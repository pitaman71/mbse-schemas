// Address book example
//
// Lines marked PROPOSED use syntax that FRAMEWORK.md does not define yet.

import { Builders, JSON, Plain, Proxies, Schemas } from "@mbse/schemas/Framework";
import { ValueError } from "@mbse/schemas/Framework/Errors";
import { assert, equal, raises } from "./_support.js";


// Schemas and objects are built in a store, `store.<schema name>(...)`; a named schema registers itself as it is built.
const store: any = new Builders.Store();
const Text = store.Schemas.OfStr.as_schema(); // the store's own basic scalar

// --- Schemas ---

const { IntlAddress } = store.transaction(() => { // every write to a store is made within a transaction, all or nothing
  const IntlAddress = store.Schemas.OfObject((o: any) => (
    o
      .name("IntlAddress")
      .ref(true)
      .properties([
        (t: any) => t.name("street1").schema([Text]),
        (t: any) => t.name("street2").schema([Text]),
        (t: any) => t.name("street3").schema([Text]),
        (t: any) => t.name("dependent_locality").schema([Text]), // neighborhood, district
        (t: any) => t.name("locality").schema([Text]), // city, town, post town
        (t: any) => t.name("administrative_area").schema([Text]), // state, province, prefecture
        (t: any) => t.name("postal_code").schema([Text]),
        (t: any) => t.name("sorting_code").schema([Text]), // e.g. French CEDEX
        (t: any) => t.name("country_code").schema([Text]), // ISO 3166-1 alpha-2
      ])
  ));

  const Contact = store.Schemas.OfObject((o: any) => (
    o
      .name("Contact")
      .ref(true)
      .properties([
        (t: any) => t.name("given_name").schema([Text]),
        (t: any) => t.name("family_name").schema([Text]),
        (t: any) => t.name("birth_date").schema([Text]), // ISO 8601 calendar date, YYYY-MM-DD
        (t: any) => t.name("preferred_language").schema([Text]), // BCP 47 tag, e.g. 'fr-CA'
      ])
  ));

  const PhoneNumber = store.Schemas.OfObject((o: any) => (
    o
      .name("PhoneNumber")
      .ref(true)
      .properties([
        (t: any) => t.name("number").schema([Text]), // ITU-T E.164, e.g. '+14155550100'
      ])
  ));

  const EmailAddress = store.Schemas.OfObject((o: any) => (
    o
      .name("EmailAddress")
      .ref(true)
      .properties([
        (t: any) => t.name("address").schema([Text]), // RFC 5322 addr-spec
      ])
  ));

  // Collections are relations. Links are untyped; each object declares its adjacencies below.

  const ContactAddresses = store.Schemas.OfRelation((r: any) => (
    r
      .name("ContactAddresses")
      .links([
        (t: any) => t.name("contact"),
        (t: any) => t.name("address"),
      ])
      .properties([
        (t: any) => t.name("label").schema([Text]), // e.g. 'home', 'work'
      ])
  ));

  const ContactPhones = store.Schemas.OfRelation((r: any) => (
    r
      .name("ContactPhones")
      .links([
        (t: any) => t.name("contact"),
        (t: any) => t.name("phone"),
      ])
      .properties([
        (t: any) => t.name("label").schema([Text]), // e.g. 'mobile', 'work'
      ])
  ));

  const ContactEmails = store.Schemas.OfRelation((r: any) => (
    r
      .name("ContactEmails")
      .links([
        (t: any) => t.name("contact"),
        (t: any) => t.name("email"),
      ])
      .properties([
        (t: any) => t.name("label").schema([Text]), // e.g. 'personal', 'work'
      ])
  ));

  // A schema and a callback: the schema, updated in place.
  store.Schemas.OfObject(Contact, (o: any) => o.adjacencies([
    (t: any) => t.name("addresses").relation([ContactAddresses]).me("contact"),
    (t: any) => t.name("phones").relation([ContactPhones]).me("contact"),
    (t: any) => t.name("emails").relation([ContactEmails]).me("contact"),
  ]));
  store.Schemas.OfObject(IntlAddress, (o: any) => o.adjacencies([
    (t: any) => t.name("contacts").relation([ContactAddresses]).me("address"),
  ]));
  store.Schemas.OfObject(PhoneNumber, (o: any) => o.adjacencies([
    (t: any) => t.name("contacts").relation([ContactPhones]).me("phone"),
  ]));
  store.Schemas.OfObject(EmailAddress, (o: any) => o.adjacencies([
    (t: any) => t.name("contacts").relation([ContactEmails]).me("email"),
  ]));
  return { IntlAddress };
});

