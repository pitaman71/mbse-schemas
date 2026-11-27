"""References: one format for what designates an object, a relation entry, a frame or a parameter ([CAP-130: references to objects, entries and frames](mbse:mbse-basis/docs/capabilities/CAP-130.md);
[CAP-311: references stabilized](mbse:mbse-basis/docs/capabilities/README.md#CAP-311)).

Value schemas, which every store holds, its own, as it holds `Paths`:

- `References.OfObject`, a singleton or other non-counted reference object: a value object whose one property, `path`, is a
  singleton's, an owned object's or a schema object's path (`Paths.OfRoot`);
- `References.OfFrame`, a frame: its `errors`, what failed as a term processed it (`References.OfError`,
  [CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)); and, which `Changes.install` gives it, its `journal`, a
  `Changes.Transaction`, which the frame is ([CAP-318: support for decoupled code](mbse:mbse-basis/docs/capabilities/README.md#CAP-318), as the user
  decided: "frames contained journals which contained changes"): its symbols the frame's bindings, each an object by
  its `References.OfObject`, a schema object by its `References.OfSchema`, and its changes what its path's clauses
  referenced or changed, each property set or cleared, each relation entry inserted or removed; and, as an item of a
  frame stream (`txn.exec`), its `scope`, the id of the input frame it descends from, its `remainder`, where the rest
  of the expression begins, written as an error's `subterm` is, unset on a complete frame, and `terminal`, true where
  a term dropped it and its path changed something, a routing mark, unset where false. It has no bindings, values or
  entries of its own beside its journal;
- `References.OfEnd`, a frame stream's completion marker, `{"end": scope}`: its `scope`, a branch's or an input
  frame's, unset where it ends the whole stream; it marks an end, and carries nothing else; and
  `References.OfItem`, an item of a frame stream, the union of a `frame` and an `end`. `Changes.install` defines both,
  after the `Changes` schemas their journals are, so that the built-in serialization carries a stream to another
  process as it carries any value;
- `References.OfError`, an error annotated on a frame: its `subterm`, where in the transaction's expression it arose,
  its `kind`, the name of its class, and its `message`;
- `References.OfEntry`, a relation entry: its `relation`, by the relation's path, its `links`, each a
  `References.OfObject`, and its `properties`, each its value. Entries compare by value, so that designates one;
- `References.OfSchema`, a schema object's reference, which refines `References.OfObject`: its `path` is a schema
  object's, from the root module, the singleton `"."`, and writing or reading one whose path is not refuses it;
  `validate_schema(store, reference, kind)` reports one that designates no schema object the store holds, or one of
  another kind than `kind` where a schema argument constrains it, as `References.OfSchema[Schemas.OfObject]` does
  ([CAP-320: schema and value references](mbse:mbse-basis/docs/capabilities/README.md#CAP-320));
- `References.OfValue`, data that holds a value of any schema, its one property, `value`, an `OfAny`, as
  `Schemas.OfAny` is the schema that admits one (CAP-320);
- `References.OfParameter`, a parameter, by its `name` and nothing else, as the user decided ([the parametrics
  proposal](mbse:mbse-basis/proposals/PARAMETRICS.md#decided)). A parameter assignment or a parameter binding in the enclosing
  scope resolves it, not a store. It may stand in the place of a value of any schema, which `Visitors.OfAny.as_parameter`
  reads ([CAP-312: a parameter reference in place of anything with a schema](mbse:mbse-basis/docs/capabilities/CAP-312.md#decided)).

`of(store, x)` gives the reference of an object, an entry, or a frame `store.transaction` or `txn.exec` gave back,
its journal, errors, scope and remainder included, a symbol it binds that has no reference annotated as an error, and the `References.OfEnd` of a completion marker `txn.exec` gave. A reference is resolved within a transaction, as every read of a store's data is: a pattern's symbol given
an object's reference binds what it designates, and no function resolves one from outside the transaction
([CAP-315: every read within a transaction or through a follow](mbse:mbse-basis/docs/capabilities/CAP-315.md)). An entry's reference is matched by a pattern over the objects it links,
and a frame's by a pattern whose symbols are given the references its journal binds. A counted object has no
reference, and a frame that binds one leaves it out of its journal: nothing names it (object identity 40 and 55 in [CAP-118: singletons, owned and counted objects](mbse:mbse-basis/docs/capabilities/CAP-118.md#decided)).

The extension: `install` gives `Schemas.OfSymbol` its `reference`, a `References.OfObject`, so that a pattern's symbol
binds the one object a reference designates, given in place of a schema (`.symbols({"ada": reference})`);
`validate(pattern)` refuses a symbol given both, or neither. A spec over such a symbol writes the members of the schema
of the object the reference designates, where the store holds it, else of the schema its path implies, followed through
the store's schemas alone (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)), so that a store holding only the schemas writes it.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import Paths, Plain, Proxies
from . import Schemas as S
from .Builders import _builder_for

__all__ = ["implied", "install", "of", "validate", "validate_schema"]


def install(txn: Any) -> Any:
    """The reference schemas, defined in the store a transaction writes: `store.transaction(References.install)`. A
    store is made by it, after `Schemas.install` and `Paths.install`, read by the bootstrap (`Builders`); run again in
    a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the store's meta-schemas and basic scalars (78)
    return txn.uid("mbse.Schemas.References/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"OfObject": S.OfObject, "OfFrame": S.OfObject, "OfEntry": S.OfObject, "OfError": S.OfObject,
                  "OfSymbol": S.OfObject, "OfParameter": S.OfObject, "OfSchema": S.OfObject, "OfValue": S.OfObject})
        .spec([
            lambda _: _.OfObject.name("References.OfObject").properties({
                "path": txn.Paths.OfRoot,  # a singleton's, an owned object's or a schema object's
            }),
            lambda _: _.OfFrame.name("References.OfFrame").properties({  # its journal, `Changes.install`'s (CAP-318)
                "errors": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.OfError])),  # what failed (CAP-309)
            }),
            lambda _: _.OfEntry.name("References.OfEntry").properties({
                "relation": txn.Paths.OfRoot,  # the relation's path
                "links": S.OfContainer(lambda c: c.index([S.OfStr]).element([_.OfObject])),
                "properties": S.OfContainer(lambda c: c.index([S.OfStr]).element([S.OfAny(lambda a: a)])),
            }),
            lambda _: _.OfError.name("References.OfError").properties({
                "subterm": S.OfStr,  # where in the expression: a path in its wire form, `$.mutations[0].map`
                "kind": S.OfStr,  # the error's class's name
                "message": S.OfStr,
            }),
            lambda _: _.OfParameter.name("References.OfParameter").properties({
                "name": S.OfStr,  # the parameter's name, and nothing else (CAP-311)
            }),
            lambda _: _.OfSchema.name("References.OfSchema").refines([_.OfObject]),  # its path starts at "." (CAP-320)
            lambda _: _.OfValue.name("References.OfValue").properties({
                "value": S.OfAny(lambda a: a),  # a value of any schema (CAP-320)
            }),
            # --- The extension: a pattern's symbol given the object it binds in place of a schema (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)) ---
            lambda _: _.OfSymbol.name("Schemas.OfSymbol").properties({"reference": _.OfObject}),
        ])]))])


