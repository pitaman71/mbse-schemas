"""Schemas: schema elements.

For each schema element `OfX`, `Schemas.OfX.Data` captures a schema. `Schemas.OfX.Builder`, which builds one, and
`Schemas.OfX.Schema`, its meta-schema, are `Builders`' (each builder a `Visitors.OfObject` over its meta-schema, built
in a store); importing this package installs them here.

`validate()` on each `Data` returns a list of problems and runs only when the caller asks.

Every kind of schema may have a `name`, set by its builder's `.name('crm.Contact')`: identifiers separated by dots, the
part before the last dot the module it is in. A store registers a named schema under that name.

Every kind of schema may declare `parameters` (`OfParameter`), variables determined where the schema is referred to:
`OfApply` applies a parametric schema to arguments. Where a literal width stands, a term may stand instead:
an expression term, such as mbse-expressions', or its neutral `Form`, which may refer to parameters.

A predicate (`OfPredicate`) names its symbols (`OfSymbol`), each of a reference object schema, and requires a
constraint over them, a term; mbse-schemas knows no dialect, so a term is checked as a `Form` only. A relation holds the
schema of its entries (`OfEntry`): their links, each a symbol, and their properties.
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
from .Visitors import Scalar

__all__ = [
    "OfAny",
    "OfScalar",
    "OfProperty",
    "OfObject",
    "OfAdjacency",
    "OfRelation",
    "OfEntry",
    "OfSymbol",
    "OfPredicate",
    "OfUnion",
    "OfIntersection",
    "OfParameter",
    "OfContainer",
    "OfApply",
    "Form",
    "Evaluate",
    "structure",
    "is_a",
    "inherited",
    "plain_forms",
    "equivalent",
]

SCALAR_TYPES: tuple[type[Scalar], ...] = (int, float, str, bool, bytes)

D = TypeVar("D")


def _copy(value: Any) -> Any:
    """Shallow-copies the builder's own containers; references to other schemas are kept, never copied."""
    return copy.copy(value) if isinstance(value, (dict, list, set)) else value


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


def _visited(names: Any) -> list[str]:
    """Problems with properties, adjacencies and links named `as_*`, which object and entry visitors keep for their own
    methods, so that no name a schema defines collides with them in data instances and builders."""
    return [f"name {name!r} is reserved: names starting with 'as_' belong to the visitor protocol"
            for name in names if isinstance(name, str) and name.startswith("as_")]


# --- Terms: expressions where a literal may stand ---


@dataclass(frozen=True)
class _Form:
    """A term's structure, in the neutral form mbse-expressions' terms give (`term.form()`): its `kind`, its scalar
    `attributes` by name, its ordered `arguments`, each a form, and the `dialect` it is read in, given at its root.
    A form is itself a term, which a module writes and reads back without knowing its dialect."""

    kind: str = ""
    attributes: Mapping[str, Scalar] = field(default_factory=dict)
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
        problems += [f"attribute {name!r} is not a scalar value: {value!r}" for name, value in self.attributes.items()
                     if type(value) not in SCALAR_TYPES]
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


class OfParameter:
    Data = _ParameterData


def _parameter_problems(parameters: dict[str, _ParameterData]) -> list[str]:
    problems = _reserved(parameters)
    for name, parameter in parameters.items():
        typed = [] if parameter.type is None else _validate(parameter.type)
        problems += [f"parameter {name!r}: {p}" for p in typed + _description_problems(parameter.description)]
    return problems


# --- OfScalar ---


BASIC, PYTHON3 = "basic", "python3"
_BASIC_NAMES = {bool: "bool", int: "int", float: "float", str: "str", bytes: "bytes"}


@dataclass(frozen=True)
class _Token:
    """A scalar type, named in a format: `basic`, the neutral vocabulary (`bool`, `int`, `float`, `str`, `bytes`), a
    language's (`python3`, `typescript5`, `ccpp`, ...), or any other."""

    format: str = BASIC
    name: str = ""

    def __str__(self) -> str:
        return f"the {self.format} type {self.name!r}"


_HOSTS = {_Token(fmt, name): host for host, name in _BASIC_NAMES.items() for fmt in (BASIC, PYTHON3)}
"""The host types of the tokens this implementation reads: the `basic` ones, and its own format's."""


