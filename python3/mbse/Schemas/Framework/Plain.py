"""Plain: conversion between values and plain data (dicts, lists, strings, numbers, booleans, null).

`ToPlain(store)(schema, value)` and `FromPlain(store)(schema, plain)` dispatch on the schema's kind;
`ToPlain(store).OfObject(...)` etc. are the per-kind forms. The store (see `Stores`) names the schemas of the objects
written, and builds the objects read. JSON and YAML are thin text encodings of plain data.

An object snapshot has the shape `{"root": key, "objects": {key: object}}`. An object's key is its identity qualified
by its schema's registered name, `"Feature/FEA-001"`, or a singleton's global name alone. Each object maps property
names to plain values and adjacency names to lists of entries. An entry maps the other links to references and the
entry properties to plain values; the object's own link is implied. A reference is `{"$ref": key, "$schema": name}`:
object content carries no schema, so references carry the schema name, and the root schema is passed in.

`ToPlain(store).OfObject` includes only the root object, so its references are unresolved and `FromPlain` rejects them.
`ToPlain(store).Reachable` also includes every object reachable through adjacencies (see `Reachable`). Decoding builds
each object in the store with the identity its key gives, or, where the store holds a live object of that identity (a
singleton's instance included), replaces that object's state.

The serializers read values through the visitor protocol (`Readers.OfObject`), and decoding writes them through a
store's builders (`Visitors.OfObject`).

A value object (a property whose schema is an `OfObject`) is written nested, as a mapping of its properties. Union
and intersection values are written the same way, with the union's branches or the intersection's parts as the
properties: a union value `{"phone": {"number": "+44"}}` holds exactly one branch, and an intersection value
`{"stamp": {...}, "audit": {...}}` each of its parts.
"""

from __future__ import annotations

from collections.abc import Callable, Hashable
from typing import Any, NamedTuple, Protocol

from . import Reachable, Readers, Schemas, Stores, Visitors
from .Errors import DecodeError, path
from .Visitors import Scalar

__all__ = ["PlainData", "ToPlain", "FromPlain"]

PlainData = None | bool | int | float | str | list["PlainData"] | dict[str, "PlainData"]

REF = "$ref"
SCHEMA = "$schema"
ID = "$id"


# --- Writing: plain data read through the visitor protocol ---


Ref = Callable[[Readers.OfObject], dict[str, PlainData]]


def _present(visitor: Any) -> bool:
    """Whether a value object's visitor visits one: a visitor of nothing has no schema."""
    return visitor.as_schema() is not None


def _value(read: Readers.OfProperty, schema: Schemas.OfAny.Data, ref: Ref) -> tuple[bool, PlainData]:
    """A property's value as plain data, read through its visitor, and whether it has one."""
    held = Schemas.structure(schema)
    found: list[PlainData] = []
    if isinstance(held, Schemas.OfScalar.Data):
        read.as_scalar(lambda s: found.extend([] if s.get() is None else [held.to_plain(s.get())]) or s)
    elif isinstance(held, Schemas.OfObject.Data):
        read.as_object(lambda o: found.extend([_object(o, held, ref)] if _present(o) else []) or o)
    else:
        select = "as_union" if isinstance(held, Schemas.OfUnion.Data) else "as_intersection"
        read.as_value(lambda a: getattr(a, select)(lambda r: found.extend([_record(r, held, ref)] if _present(r) else []) or r) or a)
    return (True, found[0]) if found else (False, None)


def _member(read: Any, schema: Any, ref: Ref) -> tuple[bool, PlainData]:
    """A union's branch or an intersection's part as plain data: its visitor is of its type's kind."""
    held = Schemas.structure(schema)
    if isinstance(held, Schemas.OfScalar.Data):
        value = read.get()
        return (False, None) if value is None else (True, held.to_plain(value))
    if not _present(read):
        return False, None
    return True, _object(read, held, ref) if isinstance(held, Schemas.OfObject.Data) else _record(read, held, ref)


def _record(read: Any, schema: Any, ref: Ref) -> dict[str, PlainData]:
    """A union value or an intersection value, nested as a mapping of its branch or its parts."""
    out: dict[str, PlainData] = {}
    for name, member in schema.properties.items():
        present, plain = _member(getattr(read, name), member.type, ref)
        if present:
            out[name] = plain
    return out