// --- Building forms ---

const { addr1 } = store.transaction(() => { // the data, as the schemas: written within a transaction, all or nothing
  // "create": a callback builds a new object
  const addr1 = store.IntlAddress((a: any) => (
    a
      .street1("10 Downing Street")
      .street2("bar")
      .street3("Whitehall")
      .locality("London")
      .postal_code("SW1A 2AA")
      .country_code("GB")
  ));

  // "update": the object and a callback write into the object, and return it
  const updated = store.IntlAddress(addr1, (a: any) => a.street2((p: any) => p.as_scalar((v: any) => v.set("baz")))); // .street2('baz')
  assert(updated === addr1);
  assert(String(addr1.street2) === "baz");

  // "clone": the object alone returns a new object, and leaves the source untouched
  const cloned = store.IntlAddress(store.IntlAddress(addr1), (a: any) => a.street2("shoe"));
  assert(cloned !== addr1);
  assert(String(cloned.street2) === "shoe");
  assert(String(addr1.street2) === "baz");

  // clearing a property makes it absent; an absent property's value reads as null
  store.IntlAddress(addr1, (a: any) => a.street3((p: any) => p.as_value((v: any) => v.clear())));
  assert(addr1.street3.get() === null);

  // a property that was never set reads as null too
  assert(addr1.sorting_code.get() === null);

  // traditional property access (read only)
  console.log(`${addr1.street1}, ${addr1.locality} ${addr1.postal_code}, ${addr1.country_code}`);

  // --- Relations ---

  // Entries are inserted through the object builder's adjacencies, `insert` taking a Spec for the entry: the object
  // fills its own link ('contact'); the entry builder sets the other links and the entry properties. A link takes an
  // existing object or a Spec that builds a new one.
  const alice = store.Contact((c: any) => (
    c
      .given_name("Alice")
      .family_name("Liddell")
      .birth_date("1852-05-04")
      .preferred_language("en-GB")
      .addresses((a: any) => a.insert((x: any) => x.address(addr1).label("work")))
      .phones((a: any) => a.insert((x: any) => x.phone((y: any) => y.number("+447700900123")).label("mobile")))
      .emails((a: any) => a.insert((x: any) => x.email((y: any) => y.address("alice@example.org")).label("personal")))
  ));
  void alice;
  return { addr1 };
});
export { IntlAddress, addr1 };

// --- Serialization ---

// A document is one transaction (docs/OBJECT_IDENTITY.md, Decided, 51): the objects it holds are the symbols of one
// upsert, numbered in the order it meets them, the root's "0", and its spec gives each one's properties and entries.
// An object's document holds it alone, so addr1's is refused: alice, whom it links, is counted (neither a singleton nor
// owned), and has no identity beyond the document that writes her.
raises(ValueError, () => Plain.ToPlain(store)(IntlAddress, addr1)); // equivalent to Plain.ToPlain(store).OfObject(IntlAddress, addr1)

// A document of addr1 and every counted object reachable from it (alice, her phone and email), so that every reference
// is to a symbol of the document.
const graph: any = Plain.ToPlain(store).Reachable(IntlAddress, addr1);
assert([...graph.get("mutations")[0].get("upsert").get("exists")[0].get("symbols").keys()][0] === "0"); // the root

// Read into another store, the document builds new objects of the same graph there.
const backup: any = new Builders.Store();
Plain.FromPlain(backup).Snapshot(Plain.ToPlain(store).Snapshot()); // the same schemas, its own: a store's snapshot writes them
const roundtrip = Plain.FromPlain(backup).Reachable(backup.IntlAddress, graph) as Proxies.Instance;
assert(roundtrip !== addr1);
assert(equal(Plain.ToPlain(backup).Reachable(backup.IntlAddress, roundtrip), graph));

// Read into the store that holds them, it builds new ones too: a counted object has no identity beyond the document.
assert(Plain.FromPlain(store).Reachable(IntlAddress, graph) !== addr1);

// The same document as JSON text, and back.
const text = JSON.ToJSON(store).Reachable(IntlAddress, addr1, { indent: 2 });
const fromJson = JSON.FromJSON(backup).Reachable(backup.IntlAddress, text) as Proxies.Instance;
assert(fromJson !== roundtrip && String(fromJson.street1) === String(addr1.street1)); // another copy
assert(equal(JSON.loads(text), graph));
