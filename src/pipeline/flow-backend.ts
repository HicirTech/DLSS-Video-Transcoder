/** The FlowBackend seam: the dense current -> previous flow contract the block matcher and the NVOFA backend fill. */

/**
 * Dense per-pixel flow on the small gray grid: an interleaved (dx, dy) field of
 * length w*h*2 in GRID pixels, `calc(current, previous)` mapping current ->
 * previous (DIS convention). The seam a native DIS or NVOFA backend slots into.
 */
export interface FlowBackend {
  /**
   * `sequenceStart` is true when `previous` does not follow the frames of the last calc (the first calc, or the
   * first after a scene cut or forced reset), so a backend that carries state from call to call drops it.
   */
  calc(current: Float32Array, previous: Float32Array, w: number, h: number, sequenceStart: boolean): Float32Array;
  /** Release any native resources (GPU backends); optional for pure backends. */
  close?(): void;
}
