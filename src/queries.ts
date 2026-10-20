import { and, asc, avg, count, eq, inArray, lte, or } from "drizzle-orm";
import type { AppDatabase } from "./database";
import { offers, operations, publicationImages, reviews, users } from "./db/schema";
import { nowIso } from "./utils";

export function listImages(db: AppDatabase, publicationId: string) {
  return db
    .select({ id: publicationImages.id, url: publicationImages.url, position: publicationImages.position })
    .from(publicationImages)
    .where(eq(publicationImages.publicationId, publicationId))
    .orderBy(asc(publicationImages.position))
    .all();
}

/**
 * Portada (imagen de menor `position`) de varias publicaciones en una sola consulta,
 * para evitar un SELECT por fila al armar listados.
 */
export function getCoverImages(db: AppDatabase, publicationIds: string[]): Map<string, string> {
  const covers = new Map<string, string>();
  if (publicationIds.length === 0) return covers;
  const rows = db
    .select({ publicationId: publicationImages.publicationId, url: publicationImages.url })
    .from(publicationImages)
    .where(inArray(publicationImages.publicationId, publicationIds))
    .orderBy(asc(publicationImages.publicationId), asc(publicationImages.position))
    .all();
  for (const row of rows) if (!covers.has(row.publicationId)) covers.set(row.publicationId, row.url);
  return covers;
}

/** Reemplaza la galería completa de una publicación, renumerando las posiciones desde 0. */
export function replaceImages(db: AppDatabase, publicationId: string, imageUrls: string[]) {
  db.transaction((tx) => {
    tx.delete(publicationImages).where(eq(publicationImages.publicationId, publicationId)).run();
    if (imageUrls.length === 0) return;
    tx.insert(publicationImages)
      .values(imageUrls.map((url, position) => ({ id: crypto.randomUUID(), publicationId, url, position })))
      .run();
  });
}

/**
 * Consigna 2 (Perfil y Reputación): perfil público con reputación (promedio de estrellas,
 * cantidad de operaciones como comprador y como vendedor) y antigüedad en la plataforma.
 */
export function getPublicUser(db: AppDatabase, userId: string) {
  const user = db
    .select({ id: users.id, name: users.name, zone: users.zone, avatarUrl: users.avatarUrl, memberSince: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) return null;

  const rating = db
    .select({ average: avg(reviews.rating), total: count(reviews.id) })
    .from(reviews)
    .where(eq(reviews.reviewedUserId, userId))
    .get();
  const purchases = db.select({ total: count() }).from(operations).where(eq(operations.buyerId, userId)).get();
  const sales = db.select({ total: count() }).from(operations).where(eq(operations.sellerId, userId)).get();

  return {
    ...user,
    ratingAverage: rating?.average == null ? 0 : Math.round(Number(rating.average) * 100) / 100,
    ratingCount: rating?.total ?? 0,
    purchasesCompleted: purchases?.total ?? 0,
    salesCompleted: sales?.total ?? 0,
  };
}

/**
 * Consigna 7 (Ofertas y Negociación): "cada oferta tiene ... un plazo de vigencia, pasado el
 * cual caduca automáticamente". Se aplica de forma perezosa (al leer/actuar sobre ofertas) en
 * vez de con un cron, porque alcanza para el alcance de esta API.
 */
export function expireStaleOffers(db: AppDatabase) {
  db.update(offers)
    .set({ status: "expired", buyerHasUpdate: true, sellerHasUpdate: true, updatedAt: nowIso() })
    .where(and(or(eq(offers.status, "pending"), eq(offers.status, "countered")), lte(offers.expiresAt, nowIso())))
    .run();
}

/** Consigna 9: plazo para calificar una operación, contado desde que se concretó. */
export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const reviewDeadline = (completedAt: string) => new Date(new Date(completedAt).getTime() + REVIEW_WINDOW_MS).toISOString();

/**
 * Consigna 4/8: la dirección exacta de una publicación solo se revela al vendedor y al
 * comprador cuya oferta fue aceptada ("si la oferta es aceptada, recién se puede observar
 * la dirección de entrega").
 */
export function hasAcceptedOffer(db: AppDatabase, publicationId: string, buyerId: string) {
  return !!db
    .select({ id: operations.id })
    .from(operations)
    .where(and(eq(operations.publicationId, publicationId), eq(operations.buyerId, buyerId)))
    .get();
}
