"""Builders: schema builders as visitors of their meta-schemas. (Proposed: replaces the builders in
python3/mbse/Schemas/Framework/Schemas.py; `Schemas.OfX.Data` and `Schemas.OfX.Schema` are unchanged.)

Each `Schemas.OfX.Builder` is a writable `Visitors.OfObject` over its meta-schema, `Schemas.OfX.Schema`: it has a
member for each of the meta-schema's properties, and one for each list of members (an object's `properties` and
`adjacencies`, every kind's `parameters`, a union's `branches`, ...), which it adapts, from however `Schemas.OfX.Data`
stores them, to `Visitors.OfAdjacency`: each entry links the schema (`owner`) and one member, through a relation of its
own (`Schemas.HasProperty`, ...). Read, a member is the child visitor; called with a `Specs.Callback`, it writes or
visits through it and returns the builder. Its other methods are named `as_*`. The data it builds implements no visitor.

A builder works on a copy of the data it is given (`_working`), made by `_make` and filled by `_update`, and is
finalized by `create()` (no data given), `clone()` (a new copy) or `update()` (written back into the data given),
through `_finalize`; none validate.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any, ClassVar, Generic, TypeVar

from mbse.Schemas.Framework import Schemas as S
from mbse.Schemas.Framework.Errors import ReadOnlyError
from mbse.Schemas.Framework.Proxies import _Dunders, _Empty, _Properties, _Unassignable  # shared, once moved

__all__ = ["OfScalar", "OfObject", "OfProperty", "OfAdjacency", "OfRelation", "OfEntry", "OfSymbol", "OfParameter",
           "OfUnion", "OfIntersection", "OfContainer", "OfApply", "OfPredicate", "OfAny", "HasProperty",
           "HasAdjacency", "HasParameter", "HasBranch", "HasPart", "HasSymbol", "HasLink", "HasArgument"]

D = TypeVar("D")


def _is_function(spec: Any) -> bool:
    """Whether a `Specs.Callback` is its callable form: not a class (a value, `int`), nor a visitor (a value too)."""
    return callable(spec) and not isinstance(spec, type) and not isinstance(spec, _VALUES)


def _visit(cb: Any, visitor: Any) -> None:
    """Hands `visitor` to a callable Spec, which reads or writes through it; its return value is the visitor's own."""
    cb(visitor)


def _same(a: Any, b: Any) -> bool:
    """Whether a member's property agrees with a template's: a schema by identity, a scalar by value and type."""
    return a is b or (type(a) is type(b) and type(a) in S.SCALAR_TYPES and a == b)


# --- The relations through which a schema holds its members ---


def _has(name: str, member: str) -> S.OfRelation.Data:
    """A relation linking a schema (`owner`) and one of its members, in order."""
    links = {"owner": S.OfSymbol.Data("owner"), member: S.OfSymbol.Data(member)}
    return S.OfRelation.Data(name=f"Schemas.{name}", entry=S.OfEntry.Data(links=links))


HasProperty = _has("HasProperty", "property")
HasAdjacency = _has("HasAdjacency", "adjacency")
HasParameter = _has("HasParameter", "parameter")
HasBranch = _has("HasBranch", "branch")
HasPart = _has("HasPart", "part")
HasSymbol = _has("HasSymbol", "symbol")
HasLink = _has("HasLink", "link")
HasArgument = _has("HasArgument", "argument")


# --- Members ---


