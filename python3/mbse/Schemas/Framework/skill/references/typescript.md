# mbse-schemas in TypeScript

Import from `@mbse/schemas/Framework`, and error classes from `@mbse/schemas/Framework/Errors`. The API mirrors
Python name for name, snake_case included (`as_scalar`, `as_adjacencies`). It runs on Node 22+, in browsers and in
Deno.

## A complete program

Components own ports, wires connect ports and carry a label, and each port describes its signal as a value object.
It writes the same JSON as the Python version, byte for byte.

```typescript
import { Builders, JSON, Proxies, Validators } from "@mbse/schemas/Framework";

/** A module's schemas, defined in the store a transaction writes: each found by its name, else made. */
function install(txn: any): any {
  const S = txn.Schemas; // a store's own schemas by name: its meta-schemas and basic scalars, and what it holds
  return txn.uid("components/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    // Each schema the module defines is a symbol of its kind; its spec, below, says what it is.
    .symbols({ Component: S.OfObject, Port: S.OfObject, Board: S.OfObject, Ownership: S.OfRelation, Wire: S.OfRelation })
    .spec([
      // Things with identity: reference object schemas, each registered under its name. A port's signal is a value with
      // no identity, a value object, defined where it is linked.
      (_: any) => _.Component.name("Component").ref(true).properties({ name: S.OfStr }).adjacencies({
        ports: (a: any) => a.relation([_.Ownership]).me("owner"), // an adjacency: a relation seen through a link
      }),
      (_: any) => _.Port.name("Port").ref(true).properties({
        name: S.OfStr,
        signal: S.OfObject((o: any) => o.properties({ width: S.OfInt, unit: S.OfStr })),
      }).adjacencies({
        owner: (a: any) => a.relation([_.Ownership]).me("port"),
        fanout: (a: any) => a.relation([_.Wire]).me("source"),
        fanin: (a: any) => a.relation([_.Wire]).me("target"),
      }),
      // A refinement has the members of the schema it refines, and its own; its objects are that schema's too.
      (_: any) => _.Board.name("Board").refines([_.Component]).properties({ revision: S.OfInt }),
      // Every collection of reference objects is a relation. uniques("owner"): entries that agree on the port agree on
      // the owner. Within a schema, links and properties are named by string.
      (_: any) => _.Ownership.name("Ownership").links([
        (t: any) => t.name("owner"),
        (t: any) => t.name("port"),
      ]).uniques("owner"),
      (_: any) => _.Wire.name("Wire").links([
        (t: any) => t.name("source"),
        (t: any) => t.name("target"),
      ]).properties({ label: S.OfStr }),
    ])]))]);
}

// Schemas and data are built in a store. Its members come from the schemas at runtime, so it is typed loosely: declare
// it `any`, and annotate the callbacks given to it `(x: any)`.
const store: any = new Builders.Store();
store.transaction(install); // run again, it finds what it defined and writes nothing
const Component = store.registered("Component");

const { irq, picIn, cpu } = store.transaction(() => { // every write within a transaction: all of it, or none
  // Data is built the same way: a callback creates, an object and a callback update, an object alone clones. Builders
  // and data instances implement the visitor protocol: members named after the schema's names.
  const irq = store.Port((p: any) => p.name("irq").signal((v: any) => v.as_object((s: any) => s.width(1n).unit("bit"))));
  const picIn = store.Port((p: any) => p.name("pic_in")); // counted: nothing owns it, so a document that writes it numbers it
  const cpu = store.Component((c: any) => c.name("cpu").ports((a: any) => a.insert((e: any) => e.port(irq))));
  store.Port(irq, (p: any) => p.fanout((a: any) => a.insert((e: any) => e.target(picIn).label("interrupt"))));
  return { irq, picIn, cpu };
});
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
| `with store.transaction(): ...` | `store.transaction(() => ...)`, which gives back what the function returns: values built within it leave it so |
| `Builders.OfObject.Builder(Contact, store=store)` | `new Builders.OfObject.Builder(Contact, true, store)`: the object it starts from, whether it may write, the store |
| a map given whole, `.attributes({"value": 32})` | a `Map` or a record, `.attributes({ value: 32n })` |
| `str(obj.prop)`, `int(obj.count)`, `float(...)` | `` `${obj.prop}` ``, `BigInt(obj.count)`, `+obj.ratio`, through `[Symbol.toPrimitive]`; `valueOf()` for a bool or bytes; never `===` on a member |
| `callable(instance)` | a data instance, and every member, is a `Proxy` with a function target: `typeof` says `"function"` |
| decoders return the object | `FromPlain`/`FromJSON`/`FromYAML` return `unknown`: cast to `Proxies.Instance` |
| `AttributeError`, `ValueError`, `KeyError`, `NotImplementedError` | classes of the same names in `@mbse/schemas/Framework/Errors`; `TypeError` is JavaScript's |
| `Adapters.Dataclasses` | none: an adapter translates its own language's type declarations |

## Cheat sheet

```typescript fragment
// Everything is built in a store. A module defines its schemas in a module-scope install(txn), as the complete program
// does: one upsert, each schema a symbol of its kind (txn.Schemas.OfObject), its spec the builder calls below, made on the
// symbol (_.Person.name(...)); txn.Schemas.OfContainer(cb) there defines one with no name where it is linked. Data is
// built with store.<dotted name>(...); the builders build schemas the same way, store.Schemas.<Kind>(...). Called
// with a callback (a Spec taking the builder), it creates; with an object and a callback, it updates the object; with
// an object alone, it clones it. It returns the object. A named schema is registered under its name as it is built.
const store: any = new Builders.Store();                    // holds its own plain schemas of schemas; shares nothing
store.transaction(install);                                // a module's schemas; run again, it writes nothing
store.transaction(() => { ... });                          // every write within one, all or nothing; outside one, refused
store.transaction((t: any) => t.mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p.symbols({ P: Person })
  .spec([(_: any) => _.P.name("Ada")])]))]));               // a transaction's expression: find by spec, else create
  // a spec removes as a builder does: _.P.knows((a: any) => a.remove((e: any) => e.b(_.Q))), or every entry, a.clear();
  // it holds where what it removes is absent, so run again it writes nothing
