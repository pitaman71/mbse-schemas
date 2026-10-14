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
singleton's instance included), updates that object through its builder: what the snapshot holds is written, what it
omits is kept, a container is written element by element, and a relation's entry is the one agreeing with a row.

The serializers read values through the visitor protocol (`Readers.OfObject`), and decoding writes them through a
store's builders (`Visitors.OfObject`).

A value object (a property whose schema is an `OfObject`) is written nested, as a mapping of its properties. Union
and intersection values are written the same way, with the union's branches or the intersection's parts as the
properties: a union value `{"phone": {"number": "+44"}}` holds exactly one branch, and an intersection value
`{"stamp": {...}, "audit": {...}}` each of its parts.
"""

from __future__ import annotations

import itertools
import math
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
    found: list[tuple[bool, PlainData]] = []
    read.as_value(lambda a: found.append(_any(a, schema, ref)) or a)
    return found[0]


def _any(read: Readers.OfAny, schema: Schemas.OfAny.Data, ref: Ref) -> tuple[bool, PlainData]:
    """A value of any kind as plain data, read through its `Visitors.OfAny`, and whether it has one."""
    held = Schemas.structure(schema)
    found: list[PlainData] = []
    if isinstance(held, Schemas.OfScalar.Data):
        read.as_scalar(lambda s: found.extend([] if s.get() is None else [held.to_plain(s.get())]) or s)
    elif isinstance(held, Schemas.OfObject.Data):
        read.as_object(lambda o: found.extend([_object(o, held, ref)] if _present(o) else []) or o)
    elif isinstance(held, Schemas.OfContainer.Data):
        read.as_container(lambda c: found.extend([_container(c, held, ref)] if _present(c) else []) or c)
    else:
        select = "as_union" if isinstance(held, Schemas.OfUnion.Data) else "as_intersection"
        getattr(read, select)(lambda r: found.extend([_record(r, held, ref)] if _present(r) else []) or r)
    return (True, found[0]) if found else (False, None)


def _tensor(schema: Schemas.OfContainer.Data) -> list[str] | None:
    """The names of a container's int indices, where its index is a value object of ints; None otherwise."""
    index = Schemas.structure(schema.index)
    if not isinstance(index, Schemas.OfObject.Data):
        return None
    hosts = [Schemas.structure(prop.type) for prop in index.properties.values()]
    return list(index.properties) if all(isinstance(h, Schemas.OfScalar.Data) and h.type is int for h in hosts) else None


def _ints(schema: Schemas.OfContainer.Data) -> bool:
    """Whether a container's index is an int."""
    index = Schemas.structure(schema.index)
    return isinstance(index, Schemas.OfScalar.Data) and index.type is int


def _plain_index(schema: Schemas.OfContainer.Data, index: Any, ref: Ref) -> PlainData:
    """An index as plain data: a scalar's plain form, or a value object index as a mapping of its properties."""
    held = Schemas.structure(schema.index)
    if isinstance(held, Schemas.OfScalar.Data):
        return held.to_plain(index)
    if isinstance(index, tuple):
        return {name: Schemas.structure(prop.type).to_plain(value)
                for (name, prop), value in zip(held.properties.items(), index)}
    return _object(index, held, ref)


def _container(read: Readers.OfContainer, schema: Schemas.OfContainer.Data, ref: Ref) -> PlainData:
    """A container as plain data, as its arrangement writes it: a dense one of int indices as an array of its elements
    (null where one is absent), of several int indices as nested arrays, or flat with its shape where the writer is
    configured so (`ToPlain(store, flat=True)`); a sparse one of int indices as its blocks, each the index it starts at
    and its run of elements; a dict by a str index as a mapping; any other as an array of entry-like elements, each its
    index and its element."""
    pairs: list[tuple[Any, Any]] = []
    read.as_entries(lambda it: pairs.extend(it))

    def element(visitor: Any) -> PlainData:
        return _any(visitor, schema.element, ref)[1]

    names, arrangement = _tensor(schema), schema.arrangement
    if arrangement == "dense" and _ints(schema):
        dense: list[PlainData] = [None] * len(read)
        for index, visitor in pairs:
            dense[index] = element(visitor)
        return dense
    if arrangement == "dense" and names is not None and pairs:
        shape = [max(index[d] for index, _ in pairs) + 1 for d in range(len(names))]
        cells: dict[Any, PlainData] = {index: element(visitor) for index, visitor in pairs}
        flat = [cells.get(cell) for cell in itertools.product(*[range(n) for n in shape])]
        if getattr(ref, "flat", False):
            return {"shape": shape, "items": flat}
        for n in reversed(shape[1:]):
            flat = [flat[i:i + n] for i in range(0, len(flat), n)]
        return flat
    if arrangement == "sparse" and (_ints(schema) or names is not None):
        blocks: list[dict[str, Any]] = []
        last: Any = None
        for index, visitor in pairs:
            follows = last is not None and (index == last + 1 if _ints(schema) else
                                            index[:-1] == last[:-1] and index[-1] == last[-1] + 1)
            if follows:
                blocks[-1]["items"].append(element(visitor))
            else:
                blocks.append({"at": _plain_index(schema, index, ref), "items": [element(visitor)]})
            last = index
        return blocks
    held = Schemas.structure(schema.index)
    if arrangement == "dict" and isinstance(held, Schemas.OfScalar.Data) and held.type is str:
        return {index: element(visitor) for index, visitor in pairs}
    return [{"index": _plain_index(schema, index, ref), "element": element(visitor)} for index, visitor in pairs]


