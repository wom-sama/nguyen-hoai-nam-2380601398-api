-- Server-managed profile version supersedes queued account-update events.
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_version integer NOT NULL DEFAULT 1 CHECK (profile_version > 0);
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_event_type_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_event_type_check CHECK (event_type IN ('shift_assigned','correction_reviewed','handover_submitted','profile_updated'));
