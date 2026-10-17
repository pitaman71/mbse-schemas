/**
 * Validators: check data against its schema, only when the caller asks.
 *
 * `Validate(store)(schema, value)` returns a list of problems (empty when valid). It is constructed with the store that
 * looks schemas up by name (see `Stores`). `Validate(store).Reachable(schema, root)` checks the root and every object
 * reachable from it.
 *
 * `Check(store)(schema, value)` checks the same, and also reports what it cannot decide: an `Outcome` of `problems`
 * and `unknowns`, which `holds` true, false or unknown.
 *
 * The validator reads the value through the visitor protocol (`Readers.OfObject`), through its schema. Checks:
 *
 * - the schemas involved pass `validate()`;
 * - each property value has exactly its schema's scalar type (distinct scalars are never interchangeable);
 * - each linked object's schema declares an adjacency to that relation via that link;
 * - `unique(S)` clauses hold over the entries seen: entries that agree on everything outside `S` agree on `S`.
 *   Uniqueness is checked only over the entries reachable from what was validated.
 * - a value object's properties hold values of their schemas, recursively;
 * - an intersection value holds every one of the intersection's parts, each with a value of that part's schema.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Builders from "./Builders.js";
import { NotImplementedError } from "./Errors.js";
import { schemaTypeName } from "./Plain.js";
import { _derefFirst, _key_of, scalarKey } from "./Proxies.js";
import * as Reachable from "./Reachable.js";
import type * as Readers from "./Readers.js";
import { repr, sortedStrings, tokenName, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type * as Stores from "./Stores.js";

// --- Reading values through their visitors ---

/** The scalar a property's visitor holds, or null. */
function scalar(read: any): unknown {
  const found: unknown[] = [];
  read.as_scalar((s: any) => found.push(s.get())); // a callback is always called
  return found[0];
}

/** The `Visitors.OfAny` method that reads a value of `schema`, a value object, union, intersection or container. */
function selecting(schema: unknown): string {
  return schema instanceof Schemas.OfUnion.Data ? "as_union" : schema instanceof Schemas.OfIntersection.Data ? "as_intersection"
    : schema instanceof Schemas.OfContainer.Data ? "as_container" : "as_object";
}

/** The value of any schema a `Visitors.OfAny` holds: a scalar, a visitor of its own kind, or null. */
function anyOf(read: any): any {
  const found: any[] = [];
  read.as_scalar((s: any) => {
    if (s.get() !== null) found.push(s.get());
    return s;
  });
  for (const select of ["as_object", "as_union", "as_intersection", "as_container"]) {
    read[select]((v: any) => {
      if (v.as_schema() !== null) found.push(v);
      return v;
    });
  }
  return found.length > 0 ? found[0] : null;
}

/** The schema a value of any schema has: a scalar's, or its visitor's schema. */
function own(value: any): any {
  const host = Schemas.hostOf(value);
  return host !== null ? new Schemas.OfScalar.Data(host) : value.as_schema();
}

/** The value object, union value or intersection value a property's visitor holds, as its own visitor; null when
 * absent. An empty visitor has no identity. */
function held(read: any, schema: unknown): any {
  const found: any[] = [];
  if (schema instanceof Schemas.OfAny.Value) {
    read.as_value((a: any) => found.push(anyOf(a)));
    return found[0];
  }
  read.as_value((a: any) => a[selecting(schema)]((v: any) => found.push(v)));
  return found[0].as_schema() !== null ? found[0] : null; // a callback is always called; a visitor of nothing has no schema
}

/** A union's branch's or an intersection's part's value, read through its visitor of its own schema's kind: a scalar, a
 * visitor, or null. */
function member(read: any, schema: unknown): unknown {
  if (schema instanceof Schemas.OfScalar.Data) return read.get();
  return read.as_schema() !== null ? read : null;
}

/** A container's element, read through its `Visitors.OfAny`: a scalar or a visitor; an element present holds one. */
function element(read: any, schema: unknown): any {
  const held = schema;
  const found: unknown[] = [];
  if (held instanceof Schemas.OfScalar.Data || held === null) read.as_scalar((s: any) => found.push(s.get()));
  else if (held instanceof Schemas.OfAny.Value) return anyOf(read);
  else read[selecting(held)]((v: any) => found.push(v));
  return found[0];
}

/** A container's elements, each with its index, in order. */
function pairs(read: any): [unknown, any][] {
  const found: [unknown, any][] = [];
  read.as_entries((it: Iterator<[unknown, any]>) => found.push(...{ [Symbol.iterator]: () => it }));
  return found;
}

const schemaNumbers = new WeakMap<object, number>();
let schemaCount = 0;

