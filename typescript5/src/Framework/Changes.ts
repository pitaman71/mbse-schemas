/**
 * Changes: what a transaction changed, gathered at its commit as schema data, a journal
 * ([CAP-270: a transaction's changes observed at its commit](mbse:mbse-basis/docs/capabilities/README.md#CAP-270),
 * [CAP-269: transactions resolved into their effects](mbse:mbse-basis/docs/capabilities/README.md#CAP-269),
 * [CAP-271: the journal language](mbse:mbse-basis/docs/capabilities/README.md#CAP-271),
 * [CAP-321: changes gathered as schema data](mbse:mbse-basis/docs/capabilities/CAP-321.md),
 * [the journals proposal](mbse:mbse-basis/proposals/JOURNALS.md#the-changes-schemas-proposed)).
 *
 * The journal language's value schemas, which every store holds, its own, as it holds `References` (`install`):
 *
 * - `Changes.Journal`, a journal: its transactions, in order, a container of `Changes.Transaction` by position. A journal
 *   is data: built, sliced, written, read and compared as any value is, with no store of its own; its transactions are
 *   read by iterating it. Whole transactions taken from a journal, in order, are a journal too.
 * - `Changes.Transaction`, one transaction: its `id`, unique, the uid `Provenance` records it by; its `symbols`, each by
 *   its name (`Changes.Symbol`), the transaction's own; then its `changes`, in order, each a `Changes.Change`.
 * - `Changes.Symbol`, an object that exists (A): an object held before, by its `reference` (`References.OfObject`), or a
 *   new object, by its `schema` (`References.OfSchema`) alone. An object held before is given its `schema` too where its
 *   path does not imply it, as where objects of several schemas are owned through one relation, so that a reader never
 *   guesses it.
 * - `Changes.Change`, a change: the union of the kinds of change, a relation entry's (`entry`, `Changes.OfEntry`) and a
 *   property's (`property`, `Changes.OfProperty`).
 * - `Changes.OfEntry`, a relation entry inserted or removed (B): the union of its actions, `Changes.OfEntry.Insert` and
 *   `Changes.OfEntry.Remove`. Each action is written on its `holder`'s adjacency named `adjacency`, and names its other
 *   `links`, each by its name, and its `properties`' values.
 * - `Changes.OfLink`, an object that an entry change names, as `References` names one: a `symbol` of the transaction; an
 *   object held, by its `reference` (`References.OfObject`); a counted object, which has no reference, by its value
 *   (`counted`, a `Changes.Counted`: its `schema`, a `References.OfSchema`, and its `properties`' values), found by that
 *   value or made; or a `parameter` reference in the object's place (`References.OfParameter`).
 * - `Changes.OfProperty`, a property changed (C): the union of its actions, `Changes.OfProperty.Set`, which gives its
 *   `holder`'s symbol, the property's `name` and its whole `value`, and `Changes.OfProperty.Clear`, which gives its
 *   `holder` and `name`. A change within a property's value is
 *   [CAP-272: surgical mutations of a property's value](mbse:mbse-basis/docs/capabilities/README.md#CAP-272)'s.
 *
 * `install` also extends `References.OfFrame` with a frame stream's parts, `scope`, `remainder` and `journal`, a
 * `Changes.Transaction`, and defines `References.OfEnd`, the stream's completion marker, and `References.OfItem`, an
 * item of the stream, a frame or an end ([CAP-318: support for decoupled code](mbse:mbse-basis/docs/capabilities/README.md#CAP-318),
 * stage 1): `References.install` runs before the journal language is defined, and a frame's journal is one.
 *
 * Every `Changes` schema is a value object. A value, a property's in a change, an entry's or a counted object's, is a
 * payload (`Mutations.Payload`), written by the schema of the property it is the value of, and marked with its schema
 * only where that schema cannot tell it ([PRI-025: never guess the schema](mbse:mbse-basis/docs/PRINCIPLES.md#PRI-025)):
 * the plain form reads a transaction's symbols first, and each payload by the schema that its holder's schema gives the
 * property (`_within`), so that a journal is read where the store holds the schemas that its objects are of.
 *
 * `observe(store, observer)` calls `observer(journal)` after each transaction of `store` that commits having changed
 * something, a `Changes.Journal` of that one transaction, a value that outlives it, and returns a function that ends the
 * observing; a transaction that raises, its writes dropped, is observed by none. What a transaction changed is net of what
 * it undid within itself: its symbols, each object the transaction touched that was held before it, by its reference as
 * it was, and each owned object it created, by its schema, after its owner's, so that applying finds it by its ownership
 * entry; then its changes, the relation entries it removed, then those it inserted, each written on the adjacency of one
 * object it links, then the properties it changed, each set to its value or cleared. An object the transaction deleted is
 * never named: the entry that owned it is removed by its owner's key for it, written on its owner's adjacency, and what
 * its deletion removed in cascade, every entry linking it and what it owned, is left to follow from that, as it does in
 * every store that applies the journal. `store.follow(follower)` gives the same journal as plain data.
 *
 * `apply(txn, journal)` writes, within the transaction `txn` builds, each transaction of a journal, in order: applied to
 * the store as it was before them, it makes the same changes, and applied again, it changes nothing. A transaction's
 * changes are applied as one upsert, which `_upsert` builds through the builders from the `Changes.Transaction`, read
 * through the visitors: of its symbols, of each object that an entry change names by its reference, and of each counted
 * object that it names inline, one symbol for each value, whose spec writes its changes where they do not hold.
 *
 * The changes are gathered from the transaction's proposals just before it commits, after `Provenance` records it and
 * its ownership is settled, so that what it deleted in cascade, and every entry linking it, is among them; what an object
 * was before is read from what the store holds as committed. `gather` builds them as a `Changes.Transaction`, from what
 * a layer changed, net, read through its interpreter's hooks, a value that outlives the transaction: a store in
 * memory's (`_gather`) and any other layer's alike. A savepoint's changes are gathered alike, relative to the
 * transaction it is within: what interpreting an input frame changed, which the frame given carries as a journal
 * (`Transactions.Frame.journal`). An expression's terms, and the entries linking schema objects, are no data, and are left
 * out.
 *
 * A cache layer, a store given a layer below, applies to what it holds the journals that the frames the layer below gives
 * back carry, and those that the layer below's follow gives, as a transaction of its own (`Builders.Store._apply`): to the
 * objects present in it alone. `_present_only` reads the layer below's `Changes.Transaction` through the visitors, and
 * builds the one that changes those objects alone, making an object created under one present, and leaving out an entry
 * that names one not present. What the cache layer writes itself, by builders, it sends below as the
 * `Changes.Transaction` of the savepoint that wrote it, which the layer below's transaction executes as the mutation
 * transaction that makes those changes (`_expression`).
 */

