/**
 * Builders: schema builders as visitors of their meta-schemas, which model schemas as reference objects and relations,
 * and the store they are built in. They replace the builders and meta-schemas in `Schemas`, which stay beside them
 * while call sites migrate (docs/META_SCHEMAS.md, Plan); `Schemas.OfX.Data` is unchanged.
 *
 * Every schema object is a reference object: a kind of schema, and each of its members (a property, an adjacency, a
 * parameter, a symbol, a branch or a part). A property of a schema object holds a value (a name, a flag); every
 * reference from one schema object to another is a relation: a schema to its members (`Schemas.HasProperty`, ...), a
 * member to its schema (`Schemas.HasSchema`), a refinement to what it refines (`Schemas.Refines`), and so on
 * (`plainSchemas`, below): each store builds its own (docs/proposals/store-overhaul, Levels).
 *
 * Each `Schemas.OfX.Builder` is a writable `Visitors.OfObject` over its plain schema (`Schemas.OfX`), as VISITOR_PATTERN.md
 * gives it: a member for each property (`osv.<propName>`, a `Visitors.OfProperty`) and for each adjacency
 * (`osv.<adjName>`, a `Visitors.OfAdjacency`, whose entries' links are members, `env.<linkName>`). Called with a
 * `Specs.Callback`, a member writes or visits through it and returns the builder. Its other methods are named `as_*`.
 * The builder adapts each member to however `Schemas.OfX.Data` stores it (a map by name, a field holding a schema);
 * the data implements no visitor.
 *
 * A builder works on a copy of the data it is given (`_working`), made by `_make` and filled by `_update`, and is
 * finalized by `create()` (no data given), `clone()` (new data) or `update()` (written back into the data given),
 * through `_finalize`; none validate.
 *
 * As proxies are, each builder and visitor is a `Proxy` (`Proxies._shell`): its own methods first, then its members by
 * name; members are typed loosely (`any` by name), as the proxy DSL's are.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { AttributeError, KeyError, LookupError, ReadOnlyError, ValueError } from "./Errors.js";
import * as Mutations from "./Mutations.js";
import * as Paths from "./Paths.js";
import * as PlainModule from "./Plain.js";
import * as Transactions from "./Transactions.js";
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

/** Each schema object's store, which gives its path (`Paths.of`): a form is frozen; its store is not one of its fields. */
const HELD_BY = new WeakMap<object, Store>();

/** The store holding a schema object; undefined where none does. */
export function _heldBy(data: unknown): Store | undefined {
  return HELD_BY.get(data as object);
}

/** Whether a schema object has a name of its own, which gives its path: a module or a named schema. Anything else has a
 * path only as a member of an object that has one (docs/OBJECT_IDENTITY.md, Decided, 81). */
export function _named(data: unknown): boolean {
  return _namable(data) && Boolean((data as { name?: string | null }).name);
}

/** Whether a value agrees with a template's: a reference object by identity, a value by value and host type. */
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

/** A property's schema: its plain schema property's `schema`; null where there is no plain schema property. */
function typeOf(schema: any): unknown {
  return schema == null ? null : schema.schema;
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

  /** A value given whole (a shorthand), whose host type must match the property's schema exactly: a scalar of its scalar's host type; for
   * a container, an iterable of its elements, or a map of names to them where it is arranged as a dict. It sets the
   * value, merging nothing; null clears it. */
  _matched(value: unknown): unknown {
    const held = (typeOf(this.as_schema()));
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
    const element = (held instanceof S.OfScalar.Data ? held : (held as S.OfContainer.Data).element) as any;
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
    if (isFunction(cb)) {
      const mapping = new Mapping(this);
      if (this._writable && this._held() == null) this._write(mapping._positional() ? [] : new Map()); // selecting the kind writes it, empty until written further
      visit(cb, shell(mapping));
    } else this._write(new Map((Proxies._mapping(cb) ?? cb) as Iterable<[unknown, unknown]>));
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
    const schema = this.as_schema();
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
      this._value._writable, container, () => Object(this.as_schema()).element));
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
  S.OfAny.Value];

function isSchema(value: unknown): boolean {
  return KINDS.some((kind) => value instanceof kind);
}

/** Refuses a link, from a schema object built in a store, to a schema object that store does not hold: a reference
 * object no store built is strictly forbidden, and one another store built is that store's (FRAMEWORK.md, Resolved). */
