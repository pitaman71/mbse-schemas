/**
 * Evaluators: compute the value of an expression.
 *
 * `Evaluators.OfAny(expression, scope)` evaluates any expression with the variables in `scope` bound, and
 * `Evaluators.OfLiteral`, `OfOperation`, `OfVariable` and `OfLet` evaluate one kind; each accepts that kind's `Spec`
 * (see `Expressions`), including `Term`s. The value is a native value, an object, or `null` when it is unknown.
 *
 * - Three-valued logic: an absent property is unknown, and comparisons with unknown or incomparable values are
 *   unknown. `and`, `or`, `not` and `implies` follow Kleene's logic; the second operand is evaluated only when the
 *   first does not decide.
 * - No coercion. Comparisons follow EQUALITY.md: natives of one type by value, objects by identity; values of
 *   different types are incomparable. Arithmetic takes numbers of one type.
 * - Only core operations (`Expressions.CORE`) are evaluated. Unknown operations, wrong numbers of arguments, unbound
 *   variables and wrong operand types raise, as do the problems `validate()` reports.
 */

import * as Comparison from "./Comparison.js";
import { KeyError, NotImplementedError, ValueError } from "./Errors.js";
import * as Expressions from "./Expressions.js";
import { repr, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import * as Validators from "./Validators.js";
import type * as Visitors from "./Visitors.js";
import type { Native } from "./Visitors.js";

/** The variables an expression is evaluated with. */
export type Scope = Record<string, unknown>;

const NATIVES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["int", BigInt],
  ["float", Number],
  ["str", String],
  ["bool", Boolean],
  ["bytes", Uint8Array],
]);

function start(expression: unknown, scope: Scope): unknown {
  return evaluateIn(expression, new Map(Object.entries(scope)), new Set());
}

/** The value of any expression, with the variables in `scope` bound. */
export function OfAny(expression: Expressions.OfAny.Spec, scope: Scope = {}): unknown {
  return start(Expressions.OfAny.resolve(expression), scope);
}

/** The value of a literal. */
export function OfLiteral(expression: Expressions.OfLiteral.Spec, scope: Scope = {}): unknown {
  return start(Expressions.OfLiteral.resolve(expression), scope);
}

/** The value of an operation, with the variables in `scope` bound. */
export function OfOperation(expression: Expressions.OfOperation.Spec, scope: Scope = {}): unknown {
  return start(Expressions.OfOperation.resolve(expression), scope);
}

/** The value `scope` binds to a variable. */
export function OfVariable(expression: Expressions.OfVariable.Spec, scope: Scope = {}): unknown {
  return start(Expressions.OfVariable.resolve(expression), scope);
}

/** The value of a let's body, with its name bound to its value and the variables in `scope` bound. */
export function OfLet(expression: Expressions.OfLet.Spec, scope: Scope = {}): unknown {
  return start(Expressions.OfLet.resolve(expression), scope);
}

function evaluateIn(expression: unknown, scope: ReadonlyMap<string, unknown>, active: Set<unknown>): unknown {
  if (expression instanceof Expressions.OfLiteral.Data) {
    if (expression.value === null) throw new ValueError("a literal needs a value");
    return expression.value;
  }
  if (expression instanceof Expressions.OfVariable.Data) {
    if (!scope.has(expression.name as string)) throw new KeyError(`variable ${repr(expression.name)} is not bound`);
    return scope.get(expression.name as string);
  }
  if (!(expression instanceof Expressions.OfLet.Data || expression instanceof Expressions.OfOperation.Data)) {
    throw new TypeError(`not an expression: ${repr(expression)}`);
  }
  if (active.has(expression)) throw new ValueError("the expression contains a cycle");
  active.add(expression);
  try {
    if (expression instanceof Expressions.OfLet.Data) {
      if (expression.value === null || expression.body === null) {
        throw new ValueError(`a let needs a ${expression.value === null ? "value" : "body"}`);
      }
      const bound = evaluateIn(expression.value, scope, active);
      return evaluateIn(expression.body, new Map([...scope, [expression.name as string, bound]]), active);
    }
    return operate(expression, scope, active);
  } finally {
    active.delete(expression);
  }
}

