"""The conformance corpus: the same cases, built statement for statement in every implementation.

`build()` returns `{case: (store, objects)}`: each case built in a store of its own, its schemas and its data, written as
a log of mutations, the store's initial snapshot (docs/SERIALIZATION.md); `objects` holds the case's data, which a store
holds weakly. Each implementation writes its logs to `conformance/<implementation>/<case>.json` and `.yaml`, and checks
them against every other implementation's files (see the CONF test suite). Keep this module and
`typescript5/src/Conformance/Corpus.ts` in lockstep: same schemas, same names, same values, same order of statements.
"""

from __future__ import annotations

import math

from mbse.Schemas.Framework import Builders as B, Schemas

CASES = ["address_book", "scalars", "family", "enrollment", "yaml_strings", "embedded", "lists", "module"]

Bool, Int, Float, Str, Bytes = B.Meta.OfBool, B.Meta.OfInt, B.Meta.OfFloat, B.Meta.OfStr, B.Meta.OfBytes


def _text(name, scalar=Str):
    return lambda t: t.name(name).type([scalar])


def _list(store, name, element, index=Int, layout=None):
    """A property `name` holding a container of `element` by `index`: dense by position, by default."""

    def container(c):
        c.index([index]).element([element])
        return c.layout(layout) if layout is not None else c

    return lambda t: t.name(name).type([store.Schemas.Container(container)])


def _write(pairs):
    """Writes a container's elements, each a scalar or, given a callable, through its `Visitors.OfAny`."""

    def write(container):
        for index, value in pairs:
            element = container.at(index)
            value(element) if callable(value) else element.as_scalar(value)
        return container

    return write


def _put(pairs):
    """A Spec writing the elements of the container a property holds."""
    return lambda prop: prop.as_value(lambda a: a.as_container(_write(pairs)))


def _literal(s, value):
    """A width given as a literal term, built in the store `s`."""
    return s.Schemas.Form(lambda f: f.kind("literal").attributes({"value": value}))


def _variable(s, name):
    """A variable's term, built in the store `s`."""
    return s.Schemas.Form(lambda f: f.kind("variable").attributes({"name": name}))


# --- Schemas, each group built in the store given ---


def _address_book(s):
    Contact = s.Schemas.Object(lambda o: o.name("Contact").ref(True).pattern(r"contact-(\d+)").properties([
        _text("given_name"), _text("family_name"), _text("birth_date")]))
    Address = s.Schemas.Object(lambda o: o.name("Address").ref(True).pattern(r"address-(\d+)").properties([
        _text("street1"), _text("locality"), _text("postal_code"), _text("country_code")]))
    Phone = s.Schemas.Object(lambda o: o.name("Phone").ref(True).pattern(r"phone-(\d+)").properties([_text("number")]))
    ContactAddresses = s.Schemas.Relation(lambda r: r.name("ContactAddresses").links([
        lambda t: t.name("contact"), lambda t: t.name("address")]).properties([_text("label")]))
    ContactPhones = s.Schemas.Relation(lambda r: r.name("ContactPhones").links([
        lambda t: t.name("contact"), lambda t: t.name("phone")]).properties([_text("label")]))
    s.Schemas.Object(Contact, lambda o: o.adjacencies([
        lambda t: t.name("addresses").relation([ContactAddresses]).me("contact"),
        lambda t: t.name("phones").relation([ContactPhones]).me("contact")]))
    s.Schemas.Object(Address, lambda o: o.adjacencies([lambda t: t.name("contacts").relation([ContactAddresses]).me("address")]))
    s.Schemas.Object(Phone, lambda o: o.adjacencies([lambda t: t.name("contacts").relation([ContactPhones]).me("phone")]))
    return Contact, Address, ContactAddresses


def _scalars(s):
    Bag = s.Schemas.Object(lambda o: o.name("Bag").ref(True).pattern(r"bag-(\d+)").properties([_text("name")]))
    Sample = s.Schemas.Object(lambda o: o.name("Sample").ref(True).pattern(r"sample-(\d+)").properties([
        _text("label"), _text("payload", Bytes), _text("count", Int), _text("ratio", Float), _text("flag", Bool)]))
    Holds = s.Schemas.Relation(lambda r: r.name("Holds").links([lambda t: t.name("bag"), lambda t: t.name("item")])
                               .properties([_text("slot", Int)]).uniques(["bag", "slot"]))
    s.Schemas.Object(Bag, lambda o: o.adjacencies([lambda t: t.name("items").relation([Holds]).me("bag")]))
    s.Schemas.Object(Sample, lambda o: o.adjacencies([lambda t: t.name("bags").relation([Holds]).me("item")]))


