// ============================================================
//  lib/correos.js  ·  Plantillas + envío por Resend (servidor)
// ------------------------------------------------------------
//  Reemplaza a EmailJS. Lo usan DOS puertas de entrada:
//    - enviar-correo.js  (el sitio llama desde el navegador con {tipo, datos})
//    - wompi-webhook.js  (respaldo del lado servidor al aprobarse un pago)
//
//  Por qué es una función y no un fetch directo desde el navegador:
//  Resend exige una clave secreta (Authorization: Bearer re_...). En el
//  navegador quedaría pública. Aquí la clave solo existe como variable de
//  entorno de Netlify (RESEND_API_KEY) y NUNCA se escribe en el código.
//
//  Variables de entorno:
//    RESEND_API_KEY  (obligatoria)  clave de Resend
//    RESEND_FROM     (obligatoria)  "Felipe Vergel <pedidos@felipevergel.com>"
//    EMAIL_FELIPE    (obligatoria)  buzón donde Felipe recibe los avisos
//    RESEND_DRY_RUN  (solo pruebas) "1" = arma los correos y los devuelve
//                    en la respuesta SIN llamar a Resend (no hace falta clave).
//  Si RESEND_FROM o EMAIL_FELIPE faltan se usan los valores por defecto de
//  abajo y se deja un aviso en el log (mejor que perder un pedido).
//
//  Tipos de correo (lista cerrada):
//    "pedido"  -> aviso a Felipe + confirmación al cliente
//    "club"    -> bienvenida al Círculo (cliente) + aviso a Felipe (ya no lo usa el sitio)
//    "vip"     -> código personal FV20 (cliente) + aviso a Felipe. SOLO lo
//                 dispara la función vip-codigo (el código lo crea el servidor);
//                 el navegador no puede pedirlo por enviar-correo.
//
//  Anti-relay: el navegador NUNCA elige destinatario ni contenido libre.
//    - El aviso a Felipe va solo a EMAIL_FELIPE.
//    - El correo al cliente va al correo del propio formulario, y:
//        pedido: piezas, precios y totales se rehacen con el catálogo del
//                servidor (o se toman del pedido que guardó wompi-sign);
//        club:   el código se recalcula del correo (mismo hash que el sitio)
//                y tiene que coincidir.
//    - Sin enlaces en nombre, notas, dirección ni color; límites por IP,
//      por destinatario y global.
// ============================================================
import { CATALOGO, recalcularTotal, configBlackFriday, RE_CODIGO_VIP, RE_CODIGO_CIRCULO } from "./catalogo-precios.js";

export const ORIGENES_OK = ["https://felipevergel.com", "https://www.felipevergel.com"];

export const EMAIL_FELIPE_DEFECTO = "felipevergelarteenvidrio@gmail.com";
export const FROM_DEFECTO = "Felipe Vergel <pedidos@felipevergel.com>";
export const RESEND_URL = "https://api.resend.com/emails";
export const TIPOS = ["pedido", "club"];

const RE_REF = /^FV-\d{10,16}-[A-Z0-9]{1,12}$/;
const RE_CODIGO = /^FV15-[A-Z0-9]{7}$/;
const RE_CODIGO_PEDIDO = /^FV(10|15|20)-[A-Z0-9]{7}$/;
// Un solo buzón, sin espacios, comas, punto y coma ni saltos de línea.
const RE_EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
// Enlaces: nadie necesita una URL en su nombre, nota o dirección; un
// spammer sí. Se rechaza la solicitud completa.
const RE_ENLACE = /(https?:|ftp:|www\.|[a-z0-9-]+\.(com|co|net|org|info|biz|xyz|top|ru|io|ly|me|link|click|site|online|shop)(\/|\b))/i;

export const MAX_BODY = 24 * 1024; // bytes
export const MAX_QTY = 20;         // mismo tope que recalcularTotal()

export const esDryRun = (env) => ["1", "true", "si", "sí", "on", "yes"].includes(String((env && env.RESEND_DRY_RUN) || "").trim().toLowerCase());

// ─────────────────────────── utilidades ───────────────────────────

/** Escapa HTML: TODO dato que venga del usuario pasa por aquí. */
export function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Texto de una sola línea (sin saltos ni caracteres de control), recortado. */
function linea(v, max) {
  return String(v == null ? "" : v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Texto multilínea (notas): conserva \n, quita el resto de controles. */
function bloque(v, max) {
  return String(v == null ? "" : v)
    // eslint-disable-next-line no-control-regex
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, "")
    .trim()
    .slice(0, max);
}

const entero = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 1e10 ? n : 0;
};

/** $1.234.567 (es-CO) sin depender de la versión de ICU de Node. */
export const fmt = (n) => "$" + sepNum(n);
export const sepNum = (n) => String(entero(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

export function fechaHoy(now = new Date()) {
  try {
    return now.toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Bogota" });
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Código del Círculo de un correo. Copia EXACTA de fnv1a7() en index.html
 * del sitio ("FV15-" + 7 caracteres). Si cambia allí, cambia aquí.
 */
export function codigoClub(email) {
  const str = String(email || "").toLowerCase().trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h ^ str.charCodeAt(i), 0x01000193)) >>> 0;
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let j = 0; j < 7; j++) {
    out += chars[h % chars.length];
    h = (Math.imul(h, 16807) + 1013904223) >>> 0;
  }
  return "FV15-" + out;
}

// ─────────────────────── validación (entrada HTTP) ───────────────────────

const CAMPOS_PEDIDO = [
  "ref", "fullName", "email", "phone", "docId", "address", "city", "department",
  "zipCode", "notes", "deliveryMethod", "paymentMethod", "discountCode",
  "discountAmount", "subtotal", "shipping", "total", "cart",
  // Black Friday (informativos; el servidor los recalcula igual)
  "subtotalLista", "descuentoBF", "bfPct"
];
const CAMPOS_ITEM = ["id", "qty", "sku", "name", "color", "price", "precioLista"];
const CAMPOS_CLUB = ["nombre", "email", "codigo", "via"];
const METODOS_PAGO = ["pse", "whatsapp"];
const METODOS_ENTREGA = ["bucaramanga", "domicilio"];

const esObjeto = (o) => o && typeof o === "object" && !Array.isArray(o);

function desconocidos(obj, permitidos) {
  return Object.keys(obj).filter((k) => !permitidos.includes(k));
}

function textoOpcional(obj, k, max, err, { multi = false, sinEnlaces = false } = {}) {
  const v = obj[k];
  if (v == null || v === "") return "";
  if (typeof v !== "string") { err.push(`${k}: debe ser texto`); return ""; }
  if (v.length > max * 2) { err.push(`${k}: demasiado largo`); return ""; }
  if (sinEnlaces && RE_ENLACE.test(v)) { err.push(`${k}: no se permiten enlaces`); return ""; }
  return multi ? bloque(v, max) : linea(v, max);
}

function numeroOpcional(obj, k, err) {
  const v = obj[k];
  if (v == null || v === "") return 0;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e10) { err.push(`${k}: número inválido`); return 0; }
  return Math.round(v);
}

