# schemas (TypeScript)

TypeScript implementation of the schemas framework, equivalent to `../python3`. The core (`src/Framework`) uses no
Node APIs, so it runs in Node, browsers and Deno. The design is in
[`../Framework.md`](../Framework.md); the test plan, including the deliberate language differences, is in
[`tests/TestPlan.md`](tests/TestPlan.md).

```sh
npm install
npm test                                # type-check and run the test notebooks
npm run portability                     # the core without Node: browser bundle + Deno smoke test (needs deno)
npx tsx src/Examples/AddressBook.ts     # an example
npm run conformance                     # regenerate ../conformance/typescript5
```

The same program in both languages:

```python
IntlAddress = Schemas.OfObject.Builder().properties(lambda p: p.name('street1').of(lambda t: t.as_native(str))).create()
Proxies.register('IntlAddress', IntlAddress)
addr = Proxies.Builders.IntlAddress().street1('10 Downing Street').create()
```

```ts
const IntlAddress = new Schemas.OfObject.Builder().properties((p) => p.name("street1").of((t) => t.as_native(String))).create();
Proxies.register("IntlAddress", IntlAddress);
const addr = Proxies.Builders.IntlAddress().street1("10 Downing Street").create();
```
