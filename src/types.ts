import { t } from "elysia";
export const CATEGORIES = ["Documentos", "Llaves", "Electrónica", "Mascotas", "Ropa", "Otros"] as const;
/** Los primeros seis no se reordenan: publicaciones, alertas y el seed dependen de sus nombres y posiciones. Sin nombres repetidos al ignorar tildes y mayúsculas. */
export const ZONES = [
  { nombre: "Centro", latitud: -34.6037, longitud: -58.3816 },
  { nombre: "Palermo", latitud: -34.5889, longitud: -58.4306 },
  { nombre: "Recoleta", latitud: -34.5875, longitud: -58.3937 },
  { nombre: "Belgrano", latitud: -34.5628, longitud: -58.4567 },
  { nombre: "Caballito", latitud: -34.6187, longitud: -58.4414 },
  { nombre: "Almagro", latitud: -34.6111, longitud: -58.4206 },
  // Barrios oficiales de CABA (el centro es aproximado).
  { nombre: "Agronomía", latitud: -34.5936, longitud: -58.4905 },
  { nombre: "Balvanera", latitud: -34.6094, longitud: -58.4003 },
  { nombre: "Barracas", latitud: -34.6445, longitud: -58.3697 },
  { nombre: "Boedo", latitud: -34.6285, longitud: -58.4180 },
  { nombre: "Chacarita", latitud: -34.5879, longitud: -58.4540 },
  { nombre: "Coghlan", latitud: -34.5600, longitud: -58.4750 },
  { nombre: "Colegiales", latitud: -34.5740, longitud: -58.4490 },
  { nombre: "Constitución", latitud: -34.6270, longitud: -58.3830 },
  { nombre: "Flores", latitud: -34.6280, longitud: -58.4620 },
  { nombre: "Floresta", latitud: -34.6310, longitud: -58.4850 },
  { nombre: "La Boca", latitud: -34.6345, longitud: -58.3630 },
  { nombre: "La Paternal", latitud: -34.5980, longitud: -58.4690 },
  { nombre: "Liniers", latitud: -34.6430, longitud: -58.5190 },
  { nombre: "Mataderos", latitud: -34.6600, longitud: -58.5030 },
  { nombre: "Monte Castro", latitud: -34.6170, longitud: -58.5040 },
  { nombre: "Montserrat", latitud: -34.6120, longitud: -58.3790 },
  { nombre: "Nueva Pompeya", latitud: -34.6500, longitud: -58.4130 },
  { nombre: "Núñez", latitud: -34.5450, longitud: -58.4630 },
  { nombre: "Parque Avellaneda", latitud: -34.6480, longitud: -58.4750 },
  { nombre: "Parque Chacabuco", latitud: -34.6350, longitud: -58.4350 },
  { nombre: "Parque Chas", latitud: -34.5860, longitud: -58.4780 },
  { nombre: "Parque Patricios", latitud: -34.6370, longitud: -58.4000 },
  { nombre: "Puerto Madero", latitud: -34.6118, longitud: -58.3636 },
  { nombre: "Retiro", latitud: -34.5920, longitud: -58.3740 },
  { nombre: "Saavedra", latitud: -34.5530, longitud: -58.4850 },
  { nombre: "San Cristóbal", latitud: -34.6240, longitud: -58.4000 },
  { nombre: "San Nicolás", latitud: -34.6040, longitud: -58.3880 },
  { nombre: "San Telmo", latitud: -34.6210, longitud: -58.3720 },
  { nombre: "Vélez Sársfield", latitud: -34.6360, longitud: -58.4890 },
  { nombre: "Versalles", latitud: -34.6290, longitud: -58.5190 },
  { nombre: "Villa Crespo", latitud: -34.5990, longitud: -58.4380 },
  { nombre: "Villa del Parque", latitud: -34.6100, longitud: -58.4860 },
  { nombre: "Villa Devoto", latitud: -34.6000, longitud: -58.5120 },
  { nombre: "Villa General Mitre", latitud: -34.6060, longitud: -58.4690 },
  { nombre: "Villa Lugano", latitud: -34.6870, longitud: -58.4670 },
  { nombre: "Villa Luro", latitud: -34.6350, longitud: -58.5050 },
  { nombre: "Villa Ortúzar", latitud: -34.5780, longitud: -58.4680 },
  { nombre: "Villa Pueyrredón", latitud: -34.5800, longitud: -58.5050 },
  { nombre: "Villa Real", latitud: -34.6170, longitud: -58.5210 },
  { nombre: "Villa Riachuelo", latitud: -34.6840, longitud: -58.4620 },
  { nombre: "Villa Santa Rita", latitud: -34.6130, longitud: -58.4780 },
  { nombre: "Villa Soldati", latitud: -34.6680, longitud: -58.4400 },
  { nombre: "Villa Urquiza", latitud: -34.5730, longitud: -58.4890 },
  // Localidades del Gran Buenos Aires.
  { nombre: "Vicente López", latitud: -34.5270, longitud: -58.4750 },
  { nombre: "Olivos", latitud: -34.5100, longitud: -58.4890 },
  { nombre: "Florida", latitud: -34.5280, longitud: -58.4890 },
  { nombre: "Munro", latitud: -34.5300, longitud: -58.5200 },
  { nombre: "San Isidro", latitud: -34.4710, longitud: -58.5270 },
  { nombre: "Martínez", latitud: -34.4920, longitud: -58.5030 },
  { nombre: "Boulogne", latitud: -34.4980, longitud: -58.5600 },
  { nombre: "Beccar", latitud: -34.4570, longitud: -58.5280 },
  { nombre: "Tigre", latitud: -34.4260, longitud: -58.5800 },
  { nombre: "Don Torcuato", latitud: -34.4960, longitud: -58.6170 },
  { nombre: "San Fernando", latitud: -34.4420, longitud: -58.5610 },
  { nombre: "San Martín", latitud: -34.5790, longitud: -58.5370 },
  { nombre: "Villa Ballester", latitud: -34.5490, longitud: -58.5550 },
  { nombre: "José León Suárez", latitud: -34.5330, longitud: -58.5810 },
  { nombre: "Caseros", latitud: -34.6100, longitud: -58.5640 },
  { nombre: "Ciudadela", latitud: -34.6360, longitud: -58.5400 },
  { nombre: "Morón", latitud: -34.6530, longitud: -58.6200 },
  { nombre: "Haedo", latitud: -34.6430, longitud: -58.5930 },
  { nombre: "Castelar", latitud: -34.6520, longitud: -58.6490 },
  { nombre: "Ituzaingó", latitud: -34.6600, longitud: -58.6670 },
  { nombre: "Hurlingham", latitud: -34.5890, longitud: -58.6370 },
  { nombre: "Merlo", latitud: -34.6650, longitud: -58.7270 },
  { nombre: "Moreno", latitud: -34.6340, longitud: -58.7900 },
  { nombre: "San Justo", latitud: -34.6810, longitud: -58.5620 },
  { nombre: "Ramos Mejía", latitud: -34.6420, longitud: -58.5640 },
  { nombre: "Avellaneda", latitud: -34.6620, longitud: -58.3650 },
  { nombre: "Sarandí", latitud: -34.6830, longitud: -58.3420 },
  { nombre: "Lanús", latitud: -34.7060, longitud: -58.3920 },
  { nombre: "Banfield", latitud: -34.7430, longitud: -58.3980 },
  { nombre: "Lomas de Zamora", latitud: -34.7600, longitud: -58.4040 },
  { nombre: "Temperley", latitud: -34.7830, longitud: -58.3930 },
  { nombre: "Adrogué", latitud: -34.7970, longitud: -58.3920 },
  { nombre: "Quilmes", latitud: -34.7200, longitud: -58.2540 },
  { nombre: "Bernal", latitud: -34.7130, longitud: -58.2800 },
  { nombre: "Berazategui", latitud: -34.7640, longitud: -58.2120 },
  { nombre: "Florencio Varela", latitud: -34.8130, longitud: -58.2790 },
  { nombre: "Monte Grande", latitud: -34.8160, longitud: -58.4690 },
  { nombre: "Ezeiza", latitud: -34.8550, longitud: -58.5230 },
  { nombre: "Pilar", latitud: -34.4580, longitud: -58.9140 },
  { nombre: "Escobar", latitud: -34.3480, longitud: -58.7940 },
  { nombre: "San Miguel", latitud: -34.5430, longitud: -58.7120 },
  { nombre: "La Plata", latitud: -34.9210, longitud: -57.9540 },
];
/**
 * Versión del catálogo (categorías y centros de barrio): huella FNV-1a (sobre las unidades UTF-16 del JSON) de su contenido, así cambia sola cuando cambia la
 * lista. Los endpoints de catálogo la envían en `x-catalogo-version` para que el cliente sepa qué copia guarda. El centro
 * de un barrio es una referencia para ordenar por cercanía, no la posición exacta de un suceso.
 */
