/**
 * Plain: conversion between values and plain data (maps, lists, strings, numbers, booleans, null).
 *
 * `ToPlain(store)(schema, value)` and `FromPlain(store)(schema, plain)` dispatch on the schema's kind;
 * `ToPlain(store).OfObject(...)` etc. are the per-kind forms. The store (see `Stores`) names the schemas of the objects
 * written, and builds the objects read. JSON and YAML are thin text encodings of plain data.
 *
 * Plain data keeps Python's distinctions: an int is a `bigint` and a float is a `number`, and a mapping is a
 * `Map<string, PlainData>` (which keeps insertion order for every key, unlike object literals).
 *
 * An object snapshot has the shape `{"root": symbol, "objects": {symbol: object}}`. Each object maps property names
 * to plain values and adjacency names to lists of entries. An entry maps the other links to references and the entry
 * properties to plain values; the object's own link is implied. A reference is `{"$ref": symbol, "$schema": name}`:
 * object content carries no schema, so references carry the schema name, and the root schema is passed in.
 *
 * `ToPlain(store).OfObject` includes only the root object, so its references are unresolved and `FromPlain` rejects
 * them. `ToPlain(store).Reachable` also includes every object reachable through adjacencies (see `Reachable`).
 *
 * The serializers are visitors: a value writes itself into them through `Visitable.accept`.
 *
 * A value object (a property whose schema is an `OfObject`) is written nested, as a mapping of its properties.
 * Union and intersection values are written the same way, with the union's branches or the intersection's parts as
 * the properties: a union value `{"phone": {"number": "+44"}}` holds exactly one branch, and an intersection value
 * `{"stamp": {...}, "audit": {...}}` each of its parts.
 */

