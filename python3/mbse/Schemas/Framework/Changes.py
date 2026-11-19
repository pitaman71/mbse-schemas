"""Changes: a transaction's effect, observed at its commit, written as a journal
([CAP-270: a transaction's changes observed at its commit](mbse:mbse-basis/docs/capabilities/README.md#CAP-270),
[CAP-269: transactions resolved into their effects](mbse:mbse-basis/docs/capabilities/README.md#CAP-269),
[CAP-271: the journal language](mbse:mbse-basis/docs/capabilities/README.md#CAP-271),
[the journals proposal](mbse:mbse-basis/proposals/JOURNALS.md#the-changes-schemas-proposed)).

The journal language's value schemas, which every store holds, its own, as it holds `References` (`install`):

- `Changes.Journal`, a journal: its transactions, in order, a container of `Changes.Transaction` by position. A journal
  is data: built, sliced, written, read and compared as any value is, with no store of its own; its transactions are
  read by iterating it. Whole transactions taken from a journal, in order, are a journal too.
- `Changes.Transaction`, one transaction: its `id`, unique, the uid `Provenance` records it by; its `symbols`, each by
  its name (`Changes.Symbol`), the transaction's own; then its `changes`, in order, each a `Changes.Change`.
- `Changes.Symbol`, an object that exists (A): an object held before, by its `reference` (`References.OfObject`), or a
  new object, by its `schema`'s reference alone, an object reference from the singleton `"."`; an object held before
  is given its `schema` too where its path does not imply it, as where objects of several schemas are owned through
  one relation, so that a reader never guesses it.
- `Changes.Change`, a change: a relation entry's (`entry`, `Changes.OfEntry`) or a property's (`property`,
  `Changes.OfProperty`).
- `Changes.OfEntry`, a relation entry inserted or removed (B): written on its `holder`'s adjacency named `adjacency`,
  its `verb`, `insert` or `remove`, its other `links`, each by its name, and its `properties`' values. A link is set as
  a spec sets one (`Mutations.OfLink.Set`): to a symbol, `{"reference": {"symbol": "o0"}}`, or, a counted object, to
  its value, inline, `{"def": {"schema": ..., "mutations": [...]}}`, never bound to a symbol: an immutable object,
  found by its value, or made; the holder too, where only the counted object has an adjacency to the entry by name.
- `Changes.OfProperty`, a property mutated (C): its `holder`'s symbol, the property's `name`, and its `mutations`,
  mbse-schemas' verbs (`Mutations.OfProperty`): `set` and `clear`, and, nested, the verbs of the value's kind.

A value, a property's in a change or an entry's, is a payload (`Mutations.Payload`), written by the schema of the
property it is the value of, as a recorded spec writes it, marked with its schema only where that schema cannot tell
it ([PRI-025: never guess the schema](mbse:mbse-basis/docs/PRINCIPLES.md#PRI-025)): the plain form reads a transaction's
symbols first, and each payload by the schema its holder's schema gives the property (`_within`), so that it is read
where the store holds the schemas the journal's objects are of.

`observe(store, observer)` calls `observer(journal)` after each transaction of `store` that commits having changed
something, a `Changes.Journal` of that one transaction, a value that outlives it; and returns a function that ends the
observing; a transaction that raises, its writes dropped, is observed by none. What it changed is net of what it undid
within itself: its symbols, each object the transaction touched that was held before it, by its reference as it was,
and each owned object it created, by its schema, after its owner's, so that applying finds it by its ownership entry;
then its changes, the relation entries it removed, then those it inserted, each written on the adjacency of one object
it links, then the properties it changed, each set to its value or cleared. An object the transaction deleted is never
named: the entry that owned it is removed by its owner's key for it, written on its owner's adjacency, and what its
deletion removed in cascade, every entry linking it and what it owned, is left to follow from that, as it does in
every store that applies the journal. `store.follow(follower)` gives the same journal as plain data.

`apply(txn, journal)` writes, within the transaction `txn` builds, each transaction of a journal, in order: applied to
the store as it was before them, it makes the same changes, and applied again, it changes nothing. A transaction's
changes are applied as one upsert, of its symbols, each counted object inline bound to a symbol of its own, one per
value, whose spec writes its changes where they do not hold.

The changes are gathered from the transaction's proposals just before it commits, after `Provenance` records it and
its ownership is settled, so that what it deleted in cascade, and every entry linking it, is among them; what an object
is before is read from what the store holds as committed. They are written outside the transaction's proposals, since
writing them builds, once the transaction has committed, for its observers. A savepoint's changes are gathered alike,
relative to the transaction it is within: what interpreting an input frame changed, which the frame given carries as a
journal (`Transactions.Frame.journal`). An expression's terms, and the entries linking schema objects, are no data,
and are left out.

A cache layer, a store given a layer below, applies to what it holds the journals the frames the layer below gives back
carry, and those the layer below's follow gives, as a transaction of its own (`Builders.Store._apply`): to the objects
present in it alone (`_present_only`), making those made under one present, and leaving out an entry that links one not
present. What it writes itself, by builders, it sends below as the effect of the savepoint that wrote it, a mutation
transaction (`_effect`), executed in the layer below's transaction.
"""

