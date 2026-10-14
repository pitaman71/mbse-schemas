/**
 * Schemas: schema elements and their builders.
 *
 * For each schema element `OfX`, `Schemas.OfX.Data` captures a schema and `Schemas.OfX.Builder` builds one. Builders
 * take an optional source instance, keep shallow copies of its data, are fluent, and are finalized by `create()`,
 * `clone()` or `update()`; none validate. Arguments describing a sub-structure are `Spec`s: a direct value, or a
 * callable that takes and returns the corresponding builder.
 *
 * `validate()` on each `Data` returns a list of problems and runs only when the caller asks. `equals()` stands in for
 * Python's `==`: by value for `OfScalar.Data`, by identity for the other kinds.
 *
 * Every kind of schema may have a `name`, set by its builder's `.name("crm.Contact")`: identifiers separated by dots,
 * the part before the last dot its namespace. A named schema is referred to by its name wherever it is written (a
 * module, a predicate's symbols), and a store registers it under that name; an unnamed one is written inline.
 *
 * Every kind of schema may declare `parameters` (`OfParameter`), variables determined where the schema is referred to:
 * `OfApply` applies a parametric schema to arguments. Where a literal width stands, a term may stand instead:
 * an expression term, such as mbse-expressions', or its neutral `Form`, which may refer to parameters.
 *
 * A predicate (`OfPredicate`) names its symbols (`OfSymbol`), each of a reference object schema, and requires a
 * constraint over them, a term; mbse-schemas knows no dialect, so a term is checked as a `Form` only. A relation holds the
 * schema of its entries (`OfEntry`): their links, each a symbol, and their properties.
 */

import { fromBase64, toBase64 } from "./Bytes.js";
import { DecodeError, ValueError } from "./Errors.js";
import type { PlainData } from "./Plain.js";
import { isClassLike, SCALAR_NAMES, repr, sortedStrings, tokenName, Tuple, typeName } from "./Repr.js";
import type { Scalar, ScalarToken } from "./Visitors.js";

/** Problems with names that start with `$`, which the wire format keeps for its own markers (`$ref`, `$schema`,
 * `$id`). */
function reserved(names: readonly unknown[]): string[] {
  return names.filter((name): name is string => typeof name === "string" && name.startsWith("$"))
    .map((name) => `name ${repr(name)} is reserved: names starting with '$' belong to the wire format`);
}

/** Problems with properties, adjacencies and links named `as_*`, which object and entry visitors keep for their own
 * methods, so that no name a schema defines collides with them in data instances and builders. */
function visited(names: readonly unknown[]): string[] {
  return names.filter((name): name is string => typeof name === "string" && name.startsWith("as_"))
    .map((name) => `name ${repr(name)} is reserved: names starting with 'as_' belong to the visitor protocol`);
}

export const SCALAR_TYPES: readonly ScalarToken[] = [BigInt, Number, String, Boolean, Uint8Array];

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

