// Serialization example: scalar values at their edges, strict scalar types, malformed snapshots, and a store.
//
// Uses ISO 4217 currencies: a price list maps a product -> [currency] -> money.

import { AttributeError, DecodeError, ValueError } from "@mbse/schemas/Framework/Errors";
import { Builders, JSON, Plain, Schemas, Validators } from "@mbse/schemas/Framework";
import type { PlainData, PlainMap } from "@mbse/schemas/Framework/Plain";
import type { Instance } from "@mbse/schemas/Framework/Proxies";
import { sortedStrings } from "@mbse/schemas/Framework/Repr";
import { assert, entries, equal, map, raises } from "./_support.js";


const store: any = new Builders.Store();
const Text = store.Schemas.OfStr.as_schema(); // the store's own basic scalar
const Int = store.Schemas.OfInt.as_schema(); // the store's own basic scalar

// --- Schemas ---

const { Sample, Currency, Product, Money, Prices, Denomination } = store.transaction(() => { // every write to a store is made within a transaction, all or nothing
  const Sample = store.Schemas.OfObject((o: any) => (
    o
      .name("Sample")
      .ref(true)
      .properties([
        (t: any) => t.name("label").schema([Text]),
        (t: any) => t.name("payload").schema([store.Schemas.OfBytes]),
        (t: any) => t.name("count").schema([Int]),
        (t: any) => t.name("ratio").schema([store.Schemas.OfFloat]),
        (t: any) => t.name("flag").schema([store.Schemas.OfBool]),
      ])
  ));

  // Registered names are strings and need not be identifiers: a dotted name is a path from the store.
  const Currency = store.Schemas.OfObject((o: any) => (
    o
      .name("iso4217.Currency")
      .ref(true)
      .properties([
        (t: any) => t.name("code").schema([Text]), // ISO 4217 alpha, e.g. 'JPY'
        (t: any) => t.name("numeric").schema([Text]), // ISO 4217 numeric, e.g. '392'; keeps zeros
        (t: any) => t.name("minor_units").schema([Int]), // 0 for JPY, 2 for EUR, 3 for BHD
      ])
  ));
  const Product = store.Schemas.OfObject((o: any) => o.name("Product").ref(true).properties([(t: any) => t.name("sku").schema([Text])]));
  const Money = store.Schemas.OfObject((o: any) => (
    o
      .name("Money")
      .ref(true)
      .properties([(t: any) => t.name("amount").schema([Int])]) // in minor units
  ));

  // product -> [currency] -> money
  const Prices = store.Schemas.OfRelation((r: any) => (
    r
      .name("Prices")
      .links([
        (t: any) => t.name("product"),
        (t: any) => t.name("price"),
      ])
      .properties([(t: any) => t.name("currency").schema([Text])])
      .uniques("price")
  ));
  // Which currency a money amount is in.
  const Denomination = store.Schemas.OfRelation((r: any) => (
    r
      .name("Denomination")
      .links([
        (t: any) => t.name("money"),
        (t: any) => t.name("currency"),
      ])
      .uniques("currency")
  ));

  store.Schemas.OfObject(Product, (o: any) => o.adjacencies([(t: any) => t.name("prices").relation([Prices]).me("product")]));
  store.Schemas.OfObject(Money, (o: any) => o.adjacencies([
    (t: any) => t.name("products").relation([Prices]).me("price"),
    (t: any) => t.name("currency").relation([Denomination]).me("money"),
  ]));
  store.Schemas.OfObject(Currency, (o: any) => o.adjacencies([(t: any) => t.name("amounts").relation([Denomination]).me("currency")]));
  return { Sample, Currency, Product, Money, Prices, Denomination };
});

for (const schema of [Sample, Currency, Product, Money, Prices, Denomination]) {
  assert(schema.validate().length === 0, `${schema.name}: ${schema.validate()}`);
  assert(store.registered(schema.name) === schema);
}
const bytes = (...values: number[]) => new Uint8Array(values);
const repeat = (b: Uint8Array, n: number) => new Uint8Array(Array.from({ length: n }, () => [...b]).flat());

// --- Scalar values at their edges ---

const { edge } = store.transaction(() => {
  const edge = store.Sample((s: any) => (
    s
      .label('日本語 🚀 \u0000 "quoted" \\ back') // non-ASCII, emoji, NUL, quotes, backslash
      .payload(repeat(bytes(0x00, 0xff, 0x10), 3))
      .count(2n ** 100n) // ints are unbounded
      .ratio(-0.0)
      .flag(false) // a present false is not an absent property
  ));
  return { edge };
});
const plain = Plain.ToPlain(store)(Sample, edge) as PlainMap;
const fields = (plain.get("objects") as PlainMap[])[0]!.get("properties") as PlainMap; // the root, listed first
assert(fields.get("payload") === "AP8QAP8QAP8Q"); // bytes become base64 text
assert(fields.get("flag") === false && fields.get("count") === 2n ** 100n);

