"""Plain: conversion between values and plain data (dicts, lists, strings, numbers, booleans, null).

`ToPlain(store)(schema, value)` and `FromPlain(store)(schema, plain)` dispatch on the schema's kind;
`ToPlain(store).OfObject(...)` etc. are the per-kind forms. The store (see `Stores`) names the schemas of the objects
written, and builds the objects read. JSON and YAML are thin text encodings of plain data.

An object snapshot has the shape `{"root": symbol, "objects": {symbol: object}}`. Each object maps property names to
plain values and adjacency names to lists of entries. An entry maps the other links to references and the entry
properties to plain values; the object's own link is implied. A reference is `{"$ref": symbol, "$schema": name}`:
object content carries no schema, so references carry the schema name, and the root schema is passed in.

`ToPlain(store).OfObject` includes only the root object, so its references are unresolved and `FromPlain` rejects them.
`ToPlain(store).Reachable` also includes every object reachable through adjacencies (see `Reachable`). Decoding builds
new objects in the store, except an object of a singleton schema, which updates the store's instance.

The serializers are visitors: a value writes itself into them through `Visitable.accept`.

A value object (a property whose schema is an `OfObject`) is written nested, as a mapping of its properties. Union
and intersection values are written the same way, with the union's branches or the intersection's parts as the
properties: a union value `{"phone": {"number": "+44"}}` holds exactly one branch, and an intersection value
`{"stamp": {...}, "audit": {...}}` each of its parts.
"""

from __future__ import annotations

from collections.abc import Callable, Hashable
from typing import Any, NamedTuple, Protocol

from . import Reachable, Schemas, Stores, Visitors
from .Errors import DecodeError, path
from .Visitors import Scalar

__all__ = ["PlainData", "ToPlain", "FromPlain"]

PlainData = None | bool | int | float | str | list["PlainData"] | dict[str, "PlainData"]

REF = "$ref"
SCHEMA = "$schema"
ID = "$id"


# --- Writers: Visitors that write plain data ---


class _ScalarWriter:
    """`Visitors.OfScalar` writing one key of a plain dict."""

    def __init__(self, out: dict[str, PlainData], name: str, schema: Schemas.OfScalar.Data):
        self._out, self._name, self._schema = out, name, schema

    def has(self) -> bool:
        return self._name in self._out

    def get(self) -> Scalar:
        return self._schema.from_plain(self._out[self._name])

    def set(self, value: Scalar) -> _ScalarWriter:
        self._out[self._name] = self._schema.to_plain(value)
        return self

    def clear(self) -> _ScalarWriter:
        self._out.pop(self._name, None)
        return self


Ref = Callable[[Visitors.Visitable], dict[str, PlainData]]
Symbol = Callable[[Visitors.Visitable], "str | None"]


def _unlinked(value: Visitors.Visitable) -> str | None:
    return None


class _AnyWriter:
    """`Visitors.OfAny` writing one key of a plain dict: a scalar, or a value object (an object's, a union value or an
    intersection value), nested. `ref` writes references to linked objects, and `symbol` gives a value object's symbol
    when something links to it."""

    def __init__(self, out: dict[str, PlainData], name: str, schema: Schemas.OfAny.Data, ref: Ref, symbol: Symbol):
        self._out, self._name, self._ref, self._symbol = out, name, ref, symbol
        self._schema = Schemas.structure(schema)

    def as_scalar(self, callback: Callable[[Visitors.OfScalar], Any]) -> _AnyWriter:
        if not isinstance(self._schema, Schemas.OfScalar.Data):
            raise TypeError(f"property {self._name!r} is not scalar")
        callback(_ScalarWriter(self._out, self._name, self._schema))
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> _AnyWriter:
        return self._record(Schemas.OfObject.Data, "an object", callback)

    def as_union(self, callback: Callable[[Visitors.OfUnion], Any]) -> _AnyWriter:
        return self._record(Schemas.OfUnion.Data, "a union", callback)

    def as_intersection(self, callback: Callable[[Visitors.OfIntersection], Any]) -> _AnyWriter:
        return self._record(Schemas.OfIntersection.Data, "an intersection", callback)

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


