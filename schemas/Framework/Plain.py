"""Plain: conversion between values and plain data (dicts, lists, strings, numbers, booleans, null).

`ToPlain(schema, value)` and `FromPlain(schema, plain)` dispatch on the schema's kind; `ToPlain.OfObject(...)` etc.
are the per-kind forms. JSON and YAML are thin text encodings of plain data.

An object snapshot has the shape `{"root": symbol, "objects": {symbol: object}}`. Each object maps property names to
plain values and adjacency names to lists of entries. An entry maps the other links to references and the entry
properties to plain values; the object's own link is implied. A reference is `{"$ref": symbol, "$schema": name}`:
object content carries no schema, so references carry the schema name, and the root schema is passed in.

`ToPlain.OfObject` includes only the root object, so its references are unresolved and `FromPlain` rejects them.
`ToPlain.Reachable` also includes every object reachable through adjacencies.

The serializers are visitors: a value writes itself into them through `Visitable.accept`. Deserializing builds
proxies (see `Proxies`).
"""

from __future__ import annotations

from collections.abc import Callable, Hashable
from typing import Any

from . import Proxies, Schemas, Visitors
from .Visitors import Native

__all__ = ["PlainData", "ToPlain", "FromPlain"]

PlainData = None | bool | int | float | str | list["PlainData"] | dict[str, "PlainData"]

REF = "$ref"
SCHEMA = "$schema"


# --- Writers: Visitors that write plain data ---


class _NativeWriter:
    """`Visitors.OfNative` writing one key of a plain dict."""

    def __init__(self, out: dict[str, PlainData], name: str, schema: Schemas.OfNative.Data):
        self._out, self._name, self._schema = out, name, schema

    def has(self) -> bool:
        return self._name in self._out

    def get(self) -> Native:
        return self._schema.from_plain(self._out[self._name])

    def set(self, value: Native) -> _NativeWriter:
        self._out[self._name] = self._schema.to_plain(value)
        return self

    def clear(self) -> _NativeWriter:
        self._out.pop(self._name, None)
        return self


class _AnyWriter:
    """`Visitors.OfAny` writing one key of a plain dict. Only native values are supported so far."""

    def __init__(self, out: dict[str, PlainData], name: str, schema: Schemas.OfAny.Data):
        self._out, self._name, self._schema = out, name, schema

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> _AnyWriter:
        if not isinstance(self._schema, Schemas.OfNative.Data):
            raise TypeError(f"property {self._name!r} is not native")
        callback(_NativeWriter(self._out, self._name, self._schema))
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> _AnyWriter:
        raise NotImplementedError("object-valued properties are not supported by Plain yet")

    def as_union(self, callback: Callable[[Visitors.OfUnion], Any]) -> _AnyWriter:
        raise NotImplementedError("union-valued properties are not supported by Plain yet")

    def as_intersection(self, callback: Callable[[Visitors.OfIntersection], Any]) -> _AnyWriter:
        raise NotImplementedError("intersection-valued properties are not supported by Plain yet")


class _PropertyWriter:
    """`Visitors.OfProperty` writing one key of a plain dict."""

    def __init__(self, out: dict[str, PlainData], name: str, schema: Schemas.OfAny.Data):
        self._out, self._name, self._schema = out, name, schema

    def name(self) -> str:
        return self._name

    def has(self) -> bool:
        return self._name in self._out

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _PropertyWriter:
        callback(_AnyWriter(self._out, self._name, self._schema))
        return self

    def clear(self) -> _PropertyWriter:
        self._out.pop(self._name, None)
        return self


def _property_schema(properties: dict[str, Schemas.OfAny.Data], name: str) -> Schemas.OfAny.Data:
    if name not in properties:
        raise KeyError(f"unknown property {name!r}")
    return properties[name]


Ref = Callable[[Visitors.Visitable], dict[str, PlainData]]


class _LinkWriter:
    """`Visitors.OfLink` writing a reference into a plain entry."""

    def __init__(self, entry: dict[str, PlainData], name: str, ref: Ref):
        self._entry, self._name, self._ref = entry, name, ref

    def name(self) -> str:
        return self._name

    def target(self, callback: Callable[[Visitors.Visitable], Any]) -> _LinkWriter:
        raise NotImplementedError("a plain writer cannot read link targets back")

    def set(self, target: Visitors.Visitable) -> _LinkWriter:
        self._entry[self._name] = self._ref(target)
        return self


