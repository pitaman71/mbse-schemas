"""Schemas: schema elements and their builders.

For each schema element `OfX`, `Schemas.OfX.Data` captures a schema and `Schemas.OfX.Builder` builds one. Builders
take an optional source instance, keep shallow copies of its data, are fluent, and are finalized by `create()`,
`clone()` or `update()`; none validate. Arguments describing a sub-structure are `Spec`s: a direct value, or a
callable that takes and returns the corresponding builder.

`validate()` on each `Data` returns a list of problems and runs only when the caller asks.

Every kind of schema may have a `name`, set by its builder's `.name('crm.Contact')`: identifiers separated by dots, the
part before the last dot its namespace. A named schema is referred to by its name wherever it is written (a module, a
predicate's symbols), and a store registers it under that name; an unnamed one is written inline.

Every kind of schema may declare `parameters` (`OfParameter`), variables determined where the schema is referred to:
`OfApply` applies a parametric schema to arguments. Where a literal width or extent stands, a term may stand instead:
an expression term, such as mbse-expressions', or its neutral `Form`, which may refer to parameters.
"""

from __future__ import annotations

import base64
import binascii
import copy
import dataclasses
import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, ClassVar, Generic, TypeVar

from .Errors import DecodeError
from .Visitors import Native

__all__ = [
    "OfAny",
    "OfNative",
    "OfProperty",
    "OfObject",
    "OfAdjacency",
    "OfRelation",
    "OfUnion",
    "OfIntersection",
    "OfIndexed",
    "OfParameter",
    "OfApply",
    "Form",
    "Evaluate",
    "structure",
    "equivalent",
    "Module",
]

NATIVE_TYPES: tuple[type[Native], ...] = (int, float, str, bool, bytes)

D = TypeVar("D")


def _copy(value: Any) -> Any:
    """Shallow-copies the builder's own containers; references to other schemas are kept, never copied."""
    return copy.copy(value) if isinstance(value, (dict, list, set)) else value


class _Builder(Generic[D]):
    """Shared builder mechanics. Subclasses set `_data` and add fluent accessors that edit `self._fields`."""

    _data: ClassVar[type]

    def __init__(self, instance: D | None = None):
        self._source = instance
        self._fields: dict[str, Any] = (
            {} if instance is None else {f.name: _copy(getattr(instance, f.name)) for f in dataclasses.fields(instance)}
        )

    def _final(self) -> dict[str, Any]:
        return {name: _copy(value) for name, value in self._fields.items()}

    def create(self) -> D:
        """Returns a new `Data`. Only valid without a source instance."""
        if self._source is not None:
            raise ValueError("create() is only valid without a source instance; use clone() or update()")
        return self._data(**self._final())

    def clone(self) -> D:
        """Returns a new `Data`, leaving the source instance untouched. Only valid with a source instance."""
        if self._source is None:
            raise ValueError("clone() is only valid with a source instance")
        return self._data(**self._final())

    def update(self) -> D:
        """Writes the builder state back into the source instance and returns it. Only valid with a source instance."""
        if self._source is None:
            raise ValueError("update() is only valid with a source instance")
        for name, value in self._final().items():
            setattr(self._source, name, value)
        return self._source

    def description(self, text: str) -> Any:
        """What the element is for, in prose: documentation, which no validation or comparison of data reads."""
        self._fields["description"] = text
        return self


class _NamedBuilder(_Builder[D]):
    """A builder of a kind of schema, which may be named."""

    def name(self, name: str) -> Any:
        """The schema's name: identifiers separated by dots, e.g. `'crm.Contact'`."""
        self._fields["name"] = name
        return self

    def parameters(self, *specs: OfParameter.Spec) -> Any:
        """Parameters the schema declares, in order, e.g. `.parameters(lambda p: p.name('n').of(...))`."""
        parameters = self._fields.setdefault("parameters", {})
        for spec in specs:
            parameter = _resolve(spec, _ParameterData, _ParameterBuilder)
            parameters[parameter.name] = parameter
        return self


_DOTTED = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*\Z")


def _name_problems(name: Any) -> list[str]:
    """A schema's name, when it has one, is identifiers separated by dots."""
    if name is None or (isinstance(name, str) and _DOTTED.match(name)):
        return []
    return [f"name {name!r} is not identifiers separated by dots, e.g. 'crm.Contact'"]


def _description_problems(description: Any, where: str = "") -> list[str]:
    """An element's description, when it has one, is text."""
    if description is None or isinstance(description, str):
        return []
    return [f"{where}a description is text, got {type(description).__name__}"]


def _reserved(names: Any) -> list[str]:
    """Problems with names that start with `$`, which the wire format keeps for its own markers (`$ref`, `$schema`,
    `$id`)."""
    return [f"name {name!r} is reserved: names starting with '$' belong to the wire format"
            for name in names if isinstance(name, str) and name.startswith("$")]


_REFLECTION: dict[str, Any] = {"accept": None}
"""Filled by `Reflection`, which writes a schema in its module form, so that this module need not import `Modules`."""


class _Reflected:
    """A schema as an object predicates match (see `Reflection`): a reference object, identified by itself, whose schema
    is its kind's meta-schema."""

    def identity(self) -> int:
        return id(self)

    def schema_name(self) -> str:
        return _KIND_NAMES[type(self)]

    def owner(self) -> None:
        return None

    def accept(self, visitor: Any) -> None:
        _REFLECTION["accept"](self, visitor)


def _resolve(spec: Any, data: type, builder: Callable[[], Any]) -> Any:
    """Resolves a `Spec`: an instance of `data` is used as is; a callable is given a new builder and must return it."""
    if isinstance(spec, data):
        return spec
    if isinstance(spec, type):
        raise TypeError(f"a class is not a Spec here; for a native type use lambda t: t.as_native({spec.__name__})")
    if callable(spec):
        built = spec(builder())
        if built is None or not callable(getattr(built, "create", None)):
            raise TypeError(f"a Spec callable must return its builder, got {built!r}")
        return built.create()
    raise TypeError(f"expected a schema or a callable taking its builder, got {spec!r}")


# --- Terms: expressions where a literal may stand ---


