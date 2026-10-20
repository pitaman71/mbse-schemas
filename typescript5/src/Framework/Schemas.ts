/**
 * Schemas: schema elements.
 *
 * For each schema element `OfX`, `Schemas.OfX.Data` captures a schema. `Schemas.OfX.Builder`, which builds one, is
 * `Builders`' (each builder a `Visitors.OfObject` over its plain schema, its store's `Schemas.OfX`); importing this
 * package installs it here.
 *
 * `validate()` on each `Data` returns a list of problems and runs only when the caller asks. `equals()` stands in for
 * Python's `==`: by value for `OfScalar.Data`, by identity for the other kinds.
 *
 * Every kind of schema may have a `name`, set by its builder's `.name("crm.Contact")`: identifiers separated by dots,
 * the part before the last dot the module it is in. A store registers a named schema under that name.
 *
 * Every kind of schema may declare `parameters` (`OfParameter`): names, each a symbol standing for a schema, bound
 * where the schema is referred to (docs/proposals/store-overhaul, Decided, 12 and 20). Terms, applications and widths
 * are mbse-expressions' (docs/SCHEMA_EXTENSION.md, Decided, 5 to 7).
 *
 * A pattern (`OfPattern`) declares symbols (`OfSymbol`), each standing for a reference object, variables
 * (`OfVariable`), each standing for a value, and the constraints a frame meets (its `requires`, each an `OfExpression` of
 * boolean result); an expression (`OfExpression`) ranges over a pattern, and a collector (`OfCollector`) folds the frames
 * of one (docs/STREAMING_QUERIES.md). A relation holds the schema of its entries (`OfEntry`): their links, each a symbol,
 * and their properties.
 */

import { fromBase64, toBase64 } from "./Bytes.js";
import { DecodeError, ValueError } from "./Errors.js";
import type * as Builders from "./Builders.js";
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
/** A dotted name: a path of identifiers (`crm.sales.Order`). */
export const _DOTTED = DOTTED;

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

/** The host type of a scalar value, or null for a value that is not one. */
export function hostOf(value: unknown): ScalarToken | null {
  return SCALAR_TYPES.find((token) => isScalarOf(token, value)) ?? null;
}

// --- OfParameter: a name a schema declares ---

/** A parameter of the schema that declares it: a name, a symbol standing for a schema, bound where the schema is
 * referred to and referred to within it by name, as a variable is. */
class ParameterData {
  name: string;
  description: string | null;

  constructor(fields: { name?: string; description?: string | null } = {}) {
    this.name = fields.name ?? "";
    this.description = fields.description ?? null;
  }

  equals(other: unknown): boolean {
    return other instanceof ParameterData && other.name === this.name && other.description === this.description;
  }
}

export namespace OfParameter {
  export const Data = ParameterData;
  export type Data = ParameterData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.ParameterBuilder;
  export type Builder = Builders.ParameterBuilder;
}

