import { and, desc, eq, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { optionalUser, requireUser } from "../auth";
import type { AppDatabase } from "../database";
import { claims, follows, halladoPublications as posts } from "../db/schema";
import { ApiError } from "../errors";
import { filtersFromQuery, getPost, matchesPost, notify, notifyFollowers, notifyMatches, ownerPost, preparePublication, rememberSearch, searchOrigin, serializePost } from "../queries";
import { CATEGORIES, publicationBody, ZONES } from "../types";
import { distanceKm, nowIso, paginate } from "../utils";

export function publicationRoutes(db: AppDatabase) {
  return new Elysia()
    .get("/categorias", () => CATEGORIES)
    .get("/categories", () => CATEGORIES)
    .get("/barrios", () => ZONES)
    .get("/zones", () => ZONES)
    .get("/publicaciones", async ({ headers, query }) => {
      const user = await optionalUser(db, headers);
      const filters = filtersFromQuery(query);
      const origin = searchOrigin(filters);
      const orden = query.orden ?? "recientes";
      if (!["recientes", "cercanos"].includes(orden)) throw new ApiError(422, "INVALID_SORT", "Orden inválido");
      if (orden === "cercanos" && !origin) throw new ApiError(422, "LOCATION_REQUIRED", "Para ordenar por cercanía enviá coordenadas o elegí un barrio de la lista");
      const items = db.select().from(posts).where(and(eq(posts.estado, "abierta"), isNull(posts.deletedAt))).all()
        .filter((p) => matchesPost(p, filters))
        .map((p) => ({ p, km: origin ? distanceKm(origin, p) : null }))
        .sort((a, b) => (orden === "cercanos" ? (a.km! - b.km!) : 0)
          || b.p.fecha.localeCompare(a.p.fecha) || b.p.createdAt.localeCompare(a.p.createdAt) || a.p.id.localeCompare(b.p.id));
      const result = paginate(items, query);
      if (user) db.transaction((tx) => rememberSearch(tx, user.id, filters));
      return { ...result, items: result.items.map(({ p, km }) => ({
        ...serializePost(db, p, user?.id), distancia: km === null ? null : Math.round(km * 10) / 10,
      })) };
    })
    .get("/publicaciones/:id", async ({ params, headers }) => {
      const user = await optionalUser(db, headers);
      return serializePost(db, getPost(db, params.id), user?.id, true);
    })
    .get("/mis-publicaciones", async ({ headers, query }) => {
      const user = await requireUser(db, headers);
      if (query.estado && !["abierta", "en_reclamo", "resuelta"].includes(query.estado)) throw new ApiError(422, "INVALID_STATUS", "Estado inválido");
      const items = db.select().from(posts).where(and(eq(posts.userId, user.id), isNull(posts.deletedAt)))
        .orderBy(desc(posts.createdAt), desc(posts.id)).all()
        .filter((p) => !query.estado || p.estado === query.estado);
      const page = paginate(items, query);
      return { ...page, items: page.items.map((p) => serializePost(db, p, user.id, true)) };
    })
    .post("/publicaciones", async ({ headers, body, set }) => {
      const user = await requireUser(db, headers);
      const data = preparePublication(db, user.id, body);
      const now = nowIso();
      const id = crypto.randomUUID();
      db.transaction((tx) => {
        tx.insert(posts).values({ id, userId: user.id, ...data, createdAt: now, updatedAt: now }).run();
        notifyMatches(tx, getPost(tx, id));
      });
      set.status = 201;
      return serializePost(db, getPost(db, id), user.id, true);
    }, { body: publicationBody })
    .patch("/publicaciones/:id", async ({ params, headers, body }) => {
      const user = await requireUser(db, headers);
      db.transaction((tx) => {
        const p = ownerPost(tx, params.id, user.id);
        if (p.estado !== "abierta") throw new ApiError(409, "PUBLICATION_LOCKED", "Solo podés editar una publicación abierta");
        const next = preparePublication(tx, user.id, {
          ...p, ubicacion: { latitud: p.latitud, longitud: p.longitud }, ...body,
          ...(body.barrio !== undefined && body.barrio !== p.barrio && body.ubicacion === undefined ? { ubicacion: null } : {}),
        });
        tx.update(posts).set({ ...next, updatedAt: nowIso() }).where(eq(posts.id, p.id)).run();
        const updated = getPost(tx, p.id);
        notifyFollowers(tx, updated, `Se actualizó: ${updated.titulo}`);
        notifyMatches(tx, updated);
      });
      return serializePost(db, getPost(db, params.id), user.id, true);
    }, { body: t.Partial(publicationBody) })
    .delete("/publicaciones/:id", async ({ params, headers }) => {
      const user = await requireUser(db, headers);
      db.transaction((tx) => {
        const p = ownerPost(tx, params.id, user.id);
        if (p.estado !== "abierta") throw new ApiError(409, "PUBLICATION_LOCKED", "Solo podés eliminar una publicación abierta");
        const now = nowIso();
        tx.update(posts).set({ deletedAt: now, updatedAt: now }).where(eq(posts.id, p.id)).run();
        for (const c of tx.select().from(claims).where(and(eq(claims.publicationId, p.id), eq(claims.estado, "pendiente"))).all()) {
          tx.update(claims).set({ estado: "cancelado", updatedAt: now }).where(eq(claims.id, c.id)).run();
          notify(tx, c.userId, "reclamo", "La publicación fue eliminada", { claimId: c.id, publicationId: p.id });
        }
        notifyFollowers(tx, p, `Se eliminó: ${p.titulo}`);
      });
      return { message: "Publicación eliminada" };
    })
    .post("/publicaciones/:id/seguir", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      const p = getPost(db, params.id);
      if (p.userId === user.id) throw new ApiError(409, "OWN_PUBLICATION", "Ya recibís las novedades de tus publicaciones");
      db.insert(follows).values({ userId: user.id, publicationId: p.id, createdAt: nowIso() }).onConflictDoNothing().run();
      return { siguiendo: true };
    })
    .delete("/publicaciones/:id/seguir", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      db.delete(follows).where(and(eq(follows.userId, user.id), eq(follows.publicationId, params.id))).run();
      return { siguiendo: false };
    })
    .get("/me/seguidas", async ({ headers, query }) => {
      const user = await requireUser(db, headers);
      const ids = db.select().from(follows).where(eq(follows.userId, user.id)).all();
      const items = ids.map((f) => db.select().from(posts).where(and(eq(posts.id, f.publicationId), isNull(posts.deletedAt))).get())
        .filter((p): p is NonNullable<typeof p> => !!p).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const page = paginate(items, query);
      return { ...page, items: page.items.map((p) => serializePost(db, p, user.id)) };
    });
}
