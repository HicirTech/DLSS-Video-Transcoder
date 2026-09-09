import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Alert, Snackbar } from "@mui/material";

type Severity = "error" | "warning" | "info" | "success";

interface Toast {
  message: string;
  severity: Severity;
}

export interface ToastApi {
  showError(message: string): void;
  showWarning(message: string): void;
  showInfo(message: string): void;
  showSuccess(message: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** One shared Snackbar for the whole app; the newest message replaces the previous one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const [open, setOpen] = useState(false);
  // Bumped on every show; used as the Snackbar key so MUI remounts it and
  // restarts the auto-hide timer even when consecutive toasts share a severity.
  const [seq, setSeq] = useState(0);

  const show = useCallback((message: string, severity: Severity) => {
    setToast({ message, severity });
    setSeq((s) => s + 1);
    setOpen(true);
  }, []);

  const toastApi = useMemo<ToastApi>(
    () => ({
      showError: (message) => show(message, "error"),
      showWarning: (message) => show(message, "warning"),
      showInfo: (message) => show(message, "info"),
      showSuccess: (message) => show(message, "success"),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={toastApi}>
      {children}
      <Snackbar
        key={seq}
        open={open}
        autoHideDuration={toast?.severity === "error" ? 8000 : 4000}
        onClose={(_event, reason) => {
          if (reason !== "clickaway") setOpen(false);
        }}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity={toast?.severity ?? "info"}
          variant="filled"
          onClose={() => setOpen(false)}
          sx={{ width: "100%", maxWidth: 640 }}
        >
          {toast?.message ?? ""}
        </Alert>
      </Snackbar>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const toastApi = useContext(ToastContext);
  if (!toastApi) throw new Error("useToast must be used inside <ToastProvider>");
  return toastApi;
}