function parameterProblems(parameters: ReadonlyMap<string, ParameterData>): string[] {
  const problems = reserved([...parameters.keys()]);
  for (const [name, parameter] of parameters) {
    problems.push(...descriptionProblems(parameter.description).map((p) => `parameter ${repr(name)}: ${p}`));
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

/** The basic scalars, the only scalar schemas, by name, each mapping to its host type (docs/proposals/store-overhaul,
 * Decided, 8 and 22). */
const HOSTS: ReadonlyMap<string, ScalarToken> = new Map(SCALAR_TYPES.map((host) => [basicName(tokenName(host)), host]));

function basicName(tag: string): string {
  return `Schemas.Of${tag.charAt(0).toUpperCase()}${tag.slice(1)}`;
}

function scalarShown(scalar: ScalarData): string {
  return scalar.name === null ? "an unnamed scalar" : `the scalar ${repr(scalar.name)}`;
}

/** A scalar's name, description and parameters. */
export interface ScalarFields {
  name?: string | null;
  description?: string | null;
  parameters?: Map<string, ParameterData>;
}

/** A scalar: one of the five basic scalars, `Schemas.OfBool`, `Schemas.OfInt`, `Schemas.OfFloat`,
 * `Schemas.OfStr` and `Schemas.OfBytes`, each mapping to its host type by its name. A host type given in place of the
 * name (`new OfScalar.Data(BigInt)`) is shorthand for the basic scalar's. Every finer scalar is a domain,
 * mbse-expressions'. */
class ScalarData {
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(host: unknown = null, fields: ScalarFields = {}) {
    this.name = SCALAR_NAMES.has(host) ? basicName(SCALAR_NAMES.get(host) as string) : fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
  }

  /** The host type the basic scalar maps to, or null when it names none. */
  get type(): ScalarToken | null {
    return typeof this.name === "string" ? HOSTS.get(this.name) ?? null : null;
  }

  /** The basic scalar's tag (`int`), which a value of any schema is tagged with on the wire, or null. */
  get tag(): string | null {
    const host = this.type;
    return host === null ? null : tokenName(host);
  }

  /** The host type the basic scalar maps to; throws TypeError when it names none. */
  host(): ScalarToken {
    const host = this.type;
    if (host === null) throw new TypeError(`${scalarShown(this)} is not a basic scalar`);
    return host;
  }

  equals(other: unknown): boolean {
    return other instanceof ScalarData && other.name === this.name && other.description === this.description
      && sameParameters(this.parameters, other.parameters);
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters)];
    if (this.type === null) {
      problems.push(`${scalarShown(this)} is not a basic scalar: a scalar is Schemas.OfBool, Schemas.OfInt, `
        + "Schemas.OfFloat, Schemas.OfStr or Schemas.OfBytes");
    }
    return problems;
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

  /** The host type, or `DecodeError` when the scalar is not a basic scalar. */
  private hostForDecoding(): ScalarToken {
    if (this.type === null) throw new DecodeError(`${scalarShown(this)} is not a basic scalar`);
    return this.type;
  }

  /** Converts plain data back to a scalar value. Distinct scalars are never coerced into each other.
   * Plain data that does not hold such a value, or a scalar that is not a basic scalar, throws
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

export namespace OfScalar {
  /** A scalar value. Conversion to and from the wire format is the responsibility of this element. */
  export const Data = ScalarData;
  export type Data = ScalarData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.ScalarBuilder;
  export type Builder = Builders.ScalarBuilder;
}

// --- OfProperty: a named property of an object or relation ---

class PropertyData {
  name: string;
  schema: AnyData | null;
  description: string | null;
  /** A key's naming pattern, e.g. `FEA-(\d+\d\d)`, from which a value is generated. */
  pattern: string | null;

  constructor(fields: { name?: string; schema?: AnyData | null; description?: string | null; pattern?: string | null } = {}) {
    this.name = fields.name ?? "";
    this.schema = fields.schema ?? null;
    this.description = fields.description ?? null;
    this.pattern = fields.pattern ?? null;
  }

  /** The value the naming pattern gives the key numbered `number` (`nameFor`). */
  name_for(number: number): string {
    return nameFor(this.pattern as string, number);
  }

  /** The number of a value the naming pattern gives (`numberOf`); null for another value. */
  number_of(name: string): number | null {
    return numberOf(this.pattern, name);
  }


  equals(other: unknown): boolean {
    return other === this;
  }
}

export namespace OfProperty {
  export const Data = PropertyData;
  export type Data = PropertyData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.PropertyBuilder;
  export type Builder = Builders.PropertyBuilder;
}

// --- OfSymbol: a name standing for an object ---

/** A name standing for an object: a pattern's symbol, which a frame binds, or an entry's link. Its schema is a
 * reference object schema, which either may leave unset (null). */
class SymbolData {
  name: string;
  schema: AnyData | null;
  description: string | null;

  constructor(fields: { name?: string; schema?: AnyData | null; description?: string | null } = {}) {
    this.name = fields.name ?? "";
    this.schema = fields.schema ?? null;
    this.description = fields.description ?? null;
  }
}

export namespace OfSymbol {
  export const Data = SymbolData;
  export type Data = SymbolData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.SymbolBuilder;
  export type Builder = Builders.SymbolBuilder;
}

/** A symbol's schema, when it has one, is a reference object schema. */
/** A symbol's schema, when it has one, is a reference object schema, or a kind union: a union of reference object
 * schemas, its branches naming the kinds of object it may stand for (docs/OBJECT_IDENTITY.md, Decided, 97). */
function symbolProblems(symbol: SymbolData): string[] {
  if (symbol.schema === null) return descriptionProblems(symbol.description);
  const problems = validateSchema(symbol.schema);
  const target = symbol.schema;
  if (target instanceof UnionData) {
    if (!target.branches.every((b) => b.schema instanceof ObjectData && b.schema.ref)) {
      problems.push("a kind union's branches are reference object schemas");
    }
  } else if (!(target instanceof ObjectData && target.ref)) {
    problems.push("a symbol stands for a reference object, so its schema is a reference object schema");
  }
  return [...problems, ...descriptionProblems(symbol.description)];
}

/** A kind union's branches' schemas, by name; null for any other schema (docs/OBJECT_IDENTITY.md, Decided, 97). */
export function _kinds(schema: unknown): Map<string, ObjectData> | null {
  if (schema instanceof UnionData && schema.branches.length > 0
    && schema.branches.every((b) => b.schema instanceof ObjectData && b.schema.ref)) {
    return new Map(schema.branches.map((b) => [b.name, b.schema as ObjectData]));
  }
  return null;
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
      problems.push(...[...validateSchema(prop.schema), ...embeddedProblems(prop.schema), ...descriptionProblems(prop.description), ...patternProblems(prop)]
        .map((p) => `property ${repr(name)}: ${p}`));
    }
    return problems;
  }
}

