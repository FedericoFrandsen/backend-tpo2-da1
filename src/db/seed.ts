import { eq } from "drizzle-orm";
import { config } from "../config";
import { createDatabase } from "../database";
import { claims, halladoPublications as posts, halladoReviews, users } from "./schema";
import { CATEGORIES, ZONES } from "../types";
import { localDate, nowIso } from "../utils";

if (config.isProduction) throw new Error("El seed de demostración solo se ejecuta fuera de producción.");
const db = createDatabase();
try {
  const hash = await Bun.password.hash("Hallado123");
  const now = nowIso();
  const people = [
    { id: "demo-usuario", email: "demo@hallado.com", name: "Usuario de prueba", zone: "Palermo", phone: "11 5555-0100", sharePhone: true },
    { id: "demo-lucia", email: "lucia@hallado.com", name: "Lucía Fernández", zone: "Caballito", phone: "11 5555-0101", sharePhone: true },
    { id: "demo-martin", email: "martin@hallado.com", name: "Martín Gómez", zone: "Belgrano", phone: "11 5555-0102", sharePhone: false },
  ];
  const ids: string[] = [];
  db.transaction((tx) => {
    for (const p of people) {
      const previous = tx.select({ id: users.id }).from(users).where(eq(users.email, p.email)).get();
      if (previous) ids.push(previous.id);
      else {
        tx.insert(users).values({ ...p, passwordHash: hash, createdAt: now, emailVerifiedAt: now }).run();
        ids.push(p.id);
      }
    }
    const titles = ["Documento en un sobre azul", "Llaves con llavero rojo", "Auriculares negros", "Perro con collar azul", "Campera negra", "Mochila azul"];
    for (const [ci, categoria] of CATEGORIES.entries()) {
      for (const [zi, z] of ZONES.entries()) {
        for (const tipo of ["encontrado", "perdido"] as const) {
          for (let day = 0; day < 3; day++) {
            const date = new Date(`${localDate()}T12:00:00Z`);
            date.setUTCDate(date.getUTCDate() - day);
            tx.insert(posts).values({
              id: `demo-${ci}-${zi}-${tipo}-${day}`, userId: ids[(ci + zi + day) % ids.length]!, tipo,
              titulo: titles[ci]!, descripcion: `${titles[ci]}. Publicación de demostración para probar Hallado.`,
              categoria, barrio: z.nombre, fecha: date.toISOString().slice(0, 10), franja: "tarde",
              latitud: z.latitud + day * 0.001, longitud: z.longitud, direccionExacta: "Dirección ficticia 123", fotos: [],
              ...(tipo === "encontrado" ? { preguntaVerificacion: "¿Qué detalle distintivo tiene?", respuestaVerificacion: "Una marca azul" } : {}),
              createdAt: now, updatedAt: now,
            }).onConflictDoNothing().run();
          }
        }
      }
    }
    for (let i = 0; i < 5; i++) {
      const id = `demo-devolucion-${i}`;
      const claimId = `demo-reclamo-${i}`;
      tx.insert(posts).values({
        id, userId: ids[0]!, tipo: "encontrado", titulo: `Devolución de ejemplo ${i + 1}`,
        descripcion: "Objeto devuelto a su dueño en los datos de demostración.", categoria: "Otros", barrio: "Palermo",
        fecha: localDate(), franja: "manana", latitud: ZONES[1]!.latitud, longitud: ZONES[1]!.longitud,
        estado: "resuelta", resolvedAt: now, createdAt: now, updatedAt: now,
        preguntaVerificacion: "¿De qué color es?", respuestaVerificacion: "Negro",
      }).onConflictDoNothing().run();
      tx.insert(claims).values({ id: claimId, publicationId: id, userId: ids[1]!, mensaje: "Es mío, coordinamos la devolución.", estado: "aceptado", createdAt: now, updatedAt: now }).onConflictDoNothing().run();
      tx.insert(halladoReviews).values({ id: `demo-valoracion-${i}`, publicationId: id, reviewerId: ids[1]!, reviewedUserId: ids[0]!, positiva: true, comentario: "Gracias por devolverlo.", createdAt: now }).onConflictDoNothing().run();
    }
    const first = tx.select().from(posts).where(eq(posts.id, "demo-0-0-encontrado-0")).get();
    if (first && first.estado === "abierta") {
      tx.insert(claims).values({ id: "demo-pendiente", publicationId: first.id, userId: ids[1]!, mensaje: "Creo que es mío, puedo describir los detalles.", createdAt: now, updatedAt: now }).onConflictDoNothing().run();
    }
  });
  console.log("Datos de ejemplo cargados sin sobrescribir datos existentes.");
  console.log("Usuarios: demo@hallado.com, lucia@hallado.com, martin@hallado.com");
  console.log("Contraseña de las cuentas nuevas de demostración: Hallado123");
} finally {
  db.$client.close();
}
