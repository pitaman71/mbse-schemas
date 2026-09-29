/**
 * Writes this implementation's conformance snapshots: `tsx src/Conformance/write.ts [directory]`.
 *
 * The default directory is `conformance/typescript5` at the repository root.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JSON, YAML } from "../Framework/index.js";
import { build } from "./Corpus.js";

export const DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../conformance/typescript5");

/** File name -> text for every case, as this implementation writes them. Pass an already built corpus to avoid
 * registering its schemas twice. */
export function render(corpus: ReturnType<typeof build> = build()): Map<string, string> {
  const files = new Map<string, string>();
  for (const [name, [schema, root]] of corpus) {
    files.set(`${name}.json`, JSON.ToJSON.Reachable(schema, root, { indent: 2 }) + "\n");
    files.set(`${name}.yaml`, YAML.ToYAML.Reachable(schema, root));
  }
  return files;
}

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
