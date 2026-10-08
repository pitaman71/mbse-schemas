"""The conformance corpus: the same cases, built statement for statement in every implementation.

`build()` registers the corpus schemas and returns `{case: (root schema, root object, store)}`, each case's store the one
its root belongs to. Each implementation writes its
snapshots to `conformance/<implementation>/<case>.json` and `.yaml`, and checks them against every other
implementation's files (see the CONF test suite). Keep this module and `typescript5/src/Conformance/Corpus.ts` in
lockstep: same schemas, same names, same values, same order of statements.
"""

from __future__ import annotations

import math

from mbse.Schemas.Framework import Modules, Proxies, Schemas

CASES = ["address_book", "natives", "family", "enrollment", "yaml_strings", "embedded", "lists", "module"]


def _text(name, native=str):
    return lambda prop: prop.name(name).of(lambda t: t.as_native(native))


def _list(spec):
    return lambda t: t.as_indexed(lambda i: i.of(spec))


def _keyed(key, spec):
    return lambda t: t.as_indexed(lambda i: i.key(key).of(spec))


def build():
    """The corpus, built in a store of its own: each case's root schema and root object."""
    S = Schemas
    store = Proxies.OfStore()

    # --- address_book ---
    Contact = S.OfObject.Builder().name("Contact").ref().properties(_text("given_name"), _text("family_name"), _text("birth_date")).create()
    Address = S.OfObject.Builder().name("Address").ref().properties(_text("street1"), _text("locality"), _text("postal_code"),
                                              _text("country_code")).create()
    Phone = S.OfObject.Builder().name("Phone").ref().properties(_text("number")).create()
    ContactAddresses = S.OfRelation.Builder().name("ContactAddresses").links("contact", "address").properties(_text("label")).create()
    ContactPhones = S.OfRelation.Builder().name("ContactPhones").links("contact", "phone").properties(_text("label")).create()
    S.OfObject.Builder(Contact).relations(lambda a: a.name("addresses").of(ContactAddresses).me("contact"),
                                          lambda a: a.name("phones").of(ContactPhones).me("contact")).update()
    S.OfObject.Builder(Address).relations(lambda a: a.name("contacts").of(ContactAddresses).me("address")).update()
    S.OfObject.Builder(Phone).relations(lambda a: a.name("contacts").of(ContactPhones).me("phone")).update()

    # --- natives ---
    Bag = S.OfObject.Builder().name("Bag").ref().properties(_text("name")).create()
    Sample = S.OfObject.Builder().name("Sample").ref().properties(_text("label"), _text("payload", bytes), _text("count", int),
                                             _text("ratio", float), _text("flag", bool)).create()
    Holds = S.OfRelation.Builder().name("Holds").links("bag", "item").properties(_text("slot", int)).unique("bag", "slot").create()
    S.OfObject.Builder(Bag).relations(lambda a: a.name("items").of(Holds).me("bag")).update()
    S.OfObject.Builder(Sample).relations(lambda a: a.name("bags").of(Holds).me("item")).update()

    # --- family ---
    Person = S.OfObject.Builder().name("Person").ref().properties(_text("given_name"), _text("birth_date")).create()
    Parentage = S.OfRelation.Builder().name("Parentage").links("parent", "child").properties(_text("kind")).create()
    Mentorship = S.OfRelation.Builder().name("Mentorship").links("mentor", "mentee").create()
    S.OfObject.Builder(Person).relations(lambda a: a.name("children").of(Parentage).me("parent"),
                                         lambda a: a.name("parents").of(Parentage).me("child"),
                                         lambda a: a.name("mentees").of(Mentorship).me("mentor"),
                                         lambda a: a.name("mentors").of(Mentorship).me("mentee")).update()

    # --- enrollment ---
    Student = S.OfObject.Builder().name("Student").ref().properties(_text("name")).create()
    Course = S.OfObject.Builder().name("Course").ref().properties(_text("code")).create()
    Term = S.OfObject.Builder().name("Term").ref().properties(_text("code"), _text("starts")).create()
    Enrollment = (S.OfRelation.Builder().name("Enrollment").links("student", "course", "term")
                  .properties(_text("credits", int), _text("score", float), _text("audit", bool)).create())
    S.OfObject.Builder(Student).relations(lambda a: a.name("enrollments").of(Enrollment).me("student")).update()
    S.OfObject.Builder(Course).relations(lambda a: a.name("enrollments").of(Enrollment).me("course")).update()
    S.OfObject.Builder(Term).relations(lambda a: a.name("enrollments").of(Enrollment).me("term")).update()

    # --- yaml_strings ---
    Notebook = S.OfObject.Builder().name("Notebook").ref().properties(_text("title")).create()
    Note = S.OfObject.Builder().name("Note").ref().properties(_text("text")).create()
    Pages = S.OfRelation.Builder().name("Pages").links("notebook", "note").properties(_text("page", int)).create()
    S.OfObject.Builder(Notebook).relations(lambda a: a.name("notes").of(Pages).me("notebook")).update()
    S.OfObject.Builder(Note).relations(lambda a: a.name("notebooks").of(Pages).me("note")).update()

    # --- embedded: value objects (value objects, one linked through a relation), union values of objects and of
    # natives, and an intersection value; a card reached only through its value object carries its schema ---
    Line = S.OfRelation.Builder().name("Line").links("hub", "phone").create()
    CardPhone = S.OfObject.Builder().properties(_text("number"), _text("label")).relations(
        lambda a: a.name("hubs").of(Line).me("phone")).create()
    CardEmail = S.OfObject.Builder().properties(_text("address")).create()
    Reach = S.OfUnion.Builder().branches(lambda b: b.name("phone").of(CardPhone),
                                         lambda b: b.name("email").of(CardEmail)).create()
    Ident = S.OfUnion.Builder().branches(lambda b: b.name("number").of(lambda t: t.as_native(int)),
                                         lambda b: b.name("code").of(lambda t: t.as_native(str))).create()
    CardStamp = S.OfObject.Builder().properties(_text("updated")).create()
    CardAudit = S.OfObject.Builder().properties(_text("by"), _text("updated")).create()
    CardMeta = S.OfIntersection.Builder().parts(lambda p: p.name("stamp").of(CardStamp),
                                                lambda p: p.name("audit").of(CardAudit)).create()
    Card = S.OfObject.Builder().name("Card").ref().properties(_text("name"), lambda p: p.name("home").of(CardPhone),
                                           lambda p: p.name("reach").of(Reach), lambda p: p.name("ident").of(Ident),
                                           lambda p: p.name("meta").of(CardMeta)).create()
    Holding = S.OfRelation.Builder().name("Holding").links("deck", "card").create()
    Deck = S.OfObject.Builder().name("Deck").ref().properties(_text("title")).relations(lambda a: a.name("cards").of(Holding).me("deck")).create()
    S.OfObject.Builder(Card).relations(lambda a: a.name("decks").of(Holding).me("card")).update()
    Hub = S.OfObject.Builder().name("Hub").ref().properties(_text("name")).relations(lambda a: a.name("phones").of(Line).me("hub")).create()

    # --- lists: of natives, of lists, of union values and of value objects, which link each other and a reference
    # object ---
    Cable = S.OfRelation.Builder().name("Cable").links("source", "sink").create()
    Socket = S.OfObject.Builder().properties(_text("name")).relations(
        lambda a: a.name("cables").of(Cable).me("source"), lambda a: a.name("plugs").of(Cable).me("sink")).create()
    Coord = S.OfObject.Builder().properties(_text("r", int), _text("c", int)).create()
    Reading = S.OfUnion.Builder().branches(lambda b: b.name("value").of(lambda t: t.as_native(float)),
                                           lambda b: b.name("note").of(lambda t: t.as_native(str))).create()
    Board = S.OfObject.Builder().name("Board").ref().properties(
        _text("name"), lambda p: p.name("tags").of(_list(lambda t: t.as_native(str))),
        lambda p: p.name("blobs").of(_list(lambda t: t.as_native(bytes))),
        lambda p: p.name("grid").of(_list(_list(lambda t: t.as_native(int)))),
        lambda p: p.name("readings").of(_list(Reading)), lambda p: p.name("sockets").of(_list(Socket)),
        lambda p: p.name("banks").of(_list(_list(Socket))),
        lambda p: p.name("matrix").of(lambda t: t.as_indexed(lambda i: i.of(_list(lambda t: t.as_native(int))).extent(1, 3))),
        lambda p: p.name("attrs").of(_keyed(lambda t: t.as_native(str), lambda t: t.as_native(float))),
        lambda p: p.name("weights").of(_keyed(lambda t: t.as_native(float), lambda t: t.as_native(str))),
        lambda p: p.name("cells").of(_keyed(Coord, lambda t: t.as_native(int)))).create()
    Panel = S.OfObject.Builder().name("Panel").ref().properties(_text("name")).relations(
        lambda a: a.name("plugs").of(Cable).me("sink")).create()

    for schema in [Contact, Address, Phone, ContactAddresses, ContactPhones, Bag, Sample, Holds, Person, Parentage, Mentorship, Student, Course, Term, Enrollment, Notebook, Note, Pages, Card, Deck, Holding, Hub, Line, Board, Panel, Cable]:
        store.register(schema)
    B = store

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

    deck = B.Deck().title("contacts").create()
    cards = [
        B.Card().name("Ann").home(lambda r: r.number("+1 555 0100").label("home"))
        .reach(lambda u: u.email(lambda r: r.address("ann@example.com"))).ident(lambda u: u.number(7)).create(),
        B.Card().name("Bo").reach(lambda u: u.phone(lambda r: r.number("+44 20 7946 0000")))
        .ident(lambda u: u.code("B-2"))
        .meta(lambda i: i.stamp(lambda r: r.updated("2026-09-29")).audit(lambda r: r.updated("2026-09-29").by("ann")))
        .create(),
        B.Card().name("Cy").create(),
    ]
    for card in cards:
        B.Deck(deck).cards(lambda x, card=card: x.card(card)).update()
    di = B.Card().name("Di").home(lambda r: r.number("+33 1 00 00 00 00")).create()
    B.Hub().name("switchboard").phones(lambda x: x.phone(cards[0].home)).phones(lambda x: x.phone(di.home)).create()

    panel = B.Panel().name("mains").create()
    board = (B.Board().name("rack").tags(["", "日本語 🚀", "a"]).blobs([b"", b"\x00\xff"]).grid([[1, -(2**70)], [], [0]])
             .readings([lambda u: u.value(-0.0), lambda u: u.note("off"), lambda u: u.value(math.inf)])
             .sockets([lambda o: o.name("in"), lambda o: o.name("out")]).banks([[], [lambda o: o.name("spare")]])
             .matrix([[1, 0], [0, 1]]).attrs({"gain": 1.5, "": -0.0}).weights({0.5: "half", math.nan: "none"})
             .cells([(lambda c: c.r(2).c(3), 6), (lambda c: c.r(0).c(0), 0)])
             .create())
    B.Board(board).sockets(lambda items: items.item(0, lambda v: v.as_object(
        lambda o: o.cables(lambda x: x.sink(board.sockets[1])).cables(lambda x: x.sink(panel))))).banks(
        lambda rows: rows.item(1, lambda v: v.as_indexed(lambda row: row.item(0, lambda w: w.as_object(
            lambda o: o.cables(lambda x: x.sink(board.sockets[0]))))))).update()

    # --- module: the corpus's own schemas as data, with natives of widths and another format's token, and parametric
    # schemas: parameters, terms where a width or a bound stands, and applications with arguments of every native ---
    int_ = lambda t: t.as_native(int)  # noqa: E731
    n = S.Form.Data("variable", {"name": "n"})
    Word = S.OfNative.resolve(lambda w: w.name("Word").type(int).parameters(lambda p: p.name("w").of(int_)).bits(
        S.Form.Data("variable", {"name": "w"})))
    Grid = S.OfObject.Builder().name("Grid").parameters(lambda p: p.name("n").of(int_).description("Its side"),
                                                        lambda p: p.name("x")).properties(
        lambda p: p.name("cells").of(lambda t: t.as_indexed(lambda i: i.of(lambda c: c.as_apply(
            lambda a: a.of(Word).arguments(8))).extent(1, S.Form.Data("operation", {"name": "mul"}, (n, n), "basic"))))).create()
    Square = S.OfApply.Builder().name("Square").parameters(lambda p: p.name("m").of(int_)).of(Grid).argument(
        "n", S.Form.Data("variable", {"name": "m"})).argument("x", True).create()
    Tricky = S.OfObject.Builder().name("Tricky").parameters(*[lambda p, x=x: p.name(x) for x in "abcd"]).create()
    Applied = S.OfObject.Builder().name("Applied").properties(
        lambda p: p.name("big").of(lambda t: t.as_apply(lambda a: a.of(Grid).arguments(2**70, math.nan))),
        lambda p: p.name("odd").of(lambda t: t.as_apply(lambda a: a.of(Tricky).arguments(-0.0, "日本語 🚀", b"\x00\xff", False)))
    ).create()
    Choice = S.OfUnion.Builder().name("Choice").branches(lambda b: b.name("n").of(lambda t: t.as_native(int)),
                                                         lambda b: b.name("s").of(lambda t: t.as_native(str))).flat().create()
    Marked = S.OfIntersection.Builder().name("Marked").parts(
        lambda b: b.name("when").of(lambda t: t.as_object(lambda o: o.properties(_text("at", int)))),
        lambda b: b.name("who").of(lambda t: t.as_object(lambda o: o.properties(_text("by"))))).flat().create()
    schemas = [S.OfNative.resolve(lambda n: n.name("Int32").type(int).bits(32)),
               S.OfNative.resolve(lambda n: n.name("Size").token("ccpp", "size_t").bytes(8)),
               Contact, Address, ContactAddresses, Person, Parentage, Card, Deck, Holding, Board, Panel,
               Word, Grid, Square, Tricky, Applied, Choice, Marked]
    module = Modules.module(store, schemas)

    return {
        "address_book": (Contact, alice, store),
        "natives": (Bag, bag, store),
        "family": (Person, ada, store),
        "enrollment": (Student, mia, store),
        "yaml_strings": (Notebook, notebook, store),
        "embedded": (Deck, deck, store),
        "lists": (Board, board, store),
        "module": (S.Module.Schema, module, store),
    }
