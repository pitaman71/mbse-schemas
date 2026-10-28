"""Mutations: the schemas of the mutations a transaction applies, and of transactions (a draft of 4i, for review; see
README.md beside it).

What changes: `schemas(Text, Int, Path, Bool, Pattern, Collector, Expression)`, which builds them with the builders and
is handed what it uses, becomes `install(txn)`, which defines them in the store a transaction writes, in the builders'
fluent syntax (PRI-019), and names what it uses from the transaction (`txn.Schemas.OfStr`, `txn.Paths.OfRoot`, 78). The
schemas are the same, by the same names, and `Mutations.Payload` is named (README.md).
"""

from __future__ import annotations

from typing import Any


def install(txn: Any) -> Any:
    """The mutation schemas, defined in the store a transaction writes: `store.transaction(Mutations.install)`. A store
    is made by it, after `Schemas.install` and `Paths.install`, read by the bootstrap (README.md, The bootstrap); run
    again in a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the store's meta-schemas and basic scalars (78)
    return txn.uid("mbse.Schemas.Mutations/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({
            "Payload": S.OfAny,
            "Ref": S.OfObject, "Def": S.OfObject, "Slice": S.OfObject,
            "OfProperty": S.OfUnion, "OfContainer": S.OfUnion, "OfAny": S.OfUnion, "OfScalar": S.OfUnion,
            "OfLink": S.OfUnion, "OfEntryMember": S.OfUnion, "OfObject": S.OfUnion, "OfAdjacency": S.OfUnion,
            "PropertySet": S.OfObject, "PropertyClear": S.OfObject, "PropertyAsAny": S.OfObject,
            "ContainerInsert": S.OfObject, "ContainerRemove": S.OfObject, "ContainerAppend": S.OfObject,
            "ContainerPrepend": S.OfObject, "ContainerClear": S.OfObject, "AsItems": S.OfObject,
            "AnySet": S.OfObject, "AnyClear": S.OfObject, "AsScalar": S.OfObject, "AsContainer": S.OfObject,
            "ScalarSet": S.OfObject, "ScalarClear": S.OfObject, "AsBranch": S.OfObject, "AsPart": S.OfObject,
            "AsUnion": S.OfObject, "AsIntersection": S.OfObject, "LinkSet": S.OfObject, "LinkClear": S.OfObject,
            "AsProperty": S.OfObject, "AsObject": S.OfObject, "EntryAsProperty": S.OfObject, "EntryAsLink": S.OfObject,
            "Entry": S.OfObject, "AsAdjacency": S.OfObject, "AdjacencyInsert": S.OfObject,
            "AdjacencyRemove": S.OfObject, "AdjacencyClear": S.OfObject, "OfPattern": S.OfContainer, "Spec": S.OfObject,
            "OfTerm": S.OfUnion, "OfTransaction": S.OfObject, "OfMap": S.OfObject, "OfReduce": S.OfObject,
            "OfPartition": S.OfObject, "OfBranch": S.OfObject, "OfUpdate": S.OfObject, "OfUpsert": S.OfObject,
            "HasRoot": S.OfRelation, "Then": S.OfRelation, "MapsSymbols": S.OfRelation, "MapsVariables": S.OfRelation,
            "ReducesSymbols": S.OfRelation, "ReducesVariables": S.OfRelation, "Branching": S.OfRelation,
            "Otherwise": S.OfRelation, "Requiring": S.OfRelation, "Applies": S.OfRelation, "Exists": S.OfRelation,
        })
        .spec([
            lambda _: _.Payload.name("Mutations.Payload"),  # untyped: interpreted by the target's schema

            # --- Nouns ---
            lambda _: _.Ref.name("Mutations.OfObject.Ref").properties({  # by its path (81), or a symbol (95)
                "path": txn.Paths.OfRoot, "symbol": S.OfStr}),
            lambda _: _.Def.name("Mutations.OfObject.Def").properties({  # no path: defined where it is linked
                "schema": S.OfStr,
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfObject]))}),
            lambda _: _.Slice.name("Mutations.OfContainer.Slice").properties({
                "index": _.Payload,  # where the section starts, by the container's index
                "items": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.Payload]))}),

            # --- Value verbs ---
            lambda _: _.PropertySet.name("Mutations.OfProperty.Set").properties({"value": _.Payload}),
            lambda _: _.PropertyClear.name("Mutations.OfProperty.Clear"),
            lambda _: _.PropertyAsAny.name("Mutations.OfProperty.AsAny").properties({
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfAny]))}),
            lambda _: _.ContainerInsert.name("Mutations.OfContainer.Insert").properties({"slice": _.Slice}),
            lambda _: _.ContainerRemove.name("Mutations.OfContainer.Remove").properties({  # by its start and length
                "index": _.Payload, "count": S.OfInt}),
            lambda _: _.ContainerAppend.name("Mutations.OfContainer.Append").properties({
                "items": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.Payload]))}),
            lambda _: _.ContainerPrepend.name("Mutations.OfContainer.Prepend").properties({
                "items": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.Payload]))}),
            lambda _: _.ContainerClear.name("Mutations.OfContainer.Clear"),
            lambda _: _.AsItems.name("Mutations.OfContainer.AsItems").properties({  # applied in modulo order
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfAny]))}),
            lambda _: _.AnySet.name("Mutations.OfAny.Set").properties({"value": _.Payload}),
            lambda _: _.AnyClear.name("Mutations.OfAny.Clear"),
            lambda _: _.AsScalar.name("Mutations.OfAny.AsScalar").properties({
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfScalar]))}),
            lambda _: _.AsContainer.name("Mutations.OfAny.AsContainer").properties({
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfContainer]))}),
            lambda _: _.ScalarSet.name("Mutations.OfScalar.Set").properties({"value": _.Payload}),
            lambda _: _.ScalarClear.name("Mutations.OfScalar.Clear"),
            lambda _: _.AsBranch.name("Mutations.OfUnion.AsBranch").properties({
                "name": S.OfStr,
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfProperty]))}),
            lambda _: _.AsPart.name("Mutations.OfIntersection.AsPart").properties({
                "name": S.OfStr,
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfProperty]))}),
            lambda _: _.AsUnion.name("Mutations.OfAny.AsUnion").properties({
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.AsBranch]))}),
            lambda _: _.AsIntersection.name("Mutations.OfAny.AsIntersection").properties({
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.AsPart]))}),
            lambda _: _.LinkSet.name("Mutations.OfLink.Set").properties({"ref": _.Ref, "def": _.Def}),
            lambda _: _.LinkClear.name("Mutations.OfLink.Clear"),

            # --- An object's, an entry's and an adjacency's verbs ---
            lambda _: _.AsProperty.name("Mutations.OfObject.AsProperty").properties({
                "name": S.OfStr,
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfProperty]))}),
            lambda _: _.AsObject.name("Mutations.OfAny.AsObject").properties({
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.AsProperty]))}),
            lambda _: _.EntryAsProperty.name("Mutations.OfEntry.AsProperty").properties({
                "name": S.OfStr,
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfProperty]))}),
            lambda _: _.EntryAsLink.name("Mutations.OfEntry.AsLink").properties({
                "name": S.OfStr,
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfLink]))}),
            lambda _: _.Entry.name("Mutations.OfEntry").properties({  # its links' and its properties' mutations
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfEntryMember]))}),
            lambda _: _.AsAdjacency.name("Mutations.OfObject.AsAdjacency").properties({
                "name": S.OfStr,
                "mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfAdjacency]))}),
            lambda _: _.AdjacencyInsert.name("Mutations.OfAdjacency.Insert").properties({
                "entries": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.Entry]))}),
            lambda _: _.AdjacencyRemove.name("Mutations.OfAdjacency.Remove").properties({
                "entries": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.Entry]))}),
            lambda _: _.AdjacencyClear.name("Mutations.OfAdjacency.Clear"),  # every entry it holds removed
            lambda _: _.OfPattern.name("Mutations.OfPattern").index([S.OfStr]).element([  # a spec, by symbol (95)
                S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfObject]))]),
            lambda _: _.Spec.name("Mutations.OfObject.Spec").properties({  # a pattern's spec, as recorded
                "items": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfPattern]))}),

            # --- The unions' branches, each a verb named as a visitor's member is ---
            lambda _: _.OfProperty.name("Mutations.OfProperty").branches([
                lambda t: t.name("set").schema([_.PropertySet]),
                lambda t: t.name("clear").schema([_.PropertyClear]),
                lambda t: t.name("as_any").schema([_.PropertyAsAny]),
            ]),
            lambda _: _.OfContainer.name("Mutations.OfContainer").branches([
                lambda t: t.name("insert").schema([_.ContainerInsert]),
                lambda t: t.name("remove").schema([_.ContainerRemove]),
                lambda t: t.name("append").schema([_.ContainerAppend]),
                lambda t: t.name("prepend").schema([_.ContainerPrepend]),
                lambda t: t.name("clear").schema([_.ContainerClear]),
                lambda t: t.name("as_items").schema([_.AsItems]),
            ]),
            lambda _: _.OfAny.name("Mutations.OfAny").branches([
                lambda t: t.name("set").schema([_.AnySet]),
                lambda t: t.name("clear").schema([_.AnyClear]),
                lambda t: t.name("as_scalar").schema([_.AsScalar]),
                lambda t: t.name("as_container").schema([_.AsContainer]),
                lambda t: t.name("as_object").schema([_.AsObject]),
                lambda t: t.name("as_union").schema([_.AsUnion]),
                lambda t: t.name("as_intersection").schema([_.AsIntersection]),
            ]),
            lambda _: _.OfScalar.name("Mutations.OfScalar").branches([
                lambda t: t.name("set").schema([_.ScalarSet]),
                lambda t: t.name("clear").schema([_.ScalarClear]),
            ]),
            lambda _: _.OfLink.name("Mutations.OfLink").branches([
                lambda t: t.name("set").schema([_.LinkSet]),
                lambda t: t.name("clear").schema([_.LinkClear]),
            ]),
            lambda _: _.OfEntryMember.name("Mutations.OfEntry.Member").branches([
                lambda t: t.name("as_property").schema([_.EntryAsProperty]),
                lambda t: t.name("as_link").schema([_.EntryAsLink]),
            ]),
            lambda _: _.OfObject.name("Mutations.OfObject").branches([
                lambda t: t.name("as_property").schema([_.AsProperty]),
                lambda t: t.name("as_adjacency").schema([_.AsAdjacency]),
                lambda t: t.name("spec").schema([_.Spec]),
            ]),
            lambda _: _.OfAdjacency.name("Mutations.OfAdjacency").branches([
                lambda t: t.name("insert").schema([_.AdjacencyInsert]),
                lambda t: t.name("remove").schema([_.AdjacencyRemove]),
                lambda t: t.name("clear").schema([_.AdjacencyClear]),
            ]),

            # --- Mutation expressions: a transaction and its terms, reference objects linked by relations (93) ---
            lambda _: _.OfTerm.name("Mutations.OfTerm").branches([
                lambda t: t.name("map").schema([_.OfMap]),
                lambda t: t.name("reduce").schema([_.OfReduce]),
                lambda t: t.name("partition").schema([_.OfPartition]),
                lambda t: t.name("update").schema([_.OfUpdate]),
                lambda t: t.name("upsert").schema([_.OfUpsert]),
            ]),
            lambda _: _.HasRoot.name("Mutations.HasRoot").links([
                lambda t: t.name("transaction"), lambda t: t.name("term").schema([_.OfTerm])]).uniques([["term"]]),
            lambda _: _.Then.name("Mutations.Then").links([
                lambda t: t.name("term"), lambda t: t.name("next").schema([_.OfTerm])]).uniques([["next"]]),
            lambda _: _.MapsSymbols.name("Mutations.MapsSymbols").links([
                lambda t: t.name("term"), lambda t: t.name("pattern").schema([S.OfPattern])]).uniques([["pattern"]]),
            lambda _: _.MapsVariables.name("Mutations.MapsVariables").links([
                lambda t: t.name("term"), lambda t: t.name("pattern").schema([S.OfPattern])]).uniques([["pattern"]]),
            lambda _: _.ReducesSymbols.name("Mutations.ReducesSymbols").links([
                lambda t: t.name("term"), lambda t: t.name("collector").schema([S.OfCollector])]).uniques([
                ["collector"]]),
            lambda _: _.ReducesVariables.name("Mutations.ReducesVariables").links([
                lambda t: t.name("term"), lambda t: t.name("collector").schema([S.OfCollector])]).uniques([
                ["collector"]]),
            lambda _: _.Branching.name("Mutations.Branching").links([
                lambda t: t.name("partition"), lambda t: t.name("branch").schema([_.OfBranch])]).uniques([]),  # a set
            lambda _: _.Otherwise.name("Mutations.Otherwise").links([
                lambda t: t.name("partition"), lambda t: t.name("next").schema([_.OfTerm])]).uniques([["next"]]),
            lambda _: _.Requiring.name("Mutations.Requiring").links([
                lambda t: t.name("branch"), lambda t: t.name("constraint").schema([S.OfExpression])]).uniques([]),  # a set
            lambda _: _.Applies.name("Mutations.Applies").links([
                lambda t: t.name("term"), lambda t: t.name("pattern").schema([S.OfPattern])]).uniques([["pattern"]]),
            lambda _: _.Exists.name("Mutations.Exists").links([
                lambda t: t.name("term"), lambda t: t.name("pattern").schema([S.OfPattern])]).uniques([["pattern"]]),
            lambda _: _.OfTransaction.name("Mutations.OfTransaction").ref(True).properties({
                "uid": S.OfStr,  # given by the program (42)
            }).adjacencies({
                "mutations": lambda a: a.relation([_.HasRoot]).me("transaction"),  # its one root term
            }),
            lambda _: _.OfMap.name("Mutations.OfMap").ref(True).adjacencies({
                "symbols": lambda a: a.relation([_.MapsSymbols]).me("term"),
                "variables": lambda a: a.relation([_.MapsVariables]).me("term"),
                "then": lambda a: a.relation([_.Then]).me("term"),
            }),
            lambda _: _.OfReduce.name("Mutations.OfReduce").ref(True).adjacencies({
                "symbols": lambda a: a.relation([_.ReducesSymbols]).me("term"),
                "variables": lambda a: a.relation([_.ReducesVariables]).me("term"),
                "then": lambda a: a.relation([_.Then]).me("term"),
            }),
            lambda _: _.OfPartition.name("Mutations.OfPartition").ref(True).properties({
                "first": S.OfBool, "last": S.OfBool,
            }).adjacencies({
                "branches": lambda a: a.relation([_.Branching]).me("partition"),
                "none": lambda a: a.relation([_.Otherwise]).me("partition"),
                "then": lambda a: a.relation([_.Then]).me("term"),
            }),
            lambda _: _.OfBranch.name("Mutations.OfBranch").ref(True).adjacencies({
                "requires": lambda a: a.relation([_.Requiring]).me("branch"),
                "then": lambda a: a.relation([_.Then]).me("term"),
            }),
            lambda _: _.OfUpdate.name("Mutations.OfUpdate").ref(True).adjacencies({
                "apply": lambda a: a.relation([_.Applies]).me("term"),
                "then": lambda a: a.relation([_.Then]).me("term"),
            }),
            lambda _: _.OfUpsert.name("Mutations.OfUpsert").ref(True).properties({
                "key": S.OfStr,
            }).adjacencies({
                "exists": lambda a: a.relation([_.Exists]).me("term"),
                "then": lambda a: a.relation([_.Then]).me("term"),
            }),
        ])]))])
