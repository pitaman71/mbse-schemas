/**
 * Portability smoke test: the framework without Node.
 *
 * `npm run portability` bundles this file for the browser with esbuild, which fails on any Node built-in, and runs the
 * bundle under Deno with Node's globals (`Buffer`, `process`, ...) removed. It checks the conformance corpus end to end: this
 * implementation's snapshots are byte-identical to the committed ones, and every implementation's JSON and YAML read into a
 * store that writes the same snapshot, its data valid. It reads files with `fetch`, so the same bundle could run in a browser page served over HTTP.
 */

import { render } from "../../src/Conformance/Render.js";
import { build, CASES } from "../../src/Conformance/Corpus.js";
import { Builders, JSON, Validators, YAML } from "../../src/Framework/index.js";

const root = new URL("../../../conformance/", import.meta.url);
const read = async (path: string): Promise<string> => (await fetch(new URL(path, root))).text();

// Remove Node's globals, as a browser lacks them (Deno 2 defines some for compatibility). The framework only touches
// globals when called, so removing them after the imports still covers everything it does.
for (const name of ["Buffer", "process", "global", "require"]) Reflect.deleteProperty(globalThis, name);
if (["Buffer", "process", "global", "require"].some((name) => name in globalThis)) throw new Error("Node globals remain");

const corpus = build(); // each case's store, and its data, which a store holds weakly
const files = render(corpus);
let checked = 0;
for (const [name, text] of files) {
  if (text !== (await read(`typescript5/${name}`))) throw new Error(`typescript5/${name} differs from this runtime's output`);
  if (name.endsWith(".json") && text !== (await read(`python3/${name}`))) throw new Error(`python3/${name} is not byte-identical`);
  checked++;
}

for (const name of CASES) {
  const expected = files.get(`${name}.json`);
  for (const implementation of ["python3", "typescript5"]) {
    for (const ext of ["json", "yaml"]) {
      const fresh = new Builders.Store();
      const load = ext === "json" ? JSON.FromJSON(fresh) : YAML.FromYAML(fresh);
      const made = load.Snapshot(await read(`${implementation}/${name}.${ext}`));
      if (JSON.ToJSON(fresh).Snapshot({ indent: 2 }) + "\n" !== expected) {
        throw new Error(`${implementation}/${name}.${ext} reads into a store that writes another snapshot`);
      }
      for (const value of made as any[]) { // the case's data, but the corpus's root, which only holds it
        if (value.as_schema().singleton === null) {
          const problems = Validators.Validate(fresh).Reachable(value.as_schema(), value as never);
          if (problems.length > 0) throw new Error(`${implementation}/${name}.${ext}: ${problems.join("; ")}`);
        }
      }
      checked++;
    }
  }
}
console.log(`portability: ${checked} checks passed without Node`);
