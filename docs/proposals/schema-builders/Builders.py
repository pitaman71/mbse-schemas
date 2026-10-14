"""Builders: schema builders as visitors of their meta-schemas, which model schemas as reference objects and
relations. (Proposed: replaces the builders and meta-schemas in python3/mbse/Schemas/Framework/Schemas.py;
`Schemas.OfX.Data` is unchanged.)

Every schema object is a reference object: a kind of schema, and each of its members (a property, an adjacency, a
parameter, a symbol, a branch or a part, an argument, a unique clause), and a term. A property of a schema object holds
a value (a name, a flag, a term's attributes); every reference from one schema object to another is a relation: a
schema to its members (`Schemas.HasProperty`, ...), a member to its type (`Schemas.Typing`), a refinement to what it
refines (`Schemas.Refines`), a scalar to its widths, which are terms (`Schemas.BitWidth`), and so on (`Meta`, below).

Each `Schemas.OfX.Builder` is a writable `Visitors.OfObject` over its meta-schema (`Meta.X`), as VISITOR_PATTERN.md
gives it: a member for each property (`osv.<propName>`, a `Visitors.OfProperty`) and for each adjacency
(`osv.<adjName>`, a `Visitors.OfAdjacency`, whose entries' links are members, `env.<linkName>`). Called with a
`Specs.Callback`, a member writes or visits through it and returns the builder. Its other methods are named `as_*`. The
builder adapts each member to however `Schemas.OfX.Data` stores it (a dict by name, a field holding a schema, a width
held as an int); the data implements no visitor.

A builder works on a copy of the data it is given (`_working`), made by `_make` and filled by `_update`, and is
finalized by `create()` (no data given), `clone()` (new data) or `update()` (written back into the data given), through
`_finalize`; none validate.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any, ClassVar, Generic, TypeVar

from mbse.Schemas.Framework import Schemas as S
from mbse.Schemas.Framework.Errors import ReadOnlyError
from mbse.Schemas.Framework.Proxies import _Dunders, _Empty, _Properties, _Unassignable  # shared, once moved

__all__ = [
    "Form",
    "Meta",
    "OfAdjacency",
    "OfAny",
    "OfApply",
    "OfContainer",
    "OfIntersection",
    "OfObject",
    "OfParameter",
    "OfPredicate",
    "OfProperty",
    "OfRelation",
    "OfScalar",
    "OfSymbol",
    "OfUnion",
]

D = TypeVar("D")


def _is_function(spec: Any) -> bool:
    """Whether a `Specs.Callback` is its callable form: not a class (a value, `int`), nor a visitor (a value too)."""
    return callable(spec) and not isinstance(spec, type) and not isinstance(spec, _VALUES)


def _visit(cb: Any, visitor: Any) -> None:
    """Hands `visitor` to a callable Spec, which reads or writes through it; its return value is the visitor's own."""
    cb(visitor)


def _same(a: Any, b: Any) -> bool:
    """Whether a value agrees with a template's: a reference object by identity, a value by value and type."""
    return a is b or (type(a) is type(b) and not dataclasses.is_dataclass(a) and a == b)


# --- Properties: values ---


class _Prop:
    """A member for one property of the meta-schema, held in a field of the data (`field`, by default the member's
    name) or read and written through `get` and `put`. Its value is a scalar, or, `container`, a dict of scalars."""

    name: str

    def __init__(self, field: str | None = None, *, get: Callable[[Any], Any] | None = None,
                 put: Callable[[Any, Any], None] | None = None, container: bool = False):
        self._field, self._get, self._put, self.container = field, get, put, container

    def __set_name__(self, owner: type, name: str) -> None:
        self.name = name
        field = self._field or name
        self.get = self._get or (lambda data: getattr(data, field))
        self.put = self._put or (lambda data, value: setattr(data, field, value))

    def __get__(self, builder: Any, owner: type | None = None) -> Any:
        return self if builder is None else _PropertyMember(builder, self)


class _PropertyMember(_Dunders):
    """`Visitors.OfProperty` over one property of the schema object a builder builds."""

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
        meta = self._builder.as_schema()
        return None if meta is None else meta.properties.get(self._prop.name)

    def get(self) -> Any:
        return self._scalar()

    def as_value(self, cb: Any) -> _PropertyMember:
        if _is_function(cb):
            _visit(cb, _Value(self._label(), self._held, self._write, self._writable, self._prop.container,
                              lambda: getattr(self.as_schema(), "type", None)))
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


class _Value(_Unassignable):
    """`Visitors.OfAny` over a value held where `held` reads it and `write` writes it: a scalar, or a container."""

    def __init__(self, label: str, held: Callable[[], Any], write: Callable[[Any], None], writable: bool,
                 container: bool, schema: Callable[[], Any]):
        self._label, self._held, self._write, self._writable = label, held, write, writable
        self._container, self._schema = container, schema

    def as_schema(self) -> Any:
        return self._schema()

    def _other(self, cb: Any) -> _Value:
        reason = f"{self._label} holds {'a container' if self._container else 'a scalar'}"
        if not _is_function(cb):
            raise TypeError(reason)
        _visit(cb, _Empty(reason))
        return self

    def as_scalar(self, cb: Any) -> _Value:
        if self._container:
            return self._other(cb)
        if _is_function(cb):
            _visit(cb, _ScalarVisitor(self))
        else:
            self._write(cb)
        return self

    def as_container(self, cb: Any) -> _Value:
        if not self._container:
            return self._other(cb)
        if _is_function(cb):
            _visit(cb, _Mapping(self))
        else:
            self._write(dict(cb))
        return self

    as_object = as_union = as_intersection = _other

    def clear(self) -> None:
        self._write(None)