/** A linked object's identity, unique among the objects of every schema: an identity is unique within its schema. */
function identity(target: any): string {
  return `${numberOf(target.as_schema())}:${_key_of(target)}`;
}

/** A number for each schema, as Python's `id()` of it. */
function numberOf(schema: object): number {
  if (!schemaNumbers.has(schema)) schemaNumbers.set(schema, ++schemaCount);
  return schemaNumbers.get(schema) as number;
}

// --- Checks ---

function scalarProblem(schema: Schemas.OfScalar.Data, value: unknown): string | null {
  if (schema.type === null) return null; // not a basic scalar: the schema's own problem, reported by its validate()
  if (!Schemas.isScalarOf(schema.type, value)) return `expected ${tokenName(schema.type)}, got ${typeName(value)}`;
  return null;
}

/** Whether an object of `schema` may fill link `name` of `relation`: its schema must declare an adjacency via it, named
 * or anonymous. */
/** A linked object, as a visitor: a schema object, which an extension's relation links, through its read-only builder,
 * whose schema is its meta-schema. */
/** A linked object, as a visitor: a schema object, which an extension's relation links, through its read-only builder in
 * `store`, whose schema is the store's plain schema of it. */
function visited(target: any, store: unknown): any {
  const builder = Builders._builder_for(target) as (new (...args: unknown[]) => unknown) | null;
  return builder === null ? target : new builder(target, false, store);
}

function filling(relation: Schemas.OfRelation.Data, name: string, schema: Schemas.OfObject.Data): string | null {
  if (schema.fills(relation, name)) return null;
  return `a ${repr(schema.name)} cannot fill link ${repr(name)}; its schema declares no adjacency, named or anonymous, to this relation via ${repr(name)}`;
}

const ABSENT = "absent";

/** Equality key per EQUALITY.md, of a value read as `propertyValue` reads it: distinct scalars never compare
 * equal; floats compare by bit pattern; a value object by its properties. */
function key(schema: unknown, value: any): string {
  const held = schema;
  if (value === null || value === undefined) return ABSENT;
  if (held instanceof Schemas.OfScalar.Data || held === null) return scalarKey(value);
  if (held instanceof Schemas.OfAny.Value) {
    const of = own(value);
    return `any:${of instanceof Schemas.OfScalar.Data ? of.tag : numberOf(of)}:${key(of, value)}`;
  }
  if (held instanceof Schemas.OfContainer.Data) {
    const keyed = pairs(value).map(([index, e]) => JSON.stringify([
      Array.isArray(index) ? index.map(scalarKey) : scalarKey(index), // a value object index by its values too
      key(held.element, element(e, held.element))]));
    return `container:${JSON.stringify(sortedStrings(keyed))}`;
  }
  if (held instanceof Schemas.OfObject.Data) {
    const properties = [...value.as_properties as Iterable<Readers.OfProperty>].map((p) =>
      [p.as_schema().name, key(p.as_schema().schema, propertyValue(p, p.as_schema().schema))]);
    return `object:${JSON.stringify(properties)}`;
  }
  const record = held as Schemas.OfUnion.Data | Schemas.OfIntersection.Data;
  const members = [...record.properties].map(([name, m]) => [name, key(m.schema, member(value[name], m.schema))]);
  return `record:${JSON.stringify(members)}`;
}

function propertyValue(read: any, schema: unknown): any {
  return schema instanceof Schemas.OfScalar.Data || schema === null ? scalar(read) : held(read, schema);
}

/** One relation entry with all its links, from whichever end it was seen: identities and value keys. */
class Entry {
  constructor(readonly links: Map<string, string>, readonly values: Map<string, string>) {}

  key(names: Iterable<string>): string {
    return JSON.stringify(sortedStrings(names).map((name) => {
      const link = this.links.get(name);
      if (link !== undefined) return [name, "object", link];
      return [name, this.values.get(name) ?? ABSENT];
    }));
  }
}

class Checker {
  readonly problems: string[] = [];
  readonly unknowns: string[] = [];
  private readonly schemasChecked = new Set<unknown>();
  private readonly entries = new Map<Schemas.OfRelation.Data, Map<string, Entry>>();

  constructor(private readonly store: Stores.Store) {}

  private schema(label: string, schema: { validate(): string[] }): void {
    if (this.schemasChecked.has(schema)) return;
    this.schemasChecked.add(schema);
    this.problems.push(...schema.validate().map((problem) => `schema ${label}: ${problem}`));
  }

  object(label: string, schema: Schemas.OfObject.Data, value: Readers.OfObject): void {
    this.schema(repr(schema.name), schema);
    this.problems.push(...this.properties(label, value));
    for (const [name, adjacency] of schema.adjacencies) {
      [...(value[name] as Iterable<unknown>)].forEach((entry, i) =>
        this.problems.push(...this.entry(`${label}.${name}[${i}]`, adjacency, value, entry)));
    }
  }

