import { useEffect, useState } from "react";

const TICK_MS = 1000;

/** Current time, refreshed every second while `active` (drives elapsed-time counters). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}
