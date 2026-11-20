// ============================================================
//  ventas-registrar  ·  Registro de pedidos por WhatsApp (Supabase)
// ------------------------------------------------------------
//  Historia: el navegador escribía directo en la hoja "Ventas" (Apps Script)
//  con una clave visible; luego pasó por esta función, que agregaba la clave.
//  Desde nov-2026 la base es Supabase:
//
//   {action:"registrar", ref, pedido:{...}}  (sitio nuevo; pedido = mismo
//      objeto que se manda a enviar-correo)
//      - WhatsApp -> se valida, se rehacen piezas y montos con el catálogo
//        del servidor (como en enviar-correo) y se guarda en Supabase con
//        origen "whatsapp" y estado_pago "PENDIENTE" (Felipe confirma el
//        pago por WhatsApp). Solo si Supabase falla se escribe en la hoja,
//        como respaldo.
//      - Wompi -> no se escribe nada: el pedido lo registra wompi-webhook con
//        los importes fijados por wompi-sign y la confirmación de Wompi.
//   {action:"registrar", ref, nombre, email, productos, total…}  (formato
//      viejo, sitio sin actualizar): se guarda en Supabase con los números
//      del navegador marcados como no verificados, y TAMBIÉN en la hoja,
//      como antes, mientras el sitio viejo siga publicado.
//   {action:"markUsed", …}: ya no hace nada. Los códigos se marcan usados
//      solo en wompi-webhook cuando Wompi aprueba (antes el navegador podía
//      gastar un código con un pago apenas PENDIENTE).
// ============================================================
import { validarPedido, recalcularPedido, dentroDelLimite } from "./lib/correos.js";
import { registrarEnSupabase } from "./lib/supabase-pedidos.js";
import { estadoCodigo, RE_FV20 } from "./lib/vip.js";
import { configSupabase } from "./lib/supabase-rest.js";

// Hoja "Ventas" (Apps Script "PAGINA WEB"): SOLO respaldo.
const VENTAS_API = "https://script.google.com/macros/s/AKfycbz9BVbko_lCUMGsSHmSTn8Pu3Kd9L3LFSB6uhaqQZNn6Qi7iK4Hs5bcD3GoR6EBwYc8Jw/exec";
// Mismo secreto que ya usaban checkout.html y wompi-webhook.js. Solo vive en
// código de servidor (nunca se sirve al navegador).
const VENTAS_KEY = "Pjh5zFh5RhYW";

const ORIGENES_OK = [
  "https://felipevergel.com",
  "https://www.felipevergel.com",
  "http://localhost:8888",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
];

const RE_REF = /^FV-\d{10,16}-[A-Z0-9]{1,12}$/;

function cabeceras(origen) {
  const permitido = ORIGENES_OK.includes(origen) ? origen : ORIGENES_OK[0];
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": permitido,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  };
}

async function aLaHoja(payload) {
  try {
    await fetch(VENTAS_API, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...payload, key: VENTAS_KEY })
    });
    return true;
  } catch (e) {
    console.error("ventas-registrar: respaldo en la hoja falló:", e && e.message);
    return false;
  }
}

// "1× Florero Ondas (Gris)\n2× ..." -> líneas (formato viejo, sin catálogo).
function lineasDeTexto(txt, precioUnit) {
  const lineas = String(txt || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lineas.map((l) => {
    const m = l.match(/^(\d+)\s*[×xX]\s*(.+?)\s*\(([^)]+)\)\s*$/);
    const qty = m ? Number(m[1]) || 1 : 1;
    return { qty, name: m ? m[2].trim() : l, color: m ? m[3].trim() : null, price: lineas.length === 1 ? Number(precioUnit) || 0 : 0 };
  });
}

