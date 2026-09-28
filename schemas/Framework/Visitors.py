"""Visitors: schema-agnostic handles for traversing, analyzing, and modifying data.

For each schema element `OfX`, `Visitors.OfX` is a handle positioned at a value of that kind. A handle can read the
value, visit its parts, and modify it. Handles are obtained through `Factories`, never instantiated directly by client
code. Builders and serializers implement these protocols; proxies do not (a proxy would be `Visitable`).

Child handles (properties, adjacencies, entries, links, kind-specific values) are never returned: they are passed to a
callback. Every method that is not a query returns `self`, so calls chain.

The value builders used in the DSL are handles: in `.street1(lambda v: v.set('foo'))`, `v` is a `Visitors.OfNative`.
"""

from __future__ import annotations

from collections.abc import Callable, Hashable
from typing import Any, Protocol

__all__ = [
    "Native",
    "OfAny",
    "OfNative",
    "OfProperty",
    "OfObject",
    "OfAdjacency",
    "OfEntry",
    "OfLink",
    "OfRelation",
    "OfUnion",
    "OfIntersection",
    "Visitable",
]

Native = int | float | str | bool | bytes


class OfAny(Protocol):
    """A value of any kind.

    Each `as_<kind>` method passes the visitor for that kind to its callback. When reading, only the callback matching
    the value's actual kind is called, so chaining several `as_<kind>` calls dispatches on kind. When writing, the call
    selects the kind.
    """

    def as_native(self, callback: Callable[[OfNative], Any]) -> OfAny: ...

    def as_object(self, callback: Callable[[OfObject], Any]) -> OfAny: ...

    def as_union(self, callback: Callable[[OfUnion], Any]) -> OfAny: ...

    def as_intersection(self, callback: Callable[[OfIntersection], Any]) -> OfAny: ...


class OfNative(Protocol):
    """A native value. Reading an absent value raises."""

    def has(self) -> bool: ...

    def get(self) -> Native: ...

    def set(self, value: Native) -> OfNative: ...

    def clear(self) -> OfNative: ...


class OfProperty(Protocol):
    """One named property of an object or entry. Reading the value of an absent property raises."""

    def name(self) -> str: ...

    def has(self) -> bool: ...

    def value(self, callback: Callable[[OfAny], Any]) -> OfProperty: ...

    def clear(self) -> OfProperty: ...


class OfObject(Protocol):
    """An object: named properties plus adjacencies to relations."""

    def properties(self, callback: Callable[[OfProperty], Any]) -> OfObject:
        """Calls `callback` once for each property that is present."""
        ...

    def has(self, name: str) -> bool: ...

    def property(self, name: str, callback: Callable[[OfProperty], Any]) -> OfObject:
        """Calls `callback` with the named property, present or not."""
        ...

    def clear(self, name: str) -> OfObject: ...

    def adjacencies(self, callback: Callable[[OfAdjacency], Any]) -> OfObject:
        """Calls `callback` once for each adjacency declared by the object's schema."""
        ...

    def adjacency(self, name: str, callback: Callable[[OfAdjacency], Any]) -> OfObject: ...


class OfAdjacency(Protocol):
    """The entries of one relation seen from one object, which fills its own link (`me`)."""

    def name(self) -> str:
        """Name of the adjacency on the object, e.g. 'addresses'."""
        ...

    def me(self) -> str:
        """Name of the link this object fills."""
        ...

    def entries(self, callback: Callable[[OfEntry], Any]) -> OfAdjacency: ...

    def add(self, callback: Callable[[OfEntry], Any]) -> OfAdjacency:
        """Adds a new entry with this object's own link already filled, after `callback` fills in the rest.
        Adding an entry equal to an existing one is elided."""
        ...

    def remove(self, entry: OfEntry) -> OfAdjacency: ...


class OfEntry(Protocol):
    """One relation entry: its links and properties."""

    def links(self, callback: Callable[[OfLink], Any]) -> OfEntry: ...

    def link(self, name: str, callback: Callable[[OfLink], Any]) -> OfEntry: ...

    def properties(self, callback: Callable[[OfProperty], Any]) -> OfEntry:
        """Calls `callback` once for each property that is present."""
        ...

    def has(self, name: str) -> bool: ...

    def property(self, name: str, callback: Callable[[OfProperty], Any]) -> OfEntry:
        """Calls `callback` with the named property, present or not."""
        ...

    def clear(self, name: str) -> OfEntry: ...


class OfLink(Protocol):
    """One named link of an entry."""

    def name(self) -> str: ...

    def target(self, callback: Callable[[Visitable], Any]) -> OfLink:
        """Calls `callback` with the linked object."""
        ...

    def set(self, target: Visitable) -> OfLink: ...


class OfRelation(Protocol):
    """All entries of a relation. Internal to implementations; no relation builder is exposed to callers."""

    def links(self, callback: Callable[[str], Any]) -> OfRelation:
        """Calls `callback` once with each link name."""
        ...

    def entries(self, callback: Callable[[OfEntry], Any]) -> OfRelation: ...


class OfUnion(Protocol):
    """A value of one of several same-kind schemas, chosen by the first matching discriminator predicate."""

    def branch(self) -> int:
        """Index of the branch the value belongs to."""
        ...

    def value(self, callback: Callable[[OfAny], Any]) -> OfUnion: ...


class OfIntersection(Protocol):
    """A value satisfying several same-kind schemas at once."""

    def value(self, callback: Callable[[OfAny], Any]) -> OfIntersection: ...


class Visitable(Protocol):
    """An in-memory object that can be visited, e.g. a proxy. It is not a visitor itself."""

    def identity(self) -> Hashable:
        """In-memory identity, stable for the object's lifetime. Serializers map it 1:1 to a transaction symbol."""
        ...

    def schema_name(self) -> str:
        """Registered name of the object's schema, carried by serialized references to this object."""
        ...

    def accept(self, visitor: OfObject) -> None:
        """Writes this object's properties and adjacency entries into `visitor`."""
        ...
