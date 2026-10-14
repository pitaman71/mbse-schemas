/**
 * Helpers built in the tutorials, collected so later case studies can import them.
 *
 * Each function is developed and explained in the case study named in its comment.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Proxies } from "@mbse/schemas/Framework";

/** One entry, read into an object: each link's target and each property's value that is set, by name. */
export type Row = Record<string, any>;

/**
 * The entries of one of `obj`'s adjacencies, as objects of link and property values. (Case study 2.)
 *
 * The object's own link is implied, so it is not included. An adjacency is a member of the object, a visitor that
 * iterates its entries; an entry's links are members giving the linked object, and its properties members whose
 * `get()` gives the value. The schema is read through `as_schema()`, so this works for any relation.
 */
export function entries(obj: Proxies.Instance, adjacency: string): Row[] {
  const read = obj[adjacency];
  const me = read.as_schema().me;
  return [...read].map((entry: any) => {
    const schema = entry.as_schema();
    const row: Row = {};
    for (const link of schema.links.keys()) if (link !== me) row[link] = entry[link];
    for (const name of schema.properties.keys()) {
      const value = entry[name].get();
      if (value !== null) row[name] = value;
    }
    return row;
  });
}

/**
 * The elements of the container a property holds, as [index, element] pairs in order: each element a scalar, or a
 * visitor where it is not one. (Case study 2.)
 *
 * A property's visitor holds its value, here read as a container; the container's elements are each visited through
 * their own visitor, read as a scalar first.
 */
export function elements(prop: any): [unknown, any][] {
  const pairs: [unknown, any][] = [];
  prop.as_value((v: any) => v.as_container((c: any) => c.as_entries((it: Iterable<[unknown, any]>) => pairs.push(...it))));
  return pairs.map(([index, element]) => {
    let value: any = null;
    element.as_scalar((s: any) => (value = s.get()) ?? s);
    if (value === null) element.as_object((o: any) => (value = o));
    return [index, value];
  });
}

/** Removes the entries of `obj`'s adjacency for which `where(row)` is true; `row` is as returned by `entries`.
 * Returns the updated object. (Case study 3.) */
export function remove_entries(obj: Proxies.Instance, adjacency: string, where: (row: Row) => boolean): Proxies.Instance {
  const rows = entries(obj, adjacency);
  const doomed = [...obj[adjacency]].filter((_entry, i) => where(rows[i] as Row));
  const remove = (a: any): any => {
    for (const entry of doomed) a.remove(entry); // an entry given as a value removes the entries equal to it
    return a;
  };
  return Proxies.store_of(obj).builder(obj.as_schema().name as string, obj)[adjacency](remove).update();
}
