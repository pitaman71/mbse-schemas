/**
 * Expressions: serializable expressions, for union discriminators and, later, constraints. `Evaluators` evaluates
 * them.
 *
 * - `OfLiteral`: a native value.
 * - `OfOperation`: a named operation applied to ordered arguments, e.g. `eq(a, b)`. The vocabulary of names is open;
 *   the core operations (`CORE`) are the ones every binding evaluates. See FRAMEWORK.md, "Expressions".
 * - `OfVariable`: the value bound to a name.
 * - `OfLet`: binds a name to the value of one expression within another, its body.
 * - `OfAny`: any of these.
 *
 * As for schemas, each kind has `Data`, a `Builder` finalized by `create()`, `clone()` or `update()` (none validate),
 * a `Spec` (a value, or a callable that takes and returns the builder) and `resolve`. Each also has a `Schema`, the
 * meta-schema that describes its data as an ordinary object schema, so expressions serialize, validate and compare
 * like any other objects:
 *
 * - Every kind's schema declares `kind`, a tag with a fixed value: 'literal', 'operation', 'variable' or 'let'.
 * - `OfLiteral.Schema` declares one optional property per native type (`int`, `float`, `str`, `bool`, `bytes`); a
 *   literal sets exactly one.
 * - `OfOperation.Schema`, `OfVariable.Schema` and `OfLet.Schema` declare `name`.
 * - Operations and lets declare the adjacency `arguments` to `Arguments`, a relation linking a `parent` to an
 *   `argument` with an `index`; `unique(argument)` makes the parent and index determine the argument. A let's value is
 *   its argument 0 and its body its argument 1.
 * - Every kind declares `used_by`: the same relation seen from the argument. The parents' arguments imply it, so data
 *   never writes it and builders ignore entries added to it.
 * - `OfAny.Schema` is the union of the four, discriminated by the tag: `eq(get(this, 'kind'), 'literal')`, and so on.
 *
 * The meta-schemas are registered with `Proxies` as 'Expressions.OfLiteral', 'Expressions.OfOperation',
 * 'Expressions.OfVariable', 'Expressions.OfLet' and 'Expressions.Arguments', the names snapshots carry. `Builders`
 * rebuilds `Data` from snapshots, e.g. `Json.FromJSON(Expressions.Builders).Reachable(Expressions.OfLet.Schema, text)`.
 * `Data` is `Visitable`; builders implement `Visitors.OfObject`.
 *
 * `Term`s write expressions with methods: `variable('this').age.ge(18n)` is `ge(get(this, 'age'), 18)`.
 */

import { AttributeError, KeyError, LookupError, ValueError } from "./Errors.js";
import * as Proxies from "./Proxies.js";
import { isClassLike, repr, tokenName, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type * as Visitors from "./Visitors.js";
import type { Callback, Native } from "./Visitors.js";

export const LITERAL = "Expressions.OfLiteral";
export const OPERATION = "Expressions.OfOperation";
export const VARIABLE = "Expressions.OfVariable";
export const LET = "Expressions.OfLet";
export const ARGUMENTS = "Expressions.Arguments";

const NATIVES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["int", BigInt],
  ["float", Number],
  ["str", String],
  ["bool", Boolean],
  ["bytes", Uint8Array],
]);

/** The core operations and their numbers of arguments. */
export const CORE: ReadonlyMap<string, number> = new Map([
  ["get", 2], ["has", 2],
  ["eq", 2], ["ne", 2], ["lt", 2], ["le", 2], ["gt", 2], ["ge", 2],
  ["and", 2], ["or", 2], ["not", 1], ["implies", 2],
  ["add", 2], ["sub", 2], ["mul", 2], ["neg", 1],
]);

/** The name of `value`'s native type, which is also the literal property that holds it; null if not native. */
function nativeName(value: unknown): string | null {
  const name = typeName(value);
  return NATIVES.has(name) && Schemas.isNativeOf(NATIVES.get(name), value) ? name : null;
}

interface HasProperty {
  property(name: string, callback: Callback<Visitors.OfProperty>): unknown;
}

function setNative(visitor: HasProperty, name: string, value: Native): void {
  visitor.property(name, (p) => p.value((a) => a.as_native((n) => n.set(value))));
}

let nextIdentity = 0;

// --- Data ---

/** Shared by every kind's data: identity, schema name, and writing the tag. */
abstract class Data implements Visitors.Visitable {
  static readonly KIND: string;
  static readonly NAME: string;
  static readonly FIELDS: readonly string[];
  private readonly id = ++nextIdentity;

