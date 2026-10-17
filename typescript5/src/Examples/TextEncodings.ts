// Text encodings example: JSON and YAML round trips over edge values and a small graph.
//
// JSON and YAML are thin encodings of Plain data, so all three produce the same plain data. Weather stations and
// readings use ISO 8601 timestamps and WMO station identifiers.

import * as Y from "yaml";

import { DecodeError } from "@mbse/schemas/Framework/Errors";
import { Builders, JSON, Paths, Plain, Proxies, Schemas, Validators, YAML } from "@mbse/schemas/Framework";
import type { Instance } from "@mbse/schemas/Framework/Proxies";
import { assert, equal, raises, same_graph } from "./_support.js";


const store: any = new Builders.Store();
const Text = store.Schemas.OfStr.as_schema(); // the store's own basic scalar

// --- Schemas ---

const Reading = store.Schemas.OfObject((o: any) => (
  o
    .name("Reading")
    .ref(true)
    .properties([
      (t: any) => t.name("observed").schema([Text]), // ISO 8601, e.g. '2026-09-28T12:00:00Z'
      (t: any) => t.name("value").schema([store.Schemas.OfFloat]),
      (t: any) => t.name("quality").schema([store.Schemas.OfInt]),
      (t: any) => t.name("valid").schema([store.Schemas.OfBool]),
      (t: any) => t.name("raw").schema([store.Schemas.OfBytes]),
      (t: any) => t.name("note").schema([Text]),
    ])
));
const Station = store.Schemas.OfObject((o: any) => (
  o
    .name("Station")
    .ref(true)
    .properties([
      (t: any) => t.name("wmo_id").schema([Text]), // e.g. '03772'; leading zeros matter
      (t: any) => t.name("name").schema([Text]),
    ])
));
const Readings = store.Schemas.OfRelation((r: any) => (
  r
    .name("Readings")
    .links([
      (t: any) => t.name("station"),
      (t: any) => t.name("reading"),
    ])
    .properties([(t: any) => t.name("sensor").schema([Text])])
    .uniques(["station", "sensor"]) // each reading comes from one sensor of one station
));
store.Schemas.OfObject(Station, (o: any) => o.adjacencies([(t: any) => t.name("readings").relation([Readings]).me("station")]));
store.Schemas.OfObject(Reading, (o: any) => o.adjacencies([(t: any) => t.name("station").relation([Readings]).me("reading")]));

const validate = Validators.Validate(store);
const from_json = JSON.FromJSON(store);
const from_yaml = YAML.FromYAML(store);
/** A stock YAML 1.1 reader, standing in for PyYAML's `yaml.safe_load`. */
const yaml11 = (text: string) => Y.parse(text, { version: "1.1", intAsBigInt: true, mapAsMap: true });

// --- Floats at their edges, through every encoding ---

for (const value of [0.0, -0.0, 1e308, 5e-324, 0.1, Infinity, -Infinity, NaN]) {
  const reading = store.Reading((r: any) => r.value(value));
  for (const back of [
    Plain.FromPlain(store)(Reading, Plain.ToPlain(store)(Reading, reading)),
    from_json(Reading, JSON.ToJSON(store)(Reading, reading)),
    from_yaml(Reading, YAML.ToYAML(store)(Reading, reading)),
  ] as Instance[]) {
    if (Number.isNaN(value)) assert(Number.isNaN(back.value.get()));
    else assert(Object.is(back.value.get(), value));
  }
}

// Non-finite floats have a plain form, so JSON output stays strict (no NaN / Infinity literals).
let text = JSON.ToJSON(store)(Reading, store.Reading((r: any) => r.value(NaN)));
assert(text.includes('"NaN"') && globalThis.JSON.parse(text));

// --- Every scalar type at once, and the three encodings agree ---

const sample = store.Reading((r: any) => (
  r
    .observed("2026-09-28T12:00:00Z")
    .value(-0.0)
    .quality(2n ** 70n) // ints are unbounded; other languages may need a wider type
    .valid(false)
    .raw(new Uint8Array([0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff]))
    .note('日本語 🚀 \x00 "quoted" \\ back\nsecond line')
));
const plain = Plain.ToPlain(store)(Reading, sample);
assert(equal(JSON.loads(JSON.ToJSON(store)(Reading, sample)), plain));
assert(equal(YAML.loads(YAML.ToYAML(store)(Reading, sample)), plain));
assert(equal(JSON.loads(JSON.ToJSON(store)(Reading, sample, { indent: 2 })), plain)); // formatting does not change content

for (const back of [from_json(Reading, JSON.ToJSON(store)(Reading, sample)), from_yaml(Reading, YAML.ToYAML(store)(Reading, sample))] as Instance[]) {
  assert(back.observed.get() === sample.observed.get() && back.quality.get() === sample.quality.get() && back.valid.get() === sample.valid.get() &&
    equal(back.raw.get(), sample.raw.get()) && back.note.get() === sample.note.get());
  assert(validate(Reading, back).length === 0);
}

// --- Strings that YAML readers like to misread ---

const tricky = ["yes", "No", "on", "OFF", "true", "null", "~", "", "010", "0o17", "0x1F", "1e3", "1_000", "1:30",
  "2026-09-01", ".inf", ".nan", "NaN", "Infinity", "-0.0", " lead", "trail ", "a: b", "- dash", "#hash",
  "x #y", '"dq"', "'sq'", "@at", "`tick", "%pct", "!bang", "&amp", "*star", "|", ">", "{}", "[]", "<<"];
