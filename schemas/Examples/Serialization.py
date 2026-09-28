# Serialization example: native values at their edges, strict native types, malformed snapshots, and the registry.
#
# Uses ISO 4217 currencies: a price list maps a product -> [currency] -> money.

import json
import math

from schemas.Framework import Schemas, Proxies, Plain
from schemas.Examples._support import entries, raises

# --- Schemas ---

Sample = (
    Schemas.OfObject.Builder()
    .properties(
        lambda prop: prop.name('label').of(lambda t: t.as_native(str)),
        lambda prop: prop.name('payload').of(lambda t: t.as_native(bytes)),
        lambda prop: prop.name('count').of(lambda t: t.as_native(int)),
        lambda prop: prop.name('ratio').of(lambda t: t.as_native(float)),
        lambda prop: prop.name('flag').of(lambda t: t.as_native(bool)),
    )
    .create()
)

Currency = (
    Schemas.OfObject.Builder()
    .properties(
        lambda prop: prop.name('code').of(lambda t: t.as_native(str)),  # ISO 4217 alpha, e.g. 'JPY'
        lambda prop: prop.name('numeric').of(lambda t: t.as_native(str)),  # ISO 4217 numeric, e.g. '392'; keeps zeros
        lambda prop: prop.name('minor_units').of(lambda t: t.as_native(int)),  # 0 for JPY, 2 for EUR, 3 for BHD
    )
    .create()
)
Product = Schemas.OfObject.Builder().properties(lambda prop: prop.name('sku').of(lambda t: t.as_native(str))).create()
Money = (
    Schemas.OfObject.Builder()
    .properties(lambda prop: prop.name('amount').of(lambda t: t.as_native(int)))  # in minor units
    .create()
)

# product -> [currency] -> money
Prices = (
    Schemas.OfRelation.Builder()
    .links('product', 'price')
    .properties(lambda prop: prop.name('currency').of(lambda t: t.as_native(str)))
    .unique('price')
    .create()
)
# Which currency a money amount is in.
Denomination = Schemas.OfRelation.Builder().links('money', 'currency').unique('currency').create()

Product = Schemas.OfObject.Builder(Product).relations(lambda adj: adj.name('prices').of(Prices).me('product')).update()
Money = (
    Schemas.OfObject.Builder(Money)
    .relations(
        lambda adj: adj.name('products').of(Prices).me('price'),
        lambda adj: adj.name('currency').of(Denomination).me('money'),
    )
    .update()
)
Currency = Schemas.OfObject.Builder(Currency).relations(lambda adj: adj.name('amounts').of(Denomination).me('currency')).update()

# Registered names are strings and need not be identifiers.
for name, schema in [('Sample', Sample), ('iso4217.Currency', Currency), ('Product', Product), ('Money', Money),
                     ('Prices', Prices), ('Denomination', Denomination)]:
    assert schema.validate() == [], (name, schema.validate())
    Proxies.register(name, schema)
Builders = Proxies.Builders

# --- Native values at their edges ---

edge = (
    Builders.Sample()
    .label('日本語 🚀 \u0000 "quoted" \\ back')  # non-ASCII, emoji, NUL, quotes, backslash
    .payload(b'\x00\xff\x10' * 3)
    .count(2**100)  # Python ints are unbounded
    .ratio(-0.0)
    .flag(False)  # a present False is not an absent property
    .create()
)
plain = Plain.ToPlain(Sample, edge)
fields = plain['objects'][plain['root']]
assert fields['payload'] == 'AP8QAP8QAP8Q'  # bytes become base64 text
assert fields['flag'] is False and fields['count'] == 2**100

# Plain data is JSON-encodable, and survives a JSON round trip.
restored = Plain.FromPlain(Proxies.Builders)(Sample, json.loads(json.dumps(plain)))
assert restored.label == edge.label and restored.payload == edge.payload and restored.count == 2**100
assert restored.ratio == 0.0 and math.copysign(1, restored.ratio) < 0  # the sign of -0.0 survives
assert restored.flag is False

# Empty values are present values.
empty = Builders.Sample().label('').payload(b'').count(0).ratio(0.0).create()
back = Plain.FromPlain(Proxies.Builders)(Sample, Plain.ToPlain(Sample, empty))
assert (back.label, back.payload, back.count, back.ratio) == ('', b'', 0, 0.0)
with raises(AttributeError):
    back.flag  # never set, so absent

# An object with nothing set serializes to an empty object.
blank = Builders.Sample().create()
assert Plain.ToPlain(Sample, blank) == {'root': 's0', 'objects': {'s0': {}}}

