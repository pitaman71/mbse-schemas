<!-- nav -->
[← Python test plan](../python3/tests/TestPlan.md) · [Home](../README.md) · [TypeScript test plan →](tests/TestPlan.md)

# mbse-schemas (TypeScript)

TypeScript implementation of the schemas framework, equivalent to `../python3`. The core (`src/Framework`) uses no
Node APIs, so it runs in Node, browsers and Deno. New to the framework? Start with the tutorial,
[the tutorial](tutorials/README.md): nine case studies, from a contact card to evolving schemas. The design is in
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
store = Builders.Store()
IntlAddress = store.Schemas.OfObject(lambda o: o.name('IntlAddress').ref(True).properties([
    lambda t: t.name('street1').schema([store.Schemas.OfStr])]))
addr = store.IntlAddress(lambda a: a.street1('10 Downing Street'))
```

```ts
const store: any = new Builders.Store();
const IntlAddress = store.Schemas.OfObject((o: any) => o.name("IntlAddress").ref(true).properties([
  (t: any) => t.name("street1").schema([store.Schemas.OfStr])]));
const addr = store.IntlAddress((a: any) => a.street1("10 Downing Street"));
```

---

<!-- nav -->
[← Python test plan](../python3/tests/TestPlan.md) · [Home](../README.md) · [TypeScript test plan →](tests/TestPlan.md)
