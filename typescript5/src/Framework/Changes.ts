/**
 * Changes: a transaction's effect, observed at its commit, written as a journal
 * ([CAP-270: a transaction's changes observed at its commit](mbse:mbse-basis/docs/capabilities/README.md#CAP-270),
 * [CAP-269: transactions resolved into their effects](mbse:mbse-basis/docs/capabilities/README.md#CAP-269),
 * [CAP-271: the journal language](mbse:mbse-basis/docs/capabilities/README.md#CAP-271),
 * [the journals proposal](mbse:mbse-basis/proposals/JOURNALS.md#the-changes-schemas-proposed)).
 *
 * The journal language's value schemas, which every store holds, its own, as it holds `References` (`install`):
 *
 * - `Changes.Journal`, a journal: its transactions, in order, a container of `Changes.Transaction` by position. A
 *   journal is data: built, sliced, written, read and compared as any value is, with no store of its own; its
 *   transactions are read by iterating it. Whole transactions taken from a journal, in order, are a journal too.
 * - `Changes.Transaction`, one transaction: its `id`, unique, the uid `Provenance` records it by; its `symbols`, each by
 *   its name (`Changes.Symbol`), the transaction's own; then its `changes`, in order, each a `Changes.Change`.
 * - `Changes.Symbol`, an object that exists (A): an object held before, by its `reference` (`References.OfObject`), or
 *   a new object, by its `schema`'s reference alone, an object reference from the singleton `"."`; an object held
 *   before is given its `schema` too where its path does not imply it, as where objects of several schemas are owned
 *   through one relation, so that a reader never guesses it.
 * - `Changes.Change`, a change: a relation entry's (`entry`, `Changes.OfEntry`) or a property's (`property`,
 *   `Changes.OfProperty`).
 * - `Changes.OfEntry`, a relation entry inserted or removed (B): written on its `holder`'s adjacency named `adjacency`,
 *   its `verb`, `insert` or `remove`, its other `links`, each by its name, and its `properties`' values. A link is set
 *   as a spec sets one (`Mutations.OfLink.Set`): to a symbol, `{"reference": {"symbol": "o0"}}`, or, a counted object,
 *   to its value, inline, `{"def": {"schema": ..., "mutations": [...]}}`, never bound to a symbol: an immutable object,
 *   found by its value, or made; the holder too, where only the counted object has an adjacency to the entry by name.
 * - `Changes.OfProperty`, a property mutated (C): its `holder`'s symbol, the property's `name`, and its `mutations`,
 *   mbse-schemas' verbs (`Mutations.OfProperty`): `set` and `clear`, and, nested, the verbs of the value's kind.
 *
 * A value, a property's in a change or an entry's, is a payload (`Mutations.Payload`), written by the schema of the
 * property it is the value of, as a recorded spec writes it, marked with its schema only where that schema cannot tell
 * it ([PRI-025: never guess the schema](mbse:mbse-basis/docs/PRINCIPLES.md#PRI-025)): the plain form reads a
 * transaction's symbols first, and each payload by the schema its holder's schema gives the property (`_within`), so
 * that it is read where the store holds the schemas the journal's objects are of.
 *
 * `observe(store, observer)` calls `observer(journal)` after each transaction of `store` that commits having changed
 * something, a `Changes.Journal` of that one transaction, a value that outlives it; and returns a function that ends the
 * observing; a transaction that throws, its writes dropped, is observed by none. What it changed is net of what it
 * undid within itself: its symbols, each object the transaction touched that was held before it, by its reference as
 * it was, and each owned object it created, by its schema, after its owner's, so that applying finds it by its
 * ownership entry; then its changes, the relation entries it removed, then those it inserted, each written on the
 * adjacency of one object it links, then the properties it changed, each set to its value or cleared. An object the
 * transaction deleted is never named: the entry that owned it is removed by its owner's key for it, written on its
 * owner's adjacency, and what its deletion removed in cascade, every entry linking it and what it owned, is left to
 * follow from that, as it does in every store that applies the journal. `store.follow(follower)` gives the same journal
 * as plain data.
 *
 * `apply(txn, journal)` writes, within the transaction `txn` builds, each transaction of a journal, in order: applied
 * to the store as it was before them, it makes the same changes, and applied again, it changes nothing. A
 * transaction's changes are applied as one upsert, of its symbols, each counted object inline bound to a symbol of its
 * own, one per value, whose spec writes its changes where they do not hold.
 *
 * The changes are gathered from the transaction's proposals just before it commits, after `Provenance` records it and
 * its ownership is settled, so that what it deleted in cascade, and every entry linking it, is among them; what an
 * object is before is read from what the store holds as committed. They are written outside the transaction's
 * proposals, since writing them builds: once the transaction has committed, for its observers, and, for the store
 * below a store, just before, with its proposals set aside, as plain data (CAP-285). What a store sends the store
 * below, and what the store below gives back it committed, is a mutation transaction, the store-to-store protocol's
 * language, not a journal: the transaction's effect as one upsert (`_effect`). A store given a store below gives its
 * observers, for a transaction of its own, the journal of what the store below gave back it committed, what the store
 * below added to it, as its record, among it, so that each store of a stack gives the same one; changes name an object
 * not present by its path, loading nothing. What the store below reports to its followers, a journal, a store above
 * applies to the objects present in it (`Builders.Store._arrive`).
 */

import * as Builders from "./Builders.js";
import { ValueError } from "./Errors.js";
import * as Json from "./JSON.js";
import * as Plain from "./Plain.js";
import type * as Proposals from "./Proposals.js";
import * as Proxies from "./Proxies.js";
import * as References from "./References.js";
import { compareStrings } from "./Repr.js";

/** The journal language's schemas, defined in the store a transaction writes: `store.transaction(Changes.install)`. A
 * store is made by it, after `References.install` and `Mutations.install`, read by the bootstrap (`Builders`); run
 * again in a store, it finds each by its name and writes nothing. */
