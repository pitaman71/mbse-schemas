/**
 * Parametrics: the parameters of definitions, what each can be bound to, and their bindings ([CAP-112: parameters modeled as schema data](../../../../mbse-basis/docs/capabilities/CAP-112.md);
 * [CAP-171: parameters attached to every schema kind by extension](../../../../mbse-basis/docs/capabilities/CAP-171.md)).
 *
 * Normal schemas and one extension, installed before use: `store.transaction(Parametrics.install)`. A parameter is a
 * `Schemas.OfParameter`, a name and a description; `Parametrics.OfParameters` is a set of named parameters, holding
 * each through `Parametrics.Defines`, keyed by its name. A parameter is for a value of one schema
 * (`Parametrics.ForValue`) or for a reference to an object of one object schema (`Parametrics.ForObject`), exactly one.
 * A definition, a schema of any kind, has one set of parameters (`Parametrics.HasParameters`, unique in both
 * directions); a binding, at the definition that binds it, is `Parametrics.BindsValue`, its value an entry property, or
 * `Parametrics.BindsObject`, the object a third link.
 *
 * The extension: `install` gives `Schemas.OfParameter` its `for_value` and `for_object`, and every kind of schema its
 * `parameters` (to `HasParameters`). `validate(store, defn)` checks a definition's set's `Defines` entries.
 */

import * as Builders from "./Builders.js";
import * as Proxies from "./Proxies.js";
import * as Schemas from "./Schemas.js";
import { repr, sortedStrings } from "./Repr.js";

/** Parameters of definitions, what each can be bound to, and their bindings, defined in the store a transaction writes;
 * the extension of the schemas the store was made holding, `Schemas.OfParameter` and each kind of schema. Run again in
 * a store, it finds each by its name and writes nothing. */
export function install(txn: any): any {
  const S = txn.Schemas; // the store's meta-schemas and basic scalars (78)
  return txn.uid("mbse.Schemas.Parametrics/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({
      OfParameters: S.OfObject, Defines: S.OfRelation, ForValue: S.OfRelation, ForObject: S.OfRelation,
      HasParameters: S.OfRelation, BindsValue: S.OfRelation, BindsObject: S.OfRelation,
      OfParameter: S.OfObject, OfScalar: S.OfObject, OfObject: S.OfObject, OfUnion: S.OfObject,
      OfIntersection: S.OfObject, OfContainer: S.OfObject, OfAny: S.OfObject, OfRelation: S.OfObject,
      OfPattern: S.OfObject, OfExpression: S.OfObject, OfCollector: S.OfObject, OfModule: S.OfObject,
    })
    .spec([
      // --- The schemas of Parametrics ---
      (_: any) => _.OfParameters.name("Parametrics.OfParameters").ref(true).adjacencies({
        parameters: (a: any) => a.relation([_.Defines]).me("parameters"),
      }).adjacencies([
        (a: any) => a.relation([_.HasParameters]).me("params"),
      ]),
      (_: any) => _.Defines.name("Parametrics.Defines").links([
        (t: any) => t.name("parameters"), (t: any) => t.name("parameter")]).properties({ name: S.OfStr }).uniques([
        ["parameters", "name"], ["parameter"]]),
      (_: any) => _.ForValue.name("Parametrics.ForValue").links([
        (t: any) => t.name("param"), (t: any) => t.name("schema")]).uniques("schema"), // one schema per parameter
      (_: any) => _.ForObject.name("Parametrics.ForObject").links([
        (t: any) => t.name("param"), (t: any) => t.name("schema")]).uniques("schema"), // one schema per parameter
      (_: any) => _.HasParameters.name("Parametrics.HasParameters").links([
        (t: any) => t.name("defn"), (t: any) => t.name("params")]).uniques([["defn"], ["params"]]),
      (_: any) => _.BindsValue.name("Parametrics.BindsValue").links([
        (t: any) => t.name("defn"), (t: any) => t.name("param")]).properties({
        value: S.OfAny((a: any) => a) }), // a value of any schema
      (_: any) => _.BindsObject.name("Parametrics.BindsObject").links([
        (t: any) => t.name("defn"), (t: any) => t.name("param"), (t: any) => t.name("obj_ref")]),

      // --- The extension: a parameter's ends, and each kind's set of parameters ---
      (_: any) => _.OfParameter.name("Schemas.OfParameter").adjacencies({
        for_value: (a: any) => a.relation([_.ForValue]).me("param"),
        for_object: (a: any) => a.relation([_.ForObject]).me("param"),
      }).adjacencies([
        (a: any) => a.relation([_.Defines]).me("parameter"),
      ]),
      (_: any) => _.OfScalar.name("Schemas.OfScalar").adjacencies({
        parameters: (a: any) => a.relation([_.HasParameters]).me("defn") }),
      (_: any) => _.OfObject.name("Schemas.OfObject").adjacencies({
        parameters: (a: any) => a.relation([_.HasParameters]).me("defn") }),
      (_: any) => _.OfUnion.name("Schemas.OfUnion").adjacencies({
        parameters: (a: any) => a.relation([_.HasParameters]).me("defn") }),
      (_: any) => _.OfIntersection.name("Schemas.OfIntersection").adjacencies({
        parameters: (a: any) => a.relation([_.HasParameters]).me("defn") }),
      (_: any) => _.OfContainer.name("Schemas.OfContainer").adjacencies({
        parameters: (a: any) => a.relation([_.HasParameters]).me("defn") }),
      (_: any) => _.OfAny.name("Schemas.OfAny").adjacencies({
        parameters: (a: any) => a.relation([_.HasParameters]).me("defn") }),
      (_: any) => _.OfRelation.name("Schemas.OfRelation").adjacencies({
        parameters: (a: any) => a.relation([_.HasParameters]).me("defn") }),
      (_: any) => _.OfPattern.name("Schemas.OfPattern").adjacencies({
        parameters: (a: any) => a.relation([_.HasParameters]).me("defn") }),
      (_: any) => _.OfExpression.name("Schemas.OfExpression").adjacencies({
        parameters: (a: any) => a.relation([_.HasParameters]).me("defn") }),
      (_: any) => _.OfCollector.name("Schemas.OfCollector").adjacencies({
        parameters: (a: any) => a.relation([_.HasParameters]).me("defn") }),
      (_: any) => _.OfModule.name("Schemas.OfModule").adjacencies({
        parameters: (a: any) => a.relation([_.HasParameters]).me("defn") }),
    ])]))]);
}

