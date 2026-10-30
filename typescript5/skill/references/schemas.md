# Designing and extending schemas

Schemas are data. Every schema is an object in its store, of a plain schema of schemas (`store.Schemas.OfObject`, ...),
the store's own. A module defines its schemas in a module-scope `install(txn)`: one upsert, each schema a symbol of its
kind, found by its name, else made, its spec the same fluent calls its builder takes. Run again, an install writes
nothing; another adds to what it finds, or removes from it. So installs design a schema, extend one that exists or
remove its members, refine one, or generate schemas from anything a program holds; the builders make a new version
beside a schema.

## A complete program

```python
from mbse.Schemas.Framework import Builders, Validators


def contacts(txn):
    """Design: each schema a symbol of its kind, in the module its name's prefix names."""
    S = txn.Schemas
    return txn.uid("crm.contacts/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Contact": S.OfObject})
        .spec([lambda _: _.Contact.name("crm.Contact").ref(True).properties({"given_name": S.OfStr})])]))])


def aged(txn):
    """Extend: another install finds crm.Contact by its name, and adds to it."""
    S = txn.Schemas
    return txn.uid("crm.aged/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Contact": S.OfObject})
        .spec([lambda _: _.Contact.name("crm.Contact").properties({"age": S.OfInt})])]))])


def unaged(txn):
    """Remove a member: an install's spec removes each entry agreeing with a template, as the adjacency's visitor does;
    run again, the entry is absent and nothing is written."""
    S = txn.Schemas
    return txn.uid("crm.unaged/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Contact": S.OfObject})
        .spec([lambda _: _.Contact.name("crm.Contact").properties(lambda a: a.remove(lambda e: e.name("age")))])]))])


def customers(txn):
    """A refinement: the members of the schema it refines, and its own; its objects are that schema's objects too."""
    S = txn.Schemas
    return txn.uid("crm.customers/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Customer": S.OfObject})
        .spec([lambda _: _.Customer.name("crm.Customer").ref(True).refines([txn.crm.Contact]).properties({
            "account": S.OfStr})])]))])


fields = {"street": "OfStr", "number": "OfInt"}  # Generate: an install made from whatever describes the schemas


def addresses(txn):
    S = txn.Schemas
    return txn.uid("crm.addresses/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Address": S.OfObject})
        .spec([lambda _: _.Address.name("crm.Address").properties({name: getattr(S, of) for name, of in fields.items()})])
    ]))])


store = Builders.Store()
store.transaction(contacts)
store.transaction(aged)
Contact = store.registered("crm.Contact")
assert list(Contact.properties) == ["given_name", "age"]

store.transaction(unaged)
store.transaction(unaged)  # run again: nothing to remove
assert list(Contact.properties) == ["given_name"]

# A new version beside the old: a named schema's path is its name, so clone it under another, in the store; a
# version's module beside the schema's, as a module and a schema do not share a path.
with store.transaction():  # made within it: changed at once
    V2 = Builders.OfObject.Builder(Contact, store=store).name("crm.v2.Contact").clone()
    store.Schemas.OfObject(V2, lambda o: o.properties([lambda t: t.name("email").schema([store.Schemas.OfStr])]))
assert list(V2.properties) == ["given_name", "email"] and list(Contact.properties) == ["given_name"]

store.transaction(customers)
store.transaction(addresses)
Customer, Address = store.registered("crm.Customer"), store.registered("crm.Address")
assert list(Customer.properties) == ["given_name", "account"] and list(Address.properties) == ["street", "number"]

# Read a schema through its builder, read-only: its members are its plain schema's, the store's Schemas.OfX.
reader = Builders.OfObject.Builder(Contact, False)
assert (reader.name.get(), reader.ref.get(), [e.name.get() for e in reader.properties]) == ("crm.Contact", True, ["given_name"])
assert list(store.module("crm").schemas) == ["Contact", "v2", "Customer", "Address"]
assert all(schema.validate() == [] for schema in (Contact, V2, Customer, Address))

with store.transaction():
    ada = store.crm.Customer(lambda c: c.given_name("Ada").account("A-1"))
assert Validators.Validate(store)(Customer, ada) == []
```

