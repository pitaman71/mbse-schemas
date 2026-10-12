"""Proxies: the dynamic implementation.

Programs using proxies skip code generation. A store, `OfStore()`, holds schemas and the proxies built with them (see
`Stores`): `store.register(schema)` makes a schema available, under its name, and `store.<Name>(optional instance)` (or
`store.builder(name, instance)`) returns a builder for it. Instances (`Proxies.OfObject.Data`) are `Visitable`, not
visitors: they expose their properties as read-only attributes and write themselves into a visitor on `accept`.
Builders (`Proxies.OfObject.Builder`) implement `Visitors.OfObject`, like every builder.

A store holds its singletons, created when their schemas are registered (`store.singleton(global_name)`), and through
them its data (see `Stores`); an object nothing reachable from a singleton links is the program's to keep. A relation's
entries live on the objects they link, so they go with them. Adding an entry equal to an existing one is elided where
the relation has a `unique` clause; an open relation's entries are a list from each end, equal entries kept. An
object of one store cannot be linked to, or be a builder's source in, another. An adjacency is a member named after it,
the tuple of its entries in the order they were added (`contact.phones`), with `project(name)`, each entry's link or
property, and `at(key)`, the entry with a key its relation declares; an entry is shared by the objects it links,
and its links and properties are read-only attributes (`entry.phone`, `entry.label`), so that code reads proxies as it
reads generated classes.

A property whose schema is an `OfObject` holds a value object: a read-only record with no identity
(`Proxies.OfObject.Record`), read with attributes like an instance and set with a Spec, e.g.
`.reach(lambda r: r.number('+44'))`. Union and intersection values are records too, whose properties are the union's
branches or the intersection's parts, by name: `.reach(lambda u: u.phone(lambda p: p.number('+44')))` sets the branch
`phone`, read back as `card.reach.phone.number`, and setting one branch clears any other. An intersection value holds
each of its parts, set and read the same way (`card.meta.stamp.updated`).

"""

from __future__ import annotations

from collections.abc import Callable, Hashable, Mapping
from typing import Any

from . import Schemas, Stores, Visitors
from .Visitors import Native

__all__ = ["OfStore", "store_of", "OfObject", "OfEntry", "OfAdjacency"]

ObjectSchema = Schemas.OfObject.Data
RelationSchema = Schemas.OfRelation.Data


# --- Stores ---

class OfStore(Stores.Catalog):
    """A store of proxies: schemas by name, and the instance of each singleton schema registered, created with it.
    `store.<Name>(optional instance)` is `store.builder(name, instance)`; use `builder` for names that are not
    identifiers, or that a method's name shadows."""

    def __init__(self) -> None:
        super().__init__()
        for schema in Stores.META:
            self.register(schema)

    def register(self, schema: ObjectSchema | RelationSchema) -> None:
        """Registers a schema under its name; a singleton schema's instance is created with it."""
        global_name = schema.singleton if isinstance(schema, ObjectSchema) else None
        if global_name is not None and global_name in self._singletons:
            raise ValueError(f"singleton {global_name!r} is already registered")
        super().register(schema)
        if global_name is not None:
            self._singletons[global_name] = _ObjectData(self, schema, schema.name)

    def builder(self, name: str, instance: Any = None) -> _ObjectBuilder:
        return _ObjectBuilder(self, self.schema(name), name, instance)

    def member(self, instance: Any, name: str) -> Any:
        """The value an instance or value object holds in its property `name`."""
        return _read(instance, name)

    def __getattr__(self, name: str) -> Callable[..., _ObjectBuilder]:
        if name.startswith("_"):
            raise AttributeError(name)
        schema = self.schema(name)
        return lambda instance=None: _ObjectBuilder(self, schema, name, instance)

    def _filled(self, relation: RelationSchema, link: str) -> str:
        """The name of the one object schema that declares an adjacency to `relation` via `link`."""
        names = self._filling(relation, link)
        if len(names) != 1:
            raise TypeError(f"expected exactly one object schema filling link {link!r}, found {names}")
        return names[0]