store.Schemas.OfInt;                                        // its basic scalars, by path: OfBool, OfInt, OfFloat, OfStr, OfBytes
store.Schemas.OfInt.as_schema();                            // the schema a path names, where an object is wanted
// The five are the only scalar schemas: a store builds no other. A finer scalar (a date, an int32) is a domain,
// mbse-expressions'; until then, give the property its basic scalar and say what it means in its description.
store.Schemas.OfObject((o: any) => o.name("crm.Contact").ref(true).properties([...]));   // .ref(true): a reference object schema
store.Schemas.OfObject((o: any) => o.properties([(t: any) => t.name("x").schema([Int])]));  // a value object schema, for a property's values
// A schema's members are its entries, each named by its entry: t.name("x"). A reference to another schema object is
// an array of what it links (.schema([T]), .relation([R]), .refines([T])), one item where only one is allowed, which
// replaces it; a schema must exist first. Value properties take their value whole, of exactly their schema.
(t: any) => t.name("x").property(existing);                 // link a member that exists, rather than build one
store.Schemas.OfRelation((r: any) => (
  r
    .name("crm.Knows")
    .links([
      (t: any) => t.name("a"),                              // a link is a name; its schema follows from the adjacencies
      (t: any) => t.name("b"),
    ])
    .properties([(t: any) => t.name("since").schema([Int])])
    .uniques("a")                                           // links and properties named by string, by exception
));
.uniques(["a", "b"]); .uniques([["a"], ["b", "since"]]); .uniques([]);   // one clause of two; two clauses; a set
store.Schemas.OfObject(Person, (o: any) => o.adjacencies([   // update: add adjacencies once the relations exist
  (t: any) => t.name("knows").relation([Knows]).me("a"),    // me: the link this object fills, by name
  (t: any) => t.relation([Knows]).me("b"),                  // anonymous: no name, no member, still checked
]));
store.Schemas.OfObject((o: any) => o.name("Board").refines([Component]));   // a refinement: the members of what it refines
store.Schemas.OfUnion((u: any) => u.branches([(t: any) => t.name("phone").schema([Phone]), ...]));
store.Schemas.OfIntersection((i: any) => i.parts([(t: any) => t.name("stamp").schema([Stamp]), ...]));
store.Schemas.OfContainer((c: any) => c.index([Int]).element([Text]));   // a list: a container by position, a property's schema
store.Schemas.OfContainer((c: any) => c.index([Cell]).element([Float]).layout("sparse"));  // a tensor by a value object of ints
obj.tags.as_value((v: any) => v.as_container((c: any) => c.at(0n)));  // elements by index, each a Visitors.OfAny
store.Schemas.OfAny((a: any) => a.schemas([Int, Phone]));      // a value of any of these schemas, written bare; none: any
store.Phone((p: any) => p.number("1"));                    // a standalone value, assigned to an unrestricted OfAny, tagged
schema.validate();                                         // the schema's own problems, [] when valid

