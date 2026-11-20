"""Provenance: the records of the transactions a store executes, who executed them, when and from where
([CAP-134: transactions recorded with provenance](mbse:mbse-basis/docs/capabilities/CAP-134.md)).

Normal schemas, installed before use: `store.transaction(Provenance.install)`. `Provenance.OfTransaction` is the record
of one executed transaction, owned by the singleton `Provenance.Transactions`, keyed by the transaction's `uid`: its
`when`, UTC ISO 8601 text, and its `where`, a `Provenance.OfWhere`, where given. `Provenance.OfSession` is the session
it was executed in (`Provenance.InSession`), owned by `Provenance.Sessions`, keyed by its `id`: its `started`, `locale`
and `device`, and its one identity (`Provenance.Who`), a `Provenance.OfIdentity` owned by `Provenance.Identities`, keyed
by its `name`. `Provenance.CreatedBy` links an object to the transaction that created it, `Provenance.ModifiedBy` to the
latest that wrote it after, replaced by each later one: the tail, not a history.

`extend(txn, schemas)` gives each reference object schema named anonymous adjacencies to `CreatedBy` and `ModifiedBy`
through `object`: the app decides which of its schemas have a history. The executor records, at commit and within the
same transaction, every transaction that creates or writes an object, where the store had `Provenance` installed when it
began (`_record`), as the lowest layer of any stack records it, through its interpreter (`record`): from what its
expression gives (`Mutations.OfTransaction`'s `when`, `session` and `where`), so that replaying a journal makes the same
records, found again by `uid`; an imperative scope's with placeholder data.
"""

from __future__ import annotations

import datetime
import uuid
from collections.abc import Iterable
from typing import Any

from . import Plain, Proxies
from . import Schemas as S

__all__ = ["install", "extend", "record"]

UNKNOWN = "unknown"
"""The placeholder of a transaction that names no session, or no identity: its session's `id`, its identity's `name`
(provenance 3 in [CAP-134: transactions recorded with provenance](mbse:mbse-basis/docs/capabilities/CAP-134.md#decided); tech debt)."""


