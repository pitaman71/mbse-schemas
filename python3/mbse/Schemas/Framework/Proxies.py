"""Proxies: the dynamic implementation of the visitor protocol.

Programs using proxies skip code generation. A store, `OfStore()`, holds schemas and the proxies built with them (see
`Stores`): `store.register(schema)` makes a schema available, under its name, and `store.<Name>(optional instance)` (or
`store.builder(name, instance)`) returns a builder for it. Data instances (`Proxies.OfObject.Data`) and builders
(`Proxies.OfObject.Builder`) both implement `Visitors.OfObject`: data instances read-only, builders writable. Their
properties and adjacencies are members: `card.name` is a `Visitors.OfProperty`, read compactly through its dunders
(`str(card.name)`), and `card.phones` a `Visitors.OfAdjacency`, which iterates its entries; an entry's link is the
linked instance itself (`entry.phone is p`). Called, a member writes through a `Specs.Callback`: `b.name("Ada")`,
`b.home(lambda p: p.as_object(lambda o: o.number("1")))`, `b.phones(lambda a: a.insert(lambda e: e.phone(p)))`. A
data instance is callable, so that calling it, a write, raises `Errors.ReadOnlyError`.

A store holds its singletons, created when their schemas are registered (`store.singleton(global_name)`), and through
them its data (see `Stores`); an object nothing reachable from a singleton links is the program's to keep. A relation's
entries live on the objects they link, so they go with them. Adding an entry equal to an existing one is elided where
the relation has a `unique` clause; an open relation's entries are a list from each end, equal entries kept. An
object of one store cannot be linked to, or be a builder's source in, another. An adjacency of a data instance is also
the tuple of its entries in the order they were added, with `project(name)`, each entry's link or property, and
`at(key)`, the entry with a key its relation declares.

A property whose schema is an `OfObject` holds a value object (`Proxies.OfObject.Record`), owned by one object, read
through `as_object` (`card.home.as_object(...)`) and written through it on a builder. A union value's branches and an
intersection value's parts are members giving the visitor of their own type's kind (`shape.circle`, `ticket.stamp`);
writing one branch clears any other.

Reads never raise: a visitor of an absent value, of a value of another kind, or of a member the schema lacks reads as
empty. The one raise is a write that the visitor's mode, or the value, forbids: `Errors.ReadOnlyError`.
"""

from __future__ import annotations

from collections.abc import Callable, Hashable, Iterator, Mapping
from typing import Any

from . import Schemas, Stores
from .Errors import ReadOnlyError
from .Visitors import Scalar

__all__ = ["OfStore", "store_of", "OfObject", "OfEntry", "OfAdjacency"]

ObjectSchema = Schemas.OfObject.Data
RelationSchema = Schemas.OfRelation.Data
RECORD_KINDS = (Schemas.OfObject.Data, Schemas.OfUnion.Data, Schemas.OfIntersection.Data)


# --- Stores ---


class OfStore(Stores.Catalog):
    """A store of proxies: schemas by name, and the instance of each singleton schema registered, created with it.
    `store.<Name>(optional instance)` is `store.builder(name, instance)`; use `builder` for names that are not
    identifiers, or that a method's name shadows."""

    def __init__(self) -> None:
        super().__init__()
        for schema in Stores.META:
            self.register(schema)

    def register(self, schema: ObjectSchema | RelationSchema | Schemas.OfPredicate.Data) -> None:
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


def _scalar_key(value: Any) -> Hashable:
    """Equality key per EQUALITY.md: distinct scalar types never compare equal; floats compare by bit pattern; a value
    object by its schema and properties, whatever its identity."""
    if isinstance(value, _RecordBuilder):
        value = value.build()
    if isinstance(value, _RecordData):
        values = object.__getattribute__(value, "_values")
        return ("object", id(value._schema), tuple(sorted((n, _scalar_key(v)) for n, v in values.items())))
    if type(value) not in (int, float, str, bool, bytes):
        raise TypeError(f"an entry property must be a scalar value or a value object, got {type(value).__name__}")
    if isinstance(value, float):
        return ("float", value.hex())
    return (type(value).__name__, value)


