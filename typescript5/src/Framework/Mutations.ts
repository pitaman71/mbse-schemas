/**
 * Mutations: the schemas of the mutations a transaction applies (docs/SERIALIZATION.md, Transactions on the wire).
 *
 * Mutations are schema-governed like everything else: each verb and noun here is a schema, every store holds them, and
 * ToPlain writes them as it writes any value. A transaction is itself an object of the mutation expressions' schemas
 * (the second half of this module, docs/OBJECT_IDENTITY.md, Decided, 93), whose patterns' specs are written in the verbs.
 *
 * Every mutation is a value object: it has no identity and is never shared. Each family of verbs is a union whose
 * branches are its verbs, named as a visitor's members are (`AsProperty` is `as_property`), so that a verb is written as
 * its union's branch (`{"set": {...}}`), and a list of verbs is a container of that union. A noun (`Ref`, `Def`,
 * `Slice`) is a value object nested in a verb. `OfContainer.AsItems` applies its list in modulo order.
 *
 * A pattern's spec (docs/OBJECT_IDENTITY.md, Decided, 95) is a `Mutations.OfPattern`: for each symbol, the mutations of
 * the object it binds (`OfObject`: a property's, `as_property`, an adjacency's, `as_adjacency`, whose `OfAdjacency`
 * verbs insert, remove and clear entries, and, a pattern's, its own spec as recorded, `spec`), a link referring to an object
 * by its symbol or its path (`Ref`), or defining one where it is linked (`Def`'s `schema` and `mutations`). Value verbs
 * are nested in them, following the property they name.
 *
 * Payloads (a property's value) are values of whatever schema the target gives: their schema here is a value of any
 * schema, and a spec records them untagged, interpreted by the target's schema.
 *
 * The schemas are built with the builders, anew for each store, which holds its own (docs/SCHEMA_EXTENSION.md, Decided,
 * 23): a store calls `schemas`, handing it the builders and its basic scalars.
 */

import type * as Builders from "./Builders.js";
import type * as S from "./Schemas.js";

type ObjectData = S.OfObject.Data;
type UnionData = S.OfUnion.Data;

type Spec = (t: any) => any;

/** What `schemas` builds with: the builders, the store's basic scalars `Text` (`Schemas.OfStr`), `Int` and `Bool`, its
 * `Paths.OfRoot` (`Path`), and its meta-schemas `Pattern`, `Collector` and `Expression` (`Schemas.OfPattern`, ...). */
interface Kit {
  AdjacencyBuilder: typeof Builders.AdjacencyBuilder;
  AnyValueBuilder: typeof Builders.AnyValueBuilder;
  ContainerBuilder: typeof Builders.ContainerBuilder;
  ObjectBuilder: typeof Builders.ObjectBuilder;
  RelationBuilder: typeof Builders.RelationBuilder;
  UnionBuilder: typeof Builders.UnionBuilder;
  Text: S.OfScalar.Data;
  Int: S.OfScalar.Data;
  Bool: S.OfScalar.Data;
  Path: ObjectData;
  Pattern: ObjectData;
  Collector: ObjectData;
  Expression: ObjectData;
}

let kit!: Kit; // the builders `schemas` builds with, set as it begins

function list(element: unknown): S.OfContainer.Data {
  return new kit.ContainerBuilder().index([kit.Int]).element([element]).create();
}

/** A verb or a noun, `Mutations.<name>`: a value object of `properties`, each naming one and giving its schema. */
function verb(name: string, ...properties: Spec[]): ObjectData {
  return new kit.ObjectBuilder().name(`Mutations.${name}`).properties(properties).create();
}

/** A verb's nested mutations: a list of `of`. */
function mutations(of: unknown): Spec {
  return (t: any) => t.name("mutations").schema([list(of)]);
}

function text(name: string): Spec {
  return (t: any) => t.name(name).schema([kit.Text]);
}

function union(name: string): UnionData {
  return new kit.UnionBuilder().name(`Mutations.${name}`).create();
}

/** Gives the union `of` its branches, `members`: each a name and the verb it holds. */
function branches(of: UnionData, members: [string, unknown][]): void {
  new kit.UnionBuilder(of).branches(members.map(([name, type]) => (t: any) => t.name(name).schema([type]))).update();
}

/** The mutation schemas, built anew with `builders` for a store whose basic scalars they are given: by name, each
 * `Mutations.<name>`'s local name (`Ref`, `OfPattern`, ...). */
