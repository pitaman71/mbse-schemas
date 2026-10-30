"""Schemas: schema elements.

For each schema element `OfX`, `Schemas.OfX.Data` captures a schema. `Schemas.OfX.Builder`, which builds one, is
`Builders`' (each builder a `Visitors.OfObject` over its plain schema, its store's `Schemas.OfX`); importing this package
installs it here.

`validate()` on each `Data` returns a list of problems and runs only when the caller asks.

Every kind of schema may have a `name`, set by its builder's `.name('crm.Contact')`: identifiers separated by dots, the
part before the last dot the module it is in. A store registers a named schema under that name.

A parameter (`OfParameter`) is a name and a description. Which definitions declare parameters, what each can be bound
to, and their bindings are `Parametrics`', a module installed before use ([CAP-112: parameters modeled as schema data](../../../../../mbse-basis/docs/capabilities/CAP-112.md)). Terms, applications and
widths are mbse-expressions' (schema extension 5 to 7 in [FEA-024: expressions as data](../../../../../mbse-basis/docs/features/FEA-024.md#decided)).

A pattern (`OfPattern`) declares symbols (`OfSymbol`), each standing for a reference object, variables
(`OfVariable`), each standing for a value, and the constraints a frame meets (its `requires`, each an `OfExpression` of
boolean result); an expression (`OfExpression`) ranges over a pattern, and a collector (`OfCollector`) folds the frames
of one ([FEA-027: mutations as queries](../../../../../mbse-basis/docs/features/FEA-027.md)). A relation holds the schema of its entries (`OfEntry`): their links, each a symbol,
and their properties.
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
    "OfVariable",
    "OfPattern",
    "OfExpression",
    "OfConstraint",
    "OfCollector",
    "OfUnion",
    "OfIntersection",
    "OfParameter",
    "OfContainer",
    "is_a",
    "inherited",
    "plain_forms",
    "install",
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


# --- OfParameter: a name a definition declares, through `Parametrics` ---


@dataclass
class _ParameterData:
    """A parameter: a name, a symbol standing for what is bound where the definition that declares it is referred to,
    and a description. Its name is its set's entry's (`Parametrics.Defines`)."""

    name: str = ""
    description: str | None = None


class OfParameter:
    Data = _ParameterData


# --- OfScalar ---


_BASIC_NAMES = {bool: "bool", int: "int", float: "float", str: "str", bytes: "bytes"}
"""Each basic scalar's tag, a value of any schema's on the wire: mbse-expressions' Basic dialect's names."""
_HOSTS = {f"Schemas.Of{tag.capitalize()}": host for host, tag in _BASIC_NAMES.items()}
"""The basic scalars, the only scalar schemas, by name, each mapping to its host type (docs/proposals/store-overhaul,
Decided, 8 and 22)."""


@dataclass(init=False)
class _ScalarData:
    """A scalar: one of the five basic scalars, `Schemas.OfBool`, `Schemas.OfInt`, `Schemas.OfFloat`,
    `Schemas.OfStr` and `Schemas.OfBytes`, each mapping to its host type by its name. A host type given in place of the
    name (`OfScalar.Data(int)`) is shorthand for the basic scalar's. Every finer scalar is a domain, mbse-expressions'."""

    name: str | None
    description: str | None

    def __init__(self, host: Any = None, name: str | None = None, description: str | None = None):
        if isinstance(host, type) and host in _BASIC_NAMES:
            name = f"Schemas.Of{_BASIC_NAMES[host].capitalize()}"
        self.name, self.description = name, description

    @property
    def type(self) -> type[Scalar] | None:
        """The host type the basic scalar maps to, or None when it names none."""
        return _HOSTS.get(self.name) if isinstance(self.name, str) else None

    @property
    def tag(self) -> str | None:
        """The basic scalar's tag (`int`), which a value of any schema is tagged with on the wire, or None."""
        return None if self.type is None else _BASIC_NAMES[self.type]

    def host(self) -> type[Scalar]:
        """The host type the basic scalar maps to; raises TypeError when it names none."""
        if self.type is None:
            raise TypeError(f"{_scalar_shown(self)} is not a basic scalar")
        return self.type

    def validate(self) -> list[str]:
        problems = _name_problems(self.name) + _description_problems(self.description)
        if self.type is None:
            problems.append(f"{_scalar_shown(self)} is not a basic scalar: a scalar is Schemas.OfBool, Schemas.OfInt, "
                            "Schemas.OfFloat, Schemas.OfStr or Schemas.OfBytes")
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
        """The host type, or `Errors.DecodeError` when the scalar is not a basic scalar."""
        if self.type is None:
            raise DecodeError(f"{_scalar_shown(self)} is not a basic scalar")
        return self.type

    def from_plain(self, plain: object) -> Scalar:
        """Converts plain data back to a scalar value. Distinct scalars are never coerced into each other.
        Plain data that does not hold such a value, or a scalar that is not a basic scalar, raises
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


def _scalar_shown(scalar: _ScalarData) -> str:
    return "an unnamed scalar" if scalar.name is None else f"the scalar {scalar.name!r}"


class OfScalar:
    """A scalar value. Conversion to and from the wire format is the responsibility of this element."""

    Data = _ScalarData


# --- OfProperty: a named property of an object or relation ---


@dataclass(eq=False)
class _PropertyData:
    name: str = ""
    schema: Any = None  # OfAny.Data
    description: str | None = None
    pattern: str | None = None  # a key's naming pattern, e.g. r"FEA-(\d+\d\d)", from which a value is generated

    def name_for(self, number: int) -> str:
        """The value the naming pattern gives the key numbered `number` (`_name_for`)."""
        return _name_for(self.pattern, number)  # type: ignore[arg-type]  # a valid pattern

    def number_of(self, name: str) -> int | None:
        """The number of a value the naming pattern gives (`_number_of`); None for another value."""
        return _number_of(self.pattern, name)


def _pattern_problems(prop: _PropertyData) -> list[str]:
    """A property's naming pattern: literal text around one group of digits, on a property of text."""
    if prop.pattern is None:
        return []
    problems = []
    if _naming(prop.pattern) is None:
        problems.append(f"naming pattern {prop.pattern!r} is not literal text around one group of digits, "
                        "e.g. 'FEA-(\\d+\\d\\d)'")
    if not (isinstance(prop.schema, _ScalarData) and prop.schema.type is str):
        problems.append("a naming pattern gives text: the property's schema is Schemas.OfStr")
    return problems


