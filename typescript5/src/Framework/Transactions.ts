/**
 * Transactions: the writes to a store, as mutation expressions over streams of frames (docs/STREAMING_QUERIES.md;
 * docs/OBJECT_IDENTITY.md, Decided, 38 to 97).
 *
 * A pattern's `spec` says what must hold of a frame: the property values the objects its symbols bind have, and the
 * relation entries that link them (Decided, 76). It is written in the builders' own notation, over the frame, whose
 * members are the pattern's symbols, each a visitor of the object it binds that records mutations rather than writing
 * objects (58, 95):
 *
 *     (_: any) => _.bob.name("Bob").knows([_.ada])
 *
 * A spec is recorded as a `Mutations.OfPattern`, plain data: for each symbol, the mutations of the object it binds, in
 * order. A property written is `{"as_property": {"name": ..., "mutations": [{"set": {"value": ...}}]}}`, its value as
 * `Plain` writes a property's; an adjacency's entries are `{"as_adjacency": {"name": ..., "mutations": [{"insert":
 * {"entries": [...]}}]}}`, each entry `{"mutations": [...]}` of its links (`as_link`) and properties (`as_property`), as
 * a snapshot writes an entry, leaving out the object's own link. A link refers to the object another symbol binds, `{"ref":
 * {"symbol": "ada"}}`, to an object by its path, `{"ref": {"path": ...}}` (a schema object, a singleton or an owned
 * object), or defines a new object where it is linked, `{"def": {"schema": ..., "mutations": [...]}}`. An adjacency's
 * entries are removed as a builder's adjacency removes them, `knows((a) => a.remove((e) => e.known(_.bob)))`, recorded
 * `{"remove": {"entries": [...]}}`, and all of them by `clear()`, recorded `{"clear": {}}`.
 *
 * `store.transaction(spec)` executes a transaction, sequentially: its stream starts as one frame, empty, and each term
 * makes the frames it passes on through `then`. A map binds each symbol its frame lacks to every object of its schema,
 * reachable from the store's singletons, whose spec holds; an upsert binds what it finds the same way and creates what
 * it does not, writing its spec where it does not hold; an update writes its spec; a reduce drops symbols; a partition
 * runs its branches and joins what they end with. It gives the frames its chain ends with, each the objects its symbols
 * bind, by symbol. A spec holds where the entries it inserts are held and those it removes are absent: an entry is
 * removed where every link and property the removal gives agrees with it, so that run again, a spec that removes writes
 * nothing.
 *
 * A symbol of a meta-schema (`store.Schemas.OfObject`, ...) binds schema objects: a module's `install(txn)` upserts its
 * schemas, each found by its name, so that a transaction defines and extends schemas (Decided, 86).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Builders from "./Builders.js";
import { LookupError, ValueError } from "./Errors.js";
import * as Json from "./JSON.js";
import * as Paths from "./Paths.js";
import * as Plain from "./Plain.js";
import * as Proxies from "./Proxies.js";
import { repr, sortedStrings, TYPE_NAME } from "./Repr.js";
import * as S from "./Schemas.js";

const { _Shelled: Shelled, _shell: shell, _innerOf: innerOf } = Proxies;

type PlainMap = Map<string, unknown>;

const m = (entries: [string, unknown][]): PlainMap => new Map(entries);

/** The mutations a spec's callback records over a frame of `symbols`, by symbol (a `Mutations.OfPattern`). */
export function _recorded(store: any, symbols: Map<string, any>, spec: unknown): PlainMap {
  const frame = new SpecFrame(store, symbols);
  store._recording += 1;
  try {
    Proxies._visit(spec, shell(frame));
  } finally {
    store._recording -= 1;
  }
  return new Map([...frame._states].filter(([, state]) => state.written.length > 0)
    .map(([name, state]) => [name, state.plain()]));
}

/** A schema object a spec defines where it is linked, `store.Schemas.OfContainer(cb)` within one: its members as `spec`
 * writes them, recorded; linked, it is written as a definition (`Mutations.OfObject.Def`). */
export function _definition(store: any, schema: unknown, spec: unknown): any {
  const recorder = makeRecorder(new State(store, schema));
  innerOf(recorder)._state.loose = true;
  Proxies._visit(spec, recorder);
  return recorder;
}

/** The frame a spec is written over: its members are the pattern's symbols, each the recording visitor of the object it
 * binds. */
class SpecFrame extends Shelled {
  readonly [TYPE_NAME] = "_Frame";
  readonly _states = new Map<string, State>();

  constructor(readonly _store: any, readonly _symbols: Map<string, any>) {
    super();
  }

  override _member(name: string): unknown {
    const symbol = this._symbols.get(name);
    if (symbol === undefined) return Proxies._makeEmpty(`${repr(name)} is not a symbol of the pattern`);
    if (symbol.schema === null) {
      throw new TypeError(`symbol ${repr(name)} has no schema: a spec writes what its object's schema declares`);
    }
    let state = this._states.get(name);
    if (state === undefined) {
      state = new State(this._store, symbol.schema, name);
      this._states.set(name, state);
    }
    return makeRecorder(state);
  }

  override _repr(): string {
    return "<frame>";
  }
}

/** What a spec writes of one object: its properties' values, and the entries of its adjacencies, in order. */
class State {
  readonly values = new Map<string, unknown>();
  /** ["property", name] or ["adjacency", [name, entries, verb]], in order. */
  readonly written: [string, unknown][] = [];
  /** Defined by `_definition`, and not linked yet. */
  loose = false;

  constructor(readonly store: any, readonly schema: any, readonly symbol: string | null = null) {}

  plain(): unknown[] {
    const names = Plain._names(this.store);
    const members: unknown[] = [];
    for (const [kind, what] of this.written) {
      if (kind === "property") {
        const prop = this.schema.properties.get(what);
        const values = new Map([[what as string, Proxies._built(this.values.get(what as string) ?? null)]]); // as a builder's
        const read = Proxies._makeProperty(values, what as string, prop, this.store, null, false);
        const [present, plain] = Plain._value(read, prop.schema, names);
        const verb = present ? m([["set", m([["value", plain]])]]) : m([["clear", new Map()]]);
        members.push(m([["as_property", m([["name", what], ["mutations", [verb]]])]]));
      } else if (kind === "adjacency") {
        const [name, entries, verb] = what as [string, RecordedEntry[], string];
        members.push(m([["as_adjacency", m([["name", name], ["mutations", [verb === "clear" ? m([["clear", new Map()]])
          : m([[verb, m([["entries", entries.map((entry) => entry.plain())]])]])]]])]]));
      } else { // a pattern's own spec, as recorded (`RecordedSpec`)
        members.push(m([["spec", m([["items", what]])]]));
      }
    }
    return members;
  }
}

