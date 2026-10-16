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

A standalone value, of a value object, union, intersection, container or `OfAny` schema, is written by
`ToPlain(store)(schema, value)` as a property holding it writes it, and read back by `FromPlain(store)(schema, plain)`
through the store's builder of its schema, which the store registers (`.Value` is the per-kind form).

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

from . import Proxies, Reachable, Readers, Schemas, Stores, Visitors
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
    held = schema
    found: list[PlainData] = []
    if isinstance(held, Schemas.OfScalar.Data):
        read.as_scalar(lambda s: found.extend([] if s.get() is None else [held.to_plain(s.get())]) or s)
    elif isinstance(held, Schemas.OfObject.Data):
        read.as_object(lambda o: found.extend([_object(o, held, ref)] if _present(o) else []) or o)
    elif isinstance(held, Schemas.OfContainer.Data):
        read.as_container(lambda c: found.extend([_container(c, held, ref)] if _present(c) else []) or c)
    elif isinstance(held, Schemas.OfAny.Value):
        return _any_value(read, held, ref)
    else:
        select = "as_union" if isinstance(held, Schemas.OfUnion.Data) else "as_intersection"
        getattr(read, select)(lambda r: found.extend([_record(r, held, ref)] if _present(r) else []) or r)
    return (True, found[0]) if found else (False, None)


def _any_value(read: Readers.OfAny, schema: Schemas.OfAny.Value, ref: Ref) -> tuple[bool, PlainData]:
    """A value of any type as plain data, and whether there is one: restricted, written bare as the type it holds;
    unrestricted, tagged with its type, a scalar's token name or its schema's registered name."""
    found: list[Any] = []
    read.as_scalar(lambda s: found.extend([] if s.get() is None else [s.get()]) or s)
    for select in ("as_object", "as_union", "as_intersection", "as_container"):
        getattr(read, select)(lambda v: found.extend([v] if _present(v) else []) or v)
    if not found:
        return False, None
    value, types = found[0], list(schema.types)
    if type(value) in Schemas.SCALAR_TYPES:
        scalar = Schemas.OfScalar.Data(type(value))
        if not types:
            return True, {scalar.token.name: scalar.to_plain(value)}
        own = next((t for t in types if isinstance(t, Schemas.OfScalar.Data) and t.type is type(value)), None)
        if own is None:  # builders do not check scalars' types; proxies refuse a value of another schema
            raise TypeError(f"a value of any type holds one of its types; {type(value).__name__} is not one")
        return _any(read, own, ref)
    own = value.as_schema()
    return True, {ref.name_of(own): _any(read, own, ref)[1]} if not types else _any(read, own, ref)[1]


def _tensor(schema: Schemas.OfContainer.Data) -> list[str] | None:
    """The names of a container's int indices, where its index is a value object of ints; None otherwise."""
    index = schema.index
    if not isinstance(index, Schemas.OfObject.Data):
        return None
    hosts = [prop.type for prop in index.properties.values()]
    return list(index.properties) if all(isinstance(h, Schemas.OfScalar.Data) and h.type is int for h in hosts) else None


def _ints(schema: Schemas.OfContainer.Data) -> bool:
    """Whether a container's index is an int."""
    index = schema.index
    return isinstance(index, Schemas.OfScalar.Data) and index.type is int


