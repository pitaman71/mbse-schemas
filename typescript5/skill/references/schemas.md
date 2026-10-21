# Designing and extending schemas

Schemas are data. Every schema is an object in its store, of a plain schema of schemas (`store.Schemas.OfObject`, ...),
the store's own, built and
changed through its builder as data is: `store.Schemas.<Kind>(callback)` creates one, `store.Schemas.<Kind>(schema,
callback)` updates it. So the same fluent calls design a schema, extend one that exists, make a new version beside it,
or generate schemas from anything a program holds.

## A complete program

```python
from mbse.Schemas.Framework import Builders, Validators

store = Builders.Store()
Int, Text = store.Schemas.OfInt, store.Schemas.OfStr  # its basic scalars, its own, named by its paths

# Design: a schema is built in its store, and a named one is registered, in the module its name's prefix names.
with store.transaction():  # every write to a store is made within a transaction
    Contact = store.Schemas.OfObject(lambda o: (
        o
        .name("crm.Contact")
        .ref(True)
        .properties([lambda t: t.name("given_name").schema([Text])])
    ))

# Extend in place: the schema and a callback update it, as an object and a callback update data.
with store.transaction():  # a schema that existed: changed when it ends
    store.Schemas.OfObject(Contact, lambda o: o.properties([lambda t: t.name("age").schema([Int])]))
assert list(Contact.properties) == ["given_name", "age"]

# Remove a member: the adjacency's visitor removes the entries agreeing with a template.
with store.transaction():
    store.Schemas.OfObject(Contact, lambda o: o.properties(lambda adv: adv.remove(lambda e: e.name("age"))))
assert list(Contact.properties) == ["given_name"]

# A new version beside the old: a named schema's path is its name, so clone it under another, in the store; a
# version's module beside the schema's, as a module and a schema do not share a path.
with store.transaction():  # made within it: changed at once
    V2 = Builders.OfObject.Builder(Contact, store=store).name("crm.v2.Contact").clone()
    store.Schemas.OfObject(V2, lambda o: o.properties([lambda t: t.name("email").schema([Text])]))
assert list(V2.properties) == ["given_name", "email"] and list(Contact.properties) == ["given_name"]

# A refinement: the members of the schema it refines, and its own; its objects are that schema's objects too.
with store.transaction():
    Customer = store.Schemas.OfObject(lambda o: (
        o
        .name("crm.Customer")
        .ref(True)
        .refines([Contact])
        .properties([lambda t: t.name("account").schema([Text])])
    ))
assert list(Customer.properties) == ["given_name", "account"]

# Generate: a program builds schemas from whatever describes them.
fields = {"street": Text, "number": Int}
with store.transaction():
    Address = store.Schemas.OfObject(lambda o: o.name("crm.Address").properties([
        lambda t, name=name, of=of: t.name(name).schema([of]) for name, of in fields.items()
    ]))

# Read a schema through its builder, read-only: its members are its plain schema's, the store's Schemas.OfX.
reader = Builders.OfObject.Builder(Contact, False)
assert (reader.name.get(), reader.ref.get(), [e.name.get() for e in reader.properties]) == ("crm.Contact", True, ["given_name"])
assert store.registered("crm.Customer") is Customer and list(store.module("crm").schemas) == ["Contact", "v2", "Customer", "Address"]
assert all(schema.validate() == [] for schema in (Contact, V2, Customer, Address))

with store.transaction():
    ada = store.crm.Customer(lambda c: c.given_name("Ada").account("A-1"))
assert Validators.Validate(store)(Customer, ada) == []
```

