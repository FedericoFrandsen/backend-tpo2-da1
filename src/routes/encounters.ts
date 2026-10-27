import { and, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { requireUser } from "../auth";
import type { AppDatabase, Store } from "../database";
import { encounters } from "../db/schema";
import { ApiError } from "../errors";
import { getClaim, getPost } from "../queries";
import { cleanText, nowIso } from "../utils";

function meeting(db: Store, claimId: string, userId: string) {
  const claim = getClaim(db, claimId);
  const post = getPost(db, claim.publicationId);
  if (userId !== claim.userId && userId !== post.userId) {
    throw new ApiError(403, "FORBIDDEN", "No participás de este reclamo");
  }
  if (claim.estado !== "aceptado" || post.estado !== "en_reclamo") {
    throw new ApiError(409, "MEETING_UNAVAILABLE", "El encuentro requiere un reclamo aceptado y una devolución pendiente");
  }
  const encuentro = db.select().from(encounters).where(and(
    eq(encounters.claimId, claim.id), eq(encounters.intento, claim.intentos),
  )).get() ?? null;
  const holderId = post.tipo === "encontrado" ? post.userId : claim.userId;
  const puedeResponder = encuentro?.estado === "pendiente" && encuentro.propuestoPor !== userId;
  return {
    encuentro,
    intento: claim.intentos,
    puedeProponer: encuentro ? puedeResponder : holderId === userId,
    puedeResponder,
  };
}

function checkProposal(actual: ReturnType<typeof meeting>, id: string | null, intento: number) {
  if (actual.intento !== intento || (actual.encuentro?.id ?? null) !== id) {
    throw new ApiError(409, "MEETING_CHANGED", "La propuesta cambió. Actualizá el encuentro antes de responder");
  }
}

export function encounterRoutes(db: AppDatabase) {
  return new Elysia()
    .get("/reclamos/:id/encuentro", async ({ headers, params }) => {
      const user = await requireUser(db, headers);
      return meeting(db, params.id, user.id);
    })
    .post("/reclamos/:id/encuentro", async ({ headers, params, body }) => {
      const user = await requireUser(db, headers);
      const direccion = cleanText(body.direccion, 1, "dirección");
      return db.transaction((tx) => {
        const actual = meeting(tx, params.id, user.id);
        checkProposal(actual, body.propuestaId, body.intento);
        if (!actual.puedeProponer) {
          throw new ApiError(409, "CANNOT_PROPOSE", "La primera propuesta la hace quien tiene el objeto. Luego responde la otra persona");
        }
        const values = { id: crypto.randomUUID(), direccion, propuestoPor: user.id, updatedAt: nowIso() };
        if (actual.encuentro) {
          tx.update(encounters).set(values).where(eq(encounters.id, actual.encuentro.id)).run();
        } else {
          tx.insert(encounters).values({ ...values, claimId: params.id, intento: actual.intento }).run();
        }
        return meeting(tx, params.id, user.id);
      });
    }, { body: t.Object({
      direccion: t.String({ minLength: 1, maxLength: 200 }),
      propuestaId: t.Nullable(t.String()), intento: t.Integer({ minimum: 1, maximum: 3 }),
    }) })
    .post("/reclamos/:id/encuentro/aceptar", async ({ headers, params, body }) => {
      const user = await requireUser(db, headers);
      return db.transaction((tx) => {
        const actual = meeting(tx, params.id, user.id);
        checkProposal(actual, body.propuestaId, body.intento);
        if (!actual.encuentro || !actual.puedeResponder) {
          throw new ApiError(409, "CANNOT_ACCEPT_MEETING", "Solo la otra persona puede aceptar una propuesta pendiente");
        }
        tx.update(encounters).set({ estado: "aceptado", updatedAt: nowIso() })
          .where(eq(encounters.id, actual.encuentro.id)).run();
        return meeting(tx, params.id, user.id);
      });
    }, { body: t.Object({
      propuestaId: t.String({ minLength: 1 }), intento: t.Integer({ minimum: 1, maximum: 3 }),
    }) });
}