def validate(pattern: Any) -> list[str]:
    """The problems of a pattern's symbols as `References.install` extends them: a symbol given both a schema and a
    reference, or neither; a symbol has exactly one (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided))."""
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


def validate_schema(store: Any, reference: Any, kind: Any = None) -> list[str]:
    """The problems of a schema object's reference (`References.OfSchema`) in `store`, where `kind`, a schema of schemas
    (`store.Schemas.OfObject`), constrains the kind of schema it designates, as the schema argument of
    `References.OfSchema[Schemas.OfObject]` does; None constrains nothing. A reference's problems: its path is not a
    schema object's, from the root module; the store holds no schema object at its path; or the schema object it
    designates is not of `kind`, nor of a refinement of it ([CAP-320: schema and value references](mbse:mbse-basis/docs/capabilities/README.md#CAP-320))."""
    reference = Proxies._durable(reference)
    if not (isinstance(reference, Proxies._RecordData)
            and S.is_a(reference._schema, store.registered(Plain.SCHEMA_REFERENCE))):
        raise TypeError(f"References.validate_schema takes a schema object's reference, not {reference!r}")
    try:
        held = _schema(store, reference)
    except ValueError as error:
        return [str(error)]
    if held is None:
        return ["a schema object's reference designates no schema object the store holds"]
    own = _builder_for(held)(held, False, store).as_schema()
    kind = Proxies._deref(kind)
    if kind is not None and not S.is_a(own, kind):
        return [f"a schema object's reference designates a {own.name!r}, where a {kind.name!r} is expected"]
    return []


