"""Proxies: the dynamic implementation.

Programs using proxies skip code generation: `register(name, schema)` makes a schema available, and
`Builders.<Name>(optional instance)` returns a builder for it. Instances (`Proxies.OfObject.Data`) are `Visitable`,
not visitors: they expose their properties as read-only attributes and write themselves into a visitor on `accept`.
Builders (`Proxies.OfObject.Builder`) implement `Visitors.OfObject`, like every builder.

Relation entries live in one global table per relation. Adding an entry equal to an existing one is elided.

A property whose schema is an `OfObject` holds an embedded object: a read-only record with no identity
(`Proxies.OfObject.Record`), read with attributes like an instance and set with a Spec, e.g.
`.reach(lambda r: r.number('+44'))`. Union and intersection values are records too, whose properties are the union's
branches or the intersection's parts, by name: `.reach(lambda u: u.phone(lambda p: p.number('+44')))` sets the branch
`phone`, read back as `card.reach.phone.number`, and setting one branch clears any other. An intersection value holds
each of its parts, set and read the same way (`card.meta.stamp.updated`).
"""

from __future__ import annotations

from collections.abc import Callable, Hashable, Iterator, Mapping
from typing import Any

from . import Schemas, Visitors
from .Visitors import Native

__all__ = ["register", "schema", "name_of", "Builders", "OfObject", "OfRelation"]

ObjectSchema = Schemas.OfObject.Data
RelationSchema = Schemas.OfRelation.Data


# --- Registry ---

_schemas: dict[str, ObjectSchema | RelationSchema] = {}


def register(name: str, schema: ObjectSchema | RelationSchema) -> None:
    """Registers a schema under a global name. The name need not be a valid identifier."""
    if name in _schemas:
        raise ValueError(f"schema {name!r} is already registered")
    _schemas[name] = schema


def schema(name: str) -> ObjectSchema:
    """The object schema registered under `name`."""
    return _object_schema(name)


def name_of(schema: ObjectSchema | RelationSchema) -> str:
    """The name `schema` is registered under."""
    for name, registered in _schemas.items():
        if registered is schema:
            return name
    raise LookupError("schema is not registered")


def _object_schema(name: str) -> ObjectSchema:
    schema = _schemas.get(name)
    if schema is None:
        raise AttributeError(f"no schema registered as {name!r}")
    if not isinstance(schema, ObjectSchema):
        raise TypeError(f"{name!r} is a relation; no relation builder is exposed")
    return schema


def _schema_filling(relation: RelationSchema, link: str) -> str:
    """Name of the registered object schema that declares an adjacency to `relation` via `link`."""
    names = [
        name
        for name, schema in _schemas.items()
        if isinstance(schema, ObjectSchema)
        and any(adj.relation is relation and adj.me == link for adj in schema.adjacencies.values())
    ]
    if len(names) != 1:
        raise TypeError(f"expected exactly one object schema filling link {link!r}, found {names}")
    return names[0]


class _Builders:
    """`Builders.<Name>(optional instance)`; use `getattr(Builders, name)` for names that are not identifiers.
    `schema` and `name_of` are methods, so schemas registered under those names are reachable only through `schema()`."""

    def schema(self, name: str) -> ObjectSchema:
        return schema(name)

    def name_of(self, schema: ObjectSchema | RelationSchema) -> str:
        return name_of(schema)

    def member(self, instance: Any, name: str) -> Any:
        """The value an instance or value object holds in its property `name`."""
        return _read(instance, name)

    def __getattr__(self, name: str) -> Callable[..., _ObjectBuilder]:
        schema = _object_schema(name)
        return lambda instance=None: _ObjectBuilder(schema, name, instance)


Builders = _Builders()


# --- Relation entries ---


