"""Comparison: compares values under their schema, as EQUALITY.md defines.

For each schema element `OfX`, `Comparison.OfX(schema, value)` holds a value read through the visitor protocol
(`Readers.OfX`), or a scalar. `a.compare(b)` compares two and returns -1, 0 or 1 when `a` is less than, equal to or
greater than `b`, and `None` when they are incomparable.

- Absent compares equal to absent; absent and present are incomparable. So do values under different schemas.
- `OfScalar`: a value must have exactly the schema's scalar type. `int`, `float`, `str` and `bytes` are ordered:
  strings by code point, bytes lexicographically, floats by value with `-0.0` before `0.0`. NaNs equal each other
  and are incomparable with other floats. Booleans are equal or incomparable.
- `OfObject`: equal when every property its schema declares is absent in both or equal in both; otherwise
  incomparable. A value object compares deeply: its adjacencies participate too, and so do those of the value objects
  it holds; a reference object's own adjacencies do not.
- `OfProperty` and `OfAny` compare their values; values of different kinds are incomparable.
- `OfUnion`: equal when both hold the same branch with equal values; otherwise incomparable.
- `OfIntersection`: equal when every part is absent in both or equal in both; otherwise incomparable.
- `OfContainer`: equal when both hold elements at the same indices, each equal; otherwise incomparable. Containers
  with different index types, or different element types, are incomparable.
- `OfLink`: equal when both link the same object, by identity: a link targets a reference object; otherwise
  incomparable.
- `OfEntry`: equal when every link and property is equal; otherwise incomparable.
- `OfAdjacency`: seen from one object (whose own link is implied), the entries of a relation with a `unique` clause
  form a set, and two adjacencies are equal when both hold equal entries; an open relation's are a list, and two are
  equal when their entries are, in order. Otherwise incomparable.
"""

from __future__ import annotations

import math
from typing import Any

from . import Readers, Schemas
from .Visitors import Scalar

__all__ = [
    "Result", "OfAny", "OfScalar", "OfProperty", "OfObject", "OfUnion", "OfIntersection", "OfContainer",
    "OfAdjacency", "OfEntry", "OfLink",
]

Result = int | None
"""-1, 0 or 1 when ordered or equal; None when incomparable."""


def _sign(a: Any, b: Any) -> int:
    return (a > b) - (a < b)


def _all_equal(results: list[Result]) -> Result:
    """Unordered composites: equal when every part is equal, otherwise incomparable."""
    return 0 if all(result == 0 for result in results) else None


def _scalars(a: Scalar, b: Scalar) -> Result:
    """Compares two values of the same scalar type."""
    if isinstance(a, bool):
        return 0 if a == b else None
    if isinstance(a, float):
        assert isinstance(b, float)
        if math.isnan(a) or math.isnan(b):
            return 0 if math.isnan(a) and math.isnan(b) else None
        return _sign((a, math.copysign(1.0, a)), (b, math.copysign(1.0, b)))
    return _sign(a, b)


# --- Reading values through their visitors ---


def _read_scalar(read: Any) -> Any:
    """The scalar a property's visitor holds, or None."""
    found: list[Any] = []
    read.as_scalar(lambda s: found.append(s.get()) or s)
    return found[0] if found else None


_SELECT = {Schemas.OfObject.Data: "as_object", Schemas.OfUnion.Data: "as_union",
           Schemas.OfIntersection.Data: "as_intersection", Schemas.OfContainer.Data: "as_container"}


def _any_of(read: Any) -> Any:
    """The value of any type a `Visitors.OfAny` holds: a scalar, a visitor of its own kind, or None."""
    found: list[Any] = []
    read.as_scalar(lambda s: found.extend([] if s.get() is None else [s.get()]) or s)
    for select in ("as_object", "as_union", "as_intersection", "as_container"):
        getattr(read, select)(lambda v: found.extend([v] if v.as_schema() is not None else []) or v)
    return found[0] if found else None


def _own(value: Any) -> Any:
    """The type a value of any type has: a scalar's, or its visitor's schema."""
    return Schemas.OfScalar.Data(type(value)) if type(value) in Schemas.SCALAR_TYPES else value.as_schema()


def _read_held(read: Any, schema: Any) -> Any:
    """The value object, union value or intersection value a property's visitor holds, as its own visitor; None when
    absent. An empty visitor has no identity."""
    found: list[Any] = []
    if isinstance(schema, Schemas.OfAny.Value):
        read.as_value(lambda a: found.append(_any_of(a)) or a)
        return found[0]
    read.as_value(lambda a: getattr(a, _SELECT[type(schema)])(lambda v: found.append(v) or v) or a)
    return found[0] if found and found[0].as_schema() is not None else None  # a visitor of nothing has no schema


