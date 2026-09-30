"""Schemas: schema elements and their builders.

For each schema element `OfX`, `Schemas.OfX.Data` captures a schema and `Schemas.OfX.Builder` builds one. Builders
take an optional source instance, keep shallow copies of its data, are fluent, and are finalized by `create()`,
`clone()` or `update()`; none validate. Arguments describing a sub-structure are `Spec`s: a direct value, or a
callable that takes and returns the corresponding builder.

`validate()` on each `Data` returns a list of problems and runs only when the caller asks.
"""

from __future__ import annotations

import base64
import binascii
import copy
import dataclasses
import math
from collections.abc import Callable
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


# --- OfNative ---


@dataclass
class _NativeData:
    type: type[Native] | None = None

    def validate(self) -> list[str]:
        if self.type not in NATIVE_TYPES:
            return [f"unsupported native type {self.type!r}"]
        return []

    def to_plain(self, value: Native) -> int | float | str | bool:
        """Converts a native value to plain data that every text encoding can hold: `bytes` become base64 text, and
        non-finite floats become the strings 'NaN', 'Infinity' and '-Infinity'."""
        if type(value) is not self.type:
            raise TypeError(f"expected {self.type.__name__}, got {type(value).__name__}")
        if isinstance(value, bytes):
            return base64.b64encode(value).decode("ascii")
        if isinstance(value, float) and not math.isfinite(value):
            return "NaN" if math.isnan(value) else "Infinity" if value > 0 else "-Infinity"
        return value

    def from_plain(self, plain: object) -> Native:
        """Converts plain data back to a native value. Distinct native types are never coerced into each other.
        Plain data that does not hold such a value raises `Errors.DecodeError`."""
        if self.type is bytes:
            if not isinstance(plain, str):
                raise DecodeError(f"expected base64 text for bytes, got {type(plain).__name__}")
            try:
                return base64.b64decode(plain, validate=True)
            except binascii.Error:
                raise DecodeError("invalid base64 text") from None
        if self.type is float and isinstance(plain, str):
            if plain not in _NON_FINITE:
                raise DecodeError(f"expected a float or one of {sorted(_NON_FINITE)}, got {plain!r}")
            return _NON_FINITE[plain]
        if type(plain) is not self.type:
            raise DecodeError(f"expected {self.type.__name__}, got {type(plain).__name__}")
        return plain


_NON_FINITE = {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf}


class _NativeBuilder(_Builder[_NativeData]):
    _data = _NativeData

    def type(self, native: type[Native]) -> _NativeBuilder:
        self._fields["type"] = native
        return self


class OfNative:
    """A native value. Conversion to and from the wire format is the responsibility of this element."""

    Data = _NativeData
    Builder = _NativeBuilder
    Spec = type | Callable[[_NativeBuilder], _NativeBuilder]

    @staticmethod
    def resolve(spec: OfNative.Spec) -> _NativeData:
        if isinstance(spec, type):
            return _NativeData(spec)
        return _resolve(spec, _NativeData, _NativeBuilder)


# --- OfProperty (auxiliary: a named property of an object or relation) ---


@dataclass(eq=False)
class _PropertyData:
    name: str = ""
    type: Any = None  # OfAny.Data


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
        properties[prop.name] = prop.type


# --- OfRelation ---


@dataclass(eq=False)
class _RelationData:
    links: tuple[str, ...] = ()
    properties: dict[str, Any] = field(default_factory=dict)  # name -> OfAny.Data
    uniques: tuple[frozenset[str], ...] = ()

    def validate(self) -> list[str]:
        problems = []
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
            problems += [f"property {name!r}: {p}" for p in _validate(prop) + _embedded_problems(prop)]
        return problems


class _RelationBuilder(_Builder[_RelationData]):
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

    def validate(self) -> list[str]:
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


@dataclass(eq=False)
class _ObjectData:
    properties: dict[str, Any] = field(default_factory=dict)  # name -> OfAny.Data
    adjacencies: dict[str, _AdjacencyData] = field(default_factory=dict)
    singleton: str | None = None

    def validate(self) -> list[str]:
        problems = []
        clashes = set(self.properties) & set(self.adjacencies)
        if clashes:
            problems.append(f"names used as both property and adjacency: {sorted(clashes)}")
        for name, prop in self.properties.items():
            problems += [f"property {name!r}: {p}" for p in _validate(prop) + _embedded_problems(prop)]
        for adjacency in self.adjacencies.values():
            problems += adjacency.validate()
        return problems