export namespace OfEntry {
  /** The schema of a relation's entries: their links and properties. */
  export const Data = EntryData;
  export type Data = EntryData;
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

export namespace OfRelation {
  /** A relation, inline or by name. */
  export let Ref: UnionData;
  /** A relationship between objects, with a named link per linked object. Relations have no caller-facing instance
   * builder; entries are added through the adjacencies of the objects they link. */
  export const Data = RelationData;
  export type Data = RelationData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.RelationBuilder;
  export type Builder = Builders.RelationBuilder;
}

// --- OfAdjacency ---

class AdjacencyData {
  name: string;
  relation: RelationData | null;
  me: string;
  description: string | null;
  /** It points back to the previous element of its object's identity path: its owner. */
  owner: boolean | null;

  constructor(fields: { name?: string; relation?: RelationData | null; me?: string; description?: string | null;
    owner?: boolean | null } = {}) {
    this.name = fields.name ?? "";
    this.relation = fields.relation ?? null;
    this.me = fields.me ?? "";
    this.description = fields.description ?? null;
    this.owner = fields.owner ?? null;
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
    return this.owner ? ownerProblems(this, label) : [];
  }
}

/** An owner adjacency's relation makes path resolution unambiguous (docs/OBJECT_IDENTITY.md, Decided, 14): of two
 * links, the owner's and the owned's (`me`); a clause holding the owner's link and not the owned's, so that the owned
 * object determines its owner, and one holding the owned's and not the owner's, so that the owner and the keys determine
 * the owned object. */
function ownerProblems(adjacency: AdjacencyData, label: string): string[] {
  const relation = adjacency.relation as RelationData;
  const owners = [...relation.entry.links.keys()].filter((link) => link !== adjacency.me);
  if (owners.length !== 1) return [`${label} is its object's owner: its relation has two links, the owner's and the owned's`];
  const [owner, owned] = [owners[0]!, adjacency.me];
  const problems: string[] = [];
  if (!relation.uniques.some((clause) => clause.has(owner) && !clause.has(owned))) {
    problems.push(`${label} is its object's owner: no unique clause has ${repr(owner)} without ${repr(owned)}, so that the `
      + "owned object determines its owner");
  }
  if (!relation.uniques.some((clause) => clause.has(owned) && !clause.has(owner))) {
    problems.push(`${label} is its object's owner: no unique clause has ${repr(owned)} without ${repr(owner)}, so that the `
      + "owner and the keys determine the owned object");
  }
  return problems;
}

/** A property's naming pattern: literal text around one group of digits, on a property of text. */
function patternProblems(prop: PropertyData): string[] {
  if (prop.pattern === null) return [];
  const problems: string[] = [];
  if (naming(prop.pattern) === null) {
    problems.push(`naming pattern ${repr(prop.pattern)} is not literal text around one group of digits, `
      + "e.g. 'FEA-(\\d+\\d\\d)'");
  }
  if (!(prop.schema instanceof ScalarData && prop.schema.type === String)) {
    problems.push("a naming pattern gives text: the property's schema is Schemas.OfStr");
  }
  return problems;
}

export namespace OfAdjacency {
  /** Declares that an `OfObject` is adjacent to an `OfRelation` via a particular link. */
  export const Data = AdjacencyData;
  export type Data = AdjacencyData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.AdjacencyBuilder;
  export type Builder = Builders.AdjacencyBuilder;
}

// --- OfObject ---

/** The schemas being validated, so that one that holds itself is validated once. */
const VALIDATING = new Set<unknown>();

/** A schema's problems, for a kind whose values hold others' (an object, a union, an intersection, a container, a value
 * of any schema): a schema that holds itself has its problems reported once, where it is first reached. */
function once(schema: unknown, problems: () => string[]): string[] {
  if (VALIDATING.has(schema)) return [];
  VALIDATING.add(schema);
  try {
    return problems();
  } finally {
    VALIDATING.delete(schema);
  }
}

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

/** The name a naming pattern gives the number `number`: it fills the pattern's group, at its minimum width, extending
 * on the left. */
export function nameFor(pattern: string, number: number): string {
  const [prefix, width, suffix] = naming(pattern)!; // a valid pattern
  return `${prefix}${String(number).padStart(width, "0")}${suffix}`;
}

/** The number of a name a naming pattern gives: its literal text around at least the minimum width of ASCII digits.
 * Null for a name it does not give, or without a valid naming pattern. */
export function numberOf(pattern: string | null, name: string): number | null {
  const found = pattern === null ? null : naming(pattern);
  if (found === null) return null;
  const [prefix, width, suffix] = found;
  const digits = name.slice(prefix.length, name.length - suffix.length);
  const fits = name.startsWith(prefix) && name.endsWith(suffix) && name.length >= prefix.length + suffix.length;
  return fits && digits.length >= width && /^[0-9]+$/.test(digits) ? Number(digits) : null;
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
  /** The links it may fill with no member. */
  anonymous: AdjacencyData[];
  /** The object schema it refines, whose members it inherits, or null. */
  refines: unknown;

  constructor(fields: { properties?: Map<string, PropertyData>; adjacencies?: Map<string, AdjacencyData>; singleton?: string | null;
    ref?: boolean; name?: string | null; description?: string | null; parameters?: Map<string, ParameterData>;
    anonymous?: AdjacencyData[]; refines?: unknown } = {}) {
    this.properties = fields.properties ?? new Map();
    this.adjacencies = fields.adjacencies ?? new Map();
    this.singleton = fields.singleton ?? null;
    this.ref = fields.ref ?? false;
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
    this.anonymous = fields.anonymous ?? [];
    this.refines = fields.refines ?? null;
  }

  /** Whether an object of this schema may fill `link` of `relation`: an adjacency, named or anonymous, says so. */
  fills(relation: unknown, link: string): boolean {
    return [...this.adjacencies.values(), ...this.anonymous].some((a) => a.relation === relation && a.me === link);
  }


  equals(other: unknown): boolean {
    return other === this;
  }

  /** The schema's problems. A value object schema may hold itself, through a list: its problems are reported once,
   * where it is first reached. */
  validate(): string[] {
    return once(this, () => this.problems());
  }

  private problems(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description),
      ...parameterProblems(this.parameters), ...reserved([...this.properties.keys(), ...this.adjacencies.keys()]),
      ...visited([...this.properties.keys(), ...this.adjacencies.keys()])];
    if (this.singleton !== null && !this.ref) problems.push("a singleton's schema must be a reference object schema");
    const clashes = [...this.properties.keys()].filter((name) => this.adjacencies.has(name));
    if (clashes.length > 0) {
      problems.push(`names used as both property and adjacency: ${repr(sortedStrings(clashes))}`);
    }
    for (const [name, prop] of this.properties) {
      problems.push(...[...validateSchema(prop.schema), ...embeddedProblems(prop.schema), ...descriptionProblems(prop.description), ...patternProblems(prop)]
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

export namespace OfObject {
  export const Data = ObjectData;
  export type Data = ObjectData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.ObjectBuilder;
  export type Builder = Builders.ObjectBuilder;
}

// --- OfUnion / OfIntersection ---

/** A named member of a union (a branch) or of an intersection (a part). */
class MemberData {
  name: string;
  schema: AnyData | null;
  description: string | null;

  constructor(fields: { name?: string; schema?: AnyData | null; description?: string | null } = {}) {
    this.name = fields.name ?? "";
    this.schema = fields.schema ?? null;
    this.description = fields.description ?? null;
  }


  equals(other: unknown): boolean {
    return other === this;
  }
}

/** Problems with a union's branches (`aKind` 'a union', `member` 'branch') or an intersection's parts. */
function memberProblems(aKind: string, member: string, plural: string, members: readonly MemberData[]): string[] {
  const kind = aKind.split(" ")[1];
  const problems = reserved(members.map((m) => m.name));
  if (members.length < 2) problems.push(`${aKind} needs at least two ${plural}`);
  if (new Set(members.map((m) => kindOf(m.schema))).size > 1) problems.push(`${kind} ${plural} must all be the same kind`);
  const seen = new Set<string>();
  members.forEach((m, i) => {
    if (typeof m.name !== "string" || m.name === "") problems.push(`${member} ${i} has no name`);
    else if (seen.has(m.name)) problems.push(`${member} name ${repr(m.name)} is used more than once`);
    seen.add(m.name);
    problems.push(...descriptionProblems(m.description, `${member} ${repr(m.name)}: `));
  });
  return problems;
}

/** What tells a value of `schema` apart at run time: a scalar's host type, or its name where it is not a basic scalar,
 * or any other schema itself. */
export function _runtime(schema: unknown): unknown {
  const found = schema;
  if (found instanceof ScalarData) return found.type ?? `scalar ${String(found.name)}`;
  return found;
}

/** A flat union's branches are told apart by their values' schemas. */
function flatUnionProblems(branches: readonly MemberData[]): string[] {
  const problems: string[] = [];
  const seen = new Map<unknown, string>();
  for (const branch of branches) {
    const key = _runtime(branch.schema);
    if (seen.has(key)) problems.push(`flat union: branches ${repr(seen.get(key))} and ${repr(branch.name)} are not told apart by schema`);
    else seen.set(key, branch.name);
  }
  return problems;
}

/** A flat intersection's parts are object schemas whose properties have distinct names: its own properties. */
function flatIntersectionProblems(parts: readonly MemberData[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const part of parts) {
    const schema = part.schema;
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

function byName(members: readonly MemberData[]): Map<string, MemberData> {
  return new Map(members.map((m) => [m.name, m]));
}

class UnionData {
  branches: readonly MemberData[];
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;
  /** Whether a value reads as its branch's value, told apart by schema, rather than as an object of one branch. */
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
    return once(this, () => this.problems());
  }

  private problems(): string[] {
    return [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters),
      ...memberProblems("a union", "branch", "branches", this.branches), ...(this.flat ? flatUnionProblems(this.branches) : [])];
  }
}

export namespace OfUnion {
  export const Data = UnionData;
  export type Data = UnionData;
  export const Branch = MemberData;
  export type Branch = MemberData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.UnionBuilder;
  export type Builder = Builders.UnionBuilder;
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
    return once(this, () => this.problems());
  }

  private problems(): string[] {
    return [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters),
      ...memberProblems("an intersection", "part", "parts", this.parts), ...(this.flat ? flatIntersectionProblems(this.parts) : [])];
  }
}

export namespace OfIntersection {
  export const Data = IntersectionData;
  export type Data = IntersectionData;
  export const Part = MemberData;
  export type Part = MemberData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.IntersectionBuilder;
  export type Builder = Builders.IntersectionBuilder;
}

// --- OfContainer: elements by index ---

/** The scalars with a total order: a container indexed by one, or by a value object of them, may be dense or
 * sparse. */
const ORDERED_TYPES = new Set<unknown>([BigInt, Number, String, Boolean]);
const LAYOUTS = ["dense", "sparse"];

/** What a container's index allows: "ordered" for a scalar with a total order, or a value object of such
 * scalars (several indices, as a tensor's, ordered by its properties in declaration order); "hashable" for any other
 * scalar, or a value object of scalars; null otherwise. */
function indexKind(index: unknown): "ordered" | "hashable" | null {
  if (index instanceof ScalarData) return ORDERED_TYPES.has(index.type) ? "ordered" : "hashable";
  if (index instanceof ObjectData && !index.ref && index.properties.size > 0) {
    const kinds = new Set([...index.properties.values()].map((prop) =>
      prop.schema instanceof ScalarData ? indexKind(prop.schema) : null));
    return kinds.has(null) ? null : kinds.has("hashable") ? "hashable" : "ordered";
  }
  return null;
}

/** Whether an index is an int, or a value object of ints: a dense container's positions, by default. */
function integerLike(index: unknown): boolean {
  if (index instanceof ScalarData) return index.type === BigInt;
  return indexKind(index) === "ordered" && [...(index as ObjectData).properties.values()].every((p) =>
    (p.schema as ScalarData).type === BigInt);
}

/** A container: elements, each of the element's schema, held by index, each of the index's schema. Dense, its elements are a
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
    return once(this, () => this.problems());
  }

  private problems(): string[] {
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

export namespace OfContainer {
  export const Data = ContainerData;
  export type Data = ContainerData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.ContainerBuilder;
  export type Builder = Builders.ContainerBuilder;
}

// --- OfVariable: a name standing for a value ---

/** A name standing for a value: a pattern's variable, which a frame assigns a value of its schema. */
class VariableData {
  name: string;
  schema: AnyData | null;
  description: string | null;

