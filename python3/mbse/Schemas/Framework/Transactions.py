"""Transactions: the writes to a store, as mutation expressions over streams of frames (docs/STREAMING_QUERIES.md;
docs/OBJECT_IDENTITY.md, Decided, 38 to 97).

A pattern's `spec` says what must hold of a frame: the property values the objects its symbols bind have, and the
relation entries that link them (Decided, 76). It is written in the builders' own notation, over the frame, whose
members are the pattern's symbols, each a visitor of the object it binds that records mutations rather than writing
objects (58, 95):

    lambda _: _.bob.name("Bob").knows([_.ada])

A spec is recorded as a `Mutations.OfPattern`, plain data: for each symbol, the mutations of the object it binds, in
order. A property written is `{"as_property": {"name": ..., "mutations": [{"set": {"value": ...}}]}}`, its value as
`Plain` writes a property's; an adjacency's entries are `{"as_adjacency": {"name": ..., "mutations": [{"insert":
{"entries": [...]}}]}}`, each entry `{"mutations": [...]}` of its links (`as_link`) and properties (`as_property`), as a
log writes an entry, leaving out the object's own link. A link refers to the object another symbol binds, `{"ref":
{"symbol": "ada"}}`, to an object by its path, `{"ref": {"path": ...}}` (a schema object, a singleton or an owned
object), or defines a new object where it is linked, `{"def": {"schema": ..., "mutations": [...]}}`.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from . import Plain, Proxies
from . import Schemas as S

__all__: list[str] = []


def _recorded(store: Any, symbols: Mapping[str, Any], spec: Any) -> dict[str, list[Any]]:
    """The mutations a spec's callback records over a frame of `symbols`, by symbol (a `Mutations.OfPattern`)."""
    frame = _Frame(store, symbols)
    Proxies._visit(spec, frame)
    return {name: state.plain() for name, state in frame._states.items() if state.written}


class _Frame(Proxies._Unassignable):
    """The frame a spec is written over: its members are the pattern's symbols, each the recording visitor of the
    object it binds."""

    def __init__(self, store: Any, symbols: Mapping[str, Any]):
        object.__setattr__(self, "_store", store)
        object.__setattr__(self, "_symbols", symbols)
        object.__setattr__(self, "_states", {})

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        symbol = self._symbols.get(name)
        if symbol is None:
            return Proxies._Empty(f"{name!r} is not a symbol of the pattern")
        if symbol.schema is None:
            raise TypeError(f"symbol {name!r} has no schema: a spec writes what its object's schema declares")
        state = self._states.get(name)
        if state is None:
            state = self._states[name] = _State(self._store, symbol.schema, name)
        return _Recorder(state)

    def __repr__(self) -> str:
        return "<frame>"


class _State:
    """What a spec writes of one object: its properties' values, and the entries of its adjacencies, in order."""

    def __init__(self, store: Any, schema: Any, symbol: str | None = None):
        self.store, self.schema, self.symbol = store, schema, symbol
        self.values: dict[str, Any] = {}
        self.written: list[tuple[str, Any]] = []  # ("property", name) or ("adjacency", (name, entries)), in order

    def plain(self) -> list[Any]:
        names, members = Plain._Names(self.store), []
        for kind, what in self.written:
            if kind == "property":
                prop = self.schema.properties[what]
                read = Proxies._Property(self.values, what, prop, self.store, None, False)
                present, plain = Plain._value(read, prop.schema, names)
                verb = {"set": {"value": plain}} if present else {"clear": {}}
                members.append({"as_property": {"name": what, "mutations": [verb]}})
            else:
                name, entries = what
                members.append({"as_adjacency": {"name": name, "mutations": [
                    {"insert": {"entries": [entry.plain() for entry in entries]}}]}})
        return members


class _Recorder(Proxies._Unassignable):
    """`Visitors.OfObject` over the object a symbol binds, or one a spec defines where it is linked: its properties and
    adjacencies are members, which record what they are given."""

    def __init__(self, state: _State):
        object.__setattr__(self, "_state", state)

    def as_schema(self) -> Any:
        return self._state.schema

    @property
    def _linked_schema(self) -> Any:
        """The schema of the object it records, which a link may link (`Proxies._schema_of`)."""
        return self._state.schema

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        state = self._state
        if name in state.schema.properties:
            return _RecordedProperty(self, name)
        if name in state.schema.adjacencies:
            return _RecordedAdjacency(self, name)
        return Proxies._Empty(f"{name!r} is not a property or adjacency of {Proxies._a(Proxies._noun(state.schema))}")

    def __repr__(self) -> str:
        return f"<spec of {self._state.symbol or 'an object'}>"


