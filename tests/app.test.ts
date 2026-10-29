import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createApp } from "../src/app";
import { createDatabase } from "../src/database";
import { createSession } from "../src/auth";
import { claims, halladoPublications as posts, loginAttempts, otpCodes, sessions, users } from "../src/db/schema";
import { localDate, nowIso } from "../src/utils";
import { config } from "../src/config";
import { sendOtp } from "../src/mailer";

let db: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createApp>;
let temp: string;
let codes: Map<string, string>;
let accounts: { id: string; email: string; token: string }[];
const password = "Hallado123";
const passwordHash = await Bun.password.hash(password);

async function api(path: string, method = "GET", body?: unknown, token?: string) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined && !(body instanceof FormData)) headers.set("Content-Type", "application/json");
  const request = new Request(`http://localhost${path}`, { method, headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const response = await app.handle(request);
  const data: any = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
  return { response, data };
}
function postBody(extra: Record<string, unknown> = {}) {
  return { tipo: "encontre", titulo: "Llaves con llavero azul", descripcion: "Juego de tres llaves con un llavero de color azul.",
    categoria: "Llaves", barrio: "Palermo", fecha: localDate(), franja: "tarde", direccionExacta: "Calle privada 123", fotos: [],
    preguntaVerificacion: "¿Qué dibujo tiene el llavero?", respuestaVerificacion: "Una estrella azul", ...extra };
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a++sAAAAASUVORK5CYII=", "base64");
async function uploadProof(account = 1, path = "/uploads/pruebas") {
  const form = new FormData(); form.set("file", new File([PNG], "prueba.png", { type: "image/png" }));
  const result = await api(path, "POST", form, accounts[account]!.token);
  expect(result.response.status).toBe(201);
  return result.data as { url: string; filename: string };
}
const filters = { situacion: "perdi", categoria: "Llaves", zona: "Palermo", periodo: "semana" };
const query = (extra: Record<string, string> = {}) => `/publicaciones?${new URLSearchParams({ ...filters, ...extra })}`;
async function publish(extra: Record<string, unknown> = {}, owner = 0) {
  const result = await api("/publicaciones", "POST", postBody(extra), accounts[owner]!.token);
  expect(result.response.status).toBe(201);
  return result.data;
}
async function claim(postId: string, claimant = 1, extra: Record<string, unknown> = {}) {
  // «Es mío» responde la pregunta del hallazgo; «Lo encontré» adjunta foto privada y barrio.
  const tipo = (await api(`/publicaciones/${postId}`)).data.tipo;
  const evidence = tipo === "encontrado" ? { respuestaVerificacion: "Una estrella azul" }
    : { fotoPrueba: (await uploadProof(claimant)).url, barrio: "Palermo" };
  const result = await api(`/publicaciones/${postId}/reclamos`, "POST", { mensaje: "Son mis llaves, tienen una marca especial.", ...evidence, ...extra }, accounts[claimant]!.token);
  expect(result.response.status).toBe(201);
  return result.data;
}
async function accept(postId: string, claimant = 1) {
  const c = await claim(postId, claimant);
  expect((await api(`/reclamos/${c.id}/aceptar`, "POST", undefined, accounts[0]!.token)).response.status).toBe(200);
  return c;
}

beforeEach(async () => {
  temp = mkdtempSync(join(tmpdir(), "hallado-test-"));
  db = createDatabase(":memory:");
  codes = new Map();
  app = createApp(db, { uploadsPath: join(temp, "uploads"), sendOtp: async ({ email, code, purpose }) => { codes.set(`${email}:${purpose}`, code); } });
  accounts = [];
  for (let i = 0; i < 3; i++) {
    const id = `user-${i}`;
    const email = `test${i}@example.com`;
    db.insert(users).values({ id, email, passwordHash, name: `Persona ${i}`, phone: `115555000${i}`, sharePhone: true, zone: "Palermo", createdAt: nowIso(), emailVerifiedAt: nowIso() }).run();
    accounts.push({ id, email, token: (await createSession(db, id, 1)).token });
  }
});
afterEach(() => { db.$client.close(); rmSync(temp, { recursive: true, force: true }); });

describe("Hallado", () => {
  test("salud, documentación y CORS", async () => {
    expect((await api("/health")).data.status).toBe("ok");
    const docs = await api("/docs");
    expect(docs.data.name).toBe("Hallado API");
    const documented = new Set(docs.data.routes.map((r: any) => `${r.method} ${r.path}`));
    for (const route of app.routes.filter((r) => !["/", "/health", "/docs", "/*"].includes(r.path))) {
      expect(documented.has(`${route.method} ${route.path}`)).toBe(true);
    }
    const options = await api("/publicaciones", "OPTIONS");
    expect(options.response.status).toBe(204);
    expect(options.response.headers.get("access-control-allow-origin")).toBe("*");
  });
  test("registro por etapas: check no crea cuenta y verify exige contraseña", async () => {
    const email = "new@example.com";
    expect((await api("/auth/otp/request", "POST", { email, purpose: "registration" })).response.status).toBe(200);
    const code = codes.get(`${email}:registration`)!;
    const body = { email, code, purpose: "registration" };
    expect((await api("/auth/otp/check", "POST", body)).data.valid).toBe(true);
    expect(db.select().from(users).where(eq(users.email, email)).get()).toBeUndefined();
    expect((await api("/auth/otp/verify", "POST", body)).data.error.code).toBe("PASSWORD_REQUIRED");
    expect((await api("/auth/otp/verify", "POST", { ...body, password: "abcdefgh" })).data.error.code).toBe("INVALID_PASSWORD");
    const completed = await api("/auth/otp/verify", "POST", { ...body, password });
    expect(completed.response.status).toBe(200);
    expect(completed.data.usuario.email).toBe(email);
    expect((await api("/me", "GET", undefined, completed.data.session.token)).data.email).toBe(email);
    expect((await api("/auth/otp/check", "POST", body)).response.status).toBe(400);
    expect((await api("/auth/login/password", "POST", { email, password })).response.status).toBe(200);
    expect((await api("/auth/otp/request", "POST", { email, purpose: "registration" })).response.status).toBe(409);
  });
  test("OTP vence, bloquea intentos, aplica espera y reemplaza códigos", async () => {
    const email = "otp@example.com";
    const body = { email, purpose: "registration" };
    await api("/auth/otp/request", "POST", body);
    const code = codes.get(`${email}:registration`)!;
    expect((await api("/auth/otp/resend", "POST", body)).response.status).toBe(429);
    for (let i = 0; i < 5; i++) {
      const wrong = code === "111111" ? "222222" : "111111";
      expect((await api("/auth/otp/check", "POST", { ...body, code: wrong })).response.status).toBe(400);
    }
    expect((await api("/auth/otp/check", "POST", { ...body, code })).response.status).toBe(429);
    db.update(otpCodes).set({ createdAt: new Date(Date.now() - 60_000).toISOString() }).where(eq(otpCodes.email, email)).run();
    await api("/auth/otp/resend", "POST", body);
    expect(db.select().from(otpCodes).where(eq(otpCodes.email, email)).all().filter((o) => !o.consumedAt)).toHaveLength(1);
    const fresh = codes.get(`${email}:registration`)!;
    expect((await api("/auth/otp/check", "POST", { ...body, code: fresh })).response.status).toBe(200);
    db.update(otpCodes).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(otpCodes.email, email)).run();
    expect((await api("/auth/otp/check", "POST", { ...body, code: fresh })).response.status).toBe(400);
  });
  test("un OTP no crea dos cuentas con finalizaciones simultáneas", async () => {
    const email = "race@example.com";
    await api("/auth/otp/request", "POST", { email, purpose: "registration" });
    const body = { email, purpose: "registration", code: codes.get(`${email}:registration`), password };
    const results = await Promise.all([api("/auth/otp/verify", "POST", body), api("/auth/otp/verify", "POST", body)]);
    expect(results.map((r) => r.response.status).sort()).toEqual([200, 400]);
    const u = db.select().from(users).where(eq(users.email, email)).all();
    expect(u).toHaveLength(1);
    expect(db.select().from(sessions).where(eq(sessions.userId, u[0]!.id)).all()).toHaveLength(1);
  });
  test("recupero cambia contraseña, revoca sesiones y no revela emails inexistentes", async () => {
    const email = accounts[0]!.email;
    const unknown = await api("/auth/otp/request", "POST", { email: "unknown@example.com", purpose: "set_password" });
    const known = await api("/auth/otp/request", "POST", { email, purpose: "set_password" });
    expect(unknown.data.message).toBe(known.data.message);
    expect(codes.has("unknown@example.com:set_password")).toBe(false);
    const result = await api("/auth/otp/verify", "POST", { email, purpose: "set_password", code: codes.get(`${email}:set_password`), password: "Nueva12345" });
    expect(result.response.status).toBe(200);
    expect((await api("/me", "GET", undefined, accounts[0]!.token)).response.status).toBe(401);
    expect((await api("/auth/login/password", "POST", { email, password })).response.status).toBe(401);
    expect((await api("/auth/login/password", "POST", { email, password: "Nueva12345" })).response.status).toBe(200);
  });
  test("login limita intentos fallidos y logout invalida el token", async () => {
    const email = accounts[0]!.email;
    for (let i = 0; i < 5; i++) expect((await api("/auth/login/password", "POST", { email, password: "Wrong123" })).response.status).toBe(401);
    expect((await api("/auth/login/password", "POST", { email, password })).response.status).toBe(429);
    db.update(loginAttempts).set({ windowStart: new Date(Date.now() - 901_000).toISOString() }).run();
    const login = await api("/auth/login/password", "POST", { email, password });
    expect(login.response.status).toBe(200);
    const token = login.data.session.token;
    expect((await api("/auth/logout", "POST", undefined, token)).response.status).toBe(200);
    expect((await api("/me", "GET", undefined, token)).response.status).toBe(401);
  });
  test("recuperar desbloquea login y revoca OTP de acceso anteriores", async () => {
    const email = accounts[0]!.email;
    await api("/auth/otp/request", "POST", { email, purpose: "login" });
    const oldCode = codes.get(`${email}:login`)!;
    const wrongs = await Promise.all(Array.from({ length: 5 }, () => api("/auth/login/password", "POST", { email, password: "Wrong123" })));
    expect(wrongs.every((r) => r.response.status === 401)).toBe(true);
    expect((await api("/auth/login/password", "POST", { email, password })).response.status).toBe(429);
    await api("/auth/otp/request", "POST", { email, purpose: "set_password" });
    const reset = await api("/auth/otp/verify", "POST", { email, code: codes.get(`${email}:set_password`), purpose: "set_password", password: "Reset12345" });
    expect(reset.response.status).toBe(200);
    expect((await api("/auth/otp/verify", "POST", { email, code: oldCode, purpose: "login" })).response.status).toBe(400);
    expect((await api("/auth/login/password", "POST", { email, password: "Reset12345" })).response.status).toBe(200);
  });
  test("si el envío falla, no queda un OTP utilizable ni espera de reenvío", async () => {
    const badApp = createApp(db, { uploadsPath: temp, sendOtp: async () => { throw new (await import("../src/errors")).ApiError(503, "EMAIL_DELIVERY_FAILED", "Falló el envío"); } });
    const response = await badApp.handle(new Request("http://localhost/auth/otp/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "fail@example.com", purpose: "registration" }) }));
    expect(response.status).toBe(503);
    expect(db.select().from(otpCodes).where(eq(otpCodes.email, "fail@example.com")).all()).toHaveLength(0);
  });
  test("perfil privado editable y perfil público sin teléfono, email ni historial", async () => {
    const token = accounts[0]!.token;
    const update = await api("/me", "PATCH", { name: "Federico", phone: "1155551234", zone: "Centro", sharePhone: false }, token);
    expect(update.data.name).toBe("Federico");
    expect(update.data.sharePhone).toBe(false);
    const profile = (await api(`/usuarios/${accounts[0]!.id}`)).data;
    expect(profile.phone).toBeUndefined(); expect(profile.email).toBeUndefined(); expect(profile.publications).toBeUndefined();
    expect(profile.reputation.completedReturns).toBe(0);
    expect((await api("/me", "PATCH", { name: "   " }, token)).response.status).toBe(422);
  });
  test("búsqueda devuelve el tipo opuesto y filtra barrio, palabras, fechas y categoría", async () => {
    const target = await publish();
    await publish({ tipo: "perdi" });
    await publish({ barrio: "Belgrano" });
    await publish({ categoria: "Otros" });
    await publish({ fecha: "2020-01-01" });
    const result = await api(query({ palabras: "LLÁVES AZUL", periodo: "hoy" }));
    expect(result.data.total).toBe(1); expect(result.data.items[0].id).toBe(target.id);
    expect((await api(query({ situacion: "encontre" }))).data.total).toBe(1);
    expect((await api(query({ palabras: "inexistente" }))).data.total).toBe(0);
  });
  test("búsqueda pagina, ordena por cercanía y limita radio GPS", async () => {
    await publish({ titulo: "Más lejos", ubicacion: { latitud: -34.59, longitud: -58.43 } });
    const near = await publish({ titulo: "Más cerca", ubicacion: { latitud: -34.5889, longitud: -58.4306 } });
    const result = await api(query({ orden: "cercanos", pageSize: "1" }));
    expect(result.data.total).toBe(2); expect(result.data.totalPages).toBe(2); expect(result.data.items[0].id).toBe(near.id);
    const gps = await api(query({ zona: "", latitud: "-34.5889", longitud: "-58.4306", radioKm: "0.1" }));
    expect(gps.data.total).toBe(1);
    expect((await api(query({ pageSize: "0" }))).response.status).toBe(422);
    expect((await api(query({ orden: "inventado" }))).response.status).toBe(422);
  });
  test("valida filtros, coordenadas y fechas imposibles o futuras", async () => {
    expect((await api(query({ periodo: "rango", desde: "2026-02-30", hasta: localDate() }))).response.status).toBe(422);
    expect((await api(query({ periodo: "rango", desde: localDate(), hasta: "2020-01-01" }))).response.status).toBe(422);
    expect((await api(query({ zona: "" }))).response.status).toBe(422);
    expect((await api(query({ zona: "", latitud: "91", longitud: "0" }))).response.status).toBe(422);
    expect((await api("/publicaciones", "POST", postBody({ fecha: "2099-12-31" }), accounts[0]!.token)).response.status).toBe(422);
    expect((await api("/publicaciones", "POST", postBody({ titulo: "    " }), accounts[0]!.token)).response.status).toBe(422);
  });
  test("historial conserva cinco búsquedas únicas del usuario", async () => {
    for (let i = 0; i < 7; i++) await api(query({ palabras: `palabra${i}` }), "GET", undefined, accounts[0]!.token);
    await api(query({ palabras: "palabra6" }), "GET", undefined, accounts[0]!.token);
    const history = (await api("/me/busquedas", "GET", undefined, accounts[0]!.token)).data.items;
    expect(history).toHaveLength(5);
    expect(history.filter((r: any) => r.filtros.palabras === "palabra6")).toHaveLength(1);
    expect((await api("/me/busquedas", "GET", undefined, accounts[1]!.token)).data.items).toHaveLength(0);
  });
  test("solo el propietario puede editar o eliminar y la eliminación oculta resultados", async () => {
    const p = await publish();
    expect((await api(`/publicaciones/${p.id}`, "PATCH", { titulo: "Otro título" }, accounts[1]!.token)).response.status).toBe(403);
    expect((await api(`/publicaciones/${p.id}`, "DELETE", undefined, accounts[1]!.token)).response.status).toBe(403);
    expect((await api(`/publicaciones/${p.id}`, "PATCH", { titulo: "Título actualizado" }, accounts[0]!.token)).data.titulo).toBe("Título actualizado");
    expect((await api(`/publicaciones/${p.id}`, "DELETE", undefined, accounts[0]!.token)).response.status).toBe(200);
    expect((await api(`/publicaciones/${p.id}`)).response.status).toBe(404);
    expect((await api(query())).data.total).toBe(0);
  });
  test("la dirección y el teléfono solo se habilitan a las partes del reclamo aceptado", async () => {
    const p = await publish(); const c = await claim(p.id);
    expect((await api(`/publicaciones/${p.id}`)).data.direccionExacta).toBeNull();
    expect((await api(`/publicaciones/${p.id}`, "GET", undefined, accounts[1]!.token)).data.publicador.phone).toBeUndefined();
    expect((await api(`/publicaciones/${p.id}/reclamos`, "GET", undefined, accounts[0]!.token)).data.items[0].telefono).toBeNull();
    await api(`/reclamos/${c.id}/aceptar`, "POST", undefined, accounts[0]!.token);
    const accepted = (await api(`/publicaciones/${p.id}`, "GET", undefined, accounts[1]!.token)).data;
    expect(accepted.direccionExacta).toBe("Calle privada 123"); expect(accepted.publicador.phone).toBe("1155550000");
    const stranger = (await api(`/publicaciones/${p.id}`, "GET", undefined, accounts[2]!.token)).data;
    expect(stranger.direccionExacta).toBeNull(); expect(stranger.publicador.phone).toBeUndefined();
    await api("/me", "PATCH", { sharePhone: false }, accounts[0]!.token);
    expect((await api(`/publicaciones/${p.id}`, "GET", undefined, accounts[1]!.token)).data.publicador.phone).toBeUndefined();
  });
  test("rechazar o cancelar revoca datos privados y reabre la publicación", async () => {
    const p = await publish(); const c = await accept(p.id);
    expect((await api(`/reclamos/${c.id}/rechazar`, "POST", undefined, accounts[0]!.token)).response.status).toBe(200);
    const result = await api(`/publicaciones/${p.id}`, "GET", undefined, accounts[1]!.token);
    expect(result.data.estado).toBe("abierta"); expect(result.data.direccionExacta).toBeNull();
    const again = await claim(p.id);
    await api(`/reclamos/${again.id}/aceptar`, "POST", undefined, accounts[0]!.token);
    expect((await api(`/reclamos/${again.id}/cancelar`, "POST", undefined, accounts[1]!.token)).response.status).toBe(200);
    expect((await api(`/publicaciones/${p.id}`)).data.estado).toBe("abierta");
  });
  test("no admite reclamos propios, duplicados ni dos aceptados", async () => {
    const p = await publish();
    expect((await api(`/publicaciones/${p.id}/reclamos`, "POST", { mensaje: "Son mis llaves." }, accounts[0]!.token)).response.status).toBe(409);
    const c1 = await claim(p.id); const c2 = await claim(p.id, 2);
    expect((await api(`/publicaciones/${p.id}/reclamos`, "POST", { mensaje: "Otra vez mis llaves." }, accounts[1]!.token)).response.status).toBe(409);
    const results = await Promise.all([api(`/reclamos/${c1.id}/aceptar`, "POST", undefined, accounts[0]!.token), api(`/reclamos/${c2.id}/aceptar`, "POST", undefined, accounts[0]!.token)]);
    expect(results.map((r) => r.response.status).sort()).toEqual([200, 409]);
    expect(db.select().from(claims).where(eq(claims.estado, "aceptado")).all()).toHaveLength(1);
    expect((await api(`/publicaciones/${p.id}`, "PATCH", { titulo: "Cambio indebido" }, accounts[0]!.token)).response.status).toBe(409);
  });
  test("mensajería privada requiere reclamo aceptado y las partes correctas", async () => {
    const p = await publish(); const c = await claim(p.id);
    expect((await api(`/reclamos/${c.id}/mensajes`, "POST", { texto: "Hola" }, accounts[1]!.token)).response.status).toBe(409);
    await api(`/reclamos/${c.id}/aceptar`, "POST", undefined, accounts[0]!.token);
    expect((await api(`/reclamos/${c.id}/mensajes`, "POST", { texto: "Hola, coordinamos?" }, accounts[1]!.token)).response.status).toBe(201);
    expect((await api(`/reclamos/${c.id}/mensajes`, "GET", undefined, accounts[0]!.token)).data.items).toHaveLength(1);
    expect((await api(`/reclamos/${c.id}/mensajes`, "GET", undefined, accounts[2]!.token)).response.status).toBe(403);
    expect((await api(`/publicaciones/${p.id}/reclamos`, "GET", undefined, accounts[2]!.token)).response.status).toBe(403);
  });
  test("resolver requiere aceptación y las valoraciones solo pertenecen a las partes", async () => {
    const p = await publish();
    expect((await api(`/publicaciones/${p.id}/resolver`, "POST", undefined, accounts[0]!.token)).response.status).toBe(409);
    const c = await accept(p.id);
    expect((await api(`/publicaciones/${p.id}/valoraciones`, "POST", { positiva: true }, accounts[0]!.token)).response.status).toBe(409);
    expect((await api(`/publicaciones/${p.id}/resolver`, "POST", undefined, accounts[1]!.token)).response.status).toBe(403);
    expect((await api(`/publicaciones/${p.id}/resolver`, "POST", undefined, accounts[0]!.token)).response.status).toBe(200);
    expect((await api(`/publicaciones/${p.id}/valoraciones`, "POST", { positiva: true }, accounts[2]!.token)).response.status).toBe(403);
    expect((await api(`/publicaciones/${p.id}/valoraciones`, "POST", { positiva: true, comentario: "Gracias" }, accounts[0]!.token)).response.status).toBe(201);
    expect((await api(`/publicaciones/${p.id}/valoraciones`, "POST", { positiva: false }, accounts[1]!.token)).response.status).toBe(201);
    expect((await api(`/publicaciones/${p.id}/valoraciones`, "POST", { positiva: true }, accounts[0]!.token)).response.status).toBe(409);
    expect((await api(`/reclamos/${c.id}/rechazar`, "POST", undefined, accounts[0]!.token)).response.status).toBe(409);
    const a = (await api(`/usuarios/${accounts[0]!.id}`)).data;
    const b = (await api(`/usuarios/${accounts[1]!.id}`)).data;
    expect(a.reputation).toEqual({ completedReturns: 1, positiveReviews: 0, negativeReviews: 1 });
    expect(b.reputation).toEqual({ completedReturns: 1, positiveReviews: 1, negativeReviews: 0 });
  });
  test("Vecino solidario aparece tras cinco devoluciones reales", async () => {
    for (let i = 0; i < 5; i++) {
      const p = await publish({ titulo: `Devolución ${i}` }); await accept(p.id);
      await api(`/publicaciones/${p.id}/resolver`, "POST", undefined, accounts[0]!.token);
    }
    const profile = (await api(`/usuarios/${accounts[0]!.id}`)).data;
    expect(profile.reputation.completedReturns).toBe(5); expect(profile.badges[0].name).toBe("Vecino solidario");
  });
  test("seguidores reciben novedades y dejar de seguir es idempotente", async () => {
    const p = await publish();
    await api(`/publicaciones/${p.id}/seguir`, "POST", undefined, accounts[2]!.token);
    await api(`/publicaciones/${p.id}/seguir`, "POST", undefined, accounts[2]!.token);
    expect((await api("/me/seguidas", "GET", undefined, accounts[2]!.token)).data.total).toBe(1);
    await api(`/publicaciones/${p.id}`, "PATCH", { titulo: "Llaves actualizadas" }, accounts[0]!.token);
    expect((await api("/notificaciones", "GET", undefined, accounts[2]!.token)).data.sinLeer).toBe(1);
    await api(`/publicaciones/${p.id}/seguir`, "DELETE", undefined, accounts[2]!.token);
    await api(`/publicaciones/${p.id}/seguir`, "DELETE", undefined, accounts[2]!.token);
    expect((await api("/me/seguidas", "GET", undefined, accounts[2]!.token)).data.total).toBe(0);
  });
  test("alertas detectan coincidencias, deduplican y respetan dueño y estado", async () => {
    const token = accounts[1]!.token;
    const alert = await api("/alertas", "POST", { filtros: filters }, token);
    expect(alert.response.status).toBe(201);
    expect((await api("/alertas", "POST", { filtros: filters }, token)).data.id).toBe(alert.data.id);
    const p = await publish();
    await api(`/publicaciones/${p.id}`, "PATCH", { titulo: "Llaves nuevas" }, accounts[0]!.token);
    const notifs = (await api("/notificaciones", "GET", undefined, token)).data;
    expect(notifs.items).toHaveLength(1); expect(notifs.items[0].tipo).toBe("coincidencia");
    expect((await api(`/alertas/${alert.data.id}`, "PATCH", { activa: false }, accounts[2]!.token)).response.status).toBe(404);
    await api(`/alertas/${alert.data.id}`, "PATCH", { activa: false }, token);
    await publish({ titulo: "Llaves de otra persona" });
    expect((await api("/notificaciones", "GET", undefined, token)).data.total).toBe(1);
    await api(`/alertas/${alert.data.id}`, "PATCH", { activa: true }, token);
    expect((await api("/notificaciones", "GET", undefined, token)).data.total).toBe(2);
    expect((await api(`/notificaciones/${notifs.items[0].id}/leida`, "POST", undefined, accounts[2]!.token)).response.status).toBe(404);
    await api(`/alertas/${alert.data.id}/leida`, "POST", undefined, token);
    expect((await api("/notificaciones", "GET", undefined, token)).data.sinLeer).toBe(0);
  });
  test("fotos se suben y sirven, pero no se pueden adjuntar fotos ajenas", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a++sAAAAASUVORK5CYII=", "base64");
    const form = new FormData(); form.set("file", new File([png], "image.png", { type: "image/png" }));
    const result = await api("/uploads/images", "POST", form, accounts[0]!.token);
    expect(result.response.status).toBe(201);
    const image = await app.handle(new Request(`http://localhost${result.data.url}`));
    expect(image.status).toBe(200); expect(image.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await image.arrayBuffer()).equals(png)).toBe(true);
    const p = await publish({ fotos: [result.data.url] }); expect(p.fotos).toHaveLength(1);
    expect((await api("/me", "PATCH", { avatarUrl: result.data.url }, accounts[0]!.token)).data.avatarUrl).toBe(result.data.url);
    expect((await api("/me", "PATCH", { avatarUrl: result.data.url }, accounts[1]!.token)).response.status).toBe(403);
    expect((await api("/publicaciones", "POST", postBody({ fotos: [result.data.url] }), accounts[1]!.token)).response.status).toBe(403);
    expect((await api("/publicaciones", "POST", postBody({ fotos: ["file:///local/photo.jpg"] }), accounts[0]!.token)).response.status).toBe(422);
    const bad = new FormData(); bad.set("file", new File(["<svg/>"], "x.png", { type: "image/png" }));
    expect((await api("/uploads/images", "POST", bad, accounts[0]!.token)).response.status).toBe(422);
  });
  test("sesiones vencidas y escrituras anónimas se rechazan", async () => {
    db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(sessions.userId, accounts[0]!.id)).run();
    expect((await api("/me", "GET", undefined, accounts[0]!.token)).response.status).toBe(401);
    expect((await api("/publicaciones", "POST", postBody())).response.status).toBe(401);
    expect((await api("/me")).response.status).toBe(401);
  });
  test("migración sobre TP1 conserva usuarios y añade consentimiento de teléfono", () => {
    const folder = join(temp, "old-migrations");
    for (const name of readdirSync(new URL("../drizzle", import.meta.url))) {
      if (name.startsWith("2026") && !name.startsWith("202610")) cpSync(new URL(`../drizzle/${name}`, import.meta.url), join(folder, name), { recursive: true });
    }
    const path = join(temp, "legacy.sqlite");
    const raw = new Database(path, { create: true });
    const old = drizzle({ client: raw }); migrate(old, { migrationsFolder: folder });
    raw.run("INSERT INTO users (id,email,name,created_at,email_verified_at) VALUES (?,?,?,?,?)", ["legacy-user", "legacy@example.com", "Usuario previo", nowIso(), nowIso()]);
    raw.close();
    const upgraded = createDatabase(path);
    const user = upgraded.select().from(users).where(eq(users.id, "legacy-user")).get()!;
    expect(user.name).toBe("Usuario previo"); expect(user.sharePhone).toBe(false);
    expect(upgraded.select().from(posts).all()).toHaveLength(0);
    upgraded.$client.close();
  });
  test("reabrir SQLite mantiene las publicaciones", () => {
    const path = join(temp, "persist.sqlite");
    let disk = createDatabase(path);
    disk.insert(users).values({ id: "persist-user", email: "persist@example.com", name: "Persistente", createdAt: nowIso(), emailVerifiedAt: nowIso() }).run();
    disk.insert(posts).values({ id: "persist-post", userId: "persist-user", ...postBody(), tipo: "encontrado", categoria: "Llaves", franja: "tarde", latitud: -34, longitud: -58, createdAt: nowIso(), updatedAt: nowIso() }).run();
    disk.$client.close(); disk = createDatabase(path);
    expect(disk.select().from(posts).get()!.titulo).toBe("Llaves con llavero azul");
    disk.$client.close();
  });
  test("Resend: carga correcta y error del proveedor sin envío externo", async () => {
    const oldMode = config.emailMode;
    const originalFetch = globalThis.fetch;
    try {
      Object.assign(config, { emailMode: "resend" });
      let sent: any;
      globalThis.fetch = (async (_url: any, options: any) => { sent = JSON.parse(options.body); return Response.json({ id: "mock-id" }); }) as typeof fetch;
      await sendOtp({ email: "test@example.com", code: "123456", purpose: "registration" });
      expect(sent.to).toEqual(["test@example.com"]); expect(sent.text).toContain("123456");
      globalThis.fetch = (async () => new Response("error", { status: 503 })) as unknown as typeof fetch;
      await expect(sendOtp({ email: "test@example.com", code: "123456", purpose: "registration" })).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
    } finally { Object.assign(config, { emailMode: oldMode }); globalThis.fetch = originalFetch; }
  });
  test("máximo de 3 intentos de reclamo por publicación", async () => {
    const p = await publish();
    // Intento 1
    const c1 = await claim(p.id);
    expect(c1.intentos).toBe(1);
    await api(`/reclamos/${c1.id}/rechazar`, "POST", undefined, accounts[0]!.token);

    // Intento 2
    const c2 = await claim(p.id);
    expect(c2.intentos).toBe(2);
    await api(`/reclamos/${c2.id}/rechazar`, "POST", undefined, accounts[0]!.token);

    // Intento 3
    const c3 = await claim(p.id);
    expect(c3.intentos).toBe(3);
    await api(`/reclamos/${c3.id}/rechazar`, "POST", undefined, accounts[0]!.token);

    // Intento 4: debe fallar por superar los 3 intentos
    const c4Res = await api(`/publicaciones/${p.id}/reclamos`, "POST", { mensaje: "Intento cuatro prohibido" }, accounts[1]!.token);
    expect(c4Res.response.status).toBe(409);
    expect(c4Res.data.error.code).toBe("MAX_ATTEMPTS_EXCEEDED");
  });
  test("reclamo vence automáticamente a las 48 horas sin respuesta", async () => {
    const p = await publish();
    const c = await claim(p.id);
    expect(c.estado).toBe("pendiente");

    // Simulamos que pasaron 49 horas sin respuesta
    const pasado49hs = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    db.update(claims).set({ createdAt: pasado49hs, updatedAt: pasado49hs }).where(eq(claims.id, c.id)).run();

    // Al consultar la publicación, el reclamo figura como vencido
    const postRes = await api(`/publicaciones/${p.id}`, "GET", undefined, accounts[1]!.token);
    expect(postRes.data.miReclamo.estado).toBe("vencido");
    expect(postRes.data.reclamoEnviado).toBe(false);

    // El dueño intenta aceptar el reclamo vencido: debe fallar con 409
    const aceptarRes = await api(`/reclamos/${c.id}/aceptar`, "POST", undefined, accounts[0]!.token);
    expect(aceptarRes.response.status).toBe(409);
    expect(aceptarRes.data.error.code).toBe("CLAIM_EXPIRED");

    // El usuario puede enviar su intento 2
    const intento2 = await claim(p.id);
    expect(intento2.estado).toBe("pendiente");
    expect(intento2.intentos).toBe(2);
  });
  test("sección mis reclamos: lista enviados y recibidos", async () => {
    const p = await publish();
    const c = await claim(p.id, 1);

    // Reclamante consulta enviados
    const enviados = await api("/me/reclamos?tipo=enviados", "GET", undefined, accounts[1]!.token);
    expect(enviados.data.items).toHaveLength(1);
    expect(enviados.data.items[0].id).toBe(c.id);
    expect(enviados.data.items[0].esEnviado).toBe(true);

    // Publicador consulta recibidos
    const recibidos = await api("/me/reclamos?tipo=recibidos", "GET", undefined, accounts[0]!.token);
    expect(recibidos.data.items).toHaveLength(1);
    expect(recibidos.data.items[0].id).toBe(c.id);
    expect(recibidos.data.items[0].esRecibido).toBe(true);

    // Publicador acepta el reclamo
    const aceptado = await api(`/reclamos/${c.id}/aceptar`, "POST", undefined, accounts[0]!.token);
    expect(aceptado.response.status).toBe(200);

    const actualizados = await api("/me/reclamos?tipo=recibidos", "GET", undefined, accounts[0]!.token);
    expect(actualizados.data.items[0].estado).toBe("aceptado");
  });
});

