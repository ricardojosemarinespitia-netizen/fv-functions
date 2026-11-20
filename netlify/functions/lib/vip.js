// ============================================================
//  lib/vip.js  ·  Códigos de descuento y suscriptores (Supabase)
// ------------------------------------------------------------
//  Fuente de verdad: Supabase, tablas `codigos_descuento` y `suscriptores`
//  (ver migracion-supabase/01_esquema.sql). Antes: FV20 en Netlify Blobs
//  ("vip-codigos") y FV15 + suscriptores en la hoja de Google (Apps Script).
//
//    FV20-XXXXXXX  personal, 20 % sobre lista, un solo uso, uno por correo.
//    FV15-XXXXXXX  Círculo histórico, 15 %, un solo uso (ya no se emiten).
//
//  Reglas (de Ricardo):
//   - Un FV20 por correo: pedirlo otra vez devuelve el MISMO código
//     (índice único parcial en la base: uq_codigos_fv20_por_email).
//   - Un solo uso: se marca usado SOLO cuando Wompi aprueba (wompi-webhook).
//     Si el pago falla, sigue válido.
//   - FV20 vence en VIP_HASTA (ISO 8601). Vacío = no vence. FV15 no vence.
//   - Si Supabase no responde: al CREAR se devuelve error (no se inventa
//     ningún código) y al VERIFICAR el estado es "sin-verificar", que en el
//     cobro significa NO aplicar descuento.
// ============================================================
import crypto from "node:crypto";
import { sbFetch, filtro } from "./supabase-rest.js";
import { legadoPorCodigo, legadoPorCorreo, importarLegado } from "./vip-legado.js";
//  `legado` (opcional en todas las funciones) = almacén viejo de Netlify Blobs
//  "vip-codigos". Si un FV20 o un correo no está en Supabase se busca allí y
//  se copia (ver lib/vip-legado.js). Sin `legado`, todo funciona igual.

export const RE_FV20 = /^FV20-[A-Z0-9]{7}$/;
export const RE_FV15 = /^FV15-[A-Z0-9]{7}$/;
// Sin 0/O ni 1/I/L para que se pueda dictar y copiar a mano sin errores.
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generarCodigoVip(rnd = crypto.randomBytes) {
  const b = rnd(7);
  let s = "";
  for (let i = 0; i < 7; i++) s += ALFABETO[b[i] % ALFABETO.length];
  return "FV20-" + s;
}

export const normalizarEmail = (email) => String(email || "").trim().toLowerCase();
export const normalizarCodigo = (codigo) => String(codigo || "").trim().toUpperCase();

/** Vencimiento de FV20: VIP_HASTA (ISO). Vacío = sin vencimiento. */
export function configVip(env = (typeof process !== "undefined" ? process.env : {})) {
  const h = String((env && env.VIP_HASTA) || "").trim();
  const t = h ? Date.parse(h) : NaN;
  return { hasta: Number.isNaN(t) ? null : h, hastaMs: Number.isNaN(t) ? null : t };
}

const T = "/rest/v1/codigos_descuento";
const S = "/rest/v1/suscriptores";
const CAMPOS = "codigo,tipo,email,usado,usado_en,referencia_pedido,creado_en";

/**
 * Estado de un código FV20 o FV15. Nunca lanza.
 * @returns {Promise<{estado:"valido"|"usado"|"vencido"|"invalido"|"sin-verificar", registro?:object}>}
 */
export async function estadoCodigo(db, codigo, { env, ahora = Date.now(), timeoutMs, reintentos, fetchFn, legado } = {}) {
  const c = normalizarCodigo(codigo);
  if (!RE_FV20.test(c) && !RE_FV15.test(c)) return { estado: "invalido" };
  if (!db) return { estado: "sin-verificar" };
  const leerSb = () => sbFetch(db, `${T}?codigo=eq.${filtro(c)}&select=${CAMPOS}`, { timeoutMs, reintentos, fetchFn });
  let r = await leerSb();
  if (!r.ok || !Array.isArray(r.datos)) return { estado: "sin-verificar" };
  let reg = r.datos[0];
  if (!reg && legado && RE_FV20.test(c)) {
    // Migración perezosa: FV20 emitido cuando los códigos vivían en Blobs.
    const viejo = await legadoPorCodigo(legado, c);
    if (viejo) {
      if (!(await importarLegado(db, viejo, { fetchFn }))) return { estado: "sin-verificar" };
      r = await leerSb();
      if (!r.ok || !Array.isArray(r.datos) || !r.datos[0]) return { estado: "sin-verificar" };
      reg = r.datos[0];
    }
  }
  if (!reg) return { estado: "invalido" };
  if (reg.usado) return { estado: "usado", registro: reg };
  if (reg.tipo === "FV20") {
    const { hastaMs } = configVip(env);
    if (hastaMs != null && ahora >= hastaMs) return { estado: "vencido", registro: reg };
  }
  return { estado: "valido", registro: reg };
}

