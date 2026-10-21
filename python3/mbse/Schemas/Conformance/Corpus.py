"""The conformance corpus: the same cases, built statement for statement in every implementation.

`build()` returns `{case: (store, objects)}`: each case built in a store of its own, its schemas and its data, written as
the store's snapshot, two transactions (docs/SERIALIZATION.md, Snapshots); `objects` holds the case's data, which a
store holds weakly. Each implementation writes its snapshots to `conformance/<implementation>/<case>.json` and `.yaml`, and checks
them against every other implementation's files (see the CONF test suite). Keep this module and
`typescript5/src/Conformance/Corpus.ts` in lockstep: same schemas, same names, same values, same order of statements.
"""

from __future__ import annotations

import math

from mbse.Schemas.Framework import Builders as B

CASES = ["address_book", "scalars", "family", "enrollment", "yaml_strings", "embedded", "lists", "module"]

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


def _hold(s, objects):
    """The case's root, `Corpus.Root` (`rooted`), holding its data: a store's snapshot holds what its singletons reach."""

    def hold(adjacency):
        for item in objects:
            adjacency.insert(lambda e, item=item: e.item(item))
        return adjacency

    s.Corpus.Root(s.singleton("corpus"), lambda r: r.holds(hold))


# --- Schemas, each group a module-scope install (docs/proposals/install) ---


def rooted(txn):
    """Corpus.Root, the case's root, a singleton holding its data: a store's snapshot holds what its singletons reach."""
    S = txn.Schemas
    return txn.uid("corpus.rooted/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Holds": S.OfRelation, "Root": S.OfObject})
        .spec([
            lambda _: _.Holds.name("Corpus.Holds").links([lambda t: t.name("corpus"), lambda t: t.name("item")]),
            lambda _: _.Root.name("Corpus.Root").ref(True).singleton("corpus").adjacencies({
                "holds": lambda a: a.relation([_.Holds]).me("corpus")}),
        ])]))])


def address_book(txn):
    S = txn.Schemas
    return txn.uid("corpus.address_book/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Contact": S.OfObject, "Address": S.OfObject, "Phone": S.OfObject, "ContactAddresses": S.OfRelation,
                  "ContactPhones": S.OfRelation})
        .spec([
            lambda _: _.Contact.name("Contact").ref(True).properties({
                "given_name": S.OfStr, "family_name": S.OfStr, "birth_date": S.OfStr,
            }).adjacencies({
                "addresses": lambda a: a.relation([_.ContactAddresses]).me("contact"),
                "phones": lambda a: a.relation([_.ContactPhones]).me("contact"),
            }),
            lambda _: _.Address.name("Address").ref(True).properties({
                "street1": S.OfStr, "locality": S.OfStr, "postal_code": S.OfStr, "country_code": S.OfStr,
            }).adjacencies({"contacts": lambda a: a.relation([_.ContactAddresses]).me("address")}),
            lambda _: _.Phone.name("Phone").ref(True).properties({"number": S.OfStr}).adjacencies({
                "contacts": lambda a: a.relation([_.ContactPhones]).me("phone")}),
            lambda _: _.ContactAddresses.name("ContactAddresses").links([
                lambda t: t.name("contact"), lambda t: t.name("address")]).properties({"label": S.OfStr}),
            lambda _: _.ContactPhones.name("ContactPhones").links([
                lambda t: t.name("contact"), lambda t: t.name("phone")]).properties({"label": S.OfStr}),
        ])]))])


def scalars(txn):
    S = txn.Schemas
    return txn.uid("corpus.scalars/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Bag": S.OfObject, "Sample": S.OfObject, "Holds": S.OfRelation})
        .spec([
            lambda _: _.Bag.name("Bag").ref(True).properties({"name": S.OfStr}).adjacencies({
                "items": lambda a: a.relation([_.Holds]).me("bag")}),
            lambda _: _.Sample.name("Sample").ref(True).properties({
                "label": S.OfStr, "payload": S.OfBytes, "count": S.OfInt, "ratio": S.OfFloat, "flag": S.OfBool,
            }).adjacencies({"bags": lambda a: a.relation([_.Holds]).me("item")}),
            lambda _: _.Holds.name("Holds").links([lambda t: t.name("bag"), lambda t: t.name("item")]).properties({
                "slot": S.OfInt}).uniques(["bag", "slot"]),
        ])]))])