describe("Punto de encuentro", () => {
  async function propose(id: string, user: number, direccion = "Av. Santa Fe 1234, CABA") {
    const actual = (await api(`/reclamos/${id}/encuentro`, "GET", undefined, accounts[user]!.token)).data;
    return api(`/reclamos/${id}/encuentro`, "POST", {
      direccion, propuestaId: actual.encuentro?.id ?? null, intento: actual.intento,
    }, accounts[user]!.token);
  }

  for (const tipo of ["encontre", "perdi"]) {
    test(`${tipo}: propone quien tiene el objeto y acuerdan una alternativa`, async () => {
      const p = await publish({ tipo }); const c = await accept(p.id);
      const holder = tipo === "encontre" ? 0 : 1; const other = 1 - holder;
      expect((await propose(c.id, other)).response.status).toBe(409);
      const first = await propose(c.id, holder);
      expect(first.response.status).toBe(200);
      expect(first.data.puedeResponder).toBe(false);
      const body = { propuestaId: first.data.encuentro.id, intento: 1 };
      expect((await api(`/reclamos/${c.id}/encuentro/aceptar`, "POST", body, accounts[holder]!.token)).response.status).toBe(409);
      const second = await propose(c.id, other, "Lima 775, CABA");
      expect(second.response.status).toBe(200);
      expect(second.data.encuentro.id).not.toBe(first.data.encuentro.id);
      expect((await api(`/reclamos/${c.id}/encuentro/aceptar`, "POST", body, accounts[other]!.token)).response.status).toBe(409);
      const accepted = await api(`/reclamos/${c.id}/encuentro/aceptar`, "POST", {
        propuestaId: second.data.encuentro.id, intento: 1,
      }, accounts[holder]!.token);
      expect(accepted.response.status).toBe(200);
      expect(accepted.data.encuentro.estado).toBe("aceptado");
      const read = await api(`/reclamos/${c.id}/encuentro`, "GET", undefined, accounts[other]!.token);
      expect(read.data.encuentro.direccion).toBe("Lima 775, CABA");
      expect(read.data.encuentro.estado).toBe("aceptado");
      expect((await propose(c.id, holder)).response.status).toBe(409);
    });
  }

  test("el encuentro es privado y requiere un reclamo aceptado", async () => {
    const p = await publish(); const c = await claim(p.id);
    const path = `/reclamos/${c.id}/encuentro`;
    expect((await api(path)).response.status).toBe(401);
    expect((await api(path, "GET", undefined, accounts[2]!.token)).response.status).toBe(403);
    expect((await api(path, "GET", undefined, accounts[0]!.token)).response.status).toBe(409);
    await api(`/reclamos/${c.id}/aceptar`, "POST", undefined, accounts[0]!.token);
    const body = { direccion: "Lima 775, CABA", propuestaId: null, intento: 1 };
    expect((await api(path, "POST", body, accounts[2]!.token)).response.status).toBe(403);
    expect((await api(path + "/aceptar", "POST", { propuestaId: "ajeno", intento: 1 }, accounts[2]!.token)).response.status).toBe(403);
    expect((await propose(c.id, 0, "   ")).response.status).toBe(422);
    expect((await propose(c.id, 0, "a".repeat(201))).response.status).toBe(422);
    await api(`/publicaciones/${p.id}/resolver`, "POST", undefined, accounts[0]!.token);
    expect((await api(path, "POST", body, accounts[0]!.token)).response.status).toBe(409);
  });

  test("dos respuestas a la misma propuesta no se pisan", async () => {
    const p = await publish(); const c = await accept(p.id);
    const first = await propose(c.id, 0);
    const body = { propuestaId: first.data.encuentro.id, intento: 1 };
    const path = `/reclamos/${c.id}/encuentro`;
    const results = await Promise.all([
      api(path, "POST", { ...body, direccion: "Lima 775, CABA" }, accounts[1]!.token),
      api(path + "/aceptar", "POST", body, accounts[1]!.token),
    ]);
    expect(results.map((r) => r.response.status).sort()).toEqual([200, 409]);
  });

  test("un nuevo intento no reutiliza el encuentro anterior", async () => {
    const p = await publish(); const c = await accept(p.id);
    const first = await propose(c.id, 0);
    await api(`/reclamos/${c.id}/cancelar`, "POST", undefined, accounts[1]!.token);
    expect((await api(`/reclamos/${c.id}/encuentro`, "GET", undefined, accounts[0]!.token)).response.status).toBe(409);
    const retry = await accept(p.id);
    expect(retry.id).toBe(c.id);
    const actual = await api(`/reclamos/${c.id}/encuentro`, "GET", undefined, accounts[0]!.token);
    expect(actual.data.encuentro).toBeNull(); expect(actual.data.intento).toBe(2);
    expect((await api(`/reclamos/${c.id}/encuentro`, "POST", {
      direccion: "Lima 775, CABA", propuestaId: null, intento: 1,
    }, accounts[0]!.token)).response.status).toBe(409);
    expect((await api(`/reclamos/${c.id}/encuentro/aceptar`, "POST", {
      propuestaId: first.data.encuentro.id, intento: 1,
    }, accounts[1]!.token)).response.status).toBe(409);
    expect((await propose(c.id, 0)).response.status).toBe(200);
  });

  test("el acuerdo permanece al reabrir la base", async () => {
    db.$client.close();
    const path = join(temp, "encuentro.sqlite");
    db = createDatabase(path);
    for (const account of accounts) {
      db.insert(users).values({ id: account.id, email: account.email, name: account.id,
        createdAt: nowIso(), emailVerifiedAt: nowIso() }).run();
      account.token = (await createSession(db, account.id, 1)).token;
    }
    app = createApp(db);
    const p = await publish(); const c = await accept(p.id);
    const first = await propose(c.id, 0);
    await api(`/reclamos/${c.id}/encuentro/aceptar`, "POST", {
      propuestaId: first.data.encuentro.id, intento: 1,
    }, accounts[1]!.token);
    db.$client.close(); db = createDatabase(path); app = createApp(db);
    const read = await api(`/reclamos/${c.id}/encuentro`, "GET", undefined, accounts[0]!.token);
    expect(read.response.status).toBe(200);
    expect(read.data.encuentro.estado).toBe("aceptado");
    expect(read.data.encuentro.direccion).toBe("Av. Santa Fe 1234, CABA");
  });
});

