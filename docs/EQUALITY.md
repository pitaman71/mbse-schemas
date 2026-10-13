<!-- nav -->
[← Schemas Framework design](FRAMEWORK.md) · [Home](../README.md) · [Equivalence of the implementations →](EQUIVALENCE.md)

# Equality

How two values compare under a schema: when they are equal, when one orders before the other, and how the `Comparison`
module implements it. This is part of the design in the [framework design](FRAMEWORK.md).

## Equality under a schema

Equality is defined by the schema, never by host-language `==`. It is used for keys, for `eq` / `ne` / `in` in expressions,
and anywhere else values are compared. Two values are compared under a schema:

- `OfScalar` : defined by `Schemas.OfScalar` as equality of the canonical wire form. Values of different scalar types are
  never equal (`1`, `1.0` and `true` are distinct).
- `OfObject` held as a property value (a value object) : every schema-declared property is either absent in both or
  present and equal in both, and so are its entries. Properties not declared by the schema (e.g. extra data held by a
  dynamic proxy) do not participate, and neither does its identity.
- Linked objects in a relation entry : compared by identity, not structure; a linked value object within the two
  objects compared, by its path from them.
- `OfUnion` : the same branch, by name, and equal under that branch's schema.
- `OfIntersection` : every part, by name, either absent in both or present and equal in both, under that part's schema.
- `OfContainer` : the same indices, each holding equal elements under the element schema, in any order. Containers
  whose index types or element types differ are never equal (decided in FRAMEWORK.md, Containers).
- An adjacency's entries, seen from one object (lists, dicts and maps among them): where its relation has a `unique`
  clause, the same entries in any order (a set); where it has none, the same number of entries, each equal to the
  entry at the same position (a list).
- `OfAny` : same runtime schema and equal under it.

Because linked objects compare by identity and only relations can form cycles, structural equality always terminates.

## Hashing

Every binding must provide a hash consistent with this equality, for enforcing keys. Hashes need not match across bindings.

## Ordering

Ordering (`lt`, `le`, `gt`, `ge`) is not universal: it is defined only for ordered `OfScalar` types. Lists, being an
adjacency's entries, are equal or incomparable.

## Comparison

The `Comparison` module implements this equality: for each element `OfX`, `Comparison.OfX(schema, value)` holds a value
read through the visitor protocol (`Readers.OfX`), or a scalar, e.g. `Comparison.OfObject(schema, instance)`. `a.compare(b)` returns -1, 0 or 1, or `None` when the two are incomparable. The ordered scalars are `int`,
`float`, `str` and `bytes`: floats by value with `-0.0` before `0.0`, NaNs equal to each other and incomparable with
other floats. Booleans, objects, entries, adjacencies and containers are equal or incomparable. Absent equals absent and is
incomparable with anything present. An adjacency compares its entries, seen from its object, as a set or, where its
relation has no `unique` clause, as a list, in order. Value objects compare by their properties and entries, links
among them by path; union values are equal when they hold the same branch with equal values, and otherwise
incomparable. Intersection values compare part by part, as value objects compare property by property. Containers
compare index by index, `Comparison.OfContainer(schema, container)`; two of different index or element types are
incomparable.

## Proposed resolutions (to confirm)

These edge cases are proposals; see Open questions in `FRAMEWORK.md`.

- Floats compare by canonical bit pattern: all NaNs are canonicalized and equal each other, and `-0.0` differs from `0.0`.
  This makes `eq` on floats differ from IEEE `==`.
- An `OfScalar` may give a width in bits or bytes, but not its interpretation (signedness, encoding): a scalar without
  a width is unbounded, as Python's `int` is, and whether a value fits a width is decided by the domain that interprets
  it (mbse-expressions' value domains), not by the schema. See Scalar types in `FRAMEWORK.md`.
- Strings compare by code point with no Unicode normalization.
- Object identity holds only within one loaded graph. Objects from two separately loaded graphs can be matched through
  their key in a singleton's directory; objects without one cannot be matched.

---

<!-- nav -->
[← Schemas Framework design](FRAMEWORK.md) · [Home](../README.md) · [Equivalence of the implementations →](EQUIVALENCE.md)
