/**
 * Builders: schema builders as visitors of their meta-schemas, which model schemas as reference objects and relations,
 * and the store they are built in. They replace the builders and meta-schemas in `Schemas`, which stay beside them
 * while call sites migrate (docs/META_SCHEMAS.md, Plan); `Schemas.OfX.Data` is unchanged.
 *
 * Every schema object is a reference object: a kind of schema, and each of its members (a property, an adjacency, a
 * parameter, a symbol, a branch or a part, an argument), and a term. A property of a schema object holds a value (a
 * name, a flag, a term's attributes); every reference from one schema object to another is a relation: a schema to its
 * members (`Schemas.HasProperty`, ...), a member to its type (`Schemas.Typing`), a refinement to what it refines
 * (`Schemas.Refines`), a scalar to its widths, which are terms (`Schemas.BitWidth`), and so on (`Meta`, below).
 *
 * Each `Schemas.OfX.Builder` is a writable `Visitors.OfObject` over its meta-schema (`Meta.X`), as VISITOR_PATTERN.md
 * gives it: a member for each property (`osv.<propName>`, a `Visitors.OfProperty`) and for each adjacency
 * (`osv.<adjName>`, a `Visitors.OfAdjacency`, whose entries' links are members, `env.<linkName>`). Called with a
 * `Specs.Callback`, a member writes or visits through it and returns the builder. Its other methods are named `as_*`.
 * The builder adapts each member to however `Schemas.OfX.Data` stores it (a map by name, a field holding a schema, a
 * width held as a bigint); the data implements no visitor.
 *
 * A builder works on a copy of the data it is given (`_working`), made by `_make` and filled by `_update`, and is
 * finalized by `create()` (no data given), `clone()` (new data) or `update()` (written back into the data given),
 * through `_finalize`; none validate.
 *
 * As proxies are, each builder and visitor is a `Proxy` (`Proxies._shell`): its own methods first, then its members by
 * name; members are typed loosely (`any` by name), as the proxy DSL's are.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { AttributeError, ReadOnlyError, ValueError } from "./Errors.js";
import * as Mutations from "./Mutations.js";
import * as Proxies from "./Proxies.js";
import { _Dunders as Dunders, _innerOf as innerOf, _makeEmpty as makeEmpty, _makeProperties as makeProperties,
  _Shelled as Shelled, _shell as shell } from "./Proxies.js";
import { isClassLike, REPR, repr, sortedStrings, tokenName, TYPE_NAME, typeName } from "./Repr.js";
import * as S from "./Schemas.js";

/** Whether a `Specs.Callback` is its function form: not a class (a value, `BigInt`), nor a visitor (a value too). */
function isFunction(spec: unknown): spec is (visitor: any) => unknown {
  return typeof spec === "function" && !isClassLike(spec) && !Proxies._isVisitor(spec);
}

/** Hands `visitor` to a function Spec, which reads or writes through it; its return value is the visitor's own. */
function visit(cb: unknown, visitor: unknown): void {
  (cb as (visitor: unknown) => unknown)(visitor);
}

/** A visitor whose state, called, writes through `_call`. */
function callable(state: { _call(spec: unknown): unknown }): any {
  return shell(state as any, (spec: unknown) => state._call(spec));
}

function noArguments(method: string, args: unknown[]): void {
  if (args.length > 0) throw new TypeError(`${method}() takes no arguments (${args.length} given)`);
}

const IDENTITIES = new WeakMap<object, string>();

/** A schema object's identity, which its builder gives it on creation; null for data no builder created. */
export function identity_of(data: unknown): string | null {
  return IDENTITIES.get(data as object) ?? null;
}

function identify<T>(data: T, identity: string): T {
  IDENTITIES.set(data as object, identity); // a form is frozen; its identity is not one of its fields
  return data;
}

/** The name a schema object had when it was last given an identity, so that its identity follows a rename. */
const NAMED_AS = new WeakMap<object, string | null>();

/** Whether a value agrees with a template's: a reference object by identity, a value by value and type. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => b.has(k) && same(v, b.get(k)));
  return false;
}

/** The last of `items`, or null for none. */
function last(items: readonly unknown[]): unknown {
  return [null, ...items].pop();
}

/** A value held, where it is a scalar; else null. */
function scalarOf(held: unknown): unknown {
  return S.hostOf(held) === null ? null : held;
}

/** A property's type: its meta-schema property's `type`; null where there is no meta-schema property. */
function typeOf(schema: any): unknown {
  return schema == null ? null : schema.type;
}

// --- Properties: values ---

type Getter = (data: any) => unknown;
type Putter = (data: any, value: unknown) => void;

/** A member for one property of the meta-schema, held in the data's field of its name, or read and written through
 * `get` and `put`. Its value is a scalar, or, `container`, a map or a list. */
class Prop {
  name = "";
  get!: Getter;
  put!: Putter;
  readonly container: boolean;
  readonly shorthand: (value: unknown) => unknown;
  /** Whether an extension added it: its value is held apart from the data's fields. */
  extension = false;

  constructor(readonly _options: { get?: Getter; put?: Putter; container?: boolean; shorthand?: (value: unknown) => unknown } = {}) {
    this.container = _options.container ?? false;
    this.shorthand = _options.shorthand ?? ((value) => value);
  }

  _bind(name: string): void {
    this.name = name;
    this.get = this._options.get ?? ((data) => data[name]);
    this.put = this._options.put ?? ((data, value) => {
      data[name] = value;
    });
  }
}

/** `Visitors.OfProperty` over one property of the schema object a builder builds. */
class PropertyMember extends Dunders {
  readonly [TYPE_NAME] = "_PropertyMember";
  readonly _writable: boolean;

  constructor(readonly _builder: Builder, readonly _prop: Prop) {
    super();
    this._writable = _builder._writable;
  }

  _held(): unknown {
    return this._prop.get(this._builder._working);
  }

  _scalar(): unknown {
    const held = this._held();
    return scalarOf(held);
  }

  _label(): string {
    return `property ${repr(this._prop.name)}`;
  }

  _write(value: unknown): void {
    this._builder._write(this._prop, value);
  }

  as_schema(): any {
    const meta = this._builder.as_schema();
    return meta === null ? null : meta.properties.get(this._prop.name);
  }

  get(): unknown {
    return this._scalar();
  }

  as_value(cb: unknown): any {
    if (isFunction(cb)) {
      visit(cb, shell(new Value(this._label(), this._held.bind(this), this._write.bind(this), this._writable,
        this._prop.container, () => typeOf(this.as_schema()))));
    } else {
      this._write(this._matched(this._prop.shorthand(cb)));
    }
    return this._proxy;
  }

  /** A value given whole (a shorthand), whose type must match the property's exactly: a scalar of its scalar type; for
   * a container, an iterable of its elements, or a map of names to them where it is arranged as a dict. It sets the
   * value, merging nothing; null clears it. */
  _matched(value: unknown): unknown {
    const held = S.structure(typeOf(this.as_schema()));
    if (value === null || held === null) return value;
    let items: unknown[];
    if (held instanceof S.OfScalar.Data) {
      items = [value];
    } else if (held instanceof S.OfContainer.Data && held.arrangement === "dict") {
      const entries = Proxies._mapping(value);
      if (entries === null) throw new TypeError(`${this._label()} holds a map, got ${typeName(value)}`);
      value = new Map(entries);
      items = [...(value as Map<unknown, unknown>).values()];
    } else if (held instanceof S.OfContainer.Data) {
      if (typeof value === "string" || value instanceof Uint8Array || value instanceof Map || !Proxies._iterable(value)) {
        throw new TypeError(`${this._label()} holds a list, got ${typeName(value)}`);
      }
      value = items = [...value];
    } else {
      return value;
    }
    const element = S.structure(held instanceof S.OfScalar.Data ? held : (held as S.OfContainer.Data).element) as any;
    const host = element.type ?? null;
    const wrong = items.filter((item) => host !== null && !S.isScalarOf(host, item));
    if (wrong.length > 0) throw new TypeError(`${this._label()} holds ${tokenName(host)}, got ${typeName(wrong[0])}`);
    return value;
  }

  as_scalar(cb: unknown): any {
    return this.as_value((value: any) => value.as_scalar(cb));
  }

  as_object(cb: unknown): any {
    return this.as_value((value: any) => value.as_object(cb));
  }

  _call(spec: unknown): unknown {
    if (isFunction(spec)) visit(spec, this._proxy);
    else this.as_value(spec);
    return this._builder._proxy;
  }

  override _repr(): string {
    return `<${this._label()}>`;
  }
}

/** `Visitors.OfAny` over a value held where `held` reads it and `write` writes it: a scalar, or a container, or, where
 * `container` is null (an element of a container not written yet), either, as it is written. `schema` gives its
 * schema. */
class Value extends Shelled {
  readonly [TYPE_NAME] = "_Value";
  declare as_object: (cb: unknown) => any;
  declare as_union: (cb: unknown) => any;
  declare as_intersection: (cb: unknown) => any;

  constructor(readonly _label: string, readonly _held: () => unknown, readonly _write: (value: unknown) => void,
    readonly _writable: boolean, readonly _container: boolean | null, readonly _schema: () => unknown) {
    super();
  }

  as_schema(): unknown {
    return this._schema();
  }

  _other(cb: unknown): any {
    const reason = `${this._label} holds ${this._container ? "a container" : "a scalar"}`;
    if (!isFunction(cb)) throw new TypeError(reason);
    visit(cb, makeEmpty(reason));
    return this._proxy;
  }

  as_scalar(cb: unknown): any {
    if (this._container === true) return this._other(cb);
    if (isFunction(cb)) visit(cb, shell(new ScalarVisitor(this)));
    else this._write(cb);
    return this._proxy;
  }

  as_container(cb: unknown): any {
    if (this._container === false) return this._other(cb);
    if (isFunction(cb)) visit(cb, shell(new Mapping(this)));
    else this._write(new Map((Proxies._mapping(cb) ?? cb) as Iterable<[unknown, unknown]>));
    return this._proxy;
  }

  clear(): void {
    this._write(null);
  }
}

Object.assign(Value.prototype, { as_object: Value.prototype._other, as_union: Value.prototype._other,
  as_intersection: Value.prototype._other });

/** `Visitors.OfScalar` over a value a `Value` holds. */
class ScalarVisitor extends Dunders {
  readonly [TYPE_NAME] = "_ScalarVisitor";

  constructor(readonly _value: Value) {
    super();
  }

  _scalar(): unknown {
    const held = this._value._held();
    return scalarOf(held);
  }

  _label(): string {
    return this._value._label;
  }

  as_schema(): unknown {
    return this._value.as_schema();
  }

  get(): unknown {
    return this._scalar();
  }

  set(value: unknown): void {
    this._value._write(value);
  }

  clear(): void {
    this._value._write(null);
  }
}

/** `Visitors.OfContainer` over a container a `Value` holds: a map, arranged as a dict (a form's attributes), or a list,
 * by position (a relation's `uniques`, each a list of names). An element that is itself a map or a list is visited as
 * a container in turn. */
class Mapping extends Shelled {
  readonly [TYPE_NAME] = "_Mapping";

  constructor(readonly _value: Value) {
    super();
  }

  /** Whether the container holds its elements by position, as a list: as it holds them, or, empty, as its schema
   * arranges them. */
  _positional(): boolean {
    const held = this._value._held();
    if (Array.isArray(held) || held instanceof Map) return Array.isArray(held);
    const schema = S.structure(this.as_schema());
    return schema instanceof S.OfContainer.Data && schema.arrangement !== "dict";
  }

  _items(): Map<unknown, unknown> {
    const held = this._value._held();
    return new Map(Array.isArray(held) ? held.map((item, i) => [BigInt(i), item]) : held as Map<unknown, unknown> | null);
  }

  _element(index: unknown): any {
    const positional = this._positional();
    const write = (element: unknown): void => {
      const items = this._items();
      if (element === null) items.delete(index);
      else items.set(index, element);
      this._value._write(positional ? [...items.keys()].sort((a, b) => Number((a as bigint) - (b as bigint))).map((key) => items.get(key))
        : items);
    };
    const held = this._items().get(index);
    const container = held === undefined ? null : Array.isArray(held) || held instanceof Map;
    return shell(new Value(`${this._value._label}[${repr(index)}]`, () => this._items().get(index), write,
      this._value._writable, container, () => Object(S.structure(this.as_schema())).element));
  }

