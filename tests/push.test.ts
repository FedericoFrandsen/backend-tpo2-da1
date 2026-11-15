import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createSession } from "../src/auth";
import { createDatabase } from "../src/database";
import { claims, notifications, pushOutbox, pushTokens, sessions, users } from "../src/db/schema";
import { startBackgroundJobs } from "../src/jobs";
import { createPushDispatcher, EXPO_PUSH_RECEIPTS_URL, EXPO_PUSH_SEND_URL, isExpoPushToken, type PushDispatcherOptions } from "../src/push";
import { CLAIM_EXPIRATION_MS, expirePendingClaims, notify } from "../src/queries";
import { localDate, nowIso } from "../src/utils";

// Sin red real: cada prueba usa un fetch simulado que registra los pedidos y responde lo que se le indique.
type Call = { url: string; body: any; headers: Record<string, string> };
type Reply = Response | Error | ((call: Call, init: RequestInit) => Response | Promise<Response>);
function fakeExpo() {
  const calls: Call[] = [];
  const replies: Reply[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const call = { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    calls.push(call);
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(call, init);
    if (reply) return reply;
    // Por defecto: ticket ok para cada mensaje.
    if (url === EXPO_PUSH_SEND_URL) return Response.json({ data: call.body.map((_: unknown, i: number) => ({ status: "ok", id: `ticket-${calls.length}-${i}` })) });
    return Response.json({ data: {} });
  };
  return { calls, replies, fetch, sends: () => calls.filter((c) => c.url === EXPO_PUSH_SEND_URL) };
}
const silent = { warn: () => {}, error: () => {} };

let db: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createApp>;
let temp: string;
let expo: ReturnType<typeof fakeExpo>;
let offset: number;
let push: ReturnType<typeof createPushDispatcher>;
let accounts: { id: string; token: string }[];
const TOKEN_A = "ExponentPushToken[dispositivo-a]";
const TOKEN_B = "ExponentPushToken[dispositivo-b]";

function dispatcher(options: PushDispatcherOptions = {}) {
  return createPushDispatcher(db, { fetch: expo.fetch, now: () => Date.now() + offset, logger: silent, retryBaseMs: 1000, ...options });
}
async function api(path: string, method = "GET", body?: unknown, token?: string) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await app.handle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const data: any = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
  return { response, data };
}
async function register(account: number, token: string, session = accounts[account]!.token) {
  const result = await api("/me/push-token", "POST", { token }, session);
  expect(result.response.status).toBe(200);
}
async function publish(owner = 0) {
  const result = await api("/publicaciones", "POST", {
    tipo: "encontre", titulo: "Llaves con llavero azul", descripcion: "Juego de tres llaves con un llavero de color azul.",
    categoria: "Llaves", barrio: "Palermo", fecha: localDate(), hora: "00:00", direccionExacta: "Calle privada 123", fotos: [],
    preguntaVerificacion: "¿Qué dibujo tiene el llavero?", respuestaVerificacion: "Una estrella azul",
  }, accounts[owner]!.token);
  expect(result.response.status).toBe(201);
  return result.data as { id: string };
}
async function claim(postId: string, claimant = 1) {
  const result = await api(`/publicaciones/${postId}/reclamos`, "POST", { mensaje: "Son mis llaves.", respuestaVerificacion: "Una estrella azul" }, accounts[claimant]!.token);
  expect(result.response.status).toBe(201);
  return result.data as { id: string };
}
/** Elysia ejecuta onAfterResponse después de entregar la respuesta: espera ese pedido de envío y lo que haya encolado. */
async function settle() {
  await Bun.sleep(5);
  await push.idle();
}
const outbox = () => db.select().from(pushOutbox).all();
const tokensOf = (userId: string) => db.select({ token: pushTokens.token }).from(pushTokens).where(eq(pushTokens.userId, userId)).all().map((r) => r.token);