def _schema(store: Any, reference: Any) -> Any:
    """The schema object a schema object's reference designates in `store`, or None where the store holds none at its
    path, or it has none; `ValueError` where its path is not a schema object's."""
    path = Plain.ToPlain(store)(reference.as_schema(), reference).get("path")
    return None if path is None else store.held(path)


def implied(store: Any, path_plain: Any) -> Any:
    """The schema of the object a path designates, as the store's schemas imply it, reading no data (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)): the
    one schema that declares its singleton, then, for each step, the one schema that declares the adjacency `o`,
    marked owner(), on another link of the relation that the current schema's adjacency `i` is to (as `_filled` finds
    what a link links). `LookupError`, saying where the path cannot be followed: an unknown singleton, an adjacency the
    schema lacks, a link no one schema fills; or a schema object's path, where the store does not hold it. `path_plain`
    is a `References.OfObject`'s path, as plain data; `store` holds the schemas, whatever layer holds the data: a journal
    names an object held before by its reference alone where this is its schema (`Changes.gather`)."""
    singleton, steps = Plain._steps(path_plain, ())
    if singleton == Plain.ROOT:
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
    """A `References.OfObject`'s callback: an object's path, or that of a reference a frame given back holds, a schema
    object's among them; refused for a counted object, which nothing names."""
    from . import Transactions

    target = Proxies._deref(obj)
    if isinstance(target, Transactions.Refused):
        raise LookupError(target.message)
    if Transactions._is_reference(store, target):
        held = Proxies._read(target, "path")
        return lambda o: o.path(held)
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
    """A `References.OfFrame`'s callback: its journal (CAP-318), the one a frame the executor gave back is
    (`Transactions.Frame`), else one of its bindings alone, each symbol's object by its reference, a schema object's a
    `References.OfSchema`; a symbol that binds an object with no reference, a counted one, left out of it and written
    as an error annotated on the frame, at `$`; and the errors annotated on it, its `scope`, and its `remainder`'s
    subterm where it halted."""
    from . import Changes, Transactions

    journal = frame.journal if isinstance(frame, Transactions.Frame) else None
    errors = [(error.subterm, error.kind, error.message) for error in getattr(frame, "errors", ())]
    symbols: dict[str, Any] = {}
    for name, target in dict.items(frame) if isinstance(frame, dict) else frame.items():
        try:
            symbols[name] = _symbol(store, target)
        except LookupError as error:
            errors.append(("$", type(error).__name__, f"symbol {name!r} of the frame: {error}"))
    if journal is None:
        journal = Plain.FromPlain(store)(store.registered("Changes.Transaction"), {"symbols": symbols})
    scope, remainder = getattr(frame, "scope", None), getattr(frame, "remainder", None)
    terminal = getattr(frame, "terminal", False)

    def written(f: Any) -> Any:
        f.journal(journal)
        if errors:
            f.errors([lambda x, e=error: x.as_object(lambda r: r.subterm(e[0]).kind(e[1]).message(e[2]))
                      for error in errors])
        if scope is not None:
            f.scope(scope)
        if remainder is not None:  # where it halted: a position in the expression the receiver holds, not a copy
            f.remainder(remainder.subterm)
        return f.terminal(True) if terminal else f  # a routing mark, unset where false
    return written


