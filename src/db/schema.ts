import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./legacy";
import { CATEGORIES } from "../types";
export * from "./legacy";

export const halladoPublications = sqliteTable("hallado_publications", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  tipo: text("tipo", { enum: ["perdido", "encontrado"] }).notNull(),
  titulo: text("titulo").notNull(),
  descripcion: text("descripcion").notNull(),
  categoria: text("categoria", { enum: CATEGORIES }).notNull(),
  barrio: text("barrio").notNull(),
  fecha: text("fecha").notNull(),
  franja: text("franja", { enum: ["manana", "tarde", "noche"] }).notNull(),
  latitud: real("latitud").notNull(),
  longitud: real("longitud").notNull(),
  direccionExacta: text("direccion_exacta"),
  fotos: text("fotos", { mode: "json" }).$type<string[]>().notNull().default([]),
  estado: text("estado", { enum: ["abierta", "en_reclamo", "resuelta"] }).notNull().default("abierta"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  resolvedAt: text("resolved_at"),
  deletedAt: text("deleted_at"),
}, (t) => [
  check("hallado_tipo_check", sql`${t.tipo} IN ('perdido','encontrado')`),
  check("hallado_estado_check", sql`${t.estado} IN ('abierta','en_reclamo','resuelta')`),
  check("hallado_franja_check", sql`${t.franja} IN ('manana','tarde','noche')`),
  index("hallado_busqueda_idx").on(t.tipo, t.categoria, t.fecha),
  index("hallado_propias_idx").on(t.userId, t.createdAt),
]);

export const claims = sqliteTable("hallado_claims", {
  id: text("id").primaryKey(),
  publicationId: text("publication_id").notNull().references(() => halladoPublications.id),
  userId: text("user_id").notNull().references(() => users.id),
  mensaje: text("mensaje").notNull(),
  estado: text("estado", { enum: ["pendiente", "aceptado", "rechazado", "cancelado", "vencido"] }).notNull().default("pendiente"),
  intentos: integer("intentos").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("hallado_reclamo_usuario_unique").on(t.publicationId, t.userId),
  uniqueIndex("hallado_aceptado_unique").on(t.publicationId).where(sql`${t.estado} = 'aceptado'`),
  check("hallado_reclamo_estado_check", sql`${t.estado} IN ('pendiente','aceptado','rechazado','cancelado','vencido')`),
]);

export const follows = sqliteTable("hallado_follows", {
  publicationId: text("publication_id").notNull().references(() => halladoPublications.id),
  userId: text("user_id").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
}, (t) => [primaryKey({ columns: [t.publicationId, t.userId] })]);

export const halladoReviews = sqliteTable("hallado_reviews", {
  id: text("id").primaryKey(),
  publicationId: text("publication_id").notNull().references(() => halladoPublications.id),
  reviewerId: text("reviewer_id").notNull().references(() => users.id),
  reviewedUserId: text("reviewed_user_id").notNull().references(() => users.id),
  positiva: integer("positiva", { mode: "boolean" }).notNull(),
  comentario: text("comentario").notNull().default(""),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("hallado_valoracion_unique").on(t.publicationId, t.reviewerId),
  index("hallado_valorado_idx").on(t.reviewedUserId),
]);

export const alerts = sqliteTable("hallado_alerts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  clave: text("clave").notNull(),
  filtros: text("filtros", { mode: "json" }).$type<import("../types").SearchFilters>().notNull(),
  activa: integer("activa", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
}, (t) => [uniqueIndex("hallado_alerta_unique").on(t.userId, t.clave)]);

export const searchHistory = sqliteTable("hallado_search_history", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  clave: text("clave").notNull(),
  filtros: text("filtros", { mode: "json" }).$type<import("../types").SearchFilters>().notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [uniqueIndex("hallado_historial_unique").on(t.userId, t.clave)]);

export const notifications = sqliteTable("hallado_notifications", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  tipo: text("tipo").notNull(),
  mensaje: text("mensaje").notNull(),
  publicationId: text("publication_id").references(() => halladoPublications.id),
  claimId: text("claim_id").references(() => claims.id),
  alertId: text("alert_id").references(() => alerts.id, { onDelete: "cascade" }),
  dedupeKey: text("dedupe_key").unique(),
  readAt: text("read_at"),
  createdAt: text("created_at").notNull(),
}, (t) => [index("hallado_notificacion_usuario_idx").on(t.userId, t.createdAt)]);

export const messages = sqliteTable("hallado_messages", {
  id: text("id").primaryKey(),
  claimId: text("claim_id").notNull().references(() => claims.id),
  senderId: text("sender_id").notNull().references(() => users.id),
  texto: text("texto").notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [index("hallado_mensaje_reclamo_idx").on(t.claimId, t.createdAt)]);

export const uploads = sqliteTable("hallado_uploads", {
  filename: text("filename").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  contentType: text("content_type").notNull(),
  createdAt: text("created_at").notNull(),
});

export const loginAttempts = sqliteTable("hallado_login_attempts", {
  login: text("login").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  windowStart: text("window_start").notNull(),
});
