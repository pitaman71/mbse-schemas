// Helpers shared by the examples.

import { Plain, Reachable } from "../Framework/index.js";
import type { Instance } from "../Framework/Proxies.js";
import type { PlainData, PlainMap } from "../Framework/Plain.js";
import type { OfObject } from "../Framework/Schemas.js";

/** Python's `assert`. */
export function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(`AssertionError: ${message}`);
}

/** Python's `==` on plain data: maps compare regardless of order, ints equal floats of the same value, NaN != NaN. */
export function equal(a: unknown, b: unknown): boolean {
  const numeric = (v: unknown) => typeof v === "bigint" || typeof v === "number";
  if (numeric(a) && numeric(b)) {
    if (typeof a === "bigint" && typeof b === "bigint") return a === b;
    return Number(a) === Number(b) && (typeof a !== "bigint" || BigInt(Number(a)) === a) && (typeof b !== "bigint" || BigInt(Number(b)) === b);
  }
  if (typeof a === "boolean" || typeof b === "boolean" || a === null || b === null || typeof a === "string") return a === b;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.from(a).equals(Buffer.from(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (a instanceof Map && b instanceof Map) {
    return a.size === b.size && [...a].every(([k, v]) => b.has(k) && equal(v, b.get(k)));
  }
  return a === b;
}

/** Map literal from an object literal, recursively (keys stay in literal order). */
export function map(value: unknown): PlainData {
  if (Array.isArray(value)) return value.map(map);
  if (value !== null && typeof value === "object" && !(value instanceof Map) && !(value instanceof Uint8Array)) {
    return new Map(Object.entries(value).map(([k, v]) => [k, map(v)]));
  }
  return value as PlainData;
}

/** The entries of `obj`'s adjacency, with references resolved to objects.
 *
 * Reading entries back is not part of the API yet, so this reads them from a Reachable snapshot: its symbols are
 * assigned in first-reference order, the same order `Reachable.of` returns. */
export function entries(schema: OfObject.Data, obj: Instance, adjacency: string): Map<string, unknown>[] {
  const graph = Plain.ToPlain.Reachable(schema, obj);
  const objects = Reachable.of(obj);
  const root = (graph.get("objects") as PlainMap).get(graph.get("root") as string) as PlainMap;
  const resolve = (value: PlainData): unknown =>
    value instanceof Map ? objects[Number(String(value.get("$ref")).slice(1))] : value;
  return ((root.get(adjacency) as PlainMap[] | undefined) ?? []).map((e) => new Map([...e].map(([k, v]) => [k, resolve(v)])));
}

/** Snapshot equality up to symbol numbering and entry order. Objects are identified by their own property values,
 * which the examples keep unique within a graph. */
export function same_graph(a: PlainData, b: PlainData): boolean {
  const canonical = (graph: PlainMap): string => {
    const objects = graph.get("objects") as Map<string, PlainMap>;
    const labels = new Map<string, string>();
    for (const [symbol, obj] of objects) {
      const own = [...obj].filter(([, v]) => !Array.isArray(v)).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
      labels.set(symbol, key(own));
    }
    assert(new Set(labels.values()).size === labels.size, "objects must have distinct property values");
    const entry = (e: PlainMap): string =>
      key([...e].map(([k, v]) => [k, v instanceof Map ? labels.get(v.get("$ref") as string) : v] as [string, unknown])
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
    const lists = [...objects].map(([symbol, obj]) => [
      labels.get(symbol),
      [...obj].filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as PlainMap[]).map(entry).sort()]).sort(),
    ]);
    return key([labels.get(graph.get("root") as string), lists.sort()]);
  };
  return canonical(a as PlainMap) === canonical(b as PlainMap);
}

/** A stable text key for plain values (bigint, -0.0 and NaN included). */
export function key(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === "bigint") return `int:${v}`;
    if (typeof v === "number") return Object.is(v, -0) ? "float:-0" : Number.isNaN(v) ? "float:nan" : `float:${v}`;
    if (v instanceof Uint8Array) return `bytes:${Buffer.from(v).toString("hex")}`;
    return v;
  });
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
