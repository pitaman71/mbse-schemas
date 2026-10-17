<!-- nav -->
[← Meta-schemas overhaul](META_SCHEMAS.md) · [Home](../README.md) · [Open-world modeling →](OPEN_WORLD.md)

# Reference Object Identity

A reference object is identified by a path: the route from a singleton to it through the relations that own it. A
path is computed from the model, never drawn at random, so the same model built twice, or in another language, gives
the same identities, and a snapshot written twice is the same.

## What has an identity

- Value objects do not need an identity, and have none.
- Every reference object may need a computed name: its path.
- Singletons, such as the root module, form the root of every path to a non-singleton reference object.
- A schema's identity never becomes part of a path. It is present only on `Mutations.OfObject.Exists`, which must know
  what to build.
- There is no UUID mechanism: it comes out entirely.
- Every reference object must take part, through an ownership adjacency: named definitions of any kind (usually module
  scoped), clauses of a definition, and subclauses of a definition clause.

## Ownership

`Schemas.OfAdjacency` gains `owner()`. An adjacency marked `owner()` points back to the previous element of the
object's identity path: the object that owns it. The relation it designates must

1. mark the owner link as unique, and
2. mark the owned link, along with any keys, as unique,

for example (the user's, in the builders' syntax; `.pattern` and `.owner` are the members this adds):

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
as data).

This makes path resolution unambiguous: from the owner, the entry's keys select exactly one owned object, and an owned
object has exactly one owner. Validation rejects a non-singleton reference object schema that has no ownership path:
one with no adjacency marked `owner()`.

The peer shorthand's visitor is the union of an entry and the object it links: the entry's link and properties first,
then the linked object's members. An ownership entry's keys therefore hide the linked object's properties of the same
name, and `t.name(...)` writes the path where the relation declares `name` and the object where it does not. The
explicit form says which: `d.dir(lambda a: a.insert(lambda e: e.name('DEF-693').defn(spec)))`, where `e` is the entry.

`Schemas.Defines` already has this shape: it links a module to a schema with the entry's `name`, declared
`.uniques([["module", "name"], ["schema"]])`, FRAMEWORK.md's Directory pattern (a schema has one module and one name in
it; a module and a name find one schema). The default module path is ported over to this mechanism, so that modules
and schemas take part in it like any other reference object: a schema's path runs from the root module through
`Defines` entries, by name.

## Naming

The name-picking regex moves out of `Schemas.OfObject.ref()`, which no longer takes a pattern at all, and into
`Schemas.OfProperty.pattern(r"FEA-\d+\d\d")`: a pattern on a property of an ownership relation's entry, a key that
continues the path, from which a value is generated where none is given. A value given that does not match the
pattern raises when written: `e.name('hello')` against `DEF-\d+\d\d`.


## Building

Building a non-singleton reference object can be coded in the apparently isolated manner it is today. The builder,
however, must recursively trace ownership links back to a singleton:

- where the ownership adjacency is already populated, according to the builder, recursion continues through it;
- any adjacency along the ownership path not already extant, as a relation entry, is added;
- any property value of such an entry is generated per its regex.

`Visitors.OfObject.as_identity` resumes being read-only for code outside of deserialization: a program reads an
object's identity, and only a snapshot or journal being read writes it. Repeated appearance of the same identity is
interpreted as an update of the existing object by the visitor, where update is allowed; this matters most for snapshot
and journal loading. Values a pattern generates are strictly increasing, even in the presence of deletions, which are
yet to be designed.

## Paths as data

`Paths.OfX` are nestable value objects:

- `Paths.OfRoot` bears two properties: `singleton`, a globally unique singleton name, and `next`, a
  `Union[Paths.OfEntry, Paths.OfTarget]`.
- `Paths.OfEntry` bears four properties: `in`, the name of the adjacency to the object addressed by the previous path
  element; `out`, the name of the adjacency to the object addressed by the next path element; `properties`, a value
  object literal assigning each property of the transited relation the value that uniquely continues the path to the
  target via this relation; and `next`, a `Union[Paths.OfEntry, Paths.OfTarget]`.
- `Paths.OfTarget`: no more traversals, the object is found.

A path has no shorthand: it is written as the nested value object it is, as any value is (mbse-basis P-019). The
definition the Ownership example places, on the wire, its unions tagged by branch:

```json
{"singleton": "wts.Features", "next": {"entry": {
    "in": "dir", "out": "def", "properties": {"name": "DEF-693"}, "next": {"target": {}}}}}
```

---

## Decided

As the user decided (2026-10-16), on the questions put to them:

1. A suffix is looked up by `as_instance`: "yes use as_instance". A suffix need not be an identifier (`FEA-001`, `Anna
   Baker`, a UUID), so `store.Instances.<path>.as_instance(suffix)` takes it as a string: the one place an object's
   identity references it (mbse-basis P-015, Exceptions); the path is attributes. (How a path given as data reaches
   `as_instance`, now that an identity is a path rather than a suffix, is open; see below.)
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
16. "as_identity can resume being read-only for code outside of deserialization".
17. "the default module path gets ported over so that modules and schemas participate in this mechanism".
18. Paths are data, `Paths.OfX`, "nestable value objects": `Paths.OfRoot`, `Paths.OfEntry` (its `in`, `out`,
    `properties` and `next`) and `Paths.OfTarget`, as
    Paths as data gives them, with the shorthand `path.to.root.singleton` `.{inAdj}-{entryProps}>{outAdj}` ...,
    for example `wts.Features.dir-{name:"FEA-693"}>def`, "oftarget is implied". (The shorthand is superseded by 23.)
19. "the UUID mechanism can come out entirely".
20. A "non-singleton reference object whose schema has no owner() adjacency: validation rejects the new reference
    object schema not having an ownership path".
21. "Every reference object must participate in this process via an ownership adjacency: named definitions of any
    kind (usually module scoped), clauses of a definition, subclauses of a definition clause".
22. A key value given that does not match its property's pattern: "raise when written".
23. No shorthand: "Maybe we should do without shorthand. Just write the path as a nested value object."

## Open questions

- **`in` is a Python keyword.** A schema's properties are its builders' and proxies' members, and `e.in(...)` does not
  parse in Python. Rename `in` and `out` (`via` and `to`, `source` and `sink`, ...), or give Python an alias such as
  `in_`?
- **Branch names of `next`.** The JSON above tags `Union[Paths.OfEntry, Paths.OfTarget]` by branches named `entry` and
  `target`, which the draft does not name.
- **Lookup.** With an identity a path, what does `store.Instances.<path>.as_instance(suffix)` (1; mbse-basis P-015)
  take: the keys of the last step, or a `Paths.OfX`?
- **Unnamed schemas.** Schema members, being clauses and subclauses of a definition, take part (21) through their
  keyed relations (`HasProperty`, ...), which have the shape 14 asks for. An unnamed schema a property links, the
  schema of its values (`crm.Person.tags`' container schema), is linked through `Schemas.HasSchema`, which no key names:
  is it a subclause owned through that link, its step written with no properties?

---

<!-- nav -->
[← Meta-schemas overhaul](META_SCHEMAS.md) · [Home](../README.md) · [Open-world modeling →](OPEN_WORLD.md)