def family(txn):
    S = txn.Schemas
    return txn.uid("corpus.family/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Person": S.OfObject, "Parentage": S.OfRelation, "Mentorship": S.OfRelation})
        .spec([
            lambda _: _.Person.name("Person").ref(True).properties({"given_name": S.OfStr, "birth_date": S.OfStr}).adjacencies({
                "children": lambda a: a.relation([_.Parentage]).me("parent"),
                "parents": lambda a: a.relation([_.Parentage]).me("child"),
                "mentees": lambda a: a.relation([_.Mentorship]).me("mentor"),
                "mentors": lambda a: a.relation([_.Mentorship]).me("mentee"),
            }),
            lambda _: _.Parentage.name("Parentage").links([lambda t: t.name("parent"), lambda t: t.name("child")]).properties({
                "kind": S.OfStr}),
            lambda _: _.Mentorship.name("Mentorship").links([lambda t: t.name("mentor"), lambda t: t.name("mentee")]),
        ])]))])


def enrollment(txn):
    S = txn.Schemas
    return txn.uid("corpus.enrollment/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Student": S.OfObject, "Course": S.OfObject, "Term": S.OfObject, "Enrollment": S.OfRelation})
        .spec([
            lambda _: _.Student.name("Student").ref(True).properties({"name": S.OfStr}).adjacencies({
                "enrollments": lambda a: a.relation([_.Enrollment]).me("student")}),
            lambda _: _.Course.name("Course").ref(True).properties({"code": S.OfStr}).adjacencies({
                "enrollments": lambda a: a.relation([_.Enrollment]).me("course")}),
            lambda _: _.Term.name("Term").ref(True).properties({"code": S.OfStr, "starts": S.OfStr}).adjacencies({
                "enrollments": lambda a: a.relation([_.Enrollment]).me("term")}),
            lambda _: _.Enrollment.name("Enrollment").links([
                lambda t: t.name("student"), lambda t: t.name("course"), lambda t: t.name("term"),
            ]).properties({"credits": S.OfInt, "score": S.OfFloat, "audit": S.OfBool}),
        ])]))])


def yaml_strings(txn):
    S = txn.Schemas
    return txn.uid("corpus.yaml_strings/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Notebook": S.OfObject, "Note": S.OfObject, "Pages": S.OfRelation})
        .spec([
            lambda _: _.Notebook.name("Notebook").ref(True).properties({"title": S.OfStr}).adjacencies({
                "notes": lambda a: a.relation([_.Pages]).me("notebook")}),
            lambda _: _.Note.name("Note").ref(True).properties({"text": S.OfStr}).adjacencies({
                "notebooks": lambda a: a.relation([_.Pages]).me("note")}),
            lambda _: _.Pages.name("Pages").links([lambda t: t.name("notebook"), lambda t: t.name("note")]).properties({
                "page": S.OfInt}),
        ])]))])


def embedded(txn):
    """Value objects (one with a container of its own), union values of objects and of scalars, and an intersection
    value."""
    S = txn.Schemas
    return txn.uid("corpus.embedded/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"CardPhone": S.OfObject, "Card": S.OfObject, "Holding": S.OfRelation, "Deck": S.OfObject})
        .spec([
            lambda _: _.CardPhone.name("CardPhone").properties({
                "number": S.OfStr, "label": S.OfStr,
                "extensions": S.OfContainer(lambda c: c.index([S.OfInt]).element([S.OfStr])),
            }),
            lambda _: _.Card.name("Card").ref(True).properties({
                "name": S.OfStr,
                "home": _.CardPhone,
                "reach": S.OfUnion(lambda n: n.branches([
                    lambda t: t.name("phone").schema([_.CardPhone]),
                    lambda t: t.name("email").schema([S.OfObject(lambda o: o.properties({"address": S.OfStr}))]),
                ])),
                "ident": S.OfUnion(lambda n: n.branches([
                    lambda t: t.name("number").schema([S.OfInt]),
                    lambda t: t.name("code").schema([S.OfStr]),
                ])),
                "meta": S.OfIntersection(lambda i: i.parts([
                    lambda t: t.name("stamp").schema([S.OfObject(lambda o: o.properties({"updated": S.OfStr}))]),
                    lambda t: t.name("audit").schema([S.OfObject(lambda o: o.properties({"by": S.OfStr, "updated": S.OfStr}))]),
                ])),
            }).adjacencies({"decks": lambda a: a.relation([_.Holding]).me("card")}),
            lambda _: _.Holding.name("Holding").links([lambda t: t.name("deck"), lambda t: t.name("card")]),
            lambda _: _.Deck.name("Deck").ref(True).properties({"title": S.OfStr}).adjacencies({
                "cards": lambda a: a.relation([_.Holding]).me("deck")}),
        ])]))])


