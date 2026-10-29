# Contrato para conectar Expo

Este documento describe el contrato del backend y cómo lo consume la app Expo. La app ya usa la API real en todas sus pantallas; no hay datos simulados en el frontend.

## Endpoints que usa la app

Cada grupo está asociado al servicio del frontend (`services/*.js` en el repositorio `hallado`) que lo llama. La columna «Documentado aquí» indica si este archivo tiene sección de contrato para ese grupo.

| Grupo | Servicio / hook | Endpoints | Documentado aquí |
| --- | --- | --- | --- |
| Sesión | `hooks/useAuth.js`, `services/sesion.js` | `POST /auth/otp/request`, `POST /auth/otp/check`, `POST /auth/otp/verify`, `POST /auth/otp/resend`, `POST /auth/login/password`, `POST /auth/logout`, `GET /me` | Sí |
| Perfil | `services/perfiles.js` | `GET /me`, `PATCH /me`, `GET /usuarios/:id`, `POST /uploads/images` | Sí |
| Publicaciones y búsqueda | `services/publicaciones.js` | `GET /publicaciones`, `GET /publicaciones/:id`, `POST /publicaciones`, `PATCH /publicaciones/:id`, `DELETE /publicaciones/:id`, `POST /publicaciones/:id/renovar`, `GET /mis-publicaciones`, `POST /uploads/images`, `POST /uploads/pruebas` | Sí |
| Conexión | `services/conexion.js` | `GET /categorias` (sondeo de disponibilidad) | Sí |
| Seguidas | `services/publicaciones.js` | `GET /me/seguidas`, `POST` y `DELETE /publicaciones/:id/seguir` | Sí |
| Reclamos | `services/publicaciones.js` | `POST /publicaciones/:id/reclamos`, `GET /me/reclamos`, `GET /publicaciones/:id/reclamos`, `POST /reclamos/:id/aceptar`, `POST /reclamos/:id/rechazar` | Sí |
| Mensajes | `services/mensajes.js` | `GET` y `POST /reclamos/:id/mensajes` | Sí |
| Encuentros | `services/encuentros.js` | `GET` y `POST /reclamos/:id/encuentro`, `POST /reclamos/:id/encuentro/aceptar` | No; ver `/docs` |
| Devoluciones e historial | `services/historial.js` | `GET /me/historial`, `POST /publicaciones/:id/resolver`, `POST /publicaciones/:id/valoraciones`, `POST /publicaciones/:id/agradecimientos`, `GET /usuarios/:id/agradecimientos` | Parcial: resolver y valoraciones sí; historial y agradecimientos no, ver `/docs` |
| Alertas | `services/alertas.js`, `hooks/useAlertas.js` | `GET` y `POST /alertas`, `PATCH` y `DELETE /alertas/:id`, `POST /alertas/:id/leida` | Sí |
| Notificaciones | `services/notificaciones.js`, `hooks/useNovedades.js` | `GET /notificaciones`, `POST /notificaciones/:id/leida` | Sí |
| Imágenes | `components/ImagenPrivada.js` y URLs de `services/publicaciones.js` | `GET /uploads/:filename`; `GET /uploads/pruebas/:filename` enviando `Authorization` | Sí |

Notas de uso:

- La app toma la base de la API de `EXPO_PUBLIC_API_URL` (ver el README del frontend). Sin esa variable usa `http://10.0.2.2:3000`.
- La app no llama a `GET /barrios`: sus zonas vienen de la constante `ZONAS` del frontend (`data/searchDemo.js`). Esa lista tiene que coincidir con la del backend, porque el reclamo «Lo encontré» valida el barrio contra `GET /barrios`.
- La app no llama a `/me/busquedas`: las búsquedas recientes se guardan en el dispositivo.

## Cliente HTTP

