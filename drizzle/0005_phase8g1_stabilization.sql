ALTER TABLE "autopilot_settings"
  ADD COLUMN IF NOT EXISTS "target_metric" text NOT NULL DEFAULT 'qualified';

UPDATE "autopilot_settings"
SET "target_metric" = 'qualified'
WHERE "target_metric" IS NULL;

ALTER TABLE "autopilot_settings"
  ADD CONSTRAINT "autopilot_settings_target_metric_check"
  CHECK ("target_metric" IN ('qualified', 'analyzed_qualified', 'outreach_ready'));