  constructor(fields: { name?: string; schema?: AnyData | null; description?: string | null } = {}) {
    this.name = fields.name ?? "";
    this.schema = fields.schema ?? null;
    this.description = fields.description ?? null;
  }
}

export namespace OfVariable {
  export const Data = VariableData;
  export type Data = VariableData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.VariableBuilder;
  export type Builder = Builders.VariableBuilder;
}

/** A variable's schema, when it has one, is a value's: never a reference object schema. */
function variableProblems(variable: VariableData): string[] {
  const problems = descriptionProblems(variable.description);
  if (variable.schema === null) return problems;
  return [...validateSchema(variable.schema), ...embeddedProblems(variable.schema), ...problems];
}

// --- OfExpression, OfConstraint ---

/** An expression over a pattern's frames: its pattern, whose symbols and variables are free in it, and the schema of the
 * value it computes. Its terms are mbse-expressions' (docs/STREAMING_QUERIES.md, Value expressions and constraints); a
 * constraint is an expression whose result is `Schemas.OfBool`. */
class ExpressionData {
  /** An OfPattern.Data, or null where its owner gives it. */
  pattern: unknown;
  result: unknown;
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(fields: { pattern?: unknown; result?: unknown; name?: string | null; description?: string | null;
    parameters?: Map<string, ParameterData> } = {}) {
    this.pattern = fields.pattern ?? null;
    this.result = fields.result ?? null;
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters)];
    if (this.pattern !== null && !(this.pattern instanceof PatternData)) problems.push("an expression's pattern is a pattern");
    if (this.result === null) problems.push("an expression needs a result schema");
    else problems.push(...[...validateSchema(this.result), ...embeddedProblems(this.result)].map((p) => `result: ${p}`));
    return problems;
  }
}

