# Querying with transactions

To find, filter, traverse and write data, give `store.transaction` an expression,
`store.transaction(lambda t: t.mutations([...]))`. Its terms pass on a stream of *frames*: each frame binds the
symbols that the terms before it declared, each symbol to one object. A pattern's *spec* says what must be true of a
frame. A map keeps the frames where it holds, and an upsert or an update writes it where it does not. The transaction
gives back the frames at the end of its chain. Like every transaction, it writes all or nothing.

## A complete program

A book owns its contacts by key, persons know persons since a year, and counted notes are about persons. The program
writes them, finds people by their properties and entries, starts from one person's reference, drops a symbol, updates
and upserts after a map, removes an entry, and hands frames on as references.

```python
from mbse.Schemas.Framework import Builders, References


def install(txn):
    """crm: persons who know persons since a year; a book, a singleton, owning its contacts by key; notes, counted."""
    S = txn.Schemas
    return txn.uid("crm/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Knows": S.OfRelation, "Person": S.OfObject, "Holds": S.OfRelation, "Book": S.OfObject,
                  "Note": S.OfObject, "About": S.OfRelation})
        .spec([
            lambda _: _.Knows.name("crm.Knows").links([lambda t: t.name("knower"), lambda t: t.name("known")])
            .properties({"since": S.OfInt}),
            lambda _: _.Person.name("crm.Person").ref(True).properties({"name": S.OfStr, "age": S.OfInt}).adjacencies([
                lambda t: t.name("knows").relation([_.Knows]).me("knower"),
                lambda t: t.relation([_.Knows]).me("known"),
                lambda t: t.name("book").relation([_.Holds]).me("contact").owner(True),
            ]),
            lambda _: _.Holds.name("crm.Holds").links([lambda t: t.name("book"), lambda t: t.name("contact")])
            .properties({"key": S.OfStr}).uniques([["book", "key"], ["contact"]]),
            lambda _: _.Book.name("crm.Book").ref(True).singleton("crm.TheBook").adjacencies({
                "contacts": lambda t: t.relation([_.Holds]).me("book")}),
            lambda _: _.Note.name("crm.Note").ref(True).properties({"text": S.OfStr}).adjacencies({
                "about": lambda t: t.relation([_.About]).me("note")}),
            lambda _: _.About.name("crm.About").links([lambda t: t.name("note"), lambda t: t.name("person")]),
        ])]))])


store = Builders.Store()
store.transaction(install)
Person, Book, Note = (store.registered(name) for name in ("crm.Person", "crm.Book", "crm.Note"))
book = store.singleton("crm.TheBook")


def people(t):
    """Write: one upsert, each object a symbol; contacts found by the book's owning entry: rerun, it writes nothing."""
    return t.uid("people").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"book": Book, "ada": Person, "bob": Person, "cy": Person}).spec([
            lambda _: _.book.contacts({"ada": lambda e: e.contact(_.ada), "bob": lambda e: e.contact(_.bob),
                                       "cy": lambda e: e.contact(_.cy)}),       # a keyed adjacency: a mapping by key
            lambda _: _.ada.name("Ada").age(36).knows([lambda e: e.known(_.bob).since(2020), _.cy]),  # an entry; a link
            lambda _: _.bob.name("Bob").age(36).knows([_.cy]),
            lambda _: _.cy.name("Cy"),
        ])]))])


frames = store.transaction(people)  # the frames its chain ends with: one, each symbol's object by name
ada, bob, cy = (frames[0][name] for name in ("ada", "bob", "cy"))
assert store.transaction(people)[0]["ada"] is ada and len(book.contacts) == 3  # found again, nothing written


def find(*specs, symbols=None, then=None):
    """A map: binds each symbol to every object of its schema whose spec holds, one frame each."""
    term = lambda m: m.symbols([lambda p: p.symbols(symbols or {"x": Person, "y": Person}).spec(list(specs))])
    return store.transaction(lambda t: t.mutations([lambda mu: mu.map(
        term if then is None else lambda m: term(m).then([then]))]))


def names(frames):
    return [tuple(str(o.name) for o in frame.values()) for frame in frames]


# Find and filter: property values, entries through a named adjacency, an entry's property, absence.
assert names(find(lambda _: _.x.knows([_.y]))) == [("Ada", "Bob"), ("Ada", "Cy"), ("Bob", "Cy")]
assert names(find(lambda _: _.x.knows([lambda e: e.known(_.y).since(2020)]))) == [("Ada", "Bob")]
assert names(find(lambda _: _.x.age(36), symbols={"x": Person})) == [("Ada",), ("Bob",)]
assert names(find(lambda _: _.x.age(None), symbols={"x": Person})) == [("Cy",)]  # None: the property absent
assert names(find(lambda _: _.x.knows(lambda a: a.clear()), symbols={"x": Person})) == [("Cy",)]  # knows no one
# Traverse: a singleton's symbol binds it; a symbol given a reference binds the one object it designates.
bobs = find(lambda _: _.b.contacts({"bob": lambda e: e.contact(_.x)}), symbols={"b": Book, "x": Person})
assert [str(f["x"].name) for f in bobs] == ["Bob"]
assert names(find(lambda _: _.x.knows([_.y]), symbols={"x": References.of(store, bob), "y": Person})) == [("Bob", "Cy")]
# Reduce: drop a symbol, keeping each frame left once (who knows anyone).
assert names(find(lambda _: _.x.knows([_.y]), then=lambda w: w.reduce(lambda r: r.symbols([
    lambda c: c.pattern([lambda p: p.symbols({"x": Person, "y": Person})]).symbols(["y"])])))) == [("Ada",), ("Bob",)]
# Update: write a spec over each frame a map gave.
find(lambda _: _.x.age(36), symbols={"x": Person}, then=lambda w: w.update(lambda u: u.apply([
    lambda p: p.symbols({"x": Person}).spec([lambda _: _.x.age(37)])])))
assert [store.member(p, "age") for p in (ada, bob, cy)] == [37, 37, None]
# Upsert after a map: a counted note about each person whose name is Ada; a counted object has no reference.
made = find(lambda _: _.x.name("Ada"), symbols={"x": Person}, then=lambda w: w.upsert(lambda u: u.key("notes").exists([
    lambda p: p.symbols({"x": Person, "n": Note}).spec([lambda _: _.n.text("about Ada").about([_.x])])])))
assert [(f["x"], str(f["n"].text)) for f in made] == [(ada, "about Ada")]
try:
    References.of(store, made[0])
    raise AssertionError("a frame binding a counted note has a reference")
except LookupError:
    pass
# Absence written: remove the entries that agree with the one given; run again, the spec holds and nothing is written.
unknow = lambda t: t.mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
    .symbols({"x": References.of(store, ada), "y": References.of(store, bob)})
    .spec([lambda _: _.x.knows(lambda a: a.remove(lambda e: e.known(_.y)))])]))])
store.transaction(unknow)
store.transaction(unknow)
assert [str(e.known.name) for e in ada.knows] == ["Cy"]
# Hand frames on: a frame's reference, carried in a response and resolved in the next request.
pairs = find(lambda _: _.x.knows([_.y]))
sent = [References.of(store, frame) for frame in pairs]
assert [References.resolve(store, ref) for ref in sent] == pairs
```

