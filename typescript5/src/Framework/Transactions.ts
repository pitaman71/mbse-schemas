/**
 * Transactions: the writes to a store, as mutation expressions over streams of frames ([FEA-027: mutations as queries](mbse:mbse-basis/docs/features/FEA-027.md);
 * object identity 38 to 97 in [FEA-030: clean mutation-based transactional API](mbse:mbse-basis/docs/features/FEA-030.md)).
 *
 * A pattern's `spec` says what must hold of a frame: the property values the objects its symbols bind have, and the
 * relation entries that link them (object identity 76 in [CAP-137: patterns of symbols, variables and specs](mbse:mbse-basis/docs/capabilities/CAP-137.md#decided)). It is written in the builders' own notation, over the frame, whose
 * members are the pattern's symbols, each a visitor of the object it binds that records mutations rather than writing
 * objects (58, 95):
 *
 *     (_: any) => _.bob.name("Bob").knows([_.ada])
 *
 * A spec is recorded as a `Mutations.OfPattern`, plain data: for each symbol, the mutations of the object it binds, in
 * order. A property written is `{"as_property": {"name": ..., "mutations": [{"set": {"value": ...}}]}}`, its value as
 * `Plain` writes a property's; an adjacency's entries are `{"as_adjacency": {"name": ..., "mutations": [{"insert":
 * {"entries": [...]}}]}}`, each entry `{"mutations": [...]}` of its links (`as_link`) and properties (`as_property`), as
 * a snapshot writes an entry, leaving out the object's own link. A link's `reference` names the object another symbol
 * binds, `{"reference": {"symbol": "ada"}}`, or an object by its path, `{"reference": {"path": ...}}` (a schema object, a
 * singleton or an owned object), as `References.OfObject` writes one; or the link defines a new object where it is linked, `{"def": {"schema": ..., "mutations": [...]}}`. An adjacency's
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
 * Within a transaction, `store.transaction((txn: any = null) => { ... })`, the transaction open (`Transaction`, a first
 * piece of [the transaction-object proposal](mbse:mbse-schemas/docs/proposals/transaction-object/README.md)) executes the suffix of a transaction's expression, a `Remainder`, over
 * input frames with `txn.exec(frame, remainder, allow_write)`, giving a stream of frames, an observable of the
 * framework's own (`Observable`), and opening and committing no transaction of its own ([CAP-308: stacking by mutation transactions, in one round trip](mbse:mbse-basis/docs/capabilities/README.md#CAP-308); [the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)):
 * each frame carries the id of its input frame, `scope`, and each input frame's frames end with its completion marker,
 * `{"end": scope}`. Writing, it interprets the expression fully; `store.transaction(spec)` collects its stream over one
 * empty frame. Read-only, it interprets over what the store holds, writing nothing: where it holds nothing to bind a
 * symbol, or a term would write, the frame halts, given as bound so far, carrying its `remainder`; the same transaction
 * completes it, writing, as the loopback of a store with no layer below. A partition keeps its join: the rest of a
 * branch a frame halted in is executed by the loopback, within the transaction. All of it commits, or is dropped, with
 * the scope.
 *
 * A symbol of a meta-schema (`store.Schemas.OfObject`, ...) binds schema objects: a module's `install(txn)` upserts its
 * schemas, each found by its name, so that a transaction defines and extends schemas (object identity 86 in [CAP-115: schemas defined by idempotent installs](mbse:mbse-basis/docs/capabilities/CAP-115.md#decided)).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Builders from "./Builders.js";
import * as Changes from "./Changes.js";
import { LookupError, path as plainPath, ValueError } from "./Errors.js";
import * as Json from "./JSON.js";
import * as Paths from "./Paths.js";
import * as Plain from "./Plain.js";
import * as Proposals from "./Proposals.js";
import * as Provenance from "./Provenance.js";
import * as Proxies from "./Proxies.js";
import * as References from "./References.js";
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
    let state = this._states.get(name);
    if (state === undefined) {
      state = new State(this._store, _recordedSchema(this._store, name, symbol), name);
      this._states.set(name, state);
    }
    return makeRecorder(state);
  }

  override _repr(): string {
    return "<frame>";
  }
}

/** The `References.OfObject` a pattern's symbol is given in place of a schema (`Schemas.OfSymbol`'s `reference`, which
 * `References.install` adds); null where it is given none. */
export function _givenReference(symbol: any): any {
  return Proxies._built(symbol._extended?.get("reference") ?? null);
}

/** A symbol's reference, refused where it has both a schema and a reference, or neither (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)). */
export function _exactlyOne(name: string, symbol: any, error: new (message: string) => Error): any {
  const reference = _givenReference(symbol);
  if ((reference === null) === (symbol.schema === null)) {
    const given = reference === null ? "neither a schema nor a reference" : "both a schema and a reference";
    throw new error(`symbol ${repr(name)} has ${given}: a symbol has exactly one`);
  }
  return reference;
}

/** The schema of the object a symbol binds, by which its spec items are written (its mutation builder's, Object
 * identity, Decided, 58 and 76): its own, or, given a reference, that of the object the reference designates where the
 * store holds it, else, or where it is not present, the schema its path implies, through the store's schemas alone
 * (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)); refused where the path
 * cannot be followed. */