class _Prop:
    """A member for one property of the meta-schema, held in a field of the data (`field`, by default the member's
    name) or read and written through `get` and `put`. A schema-valued one (`kinds`, the table of the kinds of schema it
    holds) is visited, called with a callable, through `_SchemaValue`; another, through `_ScalarValue`. `after` follows
    a write with what the old clause did besides (a refinement takes what it refines from)."""

    name: str

    def __init__(self, field: str | None = None, *, get: Callable[[Any], Any] | None = None,
                 put: Callable[[Any, Any], None] | None = None, kinds: str | None = None,
                 after: Callable[[Any, Any], None] | None = None):
        self._field, self._get, self._put, self.kinds, self._after = field, get, put, kinds, after

    def __set_name__(self, owner: type, name: str) -> None:
        self.name = name
        field = self._field or name
        self.get = self._get or (lambda data: getattr(data, field))
        self._set = self._put or (lambda data, value: setattr(data, field, value))

    def put(self, data: Any, value: Any) -> None:
        if self.kinds is not None and value is not None:
            accepted = tuple(data_class for data_class, _ in _KINDS[self.kinds].values())
            if not isinstance(value, accepted):
                raise TypeError(f"property {self.name!r} holds a schema, or a callback taking the property; got {value!r}")
        self._set(data, value)
        if self._after is not None:
            self._after(data, value)

    def value(self, member: _PropertyMember) -> Any:
        """The `Visitors.OfAny` a callback given to `as_value` is handed."""
        return _ScalarValue(member) if self.kinds is None else _SchemaValue(member, _KINDS[self.kinds])

    def __get__(self, builder: Any, owner: type | None = None) -> Any:
        return self if builder is None else _PropertyMember(builder, self)


class _PropertyMember(_Dunders):
    """`Visitors.OfProperty` over one property of the schema a builder builds."""

    def __init__(self, builder: _Builder[Any], prop: _Prop):
        self._builder, self._prop, self._writable = builder, prop, builder._writable

    def _held(self) -> Any:
        return self._prop.get(self._builder._working)

    def _scalar(self) -> Any:
        held = self._held()
        return held if type(held) in S.SCALAR_TYPES else None

    def _label(self) -> str:
        return f"property {self._prop.name!r}"

    def _write(self, value: Any) -> None:
        self._builder._write(self._prop, value)

    def as_schema(self) -> Any:
        return self._builder.as_schema().properties.get(self._prop.name)

    def get(self) -> Any:
        return self._scalar()

    def as_value(self, cb: Any) -> _PropertyMember:
        if _is_function(cb):
            _visit(cb, self._prop.value(self))
        else:
            self._write(cb)
        return self

    def as_scalar(self, cb: Any) -> _PropertyMember:
        return self.as_value(lambda value: value.as_scalar(cb))

    def as_object(self, cb: Any) -> _PropertyMember:
        return self.as_value(lambda value: value.as_object(cb))

    def __call__(self, spec: Any) -> Any:
        if _is_function(spec):
            _visit(spec, self)
        else:
            self.as_value(spec)
        return self._builder

    def __repr__(self) -> str:
        return f"<{self._label()}>"


class _ScalarValue(_Unassignable):
    """`Visitors.OfAny` over a scalar-valued property: a scalar, or nothing."""

    def __init__(self, member: _PropertyMember):
        self._member = member

    def as_schema(self) -> Any:
        return getattr(self._member.as_schema(), "type", None)

    def as_scalar(self, cb: Any) -> _ScalarValue:
        if _is_function(cb):
            _visit(cb, _ScalarVisitor(self._member))
        else:
            self._member._write(cb)
        return self

    def _other(self, cb: Any) -> _ScalarValue:
        reason = f"{self._member._label()} holds a scalar"
        if not _is_function(cb):
            raise TypeError(reason)
        _visit(cb, _Empty(reason))
        return self

    as_object = as_union = as_intersection = as_container = _other

    def clear(self) -> None:
        self._member._write(None)


class _ScalarVisitor(_Dunders):
    """`Visitors.OfScalar` over a scalar-valued property."""

    def __init__(self, member: _PropertyMember):
        self._member, self._writable = member, member._writable

    def _held(self) -> Any:
        return self._member._held()

    def _scalar(self) -> Any:
        return self._member._scalar()

    def _label(self) -> str:
        return self._member._label()

    def as_schema(self) -> Any:
        return getattr(self._member.as_schema(), "type", None)

    def get(self) -> Any:
        return self._scalar()

    def set(self, value: Any) -> None:
        self._member._write(value)

    def clear(self) -> None:
        self._member._write(None)


