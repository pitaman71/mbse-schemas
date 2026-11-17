/**
 * Validators: check data against its schema, only when the caller asks.
 *
 * `Validate(store)(schema, value)` returns a list of problems (empty when valid). It is constructed with the store that
 * looks schemas up by name (see `Stores`). `Validate(store).Reachable(schema, root)` checks the root and every object
 * reachable from it.
 *
 * `Check(store)(schema, value)` checks the same, and also reports what it cannot decide: an `Outcome` of `problems`
 * and `unknowns`, which `holds` true, false or unknown.
 *
 * The validator reads the value through the visitor protocol (`Readers.OfObject`), through its schema. Checks:
 *
 * - the schemas involved pass `validate()`;
 * - the root is an instance of the given schema: of it, or of a refinement of it, checked by its own schema, so that a
 *   member it narrows is checked as narrowed;
 * - each property value has exactly its schema's scalar type (distinct scalars are never interchangeable);
 * - each linked object's schema declares an adjacency to that relation via that link;
 * - nothing is owned by a counted object: a schema neither a singleton nor owned declares no adjacency that another
 *   schema's adjacency marked `owner()` makes an owner (object identity 47 in [CAP-118: singletons, owned and counted objects](mbse:mbse-basis/docs/capabilities/CAP-118.md#decided));
 * - `unique(S)` clauses hold over the entries seen: entries that agree on everything outside `S` agree on `S`.
 *   Uniqueness is checked only over the entries reachable from what was validated.
 * - a value object's properties hold values of their schemas, recursively, each checked by its own schema, a
 *   refinement's value by the refinement (`Schemas.is_a`);
 * - an intersection value holds every one of the intersection's parts, each with a value of that part's schema;
 * - each parameter reference standing in the place of a value, or of an object a link links, is valid in its parameter
 *   context, `Parametrics.Context`: the context assigns its parameter a value of the schema the place expects, or, at a
 *   link, binds it to an object that may fill the link; else it is invalid. A parameter bound to a parameter reference
 *   that the context around it neither assigns nor binds is unknown at a link
 *   ([CAP-313: parameter references valid where their parameters are assigned or bound](mbse:mbse-basis/docs/capabilities/README.md#CAP-313));
 * - a parameter assignment's value is of the schema its parameter is for (`Parametrics.ForValue`), and a parameter
 *   binding's object of the object schema its parameter is for (`Parametrics.ForObject`).
 *
 * Each entry point takes a parameter context, empty unless the caller gives one. Where validation meets a reference
 * object that holds parameter assignments or parameter bindings (`Parametrics.extend`'s `assigned_values` and
 * `bound_objects`), it validates the object's properties and its other entries in a sub-context, which maps those
 * parameters' names to the values assigned and the objects bound, hiding the same names in the context around it. The
 * object's own assignments and bindings are checked in the context around it, so that none resolves through itself. A
 * sub-context follows validation's own descent, into an object's properties and entries and, through them, into the
 * values, value objects, union and intersection values and containers they hold; `Reachable` checks each object reached
 * in the caller's context, with that object's own sub-context.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Builders from "./Builders.js";
import { NotImplementedError } from "./Errors.js";
import { schemaTypeName } from "./Plain.js";
import * as Parametrics from "./Parametrics.js";
import { _admits, _derefFirst, _innerOf, _internals, _is_parameter, _key_of, _link_key, _parameter_in, _refines, scalarKey } from "./Proxies.js";
import * as Reachable from "./Reachable.js";
import type * as Readers from "./Readers.js";
import { repr, sortedStrings, tokenName, typeName } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type * as Visitors from "./Visitors.js";

// --- Reading values through their visitors ---

/** The scalar a property's visitor holds, or null. */
function scalar(read: any): unknown {
  const found: unknown[] = [];
  read.as_scalar((s: any) => found.push(s.get())); // a callback is always called
  return found[0];
}

/** The `Visitors.OfAny` method that reads a value of `schema`, a value object, union, intersection or container. */
function selecting(schema: unknown): string {
  return schema instanceof Schemas.OfUnion.Data ? "as_union" : schema instanceof Schemas.OfIntersection.Data ? "as_intersection"
    : schema instanceof Schemas.OfContainer.Data ? "as_container" : "as_object";
}

