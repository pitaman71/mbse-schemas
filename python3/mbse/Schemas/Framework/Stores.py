"""Stores: the root object of a body of data, through which schemas, builders and objects are located.

A store holds schemas by name, and its data: the instances of its singleton schemas, its roots, and every reference
object reachable from them through relation entries, with the value objects those own. Anything else built with a
store's builders is transient: it lives only while the program holds it. `Store` is the protocol every implementation
meets;
`Proxies.OfStore` (dynamic instances) and `Bindings.OfStore` (a program's own classes) implement it. Everything that
looks a schema up by name takes a store: `Plain.ToPlain(store)`, `Plain.FromPlain(store)`, the JSON and YAML forms,
`Validators.Validate(store)` and `Modules`. Stores are isolated from one another; objects move between them as
snapshots. Selecting objects by a condition is an extension, in mbse-expressions.

`Catalog` holds schemas by name and the roots, as every store does, with the messages every store gives, and computes
extents from the roots; `META` holds the meta-schemas a store of proxies starts with.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Protocol

from . import Reachable, Schemas, Visitors

__all__ = ["Store", "Catalog", "META"]

META = (Schemas.Module.Schema,)
"""The meta-schemas a store of proxies starts with, each under its name, so that it can hold modules of schemas."""


class Store(Protocol):
    """A store: schemas by name, builders, and the objects it holds."""

    def schema(self, name: str) -> Schemas.OfObject.Data:
        """The object schema registered as `name`: `AttributeError` if none is, `TypeError` for a relation."""
        ...

    def registered(self, name: str) -> Schemas.OfObject.Data | Schemas.OfRelation.Data:
        """The object or relation schema registered as `name`; `LookupError` if none is."""
        ...

    def name_of(self, schema: Any) -> str:
        """The name `schema` is registered under; `LookupError` if it is not."""
        ...

    def names(self) -> Iterable[str]:
        """Every registered name, in registration order."""
        ...

    def builder(self, name: str, instance: Any = None) -> Any:
        """A builder for the object schema `name`, a `Visitors.OfObject` finalized by `create()`, or by `clone()` and
        `update()` of `instance`."""
        ...

    def member(self, instance: Any, name: str) -> Any:
        """The value `instance` holds in its property `name`, e.g. a value object or a union's branch."""
        ...

    def singleton(self, name: str) -> Visitors.Visitable:
        """The one instance of the singleton schema whose global name is `name`; `LookupError` if there is none."""
        ...

    def extent(self, name: str) -> Iterable[Visitors.Visitable]:
        """The store's reference objects of the schema `name`: those reachable from its singletons, in first-reference
        order."""
        ...


class Catalog:
    """Schemas by name: `register`, `schema`, `registered`, `name_of` and `names`, as every store has them; the roots, by
    global name (`singleton`), which an implementation fills; and `extent`, the reference objects reachable from them."""

    def __init__(self) -> None:
        self._schemas: dict[str, Schemas.OfObject.Data | Schemas.OfRelation.Data] = {}
        self._singletons: dict[str, Visitors.Visitable] = {}

    def register(self, schema: Schemas.OfObject.Data | Schemas.OfRelation.Data) -> None:
        """Registers a schema under its name."""
        name = getattr(schema, "name", None)
        if name is None:
            raise ValueError("a schema needs a name to be registered; name it with its builder's .name()")
        if name in self._schemas:
            raise ValueError(f"schema {name!r} is already registered")
        self._schemas[name] = schema

    def schema(self, name: str) -> Schemas.OfObject.Data:
        schema = self._schemas.get(name)
        if schema is None:
            raise AttributeError(f"no schema registered as {name!r}")
        if not isinstance(schema, Schemas.OfObject.Data):
            raise TypeError(f"{name!r} is a relation; no relation builder is exposed")
        return schema

    def registered(self, name: str) -> Schemas.OfObject.Data | Schemas.OfRelation.Data:
        if name not in self._schemas:
            raise LookupError(f"no schema registered as {name!r}")
        return self._schemas[name]

    def name_of(self, schema: Any) -> str:
        for name, registered in self._schemas.items():
            if registered is schema:
                return name
        raise LookupError("schema is not registered")

    def names(self) -> tuple[str, ...]:
        return tuple(self._schemas)

    def singleton(self, name: str) -> Visitors.Visitable:
        if name not in self._singletons:
            raise LookupError(f"no singleton named {name!r}")
        return self._singletons[name]

    def extent(self, name: str) -> tuple[Visitors.Visitable, ...]:
        self.schema(name)
        seen: set[Any] = set()
        found: list[Visitors.Visitable] = []
        for root in self._singletons.values():
            for value in Reachable.of(root):
                if value.identity() not in seen:
                    seen.add(value.identity())
                    if value.schema_name() == name:
                        found.append(value)
        return tuple(found)

    def _filling(self, relation: Schemas.OfRelation.Data, link: str) -> list[str]:
        """The names of the object schemas that declare an adjacency to `relation` via `link`."""
        return [name for name, schema in self._schemas.items() if isinstance(schema, Schemas.OfObject.Data)
                and any(a.relation is relation and a.me == link for a in schema.adjacencies.values())]
