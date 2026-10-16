# Family tree example: relations between objects of the same schema.
#
# Covers self-relations, several relations between the same pair of objects, multiple owners, cycles, a self-loop,
# duplicate elision, entries that differ only by a property, entry removal, clone() copying entries, and round trips.

from mbse.Schemas.Framework import Builders, Schemas, Plain, Reachable, Validators
from mbse.Schemas.Examples._support import entries, raises, same_graph


store = Builders.Store()
Text = store.Schemas.OfStr.as_schema()  # the store's own basic scalar

# --- Schemas ---

Person = store.Schemas.OfObject(lambda o: (
    o
    .name('Person')
    .ref(True)
    .properties([
        lambda t: t.name('given_name').type([Text]),
        lambda t: t.name('family_name').type([Text]),
        lambda t: t.name('birth_date').type([Text]),  # ISO 8601 calendar date
    ])
))

# Both links of these relations are filled by Person objects.
Parentage = store.Schemas.OfRelation(lambda r: (
    r
    .name('Parentage')
    .links([
        lambda t: t.name('parent'),
        lambda t: t.name('child'),
    ])
    .properties([lambda t: t.name('kind').type([Text])])  # 'biological', 'adoptive'
    .uniques([[]])  # a set of entries, with no other constraint: an entry equal to one held is that one
))

Mentorship = store.Schemas.OfRelation(lambda r: (
    r
    .name('Mentorship')
    .links([
        lambda t: t.name('mentor'),
        lambda t: t.name('mentee'),
    ])
))

store.Schemas.OfObject(Person, lambda o: o.adjacencies([
    lambda t: t.name('children').relation([Parentage]).me('parent'),
    lambda t: t.name('parents').relation([Parentage]).me('child'),
    lambda t: t.name('mentees').relation([Mentorship]).me('mentor'),
    lambda t: t.name('mentors').relation([Mentorship]).me('mentee'),
]))
assert Person.validate() == [] and Parentage.validate() == [] and Mentorship.validate() == []


def kinds(obj, adjacency):
    return sorted(e['kind'] for e in entries(Person, obj, adjacency))


def names(obj, adjacency, link):
    return sorted(str(e[link].given_name) for e in entries(Person, obj, adjacency))


# --- Self-relations ---

ada = store.Person(lambda p: p.given_name('Ada').family_name('Lovelace').birth_date('1815-12-10'))
bob = store.Person(lambda p: p.given_name('Bob').parents(lambda a: a.insert(lambda x: x.parent(ada).kind('biological'))))

# The entry is one fact, visible from both ends.
assert names(ada, 'children', 'child') == ['Bob'] and names(bob, 'parents', 'parent') == ['Ada']

# Inline creation through a link: 'child' is filled only by Person, so the new object's schema is unambiguous.
carol = store.Person(lambda p: (
    p
    .given_name('Carol')
    .children(lambda a: a.insert(lambda x: x.child(lambda y: y.given_name('Dan').birth_date('2001-02-03')).kind('adoptive')))
))
dan = entries(Person, carol, 'children')[0]['child']
assert str(dan.given_name) == 'Dan' and dan.as_schema().name == 'Person'

# --- Multiple owners: Dan has two parents, through two separate entries ---

store.Person(dan, lambda p: p.parents(lambda a: a.insert(lambda x: x.parent(ada).kind('biological'))))
assert names(dan, 'parents', 'parent') == ['Ada', 'Carol']
assert names(ada, 'children', 'child') == ['Bob', 'Dan']

# --- Two different relations between the same pair ---

store.Person(ada, lambda p: p.mentees(lambda a: a.insert(lambda x: x.mentee(bob))))
assert names(bob, 'parents', 'parent') == ['Ada'] and names(bob, 'mentors', 'mentor') == ['Ada']

# --- Duplicate elision, and entries that differ only by a property ---

store.Person(bob, lambda p: p.parents(lambda a: a.insert(lambda x: x.parent(ada).kind('biological'))))
assert kinds(bob, 'parents') == ['biological']  # adding an equal entry is elided

