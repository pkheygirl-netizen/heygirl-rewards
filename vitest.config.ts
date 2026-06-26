import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
    globals: false,
    env: {
      SUPABASE_URL: "https://zobnrlgfxlbuwlahwngn.supabase.co",
      SUPABASE_SERVICE_KEY: "test-key-placeholder",
    },
  },
});
