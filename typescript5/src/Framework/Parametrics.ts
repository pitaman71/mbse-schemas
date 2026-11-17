/**
 * Parametrics: the parameters of definitions, what each is for, and the assignments and bindings of the objects a
 * definition governs ([CAP-112: parameters modeled as schema data](mbse:mbse-basis/docs/capabilities/CAP-112.md); [CAP-171: parameters attached to every schema kind by extension](mbse:mbse-basis/docs/capabilities/CAP-171.md); [CAP-314: parameters bound by the data objects their schema governs](mbse:mbse-basis/docs/capabilities/README.md#CAP-314)).
 *
 * Normal schemas and one extension, installed before use: `store.transaction(Parametrics.install)`. A parameter is a
 * `Schemas.OfParameter`, a name and a description; `Parametrics.OfParameters` is a set of named parameters, holding
 * each through `Parametrics.Defines`, keyed by its name. A parameter is for a value of one schema
 * (`Parametrics.ForValue`) or for a reference to an object of one object schema (`Parametrics.ForObject`), exactly one.
 * A definition, a schema of any kind, has one set of parameters (`Parametrics.HasParameters`, unique in both
 * directions). A schema declares parameters and gives none of them a value or an object: a reference object that the
 * schema governs assigns a value to a parameter for a value, through `Parametrics.AssignsValue`, which links the object
 * and the parameter and holds the value as the entry property `value`; and it binds a parameter for an object to an
 * object, through `Parametrics.BindsObject`, which links the object, the parameter and the object bound, `obj_ref`, any
 * reference object. A parameter that an object neither assigns nor binds stays unbound.
 *
 * The extension: `install` gives `Schemas.OfParameter` its `for_value` and `for_object`, and every kind of schema its
 * `parameters` (to `HasParameters`). `extend(txn, schemas)` gives reference object schemas the adjacencies through
 * which their objects assign and bind, `assigned_values` and `bound_objects`. A transaction that assigns or binds a
 * parameter which the object's schema does not declare is refused when it commits (`_check`). `validate(store, defn)` checks a definition's set's
 * `Defines` entries.
 */

import * as Builders from "./Builders.js";
import { LookupError, ValueError } from "./Errors.js";
import type * as Proposals from "./Proposals.js";
import * as Proxies from "./Proxies.js";
import * as Schemas from "./Schemas.js";
import { repr, sortedStrings } from "./Repr.js";

/** Parameters of definitions, what each is for, and the assignments and bindings of the objects a definition governs,
 * defined in the store a transaction writes; the extension of the schemas the store was made holding, `Schemas.OfParameter`
 * and each kind of schema. Run again in a store, it finds each by its name and writes nothing. */
export function install(txn: any): any {
  const S = txn.Schemas; // the store's meta-schemas and basic scalars (78)
  return txn.uid("mbse.Schemas.Parametrics/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({
      OfParameters: S.OfObject, Defines: S.OfRelation, ForValue: S.OfRelation, ForObject: S.OfRelation,
      HasParameters: S.OfRelation, AssignsValue: S.OfRelation, BindsObject: S.OfRelation,
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
      (_: any) => _.AssignsValue.name("Parametrics.AssignsValue").links([
        (t: any) => t.name("object"), (t: any) => t.name("param")]).properties({
        value: S.OfAny((a: any) => a) }), // a value of any schema
      (_: any) => _.BindsObject.name("Parametrics.BindsObject").links([
        (t: any) => t.name("object"), (t: any) => t.name("param"), (t: any) => t.name("obj_ref")]),

      // --- The extension: a parameter's ends, and each kind's set of parameters ---
      (_: any) => _.OfParameter.name("Schemas.OfParameter").adjacencies({
        for_value: (a: any) => a.relation([_.ForValue]).me("param"),
        for_object: (a: any) => a.relation([_.ForObject]).me("param"),
      }).adjacencies([
        (a: any) => a.relation([_.Defines]).me("parameter"),
        (a: any) => a.relation([_.AssignsValue]).me("param"), // anonymous: what assigns it a value, or binds it
        (a: any) => a.relation([_.BindsObject]).me("param"),
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

/** The problems of a definition's parameters, or of the assignments and bindings of an object that a definition
 * governs. Of a definition, a check of its set's `Parametrics.Defines` entries: a name starting with `$`, reserved; a description
 * that is not text; a parameter for neither a value nor an object, or for both; and, of a pattern, a name used as both a
 * symbol or a variable and a parameter; and that the definition has one set, and its set one definition
 * (`Parametrics.HasParameters`, unique in both directions). None where it has no set. Of a reference object, read
 * within a transaction, each of its assignments (`Parametrics.AssignsValue`) and bindings (`Parametrics.BindsObject`)
 * of a parameter that its schema does not declare. Whether an assignment's value, or a binding's object, is of its
 * parameter's schema is not checked. */
export function validate(store: any, defn: any): string[] {
  if (Proxies._isObjectData(defn)) {
    const target = Proxies._durable(defn);
    return ["AssignsValue", "BindsObject"].flatMap((name) => {
      const relation = store.registered(`Parametrics.${name}`);
      return Proxies._linking(relation, "object", target, store).map((entry: any) => undeclared(store, relation, entry));
    }).filter((problem): problem is string => problem !== null);
  }
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

/** Gives each reference object schema of `schemas` (each a schema object, or its name as a path, `txn.hw.Bus`) the
 * adjacencies through which its objects assign values to the parameters it declares, `assigned_values`, to
 * `Parametrics.AssignsValue`, and bind them to objects, `bound_objects`, to `Parametrics.BindsObject`, each through
 * `object`
 * ([CAP-314: parameters bound by the data objects their schema governs](mbse:mbse-basis/docs/capabilities/README.md#CAP-314)); the transaction that does, in the store a
 * transaction writes: `store.transaction((t: any) => Parametrics.extend(t, [t.hw.Bus]))`. An app's install calls it
 * after its own and `Parametrics.install`; run again, it writes nothing. A value object is never linked, so that a
 * value object schema is refused, as are the meta-schemas, whose objects are schemas, and a schema that declares a
 * member of either name. */
export function extend(txn: any, schemas: Iterable<unknown>): any {
  const P = txn.Parametrics;
  try {
    P.AssignsValue.as_schema();
  } catch {
    throw new LookupError("Parametrics.extend: the store has no Parametrics installed; install it first, "
      + "store.transaction(Parametrics.install)");
  }
  const names: string[] = [];
  for (const given of schemas) {
    const schema: any = Proxies._deref(given);
    if (!(schema instanceof Schemas.OfObject.Data)) {
      const shown = typeof schema?.name === "string" ? schema.name : given;
      throw new TypeError(`Parametrics.extend takes reference object schemas: ${repr(shown)} is not one`);
    }
    if (String(schema.name).startsWith("Schemas.")) { // a schema declares parameters, and its data assigns and binds them
      throw new TypeError(`Parametrics.extend: ${repr(schema.name)} is one of the meta-schemas, whose objects are `
        + "schemas: a schema declares its parameters and neither assigns nor binds them");
    }
    if (!schema.ref) {
      throw new TypeError(`Parametrics.extend takes reference object schemas: ${repr(schema.name)} is a value object `
        + "schema, whose objects are never linked, so that none assigns or binds a parameter");
    }
    for (const [member, relation] of [["assigned_values", P.AssignsValue], ["bound_objects", P.BindsObject]] as const) {
      if (schema.properties.has(member)
        || (schema.adjacencies.has(member) && schema.adjacencies.get(member)!.relation !== relation.as_schema())) {
        throw new TypeError(`Parametrics.extend: ${repr(schema.name)} already declares a member ${repr(member)}`);
      }
    }
    names.push(schema.name as string);
  }
  const symbols = Object.fromEntries(names.map((_name, index) => [`s${index}`, txn.Schemas.OfObject]));
  return txn.mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p.symbols(symbols).spec(
    names.map((name, index) => (_: any) => _[`s${index}`].name(name).adjacencies({
      assigned_values: (a: any) => a.relation([P.AssignsValue]).me("object"),
      bound_objects: (a: any) => a.relation([P.BindsObject]).me("object"),
    })))]))]);
}

