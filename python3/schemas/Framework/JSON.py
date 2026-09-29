"""JSON: a thin text encoding of `Plain` data.

`ToJSON(schema, value)` returns JSON text; `FromJSON(builders)(schema, text)` rebuilds values with the given
implementation's builders. Both mirror `Plain`: calling them dispatches on the schema's kind, and `.OfNative`,
`.OfObject` and `.Reachable` are the specific forms.

The encoding is strict JSON (RFC 8259). Output never contains NaN or Infinity, because `Schemas.OfNative` gives
non-finite floats a plain form. Input with NaN / Infinity literals or duplicate object keys is rejected.

Input problems raise `Errors.DecodeError` with a line and column. `json` reads valid input quickly; when it fails,
`_Parser`, the reference parser shared with the TypeScript binding, reads the input again to report the first problem
the same way in every binding.
"""

from __future__ import annotations

import json
import re
from typing import Any, NoReturn

from . import Plain, Schemas, Visitors
from .Errors import DecodeError
from .Plain import PlainData

__all__ = ["ToJSON", "FromJSON", "dumps", "loads"]

INT_DIGITS_LIMIT = 4300  # as Python's int() from text; also the limit in the other bindings


def _check_keys(value: Any) -> None:
    """`json` would silently turn int, float, bool and None keys into strings; plain data only has string keys."""
    if type(value) is list:
        for item in value:
            _check_keys(item)
    elif type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise TypeError(f"keys must be str, not {type(key).__name__}")
            _check_keys(item)


def dumps(plain: PlainData, *, indent: int | None = None) -> str:
    """Encodes plain data as strict JSON, keeping key order."""
    _check_keys(plain)
    return json.dumps(plain, ensure_ascii=False, allow_nan=False, indent=indent)


def _reject_constant(name: str) -> float:
    raise ValueError(name)


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate key")
    return result


def decode_bytes(data: bytes) -> str:
    """Decodes UTF-8, UTF-16 or UTF-32, detected as JSON specifies (a BOM, or the pattern of zero bytes)."""
    encoding = json.detect_encoding(data)
    try:
        return data.decode(encoding)  # strictly: an encoded lone surrogate is not valid in any of them
    except UnicodeDecodeError:
        raise DecodeError(f"input is not valid {encoding}") from None


def loads(text: str | bytes) -> PlainData:
    """Decodes strict JSON into plain data."""
    text = text if isinstance(text, str) else decode_bytes(text)
    try:
        return json.loads(text, parse_constant=_reject_constant, object_pairs_hook=_unique_keys)
    except ValueError:  # a syntax error, a rejected constant or duplicate key, or an over-long integer
        pass
    return _Parser(text).parse()


_NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?")
_WHITESPACE = re.compile(r"[ \t\n\r]*")
_HEX4 = re.compile(r"[0-9a-fA-F]{4}")
_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}
_WORDS = (("null", None), ("true", True), ("false", False))