def _object(read: Readers.OfObject, schema: Schemas.OfObject.Data, ref: Ref) -> dict[str, PlainData]:
    """An object, a reference object or a value object nested in its owner, as a mapping: its properties, in the
    schema's order, then its adjacencies' entries. A value object has no symbol: entries never reference value
    objects."""
    out: dict[str, PlainData] = {prop.as_schema().name: _value(prop, prop.as_schema().type, ref)[1]
                                 for prop in read.as_properties}  # the properties that are set
    for name, adjacency in schema.adjacencies.items():
        entries = [_entry(entry, adjacency, ref) for entry in getattr(read, name)]
        if entries:
            out[name] = entries
    return out


def _entry(read: Readers.OfEntry, adjacency: Schemas.OfAdjacency.Data, ref: Ref) -> dict[str, PlainData]:
    """An entry as a mapping: the links other than the object's own, as references, then its properties."""
    out: dict[str, PlainData] = {}
    for name in adjacency.relation.entry.links:
        if name != adjacency.me:
            out[name] = ref(getattr(read, name))
    for name, prop in adjacency.relation.entry.properties.items():
        present, plain = _value(getattr(read, name), prop.type, ref)
        if present:
            out[name] = plain
    return out


# --- Snapshots ---


class _Snapshot:
    """Writes the included objects, in first-reference order, each keyed by its qualified identity."""

    def __init__(self, store: Stores.Store) -> None:
        self._store = store

    def _symbol(self, value: Readers.OfObject) -> str:
        """An object's key in a snapshot, and in the links to it: its identity, qualified by its schema's registered
        name (`"crm.Feature/FEA-001"`); a global name alone, being unique in a store."""
        schema = value.as_schema()
        if schema.singleton is not None:
            return schema.singleton
        return f"{self._store.name_of(schema)}/{value.as_identity()}"

    def _ref(self, target: Readers.OfObject) -> dict[str, PlainData]:
        """A reference to a linked object, which is a reference object: entries never reference value objects."""
        return {REF: self._symbol(target), SCHEMA: self._store.name_of(target.as_schema())}

    def run(
        self, schema: Schemas.OfObject.Data, root: Readers.OfObject, include: list[Readers.OfObject]
    ) -> dict[str, PlainData]:
        if root.as_schema() is not schema:
            raise TypeError(f"value is a {root.as_schema().name!r}, not an instance of the given schema")
        if not schema.ref:
            raise TypeError(f"a snapshot's root must be a reference object; {schema.name!r} is a value object schema")
        objects: dict[str, PlainData] = {}
        for value in include:
            out = _object(value, value.as_schema(), self._ref)
            _sort_entries(value.as_schema(), out)
            objects[self._symbol(value)] = out
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
            for held, prop in adjacency.relation.entry.properties.items():
                if held in entry:
                    _sort_entries(prop.type, entry[held])
        if names is None:
            continue
        keys = [tuple(entry.get(n) for n in names) for entry in entries]
        if all(len({type(key[i]) for key in keys}) == 1 and type(keys[0][i]) in _ORDERED for i in range(len(names))):
            entries.sort(key=lambda entry: tuple(entry[n] for n in names))


def _is_ref(value: PlainData) -> bool:
    """A reference: `{'$ref': key, '$schema': name}` to a reference object, or `{'$ref': key}` to a value object."""
    return (isinstance(value, dict) and set(value) in ({REF, SCHEMA}, {REF})
            and all(isinstance(v, str) for v in value.values()))


class _Link(NamedTuple):
    """A decoded link: the symbol of the target object."""

    symbol: str


class _Record(NamedTuple):
    """A decoded value object (an object's, a union value or an intersection value), which `_build` writes into its
    builder. Its entries are added once every object is built."""

    schema: Any
    values: dict[str, Any]


