CREATE TABLE `kb_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text,
	`article_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`rationale` text NOT NULL,
	`body` text NOT NULL,
	`meta` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`revision_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `kb_proposals_status_idx` ON `kb_proposals` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `kb_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`tags` text NOT NULL,
	`os` text NOT NULL,
	`ticket_category` text NOT NULL,
	`priority` text NOT NULL,
	`action` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`author_id` text,
	`source` text NOT NULL,
	`proposal_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`applied_at` integer
);
--> statement-breakpoint
CREATE INDEX `kb_revisions_article_idx` ON `kb_revisions` (`article_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `kb_articles` ADD `managed_by` text DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `escalation_reason` text;