/** Resolves a `Spec`: data is used as is; a callable is given a new builder and must return it. */
function resolveSpec<D>(spec: unknown, isData: (value: unknown) => value is D, builder: () => { create(): unknown }): D {
  if (isData(spec)) return spec;
  if (isClassLike(spec)) {
    const name = (spec as { name: string }).name;
    throw new TypeError(`a class is not a Spec here; for a scalar type use t => t.as_scalar(${name})`);
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

/** A term's structure, in the neutral form mbse-expressions' terms give (`term.form()`): its `kind`, its scalar
 * `attributes` by name, its ordered `arguments`, each a form, and the `dialect` it is read in, given at its root. A form
 * is itself a term, which a module writes and reads back without knowing its dialect. */
class FormData {
  readonly kind: string;
  readonly attributes: ReadonlyMap<string, Scalar>;
  readonly arguments: readonly unknown[];
  readonly dialect: string | null;

  constructor(kind = "", attributes: ReadonlyMap<string, Scalar> | Record<string, Scalar> = new Map(),
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
      && [...this.attributes].every(([name, value]) => other.attributes.has(name) && sameScalar(value, other.attributes.get(name)))
      && other.arguments.length === this.arguments.length
      && this.arguments.every((argument, i) => sameValue(argument, other.arguments[i]));
  }

  validate(): string[] {
    const problems = typeof this.kind === "string" && this.kind !== "" ? [] : [`a term needs a kind, got ${repr(this.kind)}`];
    if (this.dialect !== null && typeof this.dialect !== "string") problems.push(`a term's dialect is a name, got ${repr(this.dialect)}`);
    for (const [name, value] of this.attributes) {
      if (!isScalar(value)) problems.push(`attribute ${repr(name)} is not a scalar value: ${repr(value)}`);
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
  form(): { kind: string; attributes: ReadonlyMap<string, Scalar>; arguments: readonly unknown[] };
  dialect(): { name(): string };
}

/** Whether `value` is a term: a form, or anything with a `form()` and a `dialect()`, as mbse-expressions' terms. */
function isTerm(value: unknown): boolean {
  if (value instanceof FormData) return true;
  const term = value as { form?: unknown; dialect?: unknown } | null | undefined;
  return term !== null && term !== undefined && typeof term === "object" && typeof term.form === "function"
    && typeof term.dialect === "function";
}

function isScalar(value: unknown): value is Scalar {
  return SCALAR_TYPES.some((token) => isScalarOf(token, value));
}

/** The host type of a scalar value, or null for a value that is not one. */
export function hostOf(value: unknown): ScalarToken | null {
  return SCALAR_TYPES.find((token) => isScalarOf(token, value)) ?? null;
}

/** Scalar values equal as Python's `==` finds them: the same type and value, bytes by content. */
function sameScalar(a: unknown, b: unknown): boolean {
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
  /** A scalar value, by its basic type's name: `{"int": 3}`. */
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
      && (this.type instanceof ScalarData ? this.type.equals(other.type) : other.type === this.type);
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

// --- OfScalar ---

const NON_FINITE: ReadonlyMap<string, number> = new Map([
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
]);

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** True when `value` has exactly the scalar type `token` (subclasses and boxed primitives are not the same type). */
export function isScalarOf(token: unknown, value: unknown): boolean {
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
export const PYTHON3 = "python3";
const OWN_TYPES: ReadonlyMap<string, ScalarToken> = new Map<string, ScalarToken>(
  SCALAR_TYPES.map((host) => [(host as { name: string }).name, host]));
const BASIC_TYPES: ReadonlyMap<string, ScalarToken> = new Map(SCALAR_TYPES.map((host) => [tokenName(host), host]));

/** A scalar type, named in a format: `basic`, the neutral vocabulary (`bool`, `int`, `float`, `str`, `bytes`), a
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

/** The widths a scalar may have, in bits or in bytes (each a bigint or a term), its name, description and parameters. */
export interface Widths {
  bits?: unknown;
  bytes?: unknown;
  name?: string | null;
  description?: string | null;
  parameters?: Map<string, ParameterData>;
  /** The scalar schema it refines. */
  refines?: unknown;
}

/** A scalar type: a token, and optionally a width in bits or in bytes, an int or a term. A host type given in place of
 * the token (`new OfScalar.Data(BigInt)`) is shorthand for the `basic` token of the same name. */
class ScalarData {
  token: unknown;
  bits: unknown;
  bytes: unknown;
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;
  /** The scalar schema it refines, or null. */
  refines: unknown;

  constructor(token: unknown = null, widths: Widths = {}) {
    this.token = SCALAR_NAMES.has(token) ? new TokenClass(BASIC, SCALAR_NAMES.get(token) as string) : token;
    this.bits = widths.bits ?? null;
    this.bytes = widths.bytes ?? null;
    this.name = widths.name ?? null;
    this.description = widths.description ?? null;
    this.parameters = widths.parameters ?? new Map();
    this.refines = widths.refines ?? null;
  }

  /** The host type the token maps to, or null when this implementation cannot read the token. */
  get type(): ScalarToken | null {
    if (!(this.token instanceof TokenClass)) return null;
    const hosts = this.token.format === BASIC ? BASIC_TYPES : this.token.format === TYPESCRIPT5 ? OWN_TYPES : null;
    return hosts?.get(this.token.name) ?? null;
  }

  /** The host type the token maps to; throws TypeError when this implementation cannot read the token. */
  host(): ScalarToken {
    const host = this.type;
    if (host === null) throw new TypeError(`${String(this.token)} has no type in this implementation`);
    return host;
  }

  equals(other: unknown): boolean {
    return other instanceof ScalarData && sameValue(this.bits, other.bits) && sameValue(this.bytes, other.bytes)
      && other.name === this.name && other.description === this.description && sameParameters(this.parameters, other.parameters)
      && other.refines === this.refines
      && sameToken(this.token, other.token);
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters)];
    const token = this.token;
    if (!(token instanceof TokenClass)) problems.push(`unsupported scalar type ${repr(token)}`);
    else if (typeof token.format !== "string" || token.format === "" || typeof token.name !== "string" || token.name === "") {
      problems.push("a token needs a format and a name");
    } else if ((token.format === BASIC && this.type === null) || (token.format === PYTHON3 && !BASIC_TYPES.has(token.name))) {
      problems.push(`${token.format} has no type ${repr(token.name)}`); // python3: the basic types, by Python's names
    }
    for (const [unit, width] of [["bits", this.bits], ["bytes", this.bytes]] as const) {
      if (isTerm(width)) problems.push(...termProblems(width, `a width in ${unit}`));
      else if (width !== null && (typeof width !== "bigint" || width < 1n)) {
        problems.push(`a width in ${unit} must be a positive int or a term, got ${repr(width)}`);
      }
    }
    if (this.bits !== null && this.bytes !== null) problems.push("a width is in bits or in bytes, not both");
    return [...problems, ...refinementProblems(this)];
  }

  /** Converts a scalar value to plain data that every text encoding can hold: `bytes` become base64 text, and
   * non-finite floats become the strings 'NaN', 'Infinity' and '-Infinity'. */
  to_plain(value: unknown): PlainData {
    const host = this.host();
    if (!isScalarOf(host, value)) throw new TypeError(`expected ${tokenName(host)}, got ${typeName(value)}`);
    if (value instanceof Uint8Array) return toBase64(value);
    if (typeof value === "number" && !Number.isFinite(value)) {
      return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
    }
    return value as PlainData;
  }

  /** The host type, or `DecodeError` when this implementation cannot read the token. */
  private hostForDecoding(): ScalarToken {
    if (this.type === null) throw new DecodeError(`${String(this.token)} has no type in this implementation`);
    return this.type;
  }

  /** Converts plain data back to a scalar value. Distinct scalar types are never coerced into each other.
   * Plain data that does not hold such a value, or a token this implementation cannot read, throws
   * `Errors.DecodeError`. */
  from_plain(plain: unknown): Scalar {
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
    if (!isScalarOf(host, plain)) throw new DecodeError(`expected ${tokenName(host)}, got ${typeName(plain)}`);
    return plain as Scalar;
  }
}

class ScalarBuilder extends NamedBuilder<ScalarData> {
  protected make(fields: Record<string, unknown>): ScalarData {
    return new ScalarData(fields["token"] ?? null, { bits: fields["bits"], bytes: fields["bytes"],
      name: fields["name"] as string | null, description: fields["description"] as string | null,
      parameters: fields["parameters"] as Map<string, ParameterData> | undefined, refines: fields["refines"] });
  }

  /** A host type: shorthand for the `basic` token of the same name. */
  type(scalar: unknown): ScalarBuilder {
    this.state["token"] = new ScalarData(scalar).token;
    return this;
  }

  /** A token in any format, e.g. `.token("ccpp", "int32_t")`. */
  token(format: string, name: string): ScalarBuilder {
    this.state["token"] = new TokenClass(format, name);
    return this;
  }

  /** A width in bits: a bigint, or a term. */
  bits(width: unknown): ScalarBuilder {
    this.state["bits"] = width;
    return this;
  }

  bytes(width: unknown): ScalarBuilder {
    this.state["bytes"] = width;
    return this;
  }

  /** The scalar schema this one refines (a Spec): its values are the refined schema's, of its token, which it takes
   * unless one is given, narrowed by its own widths. */
  refines(spec: OfAny.Spec): ScalarBuilder {
    const base = OfAny.resolve(spec);
    this.state["refines"] = base;
    const held = structure(base);
    if ((this.state["token"] ?? null) === null && held instanceof ScalarData) this.state["token"] = held.token;
    return this;
  }
}

function isScalarData(value: unknown): value is ScalarData {
  return value instanceof ScalarData;
}

export namespace OfScalar {
  /** The meta-schema of scalar schemas: a token's `format` and `name`, and a width in `bits` or `bytes`. */
  export let Schema: ObjectData;
  /** A scalar value. Conversion to and from the wire format is the responsibility of this element. */
  export const Data = ScalarData;
  export type Data = ScalarData;
  export const Builder = ScalarBuilder;
  export type Builder = ScalarBuilder;
  export const Token = TokenClass;
  export type Token = TokenClass;
  export type Spec = ScalarToken | ScalarData | ((builder: ScalarBuilder) => ScalarBuilder);

  export function resolve(spec: (builder: ScalarBuilder) => ScalarBuilder): ScalarData;
  export function resolve(spec: Spec | unknown): ScalarData;
  export function resolve(spec: Spec | unknown): ScalarData {
    if (isClassLike(spec) || SCALAR_NAMES.has(spec)) return new ScalarData(spec);
    return resolveSpec(spec, isScalarData, () => new ScalarBuilder());
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

// --- OfSymbol: a name standing for an object ---

/** A name standing for an object: a predicate's symbol, which a match binds, or an entry's link. Its schema is a
 * reference object schema, which a predicate's symbols require and an entry's links may leave unset (null). */
class SymbolData {
  name: string;
  type: AnyData | null;
  description: string | null;

  constructor(fields: { name?: string; type?: AnyData | null; description?: string | null } = {}) {
    this.name = fields.name ?? "";
    this.type = fields.type ?? null;
    this.description = fields.description ?? null;
  }
}

class SymbolBuilder extends Builder<SymbolData> {
  protected make(fields: Record<string, unknown>): SymbolData {
    return new SymbolData(fields as ConstructorParameters<typeof SymbolData>[0]);
  }

  name(name: string): SymbolBuilder {
    this.state["name"] = name;
    return this;
  }

  /** The schema of the objects the symbol stands for: a reference object schema. */
  of(spec: OfAny.Spec): SymbolBuilder {
    this.state["type"] = OfAny.resolve(spec);
    return this;
  }
}

function isSymbolData(value: unknown): value is SymbolData {
  return value instanceof SymbolData;
}

export namespace OfSymbol {
  /** The meta-schema of a symbol: a named member's. */
  export let Schema: ObjectData;
  export const Data = SymbolData;
  export type Data = SymbolData;
  export const Builder = SymbolBuilder;
  export type Builder = SymbolBuilder;
  export type Spec = SymbolData | ((builder: SymbolBuilder) => SymbolBuilder);
}

/** A symbol's schema, when it has one, is a reference object schema. */
function symbolProblems(symbol: SymbolData): string[] {
  if (symbol.type === null) return descriptionProblems(symbol.description);
  const problems = validateSchema(symbol.type);
  const target = structure(symbol.type);
  if (!(target instanceof ObjectData && target.ref)) {
    problems.push("a symbol stands for a reference object, so its schema is a reference object schema");
  }
  return [...problems, ...descriptionProblems(symbol.description)];
}

// --- OfEntry: the schema of a relation's entries ---

/** The schema of a relation's entries: their links, each a symbol, and their properties, both by name in declaration
 * order. A relation holds it (`OfRelation.Data.entry`). */
class EntryData {
  links: Map<string, SymbolData>;
  properties: Map<string, PropertyData>;

  constructor(fields: { links?: Map<string, SymbolData>; properties?: Map<string, PropertyData> } = {}) {
    this.links = fields.links ?? new Map();
    this.properties = fields.properties ?? new Map();
  }

  validate(): string[] {
    const names = [...this.links.keys(), ...this.properties.keys()];
    const problems = [...reserved(names), ...visited(names)];
    if (this.links.size < 2) {
      problems.push(`a relation has two links or more, got ${this.links.size}; a list of values is a container`);
    }
    const clashes = [...this.links.keys()].filter((link) => this.properties.has(link));
    if (clashes.length > 0) problems.push(`names used as both link and property: ${repr(sortedStrings(new Set(clashes)))}`);
    for (const [name, link] of this.links) problems.push(...symbolProblems(link).map((p) => `link ${repr(name)}: ${p}`));
    for (const [name, prop] of this.properties) {
      problems.push(...[...validateSchema(prop.type), ...embeddedProblems(prop.type), ...descriptionProblems(prop.description)]
        .map((p) => `property ${repr(name)}: ${p}`));
    }
    return problems;
  }
}

class EntryBuilder extends Builder<EntryData> {
  protected make(fields: Record<string, unknown>): EntryData {
    return new EntryData(fields as ConstructorParameters<typeof EntryData>[0]);
  }

  /** The links, in order, e.g. `.links((s) => s.name("owner"))`. */
  links(...specs: OfSymbol.Spec[]): EntryBuilder {
    const links = (this.state["links"] ??= new Map()) as Map<string, SymbolData>;
    for (const spec of specs) {
      const link = resolveSpec(spec, isSymbolData, () => new SymbolBuilder());
      links.set(link.name, link);
    }
    return this;
  }

  properties(...specs: OfProperty.Spec[]): EntryBuilder {
    addProperties(this.state, specs);
    return this;
  }
}

function isEntryData(value: unknown): value is EntryData {
  return value instanceof EntryData;
}

export namespace OfEntry {
  /** The meta-schema of an entry's schema. */
  export let Schema: ObjectData;
  /** The schema of a relation's entries: their links and properties. */
  export const Data = EntryData;
  export type Data = EntryData;
  export const Builder = EntryBuilder;
  export type Builder = EntryBuilder;
  export type Spec = EntryData | ((builder: EntryBuilder) => EntryBuilder);

  export function resolve(spec: Spec | unknown): EntryData {
    return resolveSpec(spec, isEntryData, () => new EntryBuilder());
  }
}

// --- OfRelation ---

class RelationData {
  entry: EntryData;
  uniques: readonly ReadonlySet<string>[];
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(fields: { entry?: EntryData; uniques?: readonly ReadonlySet<string>[]; name?: string | null;
    description?: string | null; parameters?: Map<string, ParameterData> } = {}) {
    this.entry = fields.entry ?? new EntryData();
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
      ...parameterProblems(this.parameters), ...this.entry.validate()];
    for (const unique of this.uniques) {
      const unknown = [...unique].filter((name) => !this.entry.links.has(name) && !this.entry.properties.has(name));
      if (unknown.length > 0) {
        problems.push(`unique(${sortedStrings(unique).join(", ")}) names unknown links or properties ${repr(sortedStrings(unknown))}`);
      }
    }
    return problems;
  }

  /** Whether the relation is open: it has no `unique` clause, so from each end its entries are a list, in the order
   * added, equal entries kept; with one, they are a set. */
  get open(): boolean {
    return this.uniques.length === 0;
  }

  /** The keys of the entries seen from the link `me`, one per `unique(S)` clause in declaration order whose complement
   * holds `me` and something else: that complement less `me`, in declaration order. `unique(S)` makes the links and
   * properties outside `S` determine `S`, so from `me`'s end each key picks out one entry. */
  keys(me: string): string[][] {
    const names = [...this.entry.links.keys(), ...this.entry.properties.keys()];
    return this.uniques.map((unique) => names.filter((name) => !unique.has(name)))
      .filter((rest) => rest.includes(me) && rest.length > 1).map((rest) => rest.filter((name) => name !== me));
  }

  /** The first of `keys(me)`, which an adjacency from `me` is indexed by (`at`); null when there is none. */
  key(me: string): string[] | null {
    return this.keys(me)[0] ?? null;
  }
}

class RelationBuilder extends NamedBuilder<RelationData> {
  protected make(fields: Record<string, unknown>): RelationData {
    return new RelationData(fields as ConstructorParameters<typeof RelationData>[0]);
  }

  /** The schema of the relation's entries: their links and properties. */
  entry(spec: OfEntry.Spec): RelationBuilder {
    this.state["entry"] = OfEntry.resolve(spec);
    return this;
  }

  /** The entry schema's links, by name, in place of any before: symbols without a schema. */
  links(...names: string[]): RelationBuilder {
    const entry = this.state["entry"] as EntryData | undefined;
    this.state["entry"] = new EntryBuilder().links(...names.map((n) => (s: SymbolBuilder) => s.name(n)))
      .properties(...(entry === undefined ? [] : [...entry.properties.values()]) as never[]).create();
    return this;
  }

  /** Adds properties to the entry schema: `OfEntry.Builder.properties`, on a copy, so that the source's stays as it is
   * until `update()`. */
  properties(...specs: OfProperty.Spec[]): RelationBuilder {
    const entry = this.state["entry"] as EntryData | undefined;
    this.state["entry"] = (entry === undefined ? new EntryBuilder().properties(...specs).create()
      : new EntryBuilder(entry).properties(...specs).clone());
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
    const label = this.name ? `adjacency ${repr(this.name)}` : "an anonymous adjacency";
    const problems = descriptionProblems(this.description, `${label}: `);
    if (problems.length > 0) return problems;
    if (this.relation === null) return [`${label} has no relation`];
    if (!this.relation.entry.links.has(this.me)) {
      return [`${label}: ${repr(this.me)} is not a link of its relation ${repr(new Tuple([...this.relation.entry.links.keys()]))}`];
    }
    return [];
  }
}

/** An adjacency: named, the object's member through which it reads and writes its entries; anonymous (no name), it only
 * declares that the object may fill the link `me`, with no member and nothing held on the object. */
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

const LITERAL = String.raw`(?:[^\\()\[\]{}.*+?^$|]|\\[^A-Za-z0-9])*`;
/** A naming pattern: literal text around one group of digits, `\d+` then any number of `\d`, the minimum width. */
const NAMING = new RegExp(String.raw`^(${LITERAL})\(\\d\+((?:\\d)*)\)(${LITERAL})$`);

/** A naming pattern's literal prefix, the width of its number and its literal suffix; null for another pattern. */
function naming(pattern: unknown): [string, number, string] | null {
  const found = typeof pattern === "string" ? NAMING.exec(pattern) : null;
  if (found === null) return null;
  const literal = (text: string) => text.replace(/\\([^\n])/g, "$1");
  return [literal(found[1]!), 1 + found[2]!.length / 2, literal(found[3]!)];
}

class ObjectData {
  properties: Map<string, PropertyData>;
  adjacencies: Map<string, AdjacencyData>;
  singleton: string | null;
  /** A reference object schema; otherwise a value object schema. */
  ref: boolean;
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;
  /** A reference object schema's naming pattern, e.g. `FEA-(\d+\d\d)`. */
  pattern: string | null;
  /** The links it may fill with no member. */
  anonymous: AdjacencyData[];
  /** The object schema it refines, whose members it inherits, or null. */
  refines: unknown;

  constructor(fields: { properties?: Map<string, PropertyData>; adjacencies?: Map<string, AdjacencyData>; singleton?: string | null;
    ref?: boolean; name?: string | null; description?: string | null; parameters?: Map<string, ParameterData>;
    pattern?: string | null; anonymous?: AdjacencyData[]; refines?: unknown } = {}) {
    this.properties = fields.properties ?? new Map();
    this.adjacencies = fields.adjacencies ?? new Map();
    this.singleton = fields.singleton ?? null;
    this.ref = fields.ref ?? false;
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
    this.pattern = fields.pattern ?? null;
    this.anonymous = fields.anonymous ?? [];
    this.refines = fields.refines ?? null;
  }

  /** Whether an object of this schema may fill `link` of `relation`: an adjacency, named or anonymous, says so. */
  fills(relation: unknown, link: string): boolean {
    return [...this.adjacencies.values(), ...this.anonymous].some((a) => a.relation === relation && a.me === link);
  }

  /** The name the naming pattern gives the object numbered `number`: the number fills the pattern's group, at its
   * minimum width, extending on the left. */
  name_for(number: number): string {
    const [prefix, width, suffix] = naming(this.pattern)!; // a valid pattern
    return `${prefix}${String(number).padStart(width, "0")}${suffix}`;
  }

  /** The number of a name the naming pattern gives: its literal text around at least the minimum width of ASCII
   * digits. Null for a name it does not give, or without a valid naming pattern. */
  number_of(name: string): number | null {
    const found = this.pattern === null ? null : naming(this.pattern);
    if (found === null) return null;
    const [prefix, width, suffix] = found;
    const digits = name.slice(prefix.length, name.length - suffix.length);
    const fits = name.startsWith(prefix) && name.endsWith(suffix) && name.length >= prefix.length + suffix.length;
    return fits && digits.length >= width && /^[0-9]+$/.test(digits) ? Number(digits) : null;
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
      ...parameterProblems(this.parameters), ...reserved([...this.properties.keys(), ...this.adjacencies.keys()]),
      ...visited([...this.properties.keys(), ...this.adjacencies.keys()])];
    if (this.singleton !== null && !this.ref) problems.push("a singleton's schema must be a reference object schema");
    if (this.pattern !== null) {
      if (!this.ref) problems.push("a naming pattern names reference objects; mark the schema .ref()");
      if (this.singleton !== null) {
        problems.push("a singleton's schema has no naming pattern: its one instance is named by its global name");
      }
      if (naming(this.pattern) === null) {
        problems.push(`naming pattern ${repr(this.pattern)} is not literal text around one group of digits, `
          + "e.g. 'FEA-(\\d+\\d\\d)'");
      }
    }
    const clashes = [...this.properties.keys()].filter((name) => this.adjacencies.has(name));
    if (clashes.length > 0) {
      problems.push(`names used as both property and adjacency: ${repr(sortedStrings(clashes))}`);
    }
    for (const [name, prop] of this.properties) {
      problems.push(...[...validateSchema(prop.type), ...embeddedProblems(prop.type), ...descriptionProblems(prop.description)]
        .map((p) => `property ${repr(name)}: ${p}`));
    }
    for (const adjacency of [...this.adjacencies.values(), ...this.anonymous]) {
      problems.push(...adjacency.validate());
      if (!this.ref) {
        const label = adjacency.name ? `adjacency ${repr(adjacency.name)}` : "an anonymous adjacency";
        problems.push(`${label}: a value object schema has no adjacencies: entries never link value objects, `
          + "which are never shared");
      }
    }
    return [...problems, ...refinementProblems(this)];
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

  /** The object schema this one refines (a Spec): an object of this schema is an object of that one, so it has that
   * one's properties and adjacencies, which this one may redeclare narrower, and fills its links. A refinement of a
   * reference object schema is one too. */
  refines(spec: OfAny.Spec): ObjectBuilder {
    this.state["refines"] = OfAny.resolve(spec);
    const held = structure(this.state["refines"]);
    if (held instanceof ObjectData && held.ref) this.state["ref"] = true;
    return this;
  }

  override create(...args: unknown[]): ObjectData {
    return settle(super.create(...args));
  }

  override clone(...args: unknown[]): ObjectData {
    return settle(super.clone(...args));
  }

  override update(...args: unknown[]): ObjectData {
    return settle(super.update(...args));
  }

  relations(...specs: OfAdjacency.Spec[]): ObjectBuilder {
    const adjacencies = (this.state["adjacencies"] ??= new Map()) as Map<string, AdjacencyData>;
    const anonymous = (this.state["anonymous"] ??= []) as AdjacencyData[];
    for (const spec of specs) {
      const adjacency = resolveSpec(spec, isAdjacencyData, () => new AdjacencyBuilder());
      if (adjacency.name) adjacencies.set(adjacency.name, adjacency);
      else anonymous.push(adjacency); // anonymous: the object may fill the link, and holds no member for it
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
   * one. Without it, the schema describes value objects, which properties hold. A reference object is named by a UUID
   * its store gives when it is created, or, with a naming pattern (`FEA-(\d+\d\d)`), by the next name
   * the pattern gives in its store. */
  ref(pattern?: string): ObjectBuilder {
    this.state["ref"] = true;
    if (pattern !== undefined) this.state["pattern"] = pattern;
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

/** What tells a value of `schema` apart at run time: a scalar's host type, or any other schema itself. */
export function _runtime(schema: unknown): unknown {
  const found = structure(schema);
  if (found instanceof ScalarData) {
    const token = found.token as { format?: unknown; name?: unknown };
    return found.type ?? `token ${String(token.format)}:${String(token.name)}`;
  }
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

class UnionData {
  branches: readonly MemberData[];
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;
  /** Whether a value reads as its branch's value, told apart by type, rather than as an object of one branch. */
  flat: boolean;

  constructor(fields: { branches?: readonly MemberData[]; name?: string | null; description?: string | null;
    parameters?: Map<string, ParameterData>; flat?: boolean } = {}) {
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

class IntersectionData {
  parts: readonly MemberData[];
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;
  /** Whether a value reads its parts' properties as its own, rather than as an object of its parts. */
  flat: boolean;

  constructor(fields: { parts?: readonly MemberData[]; name?: string | null; description?: string | null;
    parameters?: Map<string, ParameterData>; flat?: boolean } = {}) {
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

// --- OfContainer: elements by index ---

/** The scalar types with a total order: a container indexed by one, or by a value object of them, may be dense or
 * sparse. */
const ORDERED_TYPES = new Set<unknown>([BigInt, Number, String, Boolean]);
const LAYOUTS = ["dense", "sparse"];

/** What a container's index allows: "ordered" for a scalar of a type with a total order, or a value object of such
 * scalars (several indices, as a tensor's, ordered by its properties in declaration order); "hashable" for any other
 * scalar, or a value object of scalars; null otherwise. */
function indexKind(type: unknown): "ordered" | "hashable" | null {
  const index = structure(type);
  if (index instanceof ScalarData) return ORDERED_TYPES.has(index.type) ? "ordered" : "hashable";
  if (index instanceof ObjectData && !index.ref && index.properties.size > 0) {
    const kinds = new Set([...index.properties.values()].map((prop) =>
      structure(prop.type) instanceof ScalarData ? indexKind(prop.type) : null));
    return kinds.has(null) ? null : kinds.has("hashable") ? "hashable" : "ordered";
  }
  return null;
}

/** Whether an index is an int, or a value object of ints: a dense container's positions, by default. */
function integerLike(type: unknown): boolean {
  const index = structure(type);
  if (index instanceof ScalarData) return index.type === BigInt;
  return indexKind(index) === "ordered" && [...(index as ObjectData).properties.values()].every((p) =>
    (structure(p.type) as ScalarData).type === BigInt);
}

/** A container: elements, each of the element type, held by index, each of the index type. Dense, its elements are a
 * packed array; sparse, an associative store of dense blocks; with neither, it is dense where its index is
 * integer-like (an int, or a value object of ints), a dict (by index) where its index is otherwise hashable, and its
 * elements paired with their indices otherwise. */
class ContainerData {
  index: AnyData | null;
  element: AnyData | null;
  /** "dense", "sparse", or null for the default. */
  layout: string | null;
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;
  /** The container schema it refines, or null. */
  refines: unknown;

  constructor(fields: { index?: AnyData | null; element?: AnyData | null; layout?: string | null; name?: string | null;
    description?: string | null; parameters?: Map<string, ParameterData>; refines?: unknown } = {}) {
    this.index = fields.index ?? null;
    this.element = fields.element ?? null;
    this.layout = fields.layout ?? null;
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
    this.refines = fields.refines ?? null;
  }

  /** How the container holds its elements: "dense", "sparse", "dict" (by a hashable index), or "entries" (each element
   * paired with its index, where the index is neither ordered nor hashable). */
  get arrangement(): string {
    if (this.layout !== null) return this.layout;
    return integerLike(this.index) ? "dense" : indexKind(this.index) !== null ? "dict" : "entries";
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters)];
    for (const [role, schema] of [["index", this.index], ["element", this.element]] as const) {
      if (!isAnyData(schema)) problems.push(`a container's ${role} is a schema, got ${repr(schema)}`);
      else problems.push(...validateSchema(schema).map((p) => `${role}: ${p}`));
    }
    if (this.layout !== null && !LAYOUTS.includes(this.layout)) {
      problems.push(`a container's layout is 'dense' or 'sparse', got ${repr(this.layout)}`);
    } else if (this.layout !== null && isAnyData(this.index) && indexKind(this.index) !== "ordered") {
      problems.push(`a ${this.layout} container's index has a total order: an int, float, str or bool, or a value `
        + "object of them");
    }
    return [...problems, ...refinementProblems(this)];
  }
}

class ContainerBuilder extends NamedBuilder<ContainerData> {
  protected make(fields: Record<string, unknown>): ContainerData {
    return new ContainerData(fields as ConstructorParameters<typeof ContainerData>[0]);
  }

  /** The index type, a schema of any kind (a Spec): `(t) => t.as_scalar(BigInt)`, or a value object of ints. */
  index(spec: OfAny.Spec): ContainerBuilder {
    this.state["index"] = OfAny.resolve(spec);
    return this;
  }

  /** The container schema this one refines (a Spec): its values are the refined schema's, its index and element each
   * the refined one's or narrower, which it takes unless given. */
  refines(spec: OfAny.Spec): ContainerBuilder {
    const base = OfAny.resolve(spec);
    this.state["refines"] = base;
    const held = structure(base);
    if (held instanceof ContainerData) {
      this.state["index"] ??= held.index;
      this.state["element"] ??= held.element;
    }
    return this;
  }

  /** The element type, a schema of any kind (a Spec). */
  element(spec: OfAny.Spec): ContainerBuilder {
    this.state["element"] = OfAny.resolve(spec);
    return this;
  }

  /** Elements in a packed array, at every index from the first to the last. */
  dense(): ContainerBuilder {
    return this.arranged("dense");
  }

  /** Elements in an associative store of dense blocks, indices between them absent. */
  sparse(): ContainerBuilder {
    return this.arranged("sparse");
  }

  private arranged(layout: string): ContainerBuilder {
    if ((this.state["layout"] ?? layout) !== layout) throw new ValueError("a container is .dense() or .sparse(), not both");
    this.state["layout"] = layout;
    return this;
  }
}

function isContainerData(value: unknown): value is ContainerData {
  return value instanceof ContainerData;
}

export namespace OfContainer {
  /** The meta-schema of container schemas. */
  export let Schema: ObjectData;
  export const Data = ContainerData;
  export type Data = ContainerData;
  export const Builder = ContainerBuilder;
  export type Builder = ContainerBuilder;
  export type Spec = ContainerData | ((builder: ContainerBuilder) => ContainerBuilder);

  export function resolve(spec: Spec | unknown): ContainerData {
    return resolveSpec(spec, isContainerData, () => new ContainerBuilder());
  }
}

// --- OfApply: a parametric schema applied to arguments ---

/** A parametric schema applied to arguments: a type whose values are the applied schema's (`of`), with arguments for
 * its parameters by name, each a scalar value or a term. Parameters given no argument stay unbound. */
class ApplyData {
  of: AnyData | null;
  arguments: Map<string, unknown>;
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(fields: { of?: AnyData | null; arguments?: Map<string, unknown>; name?: string | null; description?: string | null;
    parameters?: Map<string, ParameterData> } = {}) {
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

/** An argument is a term, or a scalar value, of the parameter's type where that is a scalar type. */
function argumentProblems(parameter: ParameterData, value: unknown): string[] {
  if (isTerm(value)) return termProblems(value, "a term");
  if (!isScalar(value)) return [`an argument is a scalar value or a term, got ${repr(value)}`];
  const host = parameter.type instanceof ScalarData ? parameter.type.type : null;
  return host !== null && !isScalarOf(host, value) ? [`expected ${tokenName(host)}, got ${typeName(value)}`] : [];
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

/** An argument's value: a scalar as it is, a term's as `evaluate` gives it, or `UNKNOWN`. */
function evaluated(value: unknown, scope: ReadonlyMap<string, unknown>, evaluate: Evaluate | null): unknown {
  if (!isTerm(value)) return value;
  return (evaluate === null ? null : evaluate(value, scope)) ?? UNKNOWN;
}

/** Whether two types are the same after substitution: they apply the same schema (scalars by value, other schemas by
 * identity), and give its parameters the same values, a parameter unbound in both alike. `Square(4)` and
 * `Matrix(4, 4)` are, where `Square[n]` applies `Matrix(n, n)`. null when that depends on a value that is unknown: a
 * term with no evaluator, or one `evaluate` cannot evaluate. */
export function equivalent(a: unknown, b: unknown, evaluate: Evaluate | null = null): boolean | null {
  const [[base, values], [other, others]] = [applied(a, evaluate), applied(b, evaluate)];
  const same = base instanceof ScalarData ? base.equals(other) : base === other;
  if (!same || values.size !== others.size || [...values.keys()].some((name) => !others.has(name))) return false;
  const pairs = [...values].map(([name, value]) => [value, others.get(name)]);
  if (pairs.some(([x, y]) => x !== UNKNOWN && y !== UNKNOWN && !sameScalar(x, y))) return false;
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

  /** The argument for the parameter `name`: a scalar value or a term. */
  argument(name: string, value: unknown): ApplyBuilder {
    ((this.state["arguments"] ??= new Map()) as Map<string, unknown>).set(name, value);
    return this;
  }

  /** Arguments by the names of the applied schema's parameters: `.arguments({ rows: 2n, cols: 3n })`. */
  arguments(values: Record<string, unknown> | ReadonlyMap<string, unknown>): ApplyBuilder {
    for (const [name, value] of values instanceof Map ? values : Object.entries(values)) this.argument(name, value);
    return this;
  }
}

function isApplyData(value: unknown): value is ApplyData {
  return value instanceof ApplyData;
}

export namespace OfApply {
  /** The meta-schema of applications. */
  export let Schema: ObjectData;
  /** The meta-schema of an argument: its parameter's `name`, and its scalar `value` or its `term`. */
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

// --- OfPredicate ---

/** A constraint over symbols, each standing for an object of a reference object schema, and parameters: it holds of a
 * match, a binding of every symbol to an object of its schema, where its term `requires` holds. Matching, and the
 * dialects `requires` may be written in, are the caller's (mbse-patterns'); here it is data, checked as a form. */
class PredicateData {
  symbols: Map<string, SymbolData>;
  requires: unknown;
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(fields: { symbols?: Map<string, SymbolData>; requires?: unknown; name?: string | null;
    description?: string | null; parameters?: Map<string, ParameterData> } = {}) {
    this.symbols = fields.symbols ?? new Map();
    this.requires = fields.requires ?? null;
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description),
      ...parameterProblems(this.parameters), ...reserved([...this.symbols.keys()])];
    const clashes = [...this.symbols.keys()].filter((name) => this.parameters.has(name));
    if (clashes.length > 0) problems.push(`names used as both symbol and parameter: ${repr(sortedStrings(new Set(clashes)))}`);
    for (const [name, symbol] of this.symbols) {
      if (symbol.type === null) problems.push(`symbol ${repr(name)} needs a schema`);
      problems.push(...symbolProblems(symbol).map((p) => `symbol ${repr(name)}: ${p}`));
    }
    if (this.requires !== null && !isTerm(this.requires)) problems.push(`requires is not a term: ${repr(this.requires)}`);
    return [...problems, ...termProblems(this.requires, "requires")];
  }
}

class PredicateBuilder extends NamedBuilder<PredicateData> {
  protected make(fields: Record<string, unknown>): PredicateData {
    return new PredicateData(fields as ConstructorParameters<typeof PredicateData>[0]);
  }

  /** The symbols, in order, e.g. `.symbols((s) => s.name("person").of(Person))`. */
  symbols(...specs: OfSymbol.Spec[]): PredicateBuilder {
    const symbols = (this.state["symbols"] ??= new Map()) as Map<string, SymbolData>;
    for (const spec of specs) {
      const symbol = resolveSpec(spec, isSymbolData, () => new SymbolBuilder());
      symbols.set(symbol.name, symbol);
    }
    return this;
  }

  /** The constraint, a term over the symbols and parameters: a `Form`, or a dialect's term. */
  requires(term: unknown): PredicateBuilder {
    this.state["requires"] = term;
    return this;
  }
}

function isPredicateData(value: unknown): value is PredicateData {
  return value instanceof PredicateData;
}

export namespace OfPredicate {
  /** The meta-schema of predicates. */
  export let Schema: ObjectData;
  /** A named constraint over symbols, matched by the caller. */
  export const Data = PredicateData;
  export type Data = PredicateData;
  export const Builder = PredicateBuilder;
  export type Builder = PredicateBuilder;
  export type Spec = PredicateData | ((builder: PredicateBuilder) => PredicateBuilder);

  export function resolve(spec: Spec | unknown): PredicateData {
    return resolveSpec(spec, isPredicateData, () => new PredicateBuilder());
  }
}

// --- OfAny.Value: a value of any type ---

const ALL_FORMS = ["bool", "int", "float", "text", "mapping", "list"];

/** The plain forms a value of `schema` may take: "bool", "int", "float", "text", "mapping" or "list". A float may be
 * text (`"NaN"`, `"Infinity"`), bytes are text (base64), a dense tensor a mapping where written flat, and a scalar whose
 * token this implementation cannot read any form. */
export function plain_forms(schema: unknown): Set<string> {
  const held = structure(schema);
  if (held instanceof ScalarData) {
    const forms = new Map<unknown, string[]>([[Boolean, ["bool"]], [BigInt, ["int"]], [Number, ["float", "text"]],
      [String, ["text"]], [Uint8Array, ["text"]]]);
    return new Set(forms.get(held.type) ?? ALL_FORMS);
  }
  if (held instanceof ContainerData) {
    const index = structure(held.index);
    if (held.arrangement === "dict" && index instanceof ScalarData && index.type === String) return new Set(["mapping"]);
    const tensor = held.arrangement === "dense" && index instanceof ObjectData;
    return new Set(tensor ? ["list", "mapping"] : ["list"]);
  }
  if (held instanceof AnyValueData) {
    return held.types.length > 0 ? new Set(held.types.flatMap((t) => [...plain_forms(t)])) : new Set(["mapping"]);
  }
  return new Set(held !== null ? ["mapping"] : []);
}

/** A type in a message: its name, a scalar's token name, or its kind. */
function shownType(schema: unknown): string {
  const held = structure(schema);
  const name = (schema as { name?: unknown }).name;
  if (typeof name === "string") return name;
  if (held instanceof ScalarData && held.token instanceof TokenClass) return held.token.name;
  return held instanceof ObjectData ? "a value object" : held instanceof UnionData ? "a union"
    : held instanceof IntersectionData ? "an intersection" : held instanceof ContainerData ? "a container" : "a schema";
}

/** A value of any type: of one of `types`, where they are given (an `OfAny` restricted to them), else of any type.
 * Restricted, a value is written bare, its type the one whose plain form it takes; unrestricted, it is tagged with its
 * type, a scalar's token name or a registered schema's name. */
class AnyValueData {
  types: AnyData[];
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(types: readonly unknown[] = [], fields: { name?: string | null; description?: string | null;
    parameters?: Map<string, ParameterData> } = {}) {
    this.types = [...types] as AnyData[];
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters)];
    const valid: AnyData[] = [];
    for (const schema of this.types as unknown[]) {
      if (!isAnyData(schema)) problems.push(`an OfAny's types are schemas, got ${repr(schema)}`);
      else if (structure(schema) instanceof AnyValueData) problems.push("an OfAny's types are schemas of other kinds, not an OfAny");
      else {
        valid.push(schema);
        problems.push(...validateSchema(schema).map((p) => `${shownType(schema)}: ${p}`));
      }
    }
    valid.forEach((a, i) => {
      for (const b of valid.slice(i + 1)) {
        const forms = plain_forms(b);
        if ([...plain_forms(a)].some((form) => forms.has(form))) {
          problems.push(`an OfAny's types ${shownType(a)} and ${shownType(b)} are not told apart on the wire`);
        }
      }
    });
    return problems;
  }
}

// --- OfAny ---

type AnyData = ScalarData | ObjectData | UnionData | IntersectionData | ContainerData | ApplyData | AnyValueData;

function isAnyData(value: unknown): value is AnyData {
  return value instanceof ScalarData || value instanceof ObjectData || value instanceof UnionData ||
    value instanceof IntersectionData || value instanceof ContainerData || value instanceof ApplyData
    || value instanceof AnyValueData;
}

function kindOf(value: unknown): unknown {
  return value === null || value === undefined ? null : (value as object).constructor;
}

// --- Refinement ---

/** Whether two scalar tokens are the same: by value, or the same object where one is not a token. */
function sameToken(a: unknown, b: unknown): boolean {
  return a instanceof TokenClass ? a.equals(b) : a === b;
}

function kindNoun(schema: unknown): string {
  const nouns: [Function, string][] = [[ScalarData, "a scalar schema"], [ObjectData, "an object schema"],
    [ContainerData, "a container schema"], [UnionData, "a union"], [IntersectionData, "an intersection"],
    [AnyValueData, "a value of any type"], [ApplyData, "an application"]];
  return nouns.find(([kind]) => schema instanceof kind)?.[1] ?? "nothing"; // an application of nothing
}

/** Whether `schema` is `base` or refines it, directly or not: a value of it is then a value of `base`. */
export function is_a(schema: unknown, base: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = schema;
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (current === base) return true;
    seen.add(current);
    current = (structure(current) as { refines?: unknown }).refines ?? null;
  }
  return false;
}

/** Whether validation confirms that every value of `fresh` is a value of `old`: the same schema, a refinement of it,
 * or a scalar or container schema whose parts each narrow `old`'s. */
function narrows(fresh: unknown, old: unknown): boolean {
  if (fresh === old || is_a(fresh, old)) return true;
  const [a, b] = [structure(fresh), structure(old)];
  if (a instanceof ScalarData && b instanceof ScalarData) {
    return sameToken(a.token, b.token) && widening(a, b).length === 0;
  }
  if (a instanceof ContainerData && b instanceof ContainerData) return narrows(a.index, b.index) && narrows(a.element, b.element);
  return false;
}

/** What keeps validation from confirming `fresh`'s widths are within `old`'s: a width `old` limits that `fresh` lifts,
 * widens, or gives as a term. */
function widening(fresh: ScalarData, old: ScalarData): string[] {
  const found: string[] = [];
  for (const unit of ["bits", "bytes"] as const) {
    const [limit, width] = [old[unit], fresh[unit]];
    if (typeof limit === "bigint" && !(typeof width === "bigint" && width <= limit)) {
      found.push(`its width in ${unit} cannot be confirmed within ${limit}`);
    }
  }
  return found;
}

/** A refinement's problems: it refines a schema of its own kind, not itself, and narrows what it redeclares. */
function refinementProblems(schema: ScalarData | ObjectData | ContainerData): string[] {
  if (schema.refines === null) return [];
  const base = structure(schema.refines);
  if (!(base instanceof (schema.constructor as new () => unknown))) {
    return [`refines ${kindNoun(base)}: a refinement stays within its kind, scalar, container or object`];
  }
  if (is_a(base, schema)) return ["refines itself"];
  if (schema instanceof ScalarData) {
    const held = base as ScalarData;
    if (!sameToken(schema.token, held.token)) return [`refines a scalar of ${String(held.token)}, with ${String(schema.token)}`];
    return widening(schema, held);
  }
  if (schema instanceof ContainerData) {
    const held = base as ContainerData;
    return (["index", "element"] as const).filter((role) => !narrows(schema[role], held[role]))
      .map((role) => `its ${role} cannot be confirmed to narrow the refined container's`);
  }
  const held = base as ObjectData;
  const problems = schema.ref === held.ref ? [] : ["a refinement is a reference object schema exactly where what it "
    + "refines is one"];
  for (const [name, prop] of held.properties) {
    const own = schema.properties.get(name);
    if (own !== undefined && own !== prop && !narrows(own.type, prop.type)) {
      problems.push(`property ${repr(name)} cannot be confirmed to narrow the refined schema's`);
    }
  }
  for (const [name, adjacency] of held.adjacencies) {
    const own = schema.adjacencies.get(name);
    if (own !== undefined && own !== adjacency && (own.relation !== adjacency.relation || own.me !== adjacency.me)) {
      problems.push(`adjacency ${repr(name)} redeclares the refined schema's with another relation or link`);
    }
  }
  return problems;
}

/** What an object schema has from the one it refines rather than its own, and the schemas that refine it. */
const INHERITED = new WeakMap<ObjectData, { properties: Set<string>; adjacencies: Set<string>; anonymous: AdjacencyData[] }>();
const REFINEMENTS = new WeakMap<ObjectData, ObjectData[]>();

/** The properties' and adjacencies' names, and the anonymous adjacencies, an object schema has from the one it refines
 * rather than its own. */
export function inherited(schema: ObjectData): [Set<string>, Set<string>, AdjacencyData[]] {
  const found = INHERITED.get(schema);
  return found === undefined ? [new Set(), new Set(), []] : [found.properties, found.adjacencies, found.anonymous];
}

/** Gives an object schema the members of the schema it refines, which it has not redeclared, and passes the change on
 * to the schemas that refine it. */
export function settle(schema: ObjectData): ObjectData {
  const base = schema.refines === null ? null : structure(schema.refines);
  if (base instanceof ObjectData && !is_a(base, schema)) {
    const [properties, adjacencies, anonymous] = inherited(schema);
    const ownProperties = new Map([...schema.properties].filter(([n]) => !properties.has(n)));
    const ownAdjacencies = new Map([...schema.adjacencies].filter(([n]) => !adjacencies.has(n)));
    const ownAnonymous = schema.anonymous.filter((a) => !anonymous.includes(a));
    schema.properties = new Map([...[...base.properties].map(([n, p]) => [n, ownProperties.get(n) ?? p] as const),
      ...[...ownProperties].filter(([n]) => !base.properties.has(n))]);
    schema.adjacencies = new Map([...[...base.adjacencies].map(([n, a]) => [n, ownAdjacencies.get(n) ?? a] as const),
      ...[...ownAdjacencies].filter(([n]) => !base.adjacencies.has(n))]);
    schema.anonymous = [...base.anonymous, ...ownAnonymous];
    INHERITED.set(schema, { properties: new Set([...base.properties.keys()].filter((n) => !ownProperties.has(n))),
      adjacencies: new Set([...base.adjacencies.keys()].filter((n) => !ownAdjacencies.has(n))), anonymous: [...base.anonymous] });
    const refinements = REFINEMENTS.get(base) ?? [];
    if (!refinements.includes(schema)) REFINEMENTS.set(base, [...refinements, schema]);
  }
  for (const refinement of REFINEMENTS.get(schema) ?? []) {
    if (refinement.refines !== null && structure(refinement.refines) === schema) settle(refinement);
  }
  return schema;
}

function validateSchema(schema: unknown): string[] {
  if (!isAnyData(schema)) return [`not a schema: ${repr(schema)}`];
  return schema.validate();
}

/** The schemas of the values a value of `schema` holds: a value object's properties, a union's branches, an
 * intersection's parts, through applications. */
function membersOf(type: unknown): unknown[] {
  const schema = structure(type);
  if (schema instanceof ContainerData) return [schema.index, schema.element];
  if (schema instanceof AnyValueData) return [...schema.types];
  return schema instanceof ObjectData || schema instanceof UnionData || schema instanceof IntersectionData
    ? [...schema.properties.values()].map((member) => member.type) : [];
}

/** Problems with a property's schema as a value: an object held by a property is a value object, so its schema is
 * not a reference object schema; nor are the schemas of the objects a union or an intersection holds. `seen` holds the
 * schemas on the way, so that one that holds itself is checked once. */
function embeddedProblems(type: unknown, seen: ReadonlySet<unknown> = new Set()): string[] {
  const schema = structure(type);
  if (schema instanceof ObjectData) return schema.ref ? ["a reference object schema cannot be a property's type"] : [];
  if (seen.has(schema)) return [];
  const inner = new Set([...seen, schema]);
  return sortedStrings(new Set(membersOf(schema).flatMap((member) => embeddedProblems(member, inner))));
}

/** Selects a type through `as_<kind>(spec)`. Finalizing yields that kind's data, not a wrapper; selecting several types
 * restricts an `OfAny` to them (`OfAny.Value`), and selecting none leaves it unrestricted. */
class AnyBuilder {
  private readonly source: AnyData | undefined;
  private readonly types: AnyData[] = [];

  constructor(instance?: AnyData) {
    this.source = instance;
  }

  as_scalar(spec: (builder: ScalarBuilder) => ScalarBuilder): AnyBuilder;
  as_scalar(spec: OfScalar.Spec): AnyBuilder;
  as_scalar(spec: OfScalar.Spec): AnyBuilder {
    this.types.push(OfScalar.resolve(spec));
    return this;
  }

  as_object(spec: OfObject.Spec): AnyBuilder {
    this.types.push(OfObject.resolve(spec));
    return this;
  }

  as_union(spec: OfUnion.Spec): AnyBuilder {
    this.types.push(OfUnion.resolve(spec));
    return this;
  }

  as_intersection(spec: OfIntersection.Spec): AnyBuilder {
    this.types.push(OfIntersection.resolve(spec));
    return this;
  }

  as_container(spec: OfContainer.Spec): AnyBuilder {
    this.types.push(OfContainer.resolve(spec));
    return this;
  }

  as_apply(spec: OfApply.Spec): AnyBuilder {
    this.types.push(OfApply.resolve(spec));
    return this;
  }

  /** The type selected: one kind's data, or an `OfAny.Value` of every type selected, of none for any type. */
  private selected(): AnyData {
    return this.types.length === 1 ? this.types[0] as AnyData : new AnyValueData(this.types);
  }

  create(...args: unknown[]): AnyData {
    noArguments("create", args);
    if (this.source !== undefined) {
      throw new ValueError("create() is only valid without a source instance; use clone() or update()");
    }
    return this.selected();
  }

  clone(...args: unknown[]): AnyData {
    noArguments("clone", args);
    if (this.source === undefined) throw new ValueError("clone() is only valid with a source instance");
    if (this.types.length > 0) return this.selected();
    const copy = Object.create(Object.getPrototypeOf(this.source)) as AnyData;
    return Object.assign(copy, this.source);
  }

  update(...args: unknown[]): AnyData {
    noArguments("update", args);
    if (this.source === undefined) throw new ValueError("update() is only valid with a source instance");
    if (this.types.length === 0) return this.source; // nothing selected: the source as it is, as clone() copies it
    const selected = this.selected();
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
  /** Where a schema of any kind is expected. `OfAny.Data` is any schema kind's data; `OfAny.Value`, the kind of a value
   * of any type, or of one of the types it is restricted to. */
  export type Data = AnyData;
  export const Value = AnyValueData;
  export type Value = AnyValueData;
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
  return (p: PropertyBuilder) => p.name(name).of((t) => t.as_scalar(String));
}

const Text = (t: AnyBuilder) => t.as_scalar(String);
const Int = (t: AnyBuilder) => t.as_scalar(BigInt);

/** A property listing elements of a schema: a container of value objects by position, each holding `fields`. A
 * schema's members are a list, in declaration order, which a schema read back keeps. */
function listing(name: string, fields: [string, OfAny.Spec][]) {
  const element = new ObjectBuilder().properties(...fields.map(([n, spec]) => (p: PropertyBuilder) => p.name(n).of(spec)))
    .create();
  return (p: PropertyBuilder) => p.name(name).of((t) => t.as_container((c) => c.index(Int).element(element)));
}
const NamedSchema = new ObjectBuilder().properties(namedText("name")).create();
const AnySchema = new UnionBuilder().create(); // a type; its branches, which refer back to it, are added below
const PropertySchema = new ObjectBuilder().properties(namedText("name"), (p) => p.name("type").of(AnySchema),
  namedText("description")).create();
/** The fields of an object schema's properties, which an entry listing its members holds. */
const fieldsOf = (schema: ObjectData): [string, OfAny.Spec][] =>
  [...schema.properties].map(([name, prop]) => [name, prop.type as OfAny.Data]); // the meta-schemas type every property
const MEMBER = fieldsOf(PropertySchema); // a member's entry holds a property's
const Parameters = listing("parameters", MEMBER);
const ScalarValue = new UnionBuilder().branches(
  ...SCALAR_TYPES.map((host) => (b: MemberBuilder) => b.name(tokenName(host)).of((x) => x.as_scalar(host)))).create();
const FormSchema = new ObjectBuilder().properties(namedText("dialect"), namedText("kind"),
  listing("attributes", [["name", Text], ["value", ScalarValue]])).create();
new ObjectBuilder(FormSchema).properties(listing("arguments", [["term", FormSchema]])).update();
const WidthTerms = new ObjectBuilder().properties((p) => p.name("bits").of(FormSchema), (p) => p.name("bytes").of(FormSchema))
  .create();
const Refines = (p: PropertyBuilder) => p.name("refines").of(AnySchema);
const ScalarSchema = new ObjectBuilder().name("Schemas.Scalar").properties(
  namedText("name"), Refines, namedText("format"), namedText("token"), (p) => p.name("bits").of(Int), (p) => p.name("bytes").of(Int),
  (p) => p.name("terms").of(WidthTerms), namedText("description"), Parameters).create();
const ClauseSchema = new ObjectBuilder().properties(listing("names", [["name", Text]])).create();
const RelationSchema = new ObjectBuilder().name("Schemas.Relation").properties(namedText("name"), namedText("description"),
  Parameters, listing("links", MEMBER), listing("properties", MEMBER), listing("uniques", [["clause", ClauseSchema]]))
  .create();
const RelationRef = new UnionBuilder().branches((b) => b.name("relation").of(RelationSchema),
  (b) => b.name("named").of(NamedSchema)).create();
const AdjacencySchema = new ObjectBuilder().properties(
  namedText("name"), (p) => p.name("relation").of(RelationRef), namedText("me"), namedText("description")).create();
const ObjectSchema = new ObjectBuilder().name("Schemas.Object").properties(
  namedText("name"), Refines, namedText("singleton"), (p) => p.name("ref").of((t) => t.as_scalar(Boolean)), namedText("pattern"),
  namedText("description"), Parameters, listing("properties", MEMBER), listing("adjacencies", fieldsOf(AdjacencySchema)))
  .create();
const Flat = (p: PropertyBuilder) => p.name("flat").of((t) => t.as_scalar(Boolean));
const UnionSchema = new ObjectBuilder().name("Schemas.Union").properties(namedText("name"), Flat, namedText("description"),
  Parameters, listing("branches", MEMBER)).create();
const IntersectionSchema = new ObjectBuilder().name("Schemas.Intersection").properties(
  namedText("name"), Flat, namedText("description"), Parameters, listing("parts", MEMBER)).create();
const ContainerSchema = new ObjectBuilder().name("Schemas.Container").properties(
  namedText("name"), Refines, (p) => p.name("index").of(AnySchema), (p) => p.name("element").of(AnySchema), namedText("layout"),
  namedText("description"), Parameters).create();
const ArgumentSchema = new ObjectBuilder().properties(namedText("name"), (p) => p.name("value").of(ScalarValue),
  (p) => p.name("term").of(FormSchema)).create();
const ApplySchema = new ObjectBuilder().name("Schemas.Apply").properties(
  namedText("name"), (p) => p.name("of").of(AnySchema), namedText("description"),
  Parameters, listing("arguments", fieldsOf(ArgumentSchema))).create();
const EntrySchema = new ObjectBuilder().properties(listing("links", MEMBER), listing("properties", MEMBER)).create();
const PredicateSchema = new ObjectBuilder().name("Schemas.Predicate").properties(
  namedText("name"), (p) => p.name("requires").of(FormSchema), namedText("description"),
  Parameters, listing("symbols", MEMBER)).create();
const AnyValueSchema = new ObjectBuilder().name("Schemas.Any").properties(
  namedText("name"), (p) => p.name("types").of((t) => t.as_container((c) => c.index(Int).element(AnySchema))),
  namedText("description"), Parameters).create();
const KIND_SCHEMAS: [string, ObjectData][] = [["scalar", ScalarSchema], ["object", ObjectSchema], ["union", UnionSchema],
  ["intersection", IntersectionSchema], ["container", ContainerSchema], ["apply", ApplySchema], ["any", AnyValueSchema]];
const kindBranches = KIND_SCHEMAS.map(([name, schema]) => (b: MemberBuilder) => b.name(name).of(schema));
new UnionBuilder(AnySchema).branches(...kindBranches, (b) => b.name("named").of(NamedSchema)).update();
const DefinitionSchema = new UnionBuilder().branches(...kindBranches, (b) => b.name("relation").of(RelationSchema),
  (b) => b.name("predicate").of(PredicateSchema)).create();

OfScalar.Schema = ScalarSchema;
OfProperty.Schema = PropertySchema;
OfRelation.Schema = RelationSchema;
OfRelation.Ref = RelationRef;
OfEntry.Schema = EntrySchema;
OfSymbol.Schema = PropertySchema;
OfPredicate.Schema = PredicateSchema;
OfAdjacency.Schema = AdjacencySchema;
OfObject.Schema = ObjectSchema;
OfUnion.Schema = UnionSchema;
OfIntersection.Schema = IntersectionSchema;
OfContainer.Schema = ContainerSchema;
(OfAny.Value as unknown as { Schema: ObjectData }).Schema = AnyValueSchema;
OfParameter.Schema = PropertySchema;
OfApply.Schema = ApplySchema;
OfApply.Argument = ArgumentSchema;
Form.Schema = FormSchema;
Form.Value = ScalarValue;
OfAny.Schema = AnySchema;
OfAny.Named = NamedSchema;

/** A named set of schemas, as data. `Module.Schema` is the reference object schema of a module: its `schemas` are a
 * container by name, each element a `Module.Definition` (a schema of any kind, relations and predicates included). See `Modules` for the translation between schemas and modules. */
export namespace Module {
  export const Schema = new ObjectBuilder().name("Schemas.Module").ref(String.raw`module-(\d+)`)
    .properties((p) => p.name("schemas").of((t) => t.as_container((c) => c.index(Text).element(DefinitionSchema)))).create();
  export const Definition = DefinitionSchema;
}
