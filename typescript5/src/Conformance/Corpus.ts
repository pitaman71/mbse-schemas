/**
 * The conformance corpus: the same cases, built statement for statement in every implementation.
 *
 * `build()` returns `{case: [store, objects]}`: each case built in a store of its own, its schemas and its data, written
 * as a log of mutations, the store's initial snapshot (docs/SERIALIZATION.md); `objects` holds the case's data, which a
 * store holds weakly. Each implementation writes its logs to `conformance/<implementation>/<case>.json` and `.yaml`, and
 * checks them against every other implementation's files (see the CONF test suite). Keep this module and
 * `python3/mbse/Schemas/Conformance/Corpus.py` in lockstep: same schemas, same names, same values, same order of
 * statements.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Builders as B, Schemas } from "../Framework/index.js";

export const CASES = ["address_book", "scalars", "family", "enrollment", "yaml_strings", "embedded", "lists", "module"] as const;

/** The basic scalars of the store `s`, each its own: bool, int, float, str and bytes. */
function basics(s: any): [unknown, unknown, unknown, unknown, unknown] {
  return [s.Schemas.OfBool, s.Schemas.OfInt, s.Schemas.OfFloat, s.Schemas.OfStr, s.Schemas.OfBytes];
}

function text(s: any, name: string, scalar: unknown = null) {
  return (t: any) => t.name(name).schema([scalar !== null ? scalar : s.Schemas.OfStr]);
}

/** A property `name` holding a container of `element` by `index`: dense by position, by default. */
function list(store: any, name: string, element: unknown, index: unknown = null, layout: string | null = null) {
  const container = (c: any) => {
    c.index([index !== null ? index : store.Schemas.OfInt]).element([element]);
    return layout !== null ? c.layout(layout) : c;
  };
  return (t: any) => t.name(name).schema([store.Schemas.OfContainer(container)]);
}

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

/** The case's root, a singleton holding its data: a store's snapshot holds what its singletons reach. */
function rooted(s: any, objects: unknown[]): void {
  const Holds = s.Schemas.OfRelation((r: any) => r.name("Corpus.Holds").links([(t: any) => t.name("corpus"), (t: any) => t.name("item")]));
  s.Schemas.OfObject((o: any) => o.name("Corpus.Root").ref(true).singleton("corpus").adjacencies([
    (t: any) => t.name("holds").relation([Holds]).me("corpus"),
  ]));
  const hold = (adjacency: any): any => {
    for (const item of objects) adjacency.insert((e: any) => e.item(item));
    return adjacency;
  };
  s.Corpus.Root(s.singleton("corpus"), (r: any) => r.holds(hold));
}

// --- Schemas, each group built in the store given ---

function addressBook(s: any): [any, any, any] {
  const Contact = s.Schemas.OfObject((o: any) => o.name("Contact").ref(true).properties([
    text(s, "given_name"), text(s, "family_name"), text(s, "birth_date")]));
  const Address = s.Schemas.OfObject((o: any) => o.name("Address").ref(true).properties([
    text(s, "street1"), text(s, "locality"), text(s, "postal_code"), text(s, "country_code")]));
  const Phone = s.Schemas.OfObject((o: any) => o.name("Phone").ref(true).properties([text(s, "number")]));
  const ContactAddresses = s.Schemas.OfRelation((r: any) => r.name("ContactAddresses").links([
    (t: any) => t.name("contact"), (t: any) => t.name("address")]).properties([text(s, "label")]));
  const ContactPhones = s.Schemas.OfRelation((r: any) => r.name("ContactPhones").links([
    (t: any) => t.name("contact"), (t: any) => t.name("phone")]).properties([text(s, "label")]));
  s.Schemas.OfObject(Contact, (o: any) => o.adjacencies([
    (t: any) => t.name("addresses").relation([ContactAddresses]).me("contact"),
    (t: any) => t.name("phones").relation([ContactPhones]).me("contact")]));
  s.Schemas.OfObject(Address, (o: any) => o.adjacencies([(t: any) => t.name("contacts").relation([ContactAddresses]).me("address")]));
  s.Schemas.OfObject(Phone, (o: any) => o.adjacencies([(t: any) => t.name("contacts").relation([ContactPhones]).me("phone")]));
  return [Contact, Address, ContactAddresses];
}

