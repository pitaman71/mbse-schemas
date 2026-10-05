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

A random source is given to whatever draws from it, such as mbse-patterns' generators, not held by a store, which is
data access alone: `Generate(store, weights, PCG32(42))`. `Random` is the protocol: `next_u32()`, the next 32 random
bits, and `split(key)`, an independent stream determined by the source's seed and `key` alone, not by what was drawn
before. `PCG32(seed, sequence)` is the reference source, specified exactly so that every implementation
draws the same numbers: PCG-XSH-RR with a 64-bit state, seeded as the PCG paper's `pcg32_srandom`; `split(key)` seeds
a new PCG32, with the same sequence, from FNV-1a 64 of the key's UTF-8 bytes, starting from the offset basis XOR the
seed.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Protocol

from . import Reachable, Schemas, Visitors

__all__ = ["Store", "Catalog", "META", "Random", "PCG32"]

META = (Schemas.Module.Schema,)
"""The meta-schemas a store of proxies starts with, each under its name, so that it can hold modules of schemas."""


class Random(Protocol):
    """A source of random bits, given to whatever draws from it."""

    def next_u32(self) -> int:
        """The next 32 random bits, as an int from 0 to 2**32 - 1."""
        ...

    def split(self, key: str) -> Random:
        """An independent stream, determined by this source's seed and `key` alone."""
        ...


_MASK64 = (1 << 64) - 1
_MULTIPLIER = 6364136223846793005
_FNV_BASIS, _FNV_PRIME = 0xCBF29CE484222325, 0x100000001B3


class PCG32:
    """The reference random source: PCG-XSH-RR, a 64-bit state and 32-bit output (O'Neill, 2014), seeded as
    `pcg32_srandom(seed, sequence)`."""

    def __init__(self, seed: int, sequence: int = 0):
        if type(seed) is not int or type(sequence) is not int or not 0 <= seed <= _MASK64 or not 0 <= sequence <= _MASK64:
            raise ValueError("a PCG32's seed and sequence are ints from 0 to 2**64 - 1")
        self.seed, self.sequence = seed, sequence
        self._state, self._increment = 0, ((sequence << 1) | 1) & _MASK64
        self.next_u32()
        self._state = (self._state + seed) & _MASK64
        self.next_u32()

    def next_u32(self) -> int:
        old = self._state
        self._state = (old * _MULTIPLIER + self._increment) & _MASK64
        shifted = (((old >> 18) ^ old) >> 27) & 0xFFFFFFFF
        rotation = old >> 59
        return ((shifted >> rotation) | (shifted << ((-rotation) & 31))) & 0xFFFFFFFF

    def split(self, key: str) -> PCG32:
        hashed = _FNV_BASIS ^ self.seed
        try:
            encoded = key.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("a key must be text without lone surrogates") from None
        for byte in encoded:
            hashed = ((hashed ^ byte) * _FNV_PRIME) & _MASK64
        return PCG32(hashed, self.sequence)


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
