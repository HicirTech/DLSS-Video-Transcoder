/**
 * The mux ffmpeg the two NVENC encode workers write their elementary stream into (pipe:0): started with its stderr
 * drained for the whole run, fed packet by packet, and closed with its exit code and what it printed.
 */
import { ffmpegFailedMessage } from "./ffmpeg-failure.ts";

/**
 * How long a write that broke the pipe waits for ffmpeg to exit on its own, so its exit code and message are what
 * the job reports. A chosen margin, as video.ts's ENCODER_QUIT_WAIT_MS: ffmpeg prints why it stopped and exits at once.
 */
const MUX_QUIT_WAIT_MS = 2000;

export class MuxSink {
  private stderrText = "";
  private readonly stderrDrained: Promise<void>;

  private constructor(readonly child: ReturnType<typeof Bun.spawn>) {
    // Drained for the whole run, so ffmpeg can never block on a full pipe and its message is there when it fails.
    this.stderrDrained = new Response(child.stderr as ReadableStream<Uint8Array>).text().then((text) => { this.stderrText = text; }).catch(() => {});
  }

  /** Starts ffmpeg with `args`, which read the elementary stream on pipe:0. */
  static spawn(ffmpeg: string, args: string[]): MuxSink {
    return new MuxSink(Bun.spawn([ffmpeg, ...args], { stdin: "pipe", stdout: "ignore", stderr: "pipe" }));
  }

  async write(bytes: Uint8Array): Promise<void> {
    const written = (this.child.stdin as { write(b: Uint8Array): unknown }).write(bytes);
    if (written instanceof Promise) await written;
  }

  /** Ends ffmpeg's input and waits for it to exit: its exit code and what it printed. */
  async close(): Promise<{ code: number; stderr: string }> {
    (this.child.stdin as { end(): unknown }).end();
    await this.stderrDrained;
    return { code: await this.child.exited, stderr: this.stderrText.trim() };
  }

  /**
   * What a failed step reports. A write that broke the pipe (EPIPE) says nothing of why, so ffmpeg is given
   * MUX_QUIT_WAIT_MS to exit, and its own failure is reported when it does; any other error is reported as it is.
   */
  async failureOf(error: unknown): Promise<string> {
    if ((error as { code?: unknown }).code === "EPIPE") {
      const code = await Promise.race([this.child.exited, Bun.sleep(MUX_QUIT_WAIT_MS).then(() => null)]);
      if (code !== null && code !== 0) {
        await this.stderrDrained;
        return ffmpegFailedMessage("mux", code, this.stderrText);
      }
    }
    return (error as Error).message ?? String(error);
  }
}
