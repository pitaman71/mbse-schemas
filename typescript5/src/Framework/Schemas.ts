/**
 * Schemas: schema elements and their builders.
 *
 * For each schema element `OfX`, `Schemas.OfX.Data` captures a schema and `Schemas.OfX.Builder` builds one. Builders
 * take an optional source instance, keep shallow copies of its data, are fluent, and are finalized by `create()`,
 * `clone()` or `update()`; none validate. Arguments describing a sub-structure are `Spec`s: a direct value, or a
 * callable that takes and returns the corresponding builder.
 *
 * `validate()` on each `Data` returns a list of problems and runs only when the caller asks. `equals()` stands in for
 * Python's `==`: by value for `OfNative.Data`, by identity for the other kinds.
 */

import { fromBase64, toBase64 } from "./Bytes.js";
import { DecodeError, ValueError } from "./Errors.js";
import type { PlainData } from "./Plain.js";
import { isClassLike, NATIVE_NAMES, repr, sortedStrings, tokenName, Tuple, typeName } from "./Repr.js";
import type { Native, NativeToken } from "./Visitors.js";

export const NATIVE_TYPES: readonly NativeToken[] = [BigInt, Number, String, Boolean, Uint8Array];

/** Shallow-copies the builder's own containers; references to other schemas are kept, never copied. */
function copyContainer<T>(value: T): T {
  if (value instanceof Map) return new Map(value) as T;
  if (Array.isArray(value)) return [...value] as T;
  return value;
}

function noArguments(method: string, args: unknown[]): void {
  if (args.length > 0) throw new TypeError(`${method}() takes no arguments (${args.length} given)`);
}

/** Schema data classes: their own enumerable properties are their fields, like a Python dataclass's. */
type HasFields = object;

/** Shared builder mechanics. Subclasses add fluent accessors that edit `this.state`. */
abstract class Builder<D extends HasFields> {
  protected readonly source: D | undefined;
  protected state: Record<string, unknown>;

  constructor(instance?: D) {
    this.source = instance;
    this.state = {};
    if (instance !== undefined) {
      for (const [name, value] of Object.entries(instance)) this.state[name] = copyContainer(value);
    }
  }

  protected abstract make(fields: Record<string, unknown>): D;

  private final(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this.state).map(([name, value]) => [name, copyContainer(value)]));
  }

  /** Returns a new `Data`. Only valid without a source instance. */
  create(...args: unknown[]): D {
    noArguments("create", args);
    if (this.source !== undefined) {
      throw new ValueError("create() is only valid without a source instance; use clone() or update()");
    }
    return this.make(this.final());
  }

  /** Returns a new `Data`, leaving the source instance untouched. Only valid with a source instance. */
  clone(...args: unknown[]): D {
    noArguments("clone", args);
    if (this.source === undefined) throw new ValueError("clone() is only valid with a source instance");
    return this.make(this.final());
  }

  /** Writes the builder state back into the source instance and returns it. Only valid with a source instance. */
  update(...args: unknown[]): D {
    noArguments("update", args);
    if (this.source === undefined) throw new ValueError("update() is only valid with a source instance");
    Object.assign(this.source, this.final());
    return this.source;
  }
}

/** Resolves a `Spec`: data is used as is; a callable is given a new builder and must return it. */
function resolveSpec<D>(spec: unknown, isData: (value: unknown) => value is D, builder: () => { create(): unknown }): D {
  if (isData(spec)) return spec;
  if (isClassLike(spec)) {
    const name = (spec as { name: string }).name;
    throw new TypeError(`a class is not a Spec here; for a native type use t => t.as_native(${name})`);
  }
  if (typeof spec === "function") {
    const built = (spec as (b: unknown) => unknown)(builder());
    if (built === null || built === undefined || typeof (built as { create?: unknown }).create !== "function") {
      throw new TypeError(`a Spec callable must return its builder, got ${repr(built)}`);
    }
    return (built as { create(): D }).create();
  }
  throw new TypeError(`expected a schema or a callable taking its builder, got ${repr(spec)}`);
}

// --- OfNative ---