class _ScalarVisitor(_Dunders):
    """`Visitors.OfScalar` over a value a `_Value` holds."""

    def __init__(self, value: _Value):
        self._value, self._writable = value, value._writable

    def _held(self) -> Any:
        return self._value._held()

    def _scalar(self) -> Any:
        held = self._held()
        return held if type(held) in S.SCALAR_TYPES else None

    def _label(self) -> str:
        return self._value._label

    def as_schema(self) -> Any:
        return self._value.as_schema()

    def get(self) -> Any:
        return self._scalar()

    def set(self, value: Any) -> None:
        self._value._write(value)

    def clear(self) -> None:
        self._value._write(None)


class _Mapping(_Unassignable):
    """`Visitors.OfContainer` over a dict of scalars a `_Value` holds (a form's attributes): arranged as a dict."""

    def __init__(self, value: _Value):
        self._value = value

    def _items(self) -> dict[Any, Any]:
        return dict(self._value._held() or {})

    def _element(self, index: Any) -> _Value:
        def write(element: Any) -> None:
            items = self._items()
            if element is None:
                items.pop(index, None)
            else:
                items[index] = element
            self._value._write(items)

        return _Value(f"{self._value._label}[{index!r}]", lambda: self._items().get(index), write,
                      self._value._writable, False, lambda: None)

    def as_schema(self) -> Any:
        return self._value.as_schema()

    def __len__(self) -> int:
        return len(self._items())

    def at(self, index: Any) -> _Value:
        return self._element(index)

    def remove(self, index: Any) -> _Mapping:
        self._element(index).clear()
        return self

    def as_ordered(self, cb: Any) -> _Mapping:  # arranged as a dict: cb is not called
        return self

    def as_dict(self, cb: Any) -> _Mapping:
        _visit(cb, {index: self._element(index) for index in self._items()})
        return self

    def as_entries(self, cb: Any) -> _Mapping:
        _visit(cb, iter([(index, self._element(index)) for index in self._items()]))
        return self


# --- Adjacencies: references ---


def _by_name(field: str) -> dict[str, Any]:
    """Members stored as a dict by name, in declaration order; a member inserted under a name held replaces it."""
    return {"items": lambda data: list(getattr(data, field).values()),
            "store": lambda data, members: setattr(data, field, {m.name: m for m in members})}


def _in_order(field: str) -> dict[str, Any]:
    """Referents stored as a tuple, in order."""
    return {"items": lambda data: list(getattr(data, field)),
            "store": lambda data, members: setattr(data, field, tuple(members))}


def _one(field: str) -> dict[str, Any]:
    """A referent stored in a field, or None: the adjacency holds at most one entry."""
    return {"items": lambda data: [] if getattr(data, field) is None else [getattr(data, field)],
            "store": lambda data, members: setattr(data, field, members[-1] if members else None), "one": True}


def _is_schema(value: Any) -> bool:
    return isinstance(value, S._KINDS)


class _Members:
    """A member for an adjacency of the meta-schema, whose entries link the schema object being built and, at `link`,
    another (the referent). `items` and `store` read and write the referents from and to however the data stores
    them; `accepts` says which objects `link` may link, and `build` how a callback given to it builds one: through a
    builder (a class, given lazily), through `_Kinds` ("kinds", a schema of any kind), or not at all (None: it links an
    object that exists). `one`: at most one entry, as a `unique` clause of its relation makes it."""

    name: str

    def __init__(self, link: str, *, items: Callable[[Any], list[Any]], store: Callable[[Any, list[Any]], None],
                 accepts: Callable[[Any], bool], build: Any = None, one: bool = False):
        self.link, self.items, self.store, self.accepts, self.build, self.one = link, items, store, accepts, build, one

    def __set_name__(self, owner: type, name: str) -> None:
        self.name = name

    def __get__(self, builder: Any, owner: type | None = None) -> Any:
        return self if builder is None else _AdjacencyMember(builder, self)


