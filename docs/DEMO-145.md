# Guion de video — Hallado, puntos 1, 4 y 5

Basado en `TPO_Hallado.pdf`: punto 1 (página 1), punto 4 (página 2) y punto 5 (páginas 2–3). Duración orientativa: 12–15 minutos, sin contar esperas de OTP o preparación. Se puede cortar la espera entre tomas, manteniendo visible el resultado de cada acción.

## Preparar antes de grabar

1. Detener el backend habitual con Ctrl+C en su terminal. La demo usa el mismo puerto 3000 para que la app conserve su configuración.
2. Desde `backend-tpo2-da1`, ejecutar:

   ```powershell
   bun run demo:reset
   bun run demo
   ```

   `demo:reset` prepara una toma nueva. `demo` levanta esa toma y la conserva al reiniciar. La base y los uploads quedan en `data/demo-145/<toma>/`; las tomas anteriores y la base habitual no se borran. El puntero está en `data/demo-145/toma-actual.txt`. No usar `bun run dev` para esta grabación: ese comando abre la base habitual.

3. Confirmar que `http://localhost:3000/health` responde. Mantener esta terminal a mano si los OTP se imprimen por consola.
4. Abrir Hallado en los dos emuladores, conectados al mismo Expo. Si se usa la configuración local `EXPO_PUBLIC_API_URL=http://127.0.0.1:3000`, rehacer los reenvíos después de reiniciar un emulador:

   ```powershell
   adb -s emulator-5554 reverse tcp:3000 tcp:3000
   adb -s emulator-5556 reverse tcp:3000 tcp:3000
   adb -s emulator-5554 reverse tcp:8082 tcp:8082
   adb -s emulator-5556 reverse tcp:8082 tcp:8082
   ```

   Los IDs anteriores corresponden a estos dos emuladores; si cambiaron, consultar `adb devices`. Dejar el mismo servidor Expo en el puerto 8082. No hace falta recompilar la app por cambiar el seed.
5. Preparar en la galería de los dispositivos las imágenes `assets/demo/llaves-1.png`, `llaves-2.png` y `mochila-1.png`, o fotos propias. Confirmar antes que cámara y selector de galería funcionan. Las siete imágenes incluidas son ilustraciones, se sirven desde el backend y no dependen de internet externo.
6. Preparar una huella y bloqueo de pantalla en los ajustes Android del primer emulador, o usar un teléfono con biometría. Probar la simulación de huella desde los controles del emulador. El seed no configura sensores ni enrola huellas.
7. Tener una casilla sin cuenta para mostrar registro. Si se usa correo real, debe ser una casilla propia que se pueda abrir durante la grabación. En modo consola se puede usar `grabacion@example.com` en una toma nueva.
8. Revisar que no haya un borrador de un ensayo anterior en la cuenta Sofía; descartarlo desde la app antes de empezar. Una toma nueva renueva el backend, pero no borra borradores, fotos ni ajustes biométricos del dispositivo. Cerrar las sesiones anteriores para ingresar a la nueva base.

### Qué mostrar sobre el OTP

La demo respeta `EMAIL_MODE` de tu configuración. Con `EMAIL_MODE=console`, el código aleatorio se lee en la terminal: eso permite ensayar el flujo, pero **no demuestra entrega de email**. Para mostrar literalmente el envío exigido en la consigna, configurar previamente `EMAIL_MODE=resend`, remitente verificado y credenciales según el README, y mostrar la casilla real. No mostrar claves en el video. No usar `123456` como si fuera un código fijo.

El reenvío se habilita después de 30 segundos. Usar siempre el código más reciente: reenviar invalida el anterior. El vencimiento predeterminado es de 10 minutos. No afirmar que se demostró un código vencido si solo se mostró el reenvío.

## Cuentas y casos preparados

| Uso | Email | Contraseña inicial |
| --- | --- | --- |
| Dispositivo A: Sofía, quien consulta y publica en vivo | `demo@hallado.com` | `Hallado123` |
| Dispositivo B: Lucía, autora de las llaves y la mochila | `lucia@hallado.com` | `Hallado123` |
| Contraparte precargada de los auriculares | `martin@hallado.com` | `Hallado123` |