def _symbol(store: Any, target: Any) -> dict[str, Any]:
    """A frame's binding as a `Changes.Symbol`, as plain data: its object's reference, a schema object's a
    `References.OfSchema`; `LookupError` where it has none."""
    reference = store.References.OfObject(_object(store, target))
    plain = {"reference": Plain.ToPlain(store)(reference.as_schema(), reference)}
    held = Proxies._deref(target)
    if isinstance(held, Proxies._RecordData) and held._schema is not store.registered("References.OfObject"):
        plain["reference"]["$schema"] = store.name_of(held._schema)  # a schema object's reference, as it was given
    elif not isinstance(held, (Proxies._RecordData, Proxies._ObjectData)):
        plain["reference"]["$schema"] = "References.OfSchema"  # a schema object
    return plain


def _end(store: Any, marker: Mapping[str, Any]) -> Any:
    """A `References.OfEnd`'s callback: a completion marker's scope, unset where it ends the whole stream
    (`{"end": None}`). It marks an end, and carries nothing else."""
    scope = marker["end"]
    return lambda e: e if scope is None else e.scope(scope)


def _is_end(x: Mapping[str, Any]) -> bool:
    """Whether a mapping is a completion marker of a frame stream, `{"end": scope}`: not a frame, which binds objects,
    never a scope, by its symbols."""
    from . import Transactions

    return (not isinstance(x, Transactions.Frame) and set(x) == {"end"}
            and (x["end"] is None or isinstance(x["end"], str)))


def _entry(store: Any, entry: Any) -> Any:
    """A `References.OfEntry`'s callback: its relation's path, each link's object's reference and each property's
    value."""
    relation = Paths.of(entry._relation)
    links = {link: Proxies._parameter_in(getattr(entry, link)) or _object(store, getattr(entry, link))  # each read:
             for link in entry._links}  # a parameter reference in its place, as it is (CAP-312)
    properties = dict(entry._properties)
    return lambda e: e.relation(relation).links(links).properties(properties)


def of(store: Any, x: Any) -> Any:
    """The reference of `x`, a value of the store's: of an object (`References.OfObject`), its path, refused for a
    counted object; of a relation entry (`References.OfEntry`); of a frame `store.transaction` or `txn.exec` gave back,
    a mapping of symbols to objects (`References.OfFrame`), its journal, or one of its bindings, a symbol that binds a
    counted object left out of it and annotated as an error, with its errors, scope and remainder where it carries
    them; of a completion marker `txn.exec` gave, `{"end": scope}`
    (`References.OfEnd`). It gives no
    `References.OfParameter`, since a parameter is not an object that a store holds: a parameter reference is built
    by its name, `store.References.OfParameter(lambda p: p.name(...))`."""
    if isinstance(x, Mapping):
        return store.References.OfEnd(_end(store, x)) if _is_end(x) else store.References.OfFrame(_frame(store, x))
    if isinstance(x, Proxies._Entry):
        return store.References.OfEntry(_entry(store, x))
    return store.References.OfObject(_object(store, x))


def _designated(store: Any, reference: Any) -> Any:
    """The object a `References.OfObject` designates in `store`, or None where the store holds none: what a pattern's
    symbol given the reference binds, within the transaction that runs it (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided))."""
    return store._interpreter().designated(Plain.ToPlain(store)(reference.as_schema(), reference)["path"])