class _SchemaValue(_Unassignable):
    """`Visitors.OfAny` over a schema-valued property (a type, what a schema refines, a relation). Each `as_<kind>`
    hands that kind's builder: over the schema held, where it is of that kind, else a new one; what is written through
    it replaces the schema held, by a copy. Given a value, it writes it (`as_scalar(int)`, a scalar of `int`)."""

    def __init__(self, member: _PropertyMember, kinds: dict[str, tuple[type, Callable[[], type]]]):
        self._member, self._kinds = member, kinds

    def as_schema(self) -> Any:
        return S.OfAny.Schema

    def _select(self, kind: str, cb: Any) -> _SchemaValue:
        member = self._member
        if kind not in self._kinds:
            reason = f"{member._label()} holds no {kind[3:]} schema"
            if not _is_function(cb):
                raise TypeError(reason)
            _visit(cb, _Empty(reason))
            return self
        data_class, builder_class = self._kinds[kind]
        if not _is_function(cb):
            member._write(S.OfScalar.Data(cb) if kind == "as_scalar" and isinstance(cb, type) else cb)
            return self
        held = member._held()
        builder = builder_class()(held if isinstance(held, data_class) else None, member._writable)
        _visit(cb, builder)
        if builder._written:
            member._write(builder.clone() if builder._original is not None else builder.create())
        return self

    def as_scalar(self, cb: Any) -> _SchemaValue:
        return self._select("as_scalar", cb)

    def as_object(self, cb: Any) -> _SchemaValue:
        return self._select("as_object", cb)

    def as_union(self, cb: Any) -> _SchemaValue:
        return self._select("as_union", cb)

    def as_intersection(self, cb: Any) -> _SchemaValue:
        return self._select("as_intersection", cb)

    def as_container(self, cb: Any) -> _SchemaValue:
        return self._select("as_container", cb)

    def as_apply(self, cb: Any) -> _SchemaValue:
        return self._select("as_apply", cb)

    def clear(self) -> None:
        self._member._write(None)


# --- Members held in lists, as adjacencies ---


def _by_name(field: str) -> dict[str, Any]:
    """Members stored as a dict by name, in declaration order; a member inserted under a name held replaces it."""
    return {"items": lambda data: list(getattr(data, field).values()),
            "store": lambda data, members: setattr(data, field, {m.name: m for m in members})}


def _in_order(field: str) -> dict[str, Any]:
    """Members stored as a tuple, in declaration order."""
    return {"items": lambda data: list(getattr(data, field)),
            "store": lambda data, members: setattr(data, field, tuple(members))}


class _Members:
    """A member for a list of members, which the builder adapts to `Visitors.OfAdjacency`: each entry of `relation`
    links the schema (`owner`) and one member (`link`), built by `member`'s builder. `items` and `store` read and write
    the list, from and to however the data stores it."""

    name: str

    def __init__(self, relation: S.OfRelation.Data, link: str, member: Callable[[], type],
                 items: Callable[[Any], list[Any]], store: Callable[[Any, list[Any]], None]):
        self.relation, self.link, self.member, self.items, self.store = relation, link, member, items, store

    def __set_name__(self, owner: type, name: str) -> None:
        self.name = name
        self.schema = S.OfAdjacency.Data(name=name, relation=self.relation, me="owner")

    def __get__(self, builder: Any, owner: type | None = None) -> Any:
        return self if builder is None else _AdjacencyMember(builder, self)