  as_schema(): unknown {
    return this._value.as_schema();
  }

  get length(): number {
    return this._items().size;
  }

  at(index: unknown): any {
    return this._element(index);
  }

  remove(index: unknown): any {
    this._element(index).clear();
    return this._proxy;
  }

  /** Positions are read through `as_entries`: `cb` is not called. */
  as_ordered(_cb: unknown): any {
    return this._proxy;
  }

  /** By position, `cb` is not called. */
  as_dict(cb: unknown): any {
    if (!this._positional()) visit(cb, new Map([...this._items().keys()].map((index) => [index, this._element(index)])));
    return this._proxy;
  }

  as_entries(cb: unknown): any {
    visit(cb, [...this._items().keys()].map((index) => [index, this._element(index)])[Symbol.iterator]());
    return this._proxy;
  }
}

// --- Adjacencies: references ---

interface Storage {
  items: (data: any, store?: unknown) => any[];
  store: (data: any, members: any[]) => void;
  one?: boolean;
}

/** Members stored as a map by name, in declaration order; a member inserted under a name held replaces it. */
function byName(field: string): Storage {
  return {
    items: (data) => [...data[field].values()],
    store: (data, members) => {
      data[field] = new Map(members.map((m) => [m.name, m]));
    },
  };
}

/** Referents stored as an array, in order. */
function inOrder(field: string): Storage {
  return {
    items: (data) => [...data[field]],
    store: (data, members) => {
      data[field] = [...members];
    },
  };
}

/** A referent stored in a field, or null: the adjacency holds at most one entry. */
function one(field: string): Storage {
  return {
    items: (data) => data[field] === null ? [] : [data[field]],
    store: (data, members) => {
      data[field] = last(members);
    },
    one: true,
  };
}

const KINDS: Function[] = [S.OfScalar.Data, S.OfObject.Data, S.OfUnion.Data, S.OfIntersection.Data, S.OfContainer.Data,
  S.OfApply.Data, S.OfAny.Value];

function isSchema(value: unknown): boolean {
  return KINDS.some((kind) => value instanceof kind);
}

/** Refuses a link, from a schema object built in a store, to a schema object that store does not hold: a reference
 * object no store built is strictly forbidden, and one another store built is that store's (FRAMEWORK.md, Resolved). */
function checkHeld(builder: any, link: string, referent: unknown): void {
  const store = builder._store;
  if (store !== null && store !== undefined && builderFor(referent) !== null && !store.holds(referent)) {
    throw new TypeError(`link ${repr(link)} cannot link ${repr(referent)}: the store does not hold it; build it in the store, or `
      + "link one it holds (a basic scalar is Builders.Meta's: OfStr, OfInt, ...)");
  }
}

/** Whether a value is of `kind`. */
function isA(kind: Function): (value: unknown) => boolean {
  return (value) => value instanceof kind;
}

type BuilderClass = new (original?: unknown, writable?: boolean, store?: Store | null) => any;

/** A member for an adjacency of the meta-schema, whose entries link the schema object being built and, at `link`,
 * another (the referent). `items` and `store` read and write the referents from and to however the data stores them;
 * `accepts` says which objects `link` may link, and `build` how a callback given to it builds one: through a builder (a
 * class, named), or not at all (null: it links an object that exists). `one`: at most one entry, as a `unique` clause
 * of its relation makes it. `keyed`: the relation's entries have one property, `name`, of string type, which names
 * the referent within the schema object (the data keeps it as the referent's `name`). `owned`: each referent belongs
 * to the schema object alone (keyed ones do), so that a clone of it has clones of them. `names`, for a keyed adjacency
 * whose data keeps its entries' names apart from its referents (a module's), reads and writes them:
 * `[name_of(data, referent), rename(data, referent, name)]`. */
class Members {
  name = "";
  readonly items: (data: any, store?: unknown) => any[];
  readonly store: (data: any, members: any[]) => void;
  readonly accepts: (value: unknown) => boolean;
  readonly build: string | null;
  readonly one: boolean;
  readonly keyed: boolean;
  readonly owned: boolean;
  readonly name_of: (data: any, referent: any) => string | null;
  readonly rename: (data: any, referent: any, name: string) => void;
  /** Whether an extension may add entries to it, after those it holds (docs/SCHEMA_EXTENSION.md). */
  readonly extensible: boolean;
  /** An extension's: its relation, its object's link, and the other. */
  extension: [S.OfRelation.Data, string, string] | null = null;

  constructor(readonly link: string, options: Storage & { accepts: (value: unknown) => boolean; build?: string;
    keyed?: boolean; owned?: boolean; extensible?: boolean;
    names?: [(data: any, referent: any) => string | null, (data: any, referent: any, name: string) => void] }) {
    this.items = options.items;
    this.store = options.store;
    this.accepts = options.accepts;
    this.build = options.build ?? null;
    this.one = options.one ?? false;
    this.keyed = options.keyed ?? false;
    this.owned = options.owned ?? this.keyed;
    this.extensible = options.extensible ?? false;
    [this.name_of, this.rename] = options.names ?? [
      (_data, referent) => Object(referent).name || null,
      (_data, referent, name) => {
        referent.name = name;
      },
    ];
  }

  _bind(name: string): void {
    this.name = name;
  }

  /** The class of the builder that builds a referent. */
  _builderClass(): BuilderClass {
    return BUILDER_CLASSES.get(this.build as string) as BuilderClass;
  }
}

/** `Visitors.OfAdjacency` over one adjacency of the schema object a builder builds: iterated, its entries. */
class AdjacencyMember extends Shelled {
  readonly [TYPE_NAME] = "_AdjacencyMember";

  constructor(readonly _builder: Builder, readonly _members: Members) {
    super();
  }

  _held(): any[] {
    return this._members.items(this._builder._working);
  }

  _store(referents: any[]): void {
    this._members.store(this._builder._working, referents);
    this._builder._written.push(this._members);
  }

  _replace(index: number, referent: unknown): void {
    const referents = this._held();
    referents[index] = referent;
    this._store(referents);
  }

  as_schema(): any {
    const meta = this._builder.as_schema();
    return meta === null ? null : meta.adjacencies.get(this._members.name);
  }

  [Symbol.iterator](): Iterator<any> {
    return this._held().map((referent, index) => makeEntry(this, index, referent))[Symbol.iterator]();
  }

  as_iterable(cb: unknown): any {
    visit(cb, this[Symbol.iterator]());
    return this._proxy;
  }

  /** Adds an entry, linking a referent: given to the entry's link, or built through it; an entry linking a referent
   * held is elided. Where the adjacency holds at most one entry, it must be removed before another. */
  insert(spec: unknown): any {
    this._builder._check();
    const proxy = makeEntry(this, null, null);
    const entry: Entry = innerOf(proxy);
    if (isFunction(spec)) {
      visit(spec, proxy);
    } else if (innerOf(spec) instanceof Entry) {
      entry._referent = innerOf(spec)._referent;
      entry._name = innerOf(spec)._name;
    } else {
      throw new TypeError(`an entry, or a callback taking one, is expected; got ${repr(spec)}`);
    }
    if (entry._referent === null) throw new ValueError(`link ${repr(this._members.link)} is not set`);
    if (this._members.keyed && entry._name !== null) this._members.rename(this._builder._working, entry._referent, entry._name);
    const held = this._held();
    if (held.some((referent) => referent === entry._referent)) return this._proxy;
    if (this._members.one && held.length > 0) {
      throw new ValueError(`${repr(this._members.name)} holds one entry; remove it before inserting another`);
    }
    this._store([...held, entry._referent]);
    return this._proxy;
  }

  /** Removes every entry that agrees with `spec`: an entry, linking the same referent, or a template, whose link agrees
   * with every property its callback writes. */
  remove(spec: unknown): any {
    this._builder._check();
    let template: Entry;
    if (isFunction(spec)) {
      const proxy = makeEntry(this, null, null);
      visit(spec, proxy);
      template = innerOf(proxy);
    } else if (innerOf(spec) instanceof Entry) {
      template = innerOf(spec);
    } else {
      throw new TypeError(`an entry, or a callback taking one, is expected; got ${repr(spec)}`);
    }
    this._store(this._held().filter((referent) => !template._agrees(referent)));
    return this._proxy;
  }

  /** Called with a callback, it visits through it. Called with an iterable, a shorthand, each item inserted, or
   * replacing the entry held where the relation allows one only: an entry (the entry shorthand), or, where the
   * relation has two links (the peer shorthand), a `Specs.Callback[OfThem.Visitor]`: the object to link, or a function
   * handed `Them`, through which it sets the entry's properties, its link, and the linked object's members. */
  _call(spec: unknown): unknown {
    if (isFunction(spec)) {
      visit(spec, this._proxy);
      return this._builder._proxy;
    }
    if (typeof spec === "string" || spec instanceof Uint8Array || spec instanceof Map || !Proxies._iterable(spec)) {
      throw new TypeError(`${repr(this._members.name)} takes an iterable of what it links, or of entries, or a callback `
        + `taking the adjacency; got ${repr(spec)}`);
    }
    this._builder._check();
    for (const item of spec) {
      let referent: any;
      let name: string | null;
      if (innerOf(item) instanceof Entry) {
        [referent, name] = [innerOf(item)._referent, innerOf(item)._name];
      } else if (isFunction(item)) { // every relation between schema objects has two links: the peer shorthand
        const them = new Them(this);
        visit(item, shell(them));
        [referent, name] = them._result();
      } else if (this._members.accepts(item)) {
        [referent, name] = [item, null];
      } else {
        throw new TypeError(`link ${repr(this._members.link)} cannot link ${repr(item)}`);
      }
      checkHeld(this._builder, this._members.link, referent);
      if (this._members.keyed && name !== null) this._members.rename(this._builder._working, referent, name);
      const held = this._held();
      if (held.some((other) => other === referent)) continue;
      this._store(this._members.one ? [referent] : [...held, referent]);
    }
    return this._builder._proxy;
  }

  override _repr(): string {
    return `<adjacency ${repr(this._members.name)}>`;
  }
}

/** `Visitors.OfEntry`: one entry of an adjacency. Its link to the referent is a member (`e.property`); the link to the
 * schema object being built is filled by the adjacency. */
class Entry extends Shelled {
  readonly [TYPE_NAME] = "_Entry";
  /** What the callback that built the referent wrote. */
  _template: any[] | null = null;
  /** The name written (`env.name`), where the entries are keyed. */
  _name: string | null = null;

  constructor(readonly _adjacency: AdjacencyMember, readonly _index: number | null, public _referent: any) {
    super();
  }

  as_schema(): any {
    const schema = this._adjacency.as_schema();
    return schema === null ? null : schema.relation.entry;
  }

  override _member(name: string): unknown {
    const members = this._adjacency._members;
    if (name === members.link) return callable(new Link(this));
    if (name === "name" && members.keyed) return callable(new EntryName(this));
    return makeEmpty(`${repr(name)} is not a link this entry can set, nor a property of the relation`);
  }

  /** The entry's name: the one written, else its referent's. */
  _named(): string | null {
    if (this._name !== null) return this._name;
    const adjacency = this._adjacency;
    return adjacency._members.name_of(adjacency._builder._working, this._referent);
  }

  _rename(name: unknown): void {
    if (name !== null && (typeof name !== "string" || name === "")) {
      throw new TypeError(`a name is non-empty text, got ${repr(name)}`);
    }
    this._name = name as string | null;
    if (this._index !== null) { // an entry held: its referent is renamed in place
      this._adjacency._builder._check();
      this._adjacency._members.rename(this._adjacency._builder._working, this._referent, [name].join("")); // null as ""
      this._adjacency._store(this._adjacency._held());
    }
  }

  _relink(referent: unknown, template: any[] | null): void {
    this._referent = referent;
    this._template = template;
    if (this._index !== null) this._adjacency._replace(this._index, referent); // an entry held: linked in its place
  }

  _agrees(referent: any): boolean {
    if (this._name !== null && Object(referent).name !== this._name) return false;
    if (this._referent === null) return true;
    if (this._template === null) return referent === this._referent;
    return this._template.every((member) => member instanceof Prop ? same(member.get(referent), member.get(this._referent))
      : sameItems(member.items(referent), member.items(this._referent)));
  }

