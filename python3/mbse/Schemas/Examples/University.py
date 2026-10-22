# University example: a three-link relation, entry property equality, and schema inference through links.
#
# Covers a ternary relation (student, course, term) with ISO 8601 dates, entries distinguished by float / int / bool
# values, an ambiguous link that refuses inline creation, the builder not validating scalar types, and round trips.

import math

from mbse.Schemas.Framework import Builders, Plain, Reachable, Validators
from mbse.Schemas.Examples._support import entries, raises


# --- Schemas ---


def install(txn):
    """The university's schemas, defined in the store a transaction writes (`store.transaction(install)`), each found by
    its name, else made."""
    S = txn.Schemas  # the store's own schemas, by name
    return txn.uid('examples.university/1').mutations([lambda mu: mu.upsert(lambda u: u.exists([lambda p: p
        .symbols({
            'Student': S.OfObject, 'Staff': S.OfObject, 'Course': S.OfObject, 'Term': S.OfObject, 'Room': S.OfObject,
            'Enrollment': S.OfRelation, 'Booking': S.OfRelation,
        })
        .spec([
            lambda _: _.Student.name('Student').ref(True).properties({'name': S.OfStr, 'student_id': S.OfStr}).adjacencies({
                'enrollments': lambda a: a.relation([_.Enrollment]).me('student'),
                'bookings': lambda a: a.relation([_.Booking]).me('booker'),
            }),
            lambda _: _.Staff.name('Staff').ref(True).properties({'name': S.OfStr, 'staff_id': S.OfStr}).adjacencies({
                'bookings': lambda a: a.relation([_.Booking]).me('booker')}),
            lambda _: _.Course.name('Course').ref(True).properties({'code': S.OfStr, 'title': S.OfStr}).adjacencies({
                'enrollments': lambda a: a.relation([_.Enrollment]).me('course')}),
            lambda _: _.Term.name('Term').ref(True).properties({
                'code': S.OfStr,
                'starts': S.OfStr,  # ISO 8601 dates, e.g. '2026-09-01'
                'ends': S.OfStr,
            }).adjacencies({'enrollments': lambda a: a.relation([_.Enrollment]).me('term')}),
            lambda _: _.Room.name('Room').ref(True).properties({'building': S.OfStr, 'number': S.OfStr}).adjacencies({
                'bookings': lambda a: a.relation([_.Booking]).me('room')}),
            # Three links: each entry is one student taking one course in one term.
            lambda _: _.Enrollment.name('Enrollment').links([
                lambda t: t.name('student'),
                lambda t: t.name('course'),
                lambda t: t.name('term'),
            ]).properties({
                'credits': S.OfInt,
                'score': S.OfFloat,
                'audit': S.OfBool,
            }).uniques(['score', 'audit', 'credits']),  # (student, course, term) determine the rest
            # Both Student and Staff can book rooms, so the 'booker' link is filled by more than one schema.
            lambda _: _.Booking.name('Booking').links([
                lambda t: t.name('booker'),
                lambda t: t.name('room'),
            ]).properties({'starts': S.OfStr}),  # ISO 8601 date-time, e.g. '2026-09-14T09:00:00Z'
        ])]))])


store = Builders.Store()
store.transaction(install)  # every write to a store is made within a transaction, all or nothing
Student, Staff, Course, Term, Room, Enrollment, Booking = (
    store.registered(name) for name in ('Student', 'Staff', 'Course', 'Term', 'Room', 'Enrollment', 'Booking'))

for schema in [Student, Staff, Course, Term, Room, Enrollment, Booking]:
    assert schema.validate() == [], (schema.name, schema.validate())

# --- A three-link relation ---

