# University example: a three-link relation, entry property equality, and schema inference through links.
#
# Covers a ternary relation (student, course, term) with ISO 8601 dates, entries distinguished by float / int / bool
# values, an ambiguous link that refuses inline creation, the builder not validating scalar types, and round trips.

import math

from mbse.Schemas.Framework import Builders, Schemas, Plain, Reachable, Validators
from mbse.Schemas.Examples._support import entries, raises


store = Builders.Store()
Text = store.Schemas.OfStr.as_schema()  # the store's own basic scalar


def text(name):
    return lambda t: t.name(name).schema([Text])


# --- Schemas ---

with store.transaction():  # every write to a store is made within a transaction, all or nothing
    Student = store.Schemas.OfObject(lambda o: o.name('Student').ref(True).properties([text('name'), text('student_id')]))
    Staff = store.Schemas.OfObject(lambda o: o.name('Staff').ref(True).properties([text('name'), text('staff_id')]))
    Course = store.Schemas.OfObject(lambda o: o.name('Course').ref(True).properties([text('code'), text('title')]))
    Term = store.Schemas.OfObject(lambda o: (
        o
        .name('Term')
        .ref(True)
        .properties([text('code'), text('starts'), text('ends')])  # ISO 8601 dates, e.g. '2026-09-01'
    ))
    Room = store.Schemas.OfObject(lambda o: o.name('Room').ref(True).properties([text('building'), text('number')]))

    # Three links: each entry is one student taking one course in one term.
    Enrollment = store.Schemas.OfRelation(lambda r: (
        r
        .name('Enrollment')
        .links([
            lambda t: t.name('student'),
            lambda t: t.name('course'),
            lambda t: t.name('term'),
        ])
        .properties([
            lambda t: t.name('credits').schema([store.Schemas.OfInt]),
            lambda t: t.name('score').schema([store.Schemas.OfFloat]),
            lambda t: t.name('audit').schema([store.Schemas.OfBool]),
        ])
        .uniques(['score', 'audit', 'credits'])  # (student, course, term) determine the rest
    ))

    # Both Student and Staff can book rooms, so the 'booker' link is filled by more than one schema.
    Booking = store.Schemas.OfRelation(lambda r: (
        r
        .name('Booking')
        .links([
            lambda t: t.name('booker'),
            lambda t: t.name('room'),
        ])
        .properties([text('starts')])  # ISO 8601 date-time, e.g. '2026-09-14T09:00:00Z'
    ))

    store.Schemas.OfObject(Student, lambda o: o.adjacencies([
        lambda t: t.name('enrollments').relation([Enrollment]).me('student'),
        lambda t: t.name('bookings').relation([Booking]).me('booker'),
    ]))
    store.Schemas.OfObject(Staff, lambda o: o.adjacencies([lambda t: t.name('bookings').relation([Booking]).me('booker')]))
    store.Schemas.OfObject(Course, lambda o: o.adjacencies([lambda t: t.name('enrollments').relation([Enrollment]).me('course')]))
    store.Schemas.OfObject(Term, lambda o: o.adjacencies([lambda t: t.name('enrollments').relation([Enrollment]).me('term')]))
    store.Schemas.OfObject(Room, lambda o: o.adjacencies([lambda t: t.name('bookings').relation([Booking]).me('room')]))

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


    def enroll(student, **props):
        def spec(x):
            x.course(cs101).term(fall)
            for key, value in props.items():
                getattr(x, key)(value)
            return x

        store.Student(student, lambda s: s.enrollments(lambda a: a.insert(spec)))


    enroll(noah, score=0.0)
    enroll(noah, score=-0.0)  # floats compare by bit pattern: -0.0 is a different entry
    enroll(noah, score=math.nan)
    enroll(noah, score=float('nan'))  # all NaNs are equal: elided
    assert len(entries(Student, noah, 'enrollments')) == 3

    zoe = store.Student(lambda s: s.name('Zoe'))
    enroll(zoe, credits=1)
    enroll(zoe, credits=True)  # the builder does not validate scalar types, and True is a different value from 1


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