def _family(s):
    Person = s.Schemas.Object(lambda o: o.name("Person").ref(True).pattern(r"person-(\d+)").properties([
        _text("given_name"), _text("birth_date")]))
    Parentage = s.Schemas.Relation(lambda r: r.name("Parentage").links([lambda t: t.name("parent"), lambda t: t.name("child")])
                                   .properties([_text("kind")]))
    Mentorship = s.Schemas.Relation(lambda r: r.name("Mentorship").links([lambda t: t.name("mentor"), lambda t: t.name("mentee")]))
    s.Schemas.Object(Person, lambda o: o.adjacencies([
        lambda t: t.name("children").relation([Parentage]).me("parent"),
        lambda t: t.name("parents").relation([Parentage]).me("child"),
        lambda t: t.name("mentees").relation([Mentorship]).me("mentor"),
        lambda t: t.name("mentors").relation([Mentorship]).me("mentee")]))
    return Person, Parentage


def _enrollment(s):
    Student = s.Schemas.Object(lambda o: o.name("Student").ref(True).pattern(r"student-(\d+)").properties([_text("name")]))
    Course = s.Schemas.Object(lambda o: o.name("Course").ref(True).pattern(r"course-(\d+)").properties([_text("code")]))
    Term = s.Schemas.Object(lambda o: o.name("Term").ref(True).pattern(r"term-(\d+)").properties([
        _text("code"), _text("starts")]))
    Enrollment = s.Schemas.Relation(lambda r: r.name("Enrollment").links([
        lambda t: t.name("student"), lambda t: t.name("course"), lambda t: t.name("term")]).properties([
        _text("credits", Int), _text("score", Float), _text("audit", Bool)]))
    s.Schemas.Object(Student, lambda o: o.adjacencies([lambda t: t.name("enrollments").relation([Enrollment]).me("student")]))
    s.Schemas.Object(Course, lambda o: o.adjacencies([lambda t: t.name("enrollments").relation([Enrollment]).me("course")]))
    s.Schemas.Object(Term, lambda o: o.adjacencies([lambda t: t.name("enrollments").relation([Enrollment]).me("term")]))


def _yaml_strings(s):
    Notebook = s.Schemas.Object(lambda o: o.name("Notebook").ref(True).pattern(r"notebook-(\d+)").properties([_text("title")]))
    Note = s.Schemas.Object(lambda o: o.name("Note").ref(True).pattern(r"note-(\d+)").properties([_text("text")]))
    Pages = s.Schemas.Relation(lambda r: r.name("Pages").links([lambda t: t.name("notebook"), lambda t: t.name("note")])
                               .properties([_text("page", Int)]))
    s.Schemas.Object(Notebook, lambda o: o.adjacencies([lambda t: t.name("notes").relation([Pages]).me("notebook")]))
    s.Schemas.Object(Note, lambda o: o.adjacencies([lambda t: t.name("notebooks").relation([Pages]).me("note")]))


def _embedded(s):
    """Value objects (one with a container of its own), union values of objects and of scalars, and an intersection
    value."""
    CardPhone = s.Schemas.Object(lambda o: o.properties([_text("number"), _text("label"), _list(s, "extensions", Str)]))
    CardEmail = s.Schemas.Object(lambda o: o.properties([_text("address")]))
    Reach = s.Schemas.Union(lambda u: u.branches([lambda t: t.name("phone").type([CardPhone]),
                                                  lambda t: t.name("email").type([CardEmail])]))
    Ident = s.Schemas.Union(lambda u: u.branches([lambda t: t.name("number").type([Int]),
                                                  lambda t: t.name("code").type([Str])]))
    CardStamp = s.Schemas.Object(lambda o: o.properties([_text("updated")]))
    CardAudit = s.Schemas.Object(lambda o: o.properties([_text("by"), _text("updated")]))
    CardMeta = s.Schemas.Intersection(lambda i: i.parts([lambda t: t.name("stamp").type([CardStamp]),
                                                        lambda t: t.name("audit").type([CardAudit])]))
    Card = s.Schemas.Object(lambda o: o.name("Card").ref(True).pattern(r"card-(\d+)").properties([
        _text("name"), lambda t: t.name("home").type([CardPhone]), lambda t: t.name("reach").type([Reach]),
        lambda t: t.name("ident").type([Ident]), lambda t: t.name("meta").type([CardMeta])]))
    Holding = s.Schemas.Relation(lambda r: r.name("Holding").links([lambda t: t.name("deck"), lambda t: t.name("card")]))
    Deck = s.Schemas.Object(lambda o: o.name("Deck").ref(True).pattern(r"deck-(\d+)").properties([_text("title")])
                            .adjacencies([lambda t: t.name("cards").relation([Holding]).me("deck")]))
    s.Schemas.Object(Card, lambda o: o.adjacencies([lambda t: t.name("decks").relation([Holding]).me("card")]))
    return Card, Deck, Holding


