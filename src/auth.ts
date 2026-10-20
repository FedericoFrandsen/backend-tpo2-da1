import { and, eq, gt } from "drizzle-orm";
import type { AppDatabase } from "./database";
import { sessions, users } from "./db/schema";
import { ApiError } from "./errors";
import { nowIso } from "./utils";

/** Headers tal como los entrega Elysia. */
export type RequestHeaders = Record<string, string | undefined>;

const authUserColumns = {
  id: users.id,
  email: users.email,
  username: users.username,
  name: users.name,
  phone: users.phone,
  zone: users.zone,
  avatarUrl: users.avatarUrl,
  createdAt: users.createdAt,
};

export type AuthUser = {
  id: string;
  email: string;
  username: string | null;
  name: string;
  phone: string | null;
  zone: string | null;
  avatarUrl: string | null;
  createdAt: string;
};

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bearerToken(headers: RequestHeaders) {
  const authorization = headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice(7).trim() || null;
}

/** Devuelve el usuario de la sesión, o `null` si no hay token o la sesión venció. */
export async function optionalUser(db: AppDatabase, headers: RequestHeaders): Promise<AuthUser | null> {
  const token = bearerToken(headers);
  if (!token) return null;
  const tokenHash = await sha256(token);
  return db
    .select(authUserColumns)
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, nowIso())))
    .get() ?? null;
}

/** Igual que `optionalUser`, pero corta la request con 401 si no hay sesión válida. */
export async function requireUser(db: AppDatabase, headers: RequestHeaders): Promise<AuthUser> {
  if (!bearerToken(headers)) throw new ApiError(401, "UNAUTHORIZED", "Falta el token Bearer");
  const user = await optionalUser(db, headers);
  if (!user) throw new ApiError(401, "INVALID_SESSION", "La sesión no existe o venció");
  return user;
}

export async function createSession(db: AppDatabase, userId: string, sessionDays: number) {
  const token = `${crypto.randomUUID()}.${crypto.randomUUID()}`;
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + sessionDays * 86_400_000).toISOString();
  db.insert(sessions)
    .values({ id: crypto.randomUUID(), userId, tokenHash: await sha256(token), expiresAt, createdAt })
    .run();
  return { token, tokenType: "Bearer", expiresAt };
}

export async function deleteSession(db: AppDatabase, token: string) {
  db.delete(sessions).where(eq(sessions.tokenHash, await sha256(token))).run();
}