export const CATALOG_VERSION_HEADER = "x-catalogo-version";
export const CATALOG_PATHS = new Set(["/categorias", "/categories", "/barrios", "/zones"]);
export function catalogVersion(categories: readonly string[] = CATEGORIES, zones: readonly { nombre: string; latitud: number; longitud: number }[] = ZONES) {
  const text = JSON.stringify({ categorias: categories, zonas: zones.map((z) => ({ nombre: z.nombre, latitud: z.latitud, longitud: z.longitud })) });
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}
export const CATALOG_VERSION = catalogVersion();
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
  // Verificación del publicador: obligatoria en "encontrado", se ignora en "perdido".
  preguntaVerificacion: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
  respuestaVerificacion: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
  // Identificador generado por el cliente para reintentar el alta sin duplicar (cola offline).
  clientId: t.Optional(t.String({ minLength: 8, maxLength: 100 })),
});
export type PublicationBody = typeof publicationBody.static;
export const claimBody = t.Object({
  mensaje: t.String({ minLength: 5, maxLength: 1000 }),
  respuestaVerificacion: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
  fotoPrueba: t.Optional(t.Union([t.String({ maxLength: 250 }), t.Null()])),
  barrio: t.Optional(t.Union([t.String({ maxLength: 100 }), t.Null()])),
});
