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

A value object (a property whose schema is an `OfObject`) is written nested, as a mapping of its properties. Union
and intersection values are written the same way, with the union's branches or the intersection's parts as the
properties: a union value `{"phone": {"number": "+44"}}` holds exactly one branch, and an intersection value
`{"stamp": {...}, "audit": {...}}` each of its parts. A list is written as an array of its items.
"""

from __future__ import annotations

from collections.abc import Callable, Hashable
from typing import Any, NamedTuple, Protocol

from . import Errors, Proxies, Reachable, Schemas, Visitors
from .Errors import DecodeError, path
from .Visitors import Native

__all__ = ["PlainData", "Builders", "ToPlain", "FromPlain"]

PlainData = None | bool | int | float | str | list["PlainData"] | dict[str, "PlainData"]

REF = "$ref"
SCHEMA = "$schema"
ID = "$id"


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


Ref = Callable[[Visitors.Visitable], dict[str, PlainData]]
Symbol = Callable[[Visitors.Visitable], "str | None"]


def _unlinked(value: Visitors.Visitable) -> str | None:
    return None


class _AnyWriter:
    """`Visitors.OfAny` writing one key of a plain dict: a native, or a value object (an object's, a union value or an
    intersection value), nested. `ref` writes references to linked objects, and `symbol` gives a value object's symbol
    when something links to it."""

    def __init__(self, out: dict[str, PlainData], name: str, schema: Schemas.OfAny.Data, ref: Ref, symbol: Symbol):
        self._out, self._name, self._schema, self._ref, self._symbol = out, name, schema, ref, symbol

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> _AnyWriter:
        if not isinstance(self._schema, Schemas.OfNative.Data):
            raise TypeError(f"property {self._name!r} is not native")
        callback(_NativeWriter(self._out, self._name, self._schema))
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> _AnyWriter:
        return self._record(Schemas.OfObject.Data, "an object", callback)

    def as_union(self, callback: Callable[[Visitors.OfUnion], Any]) -> _AnyWriter:
        return self._record(Schemas.OfUnion.Data, "a union", callback)

    def as_intersection(self, callback: Callable[[Visitors.OfIntersection], Any]) -> _AnyWriter:
        return self._record(Schemas.OfIntersection.Data, "an intersection", callback)

    def as_indexed(self, callback: Callable[[Visitors.OfIndexed], Any]) -> _AnyWriter:
        if not isinstance(self._schema, Schemas.OfIndexed.Data):
            raise TypeError(f"property {self._name!r} is not a list")
        items = self._out.get(self._name)
        if not isinstance(items, list):
            items = self._out[self._name] = []
        callback(_ListWriter(items, self._name, self._schema, self._ref, self._symbol))
        return self

    def _record(self, kind: type, noun: str, callback: Callable[[Any], Any]) -> _AnyWriter:
        """Writes a value object, a union value or an intersection value, nested as a mapping."""
        if not isinstance(self._schema, kind):
            raise TypeError(f"property {self._name!r} is not {noun}")
        nested = self._out.get(self._name)
        if not isinstance(nested, dict):
            nested = self._out[self._name] = {}
        callback(_ObjectWriter(nested, self._schema, self._ref, self._symbol) if isinstance(self._schema, Schemas.OfObject.Data)
                 else _RecordWriter(nested, self._schema, self._ref, self._symbol))
        if isinstance(self._schema, Schemas.OfUnion.Data) and not nested:
            del self._out[self._name]  # a union value without a branch is no value
        return self


class _ListWriter:
    """`Visitors.OfIndexed` writing a plain list, the value of the property `name`; an item written with no value is left
    out."""

    def __init__(self, out: list[PlainData], name: str, schema: Schemas.OfIndexed.Data, ref: Ref, symbol: Symbol):
        self._out, self._name, self._schema, self._ref, self._symbol = out, name, schema, ref, symbol

    def items(self, callback: Callable[[Visitors.OfAny], Any]) -> _ListWriter:
        for index in range(len(self._out)):
            self.item(index, callback)
        return self

    def item(self, index: int, callback: Callable[[Visitors.OfAny], Any]) -> _ListWriter:
        held = {self._name: Errors.item(self._out, index)}
        callback(_AnyWriter(held, self._name, self._schema.item, self._ref, self._symbol))
        self._out[index:index + 1] = held.values()
        return self

    def append(self, callback: Callable[[Visitors.OfAny], Any]) -> _ListWriter:
        held: dict[str, PlainData] = {}
        callback(_AnyWriter(held, self._name, self._schema.item, self._ref, self._symbol))
        self._out.extend(held.values())
        return self

    def remove(self, index: int) -> _ListWriter:
        Errors.item(self._out, index)
        del self._out[index]
        return self

    def clear(self) -> _ListWriter:
        self._out.clear()
        return self


class _PropertyWriter:
    """`Visitors.OfProperty` writing one key of a plain dict."""

    def __init__(self, out: dict[str, PlainData], name: str, schema: Schemas.OfAny.Data, ref: Ref, symbol: Symbol):
        self._out, self._name, self._schema, self._ref, self._symbol = out, name, schema, ref, symbol

    def name(self) -> str:
        return self._name

    def has(self) -> bool:
        return self._name in self._out

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _PropertyWriter:
        callback(_AnyWriter(self._out, self._name, self._schema, self._ref, self._symbol))
        return self

    def clear(self) -> _PropertyWriter:
        self._out.pop(self._name, None)
        return self


def _property_schema(properties: dict[str, Schemas.OfAny.Data], name: str) -> Schemas.OfAny.Data:
    if name not in properties:
        raise KeyError(f"unknown property {name!r}")
    return properties[name]


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
                callback(_PropertyWriter(self._entry, name, self._relation.properties[name], self._ref, _unlinked))
        return self

    def has(self, name: str) -> bool:
        return name in self._entry

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _EntryWriter:
        schema = _property_schema(self._relation.properties, name)
        callback(_PropertyWriter(self._entry, name, schema, self._ref, _unlinked))
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


class _RecordWriter:
    """`Visitors.OfUnion` and `Visitors.OfIntersection` writing a union or intersection value, whose properties are the
    branches or parts; the base of `_ObjectWriter`. Writing a union's branch clears any other."""

    def __init__(self, out: dict[str, PlainData], schema: Any, ref: Ref, symbol: Symbol):
        self._out, self._schema, self._ref, self._symbol = out, schema, ref, symbol

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> Any:
        for name, schema in self._schema.properties.items():
            if name in self._out:
                callback(_PropertyWriter(self._out, name, schema, self._ref, self._symbol))
        return self

    def has(self, name: str) -> bool:
        return name in self._out

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> Any:
        schema = _property_schema(self._schema.properties, name)
        if isinstance(self._schema, Schemas.OfUnion.Data):
            for other in [n for n in self._out if n != name]:
                del self._out[other]
        callback(_PropertyWriter(self._out, name, schema, self._ref, self._symbol))
        return self

    def clear(self, name: str) -> Any:
        self._out.pop(name, None)
        return self