def _build(visitor: Any, record: _Record) -> Any:
    """Writes a decoded value object, union value or intersection value through its builder."""
    for name, value in record.values.items():
        _set(visitor, name, value)
    return visitor


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
    """What decoding a reference object's values collects: the entries of the value objects in it."""

    def __init__(self, owner: str, entries: list[tuple[_Found, Rows, Any]]):
        self.owner, self.entries = owner, entries


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
    for key, item in plain.items():
        if key in adjacencies and context is not None:  # a value object an entry of two links holds has none (validate())
            rows[key] = _decode_rows(adjacencies[key], item, where, key, context, steps)
        elif key in schema.properties:
            values[key] = _decode(schema.properties[key].type, item, (*where, key), context,
                                  (*steps, (key, _kind(schema.properties[key].type))))
        else:
            raise DecodeError(f"{owner} has no {member} {key!r}", path=path(*where, key))
    if isinstance(schema, Schemas.OfUnion.Data) and len(values) != 1:
        raise DecodeError(f"a union value holds exactly one branch, got {len(values)}", path=path(*where))
    if rows:
        context.entries.append((_Found(context.owner, steps), rows, schema))  # type: ignore[union-attr]
    return _Record(schema, values)


def _kind(schema: Schemas.OfAny.Data) -> type:
    """The kind of a type's values: its structure's (see `Schemas.structure`)."""
    return type(Schemas.structure(schema))


def _decoded_key(value: Any) -> Hashable:
    """Equality key of a decoded value, per EQUALITY.md."""
    if isinstance(value, _Record):
        return ("record", tuple((name, _decoded_key(v)) for name, v in sorted(value.values.items())))
    return (type(value).__name__, value.hex() if isinstance(value, float) else value)


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
            if name in relation.entry.links:
                if not _is_ref(item):
                    raise DecodeError("a link must be a reference", path=at)
                row[name] = _Link(item[REF])
            elif name in relation.entry.properties and len(relation.entry.links) == 1 and context is not None:
                held = relation.entry.properties[name].type
                row[name] = _decode(held, item, (*where, key, i, name), context, (*steps, ((key, i, name), _kind(held))))
            elif name in relation.entry.properties:
                row[name] = _decode_entry_property(relation.entry.properties[name].type, item, (*where, key, i, name))
            else:
                raise DecodeError(f"the relation has no link or property {name!r}", path=at)
        missing = [n for n in relation.entry.links if n != adjacency.me and n not in entry]
        if missing:
            raise DecodeError(f"links {missing} are not set", path=path(*where, key, i))
        rows.append(row)
    return rows


def _references(value: PlainData, where: tuple, found: Callable[[dict[str, Any], tuple], None]) -> None:
    """Finds the references among the values of an object, at any depth: in its entries, and in the value objects and
    lists nested in it. A mapping with a `$ref` key is a reference; nothing else is."""
    if isinstance(value, dict) and REF in value:
        if not _is_ref(value):
            raise DecodeError("a reference is {'$ref': key, '$schema': name}, or {'$ref': key} to a value object",
                              path=path(*where))
        found(value, where)
    elif isinstance(value, (dict, list)):
        for key, item in value.items() if isinstance(value, dict) else enumerate(value):
            _references(item, (*where, key), found)


# Per reference object symbol: its decoded property values and its entries.
_Decoded = dict[str, tuple[dict[str, Any], Rows]]