def _member(read: Any, schema: Any, ref: Ref) -> tuple[bool, PlainData]:
    """A union's branch or an intersection's part as plain data: its visitor is of its type's kind."""
    held = Schemas.structure(schema)
    if isinstance(held, Schemas.OfScalar.Data):
        value = read.get()
        return (False, None) if value is None else (True, held.to_plain(value))
    if not _present(read):
        return False, None
    if isinstance(held, Schemas.OfContainer.Data):
        return True, _container(read, held, ref)
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

    def __init__(self, store: Stores.Store, flat: bool = False) -> None:
        self._store, self.flat = store, flat  # flat: how a dense container of several int indices is written

    def __call__(self, target: Readers.OfObject) -> dict[str, PlainData]:  # the snapshot is the writers' `Ref`
        return self._ref(target)

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
            out = _object(value, value.as_schema(), self)
            _sort_entries(value.as_schema(), out)
            objects[self._symbol(value)] = out
        return {"root": self._symbol(root), "objects": objects}


_ORDERED = (bool, int, float, str)


def _sort_entries(schema: Schemas.OfObject.Data, plain: dict[str, PlainData]) -> None:
    """Sorts the entries of each adjacency written in `plain`, an object of `schema`, by the key their relation
    declares from the adjacency's end (`Schemas.OfRelation.Data.key`): where every entry has each of its values, and
    each holds values of one ordered type (booleans false first, numbers by value, strings by code point). Otherwise, as
    where a key holds a link, entries keep the order they were written in."""
    for name, adjacency in schema.adjacencies.items():
        entries, names = plain.get(name), adjacency.relation.key(adjacency.me)
        if entries is None or names is None:
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
    builder."""

    schema: Any
    values: dict[str, Any]


class _Elements(NamedTuple):
    """A decoded container: its elements, each with its index, which `_fill` writes into its builder."""

    schema: Any
    items: list[tuple[Any, Any]]


def _build(visitor: Any, record: _Record) -> Any:
    """Writes a decoded value object, union value or intersection value through its builder."""
    for name, value in record.values.items():
        _set(visitor, name, value)
    return visitor


Rows = dict[str, list[dict[str, Any]]]
"""Per adjacency, its decoded entries: each maps links to `_Link`s and properties to decoded values."""


def _decode(schema: Schemas.OfAny.Data, plain: PlainData, where: tuple) -> Any:
    """The value `plain` holds under `schema`, located at the path `where`: a scalar, a `_Record` or `_Elements`."""
    schema = Schemas.structure(schema)
    if isinstance(schema, Schemas.OfScalar.Data):
        try:
            return schema.from_plain(plain)
        except DecodeError as error:
            raise error.at(path(*where)) from None
    if isinstance(schema, Schemas.OfContainer.Data):
        return _decode_container(schema, plain, where)
    noun, owner, member = _RECORDS[type(schema)]
    if not isinstance(plain, dict):
        raise DecodeError(f"{noun} must be a mapping, got {type(plain).__name__}", path=path(*where))
    values: dict[str, Any] = {}
    for key, item in plain.items():
        if key not in schema.properties:
            raise DecodeError(f"{owner} has no {member} {key!r}", path=path(*where, key))
        values[key] = _decode(schema.properties[key].type, item, (*where, key))
    if isinstance(schema, Schemas.OfUnion.Data) and len(values) != 1:
        raise DecodeError(f"a union value holds exactly one branch, got {len(values)}", path=path(*where))
    return _Record(schema, values)


def _decode_index(schema: Schemas.OfContainer.Data, plain: PlainData, where: tuple) -> Any:
    """An index read from its plain form: a scalar, or a value object index as the tuple of its properties."""
    held = Schemas.structure(schema.index)
    if isinstance(held, Schemas.OfScalar.Data):
        return _decode(held, plain, where)
    if schema.arrangement == "entries":
        raise DecodeError("a container whose index is neither ordered nor hashable is not read from snapshots yet",
                          path=path(*where))
    record = _decode(held, plain, where)
    missing = [name for name in held.properties if name not in record.values]
    if missing:
        raise DecodeError(f"an index has every property of its value object; {missing} are not set", path=path(*where))
    return tuple(record.values[name] for name in held.properties)


def _decode_container(schema: Schemas.OfContainer.Data, plain: PlainData, where: tuple) -> _Elements:
    """A container read from the plain form its arrangement writes (see `_container`); a dense one of several int
    indices nested or flat, whichever it is."""
    items: list[tuple[Any, Any]] = []

    def element(index: Any, value: PlainData, at: tuple) -> None:
        if value is not None:
            items.append((index, _decode(schema.element, value, at)))

    def entries(value: PlainData) -> None:
        if not isinstance(value, list):
            raise DecodeError(f"a container must be a list, got {type(value).__name__}", path=path(*where))
        for i, entry in enumerate(value):
            if not isinstance(entry, dict) or set(entry) - {"index", "element"} or "index" not in entry:
                raise DecodeError("an entry of a container is {'index': index, 'element': element}", path=path(*where, i))
            element(_decode_index(schema, entry["index"], (*where, i, "index")), entry.get("element"), (*where, i, "element"))

    names, arrangement, held = _tensor(schema), schema.arrangement, Schemas.structure(schema.index)
    if arrangement == "dense" and _ints(schema):
        if not isinstance(plain, list):
            raise DecodeError(f"a dense container must be a list, got {type(plain).__name__}", path=path(*where))
        for i, value in enumerate(plain):
            element(i, value, (*where, i))
    elif arrangement == "dense" and names is not None:
        if isinstance(plain, dict) and set(plain) == {"shape", "items"}:  # flat, with its shape
            shape, flat = plain["shape"], plain["items"]
            if not (isinstance(shape, list) and len(shape) == len(names) and all(type(n) is int and n >= 0 for n in shape)
                    and isinstance(flat, list) and len(flat) == math.prod(shape)):
                raise DecodeError(f"a flat container's shape is {len(names)} sizes, and its items as many as they make",
                                  path=path(*where))
            for i, (cell, value) in enumerate(zip(itertools.product(*[range(n) for n in shape]), flat)):
                element(cell, value, (*where, "items", i))
        else:
            def nested(value: PlainData, prefix: tuple, at: tuple) -> None:
                if len(prefix) == len(names):
                    element(prefix, value, at)
                elif not isinstance(value, list):
                    raise DecodeError(f"a container of {len(names)} indices nests {len(names)} lists", path=path(*at))
                else:
                    for i, inner in enumerate(value):
                        nested(inner, (*prefix, i), (*at, i))
            nested(plain, (), where)
    elif arrangement == "sparse" and (_ints(schema) or names is not None):
        if not isinstance(plain, list):
            raise DecodeError(f"a sparse container must be a list of blocks, got {type(plain).__name__}", path=path(*where))
        for b, block in enumerate(plain):
            if not isinstance(block, dict) or set(block) != {"at", "items"} or not isinstance(block["items"], list):
                raise DecodeError("a block is {'at': index, 'items': [element, ...]}", path=path(*where, b))
            start = _decode_index(schema, block["at"], (*where, b, "at"))
            for i, value in enumerate(block["items"]):
                index = start + i if _ints(schema) else (*start[:-1], start[-1] + i)
                element(index, value, (*where, b, "items", i))
    elif arrangement == "dict" and isinstance(held, Schemas.OfScalar.Data) and held.type is str:
        if not isinstance(plain, dict):
            raise DecodeError(f"a container keyed by text must be a mapping, got {type(plain).__name__}", path=path(*where))
        for key, value in plain.items():
            element(key, value, (*where, key))
    else:
        entries(plain)
    return _Elements(schema, items)


def _decoded_key(value: Any) -> Hashable:
    """Equality key of a decoded value, per EQUALITY.md."""
    if isinstance(value, _Elements):
        return ("container", frozenset((index, _decoded_key(v)) for index, v in value.items))
    if isinstance(value, _Record):
        return ("record", tuple((name, _decoded_key(v)) for name, v in sorted(value.values.items())))
    return (type(value).__name__, value.hex() if isinstance(value, float) else value)


# For messages, per record kind: a value of it, its schema, and what its properties are.
_RECORDS = {
    Schemas.OfObject.Data: ("a value object", "the value object", "property"),
    Schemas.OfUnion.Data: ("a union value", "the union", "branch"),
    Schemas.OfIntersection.Data: ("an intersection value", "the intersection", "part"),
}


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
            if name in relation.entry.links:
                if not _is_ref(item):
                    raise DecodeError("a link must be a reference", path=at)
                row[name] = _Link(item[REF])
            elif name in relation.entry.properties:
                row[name] = _decode(relation.entry.properties[name].type, item, (*where, key, i, name))
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
           ) -> tuple[str, dict[str, str], _Decoded, dict[str, str]]:
    """Checks a snapshot against the schemas and decodes its values before anything is built. Returns the root symbol,
    each reference object's schema name, the decoded reference objects and their identities. Problems in the snapshot
    raise `DecodeError`."""
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
        properties: dict[str, Any] = {}
        adjacencies: Rows = {}
        for key, value in obj.items():
            where = ("objects", symbol)
            if key in object_schema.adjacencies:
                adjacencies[key] = _decode_rows(object_schema.adjacencies[key], value, where, key)
            elif key in object_schema.properties:
                properties[key] = _decode(object_schema.properties[key].type, value, (*where, key))
            else:
                raise DecodeError(f"{names[symbol]!r} has no property or adjacency {key!r}", path=path(*where, key))
        decoded[symbol] = (properties, adjacencies)
    unreached = sorted(set(objects) - set(names))
    if unreached:
        raise DecodeError("nothing references this object, so its schema is unknown", path=path("objects", unreached[0]))
    for target, where in unnamed:
        raise DecodeError(f"a reference names its target's schema: {target!r} has none, and a link targets a "
                          "reference object", path=path(*where))
    return root, names, decoded, identities


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
    reference objects are built first, with the values they hold, then the entries are added."""
    root, names, decoded, identities = _check(store, schema, plain)

    seen: dict[Hashable, int] = {}

    def kept(schema: Any, owner: Hashable, key: str, rows: list[dict[str, Any]]) -> list[tuple[int, dict[str, Any], int]]:
        """The entries of an adjacency not already added through another, each with its position in the snapshot's
        list and which of the equal entries in it it is: entries written under each object they link are one, by value
        where the relation has a `unique` clause, and, in an open relation, the k-th equal entry in one list is the
        k-th in another."""
        adjacency = schema.adjacencies[key]
        relation, counts, kept_rows = adjacency.relation, {}, []
        for position, row in enumerate(rows):
            row_key = _row_key(relation, adjacency.me, owner, row)
            occurrence = counts[row_key] = counts.get(row_key, -1) + 1
            index = occurrence if relation.open else 0
            if index >= seen.get(row_key, 0):
                seen[row_key] = index + 1
                kept_rows.append((position, row, index))
        return kept_rows

    # An update writes through the builders of what the object already holds: a property's value object and a container
    # are edited in place. A relation's entries have no order to visit by: a row is the entry agreeing with its links
    # and properties, the k-th equal row the k-th such entry, and added where none agrees.
    ref = _Snapshot(store)

    def write(adjacency: Any, rows: list[tuple[int, dict[str, Any], int]], resolve: Callable[[str], Any]) -> None:
        """Writes `rows` into the adjacency builder `adjacency`."""
        for _, row, occurrence in rows:
            found: list[Any] = []
            adjacency.as_iterable(lambda entries, r=row: found.extend(e for e in entries if _agrees(e, r, resolve, ref)))
            if occurrence < len(found):
                _fill(found[occurrence], row, resolve)
            else:
                adjacency.insert(lambda x, r=row: _fill(x, r, resolve))

    created: dict[str, Any] = {}
    for symbol, (properties, adjacencies) in decoded.items():
        object_schema = store.schema(names[symbol])
        try:  # an identity the store already holds, a singleton's included, is an update of that object
            existing = store.by_identity(names[symbol], identities[symbol])
        except LookupError:
            existing = None
        builder = store.restore(names[symbol], identities[symbol]) if existing is None else store.builder(
            names[symbol], existing)
        for key, value in properties.items():
            _set(builder, key, value)
        created[symbol] = builder.create() if existing is None else builder.update()

    def resolve(symbol: str) -> Any:
        """The reference object a symbol names: entries never reference value objects."""
        return created[symbol]

    for symbol, (_, adjacencies) in decoded.items():
        object_schema = store.schema(names[symbol])
        builder = store.builder(names[symbol], created[symbol])
        for key, rows in adjacencies.items():
            write(getattr(builder, key), kept(object_schema, symbol, key, rows), resolve)
        builder.update()
    return created[root]


