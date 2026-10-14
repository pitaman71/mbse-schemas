/**
 * Reachable: finds every object reachable from a root through adjacencies.
 *
 * `Reachable.of(root)` returns the root and every reference object reachable from it, in the order each is first
 * referenced. It reads through the visitor protocol (`Readers.OfObject`): each object's adjacencies, in its schema's
 * order, their entries, in order, and each entry's links other than the object's own, in the relation's order. A value
 * object has no adjacencies, and no entry links one, so values are not followed.
 */

import type * as Readers from "./Readers.js";
import type * as Schemas from "./Schemas.js";

/** The root and every reference object reachable from it through adjacencies, in first-reference order. */
export function of(root: Readers.OfObject): Readers.OfObject[] {
  const seen = new Set<Readers.OfObject>([root]); // by object: an identity is unique within its schema only
  const queue = [root];

  const adjacency = (read: Readers.OfAdjacency): Readers.OfAdjacency => {
    const me = read.as_schema().me;
    for (const entry of read) {
      for (const link of (entry.as_schema() as Schemas.OfEntry.Data).links.keys()) {
        if (link !== me) found(entry[link] as Readers.OfObject);
      }
    }
    return read;
  };

  const found = (target: Readers.OfObject): void => {
    if (!seen.has(target)) {
      seen.add(target);
      queue.push(target);
    }
  };

  while (queue.length > 0) (queue.shift() as Readers.OfObject).as_adjacencies(adjacency);
  return [...seen.values()];
}
