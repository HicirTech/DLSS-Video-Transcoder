import { createTheme } from "@mui/material/styles";

/** Dark, compact theme: every control defaults to its small size. */
export const appTheme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#8fd14f" },
    secondary: { main: "#5ac8fa" },
    background: { default: "#0f1216", paper: "#171b22" },
  },
  shape: { borderRadius: 6 },
  typography: {
    fontSize: 13,
    fontFamily: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  components: {
    MuiButton: { defaultProps: { size: "small", disableElevation: true } },
    MuiIconButton: { defaultProps: { size: "small" } },
    MuiTextField: { defaultProps: { size: "small" } },
    MuiFormControl: { defaultProps: { size: "small" } },
    MuiChip: { defaultProps: { size: "small" } },
    MuiTable: { defaultProps: { size: "small" } },
    MuiSlider: { defaultProps: { size: "small" } },
    MuiSwitch: { defaultProps: { size: "small" } },
    MuiTooltip: { defaultProps: { arrow: true } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
  },
});