export function schemas(builders: Kit): Record<string, ObjectData | UnionData | S.OfContainer.Data | S.OfRelation.Data> {
  kit = builders;
  const { AnyValueBuilder, ContainerBuilder, Int, ObjectBuilder, Path, Text } = builders;
  const Payload = new AnyValueBuilder().create();

  const Ref = verb( // an object by its path, a schema object's from the root module (docs/OBJECT_IDENTITY.md, Decided, 81),
    "OfObject.Ref", // or, within a pattern's spec, by the symbol that binds it (95)
    (t) => t.name("path").schema([Path]),
    text("symbol"),
  );
  const Def = verb("OfObject.Def", text("schema")); // an object with no path, where it is linked: its schema's name, and
  // its own mutations (given below)
  const Slice = verb(
    "OfContainer.Slice",
    (t) => t.name("index").schema([Payload]), // where the section starts, by the container's index
    (t) => t.name("items").schema([list(Payload)]),
  );

  const OfProperty = union("OfProperty");
  const OfContainer = union("OfContainer");
  const OfAny = union("OfAny");
  const OfScalar = union("OfScalar");
  const OfLink = union("OfLink");
  const OfEntryMember = union("OfEntry.Member");
  const OfObject = union("OfObject"); // an object's mutations in a spec: its properties' and its adjacencies' (95)
  const OfAdjacency = union("OfAdjacency"); // an adjacency's mutations in a spec

  const PropertySet = verb("OfProperty.Set", (t) => t.name("value").schema([Payload]));
  const PropertyClear = verb("OfProperty.Clear");
  const PropertyAsAny = verb("OfProperty.AsAny", mutations(OfAny));
  const ContainerInsert = verb("OfContainer.Insert", (t) => t.name("slice").schema([Slice]));
  const ContainerRemove = verb( // a section, by its start and its length
    "OfContainer.Remove",
    (t) => t.name("index").schema([Payload]),
    (t) => t.name("count").schema([Int]),
  );
  const ContainerAppend = verb("OfContainer.Append", (t) => t.name("items").schema([list(Payload)]));
  const ContainerPrepend = verb("OfContainer.Prepend", (t) => t.name("items").schema([list(Payload)]));
  const ContainerClear = verb("OfContainer.Clear");
  const AsItems = verb("OfContainer.AsItems", mutations(OfAny)); // applied in modulo order
  const AnySet = verb("OfAny.Set", (t) => t.name("value").schema([Payload]));
  const AnyClear = verb("OfAny.Clear");
  const AsScalar = verb("OfAny.AsScalar", mutations(OfScalar));
  const AsContainer = verb("OfAny.AsContainer", mutations(OfContainer));
  const ScalarSet = verb("OfScalar.Set", (t) => t.name("value").schema([Payload]));
  const ScalarClear = verb("OfScalar.Clear");
  const AsBranch = verb("OfUnion.AsBranch", text("name"), mutations(OfProperty));
  const AsPart = verb("OfIntersection.AsPart", text("name"), mutations(OfProperty));
  const AsUnion = verb("OfAny.AsUnion", mutations(AsBranch));
  const AsIntersection = verb("OfAny.AsIntersection", mutations(AsPart));
  const LinkSet = verb( // a reference, or the definition of a schema object with no path, nested where it is linked
    "OfLink.Set",
    (t) => t.name("ref").schema([Ref]),
    (t) => t.name("def").schema([Def]),
  );
  const LinkClear = verb("OfLink.Clear");

  const AsProperty = verb("OfObject.AsProperty", text("name"), mutations(OfProperty));
  const AsObject = verb("OfAny.AsObject", mutations(AsProperty));
  const EntryAsProperty = verb("OfEntry.AsProperty", text("name"), mutations(OfProperty));
  const EntryAsLink = verb("OfEntry.AsLink", text("name"), mutations(OfLink));
  const Entry = verb("OfEntry", mutations(OfEntryMember)); // an entry: its links' and its properties' mutations
  const AsAdjacency = verb("OfObject.AsAdjacency", text("name"), mutations(OfAdjacency));
  const AdjacencyInsert = verb("OfAdjacency.Insert", (t) => t.name("entries").schema([list(Entry)]));
  const AdjacencyRemove = verb("OfAdjacency.Remove", (t) => t.name("entries").schema([list(Entry)]));
  const AdjacencyClear = verb("OfAdjacency.Clear"); // every entry the adjacency holds removed
  new ObjectBuilder(Def).properties([mutations(OfObject)]).update();

  // --- The unions' branches ---

  branches(OfProperty, [["set", PropertySet], ["clear", PropertyClear], ["as_any", PropertyAsAny]]);
  branches(OfContainer, [["insert", ContainerInsert], ["remove", ContainerRemove], ["append", ContainerAppend],
    ["prepend", ContainerPrepend], ["clear", ContainerClear], ["as_items", AsItems]]);
  branches(OfAny, [["set", AnySet], ["clear", AnyClear], ["as_scalar", AsScalar], ["as_container", AsContainer],
    ["as_object", AsObject], ["as_union", AsUnion], ["as_intersection", AsIntersection]]);
  branches(OfScalar, [["set", ScalarSet], ["clear", ScalarClear]]);
  branches(OfLink, [["set", LinkSet], ["clear", LinkClear]]);
  branches(OfEntryMember, [["as_property", EntryAsProperty], ["as_link", EntryAsLink]]);
  // a spec (Schemas.OfPattern.spec): for each symbol, the mutations of the object it binds (Object identity, 95)
  const OfPattern = new ContainerBuilder().name("Mutations.OfPattern").index([Text]).element([list(OfObject)]).create();
  const Spec = verb("OfObject.Spec", (t) => t.name("items").schema([list(OfPattern)])); // a pattern's spec, as recorded
  branches(OfObject, [["as_property", AsProperty], ["as_adjacency", AsAdjacency], ["spec", Spec]]);
  branches(OfAdjacency, [["insert", AdjacencyInsert], ["remove", AdjacencyRemove], ["clear", AdjacencyClear]]);

  // --- Mutation expressions: a transaction and its terms, reference objects linked by relations (93) ---

  /** A kind of term, `Mutations.<name>`: a reference object schema of `properties`. */
  const term = (name: string, ...properties: Spec[]): ObjectData =>
    new kit.ObjectBuilder().name(`Mutations.${name}`).ref(true).properties(properties).create();
  /** A relation, `Mutations.<name>`, from `first` to `second`, whose schema is `schema`: an object of `first` holds one
   * entry of it at most where `one`, else a list. */
  const relation = (name: string, first: string, second: string, schema: unknown, one = true): S.OfRelation.Data =>
    new kit.RelationBuilder().name(`Mutations.${name}`).links([(t: any) => t.name(first), (t: any) => t.name(second).schema([schema])])
      .uniques(one ? [[second]] : []).create();
  const bool = (name: string): Spec => (t: any) => t.name(name).schema([kit.Bool]);

  const OfTerm = union("OfTerm"); // a kind union (97): its branches, given below, are the kinds of term
  const OfTransaction = term("OfTransaction", text("uid")); // the root: its uid, given by the program (42), and one term
  const OfMap = term("OfMap");
  const OfReduce = term("OfReduce");
  const OfPartition = term("OfPartition", bool("first"), bool("last"));
  const OfBranch = term("OfBranch");
  const OfUpdate = term("OfUpdate");
  const OfUpsert = term("OfUpsert", text("key"));
  const HasRoot = relation("HasRoot", "transaction", "term", OfTerm);
  const Then = relation("Then", "term", "next", OfTerm);
  const MapsSymbols = relation("MapsSymbols", "term", "pattern", kit.Pattern);
  const MapsVariables = relation("MapsVariables", "term", "pattern", kit.Pattern);
  const ReducesSymbols = relation("ReducesSymbols", "term", "collector", kit.Collector);
  const ReducesVariables = relation("ReducesVariables", "term", "collector", kit.Collector);
  const Branching = relation("Branching", "partition", "branch", OfBranch, false);
  const Otherwise = relation("Otherwise", "partition", "next", OfTerm);
  const Requiring = relation("Requiring", "branch", "constraint", kit.Expression, false);
  const Applies = relation("Applies", "term", "pattern", kit.Pattern);
  const Existing = relation("Exists", "term", "pattern", kit.Pattern);
  branches(OfTerm, [["map", OfMap], ["reduce", OfReduce], ["partition", OfPartition], ["update", OfUpdate], ["upsert", OfUpsert]]);
  /** Gives `kind` its adjacencies: each a name, a relation, and the link `kind` fills. */
  const adjacencies = (kind: ObjectData, ...named: [string, S.OfRelation.Data, string][]): void => {
    new kit.ObjectBuilder(kind).adjacencies(named.map(([name, of, me]) => (t: any) => t.name(name).adjacency(
      new kit.AdjacencyBuilder().relation([of]).me(me).create()))).update();
  };
  adjacencies(OfTransaction, ["mutations", HasRoot, "transaction"]);
  adjacencies(OfMap, ["symbols", MapsSymbols, "term"], ["variables", MapsVariables, "term"], ["then", Then, "term"]);
  adjacencies(OfReduce, ["symbols", ReducesSymbols, "term"], ["variables", ReducesVariables, "term"], ["then", Then, "term"]);
  adjacencies(OfPartition, ["branches", Branching, "partition"], ["none", Otherwise, "partition"], ["then", Then, "term"]);
  adjacencies(OfBranch, ["requires", Requiring, "branch"], ["then", Then, "term"]);
  adjacencies(OfUpdate, ["apply", Applies, "term"], ["then", Then, "term"]);
  adjacencies(OfUpsert, ["exists", Existing, "term"], ["then", Then, "term"]);

  return {
    Ref,
    Def,
    Slice,
    OfProperty,
    OfContainer,
    OfAny,
    OfScalar,
    OfLink,
    OfEntryMember,
    OfObject,
    OfAdjacency,
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
    AsProperty,
    AsObject,
    EntryAsProperty,
    EntryAsLink,
    Entry,
    AsAdjacency,
    AdjacencyInsert,
    AdjacencyRemove,
    AdjacencyClear,
    OfPattern,
    Spec,
    OfTerm,
    OfTransaction,
    OfMap,
    OfReduce,
    OfPartition,
    OfBranch,
    OfUpdate,
    OfUpsert,
    HasRoot,
    Then,
    MapsSymbols,
    MapsVariables,
    ReducesSymbols,
    ReducesVariables,
    Branching,
    Otherwise,
    Requiring,
    Applies,
    Existing,
  };
}
