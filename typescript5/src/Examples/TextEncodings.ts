// Text encodings example: JSON and YAML round trips over edge values and a small graph.
//
// JSON and YAML are thin encodings of Plain data, so all three produce the same plain data. Weather stations and
// readings use ISO 8601 timestamps and WMO station identifiers.

import * as Y from "yaml";

import { DecodeError } from "@mbse/schemas/Framework/Errors";
import { JSON, Plain, Proxies, Schemas, Validators, YAML } from "@mbse/schemas/Framework";
import type { Instance } from "@mbse/schemas/Framework/Proxies";
import { assert, equal, raises, same_graph } from "./_support.js";

const store = new Proxies.OfStore();

// --- Schemas ---

let Reading = new Schemas.OfObject.Builder().name("Reading").ref()
  .properties(
    (prop) => prop.name("observed").of((t) => t.as_native(String)), // ISO 8601, e.g. '2026-09-28T12:00:00Z'
    (prop) => prop.name("value").of((t) => t.as_native(Number)),
    (prop) => prop.name("quality").of((t) => t.as_native(BigInt)),
    (prop) => prop.name("valid").of((t) => t.as_native(Boolean)),
    (prop) => prop.name("raw").of((t) => t.as_native(Uint8Array)),
    (prop) => prop.name("note").of((t) => t.as_native(String)),
  )
  .create();
let Station = new Schemas.OfObject.Builder().name("Station").ref()
  .properties(
    (prop) => prop.name("wmo_id").of((t) => t.as_native(String)), // e.g. '03772'; leading zeros matter
    (prop) => prop.name("name").of((t) => t.as_native(String)),
  )
  .create();
const Readings = new Schemas.OfRelation.Builder().name("Readings")
  .links("station", "reading")
  .properties((prop) => prop.name("sensor").of((t) => t.as_native(String)))
  .unique("station", "sensor") // each reading comes from one sensor of one station
  .create();
Station = new Schemas.OfObject.Builder(Station).relations((adj) => adj.name("readings").of(Readings).me("station")).update();
Reading = new Schemas.OfObject.Builder(Reading).relations((adj) => adj.name("station").of(Readings).me("reading")).update();

for (const schema of [Reading, Station, Readings]) {
  store.register(schema);
}
const validate = Validators.Validate(store);
const from_json = JSON.FromJSON(store);
const from_yaml = YAML.FromYAML(store);
/** A stock YAML 1.1 reader, standing in for PyYAML's `yaml.safe_load`. */
const yaml11 = (text: string) => Y.parse(text, { version: "1.1", intAsBigInt: true, mapAsMap: true });

// --- Floats at their edges, through every encoding ---

for (const value of [0.0, -0.0, 1e308, 5e-324, 0.1, Infinity, -Infinity, NaN]) {
  const reading = store.Reading().value(value).create();
  for (const back of [
    Plain.FromPlain(store)(Reading, Plain.ToPlain(store)(Reading, reading)),
    from_json(Reading, JSON.ToJSON(store)(Reading, reading)),
    from_yaml(Reading, YAML.ToYAML(store)(Reading, reading)),
  ] as Instance[]) {
    if (Number.isNaN(value)) assert(Number.isNaN(back.value));
    else assert(Object.is(back.value, value));
  }
}

// Non-finite floats have a plain form, so JSON output stays strict (no NaN / Infinity literals).
let text = JSON.ToJSON(store)(Reading, store.Reading().value(NaN).create());
assert(text.includes('"NaN"') && globalThis.JSON.parse(text));

// --- Every native type at once, and the three encodings agree ---

const sample = store.Reading()
  .observed("2026-09-28T12:00:00Z")
  .value(-0.0)
  .quality(2n ** 70n) // ints are unbounded; other languages may need a wider type
  .valid(false)
  .raw(new Uint8Array([0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff]))
  .note('日本語 🚀 \x00 "quoted" \\ back\nsecond line')
  .create();
const plain = Plain.ToPlain(store)(Reading, sample);
assert(equal(JSON.loads(JSON.ToJSON(store)(Reading, sample)), plain));
assert(equal(YAML.loads(YAML.ToYAML(store)(Reading, sample)), plain));
assert(equal(JSON.loads(JSON.ToJSON(store)(Reading, sample, { indent: 2 })), plain)); // formatting does not change content