import * as Builders from "./Builders.js";
import { ValueError } from "./Errors.js";
import * as Json from "./JSON.js";
import * as Paths from "./Paths.js";
import * as Plain from "./Plain.js";
import type * as Proposals from "./Proposals.js";
import * as Proxies from "./Proxies.js";
import * as References from "./References.js";
import { compareStrings } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import * as Transactions from "./Transactions.js";

/** The journal language's schemas, defined in the store a transaction writes: `store.transaction(Changes.install)`. A
 * store is made by it, after `References.install` and `Mutations.install`, read by the bootstrap (`Builders`); run
 * again in a store, it finds each by its name and writes nothing. */
export function install(txn: any): any {
  const S = txn.Schemas; // the store's meta-schemas and basic scalars (78)
  const R = txn.References;
  /** An entry change's members, an insert's and a remove's alike. */
  const entry = (_: any): Record<string, any> => ({
    holder: _.OfLink, // the object whose adjacency writes it
    adjacency: S.OfStr, // the holder's, by name
    links: S.OfContainer((c: any) => c.index([S.OfStr]).element([_.OfLink])), // its other links, by name
    properties: S.OfContainer((c: any) => c.index([S.OfStr]).element([txn.Mutations.Payload])),
  });
  return txn.uid("mbse.Schemas.Changes/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ Journal: S.OfContainer, Transaction: S.OfObject, Symbol: S.OfObject, Change: S.OfUnion,
      OfEntry: S.OfUnion, Insert: S.OfObject, Remove: S.OfObject, OfProperty: S.OfUnion,
      Set: S.OfObject, Clear: S.OfObject, OfLink: S.OfUnion, Counted: S.OfObject,
      OfFrame: S.OfObject, OfEnd: S.OfObject, OfItem: S.OfUnion })
    .spec([
      (_: any) => _.Journal.name("Changes.Journal").index([S.OfInt]).element([_.Transaction]), // in order
      (_: any) => _.Transaction.name("Changes.Transaction").properties({
        id: S.OfStr, // unique: the uid Provenance records it by
        symbols: S.OfContainer((c: any) => c.index([S.OfStr]).element([_.Symbol])), // by name: its own
        changes: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.Change])), // in order
      }),
      (_: any) => _.Symbol.name("Changes.Symbol").properties({ // A: an object exists
        reference: R.OfObject, // held before
        schema: R.OfSchema, // alone, a new one's; else where its path does not imply it
      }),
      (_: any) => _.Change.name("Changes.Change").branches([
        (t: any) => t.name("entry").schema([_.OfEntry]),
        (t: any) => t.name("property").schema([_.OfProperty]),
      ]),
      (_: any) => _.OfEntry.name("Changes.OfEntry").branches([ // B: a relation entry inserted or removed
        (t: any) => t.name("insert").schema([_.Insert]),
        (t: any) => t.name("remove").schema([_.Remove]),
      ]),
      (_: any) => _.Insert.name("Changes.OfEntry.Insert").properties(entry(_)),
      (_: any) => _.Remove.name("Changes.OfEntry.Remove").properties(entry(_)),
      (_: any) => _.OfProperty.name("Changes.OfProperty").branches([ // C: a property set or cleared
        (t: any) => t.name("set").schema([_.Set]),
        (t: any) => t.name("clear").schema([_.Clear]),
      ]),
      (_: any) => _.Set.name("Changes.OfProperty.Set").properties({
        holder: S.OfStr, // a symbol
        name: S.OfStr,
        value: txn.Mutations.Payload, // its whole value
      }),
      (_: any) => _.Clear.name("Changes.OfProperty.Clear").properties({
        holder: S.OfStr, // a symbol
        name: S.OfStr,
      }),
      (_: any) => _.OfLink.name("Changes.OfLink").branches([ // an object an entry change names
        (t: any) => t.name("symbol").schema([S.OfStr]), // a symbol of the transaction
        (t: any) => t.name("reference").schema([R.OfObject]), // an object held, by its reference
        (t: any) => t.name("counted").schema([_.Counted]), // a counted object, by its value
        (t: any) => t.name("parameter").schema([R.OfParameter]), // a parameter reference in its place (CAP-312)
      ]),
      (_: any) => _.Counted.name("Changes.Counted").properties({ // no reference: found by its value, or made
        schema: R.OfSchema,
        properties: S.OfContainer((c: any) => c.index([S.OfStr]).element([txn.Mutations.Payload])),
      }),
      // --- A frame stream's items as schema data, for a layer across a process boundary (CAP-318, stage 1) ---
      (_: any) => _.OfFrame.name("References.OfFrame").properties({
        scope: S.OfStr, // the id of the input frame it descends from, as `Transactions.Frame.scope`
        remainder: S.OfStr, // where the rest begins, as `References.OfError`'s subterm; unset where complete
        journal: _.Transaction, // the changes made interpreting its input frame (CAP-321)
      }),
      (_: any) => _.OfEnd.name("References.OfEnd").properties({ // the completion marker, `{"end": scope}`
        scope: S.OfStr, // a branch's or an input frame's; unset where it ends the whole stream
        journal: _.Transaction, // set only where the input frame gave no frame
      }),
      (_: any) => _.OfItem.name("References.OfItem").branches([ // an item of a frame stream
        (t: any) => t.name("frame").schema([_.OfFrame]),
        (t: any) => t.name("end").schema([_.OfEnd]),
      ]),
    ])]))]);
}

