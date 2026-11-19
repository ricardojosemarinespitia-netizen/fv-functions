// ============================================================
//  lib/vip.js  ·  Códigos personales FV20 (20 %, un solo uso)
// ------------------------------------------------------------
//  Dónde viven: Netlify Blobs, almacén "vip-codigos" (mismo sitio Netlify
//  que ya guarda los pedidos). No se usa la hoja/Apps Script del Círculo
//  porque validar y marcar un FV20 ahí exigiría cambiar el Apps Script
//  (no está en este repo). Claves:
//    correo:<sha256(correo en minúsculas)>  -> { codigo }
//    codigo:<FV20-XXXXXXX>                  -> { codigo, email, nombre, origen,
//                                               creado, usado, usadoRef, usadoEn }
//
//  Reglas (de Ricardo):
//   - Un código por correo: pedirlo otra vez devuelve el MISMO código.
//   - Un solo uso: se marca usado SOLO cuando Wompi aprueba el pago
//     (wompi-webhook). Si el pago falla, sigue válido.
//   - Vence en VIP_HASTA (ISO 8601). Vacío / sin definir = no vence.
// ============================================================
import crypto from "node:crypto";

export const STORE_VIP = "vip-codigos";
export const RE_FV20 = /^FV20-[A-Z0-9]{7}$/;
// Sin 0/O ni 1/I/L para que se pueda dictar y copiar a mano sin errores.
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generarCodigoVip(rnd = crypto.randomBytes) {
  const b = rnd(7);
  let s = "";
  for (let i = 0; i < 7; i++) s += ALFABETO[b[i] % ALFABETO.length];
  return "FV20-" + s;
}

export const claveCorreo = (email) =>
  "correo:" + crypto.createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex");
export const claveCodigo = (codigo) => "codigo:" + String(codigo || "").trim().toUpperCase();

/** Vencimiento: VIP_HASTA (ISO). Vacío = sin vencimiento. */
export function configVip(env = (typeof process !== "undefined" ? process.env : {})) {
  const h = String((env && env.VIP_HASTA) || "").trim();
  const t = h ? Date.parse(h) : NaN;
  return { hasta: Number.isNaN(t) ? null : h, hastaMs: Number.isNaN(t) ? null : t };
}

const leer = async (store, k) => {
  try { return await store.get(k, { type: "json", consistency: "strong" }); }
  catch { return await store.get(k, { type: "json" }).catch(() => null); }
};

/**
 * Estado de un código. Nunca lanza.
 * @returns {Promise<{estado:"valido"|"usado"|"vencido"|"invalido"|"sin-verificar", registro?:object}>}
 */
export async function estadoCodigoVip(store, codigo, { env, ahora = Date.now() } = {}) {
  const c = String(codigo || "").trim().toUpperCase();
  if (!RE_FV20.test(c)) return { estado: "invalido" };
  if (!store) return { estado: "sin-verificar" };
  let reg = null;
  try { reg = await leer(store, claveCodigo(c)); } catch { return { estado: "sin-verificar" }; }
  if (!reg) return { estado: "invalido" };
  if (reg.usado) return { estado: "usado", registro: reg };
  const { hastaMs } = configVip(env);
  if (hastaMs != null && ahora >= hastaMs) return { estado: "vencido", registro: reg };
  return { estado: "valido", registro: reg };
}

/** Devuelve el código del correo (lo crea si no existe). */
export async function obtenerOCrearCodigo(store, { email, nombre, origen }, { ahora = Date.now(), rnd } = {}) {
  const kc = claveCorreo(email);
  const previo = await leer(store, kc);
  if (previo && previo.codigo) {
    const reg = await leer(store, claveCodigo(previo.codigo));
    if (reg) return { codigo: previo.codigo, nuevo: false, registro: reg };
  }
  // Código nuevo, sin colisión con uno existente.
  let codigo = null;
  for (let i = 0; i < 5 && !codigo; i++) {
    const c = generarCodigoVip(rnd);
    if (!(await leer(store, claveCodigo(c)))) codigo = c;
  }
  if (!codigo) throw new Error("no se pudo generar un código único");
  const registro = { codigo, email: String(email).trim(), nombre: nombre || "", origen: origen || "vip", creado: new Date(ahora).toISOString(), usado: false };
  await store.setJSON(claveCodigo(codigo), registro);
  await store.setJSON(kc, { codigo });
  return { codigo, nuevo: true, registro };
}

/** Marca el código como usado (idempotente). Solo lo llama el webhook con pago APROBADO. */
export async function marcarVipUsado(store, codigo, ref, ahora = Date.now()) {
  const k = claveCodigo(codigo);
  const reg = await leer(store, k);
  if (!reg) return { ok: false, motivo: "no-existe" };
  if (reg.usado) return { ok: true, yaEstaba: true, usadoRef: reg.usadoRef };
  await store.setJSON(k, { ...reg, usado: true, usadoRef: ref, usadoEn: new Date(ahora).toISOString() });
  return { ok: true };
}