@dataclass(frozen=True)
class _Form:
    """A term's structure, in the neutral form mbse-expressions' terms give (`term.form()`): its `kind`, its native
    `attributes` by name, its ordered `arguments`, each a form, and the `dialect` it is read in, given at its root.
    A form is itself a term, which a module writes and reads back without knowing its dialect."""

    kind: str = ""
    attributes: Mapping[str, Native] = field(default_factory=dict)
    arguments: tuple[Any, ...] = ()
    dialect: str | None = None

    @staticmethod
    def of(term: Any) -> _Form:
        """The form of a term: a form as it is, or the form of a term of a dialect (`term.form()`, whose arguments
        are terms, and `term.dialect().name()`), its arguments' forms within it."""
        if isinstance(term, _Form):
            return term
        if not _is_term(term):
            raise TypeError(f"not a term: {term!r}")
        form = term.form()
        return _Form(form.kind, dict(form.attributes), tuple(_Form._of_argument(a) for a in form.arguments),
                     term.dialect().name())

    @staticmethod
    def _of_argument(term: Any) -> _Form:
        form = _Form.of(term)
        return dataclasses.replace(form, dialect=None) if not isinstance(term, _Form) else form

    def validate(self) -> list[str]:
        problems = [] if isinstance(self.kind, str) and self.kind else [f"a term needs a kind, got {self.kind!r}"]
        if self.dialect is not None and not isinstance(self.dialect, str):
            problems.append(f"a term's dialect is a name, got {self.dialect!r}")
        problems += [f"attribute {name!r} is not a native value: {value!r}" for name, value in self.attributes.items()
                     if type(value) not in NATIVE_TYPES]
        for i, argument in enumerate(self.arguments):
            problems += ([f"argument {i}: {p}" for p in argument.validate()] if isinstance(argument, _Form)
                         else [f"argument {i} is not a term: {argument!r}"])
        return problems


def _is_term(value: Any) -> bool:
    """Whether `value` is a term: a form, or anything with a `form()` and a `dialect()`, as mbse-expressions' terms."""
    return isinstance(value, _Form) or (callable(getattr(value, "form", None)) and callable(getattr(value, "dialect", None)))


def _term_problems(value: Any, what: str) -> list[str]:
    """Problems with a form standing for `what`; a term of a dialect is that dialect's to check."""
    return [f"{what}: {p}" for p in value.validate()] if isinstance(value, _Form) else []


class Form:
    """The neutral form of a term. `Form(kind, attributes, arguments, dialect)`; `Form.of(term)` gives a term's."""

    Data = _Form
    of = staticmethod(_Form.of)
    is_term = staticmethod(_is_term)


# --- OfParameter: a variable a schema declares ---


@dataclass
class _ParameterData:
    """A parameter of the schema that declares it: a variable, named, of a type (None for any), determined where the
    schema is referred to (`OfApply`) and referred to within it by name, as a variable is."""

    name: str = ""
    type: Any = None  # OfAny.Data
    description: str | None = None


class _ParameterBuilder(_Builder[_ParameterData]):
    _data = _ParameterData

    def name(self, name: str) -> _ParameterBuilder:
        self._fields["name"] = name
        return self

    def of(self, spec: OfAny.Spec) -> _ParameterBuilder:
        self._fields["type"] = OfAny.resolve(spec)
        return self


class OfParameter:
    Data = _ParameterData
    Builder = _ParameterBuilder
    Spec = _ParameterData | Callable[[_ParameterBuilder], _ParameterBuilder]


def _parameter_problems(parameters: dict[str, _ParameterData]) -> list[str]:
    problems = _reserved(parameters)
    for name, parameter in parameters.items():
        typed = [] if parameter.type is None else _validate(parameter.type)
        problems += [f"parameter {name!r}: {p}" for p in typed + _description_problems(parameter.description)]
    return problems


# --- OfNative ---


BASIC, PYTHON3 = "basic", "python3"
_BASIC_NAMES = {bool: "bool", int: "int", float: "float", str: "str", bytes: "bytes"}


@dataclass(frozen=True)
class _Token:
    """A native type, named in a format: `basic`, the neutral vocabulary (`bool`, `int`, `float`, `str`, `bytes`), a
    language's (`python3`, `typescript5`, `ccpp`, ...), or any other."""

    format: str = BASIC
    name: str = ""

    def __str__(self) -> str:
        return f"the {self.format} type {self.name!r}"


_HOSTS = {_Token(fmt, name): host for host, name in _BASIC_NAMES.items() for fmt in (BASIC, PYTHON3)}
"""The host types of the tokens this implementation reads: the `basic` ones, and its own format's."""


@dataclass(init=False)
class _NativeData(_Reflected):
    """A native type: a token, and optionally a width in bits or in bytes, an int or a term. A host type given in place
    of the token (`OfNative.Data(int)`) is shorthand for the `basic` token of the same name."""

    token: Any
    bits: Any  # int, a term, or None
    bytes: Any
    name: str | None
    description: str | None
    parameters: dict[str, _ParameterData]

    def __init__(self, token: Any = None, bits: Any = None, bytes: Any = None, name: str | None = None,
                 description: str | None = None, parameters: dict[str, _ParameterData] | None = None):
        self.token = _Token(BASIC, _BASIC_NAMES[token]) if isinstance(token, type) and token in _BASIC_NAMES else token
        self.bits, self.bytes, self.name, self.description = bits, bytes, name, description
        self.parameters = {} if parameters is None else parameters

    @property
    def type(self) -> type[Native] | None:
        """The host type the token maps to, or None when this implementation cannot read the token."""
        return _HOSTS.get(self.token) if isinstance(self.token, _Token) else None

    def host(self) -> type[Native]:
        """The host type the token maps to; raises TypeError when this implementation cannot read the token."""
        if self.type is None:
            raise TypeError(f"{self.token} has no type in this implementation")
        return self.type

    def validate(self) -> list[str]:
        problems = _name_problems(self.name) + _description_problems(self.description) + _parameter_problems(self.parameters)
        if not isinstance(self.token, _Token):
            problems.append(f"unsupported native type {self.token!r}")
        elif not (isinstance(self.token.format, str) and self.token.format and isinstance(self.token.name, str)
                  and self.token.name):
            problems.append("a token needs a format and a name")
        elif self.token.format in (BASIC, PYTHON3) and self.type is None:  # python3: the basic types, by Python's names
            problems.append(f"{self.token.format} has no type {self.token.name!r}")
        for unit, width in (("bits", self.bits), ("bytes", self.bytes)):
            if _is_term(width):
                problems += _term_problems(width, f"a width in {unit}")
            elif width is not None and (type(width) is not int or width < 1):
                problems.append(f"a width in {unit} must be a positive int or a term, got {width!r}")
        if self.bits is not None and self.bytes is not None:
            problems.append("a width is in bits or in bytes, not both")
        return problems

    def to_plain(self, value: Native) -> int | float | str | bool:
        """Converts a native value to plain data that every text encoding can hold: `bytes` become base64 text, and
        non-finite floats become the strings 'NaN', 'Infinity' and '-Infinity'."""
        host = self.host()
        if type(value) is not host:
            raise TypeError(f"expected {host.__name__}, got {type(value).__name__}")
        if isinstance(value, bytes):
            return base64.b64encode(value).decode("ascii")
        if isinstance(value, float) and not math.isfinite(value):
            return "NaN" if math.isnan(value) else "Infinity" if value > 0 else "-Infinity"
        return value

    def to_key(self, value: Native) -> str:
        """A native value as the text of a key over the wire: its plain form when that is text (`str`, `bytes` as
        base64, non-finite floats), a finite float's `repr`, and `true` or `false`."""
        plain = self.to_plain(value)
        if isinstance(plain, bool):
            return "true" if plain else "false"
        return plain if isinstance(plain, str) else repr(plain)

    def from_key(self, text: str) -> Native:
        """The native value a key's text holds; anything but the text `to_key` writes raises `Errors.DecodeError`."""
        host = self._host_for_decoding()
        try:
            value = ({"true": True, "false": False}[text] if host is bool else
                     float(text) if host is float and text not in _NON_FINITE else self.from_plain(text))
        except (KeyError, ValueError):
            value = None
        if value is None or self.to_key(value) != text:
            raise DecodeError(f"expected the text of a {host.__name__} key, got {text!r}")
        return value

    def _host_for_decoding(self) -> type[Native]:
        """The host type, or `Errors.DecodeError` when this implementation cannot read the token."""
        if self.type is None:
            raise DecodeError(f"{self.token} has no type in this implementation")
        return self.type

    def from_plain(self, plain: object) -> Native:
        """Converts plain data back to a native value. Distinct native types are never coerced into each other.
        Plain data that does not hold such a value, or a token this implementation cannot read, raises
        `Errors.DecodeError`."""
        host = self._host_for_decoding()
        if host is bytes:
            if not isinstance(plain, str):
                raise DecodeError(f"expected base64 text for bytes, got {type(plain).__name__}")
            try:
                return base64.b64decode(plain, validate=True)
            except binascii.Error:
                raise DecodeError("invalid base64 text") from None
        if host is float and isinstance(plain, str):
            if plain not in _NON_FINITE:
                raise DecodeError(f"expected a float or one of {sorted(_NON_FINITE)}, got {plain!r}")
            return _NON_FINITE[plain]
        if type(plain) is not host:
            raise DecodeError(f"expected {host.__name__}, got {type(plain).__name__}")
        return plain


