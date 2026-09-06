import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// RetirementBuddy is a fully client-side app — there is no backend. All data
// lives in the browser (IndexedDB) and every calculation runs in TypeScript,
// so this can be built to static files and hosted anywhere (or opened locally).
export default defineConfig({
  plugins: [react()],
  base: "./", // relative asset paths so it works from any subpath or file host
  server: {
    host: true,
    port: 5173,
  },
});