/** `Visitors.OfObject` over the object a symbol binds, or one a spec defines where it is linked: its properties and
 * adjacencies are members, which record what they are given. */
class Recorder extends Shelled {
  readonly [TYPE_NAME] = "_Recorder";

  constructor(readonly _state: State) {
    super();
  }

  as_schema(): any {
    return this._state.schema;
  }

  /** The schema of the object it records, which a link may link (`Proxies._schemaOf`). */
  get _linkedSchema(): any {
    return this._state.schema;
  }

  override _member(name: string): unknown {
    const state = this._state;
    if (name === "spec" && state.schema === state.store.registered("Schemas.OfPattern")) return makeRecordedSpec(this);
    if (state.schema.properties.has(name)) return makeRecordedProperty(this, name);
    if (state.schema.adjacencies.has(name)) return makeRecordedAdjacency(this, name);
    return Proxies._makeEmpty(`${repr(name)} is not a property or adjacency of ${Proxies._withArticle(Proxies._noun(state.schema))}`);
  }

  override _repr(): string {
    return `<spec of ${this._state.symbol ?? "an object"}>`;
  }
}

function makeRecorder(state: State): any {
  return shell(new Recorder(state));
}

/** A property of a recorded object: written as a builder's is (`Visitors.OfProperty`), and recorded. */
class RecordedProperty extends Shelled {
  readonly [TYPE_NAME] = "_RecordedProperty";

  constructor(readonly _recorder: Recorder, readonly _name: string) {
    super();
  }

  _visitor(): any {
    const state = this._recorder._state;
    return Proxies._makeProperty(state.values, this._name, state.schema.properties.get(this._name), state.store,
      this._recorder._proxy, true, () => this._note());
  }

  _note(): void {
    const written = this._recorder._state.written;
    if (!written.some(([kind, what]) => kind === "property" && what === this._name)) written.push(["property", this._name]);
  }

  _call(spec: unknown): unknown {
    if (!Proxies._isFunction(spec)) spec = shorthand(this._recorder._state, this._name)(spec);
    this._visitor()(spec);
    this._note();
    return this._recorder._proxy;
  }

  override _member(name: string): unknown {
    return this._visitor()[name];
  }
}

/** A pattern's spec, written in a spec (`Mutations.OfObject.Spec`): each callback recorded over the symbols the pattern
 * declares before it in the spec, as a pattern's builder records its own (`PatternBuilder.spec`). */
function makeRecordedSpec(recorder: Recorder): any {
  return (specs: unknown): unknown => {
    const state = recorder._state;
    const symbols = declared(state);
    const items = Proxies._isFunction(specs) ? [specs] : [...(specs as Iterable<unknown>)];
    state.written.push(["spec", items.map((item) => _recorded(state.store, symbols, item))]);
    return recorder._proxy;
  };
}

/** The symbols a recorded pattern declares, by name, each with the schema its entry links: one the store holds, since a
 * spec is recorded before its transaction runs. */
function declared(state: State): Map<string, any> {
  const symbols = new Map<string, any>();
  for (const [kind, what] of state.written) {
    const [name, , verb] = what as unknown[];
    if (kind !== "adjacency" || name !== "symbols" || verb !== "insert") continue;
    for (const entry of (what as [string, RecordedEntry[]])[1]) {
      const held = entry._links.get("symbol") as State;
      const typed = held.written.filter(([k, w]) => k === "adjacency" && (w as [string, unknown])[0] === "schema"
      && (w as unknown[])[2] === "insert");
      const ref: any = typed.length > 0 ? ((typed[0]![1] as [string, RecordedEntry[]])[1][0]!)._links.get("schema") : new Map();
      if (!(ref instanceof Map) || !ref.has("path")) {
        throw new ValueError(`symbol ${repr(entry._values.get("name"))} of a pattern whose spec a spec records names no `
          + "schema the store holds: name it by its path, an earlier install's");
      }
      symbols.set(entry._values.get("name") as string, { schema: Plain._by_path(state.store, ref.get("path"), []) });
    }
  }
  return symbols;
}

/** What a schema object's builder makes of a value given whole to its property `name` (`Prop.shorthand`), so that a spec
 * takes what the builder does (`uniques("schema")`); a value as it is, for data's. */
function shorthand(state: State, name: string): (value: unknown) => unknown {
  const builder = state.store._meta_builder_class_of(state.schema);
  const member = builder !== null ? builder._table.get(name) : undefined;
  return member instanceof Builders._Prop ? member.shorthand : (value: unknown) => value;
}

function makeRecordedProperty(recorder: Recorder, name: string): any {
  const state = new RecordedProperty(recorder, name);
  return shell(state, (spec) => state._call(spec));
}

/** An adjacency of a recorded object: its entries inserted, removed or cleared, recorded, as a builder's adjacency takes
 * them (`insert(cb)`, `remove(cb)`, `clear()`). Called with a callback, it visits through it; with an iterable, the peer
 * shorthand, each item an entry's callback or the object to link; with a mapping, where its relation has two links and
 * one property, each item an entry keyed by that property (FRAMEWORK.md, Resolved, Mappings for keyed adjacencies). */
class RecordedAdjacency extends Shelled {
  readonly [TYPE_NAME] = "_RecordedAdjacency";
  readonly _schema: any;

  constructor(readonly _recorder: Recorder, readonly _name: string) {
    super();
    this._schema = _recorder._state.schema.adjacencies.get(_name);
  }

  as_schema(): any {
    return this._schema;
  }

  _other(): string {
    const others = [...this._schema.relation.entry.links.keys()].filter((link: string) => link !== this._schema.me);
    if (others.length !== 1) {
      throw new TypeError(`adjacency ${repr(this._name)}: entries of ${this._schema.relation.name || "its relation"} have `
        + "more than two links; give each entry's links");
    }
    return others[0] as string;
  }

