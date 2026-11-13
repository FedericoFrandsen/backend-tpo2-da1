# Hallado API

Backend para la app Hallado de objetos y mascotas perdidas. Adaptado del código base del TP1 de Francisco Messina y del grupo, con Bun, TypeScript, Elysia, Drizzle y SQLite. No necesita instalar un servidor de base de datos.

## Requisitos y arranque

Bun 1.4.2 o superior. Abrí una terminal en esta carpeta:

```powershell
bun install --frozen-lockfile
```

Si es la primera instalación, creá el archivo de configuración:

```powershell
Copy-Item .env.example .env
```

Si ya tenés `.env`, conservalo; las variables nuevas tienen valores predeterminados. `OFFER_TTL_DAYS` del TP1 ya no se usa y puede borrarse.

```powershell
bun run db:seed
bun run dev
```

Las migraciones se aplican automáticamente. `db:seed` es opcional, idempotente y no cambia las contraseñas ni los datos existentes. Solo inserta registros de demostración que todavía no existen.

Para grabar los puntos **1, 4 y 5**, usar la demo separada y el [guion de grabación](docs/DEMO-145.md): detener el backend habitual, ejecutar `bun run demo:reset` y después `bun run demo`. Cada nueva toma conserva las anteriores y no modifica la base habitual. `bun run demo:prepare` prepara o verifica la toma actual sin levantar un servidor.

- Salud: http://localhost:3000/health
- Rutas: http://localhost:3000/docs
- Android Emulator: http://10.0.2.2:3000
- Celular físico: usá la IPv4 de tu PC, misma red Wi-Fi y acceso al puerto 3000 en el firewall.

El servidor escucha en `0.0.0.0`. La app Expo consume esta API real, así que el backend tiene que estar corriendo para usarla. La URL que usa la app se configura en el frontend con `EXPO_PUBLIC_API_URL`, y el contrato de cada grupo de endpoints está en `docs/INTEGRACION.md`.

## Reemplazar el backend que ya tenés

1. Detené el servidor con Ctrl+C.
2. Extraé este ZIP en una carpeta temporal; no trabajes dentro del archivo comprimido.
3. En PowerShell, dentro de la carpeta extraída, ejecutá el actualizador con la ruta de tu repositorio:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Actualizar-Hallado.ps1 -Destino "C:\Users\Fede\Downloads\backend-tpo2-da1-main"
```

El script valida que el destino tenga el backend del TP1/TP2, guarda una copia de los archivos que va a reemplazar en una carpeta hermana y actualiza el código. No ejecuta Git, no publica cambios y no copia `.git`, `.env`, `data`, `uploads` ni `node_modules`. Conserva tus migraciones y agrega las nuevas. La política `Bypass` aplica únicamente a ese proceso.

4. Volvé a la carpeta de tu repositorio y ejecutá:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun test
bun run db:seed
bun run dev
```

También podés copiar manualmente el contenido del ZIP sobre el repositorio y aceptar el reemplazo de archivos. En ese caso, reemplazá completas las carpetas `src` y `tests` para evitar que queden archivos viejos; conservá `.git`, `.env`, `data`, `uploads` y las migraciones previas. El ZIP no contiene dependencias, bases de datos, credenciales ni historial de Git.

## Usuarios de demostración

Se crean al ejecutar `bun run db:seed`, exclusivamente fuera de producción:

| Email | Contraseña para cuentas nuevas |
| --- | --- |
| sofia@hallado.com | Hallado123 |
| lucia@hallado.com | Hallado123 |
| martin@hallado.com | Hallado123 |

El seed está orientado a los puntos 1, 4 y 5: crea 11 publicaciones ficticias en Palermo, galerías con ilustraciones locales, un hallazgo y una pérdida de Lucía listos para consultar/reclamar, y publicaciones de Sofía en los cuatro estados (abierta, en reclamo, resuelta y vencida). Lucía tiene cinco devoluciones concretadas, valoraciones y la insignia Vecino solidario. La campera vencida lleva 31 días de antigüedad para demostrar su renovación sin esperar un mes.

Las fotos se copian de `assets/demo` a los uploads configurados y se sirven por las rutas normales de la API, con propietario registrado. No requieren una web externa. La respuesta privada de las llaves es `Nube` y no se ve en las imágenes. El [guion](docs/DEMO-145.md) detalla usuarios, casos, datos para completar y narración.

Repetir `bun run db:seed` también completa los placeholders de las publicaciones sin fotos del seed anterior, según su categoría, y de los ejemplos actuales que quedaron sin imágenes. Conserva las fotos ya elegidas y las publicaciones personales; no hace falta cargar manualmente una imagen por cada ejemplo.

