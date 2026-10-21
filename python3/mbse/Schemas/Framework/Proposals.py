"""Proposals: a transaction's writes, held apart from the store they change until the transaction commits
(docs/OBJECT_IDENTITY.md, Decided, 89, 96, 99, 100).

`OfStore` implements `Visitors.OfStore` over a base, the store or another `OfStore`: a data object's property values,
a value object's, and the entry tables of an object are copied from the base when first written, and read in its place
while the proposals are open; what they do not hold, they read through to the base. Committed, they write what they
hold into the base; aborted, they are dropped, and the store's registries are as they were when they began. Proposals
over proposals are a savepoint: a write within a transaction that may fail alone, as a decoder's does.

The updates of schema objects that existed before the transaction began wait in its proposals too, and are applied when
it commits; a savepoint's are its transaction's once it commits.
"""

from __future__ import annotations

from collections.abc import Hashable, Iterable
from typing import Any

__all__ = ["OfStore"]


class OfStore:
    """A transaction's proposals over `base`, the store whose data they change (`store`) or the proposals of the
    transaction a savepoint is within."""

    def __init__(self, base: Any, store: Any) -> None:
        self.base, self.store = base, store
        self.values_: dict[int, tuple[Any, dict[str, Any]]] = {}  # each holder's values, by its id
        self.entries_: dict[int, tuple[Any, dict[Hashable, dict[Hashable, Any]]]] = {}  # each holder's entry tables
        self.deferred: dict[int, Any] = {}  # each schema object's last builder, whose update waits for commit
        outer = base if isinstance(base, OfStore) else None
        # the schema objects held when the transaction began, by id: those its updates of wait for its commit
        self.existing: set[int] = outer.existing if outer is not None else store._existing()
        self.saved = store._saved()  # the store's registries, restored where the proposals are aborted
        self.pending = (len(store._unowned), len(store._orphaned))  # the ownership to settle, as it was

    # --- Visitors.OfStore: the store's schemas, read through ---

    def schema(self, name: str) -> Any:
        return self.store.schema(name)

    def registered(self, name: str) -> Any:
        return self.store.registered(name)

    def name_of(self, schema: Any) -> str:
        return self.store.name_of(schema)

    def names(self) -> Iterable[str]:
        return self.store.names()

    def builder(self, name: str, instance: Any = None) -> Any:
        return self.store.builder(name, instance)

    def framework(self, schema: Any) -> bool:
        return self.store.framework(schema)

    def member(self, instance: Any, name: str) -> Any:
        return self.store.member(instance, name)

    def singleton(self, name: str) -> Any:
        return self.store.singleton(name)

    def extent(self, name: str) -> Iterable[Any]:
        return self.store.extent(name)

    # --- Visitors.OfStore: data ---

    def values(self, holder: Any, write: bool = False) -> dict[str, Any]:
        """A data object's or a value object's property values as the proposals have them: to write, their copy, made
        the first time from the base's."""
        held = self.values_.get(id(holder))
        if held is not None:
            return held[1]
        below = self.base.values(holder)
        if not write:
            return below
        copied = self.values_[id(holder)] = (holder, dict(below))
        return copied[1]

    def entries(self, holder: Any, write: bool = False) -> dict[Hashable, dict[Hashable, Any]]:
        """The entry tables of an object as the proposals have them: to write, their copy, made the first time from the
        base's."""
        held = self.entries_.get(id(holder))
        if held is not None:
            return held[1]
        below = self.base.entries(holder)
        if not write:
            return below
        copied = self.entries_[id(holder)] = (holder, {key: dict(table) for key, table in below.items()})
        return copied[1]

    def deferred_of(self, original: Any) -> Any:
        """The last builder whose update of a schema object waits, in these proposals or those they are over."""
        found = self.deferred.get(id(original))
        if found is None and isinstance(self.base, OfStore):
            return self.base.deferred_of(original)
        return found

    # --- Ending ---

    def commit(self) -> None:
        """Writes what the proposals hold into their base: a savepoint's into its transaction's proposals, a
        transaction's into the store, the updates of schema objects that waited first; where one of those is refused,
        nothing is written, and the store's registries are as they were."""
        if not isinstance(self.base, OfStore):
            try:
                with self.store._expression():  # its commit
                    self.store._commit_schemas(self)
            except BaseException:
                self.store._restore(self.saved)
                raise
        else:
            self.base.deferred.update(self.deferred)  # in order: each waits for the transaction's commit
        for holder, values in self.values_.values():
            into = self.base.values(holder, True)
            into.clear()
            into.update(values)
        for holder, tables in self.entries_.values():
            into = self.base.entries(holder, True)
            into.clear()
            into.update(tables)

    def abort(self) -> None:
        """Drops what the proposals hold: the store's registries, and the ownership left to settle, as they were when
        they began."""
        self.store._restore(self.saved)
        del self.store._unowned[self.pending[0]:]
        del self.store._orphaned[self.pending[1]:]
