import pkg from "../package.json";

function positiveInteger(name: string, fallback: number) {
  const raw = Bun.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} debe ser un número entero positivo.`);
  }
  return value;
}

const nodeEnv = Bun.env.NODE_ENV ?? "development";
const emailMode = Bun.env.EMAIL_MODE ?? "console";
if (!["console", "resend"].includes(emailMode)) {
  throw new Error("EMAIL_MODE debe ser console o resend.");
}
if (nodeEnv === "production" && emailMode === "console") {
  throw new Error("En producción configurá EMAIL_MODE=resend y las credenciales de envío.");
}
if (emailMode === "resend" && (!Bun.env.RESEND_API_KEY || !Bun.env.EMAIL_FROM)) {
  throw new Error("Para enviar emails faltan RESEND_API_KEY y/o EMAIL_FROM.");
}

export const config = {
  name: "Hallado API",
  version: pkg.version,
  port: positiveInteger("PORT", 3000),
  databasePath: Bun.env.DATABASE_PATH ?? "data/hallado.sqlite",
  uploadsPath: Bun.env.UPLOADS_PATH ?? "uploads",
  otpTtlMinutes: positiveInteger("OTP_TTL_MINUTES", 10),
  sessionDays: positiveInteger("SESSION_DAYS", 30),
  searchRadiusKm: positiveInteger("SEARCH_RADIUS_KM", 10),
  timeZone: Bun.env.APP_TIMEZONE ?? "America/Argentina/Buenos_Aires",
  emailMode,
  resendApiKey: Bun.env.RESEND_API_KEY ?? "",
  emailFrom: Bun.env.EMAIL_FROM ?? "",
  nodeEnv,
  isProduction: nodeEnv === "production",
} as const;
new Intl.DateTimeFormat("en", { timeZone: config.timeZone }).format();
