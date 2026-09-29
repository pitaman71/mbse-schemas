"""Expressions: serializable expressions, for union discriminators and, later, constraints. `Evaluators` evaluates them.

- `OfLiteral`: a native value.
- `OfOperation`: a named operation applied to ordered arguments, e.g. `eq(a, b)`. The vocabulary of names is open; the
  core operations (`CORE`) are the ones every binding evaluates. See FRAMEWORK.md, "Expressions".
- `OfVariable`: the value bound to a name.
- `OfLet`: binds a name to the value of one expression within another, its body.
- `OfAny`: any of these.

As for schemas, each kind has `Data`, a `Builder` finalized by `create()`, `clone()` or `update()` (none validate), a
`Spec` (a value, or a callable that takes and returns the builder) and `resolve`. Each also has a `Schema`, the
meta-schema that describes its data as an ordinary object schema, so expressions serialize, validate and compare like
any other objects:

- Every kind's schema declares `kind`, a tag with a fixed value: 'literal', 'operation', 'variable' or 'let'.
- `OfLiteral.Schema` declares one optional property per native type (`int`, `float`, `str`, `bool`, `bytes`); a literal
  sets exactly one.
- `OfOperation.Schema`, `OfVariable.Schema` and `OfLet.Schema` declare `name`.
- Operations and lets declare the adjacency `arguments` to `Arguments`, a relation linking a `parent` to an `argument`
  with an `index`; `unique(argument)` makes the parent and index determine the argument. A let's value is its argument
  0 and its body its argument 1.
- Every kind declares `used_by`: the same relation seen from the argument. The parents' arguments imply it, so data
  never writes it and builders ignore entries added to it.
- `OfAny.Schema` is the union of the four, discriminated by the tag: `eq(get(this, 'kind'), 'literal')`, and so on.

The meta-schemas are registered with `Proxies` as 'Expressions.OfLiteral', 'Expressions.OfOperation',
'Expressions.OfVariable', 'Expressions.OfLet' and 'Expressions.Arguments', the names snapshots carry. `Builders`
rebuilds `Data` from snapshots, e.g. `JSON.FromJSON(Expressions.Builders).Reachable(Expressions.OfLet.Schema, text)`.
`Data` is `Visitable`; builders implement `Visitors.OfObject`.

`Term`s write expressions with methods: `variable('this').age.ge(18)` is `ge(get(this, 'age'), 18)`. `from_` reads one
from a Python function's source instead: `from_(lambda this: this.age >= 18)` is the same expression.
"""

from __future__ import annotations

import ast
import inspect
import linecache
from collections.abc import Callable, Hashable, Iterable
from dataclasses import dataclass
from typing import Any, ClassVar

from . import Proxies, Schemas, Visitors
from .Visitors import Native

__all__ = [
    "OfAny", "OfLiteral", "OfOperation", "OfVariable", "OfLet", "Arguments", "Builders", "Term", "CORE",
    "variable", "literal", "let_", "operation", "from_",
    "LITERAL", "OPERATION", "VARIABLE", "LET", "ARGUMENTS",
]

LITERAL = "Expressions.OfLiteral"
OPERATION = "Expressions.OfOperation"
VARIABLE = "Expressions.OfVariable"
LET = "Expressions.OfLet"
ARGUMENTS = "Expressions.Arguments"

_NATIVES: dict[str, type[Native]] = {"int": int, "float": float, "str": str, "bool": bool, "bytes": bytes}

CORE: dict[str, int] = {
    "get": 2, "has": 2,
    "eq": 2, "ne": 2, "lt": 2, "le": 2, "gt": 2, "ge": 2,
    "and": 2, "or": 2, "not": 1, "implies": 2,
    "add": 2, "sub": 2, "mul": 2, "neg": 1,
}
"""The core operations and their numbers of arguments."""


def _native_name(value: object) -> str | None:
    """The name of `value`'s native type, which is also the literal property that holds it; None if not native."""
    name = type(value).__name__
    return name if _NATIVES.get(name) is type(value) else None


def _type_name(value: object) -> str:
    return type(value).__name__


def _set(visitor: Any, name: str, value: Native) -> None:
    visitor.property(name, lambda p: p.value(lambda a: a.as_native(lambda n: n.set(value))))


# --- Data ---


class _Data:
    """Shared by every kind's data: identity, schema name, and writing the tag."""

    KIND: ClassVar[str]
    NAME: ClassVar[str]
    FIELDS: ClassVar[tuple[str, ...]]

    def identity(self) -> Hashable:
        return id(self)

    def schema_name(self) -> str:
        return self.NAME

    _accept: Callable[[Visitors.OfObject], None]  # writes the kind's own properties and arguments

    def accept(self, visitor: Visitors.OfObject) -> None:
        _set(visitor, "kind", self.KIND)
        self._accept(visitor)

    def validate(self, bound: Iterable[str] = (), core: bool = False) -> list[str]:
        """Problems with this expression. Variables must be bound by an enclosing let or be in `bound`. With `core`,
        every operation must be a core operation."""
        return _problems(self, frozenset(bound), core, set())


