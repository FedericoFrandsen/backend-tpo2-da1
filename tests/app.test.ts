import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { createDatabase } from "../src/database";

const db = createDatabase(":memory:");
const app = createApp(db);

async function api(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    }),
  );
  const data = await response.json();
  return { response, data };
}

/** El código ya no viaja en la respuesta HTTP: se loguea por consola (dev), así que lo interceptamos. */
async function requestOtp(email: string, purpose: "registration" | "login" | "set_password") {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  let requested: Awaited<ReturnType<typeof api>>;
  try {
    requested = await api("/auth/otp/request", { method: "POST", body: { email, purpose } });
  } finally {
    console.log = originalLog;
  }
  expect(requested.response.status).toBe(200);
  const code = logs.join("\n").match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`No se logueó el código OTP para ${email}`);
  return code;
}

async function register(email: string, name: string, password = "password123") {
  const code = await requestOtp(email, "registration");
  const verified = await api("/auth/otp/verify", {
    method: "POST",
    body: { email, purpose: "registration", code, name, password, zone: "Palermo" },
  });
  expect(verified.response.status).toBe(200);
  return { id: verified.data.userId as string, token: verified.data.session.token as string };
}

/** Crea una publicación completa (el alta guiada vive en el cliente, acá siempre se manda entera). Devuelve el id, ya activa. */
async function publish(token: string, overrides: Record<string, unknown> = {}) {
  const created = await api("/publications", {
    method: "POST",
    token,
    body: {
      title: "Bicicleta urbana",
      description: "Bicicleta en excelente estado y poco uso",
      category: "sports",
      price: 450,
      condition: "like_new",
      address: "Av. Santa Fe 3253, Palermo, CABA",
      imageUrls: ["https://images.example.com/bike.jpg"],
      ...overrides,
    },
  });
  expect(created.response.status).toBe(200);
  expect(created.data.status).toBe("active");
  return created.data.id as string;
}

afterAll(() => db.$client.close());