beforeEach(async () => {
  temp = mkdtempSync(join(tmpdir(), "hallado-push-"));
  db = createDatabase(":memory:");
  expo = fakeExpo();
  offset = 0;
  push = dispatcher();
  // La app pide envíos al despachador vigente de cada prueba (algunas lo reemplazan con otras opciones).
  app = createApp(db, { uploadsPath: join(temp, "uploads"), push: { kick: () => push.kick() }, sendOtp: async () => {} });
  accounts = [];
  for (let i = 0; i < 3; i++) {
    const id = `user-${i}`;
    db.insert(users).values({ id, email: `push${i}@example.com`, passwordHash: await Bun.password.hash("Hallado123"), name: `Persona ${i}`,
      zone: "Palermo", createdAt: nowIso(), emailVerifiedAt: nowIso() }).run();
    accounts.push({ id, token: (await createSession(db, id, 1)).token });
  }
});
afterEach(async () => { await push.idle(); db.$client.close(); rmSync(temp, { recursive: true, force: true }); });

describe("Push: eventos dentro de transacciones", () => {
  test("un reclamo creado por la ruta (dentro de una transacción) envía push al publicador después de responder", async () => {
    await register(0, TOKEN_A);
    const post = await publish();
    const c = await claim(post.id);
    await settle();
    const sends = expo.sends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body).toEqual([{
      to: TOKEN_A, title: "Reclamo", body: "Recibiste un reclamo en Llaves con llavero azul",
      data: { id: expect.any(String), notificationId: expect.any(String), tipo: "reclamo",
        claimId: c.id, reclamoId: c.id, publicationId: post.id, publicacionId: post.id },
      sound: "default", priority: "high", channelId: "hallado-notificaciones",
    }]);
    expect(sends[0]!.headers["content-type"]).toBe("application/json");
    expect(sends[0]!.headers.authorization).toBeUndefined();
    const row = outbox()[0]!;
    expect(row.estado).toBe("enviado");
    expect(row.ticketId).toStartWith("ticket-");
    expect(db.select().from(notifications).where(eq(notifications.id, row.notificationId)).get()!.tipo).toBe("reclamo");
  });

  test("aceptar, rechazar y proponer/aceptar punto de encuentro avisan a la contraparte", async () => {
    await register(1, TOKEN_B);
    const post = await publish();
    const c = await claim(post.id);
    expect((await api(`/reclamos/${c.id}/aceptar`, "POST", undefined, accounts[0]!.token)).response.status).toBe(200);
    const proposal = await api(`/reclamos/${c.id}/encuentro`, "POST", { direccion: "Plaza Italia", propuestaId: null, intento: 1 }, accounts[0]!.token);
    expect(proposal.response.status).toBe(200);
    await settle();
    const sent = expo.sends().flatMap((s) => s.body);
    expect(sent.map((m: any) => [m.to, m.data.tipo, m.body])).toEqual([
      [TOKEN_B, "reclamo", "Aceptaron tu reclamo en Llaves con llavero azul"],
      [TOKEN_B, "encuentro", "Te propusieron un punto de encuentro para Llaves con llavero azul"],
    ]);
    expect(sent[1].data).toMatchObject({ claimId: c.id, publicationId: post.id });

    const other = await publish();
    const rejected = await claim(other.id);
    expect((await api(`/reclamos/${rejected.id}/rechazar`, "POST", undefined, accounts[0]!.token)).response.status).toBe(200);
    await settle();
    expect(expo.sends().at(-1)!.body[0]).toMatchObject({ to: TOKEN_B, body: "Rechazaron tu reclamo en Llaves con llavero azul", data: { claimId: rejected.id } });
  });

  test("notify con una transacción revertida no deja notificación, ni envío pendiente, ni push", async () => {
    await register(0, TOKEN_A);
    expect(() => db.transaction((tx) => {
      notify(tx, accounts[0]!.id, "reclamo", "No debería salir");
      expect(tx.select().from(pushOutbox).all()).toHaveLength(1);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(db.select().from(notifications).all()).toHaveLength(0);
    expect(outbox()).toHaveLength(0);
    expect(await push.flush()).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 0 });
    expect(expo.calls).toHaveLength(0);
  });

  test("notify con transacción confirmada envía; una notificación deduplicada no vuelve a encolar", async () => {
    await register(0, TOKEN_A);
    db.transaction((tx) => notify(tx, accounts[0]!.id, "reclamo", "Una vez", { dedupeKey: "unico" }));
    db.transaction((tx) => notify(tx, accounts[0]!.id, "reclamo", "Una vez", { dedupeKey: "unico" }));
    notify(db, accounts[0]!.id, "reclamo", "Una vez", { dedupeKey: "unico" });
    expect(outbox()).toHaveLength(1);
    expect((await push.flush()).sent).toBe(1);
    expect((await push.flush()).sent).toBe(0);
    expect(expo.sends()).toHaveLength(1);
  });

  test("solo los tipos del punto 12 salen por push", async () => {
    await register(0, TOKEN_A);
    notify(db, accounts[0]!.id, "mensaje", "Mensaje");
    notify(db, accounts[0]!.id, "coincidencia", "Coincidencia");
    notify(db, accounts[0]!.id, "devolucion", "Se concretó la devolución");
    expect(outbox()).toHaveLength(1);
  });

  test("sin dispositivo registrado la notificación se guarda igual y no hay envío", async () => {
    const post = await publish();
    await claim(post.id);
    await settle();
    expect(db.select().from(notifications).where(eq(notifications.userId, accounts[0]!.id)).all()).toHaveLength(1);
    expect(outbox()).toHaveLength(0);
    expect(expo.calls).toHaveLength(0);
  });
});

