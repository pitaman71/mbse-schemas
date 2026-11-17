"""Validators: check data against its schema, only when the caller asks.

`Validate(store)(schema, value)` returns a list of problems (empty when valid). It is constructed with the store that
looks schemas up by name (see `Visitors.OfStore`). `Validate(store).Reachable(schema, root)` checks the root and every object
reachable from it.

`Check(store)(schema, value)` checks the same, and also reports what it cannot decide: an `Outcome` of `problems` and
`unknowns`, which `holds` true, false or unknown.

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
- an intersection value holds every one of the intersection's parts, each with a value of that part's schema;
- each parameter reference standing in the place of a value, or of an object a link links, is valid in its parameter
  context, `Parametrics.Context`: the context assigns its parameter a value of the schema the place expects, or, at a
  link, binds it to an object that may fill the link; else it is invalid. A parameter bound to a parameter reference
  that the context around it neither assigns nor binds is unknown at a link
  ([CAP-313: parameter references valid where their parameters are assigned or bound](mbse:mbse-basis/docs/capabilities/README.md#CAP-313));
- a parameter assignment's value is of the schema its parameter is for (`Parametrics.ForValue`), and a parameter
  binding's object of the object schema its parameter is for (`Parametrics.ForObject`).

Each entry point takes a parameter context, empty unless the caller gives one. Where validation meets a reference
object that holds parameter assignments or parameter bindings (`Parametrics.extend`'s `assigned_values` and
`bound_objects`), it validates the object's properties and its other entries in a sub-context, which maps those
parameters' names to the values assigned and the objects bound, hiding the same names in the context around it. The
object's own assignments and bindings are checked in the context around it, so that none resolves through itself. A
sub-context follows validation's own descent, into an object's properties and entries and, through them, into the
values, value objects, union and intersection values and containers they hold; `Reachable` checks each object reached
in the caller's context, with that object's own sub-context.
"""

from __future__ import annotations

from collections.abc import Hashable
from dataclasses import dataclass
from typing import Any

from . import Builders, Parametrics, Proxies, Reachable, Readers, Schemas, Visitors
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


def _is_of(value: Any, expected: Any) -> bool:
    """Whether a value, a scalar or a visitor, is of `expected`, as a place declared to hold a value of `expected` holds
    it: a scalar of its host type, or a value of the schema or of a refinement of it, or of one of an `OfAny`'s."""
    own = _own(value)
    if isinstance(own, Schemas.OfScalar.Data):
        held = expected.schemas if isinstance(expected, Schemas.OfAny.Value) else (expected,)
        return any(isinstance(t, Schemas.OfScalar.Data) and t.type is own.type for t in held)
    return Proxies._admits(expected, own)


def _shown(schema: Any) -> str:
    """A registered schema in a message: a basic scalar's tag, or its name."""
    return schema.tag if isinstance(schema, Schemas.OfScalar.Data) else repr(schema.name)


_ASSIGNS, _BINDS = "Parametrics.AssignsValue", "Parametrics.BindsObject"


