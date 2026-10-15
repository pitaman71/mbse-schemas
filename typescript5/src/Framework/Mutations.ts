/**
 * Mutations: the schemas of a mutation log (docs/SERIALIZATION.md, Mutations : Vocabulary).
 *
 * The wire format is a log of mutations, and mutations are schema-governed like everything else: each verb and noun
 * here is a schema, every store holds them, and ToPlain writes a log as it writes any value.
 *
 * Every mutation is a value object: a log entry has no identity and is never shared. Each family of verbs is a union
 * whose branches are its verbs, named as a visitor's members are (`AsProperty` is `as_property`), so that a verb is
 * written as its union's branch (`{"exists": {...}}`), and a list of verbs is a container of that union. A noun (`Ref`,
 * `Def`, `Slice`) is a value object nested in a verb.
 *
 * *Reference verbs* (`OfObject`, `OfRelation`) are the top level of the log (`Log`, a list of `Reference`); *value
 * verbs* are nested in them, following a path from the reference object a top-level verb names (`OfObject.AsProperty`'s
 * `ref`). A verb nested under `OfAny.AsObject` names no reference object. `OfContainer.AsItems` and
 * `OfRelation.AsEntries` apply their lists in modulo order.
 *
 * Payloads (a property's value, an object's properties) are values of whatever schema the target gives: their type here
 * is a value of any type, and ToPlain writes them untyped, interpreted by the target's schema.
 *
 * The schemas are built with the builders, and every store, built by Builders.ts, holds them; each module imports the
 * other. Builders.ts builds them through `_build` once its builders exist, handing it the builders, whichever module is
 * imported first; this one imports Builders.ts only for that. Until then each export, declared with `var` so that
 * `_build` can assign it before this module's body runs, is `undefined`, which no importer sees.
 */

import "./Builders.js"; // which builds the schemas below
import type * as Builders from "./Builders.js";
import type * as S from "./Schemas.js";

type ObjectData = S.OfObject.Data;
type UnionData = S.OfUnion.Data;

/* eslint-disable no-var */
/** Untyped: interpreted by the target's schema. */
export var Payload: S.OfAny.Value;

// --- Nouns ---
export var Ref: ObjectData; // identity only: "Module.Schema/ID"
export var Def: ObjectData;
export var Slice: ObjectData;

// --- The unions of verbs, each referring to the others ---
export var Reference: UnionData; // the top level of the log: OfObject's and OfRelation's verbs
export var OfProperty: UnionData;
export var OfContainer: UnionData;
export var OfAny: UnionData;
export var OfScalar: UnionData;
export var OfLink: UnionData;
export var OfEntryMember: UnionData; // an entry's mutations: its properties' and its links'

// --- Value verbs ---
export var PropertySet: ObjectData;
export var PropertyClear: ObjectData;
export var PropertyAsAny: ObjectData;
export var ContainerInsert: ObjectData;
export var ContainerRemove: ObjectData;
export var ContainerAppend: ObjectData;
export var ContainerPrepend: ObjectData;
export var ContainerClear: ObjectData;
export var AsItems: ObjectData;
export var AnySet: ObjectData;
export var AnyClear: ObjectData;
export var AsScalar: ObjectData;
export var AsContainer: ObjectData;
export var ScalarSet: ObjectData;
export var ScalarClear: ObjectData;
export var AsBranch: ObjectData;
export var AsPart: ObjectData;
export var AsUnion: ObjectData;
export var AsIntersection: ObjectData;
export var LinkSet: ObjectData;
export var LinkClear: ObjectData;

// --- Reference verbs, and what an object's or an entry's mutations are ---
export var Exists: ObjectData;
export var AsProperty: ObjectData;
export var AsObject: ObjectData;
export var EntryAsProperty: ObjectData;
export var EntryAsLink: ObjectData;
export var Entry: ObjectData;
export var RelationInsert: ObjectData;
export var RelationRemove: ObjectData;
export var RelationClear: ObjectData;
export var AsEntries: ObjectData;

export var Log: S.OfContainer.Data;

