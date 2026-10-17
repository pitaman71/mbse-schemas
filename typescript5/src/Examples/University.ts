// University example: a three-link relation, entry property equality, and schema inference through links.
//
// Covers a ternary relation (student, course, term) with ISO 8601 dates, entries distinguished by float / int / bool
// values, an ambiguous link that refuses inline creation, the builder not validating scalar types, and round trips.

import { ValueError } from "@mbse/schemas/Framework/Errors";
import { Builders, Plain, Proxies, Reachable, Schemas, Validators } from "@mbse/schemas/Framework";
import type { Instance } from "@mbse/schemas/Framework/Proxies";
import { sortedStrings } from "@mbse/schemas/Framework/Repr";
import { assert, entries, raises, same_graph } from "./_support.js";


const store: any = new Builders.Store();
const Text = store.Schemas.OfStr.as_schema(); // the store's own basic scalar

function text(name: string) {
  return (t: any) => t.name(name).schema([Text]);
}

// --- Schemas ---

const Student = store.Schemas.OfObject((o: any) => o.name("Student").ref(true).properties([text("name"), text("student_id")]));
const Staff = store.Schemas.OfObject((o: any) => o.name("Staff").ref(true).properties([text("name"), text("staff_id")]));
const Course = store.Schemas.OfObject((o: any) => o.name("Course").ref(true).properties([text("code"), text("title")]));
const Term = store.Schemas.OfObject((o: any) => (
  o
    .name("Term")
    .ref(true)
    .properties([text("code"), text("starts"), text("ends")]) // ISO 8601 dates, e.g. '2026-09-01'
));
const Room = store.Schemas.OfObject((o: any) => o.name("Room").ref(true).properties([text("building"), text("number")]));

// Three links: each entry is one student taking one course in one term.
const Enrollment = store.Schemas.OfRelation((r: any) => (
  r
    .name("Enrollment")
    .links([
      (t: any) => t.name("student"),
      (t: any) => t.name("course"),
      (t: any) => t.name("term"),
    ])
    .properties([
      (t: any) => t.name("credits").schema([store.Schemas.OfInt]),
      (t: any) => t.name("score").schema([store.Schemas.OfFloat]),
      (t: any) => t.name("audit").schema([store.Schemas.OfBool]),
    ])
    .uniques(["score", "audit", "credits"]) // (student, course, term) determine the rest
));

// Both Student and Staff can book rooms, so the 'booker' link is filled by more than one schema.
const Booking = store.Schemas.OfRelation((r: any) => (
  r
    .name("Booking")
    .links([
      (t: any) => t.name("booker"),
      (t: any) => t.name("room"),
    ])
    .properties([text("starts")]) // ISO 8601 date-time, e.g. '2026-09-14T09:00:00Z'
));

store.Schemas.OfObject(Student, (o: any) => o.adjacencies([
  (t: any) => t.name("enrollments").relation([Enrollment]).me("student"),
  (t: any) => t.name("bookings").relation([Booking]).me("booker"),
]));
store.Schemas.OfObject(Staff, (o: any) => o.adjacencies([(t: any) => t.name("bookings").relation([Booking]).me("booker")]));
store.Schemas.OfObject(Course, (o: any) => o.adjacencies([(t: any) => t.name("enrollments").relation([Enrollment]).me("course")]));
store.Schemas.OfObject(Term, (o: any) => o.adjacencies([(t: any) => t.name("enrollments").relation([Enrollment]).me("term")]));
store.Schemas.OfObject(Room, (o: any) => o.adjacencies([(t: any) => t.name("bookings").relation([Booking]).me("room")]));

for (const schema of [Student, Staff, Course, Term, Room, Enrollment, Booking]) {
  assert(schema.validate().length === 0, `${schema.name}: ${schema.validate()}`);
}
const same = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// --- A three-link relation ---

const fall = store.Term((t: any) => t.code("2026-FA").starts("2026-09-01").ends("2026-12-18"));
const cs101 = store.Course((c: any) => c.code("CS101").title("Programs and Data"));

// From the student's side, an entry sets the two other links; inline creation works because only Course fills 'course'.
const mia = store.Student((s: any) => (
  s
    .name("Mia")
    .student_id("S-0001")
    .enrollments((a: any) => a.insert((x: any) => x.course(cs101).term(fall).credits(4n)))
    .enrollments((a: any) => a.insert((x: any) => x.course((c: any) => c.code("MA201").title("Linear Algebra")).term(fall).credits(3n)))
));
assert(same(sortedStrings(entries(Student, mia, "enrollments").map((e) => String((e.get("course") as Instance).code))), ["CS101", "MA201"]));

// The same fact is visible from all three ends.
assert(same(entries(Course, cs101, "enrollments").map((e) => e.get("student")), [mia]));
assert(same(sortedStrings(new Set(entries(Term, fall, "enrollments").map((e) => String((e.get("course") as Instance).code)))), ["CS101", "MA201"]));

// Entries from one end carry the two other links; the object's own link is implied.
assert(same(sortedStrings((entries(Term, fall, "enrollments")[0] as Map<string, unknown>).keys()), ["course", "credits", "student"]));

// Every link other than the object's own must be set.
raises(ValueError, () => store.Student((s: any) => s.name("Noah").enrollments((a: any) => a.insert((x: any) => x.course(cs101)))));

// --- Entry property equality follows schema equality, not host-language == ---

const noah = store.Student((s: any) => s.name("Noah"));

