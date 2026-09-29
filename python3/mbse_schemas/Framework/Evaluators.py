"""Evaluators: compute the value of an expression.

`Evaluators.OfAny(expression, scope)` evaluates any expression with the variables in `scope` bound, and
`Evaluators.OfLiteral`, `OfOperation`, `OfVariable` and `OfLet` evaluate one kind; each accepts that kind's `Spec`
(see `Expressions`), including `Term`s. The value is a native value, an object, or `None` when it is unknown.

- Three-valued logic: an absent property is unknown, and comparisons with unknown or incomparable values are unknown.
  `and`, `or`, `not` and `implies` follow Kleene's logic; the second operand is evaluated only when the first does not
  decide.
- No coercion. Comparisons follow EQUALITY.md: natives of one type by value, objects by identity; values of different
  types are incomparable. Arithmetic takes numbers of one type.
- Only core operations (`Expressions.CORE`) are evaluated. Unknown operations, wrong numbers of arguments, unbound
  variables and wrong operand types raise, as do the problems `validate()` reports.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from . import Comparison, Expressions, Schemas, Validators
from .Visitors import Native

__all__ = ["OfAny", "OfLiteral", "OfOperation", "OfVariable", "OfLet"]

Scope = Mapping[str, Any] | None

_Literal = Expressions.OfLiteral.Data
_Operation = Expressions.OfOperation.Data
_Variable = Expressions.OfVariable.Data
_Let = Expressions.OfLet.Data
_NATIVES = (int, float, str, bool, bytes)


def OfAny(expression: Expressions.OfAny.Spec, scope: Scope = None) -> Any:
    """The value of any expression, with the variables in `scope` bound."""
    return _evaluate(Expressions.OfAny.resolve(expression), dict(scope or {}), set())


def OfLiteral(expression: Expressions.OfLiteral.Spec, scope: Scope = None) -> Any:
    """The value of a literal."""
    return _evaluate(Expressions.OfLiteral.resolve(expression), dict(scope or {}), set())


def OfOperation(expression: Expressions.OfOperation.Spec, scope: Scope = None) -> Any:
    """The value of an operation, with the variables in `scope` bound."""
    return _evaluate(Expressions.OfOperation.resolve(expression), dict(scope or {}), set())


def OfVariable(expression: Expressions.OfVariable.Spec, scope: Scope = None) -> Any:
    """The value `scope` binds to a variable."""
    return _evaluate(Expressions.OfVariable.resolve(expression), dict(scope or {}), set())


def OfLet(expression: Expressions.OfLet.Spec, scope: Scope = None) -> Any:
    """The value of a let's body, with its name bound to its value and the variables in `scope` bound."""
    return _evaluate(Expressions.OfLet.resolve(expression), dict(scope or {}), set())


def _type_name(value: object) -> str:
    return type(value).__name__


def _is_native(value: object) -> bool:
    return type(value) in _NATIVES


def _evaluate(expression: Any, scope: dict[str, Any], active: set[int]) -> Any:
    if isinstance(expression, _Literal):
        if expression.value is None:
            raise ValueError("a literal needs a value")
        return expression.value
    if isinstance(expression, _Variable):
        if expression.name not in scope:
            raise KeyError(f"variable {expression.name!r} is not bound")
        return scope[expression.name]
    if not isinstance(expression, (_Let, _Operation)):
        raise TypeError(f"not an expression: {expression!r}")
    if id(expression) in active:
        raise ValueError("the expression contains a cycle")
    active.add(id(expression))
    try:
        if isinstance(expression, _Let):
            if expression.value is None or expression.body is None:
                raise ValueError(f"a let needs a {'value' if expression.value is None else 'body'}")
            bound = _evaluate(expression.value, scope, active)
            return _evaluate(expression.body, {**scope, expression.name: bound}, active)
        return _operate(expression, scope, active)
    finally:
        active.discard(id(expression))


