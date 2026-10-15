<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Visitor pattern →](VISITOR_PATTERN.md)

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

- `Mutations.OfAny.AsObject` carries a list of `Mutations.OfObject.AsProperty` with no `Ref`: the value object it changes is
  the one it is nested in.
- `Mutations.OfUnion.AsBranch` and `Mutations.OfIntersection.AsPart` name a branch or a part and carry a list of
  `Mutations.OfProperty.*`, as a property does; writing a branch clears the others (`Visitors.OfUnion`).
- `Mutations.OfContainer.AsItems` carries a list of `Mutations.OfAny.*` applied in modulo order: with three mutations in
  the list, item 0 gets the first, item 1 the second, item 2 the third, item 3 the first, and so on. The list of items in the list is not required to utilize the entire list of mutations

Value verbs cannot appear at the top level of the log, only as nested mutations.

A change can be written in more than one form (`OfProperty.Set`, or `OfProperty.AsAny` then `OfAny.Set`, ...). Which form
ToPlain writes is a serializer mode: by default, the form whose serialized mutation is smallest; the mode is
configurable. A reader accepts every form.

`Mutations.OfX.AsY` has a list of `Mutations.OfY.*` 

Exists is a reentrant version of create. Noop if the identity already exists. Exists carries a `Mutations.OfObject.Def`.

Nouns are used by verbs and appear nested in a verb:

```python
Mutations.OfContainer.Slice # a section of a container
Mutations.OfObject.Ref # identity only, Module.Schema/ID
Mutations.OfObject.Def # includes props
```

- scalar payloads are untyped and interpreted according to their schema
- `Mutations.OfObject.Def` carries a schema reference
- reference objects are written as `Mutations.OfObject.{Def,Ref}` directly under `Mutations.OfObject.*` at the top level of the log, never nested as value objects are
- reference objects are only written in "definition form" the first time they are encountered. subsequent encounters are written in "reference form" as identity

## Order : Initial Snapshot

For an initial snapshot, ToPlain writes in this order:

- modules
- schemas
- other named singletons
- any remaining reference objects

## Order : Subsequent Snapshots

In anticipation for journal formatting, a stateful instance of ToPlain may be retainable. Subsequent snapshots can be sent as mutation logs without having to re-send modules and schemas.

---

<!-- nav -->
[← Open-world modeling](OPEN_WORLD.md) · [Home](../README.md) · [Visitor pattern →](VISITOR_PATTERN.md)
