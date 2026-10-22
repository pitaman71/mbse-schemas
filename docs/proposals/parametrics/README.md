# Parametrics as a module (a draft for review)

[Parametrics](../../PARAMETRICS.md), as the user rewrote it (2026-10-22), takes parameters out of the core meta-schemas
into a module of their own, `Parametrics`: "normal schemas and one extension", installed before use. Today a parameter
is a name every kind declares through `Schemas.HasParameter` (Store overhaul, Decided, 20: "Names only"), checked for
its name and description, written in snapshots, and read by nothing else: nothing binds it, substitutes it or says
what it stands for. This draft builds the user's model in place of that, and moves every use to it.

## The model, as the user wrote it

- `Schemas.OfParameter` stays: a reference object, its `name` and `description`.
- `Parametrics.OfParameters`: a reference object, a set of named parameters, holding each through
  `Parametrics.Defines(parameters, name, parameter)`, keyed by `name`.
- What a parameter can be bound to, one schema each (`*:1`):
  - `Parametrics.ForValue(param, schema: Schemas.OfAny)`: a value of that schema;
  - `Parametrics.ForObject(param, schema: Schemas.OfObject)`: a reference to an object of that schema.
- `Parametrics.HasParameters(defn, params: Parametrics.OfParameters)`, unique in both directions: a definition has one
  set of parameters, and a set belongs to one definition.
- Bindings, at the definition that binds them:
  - `Parametrics.BindsValue(defn, param, value)`, `value` an entry property (`Parametrics.value`);
  - `Parametrics.BindsObject(defn, param, obj_ref)`.
- `Parametrics.install` extends each `Schemas.OfX` (every kind of schema) with three adjacencies: `parameters` to
  `HasParameters`, `values` to `BindsValue`, `objects` to `BindsObject`.

## As drafted

`Parametrics.install` is an install (docs/proposals/install), in both languages, in a module of its own
(`Framework/Parametrics.py`, `Framework/Parametrics.ts`):

```python
def install(txn):
    """Parameters of definitions, what each can be bound to, and their bindings (docs/PARAMETRICS.md)."""
    S = txn.Schemas
    return txn.uid("mbse-schemas.Parametrics/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"OfParameters": S.OfObject, "Defines": S.OfRelation, "ForValue": S.OfRelation,
                  "ForObject": S.OfRelation, "HasParameters": S.OfRelation, "BindsValue": S.OfRelation,
                  "BindsObject": S.OfRelation,
                  "OfParameter": S.OfObject, "OfObject": S.OfObject, ...})  # the kinds it extends, found
        .spec([
            lambda _: _.OfParameters.name("Parametrics.OfParameters").ref(True)
            .adjacencies({"parameters": lambda a: a.relation([_.Defines]).me("parameters").owner(True)}),
            lambda _: _.Defines.name("Parametrics.Defines").links([
                lambda t: t.name("parameters"), lambda t: t.name("parameter")]).properties({"name": S.OfStr})
            .uniques([["parameters", "name"], ["parameter"]]),
            lambda _: _.ForValue.name("Parametrics.ForValue").links([
                lambda t: t.name("param"), lambda t: t.name("schema")]).uniques("param"),
            lambda _: _.ForObject.name("Parametrics.ForObject").links([
                lambda t: t.name("param"), lambda t: t.name("schema")]).uniques("param"),
            lambda _: _.HasParameters.name("Parametrics.HasParameters").links([
                lambda t: t.name("defn"), lambda t: t.name("params")]).uniques([["defn"], ["params"]]),
            lambda _: _.BindsValue.name("Parametrics.BindsValue").links([
                lambda t: t.name("defn"), lambda t: t.name("param")]).properties({"value": S.OfAny}),
            lambda _: _.BindsObject.name("Parametrics.BindsObject").links([
                lambda t: t.name("defn"), lambda t: t.name("param"), lambda t: t.name("obj_ref")]),
            # the extension: a parameter's two ends, and each kind's three adjacencies
            lambda _: _.OfParameter.name("Schemas.OfParameter").adjacencies({
                "for_value": lambda a: a.relation([_.ForValue]).me("param"),
                "for_object": lambda a: a.relation([_.ForObject]).me("param")}),
            lambda _: _.OfObject.name("Schemas.OfObject").adjacencies({
                "parameters": lambda a: a.relation([_.HasParameters]).me("defn"),
                "values": lambda a: a.relation([_.BindsValue]).me("defn"),
                "objects": lambda a: a.relation([_.BindsObject]).me("defn")}),
            ...  # the same three for every other kind
        ])]))])
```

A schema then declares its parameters where `parameters` links its set, the set defined in place (linked once, by the
one definition it belongs to). The corpus's `Grid`, as it would read:

```python
store.transaction(Parametrics.install)


def module(txn):
    S = txn.Schemas
    return txn.uid("corpus.module/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Grid": S.OfObject, ...})
        .spec([
            lambda _: _.Grid.name("Grid").parameters([txn.Parametrics.OfParameters(lambda ps: ps.parameters({
                "n": lambda d: d.parameter(lambda p: p.description("Its side").for_value([S.OfInt])),  # keyed: its name
                "x": lambda d: d.parameter(lambda p: p),
            }))]).properties({...}),
            ...
        ])]))])
```

## What changes

- **The core loses parameters.** `Schemas.HasParameter` goes, and so does each kind's built-in `parameters` adjacency
  and its `parameters` member in the data classes and builders; `Schemas.OfParameter` stays in `Schemas`, a name and a
  description. Parameters are declared only where `Parametrics` is installed.
- **Validation moves to `Parametrics.Defines`**, as the user decided ("move it to Parametrics.Defines"): what a kind's
  `validate()` checks of its parameters today (a name starting with `$` reserved; a description not a string; in a
  pattern, a name used as both a symbol or a variable and a parameter) is checked of a set's `Defines` entries.
- **Snapshots** write a definition's parameters as the extension's entries (SCHEMA_EXTENSION.md: an extension's
  relation written once); a store without `Parametrics` reads them as a snapshot made with extensions it lacks
  (Store overhaul, Decided, 19).
- **Moved to it** ("yes move the corpus to the updated Parametrics framework"): the corpus's `Grid`, `Tricky` and
  `Lives` (its `era`), so the corpora change in both languages together; PAR rewritten; SCH, BLD, SNP, PAT and INS
  where they declare parameters; the skill (python.md, typescript.md, modeling.md); FRAMEWORK.md's Parametrics.
- **Not built**: substituting a binding (`Parameters.Apply`), checking a binding's value against its parameter's
  `ForValue` schema, and expression parameters ("TBD"). Bindings are stored, as `Parameters.Bind` would have stored
  them (Store overhaul, Decided, 12 and 28: "super lazy").

## Decided

As the user decided (2026-10-22), on the questions this draft put:

1. **A parameter is for a value or for an object, exactly one.** A parameter with neither `ForValue` nor `ForObject`
   "should fail validation" (a check of `Parametrics.Defines`' entries, beside the others). The corpus's bare names
   so each take one when moved: chosen while building, and recorded there.
2. **Adjacency names**, "sure": on `Parametrics.OfParameters`, `parameters` (to `Defines`); on
   `Schemas.OfParameter`, `for_value` and `for_object`.
3. **Bindings**, "yes": `BindsObject`'s `obj_ref` is a third link, `BindsValue`'s `value` an entry property.
4. **First of what remains of step 4**: "4m should go before 4k or any other 4*". In two stages: **4m-1**,
   `Parametrics` and its validation, beside today's parameters (both gates at 100%); **4m-2**, every use moved, the
   core's parameters removed, the corpora regenerated.
