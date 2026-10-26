/**
 * Proposals: a transaction's writes, held apart from the store they change until the transaction commits
 * (docs/OBJECT_IDENTITY.md, Decided, 89, 96, 99, 100).
 *
 * `OfStore` implements `Visitors.OfStore` over a base, what the store holds as committed or another `OfStore`: a data
 * object's property values, a value object's, and the entry tables of an object are copied from the base when first
 * written, and read in its place while the proposals are open; what they do not hold, they read through to the base.
 * Committed, they write what they hold into the base; aborted, they are dropped, and the store's registries are as they
 * were when they began. Proposals over proposals are a savepoint: a write within a transaction that may fail alone, as a
 * decoder's does.
 *
 * The updates of schema objects that existed before the transaction began wait in its proposals too, and are applied
 * when it commits; a savepoint's are its transaction's once it commits.
 */
import type * as Readers from "./Readers.js";
import type * as Schemas from "./Schemas.js";
import type * as Visitors from "./Visitors.js";

type Values = Map<string, unknown>;
type Tables = Map<unknown, Map<string, unknown>>;

/** What proposals are over: what the store holds as committed, or the proposals of the transaction a savepoint is
 * within. */
export interface Base {
  values(holder: object, write?: boolean): Values;
  entries(holder: object, write?: boolean): Tables;
}

/** A transaction's proposals over `base`, for the store whose data they change (`store`). */
export class OfStore implements Visitors.OfStore {
  /** Each holder's values. */
  readonly values_ = new Map<object, Values>();
  /** Each holder's entry tables. */
  readonly entries_ = new Map<object, Tables>();
  /** Each schema object's last builder, whose update waits for commit. */
  readonly deferred = new Map<object, any>();
  /** The data objects its builders created: what Provenance records (`note`). */
  readonly created = new Set<object>();
  /** The data objects its builders wrote: what Provenance records (`note`). */
  readonly written = new Set<object>();
  /** The transaction's expression, where it has one: its record's data (Provenance). */
  expression: unknown = null;
  /** How many schema objects the store held when the transaction began: those its updates of wait for its commit. */
  readonly existing: number;
  /** The store's registries, restored where the proposals are aborted. */
  readonly saved: Map<Map<unknown, unknown>, [unknown, unknown][]>;
  /** The ownership to settle, as it was. */
  readonly pending: [number, number];

  constructor(readonly base: Base, readonly store: any) {
    this.existing = base instanceof OfStore ? base.existing : store._existing();
    this.saved = store._saved();
    this.pending = [store._unowned.length, store._orphaned.length];
  }

  // --- Visitors.OfStore: the store's schemas, read through ---

  schema(name: string): Schemas.OfObject.Data {
    return this.store.schema(name);
  }

  registered(name: string): ReturnType<Visitors.OfStore["registered"]> {
    return this.store.registered(name);
  }

  name_of(schema: unknown): string {
    return this.store.name_of(schema);
  }

  names(): readonly string[] {
    return this.store.names();
  }

  builder(name: string, instance?: unknown): any {
    return this.store.builder(name, instance);
  }

  framework(schema: unknown): boolean {
    return this.store.framework(schema);
  }

  member(instance: unknown, name: string): unknown {
    return this.store.member(instance, name);
  }

  singleton(name: string): Readers.OfObject {
    return this.store.singleton(name);
  }

  extent(name: string): readonly Readers.OfObject[] {
    return this.store.extent(name);
  }

  // --- Visitors.OfStore: data ---

  /** A data object's or a value object's property values as the proposals have them: to write, their copy, made the
   * first time from the base's. */
  values(holder: object, write?: boolean): Values {
    const held = this.values_.get(holder);
    if (held !== undefined) return held;
    const below = this.base.values(holder);
    if (!write) return below;
    const copied = new Map(below);
    this.values_.set(holder, copied);
    return copied;
  }

  /** The entry tables of an object as the proposals have them: to write, their copy, made the first time from the
   * base's. */
  entries(holder: object, write?: boolean): Tables {
    const held = this.entries_.get(holder);
    if (held !== undefined) return held;
    const below = this.base.entries(holder);
    if (!write) return below;
    const copied: Tables = new Map([...below].map(([relation, table]) => [relation, new Map(table)]));
    this.entries_.set(holder, copied);
    return copied;
  }

  /** The last builder whose update of a schema object waits, in these proposals or those they are over. */
  /** Notes a data object a builder created, or wrote (Provenance). */
  /** Notes a data object a builder created, or wrote (Provenance); not one a snapshot being read restores, whose
   * records it restores with it. */
  note(target: object, created: boolean): void {
    if (!this.store._restoring) (created ? this.created : this.written).add(target);
  }

  deferred_of(original: object): any {
    const found = this.deferred.get(original);
    if (found === undefined && this.base instanceof OfStore) return this.base.deferred_of(original);
    return found;
  }

  // --- Ending ---

  /** Writes what the proposals hold into their base: a savepoint's into its transaction's proposals, a transaction's
   * into the store, the updates of schema objects that waited first; where one of those is refused, nothing is written,
   * and the store's registries are as they were. */
  commit(): void {
    if (!(this.base instanceof OfStore)) {
      try {
        this.store._expression(() => this.store._commit_schemas(this)); // its commit
      } catch (error) {
        this.store._restore(this.saved);
        throw error;
      }
    } else {
      for (const [original, builder] of this.deferred) this.base.deferred.set(original, builder); // in order
      for (const target of this.created) this.base.created.add(target);
      for (const target of this.written) this.base.written.add(target);
    }
    for (const [holder, values] of this.values_) {
      const into = this.base.values(holder, true);
      into.clear();
      for (const [name, value] of values) into.set(name, value);
    }
    for (const [holder, tables] of this.entries_) {
      const into = this.base.entries(holder, true);
      into.clear();
      for (const [relation, table] of tables) into.set(relation, table);
    }
  }

  /** Drops what the proposals hold: the store's registries, and the ownership left to settle, as they were when they
   * began. */
  abort(): void {
    this.store._restore(this.saved);
    this.store._unowned.splice(this.pending[0]);
    this.store._orphaned.splice(this.pending[1]);
  }
}
