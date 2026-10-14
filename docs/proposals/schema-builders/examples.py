"""Usage of the proposed schema builders (`Builders.py`), against `Schemas.OfX.Data` as it is; each schema validates,
and so does each meta-schema.

Run from python3/: `uv run python ../docs/proposals/schema-builders/examples.py`.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import Builders as B

Text, Int = B.OfScalar.Data(str), B.OfScalar.Data(int)

# --- The meta-schemas: reference objects and relations, valid ---

for name, schema in vars(B.Meta).items():
    if not name.startswith("_"):
        assert schema.validate() == [], (name, schema.validate())
assert B.Meta.Object.ref and list(B.Meta.Object.properties) == ["name", "description", "ref", "pattern", "singleton"]
assert list(B.Meta.Object.adjacencies) == ["parameters", "adjacencies", "properties", "refines"]
assert B.Meta.Typing.uniques == (frozenset({"schema"}),) and B.Meta.HasProperty.uniques == (frozenset({"owner"}),)

# --- An object schema: properties hold values; properties and types are adjacencies ---

Contact = (
    B.OfObject.Builder()
    .name("crm.Contact")
    .ref(True)
    .properties(lambda adj: (
        adj
        .insert(lambda e: e.property(lambda p: (
            p
            .name("given_name")
            .type(lambda t: t.insert(lambda e: e.schema(Text)))
        )))
        .insert(lambda e: e.property(lambda p: (
            p
            .name("age")
            .type(lambda t: t.insert(lambda e: e.schema(lambda k: k.scalar(lambda s: s.token("int")))))
        )))
    ))
    .create()
)
assert Contact.validate() == [], Contact.validate()
assert list(Contact.properties) == ["given_name", "age"] and Contact.properties["age"].type.type is int

# --- A relation: links and a unique clause, each by reference ---

knower = (
    B.OfSymbol.Builder()
    .name("knower")
    .type(lambda t: t.insert(lambda e: e.schema(Contact)))
    .create()
)
known = (
    B.OfSymbol.Builder()
    .name("known")
    .type(lambda t: t.insert(lambda e: e.schema(Contact)))
    .create()
)
since = (
    B.OfProperty.Builder()
    .name("since")
    .type(lambda t: t.insert(lambda e: e.schema(Int)))
    .create()
)
Knows = (
    B.OfRelation.Builder()
    .name("crm.Knows")
    .links(lambda adj: (
        adj
        .insert(lambda e: e.link(knower))
        .insert(lambda e: e.link(known))
    ))
    .properties(lambda adj: adj.insert(lambda e: e.property(since)))
    .uniques(lambda adj: adj.insert(lambda e: e.unique(lambda u: u.named(lambda n: n.insert(lambda e: e.named(since))))))
    .create()
)
(
    B.OfObject.Builder(Contact)
    .adjacencies(lambda adj: (
        adj
        .insert(lambda e: e.adjacency(lambda a: (
            a
            .name("acquaintances")
            .relation(lambda r: r.insert(lambda e: e.relation(Knows)))
            .me(lambda m: m.insert(lambda e: e.link(knower)))
        )))
        .insert(lambda e: e.adjacency(lambda a: (
            a
            .relation(lambda r: r.insert(lambda e: e.relation(Knows)))
            .me(lambda m: m.insert(lambda e: e.link(known)))
        )))
    ))
    .update()
)
assert Knows.validate() == [] and Contact.validate() == [], (Knows.validate(), Contact.validate())
assert Knows.uniques == (frozenset({"since"}),) and Contact.adjacencies["acquaintances"].me == "knower"
assert len(Contact.anonymous) == 1

# --- Reading back: members are child visitors; a link reads its referent ---

builder = B.OfObject.Builder(Contact)
assert builder.name == "crm.Contact" and builder.ref.get() is True and builder.as_identity() == "crm.Contact"
assert [str(e.property.name) for e in builder.properties] == ["given_name", "age"]
assert [e.property.type.as_schema().relation.name for e in builder.properties] == ["Schemas.Typing", "Schemas.Typing"]
assert builder.as_schema() is B.Meta.Object and builder.properties.as_schema() is B.Meta.Object.adjacencies["properties"]
assert [p.as_schema().name for p in builder.as_properties] == ["name", "ref"]
seen = []
builder.as_adjacencies(lambda adj: seen.append(adj.as_schema().name))
assert seen == ["parameters", "adjacencies", "properties", "refines"]
try:
    next(iter(builder.properties)).property.name("x")
    raise AssertionError("a link read is read-only")
except B.ReadOnlyError:
    pass

# --- Editing a member through its link updates it; removing by template ---

age = Contact.properties["age"]
(
    B.OfObject.Builder(Contact)
    .properties(lambda adj: adj.as_iterable(lambda it: (next(it), next(it).property(lambda p: p.description("years")))))
    .update()
)
assert Contact.properties["age"] is age and age.description == "years"
Smaller = (
    B.OfObject.Builder(Contact)
    .name("crm.Smaller")
    .properties(lambda adj: adj.remove(lambda e: e.property(lambda p: p.name("age"))))
    .clone()
)
assert list(Smaller.properties) == ["given_name"] and list(Contact.properties) == ["given_name", "age"]

# --- Refinement and widths, each a relation; a width is a term ---

Integer = (
    B.OfScalar.Builder()
    .name("Expressions.Domains.Integer")
    .refines(lambda r: r.insert(lambda e: e.refined(Int)))
    .parameters(lambda adj: adj.insert(lambda e: e.parameter(lambda p: (
        p
        .name("width")
        .type(lambda t: t.insert(lambda e: e.schema(Int)))
    ))))
    .bits(lambda w: w.insert(lambda e: e.width(lambda f: f.kind("variable").attributes({"name": "width"}))))
    .create()
)
Int8 = (
    B.OfApply.Builder()
    .name("Expressions.Domains.int8")
    .of(lambda o: o.insert(lambda e: e.applied(Integer)))
    .arguments(lambda adj: adj.insert(lambda e: e.argument(lambda a: (
        a
        .parameter(lambda p: p.insert(lambda e: e.parameter(Integer.parameters["width"])))
        .value(8)
    ))))
    .create()
)
Byte = (
    B.OfScalar.Builder()
    .name("demo.Byte")
    .token("int")
    .bits(lambda w: w.insert(lambda e: e.width(lambda f: f.kind("literal").attributes({"value": 8}))))
    .create()
)
assert Integer.token.name == "int" and Integer.bits.kind == "variable" and Byte.bits == 8
assert Int8.arguments == {"width": 8}
for schema in (Integer, Int8, Byte):
    assert schema.validate() == [], (schema, schema.validate())

# --- A container, a union, a value of any of several types, a predicate ---

Names = (
    B.OfContainer.Builder()
    .index(lambda i: i.insert(lambda e: e.index(Int)))
    .element(lambda x: x.insert(lambda e: e.element(Text)))
    .layout("dense")
    .create()
)
Shape = (
    B.OfUnion.Builder()
    .name("geo.Shape")
    .flat(True)
    .branches(lambda adj: (
        adj
        .insert(lambda e: e.branch(lambda b: b.name("count").type(lambda t: t.insert(lambda e: e.schema(Int)))))
        .insert(lambda e: e.branch(lambda b: b.name("label").type(lambda t: t.insert(lambda e: e.schema(Text)))))
    ))
    .create()
)
Either = (
    B.OfAny.Builder()
    .types(lambda adj: (
        adj
        .insert(lambda e: e.schema(Int))
        .insert(lambda e: e.schema(Text))
    ))
    .create()
)
Mutual = (
    B.OfPredicate.Builder()
    .name("crm.Mutual")
    .symbols(lambda adj: (
        adj
        .insert(lambda e: e.symbol(lambda s: s.name("a").type(lambda t: t.insert(lambda e: e.schema(Contact)))))
        .insert(lambda e: e.symbol(lambda s: s.name("b").type(lambda t: t.insert(lambda e: e.schema(Contact)))))
    ))
    .requires(lambda r: r.insert(lambda e: e.term(lambda f: f.kind("call").attributes({"name": "knows"}))))
    .create()
)
for schema in (Names, Shape, Either, Mutual):
    assert schema.validate() == [], (schema, schema.validate())
assert Names.arrangement == "dense" and Either.types == (Int, Text) and Mutual.requires.kind == "call"

# --- At most one entry where the relation says so; entries as values ---

try:
    B.OfContainer.Builder(Names).index(lambda i: i.insert(lambda e: e.index(Text)))
    raise AssertionError("one index")
except ValueError as error:
    assert "remove it before inserting another" in str(error)
Copy = (
    B.OfObject.Builder()
    .name("crm.Copy")
    .properties(B.OfObject.Builder(Contact).properties)
    .create()
)
assert list(Copy.properties) == ["given_name", "age"] and Copy.properties["age"] is Contact.properties["age"]

print("all examples hold")