def _store_of(value: Any) -> OfStore | None:
    """The store a proxy belongs to; a value object's is its owner's, and one not yet placed has none."""
    while isinstance(value, _RecordData):
        value = object.__getattribute__(value, "_owner")
    return object.__getattribute__(value, "_store") if isinstance(value, _ObjectData) else None


def store_of(value: Any) -> OfStore:
    """The store a proxy, or a value object placed in one, belongs to."""
    store = _store_of(value)
    if store is None:
        raise TypeError("the value does not belong to a store")
    return store


def _same_store(store: OfStore | None, value: Any) -> None:
    held = _store_of(value)
    if store is not None and held is not None and held is not store:
        raise TypeError("the object belongs to another store")


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
    """An entry of a relation, shared by the objects it links: its links and its properties are read-only attributes
    (`entry.phone`, `entry.label`), read as an object's are (a flat union's value as its branch's), and a property that
    is not set reads as None."""

    __slots__ = ("_relation", "_links", "_properties")

    def __init__(self, relation: RelationSchema, links: Mapping[str, _ObjectData], properties: Mapping[str, Native]):
        object.__setattr__(self, "_relation", relation)
        object.__setattr__(self, "_links", dict(links))
        object.__setattr__(self, "_properties", dict(properties))

    def __getattr__(self, name: str) -> Any:
        if name in self._links:
            return self._links[name]
        if name in self._properties:
            return _view(self._properties[name], self._relation.properties[name].type)
        if name in self._relation.properties:
            return None  # not set: nothing is mandatory but by a constraint
        raise AttributeError(name)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("entries are read-only; use a builder")

    def _key(self) -> Hashable:
        """What the entry is held by: its value in a relation with a `unique` clause, a set, and itself in an open
        relation, a list from each end, which keeps equal entries."""
        if self._relation.open:
            return ("entry", id(self))
        return (
            tuple(sorted((name, id(target)) for name, target in self._links.items())),
            tuple(sorted((name, _native_key(value)) for name, value in self._properties.items())),
        )


def _table(target: Any, relation_id: int) -> dict[Hashable, _Entry]:
    """The entries of one relation that link `target`, by key: they live on the objects they link."""
    return object.__getattribute__(target, "_adjacent").setdefault(relation_id, {})


def _add_entry(relation: RelationSchema, entry: _Entry) -> None:
    """Adds `entry` to every object it links, unless the relation holds a set and an equal entry is there already."""
    key = entry._key()
    if key in _table(next(iter(entry._links.values())), id(relation)):
        return
    for target in entry._links.values():
        _table(target, id(relation))[key] = entry


def _linking(relation: RelationSchema, link: str, target: Any) -> list[_Entry]:
    """The entries of `relation` that link `target` via `link`, in the order they were added."""
    return [entry for entry in _table(target, id(relation)).values() if entry._links.get(link) is target]


def _discard(relation_id: int, entries: list[_Entry]) -> None:
    for entry in entries:
        key = entry._key()
        for target in entry._links.values():
            _table(target, relation_id).pop(key, None)


def _discard_linking(relation: RelationSchema, link: str, target: Any) -> None:
    _discard(id(relation), _linking(relation, link, target))


def _discard_target(target: Any) -> None:
    """Discards every entry that links `target`, through any link."""
    for relation_id, table in list(object.__getattribute__(target, "_adjacent").items()):
        _discard(relation_id, list(table.values()))


# --- Instances ---


