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
import { isClassLike, NATIVE_NAMES, pyFloat, repr, sortedStrings, tokenName, Tuple, typeName } from "./Repr.js";
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

export const BASIC = "basic";
export const TYPESCRIPT5 = "typescript5";
const OWN_TYPES: ReadonlyMap<string, NativeToken> = new Map<string, NativeToken>(
  NATIVE_TYPES.map((host) => [(host as { name: string }).name, host]));
const BASIC_TYPES: ReadonlyMap<string, NativeToken> = new Map(NATIVE_TYPES.map((host) => [tokenName(host), host]));

/** A native type, named in a format: `basic`, the neutral vocabulary (`bool`, `int`, `float`, `str`, `bytes`), a
 * language's (`python3`, `typescript5`, `ccpp`, ...), or any other. */
class TokenClass {
  constructor(readonly format: string = BASIC, readonly name: string = "") {}

  equals(other: unknown): boolean {
    return other instanceof TokenClass && other.format === this.format && other.name === this.name;
  }

  toString(): string {
    return `the ${this.format} type ${repr(this.name)}`;
  }
}

/** The widths a native may have: in bits or in bytes. */
export interface Widths {
  bits?: bigint | null;
  bytes?: bigint | null;
}

/** A native type: a token, and optionally a width in bits or in bytes. A host type given in place of the token
 * (`new OfNative.Data(BigInt)`) is shorthand for the `basic` token of the same name. */
class NativeData implements HasFields {
  token: unknown;
  bits: bigint | null;
  bytes: bigint | null;

  constructor(token: unknown = null, widths: Widths = {}) {
    this.token = NATIVE_NAMES.has(token) ? new TokenClass(BASIC, NATIVE_NAMES.get(token) as string) : token;
    this.bits = widths.bits ?? null;
    this.bytes = widths.bytes ?? null;
  }

  /** The host type the token maps to, or null when this implementation cannot read the token. */
  get type(): NativeToken | null {
    if (!(this.token instanceof TokenClass)) return null;
    const hosts = this.token.format === BASIC ? BASIC_TYPES : this.token.format === TYPESCRIPT5 ? OWN_TYPES : null;
    return hosts?.get(this.token.name) ?? null;
  }

  /** The host type the token maps to; throws TypeError when this implementation cannot read the token. */
  host(): NativeToken {
    const host = this.type;
    if (host === null) throw new TypeError(`${String(this.token)} has no type in this implementation`);
    return host;
  }

  equals(other: unknown): boolean {
    return other instanceof NativeData && other.bits === this.bits && other.bytes === this.bytes
      && (this.token instanceof TokenClass ? this.token.equals(other.token) : other.token === this.token);
  }

  validate(): string[] {
    const problems: string[] = [];
    const token = this.token;
    if (!(token instanceof TokenClass)) problems.push(`unsupported native type ${repr(token)}`);
    else if (typeof token.format !== "string" || token.format === "" || typeof token.name !== "string" || token.name === "") {
      problems.push("a token needs a format and a name");
    } else if (token.format === BASIC && this.type === null) problems.push(`basic has no type ${repr(token.name)}`);
    for (const [unit, width] of [["bits", this.bits], ["bytes", this.bytes]] as const) {
      if (width !== null && (typeof width !== "bigint" || width < 1n)) {
        problems.push(`a width in ${unit} must be a positive int, got ${repr(width)}`);
      }
    }
    if (this.bits !== null && this.bytes !== null) problems.push("a width is in bits or in bytes, not both");
    return problems;
  }

  /** Converts a native value to plain data that every text encoding can hold: `bytes` become base64 text, and
   * non-finite floats become the strings 'NaN', 'Infinity' and '-Infinity'. */
  to_plain(value: unknown): PlainData {
    const host = this.host();
    if (!isNativeOf(host, value)) throw new TypeError(`expected ${tokenName(host)}, got ${typeName(value)}`);
    if (value instanceof Uint8Array) return toBase64(value);
    if (typeof value === "number" && !Number.isFinite(value)) {
      return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
    }
    return value as PlainData;
  }

