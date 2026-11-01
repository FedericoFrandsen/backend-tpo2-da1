import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Las importaciones dinámicas hacen que la app lea estas rutas y nunca las de la base habitual.
if (Bun.env.NODE_ENV === "production") throw new Error("La demo no se ejecuta en producción.");
const project = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(project, "data/demo-145");
const current = join(root, "toma-actual.txt");
let take = Bun.argv.includes("--new-take") ? "" : await readFile(current, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
  return "";
});
if (take && !/^[a-zA-Z0-9-]+$/.test(take)) throw new Error("Nombre de toma inválido en data/demo-145/toma-actual.txt.");
if (!take) take = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
const directory = join(root, take);
await mkdir(directory, { recursive: true });
Bun.env.DATABASE_PATH = join(directory, "hallado.sqlite");
Bun.env.UPLOADS_PATH = join(directory, "uploads");
const { createDatabase } = await import("../src/database");
const { seedDemo } = await import("../src/db/seed-demo");
const { config } = await import("../src/config");
const db = createDatabase();
try {
  await seedDemo(db, { uploadsPath: config.uploadsPath });
  await writeFile(current, take, "utf8");
  console.log(`Demo 1, 4 y 5. Toma: ${take}`);
  console.log(`Base: ${config.databasePath}`);
  console.log("Usuarios: sofia@hallado.com (Sofía), lucia@hallado.com, martin@hallado.com");
  console.log("Contraseña inicial: Hallado123. Guion: docs/DEMO-145.md");
  if (Bun.argv.includes("--prepare-only")) {
    db.$client.close();
  } else {
    const { createApp } = await import("../src/app");
    createApp(db).listen({ hostname: "0.0.0.0", port: config.port });
    console.log(`API de demo: http://localhost:${config.port}`);
    console.log(config.emailMode === "console" ? "OTP de ensayo: leelos en esta terminal; no se envía email." : "Envío de OTP por email activado.");
  }
} catch (error) {
  db.$client.close();
  throw error;
}
