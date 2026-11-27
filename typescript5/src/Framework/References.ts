/**
 * References: one format for what designates an object, a relation entry, a frame or a parameter ([CAP-130: references to objects, entries and frames](mbse:mbse-basis/docs/capabilities/CAP-130.md);
 * [CAP-311: references stabilized](mbse:mbse-basis/docs/capabilities/README.md#CAP-311)).
 *
 * Value schemas, which every store holds, its own, as it holds `Paths`:
 *
 * - `References.OfObject`, a singleton or other non-counted reference object: a value object whose one property, `path`, is a
 *   singleton's, an owned object's or a schema object's path (`Paths.OfRoot`);
 * - `References.OfFrame`, a frame: its `errors`, what failed as a term processed it (`References.OfError`,
 *   [CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)); and, which `Changes.install` gives it, its `journal`, a
 *   `Changes.Transaction`, which the frame is ([CAP-318: support for decoupled code](mbse:mbse-basis/docs/capabilities/README.md#CAP-318), as the user
 *   decided: "frames contained journals which contained changes"): its symbols the frame's bindings, each an object by
 *   its `References.OfObject`, a schema object by its `References.OfSchema`, and its changes what its path's clauses
 *   referenced or changed, each property set or cleared, each relation entry inserted or removed; and, as an item of a
 *   frame stream (`txn.exec`), its `scope`, the id of the input frame it descends from, its `remainder`, where the rest
 *   of the expression begins, written as an error's `subterm` is, unset on a complete frame, and `terminal`, true where
 *   a term dropped it and its path changed something, a routing mark, unset where false. It has no bindings, values or
 *   entries of its own beside its journal;
 * - `References.OfEnd`, a frame stream's completion marker, `{"end": scope}`: its `scope`, a branch's or an input
 *   frame's, unset where it ends the whole stream; it marks an end, and carries nothing else; and
 *   `References.OfItem`, an item of a frame stream, the union of a `frame` and an `end`. `Changes.install` defines both,
 *   after the `Changes` schemas their journals are, so that the built-in serialization carries a stream to another
 *   process as it carries any value;
 * - `References.OfError`, an error annotated on a frame: its `subterm`, where in the transaction's expression it arose,
 *   its `kind`, the name of its class, and its `message`;
 * - `References.OfEntry`, a relation entry: its `relation`, by the relation's path, its `links`, each a
 *   `References.OfObject`, and its `properties`, each its value. Entries compare by value, so that designates one;
 * - `References.OfSchema`, a schema object's reference, which refines `References.OfObject`: its `path` is a schema
 *   object's, from the root module, the singleton `"."`, and writing or reading one whose path is not refuses it;
 *   `validate_schema(store, reference, kind)` reports one that designates no schema object the store holds, or one of
 *   another kind than `kind` where a schema argument constrains it, as `References.OfSchema[Schemas.OfObject]` does
 *   ([CAP-320: schema and value references](mbse:mbse-basis/docs/capabilities/README.md#CAP-320));
 * - `References.OfValue`, data that holds a value of any schema, its one property, `value`, an `OfAny`, as
 *   `Schemas.OfAny` is the schema that admits one (CAP-320);
 * - `References.OfParameter`, a parameter, by its `name` and nothing else, as the user decided ([the parametrics
 *   proposal](mbse:mbse-basis/proposals/PARAMETRICS.md#decided)). A parameter assignment or a parameter binding in the enclosing
 *   scope resolves it, not a store. It may stand in the place of a value of any schema, which `Visitors.OfAny.as_parameter`
 *   reads ([CAP-312: a parameter reference in place of anything with a schema](mbse:mbse-basis/docs/capabilities/CAP-312.md#decided)).
 *
 * `of(store, x)` gives the reference of an object, an entry, or a frame `store.transaction` or `txn.exec` gave back,
 * its journal, errors, scope and remainder included, a symbol it binds that has no reference annotated as an error,
 * and the `References.OfEnd` of a completion marker `txn.exec` gave. A reference is resolved within a transaction, as every read of a store's data is: a pattern's symbol given
 * an object's reference binds what it designates, and no function resolves one from outside the transaction
 * ([CAP-315: every read within a transaction or through a follow](mbse:mbse-basis/docs/capabilities/CAP-315.md)). An entry's reference is matched by a pattern over the objects it links,
 * and a frame's by a pattern whose symbols are given the references its journal binds. A counted object has no
 * reference, and a frame that binds one leaves it out of its journal: nothing names it (object identity 40 and 55 in [CAP-118: singletons, owned and counted objects](mbse:mbse-basis/docs/capabilities/CAP-118.md#decided)).
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
    .symbols({OfObject: S.OfObject, OfFrame: S.OfObject, OfEntry: S.OfObject,
      OfError: S.OfObject, OfSymbol: S.OfObject, OfParameter: S.OfObject, OfSchema: S.OfObject, OfValue: S.OfObject})
    .spec([
      (_: any) => _.OfObject.name("References.OfObject").properties({
        path: txn.Paths.OfRoot, // a singleton's, an owned object's or a schema object's
      }),
      (_: any) => _.OfFrame.name("References.OfFrame").properties({ // its journal, `Changes.install`'s (CAP-318)
        errors: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfError])), // what failed (CAP-309)
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
      (_: any) => _.OfSchema.name("References.OfSchema").refines([_.OfObject]), // its path starts at "." (CAP-320)
      (_: any) => _.OfValue.name("References.OfValue").properties({
        value: S.OfAny((a: any) => a), // a value of any schema (CAP-320)
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

/** A `References.OfObject`'s callback: an object's path, or that of a reference a frame given back holds, a schema
 * object's among them; refused for a counted object, which nothing names. */
