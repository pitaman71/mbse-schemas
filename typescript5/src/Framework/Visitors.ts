/**
 * Visitors: schema-agnostic handles for traversing, analyzing, and modifying data.
 *
 * For each schema element `OfX`, `Visitors.OfX` is a handle positioned at a value of that kind. A handle can read the
 * value, visit its parts, and modify it. Handles are obtained through `Factories`, never instantiated directly by
 * client code. Builders and serializers implement these protocols; proxies do not (a proxy is `Visitable`).
 *
 * Child handles (properties, adjacencies, entries, links, kind-specific values) are never returned: they are passed
 * to a callback. Every method that is not a query returns `this`, so calls chain.
 *
 * The value builders used in the DSL are handles: in `.street1(v => v.set('foo'))`, `v` is a `Visitors.OfNative`.
 */

/** A native value: int is `bigint`, float is `number`, str is `string`, bool is `boolean`, bytes is `Uint8Array`. */
export type Native = bigint | number | string | boolean | Uint8Array;

/** The DSL's markers for native types: `BigInt` (int), `Number` (float), `String`, `Boolean`, `Uint8Array` (bytes). */
export type NativeToken =
  | BigIntConstructor
  | NumberConstructor
  | StringConstructor
  | BooleanConstructor
  | Uint8ArrayConstructor;

/** The value type a native token stands for. */
export type NativeOf<T> = T extends BigIntConstructor
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

export type Callback<V> = (visitor: V) => unknown;

/**
 * A value of any kind.
 *
 * Each `as_<kind>` method passes the visitor for that kind to its callback. When reading, only the callback matching
 * the value's actual kind is called, so chaining several `as_<kind>` calls dispatches on kind. When writing, the call
 * selects the kind.
 */
export interface OfAny {
  as_native(callback: Callback<OfNative>): OfAny;
  as_object(callback: Callback<OfObject>): OfAny;
  as_union(callback: Callback<OfUnion>): OfAny;
  as_intersection(callback: Callback<OfIntersection>): OfAny;
}

/** A native value. Reading an absent value raises. */
export interface OfNative {
  has(): boolean;
  get(): Native;
  set(value: Native): OfNative;
  clear(): OfNative;
}

/** One named property of an object or entry. Reading the value of an absent property raises. */
export interface OfProperty {
  name(): string;
  has(): boolean;
  value(callback: Callback<OfAny>): OfProperty;
  clear(): OfProperty;
}

/** An object: named properties plus adjacencies to relations. */
export interface OfObject {
  /** Calls `callback` once for each property that is present. */
  properties(callback: Callback<OfProperty>): OfObject;
  has(name: string): boolean;
  /** Calls `callback` with the named property, present or not. */
  property(name: string, callback: Callback<OfProperty>): OfObject;
  clear(name: string): OfObject;
  /** Calls `callback` once for each adjacency declared by the object's schema. */
  adjacencies(callback: Callback<OfAdjacency>): OfObject;
  adjacency(name: string, callback: Callback<OfAdjacency>): OfObject;
}

/** The entries of one relation seen from one object, which fills its own link (`me`). */
export interface OfAdjacency {
  /** Name of the adjacency on the object, e.g. 'addresses'. */
  name(): string;
  /** Name of the link this object fills. */
  me(): string;
  entries(callback: Callback<OfEntry>): OfAdjacency;
  /** Adds a new entry with this object's own link already filled, after `callback` fills in the rest. Adding an
   * entry equal to an existing one is elided. */
  add(callback: Callback<OfEntry>): OfAdjacency;
  remove(entry: OfEntry): OfAdjacency;
}

/** One relation entry: its links and properties. */
export interface OfEntry {
  links(callback: Callback<OfLink>): OfEntry;
  link(name: string, callback: Callback<OfLink>): OfEntry;
  /** Calls `callback` once for each property that is present. */
  properties(callback: Callback<OfProperty>): OfEntry;
  has(name: string): boolean;
  /** Calls `callback` with the named property, present or not. */
  property(name: string, callback: Callback<OfProperty>): OfEntry;
  clear(name: string): OfEntry;
}

/** One named link of an entry. */
export interface OfLink {
  name(): string;
  /** Calls `callback` with the linked object. */
  target(callback: Callback<Visitable>): OfLink;
  set(target: Visitable): OfLink;
}

/** All entries of a relation. Internal to implementations; no relation builder is exposed to callers. */
export interface OfRelation {
  /** Calls `callback` once with each link name. */
  links(callback: (name: string) => unknown): OfRelation;
  entries(callback: Callback<OfEntry>): OfRelation;
}

/** A value of one of several same-kind schemas, chosen by the first matching discriminator predicate. */
export interface OfUnion {
  /** Index of the branch the value belongs to. */
  branch(): number;
  value(callback: Callback<OfAny>): OfUnion;
}

/** A value satisfying several same-kind schemas at once. */
export interface OfIntersection {
  value(callback: Callback<OfAny>): OfIntersection;
}

/** An in-memory object that can be visited, e.g. a proxy. It is not a visitor itself. */
export interface Visitable {
  /** In-memory identity, stable for the object's lifetime. Serializers map it 1:1 to a transaction symbol. */
  identity(): unknown;
  /** Registered name of the object's schema, carried by serialized references to this object. */
  schema_name(): string;
  /** Writes this object's properties and adjacency entries into `visitor`. */
  accept(visitor: OfObject): void;
}

/** Method names each protocol declares, for runtime conformance checks (TypeScript interfaces vanish at runtime). */
export const PROTOCOL_METHODS = {
  OfAny: ["as_native", "as_object", "as_union", "as_intersection"],
  OfNative: ["has", "get", "set", "clear"],
  OfProperty: ["name", "has", "value", "clear"],
  OfObject: ["properties", "has", "property", "clear", "adjacencies", "adjacency"],
  OfAdjacency: ["name", "me", "entries", "add", "remove"],
  OfEntry: ["links", "link", "properties", "has", "property", "clear"],
  OfLink: ["name", "target", "set"],
  OfRelation: ["links", "entries"],
  OfUnion: ["branch", "value"],
  OfIntersection: ["value"],
  Visitable: ["identity", "schema_name", "accept"],
} as const satisfies Record<string, readonly string[]>;
