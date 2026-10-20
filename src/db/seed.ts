import { eq } from "drizzle-orm";
import { createDatabase } from "../database";
import {
  favorites,
  offers,
  operations,
  publicationImages,
  publications,
  questions,
  reviews,
  savedSearches,
  users,
} from "./schema";

const db = createDatabase();

// Como los IDs ahora son UUIDs generados en cada corrida (no strings fijos), no se puede confiar
// en `onConflictDoNothing` por id para que reinsertar el seed sea un no-op: se chequea acá con un
// dato natural (el email) si el seed ya se aplicó antes.
const alreadySeeded = db.select({ id: users.id }).from(users).where(eq(users.email, "ana@example.com")).get();
if (alreadySeeded) {
  console.log("Seed ya aplicado (existe ana@example.com); no se modifica nada.");
  db.$client.close();
  process.exit(0);
}

// Los IDs de todas las entidades son UUIDs generados en runtime (no strings fijos), tal como
// se pide para el resto de la aplicación; se guardan en este mapa solo para poder referenciarlos
// entre sí dentro del propio seed.
const ids = {
  ana: crypto.randomUUID(),
  bruno: crypto.randomUUID(),
  carla: crypto.randomUUID(),
  diego: crypto.randomUUID(),
  bike: crypto.randomUUID(),
  notebook: crypto.randomUUID(),
  chair: crypto.randomUUID(),
  phone: crypto.randomUUID(),
  guitar: crypto.randomUUID(),
  bikeOffer: crypto.randomUUID(),
  phoneOffer: crypto.randomUUID(),
  phoneOperation: crypto.randomUUID(),
};

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const unsplash = (photoId: string) => `https://images.unsplash.com/photo-${photoId}`;