import { AttributeError, DecodeError, KeyError, LookupError, NotImplementedError, path } from "./Errors.js";
import * as Proxies from "./Proxies.js";
import * as Reachable from "./Reachable.js";
import { compareStrings, repr, sortedStrings, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type * as Stores from "./Stores.js";
import type { Callback, Scalar, OfAdjacency, OfAny, OfEntry, OfIntersection, OfLink, OfScalar, OfObject,
  OfProperty, OfUnion, Visitable } from "./Visitors.js";

export type PlainData = null | boolean | bigint | number | string | PlainData[] | PlainMap;
export type PlainMap = Map<string, PlainData>;

export const REF = "$ref";
export const SCHEMA = "$schema";
export const ID = "$id";

/** The Python class name of a schema's data (`_ObjectData`, ...), so messages match the Python implementation. */
export function schemaTypeName(schema: unknown): string {
  const kinds = [Schemas.OfScalar.Data, Schemas.OfObject.Data, Schemas.OfRelation.Data, Schemas.OfAdjacency.Data,
    Schemas.OfUnion.Data, Schemas.OfIntersection.Data] as const;
  for (const kind of kinds) if (schema instanceof kind) return "_" + kind.name;
  return typeName(schema);
}

// --- Writers: Visitors that write plain data ---

/** `Visitors.OfScalar` writing one key of a plain map. */
export class _ScalarWriter implements OfScalar {
  constructor(private readonly out: PlainMap, private readonly slotName: string, private readonly schema: Schemas.OfScalar.Data) {}

  has(): boolean {
    return this.out.has(this.slotName);
  }

  get(): Scalar {
    return this.schema.from_plain(this.out.get(this.slotName));
  }

  set(value: Scalar): _ScalarWriter {
    this.out.set(this.slotName, this.schema.to_plain(value));
    return this;
  }

  clear(): _ScalarWriter {
    this.out.delete(this.slotName);
    return this;
  }
}

type Ref = (target: Visitable) => PlainMap;

/** `Visitors.OfAny` writing one key of a plain map: a scalar, or a value object (an object's, a union value or an
 * intersection value), nested. `ref` writes references to linked objects. */
export class _AnyWriter implements OfAny {
  private readonly schema: Schemas.OfAny.Data;

  constructor(private readonly out: PlainMap, private readonly slotName: string, schema: Schemas.OfAny.Data,
    private readonly ref: Ref) {
    this.schema = Schemas.structure(schema) as Schemas.OfAny.Data;
  }

  as_scalar(callback: Callback<OfScalar>): _AnyWriter {
    if (!(this.schema instanceof Schemas.OfScalar.Data)) throw new TypeError(`property ${repr(this.slotName)} is not scalar`);
    callback(new _ScalarWriter(this.out, this.slotName, this.schema));
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

  /** Writes a value object, a union value or an intersection value, nested as a mapping. */
  private record(kind: abstract new (...args: never[]) => RecordSchema, what: string, callback: Callback<OfObject>): _AnyWriter {
    if (!(this.schema instanceof kind)) throw new TypeError(`property ${repr(this.slotName)} is not ${what}`);
    let nested = this.out.get(this.slotName);
    if (!(nested instanceof Map)) this.out.set(this.slotName, (nested = new Map()));
    callback(this.schema instanceof Schemas.OfObject.Data ? new _ObjectWriter(nested, this.schema, this.ref)
      : new _RecordWriter(nested, this.schema, this.ref) as unknown as OfObject);
    if (this.schema instanceof Schemas.OfUnion.Data && nested.size === 0) {
      this.out.delete(this.slotName); // a union value without a branch is no value
    }
    return this;
  }
}

/** The schema of a record: a value object's, or a union's or intersection's, whose properties are its branches or
 * parts. */
type RecordSchema = Schemas.OfObject.Data | Schemas.OfUnion.Data | Schemas.OfIntersection.Data;

/** `Visitors.OfProperty` writing one key of a plain map. */
export class _PropertyWriter implements OfProperty {
  constructor(private readonly out: PlainMap, private readonly slotName: string, private readonly schema: Schemas.OfAny.Data,
    private readonly ref: Ref) {}

  name(): string {
    return this.slotName;
  }

  has(): boolean {
    return this.out.has(this.slotName);
  }

  value(callback: Callback<OfAny>): _PropertyWriter {
    callback(new _AnyWriter(this.out, this.slotName, this.schema, this.ref));
    return this;
  }

  clear(): _PropertyWriter {
    this.out.delete(this.slotName);
    return this;
  }
}

/** The type of the property `name` (an `OfProperty`, or a union's or intersection's member). */
function propertySchema(properties: Map<string, { type: Schemas.OfAny.Data | null }>, name: string): Schemas.OfAny.Data {
  const found = properties.get(name);
  if (found === undefined) throw new KeyError(`unknown property ${repr(name)}`);
  return found.type as Schemas.OfAny.Data;
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
    for (const [name, prop] of this.relation.properties) {
      const schema = prop.type as Schemas.OfAny.Data;
      if (this.entry.has(name)) callback(new _PropertyWriter(this.entry, name, schema, this.ref));
    }
    return this;
  }

  has(name: string): boolean {
    return this.entry.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): _EntryWriter {
    callback(new _PropertyWriter(this.entry, name, propertySchema(this.relation.properties, name), this.ref));
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
  constructor(protected readonly out: PlainMap, protected readonly schema: RecordSchema, protected readonly ref: Ref) {}

  properties(callback: Callback<OfProperty>): this {
    for (const [name, prop] of this.schema.properties) {
      const schema = prop.type as Schemas.OfAny.Data;
      if (this.out.has(name)) callback(new _PropertyWriter(this.out, name, schema, this.ref));
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
    callback(new _PropertyWriter(this.out, name, schema, this.ref));
    return this;
  }

  clear(name: string): this {
    this.out.delete(name);
    return this;
  }
}

/** `Visitors.OfObject` writing one plain object, a reference object or a value object nested in its owner. A value
 * object has no symbol: entries never reference value objects. */
export class _ObjectWriter extends _RecordWriter implements OfObject {
  constructor(out: PlainMap, protected override readonly schema: Schemas.OfObject.Data, ref: Ref) {
    super(out, schema, ref);
  }

  identify(_value: Visitable): _ObjectWriter {
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

/** Assigns symbols 1:1 to object identities, in first-reference order, and writes the included objects. */
class Snapshot {
  private readonly symbols = new Map<unknown, string>();

  constructor(private readonly store: Stores.Store) {}

  private symbol(value: Visitable): string {
    let symbol = this.symbols.get(value.identity());
    if (symbol === undefined) this.symbols.set(value.identity(), (symbol = `s${this.symbols.size}`));
    return symbol;
  }


  /** A reference to a linked object, which is a reference object: entries never reference value objects. */
  private readonly ref = (target: Visitable): PlainMap => {
    if (target.owner() !== null) throw new TypeError("a link targets a reference object, never a value object");
    return new Map<string, PlainData>([[REF, this.symbol(target)], [SCHEMA, target.schema_name()]]);
  };

  run(schema: Schemas.OfObject.Data, root: Visitable, include: Visitable[]): PlainMap {
    if (this.store.schema(root.schema_name()) !== schema) {
      throw new TypeError(`value is a ${repr(root.schema_name())}, not an instance of the given schema`);
    }
    if (!schema.ref) {
      throw new TypeError(`a snapshot's root must be a reference object; ${repr(root.schema_name())} is a value object schema`);
    }
    for (const value of include) this.symbol(value);
    const objects: PlainMap = new Map();
    for (const value of include) {
      const out: PlainMap = new Map();
      const schema = this.store.schema(value.schema_name());
      value.accept(new _ObjectWriter(out, schema, this.ref));
      sortEntries(schema, out);
      objects.set(this.symbol(value), out);
    }
    return new Map<string, PlainData>([["root", this.symbol(root)], ["objects", objects]]);
  }
}

const ORDERED = new Set(["boolean", "bigint", "number", "string"]);

/** The order of two values of one ordered type: booleans false first, numbers by value, strings by code point. */
function compareOrdered(a: unknown, b: unknown): number {
  if (typeof a === "string") return compareStrings(a, b as string);
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

/** Sorts the entries of each adjacency written in `plain`, a value of `type`, nested value objects' too (those its
 * entries hold among them), by the key their relation declares from the adjacency's end (`Schemas.OfRelation.Data.key`):
 * where every entry has each of its values, and each holds values of one ordered type (booleans false first, numbers by
 * value, strings by code point). Otherwise, as where a key holds a link, entries keep the order they were written in. */
function sortEntries(type: unknown, plain: PlainData | undefined): void {
  const schema = Schemas.structure(type);
  if (!(schema instanceof Schemas.OfObject.Data || schema instanceof Schemas.OfUnion.Data || schema instanceof Schemas.OfIntersection.Data)) {
    return;
  }
  const record = plain as PlainMap;
  for (const [name, prop] of schema.properties) if (record.has(name)) sortEntries(prop.type, record.get(name));
  if (!(schema instanceof Schemas.OfObject.Data)) return;
  for (const [name, adjacency] of schema.adjacencies) {
    const relation = adjacency.relation as Schemas.OfRelation.Data;
    const [entries, names] = [record.get(name), relation.key(adjacency.me)];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as PlainMap[]) { // an entry's value objects, held by its properties
      for (const [held, prop] of relation.properties) if (entry.has(held)) sortEntries(prop.type, entry.get(held));
    }
    if (names === null) continue;
    const keys = (entries as PlainMap[]).map((entry) => names.map((n) => entry.get(n)));
    const ordered = names.every((_, i) => {
      const kinds = new Set(keys.map((key) => typeof key[i]));
      return kinds.size === 1 && ORDERED.has([...kinds][0] as string);
    });
    if (ordered) {
      (entries as PlainMap[]).sort((a, b) => {
        for (const n of names) {
          const order = compareOrdered(a.get(n), b.get(n));
          if (order !== 0) return order;
        }
        return 0;
      });
    }
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
  /** `rows`: entries decoded where no snapshot holds the value. */
  constructor(readonly schema: RecordSchema, readonly values: Map<string, unknown>, readonly rows: Rows = new Map()) {}

  accept(visitor: OfObject): void {
    for (const [name, value] of this.values) set(visitor, name, value);
    for (const [name, rows] of this.rows) {
      for (const row of rows) visitor.adjacency(name, (a) => a.add((x) => fill(x, row, unresolved)));
    }
  }
}

function unresolved(symbol: string): never {
  throw new DecodeError(`unresolved reference ${repr(symbol)}: no snapshot holds the value`);
}

type Where = (string | number)[];
/** Per adjacency, its decoded entries: each maps links to `Link`s and properties to decoded values. */
type Rows = Map<string, Map<string, unknown>[]>;
/** A step to a value object: a property name, or an entry of a one-link relation's adjacency (its name, its position
 * and the property holding the value). */
type Step = string | readonly [string, number, string];
/** The way from a reference object to a value object in it, each step with the kind of the value found there. */
type Steps = readonly (readonly [Step, ValueKind])[];
type ValueKind = typeof Schemas.OfObject.Data | typeof Schemas.OfUnion.Data | typeof Schemas.OfIntersection.Data;

/** Where decoding found a value object: its reference object's symbol, and the steps from it. */
class Found {
  constructor(readonly owner: string, readonly steps: Steps) {}
}

/** What decoding a reference object's values collects: the symbols of the value objects in it, and their entries. */
class Context {
  constructor(readonly owner: string, readonly entries: [Found, Rows, Schemas.OfObject.Data][]) {}
}

/** The kind of a type's values: its structure's (see `Schemas.structure`). */
function kindOf(schema: Schemas.OfAny.Data): ValueKind {
  return (Schemas.structure(schema) as Schemas.OfAny.Data).constructor as ValueKind;
}

/** The value `plain` holds under `schema`, located at the path `where`: a scalar or a `DecodedRecord`. */
function decode(type: Schemas.OfAny.Data, plain: unknown, where: Where, context: Context | null = null,
  steps: Steps = []): unknown {
  const schema = Schemas.structure(type) as Schemas.OfAny.Data;
  if (schema instanceof Schemas.OfScalar.Data) {
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
  const held: Rows = new Map(); // entries where no snapshot holds the value, so none of their links resolves
  for (const [key, item] of plain as PlainMap) {
    const type = record.properties.get(key)?.type as Schemas.OfAny.Data | undefined;
    const adjacency = adjacencies.get(key);
    if (adjacency !== undefined && context !== null) {
      rows.set(key, decodeRows(adjacency, item, where, key, context, steps));
    } else if (adjacency !== undefined) {
      held.set(key, decodeRows(adjacency, item, where, key));
    } else if (type !== undefined) {
      values.set(key, decode(type, item, [...where, key], context, [...steps, [key, kindOf(type)]]));
    } else {
      throw new DecodeError(`${owner} has no ${member} ${repr(key)}`, { path: path(...where, key) });
    }
  }
  if (record instanceof Schemas.OfUnion.Data && values.size !== 1) {
    throw new DecodeError(`a union value holds exactly one branch, got ${values.size}`, { path: path(...where) });
  }
  if (rows.size > 0) (context as Context).entries.push([new Found((context as Context).owner, steps), rows, record as Schemas.OfObject.Data]);
  return new DecodedRecord(record, values, held);
}

/** Equality key of a decoded value, per EQUALITY.md. */
function decodedKey(value: unknown): string {
  if (value instanceof DecodedRecord) {
    const rows = sortedStrings(value.rows.keys()).map((name) => [name, (value.rows.get(name) as Map<string, unknown>[]).map(
      (row) => sortedStrings([...row.keys()]).map((key) => [key, decodedKey(row.get(key))]))]);
    return `record:${JSON.stringify(sortedStrings(value.values.keys()).map((name) => [name, decodedKey(value.values.get(name))]))}`
      + `:${JSON.stringify(rows)}`;
  }
  return Proxies.scalarKey(value);
}

/** For messages, per record kind: a value of it, its schema, and what its properties are. */
function recordNames(schema: RecordSchema): [string, string, string] {
  if (schema instanceof Schemas.OfUnion.Data) return ["a union value", "the union", "branch"];
  if (schema instanceof Schemas.OfIntersection.Data) return ["an intersection value", "the intersection", "part"];
  return ["a value object", "the value object", "property"];
}

/** An entry property's value: a scalar or a value object, which has no symbol or adjacencies of its own. */
function decodeEntryProperty(schema: Schemas.OfAny.Data, plain: unknown, where: Where): Scalar {
  return decode(schema, plain, where) as Scalar;
}

/** The entries of one adjacency, at `where` + `key`. The value objects a one-link relation's entries hold, which are
 * written only with their one owner, may have symbols and entries of their own: `context` collects them, at `steps`
 * from the owner through the entry. */
function decodeRows(adjacency: Schemas.OfAdjacency.Data, value: unknown, where: Where, key: string,
  context: Context | null = null, steps: Steps = []): Map<string, unknown>[] {
  if (!Array.isArray(value)) throw new DecodeError("an adjacency must be a list of entries", { path: path(...where, key) });
  const relation = adjacency.relation as Schemas.OfRelation.Data;
  return value.map((entry, i) => {
    if (!(entry instanceof Map)) {
      throw new DecodeError(`an entry must be a mapping, got ${typeName(entry)}`, { path: path(...where, key, i) });
    }
    const row = new Map<string, unknown>();
    for (const [name, item] of entry as PlainMap) {
      const at = path(...where, key, i, name);
      const entryType = relation.properties.get(name)?.type as Schemas.OfAny.Data | undefined;
      if (name === adjacency.me) throw new DecodeError(`${repr(name)} is this object's own link, which is implied`, { path: at });
      if (relation.links.includes(name)) {
        if (!isRef(item)) throw new DecodeError("a link must be a reference", { path: at });
        row.set(name, new Link(item.get(REF) as string));
      } else if (entryType !== undefined && relation.links.length === 1 && context !== null) {
        row.set(name, decode(entryType, item, [...where, key, i, name], context, [...steps, [[key, i, name], kindOf(entryType)]]));
      } else if (entryType !== undefined) {
        row.set(name, decodeEntryProperty(entryType, item, [...where, key, i, name]));
      } else {
        throw new DecodeError(`the relation has no link or property ${repr(name)}`, { path: at });
      }
    }
    const missing = relation.links.filter((n) => n !== adjacency.me && !(entry as PlainMap).has(n));
    if (missing.length > 0) throw new DecodeError(`links ${repr(missing)} are not set`, { path: path(...where, key, i) });
    return row;
  });
}

/** Finds the references among the values of an object, at any depth: in its entries, and in the value objects and
 * lists nested in it. A mapping with a `$ref` key is a reference; nothing else is. */
function references(value: unknown, where: Where, found: (ref: PlainMap, where: Where) => void): void {
  if (value instanceof Map && value.has(REF)) {
    if (!isRef(value)) {
      throw new DecodeError("a reference is {'$ref': symbol, '$schema': name}, or {'$ref': symbol} to a value object",
        { path: path(...where) });
    }
    found(value, where);
  } else if (value instanceof Map) {
    for (const [key, item] of value) references(item, [...where, key], found);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => references(item, [...where, i], found));
  }
}

/** Per reference object symbol: its decoded property values and its entries. */
type Decoded = Map<string, [Map<string, unknown>, Rows]>;

/** Checks a snapshot against the schemas and decodes its values before anything is built. Returns the root symbol,
 * each reference object's schema name, the decoded reference objects, where each value object with a symbol is, and
 * the entries of value objects. Problems in the snapshot throw `DecodeError`. */
function check(store: Stores.Store, schema: unknown, plain: unknown): [string, Map<string, string>, Decoded, [Found, Rows, Schemas.OfObject.Data][]] {
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
  const names = new Map<string, string>([[root, store.name_of(schema)]]);
  const unnamed: [string, Where][] = []; // references without a schema, refused once more specific problems are not
  const found = (ref: PlainMap, where: Where): void => {
    const target = ref.get(REF) as string;
    if (!ref.has(SCHEMA)) { // the form a reference to a value object had; refused once the rest is checked
      unnamed.push([target, where]);
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
  for (const [symbol, obj] of objects as Map<string, PlainMap>) { // every object but the root is reached by a reference that names its schema
    for (const [key, value] of obj) references(value, ["objects", symbol, key], found);
  }

  // Pass 2: check every key against the schemas and decode the values.
  const decoded: Decoded = new Map();
  const entries: [Found, Rows, Schemas.OfObject.Data][] = [];
  for (const [symbol, obj] of objects as Map<string, PlainMap>) {
    const name = names.get(symbol);
    if (name === undefined) continue;
    let objectSchema: Schemas.OfObject.Data;
    try {
      objectSchema = store.schema(name);
    } catch (error) {
      if (error instanceof AttributeError || error instanceof LookupError || error instanceof TypeError) {
        throw new DecodeError(`no object schema registered as ${repr(name)}`, { path: path("objects", symbol) });
      }
      throw error;
    }
    if (!objectSchema.ref) throw new DecodeError(`${repr(name)} is not a reference object schema`, { path: path("objects", symbol) });
    const context = new Context(symbol, entries);
    const properties = new Map<string, unknown>();
    const adjacencies: Rows = new Map();
    for (const [key, value] of obj) {
      const where: Where = ["objects", symbol];
      const adjacency = objectSchema.adjacencies.get(key);
      const propertyType = objectSchema.properties.get(key)?.type as Schemas.OfAny.Data | undefined;
      if (adjacency !== undefined) {
        adjacencies.set(key, decodeRows(adjacency, value, where, key, context));
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
  for (const [target, where] of unnamed) {
    throw new DecodeError(`a reference names its target's schema: ${repr(target)} has none, and a link targets a `
      + "reference object", { path: path(...where) });
  }
  return [root, names, decoded, entries];
}

type BuilderLike = {
  create(): unknown;
  update(): unknown;
  property(name: string, callback: Callback<OfProperty>): unknown;
  adjacency(name: string, callback: Callback<OfAdjacency>): unknown;
};

function builderFor(store: Stores.Store, name: string, instance?: unknown): BuilderLike {
  return (instance === undefined ? store.builder(name) : store.builder(name, instance)) as BuilderLike;
}

/** Rebuilds objects from an object snapshot in `store`. Every reference must resolve within the snapshot:
 * reference objects are built first, with the value objects they hold, then the entries are added. */
function restore(store: Stores.Store, schema: Schemas.OfObject.Data, plain: unknown): unknown {
  const [root, names, decoded, entries] = check(store, schema, plain);
  const seen = new Map<string, number>();

  /** The entries of an adjacency not already added through another: entries written under each object they link are
   * one, by value where the relation has a `unique` clause, and, in an open relation, the k-th equal entry in one list
   * is the k-th in another. */
  const kept = (schema: Schemas.OfObject.Data, owner: string, key: string, rows: Map<string, unknown>[]): Map<string, unknown>[] => {
    const adjacency = schema.adjacencies.get(key) as Schemas.OfAdjacency.Data;
    const relation = adjacency.relation as Schemas.OfRelation.Data;
    const counts = new Map<string, number>();
    return rows.filter((row) => {
      const rowKey = keyOfRow(relation, adjacency.me, owner, row);
      const occurrence = (counts.get(rowKey) ?? -1) + 1;
      counts.set(rowKey, occurrence);
      const index = relation.open ? occurrence : 0;
      if (index < (seen.get(rowKey) ?? 0)) return false;
      seen.set(rowKey, index + 1);
      return true;
    });
  };
  const oneLink = (schema: Schemas.OfObject.Data, key: string): boolean =>
    ((schema.adjacencies.get(key) as Schemas.OfAdjacency.Data).relation as Schemas.OfRelation.Data).links.length === 1;

  const created = new Map<string, unknown>();
  for (const [symbol, [properties, adjacencies]] of decoded) {
    const name = names.get(symbol) as string;
    const objectSchema = store.schema(name);
    const globalName = objectSchema.singleton; // a singleton is the store's own instance, updated
    const builder = builderFor(store, name, globalName === null ? undefined : store.singleton(globalName));
    for (const [key, value] of properties) set(builder, key, value);
    for (const [key, rows] of adjacencies) { // a one-link relation's entries are its owner's, as its properties are
      if (!oneLink(objectSchema, key)) continue;
      for (const row of kept(objectSchema, symbol, key, rows)) builder.adjacency(key, (a) => a.add((x) => fill(x, row, () => null)));
    }
    created.set(symbol, globalName === null ? builder.create() : builder.update());
  }

  /** The reference object a symbol names: entries never reference value objects. */
  const resolve = (symbol: string): unknown => created.get(symbol);

  const nested = new Map<string, [Found, Rows, Schemas.OfObject.Data][]>();
  for (const [found, rows, valueSchema] of entries) {
    nested.set(found.owner, [...(nested.get(found.owner) ?? []), [found, rows, valueSchema]]);
  }
  /** Adds the entries of the value objects `symbol` holds, of one-link relations or of the others; whether any. Outer
   * value objects first: decoding found the inner ones first, and an inner one may be held by an outer one's entry. */
  const addNested = (builder: BuilderLike, symbol: string, oneLinkOnly: boolean): boolean => {
    let added = false;
    const outerFirst = [...(nested.get(symbol) ?? [])].sort((a, b) => a[0].steps.length - b[0].steps.length);
    for (const [found, rows, valueSchema] of outerFirst) {
      const at = `${found.owner}:${JSON.stringify(found.steps.map(([k]) => k))}`;
      const owner = `found:${at}`;
      const listed = new Map([...rows].filter(([key]) => oneLink(valueSchema, key) === oneLinkOnly)
        .map(([key, list]) => [key, kept(valueSchema, owner, key, list)] as const));
      // an edit with nothing to add would drop what another just added
      if ([...listed.values()].some((list) => list.length > 0)) {
        within(builder, found.steps, (v) => addRows(v, listed, resolve));
        added = true;
      }
    }
    return added;
  };

  // The value objects that one-link entries hold come first, in every object: a link may target any of them.
  for (const symbol of decoded.keys()) {
    const builder = builderFor(store, names.get(symbol) as string, created.get(symbol));
    if (addNested(builder, symbol, true)) builder.update();
  }
  for (const [symbol, [, adjacencies]] of decoded) {
    const objectSchema = store.schema(names.get(symbol) as string);
    const builder = builderFor(store, names.get(symbol) as string, created.get(symbol));
    for (const [key, rows] of adjacencies) {
      if (oneLink(objectSchema, key)) continue;
      for (const row of kept(objectSchema, symbol, key, rows)) builder.adjacency(key, (a) => a.add((x) => fill(x, row, resolve)));
    }
    addNested(builder, symbol, false);
    builder.update();
  }
  return created.get(root);
}

/** An entry's value, read from one end: its links' symbols, the owner's included, and its properties' values. */
function keyOfRow(relation: Schemas.OfRelation.Data, me: string, owner: string, row: Map<string, unknown>): string {
  const links = [[me, owner], ...[...row].filter(([, v]) => v instanceof Link).map(([name, v]) => [name, (v as Link).symbol])]
    .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
  const values = [...row].filter(([, v]) => !(v instanceof Link)).map(([name, v]) => [name, decodedKey(v)])
    .sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
  return JSON.stringify([schemaNumber(relation), links, values]);
}

const relationNumbers = new WeakMap<object, number>();
let nextRelation = 0;

/** A number for each relation, as Python's `id()` of it. */
function schemaNumber(relation: object): number {
  if (!relationNumbers.has(relation)) relationNumbers.set(relation, ++nextRelation);
  return relationNumbers.get(relation) as number;
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
  const [[key, kind], ...rest] = steps as [readonly [Step, ValueKind], ...Steps];
  const into = (a: OfAny): void => {
    const inner = (v: unknown) => within(v as OfObject, rest, then);
    if (kind === Schemas.OfUnion.Data) a.as_union(inner);
    else if (kind === Schemas.OfIntersection.Data) a.as_intersection(inner);
    else a.as_object(inner);
  };
  if (Array.isArray(key)) { // an entry's value: the entry at its position, then its property
    const [adjacency, position, name] = key as readonly [string, number, string];
    const found: OfEntry[] = [];
    visitor.adjacency(adjacency, (a) => a.entries((e) => found.push(e)));
    (found[position] as OfEntry).property(name, (p) => p.value(into));
  } else {
    visitor.property(key as string, (p) => p.value(into));
  }
}

function set(visitor: { property(name: string, callback: Callback<OfProperty>): unknown }, name: string, value: unknown): void {
  visitor.property(name, (p) => p.value((a) => write(a, value)));
}

/** Writes a decoded value: a scalar, a value object, union value or intersection value. */
function write(visitor: OfAny, value: unknown): void {
  if (value instanceof DecodedRecord && value.schema instanceof Schemas.OfUnion.Data) {
    visitor.as_union((u) => value.accept(u as unknown as OfObject));
  } else if (value instanceof DecodedRecord && value.schema instanceof Schemas.OfIntersection.Data) {
    visitor.as_intersection((i) => value.accept(i as unknown as OfObject));
  } else if (value instanceof DecodedRecord) {
    visitor.as_object((o) => value.accept(o));
  } else {
    visitor.as_scalar((n) => n.set(value as Scalar));
  }
}

function fill(visitor: OfEntry, row: Map<string, unknown>, resolve: (symbol: string) => unknown): void {
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

function toPlainOfScalar(schema: Schemas.OfScalar.Data, value: Scalar): PlainData {
  return schema.to_plain(value);
}

export interface ToPlainCall {
  (schema: unknown, value: unknown): PlainData;
  OfScalar(schema: Schemas.OfScalar.Data, value: Scalar): PlainData;
  /** Snapshot of `value` alone; its references to other objects are left unresolved. */
  OfObject(schema: Schemas.OfObject.Data, value: Visitable): PlainMap;
  /** Snapshot of `value` and every object reachable from it through adjacencies (see `Reachable`). */
  Reachable(schema: Schemas.OfObject.Data, value: Visitable): PlainMap;
}

/** Serializes values to plain data, naming the schemas of objects in `store`: `ToPlain(store)(schema, value)`
 * dispatches on the schema's kind. */
export function ToPlain(store: Stores.Store): ToPlainCall {
  const OfObject = (schema: Schemas.OfObject.Data, value: Visitable): PlainMap => new Snapshot(store).run(schema, value, [value]);
  const call = (schema: unknown, value: unknown): PlainData => {
    if (schema instanceof Schemas.OfScalar.Data) return toPlainOfScalar(schema, value as Scalar);
    if (schema instanceof Schemas.OfObject.Data) return OfObject(schema, value as Visitable);
    throw new NotImplementedError(`${schemaTypeName(schema)} is not supported by Plain yet`);
  };
  return Object.assign(call, {
    OfScalar: toPlainOfScalar,
    OfObject,
    Reachable: (schema: Schemas.OfObject.Data, value: Visitable): PlainMap => new Snapshot(store).run(schema, value, Reachable.of(value)),
  });
}

export interface FromPlainCall {
  (schema: unknown, plain: unknown): unknown;
  OfScalar(schema: Schemas.OfScalar.Data, plain: unknown): Scalar;
  OfObject(schema: Schemas.OfObject.Data, plain: unknown): unknown;
  Reachable(schema: Schemas.OfObject.Data, plain: unknown): unknown;
}

/** Deserializes plain data, building objects in `store`: `FromPlain(store)(schema, plain)` dispatches on the schema's
 * kind. */
export function FromPlain(store: Stores.Store): FromPlainCall {
  const OfScalar = (schema: Schemas.OfScalar.Data, plain: unknown): Scalar => {
    try {
      return schema.from_plain(plain);
    } catch (error) {
      throw (error as DecodeError).at("$"); // from_plain throws only DecodeError
    }
  };
  const OfObject = (schema: Schemas.OfObject.Data, plain: unknown): unknown => restore(store, schema, plain);
  const call = (schema: unknown, plain: unknown): unknown => {
    if (schema instanceof Schemas.OfScalar.Data) return OfScalar(schema, plain);
    if (schema instanceof Schemas.OfObject.Data) return OfObject(schema, plain);
    throw new NotImplementedError(`${schemaTypeName(schema)} is not supported by Plain yet`);
  };
  return Object.assign(call, { OfScalar, OfObject, Reachable: OfObject });
}

/** For `Bindings`: a value's decoded form from its plain form, writing a decoded value, and a symbol for none. */
export { decode as _decode, write as _write };
