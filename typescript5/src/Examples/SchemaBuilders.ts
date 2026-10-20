// Schema builders example: building schemas in a store, the shorthands, and on-demand validation.
//
// Nothing here builds instances; it exercises the schema builders (Builders.OfX.Builder, through a store) and
// Schemas.OfX.Data.validate().

import { ValueError } from "@mbse/schemas/Framework/Errors";
import { Builders, Schemas } from "@mbse/schemas/Framework";
import { assert, raises } from "./_support.js";

// Every schema object is built in a store: `store.Schemas.<Kind>(...)`. A callback creates one, an object and a
// callback update it, an object alone clones it; the call returns it.
const store: any = new Builders.Store();
const Text = store.Schemas.OfStr.as_schema(); // the store's own basic scalar

// --- Types are schemas that exist ---

// A member's type is linked, not built: a schema that exists, such as a scalar schema.
const Named = store.Schemas.OfObject((o: any) => o.properties([
  (t: any) => t.name("first").schema([Text]),
  (t: any) => t.name("last").schema([Text]),
]));
assert(Named.properties.get("first").schema === Text && Named.properties.get("last").schema === Text);

// A value of any schema has no types; a value of one of several types, those.
assert(store.Schemas.OfAny((a: any) => a).schemas.length === 0);
const types = store.Schemas.OfAny((a: any) => a.schemas([Text, store.Schemas.OfInt])).schemas;
assert(types.length === 2 && types[0] === Text && types[1] === store.Schemas.OfInt.as_schema());

// A property takes its value whole, of exactly its type.
raises(TypeError, () => store.Schemas.OfObject((o: any) => o.ref(1n))); // deliberate misuse
raises(TypeError, () => store.Schemas.OfObject((o: any) => o.properties([3n]))); // an adjacency links schema objects, not values

// --- Builder finalization ---

raises(ValueError, () => new Builders.OfObject.Builder(Named).create()); // create() is only valid without a source
raises(ValueError, () => new Builders.OfObject.Builder().clone()); // clone() needs a source
raises(ValueError, () => new Builders.OfObject.Builder().update()); // update() needs a source
raises(TypeError, () => store.Schemas.OfObject()); // a callback, an object and a callback, or an object

// A clone leaves the source untouched; an update changes it in place and returns it.
const Extended = store.Schemas.OfObject(store.Schemas.OfObject(Named), (o: any) => o.properties([(t: any) => t.name("middle").schema([Text])]));
assert(Extended !== Named && Extended.properties.has("middle") && !Named.properties.has("middle"));

const updated = store.Schemas.OfObject(Named, (o: any) => o.properties([(t: any) => t.name("nickname").schema([Text])]));
assert(updated === Named && Named.properties.has("nickname"));

// A clone owns its members: they are clones too, and later edits do not leak.
assert(Extended.properties.get("first") !== Named.properties.get("first") && Extended.properties.get("first").schema === Text);

// Each call builds its own schema: building twice through the same callback gives independent schemas.
const a_only = (o: any) => o.properties([(t: any) => t.name("a").schema([Text])]);
const first = store.Schemas.OfObject(a_only);
const second = store.Schemas.OfObject(a_only);
store.Schemas.OfObject(second, (o: any) => o.properties([(t: any) => t.name("b").schema([Text])]));
assert(first !== second && [...first.properties.keys()].join() === "a" && [...second.properties.keys()].join() === "a,b");

// Redefining a property replaces it.
const Retyped = store.Schemas.OfObject(store.Schemas.OfObject(first), (o: any) => o.properties([
  (t: any) => t.name("a").schema([store.Schemas.OfInt]),
]));
assert(Retyped.properties.get("a").schema === store.Schemas.OfInt.as_schema() && first.properties.get("a").schema === Text);

// --- Relations and cardinality ---

// A map a -> [key] -> b: a relation with links a, b and property key. ISO 4217 currency codes as keys.
const Product = store.Schemas.OfObject((o: any) => o.ref(true).properties([(t: any) => t.name("sku").schema([Text])]));
const Money = store.Schemas.OfObject((o: any) => (
  o
    .ref(true) // an entry links only reference objects
    .properties([(t: any) => t.name("minor_units").schema([store.Schemas.OfInt])]) // e.g. cents
));
const Prices = store.Schemas.OfRelation((r: any) => (
  r
    .name("Prices") // each end's adjacency links it: a schema shared is named
    .links([
      (t: any) => t.name("product"),
      (t: any) => t.name("price"),
    ])
    .properties([(t: any) => t.name("currency").schema([Text])]) // ISO 4217 alpha code, e.g. 'EUR'
    .uniques([
      ["price"], // (product, currency) determine the price
      ["product", "currency"], // each price belongs to one product under one currency
    ])
));
store.Schemas.OfObject(Product, (o: any) => o.adjacencies([(t: any) => t.name("prices").relation([Prices]).me("product")]));
store.Schemas.OfObject(Money, (o: any) => o.adjacencies([(t: any) => t.name("priced").relation([Prices]).me("price")]));
for (const schema of [Product, Money, Prices]) assert(schema.validate().length === 0, String(schema.validate()));

function parent_child(r: any): any {
  return r.links([
    (t: any) => t.name("parent"),
    (t: any) => t.name("child"),
  ]);
}

// Pure ownership and a directory keyed within its parent, written as in FRAMEWORK.md.
const Ownership = store.Schemas.OfRelation((r: any) => parent_child(r.name("Ownership")).uniques("parent"));
const Directory = store.Schemas.OfRelation((r: any) => (
  parent_child(r)
    .properties([(t: any) => t.name("key").schema([Text])])
    .uniques([
      ["parent", "key"],
      ["child"],
    ])
));
assert(Ownership.validate().length === 0 && Directory.validate().length === 0);