.name("crm.Contact")                                       // a name, identifiers separated by dots, on any kind of schema
.description("A person we know")                           // documentation, on a schema or a member: property, adjacency,
schema.properties.get("home")?.schema;                       // branch or part; a property is an element, its schema inside
store.transaction(Parametrics.install);                    // parameters are Parametrics', installed before use; in a spec,
.parameters([txn.Parametrics.OfParameters((ps: any) => ps.parameters({  // a set of them on any kind of schema, each
  n: (d: any) => d.parameter((p: any) => p.for_value([S.OfInt])) }))])  // for a value of a schema, or for_object([Shape])
Parametrics.validate(store, schema);                       // its parameters' problems; binding is mbse-expressions'
store.Schemas.OfPattern((p: any) => p.symbols([(t: any) => t.name("p").schema([Person])])  // a pattern: symbols,
  .variables([(t: any) => t.name("since").schema([Int])]));  // variables, and constraints (requires)
Validators.Check(store)(schema, obj).holds;                // true or false: since extents went, nothing it checks is unknown
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
store.crm.Contact(obj, (c: any) => c.knows((a: any) => a.clear()));   // remove every entry
obj.likes.as_iterable((entries: Iterator<any>) => entries);  // an iterator over an adjacency's entries, in order
store.crm.Card((c: any) => c.reach((p: any) => p.phone(spec)));  // a branch: a property of one kind has its members
obj.reach.phone.number.get();                                // read through them, as through as_value and as_union
obj.as_properties; obj.as_adjacencies((a: any) => a);      // schema unaware: the properties set, every adjacency
obj.as_schema();                                           // what every visitor has: its schema
Paths.of(obj);                                             // a singleton's or an owned object's path; a counted one has none
store.Instances.wts.Features.dir({ name: "DEF-693" });     // a singleton by its global name; a lookup by keys on any adjacency
Proxies.owner_of(valueObject);                             // the object a value object belongs to

// Schemas as data: designing, extending, versioning and generating them is schemas.md.
store.Schemas.OfObject(Contact, (o: any) => o.properties([...]));   // extend a schema in place, as data is updated
store.module("crm").schemas;                               // a module's schemas by name (a Map): every named schema is in one
store.Schemas.OfUnion((u: any) => u.name("Code").flat(true).branches([...]));   // flat: card.code is the branch's value
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
- A schema builder's value properties take exactly their schema's values: `.ref(1n)` throws `TypeError`; write `.ref(true)`. A
  singleton schema is a reference object schema too: `.ref(true).singleton("crm.Directory")`.
- A reference to another schema object is an array of what it links, even where only one is allowed: `.schema([Text])`,
  never `.schema(Text)`. A store links only what it holds: its basic scalars are `store.Schemas.OfInt` and so on, never
  `new S.OfScalar.Data(BigInt)` nor another store's.
- In its store, a named schema's path is its name: `store.Schemas.OfObject(Contact)` cannot clone it. Clone it under a
  new name with a builder in the store: `new Builders.OfObject.Builder(Contact, true, store).name("crm.v2.Contact").clone()`.
  A schema with no name of its own is linked by one schema object alone: name it to share it.

## Go deeper

| Topic | Read |
|---|---|
| The same nine case studies as the Python tutorial | [typescript5/tutorials/](https://github.com/pitaman71/mbse-schemas/blob/main/typescript5/tutorials/README.md) |
| Where the languages deliberately differ, and why | [EQUIVALENCE.md](https://github.com/pitaman71/mbse-schemas/blob/main/docs/EQUIVALENCE.md) |
| Self-checking example programs | [src/Examples/](https://github.com/pitaman71/mbse-schemas/blob/main/typescript5/src/Examples) |