class _AdjacencyMember(_Unassignable):
    """`Visitors.OfAdjacency` over one adjacency of the schema object a builder builds: iterated, its entries."""

    def __init__(self, builder: _Builder[Any], members: _Members):
        self._builder, self._members = builder, members

    def _held(self) -> list[Any]:
        return self._members.items(self._builder._working)

    def _store(self, referents: list[Any]) -> None:
        self._members.store(self._builder._working, referents)
        self._builder._written.append(self._members)

    def _replace(self, index: int, referent: Any) -> None:
        referents = self._held()
        referents[index] = referent
        self._store(referents)

    def as_schema(self) -> Any:
        meta = self._builder.as_schema()
        return None if meta is None else meta.adjacencies.get(self._members.name)

    def __iter__(self) -> Iterator[_Entry]:
        return iter([_Entry(self, index, referent) for index, referent in enumerate(self._held())])

    def as_iterable(self, cb: Any) -> _AdjacencyMember:
        _visit(cb, iter(self))
        return self

    def insert(self, spec: Any) -> _AdjacencyMember:
        """Adds an entry, linking a referent: given to the entry's link, or built through it; an entry linking a
        referent held is elided. Where the adjacency holds at most one entry, it must be removed before another."""
        self._builder._check()
        entry = _Entry(self)
        if _is_function(spec):
            _visit(spec, entry)
        elif isinstance(spec, _Entry):
            entry._referent = spec._referent
        else:
            raise TypeError(f"an entry, or a callback taking one, is expected; got {spec!r}")
        if entry._referent is None:
            raise ValueError(f"link {self._members.link!r} is not set")
        held = self._held()
        if any(referent is entry._referent for referent in held):
            return self
        if self._members.one and held:
            raise ValueError(f"{self._members.name!r} holds one entry; remove it before inserting another")
        self._store([*held, entry._referent])
        return self

    def remove(self, spec: Any) -> _AdjacencyMember:
        """Removes every entry that agrees with `spec`: an entry, linking the same referent, or a template, whose link
        agrees with every property its callback writes."""
        self._builder._check()
        if _is_function(spec):
            template = _Entry(self)
            _visit(spec, template)
        elif isinstance(spec, _Entry):
            template = spec
        else:
            raise TypeError(f"an entry, or a callback taking one, is expected; got {spec!r}")
        self._store([referent for referent in self._held() if not template._agrees(referent)])
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
    """`Visitors.OfEntry`: one entry of an adjacency. Its link to the referent is a member (`e.property`); the link to
    the schema object being built is filled by the adjacency."""

    def __init__(self, adjacency: _AdjacencyMember, index: int | None = None, referent: Any = None):
        self._adjacency, self._index, self._referent = adjacency, index, referent
        self._template: list[Any] | None = None  # what the callback that built the referent wrote

    def as_schema(self) -> Any:
        schema = self._adjacency.as_schema()
        return None if schema is None else schema.relation.entry

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name == self._adjacency._members.link:
            return _Link(self)
        return _Empty(f"{name!r} is not a link this entry can set, nor a property of the relation")

    def _relink(self, referent: Any, template: list[Any] | None) -> None:
        self._referent, self._template = referent, template
        if self._index is not None:  # an entry held: the adjacency links the referent in its place
            self._adjacency._replace(self._index, referent)

    def _agrees(self, referent: Any) -> bool:
        if self._referent is None:
            return True
        if self._template is None:
            return referent is self._referent
        return all(_same(prop.get(referent), prop.get(self._referent)) for prop in self._template
                   if isinstance(prop, _Prop))

    def __repr__(self) -> str:
        return f"<entry of {self._adjacency._members.name!r}>"


class _Link(_Unassignable):
    """An entry's link to its referent, a `Visitors.OfObject`: read, the referent, read-only, through its builder;
    called with a Spec, it links the referent given, or builds one through the callback: a new one, or, where the
    entry links one, that one, updated."""

    def __init__(self, entry: _Entry):
        self._entry = entry

    def _members(self) -> _Members:
        return self._entry._adjacency._members

    def _target(self) -> Any:
        referent = self._entry._referent
        if referent is None:
            return _Empty(f"link {self._members().link!r} is not set")
        builder = _builder_for(referent)
        return _Empty("a term of a dialect is read through its dialect") if builder is None else builder(referent, False)

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
        entry, members = self._entry, self._members()
        if entry._index is not None:
            entry._adjacency._builder._check()
        if _is_function(spec):
            if members.build is None:
                raise TypeError(f"link {members.link!r} links an object that exists: give it, not a callback")
            if members.build == "kinds":
                kinds = _Kinds(entry._referent)
                _visit(spec, kinds)
                result, written = kinds._result, kinds._written
            else:
                result, written = _build(members.build(), entry._referent, spec)
            if result is not None:
                entry._relink(result, written)
            return entry
        referent = spec._entry._referent if isinstance(spec, _Link) else spec
        if not members.accepts(referent):
            raise TypeError(f"link {members.link!r} cannot link {referent!r}")
        entry._relink(referent, None)
        return entry

    def __repr__(self) -> str:
        return f"<link {self._members().link!r}>"


def _build(builder_class: type, current: Any, cb: Any) -> tuple[Any, list[Any]]:
    """Builds a link's referent through a builder of `builder_class` handed to `cb`: a new referent, or the one linked,
    updated where `cb` writes; with what `cb` wrote. None where it edits the one linked and writes nothing."""
    builder = builder_class(current) if current is not None else builder_class()
    _visit(cb, builder)
    if current is not None and not builder._written:
        return None, []
    return (builder._edited() if current is not None else builder.create()), builder._written


class _Kinds(_Unassignable):
    """A link to a schema of any kind, called with a callback: a `Visitors.OfUnion` over the kinds (`Meta.Type`'s
    refinements), each branch a member taking that kind's builder, or a schema of that kind. Building one of the
    kind linked updates it; another kind builds a new one."""

    def __init__(self, current: Any):
        self._current, self._result, self._written = current, None, []

    def as_schema(self) -> Any:
        return getattr(Meta, "Type", None)

    def _select(self, kind: str, cb: Any) -> _Kinds:
        data_class, builder_class = _KIND_BUILDERS[kind]
        if not _is_function(cb):
            value = S.OfScalar.Data(cb) if kind == "scalar" and isinstance(cb, type) else cb
            if not isinstance(value, data_class):
                raise TypeError(f"branch {kind!r} takes {builder_class()._noun}, or a callback taking its builder")
            self._result = value
            return self
        current = self._current if type(self._current) is data_class else None
        result, written = _build(builder_class(), current, cb)
        if result is not None:
            self._result, self._written = result, written
        return self

    def scalar(self, cb: Any) -> _Kinds:
        return self._select("scalar", cb)

    def object(self, cb: Any) -> _Kinds:
        return self._select("object", cb)

    def union(self, cb: Any) -> _Kinds:
        return self._select("union", cb)

    def intersection(self, cb: Any) -> _Kinds:
        return self._select("intersection", cb)

    def container(self, cb: Any) -> _Kinds:
        return self._select("container", cb)

    def apply(self, cb: Any) -> _Kinds:
        return self._select("apply", cb)

    def any(self, cb: Any) -> _Kinds:
        return self._select("any", cb)


# --- Builders ---


