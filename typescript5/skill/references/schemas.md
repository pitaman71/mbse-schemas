# Designing and extending schemas

Schemas are data. Every schema is an object in its store, of a meta-schema (`Builders.Meta.Object`, ...), built and
changed through its builder as data is: `store.Schemas.<Kind>(callback)` creates one, `store.Schemas.<Kind>(schema,
callback)` updates it. So the same fluent calls design a schema, extend one that exists, make a new version beside it,
or generate schemas from anything a program holds.

## A complete program

```python
from mbse.Schemas.Framework import Builders, Validators

Int, Text = Builders.Meta.OfInt, Builders.Meta.OfStr  # the basic scalars, which every store holds
store = Builders.Store()

# Design: a schema is built in its store, and a named one is registered, in the module its name's prefix names.
Contact = store.Schemas.Object(lambda o: (
    o
    .name("crm.Contact")
    .ref(True)
    .properties([lambda t: t.name("given_name").type([Text])])
))

# Extend in place: the schema and a callback update it, as an object and a callback update data.
store.Schemas.Object(Contact, lambda o: o.properties([lambda t: t.name("age").type([Int])]))
assert list(Contact.properties) == ["given_name", "age"]

# Remove a member: the adjacency's visitor removes the entries agreeing with a template.
store.Schemas.Object(Contact, lambda o: o.properties(lambda adv: adv.remove(lambda e: e.name("age"))))
assert list(Contact.properties) == ["given_name"]

# A new version beside the old: a named schema's identity is its name, so clone it under another, in the store.
V2 = Builders.OfObject.Builder(Contact, store=store).name("crm.Contact.v2").clone()
store.Schemas.Object(V2, lambda o: o.properties([lambda t: t.name("email").type([Text])]))
assert list(V2.properties) == ["given_name", "email"] and list(Contact.properties) == ["given_name"]

# A refinement: the members of the schema it refines, and its own; its objects are that schema's objects too.
Customer = store.Schemas.Object(lambda o: (
    o
    .name("crm.Customer")
    .ref(True)
    .refines([Contact])
    .properties([lambda t: t.name("account").type([Text])])
))
assert list(Customer.properties) == ["given_name", "account"]

# Generate: a program builds schemas from whatever describes them.
fields = {"street": Text, "number": Int}
Address = store.Schemas.Object(lambda o: o.name("crm.Address").properties([
    lambda t, name=name, of=of: t.name(name).type([of]) for name, of in fields.items()
]))

# Read a schema through its builder, read-only: its members are its meta-schema's.
reader = Builders.OfObject.Builder(Contact, False)
assert (reader.name.get(), reader.ref.get(), [e.name.get() for e in reader.properties]) == ("crm.Contact", True, ["given_name"])
assert store.registered("crm.Customer") is Customer and list(store.module("crm").schemas) == ["Contact", "Customer", "Address"]
assert all(schema.validate() == [] for schema in (Contact, V2, Customer, Address))

ada = store.crm.Customer(lambda c: c.given_name("Ada").account("A-1"))
assert Validators.Validate(store)(Customer, ada) == []
```

```typescript
import { Builders, Validators } from "@mbse/schemas/Framework";

const [Int, Text] = [Builders.Meta.OfInt, Builders.Meta.OfStr]; // the basic scalars, which every store holds
const store: any = new Builders.Store();
const check = (ok: boolean) => { if (!ok) throw new Error("unexpected"); };

// Design: a schema is built in its store, and a named one is registered, in the module its name's prefix names.
const Contact = store.Schemas.Object((o: any) => (
  o
    .name("crm.Contact")
    .ref(true)
    .properties([(t: any) => t.name("given_name").type([Text])])
));

// Extend in place: the schema and a callback update it, as an object and a callback update data.
store.Schemas.Object(Contact, (o: any) => o.properties([(t: any) => t.name("age").type([Int])]));
check([...Contact.properties.keys()].join() === "given_name,age");

// Remove a member: the adjacency's visitor removes the entries agreeing with a template.
store.Schemas.Object(Contact, (o: any) => o.properties((adv: any) => adv.remove((e: any) => e.name("age"))));
check([...Contact.properties.keys()].join() === "given_name");

// A new version beside the old: a named schema's identity is its name, so clone it under another, in the store.
const V2 = new Builders.OfObject.Builder(Contact, true, store).name("crm.Contact.v2").clone();
store.Schemas.Object(V2, (o: any) => o.properties([(t: any) => t.name("email").type([Text])]));
check([...V2.properties.keys()].join() === "given_name,email" && Contact.properties.size === 1);

// A refinement: the members of the schema it refines, and its own; its objects are that schema's objects too.
const Customer = store.Schemas.Object((o: any) => (
  o
    .name("crm.Customer")
    .ref(true)
    .refines([Contact])
    .properties([(t: any) => t.name("account").type([Text])])
));
check([...Customer.properties.keys()].join() === "given_name,account");

// Generate: a program builds schemas from whatever describes them.
const fields = new Map([["street", Text], ["number", Int]]);
const Address = store.Schemas.Object((o: any) => o.name("crm.Address").properties(
  [...fields].map(([name, of]) => (t: any) => t.name(name).type([of])),
));

// Read a schema through its builder, read-only: its members are its meta-schema's.
const reader: any = new Builders.OfObject.Builder(Contact, false);
check(reader.name.get() === "crm.Contact" && reader.ref.get() === true
  && [...reader.properties].map((e: any) => e.name.get()).join() === "given_name");
check(store.registered("crm.Customer") === Customer
  && [...store.module("crm").schemas.keys()].join() === "Contact,Customer,Address");
check([Contact, V2, Customer, Address].every((schema) => schema.validate().length === 0));

const ada = store.crm.Customer((c: any) => c.given_name("Ada").account("A-1"));
check(Validators.Validate(store)(Customer, ada).length === 0);
```

## Rules

- **Link only what the store holds.** A store refuses a link to a schema object it does not hold: build every schema,
  form and member in the store that links it. The basic scalars are `Builders.Meta`'s (`OfBool`, `OfInt`, `OfFloat`,
  `OfStr`, `OfBytes`), held by every store; a scalar of another token or width is built,
  `store.Schemas.Scalar(lambda s: s.token("int").bits([w]))`, as is a width or another term,
  `store.Schemas.Form(lambda f: f.kind("literal").attributes({"value": 32}))`. Never link `Schemas.OfX.Data(...)`.
- **A type exists before what it types.** Build a value object or container schema, then the property typed by it.
  Two schemas that refer to each other are built in two steps: the first, then the second, then the first updated.
- **A named schema's identity is its name.** `store.Schemas.Object(Contact)` cannot clone it into the same store; a
  version beside it is a builder's clone under a new name. Renaming one (`.name(...)` in an update) moves it to the
  module its new name gives.
- **Extending changes the schema in place.** Objects of an extended schema gain the member, absent until written. To keep
  the old schema as it was, make a version.
- **Validate when you are done.** Building never validates, so a schema may be incomplete between steps;
  `schema.validate()` lists its problems.

## Go deeper

| Topic | Read |
|---|---|
| Schemas built from the dataclasses a program has | [python.md, cheat sheet](python.md#cheat-sheet) (`FromDataclass`) |
| Evolving schemas as requirements change | [tutorial 9, When requirements change](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/09_When_Requirements_Change.ipynb) |
| The meta-schemas and their builders | [META_SCHEMAS.md](https://github.com/pitaman71/mbse-schemas/blob/main/docs/META_SCHEMAS.md#the-meta-schemas-and-their-builders-as-built) |
