import pkg from "../package.json";

function envNumber(name: string, fallback: number) {
  const raw = Bun.env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `La variable ${name} debe ser un número positivo.`
    );
  }

  return parsed;
}

const nodeEnv = Bun.env.NODE_ENV ?? "development";

export const config = {
  name: "Hallado API",
  version: pkg.version,
  port: envNumber("PORT", 3000),
  databasePath: Bun.env.DATABASE_PATH ?? "data/hallado.sqlite",
  otpTtlMinutes: envNumber("OTP_TTL_MINUTES", 10),
  sessionDays: envNumber("SESSION_DAYS", 30),
  offerTtlDays: envNumber("OFFER_TTL_DAYS", 3),
  nodeEnv,
  isProduction: nodeEnv === "production",
} as const;