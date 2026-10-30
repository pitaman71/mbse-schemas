# Address book example
#
# Lines marked PROPOSED use syntax that FRAMEWORK.md does not define yet.

from mbse.Schemas.Framework import Builders, Plain, JSON


# --- Schemas ---


def install(txn):
    """The address book's schemas, defined in the store a transaction writes (`store.transaction(install)`), each found
    by its name, else made. Collections are relations: links are untyped, and each object declares its adjacencies."""
    S = txn.Schemas  # the store's own schemas, by name
    return txn.uid('examples.address_book/1').mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({
            'IntlAddress': S.OfObject, 'Contact': S.OfObject, 'PhoneNumber': S.OfObject, 'EmailAddress': S.OfObject,
            'ContactAddresses': S.OfRelation, 'ContactPhones': S.OfRelation, 'ContactEmails': S.OfRelation,
        })
        .spec([
            lambda _: _.IntlAddress.name('IntlAddress').ref(True).properties({
                'street1': S.OfStr,
                'street2': S.OfStr,
                'street3': S.OfStr,
                'dependent_locality': S.OfStr,  # neighborhood, district
                'locality': S.OfStr,  # city, town, post town
                'administrative_area': S.OfStr,  # state, province, prefecture
                'postal_code': S.OfStr,
                'sorting_code': S.OfStr,  # e.g. French CEDEX
                'country_code': S.OfStr,  # ISO 3166-1 alpha-2
            }).adjacencies({'contacts': lambda a: a.relation([_.ContactAddresses]).me('address')}),
            lambda _: _.Contact.name('Contact').ref(True).properties({
                'given_name': S.OfStr,
                'family_name': S.OfStr,
                'birth_date': S.OfStr,  # ISO 8601 calendar date, YYYY-MM-DD
                'preferred_language': S.OfStr,  # BCP 47 tag, e.g. 'fr-CA'
            }).adjacencies({
                'addresses': lambda a: a.relation([_.ContactAddresses]).me('contact'),
                'phones': lambda a: a.relation([_.ContactPhones]).me('contact'),
                'emails': lambda a: a.relation([_.ContactEmails]).me('contact'),
            }),
            lambda _: _.PhoneNumber.name('PhoneNumber').ref(True).properties({
                'number': S.OfStr,  # ITU-T E.164, e.g. '+14155550100'
            }).adjacencies({'contacts': lambda a: a.relation([_.ContactPhones]).me('phone')}),
            lambda _: _.EmailAddress.name('EmailAddress').ref(True).properties({
                'address': S.OfStr,  # RFC 5322 addr-spec
            }).adjacencies({'contacts': lambda a: a.relation([_.ContactEmails]).me('email')}),
            lambda _: _.ContactAddresses.name('ContactAddresses').links([
                lambda t: t.name('contact'),
                lambda t: t.name('address'),
            ]).properties({'label': S.OfStr}),  # e.g. 'home', 'work'
            lambda _: _.ContactPhones.name('ContactPhones').links([
                lambda t: t.name('contact'),
                lambda t: t.name('phone'),
            ]).properties({'label': S.OfStr}),  # e.g. 'mobile', 'work'
            lambda _: _.ContactEmails.name('ContactEmails').links([
                lambda t: t.name('contact'),
                lambda t: t.name('email'),
            ]).properties({'label': S.OfStr}),  # e.g. 'personal', 'work'
        ])]))])


# Schemas and objects are built in a store, `store.<schema name>(...)`; a module's install defines its schemas there.
store = Builders.Store()
store.transaction(install)  # every write to a store is made within a transaction, all or nothing
IntlAddress = store.registered('IntlAddress')

# --- Building forms ---

with store.transaction():  # the data, as the schemas: written within a transaction, all or nothing
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

# A document is one transaction (object identity 51 in [CAP-128: graphs sent as one-transaction documents](../../../../../mbse-basis/docs/capabilities/CAP-128.md#decided)): the objects it holds are the symbols of one
# upsert, numbered in the order it meets them, the root's "0", and its spec gives each one's properties and entries.
# An object's document holds it alone, so addr1's is refused: alice, whom it links, is counted (neither a singleton nor
# owned), and has no identity beyond the document that writes her.
try:
    Plain.ToPlain(store)(IntlAddress, addr1)  # equivalent to Plain.ToPlain(store).OfObject(IntlAddress, addr1)
    raise AssertionError('a document of addr1 alone would refer to alice, whom it does not hold')
except ValueError:
    pass

# A document of addr1 and every counted object reachable from it (alice, her phone and email), so that every reference
# is to a symbol of the document.
graph = Plain.ToPlain(store).Reachable(IntlAddress, addr1)
assert list(graph['mutations'][0]['upsert']['exists'][0]['symbols'])[0] == '0'  # the root

# Read into another store, the document builds new objects of the same graph there.
backup = Builders.Store()
Plain.FromPlain(backup).Snapshot(Plain.ToPlain(store).Snapshot())  # the same schemas, its own: a store's snapshot writes them
roundtrip = Plain.FromPlain(backup).Reachable(backup.IntlAddress, graph)
assert roundtrip is not addr1
assert Plain.ToPlain(backup).Reachable(backup.IntlAddress, roundtrip) == graph

# Read into the store that holds them, it builds new ones too: a counted object has no identity beyond the document.
assert Plain.FromPlain(store).Reachable(IntlAddress, graph) is not addr1

# The same document as JSON text, and back.
text = JSON.ToJSON(store).Reachable(IntlAddress, addr1, indent=2)
from_json = JSON.FromJSON(backup).Reachable(backup.IntlAddress, text)
assert from_json is not roundtrip and str(from_json.street1) == str(addr1.street1)  # another copy
assert JSON.loads(text) == graph