class OfProperty:
    Data = _PropertyData


# --- OfSymbol: a name standing for an object ---


@dataclass(eq=False)
class _SymbolData:
    """A name standing for an object: a pattern's symbol, which a frame binds, or an entry's link. Its schema is a
    reference object schema, which either may leave unset (None)."""

    name: str = ""
    schema: Any = None  # OfAny.Data
    description: str | None = None

class OfSymbol:
    Data = _SymbolData


def _symbol_problems(symbol: _SymbolData) -> list[str]:
    """A symbol's schema, when it has one, is a reference object schema, or a kind union: a union of reference object
    schemas, its branches naming the kinds of object it may stand for (object identity 97 in [CAP-109: schemas as linked objects in modules](../../../../../mbse-basis/docs/capabilities/CAP-109.md#decided))."""
    if symbol.schema is None:
        return _description_problems(symbol.description)
    problems = _validate(symbol.schema)
    target = symbol.schema
    if isinstance(target, _UnionData):
        if not all(isinstance(b.schema, _ObjectData) and b.schema.ref for b in target.branches):
            problems.append("a kind union's branches are reference object schemas")
    elif not (isinstance(target, _ObjectData) and target.ref):
        problems.append("a symbol stands for a reference object, so its schema is a reference object schema")
    return problems + _description_problems(symbol.description)


def _kinds(schema: Any) -> dict[str, Any] | None:
    """A kind union's branches' schemas, by name; None for any other schema (object identity 97 in [CAP-109: schemas as linked objects in modules](../../../../../mbse-basis/docs/capabilities/CAP-109.md#decided))."""
    if isinstance(schema, _UnionData) and schema.branches and all(
            isinstance(b.schema, _ObjectData) and b.schema.ref for b in schema.branches):
        return {b.name: b.schema for b in schema.branches}
    return None


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
            problems += [f"property {name!r}: {p}" for p in _validate(prop.schema) + _embedded_problems(prop.schema)
                         + _description_problems(prop.description) + _pattern_problems(prop)]
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

    def validate(self) -> list[str]:
        problems = _name_problems(self.name) + _description_problems(self.description) + self.entry.validate()
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
    owner: bool | None = None  # it points back to the previous element of its object's identity path: its owner

    def validate(self) -> list[str]:
        label = f"adjacency {self.name!r}" if self.name else "an anonymous adjacency"
        problems = _description_problems(self.description, f"{label}: ")
        if problems:
            return problems
        if self.relation is None:
            return [f"{label} has no relation"]
        if self.me not in self.relation.entry.links:
            return [f"{label}: {self.me!r} is not a link of its relation {tuple(self.relation.entry.links)}"]
        return _owner_problems(self, label) if self.owner else []


def _owner_problems(adjacency: _AdjacencyData, label: str) -> list[str]:
    """An owner adjacency's relation makes path resolution unambiguous (object identity 14 in [CAP-118: singletons, owned and counted objects](../../../../../mbse-basis/docs/capabilities/CAP-118.md#decided)): of two
    links, the owner's and the owned's (`me`); a clause holding the owner's link and not the owned's, so that the owned
    object determines its owner, and one holding the owned's and not the owner's, so that the owner and the keys determine
    the owned object."""
    relation = adjacency.relation
    owners = [link for link in relation.entry.links if link != adjacency.me]  # type: ignore[union-attr]
    if len(owners) != 1:
        return [f"{label} is its object's owner: its relation has two links, the owner's and the owned's"]
    owner, owned = owners[0], adjacency.me
    clauses = relation.uniques  # type: ignore[union-attr]
    problems = []
    if not any(owner in clause and owned not in clause for clause in clauses):
        problems.append(f"{label} is its object's owner: no unique clause has {owner!r} without {owned!r}, so that the "
                        "owned object determines its owner")
    if not any(owned in clause and owner not in clause for clause in clauses):
        problems.append(f"{label} is its object's owner: no unique clause has {owned!r} without {owner!r}, so that the "
                        "owner and the keys determine the owned object")
    return problems


class OfAdjacency:
    """Declares that an `OfObject` is adjacent to an `OfRelation` via a particular link."""

    Data = _AdjacencyData


# --- OfObject ---


_VALIDATING: set[int] = set()
"""The schemas being validated, so that one that holds itself is validated once."""


def _once(validate: Callable[[Any], list[str]]) -> Callable[[Any], list[str]]:
    """A schema's `validate`, for a kind whose values hold others' (an object, a union, an intersection, a container, a
    value of any schema): a schema that holds itself has its problems reported once, where it is first reached."""

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