def _lists(s):
    """Containers, dense by position: of scalars, of containers, of union values and of value objects, which hold
    containers of their own; a tensor by a pair of ints, sparse by an int, a dict by text, and entries by a float."""
    Socket = s.Schemas.Object(lambda o: o.properties([_text("name"), _list(s, "pins", Str)]))
    Coord = s.Schemas.Object(lambda o: o.properties([_text("r", Int), _text("c", Int)]))
    Reading = s.Schemas.Union(lambda u: u.branches([lambda t: t.name("value").type([Float]),
                                                    lambda t: t.name("note").type([Str])]))
    Row = s.Schemas.Container(lambda c: c.index([Int]).element([Int]))
    Bank = s.Schemas.Object(lambda o: o.properties([_list(s, "sockets", Socket)]))
    return s.Schemas.Object(lambda o: o.name("Board").ref(True).pattern(r"board-(\d+)").properties([
        _text("name"), _list(s, "tags", Str), _list(s, "blobs", Bytes), _list(s, "grid", Row),
        _list(s, "readings", Reading), _list(s, "sockets", Socket), _list(s, "banks", Bank), _list(s, "matrix", Int, Coord),
        _list(s, "cells", Int, layout="sparse"), _list(s, "attrs", Float, Str), _list(s, "weights", Str, Float)]))


def _module(s):
    """The corpus's own schemas as data, with scalars of widths and another format's token, parametric schemas:
    parameters, terms where a width stands, and applications with arguments of every scalar, and a predicate."""
    s.Schemas.Scalar(lambda n: n.name("Int32").token("int").bits([_literal(s, 32)]))
    s.Schemas.Scalar(lambda n: n.name("Size").format("ccpp").token("size_t").bytes([_literal(s, 8)]))
    Contact, Address, _ = _address_book(s)
    _family(s)
    _embedded(s)
    _lists(s)
    Word = s.Schemas.Scalar(lambda w: w.name("Word").token("int").parameters([lambda t: t.name("w").type([Int])])
                            .bits([_variable(s, "w")]))
    Grid = s.Schemas.Object(lambda o: o.name("Grid").parameters([
        lambda t: t.name("n").type([Int]).description("Its side"), lambda t: t.name("x")]).properties([
        lambda t: t.name("mask").type([s.Schemas.Scalar(lambda w: w.token("int").bits([
            s.Schemas.Form(lambda f: f.kind("operation").attributes({"name": "mul"}).operands([_variable(s, "n"), _variable(s, "n")])
                           .dialect("basic"))]))]),
        _list(s, "cells", s.Schemas.Apply(lambda a: a.of([Word]).arguments([
            lambda t: t.parameter([Word.parameters["w"]]).value(8)])))]))
    s.Schemas.Apply(lambda a: a.name("Square").parameters([lambda t: t.name("m").type([Int])]).of([Grid]).arguments([
        lambda t: t.parameter([Grid.parameters["n"]]).term([_variable(s, "m")]),
        lambda t: t.parameter([Grid.parameters["x"]]).value(True)]))
    Tricky = s.Schemas.Object(lambda o: o.name("Tricky").parameters([lambda t, x=x: t.name(x) for x in "abcd"]))
    s.Schemas.Object(lambda o: o.name("Applied").properties([
        lambda t: t.name("big").type([s.Schemas.Apply(lambda a: a.of([Grid]).arguments([
            lambda t: t.parameter([Grid.parameters["n"]]).value(2**70),
            lambda t: t.parameter([Grid.parameters["x"]]).value(math.nan)]))]),
        lambda t: t.name("odd").type([s.Schemas.Apply(lambda a: a.of([Tricky]).arguments([
            lambda t: t.parameter([Tricky.parameters["a"]]).value(-0.0),
            lambda t: t.parameter([Tricky.parameters["b"]]).value("日本語 🚀"),
            lambda t: t.parameter([Tricky.parameters["c"]]).value(b"\x00\xff"),
            lambda t: t.parameter([Tricky.parameters["d"]]).value(False)]))])]))
    s.Schemas.Union(lambda u: u.name("Choice").flat(True).branches([
        lambda t: t.name("n").type([Int]), lambda t: t.name("s").type([Str])]))
    s.Schemas.Intersection(lambda i: i.name("Marked").flat(True).parts([
        lambda t: t.name("when").type([s.Schemas.Object(lambda o: o.properties([_text("at", Int)]))]),
        lambda t: t.name("who").type([s.Schemas.Object(lambda o: o.properties([_text("by")]))])]))
    s.Schemas.Predicate(lambda p: p.name("Lives").description("Who lives where").symbols([
        lambda t: t.name("who").type([Contact]), lambda t: t.name("where").type([Address]).description("A home")])
        .parameters([lambda t: t.name("since").type([Int])])
        .requires([s.Schemas.Form(lambda f: f.kind("operation").attributes({"name": "and"})
                                  .operands([_variable(s, "who"), _variable(s, "since")]).dialect("basic"))]))


