/**
 * Provenance: the records of the transactions a store executes, who executed them, when and from where
 * ([CAP-134: transactions recorded with provenance](../../../../mbse-basis/docs/capabilities/CAP-134.md)).
 *
 * Normal schemas, installed before use: `store.transaction(Provenance.install)`. `Provenance.OfTransaction` is the
 * record of one executed transaction, owned by the singleton `Provenance.Transactions`, keyed by the transaction's
 * `uid`: its `when`, UTC ISO 8601 text, and its `where`, a `Provenance.OfWhere`, where given. `Provenance.OfSession` is
 * the session it was executed in (`Provenance.InSession`), owned by `Provenance.Sessions`, keyed by its `id`: its
 * `started`, `locale` and `device`, and its one identity (`Provenance.Who`), a `Provenance.OfIdentity` owned by
 * `Provenance.Identities`, keyed by its `name`. `Provenance.CreatedBy` links an object to the transaction that created
 * it, `Provenance.ModifiedBy` to the latest that wrote it after, replaced by each later one: the tail, not a history.
 *
 * `extend(txn, schemas)` gives each reference object schema named anonymous adjacencies to `CreatedBy` and `ModifiedBy`
 * through `object`: the app decides which of its schemas have a history. The executor records, at commit and within
 * the same transaction, every transaction that creates or writes an object, where the store had `Provenance` installed
 * when it began (`_record`): from what its expression gives (`Mutations.OfTransaction`'s `when`, `session` and
 * `where`), so that replaying a journal makes the same records, found again by `uid`; an imperative scope's with
 * placeholder data.
 */

import { LookupError, ValueError } from "./Errors.js";
import type * as Proposals from "./Proposals.js";
import * as Proxies from "./Proxies.js";
import { repr } from "./Repr.js";
import * as Schemas from "./Schemas.js";

/** The placeholder of a transaction that names no session, or no identity: its session's `id`, its identity's `name`
 * (provenance 3 in [CAP-134: transactions recorded with provenance](../../../../mbse-basis/docs/capabilities/CAP-134.md#decided); tech debt). */
export const UNKNOWN = "unknown";

/** The records of executed transactions, their sessions and identities, defined in the store a transaction writes:
 * `store.transaction(Provenance.install)`. Run again in a store, it finds each by its name and writes nothing. */
export function install(txn: any): any {
  const S = txn.Schemas; // the store's meta-schemas and basic scalars (78)
  return txn.uid("mbse.Schemas.Provenance/1").mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p
    .symbols({
      OfWhere: S.OfObject, InSessions: S.OfRelation, Sessions: S.OfObject, OfSession: S.OfObject,
      InSession: S.OfRelation, InTransactions: S.OfRelation, Transactions: S.OfObject,
      OfTransaction: S.OfObject, InIdentities: S.OfRelation, Identities: S.OfObject,
      OfIdentity: S.OfObject, Who: S.OfRelation, CreatedBy: S.OfRelation, ModifiedBy: S.OfRelation,
    })
    .spec([
      (_: any) => _.OfWhere.name("Provenance.OfWhere").properties({ // a transaction's geolocation, where given
        latitude: S.OfFloat,
        longitude: S.OfFloat,
      }),
      (_: any) => _.InSessions.name("Provenance.InSessions").links([
        (t: any) => t.name("directory"),
        (t: any) => t.name("session"),
      ]).properties({ id: S.OfStr }).uniques([["directory", "id"], ["session"]]),
      (_: any) => _.Sessions.name("Provenance.SessionDirectory").ref(true).singleton("Provenance.Sessions")
        .adjacencies({ sessions: (a: any) => a.relation([_.InSessions]).me("directory") }),
      (_: any) => _.OfSession.name("Provenance.OfSession").ref(true).properties({
        started: S.OfStr, // UTC ISO 8601: when the session was first recorded
        locale: S.OfStr, // an interactive session's, e.g. "en-GB"
        device: S.OfStr,
      }).adjacencies([
        (t: any) => t.name("directory").relation([_.InSessions]).me("session").owner(true),
        (t: any) => t.name("transactions").relation([_.InSession]).me("session"),
        (t: any) => t.name("who").relation([_.Who]).me("session"),
      ]),
      (_: any) => _.InSession.name("Provenance.InSession").links([
        (t: any) => t.name("transaction"),
        (t: any) => t.name("session"),
      ]).uniques("session"), // one session per transaction
      (_: any) => _.InTransactions.name("Provenance.InTransactions").links([
        (t: any) => t.name("directory"),
        (t: any) => t.name("transaction"),
      ]).properties({ uid: S.OfStr }).uniques([["directory", "uid"], ["transaction"]]),
      (_: any) => _.Transactions.name("Provenance.TransactionDirectory").ref(true)
        .singleton("Provenance.Transactions")
        .adjacencies({ transactions: (a: any) => a.relation([_.InTransactions]).me("directory") }),
      (_: any) => _.OfTransaction.name("Provenance.OfTransaction").ref(true).properties({
        when: S.OfStr, // UTC ISO 8601, e.g. "2026-10-26T14:30:05Z"
        where: _.OfWhere,
      }).adjacencies([
        (t: any) => t.name("directory").relation([_.InTransactions]).me("transaction").owner(true),
        (t: any) => t.name("session").relation([_.InSession]).me("transaction"),
        (t: any) => t.name("created").relation([_.CreatedBy]).me("transaction"),
        (t: any) => t.name("modified").relation([_.ModifiedBy]).me("transaction"),
      ]),
      (_: any) => _.InIdentities.name("Provenance.InIdentities").links([
        (t: any) => t.name("directory"),
        (t: any) => t.name("identity"),
      ]).properties({ name: S.OfStr }).uniques([["directory", "name"], ["identity"]]),
      (_: any) => _.Identities.name("Provenance.IdentityDirectory").ref(true).singleton("Provenance.Identities")
        .adjacencies({ identities: (a: any) => a.relation([_.InIdentities]).me("directory") }),
      (_: any) => _.OfIdentity.name("Provenance.OfIdentity").ref(true).adjacencies([
        (t: any) => t.name("directory").relation([_.InIdentities]).me("identity").owner(true),
        (t: any) => t.name("sessions").relation([_.Who]).me("identity"),
      ]),
      (_: any) => _.Who.name("Provenance.Who").links([
        (t: any) => t.name("session"),
        (t: any) => t.name("identity"),
      ]).uniques("identity"), // one identity per session
      (_: any) => _.CreatedBy.name("Provenance.CreatedBy").links([
        (t: any) => t.name("object"),
        (t: any) => t.name("transaction"),
      ]).uniques("transaction"), // one creating transaction per object
      (_: any) => _.ModifiedBy.name("Provenance.ModifiedBy").links([
        (t: any) => t.name("object"),
        (t: any) => t.name("transaction"),
      ]).uniques("transaction"), // one per object: the latest write, replaced by the next
    ])]))]);
}

