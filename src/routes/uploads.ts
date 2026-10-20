import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { requireUser } from "../auth";
import { config } from "../config";
import type { AppDatabase } from "../database";
import { uploads } from "../db/schema";
import { ApiError } from "../errors";
import { nowIso } from "../utils";

function detectImage(bytes: Uint8Array) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { ext: "jpg", mime: "image/jpeg" };
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return { ext: "png", mime: "image/png" };
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return { ext: "webp", mime: "image/webp" };
  throw new ApiError(422, "INVALID_IMAGE", "Solo se aceptan imágenes JPEG, PNG o WebP");
}
export function uploadRoutes(db: AppDatabase, directory = config.uploadsPath) {
  const root = resolve(directory);
  return new Elysia()
    .post("/uploads/images", async ({ headers, body, set }) => {
      const user = await requireUser(db, headers);
      const bytes = new Uint8Array(await body.file.arrayBuffer());
      const format = detectImage(bytes);
      const filename = `${crypto.randomUUID()}.${format.ext}`;
      await mkdir(root, { recursive: true });
      const target = Bun.file(resolve(root, filename));
      await Bun.write(target, bytes);
      try {
        db.insert(uploads).values({ filename, userId: user.id, contentType: format.mime, createdAt: nowIso() }).run();
      } catch (error) {
        await target.delete();
        throw error;
      }
      set.status = 201;
      return { url: `/uploads/${filename}`, filename };
    }, { body: t.Object({ file: t.File({ maxSize: "5m" }) }) })
    .get("/uploads/:filename", async ({ params }) => {
      if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(params.filename)) throw new ApiError(404, "IMAGE_NOT_FOUND", "Imagen no encontrada");
      const image = db.select().from(uploads).where(eq(uploads.filename, params.filename)).get();
      const file = Bun.file(resolve(root, params.filename));
      if (!image || !await file.exists()) throw new ApiError(404, "IMAGE_NOT_FOUND", "Imagen no encontrada");
      return new Response(file, { headers: {
        "Content-Type": image.contentType, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=86400",
      } });
    });
}
