"""Proxies: the dynamic implementation.

Programs using proxies skip code generation: `register(name, schema)` makes a schema available, and
`Builders.<Name>(optional instance)` returns a builder for it. Instances (`Proxies.OfObject.Data`) are `Visitable`,
not visitors: they expose their properties as read-only attributes and write themselves into a visitor on `accept`.
Builders (`Proxies.OfObject.Builder`) implement `Visitors.OfObject`, like every builder.

Relation entries live in one global table per relation. Adding an entry equal to an existing one is elided.

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

    def __getattr__(self, name: str) -> Callable[..., _ObjectBuilder]:
        schema = _object_schema(name)
        return lambda instance=None: _ObjectBuilder(schema, name, instance)


Builders = _Builders()


# --- Relation entries ---


def _native_key(value: Native) -> tuple[str, object]:
    """Equality key per Framework.md: distinct native types never compare equal; floats compare by bit pattern."""
    if type(value) not in (int, float, str, bool, bytes):
        raise TypeError(f"an entry property must be a native value, got {type(value).__name__}")
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

    def __getattr__(self, name: str) -> Native:
        values = object.__getattribute__(self, "_values")
        if name in values:
            return values[name]
        if name in object.__getattribute__(self, "_schema").properties:
            raise AttributeError(f"property {name!r} is not set")
        raise AttributeError(name)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("proxy properties are read-only; use a builder")

    def identity(self) -> Hashable:
        return id(self)

    def schema_name(self) -> str:
        return self._schema_name

    def accept(self, visitor: Visitors.OfObject) -> None:
        """Writes properties in the schema's declared order, then entries adjacency by adjacency."""
        for name in self._schema.properties:
            if name in self._values:
                value = self._values[name]
                visitor.property(name, lambda p, value=value: p.value(lambda a: a.as_native(lambda n: n.set(value))))
        for adjacency_name, adjacency in self._schema.adjacencies.items():
            for entry in _relation_data(adjacency.relation).linking(adjacency.me, self):
                visitor.adjacency(
                    adjacency_name,
                    lambda a, entry=entry, adj=adjacency: a.add(lambda e: _write_entry(e, entry, adj)),
                )


def _write_entry(visitor: Visitors.OfEntry, entry: _Entry, adjacency: Schemas.OfAdjacency.Data) -> None:
    """Writes an entry's links and properties in the relation's declared order, whichever end built the entry."""
    relation = adjacency.relation
    for name in relation.links:
        if name != adjacency.me:
            visitor.link(name, lambda k, target=entry.links[name]: k.set(target))
    for name in relation.properties:
        if name in entry.properties:
            value = entry.properties[name]
            visitor.property(name, lambda p, value=value: p.value(lambda a: a.as_native(lambda n: n.set(value))))


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
    """`Visitors.OfAny` over one key of a value dict. Only native values are supported so far."""

    def __init__(self, values: dict[str, Native], name: str):
        self._values, self._name = values, name

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> _AnySlot:
        callback(_NativeSlot(self._values, self._name))
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> _AnySlot:
        raise NotImplementedError("object-valued properties are not supported by proxies yet")

    def as_union(self, callback: Callable[[Visitors.OfUnion], Any]) -> _AnySlot:
        raise NotImplementedError("union-valued properties are not supported by proxies yet")

    def as_intersection(self, callback: Callable[[Visitors.OfIntersection], Any]) -> _AnySlot:
        raise NotImplementedError("intersection-valued properties are not supported by proxies yet")


class _PropertySlot:
    """`Visitors.OfProperty` over one key of a value dict."""

    def __init__(self, values: dict[str, Native], name: str):
        self._values, self._name = values, name

    def name(self) -> str:
        return self._name

    def has(self) -> bool:
        return self._name in self._values

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _PropertySlot:
        callback(_AnySlot(self._values, self._name))
        return self

    def clear(self) -> _PropertySlot:
        self._values.pop(self._name, None)
        return self


def _setter(visitor: Any, name: str) -> Callable[[Any], Any]:
    """DSL setter: `.name(value)` or `.name(lambda v: v.set(value))`, where `v` is a `Visitors.OfNative`."""

    def setter(spec: Any) -> Any:
        on_native = spec if callable(spec) else (lambda n: n.set(spec))
        visitor.property(name, lambda p: p.value(lambda a: a.as_native(on_native)))
        return visitor

    return setter


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
        if not isinstance(target, _ObjectData):
            raise TypeError("proxies can only link proxy instances")
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
            callback(_PropertySlot(self._values, name))
        return self

    def has(self, name: str) -> bool:
        return name in self._values

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _EntryBuilder:
        if name not in self._relation.properties:
            raise AttributeError(f"{name!r} is not a property of this relation")
        callback(_PropertySlot(self._values, name))
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
            return _setter(self, name)
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
        return _Entry(links, self._values)


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
        self._schema, self._schema_name, self._source = schema, schema_name, instance
        self._values: dict[str, Native] = {}
        self._entries: dict[str, list[_EntryBuilder]] = {}
        if instance is not None:
            if not isinstance(instance, _ObjectData):
                raise TypeError("a builder's source must be a proxy instance")
            if instance.schema_name() != schema_name:
                raise TypeError(f"instance is a {instance.schema_name()!r}, not a {schema_name!r}")
            instance.accept(self)

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _ObjectBuilder:
        for name in list(self._values):
            callback(_PropertySlot(self._values, name))
        return self

    def has(self, name: str) -> bool:
        return name in self._values

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _ObjectBuilder:
        if name not in self._schema.properties:
            raise AttributeError(f"{name!r} is not a property of {self._schema_name!r}")
        callback(_PropertySlot(self._values, name))
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

    def __getattr__(self, name: str) -> Callable[[Any], _ObjectBuilder]:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._schema.properties:
            return _setter(self, name)
        if name in self._schema.adjacencies:

            def adder(spec: Callable[[Visitors.OfEntry], Any]) -> _ObjectBuilder:
                if not callable(spec):
                    raise TypeError(f"{name!r} takes an entry Spec, e.g. lambda x: x.<link>(...)")
                return self.adjacency(name, lambda a: a.add(spec))

            return adder
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
        target._values.clear()
        target._values.update(self._values)
        for name, entries in self._entries.items():
            relation = _relation_data(self._schema.adjacencies[name].relation)
            for entry in entries:
                relation.add(entry.build(target))
        return target


class OfObject:
    Data = _ObjectData
    Builder = _ObjectBuilder


class OfRelation:
    Data = _RelationData
