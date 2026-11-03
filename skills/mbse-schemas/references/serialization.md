# Saving, loading and exchanging data

Documents are plain data (mappings, lists, strings, numbers, booleans), so they can be written as JSON or YAML. Python
and TypeScript write byte-identical JSON, and each reads the other's. Every form is a transaction, or a list of them:
reading one executes it, in the store given.

## Each form

1. **A document: an object, or a graph.** *Why*: one flat document holds shared and cyclic data without duplicates,
   and names each object's schema, so the reader never guesses. *When*: sending or saving an object and what it
   reaches. *How*: `Plain.ToPlain(store)(schema, value)` writes an object's document, the root alone, refused where it
   links a counted object; `.Reachable(schema, root)` writes the root and the counted objects reachable from it. A
   document is one transaction of one upsert: its objects are symbols numbered from the root, `"0"`, each naming its
   schema by its path; what it does not hold (a singleton, an owned object, a schema object) it refers to by path; each
   entry is written once, from the first object holding it. Give a `uid` where the same document may be read again.
   [CAP-128: graphs sent as one-transaction documents](mbse:mbse-basis/docs/capabilities/CAP-128.md).
   - Python: [T06.1: One object](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.1) · TypeScript: [T06.1: One object](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.1)
   - Python: [T06.2: A whole graph](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.2) · TypeScript: [T06.2: A whole graph](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.2)
   - Python: [PLN-02: The exact document format](mbse:mbse-schemas/python3/tests/05_Plain.ipynb#PLN-02) · TypeScript: [PLN-02: The exact document format](mbse:mbse-schemas/typescript5/tests/05_Plain.ipynb#PLN-02)
2. **Reading a document.** *Why*: loading is executing the transaction it holds, in the store you give, so the same
   rules apply as to any write. *How*: `Plain.FromPlain(store)(schema, data)` executes it and gives the root, within
   an open transaction as a savepoint. It binds a singleton's symbol to the singleton and an owned object's to the
   object its owning entry names, writing what the document holds and keeping what it omits; it makes counted objects
   anew, unless, under the same `uid`, it is read again while they are held. A document is how objects move between
   stores.
   [CAP-139: upserts find before they create](mbse:mbse-basis/docs/capabilities/CAP-139.md).
   - Python: [T06.3: Loading](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.3) · TypeScript: [T06.3: Loading](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.3)
   - Python: [T06.7: Round trips](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.7) · TypeScript: [T06.7: Round trips](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.7)
   - Python: [PLN-06: Reading a document executes it](mbse:mbse-schemas/python3/tests/05_Plain.ipynb#PLN-06) · TypeScript: [PLN-06: Reading a document executes it](mbse:mbse-schemas/typescript5/tests/05_Plain.ipynb#PLN-06)
3. **Any schema, not just objects.** `ToPlain` and `FromPlain` dispatch on the schema's kind, and have per-kind entry
   points; a standalone value (a value object, a union value, a container, a value of any schema) is written nested,
   as a property holding it writes it.
   - Python: [T06.8: Any schema, not just objects](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.8) · TypeScript: [T06.8: Any schema, not just objects](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.8)
   - Python: [PLN-18: A standalone value is written nested](mbse:mbse-schemas/python3/tests/05_Plain.ipynb#PLN-18) · TypeScript: [PLN-18: A standalone value is written nested](mbse:mbse-schemas/typescript5/tests/05_Plain.ipynb#PLN-18)
4. **JSON and YAML.** *Why*: JSON for machines, YAML for people, with the same values. *How*: `JSON.ToJSON(store)` and
   `JSON.FromJSON(store)`, `YAML.ToYAML(store)` and `YAML.FromYAML(store)`, mirror `Plain` exactly, `.Reachable`
   included; `JSON.dumps` and `JSON.loads` (and YAML's) write and read plain data.
   [CAP-158: values written as plain data, JSON and YAML](mbse:mbse-basis/docs/capabilities/CAP-158.md).
   - Python: [T07.1: JSON](mbse:mbse-schemas/python3/tutorials/07_JSON_And_YAML.ipynb#T07.1) · TypeScript: [T07.1: JSON](mbse:mbse-schemas/typescript5/tutorials/07_JSON_And_YAML.ipynb#T07.1)
   - Python: [T07.2: YAML](mbse:mbse-schemas/python3/tutorials/07_JSON_And_YAML.ipynb#T07.2) · TypeScript: [T07.2: YAML](mbse:mbse-schemas/typescript5/tutorials/07_JSON_And_YAML.ipynb#T07.2)
   - Python: [T07.4: Plain data in, plain data out](mbse:mbse-schemas/python3/tutorials/07_JSON_And_YAML.ipynb#T07.4) · TypeScript: [T07.4: Plain data in, plain data out](mbse:mbse-schemas/typescript5/tutorials/07_JSON_And_YAML.ipynb#T07.4)
5. **A journal: transactions as data.** *Why*: replaying the same expressions in another store, or after a crash,
   makes the same objects and the same provenance records. *When*: replicating or replaying writes. *How*:
   `Plain.ToPlain(store).Transaction(tx)` writes a transaction's expression (`store.Mutations.OfTransaction(...)`
   builds one first), and `Plain.FromPlain(store).Transaction(data)` reads it into a store, to run with
   `store.transaction(...)`. A journal is a list of them, replayed in order; each finds what it names, or makes it.
   [CAP-129: journals replayed by execution](mbse:mbse-basis/docs/capabilities/CAP-129.md).
   - Python: [T12.3: A journal, replayed in another store](mbse:mbse-schemas/python3/tutorials/12_Keeping_History.ipynb#T12.3) · TypeScript: [T12.3: A journal, replayed in another store](mbse:mbse-schemas/typescript5/tutorials/12_Keeping_History.ipynb#T12.3)
   - Python: [PRV-06: Replaying the same expression writes nothing twice](mbse:mbse-schemas/python3/tests/34_Provenance.ipynb#PRV-06) · TypeScript: [PRV-06: Replaying the same expression writes nothing twice](mbse:mbse-schemas/typescript5/tests/34_Provenance.ipynb#PRV-06)
   - Python: [TXN-13: A transaction on the wire](mbse:mbse-schemas/python3/tests/31_Transactions.ipynb#TXN-13) · TypeScript: [TXN-13: A transaction on the wire](mbse:mbse-schemas/typescript5/tests/31_Transactions.ipynb#TXN-13)
6. **A snapshot: a whole store.** *Why*: a restart, or another program, must get the store back as it was, its
   schemas and its data. *How*: `Plain.ToPlain(store).Snapshot()` (and its JSON and YAML forms) writes two
   transactions: the store's schemas, each in its module, then the data its singletons reach. `FromPlain(store)
   .Snapshot(snapshot, ignored)` reads it: a schema the store holds is found by its name, the rest made. A store
   lacking an extension the snapshot was written with reads what it can, and lists in `ignored`, where given, each
   member only that extension would hold, with the reason.
   [CAP-127: snapshots made of transactions](mbse:mbse-basis/docs/capabilities/CAP-127.md),
   [CAP-165: snapshots read by a store lacking their extensions](mbse:mbse-basis/docs/capabilities/CAP-165.md).
   - Python: [T12.4: A snapshot, and a restart](mbse:mbse-schemas/python3/tutorials/12_Keeping_History.ipynb#T12.4) · TypeScript: [T12.4: A snapshot, and a restart](mbse:mbse-schemas/typescript5/tutorials/12_Keeping_History.ipynb#T12.4)
   - Python: [T11.5: A store without the extension reads what it can](mbse:mbse-schemas/python3/tutorials/11_A_Parts_Catalog.ipynb#T11.5) · TypeScript: [T11.5: A store without the extension reads what it can](mbse:mbse-schemas/typescript5/tutorials/11_A_Parts_Catalog.ipynb#T11.5)
   - Python: [SNP-03: A snapshot: two transactions, its schemas, each found by its name, then its data, the singletons first](mbse:mbse-schemas/python3/tests/27_Snapshots.ipynb#SNP-03) · TypeScript: [SNP-03: A snapshot: two transactions, its schemas, each found by its name, then its data, the singletons first](mbse:mbse-schemas/typescript5/tests/27_Snapshots.ipynb#SNP-03)
   - Python: [SNP-04: A snapshot read back into another store, and written again the same](mbse:mbse-schemas/python3/tests/27_Snapshots.ipynb#SNP-04) · TypeScript: [SNP-04: A snapshot read back into another store, and written again the same](mbse:mbse-schemas/typescript5/tests/27_Snapshots.ipynb#SNP-04)

## Strictness

- JSON is strict. YAML is read with the 1.2 core schema, so `no` is a string (no "Norway problem"), and strings that
  readers misread are quoted when written.
  - Python: [T07.2: YAML](mbse:mbse-schemas/python3/tutorials/07_JSON_And_YAML.ipynb#T07.2) · TypeScript: [T07.2: YAML](mbse:mbse-schemas/typescript5/tutorials/07_JSON_And_YAML.ipynb#T07.2)
  - Python: [T07.3: Hand-written YAML](mbse:mbse-schemas/python3/tutorials/07_JSON_And_YAML.ipynb#T07.3) · TypeScript: [T07.3: Hand-written YAML](mbse:mbse-schemas/typescript5/tutorials/07_JSON_And_YAML.ipynb#T07.3)
- Nothing is coerced: `1`, `1.0` and true are different values, and a value of another scalar is an error. The
  serializers check values as they write.
  - Python: [T06.4: Serializers check values](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.4) · TypeScript: [T06.4: Serializers check values](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.4)
- Every problem in the input raises `DecodeError` (in Python, a `ValueError`) with a one-line reason and a location: a
  line and column for text, or a path such as
  `$.mutations[0].upsert.exists[0].spec[0]["0"][1].as_property.mutations[0].set.value`. The reasons are identical in
  both languages, but for YAML syntax errors
  ([CAP-159: error handling during deserialization is consistent across Python3 and Typescript5 bindings](mbse:mbse-basis/docs/capabilities/CAP-159.md)).
  - Python: [T06.5: Loading errors: DecodeError](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.5) · TypeScript: [T06.5: Loading errors: DecodeError](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.5)
  - Python: [T06.6: Malformed documents are rejected, with a location](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.6) · TypeScript: [T06.6: Malformed documents are rejected, with a location](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.6)
- A document's spec is checked against its symbols' schemas before anything is written; what only executing finds, a
  path to nothing, undoes what was written. A refused document writes nothing.
  - Python: [PLN-11: Malformed documents are refused before anything is written, with a path and a reason](mbse:mbse-schemas/python3/tests/05_Plain.ipynb#PLN-11) · TypeScript: [PLN-11: Malformed documents are refused before anything is written, with a path and a reason](mbse:mbse-schemas/typescript5/tests/05_Plain.ipynb#PLN-11)
  - Python: [PLN-13: A document that is refused writes nothing and leaves the input untouched](mbse:mbse-schemas/python3/tests/05_Plain.ipynb#PLN-13) · TypeScript: [PLN-13: A document that is refused writes nothing and leaves the input untouched](mbse:mbse-schemas/typescript5/tests/05_Plain.ipynb#PLN-13)
- Decoding does not validate. Call `Validators.Validate(store).Reachable(schema, root)` afterwards if you need to.
  - Python: [T06.7: Round trips](mbse:mbse-schemas/python3/tutorials/06_Saving_And_Loading.ipynb#T06.7) · TypeScript: [T06.7: Round trips](mbse:mbse-schemas/typescript5/tutorials/06_Saving_And_Loading.ipynb#T06.7)

## Go deeper

Store snapshots both languages must read identically are the
[conformance corpus](mbse:mbse-schemas/conformance/README.md).