/** Calls `observer` with a `Changes.Journal` of each transaction of `store` that commits having changed something,
 * that one transaction; returns a function that ends it. */
export function observe(store: any, observer: (journal: any) => void): () => void {
  store._observers.push(observer);
  return () => {
    const at = store._observers.indexOf(observer);
    if (at >= 0) store._observers.splice(at, 1);
  };
}

/** Writes each transaction of `journal`, a `Changes.Journal`, in order, within the transaction `txn` builds: each one
 * upsert, its symbols its own, chained, so that what one makes the next finds; gives `txn`, as an install does:
 * `store.transaction((txn) => Changes.apply(txn, journal))`. */
export function apply(txn: any, journal: unknown): any {
  const [store] = Builders._transaction_of(txn);
  let term: Spec | null = null;
  for (const [i, transaction] of [..._transactions(journal).entries()].reverse()) {
    term = upsert(store, transaction, `t${i}_`, term);
  }
  return term === null ? txn : txn.mutations([term]);
}

type Spec = (builder: any) => any;
type PlainMap = Map<string, any>;

// --- Reading a `Changes` value through the visitors ---

/** Whether a value object's visitor visits one: a visitor of nothing has no schema. */
function present(visitor: any): boolean {
  return visitor.as_schema() !== null;
}

/** A journal's transactions, in order, each as its visitor. */
export function _transactions(journal: any): any[] {
  const found: any[] = [];
  journal.as_entries((it: Iterator<[unknown, any]>) => { found.push(...{ [Symbol.iterator]: () => it }); });
  return found.map(([, element]) => object(element));
}

/** The visitor of the value a member holds (`Visitors.OfAny`), or an element, as it is one. */
function visited(member: any): any {
  if (!(member instanceof Proxies._internals._Property)) return member;
  let found: any = null;
  member.as_value((a: any) => { found = a; return a; });
  return found;
}

/** The elements of the container a member holds, each with its index, in order; none where it holds none. */
function items(member: any): [any, any][] {
  const found: [any, any][] = [];
  visited(member).as_container((c: any) => {
    c.as_entries((it: Iterator<[unknown, any]>) => { found.push(...{ [Symbol.iterator]: () => it }); });
    return c;
  });
  return found;
}

/** The value object a member or an element holds, as its visitor; null where it holds none. */
function object(member: any): any {
  let found: any = null;
  visited(member).as_object((o: any) => { found = o; return o; });
  return present(found) ? found : null;
}

/** The union value a member or an element holds, as its visitor. */
function union(member: any): any {
  let found: any = null;
  visited(member).as_union((u: any) => { found = u; return u; });
  return found;
}

/** The branch a union value holds, by name, and what it holds: a scalar, or a value object's visitor. */
function branch(value: any): [string, any] {
  const schema = value.as_schema();
  for (const member of schema === null ? [] : schema.branches as any[]) {
    const held = value[member.name];
    const scalar = Proxies._deref(member.schema) instanceof Schemas.OfScalar.Data;
    const found = scalar ? held.get() : held;
    if (scalar ? found !== null : present(found)) return [member.name, found];
  }
  throw new ValueError("a union of the journal language holds one of its branches, and one here holds none");
}

/** The value a payload holds, a member's or an element's: a scalar, a parameter reference in its place, or the visitor
 * of a value object, a union's, an intersection's or a container's value. */
function payload(member: any): unknown {
  const found: unknown[] = [];
  const read = (a: any): any => {
    a.as_parameter((p: any) => { if (present(p)) found.push(p); return p; });
    a.as_scalar((s: any) => { if (s.get() !== null) found.push(s.get()); return s; });
    for (const select of ["as_object", "as_union", "as_intersection", "as_container"]) {
      a[select]((v: any) => { if (present(v)) found.push(v); return v; });
    }
    return a;
  };
  read(visited(member));
  return found[0];
}

/** The path of an object's reference, or a schema object's, as plain data, as `Plain` writes it. */
function pathOf(store: any, reference: any): Plain.PlainData {
  return (Plain.ToPlain(store)(reference.as_schema(), reference) as PlainMap).get("path");
}

/** The schema a schema object's reference (`References.OfSchema`) designates in `store`. */
function schemaOfReference(store: any, reference: any): any {
  return Plain._by_path(store, pathOf(store, reference), []);
}

/** Plain data written with its keys in order, at each level, so that two values alike are written alike. */
function canonical(plain: unknown): unknown {
  if (Array.isArray(plain)) return plain.map(canonical);
  if (!(plain instanceof Map)) return plain;
  return new Map([...plain].sort(([a], [b]) => compareStrings(a, b)).map(([k, v]) => [k, canonical(v)]));
}

// --- Applying: a `Changes.Transaction` as the mutation transaction that makes its changes ---

/** A `Changes.Transaction` as the upsert that makes its changes, a term's Spec, built through the builders: under its
 * id, of its symbols, each named with `prefix` before its name, of an object held named by its reference, and of each
 * counted object written inline, one symbol for each value, bound to its schema, whose values the spec writes after its
 * changes, so that it is found by its value, or made; `then`, where given, the term after it. */