def _write_argument(visitor: Visitors.OfObject, index: int, argument: Any) -> None:
    def fill(entry: Visitors.OfEntry) -> None:
        entry.link("argument", lambda k: k.set(argument))
        _set(entry, "index", index)

    visitor.adjacency("arguments", lambda a: a.add(fill))


@dataclass(eq=False)
class _LiteralData(_Data):
    KIND: ClassVar[str] = "literal"
    NAME: ClassVar[str] = LITERAL
    FIELDS: ClassVar[tuple[str, ...]] = ("value",)
    value: Native | None = None

    def _accept(self, visitor: Visitors.OfObject) -> None:
        """Writes the value into the property named after its native type."""
        if self.value is None:
            return
        name = _native_name(self.value)
        if name is None:
            raise TypeError(f"a literal must hold a native value, got {_type_name(self.value)}")
        _set(visitor, name, self.value)


@dataclass(eq=False)
class _OperationData(_Data):
    KIND: ClassVar[str] = "operation"
    NAME: ClassVar[str] = OPERATION
    FIELDS: ClassVar[tuple[str, ...]] = ("name", "arguments")
    name: str | None = None
    arguments: tuple[Any, ...] = ()  # OfAny.Data

    def _accept(self, visitor: Visitors.OfObject) -> None:
        """Writes the name, then one `arguments` entry per argument, in order, with its index."""
        if self.name is not None:
            _set(visitor, "name", self.name)
        for index, argument in enumerate(self.arguments):
            _write_argument(visitor, index, argument)


@dataclass(eq=False)
class _VariableData(_Data):
    KIND: ClassVar[str] = "variable"
    NAME: ClassVar[str] = VARIABLE
    FIELDS: ClassVar[tuple[str, ...]] = ("name",)
    name: str | None = None

    def _accept(self, visitor: Visitors.OfObject) -> None:
        if self.name is not None:
            _set(visitor, "name", self.name)


@dataclass(eq=False)
class _LetData(_Data):
    KIND: ClassVar[str] = "let"
    NAME: ClassVar[str] = LET
    FIELDS: ClassVar[tuple[str, ...]] = ("name", "value", "body")
    name: str | None = None
    value: Any = None  # OfAny.Data
    body: Any = None  # OfAny.Data

    def _accept(self, visitor: Visitors.OfObject) -> None:
        """Writes the name, then the value as argument 0 and the body as argument 1."""
        if self.name is not None:
            _set(visitor, "name", self.name)
        for index, argument in enumerate([self.value, self.body]):
            if argument is not None:
                _write_argument(visitor, index, argument)


_KINDS = (_LiteralData, _OperationData, _VariableData, _LetData)


def _name_problems(what: str, name: Any) -> list[str]:
    if name is None or name == "":
        return [f"{what} needs a name"]
    if type(name) is not str:
        return [f"{what}'s name must be a str, got {_type_name(name)}"]
    return []


def _problems(expression: Any, bound: frozenset[str], core: bool, active: set[int]) -> list[str]:
    """Problems with `expression`; `active` holds the expressions being checked, to find cycles."""
    if isinstance(expression, _LiteralData):
        if expression.value is None:
            return ["a literal needs a value"]
        if _native_name(expression.value) is None:
            return [f"a literal must hold a native value, got {_type_name(expression.value)}"]
        return []
    if not isinstance(expression, _KINDS):
        return [f"not an expression: {expression!r}"]
    if isinstance(expression, _VariableData):
        problems = _name_problems("a variable", expression.name)
        if not problems and expression.name not in bound:
            problems.append(f"variable {expression.name!r} is not bound")
        return problems
    if id(expression) in active:
        return ["the expression contains a cycle"]
    active.add(id(expression))
    if isinstance(expression, _LetData):
        problems = _name_problems("a let", expression.name)
        inner = bound | {expression.name} if not problems else bound
        for part, scope in [("value", bound), ("body", inner)]:
            child = getattr(expression, part)
            if child is None:
                problems.append(f"a let needs a {part}")
            else:
                problems += [f"{part}: {problem}" for problem in _problems(child, scope, core, active)]
    else:
        problems = _name_problems("an operation", expression.name)
        name, count = expression.name, len(expression.arguments)
        if not problems and name in CORE and CORE[name] != count:
            problems.append(f"{name} takes {CORE[name]} arguments, got {count}")
        elif not problems and core and name not in CORE:
            problems.append(f"{name!r} is not a core operation")
        for i, argument in enumerate(expression.arguments):
            problems += [f"argument {i}: {problem}" for problem in _problems(argument, bound, core, active)]
    active.discard(id(expression))
    return problems


# --- Builders: Visitors that build Data ---


