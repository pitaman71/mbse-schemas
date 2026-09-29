"""Validators: check data against its schema, only when the caller asks.

`Validate(registry)(schema, value)` returns a list of problems (empty when valid). It is constructed with a registry
that looks schemas up by name, e.g. `Proxies.Builders`. `Validate(registry).Reachable(schema, root)` checks the root
and every object reachable from it.

The validator is a visitor: each object writes itself into a recorder through `Visitable.accept`. Checks:

- the schemas involved pass `validate()`;
- each property value has exactly its schema's native type (distinct native types are never interchangeable);
- each entry sets every link, its property values have their native types, and each linked object's schema declares
  an adjacency to that relation via that link;
- `unique(S)` clauses hold over the entries seen: entries that agree on everything outside `S` agree on `S`.
  Uniqueness is checked only over the entries reachable from what was validated.
- an embedded object's properties are declared by its schema and hold values of their types, recursively;
- a union value is written as one of the union's branches and holds a value of that branch's type. Given an evaluator
  (`Validate(registry, evaluator)`: a callable taking a branch's predicate and a value, returning True, False or None
  for unknown), it is also the first branch whose predicate is True.
"""

from __future__ import annotations

from collections.abc import Callable, Hashable
from typing import Any, Protocol

from . import Reachable, Schemas, Visitors
from .Visitors import Native

__all__ = ["Registry", "Validate", "properties_of"]


class Registry(Protocol):
    """Looks schemas up by name, e.g. `Proxies.Builders`."""

    def schema(self, name: str) -> Schemas.OfObject.Data: ...

    def name_of(self, schema: Schemas.OfObject.Data) -> str: ...


# --- Recorders: Visitors that capture what an object writes into them ---


class _Value:
    """`Visitors.OfProperty` / `OfAny` / `OfNative` recording one value into a dict: a native, an embedded object (an
    `_ObjectRecord`) or a union value (a `_UnionRecord`)."""

    def __init__(self, values: dict[str, Any], name: str):
        self._values, self._name = values, name

    def name(self) -> str:
        return self._name

    def has(self) -> bool:
        return self._name in self._values

    def get(self) -> Native:
        return self._values[self._name]

    def set(self, value: Native) -> _Value:
        self._values[self._name] = value
        return self

    def clear(self) -> _Value:
        self._values.pop(self._name, None)
        return self

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _Value:
        callback(self)
        return self

    def as_native(self, callback: Callable[[Visitors.OfNative], Any]) -> _Value:
        callback(self)
        return self

    def as_object(self, callback: Callable[[Visitors.OfObject], Any]) -> _Value:
        record = self._values.get(self._name)
        if not isinstance(record, _ObjectRecord):
            record = self._values[self._name] = _ObjectRecord()
        callback(record)
        return self

    def as_union(self, callback: Callable[[Visitors.OfUnion], Any]) -> _Value:
        record = self._values.get(self._name)
        if not isinstance(record, _UnionRecord):
            record = self._values[self._name] = _UnionRecord()
        callback(record)
        return self

    def as_intersection(self, callback: Callable[[Visitors.OfIntersection], Any]) -> _Value:
        raise NotImplementedError("intersection-valued properties cannot be validated yet")


class _UnionRecord:
    """`Visitors.OfUnion` recording the branch a union value is written as, and the value."""

    def __init__(self) -> None:
        self.index: int | None = None
        self.values: dict[str, Any] = {}

    def branch(self) -> int:
        if self.index is None:
            raise ValueError("no branch is selected")
        return self.index

    def select(self, index: int) -> _UnionRecord:
        self.index = index
        return self

    def value(self, callback: Callable[[Visitors.OfAny], Any]) -> _UnionRecord:
        callback(_Value(self.values, "value"))
        return self


class _Link:
    def __init__(self, links: dict[str, Visitors.Visitable], name: str):
        self._links, self._name = links, name

    def name(self) -> str:
        return self._name

    def target(self, callback: Callable[[Visitors.Visitable], Any]) -> _Link:
        callback(self._links[self._name])
        return self

    def set(self, target: Visitors.Visitable) -> _Link:
        self._links[self._name] = target
        return self