// --- Validation catches problems, but only when asked ---

// Building an invalid schema succeeds; validate() reports the problems.
const NoLinks = store.Schemas.OfRelation((r: any) => r);
assert(NoLinks.validate().some((p: string) => p.includes("two links or more")));
const OneLink = store.Schemas.OfRelation((r: any) => r.links([(t: any) => t.name("contact")]));
assert(OneLink.validate().some((p: string) => p.includes("a list of values is a container")));

const Clash = store.Schemas.OfRelation((r: any) => (
  r
    .links([
      (t: any) => t.name("owner"),
      (t: any) => t.name("item"),
    ])
    .properties([(t: any) => t.name("item").schema([Text])])
));
assert(Clash.validate().some((p: string) => p.includes("both link and property")));

const DuplicateLinks = store.Schemas.OfRelation((r: any) => r.links([
  (t: any) => t.name("node"),
  (t: any) => t.name("node"),
]));
assert([...DuplicateLinks.entry.links.keys()].join() === "node" && DuplicateLinks.validate().length > 0); // by name, as properties are

const UnknownUnique = store.Schemas.OfRelation((r: any) => (
  r
    .links([
      (t: any) => t.name("a"),
      (t: any) => t.name("b"),
    ])
    .uniques("c")
));
assert(UnknownUnique.validate().some((p: string) => p.includes("unknown")));

const WrongSide = store.Schemas.OfObject((o: any) => o.adjacencies([
  (t: any) => t.name("things").relation([Ownership]).me("owner"), // Ownership's links are parent, child
]));
assert(WrongSide.validate().some((p: string) => p.includes("not a link")));

const NameClash = store.Schemas.OfObject((o: any) => (
  o
    .properties([(t: any) => t.name("children").schema([Text])])
    .adjacencies([(t: any) => t.name("children").relation([Ownership]).me("parent")])
));
assert(NameClash.validate().some((p: string) => p.includes("both property and adjacency")));

// The scalars are the store's five basic scalars; a finer scalar is a domain (mbse-expressions), never a schema.
for (const unsupported of [Array, Map, Uint16Array]) { // the JavaScript counterparts of complex, list, bytearray
  assert(new Schemas.OfScalar.Data(unsupported).validate().length > 0); // deliberate misuse
}
raises(TypeError, () => store.Schemas.OfScalar((s: any) => s.name("Email")));

// --- Singletons ---

// A singleton is a reference object: `singleton` names it, and `ref` makes it one.
const Registry = store.Schemas.OfObject((o: any) => o.ref(true).singleton("iso3166.Registry"));
assert(Registry.singleton === "iso3166.Registry" && Registry.validate().length === 0);

// --- Unions and intersections (schema level) ---
//
// A union's branches and an intersection's parts are named: a union value holds exactly one branch, by name, and an
// intersection value every part.

const Phone = store.Schemas.OfObject((o: any) => o.name("Phone").properties([(t: any) => t.name("number").schema([Text])]));
const Email = store.Schemas.OfObject((o: any) => o.name("Email").properties([(t: any) => t.name("address").schema([Text])]));

const ContactMethod = store.Schemas.OfUnion((u: any) => u.branches([
  (t: any) => t.name("phone").schema([Phone]),
  (t: any) => t.name("email").schema([Email]),
]));
assert(ContactMethod.validate().length === 0);

const Unnamed = store.Schemas.OfUnion((u: any) => u.branches([
  (t: any) => t.schema([Phone]),
  (t: any) => t.name("email").schema([Email]),
]));
assert(Unnamed.validate().some((p: string) => p.includes("has no name")));

const SameName = store.Schemas.OfUnion((u: any) => u.branches([
  (t: any) => t.name("m").schema([Phone]),
  (t: any) => t.name("m").schema([Email]),
]));
assert(SameName.validate().some((p: string) => p.includes("more than once")));

const MixedKinds = store.Schemas.OfUnion((u: any) => u.branches([
  (t: any) => t.name("phone").schema([Phone]),
  (t: any) => t.name("text").schema([Text]),
]));
assert(MixedKinds.validate().some((p: string) => p.includes("same kind")));

const SingleBranch = store.Schemas.OfUnion((u: any) => u.branches([(t: any) => t.name("phone").schema([Phone])]));
assert(SingleBranch.validate().some((p: string) => p.includes("at least two")));

// Intersections combine same-kind schemas as named parts. Each part keeps its own properties, so two parts may
// declare the same property, even with different types.
const Timestamped = store.Schemas.OfObject((o: any) => o.name("Timestamped").properties([(t: any) => t.name("updated").schema([Text])]));
const EpochStamped = store.Schemas.OfObject((o: any) => o.properties([
  (t: any) => t.name("updated").schema([store.Schemas.OfInt]),
]));
const Stamps = store.Schemas.OfIntersection((i: any) => i.parts([
  (t: any) => t.name("text").schema([Timestamped]),
  (t: any) => t.name("epoch").schema([EpochStamped]),
]));
assert(Stamps.validate().length === 0);

assert(store.Schemas.OfIntersection((i: any) => i.parts([
  (t: any) => t.name("stamp").schema([Timestamped]),
  (t: any) => t.name("text").schema([Text]),
])).validate().length > 0); // mixed kinds

console.log("SchemaBuilders: all checks passed");