  _record(entries: RecordedEntry[], verb = "insert"): void {
    this._recorder._state.written.push(["adjacency", [this._name, entries, verb]]);
  }

  insert(spec: unknown): any {
    const entry = new RecordedEntry(this._recorder._state.store, this._schema.relation, this._schema.me);
    Proxies._visit(spec, shell(entry));
    this._record([entry]);
    return this._proxy;
  }

  /** Removes every entry that agrees with the one `spec` gives: each link and property it gives equal to the entry's; a
   * keyed adjacency's entry by its name. */
  remove(spec: unknown): any {
    const entry = new RecordedEntry(this._recorder._state.store, this._schema.relation, this._schema.me);
    Proxies._visit(spec, shell(entry));
    this._record([entry], "remove");
    return this._proxy;
  }

  /** Removes every entry the adjacency holds. */
  clear(): any {
    this._record([], "clear");
    return this._proxy;
  }

  _call(spec: unknown): unknown {
    if (Proxies._isFunction(spec)) {
      Proxies._visit(spec, this._proxy);
      return this._recorder._proxy;
    }
    const store = this._recorder._state.store;
    const relation = this._schema.relation;
    const entries: RecordedEntry[] = [];
    const items = Proxies._mapping(spec);
    if (items !== null) {
      const keys = [...relation.entry.properties.keys()];
      if (relation.entry.links.size !== 2 || keys.length !== 1) {
        throw new TypeError(`adjacency ${repr(this._name)} takes a mapping only where its relation has two links and one `
          + "property");
      }
      for (const [key, value] of items) {
        const entry = new RecordedEntry(store, relation, this._schema.me);
        entry._values.set(keys[0] as string, key);
        entry._give(this._other(), value);
        entries.push(entry);
      }
    } else if (typeof spec === "string" || spec instanceof Uint8Array || !Proxies._iterable(spec)) {
      throw new TypeError(`adjacency ${repr(this._name)} takes an iterable of entries or of what it links, a mapping, or a `
        + `callback taking the adjacency; got ${repr(spec)}`);
    } else {
      for (const item of spec) {
        const entry = new RecordedEntry(store, relation, this._schema.me);
        if (Proxies._isFunction(item)) {
          entry._other = this._other();
          Proxies._visit(item, shell(entry));
          if (!entry._links.has(entry._other)) entry._defined(entry._other); // given no link, it defines what it links
        } else {
          entry._link(this._other(), item);
        }
        entries.push(entry);
      }
    }
    this._record(entries);
    return this._recorder._proxy;
  }
}

function makeRecordedAdjacency(recorder: Recorder, name: string): any {
  const state = new RecordedAdjacency(recorder, name);
  return shell(state, (spec) => state._call(spec));
}

/** One entry a spec inserts, as the peer shorthand gives it (`OfThem.Visitor`): its properties, its link, and, through
 * the link, the members of a new object it defines where the link is not given; a kind union's kinds too. */
class RecordedEntry extends Shelled {
  readonly [TYPE_NAME] = "_RecordedEntry";
  readonly _values = new Map<string, unknown>();
  readonly _links = new Map<string, unknown>();
  _other: string | null = null;

  constructor(readonly _store: any, readonly _relation: any, readonly _me: string) {
    super();
  }

  as_schema(): any {
    return this._relation.entry;
  }

  override _member(name: string): unknown {
    if (this._relation.entry.properties.has(name)) return makeEntryProperty(this, name);
    if (this._relation.entry.links.has(name) && name !== this._me) return (target: unknown) => this._link(name, target);
    for (const link of this._relation.entry.links.keys()) {
      const kind = link !== this._me ? Proxies._linkKinds(this._relation, link)?.get(name) : undefined;
      if (kind !== undefined) return (spec: unknown) => this._define(link, kind, spec);
    }
    if (this._other !== null) return makeChained(makeRecorder(this._defined(this._other))[name], this);
    return Proxies._makeEmpty(`${repr(name)} is not a link or property of the relation`);
  }

  /** Links what `target` gives: an object another symbol binds, one a path names, or a new one a callback defines; in a
   * list of one, as a link's builder takes it. */
  _link(link: string, target: unknown): any {
    if (Array.isArray(target)) {
      if (target.length !== 1) throw new TypeError(`link ${repr(link)} links one schema, got ${target.length}`);
      target = target[0];
    }
    if (Proxies._isFunction(target)) {
      const store = this._store;
      const kinds = Proxies._linkKinds(this._relation, link);
      if (kinds !== null) {
        throw new TypeError(`link ${repr(link)} is a kind union: define through one of its kinds, ${[...kinds.keys()].join(", ")}`);
      }
      return this._define(link, store.registered(store._filled(this._relation, link)), target);
    }
    const defined = innerOf(target);
    if (defined instanceof Recorder && defined._state.loose) {
      defined._state.loose = false; // defined where it is linked (`_definition`), once
      this._links.set(link, defined._state);
      return this._proxy;
    }
    this._links.set(link, reference(this._store, target));
    return this._proxy;
  }

  _define(link: string, schema: any, spec: unknown): any {
    Proxies._visit(spec, makeRecorder(this._defined(link, schema)));
    return this._proxy;
  }

  /** The new object the entry defines through `link`, made the first time it is written. */
  _defined(link: string, schema: any = null): State {
    const held = this._links.get(link);
    if (held instanceof State) return held;
    if (held !== undefined) {
      throw new ValueError(`link ${repr(link)} links an object a spec does not define: write its members in its own spec`);
    }
    if (schema === null) {
      const kinds = Proxies._linkKinds(this._relation, link);
      if (kinds !== null) {
        throw new TypeError(`link ${repr(link)} is a kind union: define through one of its kinds, ${[...kinds.keys()].join(", ")}`);
      }
      schema = this._store.registered(this._store._filled(this._relation, link));
    }
    const state = new State(this._store, schema);
    this._links.set(link, state);
    return state;
  }