const NON_FINITE: ReadonlyMap<string, number> = new Map([
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
]);

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** True when `value` has exactly the native type `token` (subclasses and boxed primitives are not the same type). */
export function isNativeOf(token: unknown, value: unknown): boolean {
  switch (token) {
    case BigInt:
      return typeof value === "bigint";
    case Number:
      return typeof value === "number";
    case String:
      return typeof value === "string";
    case Boolean:
      return typeof value === "boolean";
    case Uint8Array:
      return value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype;
  }
  return value !== null && value !== undefined && (value as { constructor?: unknown }).constructor === token;
}

class NativeData implements HasFields {
  type: unknown;

  constructor(type: unknown = null) {
    this.type = type;
  }


  equals(other: unknown): boolean {
    return other instanceof NativeData && other.type === this.type;
  }

  validate(): string[] {
    if (!NATIVE_TYPES.includes(this.type as NativeToken)) return [`unsupported native type ${repr(this.type)}`];
    return [];
  }

  /** Converts a native value to plain data that every text encoding can hold: `bytes` become base64 text, and
   * non-finite floats become the strings 'NaN', 'Infinity' and '-Infinity'. */
  to_plain(value: unknown): PlainData {
    if (!isNativeOf(this.type, value)) {
      throw new TypeError(`expected ${tokenName(this.type)}, got ${typeName(value)}`);
    }
    if (value instanceof Uint8Array) return toBase64(value);
    if (typeof value === "number" && !Number.isFinite(value)) {
      return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
    }
    return value as PlainData;
  }

  /** Converts plain data back to a native value. Distinct native types are never coerced into each other.
   * Plain data that does not hold such a value throws `Errors.DecodeError`. */
  from_plain(plain: unknown): Native {
    if (this.type === Uint8Array) {
      if (typeof plain !== "string") throw new DecodeError(`expected base64 text for bytes, got ${typeName(plain)}`);
      if (!BASE64.test(plain)) throw new DecodeError("invalid base64 text");
      return fromBase64(plain);
    }
    if (this.type === Number && typeof plain === "string") {
      const value = NON_FINITE.get(plain);
      if (value === undefined) {
        throw new DecodeError(`expected a float or one of ${repr(sortedStrings(NON_FINITE.keys()))}, got ${repr(plain)}`);
      }
      return value;
    }
    if (!isNativeOf(this.type, plain)) throw new DecodeError(`expected ${tokenName(this.type)}, got ${typeName(plain)}`);
    return plain as Native;
  }
}

class NativeBuilder extends Builder<NativeData> {
  protected make(fields: Record<string, unknown>): NativeData {
    return new NativeData(fields["type"] ?? null);
  }

  type(native: unknown): NativeBuilder {
    this.state["type"] = native;
    return this;
  }
}

function isNativeData(value: unknown): value is NativeData {
  return value instanceof NativeData;
}

export namespace OfNative {
  /** A native value. Conversion to and from the wire format is the responsibility of this element. */
  export const Data = NativeData;
  export type Data = NativeData;
  export const Builder = NativeBuilder;
  export type Builder = NativeBuilder;
  export type Spec = NativeToken | NativeData | ((builder: NativeBuilder) => NativeBuilder);

  export function resolve(spec: (builder: NativeBuilder) => NativeBuilder): NativeData;
  export function resolve(spec: Spec | unknown): NativeData;
  export function resolve(spec: Spec | unknown): NativeData {
    if (isClassLike(spec) || NATIVE_NAMES.has(spec)) return new NativeData(spec);
    return resolveSpec(spec, isNativeData, () => new NativeBuilder());
  }
}

// --- OfProperty (auxiliary: a named property of an object or relation) ---

class PropertyData implements HasFields {
  name: string;
  type: AnyData | null;

  constructor(fields: { name?: string; type?: AnyData | null } = {}) {
    this.name = fields.name ?? "";
    this.type = fields.type ?? null;
  }


  equals(other: unknown): boolean {
    return other === this;
  }
}

class PropertyBuilder extends Builder<PropertyData> {
  protected make(fields: Record<string, unknown>): PropertyData {
    return new PropertyData(fields as { name?: string; type?: AnyData });
  }

  name(name: string): PropertyBuilder {
    this.state["name"] = name;
    return this;
  }

