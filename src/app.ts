import { lte } from "drizzle-orm";
import { Elysia, ElysiaCustomStatusResponse } from "elysia";
import { config } from "./config";
import { createDatabase, type AppDatabase } from "./database";
import { otpCodes, sessions } from "./db/schema";
import { ApiError } from "./errors";
import { expireStaleOffers } from "./queries";
import { authRoutes } from "./routes/auth";
import { interactionRoutes } from "./routes/interactions";
import { publicationRoutes } from "./routes/publications";
import { userRoutes } from "./routes/users";
import { nowIso } from "./utils";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-max-age": "600",
};

// Consigna 1 (desbloqueo por biometría) y consigna 6 (modo sin conexión) no tienen contraparte
// en el backend: la biometría desbloquea localmente el token de sesión ya emitido (Android
// BiometricPrompt + Keystore) y el caché offline vive en el dispositivo (Room/SQLite local).
// Esta API ya expone todos los datos que ambos flujos necesitan cachear/proteger.

/** Índice de rutas que devuelve `GET /docs`, agrupado por área funcional. */
const ROUTE_INDEX = {
  authentication: [
    "POST /auth/otp/request",
    "POST /auth/otp/resend",
    "POST /auth/otp/verify",
    "POST /auth/login/password",
    "POST /auth/logout",
  ],
  profiles: ["GET /me", "PATCH /me", "GET /users/:id", "GET /users/:id/reviews"],
  publications: [
    "GET /categories",
    "GET /zones",
    "GET /publications",
    "GET /publications/:id",
    "POST /publications",
    "PATCH /publications/:id",
    "PATCH /publications/:id/status",
    "GET /me/publications",
    "POST /uploads/images",
    "GET /uploads/:filename",
  ],
  favorites: [
    "POST /publications/:id/favorite",
    "DELETE /publications/:id/favorite",
    "GET /me/favorites",
    "POST /me/favorites/read",
  ],
  savedSearches: [
    "POST /saved-searches",
    "GET /saved-searches",
    "POST /saved-searches/:id/read",
    "DELETE /saved-searches/:id",
  ],
  questions: ["POST /publications/:id/questions", "POST /questions/:id/answer"],
  offers: [
    "POST /publications/:id/offers",
    "POST /offers/:id/respond",
    "POST /offers/:id/respond-to-counter",
    "POST /offers/:id/cancel",
    "GET /offers/:id",
    "GET /me/offers",
    "POST /me/offers/read",
  ],
  operations: ["GET /me/operations", "GET /operations/:id", "POST /operations/:id/reviews"],
};

/** Descarta sesiones y códigos OTP vencidos: no aportan nada y sólo hacen crecer las tablas. */
function purgeExpiredRecords(db: AppDatabase) {
  const now = nowIso();
  db.delete(sessions).where(lte(sessions.expiresAt, now)).run();
  db.delete(otpCodes).where(lte(otpCodes.expiresAt, now)).run();
  // Consigna 7: barrido de arranque; el vencimiento real ocurre de forma perezosa en cada request (ver queries.ts).
  expireStaleOffers(db);
}

function requestDetails(request: Request) {
  const url = new URL(request.url);
  return {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
  };
}

function logResponse(request: Request, statusCode: number | string, response: unknown) {
  console.dir({
    type: "HTTP RESPONSE",
    ...requestDetails(request),
    status: statusCode,
    payload: response instanceof ElysiaCustomStatusResponse ? response.response : response,
  }, { depth: null });
}

export function createApp(db: AppDatabase = createDatabase()) {
  purgeExpiredRecords(db);

  return new Elysia()
    .error({ ApiError })
    .onRequest(({ set }) => {
      Object.assign(set.headers, CORS_HEADERS);
    })
    .onTransform({ as: "global" }, ({ request, body }) => {
      console.dir({
        type: "HTTP REQUEST",
        ...requestDetails(request),
        payload: body,
      }, { depth: null });
    })
    .onAfterHandle({ as: "global" }, ({ request, set, responseValue }) => {
      logResponse(request, set.status ?? 200, responseValue);
    })
    .onError(({ code, error, request, status }) => {
      if (error instanceof ApiError) {
        const response = status(error.statusCode, { error: { code: error.code, message: error.message } });
        logResponse(request, error.statusCode, response);
        return response;
      }
      if (code === "VALIDATION") {
        const response = status(422, {
          error: { code: "VALIDATION_ERROR", message: "Los datos enviados no son válidos" },
        });
        logResponse(request, 422, response);
        return response;
      }
      if (code === "NOT_FOUND") {
        const response = status(404, { error: { code: "ROUTE_NOT_FOUND", message: "Ruta no encontrada" } });
        logResponse(request, 404, response);
        return response;
      }

      console.error(error);
      const response = status(500, { error: { code: "INTERNAL_ERROR", message: "Error interno del servidor" } });
      logResponse(request, 500, response);
      return response;
    })
    .as("global")
    .options("/*", ({ status }) => status(204))
    .get("/", () => ({
      name: config.name,
      version: config.version,
      health: "/health",
      documentation: "/docs",
    }))
    .get("/health", () => ({ status: "ok", timestamp: nowIso() }))
    .get("/docs", () => ROUTE_INDEX)
    .use(authRoutes(db))
    .use(userRoutes(db))
    .use(publicationRoutes(db))
    .use(interactionRoutes(db));
}
