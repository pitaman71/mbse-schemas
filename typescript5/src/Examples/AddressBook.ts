// Address book example
//
// Lines marked PROPOSED use syntax that FRAMEWORK.md does not define yet.

import { JSON, Plain, Proxies, Schemas } from "@mbse/schemas/Framework";
import { assert, equal } from "./_support.js";

const store = new Proxies.OfStore();

// --- Schemas ---

let IntlAddress = new Schemas.OfObject.Builder().name("IntlAddress").ref()
  .properties(
    (prop) => prop.name("street1").of((t) => t.as_scalar(String)),
    (prop) => prop.name("street2").of((t) => t.as_scalar(String)),
    (prop) => prop.name("street3").of((t) => t.as_scalar(String)),
    (prop) => prop.name("dependent_locality").of((t) => t.as_scalar(String)), // neighborhood, district
    (prop) => prop.name("locality").of((t) => t.as_scalar(String)), // city, town, post town
    (prop) => prop.name("administrative_area").of((t) => t.as_scalar(String)), // state, province, prefecture
    (prop) => prop.name("postal_code").of((t) => t.as_scalar(String)),
    (prop) => prop.name("sorting_code").of((t) => t.as_scalar(String)), // e.g. French CEDEX
    (prop) => prop.name("country_code").of((t) => t.as_scalar(String)), // ISO 3166-1 alpha-2
  )
  .create();

let Contact = new Schemas.OfObject.Builder().name("Contact").ref()
  .properties(
    (prop) => prop.name("given_name").of((t) => t.as_scalar(String)),
    (prop) => prop.name("family_name").of((t) => t.as_scalar(String)),
    (prop) => prop.name("birth_date").of((t) => t.as_scalar(String)), // ISO 8601 calendar date, YYYY-MM-DD
    (prop) => prop.name("preferred_language").of((t) => t.as_scalar(String)), // BCP 47 tag, e.g. 'fr-CA'
  )
  .create();

let PhoneNumber = new Schemas.OfObject.Builder().name("PhoneNumber").ref()
  .properties(
    (prop) => prop.name("number").of((t) => t.as_scalar(String)), // ITU-T E.164, e.g. '+14155550100'
  )
  .create();

let EmailAddress = new Schemas.OfObject.Builder().name("EmailAddress").ref()
  .properties(
    (prop) => prop.name("address").of((t) => t.as_scalar(String)), // RFC 5322 addr-spec
  )
  .create();

// Collections are relations. Links are untyped; each object declares its adjacencies below.

const ContactAddresses = new Schemas.OfRelation.Builder().name("ContactAddresses")
  .links("contact", "address")
  .properties(
    (prop) => prop.name("label").of((t) => t.as_scalar(String)), // e.g. 'home', 'work'
  )
  .create();

const ContactPhones = new Schemas.OfRelation.Builder().name("ContactPhones")
  .links("contact", "phone")
  .properties(
    (prop) => prop.name("label").of((t) => t.as_scalar(String)), // e.g. 'mobile', 'work'
  )
  .create();

const ContactEmails = new Schemas.OfRelation.Builder().name("ContactEmails")
  .links("contact", "email")
  .properties(
    (prop) => prop.name("label").of((t) => t.as_scalar(String)), // e.g. 'personal', 'work'
  )
  .create();

Contact = new Schemas.OfObject.Builder(Contact)
  .relations(
    (adj) => adj.name("addresses").of(ContactAddresses).me("contact"),
    (adj) => adj.name("phones").of(ContactPhones).me("contact"),
    (adj) => adj.name("emails").of(ContactEmails).me("contact"),
  )
  .update();

IntlAddress = new Schemas.OfObject.Builder(IntlAddress)
  .relations((adj) => adj.name("contacts").of(ContactAddresses).me("address"))
  .update();

PhoneNumber = new Schemas.OfObject.Builder(PhoneNumber)
  .relations((adj) => adj.name("contacts").of(ContactPhones).me("phone"))
  .update();

EmailAddress = new Schemas.OfObject.Builder(EmailAddress)
  .relations((adj) => adj.name("contacts").of(ContactEmails).me("email"))
  .update();