class _ObjectBuilder(_Builder[_ObjectData]):
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
        """Declares a singleton global name: the one instance exists implicitly and is referenced by this name."""
        self._fields["singleton"] = name
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
    problems = []
    if len(members) < 2:
        problems.append(f"{a_kind} needs at least two {plural}")
    if len({type(m.type) for m in members}) > 1:
        problems.append(f"{kind} {plural} must all be the same kind")
    seen: set[str] = set()
    for i, m in enumerate(members):
        if not isinstance(m.name, str) or not m.name:
            problems.append(f"{member} {i} has no name")
        elif m.name in seen:
            problems.append(f"{member} name {m.name!r} is used more than once")
        seen.add(m.name)
    return problems


def _members(specs: tuple[Callable[[_MemberBuilder], _MemberBuilder], ...]) -> tuple[_MemberData, ...]:
    return tuple(_resolve(spec, _MemberData, _MemberBuilder) for spec in specs)


@dataclass(eq=False)
class _UnionData:
    branches: tuple[_MemberData, ...] = ()

    @property
    def properties(self) -> dict[str, Any]:
        """The branches by name: a union value is an object holding exactly one of them."""
        return {branch.name: branch.type for branch in self.branches}

    def validate(self) -> list[str]:
        return _member_problems("a union", "branch", "branches", self.branches)


class _UnionBuilder(_Builder[_UnionData]):
    _data = _UnionData

    def branches(self, *specs: Callable[[_MemberBuilder], _MemberBuilder]) -> _UnionBuilder:
        """Named branches, e.g. `.branches(lambda b: b.name('phone').of(Phone), ...)`."""
        self._fields["branches"] = (*self._fields.get("branches", ()), *_members(specs))
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
class _IntersectionData:
    parts: tuple[_MemberData, ...] = ()

    @property
    def properties(self) -> dict[str, Any]:
        """The parts by name: an intersection value is an object holding every one of them."""
        return {part.name: part.type for part in self.parts}

    def validate(self) -> list[str]:
        return _member_problems("an intersection", "part", "parts", self.parts)


class _IntersectionBuilder(_Builder[_IntersectionData]):
    _data = _IntersectionData

    def parts(self, *specs: Callable[[_MemberBuilder], _MemberBuilder]) -> _IntersectionBuilder:
        """Named parts, e.g. `.parts(lambda p: p.name('stamp').of(Stamp), ...)`."""
        self._fields["parts"] = (*self._fields.get("parts", ()), *_members(specs))
        return self


class OfIntersection:
    Data = _IntersectionData
    Builder = _IntersectionBuilder
    Spec = _IntersectionData | Callable[[_IntersectionBuilder], _IntersectionBuilder]
    Part = _MemberData

    @staticmethod
    def resolve(spec: OfIntersection.Spec) -> _IntersectionData:
        return _resolve(spec, _IntersectionData, _IntersectionBuilder)


# --- OfAny ---

_KINDS = (_NativeData, _ObjectData, _UnionData, _IntersectionData)


def _validate(schema: Any) -> list[str]:
    if not isinstance(schema, _KINDS):
        return [f"not a schema: {schema!r}"]
    return schema.validate()


def _embedded_problems(schema: Any) -> list[str]:
    """Problems with a property's schema as a value: an object held by a property is embedded, with no identity, so it
    cannot have adjacencies; nor can the objects a union or intersection holds."""
    if isinstance(schema, _ObjectData) and schema.adjacencies:
        return ["an embedded object cannot have adjacencies"]
    parts = list(schema.properties.values()) if isinstance(schema, (_UnionData, _IntersectionData)) else []
    return sorted({problem for part in parts for problem in _embedded_problems(part)})


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

    Data = _NativeData | _ObjectData | _UnionData | _IntersectionData
    Builder = _AnyBuilder
    Spec = Data | Callable[[_AnyBuilder], _AnyBuilder]

    @staticmethod
    def resolve(spec: OfAny.Spec) -> OfAny.Data:
        if isinstance(spec, _KINDS):
            return spec
        return _resolve(spec, _KINDS, _AnyBuilder)
