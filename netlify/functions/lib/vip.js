// ============================================================
//  lib/vip.js  ·  Códigos de descuento y suscriptores (Supabase)
// ------------------------------------------------------------
//  Fuente de verdad: Supabase, tablas `codigos_descuento` y `suscriptores`
//  (ver migracion-supabase/01_esquema.sql). Antes: FV20 en Netlify Blobs
//  ("vip-codigos") y FV15 + suscriptores en la hoja de Google (Apps Script).
//
//    FV20-XXXXXXX  personal, 20 % sobre lista, un solo uso, uno por correo.
//                  SOLO por /vip (origen "vip").
//    FV10-XXXXXXX  personal del Círculo, 10 % sobre lista, un solo uso, uno
//                  por correo (origen "circulo"). No vence con VIP_HASTA.
//    FV15-XXXXXXX  Círculo histórico, 15 %, un solo uso (ya no se emiten).
//
//  Reglas (de Ricardo):
//   - Un FV20 por correo: pedirlo otra vez devuelve el MISMO código
//     (índice único parcial en la base: uq_codigos_fv20_por_email). Igual el
//     FV10 (uq_codigos_fv10_por_email, ver migracion-supabase/05_fv10.sql).
//   - Círculo: quien ya tiene FV20 recibe ESE (nunca se le baja a 10 %); quien
//     no, recibe su FV10. Por /vip: quien solo tiene FV10 recibe un FV20 nuevo
//     (los dos coexisten, se usa uno solo: nunca se suman).
//   - DURANTE BLACK FRIDAY el Círculo entrega un FV20 (20 % sobre lista; no se
//     suma al 15 % público). Ese FV20 (origen "circulo", creado desde el inicio
//     de la campaña) solo vale mientras Black Friday esté activo. Si la persona
//     pide luego su código por /vip, pasa a ser un FV20 normal.
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
import { configBlackFriday } from "./catalogo-precios.js";
//  `legado` (opcional en todas las funciones) = almacén viejo de Netlify Blobs
//  "vip-codigos". Si un FV20 o un correo no está en Supabase se busca allí y
//  se copia (ver lib/vip-legado.js). Sin `legado`, todo funciona igual.

export const RE_FV20 = /^FV20-[A-Z0-9]{7}$/;
export const RE_FV15 = /^FV15-[A-Z0-9]{7}$/;
export const RE_FV10 = /^FV10-[A-Z0-9]{7}$/;
// Sin 0/O ni 1/I/L para que se pueda dictar y copiar a mano sin errores.
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generarCodigoCon(prefijo, rnd = crypto.randomBytes) {
  const b = rnd(7);
  let s = "";
  for (let i = 0; i < 7; i++) s += ALFABETO[b[i] % ALFABETO.length];
  return prefijo + "-" + s;
}
export function generarCodigoVip(rnd = crypto.randomBytes) { return generarCodigoCon("FV20", rnd); }
export function generarCodigoCirculo(rnd = crypto.randomBytes) { return generarCodigoCon("FV10", rnd); }

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
const CAMPOS = "codigo,tipo,email,origen,usado,usado_en,referencia_pedido,creado_en";

/** ¿FV20 entregado por el Círculo en Black Friday (vale solo durante la campaña)? */
export function esCirculoBF(reg, env, ahora = Date.now()) {
  if (!reg || reg.tipo !== "FV20" || reg.origen !== "circulo") return false;
  const desde = Date.parse(configBlackFriday(env, ahora).desde || "");
  return !Number.isNaN(desde) && Date.parse(reg.creado_en) >= desde;
}

/**
 * Estado de un código FV20, FV15 o FV10. Nunca lanza.
 * @returns {Promise<{estado:"valido"|"usado"|"vencido"|"invalido"|"sin-verificar", registro?:object}>}
 */
export async function estadoCodigo(db, codigo, { env, ahora = Date.now(), timeoutMs, reintentos, fetchFn, legado } = {}) {
  const c = normalizarCodigo(codigo);
  if (!RE_FV20.test(c) && !RE_FV15.test(c) && !RE_FV10.test(c)) return { estado: "invalido" };
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
  if (esCirculoBF(reg, env, ahora)) {
    // No depende de VIP_HASTA: dura lo que dure Black Friday.
    if (!configBlackFriday(env, ahora).activo) return { estado: "vencido", registro: reg };
  } else if (reg.tipo === "FV20") {
    const { hastaMs } = configVip(env);
    if (hastaMs != null && ahora >= hastaMs) return { estado: "vencido", registro: reg };
  }
  return { estado: "valido", registro: reg };
}

/** Error que el que llama traduce a 503 "no se pudo, intenta de nuevo". */
export class SupabaseNoDisponible extends Error {
  constructor(paso, detalle) { super(`supabase-no-disponible (${paso}): ${detalle || ""}`); this.paso = paso; }
}