/** The named mutation schemas, which every store holds. */
export var SCHEMAS: readonly (ObjectData | UnionData | S.OfContainer.Data)[];
/* eslint-enable no-var */

type Spec = (t: any) => any;

/** What `_build` builds with: the builders, and the basic scalars. */
interface Kit {
  AnyValueBuilder: typeof Builders.AnyValueBuilder;
  ContainerBuilder: typeof Builders.ContainerBuilder;
  Meta: typeof Builders.Meta;
  ObjectBuilder: typeof Builders.ObjectBuilder;
  UnionBuilder: typeof Builders.UnionBuilder;
}

// eslint-disable-next-line no-var
var kit: Kit;

function list(element: unknown): S.OfContainer.Data {
  return new kit.ContainerBuilder().index([kit.Meta.OfInt]).element([element]).create();
}

/** A verb or a noun, `Mutations.<name>`: a value object of `properties`, each naming one and giving its type. */
function verb(name: string, ...properties: Spec[]): ObjectData {
  return new kit.ObjectBuilder().name(`Mutations.${name}`).properties(properties).create();
}

/** A verb's nested mutations: a list of `of`. */
function mutations(of: unknown): Spec {
  return (t: any) => t.name("mutations").type([list(of)]);
}

function text(name: string): Spec {
  return (t: any) => t.name(name).type([kit.Meta.OfStr]);
}

function union(name: string): UnionData {
  return new kit.UnionBuilder().name(`Mutations.${name}`).create();
}

/** Gives the union `of` its branches, `members`: each a name and the verb it holds. */
function branches(of: UnionData, members: [string, unknown][]): void {
  new kit.UnionBuilder(of).branches(members.map(([name, type]) => (t: any) => t.name(name).type([type]))).update();
}

