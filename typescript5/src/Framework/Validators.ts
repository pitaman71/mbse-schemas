/**
 * Validators: check data against its schema, only when the caller asks.
 *
 * `Validate(store)(schema, value)` returns a list of problems (empty when valid). It is constructed with the store that
 * looks schemas up by name (see `Stores`). `Validate(store).Reachable(schema, root)` checks the root
 * and every object reachable from it.
 *
 * The validator is a visitor: each object writes itself into a recorder through `Visitable.accept`. Checks:
 *
 * - the schemas involved pass `validate()`;
 * - each property value has exactly its schema's native type (distinct native types are never interchangeable);
 * - each entry sets every link, its property values have their native types, and each linked object's schema
 *   declares an adjacency to that relation via that link;
 * - `unique(S)` clauses hold over the entries seen: entries that agree on everything outside `S` agree on `S`.
 *   Uniqueness is checked only over the entries reachable from what was validated.
 * - a value object's properties are declared by its schema and hold values of their types, recursively;
 * - a union value holds exactly one of the union's branches, with a value of that branch's type;
 * - an intersection value holds every one of the intersection's parts, each with a value of that part's type;
 * - each item of a list is a value of the list's item schema.
 */

import { item, LookupError, NotImplementedError } from "./Errors.js";
import { schemaTypeName } from "./Plain.js";
import { nativeKey } from "./Proxies.js";
import * as Reachable from "./Reachable.js";
import { repr, sortedStrings, tokenName, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type * as Stores from "./Stores.js";
import type { Callback, Native, OfAdjacency, OfAny, OfEntry, OfIndexed, OfIntersection, OfItem, OfLink, OfNative,
  OfObject, OfProperty, OfUnion, Visitable } from "./Visitors.js";

// --- Recorders: Visitors that capture what an object writes into them ---

/** `Visitors.OfProperty` / `OfAny` / `OfNative` recording one value into a map: a native, or a value object, a
 * union value or an intersection value (an `_ObjectRecord` of that kind). */
export class _Value implements OfProperty, OfAny, OfNative {
  constructor(private readonly values: Map<string, unknown>, private readonly slotName: string) {}

  name(): string {
    return this.slotName;
  }

  has(): boolean {
    return this.values.has(this.slotName);
  }

  get(): Native {
    return this.values.get(this.slotName) as Native;
  }

  set(value: Native): _Value {
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

  as_native(callback: Callback<OfNative>): _Value {
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

  as_indexed(callback: Callback<OfIndexed>): _Value {
    let record = this.values.get(this.slotName);
    if (!(record instanceof _ListRecord)) this.values.set(this.slotName, (record = new _ListRecord()));
    callback(record as _ListRecord);
    return this;
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

/** `Visitors.OfIndexed` recording a list's items, in order, and their keys: `keys[i]` is the key written with `put`, or
 * null for an item appended. It keeps every item written, so that a key written twice can be reported; an item written
 * with no value is left out. */
export class _ListRecord implements OfIndexed {
  readonly values: unknown[] = [];
  readonly keys: unknown[] = [];

  items(callback: Callback<OfAny>): _ListRecord {
    for (let index = 0, count = this.values.length; index < count; index++) this.item(index, callback);
    return this;
  }

  item(index: number, callback: Callback<OfAny>): _ListRecord {
    const held = new Map([["", item(this.values, index)]]);
    callback(new _Value(held, ""));
    this.keys.splice(index, 1, ...[...held.values()].map(() => this.keys[index]));
    this.values.splice(index, 1, ...held.values());
    return this;
  }

  append(callback: Callback<OfAny>): _ListRecord {
    return this.add(null, callback);
  }

  private add(key: unknown, callback: Callback<OfAny>): _ListRecord {
    const held = new Map<string, unknown>();
    callback(new _Value(held, ""));
    this.keys.push(...[...held.values()].map(() => key));
    this.values.push(...held.values());
    return this;
  }

  remove(index: number): _ListRecord {
    item(this.values, index);
    this.values.splice(index, 1);
    this.keys.splice(index, 1);
    return this;
  }

  clear(): _ListRecord {
    this.values.length = 0;
    this.keys.length = 0;
    return this;
  }

  pairs(callback: Callback<OfItem>): _ListRecord {
    for (let index = 0, count = this.values.length; index < count; index++) callback(new _ItemRecord(this, index));
    return this;
  }

  private written(key: Callback<OfAny>): unknown {
    const held = new Map<string, unknown>();
    key(new _Value(held, ""));
    return held.get("") ?? null;
  }

  private position(key: Callback<OfAny>): number {
    const wanted = valueKey(this.written(key));
    const index = this.keys.findIndex((k) => valueKey(k) === wanted);
    if (index < 0) throw new LookupError("the list has no item with this key");
    return index;
  }

  at(key: Callback<OfAny>, callback: Callback<OfAny>): _ListRecord {
    return this.item(this.position(key), callback);
  }

  put(key: Callback<OfAny>, value: Callback<OfAny>): _ListRecord {
    return this.add(this.written(key), value);
  }

  discard(key: Callback<OfAny>): _ListRecord {
    return this.remove(this.position(key));
  }
}

/** `Visitors.OfItem` over one recorded item: its key, read from a copy, and its value. */
export class _ItemRecord implements OfItem {
  constructor(private readonly record: _ListRecord, private readonly index: number) {}

  key(callback: Callback<OfAny>): _ItemRecord {
    callback(new _Value(new Map([["", this.record.keys[this.index]]]), ""));
    return this;
  }

  value(callback: Callback<OfAny>): _ItemRecord {
    this.record.item(this.index, callback);
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

  /** Writes the recorded property values back, so a recorded value object can be read like any object. */
  accept(visitor: OfObject): void {
    for (const [name, value] of this.values) visitor.property(name, (p) => p.value((a) => replay(a, value)));
  }
}

function replay(visitor: OfAny, value: unknown): void {
  if (value instanceof _ListRecord) {
    visitor.as_indexed((items) => replayItems(items, value));
  } else if (value instanceof _ObjectRecord && value.kind === "union") {
    visitor.as_union((u) => value.accept(u as unknown as OfObject));
  } else if (value instanceof _ObjectRecord && value.kind === "intersection") {
    visitor.as_intersection((i) => value.accept(i as unknown as OfObject));
  } else if (value instanceof _ObjectRecord) {
    visitor.as_object((o) => value.accept(o));
  } else {
    visitor.as_native((n) => n.set(value as Native));
  }
}

function replayItems(visitor: OfIndexed, record: _ListRecord): void {
  record.values.forEach((value, i) => {
    const key = record.keys[i];
    if (key === null) visitor.append((a) => replay(a, value));
    else visitor.put((a) => replay(a, key), (a) => replay(a, value));
  });
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
  return value instanceof _ListRecord ? "a list" : typeName(value);
}

function nativeProblem(schema: Schemas.OfNative.Data, value: unknown): string | null {
  if (schema.type === null) { // an unsupported type is the schema's own problem, reported by its validate()
    return schema.token instanceof Schemas.OfNative.Token ? `${String(schema.token)} has no type in this implementation` : null;
  }
  if (!Schemas.isNativeOf(schema.type, value)) return `expected ${tokenName(schema.type)}, got ${_kind(value)}`;
  return null;
}

const ABSENT = "absent";

/** One relation entry with all its links, from whichever end it was seen. */
/** Whether `target`, of `schema`, may fill link `name` of `relation`: its schema must declare an adjacency via it. */
function filling(relation: Schemas.OfRelation.Data, name: string, target: Visitable, schema: Schemas.OfObject.Data): string | null {
  if ([...schema.adjacencies.values()].some((a) => a.relation === relation && a.me === name)) return null;
  const what = target.schema_name() ? `a ${repr(target.schema_name())}` : "a value object";
  return `${what} cannot fill link ${repr(name)}; its schema declares no adjacency to this relation via ${repr(name)}`;
}

/** Equality key per EQUALITY.md: a native's, or a value object's by its properties. */
function valueKey(value: unknown): string {
  if (value instanceof _ListRecord && value.keys.some((key) => key !== null)) {
    return `map:${JSON.stringify(sortedStrings(value.values.map((v, i) => JSON.stringify([valueKey(value.keys[i]), valueKey(v)]))))}`;
  }
  if (value instanceof _ListRecord) return `list:${JSON.stringify(value.values.map((v) => valueKey(v)))}`;
  if (value === null) return "none";
  if (!(value instanceof _ObjectRecord)) return nativeKey(value);
  const values = sortedStrings(value.values.keys()).map((name) => [name, valueKey(value.values.get(name))]);
  return `object:${JSON.stringify(values)}`;
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

class Check {
  readonly problems: string[] = [];
  private readonly schemasChecked = new Set<unknown>();
  private readonly entries = new Map<Schemas.OfRelation.Data, Map<string, Entry>>();
  /** The schemas of the value objects seen. */
  private readonly valueSchemas = new Map<unknown, Schemas.OfObject.Data>();
  /** The links to value objects, checked once every value object has been seen. */
  private readonly valueLinks: [string, Schemas.OfRelation.Data, string, Visitable][] = [];

  constructor(private readonly store: Stores.Store) {}

  private schema(label: string, schema: { validate(): string[] }): void {
    if (this.schemasChecked.has(schema)) return;
    this.schemasChecked.add(schema);
    this.problems.push(...schema.validate().map((problem) => `schema ${label}: ${problem}`));
  }

  /** Problems with a property's value: its kind and type, recursively, and that a union value holds one branch and an
   * intersection value every part. */
  private valueProblems(label: string, type: Schemas.OfAny.Data, item: unknown): string[] {
    const schema = Schemas.structure(type) as Schemas.OfAny.Data;
    if (schema instanceof Schemas.OfNative.Data) {
      const problem = nativeProblem(schema, item);
      return problem === null ? [] : [`${label}: ${problem}`];
    }
    if (schema instanceof Schemas.OfIndexed.Data) {
      if (!(item instanceof _ListRecord)) return [`${label}: expected a list, got ${_kind(item)}`];
      return schema.positional ? this.positional(label, schema, item) : this.keyed(label, schema, item);
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

  /** Problems with a positional list's items, labeled by key, and with its extent. */
  private positional(label: string, schema: Schemas.OfIndexed.Data, item: _ListRecord): string[] {
    const itemSchema = schema.item as Schemas.OfAny.Data;
    const problems = item.values.flatMap((value, i) => this.valueProblems(`${label}[${schema.minimum + BigInt(i)}]`, itemSchema, value));
    const capacity = schema.capacity;
    if (capacity !== null && BigInt(item.values.length) > capacity) {
      const extent = schema.extent as Schemas.OfIndexed.Extent;
      problems.push(`${label}: ${item.values.length} items are more than the extent ${extent.minimum}..${extent.maximum} holds`);
    }
    return problems;
  }

  /** Problems with a keyed list's items, labeled by position: each key's, a key that appears twice, each value's. */
  private keyed(label: string, schema: Schemas.OfIndexed.Data, item: _ListRecord): string[] {
    const problems: string[] = [];
    const seen = new Map<string, number>();
    item.values.forEach((value, i) => {
      const at = `${label}[${i}]`;
      const key = item.keys[i];
      if (key === null) {
        problems.push(`${at}.key: not set`);
      } else {
        problems.push(...this.valueProblems(`${at}.key`, schema.key as Schemas.OfAny.Data, key));
        const equality = valueKey(key);
        if (seen.has(equality)) problems.push(`${at}.key: the same key as item ${seen.get(equality)}`);
        else seen.set(equality, i);
      }
      problems.push(...this.valueProblems(at, schema.item as Schemas.OfAny.Data, value));
    });
    return problems;
  }

  /** Problems with a value object's entries, which are checked as a reference object's are. */
  private valueEntries(label: string, schema: Schemas.OfObject.Data, item: _ObjectRecord): string[] {
    if (item.target !== null) this.valueSchemas.set(item.target.identity(), schema);
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

  /** Problems with one entry. A link to a value object is checked once every value object has been seen. */
  private entry(label: string, adjacency: Schemas.OfAdjacency.Data, owner: Visitable | null, entry: _EntryRecord): string[] {
    const relation = adjacency.relation as Schemas.OfRelation.Data;
    this.schema(`of ${label}`, relation);
    const problems: string[] = [];
    const links = new Map<string, Visitable | null>([[adjacency.me, owner], ...entry.targets]);
    for (const name of relation.links) {
      if (!links.has(name)) {
        problems.push(`${label}: link ${repr(name)} is not set`);
        continue;
      }
      const target = links.get(name) as Visitable | null;
      if (target === null) continue; // a value object that did not identify itself
      if (target.owner() !== null) {
        this.valueLinks.push([label, relation, name, target]);
        continue;
      }
      const problem = filling(relation, name, target, this.store.schema(target.schema_name()));
      if (problem !== null) problems.push(`${label}.${name}: ${problem}`);
    }
    for (const [name, item] of entry.values) {
      const propertyType = relation.properties.get(name)?.type as Schemas.OfAny.Data | undefined;
      if (propertyType === undefined) {
        problems.push(`${label}.${name}: not a property of the relation`);
        continue;
      }
      problems.push(...this.valueProblems(`${label}.${name}`, propertyType, item));
    }
    const full = new Entry(new Map([...links].filter(([, t]) => t !== null)) as Map<string, Visitable>, entry.values);
    let seen = this.entries.get(relation);
    if (seen === undefined) this.entries.set(relation, (seen = new Map()));
    const key = full.key([...relation.links, ...relation.properties.keys()]);
    if (!seen.has(key)) seen.set(key, full);
    return problems;
  }

  /** Checks the links to value objects, each against its schema; a value object not validated is not checked. */
  links(): void {
    for (const [label, relation, name, target] of this.valueLinks) {
      const schema = this.valueSchemas.get(target.identity());
      const problem = schema === undefined ? null : filling(relation, name, target, schema);
      if (problem !== null) this.problems.push(`${label}.${name}: ${problem}`);
    }
  }

  uniques(): void {
    for (const [relation, entries] of this.entries) {
      const names = new Set([...relation.links, ...relation.properties.keys()]);
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
 * returned as an object whose `accept` writes its properties (a union's branch, an intersection's parts), and a list
 * as a `ListRecord`, whose `values` are its items, read the same way. */
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

/** A list as `properties_of` reads it: its items in `values`, and their keys in `keys` (null for an item appended). An
 * entry as `entries_of` reads it: its other links' targets in `targets`, and its property values in `values`. */
export { _EntryRecord as EntryRecord, _ListRecord as ListRecord };

export interface ValidateCall {
  (schema: unknown, value: unknown): string[];
  OfNative(schema: Schemas.OfNative.Data, value: unknown): string[];
  OfObject(schema: Schemas.OfObject.Data, value: Visitable): string[];
  Reachable(schema: Schemas.OfObject.Data, root: Visitable): string[];
}

/** Validates data against its schema. `Validate(store)(schema, value)` dispatches on the schema's kind. */
export function Validate(store: Stores.Store): ValidateCall {
  const run = (schema: Schemas.OfObject.Data, values: Visitable[]): string[] => {
    const root = values[0] as Visitable;
    if (store.schema(root.schema_name()) !== schema) {
      return [`the value is a ${repr(root.schema_name())}, not an instance of the given schema`];
    }
    const check = new Check(store);
    values.forEach((value, i) => check.object(`${value.schema_name()}#${i}`, store.schema(value.schema_name()), value));
    check.links();
    check.uniques();
    return check.problems;
  };
  const OfNative = (schema: Schemas.OfNative.Data, value: unknown): string[] => {
    const problem = nativeProblem(schema, value);
    return [...schema.validate(), ...(problem ? [problem] : [])];
  };
  /** Checks one object and its entries; uniqueness only over the entries it is part of. */
  const OfObject = (schema: Schemas.OfObject.Data, value: Visitable): string[] => run(schema, [value]);
  /** Checks the root and every object reachable from it through adjacencies. */
  const ReachableCheck = (schema: Schemas.OfObject.Data, root: Visitable): string[] => run(schema, Reachable.of(root));
  const call = (schema: unknown, value: unknown): string[] => {
    if (schema instanceof Schemas.OfNative.Data) return OfNative(schema, value);
    if (schema instanceof Schemas.OfObject.Data) return OfObject(schema, value as Visitable);
    throw new NotImplementedError(`${schemaTypeName(schema)} cannot be validated yet`);
  };
  return Object.assign(call, { OfNative, OfObject, Reachable: ReachableCheck });
}

