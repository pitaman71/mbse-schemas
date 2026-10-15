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
        this._prop.container, this)));
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

/** `Visitors.OfAny` over a value held where `held` reads it and `write` writes it: a scalar, or a container. Its
 * schema is the type of what `provider` visits. */
class Value extends Shelled {
  readonly [TYPE_NAME] = "_Value";
  declare as_object: (cb: unknown) => any;
  declare as_union: (cb: unknown) => any;
  declare as_intersection: (cb: unknown) => any;

  constructor(readonly _label: string, readonly _held: () => unknown, readonly _write: (value: unknown) => void,
    readonly _writable: boolean, readonly _container: boolean, readonly _provider: { as_schema(): unknown }) {
    super();
  }

  as_schema(): unknown {
    return typeOf(this._provider.as_schema());
  }

  _other(cb: unknown): any {
    const reason = `${this._label} holds ${this._container ? "a container" : "a scalar"}`;
    if (!isFunction(cb)) throw new TypeError(reason);
    visit(cb, makeEmpty(reason));
    return this._proxy;
  }

  as_scalar(cb: unknown): any {
    if (this._container) return this._other(cb);
    if (isFunction(cb)) visit(cb, shell(new ScalarVisitor(this)));
    else this._write(cb);
    return this._proxy;
  }

