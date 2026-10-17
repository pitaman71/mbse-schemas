# Briefing for phase 2 agents (schema builders as visitors)

You are one of several agents working in parallel on mbse-schemas, each in its own git worktree and branch, branched
from `overhauls/meta-schemas` after phase 1 (commit 16950eb). Read this whole file, then your assignment.

## Read first

- `AGENTS.md` (repository invariants), and `docs/META_SCHEMAS.md`, Plan: the invariants are relaxed to the branch, so
  your commits may change one language only and may fall short of 100% coverage; the branch must pass every gate again
  before it lands (phase 3), so do not lower coverage of code you do not touch.
- `docs/FRAMEWORK.md`, Resolved, "Schema builders align with their meta-schemas": the user's decisions, quoted. Never
  contradict them; never invent a design they do not cover. If your work needs a decision they do not make, stop that
  part and report the question with the options you see, rather than choose.
- `docs/VISITOR_PATTERN.md`: the visitor protocol and its shorthands, which are the correct form.
- `docs/proposals/schema-builders/README.md`: the design as built, the old clause → new table, and the work items.
- `python3/mbse/Schemas/Framework/Builders.py` and `python3/tests/25_Builders.ipynb` (suite BLD): the Python core and its
  tests. These are the reference for behavior and messages.

## The API, in brief

```python
from mbse.Schemas.Framework import Builders as B, Schemas as S

Text, Int = S.OfScalar.Data(str), S.OfScalar.Data(int)
store = B.Store()
Person = store.Schemas.Object(lambda o: (
    o
    .name("crm.Person")
    .ref(True)
    .properties([
        lambda t: t.name("given_name").schema([Text]),
        lambda t: t.name("age").schema([Int]),
    ])
))
Knows = store.Schemas.Relation(lambda r: (
    r
    .name("crm.Knows")
    .links([
        lambda t: t.name("knower"),
        lambda t: t.name("known"),
    ])
    .properties([lambda t: t.name("since").schema([Int])])
    .uniques("since")
))
store.Schemas.Object(Person, lambda o: o.adjacencies([
    lambda t: t.name("acquaintances").relation([Knows]).me("knower"),
    lambda t: t.relation([Knows]).me("known"),  # anonymous: no name
]))
ada = store.crm.Person(lambda c: c.given_name("Ada").age(36))  # create
store.crm.Person(ada, lambda c: c.age(37))                     # update: the object first
twin = store.crm.Person(ada)                                   # clone
```

- Every schema object is a reference object, built in a store: `store.Schemas.<Kind>(...)` (Scalar, Object, Union,
  Intersection, Container, Apply, Any, Relation, Predicate, Property, Parameter, Symbol, Member, Adjacency, Form). Data
  is built with `store.<dotted schema name>(...)`. A callback creates, an object and a callback update, an object alone
  clones; the call returns the object. Named schemas register under their name.
- Every reference between schema objects is an adjacency, given with the peer shorthand: `.schema([T])`,
  `.refines([T])`, `.index([T])`, `.element([T])`, `.of([T])`, `.relation([R])`, `.bits([term])`, `.requires([term])`,
  `.schemas([T, U])`. A schema's members are given as `.properties([lambda t: t.name("x").schema([T]), ...])` (likewise
  `adjacencies`, `parameters`, `branches`, `parts`, `symbols`, `links`); a member's name is its entry's (`t.name`).
- By exception, `me` and `uniques` name links and properties by string: `.me("knower")`, `.uniques("since")`,
  `.uniques(["a", "b"])`, `.uniques([["a"], ["b", "c"]])`.
- Value properties take their value whole, of exactly their type: `.ref(True)`, `.flat(True)`, `.layout("dense")`,
  `.token("int")`, `.format("ccpp").token("int32_t")`, `.pattern(r"FEA-(\d+)")`, `.singleton("x")` (which no longer
  sets `ref`: write `.ref(True)` too). An int width is `[B.Form.Builder().kind("literal").attributes({"value": 8}).create()]`.
- `S.OfScalar.Data(int)` and the other `S.OfX.Data` constructors remain, unchanged.

## Formatting (mbse-basis P-019)

Models as data are written in fluent builder syntax, never wire format or pseudocode. In notebooks and examples: wrap a
builder chain in parentheses, one clause per line, one item per line in a list with a trailing comma; a short chain may
stay on one line. A callback that writes several clauses is `lambda o: (o.a(...).b(...))` laid out one clause per line,
as above.

## Working rules

- Work only in your worktree and only on the files your assignment names; other agents own the rest. Do not edit
  `docs/FRAMEWORK.md` unless your assignment says so.
- Python: `cd python3 && uv sync --all-extras` first (each worktree has its own environment); run tests with
  `uv run pytest -q <notebook>` and coverage with `uv run coverage run -m pytest && uv run coverage combine && uv run
  coverage report`. Use uv, never pip. TypeScript: `cd typescript5 && npm install`, then `npm run coverage`.
- Notebooks are JSON with `indent=1`, `sort_keys=True`, `ensure_ascii=False`, each cell with an `id`; a case is a markdown
  cell `## ID · title` and one code cell. Keep case IDs and their order; if a case tests only old-builder behavior that no
  longer exists, replace it with the new builders' equivalent and say so in your report.
- Messages and behavior come from Builders.py; never change Builders.py or Proxies.py (the TypeScript-core and
  wire-format agents excepted, as their assignments say). If you find a bug there, report it.
- Commit on your branch, with messages that end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, and
  push after every commit: `git push -u origin HEAD`. Never push to `overhauls/meta-schemas`; the lead merges.
- Never write to `~/.claude/projects/*/memory/` or any other hidden memory.
- Report at the end: what you changed, what passes (with the test output's summary line), coverage of the files you
  touched, anything you could not do, and every question that needs the user's decision.