/** The value of any schema a `Visitors.OfAny` holds: a scalar, a visitor of its own kind, or null. */
function anyOf(read: any): any {
  const found: any[] = [];
  read.as_scalar((s: any) => {
    if (s.get() !== null) found.push(s.get());
    return s;
  });
  for (const select of ["as_object", "as_union", "as_intersection", "as_container"]) {
    read[select]((v: any) => {
      if (v.as_schema() !== null) found.push(v);
      return v;
    });
  }
  return found.length > 0 ? found[0] : null;
}

/** The schema a value of any schema has: a scalar's, or its visitor's schema. */
function own(value: any): any {
  const host = Schemas.hostOf(value);
  return host !== null ? new Schemas.OfScalar.Data(host) : value.as_schema();
}

/** The value object, union value or intersection value a property's visitor holds, as its own visitor; null when
 * absent. An empty visitor has no identity. */
function held(read: any, schema: unknown): any {
  const found: any[] = [];
  if (schema instanceof Schemas.OfAny.Value) {
    read.as_value((a: any) => found.push(anyOf(a)));
    return found[0];
  }
  read.as_value((a: any) => a[selecting(schema)]((v: any) => found.push(v)));
  return found[0].as_schema() !== null ? found[0] : null; // a callback is always called; a visitor of nothing has no schema
}

/** A union's branch's or an intersection's part's value, read through its visitor of its own schema's kind: a scalar, a
 * visitor, or null. */
function member(read: any, schema: unknown): unknown {
  if (schema instanceof Schemas.OfScalar.Data) return read.get();
  return read.as_schema() !== null ? read : null;
}

/** A container's element, read through its `Visitors.OfAny`: a scalar or a visitor; an element present holds one. */
function element(read: any, schema: unknown): any {
  const held = schema;
  const found: unknown[] = [];
  if (held instanceof Schemas.OfScalar.Data || held === null) read.as_scalar((s: any) => found.push(s.get()));
  else if (held instanceof Schemas.OfAny.Value) return anyOf(read);
  else read[selecting(held)]((v: any) => found.push(v));
  return found[0];
}

/** The name of the parameter that a parameter reference designates, where one stands in the place of a value of
 * `schema` that `read`, a `Visitors.OfAny` or an empty visitor, reads; else null (CAP-312). */
function standing(read: any, schema: unknown): string | null {
  const found: any[] = [];
  read.as_parameter((p: any) => {
    if (p.as_schema() !== null) found.push(p);
    return p;
  });
  return found.length > 0 && !_admits(schema, found[0].as_schema()) ? found[0].name.get() : null;
}

/** The name of the parameter that a parameter reference designates, where one stands in the place of a property's
 * value; else null. */
function standingInProperty(read: any, schema: unknown): string | null {
  const found: (string | null)[] = [];
  read.as_value((a: any) => found.push(standing(a, schema)));
  return found[0] as string | null;
}

/** A container's elements, each with its index, in order. */
function pairs(read: any): [unknown, any][] {
  const found: [unknown, any][] = [];
  read.as_entries((it: Iterator<[unknown, any]>) => found.push(...{ [Symbol.iterator]: () => it }));
  return found;
}

const schemaNumbers = new WeakMap<object, number>();
let schemaCount = 0;

/** A linked object's identity, unique among the objects of every schema: an identity is unique within its schema. */
function identity(target: any): string {
  return `${numberOf(target.as_schema())}:${_key_of(target)}`;
}

/** What a link links, as uniqueness tells it apart: the object's identity, or the parameter a parameter reference in its
 * place designates (CAP-312). */
function linkedIdentity(target: any, store: any): string {
  const parameter = _parameter_in(target);
  return parameter === null ? identity(visited(target, store)) : JSON.stringify(_link_key(parameter));
}

/** A number for each schema, as Python's `id()` of it. */
function numberOf(schema: object): number {
  if (!schemaNumbers.has(schema)) schemaNumbers.set(schema, ++schemaCount);
  return schemaNumbers.get(schema) as number;
}