class _ObjectData:
    """A proxy instance. Properties are read-only attributes; one that is not set reads as None."""

    __slots__ = ("_store", "_schema", "_schema_name", "_values", "_adjacent", "__weakref__")

    def __init__(self, store: OfStore, schema: ObjectSchema, schema_name: str):
        object.__setattr__(self, "_adjacent", {})
        object.__setattr__(self, "_store", store)
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
    """Writes the entries linking `target`, adjacency by adjacency; a value object not yet placed has none."""
    for adjacency_name, adjacency in schema.adjacencies.items():
        for entry in _linking(adjacency.relation, adjacency.me, target):
            visitor.adjacency(
                adjacency_name,
                lambda a, entry=entry, adj=adjacency: a.add(lambda e: _write_entry(e, entry, adj)),
            )


def _read(value: Any, name: str) -> Any:
    """A property of an instance or record, or an adjacency's entries, as an attribute; a flat intersection's parts'
    properties too, as its own."""
    values = object.__getattribute__(value, "_values")
    schema = object.__getattribute__(value, "_schema")
    if name in values:
        return _view(values[name], schema.properties[name].type)
    if name in schema.properties:
        return None  # not set: nothing is mandatory but by a constraint
    part = _owning_part(schema, name)
    if part is not None:
        return None if part not in values else _read(values[part], name)
    adjacency = schema.adjacencies.get(name) if isinstance(schema, ObjectSchema) else None
    if adjacency is not None:
        return _Adjacency(_linking(adjacency.relation, adjacency.me, value), adjacency)
    raise AttributeError(name)


class _Adjacency(tuple):  # type: ignore[type-arg]
    """An adjacency as proxies read it: the tuple of its entries, in the order they were added, indexed by position.
    `project(name)` gives each entry's link or property `name`, in order, and `at(key)` the entry with the key its
    relation declares (`Schemas.OfRelation.Data.key`). Names are arguments, so no link or property can collide."""

    _schema: Schemas.OfAdjacency.Data

    def __new__(cls, entries: Any, schema: Schemas.OfAdjacency.Data) -> _Adjacency:
        adjacency = super().__new__(cls, entries)
        adjacency._schema = schema
        return adjacency

    def project(self, name: str) -> tuple[Any, ...]:
        """Each entry's link or property `name`, in order; None for a property an entry does not set."""
        relation = self._schema.relation
        if name not in relation.links and name not in relation.properties:
            raise KeyError(f"{name!r} is not a link or property of the relation")
        return tuple(getattr(entry, name) for entry in self)

    def at(self, key: Any) -> _Entry:
        """The entry whose key is `key`: one value for a key of one link or property, else a tuple of them in
        declaration order. `KeyError` for none, `TypeError` when the relation declares no key from this end."""
        names = self._schema.relation.key(self._schema.me)
        if names is None:
            raise TypeError("the relation declares no key from this end; index by position")
        wanted = key if len(names) > 1 else (key,)
        if not isinstance(wanted, tuple) or len(wanted) != len(names):
            raise KeyError(f"a key of {list(names)} is a tuple of {len(names)} values, got {key!r}")
        links = self._schema.relation.links
        for entry in self:
            held = [getattr(entry, name) for name in names]
            if all(h is v if name in links else h is not None and _native_key(h) == _native_key(v)
                   for name, h, v in zip(names, held, wanted)):  # a target by identity, a value by schema equality
                return entry
        raise KeyError(f"no entry has the key {key!r}")


def _owning_part(schema: Any, name: str) -> str | None:
    """The part of a flat intersection whose object schema declares the property `name`, if any."""
    if not (isinstance(schema, Schemas.OfIntersection.Data) and schema.flat):
        return None
    return next((part.name for part in schema.parts if name in Schemas.structure(part.type).properties), None)


def _view(value: Any, schema: Any) -> Any:
    """A value as code reads it: a flat union's value as its branch's value."""
    schema = Schemas.structure(schema)
    if not (isinstance(schema, Schemas.OfUnion.Data) and schema.flat):
        return value
    ((branch, held),) = object.__getattribute__(value, "_values").items()
    return _view(held, schema.properties[branch].type)