  private properties(label: string, value: any): string[] {
    const problems: string[] = [];
    for (const prop of value.as_properties as Iterable<Readers.OfProperty>) {
      const name = prop.as_schema().name;
      problems.push(...this.valueProblems(`${label}.${name}`, prop.as_schema().schema, propertyValue(prop, prop.as_schema().schema)));
    }
    return problems;
  }

  /** Problems with a value: its schema, recursively, and that an intersection value holds every part. An application's
   * value is its applied schema's; one that applies itself, a problem its schema reports, has none. */
  private valueProblems(label: string, schema: unknown, item: any): string[] {
    if (schema === null || item === null || item === undefined) return [];
    if (schema instanceof Schemas.OfScalar.Data) {
      const problem = scalarProblem(schema, item);
      return problem === null ? [] : [`${label}: ${problem}`];
    }
    if (schema instanceof Schemas.OfAny.Value) return this.anyProblems(label, schema, item);
    if (schema instanceof Schemas.OfContainer.Data) {
      return pairs(item).flatMap(([index, e]) =>
        this.valueProblems(`${label}[${repr(index)}]`, schema.element, element(e, schema.element)));
    }
    if (schema instanceof Schemas.OfObject.Data) return this.properties(label, item);
    const record = schema as Schemas.OfUnion.Data | Schemas.OfIntersection.Data;
    const problems: string[] = [];
    const members = new Map([...record.properties].map(([name, m]) => [name, member(item[name], m.schema)]));
    for (const [name, m] of record.properties) problems.push(...this.valueProblems(`${label}.${name}`, m.schema, members.get(name)));
    const missing = [...record.properties.keys()].filter((name) => members.get(name) === null);
    if (record instanceof Schemas.OfIntersection.Data && missing.length > 0) problems.push(`${label}: parts ${repr(missing)} are not set`);
    return problems;
  }

  /** Problems with one entry: each linked object's schema declares an adjacency to the relation via its link, and its
   * values have their schemas. */
  /** Problems with a value of any schema: that it is of one of its schemas, where it is restricted, or of a registered
   * schema, where it is not a scalar; and its own, under its own schema. */
  private anyProblems(label: string, schema: Schemas.OfAny.Value, item: any): string[] {
    const of = own(item);
    const restricted = [...schema.schemas];
    let allowed: boolean;
    let shown: string;
    if (of instanceof Schemas.OfScalar.Data) {
      allowed = restricted.length === 0 || restricted.some((t) => t instanceof Schemas.OfScalar.Data && t.type === of.type);
      shown = String(of.tag);
    } else {
      allowed = restricted.some((t) => t === of);
      shown = repr(of.name);
      if (restricted.length === 0) {
        try {
          this.store.name_of(of);
          allowed = true;
        } catch { // a store's name_of refuses an unregistered schema
          return [`${label}: a value of any schema is of a registered schema; ${shown} is not registered`];
        }
      }
    }
    if (!allowed) return [`${label}: ${shown} is not one of its schemas`];
    return this.valueProblems(label, of, item);
  }

  private entry(label: string, adjacency: Schemas.OfAdjacency.Data, owner: any, entry: any): string[] {
    const relation = adjacency.relation as Schemas.OfRelation.Data;
    this.schema(`of ${label}`, relation);
    const problems: string[] = [];
    for (const name of relation.entry.links.keys()) {
      if (name === adjacency.me) continue;
      const problem = filling(relation, name, visited(entry[name], this.store).as_schema());
      if (problem !== null) problems.push(`${label}.${name}: ${problem}`);
    }
    for (const [name, prop] of relation.entry.properties) {
      problems.push(...this.valueProblems(`${label}.${name}`, prop.schema, propertyValue(entry[name], prop.schema)));
    }
    const links = new Map<string, string>([...relation.entry.links.keys()].filter((name) => name !== adjacency.me)
      .map((name) => [name, identity(visited(entry[name], this.store))]));
    links.set(adjacency.me, identity(owner));
    const values = new Map<string, string>();
    for (const [name, prop] of relation.entry.properties) {
      const found = propertyValue(entry[name], prop.schema);
      if (found !== null) values.set(name, key(prop.schema, found));
    }
    const full = new Entry(links, values);
    let seen = this.entries.get(relation);
    if (seen === undefined) this.entries.set(relation, (seen = new Map()));
    const fullKey = full.key([...relation.entry.links.keys(), ...relation.entry.properties.keys()]);
    if (!seen.has(fullKey)) seen.set(fullKey, full);
    return problems;
  }

