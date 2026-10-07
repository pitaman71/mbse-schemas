/**
 * Portability smoke test: the framework without Node.
 *
 * `npm run portability` bundles this file for the browser with esbuild, which fails on any Node built-in, and runs the
 * bundle under Deno with Node's globals (`Buffer`, `process`, ...) removed. It checks the conformance corpus end to end: this
 * implementation's snapshots are byte-identical to the committed ones, and every implementation's JSON and YAML load
 * and validate. It reads files with `fetch`, so the same bundle could run in a browser page served over HTTP.
 */

import { render } from "../../src/Conformance/Render.js";
import { build, CASES } from "../../src/Conformance/Corpus.js";
import { JSON, Validators, YAML } from "../../src/Framework/index.js";

const root = new URL("../../../conformance/", import.meta.url);
const read = async (path: string): Promise<string> => (await fetch(new URL(path, root))).text();

// Remove Node's globals, as a browser lacks them (Deno 2 defines some for compatibility). The framework only touches
// globals when called, so removing them after the imports still covers everything it does.
for (const name of ["Buffer", "process", "global", "require"]) Reflect.deleteProperty(globalThis, name);
if (["Buffer", "process", "global", "require"].some((name) => name in globalThis)) throw new Error("Node globals remain");

const corpus = build(); // each case's root schema, root, and the store it belongs to
const files = render(corpus);
let checked = 0;
for (const [name, text] of files) {
  if (text !== (await read(`typescript5/${name}`))) throw new Error(`typescript5/${name} differs from this runtime's output`);
  if (name.endsWith(".json") && text !== (await read(`python3/${name}`))) throw new Error(`python3/${name} is not byte-identical`);
  checked++;
}

for (const name of CASES) {
  const [schema, , store] = corpus.get(name) as [never, unknown, never];
  for (const implementation of ["python3", "typescript5"]) {
    for (const [ext, load] of [["json", JSON.FromJSON(store)], ["yaml", YAML.FromYAML(store)]] as const) {
      const restored = load.Reachable(schema, await read(`${implementation}/${name}.${ext}`));
      const problems = Validators.Validate(store).Reachable(schema, restored as never);
      if (problems.length > 0) throw new Error(`${implementation}/${name}.${ext}: ${problems.join("; ")}`);
      checked++;
    }
  }
}
console.log(`portability: ${checked} checks passed without Node`);
