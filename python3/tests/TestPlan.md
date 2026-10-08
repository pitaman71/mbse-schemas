<!-- nav -->
[← Python package](../README.md) · [Home](../../README.md) · [TypeScript package →](../../typescript5/README.md)

# Test plan — python3

Scope: everything implemented under `python3/mbse/Schemas/Framework` (Schemas, Visitors, Proxies, Reachable, Plain,
JSON, YAML, Validators, Comparison), the examples under `python3/mbse/Schemas/Examples`, and cross-implementation
conformance with `typescript5`. The design reference is `../../docs/FRAMEWORK.md`; the TypeScript test plan
(`typescript5/tests/TestPlan.md`) mirrors this one case for case.

## Running

```sh
cd python3
uv sync --all-extras          # project env with the yaml extra and the dev group (pytest, nbmake, hypothesis, ipykernel)
uv run pytest                 # runs every notebook under tests/ headless (nbmake)
uv run pytest tests/05_Plain.ipynb
uv run coverage run -m pytest && uv run coverage combine && uv run coverage report   # coverage gate: fails below 100%
uv run python -m mbse.Schemas.Conformance.write   # regenerate ../conformance/python3 after a deliberate change
```

Notebooks are committed without outputs. Open them in an IDE or Jupyter with the project's `.venv` as the kernel to
read or step through them.

## Conventions

- One suite per notebook. Each markdown heading `XXX-NN · title` starts one test case; the following code cell is the
  case. A case fails by raising, so nbmake reports the first failing case.
- Each notebook runs in a fresh kernel and makes its own stores; names are unique per store.
- Two kinds of case:
  - **Specified**: behavior FRAMEWORK.md states. A failure is a bug.
  - **Pinned**: current behavior where FRAMEWORK.md is silent or a question is open. Headings say *Finding Fn
    (pinned)*. A failure means behavior changed; update the test deliberately together with FRAMEWORK.md.
- `tests/support.py` provides `raises`, `entries`, `same_graph`, a protocol conformance checker, and `Fake`: a
  hand-written `Visitable` independent of Proxies, used to test Plain, Reachable and Validators at the protocol level
  and to express data proxies cannot produce.
- Randomized cases use Hypothesis with `derandomize=True` (reproducible) and 200 examples per property.

## Suites

