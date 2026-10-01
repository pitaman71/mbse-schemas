"""Comparison: compares values under their schema, as EQUALITY.md defines.

For each schema element `OfX`, `Comparison.OfX` implements `Visitors.OfX` and records the value written into it.
`a.compare(b)` compares two recordings and returns -1, 0 or 1 when `a` is less than, equal to or greater than `b`, and
`None` when they are incomparable. `Comparison.OfNative(schema, value)` and `Comparison.OfObject(schema, instance)`
record a value when constructed; an instance writes itself in through `Visitable.accept`.

- Absent compares equal to absent; absent and present are incomparable. So do values under different schemas.
- `OfNative`: a value must have exactly the schema's native type. `int`, `float`, `str` and `bytes` are ordered:
  strings by code point, bytes lexicographically, floats by value with `-0.0` before `0.0`. NaNs equal each other
  and are incomparable with other floats. Booleans are equal or incomparable.
- `OfObject`: equal when every property its schema declares is absent in both or equal in both; otherwise
  incomparable. A value object compares deeply: its adjacencies participate too, and so do those of the value objects
  it holds; a recorded object's own adjacencies do not.
- `OfProperty` and `OfAny` compare their values; values of different kinds are incomparable.
- `OfUnion`: equal when both hold the same branch with equal values; otherwise incomparable.
- `OfIntersection`: equal when every part is absent in both or equal in both; otherwise incomparable.
- `OfLink`: equal when both link the same object (by identity), or, within two recordings, value objects at the same
  path from their roots (`home`, `reach.phone`); otherwise incomparable.
- `OfEntry`: equal when every link and property is equal; otherwise incomparable.
- `OfAdjacency`: its entries form a set, seen from one object (whose own link is implied), so adding an entry equal
  to one already there is elided. Equal when both hold equal entries; otherwise incomparable.

`Visitors.OfRelation` has no implementation: it declares no way to write
entries into it.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Hashable
from typing import Any

from . import Schemas, Visitors
from .Visitors import Native

__all__ = [
    "Result", "OfAny", "OfNative", "OfProperty", "OfObject", "OfUnion", "OfIntersection", "OfAdjacency", "OfEntry",
    "OfLink",
]

Result = int | None
"""-1, 0 or 1 when ordered or equal; None when incomparable."""


def _sign(a: Any, b: Any) -> int:
    return (a > b) - (a < b)


def _all_equal(results: list[Result]) -> Result:
    """Unordered composites: equal when every part is equal, otherwise incomparable."""
    return 0 if all(result == 0 for result in results) else None


def _natives(a: Native, b: Native) -> Result:
    """Compares two values of the same native type."""
    if isinstance(a, bool):
        return 0 if a == b else None
    if isinstance(a, float):
        assert isinstance(b, float)
        if math.isnan(a) or math.isnan(b):
            return 0 if math.isnan(a) and math.isnan(b) else None
        return _sign((a, math.copysign(1.0, a)), (b, math.copysign(1.0, b)))
    return _sign(a, b)


class OfNative:
    """`Visitors.OfNative` recording one native value, which must have exactly the schema's native type."""

    def __init__(self, schema: Schemas.OfNative.Data, value: Native | None = None):
        self._schema = schema
        self._value: tuple[Native, ...] = ()
        if value is not None:
            self.set(value)

    def has(self) -> bool:
        return bool(self._value)

    def get(self) -> Native:
        if not self._value:
            raise AttributeError("the value is not set")
        return self._value[0]

    def set(self, value: Native) -> OfNative:
        host = self._schema.host()
        if type(value) is not host:
            raise TypeError(f"expected {host.__name__}, got {type(value).__name__}")
        self._value = (value,)
        return self

    def clear(self) -> OfNative:
        self._value = ()
        return self

    def compare(self, other: OfNative) -> Result:
        if not self._value or not other._value:
            return 0 if not self._value and not other._value else None
        if self._schema.type is not other._schema.type:
            return None
        return _natives(self._value[0], other._value[0])


