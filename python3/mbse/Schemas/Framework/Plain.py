"""Plain: conversion between values and plain data (dicts, lists, strings, numbers, booleans, null).

`ToPlain(store)(schema, value)` and `FromPlain(store)(schema, plain)` dispatch on the schema's kind;
`ToPlain(store).OfObject(...)` etc. are the per-kind forms. The store (see `Visitors.OfStore`) names the schemas of the objects
written, and builds the objects read. JSON and YAML are thin text encodings of plain data.

A reference object is written as a document (`ToPlain(store).OfObject`, `.Reachable`): one transaction, whose upsert's
symbols are the objects the document holds, numbered in the order it meets them, the root `"0"`; what it does not hold
is referred to by its path. Reading one executes it, within the open transaction as a savepoint, and gives its root. A
store is written as its snapshot (`ToPlain(store).Snapshot()`): two transactions, its schemas, then its data, which
`FromPlain(store).Snapshot` executes in order. A transaction's expression is written nested
(`ToPlain(store).Transaction`). See docs/SERIALIZATION.md, Transactions on the wire, Documents and Snapshots.

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
import json
import math
from collections.abc import Callable, Hashable, Iterator
from typing import Any, NamedTuple, Protocol

from . import Proxies, Reachable, Readers, Schemas, Visitors
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
    """A value of any schema as plain data, and whether there is one: restricted, written bare as the schema it holds;
    unrestricted, tagged with its schema, a basic scalar's tag or its schema's registered name."""
    found: list[Any] = []
    read.as_scalar(lambda s: found.extend([] if s.get() is None else [s.get()]) or s)
    for select in ("as_object", "as_union", "as_intersection", "as_container"):
        getattr(read, select)(lambda v: found.extend([v] if _present(v) else []) or v)
    if not found:
        return False, None
    value, restricted = found[0], list(schema.schemas)
    if type(value) in Schemas.SCALAR_TYPES:
        scalar = Schemas.OfScalar.Data(type(value))
        if not restricted:
            return True, {scalar.tag: scalar.to_plain(value)}
        own = next((t for t in restricted if isinstance(t, Schemas.OfScalar.Data) and t.type is type(value)), None)
        if own is None:  # builders do not check scalars' values; proxies refuse a value of another schema
            raise TypeError(f"a value of any schema holds one of its schemas; {type(value).__name__} is not one")
        return _any(read, own, ref)
    own = value.as_schema()
    return True, {ref.name_of(own): _any(read, own, ref)[1]} if not restricted else _any(read, own, ref)[1]


def _tensor(schema: Schemas.OfContainer.Data) -> list[str] | None:
    """The names of a container's int indices, where its index is a value object of ints; None otherwise."""
    index = schema.index
    if not isinstance(index, Schemas.OfObject.Data):
        return None
    hosts = [prop.schema for prop in index.properties.values()]
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
        return {name: prop.schema.to_plain(value)
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
    """A union's branch or an intersection's part as plain data: its visitor is of its schema's kind."""
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
        present, plain = _member(getattr(read, name), member.schema, ref)
        if present:
            out[name] = plain
    return out


def _object(read: Readers.OfObject, schema: Schemas.OfObject.Data, ref: Ref) -> dict[str, PlainData]:
    """A value object, nested in what holds it, as a mapping of its properties that are set, in the schema's order; it
    has no adjacencies, and nothing links it."""
    return {prop.as_schema().name: _value(prop, prop.as_schema().schema, ref)[1] for prop in read.as_properties}


def _entry(read: Readers.OfEntry, adjacency: Schemas.OfAdjacency.Data, ref: Ref) -> dict[str, PlainData]:
    """An entry as a mapping: the links other than the object's own, as references, then its properties."""
    out: dict[str, PlainData] = {}
    for name in adjacency.relation.entry.links:
        if name != adjacency.me:
            out[name] = ref(getattr(read, name))
    for name, prop in adjacency.relation.entry.properties.items():
        present, plain = _value(getattr(read, name), prop.schema, ref)
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


# --- What the writers and readers share: values, paths, decoding ---


class _Values:
    """What `_value` needs to write values: the names their schemas are tagged with, and how a dense container of several
    int indices is written (`flat`). A value holds no reference: references are links, written as entries."""

    def __init__(self, store: Visitors.OfStore, flat: bool = False) -> None:
        self.store, self.flat = store, flat

    def __call__(self, target: Any) -> PlainData:  # pragma: no cover - values hold no references
        raise TypeError("a value holds no reference to an object")

    def name_of(self, schema: Any) -> str:
        """The name a value of any schema is tagged with: its schema's registered name."""
        schema = Proxies._deref(schema)  # a path names its schema
        try:
            return self.store.name_of(schema)
        except LookupError:
            raise TypeError(f"a value of any schema is of a registered schema; {schema.name!r} is not registered") from None


_ORDERED = (bool, int, float, str)


def _sorted(adjacency: Schemas.OfAdjacency.Data, entries: list[Any], rows: list[dict[str, PlainData]]) -> list[Any]:
    """An adjacency's entries in the order they are written: sorted by the key its relation declares from its end,
    read from their `rows` as `_entry` writes them, where every entry has each of its values and each holds values of
    one ordered scalar; else as they are."""
    names = adjacency.relation.key(adjacency.me)
    if names is None:
        return entries
    keys = [tuple(row.get(n) for n in names) for row in rows]
    if all(len({type(key[i]) for key in keys}) == 1 and type(keys[0][i]) in _ORDERED for i in range(len(names))):
        return [entries[i] for i in sorted(range(len(keys)), key=lambda i: keys[i])]
    return entries


def _path_of(value: Any) -> PlainData:
    """A reference object's path, as plain data, in its own store (`Paths.of`)."""
    from . import Paths

    store = Proxies.store_of(value)
    return ToPlain(store)(store.Paths.OfRoot.as_schema(), Paths.of(value))


def _steps(path_plain: PlainData, where: tuple) -> tuple[str, list[tuple[str, str, dict[str, Any]]]]:
    """A path as plain data: the singleton it starts from, and each entry transited (`i`, `o`, keys). `DecodeError`
    where it is not a `Paths.OfRoot` value."""
    def malformed(why: str) -> DecodeError:
        return DecodeError(f"a path is {{'singleton': name, 'next': {{'entry': ...}} or {{'target': {{}}}}}}: {why}",
                           path=path(*where))
    if not isinstance(path_plain, dict) or set(path_plain) != {"singleton", "next"}:
        raise malformed("a mapping of 'singleton' and 'next'")
    singleton, step, steps = path_plain["singleton"], path_plain["next"], []
    if not isinstance(singleton, str):
        raise malformed("its singleton is text")
    while not (isinstance(step, dict) and set(step) == {"target"}):
        entry = step.get("entry") if isinstance(step, dict) and set(step) == {"entry"} else None
        if (not isinstance(entry, dict) or set(entry) != {"i", "o", "properties", "next"}
                or not isinstance(entry["i"], str) or not isinstance(entry["o"], str)
                or not isinstance(entry["properties"], dict)):
            raise malformed("each step an entry of 'i', 'o', 'properties' and 'next'")
        steps.append((entry["i"], entry["o"], dict(entry["properties"])))
        step = entry["next"]
    return singleton, steps


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
        values[key] = _decode(schema.properties[key].schema, item, (*where, key), store)
    if isinstance(schema, Schemas.OfUnion.Data) and len(values) != 1:
        raise DecodeError(f"a union value holds exactly one branch, got {len(values)}", path=path(*where))
    return _Record(schema, values)


_FORMS = {bool: "bool", int: "int", float: "float", str: "text", dict: "mapping", list: "list"}


def _decode_any(schema: Schemas.OfAny.Value, plain: PlainData, where: tuple, store: Any) -> Any:
    """A value of any schema: restricted, of the one schema whose plain form it takes; unrestricted, a mapping of its schema,
    a basic scalar's tag or a schema's registered name, to its value."""
    if schema.schemas:
        fits = [t for t in schema.schemas if _FORMS.get(type(plain)) in Schemas.plain_forms(t)]
        if len(fits) != 1:
            raise DecodeError(f"a value of any schema takes the plain form of one of its schemas, got "
                              f"{type(plain).__name__}", path=path(*where))
        return _decode(fits[0], plain, where, store)
    if not isinstance(plain, dict) or len(plain) != 1:
        raise DecodeError("a value of any schema is {schema: value}, its schema a basic scalar's tag or a registered "
                          "schema's name", path=path(*where))
    ((tag, value),) = plain.items()
    scalar = next((t for t in Schemas.SCALAR_TYPES if Schemas.OfScalar.Data(t).tag == tag), None)
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


# For messages, per record kind: a value of it, its schema, and what its properties are.
_RECORDS = {
    Schemas.OfObject.Data: ("a value object", "the value object", "property"),
    Schemas.OfUnion.Data: ("a union value", "the union", "branch"),
    Schemas.OfIntersection.Data: ("an intersection value", "the intersection", "part"),
}


# Per reference object symbol: its decoded property values and its entries.
_Decoded = dict[str, tuple[dict[str, Any], Rows]]


def _schema_steps(path_plain: PlainData, where: tuple) -> list[tuple[str, str]]:
    """A schema object's path as plain data: each step's adjacency and the name its entry gives (docs/OBJECT_IDENTITY.md,
    Decided, 81). `DecodeError` where it is not one."""
    singleton, steps = _steps(path_plain, where)
    if singleton != "." or any(o != "" or set(keys) != {"name"} or not isinstance(keys["name"], str)
                               for _, o, keys in steps):
        raise DecodeError("a schema object's path starts from the root module, '.', and each step names an entry, "
                          "{'i': adjacency, 'o': '', 'properties': {'name': name}}", path=path(*where))
    return [(i, keys["name"]) for i, _, keys in steps]


def _by_path(store: Any, path_plain: PlainData, where: tuple) -> Any:
    """The object a path names in `store`, or None: a schema object from the root module (`Builders.Store.held`), a
    singleton, or through its owner's entries, the one whose keys the path's last step gives and whose other end's owner
    adjacency is `o`."""
    singleton, steps = _steps(path_plain, where)
    if singleton == ".":
        return store._at(_schema_steps(path_plain, where))
    if not steps:
        return store._singletons.get(singleton)
    nested: PlainData = {"target": {}}
    for i, o, keys in reversed(steps[:-1]):
        nested = {"entry": {"i": i, "o": o, "properties": keys, "next": nested}}
    owner = _by_path(store, {"singleton": singleton, "next": nested}, where)
    if owner is None:
        return None
    _, o, keys = steps[-1]
    for table in Proxies._entries_of(owner).values():
        for entry in table.values():
            for link, target in entry._links.items():
                if target is owner or not isinstance(target, Proxies._ObjectData):
                    continue
                schema = object.__getattribute__(target, "_schema")
                owned = [a for a in (*schema.adjacencies.values(), *schema.anonymous)
                         if a.owner and a.name == o and a.relation is entry._relation and a.me == link]
                if owned and entry._properties == keys:
                    return target
    return None


_SELECT = {Schemas.OfObject.Data: "as_object", Schemas.OfUnion.Data: "as_union",
           Schemas.OfIntersection.Data: "as_intersection"}


def _holds_members(visitor: Any) -> bool:
    """Whether a visitor's members are a union's branches or an intersection's parts, each of its own schema's kind,
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


# --- Schema paths ---


def _schema_path(steps: list[tuple[str, str]]) -> PlainData:
    """A schema object's path as plain data (docs/OBJECT_IDENTITY.md, Decided, 81): from the root module, the singleton
    `"."`, each step through a keyed adjacency, by name."""
    nested: PlainData = {"target": {}}
    for i, name in reversed(steps):
        nested = {"entry": {"i": i, "o": "", "properties": {"name": name}, "next": nested}}
    return {"singleton": ".", "next": nested}


# --- Documents, snapshots and transactions on the wire (docs/SERIALIZATION.md) ---


class _Document:
    """A Reachable document, or an object's: one transaction (docs/OBJECT_IDENTITY.md, Decided, 51, 55; Store overhaul,
    4f), one upsert whose symbols are the objects the document holds, named by their number in the order it meets them,
    the root `"0"`: the root, and, for Reachable, the counted objects reachable from it through the objects the document
    holds. Its spec gives each object's properties and its named adjacencies' entries, each entry once, from the first
    object that holds it; an object it does not hold, an owned object, a singleton or a schema object, is referred to by
    its path. Under the caller's uid, which keys its upsert, so that reading it again while its counted objects are held
    finds them (102)."""

    def __init__(self, store: Any, flat: bool) -> None:
        self.store, self.flat = store, flat
        self._numbers: dict[int, int] = {}  # each object the document holds, by id: its number
        self._order: list[Any] = []
        self._keying = False  # reading entries' keys: what they link is not yet referred to

    def name_of(self, schema: Any) -> str:  # the values' `Ref`: a value of any schema is tagged with its schema's name
        return _Values(self.store).name_of(schema)

    def __call__(self, target: Any) -> dict[str, PlainData]:  # what an entry links, as a spec refers to it
        if self._keying:
            return {}
        number = self._numbers.get(id(target))
        if number is not None:
            return {"symbol": str(number)}
        if isinstance(target, Proxies._ObjectData):
            if Proxies._counted(target):
                raise ValueError(f"a document refers to a counted {self.store.name_of(target.as_schema())!r} it does "
                                 "not hold: a counted object has no identity beyond the document that writes it")
            return {"path": _path_of(target)}
        return {"path": _schema_path(self.store._path(target))}  # a schema object, which an extension's relation links

    def _hold(self, value: Any) -> None:
        if id(value) not in self._numbers:
            self._numbers[id(value)] = len(self._order)
            self._order.append(value)

    def _entries(self, value: Any) -> list[tuple[str, Any, list[Any]]]:
        """Each named adjacency of `value` that holds entries, with them, in the order they are written."""
        schema, out = value.as_schema(), []
        for name, adjacency in schema.adjacencies.items():
            entries = list(getattr(value, name))
            if entries:
                self._keying = True
                rows = [_entry(entry, adjacency, self) for entry in entries]
                self._keying = False
                out.append((name, adjacency, _sorted(adjacency, entries, rows)))
        return out

    def run(self, schema: Schemas.OfObject.Data, root: Readers.OfObject, reachable: bool, uid: str | None) -> PlainData:
        schema = Proxies._deref(schema)  # a path names its schema
        if root.as_schema() is not schema:
            raise TypeError(f"value is a {root.as_schema().name!r}, not an instance of the given schema")
        if not schema.ref:
            raise TypeError(f"a snapshot's root must be a reference object; {schema.name!r} is a value object schema")
        if any(adjacency.owner for adjacency in schema.anonymous) and not any(
                adjacency.owner for adjacency in schema.adjacencies.values()):
            raise ValueError(f"a {self.store.name_of(schema)!r} is owned through an adjacency with no name: a document "
                             "cannot give the entry that owns it; name the adjacency")
        self._hold(root)
        position = 0
        while reachable and position < len(self._order):  # what it holds, in the order it meets them
            value = self._order[position]
            position += 1
            for _, adjacency, entries in self._entries(value):
                for entry in entries:
                    for link in adjacency.relation.entry.links:
                        target = getattr(entry, link)
                        if link != adjacency.me and isinstance(target, Proxies._ObjectData) and Proxies._counted(target):
                            self._hold(target)
        written: set[int] = set()
        items: list[dict[str, PlainData]] = []
        for number, value in enumerate(self._order):
            members: list[PlainData] = [
                {"as_property": {"name": prop.as_schema().name, "mutations": [
                    {"set": {"value": _value(prop, prop.as_schema().schema, self)[1]}}]}}
                for prop in value.as_properties]
            for name, adjacency, entries in self._entries(value):
                fresh = [entry for entry in entries if id(entry) not in written]
                written.update(id(entry) for entry in fresh)
                rows = [_entry(entry, adjacency, self) for entry in fresh]
                if rows:
                    members.append({"as_adjacency": {"name": name, "mutations": [{"insert": {"entries": [
                        self._spec_entry(row, adjacency) for row in rows]}}]}})
            if members:
                items.append({str(number): members})
        symbols = {str(number): value.as_schema() for number, value in enumerate(self._order)}
        for schema_ in symbols.values():
            if not self.store.holds(schema_):
                raise ValueError(f"a document refers to its objects' schemas by their paths; {schema_.name!r} is a schema "
                                 "the store does not hold")
        store = self.store
        transaction = store.Mutations.OfTransaction(lambda t: (t if uid is None else t.uid(uid)).mutations([
            lambda mu: mu.upsert(lambda u: (u if uid is None else u.key(uid)).exists([
                lambda p: p.symbols(symbols).spec(items)]))]))
        return _Expression(store).object(transaction)

    @staticmethod
    def _spec_entry(row: dict[str, PlainData], adjacency: Any) -> PlainData:
        """An entry as a spec inserts it: its links set to what they refer to, then its properties."""
        links = [link for link in adjacency.relation.entry.links if link != adjacency.me]
        return {"mutations": [
            *({"as_link": {"name": link, "mutations": [{"set": {"ref": row[link]}}]}} for link in links),
            *({"as_property": {"name": name, "mutations": [{"set": {"value": row[name]}}]}}
              for name in adjacency.relation.entry.properties if name in row),
        ]}


_READS = itertools.count(1)  # documents read with no uid of their own, each keyed afresh


def _read_document(store: Any, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
    """Reads a document (`_Document`): executes its transaction, within the store's open one as a savepoint, else as a
    transaction of its own, and gives its root, the object its symbol `"0"` binds. A document with no uid is keyed afresh
    by each read, so that reading it gives new counted objects (Decided, 55)."""
    from . import Transactions

    schema = Proxies._deref(schema)  # a path names its schema
    if not isinstance(schema, Schemas.OfObject.Data):
        raise TypeError(f"the root schema must be an object schema, got {type(schema).__name__}")
    if not schema.ref:
        raise TypeError("the root schema must be a reference object schema")
    if not isinstance(plain, dict):
        raise DecodeError("expected a document, a transaction's expression", path="$")
    if "uid" not in plain and isinstance(plain.get("mutations"), list) and len(plain["mutations"]) == 1 \
            and isinstance(plain["mutations"][0], dict) and isinstance(plain["mutations"][0].get("upsert"), dict):
        plain = {**plain, "mutations": [{"upsert": {**plain["mutations"][0]["upsert"], "key": f"\0{next(_READS)}"}}]}
    transaction = FromPlain(store).Transaction(plain)
    with store._joined():  # what it writes, kept only where its root is what is asked for
        frames = Transactions._execute(store, transaction, joined=True)
        if len(frames) != 1 or "0" not in frames[0]:
            raise DecodeError("a document binds its root, the symbol '0', in one frame", path="$")
        root = frames[0]["0"]
        if not Schemas.is_a(root.as_schema(), schema):
            raise TypeError(f"the document's root is a {store.name_of(root.as_schema())!r}, not an instance of the given "
                            "schema")
    return root


class _StoreSnapshot:
    """A store's snapshot: two transactions (docs/OBJECT_IDENTITY.md, Decided, 45, 101; Store overhaul, 4f-4), each one
    upsert, the first of its schemas, the second of its data, so that a schema the store held before is extended when
    the first commits, before the second's data uses it. The first's symbols are its schemas with a name of their own,
    each a symbol of its meta-schema, found by its name (86); the second's, every object its singletons reach, and what
    the entries of an extension's relations linking its schemas reach. A schema the store was made holding is a symbol
    only to write the entries of an extension's relations it holds. Each symbol's spec gives its properties and its named
    adjacencies' entries, each entry once, from the first symbol that holds it; a schema object with no name of its own
    is defined where it is linked; an object neither transaction holds is referred to by its path."""

    def __init__(self, store: Any) -> None:
        from . import Builders

        if not isinstance(store, Builders.Store):
            raise TypeError("a snapshot is of a Builders.Store, which holds its schemas and its modules")
        self.store, self._B, self._names = store, Builders, _Values(store)
        self._numbers: dict[int, int] = {}  # each object the transaction being written holds, by id: its symbol
        self._written: dict[Hashable, int] = {}  # each entry written, by what tells it apart: how often

    def _reader(self, value: Any) -> Any:
        """A visitor of a schema object: its builder, read-only."""
        return self._B._builder_for(value)(value, False, self.store)

    @staticmethod
    def _original(visitor: Any) -> Any:
        return getattr(visitor, "_original", visitor)

    def _target(self, entry: Any, link: str, where: str) -> Any:
        """The object an entry links at `link`, as a visitor; a schema object the store does not hold is refused: there
        are no foreign schemas."""
        target = getattr(entry, link)
        if isinstance(target, self._B._Link):
            target = target._target()
        elif self._B._builder_for(target) is not None:
            target = self._reader(target)
        held = getattr(target, "_original", None)
        if held is not None and not self.store.holds(held):
            shown = getattr(held, "name", None) or type(held).__name__
            raise ValueError(f"{where} links {shown}, a schema the store does not hold: there are no foreign schemas")
        return target

    def _where(self, visitor: Any, adjacency: Any) -> str:
        """Where an entry is, in a message: the object whose adjacency holds it, and its relation."""
        steps = self.store._path(visitor._original) if self._schema(visitor) else None
        shown = ".".join(name for _, name in steps) if steps else self.store.name_of(visitor.as_schema())
        return f"{shown}, {adjacency.relation.name},"

    def _schema(self, visitor: Any) -> bool:
        return not isinstance(visitor, Proxies._ObjectData)

    def _entries(self, visitor: Any) -> list[tuple[str, Any, list[Any]]]:
        """Each named adjacency of an object that holds entries, with them: data's in the order written (`_sorted`), a
        schema object's as held."""
        out = []
        for name, adjacency in visitor.as_schema().adjacencies.items():
            entries = list(getattr(visitor, name))
            if entries and not self._schema(visitor):
                rows = [{n: _value(getattr(e, n), p.schema, self._names)[1]
                         for n, p in adjacency.relation.entry.properties.items()} for e in entries]
                entries = _sorted(adjacency, entries, rows)
            if entries:
                out.append((name, adjacency, entries))
        return out

    def _key(self, visitor: Any, adjacency: Any, entry: Any) -> Hashable:
        """What tells an entry apart, whichever end it is read from: its relation, what it links, its properties."""
        relation = adjacency.relation
        where = self._where(visitor, adjacency)
        links = tuple(sorted((link, id(self._original(visitor) if link == adjacency.me
                                       else self._original(self._target(entry, link, where)))) for link in relation.entry.links))
        values = tuple((n, repr(_value(getattr(entry, n), p.schema, self._names)[1])) for n, p in relation.entry.properties.items())
        return id(relation), links, values

    def _fresh(self, visitor: Any, adjacency: Any, entries: list[Any]) -> list[Any]:
        """The entries not written yet from another end, each counted written."""
        fresh, seen = [], {}
        for entry in entries:
            key = self._key(visitor, adjacency, entry)
            seen[key] = seen.get(key, 0) + 1
            if seen[key] > self._written.get(key, 0):
                fresh.append(entry)
        for key, count in seen.items():
            self._written[key] = max(self._written.get(key, 0), count)
        return fresh

    def _refer(self, target: Any) -> PlainData:
        """What an entry links, as a spec refers to it: a symbol, a path, or, a schema object with no name of its own,
        its definition where it is linked."""
        number = self._numbers.get(id(self._original(target)))
        if number is not None:
            return {"ref": {"symbol": str(number)}}
        original = target._original  # not a symbol: a schema object, as every object the snapshot reaches is one
        if self._B._named(original) or self.store.framework(original):
            return {"ref": {"path": _schema_path(self.store._path(original))}}
        return {"def": {"schema": self.store.name_of(target.as_schema()), "mutations": self._members(target, None)}}

    def _members(self, visitor: Any, wanted: Any) -> list[PlainData]:
        """What a spec gives of an object: its properties set, then its named adjacencies' entries not yet written;
        `wanted` chooses the entries an extension's relations add (a schema the store was made holding)."""
        framework = self._schema(visitor) and self.store.framework(visitor._original)
        members: list[PlainData] = [
            {"as_property": {"name": prop.as_schema().name, "mutations": [
                {"set": {"value": _value(prop, prop.as_schema().schema, self._names)[1]}}]}}
            for prop in visitor.as_properties if not framework or prop.as_schema().name == "name"]
        for name, adjacency, entries in self._entries(visitor):
            relation = adjacency.relation
            if framework and self.store.framework(relation):
                continue  # the store's own, between its own schemas: never written
            others = [link for link in relation.entry.links if link != adjacency.me]
            where = self._where(visitor, adjacency)
            kept = [entry for entry in entries
                    if wanted is None or wanted(self._target(entry, others[0], where))]
            written = []
            for entry in self._fresh(visitor, adjacency, kept):
                parts = [{"as_link": {"name": link, "mutations": [{"set": self._refer(self._target(entry, link, where))}]}}
                         for link in others]
                for n, prop in relation.entry.properties.items():
                    present, plain = _value(getattr(entry, n), prop.schema, self._names)
                    if present:
                        parts.append({"as_property": {"name": n, "mutations": [{"set": {"value": plain}}]}})
                written.append({"mutations": parts})
            if written:
                members.append({"as_adjacency": {"name": name, "mutations": [{"insert": {"entries": written}}]}})
        return members

    def _transaction(self, symbols: list[tuple[Any, Any]]) -> PlainData:
        """One transaction of one upsert over `symbols`, each an object and which of its entries the spec writes."""
        self._numbers = {id(self._original(v)): n for n, (v, _) in enumerate(symbols)}
        items = []
        for number, (visitor, wanted) in enumerate(symbols):
            members = self._members(visitor, wanted)
            if members:
                items.append({str(number): members})
        held = {str(n): v.as_schema() for n, (v, _) in enumerate(symbols)}
        store = self.store
        transaction = store.Mutations.OfTransaction(lambda t: t.mutations([lambda mu: mu.upsert(lambda u: u.exists([
            lambda p: p.symbols(held).spec(items)]))]))
        return _Expression(store).object(transaction)

    def run(self) -> list[PlainData]:
        store = self.store
        schemas = [self._reader(store.registered(name)) for name in store.names()
                   if not store.framework(store.registered(name))]
        framework = [self._reader(held) for held in store._objects.values()
                     if store.framework(held) and self._B._named(held)]
        is_data = lambda target: not self._schema(target)  # noqa: E731
        extending = [(v, lambda t: not is_data(t)) for v in framework if any(self._linked(v, False))]
        first = self._transaction([(v, lambda t: not is_data(t)) for v in schemas] + extending)
        reached: list[Any] = []
        met: set[int] = set()

        def reach(value: Any) -> None:
            if id(value) not in met:
                met.add(id(value))
                reached.append(value)

        for singleton in store._singletons.values():
            reach(singleton)
        holders = [v for v in (*schemas, *framework) if any(self._linked(v, True))]
        for visitor in holders:
            for target in self._linked(visitor, True):
                reach(target)
        position = 0
        while position < len(reached):
            for _, adjacency, entries in self._entries(reached[position]):
                for entry in entries:
                    for link in adjacency.relation.entry.links:
                        if link != adjacency.me:
                            target = self._target(entry, link, self._where(reached[position], adjacency))
                            if is_data(target):
                                reach(target)
            position += 1
        second = self._transaction([(v, None) for v in reached] + [(v, is_data) for v in holders])
        return [first, second]

    def _linked(self, visitor: Any, data: bool) -> Iterator[Any]:
        """What a schema object's entries of an extension's relations link: data (`data`), or schema objects."""
        for _, adjacency, entries in self._entries(visitor):
            if self.store.framework(adjacency.relation):
                continue
            for entry in entries:
                for link in adjacency.relation.entry.links:
                    if link != adjacency.me:
                        target = self._target(entry, link, self._where(visitor, adjacency))
                        if self._schema(target) != data:
                            yield target