export function install(txn: any): any {
  const S = txn.Schemas; // the store's meta-schemas and basic scalars (78)
  const Mu = txn.Mutations;
  return txn.uid("mbse.Schemas.Changes/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ Journal: S.OfContainer, Transaction: S.OfObject, Symbol: S.OfObject, Change: S.OfUnion,
      OfEntry: S.OfObject, OfProperty: S.OfObject })
    .spec([
      (_: any) => _.Journal.name("Changes.Journal").index([S.OfInt]).element([_.Transaction]), // in order
      (_: any) => _.Transaction.name("Changes.Transaction").properties({
        id: S.OfStr, // unique: the uid Provenance records it by
        symbols: S.OfContainer((c: any) => c.index([S.OfStr]).element([_.Symbol])), // by name: its own
        changes: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.Change])), // in order
      }),
      (_: any) => _.Symbol.name("Changes.Symbol").properties({ // A: an object exists
        reference: txn.References.OfObject, // held before
        schema: txn.References.OfObject, // alone, a new one's; else where its path does not imply it
      }),
      (_: any) => _.Change.name("Changes.Change").branches([
        (t: any) => t.name("entry").schema([_.OfEntry]),
        (t: any) => t.name("property").schema([_.OfProperty]),
      ]),
      (_: any) => _.OfEntry.name("Changes.OfEntry").properties({ // B: a relation entry inserted or removed
        holder: Mu["OfLink.Set"], // a symbol, or a counted object inline
        adjacency: S.OfStr, // the holder's, by name
        verb: S.OfStr, // insert or remove
        links: S.OfContainer((c: any) => c.index([S.OfStr]).element([Mu["OfLink.Set"]])),
        properties: S.OfContainer((c: any) => c.index([S.OfStr]).element([Mu.Payload])),
      }),
      (_: any) => _.OfProperty.name("Changes.OfProperty").properties({ // C: a property mutated
        holder: S.OfStr, // a symbol
        name: S.OfStr,
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([Mu.OfProperty])),
      }),
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
  const [store, builder] = Builders._transaction_of(txn);
  const plain = Plain.ToPlain(store)(store.registered("Changes.Journal"), journal) as Plain.PlainData[];
  let term: PlainMap | null = null;
  for (const [i, transaction] of [...plain.entries()].reverse()) {
    const [upsert] = (_effect_of(store, transaction as PlainMap, `t${i}_`) as PlainMap).get("mutations") as PlainMap[];
    if (term !== null) upsert!.get("upsert").set("then", [term]);
    term = upsert!;
  }
  Plain._built(store, builder, store.registered("Mutations.OfTransaction"),
    term === null ? new Map() : new Map([["mutations", [term]]]), []);
  return txn;
}

/** What a transaction changed, gathered before it commits, to be written as its effect once it has: the symbols, by
 * name, each a reference or a schema; each entry removed or inserted, as the symbol whose adjacency writes it, that
 * adjacency, the verb, its other links' symbols and its properties; each property changed, by symbol, as plain. */