  private get type(): typeof Data {
    return this.constructor as typeof Data;
  }

  identity(): unknown {
    return this.id;
  }

  schema_name(): string {
    return this.type.NAME;
  }

  accept(visitor: Visitors.OfObject): void {
    setNative(visitor, "kind", this.type.KIND);
    this.acceptOwn(visitor);
  }

  /** Writes the kind's own properties and arguments. */
  protected abstract acceptOwn(visitor: Visitors.OfObject): void;

  /** Problems with this expression. Variables must be bound by an enclosing let or be in `bound`. With `core`, every
   * operation must be a core operation. */
  validate(options: { bound?: Iterable<string>; core?: boolean } = {}): string[] {
    return problems(this, new Set(options.bound ?? []), options.core ?? false, new Set());
  }
}

function writeArgument(visitor: Visitors.OfObject, index: number, argument: unknown): void {
  visitor.adjacency("arguments", (a) => a.add((entry) => {
    entry.link("argument", (k) => k.set(argument as Visitors.Visitable));
    setNative(entry, "index", BigInt(index));
  }));
}

class LiteralData extends Data {
  static override readonly KIND = "literal";
  static override readonly NAME = LITERAL;
  static override readonly FIELDS = ["value"];

  constructor(public value: unknown = null) {
    super();
  }

  /** Writes the value into the property named after its native type. */
  protected acceptOwn(visitor: Visitors.OfObject): void {
    if (this.value === null) return;
    const name = nativeName(this.value);
    if (name === null) throw new TypeError(`a literal must hold a native value, got ${typeName(this.value)}`);
    setNative(visitor, name, this.value as Native);
  }
}

class OperationData extends Data {
  static override readonly KIND = "operation";
  static override readonly NAME = OPERATION;
  static override readonly FIELDS = ["name", "arguments"];
  name: unknown;
  arguments: readonly unknown[];

  constructor(name: unknown = null, args: readonly unknown[] = []) {
    super();
    this.name = name;
    this.arguments = args;
  }

  /** Writes the name, then one `arguments` entry per argument, in order, with its index. */
  protected acceptOwn(visitor: Visitors.OfObject): void {
    if (this.name !== null) setNative(visitor, "name", this.name as Native);
    this.arguments.forEach((argument, index) => writeArgument(visitor, index, argument));
  }
}

class VariableData extends Data {
  static override readonly KIND = "variable";
  static override readonly NAME = VARIABLE;
  static override readonly FIELDS = ["name"];

  constructor(public name: unknown = null) {
    super();
  }

  protected acceptOwn(visitor: Visitors.OfObject): void {
    if (this.name !== null) setNative(visitor, "name", this.name as Native);
  }
}

class LetData extends Data {
  static override readonly KIND = "let";
  static override readonly NAME = LET;
  static override readonly FIELDS = ["name", "value", "body"];

  constructor(public name: unknown = null, public value: unknown = null, public body: unknown = null) {
    super();
  }

  /** Writes the name, then the value as argument 0 and the body as argument 1. */
  protected acceptOwn(visitor: Visitors.OfObject): void {
    if (this.name !== null) setNative(visitor, "name", this.name as Native);
    [this.value, this.body].forEach((argument, index) => {
      if (argument !== null) writeArgument(visitor, index, argument);
    });
  }
}

type AnyData = LiteralData | OperationData | VariableData | LetData;

function isExpression(value: unknown): value is AnyData {
  return value instanceof LiteralData || value instanceof OperationData || value instanceof VariableData
    || value instanceof LetData;
}

function nameProblems(what: string, name: unknown): string[] {
  if (name === null || name === "") return [`${what} needs a name`];
  if (typeof name !== "string") return [`${what}'s name must be a str, got ${typeName(name)}`];
  return [];
}

