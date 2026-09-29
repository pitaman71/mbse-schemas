/**
 * Helpers built in the tutorials, collected so later case studies can import them.
 *
 * Each function is developed and explained in the case study named in its comment.
 */

import { Proxies } from "../src/Framework/index.js";
import type { OfAdjacency, OfEntry } from "../src/Framework/Visitors.js";

/** One entry, read into an object: each link's target and each property's value, by name. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

function read(entry: OfEntry): Row {
  const row: Row = {};
  entry.links((link) => link.target((target) => (row[link.name()] = target)));
  entry.properties((prop) => prop.value((v) => v.as_native((n) => (row[prop.name()] = n.get()))));
  return row;
}

/**
 * The entries of one of `obj`'s adjacencies, as objects of link and property values. (Case study 2.)
 *
 * The object's own link is implied, so it is not included. Reading goes through a builder started from `obj`: the
 * builder is a visitor, and visiting is how anything is read without knowing the schema in advance. The builder is
 * never finalized, so nothing changes.
 */
export function entries(obj: Proxies.Instance, adjacency: string): Row[] {
  const rows: Row[] = [];
  Proxies.Builders[obj.schema_name()](obj).adjacency(adjacency, (a: OfAdjacency) => a.entries((e) => rows.push(read(e))));
  return rows;
}

/** Removes the entries of `obj`'s adjacency for which `where(row)` is true; `row` is as returned by `entries`.
 * Returns the updated object. (Case study 3.) */
export function remove_entries(obj: Proxies.Instance, adjacency: string, where: (row: Row) => boolean): Proxies.Instance {
  return Proxies.Builders[obj.schema_name()](obj)
    .adjacency(adjacency, (a: OfAdjacency) => {
      const doomed: OfEntry[] = [];
      a.entries((e) => (where(read(e)) ? doomed.push(e) : undefined));
      for (const e of doomed) a.remove(e);
    })
    .update();
}
