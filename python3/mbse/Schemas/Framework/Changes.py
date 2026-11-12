"""Changes: a transaction's effect, observed at its commit
([CAP-270: a transaction's changes observed at its commit](mbse:mbse-basis/docs/capabilities/README.md#CAP-270),
[CAP-269: transactions resolved into their effects](mbse:mbse-basis/docs/capabilities/README.md#CAP-269),
[CAP-271: the journal language](mbse:mbse-basis/docs/capabilities/README.md#CAP-271)).

`observe(store, observer)` calls `observer(effect)` after each transaction of `store` that commits having changed
something, and returns a function that ends the observing; a transaction that raises, its writes dropped, is observed by
none. The effect is what the transaction changed, net of what it undid within itself, written in the journal language:
a transaction expression of the store's own schemas (`Mutations.OfTransaction`), schema data written and read as any
value is, with no schema of its own. It is one upsert:

- its symbols, each declared before it is used: each object the transaction touched that was held before it, bound to
  its reference (`References.OfObject`) as it was; each owned object it created, bound to its schema, after its owner's,
  so that the upsert finds it by its ownership entry; and each counted object, immutable, bound to its schema, found by
  its value, which the spec writes;
- its spec: the relation entries the transaction removed, then those it inserted, each written on the adjacency of one
  object it links, then the properties it changed, each set to its value, written by the property's schema, or cleared.
  An object the transaction deleted is never named: the entry that owned it is removed by its owner's key for it,
  written on its owner's adjacency, and what its deletion removed in cascade, every entry linking it and what it
  owned, is left to follow from that, as it does in every store that applies the effect.

Applied to the store as it was before the transaction, the effect makes the same changes; applied again, it changes
nothing. The changes are gathered from the transaction's proposals just before it commits, after `Provenance` records
it and its ownership is settled, so that what it deleted in cascade, and every entry linking it, is among them; what an
object is before is read from what the store holds as committed. The expression is built once the transaction has
committed, since building it writes.
"""

from __future__ import annotations

import contextlib
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

from . import Plain, Proxies, References

__all__ = ["observe"]


def observe(store: Any, observer: Callable[[Any], None]) -> Callable[[], None]:
    """Calls `observer` with the effect of each transaction of `store` that commits having changed something; returns a
    function that ends it."""
    store._observers.append(observer)

    def end() -> None:
        if observer in store._observers:
            store._observers.remove(observer)

    return end


@dataclass
class _Gathered:
    """What a transaction changed, gathered before it commits, to be written as its effect once it has: the symbols, by
    name, each a reference or a schema; each entry removed or inserted, as the symbol whose adjacency writes it, that
    adjacency, the verb, its other links' symbols and its properties; each property changed, by symbol, as plain."""
    symbols: dict[str, Any] = field(default_factory=dict)
    entries: list[tuple[str, str, str, dict[str, str], dict[str, Any]]] = field(default_factory=list)
    assigned: list[tuple[str, str, Any, Any]] = field(default_factory=list)


@contextlib.contextmanager
def _as_committed(store: Any) -> Iterator[None]:
    """Reads what the store holds as committed, while a transaction is open: its state before the transaction."""
    proposals, store._proposals = store._proposals, None
    try:
        yield
    finally:
        store._proposals = proposals


def _schema(x: Any) -> Any:
    return object.__getattribute__(x, "_schema")


def _value(store: Any, holder: Any, name: str) -> Any:
    """A property's value, plain, as its schema writes it; None where the object holds none."""
    value = store.member(holder, name)
    return None if value is None else Plain.ToPlain(store)(_schema(holder).properties[name].schema, value)


