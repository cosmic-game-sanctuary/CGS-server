-- Split out of 0008_faulty_vin_gonzales.sql. That file adds 'buying' and
-- 'underfunded' to agent_status via ALTER TYPE ADD VALUE; Postgres will not
-- let a transaction use a value it added itself, and drizzle wraps a
-- migration file in one transaction. On dev this file's original version
-- was applied by hand around the restriction, without ever fixing the SQL
-- on disk. Replaying the whole history against an empty database — which
-- incremental deploys never did before — hit it for the first time.
--
-- One live agent per person per game. Partial, so cancelling or firing
-- frees the buyer to set a new watch on the same game later.
CREATE UNIQUE INDEX IF NOT EXISTS "wishlist_agents_one_live_per_game"
  ON "wishlist_agents" ("buyer_user_id", "target_game_id")
  WHERE "status" IN ('draft','funded','watching','buying','underfunded');
