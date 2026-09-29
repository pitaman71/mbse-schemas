# Tutorial: the schemas framework in ten case studies (TypeScript)

This tutorial teaches the framework by solving real problems, one per notebook. Each case study builds on the ones
before it. Each spends as much time on *why* the framework does something differently as on *how* to use it, because
most of its choices (no arrays, no mandatory fields, no automatic validation, no type coercion) are unusual.

It's written for TypeScript programmers who build applications with structured data: records, relationships, files and
APIs. It's a port of the [Python tutorial](../../python3/tutorials/README.md), with the same case studies and the same
reasoning. The code follows TypeScript idioms where the bindings differ, and the notebooks point those differences
out. You don't need to have read the design document, [`../../docs/FRAMEWORK.md`](../../docs/FRAMEWORK.md), but it's
the reference for everything here.

## Running the notebooks

The notebooks are committed with their outputs, so you can just read them. To run them yourself, use Deno's Jupyter
kernel (Deno reads `../deno.json`, which lets it load the sources as written):

```sh
deno jupyter --install        # once: registers the Deno kernel with Jupyter
cd typescript5
npm install                   # the framework's one dependency, yaml
```

Then open the notebooks in VS Code (Jupyter extension) or JupyterLab and pick the **Deno** kernel. Each notebook runs
top to bottom in a fresh kernel and starts with a schema registry that holds only the built-in `Expressions.*`
meta-schemas.

`npm test` also runs every tutorial headless under Node, alongside the test suites, which keeps them in step with the
code.

`toolkit.ts` holds the two small helpers the case studies build (`entries` and `remove_entries`), so later notebooks
can import them.

## The case studies

| # | Notebook | The problem | What you learn |
|---|---|---|---|
| 1 | [A contact card](01_A_Contact_Card.ipynb) | One record that many programs must agree on | Schemas are values; builders and Specs; `create`/`update`/`clone`; read-only instances; absent is not `undefined`; why proxy callbacks take `(x: any)` |
| 2 | [An address book](02_An_Address_Book.ipynb) | Contacts share addresses, and labels belong to neither side | Relations instead of arrays; untyped links; adjacencies; entries as shared facts; set semantics; reading by visiting |
| 3 | [Moving house](03_Moving_House.ipynb) | Remove, relabel and copy relationships | Editing entries through builders; `clone()` and relations; what `update()` replaces |
| 4 | [A family tree](04_A_Family_Tree.ipynb) | People relate to people, in cycles | Self-relations; inverse views that can't disagree; `Reachable.of`; links filled by several kinds; `BigInt` for integers |
| 5 | [A price list](05_A_Price_List.ipynb) | One price per currency; dirty partner feeds | `unique(...)` cardinality; maps as relations; validation on demand with paths |
| 6 | [Saving and loading](06_Saving_And_Loading.ipynb) | Save shared, cyclic data without duplicates | Snapshots, symbols and references; plain data as `Map`s; injected builders; `DecodeError` |
| 7 | [JSON and YAML](07_JSON_And_YAML.ipynb) | An API in JSON and a hand-edited YAML config | Strict JSON with exact integers; the Norway problem; YAML 1.2 loading; no type coercion |
| 8 | [Tools for every schema](08_Tools_For_Every_Schema.ipynb) | Audit logs and docs without per-type code | Walking schemas as data; writing a visitor; `accept` |
| 9 | [When requirements change](09_When_Requirements_Change.ipynb) | New fields, v2 schemas, unique IDs, variants | Evolving schemas; versioned names; directories; unions and intersections; what isn't built yet |
| 10 | [Rules as data](10_Rules_As_Data.ipynb) | Eligibility rules stored, sent, and applied the same way by TypeScript and Python | Expressions written with terms; evaluating with three-valued logic and no coercion; saving and loading; traversing for analysis and for substitution; builders (appendix) |

## Differences from the Python tutorial

Where the TypeScript binding differs from Python's (`BigInt` for integers, `.equals()`, `Map` for plain data,
`(x: any)` on proxy callbacks, and so on), the notebooks say so as they go. Case study 10 writes expressions with terms
throughout, where the Python tutorial reads them from lambdas with `Expressions.from_`, which has no TypeScript
counterpart. The full list, with the reasons, is in [`EQUIVALENCE.md`](../../docs/EQUIVALENCE.md) under "Deliberate
differences" and "Tutorials".
