import { and, asc, count, desc, eq, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { optionalUser, requireUser } from "../auth";
import type { AppDatabase } from "../database";
import { favorites, publications, questions, savedSearches, users } from "../db/schema";
import { ApiError } from "../errors";
import { getCoverImages, getPublicUser, hasAcceptedOffer, listImages, replaceImages } from "../queries";
import {
  categories,
  categorySchema,
  conditionSchema,
  priceSchema,
  publicationStatusSchema,
  sortSchema,
} from "../types";
import { centsFromPrice, nowIso, parsePositiveInt, priceFromCents } from "../utils";

type Publication = typeof publications.$inferSelect;
type SavedSearch = typeof savedSearches.$inferSelect;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const UPLOADS_DIR = "uploads";
const UPLOAD_FILENAME_PATTERN = /^[a-f0-9-]+\.(jpg|jpeg|png|webp)$/i;

// El paso a paso de la carga guiada (consigna 5) vive enteramente en el cliente Android: la app
// guarda el progreso localmente (por eso "al volver encuentra el borrador conservado") y recién
// llama a la API una vez completo. Por eso acá no hay estado "draft" ni `draftStep`: todos estos
// campos son obligatorios tanto para crear como para editar una publicación.
const addressSchema = t.String({ minLength: 3, maxLength: 200 });
const createPublicationBody = t.Object({
  title: t.String({ minLength: 3, maxLength: 120 }),
  description: t.String({ minLength: 10, maxLength: 5000 }),
  category: categorySchema,
  price: priceSchema,
  condition: conditionSchema,
  // La zona se toma del perfil del usuario autenticado.
  address: addressSchema,
  imageUrls: t.Array(t.String({ format: "uri", maxLength: 2000 }), { minItems: 1, maxItems: 10 }),
});

const updatePublicationBody = t.Object({
  title: t.Optional(t.String({ minLength: 3, maxLength: 120 })),
  description: t.Optional(t.String({ minLength: 10, maxLength: 5000 })),
  category: t.Optional(categorySchema),
  price: t.Optional(priceSchema),
  condition: t.Optional(conditionSchema),
  address: t.Optional(addressSchema),
  imageUrls: t.Optional(t.Array(t.String({ format: "uri", maxLength: 2000 }), { minItems: 1, maxItems: 10 })),
});

const feedQuery = t.Object({
  page: t.Optional(t.String()),
  pageSize: t.Optional(t.String()),
  q: t.Optional(t.String({ maxLength: 200 })),
  category: t.Optional(categorySchema),
  condition: t.Optional(conditionSchema),
  zone: t.Optional(t.String({ maxLength: 100 })),
  minPrice: t.Optional(t.Numeric({ minimum: 0 })),
  maxPrice: t.Optional(t.Numeric({ minimum: 0 })),
  sort: t.Optional(sortSchema),
});

function matchesSearch(search: SavedSearch, publication: Publication, sellerZone: string | null) {
  const text = (search.queryText ?? "").toLowerCase();
  if (text && !`${publication.title} ${publication.description}`.toLowerCase().includes(text)) return false;
  if (search.category && search.category !== publication.category) return false;
  if (search.itemCondition && search.itemCondition !== publication.itemCondition) return false;
  if (search.zone && search.zone.toLowerCase() !== sellerZone?.toLowerCase()) return false;
  if (search.minPriceCents != null && (publication.priceCents ?? 0) < search.minPriceCents) return false;
  if (search.maxPriceCents != null && (publication.priceCents ?? 0) > search.maxPriceCents) return false;
  return true;
}

/** Suma una novedad a cada búsqueda guardada (ajena) que matchee la publicación recién activada. */
function notifySavedSearches(db: AppDatabase, publication: Publication, sellerZone: string | null) {
  const searches = db.select().from(savedSearches).where(ne(savedSearches.userId, publication.sellerId)).all();
  const matched = searches.filter((search) => matchesSearch(search, publication, sellerZone));
  if (matched.length === 0) return;
  db.transaction((tx) => {
    for (const search of matched) {
      tx.update(savedSearches)
        .set({ unreadCount: sql`${savedSearches.unreadCount} + 1` })
        .where(eq(savedSearches.id, search.id))
        .run();
    }
  });
}

/** Busca una publicación y valida que la request venga de su vendedor. */
function findOwnedPublication(db: AppDatabase, publicationId: string, userId: string, action: string) {
  const publication = db.select().from(publications).where(eq(publications.id, publicationId)).get();
  if (!publication) throw new ApiError(404, "PUBLICATION_NOT_FOUND", "Publicación no encontrada");
  if (publication.sellerId !== userId) throw new ApiError(403, "NOT_OWNER", `Solo el vendedor puede ${action}`);
  return publication;
}

export function publicationRoutes(db: AppDatabase) {
  return new Elysia()
    .get("/categories", () => ({ items: categories }))
    // Opciones reales para el filtro del feed: zonas de vendedores con publicaciones activas.
    .get("/zones", () => {
      const items = db
        .selectDistinct({ zone: users.zone })
        .from(publications)
        .innerJoin(users, eq(users.id, publications.sellerId))
        .where(and(eq(publications.status, "active"), isNotNull(users.zone)))
        .all()
        .map(({ zone }) => zone!)
        .sort((left, right) => left.localeCompare(right, "es", { sensitivity: "base" }));
      return { items };
    })
    // Consigna 3 (Explorar Publicaciones / Home): listado paginado con título, precio, estado
    // del artículo, zona y foto de portada; buscador de texto libre sobre título+descripción;
    // filtros combinados por categoría, rango de precio, estado y zona; orden por recientes,
    // menor o mayor precio. La "cercanía a la zona" se aproxima por coincidencia exacta de zona
    // (no hay coordenadas del usuario en este modelo de dominio; con ellas se podría calcular
    // distancia real igual que se hace con la dirección de la publicación).
    .get(
      "/publications",
      async ({ headers, query }) => {
        if (query.minPrice != null && query.maxPrice != null && query.minPrice > query.maxPrice)
          throw new ApiError(400, "INVALID_PRICE_RANGE", "El precio mínimo no puede superar al máximo");

        const viewer = await optionalUser(db, headers);
        const page = parsePositiveInt(query.page, 1, 10_000);
        const pageSize = parsePositiveInt(query.pageSize, 20, 50);

        const clauses: SQL[] = [eq(publications.status, "active")];
        if (query.q) {
          const pattern = `%${query.q.toLowerCase()}%`;
          clauses.push(
            sql`(lower(${publications.title}) LIKE ${pattern} OR lower(${publications.description}) LIKE ${pattern})`,
          );
        }
        if (query.category) clauses.push(eq(publications.category, query.category));
        if (query.condition) clauses.push(eq(publications.itemCondition, query.condition));
        if (query.zone) clauses.push(sql`lower(${users.zone}) = lower(${query.zone})`);
        if (query.minPrice != null) clauses.push(sql`${publications.priceCents} >= ${centsFromPrice(query.minPrice)}`);
        if (query.maxPrice != null) clauses.push(sql`${publications.priceCents} <= ${centsFromPrice(query.maxPrice)}`);
        const where = and(...clauses);

        const order =
          query.sort === "price_asc"
            ? asc(publications.priceCents)
            : query.sort === "price_desc"
              ? desc(publications.priceCents)
              : desc(publications.publishedAt);

        const total =
          db
            .select({ value: count() })
            .from(publications)
            .innerJoin(users, eq(users.id, publications.sellerId))
            .where(where)
            .get()?.value ?? 0;
        const rows = db
          .select({
            id: publications.id,
            title: publications.title,
            description: publications.description,
            category: publications.category,
            priceCents: publications.priceCents,
            itemCondition: publications.itemCondition,
            zone: users.zone,
            publishedAt: publications.publishedAt,
            sellerId: users.id,
            sellerName: users.name,
          })
          .from(publications)
          .innerJoin(users, eq(users.id, publications.sellerId))
          .where(where)
          .orderBy(order)
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .all();

        const covers = getCoverImages(db, rows.map((row) => row.id));
        const favoriteIds = new Set(
          viewer && rows.length > 0
            ? db
                .select({ publicationId: favorites.publicationId })
                .from(favorites)
                .where(
                  and(eq(favorites.userId, viewer.id), inArray(favorites.publicationId, rows.map((row) => row.id))),
                )
                .all()
                .map(({ publicationId }) => publicationId)
            : [],
        );
        const items = rows.map(({ priceCents, ...row }) => {
          const isOwner = !!viewer && row.sellerId === viewer.id;
          const canInteract = !!viewer && !isOwner;
          return {
            ...row,
            price: priceFromCents(priceCents),
            coverImage: covers.get(row.id) ?? null,
            isFavorite: favoriteIds.has(row.id),
            actions: {
              canAsk: canInteract,
              canOffer: canInteract,
              canFavorite: canInteract,
              canManage: isOwner,
            },
          };
        });
        return { items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
      },
      { query: feedQuery },
    )
    // Consigna 4 (Detalle de la Publicación): galería completa, descripción, categoría, estado,
    // precio y fecha de publicación; datos del vendedor con reputación y acceso a su perfil
    // público; acciones según quién mira (interesado vs. dueño). La dirección exacta
    // (`address`) se omite salvo que el que mira sea el vendedor o el
    // comprador cuya oferta ya fue aceptada ("no se puede ver la dirección exacta hasta que no
    // se efectúe [se acepte] la oferta del artículo").
    .get("/publications/:id", async ({ params, headers }) => {
      const publication = db.select().from(publications).where(eq(publications.id, params.id)).get();
      const viewer = await optionalUser(db, headers);
      const isOwner = !!viewer && viewer.id === publication?.sellerId;
      if (!publication) throw new ApiError(404, "PUBLICATION_NOT_FOUND", "Publicación no encontrada");

      const questionRows = db
        .select({
          id: questions.id,
          text: questions.text,
          answer: questions.answer,
          createdAt: questions.createdAt,
          answeredAt: questions.answeredAt,
          askerId: users.id,
          askerName: users.name,
        })
        .from(questions)
        .innerJoin(users, eq(users.id, questions.askerId))
        .where(eq(questions.publicationId, params.id))
        .orderBy(desc(questions.createdAt))
        .all();
      const isFavorite =
        !!viewer &&
        !!db
          .select({ userId: favorites.userId })
          .from(favorites)
          .where(and(eq(favorites.userId, viewer.id), eq(favorites.publicationId, params.id)))
          .get();

      const canInteract = !!viewer && !isOwner && publication.status === "active";
      const canViewAddress = isOwner || (!!viewer && hasAcceptedOffer(db, publication.id, viewer.id));
      const { priceCents, address, ...rest } = publication;
      return {
        ...rest,
        zone: getPublicUser(db, publication.sellerId)?.zone ?? null,
        price: priceFromCents(priceCents),
        images: listImages(db, params.id),
        seller: getPublicUser(db, publication.sellerId),
        questions: questionRows,
        isFavorite,
        address: canViewAddress ? address : null,
        addressLocked: !canViewAddress,
        actions: {
          canAsk: canInteract,
          canOffer: canInteract,
          canFavorite: canInteract,
          canManage: isOwner,
        },
      };
    })
    // Consigna 5: "Carga guiada en pasos" (fotos, título, descripción, categoría, precio, estado
    // y dirección exacta). La zona se hereda del perfil. El wizard y su borrador viven en el cliente Android ("si la persona
    // interrumpe la carga y sale de la app, al volver encuentra el borrador conservado para
    // retomarlo"); esta API recién se llama una vez, con la publicación completa, y queda activa
    // de inmediato.
    .post(
      "/publications",
      async ({ headers, body }) => {
        const user = await requireUser(db, headers);
        const id = crypto.randomUUID();
        const now = nowIso();
        db.insert(publications)
          .values({
            id,
            sellerId: user.id,
            title: body.title,
            description: body.description,
            category: body.category,
            priceCents: centsFromPrice(body.price)!,
            itemCondition: body.condition,
            address: body.address,
            status: "active",
            publishedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        replaceImages(db, id, body.imageUrls);

        const created = db.select().from(publications).where(eq(publications.id, id)).get()!;
        notifySavedSearches(db, created, user.zone);
        return { ...created, zone: user.zone, images: listImages(db, id) };
      },
      { body: createPublicationBody },
    )
    // Consigna 5: editar cualquier campo (incluida la dirección) de una publicación propia
    // mientras no esté vendida.
    .patch(
      "/publications/:id",
      async ({ params, headers, body }) => {
        const user = await requireUser(db, headers);
        const current = findOwnedPublication(db, params.id, user.id, "editarla");
        if (current.status === "sold")
          throw new ApiError(409, "PUBLICATION_SOLD", "Una publicación vendida no se puede editar");

        const priceCents = body.price === undefined ? current.priceCents : centsFromPrice(body.price)!;
        db.update(publications)
          .set({
            title: body.title ?? current.title,
            description: body.description ?? current.description,
            category: body.category ?? current.category,
            priceCents,
            itemCondition: body.condition ?? current.itemCondition,
            address: body.address ?? current.address,
            updatedAt: nowIso(),
          })
          .where(eq(publications.id, params.id))
          .run();
        if (body.imageUrls) replaceImages(db, params.id, body.imageUrls);
        // Un cambio de precio le avisa a quienes la tienen en favoritos.
        if (current.priceCents !== priceCents)
          db.update(favorites).set({ hasUpdate: true }).where(eq(favorites.publicationId, params.id)).run();

        const updated = db.select().from(publications).where(eq(publications.id, params.id)).get()!;
        return { ...updated, zone: user.zone, images: listImages(db, params.id) };
      },
      { body: updatePublicationBody },
    )
    // Consigna 5: "Mis publicaciones" — pausar y reactivar.
    .patch(
      "/publications/:id/status",
      async ({ params, headers, body }) => {
        const user = await requireUser(db, headers);
        const publication = findOwnedPublication(db, params.id, user.id, "cambiar el estado");
        const isValidTransition =
          (publication.status === "active" && body.status === "paused") ||
          (publication.status === "paused" && body.status === "active");
        if (!isValidTransition)
          throw new ApiError(409, "INVALID_STATUS_TRANSITION", "La publicación solo se puede pausar o reactivar");

        db.update(publications)
          .set({ status: body.status, updatedAt: nowIso() })
          .where(eq(publications.id, params.id))
          .run();
        return { id: params.id, status: body.status };
      },
      { body: t.Object({ status: t.Union([t.Literal("active"), t.Literal("paused")]) }) },
    )
    // Consigna 5: "Sección 'Mis publicaciones' con el estado de cada una (activa, pausada, vendida)".
    .get(
      "/me/publications",
      async ({ headers, query }) => {
        const user = await requireUser(db, headers);
        const where = query.status
          ? and(eq(publications.sellerId, user.id), eq(publications.status, query.status))
          : eq(publications.sellerId, user.id);
        const items = db
          .select()
          .from(publications)
          .where(where)
          .orderBy(desc(publications.createdAt))
          .all()
          .map((item) => ({ ...item, zone: user.zone, images: listImages(db, item.id) }));
        return { items };
      },
      { query: t.Object({ status: t.Optional(publicationStatusSchema) }) },
    )
    // Consigna 5 (fotos del artículo) y consigna 2 (foto de perfil): storage genérico de imágenes,
    // reutilizado por PATCH /me con la URL devuelta.
    .post(
      "/uploads/images",
      async ({ headers, body, request }) => {
        await requireUser(db, headers);
        const extension = EXTENSION_BY_MIME[body.file.type] ?? extname(body.file.name).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(extension))
          throw new ApiError(400, "INVALID_IMAGE", "Formato de imagen no soportado");

        mkdirSync(UPLOADS_DIR, { recursive: true });
        const filename = `${crypto.randomUUID()}${extension}`;
        await Bun.write(join(UPLOADS_DIR, filename), body.file);
        return { url: new URL(`/uploads/${filename}`, request.url).toString() };
      },
      { body: t.Object({ file: t.File({ type: "image", maxSize: "20m" }) }) },
    )
    .get("/uploads/:filename", ({ params }) => {
      // El nombre siempre lo generamos nosotros (uuid + extensión): cualquier otra cosa es path traversal.
      if (!UPLOAD_FILENAME_PATTERN.test(params.filename))
        throw new ApiError(404, "IMAGE_NOT_FOUND", "Imagen no encontrada");
      return Bun.file(join(UPLOADS_DIR, params.filename));
    });
}
