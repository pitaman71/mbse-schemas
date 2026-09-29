# University example: a three-link relation, entry property equality, and schema inference through links.
#
# Covers a ternary relation (student, course, term) with ISO 8601 dates, entries distinguished by float / int / bool
# values, an ambiguous link that refuses inline creation, the builder not validating native types, and round trips.

import math

from schemas.Framework import Schemas, Proxies, Plain, Reachable, Validators
from schemas.Examples._support import entries, raises, same_graph


def text(name):
    return lambda prop: prop.name(name).of(lambda t: t.as_native(str))


# --- Schemas ---

Student = Schemas.OfObject.Builder().properties(text('name'), text('student_id')).create()
Staff = Schemas.OfObject.Builder().properties(text('name'), text('staff_id')).create()
Course = Schemas.OfObject.Builder().properties(text('code'), text('title')).create()
Term = (
    Schemas.OfObject.Builder()
    .properties(text('code'), text('starts'), text('ends'))  # ISO 8601 dates, e.g. '2026-09-01'
    .create()
)
Room = Schemas.OfObject.Builder().properties(text('building'), text('number')).create()

# Three links: each entry is one student taking one course in one term.
Enrollment = (
    Schemas.OfRelation.Builder()
    .links('student', 'course', 'term')
    .properties(
        lambda prop: prop.name('credits').of(lambda t: t.as_native(int)),
        lambda prop: prop.name('score').of(lambda t: t.as_native(float)),
        lambda prop: prop.name('audit').of(lambda t: t.as_native(bool)),
    )
    .unique('score', 'audit', 'credits')  # (student, course, term) determine the rest
    .create()
)

# Both Student and Staff can book rooms, so the 'booker' link is filled by more than one schema.
Booking = (
    Schemas.OfRelation.Builder()
    .links('booker', 'room')
    .properties(text('starts'))  # ISO 8601 date-time, e.g. '2026-09-14T09:00:00Z'
    .create()
)

Student = (
    Schemas.OfObject.Builder(Student)
    .relations(
        lambda adj: adj.name('enrollments').of(Enrollment).me('student'),
        lambda adj: adj.name('bookings').of(Booking).me('booker'),
    )
    .update()
)
Staff = Schemas.OfObject.Builder(Staff).relations(lambda adj: adj.name('bookings').of(Booking).me('booker')).update()
Course = Schemas.OfObject.Builder(Course).relations(lambda adj: adj.name('enrollments').of(Enrollment).me('course')).update()
Term = Schemas.OfObject.Builder(Term).relations(lambda adj: adj.name('enrollments').of(Enrollment).me('term')).update()
Room = Schemas.OfObject.Builder(Room).relations(lambda adj: adj.name('bookings').of(Booking).me('room')).update()

for name, schema in [('Student', Student), ('Staff', Staff), ('Course', Course), ('Term', Term), ('Room', Room),
                     ('Enrollment', Enrollment), ('Booking', Booking)]:
    assert schema.validate() == [], (name, schema.validate())
    Proxies.register(name, schema)
Builders = Proxies.Builders

# --- A three-link relation ---

fall = Builders.Term().code('2026-FA').starts('2026-09-01').ends('2026-12-18').create()
cs101 = Builders.Course().code('CS101').title('Programs and Data').create()

# From the student's side, an entry sets the two other links; inline creation works because only Course fills 'course'.
mia = (
    Builders.Student()
    .name('Mia')
    .student_id('S-0001')
    .enrollments(lambda x: x.course(cs101).term(fall).credits(4))
    .enrollments(lambda x: x.course(lambda c: c.code('MA201').title('Linear Algebra')).term(fall).credits(3))
    .create()
)
assert sorted(e['course'].code for e in entries(Student, mia, 'enrollments')) == ['CS101', 'MA201']

# The same fact is visible from all three ends.
assert [e['student'] for e in entries(Course, cs101, 'enrollments')] == [mia]
assert {e['course'].code for e in entries(Term, fall, 'enrollments')} == {'CS101', 'MA201'}

# Entries from one end carry the two other links; the object's own link is implied.
assert set(entries(Term, fall, 'enrollments')[0]) == {'student', 'course', 'credits'}

# Every link other than the object's own must be set.
with raises(ValueError):
    Builders.Student().name('Noah').enrollments(lambda x: x.course(cs101)).create()

# --- Entry property equality follows schema equality, not host-language == ---

noah = Builders.Student().name('Noah').create()


def enroll(student, **props):
    def spec(x):
        x.course(cs101).term(fall)
        for key, value in props.items():
            getattr(x, key)(value)
        return x

    Builders.Student(student).enrollments(spec).update()


