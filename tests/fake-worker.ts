/**
 * A Worker stand-in for tests: records what it was sent and lets the test
 * answer as the real worker would, through onmessage and every "message" or
 * "error" listener. Replies are delivered synchronously, and not at all once
 * the worker is terminated, as with a real one.
 */
export class FakeWorker {
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  addEventListener(type: string, listener: (event: Event) => void, options?: { once?: boolean }): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    const set = this.listeners.get(type)!;
    if (!options?.once) {
      set.add(listener);
      return;
    }
    const onceListener = (event: Event): void => {
      set.delete(onceListener);
      listener(event);
    };
    set.add(onceListener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** What the real worker would post back. */
  reply(data: unknown): void {
    if (this.terminated) return;
    const event = { data } as MessageEvent;
    this.onmessage?.(event);
    for (const listener of [...(this.listeners.get("message") ?? [])]) listener(event);
  }

  /** An uncaught error inside the worker. */
  crash(message: string): void {
    if (this.terminated) return;
    const event = { message } as ErrorEvent;
    this.onerror?.(event);
    for (const listener of [...(this.listeners.get("error") ?? [])]) listener(event);
  }

  /** Messages of one type, in the order they were sent. */
  sentOfType(type: string): unknown[] {
    return this.sent.filter((message) => (message as { type?: string }).type === type);
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

/** A stand-in whose thread cannot take a message: postMessage throws, as it does for a message that cannot be cloned. */
export class RefusingWorker extends FakeWorker {
  override postMessage(): void {
    throw new Error("DataCloneError: the message could not be cloned");
  }
}
