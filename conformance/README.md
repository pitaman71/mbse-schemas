# Conformance corpus

Each implementation builds the same corpus of schemas and objects, statement for statement
(`python3/mbse/Schemas/Conformance/Corpus.py`, `typescript5/src/Conformance/Corpus.ts`), and commits its snapshots here as
`<implementation>/<case>.json` (reachable snapshot, indent 2) and `<case>.yaml`.

| Case | Covers |
|---|---|
| `address_book` | objects shared by two owners, inline creation through links |
| `natives` | every native type at its edges: 2^100, -0.0, NaN, ±Infinity, all 256 byte values, control characters |
| `family` | a relation between objects of the same schema, a cycle, a self-loop |
| `enrollment` | a three-link relation with int, float and bool entry properties |
| `yaml_strings` | strings that YAML readers misread, Unicode line breaks, long text |
| `embedded` | value objects, one linked through a relation (`$id`, and a reference without `$schema`), a card reached only through its value object (carrying its own `$schema`), union values of object and native branches, keyed by branch name, and an intersection value, keyed by part name |
| `lists` | lists of strings, bytes, lists of ints, union values and value objects; value objects in lists linking each other and a reference object by `$id` |

The CONF test suite in each implementation checks that:

1. its own files are current (regenerate after a deliberate change);
2. every implementation has the same cases, and the JSON files are **byte-identical** across implementations;
3. every implementation's YAML reads back to exactly the same snapshot, also under a YAML 1.1 reader;
4. every implementation's JSON and YAML deserialize with its own builders to the same graphs, and validate.

Regenerate:

```sh
(cd python3 && uv run python -m mbse.Schemas.Conformance.write)
(cd typescript5 && npm run conformance)
```