function operate(expression: Expressions.OfOperation.Data, scope: ReadonlyMap<string, unknown>, active: Set<unknown>): unknown {
  const name = expression.name as string;
  const args = expression.arguments;
  const arity = Expressions.CORE.get(name);
  if (arity === undefined) throw new NotImplementedError(`${repr(name)} is not a core operation`);
  if (args.length !== arity) throw new TypeError(`${name} takes ${arity} arguments, got ${args.length}`);
  const value = (i: number) => evaluateIn(args[i], scope, active);

  if (name === "and" || name === "or" || name === "implies") {
    return logic(name, () => truth(name, value(0)), () => truth(name, value(1)));
  }
  const values = args.map((_, i) => value(i));
  if (name === "not") {
    const t = truth(name, values[0]);
    return t === null ? null : !t;
  }
  if (name === "get" || name === "has") return read(name, values[0], values[1]);
  if (name === "eq" || name === "ne") {
    const same = equal(values[0], values[1]);
    return same === null ? null : same === (name === "eq");
  }
  if (name === "lt" || name === "le" || name === "gt" || name === "ge") {
    const o = order(values[0], values[1]);
    if (o === null) return null;
    return { lt: o < 0, le: o <= 0, gt: o > 0, ge: o >= 0 }[name];
  }
  return arithmetic(name, values);
}

function truth(name: string, value: unknown): boolean | null {
  if (value !== null && typeof value !== "boolean") {
    throw new TypeError(`${name} expects bool operands, got ${typeName(value)}`);
  }
  return value;
}

/** Kleene's logic, evaluating the second operand only when the first does not decide. */
function logic(name: "and" | "or" | "implies", first: () => boolean | null,
  second: () => boolean | null): boolean | null {
  const a = first();
  const decisive = { and: false, or: true, implies: false }[name];
  if (a === decisive) return name !== "and";
  const b = second();
  if (name === "implies") return b === true ? true : a === null || b === null ? null : false;
  if (b === (name === "or")) return b;
  return a === null || b === null ? null : name === "and";
}

function isObject(value: unknown): value is Visitors.Visitable {
  return value !== null && typeof value === "object"
    && typeof (value as { accept?: unknown }).accept === "function"
    && typeof (value as { identity?: unknown }).identity === "function";
}

/** `get`: the property's value, or `null` when absent. `has`: whether it is present. */
function read(name: string, target: unknown, propertyName: unknown): unknown {
  if (typeof propertyName !== "string") {
    throw new TypeError(`${name} expects a property name, got ${typeName(propertyName)}`);
  }
  if (target === null) return null;
  if (!isObject(target)) throw new TypeError(`${name} expects an object, got ${typeName(target)}`);
  const record = new Validators._ObjectRecord();
  target.accept(record);
  if (name === "has") return record.values.has(propertyName);
  return record.values.get(propertyName) ?? null;
}

function compare(a: Native, b: Native): Comparison.Result {
  const schema = new Schemas.OfNative.Data(NATIVES.get(typeName(a)));
  return new Comparison.OfNative(schema, a).compare(new Comparison.OfNative(schema, b));
}

function sameNativeType(a: unknown, b: unknown): boolean {
  const name = typeName(a);
  return NATIVES.has(name) && Schemas.isNativeOf(NATIVES.get(name), a) && Schemas.isNativeOf(NATIVES.get(name), b);
}

/** Whether `a` equals `b`: natives of one type by value, objects by identity; `null` if unknown or incomparable. */
function equal(a: unknown, b: unknown): boolean | null {
  if (a === null || b === null) return null;
  if (sameNativeType(a, b)) return compare(a as Native, b as Native) === 0;
  if (isObject(a) && isObject(b)) return a.identity() === b.identity();
  return null;
}

/** -1, 0 or 1 for ordered natives of one type; `null` if unknown or incomparable. */
function order(a: unknown, b: unknown): Comparison.Result {
  if (a === null || b === null || !sameNativeType(a, b)) return null;
  return compare(a as Native, b as Native);
}

function isNumber(value: unknown): value is bigint | number {
  return typeof value === "bigint" || typeof value === "number";
}

function arithmetic(name: string, values: unknown[]): unknown {
  if (values.some((value) => value === null)) return null;
  if (name === "neg") {
    const [a] = values;
    if (!isNumber(a)) throw new TypeError(`neg expects a number, got ${typeName(a)}`);
    return -a;
  }
  const [a, b] = values;
  if (!isNumber(a) || typeof a !== typeof b) {
    throw new TypeError(`${name} expects numbers of one type, got ${typeName(a)} and ${typeName(b)}`);
  }
  const [x, y] = [a as number, b as number]; // both bigint or both number
  return name === "add" ? x + y : name === "sub" ? x - y : x * y;
}