function emailValido(v, err, k = "email") {
  if (typeof v !== "string") { err.push(`${k}: obligatorio`); return ""; }
  const e = v.trim();
  if (e.length > 120 || !RE_EMAIL.test(e)) { err.push(`${k}: correo inválido`); return ""; }
  return e;
}

/** Valida y normaliza un pedido que llega del navegador (los montos aún NO son de confianza). */
export function validarPedido(datos) {
  const err = [];
  if (!esObjeto(datos)) return { ok: false, errores: ["datos: debe ser un objeto"] };
  const extra = desconocidos(datos, CAMPOS_PEDIDO);
  if (extra.length) err.push("campos no permitidos: " + extra.slice(0, 5).join(", "));

  const ref = typeof datos.ref === "string" ? datos.ref.trim() : "";
  if (!RE_REF.test(ref)) err.push("ref: formato inválido");

  const fullName = textoOpcional(datos, "fullName", 100, err, { sinEnlaces: true });
  if (!fullName) err.push("fullName: obligatorio");
  const email = emailValido(datos.email, err);

  const codigo = textoOpcional(datos, "discountCode", 20, err);
  if (codigo && !RE_CODIGO_PEDIDO.test(codigo)) err.push("discountCode: formato inválido");

  const paymentMethod = textoOpcional(datos, "paymentMethod", 30, err) || "pse";
  if (!METODOS_PAGO.includes(paymentMethod)) err.push("paymentMethod: valor no permitido");
  const deliveryMethod = textoOpcional(datos, "deliveryMethod", 30, err) || "domicilio";
  if (!METODOS_ENTREGA.includes(deliveryMethod)) err.push("deliveryMethod: valor no permitido");

  const cart = [];
  if (!Array.isArray(datos.cart) || datos.cart.length < 1 || datos.cart.length > 30) {
    err.push("cart: debe tener entre 1 y 30 piezas");
  } else {
    datos.cart.forEach((it, i) => {
      if (!esObjeto(it)) { err.push(`cart[${i}]: inválido`); return; }
      const x = desconocidos(it, CAMPOS_ITEM);
      if (x.length) err.push(`cart[${i}]: campos no permitidos`);
      const qty = it.qty;
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) err.push(`cart[${i}].qty: inválida`);
      const name = textoOpcional(it, "name", 120, err);
      if (!name) err.push(`cart[${i}].name: obligatorio`);
      cart.push({
        id: textoOpcional(it, "id", 80, err),
        qty: Number.isInteger(qty) ? qty : 1,
        sku: textoOpcional(it, "sku", 40, err),
        name,
        color: textoOpcional(it, "color", 60, err, { sinEnlaces: true }),
        price: numeroOpcional(it, "price", err)
      });
    });
  }

  // Se evalúan ANTES de mirar `err`, para que un campo malo también rechace.
  const limpio = {
    ref, fullName, email, cart, paymentMethod, deliveryMethod,
    phone: textoOpcional(datos, "phone", 30, err, { sinEnlaces: true }),
    docId: textoOpcional(datos, "docId", 30, err, { sinEnlaces: true }),
    address: textoOpcional(datos, "address", 200, err, { sinEnlaces: true }),
    city: textoOpcional(datos, "city", 80, err, { sinEnlaces: true }),
    department: textoOpcional(datos, "department", 80, err, { sinEnlaces: true }),
    zipCode: textoOpcional(datos, "zipCode", 12, err, { sinEnlaces: true }),
    notes: textoOpcional(datos, "notes", 600, err, { multi: true, sinEnlaces: true }),
    discountCode: codigo,
    discountAmount: numeroOpcional(datos, "discountAmount", err),
    subtotal: numeroOpcional(datos, "subtotal", err),
    shipping: numeroOpcional(datos, "shipping", err),
    total: numeroOpcional(datos, "total", err),
    subtotalLista: numeroOpcional(datos, "subtotalLista", err),
    descuentoBF: numeroOpcional(datos, "descuentoBF", err),
    bfPct: numeroOpcional(datos, "bfPct", err)
  };

  if (err.length) return { ok: false, errores: err.slice(0, 8) };
  return { ok: true, datos: limpiarPedido(limpio) };
}

/** Valida y normaliza una suscripción al Círculo. */
export function validarClub(datos) {
  const err = [];
  if (!esObjeto(datos)) return { ok: false, errores: ["datos: debe ser un objeto"] };
  const extra = desconocidos(datos, CAMPOS_CLUB);
  if (extra.length) err.push("campos no permitidos: " + extra.slice(0, 5).join(", "));
  const email = emailValido(datos.email, err);
  const nombre = textoOpcional(datos, "nombre", 80, err, { sinEnlaces: true }) || "coleccionista";
  const codigo = typeof datos.codigo === "string" ? datos.codigo.trim().toUpperCase() : "";
  if (!RE_CODIGO.test(codigo)) err.push("codigo: formato inválido");
  // El código sale del correo (mismo hash que el sitio): así nadie usa la
  // función para mandar códigos inventados a terceros.
  else if (email && codigo !== codigoClub(email)) err.push("codigo: no corresponde a ese correo");
  const via = datos.via == null || datos.via === "" ? "formulario" : datos.via;
  if (!["formulario", "google"].includes(via)) err.push("via: valor no permitido");
  if (err.length) return { ok: false, errores: err.slice(0, 8) };
  return { ok: true, datos: { nombre, email, codigo, via } };
}

