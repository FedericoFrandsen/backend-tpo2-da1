CREATE TABLE `hallado_alerts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`clave` text NOT NULL,
	`filtros` text NOT NULL,
	`activa` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_hallado_alerts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `hallado_claims` (
	`id` text PRIMARY KEY,
	`publication_id` text NOT NULL,
	`user_id` text NOT NULL,
	`mensaje` text NOT NULL,
	`estado` text DEFAULT 'pendiente' NOT NULL,
	`intentos` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_hallado_claims_publication_id_hallado_publications_id_fk` FOREIGN KEY (`publication_id`) REFERENCES `hallado_publications`(`id`),
	CONSTRAINT `fk_hallado_claims_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
	CONSTRAINT "hallado_reclamo_estado_check" CHECK("estado" IN ('pendiente','aceptado','rechazado','cancelado','vencido'))
);
--> statement-breakpoint
CREATE TABLE `hallado_follows` (
	`publication_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `hallado_follows_pk` PRIMARY KEY(`publication_id`, `user_id`),
	CONSTRAINT `fk_hallado_follows_publication_id_hallado_publications_id_fk` FOREIGN KEY (`publication_id`) REFERENCES `hallado_publications`(`id`),
	CONSTRAINT `fk_hallado_follows_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `hallado_publications` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`tipo` text NOT NULL,
	`titulo` text NOT NULL,
	`descripcion` text NOT NULL,
	`categoria` text NOT NULL,
	`barrio` text NOT NULL,
	`fecha` text NOT NULL,
	`franja` text NOT NULL,
	`latitud` real NOT NULL,
	`longitud` real NOT NULL,
	`direccion_exacta` text,
	`fotos` text DEFAULT '[]' NOT NULL,
	`estado` text DEFAULT 'abierta' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text,
	`deleted_at` text,
	CONSTRAINT `fk_hallado_publications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
	CONSTRAINT "hallado_tipo_check" CHECK("tipo" IN ('perdido','encontrado')),
	CONSTRAINT "hallado_estado_check" CHECK("estado" IN ('abierta','en_reclamo','resuelta')),
	CONSTRAINT "hallado_franja_check" CHECK("franja" IN ('manana','tarde','noche'))
);
--> statement-breakpoint
CREATE TABLE `hallado_reviews` (
	`id` text PRIMARY KEY,
	`publication_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`reviewed_user_id` text NOT NULL,
	`positiva` integer NOT NULL,
	`comentario` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_hallado_reviews_publication_id_hallado_publications_id_fk` FOREIGN KEY (`publication_id`) REFERENCES `hallado_publications`(`id`),
	CONSTRAINT `fk_hallado_reviews_reviewer_id_users_id_fk` FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_hallado_reviews_reviewed_user_id_users_id_fk` FOREIGN KEY (`reviewed_user_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `hallado_login_attempts` (
	`login` text PRIMARY KEY,
	`attempts` integer DEFAULT 0 NOT NULL,
	`window_start` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hallado_messages` (
	`id` text PRIMARY KEY,
	`claim_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`texto` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_hallado_messages_claim_id_hallado_claims_id_fk` FOREIGN KEY (`claim_id`) REFERENCES `hallado_claims`(`id`),
	CONSTRAINT `fk_hallado_messages_sender_id_users_id_fk` FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `hallado_notifications` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`tipo` text NOT NULL,
	`mensaje` text NOT NULL,
	`publication_id` text,
	`claim_id` text,
	`alert_id` text,
	`dedupe_key` text UNIQUE,
	`read_at` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_hallado_notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_hallado_notifications_publication_id_hallado_publications_id_fk` FOREIGN KEY (`publication_id`) REFERENCES `hallado_publications`(`id`),
	CONSTRAINT `fk_hallado_notifications_claim_id_hallado_claims_id_fk` FOREIGN KEY (`claim_id`) REFERENCES `hallado_claims`(`id`),
	CONSTRAINT `fk_hallado_notifications_alert_id_hallado_alerts_id_fk` FOREIGN KEY (`alert_id`) REFERENCES `hallado_alerts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `hallado_search_history` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`clave` text NOT NULL,
	`filtros` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_hallado_search_history_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `hallado_uploads` (
	`filename` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`content_type` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_hallado_uploads_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `share_phone` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `hallado_alerta_unique` ON `hallado_alerts` (`user_id`,`clave`);--> statement-breakpoint
CREATE UNIQUE INDEX `hallado_reclamo_usuario_unique` ON `hallado_claims` (`publication_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `hallado_aceptado_unique` ON `hallado_claims` (`publication_id`) WHERE "hallado_claims"."estado" = 'aceptado';--> statement-breakpoint
CREATE INDEX `hallado_busqueda_idx` ON `hallado_publications` (`tipo`,`categoria`,`fecha`);--> statement-breakpoint
CREATE INDEX `hallado_propias_idx` ON `hallado_publications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `hallado_valoracion_unique` ON `hallado_reviews` (`publication_id`,`reviewer_id`);--> statement-breakpoint
CREATE INDEX `hallado_valorado_idx` ON `hallado_reviews` (`reviewed_user_id`);--> statement-breakpoint
CREATE INDEX `hallado_mensaje_reclamo_idx` ON `hallado_messages` (`claim_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `hallado_notificacion_usuario_idx` ON `hallado_notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `hallado_historial_unique` ON `hallado_search_history` (`user_id`,`clave`);