def _property_schema(properties: dict[str, Any], name: str) -> Schemas.OfAny.Data:
    """The type of the property `name` (an `OfProperty`, or a union's or intersection's member)."""
    if name not in properties:
        raise KeyError(f"unknown property {name!r}")
    return properties[name].type


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

    def __init__(self, entry: dict[str, PlainData], relation: Schemas.OfRelation.Data, me: str, ref: Ref,
                 symbol: Symbol = _unlinked):
        self._entry, self._relation, self._me, self._ref = entry, relation, me, ref
        # A one-link relation's entries are written once, so their value objects can be linked by their symbols.
        self._symbol = symbol if len(relation.links) == 1 else _unlinked

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
                callback(_PropertyWriter(self._entry, name, self._relation.properties[name].type, self._ref, self._symbol))
        return self

    def has(self, name: str) -> bool:
        return name in self._entry

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _EntryWriter:
        schema = _property_schema(self._relation.properties, name)
        callback(_PropertyWriter(self._entry, name, schema, self._ref, self._symbol))
        return self

    def clear(self, name: str) -> _EntryWriter:
        self._entry.pop(name, None)
        return self


class _AdjacencyWriter:
    """`Visitors.OfAdjacency` writing a list of plain entries."""

    def __init__(self, entries: list[dict[str, PlainData]], name: str, schema: Schemas.OfAdjacency.Data, ref: Ref,
                 symbol: Symbol = _unlinked):
        self._entries, self._name, self._schema, self._ref, self._symbol = entries, name, schema, ref, symbol

    def name(self) -> str:
        return self._name

    def me(self) -> str:
        return self._schema.me

    def entries(self, callback: Callable[[Visitors.OfEntry], Any]) -> _AdjacencyWriter:
        for entry in self._entries:
            callback(_EntryWriter(entry, self._schema.relation, self._schema.me, self._ref, self._symbol))
        return self

    def add(self, callback: Callable[[Visitors.OfEntry], Any]) -> _AdjacencyWriter:
        entry: dict[str, PlainData] = {}
        callback(_EntryWriter(entry, self._schema.relation, self._schema.me, self._ref, self._symbol))
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
        for name, schema in ((n, p.type) for n, p in self._schema.properties.items()):
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
        callback(_AdjacencyWriter(entries, name, self._schema.adjacencies[name], self._ref, self._symbol))
        return self


# --- Snapshots ---


class _Snapshot:
    """Assigns symbols 1:1 to object identities, in first-reference order, and writes the included objects."""

    def __init__(self, store: Stores.Store) -> None:
        self._store = store
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
        if self._store.schema(root.schema_name()) is not schema:
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
            schema = self._store.schema(value.schema_name())
            value.accept(_ObjectWriter(out, schema, self._ref, symbol))
            _sort_entries(schema, out)
            objects[self._symbol(value)] = out
        for value in include:  # an object whose schema nothing else gives carries it: one linked only by value objects
            key = self._symbol(value)
            if value is not root and key not in self._typed:
                objects[key] = {SCHEMA: value.schema_name(), **objects[key]}  # type: ignore[dict-item]
        return {"root": self._symbol(root), "objects": objects}


_ORDERED = (bool, int, float, str)


def _sort_entries(schema: Any, plain: PlainData) -> None:
    """Sorts the entries of each adjacency written in `plain`, a value of `schema`, nested value objects' too (those
    its entries hold among them), by the key their relation declares from the adjacency's end
    (`Schemas.OfRelation.Data.key`): where every entry has each of its values, and each holds values of one ordered
    type (booleans false first, numbers by value, strings by code point). Otherwise, as where a key holds a link, entries keep the order they were written in."""
    schema = Schemas.structure(schema)
    if not isinstance(schema, (Schemas.OfObject.Data, Schemas.OfUnion.Data, Schemas.OfIntersection.Data)):
        return
    for name, prop in schema.properties.items():
        if name in plain:
            _sort_entries(prop.type, plain[name])
    for name, adjacency in schema.adjacencies.items() if isinstance(schema, Schemas.OfObject.Data) else ():
        entries, names = plain.get(name), adjacency.relation.key(adjacency.me)
        if not isinstance(entries, list):
            continue
        for entry in entries:  # an entry's value objects, held by its properties
            for held, prop in adjacency.relation.properties.items():
                if held in entry:
                    _sort_entries(prop.type, entry[held])
        if names is None:
            continue
        keys = [tuple(entry.get(n) for n in names) for entry in entries]
        if all(len({type(key[i]) for key in keys}) == 1 and type(keys[0][i]) in _ORDERED for i in range(len(names))):
            entries.sort(key=lambda entry: tuple(entry[n] for n in names))


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
    rows: dict[str, list[dict[str, Any]]] = {}  # entries decoded where no snapshot holds the value

    def accept(self, visitor: Visitors.OfObject) -> None:
        for name, value in self.values.items():
            _set(visitor, name, value)
        for name, rows in self.rows.items():
            for row in rows:
                visitor.adjacency(name, lambda a, r=row: a.add(lambda x: _fill(x, r, _unresolved)))