  of(spec: OfAny.Spec): PropertyBuilder {
    this.state["type"] = OfAny.resolve(spec);
    return this;
  }
}

function isPropertyData(value: unknown): value is PropertyData {
  return value instanceof PropertyData;
}

export namespace OfProperty {
  export const Data = PropertyData;
  export type Data = PropertyData;
  export const Builder = PropertyBuilder;
  export type Builder = PropertyBuilder;
  export type Spec = (builder: PropertyBuilder) => PropertyBuilder;
}

function addProperties(state: Record<string, unknown>, specs: readonly unknown[]): void {
  const properties = (state["properties"] ??= new Map()) as Map<string, AnyData>;
  for (const spec of specs) {
    const prop = resolveSpec(spec, isPropertyData, () => new PropertyBuilder());
    properties.set(prop.name, prop.type as AnyData);
  }
}

// --- OfRelation ---

class RelationData implements HasFields {
  links: readonly string[];
  properties: Map<string, AnyData>;
  uniques: readonly ReadonlySet<string>[];

  constructor(fields: { links?: readonly string[]; properties?: Map<string, AnyData>; uniques?: readonly ReadonlySet<string>[] } = {}) {
    this.links = fields.links ?? [];
    this.properties = fields.properties ?? new Map();
    this.uniques = fields.uniques ?? [];
  }


  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems: string[] = [];
    if (this.links.length < 2) {
      problems.push("a relation needs at least two links; a one-link relation merges a relation and an object");
    }
    if (new Set(this.links).size !== this.links.length) {
      problems.push(`duplicate link names in ${repr(new Tuple(this.links))}`);
    }
    const clashes = this.links.filter((link) => this.properties.has(link));
    if (clashes.length > 0) problems.push(`names used as both link and property: ${repr(sortedStrings(new Set(clashes)))}`);
    for (const unique of this.uniques) {
      const unknown = [...unique].filter((name) => !this.links.includes(name) && !this.properties.has(name));
      if (unknown.length > 0) {
        problems.push(`unique(${sortedStrings(unique).join(", ")}) names unknown links or properties ${repr(sortedStrings(unknown))}`);
      }
    }
    for (const [name, prop] of this.properties) {
      problems.push(...[...validateSchema(prop), ...embeddedProblems(prop)].map((p) => `property ${repr(name)}: ${p}`));
    }
    return problems;
  }
}

class RelationBuilder extends Builder<RelationData> {
  protected make(fields: Record<string, unknown>): RelationData {
    return new RelationData(fields as ConstructorParameters<typeof RelationData>[0]);
  }

  links(...names: string[]): RelationBuilder {
    this.state["links"] = names;
    return this;
  }

  properties(...specs: OfProperty.Spec[]): RelationBuilder {
    addProperties(this.state, specs);
    return this;
  }

  /** Adds a `unique(S)` clause: the links and properties outside `S` determine `S`. */
  unique(...names: string[]): RelationBuilder {
    this.state["uniques"] = [...((this.state["uniques"] as ReadonlySet<string>[] | undefined) ?? []), new Set(names)];
    return this;
  }
}

function isRelationData(value: unknown): value is RelationData {
  return value instanceof RelationData;
}

export namespace OfRelation {
  /** A relationship between objects, with a named link per linked object. Relations have no caller-facing instance
   * builder; entries are added through the adjacencies of the objects they link. */
  export const Data = RelationData;
  export type Data = RelationData;
  export const Builder = RelationBuilder;
  export type Builder = RelationBuilder;
  export type Spec = RelationData | ((builder: RelationBuilder) => RelationBuilder);

  export function resolve(spec: Spec | unknown): RelationData {
    return resolveSpec(spec, isRelationData, () => new RelationBuilder());
  }
}

// --- OfAdjacency ---

class AdjacencyData implements HasFields {
  name: string;
  relation: RelationData | null;
  me: string;

  constructor(fields: { name?: string; relation?: RelationData | null; me?: string } = {}) {
    this.name = fields.name ?? "";
    this.relation = fields.relation ?? null;
    this.me = fields.me ?? "";
  }


  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    if (this.relation === null) return [`adjacency ${repr(this.name)} has no relation`];
    if (!this.relation.links.includes(this.me)) {
      return [`adjacency ${repr(this.name)}: ${repr(this.me)} is not a link of its relation ${repr(new Tuple(this.relation.links))}`];
    }
    return [];
  }
}

