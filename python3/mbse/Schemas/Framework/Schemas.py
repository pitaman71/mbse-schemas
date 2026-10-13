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
    "OfApply",
    "Form",
    "Evaluate",
    "structure",
    "equivalent",
    "Module",
]

SCALAR_TYPES: tuple[type[Scalar], ...] = (int, float, str, bool, bytes)

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


def _visited(names: Any) -> list[str]:
    """Problems with properties, adjacencies and links named `as_*`, which object and entry visitors keep for their own
    methods, so that no name a schema defines collides with them in data instances and builders."""
    return [f"name {name!r} is reserved: names starting with 'as_' belong to the visitor protocol"
            for name in names if isinstance(name, str) and name.startswith("as_")]


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
        raise TypeError(f"a class is not a Spec here; for a scalar type use lambda t: t.as_scalar({spec.__name__})")
    if callable(spec):
        built = spec(builder())
        if built is None or not callable(getattr(built, "create", None)):
            raise TypeError(f"a Spec callable must return its builder, got {built!r}")
        return built.create()
    raise TypeError(f"expected a schema or a callable taking its builder, got {spec!r}")


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
class _ScalarData(_Reflected):
    """A scalar type: a token, and optionally a width in bits or in bytes, an int or a term. A host type given in place
    of the token (`OfScalar.Data(int)`) is shorthand for the `basic` token of the same name."""

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
        return problems

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


class _ScalarBuilder(_NamedBuilder[_ScalarData]):
    _data = _ScalarData

    def type(self, scalar: type[Scalar]) -> _ScalarBuilder:
        """A host type: shorthand for the `basic` token of the same name."""
        self._fields["token"] = _ScalarData(scalar).token
        return self

    def token(self, format: str, name: str) -> _ScalarBuilder:
        """A token in any format, e.g. `.token('ccpp', 'int32_t')`."""
        self._fields["token"] = _Token(format, name)
        return self

    def bits(self, width: Any) -> _ScalarBuilder:
        """A width in bits: an int, or a term."""
        self._fields["bits"] = width
        return self

    def bytes(self, width: Any) -> _ScalarBuilder:
        self._fields["bytes"] = width
        return self


class OfScalar:
    """A scalar value. Conversion to and from the wire format is the responsibility of this element."""

    Data = _ScalarData
    Builder = _ScalarBuilder
    Token = _Token
    Spec = type | Callable[[_ScalarBuilder], _ScalarBuilder]

    @staticmethod
    def resolve(spec: OfScalar.Spec) -> _ScalarData:
        if isinstance(spec, type):
            return _ScalarData(spec)
        return _resolve(spec, _ScalarData, _ScalarBuilder)


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


# --- OfSymbol: a name standing for an object ---


@dataclass(eq=False)
class _SymbolData:
    """A name standing for an object: a predicate's symbol, which a match binds, or an entry's link. Its schema is a
    reference object schema, which a predicate's symbols require and an entry's links may leave unset (None)."""

    name: str = ""
    type: Any = None  # OfAny.Data
    description: str | None = None


class _SymbolBuilder(_Builder[_SymbolData]):
    _data = _SymbolData

    def name(self, name: str) -> _SymbolBuilder:
        self._fields["name"] = name
        return self

    def of(self, spec: OfAny.Spec) -> _SymbolBuilder:
        """The schema of the objects the symbol stands for: a reference object schema."""
        self._fields["type"] = OfAny.resolve(spec)
        return self


class OfSymbol:
    Data = _SymbolData
    Builder = _SymbolBuilder
    Spec = _SymbolData | Callable[[_SymbolBuilder], _SymbolBuilder]


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
        if not self.links:
            problems.append("a relation needs at least one link")
        clashes = set(self.links) & set(self.properties)
        if clashes:
            problems.append(f"names used as both link and property: {sorted(clashes)}")
        for name, link in self.links.items():
            problems += [f"link {name!r}: {p}" for p in _symbol_problems(link)]
        for name, prop in self.properties.items():
            held = _entry_value_problems(prop.type) if len(self.links) > 1 else []  # one owner: written once
            problems += [f"property {name!r}: {p}" for p in _validate(prop.type) + _embedded_problems(prop.type)
                         + held + _description_problems(prop.description)]
        return problems


