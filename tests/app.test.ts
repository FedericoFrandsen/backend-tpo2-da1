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
import { alerts, claims, follows, halladoPublications as posts, halladoReviews, loginAttempts, notifications, otpCodes, sessions, thanks, users } from "../src/db/schema";
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
  test("login simultáneo con contraseña incorrecta no supera el límite de intentos", async () => {
    const email = accounts[0]!.email;
    const attempt = (address: string) => api("/auth/login/password", "POST", { email: address, password: "Wrong123" });
    const statuses = (await Promise.all(Array.from({ length: 12 }, () => attempt(email)))).map((r) => r.response.status);
    // Solo los 5 intentos permitidos llegan a verificar la contraseña; el resto se rechaza antes de ese trabajo.
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    expect(db.select().from(loginAttempts).where(eq(loginAttempts.login, email)).get()!.attempts).toBe(5);
    // Bloqueada, ni siquiera la contraseña correcta pasa; vencida la ventana se reinicia el contador.
    expect((await api("/auth/login/password", "POST", { email, password })).response.status).toBe(429);
    db.update(loginAttempts).set({ windowStart: new Date(Date.now() - 901_000).toISOString() }).run();
    const retried = (await Promise.all(Array.from({ length: 8 }, () => attempt(email)))).map((r) => r.response.status);
    expect(retried.filter((s) => s === 401)).toHaveLength(5); expect(retried.filter((s) => s === 429)).toHaveLength(3);
    // Un usuario inexistente también consume intentos, sin afectar a otras cuentas.
    const unknown = (await Promise.all(Array.from({ length: 7 }, () => attempt("nadie@example.com")))).map((r) => r.response.status);
    expect(unknown.filter((s) => s === 401)).toHaveLength(5); expect(unknown.filter((s) => s === 429)).toHaveLength(2);
    expect((await api("/auth/login/password", "POST", { email: accounts[1]!.email, password })).response.status).toBe(200);
  });
  test("un login correcto reinicia el contador de intentos fallidos", async () => {
    const email = accounts[0]!.email;
    for (let i = 0; i < 4; i++) expect((await api("/auth/login/password", "POST", { email, password: "Wrong123" })).response.status).toBe(401);
    expect(db.select().from(loginAttempts).where(eq(loginAttempts.login, email)).get()!.attempts).toBe(4);
    expect((await api("/auth/login/password", "POST", { email, password })).response.status).toBe(200);
    expect(db.select().from(loginAttempts).where(eq(loginAttempts.login, email)).get()).toBeUndefined();
    for (let i = 0; i < 5; i++) expect((await api("/auth/login/password", "POST", { email, password: "Wrong123" })).response.status).toBe(401);
    expect((await api("/auth/login/password", "POST", { email, password })).response.status).toBe(429);
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
      // Solo las migraciones anteriores a la del contrato (los nombres empiezan por su marca de tiempo).
      if (name.startsWith("2026") && name < "20261029184216_contrato_verificacion_vencimiento") {
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

describe("búsqueda: contrato de resultados", () => {
  const ANSWER = "Una estrella azul";
  const QUESTION = "¿Qué dibujo tiene el llavero?";
  const dayAgo = (n: number) => localDate(new Date(Date.now() - n * 86_400_000));
  let seq = 0;
  /** Inserta directo en la base para controlar fecha, orden de alta y vencimiento. */
  function seed(extra: Partial<typeof posts.$inferInsert> = {}) {
    const id = extra.id ?? crypto.randomUUID();
    const at = new Date(Date.UTC(2026, 0, 1) + seq++ * 1000).toISOString();
    db.insert(posts).values({ userId: accounts[0]!.id, tipo: "encontrado", titulo: "Llaves con llavero azul", descripcion: "Juego de tres llaves con un llavero de color azul.",
      categoria: "Llaves", barrio: "Palermo", fecha: localDate(), franja: "tarde", latitud: -34.5889, longitud: -58.4306, direccionExacta: "Calle privada 123",
      fotos: [], preguntaVerificacion: QUESTION, respuestaVerificacion: ANSWER, createdAt: at, updatedAt: at, ...extra, id }).run();
    return id;
  }
  const ids = async (extra: Record<string, string> = {}, token?: string) => (await api(query(extra), "GET", undefined, token)).data.items.map((x: any) => x.id);
  const expire = (id: string) => db.update(posts).set({ venceAt: new Date(Date.now() - 86_400_000).toISOString() }).where(eq(posts.id, id)).run();

  test("combina tipo, categoría, barrio, fechas, palabras, estado y eliminadas", async () => {
    const hit = seed({ titulo: "Llaves azules", fecha: dayAgo(2) });
    const accent = seed({ barrio: "Ubicación actual", titulo: "Llaves azules ubicación", fecha: dayAgo(1) });
    const old = seed({ fecha: dayAgo(8) });
    seed({ tipo: "perdido" });
    seed({ categoria: "Otros" });
    seed({ barrio: "Belgrano" });
    seed({ estado: "en_reclamo" });
    seed({ estado: "resuelta" });
    seed({ deletedAt: nowIso() });
    expect(await ids({ periodo: "semana" })).toEqual([hit]);
    expect(await ids({ zona: "UBICACION actual" })).toEqual([accent]);
    expect(await ids({ periodo: "hoy" })).toEqual([]);
    expect(await ids({ palabras: "AZULES llaves" })).toEqual([hit]);
    expect(await ids({ palabras: "azules ubicacion", zona: "ubicación ACTUAL" })).toEqual([accent]);
    expect(await ids({ palabras: "no-existe" })).toEqual([]);
    // El rango es inclusivo en ambos extremos.
    expect(await ids({ periodo: "rango", desde: dayAgo(2), hasta: dayAgo(2) })).toEqual([hit]);
    expect(await ids({ periodo: "rango", desde: dayAgo(3), hasta: dayAgo(1) })).toEqual([hit]);
    expect(await ids({ periodo: "rango", desde: dayAgo(9), hasta: dayAgo(7) })).toEqual([old]);
    // Con situación «encontré» se buscan los perdidos.
    expect(await ids({ situacion: "encontre" })).toHaveLength(1);
  });

  test("ordena por fecha, alta e id; el resumen incluye la distancia y no depende de quién consulta", async () => {
    const a = seed({ fecha: dayAgo(1) });
    const b = seed({ fecha: dayAgo(0) });
    const c = seed({ fecha: dayAgo(0) });
    const at = db.select().from(posts).where(eq(posts.id, c)).get()!.createdAt;
    const d = seed({ fecha: dayAgo(0), id: "00000000-0000-4000-8000-000000000000", createdAt: at, updatedAt: at });
    // Más reciente primero; a igual fecha y alta (c y d) gana el id menor.
    expect(await ids()).toEqual([d, c, b, a]);
    expect(await ids({}, accounts[1]!.token)).toEqual([d, c, b, a]);
    expect((await api(query())).data.items.every((x: any) => x.distancia === 0)).toBe(true);
  });

  test("cercanos ordena por distancia y desempata por fecha; el radio GPS recorta", async () => {
    const far = seed({ latitud: -34.60, longitud: -58.43, fecha: dayAgo(0) });
    const mid = seed({ latitud: -34.5895, longitud: -58.4306, fecha: dayAgo(1) });
    const nearOld = seed({ fecha: dayAgo(2) });
    const nearNew = seed({ fecha: dayAgo(0) });
    const result = await api(query({ orden: "cercanos" }));
    expect(result.data.items.map((x: any) => x.id)).toEqual([nearNew, nearOld, mid, far]);
    expect(result.data.items.map((x: any) => x.distancia)).toEqual([0, 0, 0.1, 1.2]);
    const gps = { zona: "", latitud: "-34.5889", longitud: "-58.4306" };
    const near = await api(query({ ...gps, radioKm: "0.5", orden: "cercanos" }));
    expect(near.data.items.map((x: any) => x.id)).toEqual([nearNew, nearOld, mid]); expect(near.data.total).toBe(3);
    const recent = await api(query({ ...gps, radioKm: "5" }));
    expect(recent.data.items.map((x: any) => x.id)).toEqual([nearNew, far, mid, nearOld]);
    // GPS más barrio: se exigen ambos.
    expect((await api(query({ latitud: "-34.6037", longitud: "-58.3816", radioKm: "1" }))).data.total).toBe(0);
  });

  test("pagina con total y totalPages correctos en recientes, cercanos, con palabras y con GPS", async () => {
    for (let i = 0; i < 45; i++) seed({ fecha: dayAgo(i % 5), titulo: `Llaves número ${i}`, latitud: -34.5889 + i * 0.0001 });
    seed({ deletedAt: nowIso() });
    for (const extra of [{} as Record<string, string>, { orden: "cercanos" }, { palabras: "llaves" }, { zona: "", latitud: "-34.5889", longitud: "-58.4306" }]) {
      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const r = (await api(query({ ...extra, page: String(page) }))).data;
        expect(r.total).toBe(45); expect(r.totalPages).toBe(3); expect(r.page).toBe(page); expect(r.pageSize).toBe(20);
        expect(r.items).toHaveLength(page === 3 ? 5 : 20);
        seen.push(...r.items.map((x: any) => x.id));
      }
      expect(new Set(seen).size).toBe(45);
      const beyond = (await api(query({ ...extra, page: "4" }))).data;
      expect(beyond.items).toEqual([]); expect(beyond.total).toBe(45); expect(beyond.totalPages).toBe(3);
      const small = (await api(query({ ...extra, pageSize: "7", page: "7" }))).data;
      expect(small.items).toHaveLength(3); expect(small.totalPages).toBe(7);
    }
    const dates = (await api(query({ pageSize: "100" }))).data.items.map((x: any) => x.fecha);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(Object.keys((await api(query())).data)).toEqual(["items", "page", "pageSize", "total", "totalPages"]);
  });

  test("las vencidas no cuentan ni aparecen, salvo con reclamo pendiente vigente", async () => {
    const live = seed();
    const gone = seed(); expire(gone);
    const legacy = seed({ venceAt: null });
    const stale = seed(); expire(stale);
    const pending = seed(); expire(pending);
    const expiredLost = seed({ tipo: "perdido" }); expire(expiredLost);
    const fresh = new Date().toISOString(), old = new Date(Date.now() - 49 * 3_600_000).toISOString();
    const row = (publicationId: string, at: string, estado: "pendiente" | "rechazado" = "pendiente") =>
      db.insert(claims).values({ id: crypto.randomUUID(), publicationId, userId: accounts[1]!.id, mensaje: "Son mis llaves.", estado, createdAt: at, updatedAt: at }).run();
    row(pending, fresh);
    row(stale, old);
    // Un reclamo rechazado no sostiene la publicación.
    row(gone, fresh, "rechazado");
    const result = (await api(query())).data;
    expect(result.items.map((x: any) => x.id).sort()).toEqual([live, legacy, pending].sort());
    expect(result.total).toBe(3);
    expect(result.items.find((x: any) => x.id === pending).estado).toBe("abierta");
    expect(result.items.find((x: any) => x.id === legacy).venceAt).toBeNull();
    expect((await api(query({ situacion: "encontre" }))).data.total).toBe(0);
  });

  test("el resumen no expone datos privados ni cambia de campos según quién consulta", async () => {
    const accepted = seed({ latitud: -34.588912, longitud: -58.430678, estado: "en_reclamo" });
    const claimant = accounts[1]!;
    const at = nowIso();
    db.insert(claims).values({ id: crypto.randomUUID(), publicationId: accepted, userId: claimant.id, mensaje: "Son mis llaves.", estado: "aceptado", createdAt: at, updatedAt: at }).run();
    const open = seed({ latitud: -34.588912, longitud: -58.430678 });
    const keys = ["id", "tipo", "titulo", "descripcion", "categoria", "barrio", "fecha", "franja", "estado", "latitud", "longitud", "ubicacion", "fotos",
      "creadaEn", "actualizadaEn", "resueltaEn", "venceAt", "distancia"].sort();
    for (const token of [undefined, accounts[0]!.token, claimant.token, accounts[2]!.token]) {
      const items = (await api(query(), "GET", undefined, token)).data.items;
      expect(items.map((x: any) => x.id)).toEqual([open]);
      const item = items[0];
      expect(Object.keys(item).sort()).toEqual(keys);
      expect(item.latitud).toBe(-34.589); expect(item.longitud).toBe(-58.431); expect(item.ubicacion).toEqual({ latitud: -34.589, longitud: -58.431 });
      expect(JSON.stringify(item)).not.toContain(ANSWER); expect(JSON.stringify(item)).not.toContain("Calle privada");
      expect(JSON.stringify(item)).not.toContain(QUESTION);
    }
    // Seguidas devuelve resúmenes; mis publicaciones, el detalle propio.
    await api(`/publicaciones/${open}/seguir`, "POST", undefined, accounts[2]!.token);
    const followed = (await api("/me/seguidas", "GET", undefined, accounts[2]!.token)).data.items[0];
    expect(followed).not.toHaveProperty("publicador"); expect(followed).not.toHaveProperty("direccionExacta");
    const mine = (await api("/mis-publicaciones", "GET", undefined, accounts[0]!.token)).data.items.find((x: any) => x.id === open);
    expect(mine.publicador.reputation).toEqual({ completedReturns: 0, positiveReviews: 0, negativeReviews: 0 });
    expect(mine.respuestaVerificacion).toBe(ANSWER); expect(mine.direccionExacta).toBe("Calle privada 123");
  });

  test("la búsqueda usa un número acotado de consultas y no ejecuta escrituras ni reputación por resultado", async () => {
    for (let i = 0; i < 30; i++) seed({ titulo: `Llaves número ${i}` });
    for (const id of db.select({ id: posts.id }).from(posts).all().slice(0, 5).map((r) => r.id)) {
      expire(id);
      db.insert(claims).values({ id: crypto.randomUUID(), publicationId: id, userId: accounts[1]!.id, mensaje: "Son mis llaves.", estado: "pendiente", createdAt: nowIso(), updatedAt: nowIso() }).run();
    }
    const statements: string[] = [];
    const original = db.$client.query.bind(db.$client);
    (db.$client as any).query = (text: string) => { statements.push(text); return original(text); };
    try {
      for (const extra of [{}, { orden: "cercanos" }, { palabras: "llaves" }]) {
        statements.length = 0;
        const r = await api(query({ ...extra, pageSize: "20" } as unknown as Record<string, string>), "GET", undefined, accounts[1]!.token);
        expect(r.data.items).toHaveLength(20);
        // Los 5 resultados sostenidos por un reclamo vigente cuestan una consulta cada uno como máximo; el resto, ninguna.
        expect(statements.length).toBeLessThanOrEqual(8 + 5);
        expect(statements.filter((s) => /^\s*(update|delete)/i.test(s))).toEqual([]);
        expect(statements.filter((s) => /hallado_reviews|follows/.test(s))).toEqual([]);
      }
    } finally { (db.$client as any).query = original; }
  });
});

describe("novedades de vencimiento y renovación para seguidores", () => {
  /** Fija el vencimiento del ciclo sin esperar días; `days` distintos dan ciclos de vencimiento distintos. */
  const expireAt = (id: string, days = 1) =>
    db.update(posts).set({ venceAt: new Date(Date.now() - days * 86_400_000).toISOString() }).where(eq(posts.id, id)).run();
  const notifs = async (account: number) => (await api("/notificaciones", "GET", undefined, accounts[account]!.token)).data;
  const withPrefix = (data: { items: { mensaje: string }[] }, prefix: string) => data.items.filter((n) => n.mensaje.startsWith(prefix));
  const renew = (id: string) => api(`/publicaciones/${id}/renovar`, "POST", undefined, accounts[0]!.token);
  const follow = (id: string, account = 2) => api(`/publicaciones/${id}/seguir`, "POST", undefined, accounts[account]!.token);

  test("cada ciclo avisa una sola vez al seguidor, sin abrir el detalle y sin avisar a ajenos", async () => {
    const p = await publish();
    await follow(p.id);
    expect((await notifs(2)).total).toBe(0);

    expireAt(p.id, 1);
    // Consultas repetidas y simultáneas de novedades no duplican el aviso.
    const polls = await Promise.all([notifs(2), notifs(2), notifs(2)]);
    for (const poll of polls) expect(withPrefix(poll, "Venció")).toHaveLength(1);
    expect(withPrefix(await notifs(2), "Venció")).toHaveLength(1);
    expect((await notifs(2)).total).toBe(1);
    expect((await notifs(1)).total).toBe(0);
    expect((await notifs(0)).total).toBe(0);
    expect((await notifs(2)).items[0].publicacionId).toBe(p.id);

    const renewed = await renew(p.id);
    expect(renewed.response.status).toBe(200); expect(renewed.data.estado).toBe("abierta");
    expect(withPrefix(await notifs(2), "Se renovó")).toHaveLength(1);
    await renew(p.id);
    await Promise.all([renew(p.id), renew(p.id)]);
    expect(withPrefix(await notifs(2), "Se renovó")).toHaveLength(1);
    expect((await notifs(2)).total).toBe(2);

    // Segundo ciclo: vuelve a vencer y a renovarse, y avisa de nuevo exactamente una vez por transición.
    expireAt(p.id, 2);
    await notifs(2); await notifs(2);
    expect(withPrefix(await notifs(2), "Venció")).toHaveLength(2);
    await renew(p.id);
    await renew(p.id);
    const final = await notifs(2);
    expect(withPrefix(final, "Venció")).toHaveLength(2);
    expect(withPrefix(final, "Se renovó")).toHaveLength(2);
    expect(final.total).toBe(4);
    expect((await notifs(1)).total).toBe(0);
  });

  test("renovar una publicación vencida sin haber consultado antes deja vencimiento y renovación; lo vigente no avisa", async () => {
    const p = await publish();
    await follow(p.id);
    // Nunca vencida: renovar no emite un cambio de estado falso.
    expect((await renew(p.id)).response.status).toBe(200);
    expect((await notifs(2)).total).toBe(0);
    // Vencida y renovada sin que nadie consulte entre medio: ambas novedades quedan registradas.
    expireAt(p.id);
    expect((await renew(p.id)).response.status).toBe(200);
    const after = await notifs(2);
    expect(withPrefix(after, "Venció")).toHaveLength(1);
    expect(withPrefix(after, "Se renovó")).toHaveLength(1);
    expect(after.total).toBe(2);
  });

  test("el detalle y las seguidas también reconcilian, sin avisar a quien dejó de seguir", async () => {
    const p = await publish();
    await follow(p.id); await follow(p.id, 1);
    await api(`/publicaciones/${p.id}/seguir`, "DELETE", undefined, accounts[1]!.token);
    expireAt(p.id);
    expect((await api(`/publicaciones/${p.id}`)).data.estado).toBe("vencida");
    await api(`/publicaciones/${p.id}`); await api("/me/seguidas", "GET", undefined, accounts[2]!.token);
    expect(withPrefix(await notifs(2), "Venció")).toHaveLength(1);
    expect((await notifs(2)).total).toBe(1);
    expect((await notifs(1)).total).toBe(0);
  });

  test("con reclamo pendiente vigente o aceptado la publicación no vence y no hay aviso; resuelta no se renueva", async () => {
    const pending = await publish();
    await follow(pending.id);
    await claim(pending.id);
    const accepted = await publish();
    await follow(accepted.id);
    await accept(accepted.id);
    expireAt(pending.id); expireAt(accepted.id);
    const before = (await notifs(2)).total;
    expect(withPrefix(await notifs(2), "Venció")).toHaveLength(0);
    // El reclamo aceptado de la segunda publicación ya había avisado "en reclamo": solo cuentan las novedades de vencimiento.
    expect(before).toBe(1);
    expect((await renew(accepted.id)).response.status).toBe(200);
    expect(withPrefix(await notifs(2), "Se renovó")).toHaveLength(0);
    await api(`/publicaciones/${accepted.id}/resolver`, "POST", undefined, accounts[0]!.token);
    expireAt(accepted.id);
    expect((await renew(accepted.id)).response.status).toBe(409);
    const final = await notifs(2);
    expect(withPrefix(final, "Venció")).toHaveLength(0);
    expect(withPrefix(final, "Se renovó")).toHaveLength(0);
  });

  test("al reabrir la base no se repiten los avisos de un ciclo ya notificado", async () => {
    const path = join(temp, "reabrir.sqlite");
    db.$client.close();
    db = createDatabase(path);
    app = createApp(db, { uploadsPath: join(temp, "uploads"), sendOtp: async () => {} });
    for (let i = 0; i < 3; i++) {
      db.insert(users).values({ id: accounts[i]!.id, email: accounts[i]!.email, passwordHash, name: `Persona ${i}`, phone: `115555000${i}`, sharePhone: true, zone: "Palermo", createdAt: nowIso(), emailVerifiedAt: nowIso() }).run();
      accounts[i]!.token = (await createSession(db, accounts[i]!.id, 1)).token;
    }
    const p = await publish();
    await follow(p.id);
    expireAt(p.id);
    expect(withPrefix(await notifs(2), "Venció")).toHaveLength(1);
    db.$client.close();
    db = createDatabase(path);
    app = createApp(db, { uploadsPath: join(temp, "uploads"), sendOtp: async () => {} });
    await notifs(2); await api(`/publicaciones/${p.id}`);
    expect((await notifs(2)).total).toBe(1);
    expect((await renew(p.id)).response.status).toBe(200);
    expect(withPrefix(await notifs(2), "Se renovó")).toHaveLength(1);
    expect((await notifs(2)).total).toBe(2);
  });
});

describe("listados paginados: contrato", () => {
  const ARGENTINA = "America/Argentina/Buenos_Aires";
  const DAY = 86_400_000;
  let zone: string;
  // El filtro por día local depende de la zona: se fija para que las pruebas no dependan del entorno.
  beforeEach(() => { zone = config.timeZone; (config as { timeZone: string }).timeZone = ARGENTINA; });
  afterEach(() => { (config as { timeZone: string }).timeZone = zone; });

  const get = (path: string, account: number) => api(path, "GET", undefined, accounts[account]!.token);
  const idsOf = (r: { data: any }) => r.data.items.map((x: any) => x.id);
  const uid = (n: number) => accounts[n]!.id;
  const at = (n: number) => new Date(Date.UTC(2026, 2, 1) + n * 60_000).toISOString();
  let seq = 0;
  beforeEach(() => { seq = 0; });
  function addUser(id: string) {
    db.insert(users).values({ id, email: `${id}@example.com`, passwordHash, name: id, zone: "Palermo", createdAt: nowIso(), emailVerifiedAt: nowIso() }).run();
    return id;
  }
  function insertPost(extra: Partial<typeof posts.$inferInsert> & { id: string }) {
    const stamp = at(seq++);
    db.insert(posts).values({ userId: uid(1), tipo: "encontrado", titulo: `Publicación ${extra.id}`, descripcion: "Descripción de la publicación de prueba.",
      categoria: "Llaves", barrio: "Palermo", fecha: localDate(), franja: "tarde", latitud: -34.5889, longitud: -58.4306,
      direccionExacta: "Calle privada 123", fotos: [], createdAt: stamp, updatedAt: stamp, ...extra }).run();
    return extra.id;
  }
  /** Recorre todas las páginas verificando los metadatos de cada una y devuelve los ids en el orden recibido. */
  async function walk(path: string, account: number, pageSize: number, total: number) {
    const sep = path.includes("?") ? "&" : "?";
    const totalPages = Math.ceil(total / pageSize);
    const seen: string[] = [];
    for (let page = 1; page <= totalPages; page++) {
      const r = await get(`${path}${sep}page=${page}&pageSize=${pageSize}`, account);
      expect(r.response.status).toBe(200);
      expect(r.data).toMatchObject({ page, pageSize, total, totalPages });
      expect(r.data.items).toHaveLength(page < totalPages ? pageSize : total - pageSize * (totalPages - 1));
      seen.push(...idsOf(r));
    }
    const beyond = await get(`${path}${sep}page=${totalPages + 1}&pageSize=${pageSize}`, account);
    expect(beyond.data.items).toEqual([]);
    expect(beyond.data).toMatchObject({ page: totalPages + 1, pageSize, total, totalPages });
    return seen;
  }
  const descending = <T>(rows: T[], key: (row: T) => string, tie: (row: T) => string) =>
    [...rows].sort((a, b) => key(b).localeCompare(key(a)) || tie(b).localeCompare(tie(a)));

  test("/me/seguidas: ordena por actualización, pagina en cuatro páginas, excluye eliminadas y ajenas, y deriva el estado", async () => {
    const viewer = 2;
    const fixture: { id: string; updatedAt: string }[] = [];
    // i * 5 mod 14 recorre una permutación: la actualización no coincide con el orden de alta ni de id.
    for (let i = 0; i < 14; i++) {
      const id = `s-${String(i).padStart(2, "0")}`;
      const updatedAt = at(1000 + (i * 5) % 14);
      insertPost({ id, updatedAt });
      db.insert(follows).values({ userId: uid(viewer), publicationId: id, createdAt: at(i) }).run();
      fixture.push({ id, updatedAt });
    }
    const past = new Date(Date.now() - DAY).toISOString();
    db.update(posts).set({ venceAt: past }).where(eq(posts.id, "s-03")).run();
    db.update(posts).set({ venceAt: past }).where(eq(posts.id, "s-04")).run();
    db.insert(claims).values({ id: "pending-claim", publicationId: "s-04", userId: uid(0), mensaje: "Son mis llaves.", estado: "pendiente", createdAt: nowIso(), updatedAt: nowIso() }).run();
    db.update(posts).set({ estado: "en_reclamo" }).where(eq(posts.id, "s-05")).run();
    db.update(posts).set({ estado: "resuelta", resolvedAt: nowIso() }).where(eq(posts.id, "s-06")).run();
    // Eliminadas seguidas: no cuentan. Seguidas por otra cuenta y publicaciones sin seguir: no aparecen.
    for (const id of ["gone-1", "gone-2"]) {
      insertPost({ id, deletedAt: nowIso(), updatedAt: at(5000) });
      db.insert(follows).values({ userId: uid(viewer), publicationId: id, createdAt: at(50) }).run();
    }
    insertPost({ id: "others-only", updatedAt: at(6000) });
    insertPost({ id: "not-followed", updatedAt: at(6001) });
    for (const id of ["s-00", "s-01", "others-only"]) db.insert(follows).values({ userId: uid(0), publicationId: id, createdAt: at(60) }).run();

    const expected = descending(fixture, (f) => f.updatedAt, (f) => f.id).map((f) => f.id);
    for (const size of [4, 5, 7, 20]) expect(await walk("/me/seguidas", viewer, size, 14)).toEqual(expected);
    const all = (await get("/me/seguidas?pageSize=100", viewer)).data;
    expect(Object.keys(all)).toEqual(["items", "page", "pageSize", "total", "totalPages"]);
    const estado = Object.fromEntries(all.items.map((x: any) => [x.id, x.estado]));
    expect(estado).toMatchObject({ "s-03": "vencida", "s-04": "abierta", "s-05": "en_reclamo", "s-06": "resuelta", "s-00": "abierta" });
    expect(Object.keys(all.items[0]).sort()).toEqual(["id", "tipo", "titulo", "descripcion", "categoria", "barrio", "fecha", "franja", "estado",
      "latitud", "longitud", "ubicacion", "fotos", "creadaEn", "actualizadaEn", "resueltaEn", "venceAt"].sort());
    expect(JSON.stringify(all)).not.toContain("Calle privada");
    // Cada cuenta ve solo lo que sigue; sin seguidas la página es vacía con total 0.
    expect(idsOf(await get("/me/seguidas", 0)).sort()).toEqual(["others-only", "s-00", "s-01"]);
    expect((await get("/me/seguidas", 1)).data).toEqual({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 });
  });

  describe("historial", () => {
    const E = "encontrado" as const, P = "perdido" as const;
    type Case = { id: string; owner: string; claimant: string; tipo: typeof E | typeof P; resolvedAt: string | null; estado: "resuelta" | "en_reclamo"; deleted: boolean; claim: "aceptado" | "rechazado" };
    let all: Case[];
    function insertCase(id: string, owner: string, claimant: string, tipo: typeof E | typeof P, resolvedAt: string | null, extra: Partial<Case> = {}) {
      const c: Case = { id, owner, claimant, tipo, resolvedAt, estado: "resuelta", deleted: false, claim: "aceptado", ...extra };
      insertPost({ id, userId: owner, tipo, estado: c.estado, resolvedAt, deletedAt: c.deleted ? nowIso() : null });
      db.insert(claims).values({ id: `claim-${id}`, publicationId: id, userId: claimant, mensaje: "Son mis llaves.", estado: c.claim, createdAt: at(seq), updatedAt: at(seq) }).run();
      all.push(c);
      return c;
    }
    const caseType = (c: Case, viewer: string) => ((c.tipo === E ? c.owner : c.claimant) === viewer ? "devolvi" : "recupere");
    const involves = (c: Case, viewer: string) => c.owner === viewer || c.claimant === viewer;
    /** Lo que debe ver `viewer`, en orden: resueltas con aceptado, no eliminadas y con fecha, más recientes primero. */
    const visible = (viewer: string) => descending(
      all.filter((c) => c.estado === "resuelta" && c.claim === "aceptado" && !c.deleted && c.resolvedAt && involves(c, viewer)),
      (c) => c.resolvedAt!, (c) => c.id);
    let u: string[];
    beforeEach(() => {
      all = [];
      u = [uid(0), uid(1), uid(2), addUser("extra-3")];
      const [u0, u1, u2, u3] = u as [string, string, string, string];
      insertCase("h-01", u0, u1, E, "2026-03-01T15:00:00.000Z");
      insertCase("h-02", u0, u1, P, "2026-03-02T15:00:00.000Z");
      insertCase("h-03", u1, u0, E, "2026-03-03T15:00:00.000Z");
      insertCase("h-04", u1, u0, P, "2026-03-04T15:00:00.000Z");
      // Tres casos con el mismo instante: el desempate es el id, descendente.
      insertCase("h-05", u0, u2, E, "2026-03-05T15:00:00.000Z");
      insertCase("h-06", u2, u0, P, "2026-03-05T15:00:00.000Z");
      insertCase("h-07", u0, u3, P, "2026-03-05T15:00:00.000Z");
      insertCase("h-08", u3, u0, E, "2026-03-07T15:00:00.000Z");
      insertCase("h-09", u0, u1, E, "2026-03-08T15:00:00.000Z");
      insertCase("h-10", u1, u0, E, "2026-03-09T15:00:00.000Z");
      insertCase("h-11", u0, u2, P, "2026-03-10T15:00:00.000Z");
      insertCase("h-12", u2, u0, E, "2026-03-11T15:00:00.000Z");
      insertCase("h-13", u0, u1, E, "2026-03-12T15:00:00.000Z");
      insertCase("h-14", u0, u3, E, new Date(Date.now() - DAY).toISOString());
      // No son casos del historial: eliminada, sin fecha de resolución, reclamo rechazado, publicación no resuelta y pareja ajena.
      insertCase("x-eliminada", u0, u1, E, "2026-03-06T15:00:00.000Z", { deleted: true });
      insertCase("x-sin-fecha", u0, u1, E, null);
      insertCase("x-rechazado", u0, u1, E, "2026-03-06T16:00:00.000Z", { claim: "rechazado" });
      insertCase("x-abierta", u0, u1, E, "2026-03-06T17:00:00.000Z", { estado: "en_reclamo" });
      insertCase("x-ajeno", u1, u2, E, "2026-03-06T18:00:00.000Z");
      const review = (id: string, publicationId: string, reviewerId: string, reviewedUserId: string, positiva: boolean, comentario: string) =>
        db.insert(halladoReviews).values({ id, publicationId, reviewerId, reviewedUserId, positiva, comentario, createdAt: nowIso() }).run();
      review("r1", "h-01", u0, u1, true, "Gracias");
      review("r2", "h-01", u1, u0, false, "La otra parte");
      review("r3", "h-04", u0, u1, false, "");
      const thank = (id: string, publicationId: string, authorId: string, recipientId: string, mensaje: string) =>
        db.insert(thanks).values({ id, publicationId, authorId, recipientId, mensaje, createdAt: nowIso() }).run();
      // h-03: u0 recuperó y agradeció. h-04: agradeció la otra parte, así que u0 no lo ve en su historial.
      thank("t1", "h-03", u0, u1, "Gracias por las llaves");
      thank("t2", "h-04", u1, u0, "Gracias, de parte de la otra persona");
    });

    function expectedItem(c: Case, viewer: string) {
      const other = c.owner === viewer ? c.claimant : c.owner;
      const user = db.select().from(users).where(eq(users.id, other)).get()!;
      const completed = all.filter((x) => x.estado === "resuelta" && (x.owner === other || (x.claim === "aceptado" && x.claimant === other))).length;
      const received = db.select().from(halladoReviews).where(eq(halladoReviews.reviewedUserId, other)).all();
      const mine = db.select().from(halladoReviews).where(eq(halladoReviews.reviewerId, viewer)).all().find((r) => r.publicationId === c.id);
      const thanked = db.select().from(thanks).where(eq(thanks.authorId, viewer)).all().find((t) => t.publicationId === c.id);
      const limite = new Date(Date.parse(c.resolvedAt!) + 7 * DAY).toISOString();
      return {
        id: c.id, fecha: c.resolvedAt, tipo: caseType(c, viewer),
        objeto: { titulo: `Publicación ${c.id}`, categoria: "Llaves", tipo: c.tipo },
        contraparte: { id: other, name: user.name, zone: "Palermo", avatarUrl: null, memberSince: user.createdAt,
          reputation: { completedReturns: completed, positiveReviews: received.filter((r) => r.positiva).length, negativeReviews: received.filter((r) => !r.positiva).length },
          badges: completed >= 5 ? [{ id: "vecino-solidario", name: "Vecino solidario", description: "Por concretar 5 devoluciones." }] : [] },
        valoracion: mine ? { positiva: mine.positiva, comentario: mine.comentario } : null,
        agradecimiento: thanked ? { mensaje: thanked.mensaje } : null,
        limiteValoracion: limite, puedeValorar: !mine && nowIso() <= limite,
      };
    }

    test("pagina en cuatro páginas con orden por resolución e id, y cada item conserva su forma, perfiles repetidos y tipo", async () => {
      const [u0] = u as [string];
      const expected = visible(u0);
      expect(expected.map((c) => c.id)).toEqual(["h-14", "h-13", "h-12", "h-11", "h-10", "h-09", "h-08", "h-07", "h-06", "h-05", "h-04", "h-03", "h-02", "h-01"]);
      for (const size of [4, 5, 13, 100]) expect(await walk("/me/historial", 0, size, 14)).toEqual(expected.map((c) => c.id));
      const full = (await get("/me/historial?pageSize=100", 0)).data;
      expect(Object.keys(full)).toEqual(["items", "page", "pageSize", "total", "totalPages"]);
      expect(full.items).toEqual(expected.map((c) => expectedItem(c, u0)));
      // Los tipos salen de quién devolvió: el que publicó un hallazgo o el que reclamó un objeto perdido.
      expect(Object.fromEntries(full.items.map((x: any) => [x.id, x.tipo]))).toEqual(Object.fromEntries(expected.map((c) => [c.id, caseType(c, u0)])));
      expect(full.items.find((x: any) => x.id === "h-01").valoracion).toEqual({ positiva: true, comentario: "Gracias" });
      expect(full.items.find((x: any) => x.id === "h-01").puedeValorar).toBe(false);
      expect(full.items.find((x: any) => x.id === "h-14").puedeValorar).toBe(true);
      expect(full.items.find((x: any) => x.id === "h-03").agradecimiento).toEqual({ mensaje: "Gracias por las llaves" });
      expect(full.items.find((x: any) => x.id === "h-04").agradecimiento).toBeNull();
      // Con perfiles repetidos, la reputación de la contraparte es la misma en todos sus casos.
      const rep = full.items.filter((x: any) => x.contraparte.id === u[1]).map((x: any) => JSON.stringify(x.contraparte));
      expect(rep.length).toBeGreaterThan(3); expect(new Set(rep).size).toBe(1);
      expect(JSON.stringify(full)).not.toContain("Calle privada");
    });

    test("filtra por tipo y pagina cada subconjunto con su propio total", async () => {
      const [u0] = u as [string];
      for (const tipo of ["devolvi", "recupere"] as const) {
        const expected = visible(u0).filter((c) => caseType(c, u0) === tipo).map((c) => c.id);
        expect(expected.length).toBeGreaterThan(3);
        for (const size of [3, 4, 100]) expect(await walk(`/me/historial?tipo=${tipo}`, 0, size, expected.length)).toEqual(expected);
      }
    });

    test("cada cuenta ve solo sus casos", async () => {
      for (const [account, viewer] of [[0, u[0]!], [1, u[1]!], [2, u[2]!]] as const) {
        const expected = visible(viewer);
        expect(await walk("/me/historial", account, 3, expected.length)).toEqual(expected.map((c) => c.id));
        expect((await get("/me/historial?pageSize=100", account)).data.items).toEqual(expected.map((c) => expectedItem(c, viewer)));
      }
      expect((await get("/me/historial", 2)).data.items.map((x: any) => x.id)).not.toContain("h-01");
    });

    test("sin casos devuelve una página vacía", async () => {
      db.delete(thanks).run(); db.delete(halladoReviews).run(); db.delete(claims).run(); db.delete(posts).run();
      expect((await get("/me/historial", 0)).data).toEqual({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 });
    });
  });

  test("/me/historial: el rango de fechas es por día local inclusivo, no por día UTC, y respeta el borde de medianoche", async () => {
    const [u0, u1] = [uid(0), uid(1)];
    const put = (id: string, resolvedAt: string, owner = u0, claimant = u1) => {
      insertPost({ id, userId: owner, estado: "resuelta", resolvedAt });
      db.insert(claims).values({ id: `claim-${id}`, publicationId: id, userId: claimant, mensaje: "Son mis llaves.", estado: "aceptado", createdAt: at(seq), updatedAt: at(seq) }).run();
    };
    // Argentina es UTC-3: la medianoche local del 10/03 es 03:00Z.
    put("b1", "2026-03-10T02:59:59.999Z");
    put("b2", "2026-03-10T03:00:00.000Z");
    put("b2-bis", "2026-03-10T03:00:00.000Z");
    put("b3", "2026-03-11T02:59:59.999Z");
    put("b4", "2026-03-11T03:00:00.000Z");
    put("r1", "2026-03-10T03:00:00.000Z", u1, u0); // recupere
    const listed = async (qs: string) => (await get(`/me/historial?pageSize=100&${qs}`, 0)).data;
    expect(idsOf({ data: await listed("desde=2026-03-10&hasta=2026-03-10") })).toEqual(["b3", "r1", "b2-bis", "b2"]);
    expect(idsOf({ data: await listed("desde=2026-03-09&hasta=2026-03-09") })).toEqual(["b1"]);
    expect(idsOf({ data: await listed("desde=2026-03-11&hasta=2026-03-11") })).toEqual(["b4"]);
    expect(idsOf({ data: await listed("desde=2026-03-10") })).toEqual(["b4", "b3", "r1", "b2-bis", "b2"]);
    expect(idsOf({ data: await listed("hasta=2026-03-10") })).toEqual(["b3", "r1", "b2-bis", "b2", "b1"]);
    expect(idsOf({ data: await listed("desde=2026-03-09&hasta=2026-03-11") })).toEqual(["b4", "b3", "r1", "b2-bis", "b2", "b1"]);
    expect(idsOf({ data: await listed("tipo=recupere&desde=2026-03-10&hasta=2026-03-10") })).toEqual(["r1"]);
    expect(idsOf({ data: await listed("tipo=devolvi&desde=2026-03-10&hasta=2026-03-10") })).toEqual(["b3", "b2-bis", "b2"]);
    expect(await listed("desde=2026-03-12&hasta=2026-03-12")).toEqual({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 0 });
    const paged = (await get("/me/historial?desde=2026-03-10&hasta=2026-03-10&pageSize=2&page=2", 0)).data;
    expect(paged).toMatchObject({ page: 2, pageSize: 2, total: 4, totalPages: 2 });
    expect(idsOf({ data: paged })).toEqual(["b2-bis", "b2"]);
  });

  test("/alertas: ordena por alta e id, pagina en cinco páginas, cuenta sinLeer por alerta y excluye las ajenas", async () => {
    const stamps = [0, 1, 2, 3, 3, 5, 5, 5, 8];
    const fixture = stamps.map((n, i) => ({ id: `a-${i}`, createdAt: at(n), activa: i !== 6 }));
    for (const a of fixture) {
      db.insert(alerts).values({ id: a.id, userId: uid(0), clave: `clave-${a.id}`, activa: a.activa, createdAt: a.createdAt,
        filtros: { situacion: "perdi", categoria: "Llaves", palabras: a.id, zona: "Palermo", periodo: "semana", ubicacion: null } }).run();
    }
    db.insert(alerts).values({ id: "ajena", userId: uid(1), clave: "ajena", createdAt: at(9),
      filtros: { situacion: "perdi", categoria: "Llaves", palabras: "ajena", zona: "Palermo", periodo: "semana", ubicacion: null } }).run();
    const note = (id: string, alertId: string, userId: string, read: boolean) =>
      db.insert(notifications).values({ id, userId, tipo: "coincidencia", mensaje: `Aviso ${id}`, alertId, readAt: read ? nowIso() : null, createdAt: at(seq++) }).run();
    for (const [i, read] of [[0, false], [1, false], [2, false], [3, true]] as const) note(`n8-${i}`, "a-8", uid(0), read);
    note("n4-0", "a-4", uid(0), false);
    note("n2-0", "a-2", uid(0), true); note("n2-1", "a-2", uid(0), true);
    note("naj-0", "ajena", uid(1), false); note("naj-1", "ajena", uid(1), false);
    const expected = descending(fixture, (a) => a.createdAt, (a) => a.id).map((a) => a.id);
    expect(expected).toEqual(["a-8", "a-7", "a-6", "a-5", "a-4", "a-3", "a-2", "a-1", "a-0"]);
    for (const size of [2, 4, 100]) expect(await walk("/alertas", 0, size, 9)).toEqual(expected);
    const all = (await get("/alertas?pageSize=100", 0)).data;
    expect(Object.keys(all)).toEqual(["items", "page", "pageSize", "total", "totalPages"]);
    expect(Object.keys(all.items[0])).toEqual(["id", "clave", "filtros", "activa", "creadaEn", "sinLeer"]);
    expect(Object.fromEntries(all.items.map((x: any) => [x.id, x.sinLeer]))).toEqual({ "a-8": 3, "a-7": 0, "a-6": 0, "a-5": 0, "a-4": 1, "a-3": 0, "a-2": 0, "a-1": 0, "a-0": 0 });
    expect(all.items.find((x: any) => x.id === "a-6")).toMatchObject({ activa: false, clave: "clave-a-6", creadaEn: at(5) });
    expect(all.items[0].filtros).toMatchObject({ palabras: "a-8", categoria: "Llaves" });
    // El conteo no depende de la página pedida y la cuenta ajena conserva el suyo.
    expect((await get("/alertas?pageSize=1&page=9", 0)).data.items[0]).toMatchObject({ id: "a-0", sinLeer: 0 });
    expect((await get("/alertas?pageSize=1", 0)).data.items[0]).toMatchObject({ id: "a-8", sinLeer: 3 });
    expect((await get("/alertas", 1)).data.items.map((x: any) => [x.id, x.sinLeer])).toEqual([["ajena", 2]]);
    expect((await api("/alertas/a-8/leida", "POST", undefined, accounts[0]!.token)).response.status).toBe(200);
    expect((await get("/alertas?pageSize=1", 0)).data.items[0]).toMatchObject({ id: "a-8", sinLeer: 0 });
    expect((await get("/alertas", 2)).data).toEqual({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 });
  });

  test("/notificaciones: ordena por alta e id, pagina en cuatro páginas, sinLeer es global y las ajenas no aparecen", async () => {
    insertPost({ id: "n-post", deletedAt: nowIso() });
    db.insert(alerts).values({ id: "n-alert", userId: uid(2), clave: "n-alert", createdAt: at(0),
      filtros: { situacion: "perdi", categoria: "Llaves", palabras: "", zona: "Palermo", periodo: "semana", ubicacion: null } }).run();
    db.insert(claims).values({ id: "n-claim", publicationId: "n-post", userId: uid(2), mensaje: "Son mis llaves.", estado: "pendiente", createdAt: at(0), updatedAt: at(0) }).run();
    const stamps = [0, 1, 2, 3, 3, 3, 6, 7, 8, 8, 10, 11, 12];
    const fixture = stamps.map((n, i) => ({ id: `n-${String(i).padStart(2, "0")}`, createdAt: at(100 + n), read: i % 3 === 0 }));
    for (const n of fixture) {
      db.insert(notifications).values({ id: n.id, userId: uid(2), tipo: "publicacion", mensaje: `Aviso ${n.id}`, publicationId: "n-post", claimId: "n-claim", alertId: "n-alert",
        readAt: n.read ? at(500) : null, createdAt: n.createdAt }).run();
    }
    for (const id of ["ajena-1", "ajena-2"]) db.insert(notifications).values({ id, userId: uid(1), tipo: "publicacion", mensaje: "No es tuyo", createdAt: at(1000) }).run();
    const expected = descending(fixture, (n) => n.createdAt, (n) => n.id);
    const unread = fixture.filter((n) => !n.read).length;
    for (const size of [4, 5, 100]) expect(await walk("/notificaciones", 2, size, 13)).toEqual(expected.map((n) => n.id));
    const first = (await get("/notificaciones?pageSize=2", 2)).data;
    expect(Object.keys(first)).toEqual(["items", "page", "pageSize", "total", "totalPages", "sinLeer"]);
    // sinLeer cuenta todas las notificaciones sin leer, no solo las de la página.
    expect(first.sinLeer).toBe(unread);
    expect((await get("/notificaciones?pageSize=2&page=7", 2)).data.sinLeer).toBe(unread);
    expect((await get("/notificaciones?page=99", 2)).data).toEqual({ items: [], page: 99, pageSize: 20, total: 13, totalPages: 1, sinLeer: unread });
    const item = (await get("/notificaciones?pageSize=100", 2)).data.items[0];
    expect(item).toEqual({ id: expected[0]!.id, tipo: "publicacion", mensaje: `Aviso ${expected[0]!.id}`, publicacionId: "n-post", reclamoId: "n-claim",
      alertaId: "n-alert", creadaEn: expected[0]!.createdAt, leidaEn: expected[0]!.read ? at(500) : null });
    expect((await get("/notificaciones", 1)).data).toMatchObject({ total: 2, sinLeer: 2 });
    expect((await get("/notificaciones", 0)).data).toEqual({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 0, sinLeer: 0 });
    const target = expected.find((n) => !n.read)!;
    expect((await api(`/notificaciones/${target.id}/leida`, "POST", undefined, accounts[2]!.token)).response.status).toBe(200);
    expect((await get("/notificaciones?pageSize=1", 2)).data.sinLeer).toBe(unread - 1);
    expect((await api("/notificaciones/leidas", "POST", undefined, accounts[2]!.token)).response.status).toBe(200);
    expect((await get("/notificaciones?pageSize=1", 2)).data).toMatchObject({ total: 13, sinLeer: 0 });
  });

  test("/notificaciones y /me/seguidas reconcilian los vencimientos antes de armar la página", async () => {
    const id = insertPost({ id: "vence", updatedAt: at(900) });
    db.insert(follows).values({ userId: uid(2), publicationId: id, createdAt: at(0) }).run();
    for (let i = 0; i < 5; i++) db.insert(notifications).values({ id: `old-${i}`, userId: uid(2), tipo: "publicacion", mensaje: `Viejo ${i}`, createdAt: at(i) }).run();
    db.update(posts).set({ venceAt: new Date(Date.now() - DAY).toISOString() }).where(eq(posts.id, id)).run();
    // La primera respuesta ya incluye el aviso recién creado, primero en la página y contado en el total.
    const first = (await get("/notificaciones?pageSize=2", 2)).data;
    expect(first.items[0]).toMatchObject({ mensaje: "Venció: Publicación vence", publicacionId: id });
    expect(first).toMatchObject({ total: 6, totalPages: 3, sinLeer: 6 });
    expect((await get("/notificaciones", 2)).data.total).toBe(6);
    // Las seguidas también reconcilian: el aviso borrado se vuelve a crear y la publicación figura como vencida.
    db.delete(notifications).where(eq(notifications.mensaje, "Venció: Publicación vence")).run();
    const followed = (await get("/me/seguidas", 2)).data;
    expect(followed.items[0]).toMatchObject({ id, estado: "vencida" });
    expect((await get("/notificaciones?pageSize=1", 2)).data.items[0]).toMatchObject({ mensaje: "Venció: Publicación vence" });
  });

  test("los cuatro listados validan la paginación y exigen sesión", async () => {
    for (const path of ["/me/seguidas", "/me/historial", "/alertas", "/notificaciones"]) {
      expect((await api(path)).response.status).toBe(401);
      for (const bad of ["page=0", "page=-1", "page=1.5", "page=x", "pageSize=0", "pageSize=101", "pageSize=x", "page=1000001"]) {
        const r = await get(`${path}?${bad}`, 2);
        expect([path, bad, r.response.status]).toEqual([path, bad, 422]);
        expect(r.data.error.code).toBe("INVALID_PAGINATION");
      }
      expect((await get(`${path}?page=1000000&pageSize=100`, 2)).response.status).toBe(200);
    }
    // En el historial el filtro inválido se informa antes que la paginación.
    expect((await get("/me/historial?tipo=otro&page=0", 2)).data.error.code).toBe("INVALID_TYPE");
    expect((await get("/me/historial?desde=no&page=0", 2)).data.error.code).toBe("INVALID_DATE_RANGE");
  });

  test("/me/seguidas: con la misma actualización desempata por id descendente en todas las páginas", async () => {
    const stamp = at(500);
    // Se siguen en orden ascendente de id: el orden de seguimiento no decide el desempate.
    for (const id of ["t-1", "t-2", "t-3", "t-4", "t-5"]) {
      insertPost({ id, updatedAt: stamp });
      db.insert(follows).values({ userId: uid(2), publicationId: id, createdAt: at(seq++) }).run();
    }
    insertPost({ id: "t-0", updatedAt: at(501) });
    db.insert(follows).values({ userId: uid(2), publicationId: "t-0", createdAt: at(seq++) }).run();
    expect(await walk("/me/seguidas", 2, 2, 6)).toEqual(["t-0", "t-5", "t-4", "t-3", "t-2", "t-1"]);
    // Dejar de seguir saca la publicación del listado y del total.
    expect((await api("/publicaciones/t-5/seguir", "DELETE", undefined, accounts[2]!.token)).response.status).toBe(200);
    expect((await get("/me/seguidas?pageSize=2", 2)).data).toMatchObject({ total: 5, totalPages: 3 });
    expect(idsOf(await get("/me/seguidas?pageSize=100", 2))).toEqual(["t-0", "t-4", "t-3", "t-2", "t-1"]);
  });

  describe("límites de consultas y filas materializadas", () => {
    type Statement = { sql: string; rows: number; params: unknown[] };
    const SIZES = [1, 20, 100];
    const WRITE = /^\s*(insert|update|delete|replace|create|drop|alter)/i;

    /** Ejecuta la request registrando cada consulta SQL y las filas que SQLite entrega a la aplicación. */
    async function measure(path: string, account: number) {
      const statements: Statement[] = [];
      const original = db.$client.query.bind(db.$client);
      (db.$client as any).query = (text: string) => {
        const statement: any = original(text);
        return new Proxy(statement, {
          get(target, prop) {
            const value = target[prop];
            if (typeof value !== "function") return value;
            if (prop === "all" || prop === "values") return (...args: unknown[]) => { const rows = value.apply(target, args); statements.push({ sql: text, rows: rows.length, params: args }); return rows; };
            if (prop === "get") return (...args: unknown[]) => { const row = value.apply(target, args); statements.push({ sql: text, rows: row == null ? 0 : 1, params: args }); return row; };
            if (prop === "run") return (...args: unknown[]) => { statements.push({ sql: text, rows: 0, params: args }); return value.apply(target, args); };
            return value.bind(target);
          },
        });
      };
      try {
        const result = await get(path, account);
        // La autenticación (una consulta a sesiones y usuarios) es la misma para cualquier tamaño y queda fuera del conteo.
        const counted = statements.filter((s) => !/"sessions"/i.test(s.sql));
        expect(statements.length - counted.length).toBe(1);
        return { ...result, statements: counted, rows: counted.reduce((n, s) => n + s.rows, 0), maxRows: Math.max(0, ...counted.map((s) => s.rows)) };
      } finally { (db.$client as any).query = original; }
    }
    /** Mide los tamaños 1/20/100 y exige consultas acotadas, iguales entre tamaños y filas proporcionales a la página. */
    async function bounded(path: string, account: number, total: number, maxStatements: number) {
      await get(`${path}${path.includes("?") ? "&" : "?"}pageSize=1`, account); // las escrituras de reconciliación se hacen una sola vez
      const counts: number[] = [];
      for (const size of SIZES) {
        const m = await measure(`${path}${path.includes("?") ? "&" : "?"}pageSize=${size}`, account);
        expect(m.response.status).toBe(200);
        expect(m.data.items).toHaveLength(Math.min(size, total));
        expect(m.data.total).toBe(total);
        expect(m.statements.filter((s) => WRITE.test(s.sql))).toEqual([]);
        expect(m.statements.length).toBeLessThanOrEqual(maxStatements);
        // Ninguna consulta entrega más filas que la página, y el total materializado crece con ella, no con los datos.
        expect(m.maxRows).toBeLessThanOrEqual(size);
        expect(m.rows).toBeLessThanOrEqual(5 * size + 4);
        counts.push(m.statements.length);
      }
      expect(new Set(counts).size).toBe(1);
      return (size: number) => measure(`${path}${path.includes("?") ? "&" : "?"}pageSize=${size}`, account);
    }

    /** Plan de ejecución de SQLite de las consultas medidas: cada línea es un paso, por ejemplo «SEARCH tabla USING INDEX ...». */
    const planOf = (statements: Statement[]) => statements.flatMap((s) =>
      (db.$client.query("EXPLAIN QUERY PLAN " + s.sql).all(...(s.params as any[])) as { detail: string }[]).map((r) => r.detail)).join("; ");
    // La consulta que lista cada página: ordena, y es la que debe llevar LIMIT.
    const followedPage = (s: Statement) => /from "hallado_follows" inner join "hallado_publications"/.test(s.sql) && /order by/i.test(s.sql);
    const alertsPage = (s: Statement) => /from "hallado_alerts"/.test(s.sql) && /order by/i.test(s.sql);
    const notificationsPage = (s: Statement) => /from "hallado_notifications"/.test(s.sql) && /order by/i.test(s.sql);
    /** Una página posterior a la primera agrega OFFSET a la misma consulta, con un máximo de filas igual al tamaño. */
    async function expectOffset(path: string, account: number, isPage: (s: Statement) => boolean) {
      const m = await measure(`${path}?page=2&pageSize=20`, account);
      const page = m.statements.find(isPage)!;
      expect(page.sql).toMatch(/ limit \? offset \?/i);
      expect(page.rows).toBe(20);
    }

    test("/me/seguidas: reconcilia, cuenta y trae solo la página, con estados derivados en lote", async () => {
      for (let i = 0; i < 150; i++) {
        const id = `f-${String(i).padStart(3, "0")}`;
        insertPost({ id, updatedAt: at(2000 + i) });
        db.insert(follows).values({ userId: uid(2), publicationId: id, createdAt: at(i) }).run();
      }
      // Las más recientes están vencidas; dos las sostiene un reclamo vigente y otras quedan fuera de la primera página.
      for (const i of [149, 148, 147, 140, 130, 120, 100, 60, 20, 0]) {
        db.update(posts).set({ venceAt: new Date(Date.now() - DAY).toISOString() }).where(eq(posts.id, `f-${String(i).padStart(3, "0")}`)).run();
      }
      for (const i of [148, 147]) {
        db.insert(claims).values({ id: `pc-${i}`, publicationId: `f-${i}`, userId: uid(0), mensaje: "Son mis llaves.", estado: "pendiente", createdAt: nowIso(), updatedAt: nowIso() }).run();
      }
      const run = await bounded("/me/seguidas", 2, 150, 4);
      for (const size of SIZES) {
        const m = await run(size);
        const page = m.statements.find(followedPage)!;
        expect(page.sql).toMatch(/ limit \?/i);
        expect(page.sql).toMatch(/"deleted_at" is null/);
        expect(page.rows).toBe(size);
        // Reputación, valoraciones y notificaciones no se consultan por fila; el estado vencido sale de una sola consulta por lote.
        expect(m.statements.filter((s) => /hallado_reviews|users/.test(s.sql))).toEqual([]);
        expect(m.statements.filter((s) => /from "hallado_claims"/.test(s.sql))).toHaveLength(1);
      }
      await expectOffset("/me/seguidas", 2, followedPage);
      const plan = planOf((await run(20)).statements);
      expect(plan).toContain("SEARCH hallado_follows USING INDEX hallado_seguimiento_usuario_idx (user_id=?)");
      expect(plan).not.toMatch(/SCAN hallado_(follows|publications)/);
      const top = (await get("/me/seguidas?pageSize=3", 2)).data.items;
      expect(top.map((x: any) => [x.id, x.estado])).toEqual([["f-149", "vencida"], ["f-148", "abierta"], ["f-147", "abierta"]]);
    });

    test("/alertas: pagina en SQL y cuenta sinLeer de la página con una sola consulta agrupada", async () => {
      for (let i = 0; i < 120; i++) {
        const id = `al-${String(i).padStart(3, "0")}`;
        db.insert(alerts).values({ id, userId: uid(0), clave: id, createdAt: at(i),
          filtros: { situacion: "perdi", categoria: "Llaves", palabras: id, zona: "Palermo", periodo: "semana", ubicacion: null } }).run();
        for (const read of [false, true]) db.insert(notifications).values({ id: `${id}-${read}`, userId: uid(0), tipo: "coincidencia", mensaje: "Aviso", alertId: id, readAt: read ? nowIso() : null, createdAt: at(i) }).run();
      }
      const run = await bounded("/alertas", 0, 120, 3);
      for (const size of SIZES) {
        const m = await run(size);
        const page = m.statements.find(alertsPage)!;
        expect(page.sql).toMatch(/ limit \?/i);
        expect(page.rows).toBe(size);
        expect(m.data.items.every((x: any) => x.sinLeer === 1)).toBe(true);
      }
      await expectOffset("/alertas", 0, alertsPage);
    });

    test("/notificaciones: reconcilia, pagina y obtiene total y sinLeer en SQL sin traer todas las filas", async () => {
      for (let i = 0; i < 150; i++) {
        db.insert(notifications).values({ id: `nt-${String(i).padStart(3, "0")}`, userId: uid(2), tipo: "publicacion", mensaje: `Aviso ${i}`,
          readAt: i % 4 === 0 ? at(900) : null, createdAt: at(i) }).run();
      }
      const run = await bounded("/notificaciones", 2, 150, 3);
      for (const size of SIZES) {
        const m = await run(size);
        const page = m.statements.find(notificationsPage)!;
        expect(page.sql).toMatch(/ limit \?/i);
        expect(page.rows).toBe(size);
        expect(m.data.sinLeer).toBe(150 - 38);
      }
      await expectOffset("/notificaciones", 2, notificationsPage);
      const plan = planOf((await run(20)).statements);
      expect(plan).toContain("hallado_notificacion_usuario_idx (user_id=?)");
      expect(plan).not.toMatch(/SCAN hallado_notifications/);
    });
  });
});
