/**
 * References: one format for what designates an object, a relation entry or a frame (docs/proposals/references).
 *
 * Three value schemas, which every store holds, its own, as it holds `Paths`:
 *
 * - `References.OfObject`, a singleton or other non-counted reference object: a union whose one branch, `path`, is a
 *   singleton's, an owned object's or a schema object's path (`Paths.OfRoot`);
 * - `References.OfFrame`, a frame: `binds`, each of its symbols bound to a `References.OfObject`, and `variables`, each
 *   of its variables' values;
 * - `References.OfEntry`, a relation entry: its `relation`, by the relation's path, its `links`, each a
 *   `References.OfObject`, and its `properties`, each its value. Entries compare by value, so that designates one.
 *
 * `of(store, x)` gives the reference of an object, an entry, or a frame `store.transaction` gave back; `resolve(store,
 * reference)` gives what a reference designates, or null where the store holds none. A counted object has no reference,
 * nor a frame that binds one: nothing names it (docs/OBJECT_IDENTITY.md, Decided, 40 and 55).
 */

import * as Builders from "./Builders.js";
import { LookupError } from "./Errors.js";
import * as Paths from "./Paths.js";
import * as Plain from "./Plain.js";
import * as Proxies from "./Proxies.js";
import { repr } from "./Repr.js";
import * as S from "./Schemas.js";

/** The reference schemas, defined in the store a transaction writes: `store.transaction(References.install)`. A store
 * is made by it, after `Schemas.install` and `Paths.install`, read by the bootstrap (`Builders`); run again in a store,
 * it finds each by its name and writes nothing. */
export function install(txn: any): any {
  const S = txn.Schemas; // the store's meta-schemas and basic scalars (78)
  return txn.uid("mbse.Schemas.References/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({OfObject: S.OfUnion, OfFrame: S.OfObject, OfEntry: S.OfObject})
    .spec([
      (_: any) => _.OfObject.name("References.OfObject").branches([
        (t: any) => t.name("path").schema([txn.Paths.OfRoot]), // a singleton, an owned object, a schema object
      ]),
      (_: any) => _.OfFrame.name("References.OfFrame").properties({
        binds: S.OfContainer((c: any) => c.index([S.OfStr]).element([_.OfObject])),
        variables: S.OfContainer((c: any) => c.index([S.OfStr]).element([S.OfAny((a: any) => a)])),
      }),
      (_: any) => _.OfEntry.name("References.OfEntry").properties({
        relation: txn.Paths.OfRoot, // the relation's path
        links: S.OfContainer((c: any) => c.index([S.OfStr]).element([_.OfObject])),
        properties: S.OfContainer((c: any) => c.index([S.OfStr]).element([S.OfAny((a: any) => a)])),
      }),
    ])]))]);
}

type Callback = (visitor: any) => any;

/** A `References.OfObject`'s callback: an object's path; refused for a counted object, which nothing names. */
function object(store: any, obj: unknown): Callback {
  const target = Proxies._deref(obj);
  if (Proxies._isObjectData(target)) {
    Proxies._same_store(store, target);
    if (Proxies._counted(target)) {
      throw new LookupError(`a counted ${repr(Proxies._innerOf(target)._schemaName)} has no reference: nothing names it `
        + "(make it a singleton's or an owner's)");
    }
  } else if (Builders._builder_for(target) === null) {
    throw new TypeError(`References.of takes an object, a relation entry or a frame, not ${repr(target)}`);
  }
  const path = Paths.of(target);
  return (o: any) => o.path(path);
}

/** A `References.OfFrame`'s callback: each symbol's object's reference; refused where one binds a counted object. */
function frameOf(store: any, frame: Map<string, unknown>): Callback {
  const binds = new Map<string, Callback>();
  for (const [name, target] of frame) {
    try {
      binds.set(name, object(store, target));
    } catch (error) {
      if (!(error instanceof LookupError)) throw error;
      throw new LookupError(`symbol ${repr(name)} of the frame: ${error.message}`);
    }
  }
  return (f: any) => f.binds(binds);
}

/** A `References.OfEntry`'s callback: its relation's path, each link's object's reference and each property's value. */
function entryOf(store: any, entry: any): Callback {
  const relation = Paths.of(entry._relation);
  const links = new Map([...entry._links].map(([link, target]: [string, unknown]) => [link, object(store, target)]));
  const properties = new Map(entry._properties);
  return (e: any) => e.relation(relation).links(links).properties(properties);
}

/** The reference of `x`, a value of the store's: of an object (`References.OfObject`), its path, refused for a counted
 * object; of a relation entry (`References.OfEntry`); of a frame `store.transaction` gave back, a map of symbols to
 * objects (`References.OfFrame`), refused where it binds a counted object. */
export function of(store: any, x: unknown): any {
  if (x instanceof Map) return store.References.OfFrame(frameOf(store, x));
  const inner = Proxies._innerOf(x);
  if (inner instanceof Proxies._internals._Entry) return store.References.OfEntry(entryOf(store, inner));
  return store.References.OfObject(object(store, x));
}

/** What `reference` designates in `store`: an object, an entry, or a frame, a map of symbols to objects; null where the
 * store holds none. */
export function resolve(store: any, reference: any): unknown {
  const resolvers: [string, (store: any, plain: any) => unknown][] = [["References.OfObject", resolveObject],
    ["References.OfEntry", resolveEntry], ["References.OfFrame", resolveFrame]];
  const schema = typeof reference?.as_schema === "function" ? reference.as_schema() : undefined;
  const found = resolvers.find(([name]) => store.registered(name) === schema);
  if (found === undefined) {
    throw new TypeError("References.resolve takes a References.OfObject, OfEntry or OfFrame value of the store's");
  }
  return found[1](store, Plain.ToPlain(store)(schema, reference));
}

function resolveObject(store: any, plain: Map<string, any>): unknown {
  try {
    return Plain._by_path(store, plain.get("path"), []) ?? null;
  } catch { // a schema object's path whose steps name no entries: nothing has it (only DecodeError is thrown)
    return null;
  }
}

function resolveFrame(store: any, plain: Map<string, any>): Map<string, unknown> | null {
  const frame = new Map<string, unknown>();
  for (const [name, given] of (plain.get("binds") ?? new Map()) as Map<string, any>) {
    const target = resolveObject(store, given);
    if (target === null) return null;
    frame.set(name, target);
  }
  return frame;
}

function resolveEntry(store: any, plain: Map<string, any>): unknown {
  const relation = store.held(plain.get("relation"));
  if (!(relation instanceof S.OfRelation.Data)) return null;
  const links = new Map<string, unknown>();
  for (const [link, given] of (plain.get("links") ?? new Map()) as Map<string, any>) {
    const target = resolveObject(store, given);
    if (target === null) return null;
    links.set(link, target);
  }
  if (links.size === 0) return null;
  const [first, target] = [...links][0]!;
  const want = Plain._symbol(plain);
  for (const entry of Proxies._linking(relation, first, target, store)) {
    const inner = Proxies._innerOf(entry);
    if (inner._links.size === links.size && [...links].every(([link, held]) => inner._links.get(link) === held)
      && Plain._symbol(Plain.ToPlain(store)(store.References.OfEntry.as_schema(), of(store, entry))) === want) {
      return entry;
    }
  }
  return null;
}