class _EntryBuilder(_Builder[_EntryData]):
    _data = _EntryData

    def links(self, *specs: OfSymbol.Spec) -> _EntryBuilder:
        """The links, in order, e.g. `.links(lambda s: s.name('owner'))`."""
        links = self._fields.setdefault("links", {})
        for spec in specs:
            link = _resolve(spec, _SymbolData, _SymbolBuilder)
            links[link.name] = link
        return self

    def properties(self, *specs: OfProperty.Spec) -> _EntryBuilder:
        _properties(self._fields, specs)
        return self


class OfEntry:
    """The schema of a relation's entries: their links and properties."""

    Data = _EntryData
    Builder = _EntryBuilder
    Spec = _EntryData | Callable[[_EntryBuilder], _EntryBuilder]

    @staticmethod
    def resolve(spec: OfEntry.Spec) -> _EntryData:
        return _resolve(spec, _EntryData, _EntryBuilder)


# --- OfRelation ---


@dataclass(eq=False)
class _RelationData(_Reflected):
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


def _entry_value_problems(schema: Any, seen: frozenset[int] = frozenset()) -> list[str]:
    """An entry property's value object has no adjacencies, where the entry links two objects or more: it is written
    under each, so its value objects would be too, and nothing could link them once. `seen` holds the schemas on the
    way, so that a schema that holds itself is checked once."""
    if id(schema) in seen:
        return []
    if isinstance(schema, _ObjectData) and schema.adjacencies:
        return ["a value object held by an entry cannot have adjacencies"]
    inner = seen | {id(schema)}
    return sorted({problem for member in _members_of(schema) for problem in _entry_value_problems(member, inner)})


class _RelationBuilder(_NamedBuilder[_RelationData]):
    _data = _RelationData

    def entry(self, spec: OfEntry.Spec) -> _RelationBuilder:
        """The schema of the relation's entries: their links and properties."""
        self._fields["entry"] = OfEntry.resolve(spec)
        return self

    def _edit(self, edit: Callable[[_EntryBuilder], _EntryBuilder]) -> _RelationBuilder:
        """Edits the entry schema through its builder, on a copy, so that the source's stays as it is until `update()`."""
        entry = self._fields.get("entry")
        self._fields["entry"] = edit(_EntryBuilder()).create() if entry is None else edit(_EntryBuilder(entry)).clone()
        return self

    def links(self, *names: str) -> _RelationBuilder:
        """The entry schema's links, by name, in place of any before: symbols without a schema."""
        properties = self._fields["entry"].properties.values() if "entry" in self._fields else ()
        self._fields["entry"] = _EntryBuilder().links(*[lambda s, n=n: s.name(n) for n in names]).properties(
            *properties).create()
        return self

    def properties(self, *specs: OfProperty.Spec) -> _RelationBuilder:
        """Adds properties to the entry schema: `OfEntry.Builder.properties`."""
        return self._edit(lambda e: e.properties(*specs))

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
        if self.me not in self.relation.entry.links:
            return [f"adjacency {self.name!r}: {self.me!r} is not a link of its relation {tuple(self.relation.entry.links)}"]
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
        """The schema's problems. A value object schema may hold itself, through a property or an entry: its problems
        are reported once, where it is first reached."""
        if id(self) in _VALIDATING:
            return []
        _VALIDATING.add(id(self))
        try:
            return self._problems()
        finally:
            _VALIDATING.discard(id(self))

    def _problems(self) -> list[str]:
        problems = (_name_problems(self.name) + _description_problems(self.description)
                    + _parameter_problems(self.parameters) + _reserved([*self.properties, *self.adjacencies])
                    + _visited([*self.properties, *self.adjacencies]))
        if self.singleton is not None and not self.ref:
            problems.append("a singleton's schema must be a reference object schema")
        clashes = set(self.properties) & set(self.adjacencies)
        if clashes:
            problems.append(f"names used as both property and adjacency: {sorted(clashes)}")
        for name, prop in self.properties.items():
            problems += [f"property {name!r}: {p}" for p in _validate(prop.type) + _embedded_problems(prop.type)
                         + _description_problems(prop.description)]
        for name, adjacency in self.adjacencies.items():
            problems += adjacency.validate()
            links = len(adjacency.relation.entry.links) if isinstance(adjacency.relation, _RelationData) else 0
            if not self.ref and links > 1:  # its entries would link it: value objects are never shared
                named = "the relation" if adjacency.relation.name is None else repr(adjacency.relation.name)
                problems.append(f"adjacency {name!r}: a value object schema's adjacency is to a one-link relation, "
                                f"since entries never reference value objects; {named} has {links} links")
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


