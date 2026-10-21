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

`store.transaction(spec)` executes a transaction, sequentially: its stream starts as one frame, empty, and each term
makes the frames it passes on through `then`. A map binds each symbol its frame lacks to every object of its schema,
reachable from the store's singletons, whose spec holds; an upsert binds what it finds the same way and creates what it
does not, writing its spec where it does not hold; an update writes its spec; a reduce drops symbols; a partition runs
its branches and joins what they end with. It gives the frames its chain ends with, each the objects its symbols bind,
by symbol.
"""

from __future__ import annotations

import weakref
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


# --- The executor ---

Frame = dict[str, Any]
"""A frame: the objects its symbols bind, by symbol."""


def _execute(store: Any, transaction: Any) -> list[Frame]:
    """Executes a transaction's expression over the store, sequentially (docs/OBJECT_IDENTITY.md, Decided, 85 to 89): its
    stream starts as one frame, empty, which its root term transforms and passes on through `then`. Its writes are held
    in an overlay and written when it ends, or dropped where it raises. Gives the frames its chain ends with."""
    root = _next(transaction, "mutations")
    if root is not None:
        _check(store, root, set())
    with store._transacting():
        return [{}] if root is None else _run(store, root, [{}])


def _next(term: Any, name: str) -> Any:
    """The term a term's adjacency of one entry links (91): a transaction's root, a term's next; None where it holds
    none."""
    entries = list(getattr(term, name))
    if not entries:
        return None
    me = term.as_schema().adjacencies[name].me
    return getattr(entries[0], next(link for link in entries[0].as_schema().links if link != me))


def _kind(store: Any, term: Any) -> str:
    """A term's kind: `map`, `reduce`, `partition`, `branch`, `update` or `upsert`."""
    return store.name_of(term.as_schema()).removeprefix("Mutations.Of").lower()


def _pattern(term: Any, adjacency: str, kind: str) -> Any:
    """The pattern a term's adjacency links, refused where it is an expression (87)."""
    entries = list(getattr(term, adjacency))
    if len(entries) != 1:
        raise ValueError(f"{_a(kind)} takes one pattern in {adjacency!r}, not {len(entries)}")
    pattern = entries[0].pattern
    if pattern.variables:
        raise ValueError(f"{_a(kind)}'s pattern has variables: transactions bind no variables until expressions are "
                         "evaluated (step 4h)")
    if pattern.requires:
        raise ValueError(f"{_a(kind)}'s pattern requires constraints: transactions evaluate no expressions until step 4h")
    return pattern


def _a(kind: str) -> str:
    return f"an {kind}" if kind[0] in "aeiou" else f"a {kind}"


def _check(store: Any, term: Any, bound: set[str]) -> set[str]:
    """Checks a term and those after it, given the symbols bound before it: that each refers only to symbols a term
    before it binds (85), and binds no variable and evaluates no expression (87). Gives the symbols bound after the
    chain."""
    kind = _kind(store, term)
    if kind == "branch":
        if list(term.requires):
            raise ValueError("a branch requires constraints: transactions evaluate no expressions until step 4h")
    elif kind in ("map", "reduce") and list(term.variables):
        raise ValueError(f"{_a(kind)} of variables: transactions bind no variables until expressions are evaluated "
                         "(step 4h)")
    if kind == "map":
        pattern = _pattern(term, "symbols", kind)
        _symbols(store, pattern)
        bound = bound | set(pattern.symbols)
    elif kind == "upsert":
        pattern = _pattern(term, "exists", kind)
        _symbols(store, pattern)
        bound = bound | set(pattern.symbols)
    elif kind == "update":
        pattern = _pattern(term, "apply", kind)
        _unbound(pattern.symbols, bound, kind)
    elif kind == "reduce":
        entries = list(term.symbols)
        if len(entries) != 1:
            raise ValueError(f"a reduce takes one collector in 'symbols', not {len(entries)}")
        collector = entries[0].collector
        if collector.suffixes is not None or collector.computes is not None or collector.variables:
            raise ValueError("a reduce that collects (`suffixes`, `computes`, `variables`): transactions evaluate no "
                             "expressions until step 4h; a reduce drops symbols")
        _unbound(collector.symbols, bound, kind)
        bound = bound - set(collector.symbols)
    elif kind == "partition":
        if store.member(term, "first") and store.member(term, "last"):
            raise ValueError("a partition dispatches to its first matching branch or its last, not both")
        arms = [entry.branch for entry in term.branches]
        otherwise = _next(term, "none")
        joined = [_check(store, arm, bound) for arm in ([*arms, otherwise] if otherwise is not None else arms)]
        bound = set.intersection(*joined) if joined else bound
    after = _next(term, "then")
    return bound if after is None else _check(store, after, bound)


def _unbound(symbols: Iterable[str], bound: set[str], kind: str) -> None:
    for name in symbols:
        if name not in bound:
            raise ValueError(f"symbol {name!r} of {_a(kind)} is bound by no term before it")


