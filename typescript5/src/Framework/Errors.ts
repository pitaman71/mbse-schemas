/**
 * Errors: the error taxonomy shared with the Python implementation.
 *
 * Wrong types raise the built-in `TypeError`. The others mirror Python's built-in exceptions of the same names;
 * `KeyError` is a `LookupError`, as in Python. Problems in data being decoded raise `DecodeError`, the framework's
 * own class, which carries a one-line reason and, where known, a location.
 */

export class ValueError extends Error {
  override name = "ValueError";
}

export class AttributeError extends Error {
  override name = "AttributeError";
}

export class LookupError extends Error {
  override name = "LookupError";
}

export class KeyError extends LookupError {
  override name = "KeyError";
}

export class NotImplementedError extends Error {
  override name = "NotImplementedError";
}

export interface Location {
  line?: number | null;
  column?: number | null;
  path?: string | null;
}

/** A problem in the data being decoded. `message` is `line L, column C: reason`, `$.path: reason`, or the reason alone
 * when there is no location. See FRAMEWORK.md, "Decoding errors". */
export class DecodeError extends ValueError {
  override name = "DecodeError";
  readonly reason: string;
  readonly line: number | null;
  readonly column: number | null;
  readonly path: string | null;

  constructor(reason: string, location: Location = {}) {
    const line = location.line ?? null;
    const column = location.column ?? null;
    const path = location.path ?? null;
    super(line !== null ? `line ${line}, column ${column}: ${reason}` : path !== null ? `${path}: ${reason}` : reason);
    this.reason = reason;
    this.line = line;
    this.column = column;
    this.path = path;
  }

  /** The same problem, located at `path` in plain data. */
  at(path: string): DecodeError {
    return new DecodeError(this.reason, { path });
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A plain-data path: `$`, then `.key` for identifier keys, `["key"]` for other keys and `[i]` for list items. */
export function path(...keys: (string | number)[]): string {
  let out = "$";
  for (const key of keys) {
    if (typeof key === "number") out += `[${key}]`;
    else if (IDENTIFIER.test(key)) out += `.${key}`;
    else out += `[${jsonString(key)}]`;
  }
  return out;
}

/** A string as JSON writes it, without escaping non-ASCII (as Python's `json.dumps(..., ensure_ascii=False)`). */
export function jsonString(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    const code = text.charCodeAt(i);
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (char === "\b") out += "\\b";
    else if (char === "\f") out += "\\f";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += char;
  }
  return out + '"';
}
