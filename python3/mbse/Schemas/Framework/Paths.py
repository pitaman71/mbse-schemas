"""Paths: an object's identity, the route from a singleton to it through the relations that own it
(docs/OBJECT_IDENTITY.md).

A path is a nested value object, never a string: `Paths.OfRoot` names the singleton it starts from and holds the next
element, `Paths.OfEntry` one ownership entry transited (`i`, the adjacency to it from the object before; `o`, the
adjacency to it from the object after, the one marked `owner()`; `properties`, the entry's keys), and `Paths.OfTarget`
ends it. `next` is a union of the two, its branches `entry` and `target`. Every store holds these schemas, its own.

An identity is computed on demand (Decided, 32): `of(obj)` reads an object's path off its ownership entries.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from . import Proxies
from .Builders import AnyValueBuilder, ContainerBuilder, ObjectBuilder, UnionBuilder

__all__ = ["schemas", "of"]


def schemas(Text: Any, Int: Any, Bool: Any) -> SimpleNamespace:
    """The path schemas, built anew for a store whose basic scalars `Text`, `Int` and `Bool` they use: each store holds
    its own. A key's value is one of those three, written bare."""
    Next = UnionBuilder().name("Paths.Next").create()  # its branches follow: they refer to it
    OfTarget = ObjectBuilder().name("Paths.OfTarget").create()
    keys = ContainerBuilder().index([Text]).element([AnyValueBuilder().schemas([Bool, Int, Text]).create()]).create()
    OfEntry = ObjectBuilder().name("Paths.OfEntry").properties([
        lambda t: t.name("i").schema([Text]),
        lambda t: t.name("o").schema([Text]),
        lambda t: t.name("properties").schema([keys]),
        lambda t: t.name("next").schema([Next]),
    ]).create()
    OfRoot = ObjectBuilder().name("Paths.OfRoot").properties([
        lambda t: t.name("singleton").schema([Text]),
        lambda t: t.name("next").schema([Next]),
    ]).create()
    UnionBuilder(Next).branches([
        lambda t: t.name("entry").schema([OfEntry]),
        lambda t: t.name("target").schema([OfTarget]),
    ]).update()
    return SimpleNamespace(OfRoot=OfRoot, OfEntry=OfEntry, OfTarget=OfTarget, Next=Next)


def _owned_by(obj: Any) -> tuple[Any, Any, Any]:
    """The entry that owns a proxy, through the adjacency of its schema marked `owner()`: the adjacency, the entry and
    the owner. `LookupError` where it has none, or more than one."""
    schema = object.__getattribute__(obj, "_schema")
    found = [(adjacency, entry) for adjacency in (*schema.adjacencies.values(), *schema.anonymous) if adjacency.owner
             for entry in Proxies._linking(adjacency.relation, adjacency.me, obj)]
    name = object.__getattribute__(obj, "_schema_name")
    if len(found) != 1:
        raise LookupError(f"a {name!r} has {'no owner' if not found else 'more than one owner'}: its path is not known")
    adjacency, entry = found[0]
    owner = next(target for link, target in entry._links.items() if link != adjacency.me)
    return adjacency, entry, owner


def of(obj: Any) -> Any:
    """The path of a reference object, read off its ownership entries back to a singleton: a `Paths.OfRoot` value,
    standalone, of the object's store."""
    store, steps, current, seen = Proxies.store_of(obj), [], obj, set()
    while object.__getattribute__(current, "_schema").singleton is None:
        if id(current) in seen:
            raise LookupError("an ownership cycle: no singleton owns the object")
        seen.add(id(current))
        adjacency, entry, owner = _owned_by(current)
        owner_link = next(link for link in entry._links if link != adjacency.me)
        owner_schema = object.__getattribute__(owner, "_schema")
        i = next((name for name, held in owner_schema.adjacencies.items()
                  if held.relation is adjacency.relation and held.me == owner_link), "")
        steps.append((i, adjacency.name, dict(entry._properties)))
        current = owner
    singleton = object.__getattribute__(current, "_schema").singleton

    def step(rest: list[tuple[str, str, dict[str, Any]]]) -> Any:
        if not rest:
            return lambda n: n.target(lambda t: t)
        i, o, keys = rest[0]
        return lambda n: n.entry(lambda e: e.i(i).o(o).properties(keys).next(step(rest[1:])))

    return store.Paths.OfRoot(lambda r: r.singleton(singleton).next(step(steps[::-1])))
