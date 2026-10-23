# References (4n, a proposal, decided)

The user, writing client code in a new repository, found requests that start from "an identifier for an object or
relation entry" with nothing to give: most objects have no identifier, entries never do, and nothing describes what a
response points at. "I believe these are all downstream of there not being a consolidated well-defined format for
object and relation entry references." The user's proposal (2026-10-23):

```
Framework/References.py/ts
Framework.References.OfObject # instances designate a singleton or other non-counted reference object
Framework.References.OfEntry # instances designate a relation entry
Framework.References.OfFrame
```

Today [Paths](../../OBJECT_IDENTITY.md) designate singletons and owned objects (`Paths.OfRoot`, `Paths.of(obj)`,
`store.held(path)`); nothing designates an object an upsert made, a relation entry, or a frame.

## The model

Three value schemas, in a module of their own, `References`, which every store holds as it holds `Paths` (read by the
bootstrap):

- **`References.OfFrame`**: a frame, each of its symbols bound to a `References.OfObject`. No pattern: "take pattern out
  of frame ref entirely".
- **`References.OfObject`**: an object, a union of two branches:
  - `path`: a singleton or an owned object, by its path (`Paths.OfRoot`, as today);
  - `upserted`: a counted object an upsert made, by what made it (Object identity, Decided, 61, 63 and 102): the
    `frame` that reached the upsert (a `References.OfFrame`), the upsert's `key`, and the `symbol` it was made for.

  A counted object a document writes outright still has no reference: it has no identity beyond that document
  (Decided, 40 and 55). Making one addressable is the model's choice: a singleton, an owner, or an upsert.
- **`References.OfEntry`**: a relation entry, by its relation (the schema's path) and all its links and properties:
  each link a `References.OfObject`, each property its value. Entries compare by value, so that designates one.

A reference is written and read as any value is, in both languages, through the builders' fluent calls; for example
the Note an upsert made for Ada, in a transaction `notes/1` that maps over a book's contacts:

```python
References.OfObject(lambda o: o.upserted(lambda u: u
    .frame(lambda f: f.binds({
        "book": lambda r: r.path(lambda p: p.singleton("crm.book")),
        "contact": lambda r: r.path(lambda p: p.singleton("crm.book").entry(lambda e: e
            .i("contacts").o("book").properties({"name": "ada"}))),
    }))
    .key("notes/1")
    .symbol("note")))
```

## Operations

- `References.of(store, x)`: the reference of an object (`OfObject`, its path or what upserted it; refused for a
  counted object nothing names), of an entry (`OfEntry`), or of a frame the executor gave back (`OfFrame`).
- `References.resolve(store, reference)`: what it designates, or None where the store holds none.
- The executor's frames, which `store.transaction` gives back, are given a reference by `References.of`, so that a
  response can carry them.

## Paths, meanwhile

"temporarily leave Paths as having overlapping function with References, mark them as deprecated where they appear in
the docs, tutorials, examples in favor of References, and log tech debt to eliminate Paths later". The wire keeps
writing an object a document does not hold as its path (`$ref`); the corpora do not change. Removing `Paths` is tech
debt (TODO.md).

## Decided

As the user decided (2026-10-23):

1. The three schemas above, in `Framework/References.py` and `.ts`.
2. An upserted object's reference is its frame, the upsert's key and the symbol, "as you drafted".
3. A frame's reference has no pattern: "take pattern out of frame ref entirely".
4. Paths stay for now, overlapping, marked deprecated in favor of References in docs, tutorials and examples; their
   removal is tech debt.
5. An entry is designated "by all links and properties".
6. Built "right now": 4n, before 4k and 4h.

## Fixed by the agent, for the user's review

- Each schema is a value object (as a path is); `OfObject` a union of `path` and `upserted`.
- `References` is held by every store, read by the bootstrap after `Paths`, as framework schemas are; not installed
  before use as `Parametrics` is, since what it designates is the framework's own (paths, upserts, entries).
- The operations' names, `of` and `resolve`, after `Paths.of` and `store.held`.
- Settled in building it (4n), the simplest choice consistent with the code:
  - The `upserted` branch's schema is a value object of its own, `References.OfUpserted` (`frame`, `key`, `symbol`);
    `References.OfFrame` holds its symbols in one property, `binds`, a container of `References.OfObject` by symbol, as
    the example above writes it (`f.binds({...})`).
  - `References.OfEntry` holds `relation`, a `Paths.OfRoot`; `links`, a container of `References.OfObject` by link;
    and `properties`, a container of values of any schema by property (an unrestricted `OfAny`, as
    `Parametrics.BindsValue` holds a value), so that a property of any schema is held, each tagged on the wire by its
    schema (`{"since": {"int": 2020}}`).
  - How the executor records what an upsert made: where it creates a counted object, it records, weakly by the object
    (`store._made_by`), the upsert's key, the symbol and the frame that reached it, its objects, not their references;
    `of` computes their references when asked, so a path is read off the owners as they are then. `resolve` resolves
    the frame's references, then finds the object through the index the executor keeps for 102
    (`Transactions._upsert_index`: the key, the symbol and the frame's objects), so a reference resolves while the
    object is held, and to the same object after the transaction runs again, which finds it there. An upsert without a
    key gives a reference without one.
  - A document is read as an upsert keyed by its uid (102), so a counted object read from a document with a uid has an
    `upserted` reference (an empty frame, the uid, its symbol) while it is held; one a builder writes outright (an
    imperative scope) has none, and `of` refuses it: "a counted 'crm.Note' that no upsert made has no reference: nothing
    names it (make it a singleton's, an owner's or an upsert's)" (`LookupError`). This narrows "A counted object a
    document writes outright still has no reference", for the user's review.
  - `of` takes the store whose schemas the reference is a value of, and refuses another store's object ("the object
    belongs to another store", `TypeError`) and anything not an object, an entry or a frame (`TypeError`); an entry of
    a relation with no name of its own has no path, so `of` refuses it as `Paths.of` does (`LookupError`). A frame is
    a mapping of symbols to objects, a `Map` in TypeScript, as `store.transaction` gives it back.
  - `resolve` takes a reference of the store's own schemas (one read from the wire is read with the store's
    `References.*` schema first), refusing anything else (`TypeError`). It gives an object, the entry the store holds
    now (an update may rewrite an object's entries: entries compare by value, and the one held is given back), or a
    frame; None where the store holds nothing it designates: a path to nothing, an upsert no index holds, a frame or an
    entry one of whose objects is not held, an entry no relation entry agrees with, link for link and property for
    property, or a reference giving no links.

## Stages, as built

- **4n**, one stage, both languages: `Framework/References.py` and `typescript5/src/Framework/References.ts`
  (exported as `References`, beside `Paths`), `install(txn)` read by the bootstrap after `Paths` (every store holds the
  four schemas: `References.OfObject`, `OfUpserted`, `OfFrame`, `OfEntry`), `of` and `resolve`; the executor records
  what made each counted object an upsert creates (`store._made_by`), and its upsert index is one function,
  `Transactions._upsert_index`, which `resolve` shares. Paths are marked deprecated in favor of References in
  OBJECT_IDENTITY.md, SERIALIZATION.md, FRAMEWORK.md (and its Resolved entry, References), tutorial 6 and the skill
  (python.md and typescript.md, a section each). No example used Paths. The wire and the corpora are unchanged. REF-01
  to REF-07 cover it, in both languages.