_NON_FINITE = {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf}


class _NativeBuilder(_NamedBuilder[_NativeData]):
    _data = _NativeData

    def type(self, native: type[Native]) -> _NativeBuilder:
        """A host type: shorthand for the `basic` token of the same name."""
        self._fields["token"] = _NativeData(native).token
        return self

    def token(self, format: str, name: str) -> _NativeBuilder:
        """A token in any format, e.g. `.token('ccpp', 'int32_t')`."""
        self._fields["token"] = _Token(format, name)
        return self

    def bits(self, width: Any) -> _NativeBuilder:
        """A width in bits: an int, or a term."""
        self._fields["bits"] = width
        return self

    def bytes(self, width: Any) -> _NativeBuilder:
        self._fields["bytes"] = width
        return self


class OfNative:
    """A native value. Conversion to and from the wire format is the responsibility of this element."""

    Data = _NativeData
    Builder = _NativeBuilder
    Token = _Token
    Spec = type | Callable[[_NativeBuilder], _NativeBuilder]

    @staticmethod
    def resolve(spec: OfNative.Spec) -> _NativeData:
        if isinstance(spec, type):
            return _NativeData(spec)
        return _resolve(spec, _NativeData, _NativeBuilder)


# --- OfProperty: a named property of an object or relation ---


@dataclass(eq=False)
class _PropertyData:
    name: str = ""
    type: Any = None  # OfAny.Data
    description: str | None = None


class _PropertyBuilder(_Builder[_PropertyData]):
    _data = _PropertyData

    def name(self, name: str) -> _PropertyBuilder:
        self._fields["name"] = name
        return self

    def of(self, spec: OfAny.Spec) -> _PropertyBuilder:
        self._fields["type"] = OfAny.resolve(spec)
        return self


class OfProperty:
    Data = _PropertyData
    Builder = _PropertyBuilder
    Spec = Callable[[_PropertyBuilder], _PropertyBuilder]


def _properties(fields: dict[str, Any], specs: tuple[OfProperty.Spec, ...]) -> None:
    properties = fields.setdefault("properties", {})
    for spec in specs:
        prop = _resolve(spec, _PropertyData, _PropertyBuilder)
        properties[prop.name] = prop


# --- OfRelation ---


@dataclass(eq=False)
class _RelationData(_Reflected):
    links: tuple[str, ...] = ()
    properties: dict[str, _PropertyData] = field(default_factory=dict)
    uniques: tuple[frozenset[str], ...] = ()
    name: str | None = None
    description: str | None = None
    parameters: dict[str, _ParameterData] = field(default_factory=dict)

    def validate(self) -> list[str]:
        problems = (_name_problems(self.name) + _description_problems(self.description)
                    + _parameter_problems(self.parameters) + _reserved([*self.links, *self.properties]))
        if len(self.links) < 2:
            problems.append("a relation needs at least two links; a one-link relation merges a relation and an object")
        if len(set(self.links)) != len(self.links):
            problems.append(f"duplicate link names in {self.links}")
        clashes = set(self.links) & set(self.properties)
        if clashes:
            problems.append(f"names used as both link and property: {sorted(clashes)}")
        for unique in self.uniques:
            unknown = unique - set(self.links) - set(self.properties)
            if unknown:
                problems.append(f"unique({', '.join(sorted(unique))}) names unknown links or properties {sorted(unknown)}")
        for name, prop in self.properties.items():
            problems += [f"property {name!r}: {p}" for p in _validate(prop.type) + _embedded_problems(prop.type)
                         + _entry_value_problems(prop.type) + _description_problems(prop.description)]
        return problems


def _entry_value_problems(schema: Any, held: str = "held by an entry", seen: frozenset[int] = frozenset()) -> list[str]:
    """An entry property's value object has no adjacencies: an entry is written under each object it links, so its
    value objects would be too, and nothing could link them once. Nor has a value object in a key (`held`), which
    compares by structure. `seen` holds the schemas on the way, so that a schema that holds itself is checked once."""
    if id(schema) in seen:
        return []
    if isinstance(schema, _ObjectData) and schema.adjacencies:
        return [f"a value object {held} cannot have adjacencies"]
    inner = seen | {id(schema)}
    return sorted({problem for member in _members_of(schema) for problem in _entry_value_problems(member, held, inner)})


class _RelationBuilder(_NamedBuilder[_RelationData]):
    _data = _RelationData

    def links(self, *names: str) -> _RelationBuilder:
        self._fields["links"] = tuple(names)
        return self

    def properties(self, *specs: OfProperty.Spec) -> _RelationBuilder:
        _properties(self._fields, specs)
        return self

    def unique(self, *names: str) -> _RelationBuilder:
        """Adds a `unique(S)` clause: the links and properties outside `S` determine `S`."""
        self._fields["uniques"] = (*self._fields.get("uniques", ()), frozenset(names))
        return self


