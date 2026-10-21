"""Plain: conversion between values and plain data (dicts, lists, strings, numbers, booleans, null).

`ToPlain(store)(schema, value)` and `FromPlain(store)(schema, plain)` dispatch on the schema's kind;
`ToPlain(store).OfObject(...)` etc. are the per-kind forms. The store (see `Visitors.OfStore`) names the schemas of the objects
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
import json
import math
from collections.abc import Callable, Hashable
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


# --- Snapshots ---


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


def _number(called: PlainData) -> int | None:
    """The number a document gives a counted object, where `called` is `{'n': number}`; None for a path."""
    if isinstance(called, dict) and set(called) == {"n"}:
        number = called["n"]
        return number if isinstance(number, int) and not isinstance(number, bool) and number >= 0 else -1
    return None


def _symbol(called: PlainData) -> str:
    """What a reader tells an owner apart by: its path's canonical JSON."""
    return json.dumps(called, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


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


class _Placed(NamedTuple):
    """Where a document places an object: a singleton's global name, through an `owner()` adjacency the path of its
    owner, the adjacency's name and the entry's keys, or nowhere, a counted object, made anew."""

    key: str | None
    owner: str | None = None
    o: str = ""
    keys: dict[str, Any] = {}
    counted: bool = False


def _placed(called: PlainData, name: str, schema: Schemas.OfObject.Data, where: tuple) -> _Placed:
    """Where `called`, a path or a number, places an object of `schema`, registered as `name` (docs/OBJECT_IDENTITY.md,
    Decided, 55): a counted object is called by its number in the document, an owned object or a singleton by its path."""
    counted = schema.singleton is None and not any(
        a.owner for a in (*schema.adjacencies.values(), *schema.anonymous))
    if _number(called) is not None:
        if not counted:
            raise DecodeError(f"a {name!r} is {'a singleton' if schema.singleton else 'owned'}: it is called by its path, "
                              "not a number", path=path(*where))
        return _Placed(None, counted=True)
    if counted:
        raise DecodeError(f"a {name!r} is counted: it is called by its number in the document, {{'n': number}}, not a "
                          "path", path=path(*where))
    singleton, steps = _steps(called, where)
    if schema.singleton is not None:
        if steps or singleton != schema.singleton:
            raise DecodeError(f"the singleton {name!r} is the path of its global name {schema.singleton!r} alone",
                              path=path(*where))
        return _Placed(singleton)
    if not steps:
        raise DecodeError(f"a {name!r} is not a singleton: its path goes through what owns it", path=path(*where))
    # The owner's path: the same steps but the last.
    nested: PlainData = {"target": {}}
    for i, o, keys in reversed(steps[:-1]):
        nested = {"entry": {"i": i, "o": o, "properties": keys, "next": nested}}
    _, o, keys = steps[-1]
    return _Placed(None, _symbol({"singleton": singleton, "next": nested}), o, keys)


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


def _owner_adjacency(schema: Schemas.OfObject.Data, o: str) -> Schemas.OfAdjacency.Data:
    """The adjacency of `schema` marked `owner()` that a path's `o` names; the anonymous one where `o` is empty."""
    found = [a for a in (*schema.adjacencies.values(), *schema.anonymous) if a.owner and a.name == o]
    if len(found) != 1:
        raise DecodeError(f"{schema.name!r} has no adjacency {o!r} marked owner() for a path to go through")
    return found[0]


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
    other named singletons, each followed by the data it reaches. Each object is read through its visitor (a schema
    object through its builder, read-only) and written once, in definition form (`exists`), by its path or its number;
    the members of a schema object and the data it links follow it. A schema object with no name of its own has no
    path: its definition is written where the one object that links it links it (docs/OBJECT_IDENTITY.md, Decided, 81).
    An entry is written (`insert`) once every object it links is; a link to one of the framework's schemas, which every
    store holds, is a reference only."""

    def __init__(self, store: Any) -> None:
        from . import Builders

        if not isinstance(store, Builders.Store):
            raise TypeError("a snapshot is of a Builders.Store, which holds its schemas and its modules")
        self._B, self._store, self._names = Builders, store, _Names(store)
        self._out: list[PlainData] = []
        self._written: set[str] = set()
        self._complete: set[str] = set()  # written, with every object it holds or links that follows it
        self._pending: dict[Hashable, list[Any]] = {}  # an entry: [relation, links, properties, count, needs, scan]
        self._scans = 0  # each object's adjacencies are scanned once: an inner object's later than its owner's
        self._refs: dict[str, dict[str, PlainData]] = {}  # each object's reference on the wire, by its key
        self._nested: dict[str, tuple[dict[str, PlainData], set[str]]] = {}  # each object with no path: its definition
        self._shown: dict[str, str] = {}  # each object in a message: a schema object's path, dotted, else its kind; data's key
        self._counted = 0  # the counted objects numbered so far, in the order the log meets them

    def _reader(self, value: Any) -> Any:
        """A visitor of a schema object (its builder, read-only) or of data (the proxy itself)."""
        builder = self._B._builder_for(value)
        return builder(value, False, self._store) if builder is not None else value

    def _framework(self, visitor: Any) -> bool:
        held = getattr(visitor, "_original", None)
        return held is not None and self._store.framework(held)

    def _key(self, visitor: Any) -> str:
        """What tells an object apart in the writer: the registered name of its schema and its key. On the wire
        (`_refs`), a schema object or an owned object or a singleton is referred to by its path, and a counted object by
        its number in the log, in the order the log meets them (docs/OBJECT_IDENTITY.md, 55); a schema object with no
        path is not referred to (`_nested`)."""
        key = f"{self._store.name_of(visitor.as_schema())}/{Proxies._key_of(visitor)}"
        if key not in self._refs:
            if not isinstance(visitor, Proxies._ObjectData):  # a schema object, read through its builder
                steps = self._store._path(visitor._original)
                self._refs[key] = {} if steps is None else {"path": _schema_path(steps)}
                self._shown[key] = visitor._noun if steps is None else ".".join(name for _, name in steps) or "."
            elif Proxies._counted(visitor):
                self._refs[key] = {"n": self._counted}
                self._counted += 1
            else:
                self._refs[key] = {"path": _path_of(visitor)}
        return key

    def _held(self, visitor: Any, where: str) -> None:
        """Refuses a schema object the store does not hold, saying where it is linked: there are no foreign schemas."""
        held = getattr(visitor, "_original", None)
        if held is None:
            return  # data
        if not self._store.holds(held):
            shown = getattr(held, "name", None) or type(held).__name__
            raise ValueError(f"{where} links {shown}, a schema the store does not hold: there are no foreign schemas")

    def _properties(self, visitor: Any) -> dict[str, PlainData]:
        """The properties of an object that are set, by name."""
        return {prop.as_schema().name: _value(prop, prop.as_schema().schema, self._names)[1]
                for prop in visitor.as_properties}

    def define(self, visitor: Any, key: str, singleton: bool = False) -> None:
        """Writes an object in definition form, then what follows it. A singleton exists in every store that registers
        its schema, so that `exists` leaves it as it is there: its properties are set after it (`as_property`)."""
        if key in self._written:
            return
        self._written.add(key)
        properties = self._properties(visitor)
        ref = self._refs[key]
        definition = {**ref, "schema": self._store.name_of(visitor.as_schema()), "properties": {} if singleton else properties}
        self._out.append({"exists": {"definition": definition}})
        if singleton:
            self._out.extend({"as_property": {"ref": ref, "name": name, "mutations": [{"set": {"value": value}}]}}
                             for name, value in properties.items())
        contained: list[tuple[Any, str]] = []
        visitor.as_adjacencies(lambda adjacency: self._entries(adjacency, key, contained))
        for target, target_key in contained:
            self.define(target, target_key)
        self._complete.add(key)
        self._flush()

    def _target(self, entry: Any, link: str, where: str) -> Any:
        """The object an entry links at `link`, as a visitor: a schema object's builder, or data's proxy."""
        target = getattr(entry, link)
        if self._B._builder_for(target) is not None:  # a schema object a proxy's entry links (an extension's)
            target = self._reader(target)
        elif isinstance(target, self._B._Link):  # a schema object's entry: what it links, read
            target = target._target()
        self._held(target, where)
        return target

    def _where(self, key: str, schema: Any) -> str:
        """Where an entry is, in a message: the object whose adjacency holds it, and the adjacency."""
        return f"{self._shown.get(key, key)}, {schema.name},"

    def _linked(self, target: Any, needs: set[str], contained: list[tuple[Any, str]]) -> str:
        """The key of an object an entry links, noting what must be written before the entry (`needs`) and what follows
        the object being written (`contained`): a schema object with no path is defined where it is linked."""
        key = self._key(target)
        if self._framework(target):
            self._written.add(key)
            self._complete.add(key)
        elif not self._refs[key]:
            needs |= self._define_nested(target, key, contained)
            return key
        elif isinstance(target, Proxies._ObjectData) or not self._B._named(target._original):
            contained.append((target, key))  # a member follows its owner, and data what reaches it
        needs.add(key)
        return key

    def _define_nested(self, visitor: Any, key: str, contained: list[tuple[Any, str]]) -> set[str]:
        """The definition of a schema object with no path, its entries nested in it, each without its own link; what it
        needs written before it."""
        inserts: list[PlainData] = []
        needs: set[str] = set()

        def scan(adjacency: Any) -> Any:
            schema = adjacency.as_schema()
            relation, me = schema.relation, schema.me
            entries = []
            for entry in adjacency:
                links = {link: self._linked(self._target(entry, link, self._where(key, schema)), needs, contained)
                         for link in relation.entry.links if link != me}
                entries.append(self._entry(links, self._entry_properties(entry, relation)))
            if entries:
                relation_key = self._linked(self._reader(relation), needs, contained)
                inserts.append({"relation": self._refs[relation_key], "entries": entries})
            return adjacency

        visitor.as_adjacencies(scan)
        definition: dict[str, PlainData] = {"schema": self._store.name_of(visitor.as_schema()),
                                            "properties": self._properties(visitor)}
        if inserts:
            definition["inserts"] = inserts
        self._nested[key] = (definition, needs)
        return needs

    def _entry_properties(self, entry: Any, relation: Any) -> dict[str, PlainData]:
        properties: dict[str, PlainData] = {}
        for name, prop in relation.entry.properties.items():
            present, plain = _value(getattr(entry, name), prop.schema, self._names)
            if present:
                properties[name] = plain
        return properties

    def _entry(self, links: dict[str, str], properties: dict[str, PlainData]) -> PlainData:
        """An entry's mutations: each link set to a reference, or to a definition where what it links has no path."""
        return {"mutations": [
            *({"as_link": {"name": name, "mutations": [{"set": {"def": self._nested[target][0]} if target in self._nested
                                                                 else {"ref": self._refs[target]}}]}}
              for name, target in links.items()),
            *({"as_property": {"name": name, "mutations": [{"set": {"value": value}}]}}
              for name, value in properties.items()),
        ]}

    def _entries(self, adjacency: Any, key: str, contained: list[tuple[Any, str]]) -> Any:
        self._scans += 1
        schema = adjacency.as_schema()
        relation, me = schema.relation, schema.me
        counts: dict[Hashable, int] = {}
        for entry in adjacency:
            links: dict[str, str] = {}
            needs: set[str] = set()
            for link in relation.entry.links:
                if link == me:
                    links[link] = key
                    needs.add(key)
                    continue
                links[link] = self._linked(self._target(entry, link, self._where(key, schema)), needs, contained)
            properties = self._entry_properties(entry, relation)
            identity = (id(relation), tuple(sorted(links.items())), repr(sorted(properties.items())))
            counts[identity] = counts.get(identity, 0) + 1
            pending = self._pending.setdefault(identity, [relation, links, properties, 0, needs, self._scans])
            pending[3] = max(pending[3], counts[identity])
        return adjacency

    def _flush(self) -> None:
        """Writes the entries whose objects are all written: an inner object's (scanned later) before its owner's, so
        that an object is whole before it is placed; within one object's, in order. Consecutive entries of a relation
        go in one `insert`."""
        ready = sorted(((pending[5], number, identity) for number, (identity, pending) in enumerate(self._pending.items())
                        if pending[4] <= self._complete), key=lambda item: (-item[0], item[1]))
        for _, _, identity in ready:
            relation, links, properties, count, _, _ = self._pending.pop(identity)
            relation_ref = self._refs[self._key(self._reader(relation))]
            entry = self._entry(links, properties)
            last = self._out[-1] if self._out else None
            if isinstance(last, dict) and last.get("insert", {}).get("relation") == relation_ref:
                last["insert"]["entries"].extend([entry] * count)
            else:
                self._out.append({"insert": {"relation": relation_ref, "entries": [entry] * count}})

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
        for held in [held for held in store._objects.values() if store.framework(held) and self._B._named(held)]:
            self._extended(self._reader(held))
        return self._out  # every entry is written: it links objects of the store, each written

    def _extended(self, visitor: Any) -> None:
        """Writes the entries of an extension's relations that link a schema the store was made holding, which is never
        written itself: those its other end does not reach (a scalar's, written from the scalar's end)."""
        key, contained = self._key(visitor), []

        def scan(adjacency: Any) -> Any:
            if self._store.framework(adjacency.as_schema().relation):
                return adjacency  # the store's own: between its own schemas, never written
            return self._entries(adjacency, key, contained)

        visitor.as_adjacencies(scan)
        for target, target_key in contained:
            self.define(target, target_key)
        self._written.add(key)
        self._complete.add(key)
        self._flush()


def _schema_path(steps: list[tuple[str, str]]) -> PlainData:
    """A schema object's path as plain data (docs/OBJECT_IDENTITY.md, Decided, 81): from the root module, the singleton
    `"."`, each step through a keyed adjacency, by name."""
    nested: PlainData = {"target": {}}
    for i, name in reversed(steps):
        nested = {"entry": {"i": i, "o": "", "properties": {"name": name}, "next": nested}}
    return {"singleton": ".", "next": nested}


class _LogReader:
    """Applies a log of mutations to a store, each through the store's builders: `exists` creates an object only where
    its path is new, its properties read by their schema; `insert` adds entries, through an adjacency of an object each
    links, and creates a schema object with no path where an entry defines it (`def`), nested where it is linked, when
    the object that links it is new (docs/OBJECT_IDENTITY.md, Decided, 81). A sub-clause whose meaning needs an extension of a schema the store was made holding, which the store
    lacks, is ignored, and kept in `ignored` where it is given (docs/proposals/store-overhaul, Decided, 19): a property
    such a schema lacks, and an entry no linked object can hold where one of them is of such a schema."""

    def __init__(self, store: Any, ignored: list[dict[str, str]] | None = None) -> None:
        from . import Builders

        if not isinstance(store, Builders.Store):
            raise TypeError("a snapshot is read into a Builders.Store")
        self._B, self._store = Builders, store
        self._meta = {id(schema) for schema in vars(store._meta).values() if hasattr(schema, "validate")}  # its own
        self._made: list[Any] = []  # the objects made, held: a store holds its counted objects weakly
        self._numbered: dict[int, Any] = {}  # the counted objects the log made, by their numbers in it
        self._new: set[int] = set()  # the objects the log made, by id
        self._held_before: dict[tuple[int, int, tuple[str, ...]], bool] = {}  # see `_defines`
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

    def _resolve(self, ref: Any, where: tuple) -> Any:
        """The object a reference names: a schema object, an owned object or a singleton by its path, and a counted
        object by its number in the log."""
        if isinstance(ref, dict) and "n" in ref:
            number = _number({"n": ref["n"]})
            if number not in self._numbered:
                raise DecodeError(f"no counted object the log made is numbered {ref['n']!r}", path=path(*where, "n"))
            return self._numbered[number]
        if not isinstance(ref, dict) or "path" not in ref:
            raise DecodeError("a reference is {'path': path} or {'n': number}", path=path(*where))
        found = _by_path(self._store, ref["path"], (*where, "path"))
        if found is None:
            raise DecodeError("no object of the store has the path referred to", path=path(*where, "path"))
        return found

    def _one(self, item: Any, where: tuple) -> tuple[str, Any]:
        if not isinstance(item, dict) or len(item) != 1:
            raise DecodeError("a mutation is a mapping of one verb", path=path(*where))
        return next(iter(item.items()))

    def apply(self, log: PlainData) -> list[Any]:
        if not isinstance(log, list):
            raise DecodeError(f"a log is a list, got {type(log).__name__}", path="$")
        with self._store._joined():  # a transaction of its own, or the one open, until 4f (Object identity, Decided, 90)
            return self._apply(log)

    def _apply(self, log: list[Any]) -> list[Any]:
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
        called = definition.get("path")
        if not (isinstance(called, dict) and called.get("singleton") == "."):
            self._data(definition, where)
            return
        steps = _schema_steps(called, (*where, "path"))
        if self._store._at(steps) is not None:
            return
        made = self._schema_object(definition, where)
        i, name = steps[-1]  # the root module's, which every store holds, has none
        if i != "schemas":  # a member: its owner, at the path's other steps, holds it by the name the last gives
            owner = self._store._at(steps[:-1])
            if owner is None:
                raise DecodeError("the schema object's owner is not in the store", path=path(*where, "path"))
            builder = self._B._builder_for(owner)(owner, True, self._store)
            link = builder._members_[i].link

            def fill(entry: Any) -> Any:
                getattr(entry, link)(made)
                _set(entry, "name", name)
                return entry

            getattr(builder, i)(lambda adjacency: adjacency.insert(fill))
            builder.update()

    def _schema_object(self, definition: dict[str, Any], where: tuple) -> Any:
        """Creates a schema object from its definition: its kind, by its meta-schema's name, and its properties."""
        name = definition.get("schema")
        if not isinstance(name, str):
            raise DecodeError("a schema object's definition names its kind", path=path(*where, "schema"))
        schema = self._schema(name, (*where, "schema"))
        if id(schema) not in self._meta:
            raise DecodeError(f"{name!r} is not a kind of schema object: a path from the root module ('.') is a schema "
                              "object's", path=path(*where, "schema"))
        builder = self._B._META_BUILDERS[name.removeprefix("Schemas.")]()(None, True, self._store)
        properties = builder.as_schema().properties
        for prop_name, plain in definition.get("properties", {}).items():
            if prop_name not in properties:  # an extension of a schema the store was made holding, which it lacks
                self._ignore((*where, prop_name), f"{name} has no property {prop_name!r}")
                continue
            _set(builder, prop_name, _decode(properties[prop_name].schema, plain, (*where, prop_name), self._store))
        made = builder.create()
        self._made.append(made)
        self._new.add(id(made))
        return made

    def _defined(self, definition: Any, where: tuple) -> Any:
        """A schema object with no path, created from its definition where it is linked, with its entries."""
        if not isinstance(definition, dict):
            raise DecodeError("a definition is a mapping", path=path(*where))
        made = self._schema_object(definition, where)
        for number, body in enumerate(definition.get("inserts", [])):
            self._insert(body, (*where, "inserts", number), made)
        return made

    def _data(self, definition: dict[str, Any], where: tuple) -> None:
        """Creates a data object: an owned object or a singleton where its path places it, unless the store holds one
        there, through its owner, whose entry its path's last step gives; a counted object always anew, known by its
        number for the rest of the log."""
        name = definition.get("schema")
        if not isinstance(name, str):
            raise DecodeError("a data object's definition names its schema", path=path(*where, "schema"))
        schema = self._schema(name, (*where, "schema"))
        if not isinstance(schema, Schemas.OfObject.Data) or not schema.ref:
            raise DecodeError(f"{name!r} is not a reference object schema", path=path(*where, "schema"))
        called = definition["path"] if "path" in definition else {"n": definition["n"]}
        at = (*where, "path" if "path" in definition else "n")
        placed = _placed(called, name, schema, at)
        if placed.counted:
            number = _number(called)
            if number is None or number < 0 or number in self._numbered:
                raise DecodeError("a counted object's number in a log is an int, 0 or more, given once", path=path(*at))
        elif _by_path(self._store, called, at) is not None:
            return
        owner = None
        if placed.owner is not None:
            owner = _by_path(self._store, json.loads(placed.owner), (*where, "path"))
            if owner is None:
                raise DecodeError("the object's owner is not in the store", path=path(*where, "path"))
        builder = self._store.builder(name)
        for prop_name, plain in definition.get("properties", {}).items():
            if prop_name not in schema.properties:
                raise DecodeError(f"{name} has no property {prop_name!r}", path=path(*where, prop_name))
            _set(builder, prop_name, _decode(schema.properties[prop_name].schema, plain, (*where, prop_name), self._store))
        made = builder.create()
        self._new.add(id(made))
        if placed.counted:
            self._numbered[_number(called)] = made
        if owner is not None:
            adjacency = _owner_adjacency(schema, placed.o)
            link = next(other for other in adjacency.relation.entry.links if other != adjacency.me)
            Proxies._add_entry(adjacency.relation, Proxies._Entry(adjacency.relation, {link: owner, adjacency.me: made},
                                                                  placed.keys))
        self._made.append(made)

    def _as_property(self, body: dict[str, Any], where: tuple) -> None:
        """Sets or clears a property of an object that exists (a singleton's, in an initial snapshot)."""
        target = self._resolve(body.get("ref", {}), (*where, "ref"))
        name = body.get("name")
        schema = target.as_schema()
        if name not in schema.properties:
            raise DecodeError(f"{self._store.name_of(schema)} has no property {name!r}", path=path(*where, "name"))
        builder = self._store.builder(self._store.name_of(schema), target)
        for change in body.get("mutations", []):
            verb, payload = self._one(change, where)
            if verb == "set":
                _set(builder, name, _decode(schema.properties[name].schema, payload.get("value"), where, self._store))
            else:
                getattr(builder, name).as_value(lambda value: value.clear())
        builder.update()

    def _insert(self, body: dict[str, Any], where: tuple, defined: Any = None) -> None:
        """Adds entries of a relation; nested in the definition of `defined`, each leaves out the link it fills."""
        relation = self._resolve(body.get("relation", {}), (*where, "relation"))
        for number, entry in enumerate(body.get("entries", [])):
            at = (*where, "entries", number)
            links: dict[str, Any] = {}
            values: dict[str, Any] = {}
            definitions: dict[str, Any] = {}  # what the entry links that it defines, by link
            for item in entry.get("mutations", []):
                kind, member = self._one(item, at)
                for change in member.get("mutations", []):
                    _, payload = self._one(change, at)  # an entry's links and properties are set
                    if kind == "as_link" and "def" in payload:
                        definitions[member["name"]] = payload["def"]
                    elif kind == "as_link":
                        links[member["name"]] = self._resolve(payload.get("ref", {}), at)
                    else:
                        prop = relation.entry.properties.get(member["name"])
                        if prop is None and self._store.framework(relation):
                            self._ignore(at, f"the relation has no property {member['name']!r}")
                            continue
                        if prop is None:
                            raise DecodeError(f"the relation has no property {member['name']!r}", path=path(*at))
                        values[member["name"]] = _decode(prop.schema, payload.get("value"), at, self._store)
            if definitions and defined is None and not self._defines(relation, links, tuple(sorted(definitions))):
                continue  # it defines what an object the store held already links: that object was written with it
            for link, definition in definitions.items():
                links[link] = self._defined(definition, (*at, link))
            if defined is not None:
                left = [link for link in relation.entry.links if link not in links]
                if len(left) != 1:
                    raise DecodeError("an entry nested in a definition leaves out one link, the one the defined object "
                                      "fills", path=path(*at))
                links[left[0]] = defined
            self._link(relation, {link: links[link] for link in relation.entry.links if link in links}, values, at)

    def _defines(self, relation: Any, links: dict[str, Any], defined: tuple[str, ...]) -> bool:
        """Whether an entry that defines, at `defined`, objects with no path is new: an object it refers to is new, or,
        before the log was read, none held such an entry, as an object made with the store (its basic scalar) did not.
        Read again, a log so makes nothing."""
        if any(id(target) in self._new for target in links.values()):
            return True
        for target in links.values():
            key = (id(relation), id(target), defined)
            if key not in self._held_before:  # first asked before the log adds any: only a definition adds one
                me = next(link for link, linked in links.items() if linked is target)
                self._held_before[key] = self._links_unnamed(target, me, relation, defined)
            if self._held_before[key]:
                return False
        return True

    def _links_unnamed(self, target: Any, me: str, relation: Any, defined: tuple[str, ...]) -> bool:
        """Whether `target`, at `me`, holds an entry of `relation` linking, at one of `defined`, a schema object with no
        name of its own: data's entries are the store's, a schema object's read through its builder."""
        builder_class = self._B._builder_for(target)
        if builder_class is None:
            return any(self._B._builder_for(entry._links.get(link)) is not None and not self._B._named(entry._links[link])
                       for entry in Proxies._linking(relation, me, target, self._store) for link in defined)
        found: list[bool] = []

        def scan(adjacency: Any) -> Any:
            if adjacency.as_schema().relation is relation:
                for entry in adjacency:
                    for link in defined:
                        linked = getattr(entry, link)
                        linked = linked._target() if isinstance(linked, self._B._Link) else linked
                        held = getattr(linked, "_original", None)
                        found.append(held is not None and not self._B._named(held))
            return adjacency

        builder_class(target, False, self._store).as_adjacencies(scan)
        return any(found)

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

        self._store, self._B, self._names = store, Builders, _Names(store)
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


def _built(store: Any, visitor: Any, schema: Any, body: PlainData, where: tuple) -> Any:
    """Builds, through `visitor`, the object an expression's nested form gives (`_Expression`)."""
    if not isinstance(body, dict):
        raise DecodeError(f"expected an object of {schema.name}, a mapping of its members", path=path(*where))
    for name, value in body.items():
        at = (*where, name)
        if name in schema.properties:
            _set(visitor, name, _decode(schema.properties[name].schema, value, at, store))
        elif name in schema.adjacencies:
            getattr(visitor, name)(_given(store, schema.adjacencies[name], value, at))
        elif name == "spec" and schema is store.registered("Schemas.OfPattern"):
            continue  # checked against its symbols' schemas, once they are read
        else:
            raise DecodeError(f"{name!r} is not a member of {schema.name}", path=path(*at))
    if "spec" in body and schema is store.registered("Schemas.OfPattern"):
        _checked_spec(store, visitor._working.symbols, body["spec"], (*where, "spec"))
        visitor.spec(body["spec"])  # as recorded
    return visitor


_SPEC = "expected a spec's mutations: as_property {name, mutations}, as_adjacency {name, mutations}, an entry {mutations}"


def _checked_spec(store: Any, symbols: dict[str, Any], spec: PlainData, where: tuple) -> None:
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
            _checked_members(store, held.schema, members, (*where, i, symbol), symbols)


def _checked_members(store: Any, schema: Any, members: PlainData, where: tuple, symbols: dict[str, Any]) -> None:
    """Checks what a spec gives of an object of `schema` (`_checked_spec`): a fault in its shape is reported where it is
    found, as what a spec's mutations are."""
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
                        for m, item in enumerate(entry["mutations"]):
                            _checked_entry(store, name, relation, item, (*at, kind, "mutations", k, verb_kind, "entries",
                                                                         e, "mutations", m), symbols)
            else:
                raise DecodeError(f"{schema.name} has no {kind[3:]} {name!r}", path=path(*at, kind))
        except (AttributeError, KeyError, TypeError):
            raise DecodeError(_SPEC, path=path(*at)) from None


def _checked_values(store: Any, schema: Any, verbs: list[Any], where: tuple) -> None:
    for k, verb in enumerate(verbs):
        if "set" in verb:
            _decode(schema, verb["set"]["value"], (*where, k, "set", "value"), store)


def _checked_entry(store: Any, adjacency: str, relation: Any, member: Any, where: tuple, symbols: dict[str, Any]) -> None:
    """Checks one of an entry's mutations: its property's value, or what its link refers to or defines."""
    ((kind, body),) = member.items()
    at = (*where, kind)
    if kind == "as_property" and body["name"] in relation.entry.properties:
        _checked_values(store, relation.entry.properties[body["name"]].schema, body["mutations"], (*at, "mutations"))
    elif kind == "as_link" and body["name"] in relation.entry.links:
        given = body["mutations"][0].get("set", {})
        if "def" in given:
            definition = given["def"]
            _checked_members(store, store.registered(definition["schema"]), definition["mutations"],
                             (*at, "mutations", 0, "set", "def", "mutations"), symbols)
        elif "symbol" in given.get("ref", {}) and given["ref"]["symbol"] not in symbols:
            raise DecodeError(f"{given['ref']['symbol']!r} is not a symbol of the pattern",
                              path=path(*at, "mutations", 0, "set", "ref", "symbol"))
        elif "path" in given.get("ref", {}):
            _steps(given["ref"]["path"], (*at, "mutations", 0, "set", "ref", "path"))
    else:
        raise DecodeError(f"an entry of {adjacency!r} has no {kind[3:]} {body['name']!r}", path=path(*at))


def _given(store: Any, adjacency: Any, plain: PlainData, where: tuple) -> Any:
    """An adjacency's entries in an expression's nested form, as its builder takes them: what each links, the peer
    shorthand; a mapping by the entry's one property; or each entry's links and properties."""
    relation, me = adjacency.relation, adjacency.me
    others = [link for link in relation.entry.links if link != me]
    props = list(relation.entry.properties.items())
    if len(others) == 1 and not props:
        if not isinstance(plain, list):
            raise DecodeError("expected a list of what the entries link", path=path(*where))
        return [_item(store, relation, others[0], item, (*where, i)) for i, item in enumerate(plain)]
    if len(others) == 1 and len(props) == 1:
        if not isinstance(plain, dict):
            raise DecodeError(f"expected a mapping of each entry's {props[0][0]} to what it links", path=path(*where))
        return {key: _item(store, relation, others[0], item, (*where, key)) for key, item in plain.items()}
    if not isinstance(plain, list):
        raise DecodeError("expected a list of entries", path=path(*where))

    def entry(item: PlainData, at: tuple) -> Any:
        if not isinstance(item, dict):
            raise DecodeError("expected an entry, a mapping of its links and properties", path=path(*at))

        def build(e: Any) -> Any:
            for name, value in item.items():
                if name in others:
                    getattr(e, name)(_item(store, relation, name, value, (*at, name)))
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


def _item(store: Any, relation: Any, link: str, plain: PlainData, where: tuple) -> Any:
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
            return lambda e: getattr(e, link)(lambda x: _built(store, x, linked, plain, where))
        if not isinstance(plain, dict) or len(plain) != 1 or next(iter(plain)) not in names:
            raise DecodeError(f"expected an object of one of {', '.join(names)}, as {{schema: object}}",
                              path=path(*where))
        ((name, body),) = plain.items()
        builder = store._meta_builder(name)  # several schemas fill the link: schema objects', which it links built
        return _built(store, builder, store.registered(name), body, (*where, name)).create()
    if not isinstance(plain, dict) or len(plain) != 1 or next(iter(plain)) not in kinds:
        raise DecodeError(f"expected one of the kinds {', '.join(kinds)}, as {{kind: object}}", path=path(*where))
    ((kind, body),) = plain.items()
    return lambda e: getattr(e, kind)(lambda x: _built(store, x, kinds[kind], body, (*where, kind)))


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
        """The store as a log of mutations, its initial snapshot (docs/SERIALIZATION.md): modules, then schemas, then the
        other named singletons, then the remaining reference objects."""
        return _LogWriter(self._store).run()

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

    def Snapshot(self, log: PlainData, ignored: list[dict[str, str]] | None = None) -> list[Any]:
        """Applies a log of mutations, an initial snapshot, to the store, through its builders; returns the objects it
        makes, in order, which the caller holds (a store holds its data objects weakly). A sub-clause whose meaning needs
        an extension the store lacks is ignored, and added to `ignored`, where given: its path and why."""
        return _LogReader(self._store, ignored).apply(log)

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

