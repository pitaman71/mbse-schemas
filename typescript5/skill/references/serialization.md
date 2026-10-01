# Saving, loading and exchanging data

Snapshots are plain data (mappings, lists, strings, numbers, booleans), so they can be written as JSON or YAML. Python
and TypeScript write byte-identical JSON, and each reads the other's.

## The snapshot format

```json
{"root": "s0", "objects": {
  "s0": {"name": "cpu", "ports": [{"port": {"$ref": "s1", "$schema": "Port"}}]},
  "s1": {"name": "irq", "signal": {"width": 1, "unit": "bit"},
         "reach": {"phone": {"number": "1"}},
         "owner": [{"owner": {"$ref": "s0", "$schema": "Component"}}]}}}
```

- Objects are keyed by *symbols* (`s0`, `s1`, ...), local to one snapshot. Each object appears once, however many
  objects link to it, and cycles need no special handling.
- An object maps property names to values, and adjacency names to lists of entries. An entry holds the other links
  as references `{"$ref": symbol, "$schema": name}` and its own properties. The object's own link is implied.
- A value object is a nested mapping, with its own adjacencies nested in it. One that something
  links to carries its symbol, `"home": {"$id": "s3", ...}`, and links to it are `{"$ref": "s3"}`, without a schema.
  Union and intersection values are nested mappings keyed by branch or part name: a union value has exactly one key,
  and an intersection value one per part. A list is an array of its items, and `[]` is an empty list, not an absent
  one; a value object in a list is nested like any other. A keyed list is a mapping from its keys' text when its key
  is a native (`{"gain": 1.5}`, `{"0.5": "half"}`, `{"true": "on"}`, bytes keys as base64), and otherwise an array of
  `{"key": ..., "value": ...}`. Decoding accepts only a key's canonical text and rejects a key that appears twice.
- Object content carries no schema, except where nothing else gives it. The root schema is passed to the decoder, and
  references to reference objects carry schema names, so a linked reference object's schema must be registered. An
  object reached only through links to its value objects carries its own `"$schema"`.

## Schemas as data

A module is an object holding schemas by name, so schemas save, load, validate and compare like any data:

```python fragment
text = JSON.ToJSON(S.Module.Schema, Modules.module({"Contact": Contact, "Phone": Phone}))
schemas = Modules.schemas(JSON.FromJSON(B)(S.Module.Schema, text))   # {"Contact": ..., "Phone": ...}
```

Each schema is written inline by kind (`{"object": {...}}`), and refers by name (`{"named": {"name": "Phone"}}`) to
the schemas in the module and those registered; a name resolves within the module, then in the registry. A schema
that refers to itself must be named.

## Calls

| Call | Writes or reads |
|---|---|
| `ToPlain.OfObject` / `ToJSON.OfObject` / `ToYAML.OfObject` | the root only; its references stay unresolved, and decoding rejects them |
| `ToPlain.Reachable` / `ToJSON.Reachable` / `ToYAML.Reachable` | the root and everything reachable through adjacencies |
| `FromPlain(builders)(schema, data)` and the JSON and YAML forms | builds with the builders you inject, usually `Proxies.Builders` |

## Strictness

- JSON is strict. YAML is read with the 1.2 core schema, so `no` is a string (no "Norway problem").
- Nothing is coerced: `1`, `1.0` and `true` are different values, and a wrong type is an error.
- Every problem in the input raises `DecodeError` (a `ValueError`) with a one-line reason and a location: a line and
  column for text, or a path such as `$.objects.s0.signal.width`. The reasons are identical in both languages, except
  for YAML syntax errors.
- Decoding checks everything before building anything, so a rejected snapshot builds nothing.
- Decoding does not validate. Call `Validators.Validate(builders).Reachable(schema, root)` afterwards if you need to.

## Go deeper

| Topic | Read |
|---|---|
| Symbols, references, why the schema isn't stored, injected builders | [tutorial 6, Saving and loading](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/06_Saving_And_Loading.ipynb) |
| JSON and YAML details, the Norway problem | [tutorial 7, JSON and YAML](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/07_JSON_And_YAML.ipynb) |
| The rules, and every decoding error | [FRAMEWORK.md, Serialization](https://github.com/pitaman71/mbse-schemas/blob/main/docs/FRAMEWORK.md#serialization) |
| Snapshots both languages must read identically | [conformance/](https://github.com/pitaman71/mbse-schemas/blob/main/conformance/README.md) |
