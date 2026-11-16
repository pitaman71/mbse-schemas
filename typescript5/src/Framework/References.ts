/**
 * References: one format for what designates an object, a relation entry, a frame or a parameter ([CAP-130: references to objects, entries and frames](mbse:mbse-basis/docs/capabilities/CAP-130.md);
 * [CAP-311: references stabilized](mbse:mbse-basis/docs/capabilities/README.md#CAP-311)).
 *
 * Value schemas, which every store holds, its own, as it holds `Paths`:
 *
 * - `References.OfObject`, a singleton or other non-counted reference object: a value object whose one property, `path`, is a
 *   singleton's, an owned object's or a schema object's path (`Paths.OfRoot`);
 * - `References.OfFrame`, a frame: `binds`, each of its symbols bound to a `References.OfObject`, and `variables`, each
 *   of its variables' values; and what it witnesses: `assigns`, objects' property values (`References.OfProperties`),
 *   and `entries`, relation entries (`References.OfEntry`); and its `errors`, what failed as a term processed it
 *   (`References.OfError`, [CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309));
 * - `References.OfError`, an error annotated on a frame: its `subterm`, where in the transaction's expression it arose,
 *   its `kind`, the name of its class, and its `message`;
 * - `References.OfProperties`, property values an object is witnessed to hold: its `object`, a `References.OfObject`,
 *   and its `properties`, each its value;
 * - `References.OfEntry`, a relation entry: its `relation`, by the relation's path, its `links`, each a
 *   `References.OfObject`, and its `properties`, each its value. Entries compare by value, so that designates one;
 * - `References.OfParameter`, a parameter, by its `name` and nothing else, as the user decided ([the parametrics
 *   proposal](mbse:mbse-basis/proposals/PARAMETRICS.md#decided)). A binding in the scope that encloses the reference
 *   resolves it, not a store.
 *
 * `of(store, x)` gives the reference of an object, an entry, or a frame `store.transaction` gave back, its errors
 * included; `resolve(store, reference)` gives what a reference designates, or null where the store holds none, loading
 * from a store below what the store does not hold; `present(store, reference)` gives what it designates among what the
 * store holds, and never loads; `implied(store, reference)` gives the schema a reference implies, through the store's
 * schemas alone (CAP-311). A counted object has no reference, nor a frame that binds one: nothing names it (object identity 40 and 55 in [CAP-118: singletons, owned and counted objects](mbse:mbse-basis/docs/capabilities/CAP-118.md#decided)).
 *
 * The extension: `install` gives `Schemas.OfSymbol` its `reference`, a `References.OfObject`, so that a pattern's symbol
 * binds the one object a reference designates, given in place of a schema (`.symbols({ ada: reference })`);
 * `validate(pattern)` refuses a symbol given both, or neither. A spec over such a symbol writes the members of the schema
 * of the object the reference designates, where the store holds it, else of the schema its path implies, followed through
 * the store's schemas alone (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)), so that a store holding only the schemas writes it.
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
      OfError: S.OfObject, OfSymbol: S.OfObject, OfParameter: S.OfObject})
    .spec([
      (_: any) => _.OfObject.name("References.OfObject").properties({
        path: txn.Paths.OfRoot, // a singleton's, an owned object's or a schema object's
      }),
      (_: any) => _.OfFrame.name("References.OfFrame").properties({
        binds: S.OfContainer((c: any) => c.index([S.OfStr]).element([_.OfObject])),
        variables: S.OfContainer((c: any) => c.index([S.OfStr]).element([S.OfAny((a: any) => a)])),
        assigns: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfProperties])), // witnessed values
        entries: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfEntry])), // witnessed entries
        errors: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfError])), // what failed (CAP-309)
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
      (_: any) => _.OfError.name("References.OfError").properties({
        subterm: S.OfStr, // where in the expression: a path in its wire form, `$.mutations[0].map`
        kind: S.OfStr, // the error's class's name
        message: S.OfStr,
      }),
      (_: any) => _.OfParameter.name("References.OfParameter").properties({
        name: S.OfStr, // the parameter's name, and nothing else (CAP-311)
      }),
      // --- The extension: a pattern's symbol given the object it binds in place of a schema (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)) ---
      (_: any) => _.OfSymbol.name("Schemas.OfSymbol").properties({ reference: _.OfObject }),
    ])]))]);
}

/** The problems of a pattern's symbols as `References.install` extends them: a symbol given both a schema and a
 * reference, or neither; a symbol has exactly one (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)). */
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