def _check(store: Stores.Store, schema: Schemas.OfObject.Data, plain: PlainData
           ) -> tuple[str, dict[str, str], _Decoded, list[tuple[_Found, Rows, Any]]]:
    """Checks a snapshot against the schemas and decodes its values before anything is built. Returns the root symbol,
    each reference object's schema name, the decoded reference objects, and the entries of value objects. Problems in the snapshot raise `DecodeError`."""
    if not isinstance(schema, Schemas.OfObject.Data):
        raise TypeError(f"the root schema must be an object schema, got {type(schema).__name__}")
    if not schema.ref:
        raise TypeError("the root schema must be a reference object schema")
    if not isinstance(plain, dict) or set(plain) != {"root", "objects"} or not isinstance(plain["objects"], dict):
        raise DecodeError("expected an object snapshot: {'root': key, 'objects': {key: object}}", path="$")
    root, objects = plain["root"], plain["objects"]
    if not isinstance(root, str) or root not in objects:
        raise DecodeError(f"root {root!r} is not in the snapshot's objects", path="$.root")
    for symbol, obj in objects.items():
        if not isinstance(obj, dict):
            raise DecodeError(f"an object must be a mapping, got {type(obj).__name__}", path=path("objects", symbol))

    # Pass 1: infer each reference object's schema from the references to it.
    names: dict[str, str] = {root: store.name_of(schema)}
    unnamed: list[tuple[str, tuple]] = []  # references without a schema, refused once more specific problems are not

    def found(ref: dict[str, Any], where: tuple) -> None:
        target = ref[REF]
        if SCHEMA not in ref:  # the form a reference to a value object had; refused once the rest is checked
            unnamed.append((target, where))
            return
        if target not in objects:
            raise DecodeError(f"unresolved reference {target!r}: the snapshot does not contain it", path=path(*where))
        if names.setdefault(target, ref[SCHEMA]) != ref[SCHEMA]:
            raise DecodeError(f"{target!r} is referenced as both {names[target]!r} and {ref[SCHEMA]!r}",
                              path=path(*where))

    for symbol, obj in objects.items():  # every object but the root is reached by a reference that names its schema
        for key, value in obj.items():
            _references(value, ("objects", symbol, key), found)
    # Pass 2: check every key against the schemas and decode the values.
    decoded: _Decoded = {}
    entries: list[tuple[_Found, Rows, Any]] = []
    identities: dict[str, str] = {}
    for symbol, obj in objects.items():
        if symbol not in names:
            continue
        try:
            object_schema = store.schema(names[symbol])
        except (AttributeError, LookupError, TypeError):
            raise DecodeError(f"no object schema registered as {names[symbol]!r}", path=path("objects", symbol)) from None
        if not object_schema.ref:
            raise DecodeError(f"{names[symbol]!r} is not a reference object schema", path=path("objects", symbol))
        identities[symbol] = _identity(symbol, names[symbol], object_schema)
        context = _Context(symbol, entries)
        properties: dict[str, Any] = {}
        adjacencies: Rows = {}
        for key, value in obj.items():
            where = ("objects", symbol)
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
    for target, where in unnamed:
        raise DecodeError(f"a reference names its target's schema: {target!r} has none, and a link targets a "
                          "reference object", path=path(*where))
    return root, names, decoded, entries, identities


def _identity(symbol: str, name: str, schema: Schemas.OfObject.Data) -> str:
    """The identity a snapshot's key gives an object of `schema`, registered as `name`: the key is the identity,
    qualified by `name` (`"crm.Feature/FEA-001"`), or a singleton's global name alone."""
    where = path("objects", symbol)
    if schema.singleton is not None:
        if symbol != schema.singleton:
            raise DecodeError(f"the singleton {name!r} is keyed by its global name {schema.singleton!r}", path=where)
        return symbol
    identity = symbol[len(name) + 1:]
    if not symbol.startswith(f"{name}/") or not identity:
        raise DecodeError(f"a {name!r} is keyed by its identity qualified by its schema's name, e.g. '{name}/<name>'",
                          path=where)
    if schema.pattern is not None and schema.number_of(identity) is None:
        raise DecodeError(f"{identity!r} is not a name {name!r}'s naming pattern {schema.pattern!r} gives", path=where)
    return identity


