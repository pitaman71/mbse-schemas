/**
 * The conformance corpus: the same cases, built statement for statement in every implementation.
 *
 * `build()` returns `{case: [store, objects]}`: each case built in a store of its own, its schemas and its data, written
 * as the store's snapshot, two transactions (docs/SERIALIZATION.md, Snapshots); `objects` holds the case's data, which
 * a store holds weakly. Each implementation writes its snapshots to `conformance/<implementation>/<case>.json` and `.yaml`, and
 * checks them against every other implementation's files (see the CONF test suite). Keep this module and
 * `python3/mbse/Schemas/Conformance/Corpus.py` in lockstep: same schemas, same names, same values, same order of
 * statements.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Builders as B } from "../Framework/index.js";

export const CASES = ["address_book", "scalars", "family", "enrollment", "yaml_strings", "embedded", "lists", "module"] as const;

/** Writes a container's elements, each a scalar or, given a function, through its `Visitors.OfAny`. */
function write(pairs: Iterable<readonly [unknown, unknown]>) {
  return (container: any) => {
    for (const [index, value] of pairs) {
      const element = container.at(index);
      if (typeof value === "function") value(element);
      else element.as_scalar(value);
    }
    return container;
  };
}

/** A Spec writing the elements of the container a property holds. */
function put(pairs: Iterable<readonly [unknown, unknown]>) {
  return (prop: any) => prop.as_value((a: any) => a.as_container(write(pairs)));
}

/** Each value with its position, as a bigint. */
function enumerate(values: unknown[]): [bigint, unknown][] {
  return values.map((value, i) => [BigInt(i), value]);
}

/** The case's root, `Corpus.Root` (`rooted`), holding its data: a store's snapshot holds what its singletons reach. */
function hold(s: any, objects: unknown[]): void {
  const holding = (adjacency: any): any => {
    for (const item of objects) adjacency.insert((e: any) => e.item(item));
    return adjacency;
  };
  s.Corpus.Root(s.singleton("corpus"), (r: any) => r.holds(holding));
}

// --- Schemas, each group a module-scope install (docs/proposals/install) ---

/** Corpus.Root, the case's root, a singleton holding its data: a store's snapshot holds what its singletons reach. */
function rooted(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("corpus.rooted/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({Holds: S.OfRelation, Root: S.OfObject})
    .spec([
      (_: any) => _.Holds.name("Corpus.Holds").links([(t: any) => t.name("corpus"), (t: any) => t.name("item")]),
      (_: any) => _.Root.name("Corpus.Root").ref(true).singleton("corpus").adjacencies({
        holds: (a: any) => a.relation([_.Holds]).me("corpus")}),
    ])]))]);
}

function addressBook(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("corpus.address_book/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({Contact: S.OfObject, Address: S.OfObject, Phone: S.OfObject, ContactAddresses: S.OfRelation,
      ContactPhones: S.OfRelation})
    .spec([
      (_: any) => _.Contact.name("Contact").ref(true).properties({
        given_name: S.OfStr, family_name: S.OfStr, birth_date: S.OfStr,
      }).adjacencies({
        addresses: (a: any) => a.relation([_.ContactAddresses]).me("contact"),
        phones: (a: any) => a.relation([_.ContactPhones]).me("contact"),
      }),
      (_: any) => _.Address.name("Address").ref(true).properties({
        street1: S.OfStr, locality: S.OfStr, postal_code: S.OfStr, country_code: S.OfStr,
      }).adjacencies({contacts: (a: any) => a.relation([_.ContactAddresses]).me("address")}),
      (_: any) => _.Phone.name("Phone").ref(true).properties({number: S.OfStr}).adjacencies({
        contacts: (a: any) => a.relation([_.ContactPhones]).me("phone")}),
      (_: any) => _.ContactAddresses.name("ContactAddresses").links([
        (t: any) => t.name("contact"), (t: any) => t.name("address")]).properties({label: S.OfStr}),
      (_: any) => _.ContactPhones.name("ContactPhones").links([
        (t: any) => t.name("contact"), (t: any) => t.name("phone")]).properties({label: S.OfStr}),
    ])]))]);
}

