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

def _basics(s):
    """The basic scalars of the store `s`, each its own: bool, int, float, str and bytes."""
    return s.Schemas.OfBool, s.Schemas.OfInt, s.Schemas.OfFloat, s.Schemas.OfStr, s.Schemas.OfBytes


def _text(s, name, scalar=None):
    return lambda t: t.name(name).schema([scalar if scalar is not None else s.Schemas.OfStr])


def _list(store, name, element, index=None, layout=None):
    """A property `name` holding a container of `element` by `index`: dense by position, by default."""

    def container(c):
        c.index([index if index is not None else store.Schemas.OfInt]).element([element])
        return c.layout(layout) if layout is not None else c

    return lambda t: t.name(name).schema([store.Schemas.OfContainer(container)])


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


def _rooted(s, objects):
    """The case's root, a singleton holding its data: a store's snapshot holds what its singletons reach."""
    Holds = s.Schemas.OfRelation(lambda r: r.name("Corpus.Holds").links([lambda t: t.name("corpus"), lambda t: t.name("item")]))
    s.Schemas.OfObject(lambda o: o.name("Corpus.Root").ref(True).singleton("corpus").adjacencies([
        lambda t: t.name("holds").relation([Holds]).me("corpus"),
    ]))

    def hold(adjacency):
        for item in objects:
            adjacency.insert(lambda e, item=item: e.item(item))
        return adjacency

    s.Corpus.Root(s.singleton("corpus"), lambda r: r.holds(hold))


# --- Schemas, each group built in the store given ---


def _address_book(s):
    Contact = s.Schemas.OfObject(lambda o: o.name("Contact").ref(True).properties([
        _text(s, "given_name"), _text(s, "family_name"), _text(s, "birth_date")]))
    Address = s.Schemas.OfObject(lambda o: o.name("Address").ref(True).properties([
        _text(s, "street1"), _text(s, "locality"), _text(s, "postal_code"), _text(s, "country_code")]))
    Phone = s.Schemas.OfObject(lambda o: o.name("Phone").ref(True).properties([_text(s, "number")]))
    ContactAddresses = s.Schemas.OfRelation(lambda r: r.name("ContactAddresses").links([
        lambda t: t.name("contact"), lambda t: t.name("address")]).properties([_text(s, "label")]))
    ContactPhones = s.Schemas.OfRelation(lambda r: r.name("ContactPhones").links([
        lambda t: t.name("contact"), lambda t: t.name("phone")]).properties([_text(s, "label")]))
    s.Schemas.OfObject(Contact, lambda o: o.adjacencies([
        lambda t: t.name("addresses").relation([ContactAddresses]).me("contact"),
        lambda t: t.name("phones").relation([ContactPhones]).me("contact")]))
    s.Schemas.OfObject(Address, lambda o: o.adjacencies([lambda t: t.name("contacts").relation([ContactAddresses]).me("address")]))
    s.Schemas.OfObject(Phone, lambda o: o.adjacencies([lambda t: t.name("contacts").relation([ContactPhones]).me("phone")]))
    return Contact, Address, ContactAddresses


def _scalars(s):
    Bool, Int, Float, Str, Bytes = _basics(s)
    Bag = s.Schemas.OfObject(lambda o: o.name("Bag").ref(True).properties([_text(s, "name")]))
    Sample = s.Schemas.OfObject(lambda o: o.name("Sample").ref(True).properties([
        _text(s, "label"), _text(s, "payload", Bytes), _text(s, "count", Int), _text(s, "ratio", Float), _text(s, "flag", Bool)]))
    Holds = s.Schemas.OfRelation(lambda r: r.name("Holds").links([lambda t: t.name("bag"), lambda t: t.name("item")])
                               .properties([_text(s, "slot", Int)]).uniques(["bag", "slot"]))
    s.Schemas.OfObject(Bag, lambda o: o.adjacencies([lambda t: t.name("items").relation([Holds]).me("bag")]))
    s.Schemas.OfObject(Sample, lambda o: o.adjacencies([lambda t: t.name("bags").relation([Holds]).me("item")]))


