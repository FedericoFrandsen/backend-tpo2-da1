PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_otp_codes` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL,
	`purpose` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text NOT NULL,
	CONSTRAINT "otp_purpose_check" CHECK("purpose" IN ('registration', 'login', 'set_password'))
);
--> statement-breakpoint
INSERT INTO `__new_otp_codes`(`id`, `email`, `purpose`, `code_hash`, `attempts`, `expires_at`, `consumed_at`, `created_at`) SELECT `id`, `email`, `purpose`, `code_hash`, `attempts`, `expires_at`, `consumed_at`, `created_at` FROM `otp_codes`;--> statement-breakpoint
DROP TABLE `otp_codes`;--> statement-breakpoint
ALTER TABLE `__new_otp_codes` RENAME TO `otp_codes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_otp_email_purpose` ON `otp_codes` (`email`,`purpose`,`created_at`);