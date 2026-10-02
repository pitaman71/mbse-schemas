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
        lambda prop: prop.name('given_name').of(lambda t: t.as_native(str)),
        lambda prop: prop.name('family_name').of(lambda t: t.as_native(str)),
        lambda prop: prop.name('birth_date').of(lambda t: t.as_native(str)),  # ISO 8601 calendar date
    )
    .create()
)

# Both links of these relations are filled by Person objects.
Parentage = (
    Schemas.OfRelation.Builder().name('Parentage')
    .links('parent', 'child')
    .properties(lambda prop: prop.name('kind').of(lambda t: t.as_native(str)))  # 'biological', 'adoptive'
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
    return sorted(e[link].given_name for e in entries(Person, obj, adjacency))


# --- Self-relations ---

ada = store.Person().given_name('Ada').family_name('Lovelace').birth_date('1815-12-10').create()
bob = store.Person().given_name('Bob').parents(lambda x: x.parent(ada).kind('biological')).create()

# The entry is one fact, visible from both ends.
assert names(ada, 'children', 'child') == ['Bob'] and names(bob, 'parents', 'parent') == ['Ada']

# Inline creation through a link: 'child' is filled only by Person, so the new object's schema is unambiguous.
carol = (
    store.Person()
    .given_name('Carol')
    .children(lambda x: x.child(lambda y: y.given_name('Dan').birth_date('2001-02-03')).kind('adoptive'))
    .create()
)
dan = entries(Person, carol, 'children')[0]['child']
assert dan.given_name == 'Dan' and dan.schema_name() == 'Person'

# --- Multiple owners: Dan has two parents, through two separate entries ---

store.Person(dan).parents(lambda x: x.parent(ada).kind('biological')).update()
assert names(dan, 'parents', 'parent') == ['Ada', 'Carol']
assert names(ada, 'children', 'child') == ['Bob', 'Dan']

# --- Two different relations between the same pair ---

store.Person(ada).mentees(lambda x: x.mentee(bob)).update()
assert names(bob, 'parents', 'parent') == ['Ada'] and names(bob, 'mentors', 'mentor') == ['Ada']

# --- Duplicate elision, and entries that differ only by a property ---

store.Person(bob).parents(lambda x: x.parent(ada).kind('biological')).update()
assert kinds(bob, 'parents') == ['biological']  # adding an equal entry is elided

store.Person(bob).parents(lambda x: x.parent(ada).kind('adoptive')).update()
assert kinds(bob, 'parents') == ['adoptive', 'biological']  # a different property value is a different entry

# An entry without the optional property is different again.
store.Person(bob).parents(lambda x: x.parent(ada)).update()
assert len(entries(Person, bob, 'parents')) == 3 and 'kind' not in entries(Person, bob, 'parents')[-1]

# --- Removing entries through a builder ---


def kind_of(entry):
    found = []
    if entry.has('kind'):
        entry.property('kind', lambda p: p.value(lambda v: v.as_native(lambda n: found.append(n.get()))))
    return found[0] if found else None


store.Person(bob).adjacency(
    'parents', lambda a: a.entries(lambda e: a.remove(e) if kind_of(e) != 'biological' else None)
).update()
assert kinds(bob, 'parents') == ['biological']
assert names(ada, 'children', 'child') == ['Bob', 'Dan']  # removed from both ends: it was one fact

# --- A self-loop and a cycle ---

store.Person(carol).mentees(lambda x: x.mentee(carol)).update()  # Carol mentors herself
assert names(carol, 'mentees', 'mentee') == ['Carol'] and names(carol, 'mentors', 'mentor') == ['Carol']

store.Person(dan).mentees(lambda x: x.mentee(ada)).update()  # ada -> dan by parentage, dan -> ada by mentorship
assert {p.given_name for p in Reachable.of(ada)} == {'Ada', 'Bob', 'Carol', 'Dan'}
assert Reachable.of(ada)[0] is ada  # the root comes first
assert {p.given_name for p in Reachable.of(bob)} == {p.given_name for p in Reachable.of(ada)}  # same component

loner = store.Person().given_name('Eve').create()
assert Reachable.of(loner) == [loner]

# --- clone() copies adjacency entries ---

bob2 = store.Person(bob).given_name('Bob II').clone()
assert kinds(bob2, 'parents') == ['biological'] and names(bob2, 'mentors', 'mentor') == ['Ada']
assert names(ada, 'children', 'child') == ['Bob', 'Bob II', 'Dan']
assert bob.given_name == 'Bob'

# --- Entry rules ---

with raises(AttributeError):
    store.Person().parents(lambda x: x.child(bob))  # the object's own link ('child') is implied
with raises(AttributeError):
    store.Person().parents(lambda x: x.parent(ada).since('1990'))  # not a property of Parentage
with raises(ValueError):
    store.Person().parents(lambda x: x.kind('biological')).create()  # the 'parent' link is never set
with raises(TypeError):
    store.Person().parents(x=ada)  # an adjacency takes an entry Spec

# --- Validation ---

# Cycles, a self-loop, and several relations between the same people are all valid.
assert Validators.Validate(store).Reachable(Person, ada) == []

# --- Round trips, from any root ---

for root in (ada, carol, loner):
    graph = Plain.ToPlain(store).Reachable(Person, root)
    restored = Plain.FromPlain(store).Reachable(Person, graph)
    assert restored is not root and restored.given_name == root.given_name
    assert same_graph(Plain.ToPlain(store).Reachable(Person, restored), graph)

print('FamilyTree: all checks passed')