def _native_key(value: Any) -> Hashable:
    """Equality key per EQUALITY.md: distinct native types never compare equal; floats compare by bit pattern; a value
    object by its schema and properties, whatever its identity."""
    if isinstance(value, _RecordData):
        values = object.__getattribute__(value, "_values")
        return ("object", id(value._schema), tuple(sorted((n, _native_key(v)) for n, v in values.items())))
    if type(value) not in (int, float, str, bool, bytes):
        raise TypeError(f"an entry property must be a native value or a value object, got {type(value).__name__}")
    if isinstance(value, float):
        return ("float", value.hex())
    return (type(value).__name__, value)


class _Entry:
    __slots__ = ("links", "properties")

    def __init__(self, links: Mapping[str, _ObjectData], properties: Mapping[str, Native]):
        self.links = dict(links)
        self.properties = dict(properties)

    def key(self) -> Hashable:
        return (
            tuple(sorted((name, id(target)) for name, target in self.links.items())),
            tuple(sorted((name, _native_key(value)) for name, value in self.properties.items())),
        )


class _RelationData:
    """All entries of one relation."""

    def __init__(self, schema: RelationSchema):
        self.schema = schema
        self._entries: dict[Hashable, _Entry] = {}

    def add(self, entry: _Entry) -> None:
        self._entries.setdefault(entry.key(), entry)

    def linking(self, link: str, target: _ObjectData) -> Iterator[_Entry]:
        return (entry for entry in list(self._entries.values()) if entry.links.get(link) is target)

    def discard_linking(self, link: str, target: _ObjectData) -> None:
        for key in [key for key, entry in self._entries.items() if entry.links.get(link) is target]:
            del self._entries[key]

    def discard_target(self, target: Any) -> None:
        """Discards every entry that links `target`, through any link."""
        for key in [key for key, entry in self._entries.items() if any(t is target for t in entry.links.values())]:
            del self._entries[key]


_relations: dict[int, _RelationData] = {}


def _relation_data(schema: RelationSchema) -> _RelationData:
    return _relations.setdefault(id(schema), _RelationData(schema))


# --- Instances ---


class _ObjectData:
    """A proxy instance. Properties are read-only attributes; reading one that is not set raises AttributeError."""

    __slots__ = ("_schema", "_schema_name", "_values")

    def __init__(self, schema: ObjectSchema, schema_name: str):
        object.__setattr__(self, "_schema", schema)
        object.__setattr__(self, "_schema_name", schema_name)
        object.__setattr__(self, "_values", {})

    def __getattr__(self, name: str) -> Any:
        return _read(self, name)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("proxy properties are read-only; use a builder")

    def identity(self) -> Hashable:
        return id(self)

    def schema_name(self) -> str:
        return self._schema_name

    def owner(self) -> None:
        return None

    def accept(self, visitor: Visitors.OfObject) -> None:
        """Writes properties in the schema's declared order, then entries adjacency by adjacency."""
        _write_properties(visitor, self._schema, self._values)
        _write_adjacencies(visitor, self, self._schema)


def _write_adjacencies(visitor: Any, target: Any, schema: ObjectSchema) -> None:
    """Writes the entries linking `target`, adjacency by adjacency."""
    for adjacency_name, adjacency in schema.adjacencies.items():
        for entry in _relation_data(adjacency.relation).linking(adjacency.me, target):
            visitor.adjacency(
                adjacency_name,
                lambda a, entry=entry, adj=adjacency: a.add(lambda e: _write_entry(e, entry, adj)),
            )


def _read(value: Any, name: str) -> Any:
    """A property of an instance or record, as an attribute."""
    values = object.__getattribute__(value, "_values")
    if name in values:
        return values[name]
    if name in object.__getattribute__(value, "_schema").properties:
        raise AttributeError(f"property {name!r} is not set")
    raise AttributeError(name)


def _write_properties(visitor: Any, schema: ObjectSchema, values: dict[str, Any]) -> None:
    """Writes the values that are set, in the schema's declared order."""
    for name in schema.properties:
        if name in values:
            visitor.property(name, lambda p, value=values[name]: p.value(lambda a: _write_value(a, value)))