@dataclass(init=False)
class _ScalarData:
    """A scalar type: a token, and optionally a width in bits or in bytes, an int or a term. A host type given in place
    of the token (`OfScalar.Data(int)`) is shorthand for the `basic` token of the same name."""

    token: Any
    bits: Any  # int, a term, or None
    bytes: Any
    name: str | None
    description: str | None
    parameters: dict[str, _ParameterData]
    refines: Any  # the scalar schema it refines, or None

    def __init__(self, token: Any = None, bits: Any = None, bytes: Any = None, name: str | None = None,
                 description: str | None = None, parameters: dict[str, _ParameterData] | None = None,
                 refines: Any = None):
        self.token = _Token(BASIC, _BASIC_NAMES[token]) if isinstance(token, type) and token in _BASIC_NAMES else token
        self.bits, self.bytes, self.name, self.description = bits, bytes, name, description
        self.parameters = {} if parameters is None else parameters
        self.refines = refines

    @property
    def type(self) -> type[Scalar] | None:
        """The host type the token maps to, or None when this implementation cannot read the token."""
        return _HOSTS.get(self.token) if isinstance(self.token, _Token) else None

    def host(self) -> type[Scalar]:
        """The host type the token maps to; raises TypeError when this implementation cannot read the token."""
        if self.type is None:
            raise TypeError(f"{self.token} has no type in this implementation")
        return self.type

    def validate(self) -> list[str]:
        problems = _name_problems(self.name) + _description_problems(self.description) + _parameter_problems(self.parameters)
        if not isinstance(self.token, _Token):
            problems.append(f"unsupported scalar type {self.token!r}")
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
        return problems + _refinement_problems(self)

    def to_plain(self, value: Scalar) -> int | float | str | bool:
        """Converts a scalar value to plain data that every text encoding can hold: `bytes` become base64 text, and
        non-finite floats become the strings 'NaN', 'Infinity' and '-Infinity'."""
        host = self.host()
        if type(value) is not host:
            raise TypeError(f"expected {host.__name__}, got {type(value).__name__}")
        if isinstance(value, bytes):
            return base64.b64encode(value).decode("ascii")
        if isinstance(value, float) and not math.isfinite(value):
            return "NaN" if math.isnan(value) else "Infinity" if value > 0 else "-Infinity"
        return value

    def _host_for_decoding(self) -> type[Scalar]:
        """The host type, or `Errors.DecodeError` when this implementation cannot read the token."""
        if self.type is None:
            raise DecodeError(f"{self.token} has no type in this implementation")
        return self.type

    def from_plain(self, plain: object) -> Scalar:
        """Converts plain data back to a scalar value. Distinct scalar types are never coerced into each other.
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


class OfScalar:
    """A scalar value. Conversion to and from the wire format is the responsibility of this element."""

    Data = _ScalarData
    Token = _Token


# --- OfProperty: a named property of an object or relation ---


@dataclass(eq=False)
class _PropertyData:
    name: str = ""
    type: Any = None  # OfAny.Data
    description: str | None = None


class OfProperty:
    Data = _PropertyData


# --- OfSymbol: a name standing for an object ---


@dataclass(eq=False)
class _SymbolData:
    """A name standing for an object: a predicate's symbol, which a match binds, or an entry's link. Its schema is a
    reference object schema, which a predicate's symbols require and an entry's links may leave unset (None)."""

    name: str = ""
    type: Any = None  # OfAny.Data
    description: str | None = None


class OfSymbol:
    Data = _SymbolData


def _symbol_problems(symbol: _SymbolData) -> list[str]:
    """A symbol's schema, when it has one, is a reference object schema."""
    if symbol.type is None:
        return _description_problems(symbol.description)
    problems = _validate(symbol.type)
    target = _structure(symbol.type)
    if not (isinstance(target, _ObjectData) and target.ref):
        problems.append("a symbol stands for a reference object, so its schema is a reference object schema")
    return problems + _description_problems(symbol.description)


# --- OfEntry: the schema of a relation's entries ---