Si una cuenta demo ya existía, se conserva su contraseña y perfil anterior. Repetir `db:seed` conserva las fechas y los cambios de las publicaciones existentes; tampoco elimina los ejemplos masivos del seed anterior. Para una demo limpia usar `demo:reset`: crea una base nueva bajo `data/demo-145/` y conserva las tomas anteriores. Reiniciar con `demo` reutiliza la toma actual sin revertir lo grabado. La demo respeta la configuración de correo: el modo consola permite ensayar OTP, pero no demuestra entrega real de email. Los borradores y la biometría se preparan en el dispositivo, no en el seed.

## Funcionalidades

- Registro con OTP: solicitud, comprobación sin crear cuenta y finalización con contraseña.
- Login por email/contraseña, sesiones Bearer y logout.
- Recupero con OTP, reenvío, expiración, cinco intentos y revocación de sesiones anteriores.
- Contraseñas con letras y números, entre 8 y 72 caracteres; hash Argon2 de Bun. Los tokens se guardan como SHA-256.
- Perfil editable: nombre, foto, barrio del catálogo, teléfono y consentimiento para compartirlo.
- Perfil público sin email, teléfono ni historial de publicaciones.
- Reputación calculada por devoluciones concretadas y valoraciones; insignia Vecino solidario al alcanzar cinco devoluciones. Una devolución la suma quien devolvió el objeto (el publicador de un hallazgo resuelto o el reclamante aceptado de un objeto perdido resuelto); quien solo recuperó lo suyo no suma.
- Búsqueda del tipo opuesto, categoría, palabras sin distinción de tildes/mayúsculas, barrio, períodos/rango, coordenadas y radio.
- Resultados paginados y ordenados por fecha o cercanía; hasta cinco búsquedas recientes por usuario.
- Publicaciones perdidas/encontradas: creación, edición, eliminación lógica, fotos y gestión de estados. Barrio del catálogo (91 entradas: CABA y GBA), dirección exacta y hora `HH:MM` obligatorios; la franja se deriva de la hora.
- Pregunta/respuesta de verificación del publicador (respuesta privada), reclamos con respuesta, foto de prueba privada y barrio, vencimiento a 30 días con renovación y alta idempotente por `clientId`.
- Reclamos: crear (el mensaje es opcional, salvo en un hallazgo viejo sin pregunta de verificación), aceptar, rechazar, cancelar y resolver una devolución; un único aceptado por publicación.
- Dirección exacta reservada al autor y al reclamante aceptado. Coordenadas públicas redondeadas a tres decimales; distancia redondeada a 0.1 km.
- Teléfono visible a la contraparte únicamente con reclamo aceptado y consentimiento vigente.
- Mensajes privados entre las partes de un reclamo aceptado, que pueden seguir consultándose tras resolverlo.
- Valoración positiva/negativa de la contraparte, una por persona y devolución concretada.
- Seguir publicaciones y recibir sus novedades.
- Alertas de búsqueda, coincidencias y notificaciones persistentes con estado de lectura.
- Subida autenticada de imágenes JPEG/PNG/WebP, hasta 5 MB por archivo y hasta cinco fotos por publicación.
- Sin push de Expo ni SMS: alertas, notificaciones y mensajes se consultan por HTTP.

La biometría, los permisos GPS, la selección de fotos y el almacenamiento seguro del token corresponden a Expo/dispositivo. El backend no solicita ni guarda datos biométricos.

## Códigos OTP por consola

La configuración inicial permite probar sin contratar ni configurar servicios. Con `EMAIL_MODE=console`, el código aparece en la terminal que ejecuta el servidor:

```text
[OTP] registration persona@ejemplo.com: 482915
```

Los códigos son aleatorios: **123456 no es un código fijo**. No se devuelven por HTTP. Vencen según `OTP_TTL_MINUTES` (10 por defecto), permiten cinco errores y requieren 30 segundos entre solicitudes. Al reenviar se invalida el anterior. `/auth/otp/check` no consume el código; `/auth/otp/verify` lo consume al completar la operación y vuelve a comprobarlo.

## Correo real (OTP)

Para enviar los códigos por email con Resend, cambiá estas variables en `.env` (los nombres están en `.env.example`):

```dotenv
EMAIL_MODE=resend
RESEND_API_KEY=tu_clave
EMAIL_FROM=Hallado <tu-remitente@tu-dominio.com>
```

| Variable | Qué hace |
| --- | --- |
| `EMAIL_MODE` | `console` (por defecto) o `resend`. Cualquier otro valor impide arrancar. |
| `RESEND_API_KEY` | Clave de API de Resend. Obligatoria con `resend`. |
| `EMAIL_FROM` | Remitente del mensaje, en el formato que acepte Resend. Obligatorio con `resend`. |
| `OTP_TTL_MINUTES` | Vencimiento del código en minutos (10 por defecto). Aparece en el texto del email. |

- Con `EMAIL_MODE=resend`, si falta `RESEND_API_KEY` o `EMAIL_FROM` el servidor no arranca y el error indica cuál falta.
- Con `NODE_ENV=production` la API no arranca con `EMAIL_MODE=console`.
- Si Resend no responde en 10 segundos o devuelve error, la API responde `503 EMAIL_DELIVERY_FAILED`.
- Reiniciá el servidor después de cambiar `.env`.