- PC: `http://localhost:3000`
- Emulador Android: `http://10.0.2.2:3000`
- Dispositivo físico: `http://IP_DE_TU_PC:3000`
- En la app, la base se configura con `EXPO_PUBLIC_API_URL` (ver el README del frontend).
- JSON: `Content-Type: application/json`.
- Rutas privadas: `Authorization: Bearer <session.token>`.
- Guardar el token en Expo SecureStore. Al abrir la app, recuperarlo y pedir `GET /me`. Un 401 invalida la sesión local. La biometría solo desbloquea el acceso local a la sesión.
- Todas las respuestas de error tienen `{ "error": { "code": "...", "message": "..." } }`. Con Axios: `error.response?.data?.error?.message`.
- Las listas paginadas devuelven `{ items, page, pageSize, total, totalPages }`. Los parámetros son `page` y `pageSize` (1 a 100). Búsquedas recientes devuelven solo `{ items }`, con hasta cinco elementos.
- Las URLs de las imágenes son relativas: anteponer la URL base de la API al mostrarlas.
- Fechas de sucesos: `AAAA-MM-DD`; timestamps: ISO 8601. Los períodos relativos usan `APP_TIMEZONE`, Buenos Aires por defecto.

## Autenticación: useAuth

| Función actual | Petición real |
| --- | --- |
| solicitarCodigoRegistro(email) | POST `/auth/otp/request` con `{ email, purpose: "registration" }` |
| verificarCodigo(email, codigo) en registro | POST `/auth/otp/check` con `{ email, code: codigo, purpose: "registration" }` |
| registrar(email, codigo, contraseña) | POST `/auth/otp/verify` con `{ email, code: codigo, purpose: "registration", password: contraseña }` |
| iniciarSesion(email, contraseña) | POST `/auth/login/password` con `{ email, password: contraseña }` |
| solicitarRecupero(email) | POST `/auth/otp/request` con `{ email, purpose: "set_password" }` |
| verificarCodigo(email, codigo) en recupero | POST `/auth/otp/check` con `{ email, code: codigo, purpose: "set_password" }` |
| restablecerContraseña(email, codigo, contraseña) | POST `/auth/otp/verify` con `{ email, code: codigo, purpose: "set_password", password: contraseña }` |
| reenviarCodigo(email) | POST `/auth/otp/resend` con `{ email, purpose }`, manteniendo el propósito de la pantalla |
| cerrarSesion() | POST `/auth/logout` con el token actual |

Solicitud/comprobación de OTP no crea cuentas ni sesiones. Registro, recupero e ingreso devuelven:

```json
{
  "userId": "uuid",
  "usuario": { "id": "uuid", "email": "persona@ejemplo.com", "name": "persona" },
  "session": { "token": "token-opaco", "tokenType": "Bearer", "expiresAt": "fecha-ISO" }
}
```

El campo `usuario` real incluye el perfil privado completo. `hooks/useAuth.js` agrega `nombre: usuario.name` para que las pantallas sigan usando `nombre`. Después del recupero se puede usar la sesión nueva o volver al login. Las sesiones anteriores y los OTP de acceso emitidos antes del cambio quedan invalidados.

El parámetro `purpose` tiene que viajar entre pantallas: no se puede deducir solo del email. El código no se sustituye por una constante y se vuelve a verificar al guardar la contraseña. El login por OTP de TP1 (`purpose: "login"`) también se conserva para compatibilidad, aunque las pantallas de Hallado usan contraseña.

## Perfil: usePerfil y usePerfilPublico

- `GET /me`: perfil privado del token.
- `PATCH /me`: `{ name?, zone?, phone?, sharePhone?, avatarUrl? }`.
- `GET /usuarios/:id`: perfil público, sin teléfono, email ni historial.
- `GET /usuarios/:id/valoraciones`: valoraciones recibidas, paginadas.
- Compatibilidad: `/users/:id` y `/users/:id/reviews`.

Campos del perfil:

```json
{
  "id": "uuid",
  "name": "Federico",
  "zone": "Palermo",
  "avatarUrl": null,
  "memberSince": "fecha-ISO",
  "reputation": { "completedReturns": 5, "positiveReviews": 4, "negativeReviews": 1 },
  "badges": [{ "id": "vecino-solidario", "name": "Vecino solidario", "description": "Por concretar 5 devoluciones." }]
}
```

