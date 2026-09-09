/**
 * Proves a change touched only comments: transpiles each file at `git show <base>:path`
 * and in the working tree and compares the results. Bun's transpiler drops comments and
 * normalises whitespace, so identical output means the executable code is unchanged.
 *
 * Usage: bun tests/_comment-only-gate.ts [base-ref]   (default HEAD)
 */
import { Transpiler } from "bun";

const base = process.argv[2] ?? "HEAD";
const env = { ...process.env, GIT_DIR: "W:/GPUVideoProcessor/RTX-video-processor/.git", GIT_WORK_TREE: "W:/GPUVideoProcessor/RTX-video-processor" };

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { env, stdout: "pipe", stderr: "pipe" });
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

for (const path of changed) {
  const transpiler = path.endsWith(".tsx") ? tsx : ts;
  let before: string;
  try {
    before = git(["show", `${base}:${path}`]);
  } catch {
    console.log(`NEW   ${path} (no ${base} version)`);
    continue;
  }
  const after = await Bun.file(path).text();
  try {
    if (transpiler.transformSync(before) === transpiler.transformSync(after)) console.log(`ok    ${path}`);
    else codeOnly.push(path);
  } catch (error) {
    failed.push(`${path}: ${(error as Error).message}`);
  }
}

for (const path of codeOnly) console.log(`CODE  ${path}  <- executable code changed, review this diff`);
for (const message of failed) console.log(`ERROR ${message}`);
console.log(`\n${changed.length} changed, ${changed.length - codeOnly.length - failed.length} comment-only, ${codeOnly.length} with code changes, ${failed.length} unparsable`);
process.exit(failed.length > 0 ? 2 : 0);
