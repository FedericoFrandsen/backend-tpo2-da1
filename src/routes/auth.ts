import { randomInt } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import {
  bearerToken,
  deleteSession,
  requireUser,
  sha256,
} from "../auth";
import { config } from "../config";
import type { AppDatabase } from "../database";
import { loginAttempts, otpCodes, sessions, users } from "../db/schema";
import { ApiError } from "../errors";
import { normalizeEmail, nowIso } from "../utils";
import { privateProfile } from "../queries";
import { sendOtp, type OtpSender } from "../mailer";
import { PASSWORD_MAX_LENGTH, validarPassword } from "../validations/auth";

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

const otpCheckBody = t.Object({
  email: t.String({ format: "email", maxLength: 254 }),
  code: t.String({ pattern: "^[0-9]{6}$" }),
  purpose: purposeSchema,
});

const otpVerifyBody = t.Object({
  email: t.String({ format: "email", maxLength: 254 }),
  code: t.String({ pattern: "^[0-9]{6}$" }),
  purpose: purposeSchema,
  name: t.Optional(t.String({ minLength: 2, maxLength: 80 })),
  username: t.Optional(t.String({ pattern: "^[a-zA-Z0-9_.-]{3,30}$" })),
  password: t.Optional(t.String({ maxLength: PASSWORD_MAX_LENGTH })),
  phone: t.Optional(t.String({ minLength: 6, maxLength: 30 })),
  zone: t.Optional(t.String({ minLength: 2, maxLength: 100 })),
});

type OtpRequest = typeof otpRequestBody.static;
type OtpCheck = typeof otpCheckBody.static;
type OtpVerify = typeof otpVerifyBody.static;
type Otp = typeof otpCodes.$inferSelect;
type UserWriter = Pick<AppDatabase, "insert">;

function assertUsableOtp(otp: Otp | undefined) {
  if (!otp || otp.consumedAt || otp.expiresAt <= nowIso()) {
    throw new ApiError(
      400,
      "OTP_EXPIRED",
      "El código no existe o venció; solicitá uno nuevo",
    );
  }

  if (otp.attempts >= MAX_OTP_ATTEMPTS) {
    throw new ApiError(
      429,
      "OTP_LOCKED",
      "Demasiados intentos; solicitá un código nuevo",
    );
  }

  return otp;
}

async function issueOtp(db: AppDatabase, body: OtpRequest, deliver: OtpSender) {
  const email = normalizeEmail(body.email);
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const codeHash = await sha256(code);
  const createdAt = nowIso();
  const expiresAt = new Date(
    Date.now() + config.otpTtlMinutes * 60_000,
  ).toISOString();

  const id = crypto.randomUUID();
  const generado = db.transaction((tx) => {
    const existing = tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .get();

    if (body.purpose === "registration" && existing) {
      throw new ApiError(
        409,
        "EMAIL_ALREADY_REGISTERED",
        "El email ya está registrado",
      );
    }

    if (body.purpose !== "registration" && !existing) {
      return false;
    }

    const latest = tx
      .select({ createdAt: otpCodes.createdAt })
      .from(otpCodes)
      .where(and(eq(otpCodes.email, email), eq(otpCodes.purpose, body.purpose)))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1)
      .get();

    if (
      latest &&
      Date.now() - new Date(latest.createdAt).getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      throw new ApiError(
        429,
        "OTP_RATE_LIMIT",
        "Esperá 30 segundos antes de pedir otro código",
      );
    }

    tx.update(otpCodes)
      .set({ consumedAt: createdAt })
      .where(and(
        eq(otpCodes.email, email),
        eq(otpCodes.purpose, body.purpose),
        isNull(otpCodes.consumedAt),
      ))
      .run();

    tx.insert(otpCodes).values({
      id,
      email,
      purpose: body.purpose,
      codeHash,
      expiresAt,
      createdAt,
    }).run();

    return true;
  });

  if (generado) {
    try {
      await deliver({ email, code, purpose: body.purpose });
    } catch (error) {
      db.delete(otpCodes).where(eq(otpCodes.id, id)).run();
      throw error;
    }
  }

  return {
    message: body.purpose === "registration"
      ? (config.emailMode === "console" ? "Código generado. Revisá la consola del servidor." : "Código enviado por email.")
      : "Si el email corresponde a una cuenta, se generó un código de acceso.",
    expiresAt,
  };
}

