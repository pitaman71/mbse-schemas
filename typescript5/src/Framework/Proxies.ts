/**
 * Proxies: the dynamic implementation of the visitor protocol.
 *
 * Programs using proxies skip code generation. The store, `new Builders.Store()`, holds schemas and the proxies built
 * with them (see `Stores`); `_Store` here is its implementation of proxies. A named schema is registered as it is built,
 * and `store.builder(name, instance)` returns a builder for it; a store builds through `store.<Name>(callback)`, its
 * canonical form.
 * Data instances (`Proxies.OfObject.Data`)
 * and builders (`Proxies.OfObject.Builder`) both implement `Visitors.OfObject`: data instances read-only, builders
 * writable. Their properties and adjacencies are members: `card.name` is a `Visitors.OfProperty`, read compactly
 * through `[Symbol.toPrimitive]` (`` `${card.name}` ``), and `card.phones` a `Visitors.OfAdjacency`, which iterates its
 * entries; an entry's link is the linked instance itself (`entry.phone === p`). Called, a member writes through a
 * `Specs.Callback`: `b.name("Ada")`, `b.home((p) => p.as_object((o) => o.number("1")))`,
 * `b.phones((a) => a.insert((e) => e.phone(p)))`. A data instance is callable, so that calling it, a write, throws
 * `Errors.ReadOnlyError`.
 *
 * A member is both getter and setter, so each visitor is a `Proxy` with a function target, its `name` and `length`
 * hidden: lookup follows Python's, the visitor's own methods first, then schema names. JavaScript's own protocol probes
 * (`then`, `toJSON`, ...) read as undefined unless the schema names them, so awaiting, inspecting or printing a visitor
 * is safe. Identities are never reused.
 *
 * A store holds its singletons, created when their schemas are registered (`store.singleton(globalName)`), and through
 * them its data (see `Stores`); an object nothing reachable from a singleton links is the program's to keep. A
 * relation's entries live on the objects they link, so they go with them. Adding an entry equal to an existing one is
 * elided where the relation has a `unique` clause; an open relation's entries are a list from each end, equal entries
 * kept. An object of one store cannot be linked to, or be a builder's source in, another. An adjacency of a data
 * instance is also the frozen array of its entries in the order they were added, with `project(name)`, each entry's
 * link or property, and `at(key)`, the entry with a key its relation declares (which replaces the array's own
 * `at(index)`; index it with `[i]`).
 *
 * A property whose schema is an `OfObject` holds a value object (`Proxies.OfObject.Record`), owned by one object, read
 * through `as_object` (`card.home.as_object(...)`) and written through it on a builder. A union value's branches and an
 * intersection value's parts are members giving the visitor of their own schema's kind (`shape.circle`, `ticket.stamp`);
 * writing one branch clears any other.
 *
 * Reads never throw: a visitor of an absent value, of a value of another kind, or of a member the schema lacks reads
 * as empty. The one throw is a write that the visitor's mode, or the value, forbids: `Errors.ReadOnlyError`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { toHex } from "./Bytes.js";
import { AttributeError, KeyError, LookupError, ReadOnlyError, ValueError } from "./Errors.js";
import { compareStrings, REPR, repr, sortedStrings, Tuple, TYPE_NAME, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import * as Stores from "./Stores.js";
import type * as Visitors from "./Visitors.js";

type ObjectSchema = Schemas.OfObject.Data;
type RelationSchema = Schemas.OfRelation.Data;
type AdjacencySchema = Schemas.OfAdjacency.Data;
/** The schema of a record: a value object's, or a union's or intersection's, whose properties are its branches or
 * parts. */
type RecordSchema = ObjectSchema | Schemas.OfUnion.Data | Schemas.OfIntersection.Data;

function isRecordSchema(schema: unknown): schema is RecordSchema {
  return schema instanceof Schemas.OfObject.Data || schema instanceof Schemas.OfUnion.Data
    || schema instanceof Schemas.OfIntersection.Data;
}

/** The names a value of a union, object or intersection schema has as members: its branches, properties or parts. */
function kindMembers(schema: RecordSchema): Set<string> {
  if (schema instanceof Schemas.OfUnion.Data) return new Set(schema.branches.map((branch) => branch.name));
  if (schema instanceof Schemas.OfIntersection.Data) return new Set(schema.parts.map((part) => part.name));
  return new Set(schema.properties.keys());
}
type Values = Map<string, unknown>;
type Mapping = Map<unknown, unknown>;

/** A proxy instance as seen by callers: a read-only `Visitors.OfObject`, its members readable by name. */
export type Instance = Visitors.OfObject & { readonly [name: string]: any };

/** A proxy builder as seen by callers: `Visitors.OfObject`, finalizers, and members by name. */
export type DynamicBuilder = Visitors.OfObject & {
  create(): Instance;
  clone(): Instance;
  update(): Instance;
  [name: string]: any;
};

/** A value object as seen by callers: a read-only `Visitors.OfObject`, `OfUnion` or `OfIntersection`. */
export type ValueObject = { readonly [name: string]: any };

/** JavaScript's own protocol probes: never schema lookups unless the schema names them, so awaiting, inspecting or
 * printing a proxy is safe. */
export const _probes: ReadonlySet<string> = new Set<string>([
  "then", "catch", "finally", "toJSON", "constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty",
  "isPrototypeOf", "propertyIsEnumerable", "__proto__", "$$typeof", "asymmetricMatch", "nodeType", "inspect",
]);

// --- Shells: one member both getter and setter ---

/** Node's `util.inspect.custom` symbol, by its registered name, so no Node module is imported. */
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
/** The Jupyter display protocol's symbol, as Deno's kernel uses it. */
const JUPYTER_DISPLAY = Symbol.for("Jupyter.display");

/** The members every object inherits, which a name the schema declares overrides. */
const OBJECT_MEMBERS: object = Object.prototype;

/** The state behind each proxy this module makes, by proxy. */
const INNER = new WeakMap<object, any>();

function innerOf(value: unknown): any {
  return INNER.get(value as object);
}

/** What a shell's state provides: its members by name, and what it says of itself. */
interface Shellable {
  _proxy: any;
  _member(name: string): unknown;
  _declares(name: string): boolean;
  _readOnly(): string;
}

/** A proxy over `inner`: its own methods and fields first, then its members, by name; called, `call` (a function
 * target, its `name` and `length` hidden, which `call` serves). */
function shell(inner: Shellable, call?: (spec: unknown) => unknown, frozen = false): any {
  const refuse = (): never => {
    throw new AttributeError(inner._readOnly());
  };
  const target: any = call === undefined ? {} : (spec: unknown) => call(spec);
  delete target.name; // hidden, so that members of these names are the schema's
  delete target.length;
  // Node's inspect reads the hook through the proxy (Node 22) or formats the proxy's target (later): the target carries
  // it, and the proxy serves the target's.
  Object.defineProperty(target, INSPECT, { value: () => (inner as any)[REPR]() });
  Object.setPrototypeOf(target, Object.getPrototypeOf(inner)); // so that `instanceof` names its class
  if (frozen) Object.freeze(target);
  const proxy = new Proxy(target, {
    get: (_target, prop) => {
      if (prop === INSPECT) return target[INSPECT];
      if (typeof prop === "symbol" || prop.startsWith("_")
        || (prop in inner && !(prop in OBJECT_MEMBERS && inner._declares(prop)))) { // a declared name wins over Object's
        const value = Reflect.get(inner, prop, inner);
        return typeof value === "function" && prop !== "constructor" && !INNER.has(value) ? value.bind(inner) : value;
      }
      if (_probes.has(prop) && !inner._declares(prop)) return undefined;
      return inner._member(prop);
    },
    has: (_target, prop) => typeof prop === "symbol" || prop.startsWith("_") ? Reflect.has(inner, prop)
      : prop in inner || inner._declares(prop),
    set: refuse,
    defineProperty: refuse,
    deleteProperty: refuse,
    setPrototypeOf: refuse,
  });
  inner._proxy = proxy;
  INNER.set(proxy, inner);
  return proxy;
}

/** The base of a shell's state: no members, unless a subclass names them. */
abstract class Shelled implements Shellable {
  _proxy: any;
  abstract readonly [TYPE_NAME]: string;

  _member(_name: string): unknown {
    return undefined;
  }

  _declares(_name: string): boolean {
    return false;
  }

  _readOnly(): string {
    return "a visitor's members cannot be assigned: call a member to write through it";
  }

  /** Python's default `repr()`, for a visitor that gives none of its own. */
  _repr(): string {
    return `<${this[TYPE_NAME]} object>`;
  }

  [REPR](): string {
    return this._repr();
  }

  /** Jupyter kernels (e.g. Deno's) display a cell's value with this, before probing it for other formats. */
  [JUPYTER_DISPLAY](): Record<string, string> {
    return { "text/plain": this._repr() };
  }
}

// --- Stores ---

/** A store of proxies: schemas by name, and the instance of each singleton schema registered, created with it.
 * `store.builder(name, instance)` gives a builder of an object of a registered schema. */
export abstract class _Store extends Stores.Catalog implements Stores.Store {
  _building = 0; // how deep in builders a write is: ownership is settled when the outermost one ends
  _unowned: Instance[] = []; // objects created since, whose schemas declare an owner
  _orphaned: Instance[] = []; // owned objects an owning entry of which was removed since
  readonly _keys = new Map<string, number>(); // the last number a key's pattern gave, by relation, owner and key
  /** The counted objects upserts created, weakly, by upsert key, symbol and the frame that reached the upsert (63). */
  readonly _upserted = new Map<string, WeakRef<object>>();

  /** A transaction's writes (docs/OBJECT_IDENTITY.md, Decided, 89, 96): held in an overlay while it runs, written when it
   * ends, or, where it throws, dropped, the store's registries as they were before it began. */
  _transacting<T>(write: () => T): T {
    if (OVERLAY !== null) throw new ValueError("a transaction is open: transactions do not nest");
    const saved = this._saved();
    const overlay = OVERLAY = new _Overlay(this);
    let written: T;
    try {
      written = this._writing(write); // ownership is settled within it
    } catch (error) {
      OVERLAY = null;
      this._restore(saved);
      throw error;
    }
    OVERLAY = null;
    try {
      this._commit_schemas(overlay);
    } catch (error) {
      this._restore(saved);
      throw error;
    }
    overlay.commit();
    return written;
  }

  /** Applies the updates of schema objects that waited for the transaction's commit. */
  abstract _commit_schemas(overlay: _Overlay): void;

  /** The schema objects held when a transaction begins: those its updates of wait for its commit. */
  abstract _existing(): number;

  /** What the store holds, besides objects, that a transaction may change: restored where it throws. */
  _saved(): Map<Map<unknown, unknown>, [unknown, unknown][]> {
    return new Map<Map<unknown, unknown>, [unknown, unknown][]>([this._schemas, this._singletons, this._keys, this._upserted]
      .map((held) => [held as Map<unknown, unknown>, [...held]]));
  }

  _restore(saved: Map<Map<unknown, unknown>, [unknown, unknown][]>): void {
    for (const [held, entries] of saved) {
      held.clear();
      for (const [key, value] of entries) held.set(key, value);
    }
  }

  /** A builder's write: where it is the outermost, the objects it created are given their owners after it. */
  _writing<T>(write: () => T): T {
    this._building += 1;
    let written: T;
    try {
      written = write();
    } catch (error) {
      if (this._building === 1) { // a refused write: what it left pending is not the next one's to settle
        this._unowned = [];
        this._orphaned = [];
      }
      throw error;
    } finally {
      this._building -= 1;
    }
    if (this._building === 0 && (this._unowned.length > 0 || this._orphaned.length > 0)) {
      this._settle_owners();
      this._delete_orphans();
    }
    return written;
  }

  /** Gives each object created without an owner, whose schema declares one, the one owner possible: the singleton at
   * the owning end, its keys generated by their patterns (docs/OBJECT_IDENTITY.md, Decided, 33). Where none, or more
   * than one, is possible, it raises, naming the ownership missing. */
  _settle_owners(): void {
    const pending = this._unowned;
    this._unowned = [];
    for (const target of pending) {
      const state = innerOf(target) as _ObjectData;
      const owners = [...state._schema.adjacencies.values(), ...state._schema.anonymous].filter((a) => a.owner);
      if (owners.some((a) => linking(a.relation as RelationSchema, a.me, target).length > 0)) continue;
      const possible: [AdjacencySchema, string, unknown][] = [];
      for (const adjacency of owners) {
        const relation = adjacency.relation as RelationSchema;
        const link = [...relation.entry.links.keys()].find((other) => other !== adjacency.me) as string;
        const fillers = [...this._schemas.values()].filter((schema) => schema instanceof Schemas.OfObject.Data
          && schema.fills(relation, link)) as ObjectSchema[];
        if (fillers.length === 1 && fillers[0]!.singleton !== null) {
          possible.push([adjacency, link, this.singleton(fillers[0]!.singleton)]);
        }
      }
      const names = owners.map((a) => repr(a.name || (a.relation as RelationSchema).name)).join(", ");
      if (possible.length !== 1) {
        throw new ValueError(`a ${repr(state._schemaName)} needs an owner through ${names}: give it one, since `
          + `${possible.length === 0 ? "no" : "more than one"} singleton can be`);
      }
      const [adjacency, link, owner] = possible[0]!;
      const relation = adjacency.relation as RelationSchema;
      const keys = new Map(keyNames(relation, link, adjacency.me)
        .map((name) => [name, this._next_key(relation, owner, name, link, state._schemaName)] as const));
      addEntry(relation, makeEntry(relation, new Map([[link, owner], [adjacency.me, target]]), keys));
    }
  }

  /** Deletes each owned object whose owning entry was removed and not added again, and in cascade what it owns
   * (docs/OBJECT_IDENTITY.md, Decided, 48): every entry linking it is removed, so that nothing reaches it. */
  _delete_orphans(): void {
    const deleted = new Set<unknown>();
    while (this._orphaned.length > 0) {
      const target = this._orphaned.pop();
      if (deleted.has(target) || ownerEntries(target).length > 0) continue;
      deleted.add(target);
      for (const [relation, held] of [...adjacentOf(target)]) discard(relation, [...held.values()]);
    }
  }

  /** The next value a key's naming pattern gives among the entries of `relation` its owner holds: strictly
   * increasing, past every number held. */
  _next_key(relation: RelationSchema, owner: unknown, name: string, link: string, owned: string): string {
    const prop = relation.entry.properties.get(name) as Schemas.OfProperty.Data;
    if (prop.pattern === null) {
      throw new ValueError(`a ${repr(owned)} needs an owner: the key ${repr(name)} of ${repr(relation.name)} has no naming `
        + "pattern to give it a value");
    }
    const held = linking(relation, link, owner).map((entry) => prop.number_of(String(innerOf(entry)._properties.get(name) ?? "")) ?? 0);
    const index = `${identityOf(relation)}:${identityOf(owner)}:${name}`;
    this._keys.set(index, Math.max(this._keys.get(index) ?? 0, ...held) + 1);
    return prop.name_for(this._keys.get(index)!);
  }

  /** Registers a schema under its name; a singleton schema's instance is created with it. */
  override _register(schema: any): void {
    const globalName = schema instanceof Schemas.OfObject.Data ? schema.singleton : null;
    if (globalName !== null && this._singletons.has(globalName)) {
      throw new ValueError(`singleton ${repr(globalName)} is already registered`);
    }
    super._register(schema);
    if (globalName !== null) {
      const name = schema.name as string;
      this._singletons.set(globalName, makeObjectData(this, schema as ObjectSchema, name));
    }
  }

