"""Plain: conversion between values and plain data (dicts, lists, strings, numbers, booleans, null).

`ToPlain(schema, value)` and `FromPlain(builders)(schema, plain)` dispatch on the schema's kind; `ToPlain.OfObject(...)` etc.
are the per-kind forms. JSON and YAML are thin text encodings of plain data.

An object snapshot has the shape `{"root": symbol, "objects": {symbol: object}}`. Each object maps property names to
plain values and adjacency names to lists of entries. An entry maps the other links to references and the entry
properties to plain values; the object's own link is implied. A reference is `{"$ref": symbol, "$schema": name}`:
object content carries no schema, so references carry the schema name, and the root schema is passed in.

`ToPlain.OfObject` includes only the root object, so its references are unresolved and `FromPlain` rejects them.
`ToPlain.Reachable` also includes every object reachable through adjacencies (see `Reachable`).

The serializers are visitors: a value writes itself into them through `Visitable.accept`. `FromPlain` is constructed
with the builders to build with, e.g. `FromPlain(Proxies.Builders)`.

An embedded object (a property whose schema is an `OfObject`) is written nested, as a mapping of its properties. A union
value is written with the index of its branch, `{"$branch": index, "$value": value}`, and the value is read back under
that branch's type. Whether the branch agrees with the branches' predicates is checked by `Validators`, given an
evaluator.
"""

from __future__ import annotations

from collections.abc import Callable, Hashable
from typing import Any, NamedTuple, Protocol

from . import Proxies, Reachable, Schemas, Visitors
from .Errors import DecodeError, path
from .Visitors import Native

__all__ = ["PlainData", "Builders", "ToPlain", "FromPlain"]

PlainData = None | bool | int | float | str | list["PlainData"] | dict[str, "PlainData"]

REF = "$ref"
SCHEMA = "$schema"
BRANCH = "$branch"
VALUE = "$value"


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
    """`Visitors.OfAny` writing one key of a plain dict: a native, an embedded object (nested) or a union value."""

    def __init__(self, out: dict[str, PlainData], name: str, schema: Schemas.OfAny.Data):
        self._out, self._name, self._schema = out, name, schema

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> _AnyWriter:
        if not isinstance(self._schema, Schemas.OfNative.Data):
            raise TypeError(f"property {self._name!r} is not native")
        callback(_NativeWriter(self._out, self._name, self._schema))
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> _AnyWriter:
        if not isinstance(self._schema, Schemas.OfObject.Data):
            raise TypeError(f"property {self._name!r} is not an object")
        nested = self._out.get(self._name)
        if not isinstance(nested, dict):
            nested = self._out[self._name] = {}
        callback(_ObjectWriter(nested, self._schema, lambda target: {}))
        return self

    def as_union(self, callback: Callable[[Visitors.OfUnion], Any]) -> _AnyWriter:
        if not isinstance(self._schema, Schemas.OfUnion.Data):
            raise TypeError(f"property {self._name!r} is not a union")
        callback(_UnionWriter(self._out, self._name, self._schema))
        return self

    def as_intersection(self, callback: Callable[[Visitors.OfIntersection], Any]) -> _AnyWriter:
        raise NotImplementedError("intersection-valued properties are not supported by Plain yet")


class _UnionWriter:
    """`Visitors.OfUnion` writing one key of a plain dict as `{"$branch": index, "$value": value}`."""

    def __init__(self, out: dict[str, PlainData], name: str, schema: Schemas.OfUnion.Data):
        self._out, self._name, self._schema = out, name, schema
        self._selected: int | None = None

    def branch(self) -> int:
        if self._selected is None:
            raise ValueError("no branch is selected")
        return self._selected

    def select(self, index: int) -> _UnionWriter:
        if type(index) is not int or not 0 <= index < len(self._schema.branches):
            raise ValueError(f"the union has no branch {index!r}")
        self._selected = index
        return self

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _UnionWriter:
        index = self.branch()
        wrapper: dict[str, PlainData] = {BRANCH: index}
        callback(_AnyWriter(wrapper, VALUE, self._schema.branches[index].type))
        if VALUE in wrapper:
            self._out[self._name] = wrapper
        else:
            self._out.pop(self._name, None)
        return self


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