async function verifyOtp(db: AppDatabase, email: string, body: OtpCheck) {
  const otp = assertUsableOtp(db
    .select()
    .from(otpCodes)
    .where(and(
      eq(otpCodes.email, email),
      eq(otpCodes.purpose, body.purpose),
      isNull(otpCodes.consumedAt),
    ))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1)
    .get());

  const codeHash = await sha256(body.code);
  const actual = assertUsableOtp(db
    .select()
    .from(otpCodes)
    .where(eq(otpCodes.id, otp.id))
    .get());

  if (codeHash !== actual.codeHash) {
    db.update(otpCodes)
      .set({ attempts: sql`${otpCodes.attempts} + 1` })
      .where(eq(otpCodes.id, actual.id))
      .run();

    throw new ApiError(400, "OTP_INVALID", "El código ingresado no es válido");
  }

  return actual.id;
}

function registerUser(
  db: UserWriter,
  email: string,
  body: OtpVerify,
  passwordHash: string,
) {
  const id = crypto.randomUUID();
  const createdAt = nowIso();

  try {
    db.insert(users).values({
      id,
      email,
      username: body.username?.toLowerCase() ?? null,
      passwordHash,
      name: body.name?.trim() || email.split("@")[0]!,
      phone: body.phone ?? null,
      zone: body.zone ?? null,
      createdAt,
      emailVerifiedAt: createdAt,
    }).run();
  } catch (error) {
    if (String(error).includes("users.username")) {
      throw new ApiError(409, "USERNAME_TAKEN", "Ese nombre de usuario ya está en uso");
    }
    if (String(error).includes("users.email")) {
      throw new ApiError(409, "EMAIL_ALREADY_REGISTERED", "El email ya está registrado");
    }
    throw error;
  }

  return id;
}

async function completeOtp(db: AppDatabase, body: OtpVerify) {
  if (body.purpose !== "login") {
    if (!body.password) {
      throw new ApiError(422, "PASSWORD_REQUIRED", "Falta la contraseña a guardar");
    }
    const error = validarPassword(body.password);
    if (error) {
      throw new ApiError(422, "INVALID_PASSWORD", error);
    }
  }

  const email = normalizeEmail(body.email);
  const otpId = await verifyOtp(db, email, body);
  const passwordHash = body.purpose !== "login" && body.password
    ? await Bun.password.hash(body.password)
    : null;

  const token = `${crypto.randomUUID()}.${crypto.randomUUID()}`;
  const tokenHash = await sha256(token);
  const createdAt = nowIso();
  const expiresAt = new Date(
    Date.now() + config.sessionDays * 86_400_000,
  ).toISOString();

  return db.transaction((tx) => {
    assertUsableOtp(tx.select().from(otpCodes).where(eq(otpCodes.id, otpId)).get());

    const existing = tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .get();

    let userId: string;

    if (body.purpose === "registration") {
      if (existing) {
        throw new ApiError(409, "EMAIL_ALREADY_REGISTERED", "El email ya está registrado");
      }
      if (!passwordHash) {
        throw new ApiError(422, "PASSWORD_REQUIRED", "Falta la contraseña a guardar");
      }
      userId = registerUser(tx, email, body, passwordHash);
    } else {
      if (!existing) {
        throw new ApiError(404, "USER_NOT_FOUND", "No se pudo completar la operación");
      }
      userId = existing.id;

      if (body.purpose === "set_password" && passwordHash) {
        tx.update(users).set({ passwordHash }).where(eq(users.id, userId)).run();
        tx.delete(sessions).where(eq(sessions.userId, userId)).run();
        tx.delete(loginAttempts).where(eq(loginAttempts.login, email)).run();
        tx.update(otpCodes).set({ consumedAt: createdAt })
          .where(and(eq(otpCodes.email, email), isNull(otpCodes.consumedAt))).run();
      }
    }

    tx.update(otpCodes).set({ consumedAt: createdAt }).where(eq(otpCodes.id, otpId)).run();
    tx.insert(sessions).values({
      id: crypto.randomUUID(),
      userId,
      tokenHash,
      expiresAt,
      createdAt,
    }).run();

    return { userId, session: { token, tokenType: "Bearer", expiresAt }, usuario: privateProfile(tx, userId) };
  });
}