describe("Push: tokens por dispositivo y sesión", () => {
  test("rechaza tokens que no son de Expo y exige sesión", async () => {
    expect((await api("/me/push-token", "POST", { token: "abc" }, accounts[0]!.token)).response.status).toBe(422);
    expect((await api("/me/push-token", "POST", { token: TOKEN_A })).response.status).toBe(401);
    expect(isExpoPushToken("ExpoPushToken[xyz]")).toBe(true);
    expect(isExpoPushToken("ExponentPushToken[]")).toBe(false);
    expect(isExpoPushToken("12345678-abcd-abcd-abcd-1234567890ab")).toBe(true);
  });

  test("logout desvincula el token: el mismo teléfono con otra cuenta no recibe avisos de la anterior", async () => {
    await register(0, TOKEN_A);
    expect((await api("/auth/logout", "POST", undefined, accounts[0]!.token)).response.status).toBe(200);
    expect(tokensOf(accounts[0]!.id)).toEqual([]);
    const login = await api("/auth/login/password", "POST", { email: "push1@example.com", password: "Hallado123" });
    expect(login.response.status).toBe(200);
    await register(1, TOKEN_A, login.data.session.token);
    expect(db.select().from(pushTokens).all().map((r) => [r.token, r.userId])).toEqual([[TOKEN_A, accounts[1]!.id]]);

    notify(db, accounts[0]!.id, "reclamo", "Para la cuenta 0");
    notify(db, accounts[1]!.id, "reclamo", "Para la cuenta 1");
    await push.flush();
    expect(expo.sends().flatMap((s) => s.body).map((m: any) => [m.to, m.body])).toEqual([[TOKEN_A, "Para la cuenta 1"]]);
  });

  test("cambio de cuenta sin logout mueve el token y cancela lo pendiente de la cuenta anterior", async () => {
    await register(0, TOKEN_A);
    await settle();
    notify(db, accounts[0]!.id, "reclamo", "Pendiente de la cuenta 0");
    await register(1, TOKEN_A);
    expect(tokensOf(accounts[0]!.id)).toEqual([]);
    expect(tokensOf(accounts[1]!.id)).toEqual([TOKEN_A]);
    await settle();
    await push.flush();
    expect(outbox()[0]).toMatchObject({ estado: "cancelado", pushTokenId: null });
    expect(expo.calls).toHaveLength(0);
  });

  test("varios dispositivos de la misma persona reciben cada uno su aviso; re-registrar no duplica", async () => {
    const second = (await createSession(db, accounts[0]!.id, 1)).token;
    await register(0, TOKEN_A);
    await register(0, TOKEN_A);
    await register(0, TOKEN_B, second);
    expect(tokensOf(accounts[0]!.id).sort()).toEqual([TOKEN_A, TOKEN_B]);
    notify(db, accounts[0]!.id, "encuentro", "Te propusieron un punto de encuentro");
    await push.flush();
    expect(expo.sends()).toHaveLength(1);
    expect(expo.sends()[0]!.body.map((m: any) => m.to).sort()).toEqual([TOKEN_A, TOKEN_B]);
  });

  test("si Expo renueva el token de la sesión se reemplaza el anterior", async () => {
    await register(0, TOKEN_A);
    await register(0, TOKEN_B);
    expect(tokensOf(accounts[0]!.id)).toEqual([TOKEN_B]);
  });

  test("DELETE /me/push-token desvincula sin cerrar la sesión; no borra tokens ajenos", async () => {
    await register(0, TOKEN_A);
    await register(1, TOKEN_B);
    expect((await api("/me/push-token", "DELETE", { token: TOKEN_B }, accounts[0]!.token)).response.status).toBe(200);
    expect(tokensOf(accounts[1]!.id)).toEqual([TOKEN_B]);
    expect((await api("/me/push-token", "DELETE", undefined, accounts[0]!.token)).response.status).toBe(200);
    expect(tokensOf(accounts[0]!.id)).toEqual([]);
    expect((await api("/me", "GET", undefined, accounts[0]!.token)).response.status).toBe(200);
  });

  test("sesión vencida o revocada por cambio de contraseña no recibe push", async () => {
    await register(0, TOKEN_A);
    db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(sessions.userId, accounts[0]!.id)).run();
    notify(db, accounts[0]!.id, "reclamo", "Sesión vencida");
    expect(outbox()).toHaveLength(0);
    db.delete(sessions).where(eq(sessions.userId, accounts[0]!.id)).run();
    expect(db.select().from(pushTokens).all()).toHaveLength(0);
  });
});

