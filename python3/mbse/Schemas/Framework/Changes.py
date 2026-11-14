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
object is before is read from what the store holds as committed. The expression is built outside the transaction's
proposals, since building it writes: once the transaction has committed, for its observers, and, for the store below a
store, just before, with its proposals set aside, as plain data (CAP-285).
"""

from __future__ import annotations

import contextlib
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

from . import JSON, Plain, Proxies, References
from .Plain import PlainData

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
    paths = Proxies._gone_paths(proposals, store)  # owned, not present: deleted, with what they own

    def gone(x: Any) -> bool:
        path = x.path if isinstance(x, Proxies._Unresolved) else object.__getattribute__(x, "_reference")
        return path is not None and any(Proxies._under(path, p) for p in paths)

    for entry in [] if store._applying else [*removed.values(), *inserted.values()]:  # what it names: loaded (CAP-284)
        for link, x in list(entry._links.items()):
            if isinstance(x, Proxies._Unresolved) and not gone(x):
                # loading it links it in every entry held that waits on it; one removed, held by none, is linked here
                entry._links[link] = x.store._resolved(x)
    deleted = {id(x) for entry in removed.values() for x in entry._links.values() if gone(x)} | {
               id(x) for entry in removed.values() for x in entry._links.values()
                      if isinstance(x, Proxies._ObjectData) and id(x) not in made
                      and Proxies._owner_adjacencies(_schema(x)) and not Proxies._owner_entries(x)}
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
        counted = not isinstance(x, Proxies._Unresolved) and Proxies._counted(x)
        if isinstance(x, Proxies._Unresolved):  # not present, applying the store below's transaction: by its path
            with _as_committed(store):
                bound = Plain.FromPlain(store)(store.registered("References.OfObject"), {"path": x.path})
        elif counted or id(x) in made:
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
        lost = [link for link, x in entry._links.items() if id(x) in deleted]
        if not lost:
            continue
        owned = _owning(entry, lost, store)
        if owned is not None:
            owner, me = owned
            keys = {k: entry._properties[k] for k in Proxies._key_names(entry._relation, me, lost[0])}
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
               for link, x in entry._links.items() if not isinstance(x, Proxies._Unresolved)
               for name, adjacency in _schema(x).adjacencies.items()
               if adjacency.relation is entry._relation and adjacency.me == link]
    if not choices:
        raise ValueError(f"no object an entry of {entry._relation.name!r} links has an adjacency to it by name, so "
                         "that its effect cannot write it: name one")
    _, link, name = min(choices, key=lambda choice: choice[0])
    return link, name


def _owning(entry: Any, lost: list[str], store: Any) -> tuple[str, str] | None:
    """Where `entry` owns the one deleted object it links, through `lost`, and its owner survives: the owner's
    adjacency by name that writes it, and the owner's link; else None."""
    if len(lost) != 1:
        return None
    x = entry._links[lost[0]]
    owns = Proxies._owns_through(entry._relation, lost[0], store) if isinstance(x, Proxies._Unresolved) else any(
        a.relation is entry._relation and a.me == lost[0] for a in Proxies._owner_adjacencies(_schema(x)))
    if not owns:
        return None
    (me,) = [link for link in entry._links if link != lost[0]]
    names = [name for name, a in _schema(entry._links[me]).adjacencies.items()
             if a.relation is entry._relation and a.me == me]
    if not names:
        raise ValueError(f"no owner of an entry of {entry._relation.name!r} has an adjacency to it by name, so that "
                         "its effect cannot remove what the entry owned: name one")
    return names[0], me


def _plain_effect(store: Any, effect: Any) -> PlainData:
    """An effect of `store`'s as plain data, as it is sent from one store to another."""
    return JSON.loads(JSON.dumps(Plain.ToPlain(store).Transaction(effect)))


def _plain(store: Any, gathered: _Gathered) -> PlainData:
    """The effect of the transaction open, as plain data, built just before it commits, its proposals set aside, as it
    is once it has: what a store sends the store below (CAP-285)."""
    with _as_committed(store):
        return _plain_effect(store, _effect(store, gathered))