test("la migración de encuentros conserva reclamos e intentos existentes", () => {
  const folder = join(temp, "before-meetings");
  for (const name of readdirSync(new URL("../drizzle", import.meta.url))) {
    if (name.startsWith("2026") && !name.endsWith("punto_encuentro")) {
      cpSync(new URL(`../drizzle/${name}`, import.meta.url), join(folder, name), { recursive: true });
    }
  }
  const path = join(temp, "upgrade.sqlite");
  const raw = new Database(path, { create: true });
  const old = drizzle({ client: raw });
  migrate(old, { migrationsFolder: folder });
  old.insert(users).values({ id: "owner", email: "owner@example.com", name: "Dueño", emailVerifiedAt: nowIso(), createdAt: nowIso() }).run();
  old.insert(users).values({ id: "claimant", email: "claimant@example.com", name: "Reclamante", emailVerifiedAt: nowIso(), createdAt: nowIso() }).run();
  old.insert(posts).values({ id: "post", userId: "owner", ...postBody(), tipo: "encontrado",
    categoria: "Llaves", franja: "tarde", latitud: -34, longitud: -58, createdAt: nowIso(), updatedAt: nowIso() }).run();
  old.insert(claims).values({ id: "claim", publicationId: "post", userId: "claimant",
    mensaje: "Son mis llaves", estado: "vencido", intentos: 3, createdAt: nowIso(), updatedAt: nowIso() }).run();
  raw.close();
  const upgraded = createDatabase(path);
  try {
    const claim = upgraded.select().from(claims).where(eq(claims.id, "claim")).get()!;
    expect(claim.intentos).toBe(3); expect(claim.estado).toBe("vencido");
    expect(upgraded.$client.query("SELECT COUNT(*) AS total FROM hallado_encounters").get()).toEqual({ total: 0 });
  } finally { upgraded.$client.close(); }
});