  /** A builder of an object of the schema registered as `name`; for a value object, union, intersection or container
   * schema, of a standalone value, whose `create()` gives a value to assign, copied when placed. Typed loosely, as the
   * store's members are. */
  builder(name: string, instance?: unknown): any {
    const registered = this._schemas.get(name);
    if (isValueSchema(registered)) return standalone(registered, instance ?? null, this);
    return makeObjectBuilder(this, this.schema(name), name, instance as Instance | undefined);
  }

  /** Whether the store was made holding `schema`: the store, `Builders.Store`, says. */
  abstract framework(schema: unknown): boolean;

  /** The value an instance or value object holds in its property `name`. */
  member(instance: unknown, name: string): unknown {
    return read(instance, name);
  }

  /** The name of the schema of what `link` links: the reference object schema the link declares, else the one object
   * schema that declares an adjacency to `relation` via `link`. */
  _filled(relation: RelationSchema, link: string): string {
    const declared = relation.entry.links.get(link)?.schema;
    if (declared instanceof Schemas.OfObject.Data && declared.ref) return this.name_of(declared);
    const names = this._filling(relation, link);
    if (names.length !== 1) throw new TypeError(`expected exactly one object schema filling link ${repr(link)}, found ${repr(names)}`);
    return names[0] as string;
  }
}

/** What tells a reference object apart in memory: a proxy's serial number, or a number for the schema object a builder
 * reads. */
export function _key_of(visitor: any): unknown {
  if (innerOf(visitor) instanceof _LinkMember) visitor = innerOf(visitor)._target();
  const inner = innerOf(visitor);
  return inner instanceof _ObjectData ? inner._id : _numberOf(inner._original);
}

const NUMBERS = new WeakMap<object, number>();
let numbered = 0;

/** A number for each object, as Python's `id()` of it: what tells a schema object apart in memory. */
export function _numberOf(value: object): number {
  if (!NUMBERS.has(value)) NUMBERS.set(value, ++numbered);
  return NUMBERS.get(value) as number;
}

/** A schema's adjacencies marked `owner()`: an object of it is owned; a non-singleton without them is counted. */
function ownerAdjacencies(schema: ObjectSchema): AdjacencySchema[] {
  return [...schema.adjacencies.values(), ...schema.anonymous].filter((a) => a.owner);
}

/** Whether a proxy is a counted object: neither a singleton nor owned (docs/OBJECT_IDENTITY.md, Decided, 37). */
export function _counted(target: unknown): boolean {
  return _counted_schema((innerOf(target) as _ObjectData)._schema);
}

/** Whether an object of `schema` is counted: neither a singleton nor owned. */
export function _counted_schema(schema: ObjectSchema): boolean {
  return schema.singleton === null && ownerAdjacencies(schema).length === 0;
}

/** The entries that own a proxy, through its schema's adjacencies marked `owner()`. */
function ownerEntries(target: unknown): unknown[] {
  return ownerAdjacencies((innerOf(target) as _ObjectData)._schema)
    .flatMap((a) => linking(a.relation as RelationSchema, a.me, target));
}

/** The links of an entry whose objects it owns: each linked proxy whose schema's adjacency marked `owner()` is the
 * entry's relation through that link. */
function ownedLinks(state: _Entry): [string, unknown][] {
  return [...state._links].filter(([link, target]) => isObjectData(target)
    && ownerAdjacencies((innerOf(target) as _ObjectData)._schema).some((a) => a.relation === state._relation && a.me === link));
}

/** Whether a visitor is of data: a proxy, or a link read to one. */
export function _is_data(visitor: unknown): boolean {
  const inner = innerOf(visitor);
  return inner instanceof _ObjectData || inner instanceof _LinkMember;
}

/** An ownership relation's keys: the properties of the clause by which the owned object determines its owner and them,
 * in declaration order. */
function keyNames(relation: RelationSchema, owner: string, owned: string): string[] {
  const clause = relation.uniques.find((unique) => unique.has(owner) && !unique.has(owned)) as ReadonlySet<string>;
  return [...relation.entry.properties.keys()].filter((name) => clause.has(name));
}


/** The store a proxy belongs to; a value object's is its owner's, and one not yet placed has none. */
function storeOf(value: unknown): _Store | null {
  while (isRecordData(value)) value = innerOf(value)._owner;
  return isObjectData(value) ? innerOf(value)._store : null;
}

/** The store a proxy, or a value object placed in one, belongs to. */
export function store_of(value: unknown): _Store {
  const store = storeOf(value);
  if (store === null) throw new TypeError("the value does not belong to a store");
  return store;
}

/** The object a value object belongs to, or null for a reference object or a value object not yet placed. */
export function owner_of(value: unknown): unknown {
  return isRecordData(value) ? innerOf(value)._owner : null;
}

