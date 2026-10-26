# Provenance: transaction records (a proposal, decided)

Services built on mbse-schemas need to know who changed what, when and from where: a comment shows its author and
the time it was posted (the workspace's VISUALIZATION.md, CAP-015 and CAP-016), and an audit trail answers for every write. Today a
service cannot do that bookkeeping well: the executor alone knows which objects a transaction creates or changes,
and nothing it keeps outlives the transaction. A transaction's expression (`Mutations.OfTransaction`) is a counted
object that goes when the program drops it (Object identity, Decided, 94), and the journal holds expressions, not
what they did.

The user's proposal (2026-10-26): "I believe adding `Schemas.OfTransaction` will allow the services to handle almost
all of transaction bookkeeping, provided locale and/or geolocation provided by the UI for transactions executed for an
interactive user session."

## The model

The executor records each transaction it executes, as data in the store, at commit:

- **`Provenance.OfTransaction`**: the record of one executed transaction, a reference object owned by the singleton
  directory `Provenance.Transactions`, keyed by the transaction's `uid` (given by the program, Object identity, Decided,
  42), so that a record has a reference (References) and a UI can show it. The record does not hold its expression:
  its `uid`, its key, cross-references the expression a journal holds. Its properties: `when`, the time it
  executed, as UTC ISO 8601 text; and `where`, a `Provenance.OfWhere` value, where given: the geolocation the
  transaction was initiated from, which may change within a session.
- **`Provenance.OfSession`**: the session a transaction was executed in, a reference object owned by the singleton
  directory `Provenance.Sessions`, keyed by its `id`: what the service knows a validated token by, so that a session
  cross-references its token without the record holding the token (Decided, 6). Its properties, for an interactive
  user's session: its `locale` and, where given, its `device`; and `started`, when it was first recorded. Its
  identity is `Who`'s.
- **`Provenance.InSession(transaction, session)`**: the session a transaction was executed in, one per transaction.
- **`Provenance.OfIdentity`**: a person or an agent, owned by the singleton directory `Provenance.Identities`, keyed by its
  `name`: a permalink of an identity, made on demand the first time a transaction names it.
- **`Provenance.Who(session, identity)`**: the leaf identity for whom the session's transactions execute (the end
  user, where interactive), one per session.
- **`Provenance.CreatedBy(object, transaction)`**: the transaction that created an object, one per object.
- **`Provenance.ModifiedBy(object, transaction)`**: the latest transaction that wrote an object after creating it, one
  per object, replaced by each later write: the tail, not a history. The records of earlier writes stay in
  `Provenance.Transactions`, by `uid`, as the journal holds their expressions.

