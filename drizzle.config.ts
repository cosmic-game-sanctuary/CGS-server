import { defineConfig } from "drizzle-kit";
import "dotenv/config"

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Direct (unpooled) connection — PgBouncer's transaction mode, which the
  // pooled string goes through, doesn't support the SET statements migrations need.
  dbCredentials: { url: process.env.DATABASE_URL! },
});