La cuenta creada en vivo es una cuarta cuenta y se usa para registro y recuperación. Después se cambia a Sofía para conservar un recorrido de demo predecible. Recuperar la contraseña de esa cuenta nueva evita alterar las claves de las cuentas del cuadro.

| Publicación | Autor | Estado inicial | Para qué se usa |
| --- | --- | --- | --- |
| Llaves encontradas en Plaza Italia | Lucía | Abierta | Galería de dos vistas, perfil, seguir, «Es mío» y dirección privada |
| Mochila azul perdida en Palermo | Lucía | Abierta | Detalle de una pérdida y acción «Lo encontré» |
| Billetera marrón encontrada | Sofía | Abierta | Gestión propia y edición opcional |
| Auriculares negros con reclamo aceptado | Sofía | En reclamo | Estado y acceso a gestión propia |
| Llaves del auto devueltas | Sofía | Resuelta | Estado resuelto |
| Campera verde pendiente de renovar | Sofía | Vencida | Plazo real de 30 días y renovación |

Lucía tiene además cinco casos resueltos con reclamos aceptados y valoraciones positivas. La reputación y la insignia «Vecino solidario» salen de esos datos, no de un valor fijo en el perfil. Hay 11 publicaciones en total. Todos los casos son ficticios y están ubicados en Palermo.

**Dato privado para las llaves de Lucía:** pregunta «¿Qué palabra está grabada en la llave pequeña?»; respuesta `Nube`. Esa palabra no aparece en las imágenes. Dirección ficticia: `Av. Santa Fe 4100, Palermo (dirección ficticia de demo)`. La dirección solo la ve el autor y, después de aceptar, la persona del reclamo aceptado; la respuesta privada sigue reservada al autor.

## Escena 1 — Presentación y registro (0:00–2:00)

**Pantalla:** dispositivo A, login, sin sesión. En B puede estar Lucía ya conectada.

**Decir:**

> Voy a mostrar los puntos 1, 4 y 5: autenticación, detalle de publicaciones y publicación de pérdidas y hallazgos. Uso dos dispositivos para ver las acciones del autor y de otra persona. Los datos precargados son ficticios; las acciones que vamos a realizar se guardan en el backend.

**Hacer:**

1. Entrar a registro y escribir la casilla elegida.
2. Tocar **Enviar código**. Mostrar brevemente dónde se recibió: casilla real o terminal, explicando el modo utilizado.
3. Ingresar el OTP recibido y pasar a definir contraseña. Usar `DemoVideo123` y su confirmación.
4. Terminar el registro y mostrar que se ingresa a la app.
5. Cerrar sesión e ingresar con ese email y `DemoVideo123` para mostrar el login por contraseña.

**Decir mientras se hace:**

> El registro se completa en etapas: email, validación del código y definición de contraseña. Después puedo volver a ingresar con email y contraseña.

**Debe verse:** cambio real del formulario de email al código, definición de contraseña, acceso autenticado y un login posterior. La cuenta no debe existir antes del registro.

## Escena 2 — Recuperación y reenvío (2:00–3:30)

**Hacer en A:**

1. Cerrar sesión y entrar a **recuperar contraseña**.
2. Usar el mismo email recién registrado y solicitar un código.
3. Esperar a que se habilite **Reenviar código**, tocarlo y mostrar la recepción del nuevo OTP. La espera puede cortarse en edición.
4. Ingresar el último código y definir `DemoVideo456` como nueva contraseña.
5. Intentar un ingreso con la anterior, `DemoVideo123`, y mostrar el rechazo. Después ingresar con `DemoVideo456`.

**Decir:**

> Si olvido mi contraseña puedo recuperarla con un código. También puedo pedir que lo reenvíen. Uso el último código recibido y defino una nueva clave. La contraseña anterior deja de permitir el ingreso.