_SNAPSHOTS = itertools.count(1)  # snapshots read, each keyed afresh


def _read_snapshot(store: Any, transactions: PlainData, ignored: list[dict[str, str]] | None) -> list[Any]:
    """Reads a store's snapshot (`_StoreSnapshot`): executes each transaction in order, each a transaction of its own, or
    a savepoint of the one open, and gives the objects the last binds, its data, which the caller holds. What needs an
    extension the store lacks, a member of a schema it was made holding, is ignored, and added to `ignored`, where
    given (Store overhaul, Decided, 19)."""
    from . import Builders, Transactions

    if not isinstance(store, Builders.Store):
        raise TypeError("a snapshot is read into a Builders.Store, which holds its schemas and its modules")
    if not isinstance(transactions, list):
        raise DecodeError("expected a snapshot, a list of transactions", path="$")
    transactions = json.loads(json.dumps(transactions))  # what an extension the store lacks needs is dropped from a copy
    ignored = [] if ignored is None else ignored  # ignored, kept or not
    bound: list[Any] = []
    for i, plain in enumerate(transactions):
        if isinstance(plain, dict) and isinstance(plain.get("mutations"), list) and len(plain["mutations"]) == 1 \
                and isinstance(plain["mutations"][0], dict) and isinstance(plain["mutations"][0].get("upsert"), dict):
            plain["mutations"][0]["upsert"]["key"] = f"\0snapshot {next(_SNAPSHOTS)}"
        schema = store.registered("Mutations.OfTransaction")
        transaction = store.Mutations.OfTransaction(lambda t, p=plain, at=(i,): _built(store, t, schema, p, at, ignored))
        frames = Transactions._execute(store, transaction, joined=True)
        bound = [target for target in frames[0].values() if isinstance(target, Proxies._ObjectData)]
    return bound