  /** A mapping's value: a callback given the entry, the key already written, or a value given to the one member that
   * accepts it, the entry's link or one of the linked object's properties and adjacencies. */
  _give(link: string, value: unknown): void {
    if (Proxies._isFunction(value)) {
      this._other = link;
      Proxies._visit(value, shell(this));
      if (!this._links.has(link)) this._defined(link); // given no link, it defines the object it links, as a builder's
      return;
    }
    let schema: any = null;
    const takers: [string, string][] = Proxies._links(this._store, this._relation, link, value) ? [["link", link]] : [];
    const declared = this._relation.entry.links.get(link)?.schema;
    const known = declared instanceof S.OfObject.Data && declared.ref || this._store._filling(this._relation, link).length === 1;
    if (known || takers.length === 0) { // where no one schema fills the link, the object it links has no members known
      schema = this._store.registered(this._store._filled(this._relation, link));
      for (const [name, prop] of schema.properties) if (Proxies._holds((prop as any).schema, value)) takers.push(["property", name]);
      for (const [name, adjacency] of schema.adjacencies) {
        if (Proxies._linksThrough(this._store, adjacency, value)) takers.push(["adjacency", name]);
      }
    }
    if (takers.length !== 1) {
      throw new TypeError(`${takers.length === 0 ? "no member" : "more than one member"} of the entry takes ${repr(value)}: `
        + "give a callback");
    }
    const [kind, name] = takers[0] as [string, string];
    if (kind === "link") this._link(link, value);
    else if (kind === "property") makeRecordedProperty(new Recorder(this._defined(link, schema)), name)(value);
    else makeRecordedAdjacency(new Recorder(this._defined(link, schema)), name)([value]);
  }

  plain(): PlainMap {
    const mutations: unknown[] = [];
    for (const [link, held] of this._links) {
      const target = held instanceof State
        ? m([["def", m([["schema", this._store.name_of(held.schema)], ["mutations", held.plain()]])]])
        : m([["ref", held]]);
      mutations.push(m([["as_link", m([["name", link], ["mutations", [m([["set", target]])]]])]]));
    }
    const names = Plain._names(this._store);
    for (const [name, prop] of this._relation.entry.properties) {
      const read = Proxies._makeProperty(new Map([[name, Proxies._built(this._values.get(name) ?? null)]]), name, prop,
        this._store, null, false);
      const [present, plain] = Plain._value(read, (prop as any).schema, names);
      if (present) mutations.push(m([["as_property", m([["name", name], ["mutations", [m([["set", m([["value", plain]])]])]]])]]));
    }
    return m([["mutations", mutations]]);
  }
}

/** A property of an entry a spec inserts. */
class EntryProperty extends Shelled {
  readonly [TYPE_NAME] = "_EntryProperty";

  constructor(readonly _entry: RecordedEntry, readonly _name: string) {
    super();
  }

  _call(spec: unknown): unknown {
    const entry = this._entry;
    Proxies._makeProperty(entry._values, this._name, entry._relation.entry.properties.get(this._name), entry._store,
      entry._proxy, true)(spec);
    return entry._proxy;
  }
}

function makeEntryProperty(entry: RecordedEntry, name: string): any {
  const state = new EntryProperty(entry, name);
  return shell(state, (spec) => state._call(spec));
}

/** A member of the object an entry defines, read through the entry: called, it writes, and gives back the entry, so that
 * an item's clauses chain. */
class Chained extends Shelled {
  readonly [TYPE_NAME] = "_Chained";

  constructor(readonly _wrapped: any, readonly _entry: RecordedEntry) {
    super();
  }

  _call(spec: unknown): unknown {
    this._wrapped(spec);
    return this._entry._proxy;
  }
}

function makeChained(member: unknown, entry: RecordedEntry): any {
  const state = new Chained(member, entry);
  return shell(state, (spec) => state._call(spec));
}

/** How a spec refers to an object it does not define: the symbol that binds it, or its path. A counted object has no
 * path: a spec reaches it through a symbol. */
function reference(store: any, target: unknown): PlainMap {
  const recorder = innerOf(target);
  if (recorder instanceof Recorder) {
    if (recorder._state.symbol === null) throw new ValueError("an object a spec defines is linked where it is defined");
    return m([["symbol", recorder._state.symbol]]);
  }
  target = Proxies._deref(target);
  if (Proxies._isObjectData(target) && Proxies._counted(target)) {
    throw new ValueError(`a counted ${repr(innerOf(target)._schemaName)} has no path: a spec refers to it through a symbol`);
  }
  return m([["path", Plain.ToPlain(store)(store.Paths.OfRoot.as_schema(), Paths.of(target))]]);
}

// --- The executor ---

/** A frame: the objects its symbols bind, by symbol. */
export type Frame = Map<string, any>;

type Members = Map<string, any>[];

/** Executes a transaction's expression over the store, sequentially (docs/OBJECT_IDENTITY.md, Decided, 85 to 89): its
 * stream starts as one frame, empty, which its root term transforms and passes on through `then`. Its writes are held
 * in its proposals and written when it ends, or dropped where it throws. Gives the frames its chain ends with. */
export function _execute(store: any, transaction: any, joined = false): Frame[] {
  const root = next(transaction, "mutations");
  if (root !== null) check(store, root, new Set());
  const write = (): Frame[] => (root === null ? [new Map()] : run(store, root, [new Map()]));
  return joined ? store._joined(write) : store._transacting(write); // a decoder's: a savepoint of the one open
}

/** The term a term's adjacency of one entry links (91): a transaction's root, a term's next; null where it holds none. */
function next(term: any, name: string): any {
  const entries = [...term[name]];
  if (entries.length === 0) return null;
  const me = term.as_schema().adjacencies.get(name).me;
  return entries[0][[...entries[0].as_schema().links.keys()].find((link: string) => link !== me) as string];
}

/** A term's kind: `map`, `reduce`, `partition`, `branch`, `update` or `upsert`. */
function kindOf(store: any, term: any): string {
  return (store.name_of(term.as_schema()) as string).slice("Mutations.Of".length).toLowerCase();
}

