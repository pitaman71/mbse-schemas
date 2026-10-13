/**
 * Proxies: the dynamic implementation.
 *
 * Programs using proxies skip code generation. A store, `new OfStore()`, holds schemas and the proxies built with them
 * (see `Stores`): `store.register(schema)` makes a schema available, under its name, and `store.<Name>(optional
 * instance)` (or `store.builder(name, instance)`) returns a builder for it. Instances (`Proxies.OfObject.Data`) are
 * `Visitable`, not visitors: they expose their properties as read-only attributes and write themselves into a visitor
 * on `accept`. Builders (`Proxies.OfObject.Builder`) implement `Visitors.OfObject`, like every builder.
 *
 * Attribute lookup follows Python's: the builder's or instance's own methods first, then schema names. Reading an
 * unknown name throws `AttributeError`, except JavaScript's own protocol probes (`then`, `toJSON`, `constructor`,
 * symbols, ...), which behave as on any object. Identities are never reused.
 *
 * A store holds its singletons, created when their schemas are registered (`store.singleton(globalName)`), and through
 * them its data (see `Stores`); an object nothing reachable from a singleton links is the program's to keep. A
 * relation's entries live on the objects they link, so they go with them. Adding an entry equal to an existing one is
 * elided. An object of one store cannot be linked to, or be a builder's source in, another. An adjacency is a member
 * named after it, the frozen array of its entries in the order they were added (`contact.phones`), with
 * `project(name)`, each entry's link or property, and `at(key)`, the entry with a key its relation declares (which
 * replaces the array's own `at(index)`; index it with `[i]`); an entry is shared
 * by the objects it links, and its links and properties are read-only attributes (`entry.phone`, `entry.label`), so
 * that code reads proxies as it reads generated classes.
 *
 * A property whose schema is an `OfObject` holds a value object: a read-only record with no identity
 * (`Proxies.OfObject.Record`), read with attributes like an instance and set with a Spec, e.g.
 * `.reach((r) => r.number("+44"))`. Union and intersection values are records too, whose properties are the union's
 * branches or the intersection's parts, by name: `.reach((u) => u.phone((p) => p.number("+44")))` sets the branch
 * `phone`, read back as `card.reach.phone.number`, and setting one branch clears any other. An intersection value holds
 * each of its parts, set and read the same way (`card.meta.stamp.updated`).
 *
 */


import { toHex } from "./Bytes.js";
import { AttributeError, KeyError, ValueError } from "./Errors.js";
import { repr, sortedStrings, Tuple, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import * as Stores from "./Stores.js";
import type { Callback, Scalar, OfAdjacency as AdjacencyVisitor, OfAny, OfEntry as EntryVisitor, OfIntersection, OfLink, OfScalar,
  OfObject as ObjectVisitor, OfProperty, OfUnion, Visitable } from "./Visitors.js";

type ObjectSchema = Schemas.OfObject.Data;
type RelationSchema = Schemas.OfRelation.Data;
type AdjacencySchema = Schemas.OfAdjacency.Data;

/** A proxy instance as seen by callers: `Visitable`, with properties readable by name. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Instance = Visitable & { readonly [name: string]: any };

/** A proxy builder as seen by callers: `Visitors.OfObject`, finalizers, and DSL setters by name. */
export type DynamicBuilder = ObjectVisitor & {
  create(): Instance;
  clone(): Instance;
  update(): Instance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [name: string]: any;
};

/** JavaScript's own protocol probes: never schema lookups, so awaiting, inspecting or printing a proxy is safe. */
export const _probes: ReadonlySet<string> = new Set<string>([
  "then", "catch", "finally", "toJSON", "constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty",
  "isPrototypeOf", "propertyIsEnumerable", "__proto__", "$$typeof", "asymmetricMatch", "nodeType", "inspect",
]);

// --- Stores ---

/** The value an instance or value object holds in its property `name`. */
function member(instance: unknown, name: string): unknown {
  const t = instanceTargets.get(instance as object) ?? recordTargets.get(instance as object) as RecordTarget;
  return read(t, name, instance);
}

const STORE_MEMBERS = new Set(["register", "schema", "registered", "name_of", "names", "singleton", "builder", "member",
  "extent"]);

/** A store of proxies: schemas by name, and the instance of each singleton schema registered, created with it.
 * `store.<Name>(optional instance)` is `store.builder(name, instance)`; use `builder` for names that are not
 * identifiers, or that a method's name shadows. */
export class OfStore extends Stores.Catalog implements Stores.Store {
  /** `(instance?: Instance) => DynamicBuilder` for each registered object schema; dynamic by design. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [name: string]: any;

  constructor() {
    super();
    for (const schema of Stores.META) this.register(schema);
    return new Proxy(this, {
      get(t, prop, receiver) {
        if (typeof prop === "symbol" || prop in t || STORE_MEMBERS.has(prop)) return Reflect.get(t, prop, receiver);
        if (prop.startsWith("_")) throw new AttributeError(prop);
        if (!t._schemas.has(prop) && _probes.has(prop)) return Reflect.get(t, prop, receiver);
        const found = t.schema(prop);
        return (instance?: Instance) => makeObjectBuilder(receiver as OfStore, found, prop, instance);
      },
    });
  }

  /** Registers a schema under `name`; a singleton schema's instance is created with it. */
  override register(schema: ObjectSchema | RelationSchema | Schemas.OfPredicate.Data): void {
    const globalName = schema instanceof Schemas.OfObject.Data ? schema.singleton : null;
    if (globalName !== null && this._singletons.has(globalName)) {
      throw new ValueError(`singleton ${repr(globalName)} is already registered`);
    }
    super.register(schema);
    if (globalName !== null) this._singletons.set(globalName, makeInstance(this, schema as ObjectSchema, schema.name as string));
  }

  /** A builder for the object schema `name`; typed loosely, as the store's DSL is. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder(name: string, instance?: unknown): any {
    return makeObjectBuilder(this, this.schema(name), name, instance as Instance | undefined);
  }

  /** The value an instance or value object holds in its property `name`. */
  member(instance: unknown, name: string): unknown {
    return member(instance, name);
  }

  /** The name of the one object schema that declares an adjacency to `relation` via `link`. */
  _filled(relation: RelationSchema, link: string): string {
    const names = this._filling(relation, link);
    if (names.length !== 1) throw new TypeError(`expected exactly one object schema filling link ${repr(link)}, found ${repr(names)}`);
    return names[0] as string;
  }
}

/** The store a proxy belongs to; a value object's is its owner's, and one not yet placed has none. */
function storeOf(value: unknown): OfStore | null {
  while (isRecord(value)) value = stateOf(value).holder;
  return isInstance(value) ? (instanceTargets.get(value) as ObjectTarget).store : null;
}

/** The store a proxy, or a value object placed in one, belongs to. */
export function store_of(value: unknown): OfStore {
  const store = storeOf(value);
  if (store === null) throw new TypeError("the value does not belong to a store");
  return store;
}

function sameStore(store: OfStore | null, value: unknown): void {
  const held = storeOf(value);
  if (store !== null && held !== null && held !== store) throw new TypeError("the object belongs to another store");
}

// --- Relation entries ---

const floatView = new DataView(new ArrayBuffer(8));

const schemaIds = new WeakMap<object, number>();
let nextSchemaId = 0;

/** A number for each schema, as Python's `id()` of it, so that value objects of different schemas differ. */
function schemaId(schema: object): number {
  if (!schemaIds.has(schema)) schemaIds.set(schema, ++nextSchemaId);
  return schemaIds.get(schema) as number;
}

/** Equality key per EQUALITY.md: distinct scalar types never compare equal; floats compare by bit pattern; a value
 * object by its schema and properties, whatever its identity. */
export function scalarKey(value: unknown): string {
  if (isRecord(value)) {
    const state = stateOf(value);
    const values = sortedStrings(state.values.keys()).map((name) => [name, scalarKey(state.values.get(name))]);
    return `object:${schemaId(state.schema)}:${JSON.stringify(values)}`;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "float:nan";
    floatView.setFloat64(0, value);
    return `float:${floatView.getBigUint64(0).toString(16)}`;
  }
  if (typeof value === "bigint") return `int:${value}`;
  if (typeof value === "string") return `str:${value}`;
  if (typeof value === "boolean") return `bool:${value}`;
  if (value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype) {
    return `bytes:${toHex(value)}`;
  }
  throw new TypeError(`an entry property must be a scalar value or a value object, got ${typeName(value)}`);
}

/** An entry of a relation, shared by the objects it links: read through `view`, a proxy whose read-only attributes are
 * its links and its properties (`entry.phone`, `entry.label`); a property that is not set reads as `null`, as an
 * object's does. */
let nextEntry = 0;

class Entry {
  #view: unknown = null;

  constructor(readonly relation: RelationSchema, readonly links: Map<string, Visitable>, readonly properties: Map<string, Scalar>) {}

  get view(): unknown {
    this.#view ??= new Proxy(this, {
      get(t, prop, receiver) {
        if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
        if (t.links.has(prop)) return t.links.get(prop);
        if (t.properties.has(prop)) return view(t.properties.get(prop), (t.relation.properties.get(prop) as Schemas.OfProperty.Data).type);
        if (t.relation.properties.has(prop)) return null; // not set: nothing is mandatory but by a constraint
        if (_probes.has(prop)) return undefined;
        throw new AttributeError(prop);
      },
      set: () => { throw new AttributeError("entries are read-only; use a builder"); },
    });
    return this.#view;
  }

  readonly id = ++nextEntry;

  /** What the entry is held by: its value in a relation with a `unique` clause, a set, and itself in an open relation,
   * a list from each end, which keeps equal entries. */
  key(): string {
    if (this.relation.open) return `entry:${this.id}`;
    const links = [...this.links].map(([name, target]) => [name, target.identity()] as const).sort(byName);
    const props = [...this.properties].map(([name, value]) => [name, scalarKey(value)] as const).sort(byName);
    return JSON.stringify([links, props]);
  }
}