function scalars(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("corpus.scalars/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({Bag: S.OfObject, Sample: S.OfObject, Holds: S.OfRelation})
    .spec([
      (_: any) => _.Bag.name("Bag").ref(true).properties({name: S.OfStr}).adjacencies({
        items: (a: any) => a.relation([_.Holds]).me("bag")}),
      (_: any) => _.Sample.name("Sample").ref(true).properties({
        label: S.OfStr, payload: S.OfBytes, count: S.OfInt, ratio: S.OfFloat, flag: S.OfBool,
      }).adjacencies({bags: (a: any) => a.relation([_.Holds]).me("item")}),
      (_: any) => _.Holds.name("Holds").links([(t: any) => t.name("bag"), (t: any) => t.name("item")]).properties({
        slot: S.OfInt}).uniques(["bag", "slot"]),
    ])]))]);
}

function family(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("corpus.family/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({Person: S.OfObject, Parentage: S.OfRelation, Mentorship: S.OfRelation})
    .spec([
      (_: any) => _.Person.name("Person").ref(true).properties({given_name: S.OfStr, birth_date: S.OfStr}).adjacencies({
        children: (a: any) => a.relation([_.Parentage]).me("parent"),
        parents: (a: any) => a.relation([_.Parentage]).me("child"),
        mentees: (a: any) => a.relation([_.Mentorship]).me("mentor"),
        mentors: (a: any) => a.relation([_.Mentorship]).me("mentee"),
      }),
      (_: any) => _.Parentage.name("Parentage").links([(t: any) => t.name("parent"), (t: any) => t.name("child")]).properties({
        kind: S.OfStr}),
      (_: any) => _.Mentorship.name("Mentorship").links([(t: any) => t.name("mentor"), (t: any) => t.name("mentee")]),
    ])]))]);
}

function enrollment(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("corpus.enrollment/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({Student: S.OfObject, Course: S.OfObject, Term: S.OfObject, Enrollment: S.OfRelation})
    .spec([
      (_: any) => _.Student.name("Student").ref(true).properties({name: S.OfStr}).adjacencies({
        enrollments: (a: any) => a.relation([_.Enrollment]).me("student")}),
      (_: any) => _.Course.name("Course").ref(true).properties({code: S.OfStr}).adjacencies({
        enrollments: (a: any) => a.relation([_.Enrollment]).me("course")}),
      (_: any) => _.Term.name("Term").ref(true).properties({code: S.OfStr, starts: S.OfStr}).adjacencies({
        enrollments: (a: any) => a.relation([_.Enrollment]).me("term")}),
      (_: any) => _.Enrollment.name("Enrollment").links([
        (t: any) => t.name("student"), (t: any) => t.name("course"), (t: any) => t.name("term"),
      ]).properties({credits: S.OfInt, score: S.OfFloat, audit: S.OfBool}),
    ])]))]);
}

function yamlStrings(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("corpus.yaml_strings/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({Notebook: S.OfObject, Note: S.OfObject, Pages: S.OfRelation})
    .spec([
      (_: any) => _.Notebook.name("Notebook").ref(true).properties({title: S.OfStr}).adjacencies({
        notes: (a: any) => a.relation([_.Pages]).me("notebook")}),
      (_: any) => _.Note.name("Note").ref(true).properties({text: S.OfStr}).adjacencies({
        notebooks: (a: any) => a.relation([_.Pages]).me("note")}),
      (_: any) => _.Pages.name("Pages").links([(t: any) => t.name("notebook"), (t: any) => t.name("note")]).properties({
        page: S.OfInt}),
    ])]))]);
}

