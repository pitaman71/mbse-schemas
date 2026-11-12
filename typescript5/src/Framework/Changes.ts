/**
 * Changes: a transaction's effect, observed at its commit
 * ([CAP-270: a transaction's changes observed at its commit](mbse:mbse-basis/docs/capabilities/README.md#CAP-270),
 * [CAP-269: transactions resolved into their effects](mbse:mbse-basis/docs/capabilities/README.md#CAP-269),
 * [CAP-271: the journal language](mbse:mbse-basis/docs/capabilities/README.md#CAP-271)).
 *
 * `observe(store, observer)` calls `observer(effect)` after each transaction of `store` that commits having changed
 * something, and returns a function that ends the observing; a transaction that throws, its writes dropped, is observed
 * by none. The effect is what the transaction changed, net of what it undid within itself, written in the journal
 * language: a transaction expression of the store's own schemas (`Mutations.OfTransaction`), schema data written and
 * read as any value is, with no schema of its own. It is one upsert:
 *
 * - its symbols, each declared before it is used: each object the transaction touched that was held before it, bound
 *   to its reference (`References.OfObject`) as it was; each owned object it created, bound to its schema, after its
 *   owner's, so that the upsert finds it by its ownership entry; and each counted object, immutable, bound to its
 *   schema, found by its value, which the spec writes;
 * - its spec: the relation entries the transaction removed, then those it inserted, each written on the adjacency of
 *   one object it links, then the properties it changed, each set to its value, written by the property's schema, or
 *   cleared. An object the transaction deleted is never named: the entry that owned it is removed by its owner's key
 *   for it, written on its owner's adjacency, and what its deletion removed in cascade, every entry linking it and what
 *   it owned, is left to follow from that, as it does in every store that applies the effect.
 *
 * Applied to the store as it was before the transaction, the effect makes the same changes; applied again, it changes
 * nothing. The changes are gathered from the transaction's proposals just before it commits, after `Provenance`
 * records it and its ownership is settled, so that what it deleted in cascade, and every entry linking it, is among
 * them; what an object is before is read from what the store holds as committed. The expression is built once the
 * transaction has committed, since building it writes.
 */

import { ValueError } from "./Errors.js";
import * as Json from "./JSON.js";
import * as Plain from "./Plain.js";
import type * as Proposals from "./Proposals.js";
import * as Proxies from "./Proxies.js";
import * as References from "./References.js";

/** Calls `observer` with the effect of each transaction of `store` that commits having changed something; returns a
 * function that ends it. */
export function observe(store: any, observer: (effect: any) => void): () => void {
  store._observers.push(observer);
  return () => {
    const at = store._observers.indexOf(observer);
    if (at >= 0) store._observers.splice(at, 1);
  };
}

/** What a transaction changed, gathered before it commits, to be written as its effect once it has: the symbols, by
 * name, each a reference or a schema; each entry removed or inserted, as the symbol whose adjacency writes it, that
 * adjacency, the verb, its other links' symbols and its properties; each property changed, by symbol, as plain. */
export interface _Gathered {
  symbols: Map<string, any>;
  entries: [string, string, string, Map<string, string>, Map<string, unknown>][];
  assigned: [string, string, unknown, any][];
}

