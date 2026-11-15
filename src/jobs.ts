import type { AppDatabase } from "./database";
import type { PushDispatcher } from "./push";
import { expirePendingClaims } from "./queries";

export type BackgroundJobsOptions = {
  intervalMs: number;
  /** Sin despachador (PUSH_MODE=off) solo se vencen reclamos; sus avisos quedan en la bandeja HTTP. */
  push?: PushDispatcher;
  logger?: Pick<Console, "error">;
};

/**
 * Proceso de fondo del servidor: vence reclamos pendientes de más de 48 h (y encola su aviso) aunque no llegue ninguna
 * petición, envía los push pendientes o por reintentar y consulta recibos de Expo. Corre un ciclo al arrancar y luego
 * cada `intervalMs`; nunca superpone ciclos. `stop()` frena el temporizador y espera el ciclo en curso.
 */
export function startBackgroundJobs(db: AppDatabase, options: BackgroundJobsOptions) {
  const logger = options.logger ?? console;
  let current: Promise<void> | null = null;
  let stopped = false;

  async function runCycle() {
    try {
      db.transaction((tx) => expirePendingClaims(tx));
    } catch (error) {
      logger.error(`[jobs] Error al vencer reclamos: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (options.push) {
      try { await options.push.cycle(); } catch (error) {
        logger.error(`[jobs] Error al despachar push: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  function tick() {
    if (stopped || current) return current ?? Promise.resolve();
    current = runCycle().finally(() => { current = null; });
    return current;
  }

  const timer = setInterval(tick, options.intervalMs);
  const first = tick();
  return {
    /** Ejecuta un ciclo ya (o espera el que está en curso). */
    runOnce: () => tick(),
    started: first,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (current) await current;
      await options.push?.idle();
    },
  };
}
export type BackgroundJobs = ReturnType<typeof startBackgroundJobs>;
