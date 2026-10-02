/**
 * YAML: a thin text encoding of `Plain` data. Parsing uses the `yaml` package.
 *
 * `ToYAML(store)(schema, value)` returns YAML text, naming the schemas of objects in `store`, and
 * `FromYAML(store)(schema, text)` rebuilds values in `store`. Both mirror `Plain` and `JSON`.
 *
 * Loading follows the YAML 1.2 core schema: only `true` / `false` are booleans (not `yes` / `on`), `010` is ten,
 * there are no sexagesimal numbers (`1:30` is a string), and unquoted dates stay strings. Several documents,
 * non-string keys, duplicate keys, undefined aliases and tags other than `!`, `!!str`, `!!seq` and `!!map` are rejected
 * with `Errors.DecodeError`, with the same reason and position as in the Python binding. Syntax errors are
 * `DecodeError`s too, with the `yaml` package's reason. Dumping
 * writes block style, quotes any string that a YAML 1.1 or 1.2 reader would misread, escapes line breaks and
 * non-printable characters in double quotes, never emits aliases, and keeps key order. Floats always keep a `.` or an
 * exponent (`1.0`, `1.0e+16`), so every reader sees a float.
 */

import * as Y from "yaml";

import { DecodeError } from "./Errors.js";
import { decodeBytes } from "./JSON.js";
import * as Plain from "./Plain.js";
import type { PlainData, PlainMap } from "./Plain.js";
import { pyFloat, repr, typeName } from "./Repr.js";
import type * as Schemas from "./Schemas.js";
import type * as Stores from "./Stores.js";
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
    else out += "\\u" + point.toString(16).toUpperCase().padStart(4, "0"); // every astral code point is printable
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

/** Emits a non-empty map or list in block style; scalars and empty containers are written inline by the caller. */
function emit(value: PlainMap | PlainData[], indent: number, lines: string[]): void {
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
  for (const item of value) {
    if ((item instanceof Map || Array.isArray(item)) && !isEmptyContainer(item)) {
      const nested: string[] = [];
      emit(item as PlainMap | PlainData[], indent + 2, nested);
      const first = (nested[0] as string).slice(indent + 2);
      lines.push(`${pad}- ${first}`, ...nested.slice(1));
    } else {
      lines.push(`${pad}- ${inline(item)}`);
    }
  }
}

/** Encodes plain data as YAML, keeping key order. */
export function dumps(plain: PlainData): string {
  if (isEmptyContainer(plain) || !(plain instanceof Map || Array.isArray(plain))) return inline(plain) + "\n";
  const lines: string[] = [];
  emit(plain, 0, lines);
  return lines.join("\n") + "\n";
}

// --- Loading ---

const CORE_PREFIX = "tag:yaml.org,2002:";
const STR = CORE_PREFIX + "str";
const SEQ = CORE_PREFIX + "seq";
const MAP = CORE_PREFIX + "map";

const OPTIONS = { version: "1.2", schema: "core", intAsBigInt: true, uniqueKeys: false, merge: false } as const;