function scalars(s: any): void {
  const [Bool, Int, Float, Str, Bytes] = basics(s);
  const Bag = s.Schemas.OfObject((o: any) => o.name("Bag").ref(true).properties([text(s, "name")]));
  const Sample = s.Schemas.OfObject((o: any) => o.name("Sample").ref(true).properties([
    text(s, "label"), text(s, "payload", Bytes), text(s, "count", Int), text(s, "ratio", Float), text(s, "flag", Bool)]));
  const Holds = s.Schemas.OfRelation((r: any) => r.name("Holds").links([(t: any) => t.name("bag"), (t: any) => t.name("item")])
    .properties([text(s, "slot", Int)]).uniques(["bag", "slot"]));
  s.Schemas.OfObject(Bag, (o: any) => o.adjacencies([(t: any) => t.name("items").relation([Holds]).me("bag")]));
  s.Schemas.OfObject(Sample, (o: any) => o.adjacencies([(t: any) => t.name("bags").relation([Holds]).me("item")]));
}

function family(s: any): [any, any] {
  const Person = s.Schemas.OfObject((o: any) => o.name("Person").ref(true).properties([
    text(s, "given_name"), text(s, "birth_date")]));
  const Parentage = s.Schemas.OfRelation((r: any) => r.name("Parentage").links([(t: any) => t.name("parent"), (t: any) => t.name("child")])
    .properties([text(s, "kind")]));
  const Mentorship = s.Schemas.OfRelation((r: any) => r.name("Mentorship").links([(t: any) => t.name("mentor"), (t: any) => t.name("mentee")]));
  s.Schemas.OfObject(Person, (o: any) => o.adjacencies([
    (t: any) => t.name("children").relation([Parentage]).me("parent"),
    (t: any) => t.name("parents").relation([Parentage]).me("child"),
    (t: any) => t.name("mentees").relation([Mentorship]).me("mentor"),
    (t: any) => t.name("mentors").relation([Mentorship]).me("mentee")]));
  return [Person, Parentage];
}

function enrollment(s: any): void {
  const [Bool, Int, Float, Str, Bytes] = basics(s);
  const Student = s.Schemas.OfObject((o: any) => o.name("Student").ref(true).properties([text(s, "name")]));
  const Course = s.Schemas.OfObject((o: any) => o.name("Course").ref(true).properties([text(s, "code")]));
  const Term = s.Schemas.OfObject((o: any) => o.name("Term").ref(true).properties([
    text(s, "code"), text(s, "starts")]));
  const Enrollment = s.Schemas.OfRelation((r: any) => r.name("Enrollment").links([
    (t: any) => t.name("student"), (t: any) => t.name("course"), (t: any) => t.name("term")]).properties([
    text(s, "credits", Int), text(s, "score", Float), text(s, "audit", Bool)]));
  s.Schemas.OfObject(Student, (o: any) => o.adjacencies([(t: any) => t.name("enrollments").relation([Enrollment]).me("student")]));
  s.Schemas.OfObject(Course, (o: any) => o.adjacencies([(t: any) => t.name("enrollments").relation([Enrollment]).me("course")]));
  s.Schemas.OfObject(Term, (o: any) => o.adjacencies([(t: any) => t.name("enrollments").relation([Enrollment]).me("term")]));
}

function yamlStrings(s: any): void {
  const [Bool, Int, Float, Str, Bytes] = basics(s);
  const Notebook = s.Schemas.OfObject((o: any) => o.name("Notebook").ref(true).properties([text(s, "title")]));
  const Note = s.Schemas.OfObject((o: any) => o.name("Note").ref(true).properties([text(s, "text")]));
  const Pages = s.Schemas.OfRelation((r: any) => r.name("Pages").links([(t: any) => t.name("notebook"), (t: any) => t.name("note")])
    .properties([text(s, "page", Int)]));
  s.Schemas.OfObject(Notebook, (o: any) => o.adjacencies([(t: any) => t.name("notes").relation([Pages]).me("notebook")]));
  s.Schemas.OfObject(Note, (o: any) => o.adjacencies([(t: any) => t.name("notebooks").relation([Pages]).me("note")]));
}

/** Value objects (one with a container of its own), union values of objects and of scalars, and an intersection
 * value. */