class Builders(Protocol):
    """What `FromPlain` needs from an implementation, e.g. `Proxies.Builders`: `getattr(builders, name)(instance)`
    returns a builder for the schema registered as `name`."""

    def schema(self, name: str) -> Schemas.OfObject.Data: ...

    def name_of(self, schema: Schemas.OfObject.Data) -> str: ...

    def __getattr__(self, name: str) -> Callable[..., Any]: ...


class _Snapshot:
    """Assigns symbols 1:1 to object identities, in first-reference order, and writes the included objects."""

    def __init__(self) -> None:
        self._symbols: dict[Hashable, str] = {}

    def _symbol(self, value: Visitors.Visitable) -> str:
        return self._symbols.setdefault(value.identity(), f"s{len(self._symbols)}")

    def _ref(self, target: Visitors.Visitable) -> dict[str, PlainData]:
        return {REF: self._symbol(target), SCHEMA: target.schema_name()}

    def run(
        self, schema: Schemas.OfObject.Data, root: Visitors.Visitable, include: list[Visitors.Visitable]
    ) -> dict[str, PlainData]:
        if Proxies.schema(root.schema_name()) is not schema:
            raise TypeError(f"value is a {root.schema_name()!r}, not an instance of the given schema")
        for value in include:
            self._symbol(value)
        objects: dict[str, PlainData] = {}
        for value in include:
            out: dict[str, PlainData] = {}
            value.accept(_ObjectWriter(out, Proxies.schema(value.schema_name()), self._ref))
            objects[self._symbol(value)] = out
        return {"root": self._symbol(root), "objects": objects}


def _is_ref(value: PlainData) -> bool:
    return isinstance(value, dict) and set(value) == {REF, SCHEMA} and all(isinstance(v, str) for v in value.values())


class _Link(NamedTuple):
    """A decoded link: the symbol of the target object."""

    symbol: str


class _Record(NamedTuple):
    """A decoded embedded object; `accept` writes its properties into a builder."""

    schema: Schemas.OfObject.Data
    values: dict[str, Any]

    def accept(self, visitor: Visitors.OfObject) -> None:
        for name, value in self.values.items():
            _set(visitor, name, value)


class _Union(NamedTuple):
    """A decoded union value and the index of its branch."""

    index: int
    value: Any


def _decode(schema: Schemas.OfAny.Data, plain: PlainData, where: tuple) -> Any:
    """The value `plain` holds under `schema`, located at the path `where`."""
    if isinstance(schema, Schemas.OfNative.Data):
        try:
            return schema.from_plain(plain)
        except DecodeError as error:
            raise error.at(path(*where)) from None
    if isinstance(schema, Schemas.OfObject.Data):
        if not isinstance(plain, dict):
            raise DecodeError(f"an embedded object must be a mapping, got {type(plain).__name__}", path=path(*where))
        values = {}
        for key, item in plain.items():
            if key not in schema.properties:
                raise DecodeError(f"the embedded object has no property {key!r}", path=path(*where, key))
            values[key] = _decode(schema.properties[key], item, (*where, key))
        return _Record(schema, values)
    if isinstance(schema, Schemas.OfUnion.Data):
        if not isinstance(plain, dict) or set(plain) != {BRANCH, VALUE}:
            raise DecodeError("a union value is {'$branch': index, '$value': value}", path=path(*where))
        index = plain[BRANCH]
        if type(index) is not int or not 0 <= index < len(schema.branches):
            raise DecodeError(f"the union has no branch {index!r}", path=path(*where, BRANCH))
        return _Union(index, _decode(schema.branches[index].type, plain[VALUE], (*where, VALUE)))
    raise NotImplementedError("intersection values are not supported by Plain yet")


