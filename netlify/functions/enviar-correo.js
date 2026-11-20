// ============================================================
//  enviar-correo  ·  Envía los correos del sitio por Resend
// ------------------------------------------------------------
//  Reemplaza a EmailJS. El navegador manda SOLO {tipo, datos}; el
//  servidor valida, limita el abuso, arma el correo y lo envía con la
//  clave de Resend, que nunca sale de Netlify.
//
//    POST {"tipo":"pedido","datos":{...}}  -> aviso a Felipe + confirmación al cliente
//    POST {"tipo":"club","datos":{...}}    -> bienvenida al Círculo + aviso a Felipe
//
//  Solo responde a https://felipevergel.com y https://www.felipevergel.com.
//
//  Respuesta: 200 {ok:true, cliente:true, felipe:true|false}
//             400 datos inválidos · 403 origen no permitido / pedido ajeno
//             405 método · 413 muy grande · 429 demasiados envíos
//             502 Resend falló · 503 falta RESEND_API_KEY
//  Con RESEND_DRY_RUN=1: 200 {ok:true, dryRun:true, correos:[...]} sin
//  llamar a Resend (para probar sin clave). NO dejarlo puesto en producción.
//
//  Variables de entorno en Netlify:
//    RESEND_API_KEY   clave de Resend (secreta)
//    RESEND_FROM      "Felipe Vergel <pedidos@felipevergel.com>"
//    EMAIL_FELIPE     buzón donde Felipe recibe los avisos
//
//  La lógica vive en lib/correos.js (procesarSolicitud) para poder probarla
//  sin red; esto es solo el adaptador a Netlify.
// ============================================================
import { procesarSolicitud } from "./lib/correos.js";
import { estadoCodigo } from "./lib/vip.js";
import { configSupabase } from "./lib/supabase-rest.js";
import { abrirLegado } from "./lib/vip-legado.js";

// Almacenes de Netlify Blobs (opcionales): si no cargan, el límite de abuso
// sigue funcionando en memoria y los montos se recalculan con el catálogo.
async function abrirStore(nombre) {
  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore(nombre);
  } catch {
    return null;
  }
}

export default async (req) => {
  const metodo = req.method;
  const origen = req.headers.get("origin") || "";
  const ip =
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "desconocida";

  const cuerpo = metodo === "POST" ? await req.text() : "";

  let storeRl = null;
  let storePedidos = null;
  if (metodo === "POST") {
    storeRl = await abrirStore("correos-limite");
    storePedidos = await abrirStore("pedidos");
  }

  // Pedido guardado por wompi-sign/save-pending (pagos por Wompi). Si existe,
  // el correo tiene que coincidir y los montos salen de ahí.
  const buscarPedido = storePedidos
    ? async (ref) => storePedidos.get(ref, { type: "json" }).catch(() => null)
    : null;

  // Pedido por WhatsApp con FV20 o FV10: el 20 % / 10 % solo sale en el correo si
  // Supabase (codigos_descuento) dice que el código es válido.
  const verificarVip = async (codigo) => (await estadoCodigo(configSupabase(), codigo, { timeoutMs: 3000, reintentos: 1, legado: await abrirLegado() })).estado;

  const r = await procesarSolicitud(
    { metodo, origen, ip, cuerpo },
    { store: storeRl, buscarPedido, verificarVip }
  );
  return new Response(r.body ? JSON.stringify(r.body) : null, { status: r.status, headers: r.headers });
};