// --- Checks ---

/** Whether a value, a scalar or a visitor, is of `expected`, as a place declared to hold a value of `expected` holds it:
 * a scalar of its host type, or a value of the schema or of a refinement of it, or of one of an `OfAny`'s. */
function isOf(value: any, expected: any): boolean {
  const of = own(value);
  if (of instanceof Schemas.OfScalar.Data) {
    const held: unknown[] = expected instanceof Schemas.OfAny.Value ? [...expected.schemas] : [expected];
    return held.some((t) => t instanceof Schemas.OfScalar.Data && t.type === of.type);
  }
  return _admits(expected, of);
}

/** A registered schema in a message: a basic scalar's tag, or its name. */
function shown(schema: any): string {
  return schema instanceof Schemas.OfScalar.Data ? String(schema.tag) : repr(schema.name);
}

const ASSIGNS = "Parametrics.AssignsValue";
const BINDS = "Parametrics.BindsObject";

/** Whether an adjacency is one through which its object assigns or binds parameters, as `Parametrics.extend` gives. */
function assigning(adjacency: Schemas.OfAdjacency.Data): boolean {
  return adjacency.me === "object" && [ASSIGNS, BINDS].includes((adjacency.relation as Schemas.OfRelation.Data).name as string);
}

/** Problems with a parameter reference standing in the place of a value of `schema`: its context assigns its parameter
 * a value of `schema`, or it is invalid (CAP-313). */
function reference(label: string, name: string, schema: unknown, context: Parametrics.Context): string[] {
  if (context.assigned(name) !== null) {
    return isOf(context.assigned(name), schema) ? []
      : [`${label}: parameter ${repr(name)} is assigned a value of another schema than its place expects`];
  }
  if (context.bound(name) !== null) return [`${label}: parameter ${repr(name)} is bound to an object, where a value is expected`];
  return [`${label}: parameter ${repr(name)} is neither assigned nor bound in its context`];
}

function scalarProblem(schema: Schemas.OfScalar.Data, value: unknown): string | null {
  if (schema.type === null) return null; // not a basic scalar: the schema's own problem, reported by its validate()
  if (!Schemas.isScalarOf(schema.type, value)) return `expected ${tokenName(schema.type)}, got ${typeName(value)}`;
  return null;
}

/** A linked object, as a visitor: a schema object, which an extension's relation links, through its read-only builder in
 * `store`, whose schema is the store's plain schema of it. */
function visited(target: any, store: unknown): any {
  const builder = Builders._builder_for(target) as (new (...args: unknown[]) => unknown) | null;
  return builder === null ? target : new builder(target, false, store);
}

/** Whether an object of `schema` may fill link `name` of `relation`: its schema must declare an adjacency via it, named
 * or anonymous; but the object a parameter is bound to, `Parametrics.BindsObject`'s `obj_ref`, may be any reference
 * object, whose schema opts into nothing ([CAP-314: parameters bound by the data objects their schema governs](mbse:mbse-basis/docs/capabilities/README.md#CAP-314)). */
function filling(relation: Schemas.OfRelation.Data, name: string, schema: Schemas.OfObject.Data): string | null {
  if (schema.fills(relation, name) || (relation.name === "Parametrics.BindsObject" && name === "obj_ref")) return null;
  return `a ${repr(schema.name)} cannot fill link ${repr(name)}; its schema declares no adjacency, named or anonymous, to this relation via ${repr(name)}`;
}

/** The adjacencies of a counted schema, neither a singleton nor owned, through which it would own an object of a schema
 * whose adjacency marked `owner()` is the other end: nothing is owned by a counted object (object identity
 * 47 in [CAP-118: singletons, owned and counted objects](mbse:mbse-basis/docs/capabilities/CAP-118.md#decided)). */