export function _recordedSchema(store: any, name: string, symbol: any): any {
  const reference = _exactlyOne(name, symbol, TypeError);
  if (reference === null) return symbol.schema;
  const path = (Plain.ToPlain(store)(reference.as_schema(), reference) as Map<string, unknown>).get("path") as Map<string, unknown>;
  const target = References._designated(store, reference);
  if (target != null) return reader(store, target).as_schema();
  try {
    return References._implied(store, path);
  } catch (error) {
    throw new LookupError(`symbol ${repr(name)} is given a reference whose path ${(error as Error).message}: a spec writes `
      + "what its object's schema declares");
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
 * one property, each item an entry keyed by that property (mappings for keyed adjacencies, [CAP-107: one visitor protocol reads and writes data](mbse:mbse-basis/docs/capabilities/CAP-107.md#decided)). */
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
    if (Proxies._is_parameter(Proxies._durable(value))) { // in the place of the object the entry links (CAP-312)
      this._link(link, value);
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
        : m([["reference", held]]);
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
  if (Proxies._is_parameter(Proxies._durable(target)) || Proxies._parameter_in(target) !== null) {
    return Plain._marked(store, Proxies._parameter_in(target) ?? target); // in the object's place (CAP-312)
  }
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

/** An error annotated on a frame ([CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)): where in the expression it arose,
 * `subterm`, the term that was processing the frame, by its path in the transaction's expression on the wire
 * (`Plain.ToPlain(store).Transaction`), as a decoding error locates what it reads there
 * (`$.mutations[0].map.then[0].update`); its `kind`, the name of the error's class (`ValueError`); and its `message`.
 * `error` is the error itself, where it arose here, null where the annotation was made otherwise. */
export class FrameError {
  constructor(readonly subterm: string, readonly kind: string, readonly message: string,
    readonly error: unknown = null) {}

  /** Whether `other` is the same annotation: its subterm, kind and message, the error itself not compared. */
  equals(other: unknown): boolean {
    return other instanceof FrameError && other.subterm === this.subterm && other.kind === this.kind
      && other.message === this.message;
  }
}

/** The suffix of a transaction's expression yet to be executed over a frame ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)): the term
 * at `at`, its path in the expression's wire form (`["mutations", 0, "map", "then", 0, "update"]`, which `subterm`
 * writes `$.mutations[0].map.then[0].update`), and the terms after it in its chain, through `then`, to the end of the
 * transaction, or of the branch it is in. A position in `transaction`, the original expression, not a copy of it: as it
 * is a suffix, no rewrite is required. Where a frame halts within a term, a map that bound some of its symbols and not
 * the rest, the term is the remainder's first, and the frame binds those symbols: executed again over it, the term binds
 * the rest, as a term binds only the symbols its frame does not. */
export class Remainder {
  readonly at: readonly (string | number)[];

  constructor(readonly transaction: any, at: readonly (string | number)[]) {
    this.at = [...at];
  }

  /** Where the remainder starts, as `FrameError.subterm` writes it; `$` for an expression of no term. */
  get subterm(): string {
    return plainPath(...this.at);
  }

  /** Whether `other` is the same position in the same expression. */
  equals(other: unknown): boolean {
    return other instanceof Remainder && other.transaction === this.transaction && other.at.length === this.at.length
      && other.at.every((step, index) => step === this.at[index]);
  }

  toString(): string {
    return `<remainder ${this.subterm}>`;
  }
}

/** A frame: the objects its symbols bind, by symbol, a `Map`; and its `errors`, each what failed as a term processed
 * it ([CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)), none where none did.
 *
 * One `store.transaction` or `txn.exec` gives back holds bindings and assignments, not visitors ([CAP-315: every read
 * within a transaction or through a follow](mbse:mbse-basis/docs/capabilities/CAP-315.md#decided)): each symbol's object by its reference, a `References.OfObject`, a value that
 * outlives the transaction (a schema object, which the rule does not cover, as itself); and `assigns`, by symbol, the
 * values the transaction left in the properties its terms' specs name for it, as data, harvested within it. A counted
 * object has no reference: the frame refuses it, its symbol read throwing `LookupError`, and assigns nothing of it.
 *
 * One `txn.exec` gives also carries `scope`, the id of the input frame it descends from, and, where it halted
 * unfinished, its `remainder`, the suffix of the expression yet to be executed over it (`Remainder`); null where it is
 * complete. Given to `txn.exec`, a frame's `scope` is its id, where it has one.
 *
 * And its `journal`: the changes made in interpreting its input frame, as a `Changes.Journal` of one transaction, whose
 * symbols are its own, its id the transaction's uid and the frame's position in the stream (`uid#n`), carried by the
 * first frame the input frame gives, so that applying each frame's journal by `Changes.apply` applies each change once,
 * the counted objects of each frame apart; null where it carries none
 * ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)). */
export class Frame extends Map<string, any> {
  readonly errors: FrameError[];
  readonly assigns: Map<string, Map<string, unknown>>;
  remainder: Remainder | null;
  scope: string | null;
  journal: any;

  constructor(bound: Iterable<readonly [string, any]> | null = null, errors: Iterable<FrameError> = [],
    assigns: Iterable<readonly [string, Map<string, unknown>]> = [], remainder: Remainder | null = null,
    scope: string | null = null, journal: any = null) {
    super(bound);
    this.errors = [...errors];
    this.assigns = new Map([...assigns].map(([name, values]) => [name, new Map(values)]));
    this.remainder = remainder;
    this.scope = scope;
    this.journal = journal;
  }

  override get(name: string): any {
    const found = super.get(name);
    if (found instanceof _Refused) throw new LookupError(`symbol ${repr(name)} of the frame: ${found.message}`);
    return found;
  }
}

/** What a frame given back holds for a symbol that binds a counted object, which has no reference: refused, saying
 * why. */
export class _Refused {
  /** `target`, the object it binds, given again to `exec` within the transaction that gave it, whose life is `life`, so
   * that a frame halted there is resumed there. */
  constructor(readonly message: string, readonly target: unknown = null, readonly life: unknown = null) {}

  toString(): string {
    return "<refused: a counted object>";
  }
}

/** An item of `txn.exec`'s stream: a frame, or the completion marker of the input frame or branch whose id is its
 * `end`, `{"end": scope}`, a `Map`, carrying the journal of an input frame that gave no frame, `journal`. */
export type Item = Frame | Map<string, any>;

/** Who is given a stream's items: its subscription by `start`, before any item, then each item by `next`, then
 * `complete`, or `error` where it ends with one. */
export interface Observer<T> {
  start?(subscription: Subscription): void;
  next?(value: T): void;
  error?(error: unknown): void;
  complete?(): void;
}

/** What `subscribe` gives back: `unsubscribe` ends the subscription, and `closed` says whether it has ended. */
export interface Subscription {
  unsubscribe(): void;
  readonly closed: boolean;
}

/** A stream of items, given to each subscriber as it subscribes: the framework's own, its core depending on no package
 * ([CAP-310: a cache layer's partial-aware interpretation](mbse:mbse-basis/docs/capabilities/CAP-310.md#decided-by-an-agent-for-review)), shaped as the ECMAScript Observable proposal and RxJS have it,
 * so that either takes it (`from(observable)`, through its `"@@observable"` member). `subscribe` takes an observer, or
 * its `next`, `error` and `complete`, and gives back a `Subscription`, which it gives the observer's `start` first, as
 * the proposal does. A store's stream is produced synchronously, within `subscribe`; unsubscribed from within `next`, it
 * is given nothing more. */
export class Observable<T> {
  constructor(private readonly produce: (observer: Observer<T> & { readonly closed: boolean }) => void) {}

  subscribe(observer: Observer<T> | ((value: T) => void) = {}, error?: (error: unknown) => void,
    complete?: () => void): Subscription {
    const given: Observer<T> = typeof observer === "function" ? { next: observer, error, complete } : observer;
    let closed = false;
    const subscription: Subscription = {
      unsubscribe: () => { closed = true; },
      get closed() { return closed; },
    };
    given.start?.(subscription);
    this.produce({
      next: (value) => given.next?.(value),
      error: (thrown) => {
        closed = true;
        given.error?.(thrown);
      },
      complete: () => {
        closed = true;
        given.complete?.();
      },
      get closed() { return closed; },
    });
    return subscription;
  }

  /** Itself, as the ECMAScript Observable proposal and RxJS ask of what they take. */
  ["@@observable"](): Observable<T> {
    return this;
  }
}

/** The frames a transaction gives back, made within it: each symbol's object by its reference, and what it assigns, as
 * data (CAP-315); each carrying `scope`, and its remainder where it halted. */
function givenBack(store: any, frames: Frame[], named: Map<string, string[]>, scope: string | null = null): Frame[] {
  if (store._unowned.length > 0) store._settle_owners(); // the owners the store gives, so that each object has its path
  return frames.map((frame) => {
    const bound: [string, any][] = [];
    const assigns = new Map([...frame.assigns].map(([name, values]) => [name, new Map(values)])); // a layer below's
    for (const [symbol, target] of Map.prototype.entries.call(frame) as IterableIterator<[string, any]>) {
      if (!Proxies._isObjectData(target)) {
        bound.push([symbol, target]); // a schema object, as itself
        continue;
      }
      const state = Proxies._stateOf(target);
      if (Proxies._counted(target)) {
        bound.push([symbol, new _Refused(`a counted ${repr(state._schemaName)} has no reference: nothing names it (make `
          + "it a singleton's or an owner's)", target, store._life)]);
        continue;
      }
      if (Proxies._deleted(target)) {
        bound.push([symbol, new _Refused(`a ${repr(state._schemaName)} the transaction deleted has no reference: `
          + "nothing designates it")]);
        continue;
      }
      bound.push([symbol, References.of(store, target)]);
      const values: Map<string, unknown> = store.values(state);
      const held = new Map((named.get(symbol) ?? []).filter((name) => values.has(name))
        .map((name) => [name, Proxies._copied(values.get(name))] as const));
      if (held.size > 0) assigns.set(symbol, new Map([...assigns.get(symbol) ?? [], ...held]));
    }
    return new Frame(bound, frame.errors, assigns, frame.remainder, scope);
  });
}

/** A transaction a frame of which is annotated with an error: dropped, whole (CAP-124). */
class Uncommitted extends Error {}

/** A stream unsubscribed from: given nothing more. */
class Unsubscribed extends Error {}

type Members = Map<string, any>[];

/** The objects a frame binds, by symbol, as the executor binds them. */
type Bound = Map<string, any>;

/** `frames`, where none is annotated with an error; else the first error annotated is thrown, the one that arose
 * first, as it arose, its `frames` all the frames, those annotated among them ([CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)). */
export function _raised(frames: Frame[]): Frame[] {
  const failed = frames.find((frame) => frame.errors.length > 0);
  if (failed !== undefined) {
    const error = failed.errors[0]!.error as any; // annotated here
    error.frames = frames;
    throw error;
  }
  return frames;
}

/** Executes a transaction's expression over the store, sequentially (object identity 85 to 89 in [FEA-030: clean mutation-based transactional API](mbse:mbse-basis/docs/features/FEA-030.md)): its
 * stream starts as one frame, empty, which its root term transforms and passes on through `then`, within a savepoint of
 * the transaction open. Gives the frames its chain ends with, as bound, the library's own (a decoder's, a cache layer's
 * applying what the layer below changed). Where a frame is annotated with an error, it writes nothing and throws the
 * first error annotated (`_raised`). */
export function _execute(store: any, transaction: any): Frame[] {
  return _raised(_frames(store, transaction));
}

/** The frames a transaction's expression gives, throwing nothing for an error a term meets processing a frame: that
 * frame is annotated with it, as bound as it was, and the others go on ([CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)). Gives the frames its chain
 * ends with, then those annotated, in the order their errors arose; where one is, its writes are dropped, whole
 * (CAP-124), else committed into the transaction open. An error in the expression itself, found
 * before it runs, is thrown, its `frames` none; one thrown at the commit, which no frame made, is thrown as it is, its
 * `frames` all the frames, none annotated. What `txn.exec` gives, as a stream, is `_exec`'s. */
export function _frames(store: any, transaction: any): Frame[] {
  const root = next(transaction, "mutations");
  let made: Frame[] = [];
  const write = (): void => {
    const state = new Run(transaction, true, new Map(), null);
    made = root === null ? [new Frame()] : run(store, root, [new Frame()], ["mutations", 0, kindOf(store, root)], state);
    made.push(...state.failed);
    if (state.failed.length > 0) throw new Uncommitted();
  };
  try {
    if (root !== null) check(store, root, new Set());
    store._joined(write); // a savepoint of the one open
  } catch (error) {
    if (error instanceof Uncommitted) return made;
    (error as any).frames = made;
    throw error;
  }
  return made;
}

/** What `txn.exec` is given to execute: a remainder as it is, or a whole transaction's expression, from its root term;
 * at `[]` where it has none. */
export function _remainder(store: any, transaction: any): Remainder {
  if (transaction instanceof Remainder) return transaction;
  const root = next(transaction, "mutations");
  return new Remainder(transaction, root === null ? [] : ["mutations", 0, kindOf(store, root)]);
}

/** The term at `at` in a transaction's expression, its path in the wire form: each step an adjacency of one entry
 * (`mutations`, `then`, `none`), its index and the kind of the term it links, or `branches` and a branch's index. */
function termAt(transaction: any, at: readonly (string | number)[]): any {
  let term = transaction;
  let step = 0;
  while (step < at.length) {
    if (at[step] === "branches") {
      term = [...term.branches][at[step + 1] as number].branch;
      step += 2;
    } else {
      term = next(term, at[step] as string);
      step += 3;
    }
  }
  return term;
}

/** The transaction open on a store, an object of its own, which the imperative scope gives its function,
 * `store.transaction((txn: any = null) => { ... })`: a first piece of [the transaction-object proposal](mbse:mbse-schemas/docs/proposals/transaction-object/README.md), holding the
 * transaction, and executing expressions within it (`exec`). Its writes commit, or are dropped, with the scope: where a
 * frame its `exec` gave is annotated with an error, the scope commits nothing, throwing the first error annotated
 * (CAP-309). It lives within its transaction: used after it ends, it is refused. */
export class Transaction {
  /** Every frame its `exec` gave, in order. */
  readonly _given: Frame[] = [];

  constructor(readonly _store: any, readonly _life: { readonly ended: boolean }) {}

  /** Executes the suffix of a transaction's expression over input frames, within this transaction, giving a stream of
   * frames, an observable, produced as each subscriber subscribes ([CAP-308: stacking by mutation transactions, in one round trip](mbse:mbse-basis/docs/capabilities/README.md#CAP-308), [the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)). It
   * opens and commits no transaction of its own.
   *
   * `frame` is the current execution frame, the symbols bound so far, each by its reference, a schema object as itself
   * (`Frame`, or any `Map`); or a stream of them, an iterable each item of which is taken as it arrives. `remainder` is
   * what is yet to be executed: a `Remainder`, as a frame that halted carries it, or a whole transaction, as
   * `store.transaction` takes it. Where `allow_write` is true, the expression is interpreted fully, writing; where false,
   * read-only, over what the store holds: where it holds nothing to bind a symbol, or a term would write, the frame
   * halts, and is given as bound so far, carrying its `remainder`, which `txn.exec(halted, halted.remainder, true)`
   * completes, in the same transaction, a counted object it binds among it. A partition keeps its join: a frame that
   * halts within one of its branches, the rest of that branch alone is executed below it, by the loopback, this store
   * having no layer below, writing within this transaction, and what each branch ends with is joined.
   *
   * Each input frame gives the frames made of it, given back as references and assignments (CAP-315), each carrying its
   * `scope`, the input frame's id (its own `scope`, else its position in the stream, `"0"`, `"1"`, ...), then the
   * completion marker `{"end": scope}`, a `Map`; the stream ends where the observable completes. An error a term meets
   * is annotated on the frame it processed (CAP-309); an error of no one frame is the observable's error. Unsubscribed
   * from before it completes, it is given nothing more, and what it wrote is the transaction's. */
  exec(frame: unknown, remainder: unknown, allow_write: boolean): Observable<Item> {
    const transaction = Proxies._isFunction(remainder) // built as an expression is, outside the transaction (94)
      ? Changes._as_committed(this._store, () => this._store._expressed(remainder)) : Proxies._durable(remainder);
    const given = _remainder(this._store, transaction);
    const proposals = this._store._proposals === null ? null : outermost(this._store._proposals);
    if (proposals !== null && proposals.expression === null && proposals.uid === null) {
      proposals.expression = given.transaction; // a scope's: its record's, and its uid (Provenance)
    }
    return _exec(this._store, this, frame, given, allow_write);
  }

  /** Refuses a transaction that has ended. */
  _open(): void {
    if (this._life.ended) throw new ValueError("a transaction's exec runs within it: this one has ended (store.transaction)");
  }

  /** At the end of its scope: the first error annotated on a frame its `exec` gave, thrown (`_raised`). */
  _raise(): void {
    _raised(this._given);
  }
}

/** `txn.exec`'s stream ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)), within the transaction `txn` holds, produced as each subscriber
 * subscribes: each input frame, as it arrives, extended through `remainder`, its frames given as they are made of it,
 * then `{"end": scope}`, `scope` its id. Each given back holds references and assignments (CAP-315), carries its input
 * frame's id, `scope`, and, where it halted read-only, its `remainder`. An error a term meets processing a frame is
 * annotated on it (CAP-309). An error of no one frame is the stream's error, its `frames` every frame the transaction
 * gave, and those made of the input frame it arose processing. */
export function _exec(store: any, txn: Transaction, given: unknown, remainder: Remainder, write: boolean): Observable<Item> {
  return new Observable<Item>((observer) => {
    let made: Frame[] = [];
    const emit = (item: Item): void => {
      observer.next!(item);
      if (observer.closed) throw new Unsubscribed();
    };
    try {
      const named = namedIn(store, remainder.transaction);
      let index = 0;
      // a frame, or a stream of them, consumed as it arrives
      for (const frame of (given instanceof Map ? [given] : given as Iterable<Map<string, any>>)) {
        txn._open();
        const scope = (frame instanceof Frame ? frame.scope : null) ?? String(index);
        index += 1;
        let changed: Changes._Gathered | null = null;
        const back = store._proposing(() => { // a savepoint: what it changed, gathered
          if (write && store._lower !== null && store._installing === 0) return cached(store, remainder, frame, named, scope);
          made = one(store, remainder, frame, write, named, scope);
          return givenBack(store, made, named, scope);
        }, (proposals: Proposals.OfStore) => { changed = Changes._gather(store, proposals); }) as Frame[];
        made = [];
        const marker: Map<string, any> = new Map([["end", scope]]);
        if (changed !== null) { // carried by its first frame, else by its completion marker
          const journal = Changes._frame_journal(store, changed, `${transactionUid(store)}#${txn._given.length}`);
          if (back.length > 0) back[0]!.journal = journal;
          else marker.set("journal", journal);
        }
        for (const item of back) {
          txn._given.push(item);
          emit(item);
        }
        emit(marker);
      }
    } catch (error) {
      if (error instanceof Unsubscribed) return;
      (error as any).frames = [...txn._given, ...made];
      observer.error!(error);
      return;
    }
    observer.complete!();
  });
}

/** What executing a transaction over one input frame keeps: whether it writes (`write`), else interprets read-only,
 * halting; the frames a term failed to process (`failed`) and those that halted (`halted`), each carrying its
 * remainder; the properties the specs name, by symbol (`named`); the input frame's id (`scope`); and how many branches
 * it sent below (`sent`), each a scope of its own. */
class Run {
  failed: Frame[] = [];
  readonly halted: Frame[] = [];

  constructor(readonly transaction: any, readonly write: boolean, readonly named: Map<string, string[]>,
    readonly scope: string | null, readonly sent: { count: number } = { count: 0 }) {}

  /** The run of a branch of a partition: its own halted frames, which the partition joins; the rest shared. */
  arm(): Run {
    const branch = new Run(this.transaction, this.write, this.named, this.scope, this.sent);
    branch.failed = this.failed;
    return branch;
  }

  halt(frame: Frame, at: (string | number)[]): void {
    frame.remainder = new Remainder(this.transaction, at);
    this.halted.push(frame);
  }
}

/** The frames one input frame gives, within the transaction open: those the remainder's chain ends with, then those
 * that halted read-only, then those annotated with an error. A frame given annotated is given back as it is, executed no
 * further; one whose reference designates nothing is annotated so, but where a cache layer interprets read-only, where
 * it holds the reference, unresolved, and halts. An error in the expression, as the frame's symbols leave it, is
 * thrown. */
function one(store: any, remainder: Remainder, given: Map<string, any>, write: boolean, named: Map<string, string[]>,
  scope: string): Frame[] {
  const frame = taken(store, given, remainder, !write && store._below !== null);
  if (frame.errors.length > 0 || remainder.at.length === 0) return [frame];
  const term = termAt(remainder.transaction, remainder.at);
  check(store, term, new Set(frame.keys()));
  const state = new Run(remainder.transaction, write, named, scope);
  const made = run(store, term, [frame], [...remainder.at], state);
  return [...made, ...state.halted, ...state.failed];
}

/** An input frame, as the executor binds: each symbol's object by what its reference designates, a schema object or a
 * store's object as itself; annotated where one designates nothing, or is refused (CAP-309); `keep`, a reference that
 * designates nothing the store holds kept as it is, unresolved (`unresolved`). */
function taken(store: any, given: Map<string, any>, remainder: Remainder, keep = false): Frame {
  const frame = new Frame(null, given instanceof Frame ? given.errors : [], given instanceof Frame ? given.assigns : []);
  for (const [name, value] of Map.prototype.entries.call(given) as IterableIterator<[string, any]>) {
    try {
      frame.set(name, bound(store, name, value));
    } catch (error) {
      if (error instanceof Absent) {
        if (keep) {
          frame.set(name, Proxies._durable(value));
          continue;
        }
        error = new LookupError(`symbol ${repr(name)} of the frame: no object of the store has its reference's path`);
      }
      frame.errors.push(new FrameError(remainder.subterm, (error as Error).name, (error as Error).message, error));
    }
  }
  return frame;
}

/** What a symbol of an input frame binds: the object its reference designates, else what it holds. */
function bound(store: any, name: string, value: unknown): any {
  if (value instanceof _Refused) {
    if (value.life === store._life && value.target !== null) return value.target; // given back within this transaction
    throw new LookupError(`symbol ${repr(name)} of the frame: ${value.message}`);
  }
  const target = Proxies._deref(value);
  const inner = Proxies._innerOf(target);
  if (inner instanceof Proxies._internals._RecordData && inner._schema === store.registered("References.OfObject")) {
    const found = References._designated(store, target);
    if (found === null) throw new Absent();
    return Proxies._durable(found);
  }
  return Proxies._durable(value);
}

/** A frame's reference that designates nothing the store holds. */
class Absent extends Error {}

/** Whether a frame holds a reference that designates nothing the store holds, which a cache layer's interpretation
 * read-only kept (`taken`): it halts at the next term, for the layer below to resolve. */
function unresolved(store: any, frame: Map<string, any>): boolean {
  const reference = store.registered("References.OfObject");
  return [...Map.prototype.values.call(frame) as IterableIterator<unknown>].some((value) => {
    const inner = Proxies._innerOf(value);
    return inner instanceof Proxies._internals._RecordData && inner._schema === reference;
  });
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
    throw new ValueError(`${a(kind)}'s pattern has variables: transactions bind no variables until expressions are evaluated`);
  }
  if (pattern.requires.length > 0) {
    throw new ValueError(`${a(kind)}'s pattern requires constraints: transactions evaluate no expressions yet`);
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
      throw new ValueError("a branch requires constraints: transactions evaluate no expressions yet");
    }
  } else if ((kind === "map" || kind === "reduce") && [...term.variables].length > 0) {
    throw new ValueError(`${a(kind)} of variables: transactions bind no variables until expressions are evaluated`);
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
        + "expressions yet; a reduce drops symbols");
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

/** Refuses a symbol a transaction cannot bind: one given both a schema and a reference, or neither; one of a kind
 * union, or of no reference object schema. */
function symbols(store: any, pattern: any): void {
  for (const [name, symbol] of pattern.symbols) {
    if (_exactlyOne(name, symbol, ValueError) !== null) continue; // it binds what its reference designates
    const schema = symbol.schema;
    if (!(schema instanceof S.OfObject.Data) || !schema.ref) {
      throw new ValueError(`symbol ${repr(name)} binds no reference object of one schema: transactions bind objects of an `
        + "object schema");
    }
  }
}

/** Whether `schema` is a meta-schema: its objects are schema objects (`Schemas.OfObject`, ...), written by their builders
 * (object identity 86 in [CAP-115: schemas defined by idempotent installs](mbse:mbse-basis/docs/capabilities/CAP-115.md#decided)). */
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
  return Builders._linked_data(value) ?? Proxies._durable(value); // compared by identity with what frames bind
}

/** The objects a symbol of `schema` ranges over: a meta-schema's, the named schema objects of its kind the store holds,
 * the framework's left out; data's, those the store reaches from its singletons. */
function extent(store: any, schema: any): any[] {
  if (!meta(store, schema)) return [...store.extent(store.name_of(schema))].map((found) => Proxies._durable(found));
  return [...store._objects].filter((held) => !store.framework(held) && reader(store, held).as_schema() === schema);
}

/** The frames a term, `at` its path in the expression's wire form, and those after it, make of `frames`: those its
 * chain ends with. A frame a term fails to process is annotated with the error, as bound as it was, and added to
 * `state.failed`, the others going on ([CAP-309: errors annotated on frames](mbse:mbse-basis/docs/capabilities/README.md#CAP-309)). `state.named` gathers, by symbol, the properties the specs
 * name, in order: what the frames given back assign.
 *
 * Read-only (`state.write` false), a term is interpreted over each frame within a savepoint, and where it would write,
 * or a map finds nothing the store holds to bind a symbol, the frame halts, added to `state.halted` with its remainder:
 * as it was given to the term, or, where a map bound some of its symbols, binding those. A partition keeps its join: a
 * frame halted within a branch is sent below with the rest of the branch alone, and what comes back is joined
 * (`below`). */
function run(store: any, term: any, frames: Frame[], at: (string | number)[], state: Run): Frame[] {
  const kind = kindOf(store, term);
  if (kind === "map" || kind === "upsert" || kind === "update") {
    const pattern = patternOf(term, kind === "map" ? "symbols" : kind === "upsert" ? "exists" : "apply", kind);
    for (const [symbol, items] of membersOf(pattern)) { // the properties the specs name: what the frames given back assign
      if (!state.named.has(symbol)) state.named.set(symbol, []);
      const names = state.named.get(symbol)!;
      for (const item of items) {
        const body = item.get("as_property");
        if (body !== undefined && !names.includes(body.get("name"))) names.push(body.get("name"));
      }
    }
    const key = kind === "upsert" ? (store.member(term, "key") || transactionUid(store)) : null;
    const made: Frame[] = [];
    for (const frame of frames) {
      try {
        if (state.write) {
          made.push(...termOf(store, kind, pattern, frame, key, null));
          continue;
        }
        if (store._below !== null && (kind !== "map" || unresolved(store, frame))) {
          state.halt(frame, at); // a cache layer's: what writes, or what it cannot resolve, the layer below
          continue;
        }
        const halted: Bound[] = [];
        try { // a savepoint: what a halted term began, dropped
          made.push(...store._joined(() => store._readingOnly(() => termOf(store, kind, pattern, frame, key, halted))));
        } catch (error) {
          if (!(error instanceof Proxies._Halt)) throw error;
          state.halt(frame, at); // it would write: the frame halts at the term, as it was given to it
          continue;
        }
        for (const partial of halted) state.halt(new Frame(partial), at); // a symbol nothing the store holds binds
      } catch (error) {
        frame.errors.push(new FrameError(plainPath(...at), (error as Error).name, (error as Error).message, error));
        state.failed.push(frame);
      }
    }
    frames = made;
  } else if (kind === "reduce") {
    const dropped: string[] = [...term.symbols][0].collector.symbols;
    const unique = new Map<string, Frame>();
    if (!state.write && store._below !== null) {
      for (const frame of frames.filter((each) => unresolved(store, each))) {
        state.halt(frame, at); // a cache layer's: it cannot tell what it does not hold apart
      }
      frames = frames.filter((frame) => frame.remainder === null);
    }
    for (const frame of frames) {
      const kept = new Frame([...frame].filter(([name]) => !dropped.includes(name)));
      const identity = JSON.stringify([...kept].map(([name, target]) => [name, Proxies._key_of(reader(store, target))]));
      if (!unique.has(identity)) unique.set(identity, kept);
    }
    frames = [...unique.values()];
  } else if (kind === "partition") {
    let arms: [(string | number)[], any][] = [...term.branches].map((entry: any, index: number) =>
      [[...at, "branches", index], entry.branch]);
    const first = store.member(term, "first");
    if (arms.length > 0 && (first || store.member(term, "last"))) { // every branch matches, none requiring constraints (87)
      arms = [first ? arms[0]! : arms[arms.length - 1]!];
    }
    const otherwise = next(term, "none");
    if (arms.length === 0 && otherwise !== null) arms = [[[...at, "none", 0, kindOf(store, otherwise)], otherwise]];
    const joined: Frame[] = [];
    for (const [armAt, arm] of arms) {
      const branch = state.arm();
      joined.push(...run(store, arm, frames.map((frame) => new Frame(frame)), armAt, branch));
      for (const partial of branch.halted) joined.push(...below(store, state, partial)); // the layer that split keeps the join
    }
    frames = joined;
  }
  const after = next(term, "then");
  return after === null ? frames : run(store, after, frames, [...at, "then", 0, kindOf(store, after)], state);
}

/** The frames a map, an upsert or an update makes of one frame; `halted`, where it interprets read-only, gathers the
 * frames a map halts within it. */
function termOf(store: any, kind: string, pattern: any, frame: Frame, key: unknown, halted: Bound[] | null): Frame[] {
  if (kind === "update") {
    writeSpec(store, pattern, frame);
    return [frame];
  }
  return bind(store, pattern, frame, kind === "upsert", key, halted).map((found) => new Frame(found));
}

/** The frames a branch ends with where a frame halted within it, the rest of the branch alone executed below,
 * collected until the completion marker of the scope it was sent with, a branch's own: here by the loopback, the store
 * having no layer below ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)). Those annotated with an error go on to `state.failed`,
 * as they came. */
function below(store: any, state: Run, partial: Frame): Frame[] {
  const scope = `${state.scope}/${state.sent.count}`;
  partial.scope = scope;
  state.sent.count += 1;
  const joined: Frame[] = [];
  if (store._lower !== null && store._installing === 0) { // a cache layer's: the layer below's transaction executes it
    const [given] = givenBack(store, [partial], state.named, scope);
    for (const item of fromBelow(store, given!, partial.remainder!, state.named, scope)) {
      if (item.errors.length > 0) state.failed.push(item);
      else joined.push(taken(store, item, partial.remainder!, true));
    }
    return joined;
  }
  const stream = loopback(store, state, partial);
  let item = stream.next().value as Item;
  while (item instanceof Frame) { // until the completion marker, `{"end": scope}`
    (item.errors.length > 0 ? state.failed : joined).push(item);
    item = stream.next().value as Item;
  }
  return joined;
}

/** What a store with no layer below gives back for a frame sent below with its remainder: the frame executed again by
 * the same store, writing, within the transaction open; its frames, each carrying the frame's scope, then the
 * completion marker, `{"end": scope}`. */
function* loopback(store: any, state: Run, frame: Frame): Generator<Item> {
  for (const made of one(store, frame.remainder!, frame, true, state.named, frame.scope!)) {
    made.scope = frame.scope;
    yield made;
  }
  yield new Map([["end", frame.scope]]);
}

/** The properties a transaction's specs name, by symbol, in order, through every term: what the frames it gives assign,
 * wherever in it a frame is executed, so that the frames a layer below gives back of the rest of an expression assign
 * what the whole expression names. */
function namedIn(store: any, transaction: any): Map<string, string[]> {
  const named = new Map<string, string[]>();
  const terms: any[] = [next(transaction, "mutations")];
  while (terms.length > 0) {
    const term = terms.shift();
    if (term === null) continue;
    const kind = kindOf(store, term);
    if (kind === "map" || kind === "upsert" || kind === "update") {
      for (const entry of term[kind === "map" ? "symbols" : kind === "upsert" ? "exists" : "apply"]) {
        for (const [symbol, items] of membersOf(entry.pattern)) {
          if (!named.has(symbol)) named.set(symbol, []);
          const names = named.get(symbol)!;
          for (const item of items) {
            const body = item.get("as_property");
            if (body !== undefined && !names.includes(body.get("name"))) names.push(body.get("name"));
          }
        }
      }
    } else if (kind === "partition") {
      terms.push(...[...term.branches].map((entry: any) => entry.branch), next(term, "none"));
    }
    terms.push(next(term, "then"));
  }
  return named;
}

// --- A cache layer: a store given a layer below (stage 2 of the stacked stores proposal) ---

/** Whether an expression writes schemas: an upsert or an update of it binds a symbol of a meta-schema. A cache layer
 * runs such a transaction, an install, itself, after the layer below has, as a store with no layer below does. */
export function _writesSchemas(store: any, transaction: any): boolean {
  const terms: any[] = [next(transaction, "mutations")];
  while (terms.length > 0) {
    const term = terms.pop();
    if (term === null) continue;
    const kind = kindOf(store, term);
    if (kind === "upsert" || kind === "update") {
      for (const entry of term[kind === "upsert" ? "exists" : "apply"]) {
        if ([...entry.pattern.symbols.values()].some((symbol: any) => symbol.schema !== null && meta(store, symbol.schema))) {
          return true;
        }
      }
    } else if (kind === "partition") {
      terms.push(...[...term.branches].map((entry: any) => entry.branch), next(term, "none"));
    }
    terms.push(next(term, "then"));
  }
  return false;
}

/** The frames a cache layer gives of one input frame, writing ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)): it interprets it read-only
 * over what it holds, as far as it can know (`bind`, `_knows`); each frame that halts, with its remainder, and each it
 * completes, with nothing left to execute, goes to the layer below's transaction, which executes it, writing; and each
 * that comes back is given (`fromBelow`). A frame annotated with an error here is given as it is. */
function cached(store: any, remainder: Remainder, given: Map<string, any>, named: Map<string, string[]>,
  scope: string): Frame[] {
  const made = one(store, remainder, given, false, named, scope);
  const frames: Frame[] = [];
  for (const local of givenBack(store, made, named, scope)) {
    if (local.errors.length > 0) {
      frames.push(local);
      continue;
    }
    const rest = local.remainder ?? new Remainder(remainder.transaction, []); // complete: down too, for the layer below
    local.remainder = null;
    frames.push(...fromBelow(store, local, rest, named, scope));
  }
  return frames;
}

/** What the layer below's transaction gives back of a frame a cache layer sends it with the rest of the expression to
 * execute, writing: each frame annotated with an error, as it is; each complete, its journal applied to what the cache
 * layer holds; each partial, executed again by the cache layer, writing, its writes sent below as it makes them
 * (`Builders.Store._forward`); a completion marker's journal applied. Its frames carry no journal: the cache layer gives
 * one of what it changed, in its own terms. */
function fromBelow(store: any, local: Frame, rest: Remainder, named: Map<string, string[]>, scope: string): Frame[] {
  const frames: Frame[] = [];
  for (const item of store._lower.forward(local, rest) as Item[]) {
    if (!(item instanceof Frame)) {
      if (item.has("journal")) applyJournal(store, item.get("journal"));
      continue;
    }
    const journal = item.journal;
    item.journal = null;
    if (item.errors.length > 0) {
      frames.push(item);
      continue;
    }
    if (journal !== null) applyJournal(store, journal);
    if (item.remainder === null) {
      frames.push(item);
      continue;
    }
    const made = store._proposing(() => one(store, item.remainder!, item, true, named, scope), // partial: executed
      (proposals: Proposals.OfStore) => store._forward(proposals)); // again here, writing, its writes sent below
    frames.push(...givenBack(store, made, named, scope));
  }
  return frames;
}

/** Applies a journal a layer below gave back, a value of the cache layer's, to what the cache layer holds, as it applies
 * what the layer below's follow gives it (`Builders.Store._apply`). */
function applyJournal(store: any, journal: unknown): void {
  const plain = Plain.ToPlain(store)(store.registered("Changes.Journal"), journal) as Plain.PlainData;
  for (const effect of Changes._effects(store, plain)) store._apply(effect, true);
}

/** The items of a stream, as it gives them, synchronously; its error thrown. */
function collected(stream: Observable<Item>): Item[] {
  const given: Item[] = [];
  let failure: { error: unknown } | null = null;
  stream.subscribe({ next: (item) => given.push(item), error: (error) => { failure = { error }; } });
  if (failure !== null) throw (failure as { error: unknown }).error;
  return given;
}

/** The layer below's transaction, which a cache layer's transaction holds for its whole duration
 * ([the stacked stores proposal](mbse:mbse-basis/proposals/STACKED-STORES.md#a-cache-layer-and-the-layer-below)): the cache layer's runs within it (`within`), and it commits first, as that ends,
 * before the cache layer's proposals commit, what it reports of it, as it commits (`closing`), taken into the cache
 * layer's; and where the cache layer's throws, it is dropped. What passes between them is `exec`, its frames,
 * remainders and journals each made a value of the store it goes to, through their plain forms: an object by its
 * reference, a schema object by its path, an expression by its wire form, whose positions are the same in both. */
export class _Lower {
  readonly below: any;
  closing = false;
  txn: any = null;
  /** By an expression of the cache layer's: its copy below. */
  readonly copies = new Map<unknown, unknown>();
  /** By a copy: the cache layer's expression. */
  readonly originals = new Map<unknown, unknown>();

  constructor(readonly store: any) {
    this.below = store._below;
  }

  /** Runs `body`, the cache layer's transaction, within the layer below's, which commits as it ends; throws where it is
   * refused. */
  within<T>(body: () => T): T {
    try {
      return this.below.transaction((txn: any = null) => {
        this.txn = txn;
        const result = body();
        this.closing = true; // what the layer below reports from here, it reports of this transaction
        return result;
      });
    } finally {
      this.closing = false;
    }
  }

  /** The layer below's copy of an expression of the cache layer's, under the cache layer's transaction's uid, so that the
   * layer below's transaction takes it as its own, and records it so (`Provenance`). */
  copy(transaction: unknown): unknown {
    let copied = this.copies.get(transaction);
    if (copied === undefined) {
      const plain = Plain.ToPlain(this.store).Transaction(transaction) as Map<string, unknown>; // as the transaction sees it
      plain.set("uid", transactionUid(this.store));
      copied = Changes._as_committed(this.below, () => Plain.FromPlain(this.below).Transaction(plain));
      this.copies.set(transaction, copied);
      this.originals.set(copied, transaction);
    }
    return copied;
  }

  /** The items the layer below's transaction's `exec` gives of `frame`, a frame of the cache layer's given back, and
   * `rest`, writing, each a value of the cache layer's. */
  forward(frame: Frame, rest: Remainder): Item[] {
    return collected(this.txn.exec(this.down(frame), new Remainder(this.copy(rest.transaction), rest.at), true))
      .map((item) => {
        if (item instanceof Frame) return this.up(item);
        return item.has("journal") ? new Map([...item, ["journal", this.journal(item.get("journal"))]]) : item;
      });
  }

  /** Executes a cache layer's own write, its effect as plain data, in the layer below's transaction, under the cache
   * layer's transaction's uid; throws the first error a frame of it is annotated with. */
  write(plain: Map<string, unknown>): void {
    const given = new Map([...plain, ["uid", transactionUid(this.store)]]) as Plain.PlainData;
    this.run(Changes._as_committed(this.below, () => Plain.FromPlain(this.below).Transaction(given)));
  }

  /** Executes a transaction of the layer below's in its transaction, writing: an install, the layer below's before the
   * cache layer's, or a cache layer's own write; throws the first error a frame of it is annotated with, as the layer
   * below's interpreter annotated it. */
  run(transaction: unknown): void {
    _raised(collected(this.txn.exec(new Frame(), transaction, true)).filter((item) => item instanceof Frame) as Frame[]);
  }

  /** A frame of the cache layer's as the layer below's: each object by its reference, a schema object by its path. What
   * it binds is what the cache layer's interpretation bound, or was given: an object it holds, by its reference, or a
   * schema object the layer below holds, every install having run there first. */
  down(frame: Frame): Frame {
    const bound = [...Map.prototype.entries.call(frame) as IterableIterator<[string, any]>]
      .map(([name, value]) => [name, carried(this.store, this.below, value)] as [string, any]);
    return new Frame(bound, frame.errors, [], null, frame.scope);
  }

  /** A frame the layer below gave back, as the cache layer's: its bindings, what it assigns, its remainder in the cache
   * layer's expression, and its journal. */
  up(frame: Frame): Frame {
    const bound: [string, any][] = [];
    for (const [name, value] of Map.prototype.entries.call(frame) as IterableIterator<[string, any]>) {
      try {
        bound.push([name, carried(this.below, this.store, value)]);
      } catch (error) {
        bound.push([name, new _Refused((error as Error).message)]);
      }
    }
    const holders = new Map(bound);
    const assigns = [...frame.assigns].map(([name, values]) => [name, new Map([...values].map(([key, value]) =>
      [key, carriedValue(this.below, this.store, value, holders.get(name), key)]))] as [string, Map<string, unknown>]);
    const remainder = frame.remainder === null ? null
      : new Remainder(this.originals.get(frame.remainder.transaction), frame.remainder.at);
    return new Frame(bound, frame.errors, assigns, remainder, frame.scope,
      frame.journal === null ? null : this.journal(frame.journal));
  }

  /** A journal the layer below gave, as the cache layer's. */
  journal(journal: unknown): unknown {
    return Plain.FromPlain(this.store)(this.store.registered("Changes.Journal"),
      Plain.ToPlain(this.below)(this.below.registered("Changes.Journal"), journal) as Plain.PlainData);
  }
}

/** What a frame binds, of `source`'s, as `target`'s: an object's reference by its path, a schema object by its path;
 * refused, `LookupError`, where it cannot be: a counted object, or a schema object `target` does not hold. */
function carried(source: any, target: any, value: any): any {
  if (value instanceof _Refused) throw new LookupError(value.message);
  const held = Proxies._deref(value);
  const inner = Proxies._innerOf(held);
  if (inner instanceof Proxies._internals._RecordData && inner._schema === source.registered("References.OfObject")) {
    return Plain.FromPlain(target)(target.registered("References.OfObject"),
      Plain.ToPlain(source)(inner._schema, held) as Plain.PlainData);
  }
  const path = Paths.of(held) as any;
  const found = target.held(Plain.ToPlain(source)(path.as_schema(), path));
  if (found === null) throw new LookupError("a schema object the layer it goes to does not hold");
  return found;
}

/** A value a frame assigns to the property `name` of `holder`, the object a symbol binds, by its reference, a value of
 * `target`'s: a value object of `source`'s by its plain form, read by the schema `target` gives the property, that of the
 * object's schema its path implies; any other as it is. */
function carriedValue(source: any, target: any, value: any, holder: any, name: string): unknown {
  const inner = Proxies._innerOf(value);
  if (inner instanceof Proxies._internals._RecordData || inner instanceof Proxies._internals._ContainerData) {
    const path = (Plain.ToPlain(target)(holder.as_schema(), holder) as Map<string, unknown>).get("path");
    const schema = References._implied(target, path).properties.get(name).schema;
    return Plain.FromPlain(target)(schema, Plain.ToPlain(source)(inner._schema, value) as Plain.PlainData);
  }
  return value;
}

/** The frames binding a pattern's symbols that `frame` does not, each to every object of its schema whose members its
 * spec gives hold: a singleton's to the singleton (77). A symbol given a reference binds what it designates, and no frame
 * where the store holds none (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided)). An upsert creates, where none is found, the object of a symbol,
 * and writes its spec where it does not hold; a counted object it created before from the same frame, for the same
 * symbol and key, it finds again (63), and finds none otherwise (102). Read-only, a map gives to `halted`, rather than
 * dropping, each frame as bound so far where nothing the store holds binds a symbol. */
function bind(store: any, pattern: any, frame: Bound, upsert: boolean, key: unknown = null,
  halted: Bound[] | null = null): Bound[] {
  const members = membersOf(pattern);
  let frames: Bound[] = [new Map(frame)];
  const cache = halted !== null && store._below !== null; // a cache layer's, read-only: what it can know alone
  for (const [name, symbol] of pattern.symbols) {
    if (frame.has(name)) continue;
    const reference = _givenReference(symbol);
    if (reference !== null) { // what it designates, or no frame where the store holds none (references 8 in [CAP-141: queries start from a referenced object](mbse:mbse-basis/docs/capabilities/CAP-141.md#decided))
      const target = Proxies._durable(References._designated(store, reference));
      if (target === null && halted !== null) halted.push(...frames);
      frames = target === null ? [] : frames.map((partial) => new Map([...partial, [name, target]]));
      continue;
    }
    const schema = symbol.schema;
    if (cache && schema.singleton === null) { // it cannot know it holds every object of a schema: below
      halted!.push(...frames);
      return [];
    }
    const grown: Bound[] = [];
    for (const partial of frames) {
      if (schema.singleton !== null) {
        grown.push(new Map([...partial, [name, store._singleton_of(schema.singleton)]]));
        continue;
      }
      if (upsert && Proxies._counted_schema(schema) && !meta(store, schema)) { // found only by what made it (102)
        const index = _upsert_index(store, key, name, frame);
        let made = store._upserted.get(index)?.deref();
        if (made === undefined) {
          made = Proxies._durable(writer(store, schema).create());
          store._upserted.set(index, new WeakRef(made));
        }
        grown.push(new Map([...partial, [name, made]]));
        continue;
      }
      const own = members.get(name) ?? [];
      const identifying = own.filter((member) => identifies(store, schema, member));
      const located = identifying.length > 0 ? null : locate(store, pattern, members, name, schema, partial);
      let found: any[];
      if (located !== null) { // placed by its owner's entries, which a symbol bound before it gives (60)
        found = located;
      } else if (identifying.length > 0 && meta(store, schema)) { // a schema object by its name, the store's own included (86)
        found = registeredAs(store, schema, identifying[0]!);
      } else {
        const finding = identifying.length > 0 ? identifying : own;
        found = extent(store, schema).filter((target: unknown) => holds(store, target, schema, finding, partial, partial));
      }
      if (found.length === 0 && halted !== null && !upsert) halted.push(partial);
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
  const kept: Bound[] = [];
  for (const bound of frames) {
    if (cache && ![...members.keys()].every((name) => store._knows(bound.get(name)))) {
      halted!.push(bound); // what its spec reads, it does not hold all of: below
    } else if ([...members].every(([name, items]) =>
      holds(store, bound.get(name), schemaIn(store, pattern, name, bound), items, bound, null))) {
      kept.push(bound);
    }
  }
  return kept;
}

/** The schema of the object a pattern's symbol binds in `frame`: its own, or, given a reference, the bound object's. */
function schemaIn(store: any, pattern: any, name: string, frame: Bound): any {
  const schema = pattern.symbols.get(name).schema;
  return schema === null ? reader(store, frame.get(name)).as_schema() : schema;
}

/** What tells apart a counted object an upsert makes (63): the upsert's key, the symbol, and the objects of the frame
 * that reached it, each as it is told apart in memory. */
/** The uid of the transaction open, as `Provenance` records it and its journal gives it: an upsert that gives no key is
 * keyed by it, so that a counted object it makes is found again where the same transaction is replayed, and by no other
 * transaction (102 in [CAP-139: upserts find before they create](mbse:mbse-basis/docs/capabilities/CAP-139.md#decided)). */
function transactionUid(store: any): string {
  return Provenance._uid(store, outermost(store._proposals));
}

/** The proposals of the transaction open, those of a savepoint within it given: the outermost. */
function outermost(proposals: Proposals.OfStore): Proposals.OfStore {
  while (proposals.base instanceof Proposals.OfStore) proposals = proposals.base; // a savepoint's: the outermost
  return proposals;
}

function _upsert_index(store: any, key: unknown, name: string, frame: Bound): string {
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
  return Proxies._durable(builder.create());
}

/** Where a symbol's object is owned through an adjacency it has no name for, the entry that places it in a symbol's spec
 * bound before it (object identity 60 in [CAP-139: upserts find before they create](mbse:mbse-basis/docs/capabilities/CAP-139.md#decided)): the objects linked by each of the owner's entries agreeing with the properties it
 * gives, one where they give its keys, every one where they leave them open, none where none agrees; null where no spec
 * gives such an entry. */
function locate(store: any, pattern: any, members: Map<string, Members>, name: string, schema: any,
  frame: Bound): unknown[] | null {
  const owning = [...schema.adjacencies.values(), ...schema.anonymous].filter((a: any) => a.owner);
  for (const [other, items] of members) {
    if (!frame.has(other) || owning.length === 0) continue;
    for (const item of items) {
      const [kind, body] = only(item);
      if (kind !== "as_adjacency") continue;
      const relation = schemaIn(store, pattern, other, frame).adjacencies.get(body.get("name")).relation;
      for (const entry of verbsOf(body).filter(([verb]) => verb === "insert").flatMap(([, entries]) => entries)) {
        const parts: Map<string, any>[] = entry.get("mutations");
        const link = parts.find((part) => part.has("as_link")
          && part.get("as_link").get("mutations")[0].get("set").get("reference")?.get("symbol") === name)?.get("as_link").get("name");
        if (link === undefined || !owning.some((a: any) => a.relation === relation && a.me === link)) continue;
        const properties = parts.filter((part) => part.has("as_property")).map((part) => part.get("as_property"));
        return [...reader(store, frame.get(other))[body.get("name")]]
          .filter((held: any) => properties.every((p) => agree(plainOf(store, held[p.get("name")],
            relation.entry.properties.get(p.get("name"))), given(p.get("mutations")[0]))))
          .map((held: any) => linked(held[link]));
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
function holds(store: any, target: any, schema: any, members: Members, frame: Bound, partial: Bound | null): boolean {
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
      if (held.has("reference") && held.get("reference").has("symbol")) {
        found.push(held.get("reference"));
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
function matches(store: any, relation: any, held: any, entry: Map<string, any>, frame: Bound): boolean {
  for (const item of entry.get("mutations")) {
    const [kind, body] = only(item);
    const name = body.get("name");
    if (kind === "as_property") {
      if (!agree(plainOf(store, held[name], relation.entry.properties.get(name)), given(body.get("mutations")[0]))) return false;
      continue;
    }
    const wanted = body.get("mutations")[0].get("set");
    const state = Proxies._innerOf(held);
    const mine = state instanceof Proxies._internals._Entry ? state._links.get(name) : null;
    if (Proxies._is_parameter(mine) || Plain._is_marked(wanted.get("reference"))) { // by the parameter's name (CAP-312)
      if (!wanted.has("reference") || mine === null || JSON.stringify(Proxies._link_key(mine))
        !== JSON.stringify(Proxies._link_key(resolve(store, wanted.get("reference"), frame)))) return false;
      continue;
    }
    const target = linked(held[name]);
    if (wanted.has("def")) {
      const definition = wanted.get("def");
      const schema = store.registered(definition.get("schema"));
      if (reader(store, target).as_schema() !== schema
        || !holds(store, target, schema, definition.get("mutations"), frame, null)) return false;
    } else if (target !== resolve(store, wanted.get("reference"), frame)) {
      return false;
    }
  }
  return true;
}

/** The object a spec's reference names: the one a symbol binds, or the one at a path; or the parameter reference
 * standing in its place (CAP-312). */
function resolve(store: any, ref: Map<string, any>, frame: Bound): any {
  if (Plain._is_marked(ref)) return Proxies._durable(Plain._unmarked(store, ref));
  if (ref.has("symbol")) return Proxies._durable(frame.get(ref.get("symbol")));
  const found = Proxies._durable(Plain._by_path(store, ref.get("path"), []));
  if (found === null || found === undefined) throw new LookupError("no object of the store has the path a spec refers to");
  return found;
}

/** Writes a pattern's spec over a frame where it does not hold (object identity 76 in [CAP-137: patterns of symbols, variables and specs](mbse:mbse-basis/docs/capabilities/CAP-137.md#decided)). */
function writeSpec(store: any, pattern: any, frame: Bound): void {
  for (const [name, members] of membersOf(pattern)) write(store, frame.get(name), schemaIn(store, pattern, name, frame), members, frame);
}

/** Writes what a spec gives of an object where it does not hold: a property's value, an entry, its links resolved and the
 * objects it defines made, and a pattern's spec, as recorded. */
function write(store: any, target: any, schema: any, members: Members, frame: Bound): void {
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
function removedOf(store: any, relation: any, held: any[], entries: Map<string, any>[], frame: Bound): number[] {
  return held.flatMap((candidate, index) =>
    (entries.some((entry) => matches(store, relation, candidate, entry, frame)) ? [index] : []));
}

/** Removes from an object's adjacency, `held` as read, each entry that agrees with one of `entries`, a spec's removal,
 * or every entry where it gives null (`clear`); through the object's builder, which removes the entries it holds at
 * those positions, so that removing an owning entry deletes what it owned (object identity 48 in [CAP-121: owned objects deleted in cascade](mbse:mbse-basis/docs/capabilities/CAP-121.md#decided)). */
function remove(store: any, target: any, schema: any, name: string, entries: Map<string, any>[] | null, held: any[],
  frame: Bound): void {
  const relation = schema.adjacencies.get(name).relation;
  const removed = entries === null ? held.map((_, index) => index) : removedOf(store, relation, held, entries, frame);
  if (removed.length === 0) {
    if (entries !== null) Proxies._note_missed(store, relation); // a removal that removed nothing: a stale view (CAP-293)
    return;
  }
  const builder = writer(store, schema, target);
  const member = builder[name];
  const written = [...member];
  for (const index of removed) member.remove(written[index]);
  builder.update();
}

/** The first of the entries `held` that agrees with an entry a spec gives, taken from them, so that the k-th equal entry a
 * spec gives is the k-th such entry held; null where none agrees. */
function match(store: any, relation: any, held: any[], entry: Map<string, any>, frame: Bound): unknown {
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
  frame: Bound): void {
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
      const made = Proxies._durable(defining(store, schema, name, defined).create());
      write(store, made, defined, definition.get("mutations"), frame);
      links.set(body.get("name"), made);
    } else {
      links.set(body.get("name"), resolve(store, target.get("reference"), frame));
    }
  }
  const fill = (added: any): any => {
    for (const [link, linked] of links) added[link](linked);
    for (const [prop, value] of values) Plain._set(added, prop, value);
    return added;
  };
  const builder = writer(store, schema, target);
  const member = builder[name];
  // one entry at most: the one held is replaced, but where a removal from the relation removed nothing, so that the
  // entry inserted beside it is refused at the commit (CAP-293)
  if (Proxies._single(adjacency.relation, adjacency.me) && !Proxies._missed(store, adjacency.relation)) {
    member((held: any) => held.remove((old: any) => old));
  }
  member((held: any) => held.insert(fill));
  builder.update();
}
