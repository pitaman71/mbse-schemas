"""Transactions: the writes to a store, as mutation expressions over streams of frames ([FEA-027: mutations as queries](../../../../../mbse-basis/docs/features/FEA-027.md);
object identity 38 to 97 in [FEA-026: identity and transactions](../../../../../mbse-basis/docs/features/FEA-026.md)).

A pattern's `spec` says what must hold of a frame: the property values the objects its symbols bind have, and the
relation entries that link them (Decided, 76). It is written in the builders' own notation, over the frame, whose
members are the pattern's symbols, each a visitor of the object it binds that records mutations rather than writing
objects (58, 95):

    lambda _: _.bob.name("Bob").knows([_.ada])

A spec is recorded as a `Mutations.OfPattern`, plain data: for each symbol, the mutations of the object it binds, in
order. A property written is `{"as_property": {"name": ..., "mutations": [{"set": {"value": ...}}]}}`, its value as
`Plain` writes a property's; an adjacency's entries are `{"as_adjacency": {"name": ..., "mutations": [{"insert":
{"entries": [...]}}]}}`, each entry `{"mutations": [...]}` of its links (`as_link`) and properties (`as_property`), as a
snapshot writes an entry, leaving out the object's own link. A link refers to the object another symbol binds, `{"ref":
{"symbol": "ada"}}`, to an object by its path, `{"ref": {"path": ...}}` (a schema object, a singleton or an owned
object), or defines a new object where it is linked, `{"def": {"schema": ..., "mutations": [...]}}`. An adjacency's
entries are removed as a builder's adjacency removes them, `knows(lambda a: a.remove(lambda e: e.known(_.bob)))`,
recorded `{"remove": {"entries": [...]}}`, and all of them by `clear()`, recorded `{"clear": {}}`.

`store.transaction(spec)` executes a transaction, sequentially: its stream starts as one frame, empty, and each term
makes the frames it passes on through `then`. A map binds each symbol its frame lacks to every object of its schema,
reachable from the store's singletons, whose spec holds; an upsert binds what it finds the same way and creates what it
does not, writing its spec where it does not hold; an update writes its spec; a reduce drops symbols; a partition runs
its branches and joins what they end with. It gives the frames its chain ends with, each the objects its symbols bind,
by symbol. A spec holds where the entries it inserts are held and those it removes are absent: an entry is removed
where every link and property the removal gives agrees with it, so that run again, a spec that removes writes nothing.

A symbol of a meta-schema (`store.Schemas.OfObject`, ...) binds schema objects: a module's `install(txn)` upserts its
schemas, each found by its name, so that a transaction defines and extends schemas (Decided, 86).
"""

from __future__ import annotations

import weakref
from collections.abc import Iterable, Mapping
from types import SimpleNamespace
from typing import Any

from . import Plain, Proxies
from . import Schemas as S

__all__: list[str] = []


def _recorded(store: Any, symbols: Mapping[str, Any], spec: Any) -> dict[str, list[Any]]:
    """The mutations a spec's callback records over a frame of `symbols`, by symbol (a `Mutations.OfPattern`)."""
    frame = _Frame(store, symbols)
    store._recording += 1
    try:
        Proxies._visit(spec, frame)
    finally:
        store._recording -= 1
    return {name: state.plain() for name, state in frame._states.items() if state.written}


def _definition(store: Any, schema: Any, spec: Any) -> _Recorder:
    """A schema object a spec defines where it is linked, `store.Schemas.OfContainer(cb)` within one: its members as
    `spec` writes them, recorded; linked, it is written as a definition (`Mutations.OfObject.Def`)."""
    recorder = _Recorder(_State(store, schema))
    recorder._state.loose = True
    Proxies._visit(spec, recorder)
    return recorder


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
        state = self._states.get(name)
        if state is None:
            state = self._states[name] = _State(self._store, _recorded_schema(self._store, name, symbol), name)
        return _Recorder(state)

    def __repr__(self) -> str:
        return "<frame>"