class _Expression:
    """A transaction's expression as the wire carries it, nested (docs/OBJECT_IDENTITY.md, Decided, 56; Store overhaul,
    4f): an object as a mapping of its properties and its named adjacencies' entries. An entry of a relation of one
    other link and no properties is written as what it links, the peer shorthand; of one other link and one property
    (a name), its adjacency as a mapping of that property to what it links; any other as a mapping of its other links
    and its properties. What it links is nested where it has no path (a term, linked from one place; a schema object
    with no name of its own), tagged with its kind where its link is a kind union, or with its schema's name where
    several schemas fill its link; else referred to by its path, `{"$ref": path}`. A pattern's spec is written as
    recorded."""

    def __init__(self, store: Any) -> None:
        from . import Builders

        self._store, self._B, self._names = store, Builders, _Values(store)
        self._met: list[Any] = []  # what it nested, each once

    def _reader(self, value: Any) -> Any:
        builder = self._B._builder_for(value)
        return builder(value, False, self._store) if builder is not None else value

    def object(self, visitor: Any) -> dict[str, PlainData]:
        schema = visitor.as_schema()
        out: dict[str, PlainData] = {prop.as_schema().name: _value(prop, prop.as_schema().schema, self._names)[1]
                                     for prop in visitor.as_properties}
        for name, adjacency in schema.adjacencies.items():
            entries = list(getattr(visitor, name))
            if entries:
                out[name] = self._entries(entries, adjacency)
        original = getattr(visitor, "_original", None)
        if isinstance(original, Schemas.OfPattern.Data) and original.spec:
            out["spec"] = [dict(item) for item in original.spec]
        return out

    def _entries(self, entries: list[Any], adjacency: Any) -> PlainData:
        relation, me = adjacency.relation, adjacency.me
        others = [link for link in relation.entry.links if link != me]
        props = list(relation.entry.properties.items())
        if len(others) == 1 and not props:
            return [self._linked(entry, relation, others[0]) for entry in entries]
        if len(others) == 1 and len(props) == 1:  # keyed by a name: no relation the expressions link has another key
            return {getattr(entry, props[0][0]).get(): self._linked(entry, relation, others[0]) for entry in entries}
        written = []
        for entry in entries:
            out: dict[str, PlainData] = {link: self._linked(entry, relation, link) for link in others}
            for name, prop in props:
                present, plain = _value(getattr(entry, name), prop.schema, self._names)
                if present:
                    out[name] = plain
            written.append(out)
        return written

    def _linked(self, entry: Any, relation: Any, link: str) -> PlainData:
        target = getattr(entry, link)
        if self._B._builder_for(target) is not None:
            target = self._reader(target)
        elif isinstance(target, self._B._Link):
            target = target._target()
        if not isinstance(target, Proxies._ObjectData):  # data an expression links is its terms, each nested
            steps = self._store._path(target._original)
            if steps is not None:
                return {REF: _schema_path(steps)}
        held = getattr(target, "_original", target)
        if any(met is held for met in self._met):
            raise ValueError("an expression links one of its terms from two places: it is written as a tree")
        self._met.append(held)
        body, own = self.object(target), target.as_schema()
        kinds = Proxies._link_kinds(relation, link)
        if kinds is not None:
            return {next(name for name, kind in kinds.items() if Schemas.is_a(own, kind)): body}
        return body if len(_fillers(self._store, relation, link)) == 1 else {self._store.name_of(own): body}