class _Field:
    """`Visitors.OfProperty`, `OfAny` and `OfNative` over one native-typed field of a builder."""

    def __init__(self, name: str, native: type[Native], read: Callable[[], Any], write: Callable[[Any], None]):
        self._name, self._native, self._read, self._write = name, native, read, write

    def name(self) -> str:
        return self._name

    def has(self) -> bool:
        return type(self._read()) is self._native

    def get(self) -> Native:
        if not self.has():
            raise AttributeError(f"property {self._name!r} is not set")
        return self._read()

    def set(self, value: Native) -> _Field:
        if type(value) is not self._native:
            raise TypeError(f"expected {self._native.__name__}, got {_type_name(value)}")
        self._write(value)
        return self

    def clear(self) -> _Field:
        if self.has():
            self._write(None)
        return self

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _Field:
        callback(self)
        return self

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> _Field:
        callback(self)
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> _Field:
        raise TypeError(f"property {self._name!r} is native")

    def as_union(self, callback: Callable[[Visitors.OfUnion], Any]) -> _Field:
        raise TypeError(f"property {self._name!r} is native")

    def as_intersection(self, callback: Callable[[Visitors.OfIntersection], Any]) -> _Field:
        raise TypeError(f"property {self._name!r} is native")


class _Link:
    """`Visitors.OfLink` over the one link an argument entry sets."""

    def __init__(self, entry: _Argument):
        self._entry = entry

    def name(self) -> str:
        return self._entry.other

    def target(self, callback: Callable[[Visitors.Visitable], Any]) -> _Link:
        if self._entry.target is None:
            raise ValueError(f"link {self._entry.other!r} is not set")
        callback(self._entry.target)
        return self

    def set(self, target: Visitors.Visitable) -> _Link:
        self._entry.target = target
        return self


class _Argument:
    """`Visitors.OfEntry` for one entry of `Arguments`, seen from the end that fills `me`: it sets the other link and
    the `index`."""

    def __init__(self, me: str, target: Any = None, index: int | None = None):
        self.other = "argument" if me == "parent" else "parent"
        self.target, self.index = target, index

    def _index(self) -> _Field:
        return _Field("index", int, lambda: self.index, lambda value: setattr(self, "index", value))

    def links(self, callback: Callable[[Visitors.OfLink], Any]) -> _Argument:
        callback(_Link(self))
        return self

    def link(self, name: str, callback: Callable[[Visitors.OfLink], Any]) -> _Argument:
        if name != self.other:
            raise KeyError(f"{name!r} is not a link this entry can set")
        callback(_Link(self))
        return self

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _Argument:
        if self.index is not None:
            callback(self._index())
        return self

    def has(self, name: str) -> bool:
        return name == "index" and self.index is not None

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _Argument:
        if name != "index":
            raise KeyError(f"unknown property {name!r}")
        callback(self._index())
        return self

    def clear(self, name: str) -> _Argument:
        if name == "index":
            self.index = None
        return self


class _Adjacency:
    """`Visitors.OfAdjacency` over a parent's `arguments`, or over `used_by`, whose entries are ignored (the parents'
    arguments imply them)."""

    def __init__(self, name: str, me: str, entries: list[_Argument] | None):
        self._name, self._me, self._entries = name, me, entries

    def name(self) -> str:
        return self._name

    def me(self) -> str:
        return self._me

    def entries(self, callback: Callable[[Visitors.OfEntry], Any]) -> _Adjacency:
        for entry in list(self._entries or []):
            callback(entry)
        return self

    def add(self, callback: Callable[[Visitors.OfEntry], Any]) -> _Adjacency:
        entry = _Argument(self._me)
        callback(entry)
        if self._entries is not None:
            self._entries.append(entry)
        return self

    def remove(self, entry: Visitors.OfEntry) -> _Adjacency:
        if self._entries is not None:
            self._entries[:] = [e for e in self._entries if e is not entry]
        return self


def _check_target(entry: _Argument) -> Any:
    if entry.target is None:
        raise ValueError("link 'argument' is not set")
    if not isinstance(entry.target, _KINDS):
        raise TypeError(f"an argument must be an expression, got {_type_name(entry.target)}")
    return entry.target


