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
import uuid
from collections.abc import Callable, Iterable, Iterator, Mapping
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
    "OfUnique",
    "identity_of",
]

D = TypeVar("D")


def _is_function(spec: Any) -> bool:
    """Whether a `Specs.Callback` is its callable form: not a class (a value, `int`), nor a visitor (a value too)."""
    return callable(spec) and not isinstance(spec, type) and not isinstance(spec, _VALUES)


def _visit(cb: Any, visitor: Any) -> None:
    """Hands `visitor` to a callable Spec, which reads or writes through it; its return value is the visitor's own."""
    cb(visitor)


def identity_of(data: Any) -> str | None:
    """A schema object's identity, which its builder gives it on creation; None for data no builder created."""
    return getattr(data, "__dict__", {}).get("_identity")


def _identify(data: Any, identity: str) -> Any:
    object.__setattr__(data, "_identity", identity)  # a form is frozen; its identity is not one of its fields
    return data


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
            self._write(self._matched(cb))
        return self

    def _matched(self, value: Any) -> Any:
        """A value given whole (a shorthand), whose type must match the property's exactly: a scalar of its scalar
        type; for a container, an iterable of its elements, or a map of names to them where it is arranged as a dict.
        It sets the value, merging nothing; None clears it."""
        held = S.structure(getattr(self.as_schema(), "type", None))
        if value is None or held is None:
            return value
        if isinstance(held, S.OfScalar.Data):
            items = [value]
        elif isinstance(held, S.OfContainer.Data) and held.arrangement == "dict":
            if not isinstance(value, Mapping):
                raise TypeError(f"{self._label()} holds a map, got {type(value).__name__}")
            value = dict(value)
            items = list(value.values())
        elif isinstance(held, S.OfContainer.Data):
            if isinstance(value, (str, bytes, Mapping)) or not isinstance(value, Iterable):
                raise TypeError(f"{self._label()} holds a list, got {type(value).__name__}")
            value = items = list(value)
        else:
            return value
        host = getattr(S.structure(held if isinstance(held, S.OfScalar.Data) else held.element), "type", None)
        wrong = [item for item in items if host is not None and type(item) is not host]
        if wrong:
            raise TypeError(f"{self._label()} holds {host.__name__}, got {type(wrong[0]).__name__}")
        return value

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
    builder (a class, given lazily), or not at all (None: it links an object that exists). `one`: at most one entry,
    as a `unique` clause of its relation makes it. `keyed`: the relation's entries have one property, `name`, of string
    type, which names the referent within the schema object (the data keeps it as the referent's `name`)."""

    name: str

    def __init__(self, link: str, *, items: Callable[[Any], list[Any]], store: Callable[[Any, list[Any]], None],
                 accepts: Callable[[Any], bool], build: Any = None, one: bool = False, keyed: bool = False):
        self.link, self.items, self.store, self.accepts, self.build, self.one = link, items, store, accepts, build, one
        self.keyed = keyed

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
            entry._referent, entry._name = spec._referent, spec._name
        else:
            raise TypeError(f"an entry, or a callback taking one, is expected; got {spec!r}")
        if entry._referent is None:
            raise ValueError(f"link {self._members.link!r} is not set")
        if self._members.keyed and entry._name is not None:
            entry._referent.name = entry._name
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
        """Called with a callback, it visits through it. Called with an iterable, a shorthand, each item inserted, or
        replacing the entry held where the relation allows one only: an entry (the entry shorthand), or, where the
        relation has two links (the peer shorthand), a `Specs.Callback[OfThem.Visitor]`: the object to link, or a
        callable handed `_Them`, through which it sets the entry's properties, its link, and the linked object's
        members."""
        if _is_function(spec):
            _visit(spec, self)
            return self._builder
        if isinstance(spec, (str, bytes, Mapping)) or not isinstance(spec, Iterable):
            raise TypeError(f"{self._members.name!r} takes an iterable of what it links, or of entries, or a callback "
                            f"taking the adjacency; got {spec!r}")
        self._builder._check()
        for item in spec:
            if isinstance(item, _Entry):
                referent, name = item._referent, item._name
            else:
                relation = getattr(self.as_schema(), "relation", None)
                if relation is not None and len(relation.entry.links) != 2:
                    raise TypeError(f"{self._members.name!r}: entries of {relation.name} have more than two links; give "
                                    "entries")
                if _is_function(item):
                    them = _Them(self)
                    _visit(item, them)
                    referent, name = them._result()
                elif self._members.accepts(item):
                    referent, name = item, None
                else:
                    raise TypeError(f"link {self._members.link!r} cannot link {item!r}")
            if self._members.keyed and name is not None:
                referent.name = name
            held = self._held()
            if any(other is referent for other in held):
                continue
            self._store([referent] if self._members.one else [*held, referent])
        return self._builder

    def __repr__(self) -> str:
        return f"<adjacency {self._members.name!r}>"


class _Entry(_Unassignable):
    """`Visitors.OfEntry`: one entry of an adjacency. Its link to the referent is a member (`e.property`); the link to
    the schema object being built is filled by the adjacency."""

    def __init__(self, adjacency: _AdjacencyMember, index: int | None = None, referent: Any = None):
        self._adjacency, self._index, self._referent = adjacency, index, referent
        self._template: list[Any] | None = None  # what the callback that built the referent wrote
        self._name: str | None = None  # the name written (`env.name`), where the entries are keyed

    def as_schema(self) -> Any:
        schema = self._adjacency.as_schema()
        return None if schema is None else schema.relation.entry

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name == self._adjacency._members.link:
            return _Link(self)
        if name == "name" and self._adjacency._members.keyed:
            return _EntryName(self)
        return _Empty(f"{name!r} is not a link this entry can set, nor a property of the relation")

    def _named(self) -> str | None:
        """The entry's name: the one written, else its referent's."""
        if self._name is not None:
            return self._name
        return getattr(self._referent, "name", None) or None

    def _rename(self, name: str | None) -> None:
        if name is not None and (not isinstance(name, str) or not name):
            raise TypeError(f"a name is non-empty text, got {name!r}")
        self._name = name
        if self._index is not None:  # an entry held: its referent is renamed in place
            self._adjacency._builder._check()
            self._referent.name = name or ""
            self._adjacency._store(self._adjacency._held())

    def _relink(self, referent: Any, template: list[Any] | None) -> None:
        self._referent, self._template = referent, template
        if self._index is not None:  # an entry held: the adjacency links the referent in its place
            self._adjacency._replace(self._index, referent)

    def _agrees(self, referent: Any) -> bool:
        if self._name is not None and getattr(referent, "name", None) != self._name:
            return False
        if self._referent is None:
            return True
        if self._template is None:
            return referent is self._referent
        return all(_same(prop.get(referent), prop.get(self._referent)) for prop in self._template
                   if isinstance(prop, _Prop))

    def __repr__(self) -> str:
        return f"<entry of {self._adjacency._members.name!r}>"


class _EntryName(_Dunders):
    """`Visitors.OfProperty` over an entry's name, the one property of the entries of a keyed adjacency."""

    def __init__(self, entry: _Entry):
        self._entry, self._writable = entry, entry._adjacency._builder._writable

    def _held(self) -> Any:
        return self._entry._named()

    def _scalar(self) -> Any:
        return self._held()

    def _label(self) -> str:
        return "property 'name'"

    def as_schema(self) -> Any:
        entry = self._entry.as_schema()
        return None if entry is None else entry.properties.get("name")

    def get(self) -> Any:
        return self._held()

    def as_value(self, cb: Any) -> _EntryName:
        if _is_function(cb):
            _visit(cb, _Value(self._label(), self._held, self._entry._rename, self._writable, False,
                              lambda: getattr(self.as_schema(), "type", None)))
        else:
            self._entry._rename(cb)
        return self

    def as_scalar(self, cb: Any) -> _EntryName:
        return self.as_value(lambda value: value.as_scalar(cb))

    def __call__(self, spec: Any) -> _Entry:
        if _is_function(spec):
            _visit(spec, self)
        else:
            self.as_value(spec)
        return self._entry


class _Them(_Unassignable):
    """`OfThem.Visitor`, for one item of the peer shorthand: an entry of a relation of two links, and the object it links
    (them). Its members are the entry's properties (`t.name`), its link (`t.property`, to link an object that exists),
    and the members of the object it links (`t.type`), which are written through that object's builder: a new one, or,
    where the link is set, that one, updated. Each, called, returns the visitor."""

    def __init__(self, adjacency: _AdjacencyMember):
        self._entry = _Entry(adjacency)
        self._object: _Builder[Any] | None = None

    def as_schema(self) -> Any:
        return self._entry.as_schema()

    def _builder(self) -> _Builder[Any]:
        if self._object is None:
            members = self._entry._adjacency._members
            if members.build is None:
                raise TypeError(f"link {members.link!r} links an object that exists: link it, not its members")
            builder_class, referent = members.build(), self._entry._referent
            self._object = builder_class(referent) if referent is not None else builder_class()
        return self._object

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        members = self._entry._adjacency._members
        if name == members.link or (name == "name" and members.keyed):
            return _Chained(getattr(self._entry, name), self, name == members.link)
        return _Chained(getattr(self._builder(), name), self, False)

    def _result(self) -> tuple[Any, str | None]:
        """The object linked: the one given, built, or updated; and the entry's name."""
        builder, referent = self._object, self._entry._referent
        if builder is not None and (builder._written or referent is None):
            referent = builder._edited() if builder._original is not None else builder.create()
        if referent is None:
            raise ValueError(f"link {self._entry._adjacency._members.link!r} is not set")
        return referent, self._entry._name


class _Chained(_Unassignable):
    """A member read through `_Them`: read as the member itself; called, it writes through the member and returns the
    `_Them` visitor, so that an item's clauses chain."""

    def __init__(self, member: Any, them: _Them, link: bool):
        self._member, self._them, self._link = member, them, link

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._member, name)

    def __call__(self, spec: Any) -> _Them:
        if self._link:
            if self._them._object is not None and self._them._object._written:
                raise ValueError("link the object before writing its members")
            self._them._object = None  # the members written next are the linked object's
        self._member(spec)
        return self._them


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
        self._identity: str | None = None  # the identity written (`as_identity`)
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
        return _identify(self._finalize(self._working), self._identity or self._allocate())

    def clone(self) -> D:
        """Returns new data, leaving the data given as it is. Only valid with data given."""
        if self._original is None:
            raise ValueError("clone() is only valid with a source instance")
        return _identify(self._finalize(self._working), self._identity or self._allocate())

    def update(self) -> D:
        """Writes the builder's state into the data given, and returns it. Only valid with data given."""
        if self._original is None:
            raise ValueError("update() is only valid with a source instance")
        self._update(self._original, self._working)
        return _identify(self._finalize(self._original),
                         self._identity or identity_of(self._original) or self._allocate())

    def _allocate(self) -> str:
        """The identity a schema object is given on creation, where none is written: a UUID."""
        return str(uuid.uuid4())

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
        """Read, the identity written, else the one of the data given; None for a schema object not created yet that
        none is written for. Written, the identity the object takes, and the builder: created or cloned, it is given one
        only where none is written; updated, it keeps its own unless one is written, which renames it."""
        if identity is None:
            return self._identity or identity_of(self._original)
        if not isinstance(identity, str) or not identity:
            raise TypeError(f"an identity is non-empty text, got {identity!r}")
        self._check()
        self._identity = identity
        return self

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
    """The adjacency to the schema something has as its type, its evaluation type, of any kind (`Schemas.Typing`): a
    schema that exists, such as `Schemas.OfScalar.Data(int)`."""
    return _Members("schema", accepts=_is_schema, **_one(field))


