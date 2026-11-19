<!-- nav -->
[← The transaction an object of its own](../transaction-object/README.md) · [Home](../../../README.md)

# Support for decoupled code (a proposal, for review)

[CAP-318: support for decoupled code](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/README.md#CAP-318) has code outside a store's mutation expressions work with the frames that the store
gives back, which survive their transaction, with no guarantee that their data is fresh. This proposes what such a
frame carries, how decoupled code reads it and edits a copy of it, and how an edited copy is written back. It also
asks what only the user can decide. No code is written until the persistence session's `Store.exec` lands and the
questions below are answered.

It matters to three repositories. mbse-transforms applies a transform to up to three arguments, `source`, `sync` and
`target`, each a `Visitors.OfPattern` ([its first-release proposal](https://github.com/pitaman71/mbse-transforms/blob/main/docs/proposals/first-release/README.md#the-transform-model-as-the-user-decided)). A query's frames
come back only after its transaction ends, so that no caller is given one as a `Visitors.OfPattern`: mbse-transforms
records this as its gap 1 ([Gaps found](https://github.com/pitaman71/mbse-transforms/blob/main/docs/proposals/first-release/README.md#gaps-found)), mbse-programs as its sibling gap 12
([its sibling gaps](https://github.com/pitaman71/mbse-programs/blob/main/docs/proposals/sibling-gaps/README.md)), and mbse-codegen-python's port waits on it for its stages 2 to 4
([its port proposal](https://github.com/pitaman71/mbse-codegen-python/blob/main/docs/proposals/port/README.md#stages)). Coupled code, the frame transducer, is
not part of CAP-318 ([the transaction-object proposal](../transaction-object/README.md#decided), Decided).

## Where it stands (0.30.1, main 777c645)

Measured in a scratch environment against mbse-schemas' main, in Python, over a contact book: `crm.Person`, owned by
the singleton `crm.TheBook` by key, with a `name`, an `age` and a `home` (a value object, `crm.Home`), who knows
persons through `crm.Knows` since a year; and `crm.Note`, a counted object about a person.

**What a frame given back carries** (`Transactions.Frame`, made by `_given_back`):

- A frame is a `dict` of its symbols, each bound to a `References.OfObject`, a value that is read outside the
  transaction. A frame has two attributes besides, `assigns` and `errors`, and no `entries` and no `variables`.
- `assigns` holds, by symbol, only the properties that the specs of the transaction's terms name for that symbol. A map
  whose spec names an entry and no property gives a frame whose `assigns` is empty. A map whose spec names `a.name` and
  `a.knows(...)` gives `{"a": {"name": "Ada"}}`: the `crm.Knows` entry it matched is carried nowhere.
- A value object that a spec names is carried whole, by value. An update that sets `home` to a city alone gives a
  `crm.Home` holding both its city and the zip that the object held before, and both read outside the transaction.
- A symbol that binds a counted object is refused: reading it raises `LookupError` ("a counted 'crm.Note' has no
  reference: nothing names it"), and nothing of it is assigned.
- A frame is not a `Visitors.OfPattern`: `frame.a` raises `AttributeError`, and only `frame["a"]`, an object reference,
  is given.

**What `References.of(store, frame)` writes** (`References.OfFrame`): its `binds`, each symbol's object reference, and
its `assigns`, each a `References.OfProperties` of an object by its reference, and its `errors` where the frame has
any. It never writes `entries`, which is filled only where a caller builds a `References.OfFrame` itself, as the
References suite's REF-08 does. It never writes `variables`, since a map of variables is refused ("transactions bind no
variables until expressions are evaluated", [CAP-142: expressions evaluated in queries](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/CAP-142.md#blocked)).

**`sync`'s round trip, by `Changes.observe` and `Changes.apply`**. A copy of the store was made from its snapshot, one
transaction of the copy edited it, `Changes.observe` gave that transaction's journal, and `Changes.apply`, within one
transaction of the original, wrote the journal back, carried as JSON between the stores:

- **The original unchanged meanwhile**: the original equals the copy after the journal is applied, and applying it
  again changes nothing. The journal held a renamed person, an age set, a `home` set, a `crm.Knows` entry removed and
  another inserted, and a new person owned by the book, each by a symbol of the journal's own (`o0` to `o3`).
- **The original changed meanwhile**: the original's concurrent rename of the same person is overwritten by the
  copy's, silently; the original's other writes, an age and a new person, are kept.
- **A target, an empty copy holding only the schemas**: its writes, applied to an original holding none of its data,
  make the original equal to it.
- **A counted object made in the copy**, linked by value in the journal, is made in the original equal to it.

**The journal form as frame state.** A `Changes.Transaction` holding a frame's symbols by reference, the property
values the frame holds as `set`, and the entries the frame holds as `insert`, builds in fluent builder syntax and is
read as a `Changes.Journal`. Applied to the store that holds that state, it writes nothing, and the store observes no
journal. Three things are refused:

- `Changes.apply` refuses an entry one of whose links is an object reference not bound to a symbol: "a change links an
  object by a symbol of its transaction, or a counted object by its value". The schema of `Changes.OfEntry`'s links,
  `Mutations.OfLink.Set`, holds such a link, and builds it.
- `Changes.apply` refuses a symbol bound by reference to an object that the store does not hold, with `LookupError`
  ("no entry of 'contacts' has the keys {'key': 'ada'}"), even where the journal also inserts that object's ownership
  entry. So frame state that names its objects by reference cannot make a copy in an empty store.
- The same state, its persons' symbols bound to `crm.Person`'s schema rather than by reference and its ownership
  entries inserted, does make the copy in an empty store, and applied to the original writes nothing.

**The persistence session's work in progress** (`store-exec`, read uncommitted): `Store.exec(frame, remainder,
allow_write)` gives a stream of frames and `{"end": scope}` markers; a `Transactions.Frame` gains `scope`, the id of
the input frame that it descends from, and `remainder`, where it halted, a `Transactions.Remainder`; and `exec` takes,
as its input frame, a frame of symbols each bound by its reference. Its stage 2 adds each frame's changes, a
one-transaction `Changes.Journal` over the frame's own symbols
([the stacked stores proposal](https://github.com/pitaman71/mbse-basis/blob/main/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)).

## Decided elsewhere, that applies

- **Coupled and decoupled code**, as the user decided
  ([CAP-318: support for decoupled code](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/README.md#CAP-318)): "Coupled code "Transducers" - occurs inside of mutation expressions and can
  be re-executed whenever frame changes arrive." "Decoupled code - occurs outside of mutation expressions using data
  provided by a store in a frame that survives beyond the transaction, with no particular guarantee about the
  "freshness" of that data." "Frames will need to be able to carry symbol bindings, property assignments (relative to
  a symbol binding), and relation entries (relative to at least one symbol binding and object references not
  otherwise bound to a symbol)."
- **The journal form**, as the user suggested: "Changes is used by the journal language but a significant part of it
  might could be reused to represent frame state". Of a frame's changes, as the user decided: they "should rely on
  mbse-schemas/Changes", and "the changes L made *are* reported in the frame so there is no diff"
  ([the stacked stores proposal](https://github.com/pitaman71/mbse-basis/blob/main/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)).
- **Frames and visitors**, as the user decided
  ([CAP-315: every read within a transaction or through a follow](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/CAP-315.md#decided)): "Frames hold symbol bindings and property assignments, not
  proxies." "any class that implements Visitor must be have a lifetime that is lexically scoped (such as `with
  store.transaction()`)." "a value object and a visitor of that value object are
  not necessarily the same thing." "Programs are permitted to harvest data by reading visitor inside of a transaction,
  but any data held is basically stale on contact." "the store survives indefinitely."
- **The witness CAP-318 revises**, as the user decided
  ([CAP-131: frames witness values and entries](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/CAP-131.md#decided)): "We need to allow Frames to act as a witness for property values"; an
  object held "by its identity not symbol"; "Keep OfEntry as is. Refer to linked objects by their identity not
  symbols".
- **The arguments a transform takes**, as the user decided
  ([mbse-transforms' first release](https://github.com/pitaman71/mbse-transforms/blob/main/docs/proposals/first-release/README.md#the-transform-model-as-the-user-decided)): "`source` - a read-only
  `Visitors.OfPattern` bearing a pattern frame bound to a source copy that is not to be disturbed (nondestructive)";
  "`sync` - a writeable `Visitors.OfPattern` bearing a pattern frame bound to a copy that is to be edited in place
  (destructive)"; "`target` - a writeable `Visitors.OfPattern` bearing a pattern frame bound to a (usually empty) copy
  that is to be replaced (constructive)"; "The transforms application procedure does not need to know how copies are
  made since it takes Visitors.OfPattern as an argument."
- **What the transaction object left**, as the user decided ([the transaction-object proposal](../transaction-object/README.md#decided)): "this
  hints at transaction serialization above the persistence layer which is not yet defined"; of `txn.query`, "I don't
  recognize `txn.query` - sounds like some kind of imperative code workaround. May be unwanted."; "The alternate
  'frame transducer' callback form should actually be a mutation kind of its own."
- **Frames as corpora**, as the user decided
  ([the stacked stores proposal](https://github.com/pitaman71/mbse-basis/blob/main/proposals/STACKED-STORES.md#decided)): "transaction is one representation but may be difficult to
  compare. Frame I think already has equality and comparison".
- **Values**, as the user decided ([VOC-040: parameter assignment](https://github.com/pitaman71/mbse-basis/blob/main/docs/VOCABULARY.md#VOC-040)): "Values are not bound. Values are assigned."

## The proposal

### What a frame carries: its state, in the journal form

A frame given back carries its **state**: a `Changes.Journal` of one transaction, whose symbols are the frame's own,
in the form that the persistence session's stage 2 gives a frame's changes. That form is being rewritten by
[CAP-321](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/README.md#CAP-321) (INI-014), as the
user decided: "`Changes` needs `Remove` as well as `Insert`."; "`Changes` should probably use `References` if it
doesn't already"; "I kind of prefer: `Changes.OfKind` as a union of `Changes.OfKind.Action`."; "Also `Changes.*`
should be entirely value objects". A frame's state takes CAP-321's form once its schemas are settled: each kind of
change a union of its actions (`Changes.OfEntry.Insert` and `.Remove`, `Changes.OfProperty.Set` and `.Clear`, as
CAP-321 settles them), links given by object reference as well as by symbol, every part a value object. A frame's
state, what it holds from nothing, needs only the actions that add (an entry inserted, a property set); a frame's
changes need the others too. Each of the user's three kinds maps onto a part of the journal language, described
below as it stands in 0.32.0:

- **Symbol bindings** are the transaction's `symbols`, each a `Changes.Symbol` holding the object's `reference`, and
  its `schema` where its reference does not imply it, as `Changes.observe` writes one.
- **Property assignments, relative to a symbol binding**, are `Changes.OfProperty` changes, each its `holder`'s symbol,
  the property's `name`, and `set` to its value. A value object is carried whole, by value, as it is today.
- **Relation entries, relative to at least one symbol binding and object references not otherwise bound to a symbol**,
  are `Changes.OfEntry` changes, each written on its `holder`'s adjacency, the holder a symbol, its other `links` each
  a symbol or an object reference, and its `properties`' values. An entry the frame holds is written `insert`: a
  spec's insert holds where the entry is held, so that applying a frame's state to a store that holds it writes
  nothing, as measured.

The state's id is the one that the persistence session gives a frame's changes: the transaction's uid and the
frame's position in the stream. `References.OfFrame` gains `state` through a schema extension that
`Changes.install` makes, since `Changes.install` runs after `References.install` and `References.install` already
extends `Schemas.OfSymbol` so:

```python
lambda _: _.OfFrame.name("References.OfFrame").properties({
    "state": _.Journal,  # what the frame holds, by its own symbols (CAP-318)
}),
```

A frame binding Ada and holding her name and her knowing Bob, Bob bound to no symbol of the frame, is then this value,
where `at_ada` and `at_bob` are taken as the References suite's REF-08 takes them:

```python
store.References.OfFrame(lambda f: f
    .binds({"a": lambda o: o.path(at_ada)})
    .state([lambda x: x.as_object(lambda t: t
        .id(frame_id)  # the transaction's uid and the frame's position, as store-exec's stage 2 writes it
        .symbols({"a": lambda s: s.reference(lambda o: o.path(at_ada))})
        .changes([
            lambda c: c.as_union(lambda u: u.property(lambda p: p.holder("a").name("name").mutations([
                lambda m: m.as_union(lambda v: v.set(lambda s: s.value("Ada")))]))),
            lambda c: c.as_union(lambda u: u.entry(lambda e: e
                .holder(lambda h: h.reference(lambda r: r.symbol("a")))
                .adjacency("knows").verb("insert")
                .links({"known": lambda k: k.reference(lambda r: r.path(at_bob))})
                .properties({"since": 2020}))),
        ]))]))
```

The `Changes.Transaction` within it was built as written here, in 0.32.0's form, and read back; `state` itself is
proposed, and is written in CAP-321's form once that is settled: the entry an `insert` action rather than `verb("insert")`,
and the property a `set` action rather than a list of `mutations`. Whether a
frame's state and its changes are one journal or two is question 1; what a frame's state holds of each bound object
is question 3.

### How decoupled code reads a frame that survives: `source`

A frame's state is a value, so that it outlives the transaction, as an object reference does. Decoupled code reads it
as `source` through a copy: a store of its own (`Builders.Store`, given no store below), holding the schemas, into
which the state is applied by `Changes.apply`. A `Readers.OfPattern` of the frame is read within a transaction of the
copy, whose symbols are bound to the objects that the frame's references designate there, and the copy is never
written, so that it is not disturbed. Each visitor lives within the copy's transaction, as CAP-315 has it, and the
original store is not read again. The state, not the original store, is what decoupled code reads, with no guarantee
that it is fresh. How the copy's transaction gives the frame as a `Visitors.OfPattern` is question 5; reading the state
as a value, with no copy, is question 4's other option.

### How a `sync` or `target` copy is edited and written back

- **`sync`**: a copy made from the frame's state, as for `source`, edited in place within one transaction of the copy.
  `Changes.observe(copy, ...)` gives that transaction's journal, and `Changes.apply` writes the journal back within one
  transaction of the original store. This round trip is measured above: it leaves the original equal to the copy, and
  run again changes nothing.
- **`target`**: a copy holding only the schemas, usually empty, written within one transaction of the copy, and
  written back the same way. This is measured above too.
- **Stale data**: where the original changed after the frame was given, the write-back's `set` overwrites what the
  original holds, as measured. No check that the frame's state still holds is proposed, since "transaction
  serialization above the persistence layer" is "not yet defined". Decoupled code that needs fresh data gives the
  frame's references to `Store.exec` as its input frame, so that a new transaction binds the same objects.

Making a copy from a frame's state needs two gaps closed in `Changes.apply` (Gaps found, 1 and 2).

### `assigns`, `entries` and the CAP-131 revision

`state` replaces `References.OfFrame`'s `assigns` and `entries`. CAP-131's witness holds every object by its object
reference; CAP-318's state holds every object by the frame's symbols, and a linked object bound to no symbol by its
object reference. `binds`, `variables` and `errors` are kept, and `Transactions.Frame` keeps its bindings as a `dict`.
CAP-131 is to be revised in mbse-basis, its entry and its detail file saying that a frame holds its state by its
symbols, through an agent's pull request there. Whether `assigns` and `entries` are removed at once or deprecated
first is question 6.

### CAP-315's wording

The copy keeps CAP-315 as it is worded: every visitor lives within a transaction of the copy, and the frame's state is
a value object, which outlives the transaction, as CAP-315 has a value object do. CAP-315's wording changes only where the user chooses to
read a frame's state with no copy (question 4).

### How much of each bound object a frame carries

Today a frame carries what its specs name, and nothing of a symbol whose specs name no property. A copy made from it
holds no more than that. A property that the frame does not carry then reads as absent in the copy, though the original
may hold it. Which of these to carry is question 3, and how a property not carried reads is question 7.

### Freshness

A frame's state shows its freshness by its id, the uid of the transaction that gave it and its position in that
transaction's stream. Where the store records the transaction, its provenance record gives when the transaction ran
([CAP-134: transactions recorded with provenance](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/CAP-134.md)). No other guarantee is given, as the user decided.

## Stages

Each stage lands after CAP-321 (INI-014) has rewritten `Changes` and `Changes.apply`, in Python and TypeScript, each
passing both gates at 100%. `Store.exec` (0.31.0) has landed.

1. **A frame is schema data, for stacked stores.** Delegated by the user, for the stacked stores' stage 3, which waits
   on it: a layer across a process boundary (mbse-rest, mbse-dynamodb) receives frames, and a frame holds parts that
   `References.OfFrame` does not carry. Each part becomes schema data, additively, so that `References.OfFrame` values
   stored today (mbse-transforms' certificates, mbse-programs' corpora) still read; the built-in serialization then
   carries a frame to any process, with no wire format of its own ("Serialization and wire format are built-in to
   mbse-schemas.", [PRI-018: no model needs code to read or write](https://github.com/pitaman71/mbse-basis/blob/main/docs/PRINCIPLES.md#PRI-018)). `Changes.install`,
   which runs after `References.install`, extends `References.OfFrame` and adds the stream's item:

   ```python
   lambda _: _.OfFrame.name("References.OfFrame").properties({
       "scope": S.OfStr,  # the scope the frame was made in, as `Transactions.Frame.scope`
       "remainder": S.OfStr,  # where the rest begins, as `References.OfError`'s subterm; unset on a complete frame
       "journal": _.Transaction,  # the changes made interpreting its input frame (CAP-321's form)
   }),
   lambda _: _.OfEnd.name("References.OfEnd").properties({  # the stream's completion marker, `{"end": scope}`
       "scope": S.OfStr,  # a branch's or an input frame's; unset where it ends the whole stream, `{"end": None}`
       "journal": _.Transaction,  # set only where the input frame gave no frame
   }),
   lambda _: _.OfItem.name("References.OfItem").branches([  # an item of a frame stream
       lambda t: t.name("frame").schema([txn.References.OfFrame]),
       lambda t: t.name("end").schema([_.OfEnd]),
   ]),
   ```

   `remainder` names a place in the expression the receiving layer already holds, as `Transactions.Remainder.at`
   does, not a copy of the expression: every layer below is given the transaction's expression. A frame's errors are
   carried already, as `errors`, each a `References.OfError` (subterm, kind, message;
   [CAP-309: errors annotated on frames](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/README.md#CAP-309)). As the "mbse persistence" session reviewed it on this pull
   request, for the stacked stores' stage 3. `References.of` writes the three parts of a frame, and an end marker's
   `References.OfEnd`. Lands after mbse-schemas #62 (CAP-321, 0.33.0), which makes the journal a
   `Changes.Transaction`; the "mbse persistence" session is told when it lands.
2. **`Changes.apply` makes what a frame's state names**, in CAP-321's rewriting of it, where CAP-321 does not
   already: it applies an entry linked by an object reference not bound to a symbol, and a symbol bound by reference to an object the store does not hold, found or made through the
   ownership that its reference gives (Decided, 1). It changes nothing that a journal given by
   `Changes.observe` does today.
3. **A frame carries its state.** After the persistence session's stage 2, which adds a frame's changes in the same
   form: `Changes.install` extends `References.OfFrame` with `state`; `_given_back` writes each frame's state, by its
   own symbols, as question 3 decides; `References.of` writes it; `assigns` and `entries` as question 6 decides.
4. **Copies.** A copy made from a frame's state; the frame given as a `Visitors.OfPattern` within a copy's transaction,
   as question 5 decides; `sync`'s and `target`'s write-back by `Changes.observe` and `Changes.apply`, each a case in
   both languages. mbse-transforms then takes it, and mbse-codegen-python's stages 2 to 4 with it.
5. **mbse-basis.** CAP-131 revised, and CAP-318's detail file with what was built, in a pull request to mbse-basis.

## Decided

1. **A symbol bound by object reference to an object the store does not hold** (question 2): applying finds or makes
   it through the ownership that its object reference gives, as an upsert finds an owned object by its owning entry.
   The user: "yeah (a) not sure why (b) or (c) would even be functional". Binding such an object by its schema instead
   would make a new object, which written back is another object than the one the frame bound; and a copy made from
   the original's snapshot is not decoupled code's.

## Questions for the user

1. **A frame's state and its changes.** The persistence session's stage 2 gives a frame its changes as a
   one-transaction journal; CAP-318 gives it what it holds. (a) Two journals, `state` and the changes, each in the
   same form over the frame's symbols; (b) one journal, the frame's state, of which a cache layer applies all; (c) one
   journal, the frame's changes, and no state beyond them. *Recommended: (a). A read-only map changes nothing, and its
   frames still hold what decoupled code reads; a cache layer applies the changes and nothing more.*
2. *Decided* (Decided, 1).
3. **How much of each bound object a frame carries.** (a) What its specs name, as today; (b) every property value and
   every entry of each bound object; (c) what the transaction asks for, per symbol. *Recommended: (a), with each
   bound owned object's ownership entries implied by its reference, as question 2 (a) makes them, so that a copy can
   be made.*
4. **How `source` reads a frame that survives.** (a) Through a copy, a store of its own, within its transaction, as
   proposed; CAP-315 unchanged. (b) A `Readers.OfPattern` over the frame's state, a value, read outside any
   transaction; CAP-315 worded so that a reader of a frame's state is not a visitor of a store's data. *Recommended:
   (a). The three arguments then share one mechanism, and no visitor of a value outside a transaction is added.*
5. **How a copy's transaction gives the frame as a `Visitors.OfPattern`.** (a) The transaction object
   ([the transaction-object proposal](../transaction-object/README.md)) gives, within its scope, the `Visitors.OfPattern` of a frame given to it, its
   symbols bound by the frame's references; (b) the frame transducer, coupled code, run over the copy; (c) the caller
   binds each symbol itself, in an imperative scope of the copy, from the singleton each object reference starts at.
   *Recommended: (a). No query is run, so that it is not `txn.query`; (b) is coupled code, which CAP-318 leaves out;
   (c) reads what [CAP-132: paths retired for references](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/CAP-132.md) makes internal to an object reference, as mbse-transforms' route
   does.*
6. **`assigns` and `entries`.** (a) Removed when `state` lands (breaking); (b) kept one release, deprecated, written
   beside `state`. *Recommended: (b). mbse-programs' corpora are frames written with their `assigns`, as the user
   decided, and move with the next release.*
7. **A property that a frame does not carry, read in a copy.** (a) It reads absent, as an unset property does; (b) it is
   refused as unknown, since the copy cannot tell it from absent. *Recommended: (b). "unknown is not false"
   ([PRI-007: three-valued checking on request](https://github.com/pitaman71/mbse-basis/blob/main/docs/PRINCIPLES.md#PRI-007)); where question 3 is (b), no property is not carried, and the question
   falls.*

## Gaps found

1. **`Changes.apply` refuses a link by an object reference not bound to a symbol**, in both languages
   (`Changes._effect_of`; `Changes.ts`), though `Changes.OfEntry`'s schema holds one and its builders build one. A
   frame's state therefore cannot carry what CAP-318 asks for, "object references not otherwise bound to a symbol",
   and be applied. CAP-321 closes it (mbse-schemas #62: `Changes.apply` binds a symbol to each object named by
   reference).
2. **`Changes.apply` refuses a symbol bound by reference to an object the store does not hold**, even where the
   journal inserts its ownership entry. A copy cannot be made from state that names its objects by reference. Stage 2
   closes it (Decided, 1).
3. **`References.OfFrame`'s `entries` is never written by `References.of`**, and its `variables` never can be until
   CAP-142. A frame given back carries none of the entries its specs matched.
4. **CAP-318 is in no initiative.** [Initiatives](https://github.com/pitaman71/mbse-basis/blob/main/proposals/PRIORITIES.md) lists none that holds it, so that this proposal is headed by
   none.

---

<!-- nav -->
[← The transaction an object of its own](../transaction-object/README.md) · [Home](../../../README.md)