/** Coerción SIN rechazo (para datos de confianza, p. ej. el pedido guardado por save-pending). */
export function limpiarPedido(p) {
  p = p || {};
  const cart = (Array.isArray(p.cart) ? p.cart : []).slice(0, 30).map((i) => ({
    qty: Math.min(50, Math.max(1, entero(i && i.qty) || 1)),
    sku: linea(i && i.sku, 40),
    name: linea(i && i.name, 120),
    color: linea(i && i.color, 60),
    price: entero(i && i.price),
    precioLista: entero(i && (i.precioLista != null ? i.precioLista : i.price)),
    id: linea(i && i.id, 80)
  }));
  return {
    ref: linea(p.ref, 40),
    fullName: linea(p.fullName, 100),
    email: linea(p.email, 120),
    phone: linea(p.phone, 30),
    docId: linea(p.docId, 30),
    address: linea(p.address, 200),
    city: linea(p.city, 80),
    department: linea(p.department, 80),
    zipCode: linea(p.zipCode, 12),
    notes: bloque(p.notes, 600),
    deliveryMethod: linea(p.deliveryMethod, 30),
    paymentMethod: linea(p.paymentMethod, 30),
    discountCode: linea(p.discountCode, 20),
    discountAmount: entero(p.discountAmount),
    subtotal: entero(p.subtotal),
    shipping: entero(p.shipping),
    total: entero(p.total),
    subtotalLista: entero(p.subtotalLista),
    descuentoBF: entero(p.descuentoBF),
    bfPct: entero(p.bfPct),
    avisoTotalNavegador: p.avisoTotalNavegador != null ? entero(p.avisoTotalNavegador) : null,
    cart
  };
}

/**
 * Rehace piezas y montos con el catálogo del SERVIDOR (lista + Black Friday
 * + envío + código), para que nadie pueda mandar un correo "de Felipe Vergel"
 * con piezas o precios inventados. Las piezas se buscan por id y, si no
 * llega, por SKU. Una pieza desconocida rechaza la solicitud.
 * Si el total que vio el cliente difiere, se avisa a Felipe (avisoTotalNavegador).
 */
export function recalcularPedido(p, env, { vipValido = false, circuloValido = false } = {}) {
  const porSku = new Map(Object.entries(CATALOGO).map(([id, x]) => [String(x.sku).toUpperCase(), id]));
  const ids = [];
  for (const i of p.cart) {
    const id = i.id && CATALOGO[i.id] ? i.id : porSku.get(String(i.sku || "").toUpperCase());
    if (!id) return { ok: false, error: "pieza-desconocida" };
    ids.push(id);
  }
  const bf = configBlackFriday(env);
  const esVip = RE_CODIGO_VIP.test(p.discountCode || "");
  const esCirculo = RE_CODIGO_CIRCULO.test(p.discountCode || "");
  // FV15: formato válido = se aplica (igual que la pantalla; Felipe confirma
  // por WhatsApp). FV20 y FV10: solo si Supabase los dio por válidos.
  const r = recalcularTotal(ids.map((id, k) => ({ id, qty: p.cart[k].qty })), p.deliveryMethod, !esVip && !esCirculo && !!p.discountCode, bf, { vip: esVip && vipValido, circulo: esCirculo && circuloValido });
  const cart = r.lineas.map((l, k) => ({
    id: l.id, qty: l.qty, sku: l.sku, name: l.nombre, color: p.cart[k].color, price: l.precio, precioLista: l.precioLista
  }));
  const datos = limpiarPedido({
    ...p,
    cart,
    subtotal: r.subtotal,
    discountAmount: r.descuento,
    discountCode: r.descuento > 0 ? p.discountCode : "",
    shipping: r.envio,
    total: r.total,
    subtotalLista: r.subtotalLista,
    descuentoBF: r.descuentoBF,
    bfPct: r.blackFriday.pct,
    avisoTotalNavegador: p.total && p.total !== r.total ? p.total : null
  });
  return { ok: true, datos };
}

// ─────────────────────────── plantillas ───────────────────────────
//  Marca: crema + terracota/ladrillo sobre el vino de la plantilla que ya
//  usaba EmailJS (email-templates/template-universal.html). Logo real por
//  URL pública del sitio. Tipografías: Cormorant Garamond (títulos) y Jost
//  (texto), con respaldo Georgia / Arial porque muchos clientes de correo no
//  cargan fuentes web.

const SANS = "'Jost',-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
const SERIF = "'Cormorant Garamond',Georgia,serif";
const C = { fondo: "#3a1c22", vino: "#572932", terracota: "#C66E4E", crema: "#FAF4ED", rosa: "#F3CFB3", texto: "#E7CDBC", suave: "#B89A8E" };
const SITIO = "https://felipevergel.com";