/** Problems with `expression`; `active` holds the expressions being checked, to find cycles. */
function problems(expression: unknown, bound: ReadonlySet<string>, core: boolean, active: Set<unknown>): string[] {
  if (expression instanceof LiteralData) {
    if (expression.value === null) return ["a literal needs a value"];
    if (nativeName(expression.value) === null) {
      return [`a literal must hold a native value, got ${typeName(expression.value)}`];
    }
    return [];
  }
  if (!isExpression(expression)) return [`not an expression: ${repr(expression)}`];
  if (expression instanceof VariableData) {
    const found = nameProblems("a variable", expression.name);
    if (found.length === 0 && !bound.has(expression.name as string)) {
      found.push(`variable ${repr(expression.name)} is not bound`);
    }
    return found;
  }
  if (active.has(expression)) return ["the expression contains a cycle"];
  active.add(expression);
  let found: string[];
  if (expression instanceof LetData) {
    found = nameProblems("a let", expression.name);
    const inner = found.length === 0 ? new Set([...bound, expression.name as string]) : bound;
    for (const [part, scope] of [["value", bound], ["body", inner]] as const) {
      const child = expression[part];
      if (child === null) found.push(`a let needs a ${part}`);
      else found.push(...problems(child, scope, core, active).map((problem) => `${part}: ${problem}`));
    }
  } else {
    const operation = expression as OperationData;
    found = nameProblems("an operation", operation.name);
    const name = operation.name as string;
    const count = operation.arguments.length;
    const arity = CORE.get(name);
    if (found.length === 0 && arity !== undefined && arity !== count) {
      found.push(`${name} takes ${arity} arguments, got ${count}`);
    } else if (found.length === 0 && core && arity === undefined) {
      found.push(`${repr(name)} is not a core operation`);
    }
    operation.arguments.forEach((argument, i) => {
      found.push(...problems(argument, bound, core, active).map((problem) => `argument ${i}: ${problem}`));
    });
  }
  active.delete(expression);
  return found;
}

// --- Builders: Visitors that build Data ---

/** `Visitors.OfProperty`, `OfAny` and `OfNative` over one native-typed field of a builder. */
class _Field implements Visitors.OfProperty, Visitors.OfAny, Visitors.OfNative {
  constructor(private readonly fieldName: string, private readonly native: unknown,
    private readonly read: () => unknown, private readonly write: (value: unknown) => void) {}

  name(): string {
    return this.fieldName;
  }

  has(): boolean {
    return Schemas.isNativeOf(this.native, this.read());
  }

  get(): Native {
    if (!this.has()) throw new AttributeError(`property ${repr(this.fieldName)} is not set`);
    return this.read() as Native;
  }

  set(value: Native): _Field {
    if (!Schemas.isNativeOf(this.native, value)) {
      throw new TypeError(`expected ${tokenName(this.native)}, got ${typeName(value)}`);
    }
    this.write(value);
    return this;
  }

  clear(): _Field {
    if (this.has()) this.write(null);
    return this;
  }

  value(callback: Callback<Visitors.OfAny>): _Field {
    callback(this);
    return this;
  }

  as_native(callback: Callback<Visitors.OfNative>): _Field {
    callback(this);
    return this;
  }

  as_object(_callback: Callback<Visitors.OfObject>): _Field {
    throw new TypeError(`property ${repr(this.fieldName)} is native`);
  }

  as_union(_callback: Callback<Visitors.OfUnion>): _Field {
    throw new TypeError(`property ${repr(this.fieldName)} is native`);
  }

  as_intersection(_callback: Callback<Visitors.OfIntersection>): _Field {
    throw new TypeError(`property ${repr(this.fieldName)} is native`);
  }
}

/** `Visitors.OfLink` over the one link an argument entry sets. */
class _Link implements Visitors.OfLink {
  constructor(private readonly entry: _Argument) {}

  name(): string {
    return this.entry.other;
  }

  target(callback: Callback<Visitors.Visitable>): _Link {
    if (this.entry.target === null) throw new ValueError(`link ${repr(this.entry.other)} is not set`);
    callback(this.entry.target as Visitors.Visitable);
    return this;
  }

  set(target: Visitors.Visitable): _Link {
    this.entry.target = target;
    return this;
  }
}

/** `Visitors.OfEntry` for one entry of `Arguments`, seen from the end that fills `me`: it sets the other link and the
 * `index`. */
class _Argument implements Visitors.OfEntry {
  readonly other: string;

  constructor(me: string, public target: unknown = null, public index: bigint | null = null) {
    this.other = me === "parent" ? "argument" : "parent";
  }

  private indexField(): _Field {
    return new _Field("index", BigInt, () => this.index, (value) => { this.index = value as bigint | null; });
  }

  links(callback: Callback<Visitors.OfLink>): _Argument {
    callback(new _Link(this));
    return this;
  }

  link(name: string, callback: Callback<Visitors.OfLink>): _Argument {
    if (name !== this.other) throw new KeyError(`${repr(name)} is not a link this entry can set`);
    callback(new _Link(this));
    return this;
  }

  properties(callback: Callback<Visitors.OfProperty>): _Argument {
    if (this.index !== null) callback(this.indexField());
    return this;
  }

  has(name: string): boolean {
    return name === "index" && this.index !== null;
  }