function enroll(student: Instance, props: Record<string, unknown>): void {
  const spec = (x: any) => {
    x.course(cs101).term(fall);
    for (const [key, value] of Object.entries(props)) x[key](value);
    return x;
  };
  store.Student(student, (s: any) => s.enrollments((a: any) => a.insert(spec)));
}

enroll(noah, { score: 0.0 });
enroll(noah, { score: -0.0 }); // floats compare by bit pattern: -0.0 is a different entry
enroll(noah, { score: NaN });
enroll(noah, { score: Number("NaN") }); // all NaNs are equal: elided
assert(entries(Student, noah, "enrollments").length === 3);

const zoe = store.Student((s: any) => s.name("Zoe"));
enroll(zoe, { credits: 1n });
enroll(zoe, { credits: true }); // the builder does not validate scalar types, and true is a different value from 1n

const values: unknown[] = [...zoe.enrollments].map((e: any) => e.credits.get());
assert(values.length === 2 && same(sortedStrings(new Set(values.map((v) => typeof v))), ["bigint", "boolean"]));

// Serializing checks scalar types: a bool where the schema says int is rejected, and so is anything reaching it.
raises(TypeError, () => Plain.ToPlain(store)(Student, zoe));
raises(TypeError, () => Plain.ToPlain(store).Reachable(Term, fall));

// Validation reports it, only when asked, with a path to the value.
const validate = Validators.Validate(store);
assert(same(validate(Student, zoe), [
  "Student#0.enrollments[1].credits: expected int, got bool",
  // Her two enrollments also share (student, course, term), which Enrollment's uniques clause forbids.
  "unique(audit, credits, score) violated: entries agreeing on ['course', 'student', 'term'] differ on " +
    "['audit', 'credits', 'score']",
]));

// Noah's three enrollments share (student, course, term), which Enrollment's uniques clause says determine the rest.
assert(validate(Student, noah).some((p) => p.startsWith("unique(audit, credits, score) violated")));

// A linked object must have a schema that fills that link: here a Student is linked as a course.
store.Student(noah, (s: any) => s.enrollments((a: any) => a.insert((x: any) => x.course(mia).term(fall))));
assert(validate(Student, noah).some((p) => p.includes("a 'Student' cannot fill link 'course'")));
store.Student(noah, (s: any) => s.enrollments((a: any) => a.remove((e: any) => e.course(mia))));
assert(!validate(Student, noah).some((p) => p.includes("cannot fill")));

// Remove the bad entry so the rest of the example can serialize.
store.Student(zoe, (s: any) => s.enrollments((a: any) => a.remove((e: any) => e.credits(true))));
assert(same(entries(Student, zoe, "enrollments").map((e) => e.get("credits")), [1n]));

// --- Schema inference through a link must be unambiguous ---

const lab = store.Room((r: any) => r.building("Hopper Hall").number("B12"));

// Both Student and Staff fill 'booker', so building one inline from the room's side is refused...
raises(TypeError, () => store.Room(lab, (r: any) => r.bookings((a: any) => a.insert((x: any) => x.booker((b: any) => b.name("?")).starts("2026-09-14T09:00:00Z")))));

// ...but linking an existing object works, whichever schema it has.
const grace = store.Staff((s: any) => s.name("Grace").staff_id("F-0042"));
store.Room(lab, (r: any) => r.bookings((a: any) => a.insert((x: any) => x.booker(grace).starts("2026-09-14T09:00:00Z"))));
store.Room(lab, (r: any) => r.bookings((a: any) => a.insert((x: any) => x.booker(mia).starts("2026-09-15T13:30:00Z"))));
assert(same(sortedStrings(entries(Room, lab, "bookings").map((e) => (e.get("booker") as Instance).as_schema().name as string)), ["Staff", "Student"]));

// References carry the schema name, so restoring knows Grace is Staff and Mia is a Student.
let graph = Plain.ToPlain(store).Reachable(Room, lab);
let restored = Plain.FromPlain(store).Reachable(Room, graph) as Instance;
const bookers = new Map(entries(Room, restored, "bookings").map((e) => {
  const booker = e.get("booker") as Instance;
  return [String(booker.name), booker.as_schema().name];
}));
assert(bookers.size === 2 && bookers.get("Grace") === "Staff" && bookers.get("Mia") === "Student");

// --- Reachability and round trips across the three-link relation ---

const component = Reachable.of(fall);
assert(component[0] === fall);
assert(same(sortedStrings(new Set(component.map((o) => o.as_schema().name as string))), ["Course", "Room", "Staff", "Student", "Term"]));

const archive: any = new Builders.Store(); // another store: a snapshot read into it builds objects of the same identities
Plain.FromPlain(archive).Snapshot(Plain.ToPlain(store).Snapshot()); // the same schemas, its own: a store's snapshot writes them
for (const [root, schema, its] of [[fall, Term, archive.Term], [mia, Student, archive.Student], [noah, Student, archive.Student]] as const) {
  graph = Plain.ToPlain(store).Reachable(schema, root);
  restored = Plain.FromPlain(archive).Reachable(its, graph) as Instance;
  assert(restored !== root && restored.as_identity() === root.as_identity());
  assert(same_graph(Plain.ToPlain(archive).Reachable(its, restored), graph));
}

// Apart from Noah's duplicate enrollments, the whole component is valid.
const problems = validate.Reachable(Term, fall);
assert(problems.length === 1 && (problems[0] as string).startsWith("unique("), String(problems));

// -0.0 keeps its sign through a round trip.
const scores = entries(Student, noah, "enrollments").map((e) => e.get("score"));
assert(scores.some((s) => s === 0 && Object.is(s, -0)));

console.log("University: all checks passed");