  /** Converts plain data back to a native value. Distinct native types are never coerced into each other.
   * Plain data that does not hold such a value, or a token this implementation cannot read, throws
   * `Errors.DecodeError`. */
  /** A native value as the text of a key over the wire: its plain form when that is text (`str`, `bytes` as base64,
   * non-finite floats), a finite float's Python `repr`, and `true` or `false`. */
  to_key(value: unknown): string {
    const plain = this.to_plain(value);
    if (typeof plain === "boolean") return plain ? "true" : "false";
    return typeof plain === "string" ? plain : pyFloat(plain as number);
  }

  /** The native value a key's text holds; anything but the text `to_key` writes throws `DecodeError`. */
  from_key(text: string): Native {
    const host = this.hostForDecoding();
    let value: Native | null;
    try {
      value = host === Boolean ? (text === "true" ? true : text === "false" ? false : null)
        : host === Number && !NON_FINITE.has(text) ? Number(text) : this.from_plain(text);
    } catch {
      value = null; // from_plain throws only DecodeError
    }
    if (value === null || this.to_key(value) !== text) {
      throw new DecodeError(`expected the text of a ${tokenName(host)} key, got ${repr(text)}`);
    }
    return value;
  }

  /** The host type, or `DecodeError` when this implementation cannot read the token. */
  private hostForDecoding(): NativeToken {
    if (this.type === null) throw new DecodeError(`${String(this.token)} has no type in this implementation`);
    return this.type;
  }

  from_plain(plain: unknown): Native {
    const host = this.hostForDecoding();
    if (host === Uint8Array) {
      if (typeof plain !== "string") throw new DecodeError(`expected base64 text for bytes, got ${typeName(plain)}`);
      if (!BASE64.test(plain)) throw new DecodeError("invalid base64 text");
      return fromBase64(plain);
    }
    if (host === Number && typeof plain === "string") {
      const value = NON_FINITE.get(plain);
      if (value === undefined) {
        throw new DecodeError(`expected a float or one of ${repr(sortedStrings(NON_FINITE.keys()))}, got ${repr(plain)}`);
      }
      return value;
    }
    if (!isNativeOf(host, plain)) throw new DecodeError(`expected ${tokenName(host)}, got ${typeName(plain)}`);
    return plain as Native;
  }
}

class NativeBuilder extends Builder<NativeData> {
  protected make(fields: Record<string, unknown>): NativeData {
    return new NativeData(fields["token"] ?? null, { bits: fields["bits"] as bigint | null, bytes: fields["bytes"] as bigint | null });
  }

  /** A host type: shorthand for the `basic` token of the same name. */
  type(native: unknown): NativeBuilder {
    this.state["token"] = new NativeData(native).token;
    return this;
  }

  /** A token in any format, e.g. `.token("ccpp", "int32_t")`. */
  token(format: string, name: string): NativeBuilder {
    this.state["token"] = new TokenClass(format, name);
    return this;
  }

  bits(width: bigint): NativeBuilder {
    this.state["bits"] = width;
    return this;
  }

  bytes(width: bigint): NativeBuilder {
    this.state["bytes"] = width;
    return this;
  }
}

function isNativeData(value: unknown): value is NativeData {
  return value instanceof NativeData;
}

export namespace OfNative {
  /** The meta-schema of native schemas: a token's `format` and `name`, and a width in `bits` or `bytes`. */
  export let Schema: ObjectData;
  /** A native value. Conversion to and from the wire format is the responsibility of this element. */
  export const Data = NativeData;
  export type Data = NativeData;
  export const Builder = NativeBuilder;
  export type Builder = NativeBuilder;
  export const Token = TokenClass;
  export type Token = TokenClass;
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
  /** The meta-schema of a named member: a property, a union's branch or an intersection's part. */
  export let Schema: ObjectData;
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
      problems.push(...[...validateSchema(prop), ...embeddedProblems(prop), ...entryValueProblems(prop)]
        .map((p) => `property ${repr(name)}: ${p}`));
    }
    return problems;
  }
}

