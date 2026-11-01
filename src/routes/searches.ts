import { and, asc, count, countDistinct, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { requireUser } from "../auth";
import type { AppDatabase, Store } from "../database";
import { alerts, claims, halladoPublications as posts, notifications, searchHistory } from "../db/schema";
import { ApiError } from "../errors";
import { matchingPosts, normalizeFilters, notify, reconcileFollowedExpiries, rememberSearch, searchKey } from "../queries";
import { filtersSchema } from "../types";
import { nowIso, pageResult, pageWindow } from "../utils";


/**
 * Resumen de lo que está sin leer, sin cargar textos ni filas: todas las consultas salen del índice parcial de
 * no leídas de la persona, así que el costo crece con lo pendiente y no con el historial leído. Reconcilia primero
 * los vencimientos de lo seguido (igual que el listado) para que sus avisos aparezcan aunque nadie pida el listado.
 * `corte` marca hasta dónde llegó lo mostrado: el rowid y el alta de la última notificación sin leer. Un aviso que
 * llegue después tiene un rowid mayor (o un alta posterior si se reutilizó el rowid de uno borrado) y queda fuera.
 */
function unreadSummary(db: Store, userId: string) {
  reconcileFollowedExpiries(db, userId);
  const unread = and(eq(notifications.userId, userId), isNull(notifications.readAt));
  const total = db.select({ n: count() }).from(notifications).where(unread).get()!.n;
  const last = db.select({ rowid: sql<number>`rowid`, createdAt: notifications.createdAt }).from(notifications)
    .where(unread).orderBy(sql`rowid desc`).limit(1).get();
  const alertas = db.select({ alertaId: notifications.alertId, sinLeer: countDistinct(notifications.publicationId) }).from(notifications)
    .where(and(unread, eq(notifications.tipo, "coincidencia"), sql`${notifications.alertId} is not null`, sql`${notifications.publicationId} is not null`))
    .groupBy(notifications.alertId).orderBy(asc(notifications.alertId)).all();
  const publicaciones = db.select({ publicacionId: notifications.publicationId, sinLeer: count() }).from(notifications)
    .where(and(unread, eq(notifications.tipo, "publicacion"), sql`${notifications.publicationId} is not null`))
    .groupBy(notifications.publicationId).orderBy(asc(notifications.publicationId)).all();
  // Todo lo que pasa en un reclamo suma; `mensajes` es cuántos de esos avisos son mensajes del chat.
  const reclamos = db.select({ reclamoId: notifications.claimId, sinLeer: count(), mensajes: sql<number>`count(*) filter (where ${notifications.tipo} = 'mensaje')` }).from(notifications)
    .where(and(unread, inArray(notifications.tipo, CLAIM_TYPES), sql`${notifications.claimId} is not null`))
    .groupBy(notifications.claimId).orderBy(asc(notifications.claimId)).all();
  return { sinLeer: total, corte: last ? `${last.rowid}@${last.createdAt}` : null, alertas, publicaciones, reclamos };
}
/** Avisos que viven en un reclamo: mensajes, el reclamo mismo, el punto de encuentro y la devolución. */
const CLAIM_TYPES = ["mensaje", "reclamo", "encuentro", "devolucion"];
const CUTOFF = /^([1-9]\d{0,15})@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

export function searchRoutes(db: AppDatabase) {
  return new Elysia()
    .get("/me/busquedas", async ({ headers }) => {
      const user = await requireUser(db, headers);
      return { items: db.select({ id: searchHistory.id, clave: searchHistory.clave, filtros: searchHistory.filtros, creadaEn: searchHistory.createdAt })
        .from(searchHistory).where(eq(searchHistory.userId, user.id)).orderBy(desc(searchHistory.createdAt), desc(searchHistory.id)).limit(5).all() };
    })
    .post("/me/busquedas", async ({ headers, body }) => {
      const user = await requireUser(db, headers);
      const filters = normalizeFilters(body);
      db.transaction((tx) => rememberSearch(tx, user.id, filters));
      return { message: "Búsqueda guardada", filtros: filters };
    }, { body: filtersSchema })
    .delete("/me/busquedas", async ({ headers }) => {
      const user = await requireUser(db, headers);
      db.delete(searchHistory).where(eq(searchHistory.userId, user.id)).run();
      return { message: "Historial eliminado" };
    })
    .get("/alertas", async ({ headers, query }) => {
      const user = await requireUser(db, headers);
      const window = pageWindow(query);
      const mine = eq(alerts.userId, user.id);
      const total = db.select({ n: count() }).from(alerts).where(mine).get()!.n;
      const rows = db.select().from(alerts).where(mine).orderBy(desc(alerts.createdAt), desc(alerts.id))
        .limit(window.pageSize).offset(window.offset).all();
      // Los sin leer de toda la página salen de una sola consulta agrupada por alerta.
      const unread = new Map(!rows.length ? [] : db.select({ alertId: notifications.alertId, n: count() }).from(notifications)
        .where(and(inArray(notifications.alertId, rows.map((a) => a.id)), isNull(notifications.readAt)))
        .groupBy(notifications.alertId).all().map((r) => [r.alertId, r.n]));
      return pageResult(rows.map((a) => ({
        id: a.id, clave: a.clave, filtros: a.filtros, activa: a.activa, creadaEn: a.createdAt, sinLeer: unread.get(a.id) ?? 0,
      })), window, total);
    })
    .post("/alertas", async ({ headers, body, set }) => {
      const user = await requireUser(db, headers);
      const filtros = normalizeFilters(body.filtros);
      const clave = searchKey(filtros);
      const existing = db.select().from(alerts).where(and(eq(alerts.userId, user.id), eq(alerts.clave, clave))).get();
      if (existing) return { id: existing.id, clave, filtros: existing.filtros, activa: existing.activa, creadaEn: existing.createdAt };
      const id = crypto.randomUUID();
      const createdAt = nowIso();
      db.insert(alerts).values({ id, userId: user.id, clave, filtros, createdAt }).run();
      set.status = 201;
      return { id, clave, filtros, activa: true, creadaEn: createdAt };
    }, { body: t.Object({ filtros: filtersSchema }) })
    .patch("/alertas/:id", async ({ headers, params, body }) => {
      const user = await requireUser(db, headers);
      db.transaction((tx) => {
        const a = tx.select().from(alerts).where(and(eq(alerts.id, params.id), eq(alerts.userId, user.id))).get();
        if (!a) throw new ApiError(404, "ALERT_NOT_FOUND", "No encontramos la alerta");
        tx.update(alerts).set({ activa: body.activa }).where(eq(alerts.id, a.id)).run();
        if (body.activa && !a.activa) {
          // Novedades desde que se creó la alerta (alta o edición posterior) de otras personas y que coinciden hoy:
          // las mismas condiciones SQL que la búsqueda acotan la lectura, sin cargar todas las publicaciones.
          for (const p of matchingPosts(tx, a.filtros, [ne(posts.userId, user.id), gte(posts.updatedAt, a.createdAt)])) {
            notify(tx, user.id, "coincidencia", `Hay una coincidencia: ${p.titulo}`, {
              publicationId: p.id, alertId: a.id, dedupeKey: `alert:${a.id}:${p.id}`,
            });
          }
        }
      });
      return { id: params.id, activa: body.activa };
    }, { body: t.Object({ activa: t.Boolean() }) })
    .delete("/alertas/:id", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      const deleted = db.delete(alerts).where(and(eq(alerts.id, params.id), eq(alerts.userId, user.id))).returning({ id: alerts.id }).get();
      if (!deleted) throw new ApiError(404, "ALERT_NOT_FOUND", "No encontramos la alerta");
      return { message: "Alerta eliminada" };
    })
    .post("/alertas/:id/leida", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      const a = db.select().from(alerts).where(and(eq(alerts.id, params.id), eq(alerts.userId, user.id))).get();
      if (!a) throw new ApiError(404, "ALERT_NOT_FOUND", "No encontramos la alerta");
      db.update(notifications).set({ readAt: nowIso() }).where(and(eq(notifications.alertId, a.id), eq(notifications.userId, user.id), isNull(notifications.readAt))).run();
      return { message: "Coincidencias marcadas como leídas" };
    })
    .get("/notificaciones", async ({ headers, query }) => {
      const user = await requireUser(db, headers);
      const window = pageWindow(query);
      // Los avisos de vencimiento se crean antes de contar y listar, para que aparezcan en esta misma respuesta.
      db.transaction((tx) => reconcileFollowedExpiries(tx, user.id));
      const mine = eq(notifications.userId, user.id);
      // Total y sin leer son de toda la cuenta, no de la página, y salen de una única consulta.
      const totals = db.select({ total: count(), unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)` })
        .from(notifications).where(mine).get()!;
      const rows = db.select().from(notifications).where(mine).orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(window.pageSize).offset(window.offset).all();
      return { ...pageResult(rows.map((n) => ({
        id: n.id, tipo: n.tipo, mensaje: n.mensaje, publicacionId: n.publicationId, reclamoId: n.claimId,
        alertaId: n.alertId, creadaEn: n.createdAt, leidaEn: n.readAt,
      })), window, totals.total), sinLeer: totals.unread };
    })
    .get("/notificaciones/resumen", async ({ headers }) => {
      const user = await requireUser(db, headers);
      return db.transaction((tx) => unreadSummary(tx, user.id));
    })
    .post("/notificaciones/grupo/leida", async ({ headers, body }) => {
      const user = await requireUser(db, headers);
      const cutoff = CUTOFF.exec(body.corte);
      if (!cutoff) throw new ApiError(422, "INVALID_CUTOFF", "El corte de lectura no es válido");
      return db.transaction((tx) => {
        let field;
        if (body.tipo === "alerta") {
          if (!tx.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.id, body.id), eq(alerts.userId, user.id))).get()) {
            throw new ApiError(404, "ALERT_NOT_FOUND", "No encontramos la alerta");
          }
          field = and(eq(notifications.tipo, "coincidencia"), eq(notifications.alertId, body.id));
        } else if (body.tipo === "reclamo") {
          // Participan quien reclamó y quien publicó; para el resto el reclamo no existe.
          if (!tx.select({ id: claims.id }).from(claims).innerJoin(posts, eq(posts.id, claims.publicationId))
            .where(and(eq(claims.id, body.id), or(eq(claims.userId, user.id), eq(posts.userId, user.id)))).get()) {
            throw new ApiError(404, "CLAIM_NOT_FOUND", "No encontramos el reclamo");
          }
          field = and(inArray(notifications.tipo, CLAIM_TYPES), eq(notifications.claimId, body.id));
        } else {
          if (!tx.select({ id: posts.id }).from(posts).where(eq(posts.id, body.id)).get()) {
            throw new ApiError(404, "PUBLICATION_NOT_FOUND", "No encontramos la publicación");
          }
          field = and(eq(notifications.tipo, "publicacion"), eq(notifications.publicationId, body.id));
        }
        // Solo lo ya mostrado: nada con rowid mayor al corte, ni con alta posterior (rowid reutilizado).
        const marked = tx.update(notifications).set({ readAt: nowIso() })
          .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt), field, sql`rowid <= ${Number(cutoff[1])}`, lte(notifications.createdAt, cutoff[2]!)))
          .returning({ id: notifications.id }).all();
        return { message: "Notificaciones del grupo leídas", marcadas: marked.length, resumen: unreadSummary(tx, user.id) };
      });
    }, { body: t.Object({
      tipo: t.Union([t.Literal("alerta"), t.Literal("publicacion"), t.Literal("reclamo")]),
      id: t.String({ minLength: 1, maxLength: 100 }),
      corte: t.String({ minLength: 1, maxLength: 64 }),
    }) })
    .post("/notificaciones/:id/leida", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      const row = db.select().from(notifications).where(and(eq(notifications.id, params.id), eq(notifications.userId, user.id))).get();
      if (!row) throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "No encontramos la notificación");
      db.update(notifications).set({ readAt: row.readAt ?? nowIso() }).where(eq(notifications.id, row.id)).run();
      return { message: "Notificación leída" };
    })
    .post("/notificaciones/leidas", async ({ headers }) => {
      const user = await requireUser(db, headers);
      db.update(notifications).set({ readAt: nowIso() }).where(and(eq(notifications.userId, user.id), isNull(notifications.readAt))).run();
      return { message: "Notificaciones leídas" };
    });
}
