# Address book example
#
# Lines marked PROPOSED use syntax that FRAMEWORK.md does not define yet.

from mbse.Schemas.Framework import Builders, Schemas, Plain, JSON


# Schemas and objects are built in a store, `store.<schema name>(...)`; a named schema registers itself as it is built.
store = Builders.Store()
Text = store.Schemas.OfStr.as_schema()  # the store's own basic scalar

# --- Schemas ---

IntlAddress = store.Schemas.OfObject(lambda o: (
    o
    .name('IntlAddress')
    .ref(True)
    .properties([
        lambda t: t.name('street1').schema([Text]),
        lambda t: t.name('street2').schema([Text]),
        lambda t: t.name('street3').schema([Text]),
        lambda t: t.name('dependent_locality').schema([Text]),  # neighborhood, district
        lambda t: t.name('locality').schema([Text]),  # city, town, post town
        lambda t: t.name('administrative_area').schema([Text]),  # state, province, prefecture
        lambda t: t.name('postal_code').schema([Text]),
        lambda t: t.name('sorting_code').schema([Text]),  # e.g. French CEDEX
        lambda t: t.name('country_code').schema([Text]),  # ISO 3166-1 alpha-2
    ])
))

Contact = store.Schemas.OfObject(lambda o: (
    o
    .name('Contact')
    .ref(True)
    .properties([
        lambda t: t.name('given_name').schema([Text]),
        lambda t: t.name('family_name').schema([Text]),
        lambda t: t.name('birth_date').schema([Text]),  # ISO 8601 calendar date, YYYY-MM-DD
        lambda t: t.name('preferred_language').schema([Text]),  # BCP 47 tag, e.g. 'fr-CA'
    ])
))

PhoneNumber = store.Schemas.OfObject(lambda o: (
    o
    .name('PhoneNumber')
    .ref(True)
    .properties([
        lambda t: t.name('number').schema([Text]),  # ITU-T E.164, e.g. '+14155550100'
    ])
))

EmailAddress = store.Schemas.OfObject(lambda o: (
    o
    .name('EmailAddress')
    .ref(True)
    .properties([
        lambda t: t.name('address').schema([Text]),  # RFC 5322 addr-spec
    ])
))

# Collections are relations. Links are untyped; each object declares its adjacencies below.

ContactAddresses = store.Schemas.OfRelation(lambda r: (
    r
    .name('ContactAddresses')
    .links([
        lambda t: t.name('contact'),
        lambda t: t.name('address'),
    ])
    .properties([
        lambda t: t.name('label').schema([Text]),  # e.g. 'home', 'work'
    ])
))

ContactPhones = store.Schemas.OfRelation(lambda r: (
    r
    .name('ContactPhones')
    .links([
        lambda t: t.name('contact'),
        lambda t: t.name('phone'),
    ])
    .properties([
        lambda t: t.name('label').schema([Text]),  # e.g. 'mobile', 'work'
    ])
))

ContactEmails = store.Schemas.OfRelation(lambda r: (
    r
    .name('ContactEmails')
    .links([
        lambda t: t.name('contact'),
        lambda t: t.name('email'),
    ])
    .properties([
        lambda t: t.name('label').schema([Text]),  # e.g. 'personal', 'work'
    ])
))

# A schema and a callback: the schema, updated in place.
store.Schemas.OfObject(Contact, lambda o: o.adjacencies([
    lambda t: t.name('addresses').relation([ContactAddresses]).me('contact'),
    lambda t: t.name('phones').relation([ContactPhones]).me('contact'),
    lambda t: t.name('emails').relation([ContactEmails]).me('contact'),
]))
store.Schemas.OfObject(IntlAddress, lambda o: o.adjacencies([
    lambda t: t.name('contacts').relation([ContactAddresses]).me('address'),
]))
store.Schemas.OfObject(PhoneNumber, lambda o: o.adjacencies([
    lambda t: t.name('contacts').relation([ContactPhones]).me('phone'),
]))
store.Schemas.OfObject(EmailAddress, lambda o: o.adjacencies([
    lambda t: t.name('contacts').relation([ContactEmails]).me('email'),
]))