// Plain data is JSON-encodable, and survives a JSON round trip.
const restored = Plain.FromPlain(store)(Sample, JSON.loads(JSON.dumps(plain))) as Instance;
assert(restored.label.get() === edge.label.get() && equal(restored.payload.get(), edge.payload.get()) && restored.count.get() === 2n ** 100n);
assert(restored.ratio.get() === 0 && Object.is(restored.ratio.get(), -0)); // the sign of -0.0 survives
assert(restored.flag.get() === false);

// Empty values are present values.
const { empty } = store.transaction(() => {
  const empty = store.Sample((s: any) => s.label("").payload(bytes()).count(0n).ratio(0.0));
  return { empty };
});
const back = Plain.FromPlain(store)(Sample, Plain.ToPlain(store)(Sample, empty)) as Instance;
assert(back.label.get() === "" && equal(back.payload.get(), bytes()) && back.count.get() === 0n && back.ratio.get() === 0);
assert(back.flag.get() === null); // never set, so absent

// An object with nothing set serializes to empty properties, listed with its number and its schema's name.
const { blank } = store.transaction(() => {
  const blank = store.Sample((s: any) => s);
  return { blank };
});
assert(equal(Plain.ToPlain(store)(Sample, blank), map({ root: { n: 0n }, objects: [{ n: 0n, schema: "Sample", properties: {} }] })));

// Per-kind entry points.
const bytesSchema = store.Schemas.OfBytes.as_schema();
assert(Plain.ToPlain(store)(bytesSchema, bytes(1)) === "AQ==" && Plain.ToPlain(store).OfScalar(bytesSchema, bytes(1)) === "AQ==");
assert(Plain.FromPlain(store).OfScalar(store.Schemas.OfInt.as_schema(), 7n) === 7n);

// --- Strict scalar types ---

// Distinct scalar types are never coerced into each other, in either direction. Reading a wrong type is a problem in
// the data: a DecodeError (a ValueError) located by a path, here the root.
const from_plain = Plain.FromPlain(store);
for (const [scalar, bad] of [[BigInt, true], [BigInt, 1.0], [BigInt, "1"], [Number, 1n], [Boolean, 0n], [String, bytes(0x78)],
  [String, null]] as const) {
  raises(DecodeError, () => from_plain(new Schemas.OfScalar.Data(scalar), bad));
}
raises(DecodeError, () => from_plain(bytesSchema, new TextEncoder().encode("raw"))); // bytes arrive as base64 text
raises(DecodeError, () => from_plain(bytesSchema, "not base64!"));

// The builder does not validate; the serializer does.
const { sloppy } = store.transaction(() => {
  const sloppy = store.Sample((s: any) => s.count("3"));
  return { sloppy };
});
assert(sloppy.count.get() === "3");
raises(TypeError, () => Plain.ToPlain(store)(Sample, sloppy));

// Validation reports it without serializing.
const validate = Validators.Validate(store);
assert(equal(validate(Sample, sloppy), ["Sample#0.count: expected int, got str"]));
assert(validate(Sample, edge).length === 0 && validate(Sample, blank).length === 0);
assert(equal(validate(store.Schemas.OfInt.as_schema(), true), ["expected int, got bool"]));

// --- A map: product -> [currency] -> money ---

const { jpy, eur, widget } = store.transaction(() => { // the data: written within a transaction, all or nothing
  const jpy = store.iso4217.Currency((c: any) => c.code("JPY").numeric("392").minor_units(0n));
  const eur = store.iso4217.Currency((c: any) => c.code("EUR").numeric("978").minor_units(2n));
  const widget = store.Product((p: any) => (
    p
      .sku("W-1")
      .prices((a: any) => a.insert((x: any) => x.price((m: any) => m.amount(1500n).currency((a: any) => a.insert((d: any) => d.currency(jpy)))).currency("JPY")))
      .prices((a: any) => a.insert((x: any) => x.price((m: any) => m.amount(1299n).currency((a: any) => a.insert((d: any) => d.currency(eur)))).currency("EUR")))
  ));
  return { jpy, eur, widget };
});
const byCurrency = (obj: Instance) =>
  new Map(entries(Product, obj, "prices").map((e) => [e.get("currency"), (e.get("price") as Instance).amount.get()]));
assert(equal(byCurrency(widget), map({ JPY: 1500n, EUR: 1299n })));

