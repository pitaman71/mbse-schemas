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
 * a log writes an entry, leaving out the object's own link. A link refers to the object another symbol binds, `{"ref":
 * {"symbol": "ada"}}`, to an object by its path, `{"ref": {"path": ...}}` (a schema object, a singleton or an owned
 * object), or defines a new object where it is linked, `{"def": {"schema": ..., "mutations": [...]}}`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { ValueError } from "./Errors.js";
import * as Paths from "./Paths.js";
import * as Plain from "./Plain.js";
import * as Proxies from "./Proxies.js";
import { repr, TYPE_NAME } from "./Repr.js";

const { _Shelled: Shelled, _shell: shell, _innerOf: innerOf } = Proxies;

type PlainMap = Map<string, unknown>;

const m = (entries: [string, unknown][]): PlainMap => new Map(entries);

/** The mutations a spec's callback records over a frame of `symbols`, by symbol (a `Mutations.OfPattern`). */
export function _recorded(store: any, symbols: Map<string, any>, spec: unknown): PlainMap {
  const frame = new Frame(store, symbols);
  Proxies._visit(spec, shell(frame));
  return new Map([...frame._states].filter(([, state]) => state.written.length > 0)
    .map(([name, state]) => [name, state.plain()]));
}

/** The frame a spec is written over: its members are the pattern's symbols, each the recording visitor of the object it
 * binds. */
class Frame extends Shelled {
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
  /** ["property", name] or ["adjacency", [name, entries]], in order. */
  readonly written: [string, unknown][] = [];

  constructor(readonly store: any, readonly schema: any, readonly symbol: string | null = null) {}

  plain(): unknown[] {
    const names = Plain._names(this.store);
    const members: unknown[] = [];
    for (const [kind, what] of this.written) {
      if (kind === "property") {
        const prop = this.schema.properties.get(what);
        const read = Proxies._makeProperty(this.values, what as string, prop, this.store, null, false);
        const [present, plain] = Plain._value(read, prop.schema, names);
        const verb = present ? m([["set", m([["value", plain]])]]) : m([["clear", new Map()]]);
        members.push(m([["as_property", m([["name", what], ["mutations", [verb]]])]]));
      } else {
        const [name, entries] = what as [string, RecordedEntry[]];
        members.push(m([["as_adjacency", m([["name", name], ["mutations", [
          m([["insert", m([["entries", entries.map((entry) => entry.plain())]])]])]]])]]));
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
    this._visitor()(spec);
    this._note();
    return this._recorder._proxy;
  }

  override _member(name: string): unknown {
    return this._visitor()[name];
  }
}

function makeRecordedProperty(recorder: Recorder, name: string): any {
  const state = new RecordedProperty(recorder, name);
  return shell(state, (spec) => state._call(spec));
}

/** An adjacency of a recorded object: its entries inserted, recorded. Called with a callback, it visits through it; with
 * an iterable, the peer shorthand, each item an entry's callback or the object to link; with a mapping, where its
 * relation has two links and one property, each item an entry keyed by that property (FRAMEWORK.md, Resolved, Mappings
 * for keyed adjacencies). */
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

  _record(entries: RecordedEntry[]): void {
    this._recorder._state.written.push(["adjacency", [this._name, entries]]);
  }

  insert(spec: unknown): any {
    const entry = new RecordedEntry(this._recorder._state.store, this._schema.relation, this._schema.me);
    Proxies._visit(spec, shell(entry));
    this._record([entry]);
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

  /** Links what `target` gives: an object another symbol binds, one a path names, or a new one a callback defines. */
  _link(link: string, target: unknown): any {
    if (Proxies._isFunction(target)) {
      const store = this._store;
      const kinds = Proxies._linkKinds(this._relation, link);
      if (kinds !== null) {
        throw new TypeError(`link ${repr(link)} is a kind union: define through one of its kinds, ${[...kinds.keys()].join(", ")}`);
      }
      return this._define(link, store.registered(store._filled(this._relation, link)), target);
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
      return;
    }
    const schema = this._store.registered(this._store._filled(this._relation, link));
    const takers: [string, string][] = Proxies._links(this._store, this._relation, link, value) ? [["link", link]] : [];
    for (const [name, prop] of schema.properties) if (Proxies._holds((prop as any).schema, value)) takers.push(["property", name]);
    for (const [name, adjacency] of schema.adjacencies) {
      if (Proxies._linksThrough(this._store, adjacency, value)) takers.push(["adjacency", name]);
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
      const read = Proxies._makeProperty(this._values, name, prop, this._store, null, false);
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
