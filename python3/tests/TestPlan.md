# Test plan — python3

Scope: everything implemented under `python3/mbse_schemas/Framework` (Schemas, Visitors, Proxies, Reachable, Plain, JSON,
YAML, Validators), the examples under `python3/mbse_schemas/Examples`, and cross-implementation conformance with
`typescript5`. The design reference is `../../Framework.md`; the TypeScript test plan (`typescript5/tests/TestPlan.md`)
mirrors this one case for case.

## Running

```sh
cd python3
uv sync --all-extras          # project env with the yaml extra and the dev group (pytest, nbmake, hypothesis, ipykernel)
uv run pytest                 # runs every notebook under tests/ headless (nbmake)
uv run pytest tests/05_Plain.ipynb
uv run coverage run -m pytest && uv run coverage combine && uv run coverage report   # coverage gate: fails below 100%
uv run python -m mbse_schemas.Conformance.write   # regenerate ../conformance/python3 after a deliberate change
```

Notebooks are committed without outputs. Open them in an IDE or Jupyter with the project's `.venv` as the kernel to
read or step through them.

## Conventions

- One suite per notebook. Each markdown heading `XXX-NN · title` starts one test case; the following code cell is the
  case. A case fails by raising, so nbmake reports the first failing case.
- Each notebook runs in a fresh kernel, so the global proxy registry starts empty; names are unique per notebook.
- Two kinds of case:
  - **Specified**: behavior Framework.md states. A failure is a bug.
  - **Pinned**: current behavior where Framework.md is silent or a question is open. Headings say *Finding Fn
    (pinned)*. A failure means behavior changed; update the test deliberately together with Framework.md.
- `tests/support.py` provides `raises`, `entries`, `same_graph`, a protocol conformance checker, and `Fake`: a
  hand-written `Visitable` independent of Proxies, used to test Plain, Reachable and Validators at the protocol level
  and to express data proxies cannot produce.
- Randomized cases use Hypothesis with `derandomize=True` (reproducible) and 200 examples per property.

## Suites