def _write_value(visitor: Visitors.OfAny, value: Any) -> None:
    """Writes a native, an embedded object, a union value or an intersection value into a `Visitors.OfAny`."""
    if isinstance(value, _RecordData):
        _write_record(visitor, object.__getattribute__(value, "_schema"), lambda r: value.accept(r))
    else:
        visitor.as_native(lambda n: n.set(value))


def _noun(schema: Any) -> str:
    """What a record of `schema` is, for messages."""
    if isinstance(schema, Schemas.OfUnion.Data):
        return "union value"
    if isinstance(schema, Schemas.OfIntersection.Data):
        return "intersection value"
    return "embedded object"


def _a(noun: str) -> str:
    return f"a {noun}" if noun == "union value" else f"an {noun}"


class _RecordData:
    """A value object: the value of a property whose schema is an `OfObject`, which may have adjacencies, or a union or
    intersection value, whose properties are the branches or parts. It belongs to one owner and has an identity of its
    own; its properties are read-only attributes, and reading one that is not set raises AttributeError. Built but not
    yet placed in an owner, it holds its entries in `_pending` until its owner is created or updated."""

    __slots__ = ("_schema", "_values", "_owner", "_pending", "_source", "_copy_of")

    def __init__(self, schema: Any, values: dict[str, Any], pending: dict[str, list[_EntryBuilder]] | None = None,
                 source: _RecordData | None = None, copy_of: Any = None):
        for name, value in (("_schema", schema), ("_values", dict(values)), ("_owner", None),
                            ("_pending", pending or {}), ("_source", source), ("_copy_of", copy_of)):
            object.__setattr__(self, name, value)

    def __getattr__(self, name: str) -> Any:
        return _read(self, name)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(f"{_noun(self._schema)}s are read-only; use a builder")

    def identity(self) -> Hashable:
        return id(self)

    def schema_name(self) -> str:
        """The registered name of the value object's schema, or '' when it is not registered."""
        return next((name for name, schema in _schemas.items() if schema is self._schema), "")

    def owner(self) -> Any:
        return self._owner

    def accept(self, visitor: Visitors.OfObject) -> None:
        """Identifies itself (an object's value object), then writes its properties in the schema's declared order and
        the entries linking it."""
        if isinstance(self._schema, ObjectSchema):
            visitor.identify(self)
        _write_properties(visitor, self._schema, self._values)
        if isinstance(self._schema, ObjectSchema):
            _write_adjacencies(visitor, self, self._schema)


def _set(target: Any, name: str, value: Any) -> None:
    object.__getattribute__(target, "_values")[name] = value


def _stage(old: Any, new: Any, mapping: dict[int, Any]) -> Any:
    """Prepares `new` to be placed where `old` was: a value object owned elsewhere is copied, and `mapping` records, for
    each value object copied or edited, the one that takes its place, so that the entries among them link those."""
    if not isinstance(new, _RecordData) or new is old:
        return new
    if new._source is not None and new._source is old:  # an edit of `old`, which keeps its identity
        mapping[id(old)] = old
        _stage_values(new, old, mapping)
        return new
    if new._owner is not None:
        new = _copy(new)
    for original in (new._copy_of, new._source):
        if original is not None:
            mapping[id(original)] = new
    _stage_values(new, None, mapping)
    return new


def _stage_values(record: _RecordData, old: _RecordData | None, mapping: dict[int, Any]) -> None:
    held = {} if old is None else old._values
    for name, value in list(record._values.items()):
        _set(record, name, _stage(held.get(name), value, mapping))


def _copy(record: _RecordData) -> _RecordData:
    """A copy of a placed value object, with copies of the entries linking it and the value objects it holds."""
    builder = _RecordBuilder(record._schema)
    record.accept(builder)
    return builder.build()


def _finish(owner: Any, old: Any, new: Any, mapping: dict[int, Any]) -> Any:
    """Places a staged value: an edit is merged into `old`, and a value object built for it is adopted by `owner`."""
    if not isinstance(new, _RecordData) or new is old:
        return new
    if new._source is not None and new._source is old:
        _merge(old, new, mapping)
        return old
    object.__setattr__(new, "_owner", owner)
    for name, value in list(new._values.items()):
        _set(new, name, _finish(new, None, value, mapping))
    _add_pending(new, mapping)
    return new


