"""Schemas: schema elements (a draft of 4i, for review; see README.md beside it).

What changes: the plain schemas of schemas (level 2) and the basic scalars, which `Builders._plain()` builds today, are
defined here, by `install(txn)`, written in the builders' fluent syntax (PRI-019). Level 3, the dataclasses below
(`OfObject.Data`, ...), is unchanged.
"""

from __future__ import annotations

from typing import Any

# ... level 3, as today: OfScalar, OfProperty, OfObject, OfAdjacency, OfRelation, OfEntry, OfSymbol, OfVariable,
# OfPattern, OfExpression, OfConstraint, OfCollector, OfUnion, OfIntersection, OfParameter, OfContainer, is_a,
# inherited, plain_forms ...


def install(txn: Any) -> Any:
    """The plain schemas of schemas and the basic scalars, defined in the store a transaction writes:
    `store.transaction(Schemas.install)`. A store is made by it, read by the bootstrap (README.md, The bootstrap); run
    again in a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the meta-schemas, which this defines: each a symbol of its own kind (78)
    return txn.uid("mbse.Schemas/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({
            "OfBool": S.OfScalar, "OfInt": S.OfScalar, "OfFloat": S.OfScalar, "OfStr": S.OfScalar, "OfBytes": S.OfScalar,
            "OfScalar": S.OfObject, "OfObject": S.OfObject, "OfUnion": S.OfObject, "OfIntersection": S.OfObject,
            "OfContainer": S.OfObject, "OfAny": S.OfObject, "OfRelation": S.OfObject, "OfPattern": S.OfObject,
            "OfExpression": S.OfObject, "OfCollector": S.OfObject, "OfModule": S.OfObject,
            "OfProperty": S.OfObject, "OfParameter": S.OfObject, "OfSymbol": S.OfObject, "OfVariable": S.OfObject,
            "OfAdjacency": S.OfObject,
            "HasSchema": S.OfRelation, "Refines": S.OfRelation, "Indexing": S.OfRelation, "Containing": S.OfRelation,
            "AnyOf": S.OfRelation, "Relating": S.OfRelation, "HasParameter": S.OfRelation, "HasProperty": S.OfRelation,
            "HasAdjacency": S.OfRelation, "HasBranch": S.OfRelation, "HasPart": S.OfRelation, "HasSymbol": S.OfRelation,
            "HasVariable": S.OfRelation, "Requiring": S.OfRelation, "Matching": S.OfRelation, "Resulting": S.OfRelation,
            "Computing": S.OfRelation, "HasLink": S.OfRelation, "Defines": S.OfRelation,
        })
        .spec([
            # --- The basic scalars, the only scalar schemas, each mapping to its host type by its name ---
            lambda _: _.OfBool.name("Schemas.OfBool"),
            lambda _: _.OfInt.name("Schemas.OfInt"),
            lambda _: _.OfFloat.name("Schemas.OfFloat"),
            lambda _: _.OfStr.name("Schemas.OfStr"),
            lambda _: _.OfBytes.name("Schemas.OfBytes"),

            # --- The relations between schema objects ---
            # A member belongs to one owner, which names it by the entry's `name` (keyed): the member determines its
            # owner and its name, and the owner and the name the member. A branch or a part is named by its entry, which
            # links a schema that may be linked again. A schema object has one schema, refined schema, index, element or
            # relation at most; `OfAny`'s schemas and a pattern's constraints are lists.
            lambda _: _.HasSchema.name("Schemas.HasSchema").links([
                lambda t: t.name("member"), lambda t: t.name("schema")]).uniques([["schema"]]),
            lambda _: _.Refines.name("Schemas.Refines").links([
                lambda t: t.name("refinement"), lambda t: t.name("refined")]).uniques([["refined"]]),
            lambda _: _.Indexing.name("Schemas.Indexing").links([
                lambda t: t.name("container"), lambda t: t.name("index")]).uniques([["index"]]),
            lambda _: _.Containing.name("Schemas.Containing").links([
                lambda t: t.name("container"), lambda t: t.name("element")]).uniques([["element"]]),
            lambda _: _.AnyOf.name("Schemas.AnyOf").links([lambda t: t.name("any"), lambda t: t.name("schema")]),
            lambda _: _.Relating.name("Schemas.Relating").links([
                lambda t: t.name("adjacency"), lambda t: t.name("relation")]).uniques([["relation"]]),
            lambda _: _.HasParameter.name("Schemas.HasParameter").links([
                lambda t: t.name("owner"), lambda t: t.name("parameter")]).properties({"name": _.OfStr}).uniques([
                ["owner", "name"], ["parameter"]]),
            lambda _: _.HasProperty.name("Schemas.HasProperty").links([
                lambda t: t.name("owner"), lambda t: t.name("property")]).properties({"name": _.OfStr}).uniques([
                ["owner", "name"], ["property"]]),
            lambda _: _.HasAdjacency.name("Schemas.HasAdjacency").links([
                lambda t: t.name("owner"), lambda t: t.name("adjacency")]).properties({"name": _.OfStr}).uniques([
                ["owner", "name"], ["adjacency"]]),
            lambda _: _.HasBranch.name("Schemas.HasBranch").links([
                lambda t: t.name("owner"), lambda t: t.name("schema")]).properties({
                "name": _.OfStr, "description": _.OfStr}).uniques([["owner", "name"]]),
            lambda _: _.HasPart.name("Schemas.HasPart").links([
                lambda t: t.name("owner"), lambda t: t.name("schema")]).properties({
                "name": _.OfStr, "description": _.OfStr}).uniques([["owner", "name"]]),
            lambda _: _.HasSymbol.name("Schemas.HasSymbol").links([
                lambda t: t.name("owner"), lambda t: t.name("symbol")]).properties({"name": _.OfStr}).uniques([
                ["owner", "name"], ["symbol"]]),
            lambda _: _.HasVariable.name("Schemas.HasVariable").links([
                lambda t: t.name("owner"), lambda t: t.name("variable")]).properties({"name": _.OfStr}).uniques([
                ["owner", "name"], ["variable"]]),
            lambda _: _.Requiring.name("Schemas.Requiring").links([
                lambda t: t.name("pattern"), lambda t: t.name("constraint")]),
            lambda _: _.Matching.name("Schemas.Matching").links([
                lambda t: t.name("expression"), lambda t: t.name("pattern")]).uniques([["pattern"]]),
            lambda _: _.Resulting.name("Schemas.Resulting").links([
                lambda t: t.name("expression"), lambda t: t.name("schema")]).uniques([["schema"]]),
            lambda _: _.Computing.name("Schemas.Computing").links([
                lambda t: t.name("collector"), lambda t: t.name("expression")]).uniques([["expression"]]),
            lambda _: _.HasLink.name("Schemas.HasLink").links([
                lambda t: t.name("owner"), lambda t: t.name("link")]).properties({"name": _.OfStr}).uniques([
                ["owner", "name"], ["link"]]),
            lambda _: _.Defines.name("Schemas.Defines").links([
                lambda t: t.name("module"), lambda t: t.name("schema")]).properties({"name": _.OfStr}).uniques([
                ["module", "name"], ["schema"]]),

            # --- The kinds of schema: each a reference object, its properties, then each relation it is at an end of
            # (Store overhaul, Decided, 10): named where it is the first, anonymous where it is the second ---
            lambda _: _.OfScalar.name("Schemas.OfScalar").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
            }).adjacencies({
                "parameters": lambda a: a.relation([_.HasParameter]).me("owner"),
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfObject.name("Schemas.OfObject").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr, "ref": _.OfBool, "singleton": _.OfStr,
            }).adjacencies({
                "parameters": lambda a: a.relation([_.HasParameter]).me("owner"),
                "adjacencies": lambda a: a.relation([_.HasAdjacency]).me("owner"),
                "properties": lambda a: a.relation([_.HasProperty]).me("owner"),
                "refines": lambda a: a.relation([_.Refines]).me("refinement"),
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfUnion.name("Schemas.OfUnion").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr, "flat": _.OfBool,
            }).adjacencies({
                "parameters": lambda a: a.relation([_.HasParameter]).me("owner"),
                "branches": lambda a: a.relation([_.HasBranch]).me("owner"),
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfIntersection.name("Schemas.OfIntersection").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr, "flat": _.OfBool,
            }).adjacencies({
                "parameters": lambda a: a.relation([_.HasParameter]).me("owner"),
                "parts": lambda a: a.relation([_.HasPart]).me("owner"),
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfContainer.name("Schemas.OfContainer").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr, "layout": _.OfStr,
            }).adjacencies({
                "index": lambda a: a.relation([_.Indexing]).me("container"),
                "element": lambda a: a.relation([_.Containing]).me("container"),
                "parameters": lambda a: a.relation([_.HasParameter]).me("owner"),
                "refines": lambda a: a.relation([_.Refines]).me("refinement"),
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfAny.name("Schemas.OfAny").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
            }).adjacencies({
                "schemas": lambda a: a.relation([_.AnyOf]).me("any"),
                "parameters": lambda a: a.relation([_.HasParameter]).me("owner"),
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfRelation.name("Schemas.OfRelation").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
                "uniques": S.OfContainer(lambda c: c.index([_.OfInt]).element([
                    S.OfContainer(lambda d: d.index([_.OfInt]).element([_.OfStr]))])),  # lists of names
            }).adjacencies({
                "parameters": lambda a: a.relation([_.HasParameter]).me("owner"),
                "links": lambda a: a.relation([_.HasLink]).me("owner"),
                "properties": lambda a: a.relation([_.HasProperty]).me("owner"),
            }).adjacencies([
                lambda a: a.relation([_.Relating]).me("relation"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfPattern.name("Schemas.OfPattern").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
            }).adjacencies({
                "parameters": lambda a: a.relation([_.HasParameter]).me("owner"),
                "symbols": lambda a: a.relation([_.HasSymbol]).me("owner"),
                "variables": lambda a: a.relation([_.HasVariable]).me("owner"),
                "requires": lambda a: a.relation([_.Requiring]).me("pattern"),
            }).adjacencies([
                lambda a: a.relation([_.Matching]).me("pattern"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfExpression.name("Schemas.OfExpression").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
            }).adjacencies({
                "parameters": lambda a: a.relation([_.HasParameter]).me("owner"),
                "pattern": lambda a: a.relation([_.Matching]).me("expression"),
                "result": lambda a: a.relation([_.Resulting]).me("expression"),
            }).adjacencies([
                lambda a: a.relation([_.Requiring]).me("constraint"),
                lambda a: a.relation([_.Computing]).me("expression"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfCollector.name("Schemas.OfCollector").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
                "symbols": S.OfContainer(lambda c: c.index([_.OfInt]).element([_.OfStr])),
                "variables": S.OfContainer(lambda c: c.index([_.OfInt]).element([_.OfStr])),
                "commutative": _.OfBool, "associative": _.OfBool,
                "suffixes": S.OfContainer(lambda c: c.index([_.OfStr]).element([_.OfStr])),
            }).adjacencies({
                "parameters": lambda a: a.relation([_.HasParameter]).me("owner"),
                "pattern": lambda a: a.relation([_.Matching]).me("expression"),
                "computes": lambda a: a.relation([_.Computing]).me("collector"),
            }).adjacencies([
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfModule.name("Schemas.OfModule").ref(True).properties({  # its identity is its path
                "name": _.OfStr, "description": _.OfStr,
            }).adjacencies({
                "parameters": lambda a: a.relation([_.HasParameter]).me("owner"),
                "schemas": lambda a: a.relation([_.Defines]).me("module"),
            }).adjacencies([
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),

            # --- The kinds of member: each named by its owner's entry ---
            lambda _: _.OfProperty.name("Schemas.OfProperty").ref(True).properties({
                "description": _.OfStr, "pattern": _.OfStr,
            }).adjacencies({
                "schema": lambda a: a.relation([_.HasSchema]).me("member"),
            }).adjacencies([
                lambda a: a.relation([_.HasProperty]).me("property").owner(True),
            ]),
            lambda _: _.OfParameter.name("Schemas.OfParameter").ref(True).properties({  # a symbol for a schema
                "description": _.OfStr,
            }).adjacencies([
                lambda a: a.relation([_.HasParameter]).me("parameter").owner(True),
            ]),
            lambda _: _.OfSymbol.name("Schemas.OfSymbol").ref(True).properties({
                "description": _.OfStr,
            }).adjacencies({
                "schema": lambda a: a.relation([_.HasSchema]).me("member"),
            }).adjacencies([
                lambda a: a.relation([_.HasSymbol]).me("symbol").owner(True),
                lambda a: a.relation([_.HasLink]).me("link").owner(True),
            ]),
            lambda _: _.OfVariable.name("Schemas.OfVariable").ref(True).properties({
                "description": _.OfStr,
            }).adjacencies({
                "schema": lambda a: a.relation([_.HasSchema]).me("member"),
            }).adjacencies([
                lambda a: a.relation([_.HasVariable]).me("variable").owner(True),
            ]),
            lambda _: _.OfAdjacency.name("Schemas.OfAdjacency").ref(True).properties({
                "description": _.OfStr, "me": _.OfStr, "owner": _.OfBool,
            }).adjacencies({
                "relation": lambda a: a.relation([_.Relating]).me("adjacency"),
            }).adjacencies([
                lambda a: a.relation([_.HasAdjacency]).me("adjacency").owner(True),
            ]),
        ])]))])