def _unresolved(symbol: str) -> Any:
    raise DecodeError(f"unresolved reference {symbol!r}: no snapshot holds the value")


Rows = dict[str, list[dict[str, Any]]]
"""Per adjacency, its decoded entries: each maps links to `_Link`s and properties to decoded values."""


Step = str | tuple[str, int, str]
Steps = tuple[tuple[Step, type], ...]
"""The way from a reference object to a value object in it: each step a property name, or an entry of a one-link
relation's adjacency (its name, its position and the property holding the value), and the kind of the
value found there."""


class _Found(NamedTuple):
    """Where decoding found a value object: its reference object's symbol, and the steps from it."""

    owner: str
    steps: Steps


class _Context:
    """What decoding a reference object's values collects: the symbols of the value objects in it, and their entries."""

    def __init__(self, owner: str, ids: dict[str, _Found], entries: list[tuple[_Found, Rows, Any]]):
        self.owner, self.ids, self.entries = owner, ids, entries


def _decode(schema: Schemas.OfAny.Data, plain: PlainData, where: tuple, context: _Context | None = None,
            steps: Steps = ()) -> Any:
    """The value `plain` holds under `schema`, located at the path `where`: a scalar or a `_Record`."""
    schema = Schemas.structure(schema)
    if isinstance(schema, Schemas.OfScalar.Data):
        try:
            return schema.from_plain(plain)
        except DecodeError as error:
            raise error.at(path(*where)) from None
    noun, owner, member = _RECORDS[type(schema)]
    if not isinstance(plain, dict):
        raise DecodeError(f"{noun} must be a mapping, got {type(plain).__name__}", path=path(*where))
    adjacencies = schema.adjacencies if isinstance(schema, Schemas.OfObject.Data) else {}
    values: dict[str, Any] = {}
    rows: Rows = {}
    held: Rows = {}  # entries where no snapshot holds the value, so none of their links resolves
    for key, item in plain.items():
        if key == ID and isinstance(schema, Schemas.OfObject.Data) and context is not None:
            _identify(item, context, steps, (*where, key))
        elif key in adjacencies and context is not None:
            rows[key] = _decode_rows(adjacencies[key], item, where, key, context, steps)
        elif key in adjacencies:
            held[key] = _decode_rows(adjacencies[key], item, where, key)
        elif key in schema.properties:
            values[key] = _decode(schema.properties[key].type, item, (*where, key), context,
                                  (*steps, (key, _kind(schema.properties[key].type))))
        else:
            raise DecodeError(f"{owner} has no {member} {key!r}", path=path(*where, key))
    if isinstance(schema, Schemas.OfUnion.Data) and len(values) != 1:
        raise DecodeError(f"a union value holds exactly one branch, got {len(values)}", path=path(*where))
    if rows:
        context.entries.append((_Found(context.owner, steps), rows, schema))  # type: ignore[union-attr]
    return _Record(schema, values, held)


def _kind(schema: Schemas.OfAny.Data) -> type:
    """The kind of a type's values: its structure's (see `Schemas.structure`)."""
    return type(Schemas.structure(schema))


def _decoded_key(value: Any) -> Hashable:
    """Equality key of a decoded value, per EQUALITY.md."""
    if isinstance(value, _Record):
        rows = tuple((name, tuple(tuple(sorted((key, _decoded_key(v)) for key, v in row.items())) for row in listed))
                     for name, listed in sorted(value.rows.items()))
        return ("record", tuple((name, _decoded_key(v)) for name, v in sorted(value.values.items())), rows)
    return (type(value).__name__, value.hex() if isinstance(value, float) else value)


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
    """An entry property's value: a scalar or a value object, which has no symbol or adjacencies of its own."""
    return _decode(schema, plain, where)


def _decode_rows(adjacency: Schemas.OfAdjacency.Data, value: PlainData, where: tuple, key: str,
                 context: _Context | None = None, steps: Steps = ()) -> list[dict[str, Any]]:
    """The entries of one adjacency, at `where` + `key`. The value objects a one-link relation's entries hold, which
    are written only with their one owner, may have symbols and entries of their own: `context` collects them, at
    `steps` from the owner through the entry."""
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
            elif name in relation.properties and len(relation.links) == 1 and context is not None:
                held = relation.properties[name].type
                row[name] = _decode(held, item, (*where, key, i, name), context, (*steps, ((key, i, name), _kind(held))))
            elif name in relation.properties:
                row[name] = _decode_entry_property(relation.properties[name].type, item, (*where, key, i, name))
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