@dataclass(eq=False)
class _EntryData:
    """The schema of a relation's entries: their links, each a symbol, and their properties, both by name in
    declaration order. A relation holds it (`OfRelation.Data.entry`)."""

    links: dict[str, _SymbolData] = field(default_factory=dict)
    properties: dict[str, _PropertyData] = field(default_factory=dict)

    def validate(self) -> list[str]:
        problems = _reserved([*self.links, *self.properties]) + _visited([*self.links, *self.properties])
        if len(self.links) < 2:
            problems.append(f"a relation has two links or more, got {len(self.links)}; a list of values is a container")
        clashes = set(self.links) & set(self.properties)
        if clashes:
            problems.append(f"names used as both link and property: {sorted(clashes)}")
        for name, link in self.links.items():
            problems += [f"link {name!r}: {p}" for p in _symbol_problems(link)]
        for name, prop in self.properties.items():
            problems += [f"property {name!r}: {p}" for p in _validate(prop.type) + _embedded_problems(prop.type)
                         + _description_problems(prop.description)]
        return problems


class OfEntry:
    """The schema of a relation's entries: their links and properties."""

    Data = _EntryData


# --- OfRelation ---


@dataclass(eq=False)
class _RelationData:
    entry: _EntryData = field(default_factory=_EntryData)
    uniques: tuple[frozenset[str], ...] = ()
    name: str | None = None
    description: str | None = None
    parameters: dict[str, _ParameterData] = field(default_factory=dict)

    def validate(self) -> list[str]:
        problems = (_name_problems(self.name) + _description_problems(self.description)
                    + _parameter_problems(self.parameters) + self.entry.validate())
        for unique in self.uniques:
            unknown = unique - set(self.entry.links) - set(self.entry.properties)
            if unknown:
                problems.append(f"unique({', '.join(sorted(unique))}) names unknown links or properties {sorted(unknown)}")
        return problems

    @property
    def open(self) -> bool:
        """Whether the relation is open: it has no `unique` clause, so from each end its entries are a list, in the order
        added, equal entries kept; with one, they are a set."""
        return not self.uniques

    def keys(self, me: str) -> list[tuple[str, ...]]:
        """The keys of the entries seen from the link `me`, one per `unique(S)` clause in declaration order whose
        complement holds `me` and something else: that complement less `me`, in declaration order. `unique(S)` makes
        the links and properties outside `S` determine `S`, so from `me`'s end each key picks out one entry."""
        names = [*self.entry.links, *self.entry.properties]
        rests = [[name for name in names if name not in unique] for unique in self.uniques]
        return [tuple(name for name in rest if name != me) for rest in rests if me in rest and len(rest) > 1]

    def key(self, me: str) -> tuple[str, ...] | None:
        """The first of `keys(me)`, which an adjacency from `me` is indexed by (`at`); None when there is none."""
        keys = self.keys(me)
        return keys[0] if keys else None


class OfRelation:
    """A relationship between objects, with a named link per linked object. Relations have no caller-facing
    instance builder; entries are added through the adjacencies of the objects they link."""

    Data = _RelationData


# --- OfAdjacency ---


@dataclass(eq=False)
class _AdjacencyData:
    name: str = ""
    relation: _RelationData | None = None
    me: str = ""
    description: str | None = None

    def validate(self) -> list[str]:
        label = f"adjacency {self.name!r}" if self.name else "an anonymous adjacency"
        problems = _description_problems(self.description, f"{label}: ")
        if problems:
            return problems
        if self.relation is None:
            return [f"{label} has no relation"]
        if self.me not in self.relation.entry.links:
            return [f"{label}: {self.me!r} is not a link of its relation {tuple(self.relation.entry.links)}"]
        return []


class OfAdjacency:
    """Declares that an `OfObject` is adjacent to an `OfRelation` via a particular link."""

    Data = _AdjacencyData


# --- OfObject ---


_VALIDATING: set[int] = set()
"""The schemas being validated, so that one that holds itself is validated once."""


def _once(validate: Callable[[Any], list[str]]) -> Callable[[Any], list[str]]:
    """A schema's `validate`, for a kind whose values hold others' (an object, a union, an intersection, a container, a
    value of any type): a schema that holds itself has its problems reported once, where it is first reached."""

    def guarded(self: Any) -> list[str]:
        if id(self) in _VALIDATING:
            return []
        _VALIDATING.add(id(self))
        try:
            return validate(self)
        finally:
            _VALIDATING.discard(id(self))

    guarded.__doc__ = validate.__doc__
    return guarded