Estado de la prueba: el adaptador de Resend está implementado y las pruebas simulan las respuestas del proveedor. No se envió ningún email real ni se usaron credenciales reales. Documentación del envío: https://resend.com/docs/api-reference/emails/send-email

## Persistencia y migraciones

- `data/hallado.sqlite`: cuentas, sesiones y datos de Hallado.
- `uploads/`: imágenes subidas.
- `drizzle/`: migraciones versionadas.

La migración nueva es aditiva: conserva las tablas del TP1 y agrega las de Hallado bajo el prefijo `hallado_`; los usuarios reciben `share_phone=false` por defecto. Los datos de compraventa no se transforman en pérdidas/hallazgos ni se sirven por la nueva API. `src/db/legacy.ts` conserva el esquema previo únicamente para compatibilidad y generación de migraciones; no hay rutas de ofertas ni de precios en esta versión.

Se probó actualizar una base del TP1 y reabrir una base de Hallado en disco. Conservá tu base y tus imágenes juntas si necesitás mover datos a otra computadora. No borres las migraciones anteriores.

## Comandos

```powershell
bun run typecheck
bun test
bun run check
bun run db:migrate
bun run db:generate
bun run db:studio
bun run db:seed
bun run demo:prepare
bun run demo:reset
bun run demo
bun run start
```

`db:generate` solo se usa si modificás el esquema. No hace falta ejecutarlo para instalar este ZIP. El lockfile fija las dependencias probadas.

## Prueba rápida de login en PowerShell

Con el seed cargado y el servidor abierto:

```powershell
$login = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/auth/login/password" -ContentType "application/json" -Body '{"email":"sofia@hallado.com","password":"Hallado123"}'
$halladoHeaders = @{ Authorization = "Bearer $($login.session.token)" }
Invoke-RestMethod -Uri "http://localhost:3000/me" -Headers $halladoHeaders
```

La colección `docs/Hallado.postman_collection.json` se puede importar en Postman o en un cliente compatible. Contiene rutas, cuerpos de ejemplo y variables; captura el token al iniciar sesión. `api-endpoints.json` y `/docs` muestran el índice de rutas.

## Validación de la entrega

Las pruebas usan SQLite en memoria y carpetas temporales. Incluyen registro por etapas, contraseña requerida, OTP, concurrencia, recupero, logout, permisos, búsqueda, persistencia, reclamos, privacidad, mensajes, devoluciones, reputación, insignias, seguidores, alertas, imágenes y migración desde TP1. Las pruebas cubren solo el backend. La app Expo se verifica aparte, con `npx expo export --platform android` en el frontend (ver su README).

Además de los casos sueltos, el bloque «recorridos de punta a punta» de `tests/app.test.ts` encadena con dos cuentas el hallazgo completo (fotos y pregunta, evidencia, aceptar, teléfono según consentimiento de cada parte, propuesta y alternativa de encuentro, resolver, valorar y agradecer), el caso de pérdida (foto y barrio obligatorios, rechazo, cancelación y tres intentos), el registro con reenvío y vencimiento del OTP seguido de la recuperación de contraseña (el código anterior y la contraseña anterior dejan de servir y se revocan las sesiones previas), y la alerta por radio, las seguidas, las cinco devoluciones y el plazo de 7 días. Correr todo: `bun run check`.

Qué **no** está certificado: el envío real de correo con Resend (el adaptador solo se probó con respuestas simuladas del proveedor; falta una prueba con clave, dominio verificado y una casilla propia), y el uso desde la app en un Android real. Los servicios del frontend se ejercitaron una vez contra este servidor como proceso, con una base temporal y `EMAIL_MODE=console`; esa corrida no queda como prueba automática en el repositorio.

## Devolución por QR

- `GET /reclamos/:id/devolucion`: estado y rol de la persona autenticada.
- `POST /reclamos/:id/devolucion/qr`: quien devuelve obtiene una imagen PNG
  en `imagen` (data URI) y su vencimiento en `expiresAt`.
- `POST /reclamos/:id/devolucion/confirmar`: quien recupera envía
  `{ "codigo": "contenido leído del QR" }` para cerrar el caso.

Se comprueban las partes, el intento del reclamo, el código y su vencimiento
(15 minutos). Generar uno nuevo reemplaza el anterior. La confirmación y el
consumo del código se guardan en una transacción; repetir una confirmación
exitosa no duplica avisos ni modifica la fecha de devolución.

`qrcode` genera la imagen localmente, sin enviar datos a servicios externos.
La migración agrega `hallado_return_codes` y se aplica al iniciar el backend.
El endpoint anterior `/publicaciones/:id/resolver` se conserva para clientes
anteriores; la app actual usa el flujo de QR.

Pruebas específicas: `bun test tests/returns.test.ts`.
