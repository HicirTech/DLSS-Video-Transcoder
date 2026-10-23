/**
 * Manual GPU diagnostic (not part of `bun test`): which PerfQuality values does
 * the installed nvngx_dlss.dll accept, and does CreateFeature care about the
 * mode or about the render/output ratio? Re-run it after updating nvngx_dlss.dll, before adding
 * PerfQuality 4 (UltraQuality) back to DLSS_RATIO: that mode was refused at every ratio on 310.7.129.0.
 *
 *   bun run tests/diag-sr-quality-modes.ts
 */
import { DEFAULT_RUNTIME_DIR } from "../src/paths.ts";
import { openGpu } from "../src/pipeline/gpu.ts";
import { DlssSrSession } from "../src/ngx/sr.ts";
import { DLSS_RATIO, PerfQuality, perfQualityName } from "../src/ngx/results.ts";

const runtimeDir = DEFAULT_RUNTIME_DIR;
const RENDER_WIDTH = 800;
const RENDER_HEIGHT = 1168; // even, so no dimension rounding enters the result

function attempt(quality: number, ratio: number): void {
  const label = `quality ${quality} (${perfQualityName(quality)}) at ${ratio.toFixed(2)}x`;
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
  attempt(Number(quality), ratio);
}

console.log("\nSeparating the mode from the ratio:");
// If UltraQuality fails at every ratio, the mode is unsupported. If it succeeds at 1.5,
// the 1.3 ratio was the problem, and the same 1.3 ratio should then fail on a
// mode that is known good.
attempt(PerfQuality.UltraQuality, 1.5);
attempt(PerfQuality.UltraQuality, 2.0);
attempt(PerfQuality.MaxQuality, 1.3);
attempt(PerfQuality.DLAA, 1.3);

process.exit(0);