| Notebook | Suite | Cases | Focus |
|---|---|---|---|
| `01_Schemas.ipynb` | SCH | 17 | Native validity and equality; `Spec` resolution (types, callables, data, bad returns, bare classes); strict `to_plain`/`from_plain` in both directions incl. subclasses; strict base64; the three non-finite float strings; `OfAny.Builder` selection and create/clone/update; value kinds only in `OfAny`; finalization rules for every builder; container copies vs shared references; `OfObject`/`OfRelation`/`OfAdjacency`/`OfUnion`/`OfIntersection` validation matrices; union/intersection selection, untyped branches, identity equality, Spec errors naming what they got |
| `02_Visitors.ipynb` | VIS | 7 | Protocol declarations; every implementation (Proxies, Plain, Reachable, Validators) conforms with matching arity; proxies are `Visitable`, not visitors; chaining returns `self`; unimplemented kinds raise; live instances conform (no attribute shadows a method); every protocol method of every implementation exercised, incl. empty adjacencies and absent properties |
| `03_Proxies.ipynb` | PRX | 17 | Registry (duplicates, unknown names, relations, non-identifier names, lookups); read-only instances and unset properties; setter `Spec`s; reserved-name collisions; create/clone/update incl. builder reuse; no native validation in builders; entries seen from every end; set semantics (absent, -0.0, NaN, int vs bool); schema inference through links (ambiguous, none, unique); nested inline creation per finalize; removal and exact write-back; concurrent builders; clone of entries and self-loops; self-relations; the builder's visitor API; `Proxies.OfObject.Builder`/`Data` directly; entry properties must be native (bytes key entries like any native) |
| `04_Reachable.ipynb` | RCH | 10 | Lone object; breadth-first first-reference order; cycles, self-loops, diamonds; multi-link entries and ignored properties; identity-based sameness; root first; 20,000-node chain without recursion; errors from `accept` propagate; collector refusals; components from every member |
| `05_Plain.ipynb` | PLN | 16 | Native entry points; exact snapshot format; schema-ordered properties and relation-ordered entry fields; symbol order; single-object vs reachable scope; round trips without duplicated entries; edge values; symbol renumbering on round trip; root schema and type checks; serializing fakes; 26 malformed snapshots each rejected with an exact `DecodeError` path and reason; disagreeing ends; wrong value types as `DecodeError`s with paths; rejection builds nothing, and no builder is called before every value is decoded; only injected builders are used, and a registry's own errors propagate; non-native property schemas refused; per-kind JSON/YAML entry points |
| `06_JSON.ipynb` | JSN | 11 | No NaN/Infinity output; rejection of constants, duplicate keys and syntax errors; str/UTF-8/16/32/BOM inputs; key order, non-ASCII, indentation; integers of any size, exact floats, every string; lone surrogates; top-level natives; agreement with Plain and graph round trips; a 62-row table of `DecodeError` reasons, lines and columns (code points) shared with TypeScript, and the reference parser agreeing with `json` on valid input; only plain data (str keys) written; every plain value in exact text, compact and indented |
| `07_YAML.ipynb` | YML | 14 | YAML 1.2 core scalar resolution (54 forms); 55 misreadable strings read back by our loader and stock YAML 1.1; YAML 1.1 single-letter booleans quoted; Unicode line breaks; long and whitespace-heavy strings; numeric fidelity and non-finite floats; the framework's YAML rules as a 48-row table of exact `DecodeError` messages and positions shared with TypeScript (documents, key types, duplicates, tags, aliases, unprintable characters, first problem wins); syntax errors as one-line `DecodeError`s with a position; accepted anchors/aliases, merge key as plain key, empty documents; no aliases on output; hand-written snapshots; agreement with Plain; behavior without PyYAML; every plain shape round-trips; only plain data written |
| `08_Validators.ipynb` | VAL | 13 | Natives; valid data; property types with paths; entry property types, unknown names, missing links, wrong-schema targets; checks on reached objects; `unique` semantics incl. absent, -0.0, NaN; clauses over links, empty, and everything; schema problems once; root schema mismatch; component-scoped uniqueness; validation changes nothing; non-native property schemas and non-native values refused |
| `09_Properties.ipynb` | PROP | 5 | For all natives: exact round trip through Plain, JSON, YAML; lone surrogates; mismatched types always rejected. For random graphs (1–6 nodes, 0–10 entries, random optional values incl. NaN, -0.0, surrogates, bytes): validity, reachability equals the independently computed component, snapshot scope, round trips through all three encodings. Entry-set cardinality equals distinct entries under schema equality |
| `10_Examples.ipynb` | EX | 1 | Every example module exits cleanly in its own process |
| `11_Conformance.ipynb` | CONF | 4 | This implementation's corpus files are current; JSON is byte-identical to TypeScript's for every case; every implementation's YAML reads back to the same snapshot, also under YAML 1.1; every implementation's JSON and YAML deserialize with Python's builders to the same graphs and validate |
| `12_Text.ipynb` | TXT | 4 | Messages are identical across implementations: `repr` of every native and container, float `repr`, type names, code-point string order |

Total: 119 cases, with the same IDs in the same order as the TypeScript suites.

## Coverage of Framework.md

| Requirement | Cases |
|---|---|
| Builders: create/clone/update rules; none validate | SCH-07, SCH-09, PRX-05, PRX-06 |
| Builders keep shallow copies separate from the source | SCH-10, PRX-05 |
| `Spec`: direct value or callable taking and returning the builder | SCH-02, SCH-08, SCH-14, PRX-03 |
| `OfAny.Builder` selects a kind; finalizes to that kind's data | SCH-06, SCH-07 |
| Properties optional; unset reads raise; instances read-only | PRX-02, PRX-03, VAL-02 |
| Relations: named untyped links; no one-link relations; adjacencies via `me` | SCH-12, SCH-13, PRX-07, PRX-14 |
| `unique(S)`: the rest determines `S` | SCH-13, VAL-06, VAL-07, VAL-08, VAL-11 |
| Entries form a set; equal entries elided; schema equality (types distinct, floats by bit pattern) | PRX-08, PROP-05, VAL-07 |
| Intersection conflicts are errors; union kinds and predicates | SCH-14, SCH-15 |
| No relation builder for callers; entries through adjacencies | PRX-01, PRX-07 |
| Inline link creation needs unambiguous schema inference | PRX-09 |
| `clone()` copies adjacency entries | PRX-13 |
| Visitors: callbacks, `self` returns, conformance; proxies are `Visitable` | VIS-01..05 |
| Reachability in first-reference order | RCH-01..10, PLN-04 |
| Snapshot format; adjacencies included; links as `{$ref, $schema}`; unresolved references rejected | PLN-02, PLN-05, PLN-11, JSN-08, YML-10 |
| Objects carry no schema; root schema passed in; references carry schema names | PLN-11, PLN-12 |
| `FromPlain(builders)` builds with injected builders | PLN-14 |
| Natives representable in plain data (base64 bytes, non-finite floats) | SCH-04, SCH-05, JSN-01, YML-05, PROP-01 |
| Strict JSON | JSN-01..03 |
| YAML 1.2 loading, safe dumping, rejection rules | YML-01..08 |
| Decoding errors: `DecodeError` with a one-line reason and a line/column or path; identical across bindings except YAML syntax | SCH-03..05, PLN-05, PLN-11, PLN-12, PLN-14, JSN-02, JSN-03, JSN-09, YML-06, YML-06b, YML-09 |
| Validation only on request, with the documented checks | VAL-01..12, PRX-06 |
| Language independence: identical snapshots and interchangeable text across implementations | CONF-01..04 |