def _family(s):
    Person = s.Schemas.OfObject(lambda o: o.name("Person").ref(True).properties([
        _text(s, "given_name"), _text(s, "birth_date")]))
    Parentage = s.Schemas.OfRelation(lambda r: r.name("Parentage").links([lambda t: t.name("parent"), lambda t: t.name("child")])
                                   .properties([_text(s, "kind")]))
    Mentorship = s.Schemas.OfRelation(lambda r: r.name("Mentorship").links([lambda t: t.name("mentor"), lambda t: t.name("mentee")]))
    s.Schemas.OfObject(Person, lambda o: o.adjacencies([
        lambda t: t.name("children").relation([Parentage]).me("parent"),
        lambda t: t.name("parents").relation([Parentage]).me("child"),
        lambda t: t.name("mentees").relation([Mentorship]).me("mentor"),
        lambda t: t.name("mentors").relation([Mentorship]).me("mentee")]))
    return Person, Parentage


def _enrollment(s):
    Bool, Int, Float, Str, Bytes = _basics(s)
    Student = s.Schemas.OfObject(lambda o: o.name("Student").ref(True).properties([_text(s, "name")]))
    Course = s.Schemas.OfObject(lambda o: o.name("Course").ref(True).properties([_text(s, "code")]))
    Term = s.Schemas.OfObject(lambda o: o.name("Term").ref(True).properties([
        _text(s, "code"), _text(s, "starts")]))
    Enrollment = s.Schemas.OfRelation(lambda r: r.name("Enrollment").links([
        lambda t: t.name("student"), lambda t: t.name("course"), lambda t: t.name("term")]).properties([
        _text(s, "credits", Int), _text(s, "score", Float), _text(s, "audit", Bool)]))
    s.Schemas.OfObject(Student, lambda o: o.adjacencies([lambda t: t.name("enrollments").relation([Enrollment]).me("student")]))
    s.Schemas.OfObject(Course, lambda o: o.adjacencies([lambda t: t.name("enrollments").relation([Enrollment]).me("course")]))
    s.Schemas.OfObject(Term, lambda o: o.adjacencies([lambda t: t.name("enrollments").relation([Enrollment]).me("term")]))


def _yaml_strings(s):
    Bool, Int, Float, Str, Bytes = _basics(s)
    Notebook = s.Schemas.OfObject(lambda o: o.name("Notebook").ref(True).properties([_text(s, "title")]))
    Note = s.Schemas.OfObject(lambda o: o.name("Note").ref(True).properties([_text(s, "text")]))
    Pages = s.Schemas.OfRelation(lambda r: r.name("Pages").links([lambda t: t.name("notebook"), lambda t: t.name("note")])
                               .properties([_text(s, "page", Int)]))
    s.Schemas.OfObject(Notebook, lambda o: o.adjacencies([lambda t: t.name("notes").relation([Pages]).me("notebook")]))
    s.Schemas.OfObject(Note, lambda o: o.adjacencies([lambda t: t.name("notebooks").relation([Pages]).me("note")]))


def _embedded(s):
    Bool, Int, Float, Str, Bytes = _basics(s)
    """Value objects (one with a container of its own), union values of objects and of scalars, and an intersection
    value."""
    CardPhone = s.Schemas.OfObject(lambda o: o.properties([_text(s, "number"), _text(s, "label"), _list(s, "extensions", Str)]))
    CardEmail = s.Schemas.OfObject(lambda o: o.properties([_text(s, "address")]))
    Reach = s.Schemas.OfUnion(lambda u: u.branches([lambda t: t.name("phone").schema([CardPhone]),
                                                  lambda t: t.name("email").schema([CardEmail])]))
    Ident = s.Schemas.OfUnion(lambda u: u.branches([lambda t: t.name("number").schema([Int]),
                                                  lambda t: t.name("code").schema([Str])]))
    CardStamp = s.Schemas.OfObject(lambda o: o.properties([_text(s, "updated")]))
    CardAudit = s.Schemas.OfObject(lambda o: o.properties([_text(s, "by"), _text(s, "updated")]))
    CardMeta = s.Schemas.OfIntersection(lambda i: i.parts([lambda t: t.name("stamp").schema([CardStamp]),
                                                        lambda t: t.name("audit").schema([CardAudit])]))
    Card = s.Schemas.OfObject(lambda o: o.name("Card").ref(True).properties([
        _text(s, "name"), lambda t: t.name("home").schema([CardPhone]), lambda t: t.name("reach").schema([Reach]),
        lambda t: t.name("ident").schema([Ident]), lambda t: t.name("meta").schema([CardMeta])]))
    Holding = s.Schemas.OfRelation(lambda r: r.name("Holding").links([lambda t: t.name("deck"), lambda t: t.name("card")]))
    Deck = s.Schemas.OfObject(lambda o: o.name("Deck").ref(True).properties([_text(s, "title")])
                            .adjacencies([lambda t: t.name("cards").relation([Holding]).me("deck")]))
    s.Schemas.OfObject(Card, lambda o: o.adjacencies([lambda t: t.name("decks").relation([Holding]).me("card")]))
    return Card, Deck, Holding