def lists(txn):
    """Containers, dense by position: of scalars, of containers, of union values and of value objects, which hold
    containers of their own; a tensor by a pair of ints, sparse by an int, a dict by text, and entries by a float."""
    S = txn.Schemas
    return txn.uid("corpus.lists/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Socket": S.OfObject, "Board": S.OfObject})
        .spec([
            lambda _: _.Socket.name("Socket").properties({
                "name": S.OfStr, "pins": S.OfContainer(lambda c: c.index([S.OfInt]).element([S.OfStr]))}),
            lambda _: _.Board.name("Board").ref(True).properties({
                "name": S.OfStr,
                "tags": S.OfContainer(lambda c: c.index([S.OfInt]).element([S.OfStr])),
                "blobs": S.OfContainer(lambda c: c.index([S.OfInt]).element([S.OfBytes])),
                "grid": S.OfContainer(lambda c: c.index([S.OfInt]).element([
                    S.OfContainer(lambda r: r.index([S.OfInt]).element([S.OfInt]))])),
                "readings": S.OfContainer(lambda c: c.index([S.OfInt]).element([S.OfUnion(lambda n: n.branches([
                    lambda t: t.name("value").schema([S.OfFloat]), lambda t: t.name("note").schema([S.OfStr])]))])),
                "sockets": S.OfContainer(lambda c: c.index([S.OfInt]).element([_.Socket])),
                "banks": S.OfContainer(lambda c: c.index([S.OfInt]).element([S.OfObject(lambda o: o.properties({
                    "sockets": S.OfContainer(lambda k: k.index([S.OfInt]).element([_.Socket]))}))])),
                "matrix": S.OfContainer(lambda c: c.index([S.OfObject(lambda o: o.properties({
                    "r": S.OfInt, "c": S.OfInt}))]).element([S.OfInt])),
                "cells": S.OfContainer(lambda c: c.index([S.OfInt]).element([S.OfInt]).layout("sparse")),
                "attrs": S.OfContainer(lambda c: c.index([S.OfStr]).element([S.OfFloat])),
                "weights": S.OfContainer(lambda c: c.index([S.OfFloat]).element([S.OfStr])),
            }),
        ])]))])


def module(txn):
    """The corpus's own schemas as data, beside the address book's, the family's, the embedded values' and the lists':
    parametric schemas, whose parameters are names, a flat union and a flat intersection."""
    S = txn.Schemas
    return txn.uid("corpus.module/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Grid": S.OfObject, "Tricky": S.OfObject, "Choice": S.OfUnion, "Marked": S.OfIntersection})
        .spec([
            lambda _: _.Grid.name("Grid").parameters([
                lambda t: t.name("n").description("Its side"), lambda t: t.name("x"),
            ]).properties({"mask": S.OfInt, "cells": S.OfContainer(lambda c: c.index([S.OfInt]).element([S.OfInt]))}),
            lambda _: _.Tricky.name("Tricky").parameters([
                lambda t: t.name("a"), lambda t: t.name("b"), lambda t: t.name("c"), lambda t: t.name("d")]),
            lambda _: _.Choice.name("Choice").flat(True).branches([
                lambda t: t.name("n").schema([S.OfInt]), lambda t: t.name("s").schema([S.OfStr])]),
            lambda _: _.Marked.name("Marked").flat(True).parts([
                lambda t: t.name("when").schema([S.OfObject(lambda o: o.properties({"at": S.OfInt}))]),
                lambda t: t.name("who").schema([S.OfObject(lambda o: o.properties({"by": S.OfStr}))]),
            ]),
        ])]))])


def patterns(txn):
    """A pattern over the address book's schemas, with a variable, a constraint and a spec, and a collector of it with
    an expression: recorded once the schemas it names are installed."""
    S = txn.Schemas
    return txn.uid("corpus.patterns/1").mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({"Lives": S.OfPattern, "Homes": S.OfCollector})
        .spec([
            lambda _: _.Lives.name("Lives").description("Who lives where").symbols([
                lambda t: t.name("who").schema([txn.Contact]),
                lambda t: t.name("where").schema([txn.Address]).description("A home"),
            ]).variables([
                lambda t: t.name("since").schema([S.OfStr]),
            ]).requires([
                lambda c: c.description("lived there since").result([S.OfBool]),
            ]).parameters([
                lambda t: t.name("era"),
            ]).spec([
                lambda _: _.who.addresses({"home": _.where}),
                lambda _: _.where.locality("London"),
            ]),
            lambda _: _.Homes.name("Homes").pattern([_.Lives]).symbols(["where"]).commutative(True).associative(True)
            .suffixes({"current": "_here", "next": "_there"})
            .computes([S.OfExpression(lambda e: e.pattern([_.Lives]).result([S.OfInt]))]),
        ])]))])


