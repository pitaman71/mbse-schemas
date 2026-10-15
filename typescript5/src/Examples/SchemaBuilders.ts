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

// --- Types are schemas that exist ---

// A member's type is linked, not built: a schema that exists, such as a scalar schema.
const Text = new Schemas.OfScalar.Data(String);
const Named = store.Schemas.Object((o: any) => o.properties([
  (t: any) => t.name("first").type([Text]),
  (t: any) => t.name("last").type([Text]),
]));
assert(Named.properties.get("first").type === Text && Named.properties.get("last").type === Text);

// A value of any type has no types; a value of one of several types, those.
assert(store.Schemas.Any((a: any) => a).types.length === 0);
const types = store.Schemas.Any((a: any) => a.types([Text, new Schemas.OfScalar.Data(BigInt)])).types;
assert(types.length === 2 && types[0] === Text && types[1].equals(new Schemas.OfScalar.Data(BigInt)));

// A property takes its value whole, of exactly its type.
raises(TypeError, () => store.Schemas.Object((o: any) => o.ref(1n))); // deliberate misuse
raises(TypeError, () => store.Schemas.Object((o: any) => o.properties([3n]))); // an adjacency links schema objects, not values

// --- Builder finalization ---

raises(ValueError, () => new Builders.OfObject.Builder(Named).create()); // create() is only valid without a source
raises(ValueError, () => new Builders.OfObject.Builder().clone()); // clone() needs a source
raises(ValueError, () => new Builders.OfObject.Builder().update()); // update() needs a source
raises(TypeError, () => store.Schemas.Object()); // a callback, an object and a callback, or an object

// A clone leaves the source untouched; an update changes it in place and returns it.
const Extended = store.Schemas.Object(store.Schemas.Object(Named), (o: any) => o.properties([(t: any) => t.name("middle").type([Text])]));
assert(Extended !== Named && Extended.properties.has("middle") && !Named.properties.has("middle"));

const updated = store.Schemas.Object(Named, (o: any) => o.properties([(t: any) => t.name("nickname").type([Text])]));
assert(updated === Named && Named.properties.has("nickname"));

// A clone owns its members: they are clones too, and later edits do not leak.
assert(Extended.properties.get("first") !== Named.properties.get("first") && Extended.properties.get("first").type === Text);

// Each call builds its own schema: building twice through the same callback gives independent schemas.
const a_only = (o: any) => o.properties([(t: any) => t.name("a").type([Text])]);
const first = store.Schemas.Object(a_only);
const second = store.Schemas.Object(a_only);
store.Schemas.Object(second, (o: any) => o.properties([(t: any) => t.name("b").type([Text])]));
assert(first !== second && [...first.properties.keys()].join() === "a" && [...second.properties.keys()].join() === "a,b");

// Redefining a property replaces it.
const Retyped = store.Schemas.Object(store.Schemas.Object(first), (o: any) => o.properties([
  (t: any) => t.name("a").type([new Schemas.OfScalar.Data(BigInt)]),
]));
assert(Retyped.properties.get("a").type.equals(new Schemas.OfScalar.Data(BigInt)) && first.properties.get("a").type === Text);

// --- Relations and cardinality ---

// A map a -> [key] -> b: a relation with links a, b and property key. ISO 4217 currency codes as keys.
const Product = store.Schemas.Object((o: any) => o.ref(true).properties([(t: any) => t.name("sku").type([Text])]));
const Money = store.Schemas.Object((o: any) => (
  o
    .ref(true) // an entry links only reference objects
    .properties([(t: any) => t.name("minor_units").type([new Schemas.OfScalar.Data(BigInt)])]) // e.g. cents
));
const Prices = store.Schemas.Relation((r: any) => (
  r
    .links([
      (t: any) => t.name("product"),
      (t: any) => t.name("price"),
    ])
    .properties([(t: any) => t.name("currency").type([Text])]) // ISO 4217 alpha code, e.g. 'EUR'
    .uniques([
      ["price"], // (product, currency) determine the price
      ["product", "currency"], // each price belongs to one product under one currency
    ])
));
store.Schemas.Object(Product, (o: any) => o.adjacencies([(t: any) => t.name("prices").relation([Prices]).me("product")]));
store.Schemas.Object(Money, (o: any) => o.adjacencies([(t: any) => t.name("priced").relation([Prices]).me("price")]));
for (const schema of [Product, Money, Prices]) assert(schema.validate().length === 0, String(schema.validate()));

function parent_child(r: any): any {
  return r.links([
    (t: any) => t.name("parent"),
    (t: any) => t.name("child"),
  ]);
}

// Pure ownership and a directory keyed within its parent, written as in FRAMEWORK.md.
const Ownership = store.Schemas.Relation((r: any) => parent_child(r).uniques("parent"));
const Directory = store.Schemas.Relation((r: any) => (
  parent_child(r)
    .properties([(t: any) => t.name("key").type([Text])])
    .uniques([
      ["parent", "key"],
      ["child"],
    ])
));
assert(Ownership.validate().length === 0 && Directory.validate().length === 0);

// --- Validation catches problems, but only when asked ---

