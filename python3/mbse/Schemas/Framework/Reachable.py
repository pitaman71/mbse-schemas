"""Reachable: finds every object reachable from a root through adjacencies.

`Reachable.of(root)` returns the root and every reference object reachable from it, in the order each is first
referenced. It reads through the visitor protocol (`Readers.OfObject`): each object's adjacencies, in its schema's
order, their entries, in order, and each entry's links other than the object's own, in the relation's order. A value
object's adjacencies are to one-link relations, whose entries link nothing else, so values are not followed.
"""

from __future__ import annotations

from typing import Any

from . import Readers

__all__ = ["of"]


def of(root: Readers.OfObject) -> list[Readers.OfObject]:
    """The root and every reference object reachable from it through adjacencies, in first-reference order."""
    seen: dict[str, Readers.OfObject] = {root.as_identity(): root}
    queue = [root]

    def adjacency(read: Readers.OfAdjacency) -> Readers.OfAdjacency:
        me = read.as_schema().me
        for entry in read:
            for link in entry.as_schema().links:
                if link != me:
                    found(getattr(entry, link))
        return read

    def found(target: Any) -> None:
        if target.as_identity() not in seen:
            seen[target.as_identity()] = target
            queue.append(target)

    while queue:
        queue.pop(0).as_adjacencies(adjacency)
    return list(seen.values())
