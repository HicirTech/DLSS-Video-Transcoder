/**
 * Runs the real probe process (src/server/probe-child.ts) in a setup that cannot reach the GPU:
 * its first argument is an app-data folder that cannot be created, and runProbe's first step is to
 * create that folder, so it throws before any native call. The entry's wiring and its error line
 * are then exercised without a probe. A folder that could be created ends the run here instead.
 */
import { mkdirSync } from "node:fs";

const appData = process.argv[2];
if (appData === undefined) throw new Error("probe-child-harness needs an app-data folder that cannot be created as its first argument");
process.env.NR_APPDATA = appData;
let created = false;
try {
  mkdirSync(appData, { recursive: true });
  created = true;
} catch {
  // As intended: runProbe's mkdir throws the same way.
}
if (created) {
  console.log(JSON.stringify({ error: `test setup: ${appData} could be created, so the probe would have gone on to the GPU` }));
  process.exit(1);
}
// After the variable is set, because paths.ts reads it when it loads.
await import("../src/server/probe-child.ts");
