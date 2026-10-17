# Serialization example: scalar values at their edges, strict scalar types, malformed snapshots, and a store.
#
# Uses ISO 4217 currencies: a price list maps a product -> [currency] -> money.

import json
import math

from mbse.Schemas.Framework import Builders, Schemas, Plain, Validators
from mbse.Schemas.Framework.Errors import DecodeError
from mbse.Schemas.Examples._support import entries, raises


store = Builders.Store()
Text, Int = store.Schemas.OfStr.as_schema(), store.Schemas.OfInt.as_schema()  # the store's own

# --- Schemas ---

Sample = store.Schemas.OfObject(lambda o: (
    o
    .name('Sample')
    .ref(True)
    .properties([
        lambda t: t.name('label').schema([Text]),
        lambda t: t.name('payload').schema([store.Schemas.OfBytes]),
        lambda t: t.name('count').schema([Int]),
        lambda t: t.name('ratio').schema([store.Schemas.OfFloat]),
        lambda t: t.name('flag').schema([store.Schemas.OfBool]),
    ])
))

# Registered names are strings and need not be identifiers: a dotted name is a path from the store.
Currency = store.Schemas.OfObject(lambda o: (
    o
    .name('iso4217.Currency')
    .ref(True)
    .properties([
        lambda t: t.name('code').schema([Text]),  # ISO 4217 alpha, e.g. 'JPY'
        lambda t: t.name('numeric').schema([Text]),  # ISO 4217 numeric, e.g. '392'; keeps zeros
        lambda t: t.name('minor_units').schema([Int]),  # 0 for JPY, 2 for EUR, 3 for BHD
    ])
))
Product = store.Schemas.OfObject(lambda o: o.name('Product').ref(True).properties([lambda t: t.name('sku').schema([Text])]))
Money = store.Schemas.OfObject(lambda o: (
    o
    .name('Money')
    .ref(True)
    .properties([lambda t: t.name('amount').schema([Int])])  # in minor units
))

# product -> [currency] -> money
Prices = store.Schemas.OfRelation(lambda r: (
    r
    .name('Prices')
    .links([
        lambda t: t.name('product'),
        lambda t: t.name('price'),
    ])
    .properties([lambda t: t.name('currency').schema([Text])])
    .uniques('price')
))
# Which currency a money amount is in.
Denomination = store.Schemas.OfRelation(lambda r: (
    r
    .name('Denomination')
    .links([
        lambda t: t.name('money'),
        lambda t: t.name('currency'),
    ])
    .uniques('currency')
))

store.Schemas.OfObject(Product, lambda o: o.adjacencies([lambda t: t.name('prices').relation([Prices]).me('product')]))
store.Schemas.OfObject(Money, lambda o: o.adjacencies([
    lambda t: t.name('products').relation([Prices]).me('price'),
    lambda t: t.name('currency').relation([Denomination]).me('money'),
]))
store.Schemas.OfObject(Currency, lambda o: o.adjacencies([lambda t: t.name('amounts').relation([Denomination]).me('currency')]))

for schema in [Sample, Currency, Product, Money, Prices, Denomination]:
    assert schema.validate() == [], (schema.name, schema.validate())
    assert store.registered(schema.name) is schema

# --- Scalar values at their edges ---

edge = store.Sample(lambda s: (
    s
    .label('日本語 🚀 \u0000 "quoted" \\ back')  # non-ASCII, emoji, NUL, quotes, backslash
    .payload(b'\x00\xff\x10' * 3)
    .count(2**100)  # Python ints are unbounded
    .ratio(-0.0)
    .flag(False)  # a present False is not an absent property
))
plain = Plain.ToPlain(store)(Sample, edge)
fields = plain['objects'][0]['properties']  # the root, listed first
assert fields['payload'] == 'AP8QAP8QAP8Q'  # bytes become base64 text
assert fields['flag'] is False and fields['count'] == 2**100

# Plain data is JSON-encodable, and survives a JSON round trip.
restored = Plain.FromPlain(store)(Sample, json.loads(json.dumps(plain)))
assert restored.label.get() == edge.label.get() and bytes(restored.payload) == bytes(edge.payload) and int(restored.count) == 2**100
assert float(restored.ratio) == 0.0 and math.copysign(1, float(restored.ratio)) < 0  # the sign of -0.0 survives
assert restored.flag.get() is False

# Empty values are present values.
empty = store.Sample(lambda s: s.label('').payload(b'').count(0).ratio(0.0))
back = Plain.FromPlain(store)(Sample, Plain.ToPlain(store)(Sample, empty))
assert (back.label.get(), back.payload.get(), back.count.get(), back.ratio.get()) == ('', b'', 0, 0.0)
assert back.flag.get() is None  # never set, so absent

# An object with nothing set serializes to empty properties, listed with its path and its schema's name.
blank = store.Sample(lambda s: s)
path = Plain.ToPlain(store)(store.Paths.OfRoot.as_schema(), blank.as_identity())
assert Plain.ToPlain(store)(Sample, blank) == {'root': path, 'objects': [{'path': path, 'schema': 'Sample', 'properties': {}}]}

# Per-kind entry points.
assert Plain.ToPlain(store)(store.Schemas.OfBytes.as_schema(), b'\x01') == Plain.ToPlain(store).OfScalar(store.Schemas.OfBytes.as_schema(), b'\x01') == 'AQ=='
assert Plain.FromPlain(store).OfScalar(store.Schemas.OfInt.as_schema(), 7) == 7

# --- Strict scalar types ---

# Distinct scalar types are never coerced into each other, in either direction. Reading a wrong type is a problem in
# the data: a DecodeError (a ValueError) located by a path, here the root.
from_plain = Plain.FromPlain(store)
for scalar, bad in [(int, True), (int, 1.0), (int, '1'), (float, 1), (bool, 0), (str, b'x'), (str, None)]:
    with raises(DecodeError):
        from_plain(Schemas.OfScalar.Data(scalar), bad)
