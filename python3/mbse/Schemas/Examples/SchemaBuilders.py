# Schema builders example: builder semantics, Spec forms, and on-demand validation.
#
# Nothing here builds instances; it exercises Schemas.OfX.Builder and Schemas.OfX.Data.validate().

from mbse.Schemas.Framework import Schemas
from mbse.Schemas.Examples._support import raises

# --- Spec forms ---

# A scalar Spec is a type directly, or a callable that takes and returns an OfScalar.Builder.
direct = Schemas.OfAny.Builder().as_scalar(str).create()
configured = Schemas.OfAny.Builder().as_scalar(lambda n: n.type(str)).create()
assert direct == configured == Schemas.OfScalar.Data(str)

# Finalizing an OfAny builder yields the selected kind's data, not a wrapper.
assert type(direct) is Schemas.OfScalar.Data

# An OfAny Spec may also be existing schema data, reused as is (not copied).
Text = Schemas.OfScalar.Data(str)
Named = (
    Schemas.OfObject.Builder()
    .properties(
        lambda prop: prop.name('first').of(Text),
        lambda prop: prop.name('last').of(Text),
    )
    .create()
)
assert Named.properties['first'].type is Text and Named.properties['last'].type is Text

# An OfAny builder with no kind selected is a value of any type; with several, of one of them.
assert Schemas.OfAny.Builder().create().types == ()

# A Spec callable must return its builder.
with raises(TypeError):
    Schemas.OfObject.Builder().properties(lambda prop: None).create()  # type: ignore  # deliberate misuse

# --- Builder finalization ---

with raises(ValueError):
    Schemas.OfObject.Builder(Named).create()  # create() is only valid without a source
with raises(ValueError):
    Schemas.OfObject.Builder().clone()  # clone() needs a source
with raises(ValueError):
    Schemas.OfObject.Builder().update()  # update() needs a source

# clone() leaves the source untouched; update() changes it in place and returns it.
Extended = (
    Schemas.OfObject.Builder(Named)
    .properties(lambda prop: prop.name('middle').of(Text))
    .clone()
)
assert Extended is not Named and 'middle' in Extended.properties and 'middle' not in Named.properties

updated = (
    Schemas.OfObject.Builder(Named)
    .properties(lambda prop: prop.name('nickname').of(Text))
    .update()
)
assert updated is Named and 'nickname' in Named.properties

# A builder keeps its own copies: finalizing twice gives independent schemas, and later edits do not leak.
builder = Schemas.OfObject.Builder().properties(lambda prop: prop.name('a').of(Text))
first = builder.create()
builder.properties(lambda prop: prop.name('b').of(Text))
second = builder.create()
assert list(first.properties) == ['a'] and list(second.properties) == ['a', 'b']

# Redefining a property replaces it.
Retyped = (
    Schemas.OfObject.Builder(first)
    .properties(lambda prop: prop.name('a').of(lambda t: t.as_scalar(int)))
    .clone()
)
assert Retyped.properties['a'].type == Schemas.OfScalar.Data(int) and first.properties['a'].type is Text

# --- Relations and cardinality ---

# A map a -> [key] -> b: a relation with links a, b and property key. ISO 4217 currency codes as keys.
Product = Schemas.OfObject.Builder().ref().properties(lambda prop: prop.name('sku').of(Text)).create()
Money = (
    Schemas.OfObject.Builder().ref()  # an entry links only reference objects
    .properties(lambda prop: prop.name('minor_units').of(lambda t: t.as_scalar(int)))  # e.g. cents
    .create()
)
Prices = (
    Schemas.OfRelation.Builder()
    .links('product', 'price')
    .properties(lambda prop: prop.name('currency').of(Text))  # ISO 4217 alpha code, e.g. 'EUR'
    .unique('price')  # (product, currency) determine the price
    .unique('product', 'currency')  # each price belongs to one product under one currency
    .create()
)
Schemas.OfObject.Builder(Product).relations(lambda adj: adj.name('prices').of(Prices).me('product')).update()
Schemas.OfObject.Builder(Money).relations(lambda adj: adj.name('priced').of(Prices).me('price')).update()
for schema in (Product, Money, Prices):
    assert schema.validate() == [], schema.validate()

# Pure ownership and a directory keyed within its parent, written as in FRAMEWORK.md.
Ownership = Schemas.OfRelation.Builder().links('parent', 'child').unique('parent').create()
Directory = (
    Schemas.OfRelation.Builder()
    .links('parent', 'child')
    .properties(lambda prop: prop.name('key').of(Text))
    .unique('parent', 'key')
    .unique('child')
    .create()
)
assert Ownership.validate() == [] and Directory.validate() == []

