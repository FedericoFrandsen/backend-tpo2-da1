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
| demo@hallado.com | Hallado123 |
| lucia@hallado.com | Hallado123 |
| martin@hallado.com | Hallado123 |

Hay 216 publicaciones abiertas (las seis categorías y los seis primeros barrios del catálogo), devoluciones concretadas, reputación, insignia y un reclamo pendiente. El seed usa fechas relativas al día en que se ejecuta. Si volvés a ejecutarlo otro día, las publicaciones ya existentes conservan sus fechas; creá nuevas publicaciones para probar alertas nuevas.

Si una cuenta demo ya existía, se conserva su contraseña anterior. Las fotos de los ejemplos están vacías para que puedas probar la subida real desde la app. Para probar varios roles, usá cuentas diferentes.

## Funcionalidades

- Registro con OTP: solicitud, comprobación sin crear cuenta y finalización con contraseña.
- Login por email/contraseña, sesiones Bearer y logout.
- Recupero con OTP, reenvío, expiración, cinco intentos y revocación de sesiones anteriores.
- Contraseñas con letras y números, entre 8 y 72 caracteres; hash Argon2 de Bun. Los tokens se guardan como SHA-256.
- Perfil editable: nombre, foto, barrio, teléfono y consentimiento para compartirlo.
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
bun run start
```

`db:generate` solo se usa si modificás el esquema. No hace falta ejecutarlo para instalar este ZIP. El lockfile fija las dependencias probadas.

## Prueba rápida de login en PowerShell

Con el seed cargado y el servidor abierto:

```powershell
$login = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/auth/login/password" -ContentType "application/json" -Body '{"email":"demo@hallado.com","password":"Hallado123"}'
$halladoHeaders = @{ Authorization = "Bearer $($login.session.token)" }
Invoke-RestMethod -Uri "http://localhost:3000/me" -Headers $halladoHeaders
```

La colección `docs/Hallado.postman_collection.json` se puede importar en Postman o en un cliente compatible. Contiene rutas, cuerpos de ejemplo y variables; captura el token al iniciar sesión. `api-endpoints.json` y `/docs` muestran el índice de rutas.

## Validación de la entrega

Las pruebas usan SQLite en memoria y carpetas temporales. Incluyen registro por etapas, contraseña requerida, OTP, concurrencia, recupero, logout, permisos, búsqueda, persistencia, reclamos, privacidad, mensajes, devoluciones, reputación, insignias, seguidores, alertas, imágenes y migración desde TP1. Las pruebas cubren solo el backend. La app Expo se verifica aparte, con `npx expo export --platform android` en el frontend (ver su README).

Además de los casos sueltos, el bloque «recorridos de punta a punta» de `tests/app.test.ts` encadena con dos cuentas el hallazgo completo (fotos y pregunta, evidencia, aceptar, teléfono según consentimiento de cada parte, propuesta y alternativa de encuentro, resolver, valorar y agradecer), el caso de pérdida (foto y barrio obligatorios, rechazo, cancelación y tres intentos), el registro con reenvío y vencimiento del OTP seguido de la recuperación de contraseña (el código anterior y la contraseña anterior dejan de servir y se revocan las sesiones previas), y la alerta por radio, las seguidas, las cinco devoluciones y el plazo de 7 días. Correr todo: `bun run check`.

Qué **no** está certificado: el envío real de correo con Resend (el adaptador solo se probó con respuestas simuladas del proveedor; falta una prueba con clave, dominio verificado y una casilla propia), y el uso desde la app en un Android real. Los servicios del frontend se ejercitaron una vez contra este servidor como proceso, con una base temporal y `EMAIL_MODE=console`; esa corrida no queda como prueba automática en el repositorio.
