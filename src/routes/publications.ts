import { and, count, desc, eq, isNull, ne } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { optionalUser, requireUser } from "../auth";
import type { AppDatabase } from "../database";
import { claims, follows, halladoPublications as posts, notifications } from "../db/schema";
import { ApiError } from "../errors";
import { expirePendingClaims, filtersFromQuery, getPost, isExpired, notify, notifyExpiry, notifyFollowers, notifyMatches, notifyRenewal, ownerPost, postEstado, preparePublication, reconcileFollowedExpiries, rememberSearch, searchOrigin, searchPosts, serializePost, serializeSummaries } from "../queries";
import { CATEGORIES, publicationBody, ZONES } from "../types";
import { normalizeText, nowIso, pageResult, pageWindow, paginate, publicationExpiry } from "../utils";

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
      const result = searchPosts(db, filters, origin, orden as "recientes" | "cercanos", query);
      if (user) db.transaction((tx) => rememberSearch(tx, user.id, filters));
      return { ...result, items: result.items.map(({ p, km }) => ({
        ...serializePost(db, p, user?.id), distancia: km === null ? null : Math.round(km * 10) / 10,
      })) };
    })
    .get("/publicaciones/:id", async ({ params, headers }) => {
      const user = await optionalUser(db, headers);
      expirePendingClaims(db);
      const post = getPost(db, params.id);
      db.transaction((tx) => notifyExpiry(tx, post));
      return serializePost(db, post, user?.id, true);
    })
    .get("/mis-publicaciones", async ({ headers, query }) => {
      const user = await requireUser(db, headers);
      if (query.estado && !["abierta", "en_reclamo", "resuelta", "vencida"].includes(query.estado)) throw new ApiError(422, "INVALID_STATUS", "Estado inválido");
      const items = db.select().from(posts).where(and(eq(posts.userId, user.id), isNull(posts.deletedAt)))
        .orderBy(desc(posts.createdAt), desc(posts.id)).all()
        .filter((p) => !query.estado || postEstado(db, p) === query.estado);
      const page = paginate(items, query);
      expirePendingClaims(db);
      return { ...page, items: page.items.map((p) => serializePost(db, p, user.id, true)) };
    })
    .post("/publicaciones", async ({ headers, body, set }) => {
      const user = await requireUser(db, headers);
      const { id, created } = db.transaction((tx) => {
        // Idempotencia del alta: el mismo clientId del mismo usuario devuelve la publicación ya creada.
        const previous = body.clientId ? tx.select().from(posts)
          .where(and(eq(posts.userId, user.id), eq(posts.clientId, body.clientId))).get() : undefined;
        if (previous) {
          if (previous.deletedAt) throw new ApiError(409, "CLIENT_ID_ALREADY_USED", "Esa publicación ya fue creada y luego eliminada");
          return { id: previous.id, created: false };
        }
        const data = preparePublication(tx, user.id, body);
        const now = nowIso();
        const id = crypto.randomUUID();
        tx.insert(posts).values({ id, userId: user.id, ...data, clientId: body.clientId ?? null, venceAt: publicationExpiry(), createdAt: now, updatedAt: now }).run();
        notifyMatches(tx, getPost(tx, id));
        return { id, created: true };
      });
      set.status = created ? 201 : 200;
      return serializePost(db, getPost(db, id), user.id, true);
    }, { body: publicationBody })
    .patch("/publicaciones/:id", async ({ params, headers, body }) => {
      const user = await requireUser(db, headers);
      db.transaction((tx) => {
        const p = ownerPost(tx, params.id, user.id);
        if (p.estado !== "abierta") throw new ApiError(409, "PUBLICATION_LOCKED", "Solo podés editar una publicación abierta");
        const next = preparePublication(tx, user.id, {
          ...p, clientId: undefined, ubicacion: { latitud: p.latitud, longitud: p.longitud }, ...body,
          ...(body.barrio !== undefined && normalizeText(body.barrio ?? "") !== normalizeText(p.barrio) && body.ubicacion === undefined ? { ubicacion: null } : {}),
        }, !(p.tipo === "encontrado" && !p.preguntaVerificacion), { previous: p, body });
        tx.update(posts).set({ ...next, updatedAt: nowIso() }).where(eq(posts.id, p.id)).run();
        const updated = getPost(tx, p.id);
        notifyFollowers(tx, updated, `Se actualizó: ${updated.titulo}`);
        notifyMatches(tx, updated);
      });
      return serializePost(db, getPost(db, params.id), user.id, true);
    }, { body: t.Partial(publicationBody) })
    .post("/publicaciones/:id/renovar", async ({ params, headers }) => {
      const user = await requireUser(db, headers);
      db.transaction((tx) => {
        const p = ownerPost(tx, params.id, user.id);
        if (p.estado === "resuelta") throw new ApiError(409, "PUBLICATION_LOCKED", "No podés renovar una publicación resuelta");
        // Solo hay transición real si estaba vencida: primero se deja el aviso del ciclo que se cierra y luego el de la renovación.
        const wasExpired = isExpired(tx, p);
        if (wasExpired) notifyExpiry(tx, p);
        tx.update(posts).set({ venceAt: publicationExpiry(), updatedAt: nowIso() }).where(eq(posts.id, p.id)).run();
        const renewed = getPost(tx, p.id);
        if (wasExpired) notifyRenewal(tx, p, renewed);
        // Si estaba vencida vuelve a ser visible: se avisa a las alertas que coinciden (deduplicadas).
        notifyMatches(tx, renewed);
      });
      return serializePost(db, getPost(db, params.id), user.id, true);
    })
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
        // La publicación ya no aparece en Seguidas ni en /me/reclamos: sus avisos (también los recién creados) quedarían sin
        // leer y sin forma de limpiarse. Las coincidencias de alertas se conservan.
        tx.update(notifications).set({ readAt: now })
          .where(and(eq(notifications.publicationId, p.id), ne(notifications.tipo, "coincidencia"), isNull(notifications.readAt))).run();
      });
      return { message: "Publicación eliminada" };
    })
    .post("/publicaciones/:id/seguir", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      const p = getPost(db, params.id);
      if (p.userId === user.id) throw new ApiError(409, "OWN_PUBLICATION", "Ya recibís las novedades de tus publicaciones");
      if (isExpired(db, p)) throw new ApiError(409, "PUBLICATION_EXPIRED", "La publicación venció");
      db.insert(follows).values({ userId: user.id, publicationId: p.id, createdAt: nowIso() }).onConflictDoNothing().run();
      return { siguiendo: true };
    })
    .delete("/publicaciones/:id/seguir", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      db.transaction((tx) => {
        tx.delete(follows).where(and(eq(follows.userId, user.id), eq(follows.publicationId, params.id))).run();
        // Sin el seguimiento la publicación sale de Seguidas: sus avisos pendientes ya no se pueden limpiar desde ahí.
        tx.update(notifications).set({ readAt: nowIso() })
          .where(and(eq(notifications.userId, user.id), eq(notifications.publicationId, params.id), eq(notifications.tipo, "publicacion"), isNull(notifications.readAt))).run();
      });
      return { siguiendo: false };
    })
    .get("/me/seguidas", async ({ headers, query }) => {
      const user = await requireUser(db, headers);
      const window = pageWindow(query);
      // Primero se reconcilian los vencimientos: los avisos nuevos y el estado de la página salen de la misma lectura.
      db.transaction((tx) => reconcileFollowedExpiries(tx, user.id));
      // El seguimiento es único por (publicación, persona): el join no duplica filas ni altera el total.
      const followed = and(eq(follows.userId, user.id), isNull(posts.deletedAt));
      const total = db.select({ n: count() }).from(follows).innerJoin(posts, eq(posts.id, follows.publicationId)).where(followed).get()!.n;
      const rows = db.select({ post: posts }).from(follows).innerJoin(posts, eq(posts.id, follows.publicationId)).where(followed)
        .orderBy(desc(posts.updatedAt), desc(posts.id)).limit(window.pageSize).offset(window.offset).all();
      return pageResult(serializeSummaries(db, rows.map((r) => r.post)), window, total);
    });
}
