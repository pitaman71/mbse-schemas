/**
 * Modules: schemas as data.
 *
 * A module is a set of named schemas, held by an object of the meta-schema `Schemas.Module.Schema`, which every proxy
 * store registers as 'Schemas.Module'. `module(store, schemas)` returns such an object, built in `store`, and
 * `schemas(store, module)` the schemas a module holds, by name, so that schemas are written, read, validated and
 * compared like any other objects:
 *
 *     const text = JSON.ToJSON(store)(Schemas.Module.Schema, Modules.module(store, [Contact, Phone]));
 *     const schemas = Modules.schemas(store, JSON.FromJSON(store)(Schemas.Module.Schema, text));
 *
 * Within a module, each schema is an entry, its name and its definition, inline, as a value object of its kind. A
 * schema refers to a named schema by its name, so shared and recursive schemas are written once, and writes an unnamed
 * one inline. A name resolves within the module, then in the store. A schema that refers to itself must be named.
 *
 * `reference(schema)` and `resolve(store, definition)` translate one type the same way, for data that refers to
 * schemas as a module's members do, e.g. the symbols of a predicate.
 *
 * A term (where a width, an extent's bound or an argument stands) is written as its neutral form, `Schemas.Form`, and
 * read back as one; `make`, given to `schemas` or `resolve`, makes a dialect's term of each form instead.
 *
 * The translation goes through plain data, the form `Plain`, `JSON` and `YAML` share: `module` decodes the plain form
 * of the schemas in the store, and `schemas` reads the plain form of the module.
 */

import { LookupError, ValueError } from "./Errors.js";
import * as Plain from "./Plain.js";
import type { PlainData, PlainMap } from "./Plain.js";
import { repr, sortedStrings } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type * as Stores from "./Stores.js";
import type { Native } from "./Visitors.js";

export const MODULE = "Schemas.Module";

type Schema = Schemas.OfAny.Data | Schemas.OfRelation.Data;

/** A module holding `schemas`, each under its name, built in `store`. */
export function module(store: Stores.Store, schemas: Iterable<Schema>): unknown {
  const named = [...schemas];
  if (named.some((schema) => schemaName(schema) === null)) {
    throw new ValueError("a module holds named schemas; name each with its builder's .name()");
  }
  const writer = new Writer();
  const entries = named.map((schema) => new Map<string, PlainData>([["name", schemaName(schema)], ["schema", writer.definition(schema)]]));
  const root = new Map<string, PlainData>([["schemas", entries]]);
  return Plain.FromPlain(store)(Schemas.Module.Schema,
    new Map<string, PlainData>([["root", "s0"], ["objects", new Map([["s0", root]])]]));
}

/** Makes a term of a `Schemas.Form` read from a module, e.g. a dialect's. */
export type Make = (form: Schemas.Form.Data) => unknown;

/** The schemas `module` holds, by name. Names resolve within the module, then in `store`. Terms are read as forms, or
 * made by `make`. */
export function schemas(store: Stores.Store, module: unknown, make: Make | null = null): Map<string, Schema> {
  const plain = Plain.ToPlain(store)(Schemas.Module.Schema, module as never) as PlainMap;
  const root = (plain.get("objects") as PlainMap).get(plain.get("root") as string) as PlainMap;
  return new _Reader(store, (root.get("schemas") as PlainMap[] | undefined) ?? [], make).read();
}

/** The plain form of a type (`Schemas.OfAny.Schema`'s): `{"named": {"name": ...}}` for a named schema, else the
 * schema inline. */
export function reference(schema: unknown): PlainMap {
  return new Writer().reference(schema);
}