class _Builder(_Unassignable, Generic[D]):
    """A writable `Visitors.OfObject` over a meta-schema (`_meta`, a name in `Meta`), building its data (`_data`).
    Read-only, it reads the data it is given and refuses every write: a referent read through a link is."""

    _data: ClassVar[type]
    _meta: ClassVar[str]
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
        """Writes `source`'s fields into `target`, copying the containers it holds, never the objects they reference;
        the number of fields that held something else."""
        changed = 0
        for field_ in dataclasses.fields(source):  # type: ignore[arg-type]
            old, new = getattr(target, field_.name), getattr(source, field_.name)
            changed += old is not new
            setattr(target, field_.name, S._copy(new))
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

    def _edited(self) -> D:
        """A referent edited through its link: updated, as a reference object is."""
        return self.update()

    def _check(self) -> None:
        if not self._writable:
            raise ReadOnlyError(f"{self._noun} read through a link is read-only; write it by calling the link with a "
                                "callback")

    def _write(self, prop: _Prop, value: Any) -> None:
        self._check()
        prop.put(self._working, value)
        self._written.append(prop)

    def as_schema(self) -> Any:
        return getattr(Meta, self._meta, None)

    def as_identity(self, identity: str | None = None) -> Any:
        """None: a schema object is given its identity by the store that holds it, and this one is held by none."""
        if identity is not None:
            raise TypeError(f"{self._noun} is given its identity by the store that holds it")
        return None

    def _ordered(self, kind: type, declared: str) -> list[str]:
        """The names of the members of `kind`, in the order the meta-schema declares them (its `declared` dict)."""
        meta = self.as_schema()
        names = [name for name, member in self._members_.items() if isinstance(member, kind)]
        order = list(getattr(meta, declared, {}))
        return sorted(names, key=lambda name: order.index(name) if name in order else len(order))

    @property
    def as_properties(self) -> _Properties:
        present = [getattr(self, name) for name in self._ordered(_Prop, "properties")
                   if self._members_[name].get(self._working) is not None]
        return _Properties(self, present)

    def as_adjacencies(self, cb: Any) -> Any:
        for name in self._ordered(_Members, "adjacencies"):
            _visit(cb, getattr(self, name))
        return self

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return _Empty(f"{name!r} is not a member of {self._noun}'s builder")

    def __repr__(self) -> str:
        return f"<builder of {self._noun}>"


def _type(field: str = "type") -> _Members:
    """The adjacency to the schema something has as its type, of any kind (`Schemas.Typing`)."""
    return _Members("schema", accepts=_is_schema, build="kinds", **_one(field))


class _KindBuilder(_Builder[D]):
    """A builder of a kind of schema: named, described, and parametric. Its identity is its name, a global one."""

    name = _Prop()
    description = _Prop()
    parameters = _Members("parameter", accepts=lambda v: isinstance(v, S.OfParameter.Data),
                          build=lambda: ParameterBuilder, **_by_name("parameters"))

    def as_identity(self, identity: str | None = None) -> Any:
        """The schema's identity, its global name: read, or written (as `name`)."""
        if identity is not None:
            self._write(_KindBuilder.__dict__["name"], identity)
        return self._working.name


# --- Builders of members ---


class _TypedBuilder(_Builder[D]):
    """A builder of a member with a name and a type: a property, a parameter, a symbol, a branch or a part."""

    name = _Prop()
    description = _Prop()
    type = _type()


class PropertyBuilder(_TypedBuilder[S.OfProperty.Data]):
    _data, _meta, _noun = S.OfProperty.Data, "Property", "a property"


class ParameterBuilder(_TypedBuilder[S.OfParameter.Data]):
    _data, _meta, _noun = S.OfParameter.Data, "Parameter", "a parameter"


class SymbolBuilder(_TypedBuilder[S.OfSymbol.Data]):
    _data, _meta, _noun = S.OfSymbol.Data, "Symbol", "a symbol"


class MemberBuilder(_TypedBuilder[S.OfUnion.Branch]):
    """A union's branch or an intersection's part."""

    _data, _meta, _noun = S.OfUnion.Branch, "Member", "a branch or a part"


def _filled(data: S.OfAdjacency.Data) -> list[Any]:
    """The link an adjacency fills: its relation's link of that name."""
    if not data.me:
        return []
    links = data.relation.entry.links if data.relation is not None else {}
    return [links.get(data.me) or S.OfSymbol.Data(data.me)]


class AdjacencyBuilder(_Builder[S.OfAdjacency.Data]):
    _data, _meta, _noun = S.OfAdjacency.Data, "Adjacency", "an adjacency"

    name = _Prop()
    description = _Prop()
    relation = _Members("relation", accepts=lambda v: isinstance(v, S.OfRelation.Data), build=lambda: RelationBuilder,
                        **_one("relation"))
    me = _Members("link", accepts=lambda v: isinstance(v, S.OfSymbol.Data), items=_filled, one=True,
                  store=lambda data, links: setattr(data, "me", links[-1].name if links else ""))


@dataclass(eq=False)
class _ArgumentData:
    """An application's argument, as its builder reads it: `Schemas.OfApply.Data.arguments` holds its value or term
    under its parameter's name."""

    parameter: Any = None  # OfParameter.Data
    value: Any = None  # a scalar value or a term


class ArgumentBuilder(_Builder[_ArgumentData]):
    _data, _meta, _noun = _ArgumentData, "Argument", "an argument"

    value = _Prop(get=lambda data: None if S._is_term(data.value) else data.value)
    parameter = _Members("parameter", accepts=lambda v: isinstance(v, S.OfParameter.Data), **_one("parameter"))
    term = _Members("term", accepts=S._is_term, build=lambda: FormBuilder, one=True,
                    items=lambda data: [data.value] if S._is_term(data.value) else [],
                    store=lambda data, terms: setattr(data, "value", terms[-1] if terms else None))


