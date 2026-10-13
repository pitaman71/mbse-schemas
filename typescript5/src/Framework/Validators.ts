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
 * - each property value has exactly its schema's scalar type (distinct scalar types are never interchangeable);
 * - each linked object's schema declares an adjacency to that relation via that link;
 * - `unique(S)` clauses hold over the entries seen: entries that agree on everything outside `S` agree on `S`.
 *   Uniqueness is checked only over the entries reachable from what was validated.
 * - a value object's properties hold values of their types, recursively;
 * - an intersection value holds every one of the intersection's parts, each with a value of that part's type.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { NotImplementedError } from "./Errors.js";
import { schemaTypeName } from "./Plain.js";
import { scalarKey } from "./Proxies.js";
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

/** The value object, union value or intersection value a property's visitor holds, as its own visitor; null when
 * absent. An empty visitor has no identity. */
function held(read: any, schema: unknown): any {
  const select = schema instanceof Schemas.OfUnion.Data ? "as_union"
    : schema instanceof Schemas.OfIntersection.Data ? "as_intersection" : "as_object";
  const found: any[] = [];
  read.as_value((a: any) => a[select]((v: any) => found.push(v)));
  return found.length > 0 && found[0].as_identity() !== "" ? found[0] : null;
}

/** A union's branch's or an intersection's part's value, read through its visitor of its own type's kind: a scalar, a
 * visitor, or null. */
function member(read: any, schema: unknown): unknown {
  if (Schemas.structure(schema) instanceof Schemas.OfScalar.Data) return read.get();
  return read.as_identity() !== "" ? read : null;
}

// --- Checks ---

function scalarProblem(schema: Schemas.OfScalar.Data, value: unknown): string | null {
  if (schema.type === null) { // an unsupported type is the schema's own problem, reported by its validate()
    return schema.token instanceof Schemas.OfScalar.Token ? `${String(schema.token)} has no type in this implementation` : null;
  }
  if (!Schemas.isScalarOf(schema.type, value)) return `expected ${tokenName(schema.type)}, got ${typeName(value)}`;
  return null;
}

/** Whether an object of `schema` may fill link `name` of `relation`: its schema must declare an adjacency via it. */
function filling(relation: Schemas.OfRelation.Data, name: string, schema: Schemas.OfObject.Data): string | null {
  if ([...schema.adjacencies.values()].some((a) => a.relation === relation && a.me === name)) return null;
  return `a ${repr(schema.name)} cannot fill link ${repr(name)}; its schema declares no adjacency to this relation via ${repr(name)}`;
}

const ABSENT = "absent";

/** Equality key per EQUALITY.md, of a value read as `propertyValue` reads it: distinct scalar types never compare
 * equal; floats compare by bit pattern; a value object by its properties and its entries, in order. */
function key(schema: unknown, value: any): string {
  const type = Schemas.structure(schema);
  if (value === null || value === undefined) return ABSENT;
  if (type instanceof Schemas.OfScalar.Data || type === null) return scalarKey(value);
  if (type instanceof Schemas.OfObject.Data) {
    const properties = [...value.as_properties as Iterable<Readers.OfProperty>].map((p) =>
      [p.as_schema().name, key(p.as_schema().type, propertyValue(p, p.as_schema().type))]);
    const entries = [...type.adjacencies].map(([name, a]) => [name, [...value[name]].map((e) => entryKey(e, a))]);
    return `object:${JSON.stringify(properties)}:${JSON.stringify(entries)}`;
  }
  const record = type as Schemas.OfUnion.Data | Schemas.OfIntersection.Data;
  const members = [...record.properties].map(([name, m]) => [name, key(m.type, member(value[name], m.type))]);
  return `record:${JSON.stringify(members)}`;
}

function propertyValue(read: any, schema: unknown): any {
  const type = Schemas.structure(schema);
  return type instanceof Schemas.OfScalar.Data || type === null ? scalar(read) : held(read, type);
}

/** An entry's equality key: its other links' targets by identity and its values by `key`. */
function entryKey(entry: any, adjacency: Schemas.OfAdjacency.Data): string {
  const relation = adjacency.relation as Schemas.OfRelation.Data;
  const links = [...relation.entry.links.keys()].filter((name) => name !== adjacency.me)
    .map((name) => [name, entry[name].as_identity()]);
  const values = [...relation.entry.properties].map(([name, prop]) => [name, key(prop.type, propertyValue(entry[name], prop.type))]);
  return JSON.stringify([links, values]);
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
      problems.push(...this.valueProblems(`${label}.${name}`, prop.as_schema().type, propertyValue(prop, prop.as_schema().type)));
    }
    return problems;
  }

  /** Problems with a value: its type, recursively, and that an intersection value holds every part. An application's
   * value is its applied schema's; one that applies itself, a problem its schema reports, has none. */
  private valueProblems(label: string, type: unknown, item: any): string[] {
    const schema = Schemas.structure(type);
    if (schema === null || item === null || item === undefined) return [];
    if (schema instanceof Schemas.OfScalar.Data) {
      const problem = scalarProblem(schema, item);
      return problem === null ? [] : [`${label}: ${problem}`];
    }
    if (schema instanceof Schemas.OfObject.Data) {
      const problems = this.properties(label, item);
      for (const [name, adjacency] of schema.adjacencies) {
        [...(item[name] as Iterable<unknown>)].forEach((entry, i) =>
          problems.push(...this.entry(`${label}.${name}[${i}]`, adjacency, item, entry)));
      }
      return problems;
    }
    const record = schema as Schemas.OfUnion.Data | Schemas.OfIntersection.Data;
    const problems: string[] = [];
    const members = new Map([...record.properties].map(([name, m]) => [name, member(item[name], m.type)]));
    for (const [name, m] of record.properties) problems.push(...this.valueProblems(`${label}.${name}`, m.type, members.get(name)));
    const missing = [...record.properties.keys()].filter((name) => members.get(name) === null);
    if (record instanceof Schemas.OfIntersection.Data && missing.length > 0) problems.push(`${label}: parts ${repr(missing)} are not set`);
    return problems;
  }

  /** Problems with one entry: each linked object's schema declares an adjacency to the relation via its link, and its
   * values have their types. */
  private entry(label: string, adjacency: Schemas.OfAdjacency.Data, owner: any, entry: any): string[] {
    const relation = adjacency.relation as Schemas.OfRelation.Data;
    this.schema(`of ${label}`, relation);
    const problems: string[] = [];
    for (const name of relation.entry.links.keys()) {
      if (name === adjacency.me) continue;
      const problem = filling(relation, name, entry[name].as_schema());
      if (problem !== null) problems.push(`${label}.${name}: ${problem}`);
    }
    for (const [name, prop] of relation.entry.properties) {
      problems.push(...this.valueProblems(`${label}.${name}`, prop.type, propertyValue(entry[name], prop.type)));
    }
    const links = new Map<string, string>([...relation.entry.links.keys()].filter((name) => name !== adjacency.me)
      .map((name) => [name, entry[name].as_identity()]));
    links.set(adjacency.me, owner.as_identity());
    const values = new Map<string, string>();
    for (const [name, prop] of relation.entry.properties) {
      const found = propertyValue(entry[name], prop.type);
      if (found !== null) values.set(name, key(prop.type, found));
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
  return Object.assign(call, { OfScalar, OfObject, Reachable: ReachableCheck });
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