def _decode_entry_property(schema: Schemas.OfAny.Data, name: str, plain: PlainData, where: tuple) -> Native:
    if not isinstance(schema, Schemas.OfNative.Data):
        raise NotImplementedError(f"entry property {name!r}: entry properties must be native")
    return _decode(schema, plain, where)


# Per object symbol: its decoded property values, and per adjacency its entries, each mapping links to target symbols
# and properties to decoded values.
_Decoded = dict[str, tuple[dict[str, Native], dict[str, list[dict[str, Any]]]]]


def _check(builders: Builders, schema: Schemas.OfObject.Data, plain: PlainData) -> tuple[str, dict[str, str], _Decoded]:
    """Checks a snapshot against the schemas and decodes its values before anything is built. Returns the root symbol,
    each object's schema name, and the decoded objects. Problems in the snapshot raise `DecodeError`."""
    if not isinstance(schema, Schemas.OfObject.Data):
        raise TypeError(f"the root schema must be an object schema, got {type(schema).__name__}")
    if not isinstance(plain, dict) or set(plain) != {"root", "objects"} or not isinstance(plain["objects"], dict):
        raise DecodeError("expected an object snapshot: {'root': symbol, 'objects': {symbol: object}}", path="$")
    root, objects = plain["root"], plain["objects"]
    if not isinstance(root, str) or root not in objects:
        raise DecodeError(f"root {root!r} is not in the snapshot's objects", path="$.root")
    for symbol, obj in objects.items():
        if not isinstance(obj, dict):
            raise DecodeError(f"an object must be a mapping, got {type(obj).__name__}", path=path("objects", symbol))

    # Pass 1: infer each object's schema from the references to it.
    names: dict[str, str] = {root: builders.name_of(schema)}
    for symbol, obj in objects.items():
        for key, value in obj.items():
            if not isinstance(value, list):
                continue
            for i, entry in enumerate(value):
                if not isinstance(entry, dict):
                    raise DecodeError(
                        f"an entry must be a mapping, got {type(entry).__name__}", path=path("objects", symbol, key, i)
                    )
                for name, ref in entry.items():
                    if not isinstance(ref, dict):
                        continue
                    where = path("objects", symbol, key, i, name)
                    if not _is_ref(ref):
                        raise DecodeError("a reference is {'$ref': symbol, '$schema': name}", path=where)
                    target, target_schema = ref[REF], ref[SCHEMA]
                    if target not in objects:
                        raise DecodeError(f"unresolved reference {target!r}: the snapshot does not contain it", path=where)
                    if names.setdefault(target, target_schema) != target_schema:
                        raise DecodeError(
                            f"{target!r} is referenced as both {names[target]!r} and {target_schema!r}", path=where
                        )
    # Pass 2: check every key against the schemas and decode the values.
    decoded: _Decoded = {}
    for symbol, obj in objects.items():
        if symbol not in names:
            continue
        try:
            object_schema = builders.schema(names[symbol])
        except (AttributeError, LookupError, TypeError):
            raise DecodeError(f"no object schema registered as {names[symbol]!r}", path=path("objects", symbol)) from None
        properties: dict[str, Native] = {}
        adjacencies: dict[str, list[dict[str, Any]]] = {}
        for key, value in obj.items():
            where = path("objects", symbol, key)
            if key in object_schema.adjacencies:
                if not isinstance(value, list):
                    raise DecodeError("an adjacency must be a list of entries", path=where)
                adjacency = object_schema.adjacencies[key]
                relation = adjacency.relation
                rows = adjacencies[key] = []
                for i, entry in enumerate(value):
                    row: dict[str, Any] = {}
                    for name, item in entry.items():
                        at = path("objects", symbol, key, i, name)
                        if name == adjacency.me:
                            raise DecodeError(f"{name!r} is this object's own link, which is implied", path=at)
                        if name in relation.links:
                            if not _is_ref(item):
                                raise DecodeError("a link must be a reference", path=at)
                            row[name] = _Link(item[REF])
                        elif name in relation.properties:
                            row[name] = _decode_entry_property(
                                relation.properties[name], name, item, ("objects", symbol, key, i, name))
                        else:
                            raise DecodeError(f"the relation has no link or property {name!r}", path=at)
                    missing = [n for n in relation.links if n != adjacency.me and n not in entry]
                    if missing:
                        raise DecodeError(f"links {missing} are not set", path=path("objects", symbol, key, i))
                    rows.append(row)
            elif key in object_schema.properties:
                properties[key] = _decode(object_schema.properties[key], value, ("objects", symbol, key))
            else:
                raise DecodeError(f"{names[symbol]!r} has no property or adjacency {key!r}", path=where)
        decoded[symbol] = (properties, adjacencies)
    unreached = sorted(set(objects) - set(names))
    if unreached:
        raise DecodeError("nothing references this object, so its schema is unknown", path=path("objects", unreached[0]))
    return root, names, decoded