@dataclass(eq=False)
class _UniqueData:
    """A relation's `unique` clause, as its builder reads it: `Schemas.OfRelation.Data.uniques` holds the names of
    the links and properties it names."""

    named: list[Any] = field(default_factory=list)  # OfSymbol.Data and OfProperty.Data


class UniqueBuilder(_Builder[_UniqueData]):
    _data, _meta, _noun = _UniqueData, "Unique", "a unique clause"

    named = _Members("named", accepts=lambda v: isinstance(v, (S.OfSymbol.Data, S.OfProperty.Data)),
                     **_in_order("named"))


@dataclass
class _FormWorking:
    """A form being built: `Schemas.Form.Data` is immutable."""

    kind: str = ""
    attributes: dict[str, Any] = field(default_factory=dict)
    arguments: tuple[Any, ...] = ()
    dialect: str | None = None


class FormBuilder(_Builder[_FormWorking]):
    """A term in its neutral form. A form is immutable, so a form edited through a link is a new one."""

    _data, _meta, _noun = S.Form.Data, "Form", "a form"

    dialect = _Prop()
    kind = _Prop()
    attributes = _Prop(container=True)
    operands = _Members("operand", accepts=S._is_term, build=lambda: FormBuilder, **_in_order("arguments"))

    def _make(self) -> Any:
        return _FormWorking()

    def _update(self, target: Any, source: Any) -> int:
        for name in ("kind", "attributes", "arguments", "dialect"):
            setattr(target, name, S._copy(getattr(source, name)))
        return 4

    def _finalize(self, target: Any) -> Any:
        return S.Form.Data(target.kind, dict(target.attributes), tuple(target.arguments), target.dialect)

    def update(self) -> Any:
        raise TypeError("a form is immutable; use clone()")

    def _edited(self) -> Any:
        return self.clone()


# --- Builders of kinds ---


def _width(field_: str) -> _Members:
    """A width, a term (`Schemas.BitWidth`); one the data holds as an int reads as a literal form."""

    def items(data: Any) -> list[Any]:
        width = getattr(data, field_)
        return [] if width is None else [S.Form.Data("literal", {"value": width})] if type(width) is int else [width]

    def store(data: Any, terms: list[Any]) -> None:
        term = terms[-1] if terms else None
        literal = (isinstance(term, S.Form.Data) and term.kind == "literal" and not term.arguments
                   and set(term.attributes) == {"value"} and type(term.attributes["value"]) is int)
        setattr(data, field_, term.attributes["value"] if literal else term)

    return _Members("width", accepts=S._is_term, build=lambda: FormBuilder, items=items, store=store, one=True)


def _refines() -> _Members:
    return _Members("refined", accepts=_is_schema, build="kinds", **_one("refines"))


class ScalarBuilder(_KindBuilder[S.OfScalar.Data]):
    """A refinement takes the token of what it refines, unless it is given one."""

    _data, _meta, _noun = S.OfScalar.Data, "Scalar", "a scalar schema"

    format = _Prop(get=lambda data: data.token.format if isinstance(data.token, S.OfScalar.Token) else None,
                   put=lambda data, value: setattr(data, "token", S.OfScalar.Token(
                       value, data.token.name if isinstance(data.token, S.OfScalar.Token) else "")))
    token = _Prop(get=lambda data: data.token.name if isinstance(data.token, S.OfScalar.Token) else None,
                  put=lambda data, value: setattr(data, "token", S.OfScalar.Token(
                      data.token.format if isinstance(data.token, S.OfScalar.Token) else S.BASIC, value)))
    refines = _refines()
    bits = _width("bits")
    bytes = _width("bytes")

    def _finalize(self, target: S.OfScalar.Data) -> S.OfScalar.Data:
        base = S.structure(target.refines)
        if target.token is None and isinstance(base, S.OfScalar.Data):
            target.token = base.token
        return target


class ObjectBuilder(_KindBuilder[S.OfObject.Data]):
    """A refinement of a reference object schema is one too, and has the members of what it refines."""

    _data, _meta, _noun = S.OfObject.Data, "Object", "an object schema"

    ref = _Prop()
    pattern = _Prop()
    singleton = _Prop()
    refines = _refines()
    properties = _Members("property", accepts=lambda v: isinstance(v, S.OfProperty.Data),
                          build=lambda: PropertyBuilder, **_by_name("properties"))
    adjacencies = _Members(  # named ones by name, then anonymous ones, which have none
        "adjacency", accepts=lambda v: isinstance(v, S.OfAdjacency.Data), build=lambda: AdjacencyBuilder,
        items=lambda data: [*data.adjacencies.values(), *data.anonymous],
        store=lambda data, members: (setattr(data, "adjacencies", {m.name: m for m in members if m.name}),
                                     setattr(data, "anonymous", [m for m in members if not m.name])))

    def _finalize(self, target: S.OfObject.Data) -> S.OfObject.Data:
        base = S.structure(target.refines)
        if isinstance(base, S.OfObject.Data) and base.ref:
            target.ref = True
        return S._settle(target)


class UnionBuilder(_KindBuilder[S.OfUnion.Data]):
    _data, _meta, _noun = S.OfUnion.Data, "Union", "a union"

    flat = _Prop()
    branches = _Members("branch", accepts=lambda v: isinstance(v, S.OfUnion.Branch), build=lambda: MemberBuilder,
                        **_in_order("branches"))


class IntersectionBuilder(_KindBuilder[S.OfIntersection.Data]):
    _data, _meta, _noun = S.OfIntersection.Data, "Intersection", "an intersection"

    flat = _Prop()
    parts = _Members("part", accepts=lambda v: isinstance(v, S.OfIntersection.Part), build=lambda: MemberBuilder,
                     **_in_order("parts"))