/** The problems of a definition's parameters, a check of its set's `Parametrics.Defines` entries: a name starting with
 * `$`, reserved; a description that is not text; a parameter for neither a value nor an object, or for both; and, of a
 * pattern, a name used as both a symbol or a variable and a parameter; and that the definition has one set, and its set
 * one definition (`Parametrics.HasParameters`, unique in both directions). None where it has no set. */
export function validate(store: any, defn: any): string[] {
  const reader = (data: any): any => new (Builders._builder_for(data) as any)(data, false, store);
  const builder = reader(defn);
  const hasParameters = builder.as_schema().adjacencies.get("parameters").relation;
  const sets = [...builder.parameters].map((held: any) => Builders._linked_data(held.params) as any);
  let problems: string[] = [];
  if (sets.length > 1) problems.push(`it has ${sets.length} sets of parameters: a definition has one`);
  const names: string[] = [];
  for (const params of sets) {
    const owners = Proxies._linking(hasParameters, "params", params).length;
    if (owners > 1) problems.push(`its set of parameters belongs to ${owners} definitions: a set belongs to one`);
    for (const entry of params.parameters) {
      const name = entry.name.get() as string;
      const parameter = entry.parameter;
      names.push(name);
      problems.push(...Schemas._description_problems(parameter.description).map((p) => `parameter ${repr(name)}: ${p}`));
      const ends = reader(parameter);
      const forValue = [...ends.for_value].length;
      const forObject = [...ends.for_object].length;
      if (forValue === 0 && forObject === 0) {
        problems.push(`parameter ${repr(name)} is for neither a value nor an object: a parameter is for one`);
      } else if (forValue > 0 && forObject > 0) {
        problems.push(`parameter ${repr(name)} is for both a value and an object: a parameter is for one`);
      }
    }
  }
  problems = [...Schemas._reserved(names), ...problems];
  if (defn instanceof Schemas.OfPattern.Data) {
    for (const [namesOf, plural] of [[defn.symbols, "symbol and parameter"], [defn.variables, "variable and parameter"]] as const) {
      const clashes = names.filter((name) => namesOf.has(name));
      if (clashes.length > 0) problems.push(`names used as both ${plural}: ${repr(sortedStrings(new Set(clashes)))}`);
    }
  }
  return problems;
}