export interface _Gathered {
  symbols: Map<string, any>;
  entries: [string, string, string, Map<string, unknown>, Map<string, unknown>][];
  assigned: [string, string, unknown, any][];
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

/** What an object the effect names is held by: a proxy's state; a link to one not present, itself. */
function held(x: unknown): unknown {
  return Proxies._innerOf(x) ?? x;
}

/** A property's value, plain, as its schema writes it; null where the object holds none. */
function value(store: any, holder: unknown, name: string): unknown {
  const held = store.member(holder, name);
  if (held === null || held === undefined) return null;
  return Plain.ToPlain(store)(schemaOf(holder).properties.get(name).schema, held);
}

function same(a: unknown, b: unknown): boolean {
  return Json.dumps((a ?? null) as Plain.PlainData) === Json.dumps((b ?? null) as Plain.PlainData);
}

/** What the transaction whose proposals these are changed, gathered just before it commits; null where nothing. */
export function _gather(store: any, proposals: Proposals.OfStore): _Gathered | null {
  const base = proposals.base;
  const removed = new Map<string, any>();
  const inserted = new Map<string, any>();
  const ids = new Map<unknown, number>();
  const id = (x: unknown): number => {
    if (!ids.has(x)) ids.set(x, ids.size);
    return ids.get(x) as number;
  };
  for (const [holder, tables] of proposals.entries_) { // an object's tables, copied whole when first written
    const before = base.entries(holder) as Map<unknown, Map<unknown, unknown>>;
    for (const [relation, table] of tables as Map<unknown, Map<unknown, unknown>>) {
      const old = before.get(relation) ?? new Map();
      for (const [k, entry] of table) if (!old.has(k)) inserted.set(`${id(relation)}:${String(k)}`, entry);
      for (const [k, entry] of old) if (!table.has(k)) removed.set(`${id(relation)}:${String(k)}`, entry);
    }
  }
  const made = new Set([...proposals.created].filter((x) => Proxies._isObjectData(x)).map((x) => Proxies._innerOf(x)));
  const paths = Proxies._gone_paths(proposals, store); // owned, not present: deleted, with what they own
  const gone = (x: unknown): boolean => {
    if (Proxies._is_parameter(x)) return false; // a parameter reference in an object's place (CAP-312): never deleted
    const path = x instanceof Proxies._Unresolved ? x.path : (Proxies._innerOf(x) as any)._reference;
    return path !== null && paths.some((p) => Plain._under(path, p));
  };
  const deleted = new Set<unknown>(); // each object's state; one not present, its link
  for (const entry of removed.values()) {
    for (const x of (Proxies._innerOf(entry) as any)._links.values() as Iterable<unknown>) {
      if (gone(x) || (Proxies._isObjectData(x) && !made.has(Proxies._innerOf(x))
          && Proxies._owner_adjacencies(schemaOf(x)).length > 0 && Proxies._owner_entries(x).length === 0)) deleted.add(held(x));
    }
  }
  const changed: [unknown, string, unknown][] = [];
  for (const [data, values] of proposals.values_) {
    // a value object's, read with the object holding it; or a deleted object's, which goes
    if (!(data instanceof Proxies._internals._ObjectData) || deleted.has(data)) continue;
    const holder = (data as any)._proxy; // proposals hold an object's data: read it through its proxy
    const names = [...new Set([...(base.values(data) as Map<string, unknown>).keys(), ...(values as Map<string, unknown>).keys()])];
    const after = new Map(names.map((name) => [name, value(store, holder, name)]));
    const before = _as_committed(store, () => new Map(names.map((name) =>
      [name, made.has(data) ? null : value(store, holder, name)])));
    for (const name of names) if (!same(before.get(name), after.get(name))) changed.push([holder, name, after.get(name)]);
  }
  if (removed.size === 0 && inserted.size === 0 && changed.length === 0) return null;
  const gathered: _Gathered = { symbols: new Map(), entries: [], assigned: [] };
  const named = new Map<string, string>(); // by the object, or the path of one not present
  /** The symbol of an object the effect names, declared where first needed: a created owned object's after its
   * owner's. */
  const symbol = (x: unknown): string => {
    const found = named.get(JSON.stringify(Proxies._link_key(x)));
    if (found !== undefined) return found;
    const counted = !(x instanceof Proxies._Unresolved) && Proxies._counted(x);
    let bound: any;
    if (x instanceof Proxies._Unresolved) { // not present: by its path, loading nothing
      bound = _as_committed(store, () => Plain.FromPlain(store)(store.registered("References.OfObject"),
        new Map([["path", x.path as Plain.PlainData]])));
    } else if (counted || made.has(Proxies._innerOf(x))) {
      for (const entry of counted ? [] : Proxies._owner_entries(x)) {
        for (const owner of (Proxies._innerOf(entry) as any)._links.values()) {
          if (Proxies._innerOf(owner) !== Proxies._innerOf(x)) symbol(owner);
        }
      }
      bound = schemaOf(x);
    } else {
      bound = _as_committed(store, () => References.of(store, x));
    }
    const name = `o${named.size}`;
    named.set(JSON.stringify(Proxies._link_key(x)), name);
    gathered.symbols.set(name, bound);
    if (counted) { // found by its value, which it never changes
      for (const [n, p] of schemaOf(x).properties as Map<string, any>) {
        const v = value(store, x, n);
        if (v !== null) gathered.assigned.push([name, n, v, p.schema]);
      }
    }
    return name;
  };
  const lostOf = (state: any): string[] => [...state._links as Map<string, unknown>]
    .filter(([, x]) => deleted.has(held(x))).map(([link]) => link);
  for (const entry of removed.values()) { // a deleted object's: its owning entry, by its key; the rest follows from that
    const state = Proxies._innerOf(entry) as any;
    const lost = lostOf(state);
    if (lost.length === 0) continue;
    const owned = owning(state, lost, store);
    if (owned !== null) {
      const [owner, me] = owned;
      const keys = new Map(Proxies._key_names(state._relation, me, lost[0]!)
        .map((k) => [k, state._properties.get(k)] as [string, unknown]));
      gathered.entries.push([symbol(state._links.get(me)), owner, "remove", new Map(), keys]);
    }
  }
  const kept = [...removed.values()].filter((entry) => lostOf(Proxies._innerOf(entry)).length === 0);
  for (const [verb, entries] of [["remove", kept], ["insert", [...inserted.values()]]] as const) {
    for (const entry of entries) {
      const state = Proxies._innerOf(entry) as any;
      const [link, adjacency] = writer(state, made);
      const others = new Map<string, unknown>(); // a parameter reference, as itself (CAP-312)
      for (const [other, x] of state._links as Map<string, unknown>) {
        if (other !== link) others.set(other, Proxies._is_parameter(x) ? x : symbol(x));
      }
      gathered.entries.push([symbol(state._links.get(link)), adjacency, verb, others, new Map(state._properties)]);
    }
  }
  for (const [holder, name, after] of changed) {
    if (!Proxies._counted(holder)) gathered.assigned.push([symbol(holder), name, after, schemaOf(holder).properties.get(name).schema]);
  }
  return gathered;
}

/** The link, and its object's adjacency by name, that writes an entry: preferably an object held before, not counted,
 * so that what the entry links is found through it; one present before one not present, of the schema its path
 * implies (CAP-285). */
function writer(state: any, made: Set<unknown>): [string, string] {
  const schema = (x: unknown): any => (x instanceof Proxies._Unresolved ? References._implied(x.store, x.path) : schemaOf(x));
  const choices: [number, string, string][] = []; // ranked: present and held before, not present, counted or made
  for (const [link, x] of state._links as Map<string, unknown>) {
    for (const [name, adjacency] of schema(x).adjacencies as Map<string, any>) {
      if (adjacency.relation === state._relation && adjacency.me === link) {
        const unresolved = x instanceof Proxies._Unresolved;
        choices.push([!unresolved && (Proxies._counted(x) || made.has(Proxies._innerOf(x))) ? 2 : unresolved ? 1 : 0, link, name]);
      }
    }
  }
  if (choices.length === 0) {
    throw new ValueError(`no object an entry of '${state._relation.name}' links has an adjacency to it by name, so that `
      + "its effect cannot write it: name one");
  }
  const [, link, name] = choices.reduce((best, choice) => (choice[0] < best[0] ? choice : best));
  return [link, name];
}

/** Where an entry owns the one deleted object it links, through `lost`, and its owner survives: the owner's adjacency
 * by name that writes it, and the owner's link; else null. */
function owning(state: any, lost: string[], store: any): [string, string] | null {
  if (lost.length !== 1) return null;
  const x = state._links.get(lost[0]);
  const owns = x instanceof Proxies._Unresolved ? Proxies._owns_through(state._relation, lost[0]!, store)
    : Proxies._owner_adjacencies(schemaOf(x)).some((a: any) => a.relation === state._relation && a.me === lost[0]);
  if (!owns) return null;
  const [me] = [...(state._links as Map<string, unknown>).keys()].filter((link) => link !== lost[0]) as [string];
  const names = [...(schemaOf(state._links.get(me)).adjacencies as Map<string, any>)]
    .filter(([, a]) => a.relation === state._relation && a.me === me).map(([name]) => name);
  if (names.length === 0) {
    throw new ValueError(`no owner of an entry of '${state._relation.name}' has an adjacency to it by name, so that `
      + "its effect cannot remove what the entry owned: name one");
  }
  return [names[0]!, me];
}

type PlainMap = Map<string, any>;

/** An effect of `store`'s as plain data, as it is sent from one store to another. */
export function _plain_effect(store: any, effect: unknown): Plain.PlainData {
  return Json.loads(Json.dumps(Plain.ToPlain(store).Transaction(effect) as Plain.PlainData));
}

/** The effect of the transaction open, as plain data, built just before it commits, its proposals set aside, as it is
 * once it has: what a store sends the store below (CAP-285). */
export function _plain(store: any, gathered: _Gathered): Plain.PlainData {
  return _as_committed(store, () => _plain_effect(store, _effect(store, gathered)));
}

/** A transaction of the store below's, its effect as plain data, made to change only the objects present in `store`
 * (CAP-285): each object is named by its path, an object it created by its owner's and its owning entry's keys; a
 * property of an object present is set; an entry is written from an object present it links, through its adjacency by
 * name, and one that links none is left out; an object not present, applied, is linked by its path, loading nothing. A
 * counted object is found by its value, or made. Gives that effect, under the transaction's `uid` where given, null
 * where it changes nothing present, and the
 * entries no object present it links has an adjacency to by name, to apply directly (`_apply_directly`): each its
 * relation, its verb, and its links' paths and properties as plain. */
export function _present_only(store: any, plain: Plain.PlainData): [Plain.PlainData | null, _Direct[]] {
  const [pattern] = (plain as PlainMap).get("mutations")[0].get("upsert").get("exists");
  const [symbols, spec]: [Map<string, PlainMap>, PlainMap[]] = [pattern.get("symbols"), pattern.get("spec")];
  const schemas = new Map<string, any>(); // each symbol's schema: one created's, an object present's, or its path's
  for (const [name, bound] of symbols) {
    if (bound.has("schema")) schemas.set(name, Plain._by_path(store, bound.get("schema")[0].get("path"), []));
  }
  const counted = new Set([...schemas].filter(([, schema]) => Proxies._counted_schema(schema)).map(([name]) => name));
  const paths = new Map<string, Plain.PlainData>();

  /** The path of the object a symbol names: as its reference has it, or, where the transaction created it, as its
   * owner's, then its owning entry's keys. */
  const pathOf = (name: string): Plain.PlainData => {
    const bound = symbols.get(name)!;
    if (bound.has("reference")) return bound.get("reference").get("path");
    if (!paths.has(name)) paths.set(name, createdPath(name, schemaOfSymbol, spec, pathOf));
    return paths.get(name)!;
  };
  const schemaOfSymbol = (name: string): any => {
    if (!schemas.has(name)) schemas.set(name, References._implied(store, pathOf(name)));
    return schemas.get(name);
  };

  const present = new Set(counted);
  for (const name of symbols.keys()) {
    const x = counted.has(name) ? null : store._present(pathOf(name));
    if (Proxies._isObjectData(x)) {
      present.add(name);
      schemas.set(name, schemaOf(x));
    }
  }
  const kept: PlainMap[] = [];
  const direct: _Direct[] = [];
  for (const item of spec) {
    const [[subject, [mutation]]] = [...item] as any;
    if (present.has(subject)) {
      kept.push(item);
      continue;
    }
    const adjacency = mutation!.get("as_adjacency");
    if (adjacency === undefined) continue; // a property of an object not present
    const [[verb, body]] = [...adjacency.get("mutations")[0]] as any;
    const [entry] = body.get("entries") as PlainMap[];
    const [links, keys] = parts(entry!);
    if (![...links.values()].some((symbol) => typeof symbol === "string" && present.has(symbol))) continue;
    const held = schemaOfSymbol(subject).adjacencies.get(adjacency.get("name"));
    const writers = [...links].filter(([, symbol]) => typeof symbol === "string" && present.has(symbol)).flatMap(([link, symbol]) =>
      [...schemas.get(symbol as string).adjacencies as Map<string, any>]
        .filter(([, a]) => a.relation === held.relation && a.me === link).map(([name]) => [link, name] as const));
    if (writers.length === 0) { // written to the objects present it links directly, each other linked by its path
      if ([...links.values()].some((symbol) => typeof symbol === "string" && counted.has(symbol))) {
        throw new ValueError(`a counted object an entry of '${held.relation.name}' links, which a transaction of the `
          + "store below's changes, has no adjacency to it by name, nor has any other object present it links, so that "
          + "it cannot be found to apply it: name one");
      }
      const paths = new Map<string, Plain.PlainData>([...links].map(([link, symbol]) =>
        [link, typeof symbol === "string" ? pathOf(symbol) : symbol]));
      paths.set(held.me, pathOf(subject));
      direct.push([held.relation, verb, paths, keys]);
      continue;
    }
    const [writer, name] = writers[0]!;
    const entryParts = [linkPart(held.me, subject), ...(entry!.get("mutations") as PlainMap[])
      .filter((part) => !(part.has("as_link") && part.get("as_link").get("name") === writer))];
    const written = new Map([[verb!, new Map([["entries", [new Map([["mutations", entryParts]])]]])]]);
    const rewritten = new Map<string, unknown>([["name", name], ["mutations", [written]]]);
    kept.push(new Map([[links.get(writer) as string, [new Map([["as_adjacency", rewritten]])]]]));
  }
  if (kept.length === 0) return [null, direct];
  const used = new Set<string>(); // the symbols what is kept names
  for (const item of kept) {
    const [[subject, [mutation]]] = [...item] as any;
    used.add(subject);
    if (mutation!.has("as_adjacency")) {
      const [[, body]] = [...mutation!.get("as_adjacency").get("mutations")[0]] as any;
      for (const entry of body.get("entries") as PlainMap[]) {
        for (const symbol of parts(entry)[0].values()) if (typeof symbol === "string") used.add(symbol);
      }
    }
  }
  const named = new Map([...symbols].filter(([name]) => used.has(name)).map(([name, bound]) =>
    [name, counted.has(name) ? bound : new Map([["reference", new Map([["path", pathOf(name)]])]])]));
  const uid = (plain as PlainMap).has("uid") ? [["uid", (plain as PlainMap).get("uid")] as [string, unknown]] : [];
  return [new Map([...uid, ["mutations", [new Map([["upsert", new Map([["exists", [new Map<string, unknown>([
    ["symbols", named], ["spec", kept]])]]])]])]]]) as Plain.PlainData, direct];
}

/** An entry to apply directly (`_present_only`): its relation, its verb, its links' paths and its properties as plain. */
export type _Direct = [any, string, Map<string, Plain.PlainData>, Map<string, Plain.PlainData>];

/** Writes, within the transaction open on `store`, each entry `_present_only` gave to apply directly, in the tables of
 * the objects present it links, each other linked by its path: inserted, unless one equal to it is held; removed, each
 * held equal to it. */
export function _apply_directly(store: any, direct: _Direct[]): void {
  for (const [relation, verb, paths, keys] of direct) {
    const links = new Map<string, unknown>();
    for (const [link, path] of paths) {
      if (Plain._is_marked(path)) { // a parameter reference in the object's place (CAP-312)
        links.set(link, Proxies._durable(Plain._unmarked(store, path as PlainMap)));
        continue;
      }
      const found = store._present(path);
      links.set(link, found ?? new Proxies._Unresolved(store, path));
    }
    const properties = new Map([...keys].map(([name, value]) =>
      [name, Plain.FromPlain(store)(relation.entry.properties.get(name).schema, value)] as [string, unknown]));
    const entry = Proxies._make_entry(relation, links, properties as any);
    const state = Proxies._innerOf(entry) as any;
    const present = [...links.values()].filter((x) => Proxies._isObjectData(x));
    const held = [...Proxies._table(present[0], relation, store).values()]
      .filter((e: any) => (Proxies._innerOf(e) as any)._value() === state._value());
    if (verb === "insert" && held.length === 0) Proxies._add_entry(relation, entry, store);
    else if (verb === "remove") Proxies._discard(relation, held, store);
  }
}

/** An entry's links, each to the symbol it is set to, or to a parameter reference, marked, and its properties, each as
 * plain, as an effect writes it. */
function parts(entry: PlainMap): [Map<string, Plain.PlainData>, Map<string, Plain.PlainData>] {
  const [links, keys] = [new Map<string, Plain.PlainData>(), new Map<string, Plain.PlainData>()];
  for (const part of entry.get("mutations") as PlainMap[]) {
    const [[kind, member]] = [...part] as any;
    const [[, set]] = [...member.get("mutations")[0]] as any;
    if (kind === "as_link") {
      const reference = set!.get("reference");
      links.set(member.get("name"), Plain._is_marked(reference) ? reference : reference.get("symbol"));
    } else keys.set(member.get("name"), set!.get("value"));
  }
  return [links, keys];
}

function linkPart(link: string, symbol: string): PlainMap {
  return new Map([["as_link", new Map<string, unknown>([["name", link],
    ["mutations", [new Map([["set", new Map([["reference", new Map([["symbol", symbol]])]])]])]]])]]);
}

/** The path of an object a transaction created: its owner's, then the entry that owns it, which the transaction
 * inserted, through the owner's adjacency by name, by its keys. */
function createdPath(name: string, schemaOfSymbol: (name: string) => any, spec: PlainMap[],
  pathOf: (name: string) => Plain.PlainData): Plain.PlainData {
  const [owner, i, owned, keys] = owningInserted(name, schemaOfSymbol, spec)[0]!;
  const [singleton, steps] = Plain._steps(pathOf(owner), []);
  let nested: PlainMap = new Map([["target", new Map()]]);
  for (const [i_, o, keys_] of [...steps, [i, owned.name, keys] as const].reverse()) {
    nested = new Map([["entry", new Map<string, unknown>([["i", i_], ["o", o], ["properties", keys_], ["next", nested]])]]);
  }
  return new Map<string, unknown>([["singleton", singleton], ["next", nested]]) as Plain.PlainData;
}

/** The entries an effect inserts that own the object a symbol names: each as its owner's symbol, the owner's adjacency
 * by name to it, the owned object's adjacency marked owner(), and the entry's keys. */
function owningInserted(name: string, schemaOfSymbol: (name: string) => any,
  spec: PlainMap[]): [string, string, any, Map<string, Plain.PlainData>][] {
  const found: [string, string, any, Map<string, Plain.PlainData>][] = [];
  for (const item of spec) {
    const [[subject, [mutation]]] = [...item] as any;
    const adjacency: PlainMap | undefined = mutation!.get("as_adjacency");
    if (adjacency === undefined) continue;
    const inserted = [...adjacency.get("mutations")[0] as PlainMap].filter(([verb]) => verb === "insert")
      .flatMap(([, body]) => body.get("entries") as PlainMap[]);
    for (const entry of inserted) {
      const held = schemaOfSymbol(subject).adjacencies.get(adjacency.get("name"));
      const [links, keys] = parts(entry);
      links.set(held.me, subject);
      for (const a of Proxies._owner_adjacencies(schemaOfSymbol(name))) {
        if (a.relation === held.relation && links.get(a.me) === name) {
          const [[ownerLink, owner]] = [...links].filter(([link]) => link !== a.me) as any;
          const [i] = [...[...schemaOfSymbol(owner!).adjacencies as Map<string, any>]
            .filter(([, b]) => b.relation === a.relation && b.me === ownerLink).map(([n]) => n), ""];
          found.push([owner!, i!, a, new Map(Proxies._key_names(a.relation as any, ownerLink!, a.me)
            .map((k) => [k, keys.get(k)!] as [string, Plain.PlainData]))]);
        }
      }
    }
  }
  return found;
}

/** The effect, built outside the transaction's proposals: `Mutations.OfTransaction`, one upsert. */
export function _effect(store: any, gathered: _Gathered): any {
  const specs: ((_: any) => any)[] = [];
  for (const [symbol, adjacency, verb, others, properties] of gathered.entries) {
    const fill = (entry: any, _: any): any => {
      let e = entry;
      for (const [link, other] of others) e = e[link](typeof other === "string" ? _[other] : other);
      for (const [name, v] of properties) e = e[name](v);
      return e;
    };
    specs.push((_: any) => _[symbol][adjacency]((adv: any) => adv[verb]((e: any) => fill(e, _))));
  }
  for (const [symbol, name, plain, schema] of gathered.assigned) {
    const v = plain === null ? null : Plain.FromPlain(store)(schema, plain as Plain.PlainData);
    specs.push((_: any) => _[symbol][name](v));
  }
  const symbols = Object.fromEntries(gathered.symbols);
  return store.Mutations.OfTransaction((t: any) => t.mutations([(mu: any) => mu.upsert((u: any) => u.exists([
    (p: any) => p.symbols(symbols).spec(specs)]))]));
}

// --- The journal: an effect written in the `Changes` schemas, and read back as one ---

function m(entries: [string, unknown][]): PlainMap {
  return new Map(entries);
}

/** A transaction's effect, as plain data (`_plain_effect`), written as a `Changes.Transaction`, plain, of id `uid`:
 * each symbol bound to a reference, or to the schema of an object it made, a `Changes.Symbol`; each counted object,
 * bound to its schema in the effect, written by its value, inline, where an entry links it; each entry the effect
 * writes a `Changes.OfEntry`, and each property it sets or clears a `Changes.OfProperty`, in the effect's order. */
export function _transaction(store: any, uid: string, effect: Plain.PlainData): PlainMap {
  const [pattern] = (effect as PlainMap).get("mutations")[0].get("upsert").get("exists");
  const symbols: Map<string, PlainMap> = pattern.get("symbols") ?? new Map(); // none: a counted object made, linked
  const spec: PlainMap[] = pattern.get("spec") ?? []; // by none
  const counted = new Map<string, PlainMap>(); // by symbol: its value, inline
  for (const [name, bound] of symbols) {
    if (!bound.has("schema")) continue;
    const schema: any = Plain._by_path(store, bound.get("schema")[0].get("path"), []);
    if (Proxies._counted_schema(schema)) counted.set(name, m([["schema", store.name_of(schema)], ["mutations", []]]));
  }
  for (const item of spec) { // a counted object's values, which it never changes: its value
    for (const [name, mutations] of item as Map<string, PlainMap[]>) {
      if (counted.has(name)) counted.get(name)!.get("mutations").push(...mutations.filter((x) => x.has("as_property")));
    }
  }
  const link = (target: unknown): PlainMap => {
    if (typeof target !== "string") return m([["reference", target]]); // a parameter reference, marked (CAP-312)
    return counted.has(target) ? m([["def", counted.get(target)]]) : m([["reference", m([["symbol", target]])]]);
  };
  const changes: PlainMap[] = [];
  for (const item of spec) {
    for (const [name, mutations] of item as Map<string, PlainMap[]>) {
      for (const mutation of mutations) {
        if (mutation.has("as_property")) {
          if (!counted.has(name)) changes.push(m([["property", m([["holder", name], ...mutation.get("as_property")])]]));
          continue;
        }
        const adjacency = mutation.get("as_adjacency");
        for (const verb of adjacency.get("mutations") as PlainMap[]) {
          const [[kind, body]] = [...verb] as [[string, PlainMap]];
          for (const entry of body.get("entries") as PlainMap[]) {
            const [links, keys] = parts(entry);
            changes.push(m([["entry", m([["holder", link(name)], ["adjacency", adjacency.get("name")], ["verb", kind],
              ["links", new Map([...links].map(([other, x]) => [other, link(x)]))], ["properties", keys]])]]));
          }
        }
      }
    }
  }
  return m([["id", uid], ["symbols", new Map([...symbols].filter(([name]) => !counted.has(name))
    .map(([name, bound]) => [name, symbol(store, bound)]))], ["changes", changes]]);
}

/** An effect's symbol as a `Changes.Symbol`, plain: a new object's schema's reference; an object held before's
 * reference, with its schema's where its path does not imply it, the store holding it. */
function symbol(store: any, bound: PlainMap): PlainMap {
  if (bound.has("schema")) return m([["schema", m([["path", bound.get("schema")[0].get("path")]])]]);
  const path = bound.get("reference").get("path");
  let implied: unknown = null;
  try {
    implied = References._implied(store, path);
  } catch { // a path no one schema is implied by: a LookupError
    implied = null;
  }
  const held = store._present(path);
  if (Proxies._isObjectData(held) && schemaOf(held) !== implied) {
    const path = Plain._schema_path(store._path(schemaOf(held)));
    return m([["reference", bound.get("reference")], ["schema", m([["path", path]])]]);
  }
  return m([["reference", bound.get("reference")]]);
}

/** A transaction's effect, as plain data, as a `Changes.Journal` of that one transaction, of id `uid`: a value of
 * `store`'s, which outlives the transaction. */
export function _journal(store: any, uid: string, effect: Plain.PlainData): any {
  return Plain.FromPlain(store)(store.registered("Changes.Journal"), [_transaction(store, uid, effect)] as Plain.PlainData);
}

/** Plain data written with its keys in order, at each level, so that two values alike are written alike. */
function canonical(plain: unknown): unknown {
  if (Array.isArray(plain)) return plain.map(canonical);
  if (!(plain instanceof Map)) return plain;
  return new Map([...plain].sort(([a], [b]) => compareStrings(a, b)).map(([k, v]) => [k, canonical(v)]));
}

/** A `Changes.Transaction`, as plain data, as the effect it writes: one upsert, under its id, of its symbols, each named
 * with `prefix` before its name, and of each counted object it writes inline, one symbol for each value, bound to its
 * schema, whose values the spec writes after its changes, so that it is found by its value, or made. */
export function _effect_of(store: any, transaction: PlainMap, prefix = ""): Plain.PlainData {
  const symbols = new Map<string, unknown>();
  for (const [name, bound] of new Map(transaction.get("symbols")) as Map<string, PlainMap>) {
    symbols.set(prefix + name, bound.has("reference") ? m([["reference", bound.get("reference")]])
      : m([["schema", [m([[Plain.SCHEMA, Plain.REFERENCE], ...bound.get("schema")])]]]));
  }
  const counted = new Map<string, string>(); // each counted object's symbol, by its value
  const values: PlainMap[] = [];
  /** What a link set to a symbol, a counted object's value or a parameter reference names, as an effect does. */
  const symbolOf = (link: PlainMap): unknown => {
    const [[kind, given]] = [...link] as [[string, PlainMap]];
    if (kind === "reference" && Plain._is_marked(given)) return given;
    if (kind === "reference" && given.has("symbol")) return prefix + given.get("symbol");
    if (kind !== "def") {
      throw new ValueError("a change links an object by a symbol of its transaction, or a counted object by its value");
    }
    const key = Json.dumps(canonical(given) as Plain.PlainData);
    if (!counted.has(key)) {
      let n = counted.size;
      while (symbols.has(`${prefix}c${n}`)) n += 1;
      const name = `${prefix}c${n}`;
      counted.set(key, name);
      const path = Plain._schema_path(store._path(store.registered(given.get("schema"))));
      symbols.set(name, m([["schema", [m([[Plain.SCHEMA, Plain.REFERENCE], ["path", path]])]]]));
      for (const mutation of given.get("mutations") as PlainMap[]) values.push(m([[name, [renamed(mutation, prefix)]]]));
    }
    return counted.get(key);
  };
  const spec: PlainMap[] = [];
  for (const change of (transaction.get("changes") ?? []) as PlainMap[]) {
    const [[kind, body]] = [...change] as [[string, PlainMap]];
    if (kind === "property") {
      spec.push(m([[prefix + body.get("holder"), [m([["as_property", m([["name", body.get("name")],
        ["mutations", body.get("mutations")]])]])]]]));
      continue;
    }
    const verb = body.get("verb");
    if (verb !== "insert" && verb !== "remove") {
      throw new ValueError(`an entry's change is an insert or a remove, not '${verb}'`);
    }
    const entryParts: PlainMap[] = [...new Map(body.get("links")) as Map<string, PlainMap>].map(([name, link]) => {
      const target = symbolOf(link);
      return m([["as_link", m([["name", name], ["mutations", [m([["set", m([["reference",
        target instanceof Map ? target : m([["symbol", target]])]])]])]]])]]);
    });
    for (const [name, value] of new Map(body.get("properties")) as PlainMap) {
      entryParts.push(m([["as_property", m([["name", name], ["mutations", [m([["set", m([["value", value]])]])]]])]]));
    }
    spec.push(m([[symbolOf(body.get("holder")) as string, [m([["as_adjacency", m([["name", body.get("adjacency")],
      ["mutations", [m([[verb, m([["entries", [m([["mutations", entryParts]])]]])]])]]])]])]]]));
  }
  const id = transaction.has("id") ? [["uid", transaction.get("id")] as [string, unknown]] : [];
  const keyed = transaction.has("id") ? [["key", transaction.get("id")] as [string, unknown]] : []; // a replay finds
  return m([...id, ["mutations", [m([["upsert", m([...keyed, ["exists", [m([["symbols", symbols], // what it made
    ["spec", [...spec, ...values]]])]]])]])]]]) as Plain.PlainData;
}

/** Plain mutations with each symbol a link is set to named with `prefix` before its name. */
function renamed(plain: unknown, prefix: string): unknown {
  if (Array.isArray(plain)) return plain.map((item) => renamed(item, prefix));
  if (!(plain instanceof Map)) return plain;
  return new Map([...plain].map(([k, v]) => [k, k === "reference" && v instanceof Map && v.has("symbol")
    ? new Map([...v, ["symbol", prefix + v.get("symbol")]]) : renamed(v, prefix)]));
}

/** A `Changes.Journal`, as plain data, as the effect of each of its transactions, in order (`_effect_of`). */
export function _effects(store: any, journal: Plain.PlainData): Plain.PlainData[] {
  if (!Array.isArray(journal)) throw new ValueError("a journal, as plain data, is a list of its transactions");
  return journal.map((transaction) => _effect_of(store, transaction as PlainMap));
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
abstract class At {
  payload: any = null;

  abstract member(schema: string, member: string, siblings: PlainMap): any;

  element(_index: unknown): any {
    return this;
  }
}

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
    return References._implied(this.store, bound.get("reference").get("path"));
  }