describe("Push: fallos de Expo, reintentos y recibos", () => {
  async function queued(account = 0) {
    await register(account, TOKEN_A);
    await settle();
    notify(db, accounts[account]!.id, "reclamo", "Recibiste un reclamo");
    return outbox()[0]!.id;
  }
  const row = (id: string) => db.select().from(pushOutbox).where(eq(pushOutbox.id, id)).get()!;

  test("HTTP 5xx, 429 y errores de red se reintentan con espera exponencial y quedan fallidos al agotar intentos", async () => {
    push = dispatcher({ maxAttempts: 3 });
    const id = await queued();
    expo.replies.push(new Response("boom", { status: 503 }));
    expect(await push.flush()).toMatchObject({ retried: 1, sent: 0 });
    expect(row(id)).toMatchObject({ estado: "pendiente", intentos: 1, error: "HTTP 503" });
    expect(await push.flush()).toMatchObject({ retried: 0 }); // todavía no es la hora del reintento
    offset += 1000;
    expo.replies.push(Response.json({ errors: [{ code: "TOO_MANY_REQUESTS", message: "Demasiados" }] }, { status: 429 }));
    expect(await push.flush()).toMatchObject({ retried: 1 });
    expect(row(id)).toMatchObject({ intentos: 2, error: "HTTP 429 TOO_MANY_REQUESTS Demasiados" });
    offset += 1999;
    expect(expo.calls).toHaveLength(2);
    await push.flush();
    expect(expo.calls).toHaveLength(2); // la segunda espera es el doble
    offset += 1;
    expo.replies.push(new TypeError("fetch failed"));
    expect(await push.flush()).toMatchObject({ failed: 1 });
    expect(row(id).estado).toBe("fallido");
    expect(row(id).error).toContain("Error de red: fetch failed (tras 3 intentos)");
    offset += 60 * 60_000;
    await push.flush();
    expect(expo.calls).toHaveLength(3);
  });

  test("un timeout corta el pedido y se reintenta", async () => {
    push = dispatcher({ timeoutMs: 20 });
    const id = await queued();
    expo.replies.push((_call, init) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    expect(await push.flush()).toMatchObject({ retried: 1 });
    expect(row(id).error).toBe("Expo no respondió en 20 ms");
    offset += 1000;
    expect(await push.flush()).toMatchObject({ sent: 1 });
    expect(row(id).estado).toBe("enviado");
  });

  test("un 400 de Expo no se reintenta; queda fallido con el detalle", async () => {
    const id = await queued();
    expo.replies.push(Response.json({ errors: [{ code: "VALIDATION_ERROR", message: "\"to\" inválido" }] }, { status: 400 }));
    expect(await push.flush()).toMatchObject({ failed: 1 });
    expect(row(id)).toMatchObject({ estado: "fallido", intentos: 1, error: "HTTP 400 VALIDATION_ERROR \"to\" inválido" });
  });

  test("una respuesta 200 con tickets incompletos no se da por enviada", async () => {
    const id = await queued();
    expo.replies.push(Response.json({ data: [] }));
    expect(await push.flush()).toMatchObject({ sent: 0, retried: 1 });
    expect(row(id).estado).toBe("pendiente");
  });

  test("ticket DeviceNotRegistered marca fallido y borra el token; MessageRateExceeded reintenta", async () => {
    const second = (await createSession(db, accounts[0]!.id, 1)).token;
    await register(0, TOKEN_A);
    await register(0, TOKEN_B, second);
    notify(db, accounts[0]!.id, "reclamo", "Recibiste un reclamo");
    expo.replies.push((call) => Response.json({ data: call.body.map((m: any) => m.to === TOKEN_A
      ? { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }
      : { status: "error", message: "slow down", details: { error: "MessageRateExceeded" } }) }));
    expect(await push.flush()).toMatchObject({ failed: 1, retried: 1 });
    expect(tokensOf(accounts[0]!.id)).toEqual([TOKEN_B]);
    const rows = outbox();
    expect(rows.find((r) => r.estado === "fallido")!.error).toBe("DeviceNotRegistered: not registered");
    expect(rows.find((r) => r.estado === "pendiente")!.intentos).toBe(1);
  });

  test("recibos: espera, acepta, borra tokens no registrados y marca sin_recibo pasado el plazo", async () => {
    const tokens = ["ExponentPushToken[r1]", "ExponentPushToken[r2]", "ExponentPushToken[r3]"];
    for (const token of tokens) await register(0, token, (await createSession(db, accounts[0]!.id, 1)).token);
    notify(db, accounts[0]!.id, "reclamo", "Recibiste un reclamo");
    await push.flush();
    const sent = outbox();
    expect(sent.every((r) => r.estado === "enviado")).toBe(true);
    expect(await push.checkReceipts()).toEqual({ accepted: 0, failed: 0, retried: 0, missing: 0 });
    expect(expo.calls.filter((c) => c.url === EXPO_PUSH_RECEIPTS_URL)).toHaveLength(0);

    offset += 15 * 60_000;
    const byToken = (token: string) => db.select({ ticketId: pushOutbox.ticketId }).from(pushOutbox)
      .innerJoin(pushTokens, eq(pushTokens.id, pushOutbox.pushTokenId)).where(eq(pushTokens.token, token)).get()!.ticketId!;
    const [t1, t2] = [byToken(tokens[0]!), byToken(tokens[1]!)];
    expo.replies.push(Response.json({ data: {
      [t1]: { status: "ok" },
      [t2]: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
    } }));
    expect(await push.checkReceipts()).toEqual({ accepted: 1, failed: 1, retried: 0, missing: 0 });
    expect(expo.calls.at(-1)!.body.ids.sort()).toEqual(sent.map((r) => r.ticketId).sort());
    expect(tokensOf(accounts[0]!.id).sort()).toEqual([tokens[0], tokens[2]]);

    offset += 24 * 60 * 60_000;
    expect(await push.checkReceipts()).toMatchObject({ missing: 1 });
    expect(outbox().map((r) => r.estado).sort()).toEqual(["aceptado", "fallido", "sin_recibo"]);
  });

  test("un fallo al consultar recibos deja los envíos para el próximo ciclo", async () => {
    await queued();
    await push.flush();
    offset += 15 * 60_000;
    expo.replies.push(new Response("", { status: 502 }));
    expect(await push.checkReceipts()).toEqual({ accepted: 0, failed: 0, retried: 0, missing: 0 });
    expect(outbox()[0]!.estado).toBe("enviado");
  });

  test("envía el token de acceso de Expo solo si está configurado", async () => {
    push = dispatcher({ accessToken: "token-de-prueba" });
    await queued();
    await push.flush();
    expect(expo.sends()[0]!.headers.authorization).toBe("Bearer token-de-prueba");
  });

  test("un push que no se pudo enviar en el plazo máximo se cancela", async () => {
    push = dispatcher({ maxAgeMs: 60_000 });
    const id = await queued();
    offset += 61_000;
    expect(await push.flush()).toMatchObject({ cancelled: 1 });
    expect(row(id)).toMatchObject({ estado: "cancelado", error: "Venció el plazo para avisar" });
  });
});

describe("Vencimiento de reclamos", () => {
  function age(claimId: string) {
    db.update(claims).set({ updatedAt: new Date(Date.now() - CLAIM_EXPIRATION_MS - 1000).toISOString() }).where(eq(claims.id, claimId)).run();
  }
  const expiryNotices = (userId: string) => db.select().from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.tipo, "reclamo"))).all().filter((n) => n.dedupeKey?.startsWith("reclamo-vencido:"));

  test("avisa al reclamante una sola vez aunque se consulte muchas veces, y encola un único push", async () => {
    await register(1, TOKEN_B);
    const post = await publish();
    const c = await claim(post.id);
    await settle();
    age(c.id);
    for (let i = 0; i < 3; i++) {
      expect((await api(`/reclamos/${c.id}`, "GET", undefined, accounts[1]!.token)).data.estado).toBe("vencido");
      expect((await api(`/publicaciones/${post.id}`)).response.status).toBe(200);
      expirePendingClaims(db);
    }
    await settle();
    const notices = expiryNotices(accounts[1]!.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ claimId: c.id, publicationId: post.id, mensaje: "Venció tu reclamo en Llaves con llavero azul: pasaron 48 h sin respuesta" });
    const sent = expo.sends().flatMap((s) => s.body);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: TOKEN_B, data: { tipo: "reclamo", claimId: c.id, reclamoId: c.id } });
    expect(expiryNotices(accounts[0]!.id)).toHaveLength(0);
  });

  test("cada intento de un reclamo que vence genera su propio aviso, sin duplicados", async () => {
    await register(1, TOKEN_B);
    const post = await publish();
    const first = await claim(post.id);
    age(first.id);
    expirePendingClaims(db);
    const second = await claim(post.id);
    expect(second.id).toBe(first.id);
    age(second.id);
    expirePendingClaims(db);
    expirePendingClaims(db);
    expect(expiryNotices(accounts[1]!.id)).toHaveLength(2);
    await settle();
    expect(expo.sends().flatMap((s) => s.body)).toHaveLength(2);
  });

  test("si no se puede guardar el aviso, el vencimiento se revierte y puede reintentarse", async () => {
    const post = await publish();
    const c = await claim(post.id);
    age(c.id);
    db.$client.exec(`CREATE TRIGGER fallo_aviso BEFORE INSERT ON hallado_notifications
      BEGIN SELECT RAISE(ABORT, 'fallo simulado'); END`);
    expect(() => expirePendingClaims(db)).toThrow();
    expect(db.select().from(claims).where(eq(claims.id, c.id)).get()!.estado).toBe("pendiente");
    db.$client.exec("DROP TRIGGER fallo_aviso");
    expirePendingClaims(db);
    expect(expiryNotices(accounts[1]!.id)).toHaveLength(1);
  });

  test("si falla la cola push tampoco se conserva el aviso ni el vencimiento parcial", async () => {
    await register(1, TOKEN_B);
    const post = await publish();
    const c = await claim(post.id);
    await settle();
    age(c.id);
    db.$client.exec(`CREATE TRIGGER fallo_push BEFORE INSERT ON hallado_push_outbox
      BEGIN SELECT RAISE(ABORT, 'fallo simulado'); END`);
    expect(() => expirePendingClaims(db)).toThrow();
    expect(db.select().from(claims).where(eq(claims.id, c.id)).get()!.estado).toBe("pendiente");
    expect(expiryNotices(accounts[1]!.id)).toHaveLength(0);
    db.$client.exec("DROP TRIGGER fallo_push");
    expirePendingClaims(db);
    expect(expiryNotices(accounts[1]!.id)).toHaveLength(1);
    await push.cycle();
    expect(expo.sends().flatMap((s) => s.body)).toHaveLength(1);
  });

  test("el proceso de fondo vence y envía sin peticiones entrantes; stop espera el ciclo y detiene el temporizador", async () => {
    await register(1, TOKEN_B);
    const post = await publish();
    const c = await claim(post.id);
    await settle();
    age(c.id);
    const jobs = startBackgroundJobs(db, { intervalMs: 10, push, logger: silent });
    await jobs.started;
    expect(db.select().from(claims).where(eq(claims.id, c.id)).get()!.estado).toBe("vencido");
    expect(expo.sends().flatMap((s) => s.body).map((m: any) => m.data.claimId)).toEqual([c.id]);
    await jobs.stop();
    const callsAfterStop = expo.calls.length;
    notify(db, accounts[1]!.id, "reclamo", "Después de detener");
    await Bun.sleep(40);
    expect(expo.calls.length).toBe(callsAfterStop);
    expect(outbox().filter((r) => r.estado === "pendiente")).toHaveLength(1);
  });

  test("con PUSH_MODE=off el proceso de fondo igual vence reclamos y deja el aviso en la bandeja", async () => {
    const post = await publish();
    const c = await claim(post.id);
    age(c.id);
    const jobs = startBackgroundJobs(db, { intervalMs: 60_000, logger: silent });
    await jobs.started;
    await jobs.stop();
    expect(expiryNotices(accounts[1]!.id)).toHaveLength(1);
  });
});

