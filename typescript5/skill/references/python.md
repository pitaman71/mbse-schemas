# mbse-schemas in Python

Install `mbse-schemas` (add the `yaml` extra for YAML), then import from `mbse.Schemas.Framework`.

## A complete program

Components own ports, wires connect ports and carry a label, and each port describes its signal as a value object.

```python
from mbse.Schemas.Framework import JSON, Proxies, Schemas as S, Validators


def native(name, type_):
    return lambda p: p.name(name).of(lambda t: t.as_native(type_))


# A value with no identity: a value object.
Signal = S.OfObject.Builder().properties(native("width", int), native("unit", str)).create()

# Things with identity: object schemas.
Component = S.OfObject.Builder().name("Component").ref().properties(native("name", str)).create()
Port = S.OfObject.Builder().name("Port").ref().properties(native("name", str), lambda p: p.name("signal").of(Signal)).create()

# Every collection is a relation. unique("owner"): entries that agree on the port agree on the owner.
Ownership = S.OfRelation.Builder().name("Ownership").links("owner", "port").unique("owner").create()
Wire = S.OfRelation.Builder().name("Wire").links("source", "target").properties(native("label", str)).create()

# Each object sees a relation through one of its links (an adjacency).
S.OfObject.Builder(Component).relations(lambda r: r.name("ports").of(Ownership).me("owner")).update()
S.OfObject.Builder(Port).relations(lambda r: r.name("owner").of(Ownership).me("port"),
                                   lambda r: r.name("fanout").of(Wire).me("source"),
                                   lambda r: r.name("fanin").of(Wire).me("target")).update()
# A store holds named schemas, each under its own name; the objects built with them belong to it.
store = Proxies.OfStore()
for schema in [Component, Port, Ownership, Wire]:
    store.register(schema)
B = store

irq = B.Port().name("irq").signal(lambda s: s.width(1).unit("bit")).create()
pic_in = B.Port().name("pic_in").create()
cpu = B.Component().name("cpu").ports(lambda e: e.port(irq)).create()
B.Port(irq).fanout(lambda e: e.target(pic_in).label("interrupt")).update()
assert irq.signal.width == 1

text = JSON.ToJSON(store).Reachable(Component, cpu)
copy = JSON.FromJSON(B).Reachable(Component, text)
assert Validators.Validate(B).Reachable(Component, copy) == []
```

## Cheat sheet

