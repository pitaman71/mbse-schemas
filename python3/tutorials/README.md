<!-- nav -->
[← Why the mbse repositories exist](../../MBSE.md) · [Home](../../README.md) · [1 · A contact card →](01_A_Contact_Card.ipynb)

# Tutorial: the schemas framework in ten case studies

This tutorial teaches the framework by solving real problems, one per notebook. Each case study builds on the ones
before it. Each spends as much time on *why* the framework does something differently as on *how* to use it, because
most of its choices (no lists of reference objects, no mandatory properties, no automatic validation, no coercion) are unusual.

It's written for Python programmers who build applications with structured data: records, relationships, files and
APIs. A TypeScript port with the same case studies is in
the [TypeScript tutorial](../../typescript5/tutorials/README.md). You don't need to have read the design
([the schema-driven data features](../../../mbse-basis/docs/features/README.md#schema-driven-data)), but it's the reference for everything here.

## Running the notebooks

```sh
cd python3
uv sync --all-extras                 # the project environment, with PyYAML (used in case study 7)
uv run --with jupyterlab jupyter lab tutorials/   # or open them in VS Code with the project's .venv as the kernel
```

Each notebook runs top to bottom in a fresh kernel and makes its own store. The notebooks are
committed with their outputs, so you can also just read them. `uv run pytest tutorials` executes them all as tests,
which keeps them in step with the code.

`toolkit.py` holds the three small helpers the case studies build (`entries`, `elements` and `remove_entries`), so later notebooks
can import them.

Constraints over data, such as "at least one", are written with the separate
[mbse-patterns](https://github.com/pitaman71/mbse-patterns) package ([CAP-152: relation constraint terms as mandatory, possible, or forbidden entry patterns](../../../mbse-basis/docs/capabilities/CAP-152.md)); expressions
and value domains are the separate [mbse-expressions](https://github.com/pitaman71/mbse-expressions) package's, whose
tutorial continues this one.

## The case studies

| # | Notebook | The problem | What you learn |
|---|---|---|---|
| 1 | [A contact card](01_A_Contact_Card.ipynb) | One record that many programs must agree on | Schemas are values, built in a store; builders and Specs; one call creates, updates or clones; read-only instances; absent is not `None` |
| 2 | [An address book](02_An_Address_Book.ipynb) | Contacts share addresses, and labels belong to neither side | Relations instead of lists; links without schemas; adjacencies; entries as shared facts; set semantics; reading through visitors |
| 3 | [Moving house](03_Moving_House.ipynb) | Remove, relabel and copy relationships | Editing entries through builders; clones and relations; what an update replaces |
| 4 | [A family tree](04_A_Family_Tree.ipynb) | People relate to people, in cycles | Self-relations; inverse views that can't disagree; `Reachable.of`; links filled by several kinds |
| 5 | [A price list](05_A_Price_List.ipynb) | One price per currency; dirty partner feeds | `unique(...)` cardinality; maps as relations; validation on demand with paths |
| 6 | [Saving and loading](06_Saving_And_Loading.ipynb) | Save shared, cyclic data without duplicates | Documents, identities and references; loading into the store you give; strict loading |
| 7 | [JSON and YAML](07_JSON_And_YAML.ipynb) | An API in JSON and a hand-edited YAML config | Strict JSON; the Norway problem; YAML 1.2 loading; no coercion |
| 8 | [Tools for every schema](08_Tools_For_Every_Schema.ipynb) | Audit logs and docs without per-class code | Walking schemas as data; reading any object through the visitor protocol |
| 9 | [When requirements change](09_When_Requirements_Change.ipynb) | New properties, v2 schemas, unique IDs, variants | Evolving schemas; versioned names; directories; unions and intersections; what isn't built yet |
| 10 | [Asking the store](10_Asking_The_Store.ipynb) | Questions about the data, and the changes that follow from the answers | Transactions as queries: frames; `map` over patterns and specs; a symbol given a reference; absence as a filter; `reduce` and `partition`; writing from frames; handing frames on as references |

## The ideas at a glance

| The usual way | This framework | Decided in | Case study |
|---|---|---|---|
| A class per record | A schema *value*, built in a store with a fluent DSL | [FEA-031: schemas as extensible data](../../../mbse-basis/docs/features/FEA-031.md) | 1, 8 |
| Mutable objects | Read-only instances; changes go through a builder | [CAP-124: writes all-or-nothing in transactions](../../../mbse-basis/docs/capabilities/CAP-124.md) | 1, 3 |
| Required properties, `None` for missing | Everything optional; absent is a state of its own | [CAP-025: nothing mandatory but by constraint](../../../mbse-basis/docs/capabilities/CAP-025.md) | 1, 9 |
| Lists and nested records | Relations whose entries link objects and carry properties | [CAP-108: relations as scalable containers](../../../mbse-basis/docs/capabilities/CAP-108.md) | 2, 3, 4 |
| "One-to-many" annotations | `unique(S)`: the rest of the entry determines `S` | [CAP-155: `unique` clauses on relation schemas govern relation cardinality](../../../mbse-basis/docs/capabilities/CAP-155.md) | 5, 9 |
| Validate on every assignment | Validate when you ask; every problem, with a path | [CAP-160: data validated against its schema on request](../../../mbse-basis/docs/capabilities/CAP-160.md) | 5 |
| `to_dict` per class, nested | One flat document: a transaction whose objects are symbols, each naming its schema | [CAP-128: graphs sent as one-transaction documents](../../../mbse-basis/docs/capabilities/CAP-128.md) | 6 |
| Lenient parsing | Exact scalars, strict JSON, YAML 1.2 | [CAP-158: values written as plain data, JSON and YAML](../../../mbse-basis/docs/capabilities/CAP-158.md) | 6, 7 |
| Reflection over classes | Visitors: every object reads through one protocol, whatever its schema | [CAP-107: one visitor protocol reads and writes data](../../../mbse-basis/docs/capabilities/CAP-107.md) | 2, 8 |
| Loops over objects, then writes | A transaction: a pattern's frames, filtered by a spec, then written from | [FEA-027: mutations as queries](../../../mbse-basis/docs/features/FEA-027.md) | 10 |

---

<!-- nav -->
[← Why the mbse repositories exist](../../MBSE.md) · [Home](../../README.md) · [1 · A contact card →](01_A_Contact_Card.ipynb)
