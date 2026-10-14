# Schema builders as visitors (proposal)

This follows [FRAMEWORK.md, Schema builders align with their meta-schemas](../../FRAMEWORK.md#resolved), and the
user's rules: every schema object is a reference object, and every reference is a relation. A property holds a value
of any kind: a scalar, a container, a value object, or any nesting of them.
[Builders.py](Builders.py) holds the proposed meta-schemas and builders, in Python, on top of `Schemas.OfX.Data`, which
is unchanged. [examples.py](examples.py) runs them, and every meta-schema and example schema validates
(`cd python3 && uv run python ../docs/proposals/schema-builders/examples.py`).

## The meta-schemas

Every meta-schema (`Meta.X`, which becomes `Schemas.OfX.Schema`) is a reference object schema.

- **Kinds.** `Schemas.Schema` has `name` and `description`, and owns `parameters`.
  - `Schemas.Type` refines it. Scalar, Object, Union, Intersection, Container, Apply and Any refine `Type`.
  - Relation and Predicate refine `Schema` directly; they are not types.
- **Members.** `Schemas.Typed` has `name`, `description` and a `type`. Property, Parameter, Symbol and Member (a
  branch or a part) refine it.
- **Other schema objects.** Adjacency, Argument, Unique (a `unique` clause), Term (refined by `Form`) and Module.
- **Properties hold values:** `name`, `description`, `ref`, `pattern`, `singleton`, `flat`, `layout`, `format`,
  `token`, an argument's `value`, and a form's `dialect`, `kind` and `attributes` (a container).
- **References are relations,** each with an adjacency named on the side that declares it, and anonymous on the
  other:

| Relation | Links | Adjacency | Entries |
|---|---|---|---|
| Typing | typed, schema | Typed.`type` | one per typed |
| Refines | refinement, refined | Scalar/Object/Container.`refines` | one |
| Indexing, Containing | container, index / element | Container.`index`, `element` | one |
| Applying | application, applied | Apply.`of` | one |
| AnyOf | any, schema | Any.`types` | a list |
| Relating, Filling | adjacency, relation / link | Adjacency.`relation`, `me` | one |
| Binding, ArgumentTerm | argument, parameter / term | Argument.`parameter`, `term` | one |
| Requires | predicate, term | Predicate.`requires` | one |
| BitWidth, ByteWidth | scalar, width | Scalar.`bits`, `bytes` | one; a width is a term |
| HasParameter, HasProperty, HasAdjacency, HasBranch, HasPart, HasSymbol, HasLink, HasArgument, HasUnique | owner, member | `parameters`, `properties`, `adjacencies`, `branches`, `parts`, `symbols`, `links`, `arguments`, `uniques` | a member has one owner |
| Naming | unique, named | Unique.`named` | a list |
| Operands | form, operand | Form.`operands` | a list |
| Defines | module, schema | Module.`schemas` | a schema has one module |

"One" is a `unique` clause on the relation, which the builder enforces. Inserting a second entry raises, so you remove
the first one; inserting an entry already held is elided.

## The builders

Each `Schemas.OfX.Builder` is a writable `Visitors.OfObject` over `Meta.X`, in VISITOR_PATTERN.md's form:

- **Members:**
  - `osv.<propName>` and `osv.<propName>(cb)`, a `Visitors.OfProperty`. A container-valued property (a form's
    attributes) hands over a `Visitors.OfContainer`.
  - `osv.<adjName>` and `osv.<adjName>(cb: Callback[OfAdjacency])`, an adjacency with `insert`, `remove`,
    `as_iterable` and iteration. Its value form is an iterable of entries.
- **Entries.** `env.<linkName>(spec)` links:
  - the referent given;
  - or a referent built through the callback: new, or, if the entry already links one, that one updated in place,
    as a reference object is.

  Read without a call, a link gives the referent, read-only.
- **`as_*`:**
  - `as_schema()` returns `Meta.X`, and every member's `as_schema()` returns its meta-schema property or adjacency;
  - `as_properties` and `as_adjacencies` follow the meta-schema's order;
  - `as_identity()` is a kind's global name (written, it sets `name`), and None for a member, which no store holds.
- **Data.** Each member is adapted to however the data stores it:
  - a dict of members by name, or a tuple;
  - a field holding the referent;
  - `me` and a unique clause's members as names;
  - an argument by its parameter's name;
  - a width given as an int, which reads as a literal form.
- **Derivation happens at finalization.** A refinement takes its token, `ref`, index and element in `_finalize`; no
  member write has a side effect.

## Old clause → new

| Old | New |
|---|---|
| `.properties(lambda p: p.name("x").of(T))` | `.properties(lambda adj: adj.insert(lambda e: e.property(lambda p: p.name("x").type(lambda t: t.insert(lambda e: e.schema(T))))))` |
| `.of(lambda t: t.as_scalar(int))` | `.type(lambda t: t.insert(lambda e: e.schema(lambda k: k.scalar(lambda s: s.token("int")))))` |
| `.relations(lambda a: a.name("n").of(R).me("l"))` | `.adjacencies(...)`, with `e.adjacency(lambda a: a.name("n").relation(...).me(...))`; `me` links the symbol, by reference |
| `.links("a", "b")` | `.links(lambda adj: adj.insert(lambda e: e.link(a)).insert(lambda e: e.link(b)))`, `a` and `b` symbols |
| `.unique("a")` | `.uniques(lambda adj: adj.insert(lambda e: e.unique(lambda u: u.named(lambda n: n.insert(lambda e: e.named(a))))))` |
| `.refines(T)` | `.refines(lambda r: r.insert(lambda e: e.refined(T)))` |
| `.bits(8)` / `.bits(term)` | `.bits(lambda w: w.insert(lambda e: e.width(term)))`; 8 is `lambda f: f.kind("literal").attributes({"value": 8})` |
| `.index(T)`, `.element(T)`, `.of(T)` on an application | `.index(...)`, `.element(...)`, `.of(...)`, each an adjacency |
| `.arguments(width=8)` | `.arguments(lambda adj: adj.insert(lambda e: e.argument(lambda a: a.parameter(...).value(8))))`, by the parameter |
| `.requires(term)` | `.requires(lambda r: r.insert(lambda e: e.term(term)))` |
| `.ref()`, `.ref(pattern)` | `.ref(True)`, `.ref(True).pattern(pattern)` |
| `.flat()`, `.dense()` | `.flat(True)`, `.layout("dense")` |
| `.type(int)`, `.token(fmt, name)` on a scalar | `.token("int")`, `.format(fmt).token(name)` |
| `S.OfAny.Builder().as_scalar(...)` selector | an `AnyOf` adjacency (`Schemas.OfAny.Builder().types(...)`); a link to a type, `k.scalar(...)` |
| `.entry(spec)`, `OfEntry.Builder` | gone: a relation's `links` and `properties` are its own |

## Points for your review

1. **Links to a schema of any kind.** Called with a callback, `e.schema(...)` hands over a visitor with one branch per
   kind: `k.scalar(...)`, `k.object(...)`, and so on. That matches `Visitors.OfUnion`, but in the meta-schemas
   `Schemas.Type` is a schema that the kinds refine, not a union. Is that the right reading of a callback on a link
   to a refined schema?
2. **Literal widths.** An int width reads as `Form("literal", {"value": 8})`, and a form like that is stored back as
   the int. The `literal` kind is my choice. mbse-schemas has no dialect to take one from.
3. **Identity.** A kind's identity is its global name. A member's identity would come from a store, and schemas aren't
   held in stores yet. Should every schema object live in a store, such as its module's?
4. **Wire format.** Modules and Plain still read and write schemas through bespoke code, in the old container shape.
   Under P-018 they should read and write through these meta-schemas like any other model, as linked reference
   objects. That changes the module format and the conformance corpora.
5. **Construction order.** A reference must exist before it is linked. So a relation whose `unique` clause names its
   own links is built from symbols made first (see `Knows` in the examples), and `me` links a symbol of the relation.
6. **Size.** Every reference is now an adjacency, so a typed property is three nested callbacks. The examples show
   how that reads.