/** Error que el que llama traduce a 503 "no se pudo, intenta de nuevo". */
export class SupabaseNoDisponible extends Error {
  constructor(paso, detalle) { super(`supabase-no-disponible (${paso}): ${detalle || ""}`); this.paso = paso; }
}

async function fv20DeCorreo(db, email, fetchFn) {
  const r = await sbFetch(db, `${T}?email=eq.${filtro(email)}&tipo=eq.FV20&select=${CAMPOS}`, { fetchFn });
  if (!r.ok || !Array.isArray(r.datos)) throw new SupabaseNoDisponible("leer-fv20", r.error);
  return r.datos[0] || null;
}

/**
 * Devuelve el FV20 del correo (lo crea si no existe). Lanza SupabaseNoDisponible
 * si la base no responde: nunca inventa un código que no quedó guardado.
 */
export async function obtenerOCrearCodigo(db, { email, origen }, { ahora = Date.now(), rnd, fetchFn, legado } = {}) {
  if (!db) throw new SupabaseNoDisponible("sin-configurar");
  const e = normalizarEmail(email);
  const previo = await fv20DeCorreo(db, e, fetchFn);
  if (previo) return { codigo: previo.codigo, nuevo: false, registro: previo };
  if (legado) {
    // Migración perezosa: si este correo ya tenía su FV20 en Blobs, es ESE.
    const viejo = await legadoPorCorreo(legado, e);
    if (viejo && (await importarLegado(db, viejo, { fetchFn }))) {
      const ya = await fv20DeCorreo(db, e, fetchFn);
      if (ya) return { codigo: ya.codigo, nuevo: false, registro: ya };
    }
  }
  for (let i = 0; i < 5; i++) {
    const registro = { codigo: generarCodigoVip(rnd), tipo: "FV20", email: e, origen: origen || "vip", creado_en: new Date(ahora).toISOString(), usado: false };
    const r = await sbFetch(db, T, { method: "POST", body: registro, prefer: "return=representation", fetchFn });
    if (r.ok) return { codigo: registro.codigo, nuevo: true, registro: (Array.isArray(r.datos) && r.datos[0]) || registro };
    if (r.status === 409) {
      // O alguien creó el FV20 de este correo al mismo tiempo (índice único
      // por correo), o el código aleatorio ya existía: se mira cuál fue.
      const ya = await fv20DeCorreo(db, e, fetchFn);
      if (ya) return { codigo: ya.codigo, nuevo: false, registro: ya };
      continue;
    }
    throw new SupabaseNoDisponible("crear-fv20", r.error);
  }
  throw new SupabaseNoDisponible("crear-fv20", "no se pudo generar un código único");
}

/**
 * Marca el código como usado (idempotente). Solo lo llama el webhook con el
 * pago APROBADO. La condición usado=false va en el filtro: dos webhooks a la
 * vez no pueden pisarse la referencia.
 */