def _runtime(value: Any) -> Any:
    """What tells a value apart at run time, as `Schemas` tells a flat union's branches apart: a native's type, or a
    value object's schema."""
    if isinstance(value, _RecordData):
        return ("schema", id(object.__getattribute__(value, "_schema")))
    return ("native", type(value))


def _branch(name: str, schema: Schemas.OfUnion.Data, value: Any) -> Schemas.OfUnion.Branch:
    """The branch of a flat union whose type a value has."""
    found = next((b for b in schema.branches if Schemas._runtime(b.type) == _runtime(value)), None)
    if found is None:
        raise TypeError(f"property {name!r}: a {type(value).__name__} is not a value of any branch of the flat union")
    return found


def _write_properties(visitor: Any, schema: ObjectSchema, values: dict[str, Any]) -> None:
    """Writes the values that are set, in the schema's declared order."""
    for name in schema.properties:
        if name in values:
            visitor.property(name, lambda p, value=values[name]: p.value(lambda a: _write_value(a, value)))


def _write_value(visitor: Visitors.OfAny, value: Any) -> None:
    """Writes a native, a value object, a union value or an intersection value into a `Visitors.OfAny`."""
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
    return "value object"


def _a(noun: str) -> str:
    return f"an {noun}" if noun == "intersection value" else f"a {noun}"


class _RecordData:
    """A value object: the value of a property whose schema is an `OfObject`, which may have adjacencies, or a union or
    intersection value, whose properties are the branches or parts. It belongs to one owner and has an identity of its
    own; its properties are read-only attributes, and one that is not set reads as None. Built but not
    yet placed in an owner, it holds its entries in `_pending` until its owner is created or updated."""

    __slots__ = ("_schema", "_values", "_owner", "_pending", "_source", "_copy_of", "_adjacent")

    def __init__(self, schema: Any, values: dict[str, Any], pending: dict[str, list[_EntryBuilder]] | None = None,
                 source: _RecordData | None = None, copy_of: Any = None):
        for name, value in (("_schema", schema), ("_values", dict(values)), ("_owner", None),
                            ("_pending", pending or {}), ("_source", source), ("_copy_of", copy_of), ("_adjacent", {})):
            object.__setattr__(self, name, value)

    def __getattr__(self, name: str) -> Any:
        return _read(self, name)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(f"{_noun(self._schema)}s are read-only; use a builder")

    def identity(self) -> Hashable:
        return id(self)

    def schema_name(self) -> str:
        """The registered name of the value object's schema, or '' when it is not registered in its store."""
        store = _store_of(self)
        return "" if store is None else next((n for n, s in store._schemas.items() if s is self._schema), "")

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
    """Stages the value objects a value object holds: its properties', and its entries'."""
    held = {} if old is None else old._values
    for name, value in list(record._values.items()):
        _set(record, name, _stage(held.get(name), value, mapping))
    for builders in record._pending.values():
        for builder in builders:
            builder._stage(record if old is None else old, mapping)


def _copy(record: _RecordData) -> _RecordData:
    """A copy of a placed value object, with copies of the entries linking it and the value objects it holds."""
    builder = _RecordBuilder(record._schema, store=_store_of(record))
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
        relation = record._schema.adjacencies[name].relation
        for builder in builders:
            builder._place(record, mapping)
            builder._links = {link: mapping.get(id(target), target) for link, target in builder._links.items()}
            if _first_copy(relation, builder, record, mapping):
                _add_entry(relation, builder.build(record))
    object.__setattr__(record, "_pending", {})


def _merge(old: _RecordData, new: _RecordData, mapping: dict[int, Any]) -> None:
    """Writes an edit of a placed value object into it, so that it keeps its identity."""
    before = _held(old)
    values = {name: _finish(old, old._values.get(name), value, mapping) for name, value in new._values.items()}
    object.__getattribute__(old, "_values").clear()
    object.__getattribute__(old, "_values").update(values)
    if isinstance(old._schema, ObjectSchema):
        for adjacency in old._schema.adjacencies.values():
            _discard_linking(adjacency.relation, adjacency.me, old)
    object.__setattr__(old, "_pending", new._pending)
    _add_pending(old, mapping)
    _drop(before, _held(old))