El perfil privado agrega email, username, phone, sharePhone y hasPassword. `sharePhone` es false por defecto. La API ignora campos como reputación o insignias al editar: se calculan a partir de devoluciones y valoraciones, no se aceptan contadores enviados por el cliente.

## Buscador y resultados

- `GET /categorias`: array de strings.
- `GET /barrios`: array de `{ nombre, latitud, longitud }`.
- Compatibilidad: `/categories` y `/zones`.
- `GET /publicaciones` requiere filtros del buscador guiado.

Ejemplo:

```text
/publicaciones?situacion=perdi&categoria=Llaves&zona=Palermo&periodo=semana&orden=recientes&page=1&pageSize=10
```

| Parámetro | Valores |
| --- | --- |
| situacion | perdi / encontre: la API devuelve publicaciones del tipo opuesto |
| categoria | Documentos, Llaves, Electrónica, Mascotas, Ropa, Otros |
| palabras | Texto opcional; deben aparecer todas las palabras en título/descripción |
| zona | Barrio/localidad; comparación sin distinguir tildes o mayúsculas |
| periodo | hoy / tresDias / semana / rango |
| desde, hasta | Obligatorios para rango; fechas válidas y no futuras |
| latitud, longitud | Alternativa a zona; puede combinarse con ella |
| radioKm | Con coordenadas: entre 0.1 y 500; por defecto 10 |
| orden | recientes / cercanos |
| page, pageSize | Paginación |

Al usar GPS, enviar `latitud` y `longitud` como parámetros planos, no el objeto `ubicacion`. Con un barrio de la lista se usa su centro para ordenar por cercanía. Para localidades fuera de la lista, enviar coordenadas si se desea ese orden. La búsqueda pública devuelve solo publicaciones abiertas y vigentes (las vencidas no aparecen); el detalle sigue accesible al cambiar de estado.

Cada resultado tiene `id, tipo, titulo, descripcion, categoria, barrio, fecha, franja, estado, fotos, latitud, longitud, ubicacion, distancia, creadaEn, actualizadaEn, resueltaEn, venceAt`.

`tipo` es **perdido/encontrado** en las respuestas. Al crear se aceptan también **perdi/encontre**, como manda hoy `CreatePostScreen`. `estado` es **abierta/en_reclamo/resuelta/vencida** (ver «Vencimiento y renovación»). La app usa `en_reclamo` tal como lo devuelve la API y toma `items` de la respuesta para paginar.

Una búsqueda autenticada se registra automáticamente en el historial:

- `GET /me/busquedas`: últimas cinco búsquedas únicas.
- `POST /me/busquedas`: cuerpo igual a los filtros del frontend; para guardar sin buscar.
- `DELETE /me/busquedas`: limpiar historial.

La app móvil no usa estos endpoints: guarda las búsquedas recientes en el dispositivo.

## Crear/editar publicaciones y fotos

- `POST /uploads/images`: multipart/form-data con un campo **file**. Devuelve `{ url, filename }`. Requiere token.
- Desde Expo: FormData con `file: { uri, name, type }`. Dejar que Axios/fetch genere el boundary de multipart.
- Subir primero las fotos locales; luego enviar sus URLs devueltas en `fotos`. No enviar `file://` ni URLs externas.
- `GET /uploads/:filename` sirve la imagen. Las imágenes subidas son públicas; evitá fotografiar datos personales o una dirección exacta que no quieras exponer.
- Fotos de comprobación (privadas): `POST /uploads/pruebas` (mismo multipart y mismas validaciones, requiere token) devuelve `{ url: "/uploads/pruebas/<uuid>.<ext>", filename }`. Se guardan aparte de las públicas y **no** sirven como foto de publicación ni avatar. `GET /uploads/pruebas/:filename` exige token y solo responde (200, `Cache-Control: private, no-store`) a quien la subió y al dueño de la publicación sobre la que existe un reclamo que la referencia; al resto 403 `FORBIDDEN`, sin sesión 401, inexistente 404 `PROOF_NOT_FOUND`. Para mostrarla en Expo hay que enviar el header `Authorization` en la petición de la imagen (`<Image source={{ uri, headers }} />`) y no cachearla en disco compartido.

