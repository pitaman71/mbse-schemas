"""YAML: a thin text encoding of `Plain` data. Requires PyYAML (`pip install schemas[yaml]`).

`ToYAML(schema, value)` returns YAML text; `FromYAML(builders)(schema, text)` rebuilds values with the given
implementation's builders. Both mirror `Plain` and `JSON`.

Loading follows the YAML 1.2 core schema rather than PyYAML's YAML 1.1 defaults: only `true` / `false` are booleans
(not `yes` / `on`), `010` is ten, there are no sexagesimal numbers (`1:30` is a string), and unquoted dates stay
strings. Several documents, non-string keys, duplicate keys, undefined aliases and tags other than `!`, `!!str`,
`!!seq` and `!!map` are rejected with `Errors.DecodeError`, with the same reason and position as in the TypeScript
binding. Syntax errors are `DecodeError`s too, with PyYAML's reason. Dumping quotes any string that a YAML 1.1 or 1.2
reader would misread, never emits aliases, and keeps key order.
"""

from __future__ import annotations

import re
from functools import cache
from typing import Any

from . import JSON, Plain, Schemas, Visitors
from .Errors import DecodeError
from .Plain import PlainData

__all__ = ["ToYAML", "FromYAML", "dumps", "loads"]

_CORE_PREFIX = "tag:yaml.org,2002:"
_STR, _SEQ, _MAP = _CORE_PREFIX + "str", _CORE_PREFIX + "seq", _CORE_PREFIX + "map"

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
        raise ImportError("YAML support requires PyYAML: pip install 'mbse-schemas[yaml]'") from error

    class Loader(yaml.SafeLoader):
        """Composes one document, recording each of the framework's own YAML problems with its position."""

        yaml_implicit_resolvers: dict = {}

        def __init__(self, text: str, problems: list[DecodeError]):
            super().__init__(text)
            self.problems = problems

        def problem(self, reason: str, mark: Any) -> None:
            self.problems.append(DecodeError(reason, line=mark.line + 1, column=mark.column + 1))

        def check_tag(self, event: Any, allowed: tuple[str | None, ...]) -> None:
            if event.tag not in allowed:
                shown = event.tag.replace(_CORE_PREFIX, "!!", 1) if event.tag.startswith(_CORE_PREFIX) else event.tag
                self.problem(f"unsupported tag {shown}", event.start_mark)

        def compose_scalar_node(self, anchor: Any) -> Any:
            event = self.peek_event()
            self.check_tag(event, (None, "!", _STR))
            node = super().compose_scalar_node(anchor)
            if event.tag == "!":  # the non-specific tag makes a string, in YAML 1.2
                node.tag = _STR
            return node

        def compose_sequence_node(self, anchor: Any) -> Any:
            self.check_tag(self.peek_event(), (None, "!", _SEQ))
            return super().compose_sequence_node(anchor)

        def compose_mapping_node(self, anchor: Any) -> Any:
            """PyYAML's, checking each key as soon as it is composed, so its problem is recorded before any later
            syntax error is found."""
            start = self.get_event()
            self.check_tag(start, (None, "!", _MAP))
            node = yaml.MappingNode(_MAP, [], start.start_mark, None, flow_style=start.flow_style)
            if anchor is not None:
                self.anchors[anchor] = node
            seen = set()
            while not self.check_event(yaml.MappingEndEvent):
                mark = self.peek_event().start_mark  # where the key is written, even if it is an alias
                key = self.compose_node(node, None)
                if isinstance(key, yaml.SequenceNode):
                    self.problem("keys must be strings, got a sequence", mark)
                elif isinstance(key, yaml.MappingNode):
                    self.problem("keys must be strings, got a mapping", mark)
                elif key.tag != _STR:
                    value = self.construct_object(key)
                    self.problem(f"keys must be strings, got {type(value).__name__} {value!r}", mark)
                elif key.value in seen:
                    self.problem(f"duplicate key {key.value!r}", mark)
                else:
                    seen.add(key.value)
                node.value.append((key, self.compose_node(node, key)))
            node.end_mark = self.get_event().end_mark
            return node

        def load_one(self) -> PlainData:
            """Composes the single document, then constructs it if no problem was recorded."""
            self.get_event()  # stream start
            node = None if self.check_event(yaml.StreamEndEvent) else self.compose_document()
            if not self.check_event(yaml.StreamEndEvent):
                self.problem("expected a single document, found another", self.peek_event().start_mark)
            if self.problems or node is None:
                return None
            return self.construct_document(node)

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
    # The YAML 1.1 specification also makes y / Y / n / N booleans, which PyYAML's own resolver omits; quote them too.
    Dumper.add_implicit_resolver("tag:yaml.org,2002:bool", re.compile(r"^(?:y|Y|n|N)$"), list("yYnN"))

    return yaml, Loader, Dumper


def _check_dump(value: Any) -> None:
    """PyYAML would also write bytes, sets and other objects (e.g. as !!binary); plain data holds none of them."""
    if type(value) is list:
        for item in value:
            _check_dump(item)
    elif type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise TypeError(f"keys must be str, not {type(key).__name__}")
            _check_dump(item)
    elif value is not None and type(value) not in (bool, int, float, str):
        raise TypeError(f"cannot represent {type(value).__name__} as a YAML scalar")


def dumps(plain: PlainData) -> str:
    """Encodes plain data as YAML, keeping key order."""
    _check_dump(plain)
    yaml, _, Dumper = _yaml()
    return yaml.dump(plain, Dumper=Dumper, sort_keys=False, allow_unicode=True, default_flow_style=False)


def _position(text: str, index: int) -> tuple[int, int]:
    """Line and column of `index`, counting line breaks as PyYAML's marks do."""
    line = column = 0
    for i, char in enumerate(text[:index]):
        if char in "\n\x85  " or (char == "\r" and text[i + 1 : i + 2] != "\n"):
            line, column = line + 1, 0
        else:
            column += 1
    return line + 1, column + 1


def _syntax_error(yaml: Any, error: Any, text: str) -> DecodeError:
    """A parser's error as a one-line `DecodeError`. The reason text comes from PyYAML."""
    if isinstance(error, yaml.MarkedYAMLError):
        reason = ", ".join(part for part in (error.context, error.problem) if part)
        mark = error.problem_mark or error.context_mark
        return DecodeError(reason, line=mark.line + 1, column=mark.column + 1)
    # ReaderError: a character YAML does not allow, at a character index
    line, column = _position(text, error.position)
    return DecodeError(str(error).split("\n")[0], line=line, column=column)


def loads(text: str | bytes) -> PlainData:
    """Decodes YAML (one document, YAML 1.2 core schema) into plain data."""
    yaml, Loader, _ = _yaml()
    text = text if isinstance(text, str) else JSON.decode_bytes(text)
    problems: list[DecodeError] = []
    plain = None
    try:
        loader = Loader(text, problems)  # the reader rejects characters YAML does not allow here
        plain = loader.load_one()
        loader.dispose()
    except yaml.YAMLError as error:
        problems.append(_syntax_error(yaml, error, text))
    if problems:  # the first in document order; problems recorded before a syntax error precede it
        raise min(problems, key=lambda p: (p.line, p.column))
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