/** An entry property's value object has no adjacencies: an entry is written under each object it links, so its value
 * objects would be too, and nothing could link them once. Nor has a value object in a key (`held`), which compares by
 * structure. `seen` holds the schemas on the way, so that a schema that holds itself is checked once. */
function entryValueProblems(schema: unknown, held = "held by an entry", seen: ReadonlySet<unknown> = new Set()): string[] {
  if (seen.has(schema)) return [];
  if (schema instanceof ObjectData && schema.adjacencies.size > 0) return [`a value object ${held} cannot have adjacencies`];
  const inner = new Set([...seen, schema]);
  return sortedStrings(new Set(membersOf(schema).flatMap((member) => entryValueProblems(member, held, inner))));
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
  /** The meta-schema of relation schemas. */
  export let Schema: ObjectData;
  /** A relation, inline or by name. */
  export let Ref: UnionData;
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
  /** The meta-schema of adjacencies. */
  export let Schema: ObjectData;
  /** Declares that an `OfObject` is adjacent to an `OfRelation` via a particular link. */
  export const Data = AdjacencyData;
  export type Data = AdjacencyData;
  export const Builder = AdjacencyBuilder;
  export type Builder = AdjacencyBuilder;
  export type Spec = (builder: AdjacencyBuilder) => AdjacencyBuilder;
}

// --- OfObject ---

/** The object schemas being validated, so that one that holds itself is validated once. */
const VALIDATING = new Set<unknown>();

class ObjectData implements HasFields {
  properties: Map<string, AnyData>;
  adjacencies: Map<string, AdjacencyData>;
  singleton: string | null;
  /** A reference object schema; otherwise a value object schema. */
  ref: boolean;

  constructor(fields: { properties?: Map<string, AnyData>; adjacencies?: Map<string, AdjacencyData>; singleton?: string | null;
    ref?: boolean } = {}) {
    this.properties = fields.properties ?? new Map();
    this.adjacencies = fields.adjacencies ?? new Map();
    this.singleton = fields.singleton ?? null;
    this.ref = fields.ref ?? false;
  }


  equals(other: unknown): boolean {
    return other === this;
  }

  /** The schema's problems. A value object schema may hold itself, through a list: its problems are reported once,
   * where it is first reached. */
  validate(): string[] {
    if (VALIDATING.has(this)) return [];
    VALIDATING.add(this);
    try {
      return this.problems();
    } finally {
      VALIDATING.delete(this);
    }
  }

  private problems(): string[] {
    const problems: string[] = [];
    if (this.singleton !== null && !this.ref) problems.push("a singleton's schema must be a reference object schema");
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

  /** Declares a singleton global name: the one instance exists implicitly and is referenced by this name. A
   * singleton is a reference object. */
  singleton(name: string): ObjectBuilder {
    this.state["singleton"] = name;
    this.state["ref"] = true;
    return this;
  }

  /** Marks a reference object schema: its objects stand on their own, reached through relations, and no property holds
   * one. Without it, the schema describes value objects, which properties hold. */
  ref(): ObjectBuilder {
    this.state["ref"] = true;
    return this;
  }
}

function isObjectData(value: unknown): value is ObjectData {
  return value instanceof ObjectData;
}

export namespace OfObject {
  /** The meta-schema of object schemas. */
  export let Schema: ObjectData;
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

/** A named member of a union (a branch) or of an intersection (a part). */
class MemberData implements HasFields {
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

class MemberBuilder extends Builder<MemberData> {
  protected make(fields: Record<string, unknown>): MemberData {
    return new MemberData(fields as ConstructorParameters<typeof MemberData>[0]);
  }

