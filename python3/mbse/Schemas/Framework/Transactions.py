"""Transactions: the writes to a store, as mutation expressions over streams of frames ([FEA-027: mutations as queries](mbse:mbse-basis/docs/features/FEA-027.md);
object identity 38 to 97 in [FEA-030: clean mutation-based transactional API](mbse:mbse-basis/docs/features/FEA-030.md)).

A pattern's `spec` says what must hold of a frame: the property values the objects its symbols bind have, and the
relation entries that link them (object identity 76 in [CAP-137: patterns of symbols, variables and specs](mbse:mbse-basis/docs/capabilities/CAP-137.md#decided)). It is written in the builders' own notation, over the frame, whose
members are the pattern's symbols, each a visitor of the object it binds that records mutations rather than writing
objects (58, 95):

    lambda _: _.bob.name("Bob").knows([_.ada])

A spec is recorded as a `Mutations.OfPattern`, plain data: for each symbol, the mutations of the object it binds, in
order. A property written is `{"as_property": {"name": ..., "mutations": [{"set": {"value": ...}}]}}`, its value as
`Plain` writes a property's; an adjacency's entries are `{"as_adjacency": {"name": ..., "mutations": [{"insert":
{"entries": [...]}}]}}`, each entry `{"mutations": [...]}` of its links (`as_link`) and properties (`as_property`), as a
snapshot writes an entry, leaving out the object's own link. A link's `reference` names the object another symbol binds,
`{"reference": {"symbol": "ada"}}`, or an object by its path, `{"reference": {"path": ...}}` (a schema object, a
singleton or an owned object), as `References.OfObject` writes one; or the link defines a new object where it is linked, `{"def": {"schema": ..., "mutations": [...]}}`. An adjacency's
entries are removed as a builder's adjacency removes them, `knows(lambda a: a.remove(lambda e: e.known(_.bob)))`,
recorded `{"remove": {"entries": [...]}}`, and all of them by `clear()`, recorded `{"clear": {}}`.

`store.transaction(spec)` executes a transaction, sequentially: its stream starts as one frame, empty, and each term
makes the frames it passes on through `then`. A map binds each symbol its frame lacks to every object of its schema,
reachable from the store's singletons, whose spec holds; an upsert binds what it finds the same way and creates what it
does not, writing its spec where it does not hold; an update writes its spec; a reduce drops symbols; a partition runs
its branches and joins what they end with. It gives the frames its chain ends with, each the objects its symbols bind,
by symbol. A spec holds where the entries it inserts are held and those it removes are absent: an entry is removed
where every link and property the removal gives agrees with it, so that run again, a spec that removes writes nothing.

Within a transaction, `with store.transaction() as txn:`, the transaction open (`Transaction`, a first piece of [the
transaction-object proposal](mbse:mbse-schemas/docs/proposals/transaction-object/README.md)) executes the suffix of a transaction's expression, a `Remainder`, over input frames with
`txn.exec(frame, remainder, allow_write)`, giving a stream of frames, a generator, and opening and committing no
transaction of its own ([CAP-308: stacking by mutation transactions, in one round trip](mbse:mbse-basis/docs/capabilities/README.md#CAP-308); [the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)): each frame
carries the id of its input frame, `scope`, and each input frame's frames end with its completion marker,
`{"end": scope}`. Writing, it interprets the expression fully; `store.transaction(spec)` collects its stream over one
empty frame. Read-only, it interprets over what the store holds, writing nothing: where it holds nothing to bind a
symbol, or a term would write, the frame halts, given as bound so far, carrying its `remainder`; the same transaction
completes it, writing, as the loopback of a store with no layer below. A partition keeps its join: the rest of a branch
a frame halted in is executed by the loopback, within the transaction. All of it commits, or is dropped, with the scope.

A symbol of a meta-schema (`store.Schemas.OfObject`, ...) binds schema objects: a module's `install(txn)` upserts its
schemas, each found by its name, so that a transaction defines and extends schemas (object identity 86 in [CAP-115: schemas defined by idempotent installs](mbse:mbse-basis/docs/capabilities/CAP-115.md#decided)).
"""

from __future__ import annotations

import abc
import contextlib
import itertools
import weakref
from collections.abc import Iterable, Iterator, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from . import Errors, Plain, Proxies
from . import Schemas as S

__all__ = ["Frame", "FrameError", "InMemory", "Interpreter", "Remainder", "Transaction"]


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
    """A symbol's reference, refused where it has both a schema and a reference, or neither (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided))."""
    reference = _given_reference(symbol)
    if (reference is None) == (symbol.schema is None):
        given = "neither a schema nor a reference" if reference is None else "both a schema and a reference"
        raise error(f"symbol {name!r} has {given}: a symbol has exactly one")
    return reference


