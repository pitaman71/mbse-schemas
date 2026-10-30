"""Paths: an owned object's identity, the route from a singleton to it through the relations that own it
([FEA-026: deterministic object identity](../../../../../mbse-basis/docs/features/FEA-026.md)).

A path is a nested value object, never a string: `Paths.OfRoot` names the singleton it starts from and holds the next
element, `Paths.OfEntry` one ownership entry transited (`i`, the adjacency to it from the object before; `o`, the
adjacency to it from the object after, the one marked `owner()`; `properties`, the entry's keys), and `Paths.OfTarget`
ends it. `next` is a union of the two, its branches `entry` and `target`. Every store holds these schemas, its own.

An identity is computed on demand (object identity 32 in [CAP-119: owned objects found by path](../../../../../mbse-basis/docs/capabilities/CAP-119.md#decided)): `of(obj)` reads an object's path off its ownership entries. A schema
object's path starts from the root module, the singleton `"."`, and goes through each module, then the schema, by name,
then each member by the keyed adjacency that owns it and its name (object identity 80 and 81 in [CAP-123: schema objects identified by path](../../../../../mbse-basis/docs/capabilities/CAP-123.md#decided)); one with no name of its own has
none.
"""

from __future__ import annotations

from typing import Any

from . import Proxies
from .Builders import _builder_for, _named

__all__ = ["install", "of", "same"]


def install(txn: Any) -> Any:
    """The path schemas, defined in the store a transaction writes: `store.transaction(Paths.install)`. A store is made
    by it, after `Schemas.install`, read by the bootstrap (`Builders`); run again in a store, it finds each by its name
    and writes nothing. A key's value is a basic scalar's, written bare."""
    S = txn.Schemas  # the store's meta-schemas and basic scalars (78)
    return txn.uid("mbse.Schemas.Paths/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Next": S.OfUnion, "OfTarget": S.OfObject, "OfEntry": S.OfObject, "OfRoot": S.OfObject})
        .spec([
            lambda _: _.Next.name("Paths.Next").branches([
                lambda t: t.name("entry").schema([_.OfEntry]),
                lambda t: t.name("target").schema([_.OfTarget]),
            ]),
            lambda _: _.OfTarget.name("Paths.OfTarget"),
            lambda _: _.OfEntry.name("Paths.OfEntry").properties({
                "i": S.OfStr,  # the adjacency to it from the object before
                "o": S.OfStr,  # the adjacency to it from the object after, the one marked owner()
                "properties": S.OfContainer(lambda c: c.index([S.OfStr]).element([  # the entry's keys
                    S.OfAny(lambda a: a.schemas([S.OfBool, S.OfInt, S.OfStr]))])),
                "next": _.Next,
            }),
            lambda _: _.OfRoot.name("Paths.OfRoot").properties({"singleton": S.OfStr, "next": _.Next}),
        ])]))])


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


def _owner_adjacency(schema: Any) -> bool:
    return any(adjacency.owner for adjacency in (*schema.adjacencies.values(), *schema.anonymous))


def _steps(obj: Any) -> tuple[str, list[tuple[str, str, dict[str, Any]]]]:
    """The singleton a reference object's path starts from, and the ownership entries from it to the object, through
    the adjacencies marked `owner()`. A counted object has no path (object identity 55 in [CAP-118: singletons, owned and counted objects](../../../../../mbse-basis/docs/capabilities/CAP-118.md#decided))."""
    steps, current, seen = [], obj, set()
    while True:
        schema = object.__getattribute__(current, "_schema")
        if schema.singleton is not None:
            return schema.singleton, steps[::-1]
        if not _owner_adjacency(schema):  # only the object asked about: nothing is owned by a counted object (47)
            raise LookupError(f"a {object.__getattribute__(current, '_schema_name')!r} is counted: it has no path")
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


def _schema_steps(obj: Any) -> tuple[str, list[tuple[str, str, dict[str, Any]]]]:
    """A schema object's path (object identity 80 and 81 in [CAP-123: schema objects identified by path](../../../../../mbse-basis/docs/capabilities/CAP-123.md#decided)): from the root module, the singleton `"."`, through each module and
    then the schema by name, then through the keyed adjacency that owns each member. `LookupError` where it has none."""
    store = obj.__dict__.get("_held_by")
    if store is None:
        raise LookupError(f"{_builder_for(obj)._noun} no store holds has no path: a schema object's path is in its store")
    steps = store._path(obj)
    if steps is None and _named(obj):
        raise LookupError(f"the name {obj.name!r} is not a path: its parts are names, joined by dots")
    if steps is None:
        raise LookupError(f"{_builder_for(obj)._noun} with no name of its own, nor a member of one that has a name, has "
                          "no path: it is written nested in the one object that links it")
    return ".", [(i, "", {"name": name}) for i, name in steps]


def of(obj: Any) -> Any:
    """The path of a reference object, read off its ownership entries (object identity 32 in [CAP-119: owned objects found by path](../../../../../mbse-basis/docs/capabilities/CAP-119.md#decided)), or of a schema object, off its
    name and its owners' (81): a `Paths.OfRoot` value, standalone, of the object's store."""
    if _builder_for(obj) is not None:
        singleton, steps = _schema_steps(obj)
        store = obj.__dict__["_held_by"]
    else:
        singleton, steps = _steps(obj)
        store = Proxies.store_of(obj)

    def step(rest: list[tuple[str, str, dict[str, Any]]]) -> Any:
        if not rest:
            return lambda n: n.target(lambda t: t)
        i, o, keys = rest[0]
        return lambda n: n.entry(lambda e: e.i(i).o(o).properties(keys).next(step(rest[1:])))

    return store.Paths.OfRoot(lambda r: r.singleton(singleton).next(step(steps)))


def same(a: Any, b: Any) -> bool:
    """Whether two paths name the same object: equal as plain data. None, an identity not yet given, is the same only
    as None."""
    if a is None or b is None:
        return a is b
    from . import Plain

    return Plain.ToPlain(None)(a.as_schema(), a) == Plain.ToPlain(None)(b.as_schema(), b)  # keys written bare: no names
