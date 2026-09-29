// Family tree example: relations between objects of the same schema.
//
// Covers self-relations, several relations between the same pair of objects, multiple owners, cycles, a self-loop,
// duplicate elision, entries that differ only by a property, entry removal, clone() copying entries, and round trips.

import { AttributeError, ValueError } from "@mbse/schemas/Framework/Errors";
import { Plain, Proxies, Reachable, Schemas, Validators } from "@mbse/schemas/Framework";
import type { Instance } from "@mbse/schemas/Framework/Proxies";
import { sortedStrings } from "@mbse/schemas/Framework/Repr";
import type { OfEntry } from "@mbse/schemas/Framework/Visitors";
import { assert, entries, raises, same_graph } from "./_support.js";

// --- Schemas ---

let Person = new Schemas.OfObject.Builder()
  .properties(
    (prop) => prop.name("given_name").of((t) => t.as_native(String)),
    (prop) => prop.name("family_name").of((t) => t.as_native(String)),
    (prop) => prop.name("birth_date").of((t) => t.as_native(String)), // ISO 8601 calendar date
  )
  .create();

// Both links of these relations are filled by Person objects.
const Parentage = new Schemas.OfRelation.Builder()
  .links("parent", "child")
  .properties((prop) => prop.name("kind").of((t) => t.as_native(String))) // 'biological', 'adoptive'
  .create();

const Mentorship = new Schemas.OfRelation.Builder().links("mentor", "mentee").create();

Person = new Schemas.OfObject.Builder(Person)
  .relations(
    (adj) => adj.name("children").of(Parentage).me("parent"),
    (adj) => adj.name("parents").of(Parentage).me("child"),
    (adj) => adj.name("mentees").of(Mentorship).me("mentor"),
    (adj) => adj.name("mentors").of(Mentorship).me("mentee"),
  )
  .update();
assert(Person.validate().length === 0 && Parentage.validate().length === 0 && Mentorship.validate().length === 0);

Proxies.register("Person", Person);
Proxies.register("Parentage", Parentage);
Proxies.register("Mentorship", Mentorship);
const Builders = Proxies.Builders;

function kinds(obj: Instance, adjacency: string): string[] {
  return sortedStrings(entries(Person, obj, adjacency).map((e) => e.get("kind") as string));
}

function names(obj: Instance, adjacency: string, link: string): string[] {
  return sortedStrings(entries(Person, obj, adjacency).map((e) => (e.get(link) as Instance).given_name));
}

const same = (a: string[], b: string[]): boolean => a.join("\u0000") === b.join("\u0000");

// --- Self-relations ---

const ada = Builders.Person().given_name("Ada").family_name("Lovelace").birth_date("1815-12-10").create();
const bob = Builders.Person().given_name("Bob").parents((x: any) => x.parent(ada).kind("biological")).create();

// The entry is one fact, visible from both ends.
assert(same(names(ada, "children", "child"), ["Bob"]) && same(names(bob, "parents", "parent"), ["Ada"]));

// Inline creation through a link: 'child' is filled only by Person, so the new object's schema is unambiguous.
const carol = Builders.Person()
  .given_name("Carol")
  .children((x: any) => x.child((y: any) => y.given_name("Dan").birth_date("2001-02-03")).kind("adoptive"))
  .create();
const dan = (entries(Person, carol, "children")[0] as Map<string, unknown>).get("child") as Instance;
assert(dan.given_name === "Dan" && dan.schema_name() === "Person");

// --- Multiple owners: Dan has two parents, through two separate entries ---

Builders.Person(dan).parents((x: any) => x.parent(ada).kind("biological")).update();
assert(same(names(dan, "parents", "parent"), ["Ada", "Carol"]));
assert(same(names(ada, "children", "child"), ["Bob", "Dan"]));

// --- Two different relations between the same pair ---

Builders.Person(ada).mentees((x: any) => x.mentee(bob)).update();
assert(same(names(bob, "parents", "parent"), ["Ada"]) && same(names(bob, "mentors", "mentor"), ["Ada"]));