What the record holds comes from the transaction's expression, never from the moment it runs, so that replaying a
journal makes the same records: `Mutations.OfTransaction` gains `when`, `session` (a session's `id`, `who`, an
identity's name, `locale` and `device`) and `where`. A service sets `when`, and the session's `id` and `who`, before
it executes and journals the expression; a client sets the session's `locale` and `device`, and `where`, for an
interactive session. The executor finds the session by its `id`, else makes it with its `Who`, and the identity by
its name, else makes it. Replayed, a transaction's record is found again by its `uid` and nothing is written twice.

An object is linked to its transactions through adjacencies its schema declares, as every link's object is; the
app need not declare them. `Provenance` adds them by schema extension (SCHEMA_EXTENSION.md: an install "may add …
adjacencies to an existing object schema"; a link's accepted schemas are inferred from the adjacencies that declare
it): `Provenance.extend(txn, schemas)` gives each reference object schema named an anonymous adjacency to `CreatedBy`
and to `ModifiedBy` through `object`, so that it has no member and the app's code does not change, and its records'
links validate. The app decides which of its reference object schemas have a history: its own install calls
`Provenance.extend` with those it chooses, and the executor links only objects whose schemas it extended.

## Examples

The schemas, as `Provenance.install` would define them (written out, P-019), a module of mbse-schemas installed
before use, as `Parametrics` is (`store.transaction(Provenance.install)`):

```python
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
    "started": S.OfStr,     # UTC ISO 8601: when the session was first recorded
    "locale": S.OfStr,      # an interactive session's, e.g. "en-GB"
    "device": S.OfStr,
}).adjacencies([
    lambda t: t.name("directory").relation([_.InSessions]).me("session").owner(True),
    lambda t: t.name("transactions").relation([_.InSession]).me("session"),
    lambda t: t.name("who").relation([_.Who]).me("session"),
]),
lambda _: _.InSession.name("Provenance.InSession").links([
    lambda t: t.name("transaction"),
    lambda t: t.name("session"),
]).uniques("transaction"),    # one session per transaction
lambda _: _.InTransactions.name("Provenance.InTransactions").links([
    lambda t: t.name("directory"),
    lambda t: t.name("transaction"),
]).properties({"uid": S.OfStr}).uniques([["directory", "uid"], ["transaction"]]),
lambda _: _.Transactions.name("Provenance.TransactionDirectory").ref(True).singleton("Provenance.Transactions")
.adjacencies({"transactions": lambda a: a.relation([_.InTransactions]).me("directory")}),
lambda _: _.OfTransaction.name("Provenance.OfTransaction").ref(True).properties({
    "when": S.OfStr,        # UTC ISO 8601, e.g. "2026-10-26T14:30:05Z"
    "where": _.OfWhere,
}).adjacencies([
    lambda t: t.name("directory").relation([_.InTransactions]).me("transaction").owner(True),
    lambda t: t.name("session").relation([_.InSession]).me("transaction"),
    lambda t: t.name("created").relation([_.CreatedBy]).me("transaction"),
    lambda t: t.name("modified").relation([_.ModifiedBy]).me("transaction"),
]),
lambda _: _.Who.name("Provenance.Who").links([
    lambda t: t.name("session"),
    lambda t: t.name("identity"),
]).uniques("session"),        # one identity per session
lambda _: _.CreatedBy.name("Provenance.CreatedBy").links([
    lambda t: t.name("object"),
    lambda t: t.name("transaction"),
]).uniques("object"),         # one creating transaction per object
lambda _: _.ModifiedBy.name("Provenance.ModifiedBy").links([
    lambda t: t.name("object"),
    lambda t: t.name("transaction"),
]).uniques("object"),         # one per object: the latest write, replaced by the next
```

`Provenance.OfIdentity` and its directory `Provenance.Identities` follow the same pattern, keyed by `name`.

`Provenance.extend` adds, to each schema named, the adjacencies its records' links need, anonymous, in one
upsert whose symbols find each schema by its name. The WorkTracker's install would call it for the schemas whose
history it wants, its comments among them, for which it writes:

```python
lambda _: _.Comment.name("work.Comment").adjacencies([
    lambda t: t.relation([P.CreatedBy]).me("object"),     # anonymous: no member on a comment
    lambda t: t.relation([P.ModifiedBy]).me("object"),
]),
```

A comment posted from an interactive session: the client builds the expression and sets the session's `locale`; the
service sets `when`, and the session's `id` and `who`, before executing it. The executor creates the comment, its
directory gives it its ID, and at commit the executor writes the record, `InSession` (making the session `tab-7f3a`,
with its `Who` and the identity `ada`, if they are new) and `CreatedBy`, all in the one transaction:

```python
store.transaction(lambda t: t
    .uid("6f1c4e2a-0000-4000-8000-000000000007")
    .when("2026-10-26T14:30:05Z")                                  # the service's
    .session(lambda s: s.id("tab-7f3a").who("ada").locale("en-GB"))  # its id and who the service's, its locale the client's
    .mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"topic": feature_reference, "c": store.work.Comment})
        .spec([lambda _: _.c.text("Should chips show adjacencies?").about([_.topic])])]))]))
```

Reading a comment's author, time and session back, as a map over the records, from the record's side, since a
comment's adjacencies to them are anonymous and it has no member for them:

```python
store.transaction(lambda t: t.mutations([lambda mu: mu.map(lambda m: m.symbols([lambda p: p
    .symbols({"c": comment_reference, "t": store.Provenance.OfTransaction, "i": store.Provenance.OfIdentity,
              "s": store.Provenance.OfSession})
    .spec([lambda _: _.t.created([_.c]), lambda _: _.t.session([_.s]), lambda _: _.s.who([_.i])])]))]))
# one frame: t binds the record (its `when`), i the identity (its `name`), s the session (its `locale`)
```

## Questions for the user

None at present.

## Decided

As the user decided (2026-10-26), on the questions first put:

1. **A module of its own**: "Make a new module `mbse-schemas.Provenance`" (not `Schemas.*`, so Object identity,
   Decided, 75, stands): `Provenance.OfTransaction`, `OfIdentity`, `OfWhere`, `Who`, `CreatedBy`, `ModifiedBy` and
   their directories.
2. **No expression in the record**: "No, but record the transaction's uuid which can be cross-referenced": the record's
   key is the transaction's `uid`.
3. **What is recorded**: "Use placeholder data as needed and log tech debt to get it right": every transaction that
   writes is recorded; one without an expression or a session (an imperative scope, Object identity, Decided, 103) gets
   placeholder data (a `uid` the store makes, `when` at commit, the identity `unknown`), logged as tech debt.
4. **Time as text**: "yes ISO8601 text for now": `when` is UTC ISO 8601 text until a date domain exists.

As the user decided (2026-10-26), on the two questions left:

5. **The app decides which schemas have a history**: "App code should itself decide which reference object schemas
   get provenance and which do not": the app's install calls `Provenance.extend` with the schemas it chooses.
6. **No token in the record**: "The token probably should not be part of the transaction record itself. The session
   id is part of the transaction record and that can be used to cross-reference token if necessary." A service
   validates the token it is given and writes, into the transaction's expression before executing and journaling
   it, the session's `id` and the identity the token gave (`session`'s `id` and `who`, Decided, 7 and 8); neither the record nor the
   expression holds the token.

As the user decided (2026-10-26):

7. **A session is an object of its own**: "Let's make `Provenance.OfSession` explicit": `Provenance.OfSession`, owned
   by `Provenance.Sessions`, keyed by its `id`, and `Provenance.InSession` linking each transaction to its session.

8. **What belongs where**: "locale, device, who/identity belong to the session. when belongs on the transaction":
   `Provenance.Who` links a session to its identity, one per session; a session holds its `locale` and `device`; a
   transaction holds its `when`, and its geolocation, `where`, where given ("yes, move where to the transaction"),
   since it may change within a session.

9. **`ModifiedBy` is the tail**: "I was not expecting that relation to track the journal, just the tail": one entry per
   object, the latest write, replaced by each later one.

## Corrected in moving it here

Written in the workspace's `proposals/transaction-records` by the session coordinating mbse-rest, mbse-react and
mbse-dynamodb, with the user, and moved here to be built (2026-10-26). Its draft's `uniques` clauses were inverted
against Decided 7 to 9: `uniques("x")` makes each `x` appear in at most one entry (as `Parametrics.ForValue`'s
`uniques("param")` gives a parameter one schema), so `InSession` is unique on `transaction`, `Who` on `session`, and
`CreatedBy` and `ModifiedBy` on `object`, as the decisions' wording says; corrected above, for the user's review.
