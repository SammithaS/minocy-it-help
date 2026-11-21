CREATE TABLE `app_grants` (
	`user_id` text NOT NULL,
	`application_id` text NOT NULL,
	`access_request_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `application_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `directory_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`must_change_password` integer DEFAULT false NOT NULL,
	`locked_at` integer,
	`password_changed_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directory_accounts_username_unique` ON `directory_accounts` (`username`);--> statement-breakpoint
CREATE TABLE `password_resets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`code_hash` text NOT NULL,
	`code_expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`verified_at` integer,
	`completed_at` integer,
	`link_used_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `password_resets_user_idx` ON `password_resets` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `access_requests` ADD `number` text;--> statement-breakpoint
ALTER TABLE `access_requests` ADD `approver_id` text;--> statement-breakpoint
ALTER TABLE `access_requests` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `access_requests` ADD `decision_note` text;--> statement-breakpoint
ALTER TABLE `access_requests` ADD `decided_at` integer;--> statement-breakpoint
ALTER TABLE `access_requests` ADD `provisioned_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `access_requests_number` ON `access_requests` (`number`);--> statement-breakpoint
CREATE INDEX `access_requests_requester_idx` ON `access_requests` (`requester_id`);--> statement-breakpoint
ALTER TABLE `applications` ADD `aliases` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `manager_id` text;