export namespace OfExpression {
  /** An expression: mbse-expressions refines it with its terms. */
  export const Data = ExpressionData;
  export type Data = ExpressionData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.ExpressionBuilder;
  export type Builder = Builders.ExpressionBuilder;
}

export namespace OfConstraint {
  /** A constraint: an expression whose result is the store's `Schemas.OfBool` (its builder fixes it). */
  export const Data = ExpressionData;
  export type Data = ExpressionData;
  export declare const Builder: typeof Builders.ConstraintBuilder;
  export type Builder = Builders.ConstraintBuilder;
}

function isConstraint(expression: unknown): boolean {
  return expression instanceof ExpressionData && Object(expression.result).name === "Schemas.OfBool";
}

// --- OfPattern ---

/** The shape of a frame: symbols, each bound to a reference object, variables, each assigned a value, and the
 * constraints a frame meets, in order (docs/STREAMING_QUERIES.md, Patterns). */
class PatternData {
  symbols: Map<string, SymbolData>;
  variables: Map<string, VariableData>;
  requires: ExpressionData[];
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;
  /** What must hold of a frame: `Mutations.OfPattern`s, as plain data (docs/OBJECT_IDENTITY.md, Decided, 95). */
  spec: unknown[];

  constructor(fields: { symbols?: Map<string, SymbolData>; variables?: Map<string, VariableData>; requires?: ExpressionData[];
    name?: string | null; description?: string | null; parameters?: Map<string, ParameterData>; spec?: unknown[] } = {}) {
    this.symbols = fields.symbols ?? new Map();
    this.variables = fields.variables ?? new Map();
    this.requires = fields.requires ?? [];
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
    this.spec = fields.spec ?? [];
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description),
      ...parameterProblems(this.parameters), ...reserved([...this.symbols.keys(), ...this.variables.keys()])];
    for (const [first, second, plural] of [[this.symbols, this.variables, "symbol and variable"],
      [this.symbols, this.parameters, "symbol and parameter"], [this.variables, this.parameters, "variable and parameter"]] as const) {
      const clashes = [...first.keys()].filter((name) => second.has(name));
      if (clashes.length > 0) problems.push(`names used as both ${plural}: ${repr(sortedStrings(new Set(clashes)))}`);
    }
    for (const [name, symbol] of this.symbols) problems.push(...symbolProblems(symbol).map((p) => `symbol ${repr(name)}: ${p}`));
    for (const [name, variable] of this.variables) {
      problems.push(...variableProblems(variable).map((p) => `variable ${repr(name)}: ${p}`));
    }
    this.requires.forEach((constraint, index) => {
      if (!isConstraint(constraint)) {
        problems.push(`requires[${index}] is a constraint: an expression whose result is Schemas.OfBool`);
        return;
      }
      if (constraint.pattern !== null && constraint.pattern !== this) {
        problems.push(`requires[${index}] is over this pattern's frames, not another's`);
      }
      problems.push(...constraint.validate().map((p) => `requires[${index}]: ${p}`));
    });
    return problems;
  }
}