/** Value objects (one with a container of its own), union values of objects and of scalars, and an intersection value. */
function embedded(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("corpus.embedded/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({CardPhone: S.OfObject, Card: S.OfObject, Holding: S.OfRelation, Deck: S.OfObject})
    .spec([
      (_: any) => _.CardPhone.name("CardPhone").properties({
        number: S.OfStr, label: S.OfStr,
        extensions: S.OfContainer((c: any) => c.index([S.OfInt]).element([S.OfStr])),
      }),
      (_: any) => _.Card.name("Card").ref(true).properties({
        name: S.OfStr,
        home: _.CardPhone,
        reach: S.OfUnion((n: any) => n.branches([
          (t: any) => t.name("phone").schema([_.CardPhone]),
          (t: any) => t.name("email").schema([S.OfObject((o: any) => o.properties({address: S.OfStr}))]),
        ])),
        ident: S.OfUnion((n: any) => n.branches([
          (t: any) => t.name("number").schema([S.OfInt]),
          (t: any) => t.name("code").schema([S.OfStr]),
        ])),
        meta: S.OfIntersection((i: any) => i.parts([
          (t: any) => t.name("stamp").schema([S.OfObject((o: any) => o.properties({updated: S.OfStr}))]),
          (t: any) => t.name("audit").schema([S.OfObject((o: any) => o.properties({by: S.OfStr, updated: S.OfStr}))]),
        ])),
      }).adjacencies({decks: (a: any) => a.relation([_.Holding]).me("card")}),
      (_: any) => _.Holding.name("Holding").links([(t: any) => t.name("deck"), (t: any) => t.name("card")]),
      (_: any) => _.Deck.name("Deck").ref(true).properties({title: S.OfStr}).adjacencies({
        cards: (a: any) => a.relation([_.Holding]).me("deck")}),
    ])]))]);
}

/** Containers, dense by position: of scalars, of containers, of union values and of value objects, which hold
 * containers of their own; a tensor by a pair of ints, sparse by an int, a dict by text, and entries by a float. */
function lists(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("corpus.lists/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({Socket: S.OfObject, Board: S.OfObject})
    .spec([
      (_: any) => _.Socket.name("Socket").properties({
        name: S.OfStr, pins: S.OfContainer((c: any) => c.index([S.OfInt]).element([S.OfStr]))}),
      (_: any) => _.Board.name("Board").ref(true).properties({
        name: S.OfStr,
        tags: S.OfContainer((c: any) => c.index([S.OfInt]).element([S.OfStr])),
        blobs: S.OfContainer((c: any) => c.index([S.OfInt]).element([S.OfBytes])),
        grid: S.OfContainer((c: any) => c.index([S.OfInt]).element([
          S.OfContainer((r: any) => r.index([S.OfInt]).element([S.OfInt]))])),
        readings: S.OfContainer((c: any) => c.index([S.OfInt]).element([S.OfUnion((n: any) => n.branches([
          (t: any) => t.name("value").schema([S.OfFloat]), (t: any) => t.name("note").schema([S.OfStr])]))])),
        sockets: S.OfContainer((c: any) => c.index([S.OfInt]).element([_.Socket])),
        banks: S.OfContainer((c: any) => c.index([S.OfInt]).element([S.OfObject((o: any) => o.properties({
          sockets: S.OfContainer((k: any) => k.index([S.OfInt]).element([_.Socket]))}))])),
        matrix: S.OfContainer((c: any) => c.index([S.OfObject((o: any) => o.properties({
          r: S.OfInt, c: S.OfInt}))]).element([S.OfInt])),
        cells: S.OfContainer((c: any) => c.index([S.OfInt]).element([S.OfInt]).layout("sparse")),
        attrs: S.OfContainer((c: any) => c.index([S.OfStr]).element([S.OfFloat])),
        weights: S.OfContainer((c: any) => c.index([S.OfFloat]).element([S.OfStr])),
      }),
    ])]))]);
}

/** The corpus's own schemas as data, beside the address book's, the family's, the embedded values' and the lists':
 * parametric schemas, whose parameters are names, a flat union and a flat intersection. */
