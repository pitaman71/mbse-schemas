# Tutorial: the schemas framework in ten case studies

This tutorial teaches the framework by solving real problems, one per notebook. Each case study builds on the ones
before it. Each spends as much time on *why* the framework does something differently as on *how* to use it, because
most of its choices (no lists, no mandatory fields, no automatic validation, no type coercion) are unusual.

It's written for Python programmers who build applications with structured data: records, relationships, files and
APIs. A TypeScript port with the same case studies is in
[`../../typescript5/tutorials/`](../../typescript5/tutorials/README.md). You don't need to have read the design
document, [`../../docs/FRAMEWORK.md`](../../docs/FRAMEWORK.md), but it's the reference for everything here.

## Running the notebooks

```sh
cd python3
uv sync --all-extras                 # the project environment, with PyYAML (used in case study 7)
uv run --with jupyterlab jupyter lab tutorials/   # or open them in VS Code with the project's .venv as the kernel
```

Each notebook runs top to bottom in a fresh kernel and starts with a schema registry that holds only the built-in
`Expressions.*` meta-schemas. The notebooks are committed with their outputs, so you can also just read them. `uv run
pytest tutorials` executes them all as tests, which keeps them in step with the code.

`toolkit.py` holds the two small helpers the case studies build (`entries` and `remove_entries`), so later notebooks
can import them.

## The case studies

| # | Notebook | The problem | What you learn |
|---|---|---|---|
| 1 | [A contact card](01_A_Contact_Card.ipynb) | One record that many programs must agree on | Schemas are values; builders and Specs; `create`/`update`/`clone`; read-only instances; absent is not `None` |
| 2 | [An address book](02_An_Address_Book.ipynb) | Contacts share addresses, and labels belong to neither side | Relations instead of lists; untyped links; adjacencies; entries as shared facts; set semantics; reading by visiting |
| 3 | [Moving house](03_Moving_House.ipynb) | Remove, relabel and copy relationships | Editing entries through builders; `clone()` and relations; what `update()` replaces |
| 4 | [A family tree](04_A_Family_Tree.ipynb) | People relate to people, in cycles | Self-relations; inverse views that can't disagree; `Reachable.of`; links filled by several kinds |
| 5 | [A price list](05_A_Price_List.ipynb) | One price per currency; dirty partner feeds | `unique(...)` cardinality; maps as relations; validation on demand with paths |
| 6 | [Saving and loading](06_Saving_And_Loading.ipynb) | Save shared, cyclic data without duplicates | Snapshots, symbols and references; why the schema isn't stored; injected builders; strict loading |
| 7 | [JSON and YAML](07_JSON_And_YAML.ipynb) | An API in JSON and a hand-edited YAML config | Strict JSON; the Norway problem; YAML 1.2 loading; no type coercion |
| 8 | [Tools for every schema](08_Tools_For_Every_Schema.ipynb) | Audit logs and docs without per-class code | Walking schemas as data; writing a visitor; `accept` |
| 9 | [When requirements change](09_When_Requirements_Change.ipynb) | New fields, v2 schemas, unique IDs, variants | Evolving schemas; versioned names; directories; unions and intersections; what isn't built yet |
| 10 | [Rules as data](10_Rules_As_Data.ipynb) | Eligibility rules stored, sent, and applied the same way by Python and TypeScript | Expressions from lambdas (`Expressions.from_`); evaluating with three-valued logic and no coercion; saving and loading; traversing for analysis and for substitution; methods and builders (appendix) |

## The ideas at a glance

| The usual way | This framework | Why | Case study |
|---|---|---|---|
| A class per record | A schema *value*, built with a fluent DSL | Every tool and every language can read it | 1, 8 |
| Mutable objects | Read-only instances; changes go through a builder | One place to assemble a change, one moment it applies | 1, 3 |
| Required fields, `None` for missing | Everything optional; absent is a state of its own | Old data still loads; "unset" and "empty" stay different | 1, 9 |
| Lists and nested records | Relations whose entries link objects and carry properties | Sharing, inverse lookups, no duplication, no sync code | 2, 3, 4 |
| "One-to-many" annotations | `unique(S)`: the rest of the entry determines `S` | Covers keys, maps, ownership and directories with one idea | 5, 9 |
| Validate on every assignment | Validate when you ask; every problem, with a path | Bulk loads, intermediate states, complete reports | 5 |
| `to_dict` per class, nested | One flat snapshot shape with symbols and schema-named references | Shared objects once, cycles safe, kinds preserved | 6 |
| Lenient parsing | Exact types, strict JSON, YAML 1.2 | The same text means the same thing in every language | 6, 7 |
| Reflection over classes | Visitors: objects write themselves into any tool | One protocol for serializers, validators and your tools | 2, 8 |
| Rules as functions | Rules as expressions: data with a schema, evaluated by `Evaluators` | Stored, sent and evaluated the same way by every program; unknown is an answer | 10 |
