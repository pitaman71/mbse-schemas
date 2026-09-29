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

/** `Visitors.OfAny` writing one key of a plain map. Only native values are supported so far. */
export class _AnyWriter implements OfAny {
  constructor(private readonly out: PlainMap, private readonly slotName: string, private readonly schema: Schemas.OfAny.Data) {}

  as_native(callback: Callback<OfNative>): _AnyWriter {
    if (!(this.schema instanceof Schemas.OfNative.Data)) throw new TypeError(`property ${repr(this.slotName)} is not native`);
    callback(new _NativeWriter(this.out, this.slotName, this.schema));
    return this;
  }

  as_object(_callback: Callback<OfObject>): _AnyWriter {
    throw new NotImplementedError("object-valued properties are not supported by Plain yet");
  }

  as_union(_callback: Callback<OfUnion>): _AnyWriter {
    throw new NotImplementedError("union-valued properties are not supported by Plain yet");
  }

  as_intersection(_callback: Callback<OfIntersection>): _AnyWriter {
    throw new NotImplementedError("intersection-valued properties are not supported by Plain yet");
  }
}

/** `Visitors.OfProperty` writing one key of a plain map. */
export class _PropertyWriter implements OfProperty {
  constructor(private readonly out: PlainMap, private readonly slotName: string, private readonly schema: Schemas.OfAny.Data) {}

  name(): string {
    return this.slotName;
  }

  has(): boolean {
    return this.out.has(this.slotName);
  }

