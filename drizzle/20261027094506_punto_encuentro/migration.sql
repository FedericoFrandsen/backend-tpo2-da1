CREATE TABLE `hallado_encounters` (
	`id` text PRIMARY KEY,
	`claim_id` text NOT NULL,
	`intento` integer NOT NULL,
	`direccion` text NOT NULL,
	`propuesto_por` text NOT NULL,
	`estado` text DEFAULT 'pendiente' NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_hallado_encounters_claim_id_hallado_claims_id_fk` FOREIGN KEY (`claim_id`) REFERENCES `hallado_claims`(`id`),
	CONSTRAINT `fk_hallado_encounters_propuesto_por_users_id_fk` FOREIGN KEY (`propuesto_por`) REFERENCES `users`(`id`),
	CONSTRAINT "hallado_encuentro_estado_check" CHECK("estado" IN ('pendiente','aceptado'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hallado_encuentro_intento_unique` ON `hallado_encounters` (`claim_id`,`intento`);