// University example: a three-link relation, entry property equality, and schema inference through links.
//
// Covers a ternary relation (student, course, term) with ISO 8601 dates, entries distinguished by float / int / bool
// values, an ambiguous link that refuses inline creation, the builder not validating native types, and round trips.

import { ValueError } from "@mbse/schemas/Framework/Errors";
import { Plain, Proxies, Reachable, Schemas, Validators } from "@mbse/schemas/Framework";
import type { Instance } from "@mbse/schemas/Framework/Proxies";
import { sortedStrings } from "@mbse/schemas/Framework/Repr";
import type { OfEntry, Visitable } from "@mbse/schemas/Framework/Visitors";
import { assert, entries, raises, same_graph } from "./_support.js";

function text(name: string) {
  return (prop: Schemas.OfProperty.Builder) => prop.name(name).of((t) => t.as_native(String));
}

// --- Schemas ---

let Student = new Schemas.OfObject.Builder().ref().properties(text("name"), text("student_id")).create();
let Staff = new Schemas.OfObject.Builder().ref().properties(text("name"), text("staff_id")).create();
let Course = new Schemas.OfObject.Builder().ref().properties(text("code"), text("title")).create();
let Term = new Schemas.OfObject.Builder().ref()
  .properties(text("code"), text("starts"), text("ends")) // ISO 8601 dates, e.g. '2026-09-01'
  .create();
let Room = new Schemas.OfObject.Builder().ref().properties(text("building"), text("number")).create();

// Three links: each entry is one student taking one course in one term.
const Enrollment = new Schemas.OfRelation.Builder()
  .links("student", "course", "term")
  .properties(
    (prop) => prop.name("credits").of((t) => t.as_native(BigInt)),
    (prop) => prop.name("score").of((t) => t.as_native(Number)),
    (prop) => prop.name("audit").of((t) => t.as_native(Boolean)),
  )
  .unique("score", "audit", "credits") // (student, course, term) determine the rest
  .create();

// Both Student and Staff can book rooms, so the 'booker' link is filled by more than one schema.
const Booking = new Schemas.OfRelation.Builder()
  .links("booker", "room")
  .properties(text("starts")) // ISO 8601 date-time, e.g. '2026-09-14T09:00:00Z'
  .create();

Student = new Schemas.OfObject.Builder(Student)
  .relations(
    (adj) => adj.name("enrollments").of(Enrollment).me("student"),
    (adj) => adj.name("bookings").of(Booking).me("booker"),
  )
  .update();
Staff = new Schemas.OfObject.Builder(Staff).relations((adj) => adj.name("bookings").of(Booking).me("booker")).update();
Course = new Schemas.OfObject.Builder(Course).relations((adj) => adj.name("enrollments").of(Enrollment).me("course")).update();
Term = new Schemas.OfObject.Builder(Term).relations((adj) => adj.name("enrollments").of(Enrollment).me("term")).update();
Room = new Schemas.OfObject.Builder(Room).relations((adj) => adj.name("bookings").of(Booking).me("room")).update();

for (const [name, schema] of [["Student", Student], ["Staff", Staff], ["Course", Course], ["Term", Term], ["Room", Room],
  ["Enrollment", Enrollment], ["Booking", Booking]] as const) {
  assert(schema.validate().length === 0, `${name}: ${schema.validate()}`);
  Proxies.register(name, schema);
}
const Builders = Proxies.Builders;
const same = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// --- A three-link relation ---

const fall = Builders.Term().code("2026-FA").starts("2026-09-01").ends("2026-12-18").create();
const cs101 = Builders.Course().code("CS101").title("Programs and Data").create();

// From the student's side, an entry sets the two other links; inline creation works because only Course fills 'course'.
const mia = Builders.Student()
  .name("Mia")
  .student_id("S-0001")
  .enrollments((x: any) => x.course(cs101).term(fall).credits(4n))
  .enrollments((x: any) => x.course((c: any) => c.code("MA201").title("Linear Algebra")).term(fall).credits(3n))
  .create();
assert(same(sortedStrings(entries(Student, mia, "enrollments").map((e) => (e.get("course") as Instance).code)), ["CS101", "MA201"]));

// The same fact is visible from all three ends.
assert(same(entries(Course, cs101, "enrollments").map((e) => e.get("student")), [mia]));
assert(same(sortedStrings(new Set(entries(Term, fall, "enrollments").map((e) => (e.get("course") as Instance).code))), ["CS101", "MA201"]));

// Entries from one end carry the two other links; the object's own link is implied.
assert(same(sortedStrings((entries(Term, fall, "enrollments")[0] as Map<string, unknown>).keys()), ["course", "credits", "student"]));

// Every link other than the object's own must be set.
raises(ValueError, () => Builders.Student().name("Noah").enrollments((x: any) => x.course(cs101)).create());

// --- Entry property equality follows schema equality, not host-language == ---

const noah = Builders.Student().name("Noah").create();

function enroll(student: Instance, props: Record<string, unknown>): void {
  const spec = (x: any) => {
    x.course(cs101).term(fall);
    for (const [key, value] of Object.entries(props)) x[key](value);
    return x;
  };
  Builders.Student(student).enrollments(spec).update();
}