function upsert(store: any, transaction: any, prefix: string, then: Spec | null): Spec {
  const uid = transaction.id.get();
  const symbols = new Map<string, unknown>();
  for (const [name, element] of items(transaction.symbols)) {
    const symbol = object(element);
    const reference = object(symbol.reference);
    symbols.set(prefix + name, reference !== null ? reference : schemaOfReference(store, object(symbol.schema)));
  }
  const inline = new Map<string, string>(); // each symbol bound to an object named inline, by what names it
  const values: Spec[] = [];
  /** The symbol an object named inline is bound to, one for each reference or value, declared where first named. */
  const bound = (key: string, kind: string, to: unknown): string => {
    if (!inline.has(key)) {
      let n = inline.size;
      while (symbols.has(`${prefix}${kind}${n}`)) n += 1;
      inline.set(key, `${prefix}${kind}${n}`);
      symbols.set(inline.get(key)!, to);
    }
    return inline.get(key)!;
  };
  /** What an entry change's link names, as a spec links it: a symbol's object, or a parameter reference, which names
   * no object whose adjacency writes the entry, as its holder must. */
  const named = (link: any, holder = false): Spec => {
    const [kind, held] = branch(union(link));
    if (kind === "parameter" && holder) {
      throw new ValueError("an entry change is written on an object's adjacency: its holder names an object");
    }
    if (kind === "parameter") return () => held;
    let name: string;
    if (kind === "symbol") name = prefix + held;
    else if (kind === "reference") {
      name = bound(Json.dumps(canonical(["r", pathOf(store, held)]) as Plain.PlainData), "r", held);
    } else {
      const schema = schemaOfReference(store, object(held.schema));
      const given = new Map(items(held.properties).map(([n, v]) => [n as string, payload(v)]));
      const key = Json.dumps(canonical(["c", store.name_of(schema), new Map([...given].map(([n, v]) =>
        [n, Plain.ToPlain(store)(schema.properties.get(n).schema, v)]))]) as Plain.PlainData);
      const fresh = !inline.has(key);
      name = bound(key, "c", schema);
      if (fresh) for (const [n, v] of given) values.push((_: any) => _[name][n](v));
    }
    return (_: any) => _[name];
  };
  const spec: Spec[] = [];
  for (const [, element] of items(transaction.changes)) {
    const [kind, change] = branch(union(element));
    const [verb, body] = branch(change);
    if (kind === "property") {
      const [s, n, v] = [prefix + body.holder.get(), body.name.get(), verb === "set" ? payload(body.value) : null];
      spec.push((_: any) => _[s][n](v));
      continue;
    }
    const holder = named(body.holder, true);
    const links = new Map(items(body.links).map(([n, link]) => [n as string, named(link)]));
    const properties = new Map(items(body.properties).map(([n, v]) => [n as string, payload(v)]));
    const fill = (entry: any, _: any): any => {
      let e = entry;
      for (const [n, link] of links) e = e[n](link(_));
      for (const [n, v] of properties) e = e[n](v);
      return e;
    };
    const adjacency = body.adjacency.get();
    spec.push((_: any) => holder(_)[adjacency]((adv: any) => adv[verb]((e: any) => fill(e, _))));
  }
  const pattern = (p: any): any => p.symbols(Object.fromEntries(symbols)).spec([...spec, ...values]);
  return (mu: any) => mu.upsert((u: any) => {
    const exists = (uid === null ? u : u.key(uid)).exists([pattern]);
    return then === null ? exists : exists.then([then]);
  });
}

/** A `Changes.Transaction` of `store`'s as the mutation transaction that makes its changes, one upsert under its id,
 * built through the builders outside the transaction open's proposals, as any expression is. */
export function _expression(store: any, transaction: any): any {
  const uid = transaction.id.get();
  return _as_committed(store, () => store.Mutations.OfTransaction((t: any) => (uid === null ? t : t.uid(uid))
    .mutations([upsert(store, transaction, "", null)])));
}

// --- Gathering: what a transaction changed, as a `Changes.Transaction`, built through the builders ---

/** Reads what the store held before `proposals`: their base, the transaction open's where they are a savepoint's, else
 * what it holds as committed. */
export function _before<T>(store: any, proposals: Proposals.OfStore, read: () => T): T {
  const held = store._proposals;
  store._proposals = "entries_" in (proposals.base as object) ? proposals.base : null;
  try {
    return read();
  } finally {
    store._proposals = held;
  }
}

/** Reads what the store holds as committed, while a transaction is open: its state before the transaction. */
export function _as_committed<T>(store: any, read: () => T): T {
  const proposals = store._proposals;
  store._proposals = null;
  try {
    return read();
  } finally {
    store._proposals = proposals;
  }
}

function schemaOf(x: unknown): any {
  return (Proxies._innerOf(x) as any)._schema;
}

/** What an object the transaction changed is held by: a proxy's state. */
function held(x: unknown): unknown {
  return Proxies._innerOf(x);
}

/** A property's value, as plain, as its schema writes it, to compare, and as the value itself; each null where the
 * object holds none. */
function value(store: any, holder: unknown, name: string): [unknown, unknown] {
  const found = store.member(holder, name);
  if (found === null || found === undefined) return [null, null];
  const durable = Proxies._durable(found);
  if (Proxies._is_parameter(durable)) return [Plain._marked(store, found), durable]; // in its place (CAP-312)
  return [Plain.ToPlain(store)(schemaOf(holder).properties.get(name).schema, found), durable];
}

function same(a: unknown, b: unknown): boolean {
  return Json.dumps((a ?? null) as Plain.PlainData) === Json.dumps((b ?? null) as Plain.PlainData);
}

