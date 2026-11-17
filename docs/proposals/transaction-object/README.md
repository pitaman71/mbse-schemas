<!-- nav -->
[← Store overhaul](../store-overhaul/README.md) · [Home](../../../README.md)

# The transaction an object of its own (a proposal, for review)

The user raised two objections to the store as built (mbse-schemas 0.29.0), in their words:

> BEEF #1: I can see that the Store must be retaining a handle to the most recently started transaction, which implies
> only one transaction at a time can be outstanding. Not an acceptable limitation.
>
> BEEF #2: possibly as a result of #1, attributes used in the imperative style remain on `Store` instead of
> `Transaction`. See `store.singleton` for one example.

A third finding has the same root: a query's frame stream cannot be consumed within a transaction as
`Visitors.OfPattern`, as the user expected it could ("`with Store.transaction` returns a context inside of which the
frames may be iterated and consumed as pattern visitors, no?"). And the user observed, of the form such an API takes:

> OBSERVATION #3: not all programming languages support contexts in the Pythonic sense. To that end an equivalent API
> would be for `Store.transaction` to take a callback expecting a single argument bearing a stream of frames and
> returning a (possibly empty) stream of frames.

This proposes one change for the three, and asks what only the user can decide. No code is written until it is
decided.

## Where it stands (0.29.0, main 7c367f7)

- **The store holds its one transaction.** `Proxies.OfStore._transacting` keeps the open transaction's writes in
  `self._proposals` and its lifetime in `self._life`, and refuses a second: "a transaction is open: transactions do not
  nest". Its docstring: "One is open on a store at a time; each store's is its own."
- **The imperative API is the store's.** `store.singleton(...)`, `store.extent(...)`, the builders
  (`store.<module>.<Schema>(...)`, through `__getattr__`) and `store.registered(...)` find the transaction implicitly,
  through `self._reading()`, `self._life` or "a store is read only within a transaction (store.transaction)".
- **The imperative scope yields nothing.** `store.transaction()`, given no expression, returns `_scope()`, which opens
  the transaction and yields `None`. A query (`store.transaction(expr)`) within it is refused, as nested; a query's
  frames are given back only after its own transaction ends, holding object references
  ([CAP-315](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/CAP-315.md)).

What is recorded ([CAP-124: writes all-or-nothing in transactions](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/CAP-124.md#decided)):

- **(object identity 50)** Nested transactions are "prevented by schema. Mutation.OfTransaction is strictly the root":
  a transaction within a transaction. This is about nesting, not about transactions outstanding side by side.
- **(object identity 99)** Asked "why a barrier?" of one transaction open at a time across every store, the user agreed
  it had no reason beyond the implementation; it became one transaction open at a time *per store*. BEEF #1 holds that
  limit too unacceptable.
- **(object identity 78)** "schemas are pulled from txn": within a transaction's expression, `txn.Schemas.<name>` names
  a schema. BEEF #2 asks the same of the imperative style.

## The proposal

**`store.transaction()` gives a `Transaction`**, an object of its own, holding its own writes and its own lifetime; the
store holds none, and any number may be outstanding on a store.

```python
with store.transaction() as txn:
    shelf = txn.singleton("demo.TheShelf")             # was store.singleton
    txn.demo.Shelf(shelf, lambda s: s.items({...}))      # was store.demo.Shelf
    for frame in txn.query(pattern):                     # a frame stream, each frame a Visitors.OfPattern
        ...
```

- **The imperative API moves to the transaction**: `singleton`, `extent`, the builders and whatever reads the store's
  data through a visitor. A visitor's lifetime is its transaction's, as CAP-315 has it, now an object a caller holds.
- **A query within a transaction** gives its frame stream within it, each frame a `Visitors.OfPattern`, consumed as it
  is iterated. The stream an expression transaction gives back after it ends (`store.transaction(expr)`) is unchanged.
- **What stays on the store**: what is no transaction's: its schemas as registered (`registered`), its observers and
  follows, and making a transaction.
- **The same, for languages without contexts** (OBSERVATION #3): `store.transaction(callback)`, `callback` given a
  single argument bearing the transaction's stream of frames, each a `Visitors.OfPattern`, and returning a stream of
  frames, possibly empty, which the transaction gives back. It is a transaction's frame stream as
  [CAP-138: mutation expressions over frame streams](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/CAP-138.md)
  has it, a term consuming frames and producing them, written as native code. The context form is the same transaction
  where the language has contexts.
- **Nesting stays prevented** (object identity 50): a transaction is not opened within another of the same store's.
  Side by side, each is its own.

## Questions for the user

1. **Two transactions that commit writes to the same object.** With several outstanding on a store, what happens at
   the second commit? (a) It is refused, where an object it wrote was written by a transaction committed since it
   began (optimistic, first committer wins); (b) the later commit wins, its writes over the earlier's; (c) a
   transaction sees the others' writes as they commit (no isolation). *Recommended: (a), as a commit is all or
   nothing (CAP-124) and a refused transaction leaves no trace.* Raised in review: an imperative scope is refused on a
   conflict, while an expression transaction, being data, may instead be interpreted again over what committed
   (mbse-dynamodb's `attempts` does so); in a stack, the lowest store decides, a commit above is provisional until it
   does, and what arrives from below counts as a commit; the rule covers schema writes as well as data; and follows and
   journals give commits in commit order.
2. **What a transaction reads, and how strictly.** (a) The store as it was when the transaction began, with its own
   writes (a snapshot), which needs versioned durable data; (b) the store as it is, with its own writes. Under (a),
   which check at commit: (a1) snapshot isolation, its write set against those committed since it began, which allows
   write skew (two transactions each reading what the other writes, both committed); (a2) serializable, its read set
   too. *Recommended: (a) with (a1), the cheaper, where write skew is acceptable; (a2) where it is not.*
3. **A query within a transaction**: `txn.query(pattern)` for a map over one pattern, or the whole expression
   vocabulary within it (`txn.mutations([...])`, giving its frame stream)? *Recommended: the vocabulary, as an
   expression transaction has it, so that one form serves both.*
4. **The store's imperative API**: removed in the same release (breaking), or kept for one release, deprecated, beside
   the transaction's? *Recommended: removed: every dependent moves once.*

5. **The callback that builds an expression.** `store.transaction(callback)` takes, today, a callback that builds a
   transaction's expression (`lambda t: t.mutations([...])`), executed as data. OBSERVATION #3's callback consumes and
   produces frames. (a) The expression is given as itself (`store.transaction(expression)`), and a callback is always
   OBSERVATION #3's; (b) two methods, one for each.
6. **What the callback's argument bears.** (a) The frame stream alone, a frame's members its objects' visitors, from
   which a callback reaches what it reads and writes; (b) the transaction, its frame stream and the imperative API
   (`singleton`, `extent`, the builders) besides.

## What it touches

A breaking release (0.30.0). Every `store.singleton`, `store.extent` and builder call within an imperative scope, in
mbse-schemas and its dependents: mbse-expressions; mbse-programs' Python port (`Print`, `Definitions`, `Check`, which
open their own transactions); mbse-transforms (`apply` and `certify` would take visitors from the caller's
transaction, and the gap its proposal records, a frame stream not consumed within its transaction, closes); mbse-rest,
mbse-dynamodb, mbse-journals and mbse-diagrams, through their stores. CAP-124's object identity 99 is superseded as to
one transaction at a time per store; CAP-315's text and suite LIF follow the transaction object.

---

<!-- nav -->
[← Store overhaul](../store-overhaul/README.md) · [Home](../../../README.md)