describe("historial y valoraciones", () => {
  async function resolve(extra: Record<string, unknown> = {}) {
    const p = await publish(extra);
    await accept(p.id);
    expect((await api(`/publicaciones/${p.id}/resolver`, "POST", undefined, accounts[0]!.token)).response.status).toBe(200);
    return p;
  }
  const history = (account: number, filters = "") => api(`/me/historial${filters}`, "GET", undefined, accounts[account]!.token);

  test("separa devolví y recuperé en ambos tipos de publicación y protege el historial", async () => {
    const found = await resolve();
    const lost = await resolve({ tipo: "perdi" });
    const returned = await history(0, "?tipo=devolvi");
    expect(returned.data.items.map((x: any) => x.id)).toEqual([found.id]);
    expect(returned.data.items[0].contraparte.id).toBe(accounts[1]!.id);
    expect(returned.data.items[0].fecha).toBeTruthy();
    expect(returned.data.items[0].objeto.titulo).toBe(found.titulo);
    expect(returned.data.items[0].puedeValorar).toBe(true);
    expect((await history(0, "?tipo=recupere")).data.items.map((x: any) => x.id)).toEqual([lost.id]);
    expect((await history(1, "?tipo=devolvi")).data.items.map((x: any) => x.id)).toEqual([lost.id]);
    expect((await history(1, "?tipo=recupere")).data.items.map((x: any) => x.id)).toEqual([found.id]);
    expect((await history(2)).data.items).toEqual([]);
    expect((await api("/me/historial")).response.status).toBe(401);
    expect(JSON.stringify(returned.data)).not.toContain("Calle privada");
  });

  test("filtra fechas inclusivas en la zona local, pagina y rechaza filtros inválidos", async () => {
    const older = await resolve();
    const newer = await resolve();
    db.update(posts).set({ resolvedAt: "2026-01-20T02:30:00.000Z" }).where(eq(posts.id, older.id)).run();
    db.update(posts).set({ resolvedAt: "2026-01-21T15:00:00.000Z" }).where(eq(posts.id, newer.id)).run();
    const date = localDate(new Date("2026-01-20T02:30:00.000Z"));
    expect((await history(0, `?desde=${date}&hasta=${date}`)).data.items.map((x: any) => x.id)).toEqual([older.id]);
    const page = await history(0, "?pageSize=1&page=2");
    expect(page.data.total).toBe(2);
    expect(page.data.items[0].id).toBe(older.id);
    for (const filter of ["?desde=2026-02-30", "?hasta=no", "?desde=2026-02-01&hasta=2026-01-01", "?tipo=otro", "?page=0"]) {
      expect((await history(0, filter)).response.status).toBe(422);
    }
  });

  test("no incluye casos abiertos ni reclamos sin aceptar", async () => {
    const open = await publish();
    await claim(open.id);
    expect((await history(0)).data.items).toEqual([]);
    expect((await api(`/publicaciones/${open.id}/valoraciones`, "POST", { positiva: true }, accounts[1]!.token)).response.status).toBe(409);
    expect((await api(`/publicaciones/${open.id}/agradecimientos`, "POST", { mensaje: "Gracias" }, accounts[1]!.token)).response.status).toBe(409);
  });

  test("cada parte valora una vez y actualiza la reputación", async () => {
    const p = await resolve();
    const path = `/publicaciones/${p.id}/valoraciones`;
    expect((await api(path, "POST", { positiva: true }, accounts[2]!.token)).response.status).toBe(403);
    expect((await api(path, "POST", { positiva: true, comentario: " Gracias " }, accounts[1]!.token)).response.status).toBe(201);
    expect((await api(path, "POST", { positiva: false }, accounts[0]!.token)).response.status).toBe(201);
    expect((await api(path, "POST", { positiva: false }, accounts[1]!.token)).data.error.code).toBe("ALREADY_REVIEWED");
    expect((await history(1)).data.items[0].valoracion).toEqual({ positiva: true, comentario: "Gracias" });
    expect((await history(1)).data.items[0].puedeValorar).toBe(false);
    expect((await api(`/usuarios/${accounts[0]!.id}`)).data.reputation.positiveReviews).toBe(1);
    expect((await api(`/usuarios/${accounts[1]!.id}`)).data.reputation.negativeReviews).toBe(1);
  });

  test("rechaza valoraciones fuera de los 7 días aunque se envíen directamente a la API", async () => {
    const p = await resolve();
    db.update(posts).set({ resolvedAt: new Date(Date.now() - 7 * 86400000 - 1000).toISOString() }).where(eq(posts.id, p.id)).run();
    expect((await history(0)).data.items[0].puedeValorar).toBe(false);
    for (const account of [0, 1]) {
      const result = await api(`/publicaciones/${p.id}/valoraciones`, "POST", { positiva: true }, accounts[account]!.token);
      expect(result.response.status).toBe(409);
      expect(result.data.error.code).toBe("REVIEW_EXPIRED");
    }
    db.update(posts).set({ resolvedAt: new Date(Date.now() - 6 * 86400000).toISOString() }).where(eq(posts.id, p.id)).run();
    expect((await api(`/publicaciones/${p.id}/valoraciones`, "POST", { positiva: true }, accounts[0]!.token)).response.status).toBe(201);
  });

  test("solo quien recupera puede agradecer, una vez, y el mensaje aparece en el perfil correcto", async () => {
    for (const tipo of ["encontre", "perdi"]) {
      const p = await resolve({ tipo });
      const recoverer = tipo === "encontre" ? 1 : 0;
      const returner = tipo === "encontre" ? 0 : 1;
      const path = `/publicaciones/${p.id}/agradecimientos`;
      for (const account of [returner, 2]) {
        expect((await api(path, "POST", { mensaje: "Gracias" }, accounts[account]!.token)).response.status).toBe(403);
      }
      expect((await api(path, "POST", { mensaje: "   " }, accounts[recoverer]!.token)).response.status).toBe(422);
      expect((await api(path, "POST", { mensaje: "x".repeat(501) }, accounts[recoverer]!.token)).response.status).toBe(422);
      expect((await api(path, "POST", { mensaje: " Gracias por devolverlo " }, accounts[recoverer]!.token)).response.status).toBe(201);
      expect((await api(path, "POST", { mensaje: "Otra vez" }, accounts[recoverer]!.token)).data.error.code).toBe("ALREADY_THANKED");
      const publicThanks = await api(`/usuarios/${accounts[returner]!.id}/agradecimientos`);
      expect(publicThanks.response.status).toBe(200);
      expect(publicThanks.data.items[0].autor.id).toBe(accounts[recoverer]!.id);
      expect(publicThanks.data.items[0].mensaje).toBe("Gracias por devolverlo");
      expect(publicThanks.data.items[0]).not.toHaveProperty("publicationId");
      const item = (await history(recoverer)).data.items.find((x: any) => x.id === p.id);
      expect(item.agradecimiento.mensaje).toBe("Gracias por devolverlo");
    }
  });
  test("historial, valoración y agradecimiento persisten al reabrir SQLite", async () => {
    db.$client.close();
    const path = join(temp, "historial.sqlite");
    db = createDatabase(path);
    for (const account of accounts) {
      db.insert(users).values({ id: account.id, email: account.email, name: account.id,
        createdAt: nowIso(), emailVerifiedAt: nowIso() }).run();
      account.token = (await createSession(db, account.id, 1)).token;
    }
    app = createApp(db);
    const p = await resolve();
    expect((await api(`/publicaciones/${p.id}/valoraciones`, "POST", { positiva: true }, accounts[1]!.token)).response.status).toBe(201);
    expect((await api(`/publicaciones/${p.id}/agradecimientos`, "POST", { mensaje: "Gracias por las llaves" }, accounts[1]!.token)).response.status).toBe(201);
    db.$client.close(); db = createDatabase(path); app = createApp(db);
    const item = (await history(1)).data.items[0];
    expect(item.id).toBe(p.id);
    expect(item.valoracion.positiva).toBe(true);
    expect(item.agradecimiento.mensaje).toBe("Gracias por las llaves");
    expect((await api(`/usuarios/${accounts[0]!.id}/agradecimientos`)).data.items[0].mensaje).toBe("Gracias por las llaves");
  });

});