# --- The cases ---


def build():
    """The corpus: each case's store, and the data built in it."""
    cases = {}

    s = B.Store()
    _address_book(s)
    home = s.Address(lambda a: a.street1("10 Downing Street").locality("London").postal_code("SW1A 2AA").country_code("GB"))
    alice = s.Contact(lambda c: (
        c.given_name("Alice").family_name("Liddell").birth_date("1852-05-04")
        .addresses(lambda a: a.insert(lambda x: x.address(home).label("home")))
        .phones(lambda a: a.insert(lambda x: x.phone(lambda p: p.number("+447700900123")).label("mobile")))
        .phones(lambda a: a.insert(lambda x: x.phone(lambda p: p.number("+14155550100")).label("work")))))
    bob = s.Contact(lambda c: c.given_name("Bob").addresses(lambda a: a.insert(lambda x: x.address(home).label("home"))))
    cases["address_book"] = (s, [home, alice, bob])

    s = B.Store()
    _scalars(s)
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
    bag = s.Bag(lambda b: b.name("edges"))
    items = []
    for slot, values in enumerate(samples):
        item = s.Sample(lambda b, values=values: [getattr(b, name)(value) for name, value in values.items()])
        items.append(item)
        s.Bag(bag, lambda b, item=item, slot=slot: b.items(lambda a: a.insert(lambda x: x.item(item).slot(slot))))
    cases["scalars"] = (s, [bag, *items])

    s = B.Store()
    _family(s)
    ada = s.Person(lambda p: p.given_name("Ada").birth_date("1815-12-10"))
    bob = s.Person(lambda p: p.given_name("Bob").parents(lambda a: a.insert(lambda x: x.parent(ada).kind("biological"))))
    carol = s.Person(lambda p: p.given_name("Carol").children(lambda a: a.insert(
        lambda x: x.child(lambda y: y.given_name("Dan").birth_date("2001-02-03")).kind("adoptive"))))
    s.Person(ada, lambda p: p.mentees(lambda a: a.insert(lambda x: x.mentee(bob))))
    s.Person(carol, lambda p: p.mentees(lambda a: a.insert(lambda x: x.mentee(carol))))
    s.Person(bob, lambda p: p.mentees(lambda a: a.insert(lambda x: x.mentee(ada))))
    cases["family"] = (s, [ada, bob, carol])

    s = B.Store()
    _enrollment(s)
    fall = s.Term(lambda t: t.code("2026-FA").starts("2026-09-01"))
    cs101 = s.Course(lambda c: c.code("CS101"))
    mia = s.Student(lambda st: (
        st.name("Mia")
        .enrollments(lambda a: a.insert(lambda x: x.course(cs101).term(fall).credits(4).score(3.75).audit(False)))
        .enrollments(lambda a: a.insert(lambda x: x.course(lambda c: c.code("MA201")).term(fall).credits(3).score(-0.0)))))
    noah = s.Student(lambda st: st.name("Noah").enrollments(lambda a: a.insert(lambda x: x.course(cs101).term(fall).audit(True))))
    cases["enrollment"] = (s, [fall, cs101, mia, noah])

    s = B.Store()
    _yaml_strings(s)
    tricky = ["yes", "No", "on", "OFF", "y", "true", "null", "~", "", "010", "0o17", "0x1F", "1e3", "1_000", "1:30",
              "2026-09-01", ".inf", ".nan", "NaN", "Infinity", "-0.0", "+1", " lead", "trail ", "a: b", "- dash",
              "#hash", "x #y", '"dq"', "'sq'", "@at", "`tick", "%pct", "!bang", "&amp", "*star", "|", ">", "{}", "[]",
              ",", "?", "<<", "---", "...", "a\nb", "\t", "\x00", "\x07\x7f\x9b", "﻿bom", "a\x85b", "a b",
              "日本語 🚀", "word " * 30]
    notebook = s.Notebook(lambda n: n.title("tricky"))
    notes = []
    for page, value in enumerate(tricky):
        note = s.Note(lambda n, value=value: n.text(value))
        notes.append(note)
        s.Notebook(notebook, lambda n, note=note, page=page: n.notes(lambda a: a.insert(lambda x: x.note(note).page(page))))
    cases["yaml_strings"] = (s, [notebook, *notes])

    s = B.Store()
    _embedded(s)
    deck = s.Deck(lambda d: d.title("contacts"))
    cards = [
        s.Card(lambda c: c.name("Ann").home(lambda p: p.as_object(lambda r: r.number("+1 555 0100").label("home").extensions(
            _put([(0, "12")])))).reach(lambda p: p.as_value(lambda a: a.as_union(lambda u: u.email(
                lambda r: r.address("ann@example.com"))))).ident(lambda p: p.as_value(lambda a: a.as_union(lambda u: u.number(7))))),
        s.Card(lambda c: c.name("Bo").reach(lambda p: p.as_value(lambda a: a.as_union(lambda u: u.phone(
            lambda r: r.number("+44 20 7946 0000"))))).ident(lambda p: p.as_value(lambda a: a.as_union(lambda u: u.code("B-2"))))
            .meta(lambda p: p.as_value(lambda a: a.as_intersection(lambda i: i.stamp(lambda r: r.updated("2026-09-29")).audit(
                lambda r: r.updated("2026-09-29").by("ann")))))),
        s.Card(lambda c: c.name("Cy")),
    ]
    for card in cards:
        s.Deck(deck, lambda d, card=card: d.cards(lambda a: a.insert(lambda x: x.card(card))))
    cases["embedded"] = (s, [deck, *cards])

    s = B.Store()
    _lists(s)
    board = s.Board(lambda r: (
        r.name("rack").tags(_put(enumerate(["", "日本語 🚀", "a"]))).blobs(_put(enumerate([b"", b"\x00\xff"])))
        .grid(_put([(i, lambda e, row=row: e.as_container(_write(enumerate(row))))
                    for i, row in enumerate([[1, -(2**70)], [], [0]])]))
        .readings(_put([(0, lambda e: e.as_union(lambda u: u.value(-0.0))), (1, lambda e: e.as_union(lambda u: u.note("off"))),
                        (2, lambda e: e.as_union(lambda u: u.value(math.inf)))]))
        .sockets(_put([(0, lambda e: e.as_object(lambda o: o.name("in").pins(_put([(0, "1"), (1, "2")])))),
                       (1, lambda e: e.as_object(lambda o: o.name("out")))]))
        .banks(_put([(0, lambda e: e.as_object(lambda b: b)), (1, lambda e: e.as_object(lambda b: b.sockets(_put(
            [(0, lambda x: x.as_object(lambda o: o.name("spare").pins(_put([(0, "9")]))))]))))]))
        .matrix(_put([((2, 1), 0), ((1, 1), 1), ((1, 2), 0), ((2, 2), 1)]))
        .cells(_put([(5, 6), (6, 7), (0, 0)]))
        .attrs(_put([("gain", 1.5), ("", -0.0)]))
        .weights(_put([(0.5, "half"), (-2.5, "neg")]))))
    cases["lists"] = (s, [board])

    s = B.Store()
    _module(s)
    cases["module"] = (s, [])
    return cases
