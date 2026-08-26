CREATE TABLE IF NOT EXISTS strava_users (
  session_id TEXT PRIMARY KEY,
  athlete_id INTEGER NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  age INTEGER,
  created_at INTEGER NOT NULL
);
