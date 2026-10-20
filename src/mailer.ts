import { config } from "./config";
import { ApiError } from "./errors";
export type OtpDelivery = { email: string; code: string; purpose: string };
export type OtpSender = (message: OtpDelivery) => Promise<void>;
export const sendOtp: OtpSender = async ({ email, code, purpose }) => {
  if (config.emailMode === "console") {
    console.log(`[OTP] ${purpose} ${email}: ${code}`);
    return;
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: config.emailFrom, to: [email], subject: "Tu código de Hallado",
        text: `Tu código de Hallado es ${code}. Vence en ${config.otpTtlMinutes} minutos. Si no lo solicitaste, ignorá este mensaje.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Email provider status ${response.status}`);
  } catch {
    throw new ApiError(503, "EMAIL_DELIVERY_FAILED", "No pudimos enviar el email. Intentá nuevamente más tarde");
  }
};
