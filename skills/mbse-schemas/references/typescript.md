# mbse-schemas in TypeScript

Import from `@mbse/schemas/Framework`, and error classes from `@mbse/schemas/Framework/Errors`. The API mirrors
Python name for name, snake_case included (`as_scalar`, `as_identity`). It runs on Node 22+, in browsers and in
Deno.

## A complete program

Components own ports, wires connect ports and carry a label, and each port describes its signal as a value object.
It writes the same JSON as the Python version, byte for byte.

```typescript
import { Builders, JSON, Proxies, Schemas as S, Validators } from "@mbse/schemas/Framework";

const [Int, Text] = [Builders.Meta.OfInt, Builders.Meta.OfStr]; // the basic scalars, which every store holds
// Schemas and data are built in a store. Its members come from the schemas at runtime, so it is typed loosely: declare
// it `any`, and annotate the callbacks given to it `(x: any)`.
const store: any = new Builders.Store();

// A value with no identity: a value object.
const Signal = store.Schemas.Object((o: any) => o.properties([
  (t: any) => t.name("width").type([Int]),
  (t: any) => t.name("unit").type([Text]),
]));

// Things with identity: reference object schemas, each registered under its name as it is built.
const Component = store.Schemas.Object((o: any) => (
  o
    .name("Component")
    .ref(true)
    .properties([(t: any) => t.name("name").type([Text])])
));
const Port = store.Schemas.Object((o: any) => (
  o
    .name("Port")
    .ref(true)
    .properties([
      (t: any) => t.name("name").type([Text]),
      (t: any) => t.name("signal").type([Signal]),
    ])
));

// Every collection of reference objects is a relation. uniques("owner"): entries that agree on the port agree on the
// owner. Within a schema, links and properties are named by string.
const Ownership = store.Schemas.Relation((r: any) => (
  r
    .name("Ownership")
    .links([
      (t: any) => t.name("owner"),
      (t: any) => t.name("port"),
    ])
    .uniques("owner")
));
const Wire = store.Schemas.Relation((r: any) => (
  r
    .name("Wire")
    .links([
      (t: any) => t.name("source"),
      (t: any) => t.name("target"),
    ])
    .properties([(t: any) => t.name("label").type([Text])])
));

// Each object sees a relation through one of its links (an adjacency); an object and a callback update its schema.
store.Schemas.Object(Component, (o: any) => o.adjacencies([
  (t: any) => t.name("ports").relation([Ownership]).me("owner"),
]));
store.Schemas.Object(Port, (o: any) => o.adjacencies([
  (t: any) => t.name("owner").relation([Ownership]).me("port"),
  (t: any) => t.name("fanout").relation([Wire]).me("source"),
  (t: any) => t.name("fanin").relation([Wire]).me("target"),
]));
// An object may fill a link its schema declares with no name (an anonymous adjacency): no member, but still checked.
// A refinement has the members of the schema it refines, and its own; its objects are that schema's objects too.
const Board = store.Schemas.Object((o: any) => (
  o
    .name("Board")
    .refines([Component])
    .properties([(t: any) => t.name("revision").type([Int])])
));

// Data is built the same way: a callback creates, an object and a callback update, an object alone clones. Builders
// and data instances implement the visitor protocol: members named after the schema's names.
const irq = store.Port((p: any) => p.name("irq").signal((v: any) => v.as_object((s: any) => s.width(1n).unit("bit"))));
const picIn = store.Port((p: any) => p.as_identity("pic-in").name("pic_in")); // an identity written; else the store gives one
const cpu = store.Component((c: any) => c.name("cpu").ports((a: any) => a.insert((e: any) => e.port(irq))));
store.Port(irq, (p: any) => p.fanout((a: any) => a.insert((e: any) => e.target(picIn).label("interrupt"))));
const targets = [...irq.fanout].map((e: any) => e.target);
if (`${irq.name}` !== "irq" || targets.length !== 1 || targets[0] !== picIn) throw new Error("unexpected port");
const widths: bigint[] = [];
irq.signal.as_object((s: any) => widths.push(BigInt(s.width)) && s); // a value object, through as_object
if (widths.length !== 1 || widths[0] !== 1n) throw new Error("unexpected width");

const text = JSON.ToJSON(store).Reachable(Component, cpu);
const copy = JSON.FromJSON(store).Reachable(Component, text) as Proxies.Instance; // decoders return unknown
if (Validators.Validate(store).Reachable(Component, copy).length > 0) throw new Error("invalid");
```