def _symbols(store: Any, pattern: Any) -> None:
    """Refuses a symbol a transaction cannot bind yet: one of a schema object, or of a kind union."""
    for name, symbol in pattern.symbols.items():
        schema = symbol.schema
        if not isinstance(schema, S.OfObject.Data) or not schema.ref:
            raise ValueError(f"symbol {name!r} binds no reference object of one schema: transactions bind data objects "
                             "of an object schema")
        if store._meta_builder(store.name_of(schema)) is not None:
            raise ValueError(f"symbol {name!r} binds a schema object: transactions bind data objects until schemas are "
                             "written by transactions")


def _run(store: Any, term: Any, frames: list[Frame]) -> list[Frame]:
    """The frames a term, and those after it, make of `frames`: those its chain ends with."""
    kind = _kind(store, term)
    if kind == "map":
        pattern = _pattern(term, "symbols", kind)
        frames = [found for frame in frames for found in _bind(store, pattern, frame, False)]
    elif kind == "upsert":
        pattern = _pattern(term, "exists", kind)
        key = store.member(term, "key")
        frames = [found for frame in frames for found in _bind(store, pattern, frame, True, key)]
    elif kind == "update":
        pattern = _pattern(term, "apply", kind)
        for frame in frames:
            _write_spec(store, pattern, frame)
    elif kind == "reduce":
        dropped = set(next(iter(term.symbols)).collector.symbols)
        unique: dict[tuple[Any, ...], Frame] = {}
        for frame in frames:
            kept = {name: target for name, target in frame.items() if name not in dropped}
            unique.setdefault(tuple((name, Proxies._key_of(target)) for name, target in kept.items()), kept)
        frames = list(unique.values())
    elif kind == "partition":
        arms = [entry.branch for entry in term.branches]
        first = store.member(term, "first")
        if arms and (first or store.member(term, "last")):  # every branch matches, none requiring constraints (87)
            arms = [arms[0] if first else arms[-1]]
        otherwise = _next(term, "none")
        if not arms and otherwise is not None:
            arms = [otherwise]
        frames = [found for arm in arms for found in _run(store, arm, [dict(frame) for frame in frames])]
    after = _next(term, "then")
    return frames if after is None else _run(store, after, frames)


def _bind(store: Any, pattern: Any, frame: Frame, upsert: bool, key: str | None = None) -> list[Frame]:
    """The frames binding a pattern's symbols that `frame` does not, each to every object of its schema whose members
    its spec gives hold: a singleton's to the singleton (77). An upsert creates, where none is found, the object of a
    symbol, and writes its spec where it does not hold; a counted object it created before from the same frame, for
    the same symbol and key, it finds again (63)."""
    members = _members(pattern)
    frames = [dict(frame)]
    for name, symbol in pattern.symbols.items():
        if name in frame:
            continue
        schema = symbol.schema
        grown = []
        for partial in frames:
            if schema.singleton is not None:
                grown.append({**partial, name: store.singleton(schema.singleton)})
                continue
            index = (key, name, tuple((bound, Proxies._key_of(target)) for bound, target in sorted(frame.items())))
            held = store._upserted.get(index) if upsert and Proxies._counted_schema(schema) else None
            created = held() if held is not None else None
            if created is not None:
                grown.append({**partial, name: created})
                continue
            owning = [m for m in members.get(name, []) if "as_adjacency" in m
                      and schema.adjacencies[m["as_adjacency"]["name"]].owner]
            finding = owning or members.get(name, [])
            found = [target for target in store.extent(store.name_of(schema))
                     if _holds(store, target, schema, finding, partial, partial)]
            if found or not upsert:
                grown.extend({**partial, name: target} for target in found)
                continue
            made = store.builder(store.name_of(schema)).create()
            if Proxies._counted_schema(schema):
                store._upserted[index] = weakref.ref(made)
            grown.append({**partial, name: made})
        frames = grown
    if upsert:
        for bound in frames:
            _write_spec(store, pattern, bound)
        return frames
    return [bound for bound in frames
            if all(_holds(store, bound[name], pattern.symbols[name].schema, items, bound, None)
                   for name, items in members.items())]


def _members(pattern: Any) -> dict[str, list[Any]]:
    """A pattern's spec, by symbol: the members of each, its items in order."""
    members: dict[str, list[Any]] = {}
    for item in pattern.spec:
        for name, written in item.items():
            members.setdefault(name, []).extend(written)
    return members


def _holds(store: Any, target: Any, schema: Any, members: list[Any], frame: Frame, partial: Frame | None) -> bool:
    """Whether what a spec gives of an object holds of `target`: its properties' values, and its adjacencies' entries.
    Finding the object of a symbol (`partial`, the frame as bound so far), an entry linking a symbol not yet bound is
    left out."""
    values = target._values
    for member in members:
        (kind, body), = member.items()
        if kind == "as_property":
            name = body["name"]
            if _plain(store, values, name, schema.properties[name]) != _given(body["mutations"][0]):
                return False
            continue
        adjacency = schema.adjacencies[body["name"]]
        for entry in body["mutations"][0]["insert"]["entries"]:
            if partial is not None and any(target_ref.get("symbol") not in partial
                                           for target_ref in _symbol_refs(entry)):
                continue
            if not any(_matches(store, held, entry, frame) for held in
                       Proxies._linking(adjacency.relation, adjacency.me, target, store)):
                return False
    return True


