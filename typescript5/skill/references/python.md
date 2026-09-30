# mbse-schemas in Python

Install `mbse-schemas` (add the `yaml` extra for YAML), then import from `mbse.Schemas.Framework`.

## A complete program

Components own ports, wires connect ports and carry a label, and each port describes its signal as an embedded value.

```python
from mbse.Schemas.Framework import JSON, Proxies, Schemas as S, Validators


def native(name, type_):
    return lambda p: p.name(name).of(lambda t: t.as_native(type_))


# A value with no identity: an embedded object.
Signal = S.OfObject.Builder().properties(native("width", int), native("unit", str)).create()

# Things with identity: object schemas.
Component = S.OfObject.Builder().properties(native("name", str)).create()
Port = S.OfObject.Builder().properties(native("name", str), lambda p: p.name("signal").of(Signal)).create()

# Every collection is a relation. unique("owner"): entries that agree on the port agree on the owner.
Ownership = S.OfRelation.Builder().links("owner", "port").unique("owner").create()
Wire = S.OfRelation.Builder().links("source", "target").properties(native("label", str)).create()

# Each object sees a relation through one of its links (an adjacency).
S.OfObject.Builder(Component).relations(lambda r: r.name("ports").of(Ownership).me("owner")).update()
S.OfObject.Builder(Port).relations(lambda r: r.name("owner").of(Ownership).me("port"),
                                   lambda r: r.name("fanout").of(Wire).me("source"),
                                   lambda r: r.name("fanin").of(Wire).me("target")).update()
for name, schema in [("Component", Component), ("Port", Port), ("Ownership", Ownership), ("Wire", Wire)]:
    Proxies.register(name, schema)
B = Proxies.Builders

irq = B.Port().name("irq").signal(lambda s: s.width(1).unit("bit")).create()
pic_in = B.Port().name("pic_in").create()
cpu = B.Component().name("cpu").ports(lambda e: e.port(irq)).create()
B.Port(irq).fanout(lambda e: e.target(pic_in).label("interrupt")).update()
assert irq.signal.width == 1

text = JSON.ToJSON.Reachable(Component, cpu)
copy = JSON.FromJSON(B).Reachable(Component, text)
assert Validators.Validate(B).Reachable(Component, copy) == []
```

## Cheat sheet

```python fragment
# Schemas: values built with fluent builders. A Spec is a schema or a callable taking a builder.
S.OfNative.Data(int)                                        # natives: int, float, str, bool, bytes
S.OfObject.Builder().properties(spec, ...).relations(spec, ...).singleton("Name").create()
S.OfObject.Builder(existing).relations(...).update()        # add adjacencies once the relations exist
S.OfRelation.Builder().links("a", "b").properties(spec, ...).unique("a").create()
S.OfUnion.Builder().branches(lambda b: b.of(spec).when(predicate), ...).create()
S.OfIntersection.Builder().of(spec, spec).create()
schema.validate()                                           # the schema's own problems, [] when valid

# Proxies: register object and relation schemas, then build through Proxies.Builders.
Proxies.register("Name", schema); B = Proxies.Builders
B.Name().prop(value).embedded(lambda r: r.x(1)).adjacency_name(lambda e: e.link(obj).entry_prop(v)).create()
B.Name(obj).prop(v).update()                                # change obj; .clone() makes a changed copy instead
B.Name(obj).clear("prop").update()
obj.prop                                                    # AttributeError when unset
B.Name().union_prop(lambda u: u.of(BranchSchema, spec))     # or pass a value: its kind picks the branch
B.Name(obj).property("p", lambda p: ...).adjacency("a", lambda a: a.entries(...))  # visitor protocol, any name

# Everything else works for any schema.
Reachable.of(root)                                          # root and everything reachable, in first-reference order
Plain.ToPlain(schema, obj); Plain.ToPlain.Reachable(schema, root); Plain.FromPlain(B)(schema, plain)
JSON.ToJSON(...), JSON.FromJSON(B)(...); YAML.ToYAML(...), YAML.FromYAML(B)(...)   # same shapes as Plain
Validators.Validate(B)(schema, obj); Validators.Validate(B).Reachable(schema, root); Validators.Validate(B, evaluator)
Validators.properties_of(obj)                               # {name: value} of the properties that are set
Comparison.OfObject(schema, a).compare(Comparison.OfObject(schema, b))   # -1, 0, 1, or None if incomparable
```

## Traps

- `True` is not an `int`, and `1.0` is not an `int`. Validation reports `expected int, got bool`.
- Entry properties must be native. Use an object linked by the relation for anything richer.
- The proxy registry is global to the process, and registering a name twice raises `ValueError`.
- Reading a relation's entries goes through a builder's visitor: see `entries` in
  [tutorials/toolkit.py](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/toolkit.py), and
  tutorial 3 for removing entries and for what `update()` replaces.
- Names starting with `_` are internal.

## Go deeper

| Topic | Read |
|---|---|
| Builders, Specs, `create`/`update`/`clone`, absent vs `None` | [tutorial 1, A contact card](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/01_A_Contact_Card.ipynb) |
| Editing entries | [tutorial 3, Moving house](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/03_Moving_House.ipynb) |
| Writing your own visitor, walking schemas | [tutorial 8, Tools for every schema](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/08_Tools_For_Every_Schema.ipynb) |
| Self-checking example programs | [mbse/Schemas/Examples/](https://github.com/pitaman71/mbse-schemas/blob/main/python3/mbse/Schemas/Examples) |