**Debe verse:** el botón de reenvío utilizado y un ingreso exitoso con la nueva clave. No recuperar la cuenta Lucía ni Sofía en esta escena.

## Escena 3 — Activar y desactivar biometría (3:30–4:30)

**Hacer en A:**

1. Desde **Perfil → Configuración**, activar **Desbloquear con biometría**.
2. Completar la autenticación que solicite Android. Salir de la app a Inicio y volver.
3. Mostrar el bloqueo de la sesión y desbloquear con la huella preparada.
4. Volver a Configuración y desactivar el interruptor. Volver a salir y entrar para mostrar que ya no pide biometría.
5. Cerrar sesión y entrar como `demo@hallado.com` / `Hallado123` (Sofía). En B, Lucía usa `lucia@hallado.com` / `Hallado123`.

**Decir:**

> Desde la configuración puedo activar o desactivar el desbloqueo biométrico de esta sesión. La verificación la realiza el dispositivo.

**Debe verse:** el interruptor, el diálogo biométrico y ambos comportamientos al volver a la app. Si el control aparece deshabilitado por falta de huellas, preparar Android o usar un teléfono: mostrar solo el interruptor deshabilitado no demuestra el desbloqueo.

## Escena 4 — Detalle de un hallazgo (4:30–6:00)

**Hacer en A, como Sofía:**

1. En el buscador elegir **Perdí algo**, categoría **Llaves**, barrio **Palermo**, período **Última semana**.
2. Abrir **Llaves encontradas en Plaza Italia**, de Lucía.
3. Recorrer las dos imágenes. Mostrar descripción, categoría, fecha, hora/franja, barrio y estado **Abierta**.
4. Mostrar los datos de Lucía y abrir su perfil público: cinco devoluciones, valoraciones e insignia. Volver al detalle.
5. Tocar **Seguir**. Abrir la sección Seguidas para comprobar que aparece y volver al detalle.
6. Señalar **Es mío** y que todavía no aparece la dirección exacta.

**Decir:**

> El detalle reúne las imágenes y los datos del suceso. También puedo consultar quién publicó y su reputación. Como estoy mirando el hallazgo de otra persona, puedo seguirlo o indicar que es mío. Por privacidad, todavía no veo la dirección exacta.

**Debe verse:** galería, campos del detalle, reputación, perfil público, seguimiento y acción contextual. El buscador se usa para llegar al caso, sin dedicarle una demo completa del punto 3.

## Escena 5 — Dirección privada y mirada del autor (6:00–7:00)

**Hacer:**

1. En A, tocar **Es mío**, responder `Nube` y enviar. El mensaje adicional es opcional.
2. Antes de aceptar, volver al detalle y mostrar que la dirección sigue oculta.
3. En B, como Lucía, abrir **Mis publicaciones → Llaves encontradas en Plaza Italia**. Mostrar que el autor accede a la gestión de su publicación y al reclamo de Sofía.
4. Aceptar ese reclamo.
5. En A, volver a abrir o actualizar el detalle. Mostrar **En reclamo** y la dirección ahora visible a Sofía.

**Decir:**

> El autor tiene acceso a la gestión. Cuando acepta el reclamo, la publicación pasa a estar en reclamo y la dirección se comparte con la persona aceptada. Enviar la solicitud por sí solo no revela esa dirección.

**Debe verse:** antes y después desde el mismo usuario tercero. El autor siempre conoce su propia dirección. No hace falta coordinar encuentro ni completar devolución en esta escena: eso pertenece a otros puntos.

## Escena 6 — Detalle de una pérdida (7:00–7:40)

**Hacer en A:**

1. Buscar **Encontré algo → Otros → Palermo → Última semana**.
2. Abrir **Mochila azul perdida en Palermo**, de Lucía, y recorrer su galería.
3. Mostrar que la acción es **Lo encontré**, abrir el formulario y señalar foto de comprobación y barrio. Volver sin enviarlo.

**Decir:**

