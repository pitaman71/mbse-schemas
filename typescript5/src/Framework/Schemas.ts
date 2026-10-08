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
 *
 * Every kind of schema may have a `name`, set by its builder's `.name("crm.Contact")`: identifiers separated by dots,
 * the part before the last dot its namespace. A named schema is referred to by its name wherever it is written (a
 * module, a predicate's symbols), and a store registers it under that name; an unnamed one is written inline.
 *
 * Every kind of schema may declare `parameters` (`OfParameter`), variables determined where the schema is referred to:
 * `OfApply` applies a parametric schema to arguments. Where a literal width or extent stands, a term may stand instead:
 * an expression term, such as mbse-expressions', or its neutral `Form`, which may refer to parameters.
 */

import { fromBase64, toBase64 } from "./Bytes.js";
import { DecodeError, ValueError } from "./Errors.js";
import type { PlainData } from "./Plain.js";
import { isClassLike, NATIVE_NAMES, pyFloat, repr, sortedStrings, tokenName, Tuple, typeName } from "./Repr.js";
import type { Native, NativeToken } from "./Visitors.js";

/** Problems with names that start with `$`, which the wire format keeps for its own markers (`$ref`, `$schema`,
 * `$id`). */
function reserved(names: readonly unknown[]): string[] {
  return names.filter((name): name is string => typeof name === "string" && name.startsWith("$"))
    .map((name) => `name ${repr(name)} is reserved: names starting with '$' belong to the wire format`);
}

export const NATIVE_TYPES: readonly NativeToken[] = [BigInt, Number, String, Boolean, Uint8Array];

const DOTTED = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** A schema's name, when it has one, is identifiers separated by dots. */
function nameProblems(name: unknown): string[] {
  if (name === null || name === undefined || (typeof name === "string" && DOTTED.test(name))) return [];
  return [`name ${repr(name)} is not identifiers separated by dots, e.g. 'crm.Contact'`];
}

/** An element's description, when it has one, is text. */
function descriptionProblems(description: unknown, where = ""): string[] {
  if (description === null || description === undefined || typeof description === "string") return [];
  return [`${where}a description is text, got ${typeName(description)}`];
}

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

  /** What the element is for, in prose: documentation, which no validation or comparison of data reads. */
  description(text: string): this {
    this.state["description"] = text;
    return this;
  }
}

/** A builder of a kind of schema, which may be named. */
abstract class NamedBuilder<D extends HasFields> extends Builder<D> {
  /** The schema's name: identifiers separated by dots, e.g. `"crm.Contact"`. */
  name(name: string): this {
    this.state["name"] = name;
    return this;
  }

  /** Parameters the schema declares, in order, e.g. `.parameters((p) => p.name("n").of(...))`. */
  parameters(...specs: OfParameter.Spec[]): this {
    const parameters = (this.state["parameters"] ??= new Map()) as Map<string, ParameterData>;
    for (const spec of specs) {
      const parameter = resolveSpec(spec, isParameterData, () => new ParameterBuilder());
      parameters.set(parameter.name, parameter);
    }
    return this;
  }
}

/** Filled by `Reflection`, which writes a schema in its module form, so that this module need not import `Modules`. */
export const _REFLECTION: { accept: ((schema: unknown, visitor: unknown) => void) | null } = { accept: null };

const IDENTITIES = new WeakMap<object, string>();
let identities = 0;

/** A schema as an object predicates match (see `Reflection`): a reference object, identified by a string unique to it
 * (`"schema 3"`), as mbse-schemas keys identities by their text, whose schema is its kind's meta-schema. */
class Reflected {
  identity(): string {
    let identity = IDENTITIES.get(this);
    if (identity === undefined) IDENTITIES.set(this, (identity = `schema ${++identities}`));
    return identity;
  }

  schema_name(): string {
    return KIND_NAMES.get(this.constructor) as string;
  }

  owner(): null {
    return null;
  }

