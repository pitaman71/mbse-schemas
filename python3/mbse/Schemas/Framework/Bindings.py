"""Bindings: a program's own classes, bound to reference object schemas.

`Proxies` gives any registered schema dynamic instances; `Bindings` gives a program's own classes, written or generated
in its language, the same part in the framework. A binding pairs a reference object schema, the source of truth, with
two functions: `read(instance)` gives an instance's `State`, and `make(state)` builds an instance from one;
`assign(instance, state)` writes a state into an existing instance, for `update()`. Everything else is generic:

- `accept(binding, instance, visitor)` writes an instance through the visitor protocols, so a class's `accept` is one
  line.
- `Builder(binding, instance)` is a `Visitors.OfObject` over a state, with every value kind the schema declares:
  natives (checked by type), and value objects, unions and lists (through their plain form). It is finalized by
  `create()`, `clone()` and `update()`, none validating. A class's own builder derives from it for its DSL.
- `OfStore(builders)` is a store of bound classes (see `Stores`): their schemas and builders by name, and the instance
  of each singleton schema, made by its builder.

A state holds each property's value, natives as natives and other values in their plain form (an absent property has
no key, and a builder drops the keys whose value is None), and each adjacency's
entries, each an `Entry` of its links (the linked instances) and its properties. A binding may also declare `fixed`
properties, whose value is the class's (a tag), so that writing another raises; `exclusive` groups of properties, of
which a state holds at most one, so that writing one clears the others; and `implied` adjacencies, whose entries the
other ends imply, so that the builder ignores entries added to them.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from . import Plain, Schemas, Stores, Visitors
from .Visitors import Native

__all__ = ["Entry", "State", "Binding", "Builder", "OfStore", "accept"]


@dataclass
class Entry:
    """One entry of an adjacency, seen from the instance: its other links and its properties."""

    links: dict[str, Any] = field(default_factory=dict)
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class State:
    """An instance's data in its schema's terms: property values by name (natives as natives, other values in their
    plain form; an absent property has no key), and entries by adjacency name."""

    values: dict[str, Any] = field(default_factory=dict)
    entries: dict[str, list[Entry]] = field(default_factory=dict)


class Binding:
    """A class bound to a reference object schema, through `read`, `make` and `assign`."""

    def __init__(self, schema: Schemas.OfObject.Data, read: Callable[[Any], State], make: Callable[[State], Any],
                 assign: Callable[[Any, State], Any] | None = None, *, fixed: Mapping[str, Native] | None = None,
                 exclusive: Iterable[Sequence[str]] = (), implied: Iterable[str] = ()):
        self.schema, self.read, self.make = schema, read, make
        self.assign = assign or (lambda instance, state: instance)
        self.fixed = dict(fixed or {})
        self.exclusive = {name: tuple(group) for group in exclusive for name in group}
        self.implied = frozenset(implied)


def _native(schema: Any) -> bool:
    return isinstance(schema, Schemas.OfNative.Data)


def _write_value(visitor: Visitors.OfAny, schema: Any, value: Any) -> None:
    """Writes a state's value: a native as is, any other value from its plain form."""
    if _native(schema):
        visitor.as_native(lambda n: n.set(value))
    else:
        decoded = Plain._decode(schema, value, ())
        Plain._write(visitor, decoded)


def accept(binding: Binding, instance: Any, visitor: Visitors.OfObject) -> None:
    """Writes `instance` into `visitor`: its properties in the schema's order (the fixed ones from the binding), then
    each adjacency's entries."""
    state = binding.read(instance)
    for name, schema in binding.schema.properties.items():
        value = binding.fixed[name] if name in binding.fixed else state.values.get(name)
        if value is not None:
            visitor.property(name, lambda p, s=schema, v=value: p.value(lambda a: _write_value(a, s, v)))
    for name, adjacency in binding.schema.adjacencies.items():
        for entry in state.entries.get(name, []):
            visitor.adjacency(name, lambda a, e=entry, r=adjacency.relation: a.add(lambda x: _fill(x, r, e)))


def _fill(visitor: Visitors.OfEntry, relation: Schemas.OfRelation.Data, entry: Entry) -> None:
    for link, target in entry.links.items():
        visitor.link(link, lambda k, t=target: k.set(t))
    for name, value in entry.properties.items():
        if value is not None:  # absent
            schema = relation.properties[name]
            visitor.property(name, lambda p, s=schema, v=value: p.value(lambda a: _write_value(a, s, v)))


# --- Builders: Visitors over a state ---