  override _repr(): string {
    return `<entry of ${repr(this._adjacency._members.name)}>`;
  }
}

function sameItems(held: readonly unknown[], wanted: readonly unknown[]): boolean {
  return held.length === wanted.length && held.every((item, i) => same(item, wanted[i]));
}

function makeEntry(adjacency: AdjacencyMember, index: number | null, referent: unknown): any {
  return shell(new Entry(adjacency, index, referent));
}

/** `Visitors.OfProperty` over an entry's name, the one property of the entries of a keyed adjacency. */
class EntryName extends Dunders {
  readonly [TYPE_NAME] = "_EntryName";

  constructor(readonly _entry: Entry) {
    super();
  }

  _held(): unknown {
    return this._entry._named();
  }

  _scalar(): unknown {
    return this._held();
  }

  _label(): string {
    return "property 'name'";
  }

  as_schema(): any {
    const entry = this._entry.as_schema();
    return entry === null ? null : entry.properties.get("name");
  }

  get(): unknown {
    return this._held();
  }

  as_value(cb: unknown): any {
    if (isFunction(cb)) {
      visit(cb, shell(new Value(this._label(), this._held.bind(this), this._entry._rename.bind(this._entry),
        this._entry._adjacency._builder._writable, false, () => typeOf(this.as_schema()))));
    } else {
      this._entry._rename(cb);
    }
    return this._proxy;
  }

  as_scalar(cb: unknown): any {
    return this.as_value((value: any) => value.as_scalar(cb));
  }

  _call(spec: unknown): unknown {
    if (isFunction(spec)) visit(spec, this._proxy);
    else this.as_value(spec);
    return this._entry._proxy;
  }
}

/** `OfThem.Visitor`, for one item of the peer shorthand: an entry of a relation of two links, and the object it links
 * (them). Its members are the entry's properties (`t.name`), its link (`t.property`, to link an object that exists),
 * and the members of the object it links (`t.type`), which are written through that object's builder: a new one, or,
 * where the link is set, that one, updated. Each, called, returns the visitor. */
class Them extends Shelled {
  readonly [TYPE_NAME] = "_Them";
  readonly _entry: Entry;
  _object: any = null;

  constructor(adjacency: AdjacencyMember) {
    super();
    this._entry = innerOf(makeEntry(adjacency, null, null));
  }

  as_schema(): any {
    return this._entry.as_schema();
  }

  _builder(): any {
    if (this._object === null) {
      const members = this._entry._adjacency._members;
      if (members.build === null) {
        throw new TypeError(`link ${repr(members.link)} links an object that exists: link it, not its members`);
      }
      const builderClass = members._builderClass();
      this._object = new builderClass(this._entry._referent, true, this._entry._adjacency._builder._store);
    }
    return this._object;
  }

  override _member(name: string): unknown {
    const members = this._entry._adjacency._members;
    if (name === members.link || (name === "name" && members.keyed)) {
      return callable(new Chained(this._entry._proxy[name], this, name === members.link));
    }
    return callable(new Chained(this._builder()[name], this, false));
  }

  /** The object linked: the one given, built, or updated; and the entry's name. */
  _result(): [any, string | null] {
    const members = this._entry._adjacency._members;
    let builder = this._object;
    let referent = this._entry._referent;
    if (builder === null && referent === null && members.build !== null) {
      builder = this._builder(); // nothing linked or written: a new object, with nothing but its entry's name
    }
    if (builder !== null && (builder._written.length > 0 || referent === null)) {
      referent = builder._original !== null ? builder._edited() : builder.create();
    }
    if (referent === null) throw new ValueError(`link ${repr(members.link)} is not set`);
    return [referent, this._entry._name];
  }
}

/** A member read through `Them`: read as the member itself; called, it writes through the member and returns the
 * `Them` visitor, so that an item's clauses chain. */
class Chained extends Shelled {
  readonly [TYPE_NAME] = "_Chained";

  constructor(readonly _wrapped: any, readonly _them: Them, readonly _link: boolean) {
    super();
  }

  override _member(name: string): unknown {
    return this._wrapped[name];
  }

  _call(spec: unknown): unknown {
    if (this._link) {
      if (this._them._object !== null && this._them._object._written.length > 0) {
        throw new ValueError("link the object before writing its members");
      }
      this._them._object = null; // the members written next are the linked object's
    }
    this._wrapped(spec);
    return this._them._proxy;
  }
}

/** An entry's link to its referent, a `Visitors.OfObject`: read, the referent, read-only, through its builder; called
 * with a Spec, it links the referent given, or builds one through the callback: a new one, or, where the entry links
 * one, that one, updated. */
class Link extends Shelled {
  readonly [TYPE_NAME] = "_Link";

  constructor(readonly _entry: Entry) {
    super();
  }

  _members(): Members {
    return this._entry._adjacency._members;
  }

  _target(): any {
    const referent = this._entry._referent;
    if (referent === null) return makeEmpty(`link ${repr(this._members().link)} is not set`);
    const builder = builderFor(referent);
    if (builder === null && Proxies._store_of(referent) !== null) return referent; // data, which an extension's relation links
    return builder === null ? makeEmpty("a term of a dialect is read through its dialect") : new builder(referent, false);
  }

  as_schema(): unknown {
    return this._target().as_schema();
  }

  as_identity(identity: string | null = null): unknown {
    return this._target().as_identity(identity);
  }

  get as_properties(): unknown {
    return this._target().as_properties;
  }

  as_adjacencies(cb: unknown): any {
    this._target().as_adjacencies(cb);
    return this._proxy;
  }

  override _member(name: string): unknown {
    return this._target()[name];
  }

  _call(spec: unknown): unknown {
    const entry = this._entry;
    const members = this._members();
    if (entry._index !== null) entry._adjacency._builder._check();
    if (isFunction(spec)) {
      if (members.build === null) {
        throw new TypeError(`link ${repr(members.link)} links an object that exists: give it, not a callback`);
      }
      const [result, written] = build(members._builderClass(), entry._referent, spec, entry._adjacency._builder._store);
      if (result !== null) entry._relink(result, written);
      return entry._proxy;
    }
    const referent = innerOf(spec) instanceof Link ? innerOf(spec)._entry._referent : spec;
    if (!members.accepts(referent)) throw new TypeError(`link ${repr(members.link)} cannot link ${repr(referent)}`);
    checkHeld(entry._adjacency._builder, members.link, referent);
    entry._relink(referent, null);
    return entry._proxy;
  }

  override _repr(): string {
    return `<link ${repr(this._members().link)}>`;
  }
}

/** Builds a link's referent through a builder of `builderClass` handed to `cb`: a new referent, or the one linked,
 * updated where `cb` writes; with what `cb` wrote. Null where it edits the one linked and writes nothing. */
function build(builderClass: BuilderClass, current: unknown, cb: unknown, store: Store | null): [unknown, any[]] {
  const builder = new builderClass(current, true, store);
  visit(cb, builder);
  if (current !== null && builder._written.length === 0) return [null, []];
  return [current !== null ? builder._edited() : builder.create(), builder._written];
}

// --- Builders ---

type Table = Map<string, Prop | Members>;

/** A member table: `base`'s, then `own`'s, each member named by its key; one redeclared keeps its place. */
function extendTable(base: Table, own: Record<string, Prop | Members>): Table {
  const table = new Map(base);
  for (const [name, member] of Object.entries(own)) {
    member._bind(name);
    table.set(name, member);
  }
  return table;
}

/** A field's value, its container copied, never the objects it references. */
function copied(value: unknown): unknown {
  return value instanceof Map ? new Map(value) : Array.isArray(value) ? [...value] : value;
}

/** A map held on a schema object apart from its fields: an extension's property values, or what a builder wrote to an
 * extension's adjacency, by name. */
function hidden(data: any, name: "_extended" | "_pending"): Map<string, any> {
  let found = data[name];
  if (found === undefined) Object.defineProperty(data, name, { value: (found = new Map()), enumerable: false });
  return found;
}

/** A property an extension added to a meta-schema, held on each schema object apart from its fields. */
function extensionProperty(name: string): Prop {
  const member = new Prop({
    get: (data) => data._extended?.get(name) ?? null,
    put: (data, value) => {
      hidden(data, "_extended").set(name, value);
    },
  });
  member.extension = true;
  return member;
}

/** An adjacency an extension added to a meta-schema: its entries are shared with the objects they link, as a proxy's
 * are, each held in the index of every object it links (Proxies' `addEntry`). A builder writes the objects it links to
 * its working copy; finalized, the schema object's entries are made to agree with them. */
function extensionAdjacency(adjacency: S.OfAdjacency.Data): Members {
  const relation = adjacency.relation as S.OfRelation.Data;
  const me = adjacency.me as string;
  const name = adjacency.name as string;
  const links = [...relation.entry.links.keys()];
  if (links.length !== 2 || relation.entry.properties.size > 0) {
    throw new TypeError(`an extension's adjacency ${repr(name)} is to a relation of two links and no properties, got `
      + repr(relation.name));
  }
  const other = links.find((link) => link !== me) as string;
  const member = new Members(other, {
    accepts: () => true,
    extensible: true,
    items: (data, store: unknown = null) => { // a framework schema's entries are its store's
      const pending: Map<string, any[]> | undefined = data._pending;
      if (pending?.has(name)) return [...(pending.get(name) as any[])];
      return Proxies._linking(relation, me, data, store).map((entry: any) => innerOf(entry)._links.get(other));
    },
    store: (data, referents) => {
      hidden(data, "_pending").set(name, [...referents]);
    },
  });
  member.extension = [relation, me, other];
  return member;
}

/** Makes a schema object's entries in the relations an extension added agree with what its builder wrote, in its
 * builder's store. */
function settleExtended(data: any, store: unknown): any {
  const pending: Map<string, any[]> | undefined = data._pending;
  if (pending === undefined) return data;
  const table = (builderFor(data) as unknown as typeof Builder)._table;
  for (const [name, referents] of pending) {
    const [relation, me, other] = (table.get(name) as Members).extension as [S.OfRelation.Data, string, string];
    const held = Proxies._linking(relation, me, data, store);
    const linked = (entry: any) => innerOf(entry)._links.get(other);
    Proxies._discard(relation, held.filter((entry: any) => referents.every((referent) => linked(entry) !== referent)), store);
    for (const referent of referents) {
      if (held.every((entry: any) => linked(entry) !== referent)) {
        Proxies._add_entry(relation, Proxies._make_entry(relation, new Map([[me, data], [other, referent]]), new Map()), store);
      }
    }
  }
  pending.clear();
  return data;
}

/** Gives each schema builder the members an extension added to its meta-schema (or one it refines): `added` holds each
 * meta-schema's names before the extension. */
function extendBuilders(added: Map<unknown, [Set<string>, Set<string>]>): void {
  for (const builderClass of new Set(BUILDERS.values()) as unknown as Set<typeof Builder>) {
    const meta = (Meta as Record<string, any>)[builderClass._meta];
    const [properties, adjacencies] = added.get(meta) as [Set<string>, Set<string>];
    const members: [string, Prop | Members][] = [];
    for (const name of meta.properties.keys()) {
      if (!properties.has(name) && !builderClass._table.has(name)) members.push([name, extensionProperty(name)]);
    }
    for (const [name, adjacency] of meta.adjacencies) {
      if (!adjacencies.has(name) && !builderClass._table.has(name)) members.push([name, extensionAdjacency(adjacency)]);
    }
    for (const [name, member] of members) {
      member._bind(name);
      builderClass._table.set(name, member);
    }
  }
}

/** A writable `Visitors.OfObject` over a meta-schema (`_meta`, a name in `Meta`), building its data (`_data`).
 * Read-only, it reads the data it is given and refuses every write: a referent read through a link is. */
abstract class Builder extends Shelled {
  static _data: Function;
  static _meta: string;
  static _noun: string;
  static _table: Table = new Map();
  declare readonly [TYPE_NAME]: string;
  /** Its members, by name: typed loosely, as the proxy DSL's are. */
  [member: string]: any;

  _original: any;
  _writable: boolean;
  _store: Store | null;
  /** The members written, in order. */
  _written: (Prop | Members)[] = [];
  /** The identity written (`as_identity`). */
  _identity: string | null = null;
  _working: any;

