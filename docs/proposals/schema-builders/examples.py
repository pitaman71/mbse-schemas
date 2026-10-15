"""Usage of the proposed schema builders (`Builders.py`), against `Schemas.OfX.Data` as it is; each schema validates,
and so does each meta-schema.

Shorthands first (VISITOR_PATTERN.md): a property takes its value whole; an adjacency of a relation of two links takes
an iterable (the peer shorthand), each item the object to link, or a callback setting the entry's properties
(`t.name`), its link (`t.property`), or the linked object's members (`t.type`). The callback forms follow.

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
assert all(link.type is None for link in B.Meta.Typing.entry.links.values())

# --- A contact who knows other contacts, with the shorthands ---

Contact = (
    B.OfObject.Builder()
    .name("crm.Contact")
    .ref(True)
    .properties([
        lambda t: t.name("given_name").type([Text]),
        lambda t: t.name("age").type([Int]),
    ])
    .create()
)
age = Contact.properties["age"]
Knows = (
    B.OfRelation.Builder()
    .name("crm.Knows")
    .links([
        lambda t: t.name("knower"),
        lambda t: t.name("known"),
    ])
    .properties([lambda t: t.name("since").type([Int])])
    .uniques("since")
    .create()
)
(
    B.OfObject.Builder(Contact)
    .adjacencies([
        lambda t: t.name("acquaintances").relation([Knows]).me("knower"),
        lambda t: t.relation([Knows]).me("known"),  # anonymous: no name
    ])
    .update()
)
assert Contact.validate() == [] and Knows.validate() == [], (Contact.validate(), Knows.validate())
assert list(Contact.properties) == ["given_name", "age"] and Contact.properties["age"].type is Int
assert Knows.uniques == (frozenset({"since"}),) and Contact.adjacencies["acquaintances"].me == "knower"
assert [a.me for a in Contact.anonymous] == ["known"]
assert B.OfRelation.Builder(Knows).uniques.as_schema().name == "uniques"

# --- `unique` clauses, by name: one name, one clause of several, or several clauses ---

for given, held in (("since", (frozenset({"since"}),)),
                    (["knower", "since"], (frozenset({"knower", "since"}),)),
                    ([["since"], ["knower", "known"]], (frozenset({"since"}), frozenset({"knower", "known"})))):
    assert B.OfRelation.Builder(Knows).uniques(given).clone().uniques == held
assert B.OfRelation.Builder(Knows).uniques([["since"], ["known", "knower"]]).uniques.get() is None  # not a scalar

Pairs = (
    B.OfRelation.Builder()
    .name("crm.Pairs")
    .links([
        lambda t: t.name("left"),
        lambda t: t.name("right"),
    ])
    .create()
)
assert list(Pairs.entry.links) == ["left", "right"] and Pairs.validate() == []

# --- The callback form: a member named by its entry, built where it is linked ---

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

# --- Adjacency shorthands: one entry replaced where the relation allows one ---

try:
    B.OfAny.Builder().types({"n": Int})
    raise AssertionError("a map is not an iterable of items")
except TypeError as error:
    assert "takes an iterable" in str(error), error
spare = B.OfProperty.Builder().type([Int]).create()
B.OfObject.Builder().name("demo.Spare").properties([lambda t: t.name("spare").property(spare).description("extra")])
assert spare.description == "extra"  # members written after the link update the object linked
try:
    B.OfObject.Builder().properties([lambda t: t.description("extra").property(spare)])
    raise AssertionError("link first")
except ValueError as error:
    assert "link the object before writing its members" in str(error)
renamed = B.OfObject.Builder().name("demo.Renamed").properties([lambda t: t.name("years").property(age)]).create()
assert list(renamed.properties) == ["years"] and renamed.properties["years"] is age
(
    B.OfObject.Builder(Contact)
    .properties([lambda t: t.name("age").property(age)])  # the same entry again: elided
    .update()
)
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
    .parameters([lambda t: t.name("width").parameter(width)])
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
    .branches([
        lambda t: t.name("count").type([Int]),
        lambda t: t.name("label").type([Text]),
    ])
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
    .symbols([
        lambda t: t.name("a").type([Contact]),
        lambda t: t.name("b").type([Contact]),
    ])
    .requires([B.Form.Builder().kind("call").attributes({"name": "knows"}).create()])
    .create()
)
for schema in (Shape, Either, Mutual):
    assert schema.validate() == [], (schema, schema.validate())
assert [b.name for b in Shape.branches] == ["count", "label"] and list(Mutual.symbols) == ["a", "b"]
assert Either.types == (Int, Text) and Mutual.requires.kind == "call"

print("all examples hold")
