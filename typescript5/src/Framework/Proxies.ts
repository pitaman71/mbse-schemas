/**
 * Proxies: the dynamic implementation.
 *
 * Programs using proxies skip code generation: `register(name, schema)` makes a schema available, and
 * `Builders.<Name>(optional instance)` returns a builder for it. Instances (`Proxies.OfObject.Data`) are `Visitable`,
 * not visitors: they expose their properties as read-only attributes and write themselves into a visitor on `accept`.
 * Builders (`Proxies.OfObject.Builder`) implement `Visitors.OfObject`, like every builder.
 *
 * Attribute lookup follows Python's: the builder's or instance's own methods first, then schema names. Reading an
 * unknown name throws `AttributeError`, except JavaScript's own protocol probes (`then`, `toJSON`, `constructor`,
 * symbols, ...), which behave as on any object. Identities are never reused.
 *
 * Relation entries live in one global table per relation. Adding an entry equal to an existing one is elided.
 *
 * A property whose schema is an `OfObject` holds a value object: a read-only record with no identity
 * (`Proxies.OfObject.Record`), read with attributes like an instance and set with a Spec, e.g.
 * `.reach((r) => r.number("+44"))`. Union and intersection values are records too, whose properties are the union's
 * branches or the intersection's parts, by name: `.reach((u) => u.phone((p) => p.number("+44")))` sets the branch
 * `phone`, read back as `card.reach.phone.number`, and setting one branch clears any other. An intersection value holds
 * each of its parts, set and read the same way (`card.meta.stamp.updated`).
 */