function envoltura({ asunto, nombre, saludo = true, cuerpo, cta = true }) {
  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(asunto)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;1,500&family=Jost:wght@300;400;600;700&display=swap');
body,table,td{margin:0;padding:0}
img{border:0;display:block;outline:none;text-decoration:none}
a{text-decoration:none}
@media only screen and (max-width:620px){.wrap{width:100%!important}.px{padding-left:24px!important;padding-right:24px!important}.h1{font-size:28px!important}}
</style></head>
<body style="margin:0;padding:0;background:${C.fondo};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.fondo};font-size:1px;">${esc(asunto)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.fondo};">
<tr><td align="center" style="padding:34px 16px 44px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${C.vino};border-radius:22px;overflow:hidden;">
<tr><td style="height:5px;background:${C.terracota};line-height:5px;font-size:5px;">&nbsp;</td></tr>
<tr><td align="center" class="px" style="padding:40px 48px 0;">
<img src="${SITIO}/img/logo/logo_blanco.png" width="110" alt="Felipe Vergel · Arte en Vidrio" style="width:110px;height:auto;margin:0 auto 18px;">
<div style="font-family:${SANS};font-size:11px;letter-spacing:4px;text-transform:uppercase;color:${C.rosa};font-weight:600;">&#10022;&nbsp;&nbsp;Arte en Vidrio&nbsp;&nbsp;&#10022;</div>
</td></tr>
<tr><td align="center" class="px" style="padding:20px 48px 0;">
<h1 class="h1" style="margin:0;font-family:${SERIF};font-style:italic;font-weight:500;font-size:34px;line-height:1.15;color:${C.crema};">${esc(asunto)}</h1>
</td></tr>
${saludo ? `<tr><td class="px" style="padding:20px 56px 0;"><p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.8;color:${C.rosa};font-weight:300;">Hola <strong style="color:${C.crema};font-weight:600;">${esc(nombre)}</strong>,</p></td></tr>` : ""}
<tr><td class="px" style="padding:16px 56px 0;">${cuerpo}</td></tr>
${cta ? `<tr><td align="center" style="padding:30px 48px 6px;"><table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td align="center" bgcolor="${C.terracota}" style="border-radius:999px;"><a href="${SITIO}/#catalogo" style="display:inline-block;padding:15px 38px;font-family:${SANS};font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700;color:${C.crema};border-radius:999px;">Ver cat&aacute;logo de piezas</a></td></tr></table></td></tr>` : ""}
<tr><td align="center" class="px" style="padding:32px 56px 44px;">
<p style="margin:0;font-family:${SERIF};font-style:italic;font-size:17px;line-height:1.6;color:${C.rosa};">&quot;El cristal es mi lenguaje: mi musa, mi motor y mi medio para crear arte que emociona.&quot;</p>
<p style="margin:10px 0 0;font-family:${SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.terracota};font-weight:600;">Felipe Vergel</p>
</td></tr>
</table>
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;"><tr><td align="center" style="padding:24px 40px 10px;">
<p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.7;color:${C.suave};font-weight:300;">Felipe Vergel &middot; Arte en Vidrio &middot; Floridablanca, Santander<br>
<a href="https://wa.me/573116214726" style="color:${C.rosa};">WhatsApp 311 621 4726</a>&nbsp;&middot;&nbsp;<a href="mailto:${EMAIL_FELIPE_DEFECTO}" style="color:${C.rosa};">${EMAIL_FELIPE_DEFECTO}</a></p>
</td></tr></table>
</td></tr></table>
</body></html>`;
}

const filaDato = (etq, val) =>
  `<tr><td style="padding:7px 0;font-family:${SANS};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${C.terracota};font-weight:700;width:34%;vertical-align:top;">${esc(etq)}</td><td style="padding:7px 0;font-family:${SANS};font-size:14px;line-height:1.6;color:${C.crema};vertical-align:top;">${val}</td></tr>`;

const CELDA = `padding:10px 18px;border-bottom:1px solid rgba(243,207,179,.12);font-family:${SANS};font-size:13px;`;

function lineasHtml(cart) {
  return cart
    .map((i) => `${esc(i.qty)}&times; ${i.sku ? `[${esc(i.sku)}] ` : ""}${esc(i.name)}${i.color ? ` (${esc(i.color)})` : ""} &mdash; ${fmt(i.price * i.qty)}`)
    .join("<br>");
}
function lineasTexto(cart) {
  return cart.map((i) => `${i.qty}x ${i.sku ? `[${i.sku}] ` : ""}${i.name}${i.color ? ` (${i.color})` : ""} - ${fmt(i.price * i.qty)}`).join("\n");
}

function datosDerivados(p, opts) {
  const esWhatsApp = p.paymentMethod === "whatsapp";
  return {
    esWhatsApp,
    metodoPago: esWhatsApp ? "WhatsApp (pago por confirmar)" : "PSE / Wompi",
    metodoEntrega: p.deliveryMethod === "bucaramanga" ? "Envío gratis · Zona metropolitana de Bucaramanga" : "Envío a domicilio",
    entrega: [p.address, p.city, p.department, p.zipCode ? "CP " + p.zipCode : ""].filter(Boolean).join(", "),
    fecha: fechaHoy(opts && opts.now)
  };
}

/** Correo de confirmación al cliente. */
function correoPedidoCliente(p, opts) {
  const d = datosDerivados(p, opts);
  const asunto = d.esWhatsApp ? `Recibimos tu pedido · ${p.ref}` : `Tu pedido está confirmado · ${p.ref}`;
  const intro = d.esWhatsApp
    ? `Recibimos tu solicitud de pedido. Felipe te escribirá por WhatsApp para confirmar el pago y coordinar la entrega. Una vez confirmado, tu pieza estará lista en aproximadamente <strong style="color:${C.crema};">8 días hábiles</strong>.`
    : `Tu pedido fue confirmado. Tu pieza entra al taller hoy y estará lista en aproximadamente <strong style="color:${C.crema};">8 días hábiles</strong>.`;
  // Black Friday: el ahorro va como línea informativa ANTES del subtotal
  // (el subtotal ya viene con precios finales), igual que en el carrito.
  const bf = p.descuentoBF > 0
    ? `<tr><td style="${CELDA}color:${C.suave};">Precio de lista &middot; Black Friday ${esc(p.bfPct)}&nbsp;%</td><td align="right" style="${CELDA}color:${C.rosa};">${fmt(p.subtotalLista)} &middot; -${fmt(p.descuentoBF)}</td></tr>` : "";
  const desc = p.discountAmount > 0
    ? `<tr><td style="${CELDA}color:${C.suave};">Descuento${p.discountCode ? " (" + esc(p.discountCode) + ")" : ""}</td><td align="right" style="${CELDA}color:${C.terracota};">-${fmt(p.discountAmount)}</td></tr>` : "";
  const cuerpo =
    `<p style="font-family:${SANS};font-size:15px;line-height:1.8;color:${C.texto};margin:0 0 20px;">${intro}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:rgba(243,207,179,0.07);border-radius:14px;overflow:hidden;margin-bottom:16px;">` +
    `<tr><td colspan="2" style="padding:12px 18px;border-bottom:1px solid rgba(243,207,179,.15);"><span style="font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${C.terracota};font-weight:700;">Referencia</span><br><span style="font-family:${SANS};font-size:18px;font-weight:700;color:${C.crema};letter-spacing:2px;">${esc(p.ref)}</span></td></tr>` +
    `<tr><td colspan="2" style="${CELDA}color:${C.texto};line-height:1.7;">${lineasHtml(p.cart)}</td></tr>` + bf +
    `<tr><td style="${CELDA}color:${C.suave};">Subtotal</td><td align="right" style="${CELDA}color:${C.rosa};">${fmt(p.subtotal)}</td></tr>${desc}` +
    `<tr><td style="${CELDA}color:${C.suave};">Envío</td><td align="right" style="${CELDA}color:${C.rosa};">${p.shipping > 0 ? fmt(p.shipping) : "Gratis"}</td></tr>` +
    `<tr><td style="padding:14px 18px;font-family:${SANS};font-size:13px;font-weight:700;color:${C.rosa};">Total</td><td align="right" style="padding:14px 18px;font-family:${SANS};font-size:20px;font-weight:700;color:${C.crema};">${fmt(p.total)}</td></tr></table>` +
    `<p style="font-family:${SANS};font-size:13px;line-height:1.7;color:${C.suave};margin:0;"><strong style="color:${C.rosa};">Entrega:</strong> ${esc(d.entrega) || "—"}<br><strong style="color:${C.rosa};">Fecha:</strong> ${esc(d.fecha)}` +
    `${p.notes ? `<br><strong style="color:${C.rosa};">Tu nota:</strong> ${esc(p.notes).replace(/\n/g, "<br>")}` : ""}</p>`;
  const texto =
    `Hola ${p.fullName},\n\n` +
    (d.esWhatsApp
      ? "Recibimos tu solicitud de pedido. Felipe te escribirá por WhatsApp para confirmar el pago y coordinar la entrega. Una vez confirmado, tu pieza estará lista en aproximadamente 8 días hábiles.\n\n"
      : "Tu pedido fue confirmado. Tu pieza entra al taller hoy y estará lista en aproximadamente 8 días hábiles.\n\n") +
    `Referencia: ${p.ref}\n${lineasTexto(p.cart)}\n\n` +
    (p.descuentoBF > 0 ? `Precio de lista: ${fmt(p.subtotalLista)}\nBlack Friday ${p.bfPct} %: -${fmt(p.descuentoBF)}\n` : "") +
    `Subtotal: ${fmt(p.subtotal)}\n` +
    (p.discountAmount > 0 ? `Descuento: -${fmt(p.discountAmount)}\n` : "") +
    `Envío: ${p.shipping > 0 ? fmt(p.shipping) : "Gratis"}\nTotal: ${fmt(p.total)}\n\nEntrega: ${d.entrega || "—"}\nFecha: ${d.fecha}\n` +
    (p.notes ? `Tu nota: ${p.notes}\n` : "") +
    `\nFelipe Vergel · Arte en Vidrio\nWhatsApp 311 621 4726 · ${EMAIL_FELIPE_DEFECTO}\n`;
  return { rol: "cliente", to: p.email, subject: asunto, html: envoltura({ asunto, nombre: p.fullName, cuerpo }), text: texto };
}

