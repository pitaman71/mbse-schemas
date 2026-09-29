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
 */

import { inspect } from "node:util";

import { AttributeError, LookupError, NotImplementedError, ValueError } from "./Errors.js";
import { repr } from "./Repr.js";
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
  /** `(instance?: Instance) => DynamicBuilder` for each registered object schema; dynamic by design. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [name: string]: any;
} = new Proxy({ schema, name_of } as Record<string | symbol, unknown>, {
  get(target, prop, receiver) {
    if (prop === "schema" || prop === "name_of" || typeof prop === "symbol") return Reflect.get(target, prop, receiver);
    if (!registry.has(prop) && PROBES.has(prop)) return Reflect.get(target, prop, receiver);
    const found = objectSchema(prop);
    return (instance?: Instance) => makeObjectBuilder(found, prop, instance);
  },
}) as never;

// --- Relation entries ---

const floatView = new DataView(new ArrayBuffer(8));

/** Equality key per Framework.md: distinct native types never compare equal; floats compare by bit pattern. */
export function nativeKey(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "float:nan";
    floatView.setFloat64(0, value);
    return `float:${floatView.getBigUint64(0).toString(16)}`;
  }
  if (typeof value === "bigint") return `int:${value}`;
  if (typeof value === "string") return `str:${value}`;
  if (typeof value === "boolean") return `bool:${value}`;
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString("hex")}`;
  return `${typeof value}:${String(value)}`;
}

class Entry {
  constructor(readonly links: Map<string, Instance>, readonly properties: Map<string, Native>) {}

  key(): string {
    const links = [...this.links].map(([name, target]) => [name, identityOf(target)] as const).sort(byName);
    const props = [...this.properties].map(([name, value]) => [name, nativeKey(value)] as const).sort(byName);
    return JSON.stringify([links, props]);
  }
}

function byName(a: readonly [string, unknown], b: readonly [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/** All entries of one relation. */
class RelationData {
  private readonly entries = new Map<string, Entry>();

  constructor(readonly schema: RelationSchema) {}

  add(entry: Entry): void {
    const key = entry.key();
    if (!this.entries.has(key)) this.entries.set(key, entry);
  }

  linking(link: string, target: Instance): Entry[] {
    return [...this.entries.values()].filter((entry) => entry.links.get(link) === target);
  }

  discard_linking(link: string, target: Instance): void {
    for (const [key, entry] of [...this.entries]) if (entry.links.get(link) === target) this.entries.delete(key);
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
const instanceTargets = new WeakMap<object, ObjectTarget>();

function identityOf(instance: Instance): number {
  return (instanceTargets.get(instance) as ObjectTarget).id;
}

/** The state behind a proxy instance. */
class ObjectTarget {
  readonly id = ++nextIdentity;
  readonly values = new Map<string, Native>();
  proxy!: Instance;

  constructor(readonly schema: ObjectSchema, readonly schemaName: string) {}

  identity(): number {
    return this.id;
  }

  schema_name(): string {
    return this.schemaName;
  }

  /** Writes properties in the schema's declared order, then entries adjacency by adjacency. */
  accept(visitor: ObjectVisitor): void {
    for (const name of this.schema.properties.keys()) {
      if (this.values.has(name)) {
        const value = this.values.get(name) as Native;
        visitor.property(name, (p) => p.value((a) => a.as_native((n) => n.set(value))));
      }
    }
    for (const [adjacencyName, adjacency] of this.schema.adjacencies) {
      for (const entry of relationData(adjacency.relation as RelationSchema).linking(adjacency.me, this.proxy)) {
        visitor.adjacency(adjacencyName, (a) => a.add((e) => writeEntry(e, entry, adjacency)));
      }
    }
  }

  [inspect.custom](): string {
    const values = [...this.values].map(([k, v]) => `${k}: ${repr(v)}`).join(", ");
    return `<${this.schemaName} proxy #${this.id}${values ? " " + values : ""}>`;
  }
}

const INSTANCE_METHODS = new Set(["identity", "schema_name", "accept"]);

function makeInstance(schema: ObjectSchema, schemaName: string): Instance {
  const target = new ObjectTarget(schema, schemaName);
  const readOnly = (): never => {
    throw new AttributeError("proxy properties are read-only; use a builder");
  };
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (INSTANCE_METHODS.has(prop)) return (t[prop as "identity"] as () => unknown).bind(t);
      if (t.values.has(prop)) return t.values.get(prop);
      if (t.schema.properties.has(prop)) throw new AttributeError(`property ${repr(prop)} is not set`);
      if (PROBES.has(prop)) return Reflect.get(t, prop, receiver);
      throw new AttributeError(prop);
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
      const value = entry.properties.get(name) as Native;
      visitor.property(name, (p) => p.value((a) => a.as_native((n) => n.set(value))));
    }
  }
}

// --- Builders ---

/** `Visitors.OfNative` over one key of a value map. */
export class _NativeSlot implements OfNative {
  constructor(private readonly values: Map<string, Native>, private readonly slotName: string) {}

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

/** `Visitors.OfAny` over one key of a value map. Only native values are supported so far. */
export class _AnySlot implements OfAny {
  constructor(private readonly values: Map<string, Native>, private readonly slotName: string) {}

  as_native(callback: Callback<OfNative>): _AnySlot {
    callback(new _NativeSlot(this.values, this.slotName));
    return this;
  }

  as_object(_callback: Callback<ObjectVisitor>): _AnySlot {
    throw new NotImplementedError("object-valued properties are not supported by proxies yet");
  }

  as_union(_callback: Callback<OfUnion>): _AnySlot {
    throw new NotImplementedError("union-valued properties are not supported by proxies yet");
  }