  property(name: string, callback: Callback<Visitors.OfProperty>): _Argument {
    if (name !== "index") throw new KeyError(`unknown property ${repr(name)}`);
    callback(this.indexField());
    return this;
  }

  clear(name: string): _Argument {
    if (name === "index") this.index = null;
    return this;
  }
}

/** `Visitors.OfAdjacency` over a parent's `arguments`, or over `used_by`, whose entries are ignored (the parents'
 * arguments imply them). */
class _Adjacency implements Visitors.OfAdjacency {
  constructor(private readonly adjacencyName: string, private readonly own: string,
    private readonly list: _Argument[] | null) {}

  name(): string {
    return this.adjacencyName;
  }

  me(): string {
    return this.own;
  }

  entries(callback: Callback<Visitors.OfEntry>): _Adjacency {
    for (const entry of [...(this.list ?? [])]) callback(entry);
    return this;
  }

  add(callback: Callback<Visitors.OfEntry>): _Adjacency {
    const entry = new _Argument(this.own);
    callback(entry);
    this.list?.push(entry);
    return this;
  }

  remove(entry: Visitors.OfEntry): _Adjacency {
    if (this.list !== null) this.list.splice(0, this.list.length, ...this.list.filter((e) => e !== entry));
    return this;
  }
}

function checkTarget(entry: _Argument): AnyData {
  if (entry.target === null) throw new ValueError("link 'argument' is not set");
  if (!isExpression(entry.target)) {
    throw new TypeError(`an argument must be an expression, got ${typeName(entry.target)}`);
  }
  return entry.target;
}

function noArguments(method: string, args: unknown[]): void {
  if (args.length > 0) throw new TypeError(`${method}() takes no arguments (${args.length} given)`);
}

/**
 * Shared by every kind's builder: `create()` / `clone()` / `update()` with the rules and messages of every builder,
 * and `Visitors.OfObject` over the tag `kind`, the kind's own native properties (`ownProperties`) and, for parents,
 * the `arguments` entries. Subclasses define `make()`, which builds new data from the builder state.
 */
abstract class Builder<D extends Data> implements Visitors.OfObject {
  protected readonly source: D | undefined;
  protected readonly values = new Map<string, unknown>();
  protected list: _Argument[] = [];

  constructor(protected readonly data: typeof Data, protected readonly ownProperties: ReadonlyMap<string, unknown>,
    protected readonly parent: boolean, instance?: D) {
    if (instance !== undefined && (instance as object | null)?.constructor !== data) {
      throw new TypeError(`expected ${data.KIND} data to build from, got ${typeName(instance)}`);
    }
    this.source = instance;
  }

  protected abstract make(): D;

  create(...args: unknown[]): D {
    noArguments("create", args);
    if (this.source !== undefined) {
      throw new ValueError("create() is only valid without a source instance; use clone() or update()");
    }
    return this.make();
  }

  clone(...args: unknown[]): D {
    noArguments("clone", args);
    if (this.source === undefined) throw new ValueError("clone() is only valid with a source instance");
    return this.make();
  }

  update(...args: unknown[]): D {
    noArguments("update", args);
    if (this.source === undefined) throw new ValueError("update() is only valid with a source instance");
    const made = this.make() as unknown as Record<string, unknown>;
    for (const name of this.data.FIELDS) (this.source as unknown as Record<string, unknown>)[name] = made[name];
    return this.source;
  }

  private checkKind(kind: unknown): void {
    if (kind !== null && kind !== this.data.KIND) {
      throw new ValueError(`expected kind ${repr(this.data.KIND)}, got ${repr(kind)}`);
    }
  }

  protected field(name: string): _Field {
    if (name === "kind") return new _Field("kind", String, () => this.data.KIND, (kind) => this.checkKind(kind));
    return new _Field(name, this.ownProperties.get(name), () => this.values.get(name) ?? null,
      (value) => { this.values.set(name, value); });
  }

  properties(callback: Callback<Visitors.OfProperty>): this {
    for (const name of ["kind", ...this.ownProperties.keys()]) {
      if (this.has(name)) callback(this.field(name));
    }
    return this;
  }

  has(name: string): boolean {
    return name === "kind" || (this.ownProperties.has(name) && this.field(name).has());
  }

  property(name: string, callback: Callback<Visitors.OfProperty>): this {
    if (name !== "kind" && !this.ownProperties.has(name)) throw new KeyError(`unknown property ${repr(name)}`);
    callback(this.field(name));
    return this;
  }

  clear(name: string): this {
    if (this.ownProperties.has(name)) this.field(name).clear();
    return this;
  }