enroll(noah, score=0.0)
enroll(noah, score=-0.0)  # floats compare by bit pattern: -0.0 is a different entry
enroll(noah, score=math.nan)
enroll(noah, score=float('nan'))  # all NaNs are equal: elided
assert len(entries(Student, noah, 'enrollments')) == 3

zoe = Builders.Student().name('Zoe').create()
enroll(zoe, credits=1)
enroll(zoe, credits=True)  # the builder does not validate native types, and True is a different value from 1


def credits_of(entry):
    found = []
    if entry.has('credits'):
        entry.property('credits', lambda p: p.value(lambda v: v.as_native(lambda n: found.append(n.get()))))
    return found[0] if found else None


values = []
Builders.Student(zoe).adjacency('enrollments', lambda a: a.entries(lambda e: values.append(credits_of(e))))
assert len(values) == 2 and {type(v) for v in values} == {int, bool}

# Serializing checks native types: a bool where the schema says int is rejected, and so is anything reaching it.
with raises(TypeError):
    Plain.ToPlain(Student, zoe)
with raises(TypeError):
    Plain.ToPlain.Reachable(Term, fall)

# Validation reports it, only when asked, with a path to the value.
validate = Validators.Validate(Proxies.Builders)
assert validate(Student, zoe) == [
    'Student#0.enrollments[1].credits: expected int, got bool',
    # Her two enrollments also share (student, course, term), which Enrollment's unique(...) clause forbids.
    "unique(audit, credits, score) violated: entries agreeing on ['course', 'student', 'term'] differ on "
    "['audit', 'credits', 'score']",
]

# Noah's three enrollments share (student, course, term), which Enrollment's unique(...) clause says determine the rest.
assert any(p.startswith('unique(audit, credits, score) violated') for p in validate(Student, noah))

# A linked object must have a schema that fills that link: here a Student is linked as a course.
Builders.Student(noah).enrollments(lambda x: x.course(mia).term(fall)).update()
assert any("a 'Student' cannot fill link 'course'" in p for p in validate(Student, noah))
Builders.Student(noah).adjacency(
    'enrollments', lambda a: a.entries(lambda e: e.link('course', lambda k: k.target(
        lambda t: a.remove(e) if t is mia else None)))
).update()
assert not any('cannot fill' in p for p in validate(Student, noah))

# Remove the bad entry so the rest of the example can serialize.
Builders.Student(zoe).adjacency(
    'enrollments', lambda a: a.entries(lambda e: a.remove(e) if type(credits_of(e)) is bool else None)
).update()
assert [e['credits'] for e in entries(Student, zoe, 'enrollments')] == [1]

# --- Schema inference through a link must be unambiguous ---

lab = Builders.Room().building('Hopper Hall').number('B12').create()

# Both Student and Staff fill 'booker', so building one inline from the room's side is refused...
with raises(TypeError):
    Builders.Room(lab).bookings(lambda x: x.booker(lambda b: b.name('?')).starts('2026-09-14T09:00:00Z')).update()

# ...but linking an existing object works, whichever schema it has.
grace = Builders.Staff().name('Grace').staff_id('F-0042').create()
Builders.Room(lab).bookings(lambda x: x.booker(grace).starts('2026-09-14T09:00:00Z')).update()
Builders.Room(lab).bookings(lambda x: x.booker(mia).starts('2026-09-15T13:30:00Z')).update()
assert sorted(e['booker'].schema_name() for e in entries(Room, lab, 'bookings')) == ['Staff', 'Student']

# References carry the schema name, so restoring knows Grace is Staff and Mia is a Student.
graph = Plain.ToPlain.Reachable(Room, lab)
restored = Plain.FromPlain(Proxies.Builders).Reachable(Room, graph)
bookers = {e['booker'].name: e['booker'].schema_name() for e in entries(Room, restored, 'bookings')}
assert bookers == {'Grace': 'Staff', 'Mia': 'Student'}

# --- Reachability and round trips across the three-link relation ---

component = Reachable.of(fall)
assert component[0] is fall
assert {o.schema_name() for o in component} == {'Term', 'Student', 'Course', 'Room', 'Staff'}

for root, schema in [(fall, Term), (mia, Student), (noah, Student)]:
    graph = Plain.ToPlain.Reachable(schema, root)
    restored = Plain.FromPlain(Proxies.Builders).Reachable(schema, graph)
    assert restored is not root and same_graph(Plain.ToPlain.Reachable(schema, restored), graph)

# Apart from Noah's duplicate enrollments, the whole component is valid.
problems = validate.Reachable(Term, fall)
assert len(problems) == 1 and problems[0].startswith('unique('), problems

# -0.0 keeps its sign through a round trip.
scores = [e.get('score') for e in entries(Student, noah, 'enrollments')]
assert any(s == 0.0 and math.copysign(1, s) < 0 for s in scores)

print('University: all checks passed')