export namespace OfPattern {
  /** The shape of a frame (docs/STREAMING_QUERIES.md, Patterns). */
  export const Data = PatternData;
  export type Data = PatternData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.PatternBuilder;
  export type Builder = Builders.PatternBuilder;
}

// --- OfCollector ---

/** A pattern used to fold frames (docs/STREAMING_QUERIES.md, Mutation expressions): the symbols and variables it
 * collects, each duplicated under its `suffixes`, `current` and `next`, and what it `computes`; `commutative` or
 * `associative`, so that the fold does not depend on the order frames arrive in (docs/OBJECT_IDENTITY.md, 62). */
class CollectorData {
  pattern: unknown;
  symbols: string[];
  variables: string[];
  commutative: boolean | null;
  associative: boolean | null;
  /** {current, next}, or null. */
  suffixes: Map<string, string> | null;
  /** An OfExpression.Data. */
  computes: unknown;
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(fields: { pattern?: unknown; symbols?: string[]; variables?: string[]; commutative?: boolean | null;
    associative?: boolean | null; suffixes?: Map<string, string> | null; computes?: unknown; name?: string | null;
    description?: string | null; parameters?: Map<string, ParameterData> } = {}) {
    this.pattern = fields.pattern ?? null;
    this.symbols = fields.symbols ?? [];
    this.variables = fields.variables ?? [];
    this.commutative = fields.commutative ?? null;
    this.associative = fields.associative ?? null;
    this.suffixes = fields.suffixes ?? null;
    this.computes = fields.computes ?? null;
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters)];
    const pattern = this.pattern;
    if (!(pattern instanceof PatternData)) {
      problems.push("a collector needs a pattern");
    } else {
      for (const [plural, names, held] of [["symbols", this.symbols, pattern.symbols], ["variables", this.variables, pattern.variables]] as const) {
        const missing = names.filter((name) => !held.has(name));
        if (missing.length > 0) problems.push(`it collects ${plural} ${repr(missing)}, which its pattern does not declare`);
      }
    }
    if (!this.commutative && !this.associative) {
      problems.push("a collector is commutative or associative, so that its result does not depend on the order frames arrive in");
    }
    if (this.suffixes !== null) {
      const keys = [...this.suffixes.keys()];
      if (keys.length !== 2 || !this.suffixes.has("current") || !this.suffixes.has("next")) {
        problems.push("a collector's suffixes are 'current' and 'next'");
      } else if (this.suffixes.get("current") === this.suffixes.get("next")) {
        problems.push("a collector's 'current' and 'next' suffixes differ");
      }
    }
    if (this.computes !== null) {
      if (!(this.computes instanceof ExpressionData)) problems.push("what a collector computes is an expression");
      else problems.push(...this.computes.validate().map((p) => `computes: ${p}`));
    }
    return problems;
  }
}

