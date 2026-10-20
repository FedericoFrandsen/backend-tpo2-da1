ALTER TABLE `offers` ADD `message` text;--> statement-breakpoint
ALTER TABLE `offers` ADD `counter_amount_cents` integer;--> statement-breakpoint
-- Las filas ya existentes (si las hay) no tienen un vencimiento real: se les asigna "ahora" como
-- valor temporal, así el barrido de ofertas vencidas (expireStaleOffers) las marca "expired" en
-- la próxima lectura en lugar de dejar la columna en NULL.
ALTER TABLE `offers` ADD `expires_at` text NOT NULL DEFAULT (datetime('now'));--> statement-breakpoint
ALTER TABLE `publications` ADD `address` text;--> statement-breakpoint
ALTER TABLE `publications` ADD `latitude` real;--> statement-breakpoint
ALTER TABLE `publications` ADD `longitude` real;--> statement-breakpoint
ALTER TABLE `users` ADD `avatar_url` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_offers` (
	`id` text PRIMARY KEY,
	`publication_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`message` text,
	`counter_amount_cents` integer,
	`status` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_offers_publication_id_publications_id_fk` FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_offers_buyer_id_users_id_fk` FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT "offer_status_check" CHECK("status" IN ('pending', 'countered', 'accepted', 'rejected', 'expired', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_offers`(`id`, `publication_id`, `buyer_id`, `amount_cents`, `message`, `counter_amount_cents`, `status`, `expires_at`, `created_at`, `updated_at`) SELECT `id`, `publication_id`, `buyer_id`, `amount_cents`, `message`, `counter_amount_cents`, `status`, `expires_at`, `created_at`, `updated_at` FROM `offers`;--> statement-breakpoint
DROP TABLE `offers`;--> statement-breakpoint
ALTER TABLE `__new_offers` RENAME TO `offers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;