class _Entry:
    """An entry of a relation, shared by the objects it links: a read-only `Visitors.OfEntry`. Its links are members
    giving the linked instance itself (`entry.phone`), and its properties members giving a `Visitors.OfProperty`
    (`str(entry.label)`)."""

    __slots__ = ("_relation", "_links", "_properties")

    def __init__(self, relation: RelationSchema, links: Mapping[str, _ObjectData], properties: Mapping[str, Scalar]):
        object.__setattr__(self, "_relation", relation)
        object.__setattr__(self, "_links", dict(links))
        object.__setattr__(self, "_properties", dict(properties))

    def as_schema(self) -> Schemas.OfEntry.Data:
        return self._relation.entry

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._links:
            return self._links[name]
        prop = self._relation.entry.properties.get(name)
        if prop is None:
            return _Empty(None, f"{name!r} is not a link or property of the relation")
        return _Property(self._properties, name, prop, None, self, writable=False)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("entries are read-only; use a builder")

    def __repr__(self) -> str:
        return f"<entry of {self._relation.name or 'a relation'}>"

    def _key(self) -> Hashable:
        """What the entry is held by: its value in a relation with a `unique` clause, a set, and itself in an open
        relation, a list from each end, which keeps equal entries."""
        if self._relation.open:
            return ("entry", id(self))
        return (
            tuple(sorted((name, id(target)) for name, target in self._links.items())),
            tuple(sorted((name, _scalar_key(value)) for name, value in self._properties.items())),
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


# --- Visitors over values ---


def _is_function(spec: Any) -> bool:
    """Whether a `Specs.Callback` is its callable form; data instances and visitors are callable too, but are values."""
    return callable(spec) and not isinstance(spec, _VALUES)


def _visit(spec: Any, visitor: Any) -> None:
    """Hands `visitor` to a callable Spec, which reads or writes through it; its return value is the visitor's own."""
    spec(visitor)


def _write(writable: bool, reason: str) -> None:
    """Refuses a write that the visitor's mode forbids."""
    if not writable:
        raise ReadOnlyError(reason)


def _article(kind: type) -> str:
    return {int: "an int", float: "a float", str: "a str", bool: "a bool", bytes: "bytes"}.get(kind, "a value")


def _noun_of(value: Any) -> str:
    if isinstance(value, (_RecordData, _RecordBuilder)):
        return _a(_noun(value._schema))
    return _article(type(value))


def _converted(value: Any, host: type, label: str) -> Any:
    """A scalar's value for a dunder: it must be set and of the dunder's own type."""
    if value is None:
        raise TypeError(f"{label} is not set")
    if type(value) is not host:
        raise TypeError(f"{label} holds {_noun_of(value)}, not {_article(host)}")
    return value


class _Dunders:
    """The scalar dunders, sugar over `get()`: each raises when the value is not set or not of its type."""

    def _scalar(self) -> Any:
        raise NotImplementedError

    def _label(self) -> str:
        raise NotImplementedError

    def __int__(self) -> int:
        return _converted(self._scalar(), int, self._label())

    def __float__(self) -> float:
        return _converted(self._scalar(), float, self._label())

    def __str__(self) -> str:
        return _converted(self._scalar(), str, self._label())

    def __bool__(self) -> bool:
        return _converted(self._scalar(), bool, self._label())

    def __bytes__(self) -> bytes:
        return _converted(self._scalar(), bytes, self._label())


class _Empty(_Dunders):
    """A visitor of nothing: an absent value, a value of another kind than asked for, or a member the schema lacks. It
    reads as empty in every protocol, and refuses every write, saying why."""

    def __init__(self, schema: Any, reason: str):
        object.__setattr__(self, "_schema", schema)
        object.__setattr__(self, "_reason", reason)

    def _scalar(self) -> Any:
        return None

    def _label(self) -> str:
        return "the value"

    def as_schema(self) -> Any:
        return self._schema

    def as_identity(self) -> str:
        return ""

    def get(self) -> None:
        return None

    def __iter__(self) -> Iterator[Any]:
        return iter(())

    @property
    def as_properties(self) -> _Properties:
        return _Properties(self, [])

    def _hand(self, cb: Any) -> _Empty:
        if not _is_function(cb):
            raise ReadOnlyError(self._reason)
        _visit(cb, _Empty(None, self._reason))
        return self

    as_value = as_scalar = as_object = as_union = as_intersection = as_adjacencies = _hand

    def select(self, spec: Any, cb: Any) -> _Empty:
        return self

    def _refuse(self, *args: Any) -> Any:
        raise ReadOnlyError(self._reason)

    set = clear = insert = remove = __call__ = _refuse

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return _Empty(None, self._reason)

    def __repr__(self) -> str:
        return "<empty>"


class _Scalar(_Dunders):
    """`Visitors.OfScalar` over one key of a values dict. Called, as a union's branch, with a Spec."""

    def __init__(self, values: dict[str, Any], name: str, schema: Any, writable: bool, label: str,
                 parent: Any = None, on_write: Callable[[], None] | None = None):
        self._values, self._name, self._schema, self._writable = values, name, schema, writable
        self._label_text, self._parent, self._on_write = label, parent, on_write

    def _scalar(self) -> Any:
        return self.get()

    def _label(self) -> str:
        return self._label_text

    def as_schema(self) -> Any:
        return self._schema

    def get(self) -> Any:
        value = self._values.get(self._name)
        return value if type(value) in (int, float, str, bool, bytes) else None

    def set(self, value: Scalar) -> None:
        _write(self._writable, f"{self._label_text} is read-only; write through a builder")
        if self._on_write is not None:
            self._on_write()
        self._values[self._name] = value

    def clear(self) -> None:
        _write(self._writable, f"{self._label_text} is read-only; write through a builder")
        self._values.pop(self._name, None)

    def __call__(self, spec: Any) -> Any:
        if _is_function(spec):
            _visit(spec, self)
        else:
            self.set(spec)
        return self._parent

    def __repr__(self) -> str:
        return f"<scalar {self._label_text}>"


class _Any:
    """`Visitors.OfAny` over one key of a values dict, holding a value of `schema`. Read-only, it hands over the value's
    own visitor, or an empty one; writable, it selects the kind, refusing one the schema does not hold."""

    def __init__(self, values: dict[str, Any], name: str, schema: Any, store: OfStore | None, writable: bool,
                 label: str, on_write: Callable[[], None] | None = None):
        self._values, self._name, self._store, self._writable = values, name, store, writable
        self._schema, self._label, self._on_write = schema, label, on_write
        self._type = Schemas.structure(schema)

    def as_schema(self) -> Any:
        return self._schema

    def _touch(self) -> None:
        if self._on_write is not None:
            self._on_write()

    def as_scalar(self, cb: Any) -> _Any:
        value = self._values.get(self._name)
        if isinstance(self._type, Schemas.OfUnion.Data) and self._type.flat:
            return self._flat_scalar(cb, value)
        if not isinstance(self._type, Schemas.OfScalar.Data):
            return self._hand(cb, _Empty(None, f"{self._label} holds {_a(_noun(self._type))}, not a scalar"))
        scalar = _Scalar(self._values, self._name, self._type, self._writable, self._label, self, self._on_write)
        if _is_function(cb):
            _visit(cb, scalar)
        else:
            scalar.set(cb)
        return self

    def _flat_scalar(self, cb: Any, value: Any) -> _Any:
        """A flat union's value read as its branch's, and written to the branch its type picks."""
        if not _is_function(cb):
            self._write_record(lambda u: _member_of(u, _branch(self._name, self._type, cb).name)(cb))
            return self
        if isinstance(value, (_RecordData, _RecordBuilder)):
            ((branch, held),) = value._values.items() if value._values else (("", None),)
            if type(held) in (int, float, str, bool, bytes):
                _visit(cb, _Scalar(value._values, branch, Schemas.structure(self._type.properties[branch].type),
                                   False, self._label))
                return self
        _visit(cb, _Empty(None, f"{self._label} holds no scalar"))
        return self

    def as_object(self, cb: Any) -> _Any:
        return self._record(Schemas.OfObject.Data, cb)

    def as_union(self, cb: Any) -> _Any:
        return self._record(Schemas.OfUnion.Data, cb)

    def as_intersection(self, cb: Any) -> _Any:
        return self._record(Schemas.OfIntersection.Data, cb)

    def _hand(self, cb: Any, empty: _Empty) -> _Any:
        empty._hand(cb)
        return self

    def _record(self, kind: type, cb: Any) -> _Any:
        noun = {Schemas.OfObject.Data: "value object", Schemas.OfUnion.Data: "union value"}.get(kind, "intersection value")
        if not isinstance(self._type, kind):
            return self._hand(cb, _Empty(None, f"{self._label} does not hold {_a(noun)}"))
        value = self._values.get(self._name)
        if not self._writable:
            if isinstance(value, _RecordData):
                if _is_function(cb):
                    _visit(cb, value)
                    return self
                raise ReadOnlyError(f"{self._label} is read-only; write through a builder")
            return self._hand(cb, _Empty(self._type, f"{self._label} is read-only; write through a builder"))
        if _is_function(cb):
            self._write_record(cb)
        else:
            self._replace(cb)
        return self

    def _builder(self) -> _RecordBuilder:
        """The builder of the value object held, attached to the values when first written; one already attached, so
        that a builder reads back its pending writes."""
        value = self._values.get(self._name)
        if isinstance(value, _RecordBuilder):
            return value

        def attach(builder: _RecordBuilder) -> None:
            self._touch()
            self._values[self._name] = builder

        return _RecordBuilder(self._type, value if isinstance(value, _RecordData) else None, self._store, attach)

    def _write_record(self, cb: Any) -> None:
        _visit(cb, self._builder())

    def _replace(self, value: Any) -> None:
        """Writes a value object, union value or intersection value given as a value: copied when it is placed."""
        if isinstance(value, _Property):
            value = value._values.get(value._name)
        if not isinstance(value, (_RecordData, _RecordBuilder)) or value._schema is not self._type:
            raise TypeError(f"{self._label} takes {_a(_noun(self._type))} or a Spec, got {type(value).__name__}")
        self._touch()
        self._values[self._name] = value

    def write(self, value: Any) -> None:
        """Writes a `Specs.Callback`'s value form: a scalar, a value object, union value or intersection value (a flat
        union's, its branch's), or a property's value."""
        _write(self._writable, f"{self._label} is read-only; write through a builder")
        if isinstance(value, _Property):
            value = value._values.get(value._name)
        held = Schemas.structure(self._type)
        if isinstance(held, Schemas.OfUnion.Data) and held.flat and not (
                isinstance(value, (_RecordData, _RecordBuilder)) and value._schema is held):
            branch = _branch(self._name, held, value)
            self._write_record(lambda u: _member_of(u, branch.name)(value))
        elif isinstance(held, RECORD_KINDS):
            self._replace(value)
        else:
            self.as_scalar(value)

    def clear(self) -> None:
        _write(self._writable, f"{self._label} is read-only; write through a builder")
        self._values.pop(self._name, None)


class _Property(_Dunders):
    """`Visitors.OfProperty` over one key of a values dict. Called, as a member, with a Spec, it writes or visits through
    it and returns the visitor it is a member of."""

    def __init__(self, values: dict[str, Any], name: str, schema: Schemas.OfProperty.Data, store: OfStore | None,
                 parent: Any, writable: bool, on_write: Callable[[], None] | None = None):
        self._values, self._name, self._schema, self._store = values, name, schema, store
        self._parent, self._writable, self._on_write = parent, writable, on_write

    def _any(self) -> _Any:
        return _Any(self._values, self._name, self._schema.type, self._store, self._writable, self._label(),
                    self._on_write)

    def _label(self) -> str:
        return f"property {self._name!r}"

    def _scalar(self) -> Any:
        found: list[Any] = []
        self._any().as_scalar(lambda s: found.append(s.get()))
        return found[0] if found else None

    def as_schema(self) -> Schemas.OfProperty.Data:
        return self._schema

    def get(self) -> Any:
        return self._scalar()

    def as_value(self, cb: Any) -> _Property:
        visitor = self._any()
        if _is_function(cb):
            _visit(cb, visitor)
        else:
            visitor.write(cb)
        return self

    def as_scalar(self, cb: Any) -> _Property:
        self._any().as_scalar(cb)
        return self

    def as_object(self, cb: Any) -> _Property:
        self._any().as_object(cb)
        return self

    def __call__(self, spec: Any) -> Any:
        if _is_function(spec):
            _visit(spec, self)
        else:
            self.as_value(spec)
        return self._parent

    def __repr__(self) -> str:
        return f"<{self._label()}>"


class _Properties:
    """`Visitors.OfObject.as_properties`: the properties present, iterated, or called with a callback for each."""

    def __init__(self, owner: Any, properties: list[Any]):
        self._owner, self._properties = owner, properties

    def __iter__(self) -> Iterator[Any]:
        return iter(self._properties)

    def __call__(self, cb: Any) -> Any:
        for prop in self._properties:
            _visit(cb, prop)
        return self._owner


def _properties_of(owner: Any, values: dict[str, Any], schema: Any, store: OfStore | None, writable: bool,
                   on_write: Callable[[], None] | None = None) -> _Properties:
    """The properties of an object present in `values`, in the schema's declared order."""
    return _Properties(owner, [_Property(values, name, prop, store, owner, writable, on_write)
                               for name, prop in schema.properties.items() if name in values])


def _kind_visitor(values: dict[str, Any], name: str, schema: Any, store: OfStore | None, parent: Any, writable: bool,
                  label: str, on_write: Callable[[], None] | None = None) -> Any:
    """The visitor of a union's branch or an intersection's part: of its own type's kind, the value itself for a value
    object held, or an empty one."""
    held = Schemas.structure(schema)
    value = values.get(name)
    if isinstance(held, Schemas.OfScalar.Data):
        return _Scalar(values, name, held, writable, label, parent, on_write)
    if not writable:
        return value if isinstance(value, _RecordData) else _Empty(held, f"{label} is not set")
    if isinstance(value, _RecordBuilder):
        return value

    def attach(builder: _RecordBuilder) -> None:
        if on_write is not None:
            on_write()
        values[name] = builder

    return _RecordBuilder(held, value if isinstance(value, _RecordData) else None, store, attach, parent)


# --- Data instances ---


class _ObjectData:
    """A proxy instance: a read-only `Visitors.OfObject`, whose properties and adjacencies are members."""

    __slots__ = ("_store", "_schema", "_schema_name", "_values", "_adjacent", "__weakref__")

    def __init__(self, store: OfStore, schema: ObjectSchema, schema_name: str):
        object.__setattr__(self, "_adjacent", {})
        object.__setattr__(self, "_store", store)
        object.__setattr__(self, "_schema", schema)
        object.__setattr__(self, "_schema_name", schema_name)
        object.__setattr__(self, "_values", {})

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return _member(self, name)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("proxy properties are read-only; use a builder")

    def __call__(self, spec: Any) -> Any:
        raise ReadOnlyError("a data instance is read-only; write through a builder")

    def __repr__(self) -> str:
        return f"<{self._schema_name}>"

    def as_schema(self) -> ObjectSchema:
        return self._schema

    def as_identity(self) -> str:
        return str(id(self))

    @property
    def as_properties(self) -> _Properties:
        return _properties_of(self, self._values, self._schema, self._store, False)

    def as_adjacencies(self, cb: Any) -> _ObjectData:
        for name in self._schema.adjacencies:
            _visit(cb, _member(self, name))
        return self


class _RecordData:
    """A value object: the value of a property whose schema is an `OfObject`, a read-only `Visitors.OfObject`; or a
    union or intersection value, a read-only `Visitors.OfUnion` or `Visitors.OfIntersection`, whose branches or parts
    are members giving the visitor of their own type's kind. It belongs to one owner and has an identity of its own.
    Built but not yet placed in an owner, it holds its entries in `_pending` until its owner is created or updated."""

    __slots__ = ("_schema", "_values", "_owner", "_pending", "_source", "_copy_of", "_adjacent")

    def __init__(self, schema: Any, values: dict[str, Any], pending: dict[str, list[_EntryBuilder]] | None = None,
                 source: _RecordData | None = None, copy_of: Any = None):
        for name, value in (("_schema", schema), ("_values", dict(values)), ("_owner", None),
                            ("_pending", pending or {}), ("_source", source), ("_copy_of", copy_of), ("_adjacent", {})):
            object.__setattr__(self, name, value)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return _member(self, name)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(f"{_noun(self._schema)}s are read-only; use a builder")

    def __call__(self, spec: Any) -> Any:
        raise ReadOnlyError(f"{_a(_noun(self._schema))} is read-only; write through a builder")

    def __repr__(self) -> str:
        return f"<{_noun(self._schema)}>"

    def as_schema(self) -> Any:
        return self._schema

    def as_identity(self) -> str:
        return str(id(self))

    @property
    def as_properties(self) -> _Properties:
        return _properties_of(self, self._values, self._schema, _store_of(self), False)

    def as_adjacencies(self, cb: Any) -> _RecordData:
        for name in self._schema.adjacencies if isinstance(self._schema, ObjectSchema) else ():
            _visit(cb, _member(self, name))
        return self


def _member(owner: Any, name: str) -> Any:
    """A data instance's or a value object's member, read-only: a property, or a union's branch or an intersection's
    part, the visitor of its type's kind; a flat intersection's part's property, as its own; or an adjacency."""
    schema = object.__getattribute__(owner, "_schema")
    values = object.__getattribute__(owner, "_values")
    store = _store_of(owner)
    if isinstance(schema, (Schemas.OfUnion.Data, Schemas.OfIntersection.Data)) and name in schema.properties:
        kind = "branch" if isinstance(schema, Schemas.OfUnion.Data) else "part"
        return _kind_visitor(values, name, schema.properties[name].type, store, owner, False, f"{kind} {name!r}")
    if name in schema.properties:
        return _Property(values, name, schema.properties[name], store, owner, False)
    part = _owning_part(schema, name)
    if part is not None:
        held = values.get(part)
        return _member(held, name) if isinstance(held, _RecordData) else _Empty(None, f"part {part!r} is not set")
    adjacency = schema.adjacencies.get(name) if isinstance(schema, ObjectSchema) else None
    if adjacency is not None:
        return _Adjacency(_linking(adjacency.relation, adjacency.me, owner), adjacency, owner)
    return _Empty(None, f"{name!r} is not a member of {_a(_noun(schema))}")


def _read(value: Any, name: str) -> Any:
    """The value an instance or a value object holds in its property `name` (a union's branch, an intersection's
    part), as a store reads it: a scalar, or a value object; a flat intersection's part's property too, as its own."""
    values = object.__getattribute__(value, "_values")
    schema = object.__getattribute__(value, "_schema")
    if name in schema.properties:
        return values.get(name)
    part = _owning_part(schema, name)
    if part is not None:
        return None if part not in values else _read(values[part], name)
    raise AttributeError(name)


class _Adjacency(tuple):  # type: ignore[type-arg]
    """An adjacency of a data instance, a read-only `Visitors.OfAdjacency`: the tuple of its entries, in the order they
    were added. `project(name)` gives each entry's link or property `name`, in order, and `at(key)` the entry with the
    key its relation declares (`Schemas.OfRelation.Data.key`)."""

    _schema: Schemas.OfAdjacency.Data
    _owner: Any

    def __new__(cls, entries: Any, schema: Schemas.OfAdjacency.Data, owner: Any) -> _Adjacency:
        adjacency = super().__new__(cls, entries)
        adjacency._schema, adjacency._owner = schema, owner
        return adjacency

    def as_schema(self) -> Schemas.OfAdjacency.Data:
        return self._schema

    def select(self, spec: Any, cb: Any) -> _Adjacency:
        for entry in list(self):
            if _agrees(entry, spec, self._schema, _store_of(self._owner)):
                _visit(cb, entry)
        return self

    def insert(self, spec: Any) -> _Adjacency:
        raise ReadOnlyError("a data instance's adjacency is read-only; write through a builder")

    remove = insert

    def __call__(self, spec: Any) -> Any:
        if not _is_function(spec):
            self.insert(spec)
        _visit(spec, self)
        return self._owner

    def project(self, name: str) -> tuple[Any, ...]:
        """Each entry's link or property `name`, in order; None for a property an entry does not set."""
        relation = self._schema.relation
        if name not in relation.entry.links and name not in relation.entry.properties:
            raise KeyError(f"{name!r} is not a link or property of the relation")
        return tuple(entry._links[name] if name in relation.entry.links else entry._properties.get(name)
                     for entry in self)

    def at(self, key: Any) -> _Entry:
        """The entry whose key is `key`: one value for a key of one link or property, else a tuple of them in
        declaration order. `KeyError` for none, `TypeError` when the relation declares no key from this end."""
        names = self._schema.relation.key(self._schema.me)
        if names is None:
            raise TypeError("the relation declares no key from this end; index by position")
        wanted = key if len(names) > 1 else (key,)
        if not isinstance(wanted, tuple) or len(wanted) != len(names):
            raise KeyError(f"a key of {list(names)} is a tuple of {len(names)} values, got {key!r}")
        links = self._schema.relation.entry.links
        for entry in self:
            held = [entry._links[name] if name in links else entry._properties.get(name) for name in names]
            if all(h is v if name in links else h is not None and _scalar_key(h) == _scalar_key(v)
                   for name, h, v in zip(names, held, wanted)):  # a target by identity, a value by schema equality
                return entry
        raise KeyError(f"no entry has the key {key!r}")


def _entry_parts(entry: Any, me: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """An entry's links other than `me`, and its properties: a placed entry's, or an entry builder's."""
    if isinstance(entry, _Entry):
        return {k: v for k, v in entry._links.items() if k != me}, entry._properties
    return dict(entry._links), entry._values


def _agrees(entry: Any, spec: Any, adjacency: Schemas.OfAdjacency.Data, store: OfStore | None) -> bool:
    """Whether an entry agrees with a query Spec: equal to its value form (an entry), or agreeing with every link and
    property its callable form, a template, sets."""
    links, values = _entry_parts(entry, adjacency.me)
    if _is_function(spec):
        template = _EntryBuilder(adjacency.relation, adjacency.me, store)
        _visit(spec, template)
        wanted_links, wanted_values = template._links, template._values
    else:
        wanted_links, wanted_values = _entry_parts(spec, adjacency.me)
        if set(wanted_links) != set(links) or set(wanted_values) != set(values):
            return False
    return (all(links.get(name) is target for name, target in wanted_links.items())
            and all(name in values and _scalar_key(values[name]) == _scalar_key(value)
                    for name, value in wanted_values.items()))


def _owning_part(schema: Any, name: str) -> str | None:
    """The part of a flat intersection whose object schema declares the property `name`, if any."""
    if not (isinstance(schema, Schemas.OfIntersection.Data) and schema.flat):
        return None
    return next((part.name for part in schema.parts if name in Schemas.structure(part.type).properties), None)


def _runtime(value: Any) -> Any:
    """What tells a value apart at run time, as `Schemas` tells a flat union's branches apart: a scalar's type, or a
    value object's schema."""
    if isinstance(value, (_RecordData, _RecordBuilder)):
        return ("schema", id(value._schema))
    return ("scalar", type(value))


def _branch(name: str, schema: Schemas.OfUnion.Data, value: Any) -> Schemas.OfUnion.Branch:
    """The branch of a flat union whose type a value has."""
    found = next((b for b in schema.branches if Schemas._runtime(b.type) == _runtime(value)), None)
    if found is None:
        raise TypeError(f"property {name!r}: a {type(value).__name__} is not a value of any branch of the flat union")
    return found


def _noun(schema: Any) -> str:
    """What a record of `schema` is, for messages."""
    if isinstance(schema, Schemas.OfUnion.Data):
        return "union value"
    if isinstance(schema, Schemas.OfIntersection.Data):
        return "intersection value"
    return "value object"


def _a(noun: str) -> str:
    return f"an {noun}" if noun == "intersection value" else f"a {noun}"


# --- Value objects: staging, copying, placing ---


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
    store = _store_of(record)
    builder = _RecordBuilder(record._schema, store=store)
    builder._copy_of = record
    builder._values = {name: _copy(v) if isinstance(v, _RecordData) else v for name, v in record._values.items()}
    for name, adjacency in record._schema.adjacencies.items() if isinstance(record._schema, ObjectSchema) else ():
        for entry in _linking(adjacency.relation, adjacency.me, record):
            copied = _EntryBuilder(adjacency.relation, adjacency.me, store)
            copied._links = {link: target for link, target in entry._links.items() if link != adjacency.me}
            copied._values = {n: _copy(v) if isinstance(v, _RecordData) else v for n, v in entry._properties.items()}
            copied._source = entry
            builder._entries.setdefault(name, []).append(copied)
    for name, pending in record._pending.items():
        builder._entries.setdefault(name, []).extend(pending)
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
    """Adds a value object's entries, whose value objects take the place of those in `mapping`. Its relations have one
    link, its own, so no other object gives these entries."""
    for name, builders in record._pending.items():
        relation = record._schema.adjacencies[name].relation
        for builder in builders:
            builder._place(record, mapping)
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
        if len(adjacency.relation.entry.links) == 1:
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


# --- Builders ---


def _member_of(builder: _RecordBuilder, name: str) -> Any:
    """A union builder's branch, by name."""
    return builder._member(name)


def _built(value: Any) -> Any:
    """A value as a builder finalizes it: a value object's builder, built."""
    return value.build() if isinstance(value, _RecordBuilder) else value


class _RecordBuilder:
    """A writable `Visitors.OfObject` building a value object, starting from `source` if given; or a writable
    `Visitors.OfUnion` or `Visitors.OfIntersection`, whose branches or parts are members giving the visitor of their own
    type's kind. It attaches itself to what holds it (`attach`) when first written, so that an unwritten builder
    changes nothing. Writing a union's branch clears any other."""

    def __init__(self, schema: Any, source: _RecordData | None = None, store: OfStore | None = None,
                 attach: Callable[[_RecordBuilder], None] | None = None, parent: Any = None):
        self._schema, self._source, self._copy_of, self._store = schema, source, None, store
        self._attach, self._parent = attach, parent
        self._values: dict[str, Any] = {} if source is None else dict(object.__getattribute__(source, "_values"))
        self._entries: dict[str, list[_EntryBuilder]] = {}
        if source is not None and isinstance(schema, ObjectSchema):
            _load_entries(self._entries, schema, source)

    def _touch(self) -> None:
        """Attaches the builder to what holds it, once, at its first write."""
        if self._attach is not None:
            attach, self._attach = self._attach, None
            attach(self)

    def _select(self, name: str) -> Callable[[], None]:
        """What writing the member `name` does first: for a union's branch, clearing any other branch."""
        def selected() -> None:
            if isinstance(self._schema, Schemas.OfUnion.Data):
                for other in [n for n in self._values if n != name]:
                    del self._values[other]
            self._touch()
        return selected

    def as_schema(self) -> Any:
        return self._schema

    def as_identity(self) -> str:
        return "" if self._source is None else self._source.as_identity()

    @property
    def as_properties(self) -> _Properties:
        return _properties_of(self, self._values, self._schema, self._store, True, self._touch)

    def as_adjacencies(self, cb: Any) -> _RecordBuilder:
        for name in self._schema.adjacencies if isinstance(self._schema, ObjectSchema) else ():
            _visit(cb, _AdjacencyBuilder(self, name))
        return self

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return self._member(name)

    def _member(self, name: str) -> Any:
        schema = self._schema
        if isinstance(schema, (Schemas.OfUnion.Data, Schemas.OfIntersection.Data)) and name in schema.properties:
            kind = "branch" if isinstance(schema, Schemas.OfUnion.Data) else "part"
            return _kind_visitor(self._values, name, schema.properties[name].type, self._store, self, True,
                                 f"{kind} {name!r}", self._select(name))
        if name in schema.properties:
            return _Property(self._values, name, schema.properties[name], self._store, self, True, self._touch)
        part = _owning_part(schema, name)
        if part is not None:  # a flat intersection's part's property: written in that part
            return getattr(self._member(part), name)
        if isinstance(schema, ObjectSchema) and name in schema.adjacencies:
            return _AdjacencyBuilder(self, name)
        return _Empty(None, f"{name!r} is not a member of {_a(_noun(schema))}")

    def __call__(self, spec: Any) -> Any:
        """As a union's branch or an intersection's part: writes or visits through a Spec."""
        if _is_function(spec):
            _visit(spec, self)
        else:
            if not isinstance(spec, (_RecordData, _RecordBuilder)) or spec._schema is not self._schema:
                raise TypeError(f"{_a(_noun(self._schema))} or a Spec is expected, got {type(spec).__name__}")
            self._values = dict(spec._values)
            self._entries = {}
            if isinstance(spec, _RecordData) and isinstance(self._schema, ObjectSchema):
                _load_entries(self._entries, self._schema, spec)
            self._copy_of = spec
            self._touch()
        return self._parent

    def build(self) -> _RecordData:
        values = {name: _built(value) for name, value in self._values.items()}
        return _RecordData(self._schema, values, self._entries, self._source, self._copy_of)


class _AdjacencyBuilder:
    """A writable `Visitors.OfAdjacency` over one adjacency of an object's or a value object's builder: iterated, its
    entries' builders, the pending ones included."""

    def __init__(self, builder: Any, name: str):
        self._builder, self._name = builder, name
        self._schema = builder._schema.adjacencies[name]

    def _entries(self) -> list[_EntryBuilder]:
        return self._builder._entries.get(self._name, [])

    def as_schema(self) -> Schemas.OfAdjacency.Data:
        return self._schema

    def __iter__(self) -> Iterator[_EntryBuilder]:
        return iter(list(self._entries()))

    def select(self, spec: Any, cb: Any) -> _AdjacencyBuilder:
        for entry in list(self._entries()):
            if _agrees(entry, spec, self._schema, self._builder._store):
                _visit(cb, entry)
        return self

    def insert(self, spec: Any) -> _AdjacencyBuilder:
        entry = _EntryBuilder(self._schema.relation, self._schema.me, self._builder._store)
        if _is_function(spec):
            _visit(spec, entry)
        else:
            links, values = _entry_parts(spec, self._schema.me)
            entry._links, entry._values = dict(links), dict(values)
        _touch(self._builder)
        self._builder._entries.setdefault(self._name, []).append(entry)
        return self

    def remove(self, spec: Any) -> _AdjacencyBuilder:
        kept = [e for e in self._entries() if not _agrees(e, spec, self._schema, self._builder._store)]
        _touch(self._builder)
        self._builder._entries[self._name] = kept
        return self

    def __call__(self, spec: Any) -> Any:
        if _is_function(spec):
            _visit(spec, self)
        else:
            for entry in spec:  # an iterable of entries, each inserted
                self.insert(entry)
        return self._builder


def _touch(builder: Any) -> None:
    if isinstance(builder, _RecordBuilder):
        builder._touch()


class _LinkMember:
    """An entry builder's link: read, the linked object, read-only (an object is edited through its own builder);
    called with a Spec, it relinks: to an instance given, or to one created through the builder a callable is given."""

    def __init__(self, entry: _EntryBuilder, name: str):
        object.__setattr__(self, "_entry", entry)
        object.__setattr__(self, "_name", name)

    def _target(self) -> Any:
        target = self._entry._links.get(self._name)
        if isinstance(target, _ObjectBuilder):
            return target._source if target._source is not None else _Empty(target._schema, "not created yet")
        return target if target is not None else _Empty(None, f"link {self._name!r} is not set")

    def as_schema(self) -> Any:
        return self._target().as_schema()

    def as_identity(self) -> str:
        return self._target().as_identity()

    @property
    def as_properties(self) -> Any:
        return self._target().as_properties

    def as_adjacencies(self, cb: Any) -> _LinkMember:
        self._target().as_adjacencies(cb)
        return self

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._target(), name)

    def __call__(self, spec: Any) -> _EntryBuilder:
        entry, name = self._entry, self._name
        if _is_function(spec):
            store = entry._store
            if store is None:
                raise TypeError("an object is created through a link only by a store's builder")
            schema_name = store._filled(entry._relation, name)
            builder = _ObjectBuilder(store, store.schema(schema_name), schema_name)
            _visit(spec, builder)
            entry._links[name] = builder
            return entry
        if isinstance(spec, _LinkMember):
            spec = spec._target()
        if isinstance(spec, _RecordData):
            raise ReadOnlyError("a link targets a reference object, never a value object")
        if not isinstance(spec, _ObjectData):
            raise TypeError("proxies can only link proxy instances")
        _same_store(entry._store, spec)
        entry._links[name] = spec
        return entry

    def __repr__(self) -> str:
        return f"<link {self._name!r}>"


class _EntryBuilder:
    """A writable `Visitors.OfEntry` for one entry added through an adjacency: its links are members (`env.phone`,
    read-only, relinked when called) and so are its properties. The object's own link (`me`) is filled when the
    object's builder is finalized."""

    def __init__(self, relation: RelationSchema, me: str, store: OfStore | None = None):
        self._relation, self._me, self._store = relation, me, store
        self._links: dict[str, _ObjectData | _ObjectBuilder] = {}
        self._values: dict[str, Any] = {}
        self._source: _Entry | None = None  # the entry this one rewrites, when copied or loaded from one

    def as_schema(self) -> Schemas.OfEntry.Data:
        return self._relation.entry

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._relation.entry.links and name != self._me:
            return _LinkMember(self, name)
        prop = self._relation.entry.properties.get(name)
        if prop is not None:
            return _Property(self._values, name, prop, self._store, self, True)
        return _Empty(None, f"{name!r} is not a link this entry can set, nor a property of the relation")

    def __repr__(self) -> str:
        return f"<entry builder of {self._relation.name or 'a relation'}>"

    def _kept(self, target: Any) -> dict[str, Any]:
        """The values of the entry this one rewrites, where it links the same `target`: an update keeps them."""
        source = self._source
        return source._properties if source is not None and source._links.get(self._me) is target else {}

    def _stage(self, target: Any, mapping: dict[int, Any]) -> None:
        """Stages the value objects the entry holds for `target`, before any is placed (see `_stage`)."""
        kept = self._kept(target)
        self._values = {name: _stage(kept.get(name), _built(value), mapping) for name, value in self._values.items()}

    def _place(self, target: Any, mapping: dict[int, Any]) -> None:
        """Places the staged value objects the entry holds as `target`'s."""
        kept = self._kept(target)
        self._values = {name: _finish(target, kept.get(name), value, mapping) for name, value in self._values.items()}

    def build(self, target: Any) -> _Entry:
        """The entry, linking `target`, holding its values as placed."""
        links: dict[str, _ObjectData] = {self._me: target}
        for name in self._relation.entry.links:
            if name == self._me:
                continue
            if name not in self._links:
                raise ValueError(f"link {name!r} is not set")
            value = self._links[name]
            links[name] = value.create() if isinstance(value, _ObjectBuilder) else value
        return _Entry(self._relation, links, {name: _built(value) for name, value in self._values.items()})


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


class _ObjectBuilder:
    """A writable `Visitors.OfObject` building a proxy instance: its properties and adjacencies are members, reading
    back what has been written. Finalized by `create()`, `clone()` or `update()`; none validate."""

    def __init__(self, store: OfStore, schema: ObjectSchema, schema_name: str, instance: _ObjectData | None = None):
        if not schema.ref:
            raise TypeError(f"{schema_name!r} is a value object schema; a value object is built through its owner")
        self._store, self._schema, self._schema_name, self._source = store, schema, schema_name, instance
        self._values: dict[str, Any] = {}
        self._entries: dict[str, list[_EntryBuilder]] = {}
        if instance is not None:
            if not isinstance(instance, _ObjectData):
                raise TypeError("a builder's source must be a proxy instance")
            if instance._schema_name != schema_name:
                raise TypeError(f"instance is a {instance._schema_name!r}, not a {schema_name!r}")
            _same_store(store, instance)
            self._values = dict(instance._values)  # the value objects themselves, so that an update keeps them
            _load_entries(self._entries, schema, instance)

    def as_schema(self) -> ObjectSchema:
        return self._schema

    def as_identity(self) -> str:
        return "" if self._source is None else self._source.as_identity()

    @property
    def as_properties(self) -> _Properties:
        return _properties_of(self, self._values, self._schema, self._store, True)

    def as_adjacencies(self, cb: Any) -> _ObjectBuilder:
        for name in self._schema.adjacencies:
            _visit(cb, _AdjacencyBuilder(self, name))
        return self

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._schema.properties:
            return _Property(self._values, name, self._schema.properties[name], self._store, self, True)
        if name in self._schema.adjacencies:
            return _AdjacencyBuilder(self, name)
        return _Empty(None, f"{name!r} is not a property or adjacency of {self._schema_name!r}")

    def __repr__(self) -> str:
        return f"<builder of {self._schema_name}>"

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
        mapping: dict[int, Any] = {}
        if self._source is not None and target is not self._source:  # a clone: its value objects link it, not the source
            mapping[id(self._source)] = target
        old = dict(target._values)
        staged = {name: _stage(old.get(name), _built(value), mapping) for name, value in self._values.items()}
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
                if _first_copy(relation, entry, target, mapping):
                    _add_entry(relation, entry.build(target))
        _drop(before or [], _held(target))
        return target


_VALUES = (_ObjectData, _RecordData, _Entry, _Property, _Scalar, _RecordBuilder, _LinkMember, _Adjacency,
           _AdjacencyBuilder, _Empty, _EntryBuilder)
"""The classes whose instances are values, not the callable form of a Spec, though some are callable."""


class OfObject:
    Data = _ObjectData
    Builder = _ObjectBuilder
    Record = _RecordData


class OfAdjacency:
    """An adjacency of a data instance, `Data`: the tuple of its entries, with `project(name)` and `at(key)`."""

    Data = _Adjacency


class OfEntry:
    """A relation's entries as proxies hold them: `Data`, an entry with every link, the owner's own included, and its
    properties, as an adjacency's iterable yields it."""

    Data = _Entry