def _symbol_refs(entry: Any) -> list[dict[str, Any]]:
    """The references to symbols an entry gives, its own and those of the objects it defines."""
    found = []
    for item in entry["mutations"]:
        (kind, body), = item.items()
        if kind == "as_link":
            held = body["mutations"][0]["set"]
            if "ref" in held and "symbol" in held["ref"]:
                found.append(held["ref"])
            elif "def" in held:
                for member in held["def"]["mutations"]:
                    (member_kind, member_body), = member.items()
                    if member_kind == "as_adjacency":
                        for nested in member_body["mutations"][0]["insert"]["entries"]:
                            found += _symbol_refs(nested)
    return found


def _plain(store: Any, values: dict[str, Any], name: str, prop: Any) -> Any:
    """A property's value as a spec gives it: `(present, plain)`."""
    return Plain._value(Proxies._Property(values, name, prop, store, None, False), prop.schema, Plain._Names(store))


def _given(verb: Any) -> Any:
    """A spec's property verb as `(present, plain)`."""
    return (True, verb["set"]["value"]) if "set" in verb else (False, None)


def _matches(store: Any, held: Any, entry: Any, frame: Frame) -> bool:
    """Whether an entry held is one a spec gives: the objects it links, and its properties' values."""
    for item in entry["mutations"]:
        (kind, body), = item.items()
        name = body["name"]
        if kind == "as_property":
            prop = held._relation.entry.properties[name]
            if _plain(store, held._properties, name, prop) != _given(body["mutations"][0]):
                return False
            continue
        linked = held._links.get(name)
        given = body["mutations"][0]["set"]
        if "def" in given:
            definition = given["def"]
            schema = store.registered(definition["schema"])
            if linked is None or linked.as_schema() is not schema or not _holds(
                    store, linked, schema, definition["mutations"], frame, None):
                return False
        elif linked is not _resolve(store, given["ref"], frame):
            return False
    return True


def _resolve(store: Any, ref: dict[str, Any], frame: Frame) -> Any:
    """The object a spec's reference names: the one a symbol binds, or the one at a path."""
    if "symbol" in ref:
        return frame[ref["symbol"]]
    found = Plain._by_path(store, ref["path"], ())
    if found is None:
        raise LookupError("no object of the store has the path a spec refers to")
    return found


def _write_spec(store: Any, pattern: Any, frame: Frame) -> None:
    """Writes a pattern's spec over a frame where it does not hold (Decided, 76)."""
    for name, members in _members(pattern).items():
        _write(store, frame[name], pattern.symbols[name].schema, members, frame)


def _write(store: Any, target: Any, schema: Any, members: list[Any], frame: Frame) -> None:
    """Writes what a spec gives of an object where it does not hold: a property's value, and an entry, its links
    resolved and the objects it defines made."""
    name_of = store.name_of(schema)
    for member in members:
        (kind, body), = member.items()
        name = body["name"]
        if kind == "as_property":
            prop = schema.properties[name]
            verb = body["mutations"][0]
            if _plain(store, target._values, name, prop) == _given(verb):
                continue
            builder = store.builder(name_of, target)
            if "set" in verb:
                Plain._set(builder, name, Plain._decode(prop.schema, verb["set"]["value"], (), store))
            else:
                getattr(builder, name).as_value(lambda value: value.clear())
            builder.update()
            continue
        adjacency = schema.adjacencies[name]
        for entry in body["mutations"][0]["insert"]["entries"]:
            if any(_matches(store, held, entry, frame)
                   for held in Proxies._linking(adjacency.relation, adjacency.me, target, store)):
                continue
            _insert(store, target, name_of, name, adjacency, entry, frame)


def _insert(store: Any, target: Any, name_of: str, name: str, adjacency: Any, entry: Any, frame: Frame) -> None:
    """Adds an entry a spec gives to an object's adjacency, replacing the one it holds where it holds one at most."""
    links: dict[str, Any] = {}
    values: dict[str, Any] = {}
    for item in entry["mutations"]:
        (kind, body), = item.items()
        if kind == "as_property":
            prop = adjacency.relation.entry.properties[body["name"]]
            values[body["name"]] = Plain._decode(prop.schema, body["mutations"][0]["set"]["value"], (), store)
            continue
        given = body["mutations"][0]["set"]
        if "def" in given:
            definition = given["def"]
            schema = store.registered(definition["schema"])
            made = store.builder(definition["schema"]).create()
            _write(store, made, schema, definition["mutations"], frame)
            links[body["name"]] = made
        else:
            links[body["name"]] = _resolve(store, given["ref"], frame)

    def fill(added: Any) -> Any:
        for link, linked in links.items():
            getattr(added, link)(linked)
        for prop, value in values.items():
            Plain._set(added, prop, value)
        return added

    builder = store.builder(name_of, target)
    member = getattr(builder, name)
    if Proxies._single(adjacency.relation, adjacency.me):  # one entry at most: the one held is replaced
        member(lambda held: held.remove(lambda old: old))
    member(lambda held: held.insert(fill))
    builder.update()
