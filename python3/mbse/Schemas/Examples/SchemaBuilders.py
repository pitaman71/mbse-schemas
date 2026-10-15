# Schema builders example: building schemas in a store, the shorthands, and on-demand validation.
#
# Nothing here builds instances; it exercises the schema builders (Builders.OfX.Builder, through a store) and
# Schemas.OfX.Data.validate().

from mbse.Schemas.Framework import Builders, Schemas
from mbse.Schemas.Examples._support import raises

# Every schema object is built in a store: `store.Schemas.<Kind>(...)`. A callback creates one, an object and a
# callback update it, an object alone clones it; the call returns it.
store = Builders.Store()

# --- Types are schemas that exist ---

# A member's type is linked, not built: a schema that exists, such as a scalar schema.
Text = Builders.Meta.OfStr
Named = store.Schemas.Object(lambda o: o.properties([
    lambda t: t.name('first').type([Text]),
    lambda t: t.name('last').type([Text]),
]))
assert Named.properties['first'].type is Text and Named.properties['last'].type is Text

# A value of any type has no types; a value of one of several types, those.
assert store.Schemas.Any(lambda a: a).types == ()
assert store.Schemas.Any(lambda a: a.types([Text, Builders.Meta.OfInt])).types == (Text, Builders.Meta.OfInt)

# A property takes its value whole, of exactly its type.
with raises(TypeError):
    store.Schemas.Object(lambda o: o.ref(1))  # type: ignore  # deliberate misuse
with raises(TypeError):
    store.Schemas.Object(lambda o: o.properties([3]))  # an adjacency links schema objects, not values

# --- Builder finalization ---

with raises(ValueError):
    Builders.OfObject.Builder(Named).create()  # create() is only valid without a source
with raises(ValueError):
    Builders.OfObject.Builder().clone()  # clone() needs a source
with raises(ValueError):
    Builders.OfObject.Builder().update()  # update() needs a source
with raises(TypeError):
    store.Schemas.Object()  # a callback, an object and a callback, or an object

# A clone leaves the source untouched; an update changes it in place and returns it.
Extended = store.Schemas.Object(store.Schemas.Object(Named), lambda o: o.properties([lambda t: t.name('middle').type([Text])]))
assert Extended is not Named and 'middle' in Extended.properties and 'middle' not in Named.properties

updated = store.Schemas.Object(Named, lambda o: o.properties([lambda t: t.name('nickname').type([Text])]))
assert updated is Named and 'nickname' in Named.properties

# A clone owns its members: they are clones too, and later edits do not leak.
assert Extended.properties['first'] is not Named.properties['first'] and Extended.properties['first'].type is Text

# Each call builds its own schema: building twice through the same callback gives independent schemas.
a_only = lambda o: o.properties([lambda t: t.name('a').type([Text])])  # noqa: E731
first = store.Schemas.Object(a_only)
second = store.Schemas.Object(a_only)
store.Schemas.Object(second, lambda o: o.properties([lambda t: t.name('b').type([Text])]))
assert first is not second and list(first.properties) == ['a'] and list(second.properties) == ['a', 'b']

# Redefining a property replaces it.
Retyped = store.Schemas.Object(store.Schemas.Object(first), lambda o: o.properties([
    lambda t: t.name('a').type([Builders.Meta.OfInt]),
]))
assert Retyped.properties['a'].type == Builders.Meta.OfInt and first.properties['a'].type is Text

# --- Relations and cardinality ---

# A map a -> [key] -> b: a relation with links a, b and property key. ISO 4217 currency codes as keys.
Product = store.Schemas.Object(lambda o: o.ref(True).properties([lambda t: t.name('sku').type([Text])]))
Money = store.Schemas.Object(lambda o: (
    o
    .ref(True)  # an entry links only reference objects
    .properties([lambda t: t.name('minor_units').type([Builders.Meta.OfInt])])  # e.g. cents
))
Prices = store.Schemas.Relation(lambda r: (
    r
    .links([
        lambda t: t.name('product'),
        lambda t: t.name('price'),
    ])
    .properties([lambda t: t.name('currency').type([Text])])  # ISO 4217 alpha code, e.g. 'EUR'
    .uniques([
        ['price'],  # (product, currency) determine the price
        ['product', 'currency'],  # each price belongs to one product under one currency
    ])
))
store.Schemas.Object(Product, lambda o: o.adjacencies([lambda t: t.name('prices').relation([Prices]).me('product')]))
store.Schemas.Object(Money, lambda o: o.adjacencies([lambda t: t.name('priced').relation([Prices]).me('price')]))
for schema in (Product, Money, Prices):
    assert schema.validate() == [], schema.validate()


def parent_child(r):
    return r.links([
        lambda t: t.name('parent'),
        lambda t: t.name('child'),
    ])