for (const note of tricky) {
  const reading = store.Reading((r: any) => r.note(note));
  text = YAML.ToYAML(store)(Reading, reading);
  assert((from_yaml(Reading, text) as Instance).note.get() === note, note);
  // The output is also read correctly by a stock YAML 1.1 loader.
  assert(equal(yaml11(text), Plain.ToPlain(store)(Reading, reading)), note);
}

// WMO identifiers keep their leading zeros in both encodings.
const paris = store.Station((s: any) => s.wmo_id("07149").name("Paris-Orly"));
assert((from_json(Station, JSON.ToJSON(store)(Station, paris)) as Instance).wmo_id.get() === "07149");
assert((from_yaml(Station, YAML.ToYAML(store)(Station, paris)) as Instance).wmo_id.get() === "07149");

// --- Hand-written YAML follows the YAML 1.2 core schema ---

/** The path of the reading its schema owns under `key`, as YAML: the root module, the schema, then the key. */
const at = (key: string) => "{singleton: ., next: {entry: {i: schemas, o: '', properties: {name: Reading}, next: {entry: {i: instances, "
  + `o: '', properties: {name: ${key}}, next: {target: {}}}}}}}`;

const written = `
root: ${at("noon")}
objects:
  - path: ${at("noon")}
    schema: Reading
    properties:
      observed: 2026-09-28T12:00:00Z   # unquoted, but stays a string
      quality: 010                     # ten, not eight
      value: .inf
      valid: true
      note: 1:30                       # a string, not ninety
`;
const reading = from_yaml(Reading, written) as Instance;
assert(reading.observed.get() === "2026-09-28T12:00:00Z" && reading.quality.get() === 10n && reading.value.get() === Infinity &&
  reading.valid.get() === true && reading.note.get() === "1:30");

// 'yes' is a string in YAML 1.2, so it is not accepted for a bool.
raises(DecodeError, () => from_yaml(Reading, `root: ${at("noon")}\nobjects:\n  - path: ${at("noon")}\n    schema: Reading\n    properties:\n      valid: yes\n`));

// --- Malformed text is rejected ---

const a = JSON.dumps((Plain.ToPlain(store)(Reading, store.Reading((r: any) => r)) as any).get("root")); // a reading's path, as JSON
for (const bad of [`{"root": ${a}, "objects": [{"path": ${a}, "schema": "Reading", "properties": {"value": NaN}}]}`, // not JSON
  `{"root": ${a}, "root": ${a}, "objects": []}`, // duplicate key
  `{"root": ${a}, "objects": `, // truncated
  `{"root": ${a}, "objects": [{"path": ${a}, "schema": "Reading", "properties": {"value": "nan"}}]}`]) { // only 'NaN', 'Infinity', '-Infinity'
  raises(DecodeError, () => from_json(Reading, bad));
}

for (const bad of [`root: ${at("a")}\nroot: ${at("b")}\nobjects: []`, // duplicate key
  `root: ${at("a")}\nobjects:\n  - path: ${at("a")}\n    schema: Reading\n    properties:\n      raw: !!binary AAAA`, // tagged binary: not plain data
  "1: x", // non-string key
  `---\nroot: ${at("a")}\n---\nroot: ${at("b")}`, // two documents
  "root: [unclosed"]) {
  raises(DecodeError, () => from_yaml(Reading, bad));
}

// --- A graph through each encoding ---

const lyon = store.Station((s: any) => (
  s
    .wmo_id("07480")
    .name("Lyon-Saint-Exupéry")
    .readings((a: any) => a.insert((x: any) => x.reading((r: any) => r.observed("2026-09-28T06:00:00Z").value(11.5).valid(true)).sensor("temp")))
    .readings((a: any) => a.insert((x: any) => x.reading((r: any) => r.observed("2026-09-28T06:00:00Z").value(71.0).valid(true)).sensor("rh")))
));
const graph = Plain.ToPlain(store).Reachable(Station, lyon);
for (const [encoded, decoder] of [[JSON.ToJSON(store).Reachable(Station, lyon), JSON.FromJSON],
  [YAML.ToYAML(store).Reachable(Station, lyon), YAML.FromYAML]] as const) {
  const elsewhere: any = new Builders.Store(); // read into another store: objects of the same identities
  Plain.FromPlain(elsewhere).Snapshot(Plain.ToPlain(store).Snapshot()); // the same schemas, its own: a store's snapshot writes them
  const restored = decoder(elsewhere).Reachable(elsewhere.Station, encoded) as Instance;
  assert(restored !== lyon && Paths.same(restored.as_identity(), lyon.as_identity()));
  assert(String(restored.name) === "Lyon-Saint-Exupéry");
  assert(same_graph(Plain.ToPlain(elsewhere).Reachable(elsewhere.Station, restored), graph));
  assert(Validators.Validate(elsewhere).Reachable(elsewhere.Station, restored).length === 0);
}

// A single-object snapshot leaves references unresolved, in any encoding.
raises(DecodeError, () => from_json(Station, JSON.ToJSON(store)(Station, lyon)));
raises(DecodeError, () => from_yaml(Station, YAML.ToYAML(store)(Station, lyon)));

console.log("TextEncodings: all checks passed");
