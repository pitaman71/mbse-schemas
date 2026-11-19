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
   A value object of a refinement is held wherever what it refines is declared: a property, a container's element, a
   union's branch, a value of any schema restricted to it. Build it standalone through the store's builder of its name
   and give it; a Spec builds the declared schema. It reads as itself, and is written with its schema named,
   `{"$schema": "D.Lambda", ...}`, read back as it, never guessed. A flat union takes the branch of the value's own
   schema, else the one branch whose schema it refines, and refuses several; a container's index is of its own schema
   only. [CAP-251: values of a refinement held where what it refines is declared](mbse:mbse-basis/docs/capabilities/CAP-251.md).
   - Python: [T11.1: A refinement: a resistor is a part](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.1) · TypeScript: [T11.1: A refinement: a resistor is a part](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.1)
   - Python: [T11.2: Narrowing a member: a chip mounts on the surface](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.2) · TypeScript: [T11.2: Narrowing a member: a chip mounts on the surface](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.2)
   - Python: [T11.3: Validating a refinement's object against what it refines](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.3) · TypeScript: [T11.3: Validating a refinement's object against what it refines](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.3)
   - Python: [SCH-24: Refinement: a schema refines one of its own kind](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-24) · TypeScript: [SCH-24: Refinement: a schema refines one of its own kind](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-24)
   - Python: [SCH-25: Narrowing to a union's branch](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-25) · TypeScript: [SCH-25: Narrowing to a union's branch](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-25)
   - Python: [SCH-26: A refinement is the same whether refines comes before its own members or after them](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-26) · TypeScript: [SCH-26: A refinement is the same whether refines comes before its own members or after them](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-26)
   - Python: [SCH-27: A refinement's value held where what it refines is declared](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-27) · TypeScript: [SCH-27: A refinement's value held where what it refines is declared](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-27)
   - Python: [SCH-28: A refinement's value where several schemas are open](mbse:mbse-schemas/python3/tests/01_Schemas.ipynb#SCH-28) · TypeScript: [SCH-28: A refinement's value where several schemas are open](mbse:mbse-schemas/typescript5/tests/01_Schemas.ipynb#SCH-28)
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
   (`for_object`). `Parametrics.validate(store, schema)` checks them; a schema's own `validate()` does not. A schema
   neither assigns nor binds its parameters. A parameter reference, `References.OfParameter`, built through its `name`
   alone, designates a parameter by its name and holds nothing else. It is a value, written and read as any value is.
   Its parameter context resolves it, not a store, and `References.of` makes none.
   [CAP-171: parameters attached to every schema kind by extension](mbse:mbse-basis/docs/capabilities/CAP-171.md),
   [CAP-112: parameters modeled as schema data](mbse:mbse-basis/docs/capabilities/CAP-112.md),
   [CAP-311: references stabilized](mbse:mbse-basis/docs/capabilities/README.md#CAP-311).
   - Python: [T11.5: Parameters: a bus as wide as each design needs](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.5) · TypeScript: [T11.5: Parameters: a bus as wide as each design needs](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.5)
   - Python: [PAR-02: Every kind of schema declares a set of parameters](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-02) · TypeScript: [PAR-02: Every kind of schema declares a set of parameters](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-02)
   - Python: [PAR-03: Validation checks a set's entries](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-03) · TypeScript: [PAR-03: Validation checks a set's entries](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-03)
   - Python: [REF-11: A parameter reference holds its parameter's name and nothing else](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-11) · TypeScript: [REF-11: A parameter reference holds its parameter's name and nothing else](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-11)
10. **Assigning and binding parameters.** *Why*: a schema declares its parameters once, and each object that the schema
   governs chooses its own: one bus is eight bits wide, another one bit. *When*: a reference object assigns a value to
   a parameter for a value, and binds a parameter for an object to an object, where its schema declares the parameter;
   a value object is never linked, so that it does neither, and an expression term binds parameters in
   mbse-expressions. *How*: after `Parametrics.install` and the schema's own install, `Parametrics.extend(txn,
   [schemas])` gives each reference object schema two adjacencies, `assigned_values`, to `Parametrics.AssignsValue`,
   and `bound_objects`, to `Parametrics.BindsObject`; run again, it writes nothing. An entry of `assigned_values` links
   the parameter (`param`) and holds the value (`value`); an entry of `bound_objects` links the parameter and the object
   bound (`obj_ref`), which may be any reference object, whose schema opts into nothing. A parameter the object neither
   assigns nor binds stays unbound. A transaction that assigns or binds a parameter which the object's schema does not
   declare is refused when it commits, and `Parametrics.validate(store, object)`, within a transaction, reports such an
   assignment or binding already held. Whether an assignment's value, or a binding's object, is of its parameter's
   schema is not checked: a dialect defines its own statements that assign or bind parameters, and its procedures
   interpret them ([CAP-313: parameter references valid where their parameters are assigned or bound](mbse:mbse-basis/docs/capabilities/README.md#CAP-313)).
   [CAP-314: parameters bound by the data objects their schema governs](mbse:mbse-basis/docs/capabilities/README.md#CAP-314).
   - Python: [T11.8: Assigning parameters: each bus assigns its width](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.8) · TypeScript: [T11.8: Assigning parameters: each bus assigns its width](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.8)
   - Python: [PAR-05: `extend` gives a reference object schema the adjacencies through which its objects assign and bind; it refuses a store without Parametrics, a value object schema and a member's name taken; run again, it writes nothing](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-05) · TypeScript: [PAR-05: `extend` gives a reference object schema the adjacencies through which its objects assign and bind; it refuses a store without Parametrics, a value object schema and a member's name taken; run again, it writes nothing](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-05)
   - Python: [PAR-06: An object assigns a value to a parameter its schema declares, and binds one to an object of any schema, which opts into nothing; a parameter it neither assigns nor binds stays unbound](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-06) · TypeScript: [PAR-06: An object assigns a value to a parameter its schema declares, and binds one to an object of any schema, which opts into nothing; a parameter it neither assigns nor binds stays unbound](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-06)
   - Python: [PAR-07: An assignment or a binding of a parameter its object's schema does not declare refuses its transaction when it commits; validation reports one already held, and a snapshot reads it back as written](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-07) · TypeScript: [PAR-07: An assignment or a binding of a parameter its object's schema does not declare refuses its transaction when it commits; validation reports one already held, and a snapshot reads it back as written](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-07)
   - Python: [PAR-08: A schema neither assigns nor binds its parameters: no kind of schema has an adjacency to an assignment or a binding, each links an `object`, and extending a schema of schemas is refused](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-08) · TypeScript: [PAR-08: A schema neither assigns nor binds its parameters: no kind of schema has an adjacency to an assignment or a binding, each links an `object`, and extending a schema of schemas is refused](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-08)
11. **A parameter reference in place of a value.** *Why*: a model that leaves a value to a parameter (a size, a corner,
   an element) holds the parameter's reference where the value would be, so that the schema stays as it is. *When*:
   wherever a value of any schema is expected: a property's scalar or value object, a container's element, a union's
   branch, an intersection's part, an entry's property; and in the place of an object a link links. *How*: give the
   reference as the value (`b.size(n)`, `[1, n, 3]`, a branch or a part called with `n`), or build it in place through
   `Visitors.OfAny.as_parameter`, with a callback that writes its `name`; give it to a link as an object is given
   (`e.to(n)`, `x.next([n])`). `as_parameter` reads it back; every other visitor reads the place as empty, as it
   reads an unset value, so that code that never meets a parameter reference sees no change. A link that holds one
   reads as an empty object visitor, whose `as_parameter` hands it over. Where the place's schema
   could take the reference for its own value, the plain form marks it, `{"$schema": "References.OfParameter", "name":
   "n"}`, and reads it back the same; a link set refers to it so, beside a symbol or a path. Validation reports no wrong value for it, and an intersection's part that holds one
   is held; validation checks it against its parameter context (item 12). A comparison that meets one halts and says
   incomparable. A relation that owns what it links takes none. [CAP-312: a parameter reference in place of anything with a schema](mbse:mbse-basis/docs/capabilities/CAP-312.md#decided).
   - Python: [REF-12: A parameter reference stands in the place of anything with a schema](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-12) · TypeScript: [REF-12: A parameter reference stands in the place of anything with a schema](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-12)
   - Python: [REF-13: A parameter reference in another schema's place written marked, and read back the same](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-13) · TypeScript: [REF-13: A parameter reference in another schema's place written marked, and read back the same](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-13)
   - Python: [REF-14: Validation accepts a parameter reference in any place](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-14) · TypeScript: [REF-14: Validation accepts a parameter reference in any place](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-14)
   - Python: [REF-15: A place that holds no parameter reference reads as empty through as_parameter](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-15) · TypeScript: [REF-15: A place that holds no parameter reference reads as empty through as_parameter](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-15)
   - Python: [REF-16: A parameter reference in the place of an object a link links](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-16) · TypeScript: [REF-16: A parameter reference in the place of an object a link links](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-16)
   - Python: [REF-17: A link to a parameter reference written in a link set and read back the same](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-17) · TypeScript: [REF-17: A link to a parameter reference written in a link set and read back the same](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-17)
12. **Parameter references checked against a parameter context.** *Why*: a parameter reference is valid only where
   what gives its parameter a value or an object gives one of the schema its place expects, and validation finds the
   reference given the wrong thing. *When*: whenever data holds parameter references; give a context where your
   application, or a dialect's procedure that interprets its own statements that assign or bind parameters, knows what
   each parameter is. *How*: a parameter context is a plain mapping from a parameter's name to the value assigned to it,
   or to the object or symbol bound to it. Every entry point of `Validators.Validate` and `Validators.Check` takes one
   as an optional last argument, empty by default; validation makes no sub-context of its own. A reference is
   **invalid** where the context maps its parameter to the wrong kind of thing (an object where a value is expected, a
   value where an object is) or to something of another schema, and `Validate` reports it; **partial**, and valid,
   where the context does not map its parameter, which `Validate` does not report and `Check` lists in
   `Outcome.partials`; and **bound**, and valid, where the context maps it to a value or an object of the place's
   schema. `Outcome.result` is "invalid", "partial" or "bound". Data that holds no parameter reference validates as it
   does without a context.
   [CAP-313: parameter references valid where their parameters are assigned or bound](mbse:mbse-basis/docs/capabilities/README.md#CAP-313).
   - Python: [PAR-09: Validation takes a parameter context at every entry point; a reference it maps to the right schema is bound](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-09) · TypeScript: [PAR-09: Validation takes a parameter context at every entry point; a reference it maps to the right schema is bound](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-09)
   - Python: [PAR-10: A reference whose parameter its context maps to nothing is partial, and valid](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-10) · TypeScript: [PAR-10: A reference whose parameter its context maps to nothing is partial, and valid](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-10)
   - Python: [PAR-11: A reference is invalid where its context maps its parameter to the wrong kind of thing or another schema](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-11) · TypeScript: [PAR-11: A reference is invalid where its context maps its parameter to the wrong kind of thing or another schema](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-11)
   - Python: [PAR-12: Data that holds no parameter reference validates as without a context](mbse:mbse-schemas/python3/tests/22_Parametrics.ipynb#PAR-12) · TypeScript: [PAR-12: Data that holds no parameter reference validates as without a context](mbse:mbse-schemas/typescript5/tests/22_Parametrics.ipynb#PAR-12)
13. **Schema and value references.** *Why*: data that designates a schema, or holds a value whose schema is not fixed,
   is schema data like any other, written and read with no code of its own. *When*: a context, a request or a model
   names a schema, or carries a value of any schema, by reference. *How*: a schema object's reference,
   `References.OfSchema`, refines `References.OfObject`: build it through its `path`, a schema object's path
   (`Paths.of(schema)`), which starts from the root module, the singleton `"."`. Writing or reading one whose path does
   not start there is refused. Where a `References.OfObject` is declared, it is written marked with its schema, and a
   map's symbol given it binds the schema object. A schema argument, as in `References.OfSchema[Schemas.OfObject]`,
   constrains the kind of schema that the reference designates: `References.validate_schema(store, reference, kind)`
   reports a reference that designates a schema of another kind (`kind` a schema of schemas, such as
   `store.Schemas.OfObject`), or no schema object the store holds; with no kind, it checks the rest. A value reference,
   `References.OfValue`, holds a value of any schema in its one property, `value`, written tagged with its schema, as
   a value of any schema is (item 8).
   [CAP-320: schema and value references](mbse:mbse-basis/docs/capabilities/README.md#CAP-320).
   - Python: [REF-18: A schema object's reference refines References.OfObject; one whose path does not start at "." refused](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-18) · TypeScript: [REF-18: A schema object's reference refines References.OfObject; one whose path does not start at "." refused](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-18)
   - Python: [REF-19: A value reference holds a value of any schema](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-19) · TypeScript: [REF-19: A value reference holds a value of any schema](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-19)
   - Python: [REF-20: A schema argument constrains the kind of schema a schema object's reference designates](mbse:mbse-schemas/python3/tests/33_References.ipynb#REF-20) · TypeScript: [REF-20: A schema argument constrains the kind of schema a schema object's reference designates](mbse:mbse-schemas/typescript5/tests/33_References.ipynb#REF-20)

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
<!-- no case: points to the design for reading further -->

The meta-schemas and their builders are [CAP-109: schemas as linked objects in modules](mbse:mbse-basis/docs/capabilities/CAP-109.md#the-meta-schemas-and-their-builders-as-built).
