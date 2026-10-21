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
 * A standalone value, of a value object, union, intersection, container or `OfAny` schema, is written by
 * `ToPlain(store)(schema, value)` as a property holding it writes it, and read back by `FromPlain(store)(schema, plain)`
 * through the store's builder of its schema, which the store registers (`.Value` is the per-kind form).
 *
 * A value object (a property whose schema is an `OfObject`) is written nested, as a mapping of its properties.
 * Union and intersection values are written the same way, with the union's branches or the intersection's parts as
 * the properties: a union value `{"phone": {"number": "+44"}}` holds exactly one branch, and an intersection value
 * `{"stamp": {...}, "audit": {...}}` each of its parts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Builders from "./Builders.js";
import { AttributeError, DecodeError, LookupError, NotImplementedError, path, ValueError } from "./Errors.js";
import * as Json from "./JSON.js";
import * as Paths from "./Paths.js";
import * as Proxies from "./Proxies.js";
import * as Reachable from "./Reachable.js";
import type * as Readers from "./Readers.js";
import { compareStrings, repr, sortedStrings, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import * as Transactions from "./Transactions.js";
import type * as Visitors from "./Visitors.js";
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
type Ref = ((target: Readers.OfObject) => PlainMap) & { flat?: boolean; store?: Visitors.OfStore };

/** The schema of a record: a value object's, or a union's or intersection's, whose properties are its branches or
 * parts. */
type RecordSchema = Schemas.OfObject.Data | Schemas.OfUnion.Data | Schemas.OfIntersection.Data;

/** Whether a value object's visitor visits one: a visitor of nothing has no schema. */
function present(visitor: any): boolean {
  return visitor.as_schema() !== null;
}

/** A property's value as plain data, read through its visitor, and whether it has one. */
/** What `value` needs to write a value, for a store: the names of the schemas of the values it holds. */
export function _names(store: Visitors.OfStore): Ref {
  return new Document(store, false).ref; // a document's, holding no object: values hold no references
}

export function _value(read: Readers.OfProperty, schema: unknown, ref: Ref): [boolean, PlainData] {
  return value(read, schema, ref);
}

function value(read: Readers.OfProperty, schema: unknown, ref: Ref): [boolean, PlainData] {
  const found: [boolean, PlainData][] = [];
  read.as_value((a) => found.push(anyValue(a, schema, ref)));
  return found[0] as [boolean, PlainData];
}

/** A value of any kind as plain data, read through its `Visitors.OfAny`, and whether it has one. */
function anyValue(read: any, schema: unknown, ref: Ref): [boolean, PlainData] {
  const held = schema;
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
  } else if (held instanceof Schemas.OfAny.Value) {
    return anyOfAny(read, held, ref);
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

/** A value of any schema as plain data, and whether there is one: restricted, written bare as the schema it holds;
 * unrestricted, tagged with its schema, a basic scalar's tag or its schema's registered name. */
function anyOfAny(read: any, schema: Schemas.OfAny.Value, ref: Ref): [boolean, PlainData] {
  const found: any[] = [];
  read.as_scalar((s: any) => {
    if (s.get() !== null) found.push(s.get());
    return s;
  });
  for (const select of ["as_object", "as_union", "as_intersection", "as_container"]) {
    read[select]((v: any) => {
      if (present(v)) found.push(v);
      return v;
    });
  }
  if (found.length === 0) return [false, null];
  const [value] = found;
  const restricted = [...schema.schemas];
  const host = Schemas.hostOf(value);
  if (host !== null) {
    const scalar = new Schemas.OfScalar.Data(host);
    if (restricted.length === 0) return [true, new Map([[scalar.tag as string, scalar.to_plain(value)]])];
    const own = restricted.find((t) => t instanceof Schemas.OfScalar.Data && t.type === scalar.type);
    if (own === undefined) { // builders do not check scalars' values; proxies refuse a value of another schema
      throw new TypeError(`a value of any schema holds one of its schemas; ${typeName(value)} is not one`);
    }
    return anyValue(read, own, ref);
  }
  const own = value.as_schema();
  if (restricted.length > 0) return [true, anyValue(read, own, ref)[1]];
  let name: string;
  try {
    name = (ref.store as Visitors.OfStore).name_of(own);
  } catch { // a store's name_of refuses an unregistered schema
    throw new TypeError(`a value of any schema is of a registered schema; ${repr(own.name)} is not registered`);
  }
  return [true, new Map([[name, anyValue(read, own, ref)[1]]])];
}

/** The names of a container's int indices, where its index is a value object of ints; null otherwise. */
function tensor(schema: Schemas.OfContainer.Data): string[] | null {
  const index = schema.index;
  if (!(index instanceof Schemas.OfObject.Data)) return null;
  const all = [...index.properties.values()].every((prop) => {
    const held = prop.schema;
    return held instanceof Schemas.OfScalar.Data && held.type === BigInt;
  });
  return all ? [...index.properties.keys()] : null;
}

/** Whether a container's index is an int. */
function ints(schema: Schemas.OfContainer.Data): boolean {
  const index = schema.index;
  return index instanceof Schemas.OfScalar.Data && index.type === BigInt;
}

/** An index as plain data: a scalar's plain form, or a value object index as a mapping of its properties. */
function plainIndex(schema: Schemas.OfContainer.Data, index: unknown, ref: Ref): PlainData {
  const held = schema.index;
  if (held instanceof Schemas.OfScalar.Data) return held.to_plain(index as Scalar);
  const object_ = held as Schemas.OfObject.Data;
  if (Array.isArray(index)) {
    return new Map([...object_.properties].map(([name, prop], i) =>
      [name, (prop.schema as Schemas.OfScalar.Data).to_plain(index[i] as Scalar)] as const));
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
  const held = schema.index;
  if (arrangement === "dict" && held instanceof Schemas.OfScalar.Data && held.type === String) {
    return new Map(pairs.map(([index, visitor]) => [index as string, element(visitor)]));
  }
  return pairs.map(([index, visitor]) =>
    new Map<string, PlainData>([["index", plainIndex(schema, index, ref)], ["element", element(visitor)]]));
}

/** A union's branch or an intersection's part as plain data: its visitor is of its schema's kind. */
function memberValue(read: any, schema: unknown, ref: Ref): [boolean, PlainData] {
  const held = schema;
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
    const [found, plain] = memberValue(read[name], member.schema, ref);
    if (found) out.set(name, plain);
  }
  return out;
}

/** A value object, nested in what holds it, as a mapping of its properties that are set, in the schema's order; it has
 * no adjacencies, and nothing links it. */
function object(read: Readers.OfObject, _schema: Schemas.OfObject.Data, ref: Ref): PlainMap {
  const out: PlainMap = new Map();
  for (const prop of read.as_properties) out.set(prop.as_schema().name, value(prop, prop.as_schema().schema, ref)[1]);
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
    const [found, plain] = value(read[name] as Readers.OfProperty, prop.schema, ref);
    if (found) out.set(name, plain);
  }
  return out;
}

/** The schemas of the values `ToPlain(store).Value` and `FromPlain(store).Value` take. */
const VALUES = [Schemas.OfObject.Data, Schemas.OfUnion.Data, Schemas.OfIntersection.Data, Schemas.OfContainer.Data,
  Schemas.OfAny.Value] as const;

/** The visitor of no value: no schema, and nothing to read. */
const NOTHING = { as_schema: (): null => null, get: (): null => null };

/** A standalone value, read as the `Readers.OfAny` that holds it: its own kind's visitor, or nothing for another; a
 * scalar given as itself. */
class Held {
  constructor(private readonly value: any) {}

  private hand(cb: (visitor: any) => unknown, kind: unknown): this {
    const scalar = Schemas.hostOf(this.value) !== null;
    if (kind === Schemas.OfScalar.Data) cb(scalar ? this : NOTHING);
    else cb(!scalar && this.value.as_schema() instanceof (kind as Function) ? this.value : NOTHING);
    return this;
  }

  get(): unknown {
    return this.value;
  }

  as_scalar(cb: (visitor: any) => unknown): this {
    return this.hand(cb, Schemas.OfScalar.Data);
  }

  as_object(cb: (visitor: any) => unknown): this {
    return this.hand(cb, Schemas.OfObject.Data);
  }

  as_union(cb: (visitor: any) => unknown): this {
    return this.hand(cb, Schemas.OfUnion.Data);
  }

  as_intersection(cb: (visitor: any) => unknown): this {
    return this.hand(cb, Schemas.OfIntersection.Data);
  }

  as_container(cb: (visitor: any) => unknown): this {
    return this.hand(cb, Schemas.OfContainer.Data);
  }
}

// --- Documents ---

/** A Reachable document, or an object's: one transaction (docs/OBJECT_IDENTITY.md, Decided, 51, 55; Store overhaul, 4f),
 * one upsert whose symbols are the objects the document holds, named by their number in the order it meets them, the root
 * `"0"`: the root, and, for Reachable, the counted objects reachable from it through the objects the document holds. Its
 * spec gives each object's properties and its named adjacencies' entries, each entry once, from the first object that
 * holds it; an object it does not hold, an owned object, a singleton or a schema object, is referred to by its path. Under
 * the caller's uid, which keys its upsert, so that reading it again while its counted objects are held finds them
 * (102). Its `ref` is the values' too, which hold no references. */
class Document {
  readonly ref: Ref;
  /** Each object the document holds: its number. */
  private readonly numbers = new Map<unknown, number>();
  private readonly order: any[] = [];
  /** Reading entries' keys: what they link is not yet referred to. */
  private keying = false;

  constructor(private readonly store: any, flat: boolean) {
    this.ref = Object.assign((target: any): PlainMap => this.refer(target), { flat, store });
  }

  /** What an entry links, as a spec refers to it. */
  private refer(target: any): PlainMap {
    if (this.keying) return new Map();
    const number = this.numbers.get(target);
    if (number !== undefined) return new Map([["symbol", String(number)]]);
    if (Proxies._is_data(target)) {
      if (Proxies._counted(target)) {
        throw new ValueError(`a document refers to a counted ${repr(this.store.name_of(target.as_schema()))} it does not `
          + "hold: a counted object has no identity beyond the document that writes it");
      }
      return new Map([["path", pathOf(target)]]);
    }
    return new Map([["path", schemaPath(this.store._path(target))]]); // a schema object, which an extension's relation links
  }

  private hold(value: unknown): void {
    if (!this.numbers.has(value)) {
      this.numbers.set(value, this.order.length);
      this.order.push(value);
    }
  }

  /** Each named adjacency of `value` that holds entries, with them, in the order they are written. */
  private entries(value: any): [string, Schemas.OfAdjacency.Data, any[]][] {
    const out: [string, Schemas.OfAdjacency.Data, any[]][] = [];
    for (const [name, adjacency] of value.as_schema().adjacencies as Map<string, Schemas.OfAdjacency.Data>) {
      const held = [...(value[name] as Readers.OfAdjacency)];
      if (held.length === 0) continue;
      this.keying = true;
      const rows = held.map((e) => entry(e, adjacency, this.ref));
      this.keying = false;
      out.push([name, adjacency, sorted(adjacency, held, rows)]);
    }
    return out;
  }

  run(schema: Schemas.OfObject.Data, root: Readers.OfObject, reachable: boolean, uid: string | undefined): PlainMap {
    if (root.as_schema() !== schema) {
      throw new TypeError(`value is a ${repr(root.as_schema().name)}, not an instance of the given schema`);
    }
    if (!schema.ref) {
      throw new TypeError(`a snapshot's root must be a reference object; ${repr(schema.name)} is a value object schema`);
    }
    if (schema.anonymous.some((adjacency) => adjacency.owner) && ![...schema.adjacencies.values()].some((a) => a.owner)) {
      throw new ValueError(`a ${repr(this.store.name_of(schema))} is owned through an adjacency with no name: a document `
        + "cannot give the entry that owns it; name the adjacency");
    }
    this.hold(root);
    for (let position = 0; reachable && position < this.order.length; position++) { // what it holds, in the order it meets them
      for (const [, adjacency, held] of this.entries(this.order[position])) {
        for (const e of held) {
          for (const link of (adjacency.relation as Schemas.OfRelation.Data).entry.links.keys()) {
            const target = e[link];
            if (link !== adjacency.me && Proxies._is_data(target) && Proxies._counted(target)) this.hold(target);
          }
        }
      }
    }
    const written = new Set<unknown>();
    const items: PlainMap[] = [];
    this.order.forEach((value, number) => {
      const members: PlainData[] = [...value.as_properties].map((prop: any) => m([["as_property", m([
        ["name", prop.as_schema().name],
        ["mutations", [m([["set", m([["value", this.valueOf(prop)]])]])]]])]]));
      for (const [name, adjacency, held] of this.entries(value)) {
        const fresh = held.filter((e) => !written.has(Proxies._innerOf(e)));
        for (const e of fresh) written.add(Proxies._innerOf(e));
        if (fresh.length > 0) {
          members.push(m([["as_adjacency", m([["name", name], ["mutations", [m([["insert", m([["entries",
            fresh.map((e) => specEntry(entry(e, adjacency, this.ref), adjacency))]])]])]]])]]));
        }
      }
      if (members.length > 0) items.push(m([[String(number), members]]));
    });
    const symbols = Object.fromEntries(this.order.map((value, number) => [String(number), value.as_schema()]));
    for (const held of Object.values(symbols)) {
      if (!this.store.holds(held)) {
        throw new ValueError(`a document refers to its objects' schemas by their paths; ${repr(held.name)} is a schema the `
          + "store does not hold");
      }
    }
    const transaction = this.store.Mutations.OfTransaction((t: any) => (uid === undefined ? t : t.uid(uid)).mutations([
      (mu: any) => mu.upsert((u: any) => (uid === undefined ? u : u.key(uid)).exists([(p: any) => p.symbols(symbols).spec(items)]))]));
    return new Expression(this.store).object(transaction);
  }

  private valueOf(prop: any): PlainData {
    return value(prop, prop.as_schema().schema, this.ref)[1];
  }
}

/** An entry as a spec inserts it: its links set to what they refer to, then its properties. */
function specEntry(row: PlainMap, adjacency: Schemas.OfAdjacency.Data): PlainMap {
  const relation = adjacency.relation as Schemas.OfRelation.Data;
  const links = [...relation.entry.links.keys()].filter((link) => link !== adjacency.me);
  return m([["mutations", [
    ...links.map((link) => m([["as_link", m([["name", link], ["mutations", [m([["set", m([["ref", row.get(link)!]])]])]]])]])),
    ...[...relation.entry.properties.keys()].filter((name) => row.has(name)).map((name) => m([["as_property", m([["name", name],
      ["mutations", [m([["set", m([["value", row.get(name)!]])]])]]])]])),
  ]]]);
}

const ORDERED = new Set(["boolean", "bigint", "number", "string"]);

/** The order of two values of one ordered scalar: booleans false first, numbers by value, strings by code point. */
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

/** An adjacency's entries in the order they are written: sorted by the key its relation declares from its end, read from
 * their `rows` as `entry` writes them, where every entry has each of its values and each holds values of one ordered
 * scalar (booleans false first, numbers by value, strings by code point); else as they are. */
function sorted<T>(adjacency: Schemas.OfAdjacency.Data, entries: T[], rows: PlainMap[]): T[] {
  const names = (adjacency.relation as Schemas.OfRelation.Data).key(adjacency.me);
  if (names === null) return entries;
  const keys = rows.map((row) => names.map((n) => row.get(n)));
  const ordered = names.every((_, i) => {
    const kinds = new Set(keys.map((key) => typeof key[i]));
    return kinds.size === 1 && ORDERED.has([...kinds][0] as string);
  });
  if (!ordered) return entries;
  return keys.map((key, i) => [key, i] as const).sort((a, b) => compareKeys(a[0], b[0])).map(([, i]) => entries[i]!);
}

/** Documents read with no uid of their own, each keyed afresh. */
let reads = 0;

/** Reads a document (`Document`): executes its transaction, within the store's open one as a savepoint, else as a
 * transaction of its own, and gives its root, the object its symbol `"0"` binds. A document with no uid is keyed afresh by
 * each read, so that reading it gives new counted objects (Decided, 55). */
function readDocument(store: any, schema: unknown, plain: unknown): unknown {
  if (!(schema instanceof Schemas.OfObject.Data)) {
    throw new TypeError(`the root schema must be an object schema, got ${schemaTypeName(schema)}`);
  }
  if (!schema.ref) throw new TypeError("the root schema must be a reference object schema");
  if (!(plain instanceof Map)) throw new DecodeError("expected a document, a transaction's expression", { path: "$" });
  const terms = plain.get("mutations");
  const upsert = Array.isArray(terms) && terms.length === 1 && terms[0] instanceof Map ? terms[0].get("upsert") : undefined;
  if (!plain.has("uid") && upsert instanceof Map) {
    plain = new Map([...plain, ["mutations", [new Map([["upsert", new Map([...upsert, ["key", `\0${++reads}`]])]])]]]);
  }
  const transaction = FromPlain(store).Transaction(plain);
  return store._joined(() => { // what it writes, kept only where its root is what is asked for
    const frames = Transactions._execute(store, transaction, true);
    if (frames.length !== 1 || !frames[0]!.has("0")) {
      throw new DecodeError("a document binds its root, the symbol '0', in one frame", { path: "$" });
    }
    const root: any = frames[0]!.get("0");
    if (!Schemas.is_a(root.as_schema(), schema)) {
      throw new TypeError(`the document's root is a ${repr(store.name_of(root.as_schema()))}, not an instance of the given `
        + "schema");
    }
    return root;
  });
}


/** The number a document gives a counted object, where `called` is `{'n': number}`; -1 for one that is not an int, 0
 * or more; null for a path. */
function numberIn(called: unknown): number | null {
  if (called instanceof Map && called.size === 1 && called.has("n")) {
    const number = called.get("n");
    return typeof number === "bigint" && number >= 0n ? Number(number) : -1;
  }
  return null;
}

/** A path's text in a reader, which tells paths apart: its canonical JSON, keys sorted. A path holds no lists. */
export function _symbol(plain: unknown): string {
  if (!(plain instanceof Map)) return Json.dumps(plain as PlainData);
  const keys = sortedStrings([...plain.keys()] as string[]);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${_symbol(plain.get(key))}`).join(",")}}`;
}

/** A reference object's path, as plain data, in its own store (`Paths.of`). */
function pathOf(value: unknown): PlainMap {
  const store: any = Proxies._store_of(value);
  return ToPlain(store)(store.Paths.OfRoot.as_schema(), Paths.of(value)) as PlainMap;
}

type Step = [string, string, PlainMap];

/** A path as plain data: the singleton it starts from, and each entry transited (`i`, `o`, keys). `DecodeError` where
 * it is not a `Paths.OfRoot` value. */
function stepsOf(plain: unknown, where: Where): [string, Step[]] {
  const malformed = (why: string): DecodeError =>
    new DecodeError(`a path is {'singleton': name, 'next': {'entry': ...} or {'target': {}}}: ${why}`, { path: path(...where) });
  const only = (value: unknown, ...names: string[]): value is PlainMap =>
    value instanceof Map && value.size === names.length && names.every((name) => value.has(name));
  if (!only(plain, "singleton", "next")) throw malformed("a mapping of 'singleton' and 'next'");
  const singleton = plain.get("singleton");
  if (typeof singleton !== "string") throw malformed("its singleton is text");
  const steps: Step[] = [];
  let step = plain.get("next");
  while (!only(step, "target")) {
    const entry = only(step, "entry") ? step.get("entry") : null;
    if (!only(entry, "i", "o", "properties", "next") || typeof entry.get("i") !== "string" || typeof entry.get("o") !== "string"
      || !(entry.get("properties") instanceof Map)) {
      throw malformed("each step an entry of 'i', 'o', 'properties' and 'next'");
    }
    steps.push([entry.get("i") as string, entry.get("o") as string, new Map(entry.get("properties") as PlainMap)]);
    step = entry.get("next");
  }
  return [singleton, steps];
}

/** The path of the steps given, as plain data. */
function pathFrom(singleton: string, steps: Step[]): PlainMap {
  let nested: PlainMap = new Map([["target", new Map()]]);
  for (const [i, o, keys] of [...steps].reverse()) {
    nested = new Map([["entry", new Map<string, PlainData>([["i", i], ["o", o], ["properties", keys], ["next", nested]])]]);
  }
  return new Map<string, PlainData>([["singleton", singleton], ["next", nested]]);
}

/** A decoded value object (an object's, a union value or an intersection value), which `build` writes into its
 * builder. */
class DecodedRecord {
  constructor(readonly schema: RecordSchema, readonly values: Map<string, unknown>) {}
}

/** A decoded value of an unrestricted `OfAny`'s registered schema, `name`: built standalone, through the store's
 * builder, and assigned as a value. */
class Assigned {
  constructor(readonly name: string, readonly value: unknown, readonly store: Visitors.OfStore) {}

  make(): any {
    const builder = this.store.builder(this.name);
    if (this.value instanceof DecodedElements) fillElements(builder, this.value);
    else build(builder, this.value as DecodedRecord);
    return builder.create();
  }
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
function decode(schema: Schemas.OfAny.Data, plain: unknown, where: Where, store: Visitors.OfStore | null = null): unknown {
  const held = schema as Schemas.OfAny.Data;
  if (held instanceof Schemas.OfAny.Value) return decodeAny(held, plain, where, store);
  if (held instanceof Schemas.OfScalar.Data) {
    try {
      return held.from_plain(plain);
    } catch (error) {
      throw (error as DecodeError).at(path(...where)); // from_plain throws only DecodeError
    }
  }
  if (held instanceof Schemas.OfContainer.Data) return decodeContainer(held, plain, where, store);
  const [what, owner, member] = recordNames(held as RecordSchema);
  if (!(plain instanceof Map)) throw new DecodeError(`${what} must be a mapping, got ${typeName(plain)}`, { path: path(...where) });
  const record = held as RecordSchema;
  const values = new Map<string, unknown>();
  for (const [key, item] of plain as PlainMap) {
    const memberSchema = record.properties.get(key)?.schema as Schemas.OfAny.Data | undefined;
    if (memberSchema === undefined) throw new DecodeError(`${owner} has no ${member} ${repr(key)}`, { path: path(...where, key) });
    values.set(key, decode(memberSchema, item, [...where, key], store));
  }
  if (record instanceof Schemas.OfUnion.Data && values.size !== 1) {
    throw new DecodeError(`a union value holds exactly one branch, got ${values.size}`, { path: path(...where) });
  }
  return new DecodedRecord(record, values);
}

/** The plain form a plain value takes, as `Schemas.plain_forms` names them. */
function formOf(plain: unknown): string | null {
  if (typeof plain === "boolean") return "bool";
  if (typeof plain === "bigint") return "int";
  if (typeof plain === "number") return "float";
  if (typeof plain === "string") return "text";
  if (plain instanceof Map) return "mapping";
  return Array.isArray(plain) ? "list" : null;
}

/** A value of any schema: restricted, of the one schema whose plain form it takes; unrestricted, a mapping of its schema, a
 * basic scalar's tag or a schema's registered name, to its value. */
function decodeAny(schema: Schemas.OfAny.Value, plain: unknown, where: Where, store: Visitors.OfStore | null): unknown {
  if (schema.schemas.length > 0) {
    const form = formOf(plain);
    const fits = schema.schemas.filter((t) => form !== null && Schemas.plain_forms(t).has(form));
    if (fits.length !== 1) {
      throw new DecodeError(`a value of any schema takes the plain form of one of its schemas, got ${typeName(plain)}`,
        { path: path(...where) });
    }
    return decode(fits[0] as Schemas.OfAny.Data, plain, where, store);
  }
  if (!(plain instanceof Map) || plain.size !== 1) {
    throw new DecodeError("a value of any schema is {schema: value}, its schema a basic scalar's tag or a registered schema's name",
      { path: path(...where) });
  }
  const [tag, value] = [...plain][0] as [string, unknown];
  const scalar = Schemas.SCALAR_TYPES.find((t) => new Schemas.OfScalar.Data(t).tag === tag);
  if (scalar !== undefined) return decode(new Schemas.OfScalar.Data(scalar), value, [...where, tag as string], store);
  let registered: unknown;
  try {
    registered = (store as Visitors.OfStore).registered(tag as string);
  } catch { // a store's registered refuses a name it does not hold
    throw new DecodeError(`no schema registered as ${repr(tag)}`, { path: path(...where, tag as string) });
  }
  const valueKind = (registered instanceof Schemas.OfObject.Data && !registered.ref) || registered instanceof Schemas.OfUnion.Data
    || registered instanceof Schemas.OfIntersection.Data || registered instanceof Schemas.OfContainer.Data;
  if (!valueKind) throw new DecodeError(`${repr(tag)} is not a value's schema`, { path: path(...where, tag as string) });
  return new Assigned(tag as string, decode(registered as Schemas.OfAny.Data, value, [...where, tag as string], store), store as Visitors.OfStore);
}

/** An index read from its plain form: a scalar, or a value object index as the array of its properties. */
function decodeIndex(schema: Schemas.OfContainer.Data, plain: unknown, where: Where): unknown {
  const held = schema.index;
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
function decodeContainer(schema: Schemas.OfContainer.Data, plain: unknown, where: Where,
  store: Visitors.OfStore | null = null): DecodedElements {
  const items: [unknown, unknown][] = [];
  const element = (index: unknown, value: unknown, at: Where): void => {
    if (value !== null) items.push([index, decode(schema.element as Schemas.OfAny.Data, value, at, store)]);
  };
  const names = tensor(schema);
  const arrangement = schema.arrangement;
  const held = schema.index;
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

/** For messages, per record kind: a value of it, its schema, and what its properties are. */
function recordNames(schema: RecordSchema): [string, string, string] {
  if (schema instanceof Schemas.OfUnion.Data) return ["a union value", "the union", "branch"];
  if (schema instanceof Schemas.OfIntersection.Data) return ["an intersection value", "the intersection", "part"];
  return ["a value object", "the value object", "property"];
}

/** Where a document places an object: a singleton's global name, through an `owner()` adjacency the path of its owner
 * (its symbol, and as plain data), the adjacency's name and the entry's keys, or nowhere, a counted object, made anew. */
interface Placed {
  key: string | null;
  owner: string | null;
  ownerPath: PlainMap | null;
  o: string;
  keys: PlainMap;
  counted: boolean;
}

/** Where `called`, a path or a number, places an object of `schema`, registered as `name` (docs/OBJECT_IDENTITY.md,
 * Decided, 55): a counted object is called by its number in the document, an owned object or a singleton by its path. */
function placedOf(called: unknown, name: string, schema: Schemas.OfObject.Data, where: Where): Placed {
  const at = (key: string | null, counted = false): Placed => ({ key, owner: null, ownerPath: null, o: "", keys: new Map(), counted });
  const counted = schema.singleton === null && ![...schema.adjacencies.values(), ...schema.anonymous].some((a) => a.owner);
  if (numberIn(called) !== null) {
    if (!counted) {
      throw new DecodeError(`a ${repr(name)} is ${schema.singleton !== null ? "a singleton" : "owned"}: it is called by its `
        + "path, not a number", { path: path(...where) });
    }
    return at(null, true);
  }
  if (counted) {
    throw new DecodeError(`a ${repr(name)} is counted: it is called by its number in the document, {'n': number}, not a `
      + "path", { path: path(...where) });
  }
  const [singleton, steps] = stepsOf(called, where);
  if (schema.singleton !== null) {
    if (steps.length > 0 || singleton !== schema.singleton) {
      throw new DecodeError(`the singleton ${repr(name)} is the path of its global name ${repr(schema.singleton)} alone`,
        { path: path(...where) });
    }
    return at(singleton);
  }
  if (steps.length === 0) {
    throw new DecodeError(`a ${repr(name)} is not a singleton: its path goes through what owns it`, { path: path(...where) });
  }
  const ownerPath = pathFrom(singleton, steps.slice(0, -1)); // the owner's path: the same steps but the last
  const [, o, keys] = steps[steps.length - 1]!;
  return { key: null, owner: _symbol(ownerPath), ownerPath, o, keys, counted: false };
}

/** Whether an entry's keys are those a path's step gives, equal as plain data. */
function sameKeys(properties: Map<string, unknown>, keys: PlainMap): boolean {
  return properties.size === keys.size && [...keys].every(([name, value]) => properties.has(name)
    && Proxies.scalarKey(properties.get(name)) === Proxies.scalarKey(value));
}

/** A schema object's path as plain data: each step's adjacency and the name its entry gives (docs/OBJECT_IDENTITY.md,
 * Decided, 81). `DecodeError` where it is not one. */
export function _schemaSteps(plain: unknown, where: Where): [string, string][] {
  const [singleton, steps] = stepsOf(plain, where);
  if (singleton !== "." || steps.some(([, o, keys]) => o !== "" || keys.size !== 1 || typeof keys.get("name") !== "string")) {
    throw new DecodeError("a schema object's path starts from the root module, '.', and each step names an entry, "
      + "{'i': adjacency, 'o': '', 'properties': {'name': name}}", { path: path(...where) });
  }
  return steps.map(([i, , keys]) => [i, keys.get("name") as string]);
}

/** The object a path names in `store`, or null: a schema object from the root module (`Builders.Store.held`), a
 * singleton, or through its owner's entries, the one whose keys the path's last step gives and whose other end's owner
 * adjacency is `o`. */
function byPath(store: any, plain: unknown, where: Where): unknown {
  const [singleton, steps] = stepsOf(plain, where);
  if (singleton === ".") return store._at(_schemaSteps(plain, where));
  if (steps.length === 0) return store._singletons.get(singleton) ?? null;
  const owner = byPath(store, pathFrom(singleton, steps.slice(0, -1)), where);
  if (owner === null) return null;
  const [, o, keys] = steps[steps.length - 1]!;
  for (const table of Proxies._entries_of(owner).values()) {
    for (const entry of table.values()) {
      const state = Proxies._innerOf(entry);
      for (const [link, target] of state._links) {
        if (target === owner || !(Proxies._innerOf(target) instanceof Proxies._internals._ObjectData)) continue;
        const schema = Proxies._innerOf(target)._schema as Schemas.OfObject.Data;
        const owned = [...schema.adjacencies.values(), ...schema.anonymous]
          .some((a) => a.owner && a.name === o && a.relation === state._relation && a.me === link);
        if (owned && sameKeys(state._properties, keys)) return target;
      }
    }
  }
  return null;
}

/** The adjacency of `schema` marked `owner()` that a path's `o` names; the anonymous one where `o` is empty. */
function ownerAdjacency(schema: Schemas.OfObject.Data, o: string): Schemas.OfAdjacency.Data {
  const found = [...schema.adjacencies.values(), ...schema.anonymous].filter((a) => a.owner && a.name === o);
  if (found.length !== 1) {
    throw new DecodeError(`${repr(schema.name)} has no adjacency ${repr(o)} marked owner() for a path to go through`);
  }
  return found[0]!;
}

let nextRelation = 0;

/** The `Visitors.OfAny` method that selects a record kind. */
function selectOf(kind: unknown): "as_object" | "as_union" | "as_intersection" {
  return kind === Schemas.OfUnion.Data ? "as_union" : kind === Schemas.OfIntersection.Data ? "as_intersection" : "as_object";
}

/** Whether a visitor's members are a union's branches or an intersection's parts, each of its own schema's kind, rather
 * than properties. */
function holdsMembers(visitor: any): boolean {
  const schema = visitor.as_schema();
  return schema instanceof Schemas.OfUnion.Data || schema instanceof Schemas.OfIntersection.Data;
}

/** Writes a decoded value into the member `name`: a scalar, a value object, union value or intersection value. */
function set(visitor: any, name: string, value: unknown): void {
  const member = visitor[name];
  if (value instanceof Assigned) member.as_value(value.make());
  else if (value instanceof DecodedElements) {
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
  if (value instanceof Assigned) {
    const made = value.make();
    const schema = made.as_schema();
    element[schema instanceof Schemas.OfContainer.Data ? "as_container" : selectOf(schema.constructor)](made);
  } else if (value instanceof DecodedElements) element.as_container((held: any) => fillElements(held, value));
  else if (value instanceof DecodedRecord) element[selectOf(value.schema.constructor)]((held: any) => build(held, value));
  else element.as_scalar(value);
}

// --- Logs: a store as a log of mutations (docs/SERIALIZATION.md) ---

/** A plain mapping of `entries`, in order. */
function m(entries: [string, PlainData][]): PlainMap {
  return new Map(entries);
}

/** `plain[key]`, or `fallback` where it holds none, as Python's `dict.get(key, fallback)`. */
function field(plain: any, key: string, fallback: unknown): any {
  return new Map([[key, fallback], ...plain]).get(key);
}

/** An entry waiting to be written: once every object it links is. */
interface Pending {
  relation: Schemas.OfRelation.Data;
  links: Map<string, string>;
  properties: PlainMap;
  count: number;
  keys: Set<string>;
  scan: number;
}

/** Writes a store as a log of mutations, its initial snapshot: modules, then the schemas each defines, then the other
 * named singletons, each followed by the data it reaches. Each object is read through its visitor (a schema object
 * through its builder, read-only) and written once, in definition form (`exists`), by its path or its number; the
 * members of a schema object and the data it links follow it. A schema object with no name of its own has no path: its
 * definition is written where the one object that links it links it (docs/OBJECT_IDENTITY.md, Decided, 81). An entry is
 * written (`insert`) once every object it links is; a link to one of the framework's schemas, which every store holds,
 * is a reference only. */
class LogWriter {
  private readonly store: Builders.Store;
  /** What `value` needs to write a value: a value holds no reference, so it is never called. */
  private readonly names: Ref;
  private readonly out: PlainData[] = [];
  private readonly written = new Set<string>();
  /** Written, with every object it holds or links that follows it. */
  private readonly complete = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  /** Each object's adjacencies are scanned once: an inner object's later than its owner's. */
  private scans = 0;
  private readonly relations = new Map<unknown, number>();
  /** Each object's reference on the wire, by its key. */
  private readonly refs = new Map<string, PlainMap>();
  /** Each object with no path: its definition, and what it needs written before it. */
  private readonly nested = new Map<string, [PlainMap, Set<string>]>();
  /** Each object in a message: a schema object's path, dotted, else its kind; data's key. */
  private readonly shown = new Map<string, string>();
  /** The counted objects numbered so far, in the order the log meets them. */
  private counted = 0;

  constructor(store: Visitors.OfStore) {
    if (!(store instanceof Builders.Store)) {
      throw new TypeError("a snapshot is of a Builders.Store, which holds its schemas and its modules");
    }
    this.store = store;
    this.names = _names(store);
  }

  /** A visitor of a schema object: its builder, read-only. */
  private reader(value: any): any {
    const builder = Builders._builder_for(value) as new (...args: unknown[]) => unknown;
    return new builder(value, false, this.store);
  }

  /** What tells an object apart in the writer: the registered name of its schema and its key. On the wire (`refs`), a
   * schema object or an owned object or a singleton is referred to by its path, and a counted object by its number in
   * the log, in the order the log meets them (docs/OBJECT_IDENTITY.md, 55); a schema object with no path is not
   * referred to (`nested`). */
  private key(visitor: any): string {
    const key = `${this.store.name_of(visitor.as_schema())}/${Proxies._key_of(visitor)}`;
    if (!this.refs.has(key)) {
      if (!Proxies._is_data(visitor)) { // a schema object, read through its builder
        const data: any = Builders._linked(visitor);
        const steps = this.store._path(data);
        this.refs.set(key, steps === null ? new Map() : m([["path", schemaPath(steps)]]));
        this.shown.set(key, steps === null ? (Builders._builder_for(data) as unknown as { _noun: string })._noun
          : steps.map(([, name]) => name).join(".") || ".");
      } else if (Proxies._counted(visitor)) {
        this.refs.set(key, m([["n", BigInt(this.counted)]]));
        this.counted += 1;
      } else {
        this.refs.set(key, m([["path", pathOf(visitor)]]));
      }
    }
    return key;
  }

  /** Refuses a schema object the store does not hold, saying where it is linked: there are no foreign schemas. */
  private held(visitor: any, where: string): void {
    const held: any = Builders._linked(visitor);
    if (held === null) return; // data
    if (!this.store.holds(held)) {
      const shown = held.name || `_${held.constructor.name}`;
      throw new ValueError(`${where} links ${shown}, a schema the store does not hold: there are no foreign schemas`);
    }
  }

  /** The properties of an object that are set, by name. */
  private propertiesOf(visitor: any): PlainMap {
    const properties: PlainMap = new Map();
    for (const prop of visitor.as_properties) properties.set(prop.as_schema().name, value(prop, prop.as_schema().schema, this.names)[1]);
    return properties;
  }

  /** Writes an object in definition form, then what follows it. A singleton exists in every store that registers its
   * schema, so that `exists` leaves it as it is there: its properties are set after it (`as_property`). */
  define(visitor: any, key: string, singleton = false): void {
    if (this.written.has(key)) return;
    this.written.add(key);
    const properties = this.propertiesOf(visitor);
    const ref = this.refs.get(key)!;
    const definition = m([...ref, ["schema", this.store.name_of(visitor.as_schema())], ["properties", singleton ? new Map() : properties]]);
    this.out.push(m([["exists", m([["definition", definition]])]]));
    if (singleton) {
      for (const [name, plain] of properties) {
        this.out.push(m([["as_property", m([["ref", ref], ["name", name],
          ["mutations", [m([["set", m([["value", plain]])]])]]])]]));
      }
    }
    const contained: [any, string][] = [];
    visitor.as_adjacencies((adjacency: any) => this.entries(adjacency, key, contained));
    for (const [target, targetKey] of contained) this.define(target, targetKey);
    this.complete.add(key);
    this.flush();
  }

  /** The object an entry links at `link`, as a visitor: a schema object's builder, or data's proxy. */
  private target(entry: any, link: string, where: string): any {
    let target = entry[link];
    if (Builders._builder_for(target) !== null) {
      target = this.reader(target); // a schema object a proxy's entry links (an extension's)
    } else {
      const linked = Builders._linked(target); // a schema object's entry: what it links, read
      target = linked !== null ? this.reader(linked) : Builders._linked_data(target) ?? target;
    }
    this.held(target, where);
    return target;
  }

  /** Where an entry is, in a message: the object whose adjacency holds it, and the adjacency. */
  private where(key: string, schema: any): string {
    return `${this.shown.get(key) ?? key}, ${schema.name},`;
  }

  /** The key of an object an entry links, noting what must be written before the entry (`needs`) and what follows the
   * object being written (`contained`): a schema object with no path is defined where it is linked. */
  private linked(target: any, needs: Set<string>, contained: [any, string][]): string {
    const key = this.key(target);
    const data: any = Builders._linked(target);
    if (data !== null && this.store.framework(data)) {
      this.written.add(key);
      this.complete.add(key);
    } else if (this.refs.get(key)!.size === 0) {
      for (const needed of this.defineNested(target, key, contained)) needs.add(needed);
      return key;
    } else if (data === null || !Builders._named(data)) {
      contained.push([target, key]); // a member follows its owner, and data what reaches it
    }
    needs.add(key);
    return key;
  }

  /** The definition of a schema object with no path, its entries nested in it, each without its own link; what it needs
   * written before it. */
  private defineNested(visitor: any, key: string, contained: [any, string][]): Set<string> {
    const inserts: PlainData[] = [];
    const needs = new Set<string>();
    visitor.as_adjacencies((adjacency: any) => {
      const schema = adjacency.as_schema();
      const relation: Schemas.OfRelation.Data = schema.relation;
      const entries: PlainData[] = [];
      for (const entry of adjacency) {
        const links = new Map<string, string>();
        for (const link of relation.entry.links.keys()) {
          if (link !== schema.me) links.set(link, this.linked(this.target(entry, link, this.where(key, schema)), needs, contained));
        }
        entries.push(this.entry(links, this.entryProperties(entry, relation)));
      }
      if (entries.length > 0) {
        const relationKey = this.linked(this.reader(relation), needs, contained);
        inserts.push(m([["relation", this.refs.get(relationKey)!], ["entries", entries]]));
      }
      return adjacency;
    });
    const definition = m([["schema", this.store.name_of(visitor.as_schema())], ["properties", this.propertiesOf(visitor)]]);
    if (inserts.length > 0) definition.set("inserts", inserts);
    this.nested.set(key, [definition, needs]);
    return needs;
  }

  private entryProperties(entry: any, relation: Schemas.OfRelation.Data): PlainMap {
    const properties: PlainMap = new Map();
    for (const [name, prop] of relation.entry.properties) {
      const [found, plain] = value(entry[name], prop.schema, this.names);
      if (found) properties.set(name, plain);
    }
    return properties;
  }

  /** An entry's mutations: each link set to a reference, or to a definition where what it links has no path. */
  private entry(links: Map<string, string>, properties: PlainMap): PlainMap {
    return m([["mutations", [
      ...[...links].map(([name, target]) => m([["as_link", m([["name", name], ["mutations", [m([["set",
        this.nested.has(target) ? m([["def", this.nested.get(target)![0]]]) : m([["ref", this.refs.get(target)!]])]])]]])]])),
      ...[...properties].map(([name, plain]) => m([["as_property", m([["name", name],
        ["mutations", [m([["set", m([["value", plain]])]])]]])]])),
    ]]]);
  }

  private entries(adjacency: any, key: string, contained: [any, string][]): any {
    this.scans += 1;
    const schema = adjacency.as_schema();
    const relation: Schemas.OfRelation.Data = schema.relation;
    const me: string = schema.me;
    if (!this.relations.has(relation)) this.relations.set(relation, this.relations.size);
    const counts = new Map<string, number>();
    [...adjacency].forEach((entry: any) => {
      const links = new Map<string, string>();
      const needs = new Set<string>();
      for (const link of relation.entry.links.keys()) {
        if (link === me) {
          links.set(link, key);
          needs.add(key);
          continue;
        }
        links.set(link, this.linked(this.target(entry, link, this.where(key, schema)), needs, contained));
      }
      const properties = this.entryProperties(entry, relation);
      const identity = [this.relations.get(relation), Json.dumps([...links].sort(byName)),
        Json.dumps([...properties].sort(byName) as PlainData[])].join("\n");
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
      if (!this.pending.has(identity)) {
        this.pending.set(identity, { relation, links, properties, count: 0, keys: needs, scan: this.scans });
      }
      const pending = this.pending.get(identity) as Pending;
      pending.count = Math.max(pending.count, counts.get(identity) as number);
    });
    return adjacency;
  }

  /** Writes the entries whose objects are all written: an inner object's (scanned later) before its owner's, so that an
   * object is whole before it is placed; within one object's, in order. Consecutive entries of a relation go in one
   * `insert`. */
  private flush(): void {
    const ready = [...this.pending].map(([identity, pending], number) => ({ identity, pending, number }))
      .filter(({ pending }) => [...pending.keys].every((key) => this.complete.has(key)))
      .sort((a, b) => b.pending.scan - a.pending.scan || a.number - b.number);
    for (const { identity, pending } of ready) {
      this.pending.delete(identity);
      const relationRef = this.refs.get(this.key(this.reader(pending.relation)))!;
      const entries = new Array(pending.count).fill(this.entry(pending.links, pending.properties));
      const last: any = this.out[this.out.length - 1];
      if (last.has("insert") && last.get("insert").get("relation") === relationRef) {
        last.get("insert").get("entries").push(...entries);
      } else {
        this.out.push(m([["insert", m([["relation", relationRef], ["entries", entries]])]]));
      }
    }
  }

  run(): PlainData[] {
    const store = this.store;
    const modules: any[] = [];
    const queue: any[] = [store.module()];
    while (queue.length > 0) { // the root module first, then the modules it defines, nested
      const module = queue.shift();
      modules.push(module);
      queue.push(...[...module.schemas.values()].filter((held) => held instanceof Builders._ModuleData));
    }
    for (const module of modules) {
      const reader = this.reader(module);
      this.define(reader, this.key(reader));
    }
    for (const module of modules) {
      for (const held of module.schemas.values()) {
        if (!(held instanceof Builders._ModuleData)) {
          const reader = this.reader(held);
          this.define(reader, this.key(reader));
        }
      }
    }
    for (const singleton of store._singletons.values()) this.define(singleton, this.key(singleton), true);
    for (const held of [...store._objects].filter((held) => store.framework(held) && Builders._named(held))) {
      this.extended(this.reader(held));
    }
    return this.out; // every entry is written: it links objects of the store, each written
  }

  /** Writes the entries of an extension's relations that link a schema the store was made holding, which is never
   * written itself: those its other end does not reach (a scalar's, written from the scalar's end). */
  private extended(visitor: any): void {
    const key = this.key(visitor);
    const contained: [any, string][] = [];
    visitor.as_adjacencies((adjacency: any) => this.store.framework(adjacency.as_schema().relation)
      ? adjacency // the store's own: between its own schemas, never written
      : this.entries(adjacency, key, contained));
    for (const [target, targetKey] of contained) this.define(target, targetKey);
    this.written.add(key);
    this.complete.add(key);
    this.flush();
  }
}

/** A schema object's path as plain data (docs/OBJECT_IDENTITY.md, Decided, 81): from the root module, the singleton
 * `"."`, each step through a keyed adjacency, by name. */
function schemaPath(steps: [string, string][]): PlainMap {
  return pathFrom(".", steps.map(([i, name]): Step => [i, "", new Map([["name", name]])]));
}

function byName(a: [string, unknown], b: [string, unknown]): number {
  return compareStrings(a[0], b[0]);
}

/** Applies a log of mutations to a store, each through the store's builders: `exists` creates an object only where its
 * path is new, its properties read by their schema; `insert` adds entries, through an adjacency of an object each links,
 * and creates a schema object with no path where an entry defines it (`def`), nested where it is linked, when the object
 * that links it is new (docs/OBJECT_IDENTITY.md, Decided, 81). */
/** A sub-clause of a log a store ignored on reading it: where it is, and why (`FromPlain(store).Snapshot`). */
export interface Ignored {
  path: string;
  reason: string;
}

/** Applies a log of mutations to a store, each through the store's builders. A sub-clause whose meaning needs an
 * extension of a schema the store was made holding, which the store lacks, is ignored, and kept in `ignored` where it is
 * given (docs/proposals/store-overhaul, Decided, 19): a property such a schema lacks, and an entry no linked object can
 * hold where one of them is of such a schema. */
class LogReader {
  private readonly store: Builders.Store;
  private readonly meta: Set<unknown>;
  /** The objects made, held: a store holds its counted objects weakly. */
  private readonly made: unknown[] = [];
  /** The counted objects the log made, by their numbers in it. */
  private readonly numbered = new Map<number, unknown>();
  /** The objects the log made. */
  private readonly made_ = new Set<unknown>();
  /** Whether an object held, before the log was read, an entry defining what it links (`defines`). */
  private readonly heldBefore = new Map<string, boolean>();

  constructor(store: Visitors.OfStore, private readonly ignored: Ignored[] | null = null) {
    if (!(store instanceof Builders.Store)) throw new TypeError("a snapshot is read into a Builders.Store");
    this.store = store;
    this.meta = new Set(Object.values(store._meta)); // its own
  }

  /** Ignores a sub-clause whose meaning needs an extension the store lacks, keeping where it is and why. */
  private ignore(where: Where, reason: string): void {
    this.ignored?.push({ path: path(...where), reason });
  }

  private schema(name: string, where: Where): any {
    try {
      return this.store.registered(name);
    } catch { // registered throws only LookupError
      throw new DecodeError(`no schema registered as ${repr(name)}: there are no foreign schemas`, { path: path(...where) });
    }
  }

  /** The object a reference names: a schema object, an owned object or a singleton by its path, and a counted object by
   * its number in the log. */
  private resolve(ref: unknown, where: Where): any {
    if (ref instanceof Map && ref.has("n")) {
      const number = numberIn(new Map([["n", ref.get("n")]]))!;
      if (!this.numbered.has(number)) {
        throw new DecodeError(`no counted object the log made is numbered ${repr(ref.get("n"))}`, { path: path(...where, "n") });
      }
      return this.numbered.get(number);
    }
    if (!(ref instanceof Map) || !ref.has("path")) {
      throw new DecodeError("a reference is {'path': path} or {'n': number}", { path: path(...where) });
    }
    const found = byPath(this.store, ref.get("path"), [...where, "path"]);
    if (found === null) throw new DecodeError("no object of the store has the path referred to", { path: path(...where, "path") });
    return found;
  }

  private one(item: unknown, where: Where): [string, any] {
    if (!(item instanceof Map) || item.size !== 1) {
      throw new DecodeError("a mutation is a mapping of one verb", { path: path(...where) });
    }
    return [...item][0] as [string, any];
  }

  apply(log: unknown): unknown[] {
    if (!Array.isArray(log)) throw new DecodeError(`a log is a list, got ${typeName(log)}`, { path: "$" });
    return this.store._joined(() => this.applyAll(log)); // a transaction of its own, or the one open, until 4f (Object identity, Decided, 90)
  }

  private applyAll(log: unknown[]): unknown[] {
    log.forEach((item, index) => {
      const [verb, body] = this.one(item, [index]);
      if (verb === "exists") this.exists(field(body, "definition", new Map()), [index, verb]);
      else if (verb === "insert") this.insert(body, [index, verb]);
      else if (verb === "as_property") this.asProperty(body, [index, verb]);
      else throw new DecodeError(`${repr(verb)} is not read in an initial snapshot`, { path: path(index) });
    });
    return this.made;
  }

  private exists(definition: any, where: Where): void {
    const called = field(definition, "path", null);
    if (!(called instanceof Map && called.get("singleton") === ".")) {
      this.data(definition, where);
      return;
    }
    const steps = _schemaSteps(called, [...where, "path"]);
    if (this.store._at(steps) !== null) return;
    const made = this.schemaObject(definition, where);
    const [i, name] = steps[steps.length - 1]!; // the root module's, which every store holds, has none
    if (i !== "schemas") { // a member: its owner, at the path's other steps, holds it by the name the last gives
      const owner = this.store._at(steps.slice(0, -1));
      if (owner === null) throw new DecodeError("the schema object's owner is not in the store", { path: path(...where, "path") });
      const builderClass = Builders._builder_for(owner) as any;
      const builder = new builderClass(owner, true, this.store);
      const link = builderClass._table.get(i).link;
      builder[i]((adjacency: any) => adjacency.insert((entry: any) => {
        entry[link](made);
        set(entry, "name", name);
        return entry;
      }));
      builder.update();
    }
  }

  /** Creates a schema object from its definition: its kind, by its meta-schema's name, and its properties. */
  private schemaObject(definition: any, where: Where): any {
    const name = field(definition, "schema", null);
    if (typeof name !== "string") throw new DecodeError("a schema object's definition names its kind", { path: path(...where, "schema") });
    const schema = this.schema(name, [...where, "schema"]);
    if (!this.meta.has(schema)) {
      throw new DecodeError(`${repr(name)} is not a kind of schema object: a path from the root module ('.') is a schema `
        + "object's", { path: path(...where, "schema") });
    }
    const builderClass = Builders._META_BUILDERS.get(name.slice("Schemas.".length)) as any;
    const builder = new builderClass(null, true, this.store);
    const properties: Map<string, any> = builder.as_schema().properties;
    for (const [propName, plain] of field(definition, "properties", new Map())) {
      if (!properties.has(propName)) { // an extension of a schema the store was made holding, which it lacks
        this.ignore([...where, propName], `${name} has no property ${repr(propName)}`);
        continue;
      }
      set(builder, propName, decode(properties.get(propName).schema, plain, [...where, propName], this.store));
    }
    const made = builder.create();
    this.made.push(made);
    this.made_.add(made);
    return made;
  }

  /** A schema object with no path, created from its definition where it is linked, with its entries. */
  private defined(definition: unknown, where: Where): any {
    if (!(definition instanceof Map)) throw new DecodeError("a definition is a mapping", { path: path(...where) });
    const made = this.schemaObject(definition, where);
    field(definition, "inserts", []).forEach((body: any, number: number) => this.insert(body, [...where, "inserts", number], made));
    return made;
  }

  /** Creates a data object: an owned object or a singleton where its path places it, unless the store holds one there,
   * through its owner, whose entry its path's last step gives; a counted object always anew, known by its number for the
   * rest of the log. */
  private data(definition: PlainMap, where: Where): void {
    const name = definition.get("schema");
    if (typeof name !== "string") throw new DecodeError("a data object's definition names its schema", { path: path(...where, "schema") });
    const schema = this.schema(name, [...where, "schema"]);
    if (!(schema instanceof Schemas.OfObject.Data) || !schema.ref) {
      throw new DecodeError(`${repr(name)} is not a reference object schema`, { path: path(...where, "schema") });
    }
    const called = definition.has("path") ? definition.get("path") : new Map([["n", definition.get("n")!]]);
    const at: Where = [...where, definition.has("path") ? "path" : "n"];
    const placed = placedOf(called, name, schema, at);
    if (placed.counted) {
      const number = numberIn(called);
      if (number === null || number < 0 || this.numbered.has(number)) {
        throw new DecodeError("a counted object's number in a log is an int, 0 or more, given once", { path: path(...at) });
      }
    } else if (byPath(this.store, called, at) !== null) {
      return;
    }
    let owner: unknown = null;
    if (placed.ownerPath !== null) {
      owner = byPath(this.store, placed.ownerPath, [...where, "path"]);
      if (owner === null) throw new DecodeError("the object's owner is not in the store", { path: path(...where, "path") });
    }
    const builder = this.store.builder(name);
    for (const [propName, plain] of field(definition, "properties", new Map()) as PlainMap) {
      const prop = schema.properties.get(propName);
      if (prop === undefined) throw new DecodeError(`${name} has no property ${repr(propName)}`, { path: path(...where, propName) });
      set(builder, propName, decode(prop.schema as Schemas.OfAny.Data, plain, [...where, propName], this.store));
    }
    const made = builder.create();
    this.made_.add(made);
    if (placed.counted) this.numbered.set(numberIn(called)!, made);
    if (owner !== null) {
      const adjacency = ownerAdjacency(schema, placed.o);
      const relation = adjacency.relation as Schemas.OfRelation.Data;
      const link = [...relation.entry.links.keys()].find((other) => other !== adjacency.me) as string;
      Proxies._add_entry(relation, Proxies._make_entry(relation, new Map([[link, owner], [adjacency.me, made]]), placed.keys));
    }
    this.made.push(made);
  }

  /** Sets or clears a property of an object that exists (a singleton's, in an initial snapshot). */
  private asProperty(body: any, where: Where): void {
    const target = this.resolve(field(body, "ref", new Map()), [...where, "ref"]);
    const name = field(body, "name", null);
    const schema = target.as_schema();
    if (!schema.properties.has(name)) {
      throw new DecodeError(`${this.store.name_of(schema)} has no property ${repr(name)}`, { path: path(...where, "name") });
    }
    const builder = this.store.builder(this.store.name_of(schema), target);
    for (const change of field(body, "mutations", [])) {
      const [verb, payload] = this.one(change, where);
      if (verb === "set") {
        set(builder, name, decode(schema.properties.get(name).schema, field(payload, "value", null), where, this.store));
      } else {
        builder[name].as_value((held: any) => held.clear());
      }
    }
    builder.update();
  }

  /** Adds entries of a relation; nested in the definition of `defined`, each leaves out the link it fills. */
  private insert(body: any, where: Where, defined: unknown = null): void {
    const relation = this.resolve(field(body, "relation", new Map()), [...where, "relation"]);
    field(body, "entries", []).forEach((entry: any, number: number) => {
      const at = [...where, "entries", number];
      const links = new Map<string, unknown>();
      const values = new Map<string, unknown>();
      const definitions = new Map<string, unknown>(); // what the entry links that it defines, by link
      for (const item of field(entry, "mutations", [])) {
        const [kind, member] = this.one(item, at);
        for (const change of field(member, "mutations", [])) {
          const [, payload] = this.one(change, at); // an entry's links and properties are set
          const name = member.get("name");
          if (kind === "as_link" && payload instanceof Map && payload.has("def")) {
            definitions.set(name, payload.get("def"));
          } else if (kind === "as_link") {
            links.set(name, this.resolve(field(payload, "ref", new Map()), at));
          } else {
            const prop = relation.entry.properties.get(name);
            if (prop === undefined && this.store.framework(relation)) {
              this.ignore(at, `the relation has no property ${repr(name)}`);
              continue;
            }
            if (prop === undefined) throw new DecodeError(`the relation has no property ${repr(name)}`, { path: path(...at) });
            values.set(name, decode(prop.schema, field(payload, "value", null), at, this.store));
          }
        }
      }
      if (definitions.size > 0 && defined === null && !this.defines(relation, links, sortedStrings([...definitions.keys()]))) {
        return; // it defines what an object the store held already links: that object was written with it
      }
      for (const [link, definition] of definitions) links.set(link, this.defined(definition, [...at, link]));
      if (defined !== null) {
        const left = [...relation.entry.links.keys()].filter((link) => !links.has(link));
        if (left.length !== 1) {
          throw new DecodeError("an entry nested in a definition leaves out one link, the one the defined object fills",
            { path: path(...at) });
        }
        links.set(left[0]!, defined);
      }
      const ordered = new Map([...relation.entry.links.keys()].filter((link) => links.has(link)).map((link) => [link, links.get(link)]));
      this.link(relation, ordered, values, at);
    });
  }

  /** Whether an entry that defines, at `defined`, objects with no path is new: an object it refers to is new, or, before
   * the log was read, none held such an entry, as an object made with the store (its basic scalar) did not. Read again,
   * a log so makes nothing. */
  private defines(relation: any, links: Map<string, unknown>, defined: string[]): boolean {
    if ([...links.values()].some((target) => this.made_.has(target))) return true;
    for (const [me, target] of links) {
      const key = `${Proxies._numberOf(relation)}:${Proxies._numberOf(target as object)}:${defined.join(",")}`;
      if (!this.heldBefore.has(key)) { // first asked before the log adds any: only a definition adds one
        this.heldBefore.set(key, this.linksUnnamed(target, me, relation, defined));
      }
      if (this.heldBefore.get(key)) return false;
    }
    return true;
  }

  /** Whether `target`, at `me`, holds an entry of `relation` linking, at one of `defined`, a schema object with no name
   * of its own: data's entries are the store's, a schema object's read through its builder. */
  private linksUnnamed(target: any, me: string, relation: any, defined: string[]): boolean {
    const unnamed = (linked: unknown): boolean => Builders._builder_for(linked) !== null && !Builders._named(linked);
    const builderClass = Builders._builder_for(target) as any;
    if (builderClass === null) {
      return Proxies._linking(relation, me, target, this.store)
        .some((entry: any) => defined.some((link) => unnamed(Proxies._innerOf(entry)._links.get(link))));
    }
    let found = false;
    new builderClass(target, false, this.store).as_adjacencies((adjacency: any) => {
      if (adjacency.as_schema().relation === relation) {
        for (const entry of adjacency) found ||= defined.some((link) => unnamed(Builders._linked(entry[link])));
      }
      return adjacency;
    });
    return found;
  }

  private link(relation: unknown, links: Map<string, any>, values: Map<string, unknown>, where: Where): void {
    const schemas: unknown[] = []; // the schema of each object linked
    for (const [link, target] of links) {
      const builderClass = Builders._builder_for(target);
      let builder: any;
      let schema: any;
      if (builderClass !== null) {
        builder = new builderClass(target, true, this.store);
        schema = builder.as_schema();
      } else {
        schema = target.as_schema();
        builder = this.store.builder(this.store.name_of(schema), target);
      }
      schemas.push(schema);
      const adjacency = [...schema.adjacencies as Map<string, Schemas.OfAdjacency.Data>]
        .find(([, held]) => held.relation === relation && held.me === link);
      if (adjacency === undefined) continue;
      const fill = (entry: any): any => {
        for (const [other, value] of links) {
          if (other !== link) entry[other](value);
        }
        for (const [name, value] of values) set(entry, name, value);
        return entry;
      };
      const member = builder[adjacency[0]];
      if (Builders._holds_one(member)) member((adv: any) => adv.remove((entry: any) => entry)); // the one held is replaced
      member((adv: any) => adv.insert(fill));
      builder.update();
      return;
    }
    const reason = "no object an entry links declares an adjacency through which to add it";
    if (schemas.some((schema) => this.store.framework(schema))) { // one an extension of it would declare, missing
      this.ignore(where, reason);
      return;
    }
    throw new DecodeError(reason, { path: path(...where) });
  }
}

/** A transaction's expression as the wire carries it, nested (docs/OBJECT_IDENTITY.md, Decided, 56; Store overhaul,
 * 4f): an object as a mapping of its properties and its named adjacencies' entries. An entry of a relation of one other
 * link and no properties is written as what it links, the peer shorthand; of one other link and one property (a name),
 * its adjacency as a mapping of that property to what it links; any other as a mapping of its other links and its
 * properties. What it links is nested where it has no path (a term, linked from one place; a schema object with no name
 * of its own), tagged with its kind where its link is a kind union, or with its schema's name where several schemas
 * fill its link; else referred to by its path, `{"$ref": path}`. A pattern's spec is written as recorded. */
class Expression {
  private readonly names: Ref;
  /** What it nested, each once. */
  private readonly met = new Set<unknown>();

  constructor(private readonly store: any) {
    this.names = _names(store);
  }

  private reader(value: any): any {
    const builder = Builders._builder_for(value) as new (...args: unknown[]) => unknown;
    return new builder(value, false, this.store);
  }

  object(visitor: any): PlainMap {
    const schema = visitor.as_schema();
    const out: PlainMap = new Map();
    for (const prop of visitor.as_properties) out.set(prop.as_schema().name, value(prop, prop.as_schema().schema, this.names)[1]);
    for (const [name, adjacency] of schema.adjacencies as Map<string, Schemas.OfAdjacency.Data>) {
      const entries = [...visitor[name]];
      if (entries.length > 0) out.set(name, this.entries(entries, adjacency));
    }
    const original: any = Builders._linked(visitor);
    if (original instanceof Schemas.OfPattern.Data && original.spec.length > 0) {
      out.set("spec", (original.spec as PlainMap[]).map((item) => new Map(item)));
    }
    return out;
  }

  private entries(entries: any[], adjacency: Schemas.OfAdjacency.Data): PlainData {
    const relation = adjacency.relation as Schemas.OfRelation.Data;
    const others = [...relation.entry.links.keys()].filter((link) => link !== adjacency.me);
    const props = [...relation.entry.properties];
    if (others.length === 1 && props.length === 0) return entries.map((entry) => this.linked(entry, relation, others[0]!));
    if (others.length === 1 && props.length === 1) { // keyed by a name: no relation the expressions link has another key
      return new Map(entries.map((entry) => [entry[props[0]![0]].get(), this.linked(entry, relation, others[0]!)]));
    }
    return entries.map((entry) => {
      const out: PlainMap = new Map(others.map((link) => [link, this.linked(entry, relation, link)]));
      for (const [name, prop] of props) {
        const [present, plain] = value(entry[name], prop.schema, this.names);
        if (present) out.set(name, plain);
      }
      return out;
    });
  }

  private linked(entry: any, relation: Schemas.OfRelation.Data, link: string): PlainData {
    let target = entry[link];
    if (Builders._builder_for(target) !== null) {
      target = this.reader(target);
    } else {
      const linked = Builders._linked(target);
      target = linked !== null ? this.reader(linked) : Builders._linked_data(target) ?? target;
    }
    if (!Proxies._is_data(target)) { // data an expression links is its terms, each nested
      const steps = this.store._path(Builders._linked(target));
      if (steps !== null) return new Map([[REF, schemaPath(steps)]]);
    }
    const held = Builders._linked(target) ?? target;
    if (this.met.has(held)) throw new ValueError("an expression links one of its terms from two places: it is written as a tree");
    this.met.add(held);
    const body = this.object(target);
    const own = target.as_schema();
    const kinds = Proxies._linkKinds(relation, link);
    if (kinds !== null) return new Map([[[...kinds].find(([, kind]) => Schemas.is_a(own, kind))![0], body]]);
    return fillers(this.store, relation, link).length === 1 ? body : new Map([[this.store.name_of(own), body]]);
  }
}

/** Builds, through `visitor`, the object an expression's nested form gives (`Expression`). */
function built(store: any, visitor: any, schema: any, body: unknown, where: Where): any {
  if (!(body instanceof Map)) {
    throw new DecodeError(`expected an object of ${schema.name}, a mapping of its members`, { path: path(...where) });
  }
  for (const [name, plain] of body as PlainMap) {
    const at = [...where, name];
    if (schema.properties.has(name)) set(visitor, name, decode(schema.properties.get(name).schema, plain, at, store));
    else if (schema.adjacencies.has(name)) visitor[name](given(store, schema.adjacencies.get(name), plain, at));
    else if (name !== "spec" || schema !== store.registered("Schemas.OfPattern")) { // a spec: checked once its symbols are read
      throw new DecodeError(`${repr(name)} is not a member of ${schema.name}`, { path: path(...at) });
    }
  }
  if (body.has("spec") && schema === store.registered("Schemas.OfPattern")) {
    checkedSpec(store, visitor._working.symbols, body.get("spec"), [...where, "spec"]);
    visitor.spec(body.get("spec")); // as recorded
  }
  return visitor;
}

const SPEC = "expected a spec's mutations: as_property {name, mutations}, as_adjacency {name, mutations}, an entry {mutations}";

/** Checks a spec read from the wire before anything is written, so that a document refused writes nothing and says where:
 * each symbol the pattern's, each member its object's schema's, each value decoded against its schema. */
function checkedSpec(store: any, symbols: Map<string, any>, spec: unknown, where: Where): void {
  if (!Array.isArray(spec)) throw new DecodeError("expected a list of what holds of a frame, by symbol", { path: path(...where) });
  spec.forEach((item, i) => {
    if (!(item instanceof Map)) {
      throw new DecodeError("expected a mapping of symbols to their objects' mutations", { path: path(...where, i) });
    }
    for (const [symbol, members] of item as PlainMap) {
      const held = symbols.get(symbol);
      if (held === undefined) throw new DecodeError(`${repr(symbol)} is not a symbol of the pattern`, { path: path(...where, i, symbol) });
      checkedMembers(store, held.schema, members, [...where, i, symbol], symbols);
    }
  });
}

/** Checks what a spec gives of an object of `schema` (`checkedSpec`): a fault in its shape is reported where it is
 * found, as what a spec's mutations are. */
function checkedMembers(store: any, schema: any, members: unknown, where: Where, symbols: Map<string, any>): void {
  (Array.isArray(members) ? members : [null]).forEach((member, j) => {
    const at = [...where, j];
    if (!(member instanceof Map) || member.size !== 1) throw new DecodeError(SPEC, { path: path(...at) });
    const [kind, body] = [...(member as Map<string, any>)][0]!;
    try {
      const [name, verbs] = [body.get("name"), body.get("mutations")];
      if (verbs === undefined) throw new TypeError(SPEC);
      if (kind === "as_property" && schema.properties.has(name)) {
        checkedValues(store, schema.properties.get(name).schema, verbs, [...at, kind, "mutations"]);
      } else if (kind === "as_adjacency" && schema.adjacencies.has(name)) {
        const relation = schema.adjacencies.get(name).relation;
        verbs.forEach((verb: Map<string, any>, k: number) => {
          const [verbKind, verbBody] = [...verb][0]!;
          verbBody.get("entries").forEach((e: Map<string, any>, n: number) => {
            e.get("mutations").forEach((item: Map<string, any>, i: number) => {
              checkedEntry(store, name, relation, item, [...at, kind, "mutations", k, verbKind, "entries", n, "mutations", i], symbols);
            });
          });
        });
      } else {
        throw new DecodeError(`${schema.name} has no ${kind.slice(3)} ${repr(name)}`, { path: path(...at, kind) });
      }
    } catch (error) {
      if (error instanceof DecodeError) throw error;
      throw new DecodeError(SPEC, { path: path(...at) });
    }
  });
}

function checkedValues(store: any, schema: any, verbs: Map<string, any>[], where: Where): void {
  verbs.forEach((verb, k) => {
    if (verb.has("set")) decode(schema, verb.get("set").get("value"), [...where, k, "set", "value"], store);
  });
}

/** Checks one of an entry's mutations: its property's value, or what its link refers to or defines. */
function checkedEntry(store: any, adjacency: string, relation: any, member: Map<string, any>, where: Where,
  symbols: Map<string, any>): void {
  const [kind, body] = [...member][0]!;
  const at = [...where, kind];
  if (kind === "as_property" && relation.entry.properties.has(body.get("name"))) {
    checkedValues(store, relation.entry.properties.get(body.get("name")).schema, body.get("mutations"), [...at, "mutations"]);
  } else if (kind === "as_link" && relation.entry.links.has(body.get("name"))) {
    const given: Map<string, any> = body.get("mutations")[0].get("set") ?? new Map();
    const ref: Map<string, any> = given.get("ref") ?? new Map();
    if (given.has("def")) {
      const definition = given.get("def");
      checkedMembers(store, store.registered(definition.get("schema")), definition.get("mutations"),
        [...at, "mutations", 0, "set", "def", "mutations"], symbols);
    } else if (ref.has("symbol") && !symbols.has(ref.get("symbol"))) {
      throw new DecodeError(`${repr(ref.get("symbol"))} is not a symbol of the pattern`,
        { path: path(...at, "mutations", 0, "set", "ref", "symbol") });
    } else if (ref.has("path")) {
      stepsOf(ref.get("path"), [...at, "mutations", 0, "set", "ref", "path"]);
    }
  } else {
    throw new DecodeError(`an entry of ${repr(adjacency)} has no ${kind.slice(3)} ${repr(body.get("name"))}`, { path: path(...at) });
  }
}

/** An adjacency's entries in an expression's nested form, as its builder takes them: what each links, the peer
 * shorthand; a mapping by the entry's one property; or each entry's links and properties. */
function given(store: any, adjacency: Schemas.OfAdjacency.Data, plain: unknown, where: Where): unknown {
  const relation = adjacency.relation as Schemas.OfRelation.Data;
  const others = [...relation.entry.links.keys()].filter((link) => link !== adjacency.me);
  const props = [...relation.entry.properties];
  if (others.length === 1 && props.length === 0) {
    if (!Array.isArray(plain)) throw new DecodeError("expected a list of what the entries link", { path: path(...where) });
    return plain.map((item, i) => itemOf(store, relation, others[0]!, item, [...where, i]));
  }
  if (others.length === 1 && props.length === 1) {
    if (!(plain instanceof Map)) {
      throw new DecodeError(`expected a mapping of each entry's ${props[0]![0]} to what it links`, { path: path(...where) });
    }
    return new Map([...(plain as PlainMap)].map(([key, item]) => [key, itemOf(store, relation, others[0]!, item, [...where, key])]));
  }
  if (!Array.isArray(plain)) throw new DecodeError("expected a list of entries", { path: path(...where) });
  return plain.map((item, i) => {
    const at = [...where, i];
    if (!(item instanceof Map)) throw new DecodeError("expected an entry, a mapping of its links and properties", { path: path(...at) });
    return (e: any) => {
      for (const [name, value] of item as PlainMap) {
        if (others.includes(name)) e[name](itemOf(store, relation, name, value, [...at, name]));
        else if (relation.entry.properties.has(name)) {
          set(e, name, decode(relation.entry.properties.get(name)!.schema as Schemas.OfAny.Data, value, [...at, name], store));
        } else {
          throw new DecodeError(`${repr(name)} is not a link or property of the entry`, { path: path(...at, name) });
        }
      }
      return e;
    };
  });
}

/** The names of the schemas of what `link` may link: the reference object schema it declares, else each object schema
 * that declares an adjacency to `relation` through it. */
function fillers(store: any, relation: Schemas.OfRelation.Data, link: string): string[] {
  const declared = relation.entry.links.get(link)!.schema;
  if (declared instanceof Schemas.OfObject.Data && declared.ref) return [store.name_of(declared)];
  return store._filling(relation, link);
}

/** What an entry links, in an expression's nested form: the object a path names, or a callback defining one where it is
 * linked, through its kind where the link is a kind union; where several schemas fill the link, the schema object its
 * tag names, built. */
function itemOf(store: any, relation: Schemas.OfRelation.Data, link: string, plain: unknown, where: Where): unknown {
  if (plain instanceof Map && plain.size === 1 && plain.has(REF)) {
    const found = byPath(store, plain.get(REF), [...where, REF]);
    if (found === null) throw new DecodeError("no object at this path", { path: path(...where, REF) });
    return found;
  }
  const kinds = Proxies._linkKinds(relation, link);
  if (kinds === null) {
    const names = fillers(store, relation, link);
    if (names.length === 1) {
      const linked = store.registered(names[0]);
      return (e: any) => e[link]((x: any) => built(store, x, linked, plain, where));
    }
    if (!(plain instanceof Map) || plain.size !== 1 || !names.includes([...plain.keys()][0])) {
      throw new DecodeError(`expected an object of one of ${names.join(", ")}, as {schema: object}`, { path: path(...where) });
    }
    const [name, body] = [...(plain as PlainMap)][0]!;
    // several schemas fill the link: schema objects', which it links built
    return built(store, store._meta_builder(name), store.registered(name), body, [...where, name]).create();
  }
  if (!(plain instanceof Map) || plain.size !== 1 || !kinds.has([...plain.keys()][0])) {
    throw new DecodeError(`expected one of the kinds ${[...kinds.keys()].join(", ")}, as {kind: object}`, { path: path(...where) });
  }
  const [kind, body] = [...(plain as PlainMap)][0]!;
  return (e: any) => e[kind]((x: any) => built(store, x, kinds.get(kind), body, [...where, kind]));
}

// --- Entry points ---

function toPlainOfScalar(schema: Schemas.OfScalar.Data, value: Scalar): PlainData {
  return schema.to_plain(value);
}

export interface ToPlainCall {
  (schema: unknown, value: unknown): PlainData;
  OfScalar(schema: Schemas.OfScalar.Data, value: Scalar): PlainData;
  /** A document of `value` alone (`Document`): what it links, by path; a counted object it links is refused. */
  OfObject(schema: Schemas.OfObject.Data, value: Readers.OfObject, uid?: string): PlainMap;
  /** A document of `value` and the counted objects reachable from it (`Document`; Object identity, Decided, 51): one
   * transaction, under `uid` where given. */
  Reachable(schema: Schemas.OfObject.Data, value: Readers.OfObject, uid?: string): PlainMap;
  /** A standalone value as plain data, written as a property holding it writes it: a value object, union value,
   * intersection value or container of `schema`, read through its visitor, or a value of any schema (`OfAny`), of a
   * registered schema or a scalar. */
  Value(schema: unknown, value: unknown): PlainData;
  /** The store as a log of mutations, its initial snapshot (docs/SERIALIZATION.md): modules, then schemas, then the
   * other named singletons, then the remaining reference objects. */
  Snapshot(): PlainData[];
  /** A transaction's expression, as the wire carries it (`Expression`): a journal is a list of them. */
  Transaction(transaction: unknown): PlainMap;
}

/** Serializes values to plain data, naming the schemas of objects in `store`: `ToPlain(store)(schema, value)`
 * dispatches on the schema's kind. `{ flat: true }` writes a dense container of several int indices flat, with its
 * shape, rather than as nested arrays; reading takes either. */
export function ToPlain(store: Visitors.OfStore, options: { flat?: boolean } = {}): ToPlainCall {
  const flat = options.flat ?? false;
  const OfObject = (schema: Schemas.OfObject.Data, value: Readers.OfObject, uid?: string): PlainMap =>
    new Document(store, flat).run(schema, value, false, uid);
  const Value = (schema: unknown, value: any): PlainData => {
    const held = schema;
    if (!(held instanceof Schemas.OfAny.Value)) {
      const own = value.as_schema();
      if (own !== held) throw new TypeError(`value is a ${repr(own.name)}, not an instance of the given schema`);
    }
    return anyValue(new Held(value), schema, new Document(store, flat).ref)[1];
  };
  const call = (schema: unknown, value: unknown): PlainData => {
    if (schema instanceof Schemas.OfScalar.Data) return toPlainOfScalar(schema, value as Scalar);
    if (schema instanceof Schemas.OfObject.Data && schema.ref) return OfObject(schema, value as Readers.OfObject);
    if (VALUES.some((kind) => schema instanceof kind)) return Value(schema, value);
    throw new NotImplementedError(`${schemaTypeName(schema)} is not supported by Plain yet`);
  };
  const named = Proxies._derefFirst; // a path names its schema
  return Object.assign(named(call), {
    OfScalar: named(toPlainOfScalar),
    OfObject: named(OfObject),
    Reachable: named((schema: Schemas.OfObject.Data, value: Readers.OfObject, uid?: string): PlainMap =>
      new Document(store, flat).run(schema, value, true, uid)),
    Snapshot: (): PlainData[] => new LogWriter(store).run(),
    Transaction: (transaction: unknown): PlainMap => new Expression(store).object(transaction),
    Value: named(Value),
  });
}

export interface FromPlainCall {
  (schema: unknown, plain: unknown): unknown;
  OfScalar(schema: Schemas.OfScalar.Data, plain: unknown): Scalar;
  OfObject(schema: Schemas.OfObject.Data, plain: unknown): unknown;
  Reachable(schema: Schemas.OfObject.Data, plain: unknown): unknown;
  /** A standalone value, read from the plain form `ToPlain(store).Value` writes and built through the store's builder
   * of its schema, which the store registers; a scalar as itself. */
  Value(schema: unknown, plain: unknown): unknown;
  /** Applies a log of mutations, an initial snapshot, to the store, through its builders; returns the objects it makes,
   * in order, which the caller holds (a store holds its data objects weakly). */
  /** A sub-clause whose meaning needs an extension the store lacks is ignored, and added to `ignored`, where given. */
  Snapshot(log: unknown, ignored?: Ignored[]): unknown[];
  /** A transaction's expression, read from the form `ToPlain(store).Transaction` writes and built through the store's
   * builders, as a program builds one; `store.transaction(...)` executes it. */
  Transaction(plain: unknown): unknown;
}

/** Deserializes plain data, building objects in `store`: `FromPlain(store)(schema, plain)` dispatches on the schema's
 * kind. */
export function FromPlain(store: Visitors.OfStore): FromPlainCall {
  const OfScalar = (schema: Schemas.OfScalar.Data, plain: unknown): Scalar => {
    try {
      return schema.from_plain(plain);
    } catch (error) {
      throw (error as DecodeError).at("$"); // from_plain throws only DecodeError
    }
  };
  /** Reads a document, executing its transaction, and gives its root (`readDocument`). */
  const OfObject = (schema: Schemas.OfObject.Data, plain: unknown): unknown => readDocument(store, schema, plain);
  const Value = (schema: unknown, plain: unknown): unknown => {
    let decoded = decode(schema as Schemas.OfAny.Data, plain, [], store);
    if (decoded instanceof DecodedRecord || decoded instanceof DecodedElements) {
      let name: string;
      try {
        name = store.name_of(decoded.schema);
      } catch { // name_of throws only LookupError
        throw new TypeError("a standalone value is built through the store's builder of its schema, which the store "
          + "registers; this one is not registered");
      }
      decoded = new Assigned(name, decoded, store);
    }
    return decoded instanceof Assigned ? decoded.make() : decoded;
  };
  const call = (schema: unknown, plain: unknown): unknown => {
    if (schema instanceof Schemas.OfScalar.Data) return OfScalar(schema, plain);
    if (schema instanceof Schemas.OfObject.Data && schema.ref) return OfObject(schema, plain);
    if (VALUES.some((kind) => schema instanceof kind)) return Value(schema, plain);
    throw new NotImplementedError(`${schemaTypeName(schema)} is not supported by Plain yet`);
  };
  const named = Proxies._derefFirst; // a path names its schema
  return Object.assign(named(call), { OfScalar: named(OfScalar), OfObject: named(OfObject), Reachable: named(OfObject),
    Value: named(Value), Snapshot: (log: unknown, ignored?: Ignored[]): unknown[] => new LogReader(store, ignored ?? null).apply(log),
    Transaction: (plain: unknown): unknown => {
      const schema = store.registered("Mutations.OfTransaction");
      return (store as any).Mutations.OfTransaction((t: any) => built(store, t, schema, plain, []));
    } });
}

export { decode as _decode, set as _set, byPath as _by_path };