class _ObjectWriter(_RecordWriter):
    """`Visitors.OfObject` writing one plain object, a reference object or a value object nested in its owner. A value
    object that something links to is written with its symbol, `$id`."""

    def __init__(self, out: dict[str, PlainData], schema: Schemas.OfObject.Data, ref: Ref, symbol: Symbol = _unlinked):
        super().__init__(out, schema, ref, symbol)

    def identify(self, value: Visitors.Visitable) -> _ObjectWriter:
        symbol = self._symbol(value)
        if symbol is not None:
            self._out[ID] = symbol
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

    def member(self, instance: Any, name: str) -> Any:
        """The value `instance` holds in its property `name`, e.g. a value object."""
        ...

    def __getattr__(self, name: str) -> Callable[..., Any]: ...


class _Snapshot:
    """Assigns symbols 1:1 to object identities, in first-reference order, and writes the included objects."""

    def __init__(self) -> None:
        self._symbols: dict[Hashable, str] = {}
        self._typed: set[str] = set()  # the reference objects some reference names the schema of

    def _symbol(self, value: Visitors.Visitable) -> str:
        return self._symbols.setdefault(value.identity(), f"s{len(self._symbols)}")

    def _ref(self, target: Visitors.Visitable) -> dict[str, PlainData]:
        """A reference to a linked object; one to a value object has no schema, which its owner's gives."""
        if target.owner() is not None:
            return {REF: self._symbol(target)}
        self._typed.add(self._symbol(target))
        return {REF: self._symbol(target), SCHEMA: target.schema_name()}

    def run(
        self, schema: Schemas.OfObject.Data, root: Visitors.Visitable, include: list[Visitors.Visitable]
    ) -> dict[str, PlainData]:
        if Proxies.schema(root.schema_name()) is not schema:
            raise TypeError(f"value is a {root.schema_name()!r}, not an instance of the given schema")
        if not schema.ref:
            raise TypeError(f"a snapshot's root must be a reference object; {root.schema_name()!r} is a value object schema")
        for value in include:
            self._symbol(value)
        linked = Reachable.targets(include)

        def symbol(value: Visitors.Visitable) -> str | None:
            return self._symbol(value) if value.identity() in linked else None

        objects: dict[str, PlainData] = {}
        for value in include:
            out: dict[str, PlainData] = {}
            value.accept(_ObjectWriter(out, Proxies.schema(value.schema_name()), self._ref, symbol))
            objects[self._symbol(value)] = out
        for value in include:  # an object whose schema nothing else gives carries it: one linked only by value objects
            key = self._symbol(value)
            if value is not root and key not in self._typed:
                objects[key] = {SCHEMA: value.schema_name(), **objects[key]}  # type: ignore[dict-item]
        return {"root": self._symbol(root), "objects": objects}


