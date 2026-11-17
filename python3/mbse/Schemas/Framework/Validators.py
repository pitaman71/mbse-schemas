"""Validators: check data against its schema, only when the caller asks.

`Validate(store)(schema, value)` returns a list of problems (empty when valid). It is constructed with the store that
looks schemas up by name (see `Visitors.OfStore`). `Validate(store).Reachable(schema, root)` checks the root and every object
reachable from it.

`Check(store)(schema, value)` checks the same, and also reports what it cannot decide: an `Outcome` of `problems` and
`unknowns`, which `holds` true, false or unknown; and its `partials`, which with its problems give its `result`.

The validator reads the value through the visitor protocol (`Readers.OfObject`), through its schema. Checks:

- the schemas involved pass `validate()`;
- the root is an instance of the given schema: of it, or of a refinement of it, checked by its own schema, so that a
  member it narrows is checked as narrowed;
- each property value has exactly its schema's scalar type (distinct scalars are never interchangeable);
- each linked object's schema declares an adjacency to that relation via that link;
- nothing is owned by a counted object: a schema neither a singleton nor owned declares no adjacency that another
  schema's adjacency marked `owner()` makes an owner (object identity 47 in [CAP-118: singletons, owned and counted objects](mbse:mbse-basis/docs/capabilities/CAP-118.md#decided));
- `unique(S)` clauses hold over the entries seen: entries that agree on everything outside `S` agree on `S`.
  Uniqueness is checked only over the entries reachable from what was validated.
- a value object's properties hold values of their schemas, recursively, each checked by its own schema, a
  refinement's value by the refinement (`Schemas.is_a`);
- an intersection value holds every one of the intersection's parts, each with a value of that part's schema, a part
  that holds a parameter reference counting as held;
- each parameter reference standing in the place of a value, or of an object that a link links, is checked against
  the parameter context, a mapping from a parameter's name to the value assigned to it or the object or symbol bound
  to it, which each entry point takes as its last argument, empty unless the caller gives one
  ([CAP-313: parameter references valid where their parameters are assigned or bound](mbse:mbse-basis/docs/capabilities/README.md#CAP-313)).
  A reference is invalid, a problem, where the context maps its parameter to the wrong kind of thing (an object where
  its place expects a value, or a value where it expects an object) or to something of another schema than its place
  expects; partial, and valid, where the context does not map its parameter, which `Outcome.partials` lists; and bound,
  and valid, where the context maps its parameter to a value or an object of that schema. `Outcome.result` is
  "invalid", "partial" or "bound". Validation makes no sub-context: a dialect's statements that assign or bind
  parameters are its own procedures' to interpret.
"""

from __future__ import annotations

from collections.abc import Hashable
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from . import Builders, Proxies, Reachable, Readers, Schemas, Visitors
from .Visitors import Scalar

__all__ = ["Validate", "Check", "Outcome"]


# --- Reading values through their visitors ---


_SCALARS = (int, float, str, bool, bytes)


def _scalar(read: Any) -> Any:
    """The scalar a property's visitor holds, or None."""
    found: list[Any] = []
    read.as_scalar(lambda s: found.append(s.get()) or s)
    return found[0] if found else None


_SELECT = {Schemas.OfObject.Data: "as_object", Schemas.OfUnion.Data: "as_union",
           Schemas.OfIntersection.Data: "as_intersection", Schemas.OfContainer.Data: "as_container"}


def _any_of(read: Any) -> Any:
    """The value of any schema a `Visitors.OfAny` holds: a scalar, a visitor of its own kind, or None."""
    found: list[Any] = []
    read.as_scalar(lambda s: found.extend([] if s.get() is None else [s.get()]) or s)
    for select in ("as_object", "as_union", "as_intersection", "as_container"):
        getattr(read, select)(lambda v: found.extend([v] if v.as_schema() is not None else []) or v)
    return found[0] if found else None


def _own(value: Any) -> Any:
    """The schema a value of any schema has: a scalar's, or its visitor's schema."""
    return Schemas.OfScalar.Data(type(value)) if type(value) in _SCALARS else value.as_schema()


def _held(read: Any, schema: Any) -> Any:
    """The value object, union value or intersection value a property's visitor holds, as its own visitor; None when
    absent. An empty visitor has no identity."""
    found: list[Any] = []
    if isinstance(schema, Schemas.OfAny.Value):
        read.as_value(lambda a: found.append(_any_of(a)) or a)
        return found[0]
    read.as_value(lambda a: getattr(a, _SELECT[type(schema)])(lambda v: found.append(v) or v) or a)
    return found[0] if found[0].as_schema() is not None else None  # a callback is always called; a visitor of nothing has no schema