function module(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("corpus.module/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({Grid: S.OfObject, Tricky: S.OfObject, Choice: S.OfUnion, Marked: S.OfIntersection})
    .spec([
      (_: any) => _.Grid.name("Grid").parameters([
        (t: any) => t.name("n").description("Its side"), (t: any) => t.name("x"),
      ]).properties({mask: S.OfInt, cells: S.OfContainer((c: any) => c.index([S.OfInt]).element([S.OfInt]))}),
      (_: any) => _.Tricky.name("Tricky").parameters([
        (t: any) => t.name("a"), (t: any) => t.name("b"), (t: any) => t.name("c"), (t: any) => t.name("d")]),
      (_: any) => _.Choice.name("Choice").flat(true).branches([
        (t: any) => t.name("n").schema([S.OfInt]), (t: any) => t.name("s").schema([S.OfStr])]),
      (_: any) => _.Marked.name("Marked").flat(true).parts([
        (t: any) => t.name("when").schema([S.OfObject((o: any) => o.properties({at: S.OfInt}))]),
        (t: any) => t.name("who").schema([S.OfObject((o: any) => o.properties({by: S.OfStr}))]),
      ]),
    ])]))]);
}

/** A pattern over the address book's schemas, with a variable, a constraint and a spec, and a collector of it with an
 * expression: recorded once the schemas it names are installed. */
function patterns(txn: any): any {
  const S = txn.Schemas;
  return txn.uid("corpus.patterns/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({Lives: S.OfPattern, Homes: S.OfCollector})
    .spec([
      (_: any) => _.Lives.name("Lives").description("Who lives where").symbols([
        (t: any) => t.name("who").schema([txn.Contact]),
        (t: any) => t.name("where").schema([txn.Address]).description("A home"),
      ]).variables([
        (t: any) => t.name("since").schema([S.OfStr]),
      ]).requires([
        (c: any) => c.description("lived there since").result([S.OfBool]),
      ]).parameters([
        (t: any) => t.name("era"),
      ]).spec([
        (_: any) => _.who.addresses({home: _.where}),
        (_: any) => _.where.locality("London"),
      ]),
      (_: any) => _.Homes.name("Homes").pattern([_.Lives]).symbols(["where"]).commutative(true).associative(true)
      .suffixes({current: "_here", next: "_there"})
      .computes([S.OfExpression((e: any) => e.pattern([_.Lives]).result([S.OfInt]))]),
    ])]))]);
}


// --- The cases ---

