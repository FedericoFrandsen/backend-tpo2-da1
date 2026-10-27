import { lte } from "drizzle-orm";
import { Elysia } from "elysia";
import { config } from "./config";
import { createDatabase, type AppDatabase } from "./database";
import { otpCodes, sessions } from "./db/schema";
import { ApiError } from "./errors";
import { sendOtp, type OtpSender } from "./mailer";
import { authRoutes } from "./routes/auth";
import { encounterRoutes } from "./routes/encounters";
import { interactionRoutes } from "./routes/interactions";
import { publicationRoutes } from "./routes/publications";
import { searchRoutes } from "./routes/searches";
import { uploadRoutes } from "./routes/uploads";
import { userRoutes } from "./routes/users";
import { nowIso } from "./utils";
import documentation from "../api-endpoints.json";

export function createApp(db: AppDatabase = createDatabase(), options: { sendOtp?: OtpSender; uploadsPath?: string } = {}) {
  db.delete(sessions).where(lte(sessions.expiresAt, nowIso())).run();
  db.delete(otpCodes).where(lte(otpCodes.expiresAt, nowIso())).run();
  return new Elysia({ serve: { maxRequestBodySize: 6 * 1024 * 1024 } })
    .error({ ApiError })
    .onRequest(({ set }) => {
      Object.assign(set.headers, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "access-control-max-age": "600",
        "x-content-type-options": "nosniff",
      });
    })
    .onError(({ code, error, status }) => {
      if (error instanceof ApiError) return status(error.statusCode, { error: { code: error.code, message: error.message } });
      if (code === "VALIDATION") return status(422, { error: { code: "VALIDATION_ERROR", message: "Los datos enviados no son válidos" } });
      if (code === "PARSE") return status(400, { error: { code: "INVALID_JSON", message: "El cuerpo de la solicitud no es JSON válido" } });
      if (code === "NOT_FOUND") return status(404, { error: { code: "ROUTE_NOT_FOUND", message: "Ruta no encontrada" } });
      console.error("Error interno de la API:", error instanceof Error ? error.message : "Error desconocido");
      return status(500, { error: { code: "INTERNAL_ERROR", message: "Error interno del servidor" } });
    })
    .as("global")
    .options("/*", ({ status }) => status(204))
    .get("/", () => ({ name: config.name, version: config.version, health: "/health", documentation: "/docs" }))
    .get("/health", () => ({ status: "ok", timestamp: nowIso() }))
    .get("/docs", () => documentation)
    .use(authRoutes(db, options.sendOtp ?? sendOtp))
    .use(userRoutes(db))
    .use(publicationRoutes(db))
    .use(interactionRoutes(db))
    .use(encounterRoutes(db))
    .use(searchRoutes(db))
    .use(uploadRoutes(db, options.uploadsPath ?? config.uploadsPath));
}