/** Whether an entry links data alone, objects or parameter references in their place: one that links a schema object,
 * an extension's, is no data (CAP-315), nor one that links an expression's term, of a schema the store was made holding
 * (`Mutations`), and either is left out of what a transaction changed. */
function data(store: any, entry: unknown): boolean {
  return [...((Proxies._innerOf(entry) as any)._links as Map<string, unknown>).values()].every((x) =>
    (Proxies._isObjectData(x) && !store.framework(schemaOf(x))) || Proxies._is_parameter(x));
}

/** What the transaction whose proposals these are changed, gathered just before it commits, as a `Changes.Transaction`
 * of id `uid`, a value that outlives the transaction; null where it changed nothing: a store in memory's, its net
 * changes read from its proposals, then gathered by `gather`, as every layer's are. */
export function _gather(store: any, proposals: Proposals.OfStore, uid: string): any {
  const base = proposals.base;
  const removed = new Map<string, any>();
  const inserted = new Map<string, any>();
  const ids = new Map<unknown, number>();
  const id = (x: unknown): number => {
    if (!ids.has(x)) ids.set(x, ids.size);
    return ids.get(x) as number;
  };
  for (const [holder, tables] of proposals.entries_) { // an object's tables, copied whole when first written
    if (!(holder instanceof Proxies._internals._ObjectData)) continue; // a schema object's: no data (CAP-315)
    const before = base.entries(holder) as Map<unknown, Map<unknown, unknown>>;
    for (const [relation, table] of tables as Map<unknown, Map<unknown, unknown>>) {
      const old = before.get(relation) ?? new Map();
      for (const [k, entry] of table) if (!old.has(k) && data(store, entry)) inserted.set(`${id(relation)}:${String(k)}`, entry);
      for (const [k, entry] of old) if (!table.has(k) && data(store, entry)) removed.set(`${id(relation)}:${String(k)}`, entry);
    }
  }
  const made = [...proposals.created].filter((x) => Proxies._isObjectData(x));
  const madeStates = new Set(made.map((x) => Proxies._innerOf(x)));
  const deleted = new Map<unknown, unknown>(); // each object, by its state
  for (const entry of removed.values()) {
    for (const x of (Proxies._innerOf(entry) as any)._links.values() as Iterable<unknown>) {
      if ((Proxies._isObjectData(x) && !madeStates.has(Proxies._innerOf(x))
          && Proxies._owner_adjacencies(schemaOf(x)).length > 0 && Proxies._owner_entries(x).length === 0)) {
        deleted.set(held(x), x);
      }
    }
  }
  const changed: [unknown, string][] = [];
  for (const [state, values] of proposals.values_) {
    // a value object's, read with the object holding it; or a deleted object's, which goes
    if (!(state instanceof Proxies._internals._ObjectData) || deleted.has(state) || store.framework((state as any)._schema)) continue;
    const holder = (state as any)._proxy; // proposals hold an object's data: read it through its proxy
    const names = [...new Set([...(base.values(state) as Map<string, unknown>).keys(), ...(values as Map<string, unknown>).keys()])];
    const after = new Map(names.map((name) => [name, value(store, holder, name)[0]]));
    const before = _before(store, proposals, () => new Map(names.map((name) =>
      [name, madeStates.has(state) ? null : value(store, holder, name)[0]])));
    for (const name of names) if (!same(before.get(name), after.get(name))) changed.push([holder, name]);
  }
  const relationOf = (entry: unknown): [any, unknown] => [(Proxies._innerOf(entry) as any)._relation, entry];
  return gather(new Transactions.InMemory(store), uid, made, [...deleted.values()], [...removed.values()].map(relationOf),
    [...inserted.values()].map(relationOf), changed,
    (x) => _before(store, proposals, () => pathOf(store, References.of(store, x))));
}

/** What a transaction, or a savepoint of it, changed, as a `Changes.Transaction` of id `uid`, a value of the store whose
 * schemas `interpreter` reads by (`interpreter.store`), that outlives the transaction; null where it changed nothing.
 * Every layer's journal is gathered by it, a store in memory's (`Transactions.InMemory`) and any other's, the layer
 * giving what it changed, net, of its own objects and entries, as its interpreter's hooks give them, and read through
 * them alone (`schema_of`, `value`, `link`, `linking`):
 *
 * - `made`: the objects it created that are held after it;
 * - `deleted`: the objects held before it that it deleted;
 * - `removed`, `inserted`: the entries held before it that it removed, and those it inserted that are held after it,
 *   each with its relation, `[relation, entry]`; an entry linking a schema object, or an expression's term, is no data,
 *   and is left out by the layer;
 * - `changed`: the properties whose values it changed, each `[holder, name]`, of an object held after it; the value
 *   after is read through the interpreter;
 * - `held(x)`: the path of an object held before it, as it was then, as plain data.
 *
 * Its symbols: each object it names that was held before, by its reference as it was, its schema too where its path does
 * not imply it (`References.implied`), and each object it made, by its schema, after its owner's. Its changes: for each
 * object deleted, the entry that owned it, removed by its owner's key for it; the entries it removed, then those it
 * inserted, each written on the adjacency of an object it links, one held before and not counted where one can; then
 * the properties it changed, each set to its value or cleared. A counted object is named by its value, a parameter
 * reference in an object's place as itself (CAP-312). */
