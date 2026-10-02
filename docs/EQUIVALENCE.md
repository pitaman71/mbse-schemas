# Equivalence of the implementations

`python3/` and `typescript5/` implement the same framework (`FRAMEWORK.md`). This document defines what
"equivalent" means for them, how it is checked, where they deliberately differ, and how to keep them equivalent.

## What equivalent means

1. **Same API.** The same modules, classes, methods and argument order, with the same names (snake_case included):
   `Schemas.OfObject.Builder().properties(...).create()`, `store.Name(instance)` of a `Proxies.OfStore`,
   `Plain.ToPlain(store).Reachable(schema, value)`, `JSON.FromJSON(store)(schema, text)`, `Validators.Validate(store)`.
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
| Every test case exists in both implementations, same ID, same order, except the adapters' suites (below) | `python3/tests/*.ipynb`, `typescript5/tests/*.ipynb` |
| Messages are byte-identical | cases that assert exact messages, e.g. SCH-12, SCH-13, PLN-11 (26 malformed snapshots), VAL-03, VAL-06 |
| Decoding errors: same class, reason and location | shared tables embedded verbatim in both suites: JSN-09 (62 JSON inputs), YML-06 (48 YAML inputs); PLN-11, PLN-12 (paths) |
| JSON is byte-identical; YAML and JSON are interchangeable | the CONF suite over the shared corpus in `conformance/` |
| Each corpus is current | CONF-01 |
| API conformance to the visitor protocols, on classes and on live instances | VIS-02, VIS-06, VIS-07 |
| The text inside messages (`repr`, float `repr`, type names, sort order) is Python's | TXT-01..04 |
| Full code coverage in both | the coverage gates below |
| The TypeScript core runs without Node (browsers, Deno) and still produces the identical corpus | `tsconfig.core.json`, `npm run portability` (see the TypeScript test plan) |

The corpus (`python3/mbse/Schemas/Conformance/Corpus.py`, `typescript5/src/Conformance/Corpus.ts`) builds eight cases
statement for statement: an address book, native edge values, a family with a cycle and a self-loop, a three-link
relation, strings that YAML readers misread, value objects with union and intersection values, lists, and a module of
the corpus's own schemas. See `conformance/README.md`.

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
| Required | 100% of statements and branches | 100% of statements, branches, functions and lines |

