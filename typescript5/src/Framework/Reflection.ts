/**
 * Reflection: schemas as the objects of a store.
 *
 * A module holds schemas as value objects, nested (`Modules`), which is how they are written and read. Reflection binds
 * the schema data classes themselves to reference object schemas, as mbse-expressions binds its terms (see `Bindings`),
 * so that a store's objects are the schemas: each kind of schema, and each property, branch or part, parameter and
 * adjacency, is an object of its own. `store(schemas)` makes such a store, whose singleton catalog lists the schemas;
 * what the catalog reaches is the store's data, so predicates and queries (mbse-patterns) match schemas as they match
 * any objects, and transforms rewrite them. There is nothing to build from schemas or to read back: the objects are the
 * schemas.
 *
 * - **Kinds and elements.** `Schemas.Native`, `Schemas.Object`, `Schemas.Union`, `Schemas.Intersection`,
 *   `Schemas.Indexed`, `Schemas.Apply` and `Schemas.Relation` are the kinds' meta-schemas; `Schemas.Property`,
 *   `Schemas.Member` (a union's branch, an intersection's part), `Schemas.Parameter` and `Schemas.Adjacency` the
 *   elements'. Each has its natives as properties (a native's token as `format` and `token`), and an extent, a width's
 *   terms and an application's arguments as values, in their module form.
 * - **Relations.** `Schemas.Members` links an `owner` to each `member` it holds, with the member's `role`
 *   (`parameters`, `properties`, `branches`, `parts`, `adjacencies`) and `index`; `Schemas.Types` links a `user` to
 *   each `type` it refers to, with its `role` (`type`, `item`, `key`, `of`, `relation`); `Schemas.Listed` links the
 *   catalog to each schema, with its `index`. Each is written from the side that holds it (`members`, `types`,
 *   `schemas`); the other sides (`owners`, `users`, `listed`) are implied.
 */

import * as Bindings from "./Bindings.js";
import * as Modules from "./Modules.js";
import type { PlainMap } from "./Plain.js";
import { repr } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type { OfObject as ObjectVisitor } from "./Visitors.js";

export const CATALOG = "Schemas.Catalog";

const native = (name: string, kind: Schemas.OfNative.Spec = String) => (p: Schemas.OfProperty.Builder) => p.name(name).of((t) => t.as_native(kind));
const typed = (name: string, schema: Schemas.OfAny.Data) => (p: Schemas.OfProperty.Builder) => p.name(name).of(schema);

export const Members = new Schemas.OfRelation.Builder().name("Schemas.Members").links("owner", "member").properties(
  native("role"), native("index", BigInt)).unique("member").create();
export const Types = new Schemas.OfRelation.Builder().name("Schemas.Types").links("user", "type").properties(
  native("role")).unique("type").create();
export const Listed = new Schemas.OfRelation.Builder().name("Schemas.Listed").links("catalog", "schema").properties(
  native("index", BigInt)).unique("schema").create();

type Adjacent = (r: Schemas.OfAdjacency.Builder) => Schemas.OfAdjacency.Builder;
const MEMBERS: Adjacent = (r) => r.name("members").of(Members).me("owner");
const OWNERS: Adjacent = (r) => r.name("owners").of(Members).me("member");
const TYPES: Adjacent = (r) => r.name("types").of(Types).me("user");
const USERS: Adjacent = (r) => r.name("users").of(Types).me("type");
const LISTED: Adjacent = (r) => r.name("listed").of(Listed).me("schema");
const KIND = [MEMBERS, USERS, LISTED];
const ELEMENT = [TYPES, OWNERS];

function meta(name: string, properties: ((p: Schemas.OfProperty.Builder) => Schemas.OfProperty.Builder)[],
  relations: Adjacent[]): Schemas.OfObject.Data {
  return new Schemas.OfObject.Builder().name(name).ref().properties(...properties).relations(...relations).create();
}

const named = [native("name"), native("description")];
const value = (name: string, schema: Schemas.OfObject.Data) => typed(name, schema.properties.get(name)?.type as Schemas.OfAny.Data);