// --- Duplicate elision, and entries that differ only by a property ---

Builders.Person(bob).parents((x: any) => x.parent(ada).kind("biological")).update();
assert(same(kinds(bob, "parents"), ["biological"])); // adding an equal entry is elided

Builders.Person(bob).parents((x: any) => x.parent(ada).kind("adoptive")).update();
assert(same(kinds(bob, "parents"), ["adoptive", "biological"])); // a different property value is a different entry

// An entry without the optional property is different again.
Builders.Person(bob).parents((x: any) => x.parent(ada)).update();
assert(entries(Person, bob, "parents").length === 3 && !(entries(Person, bob, "parents").at(-1) as Map<string, unknown>).has("kind"));

// --- Removing entries through a builder ---

function kind_of(entry: OfEntry): unknown {
  const found: unknown[] = [];
  if (entry.has("kind")) entry.property("kind", (p) => p.value((v) => v.as_native((n) => found.push(n.get()))));
  return found.length > 0 ? found[0] : null;
}

Builders.Person(bob).adjacency("parents", (a: any) => a.entries((e: OfEntry) => (kind_of(e) !== "biological" ? a.remove(e) : null))).update();
assert(same(kinds(bob, "parents"), ["biological"]));
assert(same(names(ada, "children", "child"), ["Bob", "Dan"])); // removed from both ends: it was one fact

// --- A self-loop and a cycle ---

Builders.Person(carol).mentees((x: any) => x.mentee(carol)).update(); // Carol mentors herself
assert(same(names(carol, "mentees", "mentee"), ["Carol"]) && same(names(carol, "mentors", "mentor"), ["Carol"]));

Builders.Person(dan).mentees((x: any) => x.mentee(ada)).update(); // ada -> dan by parentage, dan -> ada by mentorship
const namesOf = (objs: unknown[]) => sortedStrings(new Set(objs.map((p) => (p as Instance).given_name as string)));
assert(same(namesOf(Reachable.of(ada)), ["Ada", "Bob", "Carol", "Dan"]));
assert(Reachable.of(ada)[0] === ada); // the root comes first
assert(same(namesOf(Reachable.of(bob)), namesOf(Reachable.of(ada)))); // same component

const loner = Builders.Person().given_name("Eve").create();
assert(Reachable.of(loner).length === 1 && Reachable.of(loner)[0] === loner);

// --- clone() copies adjacency entries ---

const bob2 = Builders.Person(bob).given_name("Bob II").clone();
assert(same(kinds(bob2, "parents"), ["biological"]) && same(names(bob2, "mentors", "mentor"), ["Ada"]));
assert(same(names(ada, "children", "child"), ["Bob", "Bob II", "Dan"]));
assert(bob.given_name === "Bob");

// --- Entry rules ---

raises(AttributeError, () => Builders.Person().parents((x: any) => x.child(bob))); // the object's own link ('child') is implied
raises(AttributeError, () => Builders.Person().parents((x: any) => x.parent(ada).since("1990"))); // not a property of Parentage
raises(ValueError, () => Builders.Person().parents((x: any) => x.kind("biological")).create()); // the 'parent' link is never set
raises(TypeError, () => Builders.Person().parents({ x: ada })); // an adjacency takes an entry Spec

// --- Validation ---

// Cycles, a self-loop, and several relations between the same people are all valid.
assert(Validators.Validate(Proxies.Builders).Reachable(Person, ada).length === 0);

// --- Round trips, from any root ---

for (const root of [ada, carol, loner]) {
  const graph = Plain.ToPlain.Reachable(Person, root);
  const restored = Plain.FromPlain(Proxies.Builders).Reachable(Person, graph) as Instance;
  assert(restored !== root && restored.given_name === root.given_name);
  assert(same_graph(Plain.ToPlain.Reachable(Person, restored), graph));
}

console.log("FamilyTree: all checks passed");
