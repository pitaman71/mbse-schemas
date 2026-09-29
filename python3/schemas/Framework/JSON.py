"""JSON: a thin text encoding of `Plain` data.

`ToJSON(schema, value)` returns JSON text; `FromJSON(builders)(schema, text)` rebuilds values with the given
implementation's builders. Both mirror `Plain`: calling them dispatches on the schema's kind, and `.OfNative`,
`.OfObject` and `.Reachable` are the specific forms.

The encoding is strict JSON (RFC 8259). Output never contains NaN or Infinity, because `Schemas.OfNative` gives
non-finite floats a plain form. Input with NaN / Infinity literals or duplicate object keys is rejected.
"""

from __future__ import annotations

import json
from typing import Any

from . import Plain, Schemas, Visitors
from .Plain import PlainData

__all__ = ["ToJSON", "FromJSON", "dumps", "loads"]


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
    raise ValueError(f"{name} is not valid JSON")


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate key {key!r}")
        result[key] = value
    return result


def loads(text: str | bytes) -> PlainData:
    """Decodes strict JSON into plain data."""
    try:
        return json.loads(text, parse_constant=_reject_constant, object_pairs_hook=_unique_keys)
    except ValueError as error:
        # Python appends advice about sys.set_int_max_str_digits(); keep the language-neutral part.
        if str(error).startswith("Exceeds the limit"):
            raise ValueError(str(error).split(";")[0]) from error
        raise


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