```python fragment
# Schemas: values built with fluent builders. A Spec is a schema or a callable taking a builder.
S.OfNative.Data(int)                                        # natives: int, float, str, bool, bytes (basic tokens)
S.OfNative.resolve(lambda n: n.token("ccpp", "int32_t").bits(32))   # any format's token; a width in bits or bytes
S.OfObject.Builder().ref().properties(spec, ...).relations(spec, ...).create()   # .ref(): a reference object schema
S.OfObject.Builder().properties(spec, ...).create()        # a value object schema, for a property's type
S.OfObject.Builder(existing).relations(...).update()        # add adjacencies once the relations exist
S.OfRelation.Builder().links("a", "b").properties(spec, ...).unique("a").create()
S.OfUnion.Builder().branches(lambda b: b.name("phone").of(spec), ...).create()
S.OfIntersection.Builder().parts(lambda p: p.name("stamp").of(spec), ...).create()
S.OfIndexed.Builder().of(spec).create()                     # a list; in a property: lambda t: t.as_indexed(lambda i: i.of(spec))
S.OfIndexed.Builder().key(spec).of(spec).create()           # a keyed list (a native or value object key); .extent(1, 9) bounds a positional one
schema.validate()                                           # the schema's own problems, [] when valid

S.OfObject.Builder().name("crm.Contact")                    # a name, identifiers separated by dots, on any kind of schema
S.OfObject.Builder().description("A person we know")        # documentation, on any element: schema, property, adjacency,
schema.properties["home"].type                              # branch or part; a property is an element, its type inside
S.OfObject.Builder().parameters(lambda p: p.name("n").of(spec))  # parameters, on any kind of schema
S.OfApply.Builder().of(Matrix).arguments(2, 3)              # a type: a parametric schema applied; .argument("n", 3)
i.extent(1, S.Form.Data("variable", {"name": "n"}))         # a term where a bound or a width stands, or a dialect's
Validators.Check(store, evaluate)(schema, obj).holds        # True, False, or None where unknown (extents over parameters)
S.equivalent(a, b, evaluate)                                # the same after substitution: Square(4) is Matrix(4, 4)
# A store: register named object and relation schemas, then build through it. Stores are isolated; objects move between
# them as snapshots.
store = Proxies.OfStore(); store.register(schema); B = store  # under schema.name; an unnamed schema is refused
store.extent("Name"); store.singleton("Global")             # a schema's objects its singletons reach; a singleton
Stores.PCG32(42).split("key").next_u32()                 # a random source, given to whatever draws from it
Proxies.store_of(obj)                                       # the store a proxy belongs to
B.Name().prop(value).value_prop(lambda r: r.x(1)).adjacency_name(lambda e: e.link(obj).entry_prop(v)).create()
B.Name(obj).prop(v).update()                                # change obj; .clone() makes a changed copy instead
[(e.target, e.label) for e in irq.fanout]                   # an adjacency: its entries; links and properties as attributes
B.Name(obj).clear("prop").update()
obj.prop                                                    # AttributeError when unset
B.Name().union_prop(lambda u: u.phone(spec))                # a branch by name; obj.union_prop.phone reads it
B.Name().list_prop(["a", "b"]).ports([lambda p: p.name("in")])   # a list of items; obj.list_prop is a tuple
B.Name(obj).ports(lambda l: l.item(0, lambda a: a.as_object(lambda p: p.name("x"))).remove(1)).update()  # in place
B.Name().attrs({"gain": 1.5}).cells([(lambda c: c.r(1).c(2), 7)])   # keyed lists: obj.attrs["gain"], a read-only mapping
B.Name(obj).property("p", lambda p: ...).adjacency("a", lambda a: a.entries(...))  # visitor protocol, any name

# Schemas as data: a module holds schemas by name, as an object of S.Module.Schema.
Modules.module(store, [Contact]); Modules.schemas(store, module)   # named schemas to a module, and back (by name)
S.OfUnion.Builder().name("Code").branches(...).flat()      # flat: card.code is the branch's value, set by type
Reflection.of(store).extent("Schemas.Object")               # a store's schemas as objects, to match and rewrite
Paths.of(store).of(obj); Paths.of(store).find(path)          # names that survive changes elsewhere: "book.Directory/contacts[0]"
Stores.Combined(schemas, trees)                             # stores of different implementations, as one

# Everything else works for any schema.
Reachable.of(root)                                          # root and everything reachable, in first-reference order
Plain.ToPlain(store)(schema, obj); Plain.ToPlain(store).Reachable(schema, root); Plain.FromPlain(store)(schema, plain)
JSON.ToJSON(store)(...), JSON.FromJSON(store)(...); YAML.ToYAML(store)(...), YAML.FromYAML(store)(...)   # as Plain
Validators.Validate(store)(schema, obj); Validators.Validate(store).Reachable(schema, root)
Validators.properties_of(obj)                               # {name: value} of the properties that are set
Comparison.OfObject(schema, a).compare(Comparison.OfObject(schema, b))   # -1, 0, 1, or None if incomparable

# Dataclasses: native fields are properties, lists of natives are lists; set/list/dict of dataclasses are relations.
# Defaults, mandatoriness and nesting are not translated.
from mbse.Schemas.Adapters.Dataclasses import FromDataclass, ToDataclass
FromDataclass.model(Contact)       # {"Contact": ..., "Address": ..., "ContactAddresses": ...}, named, ready to register
ToDataclass.model(schemas)         # {"Contact": class, "Address": class}; FromDataclass(cls), ToDataclass(schema, name)
```

## Traps

- `True` is not an `int`, and `1.0` is not an `int`. Validation reports `expected int, got bool`.
- Entry properties hold natives, lists and value objects without adjacencies. Link an object for anything richer.
- Setting a value object into a property or a list copies it. Edit one in place through a Spec instead.
- A schema's name is its own (`.name("crm.Contact")`), the same in every store that registers it. Registering an
  unnamed schema, or a name twice in one store, raises `ValueError`, and an object of one store cannot be linked from
  another.
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
