"""Proxies: the dynamic implementation.

Programs using proxies skip code generation: `register(name, schema)` makes a schema available, and
`Builders.<Name>(optional instance)` returns a builder for it. Instances (`Proxies.OfObject.Data`) are `Visitable`,
not visitors: they expose their properties as read-only attributes and write themselves into a visitor on `accept`.
Builders (`Proxies.OfObject.Builder`) implement `Visitors.OfObject`, like every builder.

Relation entries live in one global table per relation. Adding an entry equal to an existing one is elided.

A property whose schema is an `OfObject` holds an embedded object: a read-only record with no identity
(`Proxies.OfObject.Record`), read with attributes like an instance and set with a Spec, e.g.
`.reach(lambda r: r.number('+44'))`. A property whose schema is an `OfUnion` holds a value of one of its branches, set
directly (the first branch of the value's native type or record schema) or with `.reach(lambda u: u.of(Phone, spec))`.
Proxies store which branch a union value was written as, and snapshots record it; checking it against the branches'
predicates is the job of `Validators`, given an evaluator.
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
    """Equality key per EQUALITY.md: distinct native types never compare equal; floats compare by bit pattern."""
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

    def __getattr__(self, name: str) -> Any:
        return _read(self, name)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("proxy properties are read-only; use a builder")

    def identity(self) -> Hashable:
        return id(self)

    def schema_name(self) -> str:
        return self._schema_name

    def accept(self, visitor: Visitors.OfObject) -> None:
        """Writes properties in the schema's declared order, then entries adjacency by adjacency."""
        _write_properties(visitor, self._schema, self._values)
        for adjacency_name, adjacency in self._schema.adjacencies.items():
            for entry in _relation_data(adjacency.relation).linking(adjacency.me, self):
                visitor.adjacency(
                    adjacency_name,
                    lambda a, entry=entry, adj=adjacency: a.add(lambda e: _write_entry(e, entry, adj)),
                )


def _read(value: Any, name: str) -> Any:
    """A property of an instance or record, as an attribute: a union value reads as the value it holds."""
    values = object.__getattribute__(value, "_values")
    if name in values:
        item = values[name]
        return item.value if isinstance(item, _UnionValue) else item
    if name in object.__getattribute__(value, "_schema").properties:
        raise AttributeError(f"property {name!r} is not set")
    raise AttributeError(name)


def _write_properties(visitor: Any, schema: ObjectSchema, values: dict[str, Any]) -> None:
    """Writes the values that are set, in the schema's declared order."""
    for name in schema.properties:
        if name in values:
            visitor.property(name, lambda p, value=values[name]: p.value(lambda a: _write_value(a, value)))


def _write_value(visitor: Visitors.OfAny, value: Any) -> None:
    """Writes a native, an embedded object or a union value into a `Visitors.OfAny`."""
    if isinstance(value, _UnionValue):
        visitor.as_union(lambda u: u.select(value.index).value(lambda v: _write_value(v, value.value)))
    elif isinstance(value, _RecordData):
        visitor.as_object(lambda o: value.accept(o))
    else:
        visitor.as_native(lambda n: n.set(value))


class _UnionValue:
    """A union property's value, with the index of the branch it was written as."""

    __slots__ = ("index", "value")

    def __init__(self, index: int, value: Any):
        self.index, self.value = index, value


