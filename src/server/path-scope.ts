/**
 * Whether a path lies inside a folder: the check that confines a job's output path. Kept out of
 * validate.ts because it needs node:path, and that module also runs in the browser mock.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * True when `child` resolves inside `root`.
 *
 * The check is on the first path segment, not a string prefix: a relative path
 * such as `..cache/out.mp4` names a child directory that merely starts with two
 * dots, and rejecting it would refuse a legitimate output path.
 */
export function isWithin(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}