// Publicaciones adicionales para que cada usuario tenga al menos 5 (las 5 originales, con
// referencias desde favoritos/ofertas/operaciones, se definen más abajo con ids nombrados).
const extraPublications = [
  // Ana (Palermo)
  {
    sellerId: ids.ana,
    title: "Zapatillas running talle 42",
    description: "Usadas un par de veces, suela en perfecto estado.",
    category: "fashion",
    priceCents: 95_000,
    itemCondition: "like_new" as const,
    address: "Av. Santa Fe 3253, Palermo, CABA",
    status: "active" as const,
    publishedAt: daysAgo(4),
    images: [unsplash("1542291026-7eec264c27ff")],
  },
  {
    sellerId: ids.ana,
    title: "Smartwatch blanco",
    description: "Malla de silicona, funciona perfecto. Incluye cargador y caja original.",
    category: "fashion",
    priceCents: 130_000,
    itemCondition: "used" as const,
    address: "Av. Santa Fe 3253, Palermo, CABA",
    status: "active" as const,
    publishedAt: daysAgo(8),
    images: [unsplash("1523275335684-37898b6baf30")],
  },
  {
    sellerId: ids.ana,
    title: "Lote de libros de emprendimiento y negocios",
    description: "Siete libros en muy buen estado, ideales para quienes arrancan un proyecto.",
    category: "books",
    priceCents: 60_000,
    itemCondition: "used" as const,
    address: "Av. Santa Fe 3253, Palermo, CABA",
    status: "active" as const,
    publishedAt: daysAgo(12),
    images: [unsplash("1512820790803-83ca734da794")],
  },
  // Bruno (Caballito)
  {
    sellerId: ids.bruno,
    title: "Auriculares inalámbricos",
    description: "Con cancelación de ruido, batería de 30 horas y estuche.",
    category: "electronics",
    priceCents: 140_000,
    itemCondition: "like_new" as const,
    address: "Av. Rivadavia 5401, Caballito, CABA",
    status: "active" as const,
    publishedAt: daysAgo(3),
    images: [unsplash("1505740420928-5e560c06d30e")],
  },
  {
    sellerId: ids.bruno,
    title: "Cámara instantánea Polaroid",
    description: "Funciona perfecto. Incluye correa y dos cargas de película sin usar.",
    category: "electronics",
    priceCents: 520_000,
    itemCondition: "used" as const,
    address: "Av. Rivadavia 5401, Caballito, CABA",
    status: "active" as const,
    publishedAt: daysAgo(7),
    images: [unsplash("1526170375885-4d8ecf77b99f")],
  },
  {
    sellerId: ids.bruno,
    title: "Sillón de dos cuerpos",
    description: "Tapizado en terciopelo verde, sin manchas. Retiro por Caballito.",
    category: "home",
    priceCents: 280_000,
    itemCondition: "used" as const,
    address: "Av. Rivadavia 5401, Caballito, CABA",
    status: "active" as const,
    publishedAt: daysAgo(9),
    images: [unsplash("1555041469-a586c61ea9bc")],
  },
  {
    sellerId: ids.bruno,
    title: "Set de juegos de mesa",
    description: "Cuatro juegos completos, ideal para regalar.",
    category: "toys",
    priceCents: 45_000,
    itemCondition: "like_new" as const,
    address: "Av. Rivadavia 5401, Caballito, CABA",
    status: "active" as const,
    publishedAt: daysAgo(25),
    images: ["https://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/Monopoly_board_game.jpg/960px-Monopoly_board_game.jpg"],
  },
  // Carla (Belgrano)
  {
    sellerId: ids.carla,
    title: "MacBook Pro 13 pulgadas",
    description: "8 GB de RAM y SSD de 256 GB. Batería en buen estado y cargador original.",
    category: "electronics",
    priceCents: 1_100_000,
    itemCondition: "used" as const,
    address: "Av. Cabildo 2085, Belgrano, CABA",
    status: "active" as const,
    publishedAt: daysAgo(1),
    images: [unsplash("1517336714731-489689fd1ca8")],
  },
  {
    sellerId: ids.carla,
    title: "Banqueta alta de madera",
    description: "Ideal para barra o isla de cocina. Muy resistente.",
    category: "home",
    priceCents: 90_000,
    itemCondition: "used" as const,
    address: "Av. Cabildo 2085, Belgrano, CABA",
    status: "active" as const,
    publishedAt: daysAgo(6),
    images: [unsplash("1503602642458-232111445657")],
  },
  {
    sellerId: ids.carla,
    title: "Campera de cuero mujer talle M",
    description: "Cuero genuino negro, con el desgaste natural del uso.",
    category: "fashion",
    priceCents: 150_000,
    itemCondition: "used" as const,
    address: "Av. Cabildo 2085, Belgrano, CABA",
    status: "paused" as const,
    publishedAt: daysAgo(14),
    images: ["https://upload.wikimedia.org/wikipedia/commons/thumb/b/be/Black_worn_leather_jacket.jpg/960px-Black_worn_leather_jacket.jpg"],
  },
  // Diego (Villa Crespo)
  {
    sellerId: ids.diego,
    title: "Moto Yamaha XSR700",
    description: "Modelo 2021, 12.000 km, service al día y papeles en regla.",
    category: "vehicles",
    priceCents: 9_500_000,
    itemCondition: "used" as const,
    address: "Av. Corrientes 5120, Villa Crespo, CABA",
    status: "active" as const,
    publishedAt: daysAgo(2),
    images: ["https://upload.wikimedia.org/wikipedia/commons/thumb/9/93/Red_Yamaha_XSR700_parked_near_a_bicycle_2018.jpg/960px-Red_Yamaha_XSR700_parked_near_a_bicycle_2018.jpg"],
  },
  {
    sellerId: ids.diego,
    title: "Casco integral talle L",
    description: "Homologado, con visor extra. Usado una temporada.",
    category: "vehicles",
    priceCents: 85_000,
    itemCondition: "used" as const,
    address: "Av. Corrientes 5120, Villa Crespo, CABA",
    status: "active" as const,
    publishedAt: daysAgo(2),
    images: ["https://upload.wikimedia.org/wikipedia/commons/thumb/c/c4/BlackFullCoverageMotorcycleHelmet.jpg/960px-BlackFullCoverageMotorcycleHelmet.jpg"],
  },
  {
    sellerId: ids.diego,
    title: "Mesa ratona de madera",
    description: "Estructura de madera rústica con tapa de vidrio, 120x50 cm.",
    category: "home",
    priceCents: 75_000,
    itemCondition: "used" as const,
    address: "Av. Corrientes 5120, Villa Crespo, CABA",
    status: "active" as const,
    publishedAt: daysAgo(5),
    images: ["https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Rustic-coffee-table.JPG/960px-Rustic-coffee-table.JPG"],
  },
  {
    sellerId: ids.diego,
    title: "Consola de videojuegos con dos joysticks",
    description: "Xbox 360 con cables, dos controles y 5 juegos.",
    category: "electronics",
    priceCents: 380_000,
    itemCondition: "used" as const,
    address: "Av. Corrientes 5120, Villa Crespo, CABA",
    status: "active" as const,
    publishedAt: daysAgo(10),
    images: ["https://upload.wikimedia.org/wikipedia/commons/thumb/4/40/Xbox-360-Pro-wController.jpg/960px-Xbox-360-Pro-wController.jpg"],
  },
  {
    sellerId: ids.diego,
    title: "Pelota de fútbol profesional",
    description: "Pelota de partido en excelente estado, ideal para cancha de césped.",
    category: "sports",
    priceCents: 40_000,
    itemCondition: "like_new" as const,
    address: "Av. Corrientes 5120, Villa Crespo, CABA",
    status: "active" as const,
    publishedAt: daysAgo(1),
    images: ["https://upload.wikimedia.org/wikipedia/commons/thumb/7/7f/Adidas_soccer_ball_on_a_grass_pitch_%28Unsplash%29.jpg/960px-Adidas_soccer_ball_on_a_grass_pitch_%28Unsplash%29.jpg"],
  },
].map(({ images, publishedAt, ...publication }) => ({
  publication: { id: crypto.randomUUID(), ...publication, publishedAt, createdAt: publishedAt, updatedAt: publishedAt },
  images,
}));

