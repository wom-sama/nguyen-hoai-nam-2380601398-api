-- Device-bound proof-of-possession; private biometric keys never reach this DB.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'password_otp'
  CHECK (auth_method IN ('password_otp','face','fingerprint'));
CREATE TABLE IF NOT EXISTS fingerprint_devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  device_id uuid NOT NULL,
  public_key text NOT NULL,
  key_algorithm text NOT NULL CHECK (key_algorithm IN ('rsa-sha256','p256-sha256')),
  device_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  UNIQUE(user_id,device_id)
);
CREATE TABLE IF NOT EXISTS fingerprint_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  device_id uuid NOT NULL,
  payload text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fingerprint_challenges_user_device ON fingerprint_challenges(user_id,device_id);
CREATE INDEX IF NOT EXISTS fingerprint_challenges_expiry ON fingerprint_challenges(expires_at);
