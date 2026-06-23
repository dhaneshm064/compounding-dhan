-- Database schema for comments and likes.
-- Apply with:
--   npx wrangler d1 execute blog-db --local --file=./schema.sql   (local dev)
--   npx wrangler d1 execute blog-db --remote --file=./schema.sql  (production)

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug   TEXT NOT NULL,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_slug, created_at);

CREATE TABLE IF NOT EXISTS likes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug   TEXT NOT NULL,
  visitor_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  -- One like per visitor per post. Lets INSERT OR IGNORE / DELETE act as a toggle.
  UNIQUE (post_slug, visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_post ON likes (post_slug);