function countedOwners(store: Visitors.OfStore, schema: Schemas.OfObject.Data): string[] {
  const adjacencies = [...schema.adjacencies.values(), ...schema.anonymous];
  if (schema.singleton !== null || adjacencies.some((a) => a.owner)) return [];
  const problems: string[] = [];
  for (const adjacency of adjacencies) {
    for (const name of store.names()) {
      const owned = store.registered(name);
      if (owned instanceof Schemas.OfObject.Data && [...owned.adjacencies.values(), ...owned.anonymous]
        .some((a) => a.owner && a.relation === adjacency.relation && a.me !== adjacency.me)) {
        problems.push(`adjacency ${repr(adjacency.name || (adjacency.relation as Schemas.OfRelation.Data).name)} would own a `
          + `${repr(name)}, through its adjacency marked owner(): nothing is owned by a counted object, which a `
          + `${repr(schema.name)} is`);
      }
    }
  }
  return problems;
}

const ABSENT = "absent";

/** Equality key per [CAP-111: equality and ordering defined by the schema](mbse:mbse-basis/docs/capabilities/CAP-111.md), of a value read as `propertyValue` reads it: distinct scalars never compare
 * equal; floats compare by bit pattern; a value object by its properties. */
function key(schema: unknown, value: any): string {
  const held = schema;
  if (value === null || value === undefined) return ABSENT;
  if (held instanceof Schemas.OfScalar.Data || held === null) return scalarKey(value);
  if (held instanceof Schemas.OfAny.Value) {
    const of = own(value);
    return `any:${of instanceof Schemas.OfScalar.Data ? of.tag : numberOf(of)}:${key(of, value)}`;
  }
  if (held instanceof Schemas.OfContainer.Data) {
    const keyed = pairs(value).map(([index, e]) => JSON.stringify([
      Array.isArray(index) ? index.map(scalarKey) : scalarKey(index), // a value object index by its values too
      key(held.element, element(e, held.element))]));
    return `container:${JSON.stringify(sortedStrings(keyed))}`;
  }
  if (held instanceof Schemas.OfObject.Data) { // by its own schema: a refinement's value is not its base's
    const properties = [...value.as_properties as Iterable<Readers.OfProperty>].map((p) =>
      [p.as_schema().name, key(p.as_schema().schema, propertyValue(p, p.as_schema().schema))]);
    return `object:${numberOf(value.as_schema())}:${JSON.stringify(properties)}`;
  }
  const record = held as Schemas.OfUnion.Data | Schemas.OfIntersection.Data;
  const members = [...record.properties].map(([name, m]) => [name, key(m.schema, member(value[name], m.schema))]);
  return `record:${JSON.stringify(members)}`;
}

function propertyValue(read: any, schema: unknown): any {
  return schema instanceof Schemas.OfScalar.Data || schema === null ? scalar(read) : held(read, schema);
}

/** One relation entry with all its links, from whichever end it was seen: identities and value keys. */
class Entry {
  constructor(readonly links: Map<string, string>, readonly values: Map<string, string>) {}

  key(names: Iterable<string>): string {
    return JSON.stringify(sortedStrings(names).map((name) => {
      const link = this.links.get(name);
      if (link !== undefined) return [name, "object", link];
      return [name, this.values.get(name) ?? ABSENT];
    }));
  }
}

class Checker {
  readonly problems: string[] = [];
  readonly unknowns: string[] = [];
  private readonly schemasChecked = new Set<unknown>();
  private readonly entries = new Map<Schemas.OfRelation.Data, Map<string, Entry>>();

  constructor(private readonly store: Visitors.OfStore) {}

  private schema(label: string, schema: { validate(): string[] }): void {
    if (this.schemasChecked.has(schema)) return;
    this.schemasChecked.add(schema);
    this.problems.push(...schema.validate().map((problem) => `schema ${label}: ${problem}`));
    if (schema instanceof Schemas.OfObject.Data) {
      this.problems.push(...countedOwners(this.store, schema).map((problem) => `schema ${label}: ${problem}`));
    }
  }

  /** Checks an object, its properties and its entries; those of an object that assigns or binds parameters in a
   * sub-context of `context` (CAP-313), but for its own assignments and bindings, checked in `context`. */
  object(label: string, schema: Schemas.OfObject.Data, value: Readers.OfObject, context: Parametrics.Context): void {
    this.schema(repr(schema.name), schema);
    const inner = this.subContext(schema, value, context);
    this.problems.push(...this.properties(label, value, inner));
    for (const [name, adjacency] of schema.adjacencies) {
      [...(value[name] as Iterable<unknown>)].forEach((entry, i) => this.problems.push(
        ...this.entry(`${label}.${name}[${i}]`, adjacency, value, entry, assigning(adjacency) ? context : inner)));
    }
  }