/** The pattern a term's adjacency links, refused where it is an expression (87). */
function patternOf(term: any, adjacency: string, kind: string): any {
  const entries = [...term[adjacency]];
  if (entries.length !== 1) throw new ValueError(`${a(kind)} takes one pattern in ${repr(adjacency)}, not ${entries.length}`);
  const pattern = entries[0].pattern;
  if (pattern.variables.size > 0) {
    throw new ValueError(`${a(kind)}'s pattern has variables: transactions bind no variables until expressions are `
      + "evaluated (step 4h)");
  }
  if (pattern.requires.length > 0) {
    throw new ValueError(`${a(kind)}'s pattern requires constraints: transactions evaluate no expressions until step 4h`);
  }
  return pattern;
}

function a(kind: string): string {
  return "aeiou".includes(kind[0] as string) ? `an ${kind}` : `a ${kind}`;
}

/** An adjacency's verbs in a spec, in order, each with the entries it gives: `insert` and `remove` theirs, `clear` none
 * (`Mutations.OfAdjacency`). */
function verbsOf(body: Map<string, any>): [string, Map<string, any>[]][] {
  return body.get("mutations").map((verb: Map<string, any>) => {
    const [kind, given] = only(verb);
    return [kind, kind === "clear" ? [] : given.get("entries")];
  });
}

/** Refuses a spec whose entry, inserted or removed, clears a link, which a spec read from the wire may give: every link
 * of an entry but its object's own is set. An entry's property cleared is left out of the entry inserted. */
function linksSet(spec: Map<string, any[]>[]): void {
  for (const item of spec) {
    for (const members of item.values()) {
      for (const member of members) {
        const [kind, body] = only(member);
        if (kind !== "as_adjacency") continue;
        for (const [, entries] of verbsOf(body)) {
          for (const entry of entries) {
            for (const part of entry.get("mutations")) {
              const [partKind, partBody] = only(part);
              const given = partBody.get("mutations")[0];
              if (partKind === "as_link" && !given.has("set")) {
                throw new ValueError("a spec's entry clears a link: every link of an entry but its object's own is set");
              }
              if (partKind === "as_link" && given.get("set").has("def")) {
                linksSet([new Map([["", given.get("set").get("def").get("mutations")]])]);
              }
            }
          }
        }
      }
    }
  }
}

/** Checks a term and those after it, given the symbols bound before it: that each refers only to symbols a term before
 * it binds (85), and binds no variable and evaluates no expression (87). Gives the symbols bound after the chain. */
function check(store: any, term: any, bound: Set<string>): Set<string> {
  const kind = kindOf(store, term);
  if (kind === "branch") {
    if ([...term.requires].length > 0) {
      throw new ValueError("a branch requires constraints: transactions evaluate no expressions until step 4h");
    }
  } else if ((kind === "map" || kind === "reduce") && [...term.variables].length > 0) {
    throw new ValueError(`${a(kind)} of variables: transactions bind no variables until expressions are evaluated (step 4h)`);
  }
  if (kind === "map" || kind === "upsert") {
    const pattern = patternOf(term, kind === "map" ? "symbols" : "exists", kind);
    symbols(store, pattern);
    linksSet(pattern.spec);
    bound = new Set([...bound, ...pattern.symbols.keys()]);
  } else if (kind === "update") {
    const pattern = patternOf(term, "apply", kind);
    linksSet(pattern.spec);
    unbound(pattern.symbols.keys(), bound, kind);
  } else if (kind === "reduce") {
    const entries = [...term.symbols];
    if (entries.length !== 1) throw new ValueError(`a reduce takes one collector in 'symbols', not ${entries.length}`);
    const collector = entries[0].collector;
    if (collector.suffixes !== null || collector.computes !== null || collector.variables.length > 0) {
      throw new ValueError("a reduce that collects (`suffixes`, `computes`, `variables`): transactions evaluate no "
        + "expressions until step 4h; a reduce drops symbols");
    }
    unbound(collector.symbols, bound, kind);
    bound = new Set([...bound].filter((name) => !collector.symbols.includes(name)));
  } else if (kind === "partition") {
    if (store.member(term, "first") && store.member(term, "last")) {
      throw new ValueError("a partition dispatches to its first matching branch or its last, not both");
    }
    const arms = [...term.branches].map((entry: any) => entry.branch);
    const otherwise = next(term, "none");
    const joined = (otherwise === null ? arms : [...arms, otherwise]).map((arm) => check(store, arm, bound));
    if (joined.length > 0) bound = new Set([...joined[0] as Set<string>].filter((name) => joined.every((held) => held.has(name))));
  }
  const after = next(term, "then");
  return after === null ? bound : check(store, after, bound);
}

function unbound(names: Iterable<string>, bound: Set<string>, kind: string): void {
  for (const name of names) {
    if (!bound.has(name)) throw new ValueError(`symbol ${repr(name)} of ${a(kind)} is bound by no term before it`);
  }
}

/** Refuses a symbol a transaction cannot bind: one of a kind union, or of no reference object schema. */
function symbols(store: any, pattern: any): void {
  for (const [name, symbol] of pattern.symbols) {
    const schema = symbol.schema;
    if (!(schema instanceof S.OfObject.Data) || !schema.ref) {
      throw new ValueError(`symbol ${repr(name)} binds no reference object of one schema: transactions bind objects of an `
        + "object schema");
    }
  }
}

/** Whether `schema` is a meta-schema: its objects are schema objects (`Schemas.OfObject`, ...), written by their builders
 * (Decided, 86). */
function meta(store: any, schema: any): boolean {
  return store._meta_builder(store.name_of(schema)) !== null;
}

/** A visitor of an object, to read: a schema object's builder, read-only, which sees what the transaction open has made
 * of it, or data's proxy. */
function reader(store: any, target: any): any {
  const kind = store._meta_builder_class(target);
  return kind === null ? target : new kind(target, false, store);
}

/** A builder of an object of `schema`, new or `target`: a schema object's by its meta-schema, data's by its schema. */
function writer(store: any, schema: any, target: unknown = null): any {
  const name = store.name_of(schema);
  return meta(store, schema) ? store._meta_builder(name, target) : store.builder(name, target);
}

/** The object an entry links, as read: a schema object's entry gives a link, read through its builder. */
function linked(value: unknown): any {
  return Builders._linked_data(value) ?? value;
}

/** The objects a symbol of `schema` ranges over: a meta-schema's, the named schema objects of its kind the store holds,
 * the framework's left out; data's, those the store reaches from its singletons. */