def _add_pending(record: _RecordData, mapping: dict[int, Any]) -> None:
    """Adds a value object's entries, linked to the value objects that take the place of those in `mapping`."""
    for name, builders in record._pending.items():
        relation = _relation_data(record._schema.adjacencies[name].relation)
        for builder in builders:
            builder._links = {link: mapping.get(id(target), target) for link, target in builder._links.items()}
            relation.add(builder.build(record))
    object.__setattr__(record, "_pending", {})


def _merge(old: _RecordData, new: _RecordData, mapping: dict[int, Any]) -> None:
    """Writes an edit of a placed value object into it, so that it keeps its identity."""
    values = {name: _finish(old, old._values.get(name), value, mapping) for name, value in new._values.items()}
    for name, value in old._values.items():
        if values.get(name) is not value:
            _remove(value)
    object.__getattribute__(old, "_values").clear()
    object.__getattribute__(old, "_values").update(values)
    if isinstance(old._schema, ObjectSchema):
        for adjacency in old._schema.adjacencies.values():
            _relation_data(adjacency.relation).discard_linking(adjacency.me, old)
    object.__setattr__(old, "_pending", new._pending)
    _add_pending(old, mapping)


def _settle(owner: Any, old: dict[str, Any], new: dict[str, Any], mapping: dict[int, Any]) -> dict[str, Any]:
    """The values `owner` holds after an update from `old` to `new`: every value object is staged before any is placed,
    so that the entries among them link the right ones; value objects no longer held are removed."""
    staged = {name: _stage(old.get(name), value, mapping) for name, value in new.items()}
    placed = {name: _finish(owner, old.get(name), value, mapping) for name, value in staged.items()}
    for name, value in old.items():
        if placed.get(name) is not value:
            _remove(value)
    return placed


def _remove(value: Any) -> None:
    """Removes a value object no longer held: the value objects it holds, and every entry linking it."""
    if not isinstance(value, _RecordData):
        return
    for held in value._values.values():
        _remove(held)
    for relation in _relations.values():
        relation.discard_target(value)


def _write_entry(visitor: Visitors.OfEntry, entry: _Entry, adjacency: Schemas.OfAdjacency.Data) -> None:
    """Writes an entry's links and properties in the relation's declared order, whichever end built the entry."""
    relation = adjacency.relation
    for name in relation.links:
        if name != adjacency.me:
            visitor.link(name, lambda k, target=entry.links[name]: k.set(target))
    for name in relation.properties:
        if name in entry.properties:
            value = entry.properties[name]
            visitor.property(name, lambda p, value=value: p.value(lambda a: _write_value(a, value)))


# --- Builders ---


class _NativeSlot:
    """`Visitors.OfNative` over one key of a value dict."""

    def __init__(self, values: dict[str, Native], name: str):
        self._values, self._name = values, name

    def has(self) -> bool:
        return self._name in self._values

    def get(self) -> Native:
        if self._name not in self._values:
            raise AttributeError(f"property {self._name!r} is not set")
        return self._values[self._name]

    def set(self, value: Native) -> _NativeSlot:
        self._values[self._name] = value
        return self

    def clear(self) -> _NativeSlot:
        self._values.pop(self._name, None)
        return self