class _NativeSlot:
    """`Visitors.OfProperty`, `OfAny` and `OfNative` over a native value in a dict: present only with the schema's type;
    setting checks the type, and clears the others of its exclusive group."""

    def __init__(self, values: dict[str, Any], name: str, schema: Schemas.OfNative.Data, group: Sequence[str] = ()):
        self._values, self._name, self._schema, self._group = values, name, schema, group

    def name(self) -> str:
        return self._name

    def has(self) -> bool:
        return type(self._values.get(self._name)) is self._schema.type

    def get(self) -> Native:
        if not self.has():
            raise AttributeError(f"property {self._name!r} is not set")
        return self._values[self._name]

    def set(self, value: Native) -> _NativeSlot:
        host = self._schema.host()
        if type(value) is not host:
            raise TypeError(f"expected {host.__name__}, got {type(value).__name__}")
        for other in self._group:
            self._values.pop(other, None)
        self._values[self._name] = value
        return self

    def clear(self) -> _NativeSlot:
        self._values.pop(self._name, None)
        return self

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _NativeSlot:
        callback(self)
        return self

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> _NativeSlot:
        callback(self)
        return self

    def _not_native(self, callback: Any) -> _NativeSlot:
        raise TypeError(f"property {self._name!r} is native")

    as_object = as_union = as_intersection = as_indexed = _not_native


class _FixedSlot(_NativeSlot):
    """A fixed property: it always holds the binding's value, and writing another raises."""

    def __init__(self, name: str, schema: Schemas.OfNative.Data, value: Native):
        super().__init__({name: value}, name, schema)
        self._fixed = value

    def set(self, value: Native) -> _FixedSlot:
        host = self._schema.host()
        if type(value) is not host:
            raise TypeError(f"expected {host.__name__}, got {type(value).__name__}")
        if value != self._fixed:
            raise ValueError(f"expected {self._name} {self._fixed!r}, got {value!r}")
        return self

    def clear(self) -> _FixedSlot:
        return self


def _slot(values: dict[str, Any], name: str, schema: Any, group: Sequence[str] = ()) -> Any:
    """The handle of the property `name`: a native's, or a plain writer for any other value."""
    if _native(schema):
        return _NativeSlot(values, name, schema, group)
    return Plain._PropertyWriter(values, name, schema, lambda target: {}, Plain._unlinked)


class _LinkSlot:
    """`Visitors.OfLink` over one link of an entry."""

    def __init__(self, entry: Entry, name: str):
        self._entry, self._name = entry, name

    def name(self) -> str:
        return self._name

    def target(self, callback: Callable[[Visitors.Visitable], Any]) -> _LinkSlot:
        if self._entry.links.get(self._name) is None:
            raise ValueError(f"link {self._name!r} is not set")
        callback(self._entry.links[self._name])
        return self

    def set(self, target: Visitors.Visitable) -> _LinkSlot:
        self._entry.links[self._name] = target
        return self


class _EntrySlot:
    """`Visitors.OfEntry` over one entry of an adjacency, seen from the end that fills `me`."""

    def __init__(self, relation: Schemas.OfRelation.Data, me: str, entry: Entry):
        self._relation, self._me, self._entry = relation, me, entry

    def _others(self) -> list[str]:
        return [name for name in self._relation.links if name != self._me]

    def links(self, callback: Callable[[Visitors.OfLink], Any]) -> _EntrySlot:
        for name in self._others():
            callback(_LinkSlot(self._entry, name))
        return self

    def link(self, name: str, callback: Callable[[Visitors.OfLink], Any]) -> _EntrySlot:
        if name not in self._others():
            raise KeyError(f"{name!r} is not a link this entry can set")
        callback(_LinkSlot(self._entry, name))
        return self

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _EntrySlot:
        for name in self._relation.properties:
            if self.has(name):
                callback(self._slot(name))
        return self

    def has(self, name: str) -> bool:
        return name in self._relation.properties and self._entry.properties.get(name) is not None

    def _slot(self, name: str) -> Any:
        return _slot(self._entry.properties, name, self._relation.properties[name])

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _EntrySlot:
        if name not in self._relation.properties:
            raise KeyError(f"unknown property {name!r}")
        callback(self._slot(name))
        return self

    def clear(self, name: str) -> _EntrySlot:
        self._entry.properties.pop(name, None)
        return self