class _AdjacencyMember(_Unassignable):
    """`Visitors.OfAdjacency` over one list of members of the schema a builder builds: iterated, its entries."""

    def __init__(self, builder: _Builder[Any], members: _Members):
        self._builder, self._members = builder, members

    def _held(self) -> list[Any]:
        return self._members.items(self._builder._working)

    def _store(self, members: list[Any]) -> None:
        self._members.store(self._builder._working, members)
        self._builder._written.append(self._members)

    def _replace(self, index: int, member: Any) -> None:
        members = self._held()
        members[index] = member
        self._store(members)

    def as_schema(self) -> S.OfAdjacency.Data:
        return self._members.schema

    def __iter__(self) -> Iterator[_Entry]:
        return iter([_Entry(self, index, member) for index, member in enumerate(self._held())])

    def as_iterable(self, cb: Any) -> _AdjacencyMember:
        _visit(cb, iter(self))
        return self

    def insert(self, spec: Any) -> _AdjacencyMember:
        """Adds an entry, linking a member: built through the entry's link, or the member of an entry given."""
        self._builder._check()
        entry = _Entry(self)
        if _is_function(spec):
            _visit(spec, entry)
        elif isinstance(spec, _Entry):
            entry._member = spec._member
        else:
            raise TypeError(f"an entry, or a callback taking one, is expected; got {spec!r}")
        if entry._member is None:
            raise ValueError(f"link {self._members.link!r} is not set")
        self._store([*self._held(), entry._member])
        return self

    def remove(self, spec: Any) -> _AdjacencyMember:
        """Removes every entry that agrees with `spec`: an entry, linking the same member, or a template, whose link
        agrees with every property its callback writes."""
        self._builder._check()
        if _is_function(spec):
            template = _Entry(self)
            _visit(spec, template)
        elif isinstance(spec, _Entry):
            template = spec
        else:
            raise TypeError(f"an entry, or a callback taking one, is expected; got {spec!r}")
        self._store([member for member in self._held() if not template._agrees(member)])
        return self

    def __call__(self, spec: Any) -> Any:
        if _is_function(spec):
            _visit(spec, self)
        else:
            for entry in spec:  # an iterable of entries, each inserted
                self.insert(entry)
        return self._builder

    def __repr__(self) -> str:
        return f"<adjacency {self._members.name!r}>"


class _Entry(_Unassignable):
    """`Visitors.OfEntry`: one entry of a list of members. Its link to the member is a member (`e.property`); the link
    to the schema (`owner`) is filled by the adjacency."""

    def __init__(self, adjacency: _AdjacencyMember, index: int | None = None, member: Any = None):
        self._adjacency, self._index, self._member = adjacency, index, member
        self._template: list[Any] | None = None  # what the callback that built the member wrote

    def as_schema(self) -> S.OfEntry.Data:
        return self._adjacency._members.relation.entry

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name == self._adjacency._members.link:
            return _Link(self)
        return _Empty(f"{name!r} is not a link this entry can set, nor a property of the relation")

    def _relink(self, member: Any, template: list[Any] | None) -> None:
        self._member, self._template = member, template
        if self._index is not None:  # an entry held: the adjacency links the member in its place
            self._adjacency._replace(self._index, member)

    def _agrees(self, member: Any) -> bool:
        if self._member is None:
            return True
        if self._template is None:
            return member is self._member
        return all(_same(prop.get(member), prop.get(self._member)) for prop in self._template if isinstance(prop, _Prop))

    def __repr__(self) -> str:
        return f"<entry of {self._adjacency._members.relation.name}>"


class _Link(_Unassignable):
    """An entry's link to a member, a `Visitors.OfObject`: read, the member, read-only, through its builder; called
    with a Spec, it relinks, to the member given or to the one the builder a callable is handed builds, over the member
    linked where there is one."""

    def __init__(self, entry: _Entry):
        self._entry = entry

    def _builder_class(self) -> type:
        return self._entry._adjacency._members.member()

    def _target(self) -> Any:
        member = self._entry._member
        if member is None:
            return _Empty(f"link {self._entry._adjacency._members.link!r} is not set")
        return self._builder_class()(member, False)

    def as_schema(self) -> Any:
        return self._target().as_schema()

    def as_identity(self, identity: str | None = None) -> Any:
        return self._target().as_identity(identity)

    @property
    def as_properties(self) -> Any:
        return self._target().as_properties

    def as_adjacencies(self, cb: Any) -> _Link:
        self._target().as_adjacencies(cb)
        return self

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._target(), name)

    def __call__(self, spec: Any) -> _Entry:
        entry, builder_class = self._entry, self._builder_class()
        if entry._index is not None:
            entry._adjacency._builder._check()
        if _is_function(spec):
            builder = builder_class(entry._member)
            _visit(spec, builder)
            if builder._written or entry._member is None:
                entry._relink(builder.clone() if entry._member is not None else builder.create(), builder._written)
        elif isinstance(spec, _Link):
            entry._relink(spec._entry._member, None)
        elif isinstance(spec, builder_class._data):
            entry._relink(spec, None)
        else:
            raise TypeError(f"link {entry._adjacency._members.link!r} takes {builder_class._noun}, or a callback taking "
                            f"its builder; got {spec!r}")
        return entry

    def __repr__(self) -> str:
        return f"<link {self._entry._adjacency._members.link!r}>"


