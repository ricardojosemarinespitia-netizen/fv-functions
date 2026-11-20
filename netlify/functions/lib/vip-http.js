// ============================================================
//  lib/vip-http.js  ·  Lógica HTTP de la función vip-codigo (sin Netlify)
// ------------------------------------------------------------
//  POST {"accion":"solicitar","nombre","email","origen":"vip"|"circulo","web":""}
//    -> crea (o recupera) el código personal de ese correo, lo envía por Resend
//       y lo devuelve para mostrarlo en pantalla.
//         origen "vip"     -> FV20 (20 %)
//         origen "circulo" -> su FV20 si ya lo tiene; si no, FV10 (10 %)
//       200 {ok:true, codigo, tipo:"FV20"|"FV10", pct:20|10, nuevo, correo:true|false}
//       Opcional "metodo":"email"|"google" (cómo dejó el correo).
//       El correo queda en Supabase `suscriptores` y el código en
//       `codigos_descuento`.
//  POST {"accion":"verificar","codigo"}   (FV20, FV15 o FV10)
//    -> 200 {ok:true, estado:"valido"|"usado"|"vencido"|"invalido"|"sin-verificar"}
//  POST {"accion":"registrado","email"}   (reemplaza "check" del Apps Script)
//    -> 200 {ok:true, registrado:true|false}  · 503 si no se pudo consultar
//       Solo sí/no: el código NUNCA se devuelve a quien no lo pidió.
//  "web" es un campo trampa (honeypot): una persona no lo ve ni lo llena.
//  Errores: 400 datos · 403 origen · 405 método · 410 VIP cerrado (VIP_HASTA)
//           413 muy grande · 429 demasiadas solicitudes
//           503 {error:"no-disponible", guardado} Supabase no respondió; si
//               guardado=true el correo quedó en la cola de respaldo.
// ============================================================
import { cabeceras, ORIGENES_OK, dentroDelLimite, enviarCorreos, esDryRun, MAX_BODY } from "./correos.js";
import { obtenerOCrearCodigo, estadoCodigo, configVip, guardarSuscriptor, estaRegistrado } from "./vip.js";

