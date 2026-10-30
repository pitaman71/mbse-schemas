<!-- nav -->
[← 10 · Asking the store: mutations as queries (TypeScript)](../typescript5/tutorials/10_Asking_The_Store.ipynb) · [Home](../README.md) · [Equality →](EQUALITY.md)

# Schemas Framework

Moved to [mbse-basis](../../mbse-basis/docs/README.md): each section below names the item that holds it now. Its opening is the [README](../README.md)'s; the features are under Schema-driven data in [the features index](../../mbse-basis/docs/features/README.md#schema-driven-data).

## Elements

Now in [CAP-109: schemas as linked objects in modules](../../mbse-basis/docs/capabilities/CAP-109.md#the-kinds), [CAP-157: values of any schema, restricted or not](../../mbse-basis/docs/capabilities/CAP-157.md), [CAP-156: the five basic scalars](../../mbse-basis/docs/capabilities/CAP-156.md), [CAP-154: value objects and reference objects](../../mbse-basis/docs/capabilities/CAP-154.md), [CAP-155: relations of named links, keyed by `unique` clauses](../../mbse-basis/docs/capabilities/CAP-155.md), [CAP-153: unions and intersections of named branches and parts](../../mbse-basis/docs/capabilities/CAP-153.md), [CAP-108: containers of any index and element](../../mbse-basis/docs/capabilities/CAP-108.md), [CAP-112: parameters declared by an installed module](../../mbse-basis/docs/capabilities/CAP-112.md).

### Cardinality

Now in [CAP-155: relations of named links, keyed by `unique` clauses](../../mbse-basis/docs/capabilities/CAP-155.md).

### Equality

Now in [CAP-111: equality and ordering defined by the schema](../../mbse-basis/docs/capabilities/CAP-111.md).

## Builder pattern

Now in [CAP-107: one visitor protocol reads and writes data](../../mbse-basis/docs/capabilities/CAP-107.md), [CAP-109: schemas as linked objects in modules](../../mbse-basis/docs/capabilities/CAP-109.md), [PRI-004: one visitor protocol per kind](../../mbse-basis/docs/PRINCIPLES.md#PRI-004).

## Implementation

Now in [CAP-107: one visitor protocol reads and writes data](../../mbse-basis/docs/capabilities/CAP-107.md), [CAP-109: schemas as linked objects in modules](../../mbse-basis/docs/capabilities/CAP-109.md), [CAP-161: isolated stores, with no global registry](../../mbse-basis/docs/capabilities/CAP-161.md), [CAP-138: mutation expressions over frame streams](../../mbse-basis/docs/capabilities/CAP-138.md), [CAP-160: data validated against its schema on request](../../mbse-basis/docs/capabilities/CAP-160.md), [CAP-111: equality and ordering defined by the schema](../../mbse-basis/docs/capabilities/CAP-111.md), [CAP-127: snapshots made of transactions](../../mbse-basis/docs/capabilities/CAP-127.md), [CAP-162: Python dataclasses translated to and from schemas](../../mbse-basis/docs/capabilities/CAP-162.md).

## Stores

Now in [CAP-161: isolated stores, with no global registry](../../mbse-basis/docs/capabilities/CAP-161.md), [CAP-149: data accessed through the store protocol](../../mbse-basis/docs/capabilities/CAP-149.md), [CAP-042: data generated from constraints](../../mbse-basis/docs/capabilities/CAP-042.md).

## Proxies

Now in [CAP-107: one visitor protocol reads and writes data](../../mbse-basis/docs/capabilities/CAP-107.md), [CAP-155: relations of named links, keyed by `unique` clauses](../../mbse-basis/docs/capabilities/CAP-155.md).

## Generated code

Now in [CAP-107: one visitor protocol reads and writes data](../../mbse-basis/docs/capabilities/CAP-107.md#decided), [FEA-022: code generation](../../mbse-basis/docs/features/README.md#FEA-022).

## Serialization

Now in [CAP-158: values written as plain data, JSON and YAML](../../mbse-basis/docs/capabilities/CAP-158.md), [CAP-128: graphs sent as one-transaction documents](../../mbse-basis/docs/capabilities/CAP-128.md), [CAP-127: snapshots made of transactions](../../mbse-basis/docs/capabilities/CAP-127.md), [CAP-123: schema objects identified by path](../../mbse-basis/docs/capabilities/CAP-123.md).

### Decoding errors

Now in [CAP-159: decoding errors the same in every binding](../../mbse-basis/docs/capabilities/CAP-159.md).

## Value objects and reference objects

Now in [CAP-154: value objects and reference objects](../../mbse-basis/docs/capabilities/CAP-154.md).

## Unions and intersections by name

Now in [CAP-153: unions and intersections of named branches and parts](../../mbse-basis/docs/capabilities/CAP-153.md).

## Lists

Now in [CAP-108: containers of any index and element](../../mbse-basis/docs/capabilities/CAP-108.md).

## Scalars

Now in [CAP-156: the five basic scalars](../../mbse-basis/docs/capabilities/CAP-156.md).

## Meta-schemas

Now in [CAP-109: schemas as linked objects in modules](../../mbse-basis/docs/capabilities/CAP-109.md).

## A store's schemas as a module

Now in [CAP-110: a store's schemas read as one module](../../mbse-basis/docs/capabilities/CAP-110.md).

## Expressions

Now in [CAP-137: patterns of symbols, variables and specs](../../mbse-basis/docs/capabilities/CAP-137.md), [CAP-142: expressions evaluated in queries](../../mbse-basis/docs/capabilities/CAP-142.md#design).

## Parametrics

Now in [CAP-112: parameters declared by an installed module](../../mbse-basis/docs/capabilities/CAP-112.md), [CAP-113: parameters bound at their definitions](../../mbse-basis/docs/capabilities/CAP-113.md), [CAP-114: bindings substituted and checked](../../mbse-basis/docs/capabilities/CAP-114.md), [CAP-163: parameters bound, applied and generated beyond mbse-schemas](../../mbse-basis/docs/capabilities/CAP-163.md).

### Decided

Now in [CAP-112: parameters declared by an installed module](../../mbse-basis/docs/capabilities/CAP-112.md#decided-by-an-agent-for-review), [CAP-113: parameters bound at their definitions](../../mbse-basis/docs/capabilities/CAP-113.md#decided-by-an-agent-for-review), [CAP-114: bindings substituted and checked](../../mbse-basis/docs/capabilities/CAP-114.md#decided-by-an-agent-for-review), [CAP-163: parameters bound, applied and generated beyond mbse-schemas](../../mbse-basis/docs/capabilities/CAP-163.md#decided-by-an-agent-for-review).

### Built

Now in [CAP-112: parameters declared by an installed module](../../mbse-basis/docs/capabilities/CAP-112.md).

### Moved out

Now in [CAP-112: parameters declared by an installed module](../../mbse-basis/docs/capabilities/CAP-112.md).

### Later, elsewhere

Now in [CAP-163: parameters bound, applied and generated beyond mbse-schemas](../../mbse-basis/docs/capabilities/CAP-163.md#design).

## Language bindings

Not moved: how each language differs is [EQUIVALENCE.md](EQUIVALENCE.md)'s, the list of deliberate differences that [CAP-032: deliberate differences listed](../../mbse-basis/docs/capabilities/README.md#CAP-032) asks for; the shared conformance corpus is [CAP-024: the same conformance corpora](../../mbse-basis/docs/capabilities/README.md#CAP-024)'s.

## Open questions

Each stays an open question of the item it concerns:

- Where constraints attach: [CAP-166: constraints attached where they constrain](../../mbse-basis/docs/capabilities/CAP-166.md#open-questions).
- Open-world modeling: [FEA-020: refinable models](../../mbse-basis/docs/features/FEA-020.md).
- Parametrics, beyond the proposal: [CAP-112: parameters declared by an installed module](../../mbse-basis/docs/capabilities/CAP-112.md#open-questions), [CAP-114: bindings substituted and checked](../../mbse-basis/docs/capabilities/CAP-114.md#open-questions), [CAP-163: parameters bound, applied and generated beyond mbse-schemas](../../mbse-basis/docs/capabilities/CAP-163.md#open-questions).
- Reserved names (F2): [CAP-107: one visitor protocol reads and writes data](../../mbse-basis/docs/capabilities/CAP-107.md#open-questions).
- Concurrent builders (F4) and cloning self-loops (F5): [CAP-136: one finisher for every build](../../mbse-basis/docs/capabilities/CAP-136.md#open-questions).
- Containers: [CAP-108: containers of any index and element](../../mbse-basis/docs/capabilities/CAP-108.md#open-questions).
- Equality edge cases: [CAP-111: equality and ordering defined by the schema](../../mbse-basis/docs/capabilities/CAP-111.md#open-questions).
- Multi-object snapshot naming: [CAP-128: graphs sent as one-transaction documents](../../mbse-basis/docs/capabilities/CAP-128.md#open-questions).
- Snapshot determinism: [CAP-127: snapshots made of transactions](../../mbse-basis/docs/capabilities/CAP-127.md#open-questions).
- Uniqueness checked relation-wide: [CAP-160: data validated against its schema on request](../../mbse-basis/docs/capabilities/CAP-160.md#open-questions).
- A separate "any value" kind: [CAP-157: values of any schema, restricted or not](../../mbse-basis/docs/capabilities/CAP-157.md#open-questions).
- Reading an object's entries back, and removing an entry through a builder: [CAP-107: one visitor protocol reads and writes data](../../mbse-basis/docs/capabilities/CAP-107.md#open-questions).
- Ownership chains rooted in a directory entry: [CAP-118: singletons, owned and counted objects](../../mbse-basis/docs/capabilities/CAP-118.md#open-questions).

### Resolved

Each entry is now under Decided (or, where the agent chose, Decided by an agent, for review) of the item it concerns:

- A union's branch names are unique: [CAP-153: unions and intersections of named branches and parts](../../mbse-basis/docs/capabilities/CAP-153.md#decided).
- A restricted `OfAny` refuses a scalar of another host type when written: [CAP-157: values of any schema, restricted or not](../../mbse-basis/docs/capabilities/CAP-157.md#decided).
- A restricted `OfAny` never guesses its schema: [CAP-069: wire format shorthand (scalars)](../../mbse-basis/docs/capabilities/CAP-069.md#decided).
- Provenance: [CAP-134: transactions recorded with provenance](../../mbse-basis/docs/capabilities/CAP-134.md#decided).
- References: [CAP-130: references to objects, entries and frames](../../mbse-basis/docs/capabilities/CAP-130.md#decided).
- Mappings for keyed adjacencies: [CAP-107: one visitor protocol reads and writes data](../../mbse-basis/docs/capabilities/CAP-107.md#decided).
- Versioning schema names: [CAP-123: schema objects identified by path](../../mbse-basis/docs/capabilities/CAP-123.md#decided).
- Patterns: [CAP-137: patterns of symbols, variables and specs](../../mbse-basis/docs/capabilities/CAP-137.md#decided).
- Schema, never "type": [CAP-109: schemas as linked objects in modules](../../mbse-basis/docs/capabilities/CAP-109.md#decided).
- A scalar is one of the five basic scalars: [CAP-156: the five basic scalars](../../mbse-basis/docs/capabilities/CAP-156.md#decided).
- A union's branches and an intersection's parts are relation entries: [CAP-109: schemas as linked objects in modules](../../mbse-basis/docs/capabilities/CAP-109.md#decided).
- Parameters are names only: [CAP-112: parameters declared by an installed module](../../mbse-basis/docs/capabilities/CAP-112.md#decided).
- Schema builders align with their meta-schemas: [CAP-109: schemas as linked objects in modules](../../mbse-basis/docs/capabilities/CAP-109.md#decided).
- Refinement, identities and relations: [CAP-167: schemas refined by other schemas](../../mbse-basis/docs/capabilities/CAP-167.md#decided).
- Containers: [CAP-108: containers of any index and element](../../mbse-basis/docs/capabilities/CAP-108.md#decided).
- `OfAny` returns: [CAP-157: values of any schema, restricted or not](../../mbse-basis/docs/capabilities/CAP-157.md#decided).
- Reference identity: [CAP-118: singletons, owned and counted objects](../../mbse-basis/docs/capabilities/CAP-118.md#decided).
- The visitor pattern: [CAP-107: one visitor protocol reads and writes data](../../mbse-basis/docs/capabilities/CAP-107.md#decided).
- The meta-schemas overhaul: [CAP-109: schemas as linked objects in modules](../../mbse-basis/docs/capabilities/CAP-109.md#decided).
- A `python3` token names a basic type: [CAP-156: the five basic scalars](../../mbse-basis/docs/capabilities/CAP-156.md#decided).
- Adjacencies, as specified: [CAP-107: one visitor protocol reads and writes data](../../mbse-basis/docs/capabilities/CAP-107.md#decided).
- The earlier summaries, one line each: superseded where they say so, the rest held by the items above, with [CAP-025: nothing mandatory but by constraint](../../mbse-basis/docs/capabilities/CAP-025.md), [CAP-158: values written as plain data, JSON and YAML](../../mbse-basis/docs/capabilities/CAP-158.md), [CAP-159: decoding errors the same in every binding](../../mbse-basis/docs/capabilities/CAP-159.md), [CAP-160: data validated against its schema on request](../../mbse-basis/docs/capabilities/CAP-160.md), [CAP-161: isolated stores, with no global registry](../../mbse-basis/docs/capabilities/CAP-161.md) and [CAP-024: the same conformance corpora](../../mbse-basis/docs/capabilities/README.md#CAP-024).

---

<!-- nav -->
[← 10 · Asking the store: mutations as queries (TypeScript)](../typescript5/tutorials/10_Asking_The_Store.ipynb) · [Home](../README.md) · [Equality →](EQUALITY.md)