  constructor(original: unknown = null, writable = true, store: Store | null = null) {
    super();
    const kind = this.constructor as typeof Builder;
    if (original !== null && !(original instanceof kind._data)) {
      throw new TypeError(`a builder of ${kind._noun} is given ${repr(original)}`);
    }
    this._original = original;
    this._writable = writable;
    this._store = store;
    this._working = this._make();
    if (original !== null) this._update(this._working, original);
    return shell(this);
  }

  _table(): Table {
    return (this.constructor as typeof Builder)._table;
  }

  _make(): any {
    return new ((this.constructor as typeof Builder)._data as new () => unknown)();
  }

  /** Writes `source`'s fields into `target`, copying the containers it holds, never the objects they reference. */
  _update(target: any, source: any): void {
    for (const [name, value] of Object.entries(source)) target[name] = copied(value);
    for (const member of this._table().values()) { // the members an extension added, which no field holds
      if (member instanceof Prop && member.extension) member.put(target, copied(member.get(source)));
      else if (member instanceof Members && member.extension !== null) member.store(target, member.items(source, this._store));
    }
  }

  _finalize(target: any): any {
    return target;
  }

  /** Returns new data. Only valid without data given. */
  create(...args: unknown[]): any {
    noArguments("create", args);
    if (this._original !== null) throw new ValueError("create() is only valid without a source instance; use clone() or update()");
    return this._detached(this._identified(this._finalize(this._working), this._identity));
  }

  /** Returns new data, leaving the data given as it is. Only valid with data given. */
  clone(...args: unknown[]): any {
    noArguments("clone", args);
    if (this._original === null) throw new ValueError("clone() is only valid with a source instance");
    this._cloneMembers();
    return this._detached(this._identified(this._finalize(this._working), this._identity));
  }

  /** `data`, finalized, which the builder no longer writes: it goes on working on a copy, so that finalizing it again
   * gives other data. */
  _detached(data: any): any {
    this._working = this._make();
    this._update(this._working, data);
    return data;
  }

  /** A member has one owner: a clone has its own members, each cloned, with an identity of its own; those it shares by
   * other means (an object schema's inherited ones, which its members do not list) stay shared. */
  _cloneMembers(): void {
    for (const members of this._table().values()) {
      if (members instanceof Members && members.owned && members.build !== null) {
        const builderClass = members._builderClass();
        members.store(this._working, members.items(this._working).map((referent) =>
          new builderClass(referent, true, this._store).clone()));
      }
    }
  }

  /** Writes the builder's state into the data given, and returns it. Only valid with data given. */
  update(...args: unknown[]): any {
    noArguments("update", args);
    if (this._original === null) throw new ValueError("update() is only valid with a source instance");
    if (this._store !== null) this._store._permit(this);
    this._update(this._original, this._working);
    return this._identified(this._finalize(this._original), this._identity ?? identity_of(this._original));
  }

  /** `data`, given `identity`, else one allocated: by its store, which refuses one another of its schema objects has,
   * where it is built in one. */
  _identified(data: any, identity: string | null): any {
    const chosen = identity || this._allocate();
    return settleExtended(this._store === null ? identify(data, chosen) : this._store._hold(data, chosen), this._store);
  }

  /** The identity a schema object is given on creation, where none is written: a UUID. */
  _allocate(): string {
    return Proxies._uuid4();
  }

  /** A referent edited through its link: updated, as a reference object is. */
  _edited(): any {
    return this.update();
  }

  _check(): void {
    if (!this._writable) {
      const noun = (this.constructor as typeof Builder)._noun;
      throw new ReadOnlyError(`${noun} read through a link is read-only; write it by calling the link with a callback`);
    }
  }

  _write(prop: Prop, value: unknown): void {
    this._check();
    prop.put(this._working, value);
    this._written.push(prop);
  }

  as_schema(): any {
    return (Meta as any)[(this.constructor as typeof Builder)._meta] ?? null;
  }

  /** Read, the identity written, else the one of the data given; null for a schema object not created yet that none is
   * written for. Written, the identity the object takes, and the builder: created or cloned, it is given one only where
   * none is written; updated, it keeps its own unless one is written, which renames it. */
  as_identity(identity: unknown = null): any {
    if (identity === null) return this._identity ?? identity_of(this._original);
    if (typeof identity !== "string" || identity === "") throw new TypeError(`an identity is non-empty text, got ${repr(identity)}`);
    this._check();
    this._identity = identity;
    return this._proxy;
  }

  /** The names of the members of `kind`, in the order the meta-schema declares them (its `declared` map); a name it
   * lacks sorts last (its index, -1, as an unsigned int). */
  _ordered(kind: Function, declared: string): string[] {
    const order = [...new Map(Object(this.as_schema())[declared]).keys()];
    return [...this._table()].filter(([, member]) => member instanceof kind).map(([name]) => name)
      .sort((a, b) => (order.indexOf(a) >>> 0) - (order.indexOf(b) >>> 0));
  }

  get as_properties(): any {
    const present = this._ordered(Prop, "properties")
      .filter((name) => (this._table().get(name) as Prop).get(this._working) != null).map((name) => this._proxy[name]);
    return makeProperties(this._proxy, present);
  }

  as_adjacencies(cb: unknown): any {
    for (const name of this._ordered(Members, "adjacencies")) visit(cb, this._proxy[name]);
    return this._proxy;
  }

  override _member(name: string): unknown {
    const member = this._table().get(name);
    if (member instanceof Prop) return callable(new PropertyMember(this, member));
    if (member instanceof Members) return callable(new AdjacencyMember(this, member));
    return makeEmpty(`${repr(name)} is not a member of ${(this.constructor as typeof Builder)._noun}'s builder`);
  }

  override _repr(): string {
    return `<builder of ${(this.constructor as typeof Builder)._noun}>`;
  }
}

/** The adjacency to the schema something has as its type, its evaluation type, of any kind (`Schemas.Typing`): a
 * schema that exists, such as `new Schemas.OfScalar.Data(BigInt)`. */
function typed(field: string): Members {
  return new Members("schema", { accepts: isSchema, ...one(field) });
}

/** A builder of a kind of schema: named, described, and parametric. */
abstract class KindBuilder extends Builder {
  static override _table = extendTable(Builder._table, {
    name: new Prop(),
    description: new Prop(),
    parameters: new Members("parameter", { keyed: true, accepts: isA(S.OfParameter.Data), build: "ParameterBuilder",
      ...byName("parameters") }),
  });

  /** A named schema's identity is its name, a global one; an unnamed one's, a UUID. */
  override _allocate(): string {
    return this._working.name || super._allocate();
  }

  /** A named schema's identity is its name, so it follows a rename, unless one is written. */
  override _identified(data: any, identity: string | null): any {
    const name = data.name ?? null;
    const renamed = name !== null && name !== (NAMED_AS.has(this._original) ? NAMED_AS.get(this._original) : name);
    if (this._identity === null && renamed) identity = name;
    NAMED_AS.set(data, name);
    return super._identified(data, identity);
  }
}

// --- Builders of members ---

/** A builder of a member with a type: a property, a parameter, a symbol, a branch or a part. Its name is the entry's
 * that links it to its owner. */
abstract class TypedBuilder extends Builder {
  static override _table = extendTable(Builder._table, { description: new Prop(), type: typed("type") });
}

export class PropertyBuilder extends TypedBuilder {
  static override _data = S.OfProperty.Data;
  static override _meta = "Property";
  static override _noun = "a property";
}

export class ParameterBuilder extends TypedBuilder {
  static override _data = S.OfParameter.Data;
  static override _meta = "Parameter";
  static override _noun = "a parameter";
}

export class SymbolBuilder extends TypedBuilder {
  static override _data = S.OfSymbol.Data;
  static override _meta = "Symbol";
  static override _noun = "a symbol";
}

/** A union's branch or an intersection's part. */
export class MemberBuilder extends TypedBuilder {
  static override _data = S.OfUnion.Branch;
  static override _meta = "Member";
  static override _noun = "a branch or a part";
}

/** An adjacency: named by the entry that links it to its object schema, or anonymous, with no name. It fills its
 * relation's link `me`, by name: within a schema, its relation's links and properties are named, not referred to. */
export class AdjacencyBuilder extends Builder {
  static override _data = S.OfAdjacency.Data;
  static override _meta = "Adjacency";
  static override _noun = "an adjacency";
  static override _table = extendTable(Builder._table, {
    description: new Prop(),
    me: new Prop(), // the name of the link it fills
    relation: new Members("relation", { accepts: isA(S.OfRelation.Data), build: "RelationBuilder", ...one("relation") }),
  });
}

/** An application's argument, as its builder reads it: `Schemas.OfApply.Data.arguments` holds its value or term under
 * its parameter's name. */
class ArgumentData {
  constructor(public parameter: any = null, public value: unknown = null) {}
}

export class ArgumentBuilder extends Builder {
  static override _data = ArgumentData;
  static override _meta = "Argument";
  static override _noun = "an argument";
  static override _table = extendTable(Builder._table, {
    value: new Prop({ get: (data) => S.Form.is_term(data.value) ? null : data.value }),
    parameter: new Members("parameter", { accepts: isA(S.OfParameter.Data), ...one("parameter") }),
    term: new Members("term", { accepts: S.Form.is_term, build: "FormBuilder", one: true,
      items: (data) => S.Form.is_term(data.value) ? [data.value] : [],
      store: (data, terms) => {
        data.value = last(terms);
      } }),
  });
}

/** A form being built: `Schemas.Form.Data` is immutable. */
class FormWorking {
  kind = "";
  attributes: Map<string, unknown> | null = new Map();
  arguments: unknown[] = [];
  dialect: string | null = null;
}

/** A term in its neutral form. A form is immutable, so a form edited through a link is a new one. */
export class FormBuilder extends Builder {
  static override _data = S.Form.Data;
  static override _meta = "Form";
  static override _noun = "a form";
  static override _table = extendTable(Builder._table, {
    dialect: new Prop(),
    kind: new Prop(),
    attributes: new Prop({ container: true }),
    operands: new Members("operand", { accepts: S.Form.is_term, build: "FormBuilder", ...inOrder("arguments") }),
  });

  override _make(): any {
    return new FormWorking();
  }

  override _update(target: any, source: any): void {
    target.kind = source.kind;
    target.attributes = new Map(source.attributes);
    target.arguments = [...source.arguments];
    target.dialect = source.dialect;
  }

  override _finalize(target: any): any {
    return new S.Form.Data(target.kind, new Map(target.attributes), [...target.arguments], target.dialect);
  }

  override update(...args: unknown[]): any {
    noArguments("update", args);
    throw new TypeError("a form is immutable; use clone()");
  }

  override _edited(): any {
    return this.clone();
  }
}

// --- Builders of kinds ---

/** A width, a term (`Schemas.BitWidth`); one the data holds as a bigint reads as a literal form. */
function width(field: string): Members {
  return new Members("width", { accepts: S.Form.is_term, build: "FormBuilder", one: true,
    items: (data) => {
      const held = data[field];
      return held === null ? [] : typeof held === "bigint" ? [new S.Form.Data("literal", new Map([["value", held]]))] : [held];
    },
    store: (data, terms) => {
      const term = last(terms) as any;
      const literal = term instanceof S.Form.Data && term.kind === "literal" && term.arguments.length === 0
        && term.attributes.size === 1 && typeof term.attributes.get("value") === "bigint";
      data[field] = literal ? term.attributes.get("value") : term;
    } });
}

function refinesMembers(): Members {
  return new Members("refined", { accepts: isSchema, ...one("refines") });
}

/** A refinement takes the token of what it refines, unless it is given one. */
export class ScalarBuilder extends KindBuilder {
  static override _data = S.OfScalar.Data;
  static override _meta = "Scalar";
  static override _noun = "a scalar schema";
  static override _table = extendTable(KindBuilder._table, {
    format: new Prop({
      get: (data) => data.token instanceof S.OfScalar.Token ? data.token.format : null,
      put: (data, value) => {
        data.token = new S.OfScalar.Token(value as string, data.token instanceof S.OfScalar.Token ? data.token.name : "");
      },
    }),
    token: new Prop({
      get: (data) => data.token instanceof S.OfScalar.Token ? data.token.name : null,
      put: (data, value) => {
        data.token = new S.OfScalar.Token(data.token instanceof S.OfScalar.Token ? data.token.format : S.BASIC, value as string);
      },
    }),
    refines: refinesMembers(),
    bits: width("bits"),
    bytes: width("bytes"),
  });