# --- The cases ---


def build():
    """The corpus: each case's store, and the data built in it."""
    cases = {}

    s = B.Store()
    s.transaction(address_book)
    s.transaction(rooted)
    with s.transaction():  # the case's data, one transaction
        home = s.Address(lambda a: a.street1("10 Downing Street").locality("London").postal_code("SW1A 2AA").country_code("GB"))
        alice = s.Contact(lambda c: (
            c.given_name("Alice").family_name("Liddell").birth_date("1852-05-04")
            .addresses(lambda a: a.insert(lambda x: x.address(home).label("home")))
            .phones(lambda a: a.insert(lambda x: x.phone(lambda p: p.number("+447700900123")).label("mobile")))
            .phones(lambda a: a.insert(lambda x: x.phone(lambda p: p.number("+14155550100")).label("work")))))
        bob = s.Contact(lambda c: c.given_name("Bob").addresses(lambda a: a.insert(lambda x: x.address(home).label("home"))))
        _hold(s, [home, alice, bob])
        cases["address_book"] = (s, [home, alice, bob])

    s = B.Store()
    s.transaction(scalars)
    s.transaction(rooted)
    with s.transaction():  # the case's data, one transaction
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
        _hold(s, [bag, *items])
        cases["scalars"] = (s, [bag, *items])

    s = B.Store()
    s.transaction(family)
    s.transaction(rooted)
    with s.transaction():  # the case's data, one transaction
        ada = s.Person(lambda p: p.given_name("Ada").birth_date("1815-12-10"))
        bob = s.Person(lambda p: p.given_name("Bob").parents(lambda a: a.insert(lambda x: x.parent(ada).kind("biological"))))
        carol = s.Person(lambda p: p.given_name("Carol").children(lambda a: a.insert(
            lambda x: x.child(lambda y: y.given_name("Dan").birth_date("2001-02-03")).kind("adoptive"))))
        s.Person(ada, lambda p: p.mentees(lambda a: a.insert(lambda x: x.mentee(bob))))
        s.Person(carol, lambda p: p.mentees(lambda a: a.insert(lambda x: x.mentee(carol))))
        s.Person(bob, lambda p: p.mentees(lambda a: a.insert(lambda x: x.mentee(ada))))
        _hold(s, [ada, bob, carol])
        cases["family"] = (s, [ada, bob, carol])

    s = B.Store()
    s.transaction(enrollment)
    s.transaction(rooted)
    with s.transaction():  # the case's data, one transaction
        fall = s.Term(lambda t: t.code("2026-FA").starts("2026-09-01"))
        cs101 = s.Course(lambda c: c.code("CS101"))
        mia = s.Student(lambda st: (
            st.name("Mia")
            .enrollments(lambda a: a.insert(lambda x: x.course(cs101).term(fall).credits(4).score(3.75).audit(False)))
            .enrollments(lambda a: a.insert(lambda x: x.course(lambda c: c.code("MA201")).term(fall).credits(3).score(-0.0)))))
        noah = s.Student(lambda st: st.name("Noah").enrollments(lambda a: a.insert(lambda x: x.course(cs101).term(fall).audit(True))))
        _hold(s, [fall, cs101, mia, noah])
        cases["enrollment"] = (s, [fall, cs101, mia, noah])

    s = B.Store()
    s.transaction(yaml_strings)
    s.transaction(rooted)
    with s.transaction():  # the case's data, one transaction
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
        _hold(s, [notebook, *notes])
        cases["yaml_strings"] = (s, [notebook, *notes])

    s = B.Store()
    s.transaction(embedded)
    s.transaction(rooted)
    with s.transaction():  # the case's data, one transaction
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
        _hold(s, [deck, *cards])
        cases["embedded"] = (s, [deck, *cards])

    s = B.Store()
    s.transaction(lists)
    s.transaction(rooted)
    with s.transaction():  # the case's data, one transaction
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
        _hold(s, [board])
        cases["lists"] = (s, [board])

    s = B.Store()
    for install in (address_book, family, embedded, lists, module, patterns, rooted):
        s.transaction(install)
    with s.transaction():  # the case's data, none but its root's
        _hold(s, [])
    cases["module"] = (s, [])
    return cases
