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

## Read before any work

Agents must read these mbse-basis documents before doing any work:

- [The mbse basis](../mbse-basis/docs/README.md)
- [Principles](../mbse-basis/docs/PRINCIPLES.md)
- [Features](../mbse-basis/docs/features/README.md)
- [Capabilities](../mbse-basis/docs/capabilities/README.md)

These may be read selectively, on demand: [Vocabulary](../mbse-basis/docs/VOCABULARY.md) and
[Qualities](../mbse-basis/docs/QUALITIES.md).

Never write to `~/.claude/projects/*/memory/` or any hidden memory: what is worth keeping goes in the repository.

## Commands

```sh
cd python3 && uv sync --all-extras          # Python: use uv, never pip
uv run coverage run -m pytest && uv run coverage combine && uv run coverage report
uv run python -m mbse.Schemas.Conformance.write

cd typescript5 && nvm use && npm install    # TypeScript: Node 22, 24 and 26 are supported
npm run coverage                            # type-checks, runs every notebook, gates at 100%
npm run conformance
npm run portability                         # the core without Node (browser bundle + Deno)
skills/sync.sh                                  # after editing skills/mbse-schemas/: the packaged copies (SKL-01)
```

## Related repositories

- [mbse-expressions](https://github.com/pitaman71/mbse-expressions): expressions (constraints) and their
  evaluators, and [mbse-programs](https://github.com/pitaman71/mbse-programs): programs as syntax trees. Each depends on
  this repository as a sibling checkout (`../mbse-schemas`), and pins the version and commit it was tested with.
- **Releases**: a change that spans repositories is made in a workspace from a dependent, with `--edit mbse-schemas`.
- [mbse-codegen-python](https://github.com/pitaman71/mbse-codegen-python) generates Python source from these schemas,
  the first of one code generator per target language family.
