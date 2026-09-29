/**
 * JSON: a thin text encoding of `Plain` data.
 *
 * `ToJSON(schema, value)` returns JSON text; `FromJSON(builders)(schema, text)` rebuilds values with the given
 * implementation's builders. Both mirror `Plain`: calling them dispatches on the schema's kind, and `.OfNative`,
 * `.OfObject` and `.Reachable` are the specific forms.
 *
 * The encoding is strict JSON (RFC 8259). Output never contains NaN or Infinity, because `Schemas.OfNative` gives
 * non-finite floats a plain form. Input with NaN / Infinity literals or duplicate object keys is rejected.
 *
 * `dumps` writes exactly what Python's `json.dumps(..., ensure_ascii=False, allow_nan=False)` writes, so both
 * implementations produce byte-identical JSON. `loads` keeps integers (`bigint`) apart from floats (`number`), which
 * `JSON.parse` cannot. Its parser is the reference parser shared with the Python binding: both accept the same input,
 * and input problems throw `Errors.DecodeError` with the same reason, line and column (counted in code points).
 */

import { DecodeError, jsonString, ValueError } from "./Errors.js";
import * as Plain from "./Plain.js";
import type { PlainData, PlainMap } from "./Plain.js";
import { pyFloat, repr, typeName } from "./Repr.js";
import type * as Schemas from "./Schemas.js";
import type { Native, Visitable } from "./Visitors.js";

export interface DumpOptions {
  indent?: number | null;
}

// --- Writing ---

const encodeString = jsonString;

function encode(value: unknown, indent: number | null, level: number): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValueError(`Out of range float values are not JSON compliant: ${pyFloat(value)}`);
    return pyFloat(value);
  }
  if (typeof value === "string") return encodeString(value);
  const [open, close, items] = Array.isArray(value)
    ? ["[", "]", value.map((item) => encode(item, indent, level + 1))]
    : value instanceof Map
      ? ["{", "}", [...value].map(([k, v]) => {
          if (typeof k !== "string") throw new TypeError(`keys must be str, not ${typeName(k)}`);
          return `${encodeString(k)}: ${encode(v, indent, level + 1)}`;
        })]
      : (() => {
          throw new TypeError(`Object of type ${typeName(value)} is not JSON serializable`);
        })();
  if (items.length === 0) return open + close;
  if (indent === null) return open + items.join(", ") + close;
  const inner = "\n" + " ".repeat(indent * (level + 1));
  return open + inner + items.join("," + inner) + "\n" + " ".repeat(indent * level) + close;
}

/** Encodes plain data as strict JSON, keeping key order. */
export function dumps(plain: PlainData, options: DumpOptions = {}): string {
  return encode(plain, options.indent ?? null, 0);
}

// --- Reading ---

/** The line and column of UTF-16 offset `pos`: lines split at `\n`, columns count code points from 1. */
function lineColumn(text: string, pos: number): { line: number; column: number } {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < pos; i = text.indexOf("\n", i + 1)) line++;
  return { line, column: [...text.slice(lineStart, pos)].length + 1 };
}

export const INT_DIGITS_LIMIT = 4300; // as Python's int() from text

const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const WHITESPACE = /[ \t\n\r]*/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

class Parser {
  pos = 0;

  constructor(private readonly text: string) {}

  fail(reason: string, pos: number = this.pos): never {
    throw new DecodeError(reason, lineColumn(this.text, pos));
  }

  skip(): void {
    WHITESPACE.lastIndex = this.pos;
    WHITESPACE.exec(this.text);
    this.pos = WHITESPACE.lastIndex;
  }

  value(): PlainData {
    const char = this.text[this.pos];
    if (char === '"') return this.string();
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (this.text.startsWith("null", this.pos)) return (this.pos += 4), null;
    if (this.text.startsWith("true", this.pos)) return (this.pos += 4), true;
    if (this.text.startsWith("false", this.pos)) return (this.pos += 5), false;
    for (const constant of ["NaN", "Infinity", "-Infinity"]) {
      if (this.text.startsWith(constant, this.pos)) this.fail(`${constant} is not valid JSON`);
    }
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (match === null) return this.fail("expecting a value");
    if (match[1] === undefined && match[2] === undefined) {
      const digits = match[0].replace("-", "").length;
      if (digits > INT_DIGITS_LIMIT) this.fail(`an integer has ${digits} digits, more than the limit of ${INT_DIGITS_LIMIT}`);
      this.pos = NUMBER.lastIndex;
      return BigInt(match[0]);
    }
    this.pos = NUMBER.lastIndex;
    return Number(match[0]);
  }

