"""Reachable: finds every object reachable from a root through adjacencies.

`Reachable.of(root)` returns the root and every object reachable from it, in the order each is first referenced.
The collector is a visitor: each object writes itself into it through `Visitable.accept`, and the collector records
the targets of the links it is given. It needs no schema: property values are ignored.
"""

from __future__ import annotations

from collections.abc import Callable, Hashable
from typing import Any

from . import Visitors
from .Visitors import Native

__all__ = ["of"]

_Found = Callable[[Visitors.Visitable], None]


class _Ignored:
    """`Visitors.OfNative` / `OfAny` / `OfProperty` that discards property values."""

    def __init__(self, name: str = ""):
        self._name = name

    def name(self) -> str:
        return self._name

    def has(self) -> bool:
        return False

    def get(self) -> Native:
        raise AttributeError("reachability does not record property values")

    def set(self, value: Native) -> _Ignored:
        return self

    def clear(self) -> _Ignored:
        return self

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _Ignored:
        callback(self)
        return self

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> _Ignored:
        callback(self)
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> _Ignored:
        return self

    def as_union(self, callback: Callable[[Visitors.OfUnion], Any]) -> _Ignored:
        return self

    def as_intersection(self, callback: Callable[[Visitors.OfIntersection], Any]) -> _Ignored:
        return self


class _Link:
    """`Visitors.OfLink` that reports its target."""

    def __init__(self, name: str, found: _Found):
        self._name, self._found = name, found

    def name(self) -> str:
        return self._name

    def target(self, callback: Callable[[Visitors.Visitable], Any]) -> _Link:
        raise NotImplementedError("the reachability collector does not read link targets back")

    def set(self, target: Visitors.Visitable) -> _Link:
        self._found(target)
        return self


class _Entry:
    """`Visitors.OfEntry` that reports the targets of its links."""

    def __init__(self, found: _Found):
        self._found = found

    def links(self, callback: Callable[[Visitors.OfLink], Any]) -> _Entry:
        return self

    def link(self, name: str, callback: Callable[[Visitors.OfLink], Any]) -> _Entry:
        callback(_Link(name, self._found))
        return self

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _Entry:
        return self

    def has(self, name: str) -> bool:
        return False

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _Entry:
        callback(_Ignored(name))
        return self

    def clear(self, name: str) -> _Entry:
        return self


class _Adjacency:
    """`Visitors.OfAdjacency` that reports the targets of the entries added to it."""

    def __init__(self, name: str, found: _Found):
        self._name, self._found = name, found

    def name(self) -> str:
        return self._name

    def me(self) -> str:
        raise NotImplementedError("the reachability collector is schema-agnostic")

    def entries(self, callback: Callable[[Visitors.OfEntry], Any]) -> _Adjacency:
        return self

    def add(self, callback: Callable[[Visitors.OfEntry], Any]) -> _Adjacency:
        callback(_Entry(self._found))
        return self

    def remove(self, entry: Visitors.OfEntry) -> _Adjacency:
        return self


class _Collector:
    """`Visitors.OfObject` that reports every object linked from the object written into it."""

    def __init__(self, found: _Found):
        self._found = found

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _Collector:
        return self

    def has(self, name: str) -> bool:
        return False

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _Collector:
        callback(_Ignored(name))
        return self

    def clear(self, name: str) -> _Collector:
        return self

    def adjacencies(self, callback: Callable[[Visitors.OfAdjacency], Any]) -> _Collector:
        return self

    def adjacency(self, name: str, callback: Callable[[Visitors.OfAdjacency], Any]) -> _Collector:
        callback(_Adjacency(name, self._found))
        return self


def of(root: Visitors.Visitable) -> list[Visitors.Visitable]:
    """The root and every object reachable from it through adjacencies, in first-reference order."""
    seen: dict[Hashable, Visitors.Visitable] = {root.identity(): root}
    queue = [root]

    def found(target: Visitors.Visitable) -> None:
        if target.identity() not in seen:
            seen[target.identity()] = target
            queue.append(target)

    while queue:
        queue.pop(0).accept(_Collector(found))
    return list(seen.values())
