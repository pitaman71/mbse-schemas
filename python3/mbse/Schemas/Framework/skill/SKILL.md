---
name: mbse-schemas
description: Model structured data and interfaces once, as a neutral, language-independent schema (objects, relations with properties, unions, intersections), then build, serialize (JSON/YAML), validate and compare instances in Python or TypeScript. Use when formalizing an interface or data model (MBSE/SysML blocks and associations, interface control documents, API or data-exchange models, types shared across languages), or when writing code that imports mbse.Schemas.Framework or @mbse/schemas/Framework.
---

# mbse-schemas

A schema here is an ordinary value, not a class. It is a semantically normalized formalization of an interface: every
collection is a relation, nothing is implicit, and one schema means the same thing in every language. Python
(`mbse.Schemas.Framework`) and TypeScript (`@mbse/schemas/Framework`) implement the same model, and they write
byte-identical JSON. Python builds schemas in a store, as data is built (`Builders.Store`, below); TypeScript still
builds them with the older schema builders its reference shows, until it migrates.

## When to use it

- You need one description of an interface or data model that several programs, languages or tools must agree on.
- The data is a graph: shared objects, relationships with their own attributes, inverse navigation, cycles.
- You are formalizing an MBSE model (blocks, ports, associations, multiplicities, variants) outside a modeling tool.

It is a poor fit for one-off, tree-shaped DTOs used by a single program, where a plain dataclass or interface is
simpler.

Why the mbse repositories exist, and this one's part: [MBSE.md](https://github.com/pitaman71/mbse-schemas/blob/main/MBSE.md).

## Practices that prevent most mistakes

1. **Links are relations; lists of values are containers.** Objects are linked by an `OfRelation` of two links or
   more, whose entries may carry properties. Each object sees a relation through one of its links (an *adjacency*,
   declared with `.me(link)`). A list, a dict or a tensor of values is a property holding an `OfContainer`: elements
   by index, dense by position for an int index, a dict for any other hashable one.
2. **Reference or value.** A reference object (its schema marked `.ref(True)`) stands on its own and is reached through
   relations only. A *value object* is held by a property, a container or an entry, its schema an `OfObject` without
   adjacencies; it belongs to that owner and is copied with it. Links target reference objects only: nothing links to
   a value object.
3. **Names starting with `$` are reserved** for the wire format (`$ref`, `$schema`, `$id`); `validate()` reports them.
4. **Nothing is mandatory, and absent reads as `None`** (`null` in TypeScript): a property is a member, its visitor,
   whose `get()` is `None` when absent; no property holds `None` as a value, and an absent one is left out of what is
   written. A name the schema lacks reads as empty, and writing through it raises `ReadOnlyError`. Cardinality is
   a relation's `unique` clauses, `.uniques(...)`, which name its links and properties by string. "At least one"
   constraints are not implemented yet.
5. **Validation runs only when asked:** `Validators.Validate(store)(schema, value)`, or `.Reachable(...)` for a
   whole graph. It returns every problem, each with a path. Schemas have their own `.validate()`.
6. **Scalar types are exact, never coerced.** `int`, `float`, `bool`, `str` and `bytes` are distinct. In TypeScript,
   `int` is `bigint`.
7. **Objects are read-only visitors.** Read a scalar with `str(obj.name)` or `obj.name.get()` (TypeScript:
   `` `${obj.name}` ``). In Python a member compares and orders as its value (`obj.name == "Ada"`); in TypeScript
   compare it once read (`obj.name.get() === "Ada"`), since `===` on the member itself is never true. Change
   objects in their store, through a builder whose members take a value or a callable given the visitor:
   `store.crm.Contact(obj, lambda c: c.name("Ada"))` updates `obj`, `store.crm.Contact(lambda c: ...)` creates and
   `store.crm.Contact(obj)` clones. Entries are inserted and removed through an adjacency's visitor
   (`.phones(lambda a: a.insert(...))`).
8. **Everything is built in a store.** `store = Builders.Store()` builds schemas,
   `store.Schemas.Object(lambda o: o.name("crm.Contact").ref(True).properties([...]))`, registering each named one
   under its name, and data, `store.crm.Contact(lambda c: ...)`, an attribute per part of the name; it keeps as data
   what its singletons reach. A schema's members are its entries, each named by its entry
   (`lambda t: t.name("given_name").type([Text])`), and a reference to another schema object is a list of what it
   links (`.type([Text])`). Serializers and validators take the store
   (`JSON.ToJSON(store)`, `Validators.Validate(store)`). Stores are isolated; objects move between them as snapshots.

## Load the reference for your task

| Task | Read |
|---|---|
| Decide how to model something: MBSE, UML, ORM or JSON Schema concepts mapped to schema elements | [references/modeling.md](references/modeling.md) |
| Write Python: a complete example, API cheat sheet, traps | [references/python.md](references/python.md) |
| Write TypeScript: the same example, the differences from Python | [references/typescript.md](references/typescript.md) |
| Save, load or exchange data: the snapshot format and strict decoding | [references/serialization.md](references/serialization.md) |
| Constraints (expressions and evaluators) | the separate [mbse-expressions](https://github.com/pitaman71/mbse-expressions) package |

Deeper material is in the repository: `docs/FRAMEWORK.md` holds every decision and open question, and nine tutorial case
studies explain the reasoning. The references link to the exact notebook or section you need. Links use
`https://github.com/pitaman71/mbse-schemas/blob/main/<path>`; in a checkout, `<path>` is relative to the repository
root.
