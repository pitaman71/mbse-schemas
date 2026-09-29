"""Shared helpers for the test notebooks. Each notebook runs in its own kernel, so registries start empty."""

from __future__ import annotations

import inspect
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from schemas.Framework import Plain, Reachable


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


def text(name: str, native: type = str):
    """Property Spec for a native-typed property."""
    return lambda prop: prop.name(name).of(lambda t: t.as_native(native))


def set_property(visitor: Any, name: str, value: Any) -> None:
    """Writes a native property through the visitor protocols (works for property names the DSL cannot reach)."""
    visitor.property(name, lambda p: p.value(lambda a: a.as_native(lambda n: n.set(value))))


def get_property(visitor: Any, name: str) -> Any:
    """Reads a native property through the visitor protocols."""
    found: list[Any] = []
    visitor.property(name, lambda p: p.value(lambda a: a.as_native(lambda n: found.append(n.get()))))
    return found[0]


def entries(schema: Any, obj: Any, adjacency: str) -> list[dict[str, Any]]:
    """An object's entries with references resolved to objects, read from a Reachable snapshot (symbols follow
    `Reachable.of` order)."""
    graph = Plain.ToPlain.Reachable(schema, obj)
    objects = Reachable.of(obj)

    def resolve(value: Any) -> Any:
        return objects[int(value["$ref"][1:])] if isinstance(value, dict) else value

    return [{k: resolve(v) for k, v in e.items()} for e in graph["objects"][graph["root"]].get(adjacency, [])]


def same_graph(a: dict, b: dict) -> bool:
    """Snapshot equality up to symbol numbering and entry order. Objects are identified by their own property values,
    which must be distinct within each graph."""

    def canonical(graph: dict) -> tuple:
        objects = graph["objects"]
        labels = {s: repr(sorted((k, v) for k, v in o.items() if not isinstance(v, list))) for s, o in objects.items()}
        assert len(set(labels.values())) == len(labels), "objects must have distinct property values"

        def entry(e: dict) -> str:
            return repr(sorted((k, labels[v["$ref"]] if isinstance(v, dict) else v) for k, v in e.items()))

        return labels[graph["root"]], {
            labels[s]: {k: sorted(map(entry, v)) for k, v in o.items() if isinstance(v, list)}
            for s, o in objects.items()
        }

    return canonical(a) == canonical(b)


class Fake:
    """A minimal hand-written `Visitors.Visitable`, independent of Proxies.

    `values` maps property names to native values. `adjacencies` maps adjacency names to lists of entries; an entry
    maps link names to `Fake` objects and property names to native values. Nothing is checked against a schema, so
    fakes can express data that proxies would never produce.
    """

    def __init__(self, schema_name: str, values: dict | None = None, adjacencies: dict | None = None,
                 identity: Any = None):
        self._schema_name = schema_name
        self.values = dict(values or {})
        self.adjacencies = {k: list(v) for k, v in (adjacencies or {}).items()}
        self._identity = identity

    def identity(self) -> Any:
        return id(self) if self._identity is None else self._identity

    def schema_name(self) -> str:
        return self._schema_name

    def accept(self, visitor: Any) -> None:
        for name, value in self.values.items():
            set_property(visitor, name, value)
        for name, items in self.adjacencies.items():
            for item in items:
                visitor.adjacency(name, lambda a, item=item: a.add(lambda e: _write(e, item)))


def _write(entry: Any, item: dict) -> None:
    for key, value in item.items():
        if isinstance(value, Fake):
            entry.link(key, lambda k, value=value: k.set(value))
        else:
            set_property(entry, key, value)


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
