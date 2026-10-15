# Schema builders as visitors (proposal)

This follows [FRAMEWORK.md, Schema builders align with their meta-schemas](../../FRAMEWORK.md#resolved), and the
user's rules: every schema object is a reference object, and every reference is a relation. A property holds a value
of any kind: a scalar, a container, a value object, or any nesting of them.
It was proposed in building, for the user's review, and landed in Python (phase 1, docs/META_SCHEMAS.md, Plan) as
`Framework.Builders`, beside the old builders, on top of `Schemas.OfX.Data`, which is unchanged; suite BLD runs it.

This is the record of the proposal and its work items. The design as built, the meta-schemas (their kinds, members,
relations and constraints), the builders and building in a store, is in
[Meta-schemas overhaul, The meta-schemas and their builders, as built](../../META_SCHEMAS.md#the-meta-schemas-and-their-builders-as-built),
and what the user decided in [FRAMEWORK.md, Resolved](../../FRAMEWORK.md#resolved), "Schema builders align with their
meta-schemas".

## Old clause → new

With VISITOR_PATTERN.md's shorthands:
- a property takes its value whole, and its type must match exactly;
- an adjacency of a relation with two links takes an iterable (the peer shorthand). Each item is either the object to
  link, or a callback taking `OfThem.Visitor`, which sets three things:
  - the entry's properties: `t.name(...)`, a member's name, which its entry carries;
  - its link: `t.property(age)`, linking an object that exists;
  - the linked object's members: `t.type([T])`, building a new object, or updating the linked one if the link is set
    first.

  Every relation between schema objects has two links. Where the relation allows only one entry, the shorthand
  replaces it.

| Old | New |
|---|---|
| `.properties(lambda p: p.name("x").of(T))` | `.properties([lambda t: t.name("x").type([T])])`; one built first, `.properties([lambda t: t.name("x").property(x)])` |
| `.of(T)` on a property, parameter, symbol, branch, part | `.type([T])`, the evaluation type, a schema that exists (`[S.OfScalar.Data(int)]`) |
| `.relations(lambda a: a.name("n").of(R).me("l"))` | `.adjacencies([lambda t: t.name("n").relation([R]).me("l")])`; an anonymous one has no `name` |
| `.links("a", "b")` | `.links([lambda t: t.name("a"), lambda t: t.name("b")])`, a link's type following from the adjacencies that fill it |
| `.unique("a")`, `.unique("a", "b")` | `.uniques("a")`, `.uniques(["a", "b"])`; several clauses, `.uniques([["a"], ["b", "c"]])` |
| `.refines(T)` | `.refines([T])` |
| `.bits(8)` / `.bits(term)` | `.bits([term])`; 8 is `Form.Builder().kind("literal").attributes({"value": 8}).create()` |
| `.index(T)`, `.element(T)`, `.of(T)` on an application | `.index([T])`, `.element([T])`, `.of([T])` |
| `.arguments(width=8)` | `.arguments(lambda adv: adv.insert(lambda env: env.argument(lambda a: a.parameter([width]).value(8))))` |
| `.requires(term)` | `.requires([term])` |
| `.ref()`, `.ref(pattern)` | `.ref(True)`, `.ref(True).pattern(pattern)` |
| `.flat()`, `.dense()` | `.flat(True)`, `.layout("dense")` |
| `.type(int)`, `.token(fmt, name)` on a scalar | `.token("int")`, `.format(fmt).token(name)` |
| `S.OfAny.Builder().as_scalar(...)` selector | `OfAny.Builder().types([T, U])` |
| `.entry(spec)`, `OfEntry.Builder` | gone: a relation's `links` and `properties` are its own |

## Points for your review

Decided:
- an int width reads as `Form("literal", {"value": 8})` ("leave it that way. forms may go away but not yet");
- "all schema objects are reference objects and all reference objects get an ID on creation";
- "`type` *never* needs to be provided on the symbol. that relationship is inferred from adjacencies";
- the exception for names within a schema: `me` and `uniques`;
- the canonical form of building in a store: a call with a callback creates, an object and a callback update, an
  object alone clones.

## Work items

1. **Wire format.** Modules and Plain read and write schemas through these meta-schemas like any other model, as
   linked reference objects, and the conformance corpora are regenerated.
2. **Modules in the store.** A module is an object in the store, alongside schemas and data. The module named by a
   schema's prefix (`crm`) defines it through `Defines`.
3. **Cloning owned members.** Done: a clone clones the members it owns, with identities of their own; inherited ones
   stay shared.
4. **Landing.** The meta-schemas, builders and store move into `Schemas.py` and `Proxies.py`, with the shorthands in
   proxies too, mirrored in TypeScript. The call sites migrate to the canonical form.
5. **The meta-schemas in the store.** Done: each `Builders.Store` holds them, `Schemas.Module` aside, which every
   store holds in its old form until the wire format moves.