from __future__ import annotations

import contextlib
import itertools
import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

from . import JSON, Plain, Proxies, References
from .Builders import _transaction_of
from .Plain import PlainData

__all__ = ["install", "observe", "apply"]


def install(txn: Any) -> Any:
    """The journal language's schemas, defined in the store a transaction writes: `store.transaction(Changes.install)`.
    A store is made by it, after `References.install` and `Mutations.install`, read by the bootstrap (`Builders`); run
    again in a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the store's meta-schemas and basic scalars (78)
    Mu = txn.Mutations
    return txn.uid("mbse.Schemas.Changes/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Journal": S.OfContainer, "Transaction": S.OfObject, "Symbol": S.OfObject, "Change": S.OfUnion,
                  "OfEntry": S.OfObject, "OfProperty": S.OfObject})
        .spec([
            lambda _: _.Journal.name("Changes.Journal").index([S.OfInt]).element([_.Transaction]),  # in order
            lambda _: _.Transaction.name("Changes.Transaction").properties({
                "id": S.OfStr,  # unique: the uid Provenance records it by
                "symbols": S.OfContainer(lambda c: c.index([S.OfStr]).element([_.Symbol])),  # by name: its own
                "changes": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.Change])),  # in order
            }),
            lambda _: _.Symbol.name("Changes.Symbol").properties({  # A: an object exists
                "reference": txn.References.OfObject,  # held before
                "schema": txn.References.OfObject,  # alone, a new one's; else where its path does not imply it
            }),
            lambda _: _.Change.name("Changes.Change").branches([
                lambda t: t.name("entry").schema([_.OfEntry]),
                lambda t: t.name("property").schema([_.OfProperty]),
            ]),
            lambda _: _.OfEntry.name("Changes.OfEntry").properties({  # B: a relation entry inserted or removed
                "holder": getattr(Mu, "OfLink.Set"),  # a symbol, or a counted object inline
                "adjacency": S.OfStr,  # the holder's, by name
                "verb": S.OfStr,  # insert or remove
                "links": S.OfContainer(lambda c: c.index([S.OfStr]).element([getattr(Mu, "OfLink.Set")])),
                "properties": S.OfContainer(lambda c: c.index([S.OfStr]).element([Mu.Payload])),
            }),
            lambda _: _.OfProperty.name("Changes.OfProperty").properties({  # C: a property mutated
                "holder": S.OfStr,  # a symbol
                "name": S.OfStr,
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([Mu.OfProperty])),
            }),
        ])]))])


def observe(store: Any, observer: Callable[[Any], None]) -> Callable[[], None]:
    """Calls `observer` with a `Changes.Journal` of each transaction of `store` that commits having changed something,
    that one transaction; returns a function that ends it."""
    store._observers.append(observer)

    def end() -> None:
        if observer in store._observers:
            store._observers.remove(observer)

    return end


def apply(txn: Any, journal: Any) -> Any:
    """Writes each transaction of `journal`, a `Changes.Journal`, in order, within the transaction `txn` builds: each
    one upsert, its symbols its own, chained, so that what one makes the next finds; gives `txn`, as an install does:
    `store.transaction(lambda txn: Changes.apply(txn, journal))`."""
    store, builder = _transaction_of(txn)
    plain = Plain.ToPlain(store)(store.registered("Changes.Journal"), journal)
    term: PlainData = None
    for i, transaction in reversed(list(enumerate(plain))):
        ((upsert,),) = [_effect_of(store, transaction, f"t{i}_")["mutations"]]
        if term is not None:
            upsert["upsert"]["then"] = [term]
        term = upsert
    Plain._built(store, builder, store.registered("Mutations.OfTransaction"),
                 {} if term is None else {"mutations": [term]}, ())
    return txn


@dataclass
class _Gathered:
    """What a transaction changed, gathered before it commits, to be written as its effect once it has: the symbols, by
    name, each a reference or a schema; each entry removed or inserted, as the symbol whose adjacency writes it, that
    adjacency, the verb, its other links' symbols and its properties; each property changed, by symbol, as plain."""
    symbols: dict[str, Any] = field(default_factory=dict)
    entries: list[tuple[str, str, str, dict[str, str], dict[str, Any]]] = field(default_factory=list)
    assigned: list[tuple[str, str, Any, Any]] = field(default_factory=list)


