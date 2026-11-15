import { and, asc, eq, gt, inArray, lte, or } from "drizzle-orm";
import type { AppDatabase, Store } from "./database";
import { notifications, pushOutbox, pushTokens, sessions } from "./db/schema";
import { nowIso } from "./utils";

/**
 * Push de Expo (punto 12). Flujo:
 * 1. `notify` inserta la notificación y, en la misma transacción, una fila en `hallado_push_outbox` por cada dispositivo
 *    con sesión vigente del destinatario (`enqueuePush`). Si la transacción se revierte no queda nada para enviar, y una
 *    notificación deduplicada (misma `dedupeKey`) no vuelve a encolar.
 * 2. El despachador (`createPushDispatcher`) lee la bandeja después del commit, envía en lotes a la API de Expo con
 *    timeout, reintenta con espera exponencial ante fallos temporales (red, 429, 5xx, MessageRateExceeded) y registra
 *    el resultado de cada ticket. Más tarde consulta los recibos; `DeviceNotRegistered` borra el token.
 * Referencia: https://docs.expo.dev/push-notifications/sending-notifications/
 */

export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
export const PUSH_CHANNEL_ID = "hallado-notificaciones";
/** Tipos de notificación que también salen por push: reclamo nuevo o cambio de estado, devolución y punto de encuentro. */
export const PUSH_TIPOS = new Set(["reclamo", "encuentro", "devolucion"]);
const SEND_BATCH = 100;
const RECEIPT_BATCH = 1000;
const MAX_ERROR_LENGTH = 300;

/** Regla de `Expo.isExpoPushToken` (expo-server-sdk), exigiendo además contenido entre corchetes. */
export function isExpoPushToken(token: string) {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token) || /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i.test(token);
}

/**
 * Asocia el token a la sesión que lo registra. Un token pertenece a un único dispositivo: si estaba en otra sesión
 * (otra cuenta en el mismo teléfono, o una sesión anterior) se mueve, y sus envíos pendientes se cancelan para no
 * entregar avisos de la cuenta anterior. Si la sesión ya tenía otro token (Expo lo renovó), se reemplaza.
 */
export function registerPushToken(db: AppDatabase, sessionId: string, userId: string, token: string) {
  const now = nowIso();
  db.transaction((tx) => {
    const current = tx.select().from(pushTokens).where(eq(pushTokens.token, token)).get();
    if (current && current.sessionId === sessionId && current.userId === userId) {
      tx.update(pushTokens).set({ updatedAt: now }).where(eq(pushTokens.id, current.id)).run();
      return;
    }
    tx.delete(pushTokens).where(or(eq(pushTokens.token, token), eq(pushTokens.sessionId, sessionId))).run();
    tx.insert(pushTokens).values({ id: crypto.randomUUID(), token, userId, sessionId, createdAt: now, updatedAt: now }).run();
  });
}

/** Desvincula el dispositivo de la sesión; con `token` solo lo borra si coincide (y pertenece al usuario). */
export function unregisterPushToken(db: AppDatabase, sessionId: string, userId: string, token?: string) {
  db.delete(pushTokens).where(token
    ? and(eq(pushTokens.token, token), eq(pushTokens.userId, userId))
    : eq(pushTokens.sessionId, sessionId)).run();
}

/** Encola el push de una notificación recién insertada. Funciona con la base o con una transacción (`Store`). */
export function enqueuePush(db: Store, notificationId: string, userId: string) {
  const now = nowIso();
  const devices = db.select({ id: pushTokens.id }).from(pushTokens)
    .innerJoin(sessions, eq(sessions.id, pushTokens.sessionId))
    .where(and(eq(pushTokens.userId, userId), gt(sessions.expiresAt, now))).all();
  if (!devices.length) return;
  db.insert(pushOutbox).values(devices.map((d) => ({
    id: crypto.randomUUID(), notificationId, pushTokenId: d.id, proximoIntentoAt: now, createdAt: now, updatedAt: now,
  }))).onConflictDoNothing().run();
}

const TITULOS: Record<string, string> = { reclamo: "Reclamo", encuentro: "Punto de encuentro", devolucion: "Devolución" };

