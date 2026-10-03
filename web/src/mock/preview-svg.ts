/* SVG stand-ins for the file previews the real server streams from /api/file. */

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** A stand-in for /api/file: a generated landscape whose look depends on the path (outputs look "enhanced"). */
export function mockPreviewSvg(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const enhanced = /(-|_)nr\.|enhanced|output/i.test(name);
  let hash = 7;
  for (const ch of path) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const saturation = enhanced ? 80 : 45;
  const lightness = enhanced ? 50 : 38;
  const blur = enhanced ? 0 : 1.6;
  const label = enhanced ? "mock preview - neural rendering" : "mock preview - source";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">` +
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} ${saturation}% ${lightness}%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 40) % 360} ${saturation}% ${lightness - 22}%)"/>` +
    `</linearGradient><filter id="soft"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>` +
    `<g filter="url(#soft)"><rect width="960" height="540" fill="url(#sky)"/>` +
    `<circle cx="700" cy="150" r="${enhanced ? 72 : 60}" fill="hsl(${(hue + 180) % 360} ${saturation}% 82%)" opacity="${enhanced ? 0.95 : 0.6}"/>` +
    `<path d="M0 400 L160 300 L300 380 L460 250 L620 360 L780 280 L960 380 L960 540 L0 540 Z" fill="hsl(${hue} ${saturation - 10}% ${enhanced ? 20 : 28}%)"/>` +
    `<path d="M0 470 L200 420 L380 460 L560 410 L760 450 L960 420 L960 540 L0 540 Z" fill="hsl(${(hue + 20) % 360} ${saturation - 15}% ${enhanced ? 12 : 20}%)"/></g>` +
    `<text x="24" y="40" font-family="Segoe UI, sans-serif" font-size="20" fill="#fff" opacity="0.75">${escapeXml(label)}</text>` +
    `<text x="24" y="512" font-family="Segoe UI, sans-serif" font-size="26" fill="#fff" opacity="0.9">${escapeXml(name)}</text>` +
    `</svg>`
  );
}
