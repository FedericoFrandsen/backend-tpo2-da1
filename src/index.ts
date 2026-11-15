import { config } from "./config";
import { createDatabase } from "./database";
import { startServer } from "./server";

if (import.meta.main) {
  startServer(createDatabase());
  console.log(`${config.name} v${config.version}: http://localhost:${config.port}`);
  console.log(`Documentación: http://localhost:${config.port}/docs`);
  console.log(config.emailMode === "console" ? "OTP de desarrollo: los códigos aparecen en esta consola." : "Envío de OTP por email activado.");
}
