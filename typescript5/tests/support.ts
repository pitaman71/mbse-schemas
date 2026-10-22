/** Shared helpers for the test notebooks. Each notebook runs in its own process and makes its own stores. */

import * as Paths from "@mbse/schemas/Framework/Paths";
import type * as Visitors from "@mbse/schemas/Framework/Visitors";
import { _symbol, ToPlain } from "@mbse/schemas/Framework/Plain";
import type { PlainData, PlainMap } from "@mbse/schemas/Framework/Plain";
import type { Instance } from "@mbse/schemas/Framework/Proxies";
import type { Callback } from "@mbse/schemas/Framework/Specs";

/** Python's `assert`. */
export function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(`AssertionError: ${message}`);
}

/** Asserts that `block` throws one of `errors`, optionally with `match` in the message. */
export function raises(errors: Function | Function[], block: () => unknown, match?: string): void {
  const expected = Array.isArray(errors) ? errors : [errors];
  try {
    block();
  } catch (error) {
    if (!expected.some((e) => error instanceof (e as new () => unknown))) throw error;
    if (match !== undefined && !String((error as Error).message).includes(match)) {
      throw new Error(`AssertionError: expected ${JSON.stringify(match)} in ${JSON.stringify((error as Error).message)}`);
    }
    return;
  }
  throw new Error(`AssertionError: expected one of ${expected.map((e) => e.name).join(", ")}`);
}

const BASIC = new Map<unknown, string>([[String, "OfStr"], [BigInt, "OfInt"], [Number, "OfFloat"], [Boolean, "OfBool"],
  [Uint8Array, "OfBytes"]]);

/** The basic scalar schema of a host type in `store`, which holds its own. */
export function basic(store: any, scalar: unknown): any {
  return store.Schemas[BASIC.get(scalar) as string].as_schema();
}

/** Python's `==` on plain data: maps compare regardless of order, ints equal floats of the same value, NaN != NaN. */
export function equal(a: unknown, b: unknown): boolean {
  const numeric = (v: unknown) => typeof v === "bigint" || typeof v === "number";
  if (numeric(a) && numeric(b)) {
    if (typeof a === "bigint" && typeof b === "bigint") return a === b;
    return Number(a) === Number(b);
  }
  if (typeof a === "boolean" || typeof b === "boolean" || a === null || b === null || typeof a === "string") return a === b;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.from(a).equals(Buffer.from(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => b.has(k) && equal(v, b.get(k)));
  return a === b;
}

/** Map literal from an object literal, recursively (keys stay in literal order). */
export function map(value: unknown): any {
  if (Array.isArray(value)) return value.map(map);
  if (value !== null && typeof value === "object" && !(value instanceof Map) && !(value instanceof Uint8Array)) {
    return new Map(Object.entries(value).map(([k, v]) => [k, map(v)]));
  }
  return value;
}

/** Deep copy of plain data. */
export function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, copy(v)])) as T;
  return value;
}

/** Sequence equality with `===` elements. */
export function same(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i] || (Number.isNaN(x) && Number.isNaN(b[i])));
}

/** An object's entries, read through the visitor protocol: each a map of the other links' objects and the values of
 * the properties that are set (a value object as its visitor). */
export function entries(_schema: unknown, obj: any, adjacency: string): Map<string, any>[] {
  const read = obj[adjacency];
  const me = read.as_schema().me;
  return [...read].map((entry: any) => {
    const row = new Map<string, any>();
    for (const link of entry.as_schema().links.keys()) if (link !== me) row.set(link, entry[link]);
    for (const name of entry.as_schema().properties.keys()) {
      const value = value_of(entry[name]);
      if (value !== null) row.set(name, value);
    }
    return row;
  });
}

/** A property's value, read through its visitor: its scalar, or the value object, union value or intersection value it
 * holds, as that value's visitor; null when absent. */
export function value_of(read: any): any {
  if (read.get() !== null) return read.get();
  const found: any[] = [];
  const keep = (v: any) => {
    found.push(v);
    return v;
  };
  read.as_value((a: any) => a.as_object(keep).as_union(keep).as_intersection(keep));
  return found.find((v) => v.as_schema() !== null) ?? null; // a visitor of nothing has no schema
}

/** A stable text key for plain values (bigint, -0.0 and NaN included). */
export function key(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === "bigint") return `int:${v}`;
    if (typeof v === "number") return Object.is(v, -0) ? "float:-0" : Number.isNaN(v) ? "float:nan" : `float:${v}`;
    if (v instanceof Map) return { $map: [...v] };
    return v;
  });
}