class _AnySlot:
    """`Visitors.OfAny` over one key of a value dict, holding a value of `schema` (an entry property's schema is not
    given: entry properties are native)."""

    def __init__(self, values: dict[str, Any], name: str, schema: Any = None):
        self._values, self._name, self._schema = values, name, schema

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> _AnySlot:
        callback(_NativeSlot(self._values, self._name))
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> _AnySlot:
        """Builds an embedded object, starting from the one already set, if any."""
        return self._record(Schemas.OfObject.Data, "an object", callback)

    def as_union(self, callback: Callable[[Visitors.OfUnion], Any]) -> _AnySlot:
        """Builds a union value, starting from the one already set, if any."""
        return self._record(Schemas.OfUnion.Data, "a union", callback)

    def as_intersection(self, callback: Callable[[Visitors.OfIntersection], Any]) -> _AnySlot:
        """Builds an intersection value, starting from the one already set, if any."""
        return self._record(Schemas.OfIntersection.Data, "an intersection", callback)

    def _record(self, kind: type, noun: str, callback: Callable[[Any], Any]) -> _AnySlot:
        if not isinstance(self._schema, kind):
            raise TypeError(f"property {self._name!r} does not hold {noun}")
        current = self._values.get(self._name)
        builder = _RecordBuilder(self._schema, current if isinstance(current, _RecordData) else None)
        callback(builder)
        if isinstance(self._schema, Schemas.OfUnion.Data) and not builder._values:
            self._values.pop(self._name, None)  # a union value without a branch is no value
        else:
            self._values[self._name] = builder.build()
        return self


class _PropertySlot:
    """`Visitors.OfProperty` over one key of a value dict, holding a value of `schema`."""

    def __init__(self, values: dict[str, Any], name: str, schema: Any = None):
        self._values, self._name, self._schema = values, name, schema

    def name(self) -> str:
        return self._name

    def has(self) -> bool:
        return self._name in self._values

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _PropertySlot:
        callback(_AnySlot(self._values, self._name, self._schema))
        return self

    def clear(self) -> _PropertySlot:
        self._values.pop(self._name, None)
        return self


def _setter(visitor: Any, name: str, schema: Any = None) -> Callable[[Any], Any]:
    """DSL setter for a property of `schema`: `.name(value)`, or `.name(Spec)` where the Spec receives the value's
    builder: a `Visitors.OfNative` (`v.set(...)`), or the builder of an embedded object, a union value or an intersection
    value, which starts from the value already set. A value object given as the value replaces the one set."""

    def setter(spec: Any) -> Any:
        if isinstance(spec, _RecordData):
            visitor.property(name, lambda p: p.clear().value(lambda a: _apply(a, name, schema, spec)))
        else:
            visitor.property(name, lambda p: p.value(lambda a: _apply(a, name, schema, spec)))
        return visitor

    return setter


def _apply(visitor: Visitors.OfAny, name: str, schema: Any, spec: Any) -> None:
    """Writes `spec` (a value, or a callable taking the value's builder) as a value of `schema`."""
    if isinstance(schema, (Schemas.OfObject.Data, Schemas.OfUnion.Data, Schemas.OfIntersection.Data)):
        if callable(spec):
            _write_record(visitor, schema, spec)
        elif isinstance(spec, _RecordData):
            _write_record(visitor, schema, lambda r: spec.accept(r))
        else:
            raise TypeError(f"property {name!r} takes {_a(_noun(schema))} or a Spec, got {type(spec).__name__}")
    else:
        visitor.as_native(spec if callable(spec) else (lambda n: n.set(spec)))


def _write_record(visitor: Visitors.OfAny, schema: Any, callback: Callable[[Any], Any]) -> None:
    if isinstance(schema, Schemas.OfUnion.Data):
        visitor.as_union(callback)
    elif isinstance(schema, Schemas.OfIntersection.Data):
        visitor.as_intersection(callback)
    else:
        visitor.as_object(callback)


