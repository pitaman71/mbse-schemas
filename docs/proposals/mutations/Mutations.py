"""Mutations: the schemas of a mutation log, as docs/SERIALIZATION.md gives its vocabulary. (Proposed: the first step of
Serialization, "Mutations/OfX.{py,ts}"; built here in a store with the new builders, to be reviewed before code.)

Every mutation is a value object: a log entry has no identity and is never shared. Each family of verbs is a union whose
branches are its verbs, named as the visitor's members are (`AsProperty` is `as_property`, as `osv.<propName>` and
`as_*` name what a visitor hands over), so that a verb is written as its union's branch (`{"exists": {...}}`), and a
list of verbs is a container of that union. A noun (`Ref`, `Def`, `Slice`) is a value object nested in a verb.

The reference object a path starts from is named once, at the top of the log (`Mutations.OfObject.AsProperty`'s `ref`);
the nested value verbs follow the path from there, so a verb nested in another names no reference object.

Payloads (a property's value, an object's properties) are values of whatever schema the target gives: their type here is
a value of any type, and ToPlain writes them untyped, interpreted by the target's schema (Serialization: "scalar
payloads are untyped and interpreted according to their schema").

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

    def verb(name: str, *properties: object) -> object:
        """A verb: a value object of `properties`, each a callback naming one and giving its type."""
        return store.Schemas.Object(lambda o: o.name(f"Mutations.{name}").properties(list(properties)))

    def mutations(of: object) -> object:
        """A verb's nested mutations: a list of `of`."""
        return lambda t: t.name("mutations").type([list_of(of)])

    def text(name: str) -> object:
        return lambda t: t.name(name).type([Text])

    # --- Nouns ---

    Ref = verb("OfObject.Ref", text("key"))  # identity only: "Module.Schema/ID"
    Def = verb(
        "OfObject.Def",
        text("key"),  # "Module.Schema/ID": the schema reference and the identity
        lambda t: t.name("properties").type([store.Schemas.Container(lambda c: c.index([Text]).element([Payload]))]),
    )
    Slice = verb(
        "OfContainer.Slice",
        lambda t: t.name("index").type([Payload]),  # where the section starts, by the container's index
        lambda t: t.name("items").type([list_of(Payload)]),
    )

    # --- The unions of verbs, filled below: each refers to the others ---

    def union(name: str) -> object:
        return store.Schemas.Union(lambda u: u.name(f"Mutations.{name}"))

    Reference = union("Reference")  # the top level of the log: OfObject's and OfRelation's verbs
    OfProperty = union("OfProperty")
    OfContainer = union("OfContainer")
    OfAny = union("OfAny")
    OfScalar = union("OfScalar")
    OfLink = union("OfLink")
    OfEntryMember = union("OfEntry.Member")  # what an entry's mutations are: its properties' and its links'

    # --- Value verbs ---

    PropertySet = verb("OfProperty.Set", lambda t: t.name("value").type([Payload]))
    PropertyClear = verb("OfProperty.Clear")
    PropertyAsAny = verb("OfProperty.AsAny", mutations(OfAny))
    Insert = verb("OfContainer.Insert", lambda t: t.name("slice").type([Slice]))
    Remove = verb(  # proposed: a section by its start and its length
        "OfContainer.Remove",
        lambda t: t.name("index").type([Payload]),
        lambda t: t.name("count").type([Int]),
    )
    Append = verb("OfContainer.Append", lambda t: t.name("items").type([list_of(Payload)]))
    Prepend = verb("OfContainer.Prepend", lambda t: t.name("items").type([list_of(Payload)]))
    ContainerClear = verb("OfContainer.Clear")
    AsItems = verb("OfContainer.AsItems", mutations(OfAny))  # applied in modulo order
    AnySet = verb("OfAny.Set", lambda t: t.name("value").type([Payload]))
    AnyClear = verb("OfAny.Clear")
    AsScalar = verb("OfAny.AsScalar", mutations(OfScalar))
    AsContainer = verb("OfAny.AsContainer", mutations(OfContainer))
    ScalarSet = verb("OfScalar.Set", lambda t: t.name("value").type([Payload]))
    ScalarClear = verb("OfScalar.Clear")
    AsBranch = verb("OfUnion.AsBranch", text("name"), mutations(OfProperty))
    AsPart = verb("OfIntersection.AsPart", text("name"), mutations(OfProperty))
    AsUnion = verb("OfAny.AsUnion", mutations(AsBranch))
    AsIntersection = verb("OfAny.AsIntersection", mutations(AsPart))
    LinkSet = verb("OfLink.Set", lambda t: t.name("ref").type([Ref]))
    LinkClear = verb("OfLink.Clear")

    # --- Reference verbs, and what an object's or an entry's mutations are ---

    Exists = verb("OfObject.Exists", lambda t: t.name("def").type([Def]))
    AsProperty = verb(  # `ref` at the top of the log only; nested under OfAny.AsObject, the path gives the object
        "OfObject.AsProperty",
        lambda t: t.name("ref").type([Ref]),
        text("name"),
        mutations(OfProperty),
    )
    AsObject = verb("OfAny.AsObject", mutations(AsProperty))
    EntryAsProperty = verb("OfEntry.AsProperty", text("name"), mutations(OfProperty))
    EntryAsLink = verb("OfEntry.AsLink", text("name"), mutations(OfLink))
    Entry = verb("OfEntry", mutations(OfEntryMember))  # an entry: its links' and its properties' mutations
    RelationInsert = verb(
        "OfRelation.Insert",
        lambda t: t.name("relation").type([Ref]),  # the relation schema
        lambda t: t.name("entries").type([list_of(Entry)]),
    )
    RelationRemove = verb(
        "OfRelation.Remove",
        lambda t: t.name("relation").type([Ref]),
        lambda t: t.name("entries").type([list_of(Entry)]),
    )
    RelationClear = verb("OfRelation.Clear", lambda t: t.name("ref").type([Ref]), text("adjacency"))
    AsEntries = verb(  # applied in modulo order
        "OfRelation.AsEntries",
        lambda t: t.name("ref").type([Ref]),
        text("adjacency"),
        mutations(EntryAsProperty),
    )

    # --- The unions' branches ---

    store.Schemas.Union(Reference, lambda u: u.branches([
        lambda t: t.name("exists").type([Exists]),
        lambda t: t.name("as_property").type([AsProperty]),
        lambda t: t.name("insert").type([RelationInsert]),
        lambda t: t.name("remove").type([RelationRemove]),
        lambda t: t.name("clear").type([RelationClear]),
        lambda t: t.name("as_entries").type([AsEntries]),
    ]))
    store.Schemas.Union(OfProperty, lambda u: u.branches([
        lambda t: t.name("set").type([PropertySet]),
        lambda t: t.name("clear").type([PropertyClear]),
        lambda t: t.name("as_any").type([PropertyAsAny]),
    ]))
    store.Schemas.Union(OfContainer, lambda u: u.branches([
        lambda t: t.name("insert").type([Insert]),
        lambda t: t.name("remove").type([Remove]),
        lambda t: t.name("append").type([Append]),
        lambda t: t.name("prepend").type([Prepend]),
        lambda t: t.name("clear").type([ContainerClear]),
        lambda t: t.name("as_items").type([AsItems]),
    ]))
    store.Schemas.Union(OfAny, lambda u: u.branches([
        lambda t: t.name("set").type([AnySet]),
        lambda t: t.name("clear").type([AnyClear]),
        lambda t: t.name("as_scalar").type([AsScalar]),
        lambda t: t.name("as_container").type([AsContainer]),
        lambda t: t.name("as_object").type([AsObject]),
        lambda t: t.name("as_union").type([AsUnion]),
        lambda t: t.name("as_intersection").type([AsIntersection]),
    ]))
    store.Schemas.Union(OfScalar, lambda u: u.branches([
        lambda t: t.name("set").type([ScalarSet]),
        lambda t: t.name("clear").type([ScalarClear]),
    ]))
    store.Schemas.Union(OfLink, lambda u: u.branches([
        lambda t: t.name("set").type([LinkSet]),
        lambda t: t.name("clear").type([LinkClear]),
    ]))
    store.Schemas.Union(OfEntryMember, lambda u: u.branches([
        lambda t: t.name("as_property").type([EntryAsProperty]),
        lambda t: t.name("as_link").type([EntryAsLink]),
    ]))
    Log = store.Schemas.Container(lambda c: c.name("Mutations.Log").index([Int]).element([Reference]))
    return {name: schema for name, schema in locals().items() if name[0].isupper()}


if __name__ == "__main__":
    schemas = define(B.Store())
    problems = {name: schema.validate() for name, schema in schemas.items() if schema.validate()}
    assert not problems, problems
    print(f"{len(schemas)} mutation schemas, all valid")
