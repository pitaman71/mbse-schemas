// Serialization example: native values at their edges, strict native types, malformed snapshots, and the registry.
//
// Uses ISO 4217 currencies: a price list maps a product -> [currency] -> money.

import { AttributeError, ValueError } from "../Framework/Errors.js";
import { JSON, Plain, Proxies, Schemas, Validators } from "../Framework/index.js";
import type { PlainData, PlainMap } from "../Framework/Plain.js";
import type { Instance } from "../Framework/Proxies.js";
import { sortedStrings } from "../Framework/Repr.js";
import { assert, entries, equal, map, raises } from "./_support.js";

// --- Schemas ---

const Sample = new Schemas.OfObject.Builder()
  .properties(
    (prop) => prop.name("label").of((t) => t.as_native(String)),
    (prop) => prop.name("payload").of((t) => t.as_native(Uint8Array)),
    (prop) => prop.name("count").of((t) => t.as_native(BigInt)),
    (prop) => prop.name("ratio").of((t) => t.as_native(Number)),
    (prop) => prop.name("flag").of((t) => t.as_native(Boolean)),
  )
  .create();

let Currency = new Schemas.OfObject.Builder()
  .properties(
    (prop) => prop.name("code").of((t) => t.as_native(String)), // ISO 4217 alpha, e.g. 'JPY'
    (prop) => prop.name("numeric").of((t) => t.as_native(String)), // ISO 4217 numeric, e.g. '392'; keeps zeros
    (prop) => prop.name("minor_units").of((t) => t.as_native(BigInt)), // 0 for JPY, 2 for EUR, 3 for BHD
  )
  .create();
let Product = new Schemas.OfObject.Builder().properties((prop) => prop.name("sku").of((t) => t.as_native(String))).create();
let Money = new Schemas.OfObject.Builder()
  .properties((prop) => prop.name("amount").of((t) => t.as_native(BigInt))) // in minor units
  .create();

// product -> [currency] -> money
const Prices = new Schemas.OfRelation.Builder()
  .links("product", "price")
  .properties((prop) => prop.name("currency").of((t) => t.as_native(String)))
  .unique("price")
  .create();
// Which currency a money amount is in.
const Denomination = new Schemas.OfRelation.Builder().links("money", "currency").unique("currency").create();

Product = new Schemas.OfObject.Builder(Product).relations((adj) => adj.name("prices").of(Prices).me("product")).update();
Money = new Schemas.OfObject.Builder(Money)
  .relations(
    (adj) => adj.name("products").of(Prices).me("price"),
    (adj) => adj.name("currency").of(Denomination).me("money"),
  )
  .update();
Currency = new Schemas.OfObject.Builder(Currency).relations((adj) => adj.name("amounts").of(Denomination).me("currency")).update();

// Registered names are strings and need not be identifiers.
for (const [name, schema] of [["Sample", Sample], ["iso4217.Currency", Currency], ["Product", Product], ["Money", Money],
  ["Prices", Prices], ["Denomination", Denomination]] as const) {
  assert(schema.validate().length === 0, `${name}: ${schema.validate()}`);
  Proxies.register(name, schema);
}
const Builders = Proxies.Builders;
const bytes = (...values: number[]) => new Uint8Array(values);
const repeat = (b: Uint8Array, n: number) => new Uint8Array(Array.from({ length: n }, () => [...b]).flat());

// --- Native values at their edges ---

const edge = Builders.Sample()
  .label('日本語 🚀 \u0000 "quoted" \\ back') // non-ASCII, emoji, NUL, quotes, backslash
  .payload(repeat(bytes(0x00, 0xff, 0x10), 3))
  .count(2n ** 100n) // ints are unbounded
  .ratio(-0.0)
  .flag(false) // a present false is not an absent property
  .create();
const plain = Plain.ToPlain(Sample, edge) as PlainMap;
const fields = (plain.get("objects") as PlainMap).get(plain.get("root") as string) as PlainMap;
assert(fields.get("payload") === "AP8QAP8QAP8Q"); // bytes become base64 text
assert(fields.get("flag") === false && fields.get("count") === 2n ** 100n);

