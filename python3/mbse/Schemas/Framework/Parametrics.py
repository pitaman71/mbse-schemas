"""Parametrics: the parameters of definitions, what each can be bound to, and their bindings ([CAP-112: parameters modeled as schema data](../../../../../mbse-basis/docs/capabilities/CAP-112.md);
[CAP-171: parameters attached to every schema kind by extension](../../../../../mbse-basis/docs/capabilities/CAP-171.md)).

Normal schemas and one extension, installed before use: `store.transaction(Parametrics.install)`. A parameter is a
`Schemas.OfParameter`, a name and a description; `Parametrics.OfParameters` is a set of named parameters, holding each
through `Parametrics.Defines`, keyed by its name. A parameter is for a value of one schema (`Parametrics.ForValue`) or
for a reference to an object of one object schema (`Parametrics.ForObject`), exactly one. A definition, a schema of any
kind, has one set of parameters (`Parametrics.HasParameters`, unique in both directions); a binding, at the definition
that binds it, is `Parametrics.BindsValue`, its value an entry property, or `Parametrics.BindsObject`, the object a
third link.

The extension: `install` gives `Schemas.OfParameter` its `for_value` and `for_object`, and every kind of schema its
`parameters` (to `HasParameters`). `validate(store, defn)` checks a definition's set's `Defines` entries.
"""

from __future__ import annotations

from typing import Any

from . import Proxies, Schemas
from .Builders import _builder_for

__all__ = ["install", "validate"]


def install(txn: Any) -> Any:
    """Parameters of definitions, what each can be bound to, and their bindings, defined in the store a transaction
    writes; the extension of the schemas the store was made holding, `Schemas.OfParameter` and each kind of schema. Run
    again in a store, it finds each by its name and writes nothing."""
    S = txn.Schemas  # the store's meta-schemas and basic scalars (78)
    return txn.uid("mbse.Schemas.Parametrics/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({
            "OfParameters": S.OfObject, "Defines": S.OfRelation, "ForValue": S.OfRelation, "ForObject": S.OfRelation,
            "HasParameters": S.OfRelation, "BindsValue": S.OfRelation, "BindsObject": S.OfRelation,
            "OfParameter": S.OfObject, "OfScalar": S.OfObject, "OfObject": S.OfObject, "OfUnion": S.OfObject,
            "OfIntersection": S.OfObject, "OfContainer": S.OfObject, "OfAny": S.OfObject, "OfRelation": S.OfObject,
            "OfPattern": S.OfObject, "OfExpression": S.OfObject, "OfCollector": S.OfObject, "OfModule": S.OfObject,
        })
        .spec([
            # --- The schemas of Parametrics ---
            lambda _: _.OfParameters.name("Parametrics.OfParameters").ref(True).adjacencies({
                "parameters": lambda a: a.relation([_.Defines]).me("parameters"),
            }).adjacencies([
                lambda a: a.relation([_.HasParameters]).me("params"),
            ]),
            lambda _: _.Defines.name("Parametrics.Defines").links([
                lambda t: t.name("parameters"), lambda t: t.name("parameter")]).properties({"name": S.OfStr}).uniques([
                ["parameters", "name"], ["parameter"]]),
            lambda _: _.ForValue.name("Parametrics.ForValue").links([
                lambda t: t.name("param"), lambda t: t.name("schema")]).uniques("schema"),  # one schema per parameter
            lambda _: _.ForObject.name("Parametrics.ForObject").links([
                lambda t: t.name("param"), lambda t: t.name("schema")]).uniques("schema"),  # one schema per parameter
            lambda _: _.HasParameters.name("Parametrics.HasParameters").links([
                lambda t: t.name("defn"), lambda t: t.name("params")]).uniques([["defn"], ["params"]]),
            lambda _: _.BindsValue.name("Parametrics.BindsValue").links([
                lambda t: t.name("defn"), lambda t: t.name("param")]).properties({
                "value": S.OfAny(lambda a: a)}),  # a value of any schema
            lambda _: _.BindsObject.name("Parametrics.BindsObject").links([
                lambda t: t.name("defn"), lambda t: t.name("param"), lambda t: t.name("obj_ref")]),

            # --- The extension: a parameter's ends, and each kind's set of parameters ---
            lambda _: _.OfParameter.name("Schemas.OfParameter").adjacencies({
                "for_value": lambda a: a.relation([_.ForValue]).me("param"),
                "for_object": lambda a: a.relation([_.ForObject]).me("param"),
            }).adjacencies([
                lambda a: a.relation([_.Defines]).me("parameter"),
            ]),
            lambda _: _.OfScalar.name("Schemas.OfScalar").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn")}),
            lambda _: _.OfObject.name("Schemas.OfObject").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn")}),
            lambda _: _.OfUnion.name("Schemas.OfUnion").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn")}),
            lambda _: _.OfIntersection.name("Schemas.OfIntersection").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn")}),
            lambda _: _.OfContainer.name("Schemas.OfContainer").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn")}),
            lambda _: _.OfAny.name("Schemas.OfAny").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn")}),
            lambda _: _.OfRelation.name("Schemas.OfRelation").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn")}),
            lambda _: _.OfPattern.name("Schemas.OfPattern").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn")}),
            lambda _: _.OfExpression.name("Schemas.OfExpression").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn")}),
            lambda _: _.OfCollector.name("Schemas.OfCollector").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn")}),
            lambda _: _.OfModule.name("Schemas.OfModule").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn")}),
        ])]))])


def validate(store: Any, defn: Any) -> list[str]:
    """The problems of a definition's parameters, a check of its set's `Parametrics.Defines` entries: a name starting
    with `$`, reserved; a description that is not text; a parameter for neither a value nor an object, or for both; and,
    of a pattern, a name used as both a symbol or a variable and a parameter; and that the definition has one set, and
    its set one definition (`Parametrics.HasParameters`, unique in both directions). None where it has no set."""
    builder = _builder_for(defn)(defn, False, store)
    has_parameters = builder.as_schema().adjacencies["parameters"].relation
    sets = [held.params._target() for held in builder.parameters]
    problems: list[str] = []
    if len(sets) > 1:
        problems.append(f"it has {len(sets)} sets of parameters: a definition has one")
    names: list[str] = []
    for params in sets:
        owners = len(Proxies._linking(has_parameters, "params", params))
        if owners > 1:
            problems.append(f"its set of parameters belongs to {owners} definitions: a set belongs to one")
        for entry in params.parameters:
            name, parameter = entry.name.get(), entry.parameter
            names.append(name)
            problems += [f"parameter {name!r}: {p}" for p in Schemas._description_problems(parameter.description)]
            ends = _builder_for(parameter)(parameter, False, store)
            given = (len(list(ends.for_value)), len(list(ends.for_object)))
            if given == (0, 0):
                problems.append(f"parameter {name!r} is for neither a value nor an object: a parameter is for one")
            elif 0 not in given:
                problems.append(f"parameter {name!r} is for both a value and an object: a parameter is for one")
    problems = Schemas._reserved(names) + problems
    if isinstance(defn, Schemas.OfPattern.Data):
        for names_of, plural in ((defn.symbols, "symbol and parameter"), (defn.variables, "variable and parameter")):
            clashes = set(names_of) & set(names)
            if clashes:
                problems.append(f"names used as both {plural}: {sorted(clashes)}")
    return problems