class _Builder:
    """Shared by every kind's builder: `create()` / `clone()` / `update()` with the rules and messages of every
    builder, and `Visitors.OfObject` over the tag `kind`, the kind's own native properties (`_properties`) and, for
    parents, the `arguments` entries. Subclasses define `_make()`, which builds new data from the builder state."""

    _data: ClassVar[type[_Data]]
    _properties: ClassVar[dict[str, type[Native]]]
    _parent: ClassVar[bool] = False
    _make: Callable[[], Any]

    def __init__(self, instance: Any = None):
        if instance is not None and type(instance) is not self._data:
            raise TypeError(f"expected {self._data.KIND} data to build from, got {_type_name(instance)}")
        self._source = instance
        self._values: dict[str, Any] = {}
        self._arguments: list[_Argument] = []

    def create(self) -> Any:
        if self._source is not None:
            raise ValueError("create() is only valid without a source instance; use clone() or update()")
        return self._make()

    def clone(self) -> Any:
        if self._source is None:
            raise ValueError("clone() is only valid with a source instance")
        return self._make()

    def update(self) -> Any:
        if self._source is None:
            raise ValueError("update() is only valid with a source instance")
        made = self._make()
        for name in self._data.FIELDS:
            setattr(self._source, name, getattr(made, name))
        return self._source

    def _check_kind(self, kind: Any) -> None:
        if kind is not None and kind != self._data.KIND:
            raise ValueError(f"expected kind {self._data.KIND!r}, got {kind!r}")

    def _field(self, name: str) -> _Field:
        if name == "kind":
            return _Field("kind", str, lambda: self._data.KIND, self._check_kind)
        return _Field(name, self._properties[name], lambda: self._values.get(name),
                      lambda value: self._values.__setitem__(name, value))

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _Builder:
        for name in ["kind", *self._properties]:
            if self.has(name):
                callback(self._field(name))
        return self

    def has(self, name: str) -> bool:
        return name == "kind" or (name in self._properties and self._field(name).has())

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _Builder:
        if name != "kind" and name not in self._properties:
            raise KeyError(f"unknown property {name!r}")
        callback(self._field(name))
        return self

    def clear(self, name: str) -> _Builder:
        if name in self._properties:
            self._field(name).clear()
        return self

    def adjacencies(self, callback: Callable[[Visitors.OfAdjacency], Any]) -> _Builder:
        for name in ["arguments", "used_by"] if self._parent else ["used_by"]:
            self.adjacency(name, callback)
        return self

    def adjacency(self, name: str, callback: Callable[[Visitors.OfAdjacency], Any]) -> _Builder:
        if name == "arguments" and self._parent:
            callback(_Adjacency("arguments", "parent", self._arguments))
        elif name == "used_by":
            callback(_Adjacency("used_by", "argument", None))
        else:
            raise KeyError(f"unknown adjacency {name!r}")
        return self


class _LiteralBuilder(_Builder):
    """Builds an `OfLiteral.Data`. DSL: `.value(native)`. As a `Visitors.OfObject`, it has one property per native type,
    and setting one replaces the value."""

    _data = _LiteralData
    _properties = _NATIVES

    def __init__(self, instance: _LiteralData | None = None):
        super().__init__(instance)
        self._value: Any = None if instance is None else instance.value

    def value(self, value: Native) -> _LiteralBuilder:
        self._value = value
        return self

    def _field(self, name: str) -> _Field:
        if name == "kind":
            return super()._field(name)
        return _Field(name, _NATIVES[name], lambda: self._value, lambda value: setattr(self, "_value", value))

    def _make(self) -> _LiteralData:
        return _LiteralData(self._value)


class _NamedBuilder(_Builder):
    """A builder whose kind has a `name`. DSL: `.name(str)`."""

    _properties = {"name": str}

    def __init__(self, instance: Any = None):
        super().__init__(instance)
        if instance is not None:
            self._values["name"] = instance.name

    def name(self, name: str) -> Any:
        self._values["name"] = name
        return self


class _OperationBuilder(_NamedBuilder):
    """Builds an `OfOperation.Data`. DSL: `.name(str)` and `.arguments(*specs)`, which appends `OfAny.Spec`s (a native
    value is a literal). As a `Visitors.OfObject`, arguments are `arguments` entries, ordered by `index`."""

    _data = _OperationData
    _parent = True

    def __init__(self, instance: _OperationData | None = None):
        super().__init__(instance)
        if instance is not None:
            self._arguments = [_Argument("parent", arg, i) for i, arg in enumerate(instance.arguments)]

    def arguments(self, *specs: OfAny.Spec) -> _OperationBuilder:
        for spec in specs:
            self._arguments.append(_Argument("parent", OfAny.resolve(spec), len(self._arguments)))
        return self

    def _make(self) -> _OperationData:
        last = len(self._arguments)
        ordered = sorted(self._arguments, key=lambda entry: last if entry.index is None else entry.index)
        return _OperationData(self._values.get("name"), tuple(_check_target(entry) for entry in ordered))


class _VariableBuilder(_NamedBuilder):
    """Builds an `OfVariable.Data`. DSL: `.name(str)`."""

    _data = _VariableData

    def _make(self) -> _VariableData:
        return _VariableData(self._values.get("name"))


