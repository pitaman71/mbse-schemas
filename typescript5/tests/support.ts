/** Shared helpers for the test notebooks. Each notebook runs in its own process, so registries start empty. */

import { Plain, Reachable } from "@mbse/schemas/Framework";
import type { PlainData, PlainMap } from "@mbse/schemas/Framework/Plain";
import type { Instance } from "@mbse/schemas/Framework/Proxies";
import type { OfObject } from "@mbse/schemas/Framework/Schemas";
import type { Callback, OfObject as ObjectVisitor, Visitable } from "@mbse/schemas/Framework/Visitors";

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

/** Property Spec for a native-typed property. */
export function text(name: string, native: unknown = String) {
  return (prop: any) => prop.name(name).of((t: any) => t.as_native(native));
}

/** Writes a native property through the visitor protocols (works for property names the DSL cannot reach). */
export function set_property(visitor: any, name: string, value: unknown): void {
  visitor.property(name, (p: any) => p.value((a: any) => a.as_native((n: any) => n.set(value))));
}

/** Reads a native property through the visitor protocols. */
export function get_property(visitor: any, name: string): unknown {
  const found: unknown[] = [];
  visitor.property(name, (p: any) => p.value((a: any) => a.as_native((n: any) => found.push(n.get()))));
  return found[0];
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

/** An object's entries with references resolved to objects, read from a Reachable snapshot (symbols follow
 * `Reachable.of` order). */
export function entries(schema: OfObject.Data, obj: Visitable, adjacency: string): Map<string, any>[] {
  const graph = Plain.ToPlain.Reachable(schema, obj);
  const objects = Reachable.of(obj);
  const root = (graph.get("objects") as PlainMap).get(graph.get("root") as string) as PlainMap;
  const resolve = (value: PlainData): unknown => (value instanceof Map ? objects[Number(String(value.get("$ref")).slice(1))] : value);
  return ((root.get(adjacency) as PlainMap[] | undefined) ?? []).map((e) => new Map([...e].map(([k, v]) => [k, resolve(v)])));
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

/** Snapshot equality up to symbol numbering and entry order. Objects are identified by their own property values,
 * which must be distinct within each graph. */
export function same_graph(a: PlainData, b: PlainData): boolean {
  const byKey = ([x]: [string, unknown], [y]: [string, unknown]) => (x < y ? -1 : x > y ? 1 : 0);
  /** A value without the symbols and entries in it. */
  const content = (value: unknown): unknown => value instanceof Map
    ? [...value].filter(([k, v]) => k !== "$id" && !Array.isArray(v)).map(([k, v]) => [k, content(v)] as [string, unknown]).sort(byKey)
    : value;
  const canonical = (graph: PlainMap): string => {
    const objects = graph.get("objects") as Map<string, PlainMap>;
    const labels = new Map<string, string>();
    for (const [symbol, obj] of objects) labels.set(symbol, key(content(obj)));
    assert(new Set(labels.values()).size === labels.size, "objects must have distinct property values");
    const holders: [string, PlainMap][] = []; // every object and value object, by label
    const visit = (label: string, mapping: PlainMap): void => {
      holders.push([label, mapping]);
      for (const [k, v] of mapping) {
        if (v instanceof Map && k !== "$schema") {
          if (v.has("$id")) labels.set(v.get("$id") as string, `${label}.${k}`);
          visit(`${label}.${k}`, v);
        }
      }
    };
    for (const [symbol, obj] of objects) visit(labels.get(symbol) as string, obj);
    const entry = (e: PlainMap): string =>
      key([...e].map(([k, v]) => [k, v instanceof Map ? labels.get(v.get("$ref") as string) : v] as [string, unknown]).sort(byKey));
    const lists = holders.map(([label, mapping]) => key([
      label,
      [...mapping].filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as PlainMap[]).map(entry).sort()]).sort(),
    ]));
    return key([labels.get(graph.get("root") as string), lists.sort()]);
  };
  return canonical(a as PlainMap) === canonical(b as PlainMap);
}

/**
 * A minimal hand-written `Visitors.Visitable`, independent of Proxies.
 *
 * `values` maps property names to native values. `adjacencies` maps adjacency names to lists of entries; an entry
 * maps link names to `Fake` objects and property names to native values. Nothing is checked against a schema, so
 * fakes can express data that proxies would never produce.
 */
export class Fake implements Visitable {
  readonly values: Map<string, unknown>;
  readonly adjacencies: Map<string, Record<string, unknown>[]>;
  private static counter = 0;
  private readonly id: unknown;

  constructor(private readonly schemaName: string, values: Record<string, unknown> = {},
    adjacencies: Record<string, Record<string, unknown>[]> = {}, identity?: unknown) {
    this.values = new Map(Object.entries(values));
    this.adjacencies = new Map(Object.entries(adjacencies).map(([k, v]) => [k, [...v]]));
    this.id = identity ?? `fake:${++Fake.counter}`;
  }

  identity(): unknown {
    return this.id;
  }

  schema_name(): string {
    return this.schemaName;
  }

  owner(): null {
    return null;
  }

  accept(visitor: ObjectVisitor): void {
    for (const [name, value] of this.values) set_property(visitor, name, value);
    for (const [name, items] of this.adjacencies) {
      for (const item of items) visitor.adjacency(name, (a) => a.add((e) => write(e, item)));
    }
  }
}

function write(entry: any, item: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(item)) {
    if (value instanceof Fake) entry.link(name, (k: any) => k.set(value));
    else set_property(entry, name, value);
  }
}

/** Parameter counts of every protocol method, from Python's signatures (TypeScript interfaces vanish at runtime). */
export const PROTOCOLS: Record<string, Record<string, number>> = {
  OfAny: { as_native: 1, as_object: 1, as_union: 1, as_intersection: 1 },
  OfNative: { has: 0, get: 0, set: 1, clear: 0 },
  OfProperty: { name: 0, has: 0, value: 1, clear: 0 },
  OfObject: { properties: 1, has: 1, property: 2, clear: 1, adjacencies: 1, adjacency: 2, identify: 1 },
  OfAdjacency: { name: 0, me: 0, entries: 1, add: 1, remove: 1 },
  OfEntry: { links: 1, link: 2, properties: 1, has: 1, property: 2, clear: 1 },
  OfLink: { name: 0, target: 1, set: 1 },
  OfRelation: { links: 1, entries: 1 },
  OfUnion: { properties: 1, has: 1, property: 2, clear: 1 },
  OfIntersection: { properties: 1, has: 1, property: 2, clear: 1 },
  Visitable: { identity: 0, schema_name: 0, owner: 0, accept: 1 },
};

/** Methods of `protocol` that `implementation` lacks, or declares with a different number of parameters. */
export function conformance_problems(implementation: { name: string; prototype: object }, protocol: string): string[] {
  const problems: string[] = [];
  for (const [method, arity] of Object.entries(PROTOCOLS[protocol] ?? {})) {
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
  return Object.keys(PROTOCOLS[protocol] ?? {})
    .filter((method) => typeof (instance as Record<string, unknown>)[method] !== "function")
    .map((method) => `${instance.constructor.name} instance: ${protocol}.${method} is not callable`);
}

export type { Callback, Instance };
