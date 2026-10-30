"""References: one format for what designates an object, a relation entry or a frame ([CAP-130: references to objects, entries and frames](../../../../../mbse-basis/docs/capabilities/CAP-130.md)).

Three value schemas, which every store holds, its own, as it holds `Paths`:

- `References.OfObject`, a singleton or other non-counted reference object: a value object whose one property, `path`, is a
  singleton's, an owned object's or a schema object's path (`Paths.OfRoot`);
- `References.OfFrame`, a frame: `binds`, each of its symbols bound to a `References.OfObject`, and `variables`, each
  of its variables' values; and what it witnesses: `assigns`, objects' property values (`References.OfProperties`),
  and `entries`, relation entries (`References.OfEntry`);
- `References.OfProperties`, property values an object is witnessed to hold: its `object`, a `References.OfObject`,
  and its `properties`, each its value;
- `References.OfEntry`, a relation entry: its `relation`, by the relation's path, its `links`, each a
  `References.OfObject`, and its `properties`, each its value. Entries compare by value, so that designates one.

`of(store, x)` gives the reference of an object, an entry, or a frame `store.transaction` gave back; `resolve(store,
reference)` gives what a reference designates, or None where the store holds none. A counted object has no reference,
nor a frame that binds one: nothing names it (object identity 40 and 55 in [CAP-118: singletons, owned and counted objects](../../../../../mbse-basis/docs/capabilities/CAP-118.md#decided)).

The extension: `install` gives `Schemas.OfSymbol` its `reference`, a `References.OfObject`, so that a pattern's symbol
binds the one object a reference designates, given in place of a schema (`.symbols({"ada": reference})`);
`validate(pattern)` refuses a symbol given both, or neither. A spec over such a symbol writes the members of the schema
of the object the reference designates, where the store holds it, else of the schema its path implies, followed through
the store's schemas alone (Decided, 8), so that a store holding only the schemas writes it.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import Paths, Plain, Proxies
from . import Schemas as S
from .Builders import _builder_for

__all__ = ["install", "of", "resolve", "validate"]


def install(txn: Any) -> Any:
    """The reference schemas, defined in the store a transaction writes: `store.transaction(References.install)`. A
    store is made by it, after `Schemas.install` and `Paths.install`, read by the bootstrap (`Builders`); run again in
    a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the store's meta-schemas and basic scalars (78)
    return txn.uid("mbse.Schemas.References/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"OfObject": S.OfObject, "OfFrame": S.OfObject, "OfProperties": S.OfObject, "OfEntry": S.OfObject,
                  "OfSymbol": S.OfObject})
        .spec([
            lambda _: _.OfObject.name("References.OfObject").properties({
                "path": txn.Paths.OfRoot,  # a singleton's, an owned object's or a schema object's
            }),
            lambda _: _.OfFrame.name("References.OfFrame").properties({
                "binds": S.OfContainer(lambda c: c.index([S.OfStr]).element([_.OfObject])),
                "variables": S.OfContainer(lambda c: c.index([S.OfStr]).element([S.OfAny(lambda a: a)])),
                "assigns": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfProperties])),  # witnessed values
                "entries": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfEntry])),  # witnessed entries
            }),
            lambda _: _.OfProperties.name("References.OfProperties").properties({
                "object": _.OfObject,
                "properties": S.OfContainer(lambda c: c.index([S.OfStr]).element([S.OfAny(lambda a: a)])),
            }),
            lambda _: _.OfEntry.name("References.OfEntry").properties({
                "relation": txn.Paths.OfRoot,  # the relation's path
                "links": S.OfContainer(lambda c: c.index([S.OfStr]).element([_.OfObject])),
                "properties": S.OfContainer(lambda c: c.index([S.OfStr]).element([S.OfAny(lambda a: a)])),
            }),
            # --- The extension: a pattern's symbol given the object it binds in place of a schema (Decided, 8) ---
            lambda _: _.OfSymbol.name("Schemas.OfSymbol").properties({"reference": _.OfObject}),
        ])]))])


def validate(pattern: Any) -> list[str]:
    """The problems of a pattern's symbols as `References.install` extends them: a symbol given both a schema and a
    reference, or neither; a symbol has exactly one (references 8 in [CAP-141: queries start from a referenced object](../../../../../mbse-basis/docs/capabilities/CAP-141.md#decided))."""
    from . import Transactions

    if not isinstance(pattern, S.OfPattern.Data):
        raise TypeError(f"References.validate takes a pattern, not {pattern!r}")
    problems = []
    for name, symbol in pattern.symbols.items():
        try:
            Transactions._exactly_one(name, symbol, ValueError)
        except ValueError as error:
            problems.append(str(error))
    return problems


