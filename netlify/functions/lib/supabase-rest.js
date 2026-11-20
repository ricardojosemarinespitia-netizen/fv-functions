// ============================================================
//  lib/supabase-rest.js  ·  Cliente mínimo de la API REST de Supabase
// ------------------------------------------------------------
//  Lo usan los códigos (lib/codigos.js), los suscriptores y los pedidos.
//  Sin dependencias: fetch + AbortController.
//
//  Variables de entorno (Netlify > Environment variables):
//    SUPABASE_URL          https://<ref>.supabase.co
//    SUPABASE_SERVICE_KEY  service_role (ignora RLS: NUNCA va al navegador)
//
//  Reglas:
//   - Nunca lanza: devuelve {ok, status, datos, error}.
//   - Timeout por intento (AbortController) y reintentos CORTOS solo ante
//     fallo de red, timeout o 5xx. Un 4xx no se reintenta (es un error
//     nuestro o un conflicto que el que llama sabe manejar, p. ej. 409).
//   - status 0 = no hubo respuesta (red caída, timeout, sin configurar).
// ============================================================

/** Lee la configuración. null = Supabase no está configurado. */
export function configSupabase(env = (typeof process !== "undefined" ? process.env : {})) {
  const url = String((env && env.SUPABASE_URL) || "").trim().replace(/\/+$/, "");
  const key = String((env && env.SUPABASE_SERVICE_KEY) || "").trim();
  return url && key ? { url, key } : null;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{url:string,key:string}|null} cfg
 * @param {string} ruta  p. ej. "/rest/v1/codigos_descuento?codigo=eq.FV20-ABCDEFG"
 * @param {{method?, body?, prefer?, timeoutMs?, reintentos?, fetchFn?}} o
 * @returns {Promise<{ok:boolean,status:number,datos:any,error?:string}>}
 */
export async function sbFetch(cfg, ruta, o = {}) {
  if (!cfg) return { ok: false, status: 0, datos: null, error: "sin-configurar" };
  const { method = "GET", body, prefer, timeoutMs = 4000, reintentos = 1, fetchFn = globalThis.fetch } = o;
  const headers = { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  let ultimo = { ok: false, status: 0, datos: null, error: "sin-intento" };
  for (let intento = 0; intento <= reintentos; intento++) {
    if (intento) await esperar(250 * intento);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchFn(cfg.url + ruta, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal
      });
      const texto = await r.text().catch(() => "");
      let datos = null;
      try { datos = texto ? JSON.parse(texto) : null; } catch { datos = texto; }
      ultimo = { ok: r.ok, status: r.status, datos, error: r.ok ? undefined : (datos && datos.message) || texto.slice(0, 200) || "http-" + r.status };
      if (r.ok || r.status < 500) return ultimo; // 2xx o 4xx: respuesta definitiva
    } catch (e) {
      ultimo = { ok: false, status: 0, datos: null, error: e && e.name === "AbortError" ? "timeout" : (e && e.message) || "red" };
    } finally {
      clearTimeout(t);
    }
  }
  return ultimo;
}

/** Valor seguro para un filtro de PostgREST (eq.<valor>). */
export const filtro = (v) => encodeURIComponent(String(v == null ? "" : v));