export function authRoutes(db: AppDatabase, deliver: OtpSender = sendOtp) {
  return new Elysia({ prefix: "/auth" })
    .post("/otp/request", ({ body }) => issueOtp(db, body, deliver), {
      body: otpRequestBody,
    })
    .post("/otp/resend", ({ body }) => issueOtp(db, body, deliver), {
      body: otpRequestBody,
    })
    .post("/otp/check", async ({ body }) => {
      await verifyOtp(db, normalizeEmail(body.email), body);
      return { valid: true, message: "Código válido" };
    }, { body: otpCheckBody })
    .post("/otp/verify", ({ body }) => completeOtp(db, body), {
      body: otpVerifyBody,
    })
    .post("/login/password", async ({ body }) => {
      const login = normalizeEmail(body.email);
      const previous = db.select().from(loginAttempts).where(eq(loginAttempts.login, login)).get();
      if (previous && Date.now() - Date.parse(previous.windowStart) < 900_000 && previous.attempts >= 5) {
        throw new ApiError(429, "LOGIN_LOCKED", "Demasiados intentos. Esperá 15 minutos");
      }
      const user = db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(or(eq(users.email, login), eq(users.username, login)))
        .get();

      if (!user?.passwordHash || !(await Bun.password.verify(body.password, user.passwordHash))) {
        db.transaction((tx) => {
          const latest = tx.select().from(loginAttempts).where(eq(loginAttempts.login, login)).get();
          const sameWindow = latest && Date.now() - Date.parse(latest.windowStart) < 900_000;
          tx.insert(loginAttempts).values({ login, attempts: 1, windowStart: nowIso() }).onConflictDoUpdate({
            target: loginAttempts.login,
            set: { attempts: sameWindow ? latest.attempts + 1 : 1, windowStart: sameWindow ? latest.windowStart : nowIso() },
          }).run();
        });
        throw new ApiError(401, "INVALID_CREDENTIALS", "Usuario/email o contraseña incorrectos");
      }

      const token = `${crypto.randomUUID()}.${crypto.randomUUID()}`;
      const tokenHash = await sha256(token);
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + config.sessionDays * 86_400_000).toISOString();
      return db.transaction((tx) => {
        const current = tx.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id)).get();
        if (!current || current.passwordHash !== user.passwordHash) {
          throw new ApiError(401, "INVALID_CREDENTIALS", "La contraseña cambió; volvé a ingresar");
        }
        tx.delete(loginAttempts).where(eq(loginAttempts.login, login)).run();
        tx.insert(sessions).values({ id: crypto.randomUUID(), userId: user.id, tokenHash, expiresAt, createdAt }).run();
        return { userId: user.id, usuario: privateProfile(tx, user.id), session: { token, tokenType: "Bearer", expiresAt } };
      });
    }, {
      body: t.Object({
        email: t.String({ minLength: 3, maxLength: 254 }),
        password: t.String({ minLength: 8, maxLength: PASSWORD_MAX_LENGTH }),
      }),
    })
    .post("/logout", async ({ headers }) => {
      await requireUser(db, headers);
      await deleteSession(db, bearerToken(headers)!);
      return { message: "Sesión cerrada" };
    });
}