describe("Marketplace API", () => {
  test("flujo completo: registro, publicación, favorito, venta y reputación", async () => {
    const seller = await register("seller@example.com", "Seller");
    const buyer = await register("buyer@example.com", "Buyer");

    const savedSearch = await api("/saved-searches", {
      method: "POST",
      token: buyer.token,
      body: { name: "Bicis cerca", query: "bicicleta", category: "sports", zone: "Palermo" },
    });
    expect(savedSearch.response.status).toBe(200);
    expect(savedSearch.data.query).toBe("bicicleta");
    expect(savedSearch.data.unreadCount).toBe(0);

    const publicationId = await publish(seller.token);

    const feed = await api("/publications?q=bicicleta&category=sports&sort=price_asc");
    expect(feed.data.pagination.total).toBe(1);
    expect(feed.data.items[0].price).toBe(450);
    expect(feed.data.items[0].zone).toBe("Palermo");
    expect(feed.data.items[0].coverImage).toBe("https://images.example.com/bike.jpg");
    expect(feed.data.items[0]).toMatchObject({
      isFavorite: false,
      actions: { canAsk: false, canOffer: false, canFavorite: false, canManage: false },
    });

    const feedAsBuyer = await api("/publications?q=bicicleta", { token: buyer.token });
    expect(feedAsBuyer.data.items[0]).toMatchObject({
      isFavorite: false,
      actions: { canAsk: true, canOffer: true, canFavorite: true, canManage: false },
    });
    const feedAsSeller = await api("/publications?q=bicicleta", { token: seller.token });
    expect(feedAsSeller.data.items[0]).toMatchObject({
      isFavorite: false,
      actions: { canAsk: false, canOffer: false, canFavorite: false, canManage: true },
    });

    const searches = await api("/saved-searches", { token: buyer.token });
    expect(searches.data.items[0].unreadCount).toBe(1);

    const favorite = await api(`/publications/${publicationId}/favorite`, { method: "POST", token: buyer.token });
    expect(favorite.data.isFavorite).toBe(true);
    const feedAfterFavorite = await api("/publications?q=bicicleta", { token: buyer.token });
    expect(feedAfterFavorite.data.items[0]).toMatchObject({
      isFavorite: true,
      actions: { canAsk: true, canOffer: true, canFavorite: true, canManage: false },
    });

    await api(`/publications/${publicationId}`, { method: "PATCH", token: seller.token, body: { price: 440 } });
    const favorites = await api("/me/favorites", { token: buyer.token });
    expect(favorites.data.unreadCount).toBe(1);
    expect(favorites.data.items[0].priceChanged).toBe(1);
    expect(favorites.data.items[0].coverImage).toBe("https://images.example.com/bike.jpg");

    const offer = await api(`/publications/${publicationId}/offers`, {
      method: "POST",
      token: buyer.token,
      body: { amount: 425 },
    });
    const accepted = await api(`/offers/${offer.data.id}/respond`, {
      method: "POST",
      token: seller.token,
      body: { action: "accept" },
    });
    expect(accepted.data.status).toBe("accepted");

    const review = await api(`/operations/${accepted.data.operationId}/reviews`, {
      method: "POST",
      token: buyer.token,
      body: { rating: 5, comment: "Excelente vendedor" },
    });
    expect(review.data.rating).toBe(5);

    const profile = await api(`/users/${seller.id}`);
    expect(profile.data.ratingAverage).toBe(5);
    expect(profile.data.salesCompleted).toBe(1);

    const operations = await api("/me/operations", { token: buyer.token });
    expect(operations.data.items).toHaveLength(1);
    expect(operations.data.items[0]).toMatchObject({
      amount: 425,
      title: "Bicicleta urbana",
      buyerName: "Buyer",
      sellerName: "Seller",
      myRating: 5,
    });

    // El vendedor participa de la misma operación pero todavía no calificó.
    const sellerOperations = await api("/me/operations", { token: seller.token });
    expect(sellerOperations.data.items[0].myRating).toBeNull();
  });

  test("ofertas: ambas partes las ven, el comprador puede cancelar y el vendedor rechazar", async () => {
    const seller = await register("offers-seller@example.com", "Offers Seller");
    const buyer = await register("offers-buyer@example.com", "Offers Buyer");
    const publicationId = await publish(seller.token, { title: "Guitarra criolla", category: "other", price: 300 });

    const offer = await api(`/publications/${publicationId}/offers`, {
      method: "POST",
      token: buyer.token,
      body: { amount: 250 },
    });
    expect(offer.data.status).toBe("pending");

    const asBuyer = await api("/me/offers", { token: buyer.token });
    expect(asBuyer.data.items).toHaveLength(1);
    expect(asBuyer.data.items[0]).toMatchObject({ amount: 250, role: "buyer", title: "Guitarra criolla" });

    const asSeller = await api("/me/offers", { token: seller.token });
    expect(asSeller.data.items).toHaveLength(1);
    expect(asSeller.data.items[0].role).toBe("seller");

    // Un tercero no ve ofertas ajenas.
    const stranger = await register("offers-stranger@example.com", "Stranger");
    expect((await api("/me/offers", { token: stranger.token })).data.items).toHaveLength(0);

    const cancelled = await api(`/offers/${offer.data.id}/cancel`, { method: "POST", token: buyer.token });
    expect(cancelled.data.status).toBe("cancelled");

    const rejected = await api(`/offers/${offer.data.id}/respond`, {
      method: "POST",
      token: seller.token,
      body: { action: "accept" },
    });
    expect(rejected.response.status).toBe(409);
    expect(rejected.data.error.code).toBe("OFFER_ALREADY_RESOLVED");
  });

  test("preguntas: sólo el vendedor responde", async () => {
    const seller = await register("questions-seller@example.com", "Q Seller");
    const buyer = await register("questions-buyer@example.com", "Q Buyer");
    const publicationId = await publish(seller.token, { title: "Notebook usada", category: "electronics" });

    const question = await api(`/publications/${publicationId}/questions`, {
      method: "POST",
      token: buyer.token,
      body: { text: "¿Aceptás envío?" },
    });
    expect(question.response.status).toBe(200);

    const byBuyer = await api(`/questions/${question.data.id}/answer`, {
      method: "POST",
      token: buyer.token,
      body: { answer: "Me respondo solo" },
    });
    expect(byBuyer.response.status).toBe(403);

    const answered = await api(`/questions/${question.data.id}/answer`, {
      method: "POST",
      token: seller.token,
      body: { answer: "Sí, hago envíos a todo el país" },
    });
    expect(answered.response.status).toBe(200);

    const detail = await api(`/publications/${publicationId}`);
    expect(detail.data.questions[0].answer).toBe("Sí, hago envíos a todo el país");
    expect(detail.data.questions[0].askerName).toBe("Q Buyer");
  });

  test("pausar oculta la publicación del feed, pero mantiene el detalle sin acciones", async () => {
    const seller = await register("paused-seller@example.com", "Paused Seller");
    const buyer = await register("paused-buyer@example.com", "Paused Buyer");
    const publicationId = await publish(seller.token, { title: "Mesa ratona", category: "home", price: 120 });

    const paused = await api(`/publications/${publicationId}/status`, {
      method: "PATCH",
      token: seller.token,
      body: { status: "paused" },
    });
    expect(paused.data.status).toBe("paused");

    const feed = await api("/publications?q=ratona");
    expect(feed.data.pagination.total).toBe(0);
    const detail = await api(`/publications/${publicationId}`, { token: buyer.token });
    expect(detail.response.status).toBe(200);
    expect(detail.data.status).toBe("paused");
    expect(detail.data.actions).toEqual({
      canAsk: false,
      canOffer: false,
      canFavorite: false,
      canManage: false,
    });

    const ownerDetail = await api(`/publications/${publicationId}`, { token: seller.token });
    expect(ownerDetail.response.status).toBe(200);
    expect(ownerDetail.data.actions.canManage).toBe(true);

    const reactivated = await api(`/publications/${publicationId}/status`, {
      method: "PATCH",
      token: seller.token,
      body: { status: "active" },
    });
    expect(reactivated.data.status).toBe("active");
    expect((await api("/publications?q=ratona")).data.pagination.total).toBe(1);
  });

  test("la zona de una publicación se deriva siempre del perfil del vendedor", async () => {
    const seller = await register("zone-seller@example.com", "Zone Seller");
    const publicationId = await publish(seller.token, {
      title: "Artículo con zona heredada",
      zone: "Zona enviada que debe ignorarse",
    });

    const initialDetail = await api(`/publications/${publicationId}`);
    expect(initialDetail.data.zone).toBe("Palermo");

    await api("/me", { method: "PATCH", token: seller.token, body: { zone: "Caballito" } });

    const updatedDetail = await api(`/publications/${publicationId}`);
    expect(updatedDetail.data.zone).toBe("Caballito");
    expect((await api("/publications?q=zona%20heredada&zone=Palermo")).data.pagination.total).toBe(0);
    expect((await api("/publications?q=zona%20heredada&zone=Caballito")).data.pagination.total).toBe(1);

    const zones = await api("/zones");
    expect(zones.response.status).toBe(200);
    expect(zones.data.items).toContain("Caballito");
    expect(zones.data.items).not.toContain("Zona enviada que debe ignorarse");
    expect(new Set(zones.data.items).size).toBe(zones.data.items.length);
  });

  test("las rutas privadas rechazan requests sin sesión", async () => {
    const result = await api("/me");
    expect(result.response.status).toBe(401);
    expect(result.data.error.code).toBe("UNAUTHORIZED");

    const withBadToken = await api("/me", { token: "no-existe" });
    expect(withBadToken.response.status).toBe(401);
    expect(withBadToken.data.error.code).toBe("INVALID_SESSION");
  });

  test("consigna 4/8: la dirección exacta se oculta hasta que se acepta la oferta", async () => {
    const seller = await register("address-seller@example.com", "Address Seller");
    const buyer = await register("address-buyer@example.com", "Address Buyer");
    const stranger = await register("address-stranger@example.com", "Address Stranger");
    const publicationId = await publish(seller.token, { title: "Sommier dos plazas", category: "home" });

    const asStranger = await api(`/publications/${publicationId}`, { token: stranger.token });
    expect(asStranger.data.addressLocked).toBe(true);
    expect(asStranger.data.address).toBeNull();

    const asSeller = await api(`/publications/${publicationId}`, { token: seller.token });
    expect(asSeller.data.addressLocked).toBe(false);
    expect(asSeller.data.address).toBe("Av. Santa Fe 3253, Palermo, CABA");

    const offer = await api(`/publications/${publicationId}/offers`, {
      method: "POST",
      token: buyer.token,
      body: { amount: 100, message: "¿Cerramos en 100?" },
    });
    expect(offer.data.message).toBe("¿Cerramos en 100?");

    const beforeAccept = await api(`/publications/${publicationId}`, { token: buyer.token });
    expect(beforeAccept.data.addressLocked).toBe(true);

    await api(`/offers/${offer.data.id}/respond`, { method: "POST", token: seller.token, body: { action: "accept" } });

    const afterAccept = await api(`/publications/${publicationId}`, { token: buyer.token });
    expect(afterAccept.data.addressLocked).toBe(false);
    expect(afterAccept.data.address).toBe("Av. Santa Fe 3253, Palermo, CABA");
  });

  test("consigna 7: el vendedor contraoferta y el comprador la acepta, cerrando la venta al nuevo precio", async () => {
    const seller = await register("counter-seller@example.com", "Counter Seller");
    const buyer = await register("counter-buyer@example.com", "Counter Buyer");
    const publicationId = await publish(seller.token, { title: "Heladera usada", category: "home", price: 500 });

    const offer = await api(`/publications/${publicationId}/offers`, {
      method: "POST",
      token: buyer.token,
      body: { amount: 400 },
    });

    const countered = await api(`/offers/${offer.data.id}/respond`, {
      method: "POST",
      token: seller.token,
      body: { action: "counter", counterAmount: 450 },
    });
    expect(countered.data.status).toBe("countered");

    // El vendedor ya no puede volver a responder la oferta original: espera al comprador.
    const secondAttempt = await api(`/offers/${offer.data.id}/respond`, {
      method: "POST",
      token: seller.token,
      body: { action: "accept" },
    });
    expect(secondAttempt.response.status).toBe(409);

    const accepted = await api(`/offers/${offer.data.id}/respond-to-counter`, {
      method: "POST",
      token: buyer.token,
      body: { action: "accept" },
    });
    expect(accepted.data.status).toBe("accepted");

    const operations = await api("/me/operations", { token: buyer.token });
    expect(operations.data.items[0].amount).toBe(450);
    expect(operations.data.items[0].type).toBe("buy");
  });

  test("consigna 9: no se puede calificar pasados los 7 días de la entrega", async () => {
    const seller = await register("late-review-seller@example.com", "Late Seller");
    const buyer = await register("late-review-buyer@example.com", "Late Buyer");
    const publicationId = await publish(seller.token, { title: "Ventilador de pie", category: "home", price: 80 });

    const offer = await api(`/publications/${publicationId}/offers`, {
      method: "POST",
      token: buyer.token,
      body: { amount: 80 },
    });
    const accepted = await api(`/offers/${offer.data.id}/respond`, {
      method: "POST",
      token: seller.token,
      body: { action: "accept" },
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    db.run(sql`UPDATE operations SET completed_at = ${eightDaysAgo} WHERE id = ${accepted.data.operationId}`);

    const review = await api(`/operations/${accepted.data.operationId}/reviews`, {
      method: "POST",
      token: buyer.token,
      body: { rating: 5 },
    });
    expect(review.response.status).toBe(409);
    expect(review.data.error.code).toBe("REVIEW_WINDOW_EXPIRED");
  });

  test("consigna 2: el perfil se puede editar con foto de perfil", async () => {
    const user = await register("avatar-user@example.com", "Avatar User");
    const updated = await api("/me", {
      method: "PATCH",
      token: user.token,
      body: { avatarUrl: "https://example.com/avatar.jpg" },
    });
    expect(updated.data.avatarUrl).toBe("https://example.com/avatar.jpg");

    const me = await api("/me", { token: user.token });
    expect(me.data.avatarUrl).toBe("https://example.com/avatar.jpg");
    expect(me.data.hasPassword).toBe(true);
  });

  test("registro sin contraseña: se puede agregar después vía OTP y luego loguearse con ella", async () => {
    const email = "no-password-user@example.com";
    const registerCode = await requestOtp(email, "registration");
    const registered = await api("/auth/otp/verify", {
      method: "POST",
      body: { email, purpose: "registration", code: registerCode, name: "No Password" },
    });
    expect(registered.response.status).toBe(200);

    const profileWithoutPassword = await api("/me", { token: registered.data.session.token });
    expect(profileWithoutPassword.data.hasPassword).toBe(false);

    // Sin contraseña todavía no puede loguearse por password.
    const failedLogin = await api("/auth/login/password", {
      method: "POST",
      body: { email, password: "newpassword123" },
    });
    expect(failedLogin.response.status).toBe(401);

    // El código no se consume si falla por falta de password, así que se puede reintentar con el mismo.
    const setPasswordCode = await requestOtp(email, "set_password");
    const withoutPassword = await api("/auth/otp/verify", {
      method: "POST",
      body: { email, purpose: "set_password", code: setPasswordCode },
    });
    expect(withoutPassword.response.status).toBe(422);
    expect(withoutPassword.data.error.code).toBe("PASSWORD_REQUIRED");

    const setPassword = await api("/auth/otp/verify", {
      method: "POST",
      body: { email, purpose: "set_password", code: setPasswordCode, password: "newpassword123" },
    });
    expect(setPassword.response.status).toBe(200);
    expect(setPassword.data.userId).toBe(registered.data.userId);

    const profileWithPassword = await api("/me", { token: setPassword.data.session.token });
    expect(profileWithPassword.data.hasPassword).toBe(true);

    const login = await api("/auth/login/password", {
      method: "POST",
      body: { email, password: "newpassword123" },
    });
    expect(login.response.status).toBe(200);
    expect(login.data.userId).toBe(registered.data.userId);
  });

  test("consigna 9: operaciones con contraparte normalizada, permiso y plazo de calificación", async () => {
    const seller = await register("op-seller@example.com", "Op Seller");
    const buyer = await register("op-buyer@example.com", "Op Buyer");
    const stranger = await register("op-stranger@example.com", "Op Stranger");
    await api("/me", { method: "PATCH", token: seller.token, body: { avatarUrl: "https://example.com/seller.jpg" } });
    const publicationId = await publish(seller.token, { title: "Escritorio", category: "home", price: 200 });
    const offer = await api(`/publications/${publicationId}/offers`, { method: "POST", token: buyer.token, body: { amount: 200 } });
    const accepted = await api(`/offers/${offer.data.id}/respond`, { method: "POST", token: seller.token, body: { action: "accept" } });
    const operationId = accepted.data.operationId as string;

    const asBuyer = (await api("/me/operations", { token: buyer.token })).data.items[0];
    expect(asBuyer).toMatchObject({
      type: "buy",
      counterpartyId: seller.id,
      counterpartyName: "Op Seller",
      counterpartyAvatarUrl: "https://example.com/seller.jpg",
      canReview: true,
    });
    const asSeller = (await api("/me/operations", { token: seller.token })).data.items[0];
    expect(asSeller).toMatchObject({
      type: "sell",
      counterpartyId: buyer.id,
      counterpartyName: "Op Buyer",
      counterpartyAvatarUrl: null,
      canReview: true,
    });
    const deadline = new Date(asBuyer.reviewDeadline).getTime();
    expect(Math.abs(deadline - (Date.now() + 7 * 86_400_000))).toBeLessThan(10_000);

    // Detalle individual: mismos datos, y sólo para las partes.
    const detail = await api(`/operations/${operationId}`, { token: buyer.token });
    expect(detail.data).toEqual(asBuyer);
    const foreign = await api(`/operations/${operationId}`, { token: stranger.token });
    expect(foreign.response.status).toBe(404);
    expect(foreign.data.error.code).toBe("OPERATION_NOT_FOUND");
    expect((await api(`/operations/${operationId}`)).response.status).toBe(401);

    // Un ajeno no puede calificar; el comprador sí, pero una sola vez.
    const foreignReview = await api(`/operations/${operationId}/reviews`, { method: "POST", token: stranger.token, body: { rating: 1 } });
    expect(foreignReview.response.status).toBe(403);
    expect(foreignReview.data.error.code).toBe("NOT_PARTICIPANT");

    const review = await api(`/operations/${operationId}/reviews`, { method: "POST", token: buyer.token, body: { rating: 4, comment: "Todo salió bien" } });
    expect(review.response.status).toBe(200);
    const duplicate = await api(`/operations/${operationId}/reviews`, { method: "POST", token: buyer.token, body: { rating: 1 } });
    expect(duplicate.response.status).toBe(409);
    expect(duplicate.data.error.code).toBe("REVIEW_ALREADY_EXISTS");

    const afterReview = (await api(`/operations/${operationId}`, { token: buyer.token })).data;
    expect(afterReview).toMatchObject({ myRating: 4, canReview: false });
    // El vendedor todavía puede calificar.
    expect((await api(`/operations/${operationId}`, { token: seller.token })).data.canReview).toBe(true);

    // Vencido el plazo: canReview pasa a false y el backend rechaza la reseña.
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    db.run(sql`UPDATE operations SET completed_at = ${eightDaysAgo} WHERE id = ${operationId}`);
    const expired = (await api(`/operations/${operationId}`, { token: seller.token })).data;
    expect(expired.canReview).toBe(false);
    expect(new Date(expired.reviewDeadline).getTime()).toBeLessThan(Date.now());
    const late = await api(`/operations/${operationId}/reviews`, { method: "POST", token: seller.token, body: { rating: 5 } });
    expect(late.data.error.code).toBe("REVIEW_WINDOW_EXPIRED");
  });

  test("consigna 2: los comentarios recibidos son públicos y paginados", async () => {
    const seller = await register("reviews-seller@example.com", "Reviews Seller");
    const buyers = [] as { id: string; token: string }[];
    for (let index = 0; index < 3; index++) {
      const buyer = await register(`reviews-buyer-${index}@example.com`, `Reviewer ${index}`);
      buyers.push(buyer);
      const publicationId = await publish(seller.token, { title: `Artículo reseñado ${index}`, category: "other", price: 10 });
      const offer = await api(`/publications/${publicationId}/offers`, { method: "POST", token: buyer.token, body: { amount: 10 } });
      const accepted = await api(`/offers/${offer.data.id}/respond`, { method: "POST", token: seller.token, body: { action: "accept" } });
      await api(`/operations/${accepted.data.operationId}/reviews`, {
        method: "POST",
        token: buyer.token,
        body: { rating: 5 - index, comment: `Comentario ${index}` },
      });
      // La reseña del vendedor al comprador no aparece en el perfil del vendedor.
      await api(`/operations/${accepted.data.operationId}/reviews`, { method: "POST", token: seller.token, body: { rating: 3 } });
    }

    const first = await api(`/users/${seller.id}/reviews?page=1&pageSize=2`);
    expect(first.response.status).toBe(200);
    expect(first.data.pagination).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    expect(first.data.items).toHaveLength(2);
    expect(first.data.items[0]).toMatchObject({ comment: "Comentario 2", rating: 3, reviewerName: "Reviewer 2", operationType: "sell" });
    expect(Object.keys(first.data.items[0]).sort()).toEqual(["comment", "createdAt", "id", "operationType", "rating", "reviewerName"]);

    const second = await api(`/users/${seller.id}/reviews?page=2&pageSize=2`);
    expect(second.data.items).toHaveLength(1);
    expect(second.data.items[0].comment).toBe("Comentario 0");

    // Desde el punto de vista del comprador calificado, la operación fue una compra.
    const asBuyer = await api(`/users/${buyers[0]!.id}/reviews`);
    expect(asBuyer.data.items[0]).toMatchObject({ rating: 3, reviewerName: "Reviews Seller", operationType: "buy" });

    const missing = await api(`/users/${crypto.randomUUID()}/reviews`);
    expect(missing.response.status).toBe(404);
    expect(missing.data.error.code).toBe("USER_NOT_FOUND");
  });

  test("consigna 7: ofertas con portada, contraparte y novedades (unreadCount / read)", async () => {
    const seller = await register("news-seller@example.com", "News Seller");
    const buyer = await register("news-buyer@example.com", "News Buyer");
    const stranger = await register("news-stranger@example.com", "News Stranger");
    const publicationId = await publish(seller.token, { title: "Amplificador", category: "electronics", price: 300 });

    const offer = await api(`/publications/${publicationId}/offers`, { method: "POST", token: buyer.token, body: { amount: 250 } });

    // La nueva oferta es una novedad para el vendedor, no para quien la hizo.
    const sellerView = await api("/me/offers", { token: seller.token });
    expect(sellerView.data.unreadCount).toBe(1);
    expect(sellerView.data.items[0]).toMatchObject({
      role: "seller",
      hasUpdate: true,
      coverImage: "https://images.example.com/bike.jpg",
      otherPartyId: buyer.id,
      otherPartyName: "News Buyer",
      otherPartyAvatarUrl: null,
    });
    const buyerView = await api("/me/offers", { token: buyer.token });
    expect(buyerView.data.unreadCount).toBe(0);
    expect(buyerView.data.items[0]).toMatchObject({ role: "buyer", hasUpdate: false, otherPartyId: seller.id, otherPartyName: "News Seller" });

    // Leer limpia sólo las novedades propias.
    expect((await api("/me/offers/read", { method: "POST", token: seller.token })).data.unreadCount).toBe(0);
    expect((await api("/me/offers", { token: seller.token })).data.unreadCount).toBe(0);

    // La contraoferta le avisa al comprador; su respuesta le avisa al vendedor.
    await api(`/offers/${offer.data.id}/respond`, { method: "POST", token: seller.token, body: { action: "counter", counterAmount: 280 } });
    expect((await api("/me/offers", { token: buyer.token })).data.unreadCount).toBe(1);
    expect((await api("/me/offers", { token: seller.token })).data.unreadCount).toBe(0);
    await api("/me/offers/read", { method: "POST", token: buyer.token });
    await api(`/offers/${offer.data.id}/respond-to-counter`, { method: "POST", token: buyer.token, body: { action: "accept" } });
    const afterAccept = await api("/me/offers", { token: seller.token });
    expect(afterAccept.data.unreadCount).toBe(1);
    expect(afterAccept.data.items[0].status).toBe("accepted");

    // Un tercero no tiene novedades ni puede leer las de otros.
    expect((await api("/me/offers", { token: stranger.token })).data).toEqual({ items: [], unreadCount: 0 });
    await api("/me/offers/read", { method: "POST", token: stranger.token });
    expect((await api("/me/offers", { token: seller.token })).data.unreadCount).toBe(1);
    expect((await api("/me/offers/read", { method: "POST" })).response.status).toBe(401);
  });

  test("consigna 7: detalle individual de una oferta, sólo para sus partes", async () => {
    const seller = await register("detail-seller@example.com", "Detail Seller");
    const buyer = await register("detail-buyer@example.com", "Detail Buyer");
    const stranger = await register("detail-stranger@example.com", "Detail Stranger");
    const publicationId = await publish(seller.token, { title: "Monitor", category: "electronics", price: 150 });
    const offer = await api(`/publications/${publicationId}/offers`, { method: "POST", token: buyer.token, body: { amount: 120, message: "Hola" } });

    const asBuyer = await api(`/offers/${offer.data.id}`, { token: buyer.token });
    expect(asBuyer.response.status).toBe(200);
    expect(asBuyer.data).toMatchObject({ id: offer.data.id, amount: 120, message: "Hola", role: "buyer", otherPartyId: seller.id, title: "Monitor" });
    const listed = (await api("/me/offers", { token: buyer.token })).data.items.find((item: { id: string }) => item.id === offer.data.id);
    expect(asBuyer.data).toEqual(listed);
    expect((await api(`/offers/${offer.data.id}`, { token: seller.token })).data.role).toBe("seller");

    const foreign = await api(`/offers/${offer.data.id}`, { token: stranger.token });
    expect(foreign.response.status).toBe(404);
    expect(foreign.data.error.code).toBe("OFFER_NOT_FOUND");
    expect((await api(`/offers/${crypto.randomUUID()}`, { token: buyer.token })).response.status).toBe(404);
  });

  test("consigna 7: errores estables al responder ofertas vencidas o publicaciones inactivas", async () => {
    const seller = await register("errors-seller@example.com", "Errors Seller");
    const buyer = await register("errors-buyer@example.com", "Errors Buyer");
    const publicationId = await publish(seller.token, { title: "Cámara", category: "electronics", price: 500 });

    const offer = await api(`/publications/${publicationId}/offers`, { method: "POST", token: buyer.token, body: { amount: 450 } });
    db.run(sql`UPDATE offers SET expires_at = ${new Date(Date.now() - 1000).toISOString()} WHERE id = ${offer.data.id}`);

    const respondExpired = await api(`/offers/${offer.data.id}/respond`, { method: "POST", token: seller.token, body: { action: "accept" } });
    expect(respondExpired.response.status).toBe(409);
    expect(respondExpired.data.error.code).toBe("OFFER_EXPIRED");
    const cancelExpired = await api(`/offers/${offer.data.id}/cancel`, { method: "POST", token: buyer.token });
    expect(cancelExpired.data.error.code).toBe("OFFER_EXPIRED");
    // Vencer también es una novedad para ambas partes.
    expect((await api("/me/offers", { token: buyer.token })).data.items[0]).toMatchObject({ status: "expired", hasUpdate: true });

    const counterExpired = await api(`/offers/${offer.data.id}/respond-to-counter`, { method: "POST", token: buyer.token, body: { action: "accept" } });
    expect(counterExpired.data.error.code).toBe("OFFER_EXPIRED");

    // Ofertar o preguntar en una publicación pausada o vendida -> PUBLICATION_NOT_ACTIVE.
    await api(`/publications/${publicationId}/status`, { method: "PATCH", token: seller.token, body: { status: "paused" } });
    const onPaused = await api(`/publications/${publicationId}/offers`, { method: "POST", token: buyer.token, body: { amount: 400 } });
    expect(onPaused.response.status).toBe(409);
    expect(onPaused.data.error.code).toBe("PUBLICATION_NOT_ACTIVE");
    const askPaused = await api(`/publications/${publicationId}/questions`, { method: "POST", token: buyer.token, body: { text: "¿Sigue disponible?" } });
    expect(askPaused.data.error.code).toBe("PUBLICATION_NOT_ACTIVE");
    const missing = await api(`/publications/${crypto.randomUUID()}/offers`, { method: "POST", token: buyer.token, body: { amount: 400 } });
    expect(missing.response.status).toBe(404);
    expect(missing.data.error.code).toBe("PUBLICATION_NOT_FOUND");
  });

  test("consigna 7/8: aceptar una oferta es atómico (operación, venta, otras ofertas y dirección)", async () => {
    const seller = await register("atomic-seller@example.com", "Atomic Seller");
    const winner = await register("atomic-winner@example.com", "Atomic Winner");
    const loser = await register("atomic-loser@example.com", "Atomic Loser");
    const publicationId = await publish(seller.token, { title: "Kayak", category: "sports", price: 900 });

    const winning = await api(`/publications/${publicationId}/offers`, { method: "POST", token: winner.token, body: { amount: 800 } });
    const losing = await api(`/publications/${publicationId}/offers`, { method: "POST", token: loser.token, body: { amount: 700 } });
    await api("/me/offers/read", { method: "POST", token: loser.token });

    const accepted = await api(`/offers/${winning.data.id}/respond`, { method: "POST", token: seller.token, body: { action: "accept" } });
    expect(accepted.data.status).toBe("accepted");

    expect((await api(`/publications/${publicationId}`, { token: seller.token })).data.status).toBe("sold");
    const losingOffer = (await api(`/offers/${losing.data.id}`, { token: loser.token })).data;
    expect(losingOffer).toMatchObject({ status: "rejected", hasUpdate: true });
    expect((await api("/me/operations", { token: winner.token })).data.items).toHaveLength(1);
    expect((await api("/me/operations", { token: loser.token })).data.items).toHaveLength(0);

    // La dirección se desbloquea sólo para comprador y vendedor.
    expect((await api(`/publications/${publicationId}`, { token: winner.token })).data.addressLocked).toBe(false);
    const asLoser = await api(`/publications/${publicationId}`, { token: loser.token });
    expect(asLoser.data.addressLocked).toBe(true);
    expect(asLoser.data.address).toBeNull();

    // Ya no se puede volver a aceptar (ni la ganadora ni la descartada).
    const again = await api(`/offers/${winning.data.id}/respond`, { method: "POST", token: seller.token, body: { action: "accept" } });
    expect(again.data.error.code).toBe("OFFER_ALREADY_RESOLVED");
    const discarded = await api(`/offers/${losing.data.id}/respond`, { method: "POST", token: seller.token, body: { action: "accept" } });
    expect(discarded.data.error.code).toBe("OFFER_ALREADY_RESOLVED");
  });

  test("consigna 7/8: si la publicación dejó de estar activa, aceptar no persiste nada", async () => {
    const seller = await register("rollback-seller@example.com", "Rollback Seller");
    const buyer = await register("rollback-buyer@example.com", "Rollback Buyer");
    const publicationId = await publish(seller.token, { title: "Carpa", category: "sports", price: 250 });
    const offer = await api(`/publications/${publicationId}/offers`, { method: "POST", token: buyer.token, body: { amount: 200 } });

    await api(`/publications/${publicationId}/status`, { method: "PATCH", token: seller.token, body: { status: "paused" } });
    const accept = await api(`/offers/${offer.data.id}/respond`, { method: "POST", token: seller.token, body: { action: "accept" } });
    expect(accept.response.status).toBe(409);
    expect(accept.data.error.code).toBe("PUBLICATION_NOT_ACTIVE");

    // La oferta sigue pendiente y no se creó ninguna operación.
    expect((await api(`/offers/${offer.data.id}`, { token: seller.token })).data.status).toBe("pending");
    expect((await api("/me/operations", { token: buyer.token })).data.items).toHaveLength(0);
  });
});
