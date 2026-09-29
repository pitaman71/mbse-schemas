// Schema rules example: builder semantics, Spec forms, and on-demand validation.
//
// Nothing here builds instances; it exercises Schemas.OfX.Builder and Schemas.OfX.Data.validate().

import { ValueError } from "@mbse/schemas/Framework/Errors";
import { Schemas } from "@mbse/schemas/Framework";
import { assert, raises } from "./_support.js";

// --- Spec forms ---

// A native Spec is a type directly, or a callable that takes and returns an OfNative.Builder.
const direct = new Schemas.OfAny.Builder().as_native(String).create();
const configured = new Schemas.OfAny.Builder().as_native((n) => n.type(String)).create();
assert(direct.equals(configured) && configured.equals(new Schemas.OfNative.Data(String)));

// Finalizing an OfAny builder yields the selected kind's data, not a wrapper.
assert(direct.constructor === Schemas.OfNative.Data);

// An OfAny Spec may also be existing schema data, reused as is (not copied).
const Text = new Schemas.OfNative.Data(String);
const Named = new Schemas.OfObject.Builder()
  .properties(
    (prop) => prop.name("first").of(Text),
    (prop) => prop.name("last").of(Text),
  )
  .create();
assert(Named.properties.get("first") === Text && Named.properties.get("last") === Text);

// An OfAny builder with no kind selected cannot be finalized.
raises(ValueError, () => new Schemas.OfAny.Builder().create());

// A Spec callable must return its builder.
raises(TypeError, () => new Schemas.OfObject.Builder().properties((() => undefined) as never).create()); // deliberate misuse

// --- Builder finalization ---

raises(ValueError, () => new Schemas.OfObject.Builder(Named).create()); // create() is only valid without a source
raises(ValueError, () => new Schemas.OfObject.Builder().clone()); // clone() needs a source
raises(ValueError, () => new Schemas.OfObject.Builder().update()); // update() needs a source

// clone() leaves the source untouched; update() changes it in place and returns it.
const Extended = new Schemas.OfObject.Builder(Named).properties((prop) => prop.name("middle").of(Text)).clone();
assert(Extended !== Named && Extended.properties.has("middle") && !Named.properties.has("middle"));

const updated = new Schemas.OfObject.Builder(Named).properties((prop) => prop.name("nickname").of(Text)).update();
assert(updated === Named && Named.properties.has("nickname"));

// A builder keeps its own copies: finalizing twice gives independent schemas, and later edits do not leak.
const builder = new Schemas.OfObject.Builder().properties((prop) => prop.name("a").of(Text));
const first = builder.create();
builder.properties((prop) => prop.name("b").of(Text));
const second = builder.create();
assert([...first.properties.keys()].join() === "a" && [...second.properties.keys()].join() === "a,b");

// Redefining a property replaces it.
const Retyped = new Schemas.OfObject.Builder(first)
  .properties((prop) => prop.name("a").of((t) => t.as_native(BigInt)))
  .clone();
assert((Retyped.properties.get("a") as Schemas.OfNative.Data).equals(new Schemas.OfNative.Data(BigInt)) && first.properties.get("a") === Text);

// --- Relations and cardinality ---

// A map a -> [key] -> b: a relation with links a, b and property key. ISO 4217 currency codes as keys.
const Product = new Schemas.OfObject.Builder().properties((prop) => prop.name("sku").of(Text)).create();
const Money = new Schemas.OfObject.Builder()
  .properties((prop) => prop.name("minor_units").of((t) => t.as_native(BigInt))) // e.g. cents
  .create();
const Prices = new Schemas.OfRelation.Builder()
  .links("product", "price")
  .properties((prop) => prop.name("currency").of(Text)) // ISO 4217 alpha code, e.g. 'EUR'
  .unique("price") // (product, currency) determine the price
  .unique("product", "currency") // each price belongs to one product under one currency
  .create();
new Schemas.OfObject.Builder(Product).relations((adj) => adj.name("prices").of(Prices).me("product")).update();
new Schemas.OfObject.Builder(Money).relations((adj) => adj.name("priced").of(Prices).me("price")).update();
for (const schema of [Product, Money, Prices]) assert(schema.validate().length === 0, String(schema.validate()));

// Pure ownership and a directory keyed within its parent, written as in FRAMEWORK.md.
const Ownership = new Schemas.OfRelation.Builder().links("parent", "child").unique("parent").create();
const Directory = new Schemas.OfRelation.Builder()
  .links("parent", "child")
  .properties((prop) => prop.name("key").of(Text))
  .unique("parent", "key")
  .unique("child")
  .create();