  adjacencies(callback: Callback<Visitors.OfAdjacency>): this {
    for (const name of this.parent ? ["arguments", "used_by"] : ["used_by"]) this.adjacency(name, callback);
    return this;
  }

  adjacency(name: string, callback: Callback<Visitors.OfAdjacency>): this {
    if (name === "arguments" && this.parent) callback(new _Adjacency("arguments", "parent", this.list));
    else if (name === "used_by") callback(new _Adjacency("used_by", "argument", null));
    else throw new KeyError(`unknown adjacency ${repr(name)}`);
    return this;
  }
}

/** Builds an `OfLiteral.Data`. DSL: `.value(native)`. As a `Visitors.OfObject`, it has one property per native type,
 * and setting one replaces the value. */
class LiteralBuilder extends Builder<LiteralData> {
  private recorded: unknown;

  constructor(instance?: LiteralData) {
    super(LiteralData, NATIVES, false, instance);
    this.recorded = instance === undefined ? null : instance.value;
  }

  value(value: Native): LiteralBuilder {
    this.recorded = value;
    return this;
  }

  protected override field(name: string): _Field {
    if (name === "kind") return super.field(name);
    return new _Field(name, NATIVES.get(name), () => this.recorded, (value) => { this.recorded = value; });
  }

  protected make(): LiteralData {
    return new LiteralData(this.recorded);
  }
}

const NAME_PROPERTY: ReadonlyMap<string, unknown> = new Map([["name", String]]);

/** A builder whose kind has a `name`. DSL: `.name(str)`. */
abstract class NamedBuilder<D extends OperationData | VariableData | LetData> extends Builder<D> {
  constructor(data: typeof Data, parent: boolean, instance?: D) {
    super(data, NAME_PROPERTY, parent, instance);
    if (instance !== undefined) this.values.set("name", instance.name);
  }

  name(name: string): this {
    this.values.set("name", name);
    return this;
  }
}

/** Builds an `OfOperation.Data`. DSL: `.name(str)` and `.arguments(...specs)`, which appends `OfAny.Spec`s (a native
 * value is a literal). As a `Visitors.OfObject`, arguments are `arguments` entries, ordered by `index`. */
class OperationBuilder extends NamedBuilder<OperationData> {
  constructor(instance?: OperationData) {
    super(OperationData, true, instance);
    if (instance !== undefined) {
      this.list = instance.arguments.map((arg, i) => new _Argument("parent", arg, BigInt(i)));
    }
  }

  arguments(...specs: OfAny.Spec[]): OperationBuilder {
    for (const spec of specs) this.list.push(new _Argument("parent", OfAny.resolve(spec), BigInt(this.list.length)));
    return this;
  }

  protected make(): OperationData {
    const last = BigInt(this.list.length);
    const key = (entry: _Argument) => entry.index ?? last;
    const ordered = [...this.list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    return new OperationData(this.values.get("name") ?? null, ordered.map(checkTarget));
  }
}

/** Builds an `OfVariable.Data`. DSL: `.name(str)`. */
class VariableBuilder extends NamedBuilder<VariableData> {
  constructor(instance?: VariableData) {
    super(VariableData, false, instance);
  }

  protected make(): VariableData {
    return new VariableData(this.values.get("name") ?? null);
  }
}

/** Builds an `OfLet.Data`. DSL: `.name(str)`, `.value(spec)` and `.body(spec)`, each an `OfAny.Spec`. As a
 * `Visitors.OfObject`, the value is the `arguments` entry with index 0 and the body the one with index 1. */
class LetBuilder extends NamedBuilder<LetData> {
  constructor(instance?: LetData) {
    super(LetData, true, instance);
    if (instance !== undefined) {
      this.list = [instance.value, instance.body].flatMap((part, i) =>
        (part === null ? [] : [new _Argument("parent", part, BigInt(i))]));
    }
  }

  private part(index: bigint, spec: OfAny.Spec): LetBuilder {
    this.list = this.list.filter((entry) => entry.index !== index);
    this.list.push(new _Argument("parent", OfAny.resolve(spec), index));
    return this;
  }

  value(spec: OfAny.Spec): LetBuilder {
    return this.part(0n, spec);
  }

  body(spec: OfAny.Spec): LetBuilder {
    return this.part(1n, spec);
  }