  /** The schema of what a link is set to: a symbol's, or a counted object's, inline. */
  linked(link: PlainMap): any {
    const given = link.get("def");
    return given !== undefined ? this.store.registered(given.get("schema"))
      : this.schema(link.get("reference").get("symbol"));
  }

  member(schema: string, member: string, siblings: PlainMap): any {
    if (schema === "Changes.Change") return this;
    if (schema === "Changes.OfProperty" && member === "mutations") {
      return new Value(this.schema(siblings.get("holder")).properties.get(siblings.get("name")).schema);
    }
    if (schema === "Changes.OfEntry" && (member === "holder" || member === "links")) return new Links(this);
    if (schema === "Changes.OfEntry" && member === "properties") {
      return new EntryProperties(this.linked(siblings.get("holder")).adjacencies.get(siblings.get("adjacency")).relation);
    }
    return null;
  }
}

/** A link set, to a symbol or a counted object inline (`Mutations.OfLink.Set`): its definition, within its schema. */
class Links extends At {
  constructor(readonly symbols: Symbols) {
    super();
  }

  member(schema: string, member: string, siblings: PlainMap): any {
    if (schema === "Mutations.OfLink") return this;
    if (schema === "Mutations.OfLink.Set" && member === "def") return this;
    if (schema === "Mutations.OfObject.Def" && member === "mutations") {
      return new ObjectMutations(this.symbols.store.registered(siblings.get("schema")), this.symbols);
    }
    return null;
  }
}

