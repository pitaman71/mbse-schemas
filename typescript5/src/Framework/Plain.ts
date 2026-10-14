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
 * identity (a singleton's instance included), updates that object through its builder: what the snapshot holds is
 * written, what it omits is kept, a container is written element by element, and a relation's entry is the one agreeing
 * with a row.
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

/** How the writers reference a linked object; `flat` says how a dense container of several int indices is written. */
type Ref = ((target: Readers.OfObject) => PlainMap) & { flat?: boolean };

/** The schema of a record: a value object's, or a union's or intersection's, whose properties are its branches or
 * parts. */
type RecordSchema = Schemas.OfObject.Data | Schemas.OfUnion.Data | Schemas.OfIntersection.Data;

/** Whether a value object's visitor visits one: a visitor of nothing has no schema. */
function present(visitor: any): boolean {
  return visitor.as_schema() !== null;
}

/** A property's value as plain data, read through its visitor, and whether it has one. */
function value(read: Readers.OfProperty, schema: unknown, ref: Ref): [boolean, PlainData] {
  const found: [boolean, PlainData][] = [];
  read.as_value((a) => found.push(anyValue(a, schema, ref)));
  return found[0] as [boolean, PlainData];
}

/** A value of any kind as plain data, read through its `Visitors.OfAny`, and whether it has one. */
function anyValue(read: any, schema: unknown, ref: Ref): [boolean, PlainData] {
  const held = Schemas.structure(schema);
  const found: PlainData[] = [];
  if (held instanceof Schemas.OfScalar.Data) {
    read.as_scalar((s: any) => {
      const got = s.get();
      if (got !== null) found.push(held.to_plain(got));
      return s;
    });
  } else if (held instanceof Schemas.OfObject.Data) {
    read.as_object((o: any) => {
      if (present(o)) found.push(object(o, held, ref));
      return o;
    });
  } else if (held instanceof Schemas.OfContainer.Data) {
    read.as_container((c: any) => {
      if (present(c)) found.push(container(c, held, ref));
      return c;
    });
  } else {
    const pick = (r: any): any => {
      if (present(r)) found.push(record(r, held as RecordSchema, ref));
      return r;
    };
    if (held instanceof Schemas.OfUnion.Data) read.as_union(pick);
    else read.as_intersection(pick);
  }
  return found.length > 0 ? [true, found[0] as PlainData] : [false, null];
}

/** The names of a container's int indices, where its index is a value object of ints; null otherwise. */
function tensor(schema: Schemas.OfContainer.Data): string[] | null {
  const index = Schemas.structure(schema.index);
  if (!(index instanceof Schemas.OfObject.Data)) return null;
  const all = [...index.properties.values()].every((prop) => {
    const held = Schemas.structure(prop.type);
    return held instanceof Schemas.OfScalar.Data && held.type === BigInt;
  });
  return all ? [...index.properties.keys()] : null;
}

/** Whether a container's index is an int. */
function ints(schema: Schemas.OfContainer.Data): boolean {
  const index = Schemas.structure(schema.index);
  return index instanceof Schemas.OfScalar.Data && index.type === BigInt;
}

/** An index as plain data: a scalar's plain form, or a value object index as a mapping of its properties. */
function plainIndex(schema: Schemas.OfContainer.Data, index: unknown, ref: Ref): PlainData {
  const held = Schemas.structure(schema.index);
  if (held instanceof Schemas.OfScalar.Data) return held.to_plain(index as Scalar);
  const object_ = held as Schemas.OfObject.Data;
  if (Array.isArray(index)) {
    return new Map([...object_.properties].map(([name, prop], i) =>
      [name, (Schemas.structure(prop.type) as Schemas.OfScalar.Data).to_plain(index[i] as Scalar)] as const));
  }
  return object(index as Readers.OfObject, object_, ref);
}

/** A container as plain data, as its arrangement writes it: a dense one of int indices as an array of its elements
 * (null where one is absent), of several int indices as nested arrays, or flat with its shape where the writer is
 * configured so (`ToPlain(store, { flat: true })`); a sparse one of int indices as its blocks, each the index it starts
 * at and its run of elements; a dict by a str index as a mapping; any other as an array of entry-like elements, each
 * its index and its element. */
function container(read: any, schema: Schemas.OfContainer.Data, ref: Ref): PlainData {
  const pairs: [unknown, unknown][] = [];
  read.as_entries((entries: Iterable<[unknown, unknown]>) => pairs.push(...entries));
  const element = (visitor: unknown): PlainData => anyValue(visitor, schema.element, ref)[1];
  const names = tensor(schema);
  const arrangement = schema.arrangement;
  if (arrangement === "dense" && ints(schema)) {
    const dense: PlainData[] = Array.from({ length: read.length }, () => null);
    for (const [index, visitor] of pairs) dense[Number(index)] = element(visitor);
    return dense;
  }
  if (arrangement === "dense" && names !== null && pairs.length > 0) {
    const shape = names.map((_, d) => Number(pairs.reduce((m: bigint, [index]) =>
      ((index as bigint[])[d] as bigint > m ? (index as bigint[])[d] as bigint : m), 0n)) + 1);
    const cells = new Map(pairs.map(([index, visitor]) => [JSON.stringify((index as bigint[]).map(String)), element(visitor)]));
    let all: string[][] = [[]];
    for (const size of shape) all = all.flatMap((cell) => Array.from({ length: size }, (_, i) => [...cell, String(i)]));
    let flat: PlainData[] = all.map((cell) => cells.get(JSON.stringify(cell)) ?? null);
    if (ref.flat === true) return new Map<string, PlainData>([["shape", shape.map(BigInt)], ["items", flat]]);
    for (const n of shape.slice(1).reverse()) {
      const chunked: PlainData[] = [];
      for (let i = 0; i < flat.length; i += n) chunked.push(flat.slice(i, i + n));
      flat = chunked;
    }
    return flat;
  }
  if (arrangement === "sparse" && (ints(schema) || names !== null)) {
    const blocks: PlainMap[] = [];
    let last: unknown = null;
    for (const [index, visitor] of pairs) {
      const follows = last !== null && (ints(schema) ? index === (last as bigint) + 1n
        : (index as bigint[]).slice(0, -1).every((i, d) => i === (last as bigint[])[d])
          && (index as bigint[]).at(-1) === ((last as bigint[]).at(-1) as bigint) + 1n);
      if (follows) ((blocks.at(-1) as PlainMap).get("items") as PlainData[]).push(element(visitor));
      else blocks.push(new Map<string, PlainData>([["at", plainIndex(schema, index, ref)], ["items", [element(visitor)]]]));
      last = index;
    }
    return blocks;
  }
  const held = Schemas.structure(schema.index);
  if (arrangement === "dict" && held instanceof Schemas.OfScalar.Data && held.type === String) {
    return new Map(pairs.map(([index, visitor]) => [index as string, element(visitor)]));
  }
  return pairs.map(([index, visitor]) =>
    new Map<string, PlainData>([["index", plainIndex(schema, index, ref)], ["element", element(visitor)]]));
}

/** A union's branch or an intersection's part as plain data: its visitor is of its type's kind. */
function memberValue(read: any, schema: unknown, ref: Ref): [boolean, PlainData] {
  const held = Schemas.structure(schema);
  if (held instanceof Schemas.OfScalar.Data) {
    const got = read.get();
    return got === null ? [false, null] : [true, held.to_plain(got)];
  }
  if (!present(read)) return [false, null];
  if (held instanceof Schemas.OfContainer.Data) return [true, container(read, held, ref)];
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
  private readonly ref: Ref;

  constructor(private readonly store: Stores.Store, flat = false) {
    /** A reference to a linked object, which is a reference object: entries never reference value objects. */
    this.ref = Object.assign((target: Readers.OfObject): PlainMap =>
      new Map<string, PlainData>([[REF, this.symbol(target)], [SCHEMA, this.store.name_of(target.as_schema())]]), { flat });
  }

  /** An object's key in a snapshot, and in the links to it: its identity, qualified by its schema's registered name
   * (`"crm.Feature/FEA-001"`); a global name alone, being unique in a store. */
  private symbol(value: Readers.OfObject): string {
    const schema = value.as_schema();
    if (schema.singleton !== null) return schema.singleton;
    return `${this.store.name_of(schema)}/${value.as_identity()}`;
  }


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

/** The order of two keys, value by value. */
function compareKeys(a: readonly unknown[], b: readonly unknown[]): number {
  for (let i = 0; i < a.length; i++) {
    const order = compareOrdered(a[i], b[i]);
    if (order !== 0) return order;
  }
  return 0;
}

/** Sorts the entries of each adjacency written in `plain`, an object of `schema`, by the key their relation declares
 * from the adjacency's end (`Schemas.OfRelation.Data.key`): where every entry has each of its values, and each holds
 * values of one ordered type (booleans false first, numbers by value, strings by code point). Otherwise, as where a key
 * holds a link, entries keep the order they were written in. */
function sortEntries(schema: Schemas.OfObject.Data, record: PlainMap): void {
  for (const [name, adjacency] of schema.adjacencies) {
    const relation = adjacency.relation as Schemas.OfRelation.Data;
    const [entries, names] = [record.get(name) as PlainMap[] | undefined, relation.key(adjacency.me)];
    if (entries === undefined || names === null) continue;
    const keys = entries.map((entry) => names.map((n) => entry.get(n)));
    const ordered = names.every((_, i) => {
      const kinds = new Set(keys.map((key) => typeof key[i]));
      return kinds.size === 1 && ORDERED.has([...kinds][0] as string);
    });
    if (ordered) entries.sort((a, b) => compareKeys(names.map((n) => a.get(n)), names.map((n) => b.get(n))));
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
 * builder. */
class DecodedRecord {
  constructor(readonly schema: RecordSchema, readonly values: Map<string, unknown>) {}
}

/** A decoded container: its elements, each with its index, which `fillElements` writes into its builder. */
class DecodedElements {
  constructor(readonly schema: Schemas.OfContainer.Data, readonly items: [unknown, unknown][]) {}
}

/** Writes a decoded value object, union value or intersection value through its builder. */
function build(visitor: any, record: DecodedRecord): any {
  for (const [name, value] of record.values) set(visitor, name, value);
  return visitor;
}

type Where = (string | number)[];
/** Per adjacency, its decoded entries: each maps links to `Link`s and properties to decoded values. */
type Rows = Map<string, Map<string, unknown>[]>;
/** The value `plain` holds under `schema`, located at the path `where`: a scalar, a `DecodedRecord` or
 * `DecodedElements`. */
function decode(type: Schemas.OfAny.Data, plain: unknown, where: Where): unknown {
  const schema = Schemas.structure(type) as Schemas.OfAny.Data;
  if (schema instanceof Schemas.OfScalar.Data) {
    try {
      return schema.from_plain(plain);
    } catch (error) {
      throw (error as DecodeError).at(path(...where)); // from_plain throws only DecodeError
    }
  }
  if (schema instanceof Schemas.OfContainer.Data) return decodeContainer(schema, plain, where);
  const [what, owner, member] = recordNames(schema as RecordSchema);
  if (!(plain instanceof Map)) throw new DecodeError(`${what} must be a mapping, got ${typeName(plain)}`, { path: path(...where) });
  const record = schema as RecordSchema;
  const values = new Map<string, unknown>();
  for (const [key, item] of plain as PlainMap) {
    const type = record.properties.get(key)?.type as Schemas.OfAny.Data | undefined;
    if (type === undefined) throw new DecodeError(`${owner} has no ${member} ${repr(key)}`, { path: path(...where, key) });
    values.set(key, decode(type, item, [...where, key]));
  }
  if (record instanceof Schemas.OfUnion.Data && values.size !== 1) {
    throw new DecodeError(`a union value holds exactly one branch, got ${values.size}`, { path: path(...where) });
  }
  return new DecodedRecord(record, values);
}

/** An index read from its plain form: a scalar, or a value object index as the array of its properties. */
function decodeIndex(schema: Schemas.OfContainer.Data, plain: unknown, where: Where): unknown {
  const held = Schemas.structure(schema.index);
  if (held instanceof Schemas.OfScalar.Data) return decode(held, plain, where);
  if (schema.arrangement === "entries") {
    throw new DecodeError("a container whose index is neither ordered nor hashable is not read from snapshots yet", { path: path(...where) });
  }
  const record = decode(held as Schemas.OfAny.Data, plain, where) as DecodedRecord;
  const names = [...(held as Schemas.OfObject.Data).properties.keys()];
  const missing = names.filter((name) => !record.values.has(name));
  if (missing.length > 0) {
    throw new DecodeError(`an index has every property of its value object; ${repr(missing)} are not set`, { path: path(...where) });
  }
  return names.map((name) => record.values.get(name));
}

/** A container read from the plain form its arrangement writes (see `container`); a dense one of several int indices
 * nested or flat, whichever it is. */
function decodeContainer(schema: Schemas.OfContainer.Data, plain: unknown, where: Where): DecodedElements {
  const items: [unknown, unknown][] = [];
  const element = (index: unknown, value: unknown, at: Where): void => {
    if (value !== null) items.push([index, decode(schema.element as Schemas.OfAny.Data, value, at)]);
  };
  const names = tensor(schema);
  const arrangement = schema.arrangement;
  const held = Schemas.structure(schema.index);
  if (arrangement === "dense" && ints(schema)) {
    if (!Array.isArray(plain)) throw new DecodeError(`a dense container must be a list, got ${typeName(plain)}`, { path: path(...where) });
    plain.forEach((value, i) => element(BigInt(i), value, [...where, i]));
  } else if (arrangement === "dense" && names !== null) {
    if (plain instanceof Map && plain.size === 2 && plain.has("shape") && plain.has("items")) { // flat, with its shape
      const shape = plain.get("shape");
      const flat = plain.get("items");
      const sizes = Array.isArray(shape) ? shape : [];
      const product = sizes.reduce((p: number, n) => p * Number(n), 1);
      if (!(Array.isArray(shape) && shape.length === names.length && shape.every((n) => typeof n === "bigint" && n >= 0n)
        && Array.isArray(flat) && flat.length === product)) {
        throw new DecodeError(`a flat container's shape is ${names.length} sizes, and its items as many as they make`, { path: path(...where) });
      }
      let cells: bigint[][] = [[]];
      for (const size of shape as bigint[]) cells = cells.flatMap((cell) => Array.from({ length: Number(size) }, (_, i) => [...cell, BigInt(i)]));
      cells.forEach((cell, i) => element(cell, (flat as unknown[])[i], [...where, "items", i]));
    } else {
      const nested = (value: unknown, prefix: bigint[], at: Where): void => {
        if (prefix.length === names.length) element(prefix, value, at);
        else if (!Array.isArray(value)) {
          throw new DecodeError(`a container of ${names.length} indices nests ${names.length} lists`, { path: path(...at) });
        } else value.forEach((inner, i) => nested(inner, [...prefix, BigInt(i)], [...at, i]));
      };
      nested(plain, [], where);
    }
  } else if (arrangement === "sparse" && (ints(schema) || names !== null)) {
    if (!Array.isArray(plain)) {
      throw new DecodeError(`a sparse container must be a list of blocks, got ${typeName(plain)}`, { path: path(...where) });
    }
    plain.forEach((block, b) => {
      if (!(block instanceof Map) || block.size !== 2 || !block.has("at") || !Array.isArray(block.get("items"))) {
        throw new DecodeError("a block is {'at': index, 'items': [element, ...]}", { path: path(...where, b) });
      }
      const start = decodeIndex(schema, block.get("at"), [...where, b, "at"]);
      (block.get("items") as unknown[]).forEach((value, i) => {
        const index = ints(schema) ? (start as bigint) + BigInt(i)
          : [...(start as bigint[]).slice(0, -1), ((start as bigint[]).at(-1) as bigint) + BigInt(i)];
        element(index, value, [...where, b, "items", i]);
      });
    });
  } else if (arrangement === "dict" && held instanceof Schemas.OfScalar.Data && held.type === String) {
    if (!(plain instanceof Map)) {
      throw new DecodeError(`a container keyed by text must be a mapping, got ${typeName(plain)}`, { path: path(...where) });
    }
    for (const [key, value] of plain as PlainMap) element(key, value, [...where, key]);
  } else {
    if (!Array.isArray(plain)) throw new DecodeError(`a container must be a list, got ${typeName(plain)}`, { path: path(...where) });
    plain.forEach((entry, i) => {
      if (!(entry instanceof Map) || [...entry.keys()].some((k) => k !== "index" && k !== "element") || !entry.has("index")) {
        throw new DecodeError("an entry of a container is {'index': index, 'element': element}", { path: path(...where, i) });
      }
      element(decodeIndex(schema, entry.get("index"), [...where, i, "index"]), entry.get("element") ?? null, [...where, i, "element"]);
    });
  }
  return new DecodedElements(schema, items);
}

/** Equality key of a decoded value, per EQUALITY.md. */
function decodedKey(value: unknown): string {
  if (value instanceof DecodedElements) {
    const keyed = value.items.map(([index, item]) => [Array.isArray(index) ? JSON.stringify(index.map(Proxies.scalarKey))
      : Proxies.scalarKey(index), decodedKey(item)]);
    return `container:${JSON.stringify(keyed.sort((a, b) => compareStrings(a[0] as string, b[0] as string)))}`;
  }
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

/** The entries of one adjacency, at `where` + `key`. */
function decodeRows(adjacency: Schemas.OfAdjacency.Data, value: unknown, where: Where, key: string): Map<string, unknown>[] {
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
      } else if (entryType !== undefined) {
        row.set(name, decode(entryType, item, [...where, key, i, name]));
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
 * each reference object's schema name, the decoded reference objects and their identities. Problems in the snapshot
 * throw `DecodeError`. */
function check(store: Stores.Store, schema: unknown, plain: unknown): [string, Map<string, string>, Decoded, Map<string, string>] {
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
    const properties = new Map<string, unknown>();
    const adjacencies: Rows = new Map();
    for (const [key, value] of obj) {
      const where: Where = ["objects", symbol];
      const adjacency = objectSchema.adjacencies.get(key);
      const propertyType = objectSchema.properties.get(key)?.type as Schemas.OfAny.Data | undefined;
      if (adjacency !== undefined) {
        adjacencies.set(key, decodeRows(adjacency, value, where, key));
      } else if (propertyType !== undefined) {
        properties.set(key, decode(propertyType, value, [...where, key]));
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
  return [root, names, decoded, identities];
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

/** Rebuilds objects from an object snapshot in `store`. Every reference must resolve within the snapshot:
 * reference objects are built first, with the value objects they hold, then the entries are added. */
function restore(store: Stores.Store, schema: Schemas.OfObject.Data, plain: unknown): unknown {
  const [root, names, decoded, identities] = check(store, schema, plain);
  const seen = new Map<string, number>();

  /** The entries of an adjacency not already added through another, each with its position in the snapshot's list
   * and which of the equal entries in it it is: entries written under each object they link are one, by value where
   * the relation has a `unique` clause, and, in an open relation, the k-th equal entry in one list is the k-th in
   * another. */
  const kept = (schema: Schemas.OfObject.Data, owner: string, key: string, rows: Map<string, unknown>[]): Kept[] => {
    const adjacency = schema.adjacencies.get(key) as Schemas.OfAdjacency.Data;
    const relation = adjacency.relation as Schemas.OfRelation.Data;
    const counts = new Map<string, number>();
    const keptRows: Kept[] = [];
    rows.forEach((row, position) => {
      const rowKey = keyOfRow(relation, adjacency.me, owner, row);
      const occurrence = (counts.get(rowKey) ?? -1) + 1;
      counts.set(rowKey, occurrence);
      const index = relation.open ? occurrence : 0;
      if (index < (seen.get(rowKey) ?? 0)) return;
      seen.set(rowKey, index + 1);
      keptRows.push([position, row, index]);
    });
    return keptRows;
  };

  // An update writes through the builders of what the object already holds: a property's value object and a container
  // are edited in place. A relation's entries have no order to visit by: a row is the entry agreeing with its links and
  // properties, the k-th equal row the k-th such entry, and added where none agrees.
  /** Writes `rows` into the adjacency builder `adjacency`. */
  const write = (adjacency: any, rows: Kept[], resolve: (symbol: string) => unknown): void => {
    for (const [, row, occurrence] of rows) {
      const found: any[] = [];
      adjacency.select((e: any) => fill(e, row, resolve), (e: any) => {
        const links = new Set((e.as_schema() as Schemas.OfEntry.Data).links.keys());
        const holding = [...(e.as_schema() as Schemas.OfEntry.Data).properties.keys()].filter((n) => holds(e, n));
        const wanted = [...row.keys()].filter((n) => !links.has(n));
        if (holding.length === wanted.length && wanted.every((n) => holding.includes(n))) found.push(e);
        return e;
      });
      if (occurrence < found.length) fill(found[occurrence], row, resolve);
      else adjacency.insert((x: any) => fill(x, row, resolve));
    }
  };

  const created = new Map<string, unknown>();
  for (const [symbol, [properties]] of decoded) {
    const name = names.get(symbol) as string;
    let existing: unknown = null;
    try { // an identity the store already holds, a singleton's included, is an update of that object
      existing = store.by_identity(name, identities.get(symbol) as string);
    } catch (error) {
      if (!(error instanceof LookupError)) throw error;
    }
    const builder = existing === null ? store.restore(name, identities.get(symbol) as string) : store.builder(name, existing);
    for (const [key, value] of properties) set(builder, key, value);
    created.set(symbol, existing === null ? builder.create() : builder.update());
  }

  /** The reference object a symbol names: entries never reference value objects. */
  const resolve = (symbol: string): unknown => created.get(symbol);

  for (const [symbol, [, adjacencies]] of decoded) {
    const objectSchema = store.schema(names.get(symbol) as string);
    const builder = store.builder(names.get(symbol) as string, created.get(symbol));
    for (const [key, rows] of adjacencies) write(builder[key], kept(objectSchema, symbol, key, rows), resolve);
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

/** A row kept for writing: its position in the snapshot's list, its decoded values, and which of the equal rows it is. */
type Kept = [number, Map<string, unknown>, number];

/** Whether an entry's visitor holds a value in its property `name`: a scalar, or a value of another kind. */
function holds(entry: any, name: string): boolean {
  const read = entry[name];
  if (read.get() !== null) return true;
  const found: any[] = [];
  const keep = (v: any): any => {
    found.push(v);
    return v;
  };
  read.as_value((a: any) => a.as_object(keep).as_union(keep).as_intersection(keep));
  return found.some(present);
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

/** Writes a decoded value into the member `name`: a scalar, a value object, union value or intersection value. */
function set(visitor: any, name: string, value: unknown): void {
  const member = visitor[name];
  if (value instanceof DecodedElements) {
    if (holdsMembers(visitor)) member((held: any) => fillElements(held, value));
    else member.as_value((a: any) => a.as_container((held: any) => fillElements(held, value)));
  } else if (!(value instanceof DecodedRecord)) member(value);
  else if (holdsMembers(visitor)) member((held: any) => build(held, value));
  else member.as_value((a: any) => a[selectOf(value.schema.constructor)]((held: any) => build(held, value)));
}

/** Writes a decoded container through its builder, each element at its index, over what it held there. */
function fillElements(held: any, elements: DecodedElements): any {
  for (const [index, value] of elements.items) put(held.at(index), value);
  return held;
}

/** Writes a decoded value through a `Visitors.OfAny`: a scalar, a value object, union value or intersection value, or a
 * container. */
function put(element: any, value: unknown): void {
  if (value instanceof DecodedElements) element.as_container((held: any) => fillElements(held, value));
  else if (value instanceof DecodedRecord) element[selectOf(value.schema.constructor)]((held: any) => build(held, value));
  else element.as_scalar(value);
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
 * dispatches on the schema's kind. `{ flat: true }` writes a dense container of several int indices flat, with its
 * shape, rather than as nested arrays; reading takes either. */
export function ToPlain(store: Stores.Store, options: { flat?: boolean } = {}): ToPlainCall {
  const flat = options.flat ?? false;
  const OfObject = (schema: Schemas.OfObject.Data, value: Readers.OfObject): PlainMap => new Snapshot(store, flat).run(schema, value, [value]);
  const call = (schema: unknown, value: unknown): PlainData => {
    if (schema instanceof Schemas.OfScalar.Data) return toPlainOfScalar(schema, value as Scalar);
    if (schema instanceof Schemas.OfObject.Data) return OfObject(schema, value as Readers.OfObject);
    throw new NotImplementedError(`${schemaTypeName(schema)} is not supported by Plain yet`);
  };
  return Object.assign(call, {
    OfScalar: toPlainOfScalar,
    OfObject,
    Reachable: (schema: Schemas.OfObject.Data, value: Readers.OfObject): PlainMap => new Snapshot(store, flat).run(schema, value, Reachable.of(value)),
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
