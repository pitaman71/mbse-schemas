/**
 * Comparison: compares values under their schema, as EQUALITY.md defines.
 *
 * For each schema element `OfX`, `Comparison.OfX` implements `Visitors.OfX` and records the value written into it.
 * `a.compare(b)` compares two recordings and returns -1, 0 or 1 when `a` is less than, equal to or greater than `b`,
 * and `null` when they are incomparable. `new Comparison.OfNative(schema, value)` and
 * `new Comparison.OfObject(schema, instance)` record a value when constructed; an instance writes itself in through
 * `Visitable.accept`.
 *
 * - Absent compares equal to absent; absent and present are incomparable. So do values under different schemas.
 * - `OfNative`: a value must have exactly the schema's native type. `int`, `float`, `str` and `bytes` are ordered:
 *   strings by code point, bytes lexicographically, floats by value with `-0.0` before `0.0`. NaNs equal each other
 *   and are incomparable with other floats. Booleans are equal or incomparable.
 * - `OfObject`: equal when every property its schema declares is absent in both or equal in both; otherwise
 *   incomparable. Adjacencies do not participate.
 * - `OfProperty` and `OfAny` compare their values; values of different kinds are incomparable.
 * - `OfUnion`: equal when written as the same branch with equal values; otherwise incomparable.
 * - `OfIntersection`: equal when the values are equal under the intersection's merged schema; otherwise incomparable.
 * - `OfLink`: equal when both link the same object (by identity); otherwise incomparable.
 * - `OfEntry`: equal when every link and property is equal; otherwise incomparable.
 * - `OfAdjacency`: its entries form a set, seen from one object (whose own link is implied), so adding an entry equal
 *   to one already there is elided. Equal when both hold equal entries; otherwise incomparable.
 *
 * `Visitors.OfRelation` has no implementation: it declares no way to write entries into it.
 */

