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

import itertools
import math
import uuid
import weakref

from . import Schemas, Stores
from .Errors import ReadOnlyError
from .Visitors import Scalar

__all__ = ["OfStore", "store_of", "owner_of", "OfObject", "OfEntry", "OfAdjacency"]

ObjectSchema = Schemas.OfObject.Data
RelationSchema = Schemas.OfRelation.Data
RECORD_KINDS = (Schemas.OfObject.Data, Schemas.OfUnion.Data, Schemas.OfIntersection.Data)
VALUE_KINDS = (*RECORD_KINDS, Schemas.OfContainer.Data)
SCALARS = (int, float, str, bool, bytes)


# --- Stores ---


class OfStore(Stores.Catalog):
    """A store of proxies: schemas by name, and the instance of each singleton schema registered, created with it.
    `store.<Name>(optional instance)` is `store.builder(name, instance)`; use `builder` for names that are not
    identifiers, or that a method's name shadows."""

    def __init__(self) -> None:
        super().__init__()
        self._directories: dict[str, _Directory] = {}
        for schema in Stores.META:
            self.register(schema)

    def register(self, schema: ObjectSchema | RelationSchema | Schemas.OfPredicate.Data) -> None:
        """Registers a schema under its name; a singleton schema's instance is created with it."""
        global_name = schema.singleton if isinstance(schema, ObjectSchema) else None
        if global_name is not None and global_name in self._singletons:
            raise ValueError(f"singleton {global_name!r} is already registered")
        super().register(schema)
        if global_name is not None:
            self._singletons[global_name] = self._enter(schema.name, _ObjectData(self, schema, schema.name, global_name))

    def builder(self, name: str, instance: Any = None) -> Any:
        """A builder of an object of the schema registered as `name`; for a value object, union, intersection or
        container schema, of a standalone value, whose `create()` gives a value to assign, copied when placed."""
        registered = self._schemas.get(name)
        if isinstance(registered, VALUE_KINDS) and not getattr(registered, "ref", False):
            return _standalone(registered, instance, self)
        return _ObjectBuilder(self, self.schema(name), name, instance)

    def by_identity(self, name: str, identity: str) -> _ObjectData:
        """The live object of the schema `name` whose identity is `identity`; `LookupError` if there is none."""
        self.schema(name)
        found = self._directory(name).live.get(identity)
        if found is None:
            raise LookupError(f"no {name!r} has the identity {identity!r}")
        return found

    def restore(self, name: str, identity: str) -> _ObjectBuilder:
        """For decoders: a builder whose `create()` gives the object the identity a snapshot names, whether or not the
        schema's naming pattern gives it (decoding checks that). A program writes one through `as_identity`."""
        builder = _ObjectBuilder(self, self.schema(name), name)
        builder._identity = identity
        return builder

    def _directory(self, name: str) -> _Directory:
        return self._directories.setdefault(name, _Directory())

    def _issue(self, schema: ObjectSchema, name: str) -> str:
        """A new identity for an object of `schema`: the next name its naming pattern gives in this store, else a UUID."""
        if schema.pattern is None:
            return str(uuid.uuid4())
        directory = self._directory(name)
        directory.issued += 1
        return schema.name_for(directory.issued)

    def _enter(self, name: str, target: _ObjectData) -> _ObjectData:
        """Enters an object in its schema's directory, which a name its naming pattern gives advances."""
        directory = self._directory(name)
        if target._identity in directory.live:
            raise ValueError(f"a {name!r} with the identity {target._identity!r} is already live; update it")
        directory.live[target._identity] = target
        directory.issued = max(directory.issued, target._schema.number_of(target._identity) or 0)
        return target

    def _rename(self, name: str, target: _ObjectData, identity: str) -> None:
        """Gives a live object a new identity, which no other live object of its schema may have."""
        directory = self._directory(name)
        if identity in directory.live:
            raise ValueError(f"a {name!r} with the identity {identity!r} is already live; update it")
        del directory.live[target._identity]
        object.__setattr__(target, "_identity", identity)
        directory.live[identity] = target
        directory.issued = max(directory.issued, target._schema.number_of(identity) or 0)

    def member(self, instance: Any, name: str) -> Any:
        """The value an instance or value object holds in its property `name`."""
        return _read(instance, name)

    def __getattr__(self, name: str) -> Callable[..., Any]:
        if name.startswith("_"):
            raise AttributeError(name)
        registered = self._schemas.get(name)
        if isinstance(registered, VALUE_KINDS) and not getattr(registered, "ref", False):
            return lambda instance=None: _standalone(registered, instance, self)
        schema = self.schema(name)
        return lambda instance=None: _ObjectBuilder(self, schema, name, instance)

    def _filled(self, relation: RelationSchema, link: str) -> str:
        """The name of the one object schema that declares an adjacency to `relation` via `link`."""
        names = self._filling(relation, link)
        if len(names) != 1:
            raise TypeError(f"expected exactly one object schema filling link {link!r}, found {names}")
        return names[0]


class _Directory:
    """One schema's identities in a store: its live objects by identity, held weakly, and the last number its naming
    pattern gave, which only increases."""

    def __init__(self) -> None:
        self.issued = 0
        self.live: weakref.WeakValueDictionary[str, _ObjectData] = weakref.WeakValueDictionary()


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


def owner_of(value: Any) -> Any:
    """The object a value object belongs to, or None for a reference object or a value object not yet placed."""
    return object.__getattribute__(value, "_owner") if isinstance(value, _RecordData) else None


def _same_store(store: OfStore | None, value: Any) -> None:
    held = _store_of(value)
    if store is not None and held is not None and held is not store:
        raise TypeError("the object belongs to another store")


# --- Relation entries ---


def _scalar_key(value: Any) -> Hashable:
    """Equality key per EQUALITY.md: distinct scalar types never compare equal; floats compare by bit pattern; a value
    object by its schema and properties, whatever its identity."""
    if isinstance(value, _RecordData):
        values = object.__getattribute__(value, "_values")
        return ("object", id(value._schema), tuple(sorted((n, _scalar_key(v)) for n, v in values.items())))
    if isinstance(value, _ContainerData):
        return ("container", id(value._schema), frozenset((k, _scalar_key(v)) for k, v in value._items.items()))
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
            return _Empty(f"{name!r} is not a link or property of the relation")
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


