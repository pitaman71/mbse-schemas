---
name: mbse-schemas
description: Model structured data and interfaces once, as a neutral, language-independent schema (objects, relations with properties, unions, intersections), then build, serialize (JSON/YAML), validate and compare instances in Python or TypeScript. Use when formalizing an interface or data model (MBSE/SysML blocks and associations, interface control documents, API or data-exchange models, types shared across languages), or when writing code that imports mbse.Schemas.Framework or @mbse/schemas/Framework.
---

# mbse-schemas

A schema here is an ordinary value, not a class. It is a semantically normalized formalization of an interface: every
collection is a relation, nothing is implicit, and one schema means the same thing in every language. Python
(`mbse.Schemas.Framework`) and TypeScript (`@mbse/schemas/Framework`) implement the same API, and they write
byte-identical JSON.

## When to use it

- You need one description of an interface or data model that several programs, languages or tools must agree on.
- The data is a graph: shared objects, relationships with their own attributes, inverse navigation, cycles.
- You are formalizing an MBSE model (blocks, ports, associations, multiplicities, variants) outside a modeling tool.

It is a poor fit for one-off, tree-shaped DTOs used by a single program, where a plain dataclass or interface is
simpler.

Why the mbse repositories exist, and this one's part: [MBSE.md](https://github.com/pitaman71/mbse-schemas/blob/main/MBSE.md).

## Practices that prevent most mistakes

1. **Links are relations; lists are values.** Objects are linked by an `OfRelation`, whose entries may carry
   properties. Each object sees a relation through one of its links (an *adjacency*, declared with `.me(link)`). A
   property may hold a list (`OfIndexed`) of natives or value objects, in order; a list never holds reference objects.
2. **Reference or value.** A reference object (its schema marked `.ref()`) stands on its own and is reached through
   relations only. A *value object* is held by a property, or in a list, whose schema is an `OfObject`; it belongs to
   that owner and is copied with it, and it may have adjacencies.
3. **Names starting with `$` are reserved** for the wire format (`$ref`, `$schema`, `$id`); `validate()` reports them.
4. **Nothing is mandatory, and absent reads as `None`** (`null` in TypeScript): no property holds `None` as a value,
   and an absent one is left out of what is written. An undeclared name raises `AttributeError`. Cardinality
   is `unique(...)` on a relation. "At least one" constraints are not implemented yet.
5. **Validation runs only when asked:** `Validators.Validate(store)(schema, value)`, or `.Reachable(...)` for a
   whole graph. It returns every problem, each with a path. Schemas have their own `.validate()`.
6. **Native types are exact, never coerced.** `int`, `float`, `bool`, `str` and `bytes` are distinct. In TypeScript,
   `int` is `bigint`.
7. **Objects are read-only.** Change them through a builder that ends with `create()`, `clone()` or `update()`.
8. **Everything lives in a store.** `store = Proxies.OfStore()` holds named schemas, and as data what its
   singletons reach: `store.register(schema)` (a schema named by its builder's `.name("crm.Contact")`), then
   `store.<Name>(...)`. Serializers and validators take the store
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
