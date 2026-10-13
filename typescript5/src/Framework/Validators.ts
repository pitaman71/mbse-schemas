/**
 * Validators: check data against its schema, only when the caller asks.
 *
 * `Validate(store)(schema, value)` returns a list of problems (empty when valid). It is constructed with the store that
 * looks schemas up by name (see `Stores`). `Validate(store).Reachable(schema, root)` checks the root
 * and every object reachable from it.
 *
 * `Check(store)(schema, value)` checks the same, and also reports what it cannot decide: an `Outcome` of `problems`
 * and `unknowns`, which `holds` true, false or unknown.
 *
 * The validator is a visitor: each object writes itself into a recorder through `Visitable.accept`. Checks:
 *
 * - the schemas involved pass `validate()`;
 * - each property value has exactly its schema's scalar type (distinct scalar types are never interchangeable);
 * - each entry sets every link, its property values have their scalar types, and each linked object's schema
 *   declares an adjacency to that relation via that link;
 * - `unique(S)` clauses hold over the entries seen: entries that agree on everything outside `S` agree on `S`.
 *   Uniqueness is checked only over the entries reachable from what was validated.
 * - a value object's properties are declared by its schema and hold values of their types, recursively;
 * - a union value holds exactly one of the union's branches, with a value of that branch's type;
 * - an intersection value holds every one of the intersection's parts, each with a value of that part's type.
 */

