"""References: one format for what designates an object, a relation entry or a frame (docs/proposals/references).

Three value schemas, which every store holds, its own, as it holds `Paths`:

- `References.OfObject`, an object: a union of two branches, `path`, a singleton's, an owned object's or a schema
  object's path (`Paths.OfRoot`), and `upserted`, a counted object an upsert made, by what made it
  (docs/OBJECT_IDENTITY.md, Decided, 61, 63 and 102): `References.OfUpserted`, the `frame` that reached the upsert, the
  upsert's `key` and the `symbol` it was made for;
- `References.OfFrame`, a frame: `binds`, each of its symbols bound to a `References.OfObject`;
- `References.OfEntry`, a relation entry: its `relation`, by the relation's path, its `links`, each a
  `References.OfObject`, and its `properties`, each its value. Entries compare by value, so that designates one.

`of(store, x)` gives the reference of an object, an entry, or a frame `store.transaction` gave back; `resolve(store,
reference)` gives what a reference designates, or None where the store holds none. A counted object a document or a
builder writes outright has no reference: nothing names it (Decided, 40 and 55).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import Paths, Plain, Proxies
from . import Schemas as S
from .Builders import _builder_for

__all__ = ["install", "of", "resolve"]


def install(txn: Any) -> Any:
    """The reference schemas, defined in the store a transaction writes: `store.transaction(References.install)`. A
    store is made by it, after `Schemas.install` and `Paths.install`, read by the bootstrap (`Builders`); run again in
    a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the store's meta-schemas and basic scalars (78)
    return txn.uid("mbse.Schemas.References/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"OfObject": S.OfUnion, "OfUpserted": S.OfObject, "OfFrame": S.OfObject, "OfEntry": S.OfObject})
        .spec([
            lambda _: _.OfObject.name("References.OfObject").branches([
                lambda t: t.name("path").schema([txn.Paths.OfRoot]),  # a singleton, an owned object, a schema object
                lambda t: t.name("upserted").schema([_.OfUpserted]),  # a counted object an upsert made
            ]),
            lambda _: _.OfUpserted.name("References.OfUpserted").properties({
                "frame": _.OfFrame,  # the frame that reached the upsert
                "key": S.OfStr,  # the upsert's key, where it has one
                "symbol": S.OfStr,  # the symbol it was made for
            }),
            lambda _: _.OfFrame.name("References.OfFrame").properties({
                "binds": S.OfContainer(lambda c: c.index([S.OfStr]).element([_.OfObject]))}),
            lambda _: _.OfEntry.name("References.OfEntry").properties({
                "relation": txn.Paths.OfRoot,  # the relation's path
                "links": S.OfContainer(lambda c: c.index([S.OfStr]).element([_.OfObject])),
                "properties": S.OfContainer(lambda c: c.index([S.OfStr]).element([S.OfAny(lambda a: a)])),
            }),
        ])]))])


def _object(store: Any, obj: Any) -> Any:
    """A `References.OfObject`'s callback: an object's path, or what upserted it where it is counted."""
    target = Proxies._deref(obj)
    if isinstance(target, Proxies._ObjectData):
        Proxies._same_store(store, target)
        if Proxies._counted(target):
            made = store._made_by.get(target)
            if made is None:
                raise LookupError(f"a counted {target._schema_name!r} that no upsert made has no reference: nothing "
                                  "names it (make it a singleton's, an owner's or an upsert's)")
            key, symbol, frame = made
            return lambda o: o.upserted(lambda u: (u if key is None else u.key(key)).symbol(symbol)
                                        .frame(_frame(store, frame)))
    elif _builder_for(target) is None:
        raise TypeError(f"References.of takes an object, a relation entry or a frame, not {target!r}")
    path = Paths.of(target)
    return lambda o: o.path(path)


def _frame(store: Any, frame: Mapping[str, Any]) -> Any:
    """A `References.OfFrame`'s callback: each symbol's object's reference."""
    binds = {name: _object(store, target) for name, target in frame.items()}
    return lambda f: f.binds(binds)


def _entry(store: Any, entry: Any) -> Any:
    """A `References.OfEntry`'s callback: its relation's path, each link's object's reference and each property's
    value."""
    relation = Paths.of(entry._relation)
    links = {link: _object(store, target) for link, target in entry._links.items()}
    properties = dict(entry._properties)
    return lambda e: e.relation(relation).links(links).properties(properties)


def of(store: Any, x: Any) -> Any:
    """The reference of `x`, a value of the store's: of an object (`References.OfObject`), its path, or, a counted
    object, what upserted it, refused where nothing names it; of a relation entry (`References.OfEntry`); of a frame
    `store.transaction` gave back, a mapping of symbols to objects (`References.OfFrame`)."""
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
    from . import Transactions

    if "path" in plain:
        try:
            return Plain._by_path(store, plain["path"], ())
        except Plain.DecodeError:  # a schema object's path whose steps name no entries: nothing has it
            return None
    upserted = plain["upserted"]
    frame = _resolve_frame(store, upserted.get("frame", {}))
    if frame is None:
        return None
    held = store._upserted.get(Transactions._upsert_index(store, upserted.get("key"), upserted["symbol"], frame))
    return held() if held is not None else None


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