/** The registered name a schema object's path, as plain data, gives: its modules' names and its own, dotted. */
export function schema_name(path: PlainMap): string {
  const names: string[] = [];
  let step = path.get("next") as PlainMap;
  while (step.has("entry")) {
    const entry = step.get("entry") as PlainMap;
    names.push((entry.get("properties") as PlainMap).get("name") as string);
    step = entry.get("next") as PlainMap;
  }
  return names.join(".");
}

/** A document (`Plain.ToPlain(store).Reachable`: one transaction, one upsert) as the objects it holds, each listed by its
 * number (its symbol), its schema's name and its members: the properties its spec sets, then the entries it inserts,
 * each a mapping of its links, `{'$ref': {'n': number}}` or `{'$ref': path}`, and its properties. */
export function view(document: any): PlainMap {
  const pattern = document.get("mutations")[0].get("upsert").get("exists")[0];
  const specs = new Map<string, any[]>();
  for (const item of pattern.get("spec") ?? []) {
    for (const [symbol, given] of item) specs.set(symbol, [...(specs.get(symbol) ?? []), ...given]);
  }
  const row = (entry: any): PlainMap => new Map([...entry.get("mutations")].map((member: any) => {
    const [kind, body] = [...member][0];
    const set = body.get("mutations")[0].get("set");
    if (kind === "as_property") return [body.get("name"), set.get("value")];
    const ref = set.get("ref");
    const target = ref.has("symbol") ? new Map([["n", BigInt(ref.get("symbol"))]]) : ref.get("path");
    return [body.get("name"), new Map([["$ref", target]])];
  }));
  const objects = [...pattern.get("symbols")].map(([symbol, held]: [string, any]) => {
    const properties = new Map<string, PlainData>();
    for (const member of specs.get(symbol) ?? []) {
      const [kind, body] = [...member][0];
      properties.set(body.get("name"), kind === "as_property" ? body.get("mutations")[0].get("set").get("value")
        : body.get("mutations")[0].get("insert").get("entries").map(row));
    }
    return listed(schema_name(held.get("schema")[0].get("$ref")), Number(symbol), properties);
  });
  return new Map<string, PlainData>([["root", new Map([["n", 0n]])], ["objects", objects]]);
}

/** What a store's snapshot gives, in its transaction `index` (0, its schemas'; 1, its data's), of the schema object it
 * finds by its name `name`, or of the symbol `name`. */
export function spec_of(snapshot: any, name: string, index = 0): any[] {
  const pattern = snapshot[index].get("mutations")[0].get("upsert").get("exists")[0];
  const found = new Map<string, any[]>();
  for (const item of pattern.get("spec") ?? []) {
    for (const [symbol, members] of item) found.set(symbol, [...(found.get(symbol) ?? []), ...members]);
  }
  if (found.has(name) || pattern.get("symbols").has(name)) return found.get(name) ?? [];
  return [...found.values()].find((members) => given(members).get("name") === name)!;
}

/** The properties a spec's members set, by name. */
export function given(members: any[]): Map<string, any> {
  return new Map(members.filter((m) => m.has("as_property") && m.get("as_property").get("mutations")[0].has("set"))
    .map((m) => [m.get("as_property").get("name"), m.get("as_property").get("mutations")[0].get("set").get("value")]));
}

/** The entries a spec's members insert into `adjacency`, each its links' `set` (a ref or a def) and its properties'
 * values, by name. */
export function entries_in(members: any[], adjacency: string): Map<string, any>[] {
  const out: Map<string, any>[] = [];
  for (const m of members) {
    if (!m.has("as_adjacency") || m.get("as_adjacency").get("name") !== adjacency) continue;
    for (const entry of m.get("as_adjacency").get("mutations")[0].get("insert").get("entries")) {
      const row = new Map<string, any>();
      for (const part of entry.get("mutations")) {
        const [kind, body] = [...part][0];
        const held = body.get("mutations")[0].get("set");
        row.set(body.get("name"), kind === "as_property" ? held.get("value") : held);
      }
      out.push(row);
    }
  }
  return out;
}

/** A document as `view` gives it; an object listing as it is. */
export function listing(snapshot: any): any {
  return snapshot.has("mutations") ? view(snapshot) : snapshot;
}

/** A registered schema's path, as plain data: from the root module, through its modules, to it by name. */
export function schema_path(name: string): PlainMap {
  let step: PlainMap = new Map([["target", new Map()]]);
  for (const part of name.split(".").reverse()) {
    step = map({ entry: { i: "schemas", o: "", properties: { name: part }, next: step } });
  }
  return new Map<string, PlainData>([["singleton", "."], ["next", step]]);
}

/** The document `view` lists: one transaction, each object a symbol, its number, of the schema its name gives, its
 * properties set and its entries inserted, a reference by number to the symbol, else by path. */