  name(name: string): MemberBuilder {
    this.state["name"] = name;
    return this;
  }

  of(spec: OfAny.Spec): MemberBuilder {
    this.state["type"] = OfAny.resolve(spec);
    return this;
  }
}

function isMemberData(value: unknown): value is MemberData {
  return value instanceof MemberData;
}

/** Problems with a union's branches (`aKind` 'a union', `member` 'branch') or an intersection's parts. */
function memberProblems(aKind: string, member: string, plural: string, members: readonly MemberData[]): string[] {
  const kind = aKind.split(" ")[1];
  const problems: string[] = [];
  if (members.length < 2) problems.push(`${aKind} needs at least two ${plural}`);
  if (new Set(members.map((m) => kindOf(m.type))).size > 1) problems.push(`${kind} ${plural} must all be the same kind`);
  const seen = new Set<string>();
  members.forEach((m, i) => {
    if (typeof m.name !== "string" || m.name === "") problems.push(`${member} ${i} has no name`);
    else if (seen.has(m.name)) problems.push(`${member} name ${repr(m.name)} is used more than once`);
    seen.add(m.name);
  });
  return problems;
}

function members(specs: readonly ((builder: MemberBuilder) => MemberBuilder)[]): MemberData[] {
  return specs.map((spec) => resolveSpec(spec, isMemberData, () => new MemberBuilder()));
}

function byName(members: readonly MemberData[]): Map<string, AnyData> {
  return new Map(members.map((m) => [m.name, m.type as AnyData]));
}

class UnionData implements HasFields {
  branches: readonly MemberData[];

  constructor(fields: { branches?: readonly MemberData[] } = {}) {
    this.branches = fields.branches ?? [];
  }

  /** The branches by name: a union value is an object holding exactly one of them. */
  get properties(): Map<string, AnyData> {
    return byName(this.branches);
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    return memberProblems("a union", "branch", "branches", this.branches);
  }
}

class UnionBuilder extends Builder<UnionData> {
  protected make(fields: Record<string, unknown>): UnionData {
    return new UnionData(fields as ConstructorParameters<typeof UnionData>[0]);
  }

  /** Named branches, e.g. `.branches((b) => b.name("phone").of(Phone), ...)`. */
  branches(...specs: ((builder: MemberBuilder) => MemberBuilder)[]): UnionBuilder {
    this.state["branches"] = [...((this.state["branches"] as MemberData[] | undefined) ?? []), ...members(specs)];
    return this;
  }
}

function isUnionData(value: unknown): value is UnionData {
  return value instanceof UnionData;
}

export namespace OfUnion {
  /** The meta-schema of union schemas. */
  export let Schema: ObjectData;
  export const Data = UnionData;
  export type Data = UnionData;
  export const Builder = UnionBuilder;
  export type Builder = UnionBuilder;
  export type Spec = UnionData | ((builder: UnionBuilder) => UnionBuilder);
  export const Branch = MemberData;
  export type Branch = MemberData;

  export function resolve(spec: Spec | unknown): UnionData {
    return resolveSpec(spec, isUnionData, () => new UnionBuilder());
  }
}

class IntersectionData implements HasFields {
  parts: readonly MemberData[];

  constructor(fields: { parts?: readonly MemberData[] } = {}) {
    this.parts = fields.parts ?? [];
  }

  /** The parts by name: an intersection value is an object holding every one of them. */
  get properties(): Map<string, AnyData> {
    return byName(this.parts);
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    return memberProblems("an intersection", "part", "parts", this.parts);
  }
}

class IntersectionBuilder extends Builder<IntersectionData> {
  protected make(fields: Record<string, unknown>): IntersectionData {
    return new IntersectionData(fields as ConstructorParameters<typeof IntersectionData>[0]);
  }

