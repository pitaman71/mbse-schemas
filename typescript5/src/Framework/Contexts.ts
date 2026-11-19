/**
 * Contexts: the context a procedure takes, validation among them, as schema data ([CAP-319: contexts as schema data](mbse:mbse-basis/docs/capabilities/README.md#CAP-319)).
 *
 * Value schemas, which every store holds, its own, as it holds `References`:
 *
 * - `Contexts.OfVariable`, a variable: its `name`, its `schema`, a `References.OfSchema` of any schema, and its `value`,
 *   a `References.OfValue`;
 * - `Contexts.OfSymbol`, a symbol: its `name`, its `schema`, a `References.OfSchema` of an object schema, and its
 *   `object`, a `References.OfObject`;
 * - `Contexts.OfParameter`, a parameter: its `name`, its `schema`, a `References.OfSchema`, and either the `object` it
 *   is bound to, a `References.OfObject`, or the `value` assigned to it, a `References.OfValue`;
 * - `Contexts.OfContext`, a context: its `variables`, `symbols` and `parameters`, each a container of the entries
 *   above, indexed by the entry's name.
 *
 * A context is a value, complete in itself: nothing links it to another. A sub-context is copied, as the user decided
 * ([the Context + References + Changes cleanup proposal](mbse:mbse-basis/proposals/CONTEXT-REFERENCES-CHANGES.md#decided)):
 * `within(store, outer, own)` gives a new context that holds the outer context's entries, with the entries of `own`
 * added, each replacing the outer entry of its name. `validate(store, context)` reports a context's problems, among
 * them a symbol whose schema is not an object schema: the schema argument of `References.OfSchema[Schemas.OfObject]`
 * constrains it ([CAP-320: schema and value references](mbse:mbse-basis/docs/capabilities/README.md#CAP-320)).
 */

import * as Plain from "./Plain.js";
import * as Proxies from "./Proxies.js";
import * as References from "./References.js";
import { repr } from "./Repr.js";

export const CONTEXT = "Contexts.OfContext";
const CONTAINERS = ["variables", "symbols", "parameters"] as const;

/** The context schemas, defined in the store a transaction writes: `store.transaction(Contexts.install)`. A store is
 * made by it, after `References.install`, read by the bootstrap (`Builders`); run again in a store, it finds each by its
 * name and writes nothing. */
export function install(txn: any): any {
  const S = txn.Schemas; // the store's meta-schemas and basic scalars (78)
  const R = txn.References;
  return txn.uid("mbse.Schemas.Contexts/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ OfVariable: S.OfObject, OfSymbol: S.OfObject, OfParameter: S.OfObject, OfContext: S.OfObject })
    .spec([
      (_: any) => _.OfVariable.name("Contexts.OfVariable").properties({
        name: S.OfStr,
        schema: R.OfSchema, // of any schema
        value: R.OfValue,
      }),
      (_: any) => _.OfSymbol.name("Contexts.OfSymbol").properties({
        name: S.OfStr,
        schema: R.OfSchema, // of an object schema (`validate`)
        object: R.OfObject,
      }),
      (_: any) => _.OfParameter.name("Contexts.OfParameter").properties({
        name: S.OfStr,
        schema: R.OfSchema,
        object: R.OfObject, // the object it is bound to, or
        value: R.OfValue, // the value assigned to it
      }),
      (_: any) => _.OfContext.name(CONTEXT).properties({
        variables: S.OfContainer((c: any) => c.index([S.OfStr]).element([_.OfVariable])),
        symbols: S.OfContainer((c: any) => c.index([S.OfStr]).element([_.OfSymbol])),
        parameters: S.OfContainer((c: any) => c.index([S.OfStr]).element([_.OfParameter])),
      }),
    ])]))]);
}

/** `context`, a `Contexts.OfContext` value; `TypeError` where it is not one. */
function contextOf(store: any, context: unknown, caller: string): any {
  const inner = Proxies._innerOf(Proxies._durable(context));
  if (!(inner instanceof Proxies._internals._RecordData && inner._schema === store.registered(CONTEXT))) {
    throw new TypeError(`${caller} takes a context (${CONTEXT}), not ${repr(context)}`);
  }
  return context;
}

/** A sub-context: a new `Contexts.OfContext` that holds the entries of `outer`, with those of `own` added, each
 * replacing the entry of `outer` that has its name. It copies both, so that nothing links it to either. */
export function within(store: any, outer: unknown, own: unknown): any {
  const schema = store.registered(CONTEXT);
  const written = [outer, own].map((given) =>
    Plain.ToPlain(store)(schema, contextOf(store, given, "Contexts.within")) as Plain.PlainMap);
  const merged: Plain.PlainMap = new Map();
  for (const name of CONTAINERS) {
    const entries = new Map([...((written[0]!.get(name) as Plain.PlainMap | undefined) ?? []),
      ...((written[1]!.get(name) as Plain.PlainMap | undefined) ?? [])]);
    if (entries.size > 0) merged.set(name, entries);
  }
  return Plain.FromPlain(store)(schema, merged);
}

/** The entries of a context's `variables`, `symbols` or `parameters`, by name, each as its visitor. */
export function entries(store: any, context: unknown, container: string): Map<string, any> {
  const given = contextOf(store, context, "Contexts.entries");
  const found = new Map<string, any>();
  const pairs: [string, any][] = [];
  given[container].as_value((a: any) => a.as_container((c: any) => c.as_entries((it: Iterator<[string, any]>) =>
    pairs.push(...{ [Symbol.iterator]: () => it }))));
  for (const [index, element] of pairs) element.as_object((v: any) => { found.set(index, v); return v; });
  return found;
}

/** The value object that a property of an entry holds, a reference (`References.OfSchema`, `.OfObject` or `.OfValue`),
 * as its visitor; null where the property is not set. */
export function held(prop: any): any {
  let found: any = null;
  prop.as_value((a: any) => a.as_object((v: any) => { found = v; return v; }));
  return found.as_schema() !== null ? found : null; // a visitor of nothing has no schema
}

/** The problems of a context: an entry whose name is not the one it is indexed by; a schema reference whose path is
 * not a schema object's, or that designates no schema object the store holds; a symbol whose schema is not an object
 * schema (`References.OfSchema[Schemas.OfObject]`, [CAP-320: schema and value references](mbse:mbse-basis/docs/capabilities/README.md#CAP-320)); and a parameter both bound to an object and
 * assigned a value. */
export function validate(store: any, context: unknown): string[] {
  const problems: string[] = [];
  for (const [container, noun] of [["variables", "variable"], ["symbols", "symbol"], ["parameters", "parameter"]]) {
    for (const [name, entry] of entries(store, context, container!)) {
      if (entry.name.get() !== name) problems.push(`${noun} ${repr(name)}: its entry is named ${repr(entry.name.get())}`);
      const schema = held(entry.schema);
      if (schema !== null) {
        const kind = container === "symbols" ? store.Schemas.OfObject : null;
        problems.push(...References.validate_schema(store, schema, kind).map((problem) => `${noun} ${repr(name)}: ${problem}`));
      }
      if (container === "parameters" && held(entry.object) !== null && held(entry.value) !== null) {
        problems.push(`parameter ${repr(name)} is both bound to an object and assigned a value`);
      }
    }
  }
  return problems;
}
