/**
 * Errors: the error taxonomy shared with the Python implementation.
 *
 * Wrong types raise the built-in `TypeError`. The others mirror Python's built-in exceptions of the same names;
 * `KeyError` is a `LookupError`, as in Python.
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

/** A JavaScript binding needs `ImportError` only for optional dependencies; kept for parity with Python. */
export class ImportError extends Error {
  override name = "ImportError";
}
