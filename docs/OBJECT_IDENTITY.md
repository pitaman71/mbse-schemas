<!-- nav -->
[← Meta-schemas overhaul](META_SCHEMAS.md) · [Home](../README.md) · [Open-world modeling →](OPEN_WORLD.md)

# Reference Object Identity

A reference object is identified in one of three ways, which its schema's declarations select (Decided, 37):

| Mode | Declared by | Identity | Lifetime |
|---|---|---|---|
| Singleton | `.singleton(name)` | its path of no steps: its global name, the root of every path | the store's |
| Owned | an adjacency marked `owner()` | its path: the route from a singleton to it through the entries that own it | its owning entry's |
| Counted | neither | none of its own: within a document that writes it, its index in the order the document meets counted objects | the host language's: reference counted, collected once nothing holds it |

Value objects have no identity (9). Nothing is drawn at random: a path is computed from the model, a transaction's id
is given by the program (42), and a counted object is numbered by the document that writes it (55), so the same model
built twice, or in another language, gives the same identities and the same snapshots.

## What takes which mode

- **Singletons**, such as the root module and a directory such as `wts.Features`: by their global names, as before, each the path of no steps.
- **Owned**, through `owner()` adjacencies: named definitions of any kind (usually module scoped, owned by their module
  through `Schemas.Defines`), clauses of a definition and subclauses of a clause, and the instances of a program's
  schemas at the root level of its data model, owned by a singleton directory (37).
- **Counted**: expression terms, and most other objects (37).

There is no framework relation by which a schema owns its instances: `Schemas.HasInstance`, `OfObject.pattern` and the
generated `local-name-N` keys go (41). A schema's identity never becomes part of a path, though a schema object may be a
step in one, as any owner may (12, 30); a schema's name is written only where an object is created, in
`Mutations.OfObject.Exists`, which must know what to build (8).

## Owned objects

`Schemas.OfAdjacency` has `owner()`. An adjacency marked `owner()` points back to the previous element of the object's
path: the object that owns it. The relation it designates has two links, the owner's and the owned's, and must

1. mark the owner link as unique, and
2. mark the owned link, along with any keys, as unique,

for example (the user's, in the builders' syntax):

```python
Directory = store.Schemas.OfObject(lambda o: o.name('Directory').ref(True).singleton('wts.Features'))
Definition = store.Schemas.OfObject(lambda o: o.name('Definition').ref(True))
Defines = store.Schemas.OfRelation(lambda r: (
    r
    .name('Defines')
    .links([
        lambda t: t.name('directory'),
        lambda t: t.name('defn'),
    ])
    .properties([lambda t: t.name('name').schema([store.Schemas.OfStr]).pattern(r'DEF-\d+\d\d')])
    .uniques([['directory', 'name'], ['defn']])  # a definition's one directory and name; they find one definition
))
store.Schemas.OfObject(Directory, lambda o: o.adjacencies([
    lambda t: t.name('dir').relation([Defines]).me('directory'),
]))
store.Schemas.OfObject(Definition, lambda o: o.adjacencies([
    lambda t: t.name('def').relation([Defines]).me('defn').owner(True),  # back to the previous path element
]))
```


A definition's path is then the singleton `wts.Features`, through `dir`, the entry named `DEF-693`, and `def` (Paths
as data). From the owner, the entry's keys select exactly one owned object, and an owned object has exactly one owner,
so a path resolves unambiguously.

Validation refuses an ownership relation of more than two links (14), and an `owner()` adjacency whose owning end a
counted schema can fill: nothing is owned by a counted object, so every path ends at a singleton (47).

`Schemas.Defines` already has this shape: it links a module to a schema with the entry's `name`, declared
`.uniques([["module", "name"], ["schema"]])`, FRAMEWORK.md's Directory pattern. Modules and schemas therefore take part
like any other owned object: a schema's path runs from the root module through `Defines` entries, by name (17). An
unnamed schema linked through a relation no key names (the container schema of `crm.Person.tags`, through
`Schemas.HasSchema`) is a subclause owned through that link, its step one with no keys (29).

The peer shorthand's visitor is the union of an entry and the object it links: the entry's link and properties first,
then the linked object's members. An ownership entry's keys therefore hide the linked object's properties of the same
name, and `t.name(...)` writes the path where the relation declares `name` and the object where it does not. The
explicit form says which: `d.dir(lambda a: a.insert(lambda e: e.name('DEF-693').defn(spec)))`, where `e` is the entry.

