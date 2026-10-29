import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Store } from "./database";
import { alerts, claims, follows, halladoPublications as posts, halladoReviews, notifications, searchHistory, uploads, users } from "./db/schema";
import { ApiError } from "./errors";
import { config } from "./config";
import { CATEGORIES, ZONES, type PublicationBody, type SearchFilters } from "./types";
import { cleanText, distanceKm, localDate, normalizeText, nowIso, requireDate } from "./utils";

export type Post = typeof posts.$inferSelect;
export type Claim = typeof claims.$inferSelect;

export const CLAIM_EXPIRATION_HOURS = 48;
export const CLAIM_EXPIRATION_MS = CLAIM_EXPIRATION_HOURS * 60 * 60 * 1000;

export function isClaimExpired(claim: { estado: string; updatedAt?: string; createdAt?: string }): boolean {
  if (claim.estado !== "pendiente") return false;
  const fechaStr = claim.updatedAt || claim.createdAt;
  if (!fechaStr) return false;
  const fecha = new Date(fechaStr).getTime();
  return Date.now() - fecha >= CLAIM_EXPIRATION_MS;
}

export function expirePendingClaims(db: Store): void {
  const cutoff = new Date(Date.now() - CLAIM_EXPIRATION_MS).toISOString();
  db.update(claims)
    .set({ estado: "vencido" })
    .where(and(eq(claims.estado, "pendiente"), sql`${claims.updatedAt} <= ${cutoff}`))
    .run();
}

/**
 * Una publicación abierta cuyo `venceAt` pasó se expone como "vencida" (estado derivado, no se guarda).
 * Mientras tenga un reclamo pendiente vigente (48 h) todavía no vence; una `en_reclamo` (reclamo aceptado) tampoco.
 */
export function isExpired(db: Store, p: Post): boolean {
  if (p.estado !== "abierta" || !p.venceAt || p.venceAt > nowIso()) return false;
  const cutoff = new Date(Date.now() - CLAIM_EXPIRATION_MS).toISOString();
  return !db.select({ id: claims.id }).from(claims)
    .where(and(eq(claims.publicationId, p.id), eq(claims.estado, "pendiente"), gt(claims.updatedAt, cutoff))).get();
}
export const postEstado = (db: Store, p: Post) => (isExpired(db, p) ? "vencida" as const : p.estado);