_LITERAL = r"(?:[^\\()\[\]{}.*+?^$|]|\\[^A-Za-z0-9])*"
_NAMING = re.compile(rf"({_LITERAL})\(\\d\+((?:\\d)*)\)({_LITERAL})")
"""A naming pattern: literal text around one group of digits, `\\d+` then any number of `\\d`, the minimum width."""


def _naming(pattern: str) -> tuple[str, int, str] | None:
    """A naming pattern's literal prefix, the width of its number and its literal suffix; None for another pattern."""
    found = _NAMING.fullmatch(pattern) if isinstance(pattern, str) else None
    if found is None:
        return None
    prefix, digits, suffix = found.groups()
    return re.sub(r"\\(.)", r"\1", prefix), 1 + len(digits) // 2, re.sub(r"\\(.)", r"\1", suffix)


@dataclass(eq=False)
class _ObjectData:
    properties: dict[str, _PropertyData] = field(default_factory=dict)
    adjacencies: dict[str, _AdjacencyData] = field(default_factory=dict)
    singleton: str | None = None
    ref: bool = False  # a reference object schema; otherwise a value object schema
    name: str | None = None
    description: str | None = None
    parameters: dict[str, _ParameterData] = field(default_factory=dict)
    pattern: str | None = None  # a reference object schema's naming pattern, e.g. r"FEA-(\d+\d\d)"
    anonymous: list[_AdjacencyData] = field(default_factory=list)  # the links it may fill with no member
    refines: Any = None  # the object schema it refines, whose members it inherits, or None

    def fills(self, relation: Any, link: str) -> bool:
        """Whether an object of this schema may fill `link` of `relation`: an adjacency, named or anonymous, says so."""
        return any(a.relation is relation and a.me == link for a in (*self.adjacencies.values(), *self.anonymous))

    def name_for(self, number: int) -> str:
        """The name the naming pattern gives the object numbered `number`: the number fills the pattern's group, at its
        minimum width, extending on the left."""
        prefix, width, suffix = _naming(self.pattern)  # type: ignore[arg-type,misc]  # a valid pattern
        return f"{prefix}{number:0{width}d}{suffix}"

    def number_of(self, name: str) -> int | None:
        """The number of a name the naming pattern gives: its literal text around at least the minimum width of ASCII
        digits. None for a name it does not give, or without a valid naming pattern."""
        naming = _naming(self.pattern) if self.pattern is not None else None
        if naming is None:
            return None
        prefix, width, suffix = naming
        digits = name[len(prefix):len(name) - len(suffix)]
        fits = name.startswith(prefix) and name.endswith(suffix) and len(name) >= len(prefix) + len(suffix)
        return int(digits) if fits and len(digits) >= width and digits.isascii() and digits.isdigit() else None

    @_once
    def validate(self) -> list[str]:
        """The schema's problems. A value object schema may hold itself, through a property or an entry."""
        problems = (_name_problems(self.name) + _description_problems(self.description)
                    + _parameter_problems(self.parameters) + _reserved([*self.properties, *self.adjacencies])
                    + _visited([*self.properties, *self.adjacencies]))
        if self.singleton is not None and not self.ref:
            problems.append("a singleton's schema must be a reference object schema")
        if self.pattern is not None:
            if not self.ref:
                problems.append("a naming pattern names reference objects; mark the schema .ref()")
            if self.singleton is not None:
                problems.append("a singleton's schema has no naming pattern: its one instance is named by its global name")
            if _naming(self.pattern) is None:
                problems.append(f"naming pattern {self.pattern!r} is not literal text around one group of digits, "
                                "e.g. 'FEA-(\\d+\\d\\d)'")
        clashes = set(self.properties) & set(self.adjacencies)
        if clashes:
            problems.append(f"names used as both property and adjacency: {sorted(clashes)}")
        for name, prop in self.properties.items():
            problems += [f"property {name!r}: {p}" for p in _validate(prop.type) + _embedded_problems(prop.type)
                         + _description_problems(prop.description)]
        for adjacency in (*self.adjacencies.values(), *self.anonymous):
            problems += adjacency.validate()
            if not self.ref:
                label = f"adjacency {adjacency.name!r}" if adjacency.name else "an anonymous adjacency"
                problems.append(f"{label}: a value object schema has no adjacencies: entries never link value objects, "
                                "which are never shared")
        return problems + _refinement_problems(self)


class OfObject:
    Data = _ObjectData


# --- OfUnion / OfIntersection ---


