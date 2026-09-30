# mbse-schemas

`mbse-schemas` takes the graph-shaped modeling of [ORMs][orm] and [MBSE][mbse] and packages it as a portable library.

A schema is an ordinary value built with a fluent DSL, not a class. Objects link through relationships whose entries
carry their own properties, like UML association classes or join tables with columns, and cardinality is declared.
That one schema value drives in-memory objects, JSON and YAML, validation and, eventually, generated bindings for
languages from Python and TypeScript to C++ and SystemVerilog. You don't need a database, a modeling editor or a
separate IDL compiler.

[orm]: https://en.wikipedia.org/wiki/Object%E2%80%93relational_mapping
[mbse]: https://en.wikipedia.org/wiki/Model-based_systems_engineering

## A quick look

With this framework, you describe structured data once, as data, in a single source of truth, and use that one
description everywhere:

- to build and edit objects
- to save and load them as JSON or YAML
- to validate them
- to generate idiomatic, performant interface bindings for many programming languages (planned)

Two implementations exist, in Python and TypeScript. They have the same API and the same error messages, and they
write byte-identical JSON. The TypeScript core runs in Node, in browsers and in Deno. Python imports the framework
from `mbse.Schemas.Framework`, TypeScript from `@mbse/schemas/Framework`.

```python
from mbse.Schemas.Framework import JSON, Proxies, Schemas, Validators

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

## Why another schema language?

Most programs that handle structured data describe it several times: as classes in the application, as tables or
documents in storage, as a JSON Schema or OpenAPI spec at the API boundary, and again in hand-written validation. Over
time the copies stop matching. Existing tools each handle one of these descriptions well and leave the rest to other
tools.

- **ORMs** start from the database. They make relationships first-class: foreign keys, join tables, inverse
  navigation and object identity. But the schema lives in one language's classes and takes its shape from the
  relational store. Serialization, validation and other languages need separate tools.
- **Serialization schemas** (JSON Schema, Protocol Buffers, Avro, Pydantic-style models) start from the wire. They
  are portable and validate documents well, but they describe *trees* of lists and nested records. Shared objects,
  inverse relationships and cycles have to be encoded by hand as IDs and joined back together in application code.
- **MBSE and metamodeling tools** (SysML, UML, EMF/Ecore) start from the model. They describe a system as a *graph*
  of typed elements with associations, multiplicities and constraints, and they generate code from it. The shape is
  right, but the toolchains are heavy, tied to particular platforms and editors, and rarely something you would embed
  in an ordinary program.

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
uv run pytest                                        # test suites and tutorials
uv run python -m mbse.Schemas.Examples.AddressBook   # an example
```

TypeScript (Node 22 or later; tested on 22, 24 and 26). With [nvm](https://github.com/nvm-sh/nvm), `nvm use` picks
the version in `.nvmrc`:

```sh
cd typescript5
nvm use
npm install
npm test                                             # type-check and run the test suites
npm run portability                                  # the core without Node: browser bundle + Deno smoke test
npx tsx src/Examples/AddressBook.ts                  # an example
```

## Documentation

| Read | For |
|---|---|
| [`python3/tutorials/`](python3/tutorials/README.md), [`typescript5/tutorials/`](typescript5/tutorials/README.md) | Nine case studies, from a contact card to evolving schemas, in Python and in TypeScript. Start here. |
| [`FRAMEWORK.md`](docs/FRAMEWORK.md) | The design: every element, rule and decision, plus the open questions |
| [`EQUALITY.md`](docs/EQUALITY.md) | How values compare under a schema: equality, hashing, ordering, and the `Comparison` module |
| [`EQUIVALENCE.md`](docs/EQUIVALENCE.md) | What "equivalent implementations" means, how it's checked, and where the languages deliberately differ |
| [`python3/tests/TestPlan.md`](python3/tests/TestPlan.md), [`typescript5/tests/TestPlan.md`](typescript5/tests/TestPlan.md) | The test suites, the findings they produced, and what isn't testable yet |
| [`conformance/`](conformance/README.md) | The shared corpus both implementations must read and write identically |
| [`AGENTS.md`](AGENTS.md), [`skills/mbse-schemas/`](skills/mbse-schemas/SKILL.md), [`llms.txt`](llms.txt) | Guidance for AI agents, layered so each loads only what its task needs. The skill also ships inside both packages |

## Repository layout

```
docs/               the design (FRAMEWORK.md), how values compare (EQUALITY.md), and how the two implementations
                    are kept equivalent (EQUIVALENCE.md)
python3/            Python implementation: mbse/Schemas/Framework, Adapters (Python only), examples, tests (Jupyter
                    notebooks), tutorials
typescript5/        TypeScript implementation: src/Framework, examples, tests and tutorials (notebooks; Deno kernel)
conformance/        snapshots each implementation writes; each must read the other's
skills/             the agent skill (SKILL.md plus per-task references); skills/sync.sh copies it into both packages
```

Tests are Jupyter notebooks, one suite per notebook. Both implementations have the same cases under the same
IDs, and both reach 100% code coverage (`uv run coverage ...` / `npm run coverage`; see `docs/EQUIVALENCE.md`).

## Status

The core is implemented in both languages:
- schemas: objects, relations, unions and intersections;
- embedded objects, union values and intersection values (intersections of unions are not yet supported);
- dynamic proxies;
- reachability;
- plain snapshots, JSON and YAML;
- validation;
- comparison under a schema;
- in Python, translation between dataclasses and object schemas (`mbse.Schemas.Adapters.Dataclasses`).

Expressions (for union predicates and constraints) and their evaluation are a separate package,
[mbse-expressions](https://github.com/pitaman71/mbse-expressions), which depends on this one. Generated bindings
(typed code per schema) will be separate repositories too, one per target language (e.g. mbse-cpp, mbse-python,
mbse-typescript, mbse-systemverilog), each depending on this one.

Designed but not built yet (see `docs/FRAMEWORK.md`):
- intersections of unions;
- constraints such as "at least one";
- mutations and transactions;
- factories;
- implicit singletons;
- object deletion;
- meta-schemas for schemas themselves.
