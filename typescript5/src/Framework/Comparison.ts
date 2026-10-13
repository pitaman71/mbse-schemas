/**
 * Comparison: compares values under their schema, as EQUALITY.md defines.
 *
 * For each schema element `OfX`, `new Comparison.OfX(schema, value)` holds a value read through the visitor protocol
 * (`Readers.OfX`), or a scalar. `a.compare(b)` compares two and returns -1, 0 or 1 when `a` is less than, equal to or
 * greater than `b`, and `null` when they are incomparable.
 *
 * - Absent compares equal to absent; absent and present are incomparable. So do values under different schemas.
 * - `OfScalar`: a value must have exactly the schema's scalar type. `int`, `float`, `str` and `bytes` are ordered:
 *   strings by code point, bytes lexicographically, floats by value with `-0.0` before `0.0`. NaNs equal each other
 *   and are incomparable with other floats. Booleans are equal or incomparable.
 * - `OfObject`: equal when every property its schema declares is absent in both or equal in both; otherwise
 *   incomparable. A value object compares deeply: its adjacencies participate too, and so do those of the value
 *   objects it holds; a reference object's own adjacencies do not.
 * - `OfProperty` and `OfAny` compare their values; values of different kinds are incomparable.
 * - `OfUnion`: equal when both hold the same branch with equal values; otherwise incomparable.
 * - `OfIntersection`: equal when every part is absent in both or equal in both; otherwise incomparable.
 * - `OfLink`: equal when both link the same object, by identity: a link targets a reference object; otherwise
 *   incomparable.
 * - `OfEntry`: equal when every link and property is equal; otherwise incomparable.
 * - `OfAdjacency`: seen from one object (whose own link is implied), the entries of a relation with a `unique` clause
 *   form a set, and two adjacencies are equal when both hold equal entries; an open relation's are a list, and two are
 *   equal when their entries are, in order. Otherwise incomparable.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type * as Readers from "./Readers.js";
import { compareStrings, tokenName, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type { Scalar } from "./Visitors.js";

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

/** Compares two values of the same scalar type. */
function compareScalars(a: Scalar, b: Scalar): Result {
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

// --- Reading values through their visitors ---

/** The scalar a property's visitor holds, or null. */
function readScalar(read: any): any {
  const found: unknown[] = [];
  read.as_scalar((s: any) => found.push(s.get())); // a callback is always called
  return found[0];
}

/** The value object, union value or intersection value a property's visitor holds, as its own visitor; null when
 * absent. An empty visitor has no identity. */
function readHeld(read: any, schema: unknown): any {
  const select = schema instanceof Schemas.OfUnion.Data ? "as_union"
    : schema instanceof Schemas.OfIntersection.Data ? "as_intersection" : "as_object";
  const found: any[] = [];
  read.as_value((a: any) => a[select]((v: any) => found.push(v)));
  return found.length > 0 && found[0].as_identity() !== "" ? found[0] : null;
}

/** A property's value, read through its visitor: a scalar, a visitor, or null. */
function readProperty(read: any, schema: unknown): any {
  const held = Schemas.structure(schema);
  return held instanceof Schemas.OfScalar.Data || held === null ? readScalar(read) : readHeld(read, held);
}

/** A union's branch's or an intersection's part's value, read through its visitor of its type's kind. */
function readMember(read: any, schema: unknown): any {
  if (Schemas.structure(schema) instanceof Schemas.OfScalar.Data) return read.get();
  return read.as_identity() !== "" ? read : null;
}

// --- Comparing ---

/** Whether two types are one: scalars by value, other schemas by identity, through applications. */
function sameType(a: unknown, b: unknown): boolean {
  const x = Schemas.structure(a);
  const y = Schemas.structure(b);
  return x instanceof Schemas.OfScalar.Data ? x.equals(y) : x === y;
}

/** Compares two values of `schema`, each a scalar, a visitor, or null for absent. */
function compareValues(schema: unknown, a: any, b: any): Result {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined) ? 0 : null;
  }
  const held = Schemas.structure(schema);
  if (held instanceof Schemas.OfScalar.Data) return typeName(a) !== typeName(b) ? null : compareScalars(a, b);
  if (held instanceof Schemas.OfObject.Data) return objects(held, a, b, true);
  const record = held as Schemas.OfUnion.Data | Schemas.OfIntersection.Data;
  return allEqual([...record.properties].map(([name, m]) => compareValues(m.type, readMember(a[name], m.type), readMember(b[name], m.type))));
}

/** Two objects of `schema`: their properties, and with `deep`, their entries. */
function objects(schema: Schemas.OfObject.Data, a: any, b: any, deep: boolean): Result {
  const results = [...schema.properties].map(([name, prop]) =>
    compareValues(prop.type, readProperty(a[name], prop.type), readProperty(b[name], prop.type)));
  if (deep) {
    for (const [name, adjacency] of schema.adjacencies) results.push(adjacencies(adjacency, [...a[name]], [...b[name]]));
  }
  return allEqual(results);
}

