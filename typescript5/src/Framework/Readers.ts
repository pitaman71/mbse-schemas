/**
 * Readers: the read-only view of each `Visitors.OfX`.
 *
 * `Readers.OfX` holds the reading members of `Visitors.OfX` only. It is a type, not a second implementation: code that
 * must not write (evaluators, validators, comparison, codegen's readers) takes a `Readers.OfX`, so that the type
 * checker enforces it. Every `Visitors.OfX` is a `Readers.OfX`.
 */

import type * as Schemas from "./Schemas.js";
import type { Primitive, Scalar } from "./Visitors.js";

/** A reading callback: it takes a reader and returns it. Its return is typed `any` so that every `Visitors.OfX`, whose
 * callbacks return the writable visitor, is a `Readers.OfX`. */
export type Read<V> = (reader: V) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

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
  as_container(cb: Read<OfContainer>): this;
}

export interface OfContainer {
  as_schema(): Schemas.OfContainer.Data;
  readonly length: number;
  at(index: unknown): OfAny;
  as_ordered(cb: Read<OfIterator>): this;
  as_dict(cb: Read<ReadonlyMap<unknown, OfAny>>): this;
  as_entries(cb: Read<Iterator<[unknown, OfAny]>>): this;
}

export interface OfIterator {
  first(): this;
  last(): this;
  next(): this;
  prev(): this;
  index(): unknown;
  as_item(cb: Read<OfAny>): this;
}

export interface OfProperty extends Primitive {
  as_schema(): Schemas.OfProperty.Data;
  as_value(cb: Read<OfAny>): this;
  as_scalar(cb: Read<OfScalar>): this;
  as_object(cb: Read<OfObject>): this;
  get(): Scalar | null;
}

export interface OfObject {
  as_schema(): Schemas.OfObject.Data;
  readonly as_properties: Iterable<OfProperty>;
  as_adjacencies(cb: Read<OfAdjacency>): this;
  readonly [member: string]: unknown;
}

export interface OfAdjacency extends Iterable<OfEntry> {
  as_schema(): Schemas.OfAdjacency.Data;
  as_iterable(cb: Read<Iterator<OfEntry>>): this;
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

export interface OfPattern {
  as_schema(): Schemas.OfPattern.Data;
  readonly [member: string]: unknown;
}
