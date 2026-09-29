/**
 * Reachable: finds every object reachable from a root through adjacencies.
 *
 * `Reachable.of(root)` returns the root and every object reachable from it, in the order each is first referenced.
 * The collector is a visitor: each object writes itself into it through `Visitable.accept`, and the collector records
 * the targets of the links it is given. It needs no schema: property values are ignored.
 */

import { AttributeError, NotImplementedError } from "./Errors.js";
import type { Callback, Native, OfAdjacency, OfAny, OfEntry, OfIntersection, OfLink, OfNative, OfObject, OfProperty,
  OfUnion, Visitable } from "./Visitors.js";

type Found = (target: Visitable) => void;

/** `Visitors.OfNative` / `OfAny` / `OfProperty` that discards property values. */
export class _Ignored implements OfNative, OfAny, OfProperty {
  constructor(private readonly propertyName: string = "") {}

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

  as_object(_callback: Callback<OfObject>): _Ignored {
    return this;
  }

  as_union(_callback: Callback<OfUnion>): _Ignored {
    return this;
  }

  as_intersection(_callback: Callback<OfIntersection>): _Ignored {
    return this;
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
    callback(new _Ignored(name));
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
    callback(new _Ignored(name));
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
}

/** The root and every object reachable from it through adjacencies, in first-reference order. */
export function of(root: Visitable): Visitable[] {
  const seen = new Map<unknown, Visitable>([[root.identity(), root]]);
  const queue: Visitable[] = [root];
  const found = (target: Visitable): void => {
    if (!seen.has(target.identity())) {
      seen.set(target.identity(), target);
      queue.push(target);
    }
  };
  for (let i = 0; i < queue.length; i++) (queue[i] as Visitable).accept(new _Collector(found));
  return [...seen.values()];
}