def install(txn: Any) -> Any:
    """The records of executed transactions, their sessions and identities, defined in the store a transaction writes:
    `store.transaction(Provenance.install)`. Run again in a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the store's meta-schemas and basic scalars (78)
    return txn.uid("mbse.Schemas.Provenance/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({
            "OfWhere": S.OfObject, "InSessions": S.OfRelation, "Sessions": S.OfObject, "OfSession": S.OfObject,
            "InSession": S.OfRelation, "InTransactions": S.OfRelation, "Transactions": S.OfObject,
            "OfTransaction": S.OfObject, "InIdentities": S.OfRelation, "Identities": S.OfObject,
            "OfIdentity": S.OfObject, "Who": S.OfRelation, "CreatedBy": S.OfRelation, "ModifiedBy": S.OfRelation,
        })
        .spec([
            lambda _: _.OfWhere.name("Provenance.OfWhere").properties({  # a transaction's geolocation, where given
                "latitude": S.OfFloat,
                "longitude": S.OfFloat,
            }),
            lambda _: _.InSessions.name("Provenance.InSessions").links([
                lambda t: t.name("directory"),
                lambda t: t.name("session"),
            ]).properties({"id": S.OfStr}).uniques([["directory", "id"], ["session"]]),
            lambda _: _.Sessions.name("Provenance.SessionDirectory").ref(True).singleton("Provenance.Sessions")
            .adjacencies({"sessions": lambda a: a.relation([_.InSessions]).me("directory")}),
            lambda _: _.OfSession.name("Provenance.OfSession").ref(True).properties({
                "started": S.OfStr,  # UTC ISO 8601: when the session was first recorded
                "locale": S.OfStr,  # an interactive session's, e.g. "en-GB"
                "device": S.OfStr,
            }).adjacencies([
                lambda t: t.name("directory").relation([_.InSessions]).me("session").owner(True),
                lambda t: t.name("transactions").relation([_.InSession]).me("session"),
                lambda t: t.name("who").relation([_.Who]).me("session"),
            ]),
            lambda _: _.InSession.name("Provenance.InSession").links([
                lambda t: t.name("transaction"),
                lambda t: t.name("session"),
            ]).uniques("session"),  # one session per transaction
            lambda _: _.InTransactions.name("Provenance.InTransactions").links([
                lambda t: t.name("directory"),
                lambda t: t.name("transaction"),
            ]).properties({"uid": S.OfStr}).uniques([["directory", "uid"], ["transaction"]]),
            lambda _: _.Transactions.name("Provenance.TransactionDirectory").ref(True)
            .singleton("Provenance.Transactions")
            .adjacencies({"transactions": lambda a: a.relation([_.InTransactions]).me("directory")}),
            lambda _: _.OfTransaction.name("Provenance.OfTransaction").ref(True).properties({
                "when": S.OfStr,  # UTC ISO 8601, e.g. "2026-10-26T14:30:05Z"
                "where": _.OfWhere,
            }).adjacencies([
                lambda t: t.name("directory").relation([_.InTransactions]).me("transaction").owner(True),
                lambda t: t.name("session").relation([_.InSession]).me("transaction"),
                lambda t: t.name("created").relation([_.CreatedBy]).me("transaction"),
                lambda t: t.name("modified").relation([_.ModifiedBy]).me("transaction"),
            ]),
            lambda _: _.InIdentities.name("Provenance.InIdentities").links([
                lambda t: t.name("directory"),
                lambda t: t.name("identity"),
            ]).properties({"name": S.OfStr}).uniques([["directory", "name"], ["identity"]]),
            lambda _: _.Identities.name("Provenance.IdentityDirectory").ref(True).singleton("Provenance.Identities")
            .adjacencies({"identities": lambda a: a.relation([_.InIdentities]).me("directory")}),
            lambda _: _.OfIdentity.name("Provenance.OfIdentity").ref(True).adjacencies([
                lambda t: t.name("directory").relation([_.InIdentities]).me("identity").owner(True),
                lambda t: t.name("sessions").relation([_.Who]).me("identity"),
            ]),
            lambda _: _.Who.name("Provenance.Who").links([
                lambda t: t.name("session"),
                lambda t: t.name("identity"),
            ]).uniques("identity"),  # one identity per session
            lambda _: _.CreatedBy.name("Provenance.CreatedBy").links([
                lambda t: t.name("object"),
                lambda t: t.name("transaction"),
            ]).uniques("transaction"),  # one creating transaction per object
            lambda _: _.ModifiedBy.name("Provenance.ModifiedBy").links([
                lambda t: t.name("object"),
                lambda t: t.name("transaction"),
            ]).uniques("transaction"),  # one per object: the latest write, replaced by the next
        ])]))])


def extend(txn: Any, schemas: Any) -> Any:
    """Gives each reference object schema of `schemas` (each a schema object, or its name as a path, `txn.work.Comment`)
    an anonymous adjacency to `Provenance.CreatedBy` and to `Provenance.ModifiedBy` through `object`, so that it has no
    member and the executor links its objects to the transactions that create and write them; the transaction that
    does, in the store a transaction writes: `store.transaction(lambda t: Provenance.extend(t, [t.work.Comment]))`. An
    app's install calls it with the schemas whose history it wants, after its own and `Provenance.install`; run again,
    it writes nothing."""
    P = txn.Provenance
    try:
        P.CreatedBy.as_schema()
    except LookupError:
        raise LookupError("Provenance.extend: the store has no Provenance installed; install it first, "
                          "store.transaction(Provenance.install)") from None
    names = []
    for given in schemas:
        schema = Proxies._deref(given)
        if not isinstance(schema, S.OfObject.Data) or not schema.ref:
            shown = schema.name if isinstance(getattr(schema, "name", None), str) else given
            raise TypeError(f"Provenance.extend takes reference object schemas: {shown!r} is not one")
        names.append(schema.name)
    symbols = {f"s{index}": txn.Schemas.OfObject for index in range(len(names))}
    return txn.mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p.symbols(symbols).spec([
        lambda _, symbol=symbol, name=name: getattr(_, symbol).name(name).adjacencies([
            lambda t: t.relation([P.CreatedBy]).me("object"),  # anonymous: no member on the object
            lambda t: t.relation([P.ModifiedBy]).me("object"),
        ]) for symbol, name in zip(symbols, names)])]))])


# --- The executor's records ---


def _now() -> str:
    """The time now, as UTC ISO 8601 text to the second: `when` at commit, where the expression gives none."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _extended(store: Any, schema: Any) -> bool:
    """Whether `extend` gave an object schema its adjacency to `Provenance.CreatedBy`."""
    created_by = store.registered("Provenance.CreatedBy")
    return any(a.relation is created_by and a.me == "object" for a in schema.anonymous)