def _implied(store: Any, path_plain: Any) -> Any:
    """The schema of the object a path designates, as the store's schemas imply it, reading no data (Decided, 8): the
    one schema that declares its singleton, then, for each step, the one schema that declares the adjacency `o`,
    marked owner(), on another link of the relation that the current schema's adjacency `i` is to (as `_filled` finds
    what a link links). `LookupError`, saying where the path cannot be followed: an unknown singleton, an adjacency the
    schema lacks, a link no one schema fills; or a schema object's path, where the store does not hold it."""
    singleton, steps = Plain._steps(path_plain, ())
    if singleton == ".":
        raise LookupError("names a schema object the store does not hold")
    schemas = [(name, schema) for name, schema in store._schemas.items() if isinstance(schema, S.OfObject.Data)]
    current = next((schema for _, schema in schemas if schema.singleton == singleton), None)
    if current is None:
        raise LookupError(f"starts from {singleton!r}, which no schema declares a singleton")
    for i, o, _ in steps:
        adjacency = current.adjacencies.get(i)
        if adjacency is None:
            raise LookupError(f"steps through {i!r}, an adjacency {current.name!r} does not declare")
        found = [(name, schema) for name, schema in schemas if any(
            a.owner and a.name == o and a.relation is adjacency.relation and a.me != adjacency.me
            for a in (*schema.adjacencies.values(), *schema.anonymous))]
        if len(found) != 1:
            raise LookupError(f"steps through {i!r} of {current.name!r}, where not exactly one schema declares an "
                              f"adjacency {o!r} marked owner() on another link of its relation: found "
                              f"{sorted(name for name, _ in found)}")
        current = found[0][1]
    return current


def _object(store: Any, obj: Any) -> Any:
    """A `References.OfObject`'s callback: an object's path; refused for a counted object, which nothing names."""
    target = Proxies._deref(obj)
    if isinstance(target, Proxies._ObjectData):
        Proxies._same_store(store, target)
        if Proxies._counted(target):
            raise LookupError(f"a counted {target._schema_name!r} has no reference: nothing names it (make it a "
                              "singleton's or an owner's)")
    elif _builder_for(target) is None:
        raise TypeError(f"References.of takes an object, a relation entry or a frame, not {target!r}")
    path = Paths.of(target)
    return lambda o: o.path(path)


def _frame(store: Any, frame: Mapping[str, Any]) -> Any:
    """A `References.OfFrame`'s callback: each symbol's object's reference; refused where one binds a counted object."""
    binds = {}
    for name, target in frame.items():
        try:
            binds[name] = _object(store, target)
        except LookupError as error:
            raise LookupError(f"symbol {name!r} of the frame: {error}") from None
    return lambda f: f.binds(binds)


def _entry(store: Any, entry: Any) -> Any:
    """A `References.OfEntry`'s callback: its relation's path, each link's object's reference and each property's
    value."""
    relation = Paths.of(entry._relation)
    links = {link: _object(store, target) for link, target in entry._links.items()}
    properties = dict(entry._properties)
    return lambda e: e.relation(relation).links(links).properties(properties)


def of(store: Any, x: Any) -> Any:
    """The reference of `x`, a value of the store's: of an object (`References.OfObject`), its path, refused for a
    counted object; of a relation entry (`References.OfEntry`); of a frame `store.transaction` gave back, a mapping of
    symbols to objects (`References.OfFrame`), refused where it binds a counted object."""
    if isinstance(x, Mapping):
        return store.References.OfFrame(_frame(store, x))
    if isinstance(x, Proxies._Entry):
        return store.References.OfEntry(_entry(store, x))
    return store.References.OfObject(_object(store, x))


def resolve(store: Any, reference: Any) -> Any:
    """What `reference` designates in `store`: an object, an entry, or a frame, a mapping of symbols to objects; None
    where the store holds none."""
    names = {"References.OfObject": _resolve_object, "References.OfEntry": _resolve_entry,
             "References.OfFrame": _resolve_frame}
    schema = reference.as_schema() if hasattr(reference, "as_schema") else None
    found = next((resolver for name, resolver in names.items() if store.registered(name) is schema), None)
    if found is None:
        raise TypeError("References.resolve takes a References.OfObject, OfEntry or OfFrame value of the store's")
    return found(store, Plain.ToPlain(store)(schema, reference))


def _resolve_object(store: Any, plain: Any) -> Any:
    try:
        return Plain._by_path(store, plain["path"], ())
    except Plain.DecodeError:  # a schema object's path whose steps name no entries: nothing has it
        return None


def _resolve_frame(store: Any, plain: Any) -> Any:
    frame = {}
    for name, given in plain.get("binds", {}).items():
        target = _resolve_object(store, given)
        if target is None:
            return None
        frame[name] = target
    return frame


def _resolve_entry(store: Any, plain: Any) -> Any:
    relation = store.held(plain["relation"])
    if not isinstance(relation, S.OfRelation.Data):
        return None
    links = {}
    for link, given in plain.get("links", {}).items():
        target = _resolve_object(store, given)
        if target is None:
            return None
        links[link] = target
    if not links:
        return None
    first, target = next(iter(links.items()))
    for entry in Proxies._linking(relation, first, target, store):
        if entry._links.keys() == links.keys() and all(entry._links[link] is held for link, held in links.items()) \
                and Plain.ToPlain(store)(store.References.OfEntry.as_schema(), of(store, entry)) == plain:
            return entry
    return None