with raises(DecodeError):
    from_plain(store.Schemas.OfBytes.as_schema(), b'raw')  # bytes arrive as base64 text
with raises(DecodeError):
    from_plain(store.Schemas.OfBytes.as_schema(), 'not base64!')

# The builder does not validate; the serializer does.
sloppy = store.Sample(lambda s: s.count('3'))
assert sloppy.count.get() == '3'
with raises(TypeError):
    Plain.ToPlain(store)(Sample, sloppy)

# Validation reports it without serializing.
validate = Validators.Validate(store)
assert validate(Sample, sloppy) == ['Sample#0.count: expected int, got str']
assert validate(Sample, edge) == [] and validate(Sample, blank) == []
assert validate(store.Schemas.OfInt.as_schema(), True) == ['expected int, got bool']

# --- A map: product -> [currency] -> money ---

jpy = store.iso4217.Currency(lambda c: c.code('JPY').numeric('392').minor_units(0))
eur = store.iso4217.Currency(lambda c: c.code('EUR').numeric('978').minor_units(2))
widget = store.Product(lambda p: (
    p
    .sku('W-1')
    .prices(lambda a: a.insert(lambda x: x.price(lambda m: m.amount(1500).currency(lambda a: a.insert(lambda d: d.currency(jpy)))).currency('JPY')))
    .prices(lambda a: a.insert(lambda x: x.price(lambda m: m.amount(1299).currency(lambda a: a.insert(lambda d: d.currency(eur)))).currency('EUR')))
))
by_currency = {e['currency']: int(e['price'].amount) for e in entries(Product, widget, 'prices')}
assert by_currency == {'JPY': 1500, 'EUR': 1299}

graph = Plain.ToPlain(store).Reachable(Product, widget)
assert sorted(o['properties'].get('code') for o in graph['objects'] if 'code' in o['properties']) == ['EUR', 'JPY']
assert {o['schema'] for o in graph['objects']} == {'Product', 'Money', 'iso4217.Currency'}  # each listed with its schema
again = from_plain.Reachable(Product, json.loads(json.dumps(graph)))
assert {e['currency']: int(e['price'].amount) for e in entries(Product, again, 'prices')} == by_currency

assert validate.Reachable(Product, widget) == []

# uniques('price') on Prices: (product, currency) determine the price. A second JPY price breaks it.
gadget = store.Product(lambda p: (
    p
    .sku('G-1')
    .prices(lambda a: a.insert(lambda x: x.price(lambda m: m.amount(900)).currency('JPY')))
    .prices(lambda a: a.insert(lambda x: x.price(lambda m: m.amount(950)).currency('JPY')))
))
assert validate(Product, gadget) == ['unique(price) violated: entries agreeing on [\'currency\', \'product\'] differ on [\'price\']']

# The root must be an instance of the schema given.
assert validate(Currency, widget) != []

# --- Malformed snapshots are rejected ---

good = Plain.ToPlain(store).Reachable(Product, widget)
root = good['root']


def listed(snapshot, path):
    """The object a snapshot lists at `path`."""
    return next(o for o in snapshot['objects'] if o['path'] == path)


price_ref = listed(good, root)['properties']['prices'][0]['price']


def mutated(change):
    snapshot = json.loads(json.dumps(good))
    change(snapshot)
    return snapshot


bad_snapshots = [
    [],  # not a snapshot
    {'root': root},  # no objects
    {'root': {'singleton': 'nope', 'next': {'target': {}}}, 'objects': good['objects']},  # root not in objects
    mutated(lambda s: s['objects'].remove(listed(s, price_ref['$ref']))),  # unresolved reference
    mutated(lambda s: listed(s, price_ref['$ref']).update(schema='Product')),  # its path is not its schema's
    mutated(lambda s: s['objects'].append(listed(s, root))),  # an object listed twice
    mutated(lambda s: listed(s, root)['properties'].__setitem__('colour', 'red')),  # not a property or adjacency
    mutated(lambda s: listed(s, root)['properties']['prices'][0].__setitem__('discount', 5)),  # not a link or property
]
for snapshot in bad_snapshots:
    with raises(DecodeError):
        from_plain.Reachable(Product, snapshot)

# A single-object snapshot leaves references unresolved, so it cannot be deserialized on its own.
with raises(DecodeError):
    from_plain(Product, Plain.ToPlain(store)(Product, widget))

# The root must be an instance of the schema given.
with raises(TypeError):
    Plain.ToPlain(store)(Currency, widget)

# --- Store corner cases ---

with raises(ValueError):
    store.Schemas.OfObject(lambda o: o.name('Sample'))  # a named schema's identity is its name, which Sample holds
with raises(AttributeError):
    store.Unregistered(lambda u: u)
with raises(TypeError):
    store.Product()  # a callback, an object and a callback, or an object
with raises(TypeError):
    store.Prices(lambda p: p)  # no relation builder is exposed
with raises(TypeError):
    store.Product(jpy)  # the source instance must have the builder's schema
with raises(TypeError):
    store.Product(lambda p: p.colour('red'))  # not a property or adjacency: it reads as empty, and refuses a write
with raises(AttributeError):
    widget.sku = 'W-2'  # instances are read-only

# A schema named 'schema' is shadowed by the store's schema() method, but still reachable by name.
Shadowed = store.Schemas.OfObject(lambda o: o.name('schema').ref(True).properties([lambda t: t.name('label').schema([Text])]))
assert store.schema('schema') is Shadowed and store.builder('schema').create().as_schema().name == 'schema'

print('Serialization: all checks passed')