/** The corpus: each case's store, and the data built in it. */
export function build(): Map<string, [B.Store, unknown[]]> {
  const cases = new Map<string, [B.Store, unknown[]]>();

  let s: any = new B.Store();
  s.transaction(addressBook);
  s.transaction(rooted);
  s.transaction(() => { // the case's data, one transaction
    const home = s.Address((a: any) => a.street1("10 Downing Street").locality("London").postal_code("SW1A 2AA").country_code("GB"));
    const alice = s.Contact((c: any) => (
      c.given_name("Alice").family_name("Liddell").birth_date("1852-05-04")
        .addresses((a: any) => a.insert((x: any) => x.address(home).label("home")))
        .phones((a: any) => a.insert((x: any) => x.phone((p: any) => p.number("+447700900123")).label("mobile")))
        .phones((a: any) => a.insert((x: any) => x.phone((p: any) => p.number("+14155550100")).label("work")))));
    const bob = s.Contact((c: any) => c.given_name("Bob").addresses((a: any) => a.insert((x: any) => x.address(home).label("home"))));
    hold(s, [home, alice, bob]);
    cases.set("address_book", [s, [home, alice, bob]]);
  });

  s = new B.Store();
  s.transaction(scalars);
  s.transaction(rooted);
  s.transaction(() => { // the case's data, one transaction
    const all = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
    const samples: Record<string, unknown>[] = [
      { label: "", payload: new Uint8Array(), count: 0n, ratio: 0.0, flag: false },
      { label: "日本語 🚀", payload: all, count: 2n ** 100n, ratio: -0.0, flag: true },
      { label: '\x00\x1f\x7f "q" \\ \n\t\r', payload: new Uint8Array([0]), count: -(2n ** 70n), ratio: 5e-324 },
      { label: "non-finite", ratio: NaN },
      { label: "+inf", ratio: Infinity },
      { label: "-inf", ratio: -Infinity },
      { label: "big", ratio: 1e16, count: 2n ** 63n },
      { label: "small", ratio: 0.1 },
      { label: "max", ratio: 1e308 },
      { label: "two", ratio: 2.0 },
    ];
    const bag = s.Bag((b: any) => b.name("edges"));
    const items: unknown[] = [];
    samples.forEach((values, slot) => {
      const item = s.Sample((b: any) => Object.entries(values).map(([name, value]) => b[name](value)));
      items.push(item);
      s.Bag(bag, (b: any) => b.items((a: any) => a.insert((x: any) => x.item(item).slot(BigInt(slot)))));
    });
    hold(s, [bag, ...items]);
    cases.set("scalars", [s, [bag, ...items]]);
  });

  s = new B.Store();
  s.transaction(family);
  s.transaction(rooted);
  s.transaction(() => { // the case's data, one transaction
    const ada = s.Person((p: any) => p.given_name("Ada").birth_date("1815-12-10"));
    const bob = s.Person((p: any) => p.given_name("Bob").parents((a: any) => a.insert((x: any) => x.parent(ada).kind("biological"))));
    const carol = s.Person((p: any) => p.given_name("Carol").children((a: any) => a.insert(
      (x: any) => x.child((y: any) => y.given_name("Dan").birth_date("2001-02-03")).kind("adoptive"))));
    s.Person(ada, (p: any) => p.mentees((a: any) => a.insert((x: any) => x.mentee(bob))));
    s.Person(carol, (p: any) => p.mentees((a: any) => a.insert((x: any) => x.mentee(carol))));
    s.Person(bob, (p: any) => p.mentees((a: any) => a.insert((x: any) => x.mentee(ada))));
    hold(s, [ada, bob, carol]);
    cases.set("family", [s, [ada, bob, carol]]);
  });

  s = new B.Store();
  s.transaction(enrollment);
  s.transaction(rooted);
  s.transaction(() => { // the case's data, one transaction
    const fall = s.Term((t: any) => t.code("2026-FA").starts("2026-09-01"));
    const cs101 = s.Course((c: any) => c.code("CS101"));
    const mia = s.Student((st: any) => (
      st.name("Mia")
        .enrollments((a: any) => a.insert((x: any) => x.course(cs101).term(fall).credits(4n).score(3.75).audit(false)))
        .enrollments((a: any) => a.insert((x: any) => x.course((c: any) => c.code("MA201")).term(fall).credits(3n).score(-0.0)))));
    const noah = s.Student((st: any) => st.name("Noah").enrollments((a: any) => a.insert((x: any) => x.course(cs101).term(fall).audit(true))));
    hold(s, [fall, cs101, mia, noah]);
    cases.set("enrollment", [s, [fall, cs101, mia, noah]]);
  });

  s = new B.Store();
  s.transaction(yamlStrings);
  s.transaction(rooted);
  s.transaction(() => { // the case's data, one transaction
    const tricky = ["yes", "No", "on", "OFF", "y", "true", "null", "~", "", "010", "0o17", "0x1F", "1e3", "1_000", "1:30",
      "2026-09-01", ".inf", ".nan", "NaN", "Infinity", "-0.0", "+1", " lead", "trail ", "a: b", "- dash",
      "#hash", "x #y", '"dq"', "'sq'", "@at", "`tick", "%pct", "!bang", "&amp", "*star", "|", ">", "{}", "[]",
      ",", "?", "<<", "---", "...", "a\nb", "\t", "\x00", "\x07\x7f\x9b", "﻿bom", "a\x85b", "a b",
      "日本語 🚀", "word ".repeat(30)];
    const notebook = s.Notebook((n: any) => n.title("tricky"));
    const notes: unknown[] = [];
    tricky.forEach((value, page) => {
      const note = s.Note((n: any) => n.text(value));
      notes.push(note);
      s.Notebook(notebook, (n: any) => n.notes((a: any) => a.insert((x: any) => x.note(note).page(BigInt(page)))));
    });
    hold(s, [notebook, ...notes]);
    cases.set("yaml_strings", [s, [notebook, ...notes]]);
  });

  s = new B.Store();
  s.transaction(embedded);
  s.transaction(rooted);
  s.transaction(() => { // the case's data, one transaction
    const deck = s.Deck((d: any) => d.title("contacts"));
    const cards = [
      s.Card((c: any) => c.name("Ann").home((p: any) => p.as_object((r: any) => r.number("+1 555 0100").label("home").extensions(
        put([[0n, "12"]])))).reach((p: any) => p.as_value((a: any) => a.as_union((u: any) => u.email(
        (r: any) => r.address("ann@example.com"))))).ident((p: any) => p.as_value((a: any) => a.as_union((u: any) => u.number(7n))))),
      s.Card((c: any) => c.name("Bo").reach((p: any) => p.as_value((a: any) => a.as_union((u: any) => u.phone(
        (r: any) => r.number("+44 20 7946 0000"))))).ident((p: any) => p.as_value((a: any) => a.as_union((u: any) => u.code("B-2"))))
        .meta((p: any) => p.as_value((a: any) => a.as_intersection((i: any) => i.stamp((r: any) => r.updated("2026-09-29")).audit(
          (r: any) => r.updated("2026-09-29").by("ann")))))),
      s.Card((c: any) => c.name("Cy")),
    ];
    for (const card of cards) s.Deck(deck, (d: any) => d.cards((a: any) => a.insert((x: any) => x.card(card))));
    hold(s, [deck, ...cards]);
    cases.set("embedded", [s, [deck, ...cards]]);
  });

  s = new B.Store();
  s.transaction(lists);
  s.transaction(rooted);
  s.transaction(() => { // the case's data, one transaction
    const board = s.Board((r: any) => (
      r.name("rack").tags(put(enumerate(["", "日本語 🚀", "a"]))).blobs(put(enumerate([new Uint8Array(), new Uint8Array([0, 255])])))
        .grid(put(enumerate([[1n, -(2n ** 70n)], [], [0n]]).map(([i, row]) => [i, (e: any) => e.as_container(write(enumerate(row as bigint[])))])))
        .readings(put([[0n, (e: any) => e.as_union((u: any) => u.value(-0.0))], [1n, (e: any) => e.as_union((u: any) => u.note("off"))],
          [2n, (e: any) => e.as_union((u: any) => u.value(Infinity))]]))
        .sockets(put([[0n, (e: any) => e.as_object((o: any) => o.name("in").pins(put([[0n, "1"], [1n, "2"]])))],
          [1n, (e: any) => e.as_object((o: any) => o.name("out"))]]))
        .banks(put([[0n, (e: any) => e.as_object((b: any) => b)], [1n, (e: any) => e.as_object((b: any) => b.sockets(put(
          [[0n, (x: any) => x.as_object((o: any) => o.name("spare").pins(put([[0n, "9"]])))]])))]]))
        .matrix(put([[[2n, 1n], 0n], [[1n, 1n], 1n], [[1n, 2n], 0n], [[2n, 2n], 1n]]))
        .cells(put([[5n, 6n], [6n, 7n], [0n, 0n]]))
        .attrs(put([["gain", 1.5], ["", -0.0]]))
        .weights(put([[0.5, "half"], [-2.5, "neg"]]))));
    hold(s, [board]);
    cases.set("lists", [s, [board]]);
  });

  s = new B.Store();
  for (const install of [addressBook, family, embedded, lists, module, patterns, rooted]) s.transaction(install);
  s.transaction(() => { // the case's data, none but its root's
    hold(s, []);
  });
  cases.set("module", [s, []]);
  return cases;
}
