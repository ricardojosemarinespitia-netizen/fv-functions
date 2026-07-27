// ============================================================
//  wompi-webhook  ·  Recibe los eventos de Wompi
// ------------------------------------------------------------
//  Wompi hace un POST a esta URL cada vez que una transacción
//  cambia de estado. Cuando el pago queda APROBADO:
//    1. Valida la firma del evento (WOMPI_EVENTS_SECRET)
//    2. Recupera el pedido guardado por save-pending (por referencia)
//    3. Lo registra en Google Forms (la "base de datos")
//    4. Envía los correos a Felipe y al cliente vía EmailJS
//
//  Así el pedido se registra AUNQUE el cliente cierre la ventana
//  de Wompi sin dar "Volver al comercio".
//
//  Variables de entorno requeridas en Netlify:
//    WOMPI_EVENTS_SECRET   -> Secreto de eventos (Wompi > Desarrolladores)
//    EMAILJS_PRIVATE_KEY   -> Private Key de EmailJS (Account > General)
// ============================================================
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// --- Configuración pública (igual que en checkout.html) ---
const EMAILJS_SERVICE_ID  = "service_bnw4s0x";
const EMAILJS_TPL_FELIPE   = "template_80c4173";  // notificación de pedido para Felipe
const EMAILJS_TPL_CLIENTE  = "template_20wj574";  // confirmación para el cliente
const EMAILJS_PUBLIC_KEY   = "XVjxIagv23vBCkzTX";
const EMAIL_FELIPE         = "felipevergelarteenvidrio@gmail.com";
const FORM_ID              = "1FAIpQLSflsK1YlaHGgdxFdOQ4pvnrF_cA0KUnLUVubAlO2eD3LBfm4Q";
const VENTAS_API           = "https://script.google.com/macros/s/AKfycbznN-5jCwKFFvSeKEiFuvaqwCW2DLv7OpQm6jCmEgH8w2qHIZtTfCPNsi3saPAv7j3s/exec";

const fmt = (n) => "$" + (Number(n) || 0).toLocaleString("es-CO");
const sepNum = (n) => (Number(n) || 0).toLocaleString("es-CO");

// Envía un correo usando la API REST de EmailJS (servidor, no navegador).
// Requiere que en EmailJS esté activado "Allow EmailJS API for non-browser
// applications" y la EMAILJS_PRIVATE_KEY como variable de entorno.
async function sendEmail(template_id, template_params) {
  const r = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params
    })
  });
  if (!r.ok) {
    throw new Error(`EmailJS ${r.status}: ${await r.text()}`);
  }
}

// ── Respaldo de verificación · SOLO si falta WOMPI_EVENTS_SECRET ──────────
//  Por que existe: antes el webhook fallaba ABIERTO (`if (secret && sig && …)`).
//  Endurecerlo a "sin secreto -> 503 y no proceso nada" cierra el agujero, pero
//  si esa variable no estuviera creada en Netlify el dia del despliegue se
//  dejarian de registrar TODAS las ventas en Google Forms y de enviar los dos
//  correos, en silencio (Wompi reintenta unas veces y desiste).
//  En vez de creerle al POST (inseguro) o de tirarlo (rompe el negocio), se le
//  pregunta a la fuente de verdad: la propia API de Wompi. Si Wompi confirma la
//  transaccion con la misma referencia, estado y monto, el evento es real.
//  Si Wompi no la confirma —o no responde— se rechaza igual que antes.
async function confirmarConWompi(tx) {
  if (!tx || !tx.id) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const cabeceras = { "Content-Type": "application/json" };
    // La llave publica puede viajar sin riesgo; algunos comercios la exigen.
    const pub = process.env.WOMPI_PUBLIC_KEY;
    if (pub) cabeceras.Authorization = "Bearer " + pub;

    const r = await fetch(
      "https://production.wompi.co/v1/transactions/" + encodeURIComponent(tx.id),
      { headers: cabeceras, signal: ctl.signal }
    );
    if (!r.ok) {
      console.error("wompi-webhook: Wompi respondio", r.status, "al confirmar", tx.id);
      return false;
    }
    const j = await r.json();
    const real = j && j.data;
    if (!real) return false;

    const refOk = String(real.reference) === String(tx.reference);
    const estadoOk = String(real.status) === String(tx.status);
    // El monto solo se compara si el evento lo trae (no bloquear por un campo ausente).
    const montoOk =
      tx.amount_in_cents == null ||
      Number(real.amount_in_cents) === Number(tx.amount_in_cents);

    return refOk && estadoOk && montoOk;
  } catch (e) {
    console.error("wompi-webhook: no se pudo confirmar la transaccion contra Wompi:", e.message);
    return false;
  } finally {
    clearTimeout(t);
  }
}

