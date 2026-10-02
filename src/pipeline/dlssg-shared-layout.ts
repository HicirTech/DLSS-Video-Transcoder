/**
 * Where the pixels of a frame sit in the shared mapping that the DLSS Frame Generation parent (dlssg.ts)
 * and its host (dlssg-serve.ts) both map: the real frame and its motion field going in, the generated
 * frames coming out. Pure arithmetic on the setup's size, so both sides derive the same offsets and
 * nothing about the layout is sent.
 */
import { motionFieldBytes, rgbaFrameBytes, type DlssgSetup } from "./dlssg-protocol.ts";

/**
 * Slots in the mapping, each an input half and an output half. The parent waits for a frame's reply
 * before it sends the next, so one slot is all that is ever in flight; double buffering raises this,
 * puts a slot number in the frame header and offsets every range below by slot * the slot's size.
 */
const SLOT_COUNT = 1;

export interface ByteRange {
  readonly offset: number;
  readonly byteLength: number;
}

export interface SharedFrameLayout {
  /** The real frame's RGBA8 pixels, written by the parent before it sends the frame header. */
  readonly rgba: ByteRange;
  /** Its R16G16_FLOAT motion field, directly behind the pixels. */
  readonly motion: ByteRange;
  /** One range per generated frame, RGBA8 each, in presentation order behind the input; the host writes them before it sends the result. */
  readonly generated: readonly ByteRange[];
  /** The size both sides create or open the mapping with. */
  readonly totalBytes: number;
}

export function sharedFrameLayout({ width, height, generatedCount }: Pick<DlssgSetup, "width" | "height" | "generatedCount">): SharedFrameLayout {
  for (const count of [width, height, generatedCount]) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Shared frame memory needs a whole width, height and generatedCount of at least 1; got width ${width}, height ${height}, generatedCount ${generatedCount}`);
    }
  }
  const frameBytes = rgbaFrameBytes(width, height);
  const rgba = { offset: 0, byteLength: frameBytes };
  const motion = { offset: rgba.byteLength, byteLength: motionFieldBytes(width, height) };
  const inputBytes = motion.offset + motion.byteLength;
  const generated = Array.from({ length: generatedCount }, (_, index) => ({ offset: inputBytes + index * frameBytes, byteLength: frameBytes }));
  return { rgba, motion, generated, totalBytes: SLOT_COUNT * (inputBytes + generatedCount * frameBytes) };
}

/** The bytes of `range` in the mapped `bytes`, as a view that shares their memory. */
export function viewRange(bytes: Uint8Array, range: ByteRange): Uint8Array {
  return bytes.subarray(range.offset, range.offset + range.byteLength);
}