  protected make(): LetData {
    const parts: (AnyData | null)[] = [null, null];
    for (const entry of this.list) {
      if (entry.index !== 0n && entry.index !== 1n) {
        throw new ValueError(`a let's value is argument 0 and its body argument 1, got index ${repr(entry.index)}`);
      }
      parts[Number(entry.index)] = checkTarget(entry);
    }
    return new LetData(this.values.get("name") ?? null, parts[0], parts[1]);
  }
}

/** Selects a kind through `as_<kind>(spec)`. Finalizing yields that kind's data. */
class AnyBuilder {
  private readonly source: AnyData | undefined;
  private selected: AnyData | undefined;

  constructor(instance?: AnyData) {
    this.source = instance;
  }

  as_literal(spec: OfLiteral.Spec): AnyBuilder {
    this.selected = OfLiteral.resolve(spec);
    return this;
  }

  as_operation(spec: OfOperation.Spec): AnyBuilder {
    this.selected = OfOperation.resolve(spec);
    return this;
  }

  as_variable(spec: OfVariable.Spec): AnyBuilder {
    this.selected = OfVariable.resolve(spec);
    return this;
  }

  as_let(spec: OfLet.Spec): AnyBuilder {
    this.selected = OfLet.resolve(spec);
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

  /** The selected expression, or a shallow copy of the source (arguments are shared, not copied). */
  clone(...args: unknown[]): AnyData {
    noArguments("clone", args);
    if (this.source === undefined) throw new ValueError("clone() is only valid with a source instance");
    if (this.selected !== undefined) return this.selected;
    const type = this.source.constructor as typeof Data;
    const fields = type.FIELDS.map((name) => (this.source as unknown as Record<string, unknown>)[name]);
    return new (type as unknown as new (...fields: unknown[]) => AnyData)(...fields);
  }

  update(...args: unknown[]): AnyData {
    noArguments("update", args);
    if (this.source === undefined) throw new ValueError("update() is only valid with a source instance");
    const selected = this.requireSelected();
    if (selected.constructor !== this.source.constructor) {
      throw new TypeError("update() cannot change the kind of the source expression");
    }
    const target = this.source as unknown as Record<string, unknown>;
    const from = selected as unknown as Record<string, unknown>;
    for (const name of (selected.constructor as typeof Data).FIELDS) target[name] = from[name];
    return this.source;
  }
}

// --- Specs ---

/** Resolves a `Spec`: data is used as is, a `Term` gives its data, and a callable is given a new builder and must
 * return it. */
function resolveSpec<D>(spec: unknown, isData: (value: unknown) => value is D, builder: () => unknown,
  expected: string): D {
  if (spec instanceof TermTarget) spec = spec.data;
  if (isData(spec)) return spec;
  if (isClassLike(spec)) throw new TypeError(`a class is not a Spec here, got ${tokenName(spec)}`);
  if (typeof spec === "function") {
    const built = (spec as (b: unknown) => unknown)(builder());
    if (built === null || built === undefined || typeof (built as { create?: unknown }).create !== "function") {
      throw new TypeError(`a Spec callable must return its builder, got ${repr(built)}`);
    }
    return (built as { create(): D }).create();
  }
  throw new TypeError(`expected ${expected} or a callable taking its builder, got ${repr(spec)}`);
}

// --- Terms: writing expressions with methods ---

/** The methods of a `Term`. */
class TermTarget {
  constructor(readonly data: AnyData) {}

  get(name: string): Term {
    return operation("get", this as unknown as Term, name);
  }

  has(name: string): Term {
    return operation("has", this as unknown as Term, name);
  }

  eq(other: OfAny.Spec): Term {
    return operation("eq", this as unknown as Term, other);
  }

  ne(other: OfAny.Spec): Term {
    return operation("ne", this as unknown as Term, other);
  }

  lt(other: OfAny.Spec): Term {
    return operation("lt", this as unknown as Term, other);
  }

  le(other: OfAny.Spec): Term {
    return operation("le", this as unknown as Term, other);
  }

  gt(other: OfAny.Spec): Term {
    return operation("gt", this as unknown as Term, other);
  }

  ge(other: OfAny.Spec): Term {
    return operation("ge", this as unknown as Term, other);
  }

  and_(other: OfAny.Spec): Term {
    return operation("and", this as unknown as Term, other);
  }

  or_(other: OfAny.Spec): Term {
    return operation("or", this as unknown as Term, other);
  }

  not_(): Term {
    return operation("not", this as unknown as Term);
  }

  implies(other: OfAny.Spec): Term {
    return operation("implies", this as unknown as Term, other);
  }

  add(other: OfAny.Spec): Term {
    return operation("add", this as unknown as Term, other);
  }