def _is_ref(value: PlainData) -> bool:
    """A reference: `{'$ref': symbol, '$schema': name}` to a reference object, or `{'$ref': symbol}` to a value object."""
    return (isinstance(value, dict) and set(value) in ({REF, SCHEMA}, {REF})
            and all(isinstance(v, str) for v in value.values()))


class _Link(NamedTuple):
    """A decoded link: the symbol of the target object."""

    symbol: str


class _Record(NamedTuple):
    """A decoded value object (an object's, a union value or an intersection value); `accept` writes its properties into
    a builder. Its entries are added once every object is built."""

    schema: Any
    values: dict[str, Any]

    def accept(self, visitor: Visitors.OfObject) -> None:
        for name, value in self.values.items():
            _set(visitor, name, value)


Rows = dict[str, list[dict[str, Any]]]
"""Per adjacency, its decoded entries: each maps links to `_Link`s and properties to decoded values."""


Steps = tuple[tuple[str | int, type], ...]
"""The way from a reference object to a value object in it: each step a property name, or an index in a list, and the
kind of the value found there."""


class _Found(NamedTuple):
    """Where decoding found a value object: its reference object's symbol, and the steps from it."""

    owner: str
    steps: Steps


class _Context:
    """What decoding a reference object's values collects: the symbols of the value objects in it, and their entries."""

    def __init__(self, owner: str, ids: dict[str, _Found], entries: list[tuple[_Found, Rows]]):
        self.owner, self.ids, self.entries = owner, ids, entries