### Naming

A key that continues a path may take a naming pattern, on the ownership relation's key property:
`Schemas.OfProperty.pattern(r"DEF-\d+\d\d")`. Where a key is not given, its value is generated from the pattern,
strictly increasing among the owner's entries; a value given that does not match the pattern raises when written:
`e.name('hello')` against `DEF-\d+\d\d` (13, 22). Patterns are only on such key properties (41).

### Building

An owned object can be built in the apparently isolated manner of today. When its transaction ends, an object whose
ownership adjacency is still empty is given the one owner possible, the singleton at the owning end, its keys generated
from their patterns; where none or more than one is possible, the transaction aborts, naming the ownership missing
(15, 33).

### Deleting

Removing an owned object's owning entry deletes it, and in cascade everything it owns, within the transaction; a
counted object it linked lives on while anything else holds it (48).

## Counted objects

A counted object has no identity outside the document that writes it (55). Nothing finds it except by visiting what
links it (40), and a later transaction reaches it the same way, through a symbol whose locator starts at an owned object
or a singleton and follows links, so no later transaction refers to it by a name. Within one document, a snapshot or a
Reachable transaction, it is numbered in the order the document meets counted objects, so that two links to it stay
one object and cycles close: a reference is `{"$ref": {"n": <index>}}`, beside `{"$ref": <path>}`, by which an owned
object and a singleton alike are referred to (a singleton's path has no steps). Reading the document gives each its own
new object; the numbers mean nothing after.

A counted object an upsert creates in a mutation expression has an identity, though: the frame that reached the upsert,
an instance of the upsert's pattern, the upsert's `key`, and the symbol it is created for, which tells apart the objects
one upsert creates from one frame (61, 63). Running the expression again yields the same frame and key, so the upsert finds the object rather than
creating another. The query executor finds such an object by them, through an index it holds weakly, so that it keeps
no counted object alive; a program still cannot (40). On the wire the frame is written as any instance of its pattern
is, each symbol a reference and each variable its value, so a reference to such an object is
`{"$ref": {"frame": <frame>, "key": <key>, "symbol": <symbol>}}`, recursively where the frame binds another.

A counted object is created by a transaction, by a verb or through a symbol (a `Mutations.OfUpsert` of a putative
object in a mutation expression, [Mutations as queries](STREAMING_QUERIES.md)); a clone is a creation in the transaction
that clones (46, 54). It lives while anything holds it, an object that links it or the program, as the host language
decides; the store does not keep it alive.

## Reading and finding

A program does not read or write an identity through the visitor: `as_identity` goes (43). An owned object's path is
read off its ownership entries on demand, as a `Paths.OfRoot` value, by `Paths.of(obj)` (32). A program finds:

- a singleton by its global name, `store.Instances.wts.Features` (26);
- an owned object by calling an adjacency with the keys of the entry that leads to it, on any adjacency:
  `store.Instances.wts.Features.dir({ name: 'DEF-693' }).clauses({ name: 'C-1' })` (in Python, a mapping:
  `.dir({'name': 'DEF-693'})`); keys no entry has raise (26 to 28);
- a counted object only by visiting what links it (40).

Reading a snapshot or a journal is the one way an object is given an identity it did not get by being built: the same
path appearing again is an update of the owned object or singleton that has it, through its builder, where update is
allowed. A counted object read from a document is always a new one (55).

## Locators

A pattern's symbols ([Mutations as queries](STREAMING_QUERIES.md)) sometimes specify a locator expression. These
expressions are represented by an ordinary schema over these kinds:
- `Locators.OfSymbol` # name, next
- `Locators.OfSingleton` # schema, next
- `Locators.OfRelation` # schema, adjacency, link, properties, next

Only `Locators.OfSymbol` or `Locators.OfSingleton` may be used as the root of a locator expression.

```python
Locators.OfRelation.schema: Schemas.OfRelation
Locators.OfRelation.adjacency : str # denotes name of adjacency to current obj
Locators.OfRelation.link : str # denotes name of link to next obj
```

Locators target reference objects, not value objects.
Locators can only traverse named adjacencies.
Builder shorthand makes locators a path language:
`l.singleton(Directory).dir({"name": "DEF-693"}).clauses({"name": "C-1"})`.

A locator is not an identity: it is a route a query follows, which may reach many objects, or a counted object, which
has no path; "path" names identities only (64). A hop yields every object its entry's properties match, so a frame fans
out where they leave the match open, and a frame whose locator reaches nothing yields no frame (65). An upsert of an
owned object places it by a hop through its owning adjacency, which gives owner and keys (60).

## Transactions

Every write to a store is part of a transaction (44): building, cloning and updating any object, owned, counted or a
singleton's, and so every schema built. `Mutations.OfTransaction` is the schema of one: its id and its list of
mutations (38). It is strictly the root of what a program applies, so transactions cannot nest: the schema does not
let one hold another (50). A program applies one by `store.mutation(mv)`, `mv` a `Visitors.OfMutation` whose `.uid()` gives the
transaction's UUID; the program provides it, and nothing draws one at random (42). Mutation visitors are the builders a
program is given whenever it calls a property with a callback, on an object, `<object_path>.<propName>(cb)`, or on a
relation's entry, `<rel_entry_path>.<propName>(cb)` (58): what such a builder writes is a mutation verb,
`Mutations.OfX.Y` (`OfProperty.Set`, `OfContainer.Insert`, `OfAny.AsObject`, ...), so the verbs stay, the write side of
the visitor protocol, and a transaction's terms ([Mutations as queries](STREAMING_QUERIES.md)) carry them.

A transaction holds the terms of a mutation expression ([Mutations as queries](STREAMING_QUERIES.md)). The query
executor may divide its execution into shards (52, 53), allocating their ids, but shards are the executor's alone: what
a transaction does does not depend on how it is sharded, so nothing records them, and a journal holds the transactions
as submitted, replayed by executing them again (56). Where execution would otherwise depend on the order in which
frames arrive, it is made independent of it (57).

A transaction that aborts, for any reason, changes nothing in the store of any kind (46): its creations are never made,
and its other writes are undone.

Snapshots are made of transactions (45): reading one replays them. The counted objects a snapshot holds are numbered
within it (55), and later transactions reach them through what links them.

A Reachable document, the one graph a program sends without its store (an expression tree, a syntax tree), is one
transaction (51): its creations are the counted objects reachable from the root, the root first, numbered in
first-reference order (55), under a uid the caller gives; the owned objects and singletons the graph links are referred to by path, not
included, and resolved in the reader's store, reading aborting where one is missing. Reading the
document applies it as a transaction. A document that must carry owned objects too is a store's snapshot.

## Paths as data

`Paths.OfX` are nestable value objects:

- `Paths.OfRoot` bears two properties: `singleton`, a globally unique singleton name, and `next`, a
  `Union[entry: Paths.OfEntry, target: Paths.OfTarget]`.
- `Paths.OfEntry` bears four properties: `i`, the name of the adjacency to the object addressed by the previous path
  element; `o`, the name of the adjacency to the object addressed by the next path element; `properties`, a value
  object literal assigning each property of the transited relation the value that uniquely continues the path to the
  target via this relation; and `next`, a `Union[entry: Paths.OfEntry, target: Paths.OfTarget]`.
- `Paths.OfTarget`: no more traversals, the object is found.

A key's value is a bool, an int or text, so that `properties` is written bare (`{"name": "DEF-693"}`): a float or bytes
would not be told apart from an int or text on the wire. Every store holds the path schemas, its own, as it holds its
mutation schemas.

A path has no shorthand: it is written as the nested value object it is, as any value is (mbse-basis P-019). The
definition the Ownership example places, on the wire, its unions tagged by branch:

```json
{"singleton": "wts.Features", "next": {"entry": {
    "i": "dir", "o": "def", "properties": {"name": "DEF-693"}, "next": {"target": {}}}}}
```

---

## Decided

As the user decided (2026-10-16), on the questions put to them:

1. A suffix is looked up by `as_instance`: "yes use as_instance". A suffix need not be an identifier (`FEA-001`, `Anna
   Baker`, a UUID), so `store.Instances.<path>.as_instance(suffix)` takes it as a string: the one place an object's
   identity references it (mbse-basis P-015, Exceptions); the path is attributes. (How a path given as data reaches
   `as_instance`, now that an identity is a path rather than a suffix, is open; see below.) (Superseded by 26: a path's
   step is looked up by calling its adjacency with the entry's keys.)
2. Namespaces are modules: "Use Schemas.OfModule instead of Schemas.Namespace".
3. A schema is an object's module path where none is given: "yes the schema itself is the default container" (the
   identity's path is a module path, "it was never container path"). (Superseded by 12 and 14: a path starts at a
   singleton, and a schema's identity never becomes part of one.)
4. On the wire: "use `Schema@Path/Suffix` and omit `Schema@` when it can be inferred from context". (Superseded by 8
   and 12: an identity is a path; `Schema@` only in `Exists`.)
5. "Programs cannot set or modify their identity": "yeah that rule is completely gone". (Superseded by 16:
   `as_identity` is read-only again outside deserialization.)
6. A suffix given for a schema with a `ref` pattern that it does not match: "raise". (The pattern moves to a property,
   13; a value given that does not match it still raises, 22.)
7. `as_identity`'s callback visits the identity: "yes, Schemas.OfIdentity now is an object" (its `suffix` and its
   module path, `module`). (Superseded by 18: an identity is a path, `Paths.OfX` value objects.)
8. `Schema@` is written only where an object is created, in `Mutations.OfObject.Exists`, which must know what to
   build; everywhere else the path references the object, "the path is sufficient to reference the object without the
   schema", since "there is one directory store per module within each store".

As the user decided later (2026-10-16), "I finally get what you are trying to communicate about UUIDs breaking some
assumptions about reentrancy":

9. "value objects still do not need an identity".
10. "all reference objects may need a computed name".
11. "singletons, such as the root module, will form the root of all paths to any non-singleton reference object".
12. "schema identity never becomes part of a path. it is only present on Mutations.OfObject.Exists".
13. "the name-picking regex moves out of Schemas.OfObject.ref(), which no longer takes a pattern at all, and into
    Schemas.OfProperty.pattern(r"FEA-\d+\d\d")".
14. "Schemas.OfAdjacency gains 'owner()' which if marked means the adjacency points back to the previous identity path
    element. The designated relation must (a) mark the owner link as unique and (b) mark the owned link along with any
    keys as unique. This should make path resolution unambiguous.", with `Defines` as Ownership gives it:
    `.unique('directory', 'name').unique('defn')`, FRAMEWORK.md's Directory pattern.
15. "building a non-singleton reference object can be coded in the apparrently isolated manner as it is today.
    However, the builder must recursiely trace ownership links back to a singleton. If the ownership adjacency is
    already populated according to the builder, recursion continue. Any adjacencies along the ownership path not
    already extant (as a relation entry) will need to be added and any property values for that relation entry will
    need to be generated per their regex."
16. "as_identity can resume being read-only for code outside of deserialization". (Superseded by 43.)
17. "the default module path gets ported over so that modules and schemas participate in this mechanism".
18. Paths are data, `Paths.OfX`, "nestable value objects": `Paths.OfRoot`, `Paths.OfEntry` (its `i`, `o`,
    `properties` and `next`) and `Paths.OfTarget`, as
    Paths as data gives them, with the shorthand `path.to.root.singleton` `.{inAdj}-{entryProps}>{outAdj}` ...,
    for example `wts.Features.dir-{name:"FEA-693"}>def`, "oftarget is implied". (The shorthand is superseded by 23.)
19. "the UUID mechanism can come out entirely". (Superseded by 38: every transaction has a UUID.)
20. A "non-singleton reference object whose schema has no owner() adjacency: validation rejects the new reference
    object schema not having an ownership path". (Superseded by 37: such an object is counted.)
21. "Every reference object must participate in this process via an ownership adjacency: named definitions of any
    kind (usually module scoped), clauses of a definition, subclauses of a definition clause". (Narrowed by 37: most
    other objects, expression terms among them, are counted.)
