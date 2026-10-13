/**
 * Readers: the read-only view of each `Visitors.OfX`.
 *
 * `Readers.OfX` holds the reading members of `Visitors.OfX` only. It is a type, not a second implementation: code that
 * must not write (evaluators, validators, comparison, codegen's readers) takes a `Readers.OfX`, so that the type
 * checker enforces it. Every `Visitors.OfX` is a `Readers.OfX`.
 */

import type * as Schemas from "./Schemas.js";
import type { Primitive, Scalar } from "./Visitors.js";

/** A reading callback: it takes a reader and returns it. */
export type Read<V> = (reader: V) => V;

export interface OfScalar<T extends Scalar = Scalar> extends Primitive {
  as_schema(): Schemas.OfScalar.Data;
  get(): T | null;
}

export interface OfAny {
  as_schema(): Schemas.OfAny.Data;
  as_scalar(cb: Read<OfScalar>): this;
  as_object(cb: Read<OfObject>): this;
  as_union(cb: Read<OfUnion>): this;
  as_intersection(cb: Read<OfIntersection>): this;
}

export interface OfProperty extends Primitive {
  as_schema(): Schemas.OfProperty.Data;
  as_value(cb: Read<OfAny>): this;
  as_scalar(cb: Read<OfScalar>): this;
}

export interface OfObject {
  as_schema(): Schemas.OfObject.Data;
  as_identity(): string;
  readonly as_properties: Iterable<OfProperty>;
  as_adjacencies(cb: Read<OfAdjacency>): this;
  readonly [member: string]: unknown;
}

export interface OfAdjacency extends Iterable<OfEntry> {
  as_schema(): Schemas.OfAdjacency.Data;
  select(spec: unknown, cb: Read<OfEntry>): this;
}

export interface OfEntry {
  as_schema(): Schemas.OfEntry.Data;
  readonly [member: string]: unknown;
}

export interface OfUnion {
  as_schema(): Schemas.OfUnion.Data;
  readonly [member: string]: unknown;
}

export interface OfIntersection {
  as_schema(): Schemas.OfIntersection.Data;
  readonly [member: string]: unknown;
}

export interface OfPredicate {
  as_schema(): Schemas.OfPredicate.Data;
  readonly [member: string]: unknown;
}
