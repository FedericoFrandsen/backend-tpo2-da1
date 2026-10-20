CREATE TABLE `favorites` (
	`user_id` text NOT NULL,
	`publication_id` text NOT NULL,
	`saved_price_cents` integer,
	`has_update` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `favorites_pk` PRIMARY KEY(`user_id`, `publication_id`),
	CONSTRAINT `fk_favorites_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_favorites_publication_id_publications_id_fk` FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `offers` (
	`id` text PRIMARY KEY,
	`publication_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_offers_publication_id_publications_id_fk` FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_offers_buyer_id_users_id_fk` FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "offer_status_check" CHECK("status" IN ('pending', 'accepted', 'rejected', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY,
	`publication_id` text NOT NULL UNIQUE,
	`offer_id` text NOT NULL UNIQUE,
	`buyer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`completed_at` text NOT NULL,
	CONSTRAINT `fk_operations_publication_id_publications_id_fk` FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`),
	CONSTRAINT `fk_operations_offer_id_offers_id_fk` FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`),
	CONSTRAINT `fk_operations_buyer_id_users_id_fk` FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_operations_seller_id_users_id_fk` FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `otp_codes` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL,
	`purpose` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text NOT NULL,
	CONSTRAINT "otp_purpose_check" CHECK("purpose" IN ('registration', 'login'))
);
--> statement-breakpoint
CREATE TABLE `publication_images` (
	`id` text PRIMARY KEY,
	`publication_id` text NOT NULL,
	`url` text NOT NULL,
	`position` integer NOT NULL,
	CONSTRAINT `fk_publication_images_publication_id_publications_id_fk` FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `publications` (
	`id` text PRIMARY KEY,
	`seller_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category` text,
	`price_cents` integer,
	`item_condition` text,
	`zone` text,
	`status` text NOT NULL,
	`draft_step` integer DEFAULT 1 NOT NULL,
	`published_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_publications_seller_id_users_id_fk` FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "publication_condition_check" CHECK("item_condition" IS NULL OR "item_condition" IN ('new', 'like_new', 'used')),
	CONSTRAINT "publication_status_check" CHECK("status" IN ('draft', 'active', 'paused', 'sold'))
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY,
	`publication_id` text NOT NULL,
	`asker_id` text NOT NULL,
	`text` text NOT NULL,
	`answer` text,
	`created_at` text NOT NULL,
	`answered_at` text,
	CONSTRAINT `fk_questions_publication_id_publications_id_fk` FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_questions_asker_id_users_id_fk` FOREIGN KEY (`asker_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY,
	`operation_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`reviewed_user_id` text NOT NULL,
	`rating` integer NOT NULL,
	`comment` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_reviews_operation_id_operations_id_fk` FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_reviews_reviewer_id_users_id_fk` FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_reviews_reviewed_user_id_users_id_fk` FOREIGN KEY (`reviewed_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "review_rating_check" CHECK("rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE `saved_searches` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`query_text` text,
	`category` text,
	`min_price_cents` integer,
	`max_price_cents` integer,
	`item_condition` text,
	`zone` text,
	`sort` text DEFAULT 'recent' NOT NULL,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`last_checked_at` text NOT NULL,
	CONSTRAINT `fk_saved_searches_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL UNIQUE,
	`username` text UNIQUE,
	`password_hash` text,
	`name` text NOT NULL,
	`phone` text,
	`zone` text,
	`created_at` text NOT NULL,
	`email_verified_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_otp_email_purpose` ON `otp_codes` (`email`,`purpose`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `publication_image_position_unique` ON `publication_images` (`publication_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_publications_feed` ON `publications` (`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_publications_seller` ON `publications` (`seller_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_operation_reviewer_unique` ON `reviews` (`operation_id`,`reviewer_id`);--> statement-breakpoint
CREATE INDEX `idx_reviews_reviewed_user` ON `reviews` (`reviewed_user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_token` ON `sessions` (`token_hash`);