# Equivalence of the implementations

`python3/` and `typescript5/` implement the same framework (`Framework.md`). This document defines what
"equivalent" means for them, how it is checked, where they deliberately differ, and how to keep them equivalent.

## What equivalent means

1. **Same API.** The same modules, classes, methods and argument order, with the same names (snake_case included):
   `Schemas.OfObject.Builder().properties(...).create()`, `Proxies.Builders.Name(instance)`,
   `Plain.ToPlain.Reachable(schema, value)`, `JSON.FromJSON(builders)(schema, text)`, `Validators.Validate(registry)`.
   Only the unavoidable language mechanics differ (see below).
2. **Same behavior.** The same results, the same error classes, and byte-identical error and validation messages.
3. **Same data on the wire.** For the same objects built the same way, JSON output is byte-identical: the same symbol
   numbering, key order, float formatting, escapes and whitespace. YAML output may be formatted differently but reads
   back to the same values, in either implementation and under a YAML 1.1 reader.
4. **Interchangeable data.** Each implementation reads the other's JSON and YAML back into the same graphs, which
   validate.
5. **Same tests.** The same test suites and cases, with the same IDs in the same order and the same assertions.
6. **Same coverage.** Each suite covers all of its implementation's framework code: every statement and branch in
   Python, every statement, branch and function in TypeScript.

## How it is checked

| Check | Where |
|---|---|
| Every test case exists in both implementations, same ID, same order (118 cases, 12 suites) | `python3/tests/*.ipynb`, `typescript5/tests/*.ipynb` |
| Messages are byte-identical | cases that assert exact messages, e.g. SCH-12, SCH-13, PLN-11 (24 malformed snapshots), VAL-03, VAL-06 |
| JSON is byte-identical; YAML and JSON are interchangeable | the CONF suite over the shared corpus in `conformance/` |
| Each corpus is current | CONF-01 |
| API conformance to the visitor protocols, on classes and on live instances | VIS-02, VIS-06, VIS-07 |
| The text inside messages (`repr`, float `repr`, type names, sort order) is Python's | TXT-01..04 |
| Full code coverage in both | the coverage gates below |

The corpus (`python3/schemas/Conformance/Corpus.py`, `typescript5/src/Conformance/Corpus.ts`) builds five cases
statement for statement: an address book, native edge values, a family with a cycle and a self-loop, a three-link
relation, and strings that YAML readers misread. See `conformance/README.md`.

Run everything:

```sh
(cd python3 && uv sync --all-extras && uv run pytest)
(cd typescript5 && npm install && npm test)
```

## Coverage

| | Python | TypeScript |
|---|---|---|
| Tool | coverage.py, branch mode, subprocesses measured (`[tool.coverage]` in `pyproject.toml`) | c8 (`.c8rc.json`, all files under `src/Framework`) |
| Command | `uv run coverage run -m pytest && uv run coverage combine && uv run coverage report` | `npm run coverage` |
| Gate | `fail_under = 100` | `--check-coverage --100` |
| Result | 100% statements (1438), 100% branches (426) | 100% statements (3303), branches (1466), functions (460), lines |

The counts differ because the tools count differently (V8 counts `??`, `?.` and each `case` as branches), not because
the code differs. Coverage was made equal by the same means in both:

- A gap in one implementation was closed by an assertion in the shared case, added to both suites (VIS-07, SCH-17,
  PRX-16, PRX-17, PLN-14, PLN-15, VAL-13, JSN-09..11, YML-13, TXT-01..04). A gap never became a one-language test,
  except for rows about JavaScript-only mechanics (probes, a prototype-less object), which are listed below.
- Code that no input could reach was removed from both implementations: branches in `Plain` that `_check` already
  excludes, a YAML key check the loader already makes, and in TypeScript helper methods, exports and emitter paths
  nothing used.
- No code is excluded with pragmas or ignore comments.

Examples and the conformance writer are run by EX-01 and CONF-01 but are not part of the framework and not measured.

## Deliberate differences

These were agreed before the TypeScript port. Each is asserted by the cases listed, so a change in either direction is
noticed.