def _operate(expression: _Operation, scope: dict[str, Any], active: set[int]) -> Any:
    name, arguments = expression.name, expression.arguments
    if name not in Expressions.CORE:
        raise NotImplementedError(f"{name!r} is not a core operation")
    if len(arguments) != Expressions.CORE[name]:
        raise TypeError(f"{name} takes {Expressions.CORE[name]} arguments, got {len(arguments)}")

    def value(i: int) -> Any:
        return _evaluate(arguments[i], scope, active)

    if name in ("and", "or", "implies"):
        return _logic(name, lambda: _truth(name, value(0)), lambda: _truth(name, value(1)))
    values = [value(i) for i in range(len(arguments))]
    if name == "not":
        truth = _truth(name, values[0])
        return None if truth is None else not truth
    if name in ("get", "has"):
        return _read(name, *values)
    if name in ("eq", "ne"):
        equal = _equal(*values)
        return None if equal is None else equal == (name == "eq")
    if name in ("lt", "le", "gt", "ge"):
        order = _order(*values)
        return None if order is None else {"lt": order < 0, "le": order <= 0, "gt": order > 0, "ge": order >= 0}[name]
    return _arithmetic(name, values)


def _truth(name: str, value: Any) -> bool | None:
    if value is not None and type(value) is not bool:
        raise TypeError(f"{name} expects bool operands, got {_type_name(value)}")
    return value


def _logic(name: str, first: Callable[[], bool | None], second: Callable[[], bool | None]) -> bool | None:
    """Kleene's logic, evaluating the second operand only when the first does not decide."""
    a = first()
    decisive = {"and": False, "or": True, "implies": False}[name]
    if a is decisive:
        return name != "and"
    b = second()
    if name == "implies":
        return True if b is True else None if a is None or b is None else False
    if b is (name == "or"):
        return b
    return None if a is None or b is None else name == "and"


def _is_object(value: Any) -> bool:
    return callable(getattr(value, "accept", None)) and callable(getattr(value, "identity", None))


def _read(name: str, target: Any, property_name: Any) -> Any:
    """`get`: the property's value, or `None` when absent. `has`: whether it is present."""
    if type(property_name) is not str:
        raise TypeError(f"{name} expects a property name, got {_type_name(property_name)}")
    if target is None:
        return None
    if not _is_object(target):
        raise TypeError(f"{name} expects an object, got {_type_name(target)}")
    record = Validators._ObjectRecord()
    target.accept(record)
    if name == "has":
        return property_name in record.values
    return record.values.get(property_name)


def _compare(a: Native, b: Native) -> Comparison.Result:
    schema = Schemas.OfNative.Data(type(a))
    return Comparison.OfNative(schema, a).compare(Comparison.OfNative(schema, b))


def _equal(a: Any, b: Any) -> bool | None:
    """Whether `a` equals `b`: natives of one type by value, objects by identity; `None` if unknown or incomparable."""
    if a is None or b is None:
        return None
    if _is_native(a) and type(a) is type(b):
        return _compare(a, b) == 0
    if _is_object(a) and _is_object(b):
        return a.identity() == b.identity()
    return None


def _order(a: Any, b: Any) -> Comparison.Result:
    """-1, 0 or 1 for ordered natives of one type; `None` if unknown or incomparable."""
    if a is None or b is None or not _is_native(a) or type(a) is not type(b):
        return None
    return _compare(a, b)


def _arithmetic(name: str, values: list[Any]) -> Any:
    if any(value is None for value in values):
        return None
    if name == "neg":
        if type(values[0]) not in (int, float):
            raise TypeError(f"neg expects a number, got {_type_name(values[0])}")
        return -values[0]
    a, b = values
    if type(a) is not type(b) or type(a) not in (int, float):
        raise TypeError(f"{name} expects numbers of one type, got {_type_name(a)} and {_type_name(b)}")
    return a + b if name == "add" else a - b if name == "sub" else a * b