function adjacencies(adjacency: Schemas.OfAdjacency.Data, a: any[], b: any[]): Result {
  if (a.length !== b.length) return null;
  if ((adjacency.relation as Schemas.OfRelation.Data).open) return allEqual(a.map((e, i) => entries(adjacency, e, b[i])));
  return allEqual(a.map((e) => (b.some((o) => entries(adjacency, e, o) === 0) ? 0 : null)));
}

function entries(adjacency: Schemas.OfAdjacency.Data, a: any, b: any): Result {
  const relation = adjacency.relation as Schemas.OfRelation.Data;
  const links = [...relation.entry.links.keys()].filter((name) => name !== adjacency.me).map((name) => compareLinks(a[name], b[name]));
  const values = [...relation.entry.properties].map(([name, prop]) =>
    compareValues(prop.type, readProperty(a[name], prop.type), readProperty(b[name], prop.type)));
  return allEqual([...links, ...values]);
}

/** Links compare by their targets' identities: a link targets a reference object, never a value object. */
function compareLinks(a: any, b: any): Result {
  const x = a === null || a === undefined ? "" : a.as_identity();
  const y = b === null || b === undefined ? "" : b.as_identity();
  if (!x || !y) return !x && !y ? 0 : null;
  return x === y ? 0 : null;
}

/** A scalar value, which must have exactly the schema's scalar type; null for absent. */
export class OfScalar {
  readonly #value: Scalar | null;

  constructor(private readonly schema: Schemas.OfScalar.Data, value: Scalar | null = null) {
    const host = schema.host();
    if (value !== null && !Schemas.isScalarOf(host, value)) throw new TypeError(`expected ${tokenName(host)}, got ${typeName(value)}`);
    this.#value = value;
  }

  compare(other: OfScalar): Result {
    if (this.#value === null || other.#value === null) return this.#value === null && other.#value === null ? 0 : null;
    if (this.schema.type !== other.schema.type) return null;
    return compareScalars(this.#value, other.#value);
  }
}

/** A value of any kind: a scalar, a value's visitor, or null for absent. */
export class OfAny {
  constructor(private readonly schema: Schemas.OfAny.Data, private readonly value: unknown = null) {}

  compare(other: OfAny): Result {
    if (!sameType(this.schema, other.schema)) return null;
    return compareValues(this.schema, this.value, other.value);
  }
}

/** One property's value, read through its visitor (`Readers.OfProperty`); null for absent. */
export class OfProperty {
  constructor(private readonly read: Readers.OfProperty | null = null) {}

  compare(other: OfProperty): Result {
    if (this.read === null || other.read === null) return this.read === null && other.read === null ? 0 : null;
    const schema = this.read.as_schema().type;
    if (!sameType(schema, other.read.as_schema().type)) return null;
    return compareValues(schema, readProperty(this.read, schema), readProperty(other.read, schema));
  }
}

/** An object read through its visitor (`Readers.OfObject`). A value object (`{ value: true }`) compares its adjacencies
 * too; a reference object's own adjacencies do not. Without an instance, an object with nothing set. */
export class OfObject {
  private readonly value: boolean;

  constructor(private readonly schema: Schemas.OfObject.Data, private readonly instance: Readers.OfObject | null = null,
    options: { value?: boolean } = {}) {
    this.value = options.value ?? false;
  }

  compare(other: OfObject): Result {
    if (this.schema !== other.schema) return null;
    if (this.instance === null || other.instance === null) return this.instance === null && other.instance === null ? 0 : null;
    return objects(this.schema, this.instance, other.instance, this.value);
  }
}

/** A union value read through its visitor; null for absent. */
export class OfUnion {
  constructor(private readonly schema: Schemas.OfUnion.Data | Schemas.OfIntersection.Data,
    private readonly value: Readers.OfUnion | Readers.OfIntersection | null = null) {}

  compare(other: OfUnion): Result {
    if (this.schema !== other.schema) return null;
    return compareValues(this.schema, this.value, other.value);
  }
}

/** An intersection value read through its visitor; null for absent. */
export class OfIntersection extends OfUnion {}

/** An adjacency's entries, read through its visitor (`Readers.OfAdjacency`). */
export class OfAdjacency {
  constructor(private readonly read: Readers.OfAdjacency) {}

  compare(other: OfAdjacency): Result {
    const mine = this.read.as_schema();
    const theirs = other.read.as_schema();
    if (mine.relation !== theirs.relation || mine.me !== theirs.me) return null;
    return adjacencies(mine, [...this.read], [...other.read]);
  }
}

/** One entry of an adjacency, read through its visitor (`Readers.OfEntry`), seen from the adjacency's end. */
export class OfEntry {
  constructor(private readonly adjacency: Schemas.OfAdjacency.Data, private readonly read: Readers.OfEntry) {}

  compare(other: OfEntry): Result {
    if (this.adjacency.relation !== other.adjacency.relation || this.adjacency.me !== other.adjacency.me) return null;
    return entries(this.adjacency, this.read, other.read);
  }
}

/** The object a link targets, read through its visitor; null when not set. */
export class OfLink {
  constructor(private readonly target: Readers.OfObject | null = null) {}

  compare(other: OfLink): Result {
    return compareLinks(this.target, other.target);
  }
}