function object(store: any, obj: unknown): Callback {
  const target = Proxies._deref(obj);
  if (target instanceof Transactions.Refused) throw new LookupError(target.message);
  if (Transactions._isReference(store, target)) {
    const held = Proxies._read(target, "path"); // a reference a frame given back holds
    return (o: any) => o.path(held);
  }
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

/** A `References.OfFrame`'s callback: its journal (CAP-318), the one a frame the executor gave back is
 * (`Transactions.Frame`), else one of its bindings alone, each symbol's object by its reference, a schema object's a
 * `References.OfSchema`; a symbol that binds an object with no reference, a counted one, left out of it and written as an
 * error annotated on the frame, at `$`; and the errors annotated on it, its `scope`, and its `remainder`'s subterm where
 * it halted. */
function frameOf(store: any, frame: Map<string, unknown>): Callback {
  const errors: [string, string, string][] = (frame instanceof Transactions.Frame ? frame.errors : [])
    .map((error) => [error.subterm, error.kind, error.message]);
  const symbols: Plain.PlainMap = new Map();
  for (const [name, target] of Map.prototype.entries.call(frame) as IterableIterator<[string, unknown]>) {
    try {
      symbols.set(name, symbolOf(store, target));
    } catch (error) {
      if (!(error instanceof LookupError)) throw error;
      errors.push(["$", error.name, `symbol ${repr(name)} of the frame: ${error.message}`]);
    }
  }
  const given = frame instanceof Transactions.Frame ? frame.journal : null;
  const journal = given ?? Plain.FromPlain(store)(store.registered("Changes.Transaction"),
    new Map([["symbols", symbols]]));
  const [scope, remainder] = frame instanceof Transactions.Frame ? [frame.scope, frame.remainder] : [null, null];
  const terminal = frame instanceof Transactions.Frame && frame.terminal;
  return (f: any) => {
    f.journal(journal);
    if (errors.length > 0) {
      f.errors(errors.map(([subterm, kind, message]) => (x: any) =>
        x.as_object((r: any) => r.subterm(subterm).kind(kind).message(message))));
    }
    if (scope !== null) f.scope(scope);
    if (remainder !== null) f.remainder(remainder.subterm); // where it halted: a position, not a copy of the expression
    return terminal ? f.terminal(true) : f; // a routing mark, unset where false
  };
}

/** A frame's binding as a `Changes.Symbol`, as plain data: its object's reference, a schema object's a
 * `References.OfSchema`; `LookupError` where it has none. */
function symbolOf(store: any, target: unknown): Plain.PlainMap {
  const reference = store.References.OfObject(object(store, target));
  const plain = Plain.ToPlain(store)(reference.as_schema(), reference) as Plain.PlainMap;
  const inner = Proxies._innerOf(Proxies._deref(target));
  if (inner instanceof Proxies._internals._RecordData && inner._schema !== store.registered("References.OfObject")) {
    plain.set("$schema", store.name_of(inner._schema)); // a schema object's reference, as it was given
  } else if (!(inner instanceof Proxies._internals._RecordData) && !Proxies._isObjectData(Proxies._deref(target))) {
    plain.set("$schema", "References.OfSchema"); // a schema object
  }
  return new Map([["reference", plain]]);
}

/** A `References.OfEnd`'s callback: a completion marker's scope, unset where it ends the whole stream
 * (`{"end": null}`). It marks an end, and carries nothing else. */
function endOf(marker: Map<string, unknown>): Callback {
  const scope = marker.get("end") as string | null;
  return (e: any) => scope === null ? e : e.scope(scope);
}

/** Whether a map is a completion marker of a frame stream, `{"end": scope}`: not a frame, which binds objects, never a
 * scope, by its symbols. */
function isEnd(x: Map<string, unknown>): boolean {
  const end = x.get("end");
  return !(x instanceof Transactions.Frame) && x.size === 1 && x.has("end") && (end === null || typeof end === "string");
}

/** A `References.OfEntry`'s callback: its relation's path, each link's object's reference and each property's value. */
function entryOf(store: any, entry: any): Callback {
  const relation = Paths.of(entry._relation);
  const links = new Map([...entry._links.keys()].map((link: string) => [link, // each read; a
    Proxies._parameter_in(entry._proxy[link]) ?? object(store, entry._proxy[link])])); // parameter reference, as it is
  const properties = new Map(entry._properties);
  return (e: any) => e.relation(relation).links(links).properties(properties);
}

/** The problems of a schema object's reference (`References.OfSchema`) in `store`, where `kind`, a schema of schemas
 * (`store.Schemas.OfObject`), constrains the kind of schema it designates, as the schema argument of
 * `References.OfSchema[Schemas.OfObject]` does; null constrains nothing. A reference's problems: its path is not a
 * schema object's, from the root module; the store holds no schema object at its path; or the schema object it
 * designates is not of `kind`, nor of a refinement of it ([CAP-320: schema and value references](mbse:mbse-basis/docs/capabilities/README.md#CAP-320)). */
export function validate_schema(store: any, reference: unknown, kind: unknown = null): string[] {
  const inner = Proxies._innerOf(Proxies._durable(reference));
  if (!(inner instanceof Proxies._internals._RecordData && S.is_a(inner._schema, store.registered(Plain.SCHEMA_REFERENCE)))) {
    throw new TypeError(`References.validate_schema takes a schema object's reference, not ${repr(reference)}`);
  }
  let held: unknown;
  try {
    held = _schema(store, reference);
  } catch (error) { // a ValueError: a path that is not a schema object's, refused when written
    return [(error as Error).message];
  }
  if (held === null) return ["a schema object's reference designates no schema object the store holds"];
  const builder = Builders._builder_for(held) as new (...args: unknown[]) => any;
  const own = new builder(held, false, store).as_schema();
  const expected = Proxies._deref(kind) as any;
  if (expected !== null && !S.is_a(own, expected)) {
    return [`a schema object's reference designates a ${repr(own.name)}, where a ${repr(expected.name)} is expected`];
  }
  return [];
}

/** The schema object a schema object's reference designates in `store`, or null where the store holds none at its path,
 * or it has none; `ValueError` where its path is not a schema object's. */
export function _schema(store: any, reference: any): unknown {
  const path = (Plain.ToPlain(store)(reference.as_schema(), reference) as Map<string, unknown>).get("path");
  return path === undefined ? null : store.held(path);
}

/** The schema of the object a path designates, as the store's schemas imply it, reading no data (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)): the one
 * schema that declares its singleton, then, for each step, the one schema that declares the adjacency `o`, marked
 * owner(), on another link of the relation that the current schema's adjacency `i` is to (as `_filled` finds what a
 * link links). `LookupError`, saying where the path cannot be followed: an unknown singleton, an adjacency the schema
 * lacks, a link no one schema fills; or a schema object's path, where the store does not hold it. `pathPlain` is a
 * `References.OfObject`'s path, as plain data; `store` holds the schemas, whatever layer holds the data: a journal names
 * an object held before by its reference alone where this is its schema (`Changes.gather`). */
export function implied(store: any, pathPlain: unknown): any {
  const [singleton, steps] = Plain._steps(pathPlain, []);
  if (singleton === Plain.ROOT) throw new LookupError("names a schema object the store does not hold");
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
 * object; of a relation entry (`References.OfEntry`); of a frame `store.transaction` or `txn.exec` gave back, a map of
 * symbols to objects (`References.OfFrame`), its journal, or one of its bindings, a symbol that binds a counted object
 * left out of it and annotated as an error, with its errors, scope and remainder where it carries them; of a completion marker `txn.exec` gave, `{"end": scope}` (`References.OfEnd`). It
 * gives no `References.OfParameter`, since
 * a parameter is not an object that a store holds: a parameter reference is built by its name,
 * `store.References.OfParameter((p: any) => p.name(...))`. */
export function of(store: any, x: unknown): any {
  if (x instanceof Map) {
    return isEnd(x) ? store.References.OfEnd(endOf(x)) : store.References.OfFrame(frameOf(store, x));
  }
  const inner = Proxies._innerOf(x);
  if (inner instanceof Proxies._internals._Entry) return store.References.OfEntry(entryOf(store, inner));
  return store.References.OfObject(object(store, x));
}

/** The object a `References.OfObject` designates in `store`, or null where the store holds none: what a pattern's symbol
 * given the reference binds, within the transaction that runs it (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)). */
export function _designated(store: any, reference: any): unknown {
  return store._interpreter().designated((Plain.ToPlain(store)(reference.as_schema(), reference) as Map<string, any>).get("path"));
}
