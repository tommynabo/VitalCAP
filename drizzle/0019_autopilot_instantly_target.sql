ALTER TABLE "autopilot_settings"
  DROP CONSTRAINT IF EXISTS "autopilot_settings_target_metric_check";
--> statement-breakpoint
ALTER TABLE "autopilot_settings"
  ADD CONSTRAINT "autopilot_settings_target_metric_check"
  CHECK ("target_metric" IN ('qualified', 'analyzed_qualified', 'outreach_ready', 'instantly_imported'));