/** Lógica sin Netlify (probada sin red). deps: {db?, env?, fetchFn?, ahora?, rlStore?} */
export async function procesarVenta(req, deps = {}) {
  const H = cabeceras(req.origen);
  const resp = (status, body) => ({ status, headers: H, body });
  if (req.metodo === "OPTIONS") return { status: 204, headers: H, body: null };
  if (req.metodo !== "POST") return resp(405, { ok: false, error: "metodo-no-permitido" });
  if (req.origen && !ORIGENES_OK.includes(req.origen)) return resp(403, { ok: false, error: "origen-no-autorizado" });

  let body;
  try { body = JSON.parse(req.cuerpo || ""); } catch { return resp(400, { ok: false, error: "json-invalido" }); }
  if (!body || typeof body !== "object") return resp(400, { ok: false, error: "json-invalido" });

  if (body.action === "markUsed") return resp(200, { ok: true, nota: "los códigos se marcan en wompi-webhook" });

  const ref = String(body.ref || (body.pedido && body.pedido.ref) || "");
  if (!RE_REF.test(ref)) return resp(400, { ok: false, error: "referencia-invalida" });
  const db = deps.db !== undefined ? deps.db : configSupabase();
  const env = deps.env || process.env;

  // ── Sitio nuevo: {ref, pedido} ─────────────────────────────
  if (body.pedido) {
    const v = validarPedido(body.pedido);
    if (!v.ok) return resp(400, { ok: false, error: "datos-invalidos", detalle: v.errores });
    if (v.datos.ref !== ref) return resp(400, { ok: false, error: "referencia-invalida" });
    if (v.datos.paymentMethod !== "whatsapp") return resp(200, { ok: true, registrado: false, nota: "lo registra wompi-webhook" });
    if (!(await dentroDelLimite("venta", req.ip || "-", v.datos.email, { store: deps.rlStore, ahora: deps.ahora }))) {
      return resp(429, { ok: false, error: "demasiadas-solicitudes" });
    }
    let vipValido = false;
    if (RE_FV20.test(v.datos.discountCode || "")) vipValido = (await estadoCodigo(db, v.datos.discountCode, { env })).estado === "valido";
    const rc = recalcularPedido(v.datos, env, { vipValido });
    if (!rc.ok) return resp(400, { ok: false, error: rc.error });
    const pedido = { ...rc.datos, paymentMethod: "whatsapp" };
    const r = await registrarEnSupabase(ref, pedido, null, { db, origen: "whatsapp", estado: "PENDIENTE", fetchFn: deps.fetchFn });
    if (r.ok) return resp(200, { ok: true, registrado: true });
    // Respaldo: la hoja, con los importes del servidor.
    const hoja = await aLaHoja({
      action: "registrar", ref, nombre: pedido.fullName, email: pedido.email, telefono: pedido.phone,
      productos: pedido.cart.map((i) => `${i.qty}× ${i.name} (${i.color})`).join("\n"),
      cantidad: pedido.cart.reduce((s, i) => s + i.qty, 0), precioUnit: pedido.cart.length === 1 ? pedido.cart[0].price : 0,
      subtotal: pedido.subtotal, descuento: pedido.discountAmount, envio: pedido.shipping, total: pedido.total,
      metodoPago: "WhatsApp", metodoEntrega: pedido.deliveryMethod === "bucaramanga" ? "Bucaramanga gratis" : "Domicilio",
      ciudad: pedido.city, direccion: pedido.address, departamento: pedido.department, codigoPostal: pedido.zipCode,
      documento: pedido.docId, notas: pedido.notes
    });
    return resp(200, { ok: true, registrado: false, respaldo: hoja ? "hoja" : "ninguno" });
  }

  // ── Formato viejo (sitio sin actualizar) ───────────────────
  const esWhatsapp = /whatsapp/i.test(String(body.metodoPago || ""));
  if (esWhatsapp && db) {
    const pedido = {
      fullName: body.nombre || null, email: body.email || null, phone: body.telefono || null, docId: body.documento || null,
      address: body.direccion || null, city: body.ciudad || null, department: body.departamento || null, zipCode: body.codigoPostal || null,
      notes: body.notas || null, deliveryMethod: /bucaramanga/i.test(String(body.metodoEntrega || "")) ? "bucaramanga" : "domicilio",
      paymentMethod: "whatsapp", subtotal: Number(body.subtotal) || 0, discountAmount: Number(body.descuento) || 0,
      shipping: Number(body.envio) || 0, total: Number(body.total) || 0,
      cart: lineasDeTexto(body.productos, body.precioUnit), _importesSinVerificar: true
    };
    const r = await registrarEnSupabase(ref, pedido, null, { db, origen: "whatsapp", estado: "PENDIENTE", fetchFn: deps.fetchFn });
    if (!r.ok) console.error("ventas-registrar: Supabase no registró", ref, r.motivo);
  }
  // Mientras el sitio viejo siga publicado, la hoja recibe lo mismo que antes.
  await aLaHoja({ ...body, action: "registrar" });
  return resp(200, { ok: true });
}

export default async (req) => {
  const r = await procesarVenta({
    metodo: req.method,
    origen: req.headers.get("origin") || "",
    ip: req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "desconocida",
    cuerpo: req.method === "POST" ? await req.text() : ""
  });
  return new Response(r.body ? JSON.stringify(r.body) : null, { status: r.status, headers: r.headers });
};