export function document(listedObjects: any, uid?: string): PlainMap {
  const given = (name: string, value: unknown) => map({ as_property: { name, mutations: [{ set: { value } }] } });
  const entry = (row: PlainMap) => map({ mutations: [...row].map(([name, value]) => {
    if (value instanceof Map && value.has("$ref")) {
      const target = value.get("$ref") as PlainMap;
      const ref = target.has("n") ? new Map([["symbol", String(target.get("n"))]]) : new Map([["path", target]]);
      return map({ as_link: { name, mutations: [{ set: { ref } }] } });
    }
    return given(name, value);
  }) });
  const symbols = new Map<string, PlainData>();
  const spec: PlainMap[] = [];
  for (const listing_ of listedObjects.get("objects")) {
    const symbol = String(listing_.get("n"));
    symbols.set(symbol, map({ schema: [{ $ref: schema_path(listing_.get("schema")) }] }));
    const members = [...listing_.get("properties")].map(([name, value]: [string, any]) => is_adjacency(value)
      ? map({ as_adjacency: { name, mutations: [{ insert: { entries: value.map(entry) } }] } }) : given(name, value));
    if (members.length > 0) spec.push(new Map([[symbol, members]]));
  }
  const pattern = new Map<string, PlainData>([["symbols", symbols], ...(spec.length > 0 ? [["spec", spec]] as [string, PlainData][] : [])]);
  const upsert = new Map<string, PlainData>([...(uid === undefined ? [] : [["key", uid]] as [string, PlainData][]), ["exists", [pattern]]]);
  return new Map<string, PlainData>([...(uid === undefined ? [] : [["uid", uid]] as [string, PlainData][]), ["mutations", [new Map([["upsert", upsert]])]]]);
}

/** A counted object's entry in an object snapshot's list: its number in the document, its schema's name and its
 * members (docs/OBJECT_IDENTITY.md, Decided, 55). */
export function listed(name: string, number: number, properties: unknown = {}): PlainMap {
  return new Map<string, PlainData>([["n", BigInt(number)], ["schema", name], ["properties", map(properties)]]);
}

/** The object snapshot of one counted object: rooted at it, listing it alone, numbered 0. */
export function single(name: string, properties: unknown = {}): PlainMap {
  return new Map<string, PlainData>([["root", new Map([["n", 0n]])], ["objects", [listed(name, 0, properties)]]]);
}

/** A reference to the counted object a document numbers `number`. */
export function ref(number: number): PlainMap {
  return new Map([["$ref", new Map([["n", BigInt(number)]])]]);
}

/** An owned object's or a singleton's path (`Paths.of`), as plain data. */
export function path_of(obj: any): PlainMap {
  const identity: any = Paths.of(obj);
  return ToPlain(null as any)(identity.as_schema(), identity) as PlainMap;
}

/** An object's key: the `name` of its path's last step, or a singleton's global name. */
export function key_of(obj: unknown): unknown {
  return key_in(path_of(obj));
}

/** The key a path, as plain data, ends with: the `name` of its last step, or a singleton's global name. */
export function key_in(path: PlainMap): unknown {
  let found: unknown = path.get("singleton");
  let step = path.get("next") as PlainMap;
  while (step.has("entry")) {
    const entry = step.get("entry") as PlainMap;
    found = (entry.get("properties") as PlainMap).get("name");
    step = entry.get("next") as PlainMap;
  }
  return found;
}

/** What an object snapshot calls one of the objects it lists: its path, or `{'n': number}`. */
export function called(listing: PlainMap): PlainMap {
  return listing.has("path") ? listing.get("path") as PlainMap : new Map([["n", listing.get("n")!]]);
}

/** The members of the object an object snapshot lists as `call`: a path, or a counted object's number. */
export function members(snapshot: any, call: number | PlainMap): any {
  const wanted = _symbol(typeof call === "number" ? new Map([["n", BigInt(call)]]) : call);
  return listing(snapshot).get("objects").find((o: PlainMap) => _symbol(called(o)) === wanted).get("properties");
}

/** A snapshot's root object's members. */
export function root_of(snapshot: any): any {
  return members(snapshot, listing(snapshot).get("root"));
}

/** Whether a snapshot's list is an adjacency: each of its entries links something, while a list a property holds never
 * has a reference at its top level. */
export function is_adjacency(value: unknown): value is PlainMap[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((e) => e instanceof Map && [...e.values()].some((v) => v instanceof Map && v.has("$ref")));
}

/** Snapshot equality up to the keys objects are written under, the order they are written in, and entry order.
 * Objects are identified by their own property values, which must be distinct within each graph, and value objects by
 * their owner's and the path to them. */
