/**
 * Mutations: the schemas of the mutations a transaction applies (docs/SERIALIZATION.md, Transactions on the wire).
 *
 * Mutations are schema-governed like everything else: each verb and noun here is a schema, every store holds them, and
 * ToPlain writes them as it writes any value. `install(txn)` defines them in the store a transaction writes, as every
 * module defines its schemas (docs/OBJECT_IDENTITY.md, Decided, 86); a store is made by it (`Builders`, the bootstrap). A
 * transaction is itself an object of the mutation expressions' schemas (the second half of `install`, docs/OBJECT_IDENTITY.md,
 * Decided, 93), whose patterns' specs are written in the verbs.
 *
 * Every mutation is a value object: it has no identity and is never shared. Each family of verbs is a union whose branches
 * are its verbs, named as a visitor's members are (`AsProperty` is `as_property`), so that a verb is written as its union's
 * branch (`{"set": {...}}`), and a list of verbs is a container of that union. A noun (`Ref`, `Def`, `Slice`) is a value
 * object nested in a verb. `OfContainer.AsItems` applies its list in modulo order.
 *
 * A pattern's spec (docs/OBJECT_IDENTITY.md, Decided, 95) is a `Mutations.OfPattern`: for each symbol, the mutations of the
 * object it binds (`OfObject`: a property's, `as_property`, an adjacency's, `as_adjacency`, whose `OfAdjacency` verbs
 * insert, remove and clear entries, and, a pattern's, its own spec as recorded, `spec`), a link referring to an object by
 * its symbol or its path (`Ref`), or defining one where it is linked (`Def`'s `schema` and `mutations`). Value verbs are
 * nested in them, following the property they name.
 *
 * Payloads (a property's value) are values of whatever schema the target gives, `Mutations.Payload`, a value of any
 * schema; a spec records them untagged, interpreted by the target's schema.
 */

/** The mutation schemas, defined in the store a transaction writes: `store.transaction(Mutations.install)`. A store is
 * made by it, after `Schemas.install` and `Paths.install`, read by the bootstrap (README.md, The bootstrap); run again
 * in a store, it finds each by its name and writes nothing. */