  string(): string {
    const start = this.pos;
    this.pos++;
    let out = "";
    for (;;) {
      const char = this.text[this.pos];
      if (char === undefined) return this.fail("unterminated string", start);
      if (char === '"') {
        this.pos++;
        return out;
      }
      if (char === "\\") {
        const escape = this.text[this.pos + 1];
        if (escape === undefined) return this.fail("unterminated string", start);
        if (escape === "u") {
          const unit = this.hex4(this.pos + 2);
          this.pos += 6;
          if (unit >= 0xd800 && unit <= 0xdbff && this.text.startsWith("\\u", this.pos)) {
            const low = this.hex4(this.pos + 2);
            if (low >= 0xdc00 && low <= 0xdfff) {
              out += String.fromCharCode(unit, low);
              this.pos += 6;
              continue;
            }
          }
          out += String.fromCharCode(unit);
          continue;
        }
        const replacement = ESCAPES[escape];
        if (replacement === undefined) return this.fail("invalid escape");
        out += replacement;
        this.pos += 2;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) return this.fail("invalid control character in a string");
      out += char;
      this.pos++;
    }
  }

  hex4(at: number): number {
    const digits = this.text.slice(at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail("invalid \\uXXXX escape", at - 1);
    return parseInt(digits, 16);
  }

  object(): PlainMap {
    this.pos++;
    const out: PlainMap = new Map();
    this.skip();
    if (this.text[this.pos] === "}") return this.pos++, out;
    for (;;) {
      if (this.text[this.pos] !== '"') return this.fail("expecting a property name in double quotes");
      const start = this.pos;
      const key = this.string();
      if (out.has(key)) this.fail(`duplicate key ${repr(key)}`, start);
      this.skip();
      if (this.text[this.pos] !== ":") return this.fail("expecting ':'");
      this.pos++;
      this.skip();
      out.set(key, this.value());
      this.skip();
      const next = this.text[this.pos];
      if (next === "}") return this.pos++, out;
      if (next !== ",") return this.fail("expecting ',' or '}'");
      const comma = this.pos++;
      this.skip();
      if (this.text[this.pos] === "}") return this.fail("trailing comma before '}'", comma);
    }
  }

  array(): PlainData[] {
    this.pos++;
    const out: PlainData[] = [];
    this.skip();
    if (this.text[this.pos] === "]") return this.pos++, out;
    for (;;) {
      out.push(this.value());
      this.skip();
      const next = this.text[this.pos];
      if (next === "]") return this.pos++, out;
      if (next !== ",") return this.fail("expecting ',' or ']'");
      const comma = this.pos++;
      this.skip();
      if (this.text[this.pos] === "]") return this.fail("trailing comma before ']'", comma);
    }
  }
}

/** Python's `json.detect_encoding` for byte input. */
function detectEncoding(bytes: Uint8Array): string {
  const [b0, b1, b2, b3] = bytes;
  if ((b0 === 0x00 && b1 === 0x00 && b2 === 0xfe && b3 === 0xff) || (b0 === 0xff && b1 === 0xfe && b2 === 0x00 && b3 === 0x00)) return "utf-32";
  if ((b0 === 0xfe && b1 === 0xff) || (b0 === 0xff && b1 === 0xfe)) return "utf-16";
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return "utf-8-sig";
  if (bytes.length >= 4) {
    if (!b0) return b1 ? "utf-16-be" : "utf-32-be";
    if (!b1) return b2 || b3 ? "utf-16-le" : "utf-32-le";
  } else if (bytes.length === 2) {
    if (!b0) return "utf-16-be";
    if (!b1) return "utf-16-le";
  }
  return "utf-8";
}

/** Decodes UTF-32 from `start`, or returns null if the bytes are not valid UTF-32 (TextDecoder has no UTF-32). */
function decodeUtf32(bytes: Uint8Array, littleEndian: boolean, start: number): string | null {
  if ((bytes.length - start) % 4 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let out = "";
  for (let i = start; i < bytes.length; i += 4) {
    const point = view.getUint32(i, littleEndian);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
    out += String.fromCodePoint(point);
  }
  return out;
}

/** Decodes UTF-8, UTF-16 or UTF-32, detected as JSON specifies (a BOM, or the pattern of zero bytes). */
export function decodeBytes(bytes: Uint8Array): string {
  const encoding = detectEncoding(bytes);
  let text: string | null;
  if (encoding === "utf-32") text = decodeUtf32(bytes, bytes[0] === 0xff, 4);
  else if (encoding === "utf-32-be" || encoding === "utf-32-le") text = decodeUtf32(bytes, encoding === "utf-32-le", 0);
  else {
    const [label, stripBOM] =
      encoding === "utf-16" ? [bytes[0] === 0xff ? "utf-16le" : "utf-16be", true]
      : encoding === "utf-16-le" ? ["utf-16le", false]
      : encoding === "utf-16-be" ? ["utf-16be", false]
      : ["utf-8", encoding === "utf-8-sig"];
    try {
      text = new TextDecoder(label, { fatal: true, ignoreBOM: !stripBOM }).decode(bytes);
    } catch {
      text = null;
    }
  }
  if (text === null) throw new DecodeError(`input is not valid ${encoding}`);
  return text;
}

/** Decodes strict JSON into plain data. */
export function loads(input: string | Uint8Array): PlainData {
  const text = typeof input === "string" ? input : decodeBytes(input);
  const parser = new Parser(text);
  if (text.startsWith("\ufeff")) parser.fail("unexpected byte order mark");
  parser.skip();
  const value = parser.value();
  parser.skip();
  if (parser.pos !== text.length) parser.fail("unexpected data after the value");
  return value;
}

// --- Entry points ---

function toJSONOfNative(schema: Schemas.OfNative.Data, value: Native, options: DumpOptions = {}): string {
  return dumps(Plain.ToPlain.OfNative(schema, value), options);
}

function toJSONOfObject(schema: Schemas.OfObject.Data, value: Visitable, options: DumpOptions = {}): string {
  return dumps(Plain.ToPlain.OfObject(schema, value), options);
}

function toJSONReachable(schema: Schemas.OfObject.Data, value: Visitable, options: DumpOptions = {}): string {
  return dumps(Plain.ToPlain.Reachable(schema, value), options);
}

/** `ToJSON(schema, value)` dispatches on the schema's kind. */
export const ToJSON = Object.assign(
  function ToJSON(schema: unknown, value: unknown, options: DumpOptions = {}): string {
    return dumps(Plain.ToPlain(schema, value), options);
  },
  { OfNative: toJSONOfNative, OfObject: toJSONOfObject, Reachable: toJSONReachable },
);

export interface FromJSONCall {
  (schema: unknown, text: string | Uint8Array): unknown;
  OfNative(schema: Schemas.OfNative.Data, text: string | Uint8Array): Native;
  OfObject(schema: Schemas.OfObject.Data, text: string | Uint8Array): unknown;
  Reachable(schema: Schemas.OfObject.Data, text: string | Uint8Array): unknown;
}

/** Decodes JSON, building objects with the given implementation's builders, e.g. `FromJSON(Proxies.Builders)`. */
export function FromJSON(builders: Plain.Builders): FromJSONCall {
  const plain = Plain.FromPlain(builders);
  const call = (schema: unknown, text: string | Uint8Array): unknown => plain(schema, loads(text));
  return Object.assign(call, {
    OfNative: (schema: Schemas.OfNative.Data, text: string | Uint8Array) => plain.OfNative(schema, loads(text)),
    OfObject: (schema: Schemas.OfObject.Data, text: string | Uint8Array) => plain.OfObject(schema, loads(text)),
    Reachable: (schema: Schemas.OfObject.Data, text: string | Uint8Array) => plain.Reachable(schema, loads(text)),
  });
}