def _lists(s):
    Bool, Int, Float, Str, Bytes = _basics(s)
    """Containers, dense by position: of scalars, of containers, of union values and of value objects, which hold
    containers of their own; a tensor by a pair of ints, sparse by an int, a dict by text, and entries by a float."""
    Socket = s.Schemas.OfObject(lambda o: o.properties([_text(s, "name"), _list(s, "pins", Str)]))
    Coord = s.Schemas.OfObject(lambda o: o.properties([_text(s, "r", Int), _text(s, "c", Int)]))
    Reading = s.Schemas.OfUnion(lambda u: u.branches([lambda t: t.name("value").schema([Float]),
                                                    lambda t: t.name("note").schema([Str])]))
    Row = s.Schemas.OfContainer(lambda c: c.index([Int]).element([Int]))
    Bank = s.Schemas.OfObject(lambda o: o.properties([_list(s, "sockets", Socket)]))
    return s.Schemas.OfObject(lambda o: o.name("Board").ref(True).properties([
        _text(s, "name"), _list(s, "tags", Str), _list(s, "blobs", Bytes), _list(s, "grid", Row),
        _list(s, "readings", Reading), _list(s, "sockets", Socket), _list(s, "banks", Bank), _list(s, "matrix", Int, Coord),
        _list(s, "cells", Int, layout="sparse"), _list(s, "attrs", Float, Str), _list(s, "weights", Str, Float)]))


def _module(s):
    """The corpus's own schemas as data, with parametric schemas, whose parameters are names, and a pattern, with a
    locator, a variable and a constraint, an expression and a collector."""
    Bool, Int, Float, Str, Bytes = _basics(s)
    Contact, Address, _ = _address_book(s)
    _family(s)
    _embedded(s)
    _lists(s)
    s.Schemas.OfObject(lambda o: o.name("Grid").parameters([
        lambda t: t.name("n").description("Its side"), lambda t: t.name("x")]).properties([
        lambda t: t.name("mask").schema([Int]), _list(s, "cells", Int)]))
    s.Schemas.OfObject(lambda o: o.name("Tricky").parameters([lambda t, x=x: t.name(x) for x in "abcd"]))
    s.Schemas.OfUnion(lambda u: u.name("Choice").flat(True).branches([
        lambda t: t.name("n").schema([Int]), lambda t: t.name("s").schema([Str])]))
    s.Schemas.OfIntersection(lambda i: i.name("Marked").flat(True).parts([
        lambda t: t.name("when").schema([s.Schemas.OfObject(lambda o: o.properties([_text(s, "at", Int)]))]),
        lambda t: t.name("who").schema([s.Schemas.OfObject(lambda o: o.properties([_text(s, "by")]))])]))
    Lives = s.Schemas.OfPattern(lambda p: p.name("Lives").description("Who lives where").symbols([
        lambda t: t.name("who").schema([Contact]),
        lambda t: t.name("where").schema([Address]).description("A home")
        .locator(lambda l: l.symbol("who", Contact).addresses({"label": "home"}))])
        .variables([lambda t: t.name("since").schema([Str])])
        .requires([lambda c: c.description("lived there since")])
        .parameters([lambda t: t.name("era")]))
    s.Schemas.OfCollector(lambda c: c.name("Homes").pattern([Lives]).symbols(["where"]).commutative(True).associative(True)
                          .suffixes({"current": "_here", "next": "_there"})
                          .computes([s.Schemas.OfExpression(lambda e: e.pattern([Lives]).result([Int]))]))


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
    _rooted(s, [home, alice, bob])
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
    _rooted(s, [bag, *items])
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
    _rooted(s, [ada, bob, carol])
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
    _rooted(s, [fall, cs101, mia, noah])
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
    _rooted(s, [notebook, *notes])
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
    _rooted(s, [deck, *cards])
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
    _rooted(s, [board])
    cases["lists"] = (s, [board])

    s = B.Store()
    _module(s)
    _rooted(s, [])
    cases["module"] = (s, [])
    return cases