def _gather(store: Any, proposals: Any) -> _Gathered | None:
    """What the transaction whose proposals these are changed, gathered just before it commits; None where nothing."""
    base = proposals.base
    removed: dict[Any, Any] = {}
    inserted: dict[Any, Any] = {}
    for holder, tables in proposals.entries_.values():  # an object's tables, copied whole when first written
        before = base.entries(holder)
        for relation, table in tables.items():
            old = before.get(relation, {})
            inserted.update({(relation, key): entry for key, entry in table.items() if key not in old})
            removed.update({(relation, key): entry for key, entry in old.items() if key not in table})
    made = {id(x): x for x in proposals.created.values() if isinstance(x, Proxies._ObjectData)}
    deleted = {id(x) for entry in removed.values() for x in entry._links.values()
               if id(x) not in made and Proxies._owner_adjacencies(_schema(x)) and not Proxies._owner_entries(x)}
    changed: list[tuple[Any, str, Any]] = []
    for holder, values in proposals.values_.values():
        if not isinstance(holder, Proxies._ObjectData) or id(holder) in deleted:
            continue  # a value object's, read with the object that holds it; or a deleted object's, which goes
        names = list(dict.fromkeys([*base.values(holder), *values]))
        after = {name: _value(store, holder, name) for name in names}
        with _as_committed(store):
            before = {name: None if id(holder) in made else _value(store, holder, name) for name in names}
        changed += [(holder, name, after[name]) for name in names if before[name] != after[name]]
    if not (removed or inserted or changed):
        return None
    gathered = _Gathered()
    named: dict[int, str] = {}

    def symbol(x: Any) -> str:
        """The symbol of an object the effect names, declared where first needed: a created owned object's after its
        owner's."""
        found = named.get(id(x))
        if found is not None:
            return found
        counted = Proxies._counted(x)
        if counted or id(x) in made:
            for entry in [] if counted else Proxies._owner_entries(x):
                for owner in entry._links.values():
                    if owner is not x:
                        symbol(owner)
            bound = _schema(x)
        else:
            with _as_committed(store):
                bound = References.of(store, x)
        name = named[id(x)] = f"o{len(named)}"
        gathered.symbols[name] = bound
        if counted:  # found by its value, which it never changes
            gathered.assigned += [(name, n, v, p.schema) for n, p in _schema(x).properties.items()
                                  if (v := _value(store, x, n)) is not None]
        return name

    for entry in removed.values():  # a deleted object's: its owning entry, by its key; the rest follows from that
        gone = [link for link, x in entry._links.items() if id(x) in deleted]
        if not gone:
            continue
        owned = _owning(entry, gone)
        if owned is not None:
            owner, me = owned
            keys = {k: entry._properties[k] for k in Proxies._key_names(entry._relation, me, gone[0])}
            gathered.entries.append((symbol(entry._links[me]), owner, "remove", {}, keys))
    for verb, entries in (("remove", [e for e in removed.values() if not any(id(x) in deleted
                                                                           for x in e._links.values())]),
                          ("insert", inserted.values())):
        for entry in entries:
            link, adjacency = _writer(entry, made)
            others = {other: symbol(x) for other, x in entry._links.items() if other != link}
            gathered.entries.append((symbol(entry._links[link]), adjacency, verb, others, dict(entry._properties)))
    gathered.assigned += [(symbol(holder), name, after, _schema(holder).properties[name].schema)
                          for holder, name, after in changed if not Proxies._counted(holder)]
    return gathered


def _writer(entry: Any, made: dict[int, Any]) -> tuple[str, str]:
    """The link, and its object's adjacency by name, that writes an entry: preferably an object held before, not
    counted, so that what the entry links is found through it."""
    choices = [(Proxies._counted(x) or id(x) in made, link, name)
               for link, x in entry._links.items() for name, adjacency in _schema(x).adjacencies.items()
               if adjacency.relation is entry._relation and adjacency.me == link]
    if not choices:
        raise ValueError(f"no object an entry of {entry._relation.name!r} links has an adjacency to it by name, so "
                         "that its effect cannot write it: name one")
    _, link, name = min(choices, key=lambda choice: choice[0])
    return link, name


def _owning(entry: Any, gone: list[str]) -> tuple[str, str] | None:
    """Where `entry` owns the one deleted object it links, through `gone`, and its owner survives: the owner's
    adjacency by name that writes it, and the owner's link; else None."""
    if len(gone) != 1:
        return None
    x = entry._links[gone[0]]
    if not any(a.relation is entry._relation and a.me == gone[0] for a in Proxies._owner_adjacencies(_schema(x))):
        return None
    (me,) = [link for link in entry._links if link != gone[0]]
    names = [name for name, a in _schema(entry._links[me]).adjacencies.items()
             if a.relation is entry._relation and a.me == me]
    if not names:
        raise ValueError(f"no owner of an entry of {entry._relation.name!r} has an adjacency to it by name, so that "
                         "its effect cannot remove what the entry owned: name one")
    return names[0], me


def _effect(store: Any, gathered: _Gathered) -> Any:
    """The effect, built once the transaction has committed: `Mutations.OfTransaction`, one upsert."""
    specs: list[Callable[[Any], Any]] = []
    for symbol, adjacency, verb, others, properties in gathered.entries:
        def fill(entry: Any, _: Any, others: dict[str, str] = others, properties: dict[str, Any] = properties) -> Any:
            for link, other in others.items():
                entry = getattr(entry, link)(getattr(_, other))
            for name, value in properties.items():
                entry = getattr(entry, name)(value)
            return entry

        specs.append(lambda _, s=symbol, a=adjacency, v=verb, f=fill: getattr(getattr(_, s), a)(
            lambda adv: getattr(adv, v)(lambda e: f(e, _))))
    for symbol, name, plain, schema in gathered.assigned:
        value = None if plain is None else Plain.FromPlain(store)(schema, plain)
        specs.append(lambda _, s=symbol, n=name, v=value: getattr(getattr(_, s), n)(v))
    return store.Mutations.OfTransaction(lambda t: t.mutations([lambda mu: mu.upsert(lambda u: u.exists([
        lambda p: p.symbols(gathered.symbols).spec(specs)]))]))
