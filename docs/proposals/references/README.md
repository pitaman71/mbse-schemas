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