function embedded(s: any): [any, any, any] {
  const [Bool, Int, Float, Str, Bytes] = basics(s);
  const CardPhone = s.Schemas.OfObject((o: any) => o.properties([text(s, "number"), text(s, "label"), list(s, "extensions", Str)]));
  const CardEmail = s.Schemas.OfObject((o: any) => o.properties([text(s, "address")]));
  const Reach = s.Schemas.OfUnion((u: any) => u.branches([(t: any) => t.name("phone").schema([CardPhone]),
    (t: any) => t.name("email").schema([CardEmail])]));
  const Ident = s.Schemas.OfUnion((u: any) => u.branches([(t: any) => t.name("number").schema([Int]),
    (t: any) => t.name("code").schema([Str])]));
  const CardStamp = s.Schemas.OfObject((o: any) => o.properties([text(s, "updated")]));
  const CardAudit = s.Schemas.OfObject((o: any) => o.properties([text(s, "by"), text(s, "updated")]));
  const CardMeta = s.Schemas.OfIntersection((i: any) => i.parts([(t: any) => t.name("stamp").schema([CardStamp]),
    (t: any) => t.name("audit").schema([CardAudit])]));
  const Card = s.Schemas.OfObject((o: any) => o.name("Card").ref(true).properties([
    text(s, "name"), (t: any) => t.name("home").schema([CardPhone]), (t: any) => t.name("reach").schema([Reach]),
    (t: any) => t.name("ident").schema([Ident]), (t: any) => t.name("meta").schema([CardMeta])]));
  const Holding = s.Schemas.OfRelation((r: any) => r.name("Holding").links([(t: any) => t.name("deck"), (t: any) => t.name("card")]));
  const Deck = s.Schemas.OfObject((o: any) => o.name("Deck").ref(true).properties([text(s, "title")])
    .adjacencies([(t: any) => t.name("cards").relation([Holding]).me("deck")]));
  s.Schemas.OfObject(Card, (o: any) => o.adjacencies([(t: any) => t.name("decks").relation([Holding]).me("card")]));
  return [Card, Deck, Holding];
}

/** Containers, dense by position: of scalars, of containers, of union values and of value objects, which hold
 * containers of their own; a tensor by a pair of ints, sparse by an int, a dict by text, and entries by a float. */
function lists(s: any): any {
  const [Bool, Int, Float, Str, Bytes] = basics(s);
  const Socket = s.Schemas.OfObject((o: any) => o.properties([text(s, "name"), list(s, "pins", Str)]));
  const Coord = s.Schemas.OfObject((o: any) => o.properties([text(s, "r", Int), text(s, "c", Int)]));
  const Reading = s.Schemas.OfUnion((u: any) => u.branches([(t: any) => t.name("value").schema([Float]),
    (t: any) => t.name("note").schema([Str])]));
  const Row = s.Schemas.OfContainer((c: any) => c.index([Int]).element([Int]));
  const Bank = s.Schemas.OfObject((o: any) => o.properties([list(s, "sockets", Socket)]));
  return s.Schemas.OfObject((o: any) => o.name("Board").ref(true).properties([
    text(s, "name"), list(s, "tags", Str), list(s, "blobs", Bytes), list(s, "grid", Row),
    list(s, "readings", Reading), list(s, "sockets", Socket), list(s, "banks", Bank), list(s, "matrix", Int, Coord),
    list(s, "cells", Int, Int, "sparse"), list(s, "attrs", Float, Str), list(s, "weights", Str, Float)]));
}

/** The corpus's own schemas as data, with parametric schemas, whose parameters are names, and a pattern, with a variable
 * and a constraint, an expression and a collector. */
function module(s: any): void {
  const [Bool, Int, Float, Str, Bytes] = basics(s);
  const [Contact, Address] = addressBook(s);
  family(s);
  embedded(s);
  lists(s);
  s.Schemas.OfObject((o: any) => o.name("Grid").parameters([
    (t: any) => t.name("n").description("Its side"), (t: any) => t.name("x")]).properties([
    (t: any) => t.name("mask").schema([Int]), list(s, "cells", Int)]));
  s.Schemas.OfObject((o: any) => o.name("Tricky").parameters([..."abcd"].map((x) => (t: any) => t.name(x))));
  s.Schemas.OfUnion((u: any) => u.name("Choice").flat(true).branches([
    (t: any) => t.name("n").schema([Int]), (t: any) => t.name("s").schema([Str])]));
  s.Schemas.OfIntersection((i: any) => i.name("Marked").flat(true).parts([
    (t: any) => t.name("when").schema([s.Schemas.OfObject((o: any) => o.properties([text(s, "at", Int)]))]),
    (t: any) => t.name("who").schema([s.Schemas.OfObject((o: any) => o.properties([text(s, "by")]))])]));
  const Lives = s.Schemas.OfPattern((p: any) => p.name("Lives").description("Who lives where").symbols([
    (t: any) => t.name("who").schema([Contact]),
    (t: any) => t.name("where").schema([Address]).description("A home")])
    .variables([(t: any) => t.name("since").schema([Str])])
    .requires([(c: any) => c.description("lived there since")])
    .parameters([(t: any) => t.name("era")]));
  s.Schemas.OfCollector((c: any) => c.name("Homes").pattern([Lives]).symbols(["where"]).commutative(true).associative(true)
    .suffixes({ current: "_here", next: "_there" })
    .computes([s.Schemas.OfExpression((e: any) => e.pattern([Lives]).result([Int]))]));
}