export namespace OfCollector {
  /** A pattern used to fold frames. */
  export const Data = CollectorData;
  export type Data = CollectorData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.CollectorBuilder;
  export type Builder = Builders.CollectorBuilder;
}

// --- OfAny.Value: a value of any schema ---

const ALL_FORMS = ["bool", "int", "float", "text", "mapping", "list"];

/** The plain forms a value of `schema` may take: "bool", "int", "float", "text", "mapping" or "list". A float may be
 * text (`"NaN"`, `"Infinity"`), bytes are text (base64), a dense tensor a mapping where written flat, and a scalar that
 * is not a basic scalar any form. */
export function plain_forms(schema: unknown): Set<string> {
  const held = schema;
  if (held instanceof ScalarData) {
    const forms = new Map<unknown, string[]>([[Boolean, ["bool"]], [BigInt, ["int"]], [Number, ["float", "text"]],
      [String, ["text"]], [Uint8Array, ["text"]]]);
    return new Set(forms.get(held.type) ?? ALL_FORMS);
  }
  if (held instanceof ContainerData) {
    const index = held.index;
    if (held.arrangement === "dict" && index instanceof ScalarData && index.type === String) return new Set(["mapping"]);
    const tensor = held.arrangement === "dense" && index instanceof ObjectData;
    return new Set(tensor ? ["list", "mapping"] : ["list"]);
  }
  if (held instanceof AnyValueData) {
    return held.schemas.length > 0 ? new Set(held.schemas.flatMap((t) => [...plain_forms(t)])) : new Set(["mapping"]);
  }
  return new Set(["mapping"]);
}

/** A schema in a message: its name, or its kind. */
function shownType(schema: unknown): string {
  const held = schema;
  const name = (schema as { name?: unknown }).name;
  if (typeof name === "string") return name;
  return held instanceof ObjectData ? "a value object" : held instanceof UnionData ? "a union"
    : held instanceof IntersectionData ? "an intersection" : held instanceof ContainerData ? "a container" : "a schema";
}

/** A value of any schema: of one of `schemas`, where they are given (an `OfAny` restricted to them), else of any
 * schema. Restricted, a value is written bare, its schema the one whose plain form it takes; unrestricted, it is tagged
 * with its schema, a basic scalar's tag or a registered schema's name. */
class AnyValueData {
  schemas: AnyData[];
  name: string | null;
  description: string | null;
  parameters: Map<string, ParameterData>;

  constructor(schemas: readonly unknown[] = [], fields: { name?: string | null; description?: string | null;
    parameters?: Map<string, ParameterData> } = {}) {
    this.schemas = [...schemas] as AnyData[];
    this.name = fields.name ?? null;
    this.description = fields.description ?? null;
    this.parameters = fields.parameters ?? new Map();
  }

  equals(other: unknown): boolean {
    return other === this;
  }

  validate(): string[] {
    return once(this, () => this.problems());
  }

  private problems(): string[] {
    const problems = [...nameProblems(this.name), ...descriptionProblems(this.description), ...parameterProblems(this.parameters)];
    const valid: AnyData[] = [];
    for (const schema of this.schemas as unknown[]) {
      if (!isAnyData(schema)) problems.push(`an OfAny holds schemas, got ${repr(schema)}`);
      else if (schema instanceof AnyValueData) problems.push("an OfAny holds schemas of other kinds, not an OfAny");
      else {
        valid.push(schema);
        problems.push(...validateSchema(schema).map((p) => `${shownType(schema)}: ${p}`));
      }
    }
    valid.forEach((a, i) => {
      for (const b of valid.slice(i + 1)) {
        const forms = plain_forms(b);
        if ([...plain_forms(a)].some((form) => forms.has(form))) {
          problems.push(`an OfAny's schemas ${shownType(a)} and ${shownType(b)} are not told apart on the wire`);
        }
      }
    });
    return problems;
  }
}

// --- OfAny ---

type AnyData = ScalarData | ObjectData | UnionData | IntersectionData | ContainerData | AnyValueData;

