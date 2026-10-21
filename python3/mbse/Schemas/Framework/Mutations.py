"""Mutations: the schemas of a mutation log (docs/SERIALIZATION.md, Mutations : Vocabulary).

The wire format is a log of mutations, and mutations are schema-governed like everything else: each verb and noun here is
a schema, every store holds them, and ToPlain writes a log as it writes any value.

Every mutation is a value object: a log entry has no identity and is never shared. Each family of verbs is a union whose
branches are its verbs, named as a visitor's members are (`AsProperty` is `as_property`), so that a verb is written as
its union's branch (`{"exists": {...}}`), and a list of verbs is a container of that union. A noun (`Ref`, `Def`,
`Slice`) is a value object nested in a verb.

*Reference verbs* (`OfObject`, `OfRelation`) are the top level of the log (`Log`, a list of `Reference`); *value verbs*
are nested in them, following a path from the reference object a top-level verb names (`OfObject.AsProperty`'s `ref`).
A verb nested under `OfAny.AsObject` names no reference object. `OfContainer.AsItems` and `OfRelation.AsEntries` apply
their lists in modulo order.

Payloads (a property's value, an object's properties) are values of whatever schema the target gives: their schema here is
a value of any schema, and ToPlain writes them untagged, interpreted by the target's schema.

A pattern's spec (docs/OBJECT_IDENTITY.md, Decided, 95) is written in the same verbs: a `Mutations.OfPattern` gives, for
each symbol, the mutations of the object it binds (`OfObject`: a property's, `as_property`, and an adjacency's,
`as_adjacency`, whose `OfAdjacency` verbs insert and remove entries), a link referring to an object by its symbol or its
path (`Ref`), or defining one where it is linked (`Def`'s `schema` and `mutations`).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from .Builders import AdjacencyBuilder, AnyValueBuilder, ContainerBuilder, ObjectBuilder, RelationBuilder, UnionBuilder

__all__ = ["schemas"]


def schemas(Text: Any, Int: Any, Path: Any, Bool: Any, Pattern: Any, Collector: Any, Expression: Any) -> SimpleNamespace:
    """The mutation schemas, built anew for a store whose basic scalars `Text` (`Schemas.OfStr`), `Int` (`Schemas.OfInt`)
    and `Bool`, whose `Paths.OfRoot` (`Path`) and whose meta-schemas `Pattern`, `Collector` and `Expression`
    (`Schemas.OfPattern`, ...) they use: each store holds its own (docs/SCHEMA_EXTENSION.md,
    Decided, 23)."""
    Payload = AnyValueBuilder().create()  # untyped: interpreted by the target's schema

    def _list(element: Any) -> Any:
        return ContainerBuilder().index([Int]).element([element]).create()

    def _verb(name: str, *properties: Any) -> Any:
        """A verb or a noun, `Mutations.<name>`: a value object of `properties`, each naming one and giving its schema."""
        return ObjectBuilder().name(f"Mutations.{name}").properties(list(properties)).create()

    def _mutations(of: Any) -> Any:
        """A verb's nested mutations: a list of `of`."""
        return lambda t: t.name("mutations").schema([_list(of)])

    def _text(name: str) -> Any:
        return lambda t: t.name(name).schema([Text])

    def _union(name: str) -> Any:
        return UnionBuilder().name(f"Mutations.{name}").create()

    # --- Nouns ---

    Ref = _verb(  # an object by its path, a schema object's from the root module (docs/OBJECT_IDENTITY.md, Decided, 81),
        "OfObject.Ref",  # or, within a pattern's spec, by the symbol that binds it (95)
        lambda t: t.name("path").schema([Path]),
        _text("symbol"),
    )
    Def = _verb(  # its path, but where it is linked; its schema's name (a schema object's kind's); its properties
        "OfObject.Def",
        lambda t: t.name("path").schema([Path]),
        _text("schema"),
        lambda t: t.name("properties").schema([ContainerBuilder().index([Text]).element([Payload]).create()]),
    )
    Slice = _verb(
        "OfContainer.Slice",
        lambda t: t.name("index").schema([Payload]),  # where the section starts, by the container's index
        lambda t: t.name("items").schema([_list(Payload)]),
    )

    # --- The unions of verbs, whose branches are given below: each refers to the others ---

    Reference = _union("Reference")  # the top level of the log: OfObject's and OfRelation's verbs
    OfProperty = _union("OfProperty")
    OfContainer = _union("OfContainer")
    OfAny = _union("OfAny")
    OfScalar = _union("OfScalar")
    OfLink = _union("OfLink")
    OfEntryMember = _union("OfEntry.Member")  # an entry's mutations: its properties' and its links'
    OfObject = _union("OfObject")  # an object's mutations in a spec: its properties' and its adjacencies' (95)
    OfAdjacency = _union("OfAdjacency")  # an adjacency's mutations in a spec

    # --- Value verbs ---

    PropertySet = _verb("OfProperty.Set", lambda t: t.name("value").schema([Payload]))
    PropertyClear = _verb("OfProperty.Clear")
    PropertyAsAny = _verb("OfProperty.AsAny", _mutations(OfAny))
    ContainerInsert = _verb("OfContainer.Insert", lambda t: t.name("slice").schema([Slice]))
    ContainerRemove = _verb(  # a section, by its start and its length
        "OfContainer.Remove",
        lambda t: t.name("index").schema([Payload]),
        lambda t: t.name("count").schema([Int]),
    )
    ContainerAppend = _verb("OfContainer.Append", lambda t: t.name("items").schema([_list(Payload)]))
    ContainerPrepend = _verb("OfContainer.Prepend", lambda t: t.name("items").schema([_list(Payload)]))
    ContainerClear = _verb("OfContainer.Clear")
    AsItems = _verb("OfContainer.AsItems", _mutations(OfAny))  # applied in modulo order
    AnySet = _verb("OfAny.Set", lambda t: t.name("value").schema([Payload]))
    AnyClear = _verb("OfAny.Clear")
    AsScalar = _verb("OfAny.AsScalar", _mutations(OfScalar))
    AsContainer = _verb("OfAny.AsContainer", _mutations(OfContainer))
    ScalarSet = _verb("OfScalar.Set", lambda t: t.name("value").schema([Payload]))
    ScalarClear = _verb("OfScalar.Clear")
    AsBranch = _verb("OfUnion.AsBranch", _text("name"), _mutations(OfProperty))
    AsPart = _verb("OfIntersection.AsPart", _text("name"), _mutations(OfProperty))
    AsUnion = _verb("OfAny.AsUnion", _mutations(AsBranch))
    AsIntersection = _verb("OfAny.AsIntersection", _mutations(AsPart))
    LinkSet = _verb(  # a reference, or the definition of a schema object with no path, nested where it is linked
        "OfLink.Set",
        lambda t: t.name("ref").schema([Ref]),
        lambda t: t.name("def").schema([Def]),
    )
    LinkClear = _verb("OfLink.Clear")

    # --- Reference verbs, and what an object's or an entry's mutations are ---

    Exists = _verb("OfObject.Exists", lambda t: t.name("definition").schema([Def]))  # Python cannot spell `def`
    AsProperty = _verb(  # `ref` at the top of the log only: nested under OfAny.AsObject, the path gives the object
        "OfObject.AsProperty",
        lambda t: t.name("ref").schema([Ref]),
        _text("name"),
        _mutations(OfProperty),
    )
    AsObject = _verb("OfAny.AsObject", _mutations(AsProperty))
    EntryAsProperty = _verb("OfEntry.AsProperty", _text("name"), _mutations(OfProperty))
    EntryAsLink = _verb("OfEntry.AsLink", _text("name"), _mutations(OfLink))
    Entry = _verb("OfEntry", _mutations(OfEntryMember))  # an entry: its links' and its properties' mutations
    RelationInsert = _verb(
        "OfRelation.Insert",
        lambda t: t.name("relation").schema([Ref]),  # the relation schema
        lambda t: t.name("entries").schema([_list(Entry)]),
    )
    AsAdjacency = _verb("OfObject.AsAdjacency", _text("name"), _mutations(OfAdjacency))
    AdjacencyInsert = _verb("OfAdjacency.Insert", lambda t: t.name("entries").schema([_list(Entry)]))
    AdjacencyRemove = _verb("OfAdjacency.Remove", lambda t: t.name("entries").schema([_list(Entry)]))
    ObjectBuilder(Def).properties([  # nested in a definition, each entry leaves out the link the defined object fills
        lambda t: t.name("inserts").schema([_list(RelationInsert)]),
        _mutations(OfObject),  # in a spec, the defined object's own mutations
    ]).update()
    RelationRemove = _verb(
        "OfRelation.Remove",
        lambda t: t.name("relation").schema([Ref]),
        lambda t: t.name("entries").schema([_list(Entry)]),
    )
    RelationClear = _verb("OfRelation.Clear", lambda t: t.name("ref").schema([Ref]), _text("adjacency"))
    AsEntries = _verb(  # applied in modulo order
        "OfRelation.AsEntries",
        lambda t: t.name("ref").schema([Ref]),
        _text("adjacency"),
        _mutations(EntryAsProperty),
    )

    # --- The unions' branches ---

    UnionBuilder(Reference).branches([
        lambda t: t.name("exists").schema([Exists]),
        lambda t: t.name("as_property").schema([AsProperty]),
        lambda t: t.name("insert").schema([RelationInsert]),
        lambda t: t.name("remove").schema([RelationRemove]),
        lambda t: t.name("clear").schema([RelationClear]),
        lambda t: t.name("as_entries").schema([AsEntries]),
    ]).update()
    UnionBuilder(OfProperty).branches([
        lambda t: t.name("set").schema([PropertySet]),
        lambda t: t.name("clear").schema([PropertyClear]),
        lambda t: t.name("as_any").schema([PropertyAsAny]),
    ]).update()
    UnionBuilder(OfContainer).branches([
        lambda t: t.name("insert").schema([ContainerInsert]),
        lambda t: t.name("remove").schema([ContainerRemove]),
        lambda t: t.name("append").schema([ContainerAppend]),
        lambda t: t.name("prepend").schema([ContainerPrepend]),
        lambda t: t.name("clear").schema([ContainerClear]),
        lambda t: t.name("as_items").schema([AsItems]),
    ]).update()
    UnionBuilder(OfAny).branches([
        lambda t: t.name("set").schema([AnySet]),
        lambda t: t.name("clear").schema([AnyClear]),
        lambda t: t.name("as_scalar").schema([AsScalar]),
        lambda t: t.name("as_container").schema([AsContainer]),
        lambda t: t.name("as_object").schema([AsObject]),
        lambda t: t.name("as_union").schema([AsUnion]),
        lambda t: t.name("as_intersection").schema([AsIntersection]),
    ]).update()
    UnionBuilder(OfScalar).branches([
        lambda t: t.name("set").schema([ScalarSet]),
        lambda t: t.name("clear").schema([ScalarClear]),
    ]).update()
    UnionBuilder(OfLink).branches([
        lambda t: t.name("set").schema([LinkSet]),
        lambda t: t.name("clear").schema([LinkClear]),
    ]).update()
    UnionBuilder(OfEntryMember).branches([
        lambda t: t.name("as_property").schema([EntryAsProperty]),
        lambda t: t.name("as_link").schema([EntryAsLink]),
    ]).update()
    UnionBuilder(OfObject).branches([
        lambda t: t.name("as_property").schema([AsProperty]),
        lambda t: t.name("as_adjacency").schema([AsAdjacency]),
    ]).update()
    UnionBuilder(OfAdjacency).branches([
        lambda t: t.name("insert").schema([AdjacencyInsert]),
        lambda t: t.name("remove").schema([AdjacencyRemove]),
    ]).update()
    # a spec (Schemas.OfPattern.spec): for each symbol, the mutations of the object it binds (Object identity, 95)
    OfPattern = ContainerBuilder().name("Mutations.OfPattern").index([Text]).element([_list(OfObject)]).create()
    Log = ContainerBuilder().name("Mutations.Log").index([Int]).element([Reference]).create()

    # --- Mutation expressions: a transaction and its terms, reference objects linked by relations (93) ---

    def _term(name: str, *properties: Any) -> Any:
        """A kind of term, `Mutations.<name>`: a reference object schema of `properties`."""
        return ObjectBuilder().name(f"Mutations.{name}").ref(True).properties(list(properties)).create()

    def _relation(name: str, first: str, second: str, schema: Any, one: bool = True) -> Any:
        """A relation, `Mutations.<name>`, from `first` to `second`, whose schema is `schema`: an object of `first` holds
        one entry of it at most where `one`, else a list."""
        builder = RelationBuilder().name(f"Mutations.{name}").links([
            lambda t: t.name(first), lambda t: t.name(second).schema([schema])])
        return builder.uniques([[second]] if one else []).create()

    def _bool(name: str) -> Any:
        return lambda t: t.name(name).schema([Bool])

    OfTerm = _union("OfTerm")  # a kind union (97): its branches, given below, are the kinds of term
    OfTransaction = _term("OfTransaction", _text("uid"))  # the root: its uid, given by the program (42), and one term
    OfMap = _term("OfMap")
    OfReduce = _term("OfReduce")
    OfPartition = _term("OfPartition", _bool("first"), _bool("last"))
    OfBranch = _term("OfBranch")
    OfUpdate = _term("OfUpdate")
    OfUpsert = _term("OfUpsert", _text("key"))
    HasRoot = _relation("HasRoot", "transaction", "term", OfTerm)
    Then = _relation("Then", "term", "next", OfTerm)
    MapsSymbols = _relation("MapsSymbols", "term", "pattern", Pattern)
    MapsVariables = _relation("MapsVariables", "term", "pattern", Pattern)
    ReducesSymbols = _relation("ReducesSymbols", "term", "collector", Collector)
    ReducesVariables = _relation("ReducesVariables", "term", "collector", Collector)
    Branching = _relation("Branching", "partition", "branch", OfBranch, one=False)
    Otherwise = _relation("Otherwise", "partition", "next", OfTerm)
    Requiring = _relation("Requiring", "branch", "constraint", Expression, one=False)
    Applies = _relation("Applies", "term", "pattern", Pattern)
    Existing = _relation("Exists", "term", "pattern", Pattern)  # not `Exists`, the verb's
    UnionBuilder(OfTerm).branches([lambda t, n=n, k=k: t.name(n).schema([k]) for n, k in (
        ("map", OfMap), ("reduce", OfReduce), ("partition", OfPartition), ("update", OfUpdate), ("upsert", OfUpsert))]).update()

    def _adjacencies(kind: Any, *named: tuple[str, Any, str]) -> None:
        """Gives `kind` its adjacencies: each a name, a relation, and the link `kind` fills."""
        ObjectBuilder(kind).adjacencies([lambda t, n=n, r=r, m=m: t.name(n).adjacency(
            AdjacencyBuilder().relation([r]).me(m).create()) for n, r, m in named]).update()

    _adjacencies(OfTransaction, ("mutations", HasRoot, "transaction"))
    _adjacencies(OfMap, ("symbols", MapsSymbols, "term"), ("variables", MapsVariables, "term"), ("then", Then, "term"))
    _adjacencies(OfReduce, ("symbols", ReducesSymbols, "term"), ("variables", ReducesVariables, "term"),
                 ("then", Then, "term"))
    _adjacencies(OfPartition, ("branches", Branching, "partition"), ("none", Otherwise, "partition"), ("then", Then, "term"))
    _adjacencies(OfBranch, ("requires", Requiring, "branch"), ("then", Then, "term"))
    _adjacencies(OfUpdate, ("apply", Applies, "term"), ("then", Then, "term"))
    _adjacencies(OfUpsert, ("exists", Existing, "term"), ("then", Then, "term"))

    return SimpleNamespace(**{name: schema for name, schema in locals().items()
                              if str(getattr(schema, "name", "") or "").startswith("Mutations.")})