class AdjacencyBuilder extends Builder<AdjacencyData> {
  protected make(fields: Record<string, unknown>): AdjacencyData {
    return new AdjacencyData(fields as ConstructorParameters<typeof AdjacencyData>[0]);
  }

  /** Name of the accessor on the object, e.g. 'addresses'. */
  name(name: string): AdjacencyBuilder {
    this.state["name"] = name;
    return this;
  }

  of(spec: OfRelation.Spec): AdjacencyBuilder {
    this.state["relation"] = OfRelation.resolve(spec);
    return this;
  }

  /** The link this object fills. */
  me(link: string): AdjacencyBuilder {
    this.state["me"] = link;
    return this;
  }
}

function isAdjacencyData(value: unknown): value is AdjacencyData {
  return value instanceof AdjacencyData;
}

export namespace OfAdjacency {
  /** Declares that an `OfObject` is adjacent to an `OfRelation` via a particular link. */
  export const Data = AdjacencyData;
  export type Data = AdjacencyData;
  export const Builder = AdjacencyBuilder;
  export type Builder = AdjacencyBuilder;
  export type Spec = (builder: AdjacencyBuilder) => AdjacencyBuilder;
}

// --- OfObject ---

class ObjectData implements HasFields {
  properties: Map<string, AnyData>;
  adjacencies: Map<string, AdjacencyData>;
  singleton: string | null;

  constructor(fields: { properties?: Map<string, AnyData>; adjacencies?: Map<string, AdjacencyData>; singleton?: string | null } = {}) {
    this.properties = fields.properties ?? new Map();
    this.adjacencies = fields.adjacencies ?? new Map();
    this.singleton = fields.singleton ?? null;
  }


  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems: string[] = [];
    const clashes = [...this.properties.keys()].filter((name) => this.adjacencies.has(name));
    if (clashes.length > 0) {
      problems.push(`names used as both property and adjacency: ${repr(sortedStrings(clashes))}`);
    }
    for (const [name, prop] of this.properties) {
      problems.push(...[...validateSchema(prop), ...embeddedProblems(prop)].map((p) => `property ${repr(name)}: ${p}`));
    }
    for (const adjacency of this.adjacencies.values()) problems.push(...adjacency.validate());
    return problems;
  }
}

class ObjectBuilder extends Builder<ObjectData> {
  protected make(fields: Record<string, unknown>): ObjectData {
    return new ObjectData(fields as ConstructorParameters<typeof ObjectData>[0]);
  }

  properties(...specs: OfProperty.Spec[]): ObjectBuilder {
    addProperties(this.state, specs);
    return this;
  }

  relations(...specs: OfAdjacency.Spec[]): ObjectBuilder {
    const adjacencies = (this.state["adjacencies"] ??= new Map()) as Map<string, AdjacencyData>;
    for (const spec of specs) {
      const adjacency = resolveSpec(spec, isAdjacencyData, () => new AdjacencyBuilder());
      adjacencies.set(adjacency.name, adjacency);
    }
    return this;
  }

  /** Declares a singleton global name: the one instance exists implicitly and is referenced by this name. */
  singleton(name: string): ObjectBuilder {
    this.state["singleton"] = name;
    return this;
  }
}

function isObjectData(value: unknown): value is ObjectData {
  return value instanceof ObjectData;
}

export namespace OfObject {
  export const Data = ObjectData;
  export type Data = ObjectData;
  export const Builder = ObjectBuilder;
  export type Builder = ObjectBuilder;
  export type Spec = ObjectData | ((builder: ObjectBuilder) => ObjectBuilder);

  export function resolve(spec: Spec | unknown): ObjectData {
    return resolveSpec(spec, isObjectData, () => new ObjectBuilder());
  }
}

// --- OfUnion / OfIntersection ---

class BranchData implements HasFields {
  type: AnyData | null;
  when: unknown;