| Area | Python | TypeScript | Why | Cases |
|---|---|---|---|---|
| Native types | `int`, `float`, `str`, `bool`, `bytes` | `BigInt`, `Number`, `String`, `Boolean`, `Uint8Array` as tokens | JavaScript's constructors are its runtime type objects | SCH-01..05 |
| Integers | `int` | `bigint` | `number` cannot tell `1` from `1.0` and rounds above 2^53 | SCH-03, JSN-05, JSN-07 |
| Plain mappings | `dict` | `Map<string, PlainData>` | object literals reorder integer-like keys and mishandle `__proto__` | SCH-11, PLN-02 |
| Schema data equality | `==` | `.equals()` | no operator overloading | SCH-01, SCH-15 |
| Errors | built-in exceptions | built-in `TypeError`; `ValueError`, `AttributeError`, `KeyError`, `LookupError`, `NotImplementedError` from `Errors` | JavaScript lacks the others | throughout |
| Callable entry points | objects with `__call__` | functions with the per-kind forms attached | no callable instances | PLN-01 |
| Keyword arguments | `indent=2` | `{ indent: 2 }` | no keyword arguments | JSN-04 |
| Finalizer arguments | extra arguments raise `TypeError` | checked explicitly | JavaScript ignores extra arguments | SCH-09, PRX-04 |
| Subclasses of natives | rejected | boxed primitives and `Buffer` rejected | the nearest analogues | SCH-03 |
| Unknown attribute on a proxy | `AttributeError` | `AttributeError`, except JavaScript protocol probes (`then`, `toJSON`, `constructor`, symbols) | awaiting or printing a proxy must not throw | PRX-02 |
| Name collisions (F2) | `_values` is shadowed by an internal | not shadowed (private state); declared names win over JavaScript's own members | private fields exist | PRX-04 |
| Object identity (F12) | `id(self)`, may be reused after collection | a counter, never reused | no object ids in JavaScript | PRX-02 |
| Lone surrogate encoded as UTF-8 | raises | replaced with U+FFFD | `TextEncoder` behavior | JSN-06 |
| YAML formatting | PyYAML's layout | own block emitter; no line folding, no `...` after a top-level scalar | values are what must match | YML-04, YML-08, CONF-03 |
| YAML dependency | optional extra, imported on first use | regular dependency | npm has no optional extras in the same sense | YML-11 |
| Randomized tests | Hypothesis | fast-check, fixed seed | the respective standard tools | PROP-01..05 |
| Decode errors for UTF-8/16 input | byte, position and reason | the same prefix (`'utf-8' codec can't decode`) without the detail | `TextDecoder` reports no position; UTF-32 is decoded by hand and matches exactly | JSN-09 |
| Byte-like subclass named in errors | `bytearray` | `Buffer` | the nearest analogues | PRX-17 |
| `Proxies.OfObject.Builder` | a class | a function returning the builder; `Proxies.OfObject.Data` is the class | builders are `Proxy` objects | PRX-16 |
| Objects without a class | none | `Object.create(null)` is named `object` | JavaScript-only | TXT-03 |
| Test runner | pytest + nbmake | `tests/run-notebooks.ts` | no maintained TypeScript kernel is required to run headless | all |

`Framework.md` ("Language bindings") summarizes the same mapping for readers of the design.

## What the port found

Porting and cross-checking found two bugs in the Python implementation, both fixed and now tested in both:

- **F14:** Python's YAML dumper left `y`, `Y`, `n`, `N` unquoted; the YAML 1.1 specification makes them booleans.
  Found by CONF-03 reading Python's YAML with a spec-compliant 1.1 reader; tested by YML-02b.
- **F15:** in Python `Validators`, an instance attribute shadowed the recorder's `adjacencies()` method. Found while
  porting; tested by VIS-06.

Equalizing coverage found more differences, all fixed in the direction noted and tested in both:

- Python's `JSON.dumps` and `YAML.dumps` accepted non-plain data (JSON turned `1` keys into `"1"`; YAML wrote tags);
  both now refuse it with TypeScript's messages (JSN-10, YML-13).
- Entry properties that are not native values were accepted by TypeScript, and by Python unless unhashable (then a bare
  `unhashable type` error); both now raise `an entry property must be a native value, got X` (PRX-17).
- Proxies accepted a non-proxy as a builder's source in Python; now refused in both (PRX-16).
- Parse-error messages and positions differed in TypeScript for bad escapes, trailing commas, oversized integers and
  UTF-32 input; they now match Python's `json` (JSN-09). Python's advice about `sys.set_int_max_str_digits()` is
  dropped from its message, as it does not apply to TypeScript.
- Classes named in TypeScript messages appeared as `Array`, `Map`, `Object`; they now appear as Python's `list`,
  `dict`, `object`, e.g. `unsupported native type <class 'list'>` (SCH-12, TXT-01, TXT-03).

## Keeping them equivalent

When changing behavior:

1. Change both implementations in the same commit, with the same names and the same messages.
2. Add or change the test case in both suites under the same ID and position.
3. If the change affects serialized data, update both `Corpus` modules identically and regenerate both corpora:
   `uv run python -m schemas.Conformance.write` and `npm run conformance`. CONF-02 fails until the JSON matches.
4. If a language forces a difference, add it to the table above and to both test plans, with the cases that assert
   it. Differences not listed here are bugs.
5. Run both suites under their coverage gates. A new gap is closed in both suites under the same ID, or by removing the
   unreachable code from both.
