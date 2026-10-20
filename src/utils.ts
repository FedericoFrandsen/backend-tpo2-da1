export const nowIso = () => new Date().toISOString();

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Convierte un precio en unidades de moneda a centavos enteros (y viceversa). */
export const centsFromPrice = (price: number | undefined | null) => (price == null ? null : Math.round(price * 100));
export const priceFromCents = (cents: number | null | undefined) => (cents == null ? null : cents / 100);

/** Lee un entero positivo de un query param, acotado a `max`, con fallback si es inválido. */
export function parsePositiveInt(value: string | undefined, fallback: number, max = 100) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}