def _orders(schema: ObjectSchema, source: Any) -> list[tuple[dict[Hashable, _Entry], list[_Entry]]]:
    """The tables that hold the entries linking `source`, every object's they link, each with its entries in order."""
    tables: dict[int, tuple[dict[Hashable, _Entry], list[_Entry]]] = {}
    for adjacency in schema.adjacencies.values():
        for entry in _linking(adjacency.relation, adjacency.me, source):
            for target in entry._links.values():
                table = _table(target, id(adjacency.relation))
                tables.setdefault(id(table), (table, list(table.values())))
    return list(tables.values())


def _reorder(orders: list[tuple[dict[Hashable, _Entry], list[_Entry]]], rewritten: dict[int, _Entry]) -> None:
    """Puts each entry an update rewrote back where the entry it rewrites was, in every table that held that one: an
    update keeps the order of every object's entries. Entries added anew stay last."""
    for table, before in orders:
        by_entry = {id(entry): key for key, entry in table.items()}
        ordered: dict[Hashable, _Entry] = {}
        for old in before:
            now = old if id(old) in by_entry else rewritten.get(id(old))
            if now is not None and id(now) in by_entry:
                ordered[by_entry[id(now)]] = now
        for key, entry in table.items():
            ordered.setdefault(key, entry)
        table.clear()
        table.update(ordered)


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


def _converted(value: Any, host: type, label: str) -> Any:
    """A scalar's value for a dunder: it must be set and of the dunder's own type."""
    if value is None:
        raise TypeError(f"{label} is not set")
    if type(value) is not host:
        raise TypeError(f"{label} holds {_article(type(value))}, not {_article(host)}")
    return value


class _Unassignable:
    """A visitor whose members are written by calling them, never by assignment: assigning any name not starting with
    `_` (its own state) is refused, so that a write is never silently lost."""

    _refusal = "a visitor's members cannot be assigned: call a member to write through it"

    def __setattr__(self, name: str, value: object) -> None:
        if not name.startswith("_"):
            raise AttributeError(self._refusal)
        object.__setattr__(self, name, value)


def _operand(value: Any) -> Any:
    """What a comparison compares: a scalar visitor's value, or a value given as itself."""
    return value._operand() if isinstance(value, _Dunders) else value


class _Dunders(_Unassignable):
    """The scalar dunders, sugar over `get()`: each conversion raises when the value is not set or not of its type, and
    a visitor compares and orders as its value does (`card.name == "Ada"`), a value of another kind by its identity. A
    read-only visitor hashes as its value; a writable one, whose value may change, is unhashable. A subclass gives
    `_scalar()`, the value, `_held()`, the value held whatever its kind, `_label()`, what holds it, and `_writable`."""

    _scalar: Callable[[], Any]
    _held: Callable[[], Any]
    _label: Callable[[], str]
    _writable: bool

    def _operand(self) -> Any:
        scalar = self._scalar()
        return scalar if scalar is not None else self._held()

    def __eq__(self, other: object) -> bool:
        return bool(self._operand() == _operand(other))

    def __ne__(self, other: object) -> bool:
        return not self == other

    def __lt__(self, other: object) -> bool:
        return bool(self._operand() < _operand(other))

    def __le__(self, other: object) -> bool:
        return bool(self._operand() <= _operand(other))

    def __gt__(self, other: object) -> bool:
        return bool(self._operand() > _operand(other))

    def __ge__(self, other: object) -> bool:
        return bool(self._operand() >= _operand(other))

    def __hash__(self) -> int:
        if self._writable:
            raise TypeError(f"{self._label()} is writable, so unhashable")
        return hash(self._operand())

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

    def __init__(self, reason: str):
        object.__setattr__(self, "_reason", reason)

    _writable = False

    def _scalar(self) -> Any:
        return None

    def _held(self) -> Any:
        return None

    def _label(self) -> str:
        return "the value"

    def as_schema(self) -> None:
        return None  # it visits nothing: no value, so no schema

    def as_identity(self, identity: str | None = None) -> None:
        if identity is not None:
            self._refuse()
        return None

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
        _visit(cb, _Empty(self._reason))
        return self

    as_value = as_scalar = as_object = as_union = as_intersection = as_adjacencies = _hand

    def as_iterable(self, cb: Any) -> _Empty:
        _visit(cb, iter(()))
        return self

    as_container = _hand

    def at(self, index: Any) -> _Empty:
        return _Empty(self._reason)

    def as_ordered(self, cb: Any) -> _Empty:  # nothing to visit: as an inapplicable container's, cb is not called
        return self

    as_dict = as_ordered

    def as_entries(self, cb: Any) -> _Empty:
        _visit(cb, iter(()))
        return self

    def __len__(self) -> int:
        return 0

    def _refuse(self, *args: Any) -> Any:
        raise ReadOnlyError(self._reason)

    set = clear = insert = remove = __call__ = _refuse

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return _Empty(self._reason)

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

    def _held(self) -> Any:
        return None  # a scalar visitor holds a scalar or nothing

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


