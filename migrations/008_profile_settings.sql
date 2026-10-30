-- Blobs are separate from users so lightweight /me polling never loads them.
CREATE TABLE IF NOT EXISTS user_profile_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  phone text NOT NULL DEFAULT '' CHECK (length(phone)<=30),
  address text NOT NULL DEFAULT '' CHECK (length(address)<=500),
  avatar_base64 text CHECK (length(avatar_base64)<=409600),
  font_scale double precision NOT NULL DEFAULT 1 CHECK (font_scale BETWEEN 0.8 AND 1.6),
  text_color text NOT NULL DEFAULT '#402D37' CHECK (length(text_color)=7),
  primary_color text NOT NULL DEFAULT '#AA496C' CHECK (length(primary_color)=7),
  background_base64 text CHECK (length(background_base64)<=887468)
);
CREATE TABLE IF NOT EXISTS email_change_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  old_email text NOT NULL,
  new_email text NOT NULL,
  old_code_hash text NOT NULL,
  new_code_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification','pending_approval','approved','rejected','invalidated','expired')),
  delivery_confirmed boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL,
  otp_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS email_change_requests_user_created ON email_change_requests(user_id,created_at);
CREATE INDEX IF NOT EXISTS email_change_requests_pending ON email_change_requests(status,expires_at);