def _member(read: Any, schema: Any) -> Any:
    """A union's branch's or an intersection's part's value, read through its visitor of its own schema's kind: a scalar,
    a visitor, or None."""
    if isinstance(schema, Schemas.OfScalar.Data):
        return read.get()
    return read if read.as_schema() is not None else None


def _element(read: Any, schema: Any) -> Any:
    """A container's element, read through its `Visitors.OfAny`: a scalar or a visitor; an element present holds one."""
    held = schema
    found: list[Any] = []
    if isinstance(held, Schemas.OfScalar.Data) or held is None:
        read.as_scalar(lambda s: found.append(s.get()) or s)
        return found[0]
    if isinstance(held, Schemas.OfAny.Value):
        return _any_of(read)
    getattr(read, _SELECT[type(held)])(lambda v: found.append(v) or v)
    return found[0]


def _standing(read: Any, schema: Any) -> Any:
    """The name of the parameter that a parameter reference designates, where one stands in the place of a value of
    `schema` that `read`, a `Visitors.OfAny` or an empty visitor, reads; else None (CAP-312)."""
    found: list[Any] = []
    read.as_parameter(lambda p: found.extend([p] if p.as_schema() is not None else []) or p)
    return found[0].name.get() if found and not Proxies._admits(schema, found[0].as_schema()) else None


def _standing_in_property(read: Any, schema: Any) -> Any:
    """The name of the parameter that a parameter reference designates, where one stands in the place of a property's
    value; else None."""
    found: list[Any] = []
    read.as_value(lambda a: found.append(_standing(a, schema)) or a)
    return found[0]


def _pairs(read: Any) -> list[tuple[Any, Any]]:
    """A container's elements, each with its index, in order."""
    pairs: list[tuple[Any, Any]] = []
    read.as_entries(lambda it: pairs.extend(it))
    return pairs


def _identity(target: Any) -> Hashable:
    """A linked object's identity, unique among the objects of every schema: an identity is unique within its schema."""
    return id(target.as_schema()), Proxies._key_of(target)


# --- Checks ---


def _is_object(target: Any) -> bool:
    """Whether what a parameter context maps a name to is an object, a reference object, a schema object or a symbol,
    rather than a value."""
    return isinstance(target, Schemas.OfSymbol.Data) or Builders._builder_for(target) is not None or isinstance(
        Proxies._durable(target), Proxies._ObjectData)


def _is_of(value: Any, expected: Any) -> bool:
    """Whether a value, a scalar or a visitor, is of `expected`, as a place declared to hold a value of `expected` holds
    it: a scalar of its host type, or a value of the schema or of a refinement of it, or of one of an `OfAny`'s."""
    own = _own(value)
    if isinstance(own, Schemas.OfScalar.Data):
        held = expected.schemas if isinstance(expected, Schemas.OfAny.Value) else (expected,)
        return any(isinstance(t, Schemas.OfScalar.Data) and t.type is own.type for t in held)
    return Proxies._admits(expected, own)


def _scalar_problem(schema: Schemas.OfScalar.Data, value: Any) -> str | None:
    if schema.type is None:  # not a basic scalar: the schema's own problem, reported by its validate()
        return None
    if type(value) is not schema.type:
        return f"expected {schema.type.__name__}, got {type(value).__name__}"
    return None


def _visited(target: Any, store: Any) -> Any:
    """A linked object, as a visitor: a schema object, which an extension's relation links, through its read-only
    builder in `store`, whose schema is the store's plain schema of it."""
    builder = Builders._builder_for(target)
    return target if builder is None else builder(target, False, store)


def _linked_identity(target: Any, store: Any) -> Hashable:
    """What a link links, as uniqueness tells it apart: the object's identity, or the parameter a parameter reference
    in its place designates (CAP-312)."""
    parameter = Proxies._parameter_in(target)
    return _identity(_visited(target, store)) if parameter is None else Proxies._link_key(parameter)


_BOUND = ("Parametrics.BindsObject", "obj_ref")  # the object a parameter is bound to: any reference object


