import { and, eq } from "drizzle-orm";
import type { Store } from "./database";
import { claims, halladoPublications as posts } from "./db/schema";
import { getClaim, getPost, notify, notifyFollowers } from "./queries";
import { nowIso } from "./utils";

export function completeReturn(tx: Store, p: ReturnType<typeof getPost>, c: ReturnType<typeof getClaim>) {
  const now = nowIso();
  tx.update(posts).set({ estado: "resuelta", resolvedAt: now, updatedAt: now }).where(eq(posts.id, p.id)).run();
  for (const other of tx.select().from(claims).where(and(eq(claims.publicationId, p.id), eq(claims.estado, "pendiente"))).all()) {
    tx.update(claims).set({ estado: "rechazado", updatedAt: now }).where(eq(claims.id, other.id)).run();
    notify(tx, other.userId, "reclamo", `La publicación ya se resolvió: ${p.titulo}`, { publicationId: p.id, claimId: other.id });
  }
  notify(tx, c.userId, "devolucion", `Se concretó la devolución: ${p.titulo}`, { publicationId: p.id, claimId: c.id });
  notifyFollowers(tx, p, `Se resolvió: ${p.titulo}`);
}