class _RecordBuilder:
    """`Visitors.OfObject` for building a value object, starting from `source` if given; also `Visitors.OfUnion` and
    `Visitors.OfIntersection` for a union or intersection value, whose properties are the branches or parts. DSL:
    `.<property>(value or Spec)` and `.<adjacency>(entry Spec)`. Writing a union's branch clears any other."""

    def __init__(self, schema: Any, source: _RecordData | None = None):
        self._schema, self._source, self._copy_of = schema, source, None
        self._values: dict[str, Any] = {} if source is None else dict(object.__getattribute__(source, "_values"))
        self._entries: dict[str, list[_EntryBuilder]] = {}
        if source is not None and isinstance(schema, ObjectSchema):
            _load_entries(self._entries, schema, source)
        self._member = ("branch of the union" if isinstance(schema, Schemas.OfUnion.Data) else
                        "part of the intersection" if isinstance(schema, Schemas.OfIntersection.Data) else
                        "property of the embedded object")

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _RecordBuilder:
        for name in [n for n in self._schema.properties if n in self._values]:
            callback(_PropertySlot(self._values, name, self._schema.properties[name]))
        return self

    def has(self, name: str) -> bool:
        return name in self._values

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _RecordBuilder:
        if name not in self._schema.properties:
            raise AttributeError(f"{name!r} is not a {self._member}")
        if isinstance(self._schema, Schemas.OfUnion.Data):
            for other in [n for n in self._values if n != name]:
                del self._values[other]
        callback(_PropertySlot(self._values, name, self._schema.properties[name]))
        return self

    def clear(self, name: str) -> _RecordBuilder:
        self._values.pop(name, None)
        return self

    def _adjacencies(self) -> dict[str, Any]:
        return self._schema.adjacencies if isinstance(self._schema, ObjectSchema) else {}

    def adjacencies(self, callback: Callable[[Visitors.OfAdjacency], Any]) -> _RecordBuilder:
        for name in self._adjacencies():
            callback(_AdjacencySlot(self, name))
        return self

    def adjacency(self, name: str, callback: Callable[[Visitors.OfAdjacency], Any]) -> _RecordBuilder:
        if not self._adjacencies():
            raise AttributeError(f"{_a(_noun(self._schema))} has no adjacencies, got {name!r}")
        if name not in self._adjacencies():
            raise AttributeError(f"{name!r} is not an adjacency of the {_noun(self._schema)}")
        callback(_AdjacencySlot(self, name))
        return self

    def identify(self, value: Visitors.Visitable) -> _RecordBuilder:
        """A value object replays itself into this builder: the value object built is a copy of it."""
        self._copy_of = value
        return self

    def __getattr__(self, name: str) -> Callable[[Any], _RecordBuilder]:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._schema.properties:
            return _setter(self, name, self._schema.properties[name])
        if name in self._adjacencies():
            return _adder(self, name)
        raise AttributeError(f"{name!r} is not a {self._member}")

    def build(self) -> _RecordData:
        return _RecordData(self._schema, self._values, self._entries, self._source, self._copy_of)


def _adder(builder: Any, name: str) -> Callable[[Any], Any]:
    """DSL adder for an adjacency: `.<adjacency>(lambda x: x.<link>(...))`."""

    def adder(spec: Callable[[Visitors.OfEntry], Any]) -> Any:
        if not callable(spec):
            raise TypeError(f"{name!r} takes an entry Spec, e.g. lambda x: x.<link>(...)")
        return builder.adjacency(name, lambda a: a.add(spec))

    return adder


def _load_entries(entries: dict[str, list[_EntryBuilder]], schema: ObjectSchema, source: Any) -> None:
    """Loads the entries linking `source` into a builder, as entry builders, so that an update rewrites them."""
    for name, adjacency in schema.adjacencies.items():
        for entry in _relation_data(adjacency.relation).linking(adjacency.me, source):
            builder = _EntryBuilder(adjacency.relation, adjacency.me)
            builder._links = {link: target for link, target in entry.links.items() if link != adjacency.me}
            builder._values = dict(entry.properties)
            entries.setdefault(name, []).append(builder)
    for name, pending in object.__getattribute__(source, "_pending").items() if isinstance(source, _RecordData) else ():
        entries.setdefault(name, []).extend(pending)


class _LinkSlot:
    """`Visitors.OfLink` over one link of an entry builder."""

    def __init__(self, links: dict[str, _ObjectData | _ObjectBuilder], name: str):
        self._links, self._name = links, name

    def name(self) -> str:
        return self._name

    def target(self, callback: Callable[[Visitors.Visitable], Any]) -> _LinkSlot:
        callback(self._links[self._name])
        return self

    def set(self, target: Visitors.Visitable) -> _LinkSlot:
        if not isinstance(target, _ObjectData) and not (
                isinstance(target, _RecordData) and isinstance(object.__getattribute__(target, "_schema"), ObjectSchema)):
            raise TypeError("proxies can only link proxy instances and their value objects")
        self._links[self._name] = target
        return self