class _RecordedProperty(Proxies._Unassignable):
    """A property of a recorded object: written as a builder's is (`Visitors.OfProperty`), and recorded."""

    def __init__(self, recorder: _Recorder, name: str):
        object.__setattr__(self, "_recorder", recorder)
        object.__setattr__(self, "_name", name)

    def _visitor(self) -> Proxies._Property:
        state = self._recorder._state
        return Proxies._Property(state.values, self._name, state.schema.properties[self._name], state.store,
                                 self._recorder, True, self._note)

    def _note(self) -> None:
        state = self._recorder._state
        if ("property", self._name) not in state.written:
            state.written.append(("property", self._name))

    def __call__(self, spec: Any) -> _Recorder:
        self._visitor()(spec)
        self._note()
        return self._recorder

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._visitor(), name)


class _RecordedAdjacency(Proxies._Unassignable):
    """An adjacency of a recorded object: its entries inserted, recorded. Called with a callback, it visits through it;
    with an iterable, the peer shorthand, each item an entry's callback or the object to link; with a mapping, where
    its relation has two links and one property, each item an entry keyed by that property (FRAMEWORK.md, Resolved,
    Mappings for keyed adjacencies)."""

    def __init__(self, recorder: _Recorder, name: str):
        object.__setattr__(self, "_recorder", recorder)
        object.__setattr__(self, "_name", name)
        state = recorder._state
        object.__setattr__(self, "_schema", state.schema.adjacencies[name])

    def as_schema(self) -> Any:
        return self._schema

    def _other(self) -> str:
        others = [link for link in self._schema.relation.entry.links if link != self._schema.me]
        if len(others) != 1:
            raise TypeError(f"adjacency {self._name!r}: entries of {self._schema.relation.name or 'its relation'} have "
                            "more than two links; give each entry's links")
        return others[0]

    def _record(self, entries: list[_Entry]) -> None:
        self._recorder._state.written.append(("adjacency", (self._name, entries)))

    def insert(self, spec: Any) -> _RecordedAdjacency:
        entry = _Entry(self._recorder._state.store, self._schema.relation, self._schema.me)
        Proxies._visit(spec, entry)
        self._record([entry])
        return self

    def __call__(self, spec: Any) -> _Recorder:
        if Proxies._is_function(spec):
            Proxies._visit(spec, self)
            return self._recorder
        store, relation = self._recorder._state.store, self._schema.relation
        entries = []
        if isinstance(spec, Mapping):
            keys = list(relation.entry.properties)
            if len(relation.entry.links) != 2 or len(keys) != 1:
                raise TypeError(f"adjacency {self._name!r} takes a mapping only where its relation has two links and one "
                                "property")
            for key, value in spec.items():
                entry = _Entry(store, relation, self._schema.me)
                entry._values[keys[0]] = key
                entry._give(self._other(), value)
                entries.append(entry)
        elif isinstance(spec, (str, bytes)) or not isinstance(spec, Iterable):
            raise TypeError(f"adjacency {self._name!r} takes an iterable of entries or of what it links, a mapping, or a "
                            f"callback taking the adjacency; got {spec!r}")
        else:
            for item in spec:
                entry = _Entry(store, relation, self._schema.me)
                if Proxies._is_function(item):
                    entry._other = self._other()
                    Proxies._visit(item, entry)
                else:
                    entry._link(self._other(), item)
                entries.append(entry)
        self._record(entries)
        return self._recorder


