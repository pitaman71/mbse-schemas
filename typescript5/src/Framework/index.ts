/**
 * mbse-schemas: neutral, language-independent schemas for interfaces and data models.
 *
 * Objects, relations whose entries carry properties, unions and intersections. One schema value drives in-memory
 * objects (`Proxies`), JSON and YAML (`Plain`, `JSON`, `YAML`), validation (`Validators`) and comparison
 * (`Comparison`).
 *
 * For AI agents: read `skill/SKILL.md` at the root of this package first. It says when to use this package, the
 * practices that prevent most mistakes, and which reference to load for a task. The design is in docs/FRAMEWORK.md at
 * https://github.com/pitaman71/mbse-schemas.
 */

export * as Bindings from "./Bindings.js";
export * as Comparison from "./Comparison.js";
export * as Errors from "./Errors.js";
export * as JSON from "./JSON.js";
export * as Modules from "./Modules.js";
export * as Reflection from "./Reflection.js";
export * as Plain from "./Plain.js";
export * as Proxies from "./Proxies.js";
export * as Reachable from "./Reachable.js";
export * as Repr from "./Repr.js";
export * as Schemas from "./Schemas.js";
export * as Stores from "./Stores.js";
export * as Validators from "./Validators.js";
export * as Visitors from "./Visitors.js";
export * as YAML from "./YAML.js";
