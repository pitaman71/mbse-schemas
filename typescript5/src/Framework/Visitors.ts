/**
 * Visitors: the one protocol per kind through which code reads and writes a value, knowing its schema or not.
 *
 * `Visitors.OfX` reads and writes a value of kind X. Data instances (`Proxies.OfX.Data`) and builders
 * (`Proxies.OfX.Builder`) implement it: whether a write takes effect is the visitor's mode. Data instances visit
 * read-only; builders are writable unless made read-only. A child visitor has its parent's mode, and a value object is
 * writable only under a builder that is constructing or cloning it. Code that must not write takes the read-only view
 * of the same protocol, `Readers.OfX`.
 *
 * Members. An object's properties and adjacencies, an entry's links and properties, a union's branches, an
 * intersection's parts and a match's symbols are members named after them. Read, a member is the child visitor
 * (`card.name`, a `Visitors.OfProperty`); called with a `Specs.Callback`, it writes or visits through it
 * (`b.name("Ada")`, `b.phones((a) => a.insert((e) => e.phone(p)))`) and returns the visitor it is a member of. The
 * methods of `Visitors.OfObject` and `Visitors.OfEntry` are named `as_*`, a prefix no schema-defined name may take;
 * every protocol has `as_schema()`, the schema it visits.
 *
 * Reads never throw. Every callback is called: a visitor handed over for an absent value, for a value of another kind,
 * or for a member the schema lacks, reads as empty (`get()` null, nothing to iterate). The one throw is a write that the
 * visitor's mode, or the value, forbids: `Errors.ReadOnlyError`. A write that loses nothing does not throw: inserting an
 * entry equal to one a set relation holds elides it, and removing where no entry agrees removes nothing. A member is
 * written by calling it, never by assignment: assigning to any visitor's member throws `AttributeError`.
 *
 * Scalars read compactly through `[Symbol.toPrimitive]` and `valueOf`, sugar over `get()`, on `Visitors.OfScalar` and,
 * passing through `as_scalar`, on `Visitors.OfProperty` (`` `${card.name}` ``, `+card.age`). Each throws when the value
 * is not set or is not of the type asked for. They reach less far than Python's dunders: not `===`, nor truthiness, so
 * a scalar is compared once read (`card.name.get() === "Ada"`), where Python compares the member itself (see
 * EQUIVALENCE.md).
 */

import type * as Schemas from "./Schemas.js";
import type { Callback } from "./Specs.js";

/** A scalar value: int is `bigint`, float is `number`, str is `string`, bool is `boolean`, bytes is `Uint8Array`. */
export type Scalar = bigint | number | string | boolean | Uint8Array;

/** The DSL's markers for scalar types: `BigInt` (int), `Number` (float), `String`, `Boolean`, `Uint8Array` (bytes). */
export type ScalarToken =
  | BigIntConstructor
  | NumberConstructor
  | StringConstructor
  | BooleanConstructor
  | Uint8ArrayConstructor;

/** The value type a scalar token stands for. */
export type ScalarOf<T> = T extends BigIntConstructor
  ? bigint
  : T extends NumberConstructor
    ? number
    : T extends StringConstructor
      ? string
      : T extends BooleanConstructor
        ? boolean
        : T extends Uint8ArrayConstructor
          ? Uint8Array
          : never;

/** The value form of a `Specs.Callback<V>`, by kind: a scalar's value; a value (a scalar, or a value object, union
 * value or intersection value, copied) for `OfAny` and `OfProperty`; an object (a reference object, linked, or a value
 * object, copied) for `OfObject`; an entry for `OfEntry`; entries, each inserted, for `OfAdjacency`. */
export type DataType<V> = V extends OfScalar<infer T> ? T
  : V extends OfAdjacency ? Iterable<OfEntry>
  : V extends OfEntry ? OfEntry
  : V extends OfObject ? OfObject
  : V extends OfAny | OfProperty ? Scalar | OfObject | OfUnion | OfIntersection
  : never;

/** Sugar over a scalar's `get()`: each conversion throws when the value is not set or not of the type asked for. */
export interface Primitive {
  [Symbol.toPrimitive](hint: "number" | "string" | "default"): Scalar;
  valueOf(): Scalar;
}

/** A scalar value. */
export interface OfScalar<T extends Scalar = Scalar> extends Primitive {
  as_schema(): Schemas.OfScalar.Data;
  /** The value, or null when it is not set. */
  get(): T | null;
  set(value: T): void;
  /** An alias of `Visitors.OfAny.clear`. */
  clear(): void;
}

/** A value of any kind. Each `as_<kind>` hands over that kind's visitor: reading a value of another kind, an empty one;
 * writing, it selects the kind. */
export interface OfAny {
  as_schema(): Schemas.OfAny.Data;
  as_scalar(cb: Callback<OfScalar>): this;
  as_object(cb: Callback<OfObject>): this;
  as_union(cb: Callback<OfUnion>): this;
  as_intersection(cb: Callback<OfIntersection>): this;
  as_container(cb: Callback<OfContainer>): this;
  clear(): void;
}

/** A container: elements by index, entries latent. An index is a scalar, or an array of a value object index's
 * properties in declaration order; an element is read and written through its `Visitors.OfAny`. */