import { AttributeError, KeyError, NotImplementedError, ValueError } from "./Errors.js";
import { compareStrings, repr, reprIndex, tokenName, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type * as Visitors from "./Visitors.js";
import type { Callback, Native } from "./Visitors.js";

/** -1, 0 or 1 when ordered or equal; `null` when incomparable. */
export type Result = -1 | 0 | 1 | null;

function sign(difference: number | bigint): Result {
  return difference > 0 ? 1 : difference < 0 ? -1 : 0;
}

/** Unordered composites: equal when every part is equal, otherwise incomparable. */
function allEqual(results: Result[]): Result {
  return results.every((result) => result === 0) ? 0 : null;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return a.length - b.length;
}

/** Compares two values of the same native type. */
function compareNatives(a: Native, b: Native): Result {
  if (typeof a === "boolean") return a === b ? 0 : null;
  if (typeof a === "number") {
    const y = b as number;
    if (Number.isNaN(a) || Number.isNaN(y)) return Number.isNaN(a) && Number.isNaN(y) ? 0 : null;
    return a !== y ? sign(a - y) : sign(Number(!Object.is(a, -0)) - Number(!Object.is(y, -0)));
  }
  if (typeof a === "bigint") return sign(a - (b as bigint));
  if (typeof a === "string") return sign(compareStrings(a, b as string));
  return sign(compareBytes(a, b as Uint8Array));
}

/** `Visitors.OfNative` recording one native value, which must have exactly the schema's native type. */
export class OfNative implements Visitors.OfNative {
  private value: Native[] = [];

  constructor(private readonly schema: Schemas.OfNative.Data, value?: Native) {
    if (value !== undefined) this.set(value);
  }

  has(): boolean {
    return this.value.length > 0;
  }

  get(): Native {
    if (this.value.length === 0) throw new AttributeError("the value is not set");
    return this.value[0] as Native;
  }

  set(value: Native): OfNative {
    if (!Schemas.isNativeOf(this.schema.type, value)) {
      throw new TypeError(`expected ${tokenName(this.schema.type)}, got ${typeName(value)}`);
    }
    this.value = [value];
    return this;
  }

  clear(): OfNative {
    this.value = [];
    return this;
  }

  compare(other: OfNative): Result {
    if (!this.has() || !other.has()) return !this.has() && !other.has() ? 0 : null;
    if (this.schema.type !== other.schema.type) return null;
    return compareNatives(this.value[0] as Native, other.value[0] as Native);
  }
}

/** `Visitors.OfAny` recording a value of the kind its schema declares. */
export class OfAny implements Visitors.OfAny {
  private value: OfNative | OfObject | OfUnion | OfIntersection | null = null;

  constructor(private readonly schema: Schemas.OfAny.Data) {}

  /** @internal */
  absent(): boolean {
    if (this.value instanceof OfNative) return !this.value.has();
    return this.value === null
      || ((this.value instanceof OfUnion || this.value instanceof OfIntersection) && this.value.absent());
  }

  as_native(callback: Callback<Visitors.OfNative>): OfAny {
    if (!(this.schema instanceof Schemas.OfNative.Data)) throw new TypeError("the schema is not a native schema");
    if (!(this.value instanceof OfNative)) this.value = new OfNative(this.schema);
    callback(this.value);
    return this;
  }

  as_object(callback: Callback<Visitors.OfObject>): OfAny {
    if (!(this.schema instanceof Schemas.OfObject.Data)) throw new TypeError("the schema is not an object schema");
    if (!(this.value instanceof OfObject)) this.value = new OfObject(this.schema);
    callback(this.value);
    return this;
  }

  as_union(callback: Callback<Visitors.OfUnion>): OfAny {
    if (!(this.schema instanceof Schemas.OfUnion.Data)) throw new TypeError("the schema is not a union schema");
    if (!(this.value instanceof OfUnion)) this.value = new OfUnion(this.schema);
    callback(this.value);
    return this;
  }

  as_intersection(callback: Callback<Visitors.OfIntersection>): OfAny {
    if (!(this.schema instanceof Schemas.OfIntersection.Data)) throw new TypeError("the schema is not an intersection schema");
    if (!(this.value instanceof OfIntersection)) this.value = new OfIntersection(this.schema);
    callback(this.value);
    return this;
  }

  compare(other: OfAny): Result {
    if (this.absent() || other.absent()) return this.absent() && other.absent() ? 0 : null;
    if (this.value instanceof OfNative) return other.value instanceof OfNative ? this.value.compare(other.value) : null;
    if (this.value instanceof OfUnion) return other.value instanceof OfUnion ? this.value.compare(other.value) : null;
    if (this.value instanceof OfIntersection) {
      return other.value instanceof OfIntersection ? this.value.compare(other.value) : null;
    }
    return other.value instanceof OfObject ? (this.value as OfObject).compare(other.value) : null;
  }
}

/** `Visitors.OfIntersection` recording a value of the intersection's merged schema. */
export class OfIntersection implements Visitors.OfIntersection {
  private recorded: OfAny | null = null;

  constructor(private readonly schema: Schemas.OfIntersection.Data) {}

  value(callback: Callback<Visitors.OfAny>): OfIntersection {
    if (this.recorded === null) this.recorded = new OfAny(this.schema.merged());
    callback(this.recorded);
    return this;
  }

  absent(): boolean {
    return this.recorded === null || this.recorded.absent();
  }

  compare(other: OfIntersection): Result {
    if (this.absent() || other.absent()) return this.absent() && other.absent() ? 0 : null;
    if (this.schema !== other.schema) return null;
    return (this.recorded as OfAny).compare(other.recorded as OfAny);
  }
}

/** `Visitors.OfUnion` recording the branch a union value is written as, and its value. */
export class OfUnion implements Visitors.OfUnion {
  private index: number | null = null;
  private recorded: OfAny | null = null;

  constructor(private readonly schema: Schemas.OfUnion.Data) {}

  branch(): number {
    if (this.index === null) throw new ValueError("no branch is selected");
    return this.index;
  }

  select(index: number): OfUnion {
    if (!Number.isInteger(index) || index < 0 || index >= this.schema.branches.length) {
      throw new ValueError(`the union has no branch ${reprIndex(index)}`);
    }
    if (index !== this.index) {
      this.index = index;
      this.recorded = new OfAny((this.schema.branches[index] as { type: Schemas.OfAny.Data }).type);
    }
    return this;
  }

  value(callback: Callback<Visitors.OfAny>): OfUnion {
    this.branch();
    callback(this.recorded as OfAny);
    return this;
  }

  /** @internal */
  absent(): boolean {
    return this.recorded === null || this.recorded.absent();
  }

  compare(other: OfUnion): Result {
    if (this.absent() || other.absent()) return this.absent() && other.absent() ? 0 : null;
    if (this.schema !== other.schema || this.index !== other.index) return null;
    return (this.recorded as OfAny).compare(other.recorded as OfAny);
  }
}

/** `Visitors.OfProperty` recording one named property's value. */
export class OfProperty implements Visitors.OfProperty {
  private recorded: OfAny;

  constructor(private readonly propertyName: string, private readonly schema: Schemas.OfAny.Data) {
    this.recorded = new OfAny(schema);
  }

  name(): string {
    return this.propertyName;
  }

  has(): boolean {
    return !this.recorded.absent();
  }

  value(callback: Callback<Visitors.OfAny>): OfProperty {
    callback(this.recorded);
    return this;
  }

  clear(): OfProperty {
    this.recorded = new OfAny(this.schema);
    return this;
  }

  compare(other: OfProperty): Result {
    return this.recorded.compare(other.recorded);
  }
}

/** Named properties declared by a schema, recorded as `OfProperty`s. */
class Properties {
  private readonly slots = new Map<string, OfProperty>();

  constructor(private readonly schemas: Map<string, Schemas.OfAny.Data>) {}

  each(callback: Callback<Visitors.OfProperty>): void {
    for (const name of this.schemas.keys()) {
      if (this.has(name)) callback(this.slots.get(name) as OfProperty);
    }
  }

  has(name: string): boolean {
    return this.slots.get(name)?.has() ?? false;
  }

  one(name: string, callback: Callback<Visitors.OfProperty>): void {
    const schema = this.schemas.get(name);
    if (schema === undefined) throw new KeyError(`unknown property ${repr(name)}`);
    let slot = this.slots.get(name);
    if (slot === undefined) this.slots.set(name, (slot = new OfProperty(name, schema)));
    callback(slot);
  }

  clear(name: string): void {
    this.slots.delete(name);
  }

  /** The recorded property, or an absent one if it was never written. */
  private slot(name: string): OfProperty {
    return this.slots.get(name) ?? new OfProperty(name, this.schemas.get(name) as Schemas.OfAny.Data);
  }

  compare(other: Properties): Result[] {
    return [...this.schemas.keys()].map((name) => this.slot(name).compare(other.slot(name)));
  }
}

/** `Visitors.OfObject` recording an object's properties and adjacency entries. With `instance`, the instance writes
 * itself in through `accept`. */
export class OfObject implements Visitors.OfObject {
  private readonly recorded: Properties;
  private readonly slots = new Map<string, OfAdjacency>();

  constructor(private readonly schema: Schemas.OfObject.Data, instance?: Visitors.Visitable) {
    this.recorded = new Properties(schema.properties);
    if (instance !== undefined) instance.accept(this);
  }

  properties(callback: Callback<Visitors.OfProperty>): OfObject {
    this.recorded.each(callback);
    return this;
  }

  has(name: string): boolean {
    return this.recorded.has(name);
  }

  property(name: string, callback: Callback<Visitors.OfProperty>): OfObject {
    this.recorded.one(name, callback);
    return this;
  }

  clear(name: string): OfObject {
    this.recorded.clear(name);
    return this;
  }

  adjacencies(callback: Callback<Visitors.OfAdjacency>): OfObject {
    for (const name of this.schema.adjacencies.keys()) this.adjacency(name, callback);
    return this;
  }

  adjacency(name: string, callback: Callback<Visitors.OfAdjacency>): OfObject {
    const schema = this.schema.adjacencies.get(name);
    if (schema === undefined) throw new KeyError(`unknown adjacency ${repr(name)}`);
    let slot = this.slots.get(name);
    if (slot === undefined) this.slots.set(name, (slot = new OfAdjacency(name, schema)));
    callback(slot);
    return this;
  }

  compare(other: OfObject): Result {
    if (this.schema !== other.schema) return null;
    return allEqual(this.recorded.compare(other.recorded));
  }
}

/** `Visitors.OfAdjacency` recording the entries of one relation seen from one object. Adding an entry equal to one
 * already recorded is elided. */
export class OfAdjacency implements Visitors.OfAdjacency {
  private list: OfEntry[] = [];

  constructor(private readonly adjacencyName: string, private readonly schema: Schemas.OfAdjacency.Data) {}

  name(): string {
    return this.adjacencyName;
  }

  me(): string {
    return this.schema.me;
  }

  entries(callback: Callback<Visitors.OfEntry>): OfAdjacency {
    for (const entry of [...this.list]) callback(entry);
    return this;
  }

  add(callback: Callback<Visitors.OfEntry>): OfAdjacency {
    const entry = new OfEntry(this.schema.relation as Schemas.OfRelation.Data, this.schema.me);
    callback(entry);
    if (!this.list.some((existing) => entry.compare(existing) === 0)) this.list.push(entry);
    return this;
  }

  remove(entry: Visitors.OfEntry): OfAdjacency {
    this.list = this.list.filter((e) => e !== entry);
    return this;
  }

  compare(other: OfAdjacency): Result {
    if (this.schema.relation !== other.schema.relation || this.schema.me !== other.schema.me) return null;
    if (this.list.length !== other.list.length) return null;
    return allEqual(this.list.map((e) => (other.list.some((o) => e.compare(o) === 0) ? 0 : null)));
  }
}

/** `Visitors.OfEntry` recording one relation entry's links and properties. The link named `me`, if any, is the
 * owning object's own link: it is implied and cannot be set. */
export class OfEntry implements Visitors.OfEntry {
  private readonly slots = new Map<string, OfLink>();
  private readonly recorded: Properties;

  constructor(private readonly relation: Schemas.OfRelation.Data, private readonly own: string | null = null) {
    this.recorded = new Properties(relation.properties);
  }

  private names(): string[] {
    return this.relation.links.filter((name) => name !== this.own);
  }

  links(callback: Callback<Visitors.OfLink>): OfEntry {
    for (const name of this.names()) this.link(name, callback);
    return this;
  }

  link(name: string, callback: Callback<Visitors.OfLink>): OfEntry {
    if (!this.names().includes(name)) throw new KeyError(`${repr(name)} is not a link this entry can set`);
    let slot = this.slots.get(name);
    if (slot === undefined) this.slots.set(name, (slot = new OfLink(name)));
    callback(slot);
    return this;
  }

  properties(callback: Callback<Visitors.OfProperty>): OfEntry {
    this.recorded.each(callback);
    return this;
  }

  has(name: string): boolean {
    return this.recorded.has(name);
  }

  property(name: string, callback: Callback<Visitors.OfProperty>): OfEntry {
    this.recorded.one(name, callback);
    return this;
  }

  clear(name: string): OfEntry {
    this.recorded.clear(name);
    return this;
  }

  compare(other: OfEntry): Result {
    if (this.relation !== other.relation || this.own !== other.own) return null;
    const slot = (entry: OfEntry, name: string) => entry.slots.get(name) ?? new OfLink(name);
    const links = this.names().map((name) => slot(this, name).compare(slot(other, name)));
    return allEqual([...links, ...this.recorded.compare(other.recorded)]);
  }
}

/** `Visitors.OfLink` recording the object one link targets. */
export class OfLink implements Visitors.OfLink {
  private recorded: Visitors.Visitable[] = [];

  constructor(private readonly linkName: string) {}

  name(): string {
    return this.linkName;
  }

  target(callback: Callback<Visitors.Visitable>): OfLink {
    if (this.recorded.length === 0) throw new ValueError(`link ${repr(this.linkName)} is not set`);
    callback(this.recorded[0] as Visitors.Visitable);
    return this;
  }

  set(target: Visitors.Visitable): OfLink {
    this.recorded = [target];
    return this;
  }

  compare(other: OfLink): Result {
    const [mine, theirs] = [this.recorded[0], other.recorded[0]];
    if (mine === undefined || theirs === undefined) return mine === theirs ? 0 : null;
    return mine.identity() === theirs.identity() ? 0 : null;
  }
}
