import { and, count, desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { requireUser } from "../auth";
import type { AppDatabase } from "../database";
import { operations, publications, reviews, users } from "../db/schema";
import { ApiError } from "../errors";
import { getCoverImages, getPublicUser } from "../queries";
import { zoneSchema } from "../types";
import { normalizeEmail, parsePositiveInt, priceFromCents } from "../utils";

const profileColumns = {
  id: users.id,
  email: users.email,
  username: users.username,
  name: users.name,
  phone: users.phone,
  zone: users.zone,
  avatarUrl: users.avatarUrl,
  createdAt: users.createdAt,
};

const updateProfileBody = t.Object({
  name: t.Optional(t.String({ minLength: 2, maxLength: 80 })),
  email: t.Optional(t.String({ format: "email", maxLength: 254 })),
  phone: t.Optional(t.Nullable(t.String({ minLength: 6, maxLength: 30 }))),
  zone: t.Optional(t.Nullable(zoneSchema)),
  // La URL sale de subir la foto a POST /uploads/images (igual que las fotos de publicaciones).
  avatarUrl: t.Optional(t.Nullable(t.String({ format: "uri", maxLength: 2000 }))),
});

export function userRoutes(db: AppDatabase) {
  return new Elysia()
    // Consigna 2: "Ver ... los datos personales" + reputación propia.
    .get("/me", async ({ headers }) => {
      const user = await requireUser(db, headers);
      const credentials = db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, user.id))
        .get()!;
      return {
        ...user,
        hasPassword: credentials.passwordHash !== null,
        reputation: getPublicUser(db, user.id),
      };
    })
    // Consigna 2: "editar los datos personales: nombre, email, teléfono de contacto, zona y foto de perfil".
    .patch(
      "/me",
      async ({ headers, body }) => {
        const user = await requireUser(db, headers);
        const current = db
          .select({ email: users.email, name: users.name, phone: users.phone, zone: users.zone, avatarUrl: users.avatarUrl })
          .from(users)
          .where(eq(users.id, user.id))
          .get()!;

        // `phone`, `zone` y `avatarUrl` son nullables: distinguimos "no lo mandaron" de "lo mandaron en null".
        const next = {
          name: body.name ?? current.name,
          email: body.email ? normalizeEmail(body.email) : current.email,
          phone: ("phone" in body ? body.phone : current.phone) ?? null,
          zone: ("zone" in body ? body.zone : current.zone) ?? null,
          avatarUrl: ("avatarUrl" in body ? body.avatarUrl : current.avatarUrl) ?? null,
        };

        try {
          db.update(users).set(next).where(eq(users.id, user.id)).run();
        } catch (error) {
          if (String(error).includes("users.email"))
            throw new ApiError(409, "EMAIL_ALREADY_REGISTERED", "El email ya está registrado");
          throw error;
        }
        return db.select(profileColumns).from(users).where(eq(users.id, user.id)).get();
      },
      { body: updateProfileBody },
    )
    // Consigna 2: "Antes de operar, cualquier persona puede consultar el perfil público de la
    // otra parte, donde se muestran su reputación, su antigüedad ... y sus publicaciones activas".
    .get("/users/:id", ({ params }) => {
      const profile = getPublicUser(db, params.id);
      if (!profile) throw new ApiError(404, "USER_NOT_FOUND", "Usuario no encontrado");

      const rows = db
        .select({
          id: publications.id,
          title: publications.title,
          priceCents: publications.priceCents,
          itemCondition: publications.itemCondition,
          zone: users.zone,
          publishedAt: publications.publishedAt,
        })
        .from(publications)
        .innerJoin(users, eq(users.id, publications.sellerId))
        .where(and(eq(publications.sellerId, params.id), eq(publications.status, "active")))
        .orderBy(desc(publications.publishedAt))
        .all();
      const covers = getCoverImages(db, rows.map((row) => row.id));

      const activePublications = rows.map(({ priceCents, ...row }) => ({
        ...row,
        price: priceFromCents(priceCents),
        coverImage: covers.get(row.id) ?? null,
      }));
      return { ...profile, activePublications };
    })
    // Consigna 2: las calificaciones recibidas quedan visibles en el perfil público, paginadas.
    // `operationType` es el rol del calificado en la operación: "sell" si lo calificaron como vendedor, "buy" como comprador.
    .get(
      "/users/:id/reviews",
      ({ params, query }) => {
        if (!db.select({ id: users.id }).from(users).where(eq(users.id, params.id)).get())
          throw new ApiError(404, "USER_NOT_FOUND", "Usuario no encontrado");

        const page = parsePositiveInt(query.page, 1, 10_000);
        const pageSize = parsePositiveInt(query.pageSize, 20, 50);
        const where = eq(reviews.reviewedUserId, params.id);

        const total = db.select({ value: count() }).from(reviews).where(where).get()?.value ?? 0;
        const rows = db
          .select({
            id: reviews.id,
            rating: reviews.rating,
            comment: reviews.comment,
            createdAt: reviews.createdAt,
            reviewerName: users.name,
            sellerId: operations.sellerId,
          })
          .from(reviews)
          .innerJoin(users, eq(users.id, reviews.reviewerId))
          .innerJoin(operations, eq(operations.id, reviews.operationId))
          .where(where)
          .orderBy(desc(reviews.createdAt), desc(reviews.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .all();

        const items = rows.map(({ sellerId, ...row }) => ({
          ...row,
          operationType: sellerId === params.id ? "sell" : "buy",
        }));
        return { items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
      },
      { query: t.Object({ page: t.Optional(t.String()), pageSize: t.Optional(t.String()) }) },
    );
}