// Plain data is JSON-encodable, and survives a JSON round trip.
const restored = Plain.FromPlain(Proxies.Builders)(Sample, JSON.loads(JSON.dumps(plain))) as Instance;
assert(restored.label === edge.label && equal(restored.payload, edge.payload) && restored.count === 2n ** 100n);
assert(restored.ratio === 0 && Object.is(restored.ratio, -0)); // the sign of -0.0 survives
assert(restored.flag === false);

// Empty values are present values.
const empty = Builders.Sample().label("").payload(bytes()).count(0n).ratio(0.0).create();
const back = Plain.FromPlain(Proxies.Builders)(Sample, Plain.ToPlain(Sample, empty)) as Instance;
assert(back.label === "" && equal(back.payload, bytes()) && back.count === 0n && back.ratio === 0);
raises(AttributeError, () => back.flag); // never set, so absent

// An object with nothing set serializes to an empty object.
const blank = Builders.Sample().create();
assert(equal(Plain.ToPlain(Sample, blank), map({ root: "s0", objects: { s0: {} } })));

// Per-kind entry points.
const bytesSchema = new Schemas.OfNative.Data(Uint8Array);
assert(Plain.ToPlain(bytesSchema, bytes(1)) === "AQ==" && Plain.ToPlain.OfNative(bytesSchema, bytes(1)) === "AQ==");
assert(Plain.FromPlain(Proxies.Builders).OfNative(new Schemas.OfNative.Data(BigInt), 7n) === 7n);

// --- Strict native types ---

// Distinct native types are never coerced into each other, in either direction.
const from_plain = Plain.FromPlain(Proxies.Builders);
for (const [native, bad] of [[BigInt, true], [BigInt, 1.0], [BigInt, "1"], [Number, 1n], [Boolean, 0n], [String, bytes(0x78)],
  [String, null]] as const) {
  raises(TypeError, () => from_plain(new Schemas.OfNative.Data(native), bad));
}
raises(TypeError, () => from_plain(bytesSchema, new TextEncoder().encode("raw"))); // bytes arrive as base64 text
raises(ValueError, () => from_plain(bytesSchema, "not base64!"));

// The builder does not validate; the serializer does.
const sloppy = Builders.Sample().count("3").create();
assert(sloppy.count === "3");
raises(TypeError, () => Plain.ToPlain(Sample, sloppy));

// Validation reports it without serializing.
const validate = Validators.Validate(Proxies.Builders);
assert(equal(validate(Sample, sloppy), ["Sample#0.count: expected int, got str"]));
assert(validate(Sample, edge).length === 0 && validate(Sample, blank).length === 0);
assert(equal(validate(new Schemas.OfNative.Data(BigInt), true), ["expected int, got bool"]));

// --- A map: product -> [currency] -> money ---

const jpy = Builders["iso4217.Currency"]().code("JPY").numeric("392").minor_units(0n).create();
const eur = Builders["iso4217.Currency"]().code("EUR").numeric("978").minor_units(2n).create();
const widget = Builders.Product()
  .sku("W-1")
  .prices((x: any) => x.price((m: any) => m.amount(1500n).currency((d: any) => d.currency(jpy))).currency("JPY"))
  .prices((x: any) => x.price((m: any) => m.amount(1299n).currency((d: any) => d.currency(eur))).currency("EUR"))
  .create();
const byCurrency = (obj: Instance) =>
  new Map(entries(Product, obj, "prices").map((e) => [e.get("currency"), (e.get("price") as Instance).amount]));
assert(equal(byCurrency(widget), map({ JPY: 1500n, EUR: 1299n })));

