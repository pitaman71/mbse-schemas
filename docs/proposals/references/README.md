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

- **`References.OfFrame`**: a frame; it "maps symbol names to `References.OfObject` and variable names to values" (its
  `binds` and `variables`). No pattern: "take pattern out of frame ref entirely". "A stream of those is what is passed
  by the mutation executor from call to call and what will be transferred from services to UI."
- **`References.OfObject`**: "a singleton or other non-counted reference object", by its path (`Paths.OfRoot`, as
  today): a union whose one branch is `path`.

  A counted object has no reference, an upsert's included: it has no identity beyond the document that writes it, and
  nothing finds it except through what links it (Object identity, Decided, 40 and 55). A frame or an entry that binds
  or links one has none either. Making one addressable is the model's choice: a singleton or an owner.
- **`References.OfEntry`**: a relation entry, by its relation (the schema's path) and all its links and properties:
  each link a `References.OfObject`, each property its value. Entries compare by value, so that designates one.

A reference is written and read as any value is, in both languages, through the builders' fluent calls; for example
a frame binding a book and one of its contacts:

```python
References.OfFrame(lambda f: f.binds({
    "book": lambda r: r.path(lambda p: p.singleton("crm.book")),
    "contact": lambda r: r.path(lambda p: p.singleton("crm.book").entry(lambda e: e
        .i("contacts").o("book").properties({"name": "ada"}))),
}))
```

## Operations

- `References.of(store, x)`: the reference of an object (`OfObject`, its path; refused for a counted object), of an
  entry (`OfEntry`), or of a frame the executor gave back (`OfFrame`); refused for a frame or an entry that binds or
  links a counted object.
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
2. First, an upserted object's reference was its frame, the upsert's key and the symbol ("as you drafted"); then, on
   finding that Decided 61 and 63 "are trying to create durable references to counted objects that by design should
   not be necessary or exist": "remove References.OfUpserted entirely from the prototype". "the purpose of this phase
   is to create durable references for client code": the executor keeps finding what an upsert made by its frame, key
   and symbol (61, 63, 102), and retiring that is tech debt, "log tech debt to eradicate durable direct references to
   counted objects" (TODO.md).
3. A frame's reference has no pattern: "take pattern out of frame ref entirely".
4. Paths stay for now, overlapping, marked deprecated in favor of References in docs, tutorials and examples; their
   removal is tech debt.
5. An entry is designated "by all links and properties".
6. Built "right now": 4n, before 4k and 4h.
7. A frame is also a witness, "for property values" and "to a relation + adjacency link" (2026-10-23): "We need to
   allow Frames to act as a witness for property values". `References.OfProperties` holds an object, "by its identity
   not symbol" (a `References.OfObject`), and a map of its property names to the values assigned; a frame holds them as
   `assigns`, a property ("(b)": a frame stays a value, so `assigns` is a container, not an adjacency). Its witnessed
   entries are `References.OfEntry` as built ("Keep OfEntry as is. Refer to linked objects by their identity not
   symbols"), its relation given by path ("yes given by path"), no adjacency ("no, adjacency is not needed"), held as
   the frame's `entries`. "As before, do not modify the executor or other code that uses paths at this time": the
   executor's frames carry neither; a service writes them through the builders, and `References.resolve` gives a
   frame's bindings.
8. A pattern's symbol may be given a reference instead of a schema, "(a) allow a symbol to have a reference instead of a
   schema" (2026-10-23), so that a query starts from one object (CAP-008): no syntax bound a symbol to a given object
   since the spec replaced locators (Object identity, Decided, 76). It generalizes 77 ("singletons are denoted by their
   schema"): a symbol given a `References.OfObject` binds what it designates, one object, or none where the store holds
   none. Chosen over a spec item asserting identity (`_.x.is_([ref])`), which would range over the symbol's schema
   first. Planned: `References.install` extends `Schemas.OfSymbol` with `reference`, a symbol having exactly one of
   `schema` and `reference`; `.symbols({"x": ref})` records it, the symbol's members those of the schema of the object
   it designates when recorded.

## Fixed by the agent, for the user's review

- Each schema is a value object (as a path is); `OfObject` a union of one branch, `path`, so that its wire form
  (`{"path": ...}`) holds.
- `References` is held by every store, read by the bootstrap after `Paths`, as framework schemas are; not installed
  before use as `Parametrics` is, since what it designates is the framework's own (paths, upserts, entries).
- The operations' names, `of` and `resolve`, after `Paths.of` and `store.held`.
- Settled in building it (4n), the simplest choice consistent with the code:
  - `References.OfFrame` holds its symbols in one property, `binds`, a container of `References.OfObject` by symbol,
    and its variables in another, `variables`, a container of values of any schema by name, empty while the executor
    binds no variable (87).
  - `References.OfEntry` holds `relation`, a `Paths.OfRoot`; `links`, a container of `References.OfObject` by link;
    and `properties`, a container of values of any schema by property (an unrestricted `OfAny`, as
    `Parametrics.BindsValue` holds a value), so that a property of any schema is held, each tagged on the wire by its
    schema (`{"since": {"int": 2020}}`).
  - `of` refuses a counted object, "a counted 'crm.Note' has no reference: nothing names it (make it a singleton's or
    an owner's)", and a frame binding one, "symbol 'note' of the frame: ..." (`LookupError`).
  - `of` takes the store whose schemas the reference is a value of, and refuses another store's object ("the object
    belongs to another store", `TypeError`) and anything not an object, an entry or a frame (`TypeError`); an entry of
    a relation with no name of its own has no path, so `of` refuses it as `Paths.of` does (`LookupError`). A frame is
    a mapping of symbols to objects, a `Map` in TypeScript, as `store.transaction` gives it back.
  - `resolve` takes a reference of the store's own schemas (one read from the wire is read with the store's
    `References.*` schema first), refusing anything else (`TypeError`). It gives an object, the entry the store holds
    now (an update may rewrite an object's entries: entries compare by value, and the one held is given back), or a
    frame; None where the store holds nothing it designates: a path to nothing, a frame or an
    entry one of whose objects is not held, an entry no relation entry agrees with, link for link and property for
    property, or a reference giving no links.

## Stages, as built

- **4n**, one stage, both languages: `Framework/References.py` and `typescript5/src/Framework/References.ts`
  (exported as `References`, beside `Paths`), `install(txn)` read by the bootstrap after `Paths` (every store holds the
  four schemas, then three: `References.OfObject`, `OfFrame`, `OfEntry`), `of` and `resolve`. `References.OfUpserted`,
  first built with the executor's record of what made each upserted object (`store._made_by`), was removed with it,
  as the user decided (Decided, 2); the executor's upsert index stays one function, `Transactions._upsert_index`.
  Paths are marked deprecated in favor of References in
  OBJECT_IDENTITY.md, SERIALIZATION.md, FRAMEWORK.md (and its Resolved entry, References), tutorial 6 and the skill
  (python.md and typescript.md, a section each). No example used Paths. The wire and the corpora are unchanged. REF-01
  to REF-07 cover it, in both languages.