/** Refuses a transaction, just before it commits, that inserts an assignment or a binding of a parameter which the
 * schema of the object that assigns or binds it does not declare, through `Parametrics.HasParameters` and
 * `Parametrics.Defines`, where the store has `Parametrics` installed
 * ([CAP-314: parameters bound by the data objects their schema governs](mbse:mbse-basis/docs/capabilities/README.md#CAP-314)). It is checked at commit, as a unique clause is
 * ([CAP-293: an entry inserted against a unique clause refuses its transaction](mbse:mbse-basis/docs/capabilities/README.md#CAP-293)), once the transaction's writes are all made, and
 * only of the entries the transaction inserts. An entry whose object or parameter is a parameter reference, or an
 * object of the store below that is not present, is not checked: what it gives a value or an object is not known
 * here. */
export function _check(store: any, proposals: Proposals.OfStore): void {
  if (!proposals.saved.get(store._schemas)!.some(([name]) => name === "Parametrics.AssignsValue")) return;
  const relations = [store.registered("Parametrics.AssignsValue"), store.registered("Parametrics.BindsObject")];
  const seen = new Set<unknown>();
  for (const [holder, tables] of proposals.entries_ as Map<object, Map<unknown, Map<string, unknown>>>) {
    const before = proposals.base.entries(holder) as Map<unknown, Map<string, unknown>>;
    for (const [relation, table] of tables) {
      if (!relations.includes(relation)) continue;
      const old = before.get(relation) ?? new Map();
      for (const [key, entry] of table) {
        if (old.has(key) || seen.has(entry)) continue;
        seen.add(entry);
        const problem = undeclared(store, relation, entry);
        if (problem !== null) throw new ValueError(problem);
      }
    }
  }
}

/** Why an assignment's or a binding's parameter is not one its object's schema declares; null where it is, or where
 * the object or the parameter is a parameter reference, or an object of the store below that is not present. */
function undeclared(store: any, relation: any, entry: unknown): string | null {
  const links = Proxies._innerOf(entry)._links;
  const target = links.get("object");
  const param = links.get("param");
  if (Proxies._end(target) || Proxies._end(param)) return null;
  const hasParameters = store.registered("Parametrics.HasParameters");
  const defines = store.registered("Parametrics.Defines");
  const schema = Proxies._innerOf(target)._schema;
  const declared = Proxies._linking(hasParameters, "defn", schema, store).flatMap((held: any) =>
    Proxies._linking(defines, "parameters", Proxies._innerOf(held)._links.get("params"), store)
      .map((defined: any) => Proxies._innerOf(defined)._links.get("parameter")));
  if (declared.includes(param)) return null;
  const names = Proxies._linking(defines, "parameter", param, store)
    .map((defined: any) => Proxies._innerOf(defined)._properties.get("name"));
  const shown = names.length > 0 ? `parameter ${repr(names[0])}` : "a parameter no set of parameters defines";
  const did = relation.name === "Parametrics.AssignsValue" ? `assigns a value to ${shown}` : `binds ${shown} to an object`;
  return `an entry of ${repr(relation.name)} ${did}, which ${repr(schema.name)} does not declare: an object assigns `
    + "and binds only the parameters its schema declares";
}