```json
{
  "tipo": "encontre",
  "titulo": "Llaves con llavero azul",
  "descripcion": "Tres llaves y un llavero de color azul.",
  "categoria": "Llaves",
  "barrio": "Palermo",
  "ubicacion": { "latitud": -34.5889, "longitud": -58.4306 },
  "fecha": "2026-10-20",
  "franja": "tarde",
  "direccionExacta": "Dirección privada opcional",
  "fotos": ["/uploads/uuid.png"],
  "preguntaVerificacion": "¿Qué dibujo tiene el llavero?",
  "respuestaVerificacion": "Una estrella azul",
  "clientId": "0b0f7c3e-6d0a-4c53-9a1e-6c4c1d2b7f10"
}
```

- `preguntaVerificacion` (máx. 200, mínimo 3) y `respuestaVerificacion` (máx. 200) son **obligatorias al crear un `encontrado`** (422 `VERIFICATION_QUESTION_REQUIRED` / `VERIFICATION_ANSWER_REQUIRED`) y se ignoran (quedan `null`) en `perdido`. El dueño las edita con `PATCH`; no puede dejarlas vacías en un hallazgo que ya las tenía (los hallazgos creados antes de este contrato pueden seguir sin pregunta hasta que el dueño la cargue).
- **Privacidad**: `preguntaVerificacion` es pública solo en el detalle (`GET /publicaciones/:id`). `respuestaVerificacion` se devuelve únicamente al dueño (detalle con su sesión, `POST/PATCH /publicaciones`, `GET /mis-publicaciones`, y el objeto `publicacion` embebido en sus reclamos recibidos). Nunca aparece en búsquedas, detalle de terceros o anónimo, seguidas, alertas, notificaciones ni historial.
- `clientId` (opcional, string de 8 a 100 caracteres, p. ej. un UUID generado en el móvil) hace idempotente el alta: es único por usuario. Si se repite, `POST /publicaciones` devuelve **200** con la publicación ya creada (en lugar de 201 y un duplicado), sin validar de nuevo el cuerpo. Si esa publicación fue eliminada después, responde 409 `CLIENT_ID_ALREADY_USED`: generar un `clientId` nuevo. Pensado para reintentar la cola offline sin duplicar.

- `POST /publicaciones`: crear; devuelve 201 y el detalle.
- `PATCH /publicaciones/:id`: enviar solo campos editados. Solo el dueño y mientras está abierta.
- `DELETE /publicaciones/:id`: eliminación lógica, solo el dueño y si está abierta. Se conserva la trazabilidad; no se puede eliminar una devolución resuelta.
- `POST /publicaciones/:id/renovar`: solo el dueño; fija `venceAt` en ahora + 30 días y devuelve el detalle. 409 `PUBLICATION_LOCKED` si está resuelta, 404 si fue eliminada, 403 si no es el dueño.
- `GET /mis-publicaciones`: propias, paginadas; filtro opcional `estado` (`abierta`, `en_reclamo`, `resuelta`, `vencida`; otro valor da 422).
- Cambiar barrio sin coordenadas usa el centro del barrio de la lista. Con GPS y sin barrio se guarda la etiqueta "Ubicación actual". No se hace geocodificación externa.
- `direccionExacta` es opcional porque la pantalla de creación actual no la pide. Si se quiere coordinar por una dirección concreta, se puede añadir ese campo en la app o enviar un mensaje privado después de aceptar.

## Vencimiento y renovación

