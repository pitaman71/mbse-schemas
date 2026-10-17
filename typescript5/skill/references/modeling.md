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
| Multiplicity lower bound (1, 1..*) | not expressible yet: constraints are planned |
| Qualified association, map, dictionary | relation with a key property: `.uniques(["owner", "key"])` |
| Ordered list of values or parts (tags, a component's ports) | a property holding a container by an int index: `t.name("tags").schema([Tags])`, where `Tags = store.Schemas.OfContainer(lambda c: c.index([Int]).element([Text]))`, its elements scalars, value objects or containers |
| Dictionary, associative array (values by key) | a container by a hashable index: `c.index([Text]).element([...])`, written as a mapping where the index is text |
| Dense tensor, matrix | a container by a value object of ints (`{row, col}`), dense: every cell of the box its indices span; written nested or, configured on the writer, flat with its shape |
| Sparse array or tensor | `.layout("sparse")` on the container: blocks of consecutive elements, each where it starts |
| Fixed-size array | a container by an int index; its bounds are a constraint on the index's schema, which is planned |
| Ordered list of shared objects | relation with an index property: links `owner` and `item`, a property `index`, `.uniques(["owner", "index"])` |
| Tagged union, variant, `oneOf`, `xsd:choice` | `OfUnion`: named, same-kind branches; a value holds exactly one |
| Mixin, aspect, `allOf` | `OfIntersection`: named, same-kind parts; a value holds every one. Supported for property values. Objects with identity composed from aspects are not yet |
| Singleton, global registry | `.ref(True).singleton("Name")` on the object schema, usually with a directory relation |
| Port and connector | ports as reference objects, owned by their component through a relation; connectors as a relation between ports, carrying the connection's properties. Ports nothing connects may be value objects in a list of their component |
| Template, generic, parameterized block or type (UML/SysML template parameters, C++ templates, SystemVerilog `parameter`s) | `.parameters([lambda t: t.name("n")])` on the schema: names, each standing for what a use of the schema binds. Binding them, and terms over them (a bit width, an array's size), are mbse-expressions' |
| Documentation, comment, `description` | `.description(text)` on the element's builder: a schema, property, adjacency, branch or part |
| Enumeration of literals | a basic scalar (e.g. `str`); restricting its values needs constraints, which are planned |

## Decisions

**Reference object or value object?** Use a reference object, whose schema is marked `.ref(True)`, if the thing is shared
by several owners, navigated back from, part of a cycle, or referred to by identity; it is reached through relations
and never held by a property. Otherwise use a value object: a property holds it, it is copied by
value and written nested. A value object has no identity and no adjacencies, though it may hold containers, and
nothing links to it: a component's ports that connectors link are reference objects. A reference object has an identity, its path: from a
singleton through the entries that own it, each through an adjacency marked `.owner(True)` and keyed by the entry's
key properties; where its schema declares no owner, its schema owns it, by a key given when it is created: its
schema's local name and a number (`feature-1`), or the next name its naming pattern gives in its store
(`.pattern(r"FEA-(\d+\d\d)")` names features `FEA-001`, `FEA-002`, ...). Give a pattern where people read the names.
A program never writes an identity: it reads it, `as_identity()`, and finds an object by its keys (`adjacency({"name":
"DEF-693"})`).

**A container is a list of values.** Its elements belong to their one owner (a contact's own phone numbers, a
container of text), so it is a property, copied and written with it. Data that several objects share is an object,
linked to each by a relation of two links or more.

**Set or list comes from `unique`.** A relation with a `unique` clause holds a set, and an equal entry is elided; one
without is open, its entries a list, equal entries kept. `.uniques([])`, one clause naming nothing, only makes it a set.

**Cardinality comes from `unique(S)`.** The links and properties outside `S` determine `S`, so they form a key. Pick
from the patterns in
[FRAMEWORK.md, Cardinality](https://github.com/pitaman71/mbse-schemas/blob/main/docs/FRAMEWORK.md#cardinality):
ownership, keyed ownership, directory, and global ID directory.

**Union or intersection?** Both have named members, and their values are records keyed by those names. A union value
holds exactly one branch (`{"phone": {"number": "1"}}`), and setting one clears the other; which branch it holds is
data, so nothing evaluates predicates. An intersection value holds every part (`{"stamp": {...}, "audit": {...}}`).
Parts do not merge: each keeps its own properties, so two parts may declare the same name.

**Define in phases.** Objects and relations refer to each other, so first create the objects, then the relations,
then add each object's adjacencies by updating its schema in the store,
`store.Schemas.OfObject(existing, lambda o: o.adjacencies([...]))`.

**Evolving a schema.** Add properties freely, since old data lacks them and nothing is mandatory. Never reuse a name
with a new schema.

## Go deeper

| Topic | Read |
|---|---|
| Relations instead of lists, adjacencies, entries as shared facts | [tutorial 2, An address book](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/02_An_Address_Book.ipynb) |
| Self-relations, cycles, links filled by several kinds | [tutorial 4, A family tree](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/04_A_Family_Tree.ipynb) |
| `unique(...)`, maps as relations | [tutorial 5, A price list](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/05_A_Price_List.ipynb) |
| Optional fields, versions, directories, unions and intersections | [tutorial 9, When requirements change](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/09_When_Requirements_Change.ipynb) |
| Every element and decision | [FRAMEWORK.md, Elements](https://github.com/pitaman71/mbse-schemas/blob/main/docs/FRAMEWORK.md#elements) |
