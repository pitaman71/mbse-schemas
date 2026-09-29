/**
 * The conformance corpus: the same cases, built statement for statement in every implementation.
 *
 * `build()` registers the corpus schemas and returns `{case: [root schema, root object]}`. Each implementation writes
 * its snapshots to `conformance/<implementation>/<case>.json` and `.yaml`, and checks them against every other
 * implementation's files (see the CONF test suite). Keep this module and `python3/mbse_schemas/Conformance/Corpus.py` in
 * lockstep: same schemas, same names, same values, same order of statements.
 */

import { Expressions, Proxies, Schemas } from "../Framework/index.js";
import type { Visitable } from "../Framework/Visitors.js";

export const CASES = ["address_book", "natives", "family", "enrollment", "yaml_strings", "expression"] as const;

function text(name: string, native: unknown = String) {
  return (prop: Schemas.OfProperty.Builder) => prop.name(name).of((t) => t.as_native(native as never));
}

export function build(): Map<string, [Schemas.OfObject.Data, Visitable]> {
  const S = Schemas;

  // --- address_book ---
  const Contact = new S.OfObject.Builder().properties(text("given_name"), text("family_name"), text("birth_date")).create();
  const Address = new S.OfObject.Builder().properties(text("street1"), text("locality"), text("postal_code"),
    text("country_code")).create();
  const Phone = new S.OfObject.Builder().properties(text("number")).create();
  const ContactAddresses = new S.OfRelation.Builder().links("contact", "address").properties(text("label")).create();
  const ContactPhones = new S.OfRelation.Builder().links("contact", "phone").properties(text("label")).create();
  new S.OfObject.Builder(Contact).relations((a) => a.name("addresses").of(ContactAddresses).me("contact"),
    (a) => a.name("phones").of(ContactPhones).me("contact")).update();
  new S.OfObject.Builder(Address).relations((a) => a.name("contacts").of(ContactAddresses).me("address")).update();
  new S.OfObject.Builder(Phone).relations((a) => a.name("contacts").of(ContactPhones).me("phone")).update();

  // --- natives ---
  const Bag = new S.OfObject.Builder().properties(text("name")).create();
  const Sample = new S.OfObject.Builder().properties(text("label"), text("payload", Uint8Array), text("count", BigInt),
    text("ratio", Number), text("flag", Boolean)).create();
  const Holds = new S.OfRelation.Builder().links("bag", "item").properties(text("slot", BigInt)).unique("bag", "slot").create();
  new S.OfObject.Builder(Bag).relations((a) => a.name("items").of(Holds).me("bag")).update();
  new S.OfObject.Builder(Sample).relations((a) => a.name("bags").of(Holds).me("item")).update();

  // --- family ---
  const Person = new S.OfObject.Builder().properties(text("given_name"), text("birth_date")).create();
  const Parentage = new S.OfRelation.Builder().links("parent", "child").properties(text("kind")).create();
  const Mentorship = new S.OfRelation.Builder().links("mentor", "mentee").create();
  new S.OfObject.Builder(Person).relations((a) => a.name("children").of(Parentage).me("parent"),
    (a) => a.name("parents").of(Parentage).me("child"),
    (a) => a.name("mentees").of(Mentorship).me("mentor"),
    (a) => a.name("mentors").of(Mentorship).me("mentee")).update();

  // --- enrollment ---
  const Student = new S.OfObject.Builder().properties(text("name")).create();
  const Course = new S.OfObject.Builder().properties(text("code")).create();
  const Term = new S.OfObject.Builder().properties(text("code"), text("starts")).create();
  const Enrollment = new S.OfRelation.Builder().links("student", "course", "term")
    .properties(text("credits", BigInt), text("score", Number), text("audit", Boolean)).create();
  new S.OfObject.Builder(Student).relations((a) => a.name("enrollments").of(Enrollment).me("student")).update();
  new S.OfObject.Builder(Course).relations((a) => a.name("enrollments").of(Enrollment).me("course")).update();
  new S.OfObject.Builder(Term).relations((a) => a.name("enrollments").of(Enrollment).me("term")).update();

  // --- yaml_strings ---
  const Notebook = new S.OfObject.Builder().properties(text("title")).create();
  const Note = new S.OfObject.Builder().properties(text("text")).create();
  const Pages = new S.OfRelation.Builder().links("notebook", "note").properties(text("page", BigInt)).create();
  new S.OfObject.Builder(Notebook).relations((a) => a.name("notes").of(Pages).me("notebook")).update();
  new S.OfObject.Builder(Note).relations((a) => a.name("notebooks").of(Pages).me("note")).update();

  for (const [name, schema] of [["Contact", Contact], ["Address", Address], ["Phone", Phone],
    ["ContactAddresses", ContactAddresses], ["ContactPhones", ContactPhones],
    ["Bag", Bag], ["Sample", Sample], ["Holds", Holds],
    ["Person", Person], ["Parentage", Parentage], ["Mentorship", Mentorship],
    ["Student", Student], ["Course", Course], ["Term", Term], ["Enrollment", Enrollment],
    ["Notebook", Notebook], ["Note", Note], ["Pages", Pages]] as const) {
    Proxies.register(name, schema);
  }
  const B = Proxies.Builders;

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

  // --- expression: every kind and literal type, shared sub-expressions, each operation once ---
  const E = Expressions;
  const [self, age] = [E.variable("this"), E.variable("age")];
  const expression = E.let_("age", self.age, age.ge(18n).and_(
    age.lt(65.5).or_(self.has("email").not_())
      .implies(E.operation("in", "x", new Uint8Array([0x00, 0xff]), true)))).data;

  return new Map<string, [Schemas.OfObject.Data, Visitable]>([
    ["address_book", [Contact, alice]],
    ["natives", [Bag, bag]],
    ["family", [Person, ada]],
    ["enrollment", [Student, mia]],
    ["yaml_strings", [Notebook, notebook]],
    ["expression", [E.OfLet.Schema, expression]],
  ]);
}
