import { config } from "./config";
import { ApiError } from "./errors";

export const nowIso = () => new Date().toISOString();
export function reviewDeadline(resolvedAt: string | null) {
  const time = resolvedAt ? Date.parse(resolvedAt) : NaN;
  return Number.isFinite(time) ? new Date(time + 7 * 24 * 60 * 60 * 1000).toISOString() : null;
}
export const PUBLICATION_TTL_DAYS = 30;
/** Fecha de vencimiento de una publicación: `desde` (por defecto ahora) + 30 días. */
export const publicationExpiry = (desde = Date.now()) => new Date(desde + PUBLICATION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const normalizeText = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function localDate(date = new Date(), timeZone: string = config.timeZone) {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  return ["year", "month", "day"].map((p) => parts.find((v) => v.type === p)!.value).join("-");
}
const HOUR = 60 * 60 * 1000;
/** Primer instante (ISO) cuya fecha local es `day` o posterior. Fuera de 1000..9999 no hay límite que aplicar a fechas ISO. */
function localDayStartIso(day: string, timeZone: string) {
  if (day < "1000-01-01" || day > "9999-12-31") return undefined;
  const midnightUtc = Date.parse(`${day}T00:00:00Z`);
  // Los husos van de UTC-12 a UTC+14: el inicio del día local cae siempre dentro de esta ventana (con margen para horario de verano).
  let before = midnightUtc - 26 * HOUR, from = midnightUtc + 26 * HOUR;
  while (from - before > 1) {
    const middle = Math.floor((before + from) / 2);
    if (localDate(new Date(middle), timeZone) >= day) from = middle; else before = middle;
  }
  return new Date(from).toISOString();
}
/**
 * Convierte un rango de días locales inclusivo en límites de instante para comparar texto ISO en SQL:
 * `from` es el primer instante de `desde` y `until` (exclusivo) el primero del día siguiente a `hasta`.
 * Es equivalente a `localDate(resolvedAt)` entre `desde` y `hasta`, sin usar el día UTC.
 */
export function localDayBounds(desde?: string, hasta?: string, timeZone: string = config.timeZone) {
  const next = hasta && new Date(Date.parse(`${hasta}T12:00:00Z`) + 24 * HOUR).toISOString().slice(0, 10);
  return {
    from: desde ? localDayStartIso(desde, timeZone) : undefined,
    until: next ? localDayStartIso(next, timeZone) : undefined,
  };
}
export function validDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function requireDate(s: string) {
  if (!validDate(s) || s > localDate()) {
    throw new ApiError(422, "INVALID_DATE", "La fecha debe ser válida y no puede ser futura");
  }
}
export function cleanText(value: string, min: number, field: string) {
  const result = value.trim();
  if (result.length < min) throw new ApiError(422, "INVALID_TEXT", `Revisá el campo ${field}`);
  return result;
}
export function pageOptions(q: Record<string, string | undefined>) {
  const read = (key: string, fallback: number, max: number) => {
    if (q[key] === undefined) return fallback;
    const n = Number(q[key]);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) {
      throw new ApiError(422, "INVALID_PAGINATION", `Valor inválido para ${key}`);
    }
    return n;
  };
  return { page: read("page", 1, 1_000_000), pageSize: read("pageSize", 20, 100) };
}
/** Ventana de una página: la consulta SQL usa `pageSize` como LIMIT y `offset` como OFFSET. */
export function pageWindow(q: Record<string, string | undefined>) {
  const { page, pageSize } = pageOptions(q);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
/** Respuesta paginada de una página ya resuelta en SQL; `total` es el conteo de todo el listado. */
export function pageResult<T>(items: T[], { page, pageSize }: { page: number; pageSize: number }, total: number) {
  return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}
export function paginate<T>(items: T[], q: Record<string, string | undefined>) {
  const { page, pageSize } = pageOptions(q);
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page, pageSize, total: items.length, totalPages: Math.ceil(items.length / pageSize),
  };
}
export function distanceKm(a: { latitud: number; longitud: number }, b: { latitud: number; longitud: number }) {
  const rad = (v: number) => v * Math.PI / 180;
  const x = Math.sin(rad(b.latitud - a.latitud) / 2) ** 2
    + Math.cos(rad(a.latitud)) * Math.cos(rad(b.latitud)) * Math.sin(rad(b.longitud - a.longitud) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(Math.min(1, x)), Math.sqrt(Math.max(0, 1 - x)));
}
