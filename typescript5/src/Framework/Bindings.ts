/**
 * Bindings: a program's own classes, bound to reference object schemas.
 *
 * `Proxies` gives any registered schema dynamic instances; `Bindings` gives a program's own classes, written or
 * generated in its language, the same part in the framework. A binding pairs a reference object schema, the source of
 * truth, with two functions: `read(instance)` gives an instance's `State`, and `make(state)` builds an instance from
 * one; `assign(instance, state)` writes a state into an existing instance, for `update()`. Everything else is generic:
 *
 * - `accept(binding, instance, visitor)` writes an instance through the visitor protocols, so a class's `accept` is
 *   one line.
 * - `new Builder(binding, instance)` is a `Visitors.OfObject` over a state, with every value kind the schema declares:
 *   natives (checked by type), and value objects, unions and lists (through their plain form). It is finalized by
 *   `create()`, `clone()` and `update()`, none validating. A class's own builder derives from it for its DSL.
 * - `Registry` gives `Plain.FromPlain` the builders by schema name.
 *
 * A state holds each property's value, natives as natives and other values in their plain form (an absent property
 * has no key, and a builder drops the keys whose value is null), and each adjacency's entries, each an `Entry` of its
 * links (the linked instances) and its properties. A binding may also declare `fixed` properties, whose value is the
 * class's (a tag), so that writing another throws; `exclusive` groups of properties, of which a state holds at most
 * one, so that writing one clears the others; and `implied` adjacencies, whose entries the other ends imply, so that
 * the builder ignores entries added to them.
 */

