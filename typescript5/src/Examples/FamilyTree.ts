// Family tree example: relations between objects of the same schema.
//
// Covers self-relations, several relations between the same pair of objects, multiple owners, cycles, a self-loop,
// duplicate elision, entries that differ only by a property, entry removal, clone() copying entries, and round trips.

import { ValueError } from "@mbse/schemas/Framework/Errors";
import { Builders, Paths, Plain, Proxies, Reachable, Schemas, Validators } from "@mbse/schemas/Framework";
import type { Instance } from "@mbse/schemas/Framework/Proxies";
import { sortedStrings } from "@mbse/schemas/Framework/Repr";
import { assert, entries, raises, same_graph } from "./_support.js";


const store: any = new Builders.Store();
const Text = store.Schemas.OfStr.as_schema(); // the store's own basic scalar

// --- Schemas ---

const Person = store.Schemas.OfObject((o: any) => (
  o
    .name("Person")
    .ref(true)
    .properties([
      (t: any) => t.name("given_name").schema([Text]),
      (t: any) => t.name("family_name").schema([Text]),
      (t: any) => t.name("birth_date").schema([Text]), // ISO 8601 calendar date
    ])
));

// Both links of these relations are filled by Person objects.
const Parentage = store.Schemas.OfRelation((r: any) => (
  r
    .name("Parentage")
    .links([
      (t: any) => t.name("parent"),
      (t: any) => t.name("child"),
    ])
    .properties([(t: any) => t.name("kind").schema([Text])]) // 'biological', 'adoptive'
    .uniques([[]]) // a set of entries, with no other constraint: an entry equal to one held is that one
));

const Mentorship = store.Schemas.OfRelation((r: any) => (
  r
    .name("Mentorship")
    .links([
      (t: any) => t.name("mentor"),
      (t: any) => t.name("mentee"),
    ])
));

store.Schemas.OfObject(Person, (o: any) => o.adjacencies([
  (t: any) => t.name("children").relation([Parentage]).me("parent"),
  (t: any) => t.name("parents").relation([Parentage]).me("child"),
  (t: any) => t.name("mentees").relation([Mentorship]).me("mentor"),
  (t: any) => t.name("mentors").relation([Mentorship]).me("mentee"),
]));
assert(Person.validate().length === 0 && Parentage.validate().length === 0 && Mentorship.validate().length === 0);

function kinds(obj: Instance, adjacency: string): string[] {
  return sortedStrings(entries(Person, obj, adjacency).map((e) => e.get("kind") as string));
}

function names(obj: Instance, adjacency: string, link: string): string[] {
  return sortedStrings(entries(Person, obj, adjacency).map((e) => String((e.get(link) as Instance).given_name)));
}

const same = (a: string[], b: string[]): boolean => a.join("\u0000") === b.join("\u0000");

// --- Self-relations ---

const ada = store.Person((p: any) => p.given_name("Ada").family_name("Lovelace").birth_date("1815-12-10"));
const bob = store.Person((p: any) => p.given_name("Bob").parents((a: any) => a.insert((x: any) => x.parent(ada).kind("biological"))));

// The entry is one fact, visible from both ends.
assert(same(names(ada, "children", "child"), ["Bob"]) && same(names(bob, "parents", "parent"), ["Ada"]));

// Inline creation through a link: 'child' is filled only by Person, so the new object's schema is unambiguous.
const carol = store.Person((p: any) => (
  p
    .given_name("Carol")
    .children((a: any) => a.insert((x: any) => x.child((y: any) => y.given_name("Dan").birth_date("2001-02-03")).kind("adoptive")))
));
const dan = (entries(Person, carol, "children")[0] as Map<string, unknown>).get("child") as Instance;
assert(String(dan.given_name) === "Dan" && dan.as_schema().name === "Person");

// --- Multiple owners: Dan has two parents, through two separate entries ---

store.Person(dan, (p: any) => p.parents((a: any) => a.insert((x: any) => x.parent(ada).kind("biological"))));
assert(same(names(dan, "parents", "parent"), ["Ada", "Carol"]));
assert(same(names(ada, "children", "child"), ["Bob", "Dan"]));

// --- Two different relations between the same pair ---

store.Person(ada, (p: any) => p.mentees((a: any) => a.insert((x: any) => x.mentee(bob))));
assert(same(names(bob, "parents", "parent"), ["Ada"]) && same(names(bob, "mentors", "mentor"), ["Ada"]));

// --- Duplicate elision, and entries that differ only by a property ---

