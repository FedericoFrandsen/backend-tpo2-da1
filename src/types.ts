import { t } from "elysia";
export const CATEGORIES = ["Documentos", "Llaves", "Electrónica", "Mascotas", "Ropa", "Otros"] as const;
export const ZONES = [
  { nombre: "Centro", latitud: -34.6037, longitud: -58.3816 },
  { nombre: "Palermo", latitud: -34.5889, longitud: -58.4306 },
  { nombre: "Recoleta", latitud: -34.5875, longitud: -58.3937 },
  { nombre: "Belgrano", latitud: -34.5628, longitud: -58.4567 },
  { nombre: "Caballito", latitud: -34.6187, longitud: -58.4414 },
  { nombre: "Almagro", latitud: -34.6111, longitud: -58.4206 },
];
export const categorySchema = t.Union(CATEGORIES.map((v) => t.Literal(v)));
export const locationSchema = t.Object({
  latitud: t.Number({ minimum: -90, maximum: 90 }),
  longitud: t.Number({ minimum: -180, maximum: 180 }),
});
export const filtersSchema = t.Object({
  situacion: t.Union([t.Literal("perdi"), t.Literal("encontre")]),
  categoria: categorySchema,
  palabras: t.Optional(t.String({ maxLength: 200 })),
  zona: t.Optional(t.String({ maxLength: 100 })),
  periodo: t.Union([t.Literal("hoy"), t.Literal("tresDias"), t.Literal("semana"), t.Literal("rango")]),
  desde: t.Optional(t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
  hasta: t.Optional(t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
  ubicacion: t.Optional(t.Union([locationSchema, t.Null()])),
  radioKm: t.Optional(t.Number({ minimum: 0.1, maximum: 500 })),
});
export type SearchFilters = typeof filtersSchema.static;
export const publicationBody = t.Object({
  tipo: t.Union([t.Literal("perdi"), t.Literal("encontre"), t.Literal("perdido"), t.Literal("encontrado")]),
  titulo: t.String({ minLength: 3, maxLength: 80 }),
  descripcion: t.String({ minLength: 10, maxLength: 2000 }),
  categoria: categorySchema,
  barrio: t.Optional(t.String({ maxLength: 100 })),
  ubicacion: t.Optional(t.Union([locationSchema, t.Null()])),
  fecha: t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  franja: t.Union([t.Literal("manana"), t.Literal("tarde"), t.Literal("noche")]),
  direccionExacta: t.Optional(t.Union([t.String({ maxLength: 250 }), t.Null()])),
  fotos: t.Optional(t.Array(t.String({ maxLength: 250 }), { maxItems: 5, uniqueItems: true })),
});
export type PublicationBody = typeof publicationBody.static;