def _restore(store: Stores.Store, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
    """Rebuilds objects from an object snapshot in `store`. Every reference must resolve within the snapshot:
    reference objects are built first, with the value objects they hold, then the entries are added."""
    root, names, decoded, entries, identities = _check(store, schema, plain)

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
        try:  # an identity the store already holds, a singleton's included, is an update of that object
            existing = store.by_identity(names[symbol], identities[symbol])
        except LookupError:
            existing = None
        builder = store.restore(names[symbol], identities[symbol]) if existing is None else _replaced(
            store.builder(names[symbol], existing))
        for key, value in properties.items():
            _set(builder, key, value)
        for key, rows in adjacencies.items():  # a one-link relation's entries are its owner's, as its properties are
            if len(object_schema.adjacencies[key].relation.entry.links) == 1:
                for row in kept(object_schema, symbol, key, rows):
                    getattr(builder, key).insert(lambda x, r=row: _fill(x, r, lambda symbol: None))
        created[symbol] = builder.create() if existing is None else builder.update()

    def resolve(symbol: str) -> Any:
        """The reference object a symbol names: entries never reference value objects."""
        return created[symbol]


    nested: dict[str, list[tuple[_Found, Rows, Any]]] = {}
    for found, rows, value_schema in entries:
        nested.setdefault(found.owner, []).append((found, rows, value_schema))

    def add_nested(builder: Any, symbol: str, one_link: bool) -> bool:
        """Adds the entries of the value objects `symbol` holds, of one-link relations or of the others; whether any.
        Outer value objects first: decoding found the inner ones first, and an inner one may be held by an outer one's
        entry."""
        added = False
        for found, rows, value_schema in sorted(nested.get(symbol, []), key=lambda held: len(held[0].steps)):
            owner = found
            rows = {key: kept(value_schema, owner, key, listed) for key, listed in rows.items()
                    if (len(value_schema.adjacencies[key].relation.entry.links) == 1) == one_link}
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
            if len(object_schema.adjacencies[key].relation.entry.links) > 1:
                for row in kept(object_schema, symbol, key, rows):
                    getattr(builder, key).insert(lambda x, r=row: _fill(x, r, resolve))
        add_nested(builder, symbol, one_link=False)
        builder.update()
    return created[root]


def _replaced(builder: Any) -> Any:
    """A builder over a live object that a snapshot updates, emptied: the snapshot holds the object's whole state, so
    what it does not hold, the object no longer does."""
    for prop in list(builder.as_properties):
        prop.as_value(lambda v: v.clear())
    builder.as_adjacencies(lambda a: a.remove(lambda e: e))  # an empty template agrees with every entry
    return builder


def _row_key(relation: Any, me: str, owner: Hashable, row: dict[str, Any]) -> Hashable:
    """An entry's value, read from one end: its links' symbols, the owner's included, and its properties' values."""
    links = {me: owner, **{name: value.symbol for name, value in row.items() if isinstance(value, _Link)}}
    values = sorted((name, _decoded_key(value)) for name, value in row.items() if not isinstance(value, _Link))
    return id(relation), tuple(sorted(links.items(), key=lambda item: item[0])), tuple(values)


def _add_rows(visitor: Visitors.OfObject, rows: Rows, resolve: Callable[[str], Any]) -> None:
    for key, entries in rows.items():
        for row in entries:
            getattr(visitor, key).insert(lambda x, r=row: _fill(x, r, resolve))


_SELECT = {Schemas.OfObject.Data: "as_object", Schemas.OfUnion.Data: "as_union",
           Schemas.OfIntersection.Data: "as_intersection"}


def _holds_members(visitor: Any) -> bool:
    """Whether a visitor's members are a union's branches or an intersection's parts, each of its own type's kind,
    rather than properties."""
    return isinstance(visitor.as_schema(), (Schemas.OfUnion.Data, Schemas.OfIntersection.Data))


def _within(visitor: Any, steps: Steps, then: Callable[[Any], None]) -> None:
    """Calls `then` with the builder of the value object at `steps` from `visitor`, editing each value on the way."""
    if not steps:
        then(visitor)
        return
    (key, kind), rest = steps[0], steps[1:]

    def into(held: Any) -> Any:
        _within(held, rest, then)
        return held

    if isinstance(key, tuple):  # an entry's value: the entry at its position, then its property
        adjacency, position, name = key
        entry = list(getattr(visitor, adjacency))[position]
        getattr(entry, name).as_value(lambda a: getattr(a, _SELECT[kind])(into) or a)
    elif _holds_members(visitor):
        into(getattr(visitor, key))
    else:
        getattr(visitor, key).as_value(lambda a: getattr(a, _SELECT[kind])(into) or a)


def _set(visitor: Any, name: str, value: Any) -> None:
    """Writes a decoded value into the member `name`: a scalar, a value object, union value or intersection value."""
    member = getattr(visitor, name)
    if not isinstance(value, _Record):
        member(value)
    elif _holds_members(visitor):
        member(lambda held: _build(held, value))
    else:
        member.as_value(lambda a: getattr(a, _SELECT[type(value.schema)])(lambda held: _build(held, value)) or a)


def _fill(visitor: Visitors.OfEntry, row: dict[str, Any], resolve: Callable[[str], Any]) -> Visitors.OfEntry:
    for key, value in row.items():  # links map to target symbols; properties to decoded values
        if isinstance(value, _Link):
            getattr(visitor, key)(resolve(value.symbol))
        else:
            _set(visitor, key, value)
    return visitor


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

    def OfObject(self, schema: Schemas.OfObject.Data, value: Readers.OfObject) -> PlainData:
        """Snapshot of `value` alone; its references to other objects are left unresolved."""
        return _Snapshot(self._store).run(schema, value, [value])

    def Reachable(self, schema: Schemas.OfObject.Data, value: Readers.OfObject) -> PlainData:
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