def _built(store: Any, visitor: Any, schema: Any, body: PlainData, where: tuple,
           ignored: list[dict[str, str]] | None = None) -> Any:
    """Builds, through `visitor`, the object an expression's nested form gives (`_Expression`)."""
    if not isinstance(body, dict):
        raise DecodeError(f"expected an object of {schema.name}, a mapping of its members", path=path(*where))
    for name, value in body.items():
        at = (*where, name)
        if name in schema.properties:
            _set(visitor, name, _decode(schema.properties[name].schema, value, at, store))
        elif name in schema.adjacencies:
            getattr(visitor, name)(_given(store, schema.adjacencies[name], value, at, ignored))
        elif name == "spec" and schema is store.registered("Schemas.OfPattern"):
            continue  # checked against its symbols' schemas, once they are read
        else:
            raise DecodeError(f"{name!r} is not a member of {schema.name}", path=path(*at))
    if "spec" in body and schema is store.registered("Schemas.OfPattern"):
        _checked_spec(store, visitor._working.symbols, body["spec"], (*where, "spec"), ignored)
        visitor.spec(body["spec"])  # as recorded
    return visitor


_SPEC = "expected a spec's mutations: as_property {name, mutations}, as_adjacency {name, mutations}, an entry {mutations}"


def _checked_spec(store: Any, symbols: dict[str, Any], spec: PlainData, where: tuple,
                  ignored: list[dict[str, str]] | None = None) -> None:
    """Checks a spec read from the wire before anything is written, so that a document refused writes nothing and says
    where: each symbol the pattern's, each member its object's schema's, each value decoded against its schema."""
    if not isinstance(spec, list):
        raise DecodeError("expected a list of what holds of a frame, by symbol", path=path(*where))
    for i, item in enumerate(spec):
        if not isinstance(item, dict):
            raise DecodeError("expected a mapping of symbols to their objects' mutations", path=path(*where, i))
        for symbol, members in item.items():
            held = symbols.get(symbol)
            if held is None:
                raise DecodeError(f"{symbol!r} is not a symbol of the pattern", path=path(*where, i, symbol))
            _checked_members(store, held.schema, members, (*where, i, symbol), symbols, ignored)


