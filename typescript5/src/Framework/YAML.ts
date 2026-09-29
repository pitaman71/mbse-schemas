/**
 * YAML: a thin text encoding of `Plain` data. Parsing uses the `yaml` package.
 *
 * `ToYAML(schema, value)` returns YAML text; `FromYAML(builders)(schema, text)` rebuilds values with the given
 * implementation's builders. Both mirror `Plain` and `JSON`.
 *
 * Loading follows the YAML 1.2 core schema: only `true` / `false` are booleans (not `yes` / `on`), `010` is ten,
 * there are no sexagesimal numbers (`1:30` is a string), and unquoted dates stay strings. Duplicate keys, several
 * documents, and non-plain values (e.g. `!!binary`, `!!set`, unknown tags, non-string keys) are rejected. Dumping
 * writes block style, quotes any string that a YAML 1.1 or 1.2 reader would misread, escapes line breaks and
 * non-printable characters in double quotes, never emits aliases, and keeps key order. Floats always keep a `.` or an
 * exponent (`1.0`, `1.0e+16`), so every reader sees a float.
 */

import * as Y from "yaml";

import { ValueError } from "./Errors.js";
import { decodeBytes } from "./JSON.js";
import * as Plain from "./Plain.js";
import type { PlainData } from "./Plain.js";
import { pyFloat, repr, typeName } from "./Repr.js";
import type * as Schemas from "./Schemas.js";
import type { Native, Visitable } from "./Visitors.js";

// --- Dumping ---

/** Words a YAML 1.1 reader resolves to booleans or null. */
const RESERVED_WORDS = new Set([
  "y", "Y", "yes", "Yes", "YES", "n", "N", "no", "No", "NO", "true", "True", "TRUE", "false", "False", "FALSE",
  "on", "On", "ON", "off", "Off", "OFF", "null", "Null", "NULL",
]);

/** A string that every YAML 1.1 and 1.2 reader reads back as the same string without quotes. */
const PLAIN_SAFE = /^[\p{L}$_][\p{L}\p{N}$_./-]*(?: [\p{L}\p{N}$_./-]+)*$/u;

const ESCAPES: Record<number, string> = {
  0x00: "0", 0x07: "a", 0x08: "b", 0x09: "t", 0x0a: "n", 0x0b: "v", 0x0c: "f", 0x0d: "r", 0x1b: "e",
  0x22: '"', 0x5c: "\\", 0x85: "N", 0xa0: "_", 0x2028: "L", 0x2029: "P",
};

function isYamlPrintable(point: number): boolean {
  if (point === 0x85 || point === 0x2028 || point === 0x2029 || point === 0xfeff) return false;
  return (point >= 0x20 && point <= 0x7e) || (point >= 0xa0 && point <= 0xd7ff) || (point >= 0xe000 && point <= 0xfffd) ||
    (point >= 0x10000 && point <= 0x10ffff);
}

function codePoints(text: string): number[] {
  return [...text].map((char) => char.codePointAt(0) as number);
}

function doubleQuoted(text: string): string {
  let out = '"';
  for (const point of codePoints(text)) {
    const escape = ESCAPES[point];
    if (escape !== undefined) out += "\\" + escape;
    else if (isYamlPrintable(point)) out += String.fromCodePoint(point);
    else if (point < 0x100) out += "\\x" + point.toString(16).toUpperCase().padStart(2, "0");
    else if (point < 0x10000) out += "\\u" + point.toString(16).toUpperCase().padStart(4, "0");
    else out += "\\U" + point.toString(16).toUpperCase().padStart(8, "0");
  }
  return out + '"';
}

function scalarString(text: string): string {
  if (PLAIN_SAFE.test(text) && !RESERVED_WORDS.has(text)) return text;
  if (codePoints(text).every((point) => isYamlPrintable(point) || point === 0x09)) return "'" + text.replaceAll("'", "''") + "'";
  return doubleQuoted(text);
}

/** A float every reader resolves as a float: Python's repr, with `.0` added to a bare exponent mantissa. */
function scalarFloat(value: number): string {
  if (Number.isNaN(value)) return ".nan";
  if (value === Infinity) return ".inf";
  if (value === -Infinity) return "-.inf";
  const text = pyFloat(value);
  const [mantissa, exponent] = text.split("e");
  return exponent !== undefined && !(mantissa as string).includes(".") ? `${mantissa}.0e${exponent}` : text;
}

function scalar(value: PlainData): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return scalarFloat(value);
  if (typeof value === "string") return scalarString(value);
  throw new TypeError(`cannot represent ${typeName(value)} as a YAML scalar`);
}

function isEmptyContainer(value: PlainData): boolean {
  return (Array.isArray(value) && value.length === 0) || (value instanceof Map && value.size === 0);
}

function inline(value: PlainData): string {
  if (Array.isArray(value)) return "[]";
  if (value instanceof Map) return "{}";
  return scalar(value);
}

