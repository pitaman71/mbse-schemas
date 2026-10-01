/**
 * Modules: schemas as data.
 *
 * A module is a named set of schemas, held by an object of the meta-schema `Schemas.Module.Schema`, which is
 * registered as 'Schemas.Module'. `module(schemas)` returns such an object for schemas given by name, and
 * `schemas(module)` the schemas a module holds, so that schemas are written, read, validated and compared like any
 * other objects:
 *
 *     const text = JSON.ToJSON(Schemas.Module.Schema, Modules.module(new Map([["Contact", Contact], ["Phone", Phone]])));
 *     const schemas = Modules.schemas(JSON.FromJSON(Proxies.Builders)(Schemas.Module.Schema, text));
 *
 * Within a module, each schema is written inline, as a value object of its kind, and refers to another schema by name
 * when that one is in the module or registered, so shared and recursive schemas are written once. A name resolves
 * within the module, then in the registry. A schema that refers to itself must be named.
 *
 * The translation goes through plain data, the form `Plain`, `JSON` and `YAML` share: `module` decodes the plain form
 * of the schemas, with the given builders, and `schemas` reads the plain form of the module.
 */

import { LookupError, ValueError } from "./Errors.js";
import * as Plain from "./Plain.js";
import type { PlainData, PlainMap } from "./Plain.js";
import * as Proxies from "./Proxies.js";
import { repr, sortedStrings } from "./Repr.js";
import * as Schemas from "./Schemas.js";

export const MODULE = "Schemas.Module";
Proxies.register(MODULE, Schemas.Module.Schema);

type Schema = Schemas.OfAny.Data | Schemas.OfRelation.Data;

/** A module holding `schemas`, by name, built with `builders`. */
export function module(schemas: Map<string, Schema> | Record<string, Schema>,
  builders: Plain.Builders = Proxies.Builders as unknown as Plain.Builders): unknown {
  const named = schemas instanceof Map ? [...schemas] : Object.entries(schemas);
  const writer = new Writer(new Map(named.map(([name, schema]) => [schema as unknown, name])));
  const entries = named.map(([name, schema]) => new Map<string, PlainData>([["name", name], ["schema", writer.definition(schema)]]));
  const root = new Map<string, PlainData>([["schemas", entries]]);
  return Plain.FromPlain(builders)(Schemas.Module.Schema,
    new Map<string, PlainData>([["root", "s0"], ["objects", new Map([["s0", root]])]]));
}

/** The schemas `module` holds, by name. Names resolve within the module, then in the registry. */
export function schemas(module: unknown): Map<string, Schema> {
  const plain = Plain.ToPlain(Schemas.Module.Schema, module as never) as PlainMap;
  const root = (plain.get("objects") as PlainMap).get(plain.get("root") as string) as PlainMap;
  return new Reader((root.get("schemas") as PlainMap[] | undefined) ?? []).read();
}

// --- Schemas to plain data ---

/** A schema's plain form: a mapping from its kind to its contents, e.g. `{"native": {"format": "basic", ...}}`. */
type Definition = PlainMap;

/** Writes schemas as plain data, naming those in the module (`names`, by identity) and those registered. */
class Writer {
  /** The schemas being written inline, to refuse one that refers to itself. */
  private readonly inline = new Set<unknown>();

  constructor(private readonly names: Map<unknown, string>) {}

  private nameOf(schema: unknown): string | null {
    const name = this.names.get(schema);
    if (name !== undefined) return name;
    try {
      return Proxies.name_of(schema as never);
    } catch {
      return null; // name_of throws only LookupError, for a schema not registered
    }
  }

  /** A type or a relation, by name if it has one, else inline. */
  reference(schema: unknown): Definition {
    const name = this.nameOf(schema);
    return name !== null ? new Map([["named", new Map([["name", name]])]]) : this.definition(schema);
  }

  /** A schema written inline. */
  definition(schema: unknown): Definition {
    if (this.inline.has(schema)) throw new ValueError("a schema that refers to itself must be named, in the module or the registry");
    this.inline.add(schema);
    try {
      return this.contents(schema);
    } finally {
      this.inline.delete(schema);
    }
  }

  private members(members: Iterable<readonly [string, unknown]>): PlainMap[] {
    return [...members].map(([name, schema]) => new Map<string, PlainData>([["name", name], ["type", this.reference(schema)]]));
  }

  private contents(schema: unknown): Definition {
    if (schema instanceof Schemas.OfNative.Data) {
      if (!(schema.token instanceof Schemas.OfNative.Token)) throw new TypeError(`unsupported native type ${repr(schema.token)}`);
      return kindOf("native", [["format", schema.token.format], ["name", schema.token.name], ["bits", schema.bits],
        ["bytes", schema.bytes]]);
    }
    if (schema instanceof Schemas.OfObject.Data) {
      const adjacencies = [...schema.adjacencies].map(([name, adjacency]) => new Map<string, PlainData>([["name", name],
        ["relation", this.reference(adjacency.relation)], ["me", adjacency.me]]));
      return kindOf("object", [["properties", this.members(schema.properties)], ["adjacencies", adjacencies],
        ["singleton", schema.singleton], ["ref", schema.ref]]);
    }
    if (schema instanceof Schemas.OfRelation.Data) {
      return kindOf("relation", [["links", [...schema.links]], ["properties", this.members(schema.properties)],
        ["uniques", schema.uniques.map((unique) => sortedStrings(unique))]]);
    }
    if (schema instanceof Schemas.OfUnion.Data) {
      return kindOf("union", [["branches", this.members(schema.branches.map((b) => [b.name, b.type] as const))]]);
    }
    if (schema instanceof Schemas.OfIntersection.Data) {
      return kindOf("intersection", [["parts", this.members(schema.parts.map((p) => [p.name, p.type] as const))]]);
    }
    if (schema instanceof Schemas.OfIndexed.Data) {
      const extent = schema.extent === null ? null : new Map<string, PlainData>(
        ([["minimum", schema.extent.minimum], ["maximum", schema.extent.maximum]] as [string, PlainData][]).filter(([, v]) => v !== null));
      return kindOf("indexed", [["item", this.reference(schema.item)],
        ["key", schema.key === null ? null : this.reference(schema.key)], ["extent", extent]]);
    }
    throw new TypeError(`not a schema: ${repr(schema)}`);
  }
}

