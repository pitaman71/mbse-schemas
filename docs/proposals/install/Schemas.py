"""Schemas: schema elements (a draft of 4i, for review; see README.md beside it).

What changes: the plain schemas of schemas (level 2) and the basic scalars, which `Builders._plain()` builds today with
the builders, are defined here, by `install(txn)`. Level 3, the dataclasses below (`OfObject.Data`, ...), is unchanged.
"""

from __future__ import annotations

from typing import Any

# ... level 3, as today: OfScalar, OfProperty, OfObject, OfAdjacency, OfRelation, OfEntry, OfSymbol, OfVariable,
# OfPattern, OfExpression, OfConstraint, OfCollector, OfUnion, OfIntersection, OfParameter, OfContainer, is_a,
# inherited, plain_forms ...


# --- Level 2: what every store is made holding ---

SCALARS = ("OfBool", "OfInt", "OfFloat", "OfStr", "OfBytes")
"""The basic scalars, the only scalar schemas, each mapping to its host type by its name."""

KINDS: dict[str, dict[str, str | None]] = {  # each kind of schema: its properties beside `name` and `description`
    "OfScalar": {},
    "OfObject": {"ref": "OfBool", "singleton": "OfStr"},
    "OfUnion": {"flat": "OfBool"},
    "OfIntersection": {"flat": "OfBool"},
    "OfContainer": {"layout": "OfStr"},
    "OfAny": {},
    "OfRelation": {"uniques": None},  # None: a container, defined where it is linked (below)
    "OfPattern": {},
    "OfExpression": {},
    "OfCollector": {"symbols": None, "variables": None, "commutative": "OfBool", "associative": "OfBool",
                    "suffixes": None},
    "OfModule": {},  # its identity is its path; it defines schemas and modules
}

MEMBERS: dict[str, dict[str, str]] = {  # each kind of member: its properties, its name given by its owner's entry
    "OfProperty": {"description": "OfStr", "pattern": "OfStr"},
    "OfParameter": {"description": "OfStr"},
    "OfSymbol": {"description": "OfStr"},
    "OfVariable": {"description": "OfStr"},
    "OfAdjacency": {"description": "OfStr", "me": "OfStr", "owner": "OfBool"},
}

VALUED = ("OfScalar", "OfObject", "OfUnion", "OfIntersection", "OfContainer", "OfAny")
SCHEMAS = (*VALUED, "OfRelation", "OfPattern", "OfExpression", "OfCollector", "OfModule")  # what a module defines
WITH_SCHEMA = ("OfProperty", "OfSymbol", "OfVariable")

RELATIONS: list[tuple[str, tuple[str, tuple[str, ...], str | None], tuple[str, tuple[str, ...]], str]] = [
    # (relation, (link, the kinds at that end, the adjacency they name, "" for none), (link, the kinds at that end),
    # how constrained: as `Builders._plain` documents it today)
    ("HasSchema", ("member", WITH_SCHEMA, "schema"), ("schema", VALUED), "one"),
    ("Refines", ("refinement", (), ""), ("refined", VALUED), "one"),
    ("Indexing", ("container", ("OfContainer",), "index"), ("index", VALUED), "one"),
    ("Containing", ("container", ("OfContainer",), "element"), ("element", VALUED), "one"),
    ("AnyOf", ("any", ("OfAny",), "schemas"), ("schema", VALUED), "list"),
    ("Relating", ("adjacency", ("OfAdjacency",), "relation"), ("relation", ("OfRelation",)), "one"),
    ("HasParameter", ("owner", SCHEMAS, "parameters"), ("parameter", ("OfParameter",)), "keyed"),
    ("HasProperty", ("owner", (), ""), ("property", ("OfProperty",)), "keyed"),
    ("HasAdjacency", ("owner", ("OfObject",), "adjacencies"), ("adjacency", ("OfAdjacency",)), "keyed"),
    ("HasBranch", ("owner", ("OfUnion",), "branches"), ("schema", VALUED), "named"),
    ("HasPart", ("owner", ("OfIntersection",), "parts"), ("schema", VALUED), "named"),
    ("HasSymbol", ("owner", ("OfPattern",), "symbols"), ("symbol", ("OfSymbol",)), "keyed"),
    ("HasVariable", ("owner", ("OfPattern",), "variables"), ("variable", ("OfVariable",)), "keyed"),
    ("Requiring", ("pattern", ("OfPattern",), "requires"), ("constraint", ("OfExpression",)), "list"),
    ("Matching", ("expression", ("OfExpression", "OfCollector"), "pattern"), ("pattern", ("OfPattern",)), "one"),
    ("Resulting", ("expression", ("OfExpression",), "result"), ("schema", VALUED), "one"),
    ("Computing", ("collector", ("OfCollector",), "computes"), ("expression", ("OfExpression",)), "one"),
    ("HasLink", ("owner", ("OfRelation",), "links"), ("link", ("OfSymbol",)), "keyed"),
    ("Defines", ("module", ("OfModule",), "schemas"), ("schema", SCHEMAS), "keyed"),
]


