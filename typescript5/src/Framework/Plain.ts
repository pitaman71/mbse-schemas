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
 * An object snapshot has the shape `{"root": key, "objects": {key: object}}`. An object's key is its identity
 * qualified by its schema's registered name, `"Feature/FEA-001"`, or a singleton's global name alone. Each object maps
 * property names to plain values and adjacency names to lists of entries. An entry maps the other links to references
 * and the entry properties to plain values; the object's own link is implied. A reference is
 * `{"$ref": key, "$schema": name}`: object content carries no schema, so references carry the schema name, and the
 * root schema is passed in.
 *
 * `ToPlain(store).OfObject` includes only the root object, so its references are unresolved and `FromPlain` rejects
 * them. `ToPlain(store).Reachable` also includes every object reachable through adjacencies (see `Reachable`). Decoding
 * builds each object in the store with the identity its key gives, or, where the store holds a live object of that
 * identity (a singleton's instance included), replaces that object's state.
 *
 * The serializers read values through the visitor protocol (`Readers.OfObject`), and decoding writes them through a
 * store's builders (`Visitors.OfObject`).
 *
 * A value object (a property whose schema is an `OfObject`) is written nested, as a mapping of its properties.
 * Union and intersection values are written the same way, with the union's branches or the intersection's parts as
 * the properties: a union value `{"phone": {"number": "+44"}}` holds exactly one branch, and an intersection value
 * `{"stamp": {...}, "audit": {...}}` each of its parts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { AttributeError, DecodeError, LookupError, NotImplementedError, path } from "./Errors.js";
import * as Proxies from "./Proxies.js";
import * as Reachable from "./Reachable.js";
import type * as Readers from "./Readers.js";
import { compareStrings, repr, sortedStrings, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type * as Stores from "./Stores.js";
import type { Scalar } from "./Visitors.js";

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

// --- Writing: plain data read through the visitor protocol ---

type Ref = (target: Readers.OfObject) => PlainMap;

/** The schema of a record: a value object's, or a union's or intersection's, whose properties are its branches or
 * parts. */
type RecordSchema = Schemas.OfObject.Data | Schemas.OfUnion.Data | Schemas.OfIntersection.Data;

/** Whether a value object's visitor visits one: a visitor of nothing has no schema. */
function present(visitor: any): boolean {
  return visitor.as_schema() !== null;
}

/** A property's value as plain data, read through its visitor, and whether it has one. */
function value(read: Readers.OfProperty, schema: unknown, ref: Ref): [boolean, PlainData] {
  const held = Schemas.structure(schema);
  const found: PlainData[] = [];
  if (held instanceof Schemas.OfScalar.Data) {
    read.as_scalar((s) => {
      const got = s.get();
      if (got !== null) found.push(held.to_plain(got));
      return s;
    });
  } else if (held instanceof Schemas.OfObject.Data) {
    read.as_object((o) => {
      if (present(o)) found.push(object(o, held, ref));
      return o;
    });
  } else {
    const pick = (r: any): any => {
      if (present(r)) found.push(record(r, held as RecordSchema, ref));
      return r;
    };
    read.as_value((a) => held instanceof Schemas.OfUnion.Data ? a.as_union(pick) : a.as_intersection(pick));
  }
  return found.length > 0 ? [true, found[0] as PlainData] : [false, null];
}

/** A union's branch or an intersection's part as plain data: its visitor is of its type's kind. */
function memberValue(read: any, schema: unknown, ref: Ref): [boolean, PlainData] {
  const held = Schemas.structure(schema);
  if (held instanceof Schemas.OfScalar.Data) {
    const got = read.get();
    return got === null ? [false, null] : [true, held.to_plain(got)];
  }
  if (!present(read)) return [false, null];
  return [true, held instanceof Schemas.OfObject.Data ? object(read, held, ref) : record(read, held as RecordSchema, ref)];
}

/** A union value or an intersection value, nested as a mapping of its branch or its parts. */
function record(read: any, schema: RecordSchema, ref: Ref): PlainMap {
  const out: PlainMap = new Map();
  for (const [name, member] of schema.properties) {
    const [found, plain] = memberValue(read[name], member.type, ref);
    if (found) out.set(name, plain);
  }
  return out;
}

/** An object, a reference object or a value object nested in its owner, as a mapping: its properties, in the schema's
 * order, then its adjacencies' entries. A value object has no symbol: entries never reference value objects. */
function object(read: Readers.OfObject, schema: Schemas.OfObject.Data, ref: Ref): PlainMap {
  const out: PlainMap = new Map();
  for (const prop of read.as_properties) { // the properties that are set
    out.set(prop.as_schema().name, value(prop, prop.as_schema().type, ref)[1]);
  }
  for (const [name, adjacency] of schema.adjacencies) {
    const entries = [...(read[name] as Readers.OfAdjacency)].map((held) => entry(held, adjacency, ref));
    if (entries.length > 0) out.set(name, entries);
  }
  return out;
}

/** An entry as a mapping: the links other than the object's own, as references, then its properties. */
function entry(read: Readers.OfEntry, adjacency: Schemas.OfAdjacency.Data, ref: Ref): PlainMap {
  const out: PlainMap = new Map();
  const relation = adjacency.relation as Schemas.OfRelation.Data;
  for (const name of relation.entry.links.keys()) {
    if (name !== adjacency.me) out.set(name, ref(read[name] as Readers.OfObject));
  }
  for (const [name, prop] of relation.entry.properties) {
    const [found, plain] = value(read[name] as Readers.OfProperty, prop.type, ref);
    if (found) out.set(name, plain);
  }
  return out;
}

// --- Snapshots ---

/** Writes the included objects, in first-reference order, each keyed by its qualified identity. */
class Snapshot {
  constructor(private readonly store: Stores.Store) {}

  /** An object's key in a snapshot, and in the links to it: its identity, qualified by its schema's registered name
   * (`"crm.Feature/FEA-001"`); a global name alone, being unique in a store. */
  private symbol(value: Readers.OfObject): string {
    const schema = value.as_schema();
    if (schema.singleton !== null) return schema.singleton;
    return `${this.store.name_of(schema)}/${value.as_identity()}`;
  }

  /** A reference to a linked object, which is a reference object: entries never reference value objects. */
  private readonly ref = (target: Readers.OfObject): PlainMap =>
    new Map<string, PlainData>([[REF, this.symbol(target)], [SCHEMA, this.store.name_of(target.as_schema())]]);

  run(schema: Schemas.OfObject.Data, root: Readers.OfObject, include: Readers.OfObject[]): PlainMap {
    if (root.as_schema() !== schema) {
      throw new TypeError(`value is a ${repr(root.as_schema().name)}, not an instance of the given schema`);
    }
    if (!schema.ref) {
      throw new TypeError(`a snapshot's root must be a reference object; ${repr(schema.name)} is a value object schema`);
    }
    const objects: PlainMap = new Map();
    for (const value of include) {
      const out = object(value, value.as_schema(), this.ref);
      sortEntries(value.as_schema(), out);
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
      for (const [held, prop] of relation.entry.properties) if (entry.has(held)) sortEntries(prop.type, entry.get(held));
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

/** A decoded value object (an object's, a union value or an intersection value), which `build` writes into its
 * builder. Its entries are added once every object is built. */
class DecodedRecord {
  constructor(readonly schema: RecordSchema, readonly values: Map<string, unknown>) {}
}

/** Writes a decoded value object, union value or intersection value through its builder. */
function build(visitor: any, record: DecodedRecord): any {
  for (const [name, value] of record.values) set(visitor, name, value);
  return visitor;
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
  for (const [key, item] of plain as PlainMap) {
    const type = record.properties.get(key)?.type as Schemas.OfAny.Data | undefined;
    const adjacency = adjacencies.get(key);
    if (adjacency !== undefined && context !== null) { // a value object an entry of two links holds has none (validate())
      rows.set(key, decodeRows(adjacency, item, where, key, context, steps));
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
  return new DecodedRecord(record, values);
}

/** Equality key of a decoded value, per EQUALITY.md. */
function decodedKey(value: unknown): string {
  if (value instanceof DecodedRecord) {
    return `record:${JSON.stringify(sortedStrings(value.values.keys()).map((name) => [name, decodedKey(value.values.get(name))]))}`;
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
      const entryType = relation.entry.properties.get(name)?.type as Schemas.OfAny.Data | undefined;
      if (name === adjacency.me) throw new DecodeError(`${repr(name)} is this object's own link, which is implied`, { path: at });
      if (relation.entry.links.has(name)) {
        if (!isRef(item)) throw new DecodeError("a link must be a reference", { path: at });
        row.set(name, new Link(item.get(REF) as string));
      } else if (entryType !== undefined && relation.entry.links.size === 1 && context !== null) {
        row.set(name, decode(entryType, item, [...where, key, i, name], context, [...steps, [[key, i, name], kindOf(entryType)]]));
      } else if (entryType !== undefined) {
        row.set(name, decodeEntryProperty(entryType, item, [...where, key, i, name]));
      } else {
        throw new DecodeError(`the relation has no link or property ${repr(name)}`, { path: at });
      }
    }
    const missing = [...relation.entry.links.keys()].filter((n) => n !== adjacency.me && !(entry as PlainMap).has(n));
    if (missing.length > 0) throw new DecodeError(`links ${repr(missing)} are not set`, { path: path(...where, key, i) });
    return row;
  });
}

/** Finds the references among the values of an object, at any depth: in its entries, and in the value objects and
 * lists nested in it. A mapping with a `$ref` key is a reference; nothing else is. */
function references(value: unknown, where: Where, found: (ref: PlainMap, where: Where) => void): void {
  if (value instanceof Map && value.has(REF)) {
    if (!isRef(value)) {
      throw new DecodeError("a reference is {'$ref': key, '$schema': name}, or {'$ref': key} to a value object",
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
function check(store: Stores.Store, schema: unknown, plain: unknown):
  [string, Map<string, string>, Decoded, [Found, Rows, Schemas.OfObject.Data][], Map<string, string>] {
  if (!(schema instanceof Schemas.OfObject.Data)) {
    throw new TypeError(`the root schema must be an object schema, got ${schemaTypeName(schema)}`);
  }
  if (!schema.ref) throw new TypeError("the root schema must be a reference object schema");
  if (!(plain instanceof Map) || plain.size !== 2 || !plain.has("root") || !(plain.get("objects") instanceof Map)) {
    throw new DecodeError("expected an object snapshot: {'root': key, 'objects': {key: object}}", { path: "$" });
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
  const identities = new Map<string, string>();
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
    identities.set(symbol, identityOf(symbol, name, objectSchema));
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
  return [root, names, decoded, entries, identities];
}

/** The identity a snapshot's key gives an object of `schema`, registered as `name`: the key is the identity, qualified
 * by `name` (`"crm.Feature/FEA-001"`), or a singleton's global name alone. */
function identityOf(symbol: string, name: string, schema: Schemas.OfObject.Data): string {
  const where = path("objects", symbol);
  if (schema.singleton !== null) {
    if (symbol !== schema.singleton) {
      throw new DecodeError(`the singleton ${repr(name)} is keyed by its global name ${repr(schema.singleton)}`, { path: where });
    }
    return symbol;
  }
  const identity = symbol.slice(name.length + 1);
  if (!symbol.startsWith(`${name}/`) || identity === "") {
    throw new DecodeError(`a ${repr(name)} is keyed by its identity qualified by its schema's name, e.g. '${name}/<name>'`,
      { path: where });
  }
  if (schema.pattern !== null && schema.number_of(identity) === null) {
    throw new DecodeError(`${repr(identity)} is not a name ${repr(name)}'s naming pattern ${repr(schema.pattern)} gives`,
      { path: where });
  }
  return identity;
}

/** A builder over a live object that a snapshot updates, emptied: the snapshot holds the object's whole state, so what
 * it does not hold, the object no longer does. */
function replaced(builder: any): any {
  for (const prop of [...builder.as_properties]) prop.as_value((v: any) => v.clear());
  builder.as_adjacencies((a: any) => a.remove((e: any) => e)); // an empty template agrees with every entry
  return builder;
}

/** Rebuilds objects from an object snapshot in `store`. Every reference must resolve within the snapshot:
 * reference objects are built first, with the value objects they hold, then the entries are added. */
function restore(store: Stores.Store, schema: Schemas.OfObject.Data, plain: unknown): unknown {
  const [root, names, decoded, entries, identities] = check(store, schema, plain);
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
    ((schema.adjacencies.get(key) as Schemas.OfAdjacency.Data).relation as Schemas.OfRelation.Data).entry.links.size === 1;

  const created = new Map<string, unknown>();
  for (const [symbol, [properties, adjacencies]] of decoded) {
    const name = names.get(symbol) as string;
    const objectSchema = store.schema(name);
    let existing: unknown = null;
    try { // an identity the store already holds, a singleton's included, is an update of that object
      existing = store.by_identity(name, identities.get(symbol) as string);
    } catch (error) {
      if (!(error instanceof LookupError)) throw error;
    }
    const builder = existing === null ? store.restore(name, identities.get(symbol) as string) : replaced(store.builder(name, existing));
    for (const [key, value] of properties) set(builder, key, value);
    for (const [key, rows] of adjacencies) { // a one-link relation's entries are its owner's, as its properties are
      if (!oneLink(objectSchema, key)) continue;
      for (const row of kept(objectSchema, symbol, key, rows)) builder[key].insert((x: any) => fill(x, row, () => null));
    }
    created.set(symbol, existing === null ? builder.create() : builder.update());
  }

  /** The reference object a symbol names: entries never reference value objects. */
  const resolve = (symbol: string): unknown => created.get(symbol);

  const nested = new Map<string, [Found, Rows, Schemas.OfObject.Data][]>();
  for (const [found, rows, valueSchema] of entries) {
    nested.set(found.owner, [...(nested.get(found.owner) ?? []), [found, rows, valueSchema]]);
  }
  /** Adds the entries of the value objects `symbol` holds, of one-link relations or of the others; whether any. Outer
   * value objects first: decoding found the inner ones first, and an inner one may be held by an outer one's entry. */
  const addNested = (builder: any, symbol: string, oneLinkOnly: boolean): boolean => {
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
    const builder = store.builder(names.get(symbol) as string, created.get(symbol));
    if (addNested(builder, symbol, true)) builder.update();
  }
  for (const [symbol, [, adjacencies]] of decoded) {
    const objectSchema = store.schema(names.get(symbol) as string);
    const builder = store.builder(names.get(symbol) as string, created.get(symbol));
    for (const [key, rows] of adjacencies) {
      if (oneLink(objectSchema, key)) continue;
      for (const row of kept(objectSchema, symbol, key, rows)) builder[key].insert((x: any) => fill(x, row, resolve));
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

function addRows(visitor: any, rows: Rows, resolve: (symbol: string) => unknown): void {
  for (const [key, list] of rows) {
    for (const row of list) visitor[key].insert((x: any) => fill(x, row, resolve));
  }
}

/** The `Visitors.OfAny` method that selects a record kind. */
function selectOf(kind: unknown): "as_object" | "as_union" | "as_intersection" {
  return kind === Schemas.OfUnion.Data ? "as_union" : kind === Schemas.OfIntersection.Data ? "as_intersection" : "as_object";
}

/** Whether a visitor's members are a union's branches or an intersection's parts, each of its own type's kind, rather
 * than properties. */
function holdsMembers(visitor: any): boolean {
  const schema = visitor.as_schema();
  return schema instanceof Schemas.OfUnion.Data || schema instanceof Schemas.OfIntersection.Data;
}

/** Calls `then` with the builder of the value object at `steps` from `visitor`, editing each value on the way. */
function within(visitor: any, steps: Steps, then: (visitor: any) => void): void {
  if (steps.length === 0) {
    then(visitor);
    return;
  }
  const [[key, kind], ...rest] = steps as [readonly [Step, ValueKind], ...Steps];
  const into = (held: any): any => {
    within(held, rest, then);
    return held;
  };
  if (Array.isArray(key)) { // an entry's value: the entry at its position, then its property
    const [adjacency, position, name] = key as readonly [string, number, string];
    const found = [...visitor[adjacency]][position];
    found[name].as_value((a: any) => a[selectOf(kind)](into));
  } else if (holdsMembers(visitor)) {
    into(visitor[key as string]);
  } else {
    visitor[key as string].as_value((a: any) => a[selectOf(kind)](into));
  }
}

/** Writes a decoded value into the member `name`: a scalar, a value object, union value or intersection value. */
function set(visitor: any, name: string, value: unknown): void {
  const member = visitor[name];
  if (!(value instanceof DecodedRecord)) member(value);
  else if (holdsMembers(visitor)) member((held: any) => build(held, value));
  else member.as_value((a: any) => a[selectOf(value.schema.constructor)]((held: any) => build(held, value)));
}

function fill(visitor: any, row: Map<string, unknown>, resolve: (symbol: string) => unknown): any {
  for (const [key, value] of row) { // links map to target symbols; properties to decoded values
    if (value instanceof Link) visitor[key](resolve(value.symbol));
    else set(visitor, key, value);
  }
  return visitor;
}

// --- Entry points ---

function toPlainOfScalar(schema: Schemas.OfScalar.Data, value: Scalar): PlainData {
  return schema.to_plain(value);
}

export interface ToPlainCall {
  (schema: unknown, value: unknown): PlainData;
  OfScalar(schema: Schemas.OfScalar.Data, value: Scalar): PlainData;
  /** Snapshot of `value` alone; its references to other objects are left unresolved. */
  OfObject(schema: Schemas.OfObject.Data, value: Readers.OfObject): PlainMap;
  /** Snapshot of `value` and every object reachable from it through adjacencies (see `Reachable`). */
  Reachable(schema: Schemas.OfObject.Data, value: Readers.OfObject): PlainMap;
}

/** Serializes values to plain data, naming the schemas of objects in `store`: `ToPlain(store)(schema, value)`
 * dispatches on the schema's kind. */
export function ToPlain(store: Stores.Store): ToPlainCall {
  const OfObject = (schema: Schemas.OfObject.Data, value: Readers.OfObject): PlainMap => new Snapshot(store).run(schema, value, [value]);
  const call = (schema: unknown, value: unknown): PlainData => {
    if (schema instanceof Schemas.OfScalar.Data) return toPlainOfScalar(schema, value as Scalar);
    if (schema instanceof Schemas.OfObject.Data) return OfObject(schema, value as Readers.OfObject);
    throw new NotImplementedError(`${schemaTypeName(schema)} is not supported by Plain yet`);
  };
  return Object.assign(call, {
    OfScalar: toPlainOfScalar,
    OfObject,
    Reachable: (schema: Schemas.OfObject.Data, value: Readers.OfObject): PlainMap => new Snapshot(store).run(schema, value, Reachable.of(value)),
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
