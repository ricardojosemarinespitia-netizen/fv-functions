// ============================================================
//  Supabase FALSO para pruebas sin red (servidor HTTP local, PostgREST mínimo)
// ------------------------------------------------------------
//  Imita lo que usan las funciones: GET con filtros eq./is./in., POST con
//  on_conflict + Prefer resolution/return, PATCH con filtros. Aplica las
//  mismas restricciones que la base real (01_esquema.sql + tablas viejas):
//   - únicos: suscriptores.email, codigos_descuento.codigo, FV20 por email,
//     clientes.email, pedidos.referencia
//   - checks: correos en minúsculas, formato y tipo de código
//   - permisos: service_role SIN UPDATE en pedidos / pedidos_items (403)
//  Modos de falla: srv.modo = "ok" | "caido" (503) | "lento" (no contesta a tiempo)
// ============================================================
import http from "node:http";
import crypto from "node:crypto";

export const CLAVE = "clave-de-prueba-service-role";

const UNICOS = {
  suscriptores: [["email"]],
  codigos_descuento: [["codigo"], ["email", (f) => f.tipo === "FV20"]],
  clientes: [["email"]],
  pedidos: [["referencia"]],
  pedidos_items: []
};
const SIN_UPDATE = new Set(["pedidos", "pedidos_items"]);
const DEFECTOS = {
  suscriptores: () => ({ id: crypto.randomUUID(), origen: "otro", baja: false, es_prueba: false, notas: null, metodo: null, creado_en: new Date().toISOString() }),
  codigos_descuento: () => ({ usado: false, usado_en: null, referencia_pedido: null, origen: null, creado_en: new Date().toISOString() }),
  clientes: () => ({ id: crypto.randomUUID(), creado_en: new Date().toISOString() }),
  pedidos: () => ({ id: crypto.randomUUID(), estado_pago: "APPROVED", origen: "webhook", fecha_pedido: new Date().toISOString() }),
  pedidos_items: () => ({ id: crypto.randomUUID() })
};

function revisar(t, f) {
  const minus = (e) => e == null || e === String(e).trim().toLowerCase();
  if ((t === "suscriptores" || t === "codigos_descuento") && !minus(f.email)) return "check email en minúsculas";
  if (t === "suscriptores" && !["circulo", "vip", "compra", "otro"].includes(f.origen)) return "check origen";
  if (t === "codigos_descuento") {
    if (!/^FV(15|20)-[A-Z0-9]{7}$/.test(f.codigo)) return "check formato";
    if (f.codigo.slice(0, 4) !== f.tipo) return "check tipo";
  }
  return null;
}

function filtrar(filas, params) {
  let r = filas;
  for (const [k, v] of params) {
    if (["select", "on_conflict", "order", "limit"].includes(k)) continue;
    const [op, ...resto] = v.split(".");
    const val = resto.join(".");
    if (op === "eq") r = r.filter((f) => String(f[k]) === val);
    else if (op === "is") r = r.filter((f) => (val === "null" ? f[k] == null : String(!!f[k]) === val));
    else if (op === "in") { const set = val.replace(/^\(|\)$/g, "").split(","); r = r.filter((f) => set.includes(String(f[k]))); }
    else throw new Error("operador no soportado en el falso: " + op);
  }
  return r;
}

export async function iniciarSupabaseFalso() {
  const db = { suscriptores: [], codigos_descuento: [], clientes: [], pedidos: [], pedidos_items: [] };
  const srv = { db, modo: "ok", llamadas: [] };
  const server = http.createServer(async (req, res) => {
    let cuerpo = "";
    for await (const c of req) cuerpo += c;
    const u = new URL(req.url, "http://x");
    srv.llamadas.push({ metodo: req.method, ruta: u.pathname + u.search });
    // Connection: close -> sin conexiones vivas que impidan terminar la prueba.
    const json = (st, d) => { res.writeHead(st, { "Content-Type": "application/json", Connection: "close" }); res.end(d === undefined ? "" : JSON.stringify(d)); };
    if (srv.modo === "caido") return json(503, { message: "servicio no disponible (simulado)" });
    if (srv.modo === "lento") { await new Promise((r) => setTimeout(r, 6000)); return json(503, {}); }
    if (req.headers.apikey !== CLAVE || req.headers.authorization !== "Bearer " + CLAVE) return json(401, { message: "clave inválida" });
    const m = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m || !db[m[1]]) return json(404, { message: "tabla no existe" });
    const t = m[1], tabla = db[t], params = [...u.searchParams];
    const prefer = String(req.headers.prefer || "");
    const rep = prefer.includes("return=representation");
    try {
      if (req.method === "GET") return json(200, filtrar(tabla, params));
      if (req.method === "POST") {
        const entrada = JSON.parse(cuerpo);
        const filas = Array.isArray(entrada) ? entrada : [entrada];
        const onc = u.searchParams.get("on_conflict");
        const salida = [];
        for (const f0 of filas) {
          const f = { ...DEFECTOS[t](), ...f0 };
          const err = revisar(t, f);
          if (err) return json(400, { code: "23514", message: err });
          const choque = tabla.find((x) => UNICOS[t].some(([col, cond]) => (!cond || (cond(x) && cond(f))) && x[col] != null && x[col] === f[col]));
          if (choque) {
            if (onc && prefer.includes("resolution=ignore-duplicates")) continue;
            if (onc && prefer.includes("resolution=merge-duplicates")) {
              if (SIN_UPDATE.has(t)) return json(403, { code: "42501", message: "permission denied" });
              Object.assign(choque, f0); salida.push(choque); continue;
            }
            return json(409, { code: "23505", message: "duplicate key value violates unique constraint" });
          }
          tabla.push(f); salida.push(f);
        }
        return rep ? json(201, salida) : json(201);
      }
      if (req.method === "PATCH") {
        if (SIN_UPDATE.has(t)) return json(403, { code: "42501", message: "permission denied for table " + t });
        const cambios = JSON.parse(cuerpo);
        const afectadas = filtrar(tabla, params);
        for (const f of afectadas) Object.assign(f, cambios);
        return rep ? json(200, afectadas) : json(204);
      }
      if (req.method === "DELETE") return json(403, { code: "42501", message: "permission denied (sin DELETE)" });
      return json(405, { message: "método" });
    } catch (e) {
      return json(500, { message: e.message });
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  srv.url = `http://127.0.0.1:${server.address().port}`;
  srv.cfg = { url: srv.url, key: CLAVE };
  srv.cerrar = () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); });
  return srv;
}