class ContainerBuilder(_KindBuilder[S.OfContainer.Data]):
    """A refinement takes the index and element of what it refines, unless it is given them."""

    _data, _meta, _noun = S.OfContainer.Data, "Container", "a container schema"

    layout = _Prop()  # "dense", "sparse", or None
    refines = _refines()
    index = _Members("index", accepts=_is_schema, build="kinds", **_one("index"))
    element = _Members("element", accepts=_is_schema, build="kinds", **_one("element"))

    def _finalize(self, target: S.OfContainer.Data) -> S.OfContainer.Data:
        base = S.structure(target.refines)
        if isinstance(base, S.OfContainer.Data):
            target.index = base.index if target.index is None else target.index
            target.element = base.element if target.element is None else target.element
        return target


def _arguments(data: S.OfApply.Data) -> list[_ArgumentData]:
    parameters = getattr(S.structure(data.of), "parameters", {})
    return [_ArgumentData(parameters.get(name) or S.OfParameter.Data(name), value)
            for name, value in data.arguments.items()]


class ApplyBuilder(_KindBuilder[S.OfApply.Data]):
    _data, _meta, _noun = S.OfApply.Data, "Apply", "an application"

    of = _Members("applied", accepts=_is_schema, build="kinds", **_one("of"))
    arguments = _Members("argument", accepts=lambda v: isinstance(v, _ArgumentData), build=lambda: ArgumentBuilder,
                         items=_arguments,
                         store=lambda data, members: setattr(data, "arguments",
                                                             {m.parameter.name: m.value for m in members}))


class AnyValueBuilder(_KindBuilder[S.OfAny.Value]):
    """A value of any type, or of one of `types`."""

    _data, _meta, _noun = S.OfAny.Value, "Any", "a value of any type"

    types = _Members("schema", accepts=_is_schema, build="kinds", **_in_order("types"))


class PredicateBuilder(_KindBuilder[S.OfPredicate.Data]):
    _data, _meta, _noun = S.OfPredicate.Data, "Predicate", "a predicate"

    symbols = _Members("symbol", accepts=lambda v: isinstance(v, S.OfSymbol.Data), build=lambda: SymbolBuilder,
                       **_by_name("symbols"))
    requires = _Members("term", accepts=S._is_term, build=lambda: FormBuilder, **_one("requires"))


def _uniques(data: S.OfRelation.Data) -> list[_UniqueData]:
    named = {**data.entry.links, **data.entry.properties}
    return [_UniqueData([named.get(name) or S.OfSymbol.Data(name) for name in sorted(unique, key=list(named).index
                                                                                     if unique <= set(named) else str)])
            for unique in data.uniques]


class RelationBuilder(_KindBuilder[S.OfRelation.Data]):
    """A relation's links and properties are its entries': the meta-schema has them as the relation's own."""

    _data, _meta, _noun = S.OfRelation.Data, "Relation", "a relation"

    links = _Members("link", accepts=lambda v: isinstance(v, S.OfSymbol.Data), build=lambda: SymbolBuilder,
                     items=lambda data: list(data.entry.links.values()),
                     store=lambda data, links: setattr(data.entry, "links", {m.name: m for m in links}))
    properties = _Members("property", accepts=lambda v: isinstance(v, S.OfProperty.Data), build=lambda: PropertyBuilder,
                          items=lambda data: list(data.entry.properties.values()),
                          store=lambda data, props: setattr(data.entry, "properties", {m.name: m for m in props}))
    uniques = _Members("unique", accepts=lambda v: isinstance(v, _UniqueData), build=lambda: UniqueBuilder,
                       items=_uniques,
                       store=lambda data, uniques: setattr(data, "uniques", tuple(
                           frozenset(named.name for named in unique.named) for unique in uniques)))

    def _update(self, target: S.OfRelation.Data, source: S.OfRelation.Data) -> int:
        changed = super()._update(target, source)
        target.entry = S.OfEntry.Data(dict(source.entry.links), dict(source.entry.properties))
        return changed


_KIND_BUILDERS: dict[str, tuple[type, Callable[[], type]]] = {
    "scalar": (S.OfScalar.Data, lambda: ScalarBuilder),
    "object": (S.OfObject.Data, lambda: ObjectBuilder),
    "union": (S.OfUnion.Data, lambda: UnionBuilder),
    "intersection": (S.OfIntersection.Data, lambda: IntersectionBuilder),
    "container": (S.OfContainer.Data, lambda: ContainerBuilder),
    "apply": (S.OfApply.Data, lambda: ApplyBuilder),
    "any": (S.OfAny.Value, lambda: AnyValueBuilder),
}
"""The kinds of schema a link to a type links, each its data and its builder, by `_Kinds`' branch."""

_BUILDERS: dict[type, type] = {
    S.OfScalar.Data: ScalarBuilder, S.OfObject.Data: ObjectBuilder, S.OfUnion.Data: UnionBuilder,
    S.OfIntersection.Data: IntersectionBuilder, S.OfContainer.Data: ContainerBuilder, S.OfApply.Data: ApplyBuilder,
    S.OfAny.Value: AnyValueBuilder, S.OfPredicate.Data: PredicateBuilder, S.OfRelation.Data: RelationBuilder,
    S.OfProperty.Data: PropertyBuilder, S.OfParameter.Data: ParameterBuilder, S.OfSymbol.Data: SymbolBuilder,
    S.OfUnion.Branch: MemberBuilder, S.OfAdjacency.Data: AdjacencyBuilder, _ArgumentData: ArgumentBuilder,
    _UniqueData: UniqueBuilder, S.Form.Data: FormBuilder,
}


def _builder_for(referent: Any) -> type | None:
    """The builder of a referent's data; None for a term of a dialect, which this package does not build."""
    return _BUILDERS.get(type(referent))


