"""Contexts: the context a procedure takes, validation among them, as schema data ([CAP-319: contexts as schema data](mbse:mbse-basis/docs/capabilities/README.md#CAP-319)).

Value schemas, which every store holds, its own, as it holds `References`:

- `Contexts.OfVariable`, a variable: its `name`, its `schema`, a `References.OfSchema` of any schema, and its `value`,
  a `References.OfValue`;
- `Contexts.OfSymbol`, a symbol: its `name`, its `schema`, a `References.OfSchema` of an object schema, and its
  `object`, a `References.OfObject`;
- `Contexts.OfParameter`, a parameter: its `name`, its `schema`, a `References.OfSchema`, and either the `object` it
  is bound to, a `References.OfObject`, or the `value` assigned to it, a `References.OfValue`;
- `Contexts.OfContext`, a context: its `variables`, `symbols` and `parameters`, each a container of the entries above,
  indexed by the entry's name.

A context is a value, complete in itself: nothing links it to another. A sub-context is copied, as the user decided
([the Context + References + Changes cleanup proposal](mbse:mbse-basis/proposals/CONTEXT-REFERENCES-CHANGES.md#decided)):
`within(store, outer, own)` gives a new context that holds the outer context's entries, with the entries of `own`
added, each replacing the outer entry of its name. `validate(store, context)` reports a context's problems, among them
a symbol whose schema is not an object schema: the schema argument of `References.OfSchema[Schemas.OfObject]`
constrains it ([CAP-320: schema and value references](mbse:mbse-basis/docs/capabilities/README.md#CAP-320)).
"""

from __future__ import annotations

from typing import Any

from . import Plain, Proxies, References
from . import Schemas as S

__all__ = ["install", "within", "validate"]

CONTEXT = "Contexts.OfContext"
_CONTAINERS = ("variables", "symbols", "parameters")


def install(txn: Any) -> Any:
    """The context schemas, defined in the store a transaction writes: `store.transaction(Contexts.install)`. A store is
    made by it, after `References.install`, read by the bootstrap (`Builders`); run again in a store, it finds each by
    its name and writes nothing."""
    S = txn.Schemas  # the store's meta-schemas and basic scalars (78)
    R = txn.References
    return txn.uid("mbse.Schemas.Contexts/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"OfVariable": S.OfObject, "OfSymbol": S.OfObject, "OfParameter": S.OfObject, "OfContext": S.OfObject})
        .spec([
            lambda _: _.OfVariable.name("Contexts.OfVariable").properties({
                "name": S.OfStr,
                "schema": R.OfSchema,  # of any schema
                "value": R.OfValue,
            }),
            lambda _: _.OfSymbol.name("Contexts.OfSymbol").properties({
                "name": S.OfStr,
                "schema": R.OfSchema,  # of an object schema (`validate`)
                "object": R.OfObject,
            }),
            lambda _: _.OfParameter.name("Contexts.OfParameter").properties({
                "name": S.OfStr,
                "schema": R.OfSchema,
                "object": R.OfObject,  # the object it is bound to, or
                "value": R.OfValue,  # the value assigned to it
            }),
            lambda _: _.OfContext.name(CONTEXT).properties({
                "variables": S.OfContainer(lambda c: c.index([S.OfStr]).element([_.OfVariable])),
                "symbols": S.OfContainer(lambda c: c.index([S.OfStr]).element([_.OfSymbol])),
                "parameters": S.OfContainer(lambda c: c.index([S.OfStr]).element([_.OfParameter])),
            }),
        ])]))])


def _context(store: Any, context: Any, caller: str) -> Any:
    """`context`, a `Contexts.OfContext` value, as the durable value it is; `TypeError` where it is not one."""
    held = Proxies._durable(context)
    if not (isinstance(held, Proxies._RecordData) and held._schema is store.registered(CONTEXT)):
        raise TypeError(f"{caller} takes a context ({CONTEXT}), not {context!r}")
    return held


def within(store: Any, outer: Any, own: Any) -> Any:
    """A sub-context: a new `Contexts.OfContext` that holds the entries of `outer`, with those of `own` added, each
    replacing the entry of `outer` that has its name. It copies both, so that nothing links it to either."""
    schema = store.registered(CONTEXT)
    written = [Plain.ToPlain(store)(schema, _context(store, given, "Contexts.within")) for given in (outer, own)]
    merged = {name: {**written[0].get(name, {}), **written[1].get(name, {})} for name in _CONTAINERS}
    return Plain.FromPlain(store)(schema, {name: entries for name, entries in merged.items() if entries})


def entries(store: Any, context: Any, container: str) -> dict[str, Any]:
    """The entries of a context's `variables`, `symbols` or `parameters`, by name, each as its visitor."""
    held = _context(store, context, "Contexts.entries")
    found: dict[str, Any] = {}
    pairs: list[Any] = []

    def held_by(c: Any) -> Any:
        c.as_entries(pairs.extend)
        return c

    def value(a: Any) -> Any:
        a.as_container(held_by)
        return a
    getattr(held, container).as_value(value)
    for index, element in pairs:
        element.as_object(lambda v, index=index: found.setdefault(index, v))
    return found


def held(prop: Any) -> Any:
    """The value object that a property of an entry holds, a reference (`References.OfSchema`, `.OfObject` or
    `.OfValue`), as its visitor; None where the property is not set."""
    found: list[Any] = []

    def value(a: Any) -> Any:
        a.as_object(lambda v: found.append(v) or v)
        return a
    prop.as_value(value)
    return found[0] if found[0].as_schema() is not None else None  # a visitor of nothing has no schema


def validate(store: Any, context: Any) -> list[str]:
    """The problems of a context: an entry whose name is not the one it is indexed by; a schema reference whose path
    is not a schema object's, or that designates no schema object the store holds; a symbol whose schema is not an
    object schema (`References.OfSchema[Schemas.OfObject]`, [CAP-320: schema and value references](mbse:mbse-basis/docs/capabilities/README.md#CAP-320)); and a parameter both bound to an object and
    assigned a value."""
    problems: list[str] = []
    for container, noun in (("variables", "variable"), ("symbols", "symbol"), ("parameters", "parameter")):
        for name, entry in entries(store, context, container).items():
            if entry.name.get() != name:
                problems.append(f"{noun} {name!r}: its entry is named {entry.name.get()!r}")
            schema = held(entry.schema)
            if schema is not None:
                kind = store.Schemas.OfObject if container == "symbols" else None
                problems += [f"{noun} {name!r}: {problem}" for problem in References.validate_schema(store, schema, kind)]
            if container == "parameters" and held(entry.object) is not None and held(entry.value) is not None:
                problems.append(f"parameter {name!r} is both bound to an object and assigned a value")
    return problems