export function gather(interpreter: any, uid: string, made: Iterable<unknown>, deleted: Iterable<unknown>,
  removed: Iterable<[any, unknown]>, inserted: Iterable<[any, unknown]>, changed: Iterable<[unknown, string]>,
  held: (x: unknown) => Plain.PlainData): any {
  const store = interpreter.store;
  const keyOf = (x: unknown): string => JSON.stringify(Proxies._link_key(x));
  const madeKeys = new Set([...made].map(keyOf));
  const deletedKeys = new Set([...deleted].map(keyOf));
  const [removing, inserting, changing] = [[...removed], [...inserted], [...changed]];
  if (removing.length === 0 && inserting.length === 0 && changing.length === 0) return null;
  const symbols = new Map<string, unknown>(); // each a `Changes.Symbol`, as plain data, in the order first named
  const named = new Map<string, string>(); // by the object
  const schemaReference = (schema: any): PlainMap => {
    const path: any = Paths.of(schema);
    return new Map([["path", Plain.ToPlain(store)(path.as_schema(), path)]]);
  };
  /** The objects that own `x`, through each entry that owns it. */
  const owners = (x: unknown, schema: any): unknown[] => {
    const found: unknown[] = [];
    for (const adjacency of Proxies._owner_adjacencies(schema) as any[]) {
      for (const entry of interpreter.linking(x, adjacency.relation)) {
        if (interpreter.link(entry, adjacency.me) !== x) continue;
        for (const link of adjacency.relation.entry.links.keys()) {
          const other = link === adjacency.me ? null : interpreter.link(entry, link);
          if (other !== null) found.push(other);
        }
      }
    }
    return found;
  };
  /** The symbol of an object the transaction changed, declared where first needed: a created owned object's after its
   * owner's. */
  const symbol = (x: unknown): string => {
    const found = named.get(keyOf(x));
    if (found !== undefined) return found;
    const schema = interpreter.schema_of(x);
    let spec: PlainMap;
    if (madeKeys.has(keyOf(x))) {
      for (const owner of owners(x, schema)) symbol(owner);
      spec = new Map([["schema", schemaReference(schema)]]);
    } else {
      const path = held(x);
      spec = new Map([["reference", new Map([["path", path]])]]);
      let implied: unknown = null;
      try {
        implied = References.implied(store, path);
      } catch { // a path no one schema is implied by: a LookupError
        implied = null;
      }
      if (schema !== implied) spec.set("schema", schemaReference(schema));
    }
    const name = `o${named.size}`;
    named.set(keyOf(x), name);
    symbols.set(name, spec);
    return name;
  };
  /** The values a holder, an object or an entry, holds of the properties `schema` declares, as plain data. */
  const values = (holder: unknown, schema: any): PlainMap => {
    const found: PlainMap = new Map();
    for (const name of schema.properties.keys()) {
      const [present, plain] = interpreter.value(holder, schema, name);
      if (present) found.set(name, plain);
    }
    return found;
  };
  /** What an entry change names an object by, a `Changes.OfLink`: a parameter reference, as itself (CAP-312); a counted
   * object, by its value, which it never changes; else its symbol. */
  const link = (x: unknown): PlainMap => {
    if (Proxies._is_parameter(x)) {
      const durable = Proxies._durable(x);
      return new Map([["parameter", Plain.ToPlain(store)(durable.as_schema(), durable)]]);
    }
    const schema = interpreter.schema_of(x);
    if (Proxies._counted_schema(schema)) {
      return new Map([["counted", new Map<string, unknown>([["schema", schemaReference(schema)],
        ["properties", values(x, schema)]])]]);
    }
    return new Map([["symbol", symbol(x)]]);
  };
  const changes: PlainMap[] = [];
  const entryChange = (verb: string, holder: PlainMap, adjacency: string, links: PlainMap, properties: PlainMap): void => {
    const body: PlainMap = new Map<string, unknown>([["holder", holder], ["adjacency", adjacency]]);
    if (links.size > 0) body.set("links", links);
    if (properties.size > 0) body.set("properties", properties);
    changes.push(new Map([["entry", new Map([[verb, body]])]]));
  };
  const linked = (relation: any, entry: unknown): Map<string, unknown> =>
    new Map([...relation.entry.links.keys()].map((name: string) => [name, interpreter.link(entry, name)]));
  for (const [relation, entry] of removing) { // a deleted object's: its owning entry, by its key; the rest follows from that
    const links = linked(relation, entry);
    const lost = [...links].filter(([, x]) => deletedKeys.has(keyOf(x))).map(([name]) => name);
    const owned = owning(interpreter, relation, links, lost);
    if (owned !== null) {
      const [adjacency, me] = owned;
      const keys = values(entry, relation.entry);
      entryChange("remove", link(links.get(me)), adjacency, new Map(), new Map(Proxies._key_names(relation, me, lost[0]!)
        .filter((k: string) => keys.has(k)).map((k: string) => [k, keys.get(k)] as [string, unknown])));
    }
  }
  const kept = removing.filter(([relation, entry]) => ![...linked(relation, entry).values()]
    .some((x) => deletedKeys.has(keyOf(x))));
  for (const [verb, entries] of [["remove", kept], ["insert", inserting]] as const) {
    for (const [relation, entry] of entries) {
      const links = linked(relation, entry);
      const [writes, adjacency] = writer(interpreter, relation, links, madeKeys);
      const others: PlainMap = new Map();
      for (const [other, x] of links) if (other !== writes) others.set(other, link(x));
      entryChange(verb, link(links.get(writes)), adjacency, others, values(entry, relation.entry));
    }
  }
  for (const [holder, name] of changing) {
    const schema = interpreter.schema_of(holder);
    if (Proxies._counted_schema(schema)) continue; // found by its value, which it never changes
    const s = symbol(holder);
    const [present, plain] = interpreter.value(holder, schema, name);
    changes.push(new Map([["property", present
      ? new Map([["set", new Map<string, unknown>([["holder", s], ["name", name], ["value", plain]])]])
      : new Map([["clear", new Map([["holder", s], ["name", name]])]])]]));
  }
  const plain = new Map<string, unknown>([["id", uid], ["symbols", symbols], ["changes", changes]]);
  return Plain.FromPlain(store)(store.registered("Changes.Transaction"), plain as Plain.PlainData);
}