@dataclass(eq=False)
class _MemberData:
    """A named member of a union (a branch) or of an intersection (a part)."""

    name: str = ""
    type: Any = None  # OfAny.Data
    description: str | None = None


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
    """What tells a value of `schema` apart at run time: a scalar's host type, or any other schema itself."""
    schema = _structure(schema)
    if isinstance(schema, _ScalarData):
        return ("scalar", schema.type if schema.type is not None else schema.token)
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


@dataclass(eq=False)
class _UnionData:
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

    @_once
    def validate(self) -> list[str]:
        return (_name_problems(self.name) + _description_problems(self.description) + _parameter_problems(self.parameters)
                + _member_problems("a union", "branch", "branches", self.branches)
                + (_flat_union_problems(self.branches) if self.flat else []))


class OfUnion:
    Data = _UnionData
    Branch = _MemberData


@dataclass(eq=False)
class _IntersectionData:
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

    @_once
    def validate(self) -> list[str]:
        return (_name_problems(self.name) + _description_problems(self.description) + _parameter_problems(self.parameters)
                + _member_problems("an intersection", "part", "parts", self.parts)
                + (_flat_intersection_problems(self.parts) if self.flat else []))


class OfIntersection:
    Data = _IntersectionData
    Part = _MemberData


# --- OfContainer: elements by index ---


_ORDERED = (int, float, str, bool)
"""The scalar types with a total order: a container indexed by one, or by a value object of them, may be dense or
sparse."""
_LAYOUTS = ("dense", "sparse")


def _index_kind(index: Any) -> str | None:
    """What a container's index allows: "ordered" for a scalar of a type with a total order, or a value object of
    such scalars (several indices, as a tensor's, ordered by its properties in declaration order); "hashable" for any
    other scalar, or a value object of scalars; None otherwise."""
    index = _structure(index)
    if isinstance(index, _ScalarData):
        return "ordered" if index.type in _ORDERED else "hashable"
    if isinstance(index, _ObjectData) and not index.ref and index.properties:
        kinds = {_index_kind(prop.type) if isinstance(_structure(prop.type), _ScalarData) else None
                 for prop in index.properties.values()}
        return None if None in kinds else "hashable" if "hashable" in kinds else "ordered"
    return None


def _integer_like(index: Any) -> bool:
    """Whether an index is an int, or a value object of ints: a dense container's positions, by default."""
    index = _structure(index)
    if isinstance(index, _ScalarData):
        return index.type is int
    return _index_kind(index) == "ordered" and all(_structure(p.type).type is int for p in index.properties.values())


@dataclass(eq=False)
class _ContainerData:
    """A container: elements, each of the element type, held by index, each of the index type. Dense, its elements
    are a packed array; sparse, an associative store of dense blocks; with neither, it is dense where its index is
    integer-like (an int, or a value object of ints), a dict (by index) where its index is otherwise hashable, and its
    elements paired with their indices otherwise."""

    index: Any = None  # OfAny.Data
    element: Any = None  # OfAny.Data
    layout: str | None = None  # "dense", "sparse", or None for the default
    name: str | None = None
    description: str | None = None
    parameters: dict[str, _ParameterData] = field(default_factory=dict)
    refines: Any = None  # the container schema it refines, or None

    @property
    def arrangement(self) -> str:
        """How the container holds its elements: "dense", "sparse", "dict" (by a hashable index), or "entries" (each
        element paired with its index, where the index is neither ordered nor hashable)."""
        if self.layout is not None:
            return self.layout
        kind = _index_kind(self.index)
        return "dense" if _integer_like(self.index) else "dict" if kind is not None else "entries"

    @_once
    def validate(self) -> list[str]:
        problems = _name_problems(self.name) + _description_problems(self.description) + _parameter_problems(self.parameters)
        for role, schema in (("index", self.index), ("element", self.element)):
            if not isinstance(schema, _KINDS):
                problems.append(f"a container's {role} is a schema, got {schema!r}")
            else:
                problems += [f"{role}: {p}" for p in _validate(schema)]
        if self.layout is not None and self.layout not in _LAYOUTS:
            problems.append(f"a container's layout is 'dense' or 'sparse', got {self.layout!r}")
        elif self.layout is not None and isinstance(self.index, _KINDS) and _index_kind(self.index) != "ordered":
            problems.append(f"a {self.layout} container's index has a total order: an int, float, str or bool, or a "
                            "value object of them")
        return problems + _refinement_problems(self)