/** A schema's plain form, leaving out what is absent, false or empty, as a reader assumes. */
function kindOf(kind: string, contents: [string, PlainData][]): Definition {
  const written = contents.filter(([, value]) => value !== null && value !== false && !(Array.isArray(value) && value.length === 0));
  return new Map([[kind, new Map(written)]]);
}

// --- Plain data to schemas ---

const BLANK: Record<string, () => Schema> = {
  native: () => new Schemas.OfNative.Data(),
  object: () => new Schemas.OfObject.Data(),
  relation: () => new Schemas.OfRelation.Data(),
  union: () => new Schemas.OfUnion.Data(),
  intersection: () => new Schemas.OfIntersection.Data(),
  indexed: () => new Schemas.OfIndexed.Data(),
};

/** A schema's kind and contents; a module's union values hold exactly one branch. */
function contentsOf(definition: Definition): [string, PlainMap] {
  return [...definition][0] as [string, PlainMap];
}

/** Reads the schemas of a module's plain entries. Each named schema is created first, so that references to it,
 * recursive ones included, resolve to it. */
class Reader {
  private readonly defined = new Map<string, Schema>();

  constructor(private readonly entries: PlainMap[]) {}

  read(): Map<string, Schema> {
    for (const entry of this.entries) {
      const name = entry.get("name") as string;
      if (this.defined.has(name)) throw new ValueError(`the module defines ${repr(name)} twice`);
      this.defined.set(name, (BLANK[contentsOf(entry.get("schema") as Definition)[0]] as () => Schema)());
    }
    for (const entry of this.entries) this.fill(this.defined.get(entry.get("name") as string) as Schema, entry.get("schema") as Definition);
    return new Map(this.defined);
  }

  private named(name: string): Schema {
    const found = this.defined.get(name);
    if (found !== undefined) return found;
    try {
      return Proxies.registered(name);
    } catch {
      throw new LookupError(`no schema named ${repr(name)} in the module or the registry`); // registered throws only LookupError
    }
  }

  private type(definition: Definition): Schemas.OfAny.Data {
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

  private members(members: PlainData | undefined): [string, Schemas.OfAny.Data][] {
    return ((members as PlainMap[] | undefined) ?? []).map((m) => [m.get("name") as string, this.type(m.get("type") as Definition)]);
  }

  /** Writes the contents of `definition` into `schema`, a blank schema of its kind, and returns it. */
  private fill(schema: Schema, definition: Definition): Schema {
    const [, body] = contentsOf(definition);
    const list = (key: string) => (body.get(key) as PlainData[] | undefined) ?? [];
    if (schema instanceof Schemas.OfNative.Data) {
      schema.token = new Schemas.OfNative.Token(body.get("format") as string, body.get("name") as string);
      schema.bits = (body.get("bits") as bigint | undefined) ?? null;
      schema.bytes = (body.get("bytes") as bigint | undefined) ?? null;
    } else if (schema instanceof Schemas.OfObject.Data) {
      schema.properties = new Map(this.members(body.get("properties")));
      schema.adjacencies = new Map((list("adjacencies") as PlainMap[]).map((a) => [a.get("name") as string,
        new Schemas.OfAdjacency.Data({ name: a.get("name") as string, relation: this.relation(a.get("relation") as Definition),
          me: a.get("me") as string })]));
      schema.singleton = (body.get("singleton") as string | undefined) ?? null;
      schema.ref = (body.get("ref") as boolean | undefined) ?? false;
    } else if (schema instanceof Schemas.OfRelation.Data) {
      schema.links = list("links") as string[];
      schema.properties = new Map(this.members(body.get("properties")));
      schema.uniques = (list("uniques") as string[][]).map((unique) => new Set(unique));
    } else if (schema instanceof Schemas.OfUnion.Data) {
      schema.branches = this.members(body.get("branches")).map(([name, type]) => new Schemas.OfUnion.Branch({ name, type }));
    } else if (schema instanceof Schemas.OfIntersection.Data) {
      schema.parts = this.members(body.get("parts")).map(([name, type]) => new Schemas.OfIntersection.Part({ name, type }));
    } else {
      const indexed = schema as Schemas.OfIndexed.Data;
      indexed.item = this.type(body.get("item") as Definition);
      indexed.key = body.has("key") ? this.type(body.get("key") as Definition) : null;
      const extent = body.get("extent") as PlainMap | undefined;
      indexed.extent = extent === undefined ? null
        : new Schemas.OfIndexed.Extent((extent.get("minimum") as bigint | undefined) ?? 0n, (extent.get("maximum") as bigint | undefined) ?? null);
    }
    return schema;
  }
}
