import { and, eq, isNull } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { requireUser } from "../auth";
import { config } from "../config";
import type { AppDatabase } from "../database";
import { claims, halladoPublications as posts, uploads } from "../db/schema";
import { ApiError } from "../errors";
import { nowIso } from "../utils";

function detectImage(bytes: Uint8Array) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { ext: "jpg", mime: "image/jpeg" };
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return { ext: "png", mime: "image/png" };
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return { ext: "webp", mime: "image/webp" };
  throw new ApiError(422, "INVALID_IMAGE", "Solo se aceptan imágenes JPEG, PNG o WebP");
}
const FILENAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
export function uploadRoutes(db: AppDatabase, directory = config.uploadsPath) {
  const root = resolve(directory);
  // Las pruebas de comprobación viven en otro directorio y nunca se sirven por /uploads/:filename.
  const proofRoot = resolve(root, "pruebas");
  async function save(userId: string, file: File, tipo: "imagen" | "prueba") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const format = detectImage(bytes);
    const filename = `${crypto.randomUUID()}.${format.ext}`;
    const folder = tipo === "prueba" ? proofRoot : root;
    await mkdir(folder, { recursive: true });
    const target = Bun.file(resolve(folder, filename));
    await Bun.write(target, bytes);
    try {
      db.insert(uploads).values({ filename, userId, contentType: format.mime, tipo, createdAt: nowIso() }).run();
    } catch (error) {
      await target.delete();
      throw error;
    }
    return filename;
  }
  return new Elysia()
    .post("/uploads/images", async ({ headers, body, set }) => {
      const user = await requireUser(db, headers);
      const filename = await save(user.id, body.file, "imagen");
      set.status = 201;
      return { url: `/uploads/${filename}`, filename };
    }, { body: t.Object({ file: t.File({ maxSize: "5m" }) }) })
    .post("/uploads/pruebas", async ({ headers, body, set }) => {
      const user = await requireUser(db, headers);
      const filename = await save(user.id, body.file, "prueba");
      set.status = 201;
      return { url: `/uploads/pruebas/${filename}`, filename };
    }, { body: t.Object({ file: t.File({ maxSize: "5m" }) }) })
    .get("/uploads/pruebas/:filename", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      if (!FILENAME.test(params.filename)) throw new ApiError(404, "PROOF_NOT_FOUND", "Prueba no encontrada");
      const proof = db.select().from(uploads).where(and(eq(uploads.filename, params.filename), eq(uploads.tipo, "prueba"))).get();
      const file = Bun.file(resolve(proofRoot, params.filename));
      if (!proof || !await file.exists()) throw new ApiError(404, "PROOF_NOT_FOUND", "Prueba no encontrada");
      // Solo quien la subió o el dueño de la publicación sobre la que se hizo un reclamo que la referencia.
      const shared = proof.userId === user.id || db.select({ id: claims.id }).from(claims)
        .innerJoin(posts, eq(posts.id, claims.publicationId))
        .where(and(eq(claims.fotoPrueba, `/uploads/pruebas/${params.filename}`), eq(posts.userId, user.id), isNull(posts.deletedAt))).get();
      if (!shared) throw new ApiError(403, "FORBIDDEN", "No tenés acceso a esta prueba");
      return new Response(file, { headers: {
        "Content-Type": proof.contentType, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
      } });
    })
    .get("/uploads/:filename", async ({ params }) => {
      if (!FILENAME.test(params.filename)) throw new ApiError(404, "IMAGE_NOT_FOUND", "Imagen no encontrada");
      const image = db.select().from(uploads).where(and(eq(uploads.filename, params.filename), eq(uploads.tipo, "imagen"))).get();
      const file = Bun.file(resolve(root, params.filename));
      if (!image || !await file.exists()) throw new ApiError(404, "IMAGE_NOT_FOUND", "Imagen no encontrada");
      return new Response(file, { headers: {
        "Content-Type": image.contentType, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=86400",
      } });
    });
}
