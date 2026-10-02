/**
 * Stores: the root object of a body of data, through which schemas, builders and objects are located.
 *
 * A store holds schemas by name, and its data: the instances of its singleton schemas, its roots, and every reference
 * object reachable from them through relation entries, with the value objects those own. Anything else built with a
 * store's builders is transient: it lives only while the program holds it. `Store` is the protocol every
 * implementation meets;
 * `Proxies.OfStore` (dynamic instances) and `Bindings.OfStore` (a program's own classes) implement it. Everything that
 * looks a schema up by name takes a store: `Plain.ToPlain(store)`, `Plain.FromPlain(store)`, the JSON and YAML forms,
 * `Validators.Validate(store)` and `Modules`. Stores are isolated from one another; objects move between them as
 * snapshots. Selecting objects by a condition is an extension, in mbse-expressions.
 *
 * `Catalog` holds schemas by name and the roots, as every store does, with the messages every store gives, and
 * computes extents from the roots; `META` holds the meta-schemas a store of proxies starts with.
 */

import { AttributeError, LookupError, ValueError } from "./Errors.js";
import * as Reachable from "./Reachable.js";
import { repr } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type { Visitable } from "./Visitors.js";

type ObjectSchema = Schemas.OfObject.Data;
type RelationSchema = Schemas.OfRelation.Data;

/** The meta-schemas a store of proxies starts with, each under its name, so that it can hold modules of schemas. */
export const META: readonly ObjectSchema[] = [Schemas.Module.Schema];

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
  /** The one instance of the singleton schema whose global name is `name`; `LookupError` if there is none. */
  singleton(name: string): Visitable;
  /** The store's reference objects of the schema `name`: those reachable from its singletons, in first-reference
   * order. */
  extent(name: string): readonly Visitable[];
}

/** Schemas by name: `register`, `schema`, `registered`, `name_of` and `names`, as every store has them; the roots, by
 * global name (`singleton`), which an implementation fills; and `extent`, the reference objects reachable from them. */
export class Catalog {
  readonly _schemas = new Map<string, ObjectSchema | RelationSchema>();
  readonly _singletons = new Map<string, Visitable>();

  /** Registers a schema under its name. */
  register(schema: ObjectSchema | RelationSchema): void {
    const name = schema.name;
    if (name === null) throw new ValueError("a schema needs a name to be registered; name it with its builder's .name()");
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

  singleton(name: string): Visitable {
    const found = this._singletons.get(name);
    if (found === undefined) throw new LookupError(`no singleton named ${repr(name)}`);
    return found;
  }

  extent(name: string): readonly Visitable[] {
    this.schema(name);
    const seen = new Set<unknown>();
    const found: Visitable[] = [];
    for (const root of this._singletons.values()) {
      for (const value of Reachable.of(root)) {
        if (!seen.has(value.identity())) {
          seen.add(value.identity());
          if (value.schema_name() === name) found.push(value);
        }
      }
    }
    return found;
  }

  /** The names of the object schemas that declare an adjacency to `relation` via `link`. */
  _filling(relation: RelationSchema, link: string): string[] {
    return [...this._schemas]
      .filter(([, s]) => s instanceof Schemas.OfObject.Data && [...s.adjacencies.values()].some((a) => a.relation === relation && a.me === link))
      .map(([name]) => name);
  }
}
