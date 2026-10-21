<!-- nav -->
[← Schema extension](SCHEMA_EXTENSION.md) · [Home](../README.md) · [Mutations as Queries →](STREAMING_QUERIES.md)

# Serialization 

- ToPlain does the work of serialization. No bespoke classes
- the wire format is a log of Mutations.OfX where X is a schema kind
- there are no foreign schemas. if any schema is encountered by ToPlain that is not present in the same store, it is a fatal error

## Mutations : Implementation

- Mutations are schema-governed like everything else (P-018): each verb and noun has a meta-schema, and ToPlain writes a log as it writes any value.
- `Mutations/OfX.{py,ts}` must be built as the first step and can be tested as a unit.
- then initial snapshot
- then subsequent snapshots

## Mutations : Vocabulary

*Reference verbs* are the backbone and appear as top-level objects in the log:

```python
Mutations.OfObject.{Exists, AsProperty}
Mutations.OfRelation.{Insert, Remove, Clear, AsEntries}
```

`Mutations.OfRelation.{Insert, Remove}` carry a reference to the relation schema and a list of `Mutations.OfEntry`, which
itself carries `Mutations.OfProperty.*` and `Mutations.OfLink.*`, through `Mutations.OfEntry.{AsProperty, AsLink}`:

```python
Mutations.OfEntry.{AsProperty, AsLink}
Mutations.OfLink.{Set, Clear}
```

`Mutations.OfRelation.AsEntries` carries a list of the following applied in modulo order:

```python
Mutations.OfEntry.AsProperty
```

`Mutations.OfObject.AsProperty` and `Mutations.OfEntry.AsProperty` carry a list of *Value verbs*:

```python
Mutations.OfProperty.{Set, Clear, AsAny}
Mutations.OfContainer.{Insert, Remove, Append, Prepend, Clear, AsItems}
Mutations.OfAny.{Set, Clear, AsScalar, AsContainer, AsObject, AsUnion, AsIntersection}
Mutations.OfScalar.{Set, Clear}
Mutations.OfUnion.AsBranch
Mutations.OfIntersection.AsPart
```

- `Mutations.OfAny.AsObject` carries a list of `Mutations.OfObject.AsProperty` with no `Ref`: the reference object a path
  starts from is named at its root, and the nested value verbs follow the path from there.
- `Mutations.OfUnion.AsBranch` and `Mutations.OfIntersection.AsPart` name a branch or a part and carry a list of
  `Mutations.OfProperty.*`, as a property does; writing a branch clears the others (`Visitors.OfUnion`).
- `Mutations.OfContainer.AsItems` carries a list of `Mutations.OfAny.*` applied in modulo order: with three mutations in
  the list, item 0 gets the first, item 1 the second, item 2 the third, item 3 the first, and so on. The list of items in the list is not required to utilize the entire list of mutations

Value verbs cannot appear at the top level of the log, only as nested mutations.

A change can be written in more than one form (`OfProperty.Set`, or `OfProperty.AsAny` then `OfAny.Set`, ...). Which form
ToPlain writes is a serializer mode: by default, the form whose serialized mutation is smallest, a tie going to the
shallowest form; the mode is configurable. A reader accepts every form.

`Mutations.OfX.AsY` has a list of `Mutations.OfY.*` 

Exists is a reentrant version of create. Noop if the identity already exists. Exists carries a `Mutations.OfObject.Def`.

Nouns are used by verbs and appear nested in a verb:

```python
Mutations.OfContainer.Slice # a section of a container
Mutations.OfObject.Ref # identity only: an object's path (a schema object's from the root module, "."), or a counted object's number in the log (docs/OBJECT_IDENTITY.md, 55, 81)
Mutations.OfObject.Def # includes props; its path or number, and its schema's name (a schema object's kind's, `Schemas.OfObject`); where it is linked, no path, its entries nested (`inserts`)
```

- scalar payloads are untyped and interpreted according to their schema
- `Mutations.OfObject.Def` carries a schema reference, and its object's properties; never its adjacencies, which `Mutations.OfRelation.Insert` writes
- reference objects are written as `Mutations.OfObject.{Def,Ref}` directly under `Mutations.OfObject.*` at the top level of the log, never nested as value objects are
- reference objects are only written in "definition form" the first time they are encountered. subsequent encounters are written in "reference form" as identity

## Order : Initial Snapshot

For an initial snapshot, ToPlain writes in this order:

