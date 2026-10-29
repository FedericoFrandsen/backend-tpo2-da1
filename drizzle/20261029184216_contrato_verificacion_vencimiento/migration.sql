ALTER TABLE `hallado_claims` ADD `respuesta_verificacion` text;--> statement-breakpoint
ALTER TABLE `hallado_claims` ADD `foto_prueba` text;--> statement-breakpoint
ALTER TABLE `hallado_claims` ADD `barrio` text;--> statement-breakpoint
ALTER TABLE `hallado_publications` ADD `pregunta_verificacion` text;--> statement-breakpoint
ALTER TABLE `hallado_publications` ADD `respuesta_verificacion` text;--> statement-breakpoint
ALTER TABLE `hallado_publications` ADD `client_id` text;--> statement-breakpoint
ALTER TABLE `hallado_publications` ADD `vence_at` text;--> statement-breakpoint
ALTER TABLE `hallado_uploads` ADD `tipo` text DEFAULT 'imagen' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `hallado_client_id_unique` ON `hallado_publications` (`user_id`,`client_id`);
--> statement-breakpoint
-- Las publicaciones existentes (incluidos los datos de demo) arrancan su ciclo de 30 días al migrar, para no vencer datos de golpe.
UPDATE `hallado_publications` SET `vence_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days') WHERE `vence_at` IS NULL;
