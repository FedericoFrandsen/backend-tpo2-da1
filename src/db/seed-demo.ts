import { eq } from "drizzle-orm";
import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { config } from "../config";
import type { AppDatabase } from "../database";
import { claims, halladoPublications as posts, halladoReviews, uploads, users } from "./schema";
import { franjaDeHora, localDate, publicationExpiry } from "../utils";

const assetsPath = fileURLToPath(new URL("../../assets/demo/", import.meta.url));
const DAY = 86_400_000;
export const DEMO_PASSWORD = "Hallado123";
export const DEMO_PEOPLE = [
  { id: "demo-usuario", email: "sofia@hallado.com", name: "Sofía Torres", zone: "Palermo", phone: "11 5555-0100", sharePhone: true },
  { id: "demo-lucia", email: "lucia@hallado.com", name: "Lucía Fernández", zone: "Palermo", phone: "11 5555-0101", sharePhone: true },
  { id: "demo-martin", email: "martin@hallado.com", name: "Martín Gómez", zone: "Belgrano", phone: "11 5555-0102", sharePhone: false },
] as const;
export const DEMO_POSTS = {
  encontrado: "demo145-llaves-encontradas", perdido: "demo145-mochila-perdida",
  abierta: "demo145-billetera-abierta", enReclamo: "demo145-auriculares-en-reclamo",
  vencida: "demo145-campera-vencida", resuelta: "demo145-llaves-devueltas",
} as const;
const PHOTO_NAMES = ["llaves-1", "llaves-2", "mochila-1", "mochila-2", "billetera", "auriculares", "campera"] as const;
type Photo = typeof PHOTO_NAMES[number];
type Post = typeof posts.$inferInsert;