The same in TypeScript. Ints are `bigint` (`36n`), absent is `null`, and each frame is a `Map`.

```typescript
import { Builders, References } from "@mbse/schemas/Framework";
import { LookupError } from "@mbse/schemas/Framework/Errors";

const check = (ok: boolean) => { if (!ok) throw new Error("unexpected"); };
const same = (a: unknown, b: unknown) => check(JSON.stringify(a) === JSON.stringify(b));

/** crm: persons who know persons since a year; a book, a singleton, owning its contacts by key; notes, counted. */
function install(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("crm/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ Knows: S.OfRelation, Person: S.OfObject, Holds: S.OfRelation, Book: S.OfObject,
      Note: S.OfObject, About: S.OfRelation })
    .spec([
      (_: any) => _.Knows.name("crm.Knows").links([(t: any) => t.name("knower"), (t: any) => t.name("known")])
        .properties({ since: S.OfInt }),
      (_: any) => _.Person.name("crm.Person").ref(true).properties({ name: S.OfStr, age: S.OfInt }).adjacencies([
        (t: any) => t.name("knows").relation([_.Knows]).me("knower"),
        (t: any) => t.relation([_.Knows]).me("known"),
        (t: any) => t.name("book").relation([_.Holds]).me("contact").owner(true),
      ]),
      (_: any) => _.Holds.name("crm.Holds").links([(t: any) => t.name("book"), (t: any) => t.name("contact")])
        .properties({ key: S.OfStr }).uniques([["book", "key"], ["contact"]]),
      (_: any) => _.Book.name("crm.Book").ref(true).singleton("crm.TheBook").adjacencies({
        contacts: (t: any) => t.relation([_.Holds]).me("book") }),
      (_: any) => _.Note.name("crm.Note").ref(true).properties({ text: S.OfStr }).adjacencies({
        about: (t: any) => t.relation([_.About]).me("note") }),
      (_: any) => _.About.name("crm.About").links([(t: any) => t.name("note"), (t: any) => t.name("person")]),
    ])]))]);
}

const store: any = new Builders.Store();
store.transaction(install);
const [Person, Book, Note] = ["crm.Person", "crm.Book", "crm.Note"].map((name) => store.registered(name));
const book = store.singleton("crm.TheBook");

/** Write: one upsert, each object a symbol; contacts found by the book's owning entry: rerun, it writes nothing. */
function people(t: any): any {
  return t.uid("people").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ book: Book, ada: Person, bob: Person, cy: Person }).spec([
      (_: any) => _.book.contacts({ ada: (e: any) => e.contact(_.ada), bob: (e: any) => e.contact(_.bob),
        cy: (e: any) => e.contact(_.cy) }),                                 // a keyed adjacency: a mapping by key
      (_: any) => _.ada.name("Ada").age(36n).knows([(e: any) => e.known(_.bob).since(2020n), _.cy]), // an entry; a link
      (_: any) => _.bob.name("Bob").age(36n).knows([_.cy]),
      (_: any) => _.cy.name("Cy"),
    ])]))]);
}

const frames = store.transaction(people); // the frames its chain ends with: one, a Map of each symbol's object
const [ada, bob, cy] = ["ada", "bob", "cy"].map((name) => frames[0].get(name));
check(store.transaction(people)[0].get("ada") === ada && [...book.contacts].length === 3); // found again

/** A map: binds each symbol to every object of its schema whose spec holds, one frame each. */
function find(specs: any[], symbols: any = { x: Person, y: Person }, then?: any): any[] {
  const term = (m: any) => m.symbols([(p: any) => p.symbols(symbols).spec(specs)]);
  return store.transaction((t: any) => t.mutations([(mu: any) => mu.map(
    then === undefined ? term : (m: any) => term(m).then([then]))]));
}

const names = (frames: any[]) => frames.map((frame) => [...frame.values()].map((o: any) => `${o.name}`));

// Find and filter: property values, entries through a named adjacency, an entry's property, absence.
same(names(find([(_: any) => _.x.knows([_.y])])), [["Ada", "Bob"], ["Ada", "Cy"], ["Bob", "Cy"]]);
same(names(find([(_: any) => _.x.knows([(e: any) => e.known(_.y).since(2020n)])])), [["Ada", "Bob"]]);
same(names(find([(_: any) => _.x.age(36n)], { x: Person })), [["Ada"], ["Bob"]]);
same(names(find([(_: any) => _.x.age(null)], { x: Person })), [["Cy"]]); // null: the property absent
same(names(find([(_: any) => _.x.knows((a: any) => a.clear())], { x: Person })), [["Cy"]]); // knows no one
// Traverse: a singleton's symbol binds it; a symbol given a reference binds the one object it designates.
same(find([(_: any) => _.b.contacts({ bob: (e: any) => e.contact(_.x) })], { b: Book, x: Person })
  .map((f) => `${f.get("x").name}`), ["Bob"]);
same(names(find([(_: any) => _.x.knows([_.y])], { x: References.of(store, bob), y: Person })), [["Bob", "Cy"]]);
// Reduce: drop a symbol, keeping each frame left once (who knows anyone).
same(names(find([(_: any) => _.x.knows([_.y])], { x: Person, y: Person }, (w: any) => w.reduce((r: any) => r.symbols([
  (c: any) => c.pattern([(p: any) => p.symbols({ x: Person, y: Person })]).symbols(["y"])])))), [["Ada"], ["Bob"]]);
// Update: write a spec over each frame a map gave.
find([(_: any) => _.x.age(36n)], { x: Person }, (w: any) => w.update((u: any) => u.apply([
  (p: any) => p.symbols({ x: Person }).spec([(_: any) => _.x.age(37n)])])));
check([ada, bob, cy].map((p) => store.member(p, "age")).join() === "37,37,");
// Upsert after a map: a counted note about each person whose name is Ada; a counted object has no reference.
const made = find([(_: any) => _.x.name("Ada")], { x: Person }, (w: any) => w.upsert((u: any) => u.key("notes").exists([
  (p: any) => p.symbols({ x: Person, n: Note }).spec([(_: any) => _.n.text("about Ada").about([_.x])])])));
check(made.length === 1 && made[0].get("x") === ada && `${made[0].get("n").text}` === "about Ada");
try {
  References.of(store, made[0]);
  check(false); // a frame binding a counted note has a reference
} catch (e) {
  check(e instanceof LookupError);
}
// Absence written: remove the entries that agree with the one given; run again, the spec holds and nothing is written.
const unknow = (t: any) => t.mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
  .symbols({ x: References.of(store, ada), y: References.of(store, bob) })
  .spec([(_: any) => _.x.knows((a: any) => a.remove((e: any) => e.known(_.y)))])]))]);
store.transaction(unknow);
store.transaction(unknow);
same([...ada.knows].map((e: any) => `${e.known.name}`), ["Cy"]);
// Hand frames on: a frame's reference, carried in a response and resolved in the next request.
const pairs = find([(_: any) => _.x.knows([_.y])]);
const sent = pairs.map((frame) => References.of(store, frame));
check(sent.every((ref, i) => [...References.resolve(store, ref) as Map<string, unknown>].every(
  ([name, o]) => o === pairs[i].get(name))));
```

