"""Usage of the proposed schema builders (`Builders.py`), against `Schemas.OfX.Data` as it is; each schema validates,
and so does each meta-schema.

Shorthands first (VISITOR_PATTERN.md): a property takes its value whole; an adjacency takes a map of names to what it
links where its entries name it (peer + key: a schema's members), else an iterable of what it links (peer: a type,
what a schema refines, a relation). The callback forms follow, for what they do that the shorthands do not.

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
assert list(B.Meta.HasProperty.entry.properties) == ["name"]
assert B.Meta.HasProperty.uniques == (frozenset({"owner"}), frozenset({"property"}))
assert B.Meta.Typing.uniques == (frozenset({"schema"}),)

# --- A contact who knows other contacts, with the shorthands ---

given_name = (
    B.OfProperty.Builder()
    .type([Text])
    .create()
)
age = (
    B.OfProperty.Builder()
    .type([Int])
    .create()
)
Contact = (
    B.OfObject.Builder()
    .name("crm.Contact")
    .ref(True)
    .properties({
        "given_name": given_name,
        "age": age,
    })
    .create()
)
knower = (
    B.OfSymbol.Builder()
    .type([Contact])
    .create()
)
known = (
    B.OfSymbol.Builder()
    .type([Contact])
    .create()
)
since = (
    B.OfProperty.Builder()
    .type([Int])
    .create()
)
Knows = (
    B.OfRelation.Builder()
    .name("crm.Knows")
    .links({
        "knower": knower,
        "known": known,
    })
    .properties({"since": since})
    .uniques([B.OfUnique.Builder().named([since]).create()])
    .create()
)
acquaintances = (
    B.OfAdjacency.Builder()
    .relation([Knows])
    .me([knower])
    .create()
)
acquainted = (
    B.OfAdjacency.Builder()
    .relation([Knows])
    .me([known])
    .create()
)
(
    B.OfObject.Builder(Contact)
    .adjacencies({"acquaintances": acquaintances})
    .adjacencies(lambda adv: adv.insert(lambda env: env.adjacency(acquainted)))  # anonymous: no name
    .update()
)
assert Contact.validate() == [] and Knows.validate() == [], (Contact.validate(), Knows.validate())
assert list(Contact.properties) == ["given_name", "age"] and Contact.properties["age"].type is Int
assert Knows.uniques == (frozenset({"since"}),) and Contact.adjacencies["acquaintances"].me == "knower"
assert Contact.anonymous == [acquainted]

# --- The callback forms: a member named by its entry, built where it is linked ---

Person = (
    B.OfObject.Builder()
    .name("crm.Person")
    .ref(True)
    .properties(lambda adv: adv.insert(lambda env: env.name("nickname").property(lambda p: p.type([Text]))))
    .create()
)
assert Person.validate() == [] and Person.properties["nickname"].type is Text

# --- Property shorthands: the type must match exactly; a value is set whole ---

for wrong in (lambda: B.OfObject.Builder().ref(1), lambda: B.OfObject.Builder().name(3)):
    try:
        wrong()
        raise AssertionError("a shorthand's type must match exactly")
    except TypeError as error:
        assert "holds" in str(error)
call = B.Form.Builder().kind("call").attributes({"name": "knows"}).attributes({"arity": 2}).create()
assert call.attributes == {"arity": 2}

# --- Adjacency shorthands: a map where entries are named, an iterable where not; one entry replaced ---

for wrong, says in ((lambda: B.OfObject.Builder().properties([age]), "give a map of names"),
                    (lambda: B.OfAny.Builder().types({"n": Int}), "carry no name")):
    try:
        wrong()
        raise AssertionError(says)
    except TypeError as error:
        assert says in str(error), error
Names = (
    B.OfContainer.Builder()
    .index([Int])
    .element([Text])
    .layout("dense")
    .create()
)
assert Names.validate() == [] and Names.arrangement == "dense"
Keyed = (
    B.OfContainer.Builder(Names)
    .index([Text])
    .clone()
)
assert Keyed.index is Text and Names.index is Int
try:
    B.OfContainer.Builder(Names).index(lambda adv: adv.insert(lambda env: env.index(Text)))
    raise AssertionError("insert does not replace")
except ValueError as error:
    assert "remove it before inserting another" in str(error)
try:
    B.OfProperty.Builder().type(lambda adv: adv.insert(lambda env: env.schema(lambda s: s)))
    raise AssertionError("a type is linked, not built")
except TypeError as error:
    assert "links an object that exists" in str(error)

# --- Reading back: members are child visitors; an entry's name and link read ---

builder = B.OfObject.Builder(Contact)
assert builder.name == "crm.Contact" and builder.ref.get() is True
assert [str(env.name) for env in builder.properties] == ["given_name", "age"]
assert [env.property.type.as_schema().relation.name for env in builder.properties] == ["Schemas.Typing"] * 2
assert next(iter(builder.properties)).name.as_schema() is B.Meta.HasProperty.entry.properties["name"]
assert builder.as_schema() is B.Meta.Object and builder.properties.as_schema() is B.Meta.Object.adjacencies["properties"]
assert [p.as_schema().name for p in builder.as_properties] == ["name", "ref"]
seen = []
builder.as_adjacencies(lambda adv: seen.append(adv.as_schema().name))
assert seen == ["parameters", "adjacencies", "properties", "refines"]
try:
    next(iter(builder.properties)).property.description("x")
    raise AssertionError("a link read is read-only")
except B.ReadOnlyError:
    pass

# --- Every schema object is given an identity on creation: a named schema its name, others a UUID ---

assert B.identity_of(Contact) == "crm.Contact" and B.identity_of(B.Meta.Typing) == "Schemas.Typing"
assert len(B.identity_of(age)) == 36 and builder.as_identity() == "crm.Contact"
nickname = B.OfProperty.Builder().as_identity("crm.Contact.nickname").type([Text]).create()
assert B.identity_of(nickname) == "crm.Contact.nickname"
assert B.identity_of(B.OfObject.Builder(Contact).description("people").update()) == "crm.Contact"
Twin = B.OfObject.Builder(Contact).as_identity("crm.Twin").clone()
assert B.identity_of(Twin) == "crm.Twin" and B.identity_of(Contact) == "crm.Contact"

# --- Editing through an entry: its member updated, or renamed; removing by template ---

(
    B.OfObject.Builder(Contact)
    .properties(lambda adv: adv.as_iterable(lambda it: (next(it), next(it).property(lambda p: p.description("years")))))
    .update()
)
assert Contact.properties["age"] is age and age.description == "years"
(
    B.OfObject.Builder(Person)
    .properties(lambda adv: adv.as_iterable(lambda it: next(it).name("alias")))
    .update()
)
assert list(Person.properties) == ["alias"] and Person.validate() == []
Smaller = (
    B.OfObject.Builder(Contact)
    .name("crm.Smaller")
    .properties(lambda adv: adv.remove(lambda env: env.name("age")))
    .clone()
)
assert list(Smaller.properties) == ["given_name"] and list(Contact.properties) == ["given_name", "age"]

# --- Refinement, parameters, widths (terms), an application ---

width = (
    B.OfParameter.Builder()
    .type([Int])
    .create()
)
Integer = (
    B.OfScalar.Builder()
    .name("Expressions.Domains.Integer")
    .refines([Int])
    .parameters({"width": width})
    .bits([B.Form.Builder().kind("variable").attributes({"name": "width"}).create()])
    .create()
)
eight = (
    B.OfApply.Builder()
    .name("Expressions.Domains.int8")
    .of([Integer])
    .arguments(lambda adv: adv.insert(lambda env: env.argument(lambda a: a.parameter([width]).value(8))))
    .create()
)
Byte = (
    B.OfScalar.Builder()
    .name("demo.Byte")
    .token("int")
    .bits([B.Form.Builder().kind("literal").attributes({"value": 8}).create()])
    .create()
)
assert Integer.token.name == "int" and Integer.bits.kind == "variable" and Byte.bits == 8
assert eight.arguments == {"width": 8}
for schema in (Integer, eight, Byte):
    assert schema.validate() == [], (schema, schema.validate())

# --- A union, a value of any of several types, a predicate ---

Shape = (
    B.OfUnion.Builder()
    .name("geo.Shape")
    .flat(True)
    .branches(lambda adv: (
        adv
        .insert(lambda env: env.name("count").branch(lambda b: b.type([Int])))
        .insert(lambda env: env.name("label").branch(lambda b: b.type([Text])))
    ))
    .create()
)
Either = (
    B.OfAny.Builder()
    .types([Int, Text])
    .create()
)
Mutual = (
    B.OfPredicate.Builder()
    .name("crm.Mutual")
    .symbols({
        "a": B.OfSymbol.Builder().type([Contact]).create(),
        "b": B.OfSymbol.Builder().type([Contact]).create(),
    })
    .requires([B.Form.Builder().kind("call").attributes({"name": "knows"}).create()])
    .create()
)
for schema in (Shape, Either, Mutual):
    assert schema.validate() == [], (schema, schema.validate())
assert [b.name for b in Shape.branches] == ["count", "label"] and list(Mutual.symbols) == ["a", "b"]
assert Either.types == (Int, Text) and Mutual.requires.kind == "call"

print("all examples hold")
