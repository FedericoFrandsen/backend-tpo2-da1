import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { requireUser } from "../auth";
import type { AppDatabase, Store } from "../database";
import { claims, halladoPublications as posts, halladoReviews, messages } from "../db/schema";
import { ApiError } from "../errors";
import { acceptedClaim, getClaim, getPost, notify, notifyFollowers, notifyMatches, ownerPost, publicProfile, serializeClaim, serializePost } from "../queries";
import { cleanText, nowIso, paginate } from "../utils";

function conversation(db: Store, claimId: string, userId: string) {
  const c = getClaim(db, claimId);
  const p = getPost(db, c.publicationId);
  if (userId !== c.userId && userId !== p.userId) throw new ApiError(403, "FORBIDDEN", "No participás de este reclamo");
  if (c.estado !== "aceptado") throw new ApiError(409, "CLAIM_NOT_ACCEPTED", "La conversación se habilita al aceptar el reclamo");
  return { c, p };
}

export function interactionRoutes(db: AppDatabase) {
  return new Elysia()
    .post("/publicaciones/:id/reclamos", async ({ headers, params, body, set }) => {
      const user = await requireUser(db, headers);
      const mensaje = cleanText(body.mensaje, 5, "mensaje");
      const id = db.transaction((tx) => {
        const p = getPost(tx, params.id);
        if (p.userId === user.id) throw new ApiError(409, "OWN_PUBLICATION", "No podés reclamar tu propia publicación");
        if (p.estado !== "abierta") throw new ApiError(409, "PUBLICATION_NOT_OPEN", "La publicación no está abierta");
        const previous = tx.select().from(claims).where(and(eq(claims.publicationId, p.id), eq(claims.userId, user.id))).get();
        if (previous && ["pendiente", "aceptado"].includes(previous.estado)) throw new ApiError(409, "DUPLICATE_CLAIM", "Ya enviaste un reclamo");
        const now = nowIso();
        const id = previous?.id ?? crypto.randomUUID();
        if (previous) tx.update(claims).set({ mensaje, estado: "pendiente", updatedAt: now }).where(eq(claims.id, id)).run();
        else tx.insert(claims).values({ id, publicationId: p.id, userId: user.id, mensaje, createdAt: now, updatedAt: now }).run();
        notify(tx, p.userId, "reclamo", `Recibiste un reclamo en ${p.titulo}`, { publicationId: p.id, claimId: id });
        return id;
      });
      set.status = 201;
      const c = getClaim(db, id);
      return serializeClaim(db, c, getPost(db, c.publicationId), user.id);
    }, { body: t.Object({ mensaje: t.String({ minLength: 5, maxLength: 1000 }) }) })
    .get("/publicaciones/:id/reclamos", async ({ headers, params, query }) => {
      const user = await requireUser(db, headers);
      const p = ownerPost(db, params.id, user.id);
      const rows = db.select().from(claims).where(eq(claims.publicationId, p.id)).orderBy(desc(claims.createdAt), desc(claims.id)).all();
      const page = paginate(rows, query);
      return { ...page, items: page.items.map((c) => serializeClaim(db, c, p, user.id)) };
    })
    .get("/me/reclamos", async ({ headers, query }) => {
      const user = await requireUser(db, headers);
      const rows = db.select().from(claims).innerJoin(posts, eq(posts.id, claims.publicationId))
        .where(and(eq(claims.userId, user.id), isNull(posts.deletedAt)))
        .orderBy(desc(claims.updatedAt), desc(claims.id)).all();
      const page = paginate(rows, query);
      return { ...page, items: page.items.map((row) => ({
        ...serializeClaim(db, row.hallado_claims, row.hallado_publications, user.id),
        publicacion: serializePost(db, row.hallado_publications, user.id, true),
      })) };
    })
    .get("/reclamos/:id", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      const c = getClaim(db, params.id);
      const p = getPost(db, c.publicationId);
      if (user.id !== p.userId && user.id !== c.userId) throw new ApiError(403, "FORBIDDEN", "No participás de este reclamo");
      return { ...serializeClaim(db, c, p, user.id), publicacion: serializePost(db, p, user.id, true) };
    })
    .post("/reclamos/:id/aceptar", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      db.transaction((tx) => {
        const c = getClaim(tx, params.id);
        const p = ownerPost(tx, c.publicationId, user.id);
        if (p.estado !== "abierta" || c.estado !== "pendiente") throw new ApiError(409, "INVALID_CLAIM_STATE", "Solo podés aceptar un reclamo pendiente en una publicación abierta");
        const now = nowIso();
        tx.update(claims).set({ estado: "aceptado", updatedAt: now }).where(eq(claims.id, c.id)).run();
        tx.update(posts).set({ estado: "en_reclamo", updatedAt: now }).where(eq(posts.id, p.id)).run();
        notify(tx, c.userId, "reclamo", `Aceptaron tu reclamo en ${p.titulo}`, { publicationId: p.id, claimId: c.id });
        notifyFollowers(tx, p, `La publicación está en reclamo: ${p.titulo}`);
      });
      const c = getClaim(db, params.id);
      return serializeClaim(db, c, getPost(db, c.publicationId), user.id);
    })
    .post("/reclamos/:id/rechazar", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      db.transaction((tx) => {
        const c = getClaim(tx, params.id);
        const p = ownerPost(tx, c.publicationId, user.id);
        if (p.estado === "resuelta" || !["pendiente", "aceptado"].includes(c.estado)) throw new ApiError(409, "INVALID_CLAIM_STATE", "No podés rechazar ese reclamo");
        const now = nowIso();
        tx.update(claims).set({ estado: "rechazado", updatedAt: now }).where(eq(claims.id, c.id)).run();
        if (c.estado === "aceptado") {
          tx.update(posts).set({ estado: "abierta", updatedAt: now }).where(eq(posts.id, p.id)).run();
          notifyFollowers(tx, p, `La publicación volvió a estar abierta: ${p.titulo}`);
          notifyMatches(tx, { ...p, estado: "abierta" });
        }
        notify(tx, c.userId, "reclamo", `Rechazaron tu reclamo en ${p.titulo}`, { publicationId: p.id, claimId: c.id });
      });
      return { message: "Reclamo rechazado" };
    })
    .post("/reclamos/:id/cancelar", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      db.transaction((tx) => {
        const c = getClaim(tx, params.id);
        const p = getPost(tx, c.publicationId);
        if (c.userId !== user.id) throw new ApiError(403, "FORBIDDEN", "El reclamo pertenece a otra persona");
        if (p.estado === "resuelta" || !["pendiente", "aceptado"].includes(c.estado)) throw new ApiError(409, "INVALID_CLAIM_STATE", "No podés cancelar ese reclamo");
        const now = nowIso();
        tx.update(claims).set({ estado: "cancelado", updatedAt: now }).where(eq(claims.id, c.id)).run();
        if (c.estado === "aceptado") {
          tx.update(posts).set({ estado: "abierta", updatedAt: now }).where(eq(posts.id, p.id)).run();
          notifyFollowers(tx, p, `La publicación volvió a estar abierta: ${p.titulo}`);
          notifyMatches(tx, { ...p, estado: "abierta" });
        }
        notify(tx, p.userId, "reclamo", `Cancelaron un reclamo en ${p.titulo}`, { publicationId: p.id, claimId: c.id });
      });
      return { message: "Reclamo cancelado" };
    })
    .post("/publicaciones/:id/resolver", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      db.transaction((tx) => {
        const p = ownerPost(tx, params.id, user.id);
        const c = acceptedClaim(tx, p.id);
        if (p.estado !== "en_reclamo" || !c) throw new ApiError(409, "NO_ACCEPTED_CLAIM", "Para resolver, primero aceptá un reclamo");
        const now = nowIso();
        tx.update(posts).set({ estado: "resuelta", resolvedAt: now, updatedAt: now }).where(eq(posts.id, p.id)).run();
        for (const other of tx.select().from(claims).where(and(eq(claims.publicationId, p.id), eq(claims.estado, "pendiente"))).all()) {
          tx.update(claims).set({ estado: "rechazado", updatedAt: now }).where(eq(claims.id, other.id)).run();
          notify(tx, other.userId, "reclamo", `La publicación ya se resolvió: ${p.titulo}`, { publicationId: p.id, claimId: other.id });
        }
        notify(tx, c.userId, "devolucion", `Se concretó la devolución: ${p.titulo}`, { publicationId: p.id, claimId: c.id });
        notifyFollowers(tx, p, `Se resolvió: ${p.titulo}`);
      });
      return serializePost(db, getPost(db, params.id), user.id, true);
    })
    .post("/publicaciones/:id/valoraciones", async ({ headers, params, body, set }) => {
      const user = await requireUser(db, headers);
      const result = db.transaction((tx) => {
        const p = getPost(tx, params.id);
        const c = acceptedClaim(tx, p.id);
        if (p.estado !== "resuelta" || !c) throw new ApiError(409, "RETURN_NOT_COMPLETED", "Solo podés valorar una devolución concretada");
        if (user.id !== p.userId && user.id !== c.userId) throw new ApiError(403, "FORBIDDEN", "Solo pueden valorar las partes de la devolución");
        const previous = tx.select().from(halladoReviews).where(and(eq(halladoReviews.publicationId, p.id), eq(halladoReviews.reviewerId, user.id))).get();
        if (previous) throw new ApiError(409, "ALREADY_REVIEWED", "Ya valoraste esta devolución");
        const reviewedUserId = user.id === p.userId ? c.userId : p.userId;
        const review = { id: crypto.randomUUID(), publicationId: p.id, reviewerId: user.id, reviewedUserId,
          positiva: body.positiva, comentario: (body.comentario ?? "").trim(), createdAt: nowIso() };
        tx.insert(halladoReviews).values(review).run();
        notify(tx, reviewedUserId, "valoracion", "Recibiste una valoración por una devolución", { publicationId: p.id });
        return review;
      });
      set.status = 201;
      return { id: result.id, positiva: result.positiva, comentario: result.comentario, usuario: publicProfile(db, result.reviewedUserId) };
    }, { body: t.Object({ positiva: t.Boolean(), comentario: t.Optional(t.String({ maxLength: 500 })) }) })
    .get("/reclamos/:id/mensajes", async ({ headers, params, query }) => {
      const user = await requireUser(db, headers);
      conversation(db, params.id, user.id);
      const items = db.select().from(messages).where(eq(messages.claimId, params.id))
        .orderBy(asc(messages.createdAt), asc(messages.id)).all();
      return paginate(items.map((m) => ({ id: m.id, texto: m.texto, autorId: m.senderId, creadaEn: m.createdAt })), query);
    })
    .post("/reclamos/:id/mensajes", async ({ headers, params, body, set }) => {
      const user = await requireUser(db, headers);
      const texto = cleanText(body.texto, 1, "mensaje");
      const result = db.transaction((tx) => {
        const { c, p } = conversation(tx, params.id, user.id);
        const m = { id: crypto.randomUUID(), claimId: c.id, senderId: user.id, texto, createdAt: nowIso() };
        tx.insert(messages).values(m).run();
        notify(tx, user.id === c.userId ? p.userId : c.userId, "mensaje", "Recibiste un mensaje en un reclamo", { publicationId: p.id, claimId: c.id });
        return { id: m.id, texto, autorId: user.id, creadaEn: m.createdAt };
      });
      set.status = 201;
      return result;
    }, { body: t.Object({ texto: t.String({ minLength: 1, maxLength: 2000 }) }) });
}