# --- Builders ---


class _Builder(_Unassignable, Generic[D]):
    """A writable `Visitors.OfObject` over a meta-schema (`_meta`), building its data (`_data`). Read-only, it reads the
    data it is given and refuses every write: a member read through a link is."""

    _data: ClassVar[type]
    _meta: ClassVar[Callable[[], Any]]
    _noun: ClassVar[str]
    _members_: ClassVar[dict[str, _Prop | _Members]] = {}

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        cls._members_ = {name: member for base in reversed(cls.__mro__) for name, member in vars(base).items()
                         if isinstance(member, (_Prop, _Members))}

    def __init__(self, original: D | None = None, writable: bool = True):
        if original is not None and not isinstance(original, self._data):
            raise TypeError(f"a builder of {self._noun} is given {original!r}")
        self._original, self._writable = original, writable
        self._written: list[Any] = []  # the members written, in order
        self._working = self._make()
        if original is not None:
            self._update(self._working, original)

    def _make(self) -> D:
        return self._data()

    def _update(self, target: D, source: D) -> int:
        """Writes `source`'s fields into `target`, copying the containers it holds, never the schemas; the number of
        fields that held something else."""
        changed = 0
        for field in dataclasses.fields(source):  # type: ignore[arg-type]
            old, new = getattr(target, field.name), getattr(source, field.name)
            changed += old is not new
            setattr(target, field.name, S._copy(new))
        return changed

    def _finalize(self, target: D) -> D:
        return target

    def create(self) -> D:
        """Returns new data. Only valid without data given."""
        if self._original is not None:
            raise ValueError("create() is only valid without a source instance; use clone() or update()")
        return self._finalize(self._working)

    def clone(self) -> D:
        """Returns new data, leaving the data given as it is. Only valid with data given."""
        if self._original is None:
            raise ValueError("clone() is only valid with a source instance")
        return self._finalize(self._working)

    def update(self) -> D:
        """Writes the builder's state into the data given, and returns it. Only valid with data given."""
        if self._original is None:
            raise ValueError("update() is only valid with a source instance")
        self._update(self._original, self._working)
        return self._finalize(self._original)

    def _check(self) -> None:
        if not self._writable:
            raise ReadOnlyError(f"{self._noun} read through a link is read-only; write it by calling the link with a "
                                "callback")

    def _write(self, prop: _Prop, value: Any) -> None:
        self._check()
        prop.put(self._working, value)
        self._written.append(prop)

    def as_schema(self) -> S.OfObject.Data:
        return self._meta()

    def as_identity(self, identity: str | None = None) -> None:
        """None: a schema is a value object, named by its `name`; a write is refused."""
        if identity is not None:
            raise TypeError(f"{self._noun} is a value object, with no identity")
        return None

    @property
    def as_properties(self) -> _Properties:
        present = [getattr(self, name) for name, member in self._members_.items()
                   if isinstance(member, _Prop) and member.get(self._working) is not None]
        return _Properties(self, present)

    def as_adjacencies(self, cb: Any) -> Any:
        for name, member in self._members_.items():
            if isinstance(member, _Members):
                _visit(cb, getattr(self, name))
        return self

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return _Empty(f"{name!r} is not a member of {self._noun}'s builder")

    def __repr__(self) -> str:
        return f"<builder of {self._noun}>"


def _parameters() -> _Members:
    return _Members(HasParameter, "parameter", lambda: ParameterBuilder, **_by_name("parameters"))


class _KindBuilder(_Builder[D]):
    """A builder of a kind of schema, which may be named, described and parametric."""

    name = _Prop()
    description = _Prop()
    parameters = _parameters()


# --- Builders of members ---


class _TypedBuilder(_Builder[D]):
    """A builder of a member with a name and a type: a property, a parameter, a symbol, a branch or a part."""

    name = _Prop()
    type = _Prop(kinds="any")
    description = _Prop()


class PropertyBuilder(_TypedBuilder[S.OfProperty.Data]):
    _data, _noun = S.OfProperty.Data, "a property"
    _meta = staticmethod(lambda: S.OfProperty.Schema)


