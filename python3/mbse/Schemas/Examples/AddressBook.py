# Address book example
#
# Lines marked PROPOSED use syntax that FRAMEWORK.md does not define yet.

from mbse.Schemas.Framework import Schemas, Proxies, Plain, JSON

store = Proxies.OfStore()

# --- Schemas ---

IntlAddress = (
    Schemas.OfObject.Builder().name('IntlAddress').ref()
    .properties(
        lambda prop: prop.name('street1').of(lambda t: t.as_native(str)),
        lambda prop: prop.name('street2').of(lambda t: t.as_native(str)),
        lambda prop: prop.name('street3').of(lambda t: t.as_native(str)),
        lambda prop: prop.name('dependent_locality').of(lambda t: t.as_native(str)),  # neighborhood, district
        lambda prop: prop.name('locality').of(lambda t: t.as_native(str)),  # city, town, post town
        lambda prop: prop.name('administrative_area').of(lambda t: t.as_native(str)),  # state, province, prefecture
        lambda prop: prop.name('postal_code').of(lambda t: t.as_native(str)),
        lambda prop: prop.name('sorting_code').of(lambda t: t.as_native(str)),  # e.g. French CEDEX
        lambda prop: prop.name('country_code').of(lambda t: t.as_native(str)),  # ISO 3166-1 alpha-2
    )
    .create()
)

Contact = (
    Schemas.OfObject.Builder().name('Contact').ref()
    .properties(
        lambda prop: prop.name('given_name').of(lambda t: t.as_native(str)),
        lambda prop: prop.name('family_name').of(lambda t: t.as_native(str)),
        lambda prop: prop.name('birth_date').of(lambda t: t.as_native(str)),  # ISO 8601 calendar date, YYYY-MM-DD
        lambda prop: prop.name('preferred_language').of(lambda t: t.as_native(str)),  # BCP 47 tag, e.g. 'fr-CA'
    )
    .create()
)

PhoneNumber = (
    Schemas.OfObject.Builder().name('PhoneNumber').ref()
    .properties(
        lambda prop: prop.name('number').of(lambda t: t.as_native(str)),  # ITU-T E.164, e.g. '+14155550100'
    )
    .create()
)

EmailAddress = (
    Schemas.OfObject.Builder().name('EmailAddress').ref()
    .properties(
        lambda prop: prop.name('address').of(lambda t: t.as_native(str)),  # RFC 5322 addr-spec
    )
    .create()
)

# Collections are relations. Links are untyped; each object declares its adjacencies below.

ContactAddresses = (
    Schemas.OfRelation.Builder().name('ContactAddresses')
    .links('contact', 'address')
    .properties(
        lambda prop: prop.name('label').of(lambda t: t.as_native(str)),  # e.g. 'home', 'work'
    )
    .create()
)

ContactPhones = (
    Schemas.OfRelation.Builder().name('ContactPhones')
    .links('contact', 'phone')
    .properties(
        lambda prop: prop.name('label').of(lambda t: t.as_native(str)),  # e.g. 'mobile', 'work'
    )
    .create()
)

ContactEmails = (
    Schemas.OfRelation.Builder().name('ContactEmails')
    .links('contact', 'email')
    .properties(
        lambda prop: prop.name('label').of(lambda t: t.as_native(str)),  # e.g. 'personal', 'work'
    )
    .create()
)

Contact = (
    Schemas.OfObject.Builder(Contact)
    .relations(
        lambda adj: adj.name('addresses').of(ContactAddresses).me('contact'),
        lambda adj: adj.name('phones').of(ContactPhones).me('contact'),
        lambda adj: adj.name('emails').of(ContactEmails).me('contact'),
    )
    .update()
)

IntlAddress = (
    Schemas.OfObject.Builder(IntlAddress)
    .relations(
        lambda adj: adj.name('contacts').of(ContactAddresses).me('address')
    )
    .update()
)

PhoneNumber = (
    Schemas.OfObject.Builder(PhoneNumber)
    .relations(
        lambda adj: adj.name('contacts').of(ContactPhones).me('phone')
    )
    .update()
)

EmailAddress = (
    Schemas.OfObject.Builder(EmailAddress)
    .relations(
        lambda adj: adj.name('contacts').of(ContactEmails).me('email')
    )
    .update()
)

store.register(IntlAddress)
store.register(Contact)
store.register(PhoneNumber)
store.register(EmailAddress)
store.register(ContactAddresses)
store.register(ContactPhones)
store.register(ContactEmails)

# --- Builder forms ---

# fluent "create" form
addr1 = (
    store.IntlAddress()
    .street1('10 Downing Street')
    .street2('bar')
    .street3('Whitehall')
    .locality('London')
    .postal_code('SW1A 2AA')
    .country_code('GB')
    .create()
)

# fluent "update" form: writes back into the source and returns it
updated = (
    store.IntlAddress(addr1)
    .street2(lambda v: v.set('baz'))  # equivalent to .street2('baz')
    .update()
)
assert updated is addr1
assert addr1.street2 == 'baz'

# fluent "clone" form: returns a new object and leaves the source untouched
cloned = (
    store.IntlAddress(addr1)
    .street2('shoe')
    .clone()
)
assert cloned is not addr1
assert cloned.street2 == 'shoe'
assert addr1.street2 == 'baz'

# clearing a property makes it absent; an absent property reads as None
store.IntlAddress(addr1).street3(lambda v: v.clear()).update()
assert addr1.street3 is None

# a property that was never set reads as None too
assert addr1.sorting_code is None

# traditional property access (read only)
print(f"{addr1.street1}, {addr1.locality} {addr1.postal_code}, {addr1.country_code}")

# --- Relations ---

# Entries are added through the object builder's adjacency accessors, which take a Spec for the entry: the object
# fills its own link ('contact'); the entry builder sets the other links and the entry properties. A link takes an
# existing object or a Spec that builds a new one.
alice = (
    store.Contact()
    .given_name('Alice')
    .family_name('Liddell')
    .birth_date('1852-05-04')
    .preferred_language('en-GB')
    .addresses(lambda x: x.address(addr1).label('work'))
    .phones(lambda x: x.phone(lambda y: y.number('+447700900123')).label('mobile'))
    .emails(lambda x: x.email(lambda y: y.address('alice@example.org')).label('personal') )
    .create()
)

# --- Serialization ---

# A single-object snapshot includes addr1's adjacencies, so it references alice by symbol without containing her.
# Deserializing it on its own is an error: the reference cannot be resolved.
plain = Plain.ToPlain(store)(IntlAddress, addr1)
# equivalent to
# plain = Plain.ToPlain(store).OfObject(IntlAddress, addr1)

# PROPOSED: a snapshot of addr1 and every object reachable through adjacencies (alice, her phone and email), so all
# symbol references resolve within the snapshot.
graph = Plain.ToPlain(store).Reachable(IntlAddress, addr1)
roundtrip = Plain.FromPlain(store).Reachable(IntlAddress, graph)
assert roundtrip is not addr1
assert Plain.ToPlain(store).Reachable(IntlAddress, roundtrip) == graph

# The same snapshot as JSON text, and back.
text = JSON.ToJSON(store).Reachable(IntlAddress, addr1, indent=2)
from_json = JSON.FromJSON(store).Reachable(IntlAddress, text)
assert from_json is not addr1 and from_json.street1 == addr1.street1
assert JSON.loads(text) == graph