function byName(a: readonly [string, unknown], b: readonly [string, unknown]): number {
  return a[0] < b[0] ? -1 : 1; // names within an entry are unique
}

/** The entries of one relation that link `target`, by key: they live on the objects they link. */
function table(target: Visitable, relation: RelationSchema): Map<string, Entry> {
  const adjacent = ((instanceTargets.get(target) ?? recordTargets.get(target)) as ObjectTarget | RecordTarget).adjacent;
  let found = adjacent.get(relation);
  if (found === undefined) adjacent.set(relation, (found = new Map()));
  return found;
}

/** Adds `entry` to every object it links, unless an equal entry is there already. */
function addEntry(relation: RelationSchema, entry: Entry): void {
  const key = entry.key();
  if (table([...entry.links.values()][0] as Visitable, relation).has(key)) return;
  for (const target of entry.links.values()) table(target, relation).set(key, entry);
}

/** The entries of `relation` that link `target` via `link`, in the order they were added. */
function linking(relation: RelationSchema, link: string, target: Visitable): Entry[] {
  return [...table(target, relation).values()].filter((entry) => entry.links.get(link) === target);
}

function discard(relation: RelationSchema, entries: readonly Entry[]): void {
  for (const entry of entries) {
    const key = entry.key();
    for (const target of entry.links.values()) table(target, relation).delete(key);
  }
}

function discardLinking(relation: RelationSchema, link: string, target: Visitable): void {
  discard(relation, linking(relation, link, target));
}

/** Discards every entry that links `target`, through any link. */
function discardTarget(target: Visitable): void {
  const adjacent = ((instanceTargets.get(target) ?? recordTargets.get(target)) as ObjectTarget | RecordTarget).adjacent;
  for (const [relation, entries] of [...adjacent]) discard(relation, [...entries.values()]);
}

// --- Instances ---

let nextIdentity = 0;
/** Node's `util.inspect.custom` symbol, by its registered name, so no Node module is imported. */
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
/** The Jupyter display protocol's symbol, as Deno's kernel uses it. */
const JUPYTER_DISPLAY = Symbol.for("Jupyter.display");

const instanceTargets = new WeakMap<object, ObjectTarget>();

/** The state behind a proxy instance. */
class ObjectTarget {
  readonly id = ++nextIdentity;
  readonly values = new Map<string, unknown>();
  /** The entries linking this object, by relation and key. */
  readonly adjacent = new Map<RelationSchema, Map<string, Entry>>();
  proxy!: Instance;

  constructor(readonly store: OfStore, readonly schema: ObjectSchema, readonly schemaName: string) {}

  identity(): number {
    return this.id;
  }

  schema_name(): string {
    return this.schemaName;
  }

  owner(): null {
    return null;
  }

  /** Writes properties in the schema's declared order, then entries adjacency by adjacency. */
  accept(visitor: ObjectVisitor): void {
    writeProperties(visitor, this.schema, this.values);
    writeAdjacencies(visitor, this.proxy, this.schema);
  }

  [INSPECT](): string {
    // Node calls this with the proxy as `this` (whose names are schema properties), so read the target's own state.
    const t = instanceTargets.get(this as unknown as object) as ObjectTarget; // instances are only reached as proxies
    const values = [...t.values].map(([k, v]) => `${k}: ${repr(v)}`).join(", ");
    return `<${t.schemaName} proxy #${t.id}${values ? " " + values : ""}>`;
  }

  /** Jupyter kernels (e.g. Deno's) display a cell's value with this, before probing it for other formats. */
  [JUPYTER_DISPLAY](): Record<string, string> {
    return { "text/plain": this[INSPECT]() };
  }
}

const INSTANCE_METHODS = new Set(["identity", "schema_name", "owner", "accept"]);

/** Writes the entries linking `target`, adjacency by adjacency; a value object not yet placed has none. */
function writeAdjacencies(visitor: ObjectVisitor, target: Visitable, schema: ObjectSchema): void {
  for (const [adjacencyName, adjacency] of schema.adjacencies) {
    for (const entry of linking(adjacency.relation as RelationSchema, adjacency.me, target)) {
      visitor.adjacency(adjacencyName, (a) => a.add((e) => writeEntry(e, entry, adjacency)));
    }
  }
}