/** Each schema data class's meta-schema, as a store of schemas registers it. */
export const META = new Map<unknown, Schemas.OfObject.Data>([
  [Schemas.OfNative.Data, meta("Schemas.Native", [...named, native("format"), native("token"), native("bits", BigInt),
    native("bytes", BigInt), value("terms", Schemas.OfNative.Schema)], KIND)],
  [Schemas.OfObject.Data, meta("Schemas.Object", [...named, native("singleton"), native("ref", Boolean)], KIND)],
  [Schemas.OfUnion.Data, meta("Schemas.Union", named, KIND)],
  [Schemas.OfIntersection.Data, meta("Schemas.Intersection", named, KIND)],
  [Schemas.OfIndexed.Data, meta("Schemas.Indexed", [...named, value("extent", Schemas.OfIndexed.Schema)], [...KIND, TYPES])],
  [Schemas.OfApply.Data, meta("Schemas.Apply", [...named, value("arguments", Schemas.OfApply.Schema)], [...KIND, TYPES])],
  [Schemas.OfRelation.Data, meta("Schemas.Relation", [...named, value("links", Schemas.OfRelation.Schema),
    value("uniques", Schemas.OfRelation.Schema)], KIND)],
  [Schemas.OfProperty.Data, meta("Schemas.Property", named, ELEMENT)],
  [Schemas.OfUnion.Branch, meta("Schemas.Member", named, ELEMENT)],
  [Schemas.OfParameter.Data, meta("Schemas.Parameter", named, ELEMENT)],
  [Schemas.OfAdjacency.Data, meta("Schemas.Adjacency", [...named, native("me")], ELEMENT)],
]);

// --- Reading: an instance's state ---

function present(values: [string, unknown][]): Map<string, unknown> {
  return new Map(values.filter(([, v]) => v !== null && v !== undefined));
}

/** The entries of `members`: each group's members, in order, by role. */
function members(groups: [string, Iterable<unknown>][]): Bindings.Entry[] {
  return groups.flatMap(([role, group]) => [...group].map((member, index) =>
    new Bindings.Entry(new Map([["member", member]]), new Map<string, unknown>([["role", role], ["index", BigInt(index)]]))));
}

/** The entries of `types`: each type referred to, by role. */
function types(roles: [string, unknown][]): Bindings.Entry[] {
  return roles.filter(([, type]) => type !== null).map(([role, type]) =>
    new Bindings.Entry(new Map([["type", type]]), new Map([["role", role]])));
}

/** A schema's or an element's state: its natives, its values in their module form, its members and types. */
function read(schema: any): Bindings.State {
  const named: [string, unknown][] = [["name", schema.name], ["description", schema.description]];
  const parameters: [string, Iterable<unknown>] = ["parameters", (schema.parameters ?? new Map()).values()];
  if (schema instanceof Schemas.OfNative.Data) {
    if (!(schema.token instanceof Schemas.OfNative.Token)) throw new TypeError(`unsupported native type ${repr(schema.token)}`);
    const values = present([...named, ["format", schema.token.format], ["token", schema.token.name], ["bits", Modules._literal(schema.bits)],
      ["bytes", Modules._literal(schema.bytes)], ["terms", Modules._terms([["bits", schema.bits], ["bytes", schema.bytes]])]]);
    return new Bindings.State(values, new Map([["members", members([parameters])]]));
  }
  if (schema instanceof Schemas.OfObject.Data) {
    const values = present([...named, ["singleton", schema.singleton], ["ref", schema.ref || null]]);
    return new Bindings.State(values, new Map([["members", members([parameters, ["properties", schema.properties.values()],
      ["adjacencies", schema.adjacencies.values()]])]]));
  }
  if (schema instanceof Schemas.OfUnion.Data || schema instanceof Schemas.OfIntersection.Data) {
    const role = schema instanceof Schemas.OfUnion.Data ? "branches" : "parts";
    return new Bindings.State(present(named), new Map([["members", members([parameters, [role, schema.properties.values()]])]]));
  }
  if (schema instanceof Schemas.OfIndexed.Data) {
    return new Bindings.State(present([...named, ["extent", Modules._extent(schema.extent)]]),
      new Map([["members", members([parameters])], ["types", types([["item", schema.item], ["key", schema.key]])]]));
  }
  if (schema instanceof Schemas.OfApply.Data) {
    const args = Modules._arguments(schema.arguments);
    return new Bindings.State(present([...named, ["arguments", args.length > 0 ? args : null]]),
      new Map([["members", members([parameters])], ["types", types([["of", schema.of]])]]));
  }
  if (schema instanceof Schemas.OfRelation.Data) {
    const values = present([...named, ["links", [...schema.links]],
      ["uniques", schema.uniques.length > 0 ? schema.uniques.map((unique) => [...unique].sort()) : null]]);
    return new Bindings.State(values, new Map([["members", members([parameters, ["properties", schema.properties.values()]])]]));
  }
  if (schema instanceof Schemas.OfAdjacency.Data) {
    return new Bindings.State(present([...named, ["me", schema.me]]), new Map([["types", types([["relation", schema.relation]])]]));
  }
  return new Bindings.State(present(named), new Map([["types", types([["type", schema.type]])]])); // a property, member or parameter
}

