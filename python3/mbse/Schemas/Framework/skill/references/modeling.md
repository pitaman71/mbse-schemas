# Modeling with mbse-schemas

How to express an interface or data model with the schema elements. The same model works in every language.

## Concepts mapped to elements

| Concept (SysML / UML / ORM / JSON Schema) | Element |
|---|---|
| Block, class, entity, table row: anything with identity | registered `OfObject` marked `.ref()` |
| Primitive attribute, value property | `OfScalar` property |
| Structured value without identity (UML datatype, SysML value type with parts, ICD signal description) | value object: a property whose schema is an `OfObject` |
| Association, reference property, pointer, foreign key | `OfRelation` linking the objects, with an adjacency on each side |
| Association class, association block, join table with columns | `OfRelation` with properties |
| Composition, part property (each part has at most one whole) | `.links("whole", "part").unique("whole")` |
| Multiplicity upper bound (0..1) | a `unique(...)` clause |
| Multiplicity lower bound (1, 1..*) | not expressible yet: constraints are planned |
| Qualified association, map, dictionary | relation with a key property: `.unique("owner", "key")` |
| Ordered list of values or parts (tags, a component's ports) | a one-link relation, inline in its adjacency, whose entries hold the value: `r.name("tags").me("owner").of(lambda rel: rel.links("owner").properties(text("value")))`, scalars or value objects |
| Dictionary, associative array, sparse tensor (values by key) | the same with a key property and `unique` over the value: `.properties(text("key"), text("value")).unique("value")`; the key may be a scalar or a value object (e.g. `{row, col}`), and several properties (`i`, `j`) key a matrix |
| Fixed-size array, dense tensor dimension | a list keyed by an integer property; its bounds are a constraint on that property's type, which is planned |
| Ordered list of shared objects | relation with an index property: `.links("owner", "item").properties(index).unique("owner", "index")` |
| Tagged union, variant, `oneOf`, `xsd:choice` | `OfUnion`: named, same-kind branches; a value holds exactly one |
| Mixin, aspect, `allOf` | `OfIntersection`: named, same-kind parts; a value holds every one. Supported for property values. Objects with identity composed from aspects are not yet |
| Singleton, global registry | `OfObject.Builder().singleton("Name")`, usually with a directory relation |
| Port and connector | ports as value objects in a list of their component; connectors as a relation between ports, carrying the connection's properties |
| Template, generic, parameterized block or type (UML/SysML template parameters, C++ templates, SystemVerilog `parameter`s) | `.parameters(...)` on the schema; a use of it with arguments is an `OfApply` (`S.OfApply.Builder().of(Matrix).arguments(rows=2, cols=3)`, by parameter name) |
| Bit width given by a parameter | a term where the scalar's width stands: `.bits(w)`. An array's size or a tensor's shape is a constraint on its index properties' types, which is planned |
| Documentation, comment, `description` | `.description(text)` on the element's builder: a schema, property, adjacency, branch or part |
| Enumeration of literals | a scalar (e.g. `str`); restricting its values needs constraints, which are planned |

## Decisions

**Reference object or value object?** Use a reference object, whose schema is marked `.ref()`, if the thing is shared
by several owners, navigated back from, part of a cycle, or referred to by identity; it is reached through relations
and never held by a property. Otherwise use a value object: a property holds it, it is copied by
value and written nested. A value object has an identity too, and may have adjacencies: a component's ports, say, as
value objects linked by connectors.

**A one-link relation is a list.** Its entries hold values for their one owner (a contact's own phone numbers as
entries holding `number`); declare it inline in the adjacency, `.of(lambda rel: rel.links("contact").properties(...))`.
Data that several objects share is an object, linked to each.

**Set or list comes from `unique`.** A relation with a `unique` clause holds a set, and an equal entry is elided; one
without is open, its entries a list, equal entries kept. `.unique()` names nothing and only makes it a set.

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
| Every element and decision | [FRAMEWORK.md, Elements](https://github.com/pitaman71/mbse-schemas/blob/main/docs/FRAMEWORK.md#elements) |