def _checked_members(store: Any, schema: Any, members: PlainData, where: tuple, symbols: dict[str, Any],
                     ignored: list[dict[str, str]] | None = None) -> None:
    """Checks what a spec gives of an object of `schema` (`_checked_spec`): a fault in its shape is reported where it is
    found, as what a spec's mutations are. A member a schema the store was made holding lacks, which an extension the
    store lacks gives, is dropped and added to `ignored`, where given (Store overhaul, Decided, 19)."""
    dropped: list[int] = []
    for j, member in enumerate(members if isinstance(members, list) else [None]):
        at = (*where, j)
        if not isinstance(member, dict) or len(member) != 1:
            raise DecodeError(_SPEC, path=path(*at))
        ((kind, body),) = member.items()
        try:
            name, verbs = body["name"], body["mutations"]
            if kind == "as_property" and name in schema.properties:
                _checked_values(store, schema.properties[name].schema, verbs, (*at, kind, "mutations"))
            elif kind == "as_adjacency" and name in schema.adjacencies:
                relation = schema.adjacencies[name].relation
                for k, verb in enumerate(verbs):
                    ((verb_kind, verb_body),) = verb.items()
                    for e, entry in enumerate(verb_body["entries"]):
                        entry["mutations"] = [item for m, item in enumerate(entry["mutations"]) if _checked_entry(
                            store, name, relation, item, (*at, kind, "mutations", k, verb_kind, "entries", e, "mutations",
                                                          m), symbols, ignored)]
            elif ignored is not None and store.framework(schema):
                ignored.append({"path": path(*at, kind), "reason": f"{schema.name} has no {kind[3:]} {name!r}"})
                dropped.append(j)
            else:
                raise DecodeError(f"{schema.name} has no {kind[3:]} {name!r}", path=path(*at, kind))
        except (AttributeError, KeyError, TypeError):
            raise DecodeError(_SPEC, path=path(*at)) from None
    for j in reversed(dropped):
        del members[j]


