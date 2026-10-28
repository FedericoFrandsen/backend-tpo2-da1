CREATE TABLE `hallado_thanks` (
	`id` text PRIMARY KEY,
	`publication_id` text NOT NULL,
	`author_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`mensaje` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_hallado_thanks_publication_id_hallado_publications_id_fk` FOREIGN KEY (`publication_id`) REFERENCES `hallado_publications`(`id`),
	CONSTRAINT `fk_hallado_thanks_author_id_users_id_fk` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_hallado_thanks_recipient_id_users_id_fk` FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hallado_agradecimiento_unique` ON `hallado_thanks` (`publication_id`);--> statement-breakpoint
CREATE INDEX `hallado_agradecimiento_usuario_idx` ON `hallado_thanks` (`recipient_id`);