  /** Named parts, e.g. `.parts((p) => p.name("stamp").of(Stamp), ...)`. */
  parts(...specs: ((builder: MemberBuilder) => MemberBuilder)[]): IntersectionBuilder {
    this.state["parts"] = [...((this.state["parts"] as MemberData[] | undefined) ?? []), ...members(specs)];
    return this;
  }
}

function isIntersectionData(value: unknown): value is IntersectionData {
  return value instanceof IntersectionData;
}

export namespace OfIntersection {
  /** The meta-schema of intersection schemas. */
  export let Schema: ObjectData;
  export const Data = IntersectionData;
  export type Data = IntersectionData;
  export const Builder = IntersectionBuilder;
  export type Builder = IntersectionBuilder;
  export type Spec = IntersectionData | ((builder: IntersectionBuilder) => IntersectionBuilder);
  export const Part = MemberData;
  export type Part = MemberData;

  export function resolve(spec: Spec | unknown): IntersectionData {
    return resolveSpec(spec, isIntersectionData, () => new IntersectionBuilder());
  }
}

// --- OfIndexed ---

/** The keys a positional list may have: `minimum` to `maximum`, inclusive; `maximum` null for no bound. */
class ExtentClass {
  readonly minimum: bigint;
  readonly maximum: bigint | null;

  constructor(minimum: bigint = 0n, maximum: bigint | null = null) {
    this.minimum = minimum;
    this.maximum = maximum;
  }

  equals(other: unknown): boolean {
    return other instanceof ExtentClass && other.minimum === this.minimum && other.maximum === this.maximum;
  }
}

/** A list: items of the item schema, in order. Without a key schema, or with a native `int` one, it is positional: its
 * keys are its positions, from its extent's minimum. With any other key schema it is keyed: its items are held by
 * unique keys of that schema, in insertion order. */
class IndexedData implements HasFields {
  item: AnyData | null;
  key: AnyData | null;
  extent: ExtentClass | null;

  constructor(fields: { item?: AnyData | null; key?: AnyData | null; extent?: ExtentClass | null } = {}) {
    this.item = fields.item ?? null;
    this.key = fields.key ?? null;
    this.extent = fields.extent ?? null;
  }

  get positional(): boolean {
    return this.key === null || (this.key instanceof NativeData && this.key.type === BigInt);
  }

  /** The first key of a positional list: its extent's minimum, or 0. */
  get minimum(): bigint {
    return this.extent !== null && typeof this.extent.minimum === "bigint" ? this.extent.minimum : 0n;
  }

  /** How many items a positional list's extent holds, or null when it has no valid maximum. */
  get capacity(): bigint | null {
    const extent = this.extent;
    if (extent === null || typeof extent.maximum !== "bigint" || typeof extent.minimum !== "bigint") return null;
    return extent.maximum - extent.minimum + 1n;
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems = validateSchema(this.item).map((problem) => `item: ${problem}`);
    if (this.key !== null) {
      const key = [...validateSchema(this.key), ...embeddedProblems(this.key, new Set(), "a key"),
        ...entryValueProblems(this.key, "in a key")];
      problems.push(...key.map((problem) => `key: ${problem}`));
    }
    if (this.extent !== null) problems.push(...this.extentProblems(this.extent));
    return problems;
  }

  private extentProblems(extent: ExtentClass): string[] {
    const problems = this.positional ? [] : ["an extent bounds a positional list, whose keys are ints"];
    if (typeof extent.minimum !== "bigint" || !(extent.maximum === null || typeof extent.maximum === "bigint")) {
      problems.push(`an extent's minimum and maximum are ints, got ${repr(extent.minimum)} and ${repr(extent.maximum)}`);
    } else if (extent.maximum !== null && extent.minimum > extent.maximum) {
      problems.push(`an extent's minimum ${extent.minimum} exceeds its maximum ${extent.maximum}`);
    }
    return problems;
  }
}

class IndexedBuilder extends Builder<IndexedData> {
  protected make(fields: Record<string, unknown>): IndexedData {
    return new IndexedData(fields as ConstructorParameters<typeof IndexedData>[0]);
  }

