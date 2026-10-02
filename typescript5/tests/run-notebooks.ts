/**
 * Runs the test notebooks headless, the TypeScript counterpart of pytest + nbmake.
 *
 * Each notebook's code cells run in order as one ES module in its own process, so state carries from cell to cell
 * (as in a kernel) and every notebook starts afresh. A markdown heading `## XXX-NN · title` names the
 * test case its following code cell belongs to; a failure reports the case, the error, and its position.
 *
 *   tsx tests/run-notebooks.ts [--typecheck] [notebook ...]
 *
 * With no notebooks named, it runs every notebook in tests/ and tutorials/.
 *
 * `--typecheck` also type-checks every notebook with the project's tsconfig before running anything.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, ".build");

interface Cell {
  cell_type: "markdown" | "code";
  source: string | string[];
}

const CASE = /^##\s+([A-Z]+-\d+[a-z]?)\s+·/m;

function sourceOf(cell: Cell): string {
  return Array.isArray(cell.source) ? cell.source.join("") : cell.source;
}

/** Import specifiers are written relative to the notebook's folder; the generated module lives in tests/.build. */
function relocate(source: string, folder: string): string {
  return source.replace(/(from\s+|import\s*\(\s*)(["'])(\.\.?\/[^"']*)\2/g, (_m, lead: string, quote: string, spec: string) => {
    const moved = relative(build, resolve(folder, spec)).split(sep).join("/");
    return `${lead}${quote}${moved.startsWith(".") ? moved : "./" + moved}${quote}`;
  });
}

/** One module per notebook: every code cell in order, each preceded by a marker naming its test case. */
function generate(notebook: string): string {
  const cells = (JSON.parse(readFileSync(notebook, "utf8")) as { cells: Cell[] }).cells;
  let current = "setup";
  const parts = [
    "// Generated from " + basename(notebook) + " by run-notebooks.ts; do not edit.",
    "(globalThis as any).__case = 'setup';",
    `process.chdir(${JSON.stringify(dirname(resolve(notebook)))});`,
  ];
  for (const cell of cells) {
    const source = sourceOf(cell);
    if (cell.cell_type === "markdown") {
      const match = CASE.exec(source);
      if (match) current = match[1] as string;
      continue;
    }
    parts.push(`(globalThis as any).__case = ${JSON.stringify(current)};`, relocate(source, dirname(resolve(notebook))), "");
  }
  parts.push("export {};");
  const target = join(build, basename(notebook, ".ipynb") + ".ts");
  writeFileSync(target, parts.join("\n"));
  return target;
}

const PRELUDE = `
process.on("uncaughtException", (error) => {
  console.error("FAILED in " + ((globalThis as any).__case ?? "?") + ": " + (error?.stack ?? error));
  process.exit(1);
});
`;

const args = process.argv.slice(2);
const typecheck = args.includes("--typecheck");
const requested = args.filter((a) => !a.startsWith("--"));
const notebooks = requested.length > 0
  ? requested.map((n) => resolve(n))
  : [here, join(here, "../tutorials")].flatMap((folder) =>
      readdirSync(folder).filter((n) => n.endsWith(".ipynb")).sort().map((n) => join(folder, n)));

rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
writeFileSync(join(build, "prelude.ts"), PRELUDE);
const modules = notebooks.map(generate);

if (typecheck) {
  const tsc = spawnSync("npx", ["tsc", "--noEmit", "-p", join(here, "..")], { stdio: "inherit" });
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
}

let failed = 0;
for (const [i, module] of modules.entries()) {
  const name = basename(notebooks[i] as string);
  const started = Date.now();
  const result = spawnSync("npx", ["tsx", "--import", join(build, "prelude.ts"), module], { encoding: "utf8" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`PASSED ${name} (${seconds}s)`);
  } else {
    failed++;
    console.log(`FAILED ${name} (${seconds}s)\n${(result.stderr || result.stdout).trim()}\n`);
  }
}
console.log(`\n${notebooks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
