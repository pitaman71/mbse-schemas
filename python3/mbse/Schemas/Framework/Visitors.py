"""Visitors: the one protocol per kind through which code reads and writes a value, knowing its schema or not.

`Visitors.OfX` reads and writes a value of kind X. Data instances (`Proxies.OfX.Data`) and builders
(`Proxies.OfX.Builder`) implement it: whether a write takes effect is the visitor's mode. Data instances visit
read-only; builders are writable unless made read-only. A child visitor has its parent's mode, and a value object is
writable only under a builder that is constructing or cloning it. Code that must not write takes the read-only view of
the same protocol, `Readers.OfX`.

Members. An object's properties and adjacencies, an entry's links and properties, a union's branches, an
intersection's parts and a match's symbols are members named after them. Read, a member is the child visitor
(`card.name`, a `Visitors.OfProperty`); called with a `Specs.Callback`, it writes or visits through it
(`b.name("Ada")`, `b.phones(lambda a: a.insert(lambda e: e.phone(p)))`) and returns the visitor it is a member of.
The methods of `Visitors.OfObject` and `Visitors.OfEntry` are named `as_*`, a prefix no schema-defined name may take;
every protocol has `as_schema()`, the schema it visits.

Reads never raise. Every callback is called: a visitor handed over for an absent value, for a value of another kind,
or for a member the schema lacks, reads as empty (`get()` None, nothing to iterate). The one raise is a write that the
visitor's mode, or the value, forbids: `Errors.ReadOnlyError`. A write that loses nothing does not raise: inserting an
entry equal to one a set relation holds elides it, and removing where no entry agrees removes nothing. A member is
written by calling it, never by assignment: assigning to any visitor's member raises `AttributeError`.

Scalars read compactly through dunders (`int`, `float`, `str`, `bool`, `bytes`), sugar over `get()`, on
`Visitors.OfScalar` and, passing through `as_scalar`, on `Visitors.OfProperty` (`str(card.name)`). Each raises when
the value is not set or is not of its scalar. The same visitors compare and order as their values do
(`card.name == "Ada"`, `card.age < 40`), a value of another kind by its identity; a read-only one hashes as its
value, and a writable one is unhashable.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator, Mapping
from typing import TYPE_CHECKING, Any, Generic, Protocol, Self, TypeVar

from .Specs import Callback

if TYPE_CHECKING:
    from . import Schemas

__all__ = [
    "Scalar",
    "OfScalar",
    "OfAny",
    "OfProperty",
    "OfObject",
    "OfAdjacency",
    "OfEntry",
    "OfUnion",
    "OfIntersection",
    "OfContainer",
    "OfIterator",
    "OfPredicate",
]

Scalar = int | float | str | bool | bytes

T = TypeVar("T", int, float, str, bool, bytes)


class _Dunders(Protocol):
    """Sugar over a scalar's `get()`, each raising when the value is not set or not of its scalar."""

    def __int__(self) -> int: ...

    def __float__(self) -> float: ...

    def __str__(self) -> str: ...

    def __bool__(self) -> bool: ...

    def __bytes__(self) -> bytes: ...


class OfScalar(_Dunders, Protocol, Generic[T]):
    """A scalar value."""

    def as_schema(self) -> Schemas.OfScalar.Data: ...

    def get(self) -> T | None:
        """The value, or None when it is not set."""
        ...

    def set(self, value: T) -> None: ...

    def clear(self) -> None:
        """An alias of `Visitors.OfAny.clear`."""
        ...


class OfAny(Protocol):
    """A value of any kind. Each `as_<kind>` hands over that kind's visitor: reading a value of another kind, an empty
    one; writing, it selects the kind."""

    def as_schema(self) -> Schemas.OfAny.Data: ...

    def as_scalar(self, cb: Callback[OfScalar[Any]]) -> Self: ...

    def as_object(self, cb: Callback[OfObject]) -> Self: ...

    def as_union(self, cb: Callback[OfUnion]) -> Self: ...

    def as_intersection(self, cb: Callback[OfIntersection]) -> Self: ...

    def as_container(self, cb: Callback[OfContainer]) -> Self: ...

    def clear(self) -> None: ...


class OfProperty(_Dunders, Protocol):
    """One property of an object or an entry. Called, as a member, with a `Specs.Callback[Visitors.OfProperty]`."""

    def as_schema(self) -> Schemas.OfProperty.Data: ...

    def as_value(self, cb: Callback[OfAny]) -> Self: ...

    def as_scalar(self, cb: Callback[OfScalar[Any]]) -> Self:
        """Shorthand: `as_value`, then `Visitors.OfAny.as_scalar`."""
        ...

    def as_object(self, cb: Callback[OfObject]) -> Self:
        """Shorthand, for conciseness: `as_value`, then `Visitors.OfAny.as_object`."""
        ...

    def get(self) -> Scalar | None:
        """The scalar value, or None when it is not set or not a scalar: a pass-through to `as_scalar`, as the
        dunders are."""
        ...

    def __call__(self, spec: Callback[OfProperty]) -> Any: ...