  /** The schema of every item. */
  of(spec: OfAny.Spec): IndexedBuilder {
    this.state["item"] = OfAny.resolve(spec);
    return this;
  }

  /** The schema of the keys; any but a native `int` makes the list keyed. */
  key(spec: OfAny.Spec): IndexedBuilder {
    this.state["key"] = OfAny.resolve(spec);
    return this;
  }

  /** The keys a positional list may have, `minimum` to `maximum`. */
  extent(bounds: { minimum?: bigint; maximum?: bigint | null } = {}): IndexedBuilder {
    this.state["extent"] = new ExtentClass(bounds.minimum ?? 0n, bounds.maximum ?? null);
    return this;
  }
}

function isIndexedData(value: unknown): value is IndexedData {
  return value instanceof IndexedData;
}

export namespace OfIndexed {
  /** The meta-schema of list schemas. */
  export let Schema: ObjectData;
  /** A list of items of one schema, held by a property; its items belong to the property's owner. */
  export const Data = IndexedData;
  export type Data = IndexedData;
  export const Builder = IndexedBuilder;
  export type Builder = IndexedBuilder;
  export const Extent = ExtentClass;
  export type Extent = ExtentClass;
  export type Spec = IndexedData | ((builder: IndexedBuilder) => IndexedBuilder);

