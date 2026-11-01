-- Avisos huérfanos que dejaban trabado el contador de Seguidas: la publicación eliminada o que la persona ya no sigue no se puede limpiar desde la app.
UPDATE `hallado_notifications` SET `read_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `read_at` IS NULL AND `tipo` = 'publicacion' AND `publication_id` IS NOT NULL AND (
  `publication_id` IN (SELECT `id` FROM `hallado_publications` WHERE `deleted_at` IS NOT NULL)
  OR NOT EXISTS (SELECT 1 FROM `hallado_follows` WHERE `hallado_follows`.`publication_id` = `hallado_notifications`.`publication_id` AND `hallado_follows`.`user_id` = `hallado_notifications`.`user_id`)
);
--> statement-breakpoint
-- Avisos de un reclamo cuya publicación fue eliminada: /me/reclamos ya no la lista.
UPDATE `hallado_notifications` SET `read_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `read_at` IS NULL AND `tipo` <> 'coincidencia' AND `claim_id` IN (
  SELECT `hallado_claims`.`id` FROM `hallado_claims` INNER JOIN `hallado_publications` ON `hallado_publications`.`id` = `hallado_claims`.`publication_id`
  WHERE `hallado_publications`.`deleted_at` IS NOT NULL
);