class ParameterBuilder(_TypedBuilder[S.OfParameter.Data]):
    _data, _noun = S.OfParameter.Data, "a parameter"
    _meta = staticmethod(lambda: S.OfParameter.Schema)


class SymbolBuilder(_TypedBuilder[S.OfSymbol.Data]):
    _data, _noun = S.OfSymbol.Data, "a symbol"
    _meta = staticmethod(lambda: S.OfSymbol.Schema)


class MemberBuilder(_TypedBuilder[S.OfUnion.Branch]):
    """A union's branch or an intersection's part."""

    _data, _noun = S.OfUnion.Branch, "a branch or a part"
    _meta = staticmethod(lambda: S.OfProperty.Schema)


class AdjacencyBuilder(_Builder[S.OfAdjacency.Data]):
    _data, _noun = S.OfAdjacency.Data, "an adjacency"
    _meta = staticmethod(lambda: S.OfAdjacency.Schema)

    name = _Prop()
    relation = _Prop(kinds="relation")
    me = _Prop()
    description = _Prop()


@dataclass(eq=False)
class _ArgumentData:
    """An application's argument, as its builder reads it: `Schemas.OfApply.Data.arguments` holds it by name."""

    name: str = ""
    value: Any = None  # a scalar value or a term


class ArgumentBuilder(_Builder[_ArgumentData]):
    _data, _noun = _ArgumentData, "an argument"
    _meta = staticmethod(lambda: S.OfApply.Argument)

    name = _Prop()
    value = _Prop(get=lambda data: None if S._is_term(data.value) else data.value)
    term = _Prop("value", get=lambda data: data.value if S._is_term(data.value) else None)


# --- Builders of kinds ---


def _token(data: Any) -> Any:
    return data.token if isinstance(data.token, S.OfScalar.Token) else None


def _refined_scalar(data: S.OfScalar.Data, base: Any) -> None:
    held = S.structure(base)
    if data.token is None and isinstance(held, S.OfScalar.Data):
        data.token = held.token


class ScalarBuilder(_KindBuilder[S.OfScalar.Data]):
    """`.token("int")`, a token in the `basic` format unless `.format(...)` says otherwise."""

    _data, _noun = S.OfScalar.Data, "a scalar schema"
    _meta = staticmethod(lambda: S.OfScalar.Schema)

    refines = _Prop(kinds="any", after=_refined_scalar)
    format = _Prop(get=lambda data: getattr(_token(data), "format", None),
                   put=lambda data, value: setattr(data, "token", S.OfScalar.Token(
                       value, getattr(_token(data), "name", ""))))
    token = _Prop(get=lambda data: getattr(_token(data), "name", None),
                  put=lambda data, value: setattr(data, "token", S.OfScalar.Token(
                      getattr(_token(data), "format", S.BASIC), value)))
    bits = _Prop()  # an int or a term
    bytes = _Prop()


def _refined_object(data: S.OfObject.Data, base: Any) -> None:
    held = S.structure(base)
    if isinstance(held, S.OfObject.Data) and held.ref:
        data.ref = True


def _singleton(data: S.OfObject.Data, name: Any) -> None:
    if name is not None:
        data.ref = True


class ObjectBuilder(_KindBuilder[S.OfObject.Data]):
    _data, _noun = S.OfObject.Data, "an object schema"
    _meta = staticmethod(lambda: S.OfObject.Schema)

    refines = _Prop(kinds="any", after=_refined_object)
    singleton = _Prop(after=_singleton)
    ref = _Prop()
    pattern = _Prop()
    properties = _Members(HasProperty, "property", lambda: PropertyBuilder, **_by_name("properties"))
    adjacencies = _Members(  # named ones by name, then anonymous ones, which have none
        HasAdjacency, "adjacency", lambda: AdjacencyBuilder,
        items=lambda data: [*data.adjacencies.values(), *data.anonymous],
        store=lambda data, members: (setattr(data, "adjacencies", {m.name: m for m in members if m.name}),
                                     setattr(data, "anonymous", [m for m in members if not m.name])))

    def _finalize(self, target: S.OfObject.Data) -> S.OfObject.Data:
        return S._settle(target)


