"""Validators: check data against its schema, only when the caller asks.

`Validate(store)(schema, value)` returns a list of problems (empty when valid). It is constructed with the store that
looks schemas up by name (see `Stores`). `Validate(store).Reachable(schema, root)` checks the root and every object
reachable from it.

`Check(store)(schema, value)` checks the same, and also reports what it cannot decide: an `Outcome` of `problems` and
`unknowns`, which `holds` true, false or unknown.

The validator reads the value through the visitor protocol (`Readers.OfObject`), through its schema. Checks:

- the schemas involved pass `validate()`;
- each property value has exactly its schema's scalar type (distinct scalar types are never interchangeable);
- each linked object's schema declares an adjacency to that relation via that link;
- `unique(S)` clauses hold over the entries seen: entries that agree on everything outside `S` agree on `S`.
  Uniqueness is checked only over the entries reachable from what was validated.
- a value object's properties hold values of their types, recursively;
- an intersection value holds every one of the intersection's parts, each with a value of that part's type.
"""

from __future__ import annotations

from collections.abc import Hashable
from dataclasses import dataclass
from typing import Any

from . import Reachable, Readers, Schemas, Stores
from .Visitors import Scalar

__all__ = ["Validate", "Check", "Outcome"]


# --- Reading values through their visitors ---


_SCALARS = (int, float, str, bool, bytes)


def _scalar(read: Any) -> Any:
    """The scalar a property's visitor holds, or None."""
    found: list[Any] = []
    read.as_scalar(lambda s: found.append(s.get()) or s)
    return found[0] if found else None


def _held(read: Any, schema: Any) -> Any:
    """The value object, union value or intersection value a property's visitor holds, as its own visitor; None when
    absent. An empty visitor has no identity."""
    select = {Schemas.OfObject.Data: "as_object", Schemas.OfUnion.Data: "as_union",
              Schemas.OfIntersection.Data: "as_intersection"}[type(schema)]
    found: list[Any] = []
    read.as_value(lambda a: getattr(a, select)(lambda v: found.append(v) or v) or a)
    return found[0] if found and found[0].as_schema() is not None else None  # a visitor of nothing has no schema


def _member(read: Any, schema: Any) -> Any:
    """A union's branch's or an intersection's part's value, read through its visitor of its own type's kind: a scalar,
    a visitor, or None."""
    if isinstance(Schemas.structure(schema), Schemas.OfScalar.Data):
        return read.get()
    return read if read.as_schema() is not None else None


def _identity(target: Any) -> Hashable:
    """A linked object's identity, unique among the objects of every schema: an identity is unique within its schema."""
    return id(target.as_schema()), target.as_identity()


# --- Checks ---


def _scalar_problem(schema: Schemas.OfScalar.Data, value: Any) -> str | None:
    if schema.type is None:  # an unsupported type is the schema's own problem, reported by its validate()
        token = schema.token
        return f"{token} has no type in this implementation" if isinstance(token, Schemas.OfScalar.Token) else None
    if type(value) is not schema.type:
        return f"expected {schema.type.__name__}, got {type(value).__name__}"
    return None


def _filling(relation: Schemas.OfRelation.Data, name: str, schema: Schemas.OfObject.Data) -> str | None:
    """Whether an object of `schema` may fill link `name` of `relation`: its schema must declare an adjacency via it."""
    if any(a.relation is relation and a.me == name for a in schema.adjacencies.values()):
        return None
    return (f"a {schema.name!r} cannot fill link {name!r}; its schema declares no adjacency to this relation via "
            f"{name!r}")


_ABSENT = ("absent",)


def _key(schema: Any, value: Any) -> Hashable:
    """Equality key per EQUALITY.md, of a value read as `_property_value` reads it: distinct scalar types never compare
    equal; floats compare by bit pattern; a value object by its properties and its entries, in order."""
    held = Schemas.structure(schema)
    if value is None:
        return _ABSENT
    if isinstance(held, Schemas.OfScalar.Data) or held is None:
        return ("float", value.hex()) if isinstance(value, float) else (type(value).__name__, value)
    if isinstance(held, Schemas.OfObject.Data):
        properties = tuple((p.as_schema().name, _key(p.as_schema().type, _property_value(p, p.as_schema().type)))
                           for p in value.as_properties)
        entries = tuple((name, tuple(_entry_key(e, a) for e in getattr(value, name)))
                        for name, a in held.adjacencies.items())
        return ("object", properties, entries)
    members = tuple((name, _key(m.type, _member(getattr(value, name), m.type))) for name, m in held.properties.items())
    return ("record", members)


def _property_value(read: Any, schema: Any) -> Any:
    held = Schemas.structure(schema)
    return _scalar(read) if isinstance(held, Schemas.OfScalar.Data) or held is None else _held(read, held)


def _entry_key(entry: Any, adjacency: Schemas.OfAdjacency.Data) -> Hashable:
    """An entry's equality key: its other links' targets by identity and its values by `_key`."""
    relation = adjacency.relation
    links = tuple((name, _identity(getattr(entry, name))) for name in relation.entry.links if name != adjacency.me)
    values = tuple((name, _key(prop.type, _property_value(getattr(entry, name), prop.type)))
                   for name, prop in relation.entry.properties.items())
    return links, values


class _Entry:
    """One relation entry with all its links, from whichever end it was seen: identities and value keys."""

    def __init__(self, links: dict[str, str], values: dict[str, Hashable]):
        self.links, self.values = links, values

    def key(self, names: set[str]) -> Hashable:
        return tuple(sorted((name, ("object", self.links[name]) if name in self.links
                             else self.values.get(name, _ABSENT)) for name in names))