## Code coverage

The suites cover every statement and branch of `mbse_schemas/Framework` (coverage.py, branch mode, subprocesses included:
see `[tool.coverage]` in `pyproject.toml`; `coverage report` fails below 100%). The TypeScript suites reach the same on
`src/Framework` (statements, branches, functions), with the same cases: gaps were closed by adding assertions to the
shared case in both languages, and code no test could reach was removed from both. See `../../EQUIVALENCE.md`.

## Findings

| ID | Finding | Status | Cases |
|---|---|---|---|
| F1 | YAML: strings containing NEL (`\x85`) came back with the NEL folded into a space; PyYAML wrote it raw inside single quotes | Fixed: strings with NEL/LS/PS are double-quoted | YML-03 |
| F2 | Names that collide with binding members: `create` etc. cannot be set through the DSL; `_values` is shadowed by a proxy internal; `accept` by an instance method. `validate()` accepts all of them | Pinned; open question in Framework.md | SCH-16, PRX-04 |
| F3 | Malformed snapshots raised `AttributeError` or misleading messages ("unreferenced objects" for a missing link) | Fixed: shape checked up front, precise `ValueError`s | PLN-11 |
| F4 | Two builders over one object: the last `update()` wins, silently dropping the other's entries | Pinned | PRX-12 |
| F5 | Cloning an object with a self-loop links the clone to the original, not to itself | Pinned | PRX-13 |
| F6 | A round trip can reorder entries and so renumber symbols (minimal case found by search) | Pinned; open question (snapshot determinism) | PLN-08 |
| F7 | Uniqueness is checked only over reached entries; relation-wide violations across components go unreported | Pinned; open question | VAL-11 |
| F8 | Builders accept wrong native types; serialization and validation catch them | Pinned (by design: validation on request) | PRX-06 |
| F9 | `.of(str)` (a bare class) was called as a Spec and crashed with `AttributeError` | Fixed: clear `TypeError` suggesting `as_native` | SCH-14 |
| F10 | Proxies wrote properties in the order they were set, so equal objects could serialize differently | Fixed: schema order | PLN-03 |
| F11 | YAML keys that are collections (`? [a]`) crashed with `TypeError` | Fixed: rejected as non-string keys | YML-06 |
| F12 | `identity()` is `id(self)`: objects not alive at the same time may share an identity | Pinned; safe for serialization, which compares live objects only | PRX-02 |
| F13 | Snapshots whose two ends disagree are accepted and restore the union of entries | Pinned; validation is the place to catch it | PLN-11b |
| F14 | YAML: `y`, `Y`, `n`, `N` were written unquoted; the YAML 1.1 specification makes them booleans (PyYAML's resolver omits them), so a spec-compliant 1.1 reader misread them. Found by CONF-03 against the TypeScript suite's 1.1 reader | Fixed: quoted | YML-02b, CONF-03 |
| F15 | `Validators`: the recorder's `adjacencies` attribute shadowed its `adjacencies()` visitor method on every instance; VIS-02 checked classes only. Found while porting | Fixed: renamed the attribute | VIS-06 |

## Not testable yet (specified in Framework.md, not implemented)

- Expressions (`Expressions.OfAny`, `OfLiteral`, `OfOperation`) and the core vocabulary; union predicates are
  placeholders.
- Mutations, transactions, symbol bindings and mutation serialization.
- `Factories` and `Factories.Directory`.
- Singletons existing implicitly (only the schema declaration exists).
- Deleting objects (and entries vanishing with them).
- Meta-schemas (`Schemas.OfX.Schema`) and schema builders implementing `Visitors` (serializing schemas).
- Object-, union- and intersection-valued properties in Proxies, Plain and Validators (VIS-05 pins the refusals).
- An "any value" `OfAny` kind.
- Generated bindings and mixing implementations.