class _Any(_Unassignable):
    """`Visitors.OfAny` over one key of a values dict, holding a value of `schema`. Read-only, it hands over the value's
    own visitor, or an empty one; writable, it selects the kind, refusing one the schema does not hold."""

    def __init__(self, values: dict[str, Any], name: str, schema: Any, store: OfStore | None, writable: bool,
                 label: str, on_write: Callable[[], None] | None = None):
        self._values, self._name, self._store, self._writable = values, name, store, writable
        self._schema, self._label, self._on_write = schema, label, on_write
        self._type = Schemas.structure(schema)
        self._any = self._type if isinstance(self._type, Schemas.OfAny.Value) else None
        self._unbuilt = ""  # why a Spec has nothing to build: where the value is of any type and its type unknown
        if self._any is not None:  # a value of any type: of the type the value held has
            held = values.get(name)
            self._type = held._schema if isinstance(held, (_RecordData, _RecordBuilder, _Containing)) else None

    def _only(self, kind: Any) -> Any:
        """Where the value is of any type: the one type of `kind` its restriction allows, else None."""
        found = [held for held in map(Schemas.structure, self._any.types) if isinstance(held, kind)]  # type: ignore[union-attr]
        return found[0] if len(found) == 1 else None

    def _allows(self, schema: Any) -> bool:
        """Where the value is of any type: whether its restriction allows a value of `schema`; any, unrestricted."""
        return not self._any.types or any(Schemas.structure(t) is schema for t in self._any.types)  # type: ignore[union-attr]

    def _of_any(self, kind: Any, cb: Any) -> None:
        """Where the value is of any type, takes the type a write of `kind` gives: the value's own, if it is one the
        restriction allows, else the one type of `kind` it allows; a Spec has no other schema to build by."""
        if self._any is None or isinstance(self._type, kind):
            return
        value = cb._values.get(cb._name) if isinstance(cb, _Property) else cb
        if not _is_function(cb) and isinstance(value, (_RecordData, _RecordBuilder, _Containing)):
            if not self._allows(value._schema):
                raise TypeError(f"{self._label} does not hold a value of {_shown_type(value._schema)}")
            self._type = value._schema
        elif self._writable and self._values.get(self._name) is None:  # a Spec, where nothing is held
            self._type = self._only(kind)
            if not self._any.types:
                self._unbuilt = (f"{self._label} holds a value of any type: give a value, which carries its schema, "
                                 "not a Spec")

    def as_schema(self) -> Any:
        return self._schema

    def _touch(self) -> None:
        if self._on_write is not None:
            self._on_write()

    def as_scalar(self, cb: Any) -> _Any:
        value = self._values.get(self._name)
        if self._any is not None and self._type is None:  # a scalar of any type, or of the one its restriction allows
            self._type = self._only(Schemas.OfScalar.Data) or self._any
        if isinstance(self._type, Schemas.OfUnion.Data) and self._type.flat:
            return self._flat_scalar(cb, value)
        if not isinstance(self._type, (Schemas.OfScalar.Data, Schemas.OfAny.Value)):
            return self._hand(cb, _Empty(f"{self._label} holds {_a(_noun(self._type))}, not a scalar"))
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
        if isinstance(value, (_RecordData, _RecordBuilder)):  # a union value holds one branch
            ((branch, held),) = value._values.items()
            if type(held) in (int, float, str, bool, bytes):
                _visit(cb, _Scalar(value._values, branch, Schemas.structure(self._type.properties[branch].type),
                                   False, self._label))
                return self
        _visit(cb, _Empty(f"{self._label} holds no scalar"))
        return self

    def as_object(self, cb: Any) -> _Any:
        return self._record(Schemas.OfObject.Data, cb)

    def as_union(self, cb: Any) -> _Any:
        return self._record(Schemas.OfUnion.Data, cb)

    def as_intersection(self, cb: Any) -> _Any:
        return self._record(Schemas.OfIntersection.Data, cb)

    def as_container(self, cb: Any) -> _Any:
        self._of_any(Schemas.OfContainer.Data, cb)
        if not isinstance(self._type, Schemas.OfContainer.Data):
            return self._hand(cb, _Empty(self._unbuilt or f"{self._label} does not hold a container"))
        value = self._values.get(self._name)
        if not self._writable:
            if isinstance(value, _ContainerData):
                if _is_function(cb):
                    _visit(cb, value)
                    return self
                raise ReadOnlyError(f"{self._label} is read-only; write through a builder")
            return self._hand(cb, _Empty(f"{self._label} is not set"))
        if _is_function(cb):  # selecting the kind writes it, as an empty container until written further
            builder = self._container()
            builder._touch()
            _visit(cb, builder)
        else:
            self._replace_container(cb)
        return self

    def _container(self) -> _ContainerBuilder:
        """The builder of the container held, attached to the values when first written; one already attached."""
        value = self._values.get(self._name)
        if isinstance(value, _ContainerBuilder):
            return value

        def attach(builder: _ContainerBuilder) -> None:
            self._touch()
            self._values[self._name] = builder

        return _ContainerBuilder(self._type, value if isinstance(value, _ContainerData) else None, self._store, attach,
                                 self._label)

    def _replace_container(self, value: Any) -> None:
        """Writes a container given as a value: its elements are copied when it is placed."""
        if not isinstance(value, _Containing) or value._schema is not self._type:
            raise TypeError(f"{self._label} takes a container of its schema or a Spec, got {type(value).__name__}")
        self._touch()
        self._values[self._name] = value

    def _hand(self, cb: Any, empty: _Empty) -> _Any:
        empty._hand(cb)
        return self

    def _record(self, kind: type, cb: Any) -> _Any:
        noun = {Schemas.OfObject.Data: "value object", Schemas.OfUnion.Data: "union value"}.get(kind, "intersection value")
        self._of_any(kind, cb)
        if not isinstance(self._type, kind):
            return self._hand(cb, _Empty(self._unbuilt or f"{self._label} does not hold {_a(noun)}"))
        value = self._values.get(self._name)
        if not self._writable:
            if isinstance(value, _RecordData):
                if _is_function(cb):
                    _visit(cb, value)
                    return self
                raise ReadOnlyError(f"{self._label} is read-only; write through a builder")
            return self._hand(cb, _Empty(f"{self._label} is read-only; write through a builder"))
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
        """Selects the kind, writing the value, and hands its builder over."""
        builder = self._builder()
        builder._touch()
        _visit(cb, builder)

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
        if self._any is not None and isinstance(value, (_RecordData, _RecordBuilder, _Containing)):
            self._of_any(type(value._schema), value)
        held = Schemas.structure(self._type)
        if isinstance(held, Schemas.OfUnion.Data) and held.flat and not (
                isinstance(value, (_RecordData, _RecordBuilder)) and value._schema is held):
            branch = _branch(self._name, held, value)
            self._write_record(lambda u: _member_of(u, branch.name)(value))
        elif isinstance(held, RECORD_KINDS):
            self._replace(value)
        elif isinstance(held, Schemas.OfContainer.Data):
            self._replace_container(value)
        else:
            self.as_scalar(value)

    def clear(self) -> None:
        _write(self._writable, f"{self._label} is read-only; write through a builder")
        self._values.pop(self._name, None)

def _shown_type(schema: Any) -> str:
    """A type in a message: its name, or its kind."""
    return schema.name if getattr(schema, "name", None) is not None else _a(_noun(schema))


def _standalone(schema: Any, source: Any, store: OfStore) -> Any:
    """A builder of a standalone value of a value object, union, intersection or container schema, starting from
    `source` if given: its `create()` gives a value, held by nothing until assigned."""
    if isinstance(schema, Schemas.OfContainer.Data):
        return _ContainerBuilder(schema, source, store, lambda builder: None, f"a {schema.name!r}")
    return _RecordBuilder(schema, source, store)


