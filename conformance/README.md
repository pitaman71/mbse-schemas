<!-- nav -->
[← Visitor pattern](../docs/VISITOR_PATTERN.md) · [Home](../README.md) · [Python package →](../python3/README.md)

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
| `module` | the corpus's own schemas as data: a module of object, relation, union, intersection, application and native schemas, natives of widths (one a compound term over parameters) and another format's token, a list declared inline, a flat union and a flat intersection, shared schemas by name and the others inline |
| `lists` | lists as one-link relations: of strings, bytes, lists of ints (value objects holding lists), union values and value objects; value objects in entries linking each other, one nested in another's list, and a reference object by `$id`; keyed by `str`, by `float` (including `NaN`, whose key is not ordered, so entries keep their order), by a value object, and by a pair of ints (a matrix), written as entries sorted by key where it orders |

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

---

<!-- nav -->
[← Visitor pattern](../docs/VISITOR_PATTERN.md) · [Home](../README.md) · [Python package →](../python3/README.md)