def _filling(relation: Schemas.OfRelation.Data, name: str, schema: Schemas.OfObject.Data) -> str | None:
    """Whether an object of `schema` may fill link `name` of `relation`: its schema must declare an adjacency via it,
    named or anonymous; but the object a parameter is bound to, `Parametrics.BindsObject`'s `obj_ref`, may be any
    reference object, whose schema opts into nothing ([CAP-314: parameters bound by the data objects their schema governs](mbse:mbse-basis/docs/capabilities/README.md#CAP-314))."""
    if schema.fills(relation, name) or (relation.name, name) == _BOUND:
        return None
    return (f"a {schema.name!r} cannot fill link {name!r}; its schema declares no adjacency, named or anonymous, to this "
            f"relation via {name!r}")


def _counted_owners(store: Visitors.OfStore, schema: Schemas.OfObject.Data) -> list[str]:
    """The adjacencies of a counted schema, neither a singleton nor owned, through which it would own an object of a
    schema whose adjacency marked `owner()` is the other end: nothing is owned by a counted object (object identity
    47 in [CAP-118: singletons, owned and counted objects](mbse:mbse-basis/docs/capabilities/CAP-118.md#decided))."""
    adjacencies = (*schema.adjacencies.values(), *schema.anonymous)
    if schema.singleton is not None or any(a.owner for a in adjacencies):
        return []
    problems = []
    for adjacency in adjacencies:
        for name in store.names():
            owned = store.registered(name)
            if isinstance(owned, Schemas.OfObject.Data) and any(
                    a.owner and a.relation is adjacency.relation and a.me != adjacency.me
                    for a in (*owned.adjacencies.values(), *owned.anonymous)):
                problems.append(f"adjacency {adjacency.name or adjacency.relation.name!r} would own a {name!r}, through its "
                                f"adjacency marked owner(): nothing is owned by a counted object, which a {schema.name!r} is")
    return problems


_ABSENT = ("absent",)


def _key(schema: Any, value: Any) -> Hashable:
    """Equality key per [CAP-111: equality and ordering defined by the schema](mbse:mbse-basis/docs/capabilities/CAP-111.md), of a value read as `_property_value` reads it: distinct scalars never compare
    equal; floats compare by bit pattern; a value object by its properties."""
    held = schema
    if value is None:
        return _ABSENT
    if isinstance(held, Schemas.OfScalar.Data) or held is None:
        return ("float", value.hex()) if isinstance(value, float) else (type(value).__name__, value)
    if isinstance(held, Schemas.OfAny.Value):
        own = _own(value)
        return ("any", own.tag if isinstance(own, Schemas.OfScalar.Data) else id(own), _key(own, value))
    if isinstance(held, Schemas.OfContainer.Data):
        return ("container", frozenset((index if not hasattr(index, "as_schema") else _key(held.index, index),
                                        _key(held.element, _element(e, held.element))) for index, e in _pairs(value)))
    if isinstance(held, Schemas.OfObject.Data):  # by its own schema: a refinement's value is not its base's
        properties = tuple((p.as_schema().name, _key(p.as_schema().schema, _property_value(p, p.as_schema().schema)))
                           for p in value.as_properties)
        return ("object", id(value.as_schema()), properties)
    members = tuple((name, _key(m.schema, _member(getattr(value, name), m.schema))) for name, m in held.properties.items())
    return ("record", members)


def _property_value(read: Any, schema: Any) -> Any:
    held = schema
    return _scalar(read) if isinstance(held, Schemas.OfScalar.Data) or held is None else _held(read, held)


class _Entry:
    """One relation entry with all its links, from whichever end it was seen: identities and value keys."""

    def __init__(self, links: dict[str, str], values: dict[str, Hashable]):
        self.links, self.values = links, values

    def key(self, names: set[str]) -> Hashable:
        return tuple(sorted((name, ("object", self.links[name]) if name in self.links
                             else self.values.get(name, _ABSENT)) for name in names))