class OfRelation:
    """A relationship between objects, with a named link per linked object. Relations have no caller-facing
    instance builder; entries are added through the adjacencies of the objects they link."""

    Data = _RelationData
    Builder = _RelationBuilder
    Spec = _RelationData | Callable[[_RelationBuilder], _RelationBuilder]

    @staticmethod
    def resolve(spec: OfRelation.Spec) -> _RelationData:
        return _resolve(spec, _RelationData, _RelationBuilder)


# --- OfAdjacency ---


@dataclass(eq=False)
class _AdjacencyData:
    name: str = ""
    relation: _RelationData | None = None
    me: str = ""
    description: str | None = None

    def validate(self) -> list[str]:
        problems = _description_problems(self.description, f"adjacency {self.name!r}: ")
        if problems:
            return problems
        if self.relation is None:
            return [f"adjacency {self.name!r} has no relation"]
        if self.me not in self.relation.links:
            return [f"adjacency {self.name!r}: {self.me!r} is not a link of its relation {self.relation.links}"]
        return []


class _AdjacencyBuilder(_Builder[_AdjacencyData]):
    _data = _AdjacencyData

    def name(self, name: str) -> _AdjacencyBuilder:
        """Name of the accessor on the object, e.g. 'addresses'."""
        self._fields["name"] = name
        return self

    def of(self, spec: OfRelation.Spec) -> _AdjacencyBuilder:
        self._fields["relation"] = OfRelation.resolve(spec)
        return self

    def me(self, link: str) -> _AdjacencyBuilder:
        """The link this object fills."""
        self._fields["me"] = link
        return self


class OfAdjacency:
    """Declares that an `OfObject` is adjacent to an `OfRelation` via a particular link."""

    Data = _AdjacencyData
    Builder = _AdjacencyBuilder
    Spec = Callable[[_AdjacencyBuilder], _AdjacencyBuilder]


# --- OfObject ---


_VALIDATING: set[int] = set()
"""The object schemas being validated, so that one that holds itself is validated once."""


@dataclass(eq=False)
class _ObjectData(_Reflected):
    properties: dict[str, _PropertyData] = field(default_factory=dict)
    adjacencies: dict[str, _AdjacencyData] = field(default_factory=dict)
    singleton: str | None = None
    ref: bool = False  # a reference object schema; otherwise a value object schema
    name: str | None = None
    description: str | None = None
    parameters: dict[str, _ParameterData] = field(default_factory=dict)

    def validate(self) -> list[str]:
        """The schema's problems. A value object schema may hold itself, through a list: its problems are reported once,
        where it is first reached."""
        if id(self) in _VALIDATING:
            return []
        _VALIDATING.add(id(self))
        try:
            return self._problems()
        finally:
            _VALIDATING.discard(id(self))

    def _problems(self) -> list[str]:
        problems = (_name_problems(self.name) + _description_problems(self.description)
                    + _parameter_problems(self.parameters) + _reserved([*self.properties, *self.adjacencies]))
        if self.singleton is not None and not self.ref:
            problems.append("a singleton's schema must be a reference object schema")
        clashes = set(self.properties) & set(self.adjacencies)
        if clashes:
            problems.append(f"names used as both property and adjacency: {sorted(clashes)}")
        for name, prop in self.properties.items():
            problems += [f"property {name!r}: {p}" for p in _validate(prop.type) + _embedded_problems(prop.type)
                         + _description_problems(prop.description)]
        for adjacency in self.adjacencies.values():
            problems += adjacency.validate()
        return problems


class _ObjectBuilder(_NamedBuilder[_ObjectData]):
    _data = _ObjectData

    def properties(self, *specs: OfProperty.Spec) -> _ObjectBuilder:
        _properties(self._fields, specs)
        return self

    def relations(self, *specs: OfAdjacency.Spec) -> _ObjectBuilder:
        adjacencies = self._fields.setdefault("adjacencies", {})
        for spec in specs:
            adjacency = _resolve(spec, _AdjacencyData, _AdjacencyBuilder)
            adjacencies[adjacency.name] = adjacency
        return self

    def singleton(self, name: str) -> _ObjectBuilder:
        """Declares a singleton global name: the one instance exists implicitly and is referenced by this name. A
        singleton is a reference object."""
        self._fields["singleton"] = name
        self._fields["ref"] = True
        return self

    def ref(self) -> _ObjectBuilder:
        """Marks a reference object schema: its objects stand on their own, reached through relations, and no property
        holds one. Without it, the schema describes value objects, which properties hold."""
        self._fields["ref"] = True
        return self


class OfObject:
    Data = _ObjectData
    Builder = _ObjectBuilder
    Spec = _ObjectData | Callable[[_ObjectBuilder], _ObjectBuilder]

    @staticmethod
    def resolve(spec: OfObject.Spec) -> _ObjectData:
        return _resolve(spec, _ObjectData, _ObjectBuilder)


# --- OfUnion / OfIntersection ---


@dataclass(eq=False)
class _MemberData:
    """A named member of a union (a branch) or of an intersection (a part)."""

    name: str = ""
    type: Any = None  # OfAny.Data
    description: str | None = None


class _MemberBuilder(_Builder[_MemberData]):
    _data = _MemberData

    def name(self, name: str) -> _MemberBuilder:
        self._fields["name"] = name
        return self

    def of(self, spec: OfAny.Spec) -> _MemberBuilder:
        self._fields["type"] = OfAny.resolve(spec)
        return self


def _member_problems(a_kind: str, member: str, plural: str, members: tuple[_MemberData, ...]) -> list[str]:
    """Problems with a union's branches (`a_kind` 'a union', `member` 'branch') or an intersection's parts."""
    kind = a_kind.split(" ")[1]
    problems = _reserved(m.name for m in members)
    if len(members) < 2:
        problems.append(f"{a_kind} needs at least two {plural}")
    if len({type(_structure(m.type)) for m in members}) > 1:
        problems.append(f"{kind} {plural} must all be the same kind")
    seen: set[str] = set()
    for i, m in enumerate(members):
        if not isinstance(m.name, str) or not m.name:
            problems.append(f"{member} {i} has no name")
        elif m.name in seen:
            problems.append(f"{member} name {m.name!r} is used more than once")
        seen.add(m.name)
        problems += _description_problems(m.description, f"{member} {m.name!r}: ")
    return problems