_VALUES = (_PropertyMember, _Value, _ScalarVisitor, _Mapping, _AdjacencyMember, _Entry, _Link, _Kinds, _Builder, _Empty,
           _Properties)
"""The classes whose instances are values, not the callable form of a Spec, though some are callable."""


# --- The meta-schemas: schema objects, each a reference object, and the relations between them ---


class Meta:
    """The meta-schemas, by name: `Meta.Object` is `Schemas.Object`, and so on."""


Text, Bool = S.OfScalar.Data(str), S.OfScalar.Data(bool)


def _prop(name: str, schema: Any) -> Any:
    """A `Specs.Callback[Visitors.OfEntry]`: an entry linking a property named `name`, of `schema`."""
    return lambda e: e.property(lambda p: p.name(name).type(lambda adj: adj.insert(lambda t: t.schema(schema))))


def _object(name: str, *props: Any, refines: Any = None) -> S.OfObject.Data:
    """A meta-schema: a reference object schema, `Schemas.<name>`, with `props`, refining `refines`."""
    builder = ObjectBuilder().name(f"Schemas.{name}").ref(True).properties(lambda adj: [adj.insert(p) for p in props])
    if refines is not None:
        builder.refines(lambda adj: adj.insert(lambda e: e.refined(refines)))
    return builder.create()


Meta.Schema = _object("Schema", _prop("name", Text), _prop("description", Text))
Meta.Type = _object("Type", refines=Meta.Schema)
Meta.Scalar = _object("Scalar", _prop("format", Text), _prop("token", Text), refines=Meta.Type)
Meta.Object = _object("Object", _prop("ref", Bool), _prop("pattern", Text), _prop("singleton", Text), refines=Meta.Type)
Meta.Union = _object("Union", _prop("flat", Bool), refines=Meta.Type)
Meta.Intersection = _object("Intersection", _prop("flat", Bool), refines=Meta.Type)
Meta.Container = _object("Container", _prop("layout", Text), refines=Meta.Type)
Meta.Apply = _object("Apply", refines=Meta.Type)
Meta.Any = _object("Any", refines=Meta.Type)
Meta.Relation = _object("Relation", refines=Meta.Schema)
Meta.Predicate = _object("Predicate", refines=Meta.Schema)
Meta.Typed = _object("Typed", _prop("name", Text), _prop("description", Text))
Meta.Property = _object("Property", refines=Meta.Typed)
Meta.Parameter = _object("Parameter", refines=Meta.Typed)
Meta.Symbol = _object("Symbol", refines=Meta.Typed)
Meta.Member = _object("Member", refines=Meta.Typed)
Meta.Adjacency = _object("Adjacency", _prop("name", Text), _prop("description", Text))
Meta.Argument = _object("Argument", _prop("value", S.Form.Value))
Meta.Unique = _object("Unique")
Meta.Term = _object("Term")
Meta.Form = _object("Form", _prop("dialect", Text), _prop("kind", Text),
                    _prop("attributes", S.OfContainer.Data(index=Text, element=S.Form.Value)), refines=Meta.Term)
Meta.Module = (
    ObjectBuilder()
    .name("Schemas.Module")
    .ref(True)
    .pattern(r"module-(\d+)")
    .create()
)


def _symbol(name: str, schema: Any) -> S.OfSymbol.Data:
    return SymbolBuilder().name(name).type(lambda adj: adj.insert(lambda e: e.schema(schema))).create()


def _relation(name: str, first: S.OfSymbol.Data, second: S.OfSymbol.Data,
              determined: S.OfSymbol.Data | None = None) -> S.OfRelation.Data:
    """A meta-schema relation, `Schemas.<name>`, linking `first` and `second`, where the other determines `determined`,
    when given (a `unique` clause), else a list."""
    builder = RelationBuilder().name(f"Schemas.{name}").links(
        lambda adj: adj.insert(lambda e: e.link(first)).insert(lambda e: e.link(second)))
    if determined is not None:
        builder.uniques(lambda adj: adj.insert(
            lambda e: e.unique(lambda u: u.named(lambda n: n.insert(lambda x: x.named(determined))))))
    return builder.create()


def _adjacency(relation: S.OfRelation.Data, link: S.OfSymbol.Data, name: str | None = None) -> Any:
    """A `Specs.Callback[Visitors.OfEntry]`: an entry linking an adjacency to `relation` at `link`, named `name`, or
    anonymous."""

    def build(a: AdjacencyBuilder) -> AdjacencyBuilder:
        if name is not None:
            a.name(name)
        return a.relation(lambda adj: adj.insert(lambda e: e.relation(relation))).me(
            lambda adj: adj.insert(lambda e: e.link(link)))

    return lambda e: e.adjacency(build)