```typescript
import { Builders, Validators } from "@mbse/schemas/Framework";

const check = (ok: boolean) => { if (!ok) throw new Error("unexpected"); };

/** Design: each schema a symbol of its kind, in the module its name's prefix names. */
function contacts(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("crm.contacts/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ Contact: S.OfObject })
    .spec([(_: any) => _.Contact.name("crm.Contact").ref(true).properties({ given_name: S.OfStr })])]))]);
}

/** Extend: another install finds crm.Contact by its name, and adds to it. */
function aged(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("crm.aged/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ Contact: S.OfObject })
    .spec([(_: any) => _.Contact.name("crm.Contact").properties({ age: S.OfInt })])]))]);
}

/** Remove a member: an install's spec removes each entry agreeing with a template, as the adjacency's visitor does; run
 * again, the entry is absent and nothing is written. */
function unaged(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("crm.unaged/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ Contact: S.OfObject })
    .spec([(_: any) => _.Contact.name("crm.Contact").properties((a: any) => a.remove((e: any) => e.name("age")))])]))]);
}

/** A refinement: the members of the schema it refines, and its own; its objects are that schema's objects too. */
function customers(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("crm.customers/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ Customer: S.OfObject })
    .spec([(_: any) => _.Customer.name("crm.Customer").ref(true).refines([txn.crm.Contact]).properties({
      account: S.OfStr })])]))]);
}

const fields = new Map([["street", "OfStr"], ["number", "OfInt"]]); // Generate: an install made from whatever describes the schemas

function addresses(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("crm.addresses/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ Address: S.OfObject })
    .spec([(_: any) => _.Address.name("crm.Address").properties(new Map([...fields].map(([name, of]) => [name, S[of]])))]),
  ]))]);
}

const store: any = new Builders.Store();
store.transaction(contacts);
store.transaction(aged);
const Contact = store.registered("crm.Contact");
check([...Contact.properties.keys()].join() === "given_name,age");

store.transaction(unaged);
store.transaction(unaged); // run again: nothing to remove
check([...Contact.properties.keys()].join() === "given_name");

// A new version beside the old: a named schema's path is its name, so clone it under another, in the store; a
// version's module beside the schema's, as a module and a schema do not share a path.
const V2 = store.transaction(() => { // made within it: changed at once
  const V2 = new Builders.OfObject.Builder(Contact, true, store).name("crm.v2.Contact").clone();
  return store.Schemas.OfObject(V2, (o: any) => o.properties([(t: any) => t.name("email").schema([store.Schemas.OfStr])]));
});
check([...V2.properties.keys()].join() === "given_name,email" && Contact.properties.size === 1);

store.transaction(customers);
store.transaction(addresses);
const [Customer, Address] = [store.registered("crm.Customer"), store.registered("crm.Address")];
check([...Customer.properties.keys()].join() === "given_name,account" && [...Address.properties.keys()].join() === "street,number");

// Read a schema through its builder, read-only: its members are its plain schema's, the store's Schemas.OfX.
const reader: any = new Builders.OfObject.Builder(Contact, false);
check(reader.name.get() === "crm.Contact" && reader.ref.get() === true
  && [...reader.properties].map((e: any) => e.name.get()).join() === "given_name");
check([...store.module("crm").schemas.keys()].join() === "Contact,v2,Customer,Address");
check([Contact, V2, Customer, Address].every((schema) => schema.validate().length === 0));

const ada = store.transaction(() => store.crm.Customer((c: any) => c.given_name("Ada").account("A-1")));
check(Validators.Validate(store)(Customer, ada).length === 0);
```

## Rules

- **Link only what the store holds.** A store refuses a link to a schema object it does not hold: build every schema,
  and member in the store that links it. A store's basic scalars are its own, reached by its paths
  (`store.Schemas.OfBool`, `.OfInt`, `.OfFloat`, `.OfStr`, `.OfBytes`), the only scalar schemas: a store builds no
  other, and a finer scalar (a date, an int32) is a domain, mbse-expressions'. Never link `Schemas.OfX.Data(...)`.
- **One install, in any order.** An install's schemas are its symbols, so its spec may link any of them, whichever
  comes first: two schemas that refer to each other are written each with its own links. A value object or container
  with no name of its own is defined where it is linked (`S.OfContainer(lambda c: ...)`). A pattern whose spec names
  schemas goes in an install run after theirs.
- **A named schema's path is its name.** `store.Schemas.OfObject(Contact)` cannot clone it into the same store; a
  version beside it is a builder's clone under a new name, in a module of its own (`crm.v2.Contact`): a module and a
  schema do not share a path. Renaming one (`.name(...)` in an update) moves it to the module its new name gives.
  `Paths.of(schema)` gives its path, and `store.held(path)` the schema object at one (deprecated, for
  `References.of(store, schema)` and `References.resolve`).
- **Name what you share.** A schema object with no name of its own (an unnamed value object, container or relation) has
  no path: one schema object alone may link it, and the store refuses a second ("name it to share it").
- **Extending changes the schema in place.** Objects of an extended schema gain the member, absent until written. To keep
  the old schema as it was, make a version. A schema the store was made holding (`Schemas.OfObject`, ...) only gains
  members, in any transaction.
- **Validate when you are done.** Building never validates, so a schema may be incomplete between steps;
  `schema.validate()` lists its problems.

## Go deeper

| Topic | Read |
|---|---|
| Schemas built from the dataclasses a program has | [python.md, cheat sheet](python.md#cheat-sheet) (`FromDataclass`) |
| Evolving schemas as requirements change | [tutorial 9, When requirements change](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tutorials/09_When_Requirements_Change.ipynb) |
| The meta-schemas and their builders | [CAP-109: schemas as linked objects in modules](https://github.com/pitaman71/mbse-basis/blob/main/docs/capabilities/CAP-109.md#the-meta-schemas-and-their-builders-as-built) |
