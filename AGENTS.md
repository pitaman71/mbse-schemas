# Guide for AI agents

mbse-schemas formalizes interfaces and data models as neutral, language-independent schemas: objects, relations
whose entries carry properties, unions and intersections. The same schema drives in-memory objects, JSON and YAML,
validation and comparison. It targets model-based systems engineering (MBSE) and any interface that several
programs, languages or tools must agree on. Two equivalent implementations exist: `python3/` and `typescript5/`.

## Start here

| You want to | Read |
|---|---|
| Learn it by example, from a contact card to keeping a store's history | [Tutorial: the schemas framework in twelve case studies](python3/tutorials/README.md), twelve case studies; the same in [typescript5/tutorials/](typescript5/tutorials/README.md) |
| Know why the mbse repositories exist, and this one's part in them | [Why the mbse repositories exist](MBSE.md) |
| Use the library, or model something with it | The skill, written once: [its source](skills/mbse-schemas/SKILL.md), packaged in each language as [the Python copy](python3/mbse/Schemas/Framework/skill/SKILL.md) and [the TypeScript copy](typescript5/skill/SKILL.md). Each practice links its case in each language's tutorials or tests; it loads its references only as needed |
| Understand a design decision or an open question | mbse-basis: [the schema-driven data features](https://github.com/pitaman71/mbse-basis/blob/main/docs/features/README.md#schema-driven-data), each capability's detail file |
| Build schemas with the schema builders (`Framework.Builders`: the meta-schemas, their builders and the store), or migrate a call site to them | [CAP-109: schemas as linked objects in modules](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/CAP-109.md#the-meta-schemas-and-their-builders-as-built) |
| Change the framework | this file, then [docs/EQUIVALENCE.md, Keeping them equivalent](docs/EQUIVALENCE.md#keeping-them-equivalent) |
| Find or add a test case | [Test plan — python3](python3/tests/TestPlan.md) (TypeScript's plan lists only its differences) |

## Read before any work

Agents must read these mbse-basis documents before doing any work:

- [The mbse basis](https://github.com/pitaman71/mbse-basis/blob/main/docs/README.md)
- [Principles](https://github.com/pitaman71/mbse-basis/blob/main/docs/PRINCIPLES.md)
- [Features](https://github.com/pitaman71/mbse-basis/blob/main/docs/features/README.md)
- [Capabilities](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/README.md)

These may be read selectively, on demand: [Vocabulary](https://github.com/pitaman71/mbse-basis/blob/main/docs/VOCABULARY.md) and
[Qualities](https://github.com/pitaman71/mbse-basis/blob/main/docs/QUALITIES.md).

Never write to `~/.claude/projects/*/memory/` or any hidden memory: what is worth keeping goes in the repository.

Resolve a link written `mbse:<repo>/<path>`, as skills and source comments write a link into another mbse
repository, to the first of these that exists: in a polyrepo checkout, `<repo root>/../<repo>/<path>`, where `<repo
root>` is this repository's root; for a link into the installed package's own repository, `<path>` without its
language directory (`python3/` or `typescript5/`), under the installed package's root (Python: the `site-packages`
directory that holds `mbse/`; npm: the package's directory), where the package ships that file; otherwise
`https://github.com/pitaman71/<repo>/blob/main/<path>`.

## Commands

```sh
cd python3 && uv sync --all-extras          # Python: use uv, never pip
uv run coverage run -m pytest && uv run coverage combine && uv run coverage report
uv run python -m mbse.Schemas.Conformance.write

cd typescript5 && nvm use && npm install    # TypeScript: Node 22, 24 and 26 are supported
npm run coverage                            # type-checks, runs every notebook, gates at 100%
npm run conformance
npm run portability                         # the core without Node (browser bundle + Deno)
skills/sync.sh                              # after editing skills/mbse-schemas/: the packaged copies (SKL-01)
```

The skill is written once, in `skills/mbse-schemas/`, mostly language-independent (mbse-basis
[PRI-016: guidance written once](https://github.com/pitaman71/mbse-basis/blob/main/docs/PRINCIPLES.md#PRI-016)): each practice says why, when and how, links the items for what, and links each how
to its case in both languages, as `mbse:` links with a `#Tnn.k` anchor (a tutorial step) or a test's case ID. It holds
no programs and no per-language cheat sheets. `skills/sync.sh` copies it byte for byte into
`python3/mbse/Schemas/Framework/skill/` and `typescript5/skill/`; SKL-01 checks the copies in both suites, and SKL-03
that every case it links has its `<a id>` in both languages, but for the cases
[Equivalence of the implementations](docs/EQUIVALENCE.md#cases-in-one-language-only) lists as one language's only (the dataclasses
adapter's, DC). Each tutorial step's markdown cell starts with `<a id="Tnn.k"></a>`, and each test case's with
`<a id="ID"></a>`, the same in both languages. A how the skill teaches with no case is a bug, since it is untested
([the basis](https://github.com/pitaman71/mbse-basis/blob/main/docs/README.md#the-doc-spec)): write the case, in both languages, before linking it.
SKL-04 finds such gaps: each section of the skill (a `##` or `###` heading and its text) links a case in each
language, or, where it teaches no how (an introduction, a routing table, links to go deeper), says why on the line
after its heading, as `<!-- no case: reason -->`; a section whose subsections each pass passes.

## Related repositories

- [mbse-expressions](https://github.com/pitaman71/mbse-expressions): expressions (constraints) and their
  evaluators, and [mbse-programs](https://github.com/pitaman71/mbse-programs): programs as syntax trees. Each depends on
  this repository as a sibling checkout (`../mbse-schemas`), and pins the version and commit it was tested with.
- **Releases**: a change that spans repositories is made in a workspace from a dependent, with `--edit mbse-schemas`.
- [mbse-codegen-python](https://github.com/pitaman71/mbse-codegen-python) generates Python source from these schemas,
  the first of one code generator per target language family.