/** Aviso de nuevo pedido para Felipe. */
function correoPedidoFelipe(p, opts) {
  const d = datosDerivados(p, opts);
  const etiqueta = opts && opts.pagoConfirmado ? "Nuevo pedido (pago confirmado)" : d.esWhatsApp ? "Pedido por WhatsApp" : "Nuevo pedido";
  const asunto = `${etiqueta} · ${p.ref} · ${fmt(p.total)}`;
  const aviso = p.avisoTotalNavegador
    ? filaDato("Ojo", `En la pantalla del cliente el total era ${fmt(p.avisoTotalNavegador)}; el catálogo del servidor da ${fmt(p.total)}. Confírmalo con el cliente.`)
    : "";
  const cuerpo =
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 8px;">` +
    filaDato("Referencia", esc(p.ref)) +
    filaDato("Cliente", esc(p.fullName)) +
    filaDato("Cédula / NIT", esc(p.docId) || "—") +
    filaDato("Correo", esc(p.email)) +
    filaDato("Teléfono", esc(p.phone) || "—") +
    filaDato("Método de pago", esc(d.metodoPago)) +
    filaDato("Total", fmt(p.total)) + aviso +
    (p.descuentoBF > 0 ? filaDato(`Black Friday ${p.bfPct} %`, `Precio de lista ${fmt(p.subtotalLista)} &middot; ahorro ${fmt(p.descuentoBF)}`) : "") +
    (p.discountCode ? filaDato("Código descuento", esc(p.discountCode) + (p.discountAmount > 0 ? " (-" + fmt(p.discountAmount) + ")" : "")) : "") +
    filaDato("Dirección", esc(d.entrega) || "—") +
    filaDato("Tipo de envío", esc(d.metodoEntrega)) +
    filaDato("Notas del cliente", p.notes ? esc(p.notes).replace(/\n/g, "<br>") : "—") +
    filaDato("Fecha", esc(d.fecha)) +
    `</table>` +
    `<p style="font-family:${SANS};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${C.terracota};font-weight:700;margin:18px 0 8px;">Piezas</p>` +
    `<p style="font-family:${SANS};font-size:14px;line-height:1.8;color:${C.crema};margin:0;">${lineasHtml(p.cart)}</p>`;
  const texto =
    `${etiqueta}\n\nReferencia: ${p.ref}\nCliente: ${p.fullName}\nCédula / NIT: ${p.docId || "—"}\nCorreo: ${p.email}\nTeléfono: ${p.phone || "—"}\n` +
    `Método de pago: ${d.metodoPago}\nTotal: ${fmt(p.total)}\n` +
    (p.avisoTotalNavegador ? `OJO: en la pantalla del cliente el total era ${fmt(p.avisoTotalNavegador)}.\n` : "") +
    (p.descuentoBF > 0 ? `Black Friday ${p.bfPct} %: lista ${fmt(p.subtotalLista)}, ahorro ${fmt(p.descuentoBF)}\n` : "") +
    (p.discountCode ? `Código descuento: ${p.discountCode}\n` : "") +
    `Dirección: ${d.entrega || "—"}\nTipo de envío: ${d.metodoEntrega}\nNotas: ${p.notes || "—"}\nFecha: ${d.fecha}\n\nPiezas:\n${lineasTexto(p.cart)}\n`;
  return { rol: "felipe", to: null, subject: asunto, html: envoltura({ asunto, nombre: "Felipe", saludo: false, cta: false, cuerpo }), text: texto, replyToCliente: p.email };
}

