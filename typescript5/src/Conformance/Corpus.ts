/**
 * The conformance corpus: the same cases, built statement for statement in every implementation.
 *
 * `build()` registers the corpus schemas and returns `{case: [root schema, root object]}`. Each implementation writes
 * its snapshots to `conformance/<implementation>/<case>.json` and `.yaml`, and checks them against every other
 * implementation's files (see the CONF test suite). Keep this module and `python3/mbse/Schemas/Conformance/Corpus.py` in
 * lockstep: same schemas, same names, same values, same order of statements.
 */

import { Modules, Proxies, Schemas } from "../Framework/index.js";
import type { Instance } from "../Framework/Proxies.js";

export const CASES = ["address_book", "natives", "family", "enrollment", "yaml_strings", "embedded", "lists", "module"] as const;

function text(name: string, native: unknown = String) {
  return (prop: Schemas.OfProperty.Builder) => prop.name(name).of((t) => t.as_native(native as never));
}

function list(spec: Schemas.OfAny.Spec) {
  return (t: Schemas.OfAny.Builder) => t.as_indexed((i) => i.of(spec));
}

function keyed(key: Schemas.OfAny.Spec, spec: Schemas.OfAny.Spec) {
  return (t: Schemas.OfAny.Builder) => t.as_indexed((i) => i.key(key).of(spec));
}