_RELATIONS: list[tuple[str, tuple[str, Any, str | None], tuple[str, Any], str]] = [
    # (relation, (link, schema, adjacency named there), (link, schema), "one": the first determines the second;
    # "owned": the second determines the first; "list": neither). An adjacency named "" is declared below, on the kinds
    # that have it, rather than on the link's schema.
    ("Typing", ("typed", Meta.Typed, "type"), ("schema", Meta.Type), "one"),
    ("Refines", ("refinement", Meta.Type, ""), ("refined", Meta.Type), "one"),
    ("Indexing", ("container", Meta.Container, "index"), ("index", Meta.Type), "one"),
    ("Containing", ("container", Meta.Container, "element"), ("element", Meta.Type), "one"),
    ("Applying", ("application", Meta.Apply, "of"), ("applied", Meta.Type), "one"),
    ("AnyOf", ("any", Meta.Any, "types"), ("schema", Meta.Type), "list"),
    ("Relating", ("adjacency", Meta.Adjacency, "relation"), ("relation", Meta.Relation), "one"),
    ("Filling", ("adjacency", Meta.Adjacency, "me"), ("link", Meta.Symbol), "one"),
    ("Binding", ("argument", Meta.Argument, "parameter"), ("parameter", Meta.Parameter), "one"),
    ("ArgumentTerm", ("argument", Meta.Argument, "term"), ("term", Meta.Term), "one"),
    ("Requires", ("predicate", Meta.Predicate, "requires"), ("term", Meta.Term), "one"),
    ("BitWidth", ("scalar", Meta.Scalar, "bits"), ("width", Meta.Term), "one"),
    ("ByteWidth", ("scalar", Meta.Scalar, "bytes"), ("width", Meta.Term), "one"),
    ("HasParameter", ("owner", Meta.Schema, "parameters"), ("parameter", Meta.Parameter), "owned"),
    ("HasProperty", ("owner", Meta.Schema, ""), ("property", Meta.Property), "owned"),
    ("HasAdjacency", ("owner", Meta.Object, "adjacencies"), ("adjacency", Meta.Adjacency), "owned"),
    ("HasBranch", ("owner", Meta.Union, "branches"), ("branch", Meta.Member), "owned"),
    ("HasPart", ("owner", Meta.Intersection, "parts"), ("part", Meta.Member), "owned"),
    ("HasSymbol", ("owner", Meta.Predicate, "symbols"), ("symbol", Meta.Symbol), "owned"),
    ("HasLink", ("owner", Meta.Relation, "links"), ("link", Meta.Symbol), "owned"),
    ("HasArgument", ("owner", Meta.Apply, "arguments"), ("argument", Meta.Argument), "owned"),
    ("HasUnique", ("owner", Meta.Relation, "uniques"), ("unique", Meta.Unique), "owned"),
    ("Naming", ("unique", Meta.Unique, "named"), ("named", Meta.Typed), "list"),
    ("Operands", ("form", Meta.Form, "operands"), ("operand", Meta.Term), "list"),
    ("Defines", ("module", Meta.Module, "schemas"), ("schema", Meta.Schema), "owned"),
]
"""Each relation between schema objects. A member belongs to one owner (`Has*`: the member determines its owner); a
schema object has at most one type, refined schema, index, element, applied schema, relation, link, parameter, term or
width (the first determines the second); types, named members, operands and definitions are lists."""

_ADJACENCIES: dict[int, list[Any]] = {}
for _name, (_a, _a_schema, _named), (_b, _b_schema), _how in _RELATIONS:
    _first, _second = _symbol(_a, _a_schema), _symbol(_b, _b_schema)
    setattr(Meta, _name, _relation(_name, _first, _second, {"one": _second, "owned": _first, "list": None}[_how]))
    if _named != "":
        _ADJACENCIES.setdefault(id(_a_schema), [_a_schema]).append(_adjacency(getattr(Meta, _name), _first, _named))
    _ADJACENCIES.setdefault(id(_b_schema), [_b_schema]).append(_adjacency(getattr(Meta, _name), _second))
for _owner in (Meta.Object, Meta.Relation):  # each has its own `properties`; any schema may be the owner
    _ADJACENCIES[id(_owner)].append(_adjacency(Meta.HasProperty, Meta.HasProperty.entry.links["owner"], "properties"))
for _scalar_object_container in (Meta.Scalar, Meta.Object, Meta.Container):  # only these refine
    _ADJACENCIES.setdefault(id(_scalar_object_container), [_scalar_object_container]).append(
        _adjacency(Meta.Refines, Meta.Refines.entry.links["refinement"], "refines"))
for _schema, *_specs in _ADJACENCIES.values():
    ObjectBuilder(_schema).adjacencies(lambda adj, specs=_specs: [adj.insert(spec) for spec in specs]).update()


# --- The namespaces, as `Schemas` gives them ---


class OfScalar:
    Data, Builder, Token, Schema = S.OfScalar.Data, ScalarBuilder, S.OfScalar.Token, Meta.Scalar


class OfObject:
    Data, Builder, Schema = S.OfObject.Data, ObjectBuilder, Meta.Object


class OfProperty:
    Data, Builder, Schema = S.OfProperty.Data, PropertyBuilder, Meta.Property


class OfAdjacency:
    Data, Builder, Schema = S.OfAdjacency.Data, AdjacencyBuilder, Meta.Adjacency


class OfRelation:
    Data, Builder, Schema = S.OfRelation.Data, RelationBuilder, Meta.Relation


class OfSymbol:
    Data, Builder, Schema = S.OfSymbol.Data, SymbolBuilder, Meta.Symbol


class OfParameter:
    Data, Builder, Schema = S.OfParameter.Data, ParameterBuilder, Meta.Parameter


class OfUnion:
    Data, Builder, Branch, Schema = S.OfUnion.Data, UnionBuilder, S.OfUnion.Branch, Meta.Union


class OfIntersection:
    Data, Builder, Part, Schema = S.OfIntersection.Data, IntersectionBuilder, S.OfIntersection.Part, Meta.Intersection


class OfContainer:
    Data, Builder, Schema = S.OfContainer.Data, ContainerBuilder, Meta.Container


class OfApply:
    Data, Builder, Schema = S.OfApply.Data, ApplyBuilder, Meta.Apply


class OfPredicate:
    Data, Builder, Schema = S.OfPredicate.Data, PredicateBuilder, Meta.Predicate


class OfAny:
    Data, Builder, Schema = S.OfAny.Value, AnyValueBuilder, Meta.Any


class Form:
    Data, Builder, Schema = S.Form.Data, FormBuilder, Meta.Form
