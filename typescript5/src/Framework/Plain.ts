/**
 * Plain: conversion between values and plain data (maps, lists, strings, numbers, booleans, null).
 *
 * `ToPlain(schema, value)` and `FromPlain(builders)(schema, plain)` dispatch on the schema's kind;
 * `ToPlain.OfObject(...)` etc. are the per-kind forms. JSON and YAML are thin text encodings of plain data.
 *
 * Plain data keeps Python's distinctions: an int is a `bigint` and a float is a `number`, and a mapping is a
 * `Map<string, PlainData>` (which keeps insertion order for every key, unlike object literals).
 *
 * An object snapshot has the shape `{"root": symbol, "objects": {symbol: object}}`. Each object maps property names
 * to plain values and adjacency names to lists of entries. An entry maps the other links to references and the entry
 * properties to plain values; the object's own link is implied. A reference is `{"$ref": symbol, "$schema": name}`:
 * object content carries no schema, so references carry the schema name, and the root schema is passed in.
 *
 * `ToPlain.OfObject` includes only the root object, so its references are unresolved and `FromPlain` rejects them.
 * `ToPlain.Reachable` also includes every object reachable through adjacencies (see `Reachable`).
 *
 * The serializers are visitors: a value writes itself into them through `Visitable.accept`. `FromPlain` is
 * constructed with the builders to build with, e.g. `FromPlain(Proxies.Builders)`.
 *
 * An embedded object (a property whose schema is an `OfObject`) is written nested, as a mapping of its properties.
 * Union and intersection values are written the same way, with the union's branches or the intersection's parts as
 * the properties: a union value `{"phone": {"number": "+44"}}` holds exactly one branch, and an intersection value
 * `{"stamp": {...}, "audit": {...}}` each of its parts.
 */

