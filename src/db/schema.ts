import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Consigna 2 (Perfil y Reputación): datos personales editables, incluida la foto de perfil.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  username: text("username").unique(),
  passwordHash: text("password_hash"),
  name: text("name").notNull(),
  phone: text("phone"),
  zone: text("zone"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull(),
  emailVerifiedAt: text("email_verified_at").notNull(),
});

export const otpCodes = sqliteTable("otp_codes", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  purpose: text("purpose", { enum: ["registration", "login", "set_password"] }).notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check("otp_purpose_check", sql`${table.purpose} IN ('registration', 'login', 'set_password')`),
  index("idx_otp_email_purpose").on(table.email, table.purpose, table.createdAt),
]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_sessions_token").on(table.tokenHash)]);

// Consigna 5 (Publicar un artículo): se guarda la dirección exacta. La zona no se duplica acá:
// siempre se obtiene del perfil del vendedor.
// Consigna 4/7 (Detalle / Ofertas): address solo se expone al vendedor y al comprador cuya
// oferta fue aceptada (ver `canViewAddress` en routes/publications.ts).
export const publications = sqliteTable("publications", {
  id: text("id").primaryKey(),
  sellerId: text("seller_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Ya no hay borrador server-side: una publicación siempre se crea completa, así que estos
  // campos son obligatorios (a diferencia de cuando existía el estado "draft").
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  priceCents: integer("price_cents").notNull(),
  itemCondition: text("item_condition", { enum: ["new", "like_new", "used"] }).notNull(),
  address: text("address").notNull(),
  // Sin estado "draft": el alta guiada vive en el cliente Android y solo llega al servidor
  // cuando está completa, ya como "active" (ver POST /publications).
  status: text("status", { enum: ["active", "paused", "sold"] }).notNull(),
  publishedAt: text("published_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("publication_condition_check", sql`${table.itemCondition} IN ('new', 'like_new', 'used')`),
  check("publication_status_check", sql`${table.status} IN ('active', 'paused', 'sold')`),
  index("idx_publications_feed").on(table.status, table.publishedAt),
  index("idx_publications_seller").on(table.sellerId, table.status),
]);

export const publicationImages = sqliteTable("publication_images", {
  id: text("id").primaryKey(),
  publicationId: text("publication_id").notNull().references(() => publications.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  position: integer("position").notNull(),
}, (table) => [uniqueIndex("publication_image_position_unique").on(table.publicationId, table.position)]);

export const favorites = sqliteTable("favorites", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  publicationId: text("publication_id").notNull().references(() => publications.id, { onDelete: "cascade" }),
  savedPriceCents: integer("saved_price_cents"),
  hasUpdate: integer("has_update", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.publicationId] })]);

export const savedSearches = sqliteTable("saved_searches", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  queryText: text("query_text"),
  category: text("category"),
  minPriceCents: integer("min_price_cents"),
  maxPriceCents: integer("max_price_cents"),
  itemCondition: text("item_condition", { enum: ["new", "like_new", "used"] }),
  zone: text("zone"),
  sort: text("sort", { enum: ["recent", "price_asc", "price_desc"] }).notNull().default("recent"),
  unreadCount: integer("unread_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  lastCheckedAt: text("last_checked_at").notNull(),
});

export const questions = sqliteTable("questions", {
  id: text("id").primaryKey(),
  publicationId: text("publication_id").notNull().references(() => publications.id, { onDelete: "cascade" }),
  askerId: text("asker_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  answer: text("answer"),
  createdAt: text("created_at").notNull(),
  answeredAt: text("answered_at"),
});

// Consigna 7 (Ofertas y Negociación): precio propuesto + mensaje opcional, contraoferta del
// vendedor (counterAmountCents) y vencimiento automático (expiresAt + status "expired").
export const offers = sqliteTable("offers", {
  id: text("id").primaryKey(),
  publicationId: text("publication_id").notNull().references(() => publications.id, { onDelete: "cascade" }),
  buyerId: text("buyer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
  message: text("message"),
  counterAmountCents: integer("counter_amount_cents"),
  status: text("status", {
    enum: ["pending", "countered", "accepted", "rejected", "expired", "cancelled"],
  }).notNull(),
  // Novedades sin leer por cada parte (nueva oferta, contraoferta, cambio de estado); se limpian con POST /me/offers/read.
  buyerHasUpdate: integer("buyer_has_update", { mode: "boolean" }).notNull().default(false),
  sellerHasUpdate: integer("seller_has_update", { mode: "boolean" }).notNull().default(false),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check(
    "offer_status_check",
    sql`${table.status} IN ('pending', 'countered', 'accepted', 'rejected', 'expired', 'cancelled')`,
  ),
]);

export const operations = sqliteTable("operations", {
  id: text("id").primaryKey(),
  publicationId: text("publication_id").notNull().unique().references(() => publications.id),
  offerId: text("offer_id").notNull().unique().references(() => offers.id),
  buyerId: text("buyer_id").notNull().references(() => users.id),
  sellerId: text("seller_id").notNull().references(() => users.id),
  amountCents: integer("amount_cents").notNull(),
  completedAt: text("completed_at").notNull(),
});

export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  operationId: text("operation_id").notNull().references(() => operations.id, { onDelete: "cascade" }),
  reviewerId: text("reviewer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reviewedUserId: text("reviewed_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check("review_rating_check", sql`${table.rating} BETWEEN 1 AND 5`),
  uniqueIndex("review_operation_reviewer_unique").on(table.operationId, table.reviewerId),
  index("idx_reviews_reviewed_user").on(table.reviewedUserId),
]);
