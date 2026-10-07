/**
 * Paths: names for the objects a store holds, which survive changes elsewhere in it.
 *
 * `Paths.of(store)` names every object the store's roots reach. A schema of a store of schemas (`Reflection.of`) is
 * named by its name, and a singleton by its global name; any other object by the first route that reaches it from them,
 * in order: the schemas in name order, then the singletons in global-name order, then breadth first through each
 * object's entries, adjacency by adjacency in its schema's order, each adjacency's entries in order. A route's step is
 * `/adjacency[key]`: an entry's key is the property values that a unique constraint of its relation declares with the
 * object's own link (`phones[label="home"]`), else its position among the adjacency's entries (`items[0]`). An entry
 * of a relation of more than two links names the link it follows (`/enrolled[0].course`). A key writes a string as JSON
 * does, an integer in decimal and a boolean as `true` or `false`; a value of any other type makes the key positional.
 *
 * A path names the same object after a change that does not touch the route to it: a property set, or an object added
 * elsewhere. Renaming a schema or a singleton, or inserting an entry before a positional one, changes the paths under
 * it.
 *
 * `paths.of(value)` gives an object's path (`LookupError` for one no root reaches), and `paths.find(path)` the object
 * at a path (`LookupError` for none).
 */

import { LookupError } from "./Errors.js";
import * as Reflection from "./Reflection.js";
import { repr } from "./Repr.js";
import type * as Schemas from "./Schemas.js";
import * as Stores from "./Stores.js";
import * as Validators from "./Validators.js";
import type { Visitable } from "./Visitors.js";

/** The schemas a store of schemas holds, or those of the stores a combined store combines. */
function schemasOf(store: unknown): any[] {
  if (store instanceof Reflection.OfStore) return [...store.schemas];
  return store instanceof Stores.Combined ? store.stores.flatMap((part) => schemasOf(part)) : [];
}

/** A key's value as a path writes it, or null for a type a path does not write. */
function text(value: unknown): string | null {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return String(value);
  return null;
}

function compare(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (a[i] as string) < (b[i] as string) ? -1 : 1;
  }
  return a.length - b.length;
}

/** An entry's key: the values of the first unique constraint, in name order, that holds the object's own link and
 * otherwise only properties the entry has, of types a path writes; else its position. */
function key(relation: Schemas.OfRelation.Data, me: string, values: ReadonlyMap<string, unknown>, position: number): string {
  for (const unique of relation.uniques.map((u) => [...u].sort()).sort(compare)) {
    const rest = unique.filter((name) => name !== me);
    const texts = rest.map((name) => text(values.get(name)));
    if (unique.includes(me) && rest.length > 0 && rest.every((name) => relation.properties.has(name)) && !texts.includes(null)) {
      return rest.map((name, i) => `${name}=${texts[i]}`).join(",");
    }
  }
  return String(position);
}

/** The paths of the objects a store's roots reach (see the module's documentation). */
export class Paths {
  readonly #paths = new Map<unknown, string>();
  readonly #objects = new Map<string, Visitable>();

  constructor(store: Stores.Store) {
    const pending: [Visitable, string][] = schemasOf(store).sort((a, b) => compare([a.name], [b.name]))
      .map((schema) => [schema as Visitable, schema.name as string]);
    pending.push(...[...Stores._roots(store)].map(([name, root]): [Visitable, string] => [root, name])
      .sort((a, b) => compare([a[1]], [b[1]])));
    while (pending.length > 0) {
      const [value, path] = pending.shift() as [Visitable, string];
      if (this.#paths.has(value.identity())) continue;
      this.#paths.set(value.identity(), path);
      if (!this.#objects.has(path)) this.#objects.set(path, value);
      pending.push(...this.#routes(store, value, path));
    }
  }

  /** The objects `value`'s entries link, each with its path through them, in order. */
  #routes(store: Stores.Store, value: Visitable, path: string): [Visitable, string][] {
    const found: [Visitable, string][] = [];
    const entries = Validators.entries_of(value);
    if (entries.size === 0) return found;
    const schema = store.schema(value.schema_name());
    for (const [name, listed] of entries) {
      const adjacency = schema.adjacencies.get(name) as Schemas.OfAdjacency.Data;
      const relation = adjacency.relation as Schemas.OfRelation.Data;
      const others = relation.links.filter((link) => link !== adjacency.me);
      listed.forEach((entry, position) => {
        const at = key(relation, adjacency.me, entry.values, position);
        for (const link of others) { // every link of an entry is set
          found.push([entry.targets.get(link) as Visitable, `${path}/${name}[${at}]${others.length > 1 ? `.${link}` : ""}`]);
        }
      });
    }
    return found;
  }

  /** The path of `value`. */
  of(value: Visitable): string {
    const path = this.#paths.get(value.identity());
    if (path === undefined) throw new LookupError("no root reaches the object");
    return path;
  }

  /** The object at `path`. */
  find(path: string): Visitable {
    const found = this.#objects.get(path);
    if (found === undefined) throw new LookupError(`no object at ${repr(path)}`);
    return found;
  }
}

/** The paths of the objects `store`'s roots reach. */
export function of(store: Stores.Store): Paths {
  return new Paths(store);
}