# --- Validation catches problems, but only when asked ---

# Building an invalid schema succeeds; validate() reports the problems.
NoLinks = Schemas.OfRelation.Builder().create()
assert any('two links or more' in p for p in NoLinks.validate())
assert any('a list of values is a container' in p for p in Schemas.OfRelation.Builder().links('contact').create().validate())

Clash = (
    Schemas.OfRelation.Builder()
    .links('owner', 'item')
    .properties(lambda prop: prop.name('item').of(Text))
    .create()
)
assert any('both link and property' in p for p in Clash.validate())

DuplicateLinks = Schemas.OfRelation.Builder().links('node', 'node').create()
assert list(DuplicateLinks.entry.links) == ['node'] and DuplicateLinks.validate() != []  # by name, as properties are

UnknownUnique = Schemas.OfRelation.Builder().links('a', 'b').unique('c').create()
assert any('unknown' in p for p in UnknownUnique.validate())

WrongSide = (
    Schemas.OfObject.Builder()
    .relations(lambda adj: adj.name('things').of(Ownership).me('owner'))  # Ownership's links are parent, child
    .create()
)
assert any('not a link' in p for p in WrongSide.validate())

NameClash = (
    Schemas.OfObject.Builder()
    .properties(lambda prop: prop.name('children').of(Text))
    .relations(lambda adj: adj.name('children').of(Ownership).me('parent'))
    .create()
)
assert any('both property and adjacency' in p for p in NameClash.validate())

for unsupported in (complex, list, bytearray):
    assert Schemas.OfScalar.Data(unsupported).validate()  # type: ignore  # deliberate misuse
    bad = Schemas.OfObject.Builder().properties(lambda prop: prop.name('x').of(lambda t: t.as_scalar(unsupported))).create()
    assert bad.validate(), unsupported

# --- Singletons ---

Registry = Schemas.OfObject.Builder().singleton('iso3166.Registry').create()
assert Registry.singleton == 'iso3166.Registry' and Registry.validate() == []

# --- Unions and intersections (schema level) ---
#
# A union's branches and an intersection's parts are named: a union value holds exactly one branch, by name, and an
# intersection value every part.

Phone = Schemas.OfObject.Builder().properties(lambda prop: prop.name('number').of(Text)).create()
Email = Schemas.OfObject.Builder().properties(lambda prop: prop.name('address').of(Text)).create()

ContactMethod = (
    Schemas.OfUnion.Builder()
    .branches(lambda b: b.name('phone').of(Phone), lambda b: b.name('email').of(Email))
    .create()
)
assert ContactMethod.validate() == []

Unnamed = Schemas.OfUnion.Builder().branches(lambda b: b.of(Phone), lambda b: b.name('email').of(Email)).create()
assert any('has no name' in p for p in Unnamed.validate())

SameName = Schemas.OfUnion.Builder().branches(lambda b: b.name('m').of(Phone), lambda b: b.name('m').of(Email)).create()
assert any('more than once' in p for p in SameName.validate())

MixedKinds = (
    Schemas.OfUnion.Builder()
    .branches(lambda b: b.name('phone').of(Phone), lambda b: b.name('text').of(Text))
    .create()
)
assert any('same kind' in p for p in MixedKinds.validate())

SingleBranch = Schemas.OfUnion.Builder().branches(lambda b: b.name('phone').of(Phone)).create()
assert any('at least two' in p for p in SingleBranch.validate())

# Intersections combine same-kind schemas as named parts. Each part keeps its own properties, so two parts may
# declare the same property, even with different types.
Timestamped = Schemas.OfObject.Builder().properties(lambda prop: prop.name('updated').of(Text)).create()
EpochStamped = Schemas.OfObject.Builder().properties(lambda prop: prop.name('updated').of(lambda t: t.as_scalar(int))).create()
Stamps = (
    Schemas.OfIntersection.Builder()
    .parts(lambda p: p.name('text').of(Timestamped), lambda p: p.name('epoch').of(EpochStamped))
    .create()
)
assert Stamps.validate() == []

assert Schemas.OfIntersection.Builder().parts(
    lambda p: p.name('stamp').of(Timestamped), lambda p: p.name('text').of(Text)).create().validate()  # mixed kinds

print('SchemaBuilders: all checks passed')
