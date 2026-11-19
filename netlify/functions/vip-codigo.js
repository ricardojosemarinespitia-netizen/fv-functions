// ============================================================
//  vip-codigo  ·  Código personal FV20 (20 % sobre lista, un solo uso)
// ------------------------------------------------------------
//  Lo usan la página /vip y la ventana del Círculo (solo nombre + correo).
//    POST {"accion":"solicitar","nombre","email","origen":"vip"|"circulo","web":""}
//    POST {"accion":"verificar","codigo"}   (caja de código en customer-info)
//  Códigos en Netlify Blobs ("vip-codigos"). Se marcan usados en
//  wompi-webhook cuando Wompi aprueba. Vencimiento: VIP_HASTA (vacío = no vence).
//  Lógica en lib/vip-http.js (probada sin red).
// ============================================================
import { procesarVip } from "./lib/vip-http.js";
import { STORE_VIP } from "./lib/vip.js";

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
  const store = metodo === "POST" ? await abrirStore(STORE_VIP) : null;
  const rlStore = metodo === "POST" ? await abrirStore("correos-limite") : null;
  const r = await procesarVip({ metodo, origen, ip, cuerpo }, { store, rlStore });
  return new Response(r.body ? JSON.stringify(r.body) : null, { status: r.status, headers: r.headers });
};