function makeInstance(store: OfStore, schema: ObjectSchema, schemaName: string): Instance {
  const target = new ObjectTarget(store, schema, schemaName);
  const readOnly = (): never => {
    throw new AttributeError("proxy properties are read-only; use a builder");
  };
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (INSTANCE_METHODS.has(prop)) return (t[prop as "identity"] as () => unknown).bind(t);
      return read(t, prop, receiver);
    },
    has(t, prop) {
      if (typeof prop === "symbol") return Reflect.has(t, prop);
      return INSTANCE_METHODS.has(prop) || t.values.has(prop) || t.schema.properties.has(prop) || t.schema.adjacencies.has(prop)
        || (_probes.has(prop) && Reflect.has(t, prop)); // as Python's hasattr: what reads without error
    },
    set: readOnly,
    defineProperty: readOnly,
    deleteProperty: readOnly,
    setPrototypeOf: readOnly,
  }) as unknown as Instance;
  target.proxy = proxy;
  instanceTargets.set(proxy, target);
  return proxy;
}

/** A property of an instance or record, or an adjacency's entries, as an attribute; a flat intersection's parts'
 * properties too, as its own. */
function read(t: { values: Map<string, unknown>; schema: RecordSchema }, prop: string, receiver: unknown): unknown {
  if (t.values.has(prop)) return view(t.values.get(prop), (t.schema.properties.get(prop) as Schemas.OfProperty.Data).type);
  if (t.schema.properties.has(prop)) return null; // not set: nothing is mandatory but by a constraint
  const part = owningPart(t.schema, prop);
  if (part !== null) return t.values.has(part) ? (t.values.get(part) as Record<string, unknown>)[prop] : null;
  const adjacency = t.schema instanceof Schemas.OfObject.Data ? t.schema.adjacencies.get(prop) : undefined;
  if (adjacency !== undefined) {
    return new Adjacency(linking(adjacency.relation as RelationSchema, adjacency.me, receiver as Visitable).map((entry) => entry.view), adjacency);
  }
  if (_probes.has(prop)) return Reflect.get(t, prop, receiver);
  throw new AttributeError(prop);
}

/** An adjacency as proxies read it: the frozen array of its entries, in the order they were added, indexed by position.
 * `project(name)` gives each entry's link or property `name`, in order, and `at(key)` the entry with the key its
 * relation declares (`Schemas.OfRelation.Data.key`). Names are arguments, so no link or property can collide. */
class Adjacency extends Array<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  static override get [Symbol.species](): ArrayConstructor {
    return Array; // what `map` and `filter` make is a plain array
  }

  readonly #schema: AdjacencySchema;

  constructor(entries: readonly unknown[], schema: AdjacencySchema) {
    super();
    this.#schema = schema;
    this.push(...entries);
    Object.freeze(this);
  }

  /** Each entry's link or property `name`, in order; null for a property an entry does not set. */
  project(name: string): readonly unknown[] {
    const relation = this.#schema.relation as RelationSchema;
    if (!relation.links.includes(name) && !relation.properties.has(name)) {
      throw new KeyError(`${repr(name)} is not a link or property of the relation`);
    }
    return Object.freeze([...this].map((entry) => (entry as Record<string, unknown>)[name]));
  }

  /** The entry whose key is `key`: one value for a key of one link or property, else an array of them in declaration
   * order. `KeyError` for none, `TypeError` when the relation declares no key from this end. */
  override at(key: unknown): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    const relation = this.#schema.relation as RelationSchema;
    const names = relation.key(this.#schema.me);
    if (names === null) throw new TypeError("the relation declares no key from this end; index by position");
    const wanted = names.length > 1 ? key : [key];
    if (!Array.isArray(wanted) || wanted.length !== names.length) {
      throw new KeyError(`a key of ${repr(names)} is a tuple of ${names.length} values, got ${repr(key)}`);
    }
    for (const entry of this) {
      const held: unknown[] = names.map((name) => (entry as Record<string, unknown>)[name]);
      if (names.every((name, i) => relation.links.includes(name) ? held[i] === wanted[i]
        : held[i] !== null && scalarKey(held[i]) === scalarKey(wanted[i]))) return entry; // a target by identity, a value by schema equality
    }
    throw new KeyError(`no entry has the key ${repr(Array.isArray(key) ? new Tuple(key) : key)}`);
  }
}

/** The part of a flat intersection whose object schema declares the property `prop`, if any. */
function owningPart(schema: RecordSchema, prop: string): string | null {
  if (!(schema instanceof Schemas.OfIntersection.Data && schema.flat)) return null;
  const found = schema.parts.find((part) => (Schemas.structure(part.type) as { properties?: Map<string, unknown> }).properties?.has(prop));
  return found === undefined ? null : found.name;
}

/** A value as code reads it: a flat union's value as its branch's value. */
function view(value: unknown, type: unknown): unknown {
  const schema = Schemas.structure(type);
  if (!(schema instanceof Schemas.OfUnion.Data && schema.flat)) {
    return value;
  }
  const [[branch, held]] = [...(recordTargets.get(value as object) as RecordTarget).values] as [[string, unknown]];
  return view(held, (schema.properties.get(branch) as Schemas.OfUnion.Branch).type);
}

/** What tells a value apart at run time, as `Schemas` tells a flat union's branches apart: a scalar's type, or a value
 * object's schema. */
function runtime(value: unknown): unknown {
  if (isRecord(value)) return (recordTargets.get(value) as RecordTarget).schema;
  return Schemas.SCALAR_TYPES.find((host) => Schemas.isScalarOf(host, value));
}

/** The branch of a flat union whose type a value has. */
function branchOf(name: string, schema: Schemas.OfUnion.Data, value: unknown): Schemas.OfUnion.Branch {
  const found = schema.branches.find((branch) => Schemas._runtime(branch.type) === runtime(value));
  if (found === undefined) {
    throw new TypeError(`property ${repr(name)}: a ${typeName(value)} is not a value of any branch of the flat union`);
  }
  return found;
}

type PropertyHolder = { property(name: string, callback: Callback<OfProperty>): unknown };

/** Writes the values that are set, in the schema's declared order. */
function writeProperties(visitor: PropertyHolder, schema: RecordSchema, values: Map<string, unknown>): void {
  for (const name of schema.properties.keys()) {
    if (values.has(name)) {
      const value = values.get(name);
      visitor.property(name, (p) => p.value((a) => writeValue(a, value)));
    }
  }
}

/** Writes a scalar, a value object, a union value or an intersection value into a `Visitors.OfAny`. */
function writeValue(visitor: OfAny, value: unknown): void {
  if (isRecord(value)) writeRecord(visitor, (recordTargets.get(value) as RecordTarget).schema, (r) => value.accept(r));
  else visitor.as_scalar((n) => n.set(value as Scalar));
}

function writeRecord(visitor: OfAny, schema: RecordSchema, callback: Callback<ObjectVisitor>): void {
  if (schema instanceof Schemas.OfUnion.Data) visitor.as_union(callback as unknown as Callback<OfUnion>);
  else if (schema instanceof Schemas.OfIntersection.Data) visitor.as_intersection(callback as unknown as Callback<OfIntersection>);
  else visitor.as_object(callback);
}

/** The schema of a record: a value object's, or a union's or intersection's, whose properties are its branches or
 * parts. */
type RecordSchema = ObjectSchema | Schemas.OfUnion.Data | Schemas.OfIntersection.Data;

/** What a record of `schema` is, for messages. */
function noun(schema: RecordSchema): string {
  if (schema instanceof Schemas.OfUnion.Data) return "union value";
  if (schema instanceof Schemas.OfIntersection.Data) return "intersection value";
  return "value object";
}