def _decode(schema: Schemas.OfAny.Data, plain: PlainData, where: tuple, context: _Context | None = None,
            steps: Steps = ()) -> Any:
    """The value `plain` holds under `schema`, located at the path `where`: a native, a `_Record`, or a list of the
    items' values."""
    if isinstance(schema, Schemas.OfNative.Data):
        try:
            return schema.from_plain(plain)
        except DecodeError as error:
            raise error.at(path(*where)) from None
    if isinstance(schema, Schemas.OfIndexed.Data):
        if not isinstance(plain, list):
            raise DecodeError(f"a list must be an array, got {type(plain).__name__}", path=path(*where))
        return [_decode(schema.item, item, (*where, i), context, (*steps, (i, type(schema.item))))
                for i, item in enumerate(plain)]
    noun, owner, member = _RECORDS[type(schema)]
    if not isinstance(plain, dict):
        raise DecodeError(f"{noun} must be a mapping, got {type(plain).__name__}", path=path(*where))
    adjacencies = schema.adjacencies if isinstance(schema, Schemas.OfObject.Data) else {}
    values: dict[str, Any] = {}
    rows: Rows = {}
    for key, item in plain.items():
        if key == ID and isinstance(schema, Schemas.OfObject.Data) and context is not None:
            _identify(item, context, steps, (*where, key))
        elif key in adjacencies and context is not None:
            rows[key] = _decode_rows(adjacencies[key], item, where, key)
        elif key in schema.properties:
            values[key] = _decode(schema.properties[key], item, (*where, key), context,
                                  (*steps, (key, type(schema.properties[key]))))
        else:
            raise DecodeError(f"{owner} has no {member} {key!r}", path=path(*where, key))
    if isinstance(schema, Schemas.OfUnion.Data) and len(values) != 1:
        raise DecodeError(f"a union value holds exactly one branch, got {len(values)}", path=path(*where))
    if rows:
        context.entries.append((_Found(context.owner, steps), rows))  # type: ignore[union-attr]
    return _Record(schema, values)


def _identify(symbol: PlainData, context: _Context, steps: Steps, where: tuple) -> None:
    if not isinstance(symbol, str):
        raise DecodeError(f"a symbol must be a string, got {type(symbol).__name__}", path=path(*where))
    if symbol in context.ids:
        raise DecodeError(f"{symbol!r} is the symbol of two objects", path=path(*where))
    context.ids[symbol] = _Found(context.owner, steps)


# For messages, per record kind: a value of it, its schema, and what its properties are.
_RECORDS = {
    Schemas.OfObject.Data: ("a value object", "the value object", "property"),
    Schemas.OfUnion.Data: ("a union value", "the union", "branch"),
    Schemas.OfIntersection.Data: ("an intersection value", "the intersection", "part"),
}


def _decode_entry_property(schema: Schemas.OfAny.Data, plain: PlainData, where: tuple) -> Any:
    """An entry property's value: a native or a value object, which has no symbol or adjacencies of its own."""
    return _decode(schema, plain, where)


def _decode_rows(adjacency: Schemas.OfAdjacency.Data, value: PlainData, where: tuple, key: str) -> list[dict[str, Any]]:
    """The entries of one adjacency, at `where` + `key`."""
    if not isinstance(value, list):
        raise DecodeError("an adjacency must be a list of entries", path=path(*where, key))
    relation = adjacency.relation
    rows = []
    for i, entry in enumerate(value):
        if not isinstance(entry, dict):
            raise DecodeError(f"an entry must be a mapping, got {type(entry).__name__}", path=path(*where, key, i))
        row: dict[str, Any] = {}
        for name, item in entry.items():
            at = path(*where, key, i, name)
            if name == adjacency.me:
                raise DecodeError(f"{name!r} is this object's own link, which is implied", path=at)
            if name in relation.links:
                if not _is_ref(item):
                    raise DecodeError("a link must be a reference", path=at)
                row[name] = _Link(item[REF])
            elif name in relation.properties:
                row[name] = _decode_entry_property(relation.properties[name], item, (*where, key, i, name))
            else:
                raise DecodeError(f"the relation has no link or property {name!r}", path=at)
        missing = [n for n in relation.links if n != adjacency.me and n not in entry]
        if missing:
            raise DecodeError(f"links {missing} are not set", path=path(*where, key, i))
        rows.append(row)
    return rows


def _references(value: PlainData, where: tuple, found: Callable[[dict[str, Any], tuple], None]) -> None:
    """Finds the references among the values of an object, at any depth: in its entries, and in the value objects and
    lists nested in it. A mapping with a `$ref` key is a reference; nothing else is."""
    if isinstance(value, dict) and REF in value:
        if not _is_ref(value):
            raise DecodeError("a reference is {'$ref': symbol, '$schema': name}, or {'$ref': symbol} to a value object",
                              path=path(*where))
        found(value, where)
    elif isinstance(value, (dict, list)):
        for key, item in value.items() if isinstance(value, dict) else enumerate(value):
            _references(item, (*where, key), found)


# Per reference object symbol: its decoded property values and its entries.
_Decoded = dict[str, tuple[dict[str, Any], Rows]]