class UnionBuilder(_KindBuilder[S.OfUnion.Data]):
    _data, _noun = S.OfUnion.Data, "a union"
    _meta = staticmethod(lambda: S.OfUnion.Schema)

    flat = _Prop()
    branches = _Members(HasBranch, "branch", lambda: MemberBuilder, **_in_order("branches"))


class IntersectionBuilder(_KindBuilder[S.OfIntersection.Data]):
    _data, _noun = S.OfIntersection.Data, "an intersection"
    _meta = staticmethod(lambda: S.OfIntersection.Schema)

    flat = _Prop()
    parts = _Members(HasPart, "part", lambda: MemberBuilder, **_in_order("parts"))


def _refined_container(data: S.OfContainer.Data, base: Any) -> None:
    held = S.structure(base)
    if isinstance(held, S.OfContainer.Data):
        data.index = held.index if data.index is None else data.index
        data.element = held.element if data.element is None else data.element


class ContainerBuilder(_KindBuilder[S.OfContainer.Data]):
    _data, _noun = S.OfContainer.Data, "a container schema"
    _meta = staticmethod(lambda: S.OfContainer.Schema)

    refines = _Prop(kinds="any", after=_refined_container)
    index = _Prop(kinds="any")
    element = _Prop(kinds="any")
    layout = _Prop()  # "dense", "sparse", or None


class ApplyBuilder(_KindBuilder[S.OfApply.Data]):
    _data, _noun = S.OfApply.Data, "an application"
    _meta = staticmethod(lambda: S.OfApply.Schema)

    of = _Prop(kinds="any")
    arguments = _Members(
        HasArgument, "argument", lambda: ArgumentBuilder,
        items=lambda data: [_ArgumentData(name, value) for name, value in data.arguments.items()],
        store=lambda data, members: setattr(data, "arguments", {m.name: m.value for m in members}))


class PredicateBuilder(_KindBuilder[S.OfPredicate.Data]):
    _data, _noun = S.OfPredicate.Data, "a predicate"
    _meta = staticmethod(lambda: S.OfPredicate.Schema)

    requires = _Prop()  # a term
    symbols = _Members(HasSymbol, "symbol", lambda: SymbolBuilder, **_by_name("symbols"))


class RelationBuilder(_KindBuilder[S.OfRelation.Data]):
    """A relation's links and properties are its entries': the meta-schema holds them as the relation's own."""

    _data, _noun = S.OfRelation.Data, "a relation"
    _meta = staticmethod(lambda: S.OfRelation.Schema)

    links = _Members(HasLink, "link", lambda: SymbolBuilder,
                     items=lambda data: list(data.entry.links.values()),
                     store=lambda data, members: setattr(data.entry, "links", {m.name: m for m in members}))
    properties = _Members(HasProperty, "property", lambda: PropertyBuilder,
                          items=lambda data: list(data.entry.properties.values()),
                          store=lambda data, members: setattr(data.entry, "properties", {m.name: m for m in members}))
    uniques = _Prop(put=lambda data, value: setattr(data, "uniques", tuple(frozenset(names) for names in value)))

    def _update(self, target: S.OfRelation.Data, source: S.OfRelation.Data) -> int:
        changed = super()._update(target, source)
        target.entry = S.OfEntry.Data(dict(source.entry.links), dict(source.entry.properties))
        return changed


class EntryBuilder(_Builder[S.OfEntry.Data]):
    _data, _noun = S.OfEntry.Data, "an entry schema"
    _meta = staticmethod(lambda: S.OfEntry.Schema)

    links = _Members(HasLink, "link", lambda: SymbolBuilder, **_by_name("links"))
    properties = _Members(HasProperty, "property", lambda: PropertyBuilder, **_by_name("properties"))


class AnyValueBuilder(_KindBuilder[S.OfAny.Value]):
    """A value of any type, or of one of `types`."""

    _data, _noun = S.OfAny.Value, "a value of any type"
    _meta = staticmethod(lambda: S.OfAny.Value.Schema)

    types = _Prop(put=lambda data, value: setattr(data, "types", tuple(value)))