def _checked_values(store: Any, schema: Any, verbs: list[Any], where: tuple) -> None:
    for k, verb in enumerate(verbs):
        if "set" in verb:
            _decode(schema, verb["set"]["value"], (*where, k, "set", "value"), store)


def _checked_entry(store: Any, adjacency: str, relation: Any, member: Any, where: tuple, symbols: dict[str, Any],
                   ignored: list[dict[str, str]] | None = None) -> bool:
    """Checks one of an entry's mutations: its property's value, or what its link refers to or defines; whether it is
    kept, a property a relation the store was made holding lacks dropped where `ignored` is given."""
    ((kind, body),) = member.items()
    at = (*where, kind)
    if kind == "as_property" and body["name"] in relation.entry.properties:
        _checked_values(store, relation.entry.properties[body["name"]].schema, body["mutations"], (*at, "mutations"))
    elif kind == "as_link" and body["name"] in relation.entry.links:
        given = body["mutations"][0].get("set", {})
        if "def" in given:
            definition = given["def"]
            _checked_members(store, store.registered(definition["schema"]), definition["mutations"],
                             (*at, "mutations", 0, "set", "def", "mutations"), symbols, ignored)
        elif "symbol" in given.get("ref", {}) and given["ref"]["symbol"] not in symbols:
            raise DecodeError(f"{given['ref']['symbol']!r} is not a symbol of the pattern",
                              path=path(*at, "mutations", 0, "set", "ref", "symbol"))
        elif "path" in given.get("ref", {}):
            _steps(given["ref"]["path"], (*at, "mutations", 0, "set", "ref", "path"))
    elif ignored is not None and kind == "as_property" and store.framework(relation):
        ignored.append({"path": path(*at), "reason": f"an entry of {adjacency!r} has no property {body['name']!r}"})
        return False
    else:
        raise DecodeError(f"an entry of {adjacency!r} has no {kind[3:]} {body['name']!r}", path=path(*at))
    return True