  as_intersection(_callback: Callback<OfIntersection>): _AnySlot {
    throw new NotImplementedError("intersection-valued properties are not supported by proxies yet");
  }
}

/** `Visitors.OfProperty` over one key of a value map. */
export class _PropertySlot implements OfProperty {
  constructor(private readonly values: Map<string, Native>, private readonly slotName: string) {}

  name(): string {
    return this.slotName;
  }

  has(): boolean {
    return this.values.has(this.slotName);
  }

  value(callback: Callback<OfAny>): _PropertySlot {
    callback(new _AnySlot(this.values, this.slotName));
    return this;
  }

  clear(): _PropertySlot {
    this.values.delete(this.slotName);
    return this;
  }
}

/** DSL setter: `.name(value)` or `.name(v => v.set(value))`, where `v` is a `Visitors.OfNative`. */
function setter<V extends { property(name: string, callback: Callback<OfProperty>): unknown }>(visitor: V, self: unknown, name: string) {
  return (spec: unknown): unknown => {
    const onNative = typeof spec === "function" ? (spec as Callback<OfNative>) : (n: OfNative) => n.set(spec as Native);
    visitor.property(name, (p) => p.value((a) => a.as_native(onNative)));
    return self;
  };
}

type LinkValue = Instance | ObjectBuilderTarget;

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
    if (!isInstance(target)) throw new TypeError("proxies can only link proxy instances");
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
    for (const name of [...this.values.keys()]) callback(new _PropertySlot(this.values, name));
    return this.proxy;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): _EntryBuilder {
    if (!this.relation.properties.has(name)) throw new AttributeError(`${repr(name)} is not a property of this relation`);
    callback(new _PropertySlot(this.values, name));
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
    if (this.relation.properties.has(name)) return setter(this, this.proxy, name);
    return undefined;
  }

  build(target: Instance): Entry {
    const links = new Map<string, Instance>([[this.me, target]]);
    for (const name of this.relation.links) {
      if (name === this.me) continue;
      const value = this.linkValues.get(name);
      if (value === undefined) throw new ValueError(`link ${repr(name)} is not set`);
      links.set(name, value instanceof ObjectBuilderTarget ? value.create() : value);
    }
    return new Entry(links, new Map(this.values));
  }
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
  return proxy;
}

/** `Visitors.OfAdjacency` over one adjacency of an object builder. */
export class _AdjacencySlot implements OfAdjacency {
  private readonly schema: AdjacencySchema;

  constructor(private readonly builder: ObjectBuilderTarget, private readonly adjacencyName: string) {
    this.schema = builder.schema.adjacencies.get(adjacencyName) as AdjacencySchema;
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

const BUILDER_METHODS = new Set(["properties", "has", "property", "clear", "adjacencies", "adjacency", "create", "clone", "update"]);
const builderTargets = new WeakMap<object, ObjectBuilderTarget>();

/** `Visitors.OfObject` for building a proxy instance. DSL: `.<property>(value or Spec)` and `.<adjacency>(entry
 * Spec)`. Finalized by `create()`, `clone()` or `update()`; none validate. */
export class ObjectBuilderTarget implements ObjectVisitor {
  readonly values = new Map<string, Native>();
  readonly entries = new Map<string, _EntryBuilder[]>();
  proxy!: DynamicBuilder;

  constructor(readonly schema: ObjectSchema, readonly schemaName: string, private readonly source?: Instance) {}

  properties(callback: Callback<OfProperty>): DynamicBuilder {
    for (const name of [...this.values.keys()]) callback(new _PropertySlot(this.values, name));
    return this.proxy;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): DynamicBuilder {
    if (!this.schema.properties.has(name)) throw new AttributeError(`${repr(name)} is not a property of ${repr(this.schemaName)}`);
    callback(new _PropertySlot(this.values, name));
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

  dsl(name: string): ((spec: unknown) => unknown) | undefined {
    if (name.startsWith("_")) throw new AttributeError(name);
    if (this.schema.properties.has(name)) return setter(this, this.proxy, name);
    if (this.schema.adjacencies.has(name)) {
      return (spec: unknown) => {
        if (typeof spec !== "function") throw new TypeError(`${repr(name)} takes an entry Spec, e.g. x => x.<link>(...)`);
        return this.adjacency(name, (a) => a.add(spec as Callback<OfEntry>));
      };
    }
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
    state.values.clear();
    for (const [name, value] of this.values) state.values.set(name, value);
    for (const [name, entries] of this.entries) {
      const relation = relationData((this.schema.adjacencies.get(name) as AdjacencySchema).relation as RelationSchema);
      for (const entry of entries) relation.add(entry.build(target));
    }
    return target;
  }
}

function noArguments(method: string, args: unknown[]): void {
  if (args.length > 0) throw new TypeError(`${method}() takes no arguments (${args.length} given)`);
}

function makeObjectBuilder(schema: ObjectSchema, schemaName: string, instance?: Instance): DynamicBuilder {
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
    instance.accept(proxy);
  }
  return proxy;
}

export namespace OfObject {
  export type Data = Instance;
  export type Builder = DynamicBuilder;
  export function isData(value: unknown): value is Instance {
    return isInstance(value);
  }
  export function Builder(schema: ObjectSchema, schemaName: string, instance?: Instance): DynamicBuilder {
    return makeObjectBuilder(schema, schemaName, instance);
  }
}

export namespace OfRelation {
  export const Data = RelationData;
  export type Data = RelationData;
}

/** Internal classes, exposed for protocol conformance tests. */
export const _internals = { ObjectTarget, ObjectBuilderTarget, _EntryBuilder, _AdjacencySlot, _LinkSlot, _PropertySlot, _AnySlot, _NativeSlot };