function correoClubCliente(c, opts) {
  const asunto = "Bienvenido al Círculo · Tu 15% de descuento";
  // Durante Black Friday el código no se suma (BF_ACUMULA_CODIGO=false) y el
  // cliente lo conserva: se lo decimos para que no crea que no le funcionó.
  const bf = opts && opts.blackFriday && opts.blackFriday.activo && !opts.blackFriday.acumulaCodigo;
  const notaBF = bf
    ? `Durante Black Friday el ${opts.blackFriday.pct}&nbsp;% ya está en todos los precios de la tienda, así que este código no se suma a la campaña. Consérvalo: sigue siendo tuyo para tu primera compra.`
    : "";
  const cuerpo =
    `<p style="font-family:${SANS};font-size:15px;line-height:1.8;color:${C.texto};margin:0 0 24px;">Acabas de unirte a un espacio reservado para quienes aman las piezas únicas hechas a mano. Este código es tuyo:</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 20px;"><tr><td align="center" style="border:2px dashed ${C.rosa};border-radius:16px;background:rgba(243,207,179,0.08);padding:20px 38px;">` +
    `<div style="font-family:${SANS};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${C.terracota};font-weight:700;margin-bottom:8px;">Tu código de bienvenida · 15% OFF</div>` +
    `<div style="font-family:${SANS};font-size:28px;letter-spacing:8px;font-weight:700;color:${C.crema};">${esc(c.codigo)}</div>` +
    `<div style="font-family:${SANS};font-size:11px;color:${C.rosa};margin-top:8px;">Solo válido en tu primera compra · No transferible</div></td></tr></table>` +
    (notaBF ? `<p style="font-family:${SANS};font-size:13px;line-height:1.7;color:${C.suave};margin:0;">${notaBF}</p>` : "");
  const texto =
    `Hola ${c.nombre},\n\nAcabas de unirte a un espacio reservado para quienes aman las piezas únicas hechas a mano.\n\n` +
    `Tu código de bienvenida (15% OFF): ${c.codigo}\nSolo válido en tu primera compra · No transferible\n\n` +
    (bf ? `Durante Black Friday el ${opts.blackFriday.pct} % ya está en todos los precios de la tienda, así que este código no se suma a la campaña. Consérvalo: sigue siendo tuyo para tu primera compra.\n\n` : "") +
    `Ver catálogo: ${SITIO}/#catalogo\n\nFelipe Vergel · Arte en Vidrio\n`;
  return { rol: "cliente", to: c.email, subject: asunto, html: envoltura({ asunto, nombre: c.nombre, cuerpo }), text: texto };
}

function correoClubFelipe(c) {
  const asunto = `Nuevo suscriptor · ${c.nombre}`;
  const cuerpo =
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">` +
    filaDato("Nombre", esc(c.nombre)) + filaDato("Correo", esc(c.email)) + filaDato("Código", esc(c.codigo)) +
    filaDato("Vía", c.via === "google" ? "Google Sign-In" : "Formulario") + `</table>`;
  const texto = `Nuevo suscriptor al Círculo (${c.via === "google" ? "Google Sign-In" : "formulario"}).\nNombre: ${c.nombre}\nCorreo: ${c.email}\nCódigo: ${c.codigo}\n`;
  return { rol: "felipe", to: null, subject: asunto, html: envoltura({ asunto, nombre: "Felipe", saludo: false, cta: false, cuerpo }), text: texto, replyToCliente: c.email };
}

function correoVipCliente(c) {
  const esFV10 = c.tipo === "FV10" || /^FV10-/.test(c.codigo || "");
  const pct = esFV10 ? 10 : 20;
  const asunto = `Tu código personal del ${pct} %`;
  const nota = c.soloBF
    ? `Escríbelo en &laquo;¿Tienes un código de descuento?&raquo; al pagar. Vale solo mientras dure Black Friday. Tu 20&nbsp;% reemplaza el 15&nbsp;% de la tienda: los descuentos no se acumulan.`
    : esFV10
    ? `Escríbelo en &laquo;¿Tienes un código de descuento?&raquo; al pagar. No se suma a otros descuentos.`
    : `Escríbelo en &laquo;¿Tienes un código de descuento?&raquo; al pagar. No se suma a otros descuentos: si Black Friday está activo, tu 20&nbsp;% reemplaza el 15&nbsp;%.`;
  const notaTxt = c.soloBF
    ? `Escríbelo en "¿Tienes un código de descuento?" al pagar. Vale solo mientras dure Black Friday. Tu 20 % reemplaza el 15 % de la tienda: los descuentos no se acumulan.`
    : esFV10
    ? `Escríbelo en "¿Tienes un código de descuento?" al pagar. No se suma a otros descuentos.`
    : `Escríbelo en "¿Tienes un código de descuento?" al pagar. No se suma a otros descuentos: si Black Friday está activo, tu 20 % reemplaza el 15 %.`;
  const cuerpo =
    `<p style="font-family:${SANS};font-size:15px;line-height:1.8;color:${C.texto};margin:0 0 24px;">Este es tu código personal para comprar cualquier pieza de la tienda con ${pct}&nbsp;% de descuento sobre el precio de lista:</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 20px;"><tr><td align="center" style="border:2px dashed ${C.rosa};border-radius:16px;background:rgba(243,207,179,0.08);padding:20px 38px;">` +
    `<div style="font-family:${SANS};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${C.terracota};font-weight:700;margin-bottom:8px;">Código personal &middot; ${pct}&nbsp;%</div>` +
    `<div style="font-family:${SANS};font-size:28px;letter-spacing:6px;font-weight:700;color:${C.crema};">${esc(c.codigo)}</div>` +
    `<div style="font-family:${SANS};font-size:11px;color:${C.rosa};margin-top:8px;">Un solo uso &middot; Se gasta cuando tu pago es aprobado</div></td></tr></table>` +
    `<p style="font-family:${SANS};font-size:13px;line-height:1.7;color:${C.suave};margin:0;">${nota}` +
    (c.hasta ? ` Vale hasta el ${esc(c.hastaTexto || c.hasta)}.` : "") + `</p>`;
  const texto =
    `Hola ${c.nombre},

Este es tu código personal del ${pct} % sobre el precio de lista: ${c.codigo}
` +
    `Un solo uso. Se gasta cuando tu pago es aprobado.
${notaTxt}
` +
    (c.hasta ? `Vale hasta el ${c.hastaTexto || c.hasta}.
` : "") +
    `
Ver catálogo: ${SITIO}/#catalogo

Felipe Vergel · Arte en Vidrio
`;
  return { rol: "cliente", to: c.email, subject: asunto, html: envoltura({ asunto, nombre: c.nombre, cuerpo }), text: texto };
}

