// ============================================================
//  lib/vip-legado.js  ·  Migración PEREZOSA de los FV20 de Netlify Blobs
// ------------------------------------------------------------
//  Antes de pasar a Supabase, los FV20 vivían en Netlify Blobs, almacén
//  "vip-codigos" (versión anterior de lib/vip.js, commit 2d4aaec):
//    correo:<sha256(correo en minúsculas)> -> { codigo }
//    codigo:<FV20-XXXXXXX>                 -> { codigo, email, nombre, origen,
//                                              creado, usado, usadoRef, usadoEn }
//  Desde el 19-nov-2026 (correo VIP a 121 personas) algunos códigos existen
//  SOLO ahí. Cuando un correo o un código no está en Supabase, se busca en
//  Blobs; si aparece, se copia a Supabase (suscriptores + codigos_descuento,
//  conservando creado_en y usado) y se responde desde Supabase.
//
//  Reglas:
//   - Solo LEE Blobs. Nunca escribe ni borra allí.
//   - Cualquier falla de Blobs (no existe, timeout, JSON raro) = "no está":
//     se ignora y se sigue como antes.
//   - Si Blobs tiene el código pero Supabase no lo deja guardar, el que llama
//     responde "sin-verificar" (sin descuento): nunca se aplica un código que
//     no quedó en la base, porque allí es donde se marca usado.
//   - Idempotente: insert con on_conflict ignore-duplicates; repetirlo no duplica.
// ============================================================
import crypto from "node:crypto";
import { sbFetch } from "./supabase-rest.js";

export const STORE_LEGADO = "vip-codigos";
const RE_FV20 = /^FV20-[A-Z0-9]{7}$/;
const claveCorreo = (email) => "correo:" + crypto.createHash("sha256").update(String(email || "").trim().toLowerCase()).digest("hex");
const claveCodigo = (codigo) => "codigo:" + String(codigo || "").trim().toUpperCase();

/** Abre el almacén viejo dentro de una función de Netlify. null si no se puede. */
export async function abrirLegado() {
  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore(STORE_LEGADO);
  } catch {
    return null;
  }
}

async function leer(store, k, timeoutMs = 1500) {
  if (!store) return null;
  try {
    const p = Promise.resolve().then(() => store.get(k, { type: "json" }));
    const t = new Promise((r) => setTimeout(() => r(null), timeoutMs).unref?.());
    const v = await Promise.race([p.catch(() => null), t]);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

const valido = (reg, codigo) => reg && RE_FV20.test(String(reg.codigo || "")) && (!codigo || reg.codigo === codigo);

/** Registro viejo por código (o null). Nunca lanza. */
export async function legadoPorCodigo(store, codigo) {
  const c = String(codigo || "").trim().toUpperCase();
  if (!RE_FV20.test(c)) return null;
  const reg = await leer(store, claveCodigo(c));
  return valido(reg, c) ? reg : null;
}

/** Registro viejo por correo (o null). Nunca lanza. */
export async function legadoPorCorreo(store, email) {
  const idx = await leer(store, claveCorreo(email));
  if (!idx || !RE_FV20.test(String(idx.codigo || ""))) return null;
  const reg = await legadoPorCodigo(store, idx.codigo);
  // El índice tiene que apuntar a un código de ESE correo.
  if (!reg || String(reg.email || "").trim().toLowerCase() !== String(email || "").trim().toLowerCase()) return null;
  return reg;
}

const iso = (v) => { const t = Date.parse(v || ""); return Number.isNaN(t) ? null : new Date(t).toISOString(); };

/**
 * Copia un registro viejo a Supabase. Devuelve true si el código quedó en la
 * base (recién copiado o ya estaba). Nunca lanza.
 */
export async function importarLegado(db, reg, { fetchFn } = {}) {
  if (!db || !valido(reg)) return false;
  const email = String(reg.email || "").trim().toLowerCase();
  if (!email) return false;
  const origen = reg.origen === "circulo" ? "circulo" : "vip";
  const creado = iso(reg.creado);
  const nombre = reg.nombre && String(reg.nombre).trim().toLowerCase() !== "coleccionista" ? String(reg.nombre).trim() : null;
  try {
    // Suscriptor (mejor esfuerzo: si ya estaba, no se toca).
    await sbFetch(db, "/rest/v1/suscriptores?on_conflict=email", {
      method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", reintentos: 0, timeoutMs: 2500, fetchFn,
      body: [{ email, nombre, origen, metodo: null, ...(creado ? { creado_en: creado } : {}) }]
    });
    const usado = !!reg.usado;
    const fila = {
      codigo: reg.codigo, tipo: "FV20", email, origen,
      ...(creado ? { creado_en: creado } : {}),
      usado,
      usado_en: usado ? iso(reg.usadoEn) || new Date().toISOString() : null,
      referencia_pedido: usado ? reg.usadoRef || null : null
    };
    const r = await sbFetch(db, "/rest/v1/codigos_descuento?on_conflict=codigo", {
      method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: [fila], reintentos: 0, timeoutMs: 2500, fetchFn
    });
    if (r.ok) return true;
    // 409 = ese correo ya tiene OTRO FV20 en Supabase (índice único por correo):
    // manda el de Supabase; este viejo no se importa.
    if (r.status !== 409) console.error("vip-legado: no se pudo copiar", reg.codigo, r.status, r.error);
    return false;
  } catch (e) {
    console.error("vip-legado: excepción copiando", reg && reg.codigo, e && e.message);
    return false;
  }
}
