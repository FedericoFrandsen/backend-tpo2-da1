import { and, desc, eq, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { requireUser } from "../auth";
import type { AppDatabase } from "../database";
import { alerts, halladoPublications as posts, notifications, searchHistory } from "../db/schema";
import { ApiError } from "../errors";
import { matchesPost, normalizeFilters, notify, rememberSearch, searchKey } from "../queries";
import { filtersSchema } from "../types";
import { nowIso, paginate } from "../utils";

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
      const rows = db.select().from(alerts).where(eq(alerts.userId, user.id)).orderBy(desc(alerts.createdAt), desc(alerts.id)).all();
      const page = paginate(rows, query);
      return { ...page, items: page.items.map((a) => ({
        id: a.id, clave: a.clave, filtros: a.filtros, activa: a.activa, creadaEn: a.createdAt,
        sinLeer: db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.alertId, a.id), isNull(notifications.readAt))).all().length,
      })) };
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
          for (const p of tx.select().from(posts).where(isNull(posts.deletedAt)).all()) {
            if (p.userId !== user.id && p.updatedAt >= a.createdAt && matchesPost(p, a.filtros)) {
              notify(tx, user.id, "coincidencia", `Hay una coincidencia: ${p.titulo}`, {
                publicationId: p.id, alertId: a.id, dedupeKey: `alert:${a.id}:${p.id}`,
              });
            }
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
      const rows = db.select().from(notifications).where(eq(notifications.userId, user.id))
        .orderBy(desc(notifications.createdAt), desc(notifications.id)).all();
      const page = paginate(rows, query);
      return { ...page, sinLeer: rows.filter((n) => !n.readAt).length, items: page.items.map((n) => ({
        id: n.id, tipo: n.tipo, mensaje: n.mensaje, publicacionId: n.publicationId, reclamoId: n.claimId,
        alertaId: n.alertId, creadaEn: n.createdAt, leidaEn: n.readAt,
      })) };
    })
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
