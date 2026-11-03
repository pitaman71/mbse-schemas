# Modeling with mbse-schemas

How to express an interface or data model with the schema elements. The same model works in every language.

## Concepts mapped to elements

| Concept (SysML / UML / ORM / JSON Schema) | Element |
|---|---|
| Block, class, entity, table row: anything with identity | `OfObject` marked `.ref(True)`, named, so its store registers it |
| Primitive attribute, value property | `OfScalar` property |
| Structured value without identity (UML datatype, SysML value type with parts, ICD signal description) | value object: a property whose schema is an `OfObject` |
| Association, reference property, pointer, foreign key | `OfRelation` linking the objects, with an adjacency on each side |
| Association class, association block, join table with columns | `OfRelation` with properties |
| Composition, part property (each part has at most one whole) | links `whole` and `part`, `.uniques("whole")` |
| Multiplicity upper bound (0..1) | a `unique` clause, given with `.uniques(...)` |
| Multiplicity lower bound (1, 1..*) | not a schema element: a constraint, written with mbse-patterns ([CAP-152: relation constraint terms as mandatory, possible, or forbidden entry patterns](mbse:mbse-basis/docs/capabilities/CAP-152.md)) |
| Qualified association, map, dictionary | relation with a key property: `.uniques(["owner", "key"])` |
| Ordered list of values or parts (tags, a component's ports) | a property holding a container by an int index: `{"tags": S.OfContainer(lambda c: c.index([S.OfInt]).element([S.OfStr]))}`, its elements scalars, value objects or containers |
| Dictionary, associative array (values by key) | a container by a hashable index: `c.index([Text]).element([...])`, written as a mapping where the index is text |
| Dense tensor, matrix | a container by a value object of ints (`{row, col}`), dense: every cell of the box its indices span; written nested or, configured on the writer, flat with its shape |
| Sparse array or tensor | `.layout("sparse")` on the container: blocks of consecutive elements, each where it starts |
| Fixed-size array | a container by an int index; its bounds are a shape constraint on the index's schema ([CAP-108: relations as scalable containers](mbse:mbse-basis/docs/capabilities/CAP-108.md#open-questions)) |
| Ordered list of shared objects | relation with an index property: links `owner` and `item`, a property `index`, `.uniques(["owner", "index"])` |
| Tagged union, variant, `oneOf`, `xsd:choice` | `OfUnion`: named, same-kind branches, one or more; a value holds exactly one |
| Mixin, aspect, `allOf` | `OfIntersection`: named, same-kind parts; a value holds every one. Supported for property values. Objects with identity composed from aspects: [CAP-034: schemas specialized by classifier intersection and union](mbse:mbse-basis/docs/capabilities/CAP-034.md) |
| Singleton, global registry | `.ref(True).singleton("Name")` on the object schema, usually with a directory relation |
| Port and connector | ports as reference objects, owned by their component through a relation; connectors as a relation between ports, carrying the connection's properties. Ports nothing connects may be value objects in a list of their component |
| Template, generic, parameterized block or type (UML/SysML template parameters, C++ templates, SystemVerilog `parameter`s) | `Parametrics`, installed before use (`store.transaction(Parametrics.install)`): the schema's `.parameters([txn.Parametrics.OfParameters(lambda ps: ps.parameters({"n": lambda d: d.parameter(lambda p: p.for_value([S.OfInt]))}))])`, a set of named parameters, each standing for what a use of the schema binds, for a value of a schema (`for_value`) or an object of an object schema (`for_object`); `Parametrics.validate(store, schema)` checks them. Binding them, and terms over them (a bit width, an array's size), are mbse-expressions' |
| Documentation, comment, `description` | `.description(text)` on the element's builder: a schema, property, adjacency, branch or part |
| Enumeration of literals | a basic scalar (e.g. `str`); restricting its values is a constraint attached to it ([CAP-166: constraints attached where they constrain](mbse:mbse-basis/docs/capabilities/CAP-166.md)) |

## Modeling choices

Each choice in brief; the item linked holds the design and its reasons.

**Reference object or value object?** A reference object, its schema marked `.ref(True)`, where the thing is shared,
navigated back from, part of a cycle or referred to by identity; otherwise a value object, held by a property and
copied with it ([CAP-108: relations as scalable containers](mbse:mbse-basis/docs/capabilities/CAP-108.md#value-objects-and-reference-objects)).

**Singleton, owned or counted?** Own an object by a singleton, through a keyed relation whose adjacency is marked
`.owner(True)`, where it must be found again or updated in place by loading; any other object is counted
([CAP-118: singletons, owned and counted objects](mbse:mbse-basis/docs/capabilities/CAP-118.md), [CAP-119: owned objects found by path](mbse:mbse-basis/docs/capabilities/CAP-119.md),
[CAP-120: owned objects named and placed when built](mbse:mbse-basis/docs/capabilities/CAP-120.md)). To designate an object, an entry or a frame in a request
or a response, give a reference, `References.of(store, x)` ([CAP-130: references to objects, entries and frames](mbse:mbse-basis/docs/capabilities/CAP-130.md)).

**Container or relation?** Values one owner holds go in a container, a property; objects several share are linked by
a relation of two links or more ([CAP-108: relations as scalable containers](mbse:mbse-basis/docs/capabilities/CAP-108.md)).

**Set or list, and cardinality, come from `unique`.** A clause makes a relation's entries a set; `unique(S)` makes the
links and properties outside `S` a key. Pick from the patterns in
[CAP-155: `unique` clauses on relation schemas govern relation cardinality](mbse:mbse-basis/docs/capabilities/CAP-155.md):
ownership, keyed ownership, directory, and global ID directory.

**Union or intersection?** A union has one named branch or more, and its value holds exactly one of them, written
under the branch's name even where the union has only one; an intersection has two named parts or more, and its value
holds every one
([CAP-153: unions and intersections of named branches and parts](mbse:mbse-basis/docs/capabilities/CAP-153.md)).

**Define them in an install.** Objects and relations that name each other go in one install, in any order; a pattern
whose spec names schemas goes in an install run after the one that defines them
([CAP-115: schemas defined by idempotent installs](mbse:mbse-basis/docs/capabilities/CAP-115.md)).

**Evolving a schema.** Add properties freely: old data lacks them, and nothing is mandatory
([CAP-025: nothing mandatory but by constraint](mbse:mbse-basis/docs/capabilities/CAP-025.md)). Another install adds members to a schema
the store holds ([CAP-109: schemas as linked objects in modules](mbse:mbse-basis/docs/capabilities/CAP-109.md)).

## Go deeper

| Topic | Read |
|---|---|
| Relations instead of lists, adjacencies, entries as shared facts | [tutorial 2, An address book](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/02_An_Address_Book.ipynb) |
| Self-relations, cycles, links filled by several kinds | [tutorial 4, A family tree](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/04_A_Family_Tree.ipynb) |
| `unique(...)`, maps as relations | [tutorial 5, A price list](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/05_A_Price_List.ipynb) |
| Optional properties, versions, directories, unions and intersections | [tutorial 9, When requirements change](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/09_When_Requirements_Change.ipynb) |
| Every element and decision | [CAP-109: schemas as linked objects in modules](mbse:mbse-basis/docs/capabilities/CAP-109.md#the-kinds) |