## The terms

A transaction starts from one empty frame. `mutations` takes its first term, and each term's `then` takes the next,
each a list of one entry callback whose call chooses the term: `lambda mu: mu.map(...)`, `lambda w: w.update(...)`.
Any term may come first, except that a term may refer only to symbols that a term before it binds. A symbol that a
frame already binds keeps that object: a later pattern that names it refers to it and does not bind it again.

Map and reduce are meant in MapReduce's sense, not as a list's `map`: a map works on each frame alone and may give
none, one or many, so that a transaction can be sharded and run in parallel; a reduce groups what remains and folds
each group with a collector that is commutative or associative.

| Term | Takes | What it does with each frame |
|---|---|---|
| `map` | `symbols([pattern])`, `then` | Binds each symbol the frame lacks, in the order declared, to every object of the symbol's schema that the store reaches from its singletons, one frame for each match. Only frames where the spec holds go on, so a map multiplies frames by its matches. A map with no spec gives the cross product. |
| `upsert` | `key`, `exists([pattern])`, `then` | Binds symbols as a map does. Where it finds nothing, it creates the object, and then writes the spec wherever the spec does not hold. As the first term, it upserts from the empty frame. |
| `update` | `apply([pattern])`, `then` | Writes its spec over each frame where it does not hold. Every symbol it names must already be bound, so an update as the first term is refused. |
| `reduce` | `symbols([collector])`, `then` | Drops the collector's symbols, `c.pattern([...]).symbols(["y"])`, and keeps each remaining frame once. |
| `partition` | `branches`, `first`, `last`, `none`, `then` | By default, runs every branch. `first(True)` or `last(True)` runs only that branch. `none` runs where there are no branches. The frames the branches end with are joined and passed to `then`. |