# Pure ownership and a directory keyed within its parent, written as in FRAMEWORK.md.
Ownership = store.Schemas.Relation(lambda r: parent_child(r).uniques('parent'))
Directory = store.Schemas.Relation(lambda r: (
    parent_child(r)
    .properties([lambda t: t.name('key').type([Text])])
    .uniques([
        ['parent', 'key'],
        ['child'],
    ])
))
assert Ownership.validate() == [] and Directory.validate() == []

# --- Validation catches problems, but only when asked ---

# Building an invalid schema succeeds; validate() reports the problems.
NoLinks = store.Schemas.Relation(lambda r: r)
assert any('two links or more' in p for p in NoLinks.validate())
OneLink = store.Schemas.Relation(lambda r: r.links([lambda t: t.name('contact')]))
assert any('a list of values is a container' in p for p in OneLink.validate())

Clash = store.Schemas.Relation(lambda r: (
    r
    .links([
        lambda t: t.name('owner'),
        lambda t: t.name('item'),
    ])
    .properties([lambda t: t.name('item').type([Text])])
))
assert any('both link and property' in p for p in Clash.validate())

DuplicateLinks = store.Schemas.Relation(lambda r: r.links([
    lambda t: t.name('node'),
    lambda t: t.name('node'),
]))
assert list(DuplicateLinks.entry.links) == ['node'] and DuplicateLinks.validate() != []  # by name, as properties are

UnknownUnique = store.Schemas.Relation(lambda r: (
    r
    .links([
        lambda t: t.name('a'),
        lambda t: t.name('b'),
    ])
    .uniques('c')
))
assert any('unknown' in p for p in UnknownUnique.validate())

WrongSide = store.Schemas.Object(lambda o: o.adjacencies([
    lambda t: t.name('things').relation([Ownership]).me('owner'),  # Ownership's links are parent, child
]))
assert any('not a link' in p for p in WrongSide.validate())

NameClash = store.Schemas.Object(lambda o: (
    o
    .properties([lambda t: t.name('children').type([Text])])
    .adjacencies([lambda t: t.name('children').relation([Ownership]).me('parent')])
))
assert any('both property and adjacency' in p for p in NameClash.validate())

for unsupported in (complex, list, bytearray):
    assert Schemas.OfScalar.Data(unsupported).validate()  # type: ignore  # deliberate misuse
    bad = store.Schemas.Object(lambda o: o.properties([
        lambda t: t.name('x').type([store.Schemas.Scalar(lambda s: s.token(unsupported.__name__))]),  # no basic type
    ]))
    assert bad.validate(), unsupported

# --- Singletons ---

# A singleton is a reference object: `singleton` names it, and `ref` makes it one.
Registry = store.Schemas.Object(lambda o: o.ref(True).singleton('iso3166.Registry'))
assert Registry.singleton == 'iso3166.Registry' and Registry.validate() == []

# --- Unions and intersections (schema level) ---
#
# A union's branches and an intersection's parts are named: a union value holds exactly one branch, by name, and an
# intersection value every part.

Phone = store.Schemas.Object(lambda o: o.properties([lambda t: t.name('number').type([Text])]))
Email = store.Schemas.Object(lambda o: o.properties([lambda t: t.name('address').type([Text])]))

ContactMethod = store.Schemas.Union(lambda u: u.branches([
    lambda t: t.name('phone').type([Phone]),
    lambda t: t.name('email').type([Email]),
]))
assert ContactMethod.validate() == []

Unnamed = store.Schemas.Union(lambda u: u.branches([
    lambda t: t.type([Phone]),
    lambda t: t.name('email').type([Email]),
]))
assert any('has no name' in p for p in Unnamed.validate())

SameName = store.Schemas.Union(lambda u: u.branches([
    lambda t: t.name('m').type([Phone]),
    lambda t: t.name('m').type([Email]),
]))
assert any('more than once' in p for p in SameName.validate())

MixedKinds = store.Schemas.Union(lambda u: u.branches([
    lambda t: t.name('phone').type([Phone]),
    lambda t: t.name('text').type([Text]),
]))
assert any('same kind' in p for p in MixedKinds.validate())

SingleBranch = store.Schemas.Union(lambda u: u.branches([lambda t: t.name('phone').type([Phone])]))
assert any('at least two' in p for p in SingleBranch.validate())

# Intersections combine same-kind schemas as named parts. Each part keeps its own properties, so two parts may
# declare the same property, even with different types.
Timestamped = store.Schemas.Object(lambda o: o.properties([lambda t: t.name('updated').type([Text])]))
EpochStamped = store.Schemas.Object(lambda o: o.properties([
    lambda t: t.name('updated').type([Builders.Meta.OfInt]),
]))
Stamps = store.Schemas.Intersection(lambda i: i.parts([
    lambda t: t.name('text').type([Timestamped]),
    lambda t: t.name('epoch').type([EpochStamped]),
]))
assert Stamps.validate() == []

assert store.Schemas.Intersection(lambda i: i.parts([
    lambda t: t.name('stamp').type([Timestamped]),
    lambda t: t.name('text').type([Text]),
])).validate()  # mixed kinds

print('SchemaBuilders: all checks passed')
