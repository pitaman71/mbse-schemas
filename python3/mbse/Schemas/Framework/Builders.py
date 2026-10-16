"""Builders: schema builders as visitors of their meta-schemas, which model schemas as reference objects and
relations, and the store they are built in. They replace the builders and meta-schemas in `Schemas`, which stay beside
them while call sites migrate (docs/META_SCHEMAS.md, Plan); `Schemas.OfX.Data` is unchanged.

Every schema object is a reference object: a kind of schema, and each of its members (a property, an adjacency, a
parameter, a symbol, a branch or a part, an argument), and a term. A property of a schema object holds
a value (a name, a flag, a term's attributes); every reference from one schema object to another is a relation: a
schema to its members (`Schemas.HasProperty`, ...), a member to its type (`Schemas.Typing`), a refinement to what it
refines (`Schemas.Refines`), a scalar to its widths, which are terms (`Schemas.BitWidth`), and so on (`_plain`, below):
each store builds its own (docs/proposals/store-overhaul, Levels).

Each `Schemas.OfX.Builder` is a writable `Visitors.OfObject` over its plain schema (`Schemas.OfX`), as VISITOR_PATTERN.md
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

from . import Proxies
from . import Schemas as S
from .Errors import ReadOnlyError
from .Proxies import _Dunders, _Empty, _Properties, _Unassignable

__all__ = [
    "Form",
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
    "Store",
    "extend",
    "identity_of",
]

D = TypeVar("D")


def _is_function(spec: Any) -> bool:
    """Whether a `Specs.Callback` is its callable form: not a class (a value, `int`), nor a visitor (a value too)."""
    return callable(spec) and not isinstance(spec, (type, *_VALUES, *Proxies._VALUES))


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
                 put: Callable[[Any, Any], None] | None = None, container: bool = False,
                 shorthand: Callable[[Any], Any] | None = None):
        self._field, self._get, self._put, self.container = field, get, put, container
        self.shorthand = shorthand or (lambda value: value)
        self.extension = False  # whether an extension added it: its value is held apart from the data's fields

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
            self._write(self._matched(self._prop.shorthand(cb)))
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
    """`Visitors.OfAny` over a value held where `held` reads it and `write` writes it: a scalar, or a container, or, where
    `container` is None (an element of a container not written yet), either, as it is written."""

    def __init__(self, label: str, held: Callable[[], Any], write: Callable[[Any], None], writable: bool,
                 container: bool | None, schema: Callable[[], Any]):
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
        if self._container is True:
            return self._other(cb)
        if _is_function(cb):
            _visit(cb, _ScalarVisitor(self))
        else:
            self._write(cb)
        return self

    def as_container(self, cb: Any) -> _Value:
        if self._container is False:
            return self._other(cb)
        if _is_function(cb):
            mapping = _Mapping(self)
            if self._writable and self._held() is None:  # selecting the kind writes it, empty until written further
                self._write([] if mapping._positional() else {})
            _visit(cb, mapping)
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
    """`Visitors.OfContainer` over a container a `_Value` holds: a dict, arranged as one (a form's attributes), or a list,
    by position (a relation's `uniques`, each a list of names). An element that is itself a dict or a list is visited as
    a container in turn."""

    def __init__(self, value: _Value):
        self._value = value

    def _positional(self) -> bool:
        """Whether the container holds its elements by position, as a list: as it holds them, or, empty, as its schema
        arranges them."""
        held = self._value._held()
        if isinstance(held, (list, tuple, dict)):
            return not isinstance(held, dict)
        schema = S.structure(self.as_schema())
        return isinstance(schema, S.OfContainer.Data) and schema.arrangement != "dict"

    def _items(self) -> dict[Any, Any]:
        held = self._value._held()
        return dict(enumerate(held)) if isinstance(held, (list, tuple)) else dict(held or {})

    def _element(self, index: Any) -> _Value:
        positional = self._positional()

        def write(element: Any) -> None:
            items = self._items()
            if element is None:
                items.pop(index, None)
            else:
                items[index] = element
            self._value._write([items[key] for key in sorted(items)] if positional else items)

        held = self._items().get(index)
        container = None if held is None else isinstance(held, (list, tuple, dict))
        return _Value(f"{self._value._label}[{index!r}]", lambda: self._items().get(index), write,
                      self._value._writable, container, lambda: getattr(S.structure(self.as_schema()), "element", None))

    def as_schema(self) -> Any:
        return self._value.as_schema()

    def __len__(self) -> int:
        return len(self._items())

    def at(self, index: Any) -> _Value:
        return self._element(index)

    def remove(self, index: Any) -> _Mapping:
        self._element(index).clear()
        return self

    def as_ordered(self, cb: Any) -> _Mapping:  # positions are read through `as_entries`: cb is not called
        return self

    def as_dict(self, cb: Any) -> _Mapping:  # by position: cb is not called
        if not self._positional():
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


def _check_held(builder: Any, link: str, referent: Any) -> None:
    """Refuses a link, from a schema object built in a store, to a schema object that store does not hold: a reference
    object no store built is strictly forbidden, and one another store built is that store's (FRAMEWORK.md, Resolved)."""
    store = builder._store
    if store is not None and _builder_for(referent) is not None and not store.holds(referent):
        raise TypeError(f"link {link!r} cannot link {referent!r}: the store does not hold it; build it in the store, or "
                        "link one it holds (a basic scalar is the store's own: store.Schemas.OfInt, ...)")


class _Members:
    """A member for an adjacency of the meta-schema, whose entries link the schema object being built and, at `link`,
    another (the referent). `items` and `store` read and write the referents from and to however the data stores
    them; `accepts` says which objects `link` may link, and `build` how a callback given to it builds one: through a
    builder (a class, given lazily), or not at all (None: it links an object that exists). `one`: at most one entry,
    as a `unique` clause of its relation makes it. `keyed`: the relation's entries have one property, `name`, of string
    type, which names the referent within the schema object (the data keeps it as the referent's `name`). `owned`: each
    referent belongs to the schema object alone (keyed ones do), so that a clone of it has clones of them. `names`, for
    a keyed adjacency whose data keeps its entries' names apart from its referents (a module's), reads and writes them:
    `(name_of(data, referent), rename(data, referent, name))`. `extensible`: an extension may add entries to it, after
    those it holds (docs/SCHEMA_EXTENSION.md)."""

    name: str

    def __init__(self, link: str, *, items: Callable[[Any], list[Any]], store: Callable[[Any, list[Any]], None],
                 accepts: Callable[[Any], bool], build: Any = None, one: bool = False, keyed: bool = False,
                 owned: bool | None = None, names: tuple[Callable[..., Any], Callable[..., Any]] | None = None,
                 extensible: bool = False):
        self.link, self.items, self.store, self.accepts, self.build, self.one = link, items, store, accepts, build, one
        self.keyed, self.owned, self.extensible = keyed, keyed if owned is None else owned, extensible
        self.extension: tuple[Any, str, str] | None = None  # an extension's: its relation, its object's link, the other
        self.name_of, self.rename = names or (
            lambda data, referent: getattr(referent, "name", None) or None,
            lambda data, referent, name: setattr(referent, "name", name),
        )

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
            self._members.rename(self._builder._working, entry._referent, entry._name)
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
            item = Proxies._deref(item)
            if isinstance(item, _Entry):
                referent, name = item._referent, item._name
            else:  # every relation between schema objects has two links: the peer shorthand
                if _is_function(item):
                    them = _Them(self)
                    _visit(item, them)
                    referent, name = them._result()
                elif self._members.accepts(item):
                    referent, name = item, None
                else:
                    raise TypeError(f"link {self._members.link!r} cannot link {item!r}")
            _check_held(self._builder, self._members.link, referent)
            if self._members.keyed and name is not None:
                self._members.rename(self._builder._working, referent, name)
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
        adjacency = self._adjacency
        return adjacency._members.name_of(adjacency._builder._working, self._referent)

    def _rename(self, name: str | None) -> None:
        if name is not None and (not isinstance(name, str) or not name):
            raise TypeError(f"a name is non-empty text, got {name!r}")
        self._name = name
        if self._index is not None:  # an entry held: its referent is renamed in place
            self._adjacency._builder._check()
            self._adjacency._members.rename(self._adjacency._builder._working, self._referent, name or "")
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
        return all(_same(member.get(referent), member.get(self._referent)) if isinstance(member, _Prop) else
                   len(held := member.items(referent)) == len(wanted := member.items(self._referent))
                   and all(_same(a, b) for a, b in zip(held, wanted))
                   for member in self._template)

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
            store = self._entry._adjacency._builder._store
            self._object = builder_class(referent, True, store)
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
        if builder is None and referent is None and self._entry._adjacency._members.build is not None:
            builder = self._builder()  # nothing linked or written: a new object, with nothing but its entry's name
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
        if builder is None and Proxies._store_of(referent) is not None:
            return referent  # data, which an extension's relation links: a proxy, read-only as data instances are
        if builder is None:
            return _Empty("a term of a dialect is read through its dialect")
        return builder(referent, False, self._entry._adjacency._builder._store)  # read in the store that links it

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
            result, written = _build(members.build(), entry._referent, spec, entry._adjacency._builder._store)
            if result is not None:
                entry._relink(result, written)
            return entry
        spec = Proxies._deref(spec)
        referent = spec._entry._referent if isinstance(spec, _Link) else spec
        if not members.accepts(referent):
            raise TypeError(f"link {members.link!r} cannot link {referent!r}")
        _check_held(entry._adjacency._builder, members.link, referent)
        entry._relink(referent, None)
        return entry

    def __repr__(self) -> str:
        return f"<link {self._members().link!r}>"


def _build(builder_class: type, current: Any, cb: Any, store: Store | None = None) -> tuple[Any, list[Any]]:
    """Builds a link's referent through a builder of `builder_class` handed to `cb`: a new referent, or the one linked,
    updated where `cb` writes; with what `cb` wrote. None where it edits the one linked and writes nothing."""
    builder = builder_class(current, True, store)
    _visit(cb, builder)
    if current is not None and not builder._written:
        return None, []
    return (builder._edited() if current is not None else builder.create()), builder._written


# --- Builders ---


class _Builder(_Unassignable, Generic[D]):
    """A writable `Visitors.OfObject` over a plain schema (`_meta`, its name in `Schemas`), building its data (`_data`).
    Read-only, it reads the data it is given and refuses every write: a referent read through a link is."""

    _data: ClassVar[type]
    _meta: ClassVar[str]
    _noun: ClassVar[str]
    _members_: ClassVar[dict[str, _Prop | _Members]] = {}

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        cls._members_ = {name: member for base in reversed(cls.__mro__) for name, member in vars(base).items()
                         if isinstance(member, (_Prop, _Members))}

    def __init__(self, original: D | None = None, writable: bool = True, store: Store | None = None):
        original = Proxies._deref(original)
        if original is not None and not isinstance(original, self._data):
            raise TypeError(f"a builder of {self._noun} is given {original!r}")
        self._original, self._writable, self._store = original, writable, store
        added = store._added.get(type(self)) if store is not None else None
        if added:  # the members its store's extensions added to its plain schema: the store's own
            self._members_ = {**type(self)._members_, **added}
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
        for member in self._members_.values():  # the members an extension added, which no field holds
            if isinstance(member, _Prop) and member.extension:
                member.put(target, S._copy(member.get(source)))
            elif isinstance(member, _Members) and member.extension is not None:
                member.store(target, member.items(source, self._store))
        return changed

    def _finalize(self, target: D) -> D:
        return target

    def create(self) -> D:
        """Returns new data. Only valid without data given."""
        if self._original is not None:
            raise ValueError("create() is only valid without a source instance; use clone() or update()")
        return self._detached(self._identified(self._finalize(self._working), self._identity))

    def clone(self) -> D:
        """Returns new data, leaving the data given as it is. Only valid with data given."""
        if self._original is None:
            raise ValueError("clone() is only valid with a source instance")
        self._clone_members()
        return self._detached(self._identified(self._finalize(self._working), self._identity))

    def _detached(self, data: D) -> D:
        """`data`, finalized, which the builder no longer writes: it goes on working on a copy, so that finalizing it again
        gives other data."""
        self._working = self._make()
        self._update(self._working, data)
        return data

    def _clone_members(self) -> None:
        """A member has one owner: a clone has its own members, each cloned, with an identity of its own; those it
        shares by other means (an object schema's inherited ones) stay shared."""
        for members in self._members_.values():
            if isinstance(members, _Members) and members.owned and members.build is not None:
                shared, builder_class = self._shared(members), members.build()
                members.store(self._working, [referent if id(referent) in shared else
                                              builder_class(referent, True, self._store).clone()
                                              for referent in members.items(self._working)])

    def _shared(self, members: _Members) -> set[int]:
        """The referents of `members` a clone shares with the original rather than owns."""
        return set()

    def update(self) -> D:
        """Writes the builder's state into the data given, and returns it. Only valid with data given."""
        if self._original is None:
            raise ValueError("update() is only valid with a source instance")
        if self._store is not None:
            self._store._permit(self)
        self._update(self._original, self._working)
        return self._identified(self._finalize(self._original), self._identity or identity_of(self._original))

    def _identified(self, data: D, identity: str | None) -> D:
        """`data`, given `identity`, else one allocated: by its store, which refuses one another of its schema objects
        has, where it is built in one."""
        held = (self._store._hold(data, identity or self._allocate()) if self._store is not None
                else _identify(data, identity or self._allocate()))
        return _settle_extended(held, self._store)

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
        """Its plain schema (`Schemas.OfObject`, ...): its store's, or, outside a store, the template's."""
        return getattr(self._store._meta if self._store is not None else _TEMPLATE, self._meta, None)

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
        member = self.__dict__.get("_members_", {}).get(name)  # one its store's extensions added
        if member is not None:
            return member.__get__(self, type(self))
        return _Empty(f"{name!r} is not a member of {self._noun}'s builder")

    def __repr__(self) -> str:
        return f"<builder of {self._noun}>"


def _type(field: str = "type") -> _Members:
    """The adjacency to the schema something has as its type, its evaluation type, of any kind (`Schemas.Typing`): a
    schema that exists, such as `Schemas.OfScalar.Data(int)`."""
    return _Members("schema", accepts=_is_schema, **_one(field))


def _extension_property(name: str) -> _Prop:
    """A property an extension added to a meta-schema, held on each schema object apart from its fields."""
    member = _Prop(get=lambda data: data.__dict__.get("_extended", {}).get(name),
                   put=lambda data, value: data.__dict__.setdefault("_extended", {}).__setitem__(name, value))
    member.extension = True
    return member


def _extension_adjacency(adjacency: S.OfAdjacency.Data) -> _Members:
    """An adjacency an extension added to a meta-schema: its entries are shared with the objects they link, as a proxy's
    are, each held in the index of every object it links (Proxies' `_add_entry`). A builder writes the objects it links
    to its working copy; finalized, the schema object's entries are made to agree with them."""
    relation, me, name = adjacency.relation, adjacency.me, adjacency.name
    links = list(relation.entry.links)
    if len(links) != 2 or relation.entry.properties:
        raise TypeError(f"an extension's adjacency {name!r} is to a relation of two links and no properties, got "
                        f"{relation.name!r}")
    other = next(link for link in links if link != me)

    def items(data: Any, store: Any = None) -> list[Any]:  # a framework schema's entries are its store's
        pending = data.__dict__.get("_pending", {})
        if name in pending:
            return list(pending[name])
        return [entry._links[other] for entry in Proxies._linking(relation, me, data, store)]

    def store(data: Any, referents: list[Any]) -> None:
        data.__dict__.setdefault("_pending", {})[name] = list(referents)

    member = _Members(other, items=items, store=store, accepts=lambda value: True, extensible=True)
    member.extension = (relation, me, other)
    return member


def _settle_extended(data: Any, store: Any) -> Any:
    """Makes a schema object's entries in the relations an extension added agree with what its builder wrote, in its
    builder's store."""
    pending = data.__dict__.pop("_pending", None)
    if not pending:
        return data
    added = store._added.get(_builder_for(data), {})
    for name, referents in pending.items():
        relation, me, other = added[name].extension
        held = Proxies._linking(relation, me, data, store)
        Proxies._discard(id(relation), [e for e in held if all(e._links[other] is not r for r in referents)], store)
        for referent in referents:
            if all(e._links[other] is not referent for e in held):
                Proxies._add_entry(relation, Proxies._Entry(relation, {me: data, other: referent}, {}), store)
    return data


def _extend_builders(store: Store, before: dict[int, tuple[set[str], set[str]]]) -> None:
    """Gives each schema builder in `store` the members an extension added to its plain schema (or one it refines):
    `before` holds each plain schema's names before the extension, by its id."""
    for builder_class in set(_BUILDERS.values()):
        meta = getattr(store._meta, builder_class._meta)
        properties, adjacencies = before[id(meta)]
        added = store._added.setdefault(builder_class, {})
        members: dict[str, Any] = {name: _extension_property(name) for name in meta.properties
                                   if name not in properties and name not in builder_class._members_}
        members.update({name: _extension_adjacency(adjacency) for name, adjacency in meta.adjacencies.items()
                        if name not in adjacencies and name not in builder_class._members_})
        for name, member in members.items():
            member.__set_name__(builder_class, name)
            added[name] = member


class _KindBuilder(_Builder[D]):
    """A builder of a kind of schema: named, described, and parametric."""

    name = _Prop()
    description = _Prop()
    parameters = _Members("parameter", keyed=True, accepts=lambda v: isinstance(v, S.OfParameter.Data),
                          build=lambda: ParameterBuilder, **_by_name("parameters"))

    def _allocate(self) -> str:
        """A named schema's identity is its name, a global one; an unnamed one's, a UUID."""
        return self._working.name or super()._allocate()

    def _identified(self, data: D, identity: str | None) -> D:
        """A named schema's identity is its name, so it follows a rename, unless one is written."""
        name = getattr(data, "name", None)
        renamed = name is not None and name != getattr(self._original, "__dict__", {}).get("_named", name)
        if self._identity is None and renamed:
            identity = name
        data.__dict__["_named"] = name
        return super()._identified(data, identity)


# --- Builders of members ---


class _TypedBuilder(_Builder[D]):
    """A builder of a member with a type: a property, a parameter, a symbol, a branch or a part. Its name is the entry's
    that links it to its owner."""

    description = _Prop()
    type = _type()


class PropertyBuilder(_TypedBuilder[S.OfProperty.Data]):
    _data, _meta, _noun = S.OfProperty.Data, "OfProperty", "a property"


class ParameterBuilder(_TypedBuilder[S.OfParameter.Data]):
    _data, _meta, _noun = S.OfParameter.Data, "OfParameter", "a parameter"


class SymbolBuilder(_TypedBuilder[S.OfSymbol.Data]):
    _data, _meta, _noun = S.OfSymbol.Data, "OfSymbol", "a symbol"


class MemberBuilder(_TypedBuilder[S.OfUnion.Branch]):
    """A union's branch or an intersection's part."""

    _data, _meta, _noun = S.OfUnion.Branch, "Member", "a branch or a part"


class AdjacencyBuilder(_Builder[S.OfAdjacency.Data]):
    """An adjacency: named by the entry that links it to its object schema, or anonymous, with no name. It fills its
    relation's link `me`, by name: within a schema, its relation's links and properties are named, not referred to."""

    _data, _meta, _noun = S.OfAdjacency.Data, "OfAdjacency", "an adjacency"

    description = _Prop()
    me = _Prop()  # the name of the link it fills
    relation = _Members("relation", accepts=lambda v: isinstance(v, S.OfRelation.Data), build=lambda: RelationBuilder,
                        **_one("relation"))


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

    _data, _meta, _noun = S.OfScalar.Data, "OfScalar", "a scalar schema"

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

    _data, _meta, _noun = S.OfObject.Data, "OfObject", "an object schema"

    ref = _Prop()
    pattern = _Prop()
    singleton = _Prop()
    refines = _refines()
    # A refinement's own members: those it inherits are the refined schema's, through `refines` (Resolved: "Modules
    # write `refines` and a refinement's own members only"); finalizing settles them in again.
    properties = _Members("property", keyed=True, accepts=lambda v: isinstance(v, S.OfProperty.Data),
                          build=lambda: PropertyBuilder, extensible=True,
                          items=lambda data: [prop for name, prop in data.properties.items()
                                              if name not in S.inherited(data)[0]],
                          store=lambda data, members: setattr(data, "properties", {m.name: m for m in members}))
    adjacencies = _Members(  # named ones by name, then anonymous ones, which have none
        "adjacency", keyed=True, accepts=lambda v: isinstance(v, S.OfAdjacency.Data), build=lambda: AdjacencyBuilder,
        extensible=True, items=lambda data: [*(adjacency for name, adjacency in data.adjacencies.items()
                              if name not in S.inherited(data)[1]),
                            *(adjacency for adjacency in data.anonymous
                              if not any(adjacency is held for held in S.inherited(data)[2]))],
        store=lambda data, members: (setattr(data, "adjacencies", {m.name: m for m in members if m.name}),
                                     setattr(data, "anonymous", [m for m in members if not m.name])))

    def _update(self, target: S.OfObject.Data, source: S.OfObject.Data) -> int:
        """Also which of its members the source inherits, so that its copy settles as it did."""
        changed = super()._update(target, source)
        if "_inherited" in source.__dict__:
            target.__dict__["_inherited"] = source.__dict__["_inherited"]
        return changed

    def _finalize(self, target: S.OfObject.Data) -> S.OfObject.Data:
        base = S.structure(target.refines)
        if isinstance(base, S.OfObject.Data) and base.ref:
            target.ref = True
        return S._settle(target)

    def _shared(self, members: _Members) -> set[int]:
        """The members the original inherits from the schema it refines: a clone inherits them too."""
        properties, adjacencies, anonymous = S.inherited(self._original)
        held = self._working
        if members.name == "properties":
            return {id(held.properties[name]) for name in properties if name in held.properties}
        return ({id(held.adjacencies[name]) for name in adjacencies if name in held.adjacencies}
                | {id(adjacency) for adjacency in anonymous})


class UnionBuilder(_KindBuilder[S.OfUnion.Data]):
    _data, _meta, _noun = S.OfUnion.Data, "OfUnion", "a union"

    flat = _Prop()
    branches = _Members("branch", keyed=True, accepts=lambda v: isinstance(v, S.OfUnion.Branch), build=lambda: MemberBuilder,
                        extensible=True, **_in_order("branches"))


class IntersectionBuilder(_KindBuilder[S.OfIntersection.Data]):
    _data, _meta, _noun = S.OfIntersection.Data, "OfIntersection", "an intersection"

    flat = _Prop()
    parts = _Members("part", keyed=True, accepts=lambda v: isinstance(v, S.OfIntersection.Part), build=lambda: MemberBuilder,
                     **_in_order("parts"))


class ContainerBuilder(_KindBuilder[S.OfContainer.Data]):
    """A refinement takes the index and element of what it refines, unless it is given them."""

    _data, _meta, _noun = S.OfContainer.Data, "OfContainer", "a container schema"

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
    _data, _meta, _noun = S.OfApply.Data, "OfApply", "an application"

    of = _Members("applied", accepts=_is_schema, **_one("of"))
    arguments = _Members("argument", owned=True, accepts=lambda v: isinstance(v, _ArgumentData),
                         build=lambda: ArgumentBuilder,
                         items=_arguments,
                         store=lambda data, members: setattr(data, "arguments",
                                                             {m.parameter.name: m.value for m in members}))


class AnyValueBuilder(_KindBuilder[S.OfAny.Value]):
    """A value of any type, or of one of `types`."""

    _data, _meta, _noun = S.OfAny.Value, "OfAny", "a value of any type"

    types = _Members("schema", accepts=_is_schema, **_in_order("types"))


class PredicateBuilder(_KindBuilder[S.OfPredicate.Data]):
    _data, _meta, _noun = S.OfPredicate.Data, "OfPredicate", "a predicate"

    symbols = _Members("symbol", keyed=True, accepts=lambda v: isinstance(v, S.OfSymbol.Data), build=lambda: SymbolBuilder,
                       **_by_name("symbols"))
    requires = _Members("term", accepts=S._is_term, build=lambda: FormBuilder, **_one("requires"))


def _clauses(value: Any) -> Any:
    """`unique` clauses, each the names of links and properties: a name, one clause of one name; names, one clause; a
    list of lists of names, several clauses."""
    if value is None:
        return None
    if isinstance(value, str):
        return [[value]]
    items = list(value)
    if all(isinstance(item, str) for item in items):
        return [items]
    return [[item] if isinstance(item, str) else list(item) for item in items]


class RelationBuilder(_KindBuilder[S.OfRelation.Data]):
    """A relation's links and properties are its entries': the meta-schema has them as the relation's own. Its
    `unique` clauses name them."""

    _data, _meta, _noun = S.OfRelation.Data, "OfRelation", "a relation"

    links = _Members("link", keyed=True, accepts=lambda v: isinstance(v, S.OfSymbol.Data), build=lambda: SymbolBuilder,
                     items=lambda data: list(data.entry.links.values()),
                     store=lambda data, links: setattr(data.entry, "links", {m.name: m for m in links}))
    properties = _Members("property", keyed=True, accepts=lambda v: isinstance(v, S.OfProperty.Data), build=lambda: PropertyBuilder,
                          extensible=True, items=lambda data: list(data.entry.properties.values()),
                          store=lambda data, props: setattr(data.entry, "properties", {m.name: m for m in props}))
    uniques = _Prop(get=lambda data: [[name for name in [*data.entry.links, *data.entry.properties] if name in unique]
                                      + sorted(unique - {*data.entry.links, *data.entry.properties})
                                      for unique in data.uniques] or None,
                    put=lambda data, value: setattr(data, "uniques", tuple(frozenset(clause) for clause in value or ())),
                    shorthand=lambda value: _clauses(value), container=True)

    def _update(self, target: S.OfRelation.Data, source: S.OfRelation.Data) -> int:
        changed = super()._update(target, source)
        target.entry = S.OfEntry.Data(dict(source.entry.links), dict(source.entry.properties))
        return changed


@dataclass(eq=False)
class _ModuleData:
    """A module: the schemas and the modules it defines, each under its name within it, the last part of its path
    (`Person` in `crm`, defining `crm.Person`). Its name is its path; the store's root module has none."""

    name: str | None = None
    description: str | None = None
    parameters: dict[str, Any] = field(default_factory=dict)
    schemas: dict[str, Any] = field(default_factory=dict)


def _defined_name(data: _ModuleData, referent: Any) -> str | None:
    return next((name for name, held in data.schemas.items() if held is referent), None)


def _define(data: _ModuleData, referent: Any, name: str) -> None:
    data.__dict__.setdefault("_names", {})[id(referent)] = name


def _store_defined(data: _ModuleData, referents: list[Any]) -> None:
    names = {id(held): name for name, held in data.schemas.items()}
    names.update(data.__dict__.pop("_names", {}))
    data.schemas = {names.get(id(referent)) or _local(referent): referent for referent in referents}


def _local(schema: Any) -> str:
    """A schema's name within its module: the last part of its path."""
    return str(getattr(schema, "name", "") or "").rsplit(".", 1)[-1]


class ModuleBuilder(_KindBuilder[_ModuleData]):
    """A module, a reference object in the store, whose identity is its path: the root module's is `.`."""

    _data, _meta, _noun = _ModuleData, "OfModule", "a module"

    schemas = _Members("schema", keyed=True, owned=False, names=(_defined_name, _define), extensible=True,
                       accepts=lambda v: isinstance(v, (*S._KINDS, S.OfRelation.Data, S.OfPredicate.Data, _ModuleData)),
                       items=lambda data: list(data.schemas.values()), store=_store_defined)

    def _allocate(self) -> str:
        return self._working.name or "."


_BUILDERS: dict[type, type] = {
    S.OfScalar.Data: ScalarBuilder, S.OfObject.Data: ObjectBuilder, S.OfUnion.Data: UnionBuilder,
    S.OfIntersection.Data: IntersectionBuilder, S.OfContainer.Data: ContainerBuilder, S.OfApply.Data: ApplyBuilder,
    S.OfAny.Value: AnyValueBuilder, S.OfPredicate.Data: PredicateBuilder, S.OfRelation.Data: RelationBuilder,
    S.OfProperty.Data: PropertyBuilder, S.OfParameter.Data: ParameterBuilder, S.OfSymbol.Data: SymbolBuilder,
    S.OfUnion.Branch: MemberBuilder, S.OfAdjacency.Data: AdjacencyBuilder, _ArgumentData: ArgumentBuilder,
    S.Form.Data: FormBuilder, _ModuleData: ModuleBuilder,
}


def _kind(data: Any) -> str:
    """The name of a schema object's meta-schema, `Schemas.OfObject`: the kind its identity is unique within."""
    builder = _builder_for(data)
    return f"Schemas.{builder._meta}" if builder is not None else type(data).__name__


def _dialect_term(visitor: Any) -> Any:
    """The term of a dialect a link visitor reads, which this package does not build and no store holds; None for any
    other visitor."""
    referent = visitor._entry._referent if isinstance(visitor, _Link) else None
    data = referent is not None and Proxies._store_of(referent) is not None  # a proxy, which answers any member name
    return referent if referent is not None and not data and _builder_for(referent) is None and S._is_term(referent) else None


def _builder_for(referent: Any) -> type | None:
    """The builder of a referent's data; None for a term of a dialect, which this package does not build."""
    return _BUILDERS.get(type(referent))


_VALUES = (_PropertyMember, _Value, _ScalarVisitor, _Mapping, _AdjacencyMember, _Entry, _EntryName, _Them, _Chained,
           _Link, _Builder, _Empty, _Properties)
"""The classes whose instances are values, not the callable form of a Spec, though some are callable."""


# --- The meta-schemas: schema objects, each a reference object, and the relations between them ---


class _Plain:
    """A store's plain schemas of schemas (level 2) and its basic scalars, each its own (docs/proposals/store-overhaul,
    Levels): `OfObject` is `Schemas.OfObject`, `OfInt` is `Schemas.OfInt`, `Typing` the relation `Schemas.Typing`."""


def _plain() -> _Plain:
    """Builds a store's plain schemas of schemas and its basic scalars, anew."""
    meta = _Plain()
    # The basic scalars, named after the basic tokens (FRAMEWORK.md, Resolved: "Schemas.OfBool, Schemas.OfInt, ... no
    # need to invent an alternate convention").
    meta.OfBool = ScalarBuilder().name("Schemas.OfBool").token("bool").create()
    meta.OfInt = ScalarBuilder().name("Schemas.OfInt").token("int").create()
    meta.OfFloat = ScalarBuilder().name("Schemas.OfFloat").token("float").create()
    meta.OfStr = ScalarBuilder().name("Schemas.OfStr").token("str").create()
    meta.OfBytes = ScalarBuilder().name("Schemas.OfBytes").token("bytes").create()
    Text, Bool, Int = meta.OfStr, meta.OfBool, meta.OfInt

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

    meta.Schema = _object("Schema", {"name": Text, "description": Text})
    meta.Type = _object("Type", refines=meta.Schema)
    meta.OfScalar = _object("OfScalar", {"format": Text, "token": Text}, refines=meta.Type)
    meta.OfObject = _object("OfObject", {"ref": Bool, "pattern": Text, "singleton": Text}, refines=meta.Type)
    meta.OfUnion = _object("OfUnion", {"flat": Bool}, refines=meta.Type)
    meta.OfIntersection = _object("OfIntersection", {"flat": Bool}, refines=meta.Type)
    meta.OfContainer = _object("OfContainer", {"layout": Text}, refines=meta.Type)
    meta.OfApply = _object("OfApply", refines=meta.Type)
    meta.OfAny = _object("OfAny", refines=meta.Type)
    meta.OfRelation = _object("OfRelation", {"uniques": ContainerBuilder().index([Int]).element([
        ContainerBuilder().index([Int]).element([Text]).create()]).create()}, refines=meta.Schema)
    meta.OfPredicate = _object("OfPredicate", refines=meta.Schema)
    meta.Typed = _object("Typed", {"description": Text})
    meta.OfProperty = _object("OfProperty", refines=meta.Typed)
    meta.OfParameter = _object("OfParameter", refines=meta.Typed)
    meta.OfSymbol = _object("OfSymbol", refines=meta.Typed)
    meta.Member = _object("Member", refines=meta.Typed)
    meta.OfAdjacency = _object("OfAdjacency", {"description": Text, "me": Text})
    Scalars = AnyValueBuilder().create()  # a scalar of any type, written tagged with its token (`{"int": 8}`)
    meta.Argument = _object("Argument", {"value": Scalars})
    meta.Term = _object("Term")
    meta.Form = _object("Form", {"dialect": Text, "kind": Text,
                                 "attributes": ContainerBuilder().index([Text]).element([Scalars]).create()},
                        refines=meta.Term)
    meta.OfModule = _object("OfModule", refines=meta.Schema)  # its identity is its path; it defines schemas and modules

    def _relation(name: str, links: tuple[str, str], how: str) -> S.OfRelation.Data:
        """A meta-schema relation, `Schemas.<name>`, with `links`, its first and second, constrained as `how` says (see
        `relations`): a keyed relation's entries have `name`; the member determines its owner and its name
        (`unique(owner, name)`), and the owner and the name determine the member (`unique(member)`)."""
        first, second = links
        builder = RelationBuilder().name(f"Schemas.{name}").links([lambda t, n=n: t.name(n) for n in links])
        if how == "keyed":
            builder.properties([lambda t: t.name("name").type([Text])])
        determined = {"one": [[second]], "owned": [[first]], "keyed": [[first, "name"], [second]], "list": None}[how]
        return builder.uniques(determined).create()

    def _adjacency(relation: S.OfRelation.Data, link: str) -> S.OfAdjacency.Data:
        """An adjacency to `relation` filling `link`: named by the entry that links it to its object schema, or anonymous."""
        return AdjacencyBuilder().relation([relation]).me(link).create()

    relations: list[tuple[str, tuple[str, Any, str | None], tuple[str, Any], str]] = [
        # (relation, (link, schema, adjacency named there), (link, schema), "one": the first determines the second;
        # "owned": the second determines the first; "keyed": owned, and named within its owner by the entry's `name`;
        # "list": neither). An adjacency named "" is declared below, on the kinds that have it, rather than on the link's
        # schema.
        ("Typing", ("typed", meta.Typed, "type"), ("schema", meta.Type), "one"),
        ("Refines", ("refinement", meta.Type, ""), ("refined", meta.Type), "one"),
        ("Indexing", ("container", meta.OfContainer, "index"), ("index", meta.Type), "one"),
        ("Containing", ("container", meta.OfContainer, "element"), ("element", meta.Type), "one"),
        ("Applying", ("application", meta.OfApply, "of"), ("applied", meta.Type), "one"),
        ("AnyOf", ("any", meta.OfAny, "types"), ("schema", meta.Type), "list"),
        ("Relating", ("adjacency", meta.OfAdjacency, "relation"), ("relation", meta.OfRelation), "one"),
        ("Binding", ("argument", meta.Argument, "parameter"), ("parameter", meta.OfParameter), "one"),
        ("ArgumentTerm", ("argument", meta.Argument, "term"), ("term", meta.Term), "one"),
        ("Requires", ("predicate", meta.OfPredicate, "requires"), ("term", meta.Term), "one"),
        ("BitWidth", ("scalar", meta.OfScalar, "bits"), ("width", meta.Term), "one"),
        ("ByteWidth", ("scalar", meta.OfScalar, "bytes"), ("width", meta.Term), "one"),
        ("HasParameter", ("owner", meta.Schema, "parameters"), ("parameter", meta.OfParameter), "keyed"),
        ("HasProperty", ("owner", meta.Schema, ""), ("property", meta.OfProperty), "keyed"),
        ("HasAdjacency", ("owner", meta.OfObject, "adjacencies"), ("adjacency", meta.OfAdjacency), "keyed"),
        ("HasBranch", ("owner", meta.OfUnion, "branches"), ("branch", meta.Member), "keyed"),
        ("HasPart", ("owner", meta.OfIntersection, "parts"), ("part", meta.Member), "keyed"),
        ("HasSymbol", ("owner", meta.OfPredicate, "symbols"), ("symbol", meta.OfSymbol), "keyed"),
        ("HasLink", ("owner", meta.OfRelation, "links"), ("link", meta.OfSymbol), "keyed"),
        ("HasArgument", ("owner", meta.OfApply, "arguments"), ("argument", meta.Argument), "owned"),
        ("Operands", ("form", meta.Form, "operands"), ("operand", meta.Term), "list"),
        ("Defines", ("module", meta.OfModule, "schemas"), ("schema", meta.Schema), "keyed"),
    ]
    """Each relation between schema objects. A member belongs to one owner (`Has*`: the member determines its owner); a
    schema object has at most one type, refined schema, index, element, applied schema, relation, parameter, term or width
    (the first determines the second); types and operands are lists."""

    declared: dict[int, tuple[S.OfObject.Data, dict[str, S.OfAdjacency.Data], list[S.OfAdjacency.Data]]] = {}

    def _declare(schema: S.OfObject.Data, adjacency: S.OfAdjacency.Data, name: str | None = None) -> None:
        named, anonymous = declared.setdefault(id(schema), (schema, {}, []))[1:]
        if name is None:
            anonymous.append(adjacency)
        else:
            named[name] = adjacency

    for name, (a, a_schema, named_at), (b, b_schema), how in relations:
        setattr(meta, name, _relation(name, (a, b), how))
        if named_at != "":
            _declare(a_schema, _adjacency(getattr(meta, name), a), named_at)
        _declare(b_schema, _adjacency(getattr(meta, name), b))
    for owner in (meta.OfObject, meta.OfRelation):  # each has its own `properties`; any schema may be the owner
        _declare(owner, _adjacency(meta.HasProperty, "owner"), "properties")
    for refining in (meta.OfScalar, meta.OfObject, meta.OfContainer):  # only these refine
        _declare(refining, _adjacency(meta.Refines, "refinement"), "refines")
    for schema, by_name, unnamed in declared.values():
        (
            ObjectBuilder(schema)
            .adjacencies([lambda t, n=n, a=a: t.name(n).adjacency(a) for n, a in by_name.items()])
            .adjacencies(unnamed)
            .update()
        )
    return meta


_TEMPLATE: _Plain | None = None
"""The plain schemas a builder outside any store reads its own from (`as_schema`), which no store holds."""
_TEMPLATE = _plain()


# --- A store: where schema objects and data are built ---


_META_BUILDERS: dict[str, Callable[[], type]] = {
    "OfScalar": lambda: ScalarBuilder, "OfObject": lambda: ObjectBuilder, "OfUnion": lambda: UnionBuilder,
    "OfIntersection": lambda: IntersectionBuilder, "OfContainer": lambda: ContainerBuilder, "OfApply": lambda: ApplyBuilder,
    "OfAny": lambda: AnyValueBuilder, "OfRelation": lambda: RelationBuilder, "OfPredicate": lambda: PredicateBuilder,
    "OfProperty": lambda: PropertyBuilder, "OfParameter": lambda: ParameterBuilder, "OfSymbol": lambda: SymbolBuilder,
    "Member": lambda: MemberBuilder, "OfAdjacency": lambda: AdjacencyBuilder, "Form": lambda: FormBuilder,
    "OfModule": lambda: ModuleBuilder, "Argument": lambda: ArgumentBuilder,
}
"""The schema objects a store builds as `store.Schemas.OfX(...)` (and `Schemas.Member`, `.Form`, `.Argument`),
each through its builder."""


class Store(Proxies._Store):
    """A store of schema objects and data. No reference object is built outside a store, a schema object included.

    The canonical form of building is `store.moduleName.[...moduleName].schemaName(...)`, each part of a schema's name
    an attribute: `store.Schemas.OfObject(...)` builds an object schema, `store.crm.Contact(...)` a contact. Called with
    a `Specs.Callback[Visitors.OfX]`, it creates an object; with an object and a callback, it updates the object; with
    an object alone, it clones it. It returns the object. A schema object built here, and each member built with it, is
    given its identity by the store, which refuses one it holds another with; a named schema is registered under its
    name, so that the store builds its objects next.

    A store is made holding its own plain schemas of schemas (`Schemas.OfObject`, ...), basic scalars (`Schemas.OfInt`,
    ...) and mutation schemas, which no other store shares (docs/SCHEMA_EXTENSION.md, Decided, 23); it changes them, as
    any schema it holds before an extension begins, only through `extend`, which only adds members."""

    def __init__(self) -> None:
        super().__init__()
        self._objects: dict[tuple[str, str], Any] = {}  # the schema objects, by their kind and their identity
        from . import Mutations

        self._meta = _plain()  # its plain schemas of schemas and basic scalars, its own
        self._mutations = Mutations.schemas(self._meta.OfStr, self._meta.OfInt)
        for schema in (*vars(self._meta).values(), *vars(self._mutations).values()):
            self._objects[(_kind(schema), identity_of(schema))] = schema
            self._register(schema)
        self._framework: set[int] = {id(schema) for schema in self._objects.values()}
        self._added: dict[type, dict[str, Any]] = {}  # the members its extensions added to builders, by builder class
        self._extending: set[int] | None = None  # the schema objects held when an extension began, while it runs
        self._modules: dict[str, _ModuleData] = {}  # by path; the root module's is ""
        self._placed: dict[int, tuple[_ModuleData, str]] = {}  # each schema's module, and its name there
        self._linked: dict[int, Any] = {}  # the unnamed schema objects given an identity by the first object to link them
        self._root = ModuleBuilder(None, True, self).create()

    def held(self, kind: str, identity: str) -> Any:
        """The schema object of `kind` (its meta-schema's name, `Schemas.OfObject`) whose identity is `identity`; None where
        the store holds none. Schema objects of different kinds may share an identity: a module and a schema its path
        names (`crm.Contact` and `crm.Contact.v2`'s module)."""
        return self._objects.get((kind, identity))

    def holds(self, data: Any) -> bool:
        """Whether the store holds the schema object `data`."""
        identity = identity_of(data)
        return identity is not None and self._objects.get((_kind(data), identity)) is data

    def module(self, path: str = "") -> _ModuleData:
        """The module whose path is `path` (`crm.sales`), made with the modules it is in where there is none; the root
        module for "". Every schema is in one: a named schema in the module its name's prefix names, the root module's
        where it has none."""
        found = self._modules.get(path)
        return found if found is not None else ModuleBuilder(None, True, self).name(path).create()

    def framework(self, schema: Any) -> bool:
        """Whether `schema` is one the store was made holding: a plain schema of schemas, a basic scalar, a mutation
        schema. It changes only through `extend`, which adds members to it."""
        return id(schema) in self._framework

    def extend(self, cb: Any) -> Store:
        """Builds and changes schemas through `cb`, given the store: a schema the store held before may only gain members
        (an object schema's properties and adjacencies, a relation's properties, a union's branches), each under a name
        it neither has nor inherits, nor a refinement of it declares; anything else about it stays as it was. What `cb`
        builds is the store's own. Refused, a change to a schema raises before it is written, but what was written before
        it stays: a refused extension is a program error."""
        held = {id(schema) for schema in self._objects.values()}
        before = {id(meta): (set(meta.properties), set(meta.adjacencies)) for meta in vars(self._meta).values()
                  if isinstance(meta, S.OfObject.Data)}
        self._extending = held
        try:
            _visit(cb, self)
        finally:
            self._extending = None
            _extend_builders(self, before)
        return self

    def _permit(self, builder: _Builder[Any]) -> None:
        """Refuses a builder's update of a schema the store was made holding outside an extension, and one that is not
        an extension of a schema the store held when an extension began."""
        original = builder._original
        if self.framework(original) and self._extending is None and _changes(builder):
            raise TypeError(f"{_shown(original)} is one of the schemas the store was made holding: extend it with "
                            "store.extend")
        if self._extending is not None and id(original) in self._extending:
            problems = _extension_problems(builder)
            if problems:
                raise TypeError(f"an extension only adds members to {_shown(original)}: it {'; '.join(problems)}")

    def _place(self, data: Any) -> None:
        """Defines a named schema, or a module, in the module its path's prefix names, under the last part of its path;
        a schema renamed moves."""
        if not S._DOTTED.match(data.name):
            return  # not a path: validation reports its name, and it is in no module until it has one
        parent_path, _, local = data.name.rpartition(".")
        parent = self.module(parent_path)
        previous = self._placed.get(id(data))
        if previous is not None:
            if previous == (parent, local):
                return
            ModuleBuilder(previous[0], True, self).schemas(lambda adv: adv.remove(lambda entry: entry.schema(data))).update()
        self._placed[id(data)] = (parent, local)
        ModuleBuilder(parent, True, self).schemas([lambda t: t.name(local).schema(data)]).update()

    def _derive(self, owner: Any, identity: str, rebuilt: bool = False) -> None:
        """Gives the schema objects `owner` holds or links that have no name of their own the identities their path from
        it derives: a member its owner's and its name (`crm.Person.age`); another, the first object's to link it and the
        adjacency (`crm.Person.tags#type`). Through an object `rebuilt` on every read (an argument), only what it builds
        derives: what it links that exists has its own owner."""
        builder_class = _builder_for(owner)
        table = {**builder_class._members_, **self._added.get(builder_class, {})} if builder_class is not None else {}
        for name, members in table.items():
            if not isinstance(members, _Members) or (rebuilt and members.build is None):
                continue
            for index, referent in enumerate(members.items(owner)):
                through = isinstance(referent, _ArgumentData)  # rebuilt on every read: what it builds derives through it
                if not through and not self._derivable(referent):
                    continue
                if members.owned:
                    local = members.name_of(owner, referent) if members.keyed else None
                    if local:
                        derived = f"{identity}.{local}"
                        clash = self._objects.get((_kind(referent), derived))
                        if clash is not None and clash is not referent:  # another member of that name (invalid)
                            derived = f"{identity}#{name}.{local}"
                    elif isinstance(referent, S.OfAdjacency.Data):  # anonymous: named by its relation and link
                        if referent.relation is None:
                            continue  # not linked yet (a log being read): it keeps the identity it was given
                        derived = f"{identity}#({referent.relation.name}.{referent.me})"
                    else:
                        derived = f"{identity}#{name}.{index}"
                elif self._linked.get(id(referent)) is referent:  # by identity: an id is reused once its object is gone
                    continue
                else:
                    derived = f"{identity}#{name}" if members.one else f"{identity}#{name}.{index}"
                    self._linked[id(referent)] = referent
                if not through:
                    self._rehold(referent, derived)
                self._derive(referent, derived, through)

    def _derivable(self, referent: Any) -> bool:
        """Whether a referent takes an identity from its path: a schema object this store holds, the framework's aside,
        with no name of its own (a named schema's identity is its name)."""
        named = isinstance(referent, (*S._KINDS, S.OfRelation.Data, S.OfPredicate.Data, _ModuleData)) and referent.name
        return not named and self.holds(referent) and not self.framework(referent)

    def _rehold(self, referent: Any, identity: str) -> None:
        kind = _kind(referent)
        held = self._objects.get((kind, identity))
        if held is referent:
            return
        if held is not None:
            raise ValueError(f"a schema object with the identity {identity!r} is already in this store")
        del self._objects[(kind, identity_of(referent))]
        self._objects[(kind, identity)] = _identify(referent, identity)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return _Path(self, name)

    def _hold(self, data: Any, identity: str) -> Any:
        """Gives a schema object built here `identity`, refused where another holds it; registers a named schema. A framework
        schema, which every store holds as it is, is left so: a builder of one writes only its store's entries."""
        if self.framework(data):
            return data
        kind = _kind(data)
        held = self._objects.get((kind, identity))
        if held is not None and held is not data:
            raise ValueError(f"a schema object with the identity {identity!r} is already in this store")
        previous = identity_of(data)
        if previous is not None and self._objects.get((kind, previous)) is data:
            del self._objects[(kind, previous)]
        self._objects[(kind, identity)] = _identify(data, identity)
        if isinstance(data, (*S._KINDS, S.OfRelation.Data, S.OfPredicate.Data)):
            for name in [name for name, schema in self._schemas.items() if schema is data and name != data.name]:
                del self._schemas[name]  # renamed
            if data.name and self._schemas.get(data.name) is not data:
                self._register(data)
        if isinstance(data, _ModuleData):
            for path in [path for path, module in self._modules.items() if module is data and path != (data.name or "")]:
                del self._modules[path]  # renamed
            self._modules[data.name or ""] = data
        if isinstance(data, (*S._KINDS, S.OfRelation.Data, S.OfPredicate.Data, _ModuleData)) and data.name:
            self._place(data)
            self._derive(data, identity)
        return data

    def _build(self, name: str, args: tuple[Any, ...]) -> Any:
        if len(args) == 1 and _is_function(args[0]):
            existing, cb = None, args[0]
        elif len(args) == 1:
            existing, cb = args[0], None
        elif len(args) == 2:
            existing, cb = args
        else:
            raise TypeError(f"{name}(...) takes a callback, an object and a callback, or an object")
        existing = Proxies._deref(existing)
        kind = _META_BUILDERS.get(name[len("Schemas."):]) if name.startswith("Schemas.") else None
        if kind is not None:
            builder: Any = kind()(existing, True, self)
        elif name in self._schemas:
            builder = self.builder(name, existing)
        else:
            raise AttributeError(f"no schema registered as {name!r}")
        if cb is not None:
            _visit(cb, builder)
        if existing is None:
            return builder.create()
        return builder.update() if cb is not None else builder.clone()


def _shown(schema: Any) -> str:
    """A schema object in a message: its name, else its identity."""
    return repr(getattr(schema, "name", None) or identity_of(schema))


def _extension_problems(builder: _Builder[Any]) -> list[str]:
    """How a builder's update of the schema object it was given would do more than add members to it."""
    original, working, problems = builder._original, builder._working, []
    for name, member in builder._members_.items():
        if isinstance(member, _Prop):
            if member.get(original) != member.get(working):
                problems.append(f"changes {name!r}")
            continue
        extension = member.extension is not None  # whose entries, a framework schema's, are its builder's store's
        before = member.items(original, builder._store) if extension else member.items(original)
        added = _added(before, member.items(working))
        if added is None:
            problems.append(f"removes or replaces what {name!r} holds")
        elif added and not member.extensible:
            problems.append(f"adds to {name!r}, which an extension cannot")
        elif added and member.keyed and isinstance(original, S.OfObject.Data):
            problems += _clashes(original, [member.name_of(working, referent) for referent in added])
    if isinstance(original, S.OfObject.Data):  # a member it inherits, given again, is its own: a redeclaration
        properties, adjacencies, _ = S.inherited(original)
        problems += [f"adds {name!r}, which it inherits" for name in properties
                     if name in working.properties and working.properties[name] is not original.properties.get(name)]
        problems += [f"adds {name!r}, which it inherits" for name in adjacencies
                     if name in working.adjacencies and working.adjacencies[name] is not original.adjacencies.get(name)]
    return problems


def _changes(builder: _Builder[Any]) -> bool:
    """Whether a builder's update would change the schema object it was given, apart from the entries of the relations
    an extension added, which are its store's (a framework schema's are not the shared object's)."""
    original, working = builder._original, builder._working
    for member in builder._members_.values():
        if isinstance(member, _Prop):
            if member.get(original) != member.get(working):
                return True
        elif member.extension is None and _added(member.items(original), member.items(working)) != []:
            return True
    return False


def _added(before: list[Any], after: list[Any]) -> list[Any] | None:
    """What `after` holds besides what `before` does, which it holds in the same order, wherever the additions stand
    (an object schema's anonymous adjacencies follow its named ones); None where it lacks or replaces one."""
    added, kept = [], iter(before)
    expected = next(kept, None)
    for referent in after:
        if expected is not None and referent is expected:
            expected = next(kept, None)
        else:
            added.append(referent)
    return None if expected is not None else added


def _clashes(schema: S.OfObject.Data, names: list[Any]) -> list[str]:
    """The names an extension adds to an object schema that it has already, as a property or an adjacency, its own or
    inherited, or that a schema refining it declares."""
    problems = []
    refinements = list(schema.__dict__.get("_refinements", []))
    for refinement in refinements:
        refinements += [r for r in refinement.__dict__.get("_refinements", []) if all(r is not h for h in refinements)]
    inherited = S.inherited(schema)
    for name in (name for name in names if name):
        if name in schema.properties or name in schema.adjacencies:
            problems.append(f"adds {name!r}, which it {'inherits' if name in inherited[0] | inherited[1] else 'has'}")
        for refinement in refinements:
            own = S.inherited(refinement)
            if (name in refinement.properties and name not in own[0]) or (name in refinement.adjacencies and name not in own[1]):
                problems.append(f"adds {name!r}, which {_shown(refinement)} declares")
    return problems


class _Path(_Unassignable, Proxies._Named):
    """`store.moduleName.[...moduleName].schemaName`: a schema's name, one part per attribute; called, it builds, and
    given where an object is expected, it is the schema it names (`.type([store.Schemas.OfInt])`)."""

    def __init__(self, store: Store, name: str):
        self._store, self._name = store, name

    def __getattr__(self, part: str) -> _Path:
        if part.startswith("_"):
            raise AttributeError(part)
        return _Path(self._store, f"{self._name}.{part}")

    def __call__(self, *args: Any) -> Any:
        return self._store._build(self._name, args)

    def as_schema(self) -> Any:
        """The schema it names: `store.Schemas.OfInt.as_schema()` is the store's `Schemas.OfInt`."""
        return self._store.registered(self._name)

    def _resolve(self) -> Any:
        return self.as_schema()

    def __repr__(self) -> str:
        return f"<{self._name}>"


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
    Data, Builder = S.OfAny.Value, AnyValueBuilder


class Form:
    Data, Builder = S.Form.Data, FormBuilder


# `Schemas.OfX.Builder` is this: a schema builder is a `Visitors.OfObject` over its plain schema, its store's
# `Schemas.OfX` (FRAMEWORK.md, Resolved: "Schemas.OfX.Builder must implement Visitors.OfX").
for _namespace, _own in ((S.OfScalar, OfScalar), (S.OfObject, OfObject), (S.OfProperty, OfProperty),
                         (S.OfAdjacency, OfAdjacency), (S.OfRelation, OfRelation), (S.OfSymbol, OfSymbol),
                         (S.OfParameter, OfParameter), (S.OfUnion, OfUnion), (S.OfIntersection, OfIntersection),
                         (S.OfContainer, OfContainer), (S.OfApply, OfApply), (S.OfPredicate, OfPredicate), (S.OfAny, OfAny),
                         (S.Form, Form)):
    _namespace.Builder = _own.Builder
