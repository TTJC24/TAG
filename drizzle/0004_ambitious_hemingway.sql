CREATE TYPE "public"."day_of_week" AS ENUM('sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday');--> statement-breakpoint
DROP INDEX "weeks_week_ending_date_unique";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "week_ends_on" "day_of_week";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "meeting_day" "day_of_week";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "entry_cutoff_day" "day_of_week";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "entry_cutoff_time" text;--> statement-breakpoint
ALTER TABLE "weeks" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "weeks" ADD CONSTRAINT "weeks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "weeks_org_week_ending_date_unique" ON "weeks" USING btree ("org_id","week_ending_date");--> statement-breakpoint
CREATE INDEX "weeks_org_idx" ON "weeks" USING btree ("org_id");