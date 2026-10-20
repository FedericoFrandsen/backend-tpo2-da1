import { createApp } from "./app";
import { config } from "./config";

export const app = createApp();
if (import.meta.main) {
  app.listen({ hostname: "0.0.0.0", port: config.port });
  console.log(`${config.name} v${config.version}: http://localhost:${config.port}`);
  console.log(`Documentación: http://localhost:${config.port}/docs`);
  console.log(config.emailMode === "console" ? "OTP de desarrollo: los códigos aparecen en esta consola." : "Envío de OTP por email activado.");
}
