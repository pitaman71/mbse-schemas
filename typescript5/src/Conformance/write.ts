/**
 * Writes this implementation's conformance snapshots: `tsx src/Conformance/write.ts [directory]`.
 *
 * The default directory is `conformance/typescript5` at the repository root.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { render } from "./Render.js";

export { render };

export const DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../conformance/typescript5");

export function main(directory: string = DEFAULT): void {
  mkdirSync(directory, { recursive: true });
  for (const [name, text] of render()) {
    writeFileSync(join(directory, name), text, "utf8");
    console.log("wrote", join(directory, name));
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? DEFAULT);
}
