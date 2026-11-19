"""Changes: what a transaction changed, gathered at its commit as schema data, a journal
([CAP-270: a transaction's changes observed at its commit](mbse:mbse-basis/docs/capabilities/README.md#CAP-270),
[CAP-269: transactions resolved into their effects](mbse:mbse-basis/docs/capabilities/README.md#CAP-269),
[CAP-271: the journal language](mbse:mbse-basis/docs/capabilities/README.md#CAP-271),
[CAP-321: changes gathered as schema data](mbse:mbse-basis/docs/capabilities/CAP-321.md),
[the journals proposal](mbse:mbse-basis/proposals/JOURNALS.md#the-changes-schemas-proposed)).

The journal language's value schemas, which every store holds, its own, as it holds `References` (`install`):

- `Changes.Journal`, a journal: its transactions, in order, a container of `Changes.Transaction` by position. A journal
  is data: built, sliced, written, read and compared as any value is, with no store of its own; its transactions are
  read by iterating it. Whole transactions taken from a journal, in order, are a journal too.
- `Changes.Transaction`, one transaction: its `id`, unique, the uid `Provenance` records it by; its `symbols`, each by
  its name (`Changes.Symbol`), the transaction's own; then its `changes`, in order, each a `Changes.Change`.
- `Changes.Symbol`, an object that exists (A): an object held before, by its `reference` (`References.OfObject`), or a
  new object, by its `schema` (`References.OfSchema`) alone. An object held before is given its `schema` too where its
  path does not imply it, as where objects of several schemas are owned through one relation, so that a reader never
  guesses it.
- `Changes.Change`, a change: the union of the kinds of change, a relation entry's (`entry`, `Changes.OfEntry`) and a
  property's (`property`, `Changes.OfProperty`).
- `Changes.OfEntry`, a relation entry inserted or removed (B): the union of its actions, `Changes.OfEntry.Insert` and
  `Changes.OfEntry.Remove`. Each action is written on its `holder`'s adjacency named `adjacency`, and names its other
  `links`, each by its name, and its `properties`' values.
- `Changes.OfLink`, an object that an entry change names, as `References` names one: a `symbol` of the transaction; an
  object held, by its `reference` (`References.OfObject`); a counted object, which has no reference, by its value
  (`counted`, a `Changes.Counted`: its `schema`, a `References.OfSchema`, and its `properties`' values), found by that
  value or made; or a `parameter` reference in the object's place (`References.OfParameter`).
- `Changes.OfProperty`, a property changed (C): the union of its actions, `Changes.OfProperty.Set`, which gives its
  `holder`'s symbol, the property's `name` and its whole `value`, and `Changes.OfProperty.Clear`, which gives its
  `holder` and `name`. A change within a property's value is
  [CAP-272: surgical mutations of a property's value](mbse:mbse-basis/docs/capabilities/README.md#CAP-272)'s.

Every `Changes` schema is a value object. A value, a property's in a change, an entry's or a counted object's, is a
payload (`Mutations.Payload`), written by the schema of the property it is the value of, and marked with its schema
only where that schema cannot tell it ([PRI-025: never guess the schema](mbse:mbse-basis/docs/PRINCIPLES.md#PRI-025)):
the plain form reads a transaction's symbols first, and each payload by the schema that its holder's schema gives the
property (`_within`), so that a journal is read where the store holds the schemas that its objects are of.

`observe(store, observer)` calls `observer(journal)` after each transaction of `store` that commits having changed
something, a `Changes.Journal` of that one transaction, a value that outlives it, and returns a function that ends the
observing; a transaction that raises, its writes dropped, is observed by none. What a transaction changed is net of what
it undid within itself: its symbols, each object the transaction touched that was held before it, by its reference as
it was, and each owned object it created, by its schema, after its owner's, so that applying finds it by its ownership
entry; then its changes, the relation entries it removed, then those it inserted, each written on the adjacency of one
object it links, then the properties it changed, each set to its value or cleared. An object the transaction deleted is
never named: the entry that owned it is removed by its owner's key for it, written on its owner's adjacency, and what
its deletion removed in cascade, every entry linking it and what it owned, is left to follow from that, as it does in
every store that applies the journal. `store.follow(follower)` gives the same journal as plain data.

`apply(txn, journal)` writes, within the transaction `txn` builds, each transaction of a journal, in order: applied to
the store as it was before them, it makes the same changes, and applied again, it changes nothing. A transaction's
changes are applied as one upsert, which `_upsert` builds through the builders from the `Changes.Transaction`, read
through the visitors: of its symbols, of each object that an entry change names by its reference, and of each counted
object that it names inline, one symbol for each value, whose spec writes its changes where they do not hold.

The changes are gathered from the transaction's proposals just before it commits, after `Provenance` records it and
its ownership is settled, so that what it deleted in cascade, and every entry linking it, is among them; what an object
was before is read from what the store holds as committed. `_gather` builds them as a `Changes.Transaction`, through
its builders, a value that outlives the transaction. A savepoint's changes are gathered alike, relative to the
transaction it is within: what interpreting an input frame changed, which the frame given carries as a journal
(`Transactions.Frame.journal`). An expression's terms, and the entries linking schema objects, are no data, and are left
out.

A cache layer, a store given a layer below, applies to what it holds the journals that the frames the layer below gives
back carry, and those that the layer below's follow gives, as a transaction of its own (`Builders.Store._apply`): to the
objects present in it alone. `_present_only` reads the layer below's `Changes.Transaction` through the visitors, and
builds the one that changes those objects alone, making an object created under one present, and leaving out an entry
that names one not present. What the cache layer writes itself, by builders, it sends below as the
`Changes.Transaction` of the savepoint that wrote it, which the layer below's transaction executes as the mutation
transaction that makes those changes (`_expression`).
"""

