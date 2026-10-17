/**
 * Paths: an object's identity, the route from a singleton to it through the relations that own it
 * (docs/OBJECT_IDENTITY.md).
 *
 * A path is a nested value object, never a string: `Paths.OfRoot` names the singleton it starts from and holds the
 * next element, `Paths.OfEntry` one ownership entry transited (`i`, the adjacency to it from the object before; `o`,
 * the adjacency to it from the object after, the one marked `owner()`; `properties`, the entry's keys), and
 * `Paths.OfTarget` ends it. `next` is a union of the two, its branches `entry` and `target`. Every store holds these
 * schemas, its own; a store calls `schemas`, handing it the builders and its basic scalars, as it does `Mutations`'.
 *
 * An identity is computed on demand (Decided, 32): `of(obj)` reads an object's path off its ownership entries.
 */

import type * as Builders from "./Builders.js";
import { LookupError } from "./Errors.js";
import * as Proxies from "./Proxies.js";
import { repr } from "./Repr.js";
import type * as S from "./Schemas.js";

/** What `schemas` builds with: the builders, and the store's basic scalars `Text`, `Int` and `Bool`. */
interface Kit {
  AnyValueBuilder: typeof Builders.AnyValueBuilder;
  ContainerBuilder: typeof Builders.ContainerBuilder;
  ObjectBuilder: typeof Builders.ObjectBuilder;
  UnionBuilder: typeof Builders.UnionBuilder;
  Text: S.OfScalar.Data;
  Int: S.OfScalar.Data;
  Bool: S.OfScalar.Data;
}

/** The path schemas, built anew for a store: each store holds its own. A key's value is a bool, an int or text, written
 * bare. */
export function schemas(kit: Kit): Record<string, S.OfObject.Data | S.OfUnion.Data> {
  const { AnyValueBuilder, ContainerBuilder, ObjectBuilder, UnionBuilder, Text, Int, Bool } = kit;
  const Next = new UnionBuilder().name("Paths.Next").create(); // its branches follow: they refer to it
  const OfTarget = new ObjectBuilder().name("Paths.OfTarget").create();
  const keys = new ContainerBuilder().index([Text]).element([new AnyValueBuilder().schemas([Bool, Int, Text]).create()]).create();
  const OfEntry = new ObjectBuilder().name("Paths.OfEntry").properties([
    (t: any) => t.name("i").schema([Text]),
    (t: any) => t.name("o").schema([Text]),
    (t: any) => t.name("properties").schema([keys]),
    (t: any) => t.name("next").schema([Next]),
  ]).create();
  const OfRoot = new ObjectBuilder().name("Paths.OfRoot").properties([
    (t: any) => t.name("singleton").schema([Text]),
    (t: any) => t.name("next").schema([Next]),
  ]).create();
  new UnionBuilder(Next).branches([
    (t: any) => t.name("entry").schema([OfEntry]),
    (t: any) => t.name("target").schema([OfTarget]),
  ]).update();
  return { OfRoot, OfEntry, OfTarget, Next };
}

/** The entry that owns a proxy, through the adjacency of its schema marked `owner()`: the adjacency, the entry's state
 * and the owner. `LookupError` where it has none, or more than one. */
function ownedBy(obj: unknown): [S.OfAdjacency.Data, any, unknown] {
  const state = Proxies._innerOf(obj);
  const schema = state._schema as S.OfObject.Data;
  const found: [S.OfAdjacency.Data, any][] = [];
  for (const adjacency of [...schema.adjacencies.values(), ...schema.anonymous]) {
    if (!adjacency.owner) continue;
    for (const entry of Proxies._linking(adjacency.relation as S.OfRelation.Data, adjacency.me, obj)) {
      found.push([adjacency, Proxies._innerOf(entry)]);
    }
  }
  if (found.length !== 1) {
    throw new LookupError(`a ${repr(state._schemaName)} has ${found.length === 0 ? "no owner" : "more than one owner"}: `
      + "its path is not known");
  }
  const [adjacency, entry] = found[0]!;
  const owner = [...entry._links].find(([link]) => link !== adjacency.me)![1];
  return [adjacency, entry, owner];
}

/** The path of a reference object, read off its ownership entries back to a singleton: a `Paths.OfRoot` value,
 * standalone, of the object's store. */
export function of(obj: unknown): unknown {
  const store: any = Proxies._store_of(obj);
  const steps: [string, string, Map<string, unknown>][] = [];
  const seen = new Set<unknown>();
  let current = obj;
  while ((Proxies._innerOf(current)._schema as S.OfObject.Data).singleton === null) {
    if (seen.has(current)) throw new LookupError("an ownership cycle: no singleton owns the object");
    seen.add(current);
    const [adjacency, entry, owner] = ownedBy(current);
    const ownerLink = [...entry._links.keys()].find((link: string) => link !== adjacency.me) as string;
    const ownerSchema = Proxies._innerOf(owner)._schema as S.OfObject.Data;
    const i = [...ownerSchema.adjacencies].find(([, held]) => held.relation === adjacency.relation && held.me === ownerLink)?.[0] ?? "";
    steps.push([i, adjacency.name, new Map(entry._properties)]);
    current = owner;
  }
  const singleton = (Proxies._innerOf(current)._schema as S.OfObject.Data).singleton;
  const step = (rest: [string, string, Map<string, unknown>][]): (n: any) => any => {
    if (rest.length === 0) return (n: any) => n.target((t: any) => t);
    const [i, o, keys] = rest[0]!;
    return (n: any) => n.entry((e: any) => e.i(i).o(o).properties(keys).next(step(rest.slice(1))));
  };
  return store.Paths.OfRoot((r: any) => r.singleton(singleton).next(step(steps.reverse())));
}