def _given_reference(symbol: Any) -> Any:
    """The `References.OfObject` a pattern's symbol is given in place of a schema (`Schemas.OfSymbol`'s `reference`,
    which `References.install` adds); None where it is given none."""
    return Proxies._built(symbol.__dict__.get("_extended", {}).get("reference"))


def _exactly_one(name: str, symbol: Any, error: type[Exception]) -> Any:
    """A symbol's reference, refused where it has both a schema and a reference, or neither (References, Decided, 8)."""
    reference = _given_reference(symbol)
    if (reference is None) == (symbol.schema is None):
        given = "neither a schema nor a reference" if reference is None else "both a schema and a reference"
        raise error(f"symbol {name!r} has {given}: a symbol has exactly one")
    return reference


def _recorded_schema(store: Any, name: str, symbol: Any) -> Any:
    """The schema of the object a symbol binds, by which its spec items are written (its mutation builder's, Object
    identity, Decided, 58 and 76): its own, or, given a reference, that of the object the reference designates where
    the store holds it, else the schema its path implies, through the store's schemas alone (References, Decided, 8);
    refused where the path cannot be followed."""
    from . import References

    reference = _exactly_one(name, symbol, TypeError)
    if reference is None:
        return symbol.schema
    target = References.resolve(store, reference)
    if target is not None:
        return _reader(store, target).as_schema()
    try:
        return References._implied(store, Plain.ToPlain(store)(reference.as_schema(), reference)["path"])
    except LookupError as error:
        raise LookupError(f"symbol {name!r} is given a reference whose path {error}: a spec writes what its object's "
                          "schema declares") from None


class _State:
    """What a spec writes of one object: its properties' values, and the entries of its adjacencies, in order."""

    def __init__(self, store: Any, schema: Any, symbol: str | None = None):
        self.store, self.schema, self.symbol = store, schema, symbol
        self.loose = False  # defined by `_definition`, and not linked yet
        self.values: dict[str, Any] = {}
        self.written: list[tuple[str, Any]] = []  # ("property", name) or ("adjacency", (name, entries, verb)), in order

    def plain(self) -> list[Any]:
        names, members = Plain._Values(self.store), []
        for kind, what in self.written:
            if kind == "property":
                prop = self.schema.properties[what]
                values = {what: Proxies._built(self.values.get(what))}  # a value's builder, finished as a builder's is
                read = Proxies._Property(values, what, prop, self.store, None, False)
                present, plain = Plain._value(read, prop.schema, names)
                verb = {"set": {"value": plain}} if present else {"clear": {}}
                members.append({"as_property": {"name": what, "mutations": [verb]}})
            elif kind == "adjacency":
                name, entries, verb = what
                given = {"clear": {}} if verb == "clear" else {verb: {"entries": [entry.plain() for entry in entries]}}
                members.append({"as_adjacency": {"name": name, "mutations": [given]}})
            else:  # a pattern's own spec, as recorded (`_RecordedSpec`)
                members.append({"spec": {"items": what}})
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
        if name == "spec" and state.schema is state.store.registered("Schemas.OfPattern"):
            return _RecordedSpec(self)
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
        if not Proxies._is_function(spec):
            spec = _shorthand(self._recorder._state, self._name)(spec)
        self._visitor()(spec)
        self._note()
        return self._recorder

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self._visitor(), name)


class _RecordedSpec(Proxies._Unassignable):
    """A pattern's spec, written in a spec (`Mutations.OfObject.Spec`): each callback recorded over the symbols the
    pattern declares before it in the spec, as a pattern's builder records its own (`PatternBuilder.spec`)."""

    def __init__(self, recorder: _Recorder):
        object.__setattr__(self, "_recorder", recorder)

    def __call__(self, specs: Any) -> _Recorder:
        state = self._recorder._state
        symbols = _declared(state)
        items = [specs] if Proxies._is_function(specs) else list(specs)
        state.written.append(("spec", [_recorded(state.store, symbols, item) for item in items]))
        return self._recorder