@contextlib.contextmanager
def _before(store: Any, proposals: Any) -> Iterator[None]:
    """Reads what the store held before `proposals`: their base, the transaction open's where they are a savepoint's,
    else what it holds as committed."""
    held, store._proposals = store._proposals, proposals.base if hasattr(proposals.base, "entries_") else None
    try:
        yield
    finally:
        store._proposals = held


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
    if value is not None and Proxies._is_parameter(Proxies._durable(value)):  # a parameter in its place (CAP-312)
        return Plain._marked(store, value)
    return None if value is None else Plain.ToPlain(store)(_schema(holder).properties[name].schema, value)


def _data(store: Any, entry: Any) -> bool:
    """Whether an entry links data alone, objects or parameter references in their place: one that links a schema
    object, an extension's, is no data (CAP-315), nor one that links an expression's term, of a schema the store was
    made holding (`Mutations`), and either is left out of what a transaction changed."""
    return all((isinstance(x, Proxies._ObjectData) and not store.framework(_schema(x))) or Proxies._is_parameter(x)
               for x in entry._links.values())


def _gather(store: Any, proposals: Any) -> _Gathered | None:
    """What the transaction whose proposals these are changed, gathered just before it commits; None where nothing."""
    base = proposals.base
    removed: dict[Any, Any] = {}
    inserted: dict[Any, Any] = {}
    for holder, tables in proposals.entries_.values():  # an object's tables, copied whole when first written
        if not isinstance(holder, Proxies._ObjectData):  # a schema object's: no data (CAP-315)
            continue
        before = base.entries(holder)
        for relation, table in tables.items():
            old = before.get(relation, {})
            inserted.update({(relation, key): entry for key, entry in table.items() if key not in old and _data(store, entry)})
            removed.update({(relation, key): entry for key, entry in old.items() if key not in table and _data(store, entry)})
    made = {id(x): x for x in proposals.created.values() if isinstance(x, Proxies._ObjectData)}
    deleted = {id(x) for entry in removed.values() for x in entry._links.values()
                      if isinstance(x, Proxies._ObjectData) and id(x) not in made
                      and Proxies._owner_adjacencies(_schema(x)) and not Proxies._owner_entries(x)}
    changed: list[tuple[Any, str, Any]] = []
    for holder, values in proposals.values_.values():
        if not isinstance(holder, Proxies._ObjectData) or id(holder) in deleted or store.framework(_schema(holder)):
            continue  # a value object's, read with the object that holds it; a deleted object's, which goes; a term's
        names = list(dict.fromkeys([*base.values(holder), *values]))
        after = {name: _value(store, holder, name) for name in names}
        with _before(store, proposals):
            before = {name: None if id(holder) in made else _value(store, holder, name) for name in names}
        changed += [(holder, name, after[name]) for name in names if before[name] != after[name]]
    if not (removed or inserted or changed):
        return None
    gathered = _Gathered()
    named: dict[Any, str] = {}  # by the object

    def symbol(x: Any) -> str:
        """The symbol of an object the effect names, declared where first needed: a created owned object's after its
        owner's."""
        found = named.get(Proxies._link_key(x))
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
            with _before(store, proposals):
                bound = References.of(store, x)
        name = named[Proxies._link_key(x)] = f"o{len(named)}"
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
            others = {other: x if Proxies._is_parameter(x) else symbol(x)  # a parameter reference, as itself (CAP-312)
                      for other, x in entry._links.items() if other != link}
            gathered.entries.append((symbol(entry._links[link]), adjacency, verb, others, dict(entry._properties)))
    gathered.assigned += [(symbol(holder), name, after, _schema(holder).properties[name].schema)
                          for holder, name, after in changed if not Proxies._counted(holder)]
    return gathered