def _name_for(pattern: str, number: int) -> str:
    """The name a naming pattern gives the number `number`: it fills the pattern's group, at its minimum width,
    extending on the left."""
    prefix, width, suffix = _naming(pattern)  # type: ignore[misc]  # a valid pattern
    return f"{prefix}{number:0{width}d}{suffix}"


def _number_of(pattern: str | None, name: str) -> int | None:
    """The number of a name a naming pattern gives: its literal text around at least the minimum width of ASCII digits.
    None for a name it does not give, or without a valid naming pattern."""
    naming = _naming(pattern) if pattern is not None else None
    if naming is None:
        return None
    prefix, width, suffix = naming
    digits = name[len(prefix):len(name) - len(suffix)]
    fits = name.startswith(prefix) and name.endswith(suffix) and len(name) >= len(prefix) + len(suffix)
    return int(digits) if fits and len(digits) >= width and digits.isascii() and digits.isdigit() else None


@dataclass(eq=False)
class _ObjectData:
    properties: dict[str, _PropertyData] = field(default_factory=dict)
    adjacencies: dict[str, _AdjacencyData] = field(default_factory=dict)
    singleton: str | None = None
    ref: bool = False  # a reference object schema; otherwise a value object schema
    name: str | None = None
    description: str | None = None
    anonymous: list[_AdjacencyData] = field(default_factory=list)  # the links it may fill with no member
    refines: Any = None  # the object schema it refines, whose members it inherits, or None

    def fills(self, relation: Any, link: str) -> bool:
        """Whether an object of this schema may fill `link` of `relation`: an adjacency, named or anonymous, says so."""
        return any(a.relation is relation and a.me == link for a in (*self.adjacencies.values(), *self.anonymous))

    @_once
    def validate(self) -> list[str]:
        """The schema's problems. A value object schema may hold itself, through a property or an entry."""
        problems = (_name_problems(self.name) + _description_problems(self.description)
                    + _reserved([*self.properties, *self.adjacencies])
                    + _visited([*self.properties, *self.adjacencies]))
        if self.singleton is not None and not self.ref:
            problems.append("a singleton's schema must be a reference object schema")
        clashes = set(self.properties) & set(self.adjacencies)
        if clashes:
            problems.append(f"names used as both property and adjacency: {sorted(clashes)}")
        for name, prop in self.properties.items():
            problems += [f"property {name!r}: {p}" for p in _validate(prop.schema) + _embedded_problems(prop.schema)
                         + _description_problems(prop.description) + _pattern_problems(prop)]
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
    schema: Any = None  # OfAny.Data
    description: str | None = None


def _member_problems(a_kind: str, member: str, plural: str, members: tuple[_MemberData, ...]) -> list[str]:
    """Problems with a union's branches (`a_kind` 'a union', `member` 'branch') or an intersection's parts."""
    kind = a_kind.split(" ")[1]
    problems = _reserved(m.name for m in members)
    if len(members) < 2:
        problems.append(f"{a_kind} needs at least two {plural}")
    if len({type(m.schema) for m in members}) > 1:
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
    """What tells a value of `schema` apart at run time: a scalar's host type, or its name where it is not a basic
    scalar, or any other schema itself."""
    if isinstance(schema, _ScalarData):
        return ("scalar", schema.type if schema.type is not None else schema.name)
    return ("schema", id(schema))


def _flat_union_problems(branches: tuple[_MemberData, ...]) -> list[str]:
    """A flat union's branches are told apart by their values' schemas."""
    problems: list[str] = []
    seen: dict[Any, str] = {}
    for branch in branches:
        key = _runtime(branch.schema)
        if key in seen:
            problems.append(f"flat union: branches {seen[key]!r} and {branch.name!r} are not told apart by schema")
        seen.setdefault(key, branch.name)
    return problems


