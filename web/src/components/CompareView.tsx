import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Alert, Box, Chip, Typography } from "@mui/material";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";

interface CompareViewProps {
  beforeSrc: string;
  afterSrc: string;
  beforeLabel?: string;
  afterLabel?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Before/after image comparison with a draggable vertical split (pointer or arrow keys). */
export function CompareView({ beforeSrc, afterSrc, beforeLabel = "Before", afterLabel = "After" }: CompareViewProps) {
  const [position, setPosition] = useState(50);
  const [failed, setFailed] = useState<string[]>([]);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const moveTo = (clientX: number): void => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setPosition(clamp(((clientX - rect.left) / rect.width) * 100, 0, 100));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    moveTo(event.clientX);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragging.current) moveTo(event.clientX);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowLeft") setPosition((current) => clamp(current - step, 0, 100));
    else if (event.key === "ArrowRight") setPosition((current) => clamp(current + step, 0, 100));
    else if (event.key === "Home") setPosition(0);
    else if (event.key === "End") setPosition(100);
    else return;
    event.preventDefault();
  };

  const markFailed = (label: string): void => {
    setFailed((current) => (current.includes(label) ? current : [...current, label]));
  };

  return (
    <Box>
      {failed.length > 0 ? (
        <Alert severity="warning" sx={{ mb: 1 }}>
          Could not load the {failed.join(" and ")} preview. The file path must be readable by the server.
        </Alert>
      ) : null}
      <Box
        ref={frameRef}
        role="slider"
        aria-label="Before / after split"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        sx={{
          position: "relative",
          overflow: "hidden",
          borderRadius: 1,
          bgcolor: "#000",
          lineHeight: 0,
          userSelect: "none",
          touchAction: "none",
          cursor: "col-resize",
          outline: "none",
          "&:focus-visible": { boxShadow: (theme) => `0 0 0 2px ${theme.palette.primary.main}` },
        }}
      >
        <img
          src={afterSrc}
          alt={afterLabel}
          draggable={false}
          onError={() => markFailed(afterLabel.toLowerCase())}
          style={{ width: "100%", display: "block" }}
        />
        <img
          src={beforeSrc}
          alt={beforeLabel}
          draggable={false}
          onError={() => markFailed(beforeLabel.toLowerCase())}
          style={{
            // Same sizing model as the base image (width:100%, natural height,
            // anchored top-left) so the two overlap exactly and the split line
            // lands on the same content column in both.
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "auto",
            display: "block",
            clipPath: `inset(0 ${100 - position}% 0 0)`,
          }}
        />
        <Box
          sx={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${position}%`,
            width: 2,
            ml: "-1px",
            bgcolor: "#fff",
            boxShadow: "0 0 4px rgba(0,0,0,0.8)",
            pointerEvents: "none",
          }}
        />
        <Box
          sx={{
            position: "absolute",
            top: "50%",
            left: `${position}%`,
            width: 32,
            height: 32,
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            bgcolor: "#fff",
            color: "#111",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 0 6px rgba(0,0,0,0.8)",
            pointerEvents: "none",
          }}
        >
          <SwapHorizIcon fontSize="small" />
        </Box>
        <Chip label={beforeLabel} sx={{ position: "absolute", top: 8, left: 8, bgcolor: "rgba(0,0,0,0.6)" }} />
        <Chip label={afterLabel} sx={{ position: "absolute", top: 8, right: 8, bgcolor: "rgba(0,0,0,0.6)" }} />
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
        Drag the divider or use the arrow keys. {Math.round(position)}% of the width shows the original.
      </Typography>
    </Box>
  );
}
