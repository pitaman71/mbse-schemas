# Test plan — typescript5

Scope: everything under `typescript5/src/Framework` (Errors, Repr, Visitors, Schemas, Proxies, Reachable, Plain, JSON,
YAML, Validators, Comparison), the examples under `typescript5/src/Examples`, and cross-implementation conformance
with `python3`. The design reference is `../../docs/FRAMEWORK.md`. This plan mirrors `python3/tests/TestPlan.md` case
for case: the same suites, the same case IDs in the same order, the same assertions, except for the language
differences listed below.

## Running

```sh
cd typescript5
nvm use                                   # Node 24 from ../.nvmrc; package.json requires >= 22
npm install
npm test                                  # type-checks everything, then runs every notebook under tests/ and tutorials/ headless
npx tsx tests/run-notebooks.ts tests/05_Plain.ipynb
npm run coverage                          # npm test under c8; fails below 100% statements, branches, functions, lines
npm run portability                       # the core without Node: browser bundle, then a smoke test under Deno
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
FRAMEWORK.md requires and *pinned* cases (headings say *Finding Fn (pinned)*) record current behavior on open
questions. `tests/support.ts` mirrors `tests/support.py` (`raises`, `entries`, `same_graph`, `Fake`, conformance
checks) plus `equal` (Python's `==` on plain data) and `map` (a `Map` literal from an object literal). Randomized cases
use fast-check with a fixed seed and 200 runs per property (Hypothesis in Python).

## Suites

| Notebook | Suite | Cases | Focus |
|---|---|---|---|
| `01_Schemas.ipynb` | SCH | 19 | as in Python; host types are `BigInt`, `Number`, `String`, `Boolean`, `Uint8Array`, the own token format is `typescript5`, and widths are `bigint`s |
| `02_Visitors.ipynb` | VIS | 7 | as in Python; conformance is checked at runtime by method presence and `Function.length` |
| `03_Proxies.ipynb` | PRX | 17 | as in Python, plus JavaScript protocol probes (`then`, `toString`, symbols, `in`) on instances and the registry, `util.inspect` of instances and builders, and the Jupyter display hook (`Symbol.for("Jupyter.display")`, used by Deno's kernel) |
| `04_Reachable.ipynb` | RCH | 10 | as in Python |
| `05_Plain.ipynb` | PLN | 16 | as in Python; the same 26 malformed snapshots with byte-identical `DecodeError` paths and reasons |
| `06_JSON.ipynb` | JSN | 11 | as in Python, including Python's exact output format; the 62-row JSN-09 table of `DecodeError`s is shared verbatim and matches exactly |
| `07_YAML.ipynb` | YML | 14 | as in Python; the `yaml` package in YAML 1.1 mode is the "stock 1.1 reader"; the shared YML-06 table matches exactly, syntax errors (YML-06b) carry the `yaml` package's reasons |
| `08_Validators.ipynb` | VAL | 14 | as in Python, with byte-identical problem messages |
| `09_Properties.ipynb` | PROP | 5 | as in Python, with fast-check |
| `10_Examples.ipynb` | EX | 1 | every example exits cleanly in its own process |
| `11_Conformance.ipynb` | CONF | 4 | as in Python, from this side |
| `12_Text.ipynb` | TXT | 4 | `Repr` produces Python's text: `repr`, float `repr`, type names (plus one row for a prototype-less object), code-point order |
| `13_Comparison.ipynb` | CMP | 12 | as in Python; incomparable is `null`, and strings compare by code point, not by UTF-16 code unit |
| `14_Embedded.ipynb` | EMB | 9 | as in Python; the runtime's own probes (`then`, symbols) are not properties |
| `15_Skill.ipynb` | SKL | 3 | as in Python; the skill's complete TypeScript program is type-checked with `--strict` before it runs |

Total: 146 cases, with the same IDs in the same order as the Python suites. Python's DC suite tests its dataclasses
adapter, which has no TypeScript counterpart (see `docs/EQUIVALENCE.md`).

## Language differences

Each of these was agreed before the port. Tests assert the TypeScript behavior and say so in the case.

| Area | Python | TypeScript | Cases |
|---|---|---|---|
| int / float | `int` / `float` | `bigint` / `number` (keeps int and float distinct, unbounded ints) | SCH-03, JSN-05, JSN-07 |
| Native host types | `str`, `int`, ... | `String`, `BigInt`, `Number`, `Boolean`, `Uint8Array` | SCH-01..05 |
| Own token format | `python3` | `typescript5` | SCH-18 |
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
| YAML syntax errors | PyYAML's reason and position | the `yaml` package's reason and position; the framework's own rules match exactly (YML-06) | YML-06b |
| Reading JSON | `json` for valid input, the reference parser to report problems | the reference parser for all input | JSN-09 |
| Byte-like subclasses | `bytearray` is not native (`got bytearray`) | `Buffer` is not native (`got Buffer`) | SCH-03, PRX-17 |
| `Proxies.OfObject.Builder` | a class | a function returning the builder (`Proxies.OfObject.Data` is the class, so `instanceof` works) | PRX-16 |
| Objects without a class | none | `Object.create(null)` is named `object` | TXT-03 |
| Incomparable | `None` | `null` | CMP-01..12 |
| Message text helpers | built in | `Repr` exported | TXT-01..04 |

## Findings

The findings F1–F15 are shared with Python (see `python3/tests/TestPlan.md`). F1 (NEL) and F14 (single-letter YAML
1.1 booleans) never occurred here: the TypeScript YAML emitter was written with both rules. F15 (a shadowed recorder
method) was the Python bug found while porting; VIS-06 checks it in both implementations.

The supported Node versions (22, 24, 26 at the time of writing) are each run through `npm run coverage`: tests and
coverage must pass on every one, since coverage that happens incidentally can differ between versions. Doing so found
one TypeScript-only bug:

| ID | Finding | Status | Cases |
|---|---|---|---|
| F16 | Inspecting an instance (`console.log`, `util.inspect`) threw `AttributeError: values` on Node 22, which calls the inspect hook with the proxy as `this`; later versions only reached the hook incidentally | Fixed: the hook reads the target's state | PRX-02 |

## Not testable yet

The same as in Python: Mutations and transactions, Factories, implicit singletons, deletion,
meta-schemas and schema serialization, an "any value" kind,
mixing implementations (generated bindings will live in separate repositories, one per target language).

## Code coverage

`npm run coverage` runs the suites under c8 (`.c8rc.json`: `src/Framework`, all files) and fails below 100% statements,
branches, functions and lines; the suites currently reach 100% on all four, as the Python suites do under coverage.py.
Every gap was closed in the shared case in both languages, or by removing code no test could reach from both. See
`../../docs/EQUIVALENCE.md`.

## Portability

`src/Framework` (and the conformance corpus) is platform-neutral: it runs in Node, browsers and Deno. Three checks
keep it so:

- `tsconfig.core.json` compiles it with no Node types and only the ES library, plus the few Web APIs every runtime has
  (`types/web.d.ts`: `TextDecoder`). Using `Buffer` or a `node:` module fails to compile. `npm test` runs this first.
- `npm run portability` bundles `tests/portability/smoke.ts` for the browser with esbuild, which fails on any Node
  built-in, and runs the bundle under Deno with Node's globals removed. The smoke test renders the conformance corpus
  (byte-identical to the committed files, JSON also to Python's) and loads and validates every implementation's JSON
  and YAML: 30 checks. It needs Deno on the PATH.
- The notebooks, the test runner, the examples and `src/Conformance/write.ts` stay Node-only.

