import { createClient } from "@supabase/supabase-js";

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!process.env.SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_SERVICE_KEY is required");

// After running migrations, generate types with:
// npx supabase gen types typescript --project-id zobnrlgfxlbuwlahwngn > app/database.types.ts
// Then replace `any` with: import type { Database } from "./database.types";
export const db = createClient<any>(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
