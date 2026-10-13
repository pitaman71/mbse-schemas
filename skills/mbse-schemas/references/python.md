# mbse-schemas in Python

Install `mbse-schemas` (add the `yaml` extra for YAML), then import from `mbse.Schemas.Framework`.

## A complete program

Components own ports, wires connect ports and carry a label, and each port describes its signal as a value object.

```python
from mbse.Schemas.Framework import JSON, Proxies, Schemas as S, Validators


def scalar(name, type_):
    return lambda p: p.name(name).of(lambda t: t.as_scalar(type_))


# A value with no identity: a value object.
Signal = S.OfObject.Builder().properties(scalar("width", int), scalar("unit", str)).create()

# Things with identity: object schemas.
Component = S.OfObject.Builder().name("Component").ref().properties(scalar("name", str)).create()
Port = S.OfObject.Builder().name("Port").ref().properties(scalar("name", str), lambda p: p.name("signal").of(Signal)).create()

# Every collection is a relation. unique("owner"): entries that agree on the port agree on the owner.
Ownership = S.OfRelation.Builder().name("Ownership").links("owner", "port").unique("owner").create()
Wire = S.OfRelation.Builder().name("Wire").links("source", "target").properties(scalar("label", str)).create()

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

# Builders and data instances implement the visitor protocol: members named after the schema's names.
irq = B.Port().name("irq").signal(lambda p: p.as_object(lambda s: s.width(1).unit("bit"))).create()
pic_in = B.Port().name("pic_in").create()
cpu = B.Component().name("cpu").ports(lambda a: a.insert(lambda e: e.port(irq))).create()
B.Port(irq).fanout(lambda a: a.insert(lambda e: e.target(pic_in).label("interrupt"))).update()
assert str(irq.name) == "irq" and [e.target for e in irq.fanout] == [pic_in]
widths = []
irq.signal.as_object(lambda s: widths.append(int(s.width)) or s)  # a value object, through as_object
assert widths == [1]

text = JSON.ToJSON(store).Reachable(Component, cpu)
copy = JSON.FromJSON(B).Reachable(Component, text)
assert Validators.Validate(B).Reachable(Component, copy) == []
```

## Cheat sheet

