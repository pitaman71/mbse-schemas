<!-- nav -->
[← Schema extension](SCHEMA_EXTENSION.md) · [Home](../README.md) · [Visitor pattern →](VISITOR_PATTERN.md)

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
Mutations.OfObject.Ref # identity only: a schema object's key, Module.Schema/ID; data's path (docs/OBJECT_IDENTITY.md)
Mutations.OfObject.Def # includes props; and a schema object's key, or data's path and its schema's name (`Schema@`)
```

- scalar payloads are untyped and interpreted according to their schema
- `Mutations.OfObject.Def` carries a schema reference, and its object's properties; never its adjacencies, which `Mutations.OfRelation.Insert` writes
- reference objects are written as `Mutations.OfObject.{Def,Ref}` directly under `Mutations.OfObject.*` at the top level of the log, never nested as value objects are
- reference objects are only written in "definition form" the first time they are encountered. subsequent encounters are written in "reference form" as identity

## Order : Initial Snapshot

For an initial snapshot, ToPlain writes in this order:

- modules
- schemas
- other named singletons
- any remaining reference objects

## Reading : Extensions the store lacks

A store never writes the schemas it was made holding, so what an extension added to them is not in its snapshot. A
store reading a snapshot made with an extension it lacks ignores each sub-clause whose meaning needs it, and keeps it,
with its path and why, in the list given (`Plain.FromPlain(store).Snapshot(log, ignored)`, and the JSON and YAML forms):

- a property a schema the store was made holding lacks (`unit` on `Schemas.OfScalar`): the rest of the object is read;
- a property of an entry of such a relation;
- an entry no linked object can hold, where one of them is of such a schema: one any linked object can hold is kept.

What an extension builds is written and read like any schema, so a member another schema lacks is a malformed snapshot
still (Store overhaul, Decided, 19).

## Order : Subsequent Snapshots

In anticipation for journal formatting, a stateful instance of ToPlain may be retainable. Subsequent snapshots can be sent as mutation logs without having to re-send modules and schemas.

---

<!-- nav -->
[← Schema extension](SCHEMA_EXTENSION.md) · [Home](../README.md) · [Visitor pattern →](VISITOR_PATTERN.md)
