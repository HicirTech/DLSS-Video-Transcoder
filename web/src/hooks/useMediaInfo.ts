import { useEffect, useState } from "react";
import type { MediaInfo } from "../../../src/server/api-types";
import { api } from "../api";
import { errorMessage } from "../errors";

/** How long typing must pause before the path is read, so a path typed out costs one request, not one per key. */
const SETTLE_MS = 400;

/** What GET /api/media has said about the typed path: nothing yet without a path, then loading, then its answer. */
export type MediaState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; info: MediaInfo }
  | { status: "failed"; error: string };

const NO_MEDIA: MediaState = { status: "none" };

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
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      api.media(trimmed).then(
        (info) => active && setState({ status: "ready", info }),
        (err: unknown) => active && setState({ status: "failed", error: errorMessage(err) }),
      );
    }, SETTLE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [trimmed]);

  return state;
}
