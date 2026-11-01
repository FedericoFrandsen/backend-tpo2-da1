import { and, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { union } from "drizzle-orm/sqlite-core";
import { Elysia, t } from "elysia";
import { requireUser } from "../auth";
import type { AppDatabase } from "../database";
import { claims, halladoPublications as posts, halladoReviews, thanks } from "../db/schema";
import { ApiError } from "../errors";
import { acceptedClaim, getPost, publicProfile, publicProfiles } from "../queries";
import { cleanText, localDayBounds, nowIso, pageResult, pageWindow, reviewDeadline, validDate } from "../utils";

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
      const window = pageWindow(query);
      // Los días locales se convierten a instantes aquí y SQL compara texto ISO: no se usa el día UTC.
      const { from, until } = localDayBounds(desde, hasta);
      // Quién devolvió: quien publicó un hallazgo, o quien reclamó un objeto perdido.
      const returner = sql`CASE WHEN ${posts.tipo} = 'encontrado' THEN ${posts.userId} ELSE ${claims.userId} END`;
      // Solo las partes del caso lo ven: quien publicó o quien tiene el reclamo aceptado, cada rama por su índice.
      // Hay un único reclamo aceptado por publicación, así que el join con él no duplica filas.
      const involved = union(
        db.select({ id: posts.id }).from(posts).where(eq(posts.userId, user.id)),
        db.select({ id: claims.publicationId }).from(claims).where(and(eq(claims.userId, user.id), eq(claims.estado, "aceptado"))));
      const cases = and(eq(posts.estado, "resuelta"), isNull(posts.deletedAt), sql`${posts.resolvedAt} > ''`,
        inArray(posts.id, involved),
        tipo === "devolvi" ? sql`${returner} = ${user.id}` : tipo === "recupere" ? sql`${returner} <> ${user.id}` : undefined,
        from ? gte(posts.resolvedAt, from) : undefined, until ? lt(posts.resolvedAt, until) : undefined);
      const total = db.select({ n: count() }).from(posts)
        .innerJoin(claims, and(eq(claims.publicationId, posts.id), eq(claims.estado, "aceptado"))).where(cases).get()!.n;
      const rows = db.select({ id: posts.id, titulo: posts.titulo, categoria: posts.categoria, tipo: posts.tipo, ownerId: posts.userId,
        resolvedAt: posts.resolvedAt, claimantId: claims.userId }).from(posts)
        .innerJoin(claims, and(eq(claims.publicationId, posts.id), eq(claims.estado, "aceptado"))).where(cases)
        .orderBy(desc(posts.resolvedAt), desc(posts.id)).limit(window.pageSize).offset(window.offset).all();
      // Valoraciones, agradecimientos y perfiles de toda la página en consultas por lote, no una por caso.
      const ids = rows.map((r) => r.id);
      const reviews = new Map(!ids.length ? [] : db.select({ publicationId: halladoReviews.publicationId, positiva: halladoReviews.positiva, comentario: halladoReviews.comentario })
        .from(halladoReviews).where(and(inArray(halladoReviews.publicationId, ids), eq(halladoReviews.reviewerId, user.id))).all()
        .map((r) => [r.publicationId, { positiva: r.positiva, comentario: r.comentario }]));
      const gratitude = new Map(!ids.length ? [] : db.select({ publicationId: thanks.publicationId, mensaje: thanks.mensaje })
        .from(thanks).where(and(inArray(thanks.publicationId, ids), eq(thanks.authorId, user.id))).all()
        .map((r) => [r.publicationId, { mensaje: r.mensaje }]));
      const counterpart = (r: (typeof rows)[number]) => (r.ownerId === user.id ? r.claimantId : r.ownerId);
      const profiles = publicProfiles(db, rows.map(counterpart));
      return pageResult(rows.map((r) => {
        const returnerId = r.tipo === "encontrado" ? r.ownerId : r.claimantId;
        const valoracion = reviews.get(r.id) ?? null;
        const limiteValoracion = reviewDeadline(r.resolvedAt);
        const contraparte = profiles.get(counterpart(r));
        if (!contraparte) throw new ApiError(404, "USER_NOT_FOUND", "No encontramos el usuario");
        return {
          id: r.id, fecha: r.resolvedAt, tipo: returnerId === user.id ? "devolvi" : "recupere",
          objeto: { titulo: r.titulo, categoria: r.categoria, tipo: r.tipo },
          contraparte, valoracion, agradecimiento: gratitude.get(r.id) ?? null, limiteValoracion,
          puedeValorar: !valoracion && !!limiteValoracion && nowIso() <= limiteValoracion,
        };
      }), window, total);
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
      const window = pageWindow(query);
      const mine = eq(thanks.recipientId, params.id);
      const total = db.select({ n: count() }).from(thanks).where(mine).get()!.n;
      const rows = db.select({ id: thanks.id, mensaje: thanks.mensaje, createdAt: thanks.createdAt, authorId: thanks.authorId })
        .from(thanks).where(mine).orderBy(desc(thanks.createdAt), desc(thanks.id)).limit(window.pageSize).offset(window.offset).all();
      // Un autor puede repetirse en la página: sus perfiles se resuelven una sola vez y en lote, no uno por agradecimiento.
      const authors = publicProfiles(db, rows.map((r) => r.authorId));
      return pageResult(rows.map(({ authorId, ...item }) => {
        const autor = authors.get(authorId);
        if (!autor) throw new ApiError(404, "USER_NOT_FOUND", "No encontramos el usuario");
        return { ...item, autor };
      }), window, total);
    });
}
