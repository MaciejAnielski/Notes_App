-- E2E Encryption: Device Pairing with Key Exchange
-- Run this in the Supabase Dashboard SQL Editor after the base schema.

-- ── Device pairing relay ────────────────────────────────────────────────
-- Temporary rows used during the ECDH key exchange ceremony.
-- Each row lives for at most 10 minutes. A cron job or Edge Function
-- should periodically DELETE FROM device_pairing WHERE expires_at < now().

CREATE TABLE device_pairing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pairing_code_hash TEXT NOT NULL,
  initiator_ecdh_public TEXT NOT NULL,
  joiner_ecdh_public TEXT,
  encrypted_master_key TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',  -- waiting | accepted | completed | consumed | expired
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes')
);

ALTER TABLE device_pairing ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_pairing" ON device_pairing FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE device_pairing TO authenticated;

-- ── User encryption metadata ────────────────────────────────────────────
-- One row per user. Existence indicates encryption is enabled for this account.

CREATE TABLE user_encryption (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encryption_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_encryption ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_encryption" ON user_encryption FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_encryption TO authenticated;

-- ── Device registry ─────────────────────────────────────────────────────
-- Tracks which devices have been paired for a user (informational).

CREATE TABLE user_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_id)
);

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_devices" ON user_devices FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_devices TO authenticated;

-- NOTE: These tables should NOT be added to the PowerSync publication.
-- They are accessed via direct Supabase REST calls only (online operations).
-- The pairing ceremony requires both devices to be online simultaneously.