class _EntryWriter:
    """`Visitors.OfEntry` writing one plain entry."""

    def __init__(self, entry: dict[str, PlainData], relation: Schemas.OfRelation.Data, me: str, ref: Ref):
        self._entry, self._relation, self._me, self._ref = entry, relation, me, ref

    def links(self, callback: Callable[[Visitors.OfLink], Any]) -> _EntryWriter:
        for name in self._relation.links:
            if name != self._me:
                callback(_LinkWriter(self._entry, name, self._ref))
        return self

    def link(self, name: str, callback: Callable[[Visitors.OfLink], Any]) -> _EntryWriter:
        if name == self._me or name not in self._relation.links:
            raise KeyError(f"{name!r} is not a link this entry can set")
        callback(_LinkWriter(self._entry, name, self._ref))
        return self

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _EntryWriter:
        for name in self._relation.properties:
            if name in self._entry:
                callback(_PropertyWriter(self._entry, name, self._relation.properties[name]))
        return self

    def has(self, name: str) -> bool:
        return name in self._entry

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _EntryWriter:
        callback(_PropertyWriter(self._entry, name, _property_schema(self._relation.properties, name)))
        return self

    def clear(self, name: str) -> _EntryWriter:
        self._entry.pop(name, None)
        return self


class _AdjacencyWriter:
    """`Visitors.OfAdjacency` writing a list of plain entries."""

    def __init__(self, entries: list[dict[str, PlainData]], name: str, schema: Schemas.OfAdjacency.Data, ref: Ref):
        self._entries, self._name, self._schema, self._ref = entries, name, schema, ref

    def name(self) -> str:
        return self._name

    def me(self) -> str:
        return self._schema.me

    def entries(self, callback: Callable[[Visitors.OfEntry], Any]) -> _AdjacencyWriter:
        for entry in self._entries:
            callback(_EntryWriter(entry, self._schema.relation, self._schema.me, self._ref))
        return self

    def add(self, callback: Callable[[Visitors.OfEntry], Any]) -> _AdjacencyWriter:
        entry: dict[str, PlainData] = {}
        callback(_EntryWriter(entry, self._schema.relation, self._schema.me, self._ref))
        self._entries.append(entry)
        return self

    def remove(self, entry: Visitors.OfEntry) -> _AdjacencyWriter:
        raise NotImplementedError("a plain writer does not remove entries")


class _ObjectWriter:
    """`Visitors.OfObject` writing one plain object."""

    def __init__(self, out: dict[str, PlainData], schema: Schemas.OfObject.Data, ref: Ref):
        self._out, self._schema, self._ref = out, schema, ref

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _ObjectWriter:
        for name, schema in self._schema.properties.items():
            if name in self._out:
                callback(_PropertyWriter(self._out, name, schema))
        return self

    def has(self, name: str) -> bool:
        return name in self._out

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _ObjectWriter:
        callback(_PropertyWriter(self._out, name, _property_schema(self._schema.properties, name)))
        return self

    def clear(self, name: str) -> _ObjectWriter:
        self._out.pop(name, None)
        return self

    def adjacencies(self, callback: Callable[[Visitors.OfAdjacency], Any]) -> _ObjectWriter:
        for name in self._schema.adjacencies:
            self.adjacency(name, callback)
        return self

    def adjacency(self, name: str, callback: Callable[[Visitors.OfAdjacency], Any]) -> _ObjectWriter:
        if name not in self._schema.adjacencies:
            raise KeyError(f"unknown adjacency {name!r}")
        entries = self._out.setdefault(name, [])
        assert isinstance(entries, list)
        callback(_AdjacencyWriter(entries, name, self._schema.adjacencies[name], self._ref))
        return self


# --- Snapshots ---


class _Snapshot:
    """Assigns symbols 1:1 to object identities and writes objects in the order they are first referenced."""

    def __init__(self, reachable: bool):
        self._reachable = reachable
        self._symbols: dict[Hashable, str] = {}
        self._pending: list[tuple[str, Visitors.Visitable]] = []

    def _symbol(self, value: Visitors.Visitable) -> tuple[str, bool]:
        key = value.identity()
        if key in self._symbols:
            return self._symbols[key], False
        symbol = f"s{len(self._symbols)}"
        self._symbols[key] = symbol
        return symbol, True

    def _ref(self, target: Visitors.Visitable) -> dict[str, PlainData]:
        symbol, new = self._symbol(target)
        if new and self._reachable:
            self._pending.append((symbol, target))
        return {REF: symbol, SCHEMA: target.schema_name()}

    def run(self, schema: Schemas.OfObject.Data, root: Visitors.Visitable) -> dict[str, PlainData]:
        if Proxies.schema(root.schema_name()) is not schema:
            raise TypeError(f"value is a {root.schema_name()!r}, not an instance of the given schema")
        root_symbol, _ = self._symbol(root)
        objects: dict[str, PlainData] = {}
        self._pending.insert(0, (root_symbol, root))
        while self._pending:
            symbol, value = self._pending.pop(0)
            out: dict[str, PlainData] = {}
            value.accept(_ObjectWriter(out, Proxies.schema(value.schema_name()), self._ref))
            objects[symbol] = out
        return {"root": root_symbol, "objects": objects}