/** A `References.OfFrame`'s callback: each symbol's object's reference, refused where one binds a counted object; and
 * the errors annotated on it, where it is a frame the executor gave back (`Transactions.Frame`). */
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
  const errors = (frame instanceof Transactions.Frame ? frame.errors : []).map((error) => (x: any) =>
    x.as_object((r: any) => r.subterm(error.subterm).kind(error.kind).message(error.message)));
  return (f: any) => (errors.length > 0 ? f.binds(binds).errors(errors) : f.binds(binds)); // none: written as before them
}

/** A `References.OfEntry`'s callback: its relation's path, each link's object's reference and each property's value. */
function entryOf(store: any, entry: any): Callback {
  const relation = Paths.of(entry._relation);
  const links = new Map([...entry._links.keys()].map((link: string) => [link, object(store, entry._proxy[link])])); // each read
  const properties = new Map(entry._properties);
  return (e: any) => e.relation(relation).links(links).properties(properties);
}

/** *(agent)* The schema a reference implies, through the store's schemas alone, reading no data and loading nothing
 * ([CAP-311: references stabilized](mbse:mbse-basis/docs/capabilities/README.md#CAP-311)): of an object reference (`References.OfObject`), the schema its path implies, the one schema that
 * declares its singleton, then, for each step, the one schema that declares the step's owner adjacency; of a schema
 * object's, the meta-schema of the schema object the store holds; of an entry reference (`References.OfEntry`), the
 * relation its relation's path names. It gives the schema of what `present` gives where that is present, and the
 * schema of what `resolve` would load where it is not. `LookupError`, saying where the path cannot be followed;
 * `TypeError` for any other value, a frame's reference, which binds several objects, and a parameter's, whose schema
 * its binding gives (CAP-313), among them. */
export function implied(store: any, reference: any): any {
  const schema = typeof reference?.as_schema === "function" ? reference.as_schema() : undefined;
  if (schema === store.registered("References.OfObject")) {
    const path = (Plain.ToPlain(store)(schema, reference) as Map<string, any>).get("path");
    const held = path.get("singleton") === "." ? findLoaded(store, path) : null; // a schema object, never loaded
    if (held !== null) return new (store._meta_builder_class(held))(held, false, store).as_schema(); // its builder's
    try {
      return _implied(store, path);
    } catch (error) {
      throw new LookupError(`the reference's path ${(error as Error).message}`);
    }
  }
  if (schema === store.registered("References.OfEntry")) {
    const relation = store.held((Plain.ToPlain(store)(schema, reference) as Map<string, any>).get("relation"));
    if (!(relation instanceof S.OfRelation.Data)) throw new LookupError("the reference's relation names no relation the store holds");
    return relation;
  }
  throw new TypeError("References.implied takes a References.OfObject or OfEntry value of the store's");
}

/** The schema of the object a path designates, as the store's schemas imply it, reading no data (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)): the one
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
 * objects (`References.OfFrame`), refused where it binds a counted object. It gives no `References.OfParameter`, since
 * a parameter is not an object that a store holds: a parameter reference is built by its name,
 * `store.References.OfParameter((p: any) => p.name(...))`. */
export function of(store: any, x: unknown): any {
  if (x instanceof Map) return store.References.OfFrame(frameOf(store, x));
  const inner = Proxies._innerOf(x);
  if (inner instanceof Proxies._internals._Entry) return store.References.OfEntry(entryOf(store, inner));
  return store.References.OfObject(object(store, x));
}

/** What `reference` designates in `store`: an object, an entry, or a frame, a map of symbols to objects; null where the
 * store holds none. In a store with a store below, an object the store does not hold is the store below's, loaded
 * (CAP-284); `present` gives what the store holds and loads nothing. A parameter reference (`References.OfParameter`)
 * gives null: a binding in the scope that encloses it resolves it, not a store ([CAP-313: parameter references bound and validated](mbse:mbse-basis/docs/capabilities/README.md#CAP-313)). */