function emit(value: PlainData, indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      if (typeof key !== "string") throw new TypeError(`keys must be str, not ${typeName(key)}`);
      const head = `${pad}${scalarString(key)}:`;
      if (item instanceof Map && item.size > 0) {
        lines.push(head);
        emit(item, indent + 2, lines);
      } else if (Array.isArray(item) && item.length > 0) {
        lines.push(head);
        emit(item, indent, lines); // sequences inside mappings are not indented, as PyYAML writes them
      } else {
        lines.push(`${head} ${inline(item)}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if ((item instanceof Map || Array.isArray(item)) && !isEmptyContainer(item)) {
        const nested: string[] = [];
        emit(item, indent + 2, nested);
        const first = (nested[0] as string).slice(indent + 2);
        lines.push(`${pad}- ${first}`, ...nested.slice(1));
      } else {
        lines.push(`${pad}- ${inline(item)}`);
      }
    }
    return;
  }
  lines.push(pad + scalar(value));
}

/** Encodes plain data as YAML, keeping key order. */
export function dumps(plain: PlainData): string {
  if (isEmptyContainer(plain) || !(plain instanceof Map || Array.isArray(plain))) return inline(plain) + "\n";
  const lines: string[] = [];
  emit(plain, 0, lines);
  return lines.join("\n") + "\n";
}

// --- Loading ---

function checkPlain(value: unknown, path = "$"): void {
  if (value === null || ["boolean", "bigint", "number", "string"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkPlain(item, `${path}[${i}]`));
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      if (typeof key !== "string") throw new ValueError(`${path}: keys must be strings, got ${typeName(key)} ${repr(key)}`);
      checkPlain(item, `${path}.${key}`);
    }
    return;
  }
  throw new ValueError(`${path}: ${typeName(value)} is not plain data`);
}

const OPTIONS = { version: "1.2", schema: "core", intAsBigInt: true, uniqueKeys: true, merge: false } as const;

/** Decodes YAML (one document, YAML 1.2 core schema) into plain data. */
export function loads(input: string | Uint8Array): PlainData {
  const text = typeof input === "string" ? input : decodeBytes(input);
  const documents = Y.parseAllDocuments(text, OPTIONS);
  if (!Array.isArray(documents)) return null; // an empty stream
  if (documents.length > 1) throw new ValueError("invalid YAML: expected a single document in the stream");
  const document = documents[0];
  if (document === undefined) return null;
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) throw new ValueError(`invalid YAML: ${(problems[0] as Error).message}`);
  let plain: unknown;
  try {
    plain = document.toJS({ mapAsMap: true, maxAliasCount: 100 });
  } catch (error) {
    throw new ValueError(`invalid YAML: ${(error as Error).message}`);
  }
  checkPlain(plain);
  return plain as PlainData;
}

// --- Entry points ---

function toYAMLOfNative(schema: Schemas.OfNative.Data, value: Native): string {
  return dumps(Plain.ToPlain.OfNative(schema, value));
}

function toYAMLOfObject(schema: Schemas.OfObject.Data, value: Visitable): string {
  return dumps(Plain.ToPlain.OfObject(schema, value));
}

function toYAMLReachable(schema: Schemas.OfObject.Data, value: Visitable): string {
  return dumps(Plain.ToPlain.Reachable(schema, value));
}

/** `ToYAML(schema, value)` dispatches on the schema's kind. */
export const ToYAML = Object.assign(
  function ToYAML(schema: unknown, value: unknown): string {
    return dumps(Plain.ToPlain(schema, value));
  },
  { OfNative: toYAMLOfNative, OfObject: toYAMLOfObject, Reachable: toYAMLReachable },
);

export interface FromYAMLCall {
  (schema: unknown, text: string | Uint8Array): unknown;
  OfNative(schema: Schemas.OfNative.Data, text: string | Uint8Array): Native;
  OfObject(schema: Schemas.OfObject.Data, text: string | Uint8Array): unknown;
  Reachable(schema: Schemas.OfObject.Data, text: string | Uint8Array): unknown;
}

/** Decodes YAML, building objects with the given implementation's builders, e.g. `FromYAML(Proxies.Builders)`. */
export function FromYAML(builders: Plain.Builders): FromYAMLCall {
  const plain = Plain.FromPlain(builders);
  const call = (schema: unknown, text: string | Uint8Array): unknown => plain(schema, loads(text));
  return Object.assign(call, {
    OfNative: (schema: Schemas.OfNative.Data, text: string | Uint8Array) => plain.OfNative(schema, loads(text)),
    OfObject: (schema: Schemas.OfObject.Data, text: string | Uint8Array) => plain.OfObject(schema, loads(text)),
    Reachable: (schema: Schemas.OfObject.Data, text: string | Uint8Array) => plain.Reachable(schema, loads(text)),
  });
}
