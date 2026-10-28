import { and, desc, eq, isNull, or } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { requireUser } from "../auth";
import type { AppDatabase } from "../database";
import { claims, halladoPublications as posts, halladoReviews, thanks } from "../db/schema";
import { ApiError } from "../errors";
import { acceptedClaim, getPost, publicProfile } from "../queries";
import { cleanText, localDate, nowIso, paginate, reviewDeadline, validDate } from "../utils";

export function historyRoutes(db: AppDatabase) {
  return new Elysia()
    .get("/me/historial", async ({ headers, query }) => {
      const user = await requireUser(db, headers);
      const { tipo, desde, hasta } = query;
      if (tipo && !["devolvi", "recupere"].includes(tipo)) {
        throw new ApiError(422, "INVALID_TYPE", "El tipo debe ser devolvi o recupere");
      }
      if ((desde && !validDate(desde)) || (hasta && !validDate(hasta)) || (desde && hasta && desde > hasta)) {
        throw new ApiError(422, "INVALID_DATE_RANGE", "Revisá el rango de fechas (AAAA-MM-DD)");
      }
      const rows = db.select({ post: posts, claim: claims }).from(posts)
        .innerJoin(claims, and(eq(claims.publicationId, posts.id), eq(claims.estado, "aceptado")))
        .where(and(eq(posts.estado, "resuelta"), isNull(posts.deletedAt),
          or(eq(posts.userId, user.id), eq(claims.userId, user.id))))
        .orderBy(desc(posts.resolvedAt), desc(posts.id)).all();
      const cases = rows.filter(({ post, claim }) => {
        if (!post.resolvedAt) return false;
        const returner = post.tipo === "encontrado" ? post.userId : claim.userId;
        const caseType = returner === user.id ? "devolvi" : "recupere";
        const date = localDate(new Date(post.resolvedAt));
        return (!tipo || tipo === caseType) && (!desde || date >= desde) && (!hasta || date <= hasta);
      });
      const page = paginate(cases, query);
      return { ...page, items: page.items.map(({ post, claim }) => {
        const returner = post.tipo === "encontrado" ? post.userId : claim.userId;
        const valoracion = db.select({ positiva: halladoReviews.positiva, comentario: halladoReviews.comentario })
          .from(halladoReviews).where(and(eq(halladoReviews.publicationId, post.id), eq(halladoReviews.reviewerId, user.id))).get();
        const agradecimiento = db.select({ mensaje: thanks.mensaje }).from(thanks)
          .where(and(eq(thanks.publicationId, post.id), eq(thanks.authorId, user.id))).get();
        const limiteValoracion = reviewDeadline(post.resolvedAt);
        return {
          id: post.id, fecha: post.resolvedAt, tipo: returner === user.id ? "devolvi" : "recupere",
          objeto: { titulo: post.titulo, categoria: post.categoria, tipo: post.tipo },
          contraparte: publicProfile(db, post.userId === user.id ? claim.userId : post.userId),
          valoracion: valoracion ?? null, agradecimiento: agradecimiento ?? null, limiteValoracion,
          puedeValorar: !valoracion && !!limiteValoracion && nowIso() <= limiteValoracion,
        };
      }) };
    })
    .post("/publicaciones/:id/agradecimientos", async ({ headers, params, body, set }) => {
      const user = await requireUser(db, headers);
      const mensaje = cleanText(body.mensaje, 1, "agradecimiento");
      const result = db.transaction((tx) => {
        const post = getPost(tx, params.id);
        const claim = acceptedClaim(tx, post.id);
        if (post.estado !== "resuelta" || !claim) {
          throw new ApiError(409, "RETURN_NOT_COMPLETED", "Primero debe concretarse la devolución");
        }
        const recoverer = post.tipo === "encontrado" ? claim.userId : post.userId;
        if (user.id !== recoverer) throw new ApiError(403, "FORBIDDEN", "Solo quien recuperó el objeto puede agradecer");
        if (tx.select().from(thanks).where(eq(thanks.publicationId, post.id)).get()) {
          throw new ApiError(409, "ALREADY_THANKED", "Ya agradeciste esta devolución");
        }
        const record = { id: crypto.randomUUID(), publicationId: post.id, authorId: user.id,
          recipientId: post.tipo === "encontrado" ? post.userId : claim.userId, mensaje, createdAt: nowIso() };
        tx.insert(thanks).values(record).run();
        return { id: record.id, mensaje: record.mensaje, createdAt: record.createdAt };
      });
      set.status = 201;
      return result;
    }, { body: t.Object({ mensaje: t.String({ minLength: 1, maxLength: 500 }) }) })
    .get("/usuarios/:id/agradecimientos", ({ params, query }) => {
      publicProfile(db, params.id);
      const rows = db.select({ id: thanks.id, mensaje: thanks.mensaje, createdAt: thanks.createdAt, authorId: thanks.authorId })
        .from(thanks).where(eq(thanks.recipientId, params.id)).orderBy(desc(thanks.createdAt), desc(thanks.id)).all();
      const page = paginate(rows, query);
      return { ...page, items: page.items.map(({ authorId, ...item }) => ({ ...item, autor: publicProfile(db, authorId) })) };
    });
}
