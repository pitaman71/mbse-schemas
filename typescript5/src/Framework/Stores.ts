/**
 * Stores: the root object of a body of data, through which schemas, builders and objects are located.
 *
 * A store holds schemas by name, and its data: the instances of its singleton schemas, its roots, and every reference
 * object reachable from them through relation entries, with the value objects those own. Anything else built with a
 * store's builders is transient: it lives only while the program holds it. `Store` is the protocol every
 * implementation meets; `Builders.Store` (dynamic instances) implements it, and generated code will. Everything that
 * looks a schema up by name takes a store: `Plain.ToPlain(store)`, `Plain.FromPlain(store)`, the JSON and YAML forms,
 * `Validators.Validate(store)`. Stores are isolated from one another; objects move between them as
 * snapshots. Selecting objects by a condition is an extension, in mbse-expressions.
 *
 * `Catalog` holds schemas by name and the roots, as every store does, with the messages every store gives, and
 * computes extents from the roots.
 *
 * A random source is given to whatever draws from it, such as mbse-patterns' generators, not held by a store, which is
 * data access alone: `Generate(store, weights, new PCG32(42n))`. `Random` is the protocol: `next_u32()`, the next 32
 * random bits, and `split(key)`, an independent stream determined by the source's seed and `key` alone, not by what was
 * drawn before. `PCG32(seed, sequence)` is the reference source, specified exactly so that
 * every implementation draws the same numbers: PCG-XSH-RR with a 64-bit state, seeded as the PCG paper's
 * `pcg32_srandom`; `split(key)` seeds a new PCG32, with the same sequence, from FNV-1a 64 of the key's UTF-8 bytes,
 * starting from the offset basis XOR the seed.
 */

import { utf8 } from "./Bytes.js";
import { AttributeError, LookupError, ValueError } from "./Errors.js";
import * as Reachable from "./Reachable.js";
import { repr } from "./Repr.js";
import * as Schemas from "./Schemas.js";
import type * as Readers from "./Readers.js";

type ObjectSchema = Schemas.OfObject.Data;
type RelationSchema = Schemas.OfRelation.Data;
type PredicateSchema = Schemas.OfPredicate.Data;

/** A source of random bits, given to whatever draws from it. */
export interface Random {
  /** The next 32 random bits, as an int from 0 to 2**32 - 1. */
  next_u32(): bigint;
  /** An independent stream, determined by this source's seed and `key` alone. */
  split(key: string): Random;
}

const MASK64 = (1n << 64n) - 1n;
const MULTIPLIER = 6364136223846793005n;
const [FNV_BASIS, FNV_PRIME] = [0xcbf29ce484222325n, 0x100000001b3n];

/** The reference random source: PCG-XSH-RR, a 64-bit state and 32-bit output (O'Neill, 2014), seeded as
 * `pcg32_srandom(seed, sequence)`. */
export class PCG32 implements Random {
  #state = 0n;
  readonly #increment: bigint;

  constructor(readonly seed: bigint, readonly sequence: bigint = 0n) {
    if (typeof seed !== "bigint" || typeof sequence !== "bigint" || seed < 0n || seed > MASK64 || sequence < 0n || sequence > MASK64) {
      throw new ValueError("a PCG32's seed and sequence are ints from 0 to 2**64 - 1");
    }
    this.#increment = ((sequence << 1n) | 1n) & MASK64;
    this.next_u32();
    this.#state = (this.#state + seed) & MASK64;
    this.next_u32();
  }

  next_u32(): bigint {
    const old = this.#state;
    this.#state = (old * MULTIPLIER + this.#increment) & MASK64;
    const shifted = (((old >> 18n) ^ old) >> 27n) & 0xffffffffn;
    const rotation = old >> 59n;
    return ((shifted >> rotation) | (shifted << ((-rotation) & 31n))) & 0xffffffffn;
  }

  split(key: string): PCG32 {
    let hashed = FNV_BASIS ^ this.seed;
    for (const byte of utf8(key)) hashed = ((hashed ^ BigInt(byte)) * FNV_PRIME) & MASK64;
    return new PCG32(hashed, this.sequence);
  }
}