def _restore(builders: Builders, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
    """Rebuilds objects from an object snapshot using `builders`. Every reference must resolve within the snapshot."""
    root, names, decoded = _check(builders, schema, plain)

    created: dict[str, Any] = {}
    for symbol, (properties, _) in decoded.items():
        builder = getattr(builders, names[symbol])()
        for key, value in properties.items():
            _set(builder, key, value)
        created[symbol] = builder.create()

    for symbol, (_, adjacencies) in decoded.items():
        builder = getattr(builders, names[symbol])(created[symbol])
        for key, rows in adjacencies.items():
            for row in rows:
                builder.adjacency(key, lambda a, r=row: a.add(lambda x: _fill(x, r, created)))
        builder.update()
    return created[root]


def _set(visitor: Any, name: str, value: Any) -> None:
    visitor.property(name, lambda p: p.value(lambda a: _write(a, value)))


def _write(visitor: Visitors.OfAny, value: Any) -> None:
    """Writes a decoded value: a native, an embedded object or a union value with its branch."""
    if isinstance(value, _Union):
        visitor.as_union(lambda u: u.select(value.index).value(lambda v: _write(v, value.value)))
    elif isinstance(value, _Record):
        visitor.as_object(lambda o: value.accept(o))
    else:
        visitor.as_native(lambda n: n.set(value))


def _fill(visitor: Visitors.OfEntry, row: dict[str, Any], created: dict[str, Any]) -> None:
    for key, value in row.items():  # links map to target symbols; properties to decoded values
        if isinstance(value, _Link):
            visitor.link(key, lambda k, target=created[value.symbol]: k.set(target))
        else:
            _set(visitor, key, value)


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
        return _Snapshot().run(schema, value, [value])

    @staticmethod
    def Reachable(schema: Schemas.OfObject.Data, value: Visitors.Visitable) -> PlainData:
        """Snapshot of `value` and every object reachable from it through adjacencies (see `Reachable`)."""
        return _Snapshot().run(schema, value, Reachable.of(value))


class FromPlain:
    """Deserializes plain data, building objects with the given implementation's builders, e.g.
    `FromPlain(Proxies.Builders)(schema, plain)`. Calling it dispatches on the schema's kind."""

    def __init__(self, builders: Builders):
        self._builders = builders

    def __call__(self, schema: Schemas.OfAny.Data, plain: PlainData) -> Any:
        if isinstance(schema, Schemas.OfNative.Data):
            return self.OfNative(schema, plain)
        if isinstance(schema, Schemas.OfObject.Data):
            return self.OfObject(schema, plain)
        raise NotImplementedError(f"{type(schema).__name__} is not supported by Plain yet")

    @staticmethod
    def OfNative(schema: Schemas.OfNative.Data, plain: PlainData) -> Native:
        try:
            return schema.from_plain(plain)
        except DecodeError as error:
            raise error.at("$") from None

    def OfObject(self, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
        return _restore(self._builders, schema, plain)

    def Reachable(self, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
        return _restore(self._builders, schema, plain)


ToPlain = _ToPlain()