function isAnyData(value: unknown): value is AnyData {
  return value instanceof ScalarData || value instanceof ObjectData || value instanceof UnionData ||
    value instanceof IntersectionData || value instanceof ContainerData || value instanceof AnyValueData;
}

function kindOf(value: unknown): unknown {
  return value === null || value === undefined ? null : (value as object).constructor;
}

// --- Refinement ---

function kindNoun(schema: unknown): string {
  const nouns: [Function, string][] = [[ScalarData, "a scalar schema"], [ObjectData, "an object schema"],
    [ContainerData, "a container schema"], [UnionData, "a union"], [IntersectionData, "an intersection"],
    [AnyValueData, "a value of any schema"]];
  return nouns.find(([kind]) => schema instanceof kind)?.[1] ?? "something holding no values";
}

/** Whether `schema` is `base` or refines it, directly or not: a value of it is then a value of `base`. */
export function is_a(schema: unknown, base: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = schema;
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (current === base) return true;
    seen.add(current);
    current = (current as { refines?: unknown }).refines ?? null;
  }
  return false;
}

/** Whether validation confirms that every value of `fresh` is a value of `old`: the same schema, a refinement of it,
 * or a scalar or container schema whose parts each narrow `old`'s. */
function narrows(fresh: unknown, old: unknown): boolean {
  if (fresh === old || is_a(fresh, old)) return true;
  if (fresh instanceof ScalarData && old instanceof ScalarData) return fresh.type !== null && fresh.type === old.type;
  if (fresh instanceof ContainerData && old instanceof ContainerData) {
    return narrows(fresh.index, old.index) && narrows(fresh.element, old.element);
  }
  return false;
}

/** A refinement's problems: it refines a schema of its own kind, not itself, and narrows what it redeclares. */
function refinementProblems(schema: ObjectData | ContainerData): string[] {
  if (schema.refines === null) return [];
  const base = schema.refines;
  if (!(base instanceof (schema.constructor as new () => unknown))) {
    return [`refines ${kindNoun(base)}: a refinement stays within its kind, container or object`];
  }
  if (is_a(base, schema)) return ["refines itself"];
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
    if (own !== undefined && own !== prop && !narrows(own.schema, prop.schema)) {
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

/** The object schemas that refine `schema` directly. */
export function _refinements(schema: ObjectData): ObjectData[] {
  return REFINEMENTS.get(schema) ?? [];
}

/** Gives an object schema the members of the schema it refines, which it has not redeclared, and passes the change on
 * to the schemas that refine it. */
export function settle(schema: ObjectData): ObjectData {
  const base = schema.refines;
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
    if (refinement.refines === schema) settle(refinement);
  }
  return schema;
}

function validateSchema(schema: unknown): string[] {
  if (!isAnyData(schema)) return [`not a schema: ${repr(schema)}`];
  return schema.validate();
}

/** The schemas of the values a value of `schema` holds: a value object's properties, a union's branches, an
 * intersection's parts. */
function membersOf(schema: unknown): unknown[] {
  if (schema instanceof ContainerData) return [schema.index, schema.element];
  if (schema instanceof AnyValueData) return [...schema.schemas];
  return schema instanceof ObjectData || schema instanceof UnionData || schema instanceof IntersectionData
    ? [...schema.properties.values()].map((member) => member.schema) : [];
}

/** Problems with a property's schema as a value: an object held by a property is a value object, so its schema is
 * not a reference object schema; nor are the schemas of the objects a union or an intersection holds. `seen` holds the
 * schemas on the way, so that one that holds itself is checked once. */
function embeddedProblems(schema: unknown, seen: ReadonlySet<unknown> = new Set()): string[] {
  if (schema instanceof ObjectData) return schema.ref ? ["a reference object schema cannot be a property's schema"] : [];
  if (seen.has(schema)) return [];
  const inner = new Set([...seen, schema]);
  return sortedStrings(new Set(membersOf(schema).flatMap((member) => embeddedProblems(member, inner))));
}

export namespace OfAny {
  /** Where a schema of any kind is expected. `OfAny.Data` is any schema kind's data; `OfAny.Value`, the kind of a value
   * of any schema, or of one of the schemas it is restricted to. */
  export type Data = AnyData;
  export const Value = AnyValueData;
  export type Value = AnyValueData;
  /** Its builder and its meta-schema, `Builders`': importing the package installs them here. */
  export declare const Builder: typeof Builders.AnyValueBuilder;
  export type Builder = Builders.AnyValueBuilder;
}

export { nameFor as _name_for, numberOf as _number_of };

/** Whether a schema is of a kind a module defines and a store registers by name. */
export function _defined(schema: unknown): boolean {
  return isAnyData(schema) || schema instanceof RelationData || schema instanceof PatternData
    || schema instanceof ExpressionData || schema instanceof CollectorData;
}