class _Check:
    def __init__(self, store: Visitors.OfStore, context: Mapping[str, Any]):
        self._store, self._context = store, context
        self.problems: list[str] = []
        self.unknowns: list[str] = []
        self.partials: list[str] = []
        self._schemas_checked: set[int] = set()
        self._entries: dict[int, tuple[Schemas.OfRelation.Data, dict[Hashable, _Entry]]] = {}

    def _schema(self, label: str, schema: Any) -> None:
        if id(schema) in self._schemas_checked:
            return
        self._schemas_checked.add(id(schema))
        self.problems += [f"schema {label}: {problem}" for problem in schema.validate()]
        if isinstance(schema, Schemas.OfObject.Data):
            self.problems += [f"schema {label}: {problem}" for problem in _counted_owners(self._store, schema)]

    def object(self, label: str, schema: Schemas.OfObject.Data, value: Readers.OfObject) -> None:
        self._schema(repr(schema.name), schema)
        self.problems += self._properties(label, schema, value)
        for name, adjacency in schema.adjacencies.items():
            for i, entry in enumerate(getattr(value, name)):
                self.problems += self._entry(f"{label}.{name}[{i}]", adjacency, value, entry)

    def reference(self, label: str, name: str, schema: Any) -> list[str]:
        """Problems with a parameter reference standing in the place of a value of `schema`: invalid where the context
        maps its parameter to an object, or to a value of another schema; partial where it maps it to nothing (CAP-313)."""
        if name not in self._context:
            self.partials.append(f"{label}: parameter {name!r} is neither assigned nor bound in its context")
            return []
        target = self._context[name]
        if _is_object(target):
            return [f"{label}: parameter {name!r} is bound to an object, where a value is expected"]
        if _is_of(target, schema):
            return []
        return [f"{label}: parameter {name!r} is assigned a value of another schema than its place expects"]

    def _linked(self, label: str, relation: Schemas.OfRelation.Data, link: str, name: str) -> list[str]:
        """Problems with a parameter reference standing in the place of the object that `link` links: invalid where the
        context maps its parameter to a value, or to an object that may not fill the link; partial where it maps it to
        nothing (CAP-313). A symbol is of its schema, and may fill the link where each of its kinds may; one with no
        schema may stand for any object."""
        if name not in self._context:
            self.partials.append(f"{label}: parameter {name!r} is neither assigned nor bound in its context")
            return []
        target = self._context[name]
        if not _is_object(target):
            return [f"{label}: parameter {name!r} is assigned a value, where an object is expected"]
        if isinstance(target, Schemas.OfSymbol.Data):
            kinds = [] if target.schema is None else [b.schema for b in target.schema.branches] if isinstance(
                target.schema, Schemas.OfUnion.Data) else [target.schema]
        else:
            kinds = [_visited(target, self._store).as_schema()]
        found = [problem for problem in (_filling(relation, link, kind) for kind in kinds) if problem is not None]
        return [f"{label}: parameter {name!r} is bound to an object of another schema: {found[0]}"] if found else []

    def _properties(self, label: str, schema: Any, value: Any) -> list[str]:
        problems = []
        for prop in value.as_properties:
            name = prop.as_schema().name
            standing = _standing_in_property(prop, prop.as_schema().schema)
            if standing is not None:
                problems += self.reference(f"{label}.{name}", standing, prop.as_schema().schema)
            problems += self._value_problems(f"{label}.{name}", prop.as_schema().schema,
                                             _property_value(prop, prop.as_schema().schema))
        return problems

    def _value_problems(self, label: str, schema: Schemas.OfAny.Data, item: Any) -> list[str]:
        """Problems with a value: its schema, recursively, and that an intersection value holds every part."""
        if schema is None or item is None:
            return []
        if isinstance(schema, Schemas.OfScalar.Data):
            problem = _scalar_problem(schema, item)
            return [f"{label}: {problem}"] if problem else []
        if isinstance(schema, Schemas.OfAny.Value):
            return self._any_problems(label, schema, item)
        if isinstance(schema, Schemas.OfContainer.Data):
            problems = []
            for index, element in _pairs(item):
                at = repr(list(index)) if isinstance(index, tuple) else repr(index)  # a tuple shown as a list
                standing = _standing(element, schema.element)
                if standing is not None:
                    problems += self.reference(f"{label}[{at}]", standing, schema.element)
                    continue
                problems += self._value_problems(f"{label}[{at}]", schema.element, _element(element, schema.element))
            return problems
        if isinstance(schema, Schemas.OfObject.Data):
            return self._properties(label, schema, item)
        problems = []
        held = {name: _member(getattr(item, name), m.schema) for name, m in schema.properties.items()}
        standing = {name: _standing(getattr(item, name), m.schema) if isinstance(getattr(item, name), Proxies._Empty)
                    else None for name, m in schema.properties.items()}
        for name, member in schema.properties.items():
            if standing[name] is not None:
                problems += self.reference(f"{label}.{name}", standing[name], member.schema)
            problems += self._value_problems(f"{label}.{name}", member.schema, held[name])
        missing = [name for name in schema.properties if held[name] is None and standing[name] is None]
        if isinstance(schema, Schemas.OfIntersection.Data) and missing:
            problems.append(f"{label}: parts {missing} are not set")
        return problems

    def _any_problems(self, label: str, schema: Schemas.OfAny.Value, item: Any) -> list[str]:
        """Problems with a value of any schema: that it is of one of its schemas, where it is restricted, or of a
        registered schema, where it is not a scalar; and its own, under its own schema."""
        own, restricted = _own(item), list(schema.schemas)
        if isinstance(own, Schemas.OfScalar.Data):
            allowed = not restricted or any(isinstance(t, Schemas.OfScalar.Data) and t.type is own.type for t in restricted)
            shown = own.tag
        else:
            allowed, shown = any(Proxies._refines(own, t) for t in restricted), repr(own.name)
            if not restricted:
                try:
                    self._store.name_of(own)
                    allowed = True
                except LookupError:
                    return [f"{label}: a value of any schema is of a registered schema; {shown} is not registered"]
        if not allowed:
            return [f"{label}: {shown} is not one of its schemas"]
        return self._value_problems(label, own, item)

    def _entry(self, label: str, adjacency: Schemas.OfAdjacency.Data, owner: Any, entry: Any) -> list[str]:
        """Problems with one entry: each linked object's schema declares an adjacency to the relation via its link, and
        its values have their schemas."""
        relation = adjacency.relation
        self._schema(f"of {label}", relation)
        problems = []
        for name in relation.entry.links:
            if name == adjacency.me:
                continue
            parameter = Proxies._parameter_in(getattr(entry, name))
            if parameter is not None:  # a parameter reference in the place of an object (CAP-312), checked (CAP-313)
                problems += self._linked(f"{label}.{name}", relation, name, parameter.name.get())
                continue
            problem = _filling(relation, name, _visited(getattr(entry, name), self._store).as_schema())
            if problem:
                problems.append(f"{label}.{name}: {problem}")
        for name, prop in relation.entry.properties.items():
            standing = _standing_in_property(getattr(entry, name), prop.schema)
            if standing is not None:
                problems += self.reference(f"{label}.{name}", standing, prop.schema)
            problems += self._value_problems(f"{label}.{name}", prop.schema,
                                             _property_value(getattr(entry, name), prop.schema))
        links = {name: _linked_identity(getattr(entry, name), self._store)
                 for name in relation.entry.links if name != adjacency.me}
        links[adjacency.me] = _identity(owner)
        values = {name: _key(prop.schema, _property_value(getattr(entry, name), prop.schema))
                  for name, prop in relation.entry.properties.items()
                  if _property_value(getattr(entry, name), prop.schema) is not None}
        full = _Entry(links, values)
        _, seen = self._entries.setdefault(id(relation), (relation, {}))
        seen.setdefault(full.key(set(relation.entry.links) | set(relation.entry.properties)), full)
        return problems

    def uniques(self) -> None:
        for relation, entries in self._entries.values():
            names = set(relation.entry.links) | set(relation.entry.properties)
            for unique in relation.uniques:
                rest = names - unique
                determined: dict[Hashable, Hashable] = {}
                for entry in entries.values():
                    if determined.setdefault(entry.key(rest), entry.key(set(unique))) != entry.key(set(unique)):
                        self.problems.append(
                            f"unique({', '.join(sorted(unique))}) violated: entries agreeing on "
                            f"{sorted(rest)} differ on {sorted(unique)}"
                        )
                        break