// Building an invalid schema succeeds; validate() reports the problems.
const NoLinks = store.Schemas.Relation((r: any) => r);
assert(NoLinks.validate().some((p: string) => p.includes("two links or more")));
const OneLink = store.Schemas.Relation((r: any) => r.links([(t: any) => t.name("contact")]));
assert(OneLink.validate().some((p: string) => p.includes("a list of values is a container")));

const Clash = store.Schemas.Relation((r: any) => (
  r
    .links([
      (t: any) => t.name("owner"),
      (t: any) => t.name("item"),
    ])
    .properties([(t: any) => t.name("item").type([Text])])
));
assert(Clash.validate().some((p: string) => p.includes("both link and property")));

const DuplicateLinks = store.Schemas.Relation((r: any) => r.links([
  (t: any) => t.name("node"),
  (t: any) => t.name("node"),
]));
assert([...DuplicateLinks.entry.links.keys()].join() === "node" && DuplicateLinks.validate().length > 0); // by name, as properties are

const UnknownUnique = store.Schemas.Relation((r: any) => (
  r
    .links([
      (t: any) => t.name("a"),
      (t: any) => t.name("b"),
    ])
    .uniques("c")
));
assert(UnknownUnique.validate().some((p: string) => p.includes("unknown")));

const WrongSide = store.Schemas.Object((o: any) => o.adjacencies([
  (t: any) => t.name("things").relation([Ownership]).me("owner"), // Ownership's links are parent, child
]));
assert(WrongSide.validate().some((p: string) => p.includes("not a link")));

const NameClash = store.Schemas.Object((o: any) => (
  o
    .properties([(t: any) => t.name("children").type([Text])])
    .adjacencies([(t: any) => t.name("children").relation([Ownership]).me("parent")])
));
assert(NameClash.validate().some((p: string) => p.includes("both property and adjacency")));

for (const unsupported of [Array, Map, Uint16Array]) { // the JavaScript counterparts of complex, list, bytearray
  assert(new Schemas.OfScalar.Data(unsupported).validate().length > 0); // deliberate misuse
  const bad = store.Schemas.Object((o: any) => o.properties([
    (t: any) => t.name("x").type([new Schemas.OfScalar.Data(unsupported)]), // deliberate misuse
  ]));
  assert(bad.validate().length > 0, unsupported.name);
}

// --- Singletons ---

// A singleton is a reference object: `singleton` names it, and `ref` makes it one.
const Registry = store.Schemas.Object((o: any) => o.ref(true).singleton("iso3166.Registry"));
assert(Registry.singleton === "iso3166.Registry" && Registry.validate().length === 0);

// --- Unions and intersections (schema level) ---
//
// A union's branches and an intersection's parts are named: a union value holds exactly one branch, by name, and an
// intersection value every part.

const Phone = store.Schemas.Object((o: any) => o.properties([(t: any) => t.name("number").type([Text])]));
const Email = store.Schemas.Object((o: any) => o.properties([(t: any) => t.name("address").type([Text])]));

const ContactMethod = store.Schemas.Union((u: any) => u.branches([
  (t: any) => t.name("phone").type([Phone]),
  (t: any) => t.name("email").type([Email]),
]));
assert(ContactMethod.validate().length === 0);

const Unnamed = store.Schemas.Union((u: any) => u.branches([
  (t: any) => t.type([Phone]),
  (t: any) => t.name("email").type([Email]),
]));
assert(Unnamed.validate().some((p: string) => p.includes("has no name")));

const SameName = store.Schemas.Union((u: any) => u.branches([
  (t: any) => t.name("m").type([Phone]),
  (t: any) => t.name("m").type([Email]),
]));
assert(SameName.validate().some((p: string) => p.includes("more than once")));

const MixedKinds = store.Schemas.Union((u: any) => u.branches([
  (t: any) => t.name("phone").type([Phone]),
  (t: any) => t.name("text").type([Text]),
]));
assert(MixedKinds.validate().some((p: string) => p.includes("same kind")));

const SingleBranch = store.Schemas.Union((u: any) => u.branches([(t: any) => t.name("phone").type([Phone])]));
assert(SingleBranch.validate().some((p: string) => p.includes("at least two")));

// Intersections combine same-kind schemas as named parts. Each part keeps its own properties, so two parts may
// declare the same property, even with different types.
const Timestamped = store.Schemas.Object((o: any) => o.properties([(t: any) => t.name("updated").type([Text])]));
const EpochStamped = store.Schemas.Object((o: any) => o.properties([
  (t: any) => t.name("updated").type([new Schemas.OfScalar.Data(BigInt)]),
]));
const Stamps = store.Schemas.Intersection((i: any) => i.parts([
  (t: any) => t.name("text").type([Timestamped]),
  (t: any) => t.name("epoch").type([EpochStamped]),
]));
assert(Stamps.validate().length === 0);

assert(store.Schemas.Intersection((i: any) => i.parts([
  (t: any) => t.name("stamp").type([Timestamped]),
  (t: any) => t.name("text").type([Text]),
])).validate().length > 0); // mixed kinds

console.log("SchemaBuilders: all checks passed");
