# Saving, loading and exchanging data

Documents are plain data (mappings, lists, strings, numbers, booleans), so they can be written as JSON or YAML. Python
and TypeScript write byte-identical JSON, and each reads the other's.

## The document format

A document is one transaction, one upsert (docs/OBJECT_IDENTITY.md, Decided, 51): reading it executes it.

```text
{"uid": "6f1c4e2a", "mutations": [{"upsert": {"key": "6f1c4e2a", "exists": [{
  "symbols": {"0": {"schema": [{"$ref": <Component's path>}]}, "1": {"schema": [{"$ref": <Port's path>}]}},
  "spec": [{"0": [{"as_property": {"name": "name", "mutations": [{"set": {"value": "cpu"}}]}},
                  {"as_adjacency": {"name": "ports", "mutations": [{"insert": {"entries": [{"mutations": [
                    {"as_link": {"name": "port", "mutations": [{"set": {"ref": {"symbol": "1"}}}]}}]}]}}]}}]},
           {"1": [{"as_property": {"name": "signal", "mutations": [{"set": {"value": {"width": 1, "unit": "bit"}}}]}}]}]}]}}]}
```

- The objects a document holds are its symbols, each named by its number in the order the document meets them from
  the root, `"0"`, and each naming its schema by the schema's path; the schema must be one the store holds. A Reachable
  document holds the root and the counted objects reachable from it; an object's document, the root alone, and writing
  one whose root links a counted object is refused. What a document does not hold, an owned object, a singleton or a
  schema object, it refers to by its path, `{"ref": {"path": ...}}`; reading refuses where the store holds nothing
  there.
- The spec gives, for each symbol, its properties set (`as_property`) and its named adjacencies' entries (`as_adjacency`
  then `insert`), each entry once, from the first object the document holds that holds it, sorted by the key its
  relation declares where that key's values are ordered. An entry's links refer to a symbol, `{"ref": {"symbol":
  "1"}}`, or a path; its properties follow. A property's value is written as a property holding it writes it: a value
  object, union value or intersection value nested, a container in its plain form.
- Reading binds a singleton's symbol to the singleton and an owned object's to the object its owning entry names,
  writing what the document holds and keeping what it omits; it makes counted objects anew. Under a `uid`, which the
  caller gives and which keys the upsert, reading the same document again while its counted objects are held finds them.

## Calls

| Call | Writes or reads |
|---|---|
| `ToPlain(store).OfObject(schema, value, uid)`, and the JSON and YAML forms | the root alone; refused where it links a counted object |
| `ToPlain(store).Reachable(schema, value, uid)`, and the JSON and YAML forms | the root and the counted objects reachable from it |
| `FromPlain(store)(schema, data)`, and the JSON and YAML forms | executes the document in the store given, within its open transaction as a savepoint, and gives the root; a document is how objects move between stores |
| `ToPlain(store).Transaction(tx)`, `FromPlain(store).Transaction(data)` | any transaction's expression; a journal is a list of them |

## Strictness

- JSON is strict. YAML is read with the 1.2 core schema, so `no` is a string (no "Norway problem").
- Nothing is coerced: `1`, `1.0` and `true` are different values, and a value of another scalar is an error.
- Every problem in the input raises `DecodeError` (a `ValueError`) with a one-line reason and a location: a line and
  column for text, or a path such as `$.mutations[0].upsert.exists[0].spec[0]["0"][1].as_property.mutations[0].set.value`.
  The reasons are identical in both languages, except for YAML syntax errors.
- A document's spec is checked against its symbols' schemas before anything is written; what only executing finds, a
  path to nothing, undoes what was written. A refused document writes nothing.
- Decoding does not validate. Call `Validators.Validate(builders).Reachable(schema, root)` afterwards if you need to.

## Go deeper

| Topic | Read |
|---|---|
| Identities, references, why the schema isn't stored, injected builders | [tutorial 6, Saving and loading](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/06_Saving_And_Loading.ipynb) |
| JSON and YAML details, the Norway problem | [tutorial 7, JSON and YAML](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/07_JSON_And_YAML.ipynb) |
| What decoding accepts, and every decoding error | [FRAMEWORK.md, Serialization](https://github.com/pitaman71/mbse-schemas/blob/main/docs/FRAMEWORK.md#serialization) |
| Store snapshots both languages must read identically | [conformance/](https://github.com/pitaman71/mbse-schemas/blob/main/conformance/README.md) |
