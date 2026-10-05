# Guide for AI agents

mbse-schemas formalizes interfaces and data models as neutral, language-independent schemas: objects, relations
whose entries carry properties, unions and intersections. The same schema drives in-memory objects, JSON and YAML,
validation and comparison. It targets model-based systems engineering (MBSE) and any interface that several
programs, languages or tools must agree on. Two equivalent implementations exist: `python3/` and `typescript5/`.

## Start here

| You want to | Read |
|---|---|
| Learn it by example, from a contact card to evolving schemas | [python3/tutorials/README.md](python3/tutorials/README.md), nine case studies; the same in [typescript5/tutorials/](typescript5/tutorials/README.md) |
| Know why the mbse repositories exist, and this one's part in them | [MBSE.md](MBSE.md) |
| Use the library, or model something with it | [skills/mbse-schemas/SKILL.md](skills/mbse-schemas/SKILL.md), a skill. It loads its references only as needed |
| Understand a design rule or an open question | [docs/FRAMEWORK.md](docs/FRAMEWORK.md), by section |
| Change the framework | this file, then [docs/EQUIVALENCE.md, Keeping them equivalent](docs/EQUIVALENCE.md#keeping-them-equivalent) |
| Find or add a test case | [python3/tests/TestPlan.md](python3/tests/TestPlan.md) (TypeScript's plan lists only its differences) |

## Invariants when changing code

- **One vocabulary across the mbse repositories.** A kind's or schema's named members are *properties*, never
  "fields" (a field is only the host language's class member that holds one). An element of an expression tree is
  a *term* (mbse-expressions), and of a program tree a *syntax node* (mbse-programs); never a bare "node" in code,
  docs or messages.
- **The README opens with why.** Its first sentence or paragraph says, TL;DR style, why this repository exists, in
  the terms of `MBSE.md`; what it is comes after. Keep that opening true as the repository changes.
- **Every human-facing document has navigation.** A `{previous, home, next}` line heads and ends each document in
  reading order (README, MBSE.md, tutorials, design, conformance, packages and test plans); after adding, renaming or
  retitling one, run `python3 scripts/nav.py`. Link text is human-readable, never a path.
- **The two implementations are equivalent.** Change both in the same commit, with the same names, the same error
  classes and byte-identical messages. JSON output must be byte-identical: regenerate the corpora and let CONF-02
  compare them. A difference not listed in `docs/EQUIVALENCE.md` is a bug. Adapters (`python3/mbse/Schemas/Adapters`)
  are the exception: each translates its own language's type declarations.
- **Tutorials are tested too.** `pytest` and `npm run coverage` run `tutorials/` beside `tests/`; the two languages
  tell the same case studies with the same outputs. Re-execute a tutorial after a change that alters its output, and
  commit it with its outputs.
- **Tests are Jupyter notebooks**, one suite per notebook, with the same case IDs in the same order in both
  languages. Each case is a markdown cell `## ID · title` followed by one code cell. Notebooks are JSON written with
  `indent=1`, `sort_keys=True` and `ensure_ascii=False`.
- **Coverage is 100%** in both languages, statements and branches. Close a gap with an assertion in the shared case,
  in both suites.
- **The skill is packaged with each implementation.** After editing `skills/mbse-schemas/`, run `skills/sync.sh`;
  SKL-01 fails until the copies match. Every fenced block tagged `python` or `typescript` in the skill is a complete
  program that SKL-02 runs; tag fragments `python fragment` or `typescript fragment`.
- **Behavior is decided in `docs/FRAMEWORK.md`.** Record new decisions under Resolved, and put what stays undecided
  under Open questions.

## Commands

```sh
cd python3 && uv sync --all-extras          # Python: use uv, never pip
uv run coverage run -m pytest && uv run coverage combine && uv run coverage report
uv run python -m mbse.Schemas.Conformance.write

cd typescript5 && nvm use && npm install    # TypeScript: Node 22, 24 and 26 are supported
npm run coverage                            # type-checks, runs every notebook, gates at 100%
npm run conformance
npm run portability                         # the core without Node (browser bundle + Deno)
```

## Related repositories

- [mbse-expressions](https://github.com/pitaman71/mbse-expressions): expressions (constraints) and their
  evaluators, and [mbse-programs](https://github.com/pitaman71/mbse-programs): programs as syntax trees. Each depends on
  this repository as a sibling checkout (`../mbse-schemas`), and pins the version and commit it was tested with.
- **Releases are versions and tags.** The Python and TypeScript packages share one version; a release is the tag
  `v<version>`. Below 1.0, a change that dependents must adapt to bumps the minor version. Dependents develop against
  this checkout as it is, and pin a release with their `scripts/siblings.py pin`. A change that spans repositories is
  made in a workspace from a dependent's `scripts/siblings.py workspace <dir> --branch <name> --edit mbse-schemas`, so
  that parallel work elsewhere does not see it half-finished, and landed with its `scripts/siblings.py land <dir>`.
  That tool is kept here, in [scripts/siblings.py](scripts/siblings.py), and each dependent's copy only runs it; its
  tests are `python3 -m unittest discover -s scripts`. It is scaffolding while the repositories co-evolve unpublished:
  keep it small.
- Generated bindings will live in one repository per target language (e.g. mbse-cpp, mbse-python, mbse-typescript,
  mbse-systemverilog), each depending on this one.
