# mbse-schemas (TypeScript)

TypeScript implementation of the schemas framework, equivalent to `../python3`. The core (`src/Framework`) uses no
Node APIs, so it runs in Node, browsers and Deno. New to the framework? Start with the tutorial,
[`tutorials/README.md`](tutorials/README.md): nine case studies, from a contact card to evolving schemas. The design is in
[`../docs/FRAMEWORK.md`](../docs/FRAMEWORK.md); the test plan, including the deliberate language differences, is in
[`tests/TestPlan.md`](tests/TestPlan.md).

```sh
npm install
npm test                                # type-check and run the test notebooks and tutorials
npm run portability                     # the core without Node: browser bundle + Deno smoke test (needs deno)
npx tsx src/Examples/AddressBook.ts     # an example
npm run conformance                     # regenerate ../conformance/typescript5
```

The same program in both languages:

```python
IntlAddress = Schemas.OfObject.Builder().name('IntlAddress').ref().properties(lambda p: p.name('street1').of(lambda t: t.as_native(str))).create()
store = Proxies.OfStore()
store.register(IntlAddress)
addr = store.IntlAddress().street1('10 Downing Street').create()
```

```ts
const IntlAddress = new Schemas.OfObject.Builder().name("IntlAddress").ref().properties((p) => p.name("street1").of((t) => t.as_native(String))).create();
const store = new Proxies.OfStore();
store.register(IntlAddress);
const addr = store.IntlAddress().street1("10 Downing Street").create();
```