22. A key value given that does not match its property's pattern: "raise when written".
23. No shorthand: "Maybe we should do without shorthand. Just write the path as a nested value object."
24. `Paths.OfEntry`'s `in` and `out` are named `i` and `o` ("just call them i and o"), since `in` is a Python keyword
    and a schema's properties are its builders' and proxies' members.
25. `next` is `Union[entry: Paths.OfEntry, target: Paths.OfTarget]`: its branches are `entry` and `target`.
26. Lookup by path in code calls each step's adjacency with the entry's keys, a mapping of its key properties to their
    values: `store.Instances.wts.Features.dir({ name: 'DEF-693' }).clauses({ name: 'C-1' })` (in Python,
    `.dir({'name': 'DEF-693'})`). `store.Instances.<singleton>` is the root; each call is one `Paths.OfEntry`.
27. Lookup is on any adjacency ("on any adjacency I should think"), not only under `store.Instances`: an object's
    adjacency called with a mapping of the entry's keys gives the object that entry links. And mbse-basis P-015
    "reverts to its original form. Code expressions that name a reference object use Paths, not string lookup": its
    `as_instance` exception (1) is withdrawn.
28. A lookup with keys no entry has raises: "adjacency is called with keys no entry has -> raise".
29. An unnamed schema linked through a relation no key names (the container schema of `crm.Person.tags`, through
    `Schemas.HasSchema`) is a subclause owned through that link, its step a `Paths.OfEntry` with no properties: "yes I
    think that would work".