  as_container(cb: unknown): any {
    if (!this._container) return this._other(cb);
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

  _positional(): boolean {
    return Array.isArray(this._value._held());
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
    // an element has no schema of its own: its provider is an empty visitor
    return shell(new Value(`${this._value._label}[${repr(index)}]`, () => this._items().get(index), write,
      this._value._writable, Array.isArray(held) || held instanceof Map, makeEmpty("")));
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
  items: (data: any) => any[];
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
 * to the schema object alone (keyed ones do), so that a clone of it has clones of them. */
class Members {
  name = "";
  readonly items: (data: any) => any[];
  readonly store: (data: any, members: any[]) => void;
  readonly accepts: (value: unknown) => boolean;
  readonly build: string | null;
  readonly one: boolean;
  readonly keyed: boolean;
  readonly owned: boolean;

  constructor(readonly link: string, options: Storage & { accepts: (value: unknown) => boolean; build?: string;
    keyed?: boolean; owned?: boolean }) {
    this.items = options.items;
    this.store = options.store;
    this.accepts = options.accepts;
    this.build = options.build ?? null;
    this.one = options.one ?? false;
    this.keyed = options.keyed ?? false;
    this.owned = options.owned ?? this.keyed;
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
    if (this._members.keyed && entry._name !== null) entry._referent.name = entry._name;
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
      if (this._members.keyed && name !== null) referent.name = name;
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
    return Object(this._referent).name || null;
  }

  _rename(name: unknown): void {
    if (name !== null && (typeof name !== "string" || name === "")) {
      throw new TypeError(`a name is non-empty text, got ${repr(name)}`);
    }
    this._name = name as string | null;
    if (this._index !== null) { // an entry held: its referent is renamed in place
      this._adjacency._builder._check();
      this._referent.name = [name].join(""); // null as ""
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
        this._entry._adjacency._builder._writable, false, this)));
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
function extend(base: Table, own: Record<string, Prop | Members>): Table {
  const table = new Map(base);
  for (const [name, member] of Object.entries(own)) {
    member._bind(name);
    table.set(name, member);
  }
  return table;
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
    for (const [name, value] of Object.entries(source)) {
      target[name] = value instanceof Map ? new Map(value) : Array.isArray(value) ? [...value] : value;
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
   * other means (an object schema's inherited ones) stay shared. */
  _cloneMembers(): void {
    for (const members of this._table().values()) {
      if (members instanceof Members && members.owned && members.build !== null) {
        const shared = this._shared(members);
        const builderClass = members._builderClass();
        members.store(this._working, members.items(this._working).map((referent) => shared.has(referent) ? referent
          : new builderClass(referent, true, this._store).clone()));
      }
    }
  }

  /** The referents of `members` a clone shares with the original rather than owns. */
  _shared(_members: Members): Set<unknown> {
    return new Set();
  }

  /** Writes the builder's state into the data given, and returns it. Only valid with data given. */
  update(...args: unknown[]): any {
    noArguments("update", args);
    if (this._original === null) throw new ValueError("update() is only valid with a source instance");
    this._update(this._original, this._working);
    return this._identified(this._finalize(this._original), this._identity ?? identity_of(this._original));
  }

  /** `data`, given `identity`, else one allocated: by its store, which refuses one another of its schema objects has,
   * where it is built in one. */
  _identified(data: any, identity: string | null): any {
    const chosen = identity ?? this._allocate();
    return this._store === null ? identify(data, chosen) : this._store._hold(data, chosen);
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
  static override _table = extend(Builder._table, {
    name: new Prop(),
    description: new Prop(),
    parameters: new Members("parameter", { keyed: true, accepts: isA(S.OfParameter.Data), build: "ParameterBuilder",
      ...byName("parameters") }),
  });

  /** A named schema's identity is its name, a global one; an unnamed one's, a UUID. */
  override _allocate(): string {
    return this._working.name || super._allocate();
  }
}

// --- Builders of members ---

/** A builder of a member with a type: a property, a parameter, a symbol, a branch or a part. Its name is the entry's
 * that links it to its owner. */
abstract class TypedBuilder extends Builder {
  static override _table = extend(Builder._table, { description: new Prop(), type: typed("type") });
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
  static override _table = extend(Builder._table, {
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
  static override _table = extend(Builder._table, {
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
  static override _table = extend(Builder._table, {
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
  static override _table = extend(KindBuilder._table, {
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
  static override _table = extend(KindBuilder._table, {
    ref: new Prop(),
    pattern: new Prop(),
    singleton: new Prop(),
    refines: refinesMembers(),
    properties: new Members("property", { keyed: true, accepts: isA(S.OfProperty.Data), build: "PropertyBuilder",
      ...byName("properties") }),
    adjacencies: new Members("adjacency", { // named ones by name, then anonymous ones, which have none
      keyed: true, accepts: isA(S.OfAdjacency.Data), build: "AdjacencyBuilder",
      items: (data) => [...data.adjacencies.values(), ...data.anonymous],
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

  /** The members the original inherits from the schema it refines: a clone inherits them too. */
  override _shared(members: Members): Set<unknown> {
    const [properties, adjacencies, anonymous] = inheritedOf(this._original);
    const held = this._working;
    if (members.name === "properties") {
      return new Set([...properties].filter((name) => held.properties.has(name)).map((name) => held.properties.get(name)));
    }
    return new Set([...[...adjacencies].filter((name) => held.adjacencies.has(name)).map((name) => held.adjacencies.get(name)),
      ...anonymous]);
  }
}

export class UnionBuilder extends KindBuilder {
  static override _data = S.OfUnion.Data;
  static override _meta = "Union";
  static override _noun = "a union";
  static override _table = extend(KindBuilder._table, {
    flat: new Prop(),
    branches: new Members("branch", { keyed: true, accepts: isA(S.OfUnion.Branch), build: "MemberBuilder",
      ...inOrder("branches") }),
  });
}

export class IntersectionBuilder extends KindBuilder {
  static override _data = S.OfIntersection.Data;
  static override _meta = "Intersection";
  static override _noun = "an intersection";
  static override _table = extend(KindBuilder._table, {
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
  static override _table = extend(KindBuilder._table, {
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
  static override _table = extend(KindBuilder._table, {
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
  static override _table = extend(KindBuilder._table, {
    types: new Members("schema", { accepts: isSchema, ...inOrder("types") }),
  });
}

export class PredicateBuilder extends KindBuilder {
  static override _data = S.OfPredicate.Data;
  static override _meta = "Predicate";
  static override _noun = "a predicate";
  static override _table = extend(KindBuilder._table, {
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
  static override _table = extend(KindBuilder._table, {
    links: new Members("link", { keyed: true, accepts: isA(S.OfSymbol.Data), build: "SymbolBuilder",
      items: (data) => [...data.entry.links.values()],
      store: (data, links) => {
        data.entry.links = new Map(links.map((m) => [m.name, m]));
      } }),
    properties: new Members("property", { keyed: true, accepts: isA(S.OfProperty.Data), build: "PropertyBuilder",
      items: (data) => [...data.entry.properties.values()],
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
  [S.Form.Data, FormBuilder],
]);

for (const builderClass of new Set(BUILDERS.values())) {
  Object.defineProperty(builderClass.prototype, TYPE_NAME, { value: builderClass.name });
}

/** The builder of a referent's data; null for a term of a dialect, which this package does not build. */
function builderFor(referent: unknown): BuilderClass | null {
  return BUILDERS.get(Object(referent).constructor) ?? null;
}

// --- The meta-schemas: schema objects, each a reference object, and the relations between them ---

type ObjectData = S.OfObject.Data;
type RelationData = S.OfRelation.Data;

/** The meta-schemas, by name: `Meta.Object` is `Schemas.Object`, and so on. */
export const Meta = {} as {
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

const Text = new S.OfScalar.Data(String);
const Bool = new S.OfScalar.Data(Boolean);
const Int = new S.OfScalar.Data(BigInt);

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
Meta.Relation = metaObject("Relation", [["uniques", new S.OfContainer.Data({ index: Int,
  element: new S.OfContainer.Data({ index: Int, element: Text }) })]], Meta.Schema);
Meta.Predicate = metaObject("Predicate", [], Meta.Schema);
Meta.Typed = metaObject("Typed", [["description", Text]], null);
Meta.Property = metaObject("Property", [], Meta.Typed);
Meta.Parameter = metaObject("Parameter", [], Meta.Typed);
Meta.Symbol = metaObject("Symbol", [], Meta.Typed);
Meta.Member = metaObject("Member", [], Meta.Typed);
Meta.Adjacency = metaObject("Adjacency", [["description", Text], ["me", Text]], null);
Meta.Argument = metaObject("Argument", [["value", S.Form.Value]], null);
Meta.Term = metaObject("Term", [], null);
Meta.Form = metaObject("Form", [["dialect", Text], ["kind", Text],
  ["attributes", new S.OfContainer.Data({ index: Text, element: S.Form.Value })]], Meta.Term);
Meta.Module = (
  new ObjectBuilder()
    .name("Schemas.Module")
    .ref(true)
    .pattern(String.raw`module-(\d+)`)
    .create()
);

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
const META_BUILDERS = new Map<string, BuilderClass>([
  ["Scalar", ScalarBuilder], ["Object", ObjectBuilder], ["Union", UnionBuilder], ["Intersection", IntersectionBuilder],
  ["Container", ContainerBuilder], ["Apply", ApplyBuilder], ["Any", AnyValueBuilder], ["Relation", RelationBuilder],
  ["Predicate", PredicateBuilder], ["Property", PropertyBuilder], ["Parameter", ParameterBuilder],
  ["Symbol", SymbolBuilder], ["Member", MemberBuilder], ["Adjacency", AdjacencyBuilder], ["Form", FormBuilder],
]);

/** A store of schema objects and data. No reference object is built outside a store, a schema object included.
 *
 * The canonical form of building is `store.moduleName.[...moduleName].schemaName(...)`, each part of a schema's name a
 * member: `store.Schemas.Object(...)` builds an object schema, `store.crm.Contact(...)` a contact. Called with a
 * `Specs.Callback[Visitors.OfX]`, it creates an object; with an object and a callback, it updates the object; with an
 * object alone, it clones it. It returns the object. A schema object built here, and each member built with it, is
 * given its identity by the store, which refuses one it holds another with; a named schema is registered under its
 * name, so that the store builds its objects next. The store is a `Proxy`: a name it lacks starts a schema's name,
 * except JavaScript's protocol probes (`then`, ...), and one starting with `_` throws `AttributeError`. */
export class Store extends Proxies.OfStore {
  /** The schema objects, by identity. */
  readonly _objects = new Map<string, unknown>();

  constructor() {
    super();
    for (const schema of Object.values(Meta) as (ObjectData | RelationData)[]) { // the meta-schemas, but Schemas.Module,
      if (!this._schemas.has(schema.name as string)) { // which every store has already
        this._objects.set(identity_of(schema) as string, schema);
        this.register(schema);
      }
    }
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === "symbol" || prop in target) return Reflect.get(target, prop, receiver);
        if (prop.startsWith("_")) throw new AttributeError(prop);
        if (Proxies._probes.has(prop)) return undefined;
        return makePath(receiver, prop);
      },
    });
  }

  /** Gives a schema object built here `identity`, refused where another holds it; registers a named schema. */
  _hold(data: any, identity: string): any {
    const held = this._objects.get(identity);
    if (held !== undefined && held !== data) {
      throw new ValueError(`a schema object with the identity ${repr(identity)} is already in this store`);
    }
    const previous = identity_of(data);
    if (previous !== null && this._objects.get(previous) === data) this._objects.delete(previous);
    this._objects.set(identity, identify(data, identity));
    if (isSchema(data) || data instanceof S.OfRelation.Data || data instanceof S.OfPredicate.Data) {
      for (const [name, schema] of [...this._schemas]) {
        if (schema === data && name !== data.name) this._schemas.delete(name); // renamed
      }
      if (data.name && this._schemas.get(data.name) !== data) this.register(data);
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
    const kind = name.startsWith("Schemas.") ? META_BUILDERS.get(name.slice("Schemas.".length)) : undefined;
    let builder: any;
    if (kind !== undefined) builder = new kind(existing, true, this);
    else if (this._schemas.has(name)) builder = this.builder(name, existing);
    else throw new AttributeError(`no schema registered as ${repr(name)}`);
    if (cb !== null) visit(cb, builder);
    if (existing === null) return builder.create();
    return cb !== null ? builder.update() : builder.clone();
  }
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