The commands print the counts. They differ between the languages because the tools count differently (V8 counts
`??`, `?.` and each `case` as branches), not because the code differs. Coverage was made equal by the same means in
both:

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
| Import path | `mbse.Schemas.Framework`, in the `mbse` namespace package that related packages share | `@mbse/schemas/Framework`, in the `@mbse` scope | a module specifier is a path, not a dotted name; a scope is the nearest equivalent | all |
| Native host types | `int`, `float`, `str`, `bool`, `bytes` | `BigInt`, `Number`, `String`, `Boolean`, `Uint8Array` | JavaScript's constructors are its runtime type objects | SCH-01..05 |
| Own token format | `python3` tokens are read | `typescript5` tokens are read | each implementation reads `basic` tokens and its own language's | SCH-18 |
| Native widths | `int` | `bigint`, as every int in the data model | a width becomes data once schemas serialize | SCH-18 |
| Integers | `int` | `bigint` | `number` cannot tell `1` from `1.0` and rounds above 2^53 | SCH-03, JSN-05, JSN-07 |
| Plain mappings | `dict` | `Map<string, PlainData>` | object literals reorder integer-like keys and mishandle `__proto__` | SCH-11, PLN-02 |
| Schema data equality | `==` | `.equals()` | no operator overloading | SCH-01, SCH-15, LST-01 |
| Lists in proxies | a `tuple`; a setter takes a `list` or a `tuple` | a frozen array; a setter takes an array | the read-only sequences of each language | LST-02 |
| Keyed lists in proxies | `Proxies.OfIndexed.Map`, a `Mapping`: `m[key]` raises `KeyError`, iterating gives the keys, `repr` shows the pairs; a setter takes a mapping or pairs | `Proxies.OfIndexed.Map`, shaped as a `Map`: `get(key)` gives `undefined`, iterating gives the entries; a setter takes a `Map` or pairs | each language's read-only mapping. A JavaScript `Map` makes a `-0.0` key `0`, so float keys that must keep `-0.0` are given as pairs | LST-11, LST-13 |
| Schemas by name (`Modules`) | a `dict` | a `Map`, or a record, and `schemas()` returns a `Map` | object literals are records by name, but only a `Map` keeps every key's order | MOD-02, MOD-03 |
| Typed bindings (`Bindings`) | a `Binding`'s `fixed`, `exclusive` and `implied` are keyword arguments; a `State`'s and an `Entry`'s fields are `dict`s; `Bindings.OfStore` takes `dict`s | an options object `{ fixed, exclusive, implied }`, `fixed` a `Map`; `Map`s; `Bindings.OfStore` takes `Map`s | the language's own mappings and members, as for proxies | BND-01..04 |
| Errors | built-in exceptions | built-in `TypeError`; `ValueError`, `AttributeError`, `KeyError`, `LookupError`, `NotImplementedError` from `Errors` | JavaScript lacks the others | throughout |
| Callable entry points | objects with `__call__` | functions with the per-kind forms attached | no callable instances | PLN-01 |
| Keyword arguments | `indent=2` | `{ indent: 2 }` | no keyword arguments | JSN-04 |
| Finalizer arguments | extra arguments raise `TypeError` | checked explicitly | JavaScript ignores extra arguments | SCH-09, PRX-04 |
| Subclasses of natives | rejected | boxed primitives and `Buffer` rejected | the nearest analogues | SCH-03 |
| Unknown attribute on a proxy | `AttributeError` | `AttributeError`, except JavaScript protocol probes (`then`, `toJSON`, `constructor`, symbols) | awaiting or printing a proxy must not throw | PRX-02 |
| A store's builders by name (`store.<Name>()`) | `__getattr__`; an unknown name raises `AttributeError` | the store is a `Proxy`; an unknown name throws `AttributeError`, except the protocol probes; `Proxies.OfStore.builder` returns `any`, as proxy builders are typed loosely | as for proxies | STO-01, STO-04 |
| A store's random source | `Proxies.OfStore(random=Stores.PCG32(42))`; `next_u32()` gives an `int` | `new Proxies.OfStore({ random: new Stores.PCG32(42n) })`; `next_u32()` gives a `bigint` | no keyword arguments; integers are `bigint`s | RND-01..03 |
| Transient objects (Stores) | STO-02 checks that an object no singleton reaches is garbage-collected once the program drops it | not checked | JavaScript has no deterministic collection to observe; the same structure holds no strong reference to it | STO-02 |
| Name collisions (F2) | `_values` is shadowed by an internal | not shadowed (private state); declared names win over JavaScript's own members | private fields exist | PRX-04 |
| Object identity (F12) | `id(self)`, may be reused after collection | a counter, never reused | no object ids in JavaScript | PRX-02 |
| Lone surrogate encoded as UTF-8 | raises | replaced with U+FFFD | `TextEncoder` behavior | JSN-06 |
| YAML formatting | PyYAML's layout | own block emitter; no line folding, no `...` after a top-level scalar | values are what must match | YML-04, YML-08, CONF-03 |
| YAML dependency | optional extra, imported on first use | regular dependency | npm has no optional extras in the same sense | YML-11 |
| Randomized tests | Hypothesis | fast-check, fixed seed | the respective standard tools | PROP-01..05 |
| YAML syntax errors | PyYAML's reason and position | the `yaml` package's reason and position | two parsers; the framework's own YAML rules are identical (YML-06) | YML-06b |
| YAML the parsers disagree on | e.g. a document after `...` without `---` is a syntax error | the same input is two documents | YAML 1.1 and 1.2 parsers; both reject it, differently | YML-06b |
| Reading JSON | `json` reads valid input; the reference parser (`JSON._Parser`) reads input `json` rejects, to report the problem | the reference parser reads all input | speed in Python; JSN-09 checks the reference parser reads valid input exactly as `json` | JSN-09 |
| Byte-like subclass named in errors | `bytearray` | `Buffer` | the nearest analogues | PRX-17 |
| `Proxies.OfObject.Builder` | a class, taking the store first | a function returning the builder, taking the store first; `Proxies.OfObject.Data` is the class | builders are `Proxy` objects | PRX-16 |
| Objects without a class | none | `Object.create(null)` is named `object` | JavaScript-only | TXT-03 |
| Incomparable (`Comparison`) | `None` | `null` | the respective "no value" | CMP-01..12 |
| Message text helpers | none: `repr()` and `type(v).__name__` are built in | `Repr` (`repr`, `typeName`, `tokenName`, ...) exported, for packages that must word messages as Python does | JavaScript has no `repr` | TXT-01..04 |
| Typing of the proxy DSL | untyped, like all Python | proxy builders and instances are typed loosely (`any` by name), so callbacks given to them are annotated `(x: any)`; schema builders and visitor handles are fully typed | the names come from schemas at runtime; per-schema types are the job of generated bindings | all proxy cases |
| Test runner | pytest + nbmake | `tests/run-notebooks.ts` | no maintained TypeScript kernel is required to run headless | all |
| Adapters | `Adapters.Dataclasses`, between dataclasses and object schemas | none yet | an adapter translates its language's own type declarations, so each language has its own adapters and its own suite for them | DC-01..07 |

