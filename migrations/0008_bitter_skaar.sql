DROP TABLE `directory_accounts`;--> statement-breakpoint
ALTER TABLE `access_requests` ADD `external_username` text;--> statement-breakpoint
ALTER TABLE `access_requests` ADD `provision_detail` text;--> statement-breakpoint
ALTER TABLE `access_requests` ADD `failure_ticket` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `connector` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `connector_config` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `okta_id` text;