"""The conformance corpus: the same cases, built statement for statement in every implementation.

`build()` registers the corpus schemas and returns `{case: (root schema, root object)}`. Each implementation writes its
snapshots to `conformance/<implementation>/<case>.json` and `.yaml`, and checks them against every other
implementation's files (see the CONF test suite). Keep this module and `typescript5/src/Conformance/Corpus.ts` in
lockstep: same schemas, same names, same values, same order of statements.
"""

from __future__ import annotations

import math

from schemas.Framework import Proxies, Schemas

CASES = ["address_book", "natives", "family", "enrollment", "yaml_strings"]


def _text(name, native=str):
    return lambda prop: prop.name(name).of(lambda t: t.as_native(native))


def build():
    S = Schemas

    # --- address_book ---
    Contact = S.OfObject.Builder().properties(_text("given_name"), _text("family_name"), _text("birth_date")).create()
    Address = S.OfObject.Builder().properties(_text("street1"), _text("locality"), _text("postal_code"),
                                              _text("country_code")).create()
    Phone = S.OfObject.Builder().properties(_text("number")).create()
    ContactAddresses = S.OfRelation.Builder().links("contact", "address").properties(_text("label")).create()
    ContactPhones = S.OfRelation.Builder().links("contact", "phone").properties(_text("label")).create()
    S.OfObject.Builder(Contact).relations(lambda a: a.name("addresses").of(ContactAddresses).me("contact"),
                                          lambda a: a.name("phones").of(ContactPhones).me("contact")).update()
    S.OfObject.Builder(Address).relations(lambda a: a.name("contacts").of(ContactAddresses).me("address")).update()
    S.OfObject.Builder(Phone).relations(lambda a: a.name("contacts").of(ContactPhones).me("phone")).update()

    # --- natives ---
    Bag = S.OfObject.Builder().properties(_text("name")).create()
    Sample = S.OfObject.Builder().properties(_text("label"), _text("payload", bytes), _text("count", int),
                                             _text("ratio", float), _text("flag", bool)).create()
    Holds = S.OfRelation.Builder().links("bag", "item").properties(_text("slot", int)).unique("bag", "slot").create()
    S.OfObject.Builder(Bag).relations(lambda a: a.name("items").of(Holds).me("bag")).update()
    S.OfObject.Builder(Sample).relations(lambda a: a.name("bags").of(Holds).me("item")).update()

    # --- family ---
    Person = S.OfObject.Builder().properties(_text("given_name"), _text("birth_date")).create()
    Parentage = S.OfRelation.Builder().links("parent", "child").properties(_text("kind")).create()
    Mentorship = S.OfRelation.Builder().links("mentor", "mentee").create()
    S.OfObject.Builder(Person).relations(lambda a: a.name("children").of(Parentage).me("parent"),
                                         lambda a: a.name("parents").of(Parentage).me("child"),
                                         lambda a: a.name("mentees").of(Mentorship).me("mentor"),
                                         lambda a: a.name("mentors").of(Mentorship).me("mentee")).update()

    # --- enrollment ---
    Student = S.OfObject.Builder().properties(_text("name")).create()
    Course = S.OfObject.Builder().properties(_text("code")).create()
    Term = S.OfObject.Builder().properties(_text("code"), _text("starts")).create()
    Enrollment = (S.OfRelation.Builder().links("student", "course", "term")
                  .properties(_text("credits", int), _text("score", float), _text("audit", bool)).create())
    S.OfObject.Builder(Student).relations(lambda a: a.name("enrollments").of(Enrollment).me("student")).update()
    S.OfObject.Builder(Course).relations(lambda a: a.name("enrollments").of(Enrollment).me("course")).update()
    S.OfObject.Builder(Term).relations(lambda a: a.name("enrollments").of(Enrollment).me("term")).update()

    # --- yaml_strings ---
    Notebook = S.OfObject.Builder().properties(_text("title")).create()
    Note = S.OfObject.Builder().properties(_text("text")).create()
    Pages = S.OfRelation.Builder().links("notebook", "note").properties(_text("page", int)).create()
    S.OfObject.Builder(Notebook).relations(lambda a: a.name("notes").of(Pages).me("notebook")).update()
    S.OfObject.Builder(Note).relations(lambda a: a.name("notebooks").of(Pages).me("note")).update()

    for name, schema in [("Contact", Contact), ("Address", Address), ("Phone", Phone),
                         ("ContactAddresses", ContactAddresses), ("ContactPhones", ContactPhones),
                         ("Bag", Bag), ("Sample", Sample), ("Holds", Holds),
                         ("Person", Person), ("Parentage", Parentage), ("Mentorship", Mentorship),
                         ("Student", Student), ("Course", Course), ("Term", Term), ("Enrollment", Enrollment),
                         ("Notebook", Notebook), ("Note", Note), ("Pages", Pages)]:
        Proxies.register(name, schema)
    B = Proxies.Builders

    home = B.Address().street1("10 Downing Street").locality("London").postal_code("SW1A 2AA").country_code("GB").create()
    alice = (B.Contact().given_name("Alice").family_name("Liddell").birth_date("1852-05-04")
             .addresses(lambda x: x.address(home).label("home"))
             .phones(lambda x: x.phone(lambda p: p.number("+447700900123")).label("mobile"))
             .phones(lambda x: x.phone(lambda p: p.number("+14155550100")).label("work"))
             .create())
    B.Contact().given_name("Bob").addresses(lambda x: x.address(home).label("home")).create()

    samples = [
        dict(label="", payload=b"", count=0, ratio=0.0, flag=False),
        dict(label="日本語 🚀", payload=bytes(range(256)), count=2**100, ratio=-0.0, flag=True),
        dict(label='\x00\x1f\x7f "q" \\ \n\t\r', payload=b"\x00", count=-(2**70), ratio=5e-324),
        dict(label="non-finite", ratio=math.nan),
        dict(label="+inf", ratio=math.inf),
        dict(label="-inf", ratio=-math.inf),
        dict(label="big", ratio=1e16, count=2**63),
        dict(label="small", ratio=0.1),
        dict(label="max", ratio=1e308),
        dict(label="two", ratio=2.0),
    ]
    bag = B.Bag().name("edges").create()
    for slot, values in enumerate(samples):
        builder = B.Sample()
        for name, value in values.items():
            getattr(builder, name)(value)
        item = builder.create()
        B.Bag(bag).items(lambda x, item=item, slot=slot: x.item(item).slot(slot)).update()

    ada = B.Person().given_name("Ada").birth_date("1815-12-10").create()
    bob = B.Person().given_name("Bob").parents(lambda x: x.parent(ada).kind("biological")).create()
    carol = B.Person().given_name("Carol").children(
        lambda x: x.child(lambda y: y.given_name("Dan").birth_date("2001-02-03")).kind("adoptive")).create()
    B.Person(ada).mentees(lambda x: x.mentee(bob)).update()
    B.Person(carol).mentees(lambda x: x.mentee(carol)).update()
    B.Person(bob).mentees(lambda x: x.mentee(ada)).update()

    fall = B.Term().code("2026-FA").starts("2026-09-01").create()
    cs101 = B.Course().code("CS101").create()
    mia = (B.Student().name("Mia")
           .enrollments(lambda x: x.course(cs101).term(fall).credits(4).score(3.75).audit(False))
           .enrollments(lambda x: x.course(lambda c: c.code("MA201")).term(fall).credits(3).score(-0.0))
           .create())
    B.Student().name("Noah").enrollments(lambda x: x.course(cs101).term(fall).audit(True)).create()

    tricky = ["yes", "No", "on", "OFF", "y", "true", "null", "~", "", "010", "0o17", "0x1F", "1e3", "1_000", "1:30",
              "2026-09-01", ".inf", ".nan", "NaN", "Infinity", "-0.0", "+1", " lead", "trail ", "a: b", "- dash",
              "#hash", "x #y", '"dq"', "'sq'", "@at", "`tick", "%pct", "!bang", "&amp", "*star", "|", ">", "{}", "[]",
              ",", "?", "<<", "---", "...", "a\nb", "\t", "\x00", "\x07\x7f\x9b", "﻿bom", "a\x85b", "a b",
              "日本語 🚀", "word " * 30]
    notebook = B.Notebook().title("tricky").create()
    for page, value in enumerate(tricky):
        note = B.Note().text(value).create()
        B.Notebook(notebook).notes(lambda x, note=note, page=page: x.note(note).page(page)).update()

    return {
        "address_book": (Contact, alice),
        "natives": (Bag, bag),
        "family": (Person, ada),
        "enrollment": (Student, mia),
        "yaml_strings": (Notebook, notebook),
    }
