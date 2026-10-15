# mbse-schemas in Python

Install `mbse-schemas` (add the `yaml` extra for YAML), then import from `mbse.Schemas.Framework`.

## A complete program

Components own ports, wires connect ports and carry a label, and each port describes its signal as a value object.

```python
from mbse.Schemas.Framework import JSON, Builders, Schemas as S, Validators

Int, Text = S.OfScalar.Data(int), S.OfScalar.Data(str)
store = Builders.Store()  # schemas and data are built in a store

# A value with no identity: a value object.
Signal = store.Schemas.Object(lambda o: o.properties([
    lambda t: t.name("width").type([Int]),
    lambda t: t.name("unit").type([Text]),
]))

# Things with identity: reference object schemas, each registered under its name as it is built.
Component = store.Schemas.Object(lambda o: (
    o
    .name("Component")
    .ref(True)
    .properties([lambda t: t.name("name").type([Text])])
))
Port = store.Schemas.Object(lambda o: (
    o
    .name("Port")
    .ref(True)
    .properties([
        lambda t: t.name("name").type([Text]),
        lambda t: t.name("signal").type([Signal]),
    ])
))

# Every collection of reference objects is a relation. uniques("owner"): entries that agree on the port agree on the
# owner. Within a schema, links and properties are named by string.
Ownership = store.Schemas.Relation(lambda r: (
    r
    .name("Ownership")
    .links([
        lambda t: t.name("owner"),
        lambda t: t.name("port"),
    ])
    .uniques("owner")
))
Wire = store.Schemas.Relation(lambda r: (
    r
    .name("Wire")
    .links([
        lambda t: t.name("source"),
        lambda t: t.name("target"),
    ])
    .properties([lambda t: t.name("label").type([Text])])
))

# Each object sees a relation through one of its links (an adjacency); an object and a callback update its schema.
store.Schemas.Object(Component, lambda o: o.adjacencies([
    lambda t: t.name("ports").relation([Ownership]).me("owner"),
]))
store.Schemas.Object(Port, lambda o: o.adjacencies([
    lambda t: t.name("owner").relation([Ownership]).me("port"),
    lambda t: t.name("fanout").relation([Wire]).me("source"),
    lambda t: t.name("fanin").relation([Wire]).me("target"),
]))
# An object may fill a link its schema declares with no name (an anonymous adjacency): no member, but still checked.
# A refinement has the members of the schema it refines, and its own; its objects are that schema's objects too.
Board = store.Schemas.Object(lambda o: (
    o
    .name("Board")
    .refines([Component])
    .properties([lambda t: t.name("revision").type([Int])])
))

# Data is built the same way: a callback creates, an object and a callback update, an object alone clones. Builders
# and data instances implement the visitor protocol: members named after the schema's names.
irq = store.Port(lambda p: p.name("irq").signal(lambda v: v.as_object(lambda s: s.width(1).unit("bit"))))
pic_in = store.Port(lambda p: p.as_identity("pic-in").name("pic_in"))  # an identity written; else the store gives one
cpu = store.Component(lambda c: c.name("cpu").ports(lambda a: a.insert(lambda e: e.port(irq))))
store.Port(irq, lambda p: p.fanout(lambda a: a.insert(lambda e: e.target(pic_in).label("interrupt"))))
assert str(irq.name) == "irq" and [e.target for e in irq.fanout] == [pic_in]
widths = []
irq.signal.as_object(lambda s: widths.append(int(s.width)) or s)  # a value object, through as_object
assert widths == [1]

text = JSON.ToJSON(store).Reachable(Component, cpu)
copy = JSON.FromJSON(store).Reachable(Component, text)
assert Validators.Validate(store).Reachable(Component, copy) == []
```

## Cheat sheet

