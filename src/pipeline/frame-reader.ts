/**
 * Reassembles exact-size frames from a byte stream that arrives in arbitrary
 * chunks (an ffmpeg rawvideo pipe hands us whatever the OS buffered). Pure: no
 * FFI, so it is safe to import from a Worker thread.
 */
export class FrameReader {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>) {
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
    const frame = new Uint8Array(frameBytes);
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