def _runtime(schema: Any) -> Any:
    """What tells a value of `schema` apart at run time: a native's host type, a list or a keyed list (whose items'
    types a value does not carry), or any other schema itself."""
    schema = _structure(schema)
    if isinstance(schema, _NativeData):
        return ("native", schema.type if schema.type is not None else schema.token)
    if isinstance(schema, _IndexedData):
        return ("list",) if schema.positional else ("map",)
    return ("schema", id(schema))


def _flat_union_problems(branches: tuple[_MemberData, ...]) -> list[str]:
    """A flat union's branches are told apart by their values' types."""
    problems: list[str] = []
    seen: dict[Any, str] = {}
    for branch in branches:
        key = _runtime(branch.type)
        if key in seen:
            problems.append(f"flat union: branches {seen[key]!r} and {branch.name!r} are not told apart by type")
        seen.setdefault(key, branch.name)
    return problems


def _flat_intersection_problems(parts: tuple[_MemberData, ...]) -> list[str]:
    """A flat intersection's parts are object schemas whose properties have distinct names: its own properties."""
    problems: list[str] = []
    seen: dict[str, str] = {}
    for part in parts:
        schema = _structure(part.type)
        if not isinstance(schema, _ObjectData):
            problems.append(f"flat intersection: part {part.name!r} is not an object schema")
            continue
        for name in schema.properties:
            if name in seen:
                problems.append(f"flat intersection: parts {seen[name]!r} and {part.name!r} both declare {name!r}")
            seen.setdefault(name, part.name)
    return problems


def _members(specs: tuple[Callable[[_MemberBuilder], _MemberBuilder], ...]) -> tuple[_MemberData, ...]:
    return tuple(_resolve(spec, _MemberData, _MemberBuilder) for spec in specs)


@dataclass(eq=False)
class _UnionData(_Reflected):
    branches: tuple[_MemberData, ...] = ()
    name: str | None = None
    description: str | None = None
    parameters: dict[str, _ParameterData] = field(default_factory=dict)
    flat: bool = False
    """Whether a value reads as its branch's value, told apart by type, rather than as an object of one branch."""

    @property
    def properties(self) -> dict[str, _MemberData]:
        """The branches by name: a union value is an object holding exactly one of them."""
        return {branch.name: branch for branch in self.branches}

    def validate(self) -> list[str]:
        return (_name_problems(self.name) + _description_problems(self.description) + _parameter_problems(self.parameters)
                + _member_problems("a union", "branch", "branches", self.branches)
                + (_flat_union_problems(self.branches) if self.flat else []))


class _UnionBuilder(_NamedBuilder[_UnionData]):
    _data = _UnionData

    def branches(self, *specs: Callable[[_MemberBuilder], _MemberBuilder]) -> _UnionBuilder:
        """Named branches, e.g. `.branches(lambda b: b.name('phone').of(Phone), ...)`."""
        self._fields["branches"] = (*self._fields.get("branches", ()), *_members(specs))
        return self

    def flat(self, flat: bool = True) -> _UnionBuilder:
        """A value reads as its branch's value, told apart by type (`Phone | Email`), not as an object of one branch."""
        self._fields["flat"] = flat
        return self


class OfUnion:
    Data = _UnionData
    Builder = _UnionBuilder
    Spec = _UnionData | Callable[[_UnionBuilder], _UnionBuilder]
    Branch = _MemberData

    @staticmethod
    def resolve(spec: OfUnion.Spec) -> _UnionData:
        return _resolve(spec, _UnionData, _UnionBuilder)


@dataclass(eq=False)
class _IntersectionData(_Reflected):
    parts: tuple[_MemberData, ...] = ()
    name: str | None = None
    description: str | None = None
    parameters: dict[str, _ParameterData] = field(default_factory=dict)
    flat: bool = False
    """Whether a value reads its parts' properties as its own, rather than as an object of its parts."""

    @property
    def properties(self) -> dict[str, _MemberData]:
        """The parts by name: an intersection value is an object holding every one of them."""
        return {part.name: part for part in self.parts}

    def validate(self) -> list[str]:
        return (_name_problems(self.name) + _description_problems(self.description) + _parameter_problems(self.parameters)
                + _member_problems("an intersection", "part", "parts", self.parts)
                + (_flat_intersection_problems(self.parts) if self.flat else []))


class _IntersectionBuilder(_NamedBuilder[_IntersectionData]):
    _data = _IntersectionData

    def parts(self, *specs: Callable[[_MemberBuilder], _MemberBuilder]) -> _IntersectionBuilder:
        """Named parts, e.g. `.parts(lambda p: p.name('stamp').of(Stamp), ...)`."""
        self._fields["parts"] = (*self._fields.get("parts", ()), *_members(specs))
        return self

    def flat(self, flat: bool = True) -> _IntersectionBuilder:
        """A value reads its parts' properties as its own (`x.name`), not as an object of its parts (`x.Named.name`)."""
        self._fields["flat"] = flat
        return self


class OfIntersection:
    Data = _IntersectionData
    Builder = _IntersectionBuilder
    Spec = _IntersectionData | Callable[[_IntersectionBuilder], _IntersectionBuilder]
    Part = _MemberData

    @staticmethod
    def resolve(spec: OfIntersection.Spec) -> _IntersectionData:
        return _resolve(spec, _IntersectionData, _IntersectionBuilder)


# --- OfIndexed ---


@dataclass(frozen=True)
class _Extent:
    """The keys a positional list may have: `minimum` to `maximum`, inclusive; `maximum` None for no bound. Either may
    be a term instead of an int."""

    minimum: Any = 0
    maximum: Any = None


@dataclass(eq=False)
class _IndexedData(_Reflected):
    """A list: items of the item schema, in order. Without a key schema, or with a native `int` one, it is positional:
    its keys are its positions, from its extent's minimum. With any other key schema it is keyed: its items are held by
    unique keys of that schema, in insertion order."""

    item: Any = None  # OfAny.Data
    key: Any = None  # OfAny.Data, or None for a positional list
    extent: _Extent | None = None
    name: str | None = None
    description: str | None = None
    parameters: dict[str, _ParameterData] = field(default_factory=dict)

    @property
    def positional(self) -> bool:
        key = _structure(self.key)
        return key is None or (isinstance(key, _NativeData) and key.type is int)

    @property
    def minimum(self) -> int:
        """The first key of a positional list: its extent's minimum, or 0 (also where the minimum is a term)."""
        return self.extent.minimum if self.extent is not None and type(self.extent.minimum) is int else 0

    @property
    def capacity(self) -> int | None:
        """How many items a positional list's extent holds, or None when it has no valid int bounds."""
        extent = self.extent
        if extent is None or type(extent.maximum) is not int or type(extent.minimum) is not int:
            return None
        return extent.maximum - extent.minimum + 1

    def validate(self) -> list[str]:
        problems = (_name_problems(self.name) + _description_problems(self.description) + _parameter_problems(self.parameters)
                    + [f"item: {problem}" for problem in _validate(self.item)])
        if self.key is not None:
            key = _validate(self.key) + _embedded_problems(self.key, role="a key")
            problems += [f"key: {problem}" for problem in key + _entry_value_problems(self.key, "in a key")]
        if self.extent is not None:
            problems += self._extent_problems(self.extent)
        return problems

    def _extent_problems(self, extent: _Extent) -> list[str]:
        problems = [] if self.positional else ["an extent bounds a positional list, whose keys are ints"]
        bounds = (extent.minimum, extent.maximum)
        problems += _term_problems(extent.minimum, "an extent's minimum") + _term_problems(extent.maximum, "an extent's maximum")
        if not (type(extent.minimum) is int or _is_term(extent.minimum)) or not (
                extent.maximum is None or type(extent.maximum) is int or _is_term(extent.maximum)):
            problems.append(f"an extent's minimum and maximum are ints or terms, got {extent.minimum!r} and {extent.maximum!r}")
        elif all(type(bound) is int for bound in bounds) and extent.minimum > extent.maximum:
            problems.append(f"an extent's minimum {extent.minimum} exceeds its maximum {extent.maximum}")
        return problems


