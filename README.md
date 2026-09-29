# schemas

Describe structured data once, as data, and use that one description everywhere: to build and edit objects, to save
and load them as JSON or YAML, to validate them, and (in time) to generate code for other languages.

A schema is an ordinary value built with a small fluent DSL, not a class. Two implementations exist, in Python and
TypeScript. They have the same API and the same error messages, and they write byte-identical JSON. The TypeScript
core runs in Node, in browsers and in Deno.

```python
from schemas.Framework import JSON, Proxies, Schemas, Validators

Contact = Schemas.OfObject.Builder().properties(lambda p: p.name('name').of(lambda t: t.as_native(str))).create()
Address = Schemas.OfObject.Builder().properties(lambda p: p.name('street').of(lambda t: t.as_native(str))).create()

# Collections are relations: entries link objects and carry their own properties.
ContactAddresses = (
    Schemas.OfRelation.Builder()
    .links('contact', 'address')
    .properties(lambda p: p.name('label').of(lambda t: t.as_native(str)))
    .create()
)
Schemas.OfObject.Builder(Contact).relations(lambda adj: adj.name('addresses').of(ContactAddresses).me('contact')).update()
Schemas.OfObject.Builder(Address).relations(lambda adj: adj.name('residents').of(ContactAddresses).me('address')).update()
for name, schema in [('Contact', Contact), ('Address', Address), ('ContactAddresses', ContactAddresses)]:
    Proxies.register(name, schema)

alice = (
    Proxies.Builders.Contact()
    .name('Alice')
    .addresses(lambda x: x.address(lambda a: a.street('10 Downing Street')).label('home'))
    .create()
)

text = JSON.ToJSON.Reachable(Contact, alice)              # the whole graph, shared objects written once
copy = JSON.FromJSON(Proxies.Builders).Reachable(Contact, text)
assert Validators.Validate(Proxies.Builders).Reachable(Contact, copy) == []
```

```json
{"root": "s0", "objects": {"s0": {"name": "Alice", "addresses": [{"address": {"$ref": "s1", "$schema": "Address"}, "label": "home"}]},
                           "s1": {"street": "10 Downing Street", "residents": [{"contact": {"$ref": "s0", "$schema": "Contact"}, "label": "home"}]}}}
```

## What makes it different

- **Schemas are values.** You can inspect them, compare them and generate from them, in any language.
- **No lists or nested records.** Every collection is a *relation*. Its entries link objects and carry their own
  properties, and each entry is visible from every object it links. Sharing, inverse lookups and cycles need no
  extra code. Cardinality is declared with `unique(...)` clauses.
- **Builders, and read-only objects.** Changes go through a builder that ends with `create()`, `update()` or
  `clone()`.
- **Nothing is mandatory, and absent isn't `None`.** Old data keeps loading when a schema gains a field.
- **Validation runs when you ask.** It reports every problem, each with a path, rather than failing on the first
  assignment.
- **Strict, portable text.** JSON is strict. YAML is read with the 1.2 core schema, so there's no Norway problem.
  Types are never coerced (`1`, `1.0` and `true` are different values). Every input problem is a `DecodeError`
  with a line and column, or a path.
- **One protocol for tools.** Objects write themselves into *visitors*. Serializers, the validator and your own
  tools all work on any schema.

The tutorial explains the reasoning behind each of these.

## Getting started

Python (3.11+, managed with [uv](https://docs.astral.sh/uv/)):

```sh
cd python3
uv sync --all-extras
uv run pytest                                   # test suites and tutorials
uv run python -m schemas.Examples.AddressBook   # an example
```

TypeScript (Node 22 or later; tested on 22, 24 and 26). With [nvm](https://github.com/nvm-sh/nvm), `nvm use` picks
the version in `.nvmrc`:

```sh
cd typescript5
nvm use
npm install
npm test                                        # type-check and run the test suites
npm run portability                             # the core without Node: browser bundle + Deno smoke test
npx tsx src/Examples/AddressBook.ts             # an example
```

## Documentation

| Read | For |
|---|---|
| [`python3/tutorials/`](python3/tutorials/README.md) | Nine case studies, from a contact card to evolving schemas. Start here. |
| [`Framework.md`](Framework.md) | The design: every element, rule and decision, plus the open questions |
| [`EQUIVALENCE.md`](EQUIVALENCE.md) | What "equivalent implementations" means, how it's checked, and where the languages deliberately differ |
| [`python3/tests/TestPlan.md`](python3/tests/TestPlan.md), [`typescript5/tests/TestPlan.md`](typescript5/tests/TestPlan.md) | The test suites, the findings they produced, and what isn't testable yet |
| [`conformance/`](conformance/README.md) | The shared corpus both implementations must read and write identically |

## Repository layout

```
Framework.md        the design
EQUIVALENCE.md      how the two implementations are kept equivalent
python3/            Python implementation: schemas/Framework, examples, tests (Jupyter notebooks), tutorials
typescript5/        TypeScript implementation: src/Framework, examples, tests (notebooks run by tests/run-notebooks.ts)
conformance/        snapshots each implementation writes; each must read the other's
```

Tests are Jupyter notebooks, one suite per notebook. Both implementations have the same 119 cases under the same
IDs, and both reach 100% code coverage (`uv run coverage ...` / `npm run coverage`; see `EQUIVALENCE.md`).

## Status

The core is implemented in both languages:
- schemas: objects, relations, unions and intersections;
- dynamic proxies;
- reachability;
- plain snapshots, JSON and YAML;
- validation.

Designed but not built yet (see `Framework.md`):
- expressions (union predicates and constraints such as "at least one");
- mutations and transactions;
- factories;
- implicit singletons;
- object deletion;
- meta-schemas;
- generated bindings.
