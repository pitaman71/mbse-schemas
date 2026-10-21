// Family tree example: relations between objects of the same schema.
//
// Covers self-relations, several relations between the same pair of objects, multiple owners, cycles, a self-loop,
// duplicate elision, entries that differ only by a property, entry removal, clone() copying entries, and round trips.

import { ValueError } from "@mbse/schemas/Framework/Errors";
import { Builders, Plain, Proxies, Reachable, Validators } from "@mbse/schemas/Framework";
import type { Instance } from "@mbse/schemas/Framework/Proxies";
import { sortedStrings } from "@mbse/schemas/Framework/Repr";
import { assert, entries, equal, raises } from "./_support.js";


// --- Schemas ---

/** The family tree's schemas, defined in the store a transaction writes (`store.transaction(install)`): Person, and the
 * relations between persons, Parentage and Mentorship, each found by its name, else made. */
function install(txn: any): any {
  const S = txn.Schemas; // the store's own schemas, by name
  return txn.uid("examples.family_tree/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({ Person: S.OfObject, Parentage: S.OfRelation, Mentorship: S.OfRelation })
    .spec([
      (_: any) => _.Person.name("Person").ref(true).properties({
        given_name: S.OfStr,
        family_name: S.OfStr,
        birth_date: S.OfStr, // ISO 8601 calendar date
      }).adjacencies({
        children: (a: any) => a.relation([_.Parentage]).me("parent"),
        parents: (a: any) => a.relation([_.Parentage]).me("child"),
        mentees: (a: any) => a.relation([_.Mentorship]).me("mentor"),
        mentors: (a: any) => a.relation([_.Mentorship]).me("mentee"),
      }),
      // Both links of these relations are filled by Person objects.
      (_: any) => _.Parentage.name("Parentage").links([
        (t: any) => t.name("parent"),
        (t: any) => t.name("child"),
      ]).properties({
        kind: S.OfStr, // 'biological', 'adoptive'
      }).uniques([[]]), // a set of entries, with no other constraint: an entry equal to one held is that one
      (_: any) => _.Mentorship.name("Mentorship").links([
        (t: any) => t.name("mentor"),
        (t: any) => t.name("mentee"),
      ]),
    ])]))]);
}

const store: any = new Builders.Store();
store.transaction(install); // every write to a store is made within a transaction, all or nothing
const [Person, Parentage, Mentorship] = ["Person", "Parentage", "Mentorship"].map((name) => store.registered(name));
assert(Person.validate().length === 0 && Parentage.validate().length === 0 && Mentorship.validate().length === 0);

function kinds(obj: Instance, adjacency: string): string[] {
  return sortedStrings(entries(Person, obj, adjacency).map((e) => e.get("kind") as string));
}

function names(obj: Instance, adjacency: string, link: string): string[] {
  return sortedStrings(entries(Person, obj, adjacency).map((e) => String((e.get(link) as Instance).given_name)));
}

const same = (a: string[], b: string[]): boolean => a.join("\u0000") === b.join("\u0000");

// --- Self-relations ---

const { ada, carol, loner } = store.transaction(() => { // the people and their entries, written within one transaction
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
  return { ada, carol, loner };
});

// --- Validation ---

// Cycles, a self-loop, and several relations between the same people are all valid.
assert(Validators.Validate(store).Reachable(Person, ada).length === 0);

// --- Round trips, from any root ---

// Read into any store, even the one that holds them, a document builds new objects of the same graph: a counted object
// has no identity beyond the document.
const archive: any = new Builders.Store();
Plain.FromPlain(archive).Snapshot(Plain.ToPlain(store).Snapshot()); // the same schemas, its own: a store's snapshot writes them
for (const root of [ada, carol, loner]) {
  const graph = Plain.ToPlain(store).Reachable(Person, root);
  const restored = Plain.FromPlain(archive).Reachable(archive.Person, graph) as Instance;
  assert(restored !== root);
  assert(String(restored.given_name) === String(root.given_name));
  assert(equal(Plain.ToPlain(archive).Reachable(archive.Person, restored), graph));
  assert(Plain.FromPlain(store).Reachable(Person, graph) !== root);
}

console.log("FamilyTree: all checks passed");