# --- Building forms ---

# "create": a callback builds a new object
addr1 = store.IntlAddress(lambda a: (
    a
    .street1('10 Downing Street')
    .street2('bar')
    .street3('Whitehall')
    .locality('London')
    .postal_code('SW1A 2AA')
    .country_code('GB')
))

# "update": the object and a callback write into the object, and return it
updated = store.IntlAddress(addr1, lambda a: a.street2(lambda p: p.as_scalar(lambda v: v.set('baz'))))  # .street2('baz')
assert updated is addr1
assert str(addr1.street2) == 'baz'

# "clone": the object alone returns a new object, and leaves the source untouched
cloned = store.IntlAddress(store.IntlAddress(addr1), lambda a: a.street2('shoe'))
assert cloned is not addr1
assert str(cloned.street2) == 'shoe'
assert str(addr1.street2) == 'baz'

# clearing a property makes it absent; an absent property's value reads as None
store.IntlAddress(addr1, lambda a: a.street3(lambda p: p.as_value(lambda v: v.clear())))
assert addr1.street3.get() is None

# a property that was never set reads as None too
assert addr1.sorting_code.get() is None

# traditional property access (read only)
print(f"{addr1.street1}, {addr1.locality} {addr1.postal_code}, {addr1.country_code}")

# --- Relations ---

# Entries are inserted through the object builder's adjacencies, `insert` taking a Spec for the entry: the object
# fills its own link ('contact'); the entry builder sets the other links and the entry properties. A link takes an
# existing object or a Spec that builds a new one.
alice = store.Contact(lambda c: (
    c
    .given_name('Alice')
    .family_name('Liddell')
    .birth_date('1852-05-04')
    .preferred_language('en-GB')
    .addresses(lambda a: a.insert(lambda x: x.address(addr1).label('work')))
    .phones(lambda a: a.insert(lambda x: x.phone(lambda y: y.number('+447700900123')).label('mobile')))
    .emails(lambda a: a.insert(lambda x: x.email(lambda y: y.address('alice@example.org')).label('personal')))
))

# --- Serialization ---

# A single-object snapshot includes addr1's adjacencies, so it references alice by key without containing her.
# Deserializing it on its own is an error: the reference cannot be resolved.
plain = Plain.ToPlain(store)(IntlAddress, addr1)
# equivalent to
# plain = Plain.ToPlain(store).OfObject(IntlAddress, addr1)

# PROPOSED: a snapshot of addr1 and every object reachable through adjacencies (alice, her phone and email), so all
# references resolve within the snapshot. Each object is keyed by its identity, qualified by its schema's name.
graph = Plain.ToPlain(store).Reachable(IntlAddress, addr1)
assert graph['root'] == f'IntlAddress/{addr1.as_identity()}'

# Read into another store, the snapshot builds objects of the same identities there.
backup = Builders.Store()
Plain.FromPlain(backup).Snapshot(Plain.ToPlain(store).Snapshot())  # the same schemas, its own: a store's snapshot writes them
roundtrip = Plain.FromPlain(backup).Reachable(backup.IntlAddress, graph)
assert roundtrip is not addr1 and roundtrip.as_identity() == addr1.as_identity()
assert Plain.ToPlain(backup).Reachable(backup.IntlAddress, roundtrip) == graph

# Read into the store that holds them, it updates them through their builders: what it omits, they keep.
assert Plain.FromPlain(store).Reachable(IntlAddress, graph) is addr1

# The same snapshot as JSON text, and back.
text = JSON.ToJSON(store).Reachable(IntlAddress, addr1, indent=2)
from_json = JSON.FromJSON(backup).Reachable(backup.IntlAddress, text)
assert from_json is roundtrip and str(from_json.street1) == str(addr1.street1)  # the backup's, updated
assert JSON.loads(text) == graph
