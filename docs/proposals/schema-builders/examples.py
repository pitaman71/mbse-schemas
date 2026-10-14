"""Usage of the proposed schema builders (`Builders.py`), against `Schemas.OfX.Data` as it is; each schema validates.

Run from python3/: `uv run python ../docs/proposals/schema-builders/examples.py`.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import Builders as B  # noqa: E402

Text, Int = B.OfScalar.Data(str), B.OfScalar.Data(int)

# --- An object schema: members, written by calling them; properties, an adjacency ---

Contact = (
    B.OfObject.Builder()
    .name("crm.Contact")
    .ref(True)
    .properties(lambda adj: (
        adj
        .insert(lambda e: e.property(lambda p: p.name("given_name").type(Text)))
        .insert(lambda e: e.property(lambda p: p.name("age").type(lambda t: t.as_scalar(int))))
    ))
    .create()
)
assert Contact.validate() == [], Contact.validate()
assert list(Contact.properties) == ["given_name", "age"]

# --- A relation, and an adjacency to it; an anonymous one ---

Knows = (
    B.OfRelation.Builder()
    .name("crm.Knows")
    .links(lambda adj: (
        adj
        .insert(lambda e: e.link(lambda s: s.name("knower").type(Contact)))
        .insert(lambda e: e.link(lambda s: s.name("known").type(Contact)))
    ))
    .properties(lambda adj: adj.insert(lambda e: e.property(lambda p: p.name("since").type(Int))))
    .uniques([("since",)])
    .create()
)
(
    B.OfObject.Builder(Contact)
    .adjacencies(lambda adj: (
        adj
        .insert(lambda e: e.adjacency(lambda a: a.name("acquaintances").relation(Knows).me("knower")))
        .insert(lambda e: e.adjacency(lambda a: a.relation(Knows).me("known")))
    ))
    .update()
)
assert Knows.validate() == [] and Contact.validate() == [], (Knows.validate(), Contact.validate())
assert list(Contact.adjacencies) == ["acquaintances"] and len(Contact.anonymous) == 1

# --- Reading back: members are child visitors ---

builder = B.OfObject.Builder(Contact)
assert builder.name == "crm.Contact" and str(builder.name) == "crm.Contact" and builder.ref.get() is True
assert [str(e.property.name) for e in builder.properties] == ["given_name", "age"]
assert [p.as_schema().name for p in builder.as_properties] == ["name", "ref"]
assert builder.as_schema() is B.S.OfObject.Schema and builder.as_identity() is None
seen = []
builder.as_adjacencies(lambda adj: seen.append(adj.as_schema().name))
assert seen == ["parameters", "properties", "adjacencies"]

# --- Removing by template; editing a member through its link; a link read is read-only ---

Smaller = (
    B.OfObject.Builder(Contact)
    .name("crm.Smaller")
    .properties(lambda adj: adj.remove(lambda e: e.property(lambda p: p.name("age"))))
    .clone()
)
assert list(Smaller.properties) == ["given_name"] and list(Contact.properties) == ["given_name", "age"]

Renamed = (
    B.OfObject.Builder(Contact)
    .properties(lambda adj: adj.as_iterable(lambda it: next(it).property(lambda p: p.name("first_name"))))
    .clone()
)
assert list(Renamed.properties) == ["first_name", "age"] and Renamed.properties["first_name"].type is Text
try:
    next(iter(builder.properties)).property.name("x")
    raise AssertionError("a link read is read-only")
except B.ReadOnlyError:
    pass

# --- A scalar refinement, a container, a union, an application, a predicate ---

Width = (
    B.OfScalar.Builder()
    .name("Expressions.Domains.Integer")
    .refines(Int)
    .parameters(lambda adj: adj.insert(lambda e: e.parameter(lambda p: p.name("width").type(Int))))
    .create()
)
Int8 = (
    B.OfApply.Builder()
    .name("Expressions.Domains.int8")
    .of(Width)
    .arguments(lambda adj: adj.insert(lambda e: e.argument(lambda a: a.name("width").value(8))))
    .create()
)
Names = (
    B.OfContainer.Builder()
    .index(Int)
    .element(Text)
    .layout("dense")
    .create()
)
Shape = (
    B.OfUnion.Builder()
    .name("geo.Shape")
    .branches(lambda adj: (
        adj
        .insert(lambda e: e.branch(lambda b: b.name("count").type(Int)))
        .insert(lambda e: e.branch(lambda b: b.name("label").type(Text)))
    ))
    .flat(True)
    .create()
)
Mutual = (
    B.OfPredicate.Builder()
    .name("crm.Mutual")
    .symbols(lambda adj: (
        adj
        .insert(lambda e: e.symbol(lambda s: s.name("a").type(Contact)))
        .insert(lambda e: e.symbol(lambda s: s.name("b").type(Contact)))
    ))
    .create()
)
for schema in (Width, Int8, Names, Shape, Mutual):
    assert schema.validate() == [], (schema, schema.validate())
assert Width.token.name == "int" and Int8.arguments == {"width": 8} and Names.arrangement == "dense"

# --- Entries as values: one schema's members inserted into another's ---

Copy = (
    B.OfObject.Builder()
    .name("crm.Copy")
    .properties(B.OfObject.Builder(Contact).properties)
    .create()
)
assert list(Copy.properties) == ["given_name", "age"] and Copy.properties["age"] is Contact.properties["age"]

print("all examples hold")