class _Entry(Proxies._Unassignable):
    """One entry a spec inserts, as the peer shorthand gives it (`OfThem.Visitor`): its properties, its link, and,
    through the link, the members of a new object it defines where the link is not given; a kind union's kinds too."""

    def __init__(self, store: Any, relation: Any, me: str):
        for name, value in (("_store", store), ("_relation", relation), ("_me", me), ("_values", {}), ("_links", {}),
                            ("_other", None)):
            object.__setattr__(self, name, value)

    def as_schema(self) -> Any:
        return self._relation.entry

    def __setattr__(self, name: str, value: Any) -> None:
        if name.startswith("_"):
            object.__setattr__(self, name, value)
        else:
            super().__setattr__(name, value)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._relation.entry.properties:
            return _EntryProperty(self, name)
        if name in self._relation.entry.links and name != self._me:
            return lambda target: self._link(name, target)
        for link in self._relation.entry.links:
            kinds = Proxies._link_kinds(self._relation, link) if link != self._me else None
            if kinds is not None and name in kinds:
                return lambda spec, link=link, kind=kinds[name]: self._define(link, kind, spec)
        if self._other is not None:
            return _Chained(getattr(_Recorder(self._defined(self._other)), name), self)
        return Proxies._Empty(f"{name!r} is not a link or property of the relation")

    def _link(self, link: str, target: Any) -> _Entry:
        """Links what `target` gives: an object another symbol binds, one a path names, or a new one a callback
        defines."""
        if Proxies._is_function(target):
            store = self._store
            kinds = Proxies._link_kinds(self._relation, link)
            if kinds is not None:
                raise TypeError(f"link {link!r} is a kind union: define through one of its kinds, {', '.join(kinds)}")
            schema = store.registered(store._filled(self._relation, link))
            return self._define(link, schema, target)
        self._links[link] = _reference(self._store, target)
        return self

    def _define(self, link: str, schema: Any, spec: Any) -> _Entry:
        Proxies._visit(spec, _Recorder(self._defined(link, schema)))
        return self

    def _defined(self, link: str, schema: Any = None) -> _State:
        """The new object the entry defines through `link`, made the first time it is written."""
        held = self._links.get(link)
        if isinstance(held, _State):
            return held
        if held is not None:
            raise ValueError(f"link {link!r} links an object a spec does not define: write its members in its own spec")
        if schema is None:
            store = self._store
            kinds = Proxies._link_kinds(self._relation, link)
            if kinds is not None:
                raise TypeError(f"link {link!r} is a kind union: define through one of its kinds, {', '.join(kinds)}")
            schema = store.registered(store._filled(self._relation, link))
        state = self._links[link] = _State(self._store, schema)
        return state

    def _give(self, link: str, value: Any) -> None:
        """A mapping's value: a callback given the entry, the key already written, or a value given to the one member
        that accepts it, the entry's link or one of the linked object's properties and adjacencies."""
        if Proxies._is_function(value):
            self._other = link
            Proxies._visit(value, self)
            return
        schema = self._store.registered(self._store._filled(self._relation, link))
        takers = [("link", link)] if Proxies._links(self._store, self._relation, link, value) else []
        takers += [("property", name) for name, prop in schema.properties.items() if Proxies._holds(prop.schema, value)]
        takers += [("adjacency", name) for name, adjacency in schema.adjacencies.items()
                   if Proxies._links_through(self._store, adjacency, value)]
        if len(takers) != 1:
            raise TypeError(f"{'no member' if not takers else 'more than one member'} of the entry takes {value!r}: "
                            "give a callback")
        kind, name = takers[0]
        if kind == "link":
            self._link(link, value)
        elif kind == "property":
            _RecordedProperty(_Recorder(self._defined(link, schema)), name)(value)
        else:
            _RecordedAdjacency(_Recorder(self._defined(link, schema)), name)([value])

    def plain(self) -> Any:
        mutations = []
        for link, held in self._links.items():
            target = {"def": {"schema": self._store.name_of(held.schema), "mutations": held.plain()}} \
                if isinstance(held, _State) else {"ref": held}
            mutations.append({"as_link": {"name": link, "mutations": [{"set": target}]}})
        names = Plain._Names(self._store)
        for name, prop in self._relation.entry.properties.items():
            read = Proxies._Property(self._values, name, prop, self._store, None, False)
            present, plain = Plain._value(read, prop.schema, names)
            if present:
                mutations.append({"as_property": {"name": name, "mutations": [{"set": {"value": plain}}]}})
        return {"mutations": mutations}


class _EntryProperty(Proxies._Unassignable):
    """A property of an entry a spec inserts."""

    def __init__(self, entry: _Entry, name: str):
        object.__setattr__(self, "_entry", entry)
        object.__setattr__(self, "_name", name)

    def __call__(self, spec: Any) -> _Entry:
        entry = self._entry
        Proxies._Property(entry._values, self._name, entry._relation.entry.properties[self._name], entry._store, entry,
                          True)(spec)
        return entry


class _Chained(Proxies._Unassignable):
    """A member of the object an entry defines, read through the entry: called, it writes, and gives back the entry, so
    that an item's clauses chain."""

    def __init__(self, member: Any, entry: _Entry):
        object.__setattr__(self, "_member", member)
        object.__setattr__(self, "_entry", entry)

    def __call__(self, spec: Any) -> _Entry:
        self._member(spec)
        return self._entry


def _reference(store: Any, target: Any) -> Any:
    """How a spec refers to an object it does not define: the symbol that binds it, or its path. A counted object has
    no path: a spec reaches it through a symbol."""
    from . import Paths

    if isinstance(target, _Recorder):
        if target._state.symbol is None:
            raise ValueError("an object a spec defines is linked where it is defined")
        return {"symbol": target._state.symbol}
    target = Proxies._deref(target)
    if isinstance(target, Proxies._ObjectData) and Proxies._counted(target):
        raise ValueError(f"a counted {target._schema_name!r} has no path: a spec refers to it through a symbol")
    path = Paths.of(target)
    return {"path": Plain.ToPlain(store)(store.Paths.OfRoot.as_schema(), path)}
