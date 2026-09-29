// Address book example
//
// Lines marked PROPOSED use syntax that FRAMEWORK.md does not define yet.

import { AttributeError } from "@mbse/schemas/Framework/Errors";
import { JSON, Plain, Proxies, Schemas } from "@mbse/schemas/Framework";
import { assert, equal } from "./_support.js";

// --- Schemas ---

let IntlAddress = new Schemas.OfObject.Builder()
  .properties(
    (prop) => prop.name("street1").of((t) => t.as_native(String)),
    (prop) => prop.name("street2").of((t) => t.as_native(String)),
    (prop) => prop.name("street3").of((t) => t.as_native(String)),
    (prop) => prop.name("dependent_locality").of((t) => t.as_native(String)), // neighborhood, district
    (prop) => prop.name("locality").of((t) => t.as_native(String)), // city, town, post town
    (prop) => prop.name("administrative_area").of((t) => t.as_native(String)), // state, province, prefecture
    (prop) => prop.name("postal_code").of((t) => t.as_native(String)),
    (prop) => prop.name("sorting_code").of((t) => t.as_native(String)), // e.g. French CEDEX
    (prop) => prop.name("country_code").of((t) => t.as_native(String)), // ISO 3166-1 alpha-2
  )
  .create();

let Contact = new Schemas.OfObject.Builder()
  .properties(
    (prop) => prop.name("given_name").of((t) => t.as_native(String)),
    (prop) => prop.name("family_name").of((t) => t.as_native(String)),
    (prop) => prop.name("birth_date").of((t) => t.as_native(String)), // ISO 8601 calendar date, YYYY-MM-DD
    (prop) => prop.name("preferred_language").of((t) => t.as_native(String)), // BCP 47 tag, e.g. 'fr-CA'
  )
  .create();

let PhoneNumber = new Schemas.OfObject.Builder()
  .properties(
    (prop) => prop.name("number").of((t) => t.as_native(String)), // ITU-T E.164, e.g. '+14155550100'
  )
  .create();

let EmailAddress = new Schemas.OfObject.Builder()
  .properties(
    (prop) => prop.name("address").of((t) => t.as_native(String)), // RFC 5322 addr-spec
  )
  .create();

// Collections are relations. Links are untyped; each object declares its adjacencies below.

const ContactAddresses = new Schemas.OfRelation.Builder()
  .links("contact", "address")
  .properties(
    (prop) => prop.name("label").of((t) => t.as_native(String)), // e.g. 'home', 'work'
  )
  .create();

const ContactPhones = new Schemas.OfRelation.Builder()
  .links("contact", "phone")
  .properties(
    (prop) => prop.name("label").of((t) => t.as_native(String)), // e.g. 'mobile', 'work'
  )
  .create();

const ContactEmails = new Schemas.OfRelation.Builder()
  .links("contact", "email")
  .properties(
    (prop) => prop.name("label").of((t) => t.as_native(String)), // e.g. 'personal', 'work'
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

Proxies.register("IntlAddress", IntlAddress);
Proxies.register("Contact", Contact);
Proxies.register("PhoneNumber", PhoneNumber);
Proxies.register("EmailAddress", EmailAddress);
Proxies.register("ContactAddresses", ContactAddresses);
Proxies.register("ContactPhones", ContactPhones);
Proxies.register("ContactEmails", ContactEmails);

// --- Builder forms ---

// fluent "create" form
const addr1 = Proxies.Builders.IntlAddress()
  .street1("10 Downing Street")
  .street2("bar")
  .street3("Whitehall")
  .locality("London")
  .postal_code("SW1A 2AA")
  .country_code("GB")
  .create();

// fluent "update" form: writes back into the source and returns it
const updated = Proxies.Builders.IntlAddress(addr1)
  .street2((v: any) => v.set("baz")) // equivalent to .street2('baz')
  .update();
assert(updated === addr1);
assert(addr1.street2 === "baz");

// fluent "clone" form: returns a new object and leaves the source untouched
const cloned = Proxies.Builders.IntlAddress(addr1).street2("shoe").clone();
assert(cloned !== addr1);
assert(cloned.street2 === "shoe");
assert(addr1.street2 === "baz");

// clearing a property makes it absent; reading an absent property raises
Proxies.Builders.IntlAddress(addr1).street3((v: any) => v.clear()).update();
try {
  addr1.street3;
  throw new Error("AssertionError: reading a cleared property must raise");
} catch (error) {
  if (!(error instanceof AttributeError)) throw error;
}

// a property that was never set also raises
try {
  addr1.sorting_code;
  throw new Error("AssertionError: reading an unset property must raise");
} catch (error) {
  if (!(error instanceof AttributeError)) throw error;
}

// traditional property access (read only)
console.log(`${addr1.street1}, ${addr1.locality} ${addr1.postal_code}, ${addr1.country_code}`);

// --- Relations ---

// Entries are added through the object builder's adjacency accessors, which take a Spec for the entry: the object
// fills its own link ('contact'); the entry builder sets the other links and the entry properties. A link takes an
// existing object or a Spec that builds a new one.
const alice = Proxies.Builders.Contact()
  .given_name("Alice")
  .family_name("Liddell")
  .birth_date("1852-05-04")
  .preferred_language("en-GB")
  .addresses((x: any) => x.address(addr1).label("work"))
  .phones((x: any) => x.phone((y: any) => y.number("+447700900123")).label("mobile"))
  .emails((x: any) => x.email((y: any) => y.address("alice@example.org")).label("personal"))
  .create();
void alice;
export { IntlAddress, addr1 };

// --- Serialization ---

// A single-object snapshot includes addr1's adjacencies, so it references alice by symbol without containing her.
// Deserializing it on its own is an error: the reference cannot be resolved.
const plain = Plain.ToPlain(IntlAddress, addr1);
// equivalent to
// const plain = Plain.ToPlain.OfObject(IntlAddress, addr1)
void plain;

// PROPOSED: a snapshot of addr1 and every object reachable through adjacencies (alice, her phone and email), so all
// symbol references resolve within the snapshot.
const graph = Plain.ToPlain.Reachable(IntlAddress, addr1);
const roundtrip = Plain.FromPlain(Proxies.Builders).Reachable(IntlAddress, graph);
assert(roundtrip !== addr1);
assert(equal(Plain.ToPlain.Reachable(IntlAddress, roundtrip as Proxies.Instance), graph));

// The same snapshot as JSON text, and back.
const text = JSON.ToJSON.Reachable(IntlAddress, addr1, { indent: 2 });
const fromJson = JSON.FromJSON(Proxies.Builders).Reachable(IntlAddress, text) as Proxies.Instance;
assert(fromJson !== addr1 && fromJson.street1 === addr1.street1);
assert(equal(JSON.loads(text), graph));