store.Person(bob, lambda p: p.parents(lambda a: a.insert(lambda x: x.parent(ada).kind('adoptive'))))
assert kinds(bob, 'parents') == ['adoptive', 'biological']  # a different property value is a different entry

# An entry without the optional property is different again.
store.Person(bob, lambda p: p.parents(lambda a: a.insert(lambda x: x.parent(ada))))
assert len(entries(Person, bob, 'parents')) == 3 and 'kind' not in entries(Person, bob, 'parents')[-1]

# --- Removing entries through a builder ---


def keep_biological(adjacency):
    for entry in list(bob.parents):  # an entry given as a value removes the entries equal to it
        if entry.kind.get() != 'biological':
            adjacency.remove(entry)
    return adjacency


store.Person(bob, lambda p: p.parents(keep_biological))
assert kinds(bob, 'parents') == ['biological']
assert names(ada, 'children', 'child') == ['Bob', 'Dan']  # removed from both ends: it was one fact

# --- A self-loop and a cycle ---

store.Person(carol, lambda p: p.mentees(lambda a: a.insert(lambda x: x.mentee(carol))))  # Carol mentors herself
assert names(carol, 'mentees', 'mentee') == ['Carol'] and names(carol, 'mentors', 'mentor') == ['Carol']

store.Person(dan, lambda p: p.mentees(lambda a: a.insert(lambda x: x.mentee(ada))))  # ada -> dan by parentage, dan -> ada by mentorship
assert {str(p.given_name) for p in Reachable.of(ada)} == {'Ada', 'Bob', 'Carol', 'Dan'}
assert Reachable.of(ada)[0] is ada  # the root comes first
assert {str(p.given_name) for p in Reachable.of(bob)} == {str(p.given_name) for p in Reachable.of(ada)}  # same component

loner = store.Person(lambda p: p.given_name('Eve'))
assert Reachable.of(loner) == [loner]

# --- A clone copies adjacency entries ---

bob2 = store.Person(store.Person(bob), lambda p: p.given_name('Bob II'))
assert kinds(bob2, 'parents') == ['biological'] and names(bob2, 'mentors', 'mentor') == ['Ada']
assert names(ada, 'children', 'child') == ['Bob', 'Bob II', 'Dan']
assert str(bob.given_name) == 'Bob'

# --- Building entries ---

with raises(TypeError):
    store.Person(lambda p: p.parents(lambda a: a.insert(lambda x: x.child(bob))))  # the object's own link ('child') is implied
with raises(TypeError):
    store.Person(lambda p: p.parents(lambda a: a.insert(lambda x: x.parent(ada).since('1990'))))  # not a property of Parentage
with raises(ValueError):
    store.Person(lambda p: p.parents(lambda a: a.insert(lambda x: x.kind('biological'))))  # the 'parent' link is never set
with raises(TypeError):
    store.Person(lambda p: p.parents(x=ada))  # an adjacency takes a Spec

# --- Validation ---

# Cycles, a self-loop, and several relations between the same people are all valid.
assert Validators.Validate(store).Reachable(Person, ada) == []

# --- Round trips, from any root ---

# Read into another store, a snapshot builds objects of the same identities; read into the store that holds them, it
# updates them through their builders, and reading it again changes nothing.
archive = Builders.Store()
Plain.FromPlain(archive).Snapshot(Plain.ToPlain(store).Snapshot())  # the same schemas, its own: a store's snapshot writes them
for root in (ada, carol, loner):
    graph = Plain.ToPlain(store).Reachable(Person, root)
    restored = Plain.FromPlain(archive).Reachable(archive.Person, graph)
    assert restored is not root and restored.as_identity() == root.as_identity()
    assert str(restored.given_name) == str(root.given_name)
    assert same_graph(Plain.ToPlain(archive).Reachable(archive.Person, restored), graph)
    assert Plain.FromPlain(store).Reachable(Person, graph) is root

print('FamilyTree: all checks passed')
