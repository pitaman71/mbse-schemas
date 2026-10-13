# mbse-schemas in TypeScript

Import from `@mbse/schemas/Framework`, and error classes from `@mbse/schemas/Framework/Errors`. The API mirrors
Python name for name, snake_case included (`as_scalar`, `as_identity`). It runs on Node 22+, in browsers and in
Deno.

## A complete program

Components own ports, wires connect ports and carry a label, and each port describes its signal as a value object.
It writes the same JSON as the Python version, byte for byte.

```typescript
import { JSON, Proxies, Schemas as S, Validators } from "@mbse/schemas/Framework";

const scalar = (name: string, type: S.OfScalar.Spec) => (p: S.OfProperty.Builder) => p.name(name).of((t) => t.as_scalar(type));

// A value with no identity: a value object.
const Signal = new S.OfObject.Builder().properties(scalar("width", BigInt), scalar("unit", String)).create();

// Things with identity: object schemas.
const Component = new S.OfObject.Builder().name("Component").ref().properties(scalar("name", String)).create();
const Port = new S.OfObject.Builder().name("Port").ref().properties(scalar("name", String), (p) => p.name("signal").of(Signal)).create();

// Every collection is a relation. unique("owner"): entries that agree on the port agree on the owner.
const Ownership = new S.OfRelation.Builder().name("Ownership").links("owner", "port").unique("owner").create();
const Wire = new S.OfRelation.Builder().name("Wire").links("source", "target").properties(scalar("label", String)).create();

// Each object sees a relation through one of its links (an adjacency).
new S.OfObject.Builder(Component).relations((r) => r.name("ports").of(Ownership).me("owner")).update();
new S.OfObject.Builder(Port).relations((r) => r.name("owner").of(Ownership).me("port"),
  (r) => r.name("fanout").of(Wire).me("source"),
  (r) => r.name("fanin").of(Wire).me("target")).update();
// A store holds named schemas, each under its own name; the objects built with them belong to it.
const store = new Proxies.OfStore();
for (const schema of [Component, Port, Ownership, Wire]) store.register(schema);
const B = store;

// Builders and data instances implement the visitor protocol: members named after the schema's names.
const irq = B.Port().name("irq").signal((p: any) => p.as_object((s: any) => s.width(1n).unit("bit"))).create();
const picIn = B.Port().name("pic_in").create();
const cpu = B.Component().name("cpu").ports((a: any) => a.insert((e: any) => e.port(irq))).create();
B.Port(irq).fanout((a: any) => a.insert((e: any) => e.target(picIn).label("interrupt"))).update();
if (`${irq.name}` !== "irq" || [...irq.fanout].map((e: any) => e.target)[0] !== picIn) throw new Error("unexpected port");
const widths: bigint[] = [];
irq.signal.as_object((s: any) => widths.push(BigInt(s.width)) && s); // a value object, through as_object
if (widths[0] !== 1n) throw new Error("unexpected width");

const text = JSON.ToJSON(store).Reachable(Component, cpu);
const copy = JSON.FromJSON(B).Reachable(Component, text) as Proxies.Instance; // decoders return unknown
if (Validators.Validate(B).Reachable(Component, copy).length > 0) throw new Error("invalid");
```

## Differences from Python

| Python | TypeScript |
|---|---|
| `int`, `float`, `str`, `bool`, `bytes` | `BigInt`, `Number`, `String`, `Boolean`, `Uint8Array` as scalar types. An `int` value is a `bigint` (`7n`); `7` is a float |
| `None` (absent, unknown, incomparable) | `null` |
| `dict` plain data | `Map<string, PlainData>` (`Plain.ToPlain` returns Maps) |
| `Schemas.OfObject.Builder()` | `new S.OfObject.Builder()` (schema builders are classes) |
| proxy builders and instances | typed loosely by name (`any`): annotate their callbacks `(x: any) =>` |
| `str(obj.prop)`, `int(obj.count)`, `float(...)` | `` `${obj.prop}` ``, `BigInt(obj.count)`, `+obj.ratio`, through `[Symbol.toPrimitive]`; `valueOf()` for a bool or bytes; never `===` on a member |
| `callable(instance)` | a data instance, and every member, is a `Proxy` with a function target: `typeof` says `"function"` |
| decoders return the object | `FromPlain`/`FromJSON`/`FromYAML` return `unknown`: cast to `Proxies.Instance` |
| `AttributeError`, `ValueError`, `KeyError`, `NotImplementedError` | classes of the same names in `@mbse/schemas/Framework/Errors`; `TypeError` is JavaScript's |

## Cheat sheet

