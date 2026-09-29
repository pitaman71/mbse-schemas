/**
 * Repr: Python-compatible text for messages and output, so both implementations say exactly the same thing.
 *
 * `repr` follows Python's `repr()` for the values that appear in messages, `typeName` follows `type(v).__name__` in
 * the framework's vocabulary (int, float, str, bool, bytes, ...), `pyFloat` follows `float.__repr__`, and
 * `sortedStrings` follows Python's code point ordering of `str`.
 */

/** Native tokens and their framework names. */
export const NATIVE_NAMES: ReadonlyMap<unknown, string> = new Map<unknown, string>([
  [BigInt, "int"],
  [Number, "float"],
  [String, "str"],
  [Boolean, "bool"],
  [Uint8Array, "bytes"],
]);

/** Python's `type(value).__name__`, using the framework's names for native values. */
export function typeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  switch (typeof value) {
    case "bigint":
      return "int";
    case "number":
      return "float";
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "function":
      return "function";
    case "symbol":
      return "symbol";
  }
  if (Array.isArray(value)) return "list";
  if (value instanceof Map) return "dict";
  if (value instanceof Set) return "set";
  const constructor = (value as { constructor?: { name?: string } }).constructor;
  if (constructor === Uint8Array) return "bytes";
  return constructor?.name ?? "object";
}

/** The name of a native token (`BigInt` is 'int'), or the constructor's own name for anything else. */
export function tokenName(token: unknown): string {
  const known = NATIVE_NAMES.get(token);
  if (known !== undefined) return known;
  if (token === null || token === undefined) return "NoneType";
  return (token as { name?: string }).name ?? String(token);
}

/** Python's `float.__repr__`: the shortest round-tripping digits, scientific below 1e-4 and from 1e16. */
export function pyFloat(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa, exponentText] = value.toExponential().split("e") as [string, string];
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = negative ? "-" : "";
  if (exponent < -4 || exponent >= 16) {
    const rest = digits.slice(1);
    const exp = `${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
    return `${sign}${digits[0]}${rest ? "." + rest : ""}e${exp}`;
  }
  if (exponent >= 0) {
    const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
    const fraction = digits.slice(exponent + 1);
    return `${sign}${whole}.${fraction || "0"}`;
  }
  return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
}

function codePoints(text: string): number[] {
  const points: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        points.push((unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000);
        i++;
        continue;
      }
    }
    points.push(unit);
  }
  return points;
}

/** Python's ordering of `str`: by code point, not by UTF-16 code unit. */
export function compareStrings(a: string, b: string): number {
  const x = codePoints(a);
  const y = codePoints(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  }
  return x.length - y.length;
}

export function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareStrings);
}

function isPrintable(point: number): boolean {
  // Close to Python's str.isprintable(): no controls, separators other than space, surrogates, or unassigned noise.
  if (point < 0x20 || point === 0x7f) return false;
  if (point >= 0x80 && point < 0xa0) return false;
  if (point === 0xad) return false;
  if (point >= 0xd800 && point <= 0xdfff) return false;
  if (point === 0x2028 || point === 0x2029) return false;
  if (point === 0xfeff) return false;
  const char = String.fromCodePoint(point);
  return !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(char) && !(/\p{Zs}/u.test(char) && point !== 0x20);
}

function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const point of codePoints(text)) {
    const char = String.fromCodePoint(point);
    if (char === quote || char === "\\") out += "\\" + char;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (isPrintable(point)) out += char;
    else if (point < 0x100) out += "\\x" + point.toString(16).padStart(2, "0");
    else if (point < 0x10000) out += "\\u" + point.toString(16).padStart(4, "0");
    else out += "\\U" + point.toString(16).padStart(8, "0");
  }
  return out + quote;
}

function reprBytes(bytes: Uint8Array): string {
  const quote = bytes.includes(0x27) && !bytes.includes(0x22) ? '"' : "'";
  let out = "b" + quote;
  for (const byte of bytes) {
    if (byte === quote.charCodeAt(0)) out += "\\" + quote;
    else if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x0d) out += "\\r";
    else if (byte === 0x09) out += "\\t";
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += "\\x" + byte.toString(16).padStart(2, "0");
  }
  return out + quote;
}

/** A tuple, which Python writes with parentheses (and a trailing comma for one element). */
export class Tuple {
  constructor(readonly items: readonly unknown[]) {}
}

/** Python's `repr()` for the values that appear in messages. */
export function repr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return reprString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return pyFloat(value);
  if (value instanceof Uint8Array) return reprBytes(value);
  if (value instanceof Tuple) {
    const items = value.items.map(repr);
    return items.length === 1 ? `(${items[0]},)` : `(${items.join(", ")})`;
  }
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (value instanceof Map) return `{${[...value].map(([k, v]) => `${repr(k)}: ${repr(v)}`).join(", ")}}`;
  if (value instanceof Set) return value.size === 0 ? "set()" : `{${[...value].map(repr).join(", ")}}`;
  if (typeof value === "function") {
    const name = NATIVE_NAMES.get(value) ?? (value as { name?: string }).name ?? "function";
    return isClassLike(value) ? `<class '${name}'>` : `<function ${name || "<lambda>"}>`;
  }
  const constructor = (value as { constructor?: { name?: string } }).constructor;
  return `<${constructor?.name ?? "object"} object>`;
}

/** True for classes and built-in constructors (which the DSL uses as tokens), false for ordinary callbacks. */
export function isClassLike(value: unknown): boolean {
  if (typeof value !== "function" || !("prototype" in value) || value.prototype === undefined) return false;
  const source = Function.prototype.toString.call(value);
  return source.startsWith("class") || /\{\s*\[native code\]\s*\}$/.test(source);
}