# --- Entry points ---


@dataclass(frozen=True)
class Outcome:
    """What a check found: the `problems`, each a reason the data is invalid, and the `unknowns`, each something that
    could not be decided; and the `partials`, each a parameter reference whose parameter the context neither assigns
    nor binds, which is valid ([CAP-313: parameter references valid where their parameters are assigned or bound](mbse:mbse-basis/docs/capabilities/README.md#CAP-313))."""

    problems: list[str]
    unknowns: list[str]
    partials: list[str] = field(default_factory=list)

    @property
    def result(self) -> Literal["invalid", "partial", "bound"]:
        """The result of what was checked: "invalid" with a problem, an invalid parameter reference among them; else
        "partial" with a parameter reference that its context leaves unassigned and unbound; else "bound", every
        parameter reference in it bound, or none there."""
        return "invalid" if self.problems else "partial" if self.partials else "bound"

    @property
    def holds(self) -> bool | None:
        """Whether the data is valid: False with a problem, else None with an unknown, else True."""
        return False if self.problems else None if self.unknowns else True


class Check:
    """Checks data against its schema: `Check(store)(schema, value)` gives an `Outcome`, dispatching on the schema's
    kind."""

    def __init__(self, store: Visitors.OfStore):
        self._store = store

    def __call__(self, schema: Schemas.OfAny.Data, value: Any, context: Mapping[str, Any] | None = None) -> Outcome:
        schema = Proxies._deref(schema)  # a path names its schema
        if isinstance(schema, Schemas.OfScalar.Data):
            return self.OfScalar(schema, value, context)
        if isinstance(schema, Schemas.OfObject.Data):
            return self.OfObject(schema, value, context)
        raise NotImplementedError(f"{type(schema).__name__} cannot be validated yet")

    def OfScalar(self, schema: Schemas.OfScalar.Data, value: Scalar, context: Mapping[str, Any] | None = None) -> Outcome:
        """Checks a scalar; a parameter reference given in its place, in `context`."""
        schema = Proxies._deref(schema)  # a path names its schema
        if Proxies._is_parameter(value):
            check = _Check(self._store, context or {})
            problems = check.reference("the value", value.name.get(), schema)
            return Outcome(schema.validate() + problems, [], check.partials)
        problem = _scalar_problem(schema, value)
        return Outcome(schema.validate() + ([problem] if problem else []), [])

    def OfObject(self, schema: Schemas.OfObject.Data, value: Readers.OfObject, context: Mapping[str, Any] | None = None) -> Outcome:
        """Checks one object and its entries; uniqueness only over the entries it is part of."""
        schema = Proxies._deref(schema)  # a path names its schema
        return self._run(schema, [value], context or {})

    def Reachable(self, schema: Schemas.OfObject.Data, root: Readers.OfObject, context: Mapping[str, Any] | None = None) -> Outcome:
        """Checks the root and every object reachable from it through adjacencies."""
        schema = Proxies._deref(schema)  # a path names its schema
        return self._run(schema, Reachable.of(root), context or {})

    def _run(self, schema: Schemas.OfObject.Data, values: list[Readers.OfObject], context: Mapping[str, Any]) -> Outcome:
        """Checks the objects, each by its own schema; the first, the root, must be an instance of `schema`: of it, or
        of a refinement of it, since an instance of a refinement is an instance of what it refines (`Schemas.is_a`)."""
        root = values[0]
        if not Schemas.is_a(root.as_schema(), schema):
            return Outcome([f"the value is a {root.as_schema().name!r}, not an instance of the given schema"], [])
        check = _Check(self._store, context)
        for i, value in enumerate(values):
            check.object(f"{value.as_schema().name}#{i}", value.as_schema(), value)
        check.uniques()
        return Outcome(check.problems, check.unknowns, check.partials)