/** A store: schemas by name, builders, and the objects it holds. */
export interface Store {
  /** The object schema registered as `name`: `AttributeError` if none is, `TypeError` for a relation. */
  schema(name: string): ObjectSchema;
  /** The object or relation schema registered as `name`; `LookupError` if none is. */
  registered(name: string): ObjectSchema | RelationSchema | PredicateSchema;
  /** The name `schema` is registered under; `LookupError` if it is not. */
  name_of(schema: unknown): string;
  /** Every registered name, in registration order. */
  names(): readonly string[];
  /** A builder for the object schema `name`, a `Visitors.OfObject` finalized by `create()`, or by `clone()` and
   * `update()` of `instance`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder(name: string, instance?: unknown): any;
  /** The live object of the schema `name` whose identity (unqualified, as `as_identity()` gives it) is `identity`;
   * `LookupError` if there is none. */
  by_identity(name: string, identity: string): Readers.OfObject;
  /** Whether the store was made holding `schema` (a `Builders.Store`'s plain schemas, basic scalars and mutation
   * schemas): a name each store holds its own schema under. */
  framework(schema: unknown): boolean;
  /** For decoders: a builder for the object schema `name` whose `create()` gives the object the identity a snapshot
   * names. A program writes one through the builder's `as_identity`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  restore(name: string, identity: string): any;
  /** The value `instance` holds in its property `name`, e.g. a value object or a union's branch. */
  member(instance: unknown, name: string): unknown;
  /** The one instance of the singleton schema whose global name is `name`; `LookupError` if there is none. */
  singleton(name: string): Readers.OfObject;
  /** The store's reference objects of the schema `name`: those reachable from its singletons, in first-reference
   * order. */
  extent(name: string): readonly Readers.OfObject[];
}

/** Schemas by name: `register`, `schema`, `registered`, `name_of` and `names`, as every store has them; the roots, by
 * global name (`singleton`), which an implementation fills; and `extent`, the reference objects reachable from them. */
export class Catalog {
  readonly _schemas = new Map<string, ObjectSchema | RelationSchema | PredicateSchema>();
  readonly _singletons = new Map<string, Readers.OfObject>();

  /** Registers a schema under its name. */
  _register(schema: ObjectSchema | RelationSchema | PredicateSchema): void {
    const name = schema.name as string; // a store registers only a named schema, as it builds it
    if (this._schemas.has(name)) throw new ValueError(`schema ${repr(name)} is already registered`);
    this._schemas.set(name, schema);
  }

  schema(name: string): ObjectSchema {
    const found = this._schemas.get(name);
    if (found === undefined) throw new AttributeError(`no schema registered as ${repr(name)}`);
    if (!(found instanceof Schemas.OfObject.Data)) {
      const kind = found instanceof Schemas.OfRelation.Data ? "relation" : "predicate";
      throw new TypeError(`${repr(name)} is a ${kind}; no ${kind} builder is exposed`);
    }
    return found;
  }

  registered(name: string): ObjectSchema | RelationSchema | PredicateSchema {
    const found = this._schemas.get(name);
    if (found === undefined) throw new LookupError(`no schema registered as ${repr(name)}`);
    return found;
  }

  name_of(schema: unknown): string {
    for (const [name, registered] of this._schemas) if (registered === schema) return name;
    throw new LookupError("schema is not registered");
  }

  names(): readonly string[] {
    return [...this._schemas.keys()];
  }

  singleton(name: string): Readers.OfObject {
    const found = this._singletons.get(name);
    if (found === undefined) throw new LookupError(`no singleton named ${repr(name)}`);
    return found;
  }

  extent(name: string): readonly Readers.OfObject[] {
    const schema = this.schema(name);
    const seen = new Set<unknown>();
    const found: Readers.OfObject[] = [];
    for (const root of this._singletons.values()) {
      for (const value of Reachable.of(root)) {
        if (!seen.has(value)) {
          seen.add(value);
          if (Schemas.is_a(value.as_schema(), schema)) found.push(value); // a refinement's objects are its too
        }
      }
    }
    return found;
  }