/** An object's mutations, a counted object's inline: each property's within its schema, each adjacency's within its
 * relation. */
class ObjectMutations extends At {
  constructor(readonly schema: any, readonly symbols: Symbols) {
    super();
  }

  member(schema: string, member: string, siblings: PlainMap): any {
    if (schema === "Mutations.OfObject") return this;
    if (schema === "Mutations.OfObject.AsProperty" && member === "mutations") {
      return new Value(this.schema.properties.get(siblings.get("name")).schema);
    }
    if (schema === "Mutations.OfObject.AsAdjacency" && member === "mutations") {
      return new Adjacency(this.schema.adjacencies.get(siblings.get("name")).relation, this.symbols);
    }
    return null;
  }
}

/** An adjacency's mutations: each entry's properties within its relation's, its links set as links are. */
class Adjacency extends At {
  constructor(readonly relation: any, readonly symbols: Symbols) {
    super();
  }

  member(schema: string, member: string, siblings: PlainMap): any {
    if (["Mutations.OfAdjacency", "Mutations.OfAdjacency.Insert", "Mutations.OfAdjacency.Remove", "Mutations.OfEntry",
      "Mutations.OfEntry.Member"].includes(schema)) return this;
    if (schema === "Mutations.OfEntry.AsProperty" && member === "mutations") {
      return new Value(this.relation.entry.properties.get(siblings.get("name")).schema);
    }
    if (schema === "Mutations.OfEntry.AsLink" && member === "mutations") return new Links(this.symbols);
    return null;
  }
}

