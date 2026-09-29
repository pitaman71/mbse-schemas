"""YAML: a thin text encoding of `Plain` data. Requires PyYAML (`pip install schemas[yaml]`).

`ToYAML(schema, value)` returns YAML text; `FromYAML(builders)(schema, text)` rebuilds values with the given
implementation's builders. Both mirror `Plain` and `JSON`.

Loading follows the YAML 1.2 core schema rather than PyYAML's YAML 1.1 defaults: only `true` / `false` are booleans
(not `yes` / `on`), `010` is ten, there are no sexagesimal numbers (`1:30` is a string), and unquoted dates stay
strings. Duplicate keys, aliases to non-plain values, and non-plain types (e.g. `!!binary`, `!!set`, non-string keys)
are rejected. Dumping quotes any string that a YAML 1.1 or 1.2 reader would misread, never emits aliases, and keeps
key order.
"""

from __future__ import annotations

import re
from functools import cache
from typing import Any

from . import Plain, Schemas, Visitors
from .Plain import PlainData

__all__ = ["ToYAML", "FromYAML", "dumps", "loads"]

# YAML 1.2 core schema: https://yaml.org/spec/1.2.2/#1032-tag-resolution
_CORE_RESOLVERS = [
    ("tag:yaml.org,2002:null", r"^(?:~|null|Null|NULL|)$", list("~nN") + [""]),
    ("tag:yaml.org,2002:bool", r"^(?:true|True|TRUE|false|False|FALSE)$", list("tTfF")),
    ("tag:yaml.org,2002:int", r"^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$", list("-+0123456789")),
    (
        "tag:yaml.org,2002:float",
        r"^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$",
        list("-+.0123456789"),
    ),
]


@cache
def _yaml() -> tuple[Any, type, type]:
    try:
        import yaml
    except ImportError as error:
        raise ImportError("YAML support requires PyYAML: pip install 'schemas[yaml]'") from error

    class Loader(yaml.SafeLoader):
        yaml_implicit_resolvers: dict = {}

        def construct_mapping(self, node: Any, deep: bool = False) -> dict:
            seen = set()
            for key_node, _ in node.value:
                key = self.construct_object(key_node, deep=deep)
                if not isinstance(key, str):
                    raise yaml.constructor.ConstructorError(
                        None, None, f"keys must be strings, got {type(key).__name__} {key!r}", key_node.start_mark
                    )
                if key in seen:
                    raise yaml.constructor.ConstructorError(None, None, f"duplicate key {key!r}", key_node.start_mark)
                seen.add(key)
            return super().construct_mapping(node, deep)

    def construct_int(loader: Any, node: Any) -> int:
        text = loader.construct_scalar(node)
        sign = -1 if text.startswith("-") else 1
        digits = text.lstrip("+-")
        if digits.startswith("0x"):
            return sign * int(digits[2:], 16)
        if digits.startswith("0o"):
            return sign * int(digits[2:], 8)
        return sign * int(digits, 10)

    def construct_bool(loader: Any, node: Any) -> bool:
        return loader.construct_scalar(node).lower() == "true"

    Loader.add_constructor("tag:yaml.org,2002:int", construct_int)
    Loader.add_constructor("tag:yaml.org,2002:bool", construct_bool)

    class Dumper(yaml.SafeDumper):
        def ignore_aliases(self, data: Any) -> bool:
            return True

    def represent_str(dumper: Any, data: str) -> Any:
        # PyYAML writes these line breaks raw inside single-quoted scalars, where a reader folds them into a space.
        # Double-quoted style escapes them (e.g. NEL as \N).
        style = '"' if any(c in data for c in "\x85\u2028\u2029") else None
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)

    Dumper.add_representer(str, represent_str)

    for tag, pattern, first in _CORE_RESOLVERS:
        Loader.add_implicit_resolver(tag, re.compile(pattern), first)
        # The dumper keeps PyYAML's YAML 1.1 resolvers and adds the 1.2 ones, so a string either would misread is quoted.
        Dumper.add_implicit_resolver(tag, re.compile(pattern), first)

    return yaml, Loader, Dumper


def _check_plain(value: Any, path: str = "$") -> None:
    if value is None or type(value) in (bool, int, float, str):
        return
    if type(value) is list:
        for i, item in enumerate(value):
            _check_plain(item, f"{path}[{i}]")
        return
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError(f"{path}: keys must be strings, got {type(key).__name__} {key!r}")
            _check_plain(item, f"{path}.{key}")
        return
    raise ValueError(f"{path}: {type(value).__name__} is not plain data")


def dumps(plain: PlainData) -> str:
    """Encodes plain data as YAML, keeping key order."""
    yaml, _, Dumper = _yaml()
    return yaml.dump(plain, Dumper=Dumper, sort_keys=False, allow_unicode=True, default_flow_style=False)


def loads(text: str | bytes) -> PlainData:
    """Decodes YAML (one document, YAML 1.2 core schema) into plain data."""
    yaml, Loader, _ = _yaml()
    try:
        plain = yaml.load(text, Loader=Loader)
    except yaml.YAMLError as error:
        raise ValueError(f"invalid YAML: {error}") from error
    _check_plain(plain)
    return plain


class _ToYAML:
    """`ToYAML(schema, value)` dispatches on the schema's kind."""

    def __call__(self, schema: Schemas.OfAny.Data, value: Any) -> str:
        return dumps(Plain.ToPlain(schema, value))

    @staticmethod
    def OfNative(schema: Schemas.OfNative.Data, value: Any) -> str:
        return dumps(Plain.ToPlain.OfNative(schema, value))

    @staticmethod
    def OfObject(schema: Schemas.OfObject.Data, value: Visitors.Visitable) -> str:
        return dumps(Plain.ToPlain.OfObject(schema, value))

    @staticmethod
    def Reachable(schema: Schemas.OfObject.Data, value: Visitors.Visitable) -> str:
        return dumps(Plain.ToPlain.Reachable(schema, value))


class FromYAML:
    """Decodes YAML, building objects with the given implementation's builders, e.g. `FromYAML(Proxies.Builders)`."""

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


ToYAML = _ToYAML()
