/**
 * Reassembles exact-size frames from a byte stream that arrives in arbitrary
 * chunks (an ffmpeg rawvideo pipe hands us whatever the OS buffered). Pure: no
 * FFI, so it is safe to import from a Worker thread.
 */
export class FrameReader {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  /**
   * `shared` allocates each frame in a SharedArrayBuffer so it can be handed to
   * Worker threads (structured clone shares the memory) while this thread keeps
   * using it — no copy per consumer.
   */
  constructor(stream: ReadableStream<Uint8Array>, private readonly shared = false) {
    this.reader = stream.getReader();
  }

  /** Next `frameBytes`-sized frame (a freshly allocated buffer), or null at EOF. */
  async next(frameBytes: number): Promise<Uint8Array | null> {
    while (this.pendingBytes < frameBytes) {
      const { value, done } = await this.reader.read();
      if (done) break;
      if (value && value.byteLength) {
        this.pending.push(value);
        this.pendingBytes += value.byteLength;
      }
    }
    if (this.pendingBytes < frameBytes) return null;
    const frame = this.shared ? new Uint8Array(new SharedArrayBuffer(frameBytes)) : new Uint8Array(frameBytes);
    let filled = 0;
    while (filled < frameBytes) {
      const chunk = this.pending[0]!;
      const take = Math.min(chunk.byteLength, frameBytes - filled);
      frame.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.byteLength) this.pending.shift();
      else this.pending[0] = chunk.subarray(take);
    }
    this.pendingBytes -= frameBytes;
    return frame;
  }
}
