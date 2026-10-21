"""Mutations: the schemas of the mutations a transaction applies, and of transactions (a draft of 4i, for review; see
README.md beside it).

What changes: `schemas(Text, Int, Path, Bool, Pattern, Collector, Expression)`, which builds them with the builders and
is handed what it uses, becomes `install(txn)`, which defines them in the store a transaction writes and names what it
uses from the transaction (`txn.Schemas.OfStr`, `txn.Paths.OfRoot`, 78). The schemas are the same 62, by the same names.
"""

from __future__ import annotations

from typing import Any

UNIONS = ("OfProperty", "OfContainer", "OfAny", "OfScalar", "OfLink", "OfEntry.Member", "OfObject", "OfAdjacency",
          "OfTerm")
"""The unions of verbs, and of terms: each symbol's name is its schema's, `Mutations.<name>`."""

TERMS = {"OfTransaction": {"uid": "OfStr"}, "OfMap": {}, "OfReduce": {}, "OfPartition": {"first": "OfBool", "last": "OfBool"},
         "OfBranch": {}, "OfUpdate": {}, "OfUpsert": {"key": "OfStr"}}
"""Each kind of term, a reference object schema (93), and its properties."""

RELATIONS = [  # (relation, first link, second link, the second's schema, a symbol here or a path from txn, one at most)
    ("HasRoot", "transaction", "term", "OfTerm", True),
    ("Then", "term", "next", "OfTerm", True),
    ("MapsSymbols", "term", "pattern", "Schemas.OfPattern", True),
    ("MapsVariables", "term", "pattern", "Schemas.OfPattern", True),
    ("ReducesSymbols", "term", "collector", "Schemas.OfCollector", True),
    ("ReducesVariables", "term", "collector", "Schemas.OfCollector", True),
    ("Branching", "partition", "branch", "OfBranch", False),
    ("Otherwise", "partition", "next", "OfTerm", True),
    ("Requiring", "branch", "constraint", "Schemas.OfExpression", False),
    ("Applies", "term", "pattern", "Schemas.OfPattern", True),
    ("Exists", "term", "pattern", "Schemas.OfPattern", True),
]

ADJACENCIES = {  # each kind of term's adjacencies: (name, relation, the link it fills)
    "OfTransaction": [("mutations", "HasRoot", "transaction")],
    "OfMap": [("symbols", "MapsSymbols", "term"), ("variables", "MapsVariables", "term"), ("then", "Then", "term")],
    "OfReduce": [("symbols", "ReducesSymbols", "term"), ("variables", "ReducesVariables", "term"), ("then", "Then", "term")],
    "OfPartition": [("branches", "Branching", "partition"), ("none", "Otherwise", "partition"), ("then", "Then", "term")],
    "OfBranch": [("requires", "Requiring", "branch"), ("then", "Then", "term")],
    "OfUpdate": [("apply", "Applies", "term"), ("then", "Then", "term")],
    "OfUpsert": [("exists", "Exists", "term"), ("then", "Then", "term")],
}


