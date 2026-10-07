"""Reflection: schemas as the objects predicates match.

A schema is an object of its kind's meta-schema, the schema of its module form (`Schemas.OfObject.Schema`, named
'Schemas.Object', and the like for natives, unions, intersections, lists, applications and relations): it is a reference
object identified by itself, and writes itself through `accept` as a module writes it, with its name (which a module
gives its entry), its properties, branches, parts and parameters inline, and a named schema it refers to by name
(`{"named": {"name": ...}}`). Predicates (mbse-patterns)
read it with `get` and quantify over its lists, so a symbol whose schema is a meta-schema binds a schema, and the
predicate itself says which schemas match.

`of(store)` is a store whose objects are the schemas `store` registers, and the named schemas they refer to: it
registers the meta-schemas, and the extent of each is the schemas of its kind, in name order. The store's data is not
read, nor its own meta-schemas (`Stores.META`). It builds nothing; schemas are built by their builders.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from . import Modules, Plain, Schemas, Stores, Validators

__all__ = ["META", "of", "OfStore"]

META: tuple[Schemas.OfObject.Data, ...] = (
    Schemas.OfNative.Schema, Schemas.OfObject.Schema, Schemas.OfUnion.Schema,  # type: ignore[attr-defined]
    Schemas.OfIntersection.Schema, Schemas.OfIndexed.Schema, Schemas.OfApply.Schema,  # type: ignore[attr-defined]
    Schemas.OfRelation.Schema)  # type: ignore[attr-defined]
"""The meta-schemas of the kinds of named schemas."""

_BY_NAME = {meta.name: meta for meta in META}


def _accept(schema: Any, visitor: Any) -> None:
    """Writes a schema's module form into `visitor`."""
    ((_, contents),) = Modules._Writer().definition(schema).items()
    named = contents if schema.name is None else {"name": schema.name, **contents}
    Plain._decode(_BY_NAME[schema.schema_name()], named, ()).accept(visitor)


Schemas._REFLECTION["accept"] = _accept


def _referred(schema: Any) -> Iterator[Any]:
    """The types and relations a schema refers to directly."""
    for parameter in schema.parameters.values():
        if parameter.type is not None:
            yield parameter.type
    if isinstance(schema, (Schemas.OfObject.Data, Schemas.OfRelation.Data)):
        yield from (p.type for p in schema.properties.values())
    if isinstance(schema, Schemas.OfObject.Data):
        yield from (a.relation for a in schema.adjacencies.values())
    elif isinstance(schema, Schemas.OfUnion.Data):
        yield from (b.type for b in schema.branches)
    elif isinstance(schema, Schemas.OfIntersection.Data):
        yield from (p.type for p in schema.parts)
    elif isinstance(schema, Schemas.OfIndexed.Data):
        yield from (t for t in (schema.item, schema.key) if t is not None)
    elif isinstance(schema, Schemas.OfApply.Data):
        yield schema.of


def _named(roots: list[Any]) -> list[Any]:
    """The named schemas reachable from `roots`, through the types and relations they refer to, in name order."""
    seen: set[int] = set()
    found: list[Any] = []
    pending = list(roots)
    while pending:
        schema = pending.pop(0)
        if id(schema) in seen:
            continue
        seen.add(id(schema))
        if schema.name is not None:
            found.append(schema)
        pending.extend(_referred(schema))
    return sorted(found, key=lambda schema: schema.name)


class OfStore(Stores.Catalog):
    """The schemas `store` registers, and the named schemas they refer to, as the objects of their meta-schemas."""

    def __init__(self, store: Stores.Store):
        super().__init__()
        for meta in META:
            self.register(meta)
        own = {id(meta) for meta in Stores.META}
        self.schemas = _named([schema for schema in (store.registered(name) for name in store.names())
                               if id(schema) not in own])

    def extent(self, name: str) -> tuple[Any, ...]:
        self.schema(name)
        return tuple(schema for schema in self.schemas if schema.schema_name() == name)

    def builder(self, name: str, instance: Any = None) -> Any:
        raise TypeError("schemas are built by their builders, not by a store of schemas")

    def member(self, instance: Any, name: str) -> Any:
        return Validators.properties_of(instance).get(name)


def of(store: Stores.Store) -> OfStore:
    """A store whose objects are the schemas `store` registers, and the named schemas they refer to."""
    return OfStore(store)
