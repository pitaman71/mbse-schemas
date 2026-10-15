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

Verbs are the backbone and appear as top-level objects in the log:

```python
Mutations.OfAny.{Clear, Set}
Mutations.OfScalar.{Clear, Set}
Mutations.OfContainer.{Insert, Remove, Append, Prepend, Clear}
Mutations.OfObject.{Exists, UpdateProps}
Mutations.OfRelation.{Insert, Remove, Clear}
```

A few schema kinds OfX are intentionally omitted and should be covered by the mutations vocab above in a straightforward way.

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
