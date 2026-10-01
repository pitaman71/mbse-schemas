"""Errors: the framework's own error classes.

Mistakes in the calling program raise Python's built-in exceptions. Problems in data being decoded raise
`DecodeError`, which carries a one-line reason and, where known, a location: a line and column in text, or a path in
plain data. See FRAMEWORK.md, "Decoding errors".
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import TypeVar

T = TypeVar("T")

__all__ = ["DecodeError", "path", "item"]

_IDENTIFIER = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")


class DecodeError(ValueError):
    """A problem in the data being decoded. `str(error)` is `line L, column C: reason`, `$.path: reason`, or the
    reason alone when there is no location."""

    def __init__(self, reason: str, *, line: int | None = None, column: int | None = None, path: str | None = None):
        self.reason, self.line, self.column, self.path = reason, line, column, path
        if line is not None:
            text = f"line {line}, column {column}: {reason}"
        elif path is not None:
            text = f"{path}: {reason}"
        else:
            text = reason
        super().__init__(text)

    def at(self, path: str) -> DecodeError:
        """The same problem, located at `path` in plain data."""
        return DecodeError(self.reason, path=path)


def path(*keys: str | int) -> str:
    """A plain-data path: `$`, then `.key` for identifier keys, `["key"]` for other keys and `[i]` for list items."""
    out = "$"
    for key in keys:
        if isinstance(key, int):
            out += f"[{key}]"
        elif _IDENTIFIER.fullmatch(key):
            out += f".{key}"
        else:
            out += f"[{json.dumps(key, ensure_ascii=False)}]"
    return out


def item(items: Sequence[T], index: int) -> T:
    """The item of a list at `index`; raises LookupError for an index the list does not have, negative ones included."""
    if not 0 <= index < len(items):
        raise LookupError(f"the list has no item {index}")
    return items[index]