assert(Ownership.validate().length === 0 && Directory.validate().length === 0);

// --- Validation catches problems, but only when asked ---

// Building an invalid schema succeeds; validate() reports the problems.
const OneLink = new Schemas.OfRelation.Builder().links("contact").create();
assert(OneLink.validate().some((p) => p.includes("one-link")));

const Clash = new Schemas.OfRelation.Builder()
  .links("owner", "item")
  .properties((prop) => prop.name("item").of(Text))
  .create();
assert(Clash.validate().some((p) => p.includes("both link and property")));

const DuplicateLinks = new Schemas.OfRelation.Builder().links("node", "node").create();
assert(DuplicateLinks.validate().some((p) => p.includes("duplicate link")));

const UnknownUnique = new Schemas.OfRelation.Builder().links("a", "b").unique("c").create();
assert(UnknownUnique.validate().some((p) => p.includes("unknown")));

const WrongSide = new Schemas.OfObject.Builder()
  .relations((adj) => adj.name("things").of(Ownership).me("owner")) // Ownership's links are parent, child
  .create();
assert(WrongSide.validate().some((p) => p.includes("not a link")));

const NameClash = new Schemas.OfObject.Builder()
  .properties((prop) => prop.name("children").of(Text))
  .relations((adj) => adj.name("children").of(Ownership).me("parent"))
  .create();
assert(NameClash.validate().some((p) => p.includes("both property and adjacency")));

for (const unsupported of [Array, Map, Uint16Array]) { // the JavaScript counterparts of complex, list, bytearray
  assert(new Schemas.OfNative.Data(unsupported).validate().length > 0);
  const bad = new Schemas.OfObject.Builder().properties((prop) => prop.name("x").of((t) => t.as_native(unsupported as never))).create();
  assert(bad.validate().length > 0, unsupported.name);
}

// --- Singletons ---

const Registry = new Schemas.OfObject.Builder().singleton("iso3166.Registry").create();
assert(Registry.singleton === "iso3166.Registry" && Registry.validate().length === 0);

// --- Unions and intersections (schema level) ---
//
// Discriminator predicates are serializable expressions, from the separate mbse-expressions package; these are
// placeholders.

const Phone = new Schemas.OfObject.Builder().properties((prop) => prop.name("number").of(Text)).create();
const Email = new Schemas.OfObject.Builder().properties((prop) => prop.name("address").of(Text)).create();

const ContactMethod = new Schemas.OfUnion.Builder()
  .branches(
    (b) => b.of(Phone).when(["has", "number"]),
    (b) => b.of(Email).when(["has", "address"]),
  )
  .create();
assert(ContactMethod.validate().length === 0);

const MissingPredicate = new Schemas.OfUnion.Builder().branches((b) => b.of(Phone), (b) => b.of(Email)).create();
assert(MissingPredicate.validate().some((p) => p.includes("no discriminator")));

const MixedKinds = new Schemas.OfUnion.Builder()
  .branches((b) => b.of(Phone).when(["has", "number"]), (b) => b.of(Text).when(["is", "str"]))
  .create();
assert(MixedKinds.validate().some((p) => p.includes("same kind")));

const SingleBranch = new Schemas.OfUnion.Builder().branches((b) => b.of(Phone).when(["has", "number"])).create();
assert(SingleBranch.validate().some((p) => p.includes("at least two")));

// Intersections combine same-kind schemas; the same property with the same type is fine, different types conflict.
const Timestamped = new Schemas.OfObject.Builder().properties((prop) => prop.name("updated").of(Text)).create();
const Audited = new Schemas.OfObject.Builder()
  .properties(
    (prop) => prop.name("updated").of((t) => t.as_native(String)), // equal to Text, not the same object
    (prop) => prop.name("updated_by").of(Text),
  )
  .create();
assert(new Schemas.OfIntersection.Builder().of(Timestamped, Audited).create().validate().length === 0);

const EpochStamped = new Schemas.OfObject.Builder().properties((prop) => prop.name("updated").of((t) => t.as_native(BigInt))).create();
const Conflicting = new Schemas.OfIntersection.Builder().of(Timestamped, EpochStamped).create();
assert(Conflicting.validate().some((p) => p.includes("conflicting")));

assert(new Schemas.OfIntersection.Builder().of(Timestamped, Text).create().validate().length > 0); // mixed kinds

console.log("SchemaRules: all checks passed");
