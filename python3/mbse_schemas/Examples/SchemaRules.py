# Schema rules example: builder semantics, Spec forms, and on-demand validation.
#
# Nothing here builds instances; it exercises Schemas.OfX.Builder and Schemas.OfX.Data.validate().

from mbse_schemas.Framework import Schemas
from mbse_schemas.Examples._support import raises

# --- Spec forms ---

# A native Spec is a type directly, or a callable that takes and returns an OfNative.Builder.
direct = Schemas.OfAny.Builder().as_native(str).create()
configured = Schemas.OfAny.Builder().as_native(lambda n: n.type(str)).create()
assert direct == configured == Schemas.OfNative.Data(str)

# Finalizing an OfAny builder yields the selected kind's data, not a wrapper.
assert type(direct) is Schemas.OfNative.Data

# An OfAny Spec may also be existing schema data, reused as is (not copied).
Text = Schemas.OfNative.Data(str)
Named = (
    Schemas.OfObject.Builder()
    .properties(
        lambda prop: prop.name('first').of(Text),
        lambda prop: prop.name('last').of(Text),
    )
    .create()
)
assert Named.properties['first'] is Text and Named.properties['last'] is Text

# An OfAny builder with no kind selected cannot be finalized.
with raises(ValueError):
    Schemas.OfAny.Builder().create()

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
    .properties(lambda prop: prop.name('a').of(lambda t: t.as_native(int)))
    .clone()
)
assert Retyped.properties['a'] == Schemas.OfNative.Data(int) and first.properties['a'] is Text

# --- Relations and cardinality ---

# A map a -> [key] -> b: a relation with links a, b and property key. ISO 4217 currency codes as keys.
Product = Schemas.OfObject.Builder().properties(lambda prop: prop.name('sku').of(Text)).create()
Money = (
    Schemas.OfObject.Builder()
    .properties(lambda prop: prop.name('minor_units').of(lambda t: t.as_native(int)))  # e.g. cents
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

# Pure ownership and a directory keyed within its parent, written as in Framework.md.
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
OneLink = Schemas.OfRelation.Builder().links('contact').create()
assert any('one-link' in p for p in OneLink.validate())

Clash = (
    Schemas.OfRelation.Builder()
    .links('owner', 'item')
    .properties(lambda prop: prop.name('item').of(Text))
    .create()
)
assert any('both link and property' in p for p in Clash.validate())

DuplicateLinks = Schemas.OfRelation.Builder().links('node', 'node').create()
assert any('duplicate link' in p for p in DuplicateLinks.validate())

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
    assert Schemas.OfNative.Data(unsupported).validate()  # type: ignore  # deliberate misuse
    bad = Schemas.OfObject.Builder().properties(lambda prop: prop.name('x').of(lambda t: t.as_native(unsupported))).create()
    assert bad.validate(), unsupported

# --- Singletons ---

Registry = Schemas.OfObject.Builder().singleton('iso3166.Registry').create()
assert Registry.singleton == 'iso3166.Registry' and Registry.validate() == []

# --- Unions and intersections (schema level) ---
#
# Discriminator predicates are serializable expressions; Expressions is not implemented yet, so these are placeholders.

Phone = Schemas.OfObject.Builder().properties(lambda prop: prop.name('number').of(Text)).create()
Email = Schemas.OfObject.Builder().properties(lambda prop: prop.name('address').of(Text)).create()

ContactMethod = (
    Schemas.OfUnion.Builder()
    .branches(
        lambda b: b.of(Phone).when(('has', 'number')),
        lambda b: b.of(Email).when(('has', 'address')),
    )
    .create()
)
assert ContactMethod.validate() == []

MissingPredicate = Schemas.OfUnion.Builder().branches(lambda b: b.of(Phone), lambda b: b.of(Email)).create()
assert any('no discriminator' in p for p in MissingPredicate.validate())

MixedKinds = (
    Schemas.OfUnion.Builder()
    .branches(lambda b: b.of(Phone).when(('has', 'number')), lambda b: b.of(Text).when(('is', 'str')))
    .create()
)
assert any('same kind' in p for p in MixedKinds.validate())

SingleBranch = Schemas.OfUnion.Builder().branches(lambda b: b.of(Phone).when(('has', 'number'))).create()
assert any('at least two' in p for p in SingleBranch.validate())

# Intersections combine same-kind schemas; the same property with the same type is fine, different types conflict.
Timestamped = Schemas.OfObject.Builder().properties(lambda prop: prop.name('updated').of(Text)).create()
Audited = (
    Schemas.OfObject.Builder()
    .properties(
        lambda prop: prop.name('updated').of(lambda t: t.as_native(str)),  # equal to Text, not the same object
        lambda prop: prop.name('updated_by').of(Text),
    )
    .create()
)
assert Schemas.OfIntersection.Builder().of(Timestamped, Audited).create().validate() == []

EpochStamped = Schemas.OfObject.Builder().properties(lambda prop: prop.name('updated').of(lambda t: t.as_native(int))).create()
Conflicting = Schemas.OfIntersection.Builder().of(Timestamped, EpochStamped).create()
assert any('conflicting' in p for p in Conflicting.validate())

assert Schemas.OfIntersection.Builder().of(Timestamped, Text).create().validate()  # mixed kinds

print('SchemaRules: all checks passed')