function extent(store: any, schema: any): any[] {
  if (!meta(store, schema)) return [...store.extent(store.name_of(schema))];
  return [...store._objects].filter((held) => !store.framework(held) && reader(store, held).as_schema() === schema);
}

/** The frames a term, and those after it, make of `frames`: those its chain ends with. */
function run(store: any, term: any, frames: Frame[]): Frame[] {
  const kind = kindOf(store, term);
  if (kind === "map") {
    const pattern = patternOf(term, "symbols", kind);
    frames = frames.flatMap((frame) => bind(store, pattern, frame, false));
  } else if (kind === "upsert") {
    const pattern = patternOf(term, "exists", kind);
    const key = store.member(term, "key");
    frames = frames.flatMap((frame) => bind(store, pattern, frame, true, key));
  } else if (kind === "update") {
    const pattern = patternOf(term, "apply", kind);
    for (const frame of frames) writeSpec(store, pattern, frame);
  } else if (kind === "reduce") {
    const dropped: string[] = [...term.symbols][0].collector.symbols;
    const unique = new Map<string, Frame>();
    for (const frame of frames) {
      const kept: Frame = new Map([...frame].filter(([name]) => !dropped.includes(name)));
      const identity = JSON.stringify([...kept].map(([name, target]) => [name, Proxies._key_of(reader(store, target))]));
      if (!unique.has(identity)) unique.set(identity, kept);
    }
    frames = [...unique.values()];
  } else if (kind === "partition") {
    let arms = [...term.branches].map((entry: any) => entry.branch);
    const first = store.member(term, "first");
    if (arms.length > 0 && (first || store.member(term, "last"))) { // every branch matches, none requiring constraints (87)
      arms = [first ? arms[0] : arms[arms.length - 1]];
    }
    const otherwise = next(term, "none");
    if (arms.length === 0 && otherwise !== null) arms = [otherwise];
    frames = arms.flatMap((arm) => run(store, arm, frames.map((frame) => new Map(frame))));
  }
  const after = next(term, "then");
  return after === null ? frames : run(store, after, frames);
}

/** The frames binding a pattern's symbols that `frame` does not, each to every object of its schema whose members its
 * spec gives hold: a singleton's to the singleton (77). An upsert creates, where none is found, the object of a symbol,
 * and writes its spec where it does not hold; a counted object it created before from the same frame, for the same
 * symbol and key, it finds again (63), and finds none otherwise (102). */
function bind(store: any, pattern: any, frame: Frame, upsert: boolean, key: unknown = null): Frame[] {
  const members = membersOf(pattern);
  let frames: Frame[] = [new Map(frame)];
  for (const [name, symbol] of pattern.symbols) {
    if (frame.has(name)) continue;
    const schema = symbol.schema;
    const grown: Frame[] = [];
    for (const partial of frames) {
      if (schema.singleton !== null) {
        grown.push(new Map([...partial, [name, store.singleton(schema.singleton)]]));
        continue;
      }
      if (upsert && Proxies._counted_schema(schema) && !meta(store, schema)) { // found only by what made it (102)
        const index = _upsert_index(store, key, name, frame);
        let made = store._upserted.get(index)?.deref();
        if (made === undefined) {
          made = writer(store, schema).create();
          store._upserted.set(index, new WeakRef(made));
        }
        grown.push(new Map([...partial, [name, made]]));
        continue;
      }
      const own = members.get(name) ?? [];
      const identifying = own.filter((member) => identifies(store, schema, member));
      const located = identifying.length > 0 ? null : locate(store, pattern, members, name, schema, partial);
      let found: any[];
      if (located !== null) { // placed by its owner's entry, which a symbol bound before it gives (60)
        found = located[0] === null ? [] : [located[0]];
      } else if (identifying.length > 0 && meta(store, schema)) { // a schema object by its name, the store's own included (86)
        found = registeredAs(store, schema, identifying[0]!);
      } else {
        const finding = identifying.length > 0 ? identifying : own;
        found = extent(store, schema).filter((target: unknown) => holds(store, target, schema, finding, partial, partial));
      }
      if (found.length > 0 || !upsert) {
        for (const target of found) grown.push(new Map([...partial, [name, target]]));
        continue;
      }
      grown.push(new Map([...partial, [name, created(store, schema, identifying)]]));
    }
    frames = grown;
  }
  if (upsert) {
    for (const bound of frames) writeSpec(store, pattern, bound);
    return frames;
  }
  return frames.filter((bound) => [...members].every(([name, items]) =>
    holds(store, bound.get(name), pattern.symbols.get(name).schema, items, bound, null)));
}

/** What tells apart a counted object an upsert makes (63): the upsert's key, the symbol, and the objects of the frame
 * that reached it, each as it is told apart in memory. */
function _upsert_index(store: any, key: unknown, name: string, frame: Frame): string {
  return JSON.stringify([key, name, sortedStrings([...frame.keys()])
    .map((bound) => [bound, Proxies._key_of(reader(store, frame.get(bound)))])]);
}

/** The schema object registered under the name a spec gives, where it is of the meta-schema `schema`, a module by its
 * path, the root module where it gives none: none otherwise. */
function registeredAs(store: any, schema: any, member: Map<string, any>): any[] {
  const [, body] = only(member);
  const name = given(body.get("mutations")[0])[1] as string | null;
  if (schema === store.registered("Schemas.OfModule")) {
    const module = store._modules.get(name ?? "");
    return module === undefined ? [] : [module];
  }
  let held: any;
  try {
    held = store.registered(name);
  } catch { // registered throws only LookupError
    return [];
  }
  return reader(store, held).as_schema() === schema ? [held] : [];
}

/** An object an upsert makes where it finds none: a schema object made with the name it was looked up by, so that what
 * links it before its spec is written links a named schema (86). */
function created(store: any, schema: any, identifying: Members): any {
  const builder = writer(store, schema);
  for (const member of identifying) {
    const [kind, body] = only(member);
    if (kind === "as_property") {
      const prop = schema.properties.get(body.get("name"));
      Plain._set(builder, body.get("name"), Plain._decode(prop.schema, body.get("mutations")[0].get("set").get("value"), [], store));
    }
  }
  return builder.create();
}