def _given(store: Any, adjacency: Any, plain: PlainData, where: tuple, ignored: list[dict[str, str]] | None = None) -> Any:
    """An adjacency's entries in an expression's nested form, as its builder takes them: what each links, the peer
    shorthand; a mapping by the entry's one property; or each entry's links and properties."""
    relation, me = adjacency.relation, adjacency.me
    others = [link for link in relation.entry.links if link != me]
    props = list(relation.entry.properties.items())
    if len(others) == 1 and not props:
        if not isinstance(plain, list):
            raise DecodeError("expected a list of what the entries link", path=path(*where))
        return [_item(store, relation, others[0], item, (*where, i), ignored) for i, item in enumerate(plain)]
    if len(others) == 1 and len(props) == 1:
        if not isinstance(plain, dict):
            raise DecodeError(f"expected a mapping of each entry's {props[0][0]} to what it links", path=path(*where))
        return {key: _item(store, relation, others[0], item, (*where, key), ignored) for key, item in plain.items()}
    if not isinstance(plain, list):
        raise DecodeError("expected a list of entries", path=path(*where))

    def entry(item: PlainData, at: tuple) -> Any:
        if not isinstance(item, dict):
            raise DecodeError("expected an entry, a mapping of its links and properties", path=path(*at))

        def build(e: Any) -> Any:
            for name, value in item.items():
                if name in others:
                    getattr(e, name)(_item(store, relation, name, value, (*at, name), ignored))
                elif name in relation.entry.properties:
                    _set(e, name, _decode(relation.entry.properties[name].schema, value, (*at, name), store))
                else:
                    raise DecodeError(f"{name!r} is not a link or property of the entry", path=path(*at, name))
            return e

        return build

    return [entry(item, (*where, i)) for i, item in enumerate(plain)]


