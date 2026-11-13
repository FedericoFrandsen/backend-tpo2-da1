import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import QRCode from "qrcode";
import { createApp } from "../src/app";
import { createSession } from "../src/auth";
import { createDatabase } from "../src/database";
import { claims, halladoPublications as posts, notifications, returnCodes, users } from "../src/db/schema";
import { localDate, nowIso } from "../src/utils";

let db: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createApp>;
let tokens: string[];
let generated: string;
const originalQr = QRCode.toDataURL.bind(QRCode);
let qrSpy: ReturnType<typeof spyOn>;

async function api(path: string, account: number | null = 0, body?: unknown) {
  const response = await app.handle(new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(account === null ? {} : { Authorization: `Bearer ${tokens[account]}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, data: await response.json() as any };
}

function fixture(tipo: "encontrado" | "perdido" = "encontrado", suffix = "1") {
  const publicationId = `post-${suffix}`, claimId = `claim-${suffix}`;
  db.insert(posts).values({ id: publicationId, userId: "user-0", tipo, titulo: "Llaves azules", descripcion: "Un juego de llaves azules", categoria: "Llaves", barrio: "Palermo", fecha: localDate(), franja: "tarde", latitud: -34.58, longitud: -58.42, estado: "en_reclamo", createdAt: nowIso(), updatedAt: nowIso() }).run();
  db.insert(claims).values({ id: claimId, publicationId, userId: "user-1", mensaje: "Son mis llaves", estado: "aceptado", intentos: 1, createdAt: nowIso(), updatedAt: nowIso() }).run();
  return `/reclamos/${claimId}/devolucion`;
}

beforeEach(async () => {
  db = createDatabase(":memory:");
  app = createApp(db);
  tokens = [];
  for (let i = 0; i < 3; i++) {
    const id = `user-${i}`;
    db.insert(users).values({ id, email: `qr${i}@example.com`, passwordHash: "unused-test-password", name: `Persona ${i}`, createdAt: nowIso(), emailVerifiedAt: nowIso() }).run();
    tokens.push((await createSession(db, id, 1)).token);
  }
  qrSpy = spyOn(QRCode, "toDataURL").mockImplementation(((text: string, options: any) => {
    generated = JSON.parse(text).codigo;
    expect(JSON.parse(text).reclamoId).toStartWith("claim-");
    return originalQr(text, options);
  }) as any);
});
afterEach(() => { qrSpy.mockRestore(); db.$client.close(); });

for (const tipo of ["encontrado", "perdido"] as const) {
  test(`QR de ${tipo}: roles, cierre, historial, valoración y agradecimiento`, async () => {
    const path = fixture(tipo);
    const holder = tipo === "encontrado" ? 0 : 1, recipient = 1 - holder;
    expect((await api(path, holder)).data.rol).toBe("devuelve");
    expect((await api(path, recipient)).data.rol).toBe("recupera");
    const qr = await api(`${path}/qr`, holder, {});
    expect(qr.status).toBe(200);
    expect(qr.data.imagen).toStartWith("data:image/png;base64,");
    expect((await api(`${path}/confirmar`, recipient, { codigo: generated })).status).toBe(200);
    expect(db.select().from(posts).get()!.estado).toBe("resuelta");
    const devolvi = await api("/me/historial?tipo=devolvi", holder);
    const recupere = await api("/me/historial?tipo=recupere", recipient);
    expect(devolvi.data.items).toHaveLength(1);
    expect(recupere.data.items).toHaveLength(1);
    expect((await api("/publicaciones/post-1/valoraciones", recipient, { positiva: true })).status).toBe(201);
    expect((await api("/publicaciones/post-1/agradecimientos", recipient, { mensaje: "Gracias por devolver mis llaves." })).status).toBe(201);
  });
}

test("solo las partes ven el caso y los roles no pueden intercambiarse", async () => {
  const path = fixture();
  expect((await api(path, null)).status).toBe(401);
  expect((await api(path, 2)).status).toBe(403);
  expect((await api(`${path}/qr`, 1, {})).status).toBe(403);
  expect((await api(`${path}/qr`, 2, {})).status).toBe(403);
  await api(`${path}/qr`, 0, {});
  const codigo = generated;
  expect((await api(`${path}/confirmar`, 0, { codigo })).status).toBe(403);
  expect((await api(`${path}/confirmar`, 2, { codigo })).status).toBe(403);
  expect(db.select().from(posts).get()!.estado).toBe("en_reclamo");
});

test("rechaza QR ajenos, malformados o reemplazados sin cerrar el caso", async () => {
  const path = fixture();
  await api(`${path}/qr`, 0, {});
  const viejo = generated;
  await api(`${path}/qr`, 0, {});
  const vigente = generated;
  expect((await api(`${path}/confirmar`, 1, { codigo: viejo })).status).toBe(422);
  expect((await api(`${path}/confirmar`, 1, { codigo: "https://example.com" })).status).toBe(422);
  const otro = fixture("encontrado", "2");
  expect((await api(`${otro}/confirmar`, 1, { codigo: vigente })).status).toBe(422);
  expect(db.select().from(posts).all().every(p => p.estado === "en_reclamo")).toBe(true);
});

test("un QR vencido no cierra y puede reemplazarse", async () => {
  const path = fixture();
  await api(`${path}/qr`, 0, {});
  db.update(returnCodes).set({ expiresAt: "2000-01-01T00:00:00.000Z" }).run();
  expect((await api(`${path}/confirmar`, 1, { codigo: generated })).data.error.code).toBe("QR_EXPIRED");
  await api(`${path}/qr`, 0, {});
  expect((await api(`${path}/confirmar`, 1, { codigo: generated })).status).toBe(200);
});

test("reintentar una confirmación no cambia la fecha ni duplica avisos", async () => {
  const path = fixture();
  await api(`${path}/qr`, 0, {});
  const codigo = generated;
  await api(`${path}/confirmar`, 1, { codigo });
  const resolvedAt = db.select().from(posts).get()!.resolvedAt;
  const count = db.select().from(notifications).all().length;
  expect((await api(`${path}/confirmar`, 1, { codigo })).status).toBe(200);
  expect(db.select().from(posts).get()!.resolvedAt).toBe(resolvedAt);
  expect(db.select().from(notifications).all()).toHaveLength(count);
  expect((await api(`${path}/qr`, 0, {})).status).toBe(409);
});

test("rechazar y volver a aceptar un reclamo invalida el QR del intento anterior", async () => {
  const path = fixture();
  await api(`${path}/qr`, 0, {});
  const codigo = generated;
  db.update(claims).set({ estado: "rechazado" }).run();
  expect((await api(`${path}/confirmar`, 1, { codigo })).status).toBe(409);
  db.update(claims).set({ estado: "aceptado", intentos: 2 }).run();
  expect((await api(`${path}/confirmar`, 1, { codigo })).status).toBe(422);
});

test("no genera QR sin reclamo aceptado ni para una publicación eliminada", async () => {
  const path = fixture();
  db.update(claims).set({ estado: "pendiente" }).run();
  expect((await api(`${path}/qr`, 0, {})).status).toBe(409);
  db.update(claims).set({ estado: "aceptado" }).run();
  db.update(posts).set({ deletedAt: nowIso() }).where(eq(posts.id, "post-1")).run();
  expect((await api(`${path}/qr`, 0, {})).status).toBe(404);
});
