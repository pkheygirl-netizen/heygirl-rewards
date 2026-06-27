import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["app/**/*.test.{ts,tsx}"],
    globals: false,
    env: {
      SUPABASE_URL: "https://zobnrlgfxlbuwlahwngn.supabase.co",
      SUPABASE_SERVICE_KEY: "test-key-placeholder",
    },
  },
});
