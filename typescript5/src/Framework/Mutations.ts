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
 * The schemas are built with the builders, anew for each store, which holds its own (docs/SCHEMA_EXTENSION.md, Decided,
 * 23): a store calls `schemas`, handing it the builders and its basic scalars.
 */

import type * as Builders from "./Builders.js";
import type * as S from "./Schemas.js";

type ObjectData = S.OfObject.Data;
type UnionData = S.OfUnion.Data;

type Spec = (t: any) => any;

/** What `schemas` builds with: the builders, and the store's basic scalars `Text` (`Schemas.OfStr`) and `Int`. */
interface Kit {
  AnyValueBuilder: typeof Builders.AnyValueBuilder;
  ContainerBuilder: typeof Builders.ContainerBuilder;
  ObjectBuilder: typeof Builders.ObjectBuilder;
  UnionBuilder: typeof Builders.UnionBuilder;
  Text: S.OfScalar.Data;
  Int: S.OfScalar.Data;
}

let kit!: Kit; // the builders `schemas` builds with, set as it begins

function list(element: unknown): S.OfContainer.Data {
  return new kit.ContainerBuilder().index([kit.Int]).element([element]).create();
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
  return (t: any) => t.name(name).type([kit.Text]);
}

function union(name: string): UnionData {
  return new kit.UnionBuilder().name(`Mutations.${name}`).create();
}

/** Gives the union `of` its branches, `members`: each a name and the verb it holds. */
function branches(of: UnionData, members: [string, unknown][]): void {
  new kit.UnionBuilder(of).branches(members.map(([name, type]) => (t: any) => t.name(name).type([type]))).update();
}

/** The mutation schemas, built anew with `builders` for a store whose basic scalars they are given: by name, each
 * `Mutations.<name>`'s local name (`Log`, `Ref`, ...). */
export function schemas(builders: Kit): Record<string, ObjectData | UnionData | S.OfContainer.Data> {
  kit = builders;
  const { AnyValueBuilder, ContainerBuilder, Int, Text } = builders;
  const Payload = new AnyValueBuilder().create();

  const Ref = verb("OfObject.Ref", text("key"));
  const Def = verb(
    "OfObject.Def",
    text("key"), // "Module.Schema/ID": the schema reference and the identity
    (t) => t.name("properties").type([new ContainerBuilder().index([Text]).element([Payload]).create()]),
  );
  const Slice = verb(
    "OfContainer.Slice",
    (t) => t.name("index").type([Payload]), // where the section starts, by the container's index
    (t) => t.name("items").type([list(Payload)]),
  );

  const Reference = union("Reference");
  const OfProperty = union("OfProperty");
  const OfContainer = union("OfContainer");
  const OfAny = union("OfAny");
  const OfScalar = union("OfScalar");
  const OfLink = union("OfLink");
  const OfEntryMember = union("OfEntry.Member");

  const PropertySet = verb("OfProperty.Set", (t) => t.name("value").type([Payload]));
  const PropertyClear = verb("OfProperty.Clear");
  const PropertyAsAny = verb("OfProperty.AsAny", mutations(OfAny));
  const ContainerInsert = verb("OfContainer.Insert", (t) => t.name("slice").type([Slice]));
  const ContainerRemove = verb( // a section, by its start and its length
    "OfContainer.Remove",
    (t) => t.name("index").type([Payload]),
    (t) => t.name("count").type([Int]),
  );
  const ContainerAppend = verb("OfContainer.Append", (t) => t.name("items").type([list(Payload)]));
  const ContainerPrepend = verb("OfContainer.Prepend", (t) => t.name("items").type([list(Payload)]));
  const ContainerClear = verb("OfContainer.Clear");
  const AsItems = verb("OfContainer.AsItems", mutations(OfAny)); // applied in modulo order
  const AnySet = verb("OfAny.Set", (t) => t.name("value").type([Payload]));
  const AnyClear = verb("OfAny.Clear");
  const AsScalar = verb("OfAny.AsScalar", mutations(OfScalar));
  const AsContainer = verb("OfAny.AsContainer", mutations(OfContainer));
  const ScalarSet = verb("OfScalar.Set", (t) => t.name("value").type([Payload]));
  const ScalarClear = verb("OfScalar.Clear");
  const AsBranch = verb("OfUnion.AsBranch", text("name"), mutations(OfProperty));
  const AsPart = verb("OfIntersection.AsPart", text("name"), mutations(OfProperty));
  const AsUnion = verb("OfAny.AsUnion", mutations(AsBranch));
  const AsIntersection = verb("OfAny.AsIntersection", mutations(AsPart));
  const LinkSet = verb("OfLink.Set", (t) => t.name("ref").type([Ref]));
  const LinkClear = verb("OfLink.Clear");

  const Exists = verb("OfObject.Exists", (t) => t.name("definition").type([Def])); // as Python, which cannot spell `def`
  const AsProperty = verb( // `ref` at the top of the log only: nested under OfAny.AsObject, the path gives the object
    "OfObject.AsProperty",
    (t) => t.name("ref").type([Ref]),
    text("name"),
    mutations(OfProperty),
  );
  const AsObject = verb("OfAny.AsObject", mutations(AsProperty));
  const EntryAsProperty = verb("OfEntry.AsProperty", text("name"), mutations(OfProperty));
  const EntryAsLink = verb("OfEntry.AsLink", text("name"), mutations(OfLink));
  const Entry = verb("OfEntry", mutations(OfEntryMember)); // an entry: its links' and its properties' mutations
  const RelationInsert = verb(
    "OfRelation.Insert",
    (t) => t.name("relation").type([Ref]), // the relation schema
    (t) => t.name("entries").type([list(Entry)]),
  );
  const RelationRemove = verb(
    "OfRelation.Remove",
    (t) => t.name("relation").type([Ref]),
    (t) => t.name("entries").type([list(Entry)]),
  );
  const RelationClear = verb("OfRelation.Clear", (t) => t.name("ref").type([Ref]), text("adjacency"));
  const AsEntries = verb( // applied in modulo order
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
  const Log = new ContainerBuilder().name("Mutations.Log").index([Int]).element([Reference]).create();

  return {
    Ref,
    Def,
    Slice,
    Reference,
    OfProperty,
    OfContainer,
    OfAny,
    OfScalar,
    OfLink,
    OfEntryMember,
    PropertySet,
    PropertyClear,
    PropertyAsAny,
    ContainerInsert,
    ContainerRemove,
    ContainerAppend,
    ContainerPrepend,
    ContainerClear,
    AsItems,
    AnySet,
    AnyClear,
    AsScalar,
    AsContainer,
    ScalarSet,
    ScalarClear,
    AsBranch,
    AsPart,
    AsUnion,
    AsIntersection,
    LinkSet,
    LinkClear,
    Exists,
    AsProperty,
    AsObject,
    EntryAsProperty,
    EntryAsLink,
    Entry,
    RelationInsert,
    RelationRemove,
    RelationClear,
    AsEntries,
    Log,
  };
}
