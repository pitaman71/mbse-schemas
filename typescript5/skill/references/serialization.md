# Saving, loading and exchanging data

Snapshots are plain data (mappings, lists, strings, numbers, booleans), so they can be written as JSON or YAML. Python
and TypeScript write byte-identical JSON, and each reads the other's.

## The snapshot format

```json
{"root": "Component/CMP-001", "objects": {
  "Component/CMP-001": {"name": "cpu", "ports": [{"port": {"$ref": "Port/PRT-001", "$schema": "Port"}}]},
  "Port/PRT-001": {"name": "irq", "signal": {"width": 1, "unit": "bit"},
                   "reach": {"phone": {"number": "1"}},
                   "owner": [{"owner": {"$ref": "Component/CMP-001", "$schema": "Component"}}]}}}
```

- Objects are keyed by their identities, qualified by their schemas' registered names (`Port/PRT-001`; a singleton's
  key is its global name alone). Each object appears once, however many objects link to it, and cycles need no
  special handling. Identities are kept across snapshots and stores: reading a snapshot into a store that holds an
  object of the same identity updates that object: what the snapshot holds is written, what it omits is kept, and
  reading it again changes nothing.
- An object maps property names to values, and adjacency names to lists of entries. An entry holds the other links
  as references `{"$ref": key, "$schema": name}` and its own properties. The object's own link is implied.
- A value object is a nested mapping, with its containers nested in it, and no key: nothing links to it.
  Union and intersection values are nested mappings keyed by branch or part name: a union value has exactly one key,
  and an intersection value one per part. A list, a dict or a map is an adjacency's entries like any other,
  `"tags": [{"value": "a"}, {"value": "b"}]`, sorted by the key its relation declares where that key's values are
  ordered, and in the order added otherwise; there are no compact forms. Names starting with `$` are reserved for the
  format.
- Object content carries no schema, except where nothing else gives it. The root schema is passed to the decoder, and
  references carry schema names, so a linked reference object's schema must be registered.

## Schemas as data

A module is an object holding schemas by name, so schemas save, load and validate like any data (two modules are
equal when their wire forms are):

```python fragment
text = JSON.ToJSON(store)(S.Module.Schema, Modules.module(store, [Contact, Phone]))
schemas = Modules.schemas(store, JSON.FromJSON(store)(S.Module.Schema, text))   # {"Contact": ..., "Phone": ...}
```

A module writes its schemas as a mapping by name, each definition inline by kind (`{"Phone": {"object": {...}}}`), in the
order given. A schema's own lists (properties, links, branches, parameters, ...) are containers of value objects,
`[{"name": ..., "type": ...}]`, in declaration order. A schema refers to a named schema by its name (`{"named": {"name": "Phone"}}`) and writes an unnamed
one inline; a name resolves within the module, then in the store. A schema that refers to itself must be named.

## Calls

| Call | Writes or reads |
|---|---|
| `ToPlain(store).OfObject`, and the JSON and YAML forms | the root only; its references stay unresolved, and decoding rejects them |
| `ToPlain(store).Reachable`, and the JSON and YAML forms | the root and everything reachable through adjacencies |
| `FromPlain(store)(schema, data)`, and the JSON and YAML forms | builds in the store given, with the snapshot's identities, updating an object the store holds; a snapshot is how objects move between stores |

## Strictness

- JSON is strict. YAML is read with the 1.2 core schema, so `no` is a string (no "Norway problem").
- Nothing is coerced: `1`, `1.0` and `true` are different values, and a wrong type is an error.
- An adjacency's entries are written sorted by the key its relation declares from that end, where the key's values
  are ordered (numbers, strings, booleans); otherwise in the order they were added.
- Every problem in the input raises `DecodeError` (a `ValueError`) with a one-line reason and a location: a line and
  column for text, or a path such as `$.objects["Port/PRT-001"].signal.width`. The reasons are identical in both languages, except
  for YAML syntax errors.
- Decoding checks everything before building anything, so a rejected snapshot builds nothing.
- Decoding does not validate. Call `Validators.Validate(builders).Reachable(schema, root)` afterwards if you need to.

## Go deeper

| Topic | Read |
|---|---|
| Identities, references, why the schema isn't stored, injected builders | [tutorial 6, Saving and loading](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/06_Saving_And_Loading.ipynb) |
| JSON and YAML details, the Norway problem | [tutorial 7, JSON and YAML](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/07_JSON_And_YAML.ipynb) |
| What decoding accepts, and every decoding error | [FRAMEWORK.md, Serialization](https://github.com/pitaman71/mbse-schemas/blob/main/docs/FRAMEWORK.md#serialization) |
| Snapshots both languages must read identically | [conformance/](https://github.com/pitaman71/mbse-schemas/blob/main/conformance/README.md) |