  override _finalize(target: any): any {
    const base = S.structure(target.refines);
    if (target.token === null && base instanceof S.OfScalar.Data) target.token = base.token;
    return target;
  }
}

type Inherited = [Set<string>, Set<string>, S.OfAdjacency.Data[]];

/** What a copy of an object schema inherits, carried from the schema it was copied from until it settles, as Python
 * copies `_inherited` with the copy's other fields (`Schemas.inherited` reads what settling recorded). */
const CARRIED = new WeakMap<object, Inherited>();

function inheritedOf(schema: S.OfObject.Data): Inherited {
  return CARRIED.get(schema) ?? S.inherited(schema);
}

/** A refinement of a reference object schema is one too, and has the members of what it refines. */
export class ObjectBuilder extends KindBuilder {
  static override _data = S.OfObject.Data;
  static override _meta = "Object";
  static override _noun = "an object schema";
  static override _table = extendTable(KindBuilder._table, {
    ref: new Prop(),
    pattern: new Prop(),
    singleton: new Prop(),
    refines: refinesMembers(),
    // A refinement's own members: those it inherits are the refined schema's, through `refines` (Resolved: "Modules
    // write `refines` and a refinement's own members only"); finalizing settles them in again.
    properties: new Members("property", { keyed: true, accepts: isA(S.OfProperty.Data), build: "PropertyBuilder",
      extensible: true, items: (data) => [...data.properties].filter(([name]) => !inheritedOf(data)[0].has(name)).map(([, prop]) => prop),
      store: (data, members) => {
        data.properties = new Map(members.map((m) => [m.name, m]));
      } }),
    adjacencies: new Members("adjacency", { // named ones by name, then anonymous ones, which have none
      keyed: true, accepts: isA(S.OfAdjacency.Data), build: "AdjacencyBuilder", extensible: true,
      items: (data) => [
        ...[...data.adjacencies].filter(([name]) => !inheritedOf(data)[1].has(name)).map(([, adjacency]) => adjacency),
        ...data.anonymous.filter((adjacency: S.OfAdjacency.Data) => !inheritedOf(data)[2].includes(adjacency)),
      ],
      store: (data, members) => {
        data.adjacencies = new Map(members.filter((m) => m.name).map((m) => [m.name, m]));
        data.anonymous = members.filter((m) => !m.name);
      } }),
  });

  /** Also which of its members the source inherits, so that its copy settles as it did. */
  override _update(target: any, source: any): void {
    super._update(target, source);
    CARRIED.set(target, inheritedOf(source));
  }

  /** A copy settles as its source did: the members its source inherits are the refined schema's again. */
  override _finalize(target: any): any {
    const base = S.structure(target.refines);
    if (base instanceof S.OfObject.Data && base.ref) target.ref = true;
    const carried = CARRIED.get(target);
    if (carried !== undefined && base instanceof S.OfObject.Data) {
      const [properties, adjacencies, anonymous] = carried;
      target.properties = new Map([...target.properties].filter(([name]) => !properties.has(name)));
      target.adjacencies = new Map([...target.adjacencies].filter(([name]) => !adjacencies.has(name)));
      target.anonymous = target.anonymous.filter((adjacency: S.OfAdjacency.Data) => !anonymous.includes(adjacency));
    }
    CARRIED.delete(target); // settling records what it inherits
    return S.settle(target);
  }
}

export class UnionBuilder extends KindBuilder {
  static override _data = S.OfUnion.Data;
  static override _meta = "Union";
  static override _noun = "a union";
  static override _table = extendTable(KindBuilder._table, {
    flat: new Prop(),
    branches: new Members("branch", { keyed: true, accepts: isA(S.OfUnion.Branch), build: "MemberBuilder",
      extensible: true, ...inOrder("branches") }),
  });
}

export class IntersectionBuilder extends KindBuilder {
  static override _data = S.OfIntersection.Data;
  static override _meta = "Intersection";
  static override _noun = "an intersection";
  static override _table = extendTable(KindBuilder._table, {
    flat: new Prop(),
    parts: new Members("part", { keyed: true, accepts: isA(S.OfIntersection.Part), build: "MemberBuilder",
      ...inOrder("parts") }),
  });
}

/** A refinement takes the index and element of what it refines, unless it is given them. */
export class ContainerBuilder extends KindBuilder {
  static override _data = S.OfContainer.Data;
  static override _meta = "Container";
  static override _noun = "a container schema";
  static override _table = extendTable(KindBuilder._table, {
    layout: new Prop(), // "dense", "sparse", or null
    refines: refinesMembers(),
    index: new Members("index", { accepts: isSchema, ...one("index") }),
    element: new Members("element", { accepts: isSchema, ...one("element") }),
  });

  override _finalize(target: any): any {
    const base = S.structure(target.refines);
    if (base instanceof S.OfContainer.Data) {
      target.index = target.index === null ? base.index : target.index;
      target.element = target.element === null ? base.element : target.element;
    }
    return target;
  }
}

function argumentsOf(data: S.OfApply.Data): ArgumentData[] {
  const parameters = new Map(Object(S.structure(data.of)).parameters) as Map<string, unknown>;
  return [...data.arguments].map(([name, value]) => new ArgumentData(parameters.get(name) ?? new S.OfParameter.Data({ name }), value));
}

export class ApplyBuilder extends KindBuilder {
  static override _data = S.OfApply.Data;
  static override _meta = "Apply";
  static override _noun = "an application";
  static override _table = extendTable(KindBuilder._table, {
    of: new Members("applied", { accepts: isSchema, ...one("of") }),
    arguments: new Members("argument", { owned: true, accepts: isA(ArgumentData), build: "ArgumentBuilder",
      items: argumentsOf,
      store: (data, members) => {
        data.arguments = new Map(members.map((m) => [m.parameter.name, m.value]));
      } }),
  });
}

/** A value of any type, or of one of `types`. */
export class AnyValueBuilder extends KindBuilder {
  static override _data = S.OfAny.Value;
  static override _meta = "Any";
  static override _noun = "a value of any type";
  static override _table = extendTable(KindBuilder._table, {
    types: new Members("schema", { accepts: isSchema, ...inOrder("types") }),
  });
}

export class PredicateBuilder extends KindBuilder {
  static override _data = S.OfPredicate.Data;
  static override _meta = "Predicate";
  static override _noun = "a predicate";
  static override _table = extendTable(KindBuilder._table, {
    symbols: new Members("symbol", { keyed: true, accepts: isA(S.OfSymbol.Data), build: "SymbolBuilder", ...byName("symbols") }),
    requires: new Members("term", { accepts: S.Form.is_term, build: "FormBuilder", ...one("requires") }),
  });
}

/** `unique` clauses, each the names of links and properties: a name, one clause of one name; names, one clause; a list
 * of lists of names, several clauses. */
function clauses(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string") return [[value]];
  const items = [...(value as Iterable<unknown>)];
  if (items.every((item) => typeof item === "string")) return [items];
  return items.map((item) => typeof item === "string" ? [item] : [...(item as Iterable<unknown>)]);
}

/** A relation's `unique` clauses as lists of names: links and properties in declaration order, then any other names,
 * sorted; null for none. */
function uniquesOf(data: S.OfRelation.Data): string[][] | null {
  const names = [...data.entry.links.keys(), ...data.entry.properties.keys()];
  const found = data.uniques.map((unique) => [...names.filter((name) => unique.has(name)),
    ...sortedStrings([...unique].filter((name) => !names.includes(name)))]);
  return found.length > 0 ? found : null;
}

/** A relation's links and properties are its entries': the meta-schema has them as the relation's own. Its `unique`
 * clauses name them. */
export class RelationBuilder extends KindBuilder {
  static override _data = S.OfRelation.Data;
  static override _meta = "Relation";
  static override _noun = "a relation";
  static override _table = extendTable(KindBuilder._table, {
    links: new Members("link", { keyed: true, accepts: isA(S.OfSymbol.Data), build: "SymbolBuilder",
      items: (data) => [...data.entry.links.values()],
      store: (data, links) => {
        data.entry.links = new Map(links.map((m) => [m.name, m]));
      } }),
    properties: new Members("property", { keyed: true, accepts: isA(S.OfProperty.Data), build: "PropertyBuilder",
      extensible: true, items: (data) => [...data.entry.properties.values()],
      store: (data, properties) => {
        data.entry.properties = new Map(properties.map((m) => [m.name, m]));
      } }),
    uniques: new Prop({
      get: uniquesOf,
      put: (data, value) => {
        data.uniques = ((value ?? []) as string[][]).map((clause) => new Set(clause));
      },
      shorthand: clauses,
      container: true,
    }),
  });

  override _update(target: any, source: any): void {
    super._update(target, source);
    target.entry = new S.OfEntry.Data({ links: new Map(source.entry.links), properties: new Map(source.entry.properties) });
  }
}

/** A module: the schemas and the modules it defines, each under its name within it, the last part of its path
 * (`Person` in `crm`, defining `crm.Person`). Its name is its path; the store's root module has none. */
class ModuleData {
  name: string | null = null;
  description: string | null = null;
  parameters = new Map<string, unknown>();
  schemas = new Map<string, unknown>();
}

/** The names given to a module's entries while it is built, by referent, until they are stored. */
const DEFINED = new WeakMap<object, Map<unknown, string>>();

function definedName(data: ModuleData, referent: unknown): string | null {
  return ([...data.schemas, [null, referent]].find(([, held]) => held === referent) as [string | null, unknown])[0];
}

function define(data: ModuleData, referent: unknown, name: string): void {
  if (!DEFINED.has(data)) DEFINED.set(data, new Map());
  (DEFINED.get(data) as Map<unknown, string>).set(referent, name);
}

function storeDefined(data: ModuleData, referents: unknown[]): void {
  const names = new Map([...data.schemas].map(([name, held]) => [held, name]));
  for (const [referent, name] of DEFINED.get(data) ?? []) names.set(referent, name);
  DEFINED.delete(data);
  data.schemas = new Map(referents.map((referent) => [names.get(referent) || local(referent), referent]));
}

/** A schema's name within its module: the last part of its path. */
function local(schema: unknown): string {
  return [Object(schema).name].filter(Boolean).join("").split(".").pop() as string;
}

/** A module, a reference object in the store, whose identity is its path: the root module's is `.`. */
export class ModuleBuilder extends KindBuilder {
  static override _data = ModuleData;
  static override _meta = "Module";
  static override _noun = "a module";
  static override _table = extendTable(KindBuilder._table, {
    schemas: new Members("schema", { keyed: true, owned: false, names: [definedName, define], extensible: true,
      accepts: (v) => _namable(v),
      items: (data) => [...data.schemas.values()], store: storeDefined }),
  });

  override _allocate(): string {
    return this._working.name || ".";
  }
}

const BUILDER_CLASSES = new Map<string, BuilderClass>([
  ["PropertyBuilder", PropertyBuilder], ["ParameterBuilder", ParameterBuilder], ["SymbolBuilder", SymbolBuilder],
  ["MemberBuilder", MemberBuilder], ["AdjacencyBuilder", AdjacencyBuilder], ["ArgumentBuilder", ArgumentBuilder],
  ["FormBuilder", FormBuilder], ["RelationBuilder", RelationBuilder],
]);

const BUILDERS = new Map<unknown, BuilderClass>([
  [S.OfScalar.Data, ScalarBuilder], [S.OfObject.Data, ObjectBuilder], [S.OfUnion.Data, UnionBuilder],
  [S.OfIntersection.Data, IntersectionBuilder], [S.OfContainer.Data, ContainerBuilder], [S.OfApply.Data, ApplyBuilder],
  [S.OfAny.Value, AnyValueBuilder], [S.OfPredicate.Data, PredicateBuilder], [S.OfRelation.Data, RelationBuilder],
  [S.OfProperty.Data, PropertyBuilder], [S.OfParameter.Data, ParameterBuilder], [S.OfSymbol.Data, SymbolBuilder],
  [S.OfUnion.Branch, MemberBuilder], [S.OfAdjacency.Data, AdjacencyBuilder], [ArgumentData, ArgumentBuilder],
  [S.Form.Data, FormBuilder], [ModuleData, ModuleBuilder],
]);

