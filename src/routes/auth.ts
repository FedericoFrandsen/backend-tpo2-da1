import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import {
  bearerToken,
  createSession,
  deleteSession,
  requireUser,
  sha256,
} from "../auth";
import { config } from "../config";
import type { AppDatabase } from "../database";
import { otpCodes, users } from "../db/schema";
import { ApiError } from "../errors";
import { normalizeEmail, nowIso } from "../utils";

const MAX_OTP_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 30_000;

const purposeSchema = t.Union([
  t.Literal("registration"),
  t.Literal("login"),
  t.Literal("set_password"),
]);

const otpRequestBody = t.Object({
  email: t.String({ format: "email", maxLength: 254 }),
  purpose: purposeSchema,
});

const otpVerifyBody = t.Object({
  email: t.String({ format: "email", maxLength: 254 }),
  code: t.String({ pattern: "^[0-9]{6}$" }),
  purpose: purposeSchema,
  name: t.Optional(t.String({ minLength: 2, maxLength: 80 })),
  username: t.Optional(t.String({ pattern: "^[a-zA-Z0-9_.-]{3,30}$" })),
  password: t.Optional(t.String({ minLength: 8, maxLength: 72 })),
  phone: t.Optional(t.String({ minLength: 6, maxLength: 30 })),
  zone: t.Optional(t.String({ minLength: 2, maxLength: 100 })),
});

type OtpRequest = typeof otpRequestBody.static;
type OtpVerify = typeof otpVerifyBody.static;

const sixDigitCode = () =>
  (crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000)
    .toString()
    .padStart(6, "0");

/**
 * Emite un OTP nuevo e invalida los anteriores del mismo email y propósito.
 * Todavía no hay envío de email: fuera de producción el código se loguea por consola.
 */
async function issueOtp(db: AppDatabase, body: OtpRequest) {
  const email = normalizeEmail(body.email);
  const existing = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .get();
  if (body.purpose === "registration" && existing)
    throw new ApiError(
      409,
      "EMAIL_ALREADY_REGISTERED",
      "El email ya está registrado",
    );
  if ((body.purpose === "login" || body.purpose === "set_password") && !existing)
    throw new ApiError(
      404,
      "USER_NOT_FOUND",
      "No existe una cuenta con ese email",
    );

  const latest = db
    .select({ createdAt: otpCodes.createdAt })
    .from(otpCodes)
    .where(and(eq(otpCodes.email, email), eq(otpCodes.purpose, body.purpose)))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1)
    .get();
  if (
    latest &&
    Date.now() - new Date(latest.createdAt).getTime() < OTP_RESEND_COOLDOWN_MS
  )
    throw new ApiError(
      429,
      "OTP_RATE_LIMIT",
      "Esperá 30 segundos antes de pedir otro código",
    );

  const code = sixDigitCode();
  const createdAt = nowIso();
  const expiresAt = new Date(
    Date.now() + config.otpTtlMinutes * 60_000,
  ).toISOString();
  db.update(otpCodes)
    .set({ consumedAt: createdAt })
    .where(
      and(
        eq(otpCodes.email, email),
        eq(otpCodes.purpose, body.purpose),
        isNull(otpCodes.consumedAt),
      ),
    )
    .run();
  db.insert(otpCodes)
    .values({
      id: crypto.randomUUID(),
      email,
      purpose: body.purpose,
      codeHash: await sha256(code),
      expiresAt,
      createdAt,
    })
    .run();

  // Todavía no hay envío de email: fuera de producción el código se loguea por consola.
  if (!config.isProduction) console.log(`[OTP] ${body.purpose} ${email}: ${code}`);

  return { message: "Código enviado", expiresAt };
}

/** Valida el último OTP vigente del email. Devuelve su id para consumirlo recién al final del flujo. */
async function verifyOtp(db: AppDatabase, email: string, body: OtpVerify) {
  const otp = db
    .select({
      id: otpCodes.id,
      codeHash: otpCodes.codeHash,
      attempts: otpCodes.attempts,
      expiresAt: otpCodes.expiresAt,
    })
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.email, email),
        eq(otpCodes.purpose, body.purpose),
        isNull(otpCodes.consumedAt),
      ),
    )
    .orderBy(desc(otpCodes.createdAt))
    .limit(1)
    .get();

  if (!otp || otp.expiresAt <= nowIso())
    throw new ApiError(
      400,
      "OTP_EXPIRED",
      "El código no existe o venció; solicitá uno nuevo",
    );
  if (otp.attempts >= MAX_OTP_ATTEMPTS)
    throw new ApiError(
      429,
      "OTP_LOCKED",
      "Demasiados intentos; solicitá un código nuevo",
    );
  if ((await sha256(body.code)) !== otp.codeHash) {
    db.update(otpCodes)
      .set({ attempts: sql`${otpCodes.attempts} + 1` })
      .where(eq(otpCodes.id, otp.id))
      .run();
    throw new ApiError(400, "OTP_INVALID", "El código ingresado no es válido");
  }
  return otp.id;
}