# --- Containers ---


def _index_key(schema: Schemas.OfContainer.Data, index: Any, label: str) -> Hashable:
    """The key a container holds an element by: its index, checked against the index type, a scalar or, for an index
    of a value object of scalars, a tuple of the value object's properties in declaration order; any other index, a
    value object, by its equality key."""
    kind = Schemas.structure(schema.index)
    if isinstance(kind, Schemas.OfScalar.Data):
        if kind.type is not None and type(index) is not kind.type:
            raise TypeError(f"{label}: an index is a {kind.token.name}, got {type(index).__name__}")
        return index
    if schema.arrangement != "entries":
        scalars = [Schemas.structure(prop.type) for prop in kind.properties.values()]
        if not isinstance(index, tuple) or len(index) != len(scalars) or any(
                scalar.type is not None and type(i) is not scalar.type for i, scalar in zip(index, scalars)):
            names = ", ".join(scalar.token.name for scalar in scalars)
            raise TypeError(f"{label}: an index is a tuple of {names}, got {_shown(index)}")
        return index
    if not isinstance(index, _RecordData) or index._schema is not kind:
        raise TypeError(f"{label}: an index is a value of its index type, got {type(index).__name__}")
    return _scalar_key(index)


def _shown(index: Any) -> str:
    """An index in a message: a tuple of indices as a list, as every implementation shows it."""
    return repr(list(index)) if isinstance(index, tuple) else repr(index)


def _positional(schema: Schemas.OfContainer.Data) -> bool:
    """Whether a container's positions are its int indices: dense or sparse, indexed by an int."""
    index = Schemas.structure(schema.index)
    return schema.arrangement in ("dense", "sparse") and isinstance(index, Schemas.OfScalar.Data) and index.type is int


class _Containing(_Unassignable):
    """`Visitors.OfContainer` over a container's elements, held by key (see `_index_key`), with each key's index. Each
    element is read and written through the `Visitors.OfAny` of its slot."""

    _writable = False

    def _setup(self, schema: Schemas.OfContainer.Data, items: dict[Hashable, Any], indices: dict[Hashable, Any],
               store: OfStore | None, label: str) -> None:
        object.__setattr__(self, "_schema", schema)
        object.__setattr__(self, "_items", items)
        object.__setattr__(self, "_indices", indices)
        object.__setattr__(self, "_store", store)
        object.__setattr__(self, "_label", label)

    def as_schema(self) -> Schemas.OfContainer.Data:
        return self._schema

    def _touch(self) -> None:
        """A builder attaches itself to what holds it when written."""

    def _keys(self) -> list[Hashable]:
        """The keys of the elements present: by index where the index is ordered, else in the order added."""
        return sorted(self._items) if self._schema.arrangement in ("dense", "sparse") else list(self._items)

    def _index(self, key: Hashable) -> Any:
        return self._indices.get(key, key)

    def _element(self, key: Hashable, index: Any) -> _Any:
        def wrote() -> None:
            self._indices[key] = index

        at = ", ".join(map(repr, index)) if isinstance(index, tuple) else repr(index)
        return _Any(self._items, key, self._schema.element, self._store, self._writable, f"{self._label}[{at}]", wrote)

    def __len__(self) -> int:
        """The number of positions: in a dense container of int indices, every index from 0 to the last (and every
        cell of the box they span, for several); else the elements present."""
        if self._schema.arrangement != "dense" or not self._items:
            return len(self._items)
        keys = list(self._items)
        if isinstance(keys[0], int) and not isinstance(keys[0], bool):
            return max(keys) + 1
        if isinstance(keys[0], tuple) and all(isinstance(i, int) and not isinstance(i, bool) for i in keys[0]):
            return math.prod(max(key[d] for key in keys) + 1 for d in range(len(keys[0])))
        return len(keys)

    def at(self, index: Any) -> _Any:
        """The element at `index`, which reads as empty where there is none; a builder's is writable, and writing it
        adds it."""
        key = _index_key(self._schema, index, self._label)
        if self._writable:
            if self._schema.arrangement == "dense" and _negative(index):
                raise ValueError(f"{self._label}: a dense container's index is not negative, got {_shown(index)}")
            self._touch()
        return self._element(key, index)

    def remove(self, index: Any) -> _Containing:
        """Removes the element at `index`, if any."""
        _write(self._writable, f"{self._label} is read-only; write through a builder")
        self._touch()
        key = _index_key(self._schema, index, self._label)
        self._items.pop(key, None)
        self._indices.pop(key, None)
        return self

    def as_ordered(self, cb: Any) -> _Containing:
        """A `Visitors.OfIterator` over the positions, for a dense or sparse container; `cb` is not called otherwise."""
        if self._schema.arrangement in ("dense", "sparse"):
            _visit(cb, _Iterator(self))
        return self

    def as_dict(self, cb: Any) -> _Containing:
        """The elements by index, for a container arranged as a dict; `cb` is not called otherwise."""
        if self._schema.arrangement == "dict":
            _visit(cb, {self._index(key): self._element(key, self._index(key)) for key in self._keys()})
        return self

    def as_entries(self, cb: Any) -> _Containing:
        """Each element present with its index, in order, for every container."""
        _visit(cb, iter([(self._index(key), self._element(key, self._index(key))) for key in self._keys()]))
        return self

    def _positions(self) -> list[Any]:
        """The indices an iterator visits: every position of a dense container of int indices, else those present."""
        keys = self._keys()
        if self._schema.arrangement == "dense" and keys and _positional(self._schema):
            return list(range(len(self)))
        if self._schema.arrangement == "dense" and keys and isinstance(keys[0], tuple):
            return list(itertools.product(*[range(max(key[d] for key in keys) + 1) for d in range(len(keys[0]))]))
        return [self._index(key) for key in keys]

    def _insert(self, index: int, spec: Any) -> None:
        """Writes an element at the int index `index`, moving the elements at it and after up by one."""
        self._touch()
        for key in sorted((k for k in self._items if k >= index), reverse=True):
            self._items[key + 1] = self._items.pop(key)
            self._indices[key + 1] = self._indices.pop(key, key) + 1
        element = self._element(index, index)
        if _is_function(spec):
            _visit(spec, element)
        else:
            element.write(spec)

    def __call__(self, spec: Any) -> Any:
        """As a union's branch or an intersection's part: writes through a Spec, or takes the elements of a container
        given, and returns the value it is a member of."""
        _write(self._writable, f"{self._label} is read-only; write through a builder")
        self._touch()
        if _is_function(spec):
            _visit(spec, self)
        elif isinstance(spec, _Containing) and spec._schema is self._schema:
            self._items.clear()
            self._items.update(spec._items)
            self._indices.clear()
            self._indices.update(spec._indices)
        else:
            raise TypeError(f"{self._label} takes a container of its schema or a Spec, got {type(spec).__name__}")
        return getattr(self, "_parent", None)

    def __repr__(self) -> str:
        return f"<container of {len(self._items)}>"