def _agrees(entry: Any, row: dict[str, Any], resolve: Callable[[str], Any], ref: Ref) -> bool:
    """Whether an entry's visitor agrees with a decoded row: it links the objects the row names, and holds each value the
    row holds, equal by value, and no other. A value is compared as it reads back once written (`ref` writes the
    references it would hold, though an entry's values hold none)."""
    schema = entry.as_schema()
    for name in schema.links:
        if name in row:
            linked, target = getattr(entry, name), resolve(row[name].symbol)
            if linked.as_identity() != target.as_identity() or linked.as_schema() is not target.as_schema():
                return False
    for name, prop in schema.properties.items():
        present, plain = _value(getattr(entry, name), prop.type, ref)
        if present != (name in row) or present and _decoded_key(_decode(prop.type, plain, ())) != _decoded_key(row[name]):
            return False
    return True



def _row_key(relation: Any, me: str, owner: Hashable, row: dict[str, Any]) -> Hashable:
    """An entry's value, read from one end: its links' symbols, the owner's included, and its properties' values."""
    links = {me: owner, **{name: value.symbol for name, value in row.items() if isinstance(value, _Link)}}
    values = sorted((name, _decoded_key(value)) for name, value in row.items() if not isinstance(value, _Link))
    return id(relation), tuple(sorted(links.items(), key=lambda item: item[0])), tuple(values)


