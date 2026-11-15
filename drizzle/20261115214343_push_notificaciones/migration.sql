-- Instalaciones con el PR #6 tienen una tabla hallado_push_tokens creada fuera de las migraciones (un token por usuario,
-- sin sesión). Esos tokens no se pueden atribuir a una sesión sin arriesgar avisos cruzados entre cuentas, así que se
-- descartan: la app vuelve a registrar el token del dispositivo al abrirse con sesión iniciada.
DROP TABLE IF EXISTS `hallado_push_tokens`;
--> statement-breakpoint
CREATE TABLE `hallado_push_outbox` (
	`id` text PRIMARY KEY,
	`notification_id` text NOT NULL,
	`push_token_id` text,
	`estado` text DEFAULT 'pendiente' NOT NULL,
	`intentos` integer DEFAULT 0 NOT NULL,
	`proximo_intento_at` text NOT NULL,
	`ticket_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_hallado_push_outbox_notification_id_hallado_notifications_id_fk` FOREIGN KEY (`notification_id`) REFERENCES `hallado_notifications`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_hallado_push_outbox_push_token_id_hallado_push_tokens_id_fk` FOREIGN KEY (`push_token_id`) REFERENCES `hallado_push_tokens`(`id`) ON DELETE SET NULL,
	CONSTRAINT "hallado_push_envio_estado_check" CHECK("estado" IN ('pendiente','enviado','aceptado','fallido','cancelado','sin_recibo'))
);
--> statement-breakpoint
CREATE TABLE `hallado_push_tokens` (
	`id` text PRIMARY KEY,
	`token` text NOT NULL UNIQUE,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL UNIQUE,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_hallado_push_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_hallado_push_tokens_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hallado_push_envio_unique` ON `hallado_push_outbox` (`notification_id`,`push_token_id`);--> statement-breakpoint
CREATE INDEX `hallado_push_envio_estado_idx` ON `hallado_push_outbox` (`estado`,`proximo_intento_at`);--> statement-breakpoint
CREATE INDEX `hallado_push_envio_token_idx` ON `hallado_push_outbox` (`push_token_id`);--> statement-breakpoint
CREATE INDEX `hallado_push_token_usuario_idx` ON `hallado_push_tokens` (`user_id`);