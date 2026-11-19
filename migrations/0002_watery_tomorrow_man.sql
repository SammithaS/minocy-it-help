CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`ticket_id` text,
	`user_id` text,
	`agent` text NOT NULL,
	`route_method` text NOT NULL,
	`reason` text,
	`status` text NOT NULL,
	`summary` text,
	`error` text,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_runs_agent_idx` ON `agent_runs` (`agent`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_session_idx` ON `agent_runs` (`session_id`);