def _present_only(store: Any, plain: PlainData) -> PlainData | None:
    """A transaction of the store below's, its effect as plain data, made to change only the objects present in `store`
    (CAP-285): each object is named by its path, an object it created by its owner's and its owning entry's keys; a
    property of an object present is set; an entry is written from an object present it links, through its adjacency by
    name, and one that links none is left out; an object not present, applied, is linked by its path, loading nothing.
    A counted object is found by its value, or made. None where it changes nothing present."""
    (pattern,) = plain["mutations"][0]["upsert"]["exists"]
    symbols, spec = pattern["symbols"], pattern["spec"]
    schemas = {name: Plain._by_path(store, bound["schema"][0]["$ref"], ()) for name, bound in symbols.items()
               if "schema" in bound}  # each symbol's schema: one created's, an object present's, or its path's
    counted = {name for name, schema in schemas.items() if Proxies._counted_schema(schema)}
    paths: dict[str, PlainData] = {}

    def path_of(name: str) -> PlainData:
        """The path of the object a symbol names: as its reference has it, or, where the transaction created it, as its
        owner's, then its owning entry's keys."""
        bound = symbols[name]
        if "reference" in bound:
            return bound["reference"]["path"]
        if name not in paths:
            paths[name] = _created_path(name, schema_of, spec, path_of)
        return paths[name]

    def schema_of(name: str) -> Any:
        if name not in schemas:
            schemas[name] = References._implied(store, path_of(name))
        return schemas[name]

    present = set(counted)
    for name in symbols:
        x = None if name in counted else store._present(path_of(name))
        if isinstance(x, Proxies._ObjectData):
            present.add(name)
            schemas[name] = _schema(x)
    kept: list[PlainData] = []
    for item in spec:
        ((subject, (mutation,)),) = item.items()
        if subject in present:
            kept.append(item)
            continue
        adjacency = mutation.get("as_adjacency")
        if adjacency is None:  # a property of an object not present
            continue
        ((verb, body),) = adjacency["mutations"][0].items()
        ((entry,),) = [body["entries"]]
        links, _ = _parts(entry)
        writer = next((link for link, symbol in links.items() if symbol in present), None)
        if writer is None:
            continue
        held = schema_of(subject).adjacencies[adjacency["name"]]
        names = [name for name, a in schemas[links[writer]].adjacencies.items()
                 if a.relation is held.relation and a.me == writer]
        if not names:
            raise ValueError(f"no object present an entry of {held.relation.name!r} links has an adjacency to it by "
                             "name, so that a transaction of the store below's cannot be applied to it: name one")
        parts = [_link_part(held.me, subject), *(part for part in entry["mutations"]
                                                 if part.get("as_link", {}).get("name") != writer)]
        kept.append({links[writer]: [{"as_adjacency": {"name": names[0], "mutations": [
            {verb: {"entries": [{"mutations": parts}]}}]}}]})
    if not kept:
        return None
    used = set()  # the symbols what is kept names
    for item in kept:
        ((subject, (mutation,)),) = item.items()
        used.add(subject)
        if "as_adjacency" in mutation:
            ((_, body),) = mutation["as_adjacency"]["mutations"][0].items()
            used.update(symbol for entry in body["entries"] for symbol in _parts(entry)[0].values())
    return {"mutations": [{"upsert": {"exists": [{"symbols": {
        name: bound if name in counted else {"reference": {"path": path_of(name)}}
        for name, bound in symbols.items() if name in used}, "spec": kept}]}}]}


def _parts(entry: PlainData) -> tuple[dict[str, str], dict[str, PlainData]]:
    """An entry's links, each to the symbol it is set to, and its properties, each as plain, as an effect writes it."""
    links, keys = {}, {}
    for part in entry["mutations"]:
        ((kind, member),) = part.items()
        ((_, set_),) = member["mutations"][0].items()
        if kind == "as_link":
            links[member["name"]] = set_["ref"]["symbol"]
        else:
            keys[member["name"]] = set_["value"]
    return links, keys


def _link_part(link: str, symbol: str) -> PlainData:
    return {"as_link": {"name": link, "mutations": [{"set": {"ref": {"symbol": symbol}}}]}}


def _created_path(name: str, schema_of: Callable[[str], Any], spec: list[PlainData],
                  path_of: Callable[[str], PlainData]) -> PlainData:
    """The path of an object a transaction created: its owner's, then the entry that owns it, which the transaction
    inserted, through the owner's adjacency by name, by its keys."""
    owner, i, owned, keys = _owning_inserted(name, schema_of, spec)[0]
    singleton, steps = Plain._steps(path_of(owner), ())
    nested: PlainData = {"target": {}}
    for i_, o, keys_ in reversed([*steps, (i, owned.name, keys)]):
        nested = {"entry": {"i": i_, "o": o, "properties": keys_, "next": nested}}
    return {"singleton": singleton, "next": nested}


def _owning_inserted(name: str, schema_of: Callable[[str], Any], spec: list[PlainData]) -> list[Any]:
    """The entries an effect inserts that own the object a symbol names: each as its owner's symbol, the owner's
    adjacency by name to it, the owned object's adjacency marked owner(), and the entry's keys."""
    found = []
    for item in spec:
        ((subject, (mutation,)),) = item.items()
        adjacency = mutation.get("as_adjacency", {})
        inserted = adjacency.get("mutations", [{}])[0].get("insert", {"entries": []})["entries"]
        held = schema_of(subject).adjacencies[adjacency["name"]] if inserted else None
        for entry in inserted:
            links, keys = _parts(entry)
            links[held.me] = subject
            for a in Proxies._owner_adjacencies(schema_of(name)):
                if a.relation is held.relation and links.get(a.me) == name:
                    ((owner_link, owner),) = [(link, symbol) for link, symbol in links.items() if link != a.me]
                    i = next((n for n, b in schema_of(owner).adjacencies.items()
                              if b.relation is a.relation and b.me == owner_link), "")
                    found.append((owner, i, a, {k: keys[k] for k in Proxies._key_names(a.relation, owner_link, a.me)}))
    return found


def _effect(store: Any, gathered: _Gathered) -> Any:
    """The effect, built outside the transaction's proposals: `Mutations.OfTransaction`, one upsert."""
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