def _check(builders: Builders, schema: Schemas.OfObject.Data, plain: PlainData
           ) -> tuple[str, dict[str, str], _Decoded, dict[str, _Found], list[tuple[_Found, Rows]]]:
    """Checks a snapshot against the schemas and decodes its values before anything is built. Returns the root symbol,
    each reference object's schema name, the decoded reference objects, where each value object with a symbol is, and
    the entries of value objects. Problems in the snapshot raise `DecodeError`."""
    if not isinstance(schema, Schemas.OfObject.Data):
        raise TypeError(f"the root schema must be an object schema, got {type(schema).__name__}")
    if not schema.ref:
        raise TypeError("the root schema must be a reference object schema")
    if not isinstance(plain, dict) or set(plain) != {"root", "objects"} or not isinstance(plain["objects"], dict):
        raise DecodeError("expected an object snapshot: {'root': symbol, 'objects': {symbol: object}}", path="$")
    root, objects = plain["root"], plain["objects"]
    if not isinstance(root, str) or root not in objects:
        raise DecodeError(f"root {root!r} is not in the snapshot's objects", path="$.root")
    for symbol, obj in objects.items():
        if not isinstance(obj, dict):
            raise DecodeError(f"an object must be a mapping, got {type(obj).__name__}", path=path("objects", symbol))

    # Pass 1: infer each reference object's schema from the references to it.
    names: dict[str, str] = {root: builders.name_of(schema)}
    values: list[tuple[str, tuple]] = []  # references to value objects, checked once their symbols are known

    def found(ref: dict[str, Any], where: tuple) -> None:
        target = ref[REF]
        if SCHEMA not in ref:
            values.append((target, where))
            return
        if target not in objects:
            raise DecodeError(f"unresolved reference {target!r}: the snapshot does not contain it", path=path(*where))
        if names.setdefault(target, ref[SCHEMA]) != ref[SCHEMA]:
            raise DecodeError(f"{target!r} is referenced as both {names[target]!r} and {ref[SCHEMA]!r}",
                              path=path(*where))

    for symbol, obj in objects.items():
        own = obj.get(SCHEMA)
        if own is not None:  # an object carries its schema when nothing else gives it
            if not isinstance(own, str):
                raise DecodeError(f"a schema name must be a string, got {type(own).__name__}",
                                  path=path("objects", symbol, SCHEMA))
            found({REF: symbol, SCHEMA: own}, ("objects", symbol, SCHEMA))
        for key, value in obj.items():
            if key != SCHEMA:
                _references(value, ("objects", symbol, key), found)
    # Pass 2: check every key against the schemas and decode the values.
    decoded: _Decoded = {}
    ids: dict[str, _Found] = {symbol: _Found(symbol, ()) for symbol in objects}
    entries: list[tuple[_Found, Rows]] = []
    for symbol, obj in objects.items():
        if symbol not in names:
            continue
        try:
            object_schema = builders.schema(names[symbol])
        except (AttributeError, LookupError, TypeError):
            raise DecodeError(f"no object schema registered as {names[symbol]!r}", path=path("objects", symbol)) from None
        if not object_schema.ref:
            raise DecodeError(f"{names[symbol]!r} is not a reference object schema", path=path("objects", symbol))
        context = _Context(symbol, ids, entries)
        properties: dict[str, Any] = {}
        adjacencies: Rows = {}
        for key, value in obj.items():
            where = ("objects", symbol)
            if key == SCHEMA:
                continue
            if key in object_schema.adjacencies:
                adjacencies[key] = _decode_rows(object_schema.adjacencies[key], value, where, key)
            elif key in object_schema.properties:
                properties[key] = _decode(object_schema.properties[key], value, (*where, key), context,
                                          ((key, type(object_schema.properties[key])),))
            else:
                raise DecodeError(f"{names[symbol]!r} has no property or adjacency {key!r}", path=path(*where, key))
        decoded[symbol] = (properties, adjacencies)
    unreached = sorted(set(objects) - set(names))
    if unreached:
        raise DecodeError("nothing references this object, so its schema is unknown", path=path("objects", unreached[0]))
    for target, where in values:
        if target not in ids or not ids[target].steps:
            raise DecodeError(f"unresolved reference {target!r}: no value object in the snapshot has this symbol",
                              path=path(*where))
    return root, names, decoded, {s: f for s, f in ids.items() if f.steps}, entries