  export function resolve(spec: Spec | unknown): IndexedData {
    return resolveSpec(spec, isIndexedData, () => new IndexedBuilder());
  }
}

// --- OfAny ---

type AnyData = NativeData | ObjectData | UnionData | IntersectionData | IndexedData;

function isAnyData(value: unknown): value is AnyData {
  return value instanceof NativeData || value instanceof ObjectData || value instanceof UnionData ||
    value instanceof IntersectionData || value instanceof IndexedData;
}

function kindOf(value: unknown): unknown {
  return value === null || value === undefined ? null : (value as object).constructor;
}

function validateSchema(schema: unknown): string[] {
  if (!isAnyData(schema)) return [`not a schema: ${repr(schema)}`];
  return schema.validate();
}

/** The schemas of the values a value of `schema` holds: a value object's properties, a union's branches, an
 * intersection's parts, a list's item. */
function membersOf(schema: unknown): unknown[] {
  if (schema instanceof IndexedData) return [schema.item];
  return schema instanceof ObjectData || schema instanceof UnionData || schema instanceof IntersectionData
    ? [...schema.properties.values()] : [];
}

/** Problems with a property's schema as a value (or a key's, `role`): an object held by a property is a value object,
 * so its schema is not a reference object schema; nor are the schemas of the objects a union, an intersection or a list
 * holds. `seen` holds the schemas on the way, so that one that holds itself is checked once. */
function embeddedProblems(schema: unknown, seen: ReadonlySet<unknown> = new Set(), role = "a property's type"): string[] {
  if (schema instanceof ObjectData) return schema.ref ? [`a reference object schema cannot be ${role}`] : [];
  if (seen.has(schema)) return [];
  const inner = new Set([...seen, schema]);
  return sortedStrings(new Set(membersOf(schema).flatMap((member) => embeddedProblems(member, inner, role))));
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

  as_indexed(spec: OfIndexed.Spec): AnyBuilder {
    this.selected = OfIndexed.resolve(spec);
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
  /** A type: a schema of any kind, inline, or a name. */
  export let Schema: UnionData;
  /** A name, as a type refers to a schema by it. */
  export let Named: ObjectData;
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

// --- Meta-schemas: the schemas of schema data, so that schemas are written, read, validated and compared as objects ---

function namedText(name: string) {
  return (p: PropertyBuilder) => p.name(name).of((t) => t.as_native(String));
}

function listOf(spec: OfAny.Spec) {
  return (t: AnyBuilder) => t.as_indexed((i) => i.of(spec));
}

const Text = (t: AnyBuilder) => t.as_native(String);
const NamedSchema = new ObjectBuilder().properties(namedText("name")).create();
const AnySchema = new UnionBuilder().create(); // a type; its branches, which refer back to it, are added below
const PropertySchema = new ObjectBuilder().properties(namedText("name"), (p) => p.name("type").of(AnySchema)).create();
const NativeSchema = new ObjectBuilder().properties(
  namedText("format"), namedText("name"), (p) => p.name("bits").of((t) => t.as_native(BigInt)),
  (p) => p.name("bytes").of((t) => t.as_native(BigInt))).create();
const RelationSchema = new ObjectBuilder().properties(
  (p) => p.name("links").of(listOf(Text)), (p) => p.name("properties").of(listOf(PropertySchema)),
  (p) => p.name("uniques").of(listOf(listOf(Text)))).create();
const RelationRef = new UnionBuilder().branches((b) => b.name("relation").of(RelationSchema),
  (b) => b.name("named").of(NamedSchema)).create();
const AdjacencySchema = new ObjectBuilder().properties(
  namedText("name"), (p) => p.name("relation").of(RelationRef), namedText("me")).create();
const ObjectSchema = new ObjectBuilder().properties(
  (p) => p.name("properties").of(listOf(PropertySchema)), (p) => p.name("adjacencies").of(listOf(AdjacencySchema)),
  namedText("singleton"), (p) => p.name("ref").of((t) => t.as_native(Boolean))).create();
const UnionSchema = new ObjectBuilder().properties((p) => p.name("branches").of(listOf(PropertySchema))).create();
const IntersectionSchema = new ObjectBuilder().properties((p) => p.name("parts").of(listOf(PropertySchema))).create();
const ExtentSchema = new ObjectBuilder().properties((p) => p.name("minimum").of((t) => t.as_native(BigInt)),
  (p) => p.name("maximum").of((t) => t.as_native(BigInt))).create();
const IndexedSchema = new ObjectBuilder().properties((p) => p.name("item").of(AnySchema), (p) => p.name("key").of(AnySchema),
  (p) => p.name("extent").of(ExtentSchema)).create();
const KIND_SCHEMAS: [string, ObjectData][] = [["native", NativeSchema], ["object", ObjectSchema], ["union", UnionSchema],
  ["intersection", IntersectionSchema], ["indexed", IndexedSchema]];
const kindBranches = KIND_SCHEMAS.map(([name, schema]) => (b: MemberBuilder) => b.name(name).of(schema));
new UnionBuilder(AnySchema).branches(...kindBranches, (b) => b.name("named").of(NamedSchema)).update();
const DefinitionSchema = new UnionBuilder().branches(...kindBranches, (b) => b.name("relation").of(RelationSchema)).create();
const EntrySchema = new ObjectBuilder().properties(namedText("name"), (p) => p.name("schema").of(DefinitionSchema)).create();

OfNative.Schema = NativeSchema;
OfProperty.Schema = PropertySchema;
OfRelation.Schema = RelationSchema;
OfRelation.Ref = RelationRef;
OfAdjacency.Schema = AdjacencySchema;
OfObject.Schema = ObjectSchema;
OfUnion.Schema = UnionSchema;
OfIntersection.Schema = IntersectionSchema;
OfIndexed.Schema = IndexedSchema;
OfAny.Schema = AnySchema;
OfAny.Named = NamedSchema;

/** A named set of schemas, as data. `Module.Schema` is the reference object schema of a module: its `schemas` are a
 * list of `Module.Entry` value objects, each a `name` and a `schema`, a `Module.Definition` (a schema of any kind,
 * relations included). See `Modules` for the translation between schemas and modules. */
export namespace Module {
  export const Schema = new ObjectBuilder().ref().properties((p) => p.name("schemas").of(listOf(EntrySchema))).create();
  export const Entry = EntrySchema;
  export const Definition = DefinitionSchema;
}