def _declared(state: _State) -> dict[str, Any]:
    """The symbols a recorded pattern declares, by name, each with the schema its entry links: one the store holds,
    since a spec is recorded before its transaction runs."""
    symbols: dict[str, Any] = {}
    for kind, what in state.written:
        if kind == "adjacency" and what[0] == "symbols" and what[2] == "insert":
            for entry in what[1]:
                held = entry._links["symbol"]
                typed = [w for k, w in held.written if k == "adjacency" and w[0] == "schema" and w[2] == "insert"]
                ref = typed[0][1][0]._links["schema"] if typed else {}
                if not isinstance(ref, dict) or "path" not in ref:
                    raise ValueError(f"symbol {entry._values['name']!r} of a pattern whose spec a spec records names no "
                                     "schema the store holds: name it by its path, an earlier install's")
                symbols[entry._values["name"]] = SimpleNamespace(schema=Plain._by_path(state.store, ref["path"], ()))
    return symbols


def _shorthand(state: _State, name: str) -> Any:
    """What a schema object's builder makes of a value given whole to its property `name` (`_Prop.shorthand`), so that
    a spec takes what the builder does (`uniques("schema")`); a value as it is, for data's."""
    from . import Builders

    builder = state.store._meta_builder_class_of(state.schema)
    member = builder._members_.get(name) if builder is not None else None
    return member.shorthand if isinstance(member, Builders._Prop) else (lambda value: value)


class _RecordedAdjacency(Proxies._Unassignable):
    """An adjacency of a recorded object: its entries inserted, removed or cleared, recorded, as a builder's adjacency
    takes them (`insert(cb)`, `remove(cb)`, `clear()`). Called with a callback, it visits through it;
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

    def _record(self, entries: list[_Entry], verb: str = "insert") -> None:
        self._recorder._state.written.append(("adjacency", (self._name, entries, verb)))

    def insert(self, spec: Any) -> _RecordedAdjacency:
        entry = _Entry(self._recorder._state.store, self._schema.relation, self._schema.me)
        Proxies._visit(spec, entry)
        self._record([entry])
        return self

    def remove(self, spec: Any) -> _RecordedAdjacency:
        """Removes every entry that agrees with the one `spec` gives: each link and property it gives equal to the
        entry's; a keyed adjacency's entry by its name."""
        entry = _Entry(self._recorder._state.store, self._schema.relation, self._schema.me)
        Proxies._visit(spec, entry)
        self._record([entry], "remove")
        return self

    def clear(self) -> _RecordedAdjacency:
        """Removes every entry the adjacency holds."""
        self._record([], "clear")
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
                    if entry._other not in entry._links:  # given no link, it defines the object it links, as a builder's
                        entry._defined(entry._other)
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
        defines; in a list of one, as a link's builder takes it."""
        if isinstance(target, (list, tuple)):
            if len(target) != 1:
                raise TypeError(f"link {link!r} links one schema, got {len(target)}")
            (target,) = target
        if Proxies._is_function(target):
            store = self._store
            kinds = Proxies._link_kinds(self._relation, link)
            if kinds is not None:
                raise TypeError(f"link {link!r} is a kind union: define through one of its kinds, {', '.join(kinds)}")
            schema = store.registered(store._filled(self._relation, link))
            return self._define(link, schema, target)
        if isinstance(target, _Recorder) and target._state.loose:
            target._state.loose = False  # defined where it is linked (`_definition`), once
            self._links[link] = target._state
            return self
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
            if link not in self._links:  # given no link, it defines the object it links, as a builder's
                self._defined(link)
            return
        schema, takers = None, [("link", link)] if Proxies._links(self._store, self._relation, link, value) else []
        declared = self._relation.entry.links[link].schema
        known = isinstance(declared, S.OfObject.Data) and declared.ref or len(self._store._filling(self._relation, link)) == 1
        if known or not takers:  # where no one schema fills the link, the object it links has no members known
            schema = self._store.registered(self._store._filled(self._relation, link))
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
        names = Plain._Values(self._store)
        for name, prop in self._relation.entry.properties.items():
            read = Proxies._Property({name: Proxies._built(self._values.get(name))}, name, prop, self._store, None, False)
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


