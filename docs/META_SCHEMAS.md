<!-- nav -->
[← Equivalence of the implementations](EQUIVALENCE.md) · [Home](../README.md) · [Open-world modeling →](OPEN_WORLD.md)

# Meta-schemas overhaul

How mbse-schemas' lists become relations and its meta-schemas become linked objects, so that the schema model is
built from the same constructs it offers: objects, relations and their entries. This is the plan of the work. What is
decided is in the [framework design](FRAMEWORK.md), Resolved, "The meta-schemas overhaul", which this does not restate.
Nothing in it is built, and it changes the module format, so every repository that reads schemas adapts.

## Why

- **One construct for many.** A list, a dict, a map and a relation's entries are four ways to hold a variable number
  of things. `OfIndexed` holds the first three apart from relations, with its own builders, visitors, wire forms,
  validation and comparison, and every code generator renders both.
- **Meta-schemas without invented containers.** A module holds its schemas in `Schemas.Module.Entry` value objects,
  and a type is `Schemas.OfAny`, a union of the kinds and `named`: containers that exist only to hold schemas, which
  the schema model would not offer a modeler. As linked objects, schemas refer to each other by relations, as any
  model does.
- **Modules as relations.** A module defines its schemas by a relation, `Defines`, so that modules can nest, and a
  module's dictionary of schemas is entries like any other.

## Where it comes from

An exploration on 8 to 11 Oct 2026, the `scalars` branch, built this together with the open-world and scalars
overhaul, which is deferred. Its commits are the reference, not a source: they do not apply to `main` without the
deferred open-world reading (slice 1, `e19d9e7`), so each phase below is built again.

| Phase | Reference commits on `scalars` | Left out |
|---|---|---|
| 1, 2 | `55edeb4` (slice 2), `eea1ece` (3a) | `e19d9e7` (slice 1, open-world reading) |
| 3, 4 | `d676953` (3c), `4748680` (3d) | |
| 5 | `1011f1f`, `b73fbf4`, `47054d1` (4a steps 1, 2 and 4) | `35d2743`, `4e3cdca`, `ad2e389` (`OfName`, `Specializes`, values classified, subsumption) |

## Plan

mbse-schemas first, in a workspace (`polyrepo.py workspace <dir> --branch meta-schemas --edit mbse-schemas`), in
phases that each keep both implementations equivalent and at 100% coverage, the corpora, test plans, tutorials and
skill regenerated. No release comes between phases.

0. **Decisions recorded** (this document; FRAMEWORK.md, Resolved; mbse-expressions' EXPRESSIONS.md, Resolved;
   mbse-basis V-025).
1. **Adjacencies that project**: `OfRelation.Data.keys(me)` and `key(me)`; an adjacency member stays a tuple (a frozen
   array) of its entries, with `project(name)` and `at(key)`; entries written sorted by their key; `Paths` reading
   `unique(S)` the right way round.
2. **One-link relations and lists as relations**: a relation of one link; an open relation (no `unique`) is a list,
   `.unique()` naming nothing makes a set; reading counts an entry written under several ends once; value objects held
   by a one-link relation's entries may have adjacencies; lists declared inline in their adjacency.
3. **The meta-schemas' lists as adjacencies**, in declaration order (the module format changes); a module's schemas
   keyed by name; `OfApply` binding by name only.
4. **`OfIndexed` removed**, with `Proxies.OfIndexed.Map`, the list visitors and records, the keyed wire forms and
   extents; `Check` and `Validate` evaluating no term; the dataclasses adapter mapping `list[N]` and `dict[K, N]` to
   one-link relations. The Lists suite is rewritten.
5. **Meta-schemas as linked objects**: links built with a schema given as itself (`.<link>.of(schema, spec)`);
   `OfAny` removed, a type given as itself; every schema a reference object of its kind's meta-schema, every reference
   to one a link through a meta-relation, the ends at which a schema is referred to anonymous adjacencies (built here,
   for any relation, as TODO.md's "Anonymous adjacencies"); `OfModule` and `Defines`, nestable, names qualified with
   dots; modules written as snapshots; `Schemas.Module`, `Modules.reference` and `resolve`, and `Stores.META` removed.
6. **Dependents**, each pinning the workspace's mbse-schemas:

   | Repository | Adapts |
   |---|---|
   | mbse-expressions | Basic's operations on lists (its EXPRESSIONS.md, Resolved): `get` of an adjacency, `project`, `at`, the quantifiers over them; the rest of Basic's collection operations and their translator rules removed |
   | mbse-patterns | `Predicates` lists (`_LIST`, `GIVEN`) as relations; `Modules.reference` and `resolve` replaced by links; meta-schema names in `Reflection` (`Schemas.Indexed` gone, `Schemas.Module` changed); transform paths, keyed as `Paths` now keys them |
   | mbse-programs | `Syntax`'s `as_indexed`; `OfApply` arguments by name; the conformance corpora regenerated, since a syntax node's children are written sorted by their key (`property`, `index`) since phase 1 (CONF-01) |
   | mbse-codegen-python | `Types` without `OfIndexed` and `Proxies.OfIndexed.Map`; a relation keyed by integer-like properties promoted to an indexable, and to a dict or map where unambiguous; `Codegen.Defined`'s `unique(output, name)` corrected for the right reading, `unique(node)`, without which its paths are positional since phase 1 (TYP-03) |

   The dependents' suites are run in the workspace after each phase, and what a phase breaks is listed above. After
   phase 1, mbse-patterns passes unchanged. Phase 2 breaks nothing more, though a dependent's relation that has no
   `unique` clause and relied on equal entries being elided now keeps them, which its tests may not show: each
   dependent's relations are reviewed for it here.

7. **The release**: mbse-schemas 0.11.0 and a minor version of each dependent, landed together
   (`polyrepo.py land <dir>`).

## Open questions

- **A value object held by an entry of a relation of two or more links, with adjacencies.** The entry is written under
  each object it links, so the value object is too, with one `$id`; reading would count the copies as one object, as
  it counts the entry once. Until then, only a one-link relation's entries may hold value objects with adjacencies.
- **Sparse integer keys.** An open relation is positional, its index implied; a relation keyed by an integer property
  is a map, sparse or not. Whether codegen's promotion to an indexable needs the keys dense, and how a constraint says
  so, is to be settled in phase 6.
- **Resolving qualified names.** A name qualified with dots names a schema through nested modules; whether an
  unqualified name resolves outward through the enclosing modules before the store, or only within its own module, is
  to be settled in phase 5. Name resolution stays closed either way: a name resolves or is refused.
- **Shape constraints bound to parameters.** Extents go, and a shape is a constraint on the type of the property that
  keys a relation's entries; how a parameter (Parametrics) is bound into such a constraint, to give a tensor's shape,
  is the Parametrics work's.

---

<!-- nav -->
[← Equivalence of the implementations](EQUIVALENCE.md) · [Home](../README.md) · [Open-world modeling →](OPEN_WORLD.md)