export interface OfContainer {
  as_schema(): Schemas.OfContainer.Data;
  /** The positions of a dense container of int indices (every index up to the last), else the elements present. */
  readonly length: number;
  /** The element at `index`, empty where there is none; writable in a builder, where writing adds it. */
  at(index: unknown): OfAny;
  remove(index: unknown): this;
  /** An iterator over the positions of a dense or sparse container; `cb` is not called for another. */
  as_ordered(cb: (iterator: OfIterator) => unknown): this;
  /** The elements by index of a container arranged as a dict; `cb` is not called for another. */
  as_dict(cb: (elements: ReadonlyMap<unknown, OfAny>) => unknown): this;
  /** Each element present with its index, in order, for every container. */
  as_entries(cb: (entries: Iterator<[unknown, OfAny]>) => unknown): this;
}

/** A position in a dense or sparse container: at a position, before the first, or past the last. */
export interface OfIterator {
  first(): this;
  last(): this;
  next(): this;
  prev(): this;
  /** The index at the position; null before the first or past the last. */
  index(): unknown;
  /** The element at the position. Past an end, `cb` is not called for a read-only container, and a writable one is
   * extended there. */
  as_item(cb: Callback<OfAny>): this;
  /** Inserts an element before the position, which then rests on it; only where the indices are ints. */
  prepend(spec: Callback<OfAny>): this;
  /** Inserts an element after the position, which then rests on it; only where the indices are ints. */
  append(spec: Callback<OfAny>): this;
}

/** One property of an object or an entry. Called, as a member, with a `Specs.Callback<Visitors.OfProperty>`. */
export interface OfProperty extends Primitive {
  as_schema(): Schemas.OfProperty.Data;
  as_value(cb: Callback<OfAny>): this;
  /** Shorthand: `as_value`, then `Visitors.OfAny.as_scalar`. */
  as_scalar(cb: Callback<OfScalar>): this;
  /** Shorthand, for conciseness: `as_value`, then `Visitors.OfAny.as_object`. */
  as_object(cb: Callback<OfObject>): this;
  /** The scalar value, or null when it is not set or not a scalar: a pass-through to `as_scalar`. */
  get(): Scalar | null;
}

/** `Visitors.OfObject.as_properties`: the properties present, iterated, or called with a callback for each. */
export interface Properties extends Iterable<OfProperty> {
  (cb: Callback<OfProperty>): OfObject;
}

/** An object: its properties and adjacencies are members (`osv.<propName>`, a `Visitors.OfProperty` that is also
 * callable; `osv.<adjName>`, a `Visitors.OfAdjacency`). */
export interface OfObject {
  as_schema(): Schemas.OfObject.Data;
  /** Read (no argument), the object's identity in its store, unqualified: its global name, a name its naming pattern
   * gives, a UUID, or one written; null for a value object, or an object not created yet that none was written for.
   * Written (in a builder), the identity the object takes: its store gives one only where none is set by the object it
   * updates or by this. A data instance refuses a write. */
  as_identity(identity?: string | null): any;
  /** The properties present, schema unaware. */
  readonly as_properties: Properties;
  /** Each adjacency, schema unaware; an adjacency is edited through what this hands over. */
  as_adjacencies(cb: Callback<OfAdjacency>): this;
  readonly [member: string]: unknown;
}

/** The entries of one relation seen from one object, which fills its own link; iterated, its entries. */
export interface OfAdjacency extends Iterable<OfEntry> {
  as_schema(): Schemas.OfAdjacency.Data;
  /** Calls `cb` with an iterator over the entries, in order, for every relation. */
  as_iterable(cb: (entries: Iterator<OfEntry>) => unknown): this;
  /** Adds an entry, the object's own link filled; an equal entry in a set is elided. */
  insert(spec: Callback<OfEntry>): this;
  /** Removes every entry that agrees with `spec`. */
  remove(spec: Callback<OfEntry>): this;
}

/** One entry of a relation: its links are members (`env.<linkName>`, a `Visitors.OfObject`), and so are its properties
 * (`env.<propName>`, a `Visitors.OfProperty`). Its properties are walked, schema unaware, through its schema. */
export interface OfEntry {
  as_schema(): Schemas.OfEntry.Data;
  readonly [member: string]: unknown;
}

/** A union value: its branches are members, each the visitor of its type's kind (`shape.circle`); a branch it does not
 * hold reads as empty, and writing one branch clears the others. */
export interface OfUnion {
  as_schema(): Schemas.OfUnion.Data;
  readonly [member: string]: unknown;
}

/** An intersection value: its parts are members, each the visitor of its type's kind (`ticket.stamp`). */
export interface OfIntersection {
  as_schema(): Schemas.OfIntersection.Data;
  readonly [member: string]: unknown;
}

/** A match of a predicate: its symbols are members, each a `Visitors.OfObject`, in the match's mode. Finding matches is
 * mbse-patterns'. */
export interface OfPredicate {
  as_schema(): Schemas.OfPredicate.Data;
  readonly [member: string]: unknown;
}

/** The methods each protocol declares, for runtime conformance checks (TypeScript interfaces vanish at runtime). */
export const PROTOCOL_METHODS = {
  OfScalar: ["as_schema", "get", "set", "clear"],
  OfAny: ["as_schema", "as_scalar", "as_object", "as_union", "as_intersection", "as_container", "clear"],
  OfProperty: ["as_schema", "as_value", "as_scalar", "as_object", "get"],
  OfObject: ["as_schema", "as_identity", "as_properties", "as_adjacencies"],
  OfAdjacency: ["as_schema", "as_iterable", "insert", "remove"],
  OfEntry: ["as_schema"],
  OfUnion: ["as_schema"],
  OfIntersection: ["as_schema"],
  OfContainer: ["as_schema", "at", "remove", "as_ordered", "as_dict", "as_entries"],
  OfIterator: ["first", "last", "next", "prev", "index", "as_item", "prepend", "append"],
  OfPredicate: ["as_schema"],
} as const satisfies Record<string, readonly string[]>;
