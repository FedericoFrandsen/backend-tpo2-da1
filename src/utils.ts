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
export function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  return ["year", "month", "day"].map((p) => parts.find((v) => v.type === p)!.value).join("-");
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