## Differences from Python

| Python | TypeScript |
|---|---|
| `int`, `float`, `str`, `bool`, `bytes` | `BigInt`, `Number`, `String`, `Boolean`, `Uint8Array` as scalar types. An `int` value is a `bigint` (`7n`); `7` is a float |
| `None` (absent, unknown, incomparable) | `null` |
| `True`, `False`; `r"FEA-(\d+)"` | `true`, `false`; ``String.raw`FEA-(\d+)` `` |
| `dict` plain data | `Map<string, PlainData>` (`Plain.ToPlain` returns Maps) |
| `Builders.Store()` | `new Builders.Store()`, declared `any`: the store, its builders and the objects built are typed loosely by name, so callbacks given to them are annotated `(x: any) =>` |
| `Builders.OfObject.Builder(Contact, store=store)` | `new Builders.OfObject.Builder(Contact, true, store)`: the object it starts from, whether it may write, the store |
| a map given whole, `.attributes({"value": 32})` | a `Map` or a record, `.attributes({ value: 32n })` |
| `str(obj.prop)`, `int(obj.count)`, `float(...)` | `` `${obj.prop}` ``, `BigInt(obj.count)`, `+obj.ratio`, through `[Symbol.toPrimitive]`; `valueOf()` for a bool or bytes; never `===` on a member |
| `callable(instance)` | a data instance, and every member, is a `Proxy` with a function target: `typeof` says `"function"` |
| decoders return the object | `FromPlain`/`FromJSON`/`FromYAML` return `unknown`: cast to `Proxies.Instance` |
| `AttributeError`, `ValueError`, `KeyError`, `NotImplementedError` | classes of the same names in `@mbse/schemas/Framework/Errors`; `TypeError` is JavaScript's |
| `Adapters.Dataclasses` | none: an adapter translates its own language's type declarations |

## Cheat sheet

