# Family tree example: relations between objects of the same schema.
#
# Covers self-relations, several relations between the same pair of objects, multiple owners, cycles, a self-loop,
# duplicate elision, entries that differ only by a property, entry removal, clone() copying entries, and round trips.

from mbse.Schemas.Framework import Schemas, Proxies, Plain, Reachable, Validators
from mbse.Schemas.Examples._support import entries, raises, same_graph

store = Proxies.OfStore()

# --- Schemas ---

Person = (
    Schemas.OfObject.Builder().name('Person').ref()
    .properties(
        lambda prop: prop.name('given_name').of(lambda t: t.as_scalar(str)),
        lambda prop: prop.name('family_name').of(lambda t: t.as_scalar(str)),
        lambda prop: prop.name('birth_date').of(lambda t: t.as_scalar(str)),  # ISO 8601 calendar date
    )
    .create()
)

# Both links of these relations are filled by Person objects.
Parentage = (
    Schemas.OfRelation.Builder().name('Parentage')
    .links('parent', 'child')
    .properties(lambda prop: prop.name('kind').of(lambda t: t.as_scalar(str)))  # 'biological', 'adoptive'
    .unique()  # a set of entries, with no other constraint: an entry equal to one held is that one
    .create()
)

Mentorship = Schemas.OfRelation.Builder().name('Mentorship').links('mentor', 'mentee').create()

Person = (
    Schemas.OfObject.Builder(Person)
    .relations(
        lambda adj: adj.name('children').of(Parentage).me('parent'),
        lambda adj: adj.name('parents').of(Parentage).me('child'),
        lambda adj: adj.name('mentees').of(Mentorship).me('mentor'),
        lambda adj: adj.name('mentors').of(Mentorship).me('mentee'),
    )
    .update()
)
assert Person.validate() == [] and Parentage.validate() == [] and Mentorship.validate() == []

store.register(Person)
store.register(Parentage)
store.register(Mentorship)


def kinds(obj, adjacency):
    return sorted(e['kind'] for e in entries(Person, obj, adjacency))


def names(obj, adjacency, link):
    return sorted(str(e[link].given_name) for e in entries(Person, obj, adjacency))


# --- Self-relations ---

ada = store.Person().given_name('Ada').family_name('Lovelace').birth_date('1815-12-10').create()
bob = store.Person().given_name('Bob').parents(lambda a: a.insert(lambda x: x.parent(ada).kind('biological'))).create()

# The entry is one fact, visible from both ends.
assert names(ada, 'children', 'child') == ['Bob'] and names(bob, 'parents', 'parent') == ['Ada']

# Inline creation through a link: 'child' is filled only by Person, so the new object's schema is unambiguous.
carol = (
    store.Person()
    .given_name('Carol')
    .children(lambda a: a.insert(lambda x: x.child(lambda y: y.given_name('Dan').birth_date('2001-02-03')).kind('adoptive')))
    .create()
)
dan = entries(Person, carol, 'children')[0]['child']
assert str(dan.given_name) == 'Dan' and dan.as_schema().name == 'Person'

# --- Multiple owners: Dan has two parents, through two separate entries ---

store.Person(dan).parents(lambda a: a.insert(lambda x: x.parent(ada).kind('biological'))).update()
assert names(dan, 'parents', 'parent') == ['Ada', 'Carol']
assert names(ada, 'children', 'child') == ['Bob', 'Dan']

# --- Two different relations between the same pair ---

store.Person(ada).mentees(lambda a: a.insert(lambda x: x.mentee(bob))).update()
assert names(bob, 'parents', 'parent') == ['Ada'] and names(bob, 'mentors', 'mentor') == ['Ada']

# --- Duplicate elision, and entries that differ only by a property ---

store.Person(bob).parents(lambda a: a.insert(lambda x: x.parent(ada).kind('biological'))).update()
assert kinds(bob, 'parents') == ['biological']  # adding an equal entry is elided

store.Person(bob).parents(lambda a: a.insert(lambda x: x.parent(ada).kind('adoptive'))).update()
assert kinds(bob, 'parents') == ['adoptive', 'biological']  # a different property value is a different entry

# An entry without the optional property is different again.
store.Person(bob).parents(lambda a: a.insert(lambda x: x.parent(ada))).update()
assert len(entries(Person, bob, 'parents')) == 3 and 'kind' not in entries(Person, bob, 'parents')[-1]

# --- Removing entries through a builder ---


def keep_biological(adjacency):
    for entry in list(bob.parents):  # an entry given as a value removes the entries equal to it
        if entry.kind.get() != 'biological':
            adjacency.remove(entry)
    return adjacency


store.Person(bob).parents(keep_biological).update()
assert kinds(bob, 'parents') == ['biological']
assert names(ada, 'children', 'child') == ['Bob', 'Dan']  # removed from both ends: it was one fact

# --- A self-loop and a cycle ---

store.Person(carol).mentees(lambda a: a.insert(lambda x: x.mentee(carol))).update()  # Carol mentors herself
assert names(carol, 'mentees', 'mentee') == ['Carol'] and names(carol, 'mentors', 'mentor') == ['Carol']

store.Person(dan).mentees(lambda a: a.insert(lambda x: x.mentee(ada))).update()  # ada -> dan by parentage, dan -> ada by mentorship
assert {str(p.given_name) for p in Reachable.of(ada)} == {'Ada', 'Bob', 'Carol', 'Dan'}
assert Reachable.of(ada)[0] is ada  # the root comes first
assert {str(p.given_name) for p in Reachable.of(bob)} == {str(p.given_name) for p in Reachable.of(ada)}  # same component

loner = store.Person().given_name('Eve').create()
assert Reachable.of(loner) == [loner]

# --- clone() copies adjacency entries ---

bob2 = store.Person(bob).given_name('Bob II').clone()
assert kinds(bob2, 'parents') == ['biological'] and names(bob2, 'mentors', 'mentor') == ['Ada']
assert names(ada, 'children', 'child') == ['Bob', 'Bob II', 'Dan']
assert str(bob.given_name) == 'Bob'

# --- Building entries ---

with raises(TypeError):
    store.Person().parents(lambda a: a.insert(lambda x: x.child(bob)))  # the object's own link ('child') is implied
with raises(TypeError):
    store.Person().parents(lambda a: a.insert(lambda x: x.parent(ada).since('1990')))  # not a property of Parentage
with raises(ValueError):
    store.Person().parents(lambda a: a.insert(lambda x: x.kind('biological'))).create()  # the 'parent' link is never set
with raises(TypeError):
    store.Person().parents(x=ada)  # an adjacency takes a Spec

# --- Validation ---

# Cycles, a self-loop, and several relations between the same people are all valid.
assert Validators.Validate(store).Reachable(Person, ada) == []

# --- Round trips, from any root ---

# Read into another store, a snapshot builds objects of the same identities; read into the store that holds them, it
# updates them through their builders, and reading it again changes nothing.
archive = Proxies.OfStore()
for schema in (Person, Parentage, Mentorship):
    archive.register(schema)
for root in (ada, carol, loner):
    graph = Plain.ToPlain(store).Reachable(Person, root)
    restored = Plain.FromPlain(archive).Reachable(Person, graph)
    assert restored is not root and restored.as_identity() == root.as_identity()
    assert str(restored.given_name) == str(root.given_name)
    assert same_graph(Plain.ToPlain(archive).Reachable(Person, restored), graph)
    assert Plain.FromPlain(store).Reachable(Person, graph) is root

print('FamilyTree: all checks passed')