def _read_property(read: Any, schema: Any) -> Any:
    """A property's value, read through its visitor: a scalar, a visitor, or None."""
    held = Schemas.structure(schema)
    return _read_scalar(read) if isinstance(held, Schemas.OfScalar.Data) or held is None else _read_held(read, held)


def _read_member(read: Any, schema: Any) -> Any:
    """A union's branch's or an intersection's part's value, read through its visitor of its type's kind."""
    if isinstance(Schemas.structure(schema), Schemas.OfScalar.Data):
        return read.get()
    return read if read.as_schema() is not None else None


def _read_element(read: Any, schema: Any) -> Any:
    """A container's element, read through its `Visitors.OfAny`: a scalar or a visitor; an element present holds one."""
    held = Schemas.structure(schema)
    found: list[Any] = []
    if isinstance(held, Schemas.OfScalar.Data) or held is None:
        read.as_scalar(lambda s: found.append(s.get()) or s)
    elif isinstance(held, Schemas.OfAny.Value):
        return _any_of(read)
    else:
        getattr(read, _SELECT[type(held)])(lambda v: found.append(v) or v)
    return found[0]


# --- Comparing ---


def _same_type(a: Any, b: Any) -> bool:
    """Whether two types are one: scalars by value, other schemas by identity, through applications."""
    a, b = Schemas.structure(a), Schemas.structure(b)
    return a == b if isinstance(a, Schemas.OfScalar.Data) else a is b


def _compare(schema: Any, a: Any, b: Any) -> Result:
    """Compares two values of `schema`, each a scalar, a visitor, or None for absent."""
    if a is None or b is None:
        return 0 if a is None and b is None else None
    held = Schemas.structure(schema)
    if isinstance(held, Schemas.OfScalar.Data):
        if type(a) is not type(b):
            return None
        return _scalars(a, b)
    if isinstance(held, Schemas.OfObject.Data):
        return _objects(held, a, b, deep=True)
    if isinstance(held, Schemas.OfContainer.Data):
        return _containers(held, a, b)
    if isinstance(held, Schemas.OfAny.Value):  # values of any type: comparable under one type only
        return _compare(_own(a), a, b) if _same_type(_own(a), _own(b)) else None
    return _all_equal([_compare(m.type, _read_member(getattr(a, name), m.type), _read_member(getattr(b, name), m.type))
                       for name, m in held.properties.items()])


def _same_index(schema: Any, a: Any, b: Any) -> bool:
    """Whether two indices of one index type are one: scalars, or tuples of them, equal; value objects equal."""
    if isinstance(a, tuple):
        return all(_scalars(x, y) == 0 for x, y in zip(a, b))
    if isinstance(Schemas.structure(schema), Schemas.OfScalar.Data):
        return _scalars(a, b) == 0
    return _compare(schema, a, b) == 0


def _containers(schema: Schemas.OfContainer.Data, a: Any, b: Any) -> Result:
    """Two containers of `schema`: equal when they hold elements at the same indices, each equal."""
    pairs: list[list[tuple[Any, Any]]] = [[], []]
    a.as_entries(lambda it: pairs[0].extend(it))
    b.as_entries(lambda it: pairs[1].extend(it))
    if len(pairs[0]) != len(pairs[1]):
        return None
    results: list[Result] = []
    for index, element in pairs[0]:
        other = [e for i, e in pairs[1] if _same_index(schema.index, index, i)]
        results.append(None if not other else _compare(schema.element, _read_element(element, schema.element),
                                                       _read_element(other[0], schema.element)))
    return _all_equal(results)


def _objects(schema: Schemas.OfObject.Data, a: Any, b: Any, deep: bool) -> Result:
    """Two objects of `schema`: their properties, and with `deep`, their entries."""
    results = [_compare(prop.type, _read_property(getattr(a, name), prop.type),
                        _read_property(getattr(b, name), prop.type)) for name, prop in schema.properties.items()]
    if deep:
        results += [_adjacencies(adjacency, list(getattr(a, name)), list(getattr(b, name)))
                    for name, adjacency in schema.adjacencies.items()]
    return _all_equal(results)


def _adjacencies(adjacency: Schemas.OfAdjacency.Data, a: list[Any], b: list[Any]) -> Result:
    if len(a) != len(b):
        return None
    if adjacency.relation.open:
        return _all_equal([_entries(adjacency, e, o) for e, o in zip(a, b)])
    return _all_equal([0 if any(_entries(adjacency, e, o) == 0 for o in b) else None for e in a])


def _entries(adjacency: Schemas.OfAdjacency.Data, a: Any, b: Any) -> Result:
    relation = adjacency.relation
    links = [_links(getattr(a, name), getattr(b, name)) for name in relation.entry.links if name != adjacency.me]
    values = [_compare(prop.type, _read_property(getattr(a, name), prop.type), _read_property(getattr(b, name), prop.type))
              for name, prop in relation.entry.properties.items()]
    return _all_equal(links + values)


