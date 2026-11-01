import { config } from "../config";
import { createDatabase } from "../database";
import { seedDemo } from "./seed-demo";

if (import.meta.main) {
  if (config.isProduction) throw new Error("El seed de demostración solo se ejecuta fuera de producción.");
  const db = createDatabase();
  try {
    await seedDemo(db, { uploadsPath: config.uploadsPath });
    console.log("Demo de los puntos 1, 4 y 5 cargada sin sobrescribir registros existentes.");
    console.log("Cuentas nuevas: sofia@hallado.com, lucia@hallado.com, martin@hallado.com / Hallado123");
    console.log("Para una grabación limpia y separada de tus datos: bun run demo:reset y bun run demo");
  } finally {
    db.$client.close();
  }
}