import { AttributeError, DecodeError, KeyError, LookupError, NotImplementedError, path } from "./Errors.js";
import * as Proxies from "./Proxies.js";
import * as Reachable from "./Reachable.js";
import { repr, sortedStrings, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type { Callback, Native, OfAdjacency, OfAny, OfEntry, OfIntersection, OfLink, OfNative, OfObject, OfProperty,
  OfUnion, Visitable } from "./Visitors.js";

export type PlainData = null | boolean | bigint | number | string | PlainData[] | PlainMap;
export type PlainMap = Map<string, PlainData>;

export const REF = "$ref";
export const SCHEMA = "$schema";
export const ID = "$id";

/** The Python class name of a schema's data (`_ObjectData`, ...), so messages match the Python implementation. */
export function schemaTypeName(schema: unknown): string {
  const kinds = [Schemas.OfNative.Data, Schemas.OfObject.Data, Schemas.OfRelation.Data, Schemas.OfAdjacency.Data,
    Schemas.OfUnion.Data, Schemas.OfIntersection.Data] as const;
  for (const kind of kinds) if (schema instanceof kind) return "_" + kind.name;
  return typeName(schema);
}

// --- Writers: Visitors that write plain data ---

/** `Visitors.OfNative` writing one key of a plain map. */
export class _NativeWriter implements OfNative {
  constructor(private readonly out: PlainMap, private readonly slotName: string, private readonly schema: Schemas.OfNative.Data) {}

  has(): boolean {
    return this.out.has(this.slotName);
  }

  get(): Native {
    return this.schema.from_plain(this.out.get(this.slotName));
  }

  set(value: Native): _NativeWriter {
    this.out.set(this.slotName, this.schema.to_plain(value));
    return this;
  }

  clear(): _NativeWriter {
    this.out.delete(this.slotName);
    return this;
  }
}

type Ref = (target: Visitable) => PlainMap;
type Symbol = (value: Visitable) => string | null;

function unlinked(_value: Visitable): string | null {
  return null;
}

/** `Visitors.OfAny` writing one key of a plain map: a native, or a value object (an object's, a union value or an
 * intersection value), nested. `ref` writes references to linked objects, and `symbol` gives a value object's symbol
 * when something links to it. */
export class _AnyWriter implements OfAny {
  constructor(private readonly out: PlainMap, private readonly slotName: string, private readonly schema: Schemas.OfAny.Data,
    private readonly ref: Ref, private readonly symbol: Symbol) {}

  as_native(callback: Callback<OfNative>): _AnyWriter {
    if (!(this.schema instanceof Schemas.OfNative.Data)) throw new TypeError(`property ${repr(this.slotName)} is not native`);
    callback(new _NativeWriter(this.out, this.slotName, this.schema));
    return this;
  }

  as_object(callback: Callback<OfObject>): _AnyWriter {
    return this.record(Schemas.OfObject.Data, "an object", callback);
  }

  as_union(callback: Callback<OfUnion>): _AnyWriter {
    return this.record(Schemas.OfUnion.Data, "a union", callback as unknown as Callback<OfObject>);
  }

  as_intersection(callback: Callback<OfIntersection>): _AnyWriter {
    return this.record(Schemas.OfIntersection.Data, "an intersection", callback as unknown as Callback<OfObject>);
  }

  /** Writes an embedded object, a union value or an intersection value, nested as a mapping. */
  private record(kind: abstract new (...args: never[]) => RecordSchema, what: string, callback: Callback<OfObject>): _AnyWriter {
    if (!(this.schema instanceof kind)) throw new TypeError(`property ${repr(this.slotName)} is not ${what}`);
    let nested = this.out.get(this.slotName);
    if (!(nested instanceof Map)) this.out.set(this.slotName, (nested = new Map()));
    callback(this.schema instanceof Schemas.OfObject.Data ? new _ObjectWriter(nested, this.schema, this.ref, this.symbol)
      : new _RecordWriter(nested, this.schema, this.ref, this.symbol) as unknown as OfObject);
    if (this.schema instanceof Schemas.OfUnion.Data && nested.size === 0) {
      this.out.delete(this.slotName); // a union value without a branch is no value
    }
    return this;
  }
}

/** The schema of a record: an embedded object's, or a union's or intersection's, whose properties are its branches or
 * parts. */
type RecordSchema = Schemas.OfObject.Data | Schemas.OfUnion.Data | Schemas.OfIntersection.Data;

/** `Visitors.OfProperty` writing one key of a plain map. */
export class _PropertyWriter implements OfProperty {
  constructor(private readonly out: PlainMap, private readonly slotName: string, private readonly schema: Schemas.OfAny.Data,
    private readonly ref: Ref, private readonly symbol: Symbol) {}

  name(): string {
    return this.slotName;
  }

  has(): boolean {
    return this.out.has(this.slotName);
  }

  value(callback: Callback<OfAny>): _PropertyWriter {
    callback(new _AnyWriter(this.out, this.slotName, this.schema, this.ref, this.symbol));
    return this;
  }

  clear(): _PropertyWriter {
    this.out.delete(this.slotName);
    return this;
  }
}

function propertySchema(properties: Map<string, Schemas.OfAny.Data>, name: string): Schemas.OfAny.Data {
  const found = properties.get(name);
  if (found === undefined) throw new KeyError(`unknown property ${repr(name)}`);
  return found;
}

/** `Visitors.OfLink` writing a reference into a plain entry. */
export class _LinkWriter implements OfLink {
  constructor(private readonly entry: PlainMap, private readonly linkName: string, private readonly ref: Ref) {}

  name(): string {
    return this.linkName;
  }

  target(_callback: Callback<Visitable>): _LinkWriter {
    throw new NotImplementedError("a plain writer cannot read link targets back");
  }

  set(target: Visitable): _LinkWriter {
    this.entry.set(this.linkName, this.ref(target));
    return this;
  }
}

/** `Visitors.OfEntry` writing one plain entry. */
export class _EntryWriter implements OfEntry {
  constructor(
    private readonly entry: PlainMap,
    private readonly relation: Schemas.OfRelation.Data,
    private readonly me: string,
    private readonly ref: Ref,
  ) {}

  links(callback: Callback<OfLink>): _EntryWriter {
    for (const name of this.relation.links) if (name !== this.me) callback(new _LinkWriter(this.entry, name, this.ref));
    return this;
  }

  link(name: string, callback: Callback<OfLink>): _EntryWriter {
    if (name === this.me || !this.relation.links.includes(name)) throw new KeyError(`${repr(name)} is not a link this entry can set`);
    callback(new _LinkWriter(this.entry, name, this.ref));
    return this;
  }

  properties(callback: Callback<OfProperty>): _EntryWriter {
    for (const [name, schema] of this.relation.properties) {
      if (this.entry.has(name)) callback(new _PropertyWriter(this.entry, name, schema, this.ref, unlinked));
    }
    return this;
  }

  has(name: string): boolean {
    return this.entry.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): _EntryWriter {
    callback(new _PropertyWriter(this.entry, name, propertySchema(this.relation.properties, name), this.ref, unlinked));
    return this;
  }

  clear(name: string): _EntryWriter {
    this.entry.delete(name);
    return this;
  }
}

/** `Visitors.OfAdjacency` writing a list of plain entries. */
export class _AdjacencyWriter implements OfAdjacency {
  constructor(
    private readonly list: PlainMap[],
    private readonly adjacencyName: string,
    private readonly schema: Schemas.OfAdjacency.Data,
    private readonly ref: Ref,
  ) {}

  name(): string {
    return this.adjacencyName;
  }

  me(): string {
    return this.schema.me;
  }

  entries(callback: Callback<OfEntry>): _AdjacencyWriter {
    for (const entry of this.list) {
      callback(new _EntryWriter(entry, this.schema.relation as Schemas.OfRelation.Data, this.schema.me, this.ref));
    }
    return this;
  }

  add(callback: Callback<OfEntry>): _AdjacencyWriter {
    const entry: PlainMap = new Map();
    callback(new _EntryWriter(entry, this.schema.relation as Schemas.OfRelation.Data, this.schema.me, this.ref));
    this.list.push(entry);
    return this;
  }

  remove(_entry: OfEntry): _AdjacencyWriter {
    throw new NotImplementedError("a plain writer does not remove entries");
  }
}

/** `Visitors.OfUnion` and `Visitors.OfIntersection` writing a union or intersection value, whose properties are the
 * branches or parts; the base of `_ObjectWriter`. Writing a union's branch clears any other. */
export class _RecordWriter implements OfUnion, OfIntersection {
  constructor(protected readonly out: PlainMap, protected readonly schema: RecordSchema, protected readonly ref: Ref,
    protected readonly symbol: Symbol) {}

  properties(callback: Callback<OfProperty>): this {
    for (const [name, schema] of this.schema.properties) {
      if (this.out.has(name)) callback(new _PropertyWriter(this.out, name, schema, this.ref, this.symbol));
    }
    return this;
  }

  has(name: string): boolean {
    return this.out.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): this {
    const schema = propertySchema(this.schema.properties, name);
    if (this.schema instanceof Schemas.OfUnion.Data) {
      for (const other of [...this.out.keys()]) if (other !== name) this.out.delete(other);
    }
    callback(new _PropertyWriter(this.out, name, schema, this.ref, this.symbol));
    return this;
  }

  clear(name: string): this {
    this.out.delete(name);
    return this;
  }
}

/** `Visitors.OfObject` writing one plain object, a reference object or a value object nested in its owner. A value
 * object that something links to is written with its symbol, `$id`. */
export class _ObjectWriter extends _RecordWriter implements OfObject {
  constructor(out: PlainMap, protected override readonly schema: Schemas.OfObject.Data, ref: Ref, symbol: Symbol = unlinked) {
    super(out, schema, ref, symbol);
  }

  identify(value: Visitable): _ObjectWriter {
    const symbol = this.symbol(value);
    if (symbol !== null) this.out.set(ID, symbol);
    return this;
  }

  adjacencies(callback: Callback<OfAdjacency>): _ObjectWriter {
    for (const name of this.schema.adjacencies.keys()) this.adjacency(name, callback);
    return this;
  }

  adjacency(name: string, callback: Callback<OfAdjacency>): _ObjectWriter {
    const adjacency = this.schema.adjacencies.get(name);
    if (adjacency === undefined) throw new KeyError(`unknown adjacency ${repr(name)}`);
    let list = this.out.get(name) as PlainMap[] | undefined;
    if (list === undefined) this.out.set(name, (list = []));
    callback(new _AdjacencyWriter(list, name, adjacency, this.ref));
    return this;
  }
}

// --- Snapshots ---

/** What `FromPlain` needs from an implementation, e.g. `Proxies.Builders`: `builders[name](instance)` returns a
 * builder for the schema registered as `name`. */
export interface Builders {
  schema(name: string): Schemas.OfObject.Data;
  name_of(schema: Schemas.OfObject.Data): string;
  /** The value `instance` holds in its property `name`, e.g. a value object. */
  member(instance: unknown, name: string): unknown;
}

/** Assigns symbols 1:1 to object identities, in first-reference order, and writes the included objects. */
class Snapshot {
  private readonly symbols = new Map<unknown, string>();

  private symbol(value: Visitable): string {
    let symbol = this.symbols.get(value.identity());
    if (symbol === undefined) this.symbols.set(value.identity(), (symbol = `s${this.symbols.size}`));
    return symbol;
  }

  /** The reference objects some reference names the schema of. */
  private readonly typed = new Set<string>();

  /** A reference to a linked object; one to a value object has no schema, which its owner's gives. */
  private readonly ref = (target: Visitable): PlainMap => {
    if (target.owner() !== null) return new Map<string, PlainData>([[REF, this.symbol(target)]]);
    this.typed.add(this.symbol(target));
    return new Map<string, PlainData>([[REF, this.symbol(target)], [SCHEMA, target.schema_name()]]);
  };

  run(schema: Schemas.OfObject.Data, root: Visitable, include: Visitable[]): PlainMap {
    if (Proxies.schema(root.schema_name()) !== schema) {
      throw new TypeError(`value is a ${repr(root.schema_name())}, not an instance of the given schema`);
    }
    if (!schema.ref) {
      throw new TypeError(`a snapshot's root must be a reference object; ${repr(root.schema_name())} is a value object schema`);
    }
    for (const value of include) this.symbol(value);
    const linked = Reachable.targets(include);
    const symbol = (value: Visitable): string | null => (linked.has(value.identity()) ? this.symbol(value) : null);
    const objects: PlainMap = new Map();
    for (const value of include) {
      const out: PlainMap = new Map();
      value.accept(new _ObjectWriter(out, Proxies.schema(value.schema_name()), this.ref, symbol));
      objects.set(this.symbol(value), out);
    }
    for (const value of include) { // an object whose schema nothing else gives carries it: one linked only by value objects
      const key = this.symbol(value);
      if (value !== root && !this.typed.has(key)) {
        objects.set(key, new Map<string, PlainData>([[SCHEMA, value.schema_name()], ...(objects.get(key) as PlainMap)]));
      }
    }
    return new Map<string, PlainData>([["root", this.symbol(root)], ["objects", objects]]);
  }
}

/** A reference: `{'$ref': symbol, '$schema': name}` to a reference object, or `{'$ref': symbol}` to a value object. */
function isRef(value: unknown): value is PlainMap {
  return value instanceof Map && value.has(REF) && (value.size === 1 || (value.size === 2 && value.has(SCHEMA))) &&
    [...value.values()].every((v) => typeof v === "string");
}

/** A decoded link: the symbol of the target object. */
class Link {
  constructor(readonly symbol: string) {}
}

/** A decoded value object (an object's, a union value or an intersection value); `accept` writes its properties into a
 * builder. Its entries are added once every object is built. */
class DecodedRecord {
  constructor(readonly schema: RecordSchema, readonly values: Map<string, unknown>) {}

  accept(visitor: OfObject): void {
    for (const [name, value] of this.values) set(visitor, name, value);
  }
}

type Where = (string | number)[];
/** Per adjacency, its decoded entries: each maps links to `Link`s and properties to decoded values. */
type Rows = Map<string, Map<string, Native | Link>[]>;
type Steps = readonly (readonly [string, RecordKind])[];
type RecordKind = typeof Schemas.OfObject.Data | typeof Schemas.OfUnion.Data | typeof Schemas.OfIntersection.Data;

/** Where decoding found a value object: its reference object's symbol, and the steps from it, each a property name and
 * the kind of the value it holds. */
class Found {
  constructor(readonly owner: string, readonly steps: Steps) {}
}

/** What decoding a reference object's values collects: the symbols of the value objects in it, and their entries. */
class Context {
  constructor(readonly owner: string, readonly ids: Map<string, Found>, readonly entries: [Found, Rows][]) {}
}

function kindOf(schema: Schemas.OfAny.Data): RecordKind {
  return schema.constructor as RecordKind;
}

/** The value `plain` holds under `schema`, located at the path `where`. */
function decode(schema: Schemas.OfAny.Data, plain: unknown, where: Where, context: Context | null = null,
  steps: Steps = []): unknown {
  if (schema instanceof Schemas.OfNative.Data) {
    try {
      return schema.from_plain(plain);
    } catch (error) {
      throw (error as DecodeError).at(path(...where)); // from_plain throws only DecodeError
    }
  }
  const [what, owner, member] = recordNames(schema as RecordSchema);
  if (!(plain instanceof Map)) throw new DecodeError(`${what} must be a mapping, got ${typeName(plain)}`, { path: path(...where) });
  const record = schema as RecordSchema;
  const adjacencies = record instanceof Schemas.OfObject.Data ? record.adjacencies : new Map<string, Schemas.OfAdjacency.Data>();
  const values = new Map<string, unknown>();
  const rows: Rows = new Map();
  for (const [key, item] of plain as PlainMap) {
    const type = record.properties.get(key);
    const adjacency = adjacencies.get(key);
    if (key === ID && record instanceof Schemas.OfObject.Data && context !== null) {
      identify(item, context, steps, [...where, key]);
    } else if (adjacency !== undefined && context !== null) {
      rows.set(key, decodeRows(adjacency, item, where, key));
    } else if (type !== undefined) {
      values.set(key, decode(type, item, [...where, key], context, [...steps, [key, kindOf(type)]]));
    } else {
      throw new DecodeError(`${owner} has no ${member} ${repr(key)}`, { path: path(...where, key) });
    }
  }
  if (record instanceof Schemas.OfUnion.Data && values.size !== 1) {
    throw new DecodeError(`a union value holds exactly one branch, got ${values.size}`, { path: path(...where) });
  }
  if (rows.size > 0) (context as Context).entries.push([new Found((context as Context).owner, steps), rows]);
  return new DecodedRecord(record, values);
}

function identify(symbol: unknown, context: Context, steps: Steps, where: Where): void {
  if (typeof symbol !== "string") {
    throw new DecodeError(`a symbol must be a string, got ${typeName(symbol)}`, { path: path(...where) });
  }
  if (context.ids.has(symbol)) throw new DecodeError(`${repr(symbol)} is the symbol of two objects`, { path: path(...where) });
  context.ids.set(symbol, new Found(context.owner, steps));
}

/** For messages, per record kind: a value of it, its schema, and what its properties are. */
function recordNames(schema: RecordSchema): [string, string, string] {
  if (schema instanceof Schemas.OfUnion.Data) return ["a union value", "the union", "branch"];
  if (schema instanceof Schemas.OfIntersection.Data) return ["an intersection value", "the intersection", "part"];
  return ["an embedded object", "the embedded object", "property"];
}

function decodeEntryProperty(schema: Schemas.OfAny.Data, name: string, plain: unknown, where: Where): Native {
  if (!(schema instanceof Schemas.OfNative.Data)) {
    throw new NotImplementedError(`entry property ${repr(name)}: entry properties must be native`);
  }
  return decode(schema, plain, where) as Native;
}

/** The entries of one adjacency, at `where` + `key`. */
function decodeRows(adjacency: Schemas.OfAdjacency.Data, value: unknown, where: Where, key: string): Map<string, Native | Link>[] {
  if (!Array.isArray(value)) throw new DecodeError("an adjacency must be a list of entries", { path: path(...where, key) });
  const relation = adjacency.relation as Schemas.OfRelation.Data;
  return value.map((entry, i) => {
    const row = new Map<string, Native | Link>();
    for (const [name, item] of entry as PlainMap) {
      const at = path(...where, key, i, name);
      const entryType = relation.properties.get(name);
      if (name === adjacency.me) throw new DecodeError(`${repr(name)} is this object's own link, which is implied`, { path: at });
      if (relation.links.includes(name)) {
        if (!isRef(item)) throw new DecodeError("a link must be a reference", { path: at });
        row.set(name, new Link(item.get(REF) as string));
      } else if (entryType !== undefined) {
        row.set(name, decodeEntryProperty(entryType, name, item, [...where, key, i, name]));
      } else {
        throw new DecodeError(`the relation has no link or property ${repr(name)}`, { path: at });
      }
    }
    const missing = relation.links.filter((n) => n !== adjacency.me && !(entry as PlainMap).has(n));
    if (missing.length > 0) throw new DecodeError(`links ${repr(missing)} are not set`, { path: path(...where, key, i) });
    return row;
  });
}

/** Finds the references in the entries of an object and of the value objects nested in it: a list is always an
 * adjacency, since plain values hold no lists. */
function references(value: unknown, where: Where, found: (ref: PlainMap, where: Where) => void): void {
  if (value instanceof Map) {
    for (const [key, item] of value) references(item, [...where, key], found);
    return;
  }
  if (!Array.isArray(value)) return;
  value.forEach((entry, i) => {
    if (!(entry instanceof Map)) {
      throw new DecodeError(`an entry must be a mapping, got ${typeName(entry)}`, { path: path(...where, i) });
    }
    for (const [name, ref] of entry) {
      if (!(ref instanceof Map)) continue;
      if (!isRef(ref)) {
        throw new DecodeError("a reference is {'$ref': symbol, '$schema': name}, or {'$ref': symbol} to a value object",
          { path: path(...where, i, name) });
      }
      found(ref, [...where, i, name]);
    }
  });
}

/** Per reference object symbol: its decoded property values and its entries. */
type Decoded = Map<string, [Map<string, unknown>, Rows]>;

/** Checks a snapshot against the schemas and decodes its values before anything is built. Returns the root symbol,
 * each reference object's schema name, the decoded reference objects, where each value object with a symbol is, and
 * the entries of value objects. Problems in the snapshot throw `DecodeError`. */
function check(builders: Builders, schema: unknown, plain: unknown): [string, Map<string, string>, Decoded, Map<string, Found>, [Found, Rows][]] {
  if (!(schema instanceof Schemas.OfObject.Data)) {
    throw new TypeError(`the root schema must be an object schema, got ${schemaTypeName(schema)}`);
  }
  if (!schema.ref) throw new TypeError("the root schema must be a reference object schema");
  if (!(plain instanceof Map) || plain.size !== 2 || !plain.has("root") || !(plain.get("objects") instanceof Map)) {
    throw new DecodeError("expected an object snapshot: {'root': symbol, 'objects': {symbol: object}}", { path: "$" });
  }
  const root: unknown = plain.get("root");
  const objects = plain.get("objects") as Map<string, unknown>;
  if (typeof root !== "string" || !objects.has(root)) {
    throw new DecodeError(`root ${repr(root)} is not in the snapshot's objects`, { path: "$.root" });
  }
  for (const [symbol, obj] of objects) {
    if (!(obj instanceof Map)) {
      throw new DecodeError(`an object must be a mapping, got ${typeName(obj)}`, { path: path("objects", symbol) });
    }
  }

  // Pass 1: infer each reference object's schema from the references to it.
  const names = new Map<string, string>([[root, builders.name_of(schema)]]);
  const values: [string, Where][] = []; // references to value objects, checked once their symbols are known
  const found = (ref: PlainMap, where: Where): void => {
    const target = ref.get(REF) as string;
    if (!ref.has(SCHEMA)) {
      values.push([target, where]);
      return;
    }
    const targetSchema = ref.get(SCHEMA) as string;
    if (!objects.has(target)) {
      throw new DecodeError(`unresolved reference ${repr(target)}: the snapshot does not contain it`, { path: path(...where) });
    }
    if (!names.has(target)) names.set(target, targetSchema);
    if (names.get(target) !== targetSchema) {
      throw new DecodeError(`${repr(target)} is referenced as both ${repr(names.get(target))} and ${repr(targetSchema)}`,
        { path: path(...where) });
    }
  };
  for (const [symbol, obj] of objects as Map<string, PlainMap>) {
    const own = obj.get(SCHEMA);
    if (own !== undefined) { // an object carries its schema when nothing else gives it
      if (typeof own !== "string") {
        throw new DecodeError(`a schema name must be a string, got ${typeName(own)}`, { path: path("objects", symbol, SCHEMA) });
      }
      found(new Map([[REF, symbol], [SCHEMA, own]]), ["objects", symbol, SCHEMA]);
    }
    references(new Map([...obj].filter(([key]) => key !== SCHEMA)), ["objects", symbol], found);
  }

  // Pass 2: check every key against the schemas and decode the values.
  const decoded: Decoded = new Map();
  const ids = new Map<string, Found>([...objects.keys()].map((symbol) => [symbol, new Found(symbol, [])]));
  const entries: [Found, Rows][] = [];
  for (const [symbol, obj] of objects as Map<string, PlainMap>) {
    const name = names.get(symbol);
    if (name === undefined) continue;
    let objectSchema: Schemas.OfObject.Data;
    try {
      objectSchema = builders.schema(name);
    } catch (error) {
      if (error instanceof AttributeError || error instanceof LookupError || error instanceof TypeError) {
        throw new DecodeError(`no object schema registered as ${repr(name)}`, { path: path("objects", symbol) });
      }
      throw error;
    }
    if (!objectSchema.ref) throw new DecodeError(`${repr(name)} is not a reference object schema`, { path: path("objects", symbol) });
    const context = new Context(symbol, ids, entries);
    const properties = new Map<string, unknown>();
    const adjacencies: Rows = new Map();
    for (const [key, value] of obj) {
      if (key === SCHEMA) continue;
      const where: Where = ["objects", symbol];
      const adjacency = objectSchema.adjacencies.get(key);
      const propertyType = objectSchema.properties.get(key);
      if (adjacency !== undefined) {
        adjacencies.set(key, decodeRows(adjacency, value, where, key));
      } else if (propertyType !== undefined) {
        properties.set(key, decode(propertyType, value, [...where, key], context, [[key, kindOf(propertyType)]]));
      } else {
        throw new DecodeError(`${repr(name)} has no property or adjacency ${repr(key)}`, { path: path(...where, key) });
      }
    }
    decoded.set(symbol, [properties, adjacencies]);
  }
  const unreached = sortedStrings([...objects.keys()].filter((symbol) => !names.has(symbol)));
  if (unreached.length > 0) {
    throw new DecodeError("nothing references this object, so its schema is unknown", { path: path("objects", unreached[0] as string) });
  }
  for (const [target, where] of values) {
    if (!ids.has(target) || (ids.get(target) as Found).steps.length === 0) {
      throw new DecodeError(`unresolved reference ${repr(target)}: no value object in the snapshot has this symbol`,
        { path: path(...where) });
    }
  }
  return [root, names, decoded, new Map([...ids].filter(([, f]) => f.steps.length > 0)), entries];
}

type BuilderLike = {
  create(): unknown;
  update(): unknown;
  property(name: string, callback: Callback<OfProperty>): unknown;
  adjacency(name: string, callback: Callback<OfAdjacency>): unknown;
};

function builderFor(builders: Builders, name: string, instance?: unknown): BuilderLike {
  const factory = (builders as unknown as Record<string, (instance?: unknown) => BuilderLike>)[name] as
    (instance?: unknown) => BuilderLike;
  return instance === undefined ? factory() : factory(instance);
}

/** Rebuilds objects from an object snapshot using `builders`. Every reference must resolve within the snapshot:
 * reference objects are built first, with the value objects they hold, then the entries are added. */
function restore(builders: Builders, schema: Schemas.OfObject.Data, plain: unknown): unknown {
  const [root, names, decoded, ids, entries] = check(builders, schema, plain);

  const created = new Map<string, unknown>();
  for (const [symbol, [properties]] of decoded) {
    const builder = builderFor(builders, names.get(symbol) as string);
    for (const [key, value] of properties) set(builder, key, value);
    created.set(symbol, builder.create());
  }

  /** The object a symbol names: a reference object, or the value object found at its steps. */
  const resolve = (symbol: string): unknown => {
    if (created.has(symbol)) return created.get(symbol);
    const found = ids.get(symbol) as Found;
    let target = created.get(found.owner);
    for (const [name] of found.steps) target = builders.member(target, name);
    return target;
  };

  const nested = new Map<string, [Found, Rows][]>();
  for (const [found, rows] of entries) nested.set(found.owner, [...(nested.get(found.owner) ?? []), [found, rows]]);
  for (const [symbol, [, adjacencies]] of decoded) {
    const builder = builderFor(builders, names.get(symbol) as string, created.get(symbol));
    for (const [key, rows] of adjacencies) {
      for (const row of rows) builder.adjacency(key, (a) => a.add((x) => fill(x, row, resolve)));
    }
    for (const [found, rows] of nested.get(symbol) ?? []) within(builder, found.steps, (v) => addRows(v, rows, resolve));
    builder.update();
  }
  return created.get(root);
}

function addRows(visitor: OfObject, rows: Rows, resolve: (symbol: string) => unknown): void {
  for (const [key, list] of rows) {
    for (const row of list) visitor.adjacency(key, (a) => a.add((x) => fill(x, row, resolve)));
  }
}

/** Calls `then` with the builder of the value object at `steps` from `visitor`, editing each value on the way. */
function within(visitor: BuilderLike | OfObject, steps: Steps, then: (visitor: OfObject) => void): void {
  if (steps.length === 0) {
    then(visitor as OfObject);
    return;
  }
  const [[name, kind], ...rest] = steps as [readonly [string, RecordKind], ...Steps];
  visitor.property(name, (p) => p.value((a) => {
    const inner = (v: unknown) => within(v as OfObject, rest, then);
    if (kind === Schemas.OfUnion.Data) a.as_union(inner);
    else if (kind === Schemas.OfIntersection.Data) a.as_intersection(inner);
    else a.as_object(inner);
  }));
}

function set(visitor: { property(name: string, callback: Callback<OfProperty>): unknown }, name: string, value: unknown): void {
  visitor.property(name, (p) => p.value((a) => write(a, value)));
}

/** Writes a decoded value: a native, or an embedded object, union value or intersection value. */
function write(visitor: OfAny, value: unknown): void {
  if (value instanceof DecodedRecord && value.schema instanceof Schemas.OfUnion.Data) {
    visitor.as_union((u) => value.accept(u as unknown as OfObject));
  } else if (value instanceof DecodedRecord && value.schema instanceof Schemas.OfIntersection.Data) {
    visitor.as_intersection((i) => value.accept(i as unknown as OfObject));
  } else if (value instanceof DecodedRecord) {
    visitor.as_object((o) => value.accept(o));
  } else {
    visitor.as_native((n) => n.set(value as Native));
  }
}

function fill(visitor: OfEntry, row: Map<string, Native | Link>, resolve: (symbol: string) => unknown): void {
  for (const [key, value] of row) { // links map to target symbols; properties to decoded values
    if (value instanceof Link) {
      const target = resolve(value.symbol) as Visitable;
      visitor.link(key, (k) => k.set(target));
    } else {
      set(visitor, key, value);
    }
  }
}

// --- Entry points ---

function toPlainOfNative(schema: Schemas.OfNative.Data, value: Native): PlainData {
  return schema.to_plain(value);
}

/** Snapshot of `value` alone; its references to other objects are left unresolved. */
function toPlainOfObject(schema: Schemas.OfObject.Data, value: Visitable): PlainMap {
  return new Snapshot().run(schema, value, [value]);
}

/** Snapshot of `value` and every object reachable from it through adjacencies (see `Reachable`). */
function toPlainReachable(schema: Schemas.OfObject.Data, value: Visitable): PlainMap {
  return new Snapshot().run(schema, value, Reachable.of(value));
}

/** `ToPlain(schema, value)` dispatches on the schema's kind. */
export const ToPlain = Object.assign(
  function ToPlain(schema: unknown, value: unknown): PlainData {
    if (schema instanceof Schemas.OfNative.Data) return toPlainOfNative(schema, value as Native);
    if (schema instanceof Schemas.OfObject.Data) return toPlainOfObject(schema, value as Visitable);
    throw new NotImplementedError(`${schemaTypeName(schema)} is not supported by Plain yet`);
  },
  { OfNative: toPlainOfNative, OfObject: toPlainOfObject, Reachable: toPlainReachable },
);

export interface FromPlainCall {
  (schema: unknown, plain: unknown): unknown;
  OfNative(schema: Schemas.OfNative.Data, plain: unknown): Native;
  OfObject(schema: Schemas.OfObject.Data, plain: unknown): unknown;
  Reachable(schema: Schemas.OfObject.Data, plain: unknown): unknown;
}

/** Deserializes plain data, building objects with the given implementation's builders, e.g.
 * `FromPlain(Proxies.Builders)(schema, plain)`. Calling it dispatches on the schema's kind. */
export function FromPlain(builders: Builders): FromPlainCall {
  const OfNative = (schema: Schemas.OfNative.Data, plain: unknown): Native => {
    try {
      return schema.from_plain(plain);
    } catch (error) {
      throw (error as DecodeError).at("$"); // from_plain throws only DecodeError
    }
  };
  const OfObject = (schema: Schemas.OfObject.Data, plain: unknown): unknown => restore(builders, schema, plain);
  const call = (schema: unknown, plain: unknown): unknown => {
    if (schema instanceof Schemas.OfNative.Data) return OfNative(schema, plain);
    if (schema instanceof Schemas.OfObject.Data) return OfObject(schema, plain);
    throw new NotImplementedError(`${schemaTypeName(schema)} is not supported by Plain yet`);
  };
  return Object.assign(call, { OfNative, OfObject, Reachable: OfObject });
}