- modules
- schemas
- other named singletons, each followed by the data it reaches: data nothing reaches from a singleton is not written,
  and a counted object is numbered in the order the log meets it (docs/OBJECT_IDENTITY.md, Decided, 55)

## Reading : Extensions the store lacks

A store never writes the schemas it was made holding, so what an extension added to them is not in its snapshot. A
store reading a snapshot made with an extension it lacks ignores each sub-clause whose meaning needs it, and keeps it,
with its path and why, in the list given (`Plain.FromPlain(store).Snapshot(log, ignored)`, and the JSON and YAML forms):

- a property a schema the store was made holding lacks (`unit` on `Schemas.OfScalar`): the rest of the object is read;
- a property of an entry of such a relation;
- an entry no linked object can hold, where one of them is of such a schema: one any linked object can hold is kept.

What an extension builds is written and read like any schema, so a member another schema lacks is a malformed snapshot
still (Store overhaul, Decided, 19).

## Transactions on the wire

A transaction is written as its expression (docs/OBJECT_IDENTITY.md, Decided, 56; Store overhaul, 4f), nested, since
reading it executes it: `Plain.ToPlain(store).Transaction(tx)` writes it, `Plain.FromPlain(store).Transaction(plain)`
builds it again through the store's builders, and `store.transaction(...)` executes it. A journal is a list of them, as
submitted, replayed by executing each in order; a transaction's imperative scope has no expression, so none (103).

```json
{"uid": "6f1c4e2a", "mutations": [{"upsert": {"key": "k", "exists": [{
  "symbols": {"book": {"schema": [{"$ref": <crm.Book's path>}]}, "ada": {"schema": [{"$ref": <crm.Person's path>}]}},
  "spec": [{"ada": [{"as_property": {"name": "name", "mutations": [{"set": {"value": "Ada"}}]}}]}]}]}}]}
```

- An object is a mapping of its properties, then its named adjacencies, in its schema's order.
- An adjacency's entries: where its relation has one other link and no properties, what each links (the peer
  shorthand); where it has one other link and one property, a mapping of that property to what each links (a
  pattern's symbols, by name); else each entry's links and properties.
- What an entry links is nested where it has no path, a term linked from one place or a schema object with no name of
  its own, and tagged with its kind where the link is a kind union (`{"upsert": ...}`), or with its schema's name where
  several schemas fill the link (`{"Schemas.OfUnion": ...}`); anything else is `{"$ref": path}`.
- A pattern's spec is written as recorded: for each symbol, the mutations of the object it binds (`Mutations.OfPattern`).

## Documents

A document of objects, `Plain.ToPlain(store).Reachable(schema, root, uid)` or `.OfObject`, is one transaction
(docs/OBJECT_IDENTITY.md, Decided, 51 and 55; Store overhaul, 4f-3), written as a transaction on the wire is: one
upsert, keyed by the uid where the caller gives one, whose symbols are the objects the document holds and whose spec
gives what holds of each.

- The objects it holds: the root, `"0"`, and, for Reachable, the counted objects reachable from it through the objects
  it holds, each named by its number in the order the document meets them, through each object's named adjacencies in
  its schema's order and their entries in the order written. Each symbol names its schema by the schema's path; the
  schema must be one the store holds.
- Its spec: each object's properties that are set (`as_property`), then its named adjacencies' entries (`as_adjacency`,
  `insert`), each entry once, from the first object the document holds that holds it, sorted by the key its relation
  declares where every entry has each of the key's values and they are ordered. An entry's links refer to a symbol,
  `{"ref": {"symbol": "1"}}`, or, for an object the document does not hold (an owned object, a singleton, a schema
  object), its path, `{"ref": {"path": ...}}`. A counted object it does not hold cannot be referred to: writing such a
  document is refused. An owned root is written with the entry that owns it, so its owning adjacency must be named.
- Reading executes it, within the store's open transaction as a savepoint, else as a transaction of its own, and gives
  the object `"0"` binds; the root schema given must be one it is of. A document with no uid is keyed afresh by each
  read, so that each read makes new counted objects; one under a uid, read again while what it made is held, finds
  those (Decided, 102). Its spec is checked against its symbols' schemas before it runs.

## Order : Subsequent Snapshots

In anticipation for journal formatting, a stateful instance of ToPlain may be retainable. Subsequent snapshots can be sent as mutation logs without having to re-send modules and schemas.

---

<!-- nav -->
[← Schema extension](SCHEMA_EXTENSION.md) · [Home](../README.md) · [Mutations as Queries →](STREAMING_QUERIES.md)
