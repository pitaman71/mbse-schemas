/**
 * The text of this implementation's conformance snapshots. Platform-neutral: `write.ts` saves it with Node, and the
 * portability smoke test (`tests/portability/deno.ts`) compares it without Node.
 */

import { JSON, YAML } from "../Framework/index.js";
import { build } from "./Corpus.js";

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