class Validate:
    """Validates data against its schema: `Validate(store)(schema, value)` gives the problems `Check` finds, so what
    is unknown is not a problem, nor is a partial parameter reference."""

    def __init__(self, store: Visitors.OfStore):
        self._check = Check(store)

    def __call__(self, schema: Schemas.OfAny.Data, value: Any, context: Mapping[str, Any] | None = None) -> list[str]:
        schema = Proxies._deref(schema)  # a path names its schema
        return self._check(schema, value, context).problems

    def OfScalar(self, schema: Schemas.OfScalar.Data, value: Scalar, context: Mapping[str, Any] | None = None) -> list[str]:
        """Checks a scalar; a parameter reference given in its place, in `context`."""
        schema = Proxies._deref(schema)  # a path names its schema
        return self._check.OfScalar(schema, value, context).problems

    def OfObject(self, schema: Schemas.OfObject.Data, value: Readers.OfObject, context: Mapping[str, Any] | None = None) -> list[str]:
        """Checks one object and its entries; uniqueness only over the entries it is part of."""
        schema = Proxies._deref(schema)  # a path names its schema
        return self._check.OfObject(schema, value, context).problems

    def Reachable(self, schema: Schemas.OfObject.Data, root: Readers.OfObject, context: Mapping[str, Any] | None = None) -> list[str]:
        """Checks the root and every object reachable from it through adjacencies."""
        schema = Proxies._deref(schema)  # a path names its schema
        return self._check.Reachable(schema, root, context).problems