with store.transaction():  # the data: written within one transaction
    fall = store.Term(lambda t: t.code('2026-FA').starts('2026-09-01').ends('2026-12-18'))
    cs101 = store.Course(lambda c: c.code('CS101').title('Programs and Data'))

    # From the student's side, an entry sets the two other links; inline creation works because only Course fills 'course'.
    mia = store.Student(lambda s: (
        s
        .name('Mia')
        .student_id('S-0001')
        .enrollments(lambda a: a.insert(lambda x: x.course(cs101).term(fall).credits(4)))
        .enrollments(lambda a: a.insert(lambda x: x.course(lambda c: c.code('MA201').title('Linear Algebra')).term(fall).credits(3)))
    ))
    assert sorted(str(e['course'].code) for e in entries(Student, mia, 'enrollments')) == ['CS101', 'MA201']

    # The same fact is visible from all three ends.
    assert [e['student'] for e in entries(Course, cs101, 'enrollments')] == [mia]
    assert {str(e['course'].code) for e in entries(Term, fall, 'enrollments')} == {'CS101', 'MA201'}

    # Entries from one end carry the two other links; the object's own link is implied.
    assert set(entries(Term, fall, 'enrollments')[0]) == {'student', 'course', 'credits'}

    # Every link other than the object's own must be set.
    with raises(ValueError):
        store.Student(lambda s: s.name('Noah').enrollments(lambda a: a.insert(lambda x: x.course(cs101))))

    # --- Entry property equality follows schema equality, not host-language == ---

    noah = store.Student(lambda s: s.name('Noah'))


    store.Student(noah, lambda s: s.enrollments(lambda a: a.insert(lambda x: x.course(cs101).term(fall).score(0.0))))
    # floats compare by bit pattern: -0.0 is a different entry
    store.Student(noah, lambda s: s.enrollments(lambda a: a.insert(lambda x: x.course(cs101).term(fall).score(-0.0))))
    store.Student(noah, lambda s: s.enrollments(lambda a: a.insert(lambda x: x.course(cs101).term(fall).score(math.nan))))
    # all NaNs are equal: elided
    store.Student(noah, lambda s: s.enrollments(lambda a: a.insert(lambda x: x.course(cs101).term(fall).score(float('nan')))))
    assert len(entries(Student, noah, 'enrollments')) == 3

    zoe = store.Student(lambda s: s.name('Zoe'))
    store.Student(zoe, lambda s: s.enrollments(lambda a: a.insert(lambda x: x.course(cs101).term(fall).credits(1))))
    # the builder does not validate scalar types, and True is a different value from 1
    store.Student(zoe, lambda s: s.enrollments(lambda a: a.insert(lambda x: x.course(cs101).term(fall).credits(True))))


    values = [e.credits.get() for e in zoe.enrollments]
    assert len(values) == 2 and {type(v) for v in values} == {int, bool}

    # Serializing checks scalar types: a bool where the schema says int is rejected, and so is anything reaching it.
    with raises(TypeError):
        Plain.ToPlain(store)(Student, zoe)
    with raises(TypeError):
        Plain.ToPlain(store).Reachable(Term, fall)

    # Validation reports it, only when asked, with a path to the value.
    validate = Validators.Validate(store)
    assert validate(Student, zoe) == [
        'Student#0.enrollments[1].credits: expected int, got bool',
        # Her two enrollments also share (student, course, term), which Enrollment's uniques clause forbids.
        "unique(audit, credits, score) violated: entries agreeing on ['course', 'student', 'term'] differ on "
        "['audit', 'credits', 'score']",
    ]

    # Noah's three enrollments share (student, course, term), which Enrollment's uniques clause says determine the rest.
    assert any(p.startswith('unique(audit, credits, score) violated') for p in validate(Student, noah))

    # A linked object must have a schema that fills that link: here a Student is linked as a course.
    store.Student(noah, lambda s: s.enrollments(lambda a: a.insert(lambda x: x.course(mia).term(fall))))
    assert any("a 'Student' cannot fill link 'course'" in p for p in validate(Student, noah))
    store.Student(noah, lambda s: s.enrollments(lambda a: a.remove(lambda e: e.course(mia))))
    assert not any('cannot fill' in p for p in validate(Student, noah))

    # Remove the bad entry so the rest of the example can serialize.
    store.Student(zoe, lambda s: s.enrollments(lambda a: a.remove(lambda e: e.credits(True))))
    assert [e['credits'] for e in entries(Student, zoe, 'enrollments')] == [1]

    # --- Schema inference through a link must be unambiguous ---

    lab = store.Room(lambda r: r.building('Hopper Hall').number('B12'))

    # Both Student and Staff fill 'booker', so building one inline from the room's side is refused...
    with raises(TypeError):
        store.Room(lab, lambda r: r.bookings(lambda a: a.insert(lambda x: x.booker(lambda b: b.name('?')).starts('2026-09-14T09:00:00Z'))))

    # ...but linking an existing object works, whichever schema it has.
    grace = store.Staff(lambda s: s.name('Grace').staff_id('F-0042'))
    store.Room(lab, lambda r: r.bookings(lambda a: a.insert(lambda x: x.booker(grace).starts('2026-09-14T09:00:00Z'))))
    store.Room(lab, lambda r: r.bookings(lambda a: a.insert(lambda x: x.booker(mia).starts('2026-09-15T13:30:00Z'))))
    assert sorted(e['booker'].as_schema().name for e in entries(Room, lab, 'bookings')) == ['Staff', 'Student']

    # References carry the schema name, so restoring knows Grace is Staff and Mia is a Student.
    graph = Plain.ToPlain(store).Reachable(Room, lab)
    restored = Plain.FromPlain(store).Reachable(Room, graph)
    bookers = {str(e['booker'].name): e['booker'].as_schema().name for e in entries(Room, restored, 'bookings')}
    assert bookers == {'Grace': 'Staff', 'Mia': 'Student'}

# --- Reachability and round trips across the three-link relation ---

component = Reachable.of(fall)
assert component[0] is fall
assert {o.as_schema().name for o in component} == {'Term', 'Student', 'Course', 'Room', 'Staff'}

archive = Builders.Store()  # another store: a document read into it builds new objects of the same graph
Plain.FromPlain(archive).Snapshot(Plain.ToPlain(store).Snapshot())  # the same schemas, its own: a store's snapshot writes them
for root, schema, its in [(fall, Term, archive.Term), (mia, Student, archive.Student), (noah, Student, archive.Student)]:
    graph = Plain.ToPlain(store).Reachable(schema, root)
    restored = Plain.FromPlain(archive).Reachable(its, graph)
    assert restored is not root
    assert Plain.ToPlain(archive).Reachable(its, restored) == graph

# Apart from Noah's duplicate enrollments, the whole component is valid.
problems = validate.Reachable(Term, fall)
assert len(problems) == 1 and problems[0].startswith('unique('), problems

# -0.0 keeps its sign through a round trip.
scores = [e.get('score') for e in entries(Student, noah, 'enrollments')]
assert any(s == 0.0 and math.copysign(1, s) < 0 for s in scores)

print('University: all checks passed')