- Toda publicación tiene `venceAt` (ISO) = creación + 30 días. `POST /publicaciones/:id/renovar` lo reinicia a ahora + 30 días.
- El estado `vencida` es **derivado en lectura** (no se guarda): una publicación `abierta` con `venceAt` pasado se expone como `estado: "vencida"` en todas las respuestas. Así no hay tareas programadas ni cambios en el CHECK de estados.
- Las vencidas no aparecen en `GET /publicaciones`, no generan notificaciones de alertas (ni al reactivar una alerta), y no aceptan reclamos nuevos ni seguir (409 `PUBLICATION_EXPIRED`). Siguen visibles por id, en `GET /mis-publicaciones?estado=vencida`, en seguidas y en el historial del dueño. Renovar una vencida la vuelve a mostrar y avisa a las alertas que coinciden (una sola vez por alerta).
- Reclamos en curso: una publicación `en_reclamo` (reclamo aceptado) **no vence** mientras siga así; una `abierta` con un reclamo pendiente vigente (menos de 48 h) tampoco. Si el reclamo se vence, se rechaza o se cancela y `venceAt` ya pasó, la publicación pasa a `vencida` (el dueño puede renovarla). Resolver (`resuelta`) no vence nunca.
- Migración: las publicaciones existentes reciben `venceAt` = momento de la migración + 30 días, para no vencer de golpe datos previos o de demostración.

## Detalle y seguimiento: usePublicacion

- `GET /publicaciones/:id`: público; enviar token para acciones propias y visibilidad de datos.
- `POST /publicaciones/:id/seguir`: idempotente.
- `DELETE /publicaciones/:id/seguir`: idempotente.
- `GET /me/seguidas`: seguidas, paginadas.

El detalle agrega `preguntaVerificacion` (y `respuestaVerificacion` solo para el dueño), `publicador`, `esPropia`, `siguiendo`, `reclamoEnviado`, `reclamoAceptado`, `miReclamo`, `direccionExacta` y la `valoracion` que hizo el usuario actual. `publicador` tiene el formato del perfil público. Su teléfono solo aparece si el reclamo aceptado corresponde al usuario actual y el publicador eligió compartirlo. La dirección exacta es null para cualquier tercero sin ese reclamo aceptado. El propio autor siempre puede consultar la dirección que cargó.

## Reclamos y gestión: useGestionPublicacion

| Acción | Petición |
| --- | --- |
| Es mío / Lo encontré | POST `/publicaciones/:id/reclamos` con `{ mensaje, respuestaVerificacion?, fotoPrueba?, barrio? }` (ver reglas abajo) |
| Ver reclamos de una publicación propia | GET `/publicaciones/:id/reclamos` |
| Ver mis reclamos enviados | GET `/me/reclamos` |
| Consultar un reclamo como participante | GET `/reclamos/:id` |
| Aceptar como publicador | POST `/reclamos/:id/aceptar` |
| Rechazar como publicador | POST `/reclamos/:id/rechazar` |
| Cancelar como reclamante | POST `/reclamos/:id/cancelar` |
| Concretar devolución como publicador | POST `/publicaciones/:id/resolver` |
| Valorar contraparte | POST `/publicaciones/:id/valoraciones` con `{ positiva, comentario? }` |

Un reclamo incluye `id, publicacionId, usuarioId, usuario, perfil, mensaje, respuestaVerificacion, fotoPrueba, barrio, estado, intentos, maxIntentos, permiteTelefono, telefono, creadaEn, actualizadaEn`. `telefono` solo se completa si ese reclamo está aceptado, hay consentimiento y quien lo consulta participa. Los otros reclamantes no pueden consultar el listado del dueño.

Reglas del reclamo estructurado (`mensaje` sigue siendo obligatorio, 5 a 1000 caracteres; las validaciones nuevas se aplican después de las de duplicado/intentos):