  /** The sub-context of `context` in which an object's properties and entries are checked: each parameter the object
   * assigns a value, or binds to an object, through `Parametrics.extend`'s adjacencies, named as its set of parameters
   * names it, maps to that value or object. A parameter bound to a parameter reference maps to what `context` maps the
   * reference's parameter to, or, where `context` maps it to nothing, to the reference. */
  private subContext(schema: Schemas.OfObject.Data, value: any, context: Parametrics.Context): Parametrics.Context {
    let inner = context;
    for (const [name, adjacency] of schema.adjacencies) {
      if (!assigning(adjacency)) continue;
      const relation = adjacency.relation as Schemas.OfRelation.Data;
      for (const entry of value[name] as Iterable<any>) {
        const named = _parameter_in(entry.param) !== null ? null : Parametrics._named(this.store, entry.param);
        if (named === null) continue; // a parameter reference in the parameter's place, or a parameter no set defines
        if (relation.name === ASSIGNS) {
          inner = inner.assign(named, propertyValue(entry.value, relation.entry.properties.get("value")!.schema));
          continue;
        }
        const parameter = _parameter_in(entry.obj_ref);
        if (parameter !== null && context.assigned(parameter.name.get()) !== null) {
          inner = inner.assign(named, context.assigned(parameter.name.get()));
          continue;
        }
        const held = parameter === null ? null : context.bound(parameter.name.get());
        inner = inner.bind(named, held === null ? entry.obj_ref : held);
      }
    }
    return inner;
  }

  /** Problems with a parameter reference standing in the place of the object that `link` links: its context binds its
   * parameter to an object that may fill the link, or it is invalid; bound to a parameter reference that the context
   * around the binding neither assigns nor binds, it is unknown (CAP-313). */
  private linked(label: string, relation: Schemas.OfRelation.Data, link: string, name: string, context: Parametrics.Context): string[] {
    const target = context.bound(name);
    if (target !== null && _parameter_in(target) !== null) {
      this.unknowns.push(`${label}: parameter ${repr(name)} is bound to parameter ${repr(_parameter_in(target).name.get())}, `
        + "which its context neither assigns nor binds");
      return [];
    }
    if (target !== null) {
      const problem = filling(relation, link, visited(target, this.store).as_schema());
      return problem === null ? [] : [`${label}: parameter ${repr(name)} is bound to an object of another schema: ${problem}`];
    }
    if (context.assigned(name) !== null) return [`${label}: parameter ${repr(name)} is assigned a value, where an object is expected`];
    return [`${label}: parameter ${repr(name)} is neither assigned nor bound in its context`];
  }

  private properties(label: string, value: any, context: Parametrics.Context): string[] {
    const problems: string[] = [];
    for (const prop of value.as_properties as Iterable<Readers.OfProperty>) {
      const name = prop.as_schema().name;
      const held = prop.as_schema().schema;
      const parameter = standingInProperty(prop, held);
      if (parameter !== null) problems.push(...reference(`${label}.${name}`, parameter, held, context));
      problems.push(...this.valueProblems(`${label}.${name}`, held, propertyValue(prop, held), context));
    }
    return problems;
  }