for (const back of [from_json(Reading, JSON.ToJSON(store)(Reading, sample)), from_yaml(Reading, YAML.ToYAML(store)(Reading, sample))] as Instance[]) {
  assert(back.observed === sample.observed && back.quality === sample.quality && back.valid === sample.valid &&
    equal(back.raw, sample.raw) && back.note === sample.note);
  assert(validate(Reading, back).length === 0);
}

// --- Strings that YAML readers like to misread ---

const tricky = ["yes", "No", "on", "OFF", "true", "null", "~", "", "010", "0o17", "0x1F", "1e3", "1_000", "1:30",
  "2026-09-01", ".inf", ".nan", "NaN", "Infinity", "-0.0", " lead", "trail ", "a: b", "- dash", "#hash",
  "x #y", '"dq"', "'sq'", "@at", "`tick", "%pct", "!bang", "&amp", "*star", "|", ">", "{}", "[]", "<<"];
for (const note of tricky) {
  const reading = store.Reading().note(note).create();
  text = YAML.ToYAML(store)(Reading, reading);
  assert((from_yaml(Reading, text) as Instance).note === note, note);
  // The output is also read correctly by a stock YAML 1.1 loader.
  assert(equal(yaml11(text), Plain.ToPlain(store)(Reading, reading)), note);
}

// WMO identifiers keep their leading zeros in both encodings.
const paris = store.Station().wmo_id("07149").name("Paris-Orly").create();
assert((from_json(Station, JSON.ToJSON(store)(Station, paris)) as Instance).wmo_id === "07149");
assert((from_yaml(Station, YAML.ToYAML(store)(Station, paris)) as Instance).wmo_id === "07149");

// --- Hand-written YAML follows the YAML 1.2 core schema ---

const written = `
root: s0
objects:
  s0:
    observed: 2026-09-28T12:00:00Z   # unquoted, but stays a string
    quality: 010                     # ten, not eight
    value: .inf
    valid: true
    note: 1:30                       # a string, not ninety
`;
const reading = from_yaml(Reading, written) as Instance;
assert(reading.observed === "2026-09-28T12:00:00Z" && reading.quality === 10n && reading.value === Infinity &&
  reading.valid === true && reading.note === "1:30");

// 'yes' is a string in YAML 1.2, so it is not accepted for a bool.
raises(DecodeError, () => from_yaml(Reading, "root: s0\nobjects:\n  s0:\n    valid: yes\n"));

// --- Malformed text is rejected ---

for (const bad of ['{"root": "s0", "objects": {"s0": {"value": NaN}}}', // NaN literal: not JSON
  '{"root": "s0", "root": "s1", "objects": {}}', // duplicate key
  '{"root": "s0", "objects": ', // truncated
  '{"root": "s0", "objects": {"s0": {"value": "nan"}}}']) { // only 'NaN', 'Infinity', '-Infinity'
  raises(DecodeError, () => from_json(Reading, bad));
}

for (const bad of ["root: s0\nroot: s1\nobjects: {}", // duplicate key
  "root: s0\nobjects:\n  s0:\n    raw: !!binary AAAA", // tagged binary: not plain data
  "1: x", // non-string key
  "---\nroot: s0\n---\nroot: s1", // two documents
  "root: [unclosed"]) {
  raises(DecodeError, () => from_yaml(Reading, bad));
}

// --- A graph through each encoding ---

const lyon = store.Station()
  .wmo_id("07480")
  .name("Lyon-Saint-Exupéry")
  .readings((x: any) => x.reading((r: any) => r.observed("2026-09-28T06:00:00Z").value(11.5).valid(true)).sensor("temp"))
  .readings((x: any) => x.reading((r: any) => r.observed("2026-09-28T06:00:00Z").value(71.0).valid(true)).sensor("rh"))
  .create();
const graph = Plain.ToPlain(store).Reachable(Station, lyon);
for (const [encoded, decode] of [[JSON.ToJSON(store).Reachable(Station, lyon), from_json.Reachable],
  [YAML.ToYAML(store).Reachable(Station, lyon), from_yaml.Reachable]] as const) {
  const restored = decode(Station, encoded) as Instance;
  assert(restored !== lyon && restored.name === "Lyon-Saint-Exupéry");
  assert(same_graph(Plain.ToPlain(store).Reachable(Station, restored), graph));
  assert(validate.Reachable(Station, restored).length === 0);
}

// A single-object snapshot leaves references unresolved, in any encoding.
raises(DecodeError, () => from_json(Station, JSON.ToJSON(store)(Station, lyon)));
raises(DecodeError, () => from_yaml(Station, YAML.ToYAML(store)(Station, lyon)));

console.log("TextEncodings: all checks passed");