/** Where a symbol's object is owned through an adjacency it has no name for, the entry that places it in a symbol's spec
 * bound before it (Decided, 60): `[found]`, the owner's entry agreeing with its properties linking it, or `[null]` where
 * the owner holds none; null where no spec gives such an entry. */
function locate(store: any, pattern: any, members: Map<string, Members>, name: string, schema: any,
  frame: Frame): [unknown] | null {
  const owning = [...schema.adjacencies.values(), ...schema.anonymous].filter((a: any) => a.owner);
  for (const [other, items] of members) {
    if (!frame.has(other) || owning.length === 0) continue;
    for (const item of items) {
      const [kind, body] = only(item);
      if (kind !== "as_adjacency") continue;
      const relation = pattern.symbols.get(other).schema.adjacencies.get(body.get("name")).relation;
      for (const entry of verbsOf(body).filter(([verb]) => verb === "insert").flatMap(([, entries]) => entries)) {
        const parts: Map<string, any>[] = entry.get("mutations");
        const link = parts.find((part) => part.has("as_link")
          && part.get("as_link").get("mutations")[0].get("set").get("ref")?.get("symbol") === name)?.get("as_link").get("name");
        if (link === undefined || !owning.some((a: any) => a.relation === relation && a.me === link)) continue;
        const properties = parts.filter((part) => part.has("as_property")).map((part) => part.get("as_property"));
        for (const held of reader(store, frame.get(other))[body.get("name")]) {
          if (properties.every((p) => agree(plainOf(store, held[p.get("name")], relation.entry.properties.get(p.get("name"))),
            given(p.get("mutations")[0])))) return [linked(held[link])];
        }
        return [null];
      }
    }
  }
  return null;
}

/** Whether a spec's member gives its object's identity, by which an upsert finds it: a schema object's name (86), an
 * owned object's owning entry (60). */
function identifies(store: any, schema: any, member: Map<string, any>): boolean {
  const [kind, body] = only(member);
  if (kind === "as_property") return body.get("name") === "name" && meta(store, schema);
  return kind === "as_adjacency" && schema.adjacencies.get(body.get("name")).owner
    && verbsOf(body).some(([verb]) => verb === "insert");
}

/** A pattern's spec, by symbol: the members of each, its items in order. */
function membersOf(pattern: any): Map<string, Members> {
  const members = new Map<string, Members>();
  for (const item of pattern.spec as Map<string, Members>[]) {
    for (const [name, written] of item) {
      if (!members.has(name)) members.set(name, []);
      (members.get(name) as Members).push(...written);
    }
  }
  return members;
}

/** A spec item's one member: its kind and its body. */
function only(item: Map<string, any>): [string, any] {
  return [...item][0] as [string, any];
}

/** Whether what a spec gives of an object holds of `target`: its properties' values, the entries it inserts held, and
 * those it removes absent, none where it clears the adjacency. Finding the object of a symbol (`partial`, the frame as
 * bound so far), an entry linking a symbol not yet bound is left out. */
function holds(store: any, target: any, schema: any, members: Members, frame: Frame, partial: Frame | null): boolean {
  const visitor = reader(store, target);
  for (const member of members) {
    const [kind, body] = only(member);
    if (kind === "spec") {
      if (Json.dumps(visitor._working.spec) !== Json.dumps(body.get("items"))) return false;
      continue;
    }
    const name = body.get("name");
    if (kind === "as_property") {
      if (!agree(plainOf(store, visitor[name], schema.properties.get(name)), given(body.get("mutations")[0]))) return false;
      continue;
    }
    const relation = schema.adjacencies.get(name).relation;
    const held = [...visitor[name]];
    const unmatched = [...held];
    for (const [verb, entries] of verbsOf(body)) {
      if (verb === "clear" && held.length > 0) return false;
      for (const entry of entries) {
        if (partial !== null && symbolRefs(entry).some((ref) => !partial.has(ref.get("symbol")))) continue;
        if (verb === "insert" && match(store, relation, unmatched, entry, frame) === null) return false;
        if (verb === "remove" && removedOf(store, relation, held, [entry], frame).length > 0) return false;
      }
    }
  }
  return true;
}

/** The references to symbols an entry gives, its own and those of the objects it defines. */
function symbolRefs(entry: Map<string, any>): Map<string, any>[] {
  const found: Map<string, any>[] = [];
  for (const item of entry.get("mutations")) {
    const [kind, body] = only(item);
    if (kind === "as_link") {
      const held = body.get("mutations")[0].get("set");
      if (held.has("ref") && held.get("ref").has("symbol")) {
        found.push(held.get("ref"));
      } else if (held.has("def")) {
        for (const member of held.get("def").get("mutations")) {
          const [memberKind, memberBody] = only(member);
          if (memberKind === "as_adjacency") {
            for (const [, nested] of verbsOf(memberBody)) for (const given of nested) found.push(...symbolRefs(given));
          }
        }
      }
    }
  }
  return found;
}

/** A property's value, read, as a spec gives it: `[present, plain]`. */
function plainOf(store: any, read: any, prop: any): [boolean, unknown] {
  return Plain._value(read, prop.schema, Plain._names(store));
}

/** A spec's property verb as `[present, plain]`. */
function given(verb: Map<string, any>): [boolean, unknown] {
  return verb.has("set") ? [true, verb.get("set").get("value")] : [false, null];
}

function agree([present, plain]: [boolean, unknown], [wanted, value]: [boolean, unknown]): boolean {
  return present === wanted && (!present || Plain._symbol(plain) === Plain._symbol(value));
}

/** Whether an entry held, read, is one a spec gives: the objects it links, and its properties' values. */
function matches(store: any, relation: any, held: any, entry: Map<string, any>, frame: Frame): boolean {
  for (const item of entry.get("mutations")) {
    const [kind, body] = only(item);
    const name = body.get("name");
    if (kind === "as_property") {
      if (!agree(plainOf(store, held[name], relation.entry.properties.get(name)), given(body.get("mutations")[0]))) return false;
      continue;
    }
    const target = linked(held[name]);
    const wanted = body.get("mutations")[0].get("set");
    if (wanted.has("def")) {
      const definition = wanted.get("def");
      const schema = store.registered(definition.get("schema"));
      if (reader(store, target).as_schema() !== schema
        || !holds(store, target, schema, definition.get("mutations"), frame, null)) return false;
    } else if (target !== resolve(store, wanted.get("ref"), frame)) {
      return false;
    }
  }
  return true;
}