class AnyBuilder(_Unassignable):
    """`Schemas.OfAny.Builder`, a `Visitors.OfAny` that selects a type through `as_<kind>(spec)`, as it does now:
    finalized, the one kind's data, or a value of any of several, or of any type for none."""

    def __init__(self, instance: Any = None):
        self._source, self._types = instance, []

    def as_schema(self) -> Any:
        return S.OfAny.Schema

    def _select(self, kind: str, cb: Any) -> AnyBuilder:
        data_class, builder_class = _KINDS["any"][kind]
        if _is_function(cb):
            builder = builder_class()()
            _visit(cb, builder)
            self._types.append(builder.create())
        else:
            self._types.append(S.OfScalar.Data(cb) if kind == "as_scalar" and isinstance(cb, type) else cb)
        return self

    def as_scalar(self, cb: Any) -> AnyBuilder:
        return self._select("as_scalar", cb)

    def as_object(self, cb: Any) -> AnyBuilder:
        return self._select("as_object", cb)

    def as_union(self, cb: Any) -> AnyBuilder:
        return self._select("as_union", cb)

    def as_intersection(self, cb: Any) -> AnyBuilder:
        return self._select("as_intersection", cb)

    def as_container(self, cb: Any) -> AnyBuilder:
        return self._select("as_container", cb)

    def as_apply(self, cb: Any) -> AnyBuilder:
        return self._select("as_apply", cb)

    def create(self) -> Any:
        return self._types[0] if len(self._types) == 1 else S.OfAny.Value(tuple(self._types))


_KINDS: dict[str, dict[str, tuple[type, Callable[[], type]]]] = {
    "any": {
        "as_scalar": (S.OfScalar.Data, lambda: ScalarBuilder),
        "as_object": (S.OfObject.Data, lambda: ObjectBuilder),
        "as_union": (S.OfUnion.Data, lambda: UnionBuilder),
        "as_intersection": (S.OfIntersection.Data, lambda: IntersectionBuilder),
        "as_container": (S.OfContainer.Data, lambda: ContainerBuilder),
        "as_apply": (S.OfApply.Data, lambda: ApplyBuilder),
        "as_any": (S.OfAny.Value, lambda: AnyValueBuilder),
    },
    "relation": {"as_object": (S.OfRelation.Data, lambda: RelationBuilder)},
}
"""The kinds of schema a schema-valued property holds, each its data and its builder, by the `as_<kind>` that selects
it."""

_VALUES = (_PropertyMember, _ScalarValue, _ScalarVisitor, _SchemaValue, _AdjacencyMember, _Entry, _Link, _Builder,
           AnyBuilder, _Empty, _Properties)
"""The classes whose instances are values, not the callable form of a Spec, though some are callable."""


# --- The namespaces, as `Schemas` gives them ---


class OfScalar:
    Data, Builder, Token = S.OfScalar.Data, ScalarBuilder, S.OfScalar.Token


class OfObject:
    Data, Builder = S.OfObject.Data, ObjectBuilder


class OfProperty:
    Data, Builder = S.OfProperty.Data, PropertyBuilder


class OfAdjacency:
    Data, Builder = S.OfAdjacency.Data, AdjacencyBuilder


class OfRelation:
    Data, Builder = S.OfRelation.Data, RelationBuilder


class OfEntry:
    Data, Builder = S.OfEntry.Data, EntryBuilder


class OfSymbol:
    Data, Builder = S.OfSymbol.Data, SymbolBuilder


class OfParameter:
    Data, Builder = S.OfParameter.Data, ParameterBuilder


class OfUnion:
    Data, Builder, Branch = S.OfUnion.Data, UnionBuilder, S.OfUnion.Branch


class OfIntersection:
    Data, Builder, Part = S.OfIntersection.Data, IntersectionBuilder, S.OfIntersection.Part


class OfContainer:
    Data, Builder = S.OfContainer.Data, ContainerBuilder


class OfApply:
    Data, Builder = S.OfApply.Data, ApplyBuilder


class OfPredicate:
    Data, Builder = S.OfPredicate.Data, PredicateBuilder


class OfAny:
    Builder = AnyBuilder

    class Value:
        Data, Builder = S.OfAny.Value, AnyValueBuilder
