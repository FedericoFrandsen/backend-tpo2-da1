import { createApp } from "./app";
import { config } from "./config";
import type { AppDatabase } from "./database";
import { startBackgroundJobs } from "./jobs";
import { createPushDispatcher } from "./push";

/**
 * Levanta la API con el proceso de fondo (vencimiento de reclamos y push de Expo) y cierra todo en orden con
 * SIGINT/SIGTERM: deja de aceptar peticiones, espera el ciclo de fondo en curso y cierra la base.
 */
export function startServer(db: AppDatabase) {
  const push = config.pushMode === "expo" ? createPushDispatcher(db, { accessToken: config.expoAccessToken || undefined }) : undefined;
  const app = createApp(db, { push }).listen({ hostname: "0.0.0.0", port: config.port });
  const jobs = startBackgroundJobs(db, { intervalMs: config.backgroundIntervalSeconds * 1000, push });
  console.log(push ? "Push de Expo activado (reclamos, devoluciones y puntos de encuentro)." : "Push desactivado (PUSH_MODE=off): los avisos quedan en /notificaciones.");

  let closing: Promise<void> | null = null;
  const stop = () => closing ??= (async () => {
    await app.stop();
    await jobs.stop();
    db.$client.close();
  })();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`${signal}: cerrando el servidor...`);
      void stop().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
    });
  }
  return { app, jobs, stop };
}