async function codigoDeCorreo(db, email, tipo, fetchFn) {
  const r = await sbFetch(db, `${T}?email=eq.${filtro(email)}&tipo=eq.${tipo}&select=${CAMPOS}`, { fetchFn });
  if (!r.ok || !Array.isArray(r.datos)) throw new SupabaseNoDisponible("leer-" + tipo.toLowerCase(), r.error);
  return r.datos[0] || null;
}
const fv20DeCorreo = (db, email, fetchFn) => codigoDeCorreo(db, email, "FV20", fetchFn);
const fv10DeCorreo = (db, email, fetchFn) => codigoDeCorreo(db, email, "FV10", fetchFn);

/**
 * Devuelve el código personal del correo (lo crea si no existe). Lanza
 * SupabaseNoDisponible si la base no responde: nunca inventa un código que no
 * quedó guardado.
 *   origen "vip"     -> su FV20 (si solo tenía FV10, se crea el FV20: coexisten)
 *   origen "circulo" -> su FV20 si ya lo tiene (nunca se le baja); si no, en
 *                       Black Friday un FV20 de campaña y fuera de ella su FV10
 * @returns {{codigo, tipo:"FV20"|"FV10", pct:20|10, nuevo:boolean, soloBF:boolean, registro}}
 */
export async function obtenerOCrearCodigo(db, { email, origen }, { env, ahora = Date.now(), rnd, fetchFn, legado } = {}) {
  if (!db) throw new SupabaseNoDisponible("sin-configurar");
  const e = normalizarEmail(email);
  const salida = (registro, nuevo) => {
    const tipo = registro.tipo === "FV10" ? "FV10" : "FV20";
    return { codigo: registro.codigo, tipo, pct: tipo === "FV10" ? 10 : 20, nuevo, soloBF: esCirculoBF(registro, env, ahora), registro };
  };
  const esCirculo = origen === "circulo";
  const bfActivo = configBlackFriday(env, ahora).activo;
  // 1) ¿ya tiene FV20 (Supabase o Blobs viejo)? Sirve para los dos orígenes.
  const previo = await fv20DeCorreo(db, e, fetchFn);
  if (previo && !esCirculoBF(previo, env, ahora)) return salida(previo, false);
  if (previo) {
    if (!esCirculo) {
      // Pide su código por /vip: su FV20 de campaña pasa a ser un FV20 normal.
      const r = await sbFetch(db, `${T}?codigo=eq.${filtro(previo.codigo)}`, { method: "PATCH", body: { origen: "vip" }, prefer: "return=representation", fetchFn });
      if (!r.ok) throw new SupabaseNoDisponible("promover-fv20", r.error);
      return salida({ ...previo, origen: "vip" }, false);
    }
    if (bfActivo) return salida(previo, false);
    // Círculo fuera de Black Friday: el FV20 de campaña ya no vale; va su FV10.
  } else if (legado) {
    // Migración perezosa: si este correo ya tenía su FV20 en Blobs, es ESE.
    const viejo = await legadoPorCorreo(legado, e);
    if (viejo && (await importarLegado(db, viejo, { fetchFn }))) {
      const ya = await fv20DeCorreo(db, e, fetchFn);
      if (ya) return salida(ya, false);
    }
  }
  // 2) Círculo fuera de Black Friday: su FV10 (el que ya tenga, o uno nuevo).
  const pideFV10 = esCirculo && !bfActivo;
  if (pideFV10) {
    const p10 = await fv10DeCorreo(db, e, fetchFn);
    if (p10) return salida(p10, false);
  }
  const tipo = pideFV10 ? "FV10" : "FV20";
  for (let i = 0; i < 5; i++) {
    const registro = { codigo: pideFV10 ? generarCodigoCirculo(rnd) : generarCodigoVip(rnd), tipo, email: e, origen: origen || "vip", creado_en: new Date(ahora).toISOString(), usado: false };
    const r = await sbFetch(db, T, { method: "POST", body: registro, prefer: "return=representation", fetchFn });
    if (r.ok) return salida((Array.isArray(r.datos) && r.datos[0]) || registro, true);
    if (r.status === 409) {
      // O alguien creó el código de este correo al mismo tiempo (índice único
      // por correo), o el código aleatorio ya existía: se mira cuál fue.
      const ya = await codigoDeCorreo(db, e, tipo, fetchFn);
      if (ya) return salida(ya, false);
      continue;
    }
    throw new SupabaseNoDisponible("crear-" + tipo.toLowerCase(), r.error);
  }
  throw new SupabaseNoDisponible("crear-" + tipo.toLowerCase(), "no se pudo generar un código único");
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
    sbFetch(db, `${T}?email=eq.${filtro(e)}&tipo=in.(FV20,FV10)&select=codigo`, { fetchFn, reintentos: 0, timeoutMs: 3000 })
  ]);
  if (!s.ok || !c.ok) return null;
  return (Array.isArray(s.datos) && s.datos.length > 0) || (Array.isArray(c.datos) && c.datos.length > 0);
}
