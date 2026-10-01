/**
 * Reachable: finds every object reachable from a root through adjacencies.
 *
 * `Reachable.of(root)` returns the root and every reference object reachable from it, in the order each is first
 * referenced. Value objects are followed too: their entries are collected like a reference object's, and a value object
 * reached brings in the reference object that owns it (`Visitable.owner()`), where it is written.
 * `Reachable.targets(objects)` gives the identities of every object their entries link, value objects included. The
 * collector is a visitor: each object writes itself into it through `Visitable.accept`, and the collector records the
 * targets of the links it is given. It needs no schema: native property values are ignored.
 */

import { AttributeError, LookupError, NotImplementedError } from "./Errors.js";
import type { Callback, Native, OfAdjacency, OfAny, OfEntry, OfIndexed, OfIntersection, OfItem, OfLink, OfNative, OfObject,
  OfProperty, OfUnion, Visitable } from "./Visitors.js";

type Found = (target: Visitable) => void;

/** `Visitors.OfNative` / `OfAny` / `OfProperty` that discards native property values, and collects the entries of value
 * objects. */
export class _Ignored implements OfNative, OfAny, OfProperty {
  constructor(private readonly propertyName: string, private readonly found: Found) {}

  name(): string {
    return this.propertyName;
  }

  has(): boolean {
    return false;
  }

  get(): Native {
    throw new AttributeError("reachability does not record property values");
  }

  set(_value: Native): _Ignored {
    return this;
  }

  clear(): _Ignored {
    return this;
  }

  value(callback: Callback<OfAny>): _Ignored {
    callback(this);
    return this;
  }

  as_native(callback: Callback<OfNative>): _Ignored {
    callback(this);
    return this;
  }

  /** A value object's entries are collected too. */
  as_object(callback: Callback<OfObject>): _Ignored {
    callback(new _Collector(this.found));
    return this;
  }

  as_union(callback: Callback<OfUnion>): _Ignored {
    callback(new _Collector(this.found) as unknown as OfUnion);
    return this;
  }

  as_intersection(callback: Callback<OfIntersection>): _Ignored {
    callback(new _Collector(this.found) as unknown as OfIntersection);
    return this;
  }

  /** The value objects in a list are followed too. */
  as_indexed(callback: Callback<OfIndexed>): _Ignored {
    callback(new _Items(this.propertyName, this.found));
    return this;
  }
}

/** `Visitors.OfIndexed` that discards a list, and collects the entries of the value objects in it. */
export class _Items implements OfIndexed {
  constructor(private readonly propertyName: string, private readonly found: Found) {}

  items(_callback: Callback<OfAny>): _Items {
    return this;
  }

  item(index: number, _callback: Callback<OfAny>): _Items {
    throw new LookupError(`the list has no item ${index}`); // it keeps no items
  }

  append(callback: Callback<OfAny>): _Items {
    callback(new _Ignored(this.propertyName, this.found));
    return this;
  }

  remove(index: number): _Items {
    throw new LookupError(`the list has no item ${index}`);
  }

  clear(): _Items {
    return this;
  }

  pairs(_callback: Callback<OfItem>): _Items {
    return this;
  }

  at(_key: Callback<OfAny>, _callback: Callback<OfAny>): _Items {
    throw new LookupError("the list has no item with this key"); // it keeps no items
  }

  put(key: Callback<OfAny>, value: Callback<OfAny>): _Items {
    key(new _Ignored(this.propertyName, this.found)); // a key holds no links, but a visitor may write any value
    value(new _Ignored(this.propertyName, this.found));
    return this;
  }

  discard(_key: Callback<OfAny>): _Items {
    throw new LookupError("the list has no item with this key");
  }
}

/** `Visitors.OfLink` that reports its target. */
export class _Link implements OfLink {
  constructor(private readonly linkName: string, private readonly found: Found) {}

  name(): string {
    return this.linkName;
  }

  target(_callback: Callback<Visitable>): _Link {
    throw new NotImplementedError("the reachability collector does not read link targets back");
  }

  set(target: Visitable): _Link {
    this.found(target);
    return this;
  }
}

/** `Visitors.OfEntry` that reports the targets of its links. */
export class _Entry implements OfEntry {
  constructor(private readonly found: Found) {}

  links(_callback: Callback<OfLink>): _Entry {
    return this;
  }

  link(name: string, callback: Callback<OfLink>): _Entry {
    callback(new _Link(name, this.found));
    return this;
  }

  properties(_callback: Callback<OfProperty>): _Entry {
    return this;
  }

  has(_name: string): boolean {
    return false;
  }

  property(name: string, callback: Callback<OfProperty>): _Entry {
    callback(new _Ignored(name, this.found));
    return this;
  }

  clear(_name: string): _Entry {
    return this;
  }
}

/** `Visitors.OfAdjacency` that reports the targets of the entries added to it. */
export class _Adjacency implements OfAdjacency {
  constructor(private readonly adjacencyName: string, private readonly found: Found) {}

  name(): string {
    return this.adjacencyName;
  }

  me(): string {
    throw new NotImplementedError("the reachability collector is schema-agnostic");
  }

  entries(_callback: Callback<OfEntry>): _Adjacency {
    return this;
  }

  add(callback: Callback<OfEntry>): _Adjacency {
    callback(new _Entry(this.found));
    return this;
  }

  remove(_entry: OfEntry): _Adjacency {
    return this;
  }
}

/** `Visitors.OfObject` that reports every object linked from the object written into it. */
export class _Collector implements OfObject {
  constructor(private readonly found: Found) {}

  properties(_callback: Callback<OfProperty>): _Collector {
    return this;
  }

  has(_name: string): boolean {
    return false;
  }

  property(name: string, callback: Callback<OfProperty>): _Collector {
    callback(new _Ignored(name, this.found));
    return this;
  }

  clear(_name: string): _Collector {
    return this;
  }

  adjacencies(_callback: Callback<OfAdjacency>): _Collector {
    return this;
  }

  adjacency(name: string, callback: Callback<OfAdjacency>): _Collector {
    callback(new _Adjacency(name, this.found));
    return this;
  }

  identify(_value: Visitable): _Collector {
    return this;
  }
}

/** The reference object that owns `target`, or `target` itself when it is a reference object. */
function referent(target: Visitable): Visitable {
  for (let owner = target.owner(); owner !== null; owner = target.owner()) target = owner;
  return target;
}

/** The root and every reference object reachable from it through adjacencies, in first-reference order. */
export function of(root: Visitable): Visitable[] {
  const seen = new Map<unknown, Visitable>([[root.identity(), root]]);
  const queue: Visitable[] = [root];
  const found = (reached: Visitable): void => {
    const target = referent(reached);
    if (!seen.has(target.identity())) {
      seen.set(target.identity(), target);
      queue.push(target);
    }
  };
  for (let i = 0; i < queue.length; i++) (queue[i] as Visitable).accept(new _Collector(found));
  return [...seen.values()];
}

/** The identities of every object that the entries of `objects`, and of the value objects they hold, link. */
export function targets(objects: Visitable[]): Set<unknown> {
  const linked = new Set<unknown>();
  for (const value of objects) value.accept(new _Collector((target) => linked.add(target.identity())));
  return linked;
}