class _Paths:
    """Where the value objects recorded under one root are: the path of property names from the root to each, by
    identity, so that links to them compare by where they are rather than by which object they are."""

    def __init__(self) -> None:
        self.paths: dict[Hashable, tuple[str, ...]] = {}


class OfAny:
    """`Visitors.OfAny` recording a value of the kind its schema declares."""

    def __init__(self, schema: Schemas.OfAny.Data, paths: _Paths | None = None, path: tuple[str, ...] = ()):
        self._schema, self._paths, self._path = schema, paths, path
        self._value: OfNative | OfObject | OfUnion | OfIntersection | None = None

    def _absent(self) -> bool:
        if isinstance(self._value, OfNative):
            return not self._value.has()
        return self._value is None or (isinstance(self._value, (OfUnion, OfIntersection)) and self._value._absent())

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> OfAny:
        if not isinstance(self._schema, Schemas.OfNative.Data):
            raise TypeError("the schema is not a native schema")
        if not isinstance(self._value, OfNative):
            self._value = OfNative(self._schema)
        callback(self._value)
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> OfAny:
        if not isinstance(self._schema, Schemas.OfObject.Data):
            raise TypeError("the schema is not an object schema")
        if not isinstance(self._value, OfObject):
            self._value = OfObject(self._schema, paths=self._paths, path=self._path, value=True)
        callback(self._value)
        return self

    def as_union(self, callback: Callable[[Visitors.OfUnion], Any]) -> OfAny:
        if not isinstance(self._schema, Schemas.OfUnion.Data):
            raise TypeError("the schema is not a union schema")
        if not isinstance(self._value, OfUnion):
            self._value = OfUnion(self._schema, self._paths, self._path)
        callback(self._value)
        return self

    def as_intersection(self, callback: Callable[[Visitors.OfIntersection], Any]) -> OfAny:
        if not isinstance(self._schema, Schemas.OfIntersection.Data):
            raise TypeError("the schema is not an intersection schema")
        if not isinstance(self._value, OfIntersection):
            self._value = OfIntersection(self._schema, self._paths, self._path)
        callback(self._value)
        return self

    def compare(self, other: OfAny) -> Result:
        if self._absent() or other._absent():
            return 0 if self._absent() and other._absent() else None
        if type(self._value) is not type(other._value):
            return None
        return self._value.compare(other._value)  # type: ignore[arg-type, union-attr]


class _Members:
    """A union or intersection value, recorded as the `OfProperty`s of its branches or parts."""

    def __init__(self, schema: Schemas.OfUnion.Data | Schemas.OfIntersection.Data, paths: _Paths | None = None,
                 path: tuple[str, ...] = ()):
        self._schema = schema
        self._properties = _Properties(schema.properties, paths, path)

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> Any:
        self._properties.each(callback)
        return self

    def has(self, name: str) -> bool:
        return self._properties.has(name)

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> Any:
        self._properties.one(name, callback)
        return self

    def clear(self, name: str) -> Any:
        self._properties.clear(name)
        return self

    def _absent(self) -> bool:
        return not any(self._properties.has(name) for name in self._schema.properties)

    def compare(self, other: _Members) -> Result:
        if self._schema is not other._schema:
            return None
        return _all_equal(self._properties.compare(other._properties))


class OfUnion(_Members):
    """`Visitors.OfUnion` recording a union value: the branch it holds, and its value. Writing a branch clears any
    other."""

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> OfUnion:
        if name in self._schema.properties:
            for other in self._schema.properties:
                if other != name:
                    self._properties.clear(other)
        self._properties.one(name, callback)
        return self


class OfIntersection(_Members):
    """`Visitors.OfIntersection` recording an intersection value: its parts, and their values."""


