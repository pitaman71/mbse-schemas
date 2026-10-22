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

## Stages, as built

- **4m-1, `Parametrics` beside today's parameters.** `Framework/Parametrics.py` and `Framework/Parametrics.ts`, exported
  as `Framework.Parametrics` beside the other modules: `install(txn)`, the draft above, defining
  `Parametrics.OfParameters`, `Defines`, `ForValue`, `ForObject`, `HasParameters`, `BindsValue` and `BindsObject`, and
  extending `Schemas.OfParameter` and every kind; and `validate(store, defn)`. Installed before use, never by the
  bootstrap; installed again, it writes nothing. Declared in an install, a set is defined where its definition links
  it, as the draft writes it, `txn.Parametrics.OfParameters(lambda ps: ps.parameters({...}))`; imperatively, the same
  through `store.Parametrics.OfParameters`. PAR-03 to PAR-06 cover it, in both languages.

  *Fixed by the agent, for the user's review:*

  1. **The name clash.** Every kind has the core's `parameters` until 4m-2, and the extension check refuses a name a
     schema has, so in 4m-1 the extension names each kind's adjacency to `HasParameters` `parameter_set`; 4m-2 renames
     it `parameters` when the core's goes. PAR-01 and PAR-02 keep testing the core's until then.
  2. **How validation is reached**: `Parametrics.validate(store, defn)`, the problems of a definition's parameters,
     checked of its set's `Defines` entries: a name starting with `$` (reserved), a description not text, a parameter
     for neither a value nor an object or for both (Decided, 1), and, of a pattern, a name used as both a symbol or a
     variable and a parameter. The messages are the core's (`names used as both symbol and parameter: ['x']`) and, for
     Decided, 1, `parameter 'x' is for neither a value nor an object: a parameter is for one` (`... for both a value
     and an object ...`). It also checks `HasParameters`' uniqueness in both directions (`it has 2 sets of parameters:
     a definition has one`; `its set of parameters belongs to 2 definitions: a set belongs to one`), which nothing
     else checks: validation checks data, and the set's end of `HasParameters` is anonymous. A kind's own `validate()`
     does not read the extension's entries: the core does not know `Parametrics`. Chosen over the kinds' `validate()`
     reading them where installed, which would keep the core knowing what it no longer holds.
  3. **A set is a counted object**, owned by nothing. The draft's `.owner(True)` on `OfParameters`' `parameters` would
     make a set owned by its parameter, `owner()` marking the owned end (a member's, in `Schemas.install`). Owned by its
     definition, through `HasParameters`, a set could not be read by a store without `Parametrics`: the owning entry is
     ignored there (Store overhaul, Decided, 19), and an owned object no entry owns is refused. Nor does a set own its
     parameters: a parameter is a schema object, and validation refuses an adjacency that would make a counted object
     an owner.
  4. **`Schemas.OfParameter` also declares its end of `Defines`**, anonymously (`me("parameter")`), so that a set's
     entry defines its parameter where it links it (`d.parameter(lambda p: p.for_value([S.OfInt]))`): a link's schema
     is the one object schema that declares an adjacency to it.
  5. **`BindsValue`'s `value` is `S.OfAny(lambda a: a)`**, a value of any schema, defined where it is linked: `S.OfAny`
     alone names the meta-schema, whose instances are schemas.
  6. **The install's uid is `mbse.Schemas.Parametrics/1`**, as the framework's own installs are named
     (`mbse.Schemas.Paths/1`), not the draft's `mbse-schemas.Parametrics/1`.

  *What building it found the framework lacked, built in both languages:*

  - Within a spec, `txn.X.Y(cb)` for a reference object schema of data records a definition where it is linked, as
    `txn.Schemas.OfX(cb)` does for a schema object; the executor makes it where it writes the link, and finds an equal
    one held (before, it created the object at once, outside the transaction's spec).
  - An extension's adjacency read on a schema object no store holds yet, one being built, holds nothing (it raised).
  - A schema object that existed before a transaction is updated at its commit (Object identity, Decided, 96); its
    entries in an extension's relations are now written at once, in the transaction's proposals, as data's are. Written
    at commit, they went into the store, and were then overwritten by the proposals' entry tables of the objects they
    link, wherever the transaction had written other entries of those objects: reading a snapshot, a definition lost
    its set where one of its parameters was for an object of the definition itself. EXT-05 asserts the entry within
    the transaction.
  - Python: matching a spec's entry against an entry held that links data took the link's target for a builder.

  *Snapshots*: a set is data, written with the store's data as a counted object; the definition's entry in
  `HasParameters` is written once, from the definition, in the data's transaction, as an extension's relation's entries
  are (EXT-05). A set's entries are data's keyed entries, written sorted by their names (SERIALIZATION.md), so a set
  read back holds its parameters in that order, not as declared.

  *Not built, stopped on for a decision* (open): **the bindings' adjacencies, `values` and `objects`.** The extension
  mechanism refuses them: an adjacency an extension adds to a meta-schema is to a relation of two links and no
  properties (Schema extension, Decided, 18, as built, and 22: "yes that's a compromise"), and `BindsValue` has an
  entry property and `BindsObject` three links (Decided, 3), so the draft's install raises `TypeError: an extension's
  adjacency 'values' is to a relation of two links and no properties, got 'Parametrics.BindsValue'`. `BindsValue` and
  `BindsObject` are defined; no kind has `values` or `objects`. The choices: (a) extend the mechanism, so that a
  builder's member of an extension's adjacency holds entries with their properties and links, as a proxy's adjacency
  does (`o.values(lambda a: a.insert(lambda e: e.param([n]).value(3)))`), revising Schema extension, Decided, 18 and
  22; (b) bindings as objects linked by relations of two links, as formals are (Schema extension, Decided, 22); (c)
  leave bindings unbuilt until something binds (Store overhaul, Decided, 12 and 28).
