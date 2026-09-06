import { createContext, useContext, useEffect, useState } from "react";

export type Theme = "dark" | "light";

/**
 * Chart (Recharts) colors per theme. Charts render SVG, whose `stroke`/`fill`
 * presentation attributes do NOT resolve CSS `var()`, so chart colors can't
 * come from CSS variables the way the rest of the UI does — they live here and
 * must be kept in sync with the palettes in styles.css.
 */
export interface ChartColors {
  grid: string;
  axis: string;
  tooltipBg: string;
  tooltipBorder: string;
  accent: string;
  accent2: string;
  green: string;
  amber: string;
  red: string;
  text: string;
}

const DARK: ChartColors = {
  grid: "#253451", axis: "#93a3bd", tooltipBg: "#16223a", tooltipBorder: "#253451",
  accent: "#4f9dff", accent2: "#7c5cff", green: "#35c88a", amber: "#ffb454", red: "#ff6b6b", text: "#e8eef8",
};
const LIGHT: ChartColors = {
  grid: "#e4e9f2", axis: "#64748b", tooltipBg: "#ffffff", tooltipBorder: "#d9e1ee",
  accent: "#2f6fed", accent2: "#6d44e0", green: "#0f9d68", amber: "#c77d18", red: "#e0413f", text: "#1a2333",
};

const STORAGE_KEY = "rb-theme";

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage may be unavailable (private mode) — fall through */
  }
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

interface ThemeCtx {
  theme: Theme;
  toggle: () => void;
}
const Ctx = createContext<ThemeCtx>({ theme: "dark", toggle: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore persistence failures */
    }
  }, [theme]);

  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

/** Palette for Recharts, reactive to the current theme. */
export function useChartColors(): ChartColors {
  const { theme } = useTheme();
  return theme === "light" ? LIGHT : DARK;
}