/** Repetir el seed conserva contraseñas, fechas y cambios existentes. Una nueva toma usa otra base. */
export async function seedDemo(db: AppDatabase, options: { uploadsPath: string; now?: Date }) {
  if (config.isProduction) throw new Error("El seed de demostración solo se ejecuta fuera de producción.");
  const now = options.now ?? new Date(), iso = now.toISOString();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const hash = await Bun.password.hash(DEMO_PASSWORD);
  const people = DEMO_PEOPLE.map((p) => {
    const existing = db.select({ id: users.id }).from(users).where(eq(users.email, p.email)).get()
      ?? (p.id === "demo-usuario"
        ? db.select({ id: users.id }).from(users).where(eq(users.email, "demo@hallado.com")).get()
        : undefined);
    return { ...p, id: existing?.id ?? p.id };
  });
  const images = new Map<string, { filename: string; owner: number; asset: Photo }>();
  function photos(owner: number, names: Photo[]) {
    return names.map((asset) => {
      const filename = `14500000-0000-4000-800${owner}-${String(PHOTO_NAMES.indexOf(asset) + 1).padStart(12, "0")}.png`;
      images.set(filename, { filename, owner, asset });
      return `/uploads/${filename}`;
    });
  }
  function post(id: string, owner: number, tipo: Post["tipo"], titulo: string, descripcion: string,
    categoria: Post["categoria"], photoNames: Photo[], days = 1, hora = "17:10"): Post {
    return { id, userId: people[owner]!.id, tipo, titulo, descripcion, categoria, barrio: "Palermo",
      fecha: localDate(ago(days)), hora, franja: franjaDeHora(hora), latitud: -34.588912, longitud: -58.430612,
      direccionExacta: "Av. Santa Fe 4100, Palermo (dirección ficticia de demo)", fotos: photos(owner, photoNames),
      estado: "abierta", ...(tipo === "encontrado" ? {
        preguntaVerificacion: "¿Qué palabra está grabada en la llave pequeña?", respuestaVerificacion: "Nube",
      } : {}), createdAt: ago(days).toISOString(), updatedAt: iso, venceAt: publicationExpiry(ago(days).getTime()),
    };
  }
  const data: Post[] = [
    post(DEMO_POSTS.encontrado, 1, "encontrado", "Llaves encontradas en Plaza Italia",
      "Encontré dos llaves con un llavero azul cerca de Plaza Italia. Las guardé para devolverlas a su dueño. Hay un detalle que no aparece en las imágenes.", "Llaves", ["llaves-1", "llaves-2"]),
    post(DEMO_POSTS.perdido, 1, "perdido", "Mochila azul perdida en Palermo",
      "Perdí una mochila azul con bolsillo delantero al salir de la plaza. Si la encontraste, podés avisarme desde esta publicación.", "Otros", ["mochila-1", "mochila-2"], 2, "08:20"),
    { ...post(DEMO_POSTS.abierta, 0, "encontrado", "Billetera marrón encontrada",
      "Encontré una billetera marrón cerrada en Palermo. No publico el contenido para proteger a su dueño.", "Otros", ["billetera"]),
      preguntaVerificacion: "¿Qué iniciales tiene grabadas por dentro?", respuestaVerificacion: "MG" },
    { ...post(DEMO_POSTS.enReclamo, 0, "encontrado", "Auriculares negros con reclamo aceptado",
      "Auriculares de vincha negros. El dueño ya fue identificado y estamos coordinando la devolución.", "Electrónica", ["auriculares"], 2),
      estado: "en_reclamo", preguntaVerificacion: "¿Qué nombre figura debajo de la vincha?", respuestaVerificacion: "Martín" },
    post(DEMO_POSTS.vencida, 0, "perdido", "Campera verde pendiente de renovar",
      "Perdí mi campera verde en Palermo. Este caso lleva más de 30 días publicado y está preparado para mostrar la renovación.", "Ropa", ["campera"], 31, "19:30"),
    { ...post(DEMO_POSTS.resuelta, 0, "encontrado", "Llaves del auto devueltas",
      "Las llaves ya fueron entregadas a Lucía. La publicación queda como caso resuelto.", "Llaves", ["llaves-1"], 4), estado: "resuelta", resolvedAt: ago(2).toISOString() },
  ];
  const history: [string, Post["categoria"], Photo][] = [
    ["Llaves con llavero azul devueltas", "Llaves", "llaves-1"], ["Mochila azul devuelta", "Otros", "mochila-1"],
    ["Billetera marrón devuelta", "Otros", "billetera"], ["Auriculares negros devueltos", "Electrónica", "auriculares"],
    ["Campera verde devuelta", "Ropa", "campera"],
  ];
  for (const [i, [titulo, categoria, photo]] of history.entries()) {
    data.push({ ...post(`demo145-historia-${i + 1}`, 1, "encontrado", titulo,
      "Devolución concretada de demostración para la reputación de Lucía.", categoria, [photo], 12 + i),
      estado: "resuelta", resolvedAt: ago(8 + i).toISOString() });
  }
  await mkdir(options.uploadsPath, { recursive: true });
  for (const image of images.values()) {
    const target = join(options.uploadsPath, image.filename);
    if (!await Bun.file(target).exists()) await copyFile(join(assetsPath, `${image.asset}.png`), target);
  }
  db.transaction((tx) => {
    // Conservar ID, contraseña y publicaciones de las tomas que usaban el email anterior.
    tx.update(users).set({ email: DEMO_PEOPLE[0].email })
      .where(eq(users.id, people[0]!.id)).run();
    for (const [i, person] of people.entries()) tx.insert(users).values({ ...person, passwordHash: hash,
      createdAt: ago(i === 1 ? 180 : 60).toISOString(), emailVerifiedAt: ago(60).toISOString(),
    }).onConflictDoNothing().run();
    for (const image of images.values()) tx.insert(uploads).values({ filename: image.filename,
      userId: people[image.owner]!.id, contentType: "image/png", tipo: "imagen", createdAt: iso,
    }).onConflictDoNothing().run();
    for (const publication of data) tx.insert(posts).values(publication).onConflictDoNothing().run();
    tx.insert(claims).values({ id: "demo145-reclamo-auriculares", publicationId: DEMO_POSTS.enReclamo,
      userId: people[2]!.id, mensaje: "Son mis auriculares. Mi nombre está debajo de la vincha.",
      respuestaVerificacion: "Martín", estado: "aceptado", createdAt: ago(1).toISOString(), updatedAt: iso,
    }).onConflictDoNothing().run();
    for (const publication of data.filter((p) => p.estado === "resuelta")) {
      const owner = publication.userId === people[0]!.id ? 0 : 1, claimant = owner === 0 ? 1 : 0;
      tx.insert(claims).values({ id: `${publication.id}-reclamo`, publicationId: publication.id,
        userId: people[claimant]!.id, mensaje: "El objeto fue identificado y devuelto.",
        respuestaVerificacion: publication.respuestaVerificacion, estado: "aceptado",
        createdAt: publication.createdAt, updatedAt: publication.resolvedAt!,
      }).onConflictDoNothing().run();
      tx.insert(halladoReviews).values({ id: `${publication.id}-valoracion`, publicationId: publication.id,
        reviewerId: people[claimant]!.id, reviewedUserId: people[owner]!.id, positiva: true,
        comentario: "Gracias por cuidar mis cosas y devolverlas.", createdAt: publication.resolvedAt!,
      }).onConflictDoNothing().run();
    }
  });
  return { people, publications: data.map((p) => p.id), images: images.size };
}