def _recorded_schema(store: Any, name: str, symbol: Any) -> Any:
    """The schema of the object a symbol binds, by which its spec items are written (its mutation builder's, Object
    identity, Decided, 58 and 76): its own, or, given a reference, that of the object the reference designates where
    the store holds it, else, or where it is not present, the schema its path implies, through the store's schemas
    alone (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)); refused where the path cannot be followed."""
    from . import References

    reference = _exactly_one(name, symbol, TypeError)
    if reference is None:
        return symbol.schema
    path = Plain.ToPlain(store)(reference.as_schema(), reference)["path"]
    target = References._designated(store, reference)
    if target is not None:
        return _reader(store, target).as_schema()
    try:
        return References._implied(store, path)
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
    its relation has two links and one property, each item an entry keyed by that property (mappings
    for keyed adjacencies, [CAP-107: one visitor protocol reads and writes data](mbse:mbse-basis/docs/capabilities/CAP-107.md#decided))."""

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
        if Proxies._is_parameter(Proxies._durable(value)):  # in the place of the object the entry links (CAP-312)
            self._link(link, value)
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
                if isinstance(held, _State) else {"reference": held}
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

    if Proxies._is_parameter(Proxies._durable(target)) or Proxies._parameter_in(target) is not None:
        return Plain._marked(store, Proxies._parameter_in(target) or target)  # in the object's place (CAP-312)
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

@dataclass(frozen=True)
class FrameError:
    """An error annotated on a frame ([CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)): where in
    the expression it arose, `subterm`, the term that was processing the frame, by its path in the transaction's
    expression on the wire (`Plain.ToPlain(store).Transaction`), as a decoding error locates what it reads there
    (`$.mutations[0].map.then[0].update`); its `kind`, the name of the error's class (`ValueError`); and its `message`.
    `error` is the error itself, where it arose here, None where the annotation was made otherwise; it is not
    compared."""

    subterm: str
    kind: str
    message: str
    error: BaseException | None = field(default=None, compare=False, repr=False)


class Remainder:
    """The suffix of a transaction's expression yet to be executed over a frame ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)):
    the term at `at`, its path in the expression's wire form (`("mutations", 0, "map", "then", 0, "update")`, which
    `subterm` writes `$.mutations[0].map.then[0].update`), and the terms after it in its chain, through `then`, to the
    end of the transaction, or of the branch it is in. A position in `transaction`, the original expression, not a copy
    of it: as it is a suffix, no rewrite is required. Where a frame halts within a term, a map that bound some of its
    symbols and not the rest, the term is the remainder's first, and the frame binds those symbols: executed again over
    it, the term binds the rest, as a term binds only the symbols its frame does not."""

    __slots__ = ("transaction", "at")

    def __init__(self, transaction: Any, at: tuple[str | int, ...]):
        self.transaction, self.at = transaction, tuple(at)

    @property
    def subterm(self) -> str:
        """Where the remainder starts, as `FrameError.subterm` writes it; `$` for an expression of no term."""
        return Errors.path(*self.at)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Remainder) and other.transaction is self.transaction and other.at == self.at

    def __hash__(self) -> int:
        return hash(self.at)

    def __repr__(self) -> str:
        return f"<remainder {self.subterm}>"


class Frame(dict[str, Any]):
    """A frame: the objects its symbols bind, by symbol; and its `errors`, each what failed as a term processed it
    ([CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)), none where none did.

    One `store.transaction` or `txn.exec` gives back holds bindings and assignments, not visitors ([CAP-315: every
    read within a transaction or through a follow](mbse:mbse-basis/docs/capabilities/CAP-315.md#decided)): each symbol's object by its reference, a `References.OfObject`, a
    value that outlives the transaction (a schema object, which the rule does not cover, as itself); and `assigns`, by
    symbol, the values the transaction left in the properties its terms' specs name for it, as data, harvested within
    it. A counted object has no reference: the frame refuses it, its symbol read raising `LookupError`, and assigns
    nothing of it.

    One `txn.exec` gives also carries `scope`, the id of the input frame it descends from, and, where it halted
    unfinished, its `remainder`, the suffix of the expression yet to be executed over it (`Remainder`); None where it
    is complete. Given to `txn.exec`, a frame's `scope` is its id, where it has one.

    And its `journal`: the changes made in interpreting its input frame, as a `Changes.Journal` of one transaction,
    whose symbols are its own, its id the transaction's uid and the frame's position in the stream (`uid#n`), carried
    by the first frame the input frame gives, so that applying each frame's journal by `Changes.apply` applies each
    change once, the counted objects of each frame apart; None where it carries none
    ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below))."""

    def __init__(self, bound: Mapping[str, Any] | None = None, errors: Iterable[FrameError] = (),
                 assigns: Mapping[str, Mapping[str, Any]] | None = None, remainder: Remainder | None = None,
                 scope: str | None = None, journal: Any = None):
        super().__init__(bound or {})
        self.errors: list[FrameError] = list(errors)
        self.assigns: dict[str, dict[str, Any]] = {name: dict(values) for name, values in (assigns or {}).items()}
        self.remainder, self.scope, self.journal = remainder, scope, journal

    def __getitem__(self, name: str) -> Any:
        found = super().__getitem__(name)
        if isinstance(found, _Refused):
            raise LookupError(f"symbol {name!r} of the frame: {found.message}")
        return found

    def get(self, name: str, default: Any = None) -> Any:  # type: ignore[override]
        return self[name] if name in self else default


class _Refused:
    """What a frame given back holds for a symbol that binds a counted object, which has no reference: its every use is
    refused, saying why; but given again to `exec` within the transaction that gave it (`life`), the object it binds
    (`target`), so that a frame halted there is resumed there."""

    def __init__(self, message: str, target: Any = None, life: Any = None):
        self.message, self._target, self._life = message, target, life

    def __getattr__(self, name: str) -> Any:
        raise LookupError(self.message)

    def __repr__(self) -> str:
        return "<refused: a counted object>"


class _Uncommitted(Exception):
    """A transaction a frame of which is annotated with an error: dropped, whole (CAP-124)."""


class _Halt(Exception):
    """A term that would write, interpreted read-only: its frame halts at it, writing nothing (`Interpreter._written`)."""


class _Absent(Exception):
    """A frame's reference that designates nothing the layer holds."""


def _raised(frames: list[Frame]) -> list[Frame]:
    """`frames`, where none is annotated with an error; else the first error annotated is raised, the one that arose
    first, as it arose, its `frames` all the frames, those annotated among them ([CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309))."""
    failed = next((frame for frame in frames if frame.errors), None)
    if failed is not None:
        error = failed.errors[0].error
        assert error is not None  # annotated here
        error.frames = frames  # type: ignore[attr-defined]
        raise error
    return frames


def _execute(store: Any, transaction: Any) -> list[Frame]:
    """Executes a transaction's expression over the store, sequentially, by its interpreter (`Interpreter._execute`):
    the library's own (a decoder's, a cache layer's applying what the layer below changed). A store standing in for
    another, which reads and writes through it, as a test's recorder does, is interpreted as itself."""
    interpreter = store._interpreter()
    if interpreter.store is not store:
        interpreter = InMemory(store)
    return interpreter._execute(transaction)


def _remainder(store: Any, transaction: Any) -> Remainder:
    """What `txn.exec` is given to execute: a remainder as it is, or a whole transaction's expression, from its root
    term; at `()` where it has none."""
    if isinstance(transaction, Remainder):
        return transaction
    root = _next(transaction, "mutations")
    return Remainder(transaction, () if root is None else ("mutations", 0, _kind(store, root)))


def _term_at(transaction: Any, at: tuple[str | int, ...]) -> Any:
    """The term at `at` in a transaction's expression, its path in the wire form: each step an adjacency of one entry
    (`mutations`, `then`, `none`), its index and the kind of the term it links, or `branches` and a branch's index."""
    term, step = transaction, 0
    while step < len(at):
        if at[step] == "branches":
            term = list(term.branches)[at[step + 1]].branch
            step += 2
        else:
            term = _next(term, str(at[step]))
            step += 3
    return term


class Transaction:
    """The transaction open on a layer, an object of its own, which `with store.transaction() as txn:` gives: a first
    piece of [the transaction-object proposal](mbse:mbse-schemas/docs/proposals/transaction-object/README.md), holding the transaction, and executing expressions within it
    (`exec`) by its layer's interpreter (`Interpreter`). Its writes commit, or are dropped, with the scope: where a frame
    its `exec` gave is annotated with an error, the scope commits nothing, raising the first error annotated (CAP-309).
    It lives within its transaction, `life`, whose `ended` says it has ended: used after, it is refused."""

    def __init__(self, interpreter: Interpreter, life: Any):
        self._interpreter, self._life = interpreter, life
        self._given: list[Frame] = []  # every frame its `exec` gave, in order

    def exec(self, frame: Any, remainder: Any, allow_write: bool) -> Iterator[Any]:
        """Executes the suffix of a transaction's expression over input frames, within this transaction, giving a
        stream of frames, a generator ([CAP-308: stacking by mutation transactions, in one round trip](mbse:mbse-basis/docs/capabilities/README.md#CAP-308), [the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)).
        It opens and commits no transaction of its own.

        `frame` is the current execution frame, the symbols bound so far, each by its reference, a schema object as
        itself (`Frame`, or any mapping); or a stream of them, an iterable each item of which is taken as it arrives.
        `remainder` is what is yet to be executed: a `Remainder`, as a frame that halted carries it, or a whole
        transaction, as `store.transaction` takes it. Where `allow_write` is true, the expression is interpreted fully,
        writing; where false, read-only, over what the store holds: where it holds nothing to bind a symbol, or a term
        would write, the frame halts, and is given as bound so far, carrying its `remainder`, which
        `txn.exec(halted, halted.remainder, True)` completes, in the same transaction, a counted object it binds among
        it. A partition keeps its join: a frame that halts within one of its branches, the rest of that branch alone is
        executed below it, by the loopback, this store having no layer below, writing within this transaction, and what
        each branch ends with is joined.

        Each input frame gives the frames made of it, given back as references and assignments (CAP-315), each
        carrying its `scope`, the input frame's id (its own `scope`, else its position in the stream, `"0"`, `"1"`,
        ...), then the completion marker `{"end": scope}`; the stream ends where the generator does. An error a term
        meets is annotated on the frame it processed (CAP-309); an error of no one frame is raised."""
        return self._interpreter.exec(self, frame, remainder, allow_write)

    def _open(self) -> None:
        """Refuses a transaction that has ended."""
        if self._life.ended:
            raise ValueError("a transaction's exec runs within it: this one has ended (store.transaction)")

    def _raise(self) -> None:
        """At the end of its scope: the first error annotated on a frame its `exec` gave, raised (`_raised`)."""
        _raised(self._given)


class _Run:
    """What executing a transaction over one input frame keeps: whether it writes (`write`), else interprets read-only,
    halting; the frames a term failed to process (`failed`) and those that halted (`halted`), each carrying its
    remainder; the properties the specs name, by symbol (`named`); the input frame's id (`scope`); and how many
    branches it sent below (`sent`), each a scope of its own."""

    def __init__(self, transaction: Any, write: bool, named: dict[str, list[str]], scope: str | None, sent: Any = None):
        self.transaction, self.write, self.named, self.scope = transaction, write, named, scope
        self.sent = itertools.count() if sent is None else sent
        self.failed: list[Frame] = []
        self.halted: list[Frame] = []

    def arm(self) -> _Run:
        """The run of a branch of a partition: its own halted frames, which the partition joins; the rest shared."""
        run = _Run(self.transaction, self.write, self.named, self.scope, self.sent)
        run.failed = self.failed
        return run

    def halt(self, frame: Frame, at: tuple[str | int, ...]) -> None:
        frame.remainder = Remainder(self.transaction, at)
        self.halted.append(frame)


# --- What an expression says, read through the store's schemas alone ---


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
    builders (object identity 86 in [CAP-115: schemas defined by idempotent installs](mbse:mbse-basis/docs/capabilities/CAP-115.md#decided))."""
    return store._meta_builder(store.name_of(schema)) is not None


def _named(store: Any, transaction: Any) -> dict[str, list[str]]:
    """The properties a transaction's specs name, by symbol, in order, through every term: what the frames it gives
    assign, wherever in it a frame is executed, so that the frames a layer below gives back of the rest of an
    expression assign what the whole expression names."""
    named: dict[str, list[str]] = {}
    terms = [_next(transaction, "mutations")]
    while terms:
        term = terms.pop(0)
        if term is None:
            continue
        kind = _kind(store, term)
        if kind in ("map", "upsert", "update"):
            for pattern in (entry.pattern for entry in getattr(term, {"map": "symbols", "upsert": "exists",
                                                                     "update": "apply"}[kind])):
                for symbol, items in _members(pattern).items():
                    names = named.setdefault(symbol, [])
                    names += [body["name"] for item in items for kind_, body in item.items()
                              if kind_ == "as_property" and body["name"] not in names]
        elif kind == "partition":
            terms += [entry.branch for entry in term.branches] + [_next(term, "none")]
        elif kind == "branch":
            terms.append(_next(term, "then"))
            continue
        terms.append(_next(term, "then"))
    return named


def _writes_schemas(store: Any, transaction: Any) -> bool:
    """Whether an expression writes schemas: an upsert or an update of it binds a symbol of a meta-schema. A cache
    layer runs such a transaction, an install, itself, after the layer below has, as a store with no layer below
    does."""
    terms = [_next(transaction, "mutations")]
    while terms:
        term = terms.pop()
        if term is None:
            continue
        kind = _kind(store, term)
        if kind in ("upsert", "update"):
            for entry in getattr(term, {"upsert": "exists", "update": "apply"}[kind]):
                if any(symbol.schema is not None and _meta(store, symbol.schema)
                       for symbol in entry.pattern.symbols.values()):
                    return True
        elif kind == "partition":
            terms += [entry.branch for entry in term.branches] + [_next(term, "none")]
        terms.append(_next(term, "then"))
    return False


def _members(pattern: Any) -> dict[str, list[Any]]:
    """A pattern's spec, by symbol: the members of each, its items in order."""
    members: dict[str, list[Any]] = {}
    for item in pattern.spec:
        for name, written in item.items():
            members.setdefault(name, []).extend(written)
    return members


def _identifies(store: Any, schema: Any, member: Any) -> bool:
    """Whether a spec's member gives its object's identity, by which an upsert finds it: a schema object's name (86),
    an owned object's owning entry (60)."""
    (kind, body), = member.items()
    if kind == "as_property":
        return body["name"] == "name" and _meta(store, schema)
    return kind == "as_adjacency" and schema.adjacencies[body["name"]].owner and \
        any(verb == "insert" for verb, _ in _verbs(body))


def _symbol_refs(entry: Any) -> list[dict[str, Any]]:
    """The references to symbols an entry gives, its own and those of the objects it defines."""
    found = []
    for item in entry["mutations"]:
        (kind, body), = item.items()
        if kind == "as_link":
            held = body["mutations"][0]["set"]
            if "reference" in held and "symbol" in held["reference"]:
                found.append(held["reference"])
            elif "def" in held:
                for member in held["def"]["mutations"]:
                    (member_kind, member_body), = member.items()
                    if member_kind == "as_adjacency":
                        for _, nested in _verbs(member_body):
                            for given in nested:
                                found += _symbol_refs(given)
    return found


def _given(verb: Any) -> Any:
    """A spec's property verb as `(present, plain)`."""
    return (True, verb["set"]["value"]) if "set" in verb else (False, None)


# --- The interpreter: what every layer interprets alike ---


class Interpreter(abc.ABC):
    """A layer's transaction interpreter, the base class of each kind of layer's: what every layer interprets alike
    ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#stacking-by-mutation-transactions)), so
    that each refuses what every layer refuses. It drives the walk of a transaction's terms (map, upsert, update,
    reduce, partition, then), binding symbols; the frames, each annotated with what failed as a term processed it
    ([CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)); unique clauses, which a layer checks at its commit
    (`_check_uniques`); and the stream `txn.exec` gives, each frame carrying its scope and, where it halted, its
    remainder, each input frame's frames ending with its completion marker, the first carrying its journal.

    Each kind of layer's class, coupled with the layer, gives what only that layer knows, as the hooks below: its
    reads of its own storage, which the interpreter drives as the walk needs them, not through the Store interface;
    its writes; and its transaction's savepoints. `store` is the store whose schemas the expressions are read by.
    An object the layer holds is, to the interpreter, what its hooks give for it, compared by identity
    ([CAP-315: every read within a transaction or through a follow](mbse:mbse-basis/docs/capabilities/CAP-315.md#design)): a store in memory's are its proxies'
    durable objects (`InMemory`)."""

    def __init__(self, store: Any):
        self.store = store
        self._reading = 0  # how deep in interpreting a term read-only: a write halts the frame (`_written`)

    # --- What a layer gives: reads of its own storage ---

    @abc.abstractmethod
    def candidates(self, schema: Any) -> list[Any]:
        """The objects a symbol of `schema` ranges over, among those the layer holds: a singleton schema's, its
        singleton; a meta-schema's, the named schema objects of its kind, the framework's left out; data's, every
        object of it."""

    @abc.abstractmethod
    def named(self, schema: Any, name: str | None) -> list[Any]:
        """The schema object of the meta-schema `schema` named `name`, the layer's own included, a module by its path,
        the root module where `name` is None; none where it holds none (86)."""

    @abc.abstractmethod
    def designated(self, path: Any) -> Any:
        """The object an object reference designates among what the layer holds, given the reference's path as plain
        data (`References.OfObject`'s `path`); None where it holds none (references 8 in
        [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided))."""

    @abc.abstractmethod
    def schema_of(self, target: Any) -> Any:
        """The schema of an object the layer holds."""

    @abc.abstractmethod
    def key(self, target: Any) -> Any:
        """What tells an object the layer holds apart from every other, hashable: frames that bind the same objects
        are one, where a reduce drops symbols, and a counted object an upsert made is found again by it (63)."""

    @abc.abstractmethod
    def value(self, holder: Any, schema: Any, name: str) -> tuple[bool, Any]:
        """A property's value, `(present, plain)`, as a spec gives it: the property `name` of `holder`, an object of
        `schema` or an entry of the relation whose entry schema is `schema`, its value as `Plain` writes it. Of a
        pattern (`Schemas.OfPattern`), `name` "spec", which is no property, gives its spec as recorded."""

    @abc.abstractmethod
    def entries(self, target: Any, schema: Any, name: str) -> list[Any]:
        """The entries of an object's adjacency `name`, `schema` the object's, in the order they were added: those of
        its relation that link it through the adjacency's link."""

    @abc.abstractmethod
    def link(self, entry: Any, name: str) -> Any:
        """The object an entry links through its link `name`, a parameter reference in its place (CAP-312); None where
        the link is not set."""

    @abc.abstractmethod
    def linking(self, target: Any, relation: Any) -> list[Any]:
        """Every entry of `relation` that links `target`, through any of its links: those a unique clause is checked
        against."""

    @abc.abstractmethod
    def part(self, entry: Any, name: str) -> Any:
        """An entry's property `name`, as its relation's unique clauses compare it, hashable; None where it is not
        set ([CAP-111: equality and ordering defined by the schema](mbse:mbse-basis/docs/capabilities/CAP-111.md))."""

    @abc.abstractmethod
    def shown(self, entry: Any, names: list[str]) -> str:
        """An entry's links and properties `names`, as a message shows them."""

    @abc.abstractmethod
    def given(self, target: Any, names: Iterable[str]) -> tuple[Any, dict[str, Any]]:
        """What a frame given back binds for an object, and assigns of it ([CAP-315: every read within a transaction or through a follow](mbse:mbse-basis/docs/capabilities/CAP-315.md#decided)): its
        reference, a `References.OfObject`, a value that outlives the transaction (a schema object as itself), or a
        `_Refused` where it has none; and the values it holds of its properties `names`, as data."""

    # --- What a layer gives: its writes, which the interpreter makes only writing (`_written`) ---

    @abc.abstractmethod
    def assign(self, target: Any, schema: Any, name: str, verb: Any) -> None:
        """Writes a property of an object of `schema`, as a spec's verb gives it, `{"set": {"value": plain}}` or
        `{"clear": {}}`; of a pattern, `name` "spec", its spec as recorded."""

    @abc.abstractmethod
    def insert(self, target: Any, schema: Any, name: str, links: dict[str, Any], values: dict[str, Any]) -> None:
        """Adds an entry to an object's adjacency `name`: linking it and `links`, each an object by its link, its
        properties `values`, plain, by name; replacing the one it holds where its relation lets it hold one at most,
        but where a removal from the relation removed nothing (CAP-293)."""

    @abc.abstractmethod
    def remove(self, target: Any, schema: Any, name: str, positions: list[int]) -> None:
        """Removes the entries of an object's adjacency `name` at `positions`, as `entries` gives them, deleting what
        an owning entry owned (object identity 48 in [CAP-121: owned objects deleted in cascade](mbse:mbse-basis/docs/capabilities/CAP-121.md#decided)); none, a removal that removed nothing,
        is noted (CAP-293)."""

    @abc.abstractmethod
    def create(self, schema: Any, values: dict[str, Any], within: tuple[Any, str] | None = None) -> Any:
        """A new object of `schema`, its properties `values` set, each by a spec's verb; `within`, where it is defined
        where an adjacency links it, the schema of the object that holds the adjacency and its name."""

    @abc.abstractmethod
    def upserted(self, index: tuple[Any, ...], made: Any = None) -> Any:
        """The counted object an upsert made for `index`, as long as the layer holds it, None where none (63); given
        `made`, remembers it."""

    # --- What a layer gives: its transaction ---

    @abc.abstractmethod
    def savepoint(self, journal: Any = None) -> AbstractContextManager[list[Any]]:
        """A savepoint within the layer's transaction open: its writes kept where the block ends, dropped where it
        raises. Given `journal`, a function giving the id of the changes it made, the list it gives holds them once the
        block has ended, a `Changes.Transaction` of the layer's, or None where none were made; else it stays empty."""

    @abc.abstractmethod
    def uid(self) -> str:
        """The uid of the transaction open, as its record and its journal give it: an upsert that gives no key is keyed
        by it (102 in [CAP-139: upserts find before they create](mbse:mbse-basis/docs/capabilities/CAP-139.md#decided))."""

    # --- What a layer gives: what it does where it holds no such object ---

    cache = False
    """Whether the layer is a cache layer, a store over another, which interprets read-only over what it can know it
    holds all of, halting a frame elsewhere for the layer below (a cache layer's completeness rule)."""

    life: Any = None
    """The life of the layer's transaction open, given to a frame's `_Refused` so that it is resumed within it."""

    def knows(self, target: Any) -> bool:
        """Whether the layer holds all of an object, so that its interpreter may read it: a layer with no layer below
        holds all it holds."""
        return True

    # --- The stream ---

    def exec(self, txn: Transaction, frame: Any, remainder: Any, allow_write: bool) -> Iterator[Any]:
        """`txn.exec`: the stream of the frames `remainder`, a `Remainder` or a whole transaction's expression, makes
        of `frame`, a frame or a stream of them, within `txn`."""
        return self._exec(txn, frame, _remainder(self.store, Proxies._durable(remainder)), allow_write)

    def _exec(self, txn: Transaction, given: Any, remainder: Remainder, write: bool) -> Iterator[Any]:
        """`txn.exec`'s stream ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)), within the transaction `txn` holds: each input frame, as it
        arrives, extended through `remainder`, its frames given as they are made of it, then `{"end": scope}`, `scope` its
        id. Each given back holds references and assignments (CAP-315), carries its input frame's id, `scope`, and, where
        it halted read-only, its `remainder`. An error a term meets processing a frame is annotated on it (CAP-309). An
        error of no one frame is raised, its `frames` every frame the transaction gave, and those made of the input frame
        it arose processing. What each input frame changed, a savepoint's, is carried by its first frame, else by its
        completion marker, as a one-transaction journal whose id is the transaction's uid and the frame's position."""
        from . import Changes

        inputs = [given] if isinstance(given, Mapping) else given  # a frame, or a stream of them, consumed as it arrives
        made: list[Frame] = []
        try:
            named = _named(self.store, remainder.transaction)
            for index, frame in enumerate(inputs):
                txn._open()
                scope = str(index) if getattr(frame, "scope", None) is None else frame.scope
                with self.savepoint(lambda: f"{self.uid()}#{len(txn._given)}") as changed:
                    given_back = self._extended(remainder, frame, write, named, scope, made)
                made = []
                marker: dict[str, Any] = {"end": scope}
                if changed and changed[0] is not None:  # carried by its first frame, else by its completion marker
                    journal = Changes._journal(self.store, [changed[0]])
                    if given_back:
                        given_back[0].journal = journal
                    else:
                        marker["journal"] = journal
                for item in given_back:
                    txn._given.append(item)
                    yield item
                yield marker
        except Exception as error:
            error.frames = txn._given + made  # type: ignore[attr-defined]
            raise

    def _extended(self, remainder: Remainder, frame: Mapping[str, Any], write: bool, named: dict[str, list[str]],
                  scope: str, made: list[Frame]) -> list[Frame]:
        """The frames given back of one input frame, extended through `remainder`; `made` gathers them as made, for an
        error raised after."""
        made += self._one(remainder, frame, write, named, scope)
        return self._given_back(made, named, scope)

    def _execute(self, transaction: Any) -> list[Frame]:
        """Executes a transaction's expression over the layer, sequentially (object identity 85 to 89 in [FEA-030: clean mutation-based transactional API](mbse:mbse-basis/docs/features/FEA-030.md)): its
        stream starts as one frame, empty, which its root term transforms and passes on through `then`, within a
        savepoint of the transaction open. Gives the frames its chain ends with, as bound. Where a frame is annotated
        with an error, it writes nothing and raises the first error annotated (`_raised`)."""
        return _raised(self._frames(transaction))

    def _frames(self, transaction: Any) -> list[Frame]:
        """The frames a transaction's expression gives, raising nothing for an error a term meets processing a frame:
        that frame is annotated with it, as bound as it was, and the others go on ([CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)). Gives the frames
        its chain ends with, then those annotated, in the order their errors arose; where one is, its writes are
        dropped, whole (CAP-124), else committed into the transaction open. An error in the expression itself, found
        before it runs, is raised, its `frames` none; one raised at the commit, which no frame made, is raised as it
        is, its `frames` all the frames, none annotated. What `txn.exec` gives, as a stream, is `_exec`'s."""
        root = _next(transaction, "mutations")
        made: list[Frame] = []
        try:
            if root is not None:
                _check(self.store, root, set())
            with self.savepoint():
                run = _Run(transaction, True, {}, None)
                made = [Frame()] if root is None else self._run(root, [Frame()], ("mutations", 0, _kind(self.store, root)),
                                                                run)
                made += run.failed
                if run.failed:
                    raise _Uncommitted()
        except _Uncommitted:
            pass
        except Exception as error:
            error.frames = made  # type: ignore[attr-defined]
            raise
        return made

    def _given_back(self, frames: list[Frame], named: dict[str, list[str]], scope: str | None = None) -> list[Frame]:
        """The frames a transaction gives back, made within it: each symbol's object by its reference, and what it
        assigns, as data (CAP-315, `given`); each carrying `scope`, and its remainder where it halted."""
        given = []
        for frame in frames:
            bound: dict[str, Any] = {}
            assigns = {name: dict(values) for name, values in frame.assigns.items()}  # a layer below's, where it gave them
            for symbol, target in dict.items(frame):
                bound[symbol], held = self.given(target, named.get(symbol, ()))
                if held:
                    assigns.setdefault(symbol, {}).update(held)
            given.append(Frame(bound, frame.errors, assigns, frame.remainder, scope))
        return given

    # --- The walk of the terms ---

    def _one(self, remainder: Remainder, given: Mapping[str, Any], write: bool, named: dict[str, list[str]],
             scope: str) -> list[Frame]:
        """The frames one input frame gives, within the transaction open: those the remainder's chain ends with, then
        those that halted read-only, then those annotated with an error. A frame given annotated is given back as it
        is, executed no further; one whose reference designates nothing is annotated so, but where a cache layer
        interprets read-only, where it holds the reference, unresolved, and halts. An error in the expression, as the
        frame's symbols leave it, is raised."""
        frame = self._taken(given, remainder, not write and self.cache)
        if frame.errors or not remainder.at:  # annotated, given back as it is; or nothing to execute
            return [frame]
        term = _term_at(remainder.transaction, remainder.at)
        _check(self.store, term, set(frame))
        run = _Run(remainder.transaction, write, named, scope)
        made = self._run(term, [frame], remainder.at, run)
        return made + run.halted + run.failed

    def _taken(self, given: Mapping[str, Any], remainder: Remainder, keep: bool = False) -> Frame:
        """An input frame, as the interpreter binds: each symbol's object by what its reference designates, a schema
        object or a layer's object as itself; annotated where one designates nothing, or is refused (CAP-309); `keep`,
        a reference that designates nothing the layer holds kept as it is, unresolved (`_unresolved`)."""
        frame = Frame(errors=getattr(given, "errors", ()), assigns=getattr(given, "assigns", None))
        for name, value in given.items():  # a frame's as it holds them, a refused one's among them
            try:
                frame[name] = self._bound(name, value)
            except _Absent:
                if keep:
                    frame[name] = Proxies._durable(value)
                    continue
                error = LookupError(f"symbol {name!r} of the frame: no object of the store has its reference's path")
                frame.errors.append(FrameError(remainder.subterm, type(error).__name__, str(error), error))
            except LookupError as error:
                frame.errors.append(FrameError(remainder.subterm, type(error).__name__, str(error), error))
        return frame

    def _bound(self, name: str, value: Any) -> Any:
        """What a symbol of an input frame binds: the object its reference designates, else what it holds."""
        if isinstance(value, _Refused):
            if value._life is self.life and value._target is not None:  # given back within this transaction
                return value._target
            raise LookupError(f"symbol {name!r} of the frame: {value.message}")
        target = Proxies._deref(value)
        if isinstance(target, Proxies._RecordData) and target._schema is self.store.registered("References.OfObject"):
            found = self.designated(Plain.ToPlain(self.store)(target._schema, target)["path"])
            if found is None:
                raise _Absent()
            return Proxies._durable(found)
        return Proxies._durable(value)

    def _unresolved(self, frame: Mapping[str, Any]) -> bool:
        """Whether a frame holds a reference that designates nothing the layer holds, which a cache layer's
        interpretation read-only kept (`_taken`): it halts at the next term, for the layer below to resolve."""
        reference = self.store.registered("References.OfObject")
        return any(isinstance(value, Proxies._RecordData) and value._schema is reference for value in dict.values(frame))

    @contextlib.contextmanager
    def _read_only(self) -> Iterator[None]:
        """A read-only interpretation of a term over a frame (`txn.exec`, `allow_write` false): a write it would make
        halts the frame (`_written`)."""
        self._reading += 1
        try:
            yield
        finally:
            self._reading -= 1

    def _written(self) -> None:
        """Before each write the interpreter makes: within a read-only interpretation, the frame halts (`_Halt`),
        writing nothing."""
        if self._reading:
            raise _Halt()

    def _run(self, term: Any, frames: list[Frame], at: tuple[str | int, ...], run: _Run) -> list[Frame]:
        """The frames a term, `at` its path in the expression's wire form, and those after it, make of `frames`: those
        its chain ends with. A frame a term fails to process is annotated with the error, as bound as it was, and added
        to `run.failed`, the others going on ([CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)). `run.named` gathers, by symbol, the properties
        the specs name, in order: what the frames given back assign.

        Read-only (`run.write` false), a term is interpreted over each frame within a savepoint, and where it would
        write, or a map finds nothing the layer holds to bind a symbol, the frame halts, added to `run.halted` with its
        remainder: as it was given to the term, or, where a map bound some of its symbols, binding those. A partition
        keeps its join: a frame halted within a branch is sent below with the rest of the branch alone, and what comes
        back is joined (`_below`)."""
        store = self.store
        kind = _kind(store, term)
        if kind in ("map", "upsert", "update"):
            pattern = _pattern(term, {"map": "symbols", "upsert": "exists", "update": "apply"}[kind], kind)
            for symbol, items in _members(pattern).items():
                names = run.named.setdefault(symbol, [])
                names += [body["name"] for item in items for kind_, body in item.items()
                          if kind_ == "as_property" and body["name"] not in names]
            key = (store.member(term, "key") or self.uid()) if kind == "upsert" else None
            made: list[Frame] = []
            for frame in frames:
                try:
                    if run.write:
                        made += self._term(kind, pattern, frame, key, None)
                        continue
                    if self.cache and (kind != "map" or self._unresolved(frame)):
                        run.halt(frame, at)  # a cache layer's: what writes, or what it cannot resolve, the layer below
                        continue
                    halted: list[dict[str, Any]] = []
                    try:
                        with self.savepoint(), self._read_only():  # a savepoint: what a halted term began, dropped
                            made += self._term(kind, pattern, frame, key, halted)
                    except _Halt:  # it would write: the frame halts at the term, as it was given to it
                        run.halt(frame, at)
                        continue
                    for partial in halted:  # a symbol nothing the layer holds binds: the frame halts within the term
                        run.halt(Frame(partial), at)
                except Exception as error:
                    frame.errors.append(FrameError(Errors.path(*at), type(error).__name__, str(error), error))
                    run.failed.append(frame)
            frames = made
        elif kind == "reduce":
            dropped = set(next(iter(term.symbols)).collector.symbols)
            unique: dict[tuple[Any, ...], Frame] = {}
            if not run.write and self.cache:
                for frame in [frame for frame in frames if self._unresolved(frame)]:
                    run.halt(frame, at)  # a cache layer's: it cannot tell what it does not hold apart
                frames = [frame for frame in frames if frame.remainder is None]
            for frame in frames:
                kept = Frame({name: target for name, target in frame.items() if name not in dropped})
                unique.setdefault(tuple((name, self.key(target)) for name, target in kept.items()), kept)
            frames = list(unique.values())
        elif kind == "partition":
            arms = [((*at, "branches", index), entry.branch) for index, entry in enumerate(term.branches)]
            first = store.member(term, "first")
            if arms and (first or store.member(term, "last")):  # every branch matches, none requiring constraints (87)
                arms = [arms[0] if first else arms[-1]]
            otherwise = _next(term, "none")
            if not arms and otherwise is not None:
                arms = [((*at, "none", 0, _kind(store, otherwise)), otherwise)]
            joined: list[Frame] = []
            for arm_at, arm in arms:
                branch = run.arm()
                joined += self._run(arm, [Frame(frame) for frame in frames], arm_at, branch)
                for partial in branch.halted:  # the layer that split keeps the join
                    joined += self._below(run, partial)
            frames = joined
        after = _next(term, "then")
        return frames if after is None else self._run(after, frames, (*at, "then", 0, _kind(store, after)), run)

    def _term(self, kind: str, pattern: Any, frame: Frame, key: str | None,
              halted: list[dict[str, Any]] | None) -> list[Frame]:
        """The frames a map, an upsert or an update makes of one frame; `halted`, where it interprets read-only,
        gathers the frames a map halts within it."""
        if kind == "update":
            self._write_spec(pattern, frame)
            return [frame]
        return [Frame(found) for found in self._bind(pattern, frame, kind == "upsert", key, halted)]

    def _below(self, run: _Run, partial: Frame) -> list[Frame]:
        """The frames a branch ends with where a frame halted within it, the rest of the branch alone executed below,
        collected until the completion marker of the scope it was sent with, a branch's own: here by the loopback, the
        layer having no layer below ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)). Those annotated with an error go on to
        `run.failed`, as they came."""
        partial.scope = f"{run.scope}/{next(run.sent)}"
        joined: list[Frame] = []
        stream = self._loopback(run, partial)
        item = next(stream)
        while isinstance(item, Frame):  # until the completion marker, `{"end": scope}`
            (run.failed if item.errors else joined).append(item)
            item = next(stream)
        return joined

    def _loopback(self, run: _Run, frame: Frame) -> Iterator[Any]:
        """What a layer with no layer below gives back for a frame sent below with its remainder: the frame executed
        again by the same layer, writing, within the transaction open; its frames, each carrying the frame's scope, then
        the completion marker, `{"end": scope}`."""
        for made in self._one(frame.remainder, frame, True, run.named, frame.scope):
            made.scope = frame.scope
            yield made
        yield {"end": frame.scope}

    def _bind(self, pattern: Any, frame: dict[str, Any], upsert: bool, key: str | None = None,
              halted: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
        """The frames binding a pattern's symbols that `frame` does not, each to every object of its schema whose
        members its spec gives hold: a singleton's to the singleton (77). A symbol given a reference binds what it
        designates, and no frame where the layer holds none (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)). An upsert creates, where none is
        found, the object of a symbol, and writes its spec where it does not hold; a counted object it created before
        from the same frame, for the same symbol and key, it finds again (63), and finds none otherwise (102).
        Read-only, a map gives to `halted`, rather than dropping, each frame as bound so far where nothing the layer
        holds binds a symbol."""
        store = self.store
        members = _members(pattern)
        frames = [dict(frame)]
        cache = halted is not None and self.cache  # a cache layer's, read-only: what it can know alone
        for name, symbol in pattern.symbols.items():
            if name in frame:
                continue
            reference = _given_reference(symbol)
            if reference is not None:  # what it designates, or no frame where the layer holds none (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided))
                path = Plain.ToPlain(store)(reference.as_schema(), reference)["path"]
                target = Proxies._durable(self.designated(path))
                if target is None and halted is not None:
                    halted += frames
                frames = [] if target is None else [{**partial, name: target} for partial in frames]
                continue
            schema = symbol.schema
            if cache and schema.singleton is None:  # it cannot know it holds every object of a schema: below
                halted += frames
                return []
            grown = []
            for partial in frames:
                if schema.singleton is not None:
                    grown += [{**partial, name: target} for target in self.candidates(schema)]
                    continue
                if upsert and Proxies._counted_schema(schema) and not _meta(store, schema):  # found only by what made it (102)
                    index = self._upsert_index(key, name, frame)
                    made = self.upserted(index)
                    if made is None:
                        self._written()
                        made = self.create(schema, {})
                        self.upserted(index, made)
                    grown.append({**partial, name: made})
                    continue
                own = members.get(name, [])
                identifying = [member for member in own if _identifies(store, schema, member)]
                located = None if identifying else self._located(pattern, members, name, schema, partial)
                if located is not None:  # placed by its owner's entries, which a symbol bound before it gives (60)
                    found = located
                elif identifying and _meta(store, schema):  # a schema object by its name, the store's own included (86)
                    (_, body), = identifying[0].items()
                    found = self.named(schema, _given(body["mutations"][0])[1])
                else:
                    found = [target for target in self.candidates(schema)
                             if self._holds(target, schema, identifying or own, partial, partial)]
                if not found and halted is not None and not upsert:
                    halted.append(partial)
                if found or not upsert:
                    grown.extend({**partial, name: target} for target in found)
                    continue
                grown.append({**partial, name: self._created(schema, identifying)})
            frames = grown
        if upsert:
            for bound in frames:
                self._write_spec(pattern, bound)
            return frames
        kept = []
        for bound in frames:
            if cache and not all(self.knows(bound[name]) for name in members):
                halted.append(bound)  # what its spec reads, it does not hold all of: below
            elif all(self._holds(bound[name], self._schema(pattern, name, bound), items, bound, None)
                     for name, items in members.items()):
                kept.append(bound)
        return kept

    def _schema(self, pattern: Any, name: str, frame: dict[str, Any]) -> Any:
        """The schema of the object a pattern's symbol binds in `frame`: its own, or, given a reference, the bound
        object's."""
        schema = pattern.symbols[name].schema
        return self.schema_of(frame[name]) if schema is None else schema

    def _upsert_index(self, key: str | None, name: str, frame: dict[str, Any]) -> tuple[Any, ...]:
        """What tells apart a counted object an upsert makes (63): the upsert's key, the symbol, and the objects of the
        frame that reached it, each as the layer tells it apart."""
        return key, name, tuple((bound, self.key(target)) for bound, target in sorted(frame.items()))

    def _created(self, schema: Any, identifying: list[Any]) -> Any:
        """An object an upsert makes where it finds none: a schema object made with the name it was looked up by, so
        that what links it before its spec is written links a named schema (86)."""
        values = {body["name"]: body["mutations"][0]
                  for member in identifying for kind, body in member.items() if kind == "as_property"}
        self._written()
        return self.create(schema, values)

    def _located(self, pattern: Any, members: dict[str, list[Any]], name: str, schema: Any,
                 frame: dict[str, Any]) -> Any:
        """Where a symbol's object is owned through an adjacency it has no name for, the entry that places it in a
        symbol's spec bound before it (object identity 60 in [CAP-139: upserts find before they create](mbse:mbse-basis/docs/capabilities/CAP-139.md#decided)): the objects linked by each of the owner's entries
        agreeing with the properties it gives, one where they give its keys, every one where they leave them open,
        none where none agrees; None where no spec gives such an entry."""
        owning = [a for a in (*schema.adjacencies.values(), *schema.anonymous) if a.owner]
        for other, items in members.items():
            if other not in frame or not owning:
                continue
            for item in items:
                (kind, body), = item.items()
                if kind != "as_adjacency":
                    continue
                other_schema = self._schema(pattern, other, frame)
                relation = other_schema.adjacencies[body["name"]].relation
                for entry in (entry for verb, entries in _verbs(body) if verb == "insert" for entry in entries):
                    link = next((part["as_link"]["name"] for part in entry["mutations"] if "as_link" in part
                                 and part["as_link"]["mutations"][0]["set"].get("reference", {}).get("symbol") == name),
                                None)
                    if link is None or not any(a.relation is relation and a.me == link for a in owning):
                        continue
                    given = [part["as_property"] for part in entry["mutations"] if "as_property" in part]
                    return [self.link(held, link) for held in self.entries(frame[other], other_schema, body["name"])
                            if all(self.value(held, relation.entry, p["name"]) == _given(p["mutations"][0])
                                   for p in given)]
        return None

    def _holds(self, target: Any, schema: Any, members: list[Any], frame: dict[str, Any],
               partial: dict[str, Any] | None) -> bool:
        """Whether what a spec gives of an object holds of `target`: its properties' values, the entries it inserts
        held, and those it removes absent, none where it clears the adjacency. Finding the object of a symbol
        (`partial`, the frame as bound so far), an entry linking a symbol not yet bound is left out."""
        for member in members:
            (kind, body), = member.items()
            if kind == "spec":
                if self.value(target, schema, "spec") != (True, body["items"]):
                    return False
                continue
            name = body["name"]
            if kind == "as_property":
                if self.value(target, schema, name) != _given(body["mutations"][0]):
                    return False
                continue
            relation = schema.adjacencies[name].relation
            held = self.entries(target, schema, name)
            unmatched = list(held)
            for verb, entries in _verbs(body):
                if verb == "clear" and held:
                    return False
                for entry in entries:
                    if partial is not None and any(target_ref.get("symbol") not in partial
                                                   for target_ref in _symbol_refs(entry)):
                        continue
                    if verb == "insert" and self._match(relation, unmatched, entry, frame) is None:
                        return False
                    if verb == "remove" and self._removed(relation, held, [entry], frame):
                        return False
        return True

    def _matches(self, relation: Any, held: Any, entry: Any, frame: dict[str, Any]) -> bool:
        """Whether an entry held is one a spec gives: the objects it links, and its properties' values."""
        for item in entry["mutations"]:
            (kind, body), = item.items()
            name = body["name"]
            if kind == "as_property":
                if self.value(held, relation.entry, name) != _given(body["mutations"][0]):
                    return False
                continue
            given = body["mutations"][0]["set"]
            linked = self.link(held, name)
            if Proxies._is_parameter(linked) or Plain._is_marked(given.get("reference")):  # by the parameter's name (CAP-312)
                if "reference" not in given or not Proxies._is_parameter(linked) or \
                        Proxies._link_key(linked) != Proxies._link_key(self._resolve(given["reference"], frame)):
                    return False
                continue
            if "def" in given:
                definition = given["def"]
                schema = self.store.registered(definition["schema"])
                if self.schema_of(linked) is not schema or not self._holds(
                        linked, schema, definition["mutations"], frame, None):
                    return False
            elif linked is not self._resolve(given["reference"], frame):
                return False
        return True

    def _resolve(self, ref: dict[str, Any], frame: dict[str, Any]) -> Any:
        """The object a spec's reference names: the one a symbol binds, or the one at a path; or the parameter
        reference standing in its place (CAP-312)."""
        if Plain._is_marked(ref):
            return Proxies._durable(Plain._unmarked(self.store, ref))
        if "symbol" in ref:
            return Proxies._durable(frame[ref["symbol"]])
        found = Proxies._durable(self.designated(ref["path"]))
        if found is None:
            raise LookupError("no object of the store has the path a spec refers to")
        return found

    def _write_spec(self, pattern: Any, frame: dict[str, Any]) -> None:
        """Writes a pattern's spec over a frame where it does not hold (object identity 76 in [CAP-137: patterns of symbols, variables and specs](mbse:mbse-basis/docs/capabilities/CAP-137.md#decided))."""
        for name, members in _members(pattern).items():
            self._write(frame[name], self._schema(pattern, name, frame), members, frame)

    def _write(self, target: Any, schema: Any, members: list[Any], frame: dict[str, Any]) -> None:
        """Writes what a spec gives of an object where it does not hold: a property's value, an entry, its links
        resolved and the objects it defines made, and a pattern's spec, as recorded."""
        for member in members:
            (kind, body), = member.items()
            if kind == "spec":
                if not self._holds(target, schema, [member], frame, None):
                    self._written()
                    self.assign(target, schema, "spec", {"set": {"value": body["items"]}})
                continue
            name = body["name"]
            if kind == "as_property":
                verb = body["mutations"][0]
                if self.value(target, schema, name) == _given(verb):
                    continue
                self._written()
                self.assign(target, schema, name, verb)
                continue
            adjacency = schema.adjacencies[name]
            for verb, entries in _verbs(body):
                held = self.entries(target, schema, name)
                if verb != "insert":
                    self._remove(target, schema, name, None if verb == "clear" else entries, held, frame)
                    continue
                for entry in entries:
                    if self._match(adjacency.relation, held, entry, frame) is None:
                        self._insert(target, schema, name, entry, frame)

    def _removed(self, relation: Any, held: list[Any], entries: list[Any], frame: dict[str, Any]) -> list[int]:
        """The positions of the entries `held` that agree with one of the entries a spec removes."""
        return [index for index, candidate in enumerate(held)
                if any(self._matches(relation, candidate, entry, frame) for entry in entries)]

    def _remove(self, target: Any, schema: Any, name: str, entries: list[Any] | None, held: list[Any],
                frame: dict[str, Any]) -> None:
        """Removes from an object's adjacency, `held` as read, each entry that agrees with one of `entries`, a spec's
        removal, or every entry where it gives None (`clear`); a removal that removed nothing is given the layer too,
        which notes it (CAP-293)."""
        relation = schema.adjacencies[name].relation
        removed = list(range(len(held))) if entries is None else self._removed(relation, held, entries, frame)
        if removed:
            self._written()
        if removed or entries is not None:
            self.remove(target, schema, name, removed)

    def _match(self, relation: Any, held: list[Any], entry: Any, frame: dict[str, Any]) -> Any:
        """The first of the entries `held` that agrees with an entry a spec gives, taken from them, so that the k-th
        equal entry a spec gives is the k-th such entry held; None where none agrees."""
        for index, candidate in enumerate(held):
            if self._matches(relation, candidate, entry, frame):
                return held.pop(index)
        return None

    def _insert(self, target: Any, schema: Any, name: str, entry: Any, frame: dict[str, Any]) -> None:
        """Adds an entry a spec gives to an object's adjacency: its links resolved, the objects it defines made, its
        properties as given, but one cleared, with which it is inserted without it."""
        links: dict[str, Any] = {}
        values: dict[str, Any] = {}
        for item in entry["mutations"]:
            (kind, body), = item.items()
            if kind == "as_property":
                verb = body["mutations"][0]
                if "set" in verb:  # a property cleared: the entry is inserted without it
                    values[body["name"]] = verb["set"]["value"]
                continue
            given = body["mutations"][0]["set"]
            if "def" in given:
                definition = given["def"]
                defined = self.store.registered(definition["schema"])
                self._written()
                made = self.create(defined, {}, (schema, name))
                self._write(made, defined, definition["mutations"], frame)
                links[body["name"]] = made
            else:
                links[body["name"]] = self._resolve(given["reference"], frame)
        self._written()
        self.insert(target, schema, name, links, values)

    # --- Unique clauses, which a layer checks at its commit ---

    def _check_uniques(self, relation: Any, inserted: list[Any]) -> None:
        """Raises `ValueError` where an entry `inserted` agrees with another entry of `relation` on the key of one of its
        `unique` clauses, the clause's complement, every link and property outside it, and so differs on the clause
        ([CAP-155: `unique` clauses on relation schemas govern relation cardinality](mbse:mbse-basis/docs/capabilities/CAP-155.md)): what a layer checks at its commit, once a transaction's
        writes are all made (CAP-124), each entry it inserted against those its result holds. The entries that could
        agree with one are those held by the object it links through a link of the key, all of them (`linking`), and
        the others inserted. Where the key holds no link that links an object present, those are the ones held by
        every object it links and the others inserted."""
        names = [*relation.entry.links, *relation.entry.properties]

        def part(entry: Any, name: str) -> Any:
            target = self.link(entry, name)
            if target is not None:
                return ("link", Proxies._link_key(target))
            return ("value", self.part(entry, name))

        def identity(entry: Any) -> Any:  # what an entry is held by: itself in an open relation, else its value
            return ("entry", id(entry)) if relation.open else tuple(part(entry, name) for name in names)

        def objects(entry: Any, among: Iterable[str]) -> list[Any]:
            return [target for target in (self.link(entry, name) for name in among)
                    if target is not None and not Proxies._is_parameter(target)]

        for clause in relation.uniques:
            key = [name for name in names if name not in clause]
            held: dict[Any, dict[Any, Any]] = {}  # the entries that could agree, by their key's values
            scanned: set[int] = set()
            for entry in inserted:
                held.setdefault(tuple(part(entry, n) for n in key), {}).setdefault(identity(entry), entry)
                for target in objects(entry, key)[:1] or objects(entry, relation.entry.links):
                    if id(target) not in scanned:
                        scanned.add(id(target))
                        for other in self.linking(target, relation):
                            held.setdefault(tuple(part(other, n) for n in key), {}).setdefault(identity(other), other)
            for entry in inserted:
                agreeing = held.get(tuple(part(entry, n) for n in key), {})
                other = next((e for k, e in agreeing.items() if k != identity(entry)), None)
                if other is not None:
                    raise ValueError(
                        f"an entry of {relation.name!r} breaks unique({', '.join(sorted(clause))}): two entries agree on "
                        f"its key, the links and properties outside it, {self.shown(entry, key)}, and differ on it, "
                        f"{self.shown(other, sorted(clause))} and {self.shown(entry, sorted(clause))}; an entry is "
                        "refused, not replaced: remove the one held to write the other")


# --- A store in memory: the layer-coupled interpreter of `Builders.Store` ---


def _transaction_uid(store: Any) -> str:
    """The uid of the transaction open, as `Provenance` records it and its journal gives it: an upsert that gives no key
    is keyed by it, so that a counted object it makes is found again where the same transaction is replayed, and by no
    other transaction (102 in [CAP-139: upserts find before they create](mbse:mbse-basis/docs/capabilities/CAP-139.md#decided))."""
    from . import Provenance

    return Provenance._uid(store, _outermost(store._proposals))


def _outermost(proposals: Any) -> Any:
    """The proposals of the transaction open, those of a savepoint within it given: the outermost."""
    from . import Proposals

    while isinstance(proposals.base, Proposals.OfStore):  # a savepoint's: the transaction's are the outermost
        proposals = proposals.base
    return proposals


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
    a schema object, else the data it links (an extension's relation's, or data's entry)."""
    from . import Builders

    if not isinstance(value, Builders._Link):
        return Proxies._durable(value)  # compared by identity with what frames bind: durable objects
    target = value._target()
    return target._original if isinstance(target, Builders._Builder) else target


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


class InMemory(Interpreter):
    """The interpreter of a store in memory, `Builders.Store`, coupled with it: it reads the store's objects, its
    proxies' durable objects, as the store's own visitors and builders do, within the transaction open, and writes them
    through its builders, a schema object's through its meta-schema's. A store given a layer below, a cache layer,
    interprets read-only over what it holds all of, halting a frame elsewhere, and sends each frame and the rest of the
    expression to the layer below's transaction, writing (`_cached`); an install it runs the layer below's first, then
    its own ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below))."""

    # --- Its reads ---

    def candidates(self, schema: Any) -> list[Any]:
        store = self.store
        if schema.singleton is not None:
            return [store._singleton_of(schema.singleton)]
        if not _meta(store, schema):
            return [Proxies._durable(found) for found in store.extent(store.name_of(schema))]
        return [held for held in store._objects.values()
                if not store.framework(held) and _reader(store, held).as_schema() is schema]

    def named(self, schema: Any, name: str | None) -> list[Any]:
        store = self.store
        if schema is store.registered("Schemas.OfModule"):
            held = store._modules.get(name or "")
            return [] if held is None else [held]
        try:
            held = store.registered(name)
        except LookupError:
            return []
        return [held] if _reader(store, held).as_schema() is schema else []

    def designated(self, path: Any) -> Any:
        try:
            return Plain._by_path(self.store, path, ())
        except Plain.DecodeError:  # a schema object's path whose steps name no entries: nothing has it
            return None

    def schema_of(self, target: Any) -> Any:
        return _reader(self.store, target).as_schema()

    def key(self, target: Any) -> Any:
        return Proxies._key_of(_reader(self.store, target))

    def value(self, holder: Any, schema: Any, name: str) -> tuple[bool, Any]:
        visitor = _reader(self.store, holder)
        if name not in schema.properties:  # a pattern's spec, as recorded
            return True, [dict(item) for item in visitor._working.spec]
        return Plain._value(getattr(visitor, name), schema.properties[name].schema, Plain._Values(self.store))

    def entries(self, target: Any, schema: Any, name: str) -> list[Any]:
        return list(getattr(_reader(self.store, target), name))

    def link(self, entry: Any, name: str) -> Any:
        return _linked(entry._links.get(name) if isinstance(entry, Proxies._Entry) else getattr(entry, name))

    def linking(self, target: Any, relation: Any) -> list[Any]:
        return list(Proxies._table(target, id(relation), self.store).values())

    def part(self, entry: Any, name: str) -> Any:
        value = entry._properties.get(name)
        return None if value is None else Proxies._scalar_key(value)

    def shown(self, entry: Any, names: list[str]) -> str:
        return Proxies._shown_parts(entry, names)

    def given(self, target: Any, names: Iterable[str]) -> tuple[Any, dict[str, Any]]:
        from . import References

        store = self.store
        if not isinstance(target, Proxies._ObjectData):
            return target, {}  # a schema object, as itself
        if Proxies._counted(target):
            return _Refused(f"a counted {target._schema_name!r} has no reference: nothing names it (make it a "
                            "singleton's or an owner's)", target, store._life), {}
        if Proxies._deleted(target):
            return _Refused(f"a {target._schema_name!r} the transaction deleted has no reference: nothing designates "
                            "it"), {}
        reference = References.of(store, target)
        values = store.values(target)
        return reference, {name: Proxies._copied(values[name]) for name in names if name in values}

    # --- Its writes, through its builders ---

    def assign(self, target: Any, schema: Any, name: str, verb: Any) -> None:
        store = self.store
        builder = _writer(store, schema, target)
        if name not in schema.properties:  # a pattern's spec, in place of what it held
            builder._working.spec = tuple(dict(item) for item in verb["set"]["value"])
        else:
            prop = schema.properties[name]
            Plain._set(builder, name, Plain._decode(prop.schema, verb["set"]["value"], (), store) if "set" in verb else None)
        builder.update()

    def insert(self, target: Any, schema: Any, name: str, links: dict[str, Any], values: dict[str, Any]) -> None:
        store = self.store
        adjacency = schema.adjacencies[name]
        properties = adjacency.relation.entry.properties
        decoded = {prop: Plain._decode(properties[prop].schema, plain, (), store) for prop, plain in values.items()}

        def fill(added: Any) -> Any:
            for link, linked in links.items():
                getattr(added, link)(linked)
            for prop, value in decoded.items():
                Plain._set(added, prop, value)
            return added

        builder = _writer(store, schema, target)
        member = getattr(builder, name)
        # one entry at most: the one held is replaced, but where a removal from the relation removed nothing, so that the
        # entry inserted beside it is refused at the commit (CAP-293)
        if Proxies._single(adjacency.relation, adjacency.me) and not Proxies._missed(store, adjacency.relation):
            member(lambda held: held.remove(lambda old: old))
        member(lambda held: held.insert(fill))
        builder.update()

    def remove(self, target: Any, schema: Any, name: str, positions: list[int]) -> None:
        store = self.store
        if not positions:  # a removal that removed nothing: what a writer whose view was stale sends (CAP-293)
            Proxies._note_missed(store, schema.adjacencies[name].relation)
            return
        builder = _writer(store, schema, target)  # its builder removes the entries it holds at those positions
        member = getattr(builder, name)
        written = list(member)
        for index in positions:
            member.remove(written[index])
        builder.update()

    def create(self, schema: Any, values: dict[str, Any], within: tuple[Any, str] | None = None) -> Any:
        store = self.store
        builder = _writer(store, schema) if within is None else _defining(store, *within, schema)
        for name, verb in values.items():
            Plain._set(builder, name, Plain._decode(schema.properties[name].schema, verb["set"]["value"], (), store))
        return Proxies._durable(builder.create())

    def upserted(self, index: tuple[Any, ...], made: Any = None) -> Any:
        if made is not None:
            self.store._upserted[index] = weakref.ref(made)
            return made
        held = self.store._upserted.get(index)
        return held() if held is not None else None

    # --- Its transaction ---

    @contextlib.contextmanager
    def savepoint(self, journal: Any = None) -> Iterator[list[Any]]:
        from . import Changes

        store = self.store
        changed: list[Any] = []
        if journal is None:
            with store._joined():
                yield changed
            return
        with store._proposing(lambda proposals: changed.append(Changes._gather(store, proposals, journal()))):
            yield changed

    def uid(self) -> str:
        return _transaction_uid(self.store)

    @property
    def cache(self) -> bool:  # type: ignore[override]
        return self.store._below is not None

    @property
    def life(self) -> Any:  # type: ignore[override]
        return self.store._life

    def knows(self, target: Any) -> bool:
        return self.store._knows(target)

    # --- Its stream, and a cache layer's ---

    def exec(self, txn: Transaction, frame: Any, remainder: Any, allow_write: bool) -> Iterator[Any]:
        """`txn.exec` (`Interpreter.exec`); `remainder` may be a callback building a transaction, built as an expression
        is, outside the transaction (94). A scope's transaction takes the first expression its `exec` is given as its
        own: its record's, and its uid (`Provenance`)."""
        from . import Builders, Changes

        store = self.store
        transaction = remainder
        if Builders._is_function(remainder):  # built as an expression is, outside the transaction (94)
            with Changes._as_committed(store):
                transaction = store._expressed(remainder)
        remainder = _remainder(store, Proxies._durable(transaction))
        proposals = _outermost(store._proposals) if store._proposals is not None else None
        if proposals is not None and proposals.expression is None and proposals.uid is None:
            proposals.expression = remainder.transaction  # a scope's: its record's, and its uid (Provenance)
        return self._exec(txn, frame, remainder, allow_write)

    def _extended(self, remainder: Remainder, frame: Mapping[str, Any], write: bool, named: dict[str, list[str]],
                  scope: str, made: list[Frame]) -> list[Frame]:
        """A cache layer's, writing: an install, the layer below's first, executed there as it reaches this layer,
        then this layer's, as one with no layer below; else its frames, interpreted here as far as it can know, each
        sent below (`_cached`)."""
        store = self.store
        if not write or store._lower is None or store._installing:
            return super()._extended(remainder, frame, write, named, scope, made)
        if not _writes_schemas(store, remainder.transaction):
            return self._cached(remainder, frame, named, scope)
        store._lower.run(Remainder(store._lower.copy(remainder.transaction), remainder.at), frame)
        store._installing += 1
        try:
            return super()._extended(remainder, frame, write, named, scope, made)
        finally:
            store._installing -= 1

    def _given_back(self, frames: list[Frame], named: dict[str, list[str]], scope: str | None = None) -> list[Frame]:
        """The frames given back (`Interpreter._given_back`), once the owners the store gives are settled, so that each
        object has its path."""
        if self.store._unowned:
            self.store._settle_owners()
        return super()._given_back(frames, named, scope)

    def _below(self, run: _Run, partial: Frame) -> list[Frame]:
        """A cache layer's: the rest of the branch executed by the layer below's transaction, what comes back taken
        here; else the loopback (`Interpreter._below`)."""
        store = self.store
        if store._lower is None or store._installing:
            return super()._below(run, partial)
        scope = partial.scope = f"{run.scope}/{next(run.sent)}"
        joined: list[Frame] = []
        (given,) = self._given_back([partial], run.named, scope)
        for item in self._from_below(given, partial.remainder, run.named, scope):
            (run.failed if item.errors else joined).append(item if item.errors else self._taken(item, partial.remainder,
                                                                                                True))
        return joined

    def _cached(self, remainder: Remainder, given: Mapping[str, Any], named: dict[str, list[str]],
                scope: str) -> list[Frame]:
        """The frames a cache layer gives of one input frame, writing ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)): it interprets it
        read-only over what it holds, as far as it can know (`_bind`, `knows`); each frame that halts, with its
        remainder, and each it completes, with nothing left to execute, goes to the layer below's transaction, which
        executes it, writing; and each that comes back is given (`_from_below`). A frame annotated with an error here is
        given as it is."""
        made = self._one(remainder, given, False, named, scope)
        frames: list[Frame] = []
        for local in self._given_back(made, named, scope):
            if local.errors:
                frames.append(local)
                continue
            rest = local.remainder or Remainder(remainder.transaction, ())  # complete: down too, for the layer below
            local.remainder = None
            frames += self._from_below(local, rest, named, scope)
        return frames

    def _from_below(self, local: Frame, rest: Remainder, named: dict[str, list[str]], scope: str) -> list[Frame]:
        """What the layer below's transaction gives back of a frame a cache layer sends it with the rest of the
        expression to execute, writing: each frame annotated with an error, as it is; each complete, its journal
        applied to what the cache layer holds; each partial, executed again by the cache layer, writing, its writes sent
        below as it makes them (`Builders.Store._forward`); a completion marker's journal applied. Its frames carry no
        journal: the cache layer gives one of what it changed, in its own terms."""
        store = self.store
        frames: list[Frame] = []
        for item in store._lower.forward(local, rest):
            if not isinstance(item, Frame):
                if "journal" in item:
                    self._apply_journal(item["journal"])
                continue
            journal, item.journal = item.journal, None
            if item.errors:
                frames.append(item)
                continue
            if journal is not None:
                self._apply_journal(journal)
            if item.remainder is None:
                frames.append(item)
                continue
            with store._proposing(store._forward):  # partial: executed again here, writing, its writes sent below
                made = self._one(item.remainder, item, True, named, scope)
            frames += self._given_back(made, named, scope)
        return frames

    def _apply_journal(self, journal: Any) -> None:
        """Applies a journal a layer below gave back, a value of the cache layer's, to what the cache layer holds, as
        it applies what the layer below's follow gives it (`Builders.Store._apply`)."""
        from . import Changes

        for transaction in Changes._transactions(journal):
            self.store._apply(transaction, joined=True)


class _Lower:
    """The layer below's transaction, which a cache layer's transaction opens for its whole duration
    ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)): it commits first, at the cache layer's commit (`close`), what it reports of it,
    as it commits (`closing`), taken into the cache layer's; and where the cache layer's raises, it is dropped. What
    passes between them is `exec`, its frames, remainders and journals each made a value of the store it goes to,
    through their plain forms: an object by its reference, a schema object by its path, an expression by its wire form,
    whose positions are the same in both."""

    def __init__(self, store: Any):
        self.store, self.below = store, store._below
        self.closing = self.closed = False
        self.copies: dict[int, tuple[Any, Any]] = {}  # by an expression of the cache layer's: it, and its copy below
        self.originals: dict[int, Any] = {}  # by a copy's id: the cache layer's expression
        self._scope = self.below.transaction()
        self.txn = self._scope.__enter__()

    def close(self, error: BaseException | None = None) -> None:
        """Commits the layer below's transaction, raising where it is refused; or, given the error the cache layer's
        raised, drops it."""
        if self.closed:
            return
        self.closed = True
        if error is not None:
            self._scope.__exit__(type(error), error, error.__traceback__)
            return
        self.closing = True
        try:
            self._scope.__exit__(None, None, None)
        finally:
            self.closing = False

    def copy(self, transaction: Any) -> Any:
        """The layer below's copy of an expression of the cache layer's, under the cache layer's transaction's uid, so
        that the layer below's transaction takes it as its own, and records it so (`Provenance`)."""
        from . import Changes

        held = self.copies.get(id(transaction))
        if held is None:
            plain = Plain.ToPlain(self.store).Transaction(transaction)  # as the transaction sees it, made within it maybe
            plain["uid"] = _transaction_uid(self.store)
            with Changes._as_committed(self.below):
                copied = Plain.FromPlain(self.below).Transaction(plain)
            held = self.copies[id(transaction)] = (transaction, copied)
            self.originals[id(copied)] = transaction
        return held[1]

    def forward(self, frame: Frame, rest: Remainder) -> Iterator[Any]:
        """The items the layer below's transaction's `exec` gives of `frame`, a frame of the cache layer's given back,
        and `rest`, writing, each a value of the cache layer's."""
        for item in self.txn.exec(self.down(frame), Remainder(self.copy(rest.transaction), rest.at), True):
            if isinstance(item, Frame):
                yield self.up(item)
            else:
                yield {**item, **({"journal": self.journal(item["journal"])} if "journal" in item else {})}

    def write(self, transaction: Any) -> None:
        """Executes a cache layer's own write, what it changed, a `Changes.Transaction` of the cache layer's whose id is
        its transaction's uid, in the layer below's transaction, as the mutation transaction that makes those changes
        there (`Changes._expression`); raises the first error a frame of it is annotated with."""
        from . import Changes

        schema = self.store.registered("Changes.Transaction")
        copied = Plain.FromPlain(self.below)(self.below.registered("Changes.Transaction"),
                                             Plain.ToPlain(self.store)(schema, transaction))
        self.run(Changes._expression(self.below, copied))

    def run(self, transaction: Any, frame: Mapping[str, Any] | None = None) -> None:
        """Executes a transaction of the layer below's in its transaction, writing, over `frame`, one of the cache
        layer's, else one empty: an install, the layer below's before the cache layer's, or a cache layer's own write;
        raises the first error a frame of it is annotated with, as the layer below's interpreter annotated it."""
        given = self.down(frame if isinstance(frame, Frame) else Frame(frame))
        _raised([item for item in self.txn.exec(given, transaction, True) if isinstance(item, Frame)])

    def down(self, frame: Frame) -> Frame:
        """A frame of the cache layer's as the layer below's: each object by its reference, a schema object by its
        path. What it binds is what the cache layer's interpretation bound, or was given: an object it holds, by its
        reference, or a schema object the layer below holds, every install having run there first."""
        bound = {name: _carried(self.store, self.below, value) for name, value in dict.items(frame)}
        return Frame(bound, frame.errors, scope=frame.scope)

    def up(self, frame: Frame) -> Frame:
        """A frame the layer below gave back, as the cache layer's: its bindings, what it assigns, its remainder in the
        cache layer's expression, and its journal."""
        bound: dict[str, Any] = {}
        for name, value in dict.items(frame):
            try:
                bound[name] = _carried(self.below, self.store, value)
            except LookupError as error:
                bound[name] = _Refused(str(error))
        assigns = {name: {key: _carried_value(self.below, self.store, value, bound[name], key)
                          for key, value in values.items()} for name, values in frame.assigns.items()}
        remainder = None if frame.remainder is None else Remainder(self.originals[id(frame.remainder.transaction)],
                                                                   frame.remainder.at)
        journal = None if frame.journal is None else self.journal(frame.journal)
        return Frame(bound, frame.errors, assigns, remainder, frame.scope, journal)

    def journal(self, journal: Any) -> Any:
        """A journal the layer below gave, as the cache layer's."""
        return Plain.FromPlain(self.store)(self.store.registered("Changes.Journal"), Plain.ToPlain(self.below)(
            self.below.registered("Changes.Journal"), journal))


def _carried(source: Any, target: Any, value: Any) -> Any:
    """What a frame binds, of `source`'s, as `target`'s: an object's reference by its path, a schema object by its path;
    refused, `LookupError`, where it cannot be: a counted object, or a schema object `target` does not hold."""
    from . import Paths

    if isinstance(value, _Refused):
        raise LookupError(value.message)
    held = Proxies._deref(value)
    if isinstance(held, Proxies._RecordData) and held._schema is source.registered("References.OfObject"):
        return Plain.FromPlain(target)(target.registered("References.OfObject"),
                                       Plain.ToPlain(source)(held._schema, held))
    path = Paths.of(held)
    found = target.held(Plain.ToPlain(source)(path.as_schema(), path))
    if found is None:
        raise LookupError("a schema object the layer it goes to does not hold")
    return found


def _carried_value(source: Any, target: Any, value: Any, holder: Any, name: str) -> Any:
    """A value a frame assigns to the property `name` of `holder`, the object a symbol binds, by its reference, a value
    of `target`'s: a value object of `source`'s by its plain form, read by the schema `target` gives the property, that
    of the object's schema its path implies; any other as it is."""
    from . import References

    if isinstance(value, (Proxies._RecordData, Proxies._ContainerData)):
        path = Plain.ToPlain(target)(holder.as_schema(), holder)["path"]
        schema = References._implied(target, path).properties[name].schema
        return Plain.FromPlain(target)(schema, Plain.ToPlain(source)(value._schema, value))
    return value