def _writer(entry: Any, made: dict[int, Any]) -> tuple[str, str]:
    """The link, and its object's adjacency by name, that writes an entry: preferably an object held before, not
    counted, so that what the entry links is found through it."""
    choices = [(Proxies._counted(x) or id(x) in made, link, name)
               for link, x in entry._links.items() if not Proxies._is_parameter(x)
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
    owns = any(a.relation is entry._relation and a.me == lost[0] for a in Proxies._owner_adjacencies(_schema(x)))
    if not owns:
        return None
    (me,) = [link for link in entry._links if link != lost[0]]
    names = [name for name, a in _schema(entry._links[me]).adjacencies.items()
             if a.relation is entry._relation and a.me == me]
    if not names:
        raise ValueError(f"no owner of an entry of {entry._relation.name!r} has an adjacency to it by name, so that "
                         "its effect cannot remove what the entry owned: name one")
    return names[0], me


def _frame_journal(store: Any, gathered: _Gathered, uid: str) -> Any:
    """What a frame's interpretation changed, gathered from its savepoint, as a `Changes.Journal` of one transaction of
    id `uid`, a value that outlives the transaction (`Transactions.Frame.journal`)."""
    with _as_committed(store):  # built outside the transaction's proposals, as an effect is
        effect = _plain_effect(store, _effect(store, gathered))
    return _journal(store, uid, effect)


def _plain_effect(store: Any, effect: Any) -> PlainData:
    """An effect of `store`'s as plain data, as it is sent from one store to another."""
    return JSON.loads(JSON.dumps(Plain.ToPlain(store).Transaction(effect)))


def _plain(store: Any, gathered: _Gathered) -> PlainData:
    """The effect of the transaction open, as plain data, built just before it commits, its proposals set aside, as it
    is once it has: what a cache layer sends the layer below of its own write (CAP-285)."""
    with _as_committed(store):
        return _plain_effect(store, _effect(store, gathered))


def _present_only(store: Any, plain: PlainData) -> tuple[PlainData | None, list[Any]]:
    """A transaction of the layer below's, its effect as plain data, made to change only the objects present in `store`
    ([CAP-285: writes through, others' writes in](mbse:mbse-basis/docs/capabilities/README.md#CAP-285), its second decision): each object is named by its path, an object it created by its
    owner's and its owning entry's keys, and is present where the store holds it, or where it was created owned by one
    present, which applying it creates; a counted object is found by its value, or made. A property of an object present
    is set; an entry is written where every object it links is present, and left out otherwise, nothing being made that
    is not present. Gives that effect, under the transaction's `uid` where given, None where it changes nothing present;
    and the objects present an entry left out links, whose entries the store no longer holds all of (`_complete`)."""
    (pattern,) = plain["mutations"][0]["upsert"]["exists"]
    symbols, spec = pattern["symbols"], pattern["spec"]
    schemas = {name: Plain._by_path(store, bound["schema"][0]["path"], ()) for name, bound in symbols.items()
               if "schema" in bound}  # each symbol's schema: one created's, an object present's, or its path's
    counted = {name for name, schema in schemas.items() if Proxies._counted_schema(schema)}
    present = set(counted)
    held: dict[str, Any] = {}
    for name, bound in symbols.items():
        x = None if "reference" not in bound else store._present(bound["reference"]["path"])
        if isinstance(x, Proxies._ObjectData):
            present.add(name)
            held[name] = x
            schemas[name] = _schema(x)
    def owned(name: str) -> bool:
        """Whether an entry the transaction inserts owns the object it created a symbol names, written on the
        adjacency of an object present."""
        for item in spec:
            ((subject, (mutation,)),) = item.items()
            adjacency = mutation.get("as_adjacency")
            if subject not in present or adjacency is None:
                continue
            relation = schemas[subject].adjacencies[adjacency["name"]].relation
            inserted = adjacency["mutations"][0].get("insert", {"entries": []})["entries"]
            if any(links.get(a.me) == name for links, _ in map(_parts, inserted)
                   for a in Proxies._owner_adjacencies(schemas[name]) if a.relation is relation):
                return True
        return False

    created = [name for name, bound in symbols.items() if "schema" in bound and name not in counted]
    grown = True
    while grown:  # an object created owned by one present: present once applied
        grown = False
        for name in created:
            if name not in present and owned(name):
                present.add(name)
                grown = True
    kept: list[PlainData] = []
    lost: list[Any] = []
    for item in spec:
        ((subject, (mutation,)),) = item.items()
        adjacency = mutation.get("as_adjacency")
        if adjacency is None:  # a property: of an object present, set
            if subject in present:
                kept.append(item)
            continue
        ((_, body),) = adjacency["mutations"][0].items()
        linked = [subject, *(symbol for entry in body["entries"] for symbol in _parts(entry)[0].values()
                             if isinstance(symbol, str))]
        if all(symbol in present for symbol in linked):
            kept.append(item)
        else:  # it links one not present: left out, and each present it links holds its entries no more all
            lost += [held[symbol] for symbol in linked if symbol in held]
    if not kept:
        return None, lost
    used = set()  # the symbols what is kept names
    for item in kept:
        ((subject, (mutation,)),) = item.items()
        used.add(subject)
        if "as_adjacency" in mutation:
            ((_, body),) = mutation["as_adjacency"]["mutations"][0].items()
            used.update(symbol for entry in body["entries"] for symbol in _parts(entry)[0].values()
                        if isinstance(symbol, str))
    return {**{k: v for k, v in plain.items() if k == "uid"}, "mutations": [{"upsert": {**{
        k: v for k, v in plain["mutations"][0]["upsert"].items() if k == "key"}, "exists": [{"symbols": {
        name: bound for name, bound in symbols.items() if name in used}, "spec": kept}]}}]}, lost


def _parts(entry: PlainData) -> tuple[dict[str, str], dict[str, PlainData]]:
    """An entry's links, each to the symbol it is set to, or to a parameter reference, marked, and its properties, each
    as plain, as an effect writes it."""
    links, keys = {}, {}
    for part in entry["mutations"]:
        ((kind, member),) = part.items()
        ((_, set_),) = member["mutations"][0].items()
        if kind == "as_link":
            reference = set_["reference"]
            links[member["name"]] = reference if Plain._is_marked(reference) else reference["symbol"]
        else:
            keys[member["name"]] = set_["value"]
    return links, keys


def _effect(store: Any, gathered: _Gathered) -> Any:
    """The effect, built outside the transaction's proposals: `Mutations.OfTransaction`, one upsert."""
    specs: list[Callable[[Any], Any]] = []
    for symbol, adjacency, verb, others, properties in gathered.entries:
        def fill(entry: Any, _: Any, others: dict[str, str] = others, properties: dict[str, Any] = properties) -> Any:
            for link, other in others.items():
                entry = getattr(entry, link)(getattr(_, other) if isinstance(other, str) else other)
            for name, value in properties.items():
                entry = getattr(entry, name)(value)
            return entry

        specs.append(lambda _, s=symbol, a=adjacency, v=verb, f=fill: getattr(getattr(_, s), a)(
            lambda adv: getattr(adv, v)(lambda e: f(e, _))))
    for symbol, name, plain, schema in gathered.assigned:
        value = None if plain is None else Plain._unmarked(store, plain) if Plain._is_marked(plain) else \
            Plain.FromPlain(store)(schema, plain)
        specs.append(lambda _, s=symbol, n=name, v=value: getattr(getattr(_, s), n)(v))
    return store.Mutations.OfTransaction(lambda t: t.mutations([lambda mu: mu.upsert(lambda u: u.exists([
        lambda p: p.symbols(gathered.symbols).spec(specs)]))]))


# --- The journal: an effect written in the `Changes` schemas, and read back as one ---


def _transaction(store: Any, uid: str, effect: PlainData) -> PlainData:
    """A transaction's effect, as plain data (`_plain_effect`), written as a `Changes.Transaction`, plain, of id `uid`:
    each symbol bound to a reference, or to the schema of an object it made, a `Changes.Symbol`; each counted object,
    bound to its schema in the effect, written by its value, inline, where an entry links it; each entry the effect
    writes a `Changes.OfEntry`, and each property it sets or clears a `Changes.OfProperty`, in the effect's order."""
    (pattern,) = effect["mutations"][0]["upsert"]["exists"]
    symbols, spec = pattern.get("symbols", {}), pattern.get("spec", [])  # none: a counted object made, linked by none
    counted: dict[str, PlainData] = {}  # by symbol: its value, inline
    for name, bound in symbols.items():
        if "schema" in bound:
            schema = Plain._by_path(store, bound["schema"][0]["path"], ())
            if Proxies._counted_schema(schema):
                counted[name] = {"schema": store.name_of(schema), "mutations": []}
    for item in spec:  # a counted object's values, which it never changes: its value
        for name, mutations in item.items():
            if name in counted:
                counted[name]["mutations"] += [m for m in mutations if "as_property" in m]

    def link(target: Any) -> PlainData:
        if not isinstance(target, str):  # a parameter reference, marked, in the object's place (CAP-312)
            return {"reference": target}
        return {"def": counted[target]} if target in counted else {"reference": {"symbol": target}}

    changes: list[PlainData] = []
    for item in spec:
        for name, mutations in item.items():
            for mutation in mutations:
                if "as_property" in mutation:
                    if name not in counted:
                        changes.append({"property": {"holder": name, **mutation["as_property"]}})
                    continue
                adjacency = mutation["as_adjacency"]
                for verb in adjacency["mutations"]:
                    ((kind, body),) = verb.items()
                    for entry in body["entries"]:
                        links, keys = _parts(entry)
                        changes.append({"entry": {"holder": link(name), "adjacency": adjacency["name"], "verb": kind,
                                                  "links": {other: link(x) for other, x in links.items()},
                                                  "properties": keys}})
    return {"id": uid, "symbols": {name: _symbol(store, bound) for name, bound in symbols.items() if name not in counted},
            "changes": changes}


def _symbol(store: Any, bound: PlainData) -> PlainData:
    """An effect's symbol as a `Changes.Symbol`, plain: a new object's schema's reference; an object held before's
    reference, with its schema's where its path does not imply it, the store holding it."""
    if "schema" in bound:
        return {"schema": {"path": bound["schema"][0]["path"]}}
    path = bound["reference"]["path"]
    try:
        implied = References._implied(store, path)
    except LookupError:
        implied = None
    held = store._present(path)
    if held is not None and _schema(held) is not implied:
        return {"reference": bound["reference"], "schema": {"path": Plain._schema_path(store._path(_schema(held)))}}
    return {"reference": bound["reference"]}


def _journal(store: Any, uid: str, effect: PlainData) -> Any:
    """A transaction's effect, as plain data, as a `Changes.Journal` of that one transaction, of id `uid`: a value of
    `store`'s, which outlives the transaction."""
    return Plain.FromPlain(store)(store.registered("Changes.Journal"), [_transaction(store, uid, effect)])


def _effect_of(store: Any, transaction: PlainData, prefix: str = "") -> PlainData:
    """A `Changes.Transaction`, as plain data, as the effect it writes: one upsert, under its id, of its symbols, each
    named with `prefix` before its name, and of each counted object it writes inline, one symbol for each value, bound
    to its schema, whose values the spec writes after its changes, so that it is found by its value, or made."""
    symbols: dict[str, PlainData] = {}
    for name, bound in transaction.get("symbols", {}).items():
        symbols[prefix + name] = {"reference": bound["reference"]} if "reference" in bound else {
            "schema": [{Plain.SCHEMA: Plain.REFERENCE, **bound["schema"]}]}
    counted: dict[str, str] = {}  # each counted object's symbol, by its value
    values: list[PlainData] = []

    def symbol(link: PlainData) -> Any:
        """What a link set to a symbol, a counted object's value or a parameter reference names, as an effect does."""
        ((kind, given),) = link.items()
        if kind == "reference" and Plain._is_marked(given):
            return given
        if kind == "reference" and "symbol" in given:
            return prefix + given["symbol"]
        if kind != "def":
            raise ValueError("a change links an object by a symbol of its transaction, or a counted object by its value")
        key = json.dumps(given, sort_keys=True)
        if key not in counted:
            counted[key] = next(name for n in itertools.count(len(counted)) if (name := f"{prefix}c{n}") not in symbols)
            path = Plain._schema_path(store._path(store.registered(given["schema"])))
            symbols[counted[key]] = {"schema": [{Plain.SCHEMA: Plain.REFERENCE, "path": path}]}
            values.extend({counted[key]: [_renamed(mutation, prefix)]} for mutation in given["mutations"])
        return counted[key]

    spec: list[PlainData] = []
    for change in transaction.get("changes", []):
        ((kind, body),) = change.items()
        if kind == "property":
            spec.append({prefix + body["holder"]: [{"as_property": {"name": body["name"],
                                                                    "mutations": body["mutations"]}}]})
            continue
        if body["verb"] not in ("insert", "remove"):
            raise ValueError(f"an entry's change is an insert or a remove, not {body['verb']!r}")
        parts = [{"as_link": {"name": name, "mutations": [{"set": {"reference": target if isinstance(target, dict)
                                                                    else {"symbol": target}}}]}}
                 for name, target in ((name, symbol(link)) for name, link in body.get("links", {}).items())]
        parts += [{"as_property": {"name": name, "mutations": [{"set": {"value": value}}]}}
                  for name, value in body.get("properties", {}).items()]
        spec.append({symbol(body["holder"]): [{"as_adjacency": {"name": body["adjacency"], "mutations": [
            {body["verb"]: {"entries": [{"mutations": parts}]}}]}}]})
    keyed = {"key": transaction["id"]} if "id" in transaction else {}  # a replay finds the counted objects it made
    return {**({"uid": transaction["id"]} if "id" in transaction else {}),
            "mutations": [{"upsert": {**keyed, "exists": [{"symbols": symbols, "spec": spec + values}]}}]}


def _renamed(plain: PlainData, prefix: str) -> PlainData:
    """Plain mutations with each symbol a link is set to named with `prefix` before its name."""
    if isinstance(plain, list):
        return [_renamed(item, prefix) for item in plain]
    if not isinstance(plain, dict):
        return plain
    return {k: {**v, "symbol": prefix + v["symbol"]} if k == "reference" and isinstance(v, dict) and "symbol" in v
            else _renamed(v, prefix) for k, v in plain.items()}


def _effects(store: Any, journal: PlainData) -> list[PlainData]:
    """A `Changes.Journal`, as plain data, as the effect of each of its transactions, in order (`_effect_of`)."""
    if not isinstance(journal, list):
        raise ValueError("a journal, as plain data, is a list of its transactions")
    return [_effect_of(store, transaction) for transaction in journal]


# --- What a payload is interpreted by, as `Plain` writes and reads a journal (`Plain._AT`) ---


def _within(store: Any, schema: Any, at: Any, member: str, siblings: dict[str, PlainData]) -> Any:
    """What the member `member` of a value of `schema` is within, the value being within `at`, given its members
    written or read before it, `siblings`: a transaction's changes, within its symbols; a payload in them, within the
    schema of the property it is the value of. None where nothing says, or where what it says names no schema the
    store holds, so that the payload is written, or refused, as any value of any schema is."""
    name = schema.name
    if name == "Changes.Transaction":
        return _Symbols(store, siblings.get("symbols")) if member == "changes" else None
    if at is None:
        return None
    try:
        return at.member(name, member, siblings)
    except (KeyError, LookupError, AttributeError, TypeError, ValueError, Plain.DecodeError):
        return None


class _At:
    """What a value is within, as `Plain` writes and reads it: what its members and elements are within, and the
    schema a payload is interpreted by, where it is one."""

    payload: Any = None

    def element(self, index: Any) -> Any:
        return self


class _Symbols(_At):
    """A transaction's changes: within its symbols, each bound to the schema of the object it names."""

    def __init__(self, store: Any, symbols: Any) -> None:
        self.store, self.symbols = store, symbols or {}

    def schema(self, symbol: str) -> Any:
        """The schema of the object a symbol names: the one it is given, else, one held before's, as its path implies."""
        bound = self.symbols[symbol]
        if "schema" in bound:
            return Plain._by_path(self.store, bound["schema"]["path"], ())
        return References._implied(self.store, bound["reference"]["path"])

    def linked(self, link: PlainData) -> Any:
        """The schema of what a link is set to: a symbol's, or a counted object's, inline."""
        given = link.get("def")
        return self.store.registered(given["schema"]) if given is not None else self.schema(link["reference"]["symbol"])

    def member(self, schema: str, member: str, siblings: dict[str, PlainData]) -> Any:
        if schema == "Changes.Change":
            return self
        if schema == "Changes.OfProperty" and member == "mutations":
            return _Value(self.schema(siblings["holder"]).properties[siblings["name"]].schema)
        if schema == "Changes.OfEntry" and member in ("holder", "links"):
            return _Links(self)
        if schema == "Changes.OfEntry" and member == "properties":
            return _EntryProperties(self.linked(siblings["holder"]).adjacencies[siblings["adjacency"]].relation)
        return None


class _Links(_At):
    """A link set, to a symbol or a counted object inline (`Mutations.OfLink.Set`): its definition, within its
    schema."""

    def __init__(self, symbols: _Symbols) -> None:
        self.symbols = symbols

    def member(self, schema: str, member: str, siblings: dict[str, PlainData]) -> Any:
        if schema == "Mutations.OfLink":
            return self
        if schema == "Mutations.OfLink.Set" and member == "def":
            return self
        if schema == "Mutations.OfObject.Def" and member == "mutations":
            return _Object(self.symbols.store.registered(siblings["schema"]), self.symbols)
        return None


class _Object(_At):
    """An object's mutations, a counted object's inline: each property's within its schema, each adjacency's within
    its relation."""

    def __init__(self, schema: Any, symbols: _Symbols) -> None:
        self.schema, self.symbols = schema, symbols

    def member(self, schema: str, member: str, siblings: dict[str, PlainData]) -> Any:
        if schema == "Mutations.OfObject":
            return self
        if schema == "Mutations.OfObject.AsProperty" and member == "mutations":
            return _Value(self.schema.properties[siblings["name"]].schema)
        if schema == "Mutations.OfObject.AsAdjacency" and member == "mutations":
            return _Adjacency(self.schema.adjacencies[siblings["name"]].relation, self.symbols)
        return None


class _Adjacency(_At):
    """An adjacency's mutations: each entry's properties within its relation's, its links set as links are."""

    def __init__(self, relation: Any, symbols: _Symbols) -> None:
        self.relation, self.symbols = relation, symbols

    def member(self, schema: str, member: str, siblings: dict[str, PlainData]) -> Any:
        if schema in ("Mutations.OfAdjacency", "Mutations.OfAdjacency.Insert", "Mutations.OfAdjacency.Remove",
                      "Mutations.OfEntry", "Mutations.OfEntry.Member"):
            return self
        if schema == "Mutations.OfEntry.AsProperty" and member == "mutations":
            return _Value(self.relation.entry.properties[siblings["name"]].schema)
        if schema == "Mutations.OfEntry.AsLink" and member == "mutations":
            return _Links(self.symbols)
        return None


class _EntryProperties(_At):
    """An entry's properties, each within its schema: a container, whose elements are within, not its members."""

    def __init__(self, relation: Any) -> None:
        self.relation = relation

    def element(self, index: Any) -> Any:
        found = self.relation.entry.properties.get(index)
        return None if found is None else _Value(found.schema)


_UNIONS = {"Mutations.OfProperty", "Mutations.OfAny", "Mutations.OfScalar", "Mutations.OfContainer"}
"""The unions of a value's verbs: each verb within what the union is."""

_VERBS = {  # each verb's member that holds a payload, or verbs, by its schema's name and its own, and what it is
    # within: the value's schema, or its part's
    "Mutations.OfProperty.Set value": "self", "Mutations.OfAny.Set value": "self", "Mutations.OfScalar.Set value": "self",
    "Mutations.OfProperty.AsAny mutations": "self", "Mutations.OfAny.AsScalar mutations": "self",
    "Mutations.OfAny.AsContainer mutations": "self", "Mutations.OfAny.AsObject mutations": "members",
    "Mutations.OfAny.AsUnion mutations": "members", "Mutations.OfAny.AsIntersection mutations": "members",
    "Mutations.OfContainer.Insert slice": "self", "Mutations.OfContainer.Slice index": "index",
    "Mutations.OfContainer.Slice items": "element", "Mutations.OfContainer.Remove index": "index",
    "Mutations.OfContainer.Append items": "element", "Mutations.OfContainer.Prepend items": "element",
    "Mutations.OfContainer.AsItems mutations": "element",
}


class _Value(_At):
    """A value's mutations, mbse-schemas' verbs: each payload in them interpreted by the value's schema, or, in a
    container's verbs, by its index's or its element's, and, in a value object's, a union's or an intersection's, by
    its member's."""

    def __init__(self, schema: Any) -> None:
        self.payload = Proxies._deref(schema)

    def member(self, schema: str, member: str, siblings: dict[str, PlainData]) -> Any:
        if schema in _UNIONS:
            return self
        within = _VERBS.get(f"{schema} {member}")
        if within is None:
            return None
        if within == "self":
            return self
        if within == "members":
            return _Members(self.payload)
        return _Value(getattr(self.payload, within))


class _Members(_At):
    """A value object's, a union's or an intersection's members' mutations (`AsProperty`, `AsBranch`, `AsPart`)."""

    def __init__(self, schema: Any) -> None:
        self.schema = schema

    def member(self, schema: str, member: str, siblings: dict[str, PlainData]) -> Any:
        if member == "mutations" and schema in ("Mutations.OfObject.AsProperty", "Mutations.OfUnion.AsBranch",
                                                "Mutations.OfIntersection.AsPart"):
            return _Value(self.schema.properties[siblings["name"]].schema)
        return None