/** An entry's properties, each within its schema: a container, whose elements are within, not its members. */
class EntryProperties {
  readonly payload = null;

  constructor(readonly relation: any) {}

  element(index: unknown): any {
    const found = this.relation.entry.properties.get(index);
    return found === undefined ? null : new Value(found.schema);
  }
}

/** The unions of a value's verbs: each verb within what the union is. */
const UNIONS = new Set(["Mutations.OfProperty", "Mutations.OfAny", "Mutations.OfScalar", "Mutations.OfContainer"]);

/** Each verb's member that holds a payload, or verbs, by its schema's name and its own, and what it is within: the
 * value's schema, or its part's. */
const VERBS = new Map<string, string>(Object.entries({
  "Mutations.OfProperty.Set value": "self", "Mutations.OfAny.Set value": "self", "Mutations.OfScalar.Set value": "self",
  "Mutations.OfProperty.AsAny mutations": "self", "Mutations.OfAny.AsScalar mutations": "self",
  "Mutations.OfAny.AsContainer mutations": "self", "Mutations.OfAny.AsObject mutations": "members",
  "Mutations.OfAny.AsUnion mutations": "members", "Mutations.OfAny.AsIntersection mutations": "members",
  "Mutations.OfContainer.Insert slice": "self", "Mutations.OfContainer.Slice index": "index",
  "Mutations.OfContainer.Slice items": "element", "Mutations.OfContainer.Remove index": "index",
  "Mutations.OfContainer.Append items": "element", "Mutations.OfContainer.Prepend items": "element",
  "Mutations.OfContainer.AsItems mutations": "element",
}));

/** A value's mutations, mbse-schemas' verbs: each payload in them interpreted by the value's schema, or, in a
 * container's verbs, by its index's or its element's, and, in a value object's, a union's or an intersection's, by its
 * member's. */
class Value extends At {
  constructor(schema: any) {
    super();
    this.payload = Proxies._deref(schema);
  }

  member(schema: string, member: string): any {
    if (UNIONS.has(schema)) return this;
    const within = VERBS.get(`${schema} ${member}`);
    if (within === undefined) return null;
    if (within === "self") return this;
    if (within === "members") return new Members(this.payload);
    return new Value(this.payload[within]);
  }
}

/** A value object's, a union's or an intersection's members' mutations (`AsProperty`, `AsBranch`, `AsPart`). */
class Members extends At {
  constructor(readonly schema: any) {
    super();
  }

  member(schema: string, member: string, siblings: PlainMap): any {
    if (member === "mutations" && ["Mutations.OfObject.AsProperty", "Mutations.OfUnion.AsBranch",
      "Mutations.OfIntersection.AsPart"].includes(schema)) {
      return new Value(this.schema.properties.get(siblings.get("name")).schema);
    }
    return null;
  }
}
