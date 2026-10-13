/**
 * The conformance corpus: the same cases, built statement for statement in every implementation.
 *
 * `build()` registers the corpus schemas and returns `{case: [root schema, root object, store]}`, each case's store the
 * one its root belongs to. Each implementation writes
 * its snapshots to `conformance/<implementation>/<case>.json` and `.yaml`, and checks them against every other
 * implementation's files (see the CONF test suite). Keep this module and `python3/mbse/Schemas/Conformance/Corpus.py` in
 * lockstep: same schemas, same names, same values, same order of statements.
 */

import { Modules, Proxies, Schemas, Stores } from "../Framework/index.js";
import type { Instance } from "../Framework/Proxies.js";

export const CASES = ["address_book", "scalars", "family", "enrollment", "yaml_strings", "embedded", "lists", "module"] as const;

function text(name: string, scalar: unknown = String) {
  return (prop: Schemas.OfProperty.Builder) => prop.name(name).of((t) => t.as_scalar(scalar as never));
}

/** An adjacency `name` to a one-link relation of its own, whose entries hold `properties`: a list, or keyed where
 * `unique` names the values its other properties determine. */
function list(name: string, properties: Schemas.OfProperty.Spec[], unique: string[] = []) {
  return (a: Schemas.OfAdjacency.Builder) => a.name(name).me("owner").of((rel: Schemas.OfRelation.Builder) => {
    rel.links("owner").properties(...properties);
    return unique.length > 0 ? rel.unique(...unique) : rel;
  });
}

function held(name: string, spec: Schemas.OfAny.Spec) {
  return (prop: Schemas.OfProperty.Builder) => prop.name(name).of(spec);
}

/** A Spec adding an entry to the adjacency `name` for each of `values`, each a Spec of the entry. */
function entries(name: string, values: ((e: any) => unknown)[]) {
  return (builder: any) => {
    for (const value of values) builder[name](value);
    return builder;
  };
}

