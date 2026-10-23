<!-- nav -->
[← Python test plan](../python3/tests/TestPlan.md) · [Home](../README.md) · [TypeScript test plan →](tests/TestPlan.md)

# mbse-schemas (TypeScript)

TypeScript implementation of the schemas framework, equivalent to `../python3`. The core (`src/Framework`) uses no
Node APIs, so it runs in Node, browsers and Deno. New to the framework? Start with the tutorial,
[the tutorial](tutorials/README.md): ten case studies, from a contact card to asking the store. The design is in
the [framework design document](../docs/FRAMEWORK.md); the [test plan](tests/TestPlan.md) includes the deliberate
language differences.

```sh
npm install
npm test                                # type-check and run the test notebooks and tutorials
npm run portability                     # the core without Node: browser bundle + Deno smoke test (needs deno)
npx tsx src/Examples/AddressBook.ts     # an example
npm run conformance                     # regenerate ../conformance/typescript5
```

The same program in both languages:

```python
def install(txn):
    S = txn.Schemas
    return txn.uid('addresses/1').mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({'IntlAddress': S.OfObject})
        .spec([lambda _: _.IntlAddress.name('IntlAddress').ref(True).properties({'street1': S.OfStr})])]))])


store = Builders.Store()
store.transaction(install)
with store.transaction():
    addr = store.IntlAddress(lambda a: a.street1('10 Downing Street'))
```

```ts
function install(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("addresses/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ IntlAddress: S.OfObject })
    .spec([(_: any) => _.IntlAddress.name("IntlAddress").ref(true).properties({ street1: S.OfStr })])]))]);
}

const store: any = new Builders.Store();
store.transaction(install);
const addr = store.transaction(() => store.IntlAddress((a: any) => a.street1("10 Downing Street")));
```

---

<!-- nav -->
[← Python test plan](../python3/tests/TestPlan.md) · [Home](../README.md) · [TypeScript test plan →](tests/TestPlan.md)