# Per-kind entry points.
assert Plain.ToPlain(Schemas.OfNative.Data(bytes), b'\x01') == Plain.ToPlain.OfNative(Schemas.OfNative.Data(bytes), b'\x01') == 'AQ=='
assert Plain.FromPlain(Proxies.Builders).OfNative(Schemas.OfNative.Data(int), 7) == 7

# --- Strict native types ---

# Distinct native types are never coerced into each other, in either direction.
from_plain = Plain.FromPlain(Proxies.Builders)
for native, bad in [(int, True), (int, 1.0), (int, '1'), (float, 1), (bool, 0), (str, b'x'), (str, None)]:
    with raises(TypeError):
        from_plain(Schemas.OfNative.Data(native), bad)
with raises(TypeError):
    from_plain(Schemas.OfNative.Data(bytes), b'raw')  # bytes arrive as base64 text
with raises(ValueError):
    from_plain(Schemas.OfNative.Data(bytes), 'not base64!')

# The builder does not validate; the serializer does.
sloppy = Builders.Sample().count('3').create()
assert sloppy.count == '3'
with raises(TypeError):
    Plain.ToPlain(Sample, sloppy)

# --- A map: product -> [currency] -> money ---

jpy = getattr(Builders, 'iso4217.Currency')().code('JPY').numeric('392').minor_units(0).create()
eur = getattr(Builders, 'iso4217.Currency')().code('EUR').numeric('978').minor_units(2).create()
widget = (
    Builders.Product()
    .sku('W-1')
    .prices(lambda x: x.price(lambda m: m.amount(1500).currency(lambda d: d.currency(jpy))).currency('JPY'))
    .prices(lambda x: x.price(lambda m: m.amount(1299).currency(lambda d: d.currency(eur))).currency('EUR'))
    .create()
)
by_currency = {e['currency']: e['price'].amount for e in entries(Product, widget, 'prices')}
assert by_currency == {'JPY': 1500, 'EUR': 1299}

graph = Plain.ToPlain.Reachable(Product, widget)
assert sorted(o.get('code') for o in graph['objects'].values() if 'code' in o) == ['EUR', 'JPY']
schemas_named = {ref['$schema'] for obj in graph['objects'].values() for v in obj.values() if isinstance(v, list)
                 for e in v for ref in e.values() if isinstance(ref, dict)}
assert schemas_named == {'Product', 'Money', 'iso4217.Currency'}
again = from_plain.Reachable(Product, json.loads(json.dumps(graph)))
assert {e['currency']: e['price'].amount for e in entries(Product, again, 'prices')} == by_currency

# --- Malformed snapshots are rejected ---

good = Plain.ToPlain.Reachable(Product, widget)
root = good['root']
price_ref = good['objects'][root]['prices'][0]['price']


def mutated(change):
    snapshot = json.loads(json.dumps(good))
    change(snapshot)
    return snapshot


bad_snapshots = [
    [],  # not a snapshot
    {'root': root},  # no objects
    {'root': 'nope', 'objects': good['objects']},  # root not in objects
    mutated(lambda s: s['objects'].pop(price_ref['$ref'])),  # unresolved reference
    mutated(lambda s: s['objects'][root]['prices'][1].update(price={'$ref': price_ref['$ref'], '$schema': 'Product'})),
    mutated(lambda s: s['objects'].__setitem__('s99', {'sku': 'orphan'})),  # an object nothing references
    mutated(lambda s: s['objects'][root].__setitem__('colour', 'red')),  # not a property or adjacency
    mutated(lambda s: s['objects'][root]['prices'][0].__setitem__('discount', 5)),  # not a link or property
]
for snapshot in bad_snapshots:
    with raises(ValueError):
        from_plain.Reachable(Product, snapshot)

# A single-object snapshot leaves references unresolved, so it cannot be deserialized on its own.
with raises(ValueError):
    from_plain(Product, Plain.ToPlain(Product, widget))

# The root must be an instance of the schema given.
with raises(TypeError):
    Plain.ToPlain(Currency, widget)

# --- Registry corner cases ---

with raises(ValueError):
    Proxies.register('Sample', Sample)  # names are registered once
with raises(AttributeError):
    Builders.Unregistered()
with raises(TypeError):
    Builders.Prices()  # no relation builder is exposed
with raises(TypeError):
    Builders.Product(jpy)  # the source instance must have the builder's schema
with raises(AttributeError):
    Builders.Product().colour('red')  # not a property or adjacency
with raises(AttributeError):
    widget.sku = 'W-2'  # instances are read-only

# A schema registered as 'schema' is shadowed by the Builders.schema() method, but still reachable by name.
Proxies.register('schema', Sample)
assert Proxies.schema('schema') is Sample and Builders.schema('schema') is Sample

print('Serialization: all checks passed')