function checkHeld(builder: any, link: string, referent: unknown): void {
  const store = builder._store;
  if (store !== null && store !== undefined && builderFor(referent) !== null && !store.holds(referent)) {
    throw new TypeError(`link ${repr(link)} cannot link ${repr(referent)}: the store does not hold it; build it in the store, or `
      + "link one it holds (a basic scalar is the store's own: store.Schemas.OfInt, ...)");
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
 * of its relation makes it. `keyed`: the relation's entries have one property, `name`, a string, which names
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

  /** The objects its entries link at `link`. */
  referents(data: any): any[] {
    return this.items(data);
  }

  /** Whether an entry's link may link `value`. */
  links(value: unknown): boolean {
    return this.accepts(value);
  }
}

/** An adjacency whose entries the data holds as records (a union's branches, an intersection's parts): each entry
 * links, at `link`, a schema that exists, its schema, and carries the record's other `fields` as its properties, its
 * `name` and `description`; no object of its own stands between (docs/proposals/store-overhaul, Decided, 4). A record
 * is never written in place: an entry written gives its data a new one. */
class Records extends Members {
  constructor(link: string, readonly record: new () => any, readonly fields: readonly string[],
    options: Storage & { extensible?: boolean }) {
    super(link, { ...options, accepts: isA(record), keyed: true, owned: false });
  }

  override referents(data: any): any[] {
    return this.items(data).map((record) => record.schema);
  }

  override links(value: unknown): boolean {
    return isSchema(value);
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
    if (this._members instanceof Records) { // a record may lack its schema: validation reports it
      this._store([...this._held(), entry._referent]);
      return this._proxy;
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
    const items = Proxies._mapping(spec);
    if (items !== null) spec = this._keyed(items);
    if (typeof spec === "string" || spec instanceof Uint8Array || !Proxies._iterable(spec)) {
      throw new TypeError(`${repr(this._members.name)} takes an iterable of what it links, or of entries, a mapping, or a `
        + `callback taking the adjacency; got ${repr(spec)}`);
    }
    this._builder._check();
    for (let item of spec) {
      item = Proxies._deref(item);
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
      if (this._members instanceof Records) {
        checkHeld(this._builder, this._members.link, referent.schema);
        this._store([...this._held(), referent]);
        continue;
      }
      checkHeld(this._builder, this._members.link, referent);
      if (this._members.keyed && name !== null) this._members.rename(this._builder._working, referent, name);
      const held = this._held();
      if (held.some((other) => other === referent)) continue;
      this._store(this._members.one ? [referent] : [...held, referent]);
    }
    return this._builder._proxy;
  }

  /** A mapping, as the peer shorthand: each item an entry, its key the value of the relation's one property, its value
   * given to the entry (FRAMEWORK.md, Resolved, Mappings for keyed adjacencies). */
  _keyed(items: [unknown, unknown][]): unknown[] {
    const relation = this.as_schema().relation;
    if (relation.entry.links.size !== 2 || relation.entry.properties.size !== 1) {
      throw new TypeError(`${repr(this._members.name)} takes a mapping only where its relation has two links and one property`);
    }
    const key = [...relation.entry.properties.keys()][0] as string;
    const members = this._members;
    const builderClass: any = members.build !== null ? members._builderClass() : null;
    const plain: any = this._builder._store !== null ? this._builder._store._meta : TEMPLATE;
    const objectMeta = builderClass !== null ? plain[builderClass._meta] : null;
    return items.map(([name, value]) => (them: any) => {
      them[key](name);
      const given = Proxies._deref(value);
      const takers: [string, boolean, boolean][] = objectMeta === null || isFunction(given) ? [] : [...builderClass._table]
        .filter(([memberName]: [string, unknown]) => memberName !== key)
        .map(([memberName, member]: [string, any]): [string, boolean, boolean] => [memberName, member instanceof Members,
          member instanceof Members ? member.links(given)
            : objectMeta.properties.has(memberName) && Proxies._holds(objectMeta.properties.get(memberName).schema, given)]);
      Proxies._given(them, given, members.link, !isFunction(given) && members.accepts(given), takers);
    });
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
  /** The fields of a record written, and its link, as `link`. */
  readonly _fields = new Set<string>();

  constructor(readonly _adjacency: AdjacencyMember, readonly _index: number | null, public _referent: any) {
    super();
    const members = _adjacency._members;
    if (_referent === null && members instanceof Records) {
      this._referent = new members.record(); // a record of nothing yet, written in place until it is inserted
    }
  }

  _records(): Records | null {
    const members = this._adjacency._members;
    return members instanceof Records ? members : null;
  }

  /** The object its link links: a record's schema, or the referent. */
  _linked(): any {
    return this._records() !== null ? this._referent.schema : this._referent;
  }

  as_schema(): any {
    const schema = this._adjacency.as_schema();
    return schema === null ? null : schema.relation.entry;
  }

  override _member(name: string): unknown {
    const members = this._adjacency._members;
    if (name === members.link) return callable(new Link(this));
    const records = this._records();
    if ((name === "name" && members.keyed) || (records !== null && records.fields.includes(name))) {
      return callable(new EntryField(this, name));
    }
    return makeEmpty(`${repr(name)} is not a link this entry can set, nor a property of the relation`);
  }

  /** A property of the entry: its name, or a field of its record. */
  _field(name: string): unknown {
    return name === "name" ? this._named() : this._referent[name];
  }

  _write(name: string, value: unknown): void {
    if (this._records() === null) {
      this._rename(value);
      return;
    }
    if (value !== null && (typeof value !== "string" || (name === "name" && value === ""))) {
      throw new TypeError(name === "name" ? `a name is non-empty text, got ${repr(value)}`
        : `property ${repr(name)} holds str, got ${typeName(value)}`);
    }
    this._fields.add(name);
    this._replaceRecord({ [name]: name === "name" && value === null ? "" : value });
  }

  /** Gives a record's entry a new record, with `fields` written: in the adjacency's place, where it is held. */
  _replaceRecord(fields: Record<string, unknown>): void {
    if (this._index !== null) this._adjacency._builder._check();
    this._referent = Object.assign(Object.create(Object.getPrototypeOf(this._referent)), this._referent, fields);
    if (this._index !== null) this._adjacency._replace(this._index, this._referent);
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
    if (this._records() !== null) { // a record's link is its schema
      this._fields.add(this._adjacency._members.link);
      this._replaceRecord({ schema: referent });
      return;
    }
    this._referent = referent;
    this._template = template;
    if (this._index !== null) this._adjacency._replace(this._index, referent); // an entry held: linked in its place
  }

  _agrees(referent: any): boolean {
    if (this._records() !== null) { // each field written, and the schema linked, agree
      const link = this._adjacency._members.link;
      return [...this._fields].every((name) => name === link ? referent.schema === this._referent.schema
        : referent[name] === this._referent[name]);
    }
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

/** `Visitors.OfProperty` over a property of an entry: its name, the one property of a keyed adjacency's entries, or a
 * field of a record's (its description). */
class EntryField extends Dunders {
  readonly [TYPE_NAME] = "_EntryField";

  constructor(readonly _entry: Entry, readonly _name: string) {
    super();
  }

  _held(): unknown {
    return this._entry._field(this._name);
  }

  _scalar(): unknown {
    return this._held();
  }

  _label(): string {
    return `property ${repr(this._name)}`;
  }

  as_schema(): any {
    const entry = this._entry.as_schema();
    return entry === null ? null : entry.properties.get(this._name);
  }

  get(): unknown {
    return this._held();
  }

  as_value(cb: unknown): any {
    if (isFunction(cb)) {
      visit(cb, shell(new Value(this._label(), this._held.bind(this), (value: unknown) => this._entry._write(this._name, value),
        this._entry._adjacency._builder._writable, false, () => typeOf(this.as_schema()))));
    } else {
      this._entry._write(this._name, cb);
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
 * and the members of the object it links (`t.schema`), which are written through that object's builder: a new one, or,
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
    if (name === members.link || (name === "name" && members.keyed)
      || (members instanceof Records && members.fields.includes(name))) {
      return callable(new Chained(this._entry._proxy[name], this, name === members.link));
    }
    return callable(new Chained(this._builder()[name], this, false));
  }

  /** The object linked: the one given, built, or updated; and the entry's name. A record's entry gives its record. */
  _result(): [any, string | null] {
    const members = this._entry._adjacency._members;
    if (members instanceof Records) return [this._entry._referent, null]; // a record may lack its schema: validation reports it
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
    const referent = this._entry._linked();
    if (referent === null) return makeEmpty(`link ${repr(this._members().link)} is not set`);
    const builder = builderFor(referent);
    if (builder === null) return referent; // data, which an extension's relation links: a proxy, read-only as data instances are
    return new builder(referent, false, this._entry._adjacency._builder._store); // read in the store that links it
  }

  as_schema(): unknown {
    return this._target().as_schema();
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
    if (entry._records() !== null && Array.isArray(spec)) { // a reference: a list of what it links
      if (spec.length !== 1) throw new TypeError(`link ${repr(members.link)} links one schema, got ${spec.length}`);
      spec = spec[0];
    }
    if (isFunction(spec)) {
      if (members.build === null) {
        throw new TypeError(`link ${repr(members.link)} links an object that exists: give it, not a callback`);
      }
      const [result, written] = build(members._builderClass(), entry._referent, spec, entry._adjacency._builder._store);
      if (result !== null) entry._relink(result, written);
      return entry._proxy;
    }
    spec = Proxies._deref(spec);
    const referent = innerOf(spec) instanceof Link ? innerOf(spec)._entry._linked() : spec;
    if (!members.links(referent)) throw new TypeError(`link ${repr(members.link)} cannot link ${repr(referent)}`);
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

/** A property `store.extend` declares on a plain schema, held on each schema object apart from its fields: a scalar,
 * or a container where its schema is one. */
function extensionProperty(prop: S.OfProperty.Data): Prop {
  const name = prop.name;
  const member = new Prop({
    get: (data) => data._extended?.get(name) ?? null,
    put: (data, value) => {
      hidden(data, "_extended").set(name, value);
    },
    container: prop.schema instanceof S.OfContainer.Data,
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
  const added = (store as Store)._added.get(builderFor(data) as unknown as typeof Builder) as Table;
  for (const [name, referents] of pending) {
    const [relation, me, other] = (added.get(name) as Members).extension as [S.OfRelation.Data, string, string];
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

/** Gives each schema builder in `store` the members an extension added to its plain schema (or one it refines):
 * `before` holds each plain schema's names before the extension. */
function extendBuilders(store: Store, before: Map<unknown, [Set<string>, Set<string>]>): void {
  for (const builderClass of new Set(BUILDERS.values()) as unknown as Set<typeof Builder>) {
    const meta = (store._meta as unknown as Record<string, any>)[builderClass._meta];
    const [properties, adjacencies] = before.get(meta) as [Set<string>, Set<string>];
    if (!store._added.has(builderClass)) store._added.set(builderClass, new Map());
    const added = store._added.get(builderClass) as Table;
    const members: [string, Prop | Members][] = [];
    for (const [name, prop] of meta.properties) {
      if (!properties.has(name) && !builderClass._table.has(name)) members.push([name, extensionProperty(prop)]);
    }
    for (const [name, adjacency] of meta.adjacencies) {
      if (!adjacencies.has(name) && !builderClass._table.has(name)) members.push([name, extensionAdjacency(adjacency)]);
    }
    for (const [name, member] of members) {
      member._bind(name);
      added.set(name, member);
    }
  }
}

/** A writable `Visitors.OfObject` over a plain schema (`_meta`, its name in `Schemas`), building its data (`_data`).
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
  _working: any;
  _members!: Table;

  constructor(original: unknown = null, writable = true, store: Store | null = null) {
    super();
    original = Proxies._deref(original);
    const kind = this.constructor as typeof Builder;
    if (original !== null && !(original instanceof kind._data)) {
      throw new TypeError(`a builder of ${kind._noun} is given ${repr(original)}`);
    }
    this._original = original;
    this._writable = writable;
    this._store = store;
    const added = store?._added.get(kind);
    // the members its store's extensions added to its plain schema: the store's own
    this._members = added === undefined || added.size === 0 ? kind._table : new Map([...kind._table, ...added]);
    this._working = this._make();
    // within a transaction, what its writes so far make of it (Object identity, 96)
    if (original !== null) this._update(this._working, store === null ? original : store._pending(original));
    return shell(this);
  }

  /** Its members: its class's, and those its store's extensions added. */
  _table(): Table {
    return this._members;
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
    return this._detached(this._held(this._finalize(this._working)));
  }

  /** Returns new data, leaving the data given as it is. Only valid with data given. */
  clone(...args: unknown[]): any {
    noArguments("clone", args);
    if (this._original === null) throw new ValueError("clone() is only valid with a source instance");
    this._cloneMembers();
    return this._detached(this._held(this._finalize(this._working)));
  }

  /** `data`, finalized, which the builder no longer writes: it goes on working on a copy, so that finalizing it again
   * gives other data. */
  _detached(data: any): any {
    this._working = this._make();
    this._update(this._working, data);
    return data;
  }

  /** A member has one owner, and a schema object with no name of its own is linked by one object alone: a clone has its
   * own of each, cloned; those it shares by other means (an object schema's inherited members, which its members do not
   * list) stay shared, and so does what has a name of its own. */
  _cloneMembers(): void {
    const cloned = (referent: any): any => {
      const builderClass = builderFor(referent);
      if (builderClass === null || _named(referent) || (this._store !== null && this._store.framework(referent))) return referent;
      return new builderClass(referent, true, this._store).clone();
    };
    for (const members of this._table().values()) {
      if (!(members instanceof Members) || members.extension !== null) continue;
      if (members instanceof Records) {
        members.store(this._working, members.items(this._working).map((record) =>
          Object.assign(Object.create(Object.getPrototypeOf(record)), record, { schema: cloned(record.schema) })));
      } else {
        members.store(this._working, members.items(this._working).map(cloned));
      }
    }
  }

  /** Writes the builder's state into the data given, and returns it. Only valid with data given. */
  update(...args: unknown[]): any {
    noArguments("update", args);
    if (this._original === null) throw new ValueError("update() is only valid with a source instance");
    if (this._store !== null) {
      this._store._permit(this);
      // a schema object that existed before the transaction open: at its commit
      if (this._store._defers(this)) return this._original;
    }
    this._update(this._original, this._working);
    return this._held(this._finalize(this._original));
  }

  /** `data`, held by its store where it is built in one, which refuses it where it would share an object with no name of
   * its own. */
  _held(data: any): any {
    return settleExtended(this._store === null ? data : this._store._hold(data), this._store);
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

  /** Its plain schema (`Schemas.OfObject`, ...): its store's, or, outside a store, the template's. */
  as_schema(): any {
    const meta = this._store !== null ? this._store._meta : TEMPLATE;
    return (meta as unknown as Record<string, unknown>)?.[(this.constructor as typeof Builder)._meta] ?? null;
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

/** The adjacency to the schema of something's values, of any kind (`Schemas.HasSchema`): a schema that exists, such
 * as the store's `Schemas.OfInt`. */
function schemaOf(field: string): Members {
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
}

// --- Builders of members ---

/** A builder of a member with a schema: a property or a symbol. Its name is the entry's that links it to its owner. */
abstract class MemberBuilder extends Builder {
  static override _table = extendTable(Builder._table, { description: new Prop(), schema: schemaOf("schema") });
}

export class PropertyBuilder extends MemberBuilder {
  static override _data = S.OfProperty.Data;
  static override _meta = "OfProperty";
  static override _noun = "a property";
  static override _table = extendTable(MemberBuilder._table, {
    pattern: new Prop(), // a key's naming pattern (docs/OBJECT_IDENTITY.md, Decided, 13)
  });
}

/** A parameter: a name, by the entry that links it to its schema, a symbol standing for a schema. */
export class ParameterBuilder extends Builder {
  static override _data = S.OfParameter.Data;
  static override _meta = "OfParameter";
  static override _noun = "a parameter";
  static override _table = extendTable(Builder._table, { description: new Prop() });
}

export class SymbolBuilder extends MemberBuilder {
  static override _data = S.OfSymbol.Data;
  static override _meta = "OfSymbol";
  static override _noun = "a symbol";
}

export class VariableBuilder extends MemberBuilder {
  static override _data = S.OfVariable.Data;
  static override _meta = "OfVariable";
  static override _noun = "a variable";
}

/** An adjacency: named by the entry that links it to its object schema, or anonymous, with no name. It fills its
 * relation's link `me`, by name: within a schema, its relation's links and properties are named, not referred to. */
export class AdjacencyBuilder extends Builder {
  static override _data = S.OfAdjacency.Data;
  static override _meta = "OfAdjacency";
  static override _noun = "an adjacency";
  static override _table = extendTable(Builder._table, {
    description: new Prop(),
    me: new Prop(), // the name of the link it fills
    owner: new Prop(), // it points back to its object's owner (docs/OBJECT_IDENTITY.md, Decided, 14)
    relation: new Members("relation", { accepts: isA(S.OfRelation.Data), build: "RelationBuilder", ...one("relation") }),
  });
}

// --- Builders of kinds ---

function refinesMembers(): Members {
  return new Members("refined", { accepts: isSchema, ...one("refines") });
}

/** A basic scalar: a store is made holding the five, and builds no other (docs/proposals/store-overhaul, Decided,
 * 8 and 22). */
export class ScalarBuilder extends KindBuilder {
  static override _data = S.OfScalar.Data;
  static override _meta = "OfScalar";
  static override _noun = "a scalar schema";
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
  static override _meta = "OfObject";
  static override _noun = "an object schema";
  static override _table = extendTable(KindBuilder._table, {
    ref: new Prop(),
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
    const base = target.refines;
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
  static override _meta = "OfUnion";
  static override _noun = "a union";
  static override _table = extendTable(KindBuilder._table, {
    flat: new Prop(),
    branches: new Records("schema", S.OfUnion.Branch, ["name", "description"], { extensible: true, ...inOrder("branches") }),
  });
}

export class IntersectionBuilder extends KindBuilder {
  static override _data = S.OfIntersection.Data;
  static override _meta = "OfIntersection";
  static override _noun = "an intersection";
  static override _table = extendTable(KindBuilder._table, {
    flat: new Prop(),
    parts: new Records("schema", S.OfIntersection.Part, ["name", "description"], inOrder("parts")),
  });
}

/** A refinement takes the index and element of what it refines, unless it is given them. */
export class ContainerBuilder extends KindBuilder {
  static override _data = S.OfContainer.Data;
  static override _meta = "OfContainer";
  static override _noun = "a container schema";
  static override _table = extendTable(KindBuilder._table, {
    layout: new Prop(), // "dense", "sparse", or null
    refines: refinesMembers(),
    index: new Members("index", { accepts: isSchema, ...one("index") }),
    element: new Members("element", { accepts: isSchema, ...one("element") }),
  });

  override _finalize(target: any): any {
    const base = target.refines;
    if (base instanceof S.OfContainer.Data) {
      target.index = target.index === null ? base.index : target.index;
      target.element = target.element === null ? base.element : target.element;
    }
    return target;
  }
}

/** A value of any schema, or of one of `schemas`. */
export class AnyValueBuilder extends KindBuilder {
  static override _data = S.OfAny.Value;
  static override _meta = "OfAny";
  static override _noun = "a value of any schema";
  static override _table = extendTable(KindBuilder._table, {
    schemas: new Members("schema", { accepts: isSchema, ...inOrder("schemas") }),
  });
}

/** A pattern: its symbols, then its variables, by name, in declaration order, and its constraints, in order, which it
 * owns (docs/OBJECT_IDENTITY.md, Decided, 66). */
export class PatternBuilder extends KindBuilder {
  static override _data = S.OfPattern.Data;
  static override _meta = "OfPattern";
  static override _noun = "a pattern";
  static override _table = extendTable(KindBuilder._table, {
    symbols: new Members("symbol", { keyed: true, accepts: isA(S.OfSymbol.Data), build: "SymbolBuilder", ...byName("symbols") }),
    variables: new Members("variable", { keyed: true, accepts: isA(S.OfVariable.Data), build: "VariableBuilder",
      ...byName("variables") }),
    requires: new Members("constraint", { accepts: isA(S.OfExpression.Data), build: "ConstraintBuilder", owned: true,
      ...inOrder("requires") }),
  });

  /** What must hold of a frame (docs/OBJECT_IDENTITY.md, Decided, 76, 95): each callback given, in order, is handed the
   * frame, whose members are the symbols declared so far, each the visitor of the object it binds, which records what it
   * is given; its record, a `Mutations.OfPattern` as plain data, is added to the pattern's. */
  spec(specs: unknown): any {
    this._check();
    if (this._store === null) throw new TypeError("a spec is written in a store, whose schemas its symbols name");
    const items = isFunction(specs) ? [specs] : [...(specs as Iterable<unknown>)];
    const recorded = items.map((item) => Transactions._recorded(this._store, this._working.symbols, item));
    this._working.spec = [...this._working.spec, ...recorded];
    return this._proxy;
  }
}

/** An expression: the pattern it ranges over, and the schema of its result; its terms are mbse-expressions'. */
export class ExpressionBuilder extends KindBuilder {
  static override _data = S.OfExpression.Data;
  static override _meta = "OfExpression";
  static override _noun = "an expression";
  static override _table = extendTable(KindBuilder._table, {
    pattern: new Members("pattern", { accepts: isA(S.OfPattern.Data), build: "PatternBuilder", ...one("pattern") }),
    result: new Members("schema", { accepts: isSchema, ...one("result") }),
  });
}

/** An expression whose result is its store's `Schemas.OfBool`: a constraint. */
export class ConstraintBuilder extends ExpressionBuilder {
  static override _noun = "a constraint";

  override _make(): any {
    return new S.OfExpression.Data({ result: ((this._store !== null ? this._store._meta : TEMPLATE) as Plain).OfBool });
  }
}

/** A collector: its pattern, the names of the symbols and variables it collects, how its fold may be ordered, the
 * suffixes of their duplicates, and what it computes (docs/STREAMING_QUERIES.md). */
export class CollectorBuilder extends KindBuilder {
  static override _data = S.OfCollector.Data;
  static override _meta = "OfCollector";
  static override _noun = "a collector";
  static override _table = extendTable(KindBuilder._table, {
    pattern: new Members("pattern", { accepts: isA(S.OfPattern.Data), build: "PatternBuilder", ...one("pattern") }),
    symbols: new Prop({ container: true, get: (data) => data.symbols.length > 0 ? [...data.symbols] : null,
      put: (data, value) => {
        data.symbols = [...((value ?? []) as string[])];
      } }),
    variables: new Prop({ container: true, get: (data) => data.variables.length > 0 ? [...data.variables] : null,
      put: (data, value) => {
        data.variables = [...((value ?? []) as string[])];
      } }),
    commutative: new Prop(),
    associative: new Prop(),
    suffixes: new Prop({ container: true, get: (data) => data.suffixes === null ? null : new Map(data.suffixes),
      put: (data, value) => {
        data.suffixes = value === null ? null : new Map(value as Map<string, string>);
      } }),
    computes: new Members("expression", { accepts: isA(S.OfExpression.Data), build: "ExpressionBuilder", ...one("computes") }),
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
  static override _meta = "OfRelation";
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

/** A module, a reference object in the store, whose path is its name's: the root module's is `.` alone. */
export class ModuleBuilder extends KindBuilder {
  static override _data = ModuleData;
  static override _meta = "OfModule";
  static override _noun = "a module";
  static override _table = extendTable(KindBuilder._table, {
    schemas: new Members("schema", { keyed: true, owned: false, names: [definedName, define], extensible: true,
      accepts: (v) => _namable(v),
      items: (data) => [...data.schemas.values()], store: storeDefined }),
  });
}

const BUILDER_CLASSES = new Map<string, BuilderClass>([
  ["PropertyBuilder", PropertyBuilder], ["ParameterBuilder", ParameterBuilder], ["SymbolBuilder", SymbolBuilder],
  ["AdjacencyBuilder", AdjacencyBuilder], ["RelationBuilder", RelationBuilder], ["VariableBuilder", VariableBuilder],
  ["PatternBuilder", PatternBuilder], ["ExpressionBuilder", ExpressionBuilder], ["ConstraintBuilder", ConstraintBuilder],
]);

const BUILDERS = new Map<unknown, BuilderClass>([
  [S.OfScalar.Data, ScalarBuilder], [S.OfObject.Data, ObjectBuilder], [S.OfUnion.Data, UnionBuilder],
  [S.OfIntersection.Data, IntersectionBuilder], [S.OfContainer.Data, ContainerBuilder], [S.OfAny.Value, AnyValueBuilder],
  [S.OfRelation.Data, RelationBuilder], [S.OfProperty.Data, PropertyBuilder],
  [S.OfParameter.Data, ParameterBuilder], [S.OfSymbol.Data, SymbolBuilder],
  [S.OfAdjacency.Data, AdjacencyBuilder], [ModuleData, ModuleBuilder], [S.OfVariable.Data, VariableBuilder],
  [S.OfPattern.Data, PatternBuilder], [S.OfExpression.Data, ExpressionBuilder], [S.OfCollector.Data, CollectorBuilder],
]);

for (const builderClass of new Set(BUILDERS.values())) {
  Object.defineProperty(builderClass.prototype, TYPE_NAME, { value: builderClass.name });
}

/** The builder of a schema object's data; null for anything else (data, which proxies are). */
function builderFor(referent: unknown): BuilderClass | null {
  return BUILDERS.get(Object(referent).constructor) ?? null;
}

/** Whether a schema object has a name of its own (a kind of schema a module defines, or a module), rather than the one
 * its owner's entry gives it. */
export function _namable(data: unknown): boolean {
  return S._defined(data) || data instanceof ModuleData;
}

// --- The meta-schemas: schema objects, each a reference object, and the relations between them ---

type ObjectData = S.OfObject.Data;
type RelationData = S.OfRelation.Data;

/** A store's plain schemas of schemas (level 2) and its basic scalars, each its own (docs/proposals/store-overhaul,
 * Levels): `OfObject` is `Schemas.OfObject`, `OfInt` is `Schemas.OfInt`, `HasSchema` the relation `Schemas.HasSchema`. */
export interface Plain {
  OfBool: S.OfScalar.Data; OfInt: S.OfScalar.Data; OfFloat: S.OfScalar.Data; OfStr: S.OfScalar.Data;
  OfBytes: S.OfScalar.Data;
  OfScalar: ObjectData; OfObject: ObjectData; OfUnion: ObjectData; OfIntersection: ObjectData; OfContainer: ObjectData;
  OfAny: ObjectData; OfRelation: ObjectData; OfPattern: ObjectData; OfExpression: ObjectData; OfCollector: ObjectData;
  OfModule: ObjectData; OfProperty: ObjectData; OfParameter: ObjectData; OfSymbol: ObjectData; OfVariable: ObjectData;
  OfAdjacency: ObjectData;
  HasSchema: RelationData; Refines: RelationData; Indexing: RelationData; Containing: RelationData; AnyOf: RelationData;
  Relating: RelationData; HasParameter: RelationData; HasProperty: RelationData; HasAdjacency: RelationData;
  HasBranch: RelationData; HasPart: RelationData; HasSymbol: RelationData; HasLink: RelationData; Defines: RelationData;
  HasVariable: RelationData; Requiring: RelationData; Matching: RelationData; Resulting: RelationData;
  Computing: RelationData;
}

/** Builds a store's plain schemas of schemas and its basic scalars, anew. */
function plainSchemas(): Plain {
  const meta = {} as Plain;
  // The basic scalars, the only scalar schemas, each mapping to its host type by its name (FRAMEWORK.md, Resolved:
  // "Schemas.OfBool, Schemas.OfInt, ... no need to invent an alternate convention"; docs/proposals/store-overhaul,
  // Decided, 8 and 22).
  meta.OfBool = new ScalarBuilder().name("Schemas.OfBool").create();
  meta.OfInt = new ScalarBuilder().name("Schemas.OfInt").create();
  meta.OfFloat = new ScalarBuilder().name("Schemas.OfFloat").create();
  meta.OfStr = new ScalarBuilder().name("Schemas.OfStr").create();
  meta.OfBytes = new ScalarBuilder().name("Schemas.OfBytes").create();
  const [Text, Bool, Int] = [meta.OfStr, meta.OfBool, meta.OfInt];

  /** A plain schema of schemas: a reference object schema, `Schemas.<name>`, with `properties` of their schemas, by
   * name. */
  function metaObject(name: string, properties: [string, unknown][]): ObjectData {
    return new ObjectBuilder()
      .name(`Schemas.${name}`)
      .ref(true)
      .properties(properties.map(([n, s]) => (t: any) => t.name(n).schema([s])))
      .create();
  }

  const named: [string, unknown][] = [["name", Text], ["description", Text]]; // every kind of schema's: no base declares it
  meta.OfScalar = metaObject("OfScalar", named);
  meta.OfObject = metaObject("OfObject", [...named, ["ref", Bool], ["singleton", Text]]);
  meta.OfUnion = metaObject("OfUnion", [...named, ["flat", Bool]]);
  meta.OfIntersection = metaObject("OfIntersection", [...named, ["flat", Bool]]);
  meta.OfContainer = metaObject("OfContainer", [...named, ["layout", Text]]);
  meta.OfAny = metaObject("OfAny", named);
  meta.OfRelation = metaObject("OfRelation", [...named, ["uniques", new ContainerBuilder().index([Int]).element([
    new ContainerBuilder().index([Int]).element([Text]).create()]).create()]]);
  meta.OfPattern = metaObject("OfPattern", named);
  meta.OfExpression = metaObject("OfExpression", named);
  const names = new ContainerBuilder().index([Int]).element([Text]).create();
  meta.OfCollector = metaObject("OfCollector", [...named, ["symbols", names], ["variables", names], ["commutative", Bool],
    ["associative", Bool], ["suffixes", new ContainerBuilder().index([Text]).element([Text]).create()]]);
  meta.OfModule = metaObject("OfModule", named); // its identity is its path; it defines schemas and modules
  meta.OfProperty = metaObject("OfProperty", [["description", Text], ["pattern", Text]]);
  meta.OfParameter = metaObject("OfParameter", [["description", Text]]); // a name, by its entry: a symbol for a schema
  meta.OfSymbol = metaObject("OfSymbol", [["description", Text]]);
  meta.OfVariable = metaObject("OfVariable", [["description", Text]]);
  meta.OfAdjacency = metaObject("OfAdjacency", [["description", Text], ["me", Text], ["owner", Bool]]);
  const valued = [meta.OfScalar, meta.OfObject, meta.OfUnion, meta.OfIntersection, meta.OfContainer, meta.OfAny]; // of values
  const schemas = [...valued, meta.OfRelation, meta.OfPattern, meta.OfExpression, meta.OfCollector, meta.OfModule]; // a module's
  const members = [meta.OfProperty, meta.OfSymbol, meta.OfVariable]; // each with a schema

  /** A meta-schema relation, `Schemas.<name>`, with `links`, its first and second, constrained as `how` says (see
   * `RELATIONS`): a keyed relation's entries have `name`; the member determines its owner and its name
   * (`unique(owner, name)`), and the owner and the name determine the member (`unique(member)`). A named relation's
   * entries have `name` and `description`, and link a schema that may be linked again: the owner and the name determine
   * the entry. */
  function metaRelation(name: string, links: [string, string], how: string): RelationData {
    const [first, second] = links;
    const builder = new RelationBuilder().name(`Schemas.${name}`).links(links.map((n) => (t: any) => t.name(n)));
    if (how === "keyed" || how === "named") builder.properties([(t: any) => t.name("name").schema([Text])]);
    if (how === "named") builder.properties([(t: any) => t.name("description").schema([Text])]);
    const determined = new Map<string, string[][] | null>([["one", [[second]]], ["owned", [[first]]],
      ["keyed", [[first, "name"], [second]]], ["named", [[first, "name"]]], ["list", null]]).get(how);
    return builder.uniques(determined).create();
  }

  /** An adjacency to `relation` filling `link`: named by the entry that links it to its object schema, or anonymous;
   * `owner` where it points back to its object's owner (docs/OBJECT_IDENTITY.md, Decided, 14). */
  function metaAdjacency(relation: RelationData, link: string, owner = false): S.OfAdjacency.Data {
    const builder = new AdjacencyBuilder().relation([relation]).me(link);
    return (owner ? builder.owner(true) : builder).create();
  }

  /** Each relation between schema objects: (relation, (link, the kinds at that end, adjacency named there), (link, the
   * kinds at that end), "one": the first determines the second; "owned": the second determines the first; "keyed":
   * owned, and named within its owner by the entry's `name`; "named": the entry's `name` and `description` are a member
   * of the first, which links its schema, the second; "list": neither). An adjacency named "" is declared below,
   * on the kinds that have it. Each kind declares the adjacencies of every relation it is at an end of (Store overhaul,
   * Decided, 10). A member belongs to one owner (`Has*`: the member determines its owner); a schema object has at most
   * one schema, refined schema, index, element or relation (the first determines the second); `OfAny`'s schemas are a
   * list. */
  const RELATIONS: [keyof Plain, [string, ObjectData[], string], [string, ObjectData[]], string][] = [
    ["HasSchema", ["member", members, "schema"], ["schema", valued], "one"],
    ["Refines", ["refinement", [], ""], ["refined", valued], "one"],
    ["Indexing", ["container", [meta.OfContainer], "index"], ["index", valued], "one"],
    ["Containing", ["container", [meta.OfContainer], "element"], ["element", valued], "one"],
    ["AnyOf", ["any", [meta.OfAny], "schemas"], ["schema", valued], "list"],
    ["Relating", ["adjacency", [meta.OfAdjacency], "relation"], ["relation", [meta.OfRelation]], "one"],
    ["HasParameter", ["owner", schemas, "parameters"], ["parameter", [meta.OfParameter]], "keyed"],
    ["HasProperty", ["owner", [], ""], ["property", [meta.OfProperty]], "keyed"],
    ["HasAdjacency", ["owner", [meta.OfObject], "adjacencies"], ["adjacency", [meta.OfAdjacency]], "keyed"],
    ["HasBranch", ["owner", [meta.OfUnion], "branches"], ["schema", valued], "named"],
    ["HasPart", ["owner", [meta.OfIntersection], "parts"], ["schema", valued], "named"],
    ["HasSymbol", ["owner", [meta.OfPattern], "symbols"], ["symbol", [meta.OfSymbol]], "keyed"],
    ["HasVariable", ["owner", [meta.OfPattern], "variables"], ["variable", [meta.OfVariable]], "keyed"],
    ["Requiring", ["pattern", [meta.OfPattern], "requires"], ["constraint", [meta.OfExpression]], "list"],
    ["Matching", ["expression", [meta.OfExpression, meta.OfCollector], "pattern"], ["pattern", [meta.OfPattern]], "one"],
    ["Resulting", ["expression", [meta.OfExpression], "result"], ["schema", valued], "one"],
    ["Computing", ["collector", [meta.OfCollector], "computes"], ["expression", [meta.OfExpression]], "one"],
    ["HasLink", ["owner", [meta.OfRelation], "links"], ["link", [meta.OfSymbol]], "keyed"],
    ["Defines", ["module", [meta.OfModule], "schemas"], ["schema", schemas], "keyed"],
  ];

  /** The adjacencies each meta-schema declares: named ones by name, and anonymous ones. */
  const NAMED = new Map<ObjectData, [Map<string, S.OfAdjacency.Data>, S.OfAdjacency.Data[]]>();

  function declare(schema: ObjectData, adjacency: S.OfAdjacency.Data, name: string | null): void {
    if (!NAMED.has(schema)) NAMED.set(schema, [new Map(), []]);
    const [named, anonymous] = NAMED.get(schema) as [Map<string, S.OfAdjacency.Data>, S.OfAdjacency.Data[]];
    if (name === null) anonymous.push(adjacency);
    else named.set(name, adjacency);
  }

  for (const [name, [a, aKinds, namedAt], [b, bKinds], how] of RELATIONS) {
    const relation = metaRelation(name, [a, b], how);
    (meta as unknown as Record<string, unknown>)[name] = relation;
    for (const kind of namedAt !== "" ? aKinds : []) declare(kind, metaAdjacency(relation, a), namedAt);
    // a keyed relation's member is owned by its owner, through the entry that names it
    for (const kind of bKinds) declare(kind, metaAdjacency(relation, b, how === "keyed"), null);
  }
  for (const owner of [meta.OfObject, meta.OfRelation]) { // each has its own `properties`; any schema may be the owner
    declare(owner, metaAdjacency(meta.HasProperty, "owner"), "properties");
  }
  for (const refining of [meta.OfObject, meta.OfContainer]) { // only these refine
    declare(refining, metaAdjacency(meta.Refines, "refinement"), "refines");
  }
  for (const [schema, [named, anonymous]] of NAMED) {
    (
      new ObjectBuilder(schema)
        .adjacencies([...named].map(([n, a]) => (t: any) => t.name(n).adjacency(a)))
        .adjacencies(anonymous)
        .update()
    );
  }
  return meta;
}

/** The plain schemas a builder outside any store reads its own from (`as_schema`), which no store holds. */
let TEMPLATE: Plain | null = null;
TEMPLATE = plainSchemas();

// --- A store: where schema objects and data are built ---

/** The schema objects a store builds as `store.Schemas.OfX(...)`, each through its builder. */
export const _META_BUILDERS = new Map<string, BuilderClass>([
  ["OfScalar", ScalarBuilder], ["OfObject", ObjectBuilder], ["OfUnion", UnionBuilder], ["OfIntersection", IntersectionBuilder],
  ["OfContainer", ContainerBuilder], ["OfAny", AnyValueBuilder], ["OfRelation", RelationBuilder],
  ["OfProperty", PropertyBuilder], ["OfParameter", ParameterBuilder], ["OfSymbol", SymbolBuilder],
  ["OfAdjacency", AdjacencyBuilder], ["OfModule", ModuleBuilder], ["OfVariable", VariableBuilder],
  ["OfPattern", PatternBuilder], ["OfExpression", ExpressionBuilder], ["OfConstraint", ConstraintBuilder],
  ["OfCollector", CollectorBuilder],
]);

/** A schema object in a message: its name, else its kind. */
function shown(schema: any): string {
  return schema.name ? repr(schema.name) : (builderFor(schema) as unknown as typeof Builder)._noun;
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

/** A store of schema objects and data. No reference object is built outside a store, a schema object included.
 *
 * The canonical form of building is `store.moduleName.[...moduleName].schemaName(...)`, each part of a schema's name a
 * member: `store.Schemas.OfObject(...)` builds an object schema, `store.crm.Contact(...)` a contact. Called with a
 * `Specs.Callback[Visitors.OfX]`, it creates an object; with an object and a callback, it updates the object; with an
 * object alone, it clones it. It returns the object. A schema object built here, and each member built with it, is
 * held by the store: a named schema is registered under its name, so that the store builds its objects next, and is
 * found by its path, as each member of it is (docs/OBJECT_IDENTITY.md, Decided, 80 and 81); a schema object with no
 * name of its own has no path, and is linked by one object alone. The store is a `Proxy`: a name it lacks starts a schema's name,
 * except JavaScript's protocol probes (`then`, ...), and one starting with `_` throws `AttributeError`.
 *
 * A store is made holding its own plain schemas of schemas (`Schemas.OfObject`, ...), basic scalars (`Schemas.OfInt`,
 * ...) and mutation schemas, which no other store shares (docs/SCHEMA_EXTENSION.md, Decided, 23); it changes them, as
 * any schema it holds before an extension begins, only through `extend`, which only adds members. */
export class Store extends Proxies._Store {
  /** `store.moduleName.[...moduleName].schemaName(...)`, each a path (`_Path`); dynamic by design. */
  [name: string]: any;
  /** The schema objects it holds. */
  readonly _objects = new Set<unknown>();
  /** Those with no name of their own, held while what links them is (docs/OBJECT_IDENTITY.md, Decided, 94): a term's
   * pattern goes with its transaction. */
  readonly _unnamed = new WeakSet<object>();
  /** What links each object with no name of its own, and how. */
  readonly _linkers = new WeakMap<object, [any, Members]>();
  /** Its plain schemas of schemas and basic scalars, its own. */
  readonly _meta: Plain;
  /** The schemas it was made holding. */
  readonly _framework: Set<unknown>;
  /** The members its extensions added to builders, by builder class. */
  readonly _added = new Map<unknown, Table>();
  /** How many schema objects were held when an extension began, while it runs: those are its to check. */
  _extending: number | null = null;
  /** When each schema object was first held, in order: those held when an extension began are its to extend only. */
  readonly _heldAt = new WeakMap<object, number>();
  _held = 0;
  /** The modules, by path; the root module's is "". */
  readonly _modules = new Map<string, ModuleData>();
  /** Each schema's module, and its name there. */
  readonly _placed = new Map<unknown, [ModuleData, string]>();
  readonly _root: ModuleData;

  constructor() {
    super();
    this._meta = plainSchemas(); // its plain schemas of schemas and basic scalars, its own
    const paths = Paths.schemas({ AnyValueBuilder, ContainerBuilder, ObjectBuilder, UnionBuilder, Text: this._meta.OfStr,
      Int: this._meta.OfInt, Bool: this._meta.OfBool });
    const mutations = Mutations.schemas({ AdjacencyBuilder, AnyValueBuilder, ContainerBuilder, ObjectBuilder, RelationBuilder,
      UnionBuilder, Text: this._meta.OfStr, Int: this._meta.OfInt, Path: paths.OfRoot as S.OfObject.Data,
      Bool: this._meta.OfBool, Pattern: this._meta.OfPattern, Collector: this._meta.OfCollector,
      Expression: this._meta.OfExpression });
    const framework = [...Object.values(this._meta), ...Object.values(mutations), ...Object.values(paths)] as (ObjectData | RelationData)[];
    for (const schema of framework) this._register(schema);
    const reached: unknown[] = [...framework];
    while (reached.length > 0) { // each with what it holds: framework schemas share their unnamed ones, never written
      const schema = reached.pop();
      if (this._objects.has(schema)) continue;
      this._objects.add(schema);
      this._heldAt.set(schema as object, this._held++);
      for (const [referent, members] of this._referents(schema)) {
        if (!this._linkers.has(referent as object)) this._linkers.set(referent as object, [schema, members]);
        reached.push(referent);
      }
    }
    this._framework = new Set(this._objects);
    const proxy = new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === "symbol" || prop in target) return Reflect.get(target, prop, receiver);
        if (prop.startsWith("_")) throw new AttributeError(prop);
        if (Proxies._probes.has(prop)) return undefined;
        return makePath(receiver, prop);
      },
    });
    for (const schema of this._objects) HELD_BY.set(schema as object, proxy); // the store, as it is reached
    this._root = this._expression(() => new ModuleBuilder(null, true, proxy).create()); // made with the store
    return proxy;
  }

  /** The schema object whose path is `path`, a `Paths.OfRoot` value (`Paths.of`) or its plain form; null where the store
   * holds none (docs/OBJECT_IDENTITY.md, Decided, 81). */
  held(path: any): any {
    const plain = typeof path?.as_schema === "function" ? PlainModule.ToPlain(null as any)(path.as_schema(), path) : path;
    let steps: [string, string][];
    try {
      steps = PlainModule._schemaSteps(plain, []);
    } catch { // _schemaSteps throws only DecodeError: not a schema object's path
      return null;
    }
    return this._at(steps);
  }

  /** The schema object at `steps` from the root module: through modules and then a schema, by name, then through the
   * keyed adjacencies that own its members. */
  _at(steps: [string, string][]): any {
    let named = 0;
    while (named < steps.length && steps[named]![0] === "schemas") named += 1;
    const dotted = steps.slice(0, named).map(([, name]) => name).join(".");
    let current: any = this._modules.get(dotted) ?? this._schemas.get(dotted) ?? null;
    for (const [i, name] of steps.slice(named)) {
      const builderClass = builderFor(current) as unknown as typeof Builder | null;
      const members = builderClass?._table.get(i);
      if (!(members instanceof Members) || !(members.keyed && members.owned)) return null;
      current = members.referents(current).find((referent) => members.name_of(current, referent) === name) ?? null;
    }
    return current;
  }

  /** The steps of a schema object's path from the root module, each the adjacency it goes through and the entry's name:
   * a module's and a named schema's, its name's parts, through each module that defines the next; a member's, its
   * owner's, then the adjacency that owns it and its name there. Null where it has none: an object with no name of its
   * own, and what such an object holds (Decided, 80 and 81). */
  _path(data: any): [string, string][] | null {
    if (data instanceof ModuleData && !data.name) return [];
    if (_named(data)) {
      const placed = this._modules.get(data.name) === data || this._schemas.get(data.name) === data;
      return placed && S._DOTTED.test(data.name) ? data.name.split(".").map((part: string) => ["schemas", part]) : null;
    }
    const linker = this._linker(data);
    if (linker === null || !(linker[1].keyed && linker[1].owned)) return null;
    const [owner, members] = linker;
    const name = members.name_of(owner, data);
    const steps = this._path(owner);
    return steps === null || !name ? null : [...steps, [members.name, name]];
  }

  /** Each schema object `data` links through an adjacency of its kind's own, with that adjacency's member. */
  *_referents(data: unknown): Generator<[unknown, Members]> {
    for (const members of (builderFor(data) as unknown as typeof Builder)._table.values()) {
      if (!(members instanceof Members)) continue;
      for (const referent of members.referents(data)) {
        if (builderFor(referent) !== null) yield [referent, members];
      }
    }
  }

  /** What links an object with no name of its own, and through which adjacency, while it links it still. */
  _linker(data: unknown): [any, Members] | null {
    const found = this._linkers.get(data as object);
    if (found === undefined || !found[1].referents(found[0]).includes(data)) return null;
    return found;
  }

  /** Records what links each object with no name of its own that `data` links (or will, its builder's working copy
   * `source`), refused where another links it already: it is written nested in the one object that links it (Decided,
   * 81). */
  _link(data: unknown, source: unknown = null): void {
    for (const [referent, members] of this._referents(source ?? data)) {
      if (_named(referent) || this.framework(referent)) continue;
      const linker = this._linker(referent);
      if (linker !== null && linker[0] !== data) {
        throw new ValueError(`${(builderFor(referent) as unknown as typeof Builder)._noun} with no name of its own is linked `
          + "by one schema object alone, and another links it already: name it to share it");
      }
      this._linkers.set(referent as object, [data, members]);
    }
  }

  /** Executes a transaction (docs/OBJECT_IDENTITY.md, Decided, 85 to 97): a `Mutations.OfTransaction`, or a callback
   * building one, its root term given through `mutations`. Every write it makes is held apart until it ends, and dropped
   * where it throws. Gives the frames its chain of terms ends with, each the objects its symbols bind, by symbol. Given a
   * function of no arguments, a transaction's imperative scope (98), `store.transaction(() => { ... })`, within which
   * builders write as they do anywhere, all or nothing; it gives what the function returns. */
  transaction(spec: unknown): any {
    if (Proxies._isFunction(spec) && spec.length === 0) return this._transacting(spec as () => unknown); // its scope (98)
    const transaction = Proxies._isFunction(spec) ? this.Mutations.OfTransaction(spec) : spec;
    return Transactions._execute(this, transaction);
  }

  /** Whether a builder's update of a schema object waits for the commit of the transaction open: where the object existed
   * before it began (docs/OBJECT_IDENTITY.md, Decided, 96). What it would link is checked now. */
  _defers(builder: Builder): boolean {
    const overlay = this._overlay;
    if (overlay === null || !this._existed(builder._original, overlay)) return false;
    this._link(builder._original, builder._working);
    overlay.deferred.set(builder._original, builder); // its last: each began from what the one before made
    return true;
  }

  /** Whether the store held the schema object `data` when the transaction `overlay` began. */
  _existed(data: unknown, overlay: Proxies._Overlay): boolean {
    return this.holds(data) && (this._heldAt.get(data as object) as number) < overlay.existing;
  }

  /** A schema object as the transaction open has made it: the working copy of its last deferred update, else itself. */
  _pending(original: unknown): unknown {
    const overlay = this._overlay;
    const builder = overlay === null ? undefined : overlay.deferred.get(original as object);
    return builder === undefined ? original : builder._working;
  }

  /** The schema objects held when a transaction begins: those its updates of wait for its commit, numbered below. */
  _existing(): number {
    return this._held;
  }

  /** The changes a transaction made to which objects have no name of their own: undone where it throws. */
  _unnamedLog: [object, boolean][] | null = null;

  override _saved(): Map<Map<unknown, unknown>, [unknown, unknown][]> {
    const saved = super._saved();
    for (const held of [this._modules, this._placed]) saved.set(held as Map<unknown, unknown>, [...held]);
    saved.set(this._objects as unknown as Map<unknown, unknown>, [...this._objects].map((data) => [data, data]));
    this._unnamedLog = [];
    return saved;
  }

  override _restore(saved: Map<Map<unknown, unknown>, [unknown, unknown][]>): void {
    const objects = saved.get(this._objects as unknown as Map<unknown, unknown>) as [unknown, unknown][];
    saved.delete(this._objects as unknown as Map<unknown, unknown>);
    super._restore(saved);
    this._objects.clear();
    for (const [data] of objects) this._objects.add(data);
    for (const [data, unnamed] of (this._unnamedLog as [object, boolean][]).reverse()) {
      if (unnamed) this._unnamed.add(data);
      else this._unnamed.delete(data);
    }
    this._unnamedLog = null;
  }

  /** Applies the updates of schema objects that waited for the transaction's commit, in order; where one is refused,
   * those applied before it are undone. */
  override _commit_schemas(overlay: Proxies._Overlay): void {
    const applied: [any, [string, unknown][]][] = [];
    try {
      for (const builder of overlay.deferred.values()) {
        const original = builder._original;
        applied.push([original, Object.keys(original).map((name) => [name, original[name]])]);
        builder.update();
      }
      this._unnamedLog = null;
    } catch (error) {
      for (const [original, fields] of applied.reverse()) {
        for (const [name, value] of fields) original[name] = value;
      }
      throw error;
    }
  }

  /** Whether the store holds the schema object `data`. */
  holds(data: unknown): boolean {
    return this._objects.has(data) || this._unnamed.has(data as object);
  }

  /** The store's owned objects by their paths (docs/OBJECT_IDENTITY.md, Decided, 26): `store.Instances.<a
   * singleton's global name>` is the singleton, whose adjacencies called with keys continue the path. */
  get Instances(): any {
    return makeInstances(this, "");
  }

  /** The module whose path is `path` (`crm.sales`), made with the modules it is in where there is none; the root module
   * for "". Every schema is in one: a named schema in the module its name's prefix names, the root module's where it
   * has none. */
  module(path = ""): any {
    return this._modules.get(path) ?? new ModuleBuilder(null, true, this).name(path).create();
  }

  /** Whether `schema` is one the store was made holding: a plain schema of schemas, a basic scalar, a mutation schema.
   * It changes only through `extend`, which adds members to it. */
  override framework(schema: unknown): boolean {
    return this._framework.has(schema);
  }

  /** Builds and changes schemas through `cb`, given the store: a schema the store held before may only gain members (an
   * object schema's properties and adjacencies, a relation's properties, a union's branches), each under a name it
   * neither has nor inherits, nor a refinement of it declares; anything else about it stays as it was. What `cb` builds
   * is the store's own. It is a transaction of its own (docs/OBJECT_IDENTITY.md, Decided, 44), committed before the
   * extension ends, so that what it changes in the schemas the store held is checked as an extension's when it is
   * written; refused, it writes nothing. */
  extend(cb: unknown): this {
    this._extending = this._held;
    const before = new Map<unknown, [Set<string>, Set<string>]>();
    for (const meta of Object.values(this._meta)) {
      if (meta instanceof S.OfObject.Data) before.set(meta, [new Set(meta.properties.keys()), new Set(meta.adjacencies.keys())]);
    }
    try {
      this._transacting(() => visit(cb, this));
    } finally {
      this._extending = null;
      extendBuilders(this, before);
    }
    return this;
  }

  /** Refuses a builder's update of a schema the store was made holding outside an extension, and one that is not an
   * extension of a schema the store held when an extension began. */
  _permit(builder: any): void {
    const original = builder._original;
    if (this.framework(original) && this._extending === null && changes(builder)) {
      throw new TypeError(`${shown(original)} is one of the schemas the store was made holding: extend it with `
        + "store.extend");
    }
    if (this._extending !== null && (this._heldAt.get(original) as number) < this._extending) { // one never held: false
      const problems = extensionProblems(builder);
      if (problems.length > 0) throw new TypeError(`an extension only adds members to ${shown(original)}: it ${problems.join("; ")}`);
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
    const taken = parent.schemas.get(name);
    if (taken !== undefined && taken !== data) {
      throw new ValueError(`the path ${repr(data.name)} names another schema object already: a module and a schema, or two `
        + "schemas, do not share a path");
    }
    this._placed.set(data, [parent, name]);
    new ModuleBuilder(parent, true, this).schemas([(t: any) => t.name(name).schema(data)]).update();
  }

  /** Holds a schema object built here, refused where it would share an object with no name of its own; registers a named
   * schema and places it in its module. A framework schema, which every store holds as it is, is left so: a builder of
   * one writes only its store's entries. */
  _hold(data: any): any {
    if (this.framework(data)) return data;
    this._written();
    if (data instanceof S.OfScalar.Data) {
      throw new TypeError("a store builds no scalar schema: its scalars are the basic scalars it was made holding, "
        + "store.Schemas.OfBool, OfInt, OfFloat, OfStr and OfBytes");
    }
    this._link(data);
    if (!this._heldAt.has(data)) this._heldAt.set(data, this._held++);
    this._unnamedLog?.push([data, this._unnamed.has(data)]);
    if (_named(data)) {
      this._objects.add(data);
      this._unnamed.delete(data);
    } else { // renamed, or its name cleared
      this._unnamed.add(data);
      this._objects.delete(data);
    }
    HELD_BY.set(data, this); // its store, which gives its path (`Paths.of`)
    if (S._defined(data)) {
      for (const [name, schema] of [...this._schemas]) {
        if (schema === data && name !== data.name) this._schemas.delete(name); // renamed
      }
      if (data.name && this._schemas.get(data.name) !== data) this._register(data);
    }
    if (data instanceof ModuleData) {
      for (const [path, module] of [...this._modules]) {
        if (module === data && path !== (data.name ?? "")) this._modules.delete(path); // renamed
      }
      this._modules.set(data.name ?? "", data);
    }
    if (_namable(data) && data.name) {
      this._place(data);
    }
    return data;
  }

  /** A builder of a schema object of the meta-schema registered as `name`, new or `target` updated, as a link builds one
   * (docs/OBJECT_IDENTITY.md, Decided, 97); null where `name` is not a meta-schema. */
  _meta_builder(name: string, target: unknown = null): any {
    const local = name.startsWith("Schemas.") ? name.slice("Schemas.".length) : "";
    const kind = _META_BUILDERS.get(local);
    const registered = this._schemas.get(name);
    if (kind === undefined || registered === undefined || registered !== (this._meta as any)[local]) return null;
    return new kind(target, true, this);
  }

  /** The builder of a schema object. */
  _meta_builder_class(target: unknown): any {
    return builderFor(target);
  }

  _build(name: string, args: unknown[]): any {
    let existing: unknown = null;
    let cb: unknown = null;
    if (args.length === 1 && isFunction(args[0])) cb = args[0];
    else if (args.length === 1) existing = args[0];
    else if (args.length === 2) [existing, cb] = args;
    else throw new TypeError(`${name}(...) takes a callback, an object and a callback, or an object`);
    existing = Proxies._deref(existing);
    const kind = name.startsWith("Schemas.") ? _META_BUILDERS.get(name.slice("Schemas.".length)) : undefined;
    let builder: any;
    if (kind !== undefined) builder = new kind(existing, true, this);
    else if (this._schemas.has(name)) builder = this.builder(name, existing);
    else throw new AttributeError(`no schema registered as ${repr(name)}`);
    const build = (): any => {
      if (cb !== null) visit(cb, builder);
      if (existing === null) return builder.create();
      return cb !== null ? builder.update() : builder.clone();
    };
    return name.startsWith("Mutations.") ? this._expression(build) : build(); // an expression (94)
  }
}

/** `store.moduleName.[...moduleName].schemaName`: a schema's name, one part per member; called, it builds, and given
 * where an object is expected, it is the schema it names (`.schema([store.Schemas.OfInt])`); `as_schema()` gives it. */
/** `store.Instances.<path>`: a dotted name, each part an attribute, until it names a singleton, which it gives. An
 * owned object is found from it through its owners' adjacencies, called with keys; a counted object only by visiting
 * what links it (docs/OBJECT_IDENTITY.md, Decided, 40). */
function makeInstances(store: Store, name: string): any {
  const find = (): unknown => {
    throw new LookupError(`no singleton named ${repr(name)}: an owned object is found through its owners' adjacencies, `
      + "a counted one only through what links it");
  };
  return new Proxy(find, {
    get: (_target, part) => {
      if (part === REPR) return () => `<Instances.${name}>`;
      if (typeof part === "symbol" || Proxies._probes.has(part)) return undefined;
      if (part.startsWith("_")) throw new AttributeError(part);
      const dotted = name === "" ? part : `${name}.${part}`;
      return store._singletons.has(dotted) ? store._singletons.get(dotted) : makeInstances(store, dotted);
    },
  });
}

function makePath(store: Store, name: string): any {
  const asSchema = (): unknown => store.registered(name);
  const path = new Proxy((...args: unknown[]) => store._build(name, args), {
    get: (_target, part) => {
      if (part === REPR) return () => `<${name}>`;
      if (part === "as_schema") return asSchema;
      if (typeof part === "symbol" || Proxies._probes.has(part)) return undefined;
      if (part.startsWith("_")) throw new AttributeError(part);
      return makePath(store, `${name}.${part}`);
    },
  });
  Proxies._named(path, asSchema);
  return path;
}

// --- The namespaces, as `Schemas` gives them ---

export namespace OfScalar {
  export const Data = S.OfScalar.Data;
  export type Data = S.OfScalar.Data;
  export const Builder = ScalarBuilder;
  export type Builder = ScalarBuilder;
}

export namespace OfObject {
  export const Data = S.OfObject.Data;
  export type Data = S.OfObject.Data;
  export const Builder = ObjectBuilder;
  export type Builder = ObjectBuilder;
}

export namespace OfProperty {
  export const Data = S.OfProperty.Data;
  export type Data = S.OfProperty.Data;
  export const Builder = PropertyBuilder;
  export type Builder = PropertyBuilder;
}

export namespace OfAdjacency {
  export const Data = S.OfAdjacency.Data;
  export type Data = S.OfAdjacency.Data;
  export const Builder = AdjacencyBuilder;
  export type Builder = AdjacencyBuilder;
}

export namespace OfRelation {
  export const Data = S.OfRelation.Data;
  export type Data = S.OfRelation.Data;
  export const Builder = RelationBuilder;
  export type Builder = RelationBuilder;
}

export namespace OfSymbol {
  export const Data = S.OfSymbol.Data;
  export type Data = S.OfSymbol.Data;
  export const Builder = SymbolBuilder;
  export type Builder = SymbolBuilder;
}

export namespace OfParameter {
  export const Data = S.OfParameter.Data;
  export type Data = S.OfParameter.Data;
  export const Builder = ParameterBuilder;
  export type Builder = ParameterBuilder;
}

export namespace OfUnion {
  export const Data = S.OfUnion.Data;
  export type Data = S.OfUnion.Data;
  export const Builder = UnionBuilder;
  export type Builder = UnionBuilder;
  export const Branch = S.OfUnion.Branch;
  export type Branch = S.OfUnion.Branch;
}

export namespace OfIntersection {
  export const Data = S.OfIntersection.Data;
  export type Data = S.OfIntersection.Data;
  export const Builder = IntersectionBuilder;
  export type Builder = IntersectionBuilder;
  export const Part = S.OfIntersection.Part;
  export type Part = S.OfIntersection.Part;
}

export namespace OfContainer {
  export const Data = S.OfContainer.Data;
  export type Data = S.OfContainer.Data;
  export const Builder = ContainerBuilder;
  export type Builder = ContainerBuilder;
}

export namespace OfVariable {
  export const Data = S.OfVariable.Data;
  export type Data = S.OfVariable.Data;
  export const Builder = VariableBuilder;
  export type Builder = VariableBuilder;
}

export namespace OfPattern {
  export const Data = S.OfPattern.Data;
  export type Data = S.OfPattern.Data;
  export const Builder = PatternBuilder;
  export type Builder = PatternBuilder;
}

export namespace OfExpression {
  export const Data = S.OfExpression.Data;
  export type Data = S.OfExpression.Data;
  export const Builder = ExpressionBuilder;
  export type Builder = ExpressionBuilder;
}

export namespace OfConstraint {
  export const Data = S.OfConstraint.Data;
  export type Data = S.OfConstraint.Data;
  export const Builder = ConstraintBuilder;
  export type Builder = ConstraintBuilder;
}

export namespace OfCollector {
  export const Data = S.OfCollector.Data;
  export type Data = S.OfCollector.Data;
  export const Builder = CollectorBuilder;
  export type Builder = CollectorBuilder;
}

export namespace OfAny {
  export const Data = S.OfAny.Value;
  export type Data = S.OfAny.Value;
  export const Builder = AnyValueBuilder;
  export type Builder = AnyValueBuilder;
}

// --- For Plain, which writes and reads schema objects through their builders ---

export { builderFor as _builder_for, ModuleData as _ModuleData };

/** The schema object a visitor reads: a link's referent, where a builder builds it, or a builder's own; null for any other visitor. */
export function _linked(visitor: unknown): unknown {
  const inner = innerOf(visitor);
  if (inner instanceof Builder) return inner._original; // a schema object read through its builder: one a proxy's entry links
  if (!(inner instanceof Link)) return null;
  const referent = inner._entry._linked();
  return [referent, null][Number(builderFor(referent) === null)];
}

/** The data an entry's link read links, where `_linked` gives no schema object: an extension's relation's, from a schema
 * object's end; null for any other visitor. */
export function _linked_data(visitor: unknown): unknown {
  const inner = innerOf(visitor);
  return inner instanceof Link ? inner._entry._linked() : null;
}

/** Whether an adjacency member holds one entry at most, as a `unique` clause of its relation makes it. */
export function _holds_one(member: unknown): boolean {
  const inner = innerOf(member);
  return inner instanceof AdjacencyMember && inner._members.one;
}

// `Schemas.OfX.Builder` is this: a schema builder is a `Visitors.OfObject` over its plain schema, its store's
// `Schemas.OfX` (FRAMEWORK.md, Resolved: "Schemas.OfX.Builder must implement Visitors.OfX").
for (const [namespace, own] of [[S.OfScalar, OfScalar], [S.OfObject, OfObject], [S.OfProperty, OfProperty],
  [S.OfAdjacency, OfAdjacency], [S.OfRelation, OfRelation], [S.OfSymbol, OfSymbol], [S.OfParameter, OfParameter],
  [S.OfUnion, OfUnion], [S.OfIntersection, OfIntersection], [S.OfContainer, OfContainer], [S.OfAny, OfAny],
  [S.OfVariable, OfVariable], [S.OfPattern, OfPattern], [S.OfExpression, OfExpression], [S.OfConstraint, OfConstraint],
  [S.OfCollector, OfCollector]] as const) {
  Object.assign(namespace, { Builder: own.Builder });
}

