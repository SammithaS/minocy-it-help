ALTER TABLE `notifications` ADD `kind` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `transport` text DEFAULT 'log' NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `html` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `text` text;