| Reclamo | Sobre | Obligatorio | Error 422 |
| --- | --- | --- | --- |
| «Es mío» | publicación `encontrado` con pregunta | `respuestaVerificacion` (no vacía, máx. 200) | `VERIFICATION_ANSWER_REQUIRED` |
| «Lo encontré» | publicación `perdido` | `fotoPrueba` y `barrio` | `PROOF_PHOTO_REQUIRED`, `BARRIO_REQUIRED` |

- `barrio` debe estar en `GET /barrios` (sin distinguir tildes/mayúsculas; se guarda con el nombre canónico), si no 422 `INVALID_BARRIO`. Es opcional en «Es mío».
- `fotoPrueba` es la `url` (o el `filename`) devuelto por `POST /uploads/pruebas`, subida por el mismo reclamante: formato inválido o foto pública 422 `INVALID_PROOF`; foto de otra cuenta 403 `PROOF_NOT_OWNED`. Es opcional en «Es mío». Se guarda como `/uploads/pruebas/<uuid>.<ext>`.
- En «Lo encontré» se ignora `respuestaVerificacion`. En un reintento (hasta 3 intentos, vencimiento a 48 h sin cambios) se reemplazan los tres campos.
- `respuestaVerificacion`, `fotoPrueba` y `barrio` se devuelven solo a los participantes: el reclamante (`POST`, `GET /reclamos/:id`, `GET /me/reclamos`, `miReclamo` del detalle) y el dueño de la publicación (`GET /publicaciones/:id/reclamos`, `GET /reclamos/:id`, `GET /me/reclamos`). Para comparar, el dueño de un hallazgo lee `respuestaVerificacion` del reclamo y la suya en `publicacion.respuestaVerificacion` (embebida en `GET /reclamos/:id` y `GET /me/reclamos`) o en `GET /publicaciones/:id`.
- Reclamar una publicación vencida da 409 `PUBLICATION_EXPIRED`.

Estados: publicación abierta → aceptar reclamo → en_reclamo → resolver → resuelta. Solo hay un reclamo aceptado a la vez. Para aceptar otro, primero rechazar o cancelar el actual. Los demás pendientes se cierran al resolver. Rechazar/cancelar el aceptado revoca el acceso privado y vuelve a abrir la publicación. Una devolución resuelta no se reabre ni se edita.

Las dos partes pueden valorar a su contraparte una única vez tras resolver. Se usa el id de publicación para que el servidor determine quién es la contraparte: no se acepta valorar arbitrariamente a un usuario.

## Comunicación dentro de la app

- `GET /reclamos/:id/mensajes`: mensajes paginados, orden cronológico.
- `POST /reclamos/:id/mensajes`: `{ texto }`.
- Requiere un reclamo aceptado y participación como autor o reclamante. Un tercero recibe 403 y un reclamo sin aceptar 409.
- No requiere compartir teléfono. Tras resolver la devolución la conversación sigue disponible para las mismas partes.
- Transporte HTTP; la app puede consultar periódicamente. No se implementó WebSocket ni push de Expo.

## Alertas y notificaciones: useAlertas

- `POST /alertas`: `{ filtros }`, con el objeto que ya maneja SearchContext. La API normaliza y evita duplicados por usuario.
- `GET /alertas`: listas paginadas con `{ id, clave, filtros, activa, creadaEn, sinLeer }`.
- `PATCH /alertas/:id`: `{ activa: true/false }`.
- `DELETE /alertas/:id`.
- `POST /alertas/:id/leida`.
- `GET /notificaciones`: paginadas; agrega `sinLeer` total.
- `POST /notificaciones/:id/leida` y `POST /notificaciones/leidas`.

Una publicación nueva o editada que coincide con una alerta activa genera una notificación, excepto si es del mismo usuario. No se repite la misma coincidencia alerta/publicación. Al reactivar se revisan publicaciones creadas o actualizadas desde que se guardó la alerta. Al guardar una alerta no se notifican todas las coincidencias previas. Las notificaciones también incluyen novedades de seguidas, reclamos, devoluciones, mensajes y valoraciones. Se guardan en SQLite y se consultan desde la app; no se envían por email ni push.