try {
  const passwordHash = await Bun.password.hash("12345678");

  db.transaction((tx) => {
    tx.insert(users)
      .values([
        {
          id: ids.ana,
          email: "ana@example.com",
          username: "ana.ventas",
          passwordHash,
          name: "Ana Gómez",
          phone: "+54 11 5555-0101",
          zone: "Palermo",
          avatarUrl: "https://images.unsplash.com/photo-1494790108377-be9c29b29330",
          createdAt: daysAgo(180),
          emailVerifiedAt: daysAgo(180),
        },
        {
          id: ids.bruno,
          email: "bruno@example.com",
          username: "bruno.compra",
          passwordHash,
          name: "Bruno Díaz",
          phone: "+54 11 5555-0102",
          zone: "Caballito",
          avatarUrl: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e",
          createdAt: daysAgo(120),
          emailVerifiedAt: daysAgo(120),
        },
        {
          id: ids.carla,
          email: "carla@example.com",
          username: "carla.market",
          passwordHash,
          name: "Carla Ruiz",
          phone: "+54 11 5555-0103",
          zone: "Belgrano",
          avatarUrl: "https://images.unsplash.com/photo-1517841905240-472988babdf9",
          createdAt: daysAgo(75),
          emailVerifiedAt: daysAgo(75),
        },
        {
          id: ids.diego,
          email: "diego@example.com",
          username: "diego.vende",
          passwordHash,
          name: "Diego Fernández",
          phone: "+54 11 5555-0104",
          zone: "Villa Crespo",
          avatarUrl: unsplash("1507003211169-0a1dd7228f2d"),
          createdAt: daysAgo(40),
          emailVerifiedAt: daysAgo(40),
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(publications)
      .values([
        {
          id: ids.bike,
          sellerId: ids.ana,
          title: "Bicicleta urbana rodado 28",
          description: "Bicicleta liviana, con cambios Shimano y muy poco uso.",
          category: "sports",
          priceCents: 450_000,
          itemCondition: "like_new",
          address: "Av. Santa Fe 3253, Palermo, CABA",
          status: "active",
          publishedAt: daysAgo(5),
          createdAt: daysAgo(6),
          updatedAt: daysAgo(2),
        },
        {
          id: ids.notebook,
          sellerId: ids.carla,
          title: "Notebook Lenovo ThinkPad",
          description: "16 GB de RAM, SSD de 512 GB y cargador original.",
          category: "electronics",
          priceCents: 780_000,
          itemCondition: "used",
          address: "Av. Cabildo 2085, Belgrano, CABA",
          status: "active",
          publishedAt: daysAgo(2),
          createdAt: daysAgo(3),
          updatedAt: daysAgo(2),
        },
        {
          id: ids.chair,
          sellerId: ids.ana,
          title: "Silla ergonómica de oficina",
          description: "Tapizada en cuero ecológico, con apoyabrazos y altura regulable.",
          category: "home",
          priceCents: 185_000,
          itemCondition: "like_new",
          address: "Av. Santa Fe 3253, Palermo, CABA",
          status: "paused",
          publishedAt: daysAgo(15),
          createdAt: daysAgo(16),
          updatedAt: daysAgo(1),
        },
        {
          id: ids.phone,
          sellerId: ids.carla,
          title: "Celular Samsung Galaxy",
          description: "Equipo liberado con caja y funda.",
          category: "electronics",
          priceCents: 320_000,
          itemCondition: "used",
          address: "Av. Cabildo 2085, Belgrano, CABA",
          status: "sold",
          publishedAt: daysAgo(30),
          createdAt: daysAgo(31),
          updatedAt: daysAgo(10),
        },
        {
          id: ids.guitar,
          sellerId: ids.bruno,
          title: "Guitarra criolla",
          description: "Guitarra con funda incluida, ideal para arrancar.",
          category: "other",
          priceCents: 210_000,
          itemCondition: "used",
          address: "Av. Rivadavia 5401, Caballito, CABA",
          status: "paused",
          publishedAt: daysAgo(1),
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        },
        ...extraPublications.map(({ publication }) => publication),
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(publicationImages)
      .values([
        ...extraPublications.flatMap(({ publication, images }) =>
          images.map((url, position) => ({ id: crypto.randomUUID(), publicationId: publication.id, url, position })),
        ),
        { id: crypto.randomUUID(), publicationId: ids.bike, url: "https://images.unsplash.com/photo-1571068316344-75bc76f77890", position: 0 },
        { id: crypto.randomUUID(), publicationId: ids.notebook, url: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853", position: 0 },
        { id: crypto.randomUUID(), publicationId: ids.chair, url: "https://images.unsplash.com/photo-1505797149-43b0069ec26b", position: 0 },
        { id: crypto.randomUUID(), publicationId: ids.phone, url: "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9", position: 0 },
        {
          id: crypto.randomUUID(),
          publicationId: ids.guitar,
          url: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/Spanish_classical_acoustic_guitar3.jpg/960px-Spanish_classical_acoustic_guitar3.jpg",
          position: 0,
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(favorites)
      .values([
        { userId: ids.bruno, publicationId: ids.bike, savedPriceCents: 470_000, hasUpdate: true, createdAt: daysAgo(4) },
        { userId: ids.ana, publicationId: ids.notebook, savedPriceCents: 780_000, hasUpdate: false, createdAt: daysAgo(1) },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(savedSearches)
      .values({
        id: crypto.randomUUID(),
        userId: ids.bruno,
        name: "Bicicletas cerca",
        queryText: "bicicleta",
        category: "sports",
        minPriceCents: 100_000,
        maxPriceCents: 600_000,
        itemCondition: "like_new",
        zone: "Palermo",
        sort: "recent",
        unreadCount: 1,
        createdAt: daysAgo(10),
        lastCheckedAt: daysAgo(6),
      })
      .onConflictDoNothing()
      .run();

    tx.insert(questions)
      .values([
        {
          id: crypto.randomUUID(),
          publicationId: ids.bike,
          askerId: ids.bruno,
          text: "¿Incluye luces y guardabarros?",
          answer: "Sí, incluye ambos accesorios.",
          createdAt: daysAgo(4),
          answeredAt: daysAgo(3),
        },
        {
          id: crypto.randomUUID(),
          publicationId: ids.notebook,
          askerId: ids.ana,
          text: "¿Cuánto dura la batería?",
          answer: null,
          createdAt: daysAgo(1),
          answeredAt: null,
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(offers)
      .values([
        {
          id: ids.bikeOffer,
          publicationId: ids.bike,
          buyerId: ids.bruno,
          amountCents: 420_000,
          message: "¿Aceptás este precio? Puedo pasar a buscarla el finde.",
          counterAmountCents: null,
          status: "pending",
          sellerHasUpdate: true,
          expiresAt: daysFromNow(2),
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        },
        {
          id: ids.phoneOffer,
          publicationId: ids.phone,
          buyerId: ids.bruno,
          amountCents: 300_000,
          message: null,
          counterAmountCents: null,
          status: "accepted",
          expiresAt: daysAgo(9),
          createdAt: daysAgo(12),
          updatedAt: daysAgo(10),
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(operations)
      .values({
        id: ids.phoneOperation,
        publicationId: ids.phone,
        offerId: ids.phoneOffer,
        buyerId: ids.bruno,
        sellerId: ids.carla,
        amountCents: 300_000,
        completedAt: daysAgo(10),
      })
      .onConflictDoNothing()
      .run();

    tx.insert(reviews)
      .values([
        {
          id: crypto.randomUUID(),
          operationId: ids.phoneOperation,
          reviewerId: ids.bruno,
          reviewedUserId: ids.carla,
          rating: 5,
          comment: "Todo perfecto, muy recomendable.",
          createdAt: daysAgo(9),
        },
        {
          id: crypto.randomUUID(),
          operationId: ids.phoneOperation,
          reviewerId: ids.carla,
          reviewedUserId: ids.bruno,
          rating: 5,
          comment: "Comprador puntual y amable.",
          createdAt: daysAgo(9),
        },
      ])
      .onConflictDoNothing()
      .run();
  });

  console.log("Seed completado.");
  console.log("Usuarios: ana@example.com, bruno@example.com, carla@example.com y diego@example.com");
  console.log("Contraseña para todos: 12345678");
} finally {
  db.$client.close();
}