  constructor(fields: { type?: AnyData | null; when?: unknown } = {}) {
    this.type = fields.type ?? null;
    this.when = fields.when ?? null;
  }


  equals(other: unknown): boolean {
    return other === this;
  }
}

class BranchBuilder extends Builder<BranchData> {
  protected make(fields: Record<string, unknown>): BranchData {
    return new BranchData(fields as ConstructorParameters<typeof BranchData>[0]);
  }

  of(spec: OfAny.Spec): BranchBuilder {
    this.state["type"] = OfAny.resolve(spec);
    return this;
  }

  /** Discriminator predicate, a serializable expression. */
  when(predicate: unknown): BranchBuilder {
    this.state["when"] = predicate;
    return this;
  }
}

function isBranchData(value: unknown): value is BranchData {
  return value instanceof BranchData;
}

class UnionData implements HasFields {
  branches: readonly BranchData[];

  constructor(fields: { branches?: readonly BranchData[] } = {}) {
    this.branches = fields.branches ?? [];
  }


  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems: string[] = [];
    if (this.branches.length < 2) problems.push("a union needs at least two branches");
    if (new Set(this.branches.map((b) => kindOf(b.type))).size > 1) problems.push("union branches must all be the same kind");
    this.branches.forEach((b, i) => {
      if (b.when === null || b.when === undefined) problems.push(`branch ${i} has no discriminator predicate`);
    });
    return problems;
  }
}

class UnionBuilder extends Builder<UnionData> {
  protected make(fields: Record<string, unknown>): UnionData {
    return new UnionData(fields as ConstructorParameters<typeof UnionData>[0]);
  }

  /** Branches in declaration order; the first whose predicate matches is chosen. */
  branches(...specs: ((builder: BranchBuilder) => BranchBuilder)[]): UnionBuilder {
    const added = specs.map((spec) => resolveSpec(spec, isBranchData, () => new BranchBuilder()));
    this.state["branches"] = [...((this.state["branches"] as BranchData[] | undefined) ?? []), ...added];
    return this;
  }
}

function isUnionData(value: unknown): value is UnionData {
  return value instanceof UnionData;
}

export namespace OfUnion {
  export const Data = UnionData;
  export type Data = UnionData;
  export const Builder = UnionBuilder;
  export type Builder = UnionBuilder;
  export type Spec = UnionData | ((builder: UnionBuilder) => UnionBuilder);

  export function resolve(spec: Spec | unknown): UnionData {
    return resolveSpec(spec, isUnionData, () => new UnionBuilder());
  }
}

class IntersectionData implements HasFields {
  parts: readonly AnyData[];

  constructor(fields: { parts?: readonly AnyData[] } = {}) {
    this.parts = fields.parts ?? [];
  }


  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems: string[] = [];
    if (this.parts.length < 2) problems.push("an intersection needs at least two parts");
    if (new Set(this.parts.map(kindOf)).size > 1) problems.push("intersection parts must all be the same kind");
    const seen = new Map<string, AnyData>();
    for (const part of this.parts) {
      const properties = part instanceof ObjectData ? part.properties : new Map<string, AnyData>();
      for (const [name, prop] of properties) {
        const earlier = seen.get(name);
        if (earlier !== undefined && !earlier.equals(prop)) {
          problems.push(`property ${repr(name)} is declared with conflicting types`);
        }
        if (!seen.has(name)) seen.set(name, prop);
      }
    }
    return problems;
  }
}

class IntersectionBuilder extends Builder<IntersectionData> {
  protected make(fields: Record<string, unknown>): IntersectionData {
    return new IntersectionData(fields as ConstructorParameters<typeof IntersectionData>[0]);
  }

  of(...specs: OfAny.Spec[]): IntersectionBuilder {
    this.state["parts"] = [...((this.state["parts"] as AnyData[] | undefined) ?? []), ...specs.map((s) => OfAny.resolve(s))];
    return this;
  }
}

function isIntersectionData(value: unknown): value is IntersectionData {
  return value instanceof IntersectionData;
}

export namespace OfIntersection {
  export const Data = IntersectionData;
  export type Data = IntersectionData;
  export const Builder = IntersectionBuilder;
  export type Builder = IntersectionBuilder;
  export type Spec = IntersectionData | ((builder: IntersectionBuilder) => IntersectionBuilder);