store.Person(bob, (p: any) => p.parents((a: any) => a.insert((x: any) => x.parent(ada).kind("biological"))));
assert(same(kinds(bob, "parents"), ["biological"])); // adding an equal entry is elided

store.Person(bob, (p: any) => p.parents((a: any) => a.insert((x: any) => x.parent(ada).kind("adoptive"))));
assert(same(kinds(bob, "parents"), ["adoptive", "biological"])); // a different property value is a different entry

// An entry without the optional property is different again.
store.Person(bob, (p: any) => p.parents((a: any) => a.insert((x: any) => x.parent(ada))));
assert(entries(Person, bob, "parents").length === 3 && !(entries(Person, bob, "parents").at(-1) as Map<string, unknown>).has("kind"));

// --- Removing entries through a builder ---

function keepBiological(adjacency: any): any {
  for (const entry of [...bob.parents]) { // an entry given as a value removes the entries equal to it
    if (entry.kind.get() !== "biological") adjacency.remove(entry);
  }
  return adjacency;
}

store.Person(bob, (p: any) => p.parents(keepBiological));
assert(same(kinds(bob, "parents"), ["biological"]));
assert(same(names(ada, "children", "child"), ["Bob", "Dan"])); // removed from both ends: it was one fact

// --- A self-loop and a cycle ---

store.Person(carol, (p: any) => p.mentees((a: any) => a.insert((x: any) => x.mentee(carol)))); // Carol mentors herself
assert(same(names(carol, "mentees", "mentee"), ["Carol"]) && same(names(carol, "mentors", "mentor"), ["Carol"]));

store.Person(dan, (p: any) => p.mentees((a: any) => a.insert((x: any) => x.mentee(ada)))); // ada -> dan by parentage, dan -> ada by mentorship
const namesOf = (objs: unknown[]) => sortedStrings(new Set(objs.map((p) => String((p as Instance).given_name))));
assert(same(namesOf(Reachable.of(ada)), ["Ada", "Bob", "Carol", "Dan"]));
assert(Reachable.of(ada)[0] === ada); // the root comes first
assert(same(namesOf(Reachable.of(bob)), namesOf(Reachable.of(ada)))); // same component

const loner = store.Person((p: any) => p.given_name("Eve"));
assert(Reachable.of(loner).length === 1 && Reachable.of(loner)[0] === loner);

// --- A clone copies adjacency entries ---

const bob2 = store.Person(store.Person(bob), (p: any) => p.given_name("Bob II"));
assert(same(kinds(bob2, "parents"), ["biological"]) && same(names(bob2, "mentors", "mentor"), ["Ada"]));
assert(same(names(ada, "children", "child"), ["Bob", "Bob II", "Dan"]));
assert(String(bob.given_name) === "Bob");

// --- Building entries ---

raises(TypeError, () => store.Person((p: any) => p.parents((a: any) => a.insert((x: any) => x.child(bob))))); // the object's own link ('child') is implied
raises(TypeError, () => store.Person((p: any) => p.parents((a: any) => a.insert((x: any) => x.parent(ada).since("1990"))))); // not a property of Parentage
raises(ValueError, () => store.Person((p: any) => p.parents((a: any) => a.insert((x: any) => x.kind("biological"))))); // the 'parent' link is never set
raises(TypeError, () => store.Person((p: any) => p.parents({ x: ada }))); // an adjacency takes a Spec

// --- Validation ---

// Cycles, a self-loop, and several relations between the same people are all valid.
assert(Validators.Validate(store).Reachable(Person, ada).length === 0);

// --- Round trips, from any root ---

// Read into another store, a snapshot builds objects of the same identities; read into the store that holds them, it
// updates them through their builders, and reading it again changes nothing.
const archive: any = new Builders.Store();
Plain.FromPlain(archive).Snapshot(Plain.ToPlain(store).Snapshot()); // the same schemas, its own: a store's snapshot writes them
for (const root of [ada, carol, loner]) {
  const graph = Plain.ToPlain(store).Reachable(Person, root);
  const restored = Plain.FromPlain(archive).Reachable(archive.Person, graph) as Instance;
  assert(restored !== root && Paths.same(restored.as_identity(), root.as_identity()));
  assert(String(restored.given_name) === String(root.given_name));
  assert(same_graph(Plain.ToPlain(archive).Reachable(archive.Person, restored), graph));
  assert(Plain.FromPlain(store).Reachable(Person, graph) === root);
}

console.log("FamilyTree: all checks passed");