class _LetBuilder(_NamedBuilder):
    """Builds an `OfLet.Data`. DSL: `.name(str)`, `.value(spec)` and `.body(spec)`, each an `OfAny.Spec`. As a
    `Visitors.OfObject`, the value is the `arguments` entry with index 0 and the body the one with index 1."""

    _data = _LetData
    _parent = True

    def __init__(self, instance: _LetData | None = None):
        super().__init__(instance)
        if instance is not None:
            self._arguments = [_Argument("parent", part, i) for i, part in enumerate([instance.value, instance.body])
                               if part is not None]

    def _part(self, index: int, spec: OfAny.Spec) -> _LetBuilder:
        self._arguments = [entry for entry in self._arguments if entry.index != index]
        self._arguments.append(_Argument("parent", OfAny.resolve(spec), index))
        return self

    def value(self, spec: OfAny.Spec) -> _LetBuilder:
        return self._part(0, spec)

    def body(self, spec: OfAny.Spec) -> _LetBuilder:
        return self._part(1, spec)

    def _make(self) -> _LetData:
        parts: list[Any] = [None, None]
        for entry in self._arguments:
            if entry.index not in (0, 1):
                raise ValueError(f"a let's value is argument 0 and its body argument 1, got index {entry.index}")
            parts[entry.index] = _check_target(entry)
        return _LetData(self._values.get("name"), *parts)


class _AnyBuilder:
    """Selects a kind through `as_<kind>(spec)`. Finalizing yields that kind's data."""

    def __init__(self, instance: OfAny.Data | None = None):
        self._source = instance
        self._selected: OfAny.Data | None = None

    def as_literal(self, spec: OfLiteral.Spec) -> _AnyBuilder:
        self._selected = OfLiteral.resolve(spec)
        return self

    def as_operation(self, spec: OfOperation.Spec) -> _AnyBuilder:
        self._selected = OfOperation.resolve(spec)
        return self

    def as_variable(self, spec: OfVariable.Spec) -> _AnyBuilder:
        self._selected = OfVariable.resolve(spec)
        return self

    def as_let(self, spec: OfLet.Spec) -> _AnyBuilder:
        self._selected = OfLet.resolve(spec)
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
        """The selected expression, or a shallow copy of the source (arguments are shared, not copied)."""
        if self._source is None:
            raise ValueError("clone() is only valid with a source instance")
        if self._selected is not None:
            return self._selected
        return type(self._source)(*(getattr(self._source, name) for name in self._source.FIELDS))

    def update(self) -> OfAny.Data:
        if self._source is None:
            raise ValueError("update() is only valid with a source instance")
        selected = self._require_selected()
        if type(selected) is not type(self._source):
            raise TypeError("update() cannot change the kind of the source expression")
        for name in selected.FIELDS:
            setattr(self._source, name, getattr(selected, name))
        return self._source


# --- Specs ---


def _resolve(spec: Any, data: type | tuple[type, ...], builder: Callable[[], Any], expected: str) -> Any:
    """Resolves a `Spec`: data is used as is, a `Term` gives its data, and a callable is given a new builder and must
    return it."""
    if isinstance(spec, Term):
        spec = spec.data
    if isinstance(spec, data):
        return spec
    if isinstance(spec, type):
        raise TypeError(f"a class is not a Spec here, got {spec.__name__}")
    if callable(spec):
        built = spec(builder())
        if built is None or not callable(getattr(built, "create", None)):
            raise TypeError(f"a Spec callable must return its builder, got {built!r}")
        return built.create()
    raise TypeError(f"expected {expected} or a callable taking its builder, got {spec!r}")


class OfLiteral:
    """A native value. `Spec` is a native value, an `OfLiteral.Data`, or a callable taking the builder."""

    Data = _LiteralData
    Builder = _LiteralBuilder
    Spec = Native | _LiteralData | Callable[[_LiteralBuilder], _LiteralBuilder]
    Schema: Schemas.OfObject.Data

    @staticmethod
    def resolve(spec: OfLiteral.Spec) -> _LiteralData:
        if _native_name(spec) is not None:
            return _LiteralData(spec)
        return _resolve(spec, _LiteralData, _LiteralBuilder, "a native value, a literal")


class OfOperation:
    """A named operation applied to ordered arguments."""

    Data = _OperationData
    Builder = _OperationBuilder
    Spec = _OperationData | Callable[[_OperationBuilder], _OperationBuilder]
    Schema: Schemas.OfObject.Data

    @staticmethod
    def resolve(spec: OfOperation.Spec) -> _OperationData:
        return _resolve(spec, _OperationData, _OperationBuilder, "an operation")


class OfVariable:
    """The value bound to a name. `Spec` is a name, an `OfVariable.Data`, or a callable taking the builder."""

    Data = _VariableData
    Builder = _VariableBuilder
    Spec = str | _VariableData | Callable[[_VariableBuilder], _VariableBuilder]
    Schema: Schemas.OfObject.Data

    @staticmethod
    def resolve(spec: OfVariable.Spec) -> _VariableData:
        if type(spec) is str:
            return _VariableData(spec)
        return _resolve(spec, _VariableData, _VariableBuilder, "a name, a variable")


class OfLet:
    """Binds a name to the value of one expression within another, its body."""

    Data = _LetData
    Builder = _LetBuilder
    Spec = _LetData | Callable[[_LetBuilder], _LetBuilder]
    Schema: Schemas.OfObject.Data

    @staticmethod
    def resolve(spec: OfLet.Spec) -> _LetData:
        return _resolve(spec, _LetData, _LetBuilder, "a let")