enroll(noah, { score: 0.0 });
enroll(noah, { score: -0.0 }); // floats compare by bit pattern: -0.0 is a different entry
enroll(noah, { score: NaN });
enroll(noah, { score: Number("NaN") }); // all NaNs are equal: elided
assert(entries(Student, noah, "enrollments").length === 3);

const zoe = Builders.Student().name("Zoe").create();
enroll(zoe, { credits: 1n });
enroll(zoe, { credits: true }); // the builder does not validate native types, and true is a different value from 1n

function credits_of(entry: OfEntry): unknown {
  const found: unknown[] = [];
  if (entry.has("credits")) entry.property("credits", (p) => p.value((v) => v.as_native((n) => found.push(n.get()))));
  return found.length > 0 ? found[0] : null;
}

const values: unknown[] = [];
Builders.Student(zoe).adjacency("enrollments", (a: any) => a.entries((e: OfEntry) => values.push(credits_of(e))));
assert(values.length === 2 && same(sortedStrings(new Set(values.map((v) => typeof v))), ["bigint", "boolean"]));

// Serializing checks native types: a bool where the schema says int is rejected, and so is anything reaching it.
raises(TypeError, () => Plain.ToPlain(Student, zoe));
raises(TypeError, () => Plain.ToPlain.Reachable(Term, fall));

// Validation reports it, only when asked, with a path to the value.
const validate = Validators.Validate(Proxies.Builders);
assert(same(validate(Student, zoe), [
  "Student#0.enrollments[1].credits: expected int, got bool",
  // Her two enrollments also share (student, course, term), which Enrollment's unique(...) clause forbids.
  "unique(audit, credits, score) violated: entries agreeing on ['course', 'student', 'term'] differ on " +
    "['audit', 'credits', 'score']",
]));

// Noah's three enrollments share (student, course, term), which Enrollment's unique(...) clause says determine the rest.
assert(validate(Student, noah).some((p) => p.startsWith("unique(audit, credits, score) violated")));

// A linked object must have a schema that fills that link: here a Student is linked as a course.
Builders.Student(noah).enrollments((x: any) => x.course(mia).term(fall)).update();
assert(validate(Student, noah).some((p) => p.includes("a 'Student' cannot fill link 'course'")));
Builders.Student(noah).adjacency("enrollments", (a: any) =>
  a.entries((e: OfEntry) => e.link("course", (k) => k.target((t: Visitable) => (t === mia ? a.remove(e) : null)))),
).update();
assert(!validate(Student, noah).some((p) => p.includes("cannot fill")));

// Remove the bad entry so the rest of the example can serialize.
Builders.Student(zoe).adjacency("enrollments", (a: any) =>
  a.entries((e: OfEntry) => (typeof credits_of(e) === "boolean" ? a.remove(e) : null)),
).update();
assert(same(entries(Student, zoe, "enrollments").map((e) => e.get("credits")), [1n]));

// --- Schema inference through a link must be unambiguous ---

const lab = Builders.Room().building("Hopper Hall").number("B12").create();

// Both Student and Staff fill 'booker', so building one inline from the room's side is refused...
raises(TypeError, () => Builders.Room(lab).bookings((x: any) => x.booker((b: any) => b.name("?")).starts("2026-09-14T09:00:00Z")).update());

// ...but linking an existing object works, whichever schema it has.
const grace = Builders.Staff().name("Grace").staff_id("F-0042").create();
Builders.Room(lab).bookings((x: any) => x.booker(grace).starts("2026-09-14T09:00:00Z")).update();
Builders.Room(lab).bookings((x: any) => x.booker(mia).starts("2026-09-15T13:30:00Z")).update();
assert(same(sortedStrings(entries(Room, lab, "bookings").map((e) => (e.get("booker") as Instance).schema_name())), ["Staff", "Student"]));

// References carry the schema name, so restoring knows Grace is Staff and Mia is a Student.
let graph = Plain.ToPlain.Reachable(Room, lab);
let restored = Plain.FromPlain(Proxies.Builders).Reachable(Room, graph) as Instance;
const bookers = new Map(entries(Room, restored, "bookings").map((e) => {
  const booker = e.get("booker") as Instance;
  return [booker.name as string, booker.schema_name()];
}));
assert(bookers.size === 2 && bookers.get("Grace") === "Staff" && bookers.get("Mia") === "Student");

// --- Reachability and round trips across the three-link relation ---

const component = Reachable.of(fall);
assert(component[0] === fall);
assert(same(sortedStrings(new Set(component.map((o) => o.schema_name()))), ["Course", "Room", "Staff", "Student", "Term"]));

for (const [root, schema] of [[fall, Term], [mia, Student], [noah, Student]] as const) {
  graph = Plain.ToPlain.Reachable(schema, root);
  restored = Plain.FromPlain(Proxies.Builders).Reachable(schema, graph) as Instance;
  assert(restored !== root && same_graph(Plain.ToPlain.Reachable(schema, restored), graph));
}

// Apart from Noah's duplicate enrollments, the whole component is valid.
const problems = validate.Reachable(Term, fall);
assert(problems.length === 1 && (problems[0] as string).startsWith("unique("), String(problems));

// -0.0 keeps its sign through a round trip.
const scores = entries(Student, noah, "enrollments").map((e) => e.get("score"));
assert(scores.some((s) => s === 0 && Object.is(s, -0)));

console.log("University: all checks passed");
