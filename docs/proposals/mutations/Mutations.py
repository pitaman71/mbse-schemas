"""Mutations: the schemas of a mutation log, as docs/SERIALIZATION.md gives its vocabulary. (Proposed: the first step of
Serialization, "Mutations/OfX.{py,ts}"; built here in a store with the new builders, to be reviewed before code.)

Every mutation is a value object: a log entry has no identity and is never shared. Each family of verbs is a union whose
branches are its verbs, so that a verb is written as its union's branch (`{"exists": {...}}`), and a list of verbs is a
container of that union. A branch is named after its verb, less `As` (`AsProperty` is `property`): names starting with
`as_` belong to the visitor protocol. A noun (`Ref`, `Def`, `Slice`) is a value object nested in a verb.

Payloads (a property's value, an entry's properties, an object's properties) are values of whatever schema the target
gives: their type here is a value of any type, and ToPlain writes them untyped, interpreted by the target's schema
(Serialization: "scalar payloads are untyped and interpreted according to their schema").

Run from python3/: `uv run python ../docs/proposals/mutations/Mutations.py`.
"""

from __future__ import annotations

from mbse.Schemas.Framework import Builders as B


def define(store: B.Store) -> dict[str, object]:
    """Builds the mutation schemas in `store`, and returns them by name."""
    Text = store.Schemas.Scalar(lambda s: s.token("str"))
    Int = store.Schemas.Scalar(lambda s: s.token("int"))
    Payload = store.Schemas.Any(lambda a: a)  # untyped: interpreted by the target's schema

    def list_of(element: object) -> object:
        return store.Schemas.Container(lambda c: c.index([Int]).element([element]))

    # --- Nouns ---

    Ref = store.Schemas.Object(lambda o: (
        o
        .name("Mutations.OfObject.Ref")
        .properties([
            lambda t: t.name("key").type([Text]),  # identity only: "Module.Schema/ID"
        ])
    ))
    Def = store.Schemas.Object(lambda o: (
        o
        .name("Mutations.OfObject.Def")
        .properties([
            lambda t: t.name("key").type([Text]),  # "Module.Schema/ID": the schema reference and the identity
            lambda t: t.name("properties").type([store.Schemas.Container(lambda c: (
                c
                .index([Text])
                .element([Payload])
            ))]),
        ])
    ))
    Slice = store.Schemas.Object(lambda o: (
        o
        .name("Mutations.OfContainer.Slice")
        .properties([
            lambda t: t.name("index").type([Payload]),  # where the section starts, by the container's index
            lambda t: t.name("items").type([list_of(Payload)]),
        ])
    ))

    # --- The unions of verbs, filled below: each refers to the others ---

    Reference = store.Schemas.Union(lambda u: u.name("Mutations.Reference"))  # top level: OfObject, OfRelation
    OfProperty = store.Schemas.Union(lambda u: u.name("Mutations.OfProperty"))
    OfContainer = store.Schemas.Union(lambda u: u.name("Mutations.OfContainer"))
    OfAny = store.Schemas.Union(lambda u: u.name("Mutations.OfAny"))
    OfScalar = store.Schemas.Union(lambda u: u.name("Mutations.OfScalar"))

    def verb(name: str, *properties: object) -> object:
        """A verb: a value object of `properties`, each a callback naming one and giving its type."""
        return store.Schemas.Object(lambda o: o.name(name).properties(list(properties)))

    def mutations(of: object) -> object:
        """A verb's nested mutations: a list of `of`."""
        return lambda t: t.name("mutations").type([list_of(of)])

    def named(property: str = "name") -> object:
        return lambda t: t.name(property).type([Text])

    # --- Value verbs ---

    Set = verb("Mutations.Set", lambda t: t.name("value").type([Payload]))
    Clear = verb("Mutations.Clear")
    PropertyAsAny = verb("Mutations.OfProperty.AsAny", mutations(OfAny))
    Insert = verb("Mutations.OfContainer.Insert", lambda t: t.name("slice").type([Slice]))
    Remove = verb("Mutations.OfContainer.Remove", lambda t: t.name("slice").type([Slice]))
    Append = verb("Mutations.OfContainer.Append", lambda t: t.name("items").type([list_of(Payload)]))
    Prepend = verb("Mutations.OfContainer.Prepend", lambda t: t.name("items").type([list_of(Payload)]))
    AsItems = verb("Mutations.OfContainer.AsItems", mutations(OfAny))  # applied in modulo order
    AsScalar = verb("Mutations.OfAny.AsScalar", mutations(OfScalar))
    AsContainer = verb("Mutations.OfAny.AsContainer", mutations(OfContainer))
    NestedAsProperty = verb("Mutations.OfObject.AsNestedProperty", named(), mutations(OfProperty))  # no Ref
    AsObject = verb("Mutations.OfAny.AsObject", mutations(NestedAsProperty))
    AsBranch = verb("Mutations.OfUnion.AsBranch", named(), mutations(OfProperty))
    AsPart = verb("Mutations.OfIntersection.AsPart", named(), mutations(OfProperty))
    AsUnion = verb("Mutations.OfAny.AsUnion", mutations(AsBranch))
    AsIntersection = verb("Mutations.OfAny.AsIntersection", mutations(AsPart))

    # --- Reference verbs: the top level of the log ---

    Exists = verb("Mutations.OfObject.Exists", lambda t: t.name("def").type([Def]))
    ObjectAsProperty = verb("Mutations.OfObject.AsProperty", lambda t: t.name("ref").type([Ref]), named(),
                            mutations(OfProperty))
    EntryAsProperty = verb("Mutations.OfEntry.AsProperty", named(), mutations(OfProperty))
    entry = (  # an entry of a relation: its links, by name, and its properties, by name
        lambda t: t.name("relation").type([Text]),
        lambda t: t.name("links").type([store.Schemas.Container(lambda c: c.index([Text]).element([Ref]))]),
        lambda t: t.name("properties").type([store.Schemas.Container(lambda c: c.index([Text]).element([Payload]))]),
    )
    RelationInsert = verb("Mutations.OfRelation.Insert", *entry)
    RelationRemove = verb("Mutations.OfRelation.Remove", *entry)
    RelationClear = verb("Mutations.OfRelation.Clear", lambda t: t.name("ref").type([Ref]), named("adjacency"))
    AsEntries = verb("Mutations.OfRelation.AsEntries", lambda t: t.name("ref").type([Ref]), named("adjacency"),
                     mutations(EntryAsProperty))  # applied in modulo order

    # --- The unions' branches ---

    store.Schemas.Union(Reference, lambda u: u.branches([
        lambda t: t.name("exists").type([Exists]),
        lambda t: t.name("property").type([ObjectAsProperty]),
        lambda t: t.name("insert").type([RelationInsert]),
        lambda t: t.name("remove").type([RelationRemove]),
        lambda t: t.name("clear").type([RelationClear]),
        lambda t: t.name("entries").type([AsEntries]),
    ]))
    store.Schemas.Union(OfProperty, lambda u: u.branches([
        lambda t: t.name("set").type([Set]),
        lambda t: t.name("clear").type([Clear]),
        lambda t: t.name("any").type([PropertyAsAny]),
    ]))
    store.Schemas.Union(OfContainer, lambda u: u.branches([
        lambda t: t.name("insert").type([Insert]),
        lambda t: t.name("remove").type([Remove]),
        lambda t: t.name("append").type([Append]),
        lambda t: t.name("prepend").type([Prepend]),
        lambda t: t.name("clear").type([Clear]),
        lambda t: t.name("items").type([AsItems]),
    ]))
    store.Schemas.Union(OfAny, lambda u: u.branches([
        lambda t: t.name("set").type([Set]),
        lambda t: t.name("clear").type([Clear]),
        lambda t: t.name("scalar").type([AsScalar]),
        lambda t: t.name("container").type([AsContainer]),
        lambda t: t.name("object").type([AsObject]),
        lambda t: t.name("union").type([AsUnion]),
        lambda t: t.name("intersection").type([AsIntersection]),
    ]))
    store.Schemas.Union(OfScalar, lambda u: u.branches([
        lambda t: t.name("set").type([Set]),
        lambda t: t.name("clear").type([Clear]),
    ]))
    Log = store.Schemas.Container(lambda c: c.name("Mutations.Log").index([Int]).element([Reference]))
    return {name: schema for name, schema in locals().items() if name[0].isupper()}


if __name__ == "__main__":
    schemas = define(B.Store())
    problems = {name: schema.validate() for name, schema in schemas.items() if schema.validate()}
    assert not problems, problems
    print(f"{len(schemas)} mutation schemas, all valid")
