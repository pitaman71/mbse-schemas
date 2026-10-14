"""Reachable: finds every object reachable from a root through adjacencies.

`Reachable.of(root)` returns the root and every reference object reachable from it, in the order each is first
referenced. It reads through the visitor protocol (`Readers.OfObject`): each object's adjacencies, in its schema's
order, their entries, in order, and each entry's links other than the object's own, in the relation's order. A value
object has no adjacencies, and no entry links one, so values are not followed.
"""

from __future__ import annotations

from typing import Any

from . import Readers

__all__ = ["of"]


def of(root: Readers.OfObject) -> list[Readers.OfObject]:
    """The root and every reference object reachable from it through adjacencies, in first-reference order."""
    seen: dict[int, Readers.OfObject] = {id(root): root}  # an identity is unique within its schema only
    queue = [root]

    def adjacency(read: Readers.OfAdjacency) -> Readers.OfAdjacency:
        me = read.as_schema().me
        for entry in read:
            for link in entry.as_schema().links:
                if link != me:
                    found(getattr(entry, link))
        return read

    def found(target: Any) -> None:
        if id(target) not in seen:
            seen[id(target)] = target
            queue.append(target)

    while queue:
        queue.pop(0).as_adjacencies(adjacency)
    return list(seen.values())