for (const builderClass of new Set(BUILDERS.values())) {
  Object.defineProperty(builderClass.prototype, TYPE_NAME, { value: builderClass.name });
}

/** The builder of a referent's data; null for a term of a dialect, which this package does not build. */
function builderFor(referent: unknown): BuilderClass | null {
  return BUILDERS.get(Object(referent).constructor) ?? null;
}

/** The name of a schema object's meta-schema, `Schemas.Object`: the kind its identity is unique within. */
export function _kind(data: unknown): string {
  return `Schemas.${(builderFor(data) as unknown as typeof Builder)._meta}`;
}

/** Whether a schema object has a name of its own (a kind of schema, a relation, a predicate, a module), rather than
 * the one its owner's entry gives it. */
export function _namable(data: unknown): boolean {
  return isSchema(data) || data instanceof S.OfRelation.Data || data instanceof S.OfPredicate.Data || data instanceof ModuleData;
}

// --- The meta-schemas: schema objects, each a reference object, and the relations between them ---

type ObjectData = S.OfObject.Data;
type RelationData = S.OfRelation.Data;

/** The meta-schemas, by name: `Meta.Object` is `Schemas.Object`, and so on; and the basic scalars, `Meta.OfInt` being
 * `Schemas.OfInt`. */
export const Meta = {} as {
  OfBool: S.OfScalar.Data; OfInt: S.OfScalar.Data; OfFloat: S.OfScalar.Data; OfStr: S.OfScalar.Data;
  OfBytes: S.OfScalar.Data;
  Schema: ObjectData; Type: ObjectData; Scalar: ObjectData; Object: ObjectData; Union: ObjectData;
  Intersection: ObjectData; Container: ObjectData; Apply: ObjectData; Any: ObjectData; Relation: ObjectData;
  Predicate: ObjectData; Typed: ObjectData; Property: ObjectData; Parameter: ObjectData; Symbol: ObjectData;
  Member: ObjectData; Adjacency: ObjectData; Argument: ObjectData; Term: ObjectData; Form: ObjectData; Module: ObjectData;
  Typing: RelationData; Refines: RelationData; Indexing: RelationData; Containing: RelationData; Applying: RelationData;
  AnyOf: RelationData; Relating: RelationData; Binding: RelationData; ArgumentTerm: RelationData; Requires: RelationData;
  BitWidth: RelationData; ByteWidth: RelationData; HasParameter: RelationData; HasProperty: RelationData;
  HasAdjacency: RelationData; HasBranch: RelationData; HasPart: RelationData; HasSymbol: RelationData;
  HasLink: RelationData; HasArgument: RelationData; Operands: RelationData; Defines: RelationData;
};

// The basic scalars, which every store holds, named after the basic tokens (FRAMEWORK.md, Resolved: "Schemas.OfBool,
// Schemas.OfInt, ... no need to invent an alternate convention").
Meta.OfBool = new ScalarBuilder().name("Schemas.OfBool").token("bool").create();
Meta.OfInt = new ScalarBuilder().name("Schemas.OfInt").token("int").create();
Meta.OfFloat = new ScalarBuilder().name("Schemas.OfFloat").token("float").create();
Meta.OfStr = new ScalarBuilder().name("Schemas.OfStr").token("str").create();
Meta.OfBytes = new ScalarBuilder().name("Schemas.OfBytes").token("bytes").create();
const [Text, Bool, Int] = [Meta.OfStr, Meta.OfBool, Meta.OfInt];

/** A meta-schema: a reference object schema, `Schemas.<name>`, with `properties` of their schemas, by name, refining
 * `refines`. */
function metaObject(name: string, properties: [string, unknown][], refines: unknown): ObjectData {
  const builder = new ObjectBuilder()
    .name(`Schemas.${name}`)
    .ref(true)
    .properties(properties.map(([n, s]) => (t: any) => t.name(n).type([s])));
  if (refines !== null) builder.refines([refines]);
  return builder.create();
}

Meta.Schema = metaObject("Schema", [["name", Text], ["description", Text]], null);
Meta.Type = metaObject("Type", [], Meta.Schema);
Meta.Scalar = metaObject("Scalar", [["format", Text], ["token", Text]], Meta.Type);
Meta.Object = metaObject("Object", [["ref", Bool], ["pattern", Text], ["singleton", Text]], Meta.Type);
Meta.Union = metaObject("Union", [["flat", Bool]], Meta.Type);
Meta.Intersection = metaObject("Intersection", [["flat", Bool]], Meta.Type);
Meta.Container = metaObject("Container", [["layout", Text]], Meta.Type);
Meta.Apply = metaObject("Apply", [], Meta.Type);
Meta.Any = metaObject("Any", [], Meta.Type);
Meta.Relation = metaObject("Relation", [["uniques", new ContainerBuilder().index([Int]).element([
  new ContainerBuilder().index([Int]).element([Text]).create()]).create()]], Meta.Schema);
Meta.Predicate = metaObject("Predicate", [], Meta.Schema);
Meta.Typed = metaObject("Typed", [["description", Text]], null);
Meta.Property = metaObject("Property", [], Meta.Typed);
Meta.Parameter = metaObject("Parameter", [], Meta.Typed);
Meta.Symbol = metaObject("Symbol", [], Meta.Typed);
Meta.Member = metaObject("Member", [], Meta.Typed);
Meta.Adjacency = metaObject("Adjacency", [["description", Text], ["me", Text]], null);
/** A scalar of any type, written tagged with its token (`{"int": 8}`). */
export const Scalars: S.OfAny.Value = new AnyValueBuilder().create();
Meta.Argument = metaObject("Argument", [["value", Scalars]], null);
Meta.Term = metaObject("Term", [], null);
Meta.Form = metaObject("Form", [["dialect", Text], ["kind", Text],
  ["attributes", new ContainerBuilder().index([Text]).element([Scalars]).create()]], Meta.Term);
Meta.Module = metaObject("Module", [], Meta.Schema); // its identity is its path; it defines schemas and modules

/** A meta-schema relation, `Schemas.<name>`, with `links`, its first and second, constrained as `how` says (see
 * `RELATIONS`): a keyed relation's entries have `name`; the member determines its owner and its name
 * (`unique(owner, name)`), and the owner and the name determine the member (`unique(member)`). */
function metaRelation(name: string, links: [string, string], how: string): RelationData {
  const [first, second] = links;
  const builder = new RelationBuilder().name(`Schemas.${name}`).links(links.map((n) => (t: any) => t.name(n)));
  if (how === "keyed") builder.properties([(t: any) => t.name("name").type([Text])]);
  const determined = new Map<string, string[][] | null>([["one", [[second]]], ["owned", [[first]]],
    ["keyed", [[first, "name"], [second]]], ["list", null]]).get(how);
  return builder.uniques(determined).create();
}

/** An adjacency to `relation` filling `link`: named by the entry that links it to its object schema, or anonymous. */
function metaAdjacency(relation: RelationData, link: string): S.OfAdjacency.Data {
  return new AdjacencyBuilder().relation([relation]).me(link).create();
}

/** Each relation between schema objects: (relation, (link, schema, adjacency named there), (link, schema), "one": the
 * first determines the second; "owned": the second determines the first; "keyed": owned, and named within its owner by
 * the entry's `name`; "list": neither). An adjacency named "" is declared below, on the kinds that have it, rather than
 * on the link's schema. A member belongs to one owner (`Has*`: the member determines its owner); a schema object has
 * at most one type, refined schema, index, element, applied schema, relation, parameter, term or width (the first
 * determines the second); types and operands are lists. */
const RELATIONS: [keyof typeof Meta, [string, ObjectData, string], [string, ObjectData], string][] = [
  ["Typing", ["typed", Meta.Typed, "type"], ["schema", Meta.Type], "one"],
  ["Refines", ["refinement", Meta.Type, ""], ["refined", Meta.Type], "one"],
  ["Indexing", ["container", Meta.Container, "index"], ["index", Meta.Type], "one"],
  ["Containing", ["container", Meta.Container, "element"], ["element", Meta.Type], "one"],
  ["Applying", ["application", Meta.Apply, "of"], ["applied", Meta.Type], "one"],
  ["AnyOf", ["any", Meta.Any, "types"], ["schema", Meta.Type], "list"],
  ["Relating", ["adjacency", Meta.Adjacency, "relation"], ["relation", Meta.Relation], "one"],
  ["Binding", ["argument", Meta.Argument, "parameter"], ["parameter", Meta.Parameter], "one"],
  ["ArgumentTerm", ["argument", Meta.Argument, "term"], ["term", Meta.Term], "one"],
  ["Requires", ["predicate", Meta.Predicate, "requires"], ["term", Meta.Term], "one"],
  ["BitWidth", ["scalar", Meta.Scalar, "bits"], ["width", Meta.Term], "one"],
  ["ByteWidth", ["scalar", Meta.Scalar, "bytes"], ["width", Meta.Term], "one"],
  ["HasParameter", ["owner", Meta.Schema, "parameters"], ["parameter", Meta.Parameter], "keyed"],
  ["HasProperty", ["owner", Meta.Schema, ""], ["property", Meta.Property], "keyed"],
  ["HasAdjacency", ["owner", Meta.Object, "adjacencies"], ["adjacency", Meta.Adjacency], "keyed"],
  ["HasBranch", ["owner", Meta.Union, "branches"], ["branch", Meta.Member], "keyed"],
  ["HasPart", ["owner", Meta.Intersection, "parts"], ["part", Meta.Member], "keyed"],
  ["HasSymbol", ["owner", Meta.Predicate, "symbols"], ["symbol", Meta.Symbol], "keyed"],
  ["HasLink", ["owner", Meta.Relation, "links"], ["link", Meta.Symbol], "keyed"],
  ["HasArgument", ["owner", Meta.Apply, "arguments"], ["argument", Meta.Argument], "owned"],
  ["Operands", ["form", Meta.Form, "operands"], ["operand", Meta.Term], "list"],
  ["Defines", ["module", Meta.Module, "schemas"], ["schema", Meta.Schema], "keyed"],
];

/** The adjacencies each meta-schema declares: named ones by name, and anonymous ones. */
const NAMED = new Map<ObjectData, [Map<string, S.OfAdjacency.Data>, S.OfAdjacency.Data[]]>();

function declare(schema: ObjectData, adjacency: S.OfAdjacency.Data, name: string | null): void {
  if (!NAMED.has(schema)) NAMED.set(schema, [new Map(), []]);
  const [named, anonymous] = NAMED.get(schema) as [Map<string, S.OfAdjacency.Data>, S.OfAdjacency.Data[]];
  if (name === null) anonymous.push(adjacency);
  else named.set(name, adjacency);
}

for (const [name, [a, aSchema, named], [b, bSchema], how] of RELATIONS) {
  const relation = metaRelation(name, [a, b], how);
  (Meta as Record<string, unknown>)[name] = relation;
  if (named !== "") declare(aSchema, metaAdjacency(relation, a), named);
  declare(bSchema, metaAdjacency(relation, b), null);
}
for (const owner of [Meta.Object, Meta.Relation]) { // each has its own `properties`; any schema may be the owner
  declare(owner, metaAdjacency(Meta.HasProperty, "owner"), "properties");
}
for (const refining of [Meta.Scalar, Meta.Object, Meta.Container]) { // only these refine
  declare(refining, metaAdjacency(Meta.Refines, "refinement"), "refines");
}
for (const [schema, [named, anonymous]] of NAMED) {
  (
    new ObjectBuilder(schema)
      .adjacencies([...named].map(([n, a]) => (t: any) => t.name(n).adjacency(a)))
      .adjacencies(anonymous)
      .update()
  );
}

// --- A store: where schema objects and data are built ---