def _reference(label: str, name: str, schema: Any, context: Parametrics.Context) -> list[str]:
    """Problems with a parameter reference standing in the place of a value of `schema`: its context assigns its
    parameter a value of `schema`, or it is invalid (CAP-313)."""
    if context.assigned(name) is not None:
        return [] if _is_of(context.assigned(name), schema) else [
            f"{label}: parameter {name!r} is assigned a value of another schema than its place expects"]
    if context.bound(name) is not None:
        return [f"{label}: parameter {name!r} is bound to an object, where a value is expected"]
    return [f"{label}: parameter {name!r} is neither assigned nor bound in its context"]


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
    def __init__(self, store: Visitors.OfStore):
        self._store = store
        self.problems: list[str] = []
        self.unknowns: list[str] = []
        self._schemas_checked: set[int] = set()
        self._entries: dict[int, tuple[Schemas.OfRelation.Data, dict[Hashable, _Entry]]] = {}

    def _schema(self, label: str, schema: Any) -> None:
        if id(schema) in self._schemas_checked:
            return
        self._schemas_checked.add(id(schema))
        self.problems += [f"schema {label}: {problem}" for problem in schema.validate()]
        if isinstance(schema, Schemas.OfObject.Data):
            self.problems += [f"schema {label}: {problem}" for problem in _counted_owners(self._store, schema)]

    def object(self, label: str, schema: Schemas.OfObject.Data, value: Readers.OfObject,
               context: Parametrics.Context) -> None:
        """Checks an object, its properties and its entries; those of an object that assigns or binds parameters in a
        sub-context of `context` (CAP-313), but for its own assignments and bindings, checked in `context`."""
        self._schema(repr(schema.name), schema)
        inner = self._sub_context(schema, value, context)
        self.problems += self._properties(label, schema, value, inner)
        for name, adjacency in schema.adjacencies.items():
            own = adjacency.me == "object" and adjacency.relation.name in (_ASSIGNS, _BINDS)
            for i, entry in enumerate(getattr(value, name)):
                self.problems += self._entry(f"{label}.{name}[{i}]", adjacency, value, entry, context if own else inner)

    def _sub_context(self, schema: Schemas.OfObject.Data, value: Any, context: Parametrics.Context) -> Any:
        """The sub-context of `context` in which an object's properties and entries are checked: each parameter the
        object assigns a value, or binds to an object, through `Parametrics.extend`'s adjacencies, named as its set of
        parameters names it, maps to that value or object. A parameter bound to a parameter reference maps to what
        `context` maps the reference's parameter to, or, where `context` maps it to nothing, to the reference."""
        inner = context
        for name, adjacency in schema.adjacencies.items():
            if adjacency.me != "object" or adjacency.relation.name not in (_ASSIGNS, _BINDS):
                continue
            for entry in getattr(value, name):
                named = None if Proxies._parameter_in(entry.param) is not None else Parametrics._named(self._store, entry.param)
                if named is None:  # a parameter reference in the parameter's place, or a parameter no set defines
                    continue
                if adjacency.relation.name == _ASSIGNS:
                    inner = inner.assign(named, _property_value(entry.value, adjacency.relation.entry.properties["value"].schema))
                    continue
                parameter = Proxies._parameter_in(entry.obj_ref)
                if parameter is not None and context.assigned(parameter.name.get()) is not None:
                    inner = inner.assign(named, context.assigned(parameter.name.get()))
                    continue
                held = None if parameter is None else context.bound(parameter.name.get())
                inner = inner.bind(named, entry.obj_ref if held is None else held)
        return inner

    def _linked(self, label: str, relation: Schemas.OfRelation.Data, link: str, name: str,
                context: Parametrics.Context) -> list[str]:
        """Problems with a parameter reference standing in the place of the object that `link` links: its context binds
        its parameter to an object that may fill the link, or it is invalid; bound to a parameter reference that the
        context around the binding neither assigns nor binds, it is unknown (CAP-313)."""
        target = context.bound(name)
        if target is not None and Proxies._parameter_in(target) is not None:
            self.unknowns.append(f"{label}: parameter {name!r} is bound to parameter "
                                 f"{Proxies._parameter_in(target).name.get()!r}, which its context neither assigns nor binds")
            return []
        if target is not None:
            problem = _filling(relation, link, _visited(target, self._store).as_schema())
            return [] if problem is None else [f"{label}: parameter {name!r} is bound to an object of another schema: {problem}"]
        if context.assigned(name) is not None:
            return [f"{label}: parameter {name!r} is assigned a value, where an object is expected"]
        return [f"{label}: parameter {name!r} is neither assigned nor bound in its context"]

    def _properties(self, label: str, schema: Any, value: Any, context: Parametrics.Context) -> list[str]:
        problems = []
        for prop in value.as_properties:
            name, held = prop.as_schema().name, prop.as_schema().schema
            standing = _standing_in_property(prop, held)
            if standing is not None:
                problems += _reference(f"{label}.{name}", standing, held, context)
            problems += self._value_problems(f"{label}.{name}", held, _property_value(prop, held), context)
        return problems

    def _value_problems(self, label: str, schema: Schemas.OfAny.Data, item: Any, context: Parametrics.Context) -> list[str]:
        """Problems with a value: its schema, recursively, and that an intersection value holds every part; and each
        parameter reference standing in the place of a value it holds, in `context`."""
        if schema is None or item is None:
            return []
        if isinstance(schema, Schemas.OfScalar.Data):
            problem = _scalar_problem(schema, item)
            return [f"{label}: {problem}"] if problem else []
        if isinstance(schema, Schemas.OfAny.Value):
            return self._any_problems(label, schema, item, context)
        if isinstance(schema, Schemas.OfContainer.Data):
            problems = []
            for index, element in _pairs(item):
                at = repr(list(index)) if isinstance(index, tuple) else repr(index)  # a tuple shown as a list
                standing = _standing(element, schema.element)
                if standing is not None:
                    problems += _reference(f"{label}[{at}]", standing, schema.element, context)
                    continue
                problems += self._value_problems(f"{label}[{at}]", schema.element, _element(element, schema.element),
                                                 context)
            return problems
        if isinstance(schema, Schemas.OfObject.Data):
            return self._properties(label, schema, item, context)
        problems = []
        held = {name: _member(getattr(item, name), m.schema) for name, m in schema.properties.items()}
        for name, member in schema.properties.items():
            read = getattr(item, name)
            standing = _standing(read, member.schema) if isinstance(read, Proxies._Empty) else None
            if standing is not None:
                problems += _reference(f"{label}.{name}", standing, member.schema, context)
            problems += self._value_problems(f"{label}.{name}", member.schema, held[name], context)
        missing = [name for name in schema.properties if held[name] is None]
        if isinstance(schema, Schemas.OfIntersection.Data) and missing:
            problems.append(f"{label}: parts {missing} are not set")
        return problems

    def _any_problems(self, label: str, schema: Schemas.OfAny.Value, item: Any, context: Parametrics.Context) -> list[str]:
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
        return self._value_problems(label, own, item, context)

    def _entry(self, label: str, adjacency: Schemas.OfAdjacency.Data, owner: Any, entry: Any,
               context: Parametrics.Context) -> list[str]:
        """Problems with one entry: each linked object's schema declares an adjacency to the relation via its link, and
        its values have their schemas; each parameter reference in its place is valid in `context`; and a parameter
        assignment's value, or a parameter binding's object, is of the schema its parameter is for."""
        relation = adjacency.relation
        self._schema(f"of {label}", relation)
        problems = []
        for name in relation.entry.links:
            if name == adjacency.me:
                continue
            parameter = Proxies._parameter_in(getattr(entry, name))
            if parameter is not None:  # a parameter reference in the place of an object: valid where bound (CAP-313)
                problems += self._linked(f"{label}.{name}", relation, name, parameter.name.get(), context)
                continue
            problem = _filling(relation, name, _visited(getattr(entry, name), self._store).as_schema())
            if problem:
                problems.append(f"{label}.{name}: {problem}")
        for name, prop in relation.entry.properties.items():
            standing = _standing_in_property(getattr(entry, name), prop.schema)
            if standing is not None:
                problems += _reference(f"{label}.{name}", standing, prop.schema, context)
            problems += self._value_problems(f"{label}.{name}", prop.schema,
                                             _property_value(getattr(entry, name), prop.schema), context)
        if relation.name in (_ASSIGNS, _BINDS):
            problems += self._parameter_schema(label, relation, entry, context)
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

    def _parameter_schema(self, label: str, relation: Schemas.OfRelation.Data, entry: Any,
                          context: Parametrics.Context) -> list[str]:
        """Problems with a parameter assignment's value, or a parameter binding's object: it is of the schema its
        parameter is for (`Parametrics.ForValue`, `ForObject`); a value is assigned, and an object bound, to a parameter
        for one (CAP-314, checked as CAP-313 decides). A parameter reference in the parameter's place is not checked: its
        schema is not known here."""
        if Proxies._parameter_in(entry.param) is not None:
            return []
        for_value = Parametrics._for(self._store, entry.param, "Parametrics.ForValue")
        for_object = Parametrics._for(self._store, entry.param, "Parametrics.ForObject")
        if relation.name == _ASSIGNS:
            value = _property_value(entry.value, relation.entry.properties["value"].schema)
            if for_object is not None:
                return [f"{label}: a value is assigned to a parameter for an object"]
            if for_value is None or value is None or _is_of(value, for_value):
                return []
            return [f"{label}.value: a value of {_shown(_own(value))} is assigned to a parameter for a value of "
                    f"{_shown(for_value)}"]
        if for_value is not None:
            return [f"{label}: an object is bound to a parameter for a value"]
        parameter = Proxies._parameter_in(entry.obj_ref)
        target = entry.obj_ref if parameter is None else context.bound(parameter.name.get())
        if for_object is None or target is None or Proxies._parameter_in(target) is not None:
            return []  # a parameter reference that its context does not bind to an object is reported as a link's
        bound = _visited(target, self._store).as_schema()
        if Schemas.is_a(bound, for_object):
            return []
        return [f"{label}.obj_ref: a {bound.name!r} is bound to a parameter for an object of {for_object.name!r}"]

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
    could not be decided."""

    problems: list[str]
    unknowns: list[str]

    @property
    def holds(self) -> bool | None:
        """Whether the data is valid: False with a problem, else None with an unknown, else True."""
        return False if self.problems else None if self.unknowns else True


class Check:
    """Checks data against its schema: `Check(store)(schema, value)` gives an `Outcome`, dispatching on the schema's
    kind."""

    def __init__(self, store: Visitors.OfStore):
        self._store = store

    def __call__(self, schema: Schemas.OfAny.Data, value: Any, context: Parametrics.Context | None = None) -> Outcome:
        schema = Proxies._deref(schema)  # a path names its schema
        if isinstance(schema, Schemas.OfScalar.Data):
            return self.OfScalar(schema, value, context)
        if isinstance(schema, Schemas.OfObject.Data):
            return self.OfObject(schema, value, context)
        raise NotImplementedError(f"{type(schema).__name__} cannot be validated yet")

    def OfScalar(self, schema: Schemas.OfScalar.Data, value: Scalar, context: Parametrics.Context | None = None) -> Outcome:
        """Checks a scalar; a parameter reference given in its place, in `context`."""
        schema = Proxies._deref(schema)  # a path names its schema
        if Proxies._is_parameter(value):
            return Outcome(schema.validate() + _reference("the value", value.name.get(), schema,
                                                          context or Parametrics.Context()), [])
        problem = _scalar_problem(schema, value)
        return Outcome(schema.validate() + ([problem] if problem else []), [])

    def OfObject(self, schema: Schemas.OfObject.Data, value: Readers.OfObject,
                 context: Parametrics.Context | None = None) -> Outcome:
        """Checks one object and its entries; uniqueness only over the entries it is part of."""
        schema = Proxies._deref(schema)  # a path names its schema
        return self._run(schema, [value], context or Parametrics.Context())

    def Reachable(self, schema: Schemas.OfObject.Data, root: Readers.OfObject,
                  context: Parametrics.Context | None = None) -> Outcome:
        """Checks the root and every object reachable from it through adjacencies, each in `context`."""
        schema = Proxies._deref(schema)  # a path names its schema
        return self._run(schema, Reachable.of(root), context or Parametrics.Context())

    def _run(self, schema: Schemas.OfObject.Data, values: list[Readers.OfObject], context: Parametrics.Context) -> Outcome:
        """Checks the objects, each by its own schema; the first, the root, must be an instance of `schema`: of it, or
        of a refinement of it, since an instance of a refinement is an instance of what it refines (`Schemas.is_a`)."""
        root = values[0]
        if not Schemas.is_a(root.as_schema(), schema):
            return Outcome([f"the value is a {root.as_schema().name!r}, not an instance of the given schema"], [])
        check = _Check(self._store)
        for i, value in enumerate(values):
            check.object(f"{value.as_schema().name}#{i}", value.as_schema(), value, context)
        check.uniques()
        return Outcome(check.problems, check.unknowns)


class Validate:
    """Validates data against its schema: `Validate(store)(schema, value)` gives the problems `Check` finds, so what
    is unknown is not a problem."""

    def __init__(self, store: Visitors.OfStore):
        self._check = Check(store)

    def __call__(self, schema: Schemas.OfAny.Data, value: Any, context: Parametrics.Context | None = None) -> list[str]:
        schema = Proxies._deref(schema)  # a path names its schema
        return self._check(schema, value, context).problems

    def OfScalar(self, schema: Schemas.OfScalar.Data, value: Scalar, context: Parametrics.Context | None = None) -> list[str]:
        """Checks a scalar; a parameter reference given in its place, in `context`."""
        schema = Proxies._deref(schema)  # a path names its schema
        return self._check.OfScalar(schema, value, context).problems

    def OfObject(self, schema: Schemas.OfObject.Data, value: Readers.OfObject,
                 context: Parametrics.Context | None = None) -> list[str]:
        """Checks one object and its entries; uniqueness only over the entries it is part of."""
        schema = Proxies._deref(schema)  # a path names its schema
        return self._check.OfObject(schema, value, context).problems

    def Reachable(self, schema: Schemas.OfObject.Data, root: Readers.OfObject,
                  context: Parametrics.Context | None = None) -> list[str]:
        """Checks the root and every object reachable from it through adjacencies, each in `context`."""
        schema = Proxies._deref(schema)  # a path names its schema
        return self._check.Reachable(schema, root, context).problems