class _EntryRecord:
    """`Visitors.OfEntry` recording one entry's links and property values."""

    def __init__(self) -> None:
        self.targets: dict[str, Visitors.Visitable] = {}
        self.values: dict[str, Any] = {}

    def links(self, callback: Callable[[Visitors.OfLink], Any]) -> _EntryRecord:
        for name in list(self.targets):
            callback(_Link(self.targets, name))
        return self

    def link(self, name: str, callback: Callable[[Visitors.OfLink], Any]) -> _EntryRecord:
        callback(_Link(self.targets, name))
        return self

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _EntryRecord:
        for name in list(self.values):
            callback(_Value(self.values, name))
        return self

    def has(self, name: str) -> bool:
        return name in self.values

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _EntryRecord:
        callback(_Value(self.values, name))
        return self

    def clear(self, name: str) -> _EntryRecord:
        self.values.pop(name, None)
        return self


class _AdjacencyRecord:
    def __init__(self, name: str, entries: list[_EntryRecord]):
        self._name, self._entries = name, entries

    def name(self) -> str:
        return self._name

    def me(self) -> str:
        raise NotImplementedError("the recorder is schema-agnostic")

    def entries(self, callback: Callable[[Visitors.OfEntry], Any]) -> _AdjacencyRecord:
        for entry in self._entries:
            callback(entry)
        return self

    def add(self, callback: Callable[[Visitors.OfEntry], Any]) -> _AdjacencyRecord:
        entry = _EntryRecord()
        callback(entry)
        self._entries.append(entry)
        return self

    def remove(self, entry: Visitors.OfEntry) -> _AdjacencyRecord:
        self._entries[:] = [e for e in self._entries if e is not entry]
        return self


class _ObjectRecord:
    """`Visitors.OfObject` recording an object's property values and adjacency entries."""

    def __init__(self) -> None:
        self.values: dict[str, Any] = {}
        self.adjacency_entries: dict[str, list[_EntryRecord]] = {}

    def properties(self, callback: Callable[[Visitors.OfProperty], Any]) -> _ObjectRecord:
        for name in list(self.values):
            callback(_Value(self.values, name))
        return self

    def has(self, name: str) -> bool:
        return name in self.values

    def property(self, name: str, callback: Callable[[Visitors.OfProperty], Any]) -> _ObjectRecord:
        callback(_Value(self.values, name))
        return self

    def clear(self, name: str) -> _ObjectRecord:
        self.values.pop(name, None)
        return self

    def adjacencies(self, callback: Callable[[Visitors.OfAdjacency], Any]) -> _ObjectRecord:
        for name in self.adjacency_entries:
            callback(_AdjacencyRecord(name, self.adjacency_entries[name]))
        return self

    def adjacency(self, name: str, callback: Callable[[Visitors.OfAdjacency], Any]) -> _ObjectRecord:
        callback(_AdjacencyRecord(name, self.adjacency_entries.setdefault(name, [])))
        return self

    def accept(self, visitor: Visitors.OfObject) -> None:
        """Writes the recorded property values back, so a recorded embedded object can be read like any object."""
        for name, value in self.values.items():
            visitor.property(name, lambda p, value=value: p.value(lambda a: _replay(a, value)))


def _replay(visitor: Visitors.OfAny, value: Any) -> None:
    if isinstance(value, _UnionRecord):
        visitor.as_union(lambda u: u.select(value.index).value(lambda v: _replay(v, value.values["value"])))
    elif isinstance(value, _ObjectRecord):
        visitor.as_object(lambda o: value.accept(o))
    else:
        visitor.as_native(lambda n: n.set(value))


# --- Checks ---


def _kind(value: Any) -> str:
    if isinstance(value, _ObjectRecord):
        return "an embedded object"
    if isinstance(value, _UnionRecord):
        return "a union value"
    return type(value).__name__