class _EntryBuilder:
    """`Visitors.OfEntry` for one entry being added through an adjacency. The object's own link (`me`) is filled when
    the object builder is finalized. DSL: `.<link>(object or Spec)` and `.<property>(value or Spec)`."""

    def __init__(self, relation: RelationSchema, me: str):
        self._relation, self._me = relation, me
        self._links: dict[str, _ObjectData | _ObjectBuilder] = {}
        self._values: dict[str, Native] = {}

    def _check_link(self, name: str) -> None:
        if name == self._me or name not in self._relation.links:
            raise AttributeError(f"{name!r} is not a link this entry can set")

    def links(self, callback: Callable[[Visitors.OfLink], Any]) -> _EntryBuilder:
        for name in self._relation.links:
            if name != self._me:
                callback(_LinkSlot(self._links, name))
        return self

    def link(self, name: str, callback: Callable[[Visitors.OfLink], Any]) -> _EntryBuilder:
        self._check_link(name)
        callback(_LinkSlot(self._links, name))
        return self

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _EntryBuilder:
        for name in list(self._values):
            callback(_PropertySlot(self._values, name, self._relation.properties.get(name)))
        return self

    def has(self, name: str) -> bool:
        return name in self._values

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _EntryBuilder:
        if name not in self._relation.properties:
            raise AttributeError(f"{name!r} is not a property of this relation")
        callback(_PropertySlot(self._values, name, self._relation.properties[name]))
        return self

    def clear(self, name: str) -> _EntryBuilder:
        self._values.pop(name, None)
        return self

    def __getattr__(self, name: str) -> Callable[[Any], _EntryBuilder]:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._relation.links:
            self._check_link(name)

            def link_setter(spec: Any) -> _EntryBuilder:
                if callable(spec):
                    schema_name = _schema_filling(self._relation, name)
                    builder = _ObjectBuilder(_object_schema(schema_name), schema_name)
                    spec(builder)
                    self._links[name] = builder
                else:
                    self.link(name, lambda k: k.set(spec))
                return self

            return link_setter
        if name in self._relation.properties:
            return _setter(self, name, self._relation.properties[name])
        raise AttributeError(name)

    def build(self, target: _ObjectData) -> _Entry:
        links: dict[str, _ObjectData] = {self._me: target}
        for name in self._relation.links:
            if name == self._me:
                continue
            if name not in self._links:
                raise ValueError(f"link {name!r} is not set")
            value = self._links[name]
            links[name] = value.create() if isinstance(value, _ObjectBuilder) else value
        return _Entry(links, _settle(target, {}, self._values, {}))  # its value objects belong to `target`


class _AdjacencySlot:
    """`Visitors.OfAdjacency` over one adjacency of an object builder."""

    def __init__(self, builder: _ObjectBuilder, name: str):
        self._builder, self._name = builder, name
        self._schema = builder._schema.adjacencies[name]

    def name(self) -> str:
        return self._name

    def me(self) -> str:
        return self._schema.me

    def entries(self, callback: Callable[[Visitors.OfEntry], Any]) -> _AdjacencySlot:
        for entry in list(self._builder._entries.get(self._name, [])):
            callback(entry)
        return self

    def add(self, callback: Callable[[Visitors.OfEntry], Any]) -> _AdjacencySlot:
        entry = _EntryBuilder(self._schema.relation, self._schema.me)
        callback(entry)
        self._builder._entries.setdefault(self._name, []).append(entry)
        return self

    def remove(self, entry: Visitors.OfEntry) -> _AdjacencySlot:
        entries = self._builder._entries.get(self._name, [])
        self._builder._entries[self._name] = [e for e in entries if e is not entry]
        return self