function correoVipFelipe(c) {
  const esFV10 = c.tipo === "FV10" || /^FV10-/.test(c.codigo || "");
  const etiqueta = esFV10 ? "Nuevo código del Círculo (10 %)" : c.soloBF ? "Nuevo código Black Friday del Círculo (20 %)" : "Nuevo código VIP";
  const asunto = `${etiqueta} · ${c.nombre}`;
  const cuerpo =
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">` +
    filaDato("Nombre", esc(c.nombre)) + filaDato("Correo", esc(c.email)) + filaDato("Código", esc(c.codigo)) + filaDato("Descuento", esFV10 ? "10 %" : "20 %") +
    filaDato("Desde", c.origen === "circulo" ? "Ventana del Círculo" : "Enlace /vip") + `</table>`;
  const texto = `${etiqueta} (${c.origen === "circulo" ? "Círculo" : "/vip"}).
Nombre: ${c.nombre}
Correo: ${c.email}
Código: ${c.codigo}
Descuento: ${esFV10 ? "10 %" : "20 %"}
`;
  return { rol: "felipe", to: null, subject: asunto, html: envoltura({ asunto, nombre: "Felipe", saludo: false, cta: false, cuerpo }), text: texto, replyToCliente: c.email };
}

/** Arma los correos de un tipo. Los datos ya deben venir validados/limpios. */
export function construirCorreos(tipo, datos, opts = {}) {
  if (tipo === "pedido") return [correoPedidoFelipe(datos, opts), correoPedidoCliente(datos, opts)];
  if (tipo === "club") return [correoClubCliente(datos, opts), correoClubFelipe(datos)];
  if (tipo === "vip") return [correoVipCliente(datos), correoVipFelipe(datos)];
  throw new Error("tipo desconocido: " + tipo);
}

// ───────────────────────────── envío (Resend) ─────────────────────────────

/** Cuerpo exacto que se manda a la API de Resend (lo devuelve también el modo de prueba). */
export function cuerpoResend(correo, { from, emailFelipe }) {
  // EMAIL_FELIPE puede traer varias direcciones separadas por coma (el aviso llega a todas).
  const avisos = String(emailFelipe || "").split(/[,;\s]+/).filter((d) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d));
  const principal = avisos[0] || emailFelipe;
  const para = correo.rol === "felipe" ? (avisos.length ? avisos : [emailFelipe]) : [correo.to];
  return {
    from,
    to: para,
    subject: correo.subject,
    html: correo.html,
    text: correo.text,
    // Al cliente le responde Felipe; a Felipe le responde el cliente.
    reply_to: correo.rol === "felipe" ? correo.replyToCliente || principal : principal
  };
}

/** Un correo a la API REST de Resend. Lanza error si falla; nunca imprime la clave. */
export async function enviarResend(correo, { fetchFn = fetch, apiKey, from, emailFelipe, idempotencyKey, timeoutMs = 8000 } = {}) {
  if (!apiKey) throw new Error("falta RESEND_API_KEY");
  const cuerpo = cuerpoResend(correo, { from, emailFelipe });
  const headers = { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(RESEND_URL, { method: "POST", headers, body: JSON.stringify(cuerpo), signal: ctl.signal });
    // 409 con Idempotency-Key = ese mismo correo ya salió (navegador + webhook): no es error.
    if (r.status === 409 && idempotencyKey) return { duplicado: true };
    if (!r.ok) {
      let detalle = "";
      try { detalle = (await r.text()).slice(0, 300); } catch { /* nada */ }
      throw new Error(`Resend ${r.status}: ${detalle}`);
    }
    let id = null;
    try { id = (await r.json()).id || null; } catch { /* nada */ }
    return { id };
  } finally {
    clearTimeout(t);
  }
}

let avisoConfig = false;
function configEnvio(env) {
  const from = env.RESEND_FROM || FROM_DEFECTO;
  const emailFelipe = env.EMAIL_FELIPE || EMAIL_FELIPE_DEFECTO;
  if ((!env.RESEND_FROM || !env.EMAIL_FELIPE) && !avisoConfig) {
    avisoConfig = true;
    console.warn("correos: falta RESEND_FROM o EMAIL_FELIPE en Netlify; se usan los valores por defecto.");
  }
  return { apiKey: env.RESEND_API_KEY, from, emailFelipe };
}

/**
 * Construye y envía todos los correos de un tipo. Cada correo es independiente:
 * si uno falla, el otro igual sale. Devuelve { cliente, felipe } con
 * { ok, error? } para cada uno. En RESEND_DRY_RUN=1 no llama a Resend y
 * devuelve en cada rol { ok:true, dryRun:true, correo:<cuerpo para Resend> }.
 */
export async function enviarCorreos(tipo, datos, deps = {}) {
  const env = deps.env || process.env;
  const { apiKey, from, emailFelipe } = configEnvio(env);
  const correos = construirCorreos(tipo, datos, {
    now: deps.now,
    pagoConfirmado: deps.pagoConfirmado,
    blackFriday: configBlackFriday(env)
  });
  const clave = tipo === "pedido" ? datos.ref : null;
  const salida = {};
  if (esDryRun(env)) {
    for (const c of correos) salida[c.rol] = { ok: true, dryRun: true, correo: cuerpoResend(c, { from, emailFelipe }) };
    return salida;
  }
  await Promise.all(
    correos.map(async (c) => {
      try {
        await enviarResend(c, {
          fetchFn: deps.fetchFn || fetch,
          apiKey, from, emailFelipe,
          idempotencyKey: clave ? `pedido-${clave}-${c.rol}` : undefined
        });
        salida[c.rol] = { ok: true };
      } catch (e) {
        console.error(`correos: fallo ${tipo}/${c.rol}:`, e && e.message);
        salida[c.rol] = { ok: false, error: String((e && e.message) || e).slice(0, 120) };
      }
    })
  );
  return salida;
}

// ───────────────────── límite de abuso (IP, destinatario y global) ─────────────────────
//  En memoria por instancia + (si se inyecta `store`, p. ej. Netlify Blobs)
//  contador compartido entre instancias. Si el almacén falla, se abre el
//  paso (el correo de un pedido real vale más que el riesgo de un spam puntual).

const memoria = new Map();
export function _reiniciarLimites() { memoria.clear(); }

async function contar(clave, ventanaMs, store, ahora) {
  const r = memoria.get(clave);
  let n = 1, t0 = ahora;
  if (r && ahora - r.t0 < ventanaMs) { n = r.n + 1; t0 = r.t0; }
  memoria.set(clave, { n, t0 });
  if (store) {
    try {
      const k = "rl-" + clave.replace(/[^A-Za-z0-9@._-]/g, "_").slice(0, 150);
      const g = await store.get(k, { type: "json" }).catch(() => null);
      let gn = 1, gt0 = ahora;
      if (g && ahora - g.t0 < ventanaMs) { gn = g.n + 1; gt0 = g.t0; }
      await store.setJSON(k, { n: gn, t0: gt0 });
      n = Math.max(n, gn);
    } catch { /* abre el paso */ }
  }
  return n;
}