> La acción depende del tipo de publicación: en un hallazgo puedo decir “Es mío”; en una pérdida, “Lo encontré”. El formulario se adapta a la información que corresponde aportar.

**Debe verse:** el cambio de acción y su formulario. No decir que se envió un reclamo en esta escena, porque se vuelve sin enviarlo.

## Escena 7 — Publicar un hallazgo y recuperar borrador (7:40–10:30)

**Hacer en A, como Sofía:**

1. Entrar a publicar y elegir **Encontré algo**.
2. Probar **Sacar una foto**, conceder permiso y confirmar una captura. Si la cámara virtual no muestra el objeto, quitar esa imagen de prueba después de enseñar la miniatura. Agregar las dos ilustraciones de llaves desde **Elegir de la galería** y mantenerlas en la publicación.
3. Completar los siguientes datos:

   | Campo | Valor |
   | --- | --- |
   | Título | `Llaves con llavero azul - demo en vivo` |
   | Descripción | `Encontré dos llaves con un llavero azul al salir de la plaza. Las guardé para devolverlas a su dueño.` |
   | Categoría | Llaves |
   | Fecha | Ayer |
   | Hora | `16:20` |

4. Avanzar a ubicación. Salir a Inicio, cerrar la app desde recientes y abrirla otra vez. Entrar a publicar y mostrar **Tenés un borrador sin publicar → Retomar borrador**. Comprobar campos, fotos y paso restaurados. No usar Expo Reload para simular un cierre de la app.
5. Indicar **Palermo** y dirección exacta `Av. Santa Fe 4200, Palermo (demo)`. Mostrar también **usar ubicación actual** y conceder el permiso para evidenciar la captura de coordenadas. Si el emulador está ubicado fuera de CABA/GBA, configurar antes su ubicación de prueba en Palermo; volver a seleccionar el barrio correcto y verificar la dirección antes de publicar.
6. En el paso de verificación escribir:

   | Campo | Valor |
   | --- | --- |
   | Pregunta | `¿Qué número está escrito en la parte de atrás del llavero?` |
   | Respuesta privada | `27` |

   El número no debe aparecer en las imágenes utilizadas.

7. Tocar **Publicar mi hallazgo**, mostrar la confirmación y abrir la publicación. Verificar que está **Abierta** y tiene las imágenes elegidas.
8. En B, Lucía puede buscar la publicación por las palabras `demo en vivo` en **Perdí algo → Llaves → Palermo → Última semana**. Mostrar que otra cuenta ve el alta y la pregunta, pero no la respuesta `27` ni la dirección exacta.

**Decir:**

> La carga está guiada por pasos y admite cámara y galería. Completo los datos del suceso y su ubicación. Si interrumpo la carga, el borrador queda guardado en el dispositivo. Para un hallazgo agrego una pregunta sobre un detalle que no se ve en las fotos; su respuesta es privada. Al publicar, el registro queda disponible desde otra cuenta.

**Debe verse:** ambas fuentes de imágenes, fecha/hora, barrio/dirección, permiso y resultado GPS, borrador después de cerrar y reabrir, verificación privada y creación persistida. Usar ayer evita que una hora prefijada resulte futura.

## Escena 8 — Publicar una pérdida (10:30–11:30)

**Hacer en A:**

1. Iniciar otra publicación y elegir **Perdí algo**.
2. Seleccionar una imagen de mochila desde la galería.
3. Completar: título `Mochila azul - pérdida de demo`; categoría **Otros**; descripción `Perdí mi mochila azul con un cuaderno dentro cerca de Plaza Italia.`; fecha **Ayer**; hora `09:10`; barrio **Palermo**; dirección `Av. Santa Fe 4300, Palermo (demo)`.
4. Mostrar que no se solicita pregunta/respuesta de verificación del publicador en una pérdida. Publicarla y abrir su resultado.

**Decir:**

> También puedo publicar una pérdida. El formulario comparte los datos principales, pero no exige la pregunta de verificación propia de un hallazgo.

