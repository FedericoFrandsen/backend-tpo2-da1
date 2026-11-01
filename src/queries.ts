import { and, count, desc, eq, gt, gte, inArray, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { union } from "drizzle-orm/sqlite-core";
import type { Store } from "./database";
import { alerts, claims, follows, halladoPublications as posts, halladoReviews, notifications, searchHistory, uploads, users } from "./db/schema";
import { ApiError } from "./errors";
import { config } from "./config";
import { CATEGORIES, ZONES, type PublicationBody, type SearchFilters } from "./types";
import { cleanText, distanceKm, localDate, normalizeText, nowIso, pageOptions, paginate, requireDate } from "./utils";

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
/**
 * Estado derivado de un lote de publicaciones con a lo sumo una consulta (los reclamos vigentes de las vencibles),
 * en lugar de una por fila. Aplica la misma regla que `isExpired`.
 */
export function postEstados(db: Store, list: Post[]) {
  const now = nowIso();
  const due = list.filter((p) => p.estado === "abierta" && p.venceAt && p.venceAt <= now);
  const held = new Set<string>();
  if (due.length) {
    const cutoff = new Date(Date.now() - CLAIM_EXPIRATION_MS).toISOString();
    for (const c of db.select({ id: claims.publicationId }).from(claims)
      .where(and(inArray(claims.publicationId, due.map((p) => p.id)), eq(claims.estado, "pendiente"), gt(claims.updatedAt, cutoff))).all()) held.add(c.id);
  }
  const dueIds = new Set(due.map((p) => p.id));
  return new Map(list.map((p) => [p.id, dueIds.has(p.id) && !held.has(p.id) ? "vencida" as const : p.estado]));
}

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
/**
 * Perfiles públicos de varias personas con tres consultas, sin importar cuántas sean: usuarios, devoluciones
 * (publicaciones resueltas propias o con reclamo aceptado, sin contar dos veces una misma publicación) y valoraciones recibidas.
 */
export function publicProfiles(db: Store, userIds: string[]) {
  const ids = [...new Set(userIds)];
  const profiles = new Map<string, ReturnType<typeof buildProfile>>();
  if (!ids.length) return profiles;
  const found = db.select().from(users).where(inArray(users.id, ids)).all();
  const owned = db.select({ uid: posts.userId, pid: posts.id }).from(posts)
    .where(and(eq(posts.estado, "resuelta"), inArray(posts.userId, ids)));
  const claimed = db.select({ uid: claims.userId, pid: posts.id }).from(claims)
    .innerJoin(posts, eq(posts.id, claims.publicationId))
    .where(and(eq(posts.estado, "resuelta"), eq(claims.estado, "aceptado"), inArray(claims.userId, ids)));
  const returns = union(owned, claimed).as("returns");
  const completed = new Map(db.select({ uid: returns.uid, n: count() }).from(returns).groupBy(returns.uid).all().map((r) => [r.uid, r.n]));
  const reviews = db.select({ uid: halladoReviews.reviewedUserId, positiva: halladoReviews.positiva, n: count() }).from(halladoReviews)
    .where(inArray(halladoReviews.reviewedUserId, ids)).groupBy(halladoReviews.reviewedUserId, halladoReviews.positiva).all();
  for (const u of found) {
    const mine = reviews.filter((r) => r.uid === u.id);
    profiles.set(u.id, buildProfile(u, completed.get(u.id) ?? 0,
      mine.find((r) => r.positiva)?.n ?? 0, mine.find((r) => !r.positiva)?.n ?? 0));
  }
  return profiles;
}
function buildProfile(u: typeof users.$inferSelect, completedReturns: number, positiveReviews: number, negativeReviews: number) {
  const badges = completedReturns >= 5
    ? [{ id: "vecino-solidario", name: "Vecino solidario", description: "Por concretar 5 devoluciones." }]
    : [];
  return { id: u.id, name: u.name, zone: u.zone, avatarUrl: u.avatarUrl, memberSince: u.createdAt,
    reputation: { completedReturns, positiveReviews, negativeReviews }, badges };
}
export function publicProfile(db: Store, userId: string) {
  const profile = publicProfiles(db, [userId]).get(userId);
  if (!profile) throw new ApiError(404, "USER_NOT_FOUND", "No encontramos el usuario");
  return profile;
}
export function privateProfile(db: Store, userId: string) {
  const u = db.select().from(users).where(eq(users.id, userId)).get()!;
  return { ...publicProfile(db, userId), email: u.email, username: u.username, phone: u.phone, sharePhone: u.sharePhone, hasPassword: !!u.passwordHash };
}
/**
 * Resumen (`detail = false`, listados) o detalle de una publicación. El resumen solo expone campos públicos:
 * no consulta reputación, reclamos, seguimiento ni valoraciones, que únicamente usa el detalle.
 * No ejecuta `expirePendingClaims`: la salida no depende de él y quien serializa en lote lo llama una sola vez.
 */
export function serializePost(db: Store, p: Post, viewerId?: string, detail = false, estado = postEstado(db, p)) {
  const summary = {
    id: p.id, tipo: p.tipo, titulo: p.titulo, descripcion: p.descripcion,
    categoria: p.categoria, barrio: p.barrio, fecha: p.fecha, franja: p.franja,
    estado,
  };
  const dates = { creadaEn: p.createdAt, actualizadaEn: p.updatedAt, resueltaEn: p.resolvedAt, venceAt: p.venceAt || null };
  const coarse = (n: number) => Math.round(n * 1000) / 1000;
  if (!detail) {
    const latitud = coarse(p.latitud), longitud = coarse(p.longitud);
    return { ...summary, latitud, longitud, ubicacion: { latitud, longitud }, fotos: p.fotos, ...dates };
  }
  const accepted = acceptedClaim(db, p.id);
  const own = viewerId === p.userId;
  const participant = own || (!!accepted && accepted.userId === viewerId);
  const privileged = own || (!!accepted && participant);
  const publisher = publicProfile(db, p.userId);
  const source = db.select({ phone: users.phone, sharePhone: users.sharePhone }).from(users).where(eq(users.id, p.userId)).get()!;
  const mine = viewerId ? db.select().from(claims)
    .where(and(eq(claims.publicationId, p.id), eq(claims.userId, viewerId))).get() : null;
  const siguiendo = !!viewerId && !!db.select().from(follows)
    .where(and(eq(follows.publicationId, p.id), eq(follows.userId, viewerId))).get();
  const latitud = privileged ? p.latitud : coarse(p.latitud);
  const longitud = privileged ? p.longitud : coarse(p.longitud);
  const mineExpired = mine ? isClaimExpired(mine) : false;
  const mineEstado = mine ? (mineExpired ? "vencido" : mine.estado) : null;
  return {
    ...summary, latitud, longitud, ubicacion: { latitud, longitud }, fotos: p.fotos, ...dates,
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
  };
}
/** Resúmenes de un listado: el estado derivado de toda la página se resuelve en lote, sin una consulta por publicación. */
export function serializeSummaries(db: Store, list: Post[]) {
  const estados = postEstados(db, list);
  return list.map((p) => serializePost(db, p, undefined, false, estados.get(p.id)));
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
/**
 * Fechas que cubre un período. Los relativos (hoy, tres días, semana) se calculan al momento de evaluar: en una búsqueda,
 * ahora; en una alerta, cuando ocurre el evento (publicar, editar, renovar o reanudar). Lo ya avisado no se retira cuando el
 * período se corre. El rango fijo (`desde`/`hasta`) no depende del reloj.
 */
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
/** Reclamo pendiente vigente (48 h) que sostiene a la publicación y le impide vencer: la regla de `isExpired` en SQL. */
function heldByClaim() {
  const cutoff = new Date(Date.now() - CLAIM_EXPIRATION_MS).toISOString();
  return sql`EXISTS (SELECT 1 FROM hallado_claims WHERE hallado_claims.publication_id = hallado_publications.id
    AND hallado_claims.estado = 'pendiente' AND hallado_claims.updated_at > ${cutoff})`;
}
/**
 * Equivalente SQL de `!isExpired` para publicaciones abiertas: sin `venceAt`, con `venceAt` futuro
 * o con un reclamo pendiente vigente (48 h) que la sostiene.
 */
function liveCondition() {
  return sql`(${posts.venceAt} IS NULL OR ${posts.venceAt} = '' OR ${posts.venceAt} > ${nowIso()} OR ${heldByClaim()})`;
}
/** Caja de latitud/longitud que contiene el círculo del radio (con margen mínimo); el filtro exacto sigue siendo `distanceKm`. */
function boundingBox(o: { latitud: number; longitud: number }, radioKm: number) {
  const angular = radioKm / 6371, deg = 180 / Math.PI, margin = 1e-6;
  const lat = { min: o.latitud - angular * deg - margin, max: o.latitud + angular * deg + margin };
  const ratio = Math.sin(angular) / Math.cos(o.latitud / deg);
  // Cerca de los polos o del antimeridiano la caja no acota la longitud: se omite ese límite.
  if (angular >= Math.PI / 2 || ratio >= 1) return { lat, lon: null };
  const dLon = Math.asin(ratio) * deg + margin;
  const lon = { min: o.longitud - dLon, max: o.longitud + dLon };
  return { lat, lon: lon.min < -180 || lon.max > 180 ? null : lon };
}
/**
 * Condiciones SQL de lo indexable de unos filtros: abierta, no eliminada, tipo, categoría, fechas, barrio, vigencia y caja del radio.
 * El texto libre y la distancia exacta quedan para `matchesPost`. Búsqueda y alertas parten de las mismas condiciones, así que
 * ninguna lee más publicaciones de las que pueden coincidir. Devuelve `null` si el barrio pedido no existe entre las candidatas.
 */
function candidateConditions(db: Store, f: SearchFilters) {
  const range = dateRange(f);
  const conditions = [
    isNull(posts.deletedAt), eq(posts.estado, "abierta"), eq(posts.tipo, f.situacion === "perdi" ? "encontrado" : "perdido"),
    eq(posts.categoria, f.categoria), gte(posts.fecha, range.desde), lte(posts.fecha, range.hasta), liveCondition(),
  ];
  const radius = f.radioKm ?? config.searchRadiusKm;
  if (f.ubicacion) {
    const box = boundingBox(f.ubicacion, radius);
    conditions.push(gte(posts.latitud, box.lat.min), lte(posts.latitud, box.lat.max));
    if (box.lon) conditions.push(gte(posts.longitud, box.lon.min), lte(posts.longitud, box.lon.max));
  }
  if (f.zona) {
    // La comparación ignora tildes y mayúsculas: se resuelve sobre los barrios distintos y luego se filtra por igualdad exacta.
    const zona = normalizeText(f.zona);
    const barrios = db.select({ barrio: posts.barrio }).from(posts).where(and(...conditions)).groupBy(posts.barrio).all()
      .map((r) => r.barrio).filter((b) => normalizeText(b) === zona);
    if (!barrios.length) return null;
    conditions.push(inArray(posts.barrio, barrios));
  }
  return conditions;
}
/**
 * Publicaciones que coinciden con los filtros (`matchesLive`), leyendo de la base solo las candidatas acotadas por
 * `candidateConditions` y por `extra` (por ejemplo, excluir las propias). No carga la tabla ni pagina antes de la distancia exacta.
 */
export function matchingPosts(db: Store, f: SearchFilters, extra: SQL[] = []) {
  const conditions = candidateConditions(db, f);
  if (!conditions) return [];
  return db.select().from(posts).where(and(...conditions, ...extra)).all().filter((p) => matchesLive(db, p, f));
}
/**
 * Búsqueda pública paginada. SQL aplica lo indexable (`candidateConditions`); el texto libre y la distancia exacta se
 * resuelven en memoria sobre ese conjunto ya acotado.
 * Para «recientes» sin palabras ni GPS el orden, el conteo y la página los resuelve SQL por completo.
 * Resultado idéntico al de filtrar todas las abiertas con `matchesLive` y ordenar en memoria.
 */
export function searchPosts(db: Store, f: SearchFilters, origin: { latitud: number; longitud: number } | undefined, orden: "recientes" | "cercanos", q: Record<string, string | undefined>) {
  const { page, pageSize } = pageOptions(q);
  const conditions = candidateConditions(db, f);
  if (!conditions) return { items: [], page, pageSize, total: 0, totalPages: 0 };
  const where = and(...conditions);
  const withKm = (p: Post) => ({ p, km: origin ? distanceKm(origin, p) : null });
  const recent = [desc(posts.fecha), desc(posts.createdAt), posts.id];
  const words = normalizeText(f.palabras ?? "");
  if (orden === "recientes" && !words && !f.ubicacion) {
    const total = db.select({ n: count() }).from(posts).where(where).get()!.n;
    const rows = db.select().from(posts).where(where).orderBy(...recent).limit(pageSize).offset((page - 1) * pageSize).all();
    return { items: rows.map(withKm), page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
  }
  const items = db.select().from(posts).where(where).all()
    .filter((p) => matchesPost(p, f)).map(withKm)
    .sort((a, b) => (orden === "cercanos" ? (a.km! - b.km!) : 0)
      || b.p.fecha.localeCompare(a.p.fecha) || b.p.createdAt.localeCompare(a.p.createdAt) || a.p.id.localeCompare(b.p.id));
  return paginate(items, q);
}
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
/** Con `dedupeKey` el aviso es único por seguidor: repetirlo con la misma clave no vuelve a notificar. */
export function notifyFollowers(db: Store, post: Post, mensaje: string, dedupeKey?: string) {
  for (const f of db.select().from(follows).where(eq(follows.publicationId, post.id)).all()) {
    if (f.userId !== post.userId) notify(db, f.userId, "publicacion", mensaje, { publicationId: post.id, ...(dedupeKey ? { dedupeKey: `${dedupeKey}:${f.userId}` } : {}) });
  }
}
/**
 * El ciclo de vencimiento se identifica por el `venceAt` que lo cerró: renovar lo reemplaza, así que cada ciclo
 * tiene una clave propia y un mismo ciclo nunca avisa dos veces al mismo seguidor (sin guardar estado extra).
 */
const expiryKey = (p: Post) => `vence:${p.id}:${p.venceAt}`;
const renewalKey = (p: Post) => `renueva:${p.id}:${p.venceAt}`;
/** Avisa a los seguidores que el ciclo vigente venció. Idempotente: no hace nada si la publicación no está vencida. */
export function notifyExpiry(db: Store, post: Post) {
  if (isExpired(db, post)) notifyFollowers(db, post, `Venció: ${post.titulo}`, expiryKey(post));
}
/** Avisa la renovación solo si `before` estaba realmente vencida; usa el ciclo que se cerró como clave. */
export function notifyRenewal(db: Store, before: Post, after: Post) {
  notifyFollowers(db, after, `Se renovó: ${after.titulo}`, renewalKey(before));
}
/**
 * Reconcilia los vencimientos de lo que sigue una persona. Los candidatos salen de sus seguimientos (índice por usuario),
 * se limitan a abiertas ya pasadas de `venceAt`, sin un reclamo vigente que las sostenga (regla de `isExpired`, resuelta
 * en la misma consulta para no consultar por publicación) y se descartan las que ya tienen el aviso de ese ciclo.
 */
export function reconcileFollowedExpiries(db: Store, userId: string) {
  const candidates = db.select({ post: posts }).from(follows).innerJoin(posts, eq(posts.id, follows.publicationId))
    .where(and(eq(follows.userId, userId), isNull(posts.deletedAt), eq(posts.estado, "abierta"),
      sql`${posts.venceAt} > ''`, lte(posts.venceAt, nowIso()), sql`NOT ${heldByClaim()}`,
      sql`NOT EXISTS (SELECT 1 FROM hallado_notifications WHERE dedupe_key = 'vence:' || ${posts.id} || ':' || ${posts.venceAt} || ':' || ${userId})`)).all();
  for (const { post } of candidates) {
    if (post.userId !== userId) {
      notify(db, userId, "publicacion", `Venció: ${post.titulo}`, { publicationId: post.id, dedupeKey: `${expiryKey(post)}:${userId}` });
    }
  }
}
/**
 * Alertas activas de otras personas que pueden interesarse en la publicación: misma categoría y la situación opuesta.
 * Es igualdad exacta sobre el JSON de filtros, resuelta por `hallado_alerta_candidatas_idx` (la expresión tiene que ser la misma
 * que la del índice). Es solo una preselección: no usa LIMIT y deja la comparación completa (barrio sin tildes, radio exacto,
 * palabras, fechas y vigencia) para `matchesLive`, que es la regla que comparten la búsqueda y la reanudación de alertas.
 */
function candidateAlerts(db: Store, post: Post) {
  return db.select().from(alerts).where(and(
    sql`json_extract(${alerts.filtros}, '$.categoria') = ${post.categoria}`,
    sql`json_extract(${alerts.filtros}, '$.situacion') = ${post.tipo === "encontrado" ? "perdi" : "encontre"}`,
    eq(alerts.activa, true), ne(alerts.userId, post.userId))).all();
}
/**
 * Avisa a las alertas que coinciden con la publicación (una vez por alerta y publicación). El trabajo es proporcional a las
 * candidatas de su categoría y situación, no a todas las alertas activas; si todas coinciden, sigue siendo alto.
 */
export function notifyMatches(db: Store, post: Post) {
  for (const a of candidateAlerts(db, post)) {
    if (matchesLive(db, post, a.filtros)) {
      notify(db, a.userId, "coincidencia", `Hay una coincidencia: ${post.titulo}`, {
        publicationId: post.id, alertId: a.id, dedupeKey: `alert:${a.id}:${post.id}`,
      });
    }
  }
}
