CREATE TABLE `hallado_return_codes` (
	`claim_id` text PRIMARY KEY,
	`intento` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	CONSTRAINT `fk_hallado_return_codes_claim_id_hallado_claims_id_fk` FOREIGN KEY (`claim_id`) REFERENCES `hallado_claims`(`id`)
);