/** Reads what the store holds as committed, while a transaction is open: its state before the transaction. */
function asCommitted<T>(store: any, read: () => T): T {
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
  const deleted = new Set<unknown>();
  for (const entry of removed.values()) {
    for (const x of (Proxies._innerOf(entry) as any)._links.values() as Iterable<unknown>) {
      if (!made.has(Proxies._innerOf(x)) && Proxies._owner_adjacencies(schemaOf(x)).length > 0
          && Proxies._owner_entries(x).length === 0) deleted.add(Proxies._innerOf(x));
    }
  }
  const changed: [unknown, string, unknown][] = [];
  for (const [data, values] of proposals.values_) {
    // a value object's, read with the object holding it; or a deleted object's, which goes
    if (!(data instanceof Proxies._internals._ObjectData) || deleted.has(data)) continue;
    const holder = (data as any)._proxy; // proposals hold an object's data: read it through its proxy
    const names = [...new Set([...(base.values(data) as Map<string, unknown>).keys(), ...(values as Map<string, unknown>).keys()])];
    const after = new Map(names.map((name) => [name, value(store, holder, name)]));
    const before = asCommitted(store, () => new Map(names.map((name) =>
      [name, made.has(data) ? null : value(store, holder, name)])));
    for (const name of names) if (!same(before.get(name), after.get(name))) changed.push([holder, name, after.get(name)]);
  }
  if (removed.size === 0 && inserted.size === 0 && changed.length === 0) return null;
  const gathered: _Gathered = { symbols: new Map(), entries: [], assigned: [] };
  const named = new Map<unknown, string>();
  /** The symbol of an object the effect names, declared where first needed: a created owned object's after its
   * owner's. */
  const symbol = (x: unknown): string => {
    const found = named.get(Proxies._innerOf(x));
    if (found !== undefined) return found;
    const counted = Proxies._counted(x);
    let bound: any;
    if (counted || made.has(Proxies._innerOf(x))) {
      for (const entry of counted ? [] : Proxies._owner_entries(x)) {
        for (const owner of (Proxies._innerOf(entry) as any)._links.values()) {
          if (Proxies._innerOf(owner) !== Proxies._innerOf(x)) symbol(owner);
        }
      }
      bound = schemaOf(x);
    } else {
      bound = asCommitted(store, () => References.of(store, x));
    }
    const name = `o${named.size}`;
    named.set(Proxies._innerOf(x), name);
    gathered.symbols.set(name, bound);
    if (counted) { // found by its value, which it never changes
      for (const [n, p] of schemaOf(x).properties as Map<string, any>) {
        const v = value(store, x, n);
        if (v !== null) gathered.assigned.push([name, n, v, p.schema]);
      }
    }
    return name;
  };
  const gone = (state: any): string[] => [...state._links as Map<string, unknown>]
    .filter(([, x]) => deleted.has(Proxies._innerOf(x))).map(([link]) => link);
  for (const entry of removed.values()) { // a deleted object's: its owning entry, by its key; the rest follows from that
    const state = Proxies._innerOf(entry) as any;
    const owned = owning(state, gone(state));
    if (owned !== null) {
      const [owner, me] = owned;
      const keys = new Map(Proxies._key_names(state._relation, me, gone(state)[0]!)
        .map((k) => [k, state._properties.get(k)] as [string, unknown]));
      gathered.entries.push([symbol(state._links.get(me)), owner, "remove", new Map(), keys]);
    }
  }
  const kept = [...removed.values()].filter((entry) => gone(Proxies._innerOf(entry)).length === 0);
  for (const [verb, entries] of [["remove", kept], ["insert", [...inserted.values()]]] as const) {
    for (const entry of entries) {
      const state = Proxies._innerOf(entry) as any;
      const [link, adjacency] = writer(state, made);
      const others = new Map<string, string>();
      for (const [other, x] of state._links as Map<string, unknown>) if (other !== link) others.set(other, symbol(x));
      gathered.entries.push([symbol(state._links.get(link)), adjacency, verb, others, new Map(state._properties)]);
    }
  }
  for (const [holder, name, after] of changed) {
    if (!Proxies._counted(holder)) gathered.assigned.push([symbol(holder), name, after, schemaOf(holder).properties.get(name).schema]);
  }
  return gathered;
}

/** The link, and its object's adjacency by name, that writes an entry: preferably an object held before, not counted,
 * so that what the entry links is found through it. */
function writer(state: any, made: Set<unknown>): [string, string] {
  const choices: [boolean, string, string][] = [];
  for (const [link, x] of state._links as Map<string, unknown>) {
    for (const [name, adjacency] of schemaOf(x).adjacencies as Map<string, any>) {
      if (adjacency.relation === state._relation && adjacency.me === link) {
        choices.push([Proxies._counted(x) || made.has(Proxies._innerOf(x)), link, name]);
      }
    }
  }
  if (choices.length === 0) {
    throw new ValueError(`no object an entry of '${state._relation.name}' links has an adjacency to it by name, so that `
      + "its effect cannot write it: name one");
  }
  const [, link, name] = choices.find(([later]) => !later) ?? choices[0]!;
  return [link, name];
}

/** Where an entry owns the one deleted object it links, through `gone`, and its owner survives: the owner's adjacency
 * by name that writes it, and the owner's link; else null. */
function owning(state: any, gone: string[]): [string, string] | null {
  if (gone.length !== 1) return null;
  const x = state._links.get(gone[0]);
  if (!Proxies._owner_adjacencies(schemaOf(x)).some((a: any) => a.relation === state._relation && a.me === gone[0])) {
    return null;
  }
  const [me] = [...(state._links as Map<string, unknown>).keys()].filter((link) => link !== gone[0]) as [string];
  const names = [...(schemaOf(state._links.get(me)).adjacencies as Map<string, any>)]
    .filter(([, a]) => a.relation === state._relation && a.me === me).map(([name]) => name);
  if (names.length === 0) {
    throw new ValueError(`no owner of an entry of '${state._relation.name}' has an adjacency to it by name, so that `
      + "its effect cannot remove what the entry owned: name one");
  }
  return [names[0]!, me];
}

/** The effect, built once the transaction has committed: `Mutations.OfTransaction`, one upsert. */
export function _effect(store: any, gathered: _Gathered): any {
  const specs: ((_: any) => any)[] = [];
  for (const [symbol, adjacency, verb, others, properties] of gathered.entries) {
    const fill = (entry: any, _: any): any => {
      let e = entry;
      for (const [link, other] of others) e = e[link](_[other]);
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