function withArticle(noun: string): string {
  return noun === "intersection value" ? `an ${noun}` : `a ${noun}`;
}

/** A value object as seen by callers: `Visitable`, with properties readable by name. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ValueObject = Visitable & { readonly [name: string]: any };

const recordTargets = new WeakMap<object, RecordTarget>();

/** The state behind a value object: the value of a property whose schema is an `OfObject`, which may have
 * adjacencies, or a union or intersection value, whose properties are the branches or parts. It belongs to one owner
 * and has an identity of its own; its properties are read-only attributes, and one that is not set reads as `null`.
 * Built but not yet placed in an owner, it holds its entries in `pending` until its owner is created
 * or updated. */
class RecordTarget {
  readonly id = ++nextIdentity;
  holder: Visitable | null = null;
  /** The entries linking this value object, by relation and key. */
  readonly adjacent = new Map<RelationSchema, Map<string, Entry>>();
  proxy!: ValueObject;

  constructor(readonly schema: RecordSchema, readonly values: Map<string, unknown>,
    public pending: Map<string, _EntryBuilder[]> = new Map(), readonly source: ValueObject | null = null,
    readonly copyOf: Visitable | null = null) {}

  identity(): number {
    return this.id;
  }

  /** The registered name of the value object's schema, or '' when it is not registered in its store. */
  schema_name(): string {
    const store = storeOf(this.proxy);
    for (const [name, registered] of store === null ? [] : store._schemas) if (registered === this.schema) return name;
    return "";
  }

  owner(): Visitable | null {
    return this.holder;
  }

  /** Identifies itself (an object's value object), then writes its properties in the schema's declared order and the
   * entries linking it. */
  accept(visitor: ObjectVisitor): void {
    if (this.schema instanceof Schemas.OfObject.Data) visitor.identify(this.proxy);
    writeProperties(visitor, this.schema, this.values);
    if (this.schema instanceof Schemas.OfObject.Data) writeAdjacencies(visitor, this.proxy, this.schema);
  }
}

const RECORD_METHODS = new Set(["identity", "schema_name", "owner", "accept"]);

function makeRecord(schema: RecordSchema, values: Map<string, unknown>, pending?: Map<string, _EntryBuilder[]>,
  source: ValueObject | null = null, copyOf: Visitable | null = null): ValueObject {
  const target = new RecordTarget(schema, new Map(values), pending, source, copyOf);
  const readOnly = (): never => {
    throw new AttributeError(`${noun(schema)}s are read-only; use a builder`);
  };
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (RECORD_METHODS.has(prop)) return (t[prop as "identity"] as () => unknown).bind(t);
      return read(t, prop, receiver);
    },
    set: readOnly,
    defineProperty: readOnly,
    deleteProperty: readOnly,
    setPrototypeOf: readOnly,
  }) as unknown as ValueObject;
  target.proxy = proxy;
  recordTargets.set(proxy, target);
  return proxy;
}

function isRecord(value: unknown): value is ValueObject {
  return typeof value === "object" && value !== null && recordTargets.has(value);
}

function stateOf(record: ValueObject): RecordTarget {
  return recordTargets.get(record) as RecordTarget;
}

type Mapping = Map<unknown, unknown>;

/** Prepares `value` to be placed where `old` was: a value object owned elsewhere is copied, and `mapping` records, for
 * each value object copied or edited, the one that takes its place, so that the entries among them link those. */
function stage(old: unknown, value: unknown, mapping: Mapping): unknown {
  if (!isRecord(value) || value === old) return value;
  let state = stateOf(value);
  if (state.source !== null && state.source === old) { // an edit of `old`, which keeps its identity
    mapping.set(old, old);
    stageValues(value, old as ValueObject, mapping);
    return value;
  }
  let staged = value;
  if (state.holder !== null) {
    staged = copy(value);
    state = stateOf(staged);
  }
  for (const original of [state.copyOf, state.source]) if (original !== null) mapping.set(original, staged);
  stageValues(staged, null, mapping);
  return staged;
}

/** Stages the value objects a value object holds: its properties', and its entries'. */
function stageValues(record: ValueObject, old: ValueObject | null, mapping: Mapping): void {
  const held = old === null ? new Map<string, unknown>() : stateOf(old).values;
  const values = stateOf(record).values;
  for (const [name, value] of [...values]) values.set(name, stage(held.get(name), value, mapping));
  for (const builders of stateOf(record).pending.values()) {
    for (const builder of builders) entryOf(builder).stage(old ?? record, mapping);
  }
}

/** A copy of a placed value object, with copies of the entries linking it and the value objects it holds. */
function copy(record: ValueObject): ValueObject {
  const builder = makeRecordBuilder(stateOf(record).schema, undefined, storeOf(record));
  record.accept(builder);
  return (recordBuilderTargets.get(builder) as RecordBuilderTarget).build();
}

/** Places a staged value: an edit is merged into `old`, and a value object built for it is adopted by `owner`. */
function finish(owner: Visitable, old: unknown, value: unknown, mapping: Mapping): unknown {
  if (!isRecord(value) || value === old) return value;
  const state = stateOf(value);
  if (state.source !== null && state.source === old) {
    merge(old as ValueObject, value, mapping);
    return old;
  }
  state.holder = owner;
  for (const [name, held] of [...state.values]) state.values.set(name, finish(value, null, held, mapping));
  addPending(value, mapping);
  return value;
}

/**
 * Adds a value object's entries, whose value objects take the place of those in `mapping`. Its relations have one link,
 * its own, so no other object gives these entries.
 */
function addPending(record: ValueObject, mapping: Mapping): void {
  const state = stateOf(record);
  for (const [name, builders] of state.pending) {
    const adjacency = (state.schema as ObjectSchema).adjacencies.get(name) as AdjacencySchema;
    const relation = adjacency.relation as RelationSchema;
    for (const builder of builders) {
      entryOf(builder).place(record, mapping);
      addEntry(relation, builder.build(record));
    }
  }
  state.pending = new Map();
}

/** Writes an edit of a placed value object into it, so that it keeps its identity. */
function merge(old: ValueObject, edit: ValueObject, mapping: Mapping): void {
  const target = stateOf(old);
  const before = heldBy(old);
  const values = new Map<string, unknown>();
  for (const [name, value] of stateOf(edit).values) values.set(name, finish(old, target.values.get(name), value, mapping));
  target.values.clear();
  for (const [name, value] of values) target.values.set(name, value);
  if (target.schema instanceof Schemas.OfObject.Data) {
    for (const adjacency of target.schema.adjacencies.values()) {
      discardLinking(adjacency.relation as RelationSchema, adjacency.me, old);
    }
  }
  target.pending = stateOf(edit).pending;
  addPending(old, mapping);
  drop(before, heldBy(old));
}

/** The value objects that `values` hold directly. */
function records(values: readonly unknown[]): ValueObject[] {
  return values.filter(isRecord);
}

/** The values an object or a value object holds: its properties', and those of the entries of its one-link relations,
 * which hold values for it alone. */
function heldBy(owner: Visitable): unknown[] {
  const state = (instanceTargets.get(owner) ?? recordTargets.get(owner)) as ObjectTarget | RecordTarget;
  const values = [...state.values.values()];
  for (const adjacency of state.schema instanceof Schemas.OfObject.Data ? state.schema.adjacencies.values() : []) {
    const relation = adjacency.relation as RelationSchema;
    if (relation.links.length === 1) {
      for (const entry of linking(relation, adjacency.me, owner)) values.push(...entry.properties.values());
    }
  }
  return values;
}

