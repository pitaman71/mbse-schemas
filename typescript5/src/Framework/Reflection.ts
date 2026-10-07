/**
 * Reflection: schemas as the objects predicates match.
 *
 * A schema is an object of its kind's meta-schema, the schema of its module form (`Schemas.OfObject.Schema`, named
 * 'Schemas.Object', and the like for natives, unions, intersections, lists, applications and relations): it is a
 * reference object identified by itself, and writes itself through `accept` as a module writes it, with its name (which
 * a module gives its entry), its properties, branches, parts and parameters inline, and a named schema it refers to by
 * name (`{"named": {"name": ...}}`). Predicates (mbse-patterns) read it with `get` and quantify over its lists, so a
 * symbol whose schema is a meta-schema binds a schema, and the predicate itself says which schemas match.
 *
 * `of(store)` is a store whose objects are the schemas `store` registers, and the named schemas they refer to: it
 * registers the meta-schemas, and the extent of each is the schemas of its kind, in name order, as the store registers
 * them when the extent is asked for. The store's data is not read, nor its own meta-schemas (`Stores.META`). It builds
 * nothing; schemas are built by their builders.
 */

import * as Modules from "./Modules.js";
import * as Plain from "./Plain.js";
import type { PlainMap } from "./Plain.js";
import * as Schemas from "./Schemas.js";
import * as Stores from "./Stores.js";
import * as Validators from "./Validators.js";
import type { Visitable } from "./Visitors.js";

type Schema = Schemas.OfAny.Data | Schemas.OfRelation.Data;

/** The meta-schemas of the kinds of named schemas. */
export const META: readonly Schemas.OfObject.Data[] = [
  Schemas.OfNative.Schema, Schemas.OfObject.Schema, Schemas.OfUnion.Schema, Schemas.OfIntersection.Schema,
  Schemas.OfIndexed.Schema, Schemas.OfApply.Schema, Schemas.OfRelation.Schema];

const BY_NAME = new Map(META.map((meta) => [meta.name as string, meta]));

/** Writes a schema's module form into `visitor`. */
function accept(schema: unknown, visitor: unknown): void {
  const reflected = schema as Schema & Visitable;
  const [contents] = [...new Modules._Writer().definition(reflected).values()] as PlainMap[];
  const named = reflected.name === null ? contents : new Map([["name", reflected.name], ...contents as PlainMap]);
  const record = Plain._decode(BY_NAME.get(reflected.schema_name()) as Schemas.OfObject.Data, named, []) as Visitable;
  record.accept(visitor as never);
}

Schemas._REFLECTION.accept = accept;

/** The types and relations a schema refers to directly. */
function referred(schema: Schema): unknown[] {
  const types: unknown[] = [...schema.parameters.values()].map((p) => p.type).filter((t) => t !== null);
  if (schema instanceof Schemas.OfObject.Data || schema instanceof Schemas.OfRelation.Data) {
    types.push(...[...schema.properties.values()].map((p) => p.type));
  }
  if (schema instanceof Schemas.OfObject.Data) types.push(...[...schema.adjacencies.values()].map((a) => a.relation));
  else if (schema instanceof Schemas.OfUnion.Data) types.push(...schema.branches.map((b) => b.type));
  else if (schema instanceof Schemas.OfIntersection.Data) types.push(...schema.parts.map((p) => p.type));
  else if (schema instanceof Schemas.OfIndexed.Data) types.push(...[schema.item, schema.key].filter((t) => t !== null));
  else if (schema instanceof Schemas.OfApply.Data) types.push(schema.of);
  return types;
}

/** The named schemas reachable from `roots`, through the types and relations they refer to, in name order. */
function named(roots: readonly Schema[]): Schema[] {
  const seen = new Set<unknown>();
  const found: Schema[] = [];
  const pending: unknown[] = [...roots];
  while (pending.length > 0) {
    const schema = pending.shift() as Schema;
    if (seen.has(schema)) continue;
    seen.add(schema);
    if (schema.name !== null) found.push(schema);
    pending.push(...referred(schema));
  }
  return found.sort((a, b) => (a.name as string) < (b.name as string) ? -1 : (a.name as string) > (b.name as string) ? 1 : 0);
}

/** The schemas `store` registers, and the named schemas they refer to, as the objects of their meta-schemas. */
export class OfStore extends Stores.Catalog {
  constructor(readonly store: Stores.Store) {
    super();
    for (const meta of META) this.register(meta);
  }

  /** The schemas, read from the store's registry when asked, so that a schema registered later is among them. */
  get schemas(): readonly Schema[] {
    const own = new Set<unknown>(Stores.META);
    return named([...this.store.names()].map((name) => this.store.registered(name)).filter((schema) => !own.has(schema)));
  }

  override extent(name: string): readonly Visitable[] {
    this.schema(name);
    return this.schemas.filter((schema) => (schema as unknown as Visitable).schema_name() === name) as unknown as Visitable[];
  }

  builder(_name: string, _instance: unknown = null): never {
    throw new TypeError("schemas are built by their builders, not by a store of schemas");
  }

  member(instance: unknown, name: string): unknown {
    return Validators.properties_of(instance as Visitable).get(name) ?? null;
  }
}

/** A store whose objects are the schemas `store` registers, and the named schemas they refer to. */
export function of(store: Stores.Store): OfStore {
  return new OfStore(store);
}
