# Guide for AI agents

mbse-schemas formalizes interfaces and data models as neutral, language-independent schemas: objects, relations
whose entries carry properties, unions and intersections. The same schema drives in-memory objects, JSON and YAML,
validation and comparison. It targets model-based systems engineering (MBSE) and any interface that several
programs, languages or tools must agree on. Two equivalent implementations exist: `python3/` and `typescript5/`.

## Start here

| You want to | Read |
|---|---|
| Learn it by example, from a contact card to asking the store | [python3/tutorials/README.md](python3/tutorials/README.md), ten case studies; the same in [typescript5/tutorials/](typescript5/tutorials/README.md) |
| Know why the mbse repositories exist, and this one's part in them | [MBSE.md](MBSE.md) |
| Use the library, or model something with it | [skills/mbse-schemas/SKILL.md](skills/mbse-schemas/SKILL.md), a skill. It loads its references only as needed |
| Understand a design decision or an open question | mbse-basis: [the schema-driven data features](../mbse-basis/docs/features/README.md#schema-driven-data), each capability's detail file |
| Build schemas with the schema builders (`Framework.Builders`: the meta-schemas, their builders and the store), or migrate a call site to them | [CAP-109: schemas as linked objects in modules](../mbse-basis/docs/capabilities/CAP-109.md#the-meta-schemas-and-their-builders-as-built) |
| Change the framework | this file, then [docs/EQUIVALENCE.md, Keeping them equivalent](docs/EQUIVALENCE.md#keeping-them-equivalent) |
| Find or add a test case | [python3/tests/TestPlan.md](python3/tests/TestPlan.md) (TypeScript's plan lists only its differences) |

## Invariants when changing code

The conventions every mbse repository shares are stated once in mbse-basis; this file cites them and keeps
only what differs here.

- **Vocabulary**: [VOC-007: property](../mbse-basis/docs/VOCABULARY.md#VOC-007), [VOC-026: schema](../mbse-basis/docs/VOCABULARY.md#VOC-026), [VOC-008: term](../mbse-basis/docs/VOCABULARY.md#VOC-008), [VOC-009: syntax node](../mbse-basis/docs/VOCABULARY.md#VOC-009) and [VOC-002: constraint](../mbse-basis/docs/VOCABULARY.md#VOC-002), each qualified with whose it is where it meets a language's own term ([the vocabulary](../mbse-basis/docs/VOCABULARY.md), its introduction).
- **Documents**: navigation lines, the README opening with why, and what this file holds ([Rules for every document](../mbse-basis/docs/README.md#rules-for-every-document)).
- **Equivalence**: [PRI-028: both implementations change together](../mbse-basis/docs/PRINCIPLES.md#PRI-028), [PRI-037: the same conformance corpora](../mbse-basis/docs/PRINCIPLES.md#PRI-037), [PRI-038: the same cases in both languages](../mbse-basis/docs/PRINCIPLES.md#PRI-038), [PRI-039: 100% coverage of both](../mbse-basis/docs/PRINCIPLES.md#PRI-039) and [PRI-040: deliberate differences listed](../mbse-basis/docs/PRINCIPLES.md#PRI-040), the differences listed in `docs/EQUIVALENCE.md`. Here: regenerate the corpora (Commands) and let CONF-02 compare them. Adapters (`python3/mbse/Schemas/Adapters`) are the exception: each translates its own language's type declarations.
- **Tests and tutorials**: [PRI-035: tests are notebooks: one suite each, the same case IDs in the same order in both languages](../mbse-basis/docs/PRINCIPLES.md#PRI-035); [PRI-034: tutorials run as tests, committed with their outputs](../mbse-basis/docs/PRINCIPLES.md#PRI-034). `pytest` and `npm run coverage` run `tutorials/` beside `tests/`.
- **The skill**: [PRI-036: every program in a skill is complete and run; fragments are tagged as fragments](../mbse-basis/docs/PRINCIPLES.md#PRI-036), which SKL-02 checks. After editing `skills/mbse-schemas/`, run `skills/sync.sh`; SKL-01 fails until the packaged copies match (the copy [PRI-016: guidance written once](../mbse-basis/docs/PRINCIPLES.md#PRI-016) plans to remove).
- **Work**: [PRI-029: parallel work in polyrepo workspaces](../mbse-basis/docs/PRINCIPLES.md#PRI-029), [PRI-031: the version is the contract](../mbse-basis/docs/PRINCIPLES.md#PRI-031), [PRI-032: a sibling's gap is reported, not worked around](../mbse-basis/docs/PRINCIPLES.md#PRI-032) and [PRI-033: work lands by branch and pull request](../mbse-basis/docs/PRINCIPLES.md#PRI-033).
- **Behavior is decided in mbse-basis items**: [the schema-driven data features](../mbse-basis/docs/features/README.md#schema-driven-data) and their capabilities; before deciding, check an item's Decided sections and cite the entry, recorded as the basis says ([Detail files](../mbse-basis/docs/README.md#detail-files)).
- Never write to `~/.claude/projects/*/memory/` or any hidden memory: what is worth keeping goes in the repository.

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
- **Releases**: [PRI-031: the version is the contract](../mbse-basis/docs/PRINCIPLES.md#PRI-031); a change that spans repositories is made in a workspace from a dependent,
  with `--edit mbse-schemas` ([PRI-029: parallel work in polyrepo workspaces](../mbse-basis/docs/PRINCIPLES.md#PRI-029)).
- Code generation, one repository per target language family rendering schemas, expressions and patterns step by
  step through mbse-programs' syntax trees and mbse-patterns' `Transforms`, is [FEA-022: code generation](../mbse-basis/docs/features/README.md#FEA-022) and [FEA-021: every generation ambiguity a parameter](../mbse-basis/docs/features/FEA-021.md);
  mbse-codegen-python is the first.