def _restore(builders: Builders, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
    """Rebuilds objects from an object snapshot using `builders`. Every reference must resolve within the snapshot:
    reference objects are built first, with the value objects they hold, then the entries are added."""
    root, names, decoded, ids, entries = _check(builders, schema, plain)

    created: dict[str, Any] = {}
    for symbol, (properties, _) in decoded.items():
        builder = getattr(builders, names[symbol])()
        for key, value in properties.items():
            _set(builder, key, value)
        created[symbol] = builder.create()

    def resolve(symbol: str) -> Any:
        """The object a symbol names: a reference object, or the value object found at its steps."""
        if symbol in created:
            return created[symbol]
        found = ids[symbol]
        target = created[found.owner]
        for key, _ in found.steps:
            target = target[key] if isinstance(key, int) else builders.member(target, key)
        return target

    nested: dict[str, list[tuple[_Found, Rows]]] = {}
    for found, rows in entries:
        nested.setdefault(found.owner, []).append((found, rows))
    for symbol, (_, adjacencies) in decoded.items():
        builder = getattr(builders, names[symbol])(created[symbol])
        for key, rows in adjacencies.items():
            for row in rows:
                builder.adjacency(key, lambda a, r=row: a.add(lambda x: _fill(x, r, resolve)))
        for found, rows in nested.get(symbol, []):
            _within(builder, found.steps, lambda v, rows=rows: _add_rows(v, rows, resolve))
        builder.update()
    return created[root]


def _add_rows(visitor: Visitors.OfObject, rows: Rows, resolve: Callable[[str], Any]) -> None:
    for key, entries in rows.items():
        for row in entries:
            visitor.adjacency(key, lambda a, r=row: a.add(lambda x: _fill(x, r, resolve)))


def _within(visitor: Any, steps: Steps, then: Callable[[Any], None]) -> None:
    """Calls `then` with the builder of the value object at `steps` from `visitor`, editing each value on the way."""
    if not steps:
        then(visitor)
        return
    (key, kind), rest = steps[0], steps[1:]
    select = {Schemas.OfObject.Data: "as_object", Schemas.OfUnion.Data: "as_union",
              Schemas.OfIntersection.Data: "as_intersection", Schemas.OfIndexed.Data: "as_indexed"}[kind]

    def into(a: Visitors.OfAny) -> None:
        getattr(a, select)(lambda v: _within(v, rest, then))

    if isinstance(key, int):
        visitor.item(key, into)
    else:
        visitor.property(key, lambda p: p.value(into))


def _set(visitor: Any, name: str, value: Any) -> None:
    visitor.property(name, lambda p: p.value(lambda a: _write(a, value)))


def _write(visitor: Visitors.OfAny, value: Any) -> None:
    """Writes a decoded value: a native, a value object, union value or intersection value, or a list."""
    if isinstance(value, list):
        visitor.as_indexed(lambda items: _write_items(items, value))
    elif isinstance(value, _Record):
        if isinstance(value.schema, Schemas.OfUnion.Data):
            visitor.as_union(lambda u: value.accept(u))
        elif isinstance(value.schema, Schemas.OfIntersection.Data):
            visitor.as_intersection(lambda i: value.accept(i))
        else:
            visitor.as_object(lambda o: value.accept(o))
    else:
        visitor.as_native(lambda n: n.set(value))


def _write_items(visitor: Visitors.OfIndexed, items: list[Any]) -> None:
    for item in items:
        visitor.append(lambda a, item=item: _write(a, item))


def _fill(visitor: Visitors.OfEntry, row: dict[str, Any], resolve: Callable[[str], Any]) -> None:
    for key, value in row.items():  # links map to target symbols; properties to decoded values
        if isinstance(value, _Link):
            visitor.link(key, lambda k, target=resolve(value.symbol): k.set(target))
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