store.register(IntlAddress);
store.register(Contact);
store.register(PhoneNumber);
store.register(EmailAddress);
store.register(ContactAddresses);
store.register(ContactPhones);
store.register(ContactEmails);

// --- Builder forms ---

// fluent "create" form
const addr1 = store.IntlAddress()
  .street1("10 Downing Street")
  .street2("bar")
  .street3("Whitehall")
  .locality("London")
  .postal_code("SW1A 2AA")
  .country_code("GB")
  .create();

// fluent "update" form: writes back into the source and returns it
const updated = store.IntlAddress(addr1)
  .street2((p: any) => p.as_scalar((v: any) => v.set("baz"))) // equivalent to .street2('baz')
  .update();
assert(updated === addr1);
assert(String(addr1.street2) === "baz");

// fluent "clone" form: returns a new object and leaves the source untouched
const cloned = store.IntlAddress(addr1).street2("shoe").clone();
assert(cloned !== addr1);
assert(String(cloned.street2) === "shoe");
assert(String(addr1.street2) === "baz");

// clearing a property makes it absent; an absent property's value reads as null
store.IntlAddress(addr1).street3((p: any) => p.as_value((v: any) => v.clear())).update();
assert(addr1.street3.get() === null);

// a property that was never set reads as null too
assert(addr1.sorting_code.get() === null);

// traditional property access (read only)
console.log(`${addr1.street1}, ${addr1.locality} ${addr1.postal_code}, ${addr1.country_code}`);

// --- Relations ---

// Entries are inserted through the object builder's adjacencies, `insert` taking a Spec for the entry: the object
// fills its own link ('contact'); the entry builder sets the other links and the entry properties. A link takes an
// existing object or a Spec that builds a new one.
const alice = store.Contact()
  .given_name("Alice")
  .family_name("Liddell")
  .birth_date("1852-05-04")
  .preferred_language("en-GB")
  .addresses((a: any) => a.insert((x: any) => x.address(addr1).label("work")))
  .phones((a: any) => a.insert((x: any) => x.phone((y: any) => y.number("+447700900123")).label("mobile")))
  .emails((a: any) => a.insert((x: any) => x.email((y: any) => y.address("alice@example.org")).label("personal")))
  .create();
void alice;
export { IntlAddress, addr1 };

// --- Serialization ---

// A single-object snapshot includes addr1's adjacencies, so it references alice by key without containing her.
// Deserializing it on its own is an error: the reference cannot be resolved.
const plain = Plain.ToPlain(store)(IntlAddress, addr1);
// equivalent to
// const plain = Plain.ToPlain(store).OfObject(IntlAddress, addr1)
void plain;

// PROPOSED: a snapshot of addr1 and every object reachable through adjacencies (alice, her phone and email), so all
// references resolve within the snapshot. Each object is keyed by its identity, qualified by its schema's name.
const graph = Plain.ToPlain(store).Reachable(IntlAddress, addr1);
assert(graph.get("root") === `IntlAddress/${addr1.as_identity()}`);

// Read into another store, the snapshot builds objects of the same identities there.
const backup = new Proxies.OfStore();
for (const schema of [IntlAddress, Contact, PhoneNumber, EmailAddress, ContactAddresses, ContactPhones, ContactEmails]) {
  backup.register(schema);
}
const roundtrip = Plain.FromPlain(backup).Reachable(IntlAddress, graph) as Proxies.Instance;
assert(roundtrip !== addr1 && roundtrip.as_identity() === addr1.as_identity());
assert(equal(Plain.ToPlain(backup).Reachable(IntlAddress, roundtrip), graph));

// Read into the store that holds them, it updates them through their builders: what it omits, they keep.
assert(Plain.FromPlain(store).Reachable(IntlAddress, graph) === addr1);

// The same snapshot as JSON text, and back.
const text = JSON.ToJSON(store).Reachable(IntlAddress, addr1, { indent: 2 });
const fromJson = JSON.FromJSON(backup).Reachable(IntlAddress, text) as Proxies.Instance;
assert(fromJson === roundtrip && String(fromJson.street1) === String(addr1.street1)); // the backup's, updated
assert(equal(JSON.loads(text), graph));