  value(callback: Callback<OfAny>): _PropertyWriter {
    callback(new _AnyWriter(this.out, this.slotName, this.schema));
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

type Ref = (target: Visitable) => PlainMap;

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
      if (this.entry.has(name)) callback(new _PropertyWriter(this.entry, name, schema));
    }
    return this;
  }

  has(name: string): boolean {
    return this.entry.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): _EntryWriter {
    callback(new _PropertyWriter(this.entry, name, propertySchema(this.relation.properties, name)));
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

/** `Visitors.OfObject` writing one plain object. */
export class _ObjectWriter implements OfObject {
  constructor(private readonly out: PlainMap, private readonly schema: Schemas.OfObject.Data, private readonly ref: Ref) {}

  properties(callback: Callback<OfProperty>): _ObjectWriter {
    for (const [name, schema] of this.schema.properties) {
      if (this.out.has(name)) callback(new _PropertyWriter(this.out, name, schema));
    }
    return this;
  }

  has(name: string): boolean {
    return this.out.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): _ObjectWriter {
    callback(new _PropertyWriter(this.out, name, propertySchema(this.schema.properties, name)));
    return this;
  }

  clear(name: string): _ObjectWriter {
    this.out.delete(name);
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
}

/** Assigns symbols 1:1 to object identities, in first-reference order, and writes the included objects. */
class Snapshot {
  private readonly symbols = new Map<unknown, string>();

  private symbol(value: Visitable): string {
    let symbol = this.symbols.get(value.identity());
    if (symbol === undefined) this.symbols.set(value.identity(), (symbol = `s${this.symbols.size}`));
    return symbol;
  }

  private readonly ref = (target: Visitable): PlainMap =>
    new Map<string, PlainData>([[REF, this.symbol(target)], [SCHEMA, target.schema_name()]]);

  run(schema: Schemas.OfObject.Data, root: Visitable, include: Visitable[]): PlainMap {
    if (Proxies.schema(root.schema_name()) !== schema) {
      throw new TypeError(`value is a ${repr(root.schema_name())}, not an instance of the given schema`);
    }
    for (const value of include) this.symbol(value);
    const objects: PlainMap = new Map();
    for (const value of include) {
      const out: PlainMap = new Map();
      value.accept(new _ObjectWriter(out, Proxies.schema(value.schema_name()), this.ref));
      objects.set(this.symbol(value), out);
    }
    return new Map<string, PlainData>([["root", this.symbol(root)], ["objects", objects]]);
  }
}

function isRef(value: unknown): value is PlainMap {
  return value instanceof Map && value.size === 2 && value.has(REF) && value.has(SCHEMA) &&
    [...value.values()].every((v) => typeof v === "string");
}

/** A decoded link: the symbol of the target object. */
class Link {
  constructor(readonly symbol: string) {}
}

function decode(schema: Schemas.OfAny.Data, name: string, plain: unknown, where: string): Native {
  if (!(schema instanceof Schemas.OfNative.Data)) {
    throw new NotImplementedError(`property ${repr(name)}: only native values are supported by Plain yet`);
  }
  try {
    return schema.from_plain(plain);
  } catch (error) {
    throw (error as DecodeError).at(where); // from_plain throws only DecodeError
  }
}

/** Per object symbol: its decoded property values, and per adjacency its entries, each mapping links to `Link`s and
 * properties to decoded values. */
type Decoded = Map<string, [Map<string, Native>, Map<string, Map<string, Native | Link>[]>]>;

/** Checks a snapshot against the schemas and decodes its values before anything is built. Returns the root symbol,
 * each object's schema name, and the decoded objects. Problems in the snapshot throw `DecodeError`. */
function check(builders: Builders, schema: unknown, plain: unknown): [string, Map<string, string>, Decoded] {
  if (!(schema instanceof Schemas.OfObject.Data)) {
    throw new TypeError(`the root schema must be an object schema, got ${schemaTypeName(schema)}`);
  }
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

  // Pass 1: infer each object's schema from the references to it.
  const names = new Map<string, string>([[root, builders.name_of(schema)]]);
  for (const [symbol, obj] of objects as Map<string, PlainMap>) {
    for (const [key, value] of obj) {
      if (!Array.isArray(value)) continue;
      value.forEach((entry, i) => {
        if (!(entry instanceof Map)) {
          throw new DecodeError(`an entry must be a mapping, got ${typeName(entry)}`, { path: path("objects", symbol, key, i) });
        }
        for (const [name, ref] of entry) {
          if (!(ref instanceof Map)) continue;
          const where = path("objects", symbol, key, i, name);
          if (!isRef(ref)) throw new DecodeError("a reference is {'$ref': symbol, '$schema': name}", { path: where });
          const target = ref.get(REF) as string;
          const targetSchema = ref.get(SCHEMA) as string;
          if (!objects.has(target)) {
            throw new DecodeError(`unresolved reference ${repr(target)}: the snapshot does not contain it`, { path: where });
          }
          if (!names.has(target)) names.set(target, targetSchema);
          if (names.get(target) !== targetSchema) {
            throw new DecodeError(`${repr(target)} is referenced as both ${repr(names.get(target))} and ${repr(targetSchema)}`, { path: where });
          }
        }
      });
    }
  }

  // Pass 2: check every key against the schemas and decode the values.
  const decoded: Decoded = new Map();
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
    const properties = new Map<string, Native>();
    const adjacencies = new Map<string, Map<string, Native | Link>[]>();
    for (const [key, value] of obj) {
      const where = path("objects", symbol, key);
      const adjacency = objectSchema.adjacencies.get(key);
      const propertyType = objectSchema.properties.get(key);
      if (adjacency !== undefined) {
        if (!Array.isArray(value)) throw new DecodeError("an adjacency must be a list of entries", { path: where });
        const relation = adjacency.relation as Schemas.OfRelation.Data;
        const rows: Map<string, Native | Link>[] = [];
        adjacencies.set(key, rows);
        value.forEach((entry, i) => {
          const row = new Map<string, Native | Link>();
          for (const [entryName, item] of entry as PlainMap) {
            const at = path("objects", symbol, key, i, entryName);
            const entryType = relation.properties.get(entryName);
            if (entryName === adjacency.me) {
              throw new DecodeError(`${repr(entryName)} is this object's own link, which is implied`, { path: at });
            }
            if (relation.links.includes(entryName)) {
              if (!isRef(item)) throw new DecodeError("a link must be a reference", { path: at });
              row.set(entryName, new Link(item.get(REF) as string));
            } else if (entryType !== undefined) {
              row.set(entryName, decode(entryType, entryName, item, at));
            } else {
              throw new DecodeError(`the relation has no link or property ${repr(entryName)}`, { path: at });
            }
          }
          const missing = relation.links.filter((n) => n !== adjacency.me && !(entry as PlainMap).has(n));
          if (missing.length > 0) {
            throw new DecodeError(`links ${repr(missing)} are not set`, { path: path("objects", symbol, key, i) });
          }
          rows.push(row);
        });
      } else if (propertyType !== undefined) {
        properties.set(key, decode(propertyType, key, value, where));
      } else {
        throw new DecodeError(`${repr(name)} has no property or adjacency ${repr(key)}`, { path: where });
      }
    }
    decoded.set(symbol, [properties, adjacencies]);
  }
  const unreached = sortedStrings([...objects.keys()].filter((symbol) => !names.has(symbol)));
  if (unreached.length > 0) {
    throw new DecodeError("nothing references this object, so its schema is unknown", { path: path("objects", unreached[0] as string) });
  }
  return [root, names, decoded];
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

/** Rebuilds objects from an object snapshot using `builders`. Every reference must resolve within the snapshot. */
function restore(builders: Builders, schema: Schemas.OfObject.Data, plain: unknown): unknown {
  const [root, names, decoded] = check(builders, schema, plain);

  const created = new Map<string, unknown>();
  for (const [symbol, [properties]] of decoded) {
    const builder = builderFor(builders, names.get(symbol) as string);
    for (const [key, value] of properties) set(builder, key, value);
    created.set(symbol, builder.create());
  }

  for (const [symbol, [, adjacencies]] of decoded) {
    const builder = builderFor(builders, names.get(symbol) as string, created.get(symbol));
    for (const [key, rows] of adjacencies) {
      for (const row of rows) builder.adjacency(key, (a) => a.add((x) => fill(x, row, created)));
    }
    builder.update();
  }
  return created.get(root);
}

function set(visitor: { property(name: string, callback: Callback<OfProperty>): unknown }, name: string, value: Native): void {
  visitor.property(name, (p) => p.value((a) => a.as_native((n) => n.set(value))));
}

function fill(visitor: OfEntry, row: Map<string, Native | Link>, created: Map<string, unknown>): void {
  for (const [key, value] of row) { // links map to target symbols; properties to decoded values
    if (value instanceof Link) {
      const target = created.get(value.symbol) as Visitable;
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