export function build(): Map<string, [Schemas.OfObject.Data, Instance]> {
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

  // --- natives ---
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

  // --- embedded: value objects (value objects, one linked through a relation), union values of objects and of
  // natives, and an intersection value; a card reached only through its value object carries its schema ---
  const Line = new Schemas.OfRelation.Builder().name("Line").links("hub", "phone").create();
  const CardPhone = new Schemas.OfObject.Builder().properties(text("number"), text("label")).relations(
    (a) => a.name("hubs").of(Line).me("phone")).create();
  const CardEmail = new Schemas.OfObject.Builder().properties(text("address")).create();
  const Reach = new Schemas.OfUnion.Builder().branches((b) => b.name("phone").of(CardPhone),
    (b) => b.name("email").of(CardEmail)).create();
  const Ident = new Schemas.OfUnion.Builder().branches((b) => b.name("number").of((t) => t.as_native(BigInt)),
    (b) => b.name("code").of((t) => t.as_native(String))).create();
  const CardStamp = new Schemas.OfObject.Builder().properties(text("updated")).create();
  const CardAudit = new Schemas.OfObject.Builder().properties(text("by"), text("updated")).create();
  const CardMeta = new Schemas.OfIntersection.Builder().parts((p) => p.name("stamp").of(CardStamp),
    (p) => p.name("audit").of(CardAudit)).create();
  const Card = new Schemas.OfObject.Builder().name("Card").ref().properties(text("name"), (p) => p.name("home").of(CardPhone),
    (p) => p.name("reach").of(Reach), (p) => p.name("ident").of(Ident), (p) => p.name("meta").of(CardMeta)).create();
  const Holding = new Schemas.OfRelation.Builder().name("Holding").links("deck", "card").create();
  const Deck = new Schemas.OfObject.Builder().name("Deck").ref().properties(text("title")).relations((a) => a.name("cards").of(Holding).me("deck")).create();
  new Schemas.OfObject.Builder(Card).relations((a) => a.name("decks").of(Holding).me("card")).update();
  const Hub = new Schemas.OfObject.Builder().name("Hub").ref().properties(text("name")).relations((a) => a.name("phones").of(Line).me("hub")).create();

  // --- lists: of natives, of lists, of union values and of value objects, which link each other and a reference
  // object ---
  const Cable = new Schemas.OfRelation.Builder().name("Cable").links("source", "sink").create();
  const Socket = new Schemas.OfObject.Builder().properties(text("name")).relations(
    (a) => a.name("cables").of(Cable).me("source"), (a) => a.name("plugs").of(Cable).me("sink")).create();
  const Coord = new Schemas.OfObject.Builder().properties(text("r", BigInt), text("c", BigInt)).create();
  const Reading = new Schemas.OfUnion.Builder().branches((b) => b.name("value").of((t) => t.as_native(Number)),
    (b) => b.name("note").of((t) => t.as_native(String))).create();
  const Board = new Schemas.OfObject.Builder().name("Board").ref().properties(
    text("name"), (p) => p.name("tags").of(list((t) => t.as_native(String))),
    (p) => p.name("blobs").of(list((t) => t.as_native(Uint8Array))),
    (p) => p.name("grid").of(list(list((t) => t.as_native(BigInt)))),
    (p) => p.name("readings").of(list(Reading)), (p) => p.name("sockets").of(list(Socket)),
    (p) => p.name("banks").of(list(list(Socket))),
    (p) => p.name("matrix").of((t) => t.as_indexed((i) => i.of(list((t) => t.as_native(BigInt))).extent({ minimum: 1n, maximum: 3n }))),
    (p) => p.name("attrs").of(keyed((t) => t.as_native(String), (t) => t.as_native(Number))),
    (p) => p.name("weights").of(keyed((t) => t.as_native(Number), (t) => t.as_native(String))),
    (p) => p.name("cells").of(keyed(Coord, (t) => t.as_native(BigInt)))).create();
  const Panel = new Schemas.OfObject.Builder().name("Panel").ref().properties(text("name")).relations(
    (a) => a.name("plugs").of(Cable).me("sink")).create();

  for (const schema of [Contact, Address, Phone, ContactAddresses, ContactPhones, Bag, Sample, Holds, Person, Parentage, Mentorship, Student, Course, Term, Enrollment, Notebook, Note, Pages, Card, Deck, Holding, Hub, Line, Board, Panel, Cable]) {
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
    B.Card().name("Ann").home((r: any) => r.number("+1 555 0100").label("home"))
      .reach((u: any) => u.email((r: any) => r.address("ann@example.com"))).ident((u: any) => u.number(7n)).create(),
    B.Card().name("Bo").reach((u: any) => u.phone((r: any) => r.number("+44 20 7946 0000")))
      .ident((u: any) => u.code("B-2"))
      .meta((i: any) => i.stamp((r: any) => r.updated("2026-09-29")).audit((r: any) => r.updated("2026-09-29").by("ann")))
      .create(),
    B.Card().name("Cy").create(),
  ];
  for (const card of cards) B.Deck(deck).cards((x: any) => x.card(card)).update();
  const di = B.Card().name("Di").home((r: any) => r.number("+33 1 00 00 00 00")).create();
  B.Hub().name("switchboard").phones((x: any) => x.phone((cards[0] as any).home)).phones((x: any) => x.phone(di.home)).create();

  const panel = B.Panel().name("mains").create();
  const board = B.Board().name("rack").tags(["", "日本語 🚀", "a"]).blobs([new Uint8Array(), new Uint8Array([0, 255])])
    .grid([[1n, -(2n ** 70n)], [], [0n]])
    .readings([(u: any) => u.value(-0.0), (u: any) => u.note("off"), (u: any) => u.value(Infinity)])
    .sockets([(o: any) => o.name("in"), (o: any) => o.name("out")]).banks([[], [(o: any) => o.name("spare")]])
    .matrix([[1n, 0n], [0n, 1n]]).attrs(new Map([["gain", 1.5], ["", -0.0]])).weights(new Map([[0.5, "half"], [NaN, "none"]]))
    .cells([[(c: any) => c.r(2n).c(3n), 6n], [(c: any) => c.r(0n).c(0n), 0n]])
    .create();
  B.Board(board).sockets((items: any) => items.item(0, (v: any) => v.as_object(
    (o: any) => o.cables((x: any) => x.sink(board.sockets[1])).cables((x: any) => x.sink(panel))))).banks(
    (rows: any) => rows.item(1, (v: any) => v.as_indexed((row: any) => row.item(0, (w: any) => w.as_object(
      (o: any) => o.cables((x: any) => x.sink(board.sockets[0]))))))).update();

  // --- module: the corpus's own schemas as data, with natives of widths and another format's token ---
  const schemas = [
    Schemas.OfNative.resolve((n) => n.name("Int32").type(BigInt).bits(32n)),
    Schemas.OfNative.resolve((n) => n.name("Size").token("ccpp", "size_t").bytes(8n)),
    Contact, Address, ContactAddresses, Person, Parentage, Card, Deck, Holding, Board, Panel,
  ];
  const module = Modules.module(store, schemas) as Instance;

  return new Map<string, [Schemas.OfObject.Data, Instance]>([
    ["address_book", [Contact, alice]],
    ["natives", [Bag, bag]],
    ["family", [Person, ada]],
    ["enrollment", [Student, mia]],
    ["yaml_strings", [Notebook, notebook]],
    ["embedded", [Deck, deck]],
    ["lists", [Board, board]],
    ["module", [Schemas.Module.Schema, module]],
  ]);
}