export async function marcarCodigoUsado(db, codigo, ref, { ahora = Date.now(), fetchFn, legado } = {}) {
  const c = normalizarCodigo(codigo);
  if (!db) return { ok: false, motivo: "sin-configurar" };
  const marcar = () => sbFetch(db, `${T}?codigo=eq.${filtro(c)}&usado=is.false`, {
    method: "PATCH",
    body: { usado: true, usado_en: new Date(ahora).toISOString(), referencia_pedido: ref || null },
    prefer: "return=representation",
    fetchFn
  });
  let r = await marcar();
  if (!r.ok) return { ok: false, motivo: "supabase-no-disponible", error: r.error };
  if (Array.isArray(r.datos) && r.datos.length) return { ok: true };
  let g = await sbFetch(db, `${T}?codigo=eq.${filtro(c)}&select=${CAMPOS}`, { fetchFn });
  if (!g.ok || !Array.isArray(g.datos)) return { ok: false, motivo: "supabase-no-disponible", error: g.error };
  let reg = g.datos[0];
  if (!reg && legado && RE_FV20.test(c)) {
    // Pedido firmado por el servidor anterior (código en Blobs) cuyo pago se
    // aprueba ya con este: se copia el código y se marca aquí.
    const viejo = await legadoPorCodigo(legado, c);
    if (viejo && (await importarLegado(db, viejo, { fetchFn }))) {
      r = await marcar();
      if (r.ok && Array.isArray(r.datos) && r.datos.length) return { ok: true, migrado: true };
      g = await sbFetch(db, `${T}?codigo=eq.${filtro(c)}&select=${CAMPOS}`, { fetchFn });
      reg = g.ok && Array.isArray(g.datos) ? g.datos[0] : null;
    }
  }
  if (!reg) return { ok: false, motivo: "no-existe" };
  return { ok: true, yaEstaba: true, usadoRef: reg.referencia_pedido };
}

/**
 * Guarda el correo en `suscriptores` si no estaba (el primer origen se
 * conserva). Si estaba solo como comprador ("compra"/"otro") y ahora se
 * une al Círculo o pide su código VIP, se actualiza el origen.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function guardarSuscriptor(db, { email, nombre, origen, metodo }, { ahora = Date.now(), fetchFn } = {}) {
  if (!db) return { ok: false, error: "sin-configurar" };
  const e = normalizarEmail(email);
  const fila = { email: e, nombre: nombre || null, origen: origen || "otro", metodo: metodo === "google" || metodo === "email" ? metodo : null, creado_en: new Date(ahora).toISOString() };
  const r = await sbFetch(db, `${S}?on_conflict=email`, { method: "POST", body: [fila], prefer: "resolution=ignore-duplicates,return=minimal", fetchFn });
  if (!r.ok) return { ok: false, error: r.error || "http-" + r.status };
  if (origen === "circulo" || origen === "vip") {
    // Mejor esfuerzo: un fallo aquí no cambia la respuesta.
    await sbFetch(db, `${S}?email=eq.${filtro(e)}&origen=in.(compra,otro)`, {
      method: "PATCH", body: { origen, ...(fila.metodo ? { metodo: fila.metodo } : {}) }, prefer: "return=minimal", reintentos: 0, fetchFn
    });
  }
  return { ok: true };
}

/**
 * ¿Este correo ya está en el Círculo/VIP? (reemplaza la acción "check" del
 * Apps Script). Solo dice sí/no: nunca devuelve el código.
 * @returns {Promise<boolean|null>} null = no se pudo consultar
 */
export async function estaRegistrado(db, email, { fetchFn, legado } = {}) {
  const r = await estaRegistradoSb(db, email, { fetchFn });
  if (r !== false || !legado) return r;
  const viejo = await legadoPorCorreo(legado, normalizarEmail(email));
  if (!viejo) return false;
  // Estaba en Blobs: se copia (si falla la copia, igual SÍ está registrado).
  await importarLegado(db, viejo, { fetchFn });
  return true;
}

async function estaRegistradoSb(db, email, { fetchFn } = {}) {
  if (!db) return null;
  const e = normalizarEmail(email);
  const [s, c] = await Promise.all([
    sbFetch(db, `${S}?email=eq.${filtro(e)}&origen=in.(circulo,vip)&baja=is.false&select=email`, { fetchFn, reintentos: 0, timeoutMs: 3000 }),
    sbFetch(db, `${T}?email=eq.${filtro(e)}&tipo=eq.FV20&select=codigo`, { fetchFn, reintentos: 0, timeoutMs: 3000 })
  ]);
  if (!s.ok || !c.ok) return null;
  return (Array.isArray(s.datos) && s.datos.length > 0) || (Array.isArray(c.datos) && c.datos.length > 0);
}
