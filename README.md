# fv-functions — backend de felipevergel.com

Funciones Netlify desplegadas en **exquisite-pasca-848b8b.netlify.app**.
El sitio (GitHub Pages) las llama por HTTPS. Aqui viven los secretos; en el navegador, ninguno.

| Funcion | Que hace | Quien la llama |
|---|---|---|
| `wompi-sign` | Recalcula el total desde el catalogo del servidor y devuelve la **firma de integridad** de Wompi | `checkout.html` antes de abrir la pasarela |
| `save-pending` | Guarda el pedido como `pending` en el blob store `pedidos` | `checkout.html` |
| `wompi-webhook` | Recibe el evento de Wompi, **valida su firma**, marca usado el código, registra el pedido en **Supabase** (Google Forms solo si Supabase falla) y manda los correos | Wompi |
| `vip-codigo` | Crea/recupera el FV20 (Supabase `codigos_descuento`), guarda el correo en `suscriptores`, verifica FV20 y FV15, responde "¿ya está en el Círculo?" | Círculo, `/vip`, caja de código |
| `ventas-registrar` | Pedidos por WhatsApp a Supabase (montos del catálogo del servidor, `estado_pago = PENDIENTE`); la hoja solo como respaldo | `checkout.html` |
| `enviar-correo` | Correos de pedido y del Círculo por Resend | `checkout.html` |

**Base de datos: Supabase** (proyecto `felipe-vergel-pedidos`): `suscriptores`, `codigos_descuento`,
`clientes`, `pedidos`, `pedidos_items`. La hoja de Google "PAGINA WEB" queda como respaldo histórico
de solo lectura. Esquema y migración: carpeta privada `10_CLIENTES/felipe-vergel/migracion-supabase/`.

`netlify/functions/lib/` no son funciones: son modulos compartidos (Netlify solo publica los
archivos que estan en la raiz de `netlify/functions`).

---

## Variables de entorno · SIN ESTO NO FUNCIONA

Netlify > Site configuration > Environment variables.

| Variable | La usa | Si falta |
|---|---|---|
| `WOMPI_INTEGRITY` | `wompi-sign` | Devuelve **503** y el checkout cae al respaldo antiguo (secreto en el navegador) |
| `WOMPI_EVENTS_SECRET` | `wompi-webhook` | Devuelve **503** y **no se registra ningun pedido por webhook** (falla cerrado, a proposito) |
| `RESEND_API_KEY` | `enviar-correo`, `wompi-webhook` | `enviar-correo` devuelve **503**; los correos del webhook fallan (el pedido igual se registra) |
| `RESEND_FROM` | `enviar-correo`, `wompi-webhook` | Se usa `Felipe Vergel <pedidos@felipevergel.com>` (aviso en el log); el dominio debe estar verificado en Resend |
| `EMAIL_FELIPE` | `enviar-correo`, `wompi-webhook` | Se usa `felipevergelarteenvidrio@gmail.com` (aviso en el log) |
| `BLACK_FRIDAY_ACTIVO` | `wompi-sign`, `enviar-correo` | Sin definir = campaña **activa**. `false` / `0` la apaga |
| `BLACK_FRIDAY_DESDE` | `wompi-sign`, `enviar-correo` | Se usa `BF_DESDE` = `2026-11-27T01:00:00-05:00` (inicio automático) |
| `BLACK_FRIDAY_HASTA` | `wompi-sign`, `enviar-correo` | Sin fecha de fin |
| `VIP_HASTA` | `vip-codigo`, `wompi-sign` | Vacío = los códigos FV20 no vencen |
| `SUPABASE_URL` | todas las que leen/escriben datos | Sin Supabase: **ningún código da descuento** (falla cerrado), `vip-codigo` responde 503 y guarda el correo en el blob `pendientes-supabase`, el webhook registra en Google Forms y `ventas-registrar` en la hoja (respaldos) |
| `SUPABASE_SERVICE_KEY` | ídem (service_role, ignora RLS) | Igual que la fila anterior. Nunca va al navegador ni al repo |
| `RESEND_DRY_RUN` | solo pruebas | `1` = arma los correos y los devuelve sin enviarlos. **No dejarlo puesto en producción** |

Los correos ya no usan EmailJS: `enviar-correo` (el sitio llama desde el navegador con
`{tipo, datos}`) y `wompi-webhook` comparten `lib/correos.js` (plantillas + API de Resend).
Pruebas sin red (Supabase falso local en `test/supabase-falso.mjs`): `npm test` y
`node pruebas/precios.test.mjs <products.js> <carpeta del sitio>`.

`WOMPI_INTEGRITY` es el **secreto de integridad** (empieza por `prod_integrity_`), no la
llave publica `pub_prod_...`. Wompi > Comercio > Desarrolladores.

---

## Orden de despliegue (importante, no saltarse pasos)

El valor actual del secreto de integridad estuvo publicado en `checkout.html`, es decir
**esta quemado**. Pero si se rota antes de que la funcion este viva, el checkout deja de
cobrar. El orden correcto:

1. Crear en Netlify `WOMPI_INTEGRITY` **con el valor que hoy tiene el sitio**.
2. Desplegar `fv-functions`.
3. Probar `wompi-sign`:

   ```bash
   curl -s -X POST https://exquisite-pasca-848b8b.netlify.app/.netlify/functions/wompi-sign \
     -H "Content-Type: application/json" \
     -H "Origin: https://felipevergel.com" \
     -d '{"ref":"FV-1753600000000-ABCDE","items":[{"id":"lampara-flor-colgante","qty":1}],"deliveryMethod":"domicilio"}'
   ```

   Debe responder `{"ok":true,...,"amountInCents":32200000,...}` (322.000 COP: 280.000 + 42.000
   de envio). Si responde `{"ok":false,"error":"sin-secreto"}`, falta el paso 1.
4. Hacer **una compra real de prueba** en felipevergel.com con la consola abierta. Si aparece
   `Firma local de respaldo`, la funcion no esta contestando: no continuar.
5. Solo cuando el paso 4 salga limpio: **rotar el secreto de integridad en Wompi**, actualizar
   `WOMPI_INTEGRITY` en Netlify y volver a probar.
6. Ultimo paso: borrar de `sitio-felipe-vergel/checkout.html` la constante `WOMPI_INTEGRITY`
   y el bloque marcado `RESPALDO HEREDADO`. Ahi queda cerrado C1.

---

## Precios en el servidor

`netlify/functions/lib/catalogo-precios.js` esta **generado** desde
`sitio-felipe-vergel/products.js`. Cada vez que cambie un precio:

```bash
cd fv-functions
node generar-catalogo.mjs
```

Si se olvida, el sitio muestra un total y el servidor firma otro: Wompi cobra el del servidor
y el cliente ve un numero distinto. El checkout ya avisa (actualiza el total en pantalla),
pero es una molestia evitable.

## FV20 emitidos antes de Supabase (migración perezosa)

Los FV20 pedidos con la versión anterior viven solo en Netlify Blobs (`vip-codigos`). `lib/vip-legado.js`
los busca allí cuando un código o un correo no está en Supabase (vip-codigo: solicitar, verificar,
registrado; wompi-sign; enviar-correo y ventas-registrar con FV20; wompi-webhook al marcar usado), los
copia a Supabase conservando `creado_en` y `usado`, y responde desde Supabase. Solo lee Blobs; si Blobs
falla se ignora. Si la copia no queda en Supabase, el código no da descuento ("sin-verificar").
`migrar-vip-blobs.mjs` sigue disponible para copiarlos todos de una vez.
