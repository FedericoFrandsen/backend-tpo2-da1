import { and, desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { requireUser } from "../auth";
import type { AppDatabase } from "../database";
import { halladoReviews, users, uploads } from "../db/schema";
import { ApiError } from "../errors";
import { privateProfile, publicProfile, zoneName } from "../queries";
import { cleanText, paginate } from "../utils";

/**
 * Barrio del perfil: del catálogo (se guarda el nombre canónico) o vacío. Reenviar sin cambios el valor que la persona ya
 * tenía no falla, para no bloquear perfiles con el texto libre de antes.
 */
function profileZone(value: string | null, current: string | null) {
  const zone = value?.trim();
  if (!zone) return null;
  const canonical = zoneName(zone);
  if (canonical) return canonical;
  if (zone === current?.trim()) return current;
  throw new ApiError(422, "INVALID_BARRIO", "Elegí un barrio de la lista");
}
const nullableText = (maxLength: number) => t.Union([t.String({ maxLength }), t.Null()]);
export function userRoutes(db: AppDatabase) {
  const getPublic = (id: string) => publicProfile(db, id);
  const getReviews = (id: string, query: Record<string, string | undefined>) => {
    publicProfile(db, id);
    const items = db.select({ id: halladoReviews.id, positiva: halladoReviews.positiva,
      comentario: halladoReviews.comentario, createdAt: halladoReviews.createdAt, reviewerId: halladoReviews.reviewerId })
      .from(halladoReviews).where(eq(halladoReviews.reviewedUserId, id))
      .orderBy(desc(halladoReviews.createdAt), desc(halladoReviews.id)).all()
      .map(({ reviewerId, ...r }) => ({ ...r, autor: publicProfile(db, reviewerId) }));
    return paginate(items, query);
  };
  return new Elysia()
    .get("/me", async ({ headers }) => privateProfile(db, (await requireUser(db, headers)).id))
    .patch("/me", async ({ headers, body }) => {
      const user = await requireUser(db, headers);
      if (body.avatarUrl) {
        if (!/^\/uploads\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(body.avatarUrl)) {
          throw new ApiError(422, "INVALID_AVATAR", "Primero subí la foto a /uploads/images");
        }
        const image = db.select().from(uploads).where(and(eq(uploads.filename, body.avatarUrl.slice(9)), eq(uploads.userId, user.id), eq(uploads.tipo, "imagen"))).get();
        if (!image) throw new ApiError(403, "IMAGE_NOT_OWNED", "La foto no pertenece a tu cuenta");
      }
      const changes = {
        ...(body.name !== undefined ? { name: cleanText(body.name, 2, "nombre") } : {}),
        ...(body.zone !== undefined ? { zone: profileZone(body.zone, user.zone) } : {}),
        ...(body.phone !== undefined ? { phone: body.phone?.trim() || null } : {}),
        ...(body.sharePhone !== undefined ? { sharePhone: body.sharePhone } : {}),
        ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
      };
      if (Object.keys(changes).length) db.update(users).set(changes).where(eq(users.id, user.id)).run();
      return privateProfile(db, user.id);
    }, { body: t.Object({
      name: t.Optional(t.String({ minLength: 2, maxLength: 80 })),
      zone: t.Optional(nullableText(100)), phone: t.Optional(nullableText(30)),
      sharePhone: t.Optional(t.Boolean()), avatarUrl: t.Optional(nullableText(250)),
    }) })
    .get("/usuarios/:id", ({ params }) => getPublic(params.id))
    .get("/users/:id", ({ params }) => getPublic(params.id))
    .get("/usuarios/:id/valoraciones", ({ params, query }) => getReviews(params.id, query))
    .get("/users/:id/reviews", ({ params, query }) => getReviews(params.id, query));
}