**Debe verse:** segundo tipo de publicación creado en vivo y confirmación. Esta escena es corta porque el borrador y los permisos ya se mostraron.

## Escena 9 — Mis publicaciones y renovación (11:30–13:00)

**Hacer en A:**

1. Abrir **Mis publicaciones** y mostrar los filtros **Abiertas**, **En reclamo**, **Resueltas** y **Vencidas**. Usar la billetera, los auriculares, las llaves del auto y la campera como casos de referencia. Las dos altas en vivo también aparecen en Abiertas.
2. Abrir una publicación propia abierta y mostrar el acceso a gestión. Como extra breve, editar el título de la billetera a `Billetera marrón con cierre`, guardar y comprobarlo en el listado.
3. Entrar a **Vencidas → Campera verde pendiente de renovar**. Mostrar el vencimiento y tocar **Renovar publicación**.
4. Comprobar que vuelve a **Abiertas** y muestra una nueva vigencia de 30 días. Si el filtro Vencidas queda vacío, cambiar a Abiertas para encontrarla.

**Decir:**

> Mis publicaciones reúne los estados de cada caso. Para mostrar el vencimiento sin esperar 30 días, este ejemplo fue precargado con una fecha de creación de hace 31 días y su vencimiento correspondiente. La renovación que acabo de realizar sí ocurre en vivo: vuelve a estar abierta y recibe un nuevo plazo de 30 días.

**Debe verse:** los cuatro estados antes de renovar, la acción de renovación y el estado/fecha después. Las devoluciones precargadas son ejemplos de estado; no afirmar que fueron completadas durante esta grabación.

## Cierre (13:00–13:20)

> Mostramos registro, ingreso, recuperación con reenvío y configuración biométrica; detalles con galería, reputación, acciones según el usuario y dirección privada; y publicación de hallazgos y pérdidas con fotos, ubicación, pregunta privada, borrador, gestión de estados y renovación.

## Control de cobertura antes de exportar el video

- **Punto 1:** registro OTP y contraseña; login; recupero y nueva contraseña; reenvío utilizado; biometría activada, desbloqueo real y desactivación.
- **Punto 4:** galería completa; descripción, categoría, fecha/franja, estado y barrio; publicador/reputación/perfil; «Es mío»; «Lo encontré»; seguir; gestión propia; dirección oculta y visible solo después de aceptar.
- **Punto 5:** ambos tipos creados en vivo; cámara y galería; título/descripción/categoría/fecha/hora; barrio/dirección/GPS; pregunta y respuesta privada; borrador recuperado tras cerrar; lista propia con cuatro estados; vencimiento de ejemplo y renovación en vivo.
- Si se usó OTP en consola o no se pudo demostrar biometría en el dispositivo, explicitarlo: no presentar esos apartados como envío de email real o desbloqueo probado.

## Repetir una toma y volver a la base habitual

Para repetir: detener `bun run demo`, ejecutar `bun run demo:reset` y luego `bun run demo`. Las claves vuelven a `Hallado123` en la nueva base y se conserva la toma anterior. Cerrar las sesiones viejas e ingresar de nuevo; los tokens pertenecían a la otra base. Los borradores locales se descartan desde la app si quedó alguno del ensayo.

Para volver a los datos habituales: detener la demo e iniciar `bun run dev`. No copiar la base de demo encima de `data/hallado.sqlite`. `bun run db:seed` usa la base configurada habitualmente, agrega los nuevos ejemplos de forma idempotente y conserva los registros antiguos; no es el comando para obtener una toma limpia.

## Qué se verificó automáticamente

`bun run check` incluye pruebas de ingreso con las cuentas del seed, cuatro estados, reputación e insignia, imágenes servidas por HTTP, propiedad de imágenes al editar, seguir/reclamar/aceptar, privacidad de dirección y respuesta, renovación y repetición del seed sin sobrescribir datos. Cámara, GPS, galería del dispositivo, biometría y entrega real de email se deben ensayar en los dispositivos: estas pruebas de backend no los certifican.