/** The schema objects a store builds as `store.Schemas.<Name>(...)`, each through its builder. */
export const _META_BUILDERS = new Map<string, BuilderClass>([
  ["Scalar", ScalarBuilder], ["Object", ObjectBuilder], ["Union", UnionBuilder], ["Intersection", IntersectionBuilder],
  ["Container", ContainerBuilder], ["Apply", ApplyBuilder], ["Any", AnyValueBuilder], ["Relation", RelationBuilder],
  ["Predicate", PredicateBuilder], ["Property", PropertyBuilder], ["Parameter", ParameterBuilder],
  ["Symbol", SymbolBuilder], ["Member", MemberBuilder], ["Adjacency", AdjacencyBuilder], ["Form", FormBuilder],
  ["Module", ModuleBuilder], ["Argument", ArgumentBuilder],
]);

/** Every store in the process, so that what an extension of the framework builds reaches those made before it. */
const STORES = new Set<WeakRef<Store>>();

/** What the framework's extensions built, by kind and identity, which every store holds as framework schemas. */
const FRAMEWORK = new Map<string, unknown>();

/** The framework's extensions applied, by name; the framework's store, under "". */
const EXTENSIONS = new Map<string, Store>();

/** A schema object in a message: its name, else its identity. */
function shown(schema: any): string {
  return repr(schema.name || identity_of(schema));
}

/** Python's `==` on a property's value: a scalar, or a list of them, as a relation's `uniques` is. */
function alike(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => alike(v, b[i]));
  return Object.is(a, b);
}

/** How a builder's update of the schema object it was given would do more than add members to it. */
function extensionProblems(builder: any): string[] {
  const original = builder._original;
  const working = builder._working;
  const problems: string[] = [];
  for (const [name, member] of builder._table() as Table) {
    if (member instanceof Prop) {
      if (!alike(member.get(original), member.get(working))) problems.push(`changes ${repr(name)}`);
      continue;
    }
    // an extension's entries, a framework schema's, are its builder's store's (other members' items take no store)
    const added = addedTo(member.items(original, builder._store), member.items(working));
    if (added === null) {
      problems.push(`removes or replaces what ${repr(name)} holds`);
    } else if (added.length > 0 && !member.extensible) {
      problems.push(`adds to ${repr(name)}, which an extension cannot`);
    } else if (added.length > 0 && member.keyed && original instanceof S.OfObject.Data) {
      problems.push(...clashes(original, added.map((referent) => member.name_of(working, referent))));
    }
  }
  if (original instanceof S.OfObject.Data) { // a member it inherits, given again, is its own: a redeclaration
    const [properties, adjacencies] = S.inherited(original);
    for (const name of properties) {
      if (working.properties.has(name) && working.properties.get(name) !== original.properties.get(name)) {
        problems.push(`adds ${repr(name)}, which it inherits`);
      }
    }
    for (const name of adjacencies) {
      if (working.adjacencies.has(name) && working.adjacencies.get(name) !== original.adjacencies.get(name)) {
        problems.push(`adds ${repr(name)}, which it inherits`);
      }
    }
  }
  return problems;
}

/** Whether a builder's update would change the schema object it was given, apart from the entries of the relations an
 * extension added, which are its store's (a framework schema's are not the shared object's). */
function changes(builder: any): boolean {
  const original = builder._original;
  const working = builder._working;
  for (const member of (builder._table() as Table).values()) {
    if (member instanceof Prop) {
      if (!alike(member.get(original), member.get(working))) return true;
    } else if (member.extension === null && addedTo(member.items(original), member.items(working))?.length !== 0) {
      return true;
    }
  }
  return false;
}

/** What `after` holds besides what `before` does, which it holds in the same order, wherever the additions stand (an
 * object schema's anonymous adjacencies follow its named ones); null where it lacks or replaces one. */
function addedTo(before: readonly unknown[], after: readonly unknown[]): unknown[] | null {
  const added: unknown[] = [];
  let next = 0;
  for (const referent of after) {
    if (next < before.length && referent === before[next]) next += 1;
    else added.push(referent);
  }
  return next < before.length ? null : added;
}

/** The names an extension adds to an object schema that it has already, as a property or an adjacency, its own or
 * inherited, or that a schema refining it declares. */
function clashes(schema: S.OfObject.Data, names: (string | null)[]): string[] {
  const problems: string[] = [];
  const refinements = [...S._refinements(schema)];
  for (const refinement of refinements) {
    for (const found of S._refinements(refinement)) if (!refinements.includes(found)) refinements.push(found);
  }
  const [properties, adjacencies] = S.inherited(schema);
  for (const name of names) {
    if (!name) continue;
    if (schema.properties.has(name) || schema.adjacencies.has(name)) {
      problems.push(`adds ${repr(name)}, which it ${properties.has(name) || adjacencies.has(name) ? "inherits" : "has"}`);
    }
    for (const refinement of refinements) {
      const [own, ownAdjacencies] = S.inherited(refinement);
      if ((refinement.properties.has(name) && !own.has(name)) || (refinement.adjacencies.has(name) && !ownAdjacencies.has(name))) {
        problems.push(`adds ${repr(name)}, which ${shown(refinement)} declares`);
      }
    }
  }
  return problems;
}

/** Extends the framework, once per process (docs/SCHEMA_EXTENSION.md): `cb`, given the framework's store, builds schemas
 * and adds members to framework schemas, as `Store.extend` does a store's, and every store, made before or after, holds
 * what it built as framework schemas. Extending again under a name already applied does nothing. */
export function extend(name: string, cb: unknown): void {
  if (typeof name !== "string" || !name) throw new TypeError(`an extension is named by non-empty text, got ${repr(name)}`);
  if (EXTENSIONS.has(name)) return;
  const store: any = EXTENSIONS.get("") ?? new Store();
  EXTENSIONS.set("", store);
  const before = new Set(store._objects.keys());
  const metas = new Map<unknown, [Set<string>, Set<string>]>();
  for (const meta of Object.values(Meta)) {
    if (meta instanceof S.OfObject.Data) metas.set(meta, [new Set(meta.properties.keys()), new Set(meta.adjacencies.keys())]);
  }
  store._extendsFramework = true;
  try {
    store.extend(cb);
  } finally {
    store._extendsFramework = false;
  }
  const built = new Map([...(store._objects as Map<string, unknown>)].filter(([held, schema]) =>
    !before.has(held) && !(schema instanceof ModuleData)));
  for (const [held, schema] of built) FRAMEWORK.set(held, schema);
  for (const held of [...STORES].map((ref) => ref.deref()).filter((live) => live !== undefined)) {
    (held as Store)._adopt(built);
  }
  extendBuilders(metas);
  EXTENSIONS.set(name, store);
}

/** A store of schema objects and data. No reference object is built outside a store, a schema object included.
 *
 * The canonical form of building is `store.moduleName.[...moduleName].schemaName(...)`, each part of a schema's name a
 * member: `store.Schemas.Object(...)` builds an object schema, `store.crm.Contact(...)` a contact. Called with a
 * `Specs.Callback[Visitors.OfX]`, it creates an object; with an object and a callback, it updates the object; with an
 * object alone, it clones it. It returns the object. A schema object built here, and each member built with it, is
 * given its identity by the store, which refuses one it holds another with; a named schema is registered under its
 * name, so that the store builds its objects next. The store is a `Proxy`: a name it lacks starts a schema's name,
 * except JavaScript's protocol probes (`then`, ...), and one starting with `_` throws `AttributeError`.
 *
 * A store changes a schema it holds but does not own through `extend`, which only adds members to it
 * (docs/SCHEMA_EXTENSION.md); a framework schema, which every store holds, only through `Builders.extend`. */
export class Store extends Proxies.OfStore {
  /** `store.moduleName.[...moduleName].schemaName(...)`, each a path (`_Path`); dynamic by design. */
  [name: string]: any;
  /** The schema objects, by their kind and their identity (`key`). */
  readonly _objects = new Map<string, unknown>();
  /** The framework's own schemas, which every store holds. */
  readonly _framework: Set<unknown>;
  /** The schema objects held when an extension began, while it runs. */
  _extending: Set<unknown> | null = null;
  /** Whether this store is the framework's, extending it. */
  _extendsFramework = false;
  /** The modules, by path; the root module's is "". */
  readonly _modules = new Map<string, ModuleData>();
  /** Each schema's module, and its name there. */
  readonly _placed = new Map<unknown, [ModuleData, string]>();
  /** The unnamed schema objects given an identity by the first object to link them. */
  readonly _linked = new Set<unknown>();
  readonly _root: ModuleData;