def _inner(value: Any) -> Any:
    """The value a recorded property holds, as an evaluator reads it: a union value's value, recursively."""
    return _inner(value.values.get("value")) if isinstance(value, _UnionRecord) else value


def _native_problem(schema: Schemas.OfAny.Data, value: Any) -> str | None:
    if not isinstance(schema, Schemas.OfNative.Data):
        return "entry properties must be native"
    if type(value) is not schema.type:
        return f"expected {schema.type.__name__}, got {_kind(value)}"
    return None


def _value_key(value: Any) -> Hashable:
    """Equality key per EQUALITY.md: distinct native types never compare equal; floats compare by bit pattern."""
    if isinstance(value, float):
        return ("float", value.hex())
    return (type(value).__name__, value)


_ABSENT = ("absent",)


class _Entry:
    """One relation entry with all its links, from whichever end it was seen."""

    def __init__(self, links: dict[str, Visitors.Visitable], values: dict[str, Any]):
        self.links, self.values = links, values

    def key(self, names: set[str]) -> Hashable:
        return tuple(
            sorted(
                (name, ("object", self.links[name].identity()) if name in self.links
                 else _value_key(self.values[name]) if name in self.values else _ABSENT)
                for name in names
            )
        )


class _Check:
    def __init__(self, registry: Registry, evaluator: Callable[[Any, Any], bool | None] | None):
        self._registry, self._evaluator = registry, evaluator
        self.problems: list[str] = []
        self._schemas_checked: set[int] = set()
        self._entries: dict[int, tuple[Schemas.OfRelation.Data, dict[Hashable, _Entry]]] = {}

    def _schema(self, label: str, schema: Any) -> None:
        if id(schema) in self._schemas_checked:
            return
        self._schemas_checked.add(id(schema))
        self.problems += [f"schema {label}: {problem}" for problem in schema.validate()]

    def object(self, label: str, schema: Schemas.OfObject.Data, value: Visitors.Visitable) -> None:
        self._schema(repr(value.schema_name()), schema)
        record = _ObjectRecord()
        value.accept(record)
        for name, item in record.values.items():
            if name not in schema.properties:
                self.problems.append(f"{label}.{name}: not a property of {value.schema_name()!r}")
                continue
            self.problems += self._value_problems(f"{label}.{name}", schema.properties[name], item)
        for name, entries in record.adjacency_entries.items():
            if name not in schema.adjacencies:
                self.problems.append(f"{label}.{name}: not an adjacency of {value.schema_name()!r}")
                continue
            adjacency = schema.adjacencies[name]
            for i, entry in enumerate(entries):
                self._entry(f"{label}.{name}[{i}]", adjacency, value, entry)

    def _value_problems(self, label: str, schema: Schemas.OfAny.Data, item: Any) -> list[str]:
        """Problems with a property's value: its kind and type, recursively, and a union value's branch."""
        if isinstance(schema, Schemas.OfNative.Data):
            return [] if type(item) is schema.type else [f"{label}: expected {schema.type.__name__}, got {_kind(item)}"]
        if isinstance(schema, Schemas.OfObject.Data):
            if not isinstance(item, _ObjectRecord):
                return [f"{label}: expected an embedded object, got {_kind(item)}"]
            problems = []
            for name, value in item.values.items():
                if name not in schema.properties:
                    problems.append(f"{label}.{name}: not a property of the embedded object")
                else:
                    problems += self._value_problems(f"{label}.{name}", schema.properties[name], value)
            return problems
        if isinstance(schema, Schemas.OfUnion.Data):
            if not isinstance(item, _UnionRecord):
                return [f"{label}: expected a union value, got {_kind(item)}"]
            if type(item.index) is not int or not 0 <= item.index < len(schema.branches):
                return [f"{label}: the union has no branch {item.index!r}"]
            problems = self._value_problems(label, schema.branches[item.index].type, item.values.get("value"))
            if problems or self._evaluator is None:
                return problems
            value = _inner(item)
            chosen = next((i for i, b in enumerate(schema.branches) if self._evaluator(b.when, value) is True), None)
            if chosen is None:
                return [f"{label}: no branch's predicate holds for the value"]
            if chosen != item.index:
                return [f"{label}: written as branch {item.index}, but the first branch whose predicate holds is {chosen}"]
            return []
        return [f"{label}: intersection values cannot be validated yet"]

    def _entry(
        self, label: str, adjacency: Schemas.OfAdjacency.Data, owner: Visitors.Visitable, entry: _EntryRecord
    ) -> None:
        relation = adjacency.relation
        self._schema(f"of {label}", relation)
        links = {adjacency.me: owner, **entry.targets}
        for name in relation.links:
            if name not in links:
                self.problems.append(f"{label}: link {name!r} is not set")
                continue
            target = links[name]
            target_schema = self._registry.schema(target.schema_name())
            if not any(a.relation is relation and a.me == name for a in target_schema.adjacencies.values()):
                self.problems.append(
                    f"{label}.{name}: a {target.schema_name()!r} cannot fill link {name!r}; its schema declares no "
                    f"adjacency to this relation via {name!r}"
                )
        for name, item in entry.values.items():
            if name not in relation.properties:
                self.problems.append(f"{label}.{name}: not a property of the relation")
                continue
            problem = _native_problem(relation.properties[name], item)
            if problem:
                self.problems.append(f"{label}.{name}: {problem}")
        full = _Entry(links, entry.values)
        _, seen = self._entries.setdefault(id(relation), (relation, {}))
        seen.setdefault(full.key(set(relation.links) | set(relation.properties)), full)

    def uniques(self) -> None:
        for relation, entries in self._entries.values():
            names = set(relation.links) | set(relation.properties)
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


