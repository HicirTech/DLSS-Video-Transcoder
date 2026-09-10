/**
 * Manual GPU diagnostic (not part of `bun test`): which PerfQuality values does
 * the installed nvngx_dlss.dll accept, and does CreateFeature care about the
 * mode or about the render/output ratio?
 *
 * `sr --factor 1.3` fails with UnsupportedParameter while every other documented
 * factor works, and the two candidate causes were never separated: PerfQuality 4
 * (UltraQuality) itself, or the 1.3 ratio that goes with it.
 *
 *   bun run tests/diag-sr-quality-modes.ts
 */
import { join } from "node:path";
import { openGpu } from "../src/pipeline/gpu.ts";
import { DlssSrSession } from "../src/ngx/sr.ts";
import { DLSS_RATIO, perfQualityName } from "../src/ngx/results.ts";

const ROOT = join(import.meta.dir, "..");
const runtimeDir = join(ROOT, "runtime");
const RENDER_WIDTH = 800;
const RENDER_HEIGHT = 1168; // even, so no dimension rounding enters the result

function attempt(label: string, quality: number, ratio: number): void {
  const session = openGpu({});
  const outputWidth = Math.round(RENDER_WIDTH * ratio) & ~1;
  const outputHeight = Math.round(RENDER_HEIGHT * ratio) & ~1;
  try {
    const sr = DlssSrSession.open(session, {
      renderWidth: RENDER_WIDTH,
      renderHeight: RENDER_HEIGHT,
      outputWidth,
      outputHeight,
      quality,
      runtimeDir,
    });
    sr.close();
    console.log(`  ${label.padEnd(46)} OK    ${RENDER_WIDTH}x${RENDER_HEIGHT} -> ${outputWidth}x${outputHeight}`);
  } catch (error) {
    console.log(`  ${label.padEnd(46)} FAIL  ${(error as Error).message.split("\n")[0]}`);
  } finally {
    session.close();
  }
}

console.log("Each PerfQuality at the ratio DLSS_RATIO pairs with it:");
for (const [quality, ratio] of Object.entries(DLSS_RATIO).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  attempt(`quality ${quality} (${perfQualityName(Number(quality))}) at ${ratio.toFixed(2)}x`, Number(quality), ratio);
}

console.log("\nSeparating the mode from the ratio:");
// If 4 fails at every ratio, the mode is unsupported. If it succeeds at 1.5,
// the 1.3 ratio was the problem, and the same 1.3 ratio should then fail on a
// mode that is known good.
attempt("quality 4 (UltraQuality) at 1.50x", 4, 1.5);
attempt("quality 4 (UltraQuality) at 2.00x", 4, 2.0);
attempt("quality 2 (MaxQuality) at 1.30x", 2, 1.3);
attempt("quality 5 (DLAA) at 1.30x", 5, 1.3);

process.exit(0);
