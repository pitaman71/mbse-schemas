# Modeling with mbse-schemas

How to express an interface or data model with the schema elements. The same model works in every language.

## Concepts mapped to elements

| Concept (SysML / UML / ORM / JSON Schema) | Element |
|---|---|
| Block, class, entity, table row: anything with identity | registered `OfObject` |
| Primitive attribute, value property | `OfNative` property |
| Structured value without identity (UML datatype, SysML value type with parts, ICD signal description) | embedded object: a property whose schema is an `OfObject` |
| Association, reference property, pointer, foreign key | `OfRelation` linking the objects, with an adjacency on each side |
| Association class, association block, join table with columns | `OfRelation` with properties |
| Composition, part property (each part has at most one whole) | `.links("whole", "part").unique("whole")` |
| Multiplicity upper bound (0..1) | a `unique(...)` clause |
| Multiplicity lower bound (1, 1..*) | not expressible yet: constraints are planned |
| Qualified association, map, dictionary | relation with a key property: `.unique("owner", "key")` |
| Ordered list | relation with an index property: `.links("owner", "item").properties(index).unique("owner", "index")` |
| List of primitives (tags, aliases) | objects holding the value, linked by a relation. Links always join objects |
| Tagged union, variant, `oneOf`, `xsd:choice` | `OfUnion`: named, same-kind branches; a value holds exactly one |
| Mixin, aspect, `allOf` | `OfIntersection`: named, same-kind parts; a value holds every one. Supported for property values. Objects with identity composed from aspects are not yet |
| Singleton, global registry | `OfObject.Builder().singleton("Name")`, usually with a directory relation |
| Port and connector | ports as objects owned by a component; connectors as a relation between ports, carrying the connection's properties |
| Enumeration of literals | a native (e.g. `str`); restricting its values needs constraints, which are planned |

## Decisions

**Object or embedded value?** Use an object if the thing is shared by several owners, navigated back from, part of a
cycle, or referred to by identity. Otherwise use an embedded object: it is copied by value and written nested.
Embedded objects cannot have adjacencies.

**A relation must link objects.** A one-link relation whose entries carry the data (a contact's phone numbers as
entries holding `number`) is not legal. Make the data an object and link it to its owner.

**Cardinality comes from `unique(S)`.** The links and properties outside `S` determine `S`, so they form a key. Pick
from the patterns in
[FRAMEWORK.md, Cardinality](https://github.com/pitaman71/mbse-schemas/blob/main/docs/FRAMEWORK.md#cardinality):
ownership, keyed ownership, directory, and global ID directory.

**Union or intersection?** Both have named members, and their values are records keyed by those names. A union value
holds exactly one branch (`{"phone": {"number": "1"}}`), and setting one clears the other; which branch it holds is
data, so nothing evaluates predicates. An intersection value holds every part (`{"stamp": {...}, "audit": {...}}`).
Parts do not merge: each keeps its own properties, so two parts may declare the same name.

**Define in phases.** Objects and relations refer to each other, so first create the objects, then the relations,
then add each object's adjacencies with `OfObject.Builder(existing).relations(...).update()`.

**Evolving a schema.** Add properties freely, since old data lacks them and nothing is mandatory. Never reuse a name
with a new type.

## Go deeper

| Topic | Read |
|---|---|
| Relations instead of lists, adjacencies, entries as shared facts | [tutorial 2, An address book](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/02_An_Address_Book.ipynb) |
| Self-relations, cycles, links filled by several kinds | [tutorial 4, A family tree](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/04_A_Family_Tree.ipynb) |
| `unique(...)`, maps as relations | [tutorial 5, A price list](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/05_A_Price_List.ipynb) |
| Optional fields, versions, directories, unions and intersections | [tutorial 9, When requirements change](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/09_When_Requirements_Change.ipynb) |
| Every element and rule | [FRAMEWORK.md, Elements](https://github.com/pitaman71/mbse-schemas/blob/main/docs/FRAMEWORK.md#elements) |