// --- Making: an instance from a state ---

/** The members of a state, by role, each role's in order of index. */
function grouped(state: Bindings.State): Map<string, any[]> {
  const groups = new Map<string, unknown[]>();
  for (const entry of state.entries.get("members") ?? []) {
    const role = entry.properties.get("role") as string;
    if (!groups.has(role)) groups.set(role, []);
    (groups.get(role) as unknown[])[Number(entry.properties.get("index"))] = entry.links.get("member");
  }
  return new Map([...groups].map(([role, slots]) => [role, slots.filter((member) => member !== undefined)]));
}

function typedBy(state: Bindings.State): Map<string, any> {
  return new Map((state.entries.get("types") ?? []).map((entry) => [entry.properties.get("role") as string, entry.links.get("type")]));
}

function byName<M extends { name: string }>(group: readonly M[] | undefined): Map<string, M> {
  return new Map((group ?? []).map((member) => [member.name, member]));
}

/** Reads values' module forms, which name no schema. */
const READER = new Modules._Reader(null as never, []);

function make(data: unknown): (state: Bindings.State) => any {
  return (state) => {
    const [values, groups, roles] = [state.values, grouped(state), typedBy(state)];
    const named = { name: (values.get("name") as string | undefined) ?? null, description: (values.get("description") as string | undefined) ?? null };
    const parameters = byName(groups.get("parameters"));
    const plain = new Map([...values]) as unknown as PlainMap;
    if (data === Schemas.OfNative.Data) {
      const token = new Schemas.OfNative.Token(values.get("format") as string, values.get("token") as string);
      return new Schemas.OfNative.Data(token, { bits: READER.slot(plain, "bits"), bytes: READER.slot(plain, "bytes"), parameters, ...named });
    }
    if (data === Schemas.OfObject.Data) {
      return new Schemas.OfObject.Data({ properties: byName(groups.get("properties")), adjacencies: byName(groups.get("adjacencies")),
        singleton: (values.get("singleton") as string | undefined) ?? null, ref: (values.get("ref") as boolean | undefined) ?? false, parameters, ...named });
    }
    if (data === Schemas.OfUnion.Data) return new Schemas.OfUnion.Data({ branches: groups.get("branches") ?? [], parameters, ...named });
    if (data === Schemas.OfIntersection.Data) return new Schemas.OfIntersection.Data({ parts: groups.get("parts") ?? [], parameters, ...named });
    if (data === Schemas.OfIndexed.Data) {
      return new Schemas.OfIndexed.Data({ item: roles.get("item") ?? null, key: roles.get("key") ?? null,
        extent: READER.extent((values.get("extent") as PlainMap | undefined) ?? null), parameters, ...named });
    }
    if (data === Schemas.OfApply.Data) {
      return new Schemas.OfApply.Data({ of: roles.get("of") ?? null,
        arguments: READER.arguments((values.get("arguments") as PlainMap[] | undefined) ?? []), parameters, ...named });
    }
    if (data === Schemas.OfRelation.Data) {
      return new Schemas.OfRelation.Data({ links: values.get("links") as string[], properties: byName(groups.get("properties")),
        uniques: ((values.get("uniques") as string[][] | undefined) ?? []).map((unique) => new Set(unique)), parameters, ...named });
    }
    if (data === Schemas.OfAdjacency.Data) {
      return new Schemas.OfAdjacency.Data({ name: values.get("name") as string, relation: roles.get("relation") ?? null,
        me: values.get("me") as string, description: named.description });
    }
    return new (data as typeof Schemas.OfProperty.Data)({ name: values.get("name") as string, type: roles.get("type") ?? null,
      description: named.description });
  };
}