/** Removes the value objects held among the values `before` and no longer among those `after`. */
function drop(before: readonly unknown[], after: readonly unknown[]): void {
  const kept = new Set(records(after));
  for (const record of records(before)) if (!kept.has(record)) remove(record);
}

/** Removes a value object no longer held: the value objects it holds, its entries' too, and every entry linking it. */
function remove(value: ValueObject): void {
  for (const held of records(heldBy(value))) remove(held);
  discardTarget(value);
}

function isInstance(value: unknown): value is Instance {
  return typeof value === "object" && value !== null && instanceTargets.has(value);
}

/** Whether an entry builder adds its entry: an entry rewritten from one already held (`source`), linking the same
 * objects, is added once in one build, though every object it links gives it, which in an open relation would
 * otherwise add it again. */
function firstCopy(relation: RelationSchema, builder: _EntryBuilder, target: Visitable, mapping: Mapping): boolean {
  const source = builder.source;
  if (source === null || !relation.open) return true;
  const links = new Map<string, unknown>([...builder.linkValues, [builder.me, target]]);
  const key = `entry:${source.id}:${JSON.stringify([...links].map(([name, linked]) => [name, (linked as Visitable).identity()]).sort())}`;
  if (mapping.has(key)) return false;
  mapping.set(key, source);
  return true;
}

/** Writes an entry's links and properties in the relation's declared order, whichever end built the entry. A proxy's
 * entry builder remembers the entry it copies. */
function writeEntry(visitor: EntryVisitor, entry: Entry, adjacency: AdjacencySchema): void {
  const relation = adjacency.relation as RelationSchema;
  const builder = entryTargets.get(visitor as object);
  if (builder !== undefined) builder.source = entry;
  for (const name of relation.links) {
    if (name !== adjacency.me) {
      const target = entry.links.get(name) as Instance;
      visitor.link(name, (k) => k.set(target));
    }
  }
  for (const name of relation.properties.keys()) {
    if (entry.properties.has(name)) {
      const value = entry.properties.get(name);
      visitor.property(name, (p) => p.value((a) => writeValue(a, value)));
    }
  }
}

// --- Builders ---

/** `Visitors.OfScalar` over one key of a value map. */
export class _ScalarSlot implements OfScalar {
  constructor(private readonly values: Map<string, unknown>, private readonly slotName: string) {}

  has(): boolean {
    return this.values.has(this.slotName);
  }

  get(): Scalar {
    if (!this.values.has(this.slotName)) throw new AttributeError(`property ${repr(this.slotName)} is not set`);
    return this.values.get(this.slotName) as Scalar;
  }

  set(value: Scalar): _ScalarSlot {
    this.values.set(this.slotName, value);
    return this;
  }

  clear(): _ScalarSlot {
    this.values.delete(this.slotName);
    return this;
  }
}

/** `Visitors.OfAny` over one key of a value map, holding a value of `schema` (an entry property's schema is not
 * given: entry properties are scalar). */
export class _AnySlot implements OfAny {
  private readonly schema: unknown;

  constructor(private readonly values: Map<string, unknown>, private readonly slotName: string,
    schema: unknown = null, private readonly store: OfStore | null = null) {
    this.schema = Schemas.structure(schema);
  }

  as_scalar(callback: Callback<OfScalar>): _AnySlot {
    callback(new _ScalarSlot(this.values, this.slotName));
    return this;
  }

  /** Builds a value object, starting from the one already set, if any. */
  as_object(callback: Callback<ObjectVisitor>): _AnySlot {
    return this.record(Schemas.OfObject.Data, "an object", callback);
  }

  /** Builds a union value, starting from the one already set, if any. */
  as_union(callback: Callback<OfUnion>): _AnySlot {
    return this.record(Schemas.OfUnion.Data, "a union", callback as unknown as Callback<ObjectVisitor>);
  }

  /** Builds an intersection value, starting from the one already set, if any. */
  as_intersection(callback: Callback<OfIntersection>): _AnySlot {
    return this.record(Schemas.OfIntersection.Data, "an intersection", callback as unknown as Callback<ObjectVisitor>);
  }

  private record(kind: abstract new (...args: never[]) => RecordSchema, what: string,
    callback: Callback<ObjectVisitor>): _AnySlot {
    if (!(this.schema instanceof kind)) throw new TypeError(`property ${repr(this.slotName)} does not hold ${what}`);
    const current = this.values.get(this.slotName);
    const builder = makeRecordBuilder(this.schema, isRecord(current) ? current : undefined, this.store);
    callback(builder);
    const target = recordBuilderTargets.get(builder) as RecordBuilderTarget;
    if (this.schema instanceof Schemas.OfUnion.Data && target.values.size === 0) {
      this.values.delete(this.slotName); // a union value without a branch is no value
    } else {
      this.values.set(this.slotName, target.build());
    }
    return this;
  }
}

/** `Visitors.OfProperty` over one key of a value map, holding a value of `schema`. */
export class _PropertySlot implements OfProperty {
  constructor(private readonly values: Map<string, unknown>, private readonly slotName: string,
    private readonly schema: unknown = null, private readonly store: OfStore | null = null) {}

  name(): string {
    return this.slotName;
  }

  has(): boolean {
    return this.values.has(this.slotName);
  }

  value(callback: Callback<OfAny>): _PropertySlot {
    callback(new _AnySlot(this.values, this.slotName, this.schema, this.store));
    return this;
  }

  clear(): _PropertySlot {
    this.values.delete(this.slotName);
    return this;
  }
}

/** DSL setter for a property of `schema`: `.name(value)`, or `.name(Spec)` where the Spec receives the value's builder:
 * a `Visitors.OfScalar` (`v.set(...)`), or the builder of a value object, a union value or an intersection value,
 * which starts from the value already set. A value object given as the value replaces the one set. */
function setter<V extends PropertyHolder>(visitor: V, self: unknown, name: string, schema: unknown = null) {
  return (spec: unknown): unknown => {
    if (isRecord(spec)) visitor.property(name, (p) => p.clear().value((a) => apply(a, name, schema, spec)));
    else visitor.property(name, (p) => p.value((a) => apply(a, name, schema, spec)));
    return self;
  };
}

/** Writes `spec` (a value, or a callable taking the value's builder) as a value of `schema`. */
function apply(visitor: OfAny, name: string, type: unknown, spec: unknown): void {
  const schema = Schemas.structure(type);
  if (schema instanceof Schemas.OfUnion.Data && schema.flat && typeof spec !== "function"
    && !(isRecord(spec) && (recordTargets.get(spec) as RecordTarget).schema === schema)) {
    const branch = branchOf(name, schema, spec); // a flat union's value: its branch's, told apart by type
    writeRecord(visitor, schema, (r) => r.property(branch.name, (p) => p.value((a) => apply(a, branch.name, branch.type, spec))));
  } else if (schema instanceof Schemas.OfObject.Data || schema instanceof Schemas.OfUnion.Data
    || schema instanceof Schemas.OfIntersection.Data) {
    if (typeof spec === "function") writeRecord(visitor, schema, spec as Callback<ObjectVisitor>);
    else if (isRecord(spec)) writeRecord(visitor, schema, (r) => spec.accept(r));
    else throw new TypeError(`property ${repr(name)} takes ${withArticle(noun(schema))} or a Spec, got ${typeName(spec)}`);
  } else {
    visitor.as_scalar(typeof spec === "function" ? (spec as Callback<OfScalar>) : (n) => n.set(spec as Scalar));
  }
}

