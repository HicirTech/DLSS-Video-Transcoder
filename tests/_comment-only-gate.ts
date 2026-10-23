/**
 * Proves a change touched only comments: transpiles each file at `git show <base>:path`
 * and in the working tree and compares the results. Bun's transpiler drops comments and
 * normalises whitespace, so identical output means the executable code is unchanged.
 *
 * Usage: bun tests/_comment-only-gate.ts [base-ref]   (default HEAD)
 * Exit status: 0 when every changed file changed only comments, 1 when code changed or a file was added or
 * deleted, 2 when a file could not be parsed.
 * git runs in the caller's environment, so on the network drive export GIT_DIR and GIT_WORK_TREE first.
 */
import { Transpiler } from "bun";

const base = process.argv[2] ?? "HEAD";

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(proc.stderr).trim()}`);
  return new TextDecoder().decode(proc.stdout);
}

const changed = git(["diff", "--name-only", base, "--"]).split("\n").map((l) => l.trim()).filter((l) => /\.(ts|tsx)$/.test(l));
if (changed.length === 0) {
  console.log("no changed .ts/.tsx files");
  process.exit(0);
}

const tsx = new Transpiler({ loader: "tsx" });
const ts = new Transpiler({ loader: "ts" });
const codeOnly: string[] = [];
const failed: string[] = [];
const added: string[] = [];
const removed: string[] = [];

for (const path of changed) {
  const transpiler = path.endsWith(".tsx") ? tsx : ts;
  let before: string;
  try {
    before = git(["show", `${base}:${path}`]);
  } catch {
    console.log(`NEW   ${path} (no ${base} version)`);
    added.push(path);
    continue;
  }
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.log(`GONE  ${path} (deleted since ${base})`);
    removed.push(path);
    continue;
  }
  const after = await file.text();
  try {
    if (transpiler.transformSync(before) === transpiler.transformSync(after)) console.log(`ok    ${path}`);
    else codeOnly.push(path);
  } catch (error) {
    failed.push(`${path}: ${(error as Error).message}`);
  }
}

for (const path of codeOnly) console.log(`CODE  ${path}  <- executable code changed, review this diff`);
for (const message of failed) console.log(`ERROR ${message}`);
const commentOnly = changed.length - codeOnly.length - failed.length - added.length - removed.length;
console.log(
  `\n${changed.length} changed, ${commentOnly} comment-only, ${codeOnly.length} with code changes, ${added.length} new, ${removed.length} deleted, ${failed.length} unparsable`,
);
if (failed.length > 0) process.exit(2);
process.exit(codeOnly.length + added.length + removed.length > 0 ? 1 : 0);