```typescript fragment
new S.OfObject.Builder().ref().properties(spec, ...).relations(spec, ...).create(); // .ref(): a reference object schema
new S.OfObject.Builder().ref(String.raw`FEA-(\d+\d\d)`);  // its objects named FEA-001, FEA-002, ... in each store; else UUIDs
new S.OfObject.Builder().properties(spec, ...).create();  // a value object schema, for a property's type
new S.OfObject.Builder(existing).relations(...).update();   // add adjacencies once the relations exist
new S.OfRelation.Builder().links("a", "b").properties(spec, ...).unique("a").create();
S.OfScalar.resolve((n) => n.token("ccpp", "int32_t").bits(32n));   // any format's token; a width in bits or bytes
new S.OfUnion.Builder().branches((b) => b.name("phone").of(spec), ...).create();
new S.OfIntersection.Builder().parts((p) => p.name("stamp").of(spec), ...).create();
r.name("tags").me("owner").of((rel) => rel.links("owner").properties(text("value")));   // a list: a one-link relation inline
rel.links("owner").properties(text("key"), text("value")).unique("value");   // a dict, keyed by `key`; several keys: a matrix
new S.OfObject.Builder().name("crm.Contact");                     // a name, identifiers separated by dots, on any kind
new S.OfObject.Builder().description("A person we know");         // documentation, on any element: schema, property,
schema.properties.get("home")?.type;                              // adjacency, branch or part; a property is an element
new S.OfObject.Builder().parameters((p) => p.name("n").of(spec)); // parameters, on any kind of schema
new S.OfApply.Builder().of(Matrix).arguments({ rows: 2n, cols: 3n }); // a type: a parametric schema applied, by name; .argument("n", 3n)
new S.OfPredicate.Builder().symbols((s) => s.name("p").of(Person)).requires(term); // a predicate: one term over symbols
n.bits(new S.Form.Data("variable", { name: "n" }));               // a term where a width stands
Validators.Check(store)(schema, obj).holds;                       // true or false: since extents went, nothing it checks is unknown
S.equivalent(a, b, evaluate);                                     // the same after substitution: Square(4n) is Matrix(4n, 4n)
const store = new Proxies.OfStore(); store.register(schema); const B = store;   // under schema.name; stores are isolated
store.extent("Name"); store.singleton("Global");           // a schema's objects its singletons reach; a singleton
new Stores.PCG32(42n).split("key").next_u32();             // a random source, given to whatever draws from it
Proxies.store_of(obj);                                     // the store a proxy belongs to
// The visitor protocol (Visitors.OfX): data instances read, builders write. A member is the child visitor when read
// and takes a Spec when called: a value, or a function given the visitor. Reads never throw; a forbidden write throws
// Errors.ReadOnlyError.
B.Name().prop(value).valueProp((p: any) => p.as_object((r: any) => r.x(1n))).create();   // a value object, through as_object
B.Name().adjacencyName((a: any) => a.insert((e: any) => e.link(obj).entryProp(v))).create();   // an entry, inserted
B.Name(obj).prop(v).update();                              // change obj; .clone() makes a changed copy instead
`${obj.prop}`; BigInt(obj.count); obj.prop.get();          // a scalar: toPrimitive, or get(); get() is null when absent
obj.prop.get() === "Ada";                                  // compare once read: a member is never `===` a scalar
obj.prop.as_scalar((s: any) => s.set(v));                  // a property's scalar visitor; .as_value(cb) for any kind
B.Name(obj).prop((p: any) => p.as_value((v: any) => v.clear())).update();   // clear a value
obj.valueProp.as_object((r: any) => r);                    // a value object's visitor, its members as an object's
[...irq.fanout].map((e: any) => [e.target, `${e.label}`]);  // an adjacency iterates its entries; a link is the object itself
irq.fanout.project("target"); contact.phones.at("home");   // each entry's link or property; the entry by its key
B.Name(obj).tags((a: any) => a.remove((e: any) => e.value("x")));   // remove every entry agreeing with a template
obj.tags.select((e: any) => e.value("x"), (e: any) => e);  // visit the entries agreeing with a template, or equal to a value
B.Name().unionProp((p: any) => p.as_value((v: any) => v.as_union((u: any) => u.phone(spec))));   // a branch by name
obj.as_properties; obj.as_adjacencies((a: any) => a);      // schema unaware: the properties set, every adjacency
obj.as_schema(); obj.as_identity();                        // what every visitor has: its schema; an object's identity, else null
store.by_identity("Feature", "FEA-001");                   // the live object of that schema with that identity
Proxies.owner_of(valueObject);                             // the object a value object belongs to
JSON.ToJSON(store).Reachable(schema, root); JSON.FromJSON(store).Reachable(schema, text);
Validators.Validate(store)(schema, obj); Validators.Validate(store).Reachable(schema, root);
new Comparison.OfObject(schema, a).compare(new Comparison.OfObject(schema, b));   // -1, 0, 1 or null
Modules.module(store, [Contact]); Modules.schemas(store, module);   // named schemas to a module, and back (a Map, by name)
new S.OfUnion.Builder().name("Code").branches(...).flat();  // flat: card.code is the branch's value, set by type
new Stores.Combined(one, other);                           // stores as one, each name its store's
```

## Go deeper

| Topic | Read |
|---|---|
| The same nine case studies as the Python tutorial | [typescript5/tutorials/](https://github.com/pitaman71/mbse-schemas/blob/main/typescript5/tutorials/README.md) |
| Where the languages deliberately differ, and why | [EQUIVALENCE.md](https://github.com/pitaman71/mbse-schemas/blob/main/docs/EQUIVALENCE.md) |
| Self-checking example programs | [src/Examples/](https://github.com/pitaman71/mbse-schemas/blob/main/typescript5/src/Examples) |
