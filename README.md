# Marketplace API con Elysia

Backend para una app Android de compraventa. Incluye autenticación por OTP y contraseña, perfiles y reputación, publicaciones con borradores, imágenes, favoritos, búsquedas guardadas, preguntas, ofertas, operaciones y calificaciones. La persistencia usa Drizzle ORM sobre SQLite nativo de Bun.

## Requisitos y ejecución

- [Bun](https://bun.sh/) 1.2 o posterior.
- No requiere una base externa: Drizzle usa el driver `bun:sqlite`.

```bash
bun install
cp .env.example .env
bun run dev
```

En Windows PowerShell, el segundo comando se puede reemplazar por `Copy-Item .env.example .env`.

La API queda disponible en `http://localhost:3000`. `GET /health` verifica el estado y `GET /docs` devuelve un índice de rutas. Para probar:

```bash
bun run typecheck
bun test
```

## Base de datos con Drizzle

El esquema tipado está en `src/db/schema.ts`, la conexión y ejecución automática de migraciones en `src/database.ts`, y las migraciones versionadas en `drizzle/`. No hay consultas SQL directas en las rutas.

Después de modificar el esquema:

```bash
bun run db:generate
bun run db:migrate
```

> Si tu `data/marketplace.sqlite` es de antes de que se sacara el estado `draft` (commit que quitó
> el borrador server-side), la migración que endurece `publications` a `NOT NULL` va a fallar
> contra filas viejas incompletas. Como ese archivo es local y no se versiona, lo más simple es
> borrarlo y volver a correr `db:migrate` + `db:seed`.

Para inspeccionar los datos visualmente:

```bash
bun run db:studio
```

Para cargar datos de prueba (el comando es idempotente y no borra datos existentes):

```bash
bun run db:seed
```

El seed crea 4 usuarios con 5 publicaciones cada uno, además de favoritos, búsquedas, preguntas,
ofertas, una operación y reseñas. Los usuarios son `ana@example.com`, `bruno@example.com`,
`carla@example.com` y `diego@example.com`; todos pueden iniciar sesión con la contraseña `password123`.

Al iniciar la API también se aplican automáticamente las migraciones pendientes, incluyendo en los tests con una base SQLite en memoria.

## Estructura

```
src/
  index.ts       arranque del servidor
  app.ts         creación de la app, CORS, manejo de errores e índice de rutas
  config.ts      configuración leída del entorno (falla al arrancar si es inválida)
  database.ts    conexión SQLite y ejecución de migraciones
  auth.ts        sesiones: hash de token, requireUser / optionalUser
  queries.ts     consultas compartidas entre rutas (perfil público, imágenes)
  types.ts       constantes del dominio y schemas de validación reutilizables
  utils.ts       helpers sin dependencias (fechas, precios, paginación)
  db/schema.ts   esquema Drizzle
  routes/        auth, users, publications, interactions
```

Las rutas reciben la instancia de base por parámetro (`authRoutes(db)`), así los tests pueden
inyectar una base en memoria sin tocar el disco.

## Autenticación

1. Enviar `{ "email": "...", "purpose": "registration" }` a `POST /auth/otp/request`.
2. En desarrollo, la respuesta incluye `devCode`. En producción hay que conectar el envío de email en `src/routes/auth.ts`; el código nunca se devuelve si `NODE_ENV=production`.
3. Confirmar con `POST /auth/otp/verify`. En registro también acepta `name`, `username`, `password`, `phone` y `zone`.
4. Enviar el token resultante en las rutas privadas: `Authorization: Bearer <token>`.

Para entrar con OTP se usa `purpose: "login"`. También existe `POST /auth/login/password` con `{ "login": "email-o-usuario", "password": "..." }`. Los OTP vencen, se invalidan al reenviar, tienen espera de 30 segundos y se bloquean tras cinco intentos fallidos.

## Rutas principales

| Área | Método y ruta | Uso |
|---|---|---|
| Auth | `POST /auth/otp/request`, `/auth/otp/resend`, `/auth/otp/verify` | Registro y acceso por código |
| Auth | `POST /auth/login/password`, `POST /auth/logout` | Login tradicional y cierre de sesión |
| Perfil | `GET /me`, `PATCH /me` | Perfil privado (incluye `avatarUrl`; GET informa `hasPassword`) |
| Perfil | `GET /users/:id` | Reputación, antigüedad y publicaciones activas |
| Perfil | `GET /users/:id/reviews` | Comentarios y calificaciones recibidas, paginados |
| Home | `GET /publications` | Paginación, texto, categoría, precio, condición, zona y orden |
| Home | `GET /categories` | Categorías disponibles |
| Home | `GET /zones` | Zonas únicas de vendedores con publicaciones activas |
| Detalle | `GET /publications/:id` | Galería, vendedor, preguntas y acciones disponibles; dirección oculta hasta que se acepta una oferta |
| Publicación | `POST /publications` | Crear una publicación completa; la zona se hereda del perfil |
| Publicación | `PATCH /publications/:id` | Editar una publicación propia (incluida la dirección) |
| Publicación | `PATCH /publications/:id/status` | Pausar o reactivar |
| Publicación | `GET /me/publications` | Listar publicaciones propias por estado |
| Imágenes | `POST /uploads/images`, `GET /uploads/:filename` | Subir y servir JPG, PNG o WebP de hasta 5 MB (fotos de publicación o de perfil) |
| Favoritos | `POST/DELETE /publications/:id/favorite` | Agregar o quitar |
| Favoritos | `GET /me/favorites`, `POST /me/favorites/read` | Listado e indicador por cambios de precio |
| Búsquedas | `POST/GET /saved-searches` | Guardar filtros y ver novedades |
| Búsquedas | `POST /saved-searches/:id/read`, `DELETE /saved-searches/:id` | Marcar como leída o eliminar |
| Preguntas | `POST /publications/:id/questions`, `POST /questions/:id/answer` | Consulta y respuesta |
| Ofertas | `POST /publications/:id/offers`, `POST /offers/:id/respond` | Ofertar (con mensaje opcional) y aceptar/rechazar/contraofertar |
| Ofertas | `POST /offers/:id/respond-to-counter` | El comprador acepta o rechaza la contraoferta del vendedor |
| Ofertas | `POST /offers/:id/cancel`, `GET /me/offers` | Cancelar una oferta propia y listar las propias (vencen solas pasado su plazo); cada item trae portada, contraparte y `hasUpdate` |
| Ofertas | `GET /offers/:id` | Detalle de una oferta propia (misma forma que un item de `GET /me/offers`) |
| Ofertas | `POST /me/offers/read` | Marcar como leídas las novedades de las ofertas |
| Operaciones | `GET /me/operations`, `GET /operations/:id` | Historial filtrable por tipo y fecha, y detalle; incluyen contraparte, `canReview` y `reviewDeadline` |
| Operaciones | `POST /operations/:id/reviews` | Calificar a la contraparte (ventana de 7 días, una vez por parte) |

`GET /docs` devuelve este mismo índice en JSON. El contrato completo (cuerpos, respuestas y errores de cada endpoint) está en [`api-endpoints.json`](api-endpoints.json).

### Parámetros del home

`GET /publications` acepta `page`, `pageSize`, `q`, `category`, `minPrice`, `maxPrice`, `condition`, `zone` y `sort`. Los órdenes son `recent`, `price_asc` y `price_desc`. El filtro de zona compara contra la zona actual del perfil del vendedor.

Las condiciones son `new`, `like_new` y `used`. Las categorías se consultan con `GET /categories`
y las opciones vigentes del filtro de zona con `GET /zones`.

## Alta guiada e imágenes

El paso a paso de la carga (fotos, título, descripción, categoría, precio, condición, zona y
dirección) vive enteramente en la app Android: el borrador en progreso se guarda localmente en el
dispositivo, así que si la persona sale de la app lo encuentra conservado al volver. El backend no
tiene noción de borrador ni de pasos: recién recibe la publicación cuando está completa, vía
`POST /publications`, y esta queda `active` de inmediato.

Android sube cada foto como `multipart/form-data` a `POST /uploads/images` (campo `file`) y guarda
las URLs devueltas para mandarlas en `imageUrls` al crear o editar la publicación.

`POST /publications` exige título, descripción, categoría, precio, condición, dirección y al menos
una imagen; si falta algo, la validación del body lo rechaza con 422 antes de tocar la base. La zona
no se recibe ni se guarda en la publicación: siempre se obtiene de la zona actual del vendedor.

## Novedades y reputación

- Si cambia el precio de una publicación favorita, `GET /me/favorites` devuelve `hasUpdate` y `priceChanged`.
- Al publicar un artículo nuevo se incrementa `unreadCount` de cada búsqueda guardada compatible.
- Aceptar una oferta (directa o tras una contraoferta) es atómico: en una sola transacción crea la operación, marca el artículo como vendido y rechaza las demás ofertas pendientes. Si la publicación ya no está activa o la oferta ya se resolvió, no se persiste nada.
- Las ofertas tienen novedades por participante: una oferta nueva, una contraoferta, una respuesta, una cancelación o un vencimiento dejan `hasUpdate` en la otra parte. `GET /me/offers` devuelve `unreadCount` y `POST /me/offers/read` lo pone en cero.
- Comprador y vendedor pueden calificar una vez por operación, dentro de los 7 días de concretada. El servidor gobierna esa regla: cada operación informa `canReview` y `reviewDeadline`, y `POST /operations/:id/reviews` rechaza las calificaciones ajenas, repetidas o vencidas. El perfil público calcula promedio, cantidad de calificaciones, compras y ventas concretadas, y `GET /users/:id/reviews` lista los comentarios recibidos.

## Ofertas, dirección y mapa

- Una oferta tiene un plazo de vigencia (`OFFER_TTL_DAYS`) y pasa a `expired` automáticamente al vencer; esto se aplica de forma perezosa cada vez que se lee o se actúa sobre una oferta (`expireStaleOffers` en `src/queries.ts`), además de en un barrido al arrancar la app.
- El vendedor puede `accept`, `reject` o `counter` (con `counterAmount`) una oferta pendiente; si contraoferta, el comprador la resuelve en `POST /offers/:id/respond-to-counter`.
- La dirección exacta de una publicación (`address`) solo se devuelve en `GET /publications/:id` al vendedor o al comprador cuya oferta ya fue aceptada; el resto ve `addressLocked: true` y `address: null`.

## Errores

Todo error responde `{ "error": { "code": "...", "message": "..." } }`; el cliente debe decidir por `code`. Para ofertas y calificaciones los códigos estables son `OFFER_EXPIRED`, `OFFER_ALREADY_RESOLVED`, `PUBLICATION_NOT_ACTIVE`, `REVIEW_WINDOW_EXPIRED` y `REVIEW_ALREADY_EXISTS`. El catálogo completo está en `api-endpoints.json`.

## Biometría y modo sin conexión (consignas 1 y 6)

Ambos flujos son responsabilidad del cliente Android y no requieren endpoints propios:

- El desbloqueo por biometría protege localmente el token de sesión ya emitido (`BiometricPrompt` + Android Keystore); el backend sigue validando ese mismo token con `Authorization: Bearer`.
- El modo sin conexión cachea en el dispositivo (por ejemplo con Room) las respuestas de `GET /publications` y `GET /publications/:id` ya recibidas, y deshabilita las acciones que requieren red mientras no haya conectividad.

## Configuración

| Variable | Default | Descripción |
|---|---:|---|
| `PORT` | `3000` | Puerto HTTP |
| `DATABASE_PATH` | `data/marketplace.sqlite` | Archivo SQLite |
| `OTP_TTL_MINUTES` | `10` | Vigencia del código |
| `SESSION_DAYS` | `30` | Duración de la sesión |
| `OFFER_TTL_DAYS` | `3` | Plazo de vigencia de una oferta antes de vencer |
| `NODE_ENV` | `development` | En `production` oculta el OTP |

Para producción conviene reemplazar el almacenamiento local de imágenes por S3/Cloudinary, conectar un proveedor de correo, restringir CORS al dominio de la app/API y servir todo detrás de HTTPS.