  uniques(): void {
    for (const [relation, entries] of this.entries) {
      const names = new Set([...relation.entry.links.keys(), ...relation.entry.properties.keys()]);
      for (const unique of relation.uniques) {
        const rest = [...names].filter((name) => !unique.has(name));
        const determined = new Map<string, string>();
        for (const entry of entries.values()) {
          const restKey = entry.key(rest);
          const uniqueKey = entry.key(unique);
          if (!determined.has(restKey)) determined.set(restKey, uniqueKey);
          if (determined.get(restKey) !== uniqueKey) {
            this.problems.push(
              `unique(${sortedStrings(unique).join(", ")}) violated: entries agreeing on ` +
                `${repr(sortedStrings(rest))} differ on ${repr(sortedStrings(unique))}`,
            );
            break;
          }
        }
      }
    }
  }
}

// --- Entry points ---

/** What a check found: the `problems`, each a reason the data is invalid, and the `unknowns`, each something that
 * could not be decided. */
export class Outcome {
  constructor(readonly problems: string[], readonly unknowns: string[]) {}

  /** Whether the data is valid: false with a problem, else null with an unknown, else true. */
  get holds(): boolean | null {
    return this.problems.length > 0 ? false : this.unknowns.length > 0 ? null : true;
  }
}

export interface CheckCall {
  (schema: unknown, value: unknown): Outcome;
  OfScalar(schema: Schemas.OfScalar.Data, value: unknown): Outcome;
  OfObject(schema: Schemas.OfObject.Data, value: Readers.OfObject): Outcome;
  Reachable(schema: Schemas.OfObject.Data, root: Readers.OfObject): Outcome;
}

/** Checks data against its schema: `Check(store)(schema, value)` gives an `Outcome`, dispatching on the schema's kind. */
export function Check(store: Stores.Store): CheckCall {
  const run = (schema: Schemas.OfObject.Data, values: Readers.OfObject[]): Outcome => {
    const root = values[0] as Readers.OfObject;
    if (root.as_schema() !== schema) {
      return new Outcome([`the value is a ${repr(root.as_schema().name)}, not an instance of the given schema`], []);
    }
    const check = new Checker(store);
    values.forEach((value, i) => check.object(`${value.as_schema().name}#${i}`, value.as_schema(), value));
    check.uniques();
    return new Outcome(check.problems, check.unknowns);
  };
  const OfScalar = (schema: Schemas.OfScalar.Data, value: unknown): Outcome => {
    const problem = scalarProblem(schema, value);
    return new Outcome([...schema.validate(), ...(problem ? [problem] : [])], []);
  };
  /** Checks one object and its entries; uniqueness only over the entries it is part of. */
  const OfObject = (schema: Schemas.OfObject.Data, value: Readers.OfObject): Outcome => run(schema, [value]);
  /** Checks the root and every object reachable from it through adjacencies. */
  const ReachableCheck = (schema: Schemas.OfObject.Data, root: Readers.OfObject): Outcome => run(schema, Reachable.of(root));
  const call = (schema: unknown, value: unknown): Outcome => {
    if (schema instanceof Schemas.OfScalar.Data) return OfScalar(schema, value);
    if (schema instanceof Schemas.OfObject.Data) return OfObject(schema, value as Readers.OfObject);
    throw new NotImplementedError(`${schemaTypeName(schema)} cannot be validated yet`);
  };
  const named = _derefFirst; // a path names its schema
  return Object.assign(named(call), { OfScalar: named(OfScalar), OfObject: named(OfObject), Reachable: named(ReachableCheck) });
}

export interface ValidateCall {
  (schema: unknown, value: unknown): string[];
  OfScalar(schema: Schemas.OfScalar.Data, value: unknown): string[];
  OfObject(schema: Schemas.OfObject.Data, value: Readers.OfObject): string[];
  Reachable(schema: Schemas.OfObject.Data, root: Readers.OfObject): string[];
}

/** Validates data against its schema: `Validate(store)(schema, value)` gives the problems `Check` finds, so what is
 * unknown is not a problem. */
export function Validate(store: Stores.Store): ValidateCall {
  const check = Check(store);
  const call = (schema: unknown, value: unknown): string[] => check(schema, value).problems;
  return Object.assign(call, {
    OfScalar: (schema: Schemas.OfScalar.Data, value: unknown) => check.OfScalar(schema, value).problems,
    /** Checks one object and its entries; uniqueness only over the entries it is part of. */
    OfObject: (schema: Schemas.OfObject.Data, value: Readers.OfObject) => check.OfObject(schema, value).problems,
    /** Checks the root and every object reachable from it through adjacencies. */
    Reachable: (schema: Schemas.OfObject.Data, root: Readers.OfObject) => check.Reachable(schema, root).problems,
  });
}