export function build(): Map<string, [Schemas.OfObject.Data, Instance, Stores.Store]> {
  const S = Schemas;
  const store = new Proxies.OfStore();

  // --- address_book ---
  const Contact = new S.OfObject.Builder().name("Contact").ref().properties(text("given_name"), text("family_name"), text("birth_date")).create();
  const Address = new S.OfObject.Builder().name("Address").ref().properties(text("street1"), text("locality"), text("postal_code"),
    text("country_code")).create();
  const Phone = new S.OfObject.Builder().name("Phone").ref().properties(text("number")).create();
  const ContactAddresses = new S.OfRelation.Builder().name("ContactAddresses").links("contact", "address").properties(text("label")).create();
  const ContactPhones = new S.OfRelation.Builder().name("ContactPhones").links("contact", "phone").properties(text("label")).create();
  new S.OfObject.Builder(Contact).relations((a) => a.name("addresses").of(ContactAddresses).me("contact"),
    (a) => a.name("phones").of(ContactPhones).me("contact")).update();
  new S.OfObject.Builder(Address).relations((a) => a.name("contacts").of(ContactAddresses).me("address")).update();
  new S.OfObject.Builder(Phone).relations((a) => a.name("contacts").of(ContactPhones).me("phone")).update();

  // --- scalars ---
  const Bag = new S.OfObject.Builder().name("Bag").ref().properties(text("name")).create();
  const Sample = new S.OfObject.Builder().name("Sample").ref().properties(text("label"), text("payload", Uint8Array), text("count", BigInt),
    text("ratio", Number), text("flag", Boolean)).create();
  const Holds = new S.OfRelation.Builder().name("Holds").links("bag", "item").properties(text("slot", BigInt)).unique("bag", "slot").create();
  new S.OfObject.Builder(Bag).relations((a) => a.name("items").of(Holds).me("bag")).update();
  new S.OfObject.Builder(Sample).relations((a) => a.name("bags").of(Holds).me("item")).update();

  // --- family ---
  const Person = new S.OfObject.Builder().name("Person").ref().properties(text("given_name"), text("birth_date")).create();
  const Parentage = new S.OfRelation.Builder().name("Parentage").links("parent", "child").properties(text("kind")).create();
  const Mentorship = new S.OfRelation.Builder().name("Mentorship").links("mentor", "mentee").create();
  new S.OfObject.Builder(Person).relations((a) => a.name("children").of(Parentage).me("parent"),
    (a) => a.name("parents").of(Parentage).me("child"),
    (a) => a.name("mentees").of(Mentorship).me("mentor"),
    (a) => a.name("mentors").of(Mentorship).me("mentee")).update();

  // --- enrollment ---
  const Student = new S.OfObject.Builder().name("Student").ref().properties(text("name")).create();
  const Course = new S.OfObject.Builder().name("Course").ref().properties(text("code")).create();
  const Term = new S.OfObject.Builder().name("Term").ref().properties(text("code"), text("starts")).create();
  const Enrollment = new S.OfRelation.Builder().name("Enrollment").links("student", "course", "term")
    .properties(text("credits", BigInt), text("score", Number), text("audit", Boolean)).create();
  new S.OfObject.Builder(Student).relations((a) => a.name("enrollments").of(Enrollment).me("student")).update();
  new S.OfObject.Builder(Course).relations((a) => a.name("enrollments").of(Enrollment).me("course")).update();
  new S.OfObject.Builder(Term).relations((a) => a.name("enrollments").of(Enrollment).me("term")).update();

  // --- yaml_strings ---
  const Notebook = new S.OfObject.Builder().name("Notebook").ref().properties(text("title")).create();
  const Note = new S.OfObject.Builder().name("Note").ref().properties(text("text")).create();
  const Pages = new S.OfRelation.Builder().name("Pages").links("notebook", "note").properties(text("page", BigInt)).create();
  new S.OfObject.Builder(Notebook).relations((a) => a.name("notes").of(Pages).me("notebook")).update();
  new S.OfObject.Builder(Note).relations((a) => a.name("notebooks").of(Pages).me("note")).update();

  // --- embedded: value objects (one with a list of its own), union values of objects and of scalars, and an
  // intersection value ---
  const CardPhone = new Schemas.OfObject.Builder().properties(text("number"), text("label")).relations(
    list("extensions", [text("value")])).create();
  const CardEmail = new Schemas.OfObject.Builder().properties(text("address")).create();
  const Reach = new Schemas.OfUnion.Builder().branches((b) => b.name("phone").of(CardPhone),
    (b) => b.name("email").of(CardEmail)).create();
  const Ident = new Schemas.OfUnion.Builder().branches((b) => b.name("number").of((t) => t.as_scalar(BigInt)),
    (b) => b.name("code").of((t) => t.as_scalar(String))).create();
  const CardStamp = new Schemas.OfObject.Builder().properties(text("updated")).create();
  const CardAudit = new Schemas.OfObject.Builder().properties(text("by"), text("updated")).create();
  const CardMeta = new Schemas.OfIntersection.Builder().parts((p) => p.name("stamp").of(CardStamp),
    (p) => p.name("audit").of(CardAudit)).create();
  const Card = new Schemas.OfObject.Builder().name("Card").ref().properties(text("name"), (p) => p.name("home").of(CardPhone),
    (p) => p.name("reach").of(Reach), (p) => p.name("ident").of(Ident), (p) => p.name("meta").of(CardMeta)).create();
  const Holding = new Schemas.OfRelation.Builder().name("Holding").links("deck", "card").create();
  const Deck = new Schemas.OfObject.Builder().name("Deck").ref().properties(text("title")).relations((a) => a.name("cards").of(Holding).me("deck")).create();
  new Schemas.OfObject.Builder(Card).relations((a) => a.name("decks").of(Holding).me("card")).update();

  // --- lists: one-link relations, open (lists) or keyed by what a `unique` clause leaves out: of scalars, of lists,
  // of union values and of value objects, which have lists of their own; keyed by text, by a float, by a value object
  // and by a pair of ints ---
  const Socket = new Schemas.OfObject.Builder().properties(text("name")).relations(list("pins", [text("value")])).create();
  const Coord = new Schemas.OfObject.Builder().properties(text("r", BigInt), text("c", BigInt)).create();
  const Reading = new Schemas.OfUnion.Builder().branches((b) => b.name("value").of((t) => t.as_scalar(Number)),
    (b) => b.name("note").of((t) => t.as_scalar(String))).create();
  const Row = new Schemas.OfObject.Builder().relations(list("values", [text("value", BigInt)])).create();
  const Bank = new Schemas.OfObject.Builder().relations(list("sockets", [held("socket", Socket)])).create();
  const Board = new Schemas.OfObject.Builder().name("Board").ref().properties(text("name")).relations(
    list("tags", [text("value")]), list("blobs", [text("value", Uint8Array)]), list("grid", [held("row", Row)]),
    list("readings", [held("reading", Reading)]), list("sockets", [held("socket", Socket)]),
    list("banks", [held("bank", Bank)]),
    list("matrix", [text("i", BigInt), text("j", BigInt), text("value", BigInt)], ["value"]),
    list("attrs", [text("key"), text("value", Number)], ["value"]),
    list("weights", [text("key", Number), text("value")], ["value"]),
    list("cells", [held("key", Coord), text("value", BigInt)], ["value"])).create();

  for (const schema of [Contact, Address, Phone, ContactAddresses, ContactPhones, Bag, Sample, Holds, Person, Parentage, Mentorship, Student, Course, Term, Enrollment, Notebook, Note, Pages, Card, Deck, Holding, Board]) {
    store.register(schema);
  }
  const B = store;

  const home = B.Address().street1("10 Downing Street").locality("London").postal_code("SW1A 2AA").country_code("GB").create();
  const alice = B.Contact().given_name("Alice").family_name("Liddell").birth_date("1852-05-04")
    .addresses((x: any) => x.address(home).label("home"))
    .phones((x: any) => x.phone((p: any) => p.number("+447700900123")).label("mobile"))
    .phones((x: any) => x.phone((p: any) => p.number("+14155550100")).label("work"))
    .create();
  B.Contact().given_name("Bob").addresses((x: any) => x.address(home).label("home")).create();

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
  const bag = B.Bag().name("edges").create();
  samples.forEach((values, slot) => {
    const builder = B.Sample();
    for (const [name, value] of Object.entries(values)) builder[name](value);
    const item = builder.create();
    B.Bag(bag).items((x: any) => x.item(item).slot(BigInt(slot))).update();
  });

  const ada = B.Person().given_name("Ada").birth_date("1815-12-10").create();
  const bob = B.Person().given_name("Bob").parents((x: any) => x.parent(ada).kind("biological")).create();
  const carol = B.Person().given_name("Carol").children(
    (x: any) => x.child((y: any) => y.given_name("Dan").birth_date("2001-02-03")).kind("adoptive")).create();
  B.Person(ada).mentees((x: any) => x.mentee(bob)).update();
  B.Person(carol).mentees((x: any) => x.mentee(carol)).update();
  B.Person(bob).mentees((x: any) => x.mentee(ada)).update();

  const fall = B.Term().code("2026-FA").starts("2026-09-01").create();
  const cs101 = B.Course().code("CS101").create();
  const mia = B.Student().name("Mia")
    .enrollments((x: any) => x.course(cs101).term(fall).credits(4n).score(3.75).audit(false))
    .enrollments((x: any) => x.course((c: any) => c.code("MA201")).term(fall).credits(3n).score(-0.0))
    .create();
  B.Student().name("Noah").enrollments((x: any) => x.course(cs101).term(fall).audit(true)).create();

  const tricky = ["yes", "No", "on", "OFF", "y", "true", "null", "~", "", "010", "0o17", "0x1F", "1e3", "1_000", "1:30",
    "2026-09-01", ".inf", ".nan", "NaN", "Infinity", "-0.0", "+1", " lead", "trail ", "a: b", "- dash",
    "#hash", "x #y", '"dq"', "'sq'", "@at", "`tick", "%pct", "!bang", "&amp", "*star", "|", ">", "{}", "[]",
    ",", "?", "<<", "---", "...", "a\nb", "\t", "\x00", "\x07\x7f\x9b", "﻿bom", "a\x85b", "a b",
    "日本語 🚀", "word ".repeat(30)];
  const notebook = B.Notebook().title("tricky").create();
  tricky.forEach((value, page) => {
    const note = B.Note().text(value).create();
    B.Notebook(notebook).notes((x: any) => x.note(note).page(BigInt(page))).update();
  });

  const deck = B.Deck().title("contacts").create();
  const cards = [
    B.Card().name("Ann").home((r: any) => r.number("+1 555 0100").label("home").extensions((e: any) => e.value("12")))
      .reach((u: any) => u.email((r: any) => r.address("ann@example.com"))).ident((u: any) => u.number(7n)).create(),
    B.Card().name("Bo").reach((u: any) => u.phone((r: any) => r.number("+44 20 7946 0000")))
      .ident((u: any) => u.code("B-2"))
      .meta((i: any) => i.stamp((r: any) => r.updated("2026-09-29")).audit((r: any) => r.updated("2026-09-29").by("ann")))
      .create(),
    B.Card().name("Cy").create(),
  ];
  for (const card of cards) B.Deck(deck).cards((x: any) => x.card(card)).update();

  const rack = B.Board().name("rack");
  for (const value of ["", "日本語 🚀", "a"]) rack.tags((e: any) => e.value(value));
  for (const value of [new Uint8Array(), new Uint8Array([0, 255])]) rack.blobs((e: any) => e.value(value));
  for (const row of [[1n, -(2n ** 70n)], [], [0n]]) rack.grid((e: any) => e.row(entries("values", row.map((v) => (x: any) => x.value(v)))));
  rack.readings((e: any) => e.reading((u: any) => u.value(-0.0))).readings((e: any) => e.reading((u: any) => u.note("off")));
  rack.readings((e: any) => e.reading((u: any) => u.value(Infinity)));
  rack.sockets((e: any) => e.socket((o: any) => o.name("in").pins((x: any) => x.value("1")).pins((x: any) => x.value("2"))));
  rack.sockets((e: any) => e.socket((o: any) => o.name("out")));
  rack.banks((e: any) => e.bank((b: any) => b)).banks((e: any) => e.bank((b: any) => b.sockets(
    (x: any) => x.socket((o: any) => o.name("spare").pins((y: any) => y.value("9"))))));
  for (const [i, j, value] of [[2n, 1n, 0n], [1n, 1n, 1n], [1n, 2n, 0n], [2n, 2n, 1n]]) {
    rack.matrix((e: any) => e.i(i).j(j).value(value));
  }
  rack.attrs((e: any) => e.key("gain").value(1.5)).attrs((e: any) => e.key("").value(-0.0));
  rack.weights((e: any) => e.key(0.5).value("half")).weights((e: any) => e.key(NaN).value("none"));
  rack.cells((e: any) => e.key((c: any) => c.r(2n).c(3n)).value(6n)).cells((e: any) => e.key((c: any) => c.r(0n).c(0n)).value(0n));
  const board = rack.create();

  // --- module: the corpus's own schemas as data, with scalars of widths and another format's token, parametric
  // schemas: parameters, terms where a width stands, and applications with arguments of every scalar, and a predicate ---
  const int_ = (t: Schemas.OfAny.Builder) => t.as_scalar(BigInt);
  const n = new Schemas.Form.Data("variable", { name: "n" });
  const Word = Schemas.OfScalar.resolve((w) => w.name("Word").type(BigInt).parameters((p) => p.name("w").of(int_)).bits(
    new Schemas.Form.Data("variable", { name: "w" })));
  const Grid = new Schemas.OfObject.Builder().name("Grid").parameters((p) => p.name("n").of(int_).description("Its side"),
    (p) => p.name("x")).properties(
    (p) => p.name("mask").of((t) => t.as_scalar((w) => w.type(BigInt).bits(
      new Schemas.Form.Data("operation", { name: "mul" }, [n, n], "basic"))))).relations(
    list("cells", [held("cell", (c) => c.as_apply((a) => a.of(Word).arguments({ w: 8n })))])).create();
  const Square = new Schemas.OfApply.Builder().name("Square").parameters((p) => p.name("m").of(int_)).of(Grid).argument(
    "n", new Schemas.Form.Data("variable", { name: "m" })).argument("x", true).create();
  const Tricky = new Schemas.OfObject.Builder().name("Tricky").parameters(
    ...[..."abcd"].map((x) => (p: Schemas.OfParameter.Builder) => p.name(x))).create();
  const Applied = new Schemas.OfObject.Builder().name("Applied").properties(
    (p) => p.name("big").of((t) => t.as_apply((a) => a.of(Grid).arguments({ n: 2n ** 70n, x: NaN }))),
    (p) => p.name("odd").of((t) => t.as_apply((a) => a.of(Tricky).arguments({ a: -0.0, b: "日本語 🚀", c: new Uint8Array([0, 255]), d: false })))).create();
  const Choice = new S.OfUnion.Builder().name("Choice").branches((b) => b.name("n").of((t) => t.as_scalar(BigInt)),
    (b) => b.name("s").of((t) => t.as_scalar(String))).flat().create();
  const Marked = new S.OfIntersection.Builder().name("Marked").parts(
    (b) => b.name("when").of((t) => t.as_object((o) => o.properties(text("at", BigInt)))),
    (b) => b.name("who").of((t) => t.as_object((o) => o.properties(text("by"))))).flat().create();
  const schemas = [
    Schemas.OfScalar.resolve((n) => n.name("Int32").type(BigInt).bits(32n)),
    Schemas.OfScalar.resolve((n) => n.name("Size").token("ccpp", "size_t").bytes(8n)),
    Contact, Address, ContactAddresses, Person, Parentage, Card, Deck, Holding, Board,
    Word, Grid, Square, Tricky, Applied, Choice, Marked,
  ];
  const Lives = new S.OfPredicate.Builder().name("Lives").description("Who lives where").symbols(
    (s) => s.name("who").of(Contact), (s) => s.name("where").of(Address).description("A home")).parameters(
    (p) => p.name("since").of(int_)).requires(new Schemas.Form.Data("operation", { name: "and" }, [
      new Schemas.Form.Data("variable", { name: "who" }), new Schemas.Form.Data("variable", { name: "since" })], "basic")).create();
  const module = Modules.module(store, [...schemas, Lives]) as Instance;

  return new Map<string, [Schemas.OfObject.Data, Instance, Stores.Store]>([
    ["address_book", [Contact, alice, store]],
    ["scalars", [Bag, bag, store]],
    ["family", [Person, ada, store]],
    ["enrollment", [Student, mia, store]],
    ["yaml_strings", [Notebook, notebook, store]],
    ["embedded", [Deck, deck, store]],
    ["lists", [Board, board, store]],
    ["module", [Schemas.Module.Schema, module, store]],
  ]);
}