const RECORD_BUILDER_METHODS = new Set(["properties", "has", "property", "clear", "adjacencies", "adjacency", "identify"]);
const recordBuilderTargets = new WeakMap<object, RecordBuilderTarget>();

/** `Visitors.OfObject` for building a value object, starting from `source` if given; also `Visitors.OfUnion` and
 * `Visitors.OfIntersection` for a union or intersection value, whose properties are the branches or parts. DSL:
 * `.<property>(value or Spec)` and `.<adjacency>(entry Spec)`. Writing a union's branch clears any other. */
export class RecordBuilderTarget implements ObjectVisitor {
  readonly values: Map<string, unknown>;
  readonly entries = new Map<string, _EntryBuilder[]>();
  readonly member: string;
  readonly source: ValueObject | null;
  copyOf: Visitable | null = null;
  proxy!: ObjectVisitor;

  constructor(readonly schema: RecordSchema, source?: ValueObject, readonly store: OfStore | null = null) {
    this.source = source ?? null;
    this.values = new Map(source === undefined ? [] : stateOf(source).values);
    if (source !== undefined && schema instanceof Schemas.OfObject.Data) loadEntries(this.entries, schema, source);
    this.member = schema instanceof Schemas.OfUnion.Data ? "branch of the union"
      : schema instanceof Schemas.OfIntersection.Data ? "part of the intersection" : "property of the value object";
  }

  properties(callback: Callback<OfProperty>): ObjectVisitor {
    for (const [name, prop] of this.schema.properties) {
      if (this.values.has(name)) callback(new _PropertySlot(this.values, name, prop.type, this.store));
    }
    return this.proxy;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): ObjectVisitor {
    const schema = this.schema.properties.get(name)?.type;
    if (schema === undefined) throw new AttributeError(`${repr(name)} is not a ${this.member}`);
    if (this.schema instanceof Schemas.OfUnion.Data) {
      for (const other of [...this.values.keys()]) if (other !== name) this.values.delete(other);
    }
    callback(new _PropertySlot(this.values, name, schema, this.store));
    return this.proxy;
  }

  clear(name: string): ObjectVisitor {
    this.values.delete(name);
    return this.proxy;
  }

  /** The adjacencies of the value object's schema; a union or intersection value has none. */
  adjacencyNames(): string[] {
    return this.schema instanceof Schemas.OfObject.Data ? [...this.schema.adjacencies.keys()] : [];
  }

  adjacencies(callback: Callback<AdjacencyVisitor>): ObjectVisitor {
    for (const name of this.adjacencyNames()) callback(new _AdjacencySlot(this, name));
    return this.proxy;
  }

  adjacency(name: string, callback: Callback<AdjacencyVisitor>): ObjectVisitor {
    const names = this.adjacencyNames();
    if (names.length === 0) throw new AttributeError(`${withArticle(noun(this.schema))} has no adjacencies, got ${repr(name)}`);
    if (!names.includes(name)) throw new AttributeError(`${repr(name)} is not an adjacency of the ${noun(this.schema)}`);
    callback(new _AdjacencySlot(this, name));
    return this.proxy;
  }

  /** A value object replays itself into this builder: the value object built is a copy of it. */
  identify(value: Visitable): ObjectVisitor {
    this.copyOf = value;
    return this.proxy;
  }

  build(): ValueObject {
    return makeRecord(this.schema, this.values, this.entries, this.source, this.copyOf);
  }
}

/** DSL adder for an adjacency: `.<adjacency>((x) => x.<link>(...))`. */
function adder(builder: { adjacency(name: string, callback: Callback<AdjacencyVisitor>): unknown }, name: string) {
  return (spec: unknown): unknown => {
    if (typeof spec !== "function") throw new TypeError(`${repr(name)} takes an entry Spec, e.g. x => x.<link>(...)`);
    return builder.adjacency(name, (a) => a.add(spec as Callback<EntryVisitor>));
  };
}

/** Loads the entries linking `source` into a builder, as entry builders, so that an update rewrites them. */
function loadEntries(entries: Map<string, _EntryBuilder[]>, schema: ObjectSchema, source: Visitable): void {
  const store = storeOf(source);
  for (const [name, adjacency] of schema.adjacencies) {
    for (const entry of linking(adjacency.relation as RelationSchema, adjacency.me, source)) {
      const builder = makeEntryBuilder(adjacency.relation as RelationSchema, adjacency.me, store);
      const state = entryOf(builder);
      for (const [link, target] of entry.links) if (link !== adjacency.me) state.linkValues.set(link, target as LinkValue);
      for (const [key, value] of entry.properties) state.values.set(key, value);
      state.source = entry;
      entries.set(name, [...(entries.get(name) ?? []), builder]);
    }
  }
  for (const [name, pending] of isRecord(source) ? stateOf(source).pending : []) {
    entries.set(name, [...(entries.get(name) ?? []), ...pending]);
  }
}

function makeRecordBuilder(schema: RecordSchema, source?: ValueObject, store: OfStore | null = null): ObjectVisitor {
  const target = new RecordBuilderTarget(schema, source, store);
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (RECORD_BUILDER_METHODS.has(prop)) return (t[prop as "has"] as (...a: unknown[]) => unknown).bind(t);
      const schema = t.schema.properties.get(prop)?.type;
      if (schema !== undefined) return setter(t, t.proxy, prop, schema);
      if (t.adjacencyNames().includes(prop)) return adder(t, prop);
      const part = owningPart(t.schema, prop);
      if (part !== null) { // a flat intersection's part's property: set in that part, from the value already set
        const set = setter(t, t.proxy, part, (t.schema.properties.get(part) as Schemas.OfProperty.Data).type);
        return (spec: unknown) => set((b: Record<string, (v: unknown) => unknown>) => (b[prop] as (v: unknown) => unknown)(spec));
      }
      if (_probes.has(prop)) return Reflect.get(t, prop, receiver);
      throw new AttributeError(`${repr(prop)} is not a ${t.member}`);
    },
  }) as unknown as ObjectVisitor;
  target.proxy = proxy;
  recordBuilderTargets.set(proxy, target);
  return proxy;
}

type LinkValue = Visitable | ObjectBuilderTarget;

/** `Visitors.OfLink` over one link of an entry builder. */
export class _LinkSlot implements OfLink {
  constructor(private readonly links: Map<string, LinkValue>, private readonly linkName: string,
    private readonly store: OfStore | null = null) {}

  name(): string {
    return this.linkName;
  }

  target(callback: Callback<Visitable>): _LinkSlot {
    callback(this.links.get(this.linkName) as Visitable);
    return this;
  }

  set(target: Visitable): _LinkSlot {
    if (isRecord(target)) throw new TypeError("a link targets a reference object, never a value object");
    if (!isInstance(target)) throw new TypeError("proxies can only link proxy instances");
    sameStore(this.store, target);
    this.links.set(this.linkName, target);
    return this;
  }
}

