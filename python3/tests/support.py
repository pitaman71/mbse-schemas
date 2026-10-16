"""Shared helpers for the test notebooks. Each notebook runs in its own kernel and makes its own stores."""

from __future__ import annotations

import inspect
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from mbse.Schemas.Framework import Builders


@contextmanager
def raises(*errors: type[BaseException], match: str | None = None) -> Iterator[None]:
    """Asserts that the block raises one of `errors`, optionally with `match` in the message."""
    try:
        yield
    except errors as error:
        if match is not None and match not in str(error):
            raise AssertionError(f"expected {match!r} in {str(error)!r}") from error
        return
    raise AssertionError(f"expected one of {[e.__name__ for e in errors]}")


BASIC = {str: "OfStr", int: "OfInt", float: "OfFloat", bool: "OfBool", bytes: "OfBytes"}


def basic(store: Any, scalar: type) -> Any:
    """The basic scalar schema of a host type in `store`, which holds its own."""
    return getattr(store.Schemas, BASIC[scalar]).as_schema()


def entries(schema: Any, obj: Any, adjacency: str) -> list[dict[str, Any]]:
    """An object's entries, read through the visitor protocol: each a dict of the other links' objects and the values
    of the properties that are set (a value object as its visitor)."""
    read = getattr(obj, adjacency)
    me = read.as_schema().me
    rows = []
    for entry in read:
        row = {link: getattr(entry, link) for link in entry.as_schema().links if link != me}
        for name, prop in entry.as_schema().properties.items():
            value = value_of(getattr(entry, name))
            if value is not None:
                row[name] = value
        rows.append(row)
    return rows


def value_of(read: Any) -> Any:
    """A property's value, read through its visitor: its scalar, or the value object, union value or intersection value
    it holds, as that value's visitor; None when absent."""
    if read.get() is not None:
        return read.get()
    found: list[Any] = []
    read.as_value(lambda a: a.as_object(lambda v: found.append(v) or v).as_union(lambda v: found.append(v) or v)
                  .as_intersection(lambda v: found.append(v) or v))
    return next((v for v in found if v.as_schema() is not None), None)  # a visitor of nothing has no schema


def root_of(snapshot: dict) -> dict:
    """A snapshot's root object."""
    return snapshot["objects"][snapshot["root"]]


def is_adjacency(value: Any) -> bool:
    """Whether a snapshot's list is an adjacency: each of its entries links something, while a list a property holds
    never has a reference at its top level."""
    return isinstance(value, list) and bool(value) and all(
        isinstance(e, dict) and any(isinstance(v, dict) and "$ref" in v for v in e.values()) for e in value)


def same_graph(a: dict, b: dict) -> bool:
    """Snapshot equality up to the keys objects are written under, the order they are written in, and entry order.
    Objects are identified by their own property values, which must be distinct within each graph, and value objects by
    their owner's and the path to them."""

    def content(value: Any) -> Any:
        """A value without the keys and entries in it."""
        if isinstance(value, dict):
            return sorted((k, content(v)) for k, v in value.items() if k != "$id" and not is_adjacency(v))
        if isinstance(value, list):
            return [content(v) for v in value]
        return value

    def canonical(graph: dict) -> tuple:
        objects = graph["objects"]
        labels = {s: repr(content(o)) for s, o in objects.items()}
        assert len(set(labels.values())) == len(labels), "objects must have distinct property values"
        holders: list[tuple[str, dict]] = []  # every object and value object, by label

        def visit(label: str, value: Any) -> None:
            if isinstance(value, list):
                for i, item in enumerate(value):
                    visit(f"{label}[{i}]", item)
            elif isinstance(value, dict):
                holders.append((label, value))
                if "$id" in value:
                    labels[value["$id"]] = label
                for key, item in value.items():
                    if key != "$schema" and not is_adjacency(item):
                        visit(f"{label}.{key}", item)

        for symbol, obj in objects.items():
            visit(labels[symbol], obj)

        def entry(e: dict) -> str:
            return repr(sorted((k, labels[v["$ref"]] if isinstance(v, dict) and "$ref" in v else v) for k, v in e.items()))

        return labels[graph["root"]], {
            label: {k: sorted(map(entry, v)) for k, v in mapping.items() if is_adjacency(v)} for label, mapping in holders
        }

    return canonical(a) == canonical(b)


def protocol_methods(protocol: type) -> dict[str, inspect.Signature]:
    """Public methods declared by a `typing.Protocol`, with their signatures."""
    return {
        name: inspect.signature(member)
        for name, member in vars(protocol).items()
        if callable(member) and not name.startswith("_")
    }


def conformance_problems(implementation: type, protocol: type) -> list[str]:
    """Methods of `protocol` that `implementation` lacks, or declares with a different number of parameters."""
    problems = []
    for name, expected in protocol_methods(protocol).items():
        member = getattr(implementation, name, None)
        if not callable(member):
            problems.append(f"{implementation.__name__} lacks {protocol.__name__}.{name}")
            continue
        actual = inspect.signature(member)
        if len(actual.parameters) != len(expected.parameters):
            problems.append(
                f"{implementation.__name__}.{name}{actual} does not match {protocol.__name__}.{name}{expected}"
            )
    return problems


def instance_problems(instance: Any, protocol: type) -> list[str]:
    """The conformance check on a live instance: catches instance attributes that shadow protocol methods."""
    return [
        f"{type(instance).__name__} instance: {protocol.__name__}.{name} is not callable"
        for name in protocol_methods(protocol)
        if not callable(getattr(instance, name, None))
    ]