  sub(other: OfAny.Spec): Term {
    return operation("sub", this as unknown as Term, other);
  }

  mul(other: OfAny.Spec): Term {
    return operation("mul", this as unknown as Term, other);
  }

  neg(): Term {
    return operation("neg", this as unknown as Term);
  }
}

/** An expression written with methods. `.name` reads a property (`get`); use `.get(name)` for names that are also
 * methods, such as `eq`. A `Term` is an `OfAny.Spec`; `.data` is its expression. Property names come from schemas at
 * runtime, so they are typed loosely, like proxy properties. */
export type Term = TermTarget & { readonly [property: string]: any };

function term(data: AnyData): Term {
  return new Proxy(new TermTarget(data), {
    get(target, property, receiver) {
      if (typeof property === "symbol" || property in target) return Reflect.get(target, property, receiver);
      if (property === "then" || property === "toJSON") return undefined; // probes by `await` and `JSON.stringify`
      return target.get(property);
    },
  }) as Term;
}

/** The variable `name`. */
export function variable(name: string): Term {
  return term(new VariableData(name));
}

/** The literal `value`. */
export function literal(value: Native): Term {
  return term(new LiteralData(value));
}

/** `body`, with `name` bound to the value of `value`. */
export function let_(name: string, value: OfAny.Spec, body: OfAny.Spec): Term {
  return term(new LetData(name, OfAny.resolve(value), OfAny.resolve(body)));
}

/** The operation `name` applied to `args`; for operations outside the core, or without a method. */
export function operation(name: string, ...args: OfAny.Spec[]): Term {
  return term(new OperationData(name, args.map((arg) => OfAny.resolve(arg))));
}

// --- Meta-schemas ---

type BranchBuilder = Parameters<Parameters<Schemas.OfUnion.Builder["branches"]>[0]>[0];

function nativeProperty(name: string, native: unknown) {
  return (p: Schemas.OfProperty.Builder) => p.name(name).of((t) => t.as_native(native as Schemas.OfNative.Spec));
}

const ARGUMENTS_SCHEMA = new Schemas.OfRelation.Builder().links("parent", "argument")
  .properties(nativeProperty("index", BigInt)).unique("argument").create();
const KIND = nativeProperty("kind", String);
const NAME = nativeProperty("name", String);
const ARGUMENTS_ADJACENCY = (r: Schemas.OfAdjacency.Builder) => r.name("arguments").of(ARGUMENTS_SCHEMA).me("parent");
const USED_BY = (r: Schemas.OfAdjacency.Builder) => r.name("used_by").of(ARGUMENTS_SCHEMA).me("argument");
const LITERAL_SCHEMA = new Schemas.OfObject.Builder()
  .properties(KIND, ...[...NATIVES].map(([name, native]) => nativeProperty(name, native))).relations(USED_BY).create();
const OPERATION_SCHEMA = new Schemas.OfObject.Builder().properties(KIND, NAME).relations(ARGUMENTS_ADJACENCY, USED_BY)
  .create();
const VARIABLE_SCHEMA = new Schemas.OfObject.Builder().properties(KIND, NAME).relations(USED_BY).create();
const LET_SCHEMA = new Schemas.OfObject.Builder().properties(KIND, NAME).relations(ARGUMENTS_ADJACENCY, USED_BY)
  .create();
const THIS = new VariableData("this");

/** `eq(get(this, 'kind'), kind)`: the union's discriminator. */
function kindIs(kind: string): OperationData {
  return new OperationData("eq", [new OperationData("get", [THIS, new LiteralData("kind")]), new LiteralData(kind)]);
}

const ANY_SCHEMA = new Schemas.OfUnion.Builder().branches(
  ...([[LITERAL_SCHEMA, LiteralData], [OPERATION_SCHEMA, OperationData], [VARIABLE_SCHEMA, VariableData],
    [LET_SCHEMA, LetData]] as const)
    .map(([schema, data]) => (b: BranchBuilder) => b.of(schema).when(kindIs(data.KIND))),
).create();

const SCHEMAS: ReadonlyMap<string, Schemas.OfObject.Data | Schemas.OfRelation.Data> = new Map<string,
  Schemas.OfObject.Data | Schemas.OfRelation.Data>([
  [LITERAL, LITERAL_SCHEMA], [OPERATION, OPERATION_SCHEMA], [VARIABLE, VARIABLE_SCHEMA], [LET, LET_SCHEMA],
  [ARGUMENTS, ARGUMENTS_SCHEMA],
]);
for (const [name, schema] of SCHEMAS) Proxies.register(name, schema);

export const Arguments = ARGUMENTS_SCHEMA;

export namespace OfLiteral {
  /** A native value. `Spec` is a native value, an `OfLiteral.Data`, or a callable taking the builder. */
  export const Data = LiteralData;
  export type Data = LiteralData;
  export const Builder = LiteralBuilder;
  export type Builder = LiteralBuilder;
  export type Spec = Native | LiteralData | Term | ((builder: LiteralBuilder) => LiteralBuilder);
  export const Schema = LITERAL_SCHEMA;

