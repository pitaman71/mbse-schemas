<!-- nav -->
[← Schema extension](SCHEMA_EXTENSION.md) · [Home](../README.md) · [Mutations as Queries →](STREAMING_QUERIES.md)

# Serialization 

- ToPlain does the work of serialization. No bespoke classes
- the wire format is a log of Mutations.OfX where X is a schema kind; as built (Object identity, Decided, 56 and 101), it
  is transactions, each written as its expression, whose patterns' specs are the `Mutations.OfX` verbs below
- there are no foreign schemas. if any schema is encountered by ToPlain that is not present in the same store, it is a fatal error

## Mutations : Implementation

- Mutations are schema-governed like everything else (P-018): each verb and noun has a meta-schema, and ToPlain writes
  them as it writes any value.
- `Mutations/OfX.{py,ts}` must be built as the first step and can be tested as a unit.
- then the snapshot, two transactions (Snapshots, below)
- then subsequent snapshots

## Mutations : Vocabulary

A pattern's spec (docs/OBJECT_IDENTITY.md, Decided, 95), a `Mutations.OfPattern`, gives for each symbol the mutations
of the object it binds, *object verbs*:

```python
Mutations.OfObject.{AsProperty, AsAdjacency, Spec}
Mutations.OfAdjacency.{Insert, Remove, Clear}
```

`Mutations.OfObject.Spec`, `{"spec": {"items": [...]}}`, is a pattern's own spec, written as recorded: a list of
`Mutations.OfPattern`, whose payloads are bare. Where a pattern is a symbol or a definition, it gives the spec the
pattern holds, in place of any it held before; its shape is checked when it is read, and what it says when the pattern
is executed.

`Mutations.OfAdjacency.Remove` removes each entry that agrees with an entry it gives, every link and property given
equal to the entry's, and `Mutations.OfAdjacency.Clear` every entry an adjacency holds; a spec holds where what it
removes is absent (Store overhaul, 4j, as built). `Mutations.OfAdjacency.{Insert, Remove}` carry a list of
`Mutations.OfEntry`, each leaving out the link the object
fills, which carries `Mutations.OfProperty.*` and `Mutations.OfLink.*`, through `Mutations.OfEntry.{AsProperty, AsLink}`:

```python
Mutations.OfEntry.{AsProperty, AsLink}
Mutations.OfLink.{Set, Clear}
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

- `Mutations.OfAny.AsObject` carries a list of `Mutations.OfObject.AsProperty`: the nested value verbs follow the
  property that holds the value object.
- `Mutations.OfUnion.AsBranch` and `Mutations.OfIntersection.AsPart` name a branch or a part and carry a list of
  `Mutations.OfProperty.*`, as a property does; writing a branch clears the others (`Visitors.OfUnion`).
- `Mutations.OfContainer.AsItems` carries a list of `Mutations.OfAny.*` applied in modulo order: with three mutations in
  the list, item 0 gets the first, item 1 the second, item 2 the third, item 3 the first, and so on. The list of items in the list is not required to utilize the entire list of mutations

Value verbs appear only nested in an object's or an entry's property.

A change can be written in more than one form (`OfProperty.Set`, or `OfProperty.AsAny` then `OfAny.Set`, ...). Which form
ToPlain writes is a serializer mode: by default, the form whose serialized mutation is smallest, a tie going to the
shallowest form; the mode is configurable. A reader accepts every form.

`Mutations.OfX.AsY` has a list of `Mutations.OfY.*` 

The log's own verbs, `Mutations.OfObject.Exists` (a reentrant create, a noop where the identity exists), a relation's
`Insert`, `Remove`, `Clear` and `AsEntries`, `Mutations.Log` and `Mutations.Reference`, are gone (Store overhaul, 4f):
what they wrote, an upsert's spec writes, and an upsert finds what exists.

Nouns are used by verbs and appear nested in a verb:

```python
Mutations.OfContainer.Slice # a section of a container
Mutations.OfObject.Ref # identity only: an object's path (a schema object's from the root module, "."), or, in a spec, the symbol that binds it (docs/OBJECT_IDENTITY.md, 81, 95)
Mutations.OfObject.Def # an object with no path, defined where it is linked: its schema's name (a schema object's kind's, `Schemas.OfObject`) and its own mutations
```

- scalar payloads are untyped and interpreted according to their schema
- reference objects are symbols of a transaction's patterns, never nested as value objects are; a link refers to one by
  its symbol or its path
- an object is written once, in the spec of the symbol that binds it; elsewhere it is referred to

## Snapshots

A store's snapshot, `Plain.ToPlain(store).Snapshot()`, is two transactions (docs/OBJECT_IDENTITY.md, Decided, 45 and
101; Store overhaul, 4f-4), each one upsert, written as a transaction on the wire is:

- **its modules and schemas**: the root module, then what each module holds, in the order it holds it, a module's
  contents following it, each a symbol of its meta-schema found where the store reading it holds it: a module by its
  path, the root module by none (its name cleared), a schema by its name (86); so that reading it makes them in the
  order each module held them. A schema no module holds follows them; so that a schema it held before is
  extended when the transaction commits (96); a schema object with no name of its own defined where it is linked
  (`{"def": ...}`); a schema the store was made holding is a symbol only where it holds an extension's entries linking
  schema objects, and then only its name and those entries are written;
- **its data**: each singleton, then what the singletons reach, in the order met, each a symbol: a singleton's binds the
  singleton, an owned object's is placed by its owner's entry (60), a counted object's is created; data that schema
  objects' extension entries link is reached from them, those schema objects symbols too, for those entries alone. Data
  nothing reaches is not written.

Each symbol's spec gives its properties, then its named adjacencies' entries, each entry once, from the first symbol
that holds it, then, a pattern's, its own spec (`spec`), so that a pattern is carried whole; an object neither transaction holds, a schema the store was made holding, is referred to by its path.
`Plain.FromPlain(store).Snapshot(snapshot)` executes them in order, each a transaction of its own, or a savepoint of the
one open, and gives the data the last binds, which the caller holds. Read again, a snapshot finds its schemas and its
singletons and owned objects, and makes its counted objects anew.

## Reading : Extensions the store lacks

A store never writes the schemas it was made holding, but for an extension's entries, so what an extension added to
them is in a snapshot only as the members of its schemas. A store reading a snapshot made with an extension it lacks
ignores each member whose meaning needs it, and keeps it, with its path and why, in the list given
(`Plain.FromPlain(store).Snapshot(snapshot, ignored)`, and the JSON and YAML forms):

- a member a schema the store was made holding lacks (a property, `unit` on `Schemas.OfObject`, or an adjacency, `tags`
  on `Schemas.OfScalar`): the rest of the object is read;
- a property of an entry of such a relation.

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

In anticipation for journal formatting, a stateful instance of ToPlain may be retainable. Subsequent snapshots can be sent as mutation logs without having to re-send modules and schemas. As built, a journal is a list of transactions, as submitted (Transactions on the wire, above).

---

<!-- nav -->
[← Schema extension](SCHEMA_EXTENSION.md) · [Home](../README.md) · [Mutations as Queries →](STREAMING_QUERIES.md)