/** Gives each reference object schema of `schemas` (each a schema object, or its name as a path, `txn.work.Comment`)
 * an anonymous adjacency to `Provenance.CreatedBy` and to `Provenance.ModifiedBy` through `object`, so that it has no
 * member and the executor links its objects to the transactions that create and write them; the transaction that
 * does, in the store a transaction writes: `store.transaction((t: any) => Provenance.extend(t, [t.work.Comment]))`. An
 * app's install calls it with the schemas whose history it wants, after its own and `Provenance.install`; run again,
 * it writes nothing. */
export function extend(txn: any, schemas: Iterable<unknown>): any {
  const P = txn.Provenance;
  try {
    P.CreatedBy.as_schema();
  } catch {
    throw new LookupError("Provenance.extend: the store has no Provenance installed; install it first, "
      + "store.transaction(Provenance.install)");
  }
  const names: string[] = [];
  for (const given of schemas) {
    const schema: any = Proxies._deref(given);
    if (!(schema instanceof Schemas.OfObject.Data) || !schema.ref) {
      const shown = typeof schema?.name === "string" ? schema.name : given;
      throw new TypeError(`Provenance.extend takes reference object schemas: ${repr(shown)} is not one`);
    }
    names.push(schema.name as string);
  }
  const symbols = Object.fromEntries(names.map((_name, index) => [`s${index}`, txn.Schemas.OfObject]));
  return txn.mutations([(mu: any) => mu.upsert((u: any) => u.exists([(p: any) => p.symbols(symbols).spec(
    names.map((name, index) => (_: any) => _[`s${index}`].name(name).adjacencies([
      (t: any) => t.relation([P.CreatedBy]).me("object"), // anonymous: no member on the object
      (t: any) => t.relation([P.ModifiedBy]).me("object"),
    ])))]))]);
}

// --- The executor's records ---

/** The time now, as UTC ISO 8601 text to the second: `when` at commit, where the expression gives none. */
function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** A version 4 UUID, made of random bytes: the `uid` the store makes for a transaction that gives none. */
function uuid4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether `extend` gave an object schema its adjacency to `Provenance.CreatedBy`. */
function extended(store: any, schema: any): boolean {
  const createdBy = store.registered("Provenance.CreatedBy");
  return schema.anonymous.some((a: any) => a.relation === createdBy && a.me === "object");
}

/** The link of a directory's relation that is not the directory's. */
function other(relation: any): string {
  return [...relation.entry.links.keys()].find((link: string) => link !== "directory") as string;
}

/** The object a directory singleton holds under the key `value`, through its entries of `relation`; null where it
 * holds none. */
function held(store: any, relation: string, directory: string, key: string, value: string): any {
  const schema = store.registered(relation);
  const found = Proxies._linking(schema, "directory", store.singleton(directory), store)
    .map((entry: any) => Proxies._innerOf(entry))
    .find((entry: any) => entry._properties.get(key) === value);
  return found === undefined ? null : found._links.get(other(schema));
}