# --- OfApply: a parametric schema applied to arguments ---


@dataclass(eq=False)
class _ApplyData(_Reflected):
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


class _ApplyBuilder(_NamedBuilder[_ApplyData]):
    _data = _ApplyData

    def of(self, spec: OfAny.Spec) -> _ApplyBuilder:
        """The parametric schema applied."""
        self._fields["of"] = OfAny.resolve(spec)
        return self

    def argument(self, name: str, value: Any) -> _ApplyBuilder:
        """The argument for the parameter `name`: a scalar value or a term."""
        self._fields.setdefault("arguments", {})[name] = value
        return self

    def arguments(self, **values: Any) -> _ApplyBuilder:
        """Arguments by the names of the applied schema's parameters: an application binds by name only."""
        for name, value in values.items():
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


# --- OfPredicate ---


@dataclass(eq=False)
class _PredicateData(_Reflected):
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


class _PredicateBuilder(_NamedBuilder[_PredicateData]):
    _data = _PredicateData

    def symbols(self, *specs: OfSymbol.Spec) -> _PredicateBuilder:
        """The symbols, in order, e.g. `.symbols(lambda s: s.name('person').of(Person))`."""
        symbols = self._fields.setdefault("symbols", {})
        for spec in specs:
            symbol = _resolve(spec, _SymbolData, _SymbolBuilder)
            symbols[symbol.name] = symbol
        return self

    def requires(self, term: Any) -> _PredicateBuilder:
        """The constraint, a term over the symbols and parameters: a `Form`, or a dialect's term."""
        self._fields["requires"] = term
        return self


class OfPredicate:
    """A named constraint over symbols, matched by the caller."""

    Data = _PredicateData
    Builder = _PredicateBuilder
    Spec = _PredicateData | Callable[[_PredicateBuilder], _PredicateBuilder]

    @staticmethod
    def resolve(spec: OfPredicate.Spec) -> _PredicateData:
        return _resolve(spec, _PredicateData, _PredicateBuilder)


# --- OfAny ---

_KINDS = (_ScalarData, _ObjectData, _UnionData, _IntersectionData, _ApplyData)


def _validate(schema: Any) -> list[str]:
    if not isinstance(schema, _KINDS):
        return [f"not a schema: {schema!r}"]
    return schema.validate()


def _members_of(schema: Any) -> list[Any]:
    """The schemas of the values a value of `schema` holds: a value object's properties, a union's branches, an
    intersection's parts, through applications."""
    schema = _structure(schema)
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


class _AnyBuilder:
    """Selects a kind through `as_<kind>(spec)`. Finalizing yields that kind's data, not a wrapper."""

    def __init__(self, instance: OfAny.Data | None = None):
        self._source = instance
        self._selected: OfAny.Data | None = None

    def as_scalar(self, spec: OfScalar.Spec) -> _AnyBuilder:
        self._selected = OfScalar.resolve(spec)
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

    Data = _ScalarData | _ObjectData | _UnionData | _IntersectionData | _ApplyData
    Builder = _AnyBuilder
    Spec = Data | Callable[[_AnyBuilder], _AnyBuilder]

    @staticmethod
    def resolve(spec: OfAny.Spec) -> OfAny.Data:
        if isinstance(spec, _KINDS):
            return spec
        return _resolve(spec, _KINDS, _AnyBuilder)


# --- Meta-schemas: the schemas of schema data, so that schemas are written, read, validated and compared as objects ---