def _negative(index: Any) -> bool:
    values = index if isinstance(index, tuple) else (index,)
    return any(isinstance(i, int) and i < 0 for i in values)


class _ContainerData(_Containing):
    """A container's value, read-only."""

    def __init__(self, schema: Schemas.OfContainer.Data, items: dict[Hashable, Any], indices: dict[Hashable, Any]):
        self._setup(schema, items, indices, None, "the container")


class _ContainerBuilder(_Containing):
    """A writable `Visitors.OfContainer`, starting from `source` if given. It attaches itself to what holds it
    (`attach`) when first written."""

    _writable = True

    def __init__(self, schema: Schemas.OfContainer.Data, source: _ContainerData | None, store: OfStore | None,
                 attach: Callable[[_ContainerBuilder], None], label: str, parent: Any = None):
        items = dict(source._items) if source is not None else {}
        indices = dict(source._indices) if source is not None else {}
        self._setup(schema, items, indices, store, label)
        object.__setattr__(self, "_attach", attach)
        object.__setattr__(self, "_attached", False)
        object.__setattr__(self, "_parent", parent)

    def _touch(self) -> None:
        if not self._attached:
            object.__setattr__(self, "_attached", True)
            self._attach(self)

    def build(self) -> _ContainerData:
        items = {key: built for key, built in ((k, _built(v)) for k, v in self._items.items()) if built is not None}
        return _ContainerData(self._schema, items, {key: self._indices.get(key, key) for key in items})

    def create(self) -> _ContainerData:
        """A standalone container's value, to assign (see `OfStore.builder`)."""
        return self.build()


class _Iterator(_Unassignable):
    """`Visitors.OfIterator`: a position in a dense or sparse container, before its first position, at one, or past its
    last. Past an end, a builder's `as_item` extends the container there."""

    def __init__(self, container: _Containing):
        self._container, self._at = container, -1

    def _positions(self) -> list[Any]:
        return self._container._positions()

    def first(self) -> _Iterator:
        self._at = 0
        return self

    def last(self) -> _Iterator:
        self._at = len(self._positions()) - 1
        return self

    def next(self) -> _Iterator:
        self._at = min(self._at + 1, len(self._positions()))
        return self

    def prev(self) -> _Iterator:
        self._at = max(self._at - 1, -1)
        return self

    def index(self) -> Any:
        """The index at the position, None before the first or past the last."""
        positions = self._positions()
        return positions[self._at] if 0 <= self._at < len(positions) else None

    def as_item(self, cb: Any) -> _Iterator:
        """Hands over the element at the position. Past an end, a read-only container's `cb` is not called, and a
        builder's container is extended there, the position then resting on the new element."""
        index = self.index()
        if index is not None:
            _visit(cb, self._container.at(index))
        elif self._container._writable:
            self._extend(cb)
        return self

    def _extend(self, spec: Any) -> None:
        self._insertable()
        positions = self._positions()
        if self._at < 0:
            self._at = 0
            self._place(positions[0] if positions else 0, spec)
        else:
            self._at = len(positions)
            self._place(positions[-1] + 1 if positions else 0, spec)

    def prepend(self, spec: Any) -> _Iterator:
        """Inserts an element before the position, which then rests on it."""
        self._insertable()
        positions = self._positions()
        self._at = max(self._at, 0)
        self._place(positions[self._at] if self._at < len(positions) else (positions[-1] + 1 if positions else 0), spec)
        return self

    def append(self, spec: Any) -> _Iterator:
        """Inserts an element after the position, which then rests on it."""
        self._insertable()
        positions = self._positions()
        self._at = min(self._at + 1, len(positions))
        self._place(positions[self._at - 1] + 1 if self._at > 0 else (positions[0] if positions else 0), spec)
        return self

    def _insertable(self) -> None:
        """Refuses an insertion a read-only container, or one whose indices are not ints, cannot take."""
        container = self._container
        _write(container._writable, f"{container._label} is read-only; write through a builder")
        if not _positional(container._schema):
            raise ValueError(f"{container._label}: only a dense or sparse container of int indices has positions to "
                             "insert at; write through at(index)")

    def _place(self, index: Any, spec: Any) -> None:
        container = self._container
        container._insert(index, spec)
        self._at = self._positions().index(index)

    def __repr__(self) -> str:
        return f"<iterator at {_shown(self.index())}>"


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

    def _held(self) -> Any:
        return self._values.get(self._name)

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


class _Properties(_Unassignable):
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
        return value if isinstance(value, (_RecordData, _ContainerData)) else _Empty(f"{label} is not set")
    if isinstance(value, (_RecordBuilder, _ContainerBuilder)):
        return value
    if isinstance(held, Schemas.OfContainer.Data):
        def placed(builder: _ContainerBuilder) -> None:
            on_write()  # type: ignore[misc]
            values[name] = builder

        return _ContainerBuilder(held, value if isinstance(value, _ContainerData) else None, store, placed, label, parent)

    def attach(builder: _RecordBuilder) -> None:
        on_write()  # type: ignore[misc]  # a writable member is a union's or an intersection's, which says what writing does
        values[name] = builder

    return _RecordBuilder(held, value if isinstance(value, _RecordData) else None, store, attach, parent)


# --- Data instances ---


