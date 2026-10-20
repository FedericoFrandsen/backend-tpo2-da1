import { createApp } from "./app";
import { config } from "./config";

export const app = createApp();

if (import.meta.main) {
  app.listen({
    hostname: "0.0.0.0",
    port: config.port,
  });
  console.log(
    `${config.name} v${config.version} disponible en http://localhost:${config.port}`,
  );
}