class OfAny:
    """Any expression. `Spec` is a native value (a literal), an expression, a `Term`, or a callable taking the
    builder."""

    Data = _LiteralData | _OperationData | _VariableData | _LetData
    Builder = _AnyBuilder
    Spec = Native | Data | Callable[[_AnyBuilder], _AnyBuilder]
    Schema: Schemas.OfUnion.Data

    @staticmethod
    def resolve(spec: OfAny.Spec) -> OfAny.Data:
        if _native_name(spec) is not None:
            return _LiteralData(spec)
        return _resolve(spec, _KINDS, _AnyBuilder, "an expression, a native value")


# --- Terms: writing expressions with methods ---


class Term:
    """An expression written with methods. `.name` reads a property (`get`); use `.get(name)` for names that are also
    methods, such as `eq`. A `Term` is an `OfAny.Spec`; `.data` is its expression."""

    __slots__ = ("data",)

    def __init__(self, data: OfAny.Data):
        self.data = data

    def __getattr__(self, name: str) -> Term:
        if name.startswith("_"):
            raise AttributeError(name)
        return self.get(name)

    def get(self, name: str) -> Term:
        return operation("get", self, name)

    def has(self, name: str) -> Term:
        return operation("has", self, name)

    def eq(self, other: OfAny.Spec) -> Term:
        return operation("eq", self, other)

    def ne(self, other: OfAny.Spec) -> Term:
        return operation("ne", self, other)

    def lt(self, other: OfAny.Spec) -> Term:
        return operation("lt", self, other)

    def le(self, other: OfAny.Spec) -> Term:
        return operation("le", self, other)

    def gt(self, other: OfAny.Spec) -> Term:
        return operation("gt", self, other)

    def ge(self, other: OfAny.Spec) -> Term:
        return operation("ge", self, other)

    def and_(self, other: OfAny.Spec) -> Term:
        return operation("and", self, other)

    def or_(self, other: OfAny.Spec) -> Term:
        return operation("or", self, other)

    def not_(self) -> Term:
        return operation("not", self)

    def implies(self, other: OfAny.Spec) -> Term:
        return operation("implies", self, other)

    def add(self, other: OfAny.Spec) -> Term:
        return operation("add", self, other)

    def sub(self, other: OfAny.Spec) -> Term:
        return operation("sub", self, other)

    def mul(self, other: OfAny.Spec) -> Term:
        return operation("mul", self, other)

    def neg(self) -> Term:
        return operation("neg", self)


def variable(name: str) -> Term:
    """The variable `name`."""
    return Term(_VariableData(name))


def literal(value: Native) -> Term:
    """The literal `value`."""
    return Term(_LiteralData(value))


def let_(name: str, value: OfAny.Spec, body: OfAny.Spec) -> Term:
    """`body`, with `name` bound to the value of `value`."""
    return Term(_LetData(name, OfAny.resolve(value), OfAny.resolve(body)))


def operation(name: str, *arguments: OfAny.Spec) -> Term:
    """The operation `name` applied to `arguments`; for operations outside the core, or without a method."""
    return Term(_OperationData(name, tuple(OfAny.resolve(argument) for argument in arguments)))


# --- From Python functions ---


_COMPARISONS: dict[type, str] = {
    ast.Eq: "eq", ast.NotEq: "ne", ast.Lt: "lt", ast.LtE: "le", ast.Gt: "gt", ast.GtE: "ge",
}
_ARITHMETIC: dict[type, str] = {ast.Add: "add", ast.Sub: "sub", ast.Mult: "mul"}
_FUNCTIONS = (ast.Lambda, ast.FunctionDef)


def from_(function: Callable[..., Any]) -> Term:
    """The expression a Python function computes, read from its source: a lambda, or a `def` whose body is one `return`
    (after an optional docstring). Each parameter becomes a variable of the same name, e.g. `from_(lambda this:
    this.age >= 18)` is `ge(get(this, 'age'), 18)`.

    - `x.name` and `getattr(x, 'name')` are `get`; `hasattr(x, 'name')` is `has`; `x.name is None` is
      `not(has(x, 'name'))` and `x.name is not None` is `has(x, 'name')`.
    - `==`, `!=`, `<`, `<=`, `>`, `>=` are the comparisons (a chain `a < b < c` is `and(lt(a, b), lt(b, c))`); `and`,
      `or`, `not` are the logic operations; `+`, `-`, `*` and unary `-` are `add`, `sub`, `mul` and `neg`.
    - `(lambda name: body)(value)` is a let.
    - Other names are read when `from_` runs, from the function's closure and globals: a native value becomes a literal,
      and a `Term` or expression is used as it is.

    The expression is evaluated by `Evaluators`, with three-valued logic and no coercion, not by Python's rules: for
    example, `1 == 1.0` is True in Python but unknown as an expression. Anything else raises `ValueError`.
    """
    code = getattr(function, "__code__", None)
    if code is None:
        raise TypeError(f"expected a Python function, got {_type_name(function)}")
    node = _function_node(code)
    captured = inspect.getclosurevars(function)
    names = {**captured.builtins, **captured.globals, **captured.nonlocals}
    return Term(_convert(_body(node), {name: _VariableData(name) for name in _parameters(node)}, names))