export function getPost(db: Store, id: string) {
  const post = db.select().from(posts).where(and(eq(posts.id, id), isNull(posts.deletedAt))).get();
  if (!post) throw new ApiError(404, "PUBLICATION_NOT_FOUND", "No encontramos la publicación");
  return post;
}
export function ownerPost(db: Store, id: string, userId: string) {
  const post = getPost(db, id);
  if (post.userId !== userId) throw new ApiError(403, "FORBIDDEN", "La publicación pertenece a otra persona");
  return post;
}
export function getClaim(db: Store, id: string) {
  expirePendingClaims(db);
  const claim = db.select().from(claims).where(eq(claims.id, id)).get();
  if (!claim) throw new ApiError(404, "CLAIM_NOT_FOUND", "No encontramos el reclamo");
  return claim;
}
export function acceptedClaim(db: Store, postId: string) {
  return db.select().from(claims).where(and(eq(claims.publicationId, postId), eq(claims.estado, "aceptado"))).get();
}
export function publicProfile(db: Store, userId: string) {
  const u = db.select().from(users).where(eq(users.id, userId)).get();
  if (!u) throw new ApiError(404, "USER_NOT_FOUND", "No encontramos el usuario");
  const completedReturns = db.select({ id: posts.id }).from(posts)
    .leftJoin(claims, and(eq(claims.publicationId, posts.id), eq(claims.estado, "aceptado")))
    .where(and(eq(posts.estado, "resuelta"), or(eq(posts.userId, userId), eq(claims.userId, userId)))).all().length;
  const received = db.select({ positiva: halladoReviews.positiva }).from(halladoReviews)
    .where(eq(halladoReviews.reviewedUserId, userId)).all();
  const reputation = {
    completedReturns,
    positiveReviews: received.filter((v) => v.positiva).length,
    negativeReviews: received.filter((v) => !v.positiva).length,
  };
  const badges = completedReturns >= 5
    ? [{ id: "vecino-solidario", name: "Vecino solidario", description: "Por concretar 5 devoluciones." }]
    : [];
  return { id: u.id, name: u.name, zone: u.zone, avatarUrl: u.avatarUrl, memberSince: u.createdAt, reputation, badges };
}
export function privateProfile(db: Store, userId: string) {
  const u = db.select().from(users).where(eq(users.id, userId)).get()!;
  return { ...publicProfile(db, userId), email: u.email, username: u.username, phone: u.phone, sharePhone: u.sharePhone, hasPassword: !!u.passwordHash };
}
export function serializePost(db: Store, p: Post, viewerId?: string, detail = false) {
  const accepted = acceptedClaim(db, p.id);
  const own = viewerId === p.userId;
  const participant = own || (!!accepted && accepted.userId === viewerId);
  const privileged = own || (!!accepted && participant);
  const publisher = publicProfile(db, p.userId);
  const source = db.select({ phone: users.phone, sharePhone: users.sharePhone }).from(users).where(eq(users.id, p.userId)).get()!;
  expirePendingClaims(db);
  const mine = viewerId ? db.select().from(claims)
    .where(and(eq(claims.publicationId, p.id), eq(claims.userId, viewerId))).get() : null;
  const siguiendo = !!viewerId && !!db.select().from(follows)
    .where(and(eq(follows.publicationId, p.id), eq(follows.userId, viewerId))).get();
  const latitud = privileged && detail ? p.latitud : Math.round(p.latitud * 1000) / 1000;
  const longitud = privileged && detail ? p.longitud : Math.round(p.longitud * 1000) / 1000;
  const mineExpired = mine ? isClaimExpired(mine) : false;
  const mineEstado = mine ? (mineExpired ? "vencido" : mine.estado) : null;
  return {
    id: p.id, tipo: p.tipo, titulo: p.titulo, descripcion: p.descripcion,
    categoria: p.categoria, barrio: p.barrio, fecha: p.fecha, franja: p.franja,
    estado: postEstado(db, p), latitud, longitud, ubicacion: { latitud, longitud }, fotos: p.fotos,
    creadaEn: p.createdAt, actualizadaEn: p.updatedAt, resueltaEn: p.resolvedAt, venceAt: p.venceAt || null,
    ...(detail ? {
      preguntaVerificacion: p.preguntaVerificacion,
      // La respuesta privada solo la ve quien publicó el hallazgo.
      ...(own ? { respuestaVerificacion: p.respuestaVerificacion } : {}),
      direccionExacta: privileged ? p.direccionExacta : null,
      publicador: { ...publisher, ...(participant && accepted && source.sharePhone ? { phone: source.phone } : {}) },
      esPropia: own, siguiendo,
      reclamoEnviado: !!mine && ["pendiente", "aceptado"].includes(mine.estado) && !mineExpired,
      reclamoAceptado: !!accepted && participant,
      miReclamo: mine ? {
        id: mine.id,
        estado: mineEstado,
        mensaje: mine.mensaje,
        respuestaVerificacion: mine.respuestaVerificacion, fotoPrueba: mine.fotoPrueba, barrio: mine.barrio,
        intentos: mine.intentos ?? 1,
        maxIntentos: 3,
      } : null,
      valoracion: viewerId ? db.select({ id: halladoReviews.id, positiva: halladoReviews.positiva, comentario: halladoReviews.comentario })
        .from(halladoReviews).where(and(eq(halladoReviews.publicationId, p.id), eq(halladoReviews.reviewerId, viewerId))).get() ?? null : null,
    } : {}),
  };
}
export function serializeClaim(db: Store, claim: Claim, post: Post, viewerId: string) {
  const u = db.select().from(users).where(eq(users.id, claim.userId)).get()!;
  const estado = isClaimExpired(claim) ? "vencido" : claim.estado;
  // Las pruebas del reclamo son privadas: solo el reclamante y el dueño de la publicación.
  const participant = viewerId === claim.userId || viewerId === post.userId;
  return {
    id: claim.id, publicacionId: claim.publicationId, usuarioId: u.id, usuario: u.name,
    perfil: publicProfile(db, u.id), mensaje: claim.mensaje, estado,
    ...(participant ? { respuestaVerificacion: claim.respuestaVerificacion, fotoPrueba: claim.fotoPrueba, barrio: claim.barrio } : {}),
    intentos: claim.intentos ?? 1,
    maxIntentos: 3,
    permiteTelefono: u.sharePhone,
    telefono: estado === "aceptado" && u.sharePhone && (viewerId === post.userId || viewerId === u.id) ? u.phone : null,
    creadaEn: claim.createdAt, actualizadaEn: claim.updatedAt,
  };
}
export function normalizeFilters(input: SearchFilters): SearchFilters {
  if (!["perdi", "encontre"].includes(input.situacion) || !CATEGORIES.includes(input.categoria)
      || !["hoy", "tresDias", "semana", "rango"].includes(input.periodo)) {
    throw new ApiError(422, "INVALID_FILTERS", "Revisá la situación, la categoría y el período");
  }
  const zona = (input.zona ?? "").trim();
  const palabras = (input.palabras ?? "").trim();
  if (zona.length > 100 || palabras.length > 200) throw new ApiError(422, "INVALID_FILTERS", "Los filtros son demasiado largos");
  const u = input.ubicacion;
  if (u && (!Number.isFinite(u.latitud) || !Number.isFinite(u.longitud) || Math.abs(u.latitud) > 90 || Math.abs(u.longitud) > 180)) {
    throw new ApiError(422, "INVALID_LOCATION", "Las coordenadas no son válidas");
  }
  if (!zona && !u) throw new ApiError(422, "LOCATION_REQUIRED", "Elegí un barrio o usá tu ubicación actual");
  if (input.periodo === "rango") {
    requireDate(input.desde ?? ""); requireDate(input.hasta ?? "");
    if (input.desde! > input.hasta!) throw new ApiError(422, "INVALID_DATE_RANGE", "El inicio debe ser anterior al final");
  }
  if (input.radioKm !== undefined && (!Number.isFinite(input.radioKm) || input.radioKm < 0.1 || input.radioKm > 500)) {
    throw new ApiError(422, "INVALID_RADIUS", "El radio debe estar entre 0.1 y 500 km");
  }
  return {
    situacion: input.situacion, categoria: input.categoria, palabras, zona, periodo: input.periodo,
    ...(input.periodo === "rango" ? { desde: input.desde, hasta: input.hasta } : {}),
    ubicacion: u ? { latitud: u.latitud, longitud: u.longitud } : null,
    ...(u ? { radioKm: input.radioKm ?? config.searchRadiusKm } : {}),
  };
}
export function filtersFromQuery(q: Record<string, string | undefined>) {
  const withCoords = q.latitud !== undefined || q.longitud !== undefined;
  return normalizeFilters({
    situacion: q.situacion, categoria: q.categoria, palabras: q.palabras,
    zona: q.zona, periodo: q.periodo ?? "semana", desde: q.desde, hasta: q.hasta,
    ubicacion: withCoords ? { latitud: Number(q.latitud ?? NaN), longitud: Number(q.longitud ?? NaN) } : null,
    radioKm: q.radioKm === undefined ? undefined : Number(q.radioKm),
  } as SearchFilters);
}
export function dateRange(f: SearchFilters) {
  if (f.periodo === "rango") return { desde: f.desde!, hasta: f.hasta! };
  const hasta = localDate();
  const d = new Date(`${hasta}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (f.periodo === "semana" ? 6 : f.periodo === "tresDias" ? 2 : 0));
  return { desde: d.toISOString().slice(0, 10), hasta };
}
export function searchOrigin(f: SearchFilters) {
  return f.ubicacion ?? ZONES.find((z) => normalizeText(z.nombre) === normalizeText(f.zona ?? ""));
}
export function matchesPost(p: Post, f: SearchFilters) {
  const range = dateRange(f);
  const tipo = f.situacion === "perdi" ? "encontrado" : "perdido";
  const words = normalizeText(f.palabras ?? "").split(/\s+/).filter(Boolean);
  const text = normalizeText(`${p.titulo} ${p.descripcion}`);
  return !p.deletedAt && p.estado === "abierta" && p.tipo === tipo && p.categoria === f.categoria
    && (!f.zona || normalizeText(p.barrio) === normalizeText(f.zona))
    && p.fecha >= range.desde && p.fecha <= range.hasta
    && words.every((w) => text.includes(w))
    && (!f.ubicacion || distanceKm(f.ubicacion, p) <= (f.radioKm ?? config.searchRadiusKm));
}
/** Coincide con los filtros y sigue vigente: las vencidas no aparecen en búsquedas ni disparan alertas. */
export const matchesLive = (db: Store, p: Post, f: SearchFilters) => matchesPost(p, f) && !isExpired(db, p);
export function searchKey(f: SearchFilters) {
  return JSON.stringify({ ...f, palabras: normalizeText(f.palabras ?? ""), zona: normalizeText(f.zona ?? "") });
}
export function rememberSearch(db: Store, userId: string, filtros: SearchFilters) {
  const clave = searchKey(filtros);
  db.insert(searchHistory).values({ id: crypto.randomUUID(), userId, filtros, clave, createdAt: nowIso() })
    .onConflictDoUpdate({ target: [searchHistory.userId, searchHistory.clave], set: { filtros, createdAt: nowIso() } }).run();
  const rows = db.select({ id: searchHistory.id }).from(searchHistory).where(eq(searchHistory.userId, userId))
    .orderBy(desc(searchHistory.createdAt), desc(searchHistory.id)).all();
  for (const row of rows.slice(5)) db.delete(searchHistory).where(eq(searchHistory.id, row.id)).run();
}
const IMAGE_URL = /^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp)$/;
const PROOF_URL = /^(?:\/uploads\/pruebas\/)?([0-9a-f-]{36}\.(?:jpg|png|webp))$/;

/** Valida una foto de comprobación subida por el mismo usuario a /uploads/pruebas y devuelve su URL canónica. */
export function ownedProof(db: Store, userId: string, value: string) {
  const filename = PROOF_URL.exec(value.trim())?.[1];
  if (!filename) throw new ApiError(422, "INVALID_PROOF", "Primero subí la foto de comprobación a /uploads/pruebas");
  const proof = db.select().from(uploads).where(and(eq(uploads.filename, filename), eq(uploads.tipo, "prueba"))).get();
  if (!proof || proof.userId !== userId) throw new ApiError(403, "PROOF_NOT_OWNED", "La foto de comprobación no pertenece a tu cuenta");
  return `/uploads/pruebas/${filename}`;
}
export function zoneName(value: string) {
  return ZONES.find((z) => normalizeText(z.nombre) === normalizeText(value))?.nombre;
}

/** `requireVerification`: al crear un hallazgo la pregunta y la respuesta son obligatorias (al editar, salvo hallazgos previos sin pregunta). */
export function preparePublication(db: Store, userId: string, input: PublicationBody, requireVerification = true) {
  const titulo = cleanText(input.titulo, 3, "título");
  const descripcion = cleanText(input.descripcion, 10, "descripción");
  requireDate(input.fecha);
  const barrio = (input.barrio ?? "").trim();
  const coord = input.ubicacion ?? ZONES.find((z) => normalizeText(z.nombre) === normalizeText(barrio));
  if (!coord) throw new ApiError(422, "LOCATION_REQUIRED", "Elegí un barrio de la lista o enviá las coordenadas");
  const fotos = input.fotos ?? [];
  for (const url of fotos) {
    if (!IMAGE_URL.test(url)) {
      throw new ApiError(422, "INVALID_IMAGE", "Primero subí las fotos a /uploads/images");
    }
    const image = db.select().from(uploads).where(and(eq(uploads.filename, url.slice("/uploads/".length)), eq(uploads.tipo, "imagen"))).get();
    if (!image || image.userId !== userId) throw new ApiError(403, "IMAGE_NOT_OWNED", "La foto no pertenece a tu cuenta");
  }
  const tipo = input.tipo === "perdi" || input.tipo === "perdido" ? "perdido" as const : "encontrado" as const;
  let preguntaVerificacion: string | null = null;
  let respuestaVerificacion: string | null = null;
  if (tipo === "encontrado") {
    const pregunta = (input.preguntaVerificacion ?? "").trim();
    const respuesta = (input.respuestaVerificacion ?? "").trim();
    if (requireVerification || pregunta || respuesta) {
      if (pregunta.length < 3) throw new ApiError(422, "VERIFICATION_QUESTION_REQUIRED", "Cargá una pregunta de verificación para quien diga que es el dueño");
      if (!respuesta) throw new ApiError(422, "VERIFICATION_ANSWER_REQUIRED", "Cargá la respuesta a la pregunta de verificación");
    }
    preguntaVerificacion = pregunta || null;
    respuestaVerificacion = respuesta || null;
  }
  return {
    tipo,
    titulo, descripcion, categoria: input.categoria, barrio: barrio || "Ubicación actual",
    fecha: input.fecha, franja: input.franja, latitud: coord.latitud, longitud: coord.longitud,
    direccionExacta: input.direccionExacta?.trim() || null, fotos,
    preguntaVerificacion, respuestaVerificacion,
  };
}
export function notify(db: Store, userId: string, tipo: string, mensaje: string,
  data: { publicationId?: string; claimId?: string; alertId?: string; dedupeKey?: string } = {}) {
  db.insert(notifications).values({ id: crypto.randomUUID(), userId, tipo, mensaje, ...data, createdAt: nowIso() })
    .onConflictDoNothing().run();
}
export function notifyFollowers(db: Store, post: Post, mensaje: string) {
  for (const f of db.select().from(follows).where(eq(follows.publicationId, post.id)).all()) {
    if (f.userId !== post.userId) notify(db, f.userId, "publicacion", mensaje, { publicationId: post.id });
  }
}
export function notifyMatches(db: Store, post: Post) {
  for (const a of db.select().from(alerts).where(eq(alerts.activa, true)).all()) {
    if (a.userId !== post.userId && matchesLive(db, post, a.filtros)) {
      notify(db, a.userId, "coincidencia", `Hay una coincidencia: ${post.titulo}`, {
        publicationId: post.id, alertId: a.id, dedupeKey: `alert:${a.id}:${post.id}`,
      });
    }
  }
}