describe("verificación del publicador, pruebas privadas, vencimiento e idempotencia", () => {
  const ANSWER = "Una estrella azul";
  const expire = (id: string, days = 1) =>
    db.update(posts).set({ venceAt: new Date(Date.now() - days * 86_400_000).toISOString() }).where(eq(posts.id, id)).run();
  const lost = (extra: Record<string, unknown> = {}) => publish({ tipo: "perdi", ...extra });
  const search = async (token?: string) => (await api(query(), "GET", undefined, token)).data.items.map((x: any) => x.id);

  test("hallazgo exige pregunta y respuesta; en perdido se ignoran y el dueño puede editarlas", async () => {
    const noQuestion = await api("/publicaciones", "POST", postBody({ preguntaVerificacion: undefined, respuestaVerificacion: undefined }), accounts[0]!.token);
    expect(noQuestion.response.status).toBe(422); expect(noQuestion.data.error.code).toBe("VERIFICATION_QUESTION_REQUIRED");
    const noAnswer = await api("/publicaciones", "POST", postBody({ respuestaVerificacion: "  " }), accounts[0]!.token);
    expect(noAnswer.response.status).toBe(422); expect(noAnswer.data.error.code).toBe("VERIFICATION_ANSWER_REQUIRED");
    const found = await publish();
    expect(found.preguntaVerificacion).toBe("¿Qué dibujo tiene el llavero?"); expect(found.respuestaVerificacion).toBe(ANSWER);
    const l = await lost({ preguntaVerificacion: "Ignorada", respuestaVerificacion: "Ignorada" });
    expect(l.preguntaVerificacion).toBeNull(); expect(l.respuestaVerificacion).toBeNull();
    const edited = await api(`/publicaciones/${found.id}`, "PATCH", { respuestaVerificacion: "Una luna roja" }, accounts[0]!.token);
    expect(edited.data.respuestaVerificacion).toBe("Una luna roja"); expect(edited.data.preguntaVerificacion).toBe("¿Qué dibujo tiene el llavero?");
    const cleared = await api(`/publicaciones/${found.id}`, "PATCH", { preguntaVerificacion: "" }, accounts[0]!.token);
    expect(cleared.response.status).toBe(422);
    expect((await api(`/publicaciones/${found.id}`, "PATCH", { preguntaVerificacion: "Otra" }, accounts[1]!.token)).response.status).toBe(403);
  });
  test("un hallazgo previo sin pregunta se puede seguir editando y reclamando", async () => {
    const found = await publish();
    db.update(posts).set({ preguntaVerificacion: null, respuestaVerificacion: null }).where(eq(posts.id, found.id)).run();
    expect((await api(`/publicaciones/${found.id}`, "PATCH", { titulo: "Llaves viejas" }, accounts[0]!.token)).response.status).toBe(200);
    const res = await api(`/publicaciones/${found.id}/reclamos`, "POST", { mensaje: "Son mis llaves." }, accounts[1]!.token);
    expect(res.response.status).toBe(201);
  });
  test("la respuesta privada solo la ve el dueño: nunca terceros, búsquedas, alertas ni seguidas", async () => {
    const found = await publish();
    const mine = (await api(`/publicaciones/${found.id}`, "GET", undefined, accounts[0]!.token)).data;
    expect(mine.respuestaVerificacion).toBe(ANSWER);
    expect((await api("/mis-publicaciones", "GET", undefined, accounts[0]!.token)).data.items[0].respuestaVerificacion).toBe(ANSWER);
    await api("/alertas", "POST", { filtros: filters }, accounts[2]!.token);
    await api(`/publicaciones/${found.id}/seguir`, "POST", undefined, accounts[2]!.token);
    await api(`/publicaciones/${found.id}`, "PATCH", { titulo: "Llaves actualizadas" }, accounts[0]!.token);
    const c = await claim(found.id, 1, { respuestaVerificacion: "Mi respuesta" });
    for (const token of [undefined, accounts[1]!.token, accounts[2]!.token]) {
      const detail = await api(`/publicaciones/${found.id}`, "GET", undefined, token);
      expect(detail.data.preguntaVerificacion).toBe("¿Qué dibujo tiene el llavero?");
      expect(detail.data).not.toHaveProperty("respuestaVerificacion");
    }
    const exposed = [
      await api(query(), "GET", undefined, accounts[2]!.token), await api(query()),
      await api("/me/seguidas", "GET", undefined, accounts[2]!.token), await api("/notificaciones", "GET", undefined, accounts[2]!.token),
      await api("/alertas", "GET", undefined, accounts[2]!.token), await api("/me/historial", "GET", undefined, accounts[2]!.token),
      await api("/me/reclamos", "GET", undefined, accounts[1]!.token),
      await api(`/reclamos/${c.id}`, "GET", undefined, accounts[1]!.token),
    ];
    for (const r of exposed) {
      expect(r.response.status).toBe(200);
      expect(JSON.stringify(r.data)).not.toContain(ANSWER);
    }
    const found1 = (await api(query(), "GET", undefined, accounts[2]!.token)).data.items[0];
    expect(found1).not.toHaveProperty("respuestaVerificacion"); expect(found1).not.toHaveProperty("preguntaVerificacion");
    // El dueño compara la respuesta del reclamante con la suya, tanto en la bandeja de recibidos como en el detalle.
    const received = (await api("/me/reclamos?tipo=recibidos", "GET", undefined, accounts[0]!.token)).data.items[0];
    expect(received.respuestaVerificacion).toBe("Mi respuesta");
    expect(received.publicacion.respuestaVerificacion).toBe(ANSWER);
  });
  test("«Es mío» exige responder la pregunta y el reclamo estructurado solo lo ven los participantes", async () => {
    const found = await publish();
    const missing = await api(`/publicaciones/${found.id}/reclamos`, "POST", { mensaje: "Son mis llaves." }, accounts[1]!.token);
    expect(missing.response.status).toBe(422); expect(missing.data.error.code).toBe("VERIFICATION_ANSWER_REQUIRED");
    expect((await api(`/publicaciones/${found.id}/reclamos`, "POST", { mensaje: "Son mis llaves.", respuestaVerificacion: "   " }, accounts[1]!.token)).response.status).toBe(422);
    const c = await claim(found.id, 1, { respuestaVerificacion: "  Una estrella  " });
    expect(c.respuestaVerificacion).toBe("Una estrella"); expect(c.mensaje).toBeTruthy(); expect(c.intentos).toBe(1);
    const asOwner = (await api(`/publicaciones/${found.id}/reclamos`, "GET", undefined, accounts[0]!.token)).data.items[0];
    expect(asOwner.respuestaVerificacion).toBe("Una estrella");
    const detail = (await api(`/reclamos/${c.id}`, "GET", undefined, accounts[0]!.token)).data;
    expect(detail.respuestaVerificacion).toBe("Una estrella"); expect(detail.publicacion.respuestaVerificacion).toBe(ANSWER);
    expect((await api(`/reclamos/${c.id}`, "GET", undefined, accounts[1]!.token)).data.respuestaVerificacion).toBe("Una estrella");
    expect((await api(`/publicaciones/${found.id}`, "GET", undefined, accounts[1]!.token)).data.miReclamo.respuestaVerificacion).toBe("Una estrella");
    expect((await api(`/reclamos/${c.id}`, "GET", undefined, accounts[2]!.token)).response.status).toBe(403);
    expect((await api("/me/reclamos", "GET", undefined, accounts[2]!.token)).data.items).toHaveLength(0);
    // Reintento tras rechazo: reemplaza la respuesta y respeta el tope de intentos.
    await api(`/reclamos/${c.id}/rechazar`, "POST", undefined, accounts[0]!.token);
    const again = await claim(found.id, 1, { respuestaVerificacion: "Una luna" });
    expect(again.intentos).toBe(2); expect(again.respuestaVerificacion).toBe("Una luna");
  });
  test("«Lo encontré» exige foto de prueba propia y un barrio válido", async () => {
    const l = await lost();
    const base = { mensaje: "Encontré tus llaves en la calle." };
    const post = (extra: Record<string, unknown>, who = 1) => api(`/publicaciones/${l.id}/reclamos`, "POST", { ...base, ...extra }, accounts[who]!.token);
    const proof = await uploadProof(1);
    const noPhoto = await post({ barrio: "Palermo" });
    expect(noPhoto.response.status).toBe(422); expect(noPhoto.data.error.code).toBe("PROOF_PHOTO_REQUIRED");
    const noBarrio = await post({ fotoPrueba: proof.url });
    expect(noBarrio.response.status).toBe(422); expect(noBarrio.data.error.code).toBe("BARRIO_REQUIRED");
    const badBarrio = await post({ fotoPrueba: proof.url, barrio: "Narnia" });
    expect(badBarrio.response.status).toBe(422); expect(badBarrio.data.error.code).toBe("INVALID_BARRIO");
    const foreign = await post({ fotoPrueba: proof.url, barrio: "Palermo" }, 2);
    expect(foreign.response.status).toBe(403); expect(foreign.data.error.code).toBe("PROOF_NOT_OWNED");
    const publicImage = await uploadProof(1, "/uploads/images");
    expect((await post({ fotoPrueba: publicImage.url, barrio: "Palermo" })).response.status).toBe(422);
    expect((await post({ fotoPrueba: "https://externo.example/foto.png", barrio: "Palermo" })).response.status).toBe(422);
    const ok = await post({ fotoPrueba: proof.filename, barrio: "palermo" });
    expect(ok.response.status).toBe(201);
    expect(ok.data.fotoPrueba).toBe(proof.url); expect(ok.data.barrio).toBe("Palermo");
    const detail = (await api(`/reclamos/${ok.data.id}`, "GET", undefined, accounts[0]!.token)).data;
    expect(detail.fotoPrueba).toBe(proof.url); expect(detail.barrio).toBe("Palermo");
    const outsider = await api(`/publicaciones/${l.id}`, "GET", undefined, accounts[2]!.token);
    expect(JSON.stringify(outsider.data)).not.toContain(proof.filename);
  });
  test("las pruebas privadas se sirven solo con sesión al autor y a participantes del reclamo", async () => {
    const proof = await uploadProof(1);
    const url = proof.url;
    expect(url).toMatch(/^\/uploads\/pruebas\/[0-9a-f-]{36}\.png$/);
    expect(readdirSync(join(temp, "uploads", "pruebas"))).toEqual([proof.filename]);
    expect(readdirSync(join(temp, "uploads")).filter((n) => n.endsWith(".png"))).toHaveLength(0);
    expect((await api(url)).response.status).toBe(401);
    const own = await app.handle(new Request(`http://localhost${url}`, { headers: { Authorization: `Bearer ${accounts[1]!.token}` } }));
    expect(own.status).toBe(200); expect(own.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await own.arrayBuffer()).equals(PNG)).toBe(true);
    // Sin reclamo que la referencie, ni el dueño de una publicación ni terceros la ven.
    const l = await lost();
    expect((await api(url, "GET", undefined, accounts[0]!.token)).response.status).toBe(403);
    expect((await api(url, "GET", undefined, accounts[2]!.token)).response.status).toBe(403);
    expect((await api(`/uploads/${proof.filename}`)).response.status).toBe(404);
    expect((await api(`/uploads/pruebas/${crypto.randomUUID()}.png`, "GET", undefined, accounts[1]!.token)).response.status).toBe(404);
    expect((await api("/uploads/pruebas/..%2Fx.png", "GET", undefined, accounts[1]!.token)).response.status).toBe(404);
    const c = await api(`/publicaciones/${l.id}/reclamos`, "POST", { mensaje: "Las encontré yo.", fotoPrueba: url, barrio: "Palermo" }, accounts[1]!.token);
    expect(c.response.status).toBe(201);
    expect((await api(url, "GET", undefined, accounts[0]!.token)).response.status).toBe(200);
    expect((await api(url, "GET", undefined, accounts[2]!.token)).response.status).toBe(403);
    // Una prueba no puede publicarse como foto ni como avatar, y las imágenes públicas siguen igual.
    expect((await api("/publicaciones", "POST", postBody({ fotos: [`/uploads/${proof.filename}`] }), accounts[1]!.token)).response.status).toBe(403);
    expect((await api("/me", "PATCH", { avatarUrl: `/uploads/${proof.filename}` }, accounts[1]!.token)).response.status).toBe(403);
    const image = await uploadProof(0, "/uploads/images");
    const publicRes = await app.handle(new Request(`http://localhost${image.url}`));
    expect(publicRes.status).toBe(200); expect(publicRes.headers.get("cache-control")).toContain("public");
    const anonymous = new FormData(); anonymous.set("file", new File([PNG], "prueba.png", { type: "image/png" }));
    expect((await api("/uploads/pruebas", "POST", anonymous)).response.status).toBe(401);
  });
  test("las publicaciones vencen a los 30 días, salen de búsquedas y alertas y se renuevan", async () => {
    const p = await publish();
    const days = (Date.parse(p.venceAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.99); expect(days).toBeLessThanOrEqual(30);
    expect(await search()).toEqual([p.id]);
    const token = accounts[1]!.token;
    const alert = await api("/alertas", "POST", { filtros: filters }, token);
    await api(`/alertas/${alert.data.id}`, "PATCH", { activa: false }, token);
    expire(p.id);
    expect(await search()).toEqual([]); expect(await search(token)).toEqual([]);
    expect((await api(`/publicaciones/${p.id}`)).data.estado).toBe("vencida");
    const mine = async (estado: string) => (await api(`/mis-publicaciones?estado=${estado}`, "GET", undefined, accounts[0]!.token)).data.items.map((x: any) => x.id);
    expect(await mine("vencida")).toEqual([p.id]); expect(await mine("abierta")).toEqual([]);
    expect((await api("/mis-publicaciones?estado=inexistente", "GET", undefined, accounts[0]!.token)).response.status).toBe(422);
    // Sin reclamos ni seguidores nuevos, y sin alertas aunque se reactive la alerta.
    const refused = await api(`/publicaciones/${p.id}/reclamos`, "POST", { mensaje: "Son mis llaves.", respuestaVerificacion: ANSWER }, token);
    expect(refused.response.status).toBe(409); expect(refused.data.error.code).toBe("PUBLICATION_EXPIRED");
    expect((await api(`/publicaciones/${p.id}/seguir`, "POST", undefined, token)).data.error.code).toBe("PUBLICATION_EXPIRED");
    db.update(posts).set({ updatedAt: nowIso() }).where(eq(posts.id, p.id)).run();
    await api(`/alertas/${alert.data.id}`, "PATCH", { activa: true }, token);
    expect((await api("/notificaciones", "GET", undefined, token)).data.total).toBe(0);
    // Renovar: solo el dueño; vuelve a ser visible y dispara la alerta una sola vez.
    expect((await api(`/publicaciones/${p.id}/renovar`, "POST", undefined, token)).response.status).toBe(403);
    expect((await api(`/publicaciones/${p.id}/renovar`, "POST")).response.status).toBe(401);
    const renewed = await api(`/publicaciones/${p.id}/renovar`, "POST", undefined, accounts[0]!.token);
    expect(renewed.response.status).toBe(200); expect(renewed.data.estado).toBe("abierta");
    expect(Date.parse(renewed.data.venceAt) - Date.now()).toBeGreaterThan(29.99 * 86_400_000);
    expect(await search()).toEqual([p.id]);
    expect((await api("/notificaciones", "GET", undefined, token)).data.total).toBe(1);
    await api(`/publicaciones/${p.id}/renovar`, "POST", undefined, accounts[0]!.token);
    expect((await api("/notificaciones", "GET", undefined, token)).data.total).toBe(1);
    expect((await claim(p.id)).estado).toBe("pendiente");
  });
  test("una publicación con reclamo vigente o aceptado no vence; resuelta y eliminada no se renuevan", async () => {
    const p = await publish();
    const c = await claim(p.id);
    expire(p.id);
    expect((await api(`/publicaciones/${p.id}`)).data.estado).toBe("abierta");
    // Al pasar las 48 h sin respuesta el reclamo vence y, con él, la publicación.
    const old = new Date(Date.now() - 49 * 3_600_000).toISOString();
    db.update(claims).set({ createdAt: old, updatedAt: old }).where(eq(claims.id, c.id)).run();
    expect((await api(`/publicaciones/${p.id}`)).data.estado).toBe("vencida");
    const second = await publish();
    await accept(second.id);
    expire(second.id);
    expect((await api(`/publicaciones/${second.id}`)).data.estado).toBe("en_reclamo");
    expect((await api(`/publicaciones/${second.id}/renovar`, "POST", undefined, accounts[0]!.token)).response.status).toBe(200);
    expect((await api(`/publicaciones/${second.id}/resolver`, "POST", undefined, accounts[0]!.token)).response.status).toBe(200);
    expire(second.id);
    expect((await api(`/publicaciones/${second.id}`)).data.estado).toBe("resuelta");
    expect((await api(`/publicaciones/${second.id}/renovar`, "POST", undefined, accounts[0]!.token)).response.status).toBe(409);
    await api(`/publicaciones/${p.id}`, "DELETE", undefined, accounts[0]!.token);
    expect((await api(`/publicaciones/${p.id}/renovar`, "POST", undefined, accounts[0]!.token)).response.status).toBe(404);
  });
  test("clientId hace idempotente el alta por usuario", async () => {
    const clientId = crypto.randomUUID();
    const first = await api("/publicaciones", "POST", postBody({ clientId }), accounts[0]!.token);
    expect(first.response.status).toBe(201);
    const [again, other] = await Promise.all([
      api("/publicaciones", "POST", postBody({ clientId, titulo: "Otro título" }), accounts[0]!.token),
      api("/publicaciones", "POST", postBody({ clientId }), accounts[0]!.token),
    ]);
    for (const r of [again, other]) { expect(r.response.status).toBe(200); expect(r.data.id).toBe(first.data.id); }
    expect(again.data.titulo).toBe("Llaves con llavero azul");
    expect(db.select().from(posts).all()).toHaveLength(1);
    const otherUser = await api("/publicaciones", "POST", postBody({ clientId }), accounts[1]!.token);
    expect(otherUser.response.status).toBe(201); expect(otherUser.data.id).not.toBe(first.data.id);
    expect((await api("/publicaciones", "POST", postBody({ clientId: crypto.randomUUID() }), accounts[0]!.token)).response.status).toBe(201);
    expect(db.select().from(posts).all()).toHaveLength(3);
    expect((await api("/publicaciones", "POST", postBody({ clientId: "x" }), accounts[0]!.token)).response.status).toBe(422);
    await api(`/publicaciones/${first.data.id}`, "DELETE", undefined, accounts[0]!.token);
    const deleted = await api("/publicaciones", "POST", postBody({ clientId }), accounts[0]!.token);
    expect(deleted.response.status).toBe(409); expect(deleted.data.error.code).toBe("CLIENT_ID_ALREADY_USED");
  });
  test("la migración conserva datos y da 30 días de vigencia a las publicaciones existentes", () => {
    const folder = join(temp, "before-contract");
    for (const name of readdirSync(new URL("../drizzle", import.meta.url))) {
      if (name.startsWith("2026") && !name.endsWith("contrato_verificacion_vencimiento")) {
        cpSync(new URL(`../drizzle/${name}`, import.meta.url), join(folder, name), { recursive: true });
      }
    }
    const path = join(temp, "before-contract.sqlite");
    const raw = new Database(path, { create: true });
    migrate(drizzle({ client: raw }), { migrationsFolder: folder });
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    raw.run("INSERT INTO users (id,email,name,created_at,email_verified_at) VALUES ('o','o@example.com','Dueño',?,?)", [old, old]);
    raw.run(`INSERT INTO hallado_publications (id,user_id,tipo,titulo,descripcion,categoria,barrio,fecha,franja,latitud,longitud,fotos,estado,created_at,updated_at)
      VALUES ('old-post','o','encontrado','Llaves viejas','Llaves viejas de hace mucho','Llaves','Palermo','2026-07-01','tarde',-34.5,-58.4,'[]','abierta',?,?)`, [old, old]);
    raw.run("INSERT INTO hallado_claims (id,publication_id,user_id,mensaje,estado,intentos,created_at,updated_at) VALUES ('old-claim','old-post','o','Mensaje viejo','rechazado',2,?,?)", [old, old]);
    raw.run("INSERT INTO hallado_uploads (filename,user_id,content_type,created_at) VALUES ('f.png','o','image/png',?)", [old]);
    raw.close();
    const upgraded = createDatabase(path);
    try {
      const post = upgraded.select().from(posts).where(eq(posts.id, "old-post")).get()!;
      expect(post.titulo).toBe("Llaves viejas"); expect(post.preguntaVerificacion).toBeNull(); expect(post.clientId).toBeNull();
      expect(Date.parse(post.venceAt!) - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
      const claim = upgraded.select().from(claims).where(eq(claims.id, "old-claim")).get()!;
      expect(claim.intentos).toBe(2); expect(claim.fotoPrueba).toBeNull();
      expect(upgraded.$client.query("SELECT tipo FROM hallado_uploads WHERE filename = 'f.png'").get()).toEqual({ tipo: "imagen" });
    } finally { upgraded.$client.close(); }
  });
});