const ENTRY_METHODS = new Set(["links", "link", "properties", "has", "property", "clear", "build"]);

/** `Visitors.OfEntry` for one entry being added through an adjacency. The object's own link (`me`) is filled when
 * the object builder is finalized. DSL: `.<link>(object or Spec)` and `.<property>(value or Spec)`. */
export class _EntryBuilder implements EntryVisitor {
  readonly linkValues = new Map<string, LinkValue>();
  readonly values = new Map<string, Scalar>();
  /** The entry this one rewrites, when copied or loaded from one. */
  source: Entry | null = null;
  proxy!: _EntryBuilder;

  constructor(private readonly relation: RelationSchema, readonly me: string, readonly store: OfStore | null = null) {}

  private checkLink(name: string): void {
    if (name === this.me || !this.relation.links.includes(name)) {
      throw new AttributeError(`${repr(name)} is not a link this entry can set`);
    }
  }

  links(callback: Callback<OfLink>): _EntryBuilder {
    for (const name of this.relation.links) if (name !== this.me) callback(new _LinkSlot(this.linkValues, name, this.store));
    return this.proxy;
  }

  link(name: string, callback: Callback<OfLink>): _EntryBuilder {
    this.checkLink(name);
    callback(new _LinkSlot(this.linkValues, name, this.store));
    return this.proxy;
  }

  properties(callback: Callback<OfProperty>): _EntryBuilder {
    for (const name of [...this.values.keys()]) callback(new _PropertySlot(this.values, name, this.relation.properties.get(name)?.type, this.store));
    return this.proxy;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): _EntryBuilder {
    if (!this.relation.properties.has(name)) throw new AttributeError(`${repr(name)} is not a property of this relation`);
    callback(new _PropertySlot(this.values, name, this.relation.properties.get(name)?.type, this.store));
    return this.proxy;
  }

  clear(name: string): _EntryBuilder {
    this.values.delete(name);
    return this.proxy;
  }

  dsl(name: string): ((spec: unknown) => unknown) | undefined {
    if (name.startsWith("_")) throw new AttributeError(name);
    if (this.relation.links.includes(name)) {
      this.checkLink(name);
      return (spec: unknown) => {
        if (typeof spec === "function") {
          if (this.store === null) throw new TypeError("an object is created through a link only by a store's builder");
          const schemaName = this.store._filled(this.relation, name);
          const builder = makeObjectBuilder(this.store, this.store.schema(schemaName), schemaName);
          spec(builder);
          this.linkValues.set(name, builderTargets.get(builder) as ObjectBuilderTarget);
        } else {
          this.link(name, (k) => k.set(spec as Visitable));
        }
        return this.proxy;
      };
    }
    if (this.relation.properties.has(name)) return setter(this, this.proxy, name, (this.relation.properties.get(name) as Schemas.OfProperty.Data).type);
    return undefined;
  }

  /** The values of the entry this one rewrites, where it links the same `target`: an update keeps them. */
  private kept(target: Visitable): Map<string, unknown> {
    const source = this.source;
    return source !== null && source.links.get(this.me) === target ? source.properties : new Map();
  }

  /** Stages the value objects the entry holds for `target`, before any is placed (see `stage`). */
  stage(target: Visitable, mapping: Mapping): void {
    const kept = this.kept(target);
    for (const [name, value] of [...this.values]) this.values.set(name, stage(kept.get(name), value, mapping) as Scalar);
  }

  /** Places the staged value objects the entry holds as `target`'s. */
  place(target: Visitable, mapping: Mapping): void {
    const kept = this.kept(target);
    for (const [name, value] of [...this.values]) this.values.set(name, finish(target, kept.get(name), value, mapping) as Scalar);
  }

  /** The entry, linking `target`, holding its values as placed. */
  build(target: Visitable): Entry {
    const links = new Map<string, Visitable>([[this.me, target]]);
    for (const name of this.relation.links) {
      if (name === this.me) continue;
      const value = this.linkValues.get(name);
      if (value === undefined) throw new ValueError(`link ${repr(name)} is not set`);
      links.set(name, value instanceof ObjectBuilderTarget ? value.create() : value);
    }
    return new Entry(this.relation, links, new Map(this.values));
  }
}

/** The entry builder behind each entry builder's proxy, for the state that its DSL would read as names. */
const entryTargets = new WeakMap<object, _EntryBuilder>();

function entryOf(builder: _EntryBuilder): _EntryBuilder {
  return entryTargets.get(builder) as _EntryBuilder;
}

function makeEntryBuilder(relation: RelationSchema, me: string, store: OfStore | null = null): _EntryBuilder {
  const target = new _EntryBuilder(relation, me, store);
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (ENTRY_METHODS.has(prop)) return (t[prop as "links"] as (...a: unknown[]) => unknown).bind(t);
      const dsl = t.dsl(prop);
      if (dsl !== undefined) return dsl;
      if (_probes.has(prop)) return Reflect.get(t, prop, receiver);
      throw new AttributeError(prop);
    },
  });
  target.proxy = proxy;
  entryTargets.set(proxy, target);
  return proxy;
}

/** `Visitors.OfAdjacency` over one adjacency of an object builder. */
export class _AdjacencySlot implements AdjacencyVisitor {
  private readonly schema: AdjacencySchema;

  constructor(private readonly builder: ObjectBuilderTarget | RecordBuilderTarget, private readonly adjacencyName: string) {
    this.schema = (builder.schema as ObjectSchema).adjacencies.get(adjacencyName) as AdjacencySchema;
  }

  name(): string {
    return this.adjacencyName;
  }

  me(): string {
    return this.schema.me;
  }

  entries(callback: Callback<EntryVisitor>): _AdjacencySlot {
    for (const entry of [...(this.builder.entries.get(this.adjacencyName) ?? [])]) callback(entry);
    return this;
  }

  add(callback: Callback<EntryVisitor>): _AdjacencySlot {
    const entry = makeEntryBuilder(this.schema.relation as RelationSchema, this.schema.me, this.builder.store);
    callback(entry);
    const list = this.builder.entries.get(this.adjacencyName) ?? [];
    list.push(entry);
    this.builder.entries.set(this.adjacencyName, list);
    return this;
  }

  remove(entry: EntryVisitor): _AdjacencySlot {
    const list = this.builder.entries.get(this.adjacencyName) ?? [];
    this.builder.entries.set(this.adjacencyName, list.filter((e) => e !== entry));
    return this;
  }
}

const BUILDER_METHODS = new Set(["properties", "has", "property", "clear", "adjacencies", "adjacency", "identify", "create",
  "clone", "update"]);
const builderTargets = new WeakMap<object, ObjectBuilderTarget>();

/** `Visitors.OfObject` for building a proxy instance. DSL: `.<property>(value or Spec)` and `.<adjacency>(entry
 * Spec)`. Finalized by `create()`, `clone()` or `update()`; none validate. */
export class ObjectBuilderTarget implements ObjectVisitor {
  readonly values = new Map<string, unknown>();
  readonly entries = new Map<string, _EntryBuilder[]>();
  proxy!: DynamicBuilder;

  constructor(readonly store: OfStore, readonly schema: ObjectSchema, readonly schemaName: string,
    private readonly source?: Instance) {}

