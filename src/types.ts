import { t } from "elysia";

export const categories = ["electronics", "home", "fashion", "sports", "vehicles", "books", "toys", "other"] as const;
export const conditions = ["new", "like_new", "used"] as const;
// Sin estado "draft": el borrador en progreso vive solo en el dispositivo (app nativa);
// el servidor recién ve la publicación cuando se envía completa y queda activa.
export const publicationStatuses = ["active", "paused", "sold"] as const;
export const sortOptions = ["recent", "price_asc", "price_desc"] as const;

export type Category = (typeof categories)[number];
export type Condition = (typeof conditions)[number];
export type PublicationStatus = (typeof publicationStatuses)[number];
export type SortOption = (typeof sortOptions)[number];

/** Construye un `t.Union` de literales a partir de una tupla de strings. */
const literalUnion = <T extends string>(values: readonly T[]) => t.Union(values.map((value) => t.Literal(value)));

export const categorySchema = literalUnion(categories);
export const conditionSchema = literalUnion(conditions);
export const publicationStatusSchema = literalUnion(publicationStatuses);
export const sortSchema = literalUnion(sortOptions);

/** Rango de precios aceptado en toda la API, en unidades de moneda (no centavos). */
export const priceSchema = t.Number({ minimum: 0.01, maximum: 999_999_999 });
export const zoneSchema = t.String({ minLength: 2, maxLength: 100 });
