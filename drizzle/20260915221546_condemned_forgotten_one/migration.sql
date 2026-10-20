PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_publications` (
	`id` text PRIMARY KEY,
	`seller_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`price_cents` integer NOT NULL,
	`item_condition` text NOT NULL,
	`zone` text NOT NULL,
	`address` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`status` text NOT NULL,
	`published_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_publications_seller_id_users_id_fk` FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "publication_condition_check" CHECK("item_condition" IN ('new', 'like_new', 'used')),
	CONSTRAINT "publication_status_check" CHECK("status" IN ('active', 'paused', 'sold'))
);
--> statement-breakpoint
INSERT INTO `__new_publications`(`id`, `seller_id`, `title`, `description`, `category`, `price_cents`, `item_condition`, `zone`, `address`, `latitude`, `longitude`, `status`, `published_at`, `created_at`, `updated_at`) SELECT `id`, `seller_id`, `title`, `description`, `category`, `price_cents`, `item_condition`, `zone`, `address`, `latitude`, `longitude`, `status`, `published_at`, `created_at`, `updated_at` FROM `publications`;--> statement-breakpoint
DROP TABLE `publications`;--> statement-breakpoint
ALTER TABLE `__new_publications` RENAME TO `publications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_publications_feed` ON `publications` (`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_publications_seller` ON `publications` (`seller_id`,`status`);