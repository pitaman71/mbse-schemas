"""Provenance: the records of the transactions a store executes, who executed them, when and from where
(docs/proposals/provenance; FRAMEWORK.md, Resolved, Provenance).

Normal schemas, installed before use: `store.transaction(Provenance.install)`. `Provenance.OfTransaction` is the record
of one executed transaction, owned by the singleton `Provenance.Transactions`, keyed by the transaction's `uid`: its
`when`, UTC ISO 8601 text, and its `where`, a `Provenance.OfWhere`, where given. `Provenance.OfSession` is the session
it was executed in (`Provenance.InSession`), owned by `Provenance.Sessions`, keyed by its `id`: its `started`, `locale`
and `device`, and its one identity (`Provenance.Who`), a `Provenance.OfIdentity` owned by `Provenance.Identities`, keyed
by its `name`. `Provenance.CreatedBy` links an object to the transaction that created it, `Provenance.ModifiedBy` to the
latest that wrote it after, replaced by each later one: the tail, not a history.

`extend(txn, schemas)` gives each reference object schema named anonymous adjacencies to `CreatedBy` and `ModifiedBy`
through `object`: the app decides which of its schemas have a history. The executor records, at commit and within the
same transaction, every transaction that creates or writes an object, where the store had `Provenance` installed when
it began (`_record`): from what its expression gives (`Mutations.OfTransaction`'s `when`, `session` and `where`), so
that replaying a journal makes the same records, found again by `uid`; an imperative scope's with placeholder data.
"""

from __future__ import annotations

import datetime
import uuid
from typing import Any

from . import Proxies
from . import Schemas as S

__all__ = ["install", "extend"]

UNKNOWN = "unknown"
"""The placeholder of a transaction that names no session, or no identity: its session's `id`, its identity's `name`
(Decided, 3; tech debt)."""


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


def _held(store: Any, relation: str, directory: str, key: str, value: str) -> Any:
    """The object a directory singleton holds under the key `value`, through its entries of `relation`; None where it
    holds none."""
    held = store.registered(relation)
    other = next(link for link in held.entry.links if link != "directory")
    return next((entry._links[other] for entry in Proxies._linking(held, "directory", store.singleton(directory), store)
                 if entry._properties.get(key) == value), None)


def _link(store: Any, relation: str, links: dict[str, Any], properties: dict[str, Any] | None = None) -> None:
    """Adds an entry of the relation registered as `relation`."""
    held = store.registered(relation)
    Proxies._add_entry(held, Proxies._Entry(held, links, properties or {}), store)


def _place(store: Any, made: Any, relation: str, directory: str, key: str, value: str) -> Any:
    """Gives an object its entry in a directory singleton, keyed by `value`."""
    other = next(link for link in store.registered(relation).entry.links if link != "directory")
    _link(store, relation, {"directory": store.singleton(directory), other: made}, {key: value})
    return made


def _given(store: Any, value: Any, name: str) -> Any:
    """A property of a value object an expression gives (its `session`, its `where`); None where either is absent."""
    return None if value is None else store.member(value, name)


def _record(store: Any, proposals: Any) -> None:
    """Records the transaction whose proposals these are, at its commit, within it, where the store had `Provenance`
    installed when it began and the transaction created or wrote an object through its builder: the transaction's
    record, found by its `uid`, else made, with its `when` and `where`; where made, its session, found by its `id`,
    else made with its `started`, `locale` and `device`, and its identity through `Who`, found by its name, else made;
    and `InSession`. Each object of a schema `extend` extended is linked by `CreatedBy` where the transaction created
    it, else by `ModifiedBy`, the one it held replaced. An imperative scope has no expression: its record has
    placeholder data (Decided, 3), a `uid` the store makes, `when` at commit, the session and identity `unknown`."""
    if "Provenance.OfTransaction" not in proposals.saved["_schemas"]:
        return
    created = list(proposals.created.values())
    written = [target for key, target in proposals.written.items() if key not in proposals.created]
    if not created and not written:
        return
    expression = proposals.expression
    uid = (None if expression is None else store.member(expression, "uid")) or str(uuid.uuid4())
    record = _held(store, "Provenance.InTransactions", "Provenance.Transactions", "uid", uid)
    if record is None:
        record = _made_record(store, expression, uid)
    for target in created:
        if _extended(store, target.as_schema()):
            _link(store, "Provenance.CreatedBy", {"object": target, "transaction": record})
    modified_by = store.registered("Provenance.ModifiedBy")
    for target in written:
        if not _extended(store, target.as_schema()):
            continue
        held = Proxies._linking(modified_by, "object", target, store)
        if [entry._links["transaction"] for entry in held] == [record]:
            continue
        Proxies._discard(id(modified_by), held, store)  # the tail: the one it held, replaced
        _link(store, "Provenance.ModifiedBy", {"object": target, "transaction": record})


def _made_record(store: Any, expression: Any, uid: str) -> Any:
    """A transaction's record, made, with its session, found or made, and the session's identity."""
    member = (lambda name: None) if expression is None else (lambda name: store.member(expression, name))
    when, where, session = member("when") or _now(), member("where"), member("session")
    if session is not None and _given(store, session, "id") is None:
        raise ValueError("a transaction's session has no id: a service gives it, and who, before executing it")
    latitude, longitude = _given(store, where, "latitude"), _given(store, where, "longitude")

    def build(b: Any) -> Any:
        b.when(when)
        if where is not None:
            b.where(lambda w: w.latitude(latitude).longitude(longitude))
        return b

    record = _place(store, build(store.builder("Provenance.OfTransaction")).create(), "Provenance.InTransactions",
                    "Provenance.Transactions", "uid", uid)
    sid, who = _given(store, session, "id") or UNKNOWN, _given(store, session, "who") or UNKNOWN
    found = _held(store, "Provenance.InSessions", "Provenance.Sessions", "id", sid)
    identity = _held(store, "Provenance.InIdentities", "Provenance.Identities", "name", who)
    if found is None:
        locale, device = _given(store, session, "locale"), _given(store, session, "device")
        found = store.builder("Provenance.OfSession").started(when)
        if locale is not None:
            found.locale(locale)
        if device is not None:
            found.device(device)
        found = _place(store, found.create(), "Provenance.InSessions", "Provenance.Sessions", "id", sid)
        if identity is None:
            identity = _place(store, store.builder("Provenance.OfIdentity").create(), "Provenance.InIdentities",
                              "Provenance.Identities", "name", who)
        _link(store, "Provenance.Who", {"session": found, "identity": identity})
    else:
        whose = [entry._links["identity"] for entry in Proxies._linking(store.registered("Provenance.Who"), "session",
                                                                        found, store)]
        if whose != [identity]:
            raise ValueError(f"session {sid!r} is another identity's, not {who!r}'s: a session has one identity "
                             "(Provenance.Who)")
    _link(store, "Provenance.InSession", {"transaction": record, "session": found})
    return record
