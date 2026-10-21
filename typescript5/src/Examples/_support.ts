// Helpers shared by the examples.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Instance } from "@mbse/schemas/Framework/Proxies";
import type { PlainData } from "@mbse/schemas/Framework/Plain";

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

/** The entries of `obj`'s adjacency, read through the visitor protocol: each a map of the other links' objects and the
 * properties' values that are set. */
export function entries(_schema: unknown, obj: Instance, adjacency: string): Map<string, unknown>[] {
  const read = obj[adjacency];
  const me = read.as_schema().me;
  return [...read].map((entry: any) => {
    const row = new Map<string, unknown>();
    for (const link of entry.as_schema().links.keys()) if (link !== me) row.set(link, entry[link]);
    for (const name of entry.as_schema().properties.keys()) {
      const value = entry[name].get();
      if (value !== null) row.set(name, value);
    }
    return row;
  });
}

/** A document's objects, by symbol (its number, the root's "0"): each one's properties, as its spec sets them, and its
 * entries, as its spec inserts them, each its links' references and its properties' values. */
export function members(document: any): Map<string, Map<string, unknown>> {
  const pattern = document.get("mutations")[0].get("upsert").get("exists")[0];
  const out = new Map<string, Map<string, unknown>>([...pattern.get("symbols").keys()].map((symbol: string) => [symbol, new Map()]));
  for (const item of pattern.get("spec") ?? []) {
    for (const [symbol, given] of item) {
      for (const member of given) {
        const [kind, body] = [...member][0];
        if (kind === "as_property") {
          out.get(symbol)!.set(body.get("name"), body.get("mutations")[0].get("set").get("value"));
          continue;
        }
        out.get(symbol)!.set(body.get("name"), body.get("mutations")[0].get("insert").get("entries").map((entry: any) => new Map(
          entry.get("mutations").flatMap((verb: any) => [...verb.values()]).map((part: any) => {
            const set = part.get("mutations")[0].get("set");
            return [part.get("name"), set.has("value") ? set.get("value") : set.get("ref")];
          }))));
      }
    }
  }
  return out;
}

/** The registered names of the schemas of a document's objects, by symbol: each read off its path. */
export function schema_names(document: any): Map<string, string> {
  const names = new Map<string, string>();
  for (const [symbol, held] of document.get("mutations")[0].get("upsert").get("exists")[0].get("symbols")) {
    let step = held.get("schema")[0].get("$ref").get("next");
    const parts: string[] = [];
    while (step.has("entry")) {
      parts.push(step.get("entry").get("properties").get("name"));
      step = step.get("entry").get("next");
    }
    names.set(symbol, parts.join("."));
  }
  return names;
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