class _ObjectBuilder:
    """`Visitors.OfObject` for building a proxy instance. DSL: `.<property>(value or Spec)` and
    `.<adjacency>(entry Spec)`. Finalized by `create()`, `clone()` or `update()`; none validate."""

    def __init__(self, schema: ObjectSchema, schema_name: str, instance: _ObjectData | None = None):
        if not schema.ref:
            raise TypeError(f"{schema_name!r} is a value object schema; a value object is built through its owner")
        self._schema, self._schema_name, self._source = schema, schema_name, instance
        self._values: dict[str, Native] = {}
        self._entries: dict[str, list[_EntryBuilder]] = {}
        if instance is not None:
            if not isinstance(instance, _ObjectData):
                raise TypeError("a builder's source must be a proxy instance")
            if instance.schema_name() != schema_name:
                raise TypeError(f"instance is a {instance.schema_name()!r}, not a {schema_name!r}")
            self._values = dict(instance._values)  # the value objects themselves, so that an update keeps them
            _load_entries(self._entries, schema, instance)

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _ObjectBuilder:
        for name in list(self._values):
            callback(_PropertySlot(self._values, name, self._schema.properties[name]))
        return self

    def has(self, name: str) -> bool:
        return name in self._values

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _ObjectBuilder:
        if name not in self._schema.properties:
            raise AttributeError(f"{name!r} is not a property of {self._schema_name!r}")
        callback(_PropertySlot(self._values, name, self._schema.properties[name]))
        return self

    def clear(self, name: str) -> _ObjectBuilder:
        self._values.pop(name, None)
        return self

    def adjacencies(self, callback: Callable[[Visitors.OfAdjacency], Any]) -> _ObjectBuilder:
        for name in self._schema.adjacencies:
            callback(_AdjacencySlot(self, name))
        return self

    def adjacency(self, name: str, callback: Callable[[Visitors.OfAdjacency], Any]) -> _ObjectBuilder:
        if name not in self._schema.adjacencies:
            raise AttributeError(f"{name!r} is not an adjacency of {self._schema_name!r}")
        callback(_AdjacencySlot(self, name))
        return self

    def identify(self, value: Visitors.Visitable) -> _ObjectBuilder:
        return self

    def __getattr__(self, name: str) -> Callable[[Any], _ObjectBuilder]:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._schema.properties:
            return _setter(self, name, self._schema.properties[name])
        if name in self._schema.adjacencies:
            return _adder(self, name)
        raise AttributeError(f"{name!r} is not a property or adjacency of {self._schema_name!r}")

    def create(self) -> _ObjectData:
        if self._source is not None:
            raise ValueError("create() is only valid without a source instance; use clone() or update()")
        return self._write(_ObjectData(self._schema, self._schema_name))

    def clone(self) -> _ObjectData:
        if self._source is None:
            raise ValueError("clone() is only valid with a source instance")
        return self._write(_ObjectData(self._schema, self._schema_name))

    def update(self) -> _ObjectData:
        if self._source is None:
            raise ValueError("update() is only valid with a source instance")
        for adjacency in self._schema.adjacencies.values():
            _relation_data(adjacency.relation).discard_linking(adjacency.me, self._source)
        return self._write(self._source)

    def _write(self, target: _ObjectData) -> _ObjectData:
        mapping: dict[int, Any] = {}
        if self._source is not None and target is not self._source:  # a clone: its value objects link it, not the source
            mapping[id(self._source)] = target
        values = _settle(target, dict(target._values), self._values, mapping)
        mapping.pop(id(self._source), None)  # its own entries keep their links (a self-loop links the source)
        target._values.clear()
        target._values.update(values)
        for name, entries in self._entries.items():
            relation = _relation_data(self._schema.adjacencies[name].relation)
            for entry in entries:
                entry._links = {link: mapping.get(id(t), t) for link, t in entry._links.items()}
                relation.add(entry.build(target))
        return target


class OfObject:
    Data = _ObjectData
    Builder = _ObjectBuilder
    Record = _RecordData


class OfRelation:
    Data = _RelationData