def _named_text(name: str) -> OfProperty.Spec:
    return lambda p: p.name(name).of(lambda t: t.as_scalar(str))


def _listing(adjacency: str, fields: dict[str, Any], keyed: bool = False) -> Callable[[Any], Any]:
    """An adjacency listing elements of a schema: a one-link relation of its own (`owner`), each entry holding `fields`.
    A schema's members are a list, in declaration order, which a schema read back keeps. Keyed, as a module's schemas
    are, entries are keyed by name (`unique` over all but `name`), so written sorted by it."""

    def relation(rel: Any) -> Any:
        rel.links("owner").properties(*[lambda p, n=n, t=t: p.name(n).of(t) for n, t in fields.items()])
        return rel.unique(*[n for n in fields if n != "name"]) if keyed else rel

    return lambda r: r.name(adjacency).me("owner").of(relation)


def _Text(t: _AnyBuilder) -> _AnyBuilder:
    return t.as_scalar(str)


def _int(t: _AnyBuilder) -> _AnyBuilder:
    return t.as_scalar(int)


_Named = OfObject.Builder().properties(_named_text("name")).create()
_AnySchema = OfUnion.Builder().create()  # a type; its branches, which refer back to it, are added below
_PropertySchema = OfObject.Builder().properties(_named_text("name"), lambda p: p.name("type").of(_AnySchema),
                                                _named_text("description")).create()
_MEMBER = {name: prop.type for name, prop in _PropertySchema.properties.items()}  # a member's entry holds a property's
_Parameters = _listing("parameters", _MEMBER)
_ScalarValue = OfUnion.Builder().branches(
    *[lambda b, n=n, t=t: b.name(n).of(lambda x: x.as_scalar(t)) for t, n in _BASIC_NAMES.items()]).create()
_FormSchema = OfObject.Builder().properties(_named_text("dialect"), _named_text("kind")).relations(
    _listing("attributes", {"name": _Text, "value": _ScalarValue})).create()
OfObject.Builder(_FormSchema).relations(_listing("arguments", {"term": _FormSchema})).update()
_WidthTerms = OfObject.Builder().properties(lambda p: p.name("bits").of(_FormSchema),
                                            lambda p: p.name("bytes").of(_FormSchema)).create()
_ScalarSchema = OfObject.Builder().name("Schemas.Scalar").properties(
    _named_text("name"), _named_text("format"), _named_text("token"), lambda p: p.name("bits").of(_int),
    lambda p: p.name("bytes").of(_int), lambda p: p.name("terms").of(_WidthTerms), _named_text("description")).relations(
    _Parameters).create()
_Clause = OfObject.Builder().relations(_listing("names", {"name": _Text})).create()
_RelationSchema = OfObject.Builder().name("Schemas.Relation").properties(
    _named_text("name"), _named_text("description")).relations(
    _Parameters, _listing("links", _MEMBER), _listing("properties", _MEMBER),
    _listing("uniques", {"clause": _Clause})).create()
_RelationRef = OfUnion.Builder().branches(lambda b: b.name("relation").of(_RelationSchema),
                                          lambda b: b.name("named").of(_Named)).create()
_AdjacencySchema = OfObject.Builder().properties(
    _named_text("name"), lambda p: p.name("relation").of(_RelationRef), _named_text("me"),
    _named_text("description")).create()
_ObjectSchema = OfObject.Builder().name("Schemas.Object").properties(
    _named_text("name"), _named_text("singleton"), lambda p: p.name("ref").of(lambda t: t.as_scalar(bool)),
    _named_text("description")).relations(
    _Parameters, _listing("properties", _MEMBER),
    _listing("adjacencies", {name: prop.type for name, prop in _AdjacencySchema.properties.items()})).create()
_Flat: OfProperty.Spec = lambda p: p.name("flat").of(lambda t: t.as_scalar(bool))  # noqa: E731
_UnionSchema = OfObject.Builder().name("Schemas.Union").properties(
    _named_text("name"), _Flat, _named_text("description")).relations(_Parameters, _listing("branches", _MEMBER)).create()