  /** Problems with a value: its schema, recursively, and that an intersection value holds every part; and each
   * parameter reference standing in the place of a value it holds, in `context`. */
  private valueProblems(label: string, schema: unknown, item: any, context: Parametrics.Context): string[] {
    if (schema === null || item === null || item === undefined) return [];
    if (schema instanceof Schemas.OfScalar.Data) {
      const problem = scalarProblem(schema, item);
      return problem === null ? [] : [`${label}: ${problem}`];
    }
    if (schema instanceof Schemas.OfAny.Value) return this.anyProblems(label, schema, item, context);
    if (schema instanceof Schemas.OfContainer.Data) {
      return pairs(item).flatMap(([index, e]) => {
        const parameter = standing(e, schema.element);
        if (parameter !== null) return reference(`${label}[${repr(index)}]`, parameter, schema.element, context);
        return this.valueProblems(`${label}[${repr(index)}]`, schema.element, element(e, schema.element), context);
      });
    }
    if (schema instanceof Schemas.OfObject.Data) return this.properties(label, item, context);
    const record = schema as Schemas.OfUnion.Data | Schemas.OfIntersection.Data;
    const problems: string[] = [];
    const members = new Map([...record.properties].map(([name, m]) => [name, member(item[name], m.schema)]));
    for (const [name, m] of record.properties) {
      const read = item[name];
      const parameter = _innerOf(read) instanceof _internals._Empty ? standing(read, m.schema) : null;
      if (parameter !== null) problems.push(...reference(`${label}.${name}`, parameter, m.schema, context));
      problems.push(...this.valueProblems(`${label}.${name}`, m.schema, members.get(name), context));
    }
    const missing = [...record.properties.keys()].filter((name) => members.get(name) === null);
    if (record instanceof Schemas.OfIntersection.Data && missing.length > 0) problems.push(`${label}: parts ${repr(missing)} are not set`);
    return problems;
  }

  /** Problems with a value of any schema: that it is of one of its schemas, where it is restricted, or of a registered
   * schema, where it is not a scalar; and its own, under its own schema. */
  private anyProblems(label: string, schema: Schemas.OfAny.Value, item: any, context: Parametrics.Context): string[] {
    const of = own(item);
    const restricted = [...schema.schemas];
    let allowed: boolean;
    let shown: string;
    if (of instanceof Schemas.OfScalar.Data) {
      allowed = restricted.length === 0 || restricted.some((t) => t instanceof Schemas.OfScalar.Data && t.type === of.type);
      shown = String(of.tag);
    } else {
      allowed = restricted.some((t) => _refines(of, t));
      shown = repr(of.name);
      if (restricted.length === 0) {
        try {
          this.store.name_of(of);
          allowed = true;
        } catch { // a store's name_of refuses an unregistered schema
          return [`${label}: a value of any schema is of a registered schema; ${shown} is not registered`];
        }
      }
    }
    if (!allowed) return [`${label}: ${shown} is not one of its schemas`];
    return this.valueProblems(label, of, item, context);
  }

  /** Problems with one entry: each linked object's schema declares an adjacency to the relation via its link, and its
   * values have their schemas; each parameter reference in its place is valid in `context`; and a parameter
   * assignment's value, or a parameter binding's object, is of the schema its parameter is for. */
  private entry(label: string, adjacency: Schemas.OfAdjacency.Data, owner: any, entry: any, context: Parametrics.Context): string[] {
    const relation = adjacency.relation as Schemas.OfRelation.Data;
    this.schema(`of ${label}`, relation);
    const problems: string[] = [];
    for (const name of relation.entry.links.keys()) {
      if (name === adjacency.me) continue;
      const parameter = _parameter_in(entry[name]);
      if (parameter !== null) { // a parameter reference in the place of an object: valid where bound (CAP-313)
        problems.push(...this.linked(`${label}.${name}`, relation, name, parameter.name.get(), context));
        continue;
      }
      const problem = filling(relation, name, visited(entry[name], this.store).as_schema());
      if (problem !== null) problems.push(`${label}.${name}: ${problem}`);
    }
    for (const [name, prop] of relation.entry.properties) {
      const parameter = standingInProperty(entry[name], prop.schema);
      if (parameter !== null) problems.push(...reference(`${label}.${name}`, parameter, prop.schema, context));
      problems.push(...this.valueProblems(`${label}.${name}`, prop.schema, propertyValue(entry[name], prop.schema), context));
    }
    if (relation.name === ASSIGNS || relation.name === BINDS) problems.push(...this.parameterSchema(label, relation, entry, context));
    const links = new Map<string, string>([...relation.entry.links.keys()].filter((name) => name !== adjacency.me)
      .map((name) => [name, linkedIdentity(entry[name], this.store)]));
    links.set(adjacency.me, identity(owner));
    const values = new Map<string, string>();
    for (const [name, prop] of relation.entry.properties) {
      const found = propertyValue(entry[name], prop.schema);
      if (found !== null) values.set(name, key(prop.schema, found));
    }
    const full = new Entry(links, values);
    let seen = this.entries.get(relation);
    if (seen === undefined) this.entries.set(relation, (seen = new Map()));
    const fullKey = full.key([...relation.entry.links.keys(), ...relation.entry.properties.keys()]);
    if (!seen.has(fullKey)) seen.set(fullKey, full);
    return problems;
  }

