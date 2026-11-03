# Designing and extending schemas

Schemas are data. Every schema is an object in its store, of a plain schema of schemas (`store.Schemas.OfObject`, ...),
the store's own, and every named one is in a module, its name's prefix
([CAP-109: schemas as linked objects in modules](mbse:mbse-basis/docs/capabilities/CAP-109.md)). A module defines its
schemas in a module-scope `install(txn)`: one upsert, each schema a symbol of its kind, found by its name, else made,
its spec the same fluent calls its builder takes. Run again, an install writes nothing; another adds to what it finds,
or removes from it. So installs design a schema, extend one that exists or remove its members, refine one, or generate
schemas from anything a program holds; the builders make a new version beside a schema.

## Each task

1. **Design.** *Why*: one description, found by its name, that every program shares. *How*: an install's symbols are
   its schemas, each of its kind; its spec names each (`.name(...)`, identifiers separated by dots, the module first)
   and gives its members, each named by its entry: properties mapped to their schemas, adjacencies to their relation
   and link, a relation's links and `unique` clauses, a union's branches, an intersection's parts, a container's index
   and element. A schema with no name of its own (a value object, a container) is defined where it is linked. A
   reference to another schema object is a list of what it links, even where only one is allowed; a member that
   exists is linked with `.property(...)` rather than built again. Patterns, with their symbols, variables and
   constraints, are schemas too, defined the same way.
   [CAP-115: schemas defined by idempotent installs](mbse:mbse-basis/docs/capabilities/CAP-115.md).
   - Python: [T01.1: Describing the record](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.1) · TypeScript: [T01.1: Describing the record](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.1)
   - Python: [T02.1: The schemas](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.1) · TypeScript: [T02.1: The schemas](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.1)
   - Python: [INS-01: A module's install defines its schemas, each kind a symbol of its meta-schema](mbse:mbse-schemas/python3/tests/32_Installs.ipynb#INS-01) · TypeScript: [INS-01: A module's install defines its schemas, each kind a symbol of its meta-schema](mbse:mbse-schemas/typescript5/tests/32_Installs.ipynb#INS-01)
   - Python: [INS-02: A schema with no name of its own, defined in a spec where it is linked](mbse:mbse-schemas/python3/tests/32_Installs.ipynb#INS-02) · TypeScript: [INS-02: A schema with no name of its own, defined in a spec where it is linked](mbse:mbse-schemas/typescript5/tests/32_Installs.ipynb#INS-02)
   - Python: [BLD-04: A schema's members](mbse:mbse-schemas/python3/tests/25_Builders.ipynb#BLD-04) · TypeScript: [BLD-04: A schema's members](mbse:mbse-schemas/typescript5/tests/25_Builders.ipynb#BLD-04)
   - Python: [PAT-01: A pattern: symbols, variables and constraints, in order, each its own; validated](mbse:mbse-schemas/python3/tests/30_Patterns.ipynb#PAT-01) · TypeScript: [PAT-01: A pattern: symbols, variables and constraints, in order, each its own; validated](mbse:mbse-schemas/typescript5/tests/30_Patterns.ipynb#PAT-01)
2. **Extend.** *Why*: a new requirement changes the one schema every program reads, not a copy. *How*: another
   install names the schema by its name in its spec, and adds members; objects built before read an added member as
   absent, and its refinements gain it. A transaction's schema changes take effect when it ends: write data that uses
   them in the next one.
   [CAP-116: framework schemas extended, checked](mbse:mbse-basis/docs/capabilities/CAP-116.md).
   - Python: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/python3/tutorials/02_An_Address_Book.ipynb#T02.7) · TypeScript: [T02.7: Phones: a list for one contact, or objects to share](mbse:mbse-schemas/typescript5/tutorials/02_An_Address_Book.ipynb#T02.7)
   - Python: [T09.1: Adding a property](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.1) · TypeScript: [T09.1: Adding a property](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.1)
   - Python: [EXT-01: An install adds members to the schemas a store holds](mbse:mbse-schemas/python3/tests/28_Extensions.ipynb#EXT-01) · TypeScript: [EXT-01: An install adds members to the schemas a store holds](mbse:mbse-schemas/typescript5/tests/28_Extensions.ipynb#EXT-01)
3. **Remove a member.** *Why*: a member that no longer applies must go from every program at once. *How*: an install's
   spec removes each entry agreeing with a template, as an adjacency's visitor does (`remove`, given the member's name);
   run again, the entry is absent and nothing is written.
   - Python: [T09.2: A second version, side by side](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.2) · TypeScript: [T09.2: A second version, side by side](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.2)
   - Python: [INS-05: An install removes members of the store's own schemas, each entry by its name](mbse:mbse-schemas/python3/tests/32_Installs.ipynb#INS-05) · TypeScript: [INS-05: An install removes members of the store's own schemas, each entry by its name](mbse:mbse-schemas/typescript5/tests/32_Installs.ipynb#INS-05)
4. **Version.** *Why*: old data, and programs that read it, keep the old schema while new ones use the new.
   *How*: a named schema's path is its name, so a store holds one schema per name: clone it with a schema builder in
   the store, under a new name, in a module of its own (`crm.v2.Contact`), since a module and a schema never share a
   path. Renaming one moves it to the module its new name gives.
   [CAP-123: schema objects identified by path](mbse:mbse-basis/docs/capabilities/CAP-123.md).
   - Python: [T09.2: A second version, side by side](mbse:mbse-schemas/python3/tutorials/09_When_Requirements_Change.ipynb#T09.2) · TypeScript: [T09.2: A second version, side by side](mbse:mbse-schemas/typescript5/tutorials/09_When_Requirements_Change.ipynb#T09.2)
   - Python: [BLD-03: Paths: a named schema's is its name, a member's its owner's then its name](mbse:mbse-schemas/python3/tests/25_Builders.ipynb#BLD-03) · TypeScript: [BLD-03: Paths: a named schema's is its name, a member's its owner's then its name](mbse:mbse-schemas/typescript5/tests/25_Builders.ipynb#BLD-03)
5. **Refine.** *Why*: a specialization that copies its general schema's members drifts from it. *When*: every object
   of the new schema is one of an existing schema's, with its members. *How*: `.refines([Base])` in the refinement's
   spec, before its own members or after them: it has `Base`'s members and its own, and a member added to `Base`
   later. Its objects fill `Base`'s links and are in its extent, and validate against `Base` as against their own
   schema: either way each is checked by its own. A redeclared member must narrow `Base`'s: a property to the same
   schema or a refinement of it, a container whose index and element each narrow, one of a union's branches' schemas
   (or one narrowing it), a union whose branches are the union's by name, each narrower, or one of the schemas a value
   of any schema may hold. An adjacency is redeclared only with the same relation and link. `validate()` reports what
   it can't confirm. A refinement stays within its kind, object or container; scalars do not refine.
   [CAP-167: schemas refined by other schemas](mbse:mbse-basis/docs/capabilities/CAP-167.md).
   - Python: [T11.1: A refinement: a resistor is a part](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.1) · TypeScript: [T11.1: A refinement: a resistor is a part](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.1)
   - Python: [T11.2: Narrowing a member: a chip mounts on the surface](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.2) · TypeScript: [T11.2: Narrowing a member: a chip mounts on the surface](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.2)
   - Python: [T11.3: Validating a refinement's object against what it refines](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.3) · TypeScript: [T11.3: Validating a refinement's object against what it refines](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.3)
   - Python: [SCH-24: Refinement: a schema refines one of its own kind](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-24) · TypeScript: [SCH-24: Refinement: a schema refines one of its own kind](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-24)
   - Python: [SCH-25: Narrowing to a union's branch](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-25) · TypeScript: [SCH-25: Narrowing to a union's branch](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-25)
   - Python: [SCH-26: A refinement is the same whether refines comes before its own members or after them](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-26) · TypeScript: [SCH-26: A refinement is the same whether refines comes before its own members or after them](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-26)
6. **Generate.** *Why*: schemas often exist already in another form, a table, a spreadsheet, a program's classes.
   *How*: an install is a function of its transaction, so build its spec from that description; run again, it writes
   nothing, and given more, it adds. Python's dataclasses adapter writes such an install from a program's dataclasses.
   - Python: [T11.7: Generated schemas: an install made from a table](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.7) · TypeScript: [T11.7: Generated schemas: an install made from a table](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.7)
   - Python: [DC-09: A program's dataclasses as its schemas, end to end](mbse:mbse-schemas/python3/tests/16_Dataclasses.ipynb#DC-09)
7. **Read a schema as data.** *Why*: tools, generators and documentation read schemas as they read any data. *How*:
   a schema's members are its plain schema's (`properties`, `adjacencies`, `links`, `uniques`), and a schema builder
   started read-only from it reads them through visitors; `store.module(...)` gives a module's schemas by name.
   - Python: [T08.1: Tool 1: a data dictionary, generated from schemas](mbse:mbse-schemas/python3/tutorials/08_Tools_For_Every_Schema.ipynb#T08.1) · TypeScript: [T08.1: Tool 1: a data dictionary, generated from schemas](mbse:mbse-schemas/typescript5/tutorials/08_Tools_For_Every_Schema.ipynb#T08.1)
   - Python: [BLD-08: Reading back: members are child visitors; a link reads its referent, read-only](mbse:mbse-schemas/python3/tests/25_Builders.ipynb#BLD-08) · TypeScript: [BLD-08: Reading back: members are child visitors; a link reads its referent, read-only](mbse:mbse-schemas/typescript5/tests/25_Builders.ipynb#BLD-08)
   - Python: [SNP-01: Every schema is in a module](mbse:mbse-schemas/python3/tests/27_Snapshots.ipynb#SNP-01) · TypeScript: [SNP-01: Every schema is in a module](mbse:mbse-schemas/typescript5/tests/27_Snapshots.ipynb#SNP-01)
8. **Values of any schema.** *Why*: some values have no fixed kind, a rating that is a number or a text, a setting of
   whatever type a tool gives. *How*: a value of any schema (`OfAny`) is restricted to the schemas it lists, or, with
   none, takes a value of any schema. A restricted value is written bare where one of its schemas alone fits its plain
   form, and wrapped by its kind and schema where several would; an unrestricted one is tagged by its scalar's or its
   schema's name. A value of no listed schema is refused when written, a bool where only an int is listed included.
   [CAP-157: values of any schema, restricted or not](mbse:mbse-basis/docs/capabilities/CAP-157.md).
   - Python: [T11.4: Values of any schema: a rating, whatever the datasheet gives](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.4) · TypeScript: [T11.4: Values of any schema: a rating, whatever the datasheet gives](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.4)
   - Python: [ANY-06: A restricted value never guessed](mbse:mbse-schemas/python3/tests/24_Any.ipynb#ANY-06) · TypeScript: [ANY-06: A restricted value never guessed](mbse:mbse-schemas/typescript5/tests/24_Any.ipynb#ANY-06)
   - Python: [ANY-07: A restricted value refused when written where its scalar's host type is not exactly one of its scalar schemas'](mbse:mbse-schemas/python3/tests/24_Any.ipynb#ANY-07) · TypeScript: [ANY-07: A restricted value refused when written where its scalar's host type is not exactly one of its scalar schemas'](mbse:mbse-schemas/typescript5/tests/24_Any.ipynb#ANY-07)
9. **Parameters.** *Why*: a schema that varies by a value (a bus's width, a matrix's size) is one schema with
   parameters, not one per value. *How*: install `Parametrics` before use; in a spec, give a schema of any kind a set of
   parameters, each named, described, and for a value of a schema (`for_value`) or an object of an object schema
   (`for_object`). `Parametrics.validate(store, schema)` checks them; a schema's own `validate()` does not. Binding
   them is mbse-expressions'.
   [CAP-171: parameters attached to every schema kind by extension](mbse:mbse-basis/docs/capabilities/CAP-171.md),
   [CAP-112: parameters modeled as schema data](mbse:mbse-basis/docs/capabilities/CAP-112.md).
   - Python: [T11.5: Parameters: a bus as wide as each design needs](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.5) · TypeScript: [T11.5: Parameters: a bus as wide as each design needs](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.5)
   - Python: [PAR-02: Every kind of schema declares a set of parameters](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-02) · TypeScript: [PAR-02: Every kind of schema declares a set of parameters](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-02)
   - Python: [PAR-03: Validation checks a set's entries](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-03) · TypeScript: [PAR-03: Validation checks a set's entries](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-03)

## Practices

- **Link only what the store holds.** A store refuses a link to a schema object it does not hold: build every schema,
  and member, in the store that links it, and link its basic scalars by its paths (`store.Schemas.OfInt`, ...). A
  store builds no other scalar schema.
  - Python: [SCH-08: A property's schema is of a value kind](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-08) · TypeScript: [SCH-08: A property's schema is of a value kind](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-08)
  - Python: [EXT-04: What an install adds to a framework schema is its store's alone](mbse:mbse-schemas/python3/tests/28_Extensions.ipynb#EXT-04) · TypeScript: [EXT-04: What an install adds to a framework schema is its store's alone](mbse:mbse-schemas/typescript5/tests/28_Extensions.ipynb#EXT-04)
- **Name what you share.** A schema object with no name of its own has no path: one schema object alone may link it,
  and the store refuses a second ("name it to share it").
  - Python: [BLD-03: Paths: a named schema's is its name, a member's its owner's then its name](mbse:mbse-schemas/python3/tests/25_Builders.ipynb#BLD-03) · TypeScript: [BLD-03: Paths: a named schema's is its name, a member's its owner's then its name](mbse:mbse-schemas/typescript5/tests/25_Builders.ipynb#BLD-03)
- **A schema the store was made holding only gains members.** The meta-schemas (`Schemas.OfObject`, ...) take new
  members from an extension, in any transaction, but none of theirs changes or goes; a store's own schemas change
  freely.
  - Python: [EXT-02: A schema the store was made holding only gains members, each under a name it neither has nor a refinement of it declares](mbse:mbse-schemas/python3/tests/28_Extensions.ipynb#EXT-02) · TypeScript: [EXT-02: A schema the store was made holding only gains members, each under a name it neither has nor a refinement of it declares](mbse:mbse-schemas/typescript5/tests/28_Extensions.ipynb#EXT-02)
- **Validate when you are done.** Building never validates, so a schema may be incomplete between steps;
  `schema.validate()` lists its problems.
  - Python: [T01.2: Checking the schema, when you ask](mbse:mbse-schemas/python3/tutorials/01_A_Contact_Card.ipynb#T01.2) · TypeScript: [T01.2: Checking the schema, when you ask](mbse:mbse-schemas/typescript5/tutorials/01_A_Contact_Card.ipynb#T01.2)

## Go deeper

The meta-schemas and their builders are [CAP-109: schemas as linked objects in modules](mbse:mbse-basis/docs/capabilities/CAP-109.md#the-meta-schemas-and-their-builders-as-built).
