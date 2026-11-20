// ============================================================
//  vip-codigo  ·  Código personal FV20 + verificación de códigos
// ------------------------------------------------------------
//  Lo usan la página /vip, la ventana del Círculo y la caja de código.
//    POST {"accion":"solicitar","nombre","email","origen":"vip"|"circulo","metodo"?,"web":""}
//    POST {"accion":"verificar","codigo"}     FV20 o FV15
//    POST {"accion":"registrado","email"}     ¿ya está en el Círculo? (sí/no)
//  Datos en Supabase (suscriptores + codigos_descuento). Los códigos se
//  marcan usados en wompi-webhook cuando Wompi aprueba.
//  Vencimiento FV20: VIP_HASTA (vacío = no vence).
//  Si Supabase no responde al pedir un código, el correo se guarda en el
//  almacén de Netlify Blobs "pendientes-supabase" (solo cola de respaldo,
//  para no perderlo) y se responde 503.
//  Lógica en lib/vip-http.js (probada sin red).
// ============================================================
import crypto from "node:crypto";
import { procesarVip } from "./lib/vip-http.js";
import { configSupabase } from "./lib/supabase-rest.js";
import { abrirLegado } from "./lib/vip-legado.js";

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
  const rlStore = metodo === "POST" ? await abrirStore("correos-limite") : null;
  const guardarPendiente = async (datos) => {
    const cola = await abrirStore("pendientes-supabase");
    if (!cola) throw new Error("sin almacén de respaldo");
    await cola.setJSON(`suscriptor/${new Date().toISOString()}-${crypto.randomBytes(3).toString("hex")}`, datos);
  };
  const r = await procesarVip({ metodo, origen, ip, cuerpo }, { db: configSupabase(), rlStore, guardarPendiente, legado: metodo === "POST" ? await abrirLegado() : null });
  return new Response(r.body ? JSON.stringify(r.body) : null, { status: r.status, headers: r.headers });
};