def _function_node(code: Any) -> ast.Lambda | ast.FunctionDef:
    """The lambda or `def` in the source that compiled to `code`: the innermost one whose span holds every instruction
    of `code`, none of them inside the body of a function nested in it."""
    try:
        tree = ast.parse("".join(linecache.getlines(code.co_filename)))
    except SyntaxError:
        raise ValueError("the function's source is not available") from None
    positions = [  # (start line, start column, end line, end column), without zero-width ones such as RESUME's
        (p[0], p[2], p[1], p[3]) for p in code.co_positions() if None not in p and (p[0], p[2]) != (p[1], p[3])
    ]
    for node in sorted((n for n in ast.walk(tree) if isinstance(n, _FUNCTIONS)), key=_span, reverse=True):
        start, end = _span(node)
        nested = [_span(_body(n)) for n in ast.walk(node) if n is not node and isinstance(n, _FUNCTIONS)]
        if positions and all(start <= (l1, c1) and (l2, c2) <= end for l1, c1, l2, c2 in positions) and not any(
            s <= (l1, c1) and (l2, c2) <= e for l1, c1, l2, c2 in positions for s, e in nested
        ):
            return node
    raise ValueError("the function's source is not available")


def _span(node: ast.AST) -> tuple[tuple[int, int], tuple[int, int]]:
    return (node.lineno, node.col_offset), (node.end_lineno, node.end_col_offset)  # type: ignore[attr-defined]


def _body(node: ast.Lambda | ast.FunctionDef) -> ast.expr:
    if isinstance(node, ast.Lambda):
        return node.body
    statements = node.body[1:] if ast.get_docstring(node) is not None else node.body
    if len(statements) != 1 or not isinstance(statements[0], ast.Return) or statements[0].value is None:
        raise ValueError(f"the body of {node.name!r} must be a single return statement")
    return statements[0].value


def _parameters(node: ast.Lambda | ast.FunctionDef) -> list[str]:
    arguments = node.args
    if arguments.vararg or arguments.kwarg or arguments.kwonlyargs or arguments.defaults or arguments.posonlyargs:
        raise ValueError("only plain positional parameters can become variables")
    return [argument.arg for argument in arguments.args]


def _unsupported(node: ast.AST, reason: str = "not supported in an expression") -> ValueError:
    return ValueError(f"cannot convert {ast.unparse(node)!r}: {reason}")


def _convert(node: ast.expr, bound: dict[str, _VariableData], names: dict[str, Any]) -> Any:
    """The expression data for `node`. `bound` maps the variables in scope to their data, one per name, so each is
    written once; `names` holds the other names it can read."""

    def convert(child: ast.expr) -> Any:
        return _convert(child, bound, names)

    def operation(name: str, *children: ast.expr) -> _OperationData:
        return _OperationData(name, tuple(convert(child) for child in children))

    if isinstance(node, ast.Constant):
        if _native_name(node.value) is None:
            raise _unsupported(node, "only native constants are literals")
        return _LiteralData(node.value)
    if isinstance(node, ast.Name):
        if node.id in bound:
            return bound[node.id]
        if node.id not in names:
            raise _unsupported(node, "the name is not defined")
        value = names[node.id]
        if isinstance(value, Term):
            return value.data
        if isinstance(value, _KINDS) or _native_name(value) is not None:
            return OfAny.resolve(value)
        raise _unsupported(node, f"a {_type_name(value)} is not a native value or an expression")
    if isinstance(node, ast.Attribute):
        return _OperationData("get", (convert(node.value), _LiteralData(node.attr)))
    if isinstance(node, ast.BoolOp):
        name = "and" if isinstance(node.op, ast.And) else "or"
        result = convert(node.values[0])
        for value in node.values[1:]:
            result = _OperationData(name, (result, convert(value)))
        return result
    if isinstance(node, ast.UnaryOp):
        if isinstance(node.op, ast.Not):
            return operation("not", node.operand)
        if isinstance(node.op, ast.USub):
            return operation("neg", node.operand)
        if isinstance(node.op, ast.UAdd):
            return convert(node.operand)
        raise _unsupported(node)
    if isinstance(node, ast.BinOp):
        if type(node.op) not in _ARITHMETIC:
            raise _unsupported(node)
        return operation(_ARITHMETIC[type(node.op)], node.left, node.right)
    if isinstance(node, ast.Compare):
        return _compare(node, convert)
    if isinstance(node, ast.Call):
        return _call(node, bound, names)
    raise _unsupported(node)