class OfProperty:
    """`Visitors.OfProperty` recording one named property's value."""

    def __init__(self, name: str, schema: Schemas.OfAny.Data, paths: _Paths | None = None, path: tuple[str, ...] = ()):
        self._name, self._schema, self._paths, self._path = name, schema, paths, path
        self._value = OfAny(schema, paths, path)

    def name(self) -> str:
        return self._name

    def has(self) -> bool:
        return not self._value._absent()

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> OfProperty:
        callback(self._value)
        return self

    def clear(self) -> OfProperty:
        self._value = OfAny(self._schema, self._paths, self._path)
        return self

    def compare(self, other: OfProperty) -> Result:
        return self._value.compare(other._value)


class _Properties:
    """Named properties declared by a schema, recorded as `OfProperty`s."""

    def __init__(self, schemas: dict[str, Schemas.OfAny.Data], paths: _Paths | None = None, path: tuple[str, ...] = ()):
        self._schemas, self._paths, self._path = schemas, paths, path
        self._slots: dict[str, OfProperty] = {}

    def each(self, callback: Callable[[Visitors.OfProperty], Any]) -> None:
        for name in self._schemas:
            if self.has(name):
                callback(self._slots[name])

    def has(self, name: str) -> bool:
        return name in self._slots and self._slots[name].has()

    def one(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> None:
        if name not in self._schemas:
            raise KeyError(f"unknown property {name!r}")
        callback(self._slots.setdefault(name, OfProperty(name, self._schemas[name], self._paths, (*self._path, name))))

    def clear(self, name: str) -> None:
        self._slots.pop(name, None)

    def _slot(self, name: str) -> OfProperty:
        """The recorded property, or an absent one if it was never written."""
        return self._slots.get(name) or OfProperty(name, self._schemas[name], self._paths, (*self._path, name))

    def compare(self, other: _Properties) -> list[Result]:
        return [self._slot(name).compare(other._slot(name)) for name in self._schemas]


class OfObject:
    """`Visitors.OfObject` recording an object's properties and adjacency entries. With `instance`, the instance writes
    itself in through `accept`. A value object (`value`) compares its adjacencies too."""

    def __init__(self, schema: Schemas.OfObject.Data, instance: Visitors.Visitable | None = None, *,
                 paths: _Paths | None = None, path: tuple[str, ...] = (), value: bool = False):
        self._schema, self._path, self._value = schema, path, value
        self._paths = _Paths() if paths is None else paths
        self._properties = _Properties(schema.properties, self._paths, path)
        self._adjacencies: dict[str, OfAdjacency] = {}
        if instance is not None:
            instance.accept(self)

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> OfObject:
        self._properties.each(callback)
        return self

    def has(self, name: str) -> bool:
        return self._properties.has(name)

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> OfObject:
        self._properties.one(name, callback)
        return self

    def clear(self, name: str) -> OfObject:
        self._properties.clear(name)
        return self

    def adjacencies(self, callback: Callable[[Visitors.OfAdjacency], Any]) -> OfObject:
        for name in self._schema.adjacencies:
            self.adjacency(name, callback)
        return self

    def adjacency(self, name: str, callback: Callable[[Visitors.OfAdjacency], Any]) -> OfObject:
        if name not in self._schema.adjacencies:
            raise KeyError(f"unknown adjacency {name!r}")
        callback(self._adjacency(name))
        return self

    def _adjacency(self, name: str) -> OfAdjacency:
        return self._adjacencies.setdefault(name, OfAdjacency(name, self._schema.adjacencies[name], self._paths))

    def identify(self, value: Visitors.Visitable) -> OfObject:
        self._paths.paths[value.identity()] = self._path
        return self

    def compare(self, other: OfObject) -> Result:
        if self._schema is not other._schema:
            return None
        results = self._properties.compare(other._properties)
        if self._value:
            results += [self._adjacency(name).compare(other._adjacency(name)) for name in self._schema.adjacencies]
        return _all_equal(results)


class OfAdjacency:
    """`Visitors.OfAdjacency` recording the entries of one relation seen from one object. Adding an entry equal to one
    already recorded is elided."""

    def __init__(self, name: str, schema: Schemas.OfAdjacency.Data, paths: _Paths | None = None):
        self._name, self._schema, self._paths = name, schema, paths
        self._entries: list[OfEntry] = []

    def name(self) -> str:
        return self._name

    def me(self) -> str:
        return self._schema.me

    def entries(self, callback: Callable[[Visitors.OfEntry], Any]) -> OfAdjacency:
        for entry in list(self._entries):
            callback(entry)
        return self

    def add(self, callback: Callable[[Visitors.OfEntry], Any]) -> OfAdjacency:
        entry = OfEntry(self._schema.relation, self._schema.me, self._paths)
        callback(entry)
        if not any(entry.compare(existing) == 0 for existing in self._entries):
            self._entries.append(entry)
        return self

    def remove(self, entry: Visitors.OfEntry) -> OfAdjacency:
        self._entries = [e for e in self._entries if e is not entry]
        return self

    def compare(self, other: OfAdjacency) -> Result:
        if self._schema.relation is not other._schema.relation or self._schema.me != other._schema.me:
            return None
        if len(self._entries) != len(other._entries):
            return None
        return _all_equal([0 if any(e.compare(o) == 0 for o in other._entries) else None for e in self._entries])


class OfEntry:
    """`Visitors.OfEntry` recording one relation entry's links and properties. The link named `me`, if any, is the
    owning object's own link: it is implied and cannot be set."""

    def __init__(self, relation: Schemas.OfRelation.Data, me: str | None = None, paths: _Paths | None = None):
        self._relation, self._me, self._paths = relation, me, paths
        self._links: dict[str, OfLink] = {}
        self._properties = _Properties(relation.properties)

    def _names(self) -> list[str]:
        return [name for name in self._relation.links if name != self._me]

    def links(self, callback: Callable[[Visitors.OfLink], Any]) -> OfEntry:
        for name in self._names():
            self.link(name, callback)
        return self

    def link(self, name: str, callback: Callable[[Visitors.OfLink], Any]) -> OfEntry:
        if name not in self._names():
            raise KeyError(f"{name!r} is not a link this entry can set")
        callback(self._links.setdefault(name, OfLink(name, self._paths)))
        return self

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> OfEntry:
        self._properties.each(callback)
        return self

    def has(self, name: str) -> bool:
        return self._properties.has(name)

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> OfEntry:
        self._properties.one(name, callback)
        return self

    def clear(self, name: str) -> OfEntry:
        self._properties.clear(name)
        return self

    def compare(self, other: OfEntry) -> Result:
        if self._relation is not other._relation or self._me != other._me:
            return None
        links = [self._links.get(n, OfLink(n, self._paths)).compare(other._links.get(n, OfLink(n, self._paths))) for n in self._names()]
        return _all_equal(links + self._properties.compare(other._properties))


class OfLink:
    """`Visitors.OfLink` recording the object one link targets."""

    def __init__(self, name: str, paths: _Paths | None = None):
        self._name, self._paths = name, paths
        self._target: tuple[Visitors.Visitable, ...] = ()

    def name(self) -> str:
        return self._name

    def target(self, callback: Callable[[Visitors.Visitable], Any]) -> OfLink:
        if not self._target:
            raise ValueError(f"link {self._name!r} is not set")
        callback(self._target[0])
        return self

    def set(self, target: Visitors.Visitable) -> OfLink:
        self._target = (target,)
        return self

    def _where(self) -> tuple[str, ...] | None:
        """The path to the linked value object within its recording, if it is one recorded there."""
        return None if self._paths is None else self._paths.paths.get(self._target[0].identity())

    def compare(self, other: OfLink) -> Result:
        if not self._target or not other._target:
            return 0 if not self._target and not other._target else None
        mine, theirs = self._where(), other._where()
        if mine is not None or theirs is not None:
            return 0 if mine == theirs else None
        return 0 if self._target[0].identity() == other._target[0].identity() else None