  properties(callback: Callback<OfProperty>): DynamicBuilder {
    for (const name of [...this.values.keys()]) callback(new _PropertySlot(this.values, name, this.schema.properties.get(name)?.type, this.store));
    return this.proxy;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): DynamicBuilder {
    if (!this.schema.properties.has(name)) throw new AttributeError(`${repr(name)} is not a property of ${repr(this.schemaName)}`);
    callback(new _PropertySlot(this.values, name, this.schema.properties.get(name)?.type, this.store));
    return this.proxy;
  }

  clear(name: string): DynamicBuilder {
    this.values.delete(name);
    return this.proxy;
  }

  adjacencies(callback: Callback<AdjacencyVisitor>): DynamicBuilder {
    for (const name of this.schema.adjacencies.keys()) callback(new _AdjacencySlot(this, name));
    return this.proxy;
  }

  adjacency(name: string, callback: Callback<AdjacencyVisitor>): DynamicBuilder {
    if (!this.schema.adjacencies.has(name)) throw new AttributeError(`${repr(name)} is not an adjacency of ${repr(this.schemaName)}`);
    callback(new _AdjacencySlot(this, name));
    return this.proxy;
  }

  identify(_value: Visitable): DynamicBuilder {
    return this.proxy;
  }

  dsl(name: string): ((spec: unknown) => unknown) | undefined {
    if (name.startsWith("_")) throw new AttributeError(name);
    if (this.schema.properties.has(name)) return setter(this, this.proxy, name, (this.schema.properties.get(name) as Schemas.OfProperty.Data).type);
    if (this.schema.adjacencies.has(name)) return adder(this, name);
    return undefined;
  }

  create(...args: unknown[]): Instance {
    noArguments("create", args);
    if (this.source !== undefined) {
      throw new ValueError("create() is only valid without a source instance; use clone() or update()");
    }
    this.notSingleton("create");
    return this.write(makeInstance(this.store, this.schema, this.schemaName));
  }

  clone(...args: unknown[]): Instance {
    noArguments("clone", args);
    if (this.source === undefined) throw new ValueError("clone() is only valid with a source instance");
    this.notSingleton("clone");
    return this.write(makeInstance(this.store, this.schema, this.schemaName));
  }

  update(...args: unknown[]): Instance {
    noArguments("update", args);
    if (this.source === undefined) throw new ValueError("update() is only valid with a source instance");
    const before = heldBy(this.source);
    for (const adjacency of this.schema.adjacencies.values()) {
      discardLinking(adjacency.relation as RelationSchema, adjacency.me, this.source);
    }
    return this.write(this.source, before);
  }

  private notSingleton(method: string): void {
    if (this.schema.singleton !== null) {
      throw new ValueError(`${method}() would make a second ${repr(this.schemaName)}; its one instance is `
        + `store.singleton(${repr(this.schema.singleton)})`);
    }
  }

  /** Writes the builder into `target`. Every value object it holds, its entries' too, is staged before any is placed,
   * so that the entries among them link the right ones; those held `before` and no longer are removed. */
  private write(target: Instance, before: unknown[] = []): Instance {
    const state = instanceTargets.get(target) as ObjectTarget;
    const mapping: Mapping = new Map();
    if (this.source !== undefined && target !== this.source) mapping.set(this.source, target); // a clone: its value objects link it
    const old = new Map(state.values);
    const staged = new Map([...this.values].map(([name, value]) => [name, stage(old.get(name), value, mapping)] as const));
    for (const entries of this.entries.values()) for (const entry of entries) entryOf(entry).stage(target, mapping);
    const values = new Map([...staged].map(([name, value]) => [name, finish(target, old.get(name), value, mapping)] as const));
    for (const entries of this.entries.values()) for (const entry of entries) entryOf(entry).place(target, mapping);
    mapping.delete(this.source); // its own entries keep their links (a self-loop links the source)
    state.values.clear();
    for (const [name, value] of values) state.values.set(name, value);
    for (const [name, entries] of this.entries) {
      const relation = (this.schema.adjacencies.get(name) as AdjacencySchema).relation as RelationSchema;
      for (const entry of entries) {
        if (firstCopy(relation, entryOf(entry), target, mapping)) addEntry(relation, entry.build(target));
      }
    }
    drop(before, heldBy(target));
    return target;
  }
}

function noArguments(method: string, args: unknown[]): void {
  if (args.length > 0) throw new TypeError(`${method}() takes no arguments (${args.length} given)`);
}

function makeObjectBuilder(store: OfStore, schema: ObjectSchema, schemaName: string, instance?: Instance): DynamicBuilder {
  if (!schema.ref) {
    throw new TypeError(`${repr(schemaName)} is a value object schema; a value object is built through its owner`);
  }
  if (instance !== undefined && !isInstance(instance)) throw new TypeError("a builder's source must be a proxy instance");
  const target = new ObjectBuilderTarget(store, schema, schemaName, instance);
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (BUILDER_METHODS.has(prop)) return (t[prop as "has"] as (...a: unknown[]) => unknown).bind(t);
      const dsl = t.dsl(prop);
      if (dsl !== undefined) return dsl;
      if (_probes.has(prop)) return Reflect.get(t, prop, receiver);
      throw new AttributeError(`${repr(prop)} is not a property or adjacency of ${repr(schemaName)}`);
    },
  }) as unknown as DynamicBuilder;
  target.proxy = proxy;
  builderTargets.set(proxy, target);
  if (instance !== undefined) {
    if (instance.schema_name() !== schemaName) {
      throw new TypeError(`instance is a ${repr(instance.schema_name())}, not a ${repr(schemaName)}`);
    }
    sameStore(store, instance);
    // the value objects themselves, so that an update keeps them
    for (const [name, value] of (instanceTargets.get(instance) as ObjectTarget).values) target.values.set(name, value);
    loadEntries(target.entries, schema, instance);
  }
  return proxy;
}

export namespace OfObject {
  /** The class of proxy instances: `value instanceof Proxies.OfObject.Data`, as Python's `isinstance`. */
  export const Data = ObjectTarget;
  export type Data = Instance;
  /** The class of value objects: `value instanceof Proxies.OfObject.Record`. */
  export const Record = RecordTarget;
  export type Record = ValueObject;
  export type Builder = DynamicBuilder;
  /** A builder in `store` for `schema` registered as `schemaName`, as `store[schemaName](instance)` returns. */
  export function Builder(store: OfStore, schema: ObjectSchema, schemaName: string, instance?: Instance): DynamicBuilder {
    return makeObjectBuilder(store, schema, schemaName, instance);
  }
}

/** An adjacency as proxies read it: `Data`, the frozen array of its entries, with `project(name)` and `at(key)`. */
export namespace OfAdjacency {
  export const Data = Adjacency;
  export type Data = Adjacency;
}

/** A relation's entries as proxies hold them: `Data`, an entry with every link, the owner's own included, and its
 * properties, as an adjacency's iterable yields it (`entry instanceof Proxies.OfEntry.Data`). */
export namespace OfEntry {
  export const Data = Entry;
  export type Data = Entry;
}

/** Internal classes, exposed for protocol conformance tests. */
export const _internals = { ObjectTarget, ObjectBuilderTarget, RecordBuilderTarget, _EntryBuilder, _AdjacencySlot, _LinkSlot,
  _PropertySlot, _AnySlot, _ScalarSlot };