class _Parser:
    """The reference JSON reader: RFC 8259, no duplicate keys, no NaN / Infinity. The TypeScript binding uses the same
    algorithm, so both accept the same input and report its first problem at the same place with the same reason."""

    def __init__(self, text: str):
        self.text, self.pos = text, 0

    def fail(self, reason: str, pos: int | None = None) -> NoReturn:
        at = self.pos if pos is None else pos
        line = self.text.count("\n", 0, at) + 1
        raise DecodeError(reason, line=line, column=at - self.text.rfind("\n", 0, at))

    def skip(self) -> None:
        self.pos = _WHITESPACE.match(self.text, self.pos).end()  # type: ignore[union-attr]  # always matches

    def parse(self) -> PlainData:
        if self.text.startswith("﻿"):
            self.fail("unexpected byte order mark")
        self.skip()
        value = self.value()
        self.skip()
        if self.pos != len(self.text):
            self.fail("unexpected data after the value")
        return value

    def value(self) -> PlainData:
        char = self.text[self.pos : self.pos + 1]
        if char == '"':
            return self.string()
        if char == "{":
            return self.object()
        if char == "[":
            return self.array()
        for word, value in _WORDS:
            if self.text.startswith(word, self.pos):
                self.pos += len(word)
                return value
        for constant in ("NaN", "Infinity", "-Infinity"):
            if self.text.startswith(constant, self.pos):
                self.fail(f"{constant} is not valid JSON")
        match = _NUMBER.match(self.text, self.pos)
        if match is None:
            self.fail("expecting a value")
        if match[1] is None and match[2] is None:
            digits = len(match[0].lstrip("-"))
            if digits > INT_DIGITS_LIMIT:
                self.fail(f"an integer has {digits} digits, more than the limit of {INT_DIGITS_LIMIT}")
            self.pos = match.end()
            return int(match[0])
        self.pos = match.end()
        return float(match[0])

    def string(self) -> str:
        start = self.pos
        self.pos += 1
        out = []
        while True:
            char = self.text[self.pos : self.pos + 1]
            if char == "":
                self.fail("unterminated string", start)
            if char == '"':
                self.pos += 1
                return "".join(out)
            if char == "\\":
                escape = self.text[self.pos + 1 : self.pos + 2]
                if escape == "u":
                    unit = self.hex4(self.pos + 2)
                    self.pos += 6
                    if 0xD800 <= unit <= 0xDBFF and self.text.startswith("\\u", self.pos):
                        low = self.hex4(self.pos + 2)
                        if 0xDC00 <= low <= 0xDFFF:
                            out.append(chr(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)))
                            self.pos += 6
                            continue
                    out.append(chr(unit))
                    continue
                if escape == "":
                    self.fail("unterminated string", start)
                if escape not in _ESCAPES:
                    self.fail("invalid escape")
                out.append(_ESCAPES[escape])
                self.pos += 2
                continue
            if ord(char) < 0x20:
                self.fail("invalid control character in a string")
            out.append(char)
            self.pos += 1

    def hex4(self, at: int) -> int:
        if not _HEX4.fullmatch(self.text, at, at + 4):
            self.fail("invalid \\uXXXX escape", at - 1)
        return int(self.text[at : at + 4], 16)

    def object(self) -> dict[str, PlainData]:
        self.pos += 1
        out: dict[str, PlainData] = {}
        self.skip()
        if self.text.startswith("}", self.pos):
            self.pos += 1
            return out
        while True:
            if not self.text.startswith('"', self.pos):
                self.fail("expecting a property name in double quotes")
            start = self.pos
            key = self.string()
            if key in out:
                self.fail(f"duplicate key {key!r}", start)
            self.skip()
            if not self.text.startswith(":", self.pos):
                self.fail("expecting ':'")
            self.pos += 1
            self.skip()
            out[key] = self.value()
            self.skip()
            if self.text.startswith("}", self.pos):
                self.pos += 1
                return out
            if not self.text.startswith(",", self.pos):
                self.fail("expecting ',' or '}'")
            comma = self.pos
            self.pos += 1
            self.skip()
            if self.text.startswith("}", self.pos):
                self.fail("trailing comma before '}'", comma)

    def array(self) -> list[PlainData]:
        self.pos += 1
        out: list[PlainData] = []
        self.skip()
        if self.text.startswith("]", self.pos):
            self.pos += 1
            return out
        while True:
            out.append(self.value())
            self.skip()
            if self.text.startswith("]", self.pos):
                self.pos += 1
                return out
            if not self.text.startswith(",", self.pos):
                self.fail("expecting ',' or ']'")
            comma = self.pos
            self.pos += 1
            self.skip()
            if self.text.startswith("]", self.pos):
                self.fail("trailing comma before ']'", comma)


class _ToJSON:
    """`ToJSON(schema, value)` dispatches on the schema's kind."""

    def __call__(self, schema: Schemas.OfAny.Data, value: Any, *, indent: int | None = None) -> str:
        return dumps(Plain.ToPlain(schema, value), indent=indent)

    @staticmethod
    def OfNative(schema: Schemas.OfNative.Data, value: Any, *, indent: int | None = None) -> str:
        return dumps(Plain.ToPlain.OfNative(schema, value), indent=indent)

    @staticmethod
    def OfObject(schema: Schemas.OfObject.Data, value: Visitors.Visitable, *, indent: int | None = None) -> str:
        return dumps(Plain.ToPlain.OfObject(schema, value), indent=indent)

    @staticmethod
    def Reachable(schema: Schemas.OfObject.Data, value: Visitors.Visitable, *, indent: int | None = None) -> str:
        return dumps(Plain.ToPlain.Reachable(schema, value), indent=indent)


class FromJSON:
    """Decodes JSON, building objects with the given implementation's builders, e.g. `FromJSON(Proxies.Builders)`."""

    def __init__(self, builders: Plain.Builders):
        self._plain = Plain.FromPlain(builders)

    def __call__(self, schema: Schemas.OfAny.Data, text: str | bytes) -> Any:
        return self._plain(schema, loads(text))

    def OfNative(self, schema: Schemas.OfNative.Data, text: str | bytes) -> Any:
        return self._plain.OfNative(schema, loads(text))

    def OfObject(self, schema: Schemas.OfObject.Data, text: str | bytes) -> Any:
        return self._plain.OfObject(schema, loads(text))

    def Reachable(self, schema: Schemas.OfObject.Data, text: str | bytes) -> Any:
        return self._plain.Reachable(schema, loads(text))


ToJSON = _ToJSON()