```python fragment
# Schemas: values built with fluent builders. A Spec is a schema or a callable taking a builder.
S.OfScalar.Data(int)                                        # scalars: int, float, str, bool, bytes (basic tokens)
S.OfScalar.resolve(lambda n: n.token("ccpp", "int32_t").bits(32))   # any format's token; a width in bits or bytes
S.OfObject.Builder().ref().properties(spec, ...).relations(spec, ...).create()   # .ref(): a reference object schema
S.OfObject.Builder().ref(r"FEA-(\d+\d\d)")                 # its objects named FEA-001, FEA-002, ... in each store; else UUIDs
S.OfObject.Builder().properties(spec, ...).create()        # a value object schema, for a property's type
S.OfObject.Builder(existing).relations(...).update()        # add adjacencies once the relations exist
S.OfRelation.Builder().links("a", "b").properties(spec, ...).unique("a").create()
S.OfUnion.Builder().branches(lambda b: b.name("phone").of(spec), ...).create()
S.OfIntersection.Builder().parts(lambda p: p.name("stamp").of(spec), ...).create()
r.name("tags").me("owner").of(lambda rel: rel.links("owner").properties(text("value")))   # a list: a one-link relation inline
rel.links("owner").properties(text("key"), text("value")).unique("value")   # a dict, keyed by `key`; several keys: a matrix
schema.validate()                                           # the schema's own problems, [] when valid

S.OfObject.Builder().name("crm.Contact")                    # a name, identifiers separated by dots, on any kind of schema
S.OfObject.Builder().description("A person we know")        # documentation, on any element: schema, property, adjacency,
schema.properties["home"].type                              # branch or part; a property is an element, its type inside
S.OfObject.Builder().parameters(lambda p: p.name("n").of(spec))  # parameters, on any kind of schema
S.OfApply.Builder().of(Matrix).arguments(rows=2, cols=3)    # a type: a parametric schema applied, by name; .argument("n", 3)
S.OfPredicate.Builder().symbols(lambda s: s.name("p").of(Person)).requires(term)  # a predicate: one term over symbols
n.bits(S.Form.Data("variable", {"name": "n"}))              # a term where a width stands, or a dialect's
Validators.Check(store)(schema, obj).holds                  # True or False: since extents went, nothing it checks is unknown
S.equivalent(a, b, evaluate)                                # the same after substitution: Square(4) is Matrix(4, 4)
# A store: register named object and relation schemas, then build through it. Stores are isolated; objects move between
# them as snapshots.
store = Proxies.OfStore(); store.register(schema); B = store  # under schema.name; an unnamed schema is refused
store.extent("Name"); store.singleton("Global")             # a schema's objects its singletons reach; a singleton
Stores.PCG32(42).split("key").next_u32()                 # a random source, given to whatever draws from it
Proxies.store_of(obj)                                       # the store a proxy belongs to
# The visitor protocol (Visitors.OfX): data instances read, builders write. A member is the child visitor when read
# and takes a Spec when called: a value, or a callable given the visitor. Reads never raise; a forbidden write raises
# Errors.ReadOnlyError.
B.Name().prop(value).value_prop(lambda p: p.as_object(lambda r: r.x(1))).create()   # a value object, through as_object
B.Name().adjacency_name(lambda a: a.insert(lambda e: e.link(obj).entry_prop(v))).create()   # an entry, inserted
B.Name(obj).prop(v).update()                                # change obj; .clone() makes a changed copy instead
str(obj.prop); int(obj.count); obj.prop.get()               # a scalar: the dunders, or get(); get() is None when absent
obj.prop == "Ada"; obj.count < 3; {obj.prop}                # a scalar visitor compares, orders and hashes as its value
obj.prop.as_scalar(lambda s: s.set(v))                      # a property's scalar visitor; .as_value(cb) for any kind
B.Name(obj).prop(lambda p: p.as_value(lambda v: v.clear())).update()   # clear a value
obj.value_prop.as_object(lambda r: ...)                     # a value object's visitor, its members as an object's
[(e.target, str(e.label)) for e in irq.fanout]              # an adjacency iterates its entries; a link is the object itself
irq.fanout.project("target"); contact.phones.at("home")     # each entry's link or property; the entry by its key
B.Name(obj).tags(lambda a: a.remove(lambda e: e.value("x")))   # remove every entry agreeing with a template
obj.tags.select(lambda e: e.value("x"), lambda e: ...)      # visit the entries agreeing with a template, or equal to a value
B.Name().union_prop(lambda p: p.as_value(lambda v: v.as_union(lambda u: u.phone(spec))))   # a branch by name
obj.as_properties; obj.as_adjacencies(lambda a: a)          # schema unaware: the properties set, every adjacency
obj.as_schema(); obj.as_identity()                          # what every visitor has: its schema; an object's identity, else None
store.by_identity("Feature", "FEA-001")                     # the live object of that schema with that identity
Proxies.owner_of(value_object)                              # the object a value object belongs to

# Schemas as data: a module holds schemas by name, as an object of S.Module.Schema.
Modules.module(store, [Contact]); Modules.schemas(store, module)   # named schemas to a module, and back (by name)
S.OfUnion.Builder().name("Code").branches(...).flat()      # flat: card.code is the branch's value, set by type
Stores.Combined(one, other)                                 # stores as one, each name its store's

# Everything else works for any schema.
Reachable.of(root)                                          # root and everything reachable, in first-reference order
Plain.ToPlain(store)(schema, obj); Plain.ToPlain(store).Reachable(schema, root); Plain.FromPlain(store)(schema, plain)
JSON.ToJSON(store)(...), JSON.FromJSON(store)(...); YAML.ToYAML(store)(...), YAML.FromYAML(store)(...)   # as Plain
Validators.Validate(store)(schema, obj); Validators.Validate(store).Reachable(schema, root)
Comparison.OfObject(schema, a).compare(Comparison.OfObject(schema, b))   # -1, 0, 1, or None if incomparable

# Dataclasses: scalar fields are properties; list/dict of scalars and set/list/dict of dataclasses are relations.
# Defaults, mandatoriness and nesting are not translated.
from mbse.Schemas.Adapters.Dataclasses import FromDataclass, ToDataclass
FromDataclass.model(Contact)       # {"Contact": ..., "Address": ..., "ContactAddresses": ...}, named, ready to register
ToDataclass.model(schemas)         # {"Contact": class, "Address": class}; FromDataclass(cls), ToDataclass(schema, name)
```

## Traps

- `True` is not an `int`, and `1.0` is not an `int`. Validation reports `expected int, got bool`.
- A two-link entry's properties hold scalars and value objects without adjacencies; a one-link entry's value objects
  may have lists. Link a reference object for anything richer.
- Setting a value object into a property or an entry copies it. Edit one in place through a Spec instead.
- A schema's name is its own (`.name("crm.Contact")`), the same in every store that registers it. Registering an
  unnamed schema, or a name twice in one store, raises `ValueError`, and an object of one store cannot be linked from
  another.
- `bool()` of a property is its bool value, not whether it is set: `if obj.flag:` raises when the flag is absent or
  not a bool. Ask `obj.flag.get() is not None` for presence.
- Names starting with `_` are internal, and so are a builder's own methods (`create`, `clone`, `update`): a property
  with such a name cannot be written through a builder's member.

## Go deeper

| Topic | Read |
|---|---|
| Builders, Specs, `create`/`update`/`clone`, absent vs `None` | [tutorial 1, A contact card](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/01_A_Contact_Card.ipynb) |
| Editing entries | [tutorial 3, Moving house](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/03_Moving_House.ipynb) |
| Writing your own visitor, walking schemas | [tutorial 8, Tools for every schema](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/08_Tools_For_Every_Schema.ipynb) |
| Self-checking example programs | [mbse/Schemas/Examples/](https://github.com/pitaman71/mbse-schemas/blob/main/python3/mbse/Schemas/Examples) |