def _record(store: Any, proposals: Any) -> None:
    """Records the transaction whose proposals these are, at its commit, within it, where the store had `Provenance`
    installed when it began: a store in memory's, by `record`, as every layer's is, the objects it created and those
    it wrote through their builders given it. An imperative scope has no expression: its record has placeholder data
    (provenance 3 in [CAP-134: transactions recorded with provenance](mbse:mbse-basis/docs/capabilities/CAP-134.md#decided)), a `uid` the store makes, `when` at commit, the session and identity `unknown`."""
    from . import Transactions

    if "Provenance.OfTransaction" not in proposals.saved["_schemas"]:
        return
    created = list(proposals.created.values())
    written = [target for key, target in proposals.written.items() if key not in proposals.created]
    record(Transactions.InMemory(store), proposals.expression, created, written)


def record(interpreter: Any, expression: Any, created: Iterable[Any], written: Iterable[Any]) -> None:
    """Records the transaction open in the layer `interpreter` interprets, within it, at its commit, where its store has
    `Provenance` installed, and the transaction created an object, one of `created`, or wrote one, one of `written`,
    each as the interpreter's hooks give it: the lowest layer of a stack records each transaction, once, through its
    interpreter's reads and writes alone, a store in memory's (`Transactions.InMemory`) and any other's alike.
    `expression`, the transaction's first, a `Mutations.OfTransaction`, gives its `when`, `session` and `where`; None,
    an imperative scope's, gives placeholders. Its uid is the interpreter's (`uid`).

    The record is found by its uid in `Provenance.Transactions`, else made, with its `when` and `where`; where made, its
    session, found by its `id`, else made with its `started`, `locale` and `device`, and its identity through `Who`,
    found by its name, else made; and `InSession`. Each object of a schema `extend` extended is linked by `CreatedBy`
    where the transaction created it, else by `ModifiedBy`, the one it held replaced."""
    store = interpreter.store
    try:
        records = store.registered("Provenance.OfTransaction")
    except LookupError:
        return
    created, written = list(created), list(written)
    if not created and not written:
        return
    uid = interpreter.uid()
    found = _directed(interpreter, "Provenance.Transactions", "transactions", "uid", uid)
    made = found if found is not None else _made_record(interpreter, expression, uid)
    for target in created:
        if _extended(store, interpreter.schema_of(target)):
            interpreter.insert(made, records, "created", {"object": target}, {})
    for target in written:
        if not _extended(store, interpreter.schema_of(target)):
            continue
        held = [entry for entry in interpreter.linking(target, store.registered("Provenance.ModifiedBy"))
                if interpreter.link(entry, "object") is target]
        if [interpreter.link(entry, "transaction") for entry in held] == [made]:
            continue
        for entry in held:  # the tail: the one it held, replaced
            old = interpreter.link(entry, "transaction")
            interpreter.remove(old, records, "modified", [
                index for index, other in enumerate(interpreter.entries(old, records, "modified"))
                if interpreter.link(other, "object") is target])
        interpreter.insert(made, records, "modified", {"object": target}, {})