// --- The cases ---

/** The corpus: each case's store, and the data built in it. */
export function build(): Map<string, [B.Store, unknown[]]> {
  const cases = new Map<string, [B.Store, unknown[]]>();

  let s: any = new B.Store();
  addressBook(s);
  const home = s.Address((a: any) => a.street1("10 Downing Street").locality("London").postal_code("SW1A 2AA").country_code("GB"));
  const alice = s.Contact((c: any) => (
    c.given_name("Alice").family_name("Liddell").birth_date("1852-05-04")
      .addresses((a: any) => a.insert((x: any) => x.address(home).label("home")))
      .phones((a: any) => a.insert((x: any) => x.phone((p: any) => p.number("+447700900123")).label("mobile")))
      .phones((a: any) => a.insert((x: any) => x.phone((p: any) => p.number("+14155550100")).label("work")))));
  let bob = s.Contact((c: any) => c.given_name("Bob").addresses((a: any) => a.insert((x: any) => x.address(home).label("home"))));
  rooted(s, [home, alice, bob]);
  cases.set("address_book", [s, [home, alice, bob]]);

  s = new B.Store();
  scalars(s);
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
  rooted(s, [bag, ...items]);
  cases.set("scalars", [s, [bag, ...items]]);

  s = new B.Store();
  family(s);
  const ada = s.Person((p: any) => p.given_name("Ada").birth_date("1815-12-10"));
  bob = s.Person((p: any) => p.given_name("Bob").parents((a: any) => a.insert((x: any) => x.parent(ada).kind("biological"))));
  const carol = s.Person((p: any) => p.given_name("Carol").children((a: any) => a.insert(
    (x: any) => x.child((y: any) => y.given_name("Dan").birth_date("2001-02-03")).kind("adoptive"))));
  s.Person(ada, (p: any) => p.mentees((a: any) => a.insert((x: any) => x.mentee(bob))));
  s.Person(carol, (p: any) => p.mentees((a: any) => a.insert((x: any) => x.mentee(carol))));
  s.Person(bob, (p: any) => p.mentees((a: any) => a.insert((x: any) => x.mentee(ada))));
  rooted(s, [ada, bob, carol]);
  cases.set("family", [s, [ada, bob, carol]]);

  s = new B.Store();
  enrollment(s);
  const fall = s.Term((t: any) => t.code("2026-FA").starts("2026-09-01"));
  const cs101 = s.Course((c: any) => c.code("CS101"));
  const mia = s.Student((st: any) => (
    st.name("Mia")
      .enrollments((a: any) => a.insert((x: any) => x.course(cs101).term(fall).credits(4n).score(3.75).audit(false)))
      .enrollments((a: any) => a.insert((x: any) => x.course((c: any) => c.code("MA201")).term(fall).credits(3n).score(-0.0)))));
  const noah = s.Student((st: any) => st.name("Noah").enrollments((a: any) => a.insert((x: any) => x.course(cs101).term(fall).audit(true))));
  rooted(s, [fall, cs101, mia, noah]);
  cases.set("enrollment", [s, [fall, cs101, mia, noah]]);

  s = new B.Store();
  yamlStrings(s);
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
  rooted(s, [notebook, ...notes]);
  cases.set("yaml_strings", [s, [notebook, ...notes]]);

  s = new B.Store();
  embedded(s);
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
  rooted(s, [deck, ...cards]);
  cases.set("embedded", [s, [deck, ...cards]]);

  s = new B.Store();
  lists(s);
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
  rooted(s, [board]);
  cases.set("lists", [s, [board]]);

  s = new B.Store();
  module(s);
  rooted(s, []);
  cases.set("module", [s, []]);
  return cases;
}