| Notebook | Suite | Cases | Focus |
|---|---|---|---|
| `01_Schemas.ipynb` | SCH | 21 | Native validity and equality; reference object schemas (`.ref()`, singletons, never a property's type, the only builders' and snapshots' roots); native tokens (`basic`, `python3` of the basic types' names only, other formats), host types and widths, and values of a token this implementation cannot read; `Spec` resolution (types, callables, data, bad returns, bare classes); strict `to_plain`/`from_plain` in both directions incl. subclasses; strict base64; the three non-finite float strings; `OfAny.Builder` selection and create/clone/update; value kinds only in `OfAny`; finalization alike for every builder; container copies vs shared references; `OfObject`/`OfRelation`/`OfAdjacency`/`OfUnion`/`OfIntersection` validation matrices; union/intersection selection, untyped branches, identity equality, Spec errors naming what they got; names on every kind of schema, identifiers separated by dots, kept by clones and part of a native; descriptions on every element (schemas, properties as elements, adjacencies, branches, parts), optional, kept by clones, part of a native, and reported where they are not text |
| `02_Visitors.ipynb` | VIS | 7 | Protocol declarations; every implementation (Proxies, Plain, Reachable, Validators, Comparison) conforms with matching arity; proxies are `Visitable`, not visitors; chaining returns `self`; an intersection of unions is valid; live instances conform (no attribute shadows a method); every protocol method of every implementation exercised, incl. empty adjacencies and absent properties |
| `03_Proxies.ipynb` | PRX | 18 | A store's schemas (duplicates, unknown names, relations, non-identifier names, lookups); read-only instances and unset properties; setter `Spec`s; reserved-name collisions; create/clone/update incl. builder reuse; no native validation in builders; entries seen from every end; set semantics (absent, -0.0, NaN, int vs bool); schema inference through links (ambiguous, none, unique); nested inline creation per finalize; removal and exact write-back; concurrent builders; clone of entries and self-loops; self-relations; the builder's visitor API; `Proxies.OfObject.Builder`/`Data` directly; entry properties must be native (bytes key entries like any native); adjacencies as members, each the adjacency's entries in order (a tuple), each a full entry of `Proxies.OfEntry.Data` (every link, the owner's own included), its links and properties read-only attributes, shared by both ends, an unset property None and an unknown name raising |
| `04_Reachable.ipynb` | RCH | 10 | Lone object; breadth-first first-reference order; cycles, self-loops, diamonds; multi-link entries and ignored properties; identity-based sameness; root first; 20,000-node chain without recursion; errors from `accept` propagate; collector refusals; components from every member |
| `05_Plain.ipynb` | PLN | 16 | Native entry points; exact snapshot format; schema-ordered properties and relation-ordered entry fields; symbol order; single-object vs reachable scope; round trips without duplicated entries; edge values; symbol renumbering on round trip; root schema and type checks; serializing fakes; 26 malformed snapshots each rejected with an exact `DecodeError` path and reason; disagreeing ends; wrong value types as `DecodeError`s with paths; rejection builds nothing, and no builder is called before every value is decoded; only the given store builds, and a store's own errors propagate; non-native entry properties refused; per-kind JSON/YAML entry points |
| `06_JSON.ipynb` | JSN | 11 | No NaN/Infinity output; rejection of constants, duplicate keys and syntax errors; str/UTF-8/16/32/BOM inputs; key order, non-ASCII, indentation; integers of any size, exact floats, every string; lone surrogates; top-level natives; agreement with Plain and graph round trips; a 62-row table of `DecodeError` reasons, lines and columns (code points) shared with TypeScript, and the reference parser agreeing with `json` on valid input; only plain data (str keys) written; every plain value in exact text, compact and indented |
| `07_YAML.ipynb` | YML | 14 | YAML 1.2 core scalar resolution (54 forms); 55 misreadable strings read back by our loader and stock YAML 1.1; YAML 1.1 single-letter booleans quoted; Unicode line breaks; long and whitespace-heavy strings; numeric fidelity and non-finite floats; the framework's YAML profile as a 48-row table of exact `DecodeError` messages and positions shared with TypeScript (documents, key types, duplicates, tags, aliases, unprintable characters, first problem wins); syntax errors as one-line `DecodeError`s with a position; accepted anchors/aliases, merge key as plain key, empty documents; no aliases on output; hand-written snapshots; agreement with Plain; behavior without PyYAML; every plain shape round-trips; only plain data written |
| `08_Validators.ipynb` | VAL | 14 | Natives; valid data; property types with paths; entry property types, unknown names, missing links, wrong-schema targets; checks on reached objects; `unique` semantics incl. absent, -0.0, NaN; clauses over links, empty, and everything; schema problems once; root schema mismatch; component-scoped uniqueness; validation changes nothing; non-native entry properties refused; `properties_of` reads any object's property values, and `entries_of` its entries by adjacency |
| `09_Properties.ipynb` | PROP | 5 | For all natives: exact round trip through Plain, JSON, YAML; lone surrogates; mismatched types always rejected. For random graphs (1–6 nodes, 0–10 entries, random optional values incl. NaN, -0.0, surrogates, bytes): validity, reachability equals the independently computed component, snapshot scope, round trips through all three encodings. Entry-set cardinality equals distinct entries under schema equality |
| `10_Examples.ipynb` | EX | 1 | Every example module exits cleanly in its own process |
| `11_Conformance.ipynb` | CONF | 4 | This implementation's corpus files are current; JSON is byte-identical to TypeScript's for every case; every implementation's YAML reads back to the same snapshot, also under YAML 1.1; every implementation's JSON and YAML deserialize with Python's builders to the same graphs and validate |
| `12_Text.ipynb` | TXT | 4 | Messages are identical across implementations: `repr` of every native and container, float `repr`, type names, code-point string order |
| `13_Comparison.ipynb` | CMP | 12 | Ordered natives (ints beyond 2^53, strings by code point without normalization, bytes lexicographically); floats by value with `-0.0` before `0.0` and NaNs equal only to NaNs; booleans equal or incomparable; absent values, exact native types, distinct native types; objects equal by declared properties, adjacencies excluded; links by identity; entries by links and properties, from either end; adjacencies as sets with equal entries elided; object-valued properties and mismatched kinds; reading recordings back through the protocols; union and intersection values need schemas of their kind |
| `14_Embedded.ipynb` | EMB | 11 | Value objects' schemas may have adjacencies, however held; value objects set by Spec or record, read-only, updated in part, cleared; union values hold one branch, set and read by name, and writing a branch clears any other, and a union value without a branch is no value; snapshots write value objects and union values nested, a union value keyed by its branch, with strict decoding (exactly one branch); validation of embedded values recursively and of a union value's one branch; `properties_of` reads through both; comparison by properties, and by branch and value; the new visitor classes read back through their protocols; intersection values hold each part by name, and parts do not merge, in proxies, snapshots, validation (every part present) and comparison, including an intersection of unions; value objects with identities and adjacencies: kept through edits, copied with their entries (into another owner, with a clone, within unions and intersections), removed with them, written with `$id` and linked without `$schema`, decoded, validated and compared deeply, links among them by path; entry properties holding value objects, which have no adjacencies, key and compare their entries, and are written nested; flat unions and intersections: values read as their branch's (in lists and keyed lists too), set by type or by Spec, a value of no branch's type refused, parts' properties read and set as the value's own, a part not set, the wire form per branch and per part, validation (branches not told apart by type: twin natives, lists, keyed lists, schemas, another format's tokens; parts not objects, or declaring one name twice), modules writing and reading `flat` |
| `15_Skill.ipynb` | SKL | 3 | The agent guides stay true: the packaged copy of the skill matches `skills/mbse-schemas/`; the skill's complete Python program runs; every link in `AGENTS.md`, `llms.txt` and the skill resolves, anchors included |
| `16_Dataclasses.ipynb` | DC | 7 | Python only (the adapter is Python's own). Native fields to properties in order, inherited fields included, string annotations resolved, defaults, `ClassVar` and `InitVar` left out; `set`/`list`/`dict` of dataclasses (and unions of them) to relations with `owner`/`item` links, `index`/`key` properties and `unique(item)`, the owner's adjacency and each element's `item` adjacency, self-relations, and proxies, snapshots and validation on the result; lists of natives (at any depth) to lists and dicts of them by non-`int` native keys to keyed lists, both ways; refusals of non-dataclasses, other collections, sets and dicts of natives, unions, nested classes, other types and name clashes, each with its reason; trees from `FromDataclass.ast` and built by other tools; `ToDataclass` writing natives and containers typed by reverse lookup of the adjacencies via the other link, `item` views left out, no defaults, postponed annotations; round trips of whole models; refusals of value objects, union and intersection values, relations without a container form, unknown element types, reserved and non-identifier names and malformed trees |
| `17_Lists.ipynb` | LST | 15 | `OfIndexed`: one item schema of any kind, validated, never a reference object schema, nor an entry value object with adjacencies; proxies read a list as a read-only sequence and set it from items, values or Specs, an empty list unlike an absent one, an item with no value left out; a Spec edits a list through its builder (`items`, `item`, `append`, `remove`, `clear`), keeping identities, in lists of lists too; value objects in lists link each other and reference objects, are copied into another owner and by a clone with their entries, and are removed with theirs, nested ones included; snapshots write arrays, `$id` in lists, and decode strictly with paths into them; validation per item; comparison item by item, lexicographic, a prefix less; reachability through lists; entry properties holding lists; every list class through its protocol; keys and extents: a key schema makes a list keyed (never a reference object, no adjacencies in a key's value objects), an `int` key or none keeps it positional, extents only on positional lists, of ints, ordered; keyed lists read as a read-only mapping in insertion order, looked up by schema equality (value object keys by structure), standing alone and generic (NaN keys equal, `-0.0` and `0.0` apart, a list key, generated value objects' keys by class and fields set, Python only), set from mappings or pairs, edited by key through `pairs`, `at`, `put`, `discard`, with `append` refused; positional lists addressed by key from the extent's minimum, validated against the extent; keyed lists written as mappings from the key's canonical text when it never starts with `$` (`float` incl. `NaN` and `-0.0`, `bool`, `bytes`) or as `{key, value}` arrays (`str` keys, `$ref` among them, and value objects), decoded strictly; validation by position with duplicate keys reported, comparison as mappings, entries keyed by keyed lists, reachability through them; every keyed list class through its protocol |
| `18_Modules.ipynb` | MOD | 6 | Meta-schemas validate, `Schemas.Module` registered in every proxy store, the kinds as union branches, `store.registered`; a module holds named schemas (an unnamed one refused), writes each inline by kind and refers to named schemas by name, writing an unnamed one, a relation too, inline, empty contents left out; modules through JSON, YAML, validation and comparison; reading back shares what is named, resolves names in the store, keeps natives' widths and tokens, and reads recursive schemas as themselves; validating a schema that holds itself ends, reporting each problem once; refusals of unnamed self-reference, non-schemas, unsupported tokens, unknown names, names of the wrong kind and names defined twice; one type by name or inline (`reference` needs no store, `resolve` reads names in one); descriptions of every element written last, only where present, and read back |
| `19_Bindings.ipynb` | BND | 4 | Typed bindings: a class of the program's own, bound to a reference object schema by `read` and `make`, writes itself through `accept` (natives, value objects and lists as plain data, entries with their links and properties, absent ones left out) and is rebuilt in a store of bound classes from JSON and YAML, validated and compared; a builder over a state checks natives by type, keeps a fixed property at its value, clears the other properties of an exclusive group, holds other values as plain data, reads, adds and removes entries, ignores entries of an implied adjacency, and finalizes by `create`, `clone` and `update` (`assign`, the identity by default); the store exposes builders by schema name, never relation builders, and an unknown name raises `AttributeError`; refusals of unknown properties, adjacencies and links, unset links and properties, wrong types and wrong fixed values, each with its message |
| `20_Stores.ipynb` | STO | 6 | A store holds named schemas, each under its name (an unnamed schema refused, registering twice, unknown names, relations, the meta-schemas it starts with, names a method shadows, `names()`); a store's data is what its singletons reach (a singleton made with its schema, extents by reachability through entries, transitively and from a second root without repeats, unreached objects in no extent and garbage-collected, a second instance by `create()`, `clone()` or a second registration refused, decoding a singleton updates the store's instance); stores are isolated (one name in two stores, linking or building across stores refused, snapshots move objects between stores, validation and modules in a store, `Proxies.store_of`); both implementations meet `Stores.Store` (`Proxies.OfStore`, `Bindings.OfStore`, which makes its singletons and whose extents are what they reach); a value object not yet placed belongs to no store; stores combined: each name its store's, the singletons all of theirs, extents the owning store's then what every store's singletons reach, each once, combined stores combined again, a store without singletons, refusals of unknown names, an unregistered schema, an unknown singleton and a name two stores register |
| `21_Random.ipynb` | RND | 3 | PCG32's reference sequence (pcg32-demo, seed 42, sequence 54) and its seeds' range; split streams determined by the seed and the key's UTF-8 bytes alone, the same in every implementation, and lone surrogates refused; no store holds a source (proxies, bound classes, the catalog), PCG32 meeting `Stores.Random` |
| `22_Parametrics.ipynb` | PAR | 7 | Parameters on every kind of schema, in order, typed or untyped, described, validated (reserved names, bad types and descriptions), part of a native's equality; terms where a width or an extent's bound stands: a dialect's term or its neutral form (`Form.of`, its dialect at its root only, forms within a term kept, bytes attributes by content), a form's shape validated and a dialect's left to it, capacities only of int bounds; `OfApply` by name and in order, partial and dependent, as a type (`as_apply`), with refusals of positional arguments before `.of()` and too many arguments, and problems for unknown parameters, wrong native types, non-native arguments, a missing or self-applied schema and the applied schema's own; data of an application is its applied schema's in proxies, JSON, YAML, validation, comparison, keys, union branches, entry properties and bound classes; modules write parameters (untyped ones without a type), terms in `terms`, applications with arguments of every native type, read them back as forms or through `make`, and refuse non-native attributes and arguments; checking evaluates extents through the caller's evaluator in lexical scopes (arguments evaluated where an application stands, dependent applications, a named schema's own scope, a minimum labeling items), with problems, unknowns (no evaluator, no value) and `holds` three-valued, `Validate` giving problems alone, a bound that is not an int a problem, and a self-applied type's data not checked; equivalence after substitution (`Square(4)` is `Matrix(4, 4)`), unbound unlike bound, natives by value and type, unknown where a value is |
| `23_Reflection.ipynb` | RFL | 3 | A store of schemas: what a store registers and the named schemas they refer to, by kind, in name order (ties in the order reached), its data not read, a schema registered later among them, its own meta-schemas left out, the meta-schemas the module form's, an unregistered name; a schema read through the visitor protocols as its module form with its name, every kind, an unnamed schema, `member`; each schema valid against its meta-schema, another format's token, an unsupported token, a store of schemas building nothing |
| `24_Paths.ipynb` | PTH | 3 | Singletons by their global names and other objects by route: keys by the first unique constraint that holds the object's own link and properties of types a path writes (strings, integers, booleans), else positions, constraints without the own link, without properties, with links or with a float skipped, a relation of three links naming the link; `find`, and `LookupError` for a path or an object no root reaches; paths surviving a property set and an entry added after, a positional entry shifting, the first route from roots in name order; a store of schemas naming its schemas, combined stores naming schemas then singletons, combined again |

Total: 205 cases, the sum of the rows above. The 198 outside DC have the same IDs, in the same order, as the TypeScript suites.

## Coverage of FRAMEWORK.md

| Requirement | Cases |
|---|---|
| Builders: what create, clone and update do; none validate | SCH-07, SCH-09, PRX-05, PRX-06 |
| Builders keep shallow copies separate from the source | SCH-10, PRX-05 |
| `Spec`: direct value or callable taking and returning the builder | SCH-02, SCH-08, SCH-14, PRX-03 |
| `OfAny.Builder` selects a kind; finalizes to that kind's data | SCH-06, SCH-07 |
| Properties optional; unset reads raise; instances read-only | PRX-02, PRX-03, VAL-02 |
| Relations: named untyped links; no one-link relations; adjacencies via `me` | SCH-12, SCH-13, PRX-07, PRX-14 |
| `unique(S)`: the rest determines `S` | SCH-13, VAL-06, VAL-07, VAL-08, VAL-11 |
| Entries form a set; equal entries elided; schema equality (types distinct, floats by bit pattern) | PRX-08, PROP-05, VAL-07 |
| Equality under a schema, and ordering only for ordered natives | CMP-01..12 |
| Union branches and intersection parts are named, unique and of one kind | SCH-14, SCH-15 |
| Native types are tokens; `basic` and the own format are read; a width is size only | SCH-18 |
| Reference object schemas are marked `.ref()`; no property holds one; only they are built and rooted on their own | SCH-19, VAL-13 |
| Value objects are value objects: owned, read-only, written nested; with identities and adjacencies | EMB-01, EMB-02, EMB-04, EMB-09 |
| Value objects keep their identity through edits, are copied with their entries, are removed with them; snapshots write `$id`, links without `$schema`, and an object's own `$schema` when nothing else gives it | EMB-09 |
| Union values hold one branch by name, in proxies and snapshots; validation checks there is exactly one | EMB-03..06 |
| Intersection values hold every part by name; parts do not merge | VIS-05, EMB-08 |
| Meta-schemas: modules hold schemas as data, by name and inline, read back sharing what is named | MOD-01..04, CONF-01..04 |
| Every element may be described; a description is text, documentation that no check of data reads | SCH-21, MOD-06 |
| Reflection: schemas are reference objects of their kinds' meta-schemas, written as their module form, and a store of schemas holds what a store registers and refers to | RFL-01..03 |
| Parameters: declared by every kind of schema, applied by `OfApply`, terms where widths and bounds stand; data of an application is its applied schema's; written in modules, byte-identical across implementations | PAR-01..05, MOD-01, CONF-01..04 |
| Evaluation: terms evaluated by the caller's evaluator in lexical scopes; checks three-valued (problems, unknowns); equivalence after substitution | PAR-06, PAR-07 |
| Keyed lists and extents: keys of any value schema, unique by schema equality; wire forms by key kind; extents bound positional lists | LST-10..15, MOD-03, CONF-01..04 |
| Lists: one item schema, items owned by the list's owner, ordered, written as arrays, validated per item, compared item by item | LST-01..09, CONF-01..04 |
| No relation builder for callers; entries through adjacencies | PRX-01, PRX-07 |
| Inline link creation needs unambiguous schema inference | PRX-09 |
| `clone()` copies adjacency entries | PRX-13 |
| Visitors: callbacks, `self` returns, conformance; proxies are `Visitable` | VIS-01..05 |
| Reachability in first-reference order | RCH-01..10, PLN-04 |
| Snapshot format; adjacencies included; links as `{$ref, $schema}`; unresolved references rejected | PLN-02, PLN-05, PLN-11, JSN-08, YML-10 |
| Objects carry no schema; root schema passed in; references carry schema names | PLN-11, PLN-12 |
| `FromPlain(store)` builds in the store given; everything that looks schemas up takes a store | PLN-14, STO-01..05 |
| Stores hold schemas and the data their singletons reach, isolated from one another; extents; the protocol | STO-01..05 |
| Natives representable in plain data (base64 bytes, non-finite floats) | SCH-04, SCH-05, JSN-01, YML-05, PROP-01 |
| Strict JSON | JSN-01..03 |
| YAML 1.2 loading, safe dumping, what is rejected | YML-01..08 |
| Decoding errors: `DecodeError` with a one-line reason and a line/column or path; identical across bindings except YAML syntax | SCH-03..05, PLN-05, PLN-11, PLN-12, PLN-14, JSN-02, JSN-03, JSN-09, YML-06, YML-06b, YML-09 |
| Validation only on request, with the documented checks | VAL-01..12, PRX-06 |
| Language independence: identical snapshots and interchangeable text across implementations | CONF-01..04 |

## Code coverage

The suites cover every statement and branch of `mbse/Schemas/Framework` (coverage.py, branch mode, subprocesses included:
see `[tool.coverage]` in `pyproject.toml`; `coverage report` fails below 100%). The TypeScript suites reach the same on
`src/Framework` (statements, branches, functions), with the same cases: gaps were closed by adding assertions to the
shared case in both languages, and code no test could reach was removed from both. See `../../docs/EQUIVALENCE.md`.

## Findings

| ID | Finding | Status | Cases |
|---|---|---|---|
| F1 | YAML: strings containing NEL (`\x85`) came back with the NEL folded into a space; PyYAML wrote it raw inside single quotes | Fixed: strings with NEL/LS/PS are double-quoted | YML-03 |
| F2 | Names that collide with binding members: `create` etc. cannot be set through the DSL; `_values` is shadowed by a proxy internal; `accept` by an instance method. `validate()` accepts them, except names starting with `$`, reserved for the wire format | Pinned, `$` names resolved; open question in FRAMEWORK.md | SCH-16, PRX-04 |
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

## Not testable yet (specified in FRAMEWORK.md, not implemented)

- Mutations, transactions, symbol bindings and mutation serialization.
- Deleting objects (and entries vanishing with them).
- Meta-schemas (`Schemas.OfX.Schema`) and schema builders implementing `Visitors` (serializing schemas).
- An "any value" `OfAny` kind.
- Mixing implementations (proxies and generated bindings, which will live in separate repositories, one per target language).

---

<!-- nav -->
[← Python package](../README.md) · [Home](../../README.md) · [TypeScript package →](../../typescript5/README.md)