//  Por hora. "global" es el techo de toda la tienda: si alguien reparte el
//  abuso entre muchas IP, igual se corta. Holgado para el tráfico real.
export const LIMITES = {
  pedido: { ip: 12, destinatario: 4, global: 60, ventanaMs: 60 * 60 * 1000 },
  club: { ip: 6, destinatario: 2, global: 150, ventanaMs: 60 * 60 * 1000 },
  vip: { ip: 8, destinatario: 3, global: 200, ventanaMs: 60 * 60 * 1000 },
  vipVerificar: { ip: 40, destinatario: 40, global: 2000, ventanaMs: 60 * 60 * 1000 },
  // ventas-registrar (pedidos por WhatsApp a Supabase)
  venta: { ip: 12, destinatario: 6, global: 150, ventanaMs: 60 * 60 * 1000 }
};

/** true = permitido. */
export async function dentroDelLimite(tipo, ip, email, { store, ahora = Date.now() } = {}) {
  const L = LIMITES[tipo];
  const nIp = await contar(`${tipo}:ip:${ip || "desconocida"}`, L.ventanaMs, store, ahora);
  if (nIp > L.ip) return false;
  const nDest = await contar(`${tipo}:dest:${String(email).toLowerCase()}`, L.ventanaMs, store, ahora);
  if (nDest > L.destinatario) return false;
  const nGlobal = await contar(`${tipo}:global`, L.ventanaMs, store, ahora);
  return nGlobal <= L.global;
}

// ───────────────────── lógica HTTP (sin depender de Netlify) ─────────────────────

export function cabeceras(origen) {
  const h = {
    "Content-Type": "application/json",
    "Vary": "Origin",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
  // CORS exacto: solo se devuelve Allow-Origin a los dos orígenes del sitio.
  if (ORIGENES_OK.includes(origen)) {
    h["Access-Control-Allow-Origin"] = origen;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

const completo = (p) => !!(p && p.fullName && p.email && Array.isArray(p.cart) && p.cart.length);

/**
 * @param {{metodo:string, origen:string, ip:string, cuerpo:string}} req
 * @param {{env?, fetchFn?, store?, ahora?, now?, buscarPedido?: (ref)=>Promise<object|null>}} deps
 * @returns {{status:number, headers:object, body:object|null}}
 */
export async function procesarSolicitud(req, deps = {}) {
  const h = cabeceras(req.origen);
  const resp = (status, body) => ({ status, headers: h, body });
  if (req.metodo === "OPTIONS") return ORIGENES_OK.includes(req.origen) ? { status: 204, headers: h, body: null } : resp(403, { ok: false, error: "origen-no-permitido" });
  if (req.metodo !== "POST") return resp(405, { ok: false, error: "metodo-no-permitido" });
  if (!ORIGENES_OK.includes(req.origen)) return resp(403, { ok: false, error: "origen-no-permitido" });

  const env = deps.env || process.env;
  const dry = esDryRun(env);
  if (!env.RESEND_API_KEY && !dry) {
    console.error("enviar-correo: falta RESEND_API_KEY en Netlify (Site configuration > Environment variables).");
    return resp(503, { ok: false, error: "sin-clave" });
  }

  const texto = typeof req.cuerpo === "string" ? req.cuerpo : "";
  if (Buffer.byteLength(texto, "utf8") > MAX_BODY) return resp(413, { ok: false, error: "cuerpo-muy-grande" });
  let json;
  try { json = JSON.parse(texto); } catch { return resp(400, { ok: false, error: "json-invalido" }); }
  if (!esObjeto(json)) return resp(400, { ok: false, error: "json-invalido" });
  const extra = desconocidos(json, ["tipo", "datos"]);
  if (extra.length) return resp(400, { ok: false, error: "campos-no-permitidos" });
  if (!TIPOS.includes(json.tipo)) return resp(400, { ok: false, error: "tipo-no-permitido" });

  const v = json.tipo === "pedido" ? validarPedido(json.datos) : validarClub(json.datos);
  if (!v.ok) return resp(400, { ok: false, error: "datos-invalidos", detalle: v.errores });
  let datos = v.datos;

  if (json.tipo === "pedido") {
    // Si save-pending/wompi-sign ya guardaron ese pedido (pago por Wompi), el
    // correo del comprador debe coincidir y los montos salen de ESE registro.
    let guardado = null;
    if (deps.buscarPedido) {
      try { guardado = await deps.buscarPedido(datos.ref); } catch { guardado = null; }
    }
    if (guardado && guardado.email && String(guardado.email).trim().toLowerCase() !== datos.email.toLowerCase()) {
      return resp(403, { ok: false, error: "pedido-no-coincide" });
    }
    if (guardado && guardado._serverPriced && completo(guardado)) {
      datos = limpiarPedido({ ...guardado, ref: datos.ref });
    } else {
      let vipValido = false;
      let circuloValido = false;
      const esVipCod = RE_CODIGO_VIP.test(datos.discountCode || "");
      const esCirculoCod = RE_CODIGO_CIRCULO.test(datos.discountCode || "");
      if ((esVipCod || esCirculoCod) && deps.verificarVip) {
        let ok = false;
        try { ok = (await deps.verificarVip(datos.discountCode)) === "valido"; } catch { ok = false; }
        vipValido = esVipCod && ok;
        circuloValido = esCirculoCod && ok;
      }
      const rc = recalcularPedido(datos, env, { vipValido, circuloValido });
      if (!rc.ok) return resp(400, { ok: false, error: rc.error });
      datos = rc.datos;
    }
  }

  if (!(await dentroDelLimite(json.tipo, req.ip, datos.email, { store: deps.store, ahora: deps.ahora }))) {
    return resp(429, { ok: false, error: "demasiados-envios" });
  }

  const r = await enviarCorreos(json.tipo, datos, { env, fetchFn: deps.fetchFn, now: deps.now });
  // El correo que el cliente espera es obligatorio; el aviso a Felipe es "mejor esfuerzo".
  const ok = r.cliente && r.cliente.ok;
  const body = { ok: !!ok, cliente: !!(r.cliente && r.cliente.ok), felipe: !!(r.felipe && r.felipe.ok) };
  if (dry) {
    body.dryRun = true;
    body.correos = [r.felipe, r.cliente].filter(Boolean).map((x) => x.correo);
  }
  return resp(ok ? 200 : 502, body);
}