```typescript fragment
// Everything is built in a store: schemas with store.Schemas.<Kind>(...), data with store.<dotted name>(...). Called
// with a callback (a Spec taking the builder), it creates; with an object and a callback, it updates the object; with
// an object alone, it clones it. It returns the object. A named schema is registered under its name as it is built.
const store: any = new Builders.Store();                    // holds the meta-schemas; isolated from every other store
Builders.Meta.OfInt;                                        // basic scalars, in every store: OfBool, OfInt, OfFloat, OfStr, OfBytes
const w = store.Schemas.Form((f: any) => f.kind("literal").attributes({ value: 32n }));  // a literal width, 32
store.Schemas.Scalar((s: any) => s.format("ccpp").token("int32_t").bits([w]));   // any format's token; a width, a term
store.Schemas.Object((o: any) => o.name("crm.Contact").ref(true).properties([...]));   // .ref(true): a reference object schema
store.Schemas.Object((o: any) => o.name("pm.Feature").ref(true).pattern(String.raw`FEA-(\d+\d\d)`));  // FEA-001, ...; else UUIDs
store.Schemas.Object((o: any) => o.properties([(t: any) => t.name("x").type([Int])]));  // a value object schema, for a type
// A schema's members are its entries, each named by its entry: t.name("x"). A reference to another schema object is
// an array of what it links (.type([T]), .relation([R]), .refines([T])), one item where only one is allowed, which
// replaces it; a type must exist first. Value properties take their value whole, of exactly their type.
(t: any) => t.name("x").property(existing);                 // link a member that exists, rather than build one
store.Schemas.Relation((r: any) => (
  r
    .name("crm.Knows")
    .links([
      (t: any) => t.name("a"),                              // a link is a name; its type follows from the adjacencies
      (t: any) => t.name("b"),
    ])
    .properties([(t: any) => t.name("since").type([Int])])
    .uniques("a")                                           // links and properties named by string, by exception
));
.uniques(["a", "b"]); .uniques([["a"], ["b", "since"]]); .uniques([]);   // one clause of two; two clauses; a set
store.Schemas.Object(Person, (o: any) => o.adjacencies([   // update: add adjacencies once the relations exist
  (t: any) => t.name("knows").relation([Knows]).me("a"),    // me: the link this object fills, by name
  (t: any) => t.relation([Knows]).me("b"),                  // anonymous: no name, no member, still checked
]));
store.Schemas.Object((o: any) => o.name("Board").refines([Component]));   // a refinement: the members of what it refines
store.Schemas.Union((u: any) => u.branches([(t: any) => t.name("phone").type([Phone]), ...]));
store.Schemas.Intersection((i: any) => i.parts([(t: any) => t.name("stamp").type([Stamp]), ...]));
store.Schemas.Container((c: any) => c.index([Int]).element([Text]));   // a list: a container by position, a property's type
store.Schemas.Container((c: any) => c.index([Cell]).element([Float]).layout("sparse"));  // a tensor by a value object of ints
obj.tags.as_value((v: any) => v.as_container((c: any) => c.at(0n)));  // elements by index, each a Visitors.OfAny
store.Schemas.Any((a: any) => a.types([Int, Phone]));      // a value of any of these types, written bare; none: any type
store.Phone((p: any) => p.number("1"));                    // a standalone value, assigned to an unrestricted OfAny, tagged
schema.validate();                                         // the schema's own problems, [] when valid

.name("crm.Contact")                                       // a name, identifiers separated by dots, on any kind of schema
.description("A person we know")                           // documentation, on a schema or a member: property, adjacency,
schema.properties.get("home")?.type;                       // branch or part; a property is an element, its type inside
.parameters([(t: any) => t.name("n").type([Int])])         // parameters, on any kind of schema
store.Schemas.Apply((a: any) => a.of([Matrix]).arguments((adv: any) => adv.insert(  // a parametric schema applied: each
  (e: any) => e.argument((x: any) => x.parameter([Matrix.parameters.get("rows")]).value(2n)))));  // binds a parameter
store.Schemas.Predicate((p: any) => p.symbols([(t: any) => t.name("p").type([Person])]).requires([term]));  // one term
.bits([store.Schemas.Form((f: any) => f.kind("variable").attributes({ name: "n" }))])   // a term where a width stands
Validators.Check(store)(schema, obj).holds;                // true or false: since extents went, nothing it checks is unknown
S.equivalent(a, b, evaluate);                              // the same after substitution: Square(4n) is Matrix(4n, 4n)
store.registered("crm.Contact");                            // a schema by name
store.extent("Name"); store.singleton("Global");           // a schema's objects its singletons reach; a singleton
new Stores.PCG32(42n).split("key").next_u32();             // a random source, given to whatever draws from it
Proxies.store_of(obj);                                     // the store a proxy belongs to
// The visitor protocol (Visitors.OfX): data instances read, builders write. A member is the child visitor when read
// and takes a Spec when called: a value, or a function given the visitor. Reads never throw; a forbidden write throws
// Errors.ReadOnlyError.
store.crm.Contact((c: any) => c.prop(value).valueProp((p: any) => p.as_object((r: any) => r.x(1n))));   // a value object
store.crm.Contact((c: any) => c.knows((a: any) => a.insert((e: any) => e.b(obj).since(2020n))));   // an entry, inserted
store.crm.Contact((c: any) => c.knows([bob, (t: any) => t.since(2020n).name("Cy")]));   // peer shorthand: link, or build
store.crm.Contact(obj, (c: any) => c.prop(v)); store.crm.Contact(obj);   // update obj in place; clone it
store.builder("crm.Contact", obj);                         // the builder a call drives, ending in update() or clone()
`${obj.prop}`; BigInt(obj.count); obj.prop.get();          // a scalar: toPrimitive, or get(); get() is null when absent
obj.prop.get() === "Ada";                                  // compare once read: a member is never `===` a scalar
obj.prop.as_scalar((s: any) => s.set(v));                  // a property's scalar visitor; .as_value(cb) for any kind
store.crm.Contact(obj, (c: any) => c.prop((p: any) => p.as_value((v: any) => v.clear())));   // clear a value
store.crm.Contact((c: any) => c.tags(["a", "b"]));         // a container's value, given whole; an element a value
store.crm.Deck((d: any) => d.cards([(e: any) => e.title("x")]));  // or a callback writing it through its visitor
obj.valueProp.as_object((r: any) => r);                    // a value object's visitor, its members as an object's
[...irq.fanout].map((e: any) => [e.target, `${e.label}`]);  // an adjacency iterates its entries; a link is the object itself
irq.fanout.project("target"); contact.phones.at("home");   // each entry's link or property; the entry by its key
store.crm.Contact(obj, (c: any) => c.knows((a: any) => a.remove((e: any) => e.b(bob))));   // remove every entry agreeing
obj.likes.as_iterable((entries: Iterator<any>) => entries);  // an iterator over an adjacency's entries, in order
store.crm.Card((c: any) => c.reach((p: any) => p.phone(spec)));  // a branch: a property of one kind has its members
obj.reach.phone.number.get();                                // read through them, as through as_value and as_union
obj.as_properties; obj.as_adjacencies((a: any) => a);      // schema unaware: the properties set, every adjacency
obj.as_schema(); obj.as_identity();                        // what every visitor has: its schema; an object's identity, else null
store.by_identity("Feature", "FEA-001");                   // the live object of that schema with that identity
Proxies.owner_of(valueObject);                             // the object a value object belongs to

// Schemas as data: designing, extending, versioning and generating them is schemas.md.
store.Schemas.Object(Contact, (o: any) => o.properties([...]));   // extend a schema in place, as data is updated
store.module("crm").schemas;                               // a module's schemas by name (a Map): every named schema is in one
store.Schemas.Union((u: any) => u.name("Code").flat(true).branches([...]));   // flat: card.code is the branch's value
new Stores.Combined(one, other);                           // stores as one, each name its store's

// Everything else works for any schema.
Reachable.of(root);                                        // root and everything reachable, in first-reference order
Plain.ToPlain(store)(schema, obj); Plain.ToPlain(store).Reachable(schema, root); Plain.FromPlain(store)(schema, plain);
JSON.ToJSON(store)(...); JSON.FromJSON(store)(...); YAML.ToYAML(store)(...); YAML.FromYAML(store)(...);   // as Plain
Validators.Validate(store)(schema, obj); Validators.Validate(store).Reachable(schema, root);
new Comparison.OfObject(schema, a).compare(new Comparison.OfObject(schema, b));   // -1, 0, 1 or null
```