  /** The names of the object schemas that declare an adjacency, named or anonymous, to `relation` via `link`. */
  _filling(relation: RelationSchema, link: string): string[] {
    return [...this._schemas]
      .filter(([, s]) => s instanceof Schemas.OfObject.Data && s.fills(relation, link))
      .map(([name]) => name);
  }
}

/** Whether `store` registers `name` for a schema it was made holding (a `Builders.Store`'s own built-ins). */
function builtIn(store: Store, name: string): boolean {
  return store.framework(store.registered(name));
}

/** Stores combined into one: each name belongs to the one store that registers it, which gives its schema, builds its
 * objects and reads their members; the singletons are all of theirs, and an extent is the owning store's and what
 * every store's singletons reach. A name that two of the stores register for different schemas is refused; one they
 * register for the same schema, or each for a schema it was made holding (its `Schemas.OfInt`, ...), is the first's. */
export class Combined implements Store {
  readonly stores: readonly Store[];
  readonly #owners = new Map<string, Store>();

  constructor(...stores: Store[]) {
    this.stores = stores;
    for (const store of stores) {
      for (const name of store.names()) {
        const owner = this.#owners.get(name);
        if (owner !== undefined && owner.registered(name) !== store.registered(name)
          && !(builtIn(owner, name) && builtIn(store, name))) {
          throw new ValueError(`schema ${repr(name)} is registered by two of the stores`);
        }
        if (owner === undefined) this.#owners.set(name, store);
      }
    }
  }

  /** Whether one of the stores was made holding `schema`. */
  framework(schema: unknown): boolean {
    return this.stores.some((store) => store.framework(schema));
  }

  private owner(name: string, error: new (message: string) => Error): Store {
    const store = this.#owners.get(name);
    if (store === undefined) throw new error(`no schema registered as ${repr(name)}`);
    return store;
  }

  schema(name: string): ObjectSchema {
    return this.owner(name, AttributeError).schema(name);
  }

  registered(name: string): ObjectSchema | RelationSchema | PredicateSchema {
    return this.owner(name, LookupError).registered(name);
  }

  name_of(schema: unknown): string {
    for (const [name, store] of this.#owners) if (store.registered(name) === schema) return name;
    throw new LookupError("schema is not registered");
  }

  names(): readonly string[] {
    return [...this.#owners.keys()];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  builder(name: string, instance?: unknown): any {
    return this.owner(name, AttributeError).builder(name, instance);
  }

  by_identity(name: string, identity: string): Readers.OfObject {
    return this.owner(name, AttributeError).by_identity(name, identity);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  restore(name: string, identity: string): any {
    return this.owner(name, AttributeError).restore(name, identity);
  }

  member(instance: unknown, name: string): unknown {
    return this.owner((instance as Readers.OfObject).as_schema().name as string, AttributeError).member(instance, name);
  }

  /** Every store's singletons, by global name, so that combined stores combine again. */
  get _singletons(): ReadonlyMap<string, Readers.OfObject> {
    return new Map(this.stores.flatMap((store) => [...roots(store)]));
  }

  singleton(name: string): Readers.OfObject {
    const found = this._singletons.get(name);
    if (found === undefined) throw new LookupError(`no singleton named ${repr(name)}`);
    return found;
  }

  /** The owning store's extent, then the objects of the schema the other stores' singletons reach. */
  extent(name: string): readonly Readers.OfObject[] {
    const owner = this.owner(name, AttributeError);
    const schema = owner.schema(name);
    const seen = new Set<unknown>();
    const found: Readers.OfObject[] = [];
    const reached = [...this._singletons.values()].flatMap((root) => Reachable.of(root));
    for (const value of [...owner.extent(name), ...reached]) {
      if (!seen.has(value)) {
        seen.add(value);
        if (Schemas.is_a(value.as_schema(), schema)) found.push(value);
      }
    }
    return found;
  }
}

/** A store's singletons, by global name: a catalog's or a combined store's, or none. */
function roots(store: Store): ReadonlyMap<string, Readers.OfObject> {
  return (store as { _singletons?: ReadonlyMap<string, Readers.OfObject> })._singletons ?? new Map();
}

export { roots as _roots };
