/** The dependency-free block-matching FlowBackend (flow-backend.ts), the estimator's default. */
import type { FlowBackend } from "./flow-backend.ts";

/** Square block edge of the block matcher, in grid pixels. */
const BLOCK_EDGE = 8;
/** Max search displacement of the block matcher, in grid pixels, each axis. */
const SEARCH_RADIUS = 8;

/** The two gray grids a block is matched between: a block of `current` is searched for in `previous`. */
interface GridPair {
  current: Float32Array;
  previous: Float32Array;
  w: number;
  h: number;
}

/** One block of `current` as the pixel ranges [bx, bxEnd) x [by, byEnd); blocks at the right and bottom edges are smaller. */
interface Block {
  bx: number;
  by: number;
  bxEnd: number;
  byEnd: number;
}

/**
 * Dependency-free block-matching flow: per block of `current`, the integer
 * displacement into `previous` that minimizes SAD, assigned to every pixel of
 * the block. That displacement is already the current->previous flow — a block
 * at p in current best matches previous at p+d, so prevPos - curPos = d — so it
 * carries the cv2 calc(current, previous) sign with no negation.
 */
function blockMatchFlow(current: Float32Array, previous: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 2);
  const grids: GridPair = { current, previous, w, h };
  for (let by = 0; by < h; by += BLOCK_EDGE) {
    for (let bx = 0; bx < w; bx += BLOCK_EDGE) {
      matchBlock(out, grids, { bx, by, bxEnd: Math.min(bx + BLOCK_EDGE, w), byEnd: Math.min(by + BLOCK_EDGE, h) });
    }
  }
  return out;
}

/** Writes the displacement that best matches `block` to every output pixel of the block. */
function matchBlock(out: Float32Array, grids: GridPair, block: Block): void {
  const { bx, by, bxEnd, byEnd } = block;
  let bestDx = 0;
  let bestDy = 0;
  let bestCost = Infinity;
  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy++) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx++) {
      const cost = blockCost(grids, block, dx, dy);
      // Prefer the smaller displacement on ties for a stable, low-noise field.
      if (cost < bestCost || (cost === bestCost && Math.abs(dx) + Math.abs(dy) < Math.abs(bestDx) + Math.abs(bestDy))) {
        bestCost = cost;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  for (let y = by; y < byEnd; y++) {
    let o = (y * grids.w + bx) * 2;
    for (let x = bx; x < bxEnd; x++, o += 2) {
      out[o] = bestDx;
      out[o + 1] = bestDy;
    }
  }
}

/** SAD cost of a sample displaced off the grid: the largest possible 8-bit luma difference. */
const OFF_GRID_COST = 255;

/** Sum of absolute differences between `block` and `previous` displaced by (dx, dy); a sample off the grid costs OFF_GRID_COST. */
function blockCost(grids: GridPair, block: Block, dx: number, dy: number): number {
  const { current, previous, w, h } = grids;
  const { bx, by, bxEnd, byEnd } = block;
  let cost = 0;
  for (let y = by; y < byEnd; y++) {
    const qy = y + dy;
    if (qy < 0 || qy >= h) {
      cost += OFF_GRID_COST * (bxEnd - bx);
      continue;
    }
    const cRow = y * w;
    const qRow = qy * w;
    for (let x = bx; x < bxEnd; x++) {
      const qx = x + dx;
      cost += qx < 0 || qx >= w ? OFF_GRID_COST : Math.abs(current[cRow + x]! - previous[qRow + qx]!);
    }
  }
  return cost;
}

/** The pure-TS block-matching backend, used unless the caller passes its own. */
export function createBlockMatchBackend(): FlowBackend {
  return {
    calc: blockMatchFlow,
  };
}