def _directory(interpreter: Any, singleton: str, adjacency: str) -> tuple[Any, Any, str]:
    """A directory singleton, its schema, and the link by which its adjacency's entries link what it holds."""
    directory = interpreter.designated({"singleton": singleton, "next": {"target": {}}})
    schema = interpreter.schema_of(directory)
    member = schema.adjacencies[adjacency]
    (link,) = [link for link in member.relation.entry.links if link != member.me]
    return directory, schema, link


def _directed(interpreter: Any, singleton: str, adjacency: str, key: str, value: str) -> Any:
    """What a directory singleton holds under the key `value`, through its adjacency; None where it holds none."""
    directory, schema, link = _directory(interpreter, singleton, adjacency)
    entry = schema.adjacencies[adjacency].relation.entry
    return next((interpreter.link(held, link) for held in interpreter.entries(directory, schema, adjacency)
                 if interpreter.value(held, entry, key) == (True, value)), None)


def _filed(interpreter: Any, singleton: str, adjacency: str, key: str, value: str, made: Any) -> Any:
    """Gives an object its entry in a directory singleton, keyed by `value`."""
    directory, schema, link = _directory(interpreter, singleton, adjacency)
    interpreter.insert(directory, schema, adjacency, {link: made}, {key: value})
    return made


def _given(store: Any, value: Any, name: str) -> Any:
    """A member of a value an expression gives (its `when`, its `session`, its `where`), as plain data; None where
    either is absent."""
    held = None if value is None else store.member(value, name)
    if held is None:
        return None
    return Plain.ToPlain(store)(Proxies._deref(value).as_schema().properties[name].schema, held)


def _uid(store: Any, proposals: Any) -> str:
    """The uid of the transaction whose proposals these are: its expression's, where it gives one, else one the store
    makes, once, so that what records it (`_record`) and what observes it (`Changes`) know it by the same one, whether
    or not the store has `Provenance` installed."""
    if proposals.uid is None:
        expression = proposals.expression
        proposals.uid = (None if expression is None else store.member(expression, "uid")) or str(uuid.uuid4())
    return proposals.uid


def _made_record(interpreter: Any, expression: Any, uid: str) -> Any:
    """A transaction's record, made, with its session, found or made, and the session's identity."""
    store = interpreter.store
    when = _given(store, expression, "when") or _now()
    where, session = _given(store, expression, "where"), _given(store, expression, "session") or {}
    if _given(store, expression, "session") is not None and session.get("id") is None:
        raise ValueError("a transaction's session has no id: a service gives it, and who, before executing it")
    values = {"when": {"set": {"value": when}}}
    if where is not None:
        values["where"] = {"set": {"value": where}}
    records = store.registered("Provenance.OfTransaction")
    record = _filed(interpreter, "Provenance.Transactions", "transactions", "uid", uid,
                    interpreter.create(records, values))
    sid, who = session.get("id") or UNKNOWN, session.get("who") or UNKNOWN
    found = _directed(interpreter, "Provenance.Sessions", "sessions", "id", sid)
    identity = _directed(interpreter, "Provenance.Identities", "identities", "name", who)
    sessions = store.registered("Provenance.OfSession")
    if found is None:
        given = {name: {"set": {"value": session[name]}} for name in ("locale", "device") if session.get(name) is not None}
        found = _filed(interpreter, "Provenance.Sessions", "sessions", "id", sid,
                       interpreter.create(sessions, {"started": {"set": {"value": when}}, **given}))
        if identity is None:
            identity = _filed(interpreter, "Provenance.Identities", "identities", "name", who,
                              interpreter.create(store.registered("Provenance.OfIdentity"), {}))
        interpreter.insert(found, sessions, "who", {"identity": identity}, {})
    elif [interpreter.link(entry, "identity") for entry in interpreter.entries(found, sessions, "who")] != [identity]:
        raise ValueError(f"session {sid!r} is another identity's, not {who!r}'s: a session has one identity "
                         "(Provenance.Who)")
    interpreter.insert(record, records, "session", {"session": found}, {})
    return record