import { AttributeError, KeyError, LookupError, ValueError } from "./Errors.js";
import * as Plain from "./Plain.js";
import { repr, tokenName, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type { Callback, Native, OfAdjacency, OfAny, OfEntry, OfIndexed, OfIntersection, OfLink, OfNative, OfObject,
  OfProperty, OfUnion, Visitable } from "./Visitors.js";

/** One entry of an adjacency, seen from the instance: its other links and its properties. */
export class Entry {
  constructor(readonly links: Map<string, unknown> = new Map(), readonly properties: Map<string, unknown> = new Map()) {}
}

/** An instance's data in its schema's terms: property values by name (natives as natives, other values in their
 * plain form; an absent property has no key), and entries by adjacency name. */
export class State {
  constructor(public values: Map<string, unknown> = new Map(), readonly entries: Map<string, Entry[]> = new Map()) {}
}

/** What a binding may declare beyond its functions. */
export interface Options {
  fixed?: ReadonlyMap<string, Native>;
  exclusive?: Iterable<readonly string[]>;
  implied?: Iterable<string>;
}

/** A class bound to a reference object schema, through `read`, `make` and `assign`. */
export class Binding {
  readonly assign: (instance: any, state: State) => any;
  readonly fixed: ReadonlyMap<string, Native>;
  readonly exclusive: ReadonlyMap<string, readonly string[]>;
  readonly implied: ReadonlySet<string>;

  constructor(readonly schema: Schemas.OfObject.Data, readonly read: (instance: any) => State,
    readonly make: (state: State) => any, assign: ((instance: any, state: State) => any) | null = null,
    options: Options = {}) {
    this.assign = assign ?? ((instance) => instance);
    this.fixed = new Map(options.fixed ?? []);
    this.exclusive = new Map([...(options.exclusive ?? [])].flatMap((group) => group.map((name) => [name, [...group]])));
    this.implied = new Set(options.implied ?? []);
  }
}

function isNative(schema: unknown): schema is Schemas.OfNative.Data {
  return schema instanceof Schemas.OfNative.Data;
}

/** Writes a state's value: a native as is, any other value from its plain form. */
function writeValue(visitor: OfAny, schema: Schemas.OfAny.Data, value: unknown): void {
  if (isNative(schema)) visitor.as_native((n) => n.set(value as Native));
  else Plain._write(visitor, Plain._decode(schema, value, []));
}

/** Writes `instance` into `visitor`: its properties in the schema's order (the fixed ones from the binding), then
 * each adjacency's entries. */
export function accept(binding: Binding, instance: unknown, visitor: OfObject): void {
  const state = binding.read(instance);
  for (const [name, schema] of binding.schema.properties) {
    const value = binding.fixed.has(name) ? binding.fixed.get(name) : state.values.get(name);
    if (value !== null && value !== undefined) visitor.property(name, (p) => p.value((a) => writeValue(a, schema, value)));
  }
  for (const [name, adjacency] of binding.schema.adjacencies) {
    for (const entry of state.entries.get(name) ?? []) {
      visitor.adjacency(name, (a) => a.add((x) => fill(x, adjacency.relation as Schemas.OfRelation.Data, entry)));
    }
  }
}

function fill(visitor: OfEntry, relation: Schemas.OfRelation.Data, entry: Entry): void {
  for (const [link, target] of entry.links) visitor.link(link, (k) => k.set(target as Visitable));
  for (const [name, value] of entry.properties) {
    if (value !== null && value !== undefined) { // absent
      const schema = relation.properties.get(name) as Schemas.OfAny.Data;
      visitor.property(name, (p) => p.value((a) => writeValue(a, schema, value)));
    }
  }
}

function sameNative(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

// --- Builders: Visitors over a state ---

/** `Visitors.OfProperty`, `OfAny` and `OfNative` over a native value in a map: present only with the schema's type;
 * setting checks the type, and clears the others of its exclusive group. */
class _NativeSlot implements OfProperty, OfAny, OfNative {
  constructor(protected readonly values: Map<string, unknown>, protected readonly slotName: string,
    protected readonly schema: Schemas.OfNative.Data, private readonly group: readonly string[] = []) {}

  name(): string {
    return this.slotName;
  }

  has(): boolean {
    return Schemas.isNativeOf(this.schema.type, this.values.get(this.slotName));
  }

  get(): Native {
    if (!this.has()) throw new AttributeError(`property ${repr(this.slotName)} is not set`);
    return this.values.get(this.slotName) as Native;
  }

  protected check(value: Native): void {
    const host = this.schema.host();
    if (!Schemas.isNativeOf(host, value)) throw new TypeError(`expected ${tokenName(host)}, got ${typeName(value)}`);
  }

  set(value: Native): this {
    this.check(value);
    for (const other of this.group) this.values.delete(other);
    this.values.set(this.slotName, value);
    return this;
  }

  clear(): this {
    this.values.delete(this.slotName);
    return this;
  }

  value(callback: Callback<OfAny>): this {
    callback(this);
    return this;
  }

  as_native(callback: Callback<OfNative>): this {
    callback(this);
    return this;
  }

  as_object(_callback: Callback<OfObject>): this {
    throw new TypeError(`property ${repr(this.slotName)} is native`);
  }

  as_union(_callback: Callback<OfUnion>): this {
    throw new TypeError(`property ${repr(this.slotName)} is native`);
  }

  as_intersection(_callback: Callback<OfIntersection>): this {
    throw new TypeError(`property ${repr(this.slotName)} is native`);
  }

  as_indexed(_callback: Callback<OfIndexed>): this {
    throw new TypeError(`property ${repr(this.slotName)} is native`);
  }
}

/** A fixed property: it always holds the binding's value, and writing another throws. */
class _FixedSlot extends _NativeSlot {
  constructor(name: string, schema: Schemas.OfNative.Data, private readonly fixed: Native) {
    super(new Map([[name, fixed]]), name, schema);
  }

  override set(value: Native): this {
    this.check(value);
    if (!sameNative(value, this.fixed)) {
      throw new ValueError(`expected ${this.slotName} ${repr(this.fixed)}, got ${repr(value)}`);
    }
    return this;
  }

  override clear(): this {
    return this;
  }
}

/** The handle of the property `name`: a native's, or a plain writer for any other value. */
function slot(values: Map<string, unknown>, name: string, schema: Schemas.OfAny.Data,
  group: readonly string[] = []): OfProperty {
  if (isNative(schema)) return new _NativeSlot(values, name, schema, group);
  return new Plain._PropertyWriter(values as Plain.PlainMap, name, schema, () => new Map(), Plain._unlinked);
}

/** `Visitors.OfLink` over one link of an entry. */
class _LinkSlot implements OfLink {
  constructor(private readonly entry: Entry, private readonly linkName: string) {}

  name(): string {
    return this.linkName;
  }

  target(callback: Callback<Visitable>): this {
    const target = this.entry.links.get(this.linkName) ?? null;
    if (target === null) throw new ValueError(`link ${repr(this.linkName)} is not set`);
    callback(target as Visitable);
    return this;
  }

  set(target: Visitable): this {
    this.entry.links.set(this.linkName, target);
    return this;
  }
}

/** `Visitors.OfEntry` over one entry of an adjacency, seen from the end that fills `me`. */
class _EntrySlot implements OfEntry {
  constructor(private readonly relation: Schemas.OfRelation.Data, private readonly own: string, readonly entry: Entry) {}

  private others(): string[] {
    return this.relation.links.filter((name) => name !== this.own);
  }

  links(callback: Callback<OfLink>): this {
    for (const name of this.others()) callback(new _LinkSlot(this.entry, name));
    return this;
  }

  link(name: string, callback: Callback<OfLink>): this {
    if (!this.others().includes(name)) throw new KeyError(`${repr(name)} is not a link this entry can set`);
    callback(new _LinkSlot(this.entry, name));
    return this;
  }

  properties(callback: Callback<OfProperty>): this {
    for (const name of this.relation.properties.keys()) if (this.has(name)) callback(this.slot(name));
    return this;
  }

  has(name: string): boolean {
    return this.relation.properties.has(name) && (this.entry.properties.get(name) ?? null) !== null;
  }

  private slot(name: string): OfProperty {
    return slot(this.entry.properties, name, this.relation.properties.get(name) as Schemas.OfAny.Data);
  }

  property(name: string, callback: Callback<OfProperty>): this {
    if (!this.relation.properties.has(name)) throw new KeyError(`unknown property ${repr(name)}`);
    callback(this.slot(name));
    return this;
  }

  clear(name: string): this {
    this.entry.properties.delete(name);
    return this;
  }
}

/** `Visitors.OfAdjacency` over one adjacency of a builder; an implied one keeps no entries. */
class _AdjacencySlot implements OfAdjacency {
  constructor(private readonly adjacencyName: string, private readonly adjacency: Schemas.OfAdjacency.Data,
    private readonly list: Entry[] | null) {}

  name(): string {
    return this.adjacencyName;
  }

  me(): string {
    return this.adjacency.me as string;
  }

  private slot(entry: Entry): _EntrySlot {
    return new _EntrySlot(this.adjacency.relation as Schemas.OfRelation.Data, this.me(), entry);
  }

  entries(callback: Callback<OfEntry>): this {
    for (const entry of [...(this.list ?? [])]) callback(this.slot(entry));
    return this;
  }

  add(callback: Callback<OfEntry>): this {
    const entry = new Entry();
    callback(this.slot(entry));
    this.list?.push(entry);
    return this;
  }

  remove(entry: OfEntry): this {
    if (this.list !== null && entry instanceof _EntrySlot) {
      this.list.splice(0, this.list.length, ...this.list.filter((e) => e !== entry.entry));
    }
    return this;
  }
}

/** `Visitors.OfObject` over the state of an instance of `binding`'s class, starting from `instance` if given.
 * Finalized by `create()`, `clone()` or `update()`; none validate. */
export class Builder implements OfObject {
  readonly state: State;
  protected readonly source: unknown;

  constructor(readonly binding: Binding, instance?: unknown) {
    this.source = instance ?? null;
    const state = this.source === null ? new State() : binding.read(instance);
    state.values = new Map([...state.values].filter(([, value]) => value !== null && value !== undefined));
    this.state = state;
  }

  // Finalizing

  create(): any {
    if (this.source !== null) {
      throw new ValueError("create() is only valid without a source instance; use clone() or update()");
    }
    return this.binding.make(this.state);
  }

  clone(): any {
    if (this.source === null) throw new ValueError("clone() is only valid with a source instance");
    return this.binding.make(this.state);
  }

  update(): any {
    if (this.source === null) throw new ValueError("update() is only valid with a source instance");
    return this.binding.assign(this.source, this.state);
  }

  // Visitors.OfObject

  private field(name: string): OfProperty {
    const schema = this.binding.schema.properties.get(name) as Schemas.OfAny.Data;
    if (this.binding.fixed.has(name)) {
      return new _FixedSlot(name, schema as Schemas.OfNative.Data, this.binding.fixed.get(name) as Native);
    }
    const group = (this.binding.exclusive.get(name) ?? []).filter((other) => other !== name);
    return slot(this.state.values, name, schema, group);
  }

  properties(callback: Callback<OfProperty>): this {
    for (const name of this.binding.schema.properties.keys()) if (this.has(name)) callback(this.field(name));
    return this;
  }

  has(name: string): boolean {
    return this.binding.schema.properties.has(name) && this.field(name).has();
  }

  property(name: string, callback: Callback<OfProperty>): this {
    if (!this.binding.schema.properties.has(name)) throw new KeyError(`unknown property ${repr(name)}`);
    callback(this.field(name));
    return this;
  }

  clear(name: string): this {
    if (this.binding.schema.properties.has(name)) this.field(name).clear();
    return this;
  }

  adjacencies(callback: Callback<OfAdjacency>): this {
    for (const name of this.binding.schema.adjacencies.keys()) this.adjacency(name, callback);
    return this;
  }

  adjacency(name: string, callback: Callback<OfAdjacency>): this {
    const adjacency = this.binding.schema.adjacencies.get(name);
    if (adjacency === undefined) throw new KeyError(`unknown adjacency ${repr(name)}`);
    let list: Entry[] | null = null;
    if (!this.binding.implied.has(name)) {
      if (!this.state.entries.has(name)) this.state.entries.set(name, []);
      list = this.state.entries.get(name) as Entry[];
    }
    callback(new _AdjacencySlot(name, adjacency, list));
    return this;
  }

  /** A bound class's instances are reference objects, so there is nothing to identify. */
  identify(_value: Visitable): this {
    return this;
  }
}

// --- The registry ---

/** The builders of bound classes, by schema name: `registry[name](instance)` returns a builder, as `Plain.FromPlain`
 * expects. `schema` and `name_of` look the schemas up; a relation's name is known, but has no builder. */
export class Registry implements Plain.Builders {
  private readonly schemas: Map<string, Schemas.OfObject.Data>;
  private readonly relations: Map<string, Schemas.OfRelation.Data>;
  readonly [name: string]: unknown;

  constructor(builders: ReadonlyMap<string, readonly [Schemas.OfObject.Data, (instance?: any) => unknown]>,
    relations: ReadonlyMap<string, Schemas.OfRelation.Data> = new Map()) {
    this.schemas = new Map([...builders].map(([name, [schema]]) => [name, schema]));
    this.relations = new Map(relations);
    for (const [name, [, factory]] of builders) (this as Record<string, unknown>)[name] = factory;
  }

  schema(name: string): Schemas.OfObject.Data {
    if (this.relations.has(name)) throw new TypeError(`${repr(name)} is a relation; no relation builder is exposed`);
    const found = this.schemas.get(name);
    if (found === undefined) throw new AttributeError(`no schema registered as ${repr(name)}`);
    return found;
  }

  name_of(schema: unknown): string {
    for (const [name, registered] of [...this.schemas, ...this.relations]) if (registered === schema) return name;
    throw new LookupError("schema is not registered");
  }

  /** The value an instance holds in its property `name`. */
  member(instance: unknown, name: string): unknown {
    return (instance as Record<string, unknown>)[name];
  }
}