class OfObject(Protocol):
    """An object: its properties and its adjacencies are members (`osv.<propName>`, a `Visitors.OfProperty`;
    `osv.<adjName>`, a `Visitors.OfAdjacency`)."""

    def as_schema(self) -> Schemas.OfObject.Data: ...

    def as_identity(self, identity: str | None = None) -> Any:
        """Read (no argument), the object's identity in its store, unqualified: its global name, a name its naming
        pattern gives, a UUID, or one written; None for a value object, or an object not created yet that none was
        written for. Written (in a builder), the identity the object takes: its store gives one only where none is set
        by the object it updates or by this. A data instance refuses a write."""
        ...

    @property
    def as_properties(self) -> _Properties:
        """The properties present, schema unaware: iterated, or called with a callback for each."""
        ...

    def as_adjacencies(self, cb: Callback[OfAdjacency]) -> Self:
        """Each adjacency, schema unaware; an adjacency is edited through what this hands over."""
        ...

    def __getattr__(self, name: str) -> Any:
        """A property or an adjacency, by name."""
        ...


class _Properties(Iterable[OfProperty], Protocol):
    """`Visitors.OfObject.as_properties`: an iterable of the properties present, and callable with a callback for
    each."""

    def __iter__(self) -> Iterator[OfProperty]: ...

    def __call__(self, cb: Callback[OfProperty]) -> OfObject: ...


class OfAdjacency(Iterable["OfEntry"], Protocol):
    """The entries of one relation seen from one object, which fills its own link; iterated, its entries."""

    def as_schema(self) -> Schemas.OfAdjacency.Data: ...

    def __iter__(self) -> Iterator[OfEntry]: ...

    def as_iterable(self, cb: Callback[Iterator[OfEntry]]) -> Self:
        """Calls `cb` with an iterator over the entries, in order, for every relation."""
        ...

    def insert(self, spec: Callback[OfEntry]) -> Self:
        """Adds an entry, the object's own link filled; an equal entry in a set is elided."""
        ...

    def remove(self, spec: Callback[OfEntry]) -> Self:
        """Removes every entry that agrees with `spec`."""
        ...

    def __call__(self, spec: Callback[OfAdjacency]) -> Any: ...


class OfEntry(Protocol):
    """One entry of a relation: its links are members (`env.<linkName>`, a `Visitors.OfObject`), and so are its
    properties (`env.<propName>`, a `Visitors.OfProperty`). Its properties are walked, schema unaware, through its
    schema."""

    def as_schema(self) -> Schemas.OfEntry.Data: ...

    def __getattr__(self, name: str) -> Any:
        """A link or a property, by name."""
        ...


class OfContainer(Protocol):
    """A container: elements by index, entries latent. An index is a scalar, or a tuple of a value object index's
    properties in declaration order; an element is read and written through its `Visitors.OfAny`."""

    def as_schema(self) -> Schemas.OfContainer.Data: ...

    def __len__(self) -> int:
        """The positions of a dense container of int indices (every index up to the last), else the elements present."""
        ...

    def at(self, index: Any) -> OfAny:
        """The element at `index`, empty where there is none; writable in a builder, where writing adds it."""
        ...

    def remove(self, index: Any) -> Self: ...

    def as_ordered(self, cb: Callable[[OfIterator], Any]) -> Self:
        """An iterator over the positions of a dense or sparse container; `cb` is not called for another."""
        ...

    def as_dict(self, cb: Callable[[Mapping[Any, OfAny]], Any]) -> Self:
        """The elements by index of a container arranged as a dict; `cb` is not called for another."""
        ...

    def as_entries(self, cb: Callable[[Iterator[tuple[Any, OfAny]]], Any]) -> Self:
        """Each element present with its index, in order, for every container."""
        ...


class OfIterator(Protocol):
    """A position in a dense or sparse container: at a position, before the first, or past the last."""

    def first(self) -> Self: ...

    def last(self) -> Self: ...

    def next(self) -> Self: ...

    def prev(self) -> Self: ...

    def index(self) -> Any:
        """The index at the position; None before the first or past the last."""
        ...

    def as_item(self, cb: Callback[OfAny]) -> Self:
        """The element at the position. Past an end, `cb` is not called for a read-only container, and a writable one
        is extended there."""
        ...

    def prepend(self, spec: Callback[OfAny]) -> Self:
        """Inserts an element before the position, which then rests on it; only where the indices are ints."""
        ...

    def append(self, spec: Callback[OfAny]) -> Self:
        """Inserts an element after the position, which then rests on it; only where the indices are ints."""
        ...


class OfUnion(Protocol):
    """A union value: its branches are members, each the visitor of its schema's kind (`shape.circle`); a branch it does
    not hold reads as empty, and writing one branch clears the others."""

    def as_schema(self) -> Schemas.OfUnion.Data: ...

    def __getattr__(self, name: str) -> Any: ...


class OfIntersection(Protocol):
    """An intersection value: its parts are members, each the visitor of its schema's kind (`ticket.stamp`)."""

    def as_schema(self) -> Schemas.OfIntersection.Data: ...

    def __getattr__(self, name: str) -> Any: ...


class OfPredicate(Protocol):
    """A match of a predicate: its symbols are members, each a `Visitors.OfObject`, in the match's mode. Finding
    matches is mbse-patterns'."""

    def as_schema(self) -> Schemas.OfPredicate.Data: ...

    def __getattr__(self, name: str) -> Any: ...