30. Decided 12 reads "(a)": the `Schema@` tag never appears in a path, but a schema object may be a step in one, as any
    owner may.
31. A reference object whose schema declares no `owner()` adjacency is owned by its schema, through a framework
    relation shaped as `Schemas.Defines` is, `Schemas.HasInstance`, linking a schema to its objects with the entry's
    `name`, generated where none is given ("yes to HasInstance"). A contact's path is then the root module, `crm`,
    `Contact` (through `Defines`) and the entry named `contact-6` (through `HasInstance`), on the wire:

    ```json
    {"singleton": ".", "next": {"entry": {"i": "schemas", "o": "", "properties": {"name": "crm"}, "next": {"entry": {
      "i": "schemas", "o": "", "properties": {"name": "Contact"}, "next": {"entry": {
        "i": "instances", "o": "", "properties": {"name": "contact-6"}, "next": {"target": {}}}}}}}}}
    ```

    So 20 applies where a schema has neither an `owner()` adjacency nor a schema to be owned by: none, as built.
    (Superseded by 37: such an object is counted; `HasInstance` goes.)
32. An identity is computed on demand ("yes, on demand"): no object holds one; its path is read off its ownership
    entries when asked, so a key written anew (an entry's `name`) renames the object, and another owner moves it.
33. Building an object whose ownership adjacency is empty links it only where one owner is possible, its schema
    through `HasInstance` or the singleton at the owning end, a key generated per its pattern; otherwise it raises,
    naming the ownership missing ("agreed"). (Its `HasInstance` case is superseded by 37.)
34. A schema's naming pattern stays on the object schema, `OfObject.pattern`, and names the entries of
    `Schemas.HasInstance` that own its objects ("Keep OfObject.pattern (Recommended)"); an explicit ownership relation's
    key takes its own property's pattern (13). Where a schema gives none, a `HasInstance` key is its local name
    lowercased, a dash and a counter, `contact-1` ("local-name-N (Recommended)"). (In question since 37; see Open
    questions, 1.)
35. `as_identity()` gives the path, a `Paths.OfRoot` value computed on demand ("The path value (Recommended)"). (Superseded by 43.)
36. (Superseded by 51.) The Reachable format lists its objects ("Objects as a list (Recommended)", 2026-10-17): `{"root": <path>,
    "objects": [{"path": <path>, "schema": "Contact", "properties": {...}}, ...]}`, a reference `{"$ref": <path>}`, with
    no `$schema`: the path finds the object, and its entry in `objects` names its schema, as `Exists` does.

As the user decided (2026-10-18), on the overhaul so far: "The overhaul we did on object identity was mostly a good
idea. And I get that there are problems with repeatability with UUIDs. However, I think the idea of eliminating the
entire use case of reference-counted objects is a mistake." "We need options, and I am skeptical of the HasInstance
relation":

37. Identity by kind of object:
    - "schema singletons : same as before, explicit object identity";
    - "schema definitions : yes, via the new `owner` adjacencies";
    - "schema definition clauses and sub-clauses : yes, via the new `owner` adjacencies";
    - "expression terms : should be reference counted";
    - "instances program-defined schemas at the root level of their data model : yes, via the new `owner` adjacencies";
    - "most other objects : reference counted".

    This supersedes 19 (a UUID per transaction returns), 20 and 21 (a reference object without an ownership path is
    counted, not refused), and 31, 33 and 34 as far as they concern `Schemas.HasInstance`, which goes (see Open
    questions, 1).
38. "add a 'transaction' layer to the wire format that holds a list of mutations, require a UUID for every transaction,
    name objects in the order created within the transaction". Transactions are explicit: "Mutations.OfTransaction has a
    schema and store has a method".
39. A counted object's name within its transaction is its "creation order index within the transaction". (Superseded by 55.)
40. "counted objects cannot be directly found programmatically only via visitor".

As the user decided (2026-10-18), on the questions 37 to 40 left:

41. `Schemas.HasInstance`, `OfObject.pattern` and the `local-name-N` keys: "yes, they all go" (superseding 31, 33's
    `HasInstance` case, and 34). A key is generated only by an ownership relation's key property's pattern (13).
42. A transaction's UUID is "not random - programmatically provided in store.mutation(mv : Visitors.OfMutation) via
    .uid()".
43. "as_identity can go away" (superseding 16 and 35). An owned object's path is still read by `Paths.of(obj)` (32).
44. Building outside a transaction: "nope, not allowed".
45. "snapshots are made of transactions".
46. "yes, clone is a new creation in the current transaction. yes, an aborted transaction for any reason imparts no
    changes to store of any kind".
47. "correct, nothing can be owned by a counted object nor can an ownership path proceed through any relation with more
    than two links": validation refuses an `owner()` adjacency whose owning end a counted schema can fill, as 14 already
    refuses an ownership relation of more than two links.

As the user decided (2026-10-18), on the questions 41 to 47 left:

48. Deleting an owned object ("correct"): removing its owning entry deletes it, and in cascade everything it owns,
    within the transaction; a counted object it linked lives on while anything else holds it.
49. A counted object on the wire ("fine"): a reference `{"$ref": {"tx": <uid>, "n": <index>}}` beside `{"$ref": <path>}`
    and a global name, its `Exists` carrying no id, its position among the transaction's creations being its index.
    (Superseded by 55: a counted object is numbered only within the document that writes it.)
    (A singleton needs no form of its own: "why do singletons need a separate syntax?" Its reference is its path, of
    no steps, `{"singleton": "crm.Book", "next": {"target": {}}}`.)
50. Nested transactions are "prevented by schema. Mutation.OfTransaction is strictly the root".
51. The Reachable format (superseding 36), "precisely": a Reachable document is one transaction, whose creations are
    the counted objects reachable from the root, the root first, under a uid the caller gives, references within it by
    index alone; the owned objects and singletons it links are referred to by path (a singleton's has no steps), not included, and
    resolved in the reader's store, reading aborting where one is missing. A document carrying owned objects too is a
    store's snapshot. Its uses: a graph sent across a process or language boundary (mbse-programs' Verilog reader),
    the corpora of expression and syntax trees (mbse-expressions, mbse-programs), round trips in tests, and copying a
    component into another store.

As the user decided (2026-10-19), with mutations as queries ([Mutations as queries](STREAMING_QUERIES.md)):

52. A transaction's structure: "Mutations.OfTransaction [ -> Mutations.OfShard ] -> Mutations.OfTerm ...". (The
    shard is the executor's, not on the wire: 56.)
53. "Shard id is allocated by the query executor".
54. A putative counted object that a `Mutations.OfUpsert` names "becomes a creation of the transaction, named by its
    symbol" ("10. yes"). An upsert's `key` clause, which labelled the identities of the objects it created, was tried
    and dropped: "I am just removing 'key', not worth the trouble".

As the user decided (2026-10-19), asked "Do we really need to record the outcome of sharding?", on the answer that
nothing beyond one document needs a counted object's identity ("yes, please"):

55. A counted object has no identity beyond the document that writes it: within a snapshot or a Reachable transaction it
    is numbered in the order the document meets counted objects, a reference `{"$ref": {"n": <index>}}`, and reading
    gives each a new object. No later transaction names one; it reaches it through what links it (40). This supersedes
    39 and 49, and 54's naming by symbol, which is a mutation expression's, not an identity.
56. Sharding is not recorded: `Mutations.OfShard` (52) is the executor's, not part of the transaction on the wire, and a
    journal holds transactions as submitted, replayed by executing them again.
57. A transaction's effect does not depend on how it is sharded or in what order frames arrive: keys generated from a
    pattern are given in a canonical order of the frames that need them, and `Mutations.OfReduce`'s fold is made
    independent of order (see Open questions, 1).

As the user decided (2026-10-19):

58. `Visitors.OfMutation`: "Mutation visitors (builders) appear when a property visitor is called with a callback
    expecting it": "mutation builders are currently passed to the callback whenever <object_path>.<propName>(cb) or
    <rel_entry_path>.<propName>(cb) are invoked". The mutation verbs therefore stay ("why would you think mutations go
    away?").

59. A mutation's structure, "roughly": "Mutations.OfTransaction [ -> Mutations.OfShard ] -> Mutations.OfTerm ->
    Mutations.OfPattern -> Mutations.OfObject -> Mutations.OfAdjacency -> Mutations.OfProperty"
    ([Mutations as queries](STREAMING_QUERIES.md), Mutation structure). An adjacency's entries go through
    `Mutations.OfEntry` to their links and properties ("yes"); the shard is "strictly optional", the executor's (56); a
    term has "just one" pattern, "one can use Mutations.OfPartition to fork paths if needs be"; `Mutations.OfAll` is
    the first term of a transaction's one chain. "Keep adjacency verbs, lose relation verbs for now": entries change
    only through an object's adjacency.

As the user decided (2026-10-19), on what names an object an upsert creates, the order frames arrive in mattering only
to sequential numbering:

60. An owned object an upsert finds or creates is placed by its symbol's locator, which gives its whole path, the owning
    entry's keys included: "For owned objects, Upsert key is unnecessary and does not participate". No key is generated
    from a pattern in an upsert, so nothing is numbered in the order frames arrive.
61. "For unowned reference objects, the frame and key should be sufficient to disambiguate": a counted object an upsert
    creates is identified by the frame that reached the upsert and the upsert's `key`, with no nesting path, symbol
    name, sequence number or transaction id. "instances of Schemas.OfPattern are frames", so a frame is written as any
    instance is. This narrows 55: a counted object a verb creates still has no identity beyond a document.

As the user decided (2026-10-19):

62. A collector that declares neither `.commutative()` nor `.associative()`: "reject for now during validation", so a
    fold's result never depends on the order frames arrive in (57).
63. "upserted counted objects also include the symbol": a counted object an upsert creates is identified by the frame,
    the upsert's `key` and the symbol it is created for (amending 61), so that one upsert may create several from one
    frame.

As the user decided (2026-10-20), on how a pattern's symbol finds its objects, and on step 4d's shapes:

64. A symbol's locator is "an ordinary schema" over three kinds: `Locators.OfSymbol` (name, next),
    `Locators.OfSingleton` (schema, next) and `Locators.OfRelation` (schema, the relation; adjacency, "name of adjacency
    to current obj"; link, "name of link to next obj"; properties, the entry's property values; next). "Only
    `Locators.OfSymbol` or `Locators.OfSingleton` may be used as the root of a locator expression"; each hop is
    reached by `next`, root first. "Locators target reference objects, not value objects. Locators can only traverse
    named adjacencies. Builder shorthand makes locators a path language." A locator is not an identity: it is a route a
    query follows, and may reach many objects, or a counted object, which has no path (55); "path" names identities
    only. This makes 60's "symbol's locator" an `OfRelation` hop through the owning adjacency.
65. "cardinality is gone": a hop yields every object its entry's properties match, so a frame fans out where they
    leave the match open. A frame whose locator reaches nothing yields no frame, as for a constraint it cannot satisfy.
66. Step 4d's shapes ("yes"): `OfPattern`, `OfExpression` and `OfCollector` are schema kinds, named or not, defined in
    modules and written as every schema is; `OfVariable` is a member a pattern owns, as `OfSymbol` is; one kind,
    `OfExpression` (a pattern, through `Schemas.Matching`; a result schema; its terms mbse-expressions'), whose builder
    `Schemas.OfConstraint` fixes the result to the store's `OfBool`, validation refusing a pattern's `requires` of any
    other result; `requires`, the pattern's own constraints, in order (`Schemas.Requiring`); a collector's pattern,
    collected symbol and variable names, `commutative`, `associative`, `suffixes` (`current`, `next`) and `computes`
    (an `OfExpression`), validation refusing a name the pattern lacks and equal suffixes, and what a reduce requires of
    them left to 4e. 4d is schema-level only: frames, matching and the executor are 4e's.

## Open questions

None at present.

---

<!-- nav -->
[← Meta-schemas overhaul](META_SCHEMAS.md) · [Home](../README.md) · [Open-world modeling →](OPEN_WORLD.md)