/** Contenido del push. `data` repite los ids con los nombres que lee el frontend (en inglés y en español). */
export function pushMessage(token: string, n: { id: string; tipo: string; mensaje: string; claimId: string | null; publicationId: string | null }) {
  return {
    to: token,
    title: TITULOS[n.tipo] ?? "Hallado",
    body: n.mensaje,
    data: {
      id: n.id, notificationId: n.id, tipo: n.tipo,
      ...(n.claimId ? { claimId: n.claimId, reclamoId: n.claimId } : {}),
      ...(n.publicationId ? { publicationId: n.publicationId, publicacionId: n.publicationId } : {}),
    },
    sound: "default",
    priority: "high",
    channelId: PUSH_CHANNEL_ID,
  };
}

export type PushFetch = (input: string, init: RequestInit) => Promise<Response>;
export type PushLogger = Pick<Console, "warn" | "error">;
export type PushDispatcherOptions = {
  fetch?: PushFetch;
  /** Token de acceso de Expo, solo si el proyecto activó "enhanced push security". */
  accessToken?: string;
  timeoutMs?: number;
  /** Intentos de envío antes de marcar el push como fallido. */
  maxAttempts?: number;
  /** Espera del primer reintento; se duplica en cada intento (tope: `maxRetryDelayMs`). */
  retryBaseMs?: number;
  maxRetryDelayMs?: number;
  /** Espera antes de consultar recibos (Expo recomienda 15 minutos). */
  receiptDelayMs?: number;
  /** Expo borra los recibos después de 24 h: pasado ese plazo sin recibo, el envío queda `sin_recibo`. */
  receiptMaxAgeMs?: number;
  /** Un push que no se pudo enviar en este plazo se cancela: avisar tarde confunde más de lo que ayuda. */
  maxAgeMs?: number;
  now?: () => number;
  logger?: PushLogger;
};
export type PushSummary = { sent: number; retried: number; failed: number; cancelled: number };

type Ticket = { status?: string; id?: string; message?: string; details?: { error?: string } };
type Due = { id: string; intentos: number; token: string | null; tokenId: string | null; tokenUserId: string | null;
  sessionExpiresAt: string | null; createdAt: string;
  notification: { id: string; userId: string; tipo: string; mensaje: string; claimId: string | null; publicationId: string | null } };

class TemporaryPushError extends Error {}

const clip = (value: string) => value.slice(0, MAX_ERROR_LENGTH);

