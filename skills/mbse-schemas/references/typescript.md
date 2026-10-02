# mbse-schemas in TypeScript

Import from `@mbse/schemas/Framework`, and error classes from `@mbse/schemas/Framework/Errors`. The API mirrors
Python name for name, snake_case included (`as_native`, `properties_of`). It runs on Node 22+, in browsers and in
Deno.

## A complete program

Components own ports, wires connect ports and carry a label, and each port describes its signal as a value object.
It writes the same JSON as the Python version, byte for byte.

```typescript
import { JSON, Proxies, Schemas as S, Validators } from "@mbse/schemas/Framework";

const native = (name: string, type: S.OfNative.Spec) => (p: S.OfProperty.Builder) => p.name(name).of((t) => t.as_native(type));

// A value with no identity: a value object.
const Signal = new S.OfObject.Builder().properties(native("width", BigInt), native("unit", String)).create();

// Things with identity: object schemas.
const Component = new S.OfObject.Builder().ref().properties(native("name", String)).create();
const Port = new S.OfObject.Builder().ref().properties(native("name", String), (p) => p.name("signal").of(Signal)).create();

// Every collection is a relation. unique("owner"): entries that agree on the port agree on the owner.
const Ownership = new S.OfRelation.Builder().links("owner", "port").unique("owner").create();
const Wire = new S.OfRelation.Builder().links("source", "target").properties(native("label", String)).create();

// Each object sees a relation through one of its links (an adjacency).
new S.OfObject.Builder(Component).relations((r) => r.name("ports").of(Ownership).me("owner")).update();
new S.OfObject.Builder(Port).relations((r) => r.name("owner").of(Ownership).me("port"),
  (r) => r.name("fanout").of(Wire).me("source"),
  (r) => r.name("fanin").of(Wire).me("target")).update();
// A store holds the schemas by name, and the objects built with them.
const store = new Proxies.OfStore();
for (const [name, schema] of [["Component", Component], ["Port", Port], ["Ownership", Ownership], ["Wire", Wire]] as const) {
  store.register(name, schema);
}
const B = store;

const irq = B.Port().name("irq").signal((s: any) => s.width(1n).unit("bit")).create();
const picIn = B.Port().name("pic_in").create();
const cpu = B.Component().name("cpu").ports((e: any) => e.port(irq)).create();
B.Port(irq).fanout((e: any) => e.target(picIn).label("interrupt")).update();
if (irq.signal.width !== 1n) throw new Error("unexpected width");

const text = JSON.ToJSON(store).Reachable(Component, cpu);
const copy = JSON.FromJSON(B).Reachable(Component, text) as Proxies.Instance; // decoders return unknown
if (Validators.Validate(B).Reachable(Component, copy).length > 0) throw new Error("invalid");
```

## Differences from Python

| Python | TypeScript |
|---|---|
| `int`, `float`, `str`, `bool`, `bytes` | `BigInt`, `Number`, `String`, `Boolean`, `Uint8Array` as native types. An `int` value is a `bigint` (`7n`); `7` is a float |
| `None` (absent, unknown, incomparable) | `null` |
| `dict` plain data | `Map<string, PlainData>` (`Plain.ToPlain` returns Maps) |
| `Schemas.OfObject.Builder()` | `new S.OfObject.Builder()` (schema builders are classes) |
| proxy builders and instances | typed loosely by name (`any`): annotate their callbacks `(x: any) =>` |
| decoders return the object | `FromPlain`/`FromJSON`/`FromYAML` return `unknown`: cast to `Proxies.Instance` |
| `AttributeError`, `ValueError`, `KeyError`, `NotImplementedError` | classes of the same names in `@mbse/schemas/Framework/Errors`; `TypeError` is JavaScript's |

## Cheat sheet

```typescript fragment
new S.OfObject.Builder().ref().properties(spec, ...).relations(spec, ...).create(); // .ref(): a reference object schema
new S.OfObject.Builder().properties(spec, ...).create();  // a value object schema, for a property's type
new S.OfObject.Builder(existing).relations(...).update();   // add adjacencies once the relations exist
new S.OfRelation.Builder().links("a", "b").properties(spec, ...).unique("a").create();
S.OfNative.resolve((n) => n.token("ccpp", "int32_t").bits(32n));   // any format's token; a width in bits or bytes
new S.OfUnion.Builder().branches((b) => b.name("phone").of(spec), ...).create();
new S.OfIntersection.Builder().parts((p) => p.name("stamp").of(spec), ...).create();
new S.OfIndexed.Builder().of(spec).create();              // a list; in a property: (t) => t.as_indexed((i) => i.of(spec))
new S.OfIndexed.Builder().key(spec).of(spec).extent({ minimum: 1n }).create(); // key: keyed; extent: bounds a positional list
const store = new Proxies.OfStore(); store.register("Name", schema); const B = store;   // stores are isolated
store.extent("Name"); Proxies.store_of(obj);               // a schema's reference objects; the store a proxy belongs to
B.Name().prop(value).adjacencyName((e: any) => e.link(obj).entryProp(v)).create();
B.Name(obj).prop(v).update();                              // .clone() makes a changed copy instead
B.Name().listProp(["a", "b"]).create();                    // a list of items; obj.listProp is a frozen array
B.Name().attrs(new Map([["gain", 1.5]])).create();          // a keyed list; obj.attrs.get("gain"). Give -0.0 keys as [key, value] pairs
JSON.ToJSON(store).Reachable(schema, root); JSON.FromJSON(store).Reachable(schema, text);
Validators.Validate(store)(schema, obj); Validators.Validate(store).Reachable(schema, root);
new Comparison.OfObject(schema, a).compare(new Comparison.OfObject(schema, b));   // -1, 0, 1 or null
Modules.module(store, { Contact }); Modules.schemas(store, module);   // schemas to a module (a Map or a record), and back
```

## Go deeper

| Topic | Read |
|---|---|
| The same nine case studies as the Python tutorial | [typescript5/tutorials/](https://github.com/pitaman71/mbse-schemas/blob/main/typescript5/tutorials/README.md) |
| Where the languages deliberately differ, and why | [EQUIVALENCE.md](https://github.com/pitaman71/mbse-schemas/blob/main/docs/EQUIVALENCE.md) |
| Self-checking example programs | [src/Examples/](https://github.com/pitaman71/mbse-schemas/blob/main/typescript5/src/Examples) |
