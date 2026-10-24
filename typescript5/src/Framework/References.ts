/**
 * References: one format for what designates an object, a relation entry or a frame (docs/proposals/references).
 *
 * Three value schemas, which every store holds, its own, as it holds `Paths`:
 *
 * - `References.OfObject`, a singleton or other non-counted reference object: a value object whose one property, `path`, is a
 *   singleton's, an owned object's or a schema object's path (`Paths.OfRoot`);
 * - `References.OfFrame`, a frame: `binds`, each of its symbols bound to a `References.OfObject`, and `variables`, each
 *   of its variables' values; and what it witnesses: `assigns`, objects' property values (`References.OfProperties`),
 *   and `entries`, relation entries (`References.OfEntry`);
 * - `References.OfProperties`, property values an object is witnessed to hold: its `object`, a `References.OfObject`,
 *   and its `properties`, each its value;
 * - `References.OfEntry`, a relation entry: its `relation`, by the relation's path, its `links`, each a
 *   `References.OfObject`, and its `properties`, each its value. Entries compare by value, so that designates one.
 *
 * `of(store, x)` gives the reference of an object, an entry, or a frame `store.transaction` gave back; `resolve(store,
 * reference)` gives what a reference designates, or null where the store holds none. A counted object has no reference,
 * nor a frame that binds one: nothing names it (docs/OBJECT_IDENTITY.md, Decided, 40 and 55).
 *
 * The extension: `install` gives `Schemas.OfSymbol` its `reference`, a `References.OfObject`, so that a pattern's symbol
 * binds the one object a reference designates, given in place of a schema (`.symbols({ ada: reference })`);
 * `validate(pattern)` refuses a symbol given both, or neither. A spec over such a symbol writes the members of the schema
 * of the object the reference designates, where the store holds it, else of the schema its path implies, followed through
 * the store's schemas alone (Decided, 8), so that a store holding only the schemas writes it.
 */

import * as Builders from "./Builders.js";
import { LookupError, ValueError } from "./Errors.js";
import * as Paths from "./Paths.js";
import * as Plain from "./Plain.js";
import * as Proxies from "./Proxies.js";
import { repr, sortedStrings } from "./Repr.js";
import * as S from "./Schemas.js";
import * as Transactions from "./Transactions.js";

/** The reference schemas, defined in the store a transaction writes: `store.transaction(References.install)`. A store
 * is made by it, after `Schemas.install` and `Paths.install`, read by the bootstrap (`Builders`); run again in a store,
 * it finds each by its name and writes nothing. */
export function install(txn: any): any {
  const S = txn.Schemas; // the store's meta-schemas and basic scalars (78)
  return txn.uid("mbse.Schemas.References/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({OfObject: S.OfObject, OfFrame: S.OfObject, OfProperties: S.OfObject, OfEntry: S.OfObject,
      OfSymbol: S.OfObject})
    .spec([
      (_: any) => _.OfObject.name("References.OfObject").properties({
        path: txn.Paths.OfRoot, // a singleton's, an owned object's or a schema object's
      }),
      (_: any) => _.OfFrame.name("References.OfFrame").properties({
        binds: S.OfContainer((c: any) => c.index([S.OfStr]).element([_.OfObject])),
        variables: S.OfContainer((c: any) => c.index([S.OfStr]).element([S.OfAny((a: any) => a)])),
        assigns: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfProperties])), // witnessed values
        entries: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfEntry])), // witnessed entries
      }),
      (_: any) => _.OfProperties.name("References.OfProperties").properties({
        object: _.OfObject,
        properties: S.OfContainer((c: any) => c.index([S.OfStr]).element([S.OfAny((a: any) => a)])),
      }),
      (_: any) => _.OfEntry.name("References.OfEntry").properties({
        relation: txn.Paths.OfRoot, // the relation's path
        links: S.OfContainer((c: any) => c.index([S.OfStr]).element([_.OfObject])),
        properties: S.OfContainer((c: any) => c.index([S.OfStr]).element([S.OfAny((a: any) => a)])),
      }),
      // --- The extension: a pattern's symbol given the object it binds in place of a schema (Decided, 8) ---
      (_: any) => _.OfSymbol.name("Schemas.OfSymbol").properties({ reference: _.OfObject }),
    ])]))]);
}

/** The problems of a pattern's symbols as `References.install` extends them: a symbol given both a schema and a
 * reference, or neither; a symbol has exactly one (docs/proposals/references, Decided, 8). */
export function validate(pattern: unknown): string[] {
  if (!(pattern instanceof S.OfPattern.Data)) throw new TypeError(`References.validate takes a pattern, not ${repr(pattern)}`);
  const problems: string[] = [];
  for (const [name, symbol] of pattern.symbols) {
    try {
      Transactions._exactlyOne(name, symbol, ValueError);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  return problems;
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

/** The schema of the object a path designates, as the store's schemas imply it, reading no data (Decided, 8): the one
 * schema that declares its singleton, then, for each step, the one schema that declares the adjacency `o`, marked
 * owner(), on another link of the relation that the current schema's adjacency `i` is to (as `_filled` finds what a
 * link links). `LookupError`, saying where the path cannot be followed: an unknown singleton, an adjacency the schema
 * lacks, a link no one schema fills; or a schema object's path, where the store does not hold it. */
export function _implied(store: any, pathPlain: unknown): any {
  const [singleton, steps] = Plain._steps(pathPlain, []);
  if (singleton === ".") throw new LookupError("names a schema object the store does not hold");
  const schemas = ([...store._schemas] as [string, any][]).filter(([, schema]) => schema instanceof S.OfObject.Data);
  let current = schemas.find(([, schema]) => schema.singleton === singleton)?.[1];
  if (current === undefined) throw new LookupError(`starts from ${repr(singleton)}, which no schema declares a singleton`);
  for (const [i, o] of steps) {
    const adjacency = current.adjacencies.get(i);
    if (adjacency === undefined) {
      throw new LookupError(`steps through ${repr(i)}, an adjacency ${repr(current.name)} does not declare`);
    }
    const found = schemas.filter(([, schema]) => [...schema.adjacencies.values(), ...schema.anonymous].some((a: any) =>
      a.owner && a.name === o && a.relation === adjacency.relation && a.me !== adjacency.me));
    if (found.length !== 1) {
      throw new LookupError(`steps through ${repr(i)} of ${repr(current.name)}, where not exactly one schema declares an `
        + `adjacency ${repr(o)} marked owner() on another link of its relation: found `
        + repr(sortedStrings(found.map(([name]) => name))));
    }
    current = found[0]![1];
  }
  return current;
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