/** The link, and its object's adjacency by name, that writes an entry: preferably an object held before, not counted,
 * so that what the entry links is found through it. */
function writer(interpreter: any, relation: any, links: Map<string, unknown>, made: Set<string>): [string, string] {
  const choices: [number, string, string][] = []; // ranked: held before, counted or made
  for (const [link, x] of links) {
    if (Proxies._is_parameter(x)) continue;
    const schema = interpreter.schema_of(x);
    for (const [name, adjacency] of schema.adjacencies as Map<string, any>) {
      if (adjacency.relation === relation && adjacency.me === link) {
        choices.push([Proxies._counted_schema(schema) || made.has(JSON.stringify(Proxies._link_key(x))) ? 1 : 0, link,
          name]);
      }
    }
  }
  if (choices.length === 0) {
    throw new ValueError(`no object an entry of '${relation.name}' links has an adjacency to it by name, so that `
      + "its change cannot be written: name one");
  }
  const [, link, name] = choices.reduce((best, choice) => (choice[0] < best[0] ? choice : best));
  return [link, name];
}

/** Where an entry of `relation` linking `links` owns the one deleted object it links, through `lost`, and its owner
 * survives: the owner's adjacency by name that writes it, and the owner's link; else null. */
function owning(interpreter: any, relation: any, links: Map<string, unknown>, lost: string[]): [string, string] | null {
  if (lost.length !== 1) return null;
  const x = links.get(lost[0]!);
  const owns = Proxies._owner_adjacencies(interpreter.schema_of(x)).some((a: any) => a.relation === relation
    && a.me === lost[0]);
  if (!owns) return null;
  const [me] = [...links.keys()].filter((link) => link !== lost[0]) as [string];
  const names = [...(interpreter.schema_of(links.get(me)).adjacencies as Map<string, any>)]
    .filter(([, a]) => a.relation === relation && a.me === me).map(([name]) => name);
  if (names.length === 0) {
    throw new ValueError(`no owner of an entry of '${relation.name}' has an adjacency to it by name, so that `
      + "its change cannot remove what the entry owned: name one");
  }
  return [names[0]!, me];
}

/** A `Changes.Journal` of `store`'s of these transactions, in order, built through the builders: a value that outlives
 * them. */
export function _journal(store: any, transactions: any[]): any {
  return store.Changes.Journal((j: any) => {
    for (const [i, transaction] of transactions.entries()) j.at(BigInt(i)).as_object(transaction);
    return j;
  });
}

// --- A cache layer: a layer below's changes, to the objects it holds alone ---

/** What an entry change's link names: its kind; its symbol, where it is one; the object present it names, where any;
 * and its schema, where known. */
type Named = [string, string | null, unknown, any];

/** A `Changes.Transaction` of the layer below's, read in `store`, made to change only the objects present in it
 * ([CAP-285: writes through, others' writes in](mbse:mbse-basis/docs/capabilities/README.md#CAP-285), its second decision): each object is named by its path, an object it created by its owner's
 * and its owning entry's keys, and is present where the store holds it, or where it was created owned by one present,
 * which applying it creates; a counted object is found by its value, or made. A property of an object present is set;
 * an entry is written where every object it names is present, and left out otherwise, nothing being made that is not
 * present. Gives that transaction, built through the builders, null where it changes nothing present; and the objects
 * present an entry left out names, whose entries the store no longer holds all of (`_complete`). */
export function _present_only(store: any, transaction: any): [any, unknown[]] {
  const symbols = new Map(items(transaction.symbols).map(([name, element]) => [name as string, object(element)]));
  const schemas = new Map<string, any>(); // each symbol's schema: one created's, or an object present's
  const present = new Set<string>();
  const presentBy = new Map<string, unknown>();
  for (const [name, symbol] of symbols) {
    const reference = object(symbol.reference);
    if (reference === null) {
      schemas.set(name, schemaOfReference(store, object(symbol.schema)));
      continue;
    }
    const x = store._present(pathOf(store, reference));
    if (Proxies._isObjectData(x)) {
      present.add(name);
      presentBy.set(name, Proxies._innerOf(x));
      schemas.set(name, schemaOf(x));
    }
  }
  const at = (link: any): Named => {
    const [kind, given] = branch(union(link));
    if (kind === "symbol") return [kind, given, presentBy.get(given) ?? null, schemas.get(given) ?? null];
    if (kind === "reference") {
      const x = store._present(pathOf(store, given));
      return Proxies._isObjectData(x) ? [kind, null, Proxies._innerOf(x), schemaOf(x)] : [kind, null, null, null];
    }
    return [kind, null, null, kind === "counted" ? schemaOfReference(store, object(given.schema)) : null];
  };
  /** Whether a link names an object present: a symbol present, an object held by its reference, or a counted object,
   * found by its value or made; a parameter reference names none, and is kept. */
  const known = ([kind, name, x]: Named): boolean =>
    kind === "symbol" ? present.has(name!) : x !== null || kind !== "reference";
  const changes: [any, string, string, any, string | null, Map<string, Named>][] = []; // its value, kind, action, holder,
  for (const [, element] of items(transaction.changes)) { // adjacency and links
    const value = union(element);
    const [kind, change] = branch(value);
    const [verb, body] = branch(change);
    if (kind === "property") {
      changes.push([value, kind, verb, body.holder.get(), null, new Map()]);
      continue;
    }
    changes.push([value, kind, verb, at(body.holder), body.adjacency.get(),
      new Map(items(body.links).map(([name, link]) => [name as string, at(link)]))]);
  }
  /** Whether an entry the transaction inserts owns the object it created a symbol names, written on the adjacency of an
   * object present. */
  const owned = (name: string): boolean => changes.some(([, kind, verb, holder, adjacency, links]) => {
    if (kind !== "entry" || verb !== "insert" || holder[3] === null || !known(holder)) return false;
    const relation = holder[3].adjacencies.get(adjacency).relation;
    const symbolsOf = new Map([...links].map(([link, [, symbol]]) => [link, symbol]));
    return Proxies._owner_adjacencies(schemas.get(name)).some((a: any) => a.relation === relation && symbolsOf.get(a.me) === name);
  });
  const created = [...symbols].filter(([, symbol]) => object(symbol.reference) === null).map(([name]) => name);
  let grown = true;
  while (grown) { // an object created owned by one present: present once applied
    grown = false;
    for (const name of created) {
      if (!present.has(name) && owned(name)) {
        present.add(name);
        grown = true;
      }
    }
  }
  const kept: any[] = [];
  const lost: unknown[] = [];
  const used = new Set<string>(); // the symbols what is kept names
  for (const [value, kind, , holder, , links] of changes) {
    if (kind === "property") {
      if (present.has(holder)) {
        kept.push(value);
        used.add(holder);
      }
      continue;
    }
    const named: Named[] = [holder, ...links.values()];
    if (named.every(known)) {
      kept.push(value);
      for (const [, name] of named) if (name !== null) used.add(name);
    } else lost.push(...named.filter(([, , x]) => x !== null).map(([, , x]) => x)); // it names one not present: left
  } // out, and each present it names holds its entries no more all
  if (kept.length === 0) return [null, lost];
  const uid = transaction.id.get();
  return [store.Changes.Transaction((t: any) => (uid === null ? t : t.id(uid))
    .symbols(Object.fromEntries([...symbols].filter(([name]) => used.has(name)))).changes(kept)), lost];
}

