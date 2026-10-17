import { useEffect, useState } from "react";
import type { MediaInfo } from "../../../src/server/api-types";
import { api } from "../api";
import { errorMessage } from "../errors";

/** How long typing must pause before the path is read, so a path typed out costs one request, not one per key. */
const SETTLE_MS = 400;

export interface MediaState {
  /** The trimmed path this state describes; empty while there is none. */
  path: string;
  info: MediaInfo | null;
  error: string | null;
  loading: boolean;
}

const NO_MEDIA: MediaState = { path: "", info: null, error: null, loading: false };

/** What GET /api/media says about the file at `path`, read once typing has paused there. */
export function useMediaInfo(path: string): MediaState {
  const trimmed = path.trim();
  const [state, setState] = useState<MediaState>(NO_MEDIA);

  useEffect(() => {
    if (trimmed === "") {
      setState(NO_MEDIA);
      return;
    }
    let active = true;
    setState({ path: trimmed, info: null, error: null, loading: true });
    const timer = setTimeout(() => {
      api.media(trimmed).then(
        (info) => active && setState({ path: trimmed, info, error: null, loading: false }),
        (err: unknown) => active && setState({ path: trimmed, info: null, error: errorMessage(err), loading: false }),
      );
    }, SETTLE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [trimmed]);

  return state;
}