import { NotImplementedError } from "./Errors.js";
import { schemaTypeName } from "./Plain.js";
import { scalarKey } from "./Proxies.js";
import * as Reachable from "./Reachable.js";
import { repr, sortedStrings, tokenName, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type * as Stores from "./Stores.js";
import type { Callback, Scalar, OfAdjacency, OfAny, OfEntry, OfIntersection, OfLink, OfScalar,
  OfObject, OfProperty, OfUnion, Visitable } from "./Visitors.js";

// --- Recorders: Visitors that capture what an object writes into them ---

/** `Visitors.OfProperty` / `OfAny` / `OfScalar` recording one value into a map: a scalar, or a value object, a
 * union value or an intersection value (an `_ObjectRecord` of that kind). */
export class _Value implements OfProperty, OfAny, OfScalar {
  constructor(private readonly values: Map<string, unknown>, private readonly slotName: string) {}

  name(): string {
    return this.slotName;
  }

  has(): boolean {
    return this.values.has(this.slotName);
  }

  get(): Scalar {
    return this.values.get(this.slotName) as Scalar;
  }

  set(value: Scalar): _Value {
    this.values.set(this.slotName, value);
    return this;
  }

  clear(): _Value {
    this.values.delete(this.slotName);
    return this;
  }

  value(callback: Callback<OfAny>): _Value {
    callback(this);
    return this;
  }

  as_scalar(callback: Callback<OfScalar>): _Value {
    callback(this);
    return this;
  }

  as_object(callback: Callback<OfObject>): _Value {
    return this.record("object", callback);
  }

  as_union(callback: Callback<OfUnion>): _Value {
    return this.record("union", callback as unknown as Callback<OfObject>);
  }

  as_intersection(callback: Callback<OfIntersection>): _Value {
    return this.record("intersection", callback as unknown as Callback<OfObject>);
  }

  private record(recordKind: Kind, callback: Callback<OfObject>): _Value {
    let record = this.values.get(this.slotName);
    if (!(record instanceof _ObjectRecord) || record.kind !== recordKind) {
      this.values.set(this.slotName, (record = new _ObjectRecord(recordKind)));
    }
    callback(record as _ObjectRecord);
    return this;
  }
}

export class _Link implements OfLink {
  constructor(private readonly targets: Map<string, Visitable>, private readonly linkName: string) {}

  name(): string {
    return this.linkName;
  }

  target(callback: Callback<Visitable>): _Link {
    callback(this.targets.get(this.linkName) as Visitable);
    return this;
  }

  set(target: Visitable): _Link {
    this.targets.set(this.linkName, target);
    return this;
  }
}

/** `Visitors.OfEntry` recording one entry's links and property values. */
export class _EntryRecord implements OfEntry {
  readonly targets = new Map<string, Visitable>();
  readonly values = new Map<string, unknown>();

  links(callback: Callback<OfLink>): _EntryRecord {
    for (const name of [...this.targets.keys()]) callback(new _Link(this.targets, name));
    return this;
  }

  link(name: string, callback: Callback<OfLink>): _EntryRecord {
    callback(new _Link(this.targets, name));
    return this;
  }

  properties(callback: Callback<OfProperty>): _EntryRecord {
    for (const name of [...this.values.keys()]) callback(new _Value(this.values, name));
    return this;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): _EntryRecord {
    callback(new _Value(this.values, name));
    return this;
  }

  clear(name: string): _EntryRecord {
    this.values.delete(name);
    return this;
  }

  /** Writes the recorded links and property values into `visitor`. */
  replay(visitor: OfEntry): void {
    for (const [name, target] of this.targets) visitor.link(name, (k) => k.set(target));
    for (const [name, value] of this.values) visitor.property(name, (p) => p.value((a) => replay(a, value)));
  }
}

export class _AdjacencyRecord implements OfAdjacency {
  constructor(private readonly adjacencyName: string, private readonly list: _EntryRecord[]) {}

  name(): string {
    return this.adjacencyName;
  }

  me(): string {
    throw new NotImplementedError("the recorder is schema-agnostic");
  }

  entries(callback: Callback<OfEntry>): _AdjacencyRecord {
    for (const entry of this.list) callback(entry);
    return this;
  }

  add(callback: Callback<OfEntry>): _AdjacencyRecord {
    const entry = new _EntryRecord();
    callback(entry);
    this.list.push(entry);
    return this;
  }

  remove(entry: OfEntry): _AdjacencyRecord {
    const kept = this.list.filter((e) => e !== entry);
    this.list.splice(0, this.list.length, ...kept);
    return this;
  }
}

type Kind = "object" | "union" | "intersection";

/** `Visitors.OfObject` recording an object's property values and adjacency entries; also `Visitors.OfUnion` and
 * `Visitors.OfIntersection` recording a union or intersection value (its branches or parts are its properties). It
 * records every property written, so that a union value written with two branches can be reported. */
export class _ObjectRecord implements OfObject {
  /** The value object recorded, once it identifies itself. */
  target: Visitable | null = null;
  readonly values = new Map<string, unknown>();
  readonly adjacencyEntries = new Map<string, _EntryRecord[]>();

  constructor(readonly kind: Kind = "object") {}

  identify(value: Visitable): _ObjectRecord {
    this.target = value;
    return this;
  }

  properties(callback: Callback<OfProperty>): _ObjectRecord {
    for (const name of [...this.values.keys()]) callback(new _Value(this.values, name));
    return this;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  property(name: string, callback: Callback<OfProperty>): _ObjectRecord {
    callback(new _Value(this.values, name));
    return this;
  }

  clear(name: string): _ObjectRecord {
    this.values.delete(name);
    return this;
  }

  adjacencies(callback: Callback<OfAdjacency>): _ObjectRecord {
    for (const [name, list] of this.adjacencyEntries) callback(new _AdjacencyRecord(name, list));
    return this;
  }

  adjacency(name: string, callback: Callback<OfAdjacency>): _ObjectRecord {
    let list = this.adjacencyEntries.get(name);
    if (list === undefined) this.adjacencyEntries.set(name, (list = []));
    callback(new _AdjacencyRecord(name, list));
    return this;
  }

  /** Writes the recorded property values and entries back, so a recorded value object can be read like any object. */
  accept(visitor: OfObject): void {
    for (const [name, value] of this.values) visitor.property(name, (p) => p.value((a) => replay(a, value)));
    for (const [name, list] of this.adjacencyEntries) {
      for (const entry of list) visitor.adjacency(name, (a) => a.add((x) => entry.replay(x)));
    }
  }
}

function replay(visitor: OfAny, value: unknown): void {
  if (value instanceof _ObjectRecord && value.kind === "union") {
    visitor.as_union((u) => value.accept(u as unknown as OfObject));
  } else if (value instanceof _ObjectRecord && value.kind === "intersection") {
    visitor.as_intersection((i) => value.accept(i as unknown as OfObject));
  } else if (value instanceof _ObjectRecord) {
    visitor.as_object((o) => value.accept(o));
  } else {
    visitor.as_scalar((n) => n.set(value as Scalar));
  }
}

// --- Checks ---

/** For messages, per record kind: a value of it, its schema, and what its properties are. */
const RECORDS: Record<Kind, [string, string, string]> = {
  object: ["a value object", "the value object", "property"],
  union: ["a union value", "the union", "branch"],
  intersection: ["an intersection value", "the intersection", "part"],
};

function recordKind(schema: Schemas.OfAny.Data): Kind {
  if (schema instanceof Schemas.OfUnion.Data) return "union";
  if (schema instanceof Schemas.OfIntersection.Data) return "intersection";
  return "object";
}

export function _kind(value: unknown): string {
  if (value instanceof _ObjectRecord) return RECORDS[value.kind][0];
  return typeName(value);
}

function scalarProblem(schema: Schemas.OfScalar.Data, value: unknown): string | null {
  if (schema.type === null) { // an unsupported type is the schema's own problem, reported by its validate()
    return schema.token instanceof Schemas.OfScalar.Token ? `${String(schema.token)} has no type in this implementation` : null;
  }
  if (!Schemas.isScalarOf(schema.type, value)) return `expected ${tokenName(schema.type)}, got ${_kind(value)}`;
  return null;
}

const ABSENT = "absent";

/** One relation entry with all its links, from whichever end it was seen. */
/** Whether `target`, of `schema`, may fill link `name` of `relation`: its schema must declare an adjacency via it. */
function filling(relation: Schemas.OfRelation.Data, name: string, target: Visitable, schema: Schemas.OfObject.Data): string | null {
  if ([...schema.adjacencies.values()].some((a) => a.relation === relation && a.me === name)) return null;
  return `a ${repr(target.schema_name())} cannot fill link ${repr(name)}; its schema declares no adjacency to this relation via ${repr(name)}`;
}

/** Equality key per EQUALITY.md: a scalar's, or a value object's by its properties and its entries, in order. */
function valueKey(value: unknown): string {
  if (!(value instanceof _ObjectRecord)) return scalarKey(value);
  const values = sortedStrings(value.values.keys()).map((name) => [name, valueKey(value.values.get(name))]);
  const entries = sortedStrings(value.adjacencyEntries.keys()).filter((name) => (value.adjacencyEntries.get(name) as _EntryRecord[]).length > 0)
    .map((name) => [name, (value.adjacencyEntries.get(name) as _EntryRecord[]).map(entryKey)]);
  return `object:${JSON.stringify(values)}:${JSON.stringify(entries)}`;
}

/** An entry's equality key: its links' targets by identity and its values by `valueKey`. */
function entryKey(entry: _EntryRecord): [string[][], string[][]] {
  return [sortedStrings(entry.targets.keys()).map((name) => [name, String((entry.targets.get(name) as Visitable).identity())]),
    sortedStrings(entry.values.keys()).map((name) => [name, valueKey(entry.values.get(name))])];
}

class Entry {
  constructor(readonly links: Map<string, Visitable>, readonly values: Map<string, unknown>) {}

  key(names: Iterable<string>): string {
    const parts = sortedStrings(names).map((name) => {
      const link = this.links.get(name);
      if (link !== undefined) return [name, "object", String(link.identity())];
      if (this.values.has(name)) return [name, valueKey(this.values.get(name))];
      return [name, ABSENT];
    });
    return JSON.stringify(parts);
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

  /** Problems with a property's value: its kind and type, recursively, and that a union value holds one branch and an
   * intersection value every part. An application's value is its applied schema's; one that applies itself, a problem
   * its schema reports, has none. */
  private valueProblems(label: string, type: Schemas.OfAny.Data, item: unknown): string[] {
    const schema = Schemas.structure(type) as Schemas.OfAny.Data | null;
    if (schema === null) return [];
    if (schema instanceof Schemas.OfScalar.Data) {
      const problem = scalarProblem(schema, item);
      return problem === null ? [] : [`${label}: ${problem}`];
    }
    const expected = recordKind(schema);
    const [what, owner, member] = RECORDS[expected];
    if (!(item instanceof _ObjectRecord) || item.kind !== expected) return [`${label}: expected ${what}, got ${_kind(item)}`];
    const record = schema as Schemas.OfObject.Data | Schemas.OfUnion.Data | Schemas.OfIntersection.Data;
    const problems: string[] = [];
    for (const [name, value] of item.values) {
      const type = record.properties.get(name)?.type as Schemas.OfAny.Data | undefined;
      if (type === undefined) problems.push(`${label}.${name}: not a ${member} of ${owner}`);
      else problems.push(...this.valueProblems(`${label}.${name}`, type, value));
    }
    if (expected === "union" && item.values.size !== 1) {
      problems.push(`${label}: a union value holds exactly one branch, got ${item.values.size}`);
    }
    const missing = expected === "intersection" ? [...record.properties.keys()].filter((name) => !item.values.has(name)) : [];
    if (missing.length > 0) problems.push(`${label}: parts ${repr(missing)} are not set`);
    if (expected === "object") problems.push(...this.valueEntries(label, schema as Schemas.OfObject.Data, item));
    return problems;
  }

  /** Problems with a value object's entries, which are checked as a reference object's are. */
  private valueEntries(label: string, schema: Schemas.OfObject.Data, item: _ObjectRecord): string[] {
    const problems: string[] = [];
    for (const [name, list] of item.adjacencyEntries) {
      const adjacency = schema.adjacencies.get(name);
      if (adjacency === undefined) {
        problems.push(`${label}.${name}: not an adjacency of the value object`);
        continue;
      }
      list.forEach((entry, i) => problems.push(...this.entry(`${label}.${name}[${i}]`, adjacency, item.target, entry)));
    }
    return problems;
  }

  object(label: string, schema: Schemas.OfObject.Data, value: Visitable): void {
    this.schema(repr(value.schema_name()), schema);
    const record = new _ObjectRecord();
    value.accept(record);
    for (const [name, item] of record.values) {
      const propertyType = schema.properties.get(name)?.type as Schemas.OfAny.Data | undefined;
      if (propertyType === undefined) {
        this.problems.push(`${label}.${name}: not a property of ${repr(value.schema_name())}`);
        continue;
      }
      this.problems.push(...this.valueProblems(`${label}.${name}`, propertyType, item));
    }
    for (const [name, list] of record.adjacencyEntries) {
      const adjacency = schema.adjacencies.get(name);
      if (adjacency === undefined) {
        this.problems.push(`${label}.${name}: not an adjacency of ${repr(value.schema_name())}`);
        continue;
      }
      list.forEach((entry, i) => this.problems.push(...this.entry(`${label}.${name}[${i}]`, adjacency, value, entry)));
    }
  }

  /** Problems with one entry. Its own link may name a value object, the owner of a value object's list; any other link
   * targets a reference object. */
  private entry(label: string, adjacency: Schemas.OfAdjacency.Data, owner: Visitable | null, entry: _EntryRecord): string[] {
    const relation = adjacency.relation as Schemas.OfRelation.Data;
    this.schema(`of ${label}`, relation);
    const problems: string[] = [];
    const links = new Map<string, Visitable | null>([[adjacency.me, owner], ...entry.targets]);
    for (const name of relation.entry.links.keys()) {
      if (!links.has(name)) {
        problems.push(`${label}: link ${repr(name)} is not set`);
        continue;
      }
      const target = links.get(name) as Visitable | null;
      if (target === null) continue; // a value object that did not identify itself
      if (target.owner() !== null) { // the entry's own link may name a value object, the owner of a value object's list
        if (name !== adjacency.me) problems.push(`${label}.${name}: a link targets a reference object, never a value object`);
        continue;
      }
      const problem = filling(relation, name, target, this.store.schema(target.schema_name()));
      if (problem !== null) problems.push(`${label}.${name}: ${problem}`);
    }
    for (const [name, item] of entry.values) {
      const propertyType = relation.entry.properties.get(name)?.type as Schemas.OfAny.Data | undefined;
      if (propertyType === undefined) {
        problems.push(`${label}.${name}: not a property of the relation`);
        continue;
      }
      problems.push(...this.valueProblems(`${label}.${name}`, propertyType, item));
    }
    const full = new Entry(new Map([...links].filter(([, t]) => t !== null)) as Map<string, Visitable>, entry.values);
    let seen = this.entries.get(relation);
    if (seen === undefined) this.entries.set(relation, (seen = new Map()));
    const key = full.key([...relation.entry.links.keys(), ...relation.entry.properties.keys()]);
    if (!seen.has(key)) seen.set(key, full);
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

// --- Entry point ---

/** The property values `value` writes when visited, by name; absent properties are left out. It reads through the
 * visitor protocols, so it works for any `Visitable`. A value object, a union value or an intersection value is
 * returned as an object whose `accept` writes its properties (a union's branch, an intersection's parts) and its
 * entries. */
export function properties_of(value: Visitable | { accept(visitor: OfObject): void }): Map<string, unknown> {
  const record = new _ObjectRecord();
  value.accept(record);
  return new Map(record.values);
}

/** The entries `value` writes when visited, by adjacency name, in order: each an `EntryRecord` of the targets of its
 * other links and its property values, read as `properties_of` reads them. */
export function entries_of(value: Visitable | { accept(visitor: OfObject): void }): Map<string, _EntryRecord[]> {
  const record = new _ObjectRecord();
  value.accept(record);
  return new Map([...record.adjacencyEntries].map(([name, entries]) => [name, [...entries]]));
}

/** An entry as `entries_of` reads it: its other links' targets in `targets`, and its property values in `values`. */
export { _EntryRecord as EntryRecord };

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
  OfObject(schema: Schemas.OfObject.Data, value: Visitable): Outcome;
  Reachable(schema: Schemas.OfObject.Data, root: Visitable): Outcome;
}

/** Checks data against its schema: `Check(store)(schema, value)` gives an `Outcome`, dispatching on the schema's kind. */
export function Check(store: Stores.Store): CheckCall {
  const run = (schema: Schemas.OfObject.Data, values: Visitable[]): Outcome => {
    const root = values[0] as Visitable;
    if (store.schema(root.schema_name()) !== schema) {
      return new Outcome([`the value is a ${repr(root.schema_name())}, not an instance of the given schema`], []);
    }
    const check = new Checker(store);
    values.forEach((value, i) => check.object(`${value.schema_name()}#${i}`, store.schema(value.schema_name()), value));
    check.uniques();
    return new Outcome(check.problems, check.unknowns);
  };
  const OfScalar = (schema: Schemas.OfScalar.Data, value: unknown): Outcome => {
    const problem = scalarProblem(schema, value);
    return new Outcome([...schema.validate(), ...(problem ? [problem] : [])], []);
  };
  /** Checks one object and its entries; uniqueness only over the entries it is part of. */
  const OfObject = (schema: Schemas.OfObject.Data, value: Visitable): Outcome => run(schema, [value]);
  /** Checks the root and every object reachable from it through adjacencies. */
  const ReachableCheck = (schema: Schemas.OfObject.Data, root: Visitable): Outcome => run(schema, Reachable.of(root));
  const call = (schema: unknown, value: unknown): Outcome => {
    if (schema instanceof Schemas.OfScalar.Data) return OfScalar(schema, value);
    if (schema instanceof Schemas.OfObject.Data) return OfObject(schema, value as Visitable);
    throw new NotImplementedError(`${schemaTypeName(schema)} cannot be validated yet`);
  };
  return Object.assign(call, { OfScalar, OfObject, Reachable: ReachableCheck });
}

export interface ValidateCall {
  (schema: unknown, value: unknown): string[];
  OfScalar(schema: Schemas.OfScalar.Data, value: unknown): string[];
  OfObject(schema: Schemas.OfObject.Data, value: Visitable): string[];
  Reachable(schema: Schemas.OfObject.Data, root: Visitable): string[];
}

/** Validates data against its schema: `Validate(store)(schema, value)` gives the problems `Check` finds, so what is
 * unknown is not a problem. */
export function Validate(store: Stores.Store): ValidateCall {
  const check = Check(store);
  const call = (schema: unknown, value: unknown): string[] => check(schema, value).problems;
  return Object.assign(call, {
    OfScalar: (schema: Schemas.OfScalar.Data, value: unknown) => check.OfScalar(schema, value).problems,
    /** Checks one object and its entries; uniqueness only over the entries it is part of. */
    OfObject: (schema: Schemas.OfObject.Data, value: Visitable) => check.OfObject(schema, value).problems,
    /** Checks the root and every object reachable from it through adjacencies. */
    Reachable: (schema: Schemas.OfObject.Data, root: Visitable) => check.Reachable(schema, root).problems,
  });
}