class _AdjacencySlot:
    """`Visitors.OfAdjacency` over one adjacency of a builder; an implied one keeps no entries."""

    def __init__(self, name: str, adjacency: Schemas.OfAdjacency.Data, entries: list[Entry] | None):
        self._name, self._adjacency, self._entries = name, adjacency, entries

    def name(self) -> str:
        return self._name

    def me(self) -> str:
        return self._adjacency.me

    def _slot(self, entry: Entry) -> _EntrySlot:
        return _EntrySlot(self._adjacency.relation, self._adjacency.me, entry)  # type: ignore[arg-type]

    def entries(self, callback: Callable[[Visitors.OfEntry], Any]) -> _AdjacencySlot:
        for entry in list(self._entries or []):
            callback(self._slot(entry))
        return self

    def add(self, callback: Callable[[Visitors.OfEntry], Any]) -> _AdjacencySlot:
        entry = Entry()
        callback(self._slot(entry))
        if self._entries is not None:
            self._entries.append(entry)
        return self

    def remove(self, entry: Visitors.OfEntry) -> _AdjacencySlot:
        if self._entries is not None and isinstance(entry, _EntrySlot):
            self._entries[:] = [e for e in self._entries if e is not entry._entry]
        return self


class Builder:
    """`Visitors.OfObject` over the state of an instance of `binding`'s class, starting from `instance` if given.
    Finalized by `create()`, `clone()` or `update()`; none validate."""

    def __init__(self, binding: Binding, instance: Any = None):
        self.binding, self._source = binding, instance
        state = State() if instance is None else binding.read(instance)
        state.values = {name: value for name, value in state.values.items() if value is not None}
        self.state = state

    # Finalizing

    def create(self) -> Any:
        if self._source is not None:
            raise ValueError("create() is only valid without a source instance; use clone() or update()")
        return self.binding.make(self.state)

    def clone(self) -> Any:
        if self._source is None:
            raise ValueError("clone() is only valid with a source instance")
        return self.binding.make(self.state)

    def update(self) -> Any:
        if self._source is None:
            raise ValueError("update() is only valid with a source instance")
        return self.binding.assign(self._source, self.state)

    # Visitors.OfObject

    def _field(self, name: str) -> Any:
        schema = self.binding.schema.properties[name]
        if name in self.binding.fixed:
            return _FixedSlot(name, schema, self.binding.fixed[name])
        group = [other for other in self.binding.exclusive.get(name, ()) if other != name]
        return _slot(self.state.values, name, schema, group)

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> Builder:
        for name in self.binding.schema.properties:
            if self.has(name):
                callback(self._field(name))
        return self

    def has(self, name: str) -> bool:
        return name in self.binding.schema.properties and self._field(name).has()

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> Builder:
        if name not in self.binding.schema.properties:
            raise KeyError(f"unknown property {name!r}")
        callback(self._field(name))
        return self

    def clear(self, name: str) -> Builder:
        if name in self.binding.schema.properties:
            self._field(name).clear()
        return self

    def adjacencies(self, callback: Callable[[Visitors.OfAdjacency], Any]) -> Builder:
        for name in self.binding.schema.adjacencies:
            self.adjacency(name, callback)
        return self

    def adjacency(self, name: str, callback: Callable[[Visitors.OfAdjacency], Any]) -> Builder:
        if name not in self.binding.schema.adjacencies:
            raise KeyError(f"unknown adjacency {name!r}")
        entries = None if name in self.binding.implied else self.state.entries.setdefault(name, [])
        callback(_AdjacencySlot(name, self.binding.schema.adjacencies[name], entries))
        return self

    def identify(self, value: Visitors.Visitable) -> Builder:
        """A bound class's instances are reference objects, so there is nothing to identify."""
        return self


# --- The store ---


class OfStore(Stores.Catalog):
    """A store of bound classes: `builders` gives each object schema and the function that makes its builder from an
    optional instance, by name; `relations` names the relations. `store.builder(name, instance)`, or
    `store.<Name>(instance)`, returns a builder. The instance of each singleton schema is made by its builder when the
    store is."""

    def __init__(self, builders: Mapping[str, tuple[Schemas.OfObject.Data, Callable[..., Any]]],
                 relations: Mapping[str, Schemas.OfRelation.Data] | None = None):
        super().__init__()
        self._factories: dict[str, Callable[..., Any]] = {}
        for name, (schema, factory) in builders.items():
            self.register(name, schema)
            self._factories[name] = factory
        for name, relation in (relations or {}).items():
            self.register(name, relation)
        for name, (schema, _) in builders.items():
            if schema.singleton is not None:
                self._singletons[schema.singleton] = self.builder(name).create()

    def builder(self, name: str, instance: Any = None) -> Any:
        self.schema(name)
        return self._factories[name](instance)

    def member(self, instance: Any, name: str) -> Any:
        """The value an instance holds in its property `name`."""
        return getattr(instance, name)

    def __getattr__(self, name: str) -> Callable[..., Any]:
        if name.startswith("_") or name not in self._factories:
            raise AttributeError(name)
        return lambda instance=None: self.builder(name, instance)