class OfContainer:
    Data = _ContainerData


# --- OfAny.Value: a value of any type ---


def plain_forms(schema: Any) -> frozenset[str]:
    """The plain forms a value of `schema` may take: "bool", "int", "float", "text", "mapping" or "list". A float may be
    text (`"NaN"`, `"Infinity"`), bytes are text (base64), a dense tensor a mapping where written flat, and a scalar
    whose token this implementation cannot read any form."""
    held = _structure(schema)
    if isinstance(held, _ScalarData):
        forms = {bool: {"bool"}, int: {"int"}, float: {"float", "text"}, str: {"text"}, bytes: {"text"}}
        return frozenset(forms.get(held.type, {"bool", "int", "float", "text", "mapping", "list"}))
    if isinstance(held, _ContainerData):
        index = _structure(held.index)
        if held.arrangement == "dict" and isinstance(index, _ScalarData) and index.type is str:
            return frozenset({"mapping"})
        tensor = held.arrangement == "dense" and isinstance(index, _ObjectData)
        return frozenset({"list", "mapping"}) if tensor else frozenset({"list"})
    if isinstance(held, _AnyValueData):
        return frozenset().union(*map(plain_forms, held.types)) if held.types else frozenset({"mapping"})
    return frozenset({"mapping"}) if held is not None else frozenset()


def _shown_type(schema: Any) -> str:
    """A type in a message: its name, a scalar's token name, or its kind."""
    held = _structure(schema)
    if getattr(schema, "name", None) is not None:
        return schema.name
    if isinstance(held, _ScalarData) and isinstance(held.token, _Token):
        return held.token.name
    return {_ObjectData: "a value object", _UnionData: "a union", _IntersectionData: "an intersection",
            _ContainerData: "a container"}.get(type(held), "a schema")


@dataclass(eq=False)
class _AnyValueData:
    """A value of any type: of one of `types`, where they are given (an `OfAny` restricted to them), else of any type.
    Restricted, a value is written bare, its type the one whose plain form it takes; unrestricted, it is tagged with its
    type, a scalar's token name or a registered schema's name."""

    types: tuple[Any, ...] = ()  # OfAny.Data each
    name: str | None = None
    description: str | None = None
    parameters: dict[str, _ParameterData] = field(default_factory=dict)

    @_once
    def validate(self) -> list[str]:
        problems = _name_problems(self.name) + _description_problems(self.description) + _parameter_problems(self.parameters)
        valid = []
        for schema in self.types:
            if not isinstance(schema, _KINDS):
                problems.append(f"an OfAny's types are schemas, got {schema!r}")
            elif isinstance(_structure(schema), _AnyValueData):
                problems.append("an OfAny's types are schemas of other kinds, not an OfAny")
            else:
                valid.append(schema)
                problems += [f"{_shown_type(schema)}: {p}" for p in _validate(schema)]
        for i, a in enumerate(valid):
            for b in valid[i + 1:]:
                if plain_forms(a) & plain_forms(b):
                    problems.append(f"an OfAny's types {_shown_type(a)} and {_shown_type(b)} are not told apart on the "
                                    "wire")
        return problems


# --- OfApply: a parametric schema applied to arguments ---


@dataclass(eq=False)
class _ApplyData:
    """A parametric schema applied to arguments: a type whose values are the applied schema's (`of`), with arguments
    for its parameters by name, each a scalar value or a term. Parameters given no argument stay unbound."""

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
    """An argument is a term, or a scalar value, of the parameter's type where that is a scalar type."""
    if _is_term(value):
        return _term_problems(value, "a term")
    if type(value) not in SCALAR_TYPES:
        return [f"an argument is a scalar value or a term, got {value!r}"]
    host = parameter.type.type if isinstance(parameter.type, _ScalarData) else None
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
    """An argument's value: a scalar as it is, a term's as `evaluate` gives it, or `_UNKNOWN`."""
    if not _is_term(value):
        return value
    result = None if evaluate is None else evaluate(value, scope)
    return _UNKNOWN if result is None else result


