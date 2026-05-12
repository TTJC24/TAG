CREATE TYPE "public"."cadence" AS ENUM('weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."entry_source" AS ENUM('manual', 'voice', 'fireflies', 'teams_native', 'transcript_manual', 'system');--> statement-breakpoint
CREATE TYPE "public"."goal_direction" AS ENUM('gte', 'lte', 'eq', 'between', 'trend_down', 'trend_up');--> statement-breakpoint
CREATE TYPE "public"."issue_priority" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('open', 'ids_in_progress', 'resolved', 'tabled');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('scheduled', 'live', 'concluded');--> statement-breakpoint
CREATE TYPE "public"."note_classification" AS ENUM('explained_one_off', 'structural_issue', 'on_plan_to_recover', 'no_context');--> statement-breakpoint
CREATE TYPE "public"."person_role" AS ENUM('admin', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."rock_status" AS ENUM('on_track', 'off_track', 'completed');--> statement-breakpoint
CREATE TYPE "public"."status_color" AS ENUM('green', 'yellow', 'red');--> statement-breakpoint
CREATE TYPE "public"."todo_status" AS ENUM('open', 'done', 'rolled_over', 'dropped');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"person_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"source" "entry_source" NOT NULL,
	"attributed_to_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"measurable_id" uuid NOT NULL,
	"week_id" uuid NOT NULL,
	"actual" numeric(18, 6),
	"note" text,
	"status_override" "status_color",
	"note_classification" "note_classification",
	"confidence" numeric(5, 4),
	"source" "entry_source" DEFAULT 'manual' NOT NULL,
	"entered_by_person_id" uuid,
	"attributed_to_person_id" uuid,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"priority" "issue_priority" DEFAULT 'medium' NOT NULL,
	"owner_id" uuid NOT NULL,
	"root_cause" text,
	"resolution" text,
	"status" "issue_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "measurables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"unit" text,
	"format_hint" text,
	"goal_direction" "goal_direction" NOT NULL,
	"goal_value" numeric(18, 6),
	"goal_secondary" numeric(18, 6),
	"cadence" "cadence" DEFAULT 'weekly' NOT NULL,
	"formula" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"present" boolean DEFAULT false NOT NULL,
	"rating" integer
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"facilitator_id" uuid NOT NULL,
	"scribe_id" uuid,
	"meeting_number" integer,
	"quarter" text NOT NULL,
	"status" "meeting_status" DEFAULT 'scheduled' NOT NULL,
	"rating" numeric(3, 1),
	"notes" text,
	"cascading_messages" text,
	"liveblocks_room_id" text,
	"linked_teams_meeting_id" text,
	"started_at" timestamp with time zone,
	"concluded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_org_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"avatar_url" text,
	"default_org_id" uuid,
	"role" "person_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"description" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"quarter" text NOT NULL,
	"due_date" date,
	"status" "rock_status" DEFAULT 'on_track' NOT NULL,
	"status_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"description" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"due_date" date,
	"status" "todo_status" DEFAULT 'open' NOT NULL,
	"rollover_count" integer DEFAULT 0 NOT NULL,
	"parent_todo_id" uuid,
	"created_in_meeting_id" uuid,
	"completed_in_meeting_id" uuid,
	"parent_issue_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"source" "entry_source" NOT NULL,
	"raw_text" text NOT NULL,
	"utterances" jsonb,
	"duration_sec" integer,
	"summary" text,
	"extracted_json" jsonb,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "week_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"week_id" uuid NOT NULL,
	"taken_by_person_id" uuid,
	"payload" jsonb NOT NULL,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_ending_date" date NOT NULL,
	"week_number" integer NOT NULL,
	"quarter" text NOT NULL,
	"fiscal_year" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_attributed_to_person_id_people_id_fk" FOREIGN KEY ("attributed_to_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_measurable_id_measurables_id_fk" FOREIGN KEY ("measurable_id") REFERENCES "public"."measurables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_week_id_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."weeks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_entered_by_person_id_people_id_fk" FOREIGN KEY ("entered_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_attributed_to_person_id_people_id_fk" FOREIGN KEY ("attributed_to_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_owner_id_people_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurables" ADD CONSTRAINT "measurables_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurables" ADD CONSTRAINT "measurables_owner_id_people_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_facilitator_id_people_id_fk" FOREIGN KEY ("facilitator_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_scribe_id_people_id_fk" FOREIGN KEY ("scribe_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_default_org_id_organizations_id_fk" FOREIGN KEY ("default_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rocks" ADD CONSTRAINT "rocks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rocks" ADD CONSTRAINT "rocks_owner_id_people_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_owner_id_people_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_parent_todo_id_todos_id_fk" FOREIGN KEY ("parent_todo_id") REFERENCES "public"."todos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_created_in_meeting_id_meetings_id_fk" FOREIGN KEY ("created_in_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_completed_in_meeting_id_meetings_id_fk" FOREIGN KEY ("completed_in_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_snapshots" ADD CONSTRAINT "week_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_snapshots" ADD CONSTRAINT "week_snapshots_week_id_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."weeks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_snapshots" ADD CONSTRAINT "week_snapshots_taken_by_person_id_people_id_fk" FOREIGN KEY ("taken_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_idx" ON "audit_log" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_person_idx" ON "audit_log" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "entries_measurable_week_unique" ON "entries" USING btree ("measurable_id","week_id");--> statement-breakpoint
CREATE INDEX "entries_week_idx" ON "entries" USING btree ("week_id");--> statement-breakpoint
CREATE INDEX "entries_entered_by_idx" ON "entries" USING btree ("entered_by_person_id");--> statement-breakpoint
CREATE INDEX "issues_org_idx" ON "issues" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "issues_owner_idx" ON "issues" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "issues_org_status_idx" ON "issues" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "measurables_org_idx" ON "measurables" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "measurables_owner_idx" ON "measurables" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "measurables_org_display_order_idx" ON "measurables" USING btree ("org_id","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendees_meeting_person_unique" ON "meeting_attendees" USING btree ("meeting_id","person_id");--> statement-breakpoint
CREATE INDEX "meeting_attendees_meeting_idx" ON "meeting_attendees" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "meetings_org_idx" ON "meetings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "meetings_org_scheduled_idx" ON "meetings" USING btree ("org_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_liveblocks_room_id_unique" ON "meetings" USING btree ("liveblocks_room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_linked_teams_meeting_id_unique" ON "meetings" USING btree ("linked_teams_meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_clerk_org_id_unique" ON "organizations" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_code_unique" ON "organizations" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "people_clerk_user_id_unique" ON "people" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "people_email_idx" ON "people" USING btree ("email");--> statement-breakpoint
CREATE INDEX "rocks_org_idx" ON "rocks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "rocks_owner_idx" ON "rocks" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "rocks_org_quarter_idx" ON "rocks" USING btree ("org_id","quarter");--> statement-breakpoint
CREATE INDEX "todos_org_idx" ON "todos" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "todos_owner_idx" ON "todos" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "todos_org_status_idx" ON "todos" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "todos_parent_issue_idx" ON "todos" USING btree ("parent_issue_id");--> statement-breakpoint
CREATE INDEX "transcripts_meeting_idx" ON "transcripts" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "week_snapshots_org_week_idx" ON "week_snapshots" USING btree ("org_id","week_id");--> statement-breakpoint
CREATE INDEX "week_snapshots_org_week_snapshot_at_idx" ON "week_snapshots" USING btree ("org_id","week_id","snapshot_at");--> statement-breakpoint
CREATE UNIQUE INDEX "weeks_week_ending_date_unique" ON "weeks" USING btree ("week_ending_date");