def _check(store: Stores.Store, schema: Schemas.OfObject.Data, plain: PlainData
           ) -> tuple[str, dict[str, str], _Decoded, dict[str, _Found], list[tuple[_Found, Rows, Any]]]:
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
    names: dict[str, str] = {root: store.name_of(schema)}
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
    entries: list[tuple[_Found, Rows, Any]] = []
    for symbol, obj in objects.items():
        if symbol not in names:
            continue
        try:
            object_schema = store.schema(names[symbol])
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
                adjacencies[key] = _decode_rows(object_schema.adjacencies[key], value, where, key, context)
            elif key in object_schema.properties:
                properties[key] = _decode(object_schema.properties[key].type, value, (*where, key), context,
                                          ((key, _kind(object_schema.properties[key].type)),))
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


def _restore(store: Stores.Store, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
    """Rebuilds objects from an object snapshot in `store`. Every reference must resolve within the snapshot:
    reference objects are built first, with the value objects they hold, then the entries are added."""
    root, names, decoded, ids, entries = _check(store, schema, plain)

    seen: dict[Hashable, int] = {}

    def kept(schema: Any, owner: Hashable, key: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The entries of an adjacency not already added through another: entries written under each object they
        link are one, by value where the relation has a `unique` clause, and, in an open relation, the k-th equal
        entry in one list is the k-th in another."""
        adjacency = schema.adjacencies[key]
        relation, counts, kept_rows = adjacency.relation, {}, []
        for row in rows:
            row_key = _row_key(relation, adjacency.me, owner, row)
            occurrence = counts[row_key] = counts.get(row_key, -1) + 1
            index = occurrence if relation.open else 0
            if index >= seen.get(row_key, 0):
                seen[row_key] = index + 1
                kept_rows.append(row)
        return kept_rows

    created: dict[str, Any] = {}
    for symbol, (properties, adjacencies) in decoded.items():
        object_schema = store.schema(names[symbol])
        global_name = object_schema.singleton  # a singleton is the store's own instance, updated
        builder = store.builder(names[symbol], None if global_name is None else store.singleton(global_name))
        for key, value in properties.items():
            _set(builder, key, value)
        for key, rows in adjacencies.items():  # a one-link relation's entries are its owner's, as its properties are
            if len(object_schema.adjacencies[key].relation.links) == 1:
                for row in kept(object_schema, symbol, key, rows):
                    builder.adjacency(key, lambda a, r=row: a.add(lambda x: _fill(x, r, lambda symbol: None)))
        created[symbol] = builder.create() if global_name is None else builder.update()

    def resolve(symbol: str) -> Any:
        """The object a symbol names: a reference object, or the value object found at its steps."""
        if symbol in created:
            return created[symbol]
        found = ids[symbol]
        target = created[found.owner]
        for key, _ in found.steps:
            if isinstance(key, tuple):  # an entry's value
                adjacency, position, name = key
                target = getattr(store.member(target, adjacency)[position], name)
            else:
                target = store.member(target, key)
        return target

    symbols = {(found.owner, found.steps): symbol for symbol, found in ids.items()}

    nested: dict[str, list[tuple[_Found, Rows, Any]]] = {}
    for found, rows, value_schema in entries:
        nested.setdefault(found.owner, []).append((found, rows, value_schema))

    def add_nested(builder: Any, symbol: str, one_link: bool) -> bool:
        """Adds the entries of the value objects `symbol` holds, of one-link relations or of the others; whether any.
        Outer value objects first: decoding found the inner ones first, and an inner one may be held by an outer one's
        entry."""
        added = False
        for found, rows, value_schema in sorted(nested.get(symbol, []), key=lambda held: len(held[0].steps)):
            owner = symbols.get((found.owner, found.steps), found)
            rows = {key: kept(value_schema, owner, key, listed) for key, listed in rows.items()
                    if (len(value_schema.adjacencies[key].relation.links) == 1) == one_link}
            if any(rows.values()):  # an edit with nothing to add would drop what another just added
                _within(builder, found.steps, lambda v, rows=rows: _add_rows(v, rows, resolve))
                added = True
        return added

    # The value objects that one-link entries hold come first, in every object: a link may target any of them.
    for symbol in decoded:
        builder = store.builder(names[symbol], created[symbol])
        if add_nested(builder, symbol, one_link=True):
            builder.update()
    for symbol, (_, adjacencies) in decoded.items():
        object_schema = store.schema(names[symbol])
        builder = store.builder(names[symbol], created[symbol])
        for key, rows in adjacencies.items():
            if len(object_schema.adjacencies[key].relation.links) > 1:
                for row in kept(object_schema, symbol, key, rows):
                    builder.adjacency(key, lambda a, r=row: a.add(lambda x: _fill(x, r, resolve)))
        add_nested(builder, symbol, one_link=False)
        builder.update()
    return created[root]


def _row_key(relation: Any, me: str, owner: Hashable, row: dict[str, Any]) -> Hashable:
    """An entry's value, read from one end: its links' symbols, the owner's included, and its properties' values."""
    links = {me: owner, **{name: value.symbol for name, value in row.items() if isinstance(value, _Link)}}
    values = sorted((name, _decoded_key(value)) for name, value in row.items() if not isinstance(value, _Link))
    return id(relation), tuple(sorted(links.items(), key=lambda item: item[0])), tuple(values)


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
              Schemas.OfIntersection.Data: "as_intersection"}[kind]

    def into(a: Visitors.OfAny) -> None:
        getattr(a, select)(lambda v: _within(v, rest, then))

    if isinstance(key, tuple):  # an entry's value: the entry at its position, then its property
        adjacency, position, name = key
        found: list[Any] = []
        visitor.adjacency(adjacency, lambda a: a.entries(found.append))
        found[position].property(name, lambda p: p.value(into))
    else:
        visitor.property(key, lambda p: p.value(into))


def _set(visitor: Any, name: str, value: Any) -> None:
    visitor.property(name, lambda p: p.value(lambda a: _write(a, value)))


def _write(visitor: Visitors.OfAny, value: Any) -> None:
    """Writes a decoded value: a scalar, a value object, union value or intersection value."""
    if isinstance(value, _Record):
        if isinstance(value.schema, Schemas.OfUnion.Data):
            visitor.as_union(lambda u: value.accept(u))
        elif isinstance(value.schema, Schemas.OfIntersection.Data):
            visitor.as_intersection(lambda i: value.accept(i))
        else:
            visitor.as_object(lambda o: value.accept(o))
    else:
        visitor.as_scalar(lambda n: n.set(value))


def _fill(visitor: Visitors.OfEntry, row: dict[str, Any], resolve: Callable[[str], Any]) -> None:
    for key, value in row.items():  # links map to target symbols; properties to decoded values
        if isinstance(value, _Link):
            visitor.link(key, lambda k, target=resolve(value.symbol): k.set(target))
        else:
            _set(visitor, key, value)


# --- Entry points ---


class ToPlain:
    """Serializes values to plain data, naming the schemas of objects in `store`: `ToPlain(store)(schema, value)`
    dispatches on the schema's kind."""

    def __init__(self, store: Stores.Store):
        self._store = store

    def __call__(self, schema: Schemas.OfAny.Data, value: Any) -> PlainData:
        if isinstance(schema, Schemas.OfScalar.Data):
            return self.OfScalar(schema, value)
        if isinstance(schema, Schemas.OfObject.Data):
            return self.OfObject(schema, value)
        raise NotImplementedError(f"{type(schema).__name__} is not supported by Plain yet")

    @staticmethod
    def OfScalar(schema: Schemas.OfScalar.Data, value: Scalar) -> PlainData:
        return schema.to_plain(value)

    def OfObject(self, schema: Schemas.OfObject.Data, value: Visitors.Visitable) -> PlainData:
        """Snapshot of `value` alone; its references to other objects are left unresolved."""
        return _Snapshot(self._store).run(schema, value, [value])

    def Reachable(self, schema: Schemas.OfObject.Data, value: Visitors.Visitable) -> PlainData:
        """Snapshot of `value` and every object reachable from it through adjacencies (see `Reachable`)."""
        return _Snapshot(self._store).run(schema, value, Reachable.of(value))


class FromPlain:
    """Deserializes plain data, building objects in `store`: `FromPlain(store)(schema, plain)` dispatches on the
    schema's kind."""

    def __init__(self, store: Stores.Store):
        self._store = store

    def __call__(self, schema: Schemas.OfAny.Data, plain: PlainData) -> Any:
        if isinstance(schema, Schemas.OfScalar.Data):
            return self.OfScalar(schema, plain)
        if isinstance(schema, Schemas.OfObject.Data):
            return self.OfObject(schema, plain)
        raise NotImplementedError(f"{type(schema).__name__} is not supported by Plain yet")

    @staticmethod
    def OfScalar(schema: Schemas.OfScalar.Data, plain: PlainData) -> Scalar:
        try:
            return schema.from_plain(plain)
        except DecodeError as error:
            raise error.at("$") from None

    def OfObject(self, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
        return _restore(self._store, schema, plain)

    def Reachable(self, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
        return _restore(self._store, schema, plain)