_IntersectionSchema = OfObject.Builder().name("Schemas.Intersection").properties(
    _named_text("name"), _Flat, _named_text("description")).relations(_Parameters, _listing("parts", _MEMBER)).create()
_ArgumentSchema = OfObject.Builder().properties(_named_text("name"), lambda p: p.name("value").of(_ScalarValue),
                                                lambda p: p.name("term").of(_FormSchema)).create()
_ApplySchema = OfObject.Builder().name("Schemas.Apply").properties(
    _named_text("name"), lambda p: p.name("of").of(_AnySchema), _named_text("description")).relations(
    _Parameters, _listing("arguments", {name: prop.type for name, prop in _ArgumentSchema.properties.items()})).create()
_EntrySchema = OfObject.Builder().relations(_listing("links", _MEMBER), _listing("properties", _MEMBER)).create()
_PredicateSchema = OfObject.Builder().name("Schemas.Predicate").properties(
    _named_text("name"), lambda p: p.name("requires").of(_FormSchema), _named_text("description")).relations(
    _Parameters, _listing("symbols", _MEMBER)).create()
_KIND_SCHEMAS = (("scalar", _ScalarSchema), ("object", _ObjectSchema), ("union", _UnionSchema),
                 ("intersection", _IntersectionSchema), ("apply", _ApplySchema))
OfUnion.Builder(_AnySchema).branches(*[lambda b, n=n, s=s: b.name(n).of(s) for n, s in _KIND_SCHEMAS],
                                     lambda b: b.name("named").of(_Named)).update()
_Definition = OfUnion.Builder().branches(*[lambda b, n=n, s=s: b.name(n).of(s) for n, s in _KIND_SCHEMAS],
                                         lambda b: b.name("relation").of(_RelationSchema),
                                         lambda b: b.name("predicate").of(_PredicateSchema)).create()

OfScalar.Schema = _ScalarSchema  # type: ignore[attr-defined]
OfProperty.Schema = _PropertySchema  # type: ignore[attr-defined]
OfAdjacency.Schema = _AdjacencySchema  # type: ignore[attr-defined]
OfParameter.Schema = _PropertySchema  # type: ignore[attr-defined]
OfRelation.Schema = _RelationSchema  # type: ignore[attr-defined]
OfRelation.Ref = _RelationRef  # type: ignore[attr-defined]
OfEntry.Schema = _EntrySchema  # type: ignore[attr-defined]
OfSymbol.Schema = _PropertySchema  # type: ignore[attr-defined]
OfPredicate.Schema = _PredicateSchema  # type: ignore[attr-defined]
OfObject.Schema = _ObjectSchema  # type: ignore[attr-defined]
OfUnion.Schema = _UnionSchema  # type: ignore[attr-defined]
OfIntersection.Schema = _IntersectionSchema  # type: ignore[attr-defined]
OfApply.Schema = _ApplySchema  # type: ignore[attr-defined]
OfApply.Argument = _ArgumentSchema  # type: ignore[attr-defined]
Form.Schema = _FormSchema  # type: ignore[attr-defined]
Form.Value = _ScalarValue  # type: ignore[attr-defined]
OfAny.Schema = _AnySchema  # type: ignore[attr-defined]
OfAny.Named = _Named  # type: ignore[attr-defined]
_KIND_NAMES: dict[type, str] = {
    _ScalarData: _ScalarSchema.name, _ObjectData: _ObjectSchema.name, _UnionData: _UnionSchema.name,
    _IntersectionData: _IntersectionSchema.name, _ApplyData: _ApplySchema.name,
    _RelationData: _RelationSchema.name, _PredicateData: _PredicateSchema.name}


class Module:
    """A named set of schemas, as data. `Module.Schema` is the reference object schema of a module: its `schemas` are an
    adjacency, each entry a `name` and a `schema`, a `Module.Definition` (a schema of any kind, relations and predicates
    included), keyed by name. See `Modules` for the translation between schemas and modules."""

    Schema = OfObject.Builder().name("Schemas.Module").ref().relations(
        _listing("schemas", {"name": _Text, "schema": _Definition}, keyed=True)).create()
    Definition = _Definition