def equivalent(a: Any, b: Any, evaluate: Evaluate | None = None) -> bool | None:
    """Whether two types are the same after substitution: they apply the same schema (scalars by value, other schemas
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


class OfApply:
    """A parametric schema applied to arguments, where a type is expected."""

    Data = _ApplyData


# --- OfPredicate ---


@dataclass(eq=False)
class _PredicateData:
    """A constraint over symbols, each standing for an object of a reference object schema, and parameters: it holds of
    a match, a binding of every symbol to an object of its schema, where its term `requires` holds. Matching, and the
    dialects `requires` may be written in, are the caller's (mbse-patterns'); here it is data, checked as a form."""

    symbols: dict[str, _SymbolData] = field(default_factory=dict)
    requires: Any = None  # a term
    name: str | None = None
    description: str | None = None
    parameters: dict[str, _ParameterData] = field(default_factory=dict)

    def validate(self) -> list[str]:
        problems = (_name_problems(self.name) + _description_problems(self.description)
                    + _parameter_problems(self.parameters) + _reserved(self.symbols))
        clashes = set(self.symbols) & set(self.parameters)
        if clashes:
            problems.append(f"names used as both symbol and parameter: {sorted(clashes)}")
        for name, symbol in self.symbols.items():
            if symbol.type is None:
                problems.append(f"symbol {name!r} needs a schema")
            problems += [f"symbol {name!r}: {p}" for p in _symbol_problems(symbol)]
        if self.requires is not None and not _is_term(self.requires):
            problems.append(f"requires is not a term: {self.requires!r}")
        return problems + _term_problems(self.requires, "requires")


class OfPredicate:
    """A named constraint over symbols, matched by the caller."""

    Data = _PredicateData


# --- OfAny ---

_KINDS = (_ScalarData, _ObjectData, _UnionData, _IntersectionData, _ContainerData, _ApplyData, _AnyValueData)


# --- Refinement ---

_KIND_NOUNS = {_ScalarData: "a scalar schema", _ObjectData: "an object schema", _ContainerData: "a container schema",
               _UnionData: "a union", _IntersectionData: "an intersection", _AnyValueData: "a value of any type",
               _ApplyData: "an application"}


def _kind_noun(schema: Any) -> str:
    return _KIND_NOUNS.get(type(schema), "nothing")  # an application of nothing


def is_a(schema: Any, base: Any) -> bool:
    """Whether `schema` is `base` or refines it, directly or not: a value of it is then a value of `base`."""
    seen: set[int] = set()
    while schema is not None and id(schema) not in seen:
        if schema is base:
            return True
        seen.add(id(schema))
        schema = getattr(structure(schema), "refines", None)
    return False


def _narrows(new: Any, old: Any) -> bool:
    """Whether validation confirms that every value of `new` is a value of `old`: the same schema, a refinement of it,
    or a scalar, container or value object schema whose parts each narrow `old`'s."""
    if new is old or is_a(new, old):
        return True
    new, old = structure(new), structure(old)
    if isinstance(new, _ScalarData) and isinstance(old, _ScalarData):
        return new.token == old.token and not _widening(new, old)
    if isinstance(new, _ContainerData) and isinstance(old, _ContainerData):
        return _narrows(new.index, old.index) and _narrows(new.element, old.element)
    return False


def _widening(new: _ScalarData, old: _ScalarData) -> list[str]:
    """What keeps validation from confirming `new`'s widths are within `old`'s: a width `old` limits that `new` lifts,
    widens, or gives as a term."""
    found = []
    for unit in ("bits", "bytes"):
        limit, width = getattr(old, unit), getattr(new, unit)
        if type(limit) is int and not (type(width) is int and width <= limit):
            found.append(f"its width in {unit} cannot be confirmed within {limit}")
    return found