class _ObjectData:
    """A proxy instance: a read-only `Visitors.OfObject`, whose properties and adjacencies are members."""

    __slots__ = ("_store", "_schema", "_schema_name", "_identity", "_values", "_adjacent", "__weakref__")

    def __init__(self, store: OfStore, schema: ObjectSchema, schema_name: str, identity: str):
        object.__setattr__(self, "_identity", identity)
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

    def as_identity(self, identity: str | None = None) -> str:
        if identity is not None:
            raise ReadOnlyError("a data instance is read-only; write through a builder")
        return self._identity

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
    are members giving the visitor of their own type's kind. It belongs to one owner and has no identity of its own;
    nothing links it, so it has no adjacencies."""

    __slots__ = ("_schema", "_values", "_owner", "_source", "_copy_of")

    def __init__(self, schema: Any, values: dict[str, Any], source: _RecordData | None = None, copy_of: Any = None):
        for name, value in (("_schema", schema), ("_values", dict(values)), ("_owner", None), ("_source", source),
                            ("_copy_of", copy_of)):
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

    def as_identity(self, identity: str | None = None) -> None:
        if identity is not None:
            raise TypeError("a value object has no identity of its own")
        return None

    @property
    def as_properties(self) -> _Properties:
        return _properties_of(self, self._values, self._schema, _store_of(self), False)

    def as_adjacencies(self, cb: Any) -> _RecordData:
        return self  # a value object has none


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
        return _member(held, name) if isinstance(held, _RecordData) else _Empty(f"part {part!r} is not set")
    if isinstance(schema, Schemas.OfUnion.Data) and schema.flat:  # a flat union's value reads as its branch's
        held = next(iter(values.values()), None)
        return _member(held, name) if isinstance(held, _RecordData) else _Empty(f"{name!r} is not a member of the branch held")
    adjacency = schema.adjacencies.get(name) if isinstance(schema, ObjectSchema) else None
    if adjacency is not None:
        return _Adjacency(_linking(adjacency.relation, adjacency.me, owner), adjacency, owner)
    return _Empty(f"{name!r} is not a member of {_a(_noun(schema))}")


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


class _Adjacency(_Unassignable, tuple):  # type: ignore[type-arg]
    """An adjacency of a data instance, a read-only `Visitors.OfAdjacency`: the tuple of its entries, in the order they
    were added. `project(name)` gives each entry's link or property `name`, in order, and `at(key)` the entry with the
    key its relation declares (`Schemas.OfRelation.Data.key`)."""

    _schema: Schemas.OfAdjacency.Data
    _owner: Any
    _refusal = "a data instance's adjacency is read-only; write through a builder"

    def __new__(cls, entries: Any, schema: Schemas.OfAdjacency.Data, owner: Any) -> _Adjacency:
        adjacency = super().__new__(cls, entries)
        adjacency._schema, adjacency._owner = schema, owner
        return adjacency

    def as_schema(self) -> Schemas.OfAdjacency.Data:
        return self._schema

    def as_iterable(self, cb: Any) -> _Adjacency:
        _visit(cb, iter(list(self)))
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
        return tuple(entry._links[name] if name in relation.entry.links else
                     _view(entry._properties.get(name), relation.entry.properties[name].type) for entry in self)

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
        properties = self._schema.relation.entry.properties
        for entry in self:
            held = [entry._links[name] if name in links else _view(entry._properties.get(name), properties[name].type)
                    for name in names]
            if all(h is v if name in links else h is not None and _scalar_key(h) == _scalar_key(v)
                   for name, h, v in zip(names, held, wanted)):  # a target by identity, a value by schema equality
                return entry
        raise KeyError(f"no entry has the key {key!r}")


def _entry_parts(entry: Any, me: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """An entry's links other than `me`, and its properties: a placed entry's, or an entry builder's."""
    if isinstance(entry, _Entry):
        return {k: v for k, v in entry._links.items() if k != me}, entry._properties
    return dict(entry._links), _finalized(entry._values)


def _agrees(entry: Any, spec: Any, adjacency: Schemas.OfAdjacency.Data, store: OfStore | None) -> bool:
    """Whether an entry agrees with a query Spec: equal to its value form (an entry), or agreeing with every link and
    property its callable form, a template, sets."""
    links, values = _entry_parts(entry, adjacency.me)
    if _is_function(spec):
        template = _EntryBuilder(adjacency.relation, adjacency.me, store)
        _visit(spec, template)
        wanted_links, wanted_values = template._links, _finalized(template._values)  # value objects built
    else:
        wanted_links, wanted_values = _entry_parts(spec, adjacency.me)
        if set(wanted_links) != set(links) or set(wanted_values) != set(values):
            return False
    return (all(links.get(name) is target for name, target in wanted_links.items())
            and all(name in values and _scalar_key(values[name]) == _scalar_key(value)
                    for name, value in wanted_values.items()))


def _view(value: Any, schema: Any) -> Any:
    """A value as `project` and `at` read it: a flat union's value as its branch's value."""
    schema = Schemas.structure(schema)
    if not (isinstance(schema, Schemas.OfUnion.Data) and schema.flat and isinstance(value, _RecordData) and value._values):
        return value
    ((branch, held),) = value._values.items()
    return _view(held, schema.properties[branch].type)


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
    return "container" if isinstance(schema, Schemas.OfContainer.Data) else "value object"


def _a(noun: str) -> str:
    return f"an {noun}" if noun == "intersection value" else f"a {noun}"


# --- Value objects: staging, copying, placing ---


def _set(target: Any, name: str, value: Any) -> None:
    object.__getattribute__(target, "_values")[name] = value


def _prior(old: Any, key: Hashable, new: Any) -> Any:
    """What a container's element `new` takes the place of, in the container `old`: the value object it is, or edits,
    where `old` holds that one (an element may have moved), else the element at its key."""
    if not isinstance(old, _ContainerData):
        return None
    held = {id(value): value for value in old._items.values()}
    for candidate in (new, getattr(new, "_source", None)):
        if candidate is not None and id(candidate) in held:
            return candidate
    return old._items.get(key)


def _stage(old: Any, new: Any, mapping: dict[int, Any]) -> Any:
    """Prepares `new` to be placed where `old` was: a value object owned elsewhere is copied, and `mapping` records, for
    each value object copied or edited, the one that takes its place, so that the entries among them link those. A
    container's elements are staged each in turn."""
    if isinstance(new, _ContainerData) and new is not old:
        items = {key: _stage(_prior(old, key, value), value, mapping) for key, value in new._items.items()}
        return _ContainerData(new._schema, items, dict(new._indices))
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
    """Stages the value objects a value object holds in its properties."""
    held = {} if old is None else old._values
    for name, value in list(record._values.items()):
        _set(record, name, _stage(held.get(name), value, mapping))