  /** Problems with a parameter assignment's value, or a parameter binding's object: it is of the schema its parameter is
   * for (`Parametrics.ForValue`, `ForObject`); a value is assigned, and an object bound, to a parameter for one (CAP-314,
   * checked as CAP-313 decides). A parameter reference in the parameter's place is not checked: its schema is not known
   * here. */
  private parameterSchema(label: string, relation: Schemas.OfRelation.Data, entry: any, context: Parametrics.Context): string[] {
    if (_parameter_in(entry.param) !== null) return [];
    const forValue = Parametrics._for(this.store, entry.param, "Parametrics.ForValue");
    const forObject = Parametrics._for(this.store, entry.param, "Parametrics.ForObject");
    if (relation.name === ASSIGNS) {
      const value = propertyValue(entry.value, relation.entry.properties.get("value")!.schema);
      if (forObject !== null) return [`${label}: a value is assigned to a parameter for an object`];
      if (forValue === null || value === null || isOf(value, forValue)) return [];
      return [`${label}.value: a value of ${shown(own(value))} is assigned to a parameter for a value of ${shown(forValue)}`];
    }
    if (forValue !== null) return [`${label}: an object is bound to a parameter for a value`];
    const parameter = _parameter_in(entry.obj_ref);
    const target = parameter === null ? entry.obj_ref : context.bound(parameter.name.get());
    if (forObject === null || target === null || _parameter_in(target) !== null) return []; // reported as a link's
    const bound = visited(target, this.store).as_schema();
    if (Schemas.is_a(bound, forObject)) return [];
    return [`${label}.obj_ref: a ${repr(bound.name)} is bound to a parameter for an object of ${repr(forObject.name)}`];
  }

  uniques(): void {
    for (const [relation, entries] of this.entries) {
      const names = new Set([...relation.entry.links.keys(), ...relation.entry.properties.keys()]);
      for (const unique of relation.uniques) {
        const rest = [...names].filter((name) => !unique.has(name));
        const determined = new Map<string, string>();
        for (const entry of entries.values()) {
          const restKey = entry.key(rest);
          const uniqueKey = entry.key(unique);
          if (!determined.has(restKey)) determined.set(restKey, uniqueKey);
          if (determined.get(restKey) !== uniqueKey) {
            this.problems.push(
              `unique(${sortedStrings(unique).join(", ")}) violated: entries agreeing on ` +
                `${repr(sortedStrings(rest))} differ on ${repr(sortedStrings(unique))}`,
            );
            break;
          }
        }
      }
    }
  }
}

// --- Entry points ---

/** What a check found: the `problems`, each a reason the data is invalid, and the `unknowns`, each something that
 * could not be decided. */
export class Outcome {
  constructor(readonly problems: string[], readonly unknowns: string[]) {}

  /** Whether the data is valid: false with a problem, else null with an unknown, else true. */
  get holds(): boolean | null {
    return this.problems.length > 0 ? false : this.unknowns.length > 0 ? null : true;
  }
}

export interface CheckCall {
  (schema: unknown, value: unknown, context?: Parametrics.Context): Outcome;
  OfScalar(schema: Schemas.OfScalar.Data, value: unknown, context?: Parametrics.Context): Outcome;
  OfObject(schema: Schemas.OfObject.Data, value: Readers.OfObject, context?: Parametrics.Context): Outcome;
  Reachable(schema: Schemas.OfObject.Data, root: Readers.OfObject, context?: Parametrics.Context): Outcome;
}