_SELECT = {Schemas.OfObject.Data: "as_object", Schemas.OfUnion.Data: "as_union",
           Schemas.OfIntersection.Data: "as_intersection"}


def _holds_members(visitor: Any) -> bool:
    """Whether a visitor's members are a union's branches or an intersection's parts, each of its own type's kind,
    rather than properties."""
    return isinstance(visitor.as_schema(), (Schemas.OfUnion.Data, Schemas.OfIntersection.Data))


def _set(visitor: Any, name: str, value: Any) -> None:
    """Writes a decoded value into the member `name`: a scalar, a value object, union value or intersection value, or a
    container."""
    member = getattr(visitor, name)
    if isinstance(value, _Elements):
        if _holds_members(visitor):
            member(lambda held: _fill_elements(held, value))
        else:
            member.as_value(lambda a: a.as_container(lambda held: _fill_elements(held, value)) or a)
    elif not isinstance(value, _Record):
        member(value)
    elif _holds_members(visitor):
        member(lambda held: _build(held, value))
    else:
        member.as_value(lambda a: getattr(a, _SELECT[type(value.schema)])(lambda held: _build(held, value)) or a)


def _fill_elements(container: Any, elements: _Elements) -> Any:
    """Writes a decoded container through its builder, each element at its index, over what it held there."""
    for index, value in elements.items:
        _put(container.at(index), value)
    return container


def _put(element: Any, value: Any) -> None:
    """Writes a decoded value through a `Visitors.OfAny`: a scalar, a value object, union value or intersection value,
    or a container."""
    if isinstance(value, _Elements):
        element.as_container(lambda held: _fill_elements(held, value))
    elif isinstance(value, _Record):
        getattr(element, _SELECT[type(value.schema)])(lambda held: _build(held, value))
    else:
        element.as_scalar(value)


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
    dispatches on the schema's kind. `flat=True` writes a dense container of several int indices flat, with its
    shape, rather than as nested arrays; reading takes either."""

    def __init__(self, store: Stores.Store, flat: bool = False):
        self._store, self._flat = store, flat

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
        return _Snapshot(self._store, self._flat).run(schema, value, [value])

    def Reachable(self, schema: Schemas.OfObject.Data, value: Readers.OfObject) -> PlainData:
        """Snapshot of `value` and every object reachable from it through adjacencies (see `Reachable`)."""
        return _Snapshot(self._store, self._flat).run(schema, value, Reachable.of(value))


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