class _KindBuilder(_Builder[D]):
    """A builder of a kind of schema: named, described, and parametric."""

    name = _Prop()
    description = _Prop()
    parameters = _Members("parameter", keyed=True, accepts=lambda v: isinstance(v, S.OfParameter.Data),
                          build=lambda: ParameterBuilder, **_by_name("parameters"))

    def _allocate(self) -> str:
        """A named schema's identity is its name, a global one; an unnamed one's, a UUID."""
        return self._working.name or super()._allocate()


# --- Builders of members ---


class _TypedBuilder(_Builder[D]):
    """A builder of a member with a type: a property, a parameter, a symbol, a branch or a part. Its name is the entry's
    that links it to its owner."""

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
    """An adjacency: named by the entry that links it to its object schema, or anonymous, with no name."""

    _data, _meta, _noun = S.OfAdjacency.Data, "Adjacency", "an adjacency"

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
    return _Members("refined", accepts=_is_schema, **_one("refines"))


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
    properties = _Members("property", keyed=True, accepts=lambda v: isinstance(v, S.OfProperty.Data),
                          build=lambda: PropertyBuilder, **_by_name("properties"))
    adjacencies = _Members(  # named ones by name, then anonymous ones, which have none
        "adjacency", keyed=True, accepts=lambda v: isinstance(v, S.OfAdjacency.Data), build=lambda: AdjacencyBuilder,
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
    branches = _Members("branch", keyed=True, accepts=lambda v: isinstance(v, S.OfUnion.Branch), build=lambda: MemberBuilder,
                        **_in_order("branches"))


class IntersectionBuilder(_KindBuilder[S.OfIntersection.Data]):
    _data, _meta, _noun = S.OfIntersection.Data, "Intersection", "an intersection"

    flat = _Prop()
    parts = _Members("part", keyed=True, accepts=lambda v: isinstance(v, S.OfIntersection.Part), build=lambda: MemberBuilder,
                     **_in_order("parts"))


class ContainerBuilder(_KindBuilder[S.OfContainer.Data]):
    """A refinement takes the index and element of what it refines, unless it is given them."""

    _data, _meta, _noun = S.OfContainer.Data, "Container", "a container schema"

    layout = _Prop()  # "dense", "sparse", or None
    refines = _refines()
    index = _Members("index", accepts=_is_schema, **_one("index"))
    element = _Members("element", accepts=_is_schema, **_one("element"))

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

    of = _Members("applied", accepts=_is_schema, **_one("of"))
    arguments = _Members("argument", accepts=lambda v: isinstance(v, _ArgumentData), build=lambda: ArgumentBuilder,
                         items=_arguments,
                         store=lambda data, members: setattr(data, "arguments",
                                                             {m.parameter.name: m.value for m in members}))


class AnyValueBuilder(_KindBuilder[S.OfAny.Value]):
    """A value of any type, or of one of `types`."""

    _data, _meta, _noun = S.OfAny.Value, "Any", "a value of any type"

    types = _Members("schema", accepts=_is_schema, **_in_order("types"))


class PredicateBuilder(_KindBuilder[S.OfPredicate.Data]):
    _data, _meta, _noun = S.OfPredicate.Data, "Predicate", "a predicate"

    symbols = _Members("symbol", keyed=True, accepts=lambda v: isinstance(v, S.OfSymbol.Data), build=lambda: SymbolBuilder,
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

    links = _Members("link", keyed=True, accepts=lambda v: isinstance(v, S.OfSymbol.Data), build=lambda: SymbolBuilder,
                     items=lambda data: list(data.entry.links.values()),
                     store=lambda data, links: setattr(data.entry, "links", {m.name: m for m in links}))
    properties = _Members("property", keyed=True, accepts=lambda v: isinstance(v, S.OfProperty.Data), build=lambda: PropertyBuilder,
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


_VALUES = (_PropertyMember, _Value, _ScalarVisitor, _Mapping, _AdjacencyMember, _Entry, _EntryName, _Them, _Chained,
           _Link, _Builder, _Empty, _Properties)
"""The classes whose instances are values, not the callable form of a Spec, though some are callable."""


# --- The meta-schemas: schema objects, each a reference object, and the relations between them ---


class Meta:
    """The meta-schemas, by name: `Meta.Object` is `Schemas.Object`, and so on."""


Text, Bool = S.OfScalar.Data(str), S.OfScalar.Data(bool)


def _object(name: str, properties: dict[str, Any] | None = None, refines: Any = None) -> S.OfObject.Data:
    """A meta-schema: a reference object schema, `Schemas.<name>`, with `properties` of their schemas, by name,
    refining `refines`."""
    builder = (
        ObjectBuilder()
        .name(f"Schemas.{name}")
        .ref(True)
        .properties([lambda t, n=n, s=s: t.name(n).type([s]) for n, s in (properties or {}).items()])
    )
    if refines is not None:
        builder.refines([refines])
    return builder.create()


Meta.Schema = _object("Schema", {"name": Text, "description": Text})
Meta.Type = _object("Type", refines=Meta.Schema)
Meta.Scalar = _object("Scalar", {"format": Text, "token": Text}, refines=Meta.Type)
Meta.Object = _object("Object", {"ref": Bool, "pattern": Text, "singleton": Text}, refines=Meta.Type)
Meta.Union = _object("Union", {"flat": Bool}, refines=Meta.Type)
Meta.Intersection = _object("Intersection", {"flat": Bool}, refines=Meta.Type)
Meta.Container = _object("Container", {"layout": Text}, refines=Meta.Type)
Meta.Apply = _object("Apply", refines=Meta.Type)
Meta.Any = _object("Any", refines=Meta.Type)
Meta.Relation = _object("Relation", refines=Meta.Schema)
Meta.Predicate = _object("Predicate", refines=Meta.Schema)
Meta.Typed = _object("Typed", {"description": Text})
Meta.Property = _object("Property", refines=Meta.Typed)
Meta.Parameter = _object("Parameter", refines=Meta.Typed)
Meta.Symbol = _object("Symbol", refines=Meta.Typed)
Meta.Member = _object("Member", refines=Meta.Typed)
Meta.Adjacency = _object("Adjacency", {"description": Text})
Meta.Argument = _object("Argument", {"value": S.Form.Value})
Meta.Unique = _object("Unique")
Meta.Term = _object("Term")
Meta.Form = _object("Form", {"dialect": Text, "kind": Text,
                             "attributes": S.OfContainer.Data(index=Text, element=S.Form.Value)}, refines=Meta.Term)
Meta.Module = (
    ObjectBuilder()
    .name("Schemas.Module")
    .ref(True)
    .pattern(r"module-(\d+)")
    .create()
)


def _symbol(schema: Any) -> S.OfSymbol.Data:
    return SymbolBuilder().type([schema]).create()


def _relation(name: str, links: dict[str, S.OfSymbol.Data], how: str) -> S.OfRelation.Data:
    """A meta-schema relation, `Schemas.<name>`, with `links`, its first and second, constrained as `how` says (see
    `_RELATIONS`): a keyed relation's entries have `name`, which, with the owner, determines the member."""
    first, second = links.values()
    builder = RelationBuilder().name(f"Schemas.{name}").links([lambda t, n=n, s=s: t.name(n).link(s)
                                                                for n, s in links.items()])
    determined = {"one": [second], "owned": [first], "keyed": [first, second], "list": []}[how]
    if how == "keyed":
        builder.properties([lambda t: t.name("name").type([Text])])
    builder.uniques([UniqueBuilder().named([named]).create() for named in determined])
    return builder.create()


def _adjacency(relation: S.OfRelation.Data, link: S.OfSymbol.Data) -> S.OfAdjacency.Data:
    """An adjacency to `relation` at `link`: named by the entry that links it to its object schema, or anonymous."""
    return AdjacencyBuilder().relation([relation]).me([link]).create()


_RELATIONS: list[tuple[str, tuple[str, Any, str | None], tuple[str, Any], str]] = [
    # (relation, (link, schema, adjacency named there), (link, schema), "one": the first determines the second;
    # "owned": the second determines the first; "keyed": owned, and named within its owner by the entry's `name`;
    # "list": neither). An adjacency named "" is declared below, on the kinds that have it, rather than on the link's
    # schema.
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
    ("HasParameter", ("owner", Meta.Schema, "parameters"), ("parameter", Meta.Parameter), "keyed"),
    ("HasProperty", ("owner", Meta.Schema, ""), ("property", Meta.Property), "keyed"),
    ("HasAdjacency", ("owner", Meta.Object, "adjacencies"), ("adjacency", Meta.Adjacency), "keyed"),
    ("HasBranch", ("owner", Meta.Union, "branches"), ("branch", Meta.Member), "keyed"),
    ("HasPart", ("owner", Meta.Intersection, "parts"), ("part", Meta.Member), "keyed"),
    ("HasSymbol", ("owner", Meta.Predicate, "symbols"), ("symbol", Meta.Symbol), "keyed"),
    ("HasLink", ("owner", Meta.Relation, "links"), ("link", Meta.Symbol), "keyed"),
    ("HasArgument", ("owner", Meta.Apply, "arguments"), ("argument", Meta.Argument), "owned"),
    ("HasUnique", ("owner", Meta.Relation, "uniques"), ("unique", Meta.Unique), "owned"),
    ("Naming", ("unique", Meta.Unique, "named"), ("named", Meta.Typed), "list"),
    ("Operands", ("form", Meta.Form, "operands"), ("operand", Meta.Term), "list"),
    ("Defines", ("module", Meta.Module, "schemas"), ("schema", Meta.Schema), "keyed"),
]
"""Each relation between schema objects. A member belongs to one owner (`Has*`: the member determines its owner); a
schema object has at most one type, refined schema, index, element, applied schema, relation, link, parameter, term or
width (the first determines the second); types, named members, operands and definitions are lists."""

_NAMED: dict[int, tuple[S.OfObject.Data, dict[str, S.OfAdjacency.Data], list[S.OfAdjacency.Data]]] = {}
_ENDS: dict[str, tuple[S.OfSymbol.Data, S.OfSymbol.Data]] = {}


def _declare(schema: S.OfObject.Data, adjacency: S.OfAdjacency.Data, name: str | None = None) -> None:
    named, anonymous = _NAMED.setdefault(id(schema), (schema, {}, []))[1:]
    if name is None:
        anonymous.append(adjacency)
    else:
        named[name] = adjacency


for _name, (_a, _a_schema, _named), (_b, _b_schema), _how in _RELATIONS:
    _first, _second = _ENDS[_name] = _symbol(_a_schema), _symbol(_b_schema)
    setattr(Meta, _name, _relation(_name, {_a: _first, _b: _second}, _how))
    if _named != "":
        _declare(_a_schema, _adjacency(getattr(Meta, _name), _first), _named)
    _declare(_b_schema, _adjacency(getattr(Meta, _name), _second))
for _owner in (Meta.Object, Meta.Relation):  # each has its own `properties`; any schema may be the owner
    _declare(_owner, _adjacency(Meta.HasProperty, _ENDS["HasProperty"][0]), "properties")
for _refining in (Meta.Scalar, Meta.Object, Meta.Container):  # only these refine
    _declare(_refining, _adjacency(Meta.Refines, _ENDS["Refines"][0]), "refines")
for _schema, _by_name_, _anonymous in _NAMED.values():
    (
        ObjectBuilder(_schema)
        .adjacencies([lambda t, n=n, a=a: t.name(n).adjacency(a) for n, a in _by_name_.items()])
        .adjacencies(_anonymous)
        .update()
    )


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


class OfUnique:
    """A relation's `unique` clause."""

    Builder, Schema = UniqueBuilder, Meta.Unique


class Form:
    Data, Builder, Schema = S.Form.Data, FormBuilder, Meta.Form