def _flat_intersection_problems(parts: tuple[_MemberData, ...]) -> list[str]:
    """A flat intersection's parts are object schemas whose properties have distinct names: its own properties."""
    problems: list[str] = []
    seen: dict[str, str] = {}
    for part in parts:
        schema = part.schema
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
    flat: bool = False
    """Whether a value reads as its branch's value, told apart by schema, rather than as an object of one branch."""

    @property
    def properties(self) -> dict[str, _MemberData]:
        """The branches by name: a union value is an object holding exactly one of them."""
        return {branch.name: branch for branch in self.branches}

    @_once
    def validate(self) -> list[str]:
        return (_name_problems(self.name) + _description_problems(self.description)
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
    flat: bool = False
    """Whether a value reads its parts' properties as its own, rather than as an object of its parts."""

    @property
    def properties(self) -> dict[str, _MemberData]:
        """The parts by name: an intersection value is an object holding every one of them."""
        return {part.name: part for part in self.parts}

    @_once
    def validate(self) -> list[str]:
        return (_name_problems(self.name) + _description_problems(self.description)
                + _member_problems("an intersection", "part", "parts", self.parts)
                + (_flat_intersection_problems(self.parts) if self.flat else []))


class OfIntersection:
    Data = _IntersectionData
    Part = _MemberData


# --- OfContainer: elements by index ---


_ORDERED = (int, float, str, bool)
"""The scalars with a total order: a container indexed by one, or by a value object of them, may be dense or
sparse."""
_LAYOUTS = ("dense", "sparse")


def _index_kind(index: Any) -> str | None:
    """What a container's index allows: "ordered" for a scalar with a total order, or a value object of
    such scalars (several indices, as a tensor's, ordered by its properties in declaration order); "hashable" for any
    other scalar, or a value object of scalars; None otherwise."""
    if isinstance(index, _ScalarData):
        return "ordered" if index.type in _ORDERED else "hashable"
    if isinstance(index, _ObjectData) and not index.ref and index.properties:
        kinds = {_index_kind(prop.schema) if isinstance(prop.schema, _ScalarData) else None
                 for prop in index.properties.values()}
        return None if None in kinds else "hashable" if "hashable" in kinds else "ordered"
    return None


def _integer_like(index: Any) -> bool:
    """Whether an index is an int, or a value object of ints: a dense container's positions, by default."""
    if isinstance(index, _ScalarData):
        return index.type is int
    return _index_kind(index) == "ordered" and all(p.schema.type is int for p in index.properties.values())


@dataclass(eq=False)
class _ContainerData:
    """A container: elements, each of the element's schema, held by index, each of the index's schema. Dense, its elements
    are a packed array; sparse, an associative store of dense blocks; with neither, it is dense where its index is
    integer-like (an int, or a value object of ints), a dict (by index) where its index is otherwise hashable, and its
    elements paired with their indices otherwise."""

    index: Any = None  # OfAny.Data
    element: Any = None  # OfAny.Data
    layout: str | None = None  # "dense", "sparse", or None for the default
    name: str | None = None
    description: str | None = None
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
        problems = _name_problems(self.name) + _description_problems(self.description)
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


# --- OfAny.Value: a value of any schema ---


def plain_forms(schema: Any) -> frozenset[str]:
    """The plain forms a value of `schema` may take: "bool", "int", "float", "text", "mapping" or "list". A float may be
    text (`"NaN"`, `"Infinity"`), bytes are text (base64), a dense tensor a mapping where written flat, and a scalar
    that is not a basic scalar any form."""
    held = schema
    if isinstance(held, _ScalarData):
        forms = {bool: {"bool"}, int: {"int"}, float: {"float", "text"}, str: {"text"}, bytes: {"text"}}
        return frozenset(forms.get(held.type, {"bool", "int", "float", "text", "mapping", "list"}))
    if isinstance(held, _ContainerData):
        index = held.index
        if held.arrangement == "dict" and isinstance(index, _ScalarData) and index.type is str:
            return frozenset({"mapping"})
        tensor = held.arrangement == "dense" and isinstance(index, _ObjectData)
        return frozenset({"list", "mapping"}) if tensor else frozenset({"list"})
    if isinstance(held, _AnyValueData):
        return frozenset().union(*map(plain_forms, held.schemas)) if held.schemas else frozenset({"mapping"})
    return frozenset({"mapping"})


def _shown_type(schema: Any) -> str:
    """A schema in a message: its name, or its kind."""
    held = schema
    if getattr(schema, "name", None) is not None:
        return schema.name
    return {_ObjectData: "a value object", _UnionData: "a union", _IntersectionData: "an intersection",
            _ContainerData: "a container"}.get(type(held), "a schema")


@dataclass(eq=False)
class _AnyValueData:
    """A value of any schema: of one of `schemas`, where they are given (an `OfAny` restricted to them), else of any
    schema. Restricted, a value is wrapped by its kind and schema (`{"scalar": {"str": "x"}}`), or written bare where
    exactly one of the schemas takes its plain form; unrestricted, it is tagged with its schema, a basic scalar's tag or
    a registered schema's name."""

    schemas: tuple[Any, ...] = ()  # OfAny.Data each
    name: str | None = None
    description: str | None = None

    @_once
    def validate(self) -> list[str]:
        problems = _name_problems(self.name) + _description_problems(self.description)
        for schema in self.schemas:  # schemas that share a plain form are told apart by the wrapper on the wire
            if not isinstance(schema, _KINDS):
                problems.append(f"an OfAny holds schemas, got {schema!r}")
            elif isinstance(schema, _AnyValueData):
                problems.append("an OfAny holds schemas of other kinds, not an OfAny")
            else:
                problems += [f"{_shown_type(schema)}: {p}" for p in _validate(schema)]
        return problems


# --- OfVariable: a name standing for a value ---


@dataclass(eq=False)
class _VariableData:
    """A name standing for a value: a pattern's variable, which a frame assigns a value of its schema."""

    name: str = ""
    schema: Any = None  # OfAny.Data
    description: str | None = None


class OfVariable:
    Data = _VariableData


def _variable_problems(variable: _VariableData) -> list[str]:
    """A variable's schema, when it has one, is a value's: never a reference object schema."""
    problems = _description_problems(variable.description)
    if variable.schema is None:
        return problems
    return _validate(variable.schema) + _embedded_problems(variable.schema) + problems


# --- OfExpression, OfConstraint ---


@dataclass(eq=False)
class _ExpressionData:
    """An expression over a pattern's frames: its pattern, whose symbols and variables are free in it, and the schema of
    the value it computes. Its terms are mbse-expressions' ([CAP-137: patterns of symbols, variables and specs](../../../../../mbse-basis/docs/capabilities/CAP-137.md),
    value expressions and constraints); a constraint is an expression whose result is `Schemas.OfBool`."""

    pattern: Any = None  # an OfPattern.Data, or None where its owner gives it
    result: Any = None  # OfAny.Data
    name: str | None = None
    description: str | None = None

    def validate(self) -> list[str]:
        problems = _name_problems(self.name) + _description_problems(self.description)
        if self.pattern is not None and not isinstance(self.pattern, _PatternData):
            problems.append("an expression's pattern is a pattern")
        if self.result is None:
            problems.append("an expression needs a result schema")
        else:
            problems += [f"result: {p}" for p in _validate(self.result) + _embedded_problems(self.result)]
        return problems


class OfExpression:
    """An expression: mbse-expressions refines it with its terms."""

    Data = _ExpressionData


class OfConstraint:
    """A constraint: an expression whose result is the store's `Schemas.OfBool` (its builder fixes it)."""

    Data = _ExpressionData


def _is_constraint(expression: Any) -> bool:
    return isinstance(expression, _ExpressionData) and getattr(expression.result, "name", None) == "Schemas.OfBool"


# --- OfPattern ---


@dataclass(eq=False)
class _PatternData:
    """The shape of a frame: symbols, each bound to a reference object, variables, each assigned a value, and the
    constraints a frame meets, in order ([CAP-137: patterns of symbols, variables and specs](../../../../../mbse-basis/docs/capabilities/CAP-137.md))."""

    symbols: dict[str, _SymbolData] = field(default_factory=dict)
    variables: dict[str, _VariableData] = field(default_factory=dict)
    requires: tuple[_ExpressionData, ...] = ()
    name: str | None = None
    description: str | None = None
    spec: tuple[Any, ...] = ()  # what must hold of a frame: `Mutations.OfPattern`s, as plain data (Object identity, 95)

    def validate(self) -> list[str]:
        problems = (_name_problems(self.name) + _description_problems(self.description)
                    + _reserved([*self.symbols, *self.variables]))
        clashes = set(self.symbols) & set(self.variables)
        if clashes:
            problems.append(f"names used as both symbol and variable: {sorted(clashes)}")
        for name, symbol in self.symbols.items():
            problems += [f"symbol {name!r}: {p}" for p in _symbol_problems(symbol)]
        for name, variable in self.variables.items():
            problems += [f"variable {name!r}: {p}" for p in _variable_problems(variable)]
        for index, constraint in enumerate(self.requires):
            if not _is_constraint(constraint):
                problems.append(f"requires[{index}] is a constraint: an expression whose result is Schemas.OfBool")
                continue
            if constraint.pattern is not None and constraint.pattern is not self:
                problems.append(f"requires[{index}] is over this pattern's frames, not another's")
            problems += [f"requires[{index}]: {p}" for p in constraint.validate()]
        return problems


class OfPattern:
    """The shape of a frame ([CAP-137: patterns of symbols, variables and specs](../../../../../mbse-basis/docs/capabilities/CAP-137.md))."""

    Data = _PatternData


# --- OfCollector ---


@dataclass(eq=False)
class _CollectorData:
    """A pattern used to fold frames ([CAP-138: mutation expressions over frame streams](../../../../../mbse-basis/docs/capabilities/CAP-138.md)): the symbols and variables it
    collects, each duplicated under its `suffixes`, `current` and `next`, and what it `computes`; `commutative` or
    `associative`, so that the fold does not depend on the order frames arrive in (object identity 62 in [CAP-137: patterns of symbols, variables and specs](../../../../../mbse-basis/docs/capabilities/CAP-137.md#decided))."""

    pattern: Any = None  # an OfPattern.Data
    symbols: tuple[str, ...] = ()
    variables: tuple[str, ...] = ()
    commutative: bool | None = None
    associative: bool | None = None
    suffixes: dict[str, str] | None = None  # {"current": ..., "next": ...}
    computes: Any = None  # an OfExpression.Data
    name: str | None = None
    description: str | None = None

    def validate(self) -> list[str]:
        problems = _name_problems(self.name) + _description_problems(self.description)
        if not isinstance(self.pattern, _PatternData):
            problems.append("a collector needs a pattern")
        else:
            for plural, names, held in (("symbols", self.symbols, self.pattern.symbols),
                                        ("variables", self.variables, self.pattern.variables)):
                missing = [name for name in names if name not in held]
                if missing:
                    problems.append(f"it collects {plural} {missing}, which its pattern does not declare")
        if not self.commutative and not self.associative:
            problems.append("a collector is commutative or associative, so that its result does not depend on the order "
                            "frames arrive in")
        if self.suffixes is not None:
            if set(self.suffixes) != {"current", "next"}:
                problems.append("a collector's suffixes are 'current' and 'next'")
            elif self.suffixes["current"] == self.suffixes["next"]:
                problems.append("a collector's 'current' and 'next' suffixes differ")
        if self.computes is not None:
            if not isinstance(self.computes, _ExpressionData):
                problems.append("what a collector computes is an expression")
            else:
                problems += [f"computes: {p}" for p in self.computes.validate()]
        return problems


class OfCollector:
    """A pattern used to fold frames."""

    Data = _CollectorData


# --- OfAny ---

_KINDS = (_ScalarData, _ObjectData, _UnionData, _IntersectionData, _ContainerData, _AnyValueData)


# --- Refinement ---

_KIND_NOUNS = {_ScalarData: "a scalar schema", _ObjectData: "an object schema", _ContainerData: "a container schema",
               _UnionData: "a union", _IntersectionData: "an intersection", _AnyValueData: "a value of any schema"}


def _kind_noun(schema: Any) -> str:
    return _KIND_NOUNS.get(type(schema), "something holding no values")


def is_a(schema: Any, base: Any) -> bool:
    """Whether `schema` is `base` or refines it, directly or not: a value of it is then a value of `base`."""
    seen: set[int] = set()
    while schema is not None and id(schema) not in seen:
        if schema is base:
            return True
        seen.add(id(schema))
        schema = getattr(schema, "refines", None)
    return False


def _narrows(new: Any, old: Any) -> bool:
    """Whether validation confirms that every value of `new` is a value of `old`: the same schema, a refinement of it,
    or a scalar, container or value object schema whose parts each narrow `old`'s."""
    if new is old or is_a(new, old):
        return True
    if isinstance(new, _ScalarData) and isinstance(old, _ScalarData):
        return new.type is not None and new.type is old.type
    if isinstance(new, _ContainerData) and isinstance(old, _ContainerData):
        return _narrows(new.index, old.index) and _narrows(new.element, old.element)
    return False


def _refinement_problems(schema: Any) -> list[str]:
    """A refinement's problems: it refines a schema of its own kind, not itself, and narrows what it redeclares."""
    if schema.refines is None:
        return []
    base = schema.refines
    if type(base) is not type(schema):
        return [f"refines {_kind_noun(base)}: a refinement stays within its kind, container or object"]
    if is_a(base, schema):
        return ["refines itself"]
    if isinstance(schema, _ContainerData):
        return [f"its {role} cannot be confirmed to narrow the refined container's"
                for role in ("index", "element") if not _narrows(getattr(schema, role), getattr(base, role))]
    problems = [] if schema.ref == base.ref else ["a refinement is a reference object schema exactly where what it "
                                                  "refines is one"]
    for name, prop in base.properties.items():
        own = schema.properties.get(name)
        if own is not None and own is not prop and not _narrows(own.schema, prop.schema):
            problems.append(f"property {name!r} cannot be confirmed to narrow the refined schema's")
    for name, adjacency in base.adjacencies.items():
        own = schema.adjacencies.get(name)
        if own is not None and own is not adjacency and (own.relation is not adjacency.relation or own.me != adjacency.me):
            problems.append(f"adjacency {name!r} redeclares the refined schema's with another relation or link")
    return problems


def _settle(schema: _ObjectData) -> _ObjectData:
    """Gives an object schema the members of the schema it refines, which it has not redeclared, and passes the change
    on to the schemas that refine it."""
    base = schema.refines
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
        if refinement.refines is schema:
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
    intersection's parts."""
    if isinstance(schema, _ContainerData):
        return [schema.index, schema.element]
    if isinstance(schema, _AnyValueData):
        return list(schema.schemas)
    return [m.schema for m in schema.properties.values()] if isinstance(schema, (_ObjectData, _UnionData, _IntersectionData)) else []


def _embedded_problems(schema: Any, seen: frozenset[int] = frozenset()) -> list[str]:
    """Problems with a property's schema as a value: an object held by a property is a value object, so its schema is
    not a reference object schema; nor are the schemas of the objects a union or an intersection holds. `seen` holds
    the schemas on the way, so that one that holds itself is checked once."""
    if isinstance(schema, _ObjectData):
        return ["a reference object schema cannot be a property's schema"] if schema.ref else []
    if id(schema) in seen:
        return []
    inner = seen | {id(schema)}
    return sorted({problem for member in _members_of(schema) for problem in _embedded_problems(member, inner)})


_DEFINED = (*_KINDS, _RelationData, _PatternData, _ExpressionData, _CollectorData)
"""The kinds of schema a module defines and a store registers by name."""


class OfAny:
    """Where a schema of any kind is expected. `OfAny.Data` is any schema kind's data; `OfAny.Value`, the kind of a value
    of any schema, or of one of the schemas it is restricted to."""

    Data = _ScalarData | _ObjectData | _UnionData | _IntersectionData | _ContainerData | _AnyValueData
    Value = _AnyValueData


# --- Level 2: what every store is made holding ---


def install(txn: Any) -> Any:
    """The plain schemas of schemas and the basic scalars, defined in the store a transaction writes:
    `store.transaction(Schemas.install)`. A store is made by it, read by the bootstrap (`Builders`); run
    again in a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the meta-schemas, which this defines: each a symbol of its own kind (78)
    return txn.uid("mbse.Schemas/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({
            "OfBool": S.OfScalar, "OfInt": S.OfScalar, "OfFloat": S.OfScalar, "OfStr": S.OfScalar, "OfBytes": S.OfScalar,
            "OfScalar": S.OfObject, "OfObject": S.OfObject, "OfUnion": S.OfObject, "OfIntersection": S.OfObject,
            "OfContainer": S.OfObject, "OfAny": S.OfObject, "OfRelation": S.OfObject, "OfPattern": S.OfObject,
            "OfExpression": S.OfObject, "OfCollector": S.OfObject, "OfModule": S.OfObject,
            "OfProperty": S.OfObject, "OfParameter": S.OfObject, "OfSymbol": S.OfObject, "OfVariable": S.OfObject,
            "OfAdjacency": S.OfObject,
            "HasSchema": S.OfRelation, "Refines": S.OfRelation, "Indexing": S.OfRelation, "Containing": S.OfRelation,
            "AnyOf": S.OfRelation, "Relating": S.OfRelation, "HasProperty": S.OfRelation, "HasAdjacency": S.OfRelation,
            "HasBranch": S.OfRelation, "HasPart": S.OfRelation, "HasSymbol": S.OfRelation, "HasVariable": S.OfRelation,
            "Requiring": S.OfRelation, "Matching": S.OfRelation, "Resulting": S.OfRelation, "Computing": S.OfRelation,
            "HasLink": S.OfRelation, "Defines": S.OfRelation,
        })
        .spec([
            # --- The basic scalars, the only scalar schemas, each mapping to its host type by its name ---
            lambda _: _.OfBool.name("Schemas.OfBool"),
            lambda _: _.OfInt.name("Schemas.OfInt"),
            lambda _: _.OfFloat.name("Schemas.OfFloat"),
            lambda _: _.OfStr.name("Schemas.OfStr"),
            lambda _: _.OfBytes.name("Schemas.OfBytes"),

            # --- The relations between schema objects ---
            # A member belongs to one owner, which names it by the entry's `name` (keyed): the member determines its
            # owner and its name, and the owner and the name the member. A branch or a part is named by its entry, which
            # links a schema that may be linked again: the owner and the name determine the schema and the description,
            # so that a union's branch names, and an intersection's part names, are unique. A schema object has one
            # schema, refined schema, index, element or relation at most; `OfAny`'s schemas and a pattern's constraints
            # are lists.
            lambda _: _.HasSchema.name("Schemas.HasSchema").links([
                lambda t: t.name("member"), lambda t: t.name("schema")]).uniques([["schema"]]),
            lambda _: _.Refines.name("Schemas.Refines").links([
                lambda t: t.name("refinement"), lambda t: t.name("refined")]).uniques([["refined"]]),
            lambda _: _.Indexing.name("Schemas.Indexing").links([
                lambda t: t.name("container"), lambda t: t.name("index")]).uniques([["index"]]),
            lambda _: _.Containing.name("Schemas.Containing").links([
                lambda t: t.name("container"), lambda t: t.name("element")]).uniques([["element"]]),
            lambda _: _.AnyOf.name("Schemas.AnyOf").links([lambda t: t.name("any"), lambda t: t.name("schema")]),
            lambda _: _.Relating.name("Schemas.Relating").links([
                lambda t: t.name("adjacency"), lambda t: t.name("relation")]).uniques([["relation"]]),
            lambda _: _.HasProperty.name("Schemas.HasProperty").links([
                lambda t: t.name("owner"), lambda t: t.name("property")]).properties({"name": _.OfStr}).uniques([
                ["owner", "name"], ["property"]]),
            lambda _: _.HasAdjacency.name("Schemas.HasAdjacency").links([
                lambda t: t.name("owner"), lambda t: t.name("adjacency")]).properties({"name": _.OfStr}).uniques([
                ["owner", "name"], ["adjacency"]]),
            lambda _: _.HasBranch.name("Schemas.HasBranch").links([
                lambda t: t.name("owner"), lambda t: t.name("schema")]).properties({
                "name": _.OfStr, "description": _.OfStr}).uniques([["schema", "description"]]),
            lambda _: _.HasPart.name("Schemas.HasPart").links([
                lambda t: t.name("owner"), lambda t: t.name("schema")]).properties({
                "name": _.OfStr, "description": _.OfStr}).uniques([["schema", "description"]]),
            lambda _: _.HasSymbol.name("Schemas.HasSymbol").links([
                lambda t: t.name("owner"), lambda t: t.name("symbol")]).properties({"name": _.OfStr}).uniques([
                ["owner", "name"], ["symbol"]]),
            lambda _: _.HasVariable.name("Schemas.HasVariable").links([
                lambda t: t.name("owner"), lambda t: t.name("variable")]).properties({"name": _.OfStr}).uniques([
                ["owner", "name"], ["variable"]]),
            lambda _: _.Requiring.name("Schemas.Requiring").links([
                lambda t: t.name("pattern"), lambda t: t.name("constraint")]),
            lambda _: _.Matching.name("Schemas.Matching").links([
                lambda t: t.name("expression"), lambda t: t.name("pattern")]).uniques([["pattern"]]),
            lambda _: _.Resulting.name("Schemas.Resulting").links([
                lambda t: t.name("expression"), lambda t: t.name("schema")]).uniques([["schema"]]),
            lambda _: _.Computing.name("Schemas.Computing").links([
                lambda t: t.name("collector"), lambda t: t.name("expression")]).uniques([["expression"]]),
            lambda _: _.HasLink.name("Schemas.HasLink").links([
                lambda t: t.name("owner"), lambda t: t.name("link")]).properties({"name": _.OfStr}).uniques([
                ["owner", "name"], ["link"]]),
            lambda _: _.Defines.name("Schemas.Defines").links([
                lambda t: t.name("module"), lambda t: t.name("schema")]).properties({"name": _.OfStr}).uniques([
                ["module", "name"], ["schema"]]),

            # --- The kinds of schema: each a reference object, its properties, then each relation it is at an end of
            # (Store overhaul, Decided, 10): named where it is the first, anonymous where it is the second ---
            lambda _: _.OfScalar.name("Schemas.OfScalar").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfObject.name("Schemas.OfObject").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr, "ref": _.OfBool, "singleton": _.OfStr,
            }).adjacencies({
                "adjacencies": lambda a: a.relation([_.HasAdjacency]).me("owner"),
                "properties": lambda a: a.relation([_.HasProperty]).me("owner"),
                "refines": lambda a: a.relation([_.Refines]).me("refinement"),
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfUnion.name("Schemas.OfUnion").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr, "flat": _.OfBool,
            }).adjacencies({
                "branches": lambda a: a.relation([_.HasBranch]).me("owner"),
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfIntersection.name("Schemas.OfIntersection").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr, "flat": _.OfBool,
            }).adjacencies({
                "parts": lambda a: a.relation([_.HasPart]).me("owner"),
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfContainer.name("Schemas.OfContainer").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr, "layout": _.OfStr,
            }).adjacencies({
                "index": lambda a: a.relation([_.Indexing]).me("container"),
                "element": lambda a: a.relation([_.Containing]).me("container"),
                "refines": lambda a: a.relation([_.Refines]).me("refinement"),
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfAny.name("Schemas.OfAny").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
            }).adjacencies({
                "schemas": lambda a: a.relation([_.AnyOf]).me("any"),
            }).adjacencies([
                lambda a: a.relation([_.HasSchema]).me("schema"),
                lambda a: a.relation([_.Refines]).me("refined"),
                lambda a: a.relation([_.Indexing]).me("index"),
                lambda a: a.relation([_.Containing]).me("element"),
                lambda a: a.relation([_.AnyOf]).me("schema"),
                lambda a: a.relation([_.HasBranch]).me("schema"),
                lambda a: a.relation([_.HasPart]).me("schema"),
                lambda a: a.relation([_.Resulting]).me("schema"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfRelation.name("Schemas.OfRelation").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
                "uniques": S.OfContainer(lambda c: c.index([_.OfInt]).element([
                    S.OfContainer(lambda d: d.index([_.OfInt]).element([_.OfStr]))])),  # lists of names
            }).adjacencies({
                "links": lambda a: a.relation([_.HasLink]).me("owner"),
                "properties": lambda a: a.relation([_.HasProperty]).me("owner"),
            }).adjacencies([
                lambda a: a.relation([_.Relating]).me("relation"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfPattern.name("Schemas.OfPattern").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
            }).adjacencies({
                "symbols": lambda a: a.relation([_.HasSymbol]).me("owner"),
                "variables": lambda a: a.relation([_.HasVariable]).me("owner"),
                "requires": lambda a: a.relation([_.Requiring]).me("pattern"),
            }).adjacencies([
                lambda a: a.relation([_.Matching]).me("pattern"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfExpression.name("Schemas.OfExpression").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
            }).adjacencies({
                "pattern": lambda a: a.relation([_.Matching]).me("expression"),
                "result": lambda a: a.relation([_.Resulting]).me("expression"),
            }).adjacencies([
                lambda a: a.relation([_.Requiring]).me("constraint"),
                lambda a: a.relation([_.Computing]).me("expression"),
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfCollector.name("Schemas.OfCollector").ref(True).properties({
                "name": _.OfStr, "description": _.OfStr,
                "symbols": S.OfContainer(lambda c: c.index([_.OfInt]).element([_.OfStr])),
                "variables": S.OfContainer(lambda c: c.index([_.OfInt]).element([_.OfStr])),
                "commutative": _.OfBool, "associative": _.OfBool,
                "suffixes": S.OfContainer(lambda c: c.index([_.OfStr]).element([_.OfStr])),
            }).adjacencies({
                "pattern": lambda a: a.relation([_.Matching]).me("expression"),
                "computes": lambda a: a.relation([_.Computing]).me("collector"),
            }).adjacencies([
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),
            lambda _: _.OfModule.name("Schemas.OfModule").ref(True).properties({  # its identity is its path
                "name": _.OfStr, "description": _.OfStr,
            }).adjacencies({
                "schemas": lambda a: a.relation([_.Defines]).me("module"),
            }).adjacencies([
                lambda a: a.relation([_.Defines]).me("schema").owner(True),
            ]),

            # --- The kinds of member: each named by its owner's entry ---
            lambda _: _.OfProperty.name("Schemas.OfProperty").ref(True).properties({
                "description": _.OfStr, "pattern": _.OfStr,
            }).adjacencies({
                "schema": lambda a: a.relation([_.HasSchema]).me("member"),
            }).adjacencies([
                lambda a: a.relation([_.HasProperty]).me("property").owner(True),
            ]),
            lambda _: _.OfParameter.name("Schemas.OfParameter").ref(True).properties({  # declared through Parametrics
                "description": _.OfStr,
            }),
            lambda _: _.OfSymbol.name("Schemas.OfSymbol").ref(True).properties({
                "description": _.OfStr,
            }).adjacencies({
                "schema": lambda a: a.relation([_.HasSchema]).me("member"),
            }).adjacencies([
                lambda a: a.relation([_.HasSymbol]).me("symbol").owner(True),
                lambda a: a.relation([_.HasLink]).me("link").owner(True),
            ]),
            lambda _: _.OfVariable.name("Schemas.OfVariable").ref(True).properties({
                "description": _.OfStr,
            }).adjacencies({
                "schema": lambda a: a.relation([_.HasSchema]).me("member"),
            }).adjacencies([
                lambda a: a.relation([_.HasVariable]).me("variable").owner(True),
            ]),
            lambda _: _.OfAdjacency.name("Schemas.OfAdjacency").ref(True).properties({
                "description": _.OfStr, "me": _.OfStr, "owner": _.OfBool,
            }).adjacencies({
                "relation": lambda a: a.relation([_.Relating]).me("adjacency"),
            }).adjacencies([
                lambda a: a.relation([_.HasAdjacency]).me("adjacency").owner(True),
            ]),
        ])]))])
