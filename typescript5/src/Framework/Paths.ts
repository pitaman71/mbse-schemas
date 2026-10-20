/**
 * Paths: an owned object's identity, the route from a singleton to it through the relations that own it
 * (docs/OBJECT_IDENTITY.md).
 *
 * A path is a nested value object, never a string: `Paths.OfRoot` names the singleton it starts from and holds the
 * next element, `Paths.OfEntry` one ownership entry transited (`i`, the adjacency to it from the object before; `o`,
 * the adjacency to it from the object after, the one marked `owner()`; `properties`, the entry's keys), and
 * `Paths.OfTarget` ends it. `next` is a union of the two, its branches `entry` and `target`. Every store holds these
 * schemas, its own; a store calls `schemas`, handing it the builders and its basic scalars, as it does `Mutations`'.
 *
 * An identity is computed on demand (Decided, 32): `of(obj)` reads an object's path off its ownership entries. A schema
 * object's path starts from the root module, the singleton `"."`, and goes through each module, then the schema, by
 * name, then each member by the keyed adjacency that owns it and its name (Decided, 80 and 81); one with no name of its
 * own has none.
 */

import * as Builders from "./Builders.js";
import { LookupError } from "./Errors.js";
import * as Plain from "./Plain.js";
import * as Proxies from "./Proxies.js";
import { repr } from "./Repr.js";
import type * as S from "./Schemas.js";
import type * as Stores from "./Stores.js";

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

function hasOwnerAdjacency(schema: S.OfObject.Data): boolean {
  return [...schema.adjacencies.values(), ...schema.anonymous].some((adjacency) => adjacency.owner);
}

type Step = [string, string, Map<string, unknown>];

/** The singleton a reference object's path starts from, and the ownership entries from it to the object, through the
 * adjacencies marked `owner()`. A counted object has no path (docs/OBJECT_IDENTITY.md, Decided, 55). */
function stepsOf(obj: unknown): [string, Step[]] {
  const steps: Step[] = [];
  const seen = new Set<unknown>();
  let current = obj;
  for (;;) {
    const state = Proxies._innerOf(current);
    const schema = state._schema as S.OfObject.Data;
    if (schema.singleton !== null) return [schema.singleton, steps.reverse()];
    if (!hasOwnerAdjacency(schema)) { // only the object asked about: nothing is owned by a counted object (47)
      throw new LookupError(`a ${repr(state._schemaName)} is counted: it has no path`);
    }
    if (seen.has(current)) throw new LookupError("an ownership cycle: no singleton owns the object");
    seen.add(current);
    const [adjacency, entry, owner] = ownedBy(current);
    const ownerLink = [...entry._links.keys()].find((link: string) => link !== adjacency.me) as string;
    const ownerSchema = Proxies._innerOf(owner)._schema as S.OfObject.Data;
    const i = [...ownerSchema.adjacencies].find(([, held]) => held.relation === adjacency.relation && held.me === ownerLink)?.[0] ?? "";
    steps.push([i, adjacency.name as string, new Map(entry._properties)]);
    current = owner;
  }
}

/** A schema object's path (Decided, 80 and 81): from the root module, the singleton `"."`, through each module and then
 * the schema by name, then through the keyed adjacency that owns each member. `LookupError` where it has none. */
function schemaStepsOf(obj: unknown): [string, Step[]] {
  const noun = (Builders._builder_for(obj) as unknown as { _noun: string })._noun;
  const store = Builders._heldBy(obj);
  if (store === undefined) throw new LookupError(`${noun} no store holds has no path: a schema object's path is in its store`);
  const steps = store._path(obj);
  const name = (obj as { name?: string | null }).name;
  if (steps === null && Builders._named(obj)) throw new LookupError(`the name ${repr(name)} is not a path: its parts are names, joined by dots`);
  if (steps === null) {
    throw new LookupError(`${noun} with no name of its own, nor a member of one that has a name, has no path: it is `
      + "written nested in the one object that links it");
  }
  return [".", steps.map(([i, name]): Step => [i, "", new Map([["name", name]])])];
}

/** The path of a reference object, read off its ownership entries (Decided, 32), or of a schema object, off its name and
 * its owners' (81): a `Paths.OfRoot` value, standalone, of the object's store. */
export function of(obj: unknown): unknown {
  const schemaObject = Builders._builder_for(obj) !== null;
  const [singleton, steps] = schemaObject ? schemaStepsOf(obj) : stepsOf(obj);
  const store = schemaObject ? Builders._heldBy(obj) : Proxies._store_of(obj);
  const step = (rest: Step[]): (n: any) => any => {
    if (rest.length === 0) return (n: any) => n.target((t: any) => t);
    const [i, o, keys] = rest[0]!;
    return (n: any) => n.entry((e: any) => e.i(i).o(o).properties(keys).next(step(rest.slice(1))));
  };
  return (store as any).Paths.OfRoot((r: any) => r.singleton(singleton).next(step(steps)));
}

/** Whether two paths name the same object: equal as plain data. Null, an identity not yet given, is the same only as
 * null. */
export function same(a: any, b: any): boolean {
  if (a === null || b === null) return a === b;
  const plain = Plain.ToPlain(null as unknown as Stores.Store);
  return Plain._symbol(plain(a.as_schema(), a)) === Plain._symbol(plain(b.as_schema(), b)); // keys written bare: no names
}