def install(txn: Any) -> Any:
    """The plain schemas of schemas and the basic scalars, defined in the store a transaction writes:
    `store.transaction(Schemas.install)`. A store is made by it, read by the bootstrap (README.md, The bootstrap); run
    again in a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the meta-schemas, which this defines: each a symbol of its own kind (78)

    def texts(_: Any) -> Any:
        """A list of text, defined where it is linked."""
        return S.OfContainer(lambda c: c.index([_.OfInt]).element([_.OfStr]))

    def schema_of(_: Any, name: str | None) -> Any:
        """A property's schema: a basic scalar by its symbol, or what `KINDS` leaves to be defined where it is linked."""
        if name is not None:
            return getattr(_, name)
        return S.OfContainer(lambda c: c.index([_.OfInt]).element([texts(_)]))  # uniques: lists of names

    def kind(n: str, properties: dict[str, str | None]) -> Any:
        return lambda _: getattr(_, n).name(f"Schemas.{n}").ref(True).properties({
            "name": _.OfStr, "description": _.OfStr, **{p: schema_of(_, s) for p, s in properties.items()}})

    def member(n: str, properties: dict[str, str]) -> Any:
        return lambda _: getattr(_, n).name(f"Schemas.{n}").ref(True).properties({
            p: getattr(_, s) for p, s in properties.items()})

    def relation(n: str, first: str, second: str, how: str) -> Any:
        determined = {"one": [[second]], "owned": [[first]], "keyed": [[first, "name"], [second]],
                      "named": [[first, "name"]], "list": []}[how]
        properties = {"keyed": ("name",), "named": ("name", "description")}.get(how, ())
        return lambda _: (getattr(_, n)
                          .name(f"Schemas.{n}")
                          .links([lambda t: t.name(first), lambda t: t.name(second)])
                          .properties({p: _.OfStr for p in properties})
                          .uniques(determined))

    def ends(n: str, a: tuple[str, tuple[str, ...], str | None], b: tuple[str, tuple[str, ...]], how: str) -> list[Any]:
        """Each kind's adjacencies to relation `n`: named at its first end, anonymous at its second, which a keyed
        relation's owner owns (docs/OBJECT_IDENTITY.md, Decided, 14)."""
        (first, firsts, named), (second, seconds) = a, b
        return [*(lambda _, k=k: getattr(_, k).adjacencies({named: lambda j: j.relation([getattr(_, n)]).me(first)})
                  for k in (firsts if named else ())),
                *(lambda _, k=k: getattr(_, k).adjacencies([lambda j: j.relation([getattr(_, n)]).me(second)
                                                            .owner(how == "keyed")])
                  for k in seconds)]

    return txn.uid("mbse.Schemas/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({**{n: S.OfScalar for n in SCALARS},
                  **{n: S.OfObject for n in (*KINDS, *MEMBERS)},
                  **{n: S.OfRelation for n, *_ in RELATIONS}})
        .spec([
            *(lambda _, n=n: getattr(_, n).name(f"Schemas.{n}") for n in SCALARS),
            *(kind(n, properties) for n, properties in KINDS.items()),
            *(member(n, properties) for n, properties in MEMBERS.items()),
            *(relation(n, a[0], b[0], how) for n, a, b, how in RELATIONS),
            *(item for n, a, b, how in RELATIONS for item in ends(n, a, b, how)),
            *(lambda _, k=k: getattr(_, k).adjacencies({"properties": lambda j: j.relation([_.HasProperty]).me("owner")})
              for k in ("OfObject", "OfRelation")),  # each has its own properties; any schema may be their owner
            *(lambda _, k=k: getattr(_, k).adjacencies({"refines": lambda j: j.relation([_.Refines]).me("refinement")})
              for k in ("OfObject", "OfContainer")),  # only these refine
            lambda _: _.OfCollector.properties({"symbols": texts(_), "variables": texts(_),
                                                "suffixes": S.OfContainer(lambda c: c.index([_.OfStr]).element([_.OfStr]))}),
        ])]))])