`FRAMEWORK.md` ("Language bindings") summarizes the same mapping for readers of the design.

## Tutorials

`python3/tutorials/` and `typescript5/tutorials/` are the same nine case studies: the same problems, the same
reasoning, in the same order, with the same outputs wherever the bindings agree (every error and validation message
does). They differ only where the table above does, and the TypeScript notebooks point each difference out. Both are
run as tests (`uv run pytest`, `npm test`), and both are committed with outputs: Python's from its kernel, TypeScript's
from Deno's Jupyter kernel.

Two conventions are specific to the TypeScript notebooks, not to the binding:

- The framework's `JSON` module is imported as `Json`. In a notebook, a top-level `JSON` import shadows the global
  `JSON`, which Deno's kernel itself uses.
- Examples build through a store (`store.Contact()`) and annotate DSL callbacks `(x: any)`, per the table above.

When a case study changes, change both, and rerun both notebooks to refresh their outputs.

## What the port found

Porting and cross-checking found two bugs in the Python implementation, both fixed and now tested in both:

- **F14:** Python's YAML dumper left `y`, `Y`, `n`, `N` unquoted; the YAML 1.1 specification makes them booleans.
  Found by CONF-03 reading Python's YAML with a spec-compliant 1.1 reader; tested by YML-02b.
- **F15:** in Python `Validators`, an instance attribute shadowed the recorder's `adjacencies()` method. Found while
  porting; tested by VIS-06.

Normalizing decoding errors (see FRAMEWORK.md, "Decoding errors") found more, all fixed and tested in both:

- Python decoded JSON bytes with `surrogatepass`, accepting encoded lone surrogates that TypeScript's decoder
  rejected, and TypeScript's UTF-32 decoder accepted surrogate code points. Both now decode strictly (JSN-09).
- TypeScript's YAML parser accepted control characters that PyYAML rejects; both now reject them with PyYAML's
  message (YML-06).
- `FromPlain` converted native values while building, so a bad value in a later object left earlier objects built.
  Values are now decoded while checking, before any builder is called (PLN-14).
- A duplicate key written as an alias was located at the anchor in Python and at the alias in TypeScript; both now
  locate keys where they are written (YML-06).

Equalizing coverage found more differences, all fixed in the direction noted and tested in both:

- Python's `JSON.dumps` and `YAML.dumps` accepted non-plain data (JSON turned `1` keys into `"1"`; YAML wrote tags);
  both now refuse it with TypeScript's messages (JSN-10, YML-13).
- Entry properties that are not native values were accepted by TypeScript, and by Python unless unhashable (then a bare
  `unhashable type` error); both now raise `an entry property must be a native value or a value object, got X` (PRX-17).
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
   `uv run python -m mbse.Schemas.Conformance.write` and `npm run conformance`. CONF-02 fails until the JSON matches.
4. If a language forces a difference, add it to the table above and to both test plans, with the cases that assert
   it. Differences not listed here are bugs.
5. Run both suites under their coverage gates, the TypeScript one on every supported Node version (`nvm use 22`,
   `24`, `26`), and `npm run portability`. A new gap is closed in both suites under the same ID, or by removing the
   unreachable code from both.