async function registerUser(db: AppDatabase, email: string, body: OtpVerify) {
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  try {
    db.insert(users)
      .values({
        id,
        email,
        username: body.username?.toLowerCase() ?? null,
        passwordHash: body.password
          ? await Bun.password.hash(body.password)
          : null,
        name: body.name ?? email.split("@")[0]!,
        phone: body.phone ?? null,
        zone: body.zone ?? null,
        createdAt,
        emailVerifiedAt: createdAt,
      })
      .run();
  } catch (error) {
    if (String(error).includes("users.username"))
      throw new ApiError(
        409,
        "USERNAME_TAKEN",
        "Ese nombre de usuario ya está en uso",
      );
    throw error;
  }
  return id;
}

export function authRoutes(db: AppDatabase) {
  return new Elysia({ prefix: "/auth" })
    // Consigna 1: "Solicitar email → enviar código de validación (OTP)".
    .post("/otp/request", ({ body }) => issueOtp(db, body), {
      body: otpRequestBody,
    })
    // Consigna 1: "Recupero de acceso: reenviar el código en caso de no haberlo recibido o de
    // que haya expirado" (misma lógica que /otp/request: invalida el anterior y emite uno nuevo).
    .post("/otp/resend", ({ body }) => issueOtp(db, body), {
      body: otpRequestBody,
    })
    // Consigna 1: "confirmar y crear sesión" (registro) / login alternativo por OTP.
    // También se reusa para agregarle contraseña a una cuenta que se registró sin una
    // (purpose "set_password"): el OTP prueba que el email sigue siendo del dueño de la cuenta.
    .post(
      "/otp/verify",
      async ({ body }) => {
        const email = normalizeEmail(body.email);
        const otpId = await verifyOtp(db, email, body);
        const existing = db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .get();

        let userId: string;
        if (body.purpose === "registration") {
          if (existing)
            throw new ApiError(
              409,
              "EMAIL_ALREADY_REGISTERED",
              "El email ya está registrado",
            );
          userId = await registerUser(db, email, body);
        } else if (body.purpose === "set_password") {
          if (!existing)
            throw new ApiError(
              404,
              "USER_NOT_FOUND",
              "No existe una cuenta con ese email",
            );
          if (!body.password)
            throw new ApiError(
              422,
              "PASSWORD_REQUIRED",
              "Falta la contraseña a guardar",
            );
          db.update(users)
            .set({ passwordHash: await Bun.password.hash(body.password) })
            .where(eq(users.id, existing.id))
            .run();
          userId = existing.id;
        } else {
          if (!existing)
            throw new ApiError(
              404,
              "USER_NOT_FOUND",
              "No existe una cuenta con ese email",
            );
          userId = existing.id;
        }

        db.update(otpCodes)
          .set({ consumedAt: nowIso() })
          .where(eq(otpCodes.id, otpId))
          .run();
        return {
          userId,
          session: await createSession(db, userId, config.sessionDays),
        };
      },
      { body: otpVerifyBody },
    )
    // Consigna 1: "Login mediante usuario y contraseña".
    .post(
      "/login/password",
      async ({ body }) => {
        const login = body.email.trim().toLowerCase();
        const user = db
          .select({ id: users.id, passwordHash: users.passwordHash })
          .from(users)
          .where(or(eq(users.email, login), eq(users.username, login)))
          .get();
        if (
          !user?.passwordHash ||
          !(await Bun.password.verify(body.password, user.passwordHash))
        )
          throw new ApiError(
            401,
            "INVALID_CREDENTIALS",
            "Usuario/email o contraseña incorrectos",
          );
        return {
          userId: user.id,
          session: await createSession(db, user.id, config.sessionDays),
        };
      },
      {
        body: t.Object({
          email: t.String({ minLength: 3 }),
          password: t.String({ minLength: 8, maxLength: 72 }),
        }),
      },
    )
    .post("/logout", async ({ headers }) => {
      await requireUser(db, headers);
      await deleteSession(db, bearerToken(headers)!);
      return { message: "Sesión cerrada" };
    });
}