class _Check:
    def __init__(self, store: Stores.Store):
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

    def object(self, label: str, schema: Schemas.OfObject.Data, value: Readers.OfObject) -> None:
        self._schema(repr(schema.name), schema)
        self.problems += self._properties(label, schema, value)
        for name, adjacency in schema.adjacencies.items():
            for i, entry in enumerate(getattr(value, name)):
                self.problems += self._entry(f"{label}.{name}[{i}]", adjacency, value, entry)

    def _properties(self, label: str, schema: Any, value: Any) -> list[str]:
        problems = []
        for prop in value.as_properties:
            name = prop.as_schema().name
            problems += self._value_problems(f"{label}.{name}", prop.as_schema().type,
                                             _property_value(prop, prop.as_schema().type))
        return problems

    def _value_problems(self, label: str, schema: Schemas.OfAny.Data, item: Any) -> list[str]:
        """Problems with a value: its type, recursively, and that an intersection value holds every part. An
        application's value is its applied schema's; one that applies itself, a problem its schema reports, has
        none."""
        schema = Schemas.structure(schema)
        if schema is None or item is None:
            return []
        if isinstance(schema, Schemas.OfScalar.Data):
            problem = _scalar_problem(schema, item)
            return [f"{label}: {problem}"] if problem else []
        if isinstance(schema, Schemas.OfObject.Data):
            problems = self._properties(label, schema, item)
            for name, adjacency in schema.adjacencies.items():
                for i, entry in enumerate(getattr(item, name)):
                    problems += self._entry(f"{label}.{name}[{i}]", adjacency, item, entry)
            return problems
        problems = []
        held = {name: _member(getattr(item, name), m.type) for name, m in schema.properties.items()}
        for name, member in schema.properties.items():
            problems += self._value_problems(f"{label}.{name}", member.type, held[name])
        missing = [name for name in schema.properties if held[name] is None]
        if isinstance(schema, Schemas.OfIntersection.Data) and missing:
            problems.append(f"{label}: parts {missing} are not set")
        return problems

    def _entry(self, label: str, adjacency: Schemas.OfAdjacency.Data, owner: Any, entry: Any) -> list[str]:
        """Problems with one entry: each linked object's schema declares an adjacency to the relation via its link, and
        its values have their types."""
        relation = adjacency.relation
        self._schema(f"of {label}", relation)
        problems = []
        for name in relation.entry.links:
            if name != adjacency.me:
                problem = _filling(relation, name, getattr(entry, name).as_schema())
                if problem:
                    problems.append(f"{label}.{name}: {problem}")
        for name, prop in relation.entry.properties.items():
            problems += self._value_problems(f"{label}.{name}", prop.type,
                                             _property_value(getattr(entry, name), prop.type))
        links = {name: _identity(getattr(entry, name)) for name in relation.entry.links if name != adjacency.me}
        links[adjacency.me] = _identity(owner)
        values = {name: _key(prop.type, _property_value(getattr(entry, name), prop.type))
                  for name, prop in relation.entry.properties.items()
                  if _property_value(getattr(entry, name), prop.type) is not None}
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

    def __init__(self, store: Stores.Store):
        self._store = store

    def __call__(self, schema: Schemas.OfAny.Data, value: Any) -> Outcome:
        if isinstance(schema, Schemas.OfScalar.Data):
            return self.OfScalar(schema, value)
        if isinstance(schema, Schemas.OfObject.Data):
            return self.OfObject(schema, value)
        raise NotImplementedError(f"{type(schema).__name__} cannot be validated yet")

    def OfScalar(self, schema: Schemas.OfScalar.Data, value: Scalar) -> Outcome:
        problem = _scalar_problem(schema, value)
        return Outcome(schema.validate() + ([problem] if problem else []), [])

    def OfObject(self, schema: Schemas.OfObject.Data, value: Readers.OfObject) -> Outcome:
        """Checks one object and its entries; uniqueness only over the entries it is part of."""
        return self._run(schema, [value])

    def Reachable(self, schema: Schemas.OfObject.Data, root: Readers.OfObject) -> Outcome:
        """Checks the root and every object reachable from it through adjacencies."""
        return self._run(schema, Reachable.of(root))

    def _run(self, schema: Schemas.OfObject.Data, values: list[Readers.OfObject]) -> Outcome:
        root = values[0]
        if root.as_schema() is not schema:
            return Outcome([f"the value is a {root.as_schema().name!r}, not an instance of the given schema"], [])
        check = _Check(self._store)
        for i, value in enumerate(values):
            check.object(f"{value.as_schema().name}#{i}", value.as_schema(), value)
        check.uniques()
        return Outcome(check.problems, check.unknowns)


class Validate:
    """Validates data against its schema: `Validate(store)(schema, value)` gives the problems `Check` finds, so what
    is unknown is not a problem."""

    def __init__(self, store: Stores.Store):
        self._check = Check(store)

    def __call__(self, schema: Schemas.OfAny.Data, value: Any) -> list[str]:
        return self._check(schema, value).problems

    def OfScalar(self, schema: Schemas.OfScalar.Data, value: Scalar) -> list[str]:
        return self._check.OfScalar(schema, value).problems

    def OfObject(self, schema: Schemas.OfObject.Data, value: Readers.OfObject) -> list[str]:
        """Checks one object and its entries; uniqueness only over the entries it is part of."""
        return self._check.OfObject(schema, value).problems

    def Reachable(self, schema: Schemas.OfObject.Data, root: Readers.OfObject) -> list[str]:
        """Checks the root and every object reachable from it through adjacencies."""
        return self._check.Reachable(schema, root).problems