const RE_EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const RE_ENLACE = /(https?:|ftp:|www\.|[a-z0-9-]+\.(com|co|net|org|info|biz|xyz|top|ru|io|ly|me|link|click|site|online|shop)(\/|\b))/i;
const esObjeto = (o) => o && typeof o === "object" && !Array.isArray(o);
const linea = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function fechaLegible(iso) {
  try {
    return new Date(iso).toLocaleString("es-CO", { timeZone: "America/Bogota", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return iso; }
}

/**
 * @param {{metodo, origen, ip, cuerpo}} req
 * @param {{db, rlStore?, env?, fetchFn?, ahora?, rnd?, guardarPendiente?, legado?}} deps
 *   legado = almacén Blobs viejo "vip-codigos" (migración perezosa, lib/vip-legado.js)
 *   db = configSupabase() · guardarPendiente(datos) = cola de respaldo si Supabase cae
 */
export async function procesarVip(req, deps = {}) {
  const h = cabeceras(req.origen);
  const resp = (status, body) => ({ status, headers: h, body });
  if (req.metodo === "OPTIONS") return ORIGENES_OK.includes(req.origen) ? { status: 204, headers: h, body: null } : resp(403, { ok: false, error: "origen-no-permitido" });
  if (req.metodo !== "POST") return resp(405, { ok: false, error: "metodo-no-permitido" });
  if (!ORIGENES_OK.includes(req.origen)) return resp(403, { ok: false, error: "origen-no-permitido" });

  const env = deps.env || process.env;
  const ahora = deps.ahora != null ? deps.ahora : Date.now();
  const texto = typeof req.cuerpo === "string" ? req.cuerpo : "";
  if (Buffer.byteLength(texto, "utf8") > 4096) return resp(413, { ok: false, error: "cuerpo-muy-grande" });
  let j;
  try { j = JSON.parse(texto); } catch { return resp(400, { ok: false, error: "json-invalido" }); }
  if (!esObjeto(j)) return resp(400, { ok: false, error: "json-invalido" });

  if (j.accion === "verificar") {
    if (Object.keys(j).some((k) => !["accion", "codigo"].includes(k))) return resp(400, { ok: false, error: "campos-no-permitidos" });
    if (!(await dentroDelLimite("vipVerificar", req.ip, "-", { store: deps.rlStore, ahora }))) return resp(429, { ok: false, error: "demasiadas-solicitudes" });
    const r = await estadoCodigo(deps.db, j.codigo, { env, ahora, timeoutMs: 3000, reintentos: 1, legado: deps.legado });
    return resp(200, { ok: true, estado: r.estado });
  }

  if (j.accion === "registrado") {
    if (Object.keys(j).some((k) => !["accion", "email"].includes(k))) return resp(400, { ok: false, error: "campos-no-permitidos" });
    const em = typeof j.email === "string" ? j.email.trim() : "";
    if (em.length > 120 || !RE_EMAIL.test(em)) return resp(400, { ok: false, error: "datos-invalidos", detalle: ["email: correo inválido"] });
    if (!(await dentroDelLimite("vipVerificar", req.ip, em, { store: deps.rlStore, ahora }))) return resp(429, { ok: false, error: "demasiadas-solicitudes" });
    const reg = await estaRegistrado(deps.db, em, { legado: deps.legado });
    if (reg == null) return resp(503, { ok: false, error: "no-disponible" });
    return resp(200, { ok: true, registrado: reg });
  }

  if (j.accion !== "solicitar") return resp(400, { ok: false, error: "accion-no-permitida" });
  if (Object.keys(j).some((k) => !["accion", "nombre", "email", "origen", "web", "metodo"].includes(k))) return resp(400, { ok: false, error: "campos-no-permitidos" });
  // Honeypot: un bot llena todo. No se crea nada.
  if (j.web) return resp(400, { ok: false, error: "solicitud-invalida" });

  const origenCodigo = j.origen === "circulo" ? "circulo" : j.origen == null || j.origen === "vip" ? "vip" : null;
  if (!origenCodigo) return resp(400, { ok: false, error: "datos-invalidos", detalle: ["origen: valor no permitido"] });
  const email = typeof j.email === "string" ? j.email.trim() : "";
  const err = [];
  if (email.length > 120 || !RE_EMAIL.test(email)) err.push("email: correo inválido");
  if (j.nombre != null && typeof j.nombre !== "string") err.push("nombre: debe ser texto");
  const nombreBruto = typeof j.nombre === "string" ? j.nombre : "";
  if (nombreBruto.length > 160) err.push("nombre: demasiado largo");
  if (RE_ENLACE.test(nombreBruto)) err.push("nombre: no se permiten enlaces");
  if (j.metodo != null && !["email", "google"].includes(j.metodo)) err.push("metodo: valor no permitido");
  let nombre = linea(nombreBruto, 80);
  if (!nombre && origenCodigo === "vip") err.push("nombre: obligatorio");
  const nombreReal = nombre; // el que escribió la persona ("" si no puso)
  if (!nombre) nombre = "coleccionista";
  if (err.length) return resp(400, { ok: false, error: "datos-invalidos", detalle: err });

  const vipCfg = configVip(env);
  // VIP_HASTA cierra solo /vip: el FV10 del Círculo no vence con él.
  if (origenCodigo === "vip" && vipCfg.hastaMs != null && ahora >= vipCfg.hastaMs) return resp(410, { ok: false, error: "vip-cerrado" });

  if (!(await dentroDelLimite("vip", req.ip, email, { store: deps.rlStore, ahora }))) return resp(429, { ok: false, error: "demasiadas-solicitudes" });

  // 1) El correo primero: aunque el código falle, la persona queda registrada.
  // 2) Luego el código (FV10 del Círculo / FV20 de /vip). Si Supabase no responde en cualquiera de los dos, NO se
  //    inventa un código: 503 claro y el correo va a la cola de respaldo.
  const suscriptor = { email, nombre: nombreReal || null, origen: origenCodigo, metodo: j.metodo || "email" };
  const noDisponible = async (paso, detalle) => {
    console.error("vip-codigo: Supabase no disponible en", paso, "->", detalle);
    let guardado = false;
    if (deps.guardarPendiente) {
      try { await deps.guardarPendiente({ ...suscriptor, paso, en: new Date(ahora).toISOString() }); guardado = true; }
      catch (e) { console.error("vip-codigo: tampoco se pudo guardar en la cola de respaldo:", e && e.message, JSON.stringify(suscriptor)); }
    } else {
      console.error("vip-codigo: sin cola de respaldo; correo a recuperar:", JSON.stringify(suscriptor));
    }
    return resp(503, { ok: false, error: "no-disponible", guardado });
  };
  const gs = await guardarSuscriptor(deps.db, suscriptor, { ahora });
  if (!gs.ok) return noDisponible("suscriptor", gs.error);

  let r;
  try {
    r = await obtenerOCrearCodigo(deps.db, { email, origen: origenCodigo }, { ahora, rnd: deps.rnd, legado: deps.legado });
  } catch (e) {
    return noDisponible("codigo", e && e.message);
  }

  // Correo: si falla, el código igual se muestra en pantalla (correo:false).
  let correo = false;
  let correos;
  if (env.RESEND_API_KEY || esDryRun(env)) {
    const datos = { nombre, email, codigo: r.codigo, tipo: r.tipo, origen: origenCodigo, hasta: r.tipo === "FV20" ? vipCfg.hasta : null, hastaTexto: r.tipo === "FV20" && vipCfg.hasta ? fechaLegible(vipCfg.hasta) : "" };
    const s = await enviarCorreos("vip", datos, { env, fetchFn: deps.fetchFn });
    correo = !!(s.cliente && s.cliente.ok);
    if (esDryRun(env)) correos = [s.felipe, s.cliente].filter(Boolean).map((x) => x.correo);
  } else {
    console.error("vip-codigo: falta RESEND_API_KEY; el código se muestra pero no se envía por correo.");
  }
  const body = { ok: true, codigo: r.codigo, tipo: r.tipo, pct: r.pct, nuevo: r.nuevo, correo };
  if (correos) { body.dryRun = true; body.correos = correos; }
  return resp(200, body);
}