const graph = Plain.ToPlain(store).Reachable(Product, widget);
const objectsOf = (g: PlainMap) => (g.get("objects") as PlainMap[]).map((o) => o.get("properties") as PlainMap);
assert(equal(sortedStrings(objectsOf(graph).filter((o) => o.has("code")).map((o) => o.get("code") as string)), ["EUR", "JPY"]));
const schemasNamed = new Set((graph.get("objects") as PlainMap[]).map((o) => o.get("schema") as string)); // each listed with its schema
assert(equal(sortedStrings(schemasNamed), ["Money", "Product", "iso4217.Currency"]));
const again = from_plain.Reachable(Product, JSON.loads(JSON.dumps(graph))) as Instance;
assert(equal(byCurrency(again), byCurrency(widget)));

assert(validate.Reachable(Product, widget).length === 0);

// uniques('price') on Prices: (product, currency) determine the price. A second JPY price breaks it.
const { gadget } = store.transaction(() => {
  const gadget = store.Product((p: any) => (
    p
      .sku("G-1")
      .prices((a: any) => a.insert((x: any) => x.price((m: any) => m.amount(900n)).currency("JPY")))
      .prices((a: any) => a.insert((x: any) => x.price((m: any) => m.amount(950n)).currency("JPY")))
  ));
  return { gadget };
});
assert(equal(validate(Product, gadget), ["unique(price) violated: entries agreeing on ['currency', 'product'] differ on ['price']"]));

// The root must be an instance of the schema given.
assert(validate(Currency, widget).length > 0);

// --- Malformed snapshots are rejected ---

const good = Plain.ToPlain(store).Reachable(Product, widget);
const root = good.get("root") as PlainMap;
/** The object a snapshot lists as `call`: its path, or a counted object's number. */
const listed = (s: PlainMap, call: PlainData) => (s.get("objects") as PlainMap[])
  .find((o) => equal(o.has("path") ? o.get("path") : new Map([["n", o.get("n")!]]), call)) as PlainMap;
const objectsIn = (s: PlainMap) => s.get("objects") as PlainMap[];
const pricesOf = (s: PlainMap) => (listed(s, root).get("properties") as PlainMap).get("prices") as PlainMap[];
const priceRef = (pricesOf(good)[0] as PlainMap).get("price") as PlainMap;

function mutated(change: (snapshot: PlainMap) => unknown): PlainMap {
  const snapshot = JSON.loads(JSON.dumps(good)) as PlainMap;
  change(snapshot);
  return snapshot;
}

const badSnapshots: PlainData[] = [
  [], // not a snapshot
  map({ root }), // no objects
  new Map<string, PlainData>([["root", map({ n: 99n })], ["objects", good.get("objects") as PlainData]]), // root not in objects
  mutated((s) => objectsIn(s).splice(objectsIn(s).indexOf(listed(s, priceRef.get("$ref") as PlainData)), 1)), // unresolved reference
  mutated((s) => listed(s, priceRef.get("$ref") as PlainData).set("schema", "Product")), // its properties are not its schema's
  mutated((s) => objectsIn(s).push(listed(s, root))), // an object listed twice
  mutated((s) => (listed(s, root).get("properties") as PlainMap).set("colour", "red")), // not a property or adjacency
  mutated((s) => (pricesOf(s)[0] as PlainMap).set("discount", 5n)), // not a link or property
];
for (const snapshot of badSnapshots) raises(DecodeError, () => from_plain.Reachable(Product, snapshot));

// A single-object snapshot leaves references unresolved, so it cannot be deserialized on its own.
raises(DecodeError, () => from_plain(Product, Plain.ToPlain(store)(Product, widget)));

// The root must be an instance of the schema given.
raises(TypeError, () => Plain.ToPlain(store)(Currency, widget));

// --- Store corner cases ---

store.transaction(() => { // each refused before it writes
  raises(ValueError, () => store.Schemas.OfObject((o: any) => o.name("Sample"))); // a named schema's identity is its name, which Sample holds
  raises(AttributeError, () => store.Unregistered((u: any) => u));
  raises(TypeError, () => store.Product()); // a callback, an object and a callback, or an object
  raises(TypeError, () => store.Prices((p: any) => p)); // no relation builder is exposed
  raises(TypeError, () => store.Product(jpy)); // the source instance must have the builder's schema
  raises(TypeError, () => store.Product((p: any) => p.colour("red"))); // not a property or adjacency: it reads as empty, and refuses a write
});
raises(AttributeError, () => {
  (widget as any).sku = "W-2"; // instances are read-only
});

// A schema named 'schema' is shadowed by the store's schema() method, but still reachable by name.
store.transaction(() => {
  const Shadowed = store.Schemas.OfObject((o: any) => o.name("schema").ref(true).properties([(t: any) => t.name("label").schema([Text])]));
  assert(store.schema("schema") === Shadowed && store.builder("schema").create().as_schema().name === "schema");
});

console.log("Serialization: all checks passed");
