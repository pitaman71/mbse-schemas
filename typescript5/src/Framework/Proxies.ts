/**
 * Proxies: the dynamic implementation.
 *
 * Programs using proxies skip code generation. A store, `new OfStore()`, holds schemas and the proxies built with them
 * (see `Stores`): `store.register(name, schema)` makes a schema available, and `store.<Name>(optional instance)` (or
 * `store.builder(name, instance)`) returns a builder for it. Instances (`Proxies.OfObject.Data`) are `Visitable`, not
 * visitors: they expose their properties as read-only attributes and write themselves into a visitor on `accept`.
 * Builders (`Proxies.OfObject.Builder`) implement `Visitors.OfObject`, like every builder.
 *
 * Attribute lookup follows Python's: the builder's or instance's own methods first, then schema names. Reading an
 * unknown name throws `AttributeError`, except JavaScript's own protocol probes (`then`, `toJSON`, `constructor`,
 * symbols, ...), which behave as on any object. Identities are never reused.
 *
 * Each store keeps one table per relation, and the extent of each schema: the reference objects built through it.
 * Adding an entry equal to an existing one is elided. An object of one store cannot be linked to, or be a builder's
 * source in, another.
 *
 * A property whose schema is an `OfObject` holds a value object: a read-only record with no identity
 * (`Proxies.OfObject.Record`), read with attributes like an instance and set with a Spec, e.g.
 * `.reach((r) => r.number("+44"))`. Union and intersection values are records too, whose properties are the union's
 * branches or the intersection's parts, by name: `.reach((u) => u.phone((p) => p.number("+44")))` sets the branch
 * `phone`, read back as `card.reach.phone.number`, and setting one branch clears any other. An intersection value holds
 * each of its parts, set and read the same way (`card.meta.stamp.updated`).
 *
 * A property whose schema is an `OfIndexed` holds a list, read as a frozen array and set with an array of items, each a
 * value, a value object or an item's Spec (`.tags(["a", "b"])`), or with a Spec that receives the list's builder, a
 * `Visitors.OfIndexed` starting from the items set. The value objects in a list belong to the list's owner. A keyed list
 * is read as a read-only mapping (`Proxies.OfIndexed.Map`) and set with a Map or `[key, value]` pairs.
 */


