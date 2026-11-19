// ============================================================
//  lib/vip-http.js  ·  Lógica HTTP de la función vip-codigo (sin Netlify)
// ------------------------------------------------------------
//  POST {"accion":"solicitar","nombre","email","origen":"vip"|"circulo","web":""}
//    -> crea (o recupera) el FV20 de ese correo, lo envía por Resend y lo
//       devuelve para mostrarlo en pantalla.
//       200 {ok:true, codigo, nuevo, correo:true|false}
//  POST {"accion":"verificar","codigo"}
//    -> 200 {ok:true, estado:"valido"|"usado"|"vencido"|"invalido"|"sin-verificar"}
//  "web" es un campo trampa (honeypot): una persona no lo ve ni lo llena.
//  Errores: 400 datos · 403 origen · 405 método · 410 VIP cerrado (VIP_HASTA)
//           413 muy grande · 429 demasiadas solicitudes · 503 almacén caído
// ============================================================
import { cabeceras, ORIGENES_OK, dentroDelLimite, enviarCorreos, esDryRun, MAX_BODY } from "./correos.js";
import { obtenerOCrearCodigo, estadoCodigoVip, configVip } from "./vip.js";

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
 * @param {{store, rlStore?, env?, fetchFn?, ahora?, rnd?}} deps  store = almacén "vip-codigos"
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
    const r = await estadoCodigoVip(deps.store, j.codigo, { env, ahora });
    return resp(200, { ok: true, estado: r.estado });
  }

  if (j.accion !== "solicitar") return resp(400, { ok: false, error: "accion-no-permitida" });
  if (Object.keys(j).some((k) => !["accion", "nombre", "email", "origen", "web"].includes(k))) return resp(400, { ok: false, error: "campos-no-permitidos" });
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
  let nombre = linea(nombreBruto, 80);
  if (!nombre && origenCodigo === "vip") err.push("nombre: obligatorio");
  if (!nombre) nombre = "coleccionista";
  if (err.length) return resp(400, { ok: false, error: "datos-invalidos", detalle: err });

  const vipCfg = configVip(env);
  if (vipCfg.hastaMs != null && ahora >= vipCfg.hastaMs) return resp(410, { ok: false, error: "vip-cerrado" });

  if (!(await dentroDelLimite("vip", req.ip, email, { store: deps.rlStore, ahora }))) return resp(429, { ok: false, error: "demasiadas-solicitudes" });
  if (!deps.store) return resp(503, { ok: false, error: "almacen-no-disponible" });

  let r;
  try {
    r = await obtenerOCrearCodigo(deps.store, { email, nombre, origen: origenCodigo }, { ahora, rnd: deps.rnd });
  } catch (e) {
    console.error("vip-codigo: almacén:", e && e.message);
    return resp(503, { ok: false, error: "almacen-no-disponible" });
  }

  // Correo: si falla, el código igual se muestra en pantalla (correo:false).
  let correo = false;
  let correos;
  if (env.RESEND_API_KEY || esDryRun(env)) {
    const datos = { nombre, email, codigo: r.codigo, origen: origenCodigo, hasta: vipCfg.hasta, hastaTexto: vipCfg.hasta ? fechaLegible(vipCfg.hasta) : "" };
    const s = await enviarCorreos("vip", datos, { env, fetchFn: deps.fetchFn });
    correo = !!(s.cliente && s.cliente.ok);
    if (esDryRun(env)) correos = [s.felipe, s.cliente].filter(Boolean).map((x) => x.correo);
  } else {
    console.error("vip-codigo: falta RESEND_API_KEY; el código se muestra pero no se envía por correo.");
  }
  const body = { ok: true, codigo: r.codigo, nuevo: r.nuevo, correo };
  if (correos) { body.dryRun = true; body.correos = correos; }
  return resp(200, body);
}