/** A schema's name, or null for an unnamed schema or anything else. */
function schemaName(schema: unknown): string | null {
  const name = (schema as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : null;
}

/** The type a plain form describes: a name resolves in `store`, and an inline schema is read. */
export function resolve(store: Stores.Store, definition: PlainMap, make: Make | null = null): Schemas.OfAny.Data {
  return new _Reader(store, [], make).type(definition);
}

// --- Schemas to plain data ---

/** A schema's plain form: a mapping from its kind to its contents, e.g. `{"native": {"format": "basic", ...}}`. */
type Definition = PlainMap;

/** Writes schemas as plain data, referring to named schemas by name. */
class Writer {
  /** The schemas being written inline, to refuse one that refers to itself. */
  private readonly inline = new Set<unknown>();

  /** A type or a relation, by name if it has one, else inline. */
  reference(schema: unknown): Definition {
    const name = schemaName(schema);
    return name !== null ? new Map([["named", new Map([["name", name]])]]) : this.definition(schema);
  }

  /** A schema written inline. */
  definition(schema: unknown): Definition {
    if (this.inline.has(schema)) throw new ValueError("a schema that refers to itself must be named");
    this.inline.add(schema);
    try {
      return this.contents(schema);
    } finally {
      this.inline.delete(schema);
    }
  }

  /** Properties, branches, parts or parameters: each its name, its type (a parameter may have none) and its
   * description, if any. */
  private members(members: Iterable<{ name: string; type: unknown; description: string | null }>): PlainMap[] {
    return [...members].map((m) => present([["name", m.name], ["type", m.type === null ? null : this.reference(m.type)],
      ["description", m.description]]));
  }

  private contents(schema: unknown): Definition {
    const declared = (schema as { parameters?: unknown } | null)?.parameters;
    const parameters = declared instanceof Map ? this.members(declared.values()) : [];
    if (schema instanceof Schemas.OfNative.Data) {
      if (!(schema.token instanceof Schemas.OfNative.Token)) throw new TypeError(`unsupported native type ${repr(schema.token)}`);
      return kindOf("native", [["parameters", parameters], ["format", schema.token.format], ["name", schema.token.name],
        ["bits", _literal(schema.bits)], ["bytes", _literal(schema.bytes)],
        ["terms", _terms([["bits", schema.bits], ["bytes", schema.bytes]])], ["description", schema.description]]);
    }
    if (schema instanceof Schemas.OfObject.Data) {
      const adjacencies = [...schema.adjacencies].map(([name, adjacency]) => present([["name", name],
        ["relation", this.reference(adjacency.relation)], ["me", adjacency.me], ["description", adjacency.description]]));
      return kindOf("object", [["parameters", parameters], ["properties", this.members(schema.properties.values())],
        ["adjacencies", adjacencies], ["singleton", schema.singleton], ["ref", schema.ref], ["description", schema.description]]);
    }
    if (schema instanceof Schemas.OfRelation.Data) {
      return kindOf("relation", [["parameters", parameters], ["links", [...schema.links]],
        ["properties", this.members(schema.properties.values())],
        ["uniques", schema.uniques.map((unique) => sortedStrings(unique))], ["description", schema.description]]);
    }
    if (schema instanceof Schemas.OfUnion.Data) {
      return kindOf("union", [["parameters", parameters], ["branches", this.members(schema.branches)],
        ["description", schema.description]]);
    }
    if (schema instanceof Schemas.OfIntersection.Data) {
      return kindOf("intersection", [["parameters", parameters], ["parts", this.members(schema.parts)],
        ["description", schema.description]]);
    }
    if (schema instanceof Schemas.OfIndexed.Data) {
      return kindOf("indexed", [["parameters", parameters], ["item", this.reference(schema.item)],
        ["key", schema.key === null ? null : this.reference(schema.key)], ["extent", _extent(schema.extent)],
        ["description", schema.description]]);
    }
    if (schema instanceof Schemas.OfApply.Data) {
      return kindOf("apply", [["parameters", parameters], ["of", this.reference(schema.of)], ["arguments", _arguments(schema.arguments)],
        ["description", schema.description]]);
    }
    throw new TypeError(`not a schema: ${repr(schema)}`);
  }
}

/** An extent's plain form: its int bounds, and the terms that stand for the others; null for none. */
export function _extent(extent: Schemas.OfIndexed.Extent | null): PlainMap | null {
  if (extent === null) return null;
  return present([["minimum", _literal(extent.minimum)], ["maximum", _literal(extent.maximum)],
    ["terms", _terms([["minimum", extent.minimum], ["maximum", extent.maximum]])]]);
}

/** An application's arguments' plain form, in order. */
export function _arguments(args: ReadonlyMap<string, unknown>): PlainMap[] {
  return [...args].map(([name, value]) => argument(name, value));
}

/** A width or a bound, where it is not a term. */
export function _literal(value: unknown): PlainData {
  return Schemas.Form.is_term(value) ? null : value as PlainData;
}

/** The forms of the slots that hold terms, by slot; null if none does. */
export function _terms(slots: [string, unknown][]): PlainMap | null {
  const held = slots.filter(([, value]) => Schemas.Form.is_term(value));
  return held.length === 0 ? null : new Map(held.map(([slot, value]) => [slot, form(value)]));
}

/** A term's plain form: its neutral form, `Schemas.Form.Schema`'s. */
function form(term: unknown): PlainMap {
  const neutral = Schemas.Form.of(term);
  return present([["dialect", neutral.dialect], ["kind", neutral.kind],
    ["attributes", [...neutral.attributes].map(([name, value]) => new Map<string, PlainData>([["name", name],
      ["value", native(value, `attribute ${repr(name)} of a term`)]]))],
    ["arguments", neutral.arguments.map((argument) => form(argument))]]);
}

/** A native value's plain form, as a `Schemas.Form.Value`: its basic type's branch, e.g. `{"int": 3}`. */
function native(value: unknown, what: string): PlainMap {
  const host = Schemas.NATIVE_TYPES.find((token) => Schemas.isNativeOf(token, value));
  if (host === undefined) throw new TypeError(`${what} is not a native value: ${repr(value)}`);
  const schema = new Schemas.OfNative.Data(host);
  return new Map([[(schema.token as Schemas.OfNative.Token).name, schema.to_plain(value)]]);
}

/** An argument's plain form: its parameter's name, and its native `value` or its `term`. */
function argument(name: string, value: unknown): PlainMap {
  if (Schemas.Form.is_term(value)) return new Map<string, PlainData>([["name", name], ["term", form(value)]]);
  return new Map<string, PlainData>([["name", name], ["value", native(value, `argument ${repr(name)}`)]]);
}

/** A schema's plain form, leaving out what is absent, false or empty, as a reader assumes. */
function kindOf(kind: string, contents: [string, PlainData][]): Definition {
  return new Map([[kind, present(contents)]]);
}

/** `contents` without what is absent, false or empty. */
function present(contents: [string, PlainData][]): PlainMap {
  return new Map(contents.filter(([, value]) => value !== null && value !== false && !(Array.isArray(value) && value.length === 0)));
}

// --- Plain data to schemas ---

const BLANK: Record<string, () => Schema> = {
  native: () => new Schemas.OfNative.Data(),
  object: () => new Schemas.OfObject.Data(),
  relation: () => new Schemas.OfRelation.Data(),
  union: () => new Schemas.OfUnion.Data(),
  intersection: () => new Schemas.OfIntersection.Data(),
  indexed: () => new Schemas.OfIndexed.Data(),
  apply: () => new Schemas.OfApply.Data(),
};

/** A schema's kind and contents; a module's union values hold exactly one branch. */
function contentsOf(definition: Definition): [string, PlainMap] {
  return [...definition][0] as [string, PlainMap];
}

/** Reads the schemas of a module's plain entries. Each named schema is created first, so that references to it,
 * recursive ones included, resolve to it. */
export class _Reader {
  private readonly defined = new Map<string, Schema>();

  constructor(private readonly store: Stores.Store, private readonly entries: PlainMap[], private readonly make: Make | null = null) {}

  read(): Map<string, Schema> {
    for (const entry of this.entries) {
      const name = entry.get("name") as string;
      if (this.defined.has(name)) throw new ValueError(`the module defines ${repr(name)} twice`);
      const blank = (BLANK[contentsOf(entry.get("schema") as Definition)[0]] as () => Schema)();
      blank.name = name;
      this.defined.set(name, blank);
    }
    for (const entry of this.entries) this.fill(this.defined.get(entry.get("name") as string) as Schema, entry.get("schema") as Definition);
    return new Map(this.defined);
  }

  private named(name: string): Schema {
    const found = this.defined.get(name);
    if (found !== undefined) return found;
    try {
      return this.store.registered(name);
    } catch {
      throw new LookupError(`no schema named ${repr(name)} in the module or the store`); // registered throws only LookupError
    }
  }

  type(definition: Definition): Schemas.OfAny.Data {
    const [kind, body] = contentsOf(definition);
    if (kind !== "named") return this.fill((BLANK[kind] as () => Schema)(), definition) as Schemas.OfAny.Data;
    const schema = this.named(body.get("name") as string);
    if (schema instanceof Schemas.OfRelation.Data) throw new TypeError(`${repr(body.get("name"))} is a relation, not a type`);
    return schema;
  }

  private relation(definition: Definition): Schemas.OfRelation.Data {
    const [kind, body] = contentsOf(definition);
    if (kind !== "named") return this.fill(new Schemas.OfRelation.Data(), definition) as Schemas.OfRelation.Data;
    const schema = this.named(body.get("name") as string);
    if (!(schema instanceof Schemas.OfRelation.Data)) throw new TypeError(`${repr(body.get("name"))} is not a relation`);
    return schema;
  }

  /** Properties, branches, parts or parameters, as `make` builds them from their name, type and description. */
  private members<M>(members: PlainData | undefined, make: (fields: { name: string; type: Schemas.OfAny.Data | null;
    description: string | null }) => M): M[] {
    return ((members as PlainMap[] | undefined) ?? []).map((m) => make({ name: m.get("name") as string,
      type: m.has("type") ? this.type(m.get("type") as Definition) : null,
      description: (m.get("description") as string | undefined) ?? null }));
  }

  /** The term a plain form describes: a form, or what `make` makes of it. */
  private term(plain: PlainMap): unknown {
    const form = this.form(plain);
    return this.make === null ? form : this.make(form);
  }

  private form(plain: PlainMap): Schemas.Form.Data {
    const attributes = ((plain.get("attributes") as PlainMap[] | undefined) ?? [])
      .map((a) => [a.get("name") as string, nativeOf(a.get("value") as PlainMap)] as [string, Native]);
    return new Schemas.Form.Data(plain.get("kind") as string, new Map(attributes),
      ((plain.get("arguments") as PlainMap[] | undefined) ?? []).map((argument) => this.form(argument)),
      (plain.get("dialect") as string | undefined) ?? null);
  }

  /** A width or a bound: its int, or the term `terms` holds for it. */
  slot(body: PlainMap, slot: string, absent: unknown = null): unknown {
    const terms = (body.get("terms") as PlainMap | undefined) ?? new Map();
    return terms.has(slot) ? this.term(terms.get(slot) as PlainMap) : body.get(slot) ?? absent;
  }

  /** Writes the contents of `definition` into `schema`, a blank schema of its kind, and returns it. */
  private fill(schema: Schema, definition: Definition): Schema {
    const [, body] = contentsOf(definition);
    const list = (key: string) => (body.get(key) as PlainData[] | undefined) ?? [];
    schema.description = (body.get("description") as string | undefined) ?? null;
    schema.parameters = new Map(this.members(body.get("parameters"), (f) => new Schemas.OfParameter.Data(f))
      .map((p) => [p.name, p]));
    const properties = () => new Map(this.members(body.get("properties"), (f) => new Schemas.OfProperty.Data(f))
      .map((p) => [p.name, p]));
    if (schema instanceof Schemas.OfNative.Data) {
      schema.token = new Schemas.OfNative.Token(body.get("format") as string, body.get("name") as string);
      schema.bits = this.slot(body, "bits");
      schema.bytes = this.slot(body, "bytes");
    } else if (schema instanceof Schemas.OfObject.Data) {
      schema.properties = properties();
      schema.adjacencies = new Map((list("adjacencies") as PlainMap[]).map((a) => [a.get("name") as string,
        new Schemas.OfAdjacency.Data({ name: a.get("name") as string, relation: this.relation(a.get("relation") as Definition),
          me: a.get("me") as string, description: (a.get("description") as string | undefined) ?? null })]));
      schema.singleton = (body.get("singleton") as string | undefined) ?? null;
      schema.ref = (body.get("ref") as boolean | undefined) ?? false;
    } else if (schema instanceof Schemas.OfRelation.Data) {
      schema.links = list("links") as string[];
      schema.properties = properties();
      schema.uniques = (list("uniques") as string[][]).map((unique) => new Set(unique));
    } else if (schema instanceof Schemas.OfUnion.Data) {
      schema.branches = this.members(body.get("branches"), (f) => new Schemas.OfUnion.Branch(f));
    } else if (schema instanceof Schemas.OfIntersection.Data) {
      schema.parts = this.members(body.get("parts"), (f) => new Schemas.OfIntersection.Part(f));
    } else if (schema instanceof Schemas.OfIndexed.Data) {
      schema.item = this.type(body.get("item") as Definition);
      schema.key = body.has("key") ? this.type(body.get("key") as Definition) : null;
      schema.extent = this.extent((body.get("extent") as PlainMap | undefined) ?? null);
    } else {
      const apply = schema as Schemas.OfApply.Data;
      apply.of = this.type(body.get("of") as Definition);
      apply.arguments = this.arguments(list("arguments") as PlainMap[]);
    }
    return schema;
  }

  /** The extent a plain form describes, or null. */
  extent(plain: PlainMap | null): Schemas.OfIndexed.Extent | null {
    return plain === null ? null : new Schemas.OfIndexed.Extent(this.slot(plain, "minimum", 0n), this.slot(plain, "maximum"));
  }

  /** The arguments a plain form describes, by name: native values, or terms. */
  arguments(plain: readonly PlainMap[]): Map<string, unknown> {
    return new Map(plain.map((a) => [a.get("name") as string,
      a.has("term") ? this.term(a.get("term") as PlainMap) : nativeOf(a.get("value") as PlainMap)]));
  }
}

/** The native value of a `Schemas.Form.Value`'s plain form, e.g. `{"int": 3}`. */
function nativeOf(plain: PlainMap): Native {
  const [[name, value]] = [...plain] as [[string, PlainData]];
  return new Schemas.OfNative.Data(new Schemas.OfNative.Token(Schemas.BASIC, name)).from_plain(value);
}
