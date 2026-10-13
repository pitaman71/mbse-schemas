"""Specs: what a visitor's members and `as_*` methods take.

A `Specs.Callback[V]`, for a visitor protocol `V` (`Visitors.OfX`), is either a value, `Visitors.DataType[V]`, or a
callable taking a `V` and returning it. It serves as a mutator, where it is written (`b.name("Ada")`,
`b.name.as_scalar(lambda s: s.set("Ada"))`), or as a limited value-matching query, where it selects
(`adjacency.select(spec, cb)`, `adjacency.remove(spec)`): a value matches what is equal to it, and a callable is a
template that matches what agrees with everything it sets.

`Visitors.DataType[V]`, the value form, is by kind:

- `Visitors.OfScalar[T]`: a `T`;
- `Visitors.OfAny` and `Visitors.OfProperty`: the value, a scalar or a value object, union value or intersection value
  (copied);
- `Visitors.OfObject`: a reference object (linked), or a value object (copied);
- `Visitors.OfEntry`: an entry (copied, or matched);
- `Visitors.OfAdjacency`: an iterable of entries, each inserted ("with implied 'insert' semantics (not replace)").

Python's type system cannot map a protocol to its value form, so here the value form types as `object`.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar, Union

__all__ = ["Callback"]

V = TypeVar("V")

Callback = Union[object, Callable[[V], V]]
"""`Visitors.DataType[V] | Callable[[V], V]`: a value, or a callable taking the visitor and returning it."""