def install(txn: Any) -> Any:
    """The mutation schemas, defined in the store a transaction writes: `store.transaction(Mutations.install)`. A store
    is made by it, after `Schemas.install` and `Paths.install`, read by the bootstrap (README.md, The bootstrap); run
    again in a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the store's meta-schemas and basic scalars (78)

    def mutations(_: Any, of: str) -> dict[str, Any]:
        """A verb's nested mutations: a list of `of`, defined where it is linked."""
        return {"mutations": S.OfContainer(lambda c: c.index([S.OfInt]).element([getattr(_, of)]))}

    def payloads(_: Any) -> Any:
        return S.OfContainer(lambda c: c.index([S.OfInt]).element([_.Payload]))

    verbs: dict[str, Any] = {  # each verb and noun, a value object schema: `Mutations.<name>`, by its symbol
        # --- Nouns ---
        "OfObject.Ref": lambda _: {"path": txn.Paths.OfRoot, "symbol": S.OfStr},  # by its path, or a symbol (81, 95)
        "OfObject.Def": lambda _: {"schema": S.OfStr, **mutations(_, "OfObject")},  # no path: defined where linked
        "OfContainer.Slice": lambda _: {"index": _.Payload, "items": payloads(_)},
        # --- Value verbs ---
        "OfProperty.Set": lambda _: {"value": _.Payload},
        "OfProperty.Clear": lambda _: {},
        "OfProperty.AsAny": lambda _: mutations(_, "OfAny"),
        "OfContainer.Insert": lambda _: {"slice": getattr(_, "OfContainer.Slice")},
        "OfContainer.Remove": lambda _: {"index": _.Payload, "count": S.OfInt},  # a section, by its start and length
        "OfContainer.Append": lambda _: {"items": payloads(_)},
        "OfContainer.Prepend": lambda _: {"items": payloads(_)},
        "OfContainer.Clear": lambda _: {},
        "OfContainer.AsItems": lambda _: mutations(_, "OfAny"),  # applied in modulo order
        "OfAny.Set": lambda _: {"value": _.Payload},
        "OfAny.Clear": lambda _: {},
        "OfAny.AsScalar": lambda _: mutations(_, "OfScalar"),
        "OfAny.AsContainer": lambda _: mutations(_, "OfContainer"),
        "OfScalar.Set": lambda _: {"value": _.Payload},
        "OfScalar.Clear": lambda _: {},
        "OfUnion.AsBranch": lambda _: {"name": S.OfStr, **mutations(_, "OfProperty")},
        "OfIntersection.AsPart": lambda _: {"name": S.OfStr, **mutations(_, "OfProperty")},
        "OfAny.AsUnion": lambda _: mutations(_, "OfUnion.AsBranch"),
        "OfAny.AsIntersection": lambda _: mutations(_, "OfIntersection.AsPart"),
        "OfLink.Set": lambda _: {"ref": getattr(_, "OfObject.Ref"), "def": getattr(_, "OfObject.Def")},
        "OfLink.Clear": lambda _: {},
        # --- An object's, an entry's and an adjacency's verbs ---
        "OfObject.AsProperty": lambda _: {"name": S.OfStr, **mutations(_, "OfProperty")},
        "OfAny.AsObject": lambda _: mutations(_, "OfObject.AsProperty"),
        "OfEntry.AsProperty": lambda _: {"name": S.OfStr, **mutations(_, "OfProperty")},
        "OfEntry.AsLink": lambda _: {"name": S.OfStr, **mutations(_, "OfLink")},
        "OfEntry": lambda _: mutations(_, "OfEntry.Member"),  # its links' and its properties' mutations
        "OfObject.AsAdjacency": lambda _: {"name": S.OfStr, **mutations(_, "OfAdjacency")},
        "OfAdjacency.Insert": lambda _: {"entries": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfEntry]))},
        "OfAdjacency.Remove": lambda _: {"entries": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfEntry]))},
        "OfAdjacency.Clear": lambda _: {},  # every entry the adjacency holds removed
        "OfObject.Spec": lambda _: {"items": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfPattern]))},
    }

    branches: dict[str, dict[str, str]] = {  # each union's branches: a verb's name as a visitor's member, its schema
        "OfProperty": {"set": "OfProperty.Set", "clear": "OfProperty.Clear", "as_any": "OfProperty.AsAny"},
        "OfContainer": {"insert": "OfContainer.Insert", "remove": "OfContainer.Remove", "append": "OfContainer.Append",
                        "prepend": "OfContainer.Prepend", "clear": "OfContainer.Clear", "as_items": "OfContainer.AsItems"},
        "OfAny": {"set": "OfAny.Set", "clear": "OfAny.Clear", "as_scalar": "OfAny.AsScalar",
                  "as_container": "OfAny.AsContainer", "as_object": "OfAny.AsObject", "as_union": "OfAny.AsUnion",
                  "as_intersection": "OfAny.AsIntersection"},
        "OfScalar": {"set": "OfScalar.Set", "clear": "OfScalar.Clear"},
        "OfLink": {"set": "OfLink.Set", "clear": "OfLink.Clear"},
        "OfEntry.Member": {"as_property": "OfEntry.AsProperty", "as_link": "OfEntry.AsLink"},
        "OfObject": {"as_property": "OfObject.AsProperty", "as_adjacency": "OfObject.AsAdjacency",
                     "spec": "OfObject.Spec"},
        "OfAdjacency": {"insert": "OfAdjacency.Insert", "remove": "OfAdjacency.Remove", "clear": "OfAdjacency.Clear"},
        "OfTerm": {"map": "OfMap", "reduce": "OfReduce", "partition": "OfPartition", "update": "OfUpdate",
                   "upsert": "OfUpsert"},  # a kind union (97)
    }

    def schema(_: Any, name: str) -> Any:
        """A schema a relation links: one of this module's, by its symbol, or a meta-schema, from the transaction (78)."""
        return getattr(S, name.removeprefix("Schemas.")) if name.startswith("Schemas.") else getattr(_, name)

    return txn.uid("mbse.Schemas.Mutations/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Payload": S.OfAny,  # untyped: interpreted by the target's schema
                  **{n: S.OfObject for n in verbs},
                  **{n: S.OfUnion for n in UNIONS},
                  "OfPattern": S.OfContainer,  # a spec: for each symbol, the mutations of the object it binds (95)
                  **{n: S.OfObject for n in TERMS},
                  **{n: S.OfRelation for n, *_ in RELATIONS}})
        .spec([
            lambda _: _.Payload.name("Mutations.Payload"),
            *(lambda _, n=n, v=v: getattr(_, n).name(f"Mutations.{n}").properties(v(_)) for n, v in verbs.items()),
            *(lambda _, n=n, b=b: getattr(_, n).name(f"Mutations.{n}").branches({k: getattr(_, s) for k, s in b.items()})
              for n, b in branches.items()),
            lambda _: _.OfPattern.name("Mutations.OfPattern").index([S.OfStr]).element([
                S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfObject]))]),
            *(lambda _, n=n, t=t: getattr(_, n).name(f"Mutations.{n}").ref(True).properties({
                k: getattr(S, s) for k, s in t.items()}) for n, t in TERMS.items()),
            *(lambda _, n=n, a=a, b=b, s=s, one=one: getattr(_, n)
              .name(f"Mutations.{n}")
              .links([lambda t: t.name(a), lambda t: t.name(b).schema([schema(_, s)])])
              .uniques([[b]] if one else []) for n, a, b, s, one in RELATIONS),
            *(lambda _, k=k, a=a: getattr(_, k).adjacencies({
                name: lambda j, r=r, m=m: j.relation([getattr(_, r)]).me(m) for name, r, m in a})
              for k, a in ADJACENCIES.items()),
        ])]))])