def _execute(store: Any, transaction: Any, joined: bool = False) -> list[Frame]:
    """Executes a transaction's expression over the store, sequentially (object identity 85 to 89 in [FEA-026: identity and transactions](../../../../../mbse-basis/docs/features/FEA-026.md)): its
    stream starts as one frame, empty, which its root term transforms and passes on through `then`. Its writes are held
    in its proposals and written when it ends, or dropped where it raises. Gives the frames its chain ends with."""
    root = _next(transaction, "mutations")
    if root is not None:
        _check(store, root, set())
    if joined:  # a decoder's: a savepoint of the one open
        with store._joined():
            return [{}] if root is None else _run(store, root, [{}])
    with store._transacting() as proposals:
        proposals.expression = transaction  # what its record gives (Provenance)
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
                         "evaluated")
    if pattern.requires:
        raise ValueError(f"{_a(kind)}'s pattern requires constraints: transactions evaluate no expressions yet")
    return pattern


def _a(kind: str) -> str:
    return f"an {kind}" if kind[0] in "aeiou" else f"a {kind}"


def _verbs(body: Any) -> list[tuple[str, list[Any]]]:
    """An adjacency's verbs in a spec, in order, each with the entries it gives: `insert` and `remove` theirs, `clear`
    none (`Mutations.OfAdjacency`)."""
    return [(kind, [] if kind == "clear" else given["entries"])
            for verb in body["mutations"] for kind, given in verb.items()]


def _links_set(spec: Any) -> None:
    """Refuses a spec whose entry, inserted or removed, clears a link, which a spec read from the wire may give: every
    link of an entry but its object's own is set. An entry's property cleared is left out of the entry inserted."""
    for item in spec:
        for members in item.values():
            for member in members:
                (kind, body), = member.items()
                if kind != "as_adjacency":
                    continue
                for _, entries in _verbs(body):
                    for entry in entries:
                        for part in entry["mutations"]:
                            (part_kind, part_body), = part.items()
                            given = part_body["mutations"][0]
                            if part_kind == "as_link" and "set" not in given:
                                raise ValueError("a spec's entry clears a link: every link of an entry but its object's "
                                                 "own is set")
                            if part_kind == "as_link" and "def" in given["set"]:
                                _links_set([{"": given["set"]["def"]["mutations"]}])


def _check(store: Any, term: Any, bound: set[str]) -> set[str]:
    """Checks a term and those after it, given the symbols bound before it: that each refers only to symbols a term
    before it binds (85), and binds no variable and evaluates no expression (87). Gives the symbols bound after the
    chain."""
    kind = _kind(store, term)
    if kind == "branch":
        if list(term.requires):
            raise ValueError("a branch requires constraints: transactions evaluate no expressions yet")
    elif kind in ("map", "reduce") and list(term.variables):
        raise ValueError(f"{_a(kind)} of variables: transactions bind no variables until expressions are evaluated")
    if kind == "map":
        pattern = _pattern(term, "symbols", kind)
        _symbols(store, pattern)
        _links_set(pattern.spec)
        bound = bound | set(pattern.symbols)
    elif kind == "upsert":
        pattern = _pattern(term, "exists", kind)
        _symbols(store, pattern)
        _links_set(pattern.spec)
        bound = bound | set(pattern.symbols)
    elif kind == "update":
        pattern = _pattern(term, "apply", kind)
        _links_set(pattern.spec)
        _unbound(pattern.symbols, bound, kind)
    elif kind == "reduce":
        entries = list(term.symbols)
        if len(entries) != 1:
            raise ValueError(f"a reduce takes one collector in 'symbols', not {len(entries)}")
        collector = entries[0].collector
        if collector.suffixes is not None or collector.computes is not None or collector.variables:
            raise ValueError("a reduce that collects (`suffixes`, `computes`, `variables`): transactions evaluate no "
                             "expressions yet; a reduce drops symbols")
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
    """Refuses a symbol a transaction cannot bind: one given both a schema and a reference, or neither; one of a kind
    union, or of no reference object schema."""
    for name, symbol in pattern.symbols.items():
        if _exactly_one(name, symbol, ValueError) is not None:
            continue  # it binds what its reference designates
        schema = symbol.schema
        if not isinstance(schema, S.OfObject.Data) or not schema.ref:
            raise ValueError(f"symbol {name!r} binds no reference object of one schema: transactions bind objects of an "
                             "object schema")