class _RecordData:
    """An embedded object: the value of a property whose schema is an `OfObject`. It has no identity and no
    adjacencies; its properties are read-only attributes, and reading one that is not set raises AttributeError."""

    __slots__ = ("_schema", "_values")

    def __init__(self, schema: ObjectSchema, values: dict[str, Any]):
        object.__setattr__(self, "_schema", schema)
        object.__setattr__(self, "_values", dict(values))

    def __getattr__(self, name: str) -> Any:
        return _read(self, name)

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("embedded objects are read-only; use a builder")

    def accept(self, visitor: Visitors.OfObject) -> None:
        """Writes the properties in the schema's declared order."""
        _write_properties(visitor, self._schema, self._values)


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
    """`Visitors.OfAny` over one key of a value dict, holding a value of `schema` (an entry property's schema is not
    given: entry properties are native)."""

    def __init__(self, values: dict[str, Any], name: str, schema: Any = None):
        self._values, self._name, self._schema = values, name, schema

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> _AnySlot:
        callback(_NativeSlot(self._values, self._name))
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> _AnySlot:
        """Builds an embedded object, starting from the one already set, if any."""
        if not isinstance(self._schema, Schemas.OfObject.Data):
            raise TypeError(f"property {self._name!r} does not hold an object")
        current = self._values.get(self._name)
        builder = _RecordBuilder(self._schema, current if isinstance(current, _RecordData) else None)
        callback(builder)
        self._values[self._name] = builder.build()
        return self

    def as_union(self, callback: Callable[[Visitors.OfUnion], Any]) -> _AnySlot:
        if not isinstance(self._schema, Schemas.OfUnion.Data):
            raise TypeError(f"property {self._name!r} does not hold a union")
        callback(_UnionSlot(self._values, self._name, self._schema))
        return self

    def as_intersection(self, callback: Callable[[Visitors.OfIntersection], Any]) -> _AnySlot:
        raise NotImplementedError("intersection-valued properties are not supported by proxies yet")


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
    builder: a `Visitors.OfNative` (`v.set(...)`), an embedded object's builder, or a union's `Visitors.OfUnion`."""

    def setter(spec: Any) -> Any:
        visitor.property(name, lambda p: p.value(lambda a: _apply(a, name, schema, spec)))
        return visitor

    return setter


def _apply(visitor: Visitors.OfAny, name: str, schema: Any, spec: Any) -> None:
    """Writes `spec` (a value, or a callable taking the value's builder) as a value of `schema`."""
    if isinstance(schema, Schemas.OfObject.Data):
        if callable(spec):
            visitor.as_object(spec)
        elif isinstance(spec, _RecordData):
            visitor.as_object(lambda o: spec.accept(o))
        else:
            raise TypeError(f"property {name!r} takes an embedded object or a Spec, got {type(spec).__name__}")
    elif isinstance(schema, Schemas.OfUnion.Data):
        if callable(spec):
            visitor.as_union(spec)
        else:
            index = _branch_of(schema, spec)
            visitor.as_union(lambda u: u.select(index).value(lambda v: _write_value(v, spec)))
    else:
        visitor.as_native(spec if callable(spec) else (lambda n: n.set(spec)))


def _branch_of(schema: Schemas.OfUnion.Data, value: Any) -> int:
    """The first branch that can hold `value`: of its record's schema, or of its native type."""
    for i, branch in enumerate(schema.branches):
        if isinstance(value, _RecordData):
            if branch.type is object.__getattribute__(value, "_schema"):
                return i
        elif isinstance(branch.type, Schemas.OfNative.Data) and branch.type.type is type(value):
            return i
    kind = "an embedded object" if isinstance(value, _RecordData) else f"a {type(value).__name__}"
    raise TypeError(f"no branch of the union holds {kind}")


class _UnionSlot:
    """`Visitors.OfUnion` over one key of a value dict. `select(index)` chooses the branch the value is written as,
    before `value(...)` writes it. DSL: `.of(schema, spec)` selects the first branch of `schema` and writes `spec`."""

    def __init__(self, values: dict[str, Any], name: str, schema: Schemas.OfUnion.Data):
        self._values, self._name, self._schema = values, name, schema
        current = values.get(name)
        self._selected: int | None = current.index if isinstance(current, _UnionValue) else None

    def branch(self) -> int:
        current = self._values.get(self._name)
        if not isinstance(current, _UnionValue):
            raise AttributeError(f"property {self._name!r} is not set")
        return current.index

    def select(self, index: int) -> _UnionSlot:
        if type(index) is not int or not 0 <= index < len(self._schema.branches):
            raise ValueError(f"the union has no branch {index!r}")
        self._selected = index
        return self

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _UnionSlot:
        if self._selected is None:
            raise ValueError("select a branch before writing the union's value")
        current = self._values.get(self._name)
        inner = {} if not isinstance(current, _UnionValue) or current.index != self._selected else {"value": current.value}
        callback(_AnySlot(inner, "value", self._schema.branches[self._selected].type))
        if "value" in inner:
            self._values[self._name] = _UnionValue(self._selected, inner["value"])
        else:
            self._values.pop(self._name, None)
        return self

    def of(self, schema: Any, spec: Any) -> _UnionSlot:
        for i, branch in enumerate(self._schema.branches):
            if branch.type is schema:
                return self.select(i).value(lambda v: _apply(v, self._name, schema, spec))
        raise ValueError("no branch of the union has that schema")


class _RecordBuilder:
    """`Visitors.OfObject` for building an embedded object, starting from `source` if given. DSL: `.<property>(value
    or Spec)`. An embedded object has no adjacencies."""

    def __init__(self, schema: ObjectSchema, source: _RecordData | None = None):
        self._schema = schema
        self._values: dict[str, Any] = {} if source is None else dict(object.__getattribute__(source, "_values"))

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _RecordBuilder:
        for name in [n for n in self._schema.properties if n in self._values]:
            callback(_PropertySlot(self._values, name, self._schema.properties[name]))
        return self

    def has(self, name: str) -> bool:
        return name in self._values

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _RecordBuilder:
        if name not in self._schema.properties:
            raise AttributeError(f"{name!r} is not a property of the embedded object")
        callback(_PropertySlot(self._values, name, self._schema.properties[name]))
        return self

    def clear(self, name: str) -> _RecordBuilder:
        self._values.pop(name, None)
        return self

    def adjacencies(self, callback: Callable[[Visitors.OfAdjacency], Any]) -> _RecordBuilder:
        return self

    def adjacency(self, name: str, callback: Callable[[Visitors.OfAdjacency], Any]) -> _RecordBuilder:
        raise AttributeError(f"an embedded object has no adjacencies, got {name!r}")

    def __getattr__(self, name: str) -> Callable[[Any], _RecordBuilder]:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._schema.properties:
            return _setter(self, name, self._schema.properties[name])
        raise AttributeError(f"{name!r} is not a property of the embedded object")

    def build(self) -> _RecordData:
        return _RecordData(self._schema, self._values)


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

    def __getattr__(self, name: str) -> Callable[[Any], _ObjectBuilder]:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._schema.properties:
            return _setter(self, name, self._schema.properties[name])
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
    Record = _RecordData


class OfRelation:
    Data = _RelationData