class _IndexedBuilder(_NamedBuilder[_IndexedData]):
    _data = _IndexedData

    def of(self, spec: OfAny.Spec) -> _IndexedBuilder:
        """The schema of every item."""
        self._fields["item"] = OfAny.resolve(spec)
        return self

    def key(self, spec: OfAny.Spec) -> _IndexedBuilder:
        """The schema of the keys; any but a native `int` makes the list keyed."""
        self._fields["key"] = OfAny.resolve(spec)
        return self

    def extent(self, minimum: Any = 0, maximum: Any = None) -> _IndexedBuilder:
        """The keys a positional list may have, `minimum` to `maximum`, each an int or a term."""
        self._fields["extent"] = _Extent(minimum, maximum)
        return self


class OfIndexed:
    """A list of items of one schema, held by a property; its items belong to the property's owner."""

    Data = _IndexedData
    Builder = _IndexedBuilder
    Extent = _Extent
    Spec = _IndexedData | Callable[[_IndexedBuilder], _IndexedBuilder]

    @staticmethod
    def resolve(spec: OfIndexed.Spec) -> _IndexedData:
        return _resolve(spec, _IndexedData, _IndexedBuilder)


# --- OfApply: a parametric schema applied to arguments ---


@dataclass(eq=False)
class _ApplyData(_Reflected):
    """A parametric schema applied to arguments: a type whose values are the applied schema's (`of`), with arguments
    for its parameters by name, each a native value or a term. Parameters given no argument stay unbound."""

    of: Any = None  # OfAny.Data
    arguments: dict[str, Any] = field(default_factory=dict)
    name: str | None = None
    description: str | None = None
    parameters: dict[str, _ParameterData] = field(default_factory=dict)

    def validate(self) -> list[str]:
        problems = _name_problems(self.name) + _description_problems(self.description) + _parameter_problems(self.parameters)
        if not isinstance(self.of, _KINDS):
            return [*problems, f"an application applies a schema, got {self.of!r}"]
        if _structure(self) is None:
            return [*problems, "an application cannot apply itself"]
        for name, value in self.arguments.items():
            parameter = self.of.parameters.get(name)
            if parameter is None:
                problems.append(f"the applied schema has no parameter {name!r}")
            else:
                problems += [f"argument {name!r}: {p}" for p in _argument_problems(parameter, value)]
        return problems + [f"of: {problem}" for problem in _validate(self.of)]


def _argument_problems(parameter: _ParameterData, value: Any) -> list[str]:
    """An argument is a term, or a native value, of the parameter's type where that is a native type."""
    if _is_term(value):
        return _term_problems(value, "a term")
    if type(value) not in NATIVE_TYPES:
        return [f"an argument is a native value or a term, got {value!r}"]
    host = parameter.type.type if isinstance(parameter.type, _NativeData) else None
    return [f"expected {host.__name__}, got {type(value).__name__}"] if host is not None and type(value) is not host else []


def _structure(schema: Any) -> Any:
    """The schema that gives a type its structure: an application's applied schema, followed through applications,
    else the schema itself; None for an application that applies itself."""
    seen: set[int] = set()
    while isinstance(schema, _ApplyData):
        if id(schema) in seen:
            return None
        seen.add(id(schema))
        schema = schema.of
    return schema


def structure(schema: Any) -> Any:
    """The schema that gives a type its structure: an application's applied schema (followed through applications),
    else the schema itself. Data of an application is data of its applied schema."""
    return _structure(schema)


Evaluate = Callable[[Any, Mapping[str, Any]], Any]
"""An evaluator the caller gives: the value of a term with parameters' values by name (`evaluate(term, scope)`), or
None where it is unknown, e.g. a parameter it refers to has no value. This package evaluates nothing itself."""

_UNKNOWN = object()


def _applied(schema: Any, evaluate: Evaluate | None) -> tuple[Any, dict[str, Any]]:
    """The schema a type applies, followed through applications, and the values its parameters take: each
    application's arguments, evaluated with the values the application around it gives its own parameters (an unknown
    one as `_UNKNOWN`). A parameter given no argument is left out."""
    values: dict[str, Any] = {}
    seen: set[int] = set()
    while isinstance(schema, _ApplyData) and id(schema) not in seen:
        seen.add(id(schema))
        scope = {name: value for name, value in values.items() if value is not _UNKNOWN}
        values = {name: _evaluated(value, scope, evaluate) for name, value in schema.arguments.items()}
        schema = schema.of
    return schema, values


def _evaluated(value: Any, scope: Mapping[str, Any], evaluate: Evaluate | None) -> Any:
    """An argument's value: a native as it is, a term's as `evaluate` gives it, or `_UNKNOWN`."""
    if not _is_term(value):
        return value
    result = None if evaluate is None else evaluate(value, scope)
    return _UNKNOWN if result is None else result


def equivalent(a: Any, b: Any, evaluate: Evaluate | None = None) -> bool | None:
    """Whether two types are the same after substitution: they apply the same schema (natives by value, other schemas
    by identity), and give its parameters the same values, a parameter unbound in both alike. `Square(4)` and
    `Matrix(4, 4)` are, where `Square[n]` applies `Matrix(n, n)`. None when that depends on a value that is unknown:
    a term with no evaluator, or one `evaluate` cannot evaluate."""
    (base, values), (other, others) = _applied(a, evaluate), _applied(b, evaluate)
    if base != other or set(values) != set(others):
        return False
    pairs = [(values[name], others[name]) for name in values]
    if any(type(x) is not type(y) or x != y for x, y in pairs if x is not _UNKNOWN and y is not _UNKNOWN):
        return False
    return None if any(_UNKNOWN in pair for pair in pairs) else True