def properties_of(value: Visitors.Visitable) -> dict[str, Any]:
    """The property values `value` writes when visited, by name; absent properties are left out. It reads through the
    visitor protocols, so it works for any `Visitable`. An embedded object is returned as an object whose `accept`
    writes its properties, and a union value as the value it holds."""
    record = _ObjectRecord()
    value.accept(record)
    return {name: _inner(item) for name, item in record.values.items()}



class Validate:
    """Validates data against its schema. `Validate(registry)(schema, value)` dispatches on the schema's kind. With an
    `evaluator`, union values are also checked against their branches' predicates."""

    def __init__(self, registry: Registry, evaluator: Callable[[Any, Any], bool | None] | None = None):
        self._registry, self._evaluator = registry, evaluator

    def __call__(self, schema: Schemas.OfAny.Data, value: Any) -> list[str]:
        if isinstance(schema, Schemas.OfNative.Data):
            return self.OfNative(schema, value)
        if isinstance(schema, Schemas.OfObject.Data):
            return self.OfObject(schema, value)
        raise NotImplementedError(f"{type(schema).__name__} cannot be validated yet")

    def OfNative(self, schema: Schemas.OfNative.Data, value: Native) -> list[str]:
        problems = schema.validate()
        problem = _native_problem(schema, value)
        return problems + ([problem] if problem else [])

    def OfObject(self, schema: Schemas.OfObject.Data, value: Visitors.Visitable) -> list[str]:
        """Checks one object and its entries; uniqueness only over the entries it is part of."""
        return self._run(schema, [value])

    def Reachable(self, schema: Schemas.OfObject.Data, root: Visitors.Visitable) -> list[str]:
        """Checks the root and every object reachable from it through adjacencies."""
        return self._run(schema, Reachable.of(root))

    def _run(self, schema: Schemas.OfObject.Data, values: list[Visitors.Visitable]) -> list[str]:
        root = values[0]
        if self._registry.schema(root.schema_name()) is not schema:
            return [f"the value is a {root.schema_name()!r}, not an instance of the given schema"]
        check = _Check(self._registry, self._evaluator)
        for i, value in enumerate(values):
            check.object(f"{value.schema_name()}#{i}", self._registry.schema(value.schema_name()), value)
        check.uniques()
        return check.problems