// --- What a payload is interpreted by, as `Plain` writes and reads a journal (`Plain.AT`) ---

/** What the member `member` of a value of `schema` is within, the value being within `at`, given its members written
 * or read before it, `siblings`: a transaction's changes, within its symbols; a payload in them, within the schema of
 * the property it is the value of. Null where nothing says, or where what it says names no schema the store holds, so
 * that the payload is written, or refused, as any value of any schema is. */
export function _within(store: any, schema: any, at: any, member: string, siblings: PlainMap): any {
  const name = schema.name;
  if (name === "Changes.Transaction") return member === "changes" ? new Symbols(store, siblings.get("symbols")) : null;
  if (at === null) return null;
  try {
    return at.member(name, member, siblings);
  } catch { // what it says names no schema the store holds: a missing member, an unknown name, a path not implied
    return null;
  }
}

/** What a value is within, as `Plain` writes and reads it: what its members and elements are within, and the schema a
 * payload is interpreted by, where it is one. */
class At {
  payload: any = null;

  element(_index: unknown): any {
    return this;
  }
}

/** The unions of a transaction's changes, and of what an entry change names: each branch within what the union is. */
const UNIONS = new Set(["Changes.Change", "Changes.OfEntry", "Changes.OfProperty", "Changes.OfLink"]);

const ENTRIES = new Set(["Changes.OfEntry.Insert", "Changes.OfEntry.Remove"]);

/** A transaction's changes: within its symbols, each bound to the schema of the object it names. */
class Symbols extends At {
  readonly symbols: PlainMap;

  constructor(readonly store: any, symbols: unknown) {
    super();
    this.symbols = new Map(symbols as PlainMap);
  }

  /** The schema of the object a symbol names: the one it is given, else, one held before's, as its path implies. */
  schema(symbol: string): any {
    const bound = this.symbols.get(symbol);
    if (bound.has("schema")) return Plain._by_path(this.store, bound.get("schema").get("path"), []);
    return References.implied(this.store, bound.get("reference").get("path"));
  }

  /** The schema of the object an entry change names: a symbol's, an object's held by its reference, as the store holds
   * it or its path implies it, or a counted object's, inline. */
  linked(link: PlainMap): any {
    const [[kind, given]] = [...link] as [[string, any]];
    if (kind === "symbol") return this.schema(given);
    if (kind === "counted") return Plain._by_path(this.store, given.get("schema").get("path"), []);
    const found = this.store._present(given.get("path"));
    return Proxies._isObjectData(found) ? schemaOf(found) : References.implied(this.store, given.get("path"));
  }

  member(schema: string, member: string, siblings: PlainMap): any {
    if (UNIONS.has(schema) || (ENTRIES.has(schema) && (member === "holder" || member === "links"))) return this;
    if (schema === "Changes.OfProperty.Set" && member === "value") {
      return new Value(this.schema(siblings.get("holder")).properties.get(siblings.get("name")).schema);
    }
    if (ENTRIES.has(schema) && member === "properties") {
      return new Properties(this.linked(siblings.get("holder")).adjacencies.get(siblings.get("adjacency")).relation.entry);
    }
    if (schema === "Changes.Counted" && member === "properties") {
      return new Properties(Plain._by_path(this.store, siblings.get("schema").get("path"), []));
    }
    return null;
  }
}

/** The properties of an entry, or of a counted object, each within its schema: a container, whose elements are within,
 * not its members. */
class Properties extends At {
  constructor(readonly schema: any) {
    super();
  }

  override element(index: unknown): any {
    const found = this.schema.properties.get(index);
    return found === undefined ? null : new Value(found.schema);
  }
}

/** A property's value, a payload: interpreted by the property's schema. */
class Value extends At {
  constructor(schema: any) {
    super();
    this.payload = Proxies._deref(schema);
  }
}
