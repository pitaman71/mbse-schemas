"""Paths: names for the objects a store holds, which survive changes elsewhere in it.

`Paths.of(store)` names every object the store's roots reach. A schema of a store of schemas (`Reflection.of`) is
named by its name, and a singleton by its global name; any other object by the first route that reaches it from them,
in order: the schemas in name order, then the singletons in global-name order, then breadth first through each
object's entries, adjacency by adjacency in its schema's order, each adjacency's entries in order. A route's step is
`/adjacency[key]`: an entry's key is the property values that a unique constraint of its relation declares with the
object's own link (`phones[label="home"]`), else its position among the adjacency's entries (`items[0]`). An entry of
a relation of more than two links names the link it follows (`/enrolled[0].course`). A key writes a string as JSON
does, an integer in decimal and a boolean as `true` or `false`; a value of any other type makes the key positional.

A path names the same object after a change that does not touch the route to it: a property set, or an object added
elsewhere. Renaming a schema or a singleton, or inserting an entry before a positional one, changes the paths under it.

`paths.of(value)` gives an object's path (`LookupError` for one no root reaches), and `paths.find(path)` the object at a
path (`LookupError` for none).
"""

from __future__ import annotations

import json
from typing import Any

from . import Reflection, Stores, Validators, Visitors

__all__ = ["Paths", "of"]


def _schemas(store: Any) -> list[Any]:
    """The schemas a store of schemas holds, or those of the stores a combined store combines."""
    if isinstance(store, Reflection.OfStore):
        return list(store.schemas)
    if isinstance(store, Stores.Combined):
        return [schema for part in store.stores for schema in _schemas(part)]
    return []


def _text(value: Any) -> str | None:
    """A key's value as a path writes it, or None for a type a path does not write."""
    if type(value) is str:
        return json.dumps(value, ensure_ascii=False)
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is int:
        return str(value)
    return None


def _key(relation: Any, me: str, values: dict[str, Any], position: int) -> str:
    """An entry's key: the values of the first unique constraint, in name order, that holds the object's own link and
    otherwise only properties the entry has, of types a path writes; else its position."""
    for unique in sorted(sorted(u) for u in relation.uniques):
        rest = [name for name in unique if name != me]
        texts = [_text(values.get(name)) for name in rest]
        if me in unique and rest and all(name in relation.properties for name in rest) and None not in texts:
            return ",".join(f"{name}={text}" for name, text in zip(rest, texts))
    return str(position)


class Paths:
    """The paths of the objects a store's roots reach (see the module's documentation)."""

    def __init__(self, store: Any):
        self._paths: dict[Any, str] = {}
        self._objects: dict[str, Visitors.Visitable] = {}
        pending: list[tuple[Visitors.Visitable, str]] = [(schema, schema.name) for schema in sorted(
            _schemas(store), key=lambda schema: schema.name)]
        pending += sorted(((root, name) for name, root in Stores._roots(store).items()), key=lambda pair: pair[1])
        while pending:
            value, path = pending.pop(0)
            if value.identity() in self._paths:
                continue
            self._paths[value.identity()] = path
            self._objects.setdefault(path, value)
            pending += self._routes(store, value, path)

    def _routes(self, store: Any, value: Visitors.Visitable, path: str) -> list[tuple[Visitors.Visitable, str]]:
        """The objects `value`'s entries link, each with its path through them, in order."""
        found: list[tuple[Visitors.Visitable, str]] = []
        entries = Validators.entries_of(value)
        if not entries:
            return found
        schema = store.schema(value.schema_name())
        for name, listed in entries.items():
            adjacency = schema.adjacencies[name]
            others = [link for link in adjacency.relation.links if link != adjacency.me]
            for position, entry in enumerate(listed):
                key = _key(adjacency.relation, adjacency.me, entry.values, position)
                for link in others:  # every link of an entry is set
                    suffix = f".{link}" if len(others) > 1 else ""
                    found.append((entry.targets[link], f"{path}/{name}[{key}]{suffix}"))
        return found

    def of(self, value: Visitors.Visitable) -> str:
        """The path of `value`."""
        path = self._paths.get(value.identity())
        if path is None:
            raise LookupError("no root reaches the object")
        return path

    def find(self, path: str) -> Visitors.Visitable:
        """The object at `path`."""
        if path not in self._objects:
            raise LookupError(f"no object at {path!r}")
        return self._objects[path]


def of(store: Any) -> Paths:
    """The paths of the objects `store`'s roots reach."""
    return Paths(store)