def _records(values: Any) -> list[_RecordData]:
    """The value objects that `values` hold directly."""
    return [value for value in values if isinstance(value, _RecordData)]


def _held(owner: Any) -> list[Any]:
    """The values an object or a value object holds: its properties', and those of the entries of its one-link
    relations, which hold values for it alone."""
    values = list(object.__getattribute__(owner, "_values").values())
    schema = object.__getattribute__(owner, "_schema")
    for adjacency in schema.adjacencies.values() if isinstance(schema, ObjectSchema) else ():
        if len(adjacency.relation.links) == 1:
            values += [value for entry in _linking(adjacency.relation, adjacency.me, owner) for value in entry._properties.values()]
    return values


def _drop(before: Any, after: Any) -> None:
    """Removes the value objects held among the values `before` and no longer among those `after`."""
    kept = {id(record) for record in _records(after)}
    for record in _records(before):
        if id(record) not in kept:
            _remove(record)


def _remove(value: _RecordData) -> None:
    """Removes a value object no longer held: the value objects it holds, its entries' too, and every entry linking it."""
    for held in _records(_held(value)):
        _remove(held)
    _discard_target(value)


def _first_copy(relation: RelationSchema, builder: _EntryBuilder, target: Any, mapping: dict[Any, Any]) -> bool:
    """Whether an entry builder adds its entry: an entry rewritten from one already held (`_source`), linking the same
    objects, is added once in one build, though every object it links gives it, which in an open relation would
    otherwise add it again."""
    source = builder._source
    if source is None or not relation.open:
        return True
    links = {**builder._links, builder._me: target}
    key = ("entry", id(source), tuple(sorted((name, id(linked)) for name, linked in links.items())))
    if key in mapping:
        return False
    mapping[key] = source
    return True


def _write_entry(visitor: Visitors.OfEntry, entry: _Entry, adjacency: Schemas.OfAdjacency.Data) -> None:
    """Writes an entry's links and properties in the relation's declared order, whichever end built the entry. A proxy's
    entry builder remembers the entry it copies."""
    relation = adjacency.relation
    if isinstance(visitor, _EntryBuilder):
        visitor._source = entry
    for name in relation.links:
        if name != adjacency.me:
            visitor.link(name, lambda k, target=entry._links[name]: k.set(target))
    for name in relation.properties:
        if name in entry._properties:
            value = entry._properties[name]
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

    def __init__(self, values: dict[str, Any], name: str, schema: Any = None, store: OfStore | None = None):
        self._values, self._name, self._store = values, name, store
        self._schema = Schemas.structure(schema)

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> _AnySlot:
        callback(_NativeSlot(self._values, self._name))
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> _AnySlot:
        """Builds a value object, starting from the one already set, if any."""
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
        builder = _RecordBuilder(self._schema, current if isinstance(current, _RecordData) else None, self._store)
        callback(builder)
        if isinstance(self._schema, Schemas.OfUnion.Data) and not builder._values:
            self._values.pop(self._name, None)  # a union value without a branch is no value
        else:
            self._values[self._name] = builder.build()
        return self


class _PropertySlot:
    """`Visitors.OfProperty` over one key of a value dict, holding a value of `schema`."""

    def __init__(self, values: dict[str, Any], name: str, schema: Any = None, store: OfStore | None = None):
        self._values, self._name, self._schema, self._store = values, name, schema, store

    def name(self) -> str:
        return self._name

    def has(self) -> bool:
        return self._name in self._values

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _PropertySlot:
        callback(_AnySlot(self._values, self._name, self._schema, self._store))
        return self

    def clear(self) -> _PropertySlot:
        self._values.pop(self._name, None)
        return self


