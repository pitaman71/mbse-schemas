/**
 * Specs: what a visitor's members and `as_*` methods take.
 *
 * A `Specs.Callback<V>`, for a visitor protocol `V` (`Visitors.OfX`), is either a value, `Visitors.DataType<V>`, or a
 * function taking a `V` and returning it. It serves as a mutator, where it is written (`b.name("Ada")`,
 * `b.name.as_scalar((s) => s.set("Ada"))`), or as a limited value-matching query, where it selects
 * (`adjacency.select(spec, cb)`, `adjacency.remove(spec)`): a value matches what is equal to it, and a function is a
 * template that matches what agrees with everything it sets.
 */

import type { DataType } from "./Visitors.js";

/** `Visitors.DataType<V> | ((visitor: V) => V)`: a value, or a function taking the visitor and returning it. */
export type Callback<V> = DataType<V> | ((visitor: V) => V);