```typescript
import { Builders, Validators } from "@mbse/schemas/Framework";

const store: any = new Builders.Store();
const [Int, Text] = [store.Schemas.OfInt, store.Schemas.OfStr]; // its basic scalars, its own, named by its paths
const check = (ok: boolean) => { if (!ok) throw new Error("unexpected"); };

// Design: a schema is built in its store, and a named one is registered, in the module its name's prefix names.
const Contact = store.transaction(() => store.Schemas.OfObject((o: any) => ( // every write to a store is made within a transaction
  o
    .name("crm.Contact")
    .ref(true)
    .properties([(t: any) => t.name("given_name").schema([Text])])
)));

// Extend in place: the schema and a callback update it, as an object and a callback update data.
store.transaction(() => store.Schemas.OfObject(Contact, (o: any) => o.properties([(t: any) => t.name("age").schema([Int])]))); // a schema that existed: changed when it ends
check([...Contact.properties.keys()].join() === "given_name,age");

// Remove a member: the adjacency's visitor removes the entries agreeing with a template.
store.transaction(() => store.Schemas.OfObject(Contact, (o: any) => o.properties((adv: any) => adv.remove((e: any) => e.name("age")))));
check([...Contact.properties.keys()].join() === "given_name");

// A new version beside the old: a named schema's path is its name, so clone it under another, in the store; a
// version's module beside the schema's, as a module and a schema do not share a path.
const V2 = store.transaction(() => { // made within it: changed at once
  const V2 = new Builders.OfObject.Builder(Contact, true, store).name("crm.v2.Contact").clone();
  return store.Schemas.OfObject(V2, (o: any) => o.properties([(t: any) => t.name("email").schema([Text])]));
});
check([...V2.properties.keys()].join() === "given_name,email" && Contact.properties.size === 1);

// A refinement: the members of the schema it refines, and its own; its objects are that schema's objects too.
const Customer = store.transaction(() => store.Schemas.OfObject((o: any) => (
  o
    .name("crm.Customer")
    .ref(true)
    .refines([Contact])
    .properties([(t: any) => t.name("account").schema([Text])])
)));
check([...Customer.properties.keys()].join() === "given_name,account");

// Generate: a program builds schemas from whatever describes them.
const fields = new Map([["street", Text], ["number", Int]]);
const Address = store.transaction(() => store.Schemas.OfObject((o: any) => o.name("crm.Address").properties(
  [...fields].map(([name, of]) => (t: any) => t.name(name).schema([of])),
)));

// Read a schema through its builder, read-only: its members are its plain schema's, the store's Schemas.OfX.
const reader: any = new Builders.OfObject.Builder(Contact, false);
check(reader.name.get() === "crm.Contact" && reader.ref.get() === true
  && [...reader.properties].map((e: any) => e.name.get()).join() === "given_name");
check(store.registered("crm.Customer") === Customer
  && [...store.module("crm").schemas.keys()].join() === "Contact,v2,Customer,Address");
check([Contact, V2, Customer, Address].every((schema) => schema.validate().length === 0));

const ada = store.transaction(() => store.crm.Customer((c: any) => c.given_name("Ada").account("A-1")));
check(Validators.Validate(store)(Customer, ada).length === 0);
```

## Rules

- **Link only what the store holds.** A store refuses a link to a schema object it does not hold: build every schema,
  and member in the store that links it. A store's basic scalars are its own, reached by its paths
  (`store.Schemas.OfBool`, `.OfInt`, `.OfFloat`, `.OfStr`, `.OfBytes`), the only scalar schemas: a store builds no
  other, and a finer scalar (a date, an int32) is a domain, mbse-expressions'. Never link `Schemas.OfX.Data(...)`.
- **A schema exists before what holds its values.** Build a value object or container schema, then the property that
  holds its values.
  Two schemas that refer to each other are built in two steps: the first, then the second, then the first updated.
- **A named schema's path is its name.** `store.Schemas.OfObject(Contact)` cannot clone it into the same store; a
  version beside it is a builder's clone under a new name, in a module of its own (`crm.v2.Contact`): a module and a
  schema do not share a path. Renaming one (`.name(...)` in an update) moves it to the module its new name gives.
  `Paths.of(schema)` gives its path, and `store.held(path)` the schema object at one.
- **Name what you share.** A schema object with no name of its own (an unnamed value object, container or relation) has
  no path: one schema object alone may link it, and the store refuses a second ("name it to share it").
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
