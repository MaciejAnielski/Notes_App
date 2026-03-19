-- Notes App: Supabase database schema for PowerSync integration
-- Run this in the Supabase Dashboard SQL Editor.

CREATE TABLE notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  deleted BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_notes_user_name ON notes(user_id, name) WHERE NOT deleted;

CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_attachments_user_note_file ON attachments(user_id, note_name, filename);

-- Row Level Security
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_notes" ON notes FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own_attachments" ON attachments FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- PowerSync publication
CREATE PUBLICATION powersync FOR TABLE notes, attachments;