function sameStore(store: _Store | null, value: unknown): void {
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

/** Equality key per EQUALITY.md: distinct scalars never compare equal; floats compare by bit pattern; a value
 * object by its schema and properties, whatever its identity. */
export function scalarKey(value: unknown): string {
  if (isRecordData(value)) {
    const values: Values = innerOf(value)._values;
    const keyed = sortedStrings(values.keys()).map((name) => [name, scalarKey(values.get(name))]);
    return `object:${schemaId(innerOf(value)._schema)}:${JSON.stringify(keyed)}`;
  }
  if (isContainerData(value)) {
    const items: Values = innerOf(value)._items;
    const keyed = sortedStrings(items.keys()).map((key) => [key, scalarKey(items.get(key))]);
    return `container:${schemaId(innerOf(value)._schema)}:${JSON.stringify(keyed)}`;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "float:nan";
    floatView.setFloat64(0, value);
    return `float:${floatView.getBigUint64(0).toString(16)}`;
  }
  if (typeof value === "bigint") return `int:${value}`;
  if (typeof value === "string") return `str:${value}`;
  if (typeof value === "boolean") return `bool:${value}`;
  if (isBytes(value)) return `bytes:${toHex(value)}`;
  throw new TypeError(`an entry property must be a scalar value or a value object, got ${typeName(value)}`);
}

let nextIdentity = 0;

/** An entry of a relation, shared by the objects it links: a read-only `Visitors.OfEntry`. Its links are members
 * giving the linked instance itself (`entry.phone`), and its properties members giving a `Visitors.OfProperty`
 * (`` `${entry.label}` ``). */
class _Entry extends Shelled {
  readonly [TYPE_NAME] = "_Entry";
  readonly _id = ++nextIdentity;

  constructor(readonly _relation: RelationSchema, readonly _links: Map<string, any>, readonly _properties: Values) {
    super();
  }

  as_schema(): Schemas.OfEntry.Data {
    return this._relation.entry;
  }

  override _declares(name: string): boolean {
    return this._links.has(name) || this._relation.entry.properties.has(name);
  }

  override _member(name: string): unknown {
    if (this._links.has(name)) return this._links.get(name);
    const prop = this._relation.entry.properties.get(name);
    if (prop === undefined) return makeEmpty(`${repr(name)} is not a link or property of the relation`);
    return makeProperty(this._properties, name, prop, null, this._proxy, false);
  }

  override _readOnly(): string {
    return "entries are read-only; use a builder";
  }

  override _repr(): string {
    return `<entry of ${this._relation.name || "a relation"}>`;
  }

  /** What the entry is held by: its value in a relation with a `unique` clause, a set, and itself in an open relation,
   * a list from each end, which keeps equal entries. */
  _key(): string {
    if (this._relation.open) return `entry:${this._id}`;
    const links = [...this._links].map(([name, target]) => [name, identityOf(target)] as const).sort(byName);
    const props = [...this._properties].map(([name, value]) => [name, scalarKey(value)] as const).sort(byName);
    return JSON.stringify([links, props]);
  }
}

function makeEntry(relation: RelationSchema, links: Map<string, any>, properties: Values): any {
  return shell(new _Entry(relation, new Map(links), new Map(properties)));
}

function byName(a: readonly [string, unknown], b: readonly [string, unknown]): number {
  return a[0] < b[0] ? -1 : 1; // names within an entry are unique
}

const IDENTITIES = new WeakMap<object, number>();

/** An object's number, by which entries are keyed: a proxy's own, or one given a schema object, which an extension's
 * relation links (docs/SCHEMA_EXTENSION.md), when first asked. */
function identityOf(target: unknown): number {
  const inner = innerOf(target);
  if (inner !== undefined) return inner._id;
  let found = IDENTITIES.get(target as object);
  if (found === undefined) IDENTITIES.set(target as object, (found = ++nextIdentity));
  return found;
}

/** The entries linking each framework schema, by store (by its schema objects, the same for the store and its proxy). */
const FRAMEWORK_ENTRIES = new WeakMap<object, Map<unknown, Map<RelationSchema, Map<string, any>>>>();

/** The entries of one relation that link `target`, by key: they live on the objects they link, a schema object too,
 * which an extension's relation links and which is given its index, hidden from its fields, when first linked. A
 * framework schema, which every store holds, is never written: `store` keeps the entries that link it. */
function table(target: unknown, relation: RelationSchema, store: any = null, write = false): Map<string, any> {
  let own: Tables;
  if (typeof store?.framework === "function" && store.framework(target)) {
    let byTarget = FRAMEWORK_ENTRIES.get(store._objects);
    if (byTarget === undefined) FRAMEWORK_ENTRIES.set(store._objects, (byTarget = new Map()));
    own = byTarget.get(target) as Tables;
    if (own === undefined) byTarget.set(target, (own = new Map()));
  } else {
    own = ownTables(target);
  }
  const tables = tablesOf(own, write);
  let found = tables.get(relation);
  if (found === undefined) {
    found = new Map();
    if (write) tables.set(relation, found);
  }
  return found;
}

type Tables = Map<RelationSchema, Map<string, any>>;

/** The entries that link `target`, by relation, then by key, as the store holds them: made when first asked for. */
function ownTables(target: unknown): Tables {
  const state = innerOf(target) ?? target;
  if (state._adjacent === undefined) Object.defineProperty(state, "_adjacent", { value: new Map(), enumerable: false });
  return state._adjacent;
}

/** The entries that link `target`, by relation, then by key, as the transaction open sees them. */
function adjacentOf(target: unknown): Tables {
  return tablesOf(ownTables(target), false);
}

/** A transaction's writes, held apart from the store's objects until it commits (docs/OBJECT_IDENTITY.md, Decided, 89,
 * 96): a data object's property values and entry tables, and a value object's values, each copied when first written
 * and read in its place while the transaction is open; the updates of schema objects that existed before it began,
 * applied when it commits. One is open at a time: transactions do not nest (50). */
export class _Overlay {
  /** Each holder's values, by its state. */
  readonly values = new Map<object, Values>();
  /** Each holder's entry tables, by the tables the store holds. */
  readonly tables = new Map<Tables, Tables>();
  /** Each schema object's last builder, whose update waits for commit. */
  readonly deferred = new Map<object, any>();
  /** How many schema objects the store held when it began: those its updates of wait for its commit. */
  readonly existing: number;

  constructor(readonly store: any) {
    this.existing = store._existing();
  }

  /** Writes what the transaction wrote into the objects it wrote. */
  commit(): void {
    for (const [holder, values] of this.values) {
      const own = (holder as { _ownValues: Values })._ownValues;
      own.clear();
      for (const [name, value] of values) own.set(name, value);
    }
    for (const [own, tables] of this.tables) {
      own.clear();
      for (const [relation, held] of tables) own.set(relation, held);
    }
  }
}

/** The overlay of the transaction open, if any. */
let OVERLAY: _Overlay | null = null;

export function _overlay(): _Overlay | null {
  return OVERLAY;
}

/** A data object's or a value object's property values, as the transaction open sees them. */
function valuesOf(holder: { _ownValues: Values }): Values {
  return OVERLAY?.values.get(holder) ?? holder._ownValues;
}

/** A holder's values to write: within a transaction, the overlay's copy, made the first time. */
function writableValues(holder: { _ownValues: Values }): Values {
  if (OVERLAY === null) return holder._ownValues;
  let held = OVERLAY.values.get(holder);
  if (held === undefined) OVERLAY.values.set(holder, (held = new Map(holder._ownValues)));
  return held;
}

/** Entry tables as the transaction open sees them; to write, within a transaction, the overlay's copy, made the first
 * time. */
function tablesOf(own: Tables, write: boolean): Tables {
  const held = OVERLAY?.tables.get(own);
  if (held !== undefined) return held;
  if (OVERLAY === null || !write) return own;
  const copied: Tables = new Map([...own].map(([relation, entries]) => [relation, new Map(entries)]));
  OVERLAY.tables.set(own, copied);
  return copied;
}

/** The store an entry belongs to: the one given, else that of a proxy it links. */
function entryStore(state: _Entry, store: unknown): unknown {
  return store ?? [...state._links.values()].map(storeOf).find((found) => found !== null);
}

/** Adds `entry` to every object it links, unless the relation holds a set and an equal entry is there already. An
 * entry that would make a counted object an owner is refused: nothing is owned by a counted object
 * (docs/OBJECT_IDENTITY.md, Decided, 47). */
function addEntry(relation: RelationSchema, entry: any, store: unknown = null): void {
  const state: _Entry = innerOf(entry);
  for (const [link, owned] of ownedLinks(state)) {
    for (const [other, owner] of state._links) {
      if (other !== link && isObjectData(owner) && _counted(owner)) {
        throw new ValueError(`a ${repr((innerOf(owned) as _ObjectData)._schemaName)} cannot be owned by a counted `
          + `${repr((innerOf(owner) as _ObjectData)._schemaName)}: nothing is owned by a counted object`);
      }
    }
  }
  const key = state._key();
  const held = entryStore(state, store);
  if (table(state._links.values().next().value, relation, held).has(key)) return;
  for (const target of state._links.values()) table(target, relation, held, true).set(key, entry);
}

/** The entries of `relation` that link `target` via `link`, in the order they were added. */
function linking(relation: RelationSchema, link: string, target: unknown, store: unknown = null): any[] {
  return [...table(target, relation, store).values()].filter((entry) => innerOf(entry)._links.get(link) === target);
}

/** Removes entries from every object they link; an owned object an owning entry of which goes is noted, to be deleted
 * when the outermost write ends unless it is owned again by then. */
function discard(relation: RelationSchema, entries: readonly unknown[], store: unknown = null): void {
  for (const entry of entries) {
    const state: _Entry = innerOf(entry);
    const key = state._key();
    const held = entryStore(state, store);
    for (const target of state._links.values()) table(target, relation, held, true).delete(key);
    for (const [, owned] of ownedLinks(state)) (innerOf(owned) as _ObjectData)._store._orphaned.push(owned as Instance);
  }
}

function discardLinking(relation: RelationSchema, link: string, target: unknown): void {
  discard(relation, linking(relation, link, target));
}

type Orders = [Map<string, any>, any[]][];

/** The tables that hold the entries linking `source`, every object's they link, each with its entries in order. */
function orders(schema: ObjectSchema, source: unknown): Orders {
  const tables = new Map<Map<string, any>, any[]>();
  const store = storeOf(source);
  for (const adjacency of schema.adjacencies.values()) {
    const relation = adjacency.relation as RelationSchema;
    for (const entry of linking(relation, adjacency.me, source)) {
      for (const target of (innerOf(entry) as _Entry)._links.values()) {
        const held = table(target, relation, store, true); // reordered after the update
        if (!tables.has(held)) tables.set(held, [...held.values()]);
      }
    }
  }
  return [...tables];
}

/** Puts each entry an update rewrote back where the entry it rewrites was, in every table that held that one: an
 * update keeps the order of every object's entries. Entries added anew stay last. */
function reorder(tables: Orders, rewritten: Map<unknown, unknown>): void {
  for (const [held, before] of tables) {
    const byEntry = new Map([...held].map(([key, entry]) => [entry, key] as const));
    const ordered = new Map<string, any>();
    for (const old of before) {
      const now = byEntry.has(old) ? old : rewritten.get(old);
      if (now !== undefined && byEntry.has(now)) ordered.set(byEntry.get(now) as string, now);
    }
    for (const [key, entry] of held) if (!ordered.has(key)) ordered.set(key, entry);
    held.clear();
    for (const [key, entry] of ordered) held.set(key, entry);
  }
}

// --- Visitors over values ---

/** Whether a `Specs.Callback` is its function form; data instances, visitors and paths are callable too, but are
 * values. */
function isFunction(spec: unknown): spec is (visitor: unknown) => unknown {
  return typeof spec === "function" && !INNER.has(spec) && !NAMED.has(spec);
}

/** References by name, a store's paths (`store.Schemas.OfInt`): each a value, resolved by its function to what it names
 * wherever an object is expected (docs/proposals/store-overhaul, Decided, 15). */
const NAMED = new WeakMap<object, () => unknown>();

/** Marks `value` a reference by name, which `resolve` resolves. */
export function _named(value: object, resolve: () => unknown): void {
  NAMED.set(value, resolve);
}

/** What `value` names, where it is a reference by name; else `value`. */
export function _deref(value: unknown): unknown {
  const resolve = NAMED.get(value as object);
  return resolve === undefined ? value : resolve();
}

/** `fn`, given the schema a path names where it is given a path as its schema, its first argument. */
export function _derefFirst<R, A extends unknown[]>(fn: (schema: any, ...rest: A) => R): (schema: unknown, ...rest: A) => R {
  return (schema, ...rest) => fn(_deref(schema), ...rest);
}

/** Hands `visitor` to a function Spec, which reads or writes through it; its return value is the visitor's own. */
function visit(spec: unknown, visitor: unknown): void {
  (spec as (visitor: unknown) => unknown)(visitor);
}

/** Refuses a write that the visitor's mode forbids. */
function write(writable: boolean, reason: string): void {
  if (!writable) throw new ReadOnlyError(reason);
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype;
}

/** Whether a value is iterable, as Python's `Iterable` finds it. */
export function _iterable(value: unknown): value is Iterable<unknown> {
  return value !== null && value !== undefined && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";
}

const isIterable = _iterable;

/** A map's entries, as Python's `Mapping` gives them: a `Map`'s, or a record's (an object literal's) by name; null for
 * any other value. */
export function _mapping(value: unknown): [unknown, unknown][] | null {
  if (value instanceof Map) return [...value];
  const prototype = value !== null && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  return prototype === Object.prototype || prototype === null ? Object.entries(value as object) : null;
}

function isScalar(value: unknown): value is Visitors.Scalar {
  const kind = typeof value;
  return kind === "bigint" || kind === "number" || kind === "string" || kind === "boolean" || isBytes(value);
}

function article(value: Visitors.Scalar): string {
  switch (typeof value) {
    case "bigint":
      return "an int";
    case "number":
      return "a float";
    case "string":
      return "a str";
    case "boolean":
      return "a bool";
    default:
      return "bytes";
  }
}

/** A scalar's value for `[Symbol.toPrimitive]`: it must be set, and of the type the hint asks for (a string for
 * "string", an int or a float for "number"); a value for "default", which bytes have no primitive form of. */
function converted(value: unknown, hint: string, label: string): Visitors.Scalar {
  if (value === null || value === undefined) throw new TypeError(`${label} is not set`);
  const scalar = value as Visitors.Scalar; // a scalar's visitor holds nothing else
  if (hint === "string" && typeof scalar !== "string") throw new TypeError(`${label} holds ${article(scalar)}, not a str`);
  if (hint === "number" && typeof scalar !== "number" && typeof scalar !== "bigint") {
    throw new TypeError(`${label} holds ${article(scalar)}, not an int or a float`);
  }
  if (isBytes(value)) throw new TypeError(`${label} holds bytes, which have no primitive form`);
  return value as Visitors.Scalar;
}

/** The scalar sugar over `get()`, `[Symbol.toPrimitive]` and `valueOf`: each throws when the value is not set or not of
 * the type asked for. A subclass gives `_scalar()`, the value, and `_label()`, what holds it. */
abstract class Dunders extends Shelled {
  abstract _scalar(): unknown;
  abstract _label(): string;

  [Symbol.toPrimitive](hint: string): Visitors.Scalar {
    return converted(this._scalar(), hint, this._label());
  }

  override valueOf(): Visitors.Scalar {
    const value = this._scalar();
    if (value === null || value === undefined) throw new TypeError(`${this._label()} is not set`);
    return value as Visitors.Scalar;
  }
}

/** A visitor of nothing: an absent value, a value of another kind than asked for, or a member the schema lacks. It
 * reads as empty in every protocol, and refuses every write, saying why. */
class _Empty extends Dunders {
  readonly [TYPE_NAME] = "_Empty";

  constructor(readonly _reason: string) {
    super();
  }

  _scalar(): unknown {
    return null;
  }

  _label(): string {
    return "the value";
  }

  as_schema(): null {
    return null; // it visits nothing: no value, so no schema
  }

  get(): null {
    return null;
  }

  [Symbol.iterator](): Iterator<unknown> {
    return [][Symbol.iterator]();
  }

  get as_properties(): any {
    return makeProperties(this._proxy, []);
  }

  _hand(cb: unknown): any {
    if (!isFunction(cb)) throw new ReadOnlyError(this._reason);
    visit(cb, makeEmpty(this._reason));
    return this._proxy;
  }

  as_value(cb: unknown): any {
    return this._hand(cb);
  }

  as_scalar(cb: unknown): any {
    return this._hand(cb);
  }

  as_object(cb: unknown): any {
    return this._hand(cb);
  }

  as_union(cb: unknown): any {
    return this._hand(cb);
  }

  as_intersection(cb: unknown): any {
    return this._hand(cb);
  }

  as_adjacencies(cb: unknown): any {
    return this._hand(cb);
  }

  as_iterable(cb: unknown): any {
    visit(cb, [][Symbol.iterator]());
    return this._proxy;
  }

  as_container(cb: unknown): any {
    return this._hand(cb);
  }

  at(_index: unknown): any {
    return makeEmpty(this._reason);
  }

  /** Nothing to visit: as an inapplicable container's, `cb` is not called. */
  as_ordered(_cb: unknown): any {
    return this._proxy;
  }

  as_dict(_cb: unknown): any {
    return this._proxy;
  }

  as_entries(cb: unknown): any {
    visit(cb, [][Symbol.iterator]());
    return this._proxy;
  }

  get length(): number {
    return 0;
  }

  _refuse(..._args: unknown[]): never {
    throw new ReadOnlyError(this._reason);
  }

  readonly set = this._refuse;
  readonly clear = this._refuse;
  readonly insert = this._refuse;
  readonly remove = this._refuse;

  override _member(_name: string): unknown {
    return makeEmpty(this._reason);
  }

  override _repr(): string {
    return "<empty>";
  }
}

function makeEmpty(reason: string): any {
  const state = new _Empty(reason);
  return shell(state, () => state._refuse());
}

/** `Visitors.OfScalar` over one key of a values map. Called, as a union's branch, with a Spec. */
class _Scalar extends Dunders {
  readonly [TYPE_NAME] = "_Scalar";

  constructor(readonly _values: Values, readonly _name: string, readonly _schema: unknown, readonly _writable: boolean,
    readonly _labelText: string, public _parent: unknown = null, readonly _onWrite: (() => void) | null = null) {
    super();
  }

  _scalar(): unknown {
    return this.get();
  }

  _label(): string {
    return this._labelText;
  }

  as_schema(): unknown {
    return this._schema;
  }

  get(): Visitors.Scalar | null {
    const value = this._values.get(this._name);
    return isScalar(value) ? value : null;
  }

  set(value: Visitors.Scalar): void {
    write(this._writable, `${this._labelText} is read-only; write through a builder`);
    if (this._onWrite !== null) this._onWrite();
    this._values.set(this._name, value);
  }

  clear(): void {
    write(this._writable, `${this._labelText} is read-only; write through a builder`);
    this._values.delete(this._name);
  }

  _call(spec: unknown): unknown {
    if (isFunction(spec)) visit(spec, this._proxy);
    else this.set(spec as Visitors.Scalar);
    return this._parent;
  }

  override _repr(): string {
    return `<scalar ${this._labelText}>`;
  }
}

function makeScalar(values: Values, name: string, schema: unknown, writable: boolean, label: string,
  parent: unknown = null, onWrite: (() => void) | null = null): any {
  const state = new _Scalar(values, name, schema, writable, label, parent, onWrite);
  return shell(state, (spec) => state._call(spec));
}

/** `Visitors.OfAny` over one key of a values map, holding a value of `schema`. Read-only, it hands over the value's own
 * visitor, or an empty one; writable, it selects the kind, refusing one the schema does not hold. */
class _Any {
  _type: unknown;
  readonly _any: Schemas.OfAny.Value | null;
  /** Why a Spec has nothing to build: where the value is of any schema and its schema unknown. */
  _unbuilt = "";

  constructor(readonly _values: Values, readonly _name: string, readonly _schema: unknown, readonly _store: _Store | null,
    readonly _writable: boolean, readonly _label: string, readonly _onWrite: (() => void) | null = null) {
    this._type = _schema;
    this._any = this._type instanceof Schemas.OfAny.Value ? this._type : null;
    if (this._any !== null) { // a value of any schema: of the schema the value held has
      const held = _values.get(_name);
      this._type = isRecordData(held) || isRecordBuilder(held) || isContaining(held) ? innerOf(held)._schema : null;
    }
    return new Proxy(this, { // a member of the value's kind, where its schema has one (`_kindMember`)
      get: (target, prop, receiver) => prop in target ? Reflect.get(target, prop, receiver) : target._kindMember(prop),
    });
  }

  /** Whether `name` is a member of the value's kind (`_kindMember`). */
  _hasKindMember(name: string | symbol): boolean {
    const held = this._type;
    return isRecordSchema(held) && kindMembers(held).has(name as string);
  }

  /** A member of the value's kind, where its schema has one: a union's branch, an object's property, an intersection's
   * part, as through `as_union`, `as_object` or `as_intersection` (docs/VISITOR_PATTERN.md); written, it selects the
   * kind. Any other name is not a member. */
  _kindMember(name: string | symbol): unknown {
    if (!this._hasKindMember(name)) return undefined;
    if (this._writable) return this._builder()[name]; // the builder is attached when a member is written, not read
    const value = this._values.get(this._name);
    return isRecordData(value) ? (value as any)[name] : makeEmpty(`${this._label} is not set`);
  }

  /** Where the value is of any schema: the one schema of `kind` its restriction allows, else null. */
  _only(kind: abstract new (...args: never[]) => unknown): unknown {
    const found = (this._any as Schemas.OfAny.Value).schemas.filter((t) => t instanceof kind);
    return found.length === 1 ? found[0] : null;
  }

  /** Where the value is of any schema: whether its restriction allows a value of `schema`; any, unrestricted. */
  _allows(schema: unknown): boolean {
    const restricted = (this._any as Schemas.OfAny.Value).schemas;
    return restricted.length === 0 || restricted.some((t) => t === schema);
  }

  /** Where the value is of any schema, takes the schema a write of `kind` gives: the value's own, if it is one the
   * restriction allows, else the one schema of `kind` it allows; a Spec has no other schema to build by. */
  _ofAny(kind: abstract new (...args: never[]) => unknown, cb: unknown): void {
    if (this._any === null || this._type instanceof kind) return;
    const value = isProperty(cb) ? innerOf(cb)._values.get(innerOf(cb)._name) : cb;
    if (!isFunction(cb) && (isRecordData(value) || isRecordBuilder(value) || isContaining(value))) {
      const schema = innerOf(value)._schema;
      if (!this._allows(schema)) throw new TypeError(`${this._label} does not hold a value of ${shownType(schema)}`);
      this._type = schema;
    } else if (this._writable && (this._values.get(this._name) ?? null) === null) { // a Spec, where nothing is held
      this._type = this._only(kind);
      if (this._any.schemas.length === 0) {
        this._unbuilt = `${this._label} holds a value of any schema: give a value, which carries its schema, not a Spec`;
      }
    }
  }

  as_schema(): unknown {
    return this._schema;
  }

  _touch(): void {
    if (this._onWrite !== null) this._onWrite();
  }

  as_scalar(cb: unknown): this {
    const value = this._values.get(this._name);
    if (this._any !== null && this._type === null) { // a scalar of any schema, or of the one its restriction allows
      this._type = this._only(Schemas.OfScalar.Data) ?? this._any;
    }
    if (this._type instanceof Schemas.OfUnion.Data && this._type.flat) return this._flatScalar(cb, value);
    if (!(this._type instanceof Schemas.OfScalar.Data || this._type instanceof Schemas.OfAny.Value)) {
      return this._hand(cb, makeEmpty(`${this._label} holds ${withArticle(noun(this._type))}, not a scalar`));
    }
    const scalar = makeScalar(this._values, this._name, this._type, this._writable, this._label, this, this._onWrite);
    if (isFunction(cb)) visit(cb, scalar);
    else scalar.set(cb);
    return this;
  }

  /** A flat union's value read as its branch's, and written to the branch its schema picks. */
  _flatScalar(cb: unknown, value: unknown): this {
    const union = this._type as Schemas.OfUnion.Data;
    if (!isFunction(cb)) {
      this._writeRecord((u: unknown) => innerOf(u)._member(branchOf(this._name, union, cb).name)(cb));
      return this;
    }
    if (isRecordData(value) || isRecordBuilder(value)) { // a union value holds one branch
      const values: Values = innerOf(value)._values;
      const [branch, held] = values.entries().next().value as [string, unknown];
      if (isScalar(held)) {
        const branchSchema = (union.properties.get(branch) as Schemas.OfProperty.Data).schema;
        visit(cb, makeScalar(values, branch, branchSchema, false, this._label));
        return this;
      }
    }
    visit(cb, makeEmpty(`${this._label} holds no scalar`));
    return this;
  }

  as_object(cb: unknown): this {
    return this._record(Schemas.OfObject.Data, cb);
  }

  as_union(cb: unknown): this {
    return this._record(Schemas.OfUnion.Data, cb);
  }

  as_intersection(cb: unknown): this {
    return this._record(Schemas.OfIntersection.Data, cb);
  }

  as_container(cb: unknown): this {
    this._ofAny(Schemas.OfContainer.Data, cb);
    if (!(this._type instanceof Schemas.OfContainer.Data)) {
      return this._hand(cb, makeEmpty(this._unbuilt || `${this._label} does not hold a container`));
    }
    const value = this._values.get(this._name);
    if (!this._writable) {
      if (isContainerData(value)) {
        if (isFunction(cb)) {
          visit(cb, value);
          return this;
        }
        throw new ReadOnlyError(`${this._label} is read-only; write through a builder`);
      }
      return this._hand(cb, makeEmpty(`${this._label} is not set`));
    }
    if (isFunction(cb)) { // selecting the kind writes it, as an empty container until written further
      const builder = this._container();
      innerOf(builder)._touch();
      visit(cb, builder);
    } else this._replaceContainer(cb);
    return this;
  }

  /** The builder of the container held, attached to the values when first written; one already attached. */
  _container(): any {
    const value = this._values.get(this._name);
    if (isContainerBuilder(value)) return value;
    const attach = (builder: unknown): void => {
      this._touch();
      this._values.set(this._name, builder);
    };
    return makeContainerBuilder(this._type as Schemas.OfContainer.Data, isContainerData(value) ? value : null, this._store, attach,
      this._label);
  }

  /** Writes a container given as a value: its elements are copied when it is placed. A map (by index) or an iterable
   * (by position) is a shorthand for one holding its elements, which replaces the one held: nothing merges. */
  _replaceContainer(value: unknown): void {
    const elements = _mapping(value) ?? (isIterable(value) && typeof value !== "string" && !isBytes(value)
      ? [...value].map((element, i) => [BigInt(i), element] as [unknown, unknown]) : null);
    if (elements !== null) {
      const attach = (builder: unknown): void => {
        this._touch();
        this._values.set(this._name, builder);
      };
      const builder = makeContainerBuilder(this._type as Schemas.OfContainer.Data, null, this._store, attach, this._label);
      innerOf(builder)._touch();
      for (const [index, element] of elements) { // each a value, or a callback writing the element through its visitor
        if (isFunction(element)) visit(element, builder.at(index));
        else builder.at(index).write(element);
      }
      return;
    }
    if (!(innerOf(value) instanceof _Containing) || innerOf(value)._schema !== this._type) {
      throw new TypeError(`${this._label} takes a container of its schema or a Spec, got ${typeName(value)}`);
    }
    this._touch();
    this._values.set(this._name, value);
  }

  _hand(cb: unknown, empty: unknown): this {
    innerOf(empty)._hand(cb);
    return this;
  }

  _record(kind: abstract new (...args: never[]) => RecordSchema, cb: unknown): this {
    const what = kind === Schemas.OfObject.Data ? "value object" : kind === Schemas.OfUnion.Data ? "union value"
      : "intersection value";
    this._ofAny(kind, cb);
    if (!(this._type instanceof kind)) return this._hand(cb, makeEmpty(this._unbuilt || `${this._label} does not hold ${withArticle(what)}`));
    const value = this._values.get(this._name);
    if (!this._writable) {
      if (isRecordData(value)) {
        if (isFunction(cb)) {
          visit(cb, value);
          return this;
        }
        throw new ReadOnlyError(`${this._label} is read-only; write through a builder`);
      }
      return this._hand(cb, makeEmpty(`${this._label} is read-only; write through a builder`));
    }
    if (isFunction(cb)) this._writeRecord(cb);
    else this._replace(cb);
    return this;
  }

  /** The builder of the value object held, attached to the values when first written; one already attached, so that a
   * builder reads back its pending writes. */
  _builder(): any {
    const value = this._values.get(this._name);
    if (isRecordBuilder(value)) return value;
    const attach = (builder: unknown): void => {
      this._touch();
      this._values.set(this._name, builder);
    };
    return makeRecordBuilder(this._type as RecordSchema, isRecordData(value) ? value : null, this._store, attach);
  }

  /** Selects the kind, writing the value, and hands its builder over. */
  _writeRecord(cb: unknown): void {
    const builder = this._builder();
    innerOf(builder)._touch();
    visit(cb, builder);
  }

  /** Writes a value object, union value or intersection value given as a value: copied when it is placed. */
  _replace(value: unknown): void {
    if (isProperty(value)) value = innerOf(value)._values.get(innerOf(value)._name);
    if (!(isRecordData(value) || isRecordBuilder(value)) || innerOf(value)._schema !== this._type) {
      throw new TypeError(`${this._label} takes ${withArticle(noun(this._type))} or a Spec, got ${typeName(value)}`);
    }
    this._touch();
    this._values.set(this._name, value);
  }

  /** Writes a `Specs.Callback`'s value form: a scalar, a value object, union value or intersection value (a flat
   * union's, its branch's), or a property's value. */
  write(value: unknown): void {
    write(this._writable, `${this._label} is read-only; write through a builder`);
    if (isProperty(value)) value = innerOf(value)._values.get(innerOf(value)._name);
    if (this._any !== null && (isRecordData(value) || isRecordBuilder(value) || isContaining(value))) {
      this._ofAny(innerOf(value)._schema.constructor, value);
    }
    const held = this._type;
    if (held instanceof Schemas.OfUnion.Data && held.flat
      && !((isRecordData(value) || isRecordBuilder(value)) && innerOf(value)._schema === held)) {
      const branch = branchOf(this._name, held, value);
      this._writeRecord((u: unknown) => innerOf(u)._member(branch.name)(value));
    } else if (held instanceof Schemas.OfObject.Data || held instanceof Schemas.OfUnion.Data
      || held instanceof Schemas.OfIntersection.Data) {
      this._replace(value);
    } else if (held instanceof Schemas.OfContainer.Data) {
      this._replaceContainer(value);
    } else {
      this.as_scalar(value);
    }
  }

  clear(): void {
    write(this._writable, `${this._label} is read-only; write through a builder`);
    this._values.delete(this._name);
  }
}

/** `Visitors.OfProperty` over one key of a values map. Called, as a member, with a Spec, it writes or visits through it
 * and returns the visitor it is a member of. */
// --- Containers ---

/** An index in a message: an array of indices as a list, as every implementation shows it. */
function shown(index: unknown): string {
  return repr(index);
}

/** The key (a string, for a Map) a container holds an element by: its index, checked against the index's schema, a scalar
 * or, for an index of a value object of scalars, an array of the value object's properties in declaration order; any
 * other index, a value object, by its equality key. */
function indexKey(schema: Schemas.OfContainer.Data, index: unknown, label: string): string {
  const kind = schema.index;
  if (kind instanceof Schemas.OfScalar.Data) {
    if (kind.type !== null && !Schemas.isScalarOf(kind.type, index)) {
      throw new TypeError(`${label}: an index is a ${String(kind.tag)}, got ${typeName(index)}`);
    }
    return scalarKey(index);
  }
  if (schema.arrangement !== "entries") {
    const hosts = [...(kind as ObjectSchema).properties.values()].map((p) => p.schema as Schemas.OfScalar.Data);
    if (!Array.isArray(index) || index.length !== hosts.length
      || hosts.some((host, i) => host.type !== null && !Schemas.isScalarOf(host.type, index[i]))) {
      const names = hosts.map((host) => String(host.tag)).join(", ");
      throw new TypeError(`${label}: an index is a tuple of ${names}, got ${shown(index)}`);
    }
    return JSON.stringify(index.map(scalarKey));
  }
  if (!isRecordData(index) || innerOf(index)._schema !== kind) {
    throw new TypeError(`${label}: an index is a value of its index type, got ${typeName(index)}`);
  }
  return scalarKey(index);
}

/** Whether a container's positions are its int indices: dense or sparse, indexed by an int. */
function positional(schema: Schemas.OfContainer.Data): boolean {
  const index = schema.index;
  return ["dense", "sparse"].includes(schema.arrangement) && index instanceof Schemas.OfScalar.Data && index.type === BigInt;
}

/** The order of two indices of one ordered scalar: numbers by value, text by code point, false first. */
function compareIndices(a: unknown, b: unknown): number {
  if (typeof a === "string") return compareStrings(a, b as string);
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

/** Keys in the order of their indices: a scalar's, or an array's item by item (sorted stably by each item, last first). */
function sortByIndex(keys: string[], indices: Map<string, unknown>): string[] {
  const first = indices.get(keys[0] as string);
  if (!Array.isArray(first)) return keys.sort((a, b) => compareIndices(indices.get(a), indices.get(b)));
  for (let d = first.length - 1; d >= 0; d--) {
    keys.sort((a, b) => compareIndices((indices.get(a) as unknown[])[d], (indices.get(b) as unknown[])[d]));
  }
  return keys;
}

function negative(index: unknown): boolean {
  return (Array.isArray(index) ? index : [index]).some((i) => typeof i === "bigint" && i < 0n);
}

/** `Visitors.OfContainer` over a container's elements, held by key (see `indexKey`), with each key's index. Each
 * element is read and written through the `Visitors.OfAny` of its slot. */
abstract class _Containing extends Shelled {
  _writable = false;
  _parent: unknown = null;

  constructor(readonly _schema: Schemas.OfContainer.Data, readonly _items: Values, readonly _indices: Map<string, unknown>,
    readonly _store: _Store | null, readonly _label: string) {
    super();
  }

  as_schema(): Schemas.OfContainer.Data {
    return this._schema;
  }

  /** A builder attaches itself to what holds it when written: only a builder writes. */
  _touch(): void {
    (this as unknown as _ContainerBuilder)._attachOnce();
  }

  /** The keys of the elements present: by index where the index is ordered, else in the order added. */
  _keys(): string[] {
    const keys = [...this._items.keys()];
    if (!["dense", "sparse"].includes(this._schema.arrangement) || keys.length === 0) return keys;
    return sortByIndex(keys, this._indices);
  }

  _element(key: string, index: unknown): _Any {
    const at = Array.isArray(index) ? index.map((i) => repr(i)).join(", ") : repr(index);
    return new _Any(this._items, key, this._schema.element, this._store, this._writable, `${this._label}[${at}]`,
      () => this._indices.set(key, index));
  }

  /** The number of positions: in a dense container of int indices, every index from 0 to the last (and every cell of
   * the box they span, for several); else the elements present. */
  get length(): number {
    const indices = [...this._items.keys()].map((key) => this._indices.get(key));
    if (this._schema.arrangement !== "dense" || indices.length === 0) return indices.length;
    if (typeof indices[0] === "bigint") return Number(indices.reduce((m, i) => ((i as bigint) > (m as bigint) ? i : m))) + 1;
    const first = indices[0];
    if (Array.isArray(first) && first.every((i) => typeof i === "bigint")) {
      return first.reduce((product: number, _, d) =>
        product * (Number(indices.reduce((m: bigint, i) => ((i as bigint[])[d] as bigint > m ? (i as bigint[])[d] as bigint : m), 0n)) + 1), 1);
    }
    return indices.length;
  }

  /** The element at `index`, which reads as empty where there is none; a builder's is writable, and writing it adds it. */
  at(index: unknown): any {
    const key = indexKey(this._schema, index, this._label);
    if (this._writable) {
      if (this._schema.arrangement === "dense" && negative(index)) {
        throw new ValueError(`${this._label}: a dense container's index is not negative, got ${shown(index)}`);
      }
      this._touch();
    }
    return this._element(key, index);
  }

  /** Removes the element at `index`, if any. */
  remove(index: unknown): any {
    write(this._writable, `${this._label} is read-only; write through a builder`);
    this._touch();
    const key = indexKey(this._schema, index, this._label);
    this._items.delete(key);
    this._indices.delete(key);
    return this._proxy;
  }

  /** A `Visitors.OfIterator` over the positions, for a dense or sparse container; `cb` is not called otherwise. */
  as_ordered(cb: unknown): any {
    if (["dense", "sparse"].includes(this._schema.arrangement)) visit(cb, new _Iterator(this));
    return this._proxy;
  }

  /** The elements by index, for a container arranged as a dict; `cb` is not called otherwise. */
  as_dict(cb: unknown): any {
    if (this._schema.arrangement === "dict") {
      visit(cb, new Map(this._keys().map((key) => [this._indices.get(key), this._element(key, this._indices.get(key))])));
    }
    return this._proxy;
  }

  /** Each element present with its index, in order, for every container. */
  as_entries(cb: unknown): any {
    visit(cb, this._keys().map((key) => [this._indices.get(key), this._element(key, this._indices.get(key))])[Symbol.iterator]());
    return this._proxy;
  }

  /** The indices an iterator visits: every position of a dense container of int indices, else those present. */
  _positions(): unknown[] {
    const keys = this._keys();
    const first = this._indices.get(keys[0] as string);
    if (this._schema.arrangement === "dense" && keys.length > 0 && positional(this._schema)) {
      return Array.from({ length: this.length }, (_, i) => BigInt(i));
    }
    if (this._schema.arrangement === "dense" && keys.length > 0 && Array.isArray(first)) {
      const sizes = (first as bigint[]).map((_, d) => Number(keys.reduce((m: bigint, key) =>
        ((this._indices.get(key) as bigint[])[d] as bigint > m ? (this._indices.get(key) as bigint[])[d] as bigint : m), 0n)) + 1);
      let cells: bigint[][] = [[]];
      for (const size of sizes) cells = cells.flatMap((cell) => Array.from({ length: size }, (_, i) => [...cell, BigInt(i)]));
      return cells;
    }
    return keys.map((key) => this._indices.get(key));
  }

  /** Writes an element at the int index `index`, moving the elements at it and after up by one. */
  _insert(index: bigint, spec: unknown): void {
    this._touch();
    const moving = this._keys().filter((key) => (this._indices.get(key) as bigint) >= index).reverse();
    for (const key of moving) {
      const at = (this._indices.get(key) as bigint) + 1n;
      const value = this._items.get(key);
      this._items.delete(key);
      this._indices.delete(key);
      this._items.set(scalarKey(at), value);
      this._indices.set(scalarKey(at), at);
    }
    const element = this._element(scalarKey(index), index);
    if (isFunction(spec)) visit(spec, element);
    else element.write(spec);
  }

  /** As a union's branch or an intersection's part: writes through a Spec, or takes the elements of a container given,
   * and returns the value it is a member of. */
  _call(spec: unknown): unknown {
    write(this._writable, `${this._label} is read-only; write through a builder`);
    this._touch();
    if (isFunction(spec)) {
      visit(spec, this._proxy);
    } else if (innerOf(spec) instanceof _Containing && innerOf(spec)._schema === this._schema) {
      const given: _Containing = innerOf(spec);
      this._items.clear();
      for (const [key, value] of given._items) this._items.set(key, value);
      this._indices.clear();
      for (const [key, value] of given._indices) this._indices.set(key, value);
    } else {
      throw new TypeError(`${this._label} takes a container of its schema or a Spec, got ${typeName(spec)}`);
    }
    return this._parent;
  }

  override _repr(): string {
    return `<container of ${this._items.size}>`;
  }
}

/** A container's value, read-only. */
class _ContainerData extends _Containing {
  readonly [TYPE_NAME] = "_ContainerData";

  constructor(schema: Schemas.OfContainer.Data, items: Values, indices: Map<string, unknown>) {
    super(schema, items, indices, null, "the container");
  }
}

function makeContainerData(schema: Schemas.OfContainer.Data, items: Values, indices: Map<string, unknown>): any {
  const state = new _ContainerData(schema, items, indices);
  return shell(state, (spec) => state._call(spec));
}

/** A writable `Visitors.OfContainer`, starting from `source` if given. It attaches itself to what holds it (`attach`)
 * when first written. */
class _ContainerBuilder extends _Containing {
  readonly [TYPE_NAME] = "_ContainerBuilder";
  override _writable = true;
  _attached = false;

  constructor(schema: Schemas.OfContainer.Data, source: unknown, store: _Store | null,
    readonly _attach: (builder: unknown) => void, label: string, parent: unknown = null) {
    super(schema, new Map(source === null ? [] : innerOf(source)._items), new Map(source === null ? [] : innerOf(source)._indices),
      store, label);
    this._parent = parent;
  }

  _attachOnce(): void {
    if (!this._attached) {
      this._attached = true;
      this._attach(this._proxy);
    }
  }

  build(): unknown {
    const items = finalized(this._items);
    return makeContainerData(this._schema, items, new Map([...items.keys()].map((key) => [key, this._indices.get(key)])));
  }

  /** A standalone container's value, to assign (see `_Store.builder`). */
  create(): unknown {
    return this.build();
  }
}

/** A schema in a message: its name, or its kind. */
function shownType(schema: unknown): string {
  const name = (schema as { name?: unknown }).name;
  return typeof name === "string" ? name : withArticle(noun(schema));
}

/** Whether a registered schema is a value's: a value object, union, intersection or container schema. */
function isValueSchema(schema: unknown): schema is RecordSchema | Schemas.OfContainer.Data {
  return (schema instanceof Schemas.OfObject.Data && !schema.ref) || schema instanceof Schemas.OfUnion.Data
    || schema instanceof Schemas.OfIntersection.Data || schema instanceof Schemas.OfContainer.Data;
}

/** A builder of a standalone value of a value object, union, intersection or container schema, starting from `source`
 * if given: its `create()` gives a value, held by nothing until assigned. */
function standalone(schema: RecordSchema | Schemas.OfContainer.Data, source: unknown, store: _Store): any {
  if (schema instanceof Schemas.OfContainer.Data) {
    return makeContainerBuilder(schema, source, store, () => undefined, `a ${repr(schema.name)}`);
  }
  return makeRecordBuilder(schema, source, store);
}

function makeContainerBuilder(schema: Schemas.OfContainer.Data, source: unknown, store: _Store | null,
  attach: (builder: unknown) => void, label: string, parent: unknown = null): any {
  const state = new _ContainerBuilder(schema, source, store, attach, label, parent);
  return shell(state, (spec) => state._call(spec));
}

function isContainerData(value: unknown): boolean {
  return innerOf(value) instanceof _ContainerData;
}

/** Whether a value is a container or a container's builder. */
function isContaining(value: unknown): boolean {
  return innerOf(value) instanceof _Containing;
}

function isContainerBuilder(value: unknown): boolean {
  return innerOf(value) instanceof _ContainerBuilder;
}

/** `Visitors.OfIterator`: a position in a dense or sparse container, before its first position, at one, or past its
 * last. Past an end, a builder's `as_item` extends the container there. */
class _Iterator {
  _at = -1;

  constructor(readonly _container: _Containing) {}

  first(): this {
    this._at = 0;
    return this;
  }

  last(): this {
    this._at = this._container._positions().length - 1;
    return this;
  }

  next(): this {
    this._at = Math.min(this._at + 1, this._container._positions().length);
    return this;
  }

  prev(): this {
    this._at = Math.max(this._at - 1, -1);
    return this;
  }

  /** The index at the position, null before the first or past the last. */
  index(): unknown {
    const positions = this._container._positions();
    return this._at >= 0 && this._at < positions.length ? positions[this._at] : null;
  }

  /** Hands over the element at the position. Past an end, a read-only container's `cb` is not called, and a builder's
   * container is extended there, the position then resting on the new element. */
  as_item(cb: unknown): this {
    const index = this.index();
    if (index !== null) visit(cb, this._container.at(index));
    else if (this._container._writable) this._extend(cb);
    return this;
  }

  _extend(spec: unknown): void {
    this._insertable();
    const positions = this._container._positions() as bigint[];
    if (this._at < 0) {
      this._at = 0;
      this._place(positions.length > 0 ? positions[0] as bigint : 0n, spec);
    } else {
      this._at = positions.length;
      this._place(positions.length > 0 ? (positions.at(-1) as bigint) + 1n : 0n, spec);
    }
  }

  /** Inserts an element before the position, which then rests on it. */
  prepend(spec: unknown): this {
    this._insertable();
    const positions = this._container._positions() as bigint[];
    this._at = Math.max(this._at, 0);
    this._place(this._at < positions.length ? positions[this._at] as bigint
      : (positions.length > 0 ? (positions.at(-1) as bigint) + 1n : 0n), spec);
    return this;
  }

  /** Inserts an element after the position, which then rests on it. */
  append(spec: unknown): this {
    this._insertable();
    const positions = this._container._positions() as bigint[];
    this._at = Math.min(this._at + 1, positions.length);
    this._place(this._at > 0 ? (positions[this._at - 1] as bigint) + 1n : (positions.length > 0 ? positions[0] as bigint : 0n), spec);
    return this;
  }

  /** Refuses an insertion a read-only container, or one whose indices are not ints, cannot take. */
  _insertable(): void {
    write(this._container._writable, `${this._container._label} is read-only; write through a builder`);
    if (!positional(this._container._schema)) {
      throw new ValueError(`${this._container._label}: only a dense or sparse container of int indices has positions to `
        + "insert at; write through at(index)");
    }
  }

  _place(index: bigint, spec: unknown): void {
    this._container._insert(index, spec);
    this._at = (this._container._positions() as bigint[]).indexOf(index);
  }

  toString(): string {
    return `<iterator at ${shown(this.index())}>`;
  }
}

class _Property extends Dunders {
  readonly [TYPE_NAME] = "_Property";

  constructor(readonly _values: Values, readonly _name: string, readonly _schema: Schemas.OfProperty.Data | Schemas.OfUnion.Branch,
    readonly _store: _Store | null, public _parent: unknown, readonly _writable: boolean,
    readonly _onWrite: (() => void) | null = null) {
    super();
  }

  _any(): _Any {
    return new _Any(this._values, this._name, this._schema.schema, this._store, this._writable, this._label(), this._onWrite);
  }

  _label(): string {
    return `property ${repr(this._name)}`;
  }

  _scalar(): unknown {
    const found: unknown[] = [];
    this._any().as_scalar((s: any) => found.push(s.get())); // a callback is always called
    return found[0];
  }

  as_schema(): Schemas.OfProperty.Data | Schemas.OfUnion.Branch {
    return this._schema;
  }

  get(): Visitors.Scalar | null {
    return this._scalar() as Visitors.Scalar | null;
  }

  as_value(cb: unknown): any {
    const visitor = this._any();
    if (isFunction(cb)) visit(cb, visitor);
    else visitor.write(cb);
    return this._proxy;
  }

  as_scalar(cb: unknown): any {
    this._any().as_scalar(cb);
    return this._proxy;
  }

  as_object(cb: unknown): any {
    this._any().as_object(cb);
    return this._proxy;
  }

  _call(spec: unknown): unknown {
    if (isFunction(spec)) visit(spec, this._proxy);
    else this.as_value(spec);
    return this._parent;
  }

  /** A member of its value's kind, where its schema has one (`_Any`'s). */
  override _member(name: string): unknown {
    return this._any()._kindMember(name);
  }

  override _declares(name: string): boolean {
    return this._any()._hasKindMember(name);
  }

  override _repr(): string {
    return `<${this._label()}>`;
  }
}

function makeProperty(values: Values, name: string, schema: Schemas.OfProperty.Data | Schemas.OfUnion.Branch, store: _Store | null,
  parent: unknown, writable: boolean, onWrite: (() => void) | null = null): any {
  const state = new _Property(values, name, schema, store, parent, writable, onWrite);
  return shell(state, (spec) => state._call(spec));
}

function isProperty(value: unknown): boolean {
  return innerOf(value) instanceof _Property;
}

/** `Visitors.OfObject.as_properties`: the properties present, iterated, or called with a callback for each. */
class _Properties extends Shelled {
  readonly [TYPE_NAME] = "_Properties";

  constructor(readonly _owner: unknown, readonly _properties: readonly unknown[]) {
    super();
  }

  [Symbol.iterator](): Iterator<unknown> {
    return this._properties[Symbol.iterator]();
  }

  _call(cb: unknown): unknown {
    for (const prop of this._properties) visit(cb, prop);
    return this._owner;
  }

  override _repr(): string {
    return "<properties>";
  }
}

function makeProperties(owner: unknown, properties: readonly unknown[]): any {
  const state = new _Properties(owner, properties);
  return shell(state, (cb) => state._call(cb));
}

/** The properties of an object present in `values`, in the schema's declared order. */
function propertiesOf(owner: unknown, values: Values, schema: RecordSchema, store: _Store | null, writable: boolean,
  onWrite: (() => void) | null = null): any {
  return makeProperties(owner, [...schema.properties].filter(([name]) => values.has(name))
    .map(([name, prop]) => makeProperty(values, name, prop, store, owner, writable, onWrite)));
}

/** The visitor of a union's branch or an intersection's part: of its own schema's kind, the value itself for a value
 * object held, or an empty one. */
function kindVisitor(values: Values, name: string, schema: unknown, store: _Store | null, parent: unknown,
  writable: boolean, label: string, onWrite: (() => void) | null = null): any {
  const held = schema;
  const value = values.get(name);
  if (held instanceof Schemas.OfScalar.Data) return makeScalar(values, name, held, writable, label, parent, onWrite);
  if (!writable) return isRecordData(value) || isContainerData(value) ? value : makeEmpty(`${label} is not set`);
  if (isRecordBuilder(value) || isContainerBuilder(value)) return value;
  if (held instanceof Schemas.OfContainer.Data) {
    const placed = (builder: unknown): void => {
      (onWrite as () => void)();
      values.set(name, builder);
    };
    return makeContainerBuilder(held, isContainerData(value) ? value : null, store, placed, label, parent);
  }
  const attach = (builder: unknown): void => {
    (onWrite as () => void)(); // a writable member is a union's or an intersection's, which says what writing does
    values.set(name, builder);
  };
  return makeRecordBuilder(held as RecordSchema, isRecordData(value) ? value : null, store, attach, parent);
}

// --- Data instances ---

/** A proxy instance: a read-only `Visitors.OfObject`, whose properties and adjacencies are members. */
class _ObjectData extends Shelled {
  readonly [TYPE_NAME] = "_ObjectData";
  readonly _id = ++nextIdentity;
  readonly _ownValues: Values = new Map();
  /** The entries linking this object, by relation and key. */
  readonly _adjacent = new Map<RelationSchema, Map<string, unknown>>();

  /** Its property values, as the transaction open sees them. */
  get _values(): Values {
    return valuesOf(this);
  }

  constructor(readonly _store: _Store, readonly _schema: ObjectSchema, readonly _schemaName: string) {
    super();
  }

  override _declares(name: string): boolean {
    return this._schema.properties.has(name) || this._schema.adjacencies.has(name);
  }

  override _member(name: string): unknown {
    return member(this._proxy, name);
  }

  override _readOnly(): string {
    return "proxy properties are read-only; use a builder";
  }

  _call(_spec: unknown): never {
    throw new ReadOnlyError("a data instance is read-only; write through a builder");
  }

  override _repr(): string {
    return `<${this._schemaName}>`;
  }

  as_schema(): ObjectSchema {
    return this._schema;
  }

  get as_properties(): any {
    return propertiesOf(this._proxy, this._values, this._schema, this._store, false);
  }

  as_adjacencies(cb: unknown): any {
    for (const name of this._schema.adjacencies.keys()) visit(cb, member(this._proxy, name));
    return this._proxy;
  }
}

function makeObjectData(store: _Store, schema: ObjectSchema, schemaName: string): Instance {
  const state = new _ObjectData(store, schema, schemaName);
  return shell(state, (spec) => state._call(spec));
}

function isObjectData(value: unknown): boolean {
  return innerOf(value) instanceof _ObjectData;
}

/** A value object: the value of a property whose schema is an `OfObject`, a read-only `Visitors.OfObject`; or a union
 * or intersection value, a read-only `Visitors.OfUnion` or `Visitors.OfIntersection`, whose branches or parts are
 * members giving the visitor of their own schema's kind. It belongs to one owner and has no identity of its own; nothing
 * links it, so it has no adjacencies. */
class _RecordData extends Shelled {
  readonly [TYPE_NAME] = "_RecordData";
  readonly _id = ++nextIdentity;
  readonly _ownValues: Values;
  _owner: unknown = null;

  constructor(readonly _schema: RecordSchema, values: Values, readonly _source: unknown = null,
    readonly _copyOf: unknown = null) {
    super();
    this._ownValues = new Map(values);
  }

  /** Its values, as the transaction open sees them. */
  get _values(): Values {
    return valuesOf(this);
  }

  override _declares(name: string): boolean {
    return this._schema.properties.has(name) || owningPart(this._schema, name) !== null;
  }

  override _member(name: string): unknown {
    return member(this._proxy, name);
  }

  override _readOnly(): string {
    return `${noun(this._schema)}s are read-only; use a builder`;
  }

  _call(_spec: unknown): never {
    throw new ReadOnlyError(`${withArticle(noun(this._schema))} is read-only; write through a builder`);
  }

  override _repr(): string {
    return `<${noun(this._schema)}>`;
  }

  as_schema(): RecordSchema {
    return this._schema;
  }

  get as_properties(): any {
    return propertiesOf(this._proxy, this._values, this._schema, storeOf(this._proxy), false);
  }

  as_adjacencies(_cb: unknown): any {
    return this._proxy; // a value object has none
  }
}

function makeRecordData(schema: RecordSchema, values: Values, source: unknown = null, copyOf: unknown = null): ValueObject {
  const state = new _RecordData(schema, values, source, copyOf);
  return shell(state, (spec) => state._call(spec));
}

function isRecordData(value: unknown): boolean {
  return innerOf(value) instanceof _RecordData;
}

/** A data instance's or a value object's member, read-only: a property, or a union's branch or an intersection's part,
 * the visitor of its schema's kind; a flat intersection's part's property, as its own; or an adjacency. */
function member(owner: unknown, name: string): unknown {
  const state = innerOf(owner);
  const schema: RecordSchema = state._schema;
  const values: Values = state._values;
  const store = storeOf(owner);
  if ((schema instanceof Schemas.OfUnion.Data || schema instanceof Schemas.OfIntersection.Data) && schema.properties.has(name)) {
    const kind = schema instanceof Schemas.OfUnion.Data ? "branch" : "part";
    const held = (schema.properties.get(name) as Schemas.OfProperty.Data).schema;
    return kindVisitor(values, name, held, store, owner, false, `${kind} ${repr(name)}`);
  }
  const prop = schema.properties.get(name);
  if (prop !== undefined) return makeProperty(values, name, prop, store, owner, false);
  const part = owningPart(schema, name);
  if (part !== null) {
    const held = values.get(part);
    return isRecordData(held) ? member(held, name) : makeEmpty(`part ${repr(part)} is not set`);
  }
  if (schema instanceof Schemas.OfUnion.Data && schema.flat) { // a flat union's value reads as its branch's
    const held = values.values().next().value;
    return isRecordData(held) ? member(held, name) : makeEmpty(`${repr(name)} is not a member of the branch held`);
  }
  const adjacency = schema instanceof Schemas.OfObject.Data ? schema.adjacencies.get(name) : undefined;
  if (adjacency !== undefined) {
    return makeAdjacency(linking(adjacency.relation as RelationSchema, adjacency.me, owner), adjacency, owner);
  }
  return makeEmpty(`${repr(name)} is not a member of ${withArticle(noun(schema))}`);
}

/** The value an instance or a value object holds in its property `name` (a union's branch, an intersection's part), as
 * a store reads it: a scalar, or a value object; a flat intersection's part's property too, as its own. */
function read(value: unknown, name: string): unknown {
  const state = innerOf(value);
  const values: Values = state._values;
  const schema: RecordSchema = state._schema;
  if (schema.properties.has(name)) return values.has(name) ? values.get(name) : null;
  const part = owningPart(schema, name);
  if (part !== null) return values.has(part) ? read(values.get(part), name) : null;
  throw new AttributeError(name);
}

/** An adjacency of a data instance, a read-only `Visitors.OfAdjacency`: the frozen array of its entries, in the order
 * they were added. `project(name)` gives each entry's link or property `name`, in order, and `at(key)` the entry with
 * the key its relation declares (`Schemas.OfRelation.Data.key`). */
class _Adjacency extends Array<any> implements Shellable {
  static override get [Symbol.species](): ArrayConstructor {
    return Array; // what `map` and `filter` make is a plain array
  }

  readonly [TYPE_NAME] = "_Adjacency";
  _proxy: any;
  _schema!: AdjacencySchema;
  _owner: unknown;

  _member(_name: string): unknown {
    return undefined;
  }

  _declares(_name: string): boolean {
    return false;
  }

  _readOnly(): string {
    return "a data instance's adjacency is read-only; write through a builder";
  }

  [REPR](): string {
    return `<adjacency ${this._schema.name}>`;
  }

  as_schema(): AdjacencySchema {
    return this._schema;
  }

  as_iterable(cb: unknown): any {
    visit(cb, [...this][Symbol.iterator]());
    return this._proxy;
  }

  insert(_spec: unknown): never {
    throw new ReadOnlyError("a data instance's adjacency is read-only; write through a builder");
  }

  remove(spec: unknown): never {
    return this.insert(spec);
  }

  /** Called with keys (an object), a lookup: the object the entry with those keys links through the
   * relation's other link (docs/OBJECT_IDENTITY.md, Decided, 26 to 28); `LookupError` where no entry has them. Called
   * with a callback, it visits through it. */
  _call(spec: unknown): unknown {
    if (spec !== null && typeof spec === "object" && Object.getPrototypeOf(spec) === Object.prototype) {
      return this._lookup(new Map(Object.entries(spec)));
    }
    if (!isFunction(spec)) this.insert(spec);
    visit(spec, this._proxy);
    return this._owner;
  }

  _lookup(keys: Map<string, unknown>): unknown {
    const relation = this._schema.relation as RelationSchema;
    const others = [...relation.entry.links.keys()].filter((link) => link !== this._schema.me);
    if (others.length !== 1) throw new TypeError(`a lookup through ${repr(this._schema.name)} needs a relation of two links`);
    const unknown = [...keys.keys()].filter((name) => !relation.entry.properties.has(name));
    if (unknown.length > 0) throw new KeyError(`${repr(unknown[0])} is not a property of ${repr(relation.name)}`);
    for (const entry of this) { // an entry without a key's value has none of its keys
      const state: _Entry = innerOf(entry);
      const agrees = [...keys].every(([name, value]) => state._properties.has(name)
        && scalarKey(view(state._properties.get(name), (relation.entry.properties.get(name) as Schemas.OfProperty.Data).schema)) === scalarKey(value));
      if (agrees) return state._links.get(others[0]!);
    }
    throw new LookupError(`no entry of ${repr(this._schema.name)} has the keys ${repr(keys)}`);
  }

  /** Each entry's link or property `name`, in order; null for a property an entry does not set. */
  project(name: string): readonly unknown[] {
    const entry = (this._schema.relation as RelationSchema).entry;
    if (!entry.links.has(name) && !entry.properties.has(name)) {
      throw new KeyError(`${repr(name)} is not a link or property of the relation`);
    }
    return Object.freeze([...this].map((held) => {
      const state: _Entry = innerOf(held);
      if (entry.links.has(name)) return state._links.get(name);
      return view(state._properties.has(name) ? state._properties.get(name) : null,
        (entry.properties.get(name) as Schemas.OfProperty.Data).schema);
    }));
  }

  /** The entry whose key is `key`: one value for a key of one link or property, else an array of them in declaration
   * order. `KeyError` for none, `TypeError` when the relation declares no key from this end. */
  override at(key: unknown): any {
    const relation = this._schema.relation as RelationSchema;
    const names = relation.key(this._schema.me);
    if (names === null) throw new TypeError("the relation declares no key from this end; index by position");
    const wanted = names.length > 1 ? key : [key];
    if (!Array.isArray(wanted) || wanted.length !== names.length) {
      throw new KeyError(`a key of ${repr(names)} is a tuple of ${names.length} values, got ${repr(key)}`);
    }
    const { links, properties } = relation.entry;
    for (const entry of this) {
      const state: _Entry = innerOf(entry);
      const held: unknown[] = names.map((name): unknown => links.has(name) ? state._links.get(name)
        : view(state._properties.has(name) ? state._properties.get(name) : null, (properties.get(name) as Schemas.OfProperty.Data).schema));
      if (names.every((name, i) => links.has(name) ? held[i] === wanted[i]
        : held[i] !== null && scalarKey(held[i]) === scalarKey(wanted[i]))) return entry; // a target by identity, a value by schema equality
    }
    throw new KeyError(`no entry has the key ${repr(Array.isArray(key) ? new Tuple(key) : key)}`);
  }
}

function makeAdjacency(entries: readonly unknown[], schema: AdjacencySchema, owner: unknown): any {
  const state = new _Adjacency();
  state.push(...entries);
  state._schema = schema;
  state._owner = owner;
  const proxy = shell(state, (spec) => state._call(spec), true);
  Object.freeze(state);
  return proxy;
}

/** An entry's links other than `me`, and its properties: a placed entry's, or an entry builder's. */
function entryParts(entry: any, me: string): [Map<string, unknown>, Values] {
  const state = innerOf(entry);
  if (state instanceof _Entry) {
    return [new Map([...state._links].filter(([name]) => name !== me)), state._properties];
  }
  return [new Map(state._links), finalized(state._values)];
}

function sameKeys(a: Map<string, unknown>, b: Map<string, unknown>): boolean {
  return a.size === b.size && [...a.keys()].every((name) => b.has(name));
}

/** Whether an entry agrees with a query Spec: equal to its value form (an entry), or agreeing with every link and
 * property its function form, a template, sets. */
function agrees(entry: unknown, spec: unknown, adjacency: AdjacencySchema, store: _Store | null): boolean {
  const [links, values] = entryParts(entry, adjacency.me);
  let wantedLinks: Map<string, unknown>;
  let wantedValues: Values;
  if (isFunction(spec)) {
    const template = makeEntryBuilder(adjacency.relation as RelationSchema, adjacency.me, store);
    visit(spec, template);
    wantedLinks = innerOf(template)._links;
    wantedValues = finalized(innerOf(template)._values); // value objects built
  } else {
    [wantedLinks, wantedValues] = entryParts(spec, adjacency.me);
    if (!sameKeys(wantedLinks, links) || !sameKeys(wantedValues, values)) return false;
  }
  return [...wantedLinks].every(([name, target]) => links.get(name) === target)
    && [...wantedValues].every(([name, value]) => values.has(name) && scalarKey(values.get(name)) === scalarKey(value));
}

/** A value as `project` and `at` read it: a flat union's value as its branch's value. */
function view(value: unknown, schema: unknown): unknown {
  if (!(schema instanceof Schemas.OfUnion.Data && schema.flat && isRecordData(value) && innerOf(value)._values.size > 0)) {
    return value;
  }
  const [branch, held] = (innerOf(value)._values as Values).entries().next().value as [string, unknown];
  return view(held, (schema.properties.get(branch) as Schemas.OfProperty.Data).schema);
}

/** The part of a flat intersection whose object schema declares the property `name`, if any. */
function owningPart(schema: RecordSchema, name: string): string | null {
  if (!(schema instanceof Schemas.OfIntersection.Data && schema.flat)) return null;
  const found = schema.parts.find((part) => (part.schema as ObjectSchema).properties.has(name));
  return found === undefined ? null : found.name;
}

/** What tells a value apart at run time, as `Schemas` tells a flat union's branches apart: a scalar's host type, or a value
 * object's schema. */
function runtime(value: unknown): unknown {
  if (isRecordData(value) || isRecordBuilder(value)) return innerOf(value)._schema;
  return Schemas.SCALAR_TYPES.find((host) => Schemas.isScalarOf(host, value));
}

/** The branch of a flat union whose schema a value has. */
function branchOf(name: string, schema: Schemas.OfUnion.Data, value: unknown): Schemas.OfUnion.Branch {
  const found = schema.branches.find((branch) => Schemas._runtime(branch.schema) === runtime(value));
  if (found === undefined) {
    throw new TypeError(`property ${repr(name)}: a ${typeName(value)} is not a value of any branch of the flat union`);
  }
  return found;
}

/** What a record of `schema` is, for messages. */
function noun(schema: unknown): string {
  if (schema instanceof Schemas.OfUnion.Data) return "union value";
  if (schema instanceof Schemas.OfIntersection.Data) return "intersection value";
  return schema instanceof Schemas.OfContainer.Data ? "container" : "value object";
}

function withArticle(noun: string): string {
  return noun === "intersection value" ? `an ${noun}` : `a ${noun}`;
}

// --- Value objects: staging, copying, placing ---

/** Prepares `value` to be placed where `old` was: a value object owned elsewhere is copied, and `mapping` records, for
 * each value object copied or edited, the one that takes its place, so that the entries among them link those. */
/** What a container's element `value` takes the place of, in the container `old`: the value object it is, or edits,
 * where `old` holds that one (an element may have moved), else the element at its key. */
function prior(old: unknown, key: string, value: unknown): unknown {
  if (!isContainerData(old)) return null;
  const held = new Set((innerOf(old)._items as Values).values());
  for (const candidate of [value, isRecordData(value) ? innerOf(value)._source : null]) {
    if (candidate !== null && held.has(candidate)) return candidate;
  }
  return (innerOf(old)._items as Values).get(key) ?? null;
}

function stage(old: unknown, value: unknown, mapping: Mapping): unknown {
  if (isContainerData(value) && value !== old) {
    const state: _ContainerData = innerOf(value);
    const items: Values = new Map([...state._items].map(([key, item]) => [key, stage(prior(old, key, item), item, mapping)] as const));
    return makeContainerData(state._schema, items, new Map(state._indices));
  }
  if (!isRecordData(value) || value === old) return value;
  let state: _RecordData = innerOf(value);
  if (state._source !== null && state._source === old) { // an edit of `old`, which keeps its identity
    mapping.set(old, old);
    stageValues(value, old, mapping);
    return value;
  }
  let staged = value;
  if (state._owner !== null) {
    staged = copy(value);
    state = innerOf(staged);
  }
  for (const original of [state._copyOf, state._source]) if (original !== null) mapping.set(original, staged);
  stageValues(staged, null, mapping);
  return staged;
}

/** Stages the value objects a value object holds in its properties. */
function stageValues(record: unknown, old: unknown, mapping: Mapping): void {
  const state: _RecordData = innerOf(record);
  const held: Values = old === null ? new Map() : innerOf(old)._values;
  const values = writableValues(state);
  for (const [name, value] of [...values]) values.set(name, stage(held.get(name), value, mapping));
}

/** A copy of a placed value object, with copies of the value objects it holds. */
function copy(record: unknown): unknown {
  const state: _RecordData = innerOf(record);
  const builder = new _RecordBuilder(state._schema, null, storeOf(record));
  shell(builder);
  builder._copyOf = record;
  builder._values = new Map([...state._values].map(([name, value]) => [name, copyHeld(value)]));
  return builder.build();
}

/** A copy of a held value: of a value object, or of a container and the value objects it holds. */
function copyHeld(value: unknown): unknown {
  if (isRecordData(value)) return copy(value);
  if (isContainerData(value)) {
    const state: _ContainerData = innerOf(value);
    return makeContainerData(state._schema, new Map([...state._items].map(([key, item]) => [key, copyHeld(item)])), new Map(state._indices));
  }
  return value;
}

/** Places a staged value: an edit is merged into `old`, and a value object built for it is adopted by `owner`, as those
 * a container holds are. */
function finish(owner: unknown, old: unknown, value: unknown, mapping: Mapping): unknown {
  if (isContainerData(value) && value !== old) {
    const items: Values = innerOf(value)._items;
    for (const [key, item] of [...items]) items.set(key, finish(owner, prior(old, key, item), item, mapping));
    return value;
  }
  if (!isRecordData(value) || value === old) return value;
  const state: _RecordData = innerOf(value);
  if (state._source !== null && state._source === old) {
    merge(old, value, mapping);
    return old;
  }
  state._owner = owner;
  const values = writableValues(state);
  for (const [name, held] of [...values]) values.set(name, finish(value, null, held, mapping));
  return value;
}

/** Writes an edit of a placed value object into it, so that it is the one its owner holds. */
function merge(old: unknown, edit: unknown, mapping: Mapping): void {
  const target: _RecordData = innerOf(old);
  const values = new Map([...innerOf(edit)._values as Values].map(([name, value]) =>
    [name, finish(old, target._values.get(name), value, mapping)] as const));
  const held = writableValues(target);
  held.clear();
  for (const [name, value] of values) held.set(name, value);
}

/** Whether an entry builder adds its entry: an entry rewritten from one already held (`_source`), linking the same
 * objects, is added once in one build, though every object it links gives it, which in an open relation would
 * otherwise add it again. */
function firstCopy(relation: RelationSchema, builder: _EntryBuilder, target: unknown, mapping: Mapping): boolean {
  const source = builder._source;
  if (source === null || !relation.open) return true;
  const links = new Map<string, unknown>([...builder._links, [builder._me, target]]);
  const identities = [...links].map(([name, linked]) => [name, innerOf(linked)?._id ?? `schema ${_numberOf(linked as object)}`] as const)
    .sort(byName); // a schema object an extension's relation links is not a proxy
  const key = `entry:${innerOf(source)._id}:${JSON.stringify(identities)}`;
  if (mapping.has(key)) return false;
  mapping.set(key, source);
  return true;
}

// --- Builders ---

/** A value as a builder finalizes it: a value object's builder, built; a union value without a branch, none. */
function built(value: unknown): unknown {
  if (isRecordBuilder(value)) {
    const state: _RecordBuilder = innerOf(value);
    return state._schema instanceof Schemas.OfUnion.Data && state._values.size === 0 ? null : state.build();
  }
  if (isContainerBuilder(value)) return innerOf(value).build();
  return value;
}

/** Values as a builder finalizes them, a union value without a branch left out. */
function finalized(values: Values): Values {
  const out: Values = new Map();
  for (const [name, value] of values) {
    const done = built(value);
    if (done !== null && done !== undefined) out.set(name, done);
  }
  return out;
}

/** A writable `Visitors.OfObject` building a value object, starting from `source` if given; or a writable
 * `Visitors.OfUnion` or `Visitors.OfIntersection`, whose branches or parts are members giving the visitor of their own
 * schema's kind. It attaches itself to what holds it (`attach`) when first written, so that an unwritten builder changes
 * nothing. Writing a union's branch clears any other. */
class _RecordBuilder extends Shelled {
  readonly [TYPE_NAME] = "_RecordBuilder";
  _values: Values;
  _copyOf: unknown = null;

  constructor(readonly _schema: RecordSchema, readonly _source: unknown = null, readonly _store: _Store | null = null,
    public _attach: ((builder: unknown) => void) | null = null, readonly _parent: unknown = null) {
    super();
    this._values = new Map(_source === null ? [] : innerOf(_source)._values);
  }

  /** Attaches the builder to what holds it, once, at its first write. */
  _touch(): void {
    if (this._attach !== null) {
      const attach = this._attach;
      this._attach = null;
      attach(this._proxy);
    }
  }

  /** What writing the member `name` does first: for a union's branch, clearing any other branch. */
  _select(name: string): () => void {
    return () => {
      if (this._schema instanceof Schemas.OfUnion.Data) {
        for (const other of [...this._values.keys()]) if (other !== name) this._values.delete(other);
      }
      this._touch();
    };
  }

  as_schema(): RecordSchema {
    return this._schema;
  }

  get as_properties(): any {
    return propertiesOf(this._proxy, this._values, this._schema, this._store, true, () => this._touch());
  }

  as_adjacencies(_cb: unknown): any {
    return this._proxy; // a value object has none
  }

  override _declares(name: string): boolean {
    return this._schema.properties.has(name) || owningPart(this._schema, name) !== null;
  }

  override _member(name: string): unknown {
    const schema = this._schema;
    if ((schema instanceof Schemas.OfUnion.Data || schema instanceof Schemas.OfIntersection.Data) && schema.properties.has(name)) {
      const kind = schema instanceof Schemas.OfUnion.Data ? "branch" : "part";
      return kindVisitor(this._values, name, (schema.properties.get(name) as Schemas.OfProperty.Data).schema, this._store,
        this._proxy, true, `${kind} ${repr(name)}`, this._select(name));
    }
    const prop = schema.properties.get(name);
    if (prop !== undefined) return makeProperty(this._values, name, prop, this._store, this._proxy, true, () => this._touch());
    const part = owningPart(schema, name);
    if (part !== null) { // a flat intersection's part's property: written in that part, a member of this value
      const found = innerOf(this._member(part))._member(name);
      innerOf(found)._parent = this._proxy;
      return found;
    }
    return makeEmpty(`${repr(name)} is not a member of ${withArticle(noun(schema))}`);
  }

  /** As a union's branch or an intersection's part: writes through a Spec, selecting the branch. */
  _call(spec: unknown): unknown {
    if (isFunction(spec)) {
      this._touch();
      visit(spec, this._proxy);
    } else {
      if (!isRecordData(spec) || innerOf(spec)._schema !== this._schema) {
        throw new TypeError(`${withArticle(noun(this._schema))} or a Spec is expected, got ${typeName(spec)}`);
      }
      this._values = new Map(innerOf(spec)._values);
      this._copyOf = spec;
      this._touch();
    }
    return this._parent;
  }

  override _repr(): string {
    return `<builder of a ${noun(this._schema)}>`;
  }

  build(): ValueObject {
    return makeRecordData(this._schema, finalized(this._values), this._source, this._copyOf);
  }

  /** A standalone value's value, to assign (see `_Store.builder`). */
  create(): ValueObject {
    return this.build();
  }
}

function makeRecordBuilder(schema: RecordSchema, source: unknown = null, store: _Store | null = null,
  attach: ((builder: unknown) => void) | null = null, parent: unknown = null): any {
  const state = new _RecordBuilder(schema, source, store, attach, parent);
  return shell(state, (spec) => state._call(spec));
}

function isRecordBuilder(value: unknown): boolean {
  return innerOf(value) instanceof _RecordBuilder;
}

/** A writable `Visitors.OfAdjacency` over one adjacency of an object's builder: iterated, its entries' builders. */
/** Whether a link holds a builder, finalized when the entry is: a proxy's, or a schema object's (a meta-schema's). */
function isBuilder(value: unknown): boolean {
  const inner = innerOf(value);
  return inner !== undefined && typeof inner.create === "function" && typeof inner.update === "function";
}

/** A builder of an object of the schema registered as `name`, new or `target` updated: a meta-schema's builder for a
 * schema object (docs/OBJECT_IDENTITY.md, Decided, 97), else a proxy's. */
function builderOf(store: any, name: string, target: unknown = undefined): any {
  const built = store._meta_builder(name, target ?? null);
  return built ?? makeObjectBuilder(store, store.schema(name), name, target as Instance | undefined);
}

/** The registered name of a linked object's schema: a proxy's, or a schema object's meta-schema's. */
function schemaNameOf(store: any, target: unknown): string {
  if (isObjectData(target)) return innerOf(target)._schemaName;
  const builderClass = store._meta_builder_class(target);
  return store.name_of(new builderClass(target, false, store).as_schema());
}

/** The kinds a link may link, by branch name, where its schema is a kind union. */
export function _linkKinds(relation: RelationSchema, link: string): Map<string, ObjectSchema> | null {
  return Schemas._kinds((relation.entry.links.get(link) as Schemas.OfSymbol.Data).schema);
}

/** The schema of what `value` is, where it is an object a link may link: a proxy's schema, a schema object's
 * meta-schema, or the schema of the object a spec's visitor records; null for a value. */
export function _schemaOf(store: any, value: unknown): any {
  const inner = innerOf(value);
  if (inner !== undefined && "_linkedSchema" in inner) return inner._linkedSchema; // a spec's visitor (Transactions)
  value = _deref(value);
  if (isObjectData(value)) return innerOf(value)._schema;
  if (store.holds(value)) return new (store._meta_builder_class(value))(value, false, store).as_schema();
  return null;
}

/** Whether `link` of `relation` may link `value`: an object of the link's schema, of a kind of its kind union, or of a
 * schema declaring an adjacency that fills it. */
export function _links(store: any, relation: RelationSchema, link: string, value: unknown): boolean {
  const schema = _schemaOf(store, value);
  if (schema === null) return false;
  const declared = (relation.entry.links.get(link) as Schemas.OfSymbol.Data).schema;
  const kinds = Schemas._kinds(declared);
  if (kinds !== null) return [...kinds.values()].some((kind) => Schemas.is_a(schema, kind));
  if (declared !== null) return Schemas.is_a(schema, declared);
  return store._filling(relation, link).some((name: string) => Schemas.is_a(schema, store.registered(name)));
}

/** Whether an adjacency's entries may link `value` at their other link. */
export function _linksThrough(store: any, adjacency: AdjacencySchema, value: unknown): boolean {
  const relation = adjacency.relation as RelationSchema | null;
  const others = relation !== null ? [...relation.entry.links.keys()].filter((link) => link !== adjacency.me) : [];
  return others.length === 1 && _links(store, relation as RelationSchema, others[0] as string, value);
}

/** Whether a property of `schema` holds `value` as given: a scalar of its scalar's host type. */
export function _holds(schema: unknown, value: unknown): boolean {
  return schema instanceof Schemas.OfScalar.Data && schema.type !== null && Schemas.isScalarOf(schema.type, value);
}

/** Gives a keyed mapping's value to the peer shorthand's visitor of one entry, its key written (FRAMEWORK.md, Resolved,
 * Mappings for keyed adjacencies): a callback is called with it; any other value goes to the one member that accepts
 * it, the entry's link (`linkTakes`) or one of the linked object's properties and adjacencies (`members`, each a name,
 * and whether it is an adjacency and takes the value). */
export function _given(them: any, value: unknown, link: string, linkTakes: boolean,
  members: [string, boolean, boolean][]): void {
  if (isFunction(value)) {
    visit(value, them);
    return;
  }
  const takers: [string, boolean][] = linkTakes ? [[link, false]] : [];
  for (const [name, adjacency, takes] of members) if (takes) takers.push([name, adjacency]);
  if (takers.length !== 1) {
    throw new TypeError(`${takers.length === 0 ? "no member" : "more than one member"} of the entry takes ${repr(value)}: `
      + "give a callback");
  }
  const [name, adjacency] = takers[0] as [string, boolean];
  them[name](adjacency ? [value] : value);
}

class _AdjacencyBuilder extends Shelled {
  readonly [TYPE_NAME] = "_AdjacencyBuilder";
  readonly _schema: AdjacencySchema;

  constructor(readonly _builder: unknown, readonly _name: string) {
    super();
    this._schema = (innerOf(_builder)._schema as ObjectSchema).adjacencies.get(_name) as AdjacencySchema;
  }

  _entries(): any[] {
    return innerOf(this._builder)._entries.get(this._name) ?? [];
  }

  as_schema(): AdjacencySchema {
    return this._schema;
  }

  [Symbol.iterator](): Iterator<unknown> {
    return [...this._entries()][Symbol.iterator]();
  }

  as_iterable(cb: unknown): any {
    visit(cb, [...this._entries()][Symbol.iterator]());
    return this._proxy;
  }

  insert(spec: unknown): any {
    const builder = innerOf(this._builder);
    const entry = makeEntryBuilder(this._schema.relation as RelationSchema, this._schema.me, builder._store);
    if (isFunction(spec)) {
      visit(spec, entry);
    } else {
      const [links, values] = entryParts(spec, this._schema.me);
      innerOf(entry)._links = new Map(links);
      innerOf(entry)._values = new Map(values);
    }
    builder._entries.set(this._name, [...(builder._entries.get(this._name) ?? []), entry]);
    return this._proxy;
  }

  remove(spec: unknown): any {
    const builder = innerOf(this._builder);
    const kept = this._entries().filter((entry) => !agrees(entry, spec, this._schema, builder._store));
    builder._entries.set(this._name, kept);
    return this._proxy;
  }

  /** Called with a callback, it visits through it. Called with an iterable, a shorthand, each item inserted, or
   * replacing the entry held where the relation allows one only from this end: an entry (the entry shorthand), or,
   * where the relation has two links (the peer shorthand), the object to link, or a function handed `_Them`, through
   * which it sets the entry's properties, its link, and the linked object's members. */
  _call(spec: unknown): unknown {
    if (isFunction(spec)) {
      visit(spec, this._proxy);
      return this._builder;
    }
    const items = _mapping(spec);
    if (items !== null) spec = this._keyed(items);
    if (typeof spec === "string" || isBytes(spec) || !isIterable(spec)) {
      throw new TypeError(`adjacency ${repr(this._name)} takes an iterable of entries or of what it links, a mapping, or a `
        + `callback taking the adjacency; got ${repr(spec)}`);
    }
    const relation = this._schema.relation as RelationSchema;
    const others = [...relation.entry.links.keys()].filter((link) => link !== this._schema.me);
    for (const item of spec) {
      let entry: unknown;
      if (innerOf(item) instanceof _Entry || innerOf(item) instanceof _EntryBuilder) {
        entry = item;
      } else if (others.length !== 1) {
        throw new TypeError(`adjacency ${repr(this._name)}: entries of ${relation.name || "its relation"} have more than `
          + "two links; give entries");
      } else if (isFunction(item)) {
        const them = new _Them(this, others[0] as string);
        visit(item, shell(them));
        entry = them._entryBuilder();
      } else {
        entry = makeEntryBuilder(relation, this._schema.me, innerOf(this._builder)._store);
        (entry as any)[others[0] as string](item);
      }
      if (single(relation, this._schema.me)) innerOf(this._builder)._entries.set(this._name, []);
      this.insert(entry);
    }
    return this._builder;
  }

  /** A mapping, as the peer shorthand: each item an entry, its key the value of the relation's one property, its value
   * given to the entry (FRAMEWORK.md, Resolved, Mappings for keyed adjacencies). */
  _keyed(items: [unknown, unknown][]): unknown[] {
    const relation = this._schema.relation as RelationSchema;
    const store: any = innerOf(this._builder)._store;
    const keys = [...relation.entry.properties.keys()];
    if (relation.entry.links.size !== 2 || keys.length !== 1) {
      throw new TypeError(`adjacency ${repr(this._name)} takes a mapping only where its relation has two links and one `
        + "property");
    }
    const other = [...relation.entry.links.keys()].find((link) => link !== this._schema.me) as string;
    return items.map(([key, value]) => (them: any) => {
      them[keys[0] as string](key);
      if (isFunction(value)) {
        visit(value, them);
        return;
      }
      const given = _deref(value);
      const schema = _linkKinds(relation, other) !== null ? null : store.registered(store._filled(relation, other));
      const members: [string, boolean, boolean][] = schema === null ? [] : [
        ...[...schema.properties].map(([name, prop]: [string, any]): [string, boolean, boolean] => [name, false, _holds(prop.schema, given)]),
        ...[...schema.adjacencies].map(([name, adjacency]: [string, any]): [string, boolean, boolean] =>
          [name, true, _linksThrough(store, adjacency, given)]),
      ];
      _given(them, given, other, _links(store, relation, other, given), members);
    });
  }

  override _repr(): string {
    return `<adjacency builder ${this._name}>`;
  }
}



/** Whether an object holds one entry of `relation` at most from its link `me`: a `unique` clause makes `me` determine
 * every other link and property. */
function single(relation: RelationSchema, me: string): boolean {
  const names = [...relation.entry.links.keys(), ...relation.entry.properties.keys()];
  return relation.uniques.some((unique) => {
    const rest = names.filter((name) => !unique.has(name));
    return rest.length === 1 && rest[0] === me;
  });
}

/** `OfThem.Visitor`, for one item of the peer shorthand: an entry of a relation of two links, and the object it links
 * (them). Its members are the entry's properties, its link (to link an object that exists), and the members of the
 * object it links, written through that object's builder: a new one, or, where the link is set, that one, updated.
 * Each, called, returns the visitor. */
class _Them extends Shelled {
  readonly [TYPE_NAME] = "_Them";
  readonly _entry: any;
  _object: any = null;

  constructor(readonly _adjacency: _AdjacencyBuilder, readonly _other: string) {
    super();
    this._entry = makeEntryBuilder(_adjacency._schema.relation as RelationSchema, _adjacency._schema.me,
      innerOf(_adjacency._builder)._store);
  }

  as_schema(): Schemas.OfEntry.Data {
    return this._entry.as_schema();
  }

  _builder(): any {
    if (this._object === null) {
      const entry: _EntryBuilder = innerOf(this._entry);
      const store = entry._store as _Store;
      const target = entry._links.get(this._other);
      if (isBuilder(target)) {
        this._object = target;
      } else {
        const kinds = _linkKinds(entry._relation, this._other);
        if (kinds !== null && target === undefined) {
          throw new TypeError(`link ${repr(this._other)} is a kind union: build through one of its kinds, `
            + [...kinds.keys()].join(", "));
        }
        const name = target === undefined ? store._filled(entry._relation, this._other) : schemaNameOf(store, target);
        this._object = builderOf(store, name, target);
      }
    }
    return this._object;
  }

  override _member(name: string): unknown {
    const entry: _EntryBuilder = innerOf(this._entry);
    if (name === this._other || entry._relation.entry.properties.has(name)) {
      return makeChained(this._entry[name], this, name === this._other);
    }
    const kind = _linkKinds(entry._relation, this._other)?.get(name);
    if (kind !== undefined) return makeChained(makeKindMember(entry, this._other, kind), this, true);
    return makeChained(this._builder()[name], this, false);
  }

  /** The entry: linking the object given, updated where its members were written, or the one built. */
  _entryBuilder(): any {
    const entry: _EntryBuilder = innerOf(this._entry);
    const builder = this._object;
    const target = entry._links.get(this._other);
    if (builder !== null && builder !== target && !isBuilder(target)) {
      if (target === undefined) entry._links.set(this._other, builder);
      else builder.update();
    }
    if (!entry._links.has(this._other)) throw new ValueError(`link ${repr(this._other)} is not set`);
    return this._entry;
  }
}

/** A member read through `_Them`: read as the member itself; called, it writes through the member and returns the
 * `_Them` visitor, so that an item's clauses chain. */
class _Chained extends Shelled {
  readonly [TYPE_NAME] = "_Chained";

  constructor(readonly _wrapped: any, readonly _them: _Them, readonly _link: boolean) {
    super();
  }

  override _member(name: string): unknown {
    return this._wrapped[name];
  }

  _call(spec: unknown): unknown {
    if (this._link && this._them._object !== null) throw new ValueError("link the object before writing its members");
    this._wrapped(spec);
    return this._them._proxy;
  }
}

function makeChained(member: unknown, them: _Them, link: boolean): any {
  const state = new _Chained(member, them, link);
  return shell(state, (spec) => state._call(spec));
}

function makeAdjacencyBuilder(builder: unknown, name: string): any {
  const state = new _AdjacencyBuilder(builder, name);
  return shell(state, (spec) => state._call(spec));
}

/** An entry builder's link: read, the linked object, read-only (an object is edited through its own builder); called
 * with a Spec, it relinks: to an instance given, or to one created through the builder a function is given. */
class _LinkMember extends Shelled {
  readonly [TYPE_NAME] = "_LinkMember";

  constructor(readonly _entry: _EntryBuilder, readonly _name: string) {
    super();
  }

  _target(): any {
    const target = this._entry._links.get(this._name);
    if (isBuilder(target)) return makeEmpty("not created yet"); // what an entry builds through its link is created with it
    return target ?? makeEmpty(`link ${repr(this._name)} is not set`);
  }

  as_schema(): unknown {
    return this._target().as_schema();
  }

  get as_properties(): unknown {
    return this._target().as_properties;
  }

  as_adjacencies(cb: unknown): any {
    this._target().as_adjacencies(cb);
    return this._proxy;
  }

  override _declares(name: string): boolean {
    return innerOf(this._target())._declares(name);
  }

  override _member(name: string): unknown {
    return this._target()[name];
  }

  _call(spec: unknown): unknown {
    const entry = this._entry;
    const name = this._name;
    if (isFunction(spec)) {
      const kinds = _linkKinds(entry._relation, name);
      if (kinds !== null) throw new TypeError(`link ${repr(name)} is a kind union: build through one of its kinds, ${[...kinds.keys()].join(", ")}`);
      const store = entry._store as _Store; // a link is a reference object's, built in a store
      const builder = builderOf(store, store._filled(entry._relation, name));
      visit(spec, builder);
      entry._links.set(name, builder);
      return entry._proxy;
    }
    spec = _deref(spec);
    if (innerOf(spec) instanceof _LinkMember) spec = innerOf(spec)._target();
    if (isRecordData(spec)) throw new ReadOnlyError("a link targets a reference object, never a value object");
    const holds = (entry._store as { holds?: (data: unknown) => boolean } | null)?.holds;
    if (!isObjectData(spec) && !(holds !== undefined && holds.call(entry._store, spec))) {
      throw new TypeError("proxies can only link proxy instances, or schema objects their store holds");
    }
    if (isObjectData(spec)) sameStore(entry._store, spec); // else a schema object the store holds, an extension's
    entry._links.set(name, spec);
    return entry._proxy;
  }

  override _repr(): string {
    return `<link ${repr(this._name)}>`;
  }
}

function makeLinkMember(entry: _EntryBuilder, name: string): any {
  const state = new _LinkMember(entry, name);
  return shell(state, (spec) => state._call(spec));
}

/** A kind of a kind union, one of its branches, as an entry builder's member: called with a callback, it builds through
 * the link an object of that kind's schema; called with an object of that kind, it links it. */
class _KindMember extends Shelled {
  readonly [TYPE_NAME] = "_KindMember";

  constructor(readonly _entry: _EntryBuilder, readonly _link: string, readonly _schema: ObjectSchema) {
    super();
  }

  _call(spec: unknown): unknown {
    const entry = this._entry;
    const store: any = entry._store;
    if (!isFunction(spec)) return makeLinkMember(entry, this._link)(spec);
    const builder = builderOf(store, store.name_of(this._schema));
    visit(spec, builder);
    entry._links.set(this._link, builder);
    return entry._proxy;
  }

  override _repr(): string {
    return `<kind of link ${repr(this._link)}>`;
  }
}

function makeKindMember(entry: _EntryBuilder, link: string, schema: ObjectSchema): any {
  const state = new _KindMember(entry, link, schema);
  return shell(state, (spec) => state._call(spec));
}

/** A writable `Visitors.OfEntry` for one entry added through an adjacency: its links are members (`env.phone`,
 * read-only, relinked when called) and so are its properties. The object's own link (`me`) is filled when the
 * object's builder is finalized. */
class _EntryBuilder extends Shelled {
  readonly [TYPE_NAME] = "_EntryBuilder";
  _links = new Map<string, unknown>();
  _values: Values = new Map();
  /** The entry this one rewrites, when copied or loaded from one. */
  _source: unknown = null;

  constructor(readonly _relation: RelationSchema, readonly _me: string, readonly _store: _Store | null = null) {
    super();
  }

  as_schema(): Schemas.OfEntry.Data {
    return this._relation.entry;
  }

  override _declares(name: string): boolean {
    return (this._relation.entry.links.has(name) && name !== this._me) || this._relation.entry.properties.has(name);
  }

  override _member(name: string): unknown {
    if (this._relation.entry.links.has(name) && name !== this._me) return makeLinkMember(this, name);
    const prop = this._relation.entry.properties.get(name);
    if (prop !== undefined) return makeProperty(this._values, name, prop, this._store, this._proxy, true);
    for (const link of this._relation.entry.links.keys()) { // a kind union's kind, built through its link
      const kind = link !== this._me ? _linkKinds(this._relation, link)?.get(name) : undefined;
      if (kind !== undefined) return makeKindMember(this, link, kind);
    }
    return makeEmpty(`${repr(name)} is not a link this entry can set, nor a property of the relation`);
  }

  override _repr(): string {
    return `<entry builder of ${this._relation.name || "a relation"}>`;
  }

  /** The values of the entry this one rewrites, where it links the same `target`: an update keeps them. */
  _kept(target: unknown): Values {
    const source = this._source;
    return source !== null && innerOf(source)._links.get(this._me) === target ? innerOf(source)._properties : new Map();
  }

  /** Stages the value objects the entry holds for `target`, before any is placed (see `stage`). */
  _stage(target: unknown, mapping: Mapping): void {
    const kept = this._kept(target);
    this._values = new Map([...finalized(this._values)].map(([name, value]) => [name, stage(kept.get(name), value, mapping)]));
  }

  /** Places the staged value objects the entry holds as `target`'s. */
  _place(target: unknown, mapping: Mapping): void {
    const kept = this._kept(target);
    this._values = new Map([...this._values].map(([name, value]) => [name, finish(target, kept.get(name), value, mapping)]));
  }

  /** The entry, linking `target`, holding its values as placed. */
  build(target: unknown): any {
    const links = new Map<string, unknown>([[this._me, target]]);
    for (const name of this._relation.entry.links.keys()) {
      if (name === this._me) continue;
      if (!this._links.has(name)) throw new ValueError(`link ${repr(name)} is not set`);
      const value = this._links.get(name);
      links.set(name, isBuilder(value) ? innerOf(value).create() : value);
    }
    return makeEntry(this._relation, links, finalized(this._values));
  }
}

function makeEntryBuilder(relation: RelationSchema, me: string, store: _Store | null = null): any {
  return shell(new _EntryBuilder(relation, me, store));
}

/** Loads the entries linking `source` into a builder, as entry builders, so that an update rewrites them. */
function loadEntries(entries: Map<string, any[]>, schema: ObjectSchema, source: unknown): void {
  const store = storeOf(source);
  for (const [name, adjacency] of schema.adjacencies) {
    for (const entry of linking(adjacency.relation as RelationSchema, adjacency.me, source)) {
      const held: _Entry = innerOf(entry);
      const builder = makeEntryBuilder(adjacency.relation as RelationSchema, adjacency.me, store);
      const state: _EntryBuilder = innerOf(builder);
      state._links = new Map([...held._links].filter(([link]) => link !== adjacency.me));
      state._values = new Map(held._properties);
      state._source = entry;
      entries.set(name, [...(entries.get(name) ?? []), builder]);
    }
  }
}

/** A writable `Visitors.OfObject` building a proxy instance: its properties and adjacencies are members, reading back
 * what has been written. Finalized by `create()`, `clone()` or `update()`; none validate. */
class _ObjectBuilder extends Shelled {
  readonly [TYPE_NAME] = "_ObjectBuilder";
  readonly _values: Values = new Map();
  readonly _entries = new Map<string, any[]>();

  constructor(readonly _store: _Store, readonly _schema: ObjectSchema, readonly _schemaName: string,
    readonly _source: Instance | null = null) {
    super();
  }

  as_schema(): ObjectSchema {
    return this._schema;
  }

  get as_properties(): any {
    return propertiesOf(this._proxy, this._values, this._schema, this._store, true);
  }

  as_adjacencies(cb: unknown): any {
    for (const name of this._schema.adjacencies.keys()) visit(cb, makeAdjacencyBuilder(this._proxy, name));
    return this._proxy;
  }

  override _declares(name: string): boolean {
    return this._schema.properties.has(name) || this._schema.adjacencies.has(name);
  }

  override _member(name: string): unknown {
    const prop = this._schema.properties.get(name);
    if (prop !== undefined) return makeProperty(this._values, name, prop, this._store, this._proxy, true);
    if (this._schema.adjacencies.has(name)) return makeAdjacencyBuilder(this._proxy, name);
    return makeEmpty(`${repr(name)} is not a property or adjacency of ${repr(this._schemaName)}`);
  }

  override _repr(): string {
    return `<builder of ${this._schemaName}>`;
  }

  create(...args: unknown[]): Instance {
    noArguments("create", args);
    if (this._source !== null) throw new ValueError("create() is only valid without a source instance; use clone() or update()");
    this._notSingleton("create");
    return this._store._writing(() => this._write(this._new()));
  }

  clone(...args: unknown[]): Instance {
    noArguments("clone", args);
    if (this._source === null) throw new ValueError("clone() is only valid with a source instance");
    this._notSingleton("clone");
    return this._store._writing(() => this._write(this._new()));
  }

  /** A new object of the builder's schema; one whose schema declares an owner is given it when the outermost write
   * ends, unless it has one by then. */
  _new(): Instance {
    const target = makeObjectData(this._store, this._schema, this._schemaName);
    if (ownerAdjacencies(this._schema).length > 0) this._store._unowned.push(target);
    return target;
  }

  update(...args: unknown[]): Instance {
    noArguments("update", args);
    if (this._source === null) throw new ValueError("update() is only valid with a source instance");
    const rewritten = new Map<unknown, unknown>();
    return this._store._writing(() => { // an owned object whose entry is written again is not orphaned
      const tables = orders(this._schema, this._source);
      for (const adjacency of this._schema.adjacencies.values()) {
        discardLinking(adjacency.relation as RelationSchema, adjacency.me, this._source);
      }
      const written = this._write(this._source!, rewritten);
      reorder(tables, rewritten);
      return written;
    });
  }

  _notSingleton(method: string): void {
    if (this._schema.singleton !== null) {
      throw new ValueError(`${method}() would make a second ${repr(this._schemaName)}; its one instance is `
        + `store.singleton(${repr(this._schema.singleton)})`);
    }
  }

  /** Writes the builder into `target`. Every value object it holds, its entries' too, is staged before any is placed. */
  _write(target: Instance, rewritten?: Map<unknown, unknown>): Instance {
    const state: _ObjectData = innerOf(target);
    const mapping: Mapping = new Map();
    if (this._source !== null && target !== this._source) mapping.set(this._source, target); // a clone: its value objects link it, not the source
    const old = new Map(state._values);
    const staged = new Map([...finalized(this._values)].map(([name, value]) => [name, stage(old.get(name), value, mapping)] as const));
    for (const entries of this._entries.values()) for (const entry of entries) innerOf(entry)._stage(target, mapping);
    const values = new Map([...staged].map(([name, value]) => [name, finish(target, old.get(name), value, mapping)] as const));
    for (const entries of this._entries.values()) for (const entry of entries) innerOf(entry)._place(target, mapping);
    mapping.delete(this._source); // its own entries keep their links (a self-loop links the source)
    const held = writableValues(state);
    held.clear();
    for (const [name, value] of values) held.set(name, value);
    for (const [name, entries] of this._entries) {
      const relation = (this._schema.adjacencies.get(name) as AdjacencySchema).relation as RelationSchema;
      for (const entry of entries) {
        if (!firstCopy(relation, innerOf(entry), target, mapping)) continue;
        const built = innerOf(entry).build(target);
        addEntry(relation, built);
        const source = innerOf(entry)._source;
        if (rewritten !== undefined && source !== null) { // the entry held: a self-loop's is built from each end, and a set keeps one
          rewritten.set(source, table(target, relation).get(innerOf(built)._key()));
        }
      }
    }
    return target;
  }
}

function noArguments(method: string, args: unknown[]): void {
  if (args.length > 0) throw new TypeError(`${method}() takes no arguments (${args.length} given)`);
}

function makeObjectBuilder(store: _Store, schema: ObjectSchema, schemaName: string, instance?: unknown): DynamicBuilder {
  if (!schema.ref) {
    throw new TypeError(`${repr(schemaName)} is a value object schema; build a value through its owner, or standalone `
      + "through the store");
  }
  if (instance !== undefined && instance !== null) {
    if (!isObjectData(instance)) throw new TypeError("a builder's source must be a proxy instance");
    const held: _ObjectData = innerOf(instance);
    if (held._schemaName !== schemaName) {
      throw new TypeError(`instance is a ${repr(held._schemaName)}, not a ${repr(schemaName)}`);
    }
    sameStore(store, instance);
  }
  const state = new _ObjectBuilder(store, schema, schemaName, (instance ?? null) as Instance | null);
  if (instance !== undefined && instance !== null) {
    // the value objects themselves, so that an update keeps them
    for (const [name, value] of innerOf(instance)._values as Values) state._values.set(name, value);
    loadEntries(state._entries, schema, instance);
  }
  return shell(state);
}

export namespace OfObject {
  /** The class of proxy instances: `value instanceof Proxies.OfObject.Data`, as Python's `isinstance`. */
  export const Data = _ObjectData;
  export type Data = Instance;
  /** The class of value objects: `value instanceof Proxies.OfObject.Record`. */
  export const Record = _RecordData;
  export type Record = ValueObject;
  export type Builder = DynamicBuilder;
  /** A builder in `store` for `schema` registered as `schemaName`, as `store[schemaName](instance)` returns. */
  export function Builder(store: _Store, schema: ObjectSchema, schemaName: string, instance?: Instance): DynamicBuilder {
    return makeObjectBuilder(store, schema, schemaName, instance);
  }
}

/** An adjacency of a data instance, `Data`: the frozen array of its entries, with `project(name)` and `at(key)`. */
export namespace OfAdjacency {
  export const Data = _Adjacency;
  export type Data = _Adjacency;
}

/** A relation's entries as proxies hold them: `Data`, an entry with every link, the owner's own included, and its
 * properties, as an adjacency's iterable yields it (`entry instanceof Proxies.OfEntry.Data`). */
export namespace OfEntry {
  export const Data = _Entry;
  export type Data = _Entry;
}

/** Whether a value is a visitor this module or `Builders` made (a shell), which is a value, though callable, never the
 * function form of a `Specs.Callback`. */
export function _isVisitor(value: unknown): boolean {
  return INNER.has(value as object) || NAMED.has(value as object);
}

/** The shells visitors are made with, shared with `Builders`, as Python's `Builders` imports `_Dunders`, `_Empty`,
 * `_Properties` and `_Unassignable`. */
export { shell as _shell, Shelled as _Shelled, Dunders as _Dunders, makeEmpty as _makeEmpty, makeProperty as _makeProperty,
  isFunction as _isFunction, visit as _visit, noun as _noun, withArticle as _withArticle, isObjectData as _isObjectData,
  makeProperties as _makeProperties, innerOf as _innerOf, storeOf as _store_of, linking as _linking,
  addEntry as _add_entry, discard as _discard, makeEntry as _make_entry, adjacentOf as _adjacent_of, single as _single };

/** Internal classes, exposed for protocol conformance tests. */
export const _internals = { makeRecordBuilder, _ObjectData, _RecordData, _Entry, _Empty, _Scalar, _Any, _Property, _Properties, _Adjacency,
  _RecordBuilder, _AdjacencyBuilder, _LinkMember, _EntryBuilder, _ObjectBuilder };