  export function resolve(spec: Spec | unknown): LiteralData {
    if (nativeName(spec) !== null) return new LiteralData(spec);
    return resolveSpec(spec, (v): v is LiteralData => v instanceof LiteralData, () => new LiteralBuilder(),
      "a native value, a literal");
  }
}

export namespace OfOperation {
  /** A named operation applied to ordered arguments. */
  export const Data = OperationData;
  export type Data = OperationData;
  export const Builder = OperationBuilder;
  export type Builder = OperationBuilder;
  export type Spec = OperationData | Term | ((builder: OperationBuilder) => OperationBuilder);
  export const Schema = OPERATION_SCHEMA;

  export function resolve(spec: Spec | unknown): OperationData {
    return resolveSpec(spec, (v): v is OperationData => v instanceof OperationData, () => new OperationBuilder(),
      "an operation");
  }
}

export namespace OfVariable {
  /** The value bound to a name. `Spec` is a name, an `OfVariable.Data`, or a callable taking the builder. */
  export const Data = VariableData;
  export type Data = VariableData;
  export const Builder = VariableBuilder;
  export type Builder = VariableBuilder;
  export type Spec = string | VariableData | Term | ((builder: VariableBuilder) => VariableBuilder);
  export const Schema = VARIABLE_SCHEMA;

  export function resolve(spec: Spec | unknown): VariableData {
    if (typeof spec === "string") return new VariableData(spec);
    return resolveSpec(spec, (v): v is VariableData => v instanceof VariableData, () => new VariableBuilder(),
      "a name, a variable");
  }
}

export namespace OfLet {
  /** Binds a name to the value of one expression within another, its body. */
  export const Data = LetData;
  export type Data = LetData;
  export const Builder = LetBuilder;
  export type Builder = LetBuilder;
  export type Spec = LetData | Term | ((builder: LetBuilder) => LetBuilder);
  export const Schema = LET_SCHEMA;

  export function resolve(spec: Spec | unknown): LetData {
    return resolveSpec(spec, (v): v is LetData => v instanceof LetData, () => new LetBuilder(), "a let");
  }
}

export namespace OfAny {
  /** Any expression. `Spec` is a native value (a literal), an expression, a `Term`, or a callable taking the
   * builder. */
  export type Data = AnyData;
  export const Builder = AnyBuilder;
  export type Builder = AnyBuilder;
  export type Spec = Native | AnyData | Term | ((builder: AnyBuilder) => AnyBuilder);
  export const Schema = ANY_SCHEMA;

  export function resolve(spec: Spec | unknown): AnyData {
    if (nativeName(spec) !== null) return new LiteralData(spec);
    return resolveSpec(spec, isExpression, () => new AnyBuilder(), "an expression, a native value");
  }
}

// --- Registry ---

/** Builds expressions from snapshots: `Builders['Expressions.OfLiteral'](instance)` returns a builder, as
 * `Plain.FromPlain` expects. `schema` and `name_of` look the meta-schemas up. */
export const Builders = {
  schema(name: string): Schemas.OfObject.Data {
    if (name === ARGUMENTS) throw new TypeError(`${repr(name)} is a relation; no relation builder is exposed`);
    const found = SCHEMAS.get(name);
    if (found === undefined) throw new AttributeError(`no schema registered as ${repr(name)}`);
    return found as Schemas.OfObject.Data;
  },
  name_of(schema: unknown): string {
    for (const [name, registered] of SCHEMAS) if (registered === schema) return name;
    throw new LookupError("schema is not registered");
  },
  [LITERAL]: (instance?: LiteralData): LiteralBuilder => new LiteralBuilder(instance),
  [OPERATION]: (instance?: OperationData): OperationBuilder => new OperationBuilder(instance),
  [VARIABLE]: (instance?: VariableData): VariableBuilder => new VariableBuilder(instance),
  [LET]: (instance?: LetData): LetBuilder => new LetBuilder(instance),
};

/** Internals, for the protocol conformance tests. */
export const _internals = { _Adjacency, _Argument, _Field, _Link };
