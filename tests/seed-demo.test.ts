import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createDatabase } from "../src/database";
import { DEMO_PASSWORD, DEMO_PEOPLE, DEMO_POSTS, seedDemo } from "../src/db/seed-demo";
import { claims, halladoPublications as posts, halladoReviews, uploads, users } from "../src/db/schema";

let db: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createApp>;
let directory: string;
let tokens: string[];

async function api(path: string, method = "GET", body?: unknown, token?: string) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await app.handle(new Request(`http://localhost${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const data: any = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
  return { response, data };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "hallado-seed-demo-"));
  db = createDatabase(":memory:");
  await seedDemo(db, { uploadsPath: directory });
  app = createApp(db, { uploadsPath: directory });
  tokens = [];
  for (const person of DEMO_PEOPLE) {
    const { response, data } = await api("/auth/login/password", "POST", { email: person.email, password: DEMO_PASSWORD });
    expect(response.status).toBe(200);
    tokens.push(data.session.token);
  }
});

afterEach(() => {
  db.$client.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("seed de la demo de puntos 1, 4 y 5", () => {
  test("las cuentas ingresan y Sofía tiene los cuatro estados; Lucía tiene reputación real", async () => {
    const mine = await api("/mis-publicaciones", "GET", undefined, tokens[0]);
    expect(mine.data.total).toBe(4);
    expect(mine.data.items.map((p: any) => p.estado).sort()).toEqual(["abierta", "en_reclamo", "resuelta", "vencida"]);
    const profile = (await api(`/usuarios/${DEMO_PEOPLE[1].id}`)).data;
    expect(profile.reputation.completedReturns).toBe(5);
    expect(profile.reputation.positiveReviews).toBe(5);
    expect(JSON.stringify(profile)).toContain("Vecino solidario");
    expect(profile.phone).toBeUndefined();
    expect(db.select().from(posts).all()).toHaveLength(11);
    expect(db.$client.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("todas las imágenes se sirven desde uploads y la galería tiene dos vistas distintas", async () => {
    const detail = (await api(`/publicaciones/${DEMO_POSTS.encontrado}`)).data;
    expect(detail.fotos).toHaveLength(2);
    const bytes: Uint8Array[] = [];
    for (const image of db.select().from(uploads).all()) {
      const response = await app.handle(new Request(`http://localhost/uploads/${image.filename}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      const content = new Uint8Array(await response.arrayBuffer());
      expect([...content.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      if (detail.fotos.includes(`/uploads/${image.filename}`)) bytes.push(content);
    }
    expect(bytes).toHaveLength(2);
    expect(Buffer.compare(Buffer.from(bytes[0]!), Buffer.from(bytes[1]!))).not.toBe(0);
  });

  test("el hallazgo permite seguir, reclamar y revelar la dirección solo a quien fue aceptado", async () => {
    const path = `/publicaciones/${DEMO_POSTS.encontrado}`;
    const before = (await api(path, "GET", undefined, tokens[0])).data;
    expect(before.estado).toBe("abierta");
    expect(before.direccionExacta).toBeNull();
    expect(before.respuestaVerificacion).toBeUndefined();
    expect((await api(`${path}/seguir`, "POST", undefined, tokens[0])).response.status).toBe(200);
    const claim = await api(`${path}/reclamos`, "POST", { respuestaVerificacion: "Nube" }, tokens[0]);
    expect(claim.response.status).toBe(201);
    expect((await api(path, "GET", undefined, tokens[0])).data.direccionExacta).toBeNull();
    expect((await api(`/reclamos/${claim.data.id}/aceptar`, "POST", undefined, tokens[1])).response.status).toBe(200);
    const after = (await api(path, "GET", undefined, tokens[0])).data;
    expect(after.estado).toBe("en_reclamo");
    expect(after.direccionExacta).toContain("Santa Fe 4100");
    expect(after.respuestaVerificacion).toBeUndefined();
    expect((await api(path, "GET", undefined, tokens[2])).data.direccionExacta).toBeNull();
  });

  test("la campera está vencida por plazo real y vuelve a abierta al renovar", async () => {
    const path = `/publicaciones/${DEMO_POSTS.vencida}`;
    const before = (await api(path, "GET", undefined, tokens[0])).data;
    expect(before.estado).toBe("vencida");
    expect(Date.parse(before.venceAt)).toBeLessThan(Date.now());
    const renewed = await api(`${path}/renovar`, "POST", undefined, tokens[0]);
    expect(renewed.response.status).toBe(200);
    expect(renewed.data.estado).toBe("abierta");
    expect(Date.parse(renewed.data.venceAt)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  test("editar fotos de la propia publicación funciona con la propiedad real de los uploads", async () => {
    const path = `/publicaciones/${DEMO_POSTS.abierta}`;
    const original = (await api(path, "GET", undefined, tokens[0])).data;
    const edit = await api(path, "PATCH", { titulo: "Billetera marrón con cierre", fotos: original.fotos }, tokens[0]);
    expect(edit.response.status).toBe(200);
    expect(edit.data.titulo).toBe("Billetera marrón con cierre");
  });

  test("completa placeholders de ejemplos viejos y nuevos sin tocar fotos elegidas ni publicaciones personales", async () => {
    const original = db.select().from(posts).where(eq(posts.id, DEMO_POSTS.abierta)).get()!;
    for (const [id, categoria] of [["demo-0-0-encontrado-0", "Documentos"], ["demo-3-0-encontrado-0", "Mascotas"]] as const) {
      db.insert(posts).values({ ...original, id, categoria, fotos: [] }).run();
    }
    db.insert(posts).values({ ...original, id: "alta-personal-sin-foto", fotos: [] }).run();
    db.update(posts).set({ fotos: [], titulo: "Título editado que se conserva" }).where(eq(posts.id, original.id)).run();
    const kept = db.select().from(posts).where(eq(posts.id, DEMO_POSTS.encontrado)).get()!;
    await seedDemo(db, { uploadsPath: directory });
    for (const id of [original.id, "demo-0-0-encontrado-0", "demo-3-0-encontrado-0"]) {
      const row = db.select().from(posts).where(eq(posts.id, id)).get()!;
      expect(row.fotos.length).toBeGreaterThan(0);
      for (const photo of row.fotos) {
        const image = db.select().from(uploads).where(eq(uploads.filename, photo.slice(9))).get()!;
        expect(image.userId).toBe(row.userId);
        expect((await app.handle(new Request(`http://localhost${photo}`))).status).toBe(200);
      }
    }
    expect(db.select().from(posts).where(eq(posts.id, original.id)).get()!.titulo).toBe("Título editado que se conserva");
    expect(db.select().from(posts).where(eq(posts.id, kept.id)).get()!.fotos).toEqual(kept.fotos);
    expect(db.select().from(posts).where(eq(posts.id, "alta-personal-sin-foto")).get()!.fotos).toEqual([]);
  });

  test("repetir el seed conserva la contraseña cambiada, la renovación y los datos ajenos", async () => {
    const newHash = await Bun.password.hash("OtraClave123");
    db.update(users).set({ passwordHash: newHash, email: "demo@hallado.com" })
      .where(eq(users.id, DEMO_PEOPLE[0].id)).run();
    db.insert(users).values({ id: "persona-ajena", email: "ajena@example.com", name: "Cuenta ajena",
      passwordHash: newHash, createdAt: new Date().toISOString(), emailVerifiedAt: new Date().toISOString(),
    }).run();
    const renewed = (await api(`/publicaciones/${DEMO_POSTS.vencida}/renovar`, "POST", undefined, tokens[0])).data;
    const before = { posts: db.select().from(posts).all(), claims: db.select().from(claims).all(),
      reviews: db.select().from(halladoReviews).all(), uploads: db.select().from(uploads).all() };
    await seedDemo(db, { uploadsPath: directory, now: new Date(Date.now() + 3 * 86_400_000) });
    expect(db.select().from(posts).all()).toEqual(before.posts);
    expect(db.select().from(claims).all()).toEqual(before.claims);
    expect(db.select().from(halladoReviews).all()).toEqual(before.reviews);
    expect(db.select().from(uploads).all()).toEqual(before.uploads);
    expect((await api(`/publicaciones/${DEMO_POSTS.vencida}`, "GET", undefined, tokens[0])).data.venceAt).toBe(renewed.venceAt);
    expect(db.select().from(users).where(eq(users.id, "persona-ajena")).get()).toBeDefined();
    expect(db.select().from(users).where(eq(users.email, "demo@hallado.com")).get()).toBeUndefined();
    expect(db.select().from(users).all()).toHaveLength(4);
    expect((await api("/auth/login/password", "POST", { email: DEMO_PEOPLE[0].email, password: "OtraClave123" })).response.status).toBe(200);
    expect((await api("/auth/login/password", "POST", { email: DEMO_PEOPLE[0].email, password: DEMO_PASSWORD })).response.status).toBe(401);
  });
});