  accept(visitor: unknown): void {
    (_REFLECTION.accept as (schema: unknown, visitor: unknown) => void)(this, visitor);
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

// --- Terms: expressions where a literal may stand ---

/** A term's structure, in the neutral form mbse-expressions' terms give (`term.form()`): its `kind`, its native
 * `attributes` by name, its ordered `arguments`, each a form, and the `dialect` it is read in, given at its root. A form
 * is itself a term, which a module writes and reads back without knowing its dialect. */
class FormData {
  readonly kind: string;
  readonly attributes: ReadonlyMap<string, Native>;
  readonly arguments: readonly unknown[];
  readonly dialect: string | null;

  constructor(kind = "", attributes: ReadonlyMap<string, Native> | Record<string, Native> = new Map(),
    args: readonly unknown[] = [], dialect: string | null = null) {
    this.kind = kind;
    this.attributes = attributes instanceof Map ? attributes : new Map(Object.entries(attributes));
    this.arguments = args;
    this.dialect = dialect;
  }

  /** The form of a term: a form as it is, or the form of a term of a dialect (`term.form()`, whose arguments are
   * terms, and `term.dialect().name()`), its arguments' forms within it. */
  static of(term: unknown): FormData {
    if (term instanceof FormData) return term;
    if (!isTerm(term)) throw new TypeError(`not a term: ${repr(term)}`);
    const form = (term as ForeignTerm).form();
    return new FormData(form.kind, new Map(form.attributes), form.arguments.map((a) => FormData.ofArgument(a)),
      (term as ForeignTerm).dialect().name());
  }

  private static ofArgument(term: unknown): FormData {
    const form = FormData.of(term);
    return term instanceof FormData ? form : new FormData(form.kind, form.attributes, form.arguments, null);
  }

  equals(other: unknown): boolean {
    return other instanceof FormData && other.kind === this.kind && other.dialect === this.dialect
      && other.attributes.size === this.attributes.size
      && [...this.attributes].every(([name, value]) => other.attributes.has(name) && sameNative(value, other.attributes.get(name)))
      && other.arguments.length === this.arguments.length
      && this.arguments.every((argument, i) => sameValue(argument, other.arguments[i]));
  }

  validate(): string[] {
    const problems = typeof this.kind === "string" && this.kind !== "" ? [] : [`a term needs a kind, got ${repr(this.kind)}`];
    if (this.dialect !== null && typeof this.dialect !== "string") problems.push(`a term's dialect is a name, got ${repr(this.dialect)}`);
    for (const [name, value] of this.attributes) {
      if (!isNative(value)) problems.push(`attribute ${repr(name)} is not a native value: ${repr(value)}`);
    }
    this.arguments.forEach((argument, i) => {
      if (argument instanceof FormData) problems.push(...argument.validate().map((p) => `argument ${i}: ${p}`));
      else problems.push(`argument ${i} is not a term: ${repr(argument)}`);
    });
    return problems;
  }
}

/** A term of a dialect, as mbse-expressions' terms are: its form, whose arguments are terms, and its dialect. */
interface ForeignTerm {
  form(): { kind: string; attributes: ReadonlyMap<string, Native>; arguments: readonly unknown[] };
  dialect(): { name(): string };
}

/** Whether `value` is a term: a form, or anything with a `form()` and a `dialect()`, as mbse-expressions' terms. */
function isTerm(value: unknown): boolean {
  if (value instanceof FormData) return true;
  const term = value as { form?: unknown; dialect?: unknown } | null | undefined;
  return term !== null && term !== undefined && typeof term === "object" && typeof term.form === "function"
    && typeof term.dialect === "function";
}

function isNative(value: unknown): value is Native {
  return NATIVE_TYPES.some((token) => isNativeOf(token, value));
}

/** Native values equal as Python's `==` finds them: the same type and value, bytes by content. */
function sameNative(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((byte, i) => byte === b[i]);
  return typeof a === typeof b && a === b;
}

/** A width, a bound or an argument equal to another: a form by structure, anything else as itself. */
function sameValue(a: unknown, b: unknown): boolean {
  return a instanceof FormData ? a.equals(b) : a === b;
}

/** Problems with a form standing for `what`; a term of a dialect is that dialect's to check. */
function termProblems(value: unknown, what: string): string[] {
  return value instanceof FormData ? value.validate().map((p) => `${what}: ${p}`) : [];
}

/** The neutral form of a term. `new Form.Data(kind, attributes, arguments, dialect)`; `Form.of(term)` gives a term's. */
export namespace Form {
  /** The meta-schema of a form: its `dialect`, `kind`, `attributes` and `arguments`. */
  export let Schema: ObjectData;
  /** A native value, by its basic type's name: `{"int": 3}`. */
  export let Value: UnionData;
  export const Data = FormData;
  export type Data = FormData;
  export function of(term: unknown): FormData {
    return FormData.of(term);
  }
  export function is_term(value: unknown): boolean {
    return isTerm(value);
  }
}

// --- OfParameter: a variable a schema declares ---

/** A parameter of the schema that declares it: a variable, named, of a type (null for any), determined where the
 * schema is referred to (`OfApply`) and referred to within it by name, as a variable is. */
class ParameterData {
  name: string;
  type: AnyData | null;
  description: string | null;

  constructor(fields: { name?: string; type?: AnyData | null; description?: string | null } = {}) {
    this.name = fields.name ?? "";
    this.type = fields.type ?? null;
    this.description = fields.description ?? null;
  }

  equals(other: unknown): boolean {
    return other instanceof ParameterData && other.name === this.name && other.description === this.description
      && (this.type instanceof NativeData ? this.type.equals(other.type) : other.type === this.type);
  }
}

class ParameterBuilder extends Builder<ParameterData> {
  protected make(fields: Record<string, unknown>): ParameterData {
    return new ParameterData(fields as ConstructorParameters<typeof ParameterData>[0]);
  }

  name(name: string): ParameterBuilder {
    this.state["name"] = name;
    return this;
  }

  of(spec: OfAny.Spec): ParameterBuilder {
    this.state["type"] = OfAny.resolve(spec);
    return this;
  }
}

function isParameterData(value: unknown): value is ParameterData {
  return value instanceof ParameterData;
}

export namespace OfParameter {
  /** The meta-schema of a parameter: a named member's. */
  export let Schema: ObjectData;
  export const Data = ParameterData;
  export type Data = ParameterData;
  export const Builder = ParameterBuilder;
  export type Builder = ParameterBuilder;
  export type Spec = ParameterData | ((builder: ParameterBuilder) => ParameterBuilder);
}

function parameterProblems(parameters: ReadonlyMap<string, ParameterData>): string[] {
  const problems = reserved([...parameters.keys()]);
  for (const [name, parameter] of parameters) {
    const typed = parameter.type === null ? [] : validateSchema(parameter.type);
    problems.push(...[...typed, ...descriptionProblems(parameter.description)].map((p) => `parameter ${repr(name)}: ${p}`));
  }
  return problems;
}

/** Parameters equal as Python's dict equality finds them: the same names, each parameter equal. */
function sameParameters(a: ReadonlyMap<string, ParameterData>, b: ReadonlyMap<string, ParameterData>): boolean {
  return a.size === b.size && [...a].every(([name, parameter]) => parameter.equals(b.get(name)));
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

/** The widths a native may have, in bits or in bytes (each a bigint or a term), its name, description and parameters. */
export interface Widths {
  bits?: unknown;
  bytes?: unknown;
  name?: string | null;
  description?: string | null;
  parameters?: Map<string, ParameterData>;
}

/** A native type: a token, and optionally a width in bits or in bytes, an int or a term. A host type given in place of
 * the token (`new OfNative.Data(BigInt)`) is shorthand for the `basic` token of the same name. */
class NativeData extends Reflected {
  token: unknown;
  bits: unknown;
  bytes: unknown;
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(token: unknown = null, widths: Widths = {}) {
    super();
    this.token = NATIVE_NAMES.has(token) ? new TokenClass(BASIC, NATIVE_NAMES.get(token) as string) : token;
    this.bits = widths.bits ?? null;
    this.bytes = widths.bytes ?? null;
    this.name = widths.name ?? null;
    this.description = widths.description ?? null;
    this.parameters = widths.parameters ?? new Map();
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
    return other instanceof NativeData && sameValue(this.bits, other.bits) && sameValue(this.bytes, other.bytes)
      && other.name === this.name && other.description === this.description && sameParameters(this.parameters, other.parameters)
      && (this.token instanceof TokenClass ? this.token.equals(other.token) : other.token === this.token);
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters)];
    const token = this.token;
    if (!(token instanceof TokenClass)) problems.push(`unsupported native type ${repr(token)}`);
    else if (typeof token.format !== "string" || token.format === "" || typeof token.name !== "string" || token.name === "") {
      problems.push("a token needs a format and a name");
    } else if (token.format === BASIC && this.type === null) problems.push(`basic has no type ${repr(token.name)}`);
    for (const [unit, width] of [["bits", this.bits], ["bytes", this.bytes]] as const) {
      if (isTerm(width)) problems.push(...termProblems(width, `a width in ${unit}`));
      else if (width !== null && (typeof width !== "bigint" || width < 1n)) {
        problems.push(`a width in ${unit} must be a positive int or a term, got ${repr(width)}`);
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

class NativeBuilder extends NamedBuilder<NativeData> {
  protected make(fields: Record<string, unknown>): NativeData {
    return new NativeData(fields["token"] ?? null, { bits: fields["bits"], bytes: fields["bytes"],
      name: fields["name"] as string | null, description: fields["description"] as string | null,
      parameters: fields["parameters"] as Map<string, ParameterData> | undefined });
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

  /** A width in bits: a bigint, or a term. */
  bits(width: unknown): NativeBuilder {
    this.state["bits"] = width;
    return this;
  }

  bytes(width: unknown): NativeBuilder {
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

// --- OfProperty: a named property of an object or relation ---

class PropertyData {
  name: string;
  type: AnyData | null;
  description: string | null;

  constructor(fields: { name?: string; type?: AnyData | null; description?: string | null } = {}) {
    this.name = fields.name ?? "";
    this.type = fields.type ?? null;
    this.description = fields.description ?? null;
  }


  equals(other: unknown): boolean {
    return other === this;
  }
}

class PropertyBuilder extends Builder<PropertyData> {
  protected make(fields: Record<string, unknown>): PropertyData {
    return new PropertyData(fields as ConstructorParameters<typeof PropertyData>[0]);
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
  const properties = (state["properties"] ??= new Map()) as Map<string, PropertyData>;
  for (const spec of specs) {
    const prop = resolveSpec(spec, isPropertyData, () => new PropertyBuilder());
    properties.set(prop.name, prop);
  }
}

// --- OfRelation ---

class RelationData extends Reflected {
  links: readonly string[];
  properties: Map<string, PropertyData>;
  uniques: readonly ReadonlySet<string>[];
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(fields: { links?: readonly string[]; properties?: Map<string, PropertyData>; uniques?: readonly ReadonlySet<string>[];
    name?: string | null; description?: string | null; parameters?: Map<string, ParameterData> } = {}) {
    super();
    this.links = fields.links ?? [];
    this.properties = fields.properties ?? new Map();
    this.uniques = fields.uniques ?? [];
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
  }


  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description),
      ...parameterProblems(this.parameters), ...reserved([...this.links, ...this.properties.keys()])];
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
      problems.push(...[...validateSchema(prop.type), ...embeddedProblems(prop.type), ...entryValueProblems(prop.type),
        ...descriptionProblems(prop.description)].map((p) => `property ${repr(name)}: ${p}`));
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

class RelationBuilder extends NamedBuilder<RelationData> {
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

class AdjacencyData {
  name: string;
  relation: RelationData | null;
  me: string;
  description: string | null;

  constructor(fields: { name?: string; relation?: RelationData | null; me?: string; description?: string | null } = {}) {
    this.name = fields.name ?? "";
    this.relation = fields.relation ?? null;
    this.me = fields.me ?? "";
    this.description = fields.description ?? null;
  }


  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems = descriptionProblems(this.description, `adjacency ${repr(this.name)}: `);
    if (problems.length > 0) return problems;
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

class ObjectData extends Reflected {
  properties: Map<string, PropertyData>;
  adjacencies: Map<string, AdjacencyData>;
  singleton: string | null;
  /** A reference object schema; otherwise a value object schema. */
  ref: boolean;
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(fields: { properties?: Map<string, PropertyData>; adjacencies?: Map<string, AdjacencyData>; singleton?: string | null;
    ref?: boolean; name?: string | null; description?: string | null; parameters?: Map<string, ParameterData> } = {}) {
    super();
    this.properties = fields.properties ?? new Map();
    this.adjacencies = fields.adjacencies ?? new Map();
    this.singleton = fields.singleton ?? null;
    this.ref = fields.ref ?? false;
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
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
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description),
      ...parameterProblems(this.parameters), ...reserved([...this.properties.keys(), ...this.adjacencies.keys()])];
    if (this.singleton !== null && !this.ref) problems.push("a singleton's schema must be a reference object schema");
    const clashes = [...this.properties.keys()].filter((name) => this.adjacencies.has(name));
    if (clashes.length > 0) {
      problems.push(`names used as both property and adjacency: ${repr(sortedStrings(clashes))}`);
    }
    for (const [name, prop] of this.properties) {
      problems.push(...[...validateSchema(prop.type), ...embeddedProblems(prop.type), ...descriptionProblems(prop.description)]
        .map((p) => `property ${repr(name)}: ${p}`));
    }
    for (const adjacency of this.adjacencies.values()) problems.push(...adjacency.validate());
    return problems;
  }
}

class ObjectBuilder extends NamedBuilder<ObjectData> {
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
class MemberData {
  name: string;
  type: AnyData | null;
  description: string | null;

  constructor(fields: { name?: string; type?: AnyData | null; description?: string | null } = {}) {
    this.name = fields.name ?? "";
    this.type = fields.type ?? null;
    this.description = fields.description ?? null;
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
  const problems = reserved(members.map((m) => m.name));
  if (members.length < 2) problems.push(`${aKind} needs at least two ${plural}`);
  if (new Set(members.map((m) => kindOf(structure(m.type)))).size > 1) problems.push(`${kind} ${plural} must all be the same kind`);
  const seen = new Set<string>();
  members.forEach((m, i) => {
    if (typeof m.name !== "string" || m.name === "") problems.push(`${member} ${i} has no name`);
    else if (seen.has(m.name)) problems.push(`${member} name ${repr(m.name)} is used more than once`);
    seen.add(m.name);
    problems.push(...descriptionProblems(m.description, `${member} ${repr(m.name)}: `));
  });
  return problems;
}

/** What tells a value of `schema` apart at run time: a native's host type, a list or a keyed list (whose items' types
 * a value does not carry), or any other schema itself. */
export function _runtime(schema: unknown): unknown {
  const found = structure(schema);
  if (found instanceof NativeData) {
    const token = found.token as { format?: unknown; name?: unknown };
    return found.type ?? `token ${String(token.format)}:${String(token.name)}`;
  }
  if (found instanceof IndexedData) return found.positional ? "list" : "map";
  return found;
}

/** A flat union's branches are told apart by their values' types. */
function flatUnionProblems(branches: readonly MemberData[]): string[] {
  const problems: string[] = [];
  const seen = new Map<unknown, string>();
  for (const branch of branches) {
    const key = _runtime(branch.type);
    if (seen.has(key)) problems.push(`flat union: branches ${repr(seen.get(key))} and ${repr(branch.name)} are not told apart by type`);
    else seen.set(key, branch.name);
  }
  return problems;
}

/** A flat intersection's parts are object schemas whose properties have distinct names: its own properties. */
function flatIntersectionProblems(parts: readonly MemberData[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const part of parts) {
    const schema = structure(part.type);
    if (!(schema instanceof ObjectData)) {
      problems.push(`flat intersection: part ${repr(part.name)} is not an object schema`);
      continue;
    }
    for (const named of schema.properties.keys()) {
      if (seen.has(named)) problems.push(`flat intersection: parts ${repr(seen.get(named))} and ${repr(part.name)} both declare ${repr(named)}`);
      else seen.set(named, part.name);
    }
  }
  return problems;
}

function members(specs: readonly ((builder: MemberBuilder) => MemberBuilder)[]): MemberData[] {
  return specs.map((spec) => resolveSpec(spec, isMemberData, () => new MemberBuilder()));
}

function byName(members: readonly MemberData[]): Map<string, MemberData> {
  return new Map(members.map((m) => [m.name, m]));
}

class UnionData extends Reflected {
  branches: readonly MemberData[];
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;
  /** Whether a value reads as its branch's value, told apart by type, rather than as an object of one branch. */
  flat: boolean;

  constructor(fields: { branches?: readonly MemberData[]; name?: string | null; description?: string | null;
    parameters?: Map<string, ParameterData>; flat?: boolean } = {}) {
    super();
    this.branches = fields.branches ?? [];
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
    this.flat = fields.flat ?? false;
  }

  /** The branches by name: a union value is an object holding exactly one of them. */
  get properties(): Map<string, MemberData> {
    return byName(this.branches);
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    return [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters),
      ...memberProblems("a union", "branch", "branches", this.branches), ...(this.flat ? flatUnionProblems(this.branches) : [])];
  }
}

class UnionBuilder extends NamedBuilder<UnionData> {
  protected make(fields: Record<string, unknown>): UnionData {
    return new UnionData(fields as ConstructorParameters<typeof UnionData>[0]);
  }

  /** Named branches, e.g. `.branches((b) => b.name("phone").of(Phone), ...)`. */
  branches(...specs: ((builder: MemberBuilder) => MemberBuilder)[]): UnionBuilder {
    this.state["branches"] = [...((this.state["branches"] as MemberData[] | undefined) ?? []), ...members(specs)];
    return this;
  }

  /** A value reads as its branch's value, told apart by type (`Phone | Email`), not as an object of one branch. */
  flat(flat = true): UnionBuilder {
    this.state["flat"] = flat;
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

class IntersectionData extends Reflected {
  parts: readonly MemberData[];
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;
  /** Whether a value reads its parts' properties as its own, rather than as an object of its parts. */
  flat: boolean;

  constructor(fields: { parts?: readonly MemberData[]; name?: string | null; description?: string | null;
    parameters?: Map<string, ParameterData>; flat?: boolean } = {}) {
    super();
    this.parts = fields.parts ?? [];
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
    this.flat = fields.flat ?? false;
  }

  /** The parts by name: an intersection value is an object holding every one of them. */
  get properties(): Map<string, MemberData> {
    return byName(this.parts);
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    return [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters),
      ...memberProblems("an intersection", "part", "parts", this.parts), ...(this.flat ? flatIntersectionProblems(this.parts) : [])];
  }
}

class IntersectionBuilder extends NamedBuilder<IntersectionData> {
  protected make(fields: Record<string, unknown>): IntersectionData {
    return new IntersectionData(fields as ConstructorParameters<typeof IntersectionData>[0]);
  }

  /** Named parts, e.g. `.parts((p) => p.name("stamp").of(Stamp), ...)`. */
  parts(...specs: ((builder: MemberBuilder) => MemberBuilder)[]): IntersectionBuilder {
    this.state["parts"] = [...((this.state["parts"] as MemberData[] | undefined) ?? []), ...members(specs)];
    return this;
  }

  /** A value reads its parts' properties as its own (`x.name`), not as an object of its parts (`x.Named.name`). */
  flat(flat = true): IntersectionBuilder {
    this.state["flat"] = flat;
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

/** The keys a positional list may have: `minimum` to `maximum`, inclusive; `maximum` null for no bound. Either may be a
 * term instead of a bigint. */
class ExtentClass {
  readonly minimum: unknown;
  readonly maximum: unknown;

  constructor(minimum: unknown = 0n, maximum: unknown = null) {
    this.minimum = minimum;
    this.maximum = maximum;
  }

  equals(other: unknown): boolean {
    return other instanceof ExtentClass && sameValue(this.minimum, other.minimum) && sameValue(this.maximum, other.maximum);
  }
}

/** A list: items of the item schema, in order. Without a key schema, or with a native `int` one, it is positional: its
 * keys are its positions, from its extent's minimum. With any other key schema it is keyed: its items are held by
 * unique keys of that schema, in insertion order. */
class IndexedData extends Reflected {
  item: AnyData | null;
  key: AnyData | null;
  extent: ExtentClass | null;
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(fields: { item?: AnyData | null; key?: AnyData | null; extent?: ExtentClass | null; name?: string | null;
    description?: string | null; parameters?: Map<string, ParameterData> } = {}) {
    super();
    this.item = fields.item ?? null;
    this.key = fields.key ?? null;
    this.extent = fields.extent ?? null;
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
  }

  get positional(): boolean {
    const key = structure(this.key);
    return key === null || (key instanceof NativeData && key.type === BigInt);
  }

  /** The first key of a positional list: its extent's minimum, or 0 (also where the minimum is a term). */
  get minimum(): bigint {
    return this.extent !== null && typeof this.extent.minimum === "bigint" ? this.extent.minimum : 0n;
  }

  /** How many items a positional list's extent holds, or null when it has no valid int bounds. */
  get capacity(): bigint | null {
    const extent = this.extent;
    if (extent === null || typeof extent.maximum !== "bigint" || typeof extent.minimum !== "bigint") return null;
    return extent.maximum - extent.minimum + 1n;
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters),
      ...validateSchema(this.item).map((problem) => `item: ${problem}`)];
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
    problems.push(...termProblems(extent.minimum, "an extent's minimum"), ...termProblems(extent.maximum, "an extent's maximum"));
    if (!(typeof extent.minimum === "bigint" || isTerm(extent.minimum))
      || !(extent.maximum === null || typeof extent.maximum === "bigint" || isTerm(extent.maximum))) {
      problems.push(`an extent's minimum and maximum are ints or terms, got ${repr(extent.minimum)} and ${repr(extent.maximum)}`);
    } else if (typeof extent.minimum === "bigint" && typeof extent.maximum === "bigint" && extent.minimum > extent.maximum) {
      problems.push(`an extent's minimum ${extent.minimum} exceeds its maximum ${extent.maximum}`);
    }
    return problems;
  }
}

class IndexedBuilder extends NamedBuilder<IndexedData> {
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

  /** The keys a positional list may have, `minimum` to `maximum`, each a bigint or a term. */
  extent(bounds: { minimum?: unknown; maximum?: unknown } = {}): IndexedBuilder {
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

// --- OfApply: a parametric schema applied to arguments ---

/** A parametric schema applied to arguments: a type whose values are the applied schema's (`of`), with arguments for
 * its parameters by name, each a native value or a term. Parameters given no argument stay unbound. */
class ApplyData extends Reflected {
  of: AnyData | null;
  arguments: Map<string, unknown>;
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(fields: { of?: AnyData | null; arguments?: Map<string, unknown>; name?: string | null; description?: string | null;
    parameters?: Map<string, ParameterData> } = {}) {
    super();
    this.of = fields.of ?? null;
    this.arguments = fields.arguments ?? new Map();
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters)];
    if (!isAnyData(this.of)) return [...problems, `an application applies a schema, got ${repr(this.of)}`];
    if (structure(this) === null) return [...problems, "an application cannot apply itself"];
    for (const [name, value] of this.arguments) {
      const parameter = this.of.parameters.get(name);
      if (parameter === undefined) problems.push(`the applied schema has no parameter ${repr(name)}`);
      else problems.push(...argumentProblems(parameter, value).map((p) => `argument ${repr(name)}: ${p}`));
    }
    return [...problems, ...validateSchema(this.of).map((problem) => `of: ${problem}`)];
  }
}

/** An argument is a term, or a native value, of the parameter's type where that is a native type. */
function argumentProblems(parameter: ParameterData, value: unknown): string[] {
  if (isTerm(value)) return termProblems(value, "a term");
  if (!isNative(value)) return [`an argument is a native value or a term, got ${repr(value)}`];
  const host = parameter.type instanceof NativeData ? parameter.type.type : null;
  return host !== null && !isNativeOf(host, value) ? [`expected ${tokenName(host)}, got ${typeName(value)}`] : [];
}

/** The schema that gives a type its structure: an application's applied schema (followed through applications), else
 * the schema itself; null for an application that applies itself. Data of an application is data of its applied
 * schema. */
export function structure<T>(schema: T): T | AnyData | null {
  const seen = new Set<unknown>();
  let current: unknown = schema;
  while (current instanceof ApplyData) {
    if (seen.has(current)) return null;
    seen.add(current);
    current = current.of;
  }
  return current as T | AnyData | null;
}

/** An evaluator the caller gives: the value of a term with parameters' values by name (`evaluate(term, scope)`), or
 * null (or undefined) where it is unknown, e.g. a parameter it refers to has no value. This package evaluates nothing
 * itself. */
export type Evaluate = (term: unknown, scope: ReadonlyMap<string, unknown>) => unknown;

const UNKNOWN = Symbol("unknown");

/** The schema a type applies, followed through applications, and the values its parameters take: each application's
 * arguments, evaluated with the values the application around it gives its own parameters (an unknown one as
 * `UNKNOWN`). A parameter given no argument is left out. */
function applied(schema: unknown, evaluate: Evaluate | null): [unknown, Map<string, unknown>] {
  let values = new Map<string, unknown>();
  const seen = new Set<unknown>();
  let current = schema;
  while (current instanceof ApplyData && !seen.has(current)) {
    seen.add(current);
    const scope = new Map([...values].filter(([, value]) => value !== UNKNOWN));
    values = new Map([...current.arguments].map(([name, value]) => [name, evaluated(value, scope, evaluate)]));
    current = current.of;
  }
  return [current, values];
}

/** An argument's value: a native as it is, a term's as `evaluate` gives it, or `UNKNOWN`. */
function evaluated(value: unknown, scope: ReadonlyMap<string, unknown>, evaluate: Evaluate | null): unknown {
  if (!isTerm(value)) return value;
  return (evaluate === null ? null : evaluate(value, scope)) ?? UNKNOWN;
}

/** Whether two types are the same after substitution: they apply the same schema (natives by value, other schemas by
 * identity), and give its parameters the same values, a parameter unbound in both alike. `Square(4)` and
 * `Matrix(4, 4)` are, where `Square[n]` applies `Matrix(n, n)`. null when that depends on a value that is unknown: a
 * term with no evaluator, or one `evaluate` cannot evaluate. */
export function equivalent(a: unknown, b: unknown, evaluate: Evaluate | null = null): boolean | null {
  const [[base, values], [other, others]] = [applied(a, evaluate), applied(b, evaluate)];
  const same = base instanceof NativeData ? base.equals(other) : base === other;
  if (!same || values.size !== others.size || [...values.keys()].some((name) => !others.has(name))) return false;
  const pairs = [...values].map(([name, value]) => [value, others.get(name)]);
  if (pairs.some(([x, y]) => x !== UNKNOWN && y !== UNKNOWN && !sameNative(x, y))) return false;
  return pairs.some((pair) => pair.includes(UNKNOWN)) ? null : true;
}

class ApplyBuilder extends NamedBuilder<ApplyData> {
  protected make(fields: Record<string, unknown>): ApplyData {
    return new ApplyData(fields as ConstructorParameters<typeof ApplyData>[0]);
  }

  /** The parametric schema applied. */
  of(spec: OfAny.Spec): ApplyBuilder {
    this.state["of"] = OfAny.resolve(spec);
    return this;
  }

  /** The argument for the parameter `name`: a native value or a term. */
  argument(name: string, value: unknown): ApplyBuilder {
    ((this.state["arguments"] ??= new Map()) as Map<string, unknown>).set(name, value);
    return this;
  }

  /** Arguments for the applied schema's parameters, in their declared order. */
  arguments(...values: unknown[]): ApplyBuilder {
    const of = this.state["of"] as AnyData | undefined;
    if (of === undefined) {
      throw new ValueError("positional arguments are taken in the applied schema's parameter order; call .of() first");
    }
    const names = [...of.parameters.keys()];
    if (values.length > names.length) {
      throw new ValueError(`the applied schema has ${names.length} parameters, got ${values.length} arguments`);
    }
    values.forEach((value, i) => this.argument(names[i] as string, value));
    return this;
  }
}

function isApplyData(value: unknown): value is ApplyData {
  return value instanceof ApplyData;
}

export namespace OfApply {
  /** The meta-schema of applications. */
  export let Schema: ObjectData;
  /** The meta-schema of an argument: its parameter's `name`, and its native `value` or its `term`. */
  export let Argument: ObjectData;
  /** A parametric schema applied to arguments, where a type is expected. */
  export const Data = ApplyData;
  export type Data = ApplyData;
  export const Builder = ApplyBuilder;
  export type Builder = ApplyBuilder;
  export type Spec = ApplyData | ((builder: ApplyBuilder) => ApplyBuilder);

  export function resolve(spec: Spec | unknown): ApplyData {
    return resolveSpec(spec, isApplyData, () => new ApplyBuilder());
  }
}

// --- OfAny ---

type AnyData = NativeData | ObjectData | UnionData | IntersectionData | IndexedData | ApplyData;

function isAnyData(value: unknown): value is AnyData {
  return value instanceof NativeData || value instanceof ObjectData || value instanceof UnionData ||
    value instanceof IntersectionData || value instanceof IndexedData || value instanceof ApplyData;
}

function kindOf(value: unknown): unknown {
  return value === null || value === undefined ? null : (value as object).constructor;
}

function validateSchema(schema: unknown): string[] {
  if (!isAnyData(schema)) return [`not a schema: ${repr(schema)}`];
  return schema.validate();
}

/** The schemas of the values a value of `schema` holds: a value object's properties, a union's branches, an
 * intersection's parts, a list's item, through applications. */
function membersOf(type: unknown): unknown[] {
  const schema = structure(type);
  if (schema instanceof IndexedData) return [schema.item];
  return schema instanceof ObjectData || schema instanceof UnionData || schema instanceof IntersectionData
    ? [...schema.properties.values()].map((member) => member.type) : [];
}

/** Problems with a property's schema as a value (or a key's, `role`): an object held by a property is a value object,
 * so its schema is not a reference object schema; nor are the schemas of the objects a union, an intersection or a list
 * holds. `seen` holds the schemas on the way, so that one that holds itself is checked once. */
function embeddedProblems(type: unknown, seen: ReadonlySet<unknown> = new Set(), role = "a property's type"): string[] {
  const schema = structure(type);
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

  as_apply(spec: OfApply.Spec): AnyBuilder {
    this.selected = OfApply.resolve(spec);
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
const Int = (t: AnyBuilder) => t.as_native(BigInt);
const NamedSchema = new ObjectBuilder().properties(namedText("name")).create();
const AnySchema = new UnionBuilder().create(); // a type; its branches, which refer back to it, are added below
const PropertySchema = new ObjectBuilder().properties(namedText("name"), (p) => p.name("type").of(AnySchema),
  namedText("description")).create();
const Parameters = (p: PropertyBuilder) => p.name("parameters").of(listOf(PropertySchema));
const NativeValue = new UnionBuilder().branches(
  ...NATIVE_TYPES.map((host) => (b: MemberBuilder) => b.name(tokenName(host)).of((x) => x.as_native(host)))).create();
const AttributeSchema = new ObjectBuilder().properties(namedText("name"), (p) => p.name("value").of(NativeValue)).create();
const FormSchema = new ObjectBuilder().properties(
  namedText("dialect"), namedText("kind"), (p) => p.name("attributes").of(listOf(AttributeSchema))).create();
new ObjectBuilder(FormSchema).properties((p) => p.name("arguments").of(listOf(FormSchema))).update();
const WidthTerms = new ObjectBuilder().properties((p) => p.name("bits").of(FormSchema), (p) => p.name("bytes").of(FormSchema))
  .create();
const NativeSchema = new ObjectBuilder().name("Schemas.Native").properties(
  namedText("name"), Parameters, namedText("format"), namedText("token"), (p) => p.name("bits").of(Int), (p) => p.name("bytes").of(Int),
  (p) => p.name("terms").of(WidthTerms), namedText("description")).create();
const RelationSchema = new ObjectBuilder().name("Schemas.Relation").properties(
  namedText("name"), Parameters, (p) => p.name("links").of(listOf(Text)), (p) => p.name("properties").of(listOf(PropertySchema)),
  (p) => p.name("uniques").of(listOf(listOf(Text))), namedText("description")).create();
const RelationRef = new UnionBuilder().branches((b) => b.name("relation").of(RelationSchema),
  (b) => b.name("named").of(NamedSchema)).create();
const AdjacencySchema = new ObjectBuilder().properties(
  namedText("name"), (p) => p.name("relation").of(RelationRef), namedText("me"), namedText("description")).create();
const ObjectSchema = new ObjectBuilder().name("Schemas.Object").properties(
  namedText("name"), Parameters, (p) => p.name("properties").of(listOf(PropertySchema)), (p) => p.name("adjacencies").of(listOf(AdjacencySchema)),
  namedText("singleton"), (p) => p.name("ref").of((t) => t.as_native(Boolean)), namedText("description")).create();
const Flat = (p: PropertyBuilder) => p.name("flat").of((t) => t.as_native(Boolean));
const UnionSchema = new ObjectBuilder().name("Schemas.Union").properties(
  namedText("name"), Parameters, (p) => p.name("branches").of(listOf(PropertySchema)), Flat, namedText("description")).create();
const IntersectionSchema = new ObjectBuilder().name("Schemas.Intersection").properties(
  namedText("name"), Parameters, (p) => p.name("parts").of(listOf(PropertySchema)), Flat, namedText("description")).create();
const ExtentTerms = new ObjectBuilder().properties((p) => p.name("minimum").of(FormSchema),
  (p) => p.name("maximum").of(FormSchema)).create();
const ExtentSchema = new ObjectBuilder().properties((p) => p.name("minimum").of(Int), (p) => p.name("maximum").of(Int),
  (p) => p.name("terms").of(ExtentTerms)).create();
const IndexedSchema = new ObjectBuilder().name("Schemas.Indexed").properties(
  namedText("name"), Parameters, (p) => p.name("item").of(AnySchema), (p) => p.name("key").of(AnySchema),
  (p) => p.name("extent").of(ExtentSchema), namedText("description")).create();
const ArgumentSchema = new ObjectBuilder().properties(namedText("name"), (p) => p.name("value").of(NativeValue),
  (p) => p.name("term").of(FormSchema)).create();
const ApplySchema = new ObjectBuilder().name("Schemas.Apply").properties(
  namedText("name"), Parameters, (p) => p.name("of").of(AnySchema), (p) => p.name("arguments").of(listOf(ArgumentSchema)),
  namedText("description")).create();
const KIND_SCHEMAS: [string, ObjectData][] = [["native", NativeSchema], ["object", ObjectSchema], ["union", UnionSchema],
  ["intersection", IntersectionSchema], ["indexed", IndexedSchema], ["apply", ApplySchema]];
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
OfParameter.Schema = PropertySchema;
OfApply.Schema = ApplySchema;
OfApply.Argument = ArgumentSchema;
Form.Schema = FormSchema;
Form.Value = NativeValue;
OfAny.Schema = AnySchema;
OfAny.Named = NamedSchema;
const KIND_NAMES = new Map<unknown, string>([[NativeData, "Schemas.Native"], [ObjectData, "Schemas.Object"],
  [UnionData, "Schemas.Union"], [IntersectionData, "Schemas.Intersection"], [IndexedData, "Schemas.Indexed"],
  [ApplyData, "Schemas.Apply"], [RelationData, "Schemas.Relation"]]);

/** A named set of schemas, as data. `Module.Schema` is the reference object schema of a module: its `schemas` are a
 * list of `Module.Entry` value objects, each a `name` and a `schema`, a `Module.Definition` (a schema of any kind,
 * relations included). See `Modules` for the translation between schemas and modules. */
export namespace Module {
  export const Schema = new ObjectBuilder().name("Schemas.Module").ref()
    .properties((p) => p.name("schemas").of(listOf(EntrySchema))).create();
  export const Entry = EntrySchema;
  export const Definition = DefinitionSchema;
}