export function same_graph(a: PlainData, b: PlainData): boolean {
  const byKey = ([x]: [string, unknown], [y]: [string, unknown]) => (x < y ? -1 : x > y ? 1 : 0);
  /** A value without the keys and entries in it. */
  const content = (value: unknown): unknown => value instanceof Map
    ? [...value].filter(([k, v]) => k !== "$id" && !is_adjacency(v)).map(([k, v]) => [k, content(v)] as [string, unknown]).sort(byKey)
    : Array.isArray(value) ? value.map(content) : value;
  const canonical = (graph: PlainMap): string => {
    const objects = new Map((graph.get("objects") as PlainMap[]).map((o) => [_symbol(called(o)), o.get("properties") as PlainMap]));
    const labels = new Map<string, string>();
    for (const [symbol, obj] of objects) labels.set(symbol, key(content(obj)));
    assert(new Set(labels.values()).size === labels.size, "objects must have distinct property values");
    const holders: [string, PlainMap][] = []; // every object and value object, by label
    const visit = (label: string, value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach((item, i) => visit(`${label}[${i}]`, item));
      } else if (value instanceof Map) {
        holders.push([label, value]);
        if (value.has("$id")) labels.set(value.get("$id") as string, label);
        for (const [k, item] of value) if (k !== "$schema" && !is_adjacency(item)) visit(`${label}.${k}`, item);
      }
    };
    for (const [symbol, obj] of objects) visit(labels.get(symbol) as string, obj);
    const entry = (e: PlainMap): string => key([...e]
      .map(([k, v]) => [k, v instanceof Map && v.has("$ref") ? labels.get(_symbol(v.get("$ref"))) : v] as [string, unknown])
      .sort(byKey));
    const lists = holders.map(([label, mapping]) => key([
      label,
      [...mapping].filter(([, v]) => is_adjacency(v)).map(([k, v]) => [k, (v as PlainMap[]).map(entry).sort()]).sort(),
    ]));
    return key([labels.get(_symbol(graph.get("root"))), lists.sort()]);
  };
  return canonical(listing(a)) === canonical(listing(b));
}

/** Parameter counts of every protocol method, from Python's signatures (TypeScript interfaces vanish at runtime);
 * `Visitors.OfObject.as_properties` is a property, not a method. */
export const PROTOCOLS: Record<string, Record<string, number>> = {
  OfScalar: { as_schema: 0, get: 0, set: 1, clear: 0 },
  OfAny: { as_schema: 0, as_scalar: 1, as_object: 1, as_union: 1, as_intersection: 1, as_container: 1, clear: 0 },
  OfProperty: { as_schema: 0, as_value: 1, as_scalar: 1, as_object: 1, get: 0 },
  OfObject: { as_schema: 0, as_adjacencies: 1 },
  OfAdjacency: { as_schema: 0, as_iterable: 1, insert: 1, remove: 1, clear: 0 },
  OfEntry: { as_schema: 0 },
  OfUnion: { as_schema: 0 },
  OfIntersection: { as_schema: 0 },
  OfContainer: { as_schema: 0, at: 1, remove: 1, as_ordered: 1, as_dict: 1, as_entries: 1 },
  OfIterator: { first: 0, last: 0, next: 0, prev: 0, index: 0, as_item: 1, prepend: 1, append: 1 },
  OfPattern: { as_schema: 0 },
};

/** Parameter counts of the store protocol's methods, from Python's `Visitors.OfStore`. */
export const STORE_PROTOCOLS: Record<string, Record<string, number>> = {
  OfStore: {
    schema: 1, registered: 1, name_of: 1, names: 0, builder: 2, framework: 1, member: 2, singleton: 1, extent: 1, values: 2,
    entries: 2,
  },
};

function methodsOf(protocol: string): Record<string, number> {
  return PROTOCOLS[protocol] ?? STORE_PROTOCOLS[protocol] ?? {};
}

/** Methods of `protocol` that `implementation` lacks, or declares with a different number of parameters. */
export function conformance_problems(implementation: { name: string; prototype: object }, protocol: string): string[] {
  const problems: string[] = [];
  for (const [method, arity] of Object.entries(methodsOf(protocol))) {
    const member = (implementation.prototype as Record<string, unknown>)[method];
    if (typeof member !== "function") {
      problems.push(`${implementation.name} lacks ${protocol}.${method}`);
      continue;
    }
    if (member.length !== arity) problems.push(`${implementation.name}.${method} takes ${member.length}, not ${arity} parameters`);
  }
  return problems;
}

/** The same check on a live instance: catches instance attributes that shadow protocol methods. */
export function instance_problems(instance: object, protocol: string): string[] {
  return Object.keys(methodsOf(protocol))
    .filter((method) => typeof (instance as Record<string, unknown>)[method] !== "function")
    .map((method) => `${instance.constructor.name} instance: ${protocol}.${method} is not callable`);
}

export type { Callback, Instance };
