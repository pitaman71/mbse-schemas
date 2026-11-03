# Modeling with mbse-schemas

How to express an interface or data model with the schema elements. The same model works in every language; each
element links the cases that build it, in each language.

## Concepts mapped to elements

- **Block, class, entity, table row: anything with identity.** A reference object schema, marked `.ref(...)` and
  named, so its store registers it.
  - Python: [T01.1: Describing the record](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.1) · TypeScript: [T01.1: Describing the record](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.1)
  - Python: [SCH-19: Reference object schemas](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-19) · TypeScript: [SCH-19: Reference object schemas](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-19)
- **Primitive attribute, value property.** A property of a basic scalar.
  - Python: [T01.1: Describing the record](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.1) · TypeScript: [T01.1: Describing the record](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.1)
- **Structured value without identity** (UML datatype, SysML value type with parts, ICD signal description). A value
  object: a property whose schema is an object schema without adjacencies.
  - Python: [T09.4: Variants: unions and intersections](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.4) · TypeScript: [T09.4: Variants: unions and intersections](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.4)
  - Python: [EMB-02: Value objects](mbse:mbse-schemas/python3/tests/14_Embedded.ipynb#EMB-02) · TypeScript: [EMB-02: Value objects](mbse:mbse-schemas/typescript5/tests/14_Embedded.ipynb#EMB-02)
- **Association, reference property, pointer, foreign key.** A relation linking the objects, with an adjacency on
  each side, each naming the link its object fills.
  - Python: [T02.1: The schemas](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.1) · TypeScript: [T02.1: The schemas](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.1)
  - Python: [T02.3: Adding entries](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.3) · TypeScript: [T02.3: Adding entries](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.3)
- **Association class, association block, join table with columns.** A relation with properties: each entry carries
  them.
  - Python: [T02.3: Adding entries](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.3) · TypeScript: [T02.3: Adding entries](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.3)
  - Python: [T04.3: Several relations between the same pair, and more than one owner](mbse:mbse-schemas/python3/tutorials/04_A_Family_Tree.ipynb#T04.3) · TypeScript: [T04.3: Several relations between the same pair, and more than one owner](mbse:mbse-schemas/typescript5/tutorials/04_A_Family_Tree.ipynb#T04.3)
- **Self-association, a link filled by several kinds.** One relation, two adjacencies on the same schema; a link with
  no schema, filled by every schema that declares an adjacency through it.
  - Python: [T04.1: One relation, two adjacencies on the same schema](mbse:mbse-schemas/python3/tutorials/04_A_Family_Tree.ipynb#T04.1) · TypeScript: [T04.1: One relation, two adjacencies on the same schema](mbse:mbse-schemas/typescript5/tutorials/04_A_Family_Tree.ipynb#T04.1)
  - Python: [T04.6: When a link can be filled by different kinds of thing](mbse:mbse-schemas/python3/tutorials/04_A_Family_Tree.ipynb#T04.6) · TypeScript: [T04.6: When a link can be filled by different kinds of thing](mbse:mbse-schemas/typescript5/tutorials/04_A_Family_Tree.ipynb#T04.6)
- **Composition, part property** (each part has at most one whole). Links `whole` and `part`, with a `unique` clause on
  `whole`: the part determines its whole. Ownership, keyed ownership and directories are such clauses.
  - Python: [T05.2: Reading unique(S)](mbse:mbse-schemas/python3/tutorials/05_A_Price_List.ipynb#T05.2) · TypeScript: [T05.2: Reading unique(S)](mbse:mbse-schemas/typescript5/tutorials/05_A_Price_List.ipynb#T05.2)
  - Python: [T05.7: Ownership](mbse:mbse-schemas/python3/tutorials/05_A_Price_List.ipynb#T05.7) · TypeScript: [T05.7: Ownership](mbse:mbse-schemas/typescript5/tutorials/05_A_Price_List.ipynb#T05.7)
- **Multiplicity upper bound (0..1).** A `unique` clause, given with `.uniques(...)`.
  - Python: [T05.2: Reading unique(S)](mbse:mbse-schemas/python3/tutorials/05_A_Price_List.ipynb#T05.2) · TypeScript: [T05.2: Reading unique(S)](mbse:mbse-schemas/typescript5/tutorials/05_A_Price_List.ipynb#T05.2)
- **Multiplicity lower bound (1, 1..\*).** Not a schema element: a constraint, written with mbse-patterns
  ([CAP-152: relation constraint terms as mandatory, possible, or forbidden entry patterns](mbse:mbse-basis/docs/capabilities/CAP-152.md)), attached
  where it constrains when [CAP-166: constraints attached where they constrain](mbse:mbse-basis/docs/capabilities/CAP-166.md) is built.
- **Qualified association, map, dictionary of objects.** A relation with a key property, and a clause naming the
  linked object, so that the owner and the key determine it.
  - Python: [T05.1: A dictionary is a relation with a key](mbse:mbse-schemas/python3/tutorials/05_A_Price_List.ipynb#T05.1) · TypeScript: [T05.1: A map is a relation with a key](mbse:mbse-schemas/typescript5/tutorials/05_A_Price_List.ipynb#T05.1)
- **Ordered list of values or parts** (tags, a component's own ports). A property holding a container by an int
  index, its elements scalars, value objects or containers.
  - Python: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.7) · TypeScript: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.7)
  - Python: [CNT-01: Elements by index](mbse:mbse-schemas/python3/tests/23_Containers.ipynb#CNT-01) · TypeScript: [CNT-01: Elements by index](mbse:mbse-schemas/typescript5/tests/23_Containers.ipynb#CNT-01)
- **Dictionary, associative array** (values by key). A container by a hashable index, written as a mapping where the
  index is text.
  - Python: [SCH-23: Containers: elements by index, each of a schema](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-23) · TypeScript: [SCH-23: Containers: elements by index, each of a schema](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-23)
  - Python: [CNT-04: Snapshots: a dense container as an array, nested or flat for several indices, a sparse one as blocks, a dict by text as a mapping, entries otherwise](mbse:mbse-schemas/python3/tests/23_Containers.ipynb#CNT-04) · TypeScript: [CNT-04: Snapshots: a dense container as an array, nested or flat for several indices, a sparse one as blocks, a dict by text as a mapping, entries otherwise](mbse:mbse-schemas/typescript5/tests/23_Containers.ipynb#CNT-04)
- **Dense tensor, matrix; sparse array.** A container by a value object of ints (`{row, col}`), dense: every cell of
  the box its indices span, written nested or, configured on the writer, flat with its shape. A sparse one is written
  as blocks of consecutive elements, each where it starts.
  - Python: [CNT-01: Elements by index](mbse:mbse-schemas/python3/tests/23_Containers.ipynb#CNT-01) · TypeScript: [CNT-01: Elements by index](mbse:mbse-schemas/typescript5/tests/23_Containers.ipynb#CNT-01)
  - Python: [CNT-04: Snapshots: a dense container as an array, nested or flat for several indices, a sparse one as blocks, a dict by text as a mapping, entries otherwise](mbse:mbse-schemas/python3/tests/23_Containers.ipynb#CNT-04) · TypeScript: [CNT-04: Snapshots: a dense container as an array, nested or flat for several indices, a sparse one as blocks, a dict by text as a mapping, entries otherwise](mbse:mbse-schemas/typescript5/tests/23_Containers.ipynb#CNT-04)
- **Fixed-size array.** A container by an int index; its bounds are a shape constraint on the index's schema
  ([CAP-108: relations as scalable containers](mbse:mbse-basis/docs/capabilities/CAP-108.md#open-questions)).
- **Ordered list of shared objects.** A relation with no `unique` clause, whose entries are a list from each end, or
  one with an index property and a clause naming the item.
  - Python: [PRX-20: An open relation's entries are a list, equal entries kept](mbse:mbse-schemas/python3/tests/03_Proxies.ipynb#PRX-20) · TypeScript: [PRX-20: An open relation's entries are a list, equal entries kept](mbse:mbse-schemas/typescript5/tests/03_Proxies.ipynb#PRX-20)
  - Python: [DC-09: A program's dataclasses as its schemas, end to end](mbse:mbse-schemas/python3/tests/16_Dataclasses.ipynb#DC-09)
- **Tagged union, variant, `oneOf`, `xsd:choice`.** A union: named, same-kind branches, one or more; a value holds
  exactly one, written under its branch's name. A flat union's value reads, and is written, as its branch's value.
  - Python: [T09.4: Variants: unions and intersections](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.4) · TypeScript: [T09.4: Variants: unions and intersections](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.4)
  - Python: [SCH-14: Unions: named branches accumulate in order; validation checks count, kinds and names](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-14) · TypeScript: [SCH-14: Unions: named branches accumulate in order; validation checks count, kinds and names](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-14)
  - Python: [EMB-11: Flat unions and intersections](mbse:mbse-schemas/python3/tests/14_Embedded.ipynb#EMB-11) · TypeScript: [EMB-11: Flat unions and intersections](mbse:mbse-schemas/typescript5/tests/14_Embedded.ipynb#EMB-11)
- **Mixin, aspect, `allOf`.** An intersection: named, same-kind parts, two or more; a value holds every one. For
  property values; objects with identity composed from aspects are
  [CAP-034: schemas specialized by classifier intersection and union](mbse:mbse-basis/docs/capabilities/CAP-034.md).
  - Python: [T09.4: Variants: unions and intersections](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.4) · TypeScript: [T09.4: Variants: unions and intersections](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.4)
  - Python: [EMB-08: Intersection values: each part by name; parts do not merge](mbse:mbse-schemas/python3/tests/14_Embedded.ipynb#EMB-08) · TypeScript: [EMB-08: Intersection values: each part by name; parts do not merge](mbse:mbse-schemas/typescript5/tests/14_Embedded.ipynb#EMB-08)
- **Generalization, specialization, subtype.** A refinement (`.refines(...)`): the members of the schema it refines
  and its own, a member it redeclares only narrower; its objects are that schema's too.
  - Python: [T11.1: A refinement: a resistor is a part](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.1) · TypeScript: [T11.1: A refinement: a resistor is a part](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.1)
  - Python: [T11.2: Narrowing a member: a chip mounts on the surface](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.2) · TypeScript: [T11.2: Narrowing a member: a chip mounts on the surface](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.2)
- **A value of whichever type a source gives** (a datasheet's number or text, `anyOf`). A value of any schema,
  restricted to a few schemas, or to none.
  - Python: [T11.4: Values of any schema: a rating, whatever the datasheet gives](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.4) · TypeScript: [T11.4: Values of any schema: a rating, whatever the datasheet gives](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.4)
- **Singleton, global registry, directory.** A reference object schema marked `.singleton(...)`, usually with a
  directory relation keyed by a unique ID.
  - Python: [T09.3: Unique customer IDs: a directory](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.3) · TypeScript: [T09.3: Unique customer IDs: a directory](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.3)
- **Port and connector.** Ports as reference objects, owned by their component through a relation; connectors as a
  relation between ports, carrying the connection's properties. Ports nothing connects may be value objects in a
  container of their component.
  - Python: [T04.3: Several relations between the same pair, and more than one owner](mbse:mbse-schemas/python3/tutorials/04_A_Family_Tree.ipynb#T04.3) · TypeScript: [T04.3: Several relations between the same pair, and more than one owner](mbse:mbse-schemas/typescript5/tutorials/04_A_Family_Tree.ipynb#T04.3)
  - Python: [T05.7: Ownership](mbse:mbse-schemas/python3/tutorials/05_A_Price_List.ipynb#T05.7) · TypeScript: [T05.7: Ownership](mbse:mbse-schemas/typescript5/tutorials/05_A_Price_List.ipynb#T05.7)
- **Template, generic, parameterized block or type** (UML/SysML template parameters, C++ templates, SystemVerilog
  `parameter`s). `Parametrics`, installed before use: a set of named parameters on the schema, each for a value of a
  schema or an object of an object schema. Binding them, and terms over them (a bit width, an array's size), are
  mbse-expressions'.
  - Python: [T11.5: Parameters: a bus as wide as each design needs](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.5) · TypeScript: [T11.5: Parameters: a bus as wide as each design needs](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.5)
  - Python: [PAR-02: Every kind of schema declares a set of parameters](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-02) · TypeScript: [PAR-02: Every kind of schema declares a set of parameters](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-02)
- **Documentation, comment, `description`.** `.description(...)` on the element's builder: a schema, a property, an
  adjacency, a branch or a part. A description is text that no check of data reads.
  - Python: [T01.1: Describing the record](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.1) · TypeScript: [T01.1: Describing the record](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.1)
  - Python: [SCH-21: Every element may be described: schemas, properties, adjacencies and members](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-21) · TypeScript: [SCH-21: Every element may be described: schemas, properties, adjacencies and members](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-21)
- **Enumeration of literals.** A basic scalar (text, say); restricting its values is a constraint attached to it
  ([CAP-166: constraints attached where they constrain](mbse:mbse-basis/docs/capabilities/CAP-166.md)).

## Modeling choices

Each choice in brief; the item linked holds the design and its reasons.

- **Reference object or value object?** A reference object where the thing is shared, navigated back from, part of a
  cycle or referred to by identity; otherwise a value object, held by a property and copied with it
  ([CAP-154: value objects and reference objects](mbse:mbse-basis/docs/capabilities/CAP-154.md)).
  - Python: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.7) · TypeScript: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.7)
- **Singleton, owned or counted?** Own an object by a singleton, through a keyed relation whose adjacency is marked
  `.owner(...)`, where it must be found again or updated in place by loading; any other object is counted
  ([CAP-118: singletons, owned and counted objects](mbse:mbse-basis/docs/capabilities/CAP-118.md), [CAP-119: owned objects found by path](mbse:mbse-basis/docs/capabilities/CAP-119.md),
  [CAP-120: owned objects named and placed when built](mbse:mbse-basis/docs/capabilities/CAP-120.md)). To designate one in a request or a response, give its
  reference ([CAP-130: references to objects, entries and frames](mbse:mbse-basis/docs/capabilities/CAP-130.md)).
  - Python: [T06.1: One object](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.1) · TypeScript: [T06.1: One object](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.1)
  - Python: [IDN-05: An object built without an owner is given the one its schema allows](mbse:mbse-schemas/python3/tests/29_Identity.ipynb#IDN-05) · TypeScript: [IDN-05: An object built without an owner is given the one its schema allows](mbse:mbse-schemas/typescript5/tests/29_Identity.ipynb#IDN-05)
  - Python: [T10.7: Handing frames on](mbse:mbse-schemas/python3/tutorials/10_Asking_The_Store.ipynb#T10.7) · TypeScript: [T10.7: Handing frames on](mbse:mbse-schemas/typescript5/tutorials/10_Asking_The_Store.ipynb#T10.7)
- **Container or relation?** Values one owner holds go in a container, a property; objects several share are linked by
  a relation of two links or more ([CAP-108: relations as scalable containers](mbse:mbse-basis/docs/capabilities/CAP-108.md)).
  - Python: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.7) · TypeScript: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.7)
- **Set or list, and cardinality, come from `unique`.** A clause makes a relation's entries a set; `unique(S)` makes
  the links and properties outside `S` a key; a relation without one is open, its entries a list. Pick from the
  patterns in [CAP-155: `unique` clauses on relation schemas govern relation cardinality](mbse:mbse-basis/docs/capabilities/CAP-155.md): ownership, keyed ownership,
  directory, and global ID directory.
  - Python: [T02.6: Entries form a set, because the relation says so](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.6) · TypeScript: [T02.6: Entries form a set, because the relation says so](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.6)
  - Python: [T05.2: Reading unique(S)](mbse:mbse-schemas/python3/tutorials/05_A_Price_List.ipynb#T05.2) · TypeScript: [T05.2: Reading unique(S)](mbse:mbse-schemas/typescript5/tutorials/05_A_Price_List.ipynb#T05.2)
  - Python: [PRX-20: An open relation's entries are a list, equal entries kept](mbse:mbse-schemas/python3/tests/03_Proxies.ipynb#PRX-20) · TypeScript: [PRX-20: An open relation's entries are a list, equal entries kept](mbse:mbse-schemas/typescript5/tests/03_Proxies.ipynb#PRX-20)
- **Union or intersection?** A union's value holds exactly one of its branches, written under the branch's name even
  where it has only one; an intersection's holds every part
  ([CAP-153: unions and intersections of named branches and parts](mbse:mbse-basis/docs/capabilities/CAP-153.md)).
  - Python: [T09.4: Variants: unions and intersections](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.4) · TypeScript: [T09.4: Variants: unions and intersections](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.4)
- **A refinement, a union or a value of any schema?** A refinement where every one of its objects is one of the
  refined schema's, with its members; a union where a value is one of a few named kinds; a value of any schema where
  the kinds have no names of their own and the plain form tells them apart
  ([CAP-167: schemas refined by other schemas](mbse:mbse-basis/docs/capabilities/CAP-167.md),
  [CAP-157: values of any schema, restricted or not](mbse:mbse-basis/docs/capabilities/CAP-157.md)).
  - Python: [T11.1: A refinement: a resistor is a part](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.1) · TypeScript: [T11.1: A refinement: a resistor is a part](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.1)
  - Python: [T11.4: Values of any schema: a rating, whatever the datasheet gives](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.4) · TypeScript: [T11.4: Values of any schema: a rating, whatever the datasheet gives](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.4)
- **Define them in an install.** Objects and relations that name each other go in one install, in any order; a
  pattern whose spec names schemas goes in an install run after the one that defines them
  ([CAP-115: schemas defined by idempotent installs](mbse:mbse-basis/docs/capabilities/CAP-115.md)).
  - Python: [T02.1: The schemas](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.1) · TypeScript: [T02.1: The schemas](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.1)
  - Python: [INS-03: An install adds to what another defined](mbse:mbse-schemas/python3/tests/32_Installs.ipynb#INS-03) · TypeScript: [INS-03: An install adds to what another defined](mbse:mbse-schemas/typescript5/tests/32_Installs.ipynb#INS-03)
- **Evolving a schema.** Add properties freely: old data lacks them, and nothing is mandatory
  ([CAP-025: nothing mandatory but by constraint](mbse:mbse-basis/docs/capabilities/CAP-025.md)). Another install adds members to a schema
  the store holds ([CAP-109: schemas as linked objects in modules](mbse:mbse-basis/docs/capabilities/CAP-109.md)); [schemas.md](schemas.md) says how.
  - Python: [T09.1: Adding a property](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.1) · TypeScript: [T09.1: Adding a property](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.1)

## Go deeper

The design of every element and decision is [CAP-109: schemas as linked objects in modules](mbse:mbse-basis/docs/capabilities/CAP-109.md#the-kinds).