class _ApplyBuilder(_NamedBuilder[_ApplyData]):
    _data = _ApplyData

    def of(self, spec: OfAny.Spec) -> _ApplyBuilder:
        """The parametric schema applied."""
        self._fields["of"] = OfAny.resolve(spec)
        return self

    def argument(self, name: str, value: Any) -> _ApplyBuilder:
        """The argument for the parameter `name`: a native value or a term."""
        self._fields.setdefault("arguments", {})[name] = value
        return self

    def arguments(self, *values: Any) -> _ApplyBuilder:
        """Arguments for the applied schema's parameters, in their declared order."""
        of = self._fields.get("of")
        if of is None:
            raise ValueError("positional arguments are taken in the applied schema's parameter order; call .of() first")
        names = list(of.parameters)
        if len(values) > len(names):
            raise ValueError(f"the applied schema has {len(names)} parameters, got {len(values)} arguments")
        for name, value in zip(names, values):
            self.argument(name, value)
        return self


class OfApply:
    """A parametric schema applied to arguments, where a type is expected."""

    Data = _ApplyData
    Builder = _ApplyBuilder
    Spec = _ApplyData | Callable[[_ApplyBuilder], _ApplyBuilder]

    @staticmethod
    def resolve(spec: OfApply.Spec) -> _ApplyData:
        return _resolve(spec, _ApplyData, _ApplyBuilder)


# --- OfAny ---

_KINDS = (_NativeData, _ObjectData, _UnionData, _IntersectionData, _IndexedData, _ApplyData)


def _validate(schema: Any) -> list[str]:
    if not isinstance(schema, _KINDS):
        return [f"not a schema: {schema!r}"]
    return schema.validate()


def _members_of(schema: Any) -> list[Any]:
    """The schemas of the values a value of `schema` holds: a value object's properties, a union's branches, an
    intersection's parts, a list's item, through applications."""
    schema = _structure(schema)
    if isinstance(schema, _IndexedData):
        return [schema.item]
    return [m.type for m in schema.properties.values()] if isinstance(schema, (_ObjectData, _UnionData, _IntersectionData)) else []


def _embedded_problems(schema: Any, seen: frozenset[int] = frozenset(), role: str = "a property's type") -> list[str]:
    """Problems with a property's schema as a value (or a key's, `role`): an object held by a property is a value
    object, so its schema is not a reference object schema; nor are the schemas of the objects a union, an intersection
    or a list holds. `seen` holds the schemas on the way, so that one that holds itself is checked once."""
    schema = _structure(schema)
    if isinstance(schema, _ObjectData):
        return [f"a reference object schema cannot be {role}"] if schema.ref else []
    if id(schema) in seen:
        return []
    inner = seen | {id(schema)}
    return sorted({problem for member in _members_of(schema) for problem in _embedded_problems(member, inner, role)})


class _AnyBuilder:
    """Selects a kind through `as_<kind>(spec)`. Finalizing yields that kind's data, not a wrapper."""

    def __init__(self, instance: OfAny.Data | None = None):
        self._source = instance
        self._selected: OfAny.Data | None = None

    def as_native(self, spec: OfNative.Spec) -> _AnyBuilder:
        self._selected = OfNative.resolve(spec)
        return self

    def as_object(self, spec: OfObject.Spec) -> _AnyBuilder:
        self._selected = OfObject.resolve(spec)
        return self

    def as_union(self, spec: OfUnion.Spec) -> _AnyBuilder:
        self._selected = OfUnion.resolve(spec)
        return self

    def as_intersection(self, spec: OfIntersection.Spec) -> _AnyBuilder:
        self._selected = OfIntersection.resolve(spec)
        return self

    def as_indexed(self, spec: OfIndexed.Spec) -> _AnyBuilder:
        self._selected = OfIndexed.resolve(spec)
        return self

    def as_apply(self, spec: OfApply.Spec) -> _AnyBuilder:
        self._selected = OfApply.resolve(spec)
        return self

    def _require_selected(self) -> OfAny.Data:
        if self._selected is None:
            raise ValueError("no kind selected; call an as_<kind> method")
        return self._selected

    def create(self) -> OfAny.Data:
        if self._source is not None:
            raise ValueError("create() is only valid without a source instance; use clone() or update()")
        return self._require_selected()

    def clone(self) -> OfAny.Data:
        if self._source is None:
            raise ValueError("clone() is only valid with a source instance")
        return self._selected if self._selected is not None else copy.copy(self._source)

    def update(self) -> OfAny.Data:
        if self._source is None:
            raise ValueError("update() is only valid with a source instance")
        selected = self._require_selected()
        if type(selected) is not type(self._source):
            raise TypeError("update() cannot change the kind of the source schema")
        for f in dataclasses.fields(selected):
            setattr(self._source, f.name, _copy(getattr(selected, f.name)))
        return self._source


class OfAny:
    """Where a schema of any kind is expected. `OfAny.Data` is any schema kind's data."""

    Data = _NativeData | _ObjectData | _UnionData | _IntersectionData | _IndexedData | _ApplyData
    Builder = _AnyBuilder
    Spec = Data | Callable[[_AnyBuilder], _AnyBuilder]

    @staticmethod
    def resolve(spec: OfAny.Spec) -> OfAny.Data:
        if isinstance(spec, _KINDS):
            return spec
        return _resolve(spec, _KINDS, _AnyBuilder)


# --- Meta-schemas: the schemas of schema data, so that schemas are written, read, validated and compared as objects ---


def _named_text(name: str) -> OfProperty.Spec:
    return lambda p: p.name(name).of(lambda t: t.as_native(str))


def _list_of(spec: OfAny.Spec) -> Callable[[_AnyBuilder], _AnyBuilder]:
    return lambda t: t.as_indexed(lambda i: i.of(spec))


def _Text(t: _AnyBuilder) -> _AnyBuilder:
    return t.as_native(str)


def _int(t: _AnyBuilder) -> _AnyBuilder:
    return t.as_native(int)


_Named = OfObject.Builder().properties(_named_text("name")).create()
_AnySchema = OfUnion.Builder().create()  # a type; its branches, which refer back to it, are added below
_PropertySchema = OfObject.Builder().properties(_named_text("name"), lambda p: p.name("type").of(_AnySchema),
                                                _named_text("description")).create()
_Parameters: OfProperty.Spec = lambda p: p.name("parameters").of(_list_of(_PropertySchema))  # noqa: E731
_NativeValue = OfUnion.Builder().branches(
    *[lambda b, n=n, t=t: b.name(n).of(lambda x: x.as_native(t)) for t, n in _BASIC_NAMES.items()]).create()