export default async (req) => {
  // 1) Leer el evento
  const raw = await req.text();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("JSON inválido", { status: 400 });
  }

  const tx = event && event.data && event.data.transaction;
  if (!tx) {
    return new Response("Sin transacción", { status: 200 });
  }

  // 2) Validar que el evento viene de Wompi — NUNCA se procesa a ciegas.
  //    Antes esto era `if (secret && sig && ...)`: si faltaba la variable de
  //    entorno, la validación se SALTABA y cualquier POST forjado se procesaba
  //    como un pago real (registro en Forms + correos).
  //
  //    Camino normal   -> firma del evento con WOMPI_EVENTS_SECRET.
  //    Camino degradado (sin esa variable) -> se confirma la transacción contra
  //      la API de Wompi, para que el negocio no se caiga si la variable falta.
  const secret = process.env.WOMPI_EVENTS_SECRET;
  const sig = event.signature;

  if (secret) {
    if (!sig || !Array.isArray(sig.properties) || !sig.checksum) {
      return new Response("Evento sin firma", { status: 401 });
    }

    const concat = sig.properties
      .map((path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), event.data))
      .join("");
    const calc = crypto
      .createHash("sha256")
      .update(concat + event.timestamp + secret)
      .digest("hex")
      .toUpperCase();

    const esperado = Buffer.from(calc, "utf8");
    const recibido = Buffer.from(String(sig.checksum).toUpperCase(), "utf8");
    // timingSafeEqual exige la misma longitud: si no coincide, ya es firma inválida.
    if (esperado.length !== recibido.length || !crypto.timingSafeEqual(esperado, recibido)) {
      return new Response("Firma inválida", { status: 401 });
    }
  } else {
    console.error(
      "wompi-webhook: falta WOMPI_EVENTS_SECRET en Netlify (Site settings > Environment " +
      "variables). Modo degradado: el evento se confirma contra la API de Wompi. " +
      "Configura la variable para volver al camino normal."
    );
    const confirmado = await confirmarConWompi(tx);
    if (!confirmado) {
      console.error("wompi-webhook: RECHAZADO, Wompi no confirma", tx.id, tx.reference);
      return new Response("Transacción no confirmada por Wompi", { status: 401 });
    }
    console.warn("wompi-webhook: evento aceptado por confirmación directa con Wompi:", tx.reference);
  }

  // 3) Solo actuamos cuando el pago está APROBADO
  if (tx.status !== "APPROVED") {
    return new Response(`Ignorado (estado ${tx.status})`, { status: 200 });
  }

  const ref = tx.reference;
  const store = getStore("pedidos");
  // Lectura con consistencia FUERTE: el webhook puede dispararse pocos segundos
  // después de save-pending; con la consistencia eventual por defecto el pedido
  // recién guardado a veces todavía no se ve y la venta se perdía sin más.
  // (Misma corrección que ya tenía el webhook de Alejandra.)
  let pedido = await store.get(ref, { type: "json", consistency: "strong" }).catch(() => null);

  // Reintento defensivo por si aún no propagó (hasta 3 intentos, 1,5 s c/u).
  for (let i = 0; !pedido && i < 3; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    pedido = await store.get(ref, { type: "json", consistency: "strong" }).catch(() => null);
  }

  if (!pedido) {
    return new Response(`Sin pedido pendiente para ${ref}`, { status: 200 });
  }

  // 4) Idempotencia: si ya se procesó (aquí o en el navegador), no repetir
  if (pedido._status === "done") {
    return new Response("Ya estaba procesado", { status: 200 });
  }

  // 5) Armar datos
  const cart = pedido.cart || [];
  const lineas = cart
    .map((i) => `${i.qty}x ${i.sku ? `[${i.sku}] ` : ""}${i.name} (${i.color}) - ${fmt(i.price * i.qty)}`)
    .join("\n");
  const entrega = `${pedido.address || ""}${pedido.city ? ", " + pedido.city : ""}`;
  const fechaHoy = new Date().toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" });

  // 6) Registrar en Google Forms (misma estructura que guardarPedido)
  try {
    const productos = cart
      .map((i) => `${i.qty}× ${i.sku ? `[${i.sku}] ` : ""}${i.name} (${i.color}) — ${fmt(i.price * i.qty)}`)
      .join(" | ");
    const qty = cart.reduce((s, i) => s + i.qty, 0);
    const desc = `PEDIDO #${ref} · ${pedido.email} · ${productos} · Total ${fmt(pedido.total)} [AUTO/WEBHOOK]`;
    const fd = new URLSearchParams();
    fd.append("entry.297753956", pedido.fullName || "");
    fd.append("entry.1064695391", entrega);
    fd.append("entry.1732518498", pedido.phone || "");
    fd.append("entry.1495498498", desc);
    fd.append("entry.932926498", String(qty));
    await fetch(`https://docs.google.com/forms/d/e/${FORM_ID}/formResponse`, { method: "POST", body: fd });
  } catch (e) {
    console.error("Google Forms:", e);
  }

  // 7) Correos (Felipe + cliente)
  const mensajeHtml =
    `<p style="font-family:-apple-system,sans-serif;font-size:14px;line-height:1.7;color:#d4e8e6;margin:0;">` +
    `<strong style="color:#FAF4ED;">Referencia:</strong> ${ref}<br>` +
    `<strong style="color:#FAF4ED;">Cliente:</strong> ${pedido.fullName}<br>` +
    `<strong style="color:#FAF4ED;">Correo:</strong> ${pedido.email}<br>` +
    `<strong style="color:#FAF4ED;">Teléfono:</strong> ${pedido.phone}<br>` +
    `<strong style="color:#FAF4ED;">Total:</strong> ${fmt(pedido.total)}<br>` +
    `<strong style="color:#FAF4ED;">Entrega:</strong> ${entrega}<br>` +
    `<strong style="color:#FAF4ED;">Piezas:</strong><br>${lineas.replace(/\n/g, "<br>")}</p>`;

  try {
    await sendEmail(EMAILJS_TPL_FELIPE, {
      nombre: pedido.fullName,
      to_email: EMAIL_FELIPE,
      asunto: `Nuevo pedido (pago confirmado) · ${ref} · ${fmt(pedido.total)}`,
      mensaje: mensajeHtml,
      email_cliente: pedido.email,
      telefono: pedido.phone,
      fecha: fechaHoy,
      referencia: ref,
      productos: lineas,
      codigo_descuento: pedido.discountCode || "",
      direccion: entrega,
      total: sepNum(pedido.total)
    });
  } catch (e) {
    console.error("Correo Felipe:", e);
  }

  try {
    await sendEmail(EMAILJS_TPL_CLIENTE, {
      nombre: pedido.fullName,
      to_email: pedido.email,
      asunto: `Tu pedido está confirmado · ${ref}`,
      mensaje: mensajeHtml,
      referencia: ref,
      productos: lineas,
      total: sepNum(pedido.total)
    });
  } catch (e) {
    console.error("Correo cliente:", e);
  }

  // 8) Marcar código de descuento como usado (si aplica)
  if (pedido.discountCode) {
    try {
      await fetch(VENTAS_API, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "markUsed", code: pedido.discountCode, ref, email: pedido.email })
      });
    } catch (e) {
      console.error("markUsed:", e);
    }
  }

  // 9) Marcar como procesado (idempotencia)
  await store.setJSON(ref, { ...pedido, _status: "done", _processedAt: Date.now() });

  return new Response("OK", { status: 200 });
};