def _meta(store: Any, schema: Any) -> bool:
    """Whether `schema` is a meta-schema: its objects are schema objects (`Schemas.OfObject`, ...), written by their
    builders (Decided, 86)."""
    return store._meta_builder(store.name_of(schema)) is not None


def _reader(store: Any, target: Any) -> Any:
    """A visitor of an object, to read: a schema object's builder, read-only, which sees what the transaction open has
    made of it, or data's proxy."""
    kind = store._meta_builder_class(target)
    return target if kind is None else kind(target, False, store)


def _writer(store: Any, schema: Any, target: Any = None) -> Any:
    """A builder of an object of `schema`, new or `target`: a schema object's by its meta-schema, data's by its
    schema."""
    name = store.name_of(schema)
    return store._meta_builder(name, target) if _meta(store, schema) else store.builder(name, target)


def _linked(value: Any) -> Any:
    """The object an entry links, as read: a schema object's entry gives a link, read through its builder where it links
    a schema object, else the data it links (an extension's relation's)."""
    from . import Builders

    if not isinstance(value, Builders._Link):
        return value
    target = value._target()
    return target._original if isinstance(target, Builders._Builder) else target


def _extent(store: Any, schema: Any) -> list[Any]:
    """The objects a symbol of `schema` ranges over: a meta-schema's, the named schema objects of its kind the store
    holds, the framework's left out; data's, those the store reaches from its singletons."""
    if not _meta(store, schema):
        return list(store.extent(store.name_of(schema)))
    return [held for held in store._objects.values()
            if not store.framework(held) and _reader(store, held).as_schema() is schema]


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
            unique.setdefault(tuple((name, Proxies._key_of(_reader(store, target))) for name, target in kept.items()), kept)
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
    its spec gives hold: a singleton's to the singleton (77). A symbol given a reference binds what it designates, and no frame
    where the store holds none (References, Decided, 8). An upsert creates, where none is found, the object of a
    symbol, and writes its spec where it does not hold; a counted object it created before from the same frame, for
    the same symbol and key, it finds again (63), and finds none otherwise (102)."""
    from . import References

    members = _members(pattern)
    frames = [dict(frame)]
    for name, symbol in pattern.symbols.items():
        if name in frame:
            continue
        reference = _given_reference(symbol)
        if reference is not None:  # what it designates, or no frame where the store holds none (References, Decided, 8)
            target = References.resolve(store, reference)
            frames = [] if target is None else [{**partial, name: target} for partial in frames]
            continue
        schema = symbol.schema
        grown = []
        for partial in frames:
            if schema.singleton is not None:
                grown.append({**partial, name: store.singleton(schema.singleton)})
                continue
            if upsert and Proxies._counted_schema(schema) and not _meta(store, schema):  # found only by what made it (102)
                index = _upsert_index(store, key, name, frame)
                held = store._upserted.get(index)
                made = held() if held is not None else None
                if made is None:
                    made = _writer(store, schema).create()
                    store._upserted[index] = weakref.ref(made)
                grown.append({**partial, name: made})
                continue
            own = members.get(name, [])
            identifying = [member for member in own if _identifies(store, schema, member)]
            located = None if identifying else _located(store, pattern, members, name, schema, partial)
            if located is not None:  # placed by its owner's entries, which a symbol bound before it gives (60)
                found = located
            elif identifying and _meta(store, schema):  # a schema object by its name, the store's own included (86)
                found = _registered(store, schema, identifying[0], partial)
            else:
                found = [target for target in _extent(store, schema)
                         if _holds(store, target, schema, identifying or own, partial, partial)]
            if found or not upsert:
                grown.extend({**partial, name: target} for target in found)
                continue
            grown.append({**partial, name: _created(store, schema, identifying)})
        frames = grown
    if upsert:
        for bound in frames:
            _write_spec(store, pattern, bound)
        return frames
    return [bound for bound in frames
            if all(_holds(store, bound[name], _schema(store, pattern, name, bound), items, bound, None)
                   for name, items in members.items())]


def _schema(store: Any, pattern: Any, name: str, frame: Frame) -> Any:
    """The schema of the object a pattern's symbol binds in `frame`: its own, or, given a reference, the bound object's."""
    schema = pattern.symbols[name].schema
    return _reader(store, frame[name]).as_schema() if schema is None else schema


def _upsert_index(store: Any, key: str | None, name: str, frame: Frame) -> tuple[Any, ...]:
    """What tells apart a counted object an upsert makes (63): the upsert's key, the symbol, and the objects of the
    frame that reached it, each as it is told apart in memory."""
    return key, name, tuple((bound, Proxies._key_of(_reader(store, target))) for bound, target in sorted(frame.items()))


def _registered(store: Any, schema: Any, member: Any, frame: Frame) -> list[Any]:
    """The schema object registered under the name a spec gives, where it is of the meta-schema `schema`, a module by
    its path, the root module where it gives none: none otherwise."""
    (_, body), = member.items()
    name = _given(body["mutations"][0])[1]
    if schema is store.registered("Schemas.OfModule"):
        held = store._modules.get(name or "")
        return [] if held is None else [held]
    try:
        held = store.registered(name)
    except LookupError:
        return []
    return [held] if _reader(store, held).as_schema() is schema else []


def _created(store: Any, schema: Any, identifying: list[Any]) -> Any:
    """An object an upsert makes where it finds none: a schema object made with the name it was looked up by, so that
    what links it before its spec is written links a named schema (86)."""
    builder = _writer(store, schema)
    for member in identifying:
        (kind, body), = member.items()
        if kind == "as_property":
            prop = schema.properties[body["name"]]
            Plain._set(builder, body["name"], Plain._decode(prop.schema, body["mutations"][0]["set"]["value"], (), store))
    return builder.create()


def _located(store: Any, pattern: Any, members: dict[str, list[Any]], name: str, schema: Any, frame: Frame) -> Any:
    """Where a symbol's object is owned through an adjacency it has no name for, the entry that places it in a symbol's
    spec bound before it (Decided, 60): the objects linked by each of the owner's entries agreeing with the properties
    it gives, one where they give its keys, every one where they leave them open, none where none agrees; None where no
    spec gives such an entry."""
    owning = [a for a in (*schema.adjacencies.values(), *schema.anonymous) if a.owner]
    for other, items in members.items():
        if other not in frame or not owning:
            continue
        for item in items:
            (kind, body), = item.items()
            if kind != "as_adjacency":
                continue
            relation = _schema(store, pattern, other, frame).adjacencies[body["name"]].relation
            for entry in (entry for verb, entries in _verbs(body) if verb == "insert" for entry in entries):
                link = next((part["as_link"]["name"] for part in entry["mutations"] if "as_link" in part
                             and part["as_link"]["mutations"][0]["set"].get("ref", {}).get("symbol") == name), None)
                if link is None or not any(a.relation is relation and a.me == link for a in owning):
                    continue
                given = [part["as_property"] for part in entry["mutations"] if "as_property" in part]
                return [_linked(getattr(held, link)) for held in getattr(_reader(store, frame[other]), body["name"])
                        if all(_plain(store, getattr(held, p["name"]), relation.entry.properties[p["name"]])
                               == _given(p["mutations"][0]) for p in given)]
    return None


def _identifies(store: Any, schema: Any, member: Any) -> bool:
    """Whether a spec's member gives its object's identity, by which an upsert finds it: a schema object's name (86),
    an owned object's owning entry (60)."""
    (kind, body), = member.items()
    if kind == "as_property":
        return body["name"] == "name" and _meta(store, schema)
    return kind == "as_adjacency" and schema.adjacencies[body["name"]].owner and \
        any(verb == "insert" for verb, _ in _verbs(body))