from __future__ import annotations

import contextlib
import itertools
import json
from collections.abc import Callable, Iterator
from typing import Any

from . import Paths, Plain, Proxies, References
from . import Schemas as S
from .Builders import _transaction_of
from .Plain import PlainData

__all__ = ["install", "observe", "apply"]


def install(txn: Any) -> Any:
    """The journal language's schemas, defined in the store a transaction writes: `store.transaction(Changes.install)`.
    A store is made by it, after `References.install` and `Mutations.install`, read by the bootstrap (`Builders`); run
    again in a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the store's meta-schemas and basic scalars (78)
    R = txn.References

    def entry(_: Any) -> dict[str, Any]:
        """An entry change's members, an insert's and a remove's alike."""
        return {
            "holder": _.OfLink,  # the object whose adjacency writes it
            "adjacency": S.OfStr,  # the holder's, by name
            "links": S.OfContainer(lambda c: c.index([S.OfStr]).element([_.OfLink])),  # its other links, by name
            "properties": S.OfContainer(lambda c: c.index([S.OfStr]).element([txn.Mutations.Payload])),
        }

    return txn.uid("mbse.Schemas.Changes/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Journal": S.OfContainer, "Transaction": S.OfObject, "Symbol": S.OfObject, "Change": S.OfUnion,
                  "OfEntry": S.OfUnion, "Insert": S.OfObject, "Remove": S.OfObject, "OfProperty": S.OfUnion,
                  "Set": S.OfObject, "Clear": S.OfObject, "OfLink": S.OfUnion, "Counted": S.OfObject})
        .spec([
            lambda _: _.Journal.name("Changes.Journal").index([S.OfInt]).element([_.Transaction]),  # in order
            lambda _: _.Transaction.name("Changes.Transaction").properties({
                "id": S.OfStr,  # unique: the uid Provenance records it by
                "symbols": S.OfContainer(lambda c: c.index([S.OfStr]).element([_.Symbol])),  # by name: its own
                "changes": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.Change])),  # in order
            }),
            lambda _: _.Symbol.name("Changes.Symbol").properties({  # A: an object exists
                "reference": R.OfObject,  # held before
                "schema": R.OfSchema,  # alone, a new one's; else where its path does not imply it
            }),
            lambda _: _.Change.name("Changes.Change").branches([
                lambda t: t.name("entry").schema([_.OfEntry]),
                lambda t: t.name("property").schema([_.OfProperty]),
            ]),
            lambda _: _.OfEntry.name("Changes.OfEntry").branches([  # B: a relation entry inserted or removed
                lambda t: t.name("insert").schema([_.Insert]),
                lambda t: t.name("remove").schema([_.Remove]),
            ]),
            lambda _: _.Insert.name("Changes.OfEntry.Insert").properties(entry(_)),
            lambda _: _.Remove.name("Changes.OfEntry.Remove").properties(entry(_)),
            lambda _: _.OfProperty.name("Changes.OfProperty").branches([  # C: a property set or cleared
                lambda t: t.name("set").schema([_.Set]),
                lambda t: t.name("clear").schema([_.Clear]),
            ]),
            lambda _: _.Set.name("Changes.OfProperty.Set").properties({
                "holder": S.OfStr,  # a symbol
                "name": S.OfStr,
                "value": txn.Mutations.Payload,  # its whole value
            }),
            lambda _: _.Clear.name("Changes.OfProperty.Clear").properties({
                "holder": S.OfStr,  # a symbol
                "name": S.OfStr,
            }),
            lambda _: _.OfLink.name("Changes.OfLink").branches([  # an object an entry change names
                lambda t: t.name("symbol").schema([S.OfStr]),  # a symbol of the transaction
                lambda t: t.name("reference").schema([R.OfObject]),  # an object held, by its reference
                lambda t: t.name("counted").schema([_.Counted]),  # a counted object, by its value
                lambda t: t.name("parameter").schema([R.OfParameter]),  # a parameter reference in its place (CAP-312)
            ]),
            lambda _: _.Counted.name("Changes.Counted").properties({  # no reference: found by its value, or made
                "schema": R.OfSchema,
                "properties": S.OfContainer(lambda c: c.index([S.OfStr]).element([txn.Mutations.Payload])),
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
    store, _ = _transaction_of(txn)
    term = None
    for i, transaction in reversed(list(enumerate(_transactions(journal)))):
        term = _upsert(store, transaction, f"t{i}_", term)
    return txn if term is None else txn.mutations([term])


# --- Reading a `Changes` value through the visitors ---


def _transactions(journal: Any) -> list[Any]:
    """A journal's transactions, in order, each as its visitor."""
    found: list[Any] = []
    journal.as_entries(found.extend)
    return [_object(element) for _, element in found]


def _visited(member: Any) -> Any:
    """The visitor of the value a member holds (`Visitors.OfAny`), or an element, as it is one."""
    if not isinstance(member, Proxies._Property):
        return member
    found: list[Any] = []
    member.as_value(lambda a: found.append(a) or a)
    return found[0]


def _items(member: Any) -> list[tuple[Any, Any]]:
    """The elements of the container a member holds, each with its index, in order; none where it holds none."""
    found: list[tuple[Any, Any]] = []

    def entries(c: Any) -> Any:
        c.as_entries(found.extend)
        return c

    _visited(member).as_container(entries)
    return found


def _object(member: Any) -> Any:
    """The value object a member or an element holds, as its visitor; None where it holds none."""
    found: list[Any] = []
    _visited(member).as_object(lambda o: found.append(o) or o)
    return found[0] if Plain._present(found[0]) else None


def _union(member: Any) -> Any:
    """The union value a member or an element holds, as its visitor."""
    found: list[Any] = []
    _visited(member).as_union(lambda u: found.append(u) or u)
    return found[0]


def _branch(union: Any) -> tuple[str, Any]:
    """The branch a union value holds, by name, and what it holds: a scalar, or a value object's visitor."""
    schema = union.as_schema()
    for branch in [] if schema is None else schema.branches:
        held = getattr(union, branch.name)
        scalar = isinstance(Proxies._deref(branch.schema), S.OfScalar.Data)
        value = held.get() if scalar else held
        if (value is not None) if scalar else Plain._present(value):
            return branch.name, value
    raise ValueError("a union of the journal language holds one of its branches, and one here holds none")


def _payload(member: Any) -> Any:
    """The value a payload holds, a member's or an element's: a scalar, a parameter reference in its place, or the
    visitor of a value object, a union's, an intersection's or a container's value."""
    found: list[Any] = []

    def read(a: Any) -> Any:
        a.as_parameter(lambda p: found.extend([p] if Plain._present(p) else []) or p)
        a.as_scalar(lambda s: found.extend([] if s.get() is None else [s.get()]) or s)
        for select in ("as_object", "as_union", "as_intersection", "as_container"):
            getattr(a, select)(lambda v: found.extend([v] if Plain._present(v) else []) or v)
        return a

    read(_visited(member))
    return found[0]


def _path(store: Any, reference: Any) -> PlainData:
    """The path of an object's reference, or a schema object's, as plain data, as `Plain` writes it."""
    return Plain.ToPlain(store)(reference.as_schema(), reference)["path"]


def _schema_of(store: Any, reference: Any) -> Any:
    """The schema a schema object's reference (`References.OfSchema`) designates in `store`."""
    return Plain._by_path(store, _path(store, reference), ())


# --- Applying: a `Changes.Transaction` as the mutation transaction that makes its changes ---


def _upsert(store: Any, transaction: Any, prefix: str, then: Any) -> Callable[[Any], Any]:
    """A `Changes.Transaction` as the upsert that makes its changes, a term's Spec, built through the builders: under
    its id, of its symbols, each named with `prefix` before its name, of an object held named by its reference, and of
    each counted object written inline, one symbol for each value, bound to its schema, whose values the spec writes
    after its changes, so that it is found by its value, or made; `then`, where given, the term after it."""
    uid = transaction.id.get()
    symbols: dict[str, Any] = {}
    for name, element in _items(transaction.symbols):
        symbol = _object(element)
        reference = _object(symbol.reference)
        symbols[prefix + name] = reference if reference is not None else _schema_of(store, _object(symbol.schema))
    inline: dict[str, str] = {}  # each symbol bound to an object named inline, by what names it
    values: list[Callable[[Any], Any]] = []

    def bound(key: str, kind: str, to: Any) -> str:
        """The symbol an object named inline is bound to, one for each reference or value, declared where first
        named."""
        if key not in inline:
            inline[key] = next(name for n in itertools.count(len(inline))
                               if (name := f"{prefix}{kind}{n}") not in symbols)
            symbols[inline[key]] = to
        return inline[key]

    def named(link: Any, holder: bool = False) -> Callable[[Any], Any]:
        """What an entry change's link names, as a spec links it: a symbol's object, or a parameter reference, which
        names no object whose adjacency writes the entry, as its holder must."""
        kind, held = _branch(_union(link))
        if kind == "parameter" and holder:
            raise ValueError("an entry change is written on an object's adjacency: its holder names an object")
        if kind == "parameter":
            return lambda _: held
        if kind == "symbol":
            name = prefix + held
        elif kind == "reference":
            name = bound(json.dumps(["r", _path(store, held)], sort_keys=True), "r", held)
        else:
            schema = _schema_of(store, _object(held.schema))
            given = {n: _payload(v) for n, v in _items(held.properties)}
            key = json.dumps(["c", store.name_of(schema), {n: Plain.ToPlain(store)(schema.properties[n].schema, v)
                                                           for n, v in given.items()}], sort_keys=True)
            fresh = key not in inline
            name = bound(key, "c", schema)
            if fresh:
                values.extend(lambda _, n=n, v=v: getattr(getattr(_, name), n)(v) for n, v in given.items())
        return lambda _: getattr(_, name)

    spec: list[Callable[[Any], Any]] = []
    for _, element in _items(transaction.changes):
        kind, change = _branch(_union(element))
        verb, body = _branch(change)
        if kind == "property":
            value = _payload(body.value) if verb == "set" else None
            spec.append(lambda _, s=prefix + body.holder.get(), n=body.name.get(), v=value: getattr(getattr(_, s), n)(v))
            continue
        holder = named(body.holder, True)
        links = {n: named(link) for n, link in _items(body.links)}
        properties = {n: _payload(v) for n, v in _items(body.properties)}

        def fill(e: Any, _: Any, links: dict[str, Any] = links, properties: dict[str, Any] = properties) -> Any:
            for n, link in links.items():
                e = getattr(e, n)(link(_))
            for n, v in properties.items():
                e = getattr(e, n)(v)
            return e

        spec.append(lambda _, h=holder, a=body.adjacency.get(), v=verb, f=fill: getattr(h(_), a)(
            lambda adv: getattr(adv, v)(lambda e: f(e, _))))

    def upsert(u: Any) -> Any:
        u = (u if uid is None else u.key(uid)).exists([lambda p: p.symbols(symbols).spec(spec + values)])
        return u if then is None else u.then([then])

    return lambda mu: mu.upsert(upsert)


def _expression(store: Any, transaction: Any) -> Any:
    """A `Changes.Transaction` of `store`'s as the mutation transaction that makes its changes, one upsert under its id,
    built through the builders outside the transaction open's proposals, as any expression is."""
    uid = transaction.id.get()
    with _as_committed(store):
        return store.Mutations.OfTransaction(lambda t: (t if uid is None else t.uid(uid)).mutations([
            _upsert(store, transaction, "", None)]))



# --- Gathering: what a transaction changed, as a `Changes.Transaction`, built through the builders ---


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


def _value(store: Any, holder: Any, name: str) -> tuple[PlainData, Any]:
    """A property's value, as plain, as its schema writes it, to compare, and as the value itself; each None where the
    object holds none."""
    value = store.member(holder, name)
    if value is None:
        return None, None
    value = Proxies._durable(value)
    if Proxies._is_parameter(value):  # a parameter in its place (CAP-312)
        return Plain._marked(store, value), value
    return Plain.ToPlain(store)(_schema(holder).properties[name].schema, value), value


def _data(store: Any, entry: Any) -> bool:
    """Whether an entry links data alone, objects or parameter references in their place: one that links a schema
    object, an extension's, is no data (CAP-315), nor one that links an expression's term, of a schema the store was
    made holding (`Mutations`), and either is left out of what a transaction changed."""
    return all((isinstance(x, Proxies._ObjectData) and not store.framework(_schema(x))) or Proxies._is_parameter(x)
               for x in entry._links.values())


def _at(schema: Any) -> Callable[[Any], Any]:
    """A schema object's reference (`References.OfSchema`) to `schema`, as a Spec."""
    return lambda r: r.path(Paths.of(schema))


def _gather(store: Any, proposals: Any, uid: str) -> Any:
    """What the transaction whose proposals these are changed, gathered just before it commits, as a
    `Changes.Transaction` of id `uid`, built through the builders, a value that outlives the transaction; None where
    it changed nothing."""
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
            before = {name: None if id(holder) in made else _value(store, holder, name)[0] for name in names}
        changed += [(holder, name, after[name][1]) for name in names if before[name] != after[name][0]]
    if not (removed or inserted or changed):
        return None
    symbols: dict[str, Callable[[Any], Any]] = {}  # each a `Changes.Symbol`'s Spec, in the order first named
    named: dict[Any, str] = {}  # by the object

    def symbol(x: Any) -> str:
        """The symbol of an object the transaction changed, declared where first needed: a created owned object's after
        its owner's."""
        found = named.get(Proxies._link_key(x))
        if found is not None:
            return found
        if id(x) in made:
            for entry in Proxies._owner_entries(x):
                for owner in entry._links.values():
                    if owner is not x:
                        symbol(owner)
            spec = lambda s, schema=_schema(x): s.schema(_at(schema))
        else:
            with _before(store, proposals):
                spec = _held_symbol(store, x, References.of(store, x))
        name = named[Proxies._link_key(x)] = f"o{len(named)}"
        symbols[name] = spec
        return name

    def link(x: Any) -> Callable[[Any], Any]:
        """What an entry change names an object by, a `Changes.OfLink`'s Spec: a parameter reference, as itself
        (CAP-312); a counted object, by its value, which it never changes; else its symbol."""
        if Proxies._is_parameter(x):
            return lambda link_: link_.parameter(x)
        if Proxies._counted(x):
            values = {n: v for n in _schema(x).properties if (v := _value(store, x, n)[1]) is not None}
            return lambda link_, schema=_schema(x): link_.counted(lambda c: c.schema(_at(schema)).properties(values))
        name = symbol(x)
        return lambda link_: link_.symbol(name)

    changes: list[Callable[[Any], Any]] = []

    def entry_change(verb: str, holder: Callable[[Any], Any], adjacency: str, links: dict[str, Any],
                     properties: dict[str, Any]) -> None:
        def body(b: Any) -> Any:
            b = b.holder(holder).adjacency(adjacency)
            b = b.links(links) if links else b
            return b.properties(properties) if properties else b

        changes.append(lambda c: c.entry(lambda e: getattr(e, verb)(body)))

    for entry in removed.values():  # a deleted object's: its owning entry, by its key; the rest follows from that
        lost = [link_ for link_, x in entry._links.items() if id(x) in deleted]
        if not lost:
            continue
        owned = _owning(entry, lost, store)
        if owned is not None:
            owner, me = owned
            keys = {k: entry._properties[k] for k in Proxies._key_names(entry._relation, me, lost[0])}
            entry_change("remove", link(entry._links[me]), owner, {}, keys)
    for verb, entries in (("remove", [e for e in removed.values() if not any(id(x) in deleted
                                                                           for x in e._links.values())]),
                          ("insert", inserted.values())):
        for entry in entries:
            writer, adjacency = _writer(entry, made)
            others = {other: link(x) for other, x in entry._links.items() if other != writer}
            entry_change(verb, link(entry._links[writer]), adjacency, others, dict(entry._properties))
    for holder, name, value in changed:
        if Proxies._counted(holder):  # found by its value, which it never changes
            continue
        s = symbol(holder)
        changes.append(lambda c, s=s, n=name, v=value: c.property(
            lambda p: p.clear(lambda b: b.holder(s).name(n)) if v is None else p.set(
                lambda b: b.holder(s).name(n).value(v))))
    return store.Changes.Transaction(lambda t: t.id(uid).symbols(symbols).changes(changes))


def _held_symbol(store: Any, x: Any, reference: Any) -> Callable[[Any], Any]:
    """The `Changes.Symbol` of an object held before, a Spec: its reference, and its schema too where its path does not
    imply it, as where objects of several schemas are owned through one relation, so that a reader never guesses it."""
    try:
        implied = References._implied(store, _path(store, reference))
    except LookupError:
        implied = None
    if _schema(x) is implied:
        return lambda s: s.reference(reference)
    return lambda s: s.reference(reference).schema(_at(_schema(x)))


def _writer(entry: Any, made: dict[int, Any]) -> tuple[str, str]:
    """The link, and its object's adjacency by name, that writes an entry: preferably an object held before, not
    counted, so that what the entry links is found through it."""
    choices = [(Proxies._counted(x) or id(x) in made, link, name)
               for link, x in entry._links.items() if not Proxies._is_parameter(x)
               for name, adjacency in _schema(x).adjacencies.items()
               if adjacency.relation is entry._relation and adjacency.me == link]
    if not choices:
        raise ValueError(f"no object an entry of {entry._relation.name!r} links has an adjacency to it by name, so "
                         "that its change cannot be written: name one")
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
                         "its change cannot remove what the entry owned: name one")
    return names[0], me


def _journal(store: Any, transactions: list[Any]) -> Any:
    """A `Changes.Journal` of `store`'s of these transactions, in order, built through the builders: a value that
    outlives them."""
    def fill(j: Any) -> Any:
        for i, transaction in enumerate(transactions):
            j.at(i).as_object(transaction)
        return j

    return store.Changes.Journal(fill)


# --- A cache layer: a layer below's changes, to the objects it holds alone ---


def _present_only(store: Any, transaction: Any) -> tuple[Any, list[Any]]:
    """A `Changes.Transaction` of the layer below's, read in `store`, made to change only the objects present in it
    ([CAP-285: writes through, others' writes in](mbse:mbse-basis/docs/capabilities/README.md#CAP-285), its second decision): each object is named by its path, an object it created by its
    owner's and its owning entry's keys, and is present where the store holds it, or where it was created owned by one
    present, which applying it creates; a counted object is found by its value, or made. A property of an object present
    is set; an entry is written where every object it names is present, and left out otherwise, nothing being made that
    is not present. Gives that transaction, built through the builders, None where it changes nothing present; and the
    objects present an entry left out names, whose entries the store no longer holds all of (`_complete`)."""
    symbols = {name: _object(element) for name, element in _items(transaction.symbols)}
    schemas: dict[str, Any] = {}  # each symbol's schema: one created's, or an object present's
    present: set[str] = set()
    held: dict[str, Any] = {}
    for name, symbol in symbols.items():
        reference = _object(symbol.reference)
        if reference is None:
            schemas[name] = _schema_of(store, _object(symbol.schema))
            continue
        x = store._present(_path(store, reference))
        if isinstance(x, Proxies._ObjectData):
            present.add(name)
            held[name], schemas[name] = x, _schema(x)

    def at(link: Any) -> tuple[str, str | None, Any, Any]:
        """What an entry change's link names: its kind; its symbol, where it is one; the object present it names, where
        any; and its schema, where known."""
        kind, given = _branch(_union(link))
        if kind == "symbol":
            return kind, given, held.get(given), schemas.get(given)
        if kind == "reference":
            x = store._present(_path(store, given))
            return (kind, None, x, _schema(x)) if isinstance(x, Proxies._ObjectData) else (kind, None, None, None)
        return kind, None, None, _schema_of(store, _object(given.schema)) if kind == "counted" else None

    def known(link: tuple[str, str | None, Any, Any]) -> bool:
        """Whether a link names an object present: a symbol present, an object held by its reference, or a counted
        object, found by its value or made; a parameter reference names none, and is kept."""
        kind, name, x, _ = link
        return name in present if kind == "symbol" else x is not None or kind != "reference"

    changes: list[tuple[Any, str, str, Any, Any, dict[str, Any]]] = []  # each: its value, kind, action, holder, links
    for _, element in _items(transaction.changes):
        value = _union(element)
        kind, change = _branch(value)
        verb, body = _branch(change)
        if kind == "property":
            changes.append((value, kind, verb, body.holder.get(), None, {}))
            continue
        changes.append((value, kind, verb, at(body.holder), body.adjacency.get(),
                        {name: at(link) for name, link in _items(body.links)}))

    def owned(name: str) -> bool:
        """Whether an entry the transaction inserts owns the object it created a symbol names, written on the
        adjacency of an object present."""
        for _, kind, verb, holder, adjacency, links in changes:
            if kind != "entry" or verb != "insert" or holder[3] is None or not known(holder):
                continue
            relation = holder[3].adjacencies[adjacency].relation
            symbols_of = {link: symbol for link, (_, symbol, _, _) in links.items()}
            if any(symbols_of.get(a.me) == name for a in Proxies._owner_adjacencies(schemas[name]) if a.relation is relation):
                return True
        return False

    created = [name for name, symbol in symbols.items() if _object(symbol.reference) is None]
    grown = True
    while grown:  # an object created owned by one present: present once applied
        grown = False
        for name in created:
            if name not in present and owned(name):
                present.add(name)
                grown = True
    kept: list[Any] = []
    lost: list[Any] = []
    used: set[str] = set()  # the symbols what is kept names
    for value, kind, _, holder, _, links in changes:
        if kind == "property":
            if holder in present:
                kept.append(value)
                used.add(holder)
            continue
        named = [holder, *links.values()]
        if all(known(link) for link in named):
            kept.append(value)
            used.update(link[1] for link in named if link[1] is not None)
        else:  # it names one not present: left out, and each present it names holds its entries no more all
            lost += [link[2] for link in named if link[2] is not None]
    if not kept:
        return None, lost
    uid = transaction.id.get()
    return store.Changes.Transaction(lambda t: (t if uid is None else t.id(uid)).symbols(
        {name: symbol for name, symbol in symbols.items() if name in used}).changes(kept)), lost


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


_UNIONS = {"Changes.Change", "Changes.OfEntry", "Changes.OfProperty", "Changes.OfLink"}
"""The unions of a transaction's changes, and of what an entry change names: each branch within what the union is."""

_ENTRIES = {"Changes.OfEntry.Insert", "Changes.OfEntry.Remove"}


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
        """The schema of the object an entry change names: a symbol's, an object's held by its reference, as the store
        holds it or its path implies it, or a counted object's, inline."""
        ((kind, given),) = link.items()
        if kind == "symbol":
            return self.schema(given)
        if kind == "counted":
            return Plain._by_path(self.store, given["schema"]["path"], ())
        held = self.store._present(given["path"])
        return _schema(held) if isinstance(held, Proxies._ObjectData) else References._implied(self.store, given["path"])

    def member(self, schema: str, member: str, siblings: dict[str, PlainData]) -> Any:
        if schema in _UNIONS or (schema in _ENTRIES and member in ("holder", "links")):
            return self
        if schema == "Changes.OfProperty.Set" and member == "value":
            return _Value(self.schema(siblings["holder"]).properties[siblings["name"]].schema)
        if schema in _ENTRIES and member == "properties":
            return _Properties(self.linked(siblings["holder"]).adjacencies[siblings["adjacency"]].relation.entry)
        if schema == "Changes.Counted" and member == "properties":
            return _Properties(Plain._by_path(self.store, siblings["schema"]["path"], ()))
        return None


class _Properties(_At):
    """The properties of an entry, or of a counted object, each within its schema: a container, whose elements are
    within, not its members."""

    def __init__(self, schema: Any) -> None:
        self.schema = schema

    def element(self, index: Any) -> Any:
        found = self.schema.properties.get(index)
        return None if found is None else _Value(found.schema)


class _Value(_At):
    """A property's value, a payload: interpreted by the property's schema."""

    def __init__(self, schema: Any) -> None:
        self.payload = Proxies._deref(schema)
