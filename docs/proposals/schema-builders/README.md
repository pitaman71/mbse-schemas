# Schema builders as visitors (proposal)

Each `Schemas.OfX.Builder` is a writable `Visitors.OfObject` over its meta-schema (`Schemas.OfX.Schema`), per
[FRAMEWORK.md, Schema builders align with their meta-schemas](../../FRAMEWORK.md#resolved).
[Builders.py](Builders.py) holds the full Python builder layer, on top of `Schemas.OfX.Data` and the meta-schemas as
they are now. [examples.py](examples.py) runs it (`cd python3 && uv run python ../docs/proposals/schema-builders/examples.py`).

- **A member for each meta-schema property.** Calling it with a value writes the value (`.name("crm.Contact")`). Calling
  it with a callable hands over the `Visitors.OfProperty`. Read without a call, the member is that visitor
  (`str(b.name)`). Calling any member returns the builder.
- **A member for each list of members, as an adjacency.** The list is adapted from the data's own storage (a dict by
  name, a tuple, `adjacencies` + `anonymous`, `arguments` by name) to `Visitors.OfAdjacency`. Each entry links the
  schema (`owner`) and one member through a relation: `Schemas.HasProperty`, `HasAdjacency`, `HasParameter`,
  `HasBranch`, `HasPart`, `HasSymbol`, `HasLink`, `HasArgument`. The adjacency supports `insert`, `remove`
  (by entry, or by a template), `as_iterable`, iteration, and an iterable of entries as its value form.
- **An entry's link is a member** (`e.property`):
  - read, it gives the linked member, read-only;
  - called with a callable, it gives that member's builder, over the member already linked if there is one;
  - called with a value, it links that member data.
- **`as_*`:**
  - `as_schema()` returns the meta-schema;
  - `as_properties` gives the properties that are set, and `as_adjacencies` the member lists;
  - `as_identity()` returns None.
- **Lifecycle** follows your `_Builder`: `_original`, `_working`, `_make`, `_update`, `_finalize`, `create`, `clone`,
  `update`.

## Old clause → member

| Old | New |
|---|---|
| `.properties(lambda p: p.name("x").of(T))` | `.properties(lambda adj: adj.insert(lambda e: e.property(lambda p: p.name("x").type(T))))` |
| `.relations(lambda a: a.name("n").of(R).me("l"))` | `.adjacencies(lambda adj: adj.insert(lambda e: e.adjacency(lambda a: a.name("n").relation(R).me("l"))))` |
| `.of(T)` on a property, parameter, symbol, branch, part | `.type(T)`; `.type(lambda t: t.as_scalar(int))` keeps the `OfAny` idiom |
| `.of(R)` on an adjacency | `.relation(R)` |
| `.ref()` / `.ref(r"FEA-(\d+)")` | `.ref(True)` / `.ref(True).pattern(r"FEA-(\d+)")` |
| `.flat()` | `.flat(True)` |
| `.dense()` / `.sparse()` | `.layout("dense")` / `.layout("sparse")` |
| `.type(int)` / `.token("ccpp", "int32_t")` on a scalar | `.token("int")` / `.format("ccpp").token("int32_t")` |
| `.links("a", "b")` | `.links(lambda adj: adj.insert(lambda e: e.link(lambda s: s.name("a"))).insert(...))` |
| `.unique("a", "b")` | `.uniques([("a", "b")])` |
| `.branches(...)`, `.parts(...)`, `.symbols(...)`, `.parameters(...)` | adjacencies: `e.branch(...)`, `e.part(...)`, `e.symbol(...)`, `e.parameter(...)` |
| `.arguments(width=8)` | `.arguments(lambda adj: adj.insert(lambda e: e.argument(lambda a: a.name("width").value(8))))` |
| `.entry(spec)` on a relation | gone: the meta-schema has no `entry`; `links` and `properties` instead |

The clauses that change have about 3,700 call sites across both languages, tests, tutorials and the skill (`.of(`
alone has 1,513, though some of those are not schema builders).

## Points for your review

1. **Verbosity.** `adj.insert(lambda e: e.property(lambda p: ...))` follows VISITOR_PATTERN.md (`insert(spec:
   Callback[OfEntry])`, then `env.<linkName>(spec)`). Your earlier sketch, `adj.insert(lambda p: p.name(...))`, skips
   the entry. Which one do you want?
2. **The meta-schemas still list members as containers.** So `b.as_schema().properties["properties"]` is a container
   property, while `b.properties` is an adjacency over `Schemas.HasProperty`. This proposal adds the eight relations
   only as the adjacencies' schemas. Moving them into the meta-schemas is a Schema change (phase 5, question 2).
3. **A link called with a callable edits the member already linked** (a copy) instead of starting from nothing, the
   way proxies do. That is what makes `next(it).property(lambda p: p.name("first_name"))` rename a property.
4. **Width terms.** `bits` and `bytes` take an int or a term, as `Schemas.OfScalar.Data` stores them. The meta-schema
   instead splits them into `bits`/`bytes` and `terms`, and no `terms` member is proposed.
5. **Side effects kept from the old clauses:**
   - `refines` takes what it refines from: a scalar's token, an object's `ref`, a container's index and element;
   - `singleton` sets `ref`.
6. **Schemas have no identity.** `as_identity()` returns None and refuses a write, as a value object does; the schema
   is named by `name`.
7. **`uniques` and `types` take only a value** (a list of name tuples, a list of schemas). A callable gets the
   property visitor, but no container visitor is proposed under it.
