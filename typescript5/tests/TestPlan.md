# Test plan — typescript5

Scope: everything under `typescript5/src/Framework` (Errors, Repr, Visitors, Schemas, Proxies, Reachable, Plain, JSON,
YAML, Validators), the examples under `typescript5/src/Examples`, and cross-implementation conformance with `python3`.
The design reference is `../../Framework.md`. This plan mirrors `python3/tests/TestPlan.md` case for case: the same
suites, the same case IDs in the same order, the same assertions, except for the language differences listed below.

## Running

```sh
cd typescript5
npm install
npm test                                  # type-checks everything, then runs every notebook under tests/ headless
npx tsx tests/run-notebooks.ts tests/05_Plain.ipynb
npm run coverage                          # npm test under c8; fails below 100% statements, branches, functions, lines
npm run conformance                       # regenerate ../conformance/typescript5 after a deliberate change
npx tsx src/Examples/AddressBook.ts       # an example
```

Notebooks are committed without outputs. `tests/run-notebooks.ts` is the counterpart of pytest + nbmake: each
notebook's code cells run in order as one module in a fresh process (state carries between cells as in a kernel, and
the proxy registry starts empty), and a failure names the case, the error and its position. With `--typecheck` the
notebooks are also type-checked under the project's strict `tsconfig.json`. Opening them interactively needs a
TypeScript kernel (e.g. tslab or `deno jupyter`), which the test run does not.

## Conventions

As in Python: one suite per notebook; a heading `XXX-NN · title` starts a case; *specified* cases state what
Framework.md requires and *pinned* cases (headings say *Finding Fn (pinned)*) record current behavior on open
questions. `tests/support.ts` mirrors `tests/support.py` (`raises`, `entries`, `same_graph`, `Fake`, conformance
checks) plus `equal` (Python's `==` on plain data) and `map` (a `Map` literal from an object literal). Randomized cases
use fast-check with a fixed seed and 200 runs per property (Hypothesis in Python).

## Suites

| Notebook | Suite | Cases | Focus |
|---|---|---|---|
| `01_Schemas.ipynb` | SCH | 17 | as in Python; native tokens are `BigInt`, `Number`, `String`, `Boolean`, `Uint8Array` |
| `02_Visitors.ipynb` | VIS | 7 | as in Python; conformance is checked at runtime by method presence and `Function.length` |
| `03_Proxies.ipynb` | PRX | 17 | as in Python, plus JavaScript protocol probes (`then`, `toString`, symbols, `in`) on instances and the registry |
| `04_Reachable.ipynb` | RCH | 10 | as in Python |
| `05_Plain.ipynb` | PLN | 16 | as in Python; the same 24 malformed snapshots with byte-identical messages |
| `06_JSON.ipynb` | JSN | 11 | as in Python, including Python's exact output format and error messages (the 47-row JSN-09 table is shared verbatim; codec errors match by prefix) |
| `07_YAML.ipynb` | YML | 13 | as in Python; the `yaml` package in YAML 1.1 mode is the "stock 1.1 reader" |
| `08_Validators.ipynb` | VAL | 13 | as in Python, with byte-identical problem messages |
| `09_Properties.ipynb` | PROP | 5 | as in Python, with fast-check |
| `10_Examples.ipynb` | EX | 1 | every example exits cleanly in its own process |
| `11_Conformance.ipynb` | CONF | 4 | as in Python, from this side |
| `12_Text.ipynb` | TXT | 4 | `Repr` produces Python's text: `repr`, float `repr`, type names (plus one row for a prototype-less object), code-point order |

Total: 118 cases, with the same IDs in the same order as the Python suites.

## Language differences

Each of these was agreed before the port. Tests assert the TypeScript behavior and say so in the case.

| Area | Python | TypeScript | Cases |
|---|---|---|---|
| int / float | `int` / `float` | `bigint` / `number` (keeps int and float distinct, unbounded ints) | SCH-03, JSN-05, JSN-07 |
| Native tokens | `str`, `int`, ... | `String`, `BigInt`, `Number`, `Boolean`, `Uint8Array` | SCH-01..05 |
| Plain mappings | `dict` | `Map<string, PlainData>` (keeps order for every key, incl. `"2"` and `"__proto__"`) | SCH-11, PLN-02 |
| Schema equality | `==` on data | `.equals()` (no operator overloading) | SCH-01, SCH-15 |
| Subclasses of natives | `int` subclasses rejected | boxed primitives and `Buffer` rejected | SCH-03 |
| Missing attribute | `AttributeError` for any name | `AttributeError`, except JavaScript protocol probes (`then`, `toJSON`, `constructor`, symbols) | PRX-02 |
| Name collisions (F2) | `_values` shadowed by an internal | internals are private: not shadowed; declared names win over JavaScript's own members | PRX-04 |
| Identity (F12) | `id(self)`, may be reused after collection | a counter, never reused | PRX-02 |
| Finalizer arguments | extra arguments raise `TypeError` | the same, checked explicitly (JavaScript ignores extra arguments) | SCH-09, PRX-04 |
| Lone surrogate to UTF-8 | raises `UnicodeEncodeError` | `TextEncoder` substitutes U+FFFD | JSN-06 |
| YAML text | PyYAML's layout (folds long lines, `...` after a top-level scalar) | own block emitter (no folding, no end marker); values are identical | YML-04, YML-08, CONF-03 |
| YAML dependency | optional extra, imported on first use | regular dependency | YML-11 |
| Recursion | Python's recursion limit | no fixed limit; the traversal is iterative in both | RCH-07 |
| Decode errors | `UnicodeDecodeError` detail (byte, position, reason) for UTF-8/16 | the same prefix (`'utf-8' codec can't decode`); `TextDecoder` gives no detail. UTF-32 matches exactly | JSN-09 |
| Byte-like subclasses | `bytearray` is not native (`got bytearray`) | `Buffer` is not native (`got Buffer`) | SCH-03, PRX-17 |
| `Proxies.OfObject.Builder` | a class | a function returning the builder (`Proxies.OfObject.Data` is the class, so `instanceof` works) | PRX-16 |
| Objects without a class | none | `Object.create(null)` is named `object` | TXT-03 |

## Findings

The findings F1–F15 are shared with Python (see `python3/tests/TestPlan.md`). F1 (NEL) and F14 (single-letter YAML
1.1 booleans) never occurred here: the TypeScript YAML emitter was written with both rules. F15 (a shadowed recorder
method) was the Python bug found while porting; VIS-06 checks it in both implementations.

## Not testable yet

The same as in Python: Expressions, Mutations and transactions, Factories, implicit singletons, deletion,
meta-schemas and schema serialization, object- / union- / intersection-valued properties, an "any value" kind,
generated bindings.

## Code coverage

`npm run coverage` runs the suites under c8 (`.c8rc.json`: `src/Framework`, all files) and fails below 100% statements,
branches, functions and lines; the suites currently reach 100% on all four, as the Python suites do under coverage.py.
Every gap was closed in the shared case in both languages, or by removing code no test could reach from both. See
`../../EQUIVALENCE.md`.