def _compare(node: ast.Compare, convert: Callable[[ast.expr], Any]) -> Any:
    if len(node.ops) == 1 and isinstance(node.ops[0], (ast.Is, ast.IsNot)):
        right = node.comparators[0]
        if not (isinstance(right, ast.Constant) and right.value is None and isinstance(node.left, ast.Attribute)):
            raise _unsupported(node, "'is' only tests whether a property is None")
        has = _OperationData("has", (convert(node.left.value), _LiteralData(node.left.attr)))
        return _OperationData("not", (has,)) if isinstance(node.ops[0], ast.Is) else has
    pairs = []
    left = convert(node.left)
    for op, comparator in zip(node.ops, node.comparators):
        if type(op) not in _COMPARISONS:
            raise _unsupported(node)
        right = convert(comparator)
        pairs.append(_OperationData(_COMPARISONS[type(op)], (left, right)))
        left = right
    result = pairs[0]
    for pair in pairs[1:]:
        result = _OperationData("and", (result, pair))
    return result


def _call(node: ast.Call, bound: dict[str, _VariableData], names: dict[str, Any]) -> Any:
    if node.keywords:
        raise _unsupported(node)
    function, arguments = node.func, node.args
    if isinstance(function, ast.Lambda):
        parameters = _parameters(function)
        if len(parameters) != 1 or len(arguments) != 1:
            raise _unsupported(node, "a let binds one name")
        value = _convert(arguments[0], bound, names)
        inner = {**bound, parameters[0]: _VariableData(parameters[0])}
        return _LetData(parameters[0], value, _convert(function.body, inner, names))
    if isinstance(function, ast.Name) and function.id in ("hasattr", "getattr") and function.id not in bound:
        if len(arguments) != 2 or not (isinstance(arguments[1], ast.Constant) and type(arguments[1].value) is str):
            raise _unsupported(node, f"{function.id} takes an object and a property name")
        name = "has" if function.id == "hasattr" else "get"
        return _OperationData(name, (_convert(arguments[0], bound, names), _LiteralData(arguments[1].value)))
    raise _unsupported(node)


# --- Meta-schemas ---


def _native(name: str, native: type) -> Callable[[Any], Any]:
    return lambda p: p.name(name).of(lambda t: t.as_native(native))


Arguments = (
    Schemas.OfRelation.Builder().links("parent", "argument").properties(_native("index", int)).unique("argument")
    .create()
)
_KIND = _native("kind", str)
_NAME = _native("name", str)
_ARGUMENTS = lambda r: r.name("arguments").of(Arguments).me("parent")  # noqa: E731
_USED_BY = lambda r: r.name("used_by").of(Arguments).me("argument")  # noqa: E731
OfLiteral.Schema = (
    Schemas.OfObject.Builder().properties(_KIND, *(_native(name, native) for name, native in _NATIVES.items()))
    .relations(_USED_BY).create()
)
OfOperation.Schema = Schemas.OfObject.Builder().properties(_KIND, _NAME).relations(_ARGUMENTS, _USED_BY).create()
OfVariable.Schema = Schemas.OfObject.Builder().properties(_KIND, _NAME).relations(_USED_BY).create()
OfLet.Schema = Schemas.OfObject.Builder().properties(_KIND, _NAME).relations(_ARGUMENTS, _USED_BY).create()
_THIS = _VariableData("this")


def _kind_is(kind: str) -> _OperationData:
    """`eq(get(this, 'kind'), kind)`: the union's discriminator."""
    return _OperationData("eq", (_OperationData("get", (_THIS, _LiteralData("kind"))), _LiteralData(kind)))


OfAny.Schema = Schemas.OfUnion.Builder().branches(
    *(lambda b, data=data: b.of(data.Schema).when(_kind_is(data.Data.KIND))
      for data in (OfLiteral, OfOperation, OfVariable, OfLet))
).create()

_SCHEMAS: dict[str, Any] = {
    LITERAL: OfLiteral.Schema, OPERATION: OfOperation.Schema, VARIABLE: OfVariable.Schema, LET: OfLet.Schema,
    ARGUMENTS: Arguments,
}
for _name, _schema in _SCHEMAS.items():
    Proxies.register(_name, _schema)


# --- Registry ---


class _Builders:
    """Builds expressions from snapshots: `getattr(Builders, 'Expressions.OfLiteral')(instance)` returns a builder,
    as `Plain.FromPlain` expects. `schema` and `name_of` look the meta-schemas up."""

    def __init__(self) -> None:
        for name, builder in [(LITERAL, _LiteralBuilder), (OPERATION, _OperationBuilder),
                              (VARIABLE, _VariableBuilder), (LET, _LetBuilder)]:
            setattr(self, name, builder)

    def schema(self, name: str) -> Schemas.OfObject.Data:
        if name == ARGUMENTS:
            raise TypeError(f"{name!r} is a relation; no relation builder is exposed")
        if name not in _SCHEMAS:
            raise AttributeError(f"no schema registered as {name!r}")
        return _SCHEMAS[name]

    def name_of(self, schema: Any) -> str:
        for name, registered in _SCHEMAS.items():
            if registered is schema:
                return name
        raise LookupError("schema is not registered")


Builders = _Builders()