  export function resolve(spec: Spec | unknown): IntersectionData {
    return resolveSpec(spec, isIntersectionData, () => new IntersectionBuilder());
  }
}

// --- OfAny ---

type AnyData = NativeData | ObjectData | UnionData | IntersectionData;

function isAnyData(value: unknown): value is AnyData {
  return value instanceof NativeData || value instanceof ObjectData || value instanceof UnionData || value instanceof IntersectionData;
}

function kindOf(value: unknown): unknown {
  return value === null || value === undefined ? null : (value as object).constructor;
}

function validateSchema(schema: unknown): string[] {
  if (!isAnyData(schema)) return [`not a schema: ${repr(schema)}`];
  return schema.validate();
}

/** Problems with a property's schema as a value: an object held by a property is embedded, with no identity, so it
 * cannot have adjacencies; nor can the objects a union or intersection holds. */
function embeddedProblems(schema: unknown): string[] {
  if (schema instanceof ObjectData && schema.adjacencies.size > 0) return ["an embedded object cannot have adjacencies"];
  const parts = schema instanceof UnionData ? schema.branches.map((b) => b.type)
    : schema instanceof IntersectionData ? [...schema.parts] : [];
  return sortedStrings(new Set(parts.flatMap((part) => embeddedProblems(part))));
}

/** Selects a kind through `as_<kind>(spec)`. Finalizing yields that kind's data, not a wrapper. */
class AnyBuilder {
  private readonly source: AnyData | undefined;
  private selected: AnyData | undefined;

  constructor(instance?: AnyData) {
    this.source = instance;
    this.selected = undefined;
  }

  as_native(spec: (builder: NativeBuilder) => NativeBuilder): AnyBuilder;
  as_native(spec: OfNative.Spec): AnyBuilder;
  as_native(spec: OfNative.Spec): AnyBuilder {
    this.selected = OfNative.resolve(spec);
    return this;
  }

  as_object(spec: OfObject.Spec): AnyBuilder {
    this.selected = OfObject.resolve(spec);
    return this;
  }

  as_union(spec: OfUnion.Spec): AnyBuilder {
    this.selected = OfUnion.resolve(spec);
    return this;
  }

  as_intersection(spec: OfIntersection.Spec): AnyBuilder {
    this.selected = OfIntersection.resolve(spec);
    return this;
  }

  private requireSelected(): AnyData {
    if (this.selected === undefined) throw new ValueError("no kind selected; call an as_<kind> method");
    return this.selected;
  }

  create(...args: unknown[]): AnyData {
    noArguments("create", args);
    if (this.source !== undefined) {
      throw new ValueError("create() is only valid without a source instance; use clone() or update()");
    }
    return this.requireSelected();
  }

  clone(...args: unknown[]): AnyData {
    noArguments("clone", args);
    if (this.source === undefined) throw new ValueError("clone() is only valid with a source instance");
    if (this.selected !== undefined) return this.selected;
    const copy = Object.create(Object.getPrototypeOf(this.source)) as AnyData;
    return Object.assign(copy, this.source);
  }

  update(...args: unknown[]): AnyData {
    noArguments("update", args);
    if (this.source === undefined) throw new ValueError("update() is only valid with a source instance");
    const selected = this.requireSelected();
    if (selected.constructor !== this.source.constructor) {
      throw new TypeError("update() cannot change the kind of the source schema");
    }
    for (const [name, value] of Object.entries(selected)) {
      (this.source as unknown as Record<string, unknown>)[name] = copyContainer(value);
    }
    return this.source;
  }
}

export namespace OfAny {
  /** Where a schema of any kind is expected. `OfAny.Data` is any schema kind's data. */
  export type Data = AnyData;
  export const Builder = AnyBuilder;
  export type Builder = AnyBuilder;
  export type Spec = AnyData | ((builder: AnyBuilder) => AnyBuilder);

  export function resolve(spec: Spec | unknown): AnyData {
    if (isAnyData(spec)) return spec;
    return resolveSpec(spec, isAnyData, () => new AnyBuilder());
  }
}