def _plain_index(schema: Schemas.OfContainer.Data, index: Any, ref: Ref) -> PlainData:
    """An index as plain data: a scalar's plain form, or a value object index as a mapping of its properties."""
    held = schema.index
    if isinstance(held, Schemas.OfScalar.Data):
        return held.to_plain(index)
    if isinstance(index, tuple):
        return {name: prop.type.to_plain(value)
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
    held = schema.index
    if arrangement == "dict" and isinstance(held, Schemas.OfScalar.Data) and held.type is str:
        return {index: element(visitor) for index, visitor in pairs}
    return [{"index": _plain_index(schema, index, ref), "element": element(visitor)} for index, visitor in pairs]


def _member(read: Any, schema: Any, ref: Ref) -> tuple[bool, PlainData]:
    """A union's branch or an intersection's part as plain data: its visitor is of its type's kind."""
    held = schema
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


_VALUES = (Schemas.OfObject.Data, Schemas.OfUnion.Data, Schemas.OfIntersection.Data, Schemas.OfContainer.Data,
           Schemas.OfAny.Value)
"""The schemas of the values `ToPlain(store).Value` and `FromPlain(store).Value` take."""


class _Nothing:
    """The visitor of no value: no schema, and nothing to read."""

    def as_schema(self) -> None:
        return None

    def get(self) -> None:
        return None


class _Held:
    """A standalone value, read as the `Readers.OfAny` that holds it: its own kind's visitor, or nothing for another;
    a scalar given as itself."""

    def __init__(self, value: Any) -> None:
        self._value = value

    def _hand(self, cb: Any, kind: type) -> _Held:
        scalar = type(self._value) in Schemas.SCALAR_TYPES
        if kind is Schemas.OfScalar.Data:
            cb(self if scalar else _Nothing())
        else:
            cb(self._value if not scalar and isinstance(self._value.as_schema(), kind) else _Nothing())
        return self

    def get(self) -> Any:
        return self._value

    def as_scalar(self, cb: Any) -> _Held:
        return self._hand(cb, Schemas.OfScalar.Data)

    def as_object(self, cb: Any) -> _Held:
        return self._hand(cb, Schemas.OfObject.Data)

    def as_union(self, cb: Any) -> _Held:
        return self._hand(cb, Schemas.OfUnion.Data)

    def as_intersection(self, cb: Any) -> _Held:
        return self._hand(cb, Schemas.OfIntersection.Data)

    def as_container(self, cb: Any) -> _Held:
        return self._hand(cb, Schemas.OfContainer.Data)


# --- Snapshots ---


class _Snapshot:
    """Writes the included objects, in first-reference order, each keyed by its qualified identity."""

    def __init__(self, store: Stores.Store, flat: bool = False) -> None:
        self.store, self.flat = store, flat  # flat: how a dense container of several int indices is written

    def __call__(self, target: Readers.OfObject) -> dict[str, PlainData]:  # the snapshot is the writers' `Ref`
        return self._ref(target)

    def _symbol(self, value: Readers.OfObject) -> str:
        """An object's key in a snapshot, and in the links to it: its identity, qualified by its schema's registered
        name (`"crm.Feature/FEA-001"`); a global name alone, being unique in a store."""
        schema = value.as_schema()
        if schema.singleton is not None:
            return schema.singleton
        return f"{self.store.name_of(schema)}/{value.as_identity()}"

    def name_of(self, schema: Any) -> str:
        """The name a value of any type is tagged with: its schema's registered name."""
        schema = Proxies._deref(schema)  # a path names its schema
        try:
            return self.store.name_of(schema)
        except LookupError:
            raise TypeError(f"a value of any type is of a registered schema; {schema.name!r} is not registered") from None

    def _ref(self, target: Readers.OfObject) -> dict[str, PlainData]:
        """A reference to a linked object, which is a reference object: entries never reference value objects."""
        return {REF: self._symbol(target), SCHEMA: self.store.name_of(target.as_schema())}

    def run(
        self, schema: Schemas.OfObject.Data, root: Readers.OfObject, include: list[Readers.OfObject]
    ) -> dict[str, PlainData]:
        schema = Proxies._deref(schema)  # a path names its schema
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


class _Assigned(NamedTuple):
    """A decoded value of an unrestricted `OfAny`'s registered schema, `name`: built standalone, through the store's
    builder, and assigned as a value."""

    name: str
    value: Any
    store: Any

    def make(self) -> Any:
        builder = self.store.builder(self.name)
        if isinstance(self.value, _Elements):
            _fill_elements(builder, self.value)
        else:
            _build(builder, self.value)
        return builder.create()


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


def _decode(schema: Schemas.OfAny.Data, plain: PlainData, where: tuple, store: Any = None) -> Any:
    """The value `plain` holds under `schema`, located at the path `where`: a scalar, a `_Record`, `_Elements`, or an
    `_Assigned` value of a schema `store` registers."""
    if isinstance(schema, Schemas.OfAny.Value):
        return _decode_any(schema, plain, where, store)
    if isinstance(schema, Schemas.OfScalar.Data):
        try:
            return schema.from_plain(plain)
        except DecodeError as error:
            raise error.at(path(*where)) from None
    if isinstance(schema, Schemas.OfContainer.Data):
        return _decode_container(schema, plain, where, store)
    noun, owner, member = _RECORDS[type(schema)]
    if not isinstance(plain, dict):
        raise DecodeError(f"{noun} must be a mapping, got {type(plain).__name__}", path=path(*where))
    values: dict[str, Any] = {}
    for key, item in plain.items():
        if key not in schema.properties:
            raise DecodeError(f"{owner} has no {member} {key!r}", path=path(*where, key))
        values[key] = _decode(schema.properties[key].type, item, (*where, key), store)
    if isinstance(schema, Schemas.OfUnion.Data) and len(values) != 1:
        raise DecodeError(f"a union value holds exactly one branch, got {len(values)}", path=path(*where))
    return _Record(schema, values)


_FORMS = {bool: "bool", int: "int", float: "float", str: "text", dict: "mapping", list: "list"}


def _decode_any(schema: Schemas.OfAny.Value, plain: PlainData, where: tuple, store: Any) -> Any:
    """A value of any type: restricted, of the one type whose plain form it takes; unrestricted, a mapping of its type,
    a scalar's token name or a schema's registered name, to its value."""
    if schema.types:
        fits = [t for t in schema.types if _FORMS.get(type(plain)) in Schemas.plain_forms(t)]
        if len(fits) != 1:
            raise DecodeError(f"a value of any type takes the plain form of one of its types, got "
                              f"{type(plain).__name__}", path=path(*where))
        return _decode(fits[0], plain, where, store)
    if not isinstance(plain, dict) or len(plain) != 1:
        raise DecodeError("a value of any type is {type: value}, its type a scalar's token name or a registered "
                          "schema's name", path=path(*where))
    ((tag, value),) = plain.items()
    scalar = next((t for t in Schemas.SCALAR_TYPES if Schemas.OfScalar.Data(t).token.name == tag), None)
    if scalar is not None:
        return _decode(Schemas.OfScalar.Data(scalar), value, (*where, tag), store)
    try:
        registered = store.registered(tag)
    except LookupError:
        raise DecodeError(f"no schema registered as {tag!r}", path=path(*where, tag)) from None
    if not isinstance(registered, (*_RECORDS, Schemas.OfContainer.Data)) or getattr(registered, "ref", False):
        raise DecodeError(f"{tag!r} is not a value's schema", path=path(*where, tag))
    return _Assigned(tag, _decode(registered, value, (*where, tag), store), store)


def _decode_index(schema: Schemas.OfContainer.Data, plain: PlainData, where: tuple) -> Any:
    """An index read from its plain form: a scalar, or a value object index as the tuple of its properties."""
    held = schema.index
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


def _decode_container(schema: Schemas.OfContainer.Data, plain: PlainData, where: tuple, store: Any = None) -> _Elements:
    """A container read from the plain form its arrangement writes (see `_container`); a dense one of several int
    indices nested or flat, whichever it is."""
    items: list[tuple[Any, Any]] = []

    def element(index: Any, value: PlainData, at: tuple) -> None:
        if value is not None:
            items.append((index, _decode(schema.element, value, at, store)))

    def entries(value: PlainData) -> None:
        if not isinstance(value, list):
            raise DecodeError(f"a container must be a list, got {type(value).__name__}", path=path(*where))
        for i, entry in enumerate(value):
            if not isinstance(entry, dict) or set(entry) - {"index", "element"} or "index" not in entry:
                raise DecodeError("an entry of a container is {'index': index, 'element': element}", path=path(*where, i))
            element(_decode_index(schema, entry["index"], (*where, i, "index")), entry.get("element"), (*where, i, "element"))

    names, arrangement, held = _tensor(schema), schema.arrangement, schema.index
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
    if isinstance(value, _Assigned):
        return ("assigned", value.name, _decoded_key(value.value))
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


def _decode_rows(adjacency: Schemas.OfAdjacency.Data, value: PlainData, where: tuple, key: str,
                 store: Any = None) -> list[dict[str, Any]]:
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
                row[name] = _decode(relation.entry.properties[name].type, item, (*where, key, i, name), store)
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
                adjacencies[key] = _decode_rows(object_schema.adjacencies[key], value, where, key, store)
            elif key in object_schema.properties:
                properties[key] = _decode(object_schema.properties[key].type, value, (*where, key), store)
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
        if present != (name in row) or present and _decoded_key(_decode(prop.type, plain, (), ref.store)) != _decoded_key(
                row[name]):
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
    if isinstance(value, _Assigned):
        member.as_value(value.make())
    elif isinstance(value, _Elements):
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
    if isinstance(value, _Assigned):
        made = value.make()
        getattr(element, _SELECT.get(type(made.as_schema()), "as_container"))(made)
    elif isinstance(value, _Elements):
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


# --- Logs: a store as a log of mutations (docs/SERIALIZATION.md) ---


class _Names:
    """What `_value` needs to write a value: the names of the schemas of the values it holds. A value holds no
    reference: references are links, written as entries."""

    def __init__(self, store: Any) -> None:
        self.name_of = store.name_of

    def __call__(self, target: Any) -> PlainData:  # pragma: no cover - values hold no references
        raise TypeError("a value holds no reference to an object")


class _LogWriter:
    """Writes a store as a log of mutations, its initial snapshot: modules, then the schemas each defines, then the
    other named singletons, then the remaining reference objects. Each object is read through its visitor (a schema
    object through its builder, read-only) and written once, in definition form (`exists`); the objects a schema object
    holds or links that have no name of their own follow it. An entry is written (`insert`) once every object it links
    is; a link to one of the framework's schemas, which every store holds, is a reference only."""

    def __init__(self, store: Any) -> None:
        from . import Builders

        if not isinstance(store, Builders.Store):
            raise TypeError("a snapshot is of a Builders.Store, which holds its schemas and its modules")
        self._B, self._store, self._names = Builders, store, _Names(store)
        self._out: list[PlainData] = []
        self._written: set[str] = set()
        self._complete: set[str] = set()  # written, with every object it holds or links that follows it
        self._pending: dict[Hashable, list[Any]] = {}  # an entry: [relation, links, properties, count, keys, scan]
        self._scans = 0  # each object's adjacencies are scanned once: an inner object's later than its owner's

    def _reader(self, value: Any) -> Any:
        """A visitor of a schema object (its builder, read-only) or of data (the proxy itself)."""
        builder = self._B._builder_for(value)
        return builder(value, False, self._store) if builder is not None else value

    def _framework(self, visitor: Any) -> bool:
        held = getattr(visitor, "_original", None)
        target = getattr(visitor, "_target", None)
        if held is None and callable(target):  # a link, read: its referent's builder
            held = getattr(target(), "_original", None)
        return held is not None and self._store.framework(held)

    def _key(self, visitor: Any) -> str:
        """`Module.Schema/ID`: the registered name of the object's schema, and its identity."""
        return f"{self._store.name_of(visitor.as_schema())}/{visitor.as_identity()}"

    def _held(self, visitor: Any, where: str) -> None:
        """Refuses a schema object the store does not hold, saying where it is linked: there are no foreign schemas."""
        held = getattr(visitor, "_original", None)
        target = getattr(visitor, "_target", None)
        if held is None and callable(target):
            held = getattr(target(), "_original", None)
        if held is None:
            return  # data
        if not self._store.holds(held):
            shown = getattr(held, "name", None) or type(held).__name__
            raise ValueError(f"{where} links {shown}, a schema the store does not hold: there are no foreign schemas")

    def define(self, visitor: Any, key: str, singleton: bool = False) -> None:
        """Writes an object in definition form, then what follows it. A singleton exists in every store that registers
        its schema, so that `exists` leaves it as it is there: its properties are set after it (`as_property`)."""
        if key in self._written:
            return
        self._written.add(key)
        properties: dict[str, PlainData] = {}
        for prop in visitor.as_properties:  # the properties that are set
            properties[prop.as_schema().name] = _value(prop, prop.as_schema().type, self._names)[1]
        self._out.append({"exists": {"definition": {"key": key, "properties": {} if singleton else properties}}})
        if singleton:
            self._out.extend({"as_property": {"ref": {"key": key}, "name": name, "mutations": [{"set": {"value": value}}]}}
                             for name, value in properties.items())
        contained: list[tuple[Any, str]] = []
        visitor.as_adjacencies(lambda adjacency: self._entries(adjacency, key, contained))
        for target, target_key in contained:
            self.define(target, target_key)
        self._complete.add(key)
        self._flush()

    def _entries(self, adjacency: Any, key: str, contained: list[tuple[Any, str]]) -> Any:
        self._scans += 1
        schema = adjacency.as_schema()
        relation, me = schema.relation, schema.me
        counts: dict[Hashable, int] = {}
        for entry in adjacency:
            links: dict[str, str] = {}
            for link in relation.entry.links:
                if link == me:
                    links[link] = key
                    continue
                target = getattr(entry, link)
                if self._B._builder_for(target) is not None:  # a schema object a proxy's entry links (an extension's)
                    target = self._reader(target)
                self._held(target, f"{key}, {schema.name},")
                links[link] = self._key(target)
                if self._framework(target):
                    self._written.add(links[link])
                    self._complete.add(links[link])
                elif self._contained(target):
                    contained.append((target, links[link]))
            properties: dict[str, PlainData] = {}
            for name, prop in relation.entry.properties.items():
                present, plain = _value(getattr(entry, name), prop.type, self._names)
                if present:
                    properties[name] = plain
            identity = (id(relation), tuple(sorted(links.items())), repr(sorted(properties.items())))
            counts[identity] = counts.get(identity, 0) + 1
            pending = self._pending.setdefault(identity, [relation, links, properties, 0, set(links.values()), self._scans])
            pending[3] = max(pending[3], counts[identity])
        return adjacency

    def _contained(self, target: Any) -> bool:
        """Whether a linked object follows the one that links it: a schema object with no name of its own."""
        held = getattr(target, "_target", None)
        builder = held() if callable(held) else None
        data = getattr(builder, "_original", None)
        if data is None:
            return False
        named = isinstance(data, (*Schemas._KINDS, Schemas.OfRelation.Data, Schemas.OfPredicate.Data,
                                  self._B._ModuleData)) and data.name
        return not named

    def _flush(self) -> None:
        """Writes the entries whose objects are all written: an inner object's (scanned later) before its owner's, so
        that an object is whole before it is placed; within one object's, in order. Consecutive entries of a relation
        go in one `insert`."""
        ready = sorted(((pending[5], number, identity) for number, (identity, pending) in enumerate(self._pending.items())
                        if pending[4] <= self._complete), key=lambda item: (-item[0], item[1]))
        for _, _, identity in ready:
            relation, links, properties, count, _, _ = self._pending.pop(identity)
            relation_key = self._key(self._reader(relation))
            entry = {"mutations": [
                *({"as_link": {"name": name, "mutations": [{"set": {"ref": {"key": target}}}]}}
                  for name, target in links.items()),
                *({"as_property": {"name": name, "mutations": [{"set": {"value": value}}]}}
                  for name, value in properties.items()),
            ]}
            last = self._out[-1] if self._out else None
            if isinstance(last, dict) and last.get("insert", {}).get("relation", {}).get("key") == relation_key:
                last["insert"]["entries"].extend([entry] * count)
            else:
                self._out.append({"insert": {"relation": {"key": relation_key}, "entries": [entry] * count}})

    def run(self) -> list[PlainData]:
        store = self._store
        modules, queue = [], [store.module()]
        while queue:  # the root module first, then the modules it defines, nested
            module = queue.pop(0)
            modules.append(module)
            queue += [held for held in module.schemas.values() if isinstance(held, self._B._ModuleData)]
        for module in modules:
            reader = self._reader(module)
            self.define(reader, self._key(reader))
        for module in modules:
            for held in module.schemas.values():
                if not isinstance(held, self._B._ModuleData):
                    reader = self._reader(held)
                    self.define(reader, self._key(reader))
        for singleton in store._singletons.values():
            self.define(singleton, self._key(singleton), singleton=True)
        for directory in list(store._directories.values()):
            for value in list(directory.live.values()):
                self.define(value, self._key(value))
        return self._out  # every entry is written: it links objects of the store, each written


class _LogReader:
    """Applies a log of mutations to a store, each through the store's builders: `exists` creates an object only where
    its identity is new, its properties read by their schema; `insert` adds entries, through an adjacency of an object
    each links. A sub-clause whose meaning needs an extension of a schema the store was made holding, which the store
    lacks, is ignored, and kept in `ignored` where it is given (docs/proposals/store-overhaul, Decided, 19): a property
    such a schema lacks, and an entry no linked object can hold where one of them is of such a schema."""

    def __init__(self, store: Any, ignored: list[dict[str, str]] | None = None) -> None:
        from . import Builders

        if not isinstance(store, Builders.Store):
            raise TypeError("a snapshot is read into a Builders.Store")
        self._B, self._store = Builders, store
        self._meta = {id(schema) for schema in vars(store._meta).values() if hasattr(schema, "validate")}  # its own
        self._made: list[Any] = []  # the objects made, held: a store holds its data objects weakly
        self._ignored = ignored

    def _ignore(self, where: tuple, reason: str) -> None:
        """Ignores a sub-clause whose meaning needs an extension the store lacks, keeping where it is and why."""
        if self._ignored is not None:
            self._ignored.append({"path": path(*where), "reason": reason})

    def _schema(self, name: str, where: tuple) -> Any:
        try:
            return self._store.registered(name)
        except LookupError:
            raise DecodeError(f"no schema registered as {name!r}: there are no foreign schemas", path=path(*where)) from None

    def _split(self, key: Any, where: tuple) -> tuple[str, str]:
        if not isinstance(key, str) or "/" not in key:
            raise DecodeError(f"a key is 'Module.Schema/ID', got {key!r}", path=path(*where))
        name, _, identity = key.partition("/")
        return name, identity

    def _resolve(self, key: Any, where: tuple) -> Any:
        name, identity = self._split(key, where)
        schema = self._schema(name, where)
        if id(schema) in self._meta:
            found = self._store.held(name, identity)
        else:
            try:
                found = self._store.by_identity(name, identity)
            except (LookupError, AttributeError, TypeError):
                found = None
        if found is None:
            raise DecodeError(f"{key!r} is not in the store", path=path(*where))
        return found

    def _one(self, item: Any, where: tuple) -> tuple[str, Any]:
        if not isinstance(item, dict) or len(item) != 1:
            raise DecodeError("a mutation is a mapping of one verb", path=path(*where))
        return next(iter(item.items()))

    def apply(self, log: PlainData) -> list[Any]:
        if not isinstance(log, list):
            raise DecodeError(f"a log is a list, got {type(log).__name__}", path="$")
        for index, item in enumerate(log):
            verb, body = self._one(item, (index,))
            if verb == "exists":
                self._exists(body.get("definition", {}), (index, verb))
            elif verb == "insert":
                self._insert(body, (index, verb))
            elif verb == "as_property":
                self._as_property(body, (index, verb))
            else:
                raise DecodeError(f"{verb!r} is not read in an initial snapshot", path=path(index))
        return self._made

    def _exists(self, definition: dict[str, Any], where: tuple) -> None:
        key = definition.get("key")
        name, identity = self._split(key, (*where, "key"))
        schema = self._schema(name, (*where, "key"))
        if id(schema) in self._meta:
            if self._store.held(name, identity) is not None:
                return
            builder = self._B._META_BUILDERS[name.removeprefix("Schemas.")]()(None, True, self._store)
            builder.as_identity(identity)
            properties = builder.as_schema().properties
        else:
            try:
                self._store.by_identity(name, identity)
                return
            except LookupError:
                builder = self._store.restore(name, identity)
            properties = schema.properties
        for prop_name, plain in definition.get("properties", {}).items():
            if prop_name not in properties:
                owner = builder.as_schema() if id(schema) in self._meta else schema
                if self._store.framework(owner):  # an extension of a schema the store was made holding, which it lacks
                    self._ignore((*where, prop_name), f"{name} has no property {prop_name!r}")
                    continue
                raise DecodeError(f"{name} has no property {prop_name!r}", path=path(*where, prop_name))
            _set(builder, prop_name, _decode(properties[prop_name].type, plain, (*where, prop_name), self._store))
        self._made.append(builder.create())

    def _as_property(self, body: dict[str, Any], where: tuple) -> None:
        """Sets or clears a property of an object that exists (a singleton's, in an initial snapshot)."""
        target = self._resolve(body.get("ref", {}).get("key"), (*where, "ref"))
        name = body.get("name")
        schema = target.as_schema()
        if name not in schema.properties:
            raise DecodeError(f"{self._store.name_of(schema)} has no property {name!r}", path=path(*where, "name"))
        builder = self._store.builder(self._store.name_of(schema), target)
        for change in body.get("mutations", []):
            verb, payload = self._one(change, where)
            if verb == "set":
                _set(builder, name, _decode(schema.properties[name].type, payload.get("value"), where, self._store))
            else:
                getattr(builder, name).as_value(lambda value: value.clear())
        builder.update()

    def _insert(self, body: dict[str, Any], where: tuple) -> None:
        relation = self._resolve(body.get("relation", {}).get("key"), (*where, "relation"))
        for number, entry in enumerate(body.get("entries", [])):
            at = (*where, "entries", number)
            links: dict[str, Any] = {}
            values: dict[str, Any] = {}
            for item in entry.get("mutations", []):
                kind, member = self._one(item, at)
                for change in member.get("mutations", []):
                    _, payload = self._one(change, at)  # an entry's links and properties are set
                    if kind == "as_link":
                        links[member["name"]] = self._resolve(payload.get("ref", {}).get("key"), at)
                    else:
                        prop = relation.entry.properties.get(member["name"])
                        if prop is None and self._store.framework(relation):
                            self._ignore(at, f"the relation has no property {member['name']!r}")
                            continue
                        if prop is None:
                            raise DecodeError(f"the relation has no property {member['name']!r}", path=path(*at))
                        values[member["name"]] = _decode(prop.type, payload.get("value"), at, self._store)
            self._link(relation, links, values, at)

    def _link(self, relation: Any, links: dict[str, Any], values: dict[str, Any], where: tuple) -> None:
        schemas = []  # the schema of each object linked
        for link, target in links.items():
            builder_class = self._B._builder_for(target)
            if builder_class is not None:
                builder, schema = builder_class(target, True, self._store), None
                schema = builder.as_schema()
            else:
                schema = target.as_schema()
                builder = self._store.builder(self._store.name_of(schema), target)
            schemas.append(schema)
            adjacency = next((name for name, held in schema.adjacencies.items()
                              if held.relation is relation and held.me == link), None)
            if adjacency is None:
                continue

            def fill(entry: Any, link: str = link) -> Any:
                for other, value in links.items():
                    if other != link:
                        getattr(entry, other)(value)
                for name, value in values.items():
                    _set(entry, name, value)
                return entry

            member = getattr(builder, adjacency)
            if getattr(getattr(member, "_members", None), "one", False):  # one entry: the one held is replaced
                member(lambda adv: adv.remove(lambda entry: entry))
            member(lambda adv: adv.insert(fill))
            builder.update()
            return
        reason = "no object an entry links declares an adjacency through which to add it"
        if any(self._store.framework(schema) for schema in schemas):  # one an extension of it would declare, missing
            self._ignore(where, reason)
            return
        raise DecodeError(reason, path=path(*where))


# --- Entry points ---


class ToPlain:
    """Serializes values to plain data, naming the schemas of objects in `store`: `ToPlain(store)(schema, value)`
    dispatches on the schema's kind. `flat=True` writes a dense container of several int indices flat, with its
    shape, rather than as nested arrays; reading takes either."""

    def __init__(self, store: Stores.Store, flat: bool = False):
        self._store, self._flat = store, flat

    def __call__(self, schema: Schemas.OfAny.Data, value: Any) -> PlainData:
        schema = Proxies._deref(schema)  # a path names its schema
        if isinstance(schema, Schemas.OfScalar.Data):
            return self.OfScalar(schema, value)
        if isinstance(schema, Schemas.OfObject.Data) and schema.ref:
            return self.OfObject(schema, value)
        if isinstance(schema, _VALUES):
            return self.Value(schema, value)
        raise NotImplementedError(f"{type(schema).__name__} is not supported by Plain yet")

    @staticmethod
    def OfScalar(schema: Schemas.OfScalar.Data, value: Scalar) -> PlainData:
        schema = Proxies._deref(schema)  # a path names its schema
        return schema.to_plain(value)

    def OfObject(self, schema: Schemas.OfObject.Data, value: Readers.OfObject) -> PlainData:
        """Snapshot of `value` alone; its references to other objects are left unresolved."""
        schema = Proxies._deref(schema)  # a path names its schema
        return _Snapshot(self._store, self._flat).run(schema, value, [value])

    def Reachable(self, schema: Schemas.OfObject.Data, value: Readers.OfObject) -> PlainData:
        """Snapshot of `value` and every object reachable from it through adjacencies (see `Reachable`)."""
        schema = Proxies._deref(schema)  # a path names its schema
        return _Snapshot(self._store, self._flat).run(schema, value, Reachable.of(value))

    def Snapshot(self) -> list[PlainData]:
        """The store as a log of mutations, its initial snapshot (docs/SERIALIZATION.md): modules, then schemas, then the
        other named singletons, then the remaining reference objects."""
        return _LogWriter(self._store).run()

    def Value(self, schema: Schemas.OfAny.Data, value: Any) -> PlainData:
        """A standalone value as plain data, written as a property holding it writes it: a value object, union value,
        intersection value or container of `schema`, read through its visitor, or a value of any type (`OfAny`), of a
        registered schema or a scalar."""
        schema = Proxies._deref(schema)  # a path names its schema
        held = schema
        if not isinstance(held, Schemas.OfAny.Value):
            own = value.as_schema()
            if own is not held:
                raise TypeError(f"value is a {own.name!r}, not an instance of the given schema")
        return _any(_Held(value), schema, _Snapshot(self._store, self._flat))[1]


class FromPlain:
    """Deserializes plain data, building objects in `store`: `FromPlain(store)(schema, plain)` dispatches on the
    schema's kind."""

    def __init__(self, store: Stores.Store):
        self._store = store

    def __call__(self, schema: Schemas.OfAny.Data, plain: PlainData) -> Any:
        schema = Proxies._deref(schema)  # a path names its schema
        if isinstance(schema, Schemas.OfScalar.Data):
            return self.OfScalar(schema, plain)
        if isinstance(schema, Schemas.OfObject.Data) and schema.ref:
            return self.OfObject(schema, plain)
        if isinstance(schema, _VALUES):
            return self.Value(schema, plain)
        raise NotImplementedError(f"{type(schema).__name__} is not supported by Plain yet")

    @staticmethod
    def OfScalar(schema: Schemas.OfScalar.Data, plain: PlainData) -> Scalar:
        schema = Proxies._deref(schema)  # a path names its schema
        try:
            return schema.from_plain(plain)
        except DecodeError as error:
            raise error.at("$") from None

    def OfObject(self, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
        schema = Proxies._deref(schema)  # a path names its schema
        return _restore(self._store, schema, plain)

    def Reachable(self, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
        schema = Proxies._deref(schema)  # a path names its schema
        return _restore(self._store, schema, plain)

    def Snapshot(self, log: PlainData, ignored: list[dict[str, str]] | None = None) -> list[Any]:
        """Applies a log of mutations, an initial snapshot, to the store, through its builders; returns the objects it
        makes, in order, which the caller holds (a store holds its data objects weakly). A sub-clause whose meaning needs
        an extension the store lacks is ignored, and added to `ignored`, where given: its path and why."""
        return _LogReader(self._store, ignored).apply(log)

    def Value(self, schema: Schemas.OfAny.Data, plain: PlainData) -> Any:
        """A standalone value, read from the plain form `ToPlain(store).Value` writes and built through the store's
        builder of its schema, which the store registers; a scalar as itself."""
        schema = Proxies._deref(schema)  # a path names its schema
        decoded = _decode(schema, plain, (), self._store)
        if isinstance(decoded, (_Record, _Elements)):
            try:
                name = self._store.name_of(decoded.schema)
            except LookupError:
                raise TypeError("a standalone value is built through the store's builder of its schema, which the store "
                                "registers; this one is not registered") from None
            decoded = _Assigned(name, decoded, self._store)
        return decoded.make() if isinstance(decoded, _Assigned) else decoded