function assign(made: (state: Bindings.State) => any): (instance: any, state: Bindings.State) => any {
  return (instance, state) => Object.assign(instance, made(state));
}

// --- The catalog ---

let catalogs = 0;

/** The schemas a store of schemas holds, in order: its one singleton, from which its data is reached. */
export class Catalog {
  /** The catalog's meta-schema. */
  static Schema: Schemas.OfObject.Data;
  schemas: unknown[];
  readonly #identity = `catalog ${++catalogs}`;

  constructor(schemas: Iterable<unknown> = []) {
    this.schemas = [...schemas];
  }

  identity(): string {
    return this.#identity;
  }

  schema_name(): string {
    return CATALOG;
  }

  owner(): null {
    return null;
  }

  accept(visitor: ObjectVisitor): void {
    Bindings.accept(CATALOG_BINDING, this, visitor);
  }
}

function readCatalog(catalog: Catalog): Bindings.State {
  return new Bindings.State(new Map(), new Map([["schemas", catalog.schemas.map((schema, index) =>
    new Bindings.Entry(new Map([["schema", schema]]), new Map([["index", BigInt(index)]])))]]));
}

function listed(state: Bindings.State): unknown[] {
  const slots: unknown[] = [];
  for (const entry of state.entries.get("schemas") ?? []) slots[Number(entry.properties.get("index"))] = entry.links.get("schema");
  return slots.filter((schema) => schema !== undefined);
}

const CatalogSchema = new Schemas.OfObject.Builder().name(CATALOG).ref().singleton(CATALOG).relations(
  (r) => r.name("schemas").of(Listed).me("catalog")).create();
const CATALOG_BINDING = new Bindings.Binding(CatalogSchema, readCatalog, (state) => new Catalog(listed(state)),
  (catalog: Catalog, state) => Object.assign(catalog, { schemas: listed(state) }));
Catalog.Schema = CatalogSchema;

export const BINDINGS = new Map([...META].map(([data, schema]) =>
  [data, new Bindings.Binding(schema, read, make(data), assign(make(data)), { implied: ["owners", "users", "listed"] })]));

Schemas._REFLECTION.accept = (schema, visitor) => Bindings.accept(BINDINGS.get((schema as object).constructor) as Bindings.Binding,
  schema, visitor as ObjectVisitor);
for (const [data, schema] of META) Schemas._REFLECTION.names.set(data, schema.name as string);

/** A store whose objects are `schemas` and the schemas and elements they hold, listed in order by its catalog,
 * `store.singleton("Schemas.Catalog")`. */
export function store(schemas: Iterable<unknown> = []): Bindings.OfStore {
  const built = new Bindings.OfStore([
    [CatalogSchema, (instance?: unknown) => new Bindings.Builder(CATALOG_BINDING, instance)],
    ...[...META].map(([data, schema]) => [schema, (instance?: unknown) => new Bindings.Builder(BINDINGS.get(data) as Bindings.Binding, instance)] as const),
  ], [Members, Types, Listed]);
  (built.singleton(CATALOG) as unknown as Catalog).schemas = [...schemas];
  return built;
}