export function createPushDispatcher(db: AppDatabase, options: PushDispatcherOptions = {}) {
  const doFetch: PushFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const retryBaseMs = options.retryBaseMs ?? 30_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 30 * 60_000;
  const receiptDelayMs = options.receiptDelayMs ?? 15 * 60_000;
  const receiptMaxAgeMs = options.receiptMaxAgeMs ?? 24 * 60 * 60_000;
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60_000;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const iso = (ms = 0) => new Date(now() + ms).toISOString();

  async function post(url: string, body: unknown) {
    const headers: Record<string, string> = {
      accept: "application/json", "accept-encoding": "gzip, deflate", "content-type": "application/json",
    };
    if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;
    let response: Response;
    try {
      response = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new TemporaryPushError(name === "TimeoutError" || name === "AbortError" ? `Expo no respondió en ${timeoutMs} ms` : `Error de red: ${error instanceof Error ? error.message : String(error)}`);
    }
    let payload: any = null;
    try { payload = await response.json(); } catch { /* cuerpo vacío o no JSON */ }
    const detail = payload?.errors?.[0] ? `${payload.errors[0].code ?? ""} ${payload.errors[0].message ?? ""}`.trim() : "";
    if (response.status === 429 || response.status >= 500) throw new TemporaryPushError(clip(`HTTP ${response.status} ${detail}`.trim()));
    if (!response.ok) throw new Error(clip(`HTTP ${response.status} ${detail}`.trim()));
    if (!payload || typeof payload !== "object") throw new TemporaryPushError(`Respuesta de Expo no válida (HTTP ${response.status})`);
    return payload;
  }

  function setRow(id: string, values: Partial<typeof pushOutbox.$inferInsert>) {
    db.update(pushOutbox).set({ ...values, updatedAt: iso() }).where(eq(pushOutbox.id, id)).run();
  }

  /** Reintento acotado; al agotar los intentos el envío queda `fallido` con el motivo. */
  function retryOrFail(row: { id: string; intentos: number }, error: string, summary: { retried: number; failed: number }) {
    const intentos = row.intentos + 1;
    if (intentos >= maxAttempts) {
      setRow(row.id, { estado: "fallido", intentos, error: clip(`${error} (tras ${intentos} intentos)`) });
      summary.failed++;
      logger.warn(`[push] Envío ${row.id} fallido tras ${intentos} intentos: ${error}`);
      return;
    }
    const delay = Math.min(retryBaseMs * 2 ** (intentos - 1), maxRetryDelayMs);
    setRow(row.id, { estado: "pendiente", intentos, error: clip(error), proximoIntentoAt: iso(delay) });
    summary.retried++;
  }

  function forgetToken(tokenId: string | null) {
    // Las filas pendientes de ese dispositivo quedan sin token (ON DELETE SET NULL) y se cancelan en el próximo ciclo.
    if (tokenId) db.delete(pushTokens).where(eq(pushTokens.id, tokenId)).run();
  }

  function dueRows(): Due[] {
    return db.select({
      id: pushOutbox.id, intentos: pushOutbox.intentos, createdAt: pushOutbox.createdAt,
      token: pushTokens.token, tokenId: pushTokens.id, tokenUserId: pushTokens.userId, sessionExpiresAt: sessions.expiresAt,
      notification: { id: notifications.id, userId: notifications.userId, tipo: notifications.tipo, mensaje: notifications.mensaje,
        claimId: notifications.claimId, publicationId: notifications.publicationId },
    }).from(pushOutbox)
      .innerJoin(notifications, eq(notifications.id, pushOutbox.notificationId))
      .leftJoin(pushTokens, eq(pushTokens.id, pushOutbox.pushTokenId))
      .leftJoin(sessions, eq(sessions.id, pushTokens.sessionId))
      .where(and(eq(pushOutbox.estado, "pendiente"), lte(pushOutbox.proximoIntentoAt, iso())))
      .orderBy(asc(pushOutbox.proximoIntentoAt)).limit(SEND_BATCH).all();
  }

  /** Envía los push pendientes cuya hora de intento llegó. Devuelve qué pasó con cada fila procesada. */
  async function flush(): Promise<PushSummary> {
    const summary: PushSummary = { sent: 0, retried: 0, failed: 0, cancelled: 0 };
    // Tope de lotes por ciclo: lo que quede (o se reprograme) sale en el siguiente, sin bucles largos.
    for (let batch = 0; batch < 10; batch++) {
      const rows = dueRows();
      if (!rows.length) return summary;
      const sendable: (Due & { token: string })[] = [];
      for (const row of rows) {
        const reason = !row.token ? "El dispositivo se desvinculó (logout, cambio de cuenta o token inválido)"
          : row.tokenUserId !== row.notification.userId ? "El dispositivo pertenece a otra cuenta"
          : !row.sessionExpiresAt || row.sessionExpiresAt <= iso() ? "La sesión del dispositivo venció"
          : now() - new Date(row.createdAt).getTime() > maxAgeMs ? "Venció el plazo para avisar"
          : null;
        if (reason) { setRow(row.id, { estado: "cancelado", error: reason }); summary.cancelled++; }
        else sendable.push(row as Due & { token: string });
      }
      if (!sendable.length) continue;
      // Reserva las filas mientras dura el pedido, por si otro ciclo empieza antes de que termine.
      db.update(pushOutbox).set({ proximoIntentoAt: iso(timeoutMs * 2) }).where(inArray(pushOutbox.id, sendable.map((r) => r.id))).run();
      let tickets: Ticket[];
      try {
        const payload = await post(EXPO_PUSH_SEND_URL, sendable.map((r) => pushMessage(r.token, r.notification)));
        if (!Array.isArray(payload.data) || payload.data.length !== sendable.length) {
          throw new TemporaryPushError("Expo devolvió una cantidad de tickets distinta a la de mensajes");
        }
        tickets = payload.data;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof TemporaryPushError) for (const row of sendable) retryOrFail(row, message, summary);
        else {
          logger.error(`[push] Expo rechazó el pedido: ${message}`);
          for (const row of sendable) { setRow(row.id, { estado: "fallido", intentos: row.intentos + 1, error: message }); summary.failed++; }
        }
        continue;
      }
      sendable.forEach((row, i) => {
        const ticket = tickets[i]!;
        if (ticket.status === "ok" && ticket.id) {
          setRow(row.id, { estado: "enviado", intentos: row.intentos + 1, ticketId: ticket.id, error: null });
          summary.sent++;
          return;
        }
        const code = ticket.details?.error ?? "Ticket sin estado";
        const error = clip(`${code}: ${ticket.message ?? ""}`.trim());
        if (code === "MessageRateExceeded") return retryOrFail(row, error, summary);
        setRow(row.id, { estado: "fallido", intentos: row.intentos + 1, error });
        summary.failed++;
        if (code === "DeviceNotRegistered") forgetToken(row.tokenId);
        else logger.warn(`[push] Envío ${row.id} rechazado por Expo: ${error}`);
      });
    }
    return summary;
  }

  /** Consulta los recibos de los envíos con ticket `ok` que ya esperaron `receiptDelayMs`. */
  async function checkReceipts() {
    const result = { accepted: 0, failed: 0, retried: 0, missing: 0 };
    const rows = db.select({ id: pushOutbox.id, ticketId: pushOutbox.ticketId, intentos: pushOutbox.intentos,
      updatedAt: pushOutbox.updatedAt, tokenId: pushOutbox.pushTokenId }).from(pushOutbox)
      .where(and(eq(pushOutbox.estado, "enviado"), lte(pushOutbox.updatedAt, iso(-receiptDelayMs))))
      .orderBy(asc(pushOutbox.updatedAt)).limit(RECEIPT_BATCH).all();
    if (!rows.length) return result;
    let receipts: Record<string, Ticket>;
    try {
      const payload = await post(EXPO_PUSH_RECEIPTS_URL, { ids: rows.map((r) => r.ticketId) });
      receipts = payload.data && typeof payload.data === "object" ? payload.data : {};
    } catch (error) {
      logger.warn(`[push] No se pudieron consultar los recibos: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
    for (const row of rows) {
      const receipt = row.ticketId ? receipts[row.ticketId] : undefined;
      if (!receipt) {
        if (now() - new Date(row.updatedAt).getTime() > receiptMaxAgeMs) {
          setRow(row.id, { estado: "sin_recibo", error: "Expo no devolvió el recibo dentro de las 24 h" });
          result.missing++;
        }
        continue;
      }
      if (receipt.status === "ok") { setRow(row.id, { estado: "aceptado", error: null }); result.accepted++; continue; }
      const code = receipt.details?.error ?? "Recibo sin estado";
      const error = clip(`${code}: ${receipt.message ?? ""}`.trim());
      if (code === "MessageRateExceeded") { retryOrFail(row, error, result); continue; }
      setRow(row.id, { estado: "fallido", error });
      result.failed++;
      if (code === "DeviceNotRegistered") forgetToken(row.tokenId);
      else logger.warn(`[push] Recibo con error para ${row.id}: ${error}`);
    }
    return result;
  }

  // Todo el trabajo contra Expo pasa por esta cola: nunca corren dos ciclos a la vez (ni el de una petición y el periódico).
  let chain: Promise<unknown> = Promise.resolve();
  let kickQueued = false;
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = chain.then(task, task);
    chain = result.catch(() => undefined);
    return result;
  }
  const logFailure = (error: unknown) => logger.error(`[push] Error al despachar: ${error instanceof Error ? error.message : String(error)}`);
  /** Pide un envío sin esperarlo (p. ej. al terminar una petición, ya con la transacción confirmada). */
  function kick() {
    if (kickQueued) return;
    kickQueued = true;
    exclusive(() => { kickQueued = false; return flush(); }).catch(logFailure);
  }
  /** Ciclo completo del proceso de fondo: envía lo pendiente y consulta recibos. */
  function cycle() {
    return exclusive(async () => ({ push: await flush(), receipts: await checkReceipts() }));
  }
  /** Espera a que termine lo encolado (tests y cierre ordenado). */
  async function idle() {
    let current: Promise<unknown>;
    do { current = chain; await current; } while (current !== chain);
  }

  return { flush, checkReceipts, kick, cycle, idle };
}
export type PushDispatcher = ReturnType<typeof createPushDispatcher>;