def _refinement_problems(schema: Any) -> list[str]:
    """A refinement's problems: it refines a schema of its own kind, not itself, and narrows what it redeclares."""
    if schema.refines is None:
        return []
    base = structure(schema.refines)
    if type(base) is not type(schema):
        return [f"refines {_kind_noun(base)}: a refinement stays within its kind, scalar, container or object"]
    if is_a(base, schema):
        return ["refines itself"]
    if isinstance(schema, _ScalarData):
        if schema.token != base.token:
            return [f"refines a scalar of {base.token}, with {schema.token}"]
        return _widening(schema, base)
    if isinstance(schema, _ContainerData):
        return [f"its {role} cannot be confirmed to narrow the refined container's"
                for role in ("index", "element") if not _narrows(getattr(schema, role), getattr(base, role))]
    problems = [] if schema.ref == base.ref else ["a refinement is a reference object schema exactly where what it "
                                                  "refines is one"]
    for name, prop in base.properties.items():
        own = schema.properties.get(name)
        if own is not None and own is not prop and not _narrows(own.type, prop.type):
            problems.append(f"property {name!r} cannot be confirmed to narrow the refined schema's")
    for name, adjacency in base.adjacencies.items():
        own = schema.adjacencies.get(name)
        if own is not None and own is not adjacency and (own.relation is not adjacency.relation or own.me != adjacency.me):
            problems.append(f"adjacency {name!r} redeclares the refined schema's with another relation or link")
    return problems


def _settle(schema: _ObjectData) -> _ObjectData:
    """Gives an object schema the members of the schema it refines, which it has not redeclared, and passes the change
    on to the schemas that refine it."""
    base = structure(schema.refines) if schema.refines is not None else None
    if isinstance(base, _ObjectData) and not is_a(base, schema):
        inherited = schema.__dict__.get("_inherited", (set(), set(), []))
        own_properties = {n: p for n, p in schema.properties.items() if n not in inherited[0]}
        own_adjacencies = {n: a for n, a in schema.adjacencies.items() if n not in inherited[1]}
        own_anonymous = [a for a in schema.anonymous if not any(a is b for b in inherited[2])]
        schema.properties = {**{n: own_properties.get(n, p) for n, p in base.properties.items()},
                             **{n: p for n, p in own_properties.items() if n not in base.properties}}
        schema.adjacencies = {**{n: own_adjacencies.get(n, a) for n, a in base.adjacencies.items()},
                              **{n: a for n, a in own_adjacencies.items() if n not in base.adjacencies}}
        schema.anonymous = [*base.anonymous, *own_anonymous]
        schema.__dict__["_inherited"] = ({n for n in base.properties if n not in own_properties},
                                         {n for n in base.adjacencies if n not in own_adjacencies}, list(base.anonymous))
        refinements = base.__dict__.setdefault("_refinements", [])
        if not any(r is schema for r in refinements):
            refinements.append(schema)
    for refinement in list(schema.__dict__.get("_refinements", [])):
        if refinement.refines is not None and structure(refinement.refines) is schema:
            _settle(refinement)
    return schema


def inherited(schema: _ObjectData) -> tuple[set[str], set[str], list[Any]]:
    """The properties' and adjacencies' names, and the anonymous adjacencies, an object schema has from the one it
    refines rather than its own."""
    return schema.__dict__.get("_inherited", (set(), set(), []))


def _validate(schema: Any) -> list[str]:
    if not isinstance(schema, _KINDS):
        return [f"not a schema: {schema!r}"]
    return schema.validate()


def _members_of(schema: Any) -> list[Any]:
    """The schemas of the values a value of `schema` holds: a value object's properties, a union's branches, an
    intersection's parts, through applications."""
    schema = _structure(schema)
    if isinstance(schema, _ContainerData):
        return [schema.index, schema.element]
    if isinstance(schema, _AnyValueData):
        return list(schema.types)
    return [m.type for m in schema.properties.values()] if isinstance(schema, (_ObjectData, _UnionData, _IntersectionData)) else []


def _embedded_problems(schema: Any, seen: frozenset[int] = frozenset()) -> list[str]:
    """Problems with a property's schema as a value: an object held by a property is a value object, so its schema is
    not a reference object schema; nor are the schemas of the objects a union or an intersection holds. `seen` holds
    the schemas on the way, so that one that holds itself is checked once."""
    schema = _structure(schema)
    if isinstance(schema, _ObjectData):
        return ["a reference object schema cannot be a property's type"] if schema.ref else []
    if id(schema) in seen:
        return []
    inner = seen | {id(schema)}
    return sorted({problem for member in _members_of(schema) for problem in _embedded_problems(member, inner)})


class OfAny:
    """Where a schema of any kind is expected. `OfAny.Data` is any schema kind's data; `OfAny.Value`, the kind of a value
    of any type, or of one of the types it is restricted to."""

    Data = _ScalarData | _ObjectData | _UnionData | _IntersectionData | _ContainerData | _ApplyData | _AnyValueData
    Value = _AnyValueData