  constructor() {
    super();
    for (const schema of Object.values(Meta) as (ObjectData | RelationData)[]) { // the meta-schemas
      if (!this._schemas.has(schema.name as string)) {
        this._objects.set(key(_kind(schema), identity_of(schema) as string), schema);
        this.register(schema);
      }
    }
    for (const schema of Mutations.SCHEMAS) { // the mutation schemas, which every store holds too
      this._objects.set(key(_kind(schema), identity_of(schema) as string), schema);
      this.register(schema as ObjectData);
    }
    this._framework = new Set(this._objects.values());
    this._adopt(FRAMEWORK); // what the framework's extensions built
    STORES.add(new WeakRef(this));
    const proxy = new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === "symbol" || prop in target) return Reflect.get(target, prop, receiver);
        if (prop.startsWith("_")) throw new AttributeError(prop);
        if (Proxies._probes.has(prop)) return undefined;
        return makePath(receiver, prop);
      },
    });
    this._root = new ModuleBuilder(null, true, proxy).create();
    return proxy;
  }

  /** The schema object of `kind` (its meta-schema's name, `Schemas.Object`) whose identity is `identity`; null where the
   * store holds none. Schema objects of different kinds may share an identity: a module and a schema its path names
   * (`crm.Contact` and `crm.Contact.v2`'s module). */
  held(kind: string, identity: string): any {
    return this._objects.get(key(kind, identity)) ?? null;
  }

  /** Whether the store holds the schema object `data`. */
  holds(data: unknown): boolean {
    const identity = identity_of(data);
    return identity !== null && this._objects.get(key(_kind(data), identity)) === data;
  }

  /** The module whose path is `path` (`crm.sales`), made with the modules it is in where there is none; the root module
   * for "". Every schema is in one: a named schema in the module its name's prefix names, the root module's where it
   * has none. */
  module(path = ""): any {
    return this._modules.get(path) ?? new ModuleBuilder(null, true, this).name(path).create();
  }

  /** Whether `schema` is one of the framework's own, which every store holds: a meta-schema, a basic scalar, a mutation
   * schema, or what an extension of the framework built (`Builders.extend`). It is never written, only referred to. */
  framework(schema: unknown): boolean {
    return this._framework.has(schema);
  }

  /** Builds and changes schemas through `cb`, given the store: a schema the store held before may only gain members (an
   * object schema's properties and adjacencies, a relation's properties, a union's branches), each under a name it
   * neither has nor inherits, nor a refinement of it declares; anything else about it stays as it was. What `cb` builds
   * is the store's own. Refused, a change to a schema throws before it is written, but what was written before it
   * stays: a refused extension is a program error. */
  extend(cb: unknown): this {
    this._extending = new Set(this._objects.values());
    try {
      visit(cb, this);
    } finally {
      this._extending = null;
    }
    return this;
  }

  /** Refuses a builder's update of a framework schema outside the framework's extension, and one that is not an
   * extension of a schema the store held when an extension began. */
  _permit(builder: any): void {
    const original = builder._original;
    if (this.framework(original) && !this._extendsFramework && changes(builder)) {
      throw new TypeError(`${shown(original)} is a framework schema, which every store holds: extend it with `
        + "Builders.extend");
    }
    if (this._extending !== null && this._extending.has(original)) {
      const problems = extensionProblems(builder);
      if (problems.length > 0) throw new TypeError(`an extension only adds members to ${shown(original)}: it ${problems.join("; ")}`);
    }
  }

  /** Holds what the framework's extensions built, as framework schemas. */
  _adopt(built: ReadonlyMap<string, unknown>): void {
    for (const [held, schema] of built) {
      this._objects.set(held, schema);
      this._framework.add(schema);
      const name = (schema as { name?: unknown }).name;
      if (_namable(schema) && typeof name === "string" && name && this._schemas.get(name) !== schema) {
        this.register(schema as ObjectData);
      }
    }
  }

  /** Defines a named schema, or a module, in the module its path's prefix names, under the last part of its path; a
   * schema renamed moves. */
  _place(data: any): void {
    if (!S._DOTTED.test(data.name)) return; // not a path: validation reports its name, and it is in no module until it has one
    const at = data.name.lastIndexOf(".");
    const [parentPath, name] = [data.name.slice(0, Math.max(at, 0)), data.name.slice(at + 1)];
    const parent = this.module(parentPath);
    const previous = this._placed.get(data);
    if (previous !== undefined) {
      if (previous[0] === parent && previous[1] === name) return;
      new ModuleBuilder(previous[0], true, this).schemas((adv: any) => adv.remove((entry: any) => entry.schema(data))).update();
    }
    this._placed.set(data, [parent, name]);
    new ModuleBuilder(parent, true, this).schemas([(t: any) => t.name(name).schema(data)]).update();
  }

  /** Gives the schema objects `owner` holds or links that have no name of their own the identities their path from it
   * derives: a member its owner's and its name (`crm.Person.age`); another, the first object's to link it and the
   * adjacency (`crm.Person.tags#type`). */
  _derive(owner: any, identity: string, rebuilt = false): void {
    const builderClass = builderFor(owner) as unknown as typeof Builder;
    for (const [name, members] of builderClass._table) {
      if (!(members instanceof Members) || (rebuilt && members.build === null)) continue; // through a rebuilt object, only what it builds
      members.items(owner).forEach((referent, index) => {
        const through = referent instanceof ArgumentData; // rebuilt on every read: what it builds derives through it
        if (!through && !this._derivable(referent)) return;
        let derived: string;
        if (members.owned) {
          const named = members.name_of(owner, referent); // a member not keyed (an argument) has no name
          if (named) {
            derived = `${identity}.${named}`;
            const clash = this._objects.get(key(_kind(referent), derived));
            if (clash !== undefined && clash !== referent) derived = `${identity}#${name}.${named}`; // another member of that name (invalid)
          } else if (referent instanceof S.OfAdjacency.Data) { // anonymous: named by its relation and link
            if (referent.relation === null) return; // not linked yet (a log being read): it keeps the identity it was given
            derived = `${identity}#(${(referent.relation as RelationData).name}.${referent.me})`;
          } else {
            derived = `${identity}#${name}.${index}`;
          }
        } else if (this._linked.has(referent)) {
          return;
        } else {
          derived = members.one ? `${identity}#${name}` : `${identity}#${name}.${index}`;
          this._linked.add(referent);
        }
        if (!through) this._rehold(referent, derived);
        this._derive(referent, derived, through);
      });
    }
  }

  /** Whether a referent takes an identity from its path: a schema object this store holds, the framework's aside, with
   * no name of its own (a named schema's identity is its name). */
  _derivable(referent: any): boolean {
    const named = _namable(referent) && referent.name;
    return !named && this.holds(referent) && !this.framework(referent);
  }

  _rehold(referent: unknown, identity: string): void {
    const kind = _kind(referent);
    const held = this._objects.get(key(kind, identity));
    if (held === referent) return;
    if (held !== undefined) throw new ValueError(`a schema object with the identity ${repr(identity)} is already in this store`);
    this._objects.delete(key(kind, identity_of(referent) as string));
    this._objects.set(key(kind, identity), identify(referent, identity));
  }

  /** Gives a schema object built here `identity`, refused where another holds it; registers a named schema. */
  _hold(data: any, identity: string): any {
    const kind = _kind(data);
    const held = this._objects.get(key(kind, identity));
    if (held !== undefined && held !== data) {
      throw new ValueError(`a schema object with the identity ${repr(identity)} is already in this store`);
    }
    const previous = identity_of(data);
    if (previous !== null && this._objects.get(key(kind, previous)) === data) this._objects.delete(key(kind, previous));
    this._objects.set(key(kind, identity), identify(data, identity));
    if (isSchema(data) || data instanceof S.OfRelation.Data || data instanceof S.OfPredicate.Data) {
      for (const [name, schema] of [...this._schemas]) {
        if (schema === data && name !== data.name) this._schemas.delete(name); // renamed
      }
      if (data.name && this._schemas.get(data.name) !== data) this.register(data);
    }
    if (data instanceof ModuleData) {
      for (const [path, module] of [...this._modules]) {
        if (module === data && path !== (data.name ?? "")) this._modules.delete(path); // renamed
      }
      this._modules.set(data.name ?? "", data);
    }
    if (_namable(data) && data.name) {
      this._place(data);
      this._derive(data, identity);
    }
    return data;
  }

  _build(name: string, args: unknown[]): any {
    let existing: unknown = null;
    let cb: unknown = null;
    if (args.length === 1 && isFunction(args[0])) cb = args[0];
    else if (args.length === 1) existing = args[0];
    else if (args.length === 2) [existing, cb] = args;
    else throw new TypeError(`${name}(...) takes a callback, an object and a callback, or an object`);
    const kind = name.startsWith("Schemas.") ? _META_BUILDERS.get(name.slice("Schemas.".length)) : undefined;
    let builder: any;
    if (kind !== undefined) builder = new kind(existing, true, this);
    else if (this._schemas.has(name)) builder = this.builder(name, existing);
    else throw new AttributeError(`no schema registered as ${repr(name)}`);
    if (cb !== null) visit(cb, builder);
    if (existing === null) return builder.create();
    return cb !== null ? builder.update() : builder.clone();
  }
}

/** A schema object's key in a store: its kind and its identity. */
function key(kind: string, identity: string): string {
  return `${kind}/${identity}`;
}

/** `store.moduleName.[...moduleName].schemaName`: a schema's name, one part per member; called, it builds. */
function makePath(store: Store, name: string): any {
  return new Proxy((...args: unknown[]) => store._build(name, args), {
    get: (_target, part) => {
      if (part === REPR) return () => `<${name}>`;
      if (typeof part === "symbol" || Proxies._probes.has(part)) return undefined;
      if (part.startsWith("_")) throw new AttributeError(part);
      return makePath(store, `${name}.${part}`);
    },
  });
}

// --- The namespaces, as `Schemas` gives them ---

export namespace OfScalar {
  export const Data = S.OfScalar.Data;
  export type Data = S.OfScalar.Data;
  export const Builder = ScalarBuilder;
  export type Builder = ScalarBuilder;
  export const Token = S.OfScalar.Token;
  export type Token = S.OfScalar.Token;
  export const Schema = Meta.Scalar;
}

export namespace OfObject {
  export const Data = S.OfObject.Data;
  export type Data = S.OfObject.Data;
  export const Builder = ObjectBuilder;
  export type Builder = ObjectBuilder;
  export const Schema = Meta.Object;
}

export namespace OfProperty {
  export const Data = S.OfProperty.Data;
  export type Data = S.OfProperty.Data;
  export const Builder = PropertyBuilder;
  export type Builder = PropertyBuilder;
  export const Schema = Meta.Property;
}

export namespace OfAdjacency {
  export const Data = S.OfAdjacency.Data;
  export type Data = S.OfAdjacency.Data;
  export const Builder = AdjacencyBuilder;
  export type Builder = AdjacencyBuilder;
  export const Schema = Meta.Adjacency;
}

export namespace OfRelation {
  export const Data = S.OfRelation.Data;
  export type Data = S.OfRelation.Data;
  export const Builder = RelationBuilder;
  export type Builder = RelationBuilder;
  export const Schema = Meta.Relation;
}

export namespace OfSymbol {
  export const Data = S.OfSymbol.Data;
  export type Data = S.OfSymbol.Data;
  export const Builder = SymbolBuilder;
  export type Builder = SymbolBuilder;
  export const Schema = Meta.Symbol;
}

export namespace OfParameter {
  export const Data = S.OfParameter.Data;
  export type Data = S.OfParameter.Data;
  export const Builder = ParameterBuilder;
  export type Builder = ParameterBuilder;
  export const Schema = Meta.Parameter;
}

export namespace OfUnion {
  export const Data = S.OfUnion.Data;
  export type Data = S.OfUnion.Data;
  export const Builder = UnionBuilder;
  export type Builder = UnionBuilder;
  export const Branch = S.OfUnion.Branch;
  export type Branch = S.OfUnion.Branch;
  export const Schema = Meta.Union;
}

export namespace OfIntersection {
  export const Data = S.OfIntersection.Data;
  export type Data = S.OfIntersection.Data;
  export const Builder = IntersectionBuilder;
  export type Builder = IntersectionBuilder;
  export const Part = S.OfIntersection.Part;
  export type Part = S.OfIntersection.Part;
  export const Schema = Meta.Intersection;
}

export namespace OfContainer {
  export const Data = S.OfContainer.Data;
  export type Data = S.OfContainer.Data;
  export const Builder = ContainerBuilder;
  export type Builder = ContainerBuilder;
  export const Schema = Meta.Container;
}

export namespace OfApply {
  export const Data = S.OfApply.Data;
  export type Data = S.OfApply.Data;
  export const Builder = ApplyBuilder;
  export type Builder = ApplyBuilder;
  export const Schema = Meta.Apply;
}

export namespace OfPredicate {
  export const Data = S.OfPredicate.Data;
  export type Data = S.OfPredicate.Data;
  export const Builder = PredicateBuilder;
  export type Builder = PredicateBuilder;
  export const Schema = Meta.Predicate;
}

export namespace OfAny {
  export const Data = S.OfAny.Value;
  export type Data = S.OfAny.Value;
  export const Builder = AnyValueBuilder;
  export type Builder = AnyValueBuilder;
  export const Schema = Meta.Any;
}

export namespace Form {
  export const Data = S.Form.Data;
  export type Data = S.Form.Data;
  export const Builder = FormBuilder;
  export type Builder = FormBuilder;
  export const Schema = Meta.Form;
}

// --- For Plain, which writes and reads schema objects through their builders ---

export { builderFor as _builder_for, identify as _identify, ArgumentData as _ArgumentData, ModuleData as _ModuleData };

/** The schema object a visitor reads: a link's referent, where a builder builds it, or a builder's own; null for any other visitor. */
export function _linked(visitor: unknown): unknown {
  const inner = innerOf(visitor);
  if (inner instanceof Builder) return inner._original; // a schema object read through its builder: one a proxy's entry links
  if (!(inner instanceof Link)) return null;
  const referent = inner._entry._referent;
  return [referent, null][Number(builderFor(referent) === null)];
}

/** Holds `form`, a form's clone, in its place in `store`: a form is immutable. */
export function _rehold_form(store: Store, held: unknown, form: unknown): void {
  const identity = identity_of(held) as string;
  store._objects.set(key(_kind(held), identity), identify(form, identity));
}

/** The term of a dialect a link visitor reads, which this package does not build and no store holds; null for any other
 * visitor. */
export function _dialect_term(visitor: unknown): unknown {
  const inner = innerOf(visitor);
  const referent = inner instanceof Link ? inner._entry._referent : null;
  const data = referent !== null && referent !== undefined && Proxies._store_of(referent) !== null; // a proxy answers any name
  return referent !== null && referent !== undefined && !data && builderFor(referent) === null && S.Form.is_term(referent)
    ? referent : null;
}

/** Whether an adjacency member holds one entry at most, as a `unique` clause of its relation makes it. */
export function _holds_one(member: unknown): boolean {
  const inner = innerOf(member);
  return inner instanceof AdjacencyMember && inner._members.one;
}

// `Schemas.OfX.Builder` and `Schemas.OfX.Schema` are these: a schema builder is a `Visitors.OfObject` over its meta-schema
// (FRAMEWORK.md, Resolved: "Schemas.OfX.Builder must implement Visitors.OfX").
for (const [namespace, own] of [[S.OfScalar, OfScalar], [S.OfObject, OfObject], [S.OfProperty, OfProperty],
  [S.OfAdjacency, OfAdjacency], [S.OfRelation, OfRelation], [S.OfSymbol, OfSymbol], [S.OfParameter, OfParameter],
  [S.OfUnion, OfUnion], [S.OfIntersection, OfIntersection], [S.OfContainer, OfContainer], [S.OfApply, OfApply],
  [S.OfPredicate, OfPredicate], [S.OfAny, OfAny], [S.Form, Form]] as const) {
  Object.assign(namespace, { Builder: own.Builder, Schema: own.Schema });
}

// The mutation schemas, which every store holds, built with the builders above.
Mutations._build({ AnyValueBuilder, ContainerBuilder, Meta, ObjectBuilder, UnionBuilder });
