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

  // 2) Validar la firma del evento
  const secret = process.env.WOMPI_EVENTS_SECRET;
  const sig = event.signature;
  if (secret && sig && Array.isArray(sig.properties) && sig.checksum) {
    const concat = sig.properties
      .map((path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), event.data))
      .join("");
    const calc = crypto
      .createHash("sha256")
      .update(concat + event.timestamp + secret)
      .digest("hex")
      .toUpperCase();
    if (calc !== String(sig.checksum).toUpperCase()) {
      return new Response("Firma inválida", { status: 401 });
    }
  }

  // 3) Solo actuamos cuando el pago está APROBADO
  if (tx.status !== "APPROVED") {
    return new Response(`Ignorado (estado ${tx.status})`, { status: 200 });
  }

  const ref = tx.reference;
  const store = getStore("pedidos");
  const pedido = await store.get(ref, { type: "json" }).catch(() => null);

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

  // 8) Marcar como procesado (idempotencia)
  await store.setJSON(ref, { ...pedido, _status: "done", _processedAt: Date.now() });

  return new Response("OK", { status: 200 });
};