def _setter(visitor: Any, name: str, schema: Any = None) -> Callable[[Any], Any]:
    """DSL setter for a property of `schema`: `.name(value)`, or `.name(Spec)` where the Spec receives the value's
    builder: a `Visitors.OfNative` (`v.set(...)`), or the builder of a value object, a union value or an intersection
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
    schema = Schemas.structure(schema)
    if isinstance(schema, Schemas.OfUnion.Data) and schema.flat and not callable(spec) and not (
            isinstance(spec, _RecordData) and object.__getattribute__(spec, "_schema") is schema):
        branch = _branch(name, schema, spec)  # a flat union's value: its branch's, told apart by type
        _write_record(visitor, schema, lambda r: r.property(
            branch.name, lambda p: p.value(lambda a: _apply(a, branch.name, branch.type, spec))))
    elif isinstance(schema, (Schemas.OfObject.Data, Schemas.OfUnion.Data, Schemas.OfIntersection.Data)):
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

    def __init__(self, schema: Any, source: _RecordData | None = None, store: OfStore | None = None):
        self._schema, self._source, self._copy_of, self._store = schema, source, None, store
        self._values: dict[str, Any] = {} if source is None else dict(object.__getattribute__(source, "_values"))
        self._entries: dict[str, list[_EntryBuilder]] = {}
        if source is not None and isinstance(schema, ObjectSchema):
            _load_entries(self._entries, schema, source)
        self._member = ("branch of the union" if isinstance(schema, Schemas.OfUnion.Data) else
                        "part of the intersection" if isinstance(schema, Schemas.OfIntersection.Data) else
                        "property of the value object")

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _RecordBuilder:
        for name in [n for n in self._schema.properties if n in self._values]:
            callback(_PropertySlot(self._values, name, self._schema.properties[name].type, self._store))
        return self

    def has(self, name: str) -> bool:
        return name in self._values

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _RecordBuilder:
        if name not in self._schema.properties:
            raise AttributeError(f"{name!r} is not a {self._member}")
        if isinstance(self._schema, Schemas.OfUnion.Data):
            for other in [n for n in self._values if n != name]:
                del self._values[other]
        callback(_PropertySlot(self._values, name, self._schema.properties[name].type, self._store))
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
            return _setter(self, name, self._schema.properties[name].type)
        if name in self._adjacencies():
            return _adder(self, name)
        part = _owning_part(self._schema, name)
        if part is not None:  # a flat intersection's part's property: set in that part, from the value already set
            setter = _setter(self, part, self._schema.properties[part].type)
            return lambda spec: setter(lambda b: getattr(b, name)(spec))
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
    store = _store_of(source)
    for name, adjacency in schema.adjacencies.items():
        for entry in _linking(adjacency.relation, adjacency.me, source):
            builder = _EntryBuilder(adjacency.relation, adjacency.me, store)
            builder._links = {link: target for link, target in entry._links.items() if link != adjacency.me}
            builder._values = dict(entry._properties)
            builder._source = entry
            entries.setdefault(name, []).append(builder)
    for name, pending in object.__getattribute__(source, "_pending").items() if isinstance(source, _RecordData) else ():
        entries.setdefault(name, []).extend(pending)


class _LinkSlot:
    """`Visitors.OfLink` over one link of an entry builder."""

    def __init__(self, links: dict[str, _ObjectData | _ObjectBuilder], name: str, store: OfStore | None = None):
        self._links, self._name, self._store = links, name, store

    def name(self) -> str:
        return self._name

    def target(self, callback: Callable[[Visitors.Visitable], Any]) -> _LinkSlot:
        callback(self._links[self._name])
        return self

    def set(self, target: Visitors.Visitable) -> _LinkSlot:
        if not isinstance(target, _ObjectData) and not (
                isinstance(target, _RecordData) and isinstance(object.__getattribute__(target, "_schema"), ObjectSchema)):
            raise TypeError("proxies can only link proxy instances and their value objects")
        _same_store(self._store, target)
        self._links[self._name] = target
        return self


class _EntryBuilder:
    """`Visitors.OfEntry` for one entry being added through an adjacency. The object's own link (`me`) is filled when
    the object builder is finalized. DSL: `.<link>(object or Spec)` and `.<property>(value or Spec)`."""

    def __init__(self, relation: RelationSchema, me: str, store: OfStore | None = None):
        self._relation, self._me, self._store = relation, me, store
        self._links: dict[str, _ObjectData | _ObjectBuilder] = {}
        self._values: dict[str, Native] = {}
        self._source: _Entry | None = None  # the entry this one rewrites, when copied or loaded from one

    def _check_link(self, name: str) -> None:
        if name == self._me or name not in self._relation.links:
            raise AttributeError(f"{name!r} is not a link this entry can set")

    def links(self, callback: Callable[[Visitors.OfLink], Any]) -> _EntryBuilder:
        for name in self._relation.links:
            if name != self._me:
                callback(_LinkSlot(self._links, name, self._store))
        return self

    def link(self, name: str, callback: Callable[[Visitors.OfLink], Any]) -> _EntryBuilder:
        self._check_link(name)
        callback(_LinkSlot(self._links, name, self._store))
        return self

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _EntryBuilder:
        for name in list(self._values):
            callback(_PropertySlot(self._values, name, self._relation.properties[name].type if name in self._relation.properties else None, self._store))
        return self

    def has(self, name: str) -> bool:
        return name in self._values

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _EntryBuilder:
        if name not in self._relation.properties:
            raise AttributeError(f"{name!r} is not a property of this relation")
        callback(_PropertySlot(self._values, name, self._relation.properties[name].type, self._store))
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
                    if self._store is None:
                        raise TypeError("an object is created through a link only by a store's builder")
                    schema_name = self._store._filled(self._relation, name)
                    builder = _ObjectBuilder(self._store, self._store.schema(schema_name), schema_name)
                    spec(builder)
                    self._links[name] = builder
                else:
                    self.link(name, lambda k: k.set(spec))
                return self

            return link_setter
        if name in self._relation.properties:
            return _setter(self, name, self._relation.properties[name].type)
        raise AttributeError(name)

    def _kept(self, target: Any) -> dict[str, Any]:
        """The values of the entry this one rewrites, where it links the same `target`: an update keeps them."""
        source = self._source
        return source._properties if source is not None and source._links.get(self._me) is target else {}

    def _stage(self, target: Any, mapping: dict[int, Any]) -> None:
        """Stages the value objects the entry holds for `target`, before any is placed (see `_stage`)."""
        kept = self._kept(target)
        self._values = {name: _stage(kept.get(name), value, mapping) for name, value in self._values.items()}

    def _place(self, target: Any, mapping: dict[int, Any]) -> None:
        """Places the staged value objects the entry holds as `target`'s."""
        kept = self._kept(target)
        self._values = {name: _finish(target, kept.get(name), value, mapping) for name, value in self._values.items()}

    def build(self, target: Any) -> _Entry:
        """The entry, linking `target`, holding its values as placed."""
        links: dict[str, _ObjectData] = {self._me: target}
        for name in self._relation.links:
            if name == self._me:
                continue
            if name not in self._links:
                raise ValueError(f"link {name!r} is not set")
            value = self._links[name]
            links[name] = value.create() if isinstance(value, _ObjectBuilder) else value
        return _Entry(self._relation, links, self._values)


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
        entry = _EntryBuilder(self._schema.relation, self._schema.me, self._builder._store)
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

    def __init__(self, store: OfStore, schema: ObjectSchema, schema_name: str, instance: _ObjectData | None = None):
        if not schema.ref:
            raise TypeError(f"{schema_name!r} is a value object schema; a value object is built through its owner")
        self._store, self._schema, self._schema_name, self._source = store, schema, schema_name, instance
        self._values: dict[str, Native] = {}
        self._entries: dict[str, list[_EntryBuilder]] = {}
        if instance is not None:
            if not isinstance(instance, _ObjectData):
                raise TypeError("a builder's source must be a proxy instance")
            if instance.schema_name() != schema_name:
                raise TypeError(f"instance is a {instance.schema_name()!r}, not a {schema_name!r}")
            _same_store(store, instance)
            self._values = dict(instance._values)  # the value objects themselves, so that an update keeps them
            _load_entries(self._entries, schema, instance)

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _ObjectBuilder:
        for name in list(self._values):
            callback(_PropertySlot(self._values, name, self._schema.properties[name].type, self._store))
        return self

    def has(self, name: str) -> bool:
        return name in self._values

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _ObjectBuilder:
        if name not in self._schema.properties:
            raise AttributeError(f"{name!r} is not a property of {self._schema_name!r}")
        callback(_PropertySlot(self._values, name, self._schema.properties[name].type, self._store))
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
            return _setter(self, name, self._schema.properties[name].type)
        if name in self._schema.adjacencies:
            return _adder(self, name)
        raise AttributeError(f"{name!r} is not a property or adjacency of {self._schema_name!r}")

    def create(self) -> _ObjectData:
        if self._source is not None:
            raise ValueError("create() is only valid without a source instance; use clone() or update()")
        self._not_singleton("create")
        return self._write(_ObjectData(self._store, self._schema, self._schema_name))

    def clone(self) -> _ObjectData:
        if self._source is None:
            raise ValueError("clone() is only valid with a source instance")
        self._not_singleton("clone")
        return self._write(_ObjectData(self._store, self._schema, self._schema_name))

    def update(self) -> _ObjectData:
        if self._source is None:
            raise ValueError("update() is only valid with a source instance")
        before = _held(self._source)
        for adjacency in self._schema.adjacencies.values():
            _discard_linking(adjacency.relation, adjacency.me, self._source)
        return self._write(self._source, before)

    def _not_singleton(self, method: str) -> None:
        if self._schema.singleton is not None:
            raise ValueError(f"{method}() would make a second {self._schema_name!r}; its one instance is "
                             f"store.singleton({self._schema.singleton!r})")

    def _write(self, target: _ObjectData, before: list[Any] | None = None) -> _ObjectData:
        """Writes the builder into `target`. Every value object it holds, its entries' too, is staged before any is
        placed, so that the entries among them link the right ones; those held `before` and no longer are removed."""
        schema = self._schema
        mapping: dict[int, Any] = {}
        if self._source is not None and target is not self._source:  # a clone: its value objects link it, not the source
            mapping[id(self._source)] = target
        old = dict(target._values)
        staged = {name: _stage(old.get(name), value, mapping) for name, value in self._values.items()}
        for entries in self._entries.values():
            for entry in entries:
                entry._stage(target, mapping)
        values = {name: _finish(target, old.get(name), value, mapping) for name, value in staged.items()}
        for entries in self._entries.values():
            for entry in entries:
                entry._place(target, mapping)
        mapping.pop(id(self._source), None)  # its own entries keep their links (a self-loop links the source)
        target._values.clear()
        target._values.update(values)
        for name, entries in self._entries.items():
            relation = self._schema.adjacencies[name].relation
            for entry in entries:
                entry._links = {link: mapping.get(id(t), t) for link, t in entry._links.items()}
                if _first_copy(relation, entry, target, mapping):
                    _add_entry(relation, entry.build(target))
        _drop(before or [], _held(target))
        return target


class OfObject:
    Data = _ObjectData
    Builder = _ObjectBuilder
    Record = _RecordData


class OfAdjacency:
    """An adjacency as proxies read it: `Data`, the tuple of its entries, with `project(name)` and `at(key)`."""

    Data = _Adjacency


class OfEntry:
    """A relation's entries as proxies hold them: `Data`, an entry with every link, the owner's own included, and its
    properties, as an adjacency's iterable yields it."""

    Data = _Entry
