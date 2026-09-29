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