```python fragment
# Everything is built in a store: schemas with store.Schemas.<Kind>(...), data with store.<dotted name>(...). Called
# with a callback (a Spec taking the builder), it creates; with an object and a callback, it updates the object; with
# an object alone, it clones it. It returns the object. A named schema is registered under its name as it is built.
store = Builders.Store()                                    # holds the meta-schemas; isolated from every other store
S.OfScalar.Data(int)                                        # scalars: int, float, str, bool, bytes (basic tokens)
w = store.Schemas.Form(lambda f: f.kind("literal").attributes({"value": 32}))  # a literal width, 32
store.Schemas.Scalar(lambda s: s.format("ccpp").token("int32_t").bits([w]))   # any format's token; a width, a term
store.Schemas.Object(lambda o: o.name("crm.Contact").ref(True).properties([...]))   # .ref(True): a reference object schema
store.Schemas.Object(lambda o: o.name("pm.Feature").ref(True).pattern(r"FEA-(\d+\d\d)"))  # objects FEA-001, ...; else UUIDs
store.Schemas.Object(lambda o: o.properties([lambda t: t.name("x").type([Int])]))  # a value object schema, for a type
# A schema's members are its entries, each named by its entry: t.name("x"). A reference to another schema object is
# a list of what it links (.type([T]), .relation([R]), .refines([T])), one item where only one is allowed, which
# replaces it; a type must exist first. Value properties take their value whole, of exactly their type.
lambda t: t.name("x").property(existing)                    # link a member that exists, rather than build one
store.Schemas.Relation(lambda r: (
    r
    .name("crm.Knows")
    .links([
        lambda t: t.name("a"),                              # a link is a name; its type follows from the adjacencies
        lambda t: t.name("b"),
    ])
    .properties([lambda t: t.name("since").type([Int])])
    .uniques("a")                                           # links and properties named by string, by exception
))
.uniques(["a", "b"]); .uniques([["a"], ["b", "since"]]); .uniques([])   # one clause of two; two clauses; a set
store.Schemas.Object(Person, lambda o: o.adjacencies([      # update: add adjacencies once the relations exist
    lambda t: t.name("knows").relation([Knows]).me("a"),    # me: the link this object fills, by name
    lambda t: t.relation([Knows]).me("b"),                  # anonymous: no name, no member, still checked
]))
store.Schemas.Object(lambda o: o.name("Board").refines([Component]))   # a refinement: the members of what it refines
store.Schemas.Union(lambda u: u.branches([lambda t: t.name("phone").type([Phone]), ...]))
store.Schemas.Intersection(lambda i: i.parts([lambda t: t.name("stamp").type([Stamp]), ...]))
store.Schemas.Container(lambda c: c.index([Int]).element([Text]))   # a list: a container by position, a property's type
store.Schemas.Container(lambda c: c.index([Cell]).element([Float]).layout("sparse"))  # a tensor by a value object of ints
obj.tags.as_value(lambda v: v.as_container(lambda c: c.at(0)))  # elements by index, each a Visitors.OfAny
store.Schemas.Any(lambda a: a.types([Int, Phone]))          # a value of any of these types, written bare; none: any type
store.Phone(lambda p: p.number("1"))                        # a standalone value, assigned to an unrestricted OfAny, tagged
schema.validate()                                           # the schema's own problems, [] when valid

.name("crm.Contact")                                        # a name, identifiers separated by dots, on any kind of schema
.description("A person we know")                            # documentation, on a schema or a member: property, adjacency,
schema.properties["home"].type                              # branch or part; a property is an element, its type inside
.parameters([lambda t: t.name("n").type([Int])])            # parameters, on any kind of schema
store.Schemas.Apply(lambda a: a.of([Matrix]).arguments(lambda adv: adv.insert(  # a parametric schema applied: each
    lambda e: e.argument(lambda x: x.parameter([Matrix.parameters["rows"]]).value(2)))))  # argument binds a parameter
store.Schemas.Predicate(lambda p: p.symbols([lambda t: t.name("p").type([Person])]).requires([term]))  # one term
.bits([store.Schemas.Form(lambda f: f.kind("variable").attributes({"name": "n"}))])   # a term where a width stands
Validators.Check(store)(schema, obj).holds                  # True or False: since extents went, nothing it checks is unknown
S.equivalent(a, b, evaluate)                                # the same after substitution: Square(4) is Matrix(4, 4)
store.registered("crm.Contact"); store.register(schema)     # a schema by name; one built in another store, here too
store.extent("Name"); store.singleton("Global")             # a schema's objects its singletons reach; a singleton
Stores.PCG32(42).split("key").next_u32()                 # a random source, given to whatever draws from it
Proxies.store_of(obj)                                       # the store a proxy belongs to
# The visitor protocol (Visitors.OfX): data instances read, builders write. A member is the child visitor when read
# and takes a Spec when called: a value, or a callable given the visitor. Reads never raise; a forbidden write raises
# Errors.ReadOnlyError.
store.crm.Contact(lambda c: c.prop(value).value_prop(lambda p: p.as_object(lambda r: r.x(1))))   # a value object
store.crm.Contact(lambda c: c.knows(lambda a: a.insert(lambda e: e.b(obj).since(2020))))   # an entry, inserted
store.crm.Contact(lambda c: c.knows([bob, lambda t: t.since(2020).name("Cy")]))   # peer shorthand: link, or build
store.crm.Contact(obj, lambda c: c.prop(v)); store.crm.Contact(obj)   # update obj in place; clone it
store.builder("crm.Contact", obj)                           # the builder a call drives, ending in update() or clone()
str(obj.prop); int(obj.count); obj.prop.get()               # a scalar: the dunders, or get(); get() is None when absent
obj.prop == "Ada"; obj.count < 3; {obj.prop}                # a scalar visitor compares, orders and hashes as its value
obj.prop.as_scalar(lambda s: s.set(v))                      # a property's scalar visitor; .as_value(cb) for any kind
store.crm.Contact(obj, lambda c: c.prop(lambda p: p.as_value(lambda v: v.clear())))   # clear a value
store.crm.Contact(lambda c: c.tags(["a", "b"]))             # a container's value, given whole
obj.value_prop.as_object(lambda r: ...)                     # a value object's visitor, its members as an object's
[(e.target, str(e.label)) for e in irq.fanout]              # an adjacency iterates its entries; a link is the object itself
irq.fanout.project("target"); contact.phones.at("home")     # each entry's link or property; the entry by its key
store.crm.Contact(obj, lambda c: c.knows(lambda a: a.remove(lambda e: e.b(bob))))   # remove every entry agreeing
obj.likes.as_iterable(lambda entries: ...)                  # an iterator over an adjacency's entries, in order
store.crm.Card(lambda c: c.reach(lambda p: p.as_value(lambda v: v.as_union(lambda u: u.phone(spec)))))   # a branch
obj.as_properties; obj.as_adjacencies(lambda a: a)          # schema unaware: the properties set, every adjacency
obj.as_schema(); obj.as_identity()                          # what every visitor has: its schema; an object's identity, else None
store.by_identity("Feature", "FEA-001")                     # the live object of that schema with that identity
Proxies.owner_of(value_object)                              # the object a value object belongs to

# Schemas as data: a module holds schemas by name, as an object of S.Module.Schema.
Modules.module(store, [Contact]); Modules.schemas(store, module)   # named schemas to a module, and back (by name)
store.Schemas.Union(lambda u: u.name("Code").flat(True).branches([...]))   # flat: card.code is the branch's value
Stores.Combined(one, other)                                 # stores as one, each name its store's

# Everything else works for any schema.
Reachable.of(root)                                          # root and everything reachable, in first-reference order
Plain.ToPlain(store)(schema, obj); Plain.ToPlain(store).Reachable(schema, root); Plain.FromPlain(store)(schema, plain)
Plain.ToPlain(store)(Phone, phone)   # a standalone value (value object, union, container, any): nested, {"number": ...}
JSON.ToJSON(store)(...), JSON.FromJSON(store)(...); YAML.ToYAML(store)(...), YAML.FromYAML(store)(...)   # as Plain
Validators.Validate(store)(schema, obj); Validators.Validate(store).Reachable(schema, root)
Comparison.OfObject(schema, a).compare(Comparison.OfObject(schema, b))   # -1, 0, 1, or None if incomparable

# Dataclasses: scalar fields are properties, list/dict of scalars containers; set/list/dict of dataclasses are relations.
# Defaults, mandatoriness and nesting are not translated.
from mbse.Schemas.Adapters.Dataclasses import FromDataclass, ToDataclass
FromDataclass.model(Contact)       # {"Contact": ..., "Address": ..., "ContactAddresses": ...}, named, ready to register
ToDataclass.model(schemas)         # {"Contact": class, "Address": class}; FromDataclass(cls), ToDataclass(schema, name)
```

