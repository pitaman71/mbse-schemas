/**
 * Stores: the root object of a body of data, through which schemas, builders and objects are located.
 *
 * A store holds schemas by name and the objects built with them. `Store` is the protocol every implementation meets;
 * `Proxies.OfStore` (dynamic instances) and `Bindings.OfStore` (a program's own classes) implement it. Everything that
 * looks a schema up by name takes a store: `Plain.ToPlain(store)`, `Plain.FromPlain(store)`, the JSON and YAML forms,
 * `Validators.Validate(store)` and `Modules`. Stores are isolated from one another; objects move between them as
 * snapshots. Selecting objects by a condition is an extension, in mbse-expressions.
 *
 * `Catalog` holds schemas by name, as every store does, with the messages every store gives; `META` names the
 * meta-schemas a store of proxies starts with.
 */

import { AttributeError, LookupError, ValueError } from "./Errors.js";
import { repr } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type { Visitable } from "./Visitors.js";

type ObjectSchema = Schemas.OfObject.Data;
type RelationSchema = Schemas.OfRelation.Data;

/** The meta-schemas a store of proxies starts with, by name, so that it can hold modules of schemas. */
export const META: ReadonlyMap<string, ObjectSchema> = new Map([["Schemas.Module", Schemas.Module.Schema]]);

/** A store: schemas by name, builders, and the objects it holds. */
export interface Store {
  /** The object schema registered as `name`: `AttributeError` if none is, `TypeError` for a relation. */
  schema(name: string): ObjectSchema;
  /** The object or relation schema registered as `name`; `LookupError` if none is. */
  registered(name: string): ObjectSchema | RelationSchema;
  /** The name `schema` is registered under; `LookupError` if it is not. */
  name_of(schema: unknown): string;
  /** Every registered name, in registration order. */
  names(): readonly string[];
  /** A builder for the object schema `name`, a `Visitors.OfObject` finalized by `create()`, or by `clone()` and
   * `update()` of `instance`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder(name: string, instance?: unknown): any;
  /** The value `instance` holds in its property `name`, e.g. a value object or a union's branch. */
  member(instance: unknown, name: string): unknown;
  /** The reference objects of the schema `name` that the store holds, in the order they were made. */
  extent(name: string): readonly Visitable[];
}

/** Schemas by name: `register`, `schema`, `registered`, `name_of` and `names`, as every store has them. */
export class Catalog {
  readonly _schemas = new Map<string, ObjectSchema | RelationSchema>();

  /** Registers a schema under `name`, which need not be a valid identifier. */
  register(name: string, schema: ObjectSchema | RelationSchema): void {
    if (this._schemas.has(name)) throw new ValueError(`schema ${repr(name)} is already registered`);
    this._schemas.set(name, schema);
  }

  schema(name: string): ObjectSchema {
    const found = this._schemas.get(name);
    if (found === undefined) throw new AttributeError(`no schema registered as ${repr(name)}`);
    if (!(found instanceof Schemas.OfObject.Data)) throw new TypeError(`${repr(name)} is a relation; no relation builder is exposed`);
    return found;
  }

  registered(name: string): ObjectSchema | RelationSchema {
    const found = this._schemas.get(name);
    if (found === undefined) throw new LookupError(`no schema registered as ${repr(name)}`);
    return found;
  }

  name_of(schema: unknown): string {
    for (const [name, registered] of this._schemas) if (registered === schema) return name;
    throw new LookupError("schema is not registered");
  }

  names(): readonly string[] {
    return [...this._schemas.keys()];
  }

  /** The names of the object schemas that declare an adjacency to `relation` via `link`. */
  _filling(relation: RelationSchema, link: string): string[] {
    return [...this._schemas]
      .filter(([, s]) => s instanceof Schemas.OfObject.Data && [...s.adjacencies.values()].some((a) => a.relation === relation && a.me === link))
      .map(([name]) => name);
  }
}
