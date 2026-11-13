import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import QRCode from "qrcode";
import { requireUser, sha256 } from "../auth";
import type { AppDatabase, Store } from "../database";
import { returnCodes } from "../db/schema";
import { ApiError } from "../errors";
import { getClaim, getPost } from "../queries";
import { completeReturn } from "../returns";
import { nowIso } from "../utils";

function participants(db: Store, claimId: string, userId: string) {
  const c = getClaim(db, claimId);
  const p = getPost(db, c.publicationId);
  if (userId !== p.userId && userId !== c.userId) throw new ApiError(403, "FORBIDDEN", "No participás de esta devolución");
  if (c.estado !== "aceptado" || !["en_reclamo", "resuelta"].includes(p.estado)) {
    throw new ApiError(409, "CLAIM_NOT_ACCEPTED", "La devolución necesita un reclamo aceptado");
  }
  const holder = p.tipo === "encontrado" ? p.userId : c.userId;
  const recipient = p.tipo === "encontrado" ? c.userId : p.userId;
  return { c, p, holder, recipient };
}

export function returnRoutes(db: AppDatabase) {
  return new Elysia()
    .get("/reclamos/:id/devolucion", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      const { p, holder } = participants(db, params.id, user.id);
      return { publicacionId: p.id, titulo: p.titulo, estado: p.estado, rol: user.id === holder ? "devuelve" : "recupera" };
    })
    .post("/reclamos/:id/devolucion/qr", async ({ headers, params, set }) => {
      const user = await requireUser(db, headers);
      const initial = participants(db, params.id, user.id);
      if (user.id !== initial.holder) throw new ApiError(403, "NOT_HOLDER", "Solo quien devuelve puede mostrar el QR");
      if (initial.p.estado === "resuelta") throw new ApiError(409, "RETURN_COMPLETED", "La devolución ya fue confirmada");
      const token = crypto.randomUUID();
      const tokenHash = await sha256(token);
      const codigo = `hallado:devolucion:${token}`;
      const imagen = await QRCode.toDataURL(codigo, { width: 320, margin: 4, errorCorrectionLevel: "M" });
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      db.transaction((tx) => {
        const { c, p, holder } = participants(tx, params.id, user.id);
        if (user.id !== holder) throw new ApiError(403, "NOT_HOLDER", "Solo quien devuelve puede mostrar el QR");
        if (p.estado === "resuelta") throw new ApiError(409, "RETURN_COMPLETED", "La devolución ya fue confirmada");
        const values = { claimId: c.id, intento: c.intentos ?? 1, tokenHash, expiresAt, usedAt: null };
        tx.insert(returnCodes).values(values).onConflictDoUpdate({ target: returnCodes.claimId, set: values }).run();
      });
      set.headers["cache-control"] = "no-store";
      return { imagen, expiresAt };
    })
    .post("/reclamos/:id/devolucion/confirmar", async ({ headers, params, body }) => {
      const user = await requireUser(db, headers);
      const match = /^hallado:devolucion:([0-9a-f-]{36})$/.exec(body.codigo);
      if (!match) throw new ApiError(422, "INVALID_QR", "Este QR no corresponde a una devolución de Hallado");
      const tokenHash = await sha256(match[1]!);
      return db.transaction((tx) => {
        const { c, p, recipient } = participants(tx, params.id, user.id);
        if (user.id !== recipient) throw new ApiError(403, "NOT_RECIPIENT", "Solo quien recupera puede confirmar la devolución");
        const code = tx.select().from(returnCodes).where(eq(returnCodes.claimId, c.id)).get();
        if (!code || code.tokenHash !== tokenHash || code.intento !== (c.intentos ?? 1)) {
          throw new ApiError(422, "WRONG_QR", "El QR no corresponde a este reclamo o fue reemplazado. Pedí el código actual");
        }
        if (p.estado === "resuelta" && code.usedAt) return { publicacionId: p.id, estado: "resuelta" };
        if (p.estado === "resuelta") throw new ApiError(409, "RETURN_COMPLETED", "La devolución ya fue confirmada");
        if (code.expiresAt <= nowIso()) throw new ApiError(409, "QR_EXPIRED", "El QR venció. Pedile a la otra persona que genere uno nuevo");
        completeReturn(tx, p, c);
        tx.update(returnCodes).set({ usedAt: nowIso() }).where(eq(returnCodes.claimId, c.id)).run();
        return { publicacionId: p.id, estado: "resuelta" };
      });
    }, { body: t.Object({ codigo: t.String({ minLength: 1, maxLength: 200 }) }) });
}