def _restore(schema: Schemas.OfObject.Data, plain: PlainData) -> Proxies.OfObject.Data:
    """Rebuilds proxies from an object snapshot. Every reference must resolve within the snapshot."""
    if not isinstance(plain, dict) or not isinstance(plain.get("objects"), dict):
        raise ValueError("expected an object snapshot: {'root': symbol, 'objects': {...}}")
    root, objects = plain.get("root"), plain["objects"]
    if root not in objects:
        raise ValueError(f"root {root!r} is not in the snapshot")

    names: dict[str, str] = {root: Proxies.name_of(schema)}
    for obj in objects.values():
        for value in obj.values():
            if not isinstance(value, list):
                continue
            for entry in value:
                for ref in entry.values():
                    if not (isinstance(ref, dict) and REF in ref):
                        continue
                    symbol, name = ref[REF], ref.get(SCHEMA)
                    if symbol not in objects:
                        raise ValueError(f"unresolved reference {symbol!r}: the snapshot does not contain it")
                    if names.setdefault(symbol, name) != name:
                        raise ValueError(f"{symbol!r} is referenced as both {names[symbol]!r} and {name!r}")
    unreached = set(objects) - set(names)
    if unreached:
        raise ValueError(f"cannot infer schemas for unreferenced objects {sorted(unreached)}")

    created: dict[str, Proxies.OfObject.Data] = {}
    for symbol, obj in objects.items():
        object_schema = Proxies.schema(names[symbol])
        builder = Proxies.OfObject.Builder(object_schema, names[symbol])
        for key, value in obj.items():
            if key in object_schema.properties:
                _set_native(builder, key, object_schema.properties[key], value)
            elif key not in object_schema.adjacencies:
                raise ValueError(f"{names[symbol]!r} has no property or adjacency {key!r}")
        created[symbol] = builder.create()

    for symbol, obj in objects.items():
        object_schema = Proxies.schema(names[symbol])
        builder = Proxies.OfObject.Builder(object_schema, names[symbol], created[symbol])
        for key, entries in obj.items():
            if key in object_schema.adjacencies:
                adjacency = object_schema.adjacencies[key]
                for entry in entries:
                    builder.adjacency(key, lambda a, e=entry, adj=adjacency: a.add(lambda x: _fill(x, e, adj, created)))
        builder.update()
    return created[root]


def _set_native(visitor: Any, name: str, schema: Schemas.OfAny.Data, plain: PlainData) -> None:
    if not isinstance(schema, Schemas.OfNative.Data):
        raise NotImplementedError(f"property {name!r}: only native values are supported by Plain yet")
    value = schema.from_plain(plain)
    visitor.property(name, lambda p: p.value(lambda a: a.as_native(lambda n: n.set(value))))


def _fill(
    visitor: Visitors.OfEntry,
    entry: dict[str, PlainData],
    adjacency: Schemas.OfAdjacency.Data,
    created: dict[str, Proxies.OfObject.Data],
) -> None:
    relation = adjacency.relation
    for key, value in entry.items():
        if key in relation.links and key != adjacency.me:
            target = created[value[REF]]
            visitor.link(key, lambda k: k.set(target))
        elif key in relation.properties:
            _set_native(visitor, key, relation.properties[key], value)
        else:
            raise ValueError(f"entry has no link or property {key!r}")


# --- Entry points ---


class _ToPlain:
    """`ToPlain(schema, value)` dispatches on the schema's kind."""

    def __call__(self, schema: Schemas.OfAny.Data, value: Any) -> PlainData:
        if isinstance(schema, Schemas.OfNative.Data):
            return self.OfNative(schema, value)
        if isinstance(schema, Schemas.OfObject.Data):
            return self.OfObject(schema, value)
        raise NotImplementedError(f"{type(schema).__name__} is not supported by Plain yet")

    @staticmethod
    def OfNative(schema: Schemas.OfNative.Data, value: Native) -> PlainData:
        return schema.to_plain(value)

    @staticmethod
    def OfObject(schema: Schemas.OfObject.Data, value: Visitors.Visitable) -> PlainData:
        """Snapshot of `value` alone; its references to other objects are left unresolved."""
        return _Snapshot(reachable=False).run(schema, value)

    @staticmethod
    def Reachable(schema: Schemas.OfObject.Data, value: Visitors.Visitable) -> PlainData:
        """Snapshot of `value` and every object reachable from it through adjacencies."""
        return _Snapshot(reachable=True).run(schema, value)


class _FromPlain:
    """`FromPlain(schema, plain)` dispatches on the schema's kind."""

    def __call__(self, schema: Schemas.OfAny.Data, plain: PlainData) -> Any:
        if isinstance(schema, Schemas.OfNative.Data):
            return self.OfNative(schema, plain)
        if isinstance(schema, Schemas.OfObject.Data):
            return self.OfObject(schema, plain)
        raise NotImplementedError(f"{type(schema).__name__} is not supported by Plain yet")

    @staticmethod
    def OfNative(schema: Schemas.OfNative.Data, plain: PlainData) -> Native:
        return schema.from_plain(plain)

    @staticmethod
    def OfObject(schema: Schemas.OfObject.Data, plain: PlainData) -> Proxies.OfObject.Data:
        return _restore(schema, plain)

    Reachable = OfObject


ToPlain = _ToPlain()
FromPlain = _FromPlain()