import { toHex } from "./Bytes.js";
import { AttributeError, item, LookupError, NotImplementedError, ValueError } from "./Errors.js";
import { repr, sortedStrings, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import * as Stores from "./Stores.js";
import type { Callback, Native, OfAdjacency, OfAny, OfEntry, OfIndexed as IndexedVisitor, OfIntersection, OfItem, OfLink, OfNative,
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

const STORE_MEMBERS = new Set(["register", "schema", "registered", "name_of", "names", "builder", "member", "extent"]);

/** A store of proxies: schemas by name, the proxies built with them, and their relation entries.
 * `store.<Name>(optional instance)` is `store.builder(name, instance)`; use `builder` for names that are not
 * identifiers, or that a method's name shadows. */
export class OfStore extends Stores.Catalog implements Stores.Store {
  readonly _relations = new Map<RelationSchema, RelationData>();
  readonly _extents = new Map<string, Instance[]>();
  /** `(instance?: Instance) => DynamicBuilder` for each registered object schema; dynamic by design. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [name: string]: any;

  constructor() {
    super();
    for (const [name, schema] of Stores.META) this.register(name, schema);
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

  /** A builder for the object schema `name`; typed loosely, as the store's DSL is. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder(name: string, instance?: unknown): any {
    return makeObjectBuilder(this, this.schema(name), name, instance as Instance | undefined);
  }

  /** The value an instance or value object holds in its property `name`. */
  member(instance: unknown, name: string): unknown {
    return member(instance, name);
  }

  extent(name: string): readonly Instance[] {
    this.schema(name);
    return [...(this._extents.get(name) ?? [])];
  }

  _relationData(schema: RelationSchema): RelationData {
    let data = this._relations.get(schema);
    if (data === undefined) this._relations.set(schema, (data = new RelationData(schema)));
    return data;
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

/** Equality key per EQUALITY.md: distinct native types never compare equal; floats compare by bit pattern; a value
 * object by its schema and properties, whatever its identity. */
export function nativeKey(value: unknown): string {
  if (isRecord(value)) {
    const state = stateOf(value);
    const values = sortedStrings(state.values.keys()).map((name) => [name, nativeKey(state.values.get(name))]);
    return `object:${schemaId(state.schema)}:${JSON.stringify(values)}`;
  }
  if (value instanceof IndexedMap) {
    return `map:${JSON.stringify(sortedStrings([...value.entries()].map(([k, v]) => JSON.stringify([nativeKey(k), nativeKey(v)]))))}`;
  }
  if (Array.isArray(value)) return `list:${JSON.stringify(value.map((item) => nativeKey(item)))}`;
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
  throw new TypeError(`an entry property must be a native value, a list or a value object, got ${typeName(value)}`);
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
  const store = storeOf(target);
  if (store === null) return;
  for (const [adjacencyName, adjacency] of schema.adjacencies) {
    for (const entry of store._relationData(adjacency.relation as RelationSchema).linking(adjacency.me, target)) {
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
      return INSTANCE_METHODS.has(prop) || t.values.has(prop) || (_probes.has(prop) && Reflect.has(t, prop));
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
  if (_probes.has(prop)) return Reflect.get(t, prop, receiver);
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

/** Writes a native, a value object, a union value, an intersection value or a list into a `Visitors.OfAny`. */
function writeValue(visitor: OfAny, value: unknown): void {
  if (isRecord(value)) writeRecord(visitor, (recordTargets.get(value) as RecordTarget).schema, (r) => value.accept(r));
  else if (value instanceof IndexedMap) visitor.as_indexed((items) => writePairs(items, value));
  else if (Array.isArray(value)) visitor.as_indexed((items) => writeItems(items, value));
  else visitor.as_native((n) => n.set(value as Native));
}

function writeItems(visitor: IndexedVisitor, items: readonly unknown[]): void {
  for (const value of items) visitor.append((a) => writeValue(a, value));
}

function writePairs(visitor: IndexedVisitor, items: IndexedMap): void {
  for (const [key, value] of items.entries()) visitor.put((a) => writeValue(a, key), (a) => writeValue(a, value));
}

/** A keyed list as proxies read it: a read-only mapping, in insertion order. A key is looked up by schema equality: a
 * native by its exact type, a list given as an array, a value object by its schema and properties. Iterating it gives
 * its `[key, value]` entries, as a `Map` does. */
export class IndexedMap {
  readonly #pairs: readonly (readonly [unknown, unknown])[];
  readonly #index: Map<string, number>;

  constructor(pairs: Iterable<readonly [unknown, unknown]>) {
    this.#pairs = Object.freeze([...pairs].map(([key, value]) => Object.freeze([key, value] as const)));
    this.#index = new Map(this.#pairs.map(([key], i) => [nativeKey(key), i]));
    Object.freeze(this);
  }

  get size(): number {
    return this.#pairs.length;
  }

  get(key: unknown): unknown {
    const index = this.#index.get(nativeKey(key));
    return index === undefined ? undefined : (this.#pairs[index] as readonly [unknown, unknown])[1];
  }

  has(key: unknown): boolean {
    return this.#index.has(nativeKey(key));
  }

  keys(): unknown[] {
    return this.#pairs.map(([key]) => key);
  }

  values(): unknown[] {
    return this.#pairs.map(([, value]) => value);
  }

  entries(): (readonly [unknown, unknown])[] {
    return [...this.#pairs];
  }

  [Symbol.iterator](): Iterator<readonly [unknown, unknown]> {
    return this.entries()[Symbol.iterator]();
  }

  /** The key and value of the item with a key equal to `key`, or nulls. */
  replaced(key: unknown): readonly [unknown, unknown] {
    const index = this.#index.get(nativeKey(key));
    return index === undefined ? [null, null] : this.#pairs[index] as readonly [unknown, unknown];
  }
}

/** A list as proxies hold it: a frozen array. */
function frozen(items: unknown[]): readonly unknown[] {
  return Object.freeze(items);
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

/** What a keyed list's item replaces in `old`: the key and value of the item with an equal key. */
function replaced(old: unknown, key: unknown): readonly [unknown, unknown] {
  return old instanceof IndexedMap ? old.replaced(key) : [null, null];
}

/** What a list's item replaces in the list `old`: the value object it is or edits, or the list at its position. */
function counterpart(old: unknown, index: number, value: unknown): unknown {
  const olds: readonly unknown[] = Array.isArray(old) ? old : [];
  if (Array.isArray(value)) return index < olds.length ? olds[index] : null;
  return olds.find((o) => o === value || (isRecord(value) && stateOf(value).source === o)) ?? null;
}

/** Prepares `value` to be placed where `old` was: a value object owned elsewhere is copied, and `mapping` records, for
 * each value object copied or edited, the one that takes its place, so that the entries among them link those. A
 * list's items are staged each in place of what it replaces. */
function stage(old: unknown, value: unknown, mapping: Mapping): unknown {
  if (Array.isArray(value) && value !== old) {
    return frozen(value.map((item, i) => stage(counterpart(old, i, item), item, mapping)));
  }
  if (value instanceof IndexedMap && value !== old) {
    return new IndexedMap(value.entries().map(([k, v]) => {
      const [oldKey, oldValue] = replaced(old, k);
      return [stage(oldKey, k, mapping), stage(oldValue, v, mapping)] as const;
    }));
  }
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
  const builder = makeRecordBuilder(stateOf(record).schema, undefined, storeOf(record));
  record.accept(builder);
  return (recordBuilderTargets.get(builder) as RecordBuilderTarget).build();
}

/** Places a staged value: an edit is merged into `old`, and a value object built for it is adopted by `owner`, as are
 * those in a list. */
function finish(owner: Visitable, old: unknown, value: unknown, mapping: Mapping): unknown {
  if (Array.isArray(value) && value !== old) {
    return frozen(value.map((item, i) => finish(owner, counterpart(old, i, item), item, mapping)));
  }
  if (value instanceof IndexedMap && value !== old) {
    return new IndexedMap(value.entries().map(([k, v]) => {
      const [oldKey, oldValue] = replaced(old, k);
      return [finish(owner, oldKey, k, mapping), finish(owner, oldValue, v, mapping)] as const;
    }));
  }
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
  const store = storeOf(record) as OfStore; // placed, so its owner's
  for (const [name, builders] of state.pending) {
    const adjacency = (state.schema as ObjectSchema).adjacencies.get(name) as AdjacencySchema;
    const relation = store._relationData(adjacency.relation as RelationSchema);
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
  drop([...target.values.values()], [...values.values()]);
  target.values.clear();
  for (const [name, value] of values) target.values.set(name, value);
  if (target.schema instanceof Schemas.OfObject.Data) {
    for (const adjacency of target.schema.adjacencies.values()) {
      (storeOf(old) as OfStore)._relationData(adjacency.relation as RelationSchema).discard_linking(adjacency.me, old);
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
  drop([...old.values()], [...placed.values()]);
  return placed;
}

/** The value objects that `values` hold directly, those in lists, keys included, too. */
function records(values: readonly unknown[]): ValueObject[] {
  const found: ValueObject[] = [];
  for (const value of values) {
    if (value instanceof IndexedMap) found.push(...records(value.entries().flat()));
    else if (Array.isArray(value)) found.push(...records(value));
    else if (isRecord(value)) found.push(value);
  }
  return found;
}

/** Removes the value objects held among the values `before` and no longer among those `after`. */
function drop(before: readonly unknown[], after: readonly unknown[]): void {
  const kept = new Set(records(after));
  for (const record of records(before)) if (!kept.has(record)) remove(record);
}

/** Removes a value object no longer held: the value objects it holds, and every entry linking it. */
function remove(value: ValueObject): void {
  for (const held of records([...stateOf(value).values.values()])) remove(held);
  for (const relation of (storeOf(value) as OfStore)._relations.values()) relation.discard_target(value); // placed, so its owner's
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
    private readonly schema: unknown = null, private readonly store: OfStore | null = null) {}

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

  /** Builds a list, starting from the items already set, if any. */
  as_indexed(callback: Callback<IndexedVisitor>): _AnySlot {
    if (!(this.schema instanceof Schemas.OfIndexed.Data)) throw new TypeError(`property ${repr(this.slotName)} does not hold a list`);
    const current = this.values.get(this.slotName);
    if (this.schema.positional) {
      const builder = new _ListBuilder(this.slotName, this.schema, Array.isArray(current) ? current : [], this.store);
      callback(builder);
      this.values.set(this.slotName, frozen(builder.held));
    } else {
      const keyed = new _MapBuilder(this.slotName, this.schema, current instanceof IndexedMap ? current.entries() : [], this.store);
      callback(keyed);
      this.values.set(this.slotName, new IndexedMap(keyed.held));
    }
    return this;
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

/** `Visitors.OfIndexed` building the list a property holds, starting from `items`. Each item is written through an
 * `_AnySlot`; an item written with no value is left out. */
export class _ListBuilder implements IndexedVisitor {
  readonly held: unknown[];

  constructor(readonly slotName: string, private readonly schema: Schemas.OfIndexed.Data, items: readonly unknown[],
    private readonly store: OfStore | null = null) {
    this.held = [...items];
  }

  items(callback: Callback<OfAny>): _ListBuilder {
    for (let index = 0, count = this.held.length; index < count; index++) this.item(index, callback);
    return this;
  }

  item(index: number, callback: Callback<OfAny>): _ListBuilder {
    const slot = new Map([[this.slotName, item(this.held, index)]]);
    callback(new _AnySlot(slot, this.slotName, this.schema.item, this.store));
    this.held.splice(index, 1, ...slot.values());
    return this;
  }

  append(callback: Callback<OfAny>): _ListBuilder {
    const slot = new Map<string, unknown>();
    callback(new _AnySlot(slot, this.slotName, this.schema.item, this.store));
    this.held.push(...slot.values());
    return this;
  }

  remove(index: number): _ListBuilder {
    item(this.held, index);
    this.held.splice(index, 1);
    return this;
  }

  clear(): _ListBuilder {
    this.held.length = 0;
    return this;
  }

  pairs(callback: Callback<OfItem>): _ListBuilder {
    for (let index = 0, count = this.held.length; index < count; index++) {
      callback(new _ItemSlot(this, index, this.schema.minimum + BigInt(index), INT));
    }
    return this;
  }

  /** The position of the item at the key `key` writes; `appending` admits the next key. */
  private position(key: Callback<OfAny>, appending = false): number {
    const written = writtenKey(this.slotName, INT, key);
    if (typeof written !== "bigint") throw new TypeError(`a positional list's keys are ints, got ${typeName(written)}`);
    const position = Number(written - this.schema.minimum);
    if (!(position >= 0 && position < this.held.length + Number(appending))) throw new LookupError(`the list has no item ${written}`);
    return position;
  }

  at(key: Callback<OfAny>, callback: Callback<OfAny>): _ListBuilder {
    return this.item(this.position(key), callback);
  }

  put(key: Callback<OfAny>, value: Callback<OfAny>): _ListBuilder {
    const position = this.position(key, true);
    return position === this.held.length ? this.append(value) : this.item(position, value);
  }

  discard(key: Callback<OfAny>): _ListBuilder {
    return this.remove(this.position(key));
  }
}

/** The keys of a positional list. */
const INT = new Schemas.OfNative.Data(BigInt);

/** The key that `key` writes, as a value of `schema`. */
function writtenKey(name: string, schema: unknown, key: Callback<OfAny>): unknown {
  const held = new Map<string, unknown>();
  key(new _AnySlot(held, name, schema));
  if (!held.has(name)) throw new ValueError("a key needs a value");
  return held.get(name);
}

/** `Visitors.OfItem` over one item of a list builder: its key, read from a copy, and its value. */
export class _ItemSlot implements OfItem {
  constructor(private readonly builder: { slotName: string; item(index: number, callback: Callback<OfAny>): unknown },
    private readonly index: number, private readonly heldKey: unknown, private readonly schema: unknown) {}

  key(callback: Callback<OfAny>): _ItemSlot {
    const name = this.builder.slotName;
    callback(new _AnySlot(new Map([[name, this.heldKey]]), name, this.schema));
    return this;
  }

  value(callback: Callback<OfAny>): _ItemSlot {
    this.builder.item(this.index, callback);
    return this;
  }
}

/** `Visitors.OfIndexed` building a keyed list, starting from `pairs`: items held by unique keys, in insertion order.
 * Keys are compared by schema equality; an item written with no value is left out. */
export class _MapBuilder implements IndexedVisitor {
  readonly held: [unknown, unknown][];

  constructor(readonly slotName: string, private readonly schema: Schemas.OfIndexed.Data,
    pairs: Iterable<readonly [unknown, unknown]>, private readonly store: OfStore | null = null) {
    this.held = [...pairs].map(([key, value]) => [key, value]);
  }

  private find(key: unknown): number | null {
    const wanted = nativeKey(key);
    const index = this.held.findIndex(([k]) => nativeKey(k) === wanted);
    return index < 0 ? null : index;
  }

  private position(key: Callback<OfAny>): number {
    const index = this.find(writtenKey(this.slotName, this.schema.key, key));
    if (index === null) throw new LookupError("the list has no item with this key");
    return index;
  }

  items(callback: Callback<OfAny>): _MapBuilder {
    for (let index = 0, count = this.held.length; index < count; index++) this.item(index, callback);
    return this;
  }

  item(index: number, callback: Callback<OfAny>): _MapBuilder {
    const pair = item(this.held, index);
    const slot = new Map([[this.slotName, pair[1]]]);
    callback(new _AnySlot(slot, this.slotName, this.schema.item, this.store));
    this.held.splice(index, 1, ...[...slot.values()].map((value) => [pair[0], value] as [unknown, unknown]));
    return this;
  }

  append(_callback: Callback<OfAny>): _MapBuilder {
    throw new TypeError("a keyed list takes put, not append");
  }

  remove(index: number): _MapBuilder {
    item(this.held, index);
    this.held.splice(index, 1);
    return this;
  }

  clear(): _MapBuilder {
    this.held.length = 0;
    return this;
  }

  pairs(callback: Callback<OfItem>): _MapBuilder {
    for (let index = 0, count = this.held.length; index < count; index++) {
      callback(new _ItemSlot(this, index, (this.held[index] as [unknown, unknown])[0], this.schema.key));
    }
    return this;
  }

  at(key: Callback<OfAny>, callback: Callback<OfAny>): _MapBuilder {
    return this.item(this.position(key), callback);
  }

  put(key: Callback<OfAny>, value: Callback<OfAny>): _MapBuilder {
    const written = writtenKey(this.slotName, this.schema.key, key);
    const index = this.find(written);
    if (index !== null) return this.item(index, value);
    const slot = new Map<string, unknown>();
    value(new _AnySlot(slot, this.slotName, this.schema.item, this.store));
    this.held.push(...[...slot.values()].map((v) => [written, v] as [unknown, unknown]));
    return this;
  }

  discard(key: Callback<OfAny>): _MapBuilder {
    return this.remove(this.position(key));
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
 * a `Visitors.OfNative` (`v.set(...)`), or the builder of a value object, a union value or an intersection value,
 * which starts from the value already set. A value object given as the value replaces the one set. */
function setter<V extends PropertyHolder>(visitor: V, self: unknown, name: string, schema: unknown = null) {
  return (spec: unknown): unknown => {
    if (isRecord(spec)) visitor.property(name, (p) => p.clear().value((a) => apply(a, name, schema, spec)));
    else visitor.property(name, (p) => p.value((a) => apply(a, name, schema, spec)));
    return self;
  };
}

/** Writes `spec` (a value, or a callable taking the value's builder) as a value of `schema`. An array given for a list
 * replaces its items, each written the same way under the item schema. */
function apply(visitor: OfAny, name: string, schema: unknown, spec: unknown): void {
  if (schema instanceof Schemas.OfIndexed.Data) {
    if (typeof spec === "function") visitor.as_indexed(spec as Callback<IndexedVisitor>);
    else if (schema.positional && Array.isArray(spec)) visitor.as_indexed((items) => applyItems(items.clear(), name, schema.item, spec));
    else if (!schema.positional && (spec instanceof Map || spec instanceof IndexedMap || Array.isArray(spec))) {
      const pairs: unknown[] = Array.isArray(spec) ? spec : [...(spec as Map<unknown, unknown>).entries()];
      visitor.as_indexed((items) => applyPairs(items.clear(), name, schema, pairs));
    } else {
      const takes = schema.positional ? "a list" : "a mapping, (key, value) pairs";
      throw new TypeError(`property ${repr(name)} takes ${takes} or a Spec, got ${typeName(spec)}`);
    }
  } else if (schema instanceof Schemas.OfObject.Data || schema instanceof Schemas.OfUnion.Data
    || schema instanceof Schemas.OfIntersection.Data) {
    if (typeof spec === "function") writeRecord(visitor, schema, spec as Callback<ObjectVisitor>);
    else if (isRecord(spec)) writeRecord(visitor, schema, (r) => spec.accept(r));
    else throw new TypeError(`property ${repr(name)} takes ${withArticle(noun(schema))} or a Spec, got ${typeName(spec)}`);
  } else {
    visitor.as_native(typeof spec === "function" ? (spec as Callback<OfNative>) : (n) => n.set(spec as Native));
  }
}

function applyPairs(visitor: IndexedVisitor, name: string, schema: Schemas.OfIndexed.Data, pairs: readonly unknown[]): void {
  for (const pair of pairs) {
    if (!(Array.isArray(pair) && pair.length === 2)) throw new TypeError(`property ${repr(name)} takes (key, value) pairs, got ${typeName(pair)}`);
    const [key, value] = pair;
    visitor.put((a) => apply(a, name, schema.key, key), (a) => apply(a, name, schema.item, value));
  }
}

function applyItems(visitor: IndexedVisitor, name: string, schema: unknown, specs: readonly unknown[]): void {
  for (const spec of specs) visitor.append((a) => apply(a, name, schema, spec));
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
    for (const [name, schema] of this.schema.properties) {
      if (this.values.has(name)) callback(new _PropertySlot(this.values, name, schema, this.store));
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
  const store = storeOf(source);
  for (const [name, adjacency] of store === null ? [] : schema.adjacencies) {
    for (const entry of (store as OfStore)._relationData(adjacency.relation as RelationSchema).linking(adjacency.me, source)) {
      const builder = makeEntryBuilder(adjacency.relation as RelationSchema, adjacency.me, store);
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

function makeRecordBuilder(schema: RecordSchema, source?: ValueObject, store: OfStore | null = null): ObjectVisitor {
  const target = new RecordBuilderTarget(schema, source, store);
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (RECORD_BUILDER_METHODS.has(prop)) return (t[prop as "has"] as (...a: unknown[]) => unknown).bind(t);
      const schema = t.schema.properties.get(prop);
      if (schema !== undefined) return setter(t, t.proxy, prop, schema);
      if (t.adjacencyNames().includes(prop)) return adder(t, prop);
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
    if (!isInstance(target) && !(isRecord(target) && stateOf(target).schema instanceof Schemas.OfObject.Data)) {
      throw new TypeError("proxies can only link proxy instances and their value objects");
    }
    sameStore(this.store, target);
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

  constructor(private readonly relation: RelationSchema, private readonly me: string, readonly store: OfStore | null = null) {}

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
    for (const name of [...this.values.keys()]) callback(new _PropertySlot(this.values, name, this.relation.properties.get(name), this.store));
    return this.proxy;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): _EntryBuilder {
    if (!this.relation.properties.has(name)) throw new AttributeError(`${repr(name)} is not a property of this relation`);
    callback(new _PropertySlot(this.values, name, this.relation.properties.get(name), this.store));
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
    const entry = makeEntryBuilder(this.schema.relation as RelationSchema, this.schema.me, this.builder.store);
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

  constructor(readonly store: OfStore, readonly schema: ObjectSchema, readonly schemaName: string,
    private readonly source?: Instance) {}

  properties(callback: Callback<OfProperty>): DynamicBuilder {
    for (const name of [...this.values.keys()]) callback(new _PropertySlot(this.values, name, this.schema.properties.get(name), this.store));
    return this.proxy;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): DynamicBuilder {
    if (!this.schema.properties.has(name)) throw new AttributeError(`${repr(name)} is not a property of ${repr(this.schemaName)}`);
    callback(new _PropertySlot(this.values, name, this.schema.properties.get(name), this.store));
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
    return this.made(this.write(makeInstance(this.store, this.schema, this.schemaName)));
  }

  clone(...args: unknown[]): Instance {
    noArguments("clone", args);
    if (this.source === undefined) throw new ValueError("clone() is only valid with a source instance");
    return this.made(this.write(makeInstance(this.store, this.schema, this.schemaName)));
  }

  update(...args: unknown[]): Instance {
    noArguments("update", args);
    if (this.source === undefined) throw new ValueError("update() is only valid with a source instance");
    for (const adjacency of this.schema.adjacencies.values()) {
      this.store._relationData(adjacency.relation as RelationSchema).discard_linking(adjacency.me, this.source);
    }
    return this.write(this.source);
  }

  /** Adds a new instance to its schema's extent. */
  private made(target: Instance): Instance {
    const extent = this.store._extents.get(this.schemaName) ?? [];
    extent.push(target);
    this.store._extents.set(this.schemaName, extent);
    return target;
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
      const relation = this.store._relationData((this.schema.adjacencies.get(name) as AdjacencySchema).relation as RelationSchema);
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

export namespace OfRelation {
  export const Data = RelationData;
  export type Data = RelationData;
}

export namespace OfIndexed {
  /** The class of keyed lists as proxies read them. */
  export const Map = IndexedMap;
  export type Map = IndexedMap;
}

/** Internal classes, exposed for protocol conformance tests. */
export const _internals = { ObjectTarget, ObjectBuilderTarget, RecordBuilderTarget, _EntryBuilder, _AdjacencySlot, _LinkSlot,
  _PropertySlot, _AnySlot, _NativeSlot, _ListBuilder, _MapBuilder, _ItemSlot };