def _copy(record: _RecordData) -> _RecordData:
    """A copy of a placed value object, with copies of the value objects it holds."""
    builder = _RecordBuilder(record._schema, store=_store_of(record))
    builder._copy_of = record
    builder._values = {name: _copied(v) for name, v in record._values.items()}
    return builder.build()


def _copied(value: Any) -> Any:
    """A copy of a held value: of a value object, or of a container and the value objects it holds."""
    if isinstance(value, _RecordData):
        return _copy(value)
    if isinstance(value, _ContainerData):
        return _ContainerData(value._schema, {k: _copied(v) for k, v in value._items.items()}, dict(value._indices))
    return value


def _finish(owner: Any, old: Any, new: Any, mapping: dict[int, Any]) -> Any:
    """Places a staged value: an edit is merged into `old`, and a value object built for it is adopted by `owner`, as
    those a container holds are."""
    if isinstance(new, _ContainerData) and new is not old:
        for key, value in list(new._items.items()):
            new._items[key] = _finish(owner, _prior(old, key, value), value, mapping)
        return new
    if not isinstance(new, _RecordData) or new is old:
        return new
    if new._source is not None and new._source is old:
        _merge(old, new, mapping)
        return old
    object.__setattr__(new, "_owner", owner)
    for name, value in list(new._values.items()):
        _set(new, name, _finish(new, None, value, mapping))
    return new


def _merge(old: _RecordData, new: _RecordData, mapping: dict[int, Any]) -> None:
    """Writes an edit of a placed value object into it, so that it is the one its owner holds."""
    values = {name: _finish(old, old._values.get(name), value, mapping) for name, value in new._values.items()}
    object.__getattribute__(old, "_values").clear()
    object.__getattribute__(old, "_values").update(values)


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
    """A value as a builder finalizes it: a value object's builder, built; a union value without a branch, none."""
    if isinstance(value, _RecordBuilder):
        return None if isinstance(value._schema, Schemas.OfUnion.Data) and not value._values else value.build()
    if isinstance(value, _ContainerBuilder):
        return value.build()
    return value


def _finalized(values: dict[str, Any]) -> dict[str, Any]:
    """Values as a builder finalizes them, a union value without a branch left out."""
    return {name: built for name, built in ((n, _built(v)) for n, v in values.items()) if built is not None}


class _RecordBuilder(_Unassignable):
    """A writable `Visitors.OfObject` building a value object, starting from `source` if given; or a writable
    `Visitors.OfUnion` or `Visitors.OfIntersection`, whose branches or parts are members giving the visitor of their own
    type's kind. It attaches itself to what holds it (`attach`) when first written, so that an unwritten builder
    changes nothing. Writing a union's branch clears any other."""

    def __init__(self, schema: Any, source: _RecordData | None = None, store: OfStore | None = None,
                 attach: Callable[[_RecordBuilder], None] | None = None, parent: Any = None):
        self._schema, self._source, self._copy_of, self._store = schema, source, None, store
        self._attach, self._parent = attach, parent
        self._values: dict[str, Any] = {} if source is None else dict(object.__getattribute__(source, "_values"))

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

    def as_identity(self, identity: str | None = None) -> None:
        if identity is not None:
            raise TypeError("a value object has no identity of its own")
        return None

    @property
    def as_properties(self) -> _Properties:
        return _properties_of(self, self._values, self._schema, self._store, True, self._touch)

    def as_adjacencies(self, cb: Any) -> _RecordBuilder:
        return self  # a value object has none

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
        if part is not None:  # a flat intersection's part's property: written in that part, a member of this value
            member = self._member(part)._member(name)
            member._parent = self
            return member
        return _Empty(f"{name!r} is not a member of {_a(_noun(schema))}")

    def __call__(self, spec: Any) -> Any:
        """As a union's branch or an intersection's part: writes through a Spec, selecting the branch."""
        if _is_function(spec):
            self._touch()
            _visit(spec, self)
        else:
            if not isinstance(spec, _RecordData) or spec._schema is not self._schema:
                raise TypeError(f"{_a(_noun(self._schema))} or a Spec is expected, got {type(spec).__name__}")
            self._values = dict(spec._values)
            self._copy_of = spec
            self._touch()
        return self._parent

    def build(self) -> _RecordData:
        return _RecordData(self._schema, _finalized(self._values), self._source, self._copy_of)

    def create(self) -> _RecordData:
        """A standalone value's value, to assign (see `OfStore.builder`)."""
        return self.build()


class _AdjacencyBuilder(_Unassignable):
    """A writable `Visitors.OfAdjacency` over one adjacency of an object's builder: iterated, its entries' builders."""

    def __init__(self, builder: Any, name: str):
        self._builder, self._name = builder, name
        self._schema = builder._schema.adjacencies[name]

    def _entries(self) -> list[_EntryBuilder]:
        return self._builder._entries.get(self._name, [])

    def as_schema(self) -> Schemas.OfAdjacency.Data:
        return self._schema

    def __iter__(self) -> Iterator[_EntryBuilder]:
        return iter(list(self._entries()))

    def as_iterable(self, cb: Any) -> _AdjacencyBuilder:
        _visit(cb, iter(list(self._entries())))
        return self

    def insert(self, spec: Any) -> _AdjacencyBuilder:
        entry = _EntryBuilder(self._schema.relation, self._schema.me, self._builder._store)
        if _is_function(spec):
            _visit(spec, entry)
        else:
            links, values = _entry_parts(spec, self._schema.me)
            entry._links, entry._values = dict(links), dict(values)
        self._builder._entries.setdefault(self._name, []).append(entry)
        return self

    def remove(self, spec: Any) -> _AdjacencyBuilder:
        kept = [e for e in self._entries() if not _agrees(e, spec, self._schema, self._builder._store)]
        self._builder._entries[self._name] = kept
        return self

    def __call__(self, spec: Any) -> Any:
        if _is_function(spec):
            _visit(spec, self)
        else:
            for entry in spec:  # an iterable of entries, each inserted
                self.insert(entry)
        return self._builder


