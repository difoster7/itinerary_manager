CREATE TABLE versions (
  version    INTEGER PRIMARY KEY,
  blob       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  blob       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