/** The line and column of UTF-16 offset `offset`, counting line breaks as PyYAML's marks do, columns in code points. */
function position(text: string, offset: number): { line: number; column: number } {
  let line = 0;
  let column = 0;
  for (let i = 0; i < offset; ) {
    const char = String.fromCodePoint(text.codePointAt(i) as number);
    if ("\n\x85\u2028\u2029".includes(char) || (char === "\r" && text[i + 1] !== "\n")) {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
    i += char.length;
  }
  return { line: line + 1, column: column + 1 };
}

/** The tag and anchor tokens in the text, from the concrete syntax tree: where each starts and ends. */
function propertyTokens(text: string): { offset: number; end: number }[] {
  const found: { offset: number; end: number }[] = [];
  const visit = (token: unknown): void => {
    if (Array.isArray(token)) token.forEach(visit);
    else if (token !== null && typeof token === "object") {
      const { type, offset, source } = token as { type?: unknown; offset?: unknown; source?: unknown };
      if ((type === "tag" || type === "anchor") && typeof offset === "number" && typeof source === "string") {
        found.push({ offset, end: offset + source.length });
      }
      Object.values(token).forEach(visit);
    }
  };
  for (const token of new Y.Parser().parse(text)) visit(token);
  return found;
}

/** Collects the framework's own YAML problems in one document, each with its position. */
class Checker {
  readonly problems: DecodeError[] = [];
  private tokens: ReturnType<typeof propertyTokens> | undefined;

  constructor(private readonly text: string, private readonly document: Y.Document.Parsed) {}

  problem(reason: string, offset: number): void {
    this.problems.push(new DecodeError(reason, position(this.text, offset)));
  }

  /** Where a node is written, as PyYAML's marks: at its tag or anchor if it has them, which the `yaml` package's
   * ranges leave out. */
  start(node: Y.Node): number {
    let start = (node.range as [number, number, number])[0];
    if (node.tag === undefined && node.anchor === undefined) return start;
    this.tokens ??= propertyTokens(this.text);
    for (;;) {
      const before = this.tokens.find((t) => t.end <= start && this.text.slice(t.end, start).trim() === "" && t.offset < start);
      if (before === undefined) return start;
      start = before.offset;
    }
  }

  checkTag(node: Y.Node, allowed: string): void {
    const tag = node.tag;
    if (tag === undefined || tag === null || tag === "!" || tag === allowed) return;
    const shown = tag.startsWith(CORE_PREFIX) ? "!!" + tag.slice(CORE_PREFIX.length) : tag;
    this.problem(`unsupported tag ${shown}`, this.start(node));
  }

  visit(node: unknown): void {
    if (Y.isAlias(node)) {
      if (node.resolve(this.document) === undefined) {
        this.problem(`found undefined alias ${repr(node.source)}`, (node.range as [number, number, number])[0]);
      }
    } else if (Y.isScalar(node)) {
      this.checkTag(node, STR);
    } else if (Y.isSeq(node)) {
      this.checkTag(node, SEQ);
      node.items.forEach((item) => this.visit(item));
    } else if (Y.isMap(node)) {
      this.checkTag(node, MAP);
      const seen = new Set<string>();
      for (const pair of node.items) {
        const key = Y.isAlias(pair.key) ? pair.key.resolve(this.document) : pair.key;
        const offset = this.start(pair.key as Y.Node); // where the key is written, even if it is an alias
        this.visit(pair.key);
        if (Y.isSeq(key)) this.problem("keys must be strings, got a sequence", offset);
        else if (Y.isMap(key)) this.problem("keys must be strings, got a mapping", offset);
        else if (Y.isScalar(key) && typeof key.value !== "string") {
          this.problem(`keys must be strings, got ${typeName(key.value)} ${repr(key.value)}`, offset);
        } else if (Y.isScalar(key) && seen.has(key.value as string)) {
          this.problem(`duplicate key ${repr(key.value)}`, offset);
        } else if (Y.isScalar(key)) {
          seen.add(key.value as string);
        }
        this.visit(pair.value);
      }
    }
  }
}

/** A parser's error as a one-line `DecodeError`. The reason text comes from the `yaml` package. */
function syntaxError(text: string, error: Y.YAMLError): DecodeError {
  const first = (error.message.split("\n")[0] as string).replace(/ at line \d+, column \d+:?$/, "");
  return new DecodeError(first.charAt(0).toLowerCase() + first.slice(1), position(text, error.pos[0]));
}

/** Characters YAML does not allow in a stream (as PyYAML's reader checks them). */
const NON_PRINTABLE = /[^\x09\x0A\x0D\x20-\x7E\x85\xA0-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

/** Decodes YAML (one document, YAML 1.2 core schema) into plain data. */
export function loads(input: string | Uint8Array): PlainData {
  const text = typeof input === "string" ? input : decodeBytes(input);
  const bad = NON_PRINTABLE.exec(text);
  if (bad !== null) {
    const code = (bad[0].codePointAt(0) as number).toString(16).padStart(4, "0");
    throw new DecodeError(`unacceptable character #x${code}: special characters are not allowed`, position(text, bad.index));
  }
  const documents = Y.parseAllDocuments(text, OPTIONS);
  const document = documents[0];
  if (document === undefined) return null;
  const checker = new Checker(text, document);
  const problems = checker.problems;
  problems.push(...document.errors.map((error) => syntaxError(text, error)));
  const second = documents[1];
  if (second !== undefined) checker.problem("expected a single document, found another", second.range[0]);
  checker.visit(document.contents);
  if (problems.length > 0) {
    // the first in document order
    throw problems.reduce((a, b) => ((b.line as number) < (a.line as number) || (b.line === a.line && (b.column as number) < (a.column as number)) ? b : a));
  }
  // Aliases resolve to shared values, as in PyYAML, so there is no expansion to limit.
  return document.toJS({ mapAsMap: true, maxAliasCount: -1 }) as PlainData;
}

// --- Entry points ---

export interface ToYAMLCall {
  (schema: unknown, value: unknown): string;
  OfNative(schema: Schemas.OfNative.Data, value: Native): string;
  OfObject(schema: Schemas.OfObject.Data, value: Visitable): string;
  Reachable(schema: Schemas.OfObject.Data, value: Visitable): string;
}

/** Encodes values, naming the schemas of objects in `store`: `ToYAML(store)(schema, value)` dispatches on the schema's
 * kind. */
export function ToYAML(store: Stores.Store): ToYAMLCall {
  const plain = Plain.ToPlain(store);
  const call = (schema: unknown, value: unknown): string => dumps(plain(schema, value));
  return Object.assign(call, {
    OfNative: (schema: Schemas.OfNative.Data, value: Native) => dumps(plain.OfNative(schema, value)),
    OfObject: (schema: Schemas.OfObject.Data, value: Visitable) => dumps(plain.OfObject(schema, value)),
    Reachable: (schema: Schemas.OfObject.Data, value: Visitable) => dumps(plain.Reachable(schema, value)),
  });
}

export interface FromYAMLCall {
  (schema: unknown, text: string | Uint8Array): unknown;
  OfNative(schema: Schemas.OfNative.Data, text: string | Uint8Array): Native;
  OfObject(schema: Schemas.OfObject.Data, text: string | Uint8Array): unknown;
  Reachable(schema: Schemas.OfObject.Data, text: string | Uint8Array): unknown;
}

/** Decodes YAML, building objects in `store`: `FromYAML(store)(schema, text)`. */
export function FromYAML(store: Stores.Store): FromYAMLCall {
  const plain = Plain.FromPlain(store);
  const call = (schema: unknown, text: string | Uint8Array): unknown => plain(schema, loads(text));
  return Object.assign(call, {
    OfNative: (schema: Schemas.OfNative.Data, text: string | Uint8Array) => plain.OfNative(schema, loads(text)),
    OfObject: (schema: Schemas.OfObject.Data, text: string | Uint8Array) => plain.OfObject(schema, loads(text)),
    Reachable: (schema: Schemas.OfObject.Data, text: string | Uint8Array) => plain.Reachable(schema, loads(text)),
  });
}