/** Builds the mutation schemas with `builders`; Builders.ts calls it, once, when they exist. */
export function _build(builders: Kit): void {
  kit = builders;
  const { AnyValueBuilder, ContainerBuilder, Meta } = builders;
  const Int = Meta.OfInt;
  Payload = new AnyValueBuilder().create();

  Ref = verb("OfObject.Ref", text("key"));
  Def = verb(
    "OfObject.Def",
    text("key"), // "Module.Schema/ID": the schema reference and the identity
    (t) => t.name("properties").type([new ContainerBuilder().index([Meta.OfStr]).element([Payload]).create()]),
  );
  Slice = verb(
    "OfContainer.Slice",
    (t) => t.name("index").type([Payload]), // where the section starts, by the container's index
    (t) => t.name("items").type([list(Payload)]),
  );

  Reference = union("Reference");
  OfProperty = union("OfProperty");
  OfContainer = union("OfContainer");
  OfAny = union("OfAny");
  OfScalar = union("OfScalar");
  OfLink = union("OfLink");
  OfEntryMember = union("OfEntry.Member");

  PropertySet = verb("OfProperty.Set", (t) => t.name("value").type([Payload]));
  PropertyClear = verb("OfProperty.Clear");
  PropertyAsAny = verb("OfProperty.AsAny", mutations(OfAny));
  ContainerInsert = verb("OfContainer.Insert", (t) => t.name("slice").type([Slice]));
  ContainerRemove = verb( // a section, by its start and its length
    "OfContainer.Remove",
    (t) => t.name("index").type([Payload]),
    (t) => t.name("count").type([Int]),
  );
  ContainerAppend = verb("OfContainer.Append", (t) => t.name("items").type([list(Payload)]));
  ContainerPrepend = verb("OfContainer.Prepend", (t) => t.name("items").type([list(Payload)]));
  ContainerClear = verb("OfContainer.Clear");
  AsItems = verb("OfContainer.AsItems", mutations(OfAny)); // applied in modulo order
  AnySet = verb("OfAny.Set", (t) => t.name("value").type([Payload]));
  AnyClear = verb("OfAny.Clear");
  AsScalar = verb("OfAny.AsScalar", mutations(OfScalar));
  AsContainer = verb("OfAny.AsContainer", mutations(OfContainer));
  ScalarSet = verb("OfScalar.Set", (t) => t.name("value").type([Payload]));
  ScalarClear = verb("OfScalar.Clear");
  AsBranch = verb("OfUnion.AsBranch", text("name"), mutations(OfProperty));
  AsPart = verb("OfIntersection.AsPart", text("name"), mutations(OfProperty));
  AsUnion = verb("OfAny.AsUnion", mutations(AsBranch));
  AsIntersection = verb("OfAny.AsIntersection", mutations(AsPart));
  LinkSet = verb("OfLink.Set", (t) => t.name("ref").type([Ref]));
  LinkClear = verb("OfLink.Clear");

  Exists = verb("OfObject.Exists", (t) => t.name("definition").type([Def])); // as Python, which cannot spell `def`
  AsProperty = verb( // `ref` at the top of the log only: nested under OfAny.AsObject, the path gives the object
    "OfObject.AsProperty",
    (t) => t.name("ref").type([Ref]),
    text("name"),
    mutations(OfProperty),
  );
  AsObject = verb("OfAny.AsObject", mutations(AsProperty));
  EntryAsProperty = verb("OfEntry.AsProperty", text("name"), mutations(OfProperty));
  EntryAsLink = verb("OfEntry.AsLink", text("name"), mutations(OfLink));
  Entry = verb("OfEntry", mutations(OfEntryMember)); // an entry: its links' and its properties' mutations
  RelationInsert = verb(
    "OfRelation.Insert",
    (t) => t.name("relation").type([Ref]), // the relation schema
    (t) => t.name("entries").type([list(Entry)]),
  );
  RelationRemove = verb(
    "OfRelation.Remove",
    (t) => t.name("relation").type([Ref]),
    (t) => t.name("entries").type([list(Entry)]),
  );
  RelationClear = verb("OfRelation.Clear", (t) => t.name("ref").type([Ref]), text("adjacency"));
  AsEntries = verb( // applied in modulo order
    "OfRelation.AsEntries",
    (t) => t.name("ref").type([Ref]),
    text("adjacency"),
    mutations(EntryAsProperty),
  );

  // --- The unions' branches ---

  branches(Reference, [["exists", Exists], ["as_property", AsProperty], ["insert", RelationInsert],
    ["remove", RelationRemove], ["clear", RelationClear], ["as_entries", AsEntries]]);
  branches(OfProperty, [["set", PropertySet], ["clear", PropertyClear], ["as_any", PropertyAsAny]]);
  branches(OfContainer, [["insert", ContainerInsert], ["remove", ContainerRemove], ["append", ContainerAppend],
    ["prepend", ContainerPrepend], ["clear", ContainerClear], ["as_items", AsItems]]);
  branches(OfAny, [["set", AnySet], ["clear", AnyClear], ["as_scalar", AsScalar], ["as_container", AsContainer],
    ["as_object", AsObject], ["as_union", AsUnion], ["as_intersection", AsIntersection]]);
  branches(OfScalar, [["set", ScalarSet], ["clear", ScalarClear]]);
  branches(OfLink, [["set", LinkSet], ["clear", LinkClear]]);
  branches(OfEntryMember, [["as_property", EntryAsProperty], ["as_link", EntryAsLink]]);
  Log = new ContainerBuilder().name("Mutations.Log").index([Int]).element([Reference]).create();

  SCHEMAS = [Ref, Def, Slice, Reference, OfProperty, OfContainer, OfAny, OfScalar, OfLink, OfEntryMember, PropertySet,
    PropertyClear, PropertyAsAny, ContainerInsert, ContainerRemove, ContainerAppend, ContainerPrepend, ContainerClear,
    AsItems, AnySet, AnyClear, AsScalar, AsContainer, ScalarSet, ScalarClear, AsBranch, AsPart, AsUnion, AsIntersection,
    LinkSet, LinkClear, Exists, AsProperty, AsObject, EntryAsProperty, EntryAsLink, Entry, RelationInsert,
    RelationRemove, RelationClear, AsEntries, Log];
}
