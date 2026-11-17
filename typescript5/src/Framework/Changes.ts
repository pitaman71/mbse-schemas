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
 * them; what an object is before is read from what the store holds as committed. The expression is built outside the
 * transaction's proposals, since building it writes: once the transaction has committed, for its observers, and, for
 * the store below a store, just before, with its proposals set aside, as plain data (CAP-285). A store given a store
 * below gives its observers, for a transaction of its own, the effect the store below reported it committed, what the
 * store below added to it, as its record, among it, so that each store of a stack gives the same one; changes name an
 * object not present by its path, loading nothing.
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
 * counted object is found by its value, or made. Gives that effect, null where it changes nothing present, and the
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
  return [new Map([["mutations", [new Map([["upsert", new Map([["exists", [new Map<string, unknown>([["symbols", named],
    ["spec", kept]])]]])]])]]]) as Plain.PlainData, direct];
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