def _members(pattern: Any) -> dict[str, list[Any]]:
    """A pattern's spec, by symbol: the members of each, its items in order."""
    members: dict[str, list[Any]] = {}
    for item in pattern.spec:
        for name, written in item.items():
            members.setdefault(name, []).extend(written)
    return members


def _holds(store: Any, target: Any, schema: Any, members: list[Any], frame: Frame, partial: Frame | None) -> bool:
    """Whether what a spec gives of an object holds of `target`: its properties' values, the entries it inserts held,
    and those it removes absent, none where it clears the adjacency. Finding the object of a symbol (`partial`, the frame
    as bound so far), an entry linking a symbol not yet bound is left out."""
    visitor = _reader(store, target)
    for member in members:
        (kind, body), = member.items()
        if kind == "spec":
            if [dict(item) for item in visitor._working.spec] != body["items"]:
                return False
            continue
        name = body["name"]
        if kind == "as_property":
            if _plain(store, getattr(visitor, name), schema.properties[name]) != _given(body["mutations"][0]):
                return False
            continue
        relation = schema.adjacencies[name].relation
        held = list(getattr(visitor, name))
        unmatched = list(held)
        for verb, entries in _verbs(body):
            if verb == "clear" and held:
                return False
            for entry in entries:
                if partial is not None and any(target_ref.get("symbol") not in partial
                                               for target_ref in _symbol_refs(entry)):
                    continue
                if verb == "insert" and _match(store, relation, unmatched, entry, frame) is None:
                    return False
                if verb == "remove" and _removed(store, relation, held, [entry], frame):
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
                        for _, nested in _verbs(member_body):
                            for given in nested:
                                found += _symbol_refs(given)
    return found