## Traps

- `True` is not an `int`, and `1.0` is not an `int`. Validation reports `expected int, got bool`.
- A relation has two links or more, and a value object no adjacencies: a list of values is a container, and anything
  that is linked is a reference object.
- Setting a value object into a property or an entry copies it. Edit one in place through a Spec instead.
- A schema builder's value properties are typed exactly: `.ref(1)` raises `TypeError`; write `.ref(True)`. A
  singleton schema is a reference object schema too: `.ref(True).singleton("crm.Directory")`.
- A reference to another schema object is a list of what it links, even where only one is allowed: `.type([Text])`,
  never `.type(Text)`. It links schemas that exist, so build a container or value object schema before the property
  typed by it.
- In its store, a named schema's identity is its name, and the store refuses a second schema object with an identity
  it holds: `store.Schemas.Object(Contact)` cannot clone a named schema. Clone it under a new name with a builder in
  the store: `Builders.OfObject.Builder(Contact, store=store).name("crm.Contact.v2").clone()`.
- A schema's name is its own (`.name("crm.Contact")`), the same in every store that registers it; one built in
  another store is registered with `store.register(schema)`, which refuses an unnamed schema or a name held. An
  object of one store cannot be linked from another.
- `bool()` of a property is its bool value, not whether it is set: `if obj.flag:` raises when the flag is absent or
  not a bool. Ask `obj.flag.get() is not None` for presence.
- Names starting with `_` are internal, and so are a builder's own methods (`create`, `clone`, `update`): a property
  with such a name cannot be written through a builder's member.

## Go deeper

| Topic | Read |
|---|---|
| Building in a store, Specs, create, update and clone, absent vs `None` | [tutorial 1, A contact card](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/01_A_Contact_Card.ipynb) |
| Editing entries | [tutorial 3, Moving house](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/03_Moving_House.ipynb) |
| Writing your own visitor, walking schemas | [tutorial 8, Tools for every schema](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/08_Tools_For_Every_Schema.ipynb) |
| Self-checking example programs | [mbse/Schemas/Examples/](https://github.com/pitaman71/mbse-schemas/blob/main/python3/mbse/Schemas/Examples) |