/** The object a spec's reference names: the one a symbol binds, or the one at a path. */
function resolve(store: any, ref: Map<string, any>, frame: Frame): any {
  if (ref.has("symbol")) return frame.get(ref.get("symbol"));
  const found = Plain._by_path(store, ref.get("path"), []);
  if (found === null || found === undefined) throw new LookupError("no object of the store has the path a spec refers to");
  return found;
}

/** Writes a pattern's spec over a frame where it does not hold (Decided, 76). */
function writeSpec(store: any, pattern: any, frame: Frame): void {
  for (const [name, members] of membersOf(pattern)) write(store, frame.get(name), pattern.symbols.get(name).schema, members, frame);
}

/** Writes what a spec gives of an object where it does not hold: a property's value, an entry, its links resolved and the
 * objects it defines made, and a pattern's spec, as recorded. */
function write(store: any, target: any, schema: any, members: Members, frame: Frame): void {
  for (const member of members) {
    const [kind, body] = only(member);
    if (kind === "spec") {
      if (!holds(store, target, schema, [member], frame, null)) {
        const builder = writer(store, schema, target);
        builder._working.spec = body.get("items").map((item: Map<string, any>) => new Map(item)); // in place of what it held
        builder.update();
      }
      continue;
    }
    const name = body.get("name");
    if (kind === "as_property") {
      const prop = schema.properties.get(name);
      const verb = body.get("mutations")[0];
      if (agree(plainOf(store, reader(store, target)[name], prop), given(verb))) continue;
      const builder = writer(store, schema, target);
      Plain._set(builder, name, verb.has("set") ? Plain._decode(prop.schema, verb.get("set").get("value"), [], store) : null);
      builder.update();
      continue;
    }
    const adjacency = schema.adjacencies.get(name);
    for (const [verb, entries] of verbsOf(body)) {
      const held = [...reader(store, target)[name]];
      if (verb !== "insert") {
        remove(store, target, schema, name, verb === "clear" ? null : entries, held, frame);
        continue;
      }
      for (const entry of entries) {
        if (match(store, adjacency.relation, held, entry, frame) === null) {
          insert(store, target, schema, name, adjacency, entry, frame);
        }
      }
    }
  }
}

/** The positions of the entries `held` that agree with one of the entries a spec removes. */
function removedOf(store: any, relation: any, held: any[], entries: Map<string, any>[], frame: Frame): number[] {
  return held.flatMap((candidate, index) =>
    (entries.some((entry) => matches(store, relation, candidate, entry, frame)) ? [index] : []));
}

/** Removes from an object's adjacency, `held` as read, each entry that agrees with one of `entries`, a spec's removal,
 * or every entry where it gives null (`clear`); through the object's builder, which removes the entries it holds at
 * those positions, so that removing an owning entry deletes what it owned (Decided, 48). */
function remove(store: any, target: any, schema: any, name: string, entries: Map<string, any>[] | null, held: any[],
  frame: Frame): void {
  const relation = schema.adjacencies.get(name).relation;
  const removed = entries === null ? held.map((_, index) => index) : removedOf(store, relation, held, entries, frame);
  if (removed.length === 0) return;
  const builder = writer(store, schema, target);
  const member = builder[name];
  const written = [...member];
  for (const index of removed) member.remove(written[index]);
  builder.update();
}

/** The first of the entries `held` that agrees with an entry a spec gives, taken from them, so that the k-th equal entry a
 * spec gives is the k-th such entry held; null where none agrees. */
function match(store: any, relation: any, held: any[], entry: Map<string, any>, frame: Frame): unknown {
  const index = held.findIndex((candidate) => matches(store, relation, candidate, entry, frame));
  return index < 0 ? null : held.splice(index, 1)[0];
}

/** A builder of an object a spec defines where an adjacency `name` of an object of `schema` links it: the one that
 * adjacency's member declares, where it builds `defined`'s kind (a pattern's `requires`, a constraint, whose result is
 * the store's `Schemas.OfBool`), as a builder's member does; else `defined`'s own. */
function defining(store: any, schema: any, name: string, defined: any): any {
  const owner = store._meta_builder_class_of(schema);
  const member = owner !== null ? owner._table.get(name) : undefined;
  const builder: any = member instanceof Builders._Members && member.build !== null ? member._builderClass() : null;
  if (builder !== null && store._meta[builder._meta] === defined) return new builder(null, true, store);
  return writer(store, defined);
}

/** Adds an entry a spec gives to an object's adjacency, replacing the one it holds where it holds one at most. */
function insert(store: any, target: any, schema: any, name: string, adjacency: any, entry: Map<string, any>,
  frame: Frame): void {
  const links = new Map<string, unknown>();
  const values = new Map<string, unknown>();
  for (const item of entry.get("mutations")) {
    const [kind, body] = only(item);
    if (kind === "as_property") {
      const verb = body.get("mutations")[0];
      if (verb.has("set")) { // a property cleared: the entry is inserted without it
        const prop = adjacency.relation.entry.properties.get(body.get("name"));
        values.set(body.get("name"), Plain._decode(prop.schema, verb.get("set").get("value"), [], store));
      }
      continue;
    }
    const target = body.get("mutations")[0].get("set");
    if (target.has("def")) {
      const definition = target.get("def");
      const defined = store.registered(definition.get("schema"));
      const made = defining(store, schema, name, defined).create();
      write(store, made, defined, definition.get("mutations"), frame);
      links.set(body.get("name"), made);
    } else {
      links.set(body.get("name"), resolve(store, target.get("ref"), frame));
    }
  }
  const fill = (added: any): any => {
    for (const [link, linked] of links) added[link](linked);
    for (const [prop, value] of values) Plain._set(added, prop, value);
    return added;
  };
  const builder = writer(store, schema, target);
  const member = builder[name];
  if (Proxies._single(adjacency.relation, adjacency.me)) member((held: any) => held.remove((old: any) => old)); // one at most: replaced
  member((held: any) => held.insert(fill));
  builder.update();
}