_AttributeSchema = OfObject.Builder().properties(_named_text("name"), lambda p: p.name("value").of(_NativeValue)).create()
_FormSchema = OfObject.Builder().properties(
    _named_text("dialect"), _named_text("kind"), lambda p: p.name("attributes").of(_list_of(_AttributeSchema))).create()
OfObject.Builder(_FormSchema).properties(lambda p: p.name("arguments").of(_list_of(_FormSchema))).update()
_WidthTerms = OfObject.Builder().properties(lambda p: p.name("bits").of(_FormSchema),
                                            lambda p: p.name("bytes").of(_FormSchema)).create()
_NativeSchema = OfObject.Builder().name("Schemas.Native").properties(
    _named_text("name"), _Parameters, _named_text("format"), _named_text("token"), lambda p: p.name("bits").of(_int),
    lambda p: p.name("bytes").of(_int), lambda p: p.name("terms").of(_WidthTerms), _named_text("description")).create()
_RelationSchema = OfObject.Builder().name("Schemas.Relation").properties(
    _named_text("name"), _Parameters, lambda p: p.name("links").of(_list_of(_Text)),
    lambda p: p.name("properties").of(_list_of(_PropertySchema)),
    lambda p: p.name("uniques").of(_list_of(_list_of(_Text))), _named_text("description")).create()
_RelationRef = OfUnion.Builder().branches(lambda b: b.name("relation").of(_RelationSchema),
                                          lambda b: b.name("named").of(_Named)).create()
_AdjacencySchema = OfObject.Builder().properties(
    _named_text("name"), lambda p: p.name("relation").of(_RelationRef), _named_text("me"),
    _named_text("description")).create()
_ObjectSchema = OfObject.Builder().name("Schemas.Object").properties(
    _named_text("name"), _Parameters, lambda p: p.name("properties").of(_list_of(_PropertySchema)),
    lambda p: p.name("adjacencies").of(_list_of(_AdjacencySchema)), _named_text("singleton"),
    lambda p: p.name("ref").of(lambda t: t.as_native(bool)), _named_text("description")).create()
_Flat: OfProperty.Spec = lambda p: p.name("flat").of(lambda t: t.as_native(bool))  # noqa: E731
_UnionSchema = OfObject.Builder().name("Schemas.Union").properties(
    _named_text("name"), _Parameters, lambda p: p.name("branches").of(_list_of(_PropertySchema)), _Flat,
    _named_text("description")).create()
_IntersectionSchema = OfObject.Builder().name("Schemas.Intersection").properties(
    _named_text("name"), _Parameters, lambda p: p.name("parts").of(_list_of(_PropertySchema)), _Flat,
    _named_text("description")).create()
_ExtentTerms = OfObject.Builder().properties(lambda p: p.name("minimum").of(_FormSchema),
                                             lambda p: p.name("maximum").of(_FormSchema)).create()
_ExtentSchema = OfObject.Builder().properties(lambda p: p.name("minimum").of(_int), lambda p: p.name("maximum").of(_int),
                                              lambda p: p.name("terms").of(_ExtentTerms)).create()
_IndexedSchema = OfObject.Builder().name("Schemas.Indexed").properties(
    _named_text("name"), _Parameters, lambda p: p.name("item").of(_AnySchema), lambda p: p.name("key").of(_AnySchema),
    lambda p: p.name("extent").of(_ExtentSchema), _named_text("description")).create()
_ArgumentSchema = OfObject.Builder().properties(_named_text("name"), lambda p: p.name("value").of(_NativeValue),
                                                lambda p: p.name("term").of(_FormSchema)).create()
_ApplySchema = OfObject.Builder().name("Schemas.Apply").properties(
    _named_text("name"), _Parameters, lambda p: p.name("of").of(_AnySchema),
    lambda p: p.name("arguments").of(_list_of(_ArgumentSchema)), _named_text("description")).create()
_KIND_SCHEMAS = (("native", _NativeSchema), ("object", _ObjectSchema), ("union", _UnionSchema),
                 ("intersection", _IntersectionSchema), ("indexed", _IndexedSchema), ("apply", _ApplySchema))
OfUnion.Builder(_AnySchema).branches(*[lambda b, n=n, s=s: b.name(n).of(s) for n, s in _KIND_SCHEMAS],
                                     lambda b: b.name("named").of(_Named)).update()
_Definition = OfUnion.Builder().branches(*[lambda b, n=n, s=s: b.name(n).of(s) for n, s in _KIND_SCHEMAS],
                                         lambda b: b.name("relation").of(_RelationSchema)).create()
_Entry = OfObject.Builder().properties(_named_text("name"), lambda p: p.name("schema").of(_Definition)).create()

OfNative.Schema = _NativeSchema  # type: ignore[attr-defined]
OfProperty.Schema = _PropertySchema  # type: ignore[attr-defined]
OfRelation.Schema = _RelationSchema  # type: ignore[attr-defined]
OfRelation.Ref = _RelationRef  # type: ignore[attr-defined]
OfAdjacency.Schema = _AdjacencySchema  # type: ignore[attr-defined]
OfObject.Schema = _ObjectSchema  # type: ignore[attr-defined]
OfUnion.Schema = _UnionSchema  # type: ignore[attr-defined]
OfIntersection.Schema = _IntersectionSchema  # type: ignore[attr-defined]
OfIndexed.Schema = _IndexedSchema  # type: ignore[attr-defined]
OfParameter.Schema = _PropertySchema  # type: ignore[attr-defined]
OfApply.Schema = _ApplySchema  # type: ignore[attr-defined]
OfApply.Argument = _ArgumentSchema  # type: ignore[attr-defined]
Form.Schema = _FormSchema  # type: ignore[attr-defined]
Form.Value = _NativeValue  # type: ignore[attr-defined]
OfAny.Schema = _AnySchema  # type: ignore[attr-defined]
OfAny.Named = _Named  # type: ignore[attr-defined]
_KIND_NAMES: dict[type, str] = {
    _NativeData: _NativeSchema.name, _ObjectData: _ObjectSchema.name, _UnionData: _UnionSchema.name,
    _IntersectionData: _IntersectionSchema.name, _IndexedData: _IndexedSchema.name, _ApplyData: _ApplySchema.name,
    _RelationData: _RelationSchema.name}


class Module:
    """A named set of schemas, as data. `Module.Schema` is the reference object schema of a module: its `schemas` are a
    list of `Module.Entry` value objects, each a `name` and a `schema`, a `Module.Definition` (a schema of any kind,
    relations included). See `Modules` for the translation between schemas and modules."""

    Schema = OfObject.Builder().name("Schemas.Module").ref().properties(
        lambda p: p.name("schemas").of(_list_of(_Entry))).create()
    Entry = _Entry
    Definition = _Definition