const graph = Plain.ToPlain.Reachable(Product, widget);
const objectsOf = (g: PlainMap) => [...(g.get("objects") as Map<string, PlainMap>).values()];
assert(equal(sortedStrings(objectsOf(graph).filter((o) => o.has("code")).map((o) => o.get("code") as string)), ["EUR", "JPY"]));
const schemasNamed = new Set(objectsOf(graph).flatMap((obj) => [...obj.values()].filter(Array.isArray)
  .flatMap((list) => (list as PlainMap[]).flatMap((e) => [...e.values()].filter((v) => v instanceof Map)
    .map((ref) => (ref as PlainMap).get("$schema"))))));
assert(equal(sortedStrings(schemasNamed as Set<string>), ["Money", "Product", "iso4217.Currency"]));
const again = from_plain.Reachable(Product, JSON.loads(JSON.dumps(graph))) as Instance;
assert(equal(byCurrency(again), byCurrency(widget)));

assert(validate.Reachable(Product, widget).length === 0);

// unique('price') on Prices: (product, currency) determine the price. A second JPY price breaks it.
const gadget = Builders.Product()
  .sku("G-1")
  .prices((x: any) => x.price((m: any) => m.amount(900n)).currency("JPY"))
  .prices((x: any) => x.price((m: any) => m.amount(950n)).currency("JPY"))
  .create();
assert(equal(validate(Product, gadget), ["unique(price) violated: entries agreeing on ['currency', 'product'] differ on ['price']"]));

// The root must be an instance of the schema given.
assert(validate(Currency, widget).length > 0);

// --- Malformed snapshots are rejected ---

const good = Plain.ToPlain.Reachable(Product, widget);
const root = good.get("root") as string;
const objectsIn = (s: PlainMap) => s.get("objects") as Map<string, PlainMap>;
const pricesOf = (s: PlainMap) => (objectsIn(s).get(root) as PlainMap).get("prices") as PlainMap[];
const priceRef = (pricesOf(good)[0] as PlainMap).get("price") as PlainMap;

function mutated(change: (snapshot: PlainMap) => unknown): PlainMap {
  const snapshot = JSON.loads(JSON.dumps(good)) as PlainMap;
  change(snapshot);
  return snapshot;
}

const badSnapshots: PlainData[] = [
  [], // not a snapshot
  map({ root }), // no objects
  new Map<string, PlainData>([["root", "nope"], ["objects", good.get("objects") as PlainData]]), // root not in objects
  mutated((s) => objectsIn(s).delete(priceRef.get("$ref") as string)), // unresolved reference
  mutated((s) => (pricesOf(s)[1] as PlainMap).set("price", map({ $ref: priceRef.get("$ref"), $schema: "Product" }))),
  mutated((s) => objectsIn(s).set("s99", map({ sku: "orphan" }) as PlainMap)), // an object nothing references
  mutated((s) => (objectsIn(s).get(root) as PlainMap).set("colour", "red")), // not a property or adjacency
  mutated((s) => (pricesOf(s)[0] as PlainMap).set("discount", 5n)), // not a link or property
];
for (const snapshot of badSnapshots) raises(ValueError, () => from_plain.Reachable(Product, snapshot));

// A single-object snapshot leaves references unresolved, so it cannot be deserialized on its own.
raises(ValueError, () => from_plain(Product, Plain.ToPlain(Product, widget)));

// The root must be an instance of the schema given.
raises(TypeError, () => Plain.ToPlain(Currency, widget));

// --- Registry corner cases ---

raises(ValueError, () => Proxies.register("Sample", Sample)); // names are registered once
raises(AttributeError, () => Builders.Unregistered());
raises(TypeError, () => Builders.Prices()); // no relation builder is exposed
raises(TypeError, () => Builders.Product(jpy)); // the source instance must have the builder's schema
raises(AttributeError, () => Builders.Product().colour("red")); // not a property or adjacency
raises(AttributeError, () => {
  (widget as any).sku = "W-2"; // instances are read-only
});

// A schema registered as 'schema' is shadowed by the Builders.schema() method, but still reachable by name.
Proxies.register("schema", Sample);
assert(Proxies.schema("schema") === Sample && Builders.schema("schema") === Sample);

console.log("Serialization: all checks passed");