def _fillers(store: Any, relation: Any, link: str) -> list[str]:
    """The names of the schemas of what `link` may link: the reference object schema it declares, else each object schema
    that declares an adjacency to `relation` through it."""
    declared = relation.entry.links[link].schema
    if isinstance(declared, Schemas.OfObject.Data) and declared.ref:
        return [store.name_of(declared)]
    return store._filling(relation, link)


def _item(store: Any, relation: Any, link: str, plain: PlainData, where: tuple,
          ignored: list[dict[str, str]] | None = None) -> Any:
    """What an entry links, in an expression's nested form: the object a path names, or a callback defining one where it
    is linked, through its kind where the link is a kind union; where several schemas fill the link, the schema object
    its tag names, built."""
    if isinstance(plain, dict) and len(plain) == 1 and REF in plain:
        found = _by_path(store, plain[REF], (*where, REF))
        if found is None:
            raise DecodeError("no object at this path", path=path(*where, REF))
        return found
    kinds = Proxies._link_kinds(relation, link)
    if kinds is None:
        names = _fillers(store, relation, link)
        if len(names) == 1:
            linked = store.registered(names[0])
            return lambda e: getattr(e, link)(lambda x: _built(store, x, linked, plain, where, ignored))
        if not isinstance(plain, dict) or len(plain) != 1 or next(iter(plain)) not in names:
            raise DecodeError(f"expected an object of one of {', '.join(names)}, as {{schema: object}}",
                              path=path(*where))
        ((name, body),) = plain.items()
        builder = store._meta_builder(name)  # several schemas fill the link: schema objects', which it links built
        return _built(store, builder, store.registered(name), body, (*where, name), ignored).create()
    if not isinstance(plain, dict) or len(plain) != 1 or next(iter(plain)) not in kinds:
        raise DecodeError(f"expected one of the kinds {', '.join(kinds)}, as {{kind: object}}", path=path(*where))
    ((kind, body),) = plain.items()
    return lambda e: getattr(e, kind)(lambda x: _built(store, x, kinds[kind], body, (*where, kind), ignored))


# --- Entry points ---


class ToPlain:
    """Serializes values to plain data, naming the schemas of objects in `store`: `ToPlain(store)(schema, value)`
    dispatches on the schema's kind. `flat=True` writes a dense container of several int indices flat, with its
    shape, rather than as nested arrays; reading takes either."""

    def __init__(self, store: Visitors.OfStore, flat: bool = False):
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

    def OfObject(self, schema: Schemas.OfObject.Data, value: Readers.OfObject, uid: str | None = None) -> PlainData:
        """A document of `value` alone (`_Document`): what it links, by path; a counted object it links is refused."""
        return _Document(self._store, self._flat).run(schema, value, False, uid)

    def Reachable(self, schema: Schemas.OfObject.Data, value: Readers.OfObject, uid: str | None = None) -> PlainData:
        """A document of `value` and the counted objects reachable from it (`_Document`; Object identity, Decided, 51):
        one transaction, under `uid` where given."""
        return _Document(self._store, self._flat).run(schema, value, True, uid)

    def Snapshot(self) -> list[PlainData]:
        """The store's snapshot (`_StoreSnapshot`): two transactions, its schemas, then its data (docs/SERIALIZATION.md,
        Snapshots)."""
        return _StoreSnapshot(self._store).run()

    def Transaction(self, transaction: Any) -> PlainData:
        """A transaction's expression, as the wire carries it (`_Expression`): a journal is a list of them."""
        return _Expression(self._store).object(transaction)

    def Value(self, schema: Schemas.OfAny.Data, value: Any) -> PlainData:
        """A standalone value as plain data, written as a property holding it writes it: a value object, union value,
        intersection value or container of `schema`, read through its visitor, or a value of any schema (`OfAny`), of a
        registered schema or a scalar."""
        schema = Proxies._deref(schema)  # a path names its schema
        held = schema
        if not isinstance(held, Schemas.OfAny.Value):
            own = value.as_schema()
            if own is not held:
                raise TypeError(f"value is a {own.name!r}, not an instance of the given schema")
        return _any(_Held(value), schema, _Values(self._store, self._flat))[1]


class FromPlain:
    """Deserializes plain data, building objects in `store`: `FromPlain(store)(schema, plain)` dispatches on the
    schema's kind."""

    def __init__(self, store: Visitors.OfStore):
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
        """Reads a document, executing its transaction, and gives its root (`_read_document`)."""
        return _read_document(self._store, schema, plain)

    def Reachable(self, schema: Schemas.OfObject.Data, plain: PlainData) -> Any:
        return _read_document(self._store, schema, plain)

    def Snapshot(self, snapshot: PlainData, ignored: list[dict[str, str]] | None = None) -> list[Any]:
        """Reads a store's snapshot, executing its transactions (`_read_snapshot`); returns its data, the objects its last
        transaction binds, in order, which the caller holds (a store holds its data objects weakly). A member whose
        meaning needs an extension the store lacks is ignored, and added to `ignored`, where given: its path and why."""
        return _read_snapshot(self._store, snapshot, ignored)

    def Transaction(self, plain: PlainData) -> Any:
        """A transaction's expression, read from the form `ToPlain(store).Transaction` writes and built through the
        store's builders, as a program builds one; `store.transaction(...)` executes it."""
        schema = self._store.registered("Mutations.OfTransaction")
        return self._store.Mutations.OfTransaction(lambda t: _built(self._store, t, schema, plain, ()))

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