export function install(txn: any): any {
  const S = txn.Schemas; // the store's meta-schemas and basic scalars (78)
  return txn.uid("mbse.Schemas.Mutations/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({
      Payload: S.OfAny,
      Ref: S.OfObject, Def: S.OfObject, Slice: S.OfObject,
      OfProperty: S.OfUnion, OfContainer: S.OfUnion, OfAny: S.OfUnion, OfScalar: S.OfUnion,
      OfLink: S.OfUnion, OfEntryMember: S.OfUnion, OfObject: S.OfUnion, OfAdjacency: S.OfUnion,
      PropertySet: S.OfObject, PropertyClear: S.OfObject, PropertyAsAny: S.OfObject,
      ContainerInsert: S.OfObject, ContainerRemove: S.OfObject, ContainerAppend: S.OfObject,
      ContainerPrepend: S.OfObject, ContainerClear: S.OfObject, AsItems: S.OfObject,
      AnySet: S.OfObject, AnyClear: S.OfObject, AsScalar: S.OfObject, AsContainer: S.OfObject,
      ScalarSet: S.OfObject, ScalarClear: S.OfObject, AsBranch: S.OfObject, AsPart: S.OfObject,
      AsUnion: S.OfObject, AsIntersection: S.OfObject, LinkSet: S.OfObject, LinkClear: S.OfObject,
      AsProperty: S.OfObject, AsObject: S.OfObject, EntryAsProperty: S.OfObject, EntryAsLink: S.OfObject,
      Entry: S.OfObject, AsAdjacency: S.OfObject, AdjacencyInsert: S.OfObject,
      AdjacencyRemove: S.OfObject, AdjacencyClear: S.OfObject, OfPattern: S.OfContainer, Spec: S.OfObject,
      OfTerm: S.OfUnion, OfTransaction: S.OfObject, OfMap: S.OfObject, OfReduce: S.OfObject,
      OfPartition: S.OfObject, OfBranch: S.OfObject, OfUpdate: S.OfObject, OfUpsert: S.OfObject,
      HasRoot: S.OfRelation, Then: S.OfRelation, MapsSymbols: S.OfRelation, MapsVariables: S.OfRelation,
      ReducesSymbols: S.OfRelation, ReducesVariables: S.OfRelation, Branching: S.OfRelation,
      Otherwise: S.OfRelation, Requiring: S.OfRelation, Applies: S.OfRelation, Exists: S.OfRelation,
    })
    .spec([
      (_: any) => _.Payload.name("Mutations.Payload"), // untyped: interpreted by the target's schema

     // --- Nouns ---
      (_: any) => _.Ref.name("Mutations.OfObject.Ref").properties({ // by its path (81), or a symbol (95)
        path: txn.Paths.OfRoot, symbol: S.OfStr}),
      (_: any) => _.Def.name("Mutations.OfObject.Def").properties({ // no path: defined where it is linked
        schema: S.OfStr,
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfObject]))}),
      (_: any) => _.Slice.name("Mutations.OfContainer.Slice").properties({
        index: _.Payload, // where the section starts, by the container's index
        items: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.Payload]))}),

     // --- Value verbs ---
      (_: any) => _.PropertySet.name("Mutations.OfProperty.Set").properties({value: _.Payload}),
      (_: any) => _.PropertyClear.name("Mutations.OfProperty.Clear"),
      (_: any) => _.PropertyAsAny.name("Mutations.OfProperty.AsAny").properties({
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfAny]))}),
      (_: any) => _.ContainerInsert.name("Mutations.OfContainer.Insert").properties({slice: _.Slice}),
      (_: any) => _.ContainerRemove.name("Mutations.OfContainer.Remove").properties({ // by its start and length
        index: _.Payload, count: S.OfInt}),
      (_: any) => _.ContainerAppend.name("Mutations.OfContainer.Append").properties({
        items: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.Payload]))}),
      (_: any) => _.ContainerPrepend.name("Mutations.OfContainer.Prepend").properties({
        items: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.Payload]))}),
      (_: any) => _.ContainerClear.name("Mutations.OfContainer.Clear"),
      (_: any) => _.AsItems.name("Mutations.OfContainer.AsItems").properties({ // applied in modulo order
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfAny]))}),
      (_: any) => _.AnySet.name("Mutations.OfAny.Set").properties({value: _.Payload}),
      (_: any) => _.AnyClear.name("Mutations.OfAny.Clear"),
      (_: any) => _.AsScalar.name("Mutations.OfAny.AsScalar").properties({
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfScalar]))}),
      (_: any) => _.AsContainer.name("Mutations.OfAny.AsContainer").properties({
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfContainer]))}),
      (_: any) => _.ScalarSet.name("Mutations.OfScalar.Set").properties({value: _.Payload}),
      (_: any) => _.ScalarClear.name("Mutations.OfScalar.Clear"),
      (_: any) => _.AsBranch.name("Mutations.OfUnion.AsBranch").properties({
        name: S.OfStr,
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfProperty]))}),
      (_: any) => _.AsPart.name("Mutations.OfIntersection.AsPart").properties({
        name: S.OfStr,
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfProperty]))}),
      (_: any) => _.AsUnion.name("Mutations.OfAny.AsUnion").properties({
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.AsBranch]))}),
      (_: any) => _.AsIntersection.name("Mutations.OfAny.AsIntersection").properties({
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.AsPart]))}),
      (_: any) => _.LinkSet.name("Mutations.OfLink.Set").properties({ref: _.Ref, def: _.Def}),
      (_: any) => _.LinkClear.name("Mutations.OfLink.Clear"),

     // --- An object's, an entry's and an adjacency's verbs ---
      (_: any) => _.AsProperty.name("Mutations.OfObject.AsProperty").properties({
        name: S.OfStr,
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfProperty]))}),
      (_: any) => _.AsObject.name("Mutations.OfAny.AsObject").properties({
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.AsProperty]))}),
      (_: any) => _.EntryAsProperty.name("Mutations.OfEntry.AsProperty").properties({
        name: S.OfStr,
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfProperty]))}),
      (_: any) => _.EntryAsLink.name("Mutations.OfEntry.AsLink").properties({
        name: S.OfStr,
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfLink]))}),
      (_: any) => _.Entry.name("Mutations.OfEntry").properties({ // its links' and its properties' mutations
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfEntryMember]))}),
      (_: any) => _.AsAdjacency.name("Mutations.OfObject.AsAdjacency").properties({
        name: S.OfStr,
        mutations: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfAdjacency]))}),
      (_: any) => _.AdjacencyInsert.name("Mutations.OfAdjacency.Insert").properties({
        entries: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.Entry]))}),
      (_: any) => _.AdjacencyRemove.name("Mutations.OfAdjacency.Remove").properties({
        entries: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.Entry]))}),
      (_: any) => _.AdjacencyClear.name("Mutations.OfAdjacency.Clear"), // every entry it holds removed
      (_: any) => _.OfPattern.name("Mutations.OfPattern").index([S.OfStr]).element([ // a spec, by symbol (95)
        S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfObject]))]),
      (_: any) => _.Spec.name("Mutations.OfObject.Spec").properties({ // a pattern's spec, as recorded
        items: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.OfPattern]))}),

     // --- The unions' branches, each a verb named as a visitor's member is ---
      (_: any) => _.OfProperty.name("Mutations.OfProperty").branches([
        (t: any) => t.name("set").schema([_.PropertySet]),
        (t: any) => t.name("clear").schema([_.PropertyClear]),
        (t: any) => t.name("as_any").schema([_.PropertyAsAny]),
      ]),
      (_: any) => _.OfContainer.name("Mutations.OfContainer").branches([
        (t: any) => t.name("insert").schema([_.ContainerInsert]),
        (t: any) => t.name("remove").schema([_.ContainerRemove]),
        (t: any) => t.name("append").schema([_.ContainerAppend]),
        (t: any) => t.name("prepend").schema([_.ContainerPrepend]),
        (t: any) => t.name("clear").schema([_.ContainerClear]),
        (t: any) => t.name("as_items").schema([_.AsItems]),
      ]),
      (_: any) => _.OfAny.name("Mutations.OfAny").branches([
        (t: any) => t.name("set").schema([_.AnySet]),
        (t: any) => t.name("clear").schema([_.AnyClear]),
        (t: any) => t.name("as_scalar").schema([_.AsScalar]),
        (t: any) => t.name("as_container").schema([_.AsContainer]),
        (t: any) => t.name("as_object").schema([_.AsObject]),
        (t: any) => t.name("as_union").schema([_.AsUnion]),
        (t: any) => t.name("as_intersection").schema([_.AsIntersection]),
      ]),
      (_: any) => _.OfScalar.name("Mutations.OfScalar").branches([
        (t: any) => t.name("set").schema([_.ScalarSet]),
        (t: any) => t.name("clear").schema([_.ScalarClear]),
      ]),
      (_: any) => _.OfLink.name("Mutations.OfLink").branches([
        (t: any) => t.name("set").schema([_.LinkSet]),
        (t: any) => t.name("clear").schema([_.LinkClear]),
      ]),
      (_: any) => _.OfEntryMember.name("Mutations.OfEntry.Member").branches([
        (t: any) => t.name("as_property").schema([_.EntryAsProperty]),
        (t: any) => t.name("as_link").schema([_.EntryAsLink]),
      ]),
      (_: any) => _.OfObject.name("Mutations.OfObject").branches([
        (t: any) => t.name("as_property").schema([_.AsProperty]),
        (t: any) => t.name("as_adjacency").schema([_.AsAdjacency]),
        (t: any) => t.name("spec").schema([_.Spec]),
      ]),
      (_: any) => _.OfAdjacency.name("Mutations.OfAdjacency").branches([
        (t: any) => t.name("insert").schema([_.AdjacencyInsert]),
        (t: any) => t.name("remove").schema([_.AdjacencyRemove]),
        (t: any) => t.name("clear").schema([_.AdjacencyClear]),
      ]),

     // --- Mutation expressions: a transaction and its terms, reference objects linked by relations (93) ---
      (_: any) => _.OfTerm.name("Mutations.OfTerm").branches([
        (t: any) => t.name("map").schema([_.OfMap]),
        (t: any) => t.name("reduce").schema([_.OfReduce]),
        (t: any) => t.name("partition").schema([_.OfPartition]),
        (t: any) => t.name("update").schema([_.OfUpdate]),
        (t: any) => t.name("upsert").schema([_.OfUpsert]),
      ]),
      (_: any) => _.HasRoot.name("Mutations.HasRoot").links([
        (t: any) => t.name("transaction"), (t: any) => t.name("term").schema([_.OfTerm])]).uniques([["term"]]),
      (_: any) => _.Then.name("Mutations.Then").links([
        (t: any) => t.name("term"), (t: any) => t.name("next").schema([_.OfTerm])]).uniques([["next"]]),
      (_: any) => _.MapsSymbols.name("Mutations.MapsSymbols").links([
        (t: any) => t.name("term"), (t: any) => t.name("pattern").schema([S.OfPattern])]).uniques([["pattern"]]),
      (_: any) => _.MapsVariables.name("Mutations.MapsVariables").links([
        (t: any) => t.name("term"), (t: any) => t.name("pattern").schema([S.OfPattern])]).uniques([["pattern"]]),
      (_: any) => _.ReducesSymbols.name("Mutations.ReducesSymbols").links([
        (t: any) => t.name("term"), (t: any) => t.name("collector").schema([S.OfCollector])]).uniques([
        ["collector"]]),
      (_: any) => _.ReducesVariables.name("Mutations.ReducesVariables").links([
        (t: any) => t.name("term"), (t: any) => t.name("collector").schema([S.OfCollector])]).uniques([
        ["collector"]]),
      (_: any) => _.Branching.name("Mutations.Branching").links([
        (t: any) => t.name("partition"), (t: any) => t.name("branch").schema([_.OfBranch])]).uniques([]), // a set
      (_: any) => _.Otherwise.name("Mutations.Otherwise").links([
        (t: any) => t.name("partition"), (t: any) => t.name("next").schema([_.OfTerm])]).uniques([["next"]]),
      (_: any) => _.Requiring.name("Mutations.Requiring").links([
        (t: any) => t.name("branch"), (t: any) => t.name("constraint").schema([S.OfExpression])]).uniques([]), // a set
      (_: any) => _.Applies.name("Mutations.Applies").links([
        (t: any) => t.name("term"), (t: any) => t.name("pattern").schema([S.OfPattern])]).uniques([["pattern"]]),
      (_: any) => _.Exists.name("Mutations.Exists").links([
        (t: any) => t.name("term"), (t: any) => t.name("pattern").schema([S.OfPattern])]).uniques([["pattern"]]),
      (_: any) => _.OfTransaction.name("Mutations.OfTransaction").ref(true).properties({
        uid: S.OfStr, // given by the program (42)
      }).adjacencies({
        mutations: (a: any) => a.relation([_.HasRoot]).me("transaction"), // its one root term
      }),
      (_: any) => _.OfMap.name("Mutations.OfMap").ref(true).adjacencies({
        symbols: (a: any) => a.relation([_.MapsSymbols]).me("term"),
        variables: (a: any) => a.relation([_.MapsVariables]).me("term"),
        then: (a: any) => a.relation([_.Then]).me("term"),
      }),
      (_: any) => _.OfReduce.name("Mutations.OfReduce").ref(true).adjacencies({
        symbols: (a: any) => a.relation([_.ReducesSymbols]).me("term"),
        variables: (a: any) => a.relation([_.ReducesVariables]).me("term"),
        then: (a: any) => a.relation([_.Then]).me("term"),
      }),
      (_: any) => _.OfPartition.name("Mutations.OfPartition").ref(true).properties({
        first: S.OfBool, last: S.OfBool,
      }).adjacencies({
        branches: (a: any) => a.relation([_.Branching]).me("partition"),
        none: (a: any) => a.relation([_.Otherwise]).me("partition"),
        then: (a: any) => a.relation([_.Then]).me("term"),
      }),
      (_: any) => _.OfBranch.name("Mutations.OfBranch").ref(true).adjacencies({
        requires: (a: any) => a.relation([_.Requiring]).me("branch"),
        then: (a: any) => a.relation([_.Then]).me("term"),
      }),
      (_: any) => _.OfUpdate.name("Mutations.OfUpdate").ref(true).adjacencies({
        apply: (a: any) => a.relation([_.Applies]).me("term"),
        then: (a: any) => a.relation([_.Then]).me("term"),
      }),
      (_: any) => _.OfUpsert.name("Mutations.OfUpsert").ref(true).properties({
        key: S.OfStr,
      }).adjacencies({
        exists: (a: any) => a.relation([_.Exists]).me("term"),
        then: (a: any) => a.relation([_.Then]).me("term"),
      }),
    ])]))]);
}
