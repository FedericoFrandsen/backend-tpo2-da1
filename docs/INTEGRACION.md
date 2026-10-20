# Contrato para conectar Expo

Este documento describe el backend entregado. El ZIP no modifica el frontend: sus hooks todavía usan mocks. Se pueden conectar conservando los componentes y el manejo de loading/error.

## Cliente HTTP

- PC: `http://localhost:3000`
- Emulador Android: `http://10.0.2.2:3000`
- Dispositivo físico: `http://IP_DE_TU_PC:3000`
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

El campo `usuario` real incluye el perfil privado completo. El mock de auth usa `nombre`; se puede asignar `nombre: respuesta.usuario.name` sin cambiar las pantallas. Después del recupero se puede usar la sesión nueva o volver al login. Las sesiones anteriores y los OTP de acceso emitidos antes del cambio quedan invalidados.

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

Al usar GPS, enviar `latitud` y `longitud` como parámetros planos, no el objeto `ubicacion`. Con un barrio de la lista se usa su centro para ordenar por cercanía. Para localidades fuera de la lista, enviar coordenadas si se desea ese orden. La búsqueda pública devuelve solo publicaciones abiertas; el detalle sigue accesible al cambiar de estado.

Cada resultado tiene `id, tipo, titulo, descripcion, categoria, barrio, fecha, franja, estado, fotos, latitud, longitud, ubicacion, distancia, creadaEn, actualizadaEn, resueltaEn`.

`tipo` es **perdido/encontrado** en las respuestas. Al crear se aceptan también **perdi/encontre**, como manda hoy `CreatePostScreen`. `estado` es **abierta/en_reclamo/resuelta**; el mock de detalle que usa `enReclamo` debe adaptarse a `en_reclamo` al conectar. El frontend debe usar `items` del servidor y quitar la paginación local para no paginar dos veces.

Una búsqueda autenticada se registra automáticamente en el historial:

- `GET /me/busquedas`: últimas cinco búsquedas únicas.
- `POST /me/busquedas`: cuerpo igual a los filtros del frontend; para guardar sin buscar.
- `DELETE /me/busquedas`: limpiar historial.

## Crear/editar publicaciones y fotos

- `POST /uploads/images`: multipart/form-data con un campo **file**. Devuelve `{ url, filename }`. Requiere token.
- Desde Expo: FormData con `file: { uri, name, type }`. Dejar que Axios/fetch genere el boundary de multipart.
- Subir primero las fotos locales; luego enviar sus URLs devueltas en `fotos`. No enviar `file://` ni URLs externas.
- `GET /uploads/:filename` sirve la imagen. Las imágenes subidas son públicas; evitá fotografiar datos personales o una dirección exacta que no quieras exponer.

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
  "fotos": ["/uploads/uuid.png"]
}
```

- `POST /publicaciones`: crear; devuelve 201 y el detalle.
- `PATCH /publicaciones/:id`: enviar solo campos editados. Solo el dueño y mientras está abierta.
- `DELETE /publicaciones/:id`: eliminación lógica, solo el dueño y si está abierta. Se conserva la trazabilidad; no se puede eliminar una devolución resuelta.
- `GET /mis-publicaciones`: propias, paginadas; filtro opcional `estado`.
- Cambiar barrio sin coordenadas usa el centro del barrio de la lista. Con GPS y sin barrio se guarda la etiqueta "Ubicación actual". No se hace geocodificación externa.
- `direccionExacta` es opcional porque la pantalla de creación actual no la pide. Si se quiere coordinar por una dirección concreta, se puede añadir ese campo en la app o enviar un mensaje privado después de aceptar.

## Detalle y seguimiento: usePublicacion

- `GET /publicaciones/:id`: público; enviar token para acciones propias y visibilidad de datos.
- `POST /publicaciones/:id/seguir`: idempotente.
- `DELETE /publicaciones/:id/seguir`: idempotente.
- `GET /me/seguidas`: seguidas, paginadas.

El detalle agrega `publicador`, `esPropia`, `siguiendo`, `reclamoEnviado`, `reclamoAceptado`, `miReclamo`, `direccionExacta` y la `valoracion` que hizo el usuario actual. `publicador` tiene el formato del perfil público. Su teléfono solo aparece si el reclamo aceptado corresponde al usuario actual y el publicador eligió compartirlo. La dirección exacta es null para cualquier tercero sin ese reclamo aceptado. El propio autor siempre puede consultar la dirección que cargó.

## Reclamos y gestión: useGestionPublicacion

| Acción | Petición |
| --- | --- |
| Es mío / Lo encontré | POST `/publicaciones/:id/reclamos` con `{ mensaje }` |
| Ver reclamos de una publicación propia | GET `/publicaciones/:id/reclamos` |
| Ver mis reclamos enviados | GET `/me/reclamos` |
| Consultar un reclamo como participante | GET `/reclamos/:id` |
| Aceptar como publicador | POST `/reclamos/:id/aceptar` |
| Rechazar como publicador | POST `/reclamos/:id/rechazar` |
| Cancelar como reclamante | POST `/reclamos/:id/cancelar` |
| Concretar devolución como publicador | POST `/publicaciones/:id/resolver` |
| Valorar contraparte | POST `/publicaciones/:id/valoraciones` con `{ positiva, comentario? }` |

Un reclamo incluye `id, publicacionId, usuarioId, usuario, perfil, mensaje, estado, permiteTelefono, telefono, creadaEn, actualizadaEn`. `telefono` solo se completa si ese reclamo está aceptado, hay consentimiento y quien lo consulta participa. Los otros reclamantes no pueden consultar el listado del dueño.

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