## Traps

The traps of [Python](python.md#traps) hold here too, in TypeScript's terms:

- `1` is a float, and `true` is neither: an int is a `bigint`, `1n`. Validation reports `expected int, got float`.
- A schema builder's value properties are typed exactly: `.ref(1n)` throws `TypeError`; write `.ref(true)`. A
  singleton schema is a reference object schema too: `.ref(true).singleton("crm.Directory")`.
- A reference to another schema object is an array of what it links, even where only one is allowed: `.type([Text])`,
  never `.type(Text)`. A store links only what it holds: the basic scalars are `Builders.Meta.OfInt` and so on, never
  `new S.OfScalar.Data(BigInt)`.
- In its store, a named schema's identity is its name: `store.Schemas.Object(Contact)` cannot clone it. Clone it under
  a new name with a builder in the store: `new Builders.OfObject.Builder(Contact, true, store).name("crm.Contact.v2").clone()`.

## Go deeper

| Topic | Read |
|---|---|
| The same nine case studies as the Python tutorial | [typescript5/tutorials/](https://github.com/pitaman71/mbse-schemas/blob/main/typescript5/tutorials/README.md) |
| Where the languages deliberately differ, and why | [EQUIVALENCE.md](https://github.com/pitaman71/mbse-schemas/blob/main/docs/EQUIVALENCE.md) |
| Self-checking example programs | [src/Examples/](https://github.com/pitaman71/mbse-schemas/blob/main/typescript5/src/Examples) |