/** Adds an entry of the relation registered as `relation`. */
function link(store: any, relation: string, links: [string, unknown][], properties: [string, unknown][] = []): void {
  const schema = store.registered(relation);
  Proxies._add_entry(schema, Proxies._make_entry(schema, new Map(links), new Map(properties)), store);
}

/** Gives an object its entry in a directory singleton, keyed by `value`. */
function place(store: any, made: unknown, relation: string, directory: string, key: string, value: string): any {
  link(store, relation, [["directory", store.singleton(directory)], [other(store.registered(relation)), made]],
    [[key, value]]);
  return made;
}

/** A property of a value object an expression gives (its `session`, its `where`); null where either is absent. */
function given(store: any, value: unknown, name: string): any {
  return value === null || value === undefined ? null : store.member(value, name) ?? null;
}

/** Records the transaction whose proposals these are, at its commit, within it, where the store had `Provenance`
 * installed when it began and the transaction created or wrote an object through its builder: the transaction's
 * record, found by its `uid`, else made, with its `when` and `where`; where made, its session, found by its `id`, else
 * made with its `started`, `locale` and `device`, and its identity through `Who`, found by its name, else made; and
 * `InSession`. Each object of a schema `extend` extended is linked by `CreatedBy` where the transaction created it,
 * else by `ModifiedBy`, the one it held replaced. An imperative scope has no expression: its record has placeholder
 * data (provenance 3 in [CAP-134: transactions recorded with provenance](../../../../mbse-basis/docs/capabilities/CAP-134.md#decided)), a `uid` the store makes, `when` at commit, the session and identity `unknown`. */
export function _record(store: any, proposals: Proposals.OfStore): void {
  if (!proposals.saved.get(store._schemas)!.some(([name]) => name === "Provenance.OfTransaction")) return;
  const created = [...proposals.created];
  const written = [...proposals.written].filter((target) => !proposals.created.has(target));
  if (created.length === 0 && written.length === 0) return;
  const expression = proposals.expression;
  const uid = (expression === null ? null : store.member(expression, "uid")) ?? uuid4();
  const record = held(store, "Provenance.InTransactions", "Provenance.Transactions", "uid", uid)
    ?? madeRecord(store, expression, uid);
  for (const target of created) {
    if (extended(store, (target as any).as_schema())) {
      link(store, "Provenance.CreatedBy", [["object", target], ["transaction", record]]);
    }
  }
  const modifiedBy = store.registered("Provenance.ModifiedBy");
  for (const target of written) {
    if (!extended(store, (target as any).as_schema())) continue;
    const holding = Proxies._linking(modifiedBy, "object", target, store);
    if (holding.length === 1 && Proxies._innerOf(holding[0])._links.get("transaction") === record) continue;
    Proxies._discard(modifiedBy, holding, store); // the tail: the one it held, replaced
    link(store, "Provenance.ModifiedBy", [["object", target], ["transaction", record]]);
  }
}

/** A transaction's record, made, with its session, found or made, and the session's identity. */
function madeRecord(store: any, expression: unknown, uid: string): any {
  const member = (name: string): any => (expression === null ? null : store.member(expression, name) ?? null);
  const [when, where, session] = [member("when") ?? now(), member("where"), member("session")];
  if (session !== null && given(store, session, "id") === null) {
    throw new ValueError("a transaction's session has no id: a service gives it, and who, before executing it");
  }
  const [latitude, longitude] = [given(store, where, "latitude"), given(store, where, "longitude")];
  const builder = store.builder("Provenance.OfTransaction").when(when);
  if (where !== null) builder.where((w: any) => w.latitude(latitude).longitude(longitude));
  const record = place(store, builder.create(), "Provenance.InTransactions", "Provenance.Transactions", "uid", uid);
  const [sid, who] = [given(store, session, "id") ?? UNKNOWN, given(store, session, "who") ?? UNKNOWN];
  let found = held(store, "Provenance.InSessions", "Provenance.Sessions", "id", sid);
  let identity = held(store, "Provenance.InIdentities", "Provenance.Identities", "name", who);
  if (found === null) {
    const [locale, device] = [given(store, session, "locale"), given(store, session, "device")];
    const made = store.builder("Provenance.OfSession").started(when);
    if (locale !== null) made.locale(locale);
    if (device !== null) made.device(device);
    found = place(store, made.create(), "Provenance.InSessions", "Provenance.Sessions", "id", sid);
    identity ??= place(store, store.builder("Provenance.OfIdentity").create(), "Provenance.InIdentities",
      "Provenance.Identities", "name", who);
    link(store, "Provenance.Who", [["session", found], ["identity", identity]]);
  } else {
    const whose = Proxies._linking(store.registered("Provenance.Who"), "session", found, store)
      .map((entry: any) => Proxies._innerOf(entry)._links.get("identity"));
    if (whose.length !== 1 || whose[0] !== identity) {
      throw new ValueError(`session ${repr(sid)} is another identity's, not ${repr(who)}'s: a session has one identity `
        + "(Provenance.Who)");
    }
  }
  link(store, "Provenance.InSession", [["transaction", record], ["session", found]]);
  return record;
}