describe("Migración de tokens push", () => {
  test("una base con la tabla ad hoc del PR #6 migra al esquema versionado y descarta los tokens sin sesión", () => {
    const folder = join(temp, "old-migrations");
    for (const name of readdirSync(new URL("../drizzle", import.meta.url))) {
      if (name.startsWith("2026") && name < "20261115") cpSync(new URL(`../drizzle/${name}`, import.meta.url), join(folder, name), { recursive: true });
    }
    const path = join(temp, "pr6.sqlite");
    const raw = new Database(path, { create: true });
    raw.exec("PRAGMA foreign_keys = ON;");
    migrate(drizzle({ client: raw }), { migrationsFolder: folder });
    // Lo que creaba createDatabase en el PR #6.
    raw.run(`CREATE TABLE IF NOT EXISTS hallado_push_tokens (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    raw.run("INSERT INTO users (id,email,name,created_at,email_verified_at) VALUES (?,?,?,?,?)", ["u-1", "u1@example.com", "Uno", nowIso(), nowIso()]);
    raw.run("INSERT INTO hallado_push_tokens VALUES (?,?,?)", ["u-1", TOKEN_A, nowIso()]);
    raw.close();

    const upgraded = createDatabase(path);
    const columns = upgraded.$client.query("SELECT name FROM pragma_table_info('hallado_push_tokens')").all().map((r: any) => r.name);
    expect(columns).toEqual(["id", "token", "user_id", "session_id", "created_at", "updated_at"]);
    expect(upgraded.select().from(pushTokens).all()).toHaveLength(0);
    expect(upgraded.select().from(pushOutbox).all()).toHaveLength(0);
    expect(upgraded.select().from(users).where(eq(users.id, "u-1")).get()!.name).toBe("Uno");
    upgraded.$client.close();
    // Reabrir no vuelve a aplicar nada ni crea tablas por fuera de las migraciones.
    const reopened = createDatabase(path);
    expect(reopened.select().from(pushTokens).all()).toHaveLength(0);
    reopened.$client.close();
  });

  test("una base nueva tiene las tablas push solo por migraciones", () => {
    const tables = db.$client.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'hallado_push%' ORDER BY name").all().map((r: any) => r.name);
    expect(tables).toEqual(["hallado_push_outbox", "hallado_push_tokens"]);
  });
});