def _links(a: Any, b: Any) -> Result:
    """Links compare by their targets' identities: a link targets a reference object, never a value object."""
    a_id = None if a is None or a.as_identity() is None else (id(a.as_schema()), a.as_identity())
    b_id = None if b is None or b.as_identity() is None else (id(b.as_schema()), b.as_identity())
    if not a_id or not b_id:
        return 0 if not a_id and not b_id else None
    return 0 if a_id == b_id else None


class OfScalar:
    """A scalar value, which must have exactly the schema's scalar type; None for absent."""

    def __init__(self, schema: Schemas.OfScalar.Data, value: Scalar | None = None):
        if value is not None and type(value) is not schema.host():
            raise TypeError(f"expected {schema.host().__name__}, got {type(value).__name__}")
        self._schema, self._value = schema, value

    def compare(self, other: OfScalar) -> Result:
        if self._value is None or other._value is None:
            return 0 if self._value is None and other._value is None else None
        if self._schema.type is not other._schema.type:
            return None
        return _scalars(self._value, other._value)


class OfAny:
    """A value of any kind: a scalar, a value's visitor, or None for absent."""

    def __init__(self, schema: Schemas.OfAny.Data, value: Any = None):
        self._schema, self._value = schema, value

    def compare(self, other: OfAny) -> Result:
        if not _same_type(self._schema, other._schema):
            return None
        return _compare(self._schema, self._value, other._value)


class OfProperty:
    """One property's value, read through its visitor (`Readers.OfProperty`); None for absent."""

    def __init__(self, read: Readers.OfProperty | None = None):
        self._read = read

    def compare(self, other: OfProperty) -> Result:
        if self._read is None or other._read is None:
            return 0 if self._read is None and other._read is None else None
        schema = self._read.as_schema().type
        if not _same_type(schema, other._read.as_schema().type):
            return None
        return _compare(schema, _read_property(self._read, schema), _read_property(other._read, schema))


class OfObject:
    """An object read through its visitor (`Readers.OfObject`). A value object (`value`) compares its adjacencies
    too; a reference object's own adjacencies do not. Without an instance, an object with nothing set."""

    def __init__(self, schema: Schemas.OfObject.Data, instance: Readers.OfObject | None = None, *, value: bool = False):
        self._schema, self._instance, self._value = schema, instance, value

    def compare(self, other: OfObject) -> Result:
        if self._schema is not other._schema:
            return None
        if self._instance is None or other._instance is None:
            return 0 if self._instance is None and other._instance is None else None
        return _objects(self._schema, self._instance, other._instance, deep=self._value)


class OfUnion:
    """A union value read through its visitor; None for absent."""

    def __init__(self, schema: Schemas.OfUnion.Data, value: Readers.OfUnion | None = None):
        self._schema, self._value = schema, value

    def compare(self, other: OfUnion) -> Result:
        if self._schema is not other._schema:
            return None
        return _compare(self._schema, self._value, other._value)


class OfIntersection(OfUnion):
    """An intersection value read through its visitor; None for absent."""


class OfContainer:
    """A container read through its visitor (`Readers.OfContainer`); None for absent. Containers of different index
    types, or of different element types, are incomparable."""

    def __init__(self, schema: Schemas.OfContainer.Data, value: Readers.OfContainer | None = None):
        self._schema, self._value = schema, value

    def compare(self, other: OfContainer) -> Result:
        if not (_same_type(self._schema.index, other._schema.index) and _same_type(self._schema.element, other._schema.element)):
            return None
        return _compare(self._schema, self._value, other._value)


class OfAdjacency:
    """An adjacency's entries, read through its visitor (`Readers.OfAdjacency`)."""

    def __init__(self, read: Readers.OfAdjacency):
        self._read = read

    def compare(self, other: OfAdjacency) -> Result:
        mine, theirs = self._read.as_schema(), other._read.as_schema()
        if mine.relation is not theirs.relation or mine.me != theirs.me:
            return None
        return _adjacencies(mine, list(self._read), list(other._read))


class OfEntry:
    """One entry of an adjacency, read through its visitor (`Readers.OfEntry`), seen from the adjacency's end."""

    def __init__(self, adjacency: Schemas.OfAdjacency.Data, read: Readers.OfEntry):
        self._adjacency, self._read = adjacency, read

    def compare(self, other: OfEntry) -> Result:
        if self._adjacency.relation is not other._adjacency.relation or self._adjacency.me != other._adjacency.me:
            return None
        return _entries(self._adjacency, self._read, other._read)


class OfLink:
    """The object a link targets, read through its visitor; None when not set."""

    def __init__(self, target: Readers.OfObject | None = None):
        self._target = target

    def compare(self, other: OfLink) -> Result:
        return _links(self._target, other._target)