import { toHex } from "./Bytes.js";
import { AttributeError, LookupError, NotImplementedError, ValueError } from "./Errors.js";
import { repr, sortedStrings, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type { Callback, Native, OfAdjacency, OfAny, OfEntry, OfIntersection, OfLink, OfNative,
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
const PROBES = new Set<string>([
  "then", "catch", "finally", "toJSON", "constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty",
  "isPrototypeOf", "propertyIsEnumerable", "__proto__", "$$typeof", "asymmetricMatch", "nodeType", "inspect",
]);

// --- Registry ---

const registry = new Map<string, ObjectSchema | RelationSchema>();

/** Registers a schema under a global name. The name need not be a valid identifier. */
export function register(name: string, schema: ObjectSchema | RelationSchema): void {
  if (registry.has(name)) throw new ValueError(`schema ${repr(name)} is already registered`);
  registry.set(name, schema);
}

/** The object schema registered under `name`. */
export function schema(name: string): ObjectSchema {
  return objectSchema(name);
}

/** The name `schema` is registered under. */
export function name_of(schema: ObjectSchema | RelationSchema): string {
  for (const [name, registered] of registry) if (registered === schema) return name;
  throw new LookupError("schema is not registered");
}

function objectSchema(name: string): ObjectSchema {
  const found = registry.get(name);
  if (found === undefined) throw new AttributeError(`no schema registered as ${repr(name)}`);
  if (!(found instanceof Schemas.OfObject.Data)) throw new TypeError(`${repr(name)} is a relation; no relation builder is exposed`);
  return found;
}

/** The value an instance or value object holds in its property `name`. */
function member(instance: unknown, name: string): unknown {
  const t = instanceTargets.get(instance as object) ?? recordTargets.get(instance as object) as RecordTarget;
  return read(t, name, instance);
}

/** Name of the registered object schema that declares an adjacency to `relation` via `link`. */
function schemaFilling(relation: RelationSchema, link: string): string {
  const names = [...registry]
    .filter(([, s]) => s instanceof Schemas.OfObject.Data && [...s.adjacencies.values()].some((a) => a.relation === relation && a.me === link))
    .map(([name]) => name);
  if (names.length !== 1) throw new TypeError(`expected exactly one object schema filling link ${repr(link)}, found ${repr(names)}`);
  return names[0] as string;
}

/** `Builders.<Name>(optional instance)`; use `Builders[name]` for names that are not identifiers. `schema` and
 * `name_of` are methods, so schemas registered under those names are reachable only through `schema()`. */
export const Builders: {
  schema(name: string): ObjectSchema;
  name_of(schema: ObjectSchema | RelationSchema): string;
  /** The value an instance or value object holds in its property `name`. */
  member(instance: unknown, name: string): unknown;
  /** `(instance?: Instance) => DynamicBuilder` for each registered object schema; dynamic by design. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [name: string]: any;
} = new Proxy({ schema, name_of, member } as Record<string | symbol, unknown>, {
  get(target, prop, receiver) {
    if (prop === "schema" || prop === "name_of" || prop === "member" || typeof prop === "symbol") {
      return Reflect.get(target, prop, receiver);
    }
    if (!registry.has(prop) && PROBES.has(prop)) return Reflect.get(target, prop, receiver);
    const found = objectSchema(prop);
    return (instance?: Instance) => makeObjectBuilder(found, prop, instance);
  },
}) as never;

// --- Relation entries ---

const floatView = new DataView(new ArrayBuffer(8));

const schemaIds = new WeakMap<object, number>();
let nextSchemaId = 0;

/** A number for each schema, as Python's `id()` of it, so that value objects of different schemas differ. */
function schemaId(schema: object): number {
  if (!schemaIds.has(schema)) schemaIds.set(schema, ++nextSchemaId);
  return schemaIds.get(schema) as number;
}

/** Equality key per EQUALITY.md: distinct native types never compare equal; floats compare by bit pattern; a value
 * object by its schema and properties, whatever its identity. */
export function nativeKey(value: unknown): string {
  if (isRecord(value)) {
    const state = stateOf(value);
    const values = sortedStrings(state.values.keys()).map((name) => [name, nativeKey(state.values.get(name))]);
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
  throw new TypeError(`an entry property must be a native value or a value object, got ${typeName(value)}`);
}

class Entry {
  constructor(readonly links: Map<string, Visitable>, readonly properties: Map<string, Native>) {}

  key(): string {
    const links = [...this.links].map(([name, target]) => [name, target.identity()] as const).sort(byName);
    const props = [...this.properties].map(([name, value]) => [name, nativeKey(value)] as const).sort(byName);
    return JSON.stringify([links, props]);
  }
}

function byName(a: readonly [string, unknown], b: readonly [string, unknown]): number {
  return a[0] < b[0] ? -1 : 1; // names within an entry are unique
}

/** All entries of one relation. */
class RelationData {
  private readonly entries = new Map<string, Entry>();

  constructor(readonly schema: RelationSchema) {}

  add(entry: Entry): void {
    const key = entry.key();
    if (!this.entries.has(key)) this.entries.set(key, entry);
  }

  linking(link: string, target: Visitable): Entry[] {
    return [...this.entries.values()].filter((entry) => entry.links.get(link) === target);
  }

  discard_linking(link: string, target: Visitable): void {
    for (const [key, entry] of [...this.entries]) if (entry.links.get(link) === target) this.entries.delete(key);
  }

  /** Discards every entry that links `target`, through any link. */
  discard_target(target: Visitable): void {
    for (const [key, entry] of [...this.entries]) {
      if ([...entry.links.values()].some((t) => t === target)) this.entries.delete(key);
    }
  }
}

const relations = new Map<RelationSchema, RelationData>();

function relationData(schema: RelationSchema): RelationData {
  let data = relations.get(schema);
  if (data === undefined) relations.set(schema, (data = new RelationData(schema)));
  return data;
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
  proxy!: Instance;

  constructor(readonly schema: ObjectSchema, readonly schemaName: string) {}

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

/** Writes the entries linking `target`, adjacency by adjacency. */
function writeAdjacencies(visitor: ObjectVisitor, target: Visitable, schema: ObjectSchema): void {
  for (const [adjacencyName, adjacency] of schema.adjacencies) {
    for (const entry of relationData(adjacency.relation as RelationSchema).linking(adjacency.me, target)) {
      visitor.adjacency(adjacencyName, (a) => a.add((e) => writeEntry(e, entry, adjacency)));
    }
  }
}

function makeInstance(schema: ObjectSchema, schemaName: string): Instance {
  const target = new ObjectTarget(schema, schemaName);
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
      return INSTANCE_METHODS.has(prop) || t.values.has(prop) || (PROBES.has(prop) && Reflect.has(t, prop));
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

/** A property of an instance or record, as an attribute. */
function read(t: { values: Map<string, unknown>; schema: RecordSchema }, prop: string, receiver: unknown): unknown {
  if (t.values.has(prop)) return t.values.get(prop);
  if (t.schema.properties.has(prop)) throw new AttributeError(`property ${repr(prop)} is not set`);
  if (PROBES.has(prop)) return Reflect.get(t, prop, receiver);
  throw new AttributeError(prop);
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

/** Writes a native, a value object, a union value or an intersection value into a `Visitors.OfAny`. */
function writeValue(visitor: OfAny, value: unknown): void {
  if (isRecord(value)) writeRecord(visitor, (recordTargets.get(value) as RecordTarget).schema, (r) => value.accept(r));
  else visitor.as_native((n) => n.set(value as Native));
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
 * and has an identity of its own; its properties are read-only attributes, and reading one that is not set throws
 * AttributeError. Built but not yet placed in an owner, it holds its entries in `pending` until its owner is created
 * or updated. */
class RecordTarget {
  readonly id = ++nextIdentity;
  holder: Visitable | null = null;
  proxy!: ValueObject;

  constructor(readonly schema: RecordSchema, readonly values: Map<string, unknown>,
    public pending: Map<string, _EntryBuilder[]> = new Map(), readonly source: ValueObject | null = null,
    readonly copyOf: Visitable | null = null) {}

  identity(): number {
    return this.id;
  }

  /** The registered name of the value object's schema, or '' when it is not registered. */
  schema_name(): string {
    for (const [name, registered] of registry) if (registered === this.schema) return name;
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

function stageValues(record: ValueObject, old: ValueObject | null, mapping: Mapping): void {
  const held = old === null ? new Map<string, unknown>() : stateOf(old).values;
  const values = stateOf(record).values;
  for (const [name, value] of [...values]) values.set(name, stage(held.get(name), value, mapping));
}

/** A copy of a placed value object, with copies of the entries linking it and the value objects it holds. */
function copy(record: ValueObject): ValueObject {
  const builder = makeRecordBuilder(stateOf(record).schema);
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

/** Adds a value object's entries, linked to the value objects that take the place of those in `mapping`. */
function addPending(record: ValueObject, mapping: Mapping): void {
  const state = stateOf(record);
  for (const [name, builders] of state.pending) {
    const adjacency = (state.schema as ObjectSchema).adjacencies.get(name) as AdjacencySchema;
    const relation = relationData(adjacency.relation as RelationSchema);
    for (const builder of builders) {
      const links = entryOf(builder).linkValues;
      for (const [link, target] of [...links]) if (mapping.has(target)) links.set(link, mapping.get(target) as LinkValue);
      relation.add(builder.build(record));
    }
  }
  state.pending = new Map();
}

/** Writes an edit of a placed value object into it, so that it keeps its identity. */
function merge(old: ValueObject, edit: ValueObject, mapping: Mapping): void {
  const target = stateOf(old);
  const values = new Map<string, unknown>();
  for (const [name, value] of stateOf(edit).values) values.set(name, finish(old, target.values.get(name), value, mapping));
  for (const [name, value] of target.values) if (values.get(name) !== value) remove(value);
  target.values.clear();
  for (const [name, value] of values) target.values.set(name, value);
  if (target.schema instanceof Schemas.OfObject.Data) {
    for (const adjacency of target.schema.adjacencies.values()) {
      relationData(adjacency.relation as RelationSchema).discard_linking(adjacency.me, old);
    }
  }
  target.pending = stateOf(edit).pending;
  addPending(old, mapping);
}

/** The values `owner` holds after an update from `old` to `values`: every value object is staged before any is
 * placed, so that the entries among them link the right ones; value objects no longer held are removed. */
function settle(owner: Visitable, old: Map<string, unknown>, values: Map<string, unknown>, mapping: Mapping): Map<string, unknown> {
  const staged = new Map([...values].map(([name, value]) => [name, stage(old.get(name), value, mapping)] as const));
  const placed = new Map([...staged].map(([name, value]) => [name, finish(owner, old.get(name), value, mapping)] as const));
  for (const [name, value] of old) if (placed.get(name) !== value) remove(value);
  return placed;
}

/** Removes a value object no longer held: the value objects it holds, and every entry linking it. */
function remove(value: unknown): void {
  if (!isRecord(value)) return;
  for (const held of stateOf(value).values.values()) remove(held);
  for (const relation of relations.values()) relation.discard_target(value);
}

function isInstance(value: unknown): value is Instance {
  return typeof value === "object" && value !== null && instanceTargets.has(value);
}

function writeEntry(visitor: OfEntry, entry: Entry, adjacency: AdjacencySchema): void {
  const relation = adjacency.relation as RelationSchema;
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

/** `Visitors.OfNative` over one key of a value map. */
export class _NativeSlot implements OfNative {
  constructor(private readonly values: Map<string, unknown>, private readonly slotName: string) {}

  has(): boolean {
    return this.values.has(this.slotName);
  }

  get(): Native {
    if (!this.values.has(this.slotName)) throw new AttributeError(`property ${repr(this.slotName)} is not set`);
    return this.values.get(this.slotName) as Native;
  }

  set(value: Native): _NativeSlot {
    this.values.set(this.slotName, value);
    return this;
  }

  clear(): _NativeSlot {
    this.values.delete(this.slotName);
    return this;
  }
}

/** `Visitors.OfAny` over one key of a value map, holding a value of `schema` (an entry property's schema is not
 * given: entry properties are native). */
export class _AnySlot implements OfAny {
  constructor(private readonly values: Map<string, unknown>, private readonly slotName: string,
    private readonly schema: unknown = null) {}

  as_native(callback: Callback<OfNative>): _AnySlot {
    callback(new _NativeSlot(this.values, this.slotName));
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
    const builder = makeRecordBuilder(this.schema, isRecord(current) ? current : undefined);
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
    private readonly schema: unknown = null) {}

  name(): string {
    return this.slotName;
  }

  has(): boolean {
    return this.values.has(this.slotName);
  }

  value(callback: Callback<OfAny>): _PropertySlot {
    callback(new _AnySlot(this.values, this.slotName, this.schema));
    return this;
  }

  clear(): _PropertySlot {
    this.values.delete(this.slotName);
    return this;
  }
}

/** DSL setter for a property of `schema`: `.name(value)`, or `.name(Spec)` where the Spec receives the value's builder:
 * a `Visitors.OfNative` (`v.set(...)`), or the builder of a value object, a union value or an intersection value,
 * which starts from the value already set. A value object given as the value replaces the one set. */
function setter<V extends PropertyHolder>(visitor: V, self: unknown, name: string, schema: unknown = null) {
  return (spec: unknown): unknown => {
    if (isRecord(spec)) visitor.property(name, (p) => p.clear().value((a) => apply(a, name, schema, spec)));
    else visitor.property(name, (p) => p.value((a) => apply(a, name, schema, spec)));
    return self;
  };
}

/** Writes `spec` (a value, or a callable taking the value's builder) as a value of `schema`. */
function apply(visitor: OfAny, name: string, schema: unknown, spec: unknown): void {
  if (schema instanceof Schemas.OfObject.Data || schema instanceof Schemas.OfUnion.Data
    || schema instanceof Schemas.OfIntersection.Data) {
    if (typeof spec === "function") writeRecord(visitor, schema, spec as Callback<ObjectVisitor>);
    else if (isRecord(spec)) writeRecord(visitor, schema, (r) => spec.accept(r));
    else throw new TypeError(`property ${repr(name)} takes ${withArticle(noun(schema))} or a Spec, got ${typeName(spec)}`);
  } else {
    visitor.as_native(typeof spec === "function" ? (spec as Callback<OfNative>) : (n) => n.set(spec as Native));
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

  constructor(readonly schema: RecordSchema, source?: ValueObject) {
    this.source = source ?? null;
    this.values = new Map(source === undefined ? [] : stateOf(source).values);
    if (source !== undefined && schema instanceof Schemas.OfObject.Data) loadEntries(this.entries, schema, source);
    this.member = schema instanceof Schemas.OfUnion.Data ? "branch of the union"
      : schema instanceof Schemas.OfIntersection.Data ? "part of the intersection" : "property of the value object";
  }

  properties(callback: Callback<OfProperty>): ObjectVisitor {
    for (const [name, schema] of this.schema.properties) {
      if (this.values.has(name)) callback(new _PropertySlot(this.values, name, schema));
    }
    return this.proxy;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): ObjectVisitor {
    const schema = this.schema.properties.get(name);
    if (schema === undefined) throw new AttributeError(`${repr(name)} is not a ${this.member}`);
    if (this.schema instanceof Schemas.OfUnion.Data) {
      for (const other of [...this.values.keys()]) if (other !== name) this.values.delete(other);
    }
    callback(new _PropertySlot(this.values, name, schema));
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

  adjacencies(callback: Callback<OfAdjacency>): ObjectVisitor {
    for (const name of this.adjacencyNames()) callback(new _AdjacencySlot(this, name));
    return this.proxy;
  }

  adjacency(name: string, callback: Callback<OfAdjacency>): ObjectVisitor {
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
function adder(builder: { adjacency(name: string, callback: Callback<OfAdjacency>): unknown }, name: string) {
  return (spec: unknown): unknown => {
    if (typeof spec !== "function") throw new TypeError(`${repr(name)} takes an entry Spec, e.g. x => x.<link>(...)`);
    return builder.adjacency(name, (a) => a.add(spec as Callback<OfEntry>));
  };
}

/** Loads the entries linking `source` into a builder, as entry builders, so that an update rewrites them. */
function loadEntries(entries: Map<string, _EntryBuilder[]>, schema: ObjectSchema, source: Visitable): void {
  for (const [name, adjacency] of schema.adjacencies) {
    for (const entry of relationData(adjacency.relation as RelationSchema).linking(adjacency.me, source)) {
      const builder = makeEntryBuilder(adjacency.relation as RelationSchema, adjacency.me);
      const state = entryOf(builder);
      for (const [link, target] of entry.links) if (link !== adjacency.me) state.linkValues.set(link, target as LinkValue);
      for (const [key, value] of entry.properties) state.values.set(key, value);
      entries.set(name, [...(entries.get(name) ?? []), builder]);
    }
  }
  for (const [name, pending] of isRecord(source) ? stateOf(source).pending : []) {
    entries.set(name, [...(entries.get(name) ?? []), ...pending]);
  }
}

function makeRecordBuilder(schema: RecordSchema, source?: ValueObject): ObjectVisitor {
  const target = new RecordBuilderTarget(schema, source);
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (RECORD_BUILDER_METHODS.has(prop)) return (t[prop as "has"] as (...a: unknown[]) => unknown).bind(t);
      const schema = t.schema.properties.get(prop);
      if (schema !== undefined) return setter(t, t.proxy, prop, schema);
      if (t.adjacencyNames().includes(prop)) return adder(t, prop);
      if (PROBES.has(prop)) return Reflect.get(t, prop, receiver);
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
  constructor(private readonly links: Map<string, LinkValue>, private readonly linkName: string) {}

  name(): string {
    return this.linkName;
  }

  target(callback: Callback<Visitable>): _LinkSlot {
    callback(this.links.get(this.linkName) as Visitable);
    return this;
  }

  set(target: Visitable): _LinkSlot {
    if (!isInstance(target) && !(isRecord(target) && stateOf(target).schema instanceof Schemas.OfObject.Data)) {
      throw new TypeError("proxies can only link proxy instances and their value objects");
    }
    this.links.set(this.linkName, target);
    return this;
  }
}

const ENTRY_METHODS = new Set(["links", "link", "properties", "has", "property", "clear", "build"]);

/** `Visitors.OfEntry` for one entry being added through an adjacency. The object's own link (`me`) is filled when
 * the object builder is finalized. DSL: `.<link>(object or Spec)` and `.<property>(value or Spec)`. */
export class _EntryBuilder implements OfEntry {
  readonly linkValues = new Map<string, LinkValue>();
  readonly values = new Map<string, Native>();
  proxy!: _EntryBuilder;

  constructor(private readonly relation: RelationSchema, private readonly me: string) {}

  private checkLink(name: string): void {
    if (name === this.me || !this.relation.links.includes(name)) {
      throw new AttributeError(`${repr(name)} is not a link this entry can set`);
    }
  }

  links(callback: Callback<OfLink>): _EntryBuilder {
    for (const name of this.relation.links) if (name !== this.me) callback(new _LinkSlot(this.linkValues, name));
    return this.proxy;
  }

  link(name: string, callback: Callback<OfLink>): _EntryBuilder {
    this.checkLink(name);
    callback(new _LinkSlot(this.linkValues, name));
    return this.proxy;
  }

  properties(callback: Callback<OfProperty>): _EntryBuilder {
    for (const name of [...this.values.keys()]) callback(new _PropertySlot(this.values, name, this.relation.properties.get(name)));
    return this.proxy;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): _EntryBuilder {
    if (!this.relation.properties.has(name)) throw new AttributeError(`${repr(name)} is not a property of this relation`);
    callback(new _PropertySlot(this.values, name, this.relation.properties.get(name)));
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
          const schemaName = schemaFilling(this.relation, name);
          const builder = makeObjectBuilder(objectSchema(schemaName), schemaName);
          spec(builder);
          this.linkValues.set(name, builderTargets.get(builder) as ObjectBuilderTarget);
        } else {
          this.link(name, (k) => k.set(spec as Visitable));
        }
        return this.proxy;
      };
    }
    if (this.relation.properties.has(name)) return setter(this, this.proxy, name, this.relation.properties.get(name));
    return undefined;
  }

  build(target: Visitable): Entry {
    const links = new Map<string, Visitable>([[this.me, target]]);
    for (const name of this.relation.links) {
      if (name === this.me) continue;
      const value = this.linkValues.get(name);
      if (value === undefined) throw new ValueError(`link ${repr(name)} is not set`);
      links.set(name, value instanceof ObjectBuilderTarget ? value.create() : value);
    }
    return new Entry(links, settle(target, new Map(), this.values, new Map()) as Map<string, Native>); // its value objects belong to `target`
  }
}

/** The entry builder behind each entry builder's proxy, for the state that its DSL would read as names. */
const entryTargets = new WeakMap<object, _EntryBuilder>();

function entryOf(builder: _EntryBuilder): _EntryBuilder {
  return entryTargets.get(builder) as _EntryBuilder;
}

function makeEntryBuilder(relation: RelationSchema, me: string): _EntryBuilder {
  const target = new _EntryBuilder(relation, me);
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (ENTRY_METHODS.has(prop)) return (t[prop as "links"] as (...a: unknown[]) => unknown).bind(t);
      const dsl = t.dsl(prop);
      if (dsl !== undefined) return dsl;
      if (PROBES.has(prop)) return Reflect.get(t, prop, receiver);
      throw new AttributeError(prop);
    },
  });
  target.proxy = proxy;
  entryTargets.set(proxy, target);
  return proxy;
}

/** `Visitors.OfAdjacency` over one adjacency of an object builder. */
export class _AdjacencySlot implements OfAdjacency {
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

  entries(callback: Callback<OfEntry>): _AdjacencySlot {
    for (const entry of [...(this.builder.entries.get(this.adjacencyName) ?? [])]) callback(entry);
    return this;
  }

  add(callback: Callback<OfEntry>): _AdjacencySlot {
    const entry = makeEntryBuilder(this.schema.relation as RelationSchema, this.schema.me);
    callback(entry);
    const list = this.builder.entries.get(this.adjacencyName) ?? [];
    list.push(entry);
    this.builder.entries.set(this.adjacencyName, list);
    return this;
  }

  remove(entry: OfEntry): _AdjacencySlot {
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

  constructor(readonly schema: ObjectSchema, readonly schemaName: string, private readonly source?: Instance) {}

  properties(callback: Callback<OfProperty>): DynamicBuilder {
    for (const name of [...this.values.keys()]) callback(new _PropertySlot(this.values, name, this.schema.properties.get(name)));
    return this.proxy;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): DynamicBuilder {
    if (!this.schema.properties.has(name)) throw new AttributeError(`${repr(name)} is not a property of ${repr(this.schemaName)}`);
    callback(new _PropertySlot(this.values, name, this.schema.properties.get(name)));
    return this.proxy;
  }

  clear(name: string): DynamicBuilder {
    this.values.delete(name);
    return this.proxy;
  }

  adjacencies(callback: Callback<OfAdjacency>): DynamicBuilder {
    for (const name of this.schema.adjacencies.keys()) callback(new _AdjacencySlot(this, name));
    return this.proxy;
  }

  adjacency(name: string, callback: Callback<OfAdjacency>): DynamicBuilder {
    if (!this.schema.adjacencies.has(name)) throw new AttributeError(`${repr(name)} is not an adjacency of ${repr(this.schemaName)}`);
    callback(new _AdjacencySlot(this, name));
    return this.proxy;
  }

  identify(_value: Visitable): DynamicBuilder {
    return this.proxy;
  }

  dsl(name: string): ((spec: unknown) => unknown) | undefined {
    if (name.startsWith("_")) throw new AttributeError(name);
    if (this.schema.properties.has(name)) return setter(this, this.proxy, name, this.schema.properties.get(name));
    if (this.schema.adjacencies.has(name)) return adder(this, name);
    return undefined;
  }

  create(...args: unknown[]): Instance {
    noArguments("create", args);
    if (this.source !== undefined) {
      throw new ValueError("create() is only valid without a source instance; use clone() or update()");
    }
    return this.write(makeInstance(this.schema, this.schemaName));
  }

  clone(...args: unknown[]): Instance {
    noArguments("clone", args);
    if (this.source === undefined) throw new ValueError("clone() is only valid with a source instance");
    return this.write(makeInstance(this.schema, this.schemaName));
  }

  update(...args: unknown[]): Instance {
    noArguments("update", args);
    if (this.source === undefined) throw new ValueError("update() is only valid with a source instance");
    for (const adjacency of this.schema.adjacencies.values()) {
      relationData(adjacency.relation as RelationSchema).discard_linking(adjacency.me, this.source);
    }
    return this.write(this.source);
  }

  private write(target: Instance): Instance {
    const state = instanceTargets.get(target) as ObjectTarget;
    const mapping: Mapping = new Map();
    if (this.source !== undefined && target !== this.source) mapping.set(this.source, target); // a clone: its value objects link it
    const values = settle(target, new Map(state.values), this.values, mapping);
    mapping.delete(this.source); // its own entries keep their links (a self-loop links the source)
    state.values.clear();
    for (const [name, value] of values) state.values.set(name, value);
    for (const [name, entries] of this.entries) {
      const relation = relationData((this.schema.adjacencies.get(name) as AdjacencySchema).relation as RelationSchema);
      for (const entry of entries) {
        const links = entryOf(entry).linkValues;
        for (const [link, linked] of [...links]) if (mapping.has(linked)) links.set(link, mapping.get(linked) as LinkValue);
        relation.add(entry.build(target));
      }
    }
    return target;
  }
}

function noArguments(method: string, args: unknown[]): void {
  if (args.length > 0) throw new TypeError(`${method}() takes no arguments (${args.length} given)`);
}

function makeObjectBuilder(schema: ObjectSchema, schemaName: string, instance?: Instance): DynamicBuilder {
  if (!schema.ref) {
    throw new TypeError(`${repr(schemaName)} is a value object schema; a value object is built through its owner`);
  }
  if (instance !== undefined && !isInstance(instance)) throw new TypeError("a builder's source must be a proxy instance");
  const target = new ObjectBuilderTarget(schema, schemaName, instance);
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (BUILDER_METHODS.has(prop)) return (t[prop as "has"] as (...a: unknown[]) => unknown).bind(t);
      const dsl = t.dsl(prop);
      if (dsl !== undefined) return dsl;
      if (PROBES.has(prop)) return Reflect.get(t, prop, receiver);
      throw new AttributeError(`${repr(prop)} is not a property or adjacency of ${repr(schemaName)}`);
    },
  }) as unknown as DynamicBuilder;
  target.proxy = proxy;
  builderTargets.set(proxy, target);
  if (instance !== undefined) {
    if (instance.schema_name() !== schemaName) {
      throw new TypeError(`instance is a ${repr(instance.schema_name())}, not a ${repr(schemaName)}`);
    }
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
  /** A builder for `schema` registered as `schemaName`, as `Builders[schemaName](instance)` returns. */
  export function Builder(schema: ObjectSchema, schemaName: string, instance?: Instance): DynamicBuilder {
    return makeObjectBuilder(schema, schemaName, instance);
  }
}

export namespace OfRelation {
  export const Data = RelationData;
  export type Data = RelationData;
}

/** Internal classes, exposed for protocol conformance tests. */
export const _internals = { ObjectTarget, ObjectBuilderTarget, RecordBuilderTarget, _EntryBuilder, _AdjacencySlot, _LinkSlot,
  _PropertySlot, _AnySlot, _NativeSlot };
