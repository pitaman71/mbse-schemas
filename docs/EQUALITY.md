# Equality

How two values compare under a schema: when they are equal, when one orders before the other, and how the `Comparison`
module implements it. This is part of the design in [`FRAMEWORK.md`](FRAMEWORK.md).

## Equality under a schema

Equality is defined by the schema, never by host-language `==`. It is used for keys, for `eq` / `ne` / `in` in expressions,
and anywhere else values are compared. Two values are compared under a schema:

- `OfNative` : defined by `Schemas.OfNative` as equality of the canonical wire form. Values of different native types are
  never equal (`1`, `1.0` and `true` are distinct).
- `OfObject` held as a property value (a value object) : every schema-declared property is either absent in both or
  present and equal in both, and so are its entries. Properties not declared by the schema (e.g. extra data held by a
  dynamic proxy) do not participate, and neither does its identity.
- Linked objects in a relation entry : compared by identity, not structure; a linked value object within the two
  objects compared, by its path from them.
- `OfUnion` : the same branch, by name, and equal under that branch's schema.
- `OfIntersection` : every part, by name, either absent in both or present and equal in both, under that part's schema.
- `OfAny` : same runtime schema and equal under it.

Because linked objects compare by identity and only relations can form cycles, structural equality always terminates.

## Hashing

Every binding must provide a hash consistent with this equality, for enforcing keys. Hashes need not match across bindings.

## Ordering

Ordering (`lt`, `le`, `gt`, `ge`) is not universal: it is defined only for ordered `OfNative` types.

## Comparison

The `Comparison` module implements these rules: for each element `OfX`, `Comparison.OfX` implements `Visitors.OfX` and records the value
written into it, e.g. `Comparison.OfObject(schema, instance)`, which the instance fills through `accept`.
`a.compare(b)` returns -1, 0 or 1, or `None` when the two are incomparable. The ordered natives are `int`, `float`, `str`
and `bytes`: floats by value with `-0.0` before `0.0`, NaNs equal to each other and incomparable with other floats.
Booleans, objects, entries and adjacencies are equal or incomparable. Absent equals absent and is incomparable with
anything present. An adjacency compares its entries as a set, seen from its object. Embedded objects (value objects)
compare by their properties and entries, links among them by path; union values are equal when they hold the same branch with equal values, and otherwise incomparable.
Intersection values compare part by part, as embedded objects compare property by property.

## Proposed resolutions (to confirm)

These edge cases are proposals; see Open questions in `FRAMEWORK.md`.

- Floats compare by canonical bit pattern: all NaNs are canonicalized and equal each other, and `-0.0` differs from `0.0`.
  This makes `eq` on floats differ from IEEE `==`.
- An `OfNative` may give a width in bits or bytes, but not its interpretation (signedness, encoding): a native without
  a width is unbounded, as Python's `int` is, and whether a value fits a width is decided by the domain that interprets
  it (mbse-expressions' value domains), not by the schema. See Meta-schemas in `FRAMEWORK.md`.
- Strings compare by code point with no Unicode normalization.
- Object identity holds only within one loaded graph. Objects from two separately loaded graphs can be matched through
  their key in a singleton's directory; objects without one cannot be matched.