`store.transaction` gives back the frames its chain ends with, a list of `{symbol: object}` (in TypeScript, an array of
`Map`). With no terms, it gives back `[{}]`; where nothing matches, `[]`. A transaction can also be built first, as
`tx = store.Mutations.OfTransaction(lambda t: ...)`, then run with `store.transaction(tx)` and written out with
`Plain.ToPlain(store).Transaction(tx)` ([serialization.md](serialization.md)).

```python fragment
lambda w: w.partition(lambda p: p.first(True).branches([
    lambda e: e.branch(lambda b: b.then([lambda w2: w2.upsert(...)])),  # a branch with no then: frames pass as they are
]).none([lambda w2: w2.reduce(...)]).then([lambda w2: w2.update(...)]))  # what the branches end with, joined
```

## Patterns

A pattern's `symbols` maps each symbol name to one of the following:
- **A schema** (`Person`, or `txn.Schemas.OfObject` for schema objects). The symbol ranges over that schema's objects:
  every object of any reference object schema, or every named schema of a meta-schema's kind. Installs work this way
  ([schemas.md](schemas.md)).
- **A singleton's schema** (`Book`). The symbol binds the singleton itself, with no spec needed.
- **A reference** (`References.of(store, bob)`, or one read from a request). The symbol binds the one object the
  reference designates, and its spec writes the members of that object's schema. Where the store holds nothing there,
  a map gives no frame and an upsert creates nothing. The spec is still written: by the schema the reference's path
  implies, followed through the schemas, so that a store holding only the schemas (a client's) writes it and the
  store holding the data runs it. A path the schemas cannot follow (an unknown singleton, an adjacency the schema
  lacks, a link no one schema fills) is refused when the spec is written.

A symbol has exactly one of a schema and a reference. `variables` are refused, as are `requires` (below).

## The spec

`spec([...])` takes callbacks, one per item, each given the frame `_`. Each symbol in the frame takes the builders'
calls for the object it binds: `lambda _: _.ada.name("Ada").knows([_.bob])`. In a map the spec filters. In an upsert
or an update it is written. Either way, it means the same:

- **Property values**: `_.x.age(36)`. `_.x.age(None)` (TypeScript: `null`) holds where the property is absent, and
  writing it clears the property.
- **Entries, only through an object's named adjacency**:
  - a list (peer shorthand) of linked symbols, `knows([_.y])`, or entry callbacks, `knows([lambda e: e.known(_.y).since(2020)])`;
  - for a keyed adjacency (two links, one property), a mapping from key to entry, `contacts({"ada": lambda e: e.contact(_.ada)})`.
    A bare symbol as the mapping's value is refused where more than one member could take it: give a callback;
  - `e.known(lambda n: n.name("Dan"))` defines the linked object in place. In a map, that matches *through* one, an
    object that the entry links and that has those members.

  A counted object is linked through a symbol that binds it, never as the object itself. For a relation with more
  than two links, give each entry's links.
- **Absence**: `knows(lambda a: a.remove(lambda e: e.known(_.y)))` removes every entry that agrees on what it gives.
  In a keyed adjacency, an entry given by its key removes that entry. `knows(lambda a: a.clear())` removes every entry.
  Either holds where what it removes is already absent: a map binds the objects that lack the entry, and run again
  it writes nothing. Removing an entry that is not there is no error. Removing an owning entry deletes what it owns.
  An entry's property may be cleared, but its link may not.

The spec's items apply in order. A spec that clears and then inserts does not hold afterward, so it writes again on
every run, and the store ends the same.

## Handing frames on

- `References.of(store, frame)` gives a frame's reference, the reference of each object it binds, which a response can
  carry and `References.resolve(store, ref)` turns back into the frame. `References.of(store, obj)` and
  `References.of(store, entry)` do the same for an object or an entry ([python.md, References](python.md#references)).
  Each reference given back can start a query of its own, as a symbol's reference.
- A frame can also act as a *witness*. It can carry property values an object holds (`assigns`) and relation entries
  (`entries`), each object given by its reference. The executor's frames carry neither of these. A service writes them,
  as below.
- **A counted object has no reference.** That includes one an upsert made, and any frame or entry that binds or links
  one: `References.of` raises `LookupError`. A map finds only what the store reaches from its singletons, so it
  misses a counted object that nothing reachable links. To designate an object, make it a singleton's or an owner's.

```python fragment
store.References.OfFrame(lambda f: f                      # a witness, as a service writes one (Paths: deprecated)
    .binds({"ada": lambda o: o.path(Paths.of(ada))})
    .assigns([lambda x: x.as_object(lambda p: p.object(lambda o: o.path(Paths.of(ada))).properties({"name": "Ada"}))])
    .entries([lambda x: x.as_object(lambda e: e.relation(Paths.of(Knows)).links({
        "knower": lambda o: o.path(Paths.of(ada)), "known": lambda o: o.path(Paths.of(bob))}).properties({"since": 2020}))]))
```

## Limits and traps

- **Entries change only through an object's named adjacency.** There is no relation-level verb. An anonymous
  adjacency is not a member, so a spec cannot write it.
- **No expressions yet.** Until mbse-expressions is ported (step 5), the executor refuses `requires` (a pattern's or a
  branch's), variables (`.variables(...)`, a map of variables), a reduce that collects (`suffixes`, `computes`), and a
  partition that is both `first` and `last`. It refuses them before writing anything. Filter by spec, or in your own
  code over the frames given back.
- **A change to an existing schema is seen only at commit** (Object identity, Decided, 96). A transaction that adds a
  property to a schema writes no object with that property. Write the data in a second transaction.
- **Do not rely on upserting a counted object again.** What an upsert of a counted object does when run again is the
  executor's own, and may change. Write so that a re-run is harmless: give the object an owner or a singleton, or reach
  it through what links it.
- **No partial writes.** A transaction that raises, or that is refused when it ends (an owned object with no owner),
  writes nothing. Transactions on one store do not nest.

## Go deeper

| Topic | Read |
|---|---|
| Frames, terms and their design | [Mutations as queries](https://github.com/pitaman71/mbse-schemas/blob/main/docs/STREAMING_QUERIES.md) |
| What names an object an upsert finds or creates | [Object identity, Decided](https://github.com/pitaman71/mbse-schemas/blob/main/docs/OBJECT_IDENTITY.md#decided) (55 to 103) |
| References, frames as witnesses, a symbol given a reference | [References](https://github.com/pitaman71/mbse-schemas/blob/main/docs/proposals/references/README.md) |
| Every working form, with what each refuses | the TXN and REF suites, [31_Transactions](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tests/31_Transactions.ipynb) and [33_References](https://github.com/pitaman71/mbse-schemas/blob/main/python3/tests/33_References.ipynb) |