class _LinkMember(_Unassignable):
    """An entry builder's link: read, the linked object, read-only (an object is edited through its own builder);
    called with a Spec, it relinks: to an instance given, or to one created through the builder a callable is given."""

    def __init__(self, entry: _EntryBuilder, name: str):
        object.__setattr__(self, "_entry", entry)
        object.__setattr__(self, "_name", name)

    def _target(self) -> Any:
        target = self._entry._links.get(self._name)
        if isinstance(target, _ObjectBuilder):
            return target._source if target._source is not None else _Empty("not created yet")
        return target if target is not None else _Empty(f"link {self._name!r} is not set")

    def as_schema(self) -> Any:
        return self._target().as_schema()

    def as_identity(self, identity: str | None = None) -> str | None:
        return self._target().as_identity(identity)

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
            store = entry._store  # a link is a reference object's, built in a store
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


class _EntryBuilder(_Unassignable):
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
        return _Empty(f"{name!r} is not a link this entry can set, nor a property of the relation")

    def __repr__(self) -> str:
        return f"<entry builder of {self._relation.name or 'a relation'}>"

    def _kept(self, target: Any) -> dict[str, Any]:
        """The values of the entry this one rewrites, where it links the same `target`: an update keeps them."""
        source = self._source
        return source._properties if source is not None and source._links.get(self._me) is target else {}

    def _stage(self, target: Any, mapping: dict[int, Any]) -> None:
        """Stages the value objects the entry holds for `target`, before any is placed (see `_stage`)."""
        kept = self._kept(target)
        self._values = {name: _stage(kept.get(name), value, mapping) for name, value in _finalized(self._values).items()}

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
        return _Entry(self._relation, links, _finalized(self._values))


def _load_entries(entries: dict[str, list[_EntryBuilder]], schema: ObjectSchema, source: _ObjectData) -> None:
    """Loads the entries linking `source` into a builder, as entry builders, so that an update rewrites them."""
    store = _store_of(source)
    for name, adjacency in schema.adjacencies.items():
        for entry in _linking(adjacency.relation, adjacency.me, source):
            builder = _EntryBuilder(adjacency.relation, adjacency.me, store)
            builder._links = {link: target for link, target in entry._links.items() if link != adjacency.me}
            builder._values = dict(entry._properties)
            builder._source = entry
            entries.setdefault(name, []).append(builder)


class _ObjectBuilder(_Unassignable):
    """A writable `Visitors.OfObject` building a proxy instance: its properties and adjacencies are members, reading
    back what has been written. Finalized by `create()`, `clone()` or `update()`; none validate."""

    def __init__(self, store: OfStore, schema: ObjectSchema, schema_name: str, instance: _ObjectData | None = None):
        if not schema.ref:
            raise TypeError(f"{schema_name!r} is a value object schema; build a value through its owner, or standalone "
                            "through the store")
        self._store, self._schema, self._schema_name, self._source = store, schema, schema_name, instance
        self._identity: str | None = None  # the identity written (`as_identity`), or a decoder restores
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

    def as_identity(self, identity: str | None = None) -> Any:
        """Read, the identity the object will have: the one written, its source's, or None for a new object, which its
        store gives one when created. Written, the object's identity: a global ID, such as an operator's, or another
        name; a schema's naming pattern must give it, and a singleton's is its global name."""
        if identity is None:
            return self._identity if self._identity is not None else (
                None if self._source is None else self._source.as_identity())
        if not isinstance(identity, str) or not identity:
            raise TypeError(f"an identity is non-empty text, got {identity!r}")
        if self._schema.singleton is not None:
            raise ValueError(f"a singleton's identity is its global name, {self._schema.singleton!r}")
        if self._schema.pattern is not None and self._schema.number_of(identity) is None:
            raise ValueError(f"{identity!r} is not a name {self._schema_name!r}'s naming pattern "
                             f"{self._schema.pattern!r} gives")
        self._identity = identity
        return self

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
        return _Empty(f"{name!r} is not a property or adjacency of {self._schema_name!r}")

    def __repr__(self) -> str:
        return f"<builder of {self._schema_name}>"

    def create(self) -> _ObjectData:
        if self._source is not None:
            raise ValueError("create() is only valid without a source instance; use clone() or update()")
        self._not_singleton("create")
        return self._write(self._new(self._identity or self._store._issue(self._schema, self._schema_name)))

    def clone(self) -> _ObjectData:
        if self._source is None:
            raise ValueError("clone() is only valid with a source instance")
        self._not_singleton("clone")
        return self._write(self._new(self._identity or self._store._issue(self._schema, self._schema_name)))

    def _new(self, identity: str) -> _ObjectData:
        """A new object of the builder's schema, entered in its directory under `identity`."""
        return self._store._enter(self._schema_name, _ObjectData(self._store, self._schema, self._schema_name, identity))

    def update(self) -> _ObjectData:
        if self._source is None:
            raise ValueError("update() is only valid with a source instance")
        if self._identity is not None and self._identity != self._source._identity:  # renamed
            self._store._rename(self._schema_name, self._source, self._identity)
        orders = _orders(self._schema, self._source)
        for adjacency in self._schema.adjacencies.values():
            _discard_linking(adjacency.relation, adjacency.me, self._source)
        rewritten: dict[int, _Entry] = {}
        written = self._write(self._source, rewritten)
        _reorder(orders, rewritten)
        return written

    def _not_singleton(self, method: str) -> None:
        if self._schema.singleton is not None:
            raise ValueError(f"{method}() would make a second {self._schema_name!r}; its one instance is "
                             f"store.singleton({self._schema.singleton!r})")

    def _write(self, target: _ObjectData, rewritten: dict[int, _Entry] | None = None) -> _ObjectData:
        """Writes the builder into `target`. Every value object it holds, its entries' too, is staged before any is
        placed."""
        mapping: dict[int, Any] = {}
        if self._source is not None and target is not self._source:  # a clone: its value objects link it, not the source
            mapping[id(self._source)] = target
        old = dict(target._values)
        staged = {name: _stage(old.get(name), value, mapping) for name, value in _finalized(self._values).items()}
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
                    built = entry.build(target)
                    _add_entry(relation, built)
                    if rewritten is not None and entry._source is not None:  # by id: the entry it rewrites
                        # the entry held: a self-loop's is built from each end, and a set keeps one
                        rewritten[id(entry._source)] = _table(target, id(relation))[built._key()]
        return target


_VALUES = (_ObjectData, _RecordData, _Entry, _Property, _Scalar, _RecordBuilder, _LinkMember, _Adjacency,
           _AdjacencyBuilder, _Empty, _EntryBuilder, _Containing, _Iterator)
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