/** Checks data against its schema: `Check(store)(schema, value)` gives an `Outcome`, dispatching on the schema's kind. */
export function Check(store: Visitors.OfStore): CheckCall {
  /** Checks the objects, each by its own schema; the first, the root, must be an instance of `schema`: of it, or of a
   * refinement of it, since an instance of a refinement is an instance of what it refines (`Schemas.is_a`). */
  const run = (schema: Schemas.OfObject.Data, values: Readers.OfObject[], context: Parametrics.Context): Outcome => {
    const root = values[0] as Readers.OfObject;
    if (!Schemas.is_a(root.as_schema(), schema)) {
      return new Outcome([`the value is a ${repr(root.as_schema().name)}, not an instance of the given schema`], []);
    }
    const check = new Checker(store);
    values.forEach((value, i) => check.object(`${value.as_schema().name}#${i}`, value.as_schema(), value, context));
    check.uniques();
    return new Outcome(check.problems, check.unknowns);
  };
  /** Checks a scalar; a parameter reference given in its place, in `context`. */
  const OfScalar = (schema: Schemas.OfScalar.Data, value: unknown, context = new Parametrics.Context()): Outcome => {
    if (_is_parameter(value)) return new Outcome([...schema.validate(), ...reference("the value", (value as any).name.get(), schema, context)], []);
    const problem = scalarProblem(schema, value);
    return new Outcome([...schema.validate(), ...(problem ? [problem] : [])], []);
  };
  /** Checks one object and its entries; uniqueness only over the entries it is part of. */
  const OfObject = (schema: Schemas.OfObject.Data, value: Readers.OfObject, context = new Parametrics.Context()): Outcome =>
    run(schema, [value], context);
  /** Checks the root and every object reachable from it through adjacencies, each in `context`. */
  const ReachableCheck = (schema: Schemas.OfObject.Data, root: Readers.OfObject, context = new Parametrics.Context()): Outcome =>
    run(schema, Reachable.of(root), context);
  const call = (schema: unknown, value: unknown, context?: Parametrics.Context): Outcome => {
    if (schema instanceof Schemas.OfScalar.Data) return OfScalar(schema, value, context);
    if (schema instanceof Schemas.OfObject.Data) return OfObject(schema, value as Readers.OfObject, context);
    throw new NotImplementedError(`${schemaTypeName(schema)} cannot be validated yet`);
  };
  const named = _derefFirst; // a path names its schema
  return Object.assign(named(call), { OfScalar: named(OfScalar), OfObject: named(OfObject), Reachable: named(ReachableCheck) });
}

export interface ValidateCall {
  (schema: unknown, value: unknown, context?: Parametrics.Context): string[];
  OfScalar(schema: Schemas.OfScalar.Data, value: unknown, context?: Parametrics.Context): string[];
  OfObject(schema: Schemas.OfObject.Data, value: Readers.OfObject, context?: Parametrics.Context): string[];
  Reachable(schema: Schemas.OfObject.Data, root: Readers.OfObject, context?: Parametrics.Context): string[];
}

/** Validates data against its schema: `Validate(store)(schema, value)` gives the problems `Check` finds, so what is
 * unknown is not a problem. */
export function Validate(store: Visitors.OfStore): ValidateCall {
  const check = Check(store);
  const call = (schema: unknown, value: unknown, context?: Parametrics.Context): string[] => check(schema, value, context).problems;
  return Object.assign(call, {
    /** Checks a scalar; a parameter reference given in its place, in `context`. */
    OfScalar: (schema: Schemas.OfScalar.Data, value: unknown, context?: Parametrics.Context) =>
      check.OfScalar(schema, value, context).problems,
    /** Checks one object and its entries; uniqueness only over the entries it is part of. */
    OfObject: (schema: Schemas.OfObject.Data, value: Readers.OfObject, context?: Parametrics.Context) =>
      check.OfObject(schema, value, context).problems,
    /** Checks the root and every object reachable from it through adjacencies, each in `context`. */
    Reachable: (schema: Schemas.OfObject.Data, root: Readers.OfObject, context?: Parametrics.Context) =>
      check.Reachable(schema, root, context).problems,
  });
}