export function resolve(store: any, reference: any): unknown {
  return designated(store, reference, "resolve", findLoaded);
}

/** *(agent)* What `reference` designates among what `store` holds, what it has present: an object made in it or loaded
 * into it, an entry among those it holds, or a frame whose every object it holds; null otherwise. It never fetches from
 * a store below, so that a reference to an object the store does not hold gives null where `resolve` would load it;
 * `implied` then gives the schema the reference implies ([CAP-311: references stabilized](mbse:mbse-basis/docs/capabilities/README.md#CAP-311)). A parameter reference gives null,
 * as `resolve` gives. */
export function present(store: any, reference: any): unknown {
  return designated(store, reference, "present", findHeld);
}

type Find = (store: any, path: any) => unknown;

/** What `reference` designates, each object it names found by `find`: `findLoaded`, which may load from the store
 * below, or `findHeld`, which never does. */
function designated(store: any, reference: any, verb: string, find: Find): unknown {
  const resolvers: [string, (store: any, plain: any, find: Find) => unknown][] = [["References.OfObject", resolveObject],
    ["References.OfEntry", resolveEntry], ["References.OfFrame", resolveFrame], ["References.OfParameter", resolveParameter]];
  const schema = typeof reference?.as_schema === "function" ? reference.as_schema() : undefined;
  const found = resolvers.find(([name]) => store.registered(name) === schema);
  if (found === undefined) {
    throw new TypeError(`References.${verb} takes a References.OfObject, OfEntry, OfFrame or OfParameter value of the `
      + "store's");
  }
  return found[1](store, Plain.ToPlain(store)(schema, reference), find);
}

/** The object at `path`: one the store holds, else, in a store with a store below, the store below's, loaded. */
function findLoaded(store: any, path: any): unknown {
  try {
    return Plain._by_path(store, path, []) ?? null;
  } catch { // a schema object's path whose steps name no entries: nothing has it (only DecodeError is thrown)
    return null;
  }
}

/** The object at `path` that the store holds, loading nothing: a schema object, which a store never loads, or one made
 * in it or loaded into it (`_present`). */
function findHeld(store: any, path: any): unknown {
  if (path.get("singleton") === ".") return findLoaded(store, path);
  return store._present(path) ?? null;
}

/** Null: a parameter reference is resolved by a binding in its scope, never by a store. */
function resolveParameter(): null {
  return null;
}

function resolveObject(store: any, plain: Map<string, any>, find: Find): unknown {
  return find(store, plain.get("path"));
}

function resolveFrame(store: any, plain: Map<string, any>, find: Find): Transactions.Frame | null {
  const frame = new Transactions.Frame(null, ((plain.get("errors") ?? []) as Map<string, any>[]).map((e) =>
    new Transactions.FrameError(e.get("subterm"), e.get("kind"), e.get("message"))));
  for (const [name, given] of (plain.get("binds") ?? new Map()) as Map<string, any>) {
    const target = resolveObject(store, given, find);
    if (target === null) return null;
    frame.set(name, target);
  }
  return frame;
}

function resolveEntry(store: any, plain: Map<string, any>, find: Find): unknown {
  const relation = store.held(plain.get("relation"));
  if (!(relation instanceof S.OfRelation.Data)) return null;
  const links = new Map<string, unknown>();
  for (const [link, given] of (plain.get("links") ?? new Map()) as Map<string, any>) {
    const target = resolveObject(store, given, find);
    if (target === null) return null;
    links.set(link, target);
  }
  if (links.size === 0) return null;
  const [first, target] = [...links][0]!;
  const want = Plain._symbol(plain);
  if (find === findHeld) store._loading += 1; // the entries the store holds of the object, as it holds them, loading none
  try {
    for (const entry of Proxies._linking(relation, first, target, store)) {
      const inner = Proxies._innerOf(entry);
      if (inner._links.size === links.size && [...links].every(([link, held]) => inner._links.get(link) === held)
        && Plain._symbol(Plain.ToPlain(store)(store.References.OfEntry.as_schema(), of(store, entry))) === want) {
        return entry;
      }
    }
  } finally {
    if (find === findHeld) store._loading -= 1;
  }
  return null;
}
