/**
 * mbse-schemas: neutral, language-independent schemas for interfaces and data models.
 *
 * Objects, relations whose entries carry properties, unions and intersections. One schema value drives in-memory
 * objects (`Proxies`), JSON and YAML (`Plain`, `JSON`, `YAML`), validation (`Validators`) and comparison
 * (`Comparison`). Schemas are built in a store (`Builders.Store`); its writes are mutation expressions over frames
 * (`Transactions`, `Mutations`), held apart from it until they commit (`Proposals`), and written on the wire as
 * transactions, a store's snapshot two.
 *
 * For AI agents: read `skill/SKILL.md` at the root of this package first. It says when to use this package, the
 * practices that prevent most mistakes, and which reference to load for a task. The design is in docs/FRAMEWORK.md at
 * https://github.com/pitaman71/mbse-schemas.
 */

export * as Builders from "./Builders.js";
export * as Comparison from "./Comparison.js";
export * as Errors from "./Errors.js";
export * as JSON from "./JSON.js";
export * as Mutations from "./Mutations.js";
export * as Parametrics from "./Parametrics.js";
export * as Paths from "./Paths.js";
export * as Plain from "./Plain.js";
export * as Proposals from "./Proposals.js";
export * as Proxies from "./Proxies.js";
export * as Readers from "./Readers.js";
export * as References from "./References.js";
export * as Reachable from "./Reachable.js";
export * as Repr from "./Repr.js";
export * as Schemas from "./Schemas.js";
export * as Specs from "./Specs.js";
export * as Stores from "./Stores.js";
export * as Transactions from "./Transactions.js";
export * as Validators from "./Validators.js";
export * as Visitors from "./Visitors.js";
export * as YAML from "./YAML.js";