def _plain(store: Any, read: Any, prop: Any) -> Any:
    """A property's value, read, as a spec gives it: `(present, plain)`."""
    return Plain._value(read, prop.schema, Plain._Values(store))


def _given(verb: Any) -> Any:
    """A spec's property verb as `(present, plain)`."""
    return (True, verb["set"]["value"]) if "set" in verb else (False, None)


def _matches(store: Any, relation: Any, held: Any, entry: Any, frame: Frame) -> bool:
    """Whether an entry held, read, is one a spec gives: the objects it links, and its properties' values."""
    for item in entry["mutations"]:
        (kind, body), = item.items()
        name = body["name"]
        if kind == "as_property":
            if _plain(store, getattr(held, name), relation.entry.properties[name]) != _given(body["mutations"][0]):
                return False
            continue
        linked = _linked(getattr(held, name))
        given = body["mutations"][0]["set"]
        if "def" in given:
            definition = given["def"]
            schema = store.registered(definition["schema"])
            if _reader(store, linked).as_schema() is not schema or not _holds(
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
        _write(store, frame[name], _schema(store, pattern, name, frame), members, frame)


def _write(store: Any, target: Any, schema: Any, members: list[Any], frame: Frame) -> None:
    """Writes what a spec gives of an object where it does not hold: a property's value, an entry, its links resolved and
    the objects it defines made, and a pattern's spec, as recorded."""
    for member in members:
        (kind, body), = member.items()
        if kind == "spec":
            if not _holds(store, target, schema, [member], frame, None):
                builder = _writer(store, schema, target)
                builder._working.spec = tuple(dict(item) for item in body["items"])  # its spec, in place of what it held
                builder.update()
            continue
        name = body["name"]
        if kind == "as_property":
            prop = schema.properties[name]
            verb = body["mutations"][0]
            if _plain(store, getattr(_reader(store, target), name), prop) == _given(verb):
                continue
            builder = _writer(store, schema, target)
            Plain._set(builder, name, Plain._decode(prop.schema, verb["set"]["value"], (), store) if "set" in verb else None)
            builder.update()
            continue
        adjacency = schema.adjacencies[name]
        for verb, entries in _verbs(body):
            held = list(getattr(_reader(store, target), name))
            if verb != "insert":
                _remove(store, target, schema, name, None if verb == "clear" else entries, held, frame)
                continue
            for entry in entries:
                if _match(store, adjacency.relation, held, entry, frame) is None:
                    _insert(store, target, schema, name, adjacency, entry, frame)


def _removed(store: Any, relation: Any, held: list[Any], entries: list[Any], frame: Frame) -> list[int]:
    """The positions of the entries `held` that agree with one of the entries a spec removes."""
    return [index for index, candidate in enumerate(held)
            if any(_matches(store, relation, candidate, entry, frame) for entry in entries)]


def _remove(store: Any, target: Any, schema: Any, name: str, entries: list[Any] | None, held: list[Any],
            frame: Frame) -> None:
    """Removes from an object's adjacency, `held` as read, each entry that agrees with one of `entries`, a spec's
    removal, or every entry where it gives None (`clear`); through the object's builder, which removes the entries it
    holds at those positions, so that removing an owning entry deletes what it owned (Decided, 48)."""
    relation = schema.adjacencies[name].relation
    removed = range(len(held)) if entries is None else _removed(store, relation, held, entries, frame)
    if not removed:
        return
    builder = _writer(store, schema, target)
    member = getattr(builder, name)
    written = list(member)
    for index in removed:
        member.remove(written[index])
    builder.update()


def _match(store: Any, relation: Any, held: list[Any], entry: Any, frame: Frame) -> Any:
    """The first of the entries `held` that agrees with an entry a spec gives, taken from them, so that the k-th equal
    entry a spec gives is the k-th such entry held; None where none agrees."""
    for index, candidate in enumerate(held):
        if _matches(store, relation, candidate, entry, frame):
            return held.pop(index)
    return None


def _defining(store: Any, schema: Any, name: str, defined: Any) -> Any:
    """A builder of an object a spec defines where an adjacency `name` of an object of `schema` links it: the one that
    adjacency's member declares, where it builds `defined`'s kind (a pattern's `requires`, a constraint, whose result is
    the store's `Schemas.OfBool`), as a builder's member does; else `defined`'s own."""
    from . import Builders

    owner = store._meta_builder_class_of(schema)
    member = owner._members_.get(name) if owner is not None else None
    builder = member.build() if isinstance(member, Builders._Members) and member.build is not None else None
    if builder is not None and getattr(store._meta, builder._meta, None) is defined:
        return builder(None, True, store)
    return _writer(store, defined)


def _insert(store: Any, target: Any, schema: Any, name: str, adjacency: Any, entry: Any, frame: Frame) -> None:
    """Adds an entry a spec gives to an object's adjacency, replacing the one it holds where it holds one at most."""
    links: dict[str, Any] = {}
    values: dict[str, Any] = {}
    for item in entry["mutations"]:
        (kind, body), = item.items()
        if kind == "as_property":
            verb = body["mutations"][0]
            if "set" in verb:  # a property cleared: the entry is inserted without it
                prop = adjacency.relation.entry.properties[body["name"]]
                values[body["name"]] = Plain._decode(prop.schema, verb["set"]["value"], (), store)
            continue
        given = body["mutations"][0]["set"]
        if "def" in given:
            definition = given["def"]
            defined = store.registered(definition["schema"])
            made = _defining(store, schema, name, defined).create()
            _write(store, made, defined, definition["mutations"], frame)
            links[body["name"]] = made
        else:
            links[body["name"]] = _resolve(store, given["ref"], frame)

    def fill(added: Any) -> Any:
        for link, linked in links.items():
            getattr(added, link)(linked)
        for prop, value in values.items():
            Plain._set(added, prop, value)
        return added

    builder = _writer(store, schema, target)
    member = getattr(builder, name)
    if Proxies._single(adjacency.relation, adjacency.me):  # one entry at most: the one held is replaced
        member(lambda held: held.remove(lambda old: old))
    member(lambda held: held.insert(fill))
    builder.update()
