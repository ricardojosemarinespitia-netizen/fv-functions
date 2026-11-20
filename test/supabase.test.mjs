// Pruebas SIN red de la conexión con Supabase: node test/supabase.test.mjs
// Base = Supabase FALSO local (test/supabase-falso.mjs) con las mismas
// restricciones que la real. Cubre: suscriptores, FV20/FV15, "registrado",
// fallas de Supabase (caído / lento), pedidos del webhook y de WhatsApp.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { procesarVip } from "../netlify/functions/lib/vip-http.js";
import { estadoCodigo, marcarCodigoUsado, obtenerOCrearCodigo, guardarSuscriptor, estaRegistrado } from "../netlify/functions/lib/vip.js";
import { registrarEnSupabase } from "../netlify/functions/lib/supabase-pedidos.js";
import { procesarVenta } from "../netlify/functions/ventas-registrar.js";
import { sbFetch, configSupabase } from "../netlify/functions/lib/supabase-rest.js";
import { _reiniciarLimites } from "../netlify/functions/lib/correos.js";
import { iniciarSupabaseFalso } from "./supabase-falso.mjs";

const RE_FV20_T = /^FV20-[A-Z0-9]{7}$/;
const fetchReal = globalThis.fetch;
const salidas = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("http://127.0.0.1:")) return fetchReal(url, init);
  salidas.push(String(url));
  if (String(url).startsWith("https://script.google.com/")) return new Response("ok", { status: 200 }); // hoja (respaldo) simulada
  throw new Error("RED BLOQUEADA en pruebas: " + url);
};
const SB = await iniciarSupabaseFalso();
const db = SB.cfg;
const limpiar = () => { for (const k of Object.keys(SB.db)) SB.db[k].length = 0; SB.modo = "ok"; salidas.length = 0; _reiniciarLimites(); };
const O = "https://felipevergel.com";
const ENV = { RESEND_DRY_RUN: "1", EMAIL_FELIPE: "avisos@felipevergel.com", RESEND_FROM: "Felipe Vergel <pedidos@felipevergel.com>" };
const req = (body, extra = {}) => ({ metodo: "POST", origen: O, ip: "1.1.1.1", cuerpo: JSON.stringify(body), ...extra });
const silencio = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };

let ok = 0;
async function prueba(n, fn) { limpiar(); try { await fn(); ok++; console.log("  ok  " + n); } catch (e) { console.error("  FALLA " + n + "\n", e); process.exitCode = 1; } }

await prueba("configSupabase: sin variables = null (no hace nada); con variables = {url,key} sin / final", async () => {
  assert.equal(configSupabase({}), null);
  assert.deepEqual(configSupabase({ SUPABASE_URL: "https://x.supabase.co/", SUPABASE_SERVICE_KEY: "k" }), { url: "https://x.supabase.co", key: "k" });
  const r = await sbFetch(null, "/rest/v1/suscriptores");
  assert.equal(r.ok, false); assert.equal(r.error, "sin-configurar");
});

await prueba("solicitar: guarda el suscriptor (origen, método, nombre real) y el FV20 en la base", async () => {
  const r = await procesarVip(req({ accion: "solicitar", origen: "circulo", email: "  Ana@Example.com ", metodo: "google", web: "" }), { db, env: ENV });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [s] = SB.db.suscriptores;
  assert.equal(s.email, "ana@example.com"); assert.equal(s.origen, "circulo"); assert.equal(s.metodo, "google");
  assert.equal(s.nombre, null, "sin nombre escrito no se guarda 'coleccionista'");
  const [c] = SB.db.codigos_descuento;
  assert.equal(c.codigo, r.body.codigo); assert.equal(c.tipo, "FV20"); assert.equal(c.email, "ana@example.com"); assert.equal(c.origen, "circulo"); assert.equal(c.usado, false);
});

await prueba("un FV20 por correo aunque lleguen dos solicitudes a la vez (índice único por correo)", async () => {
  const [a, b] = await Promise.all([
    obtenerOCrearCodigo(db, { email: "par@example.com", origen: "vip" }),
    obtenerOCrearCodigo(db, { email: "par@example.com", origen: "vip" })
  ]);
  assert.equal(a.codigo, b.codigo);
  assert.equal(SB.db.codigos_descuento.filter((x) => x.email === "par@example.com").length, 1);
});

await prueba("colisión de código aleatorio: se genera otro, no se pisa el ajeno", async () => {
  SB.db.codigos_descuento.push({ codigo: "FV20-AAAAAAA", tipo: "FV20", email: "otro@example.com", usado: false });
  let n = 0;
  const rnd = (k) => Buffer.alloc(k, n++ === 0 ? 0 : 1); // 1.º intento = FV20-AAAAAAA (choca), 2.º = FV20-BBBBBBB
  const r = await obtenerOCrearCodigo(db, { email: "nuevo@example.com", origen: "vip" }, { rnd });
  assert.equal(r.codigo, "FV20-BBBBBBB");
  assert.equal(SB.db.codigos_descuento.find((x) => x.codigo === "FV20-AAAAAAA").email, "otro@example.com");
});

await prueba("comprador que luego se une al Círculo: el origen pasa de 'compra' a 'circulo'; uno del Círculo no se pisa", async () => {
  await guardarSuscriptor(db, { email: "c@example.com", nombre: "Cata", origen: "compra" });
  await guardarSuscriptor(db, { email: "c@example.com", nombre: "Otra", origen: "circulo", metodo: "email" });
  assert.equal(SB.db.suscriptores.length, 1);
  assert.equal(SB.db.suscriptores[0].origen, "circulo"); assert.equal(SB.db.suscriptores[0].nombre, "Cata", "el nombre original se conserva");
  await guardarSuscriptor(db, { email: "c@example.com", origen: "compra" });
  assert.equal(SB.db.suscriptores[0].origen, "circulo", "una compra no baja a un miembro del Círculo");
});

await prueba("verificar FV15 histórico: válido, usado, inexistente; FV20 vencido; formato malo", async () => {
  SB.db.codigos_descuento.push(
    { codigo: "FV15-ABC1234", tipo: "FV15", email: "h@example.com", usado: false },
    { codigo: "FV15-USADO12", tipo: "FV15", email: "u@example.com", usado: true, referencia_pedido: "FV-1790000000000-AAAAA" },
    { codigo: "FV20-VVVVVVV", tipo: "FV20", email: "v@example.com", usado: false }
  );
  const ver = async (codigo, env = ENV) => (await procesarVip(req({ accion: "verificar", codigo }), { db, env })).body.estado;
  assert.equal(await ver("fv15-abc1234"), "valido");
  assert.equal(await ver("FV15-USADO12"), "usado");
  assert.equal(await ver("FV15-NOEXIST"), "invalido");
  assert.equal(await ver("HOLA"), "invalido");
  assert.equal(await ver("FV20-VVVVVVV", { ...ENV, VIP_HASTA: "2020-01-01T00:00:00-05:00" }), "vencido");
  assert.equal(await ver("FV15-ABC1234", { ...ENV, VIP_HASTA: "2020-01-01T00:00:00-05:00" }), "valido", "FV15 no vence con VIP_HASTA");
});

await prueba("Supabase CAÍDO (503): verificar -> 'sin-verificar'; solicitar -> 503 sin código y el correo a la cola de respaldo", async () => {
  SB.modo = "caido";
  assert.equal((await estadoCodigo(db, "FV15-ABC1234")).estado, "sin-verificar");
  const cola = [];
  const r = await silencio(() => procesarVip(req({ accion: "solicitar", origen: "vip", nombre: "Lu", email: "lu@example.com", web: "" }), { db, env: ENV, guardarPendiente: async (d) => cola.push(d) }));
  assert.equal(r.status, 503); assert.equal(r.body.error, "no-disponible"); assert.equal(r.body.guardado, true);
  assert.equal(r.body.codigo, undefined, "no se inventa un código");
  assert.equal(cola.length, 1); assert.equal(cola[0].email, "lu@example.com"); assert.equal(cola[0].paso, "suscriptor");
  // sin cola de respaldo: igual 503, y el correo queda en el log
  const r2 = await silencio(() => procesarVip(req({ accion: "solicitar", origen: "vip", nombre: "Lu", email: "lu2@example.com", web: "" }), { db, env: ENV }));
  assert.equal(r2.status, 503); assert.equal(r2.body.guardado, false);
});

await prueba("Supabase LENTO: verificar corta en el timeout (sin colgar el pago) y no da descuento", async () => {
  SB.modo = "lento";
  const t0 = Date.now();
  const e = await estadoCodigo(db, "FV20-ABCDEFG", { timeoutMs: 300, reintentos: 0 });
  assert.equal(e.estado, "sin-verificar");
  assert.ok(Date.now() - t0 < 2000, "tardó " + (Date.now() - t0) + " ms");
});

await prueba("Supabase sin configurar: verificar 'sin-verificar', solicitar 503, registrado 503", async () => {
  assert.equal((await estadoCodigo(null, "FV15-ABC1234")).estado, "sin-verificar");
  const r = await silencio(() => procesarVip(req({ accion: "solicitar", origen: "vip", nombre: "X", email: "x@example.com", web: "" }), { db: null, env: ENV }));
  assert.equal(r.status, 503);
  assert.equal((await procesarVip(req({ accion: "registrado", email: "x@example.com" }), { db: null, env: ENV })).status, 503);
});

await prueba("registrado: sí para Círculo/VIP, no para solo-comprador o desconocido; nunca devuelve el código", async () => {
  await guardarSuscriptor(db, { email: "circ@example.com", origen: "circulo" });
  await guardarSuscriptor(db, { email: "comp@example.com", origen: "compra" });
  SB.db.codigos_descuento.push({ codigo: "FV20-SOLOCOD", tipo: "FV20", email: "solo@example.com", usado: false });
  const reg = async (email) => (await procesarVip(req({ accion: "registrado", email }), { db, env: ENV }));
  const a = await reg("CIRC@example.com");
  assert.deepEqual(a.body, { ok: true, registrado: true });
  assert.equal((await reg("comp@example.com")).body.registrado, false);
  assert.equal((await reg("nadie@example.com")).body.registrado, false);
  assert.equal((await reg("solo@example.com")).body.registrado, true);
  assert.equal((await reg("no-es-correo")).status, 400);
  assert.equal((await procesarVip(req({ accion: "registrado", email: "a@b.co", codigo: "x" }), { db, env: ENV })).status, 400);
  assert.equal(await estaRegistrado(db, "circ@example.com"), true);
});

await prueba("solicitar con metodo no permitido -> 400 y no se guarda nada", async () => {
  const r = await procesarVip(req({ accion: "solicitar", origen: "vip", nombre: "Ana", email: "m@example.com", metodo: "facebook", web: "" }), { db, env: ENV });
  assert.equal(r.status, 400);
  assert.equal(SB.db.suscriptores.length + SB.db.codigos_descuento.length, 0);
});

await prueba("marcar usado: idempotente, no pisa la referencia, FV15 también; inexistente -> no-existe; caído -> error claro", async () => {
  SB.db.codigos_descuento.push({ codigo: "FV15-ABC1234", tipo: "FV15", email: "h@example.com", usado: false, usado_en: null, referencia_pedido: null });
  const a = await marcarCodigoUsado(db, "FV15-ABC1234", "FV-1795000000000-PRIME");
  assert.deepEqual(a, { ok: true });
  const b = await marcarCodigoUsado(db, "FV15-ABC1234", "FV-1795000000001-OTRAA");
  assert.equal(b.yaEstaba, true); assert.equal(b.usadoRef, "FV-1795000000000-PRIME");
  assert.equal(SB.db.codigos_descuento[0].referencia_pedido, "FV-1795000000000-PRIME");
  assert.ok(SB.db.codigos_descuento[0].usado_en);
  assert.equal((await marcarCodigoUsado(db, "FV20-NOEXIST", "FV-1795000000002-XXXXX")).motivo, "no-existe");
  SB.modo = "caido";
  assert.equal((await marcarCodigoUsado(db, "FV15-ABC1234", "x")).motivo, "supabase-no-disponible");
});

const pedidoWompi = {
  fullName: "Ana Prueba", email: "Ana@Example.com", phone: "3000000000", docId: "123", address: "Calle 1", city: "Floridablanca",
  department: "Santander", zipCode: "681001", deliveryMethod: "domicilio", paymentMethod: "pse", notes: "Regalo",
  subtotal: 299000, discountAmount: 59800, discountCode: "FV20-ABCDEFG", shipping: 35880, total: 275080,
  cart: [{ id: "lampara-caribe-brisa", sku: "LAM-002", qty: 1, name: "Lámpara Caribe Brisa", color: "Azul", price: 299000 }]
};

await prueba("pedido del webhook: cliente + pedido + piezas + suscriptor 'compra'; repetirlo no duplica", async () => {
  const ref = "FV-1795000000100-WEBHK";
  const r = await registrarEnSupabase(ref, pedidoWompi, { id: "tx-1", status: "APPROVED" }, { db });
  assert.deepEqual(r, { ok: true, motivo: "registrado" });
  const [p] = SB.db.pedidos;
  assert.equal(p.referencia, ref); assert.equal(p.cliente_email, "ana@example.com"); assert.equal(p.total, 275080);
  assert.equal(p.descuento, 59800); assert.equal(p.codigo_descuento, "FV20-ABCDEFG"); assert.equal(p.codigo_postal, "681001", "zipCode llega a la base (antes se perdía)");
  assert.equal(p.wompi_tx_id, "tx-1"); assert.equal(p.origen, "webhook"); assert.equal(p.cliente_id, SB.db.clientes[0].id);
  assert.equal(SB.db.pedidos_items.length, 1); assert.equal(SB.db.pedidos_items[0].pedido_id, p.id);
  assert.equal(SB.db.suscriptores[0].origen, "compra");
  const r2 = await registrarEnSupabase(ref, pedidoWompi, { id: "tx-1", status: "APPROVED" }, { db });
  assert.equal(r2.motivo, "ya-existia");
  assert.equal(SB.db.pedidos.length, 1); assert.equal(SB.db.pedidos_items.length, 1); assert.equal(SB.db.suscriptores.length, 1);
});

await prueba("pedido con Supabase caído o sin configurar: {ok:false} sin lanzar (el webhook usa su respaldo)", async () => {
  assert.equal((await registrarEnSupabase("FV-1795000000101-SINCF", pedidoWompi, null, { db: null })).motivo, "sin-configurar");
  SB.modo = "caido";
  const r = await silencio(() => registrarEnSupabase("FV-1795000000102-CAIDO", pedidoWompi, null, { db }));
  assert.equal(r.ok, false); assert.equal(r.motivo, "insert-pedido-fallo");
});

const datosWa = (extra = {}) => ({
  ref: "FV-1795000000200-WHATS", fullName: "Beto", email: "beto@example.com", phone: "3001112233", paymentMethod: "whatsapp",
  deliveryMethod: "bucaramanga", total: 5, subtotal: 5, discountCode: "", discountAmount: 0,
  cart: [{ id: "lampara-caribe-brisa", sku: "LAM-002", qty: 1, name: "Lámpara Caribe Brisa", color: "Azul", price: 1 }], ...extra
});

await prueba("ventas-registrar (sitio nuevo, WhatsApp): montos del catálogo del servidor, estado PENDIENTE, sin tocar la hoja", async () => {
  const r = await procesarVenta(req({ action: "registrar", ref: "FV-1795000000200-WHATS", pedido: datosWa() }), { db, env: { BLACK_FRIDAY_DESDE: "2099-01-01T00:00:00-05:00" } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.registrado, true);
  const [p] = SB.db.pedidos;
  assert.equal(p.origen, "whatsapp"); assert.equal(p.estado_pago, "PENDIENTE"); assert.equal(p.metodo_pago, "whatsapp");
  assert.equal(p.total, 299000, "el precio falso del navegador (5) no llega a la base");
  assert.equal(SB.db.pedidos_items[0].precio_unitario, 299000);
  assert.equal(salidas.length, 0, "no se escribió en la hoja");
});

await prueba("ventas-registrar: Wompi no escribe (lo hace el webhook); markUsed ya no hace nada; datos malos -> 400", async () => {
  const w = await procesarVenta(req({ action: "registrar", ref: "FV-1795000000201-WOMPI", pedido: datosWa({ ref: "FV-1795000000201-WOMPI", paymentMethod: "pse" }) }), { db });
  assert.equal(w.status, 200); assert.equal(w.body.registrado, false);
  const m = await procesarVenta(req({ action: "markUsed", code: "FV15-ABC1234", ref: "FV-1795000000201-WOMPI" }), { db });
  assert.equal(m.status, 200);
  assert.equal((await procesarVenta(req({ action: "registrar", ref: "FV-1795000000202-MALOS", pedido: datosWa({ ref: "FV-1795000000202-MALOS", cart: [] }) }), { db })).status, 400);
  assert.equal((await procesarVenta(req({ action: "registrar", ref: "nada" }), { db })).status, 400);
  assert.equal((await procesarVenta(req({ action: "registrar", ref: "FV-1795000000201-WOMPI" }, { origen: "https://evil.example" }), { db })).status, 403);
  assert.equal(SB.db.pedidos.length, 0); assert.equal(salidas.length, 0);
});

await prueba("ventas-registrar con Supabase caído: el pedido de WhatsApp va a la hoja como respaldo", async () => {
  SB.modo = "caido";
  const r = await silencio(() => procesarVenta(req({ action: "registrar", ref: "FV-1795000000203-RESPA", pedido: datosWa({ ref: "FV-1795000000203-RESPA" }) }), { db }));
  assert.equal(r.status, 200); assert.equal(r.body.respaldo, "hoja");
  assert.ok(salidas.some((u) => u.startsWith("https://script.google.com/")));
});

await prueba("ventas-registrar (formato viejo del sitio actual): WhatsApp a Supabase + hoja como antes", async () => {
  const r = await procesarVenta(req({ ref: "FV-1795000000204-VIEJO", nombre: "Olga", email: "olga@example.com", telefono: "300", productos: "1× Florero Ondas (Gris)", cantidad: 1, precioUnit: 270000, subtotal: 270000, descuento: 0, envio: 40500, total: 310500, metodoPago: "WhatsApp", metodoEntrega: "Domicilio", ciudad: "Bogotá" }), { db });
  assert.equal(r.status, 200);
  const [p] = SB.db.pedidos;
  assert.equal(p.origen, "whatsapp"); assert.equal(p.total, 310500); assert.equal(p.payload_raw._importesSinVerificar, true);
  assert.equal(SB.db.pedidos_items[0].nombre, "Florero Ondas"); assert.equal(SB.db.pedidos_items[0].color, "Gris");
  assert.ok(salidas.some((u) => u.startsWith("https://script.google.com/")));
});

// ── Migración perezosa desde Netlify Blobs ("vip-codigos", formato de la versión anterior) ──
const sha = (e) => crypto.createHash("sha256").update(String(e).trim().toLowerCase()).digest("hex");
const blobsViejos = (regs, { falla = false, cuelga = false } = {}) => {
  const m = new Map();
  for (const r of regs) { m.set("codigo:" + r.codigo, JSON.stringify(r)); m.set("correo:" + sha(r.email), JSON.stringify({ codigo: r.codigo })); }
  return {
    m,
    async get(k) {
      if (falla) throw new Error("blobs caído (simulado)");
      if (cuelga) return new Promise(() => {});
      return m.has(k) ? JSON.parse(m.get(k)) : null;
    },
    async setJSON() { throw new Error("el legado NUNCA se escribe"); },
    async delete() { throw new Error("el legado NUNCA se borra"); }
  };
};
const VIEJO = { codigo: "FV20-VIEJOAB", email: "Vieja@Ejemplo.co ", nombre: "Vieja", origen: "vip", creado: "2026-11-19T21:30:00.000Z", usado: false };
const VIEJO_USADO = { codigo: "FV20-USADOAB", email: "gasto@ejemplo.co", nombre: "coleccionista", origen: "circulo", creado: "2026-11-19T21:40:00.000Z", usado: true, usadoRef: "FV-1795100000000-PAGOX", usadoEn: "2026-11-19T22:00:00.000Z" };

await prueba("legado: verificar un FV20 que solo está en Blobs -> válido, copiado a Supabase con fecha original; repetir no duplica", async () => {
  const legado = blobsViejos([VIEJO]);
  const ver = async () => (await procesarVip(req({ accion: "verificar", codigo: "fv20-viejoab" }), { db, env: ENV, legado })).body.estado;
  assert.equal(await ver(), "valido");
  const [c] = SB.db.codigos_descuento;
  assert.equal(c.codigo, "FV20-VIEJOAB"); assert.equal(c.email, "vieja@ejemplo.co"); assert.equal(c.creado_en, VIEJO.creado); assert.equal(c.usado, false); assert.equal(c.origen, "vip");
  const [s] = SB.db.suscriptores;
  assert.equal(s.email, "vieja@ejemplo.co"); assert.equal(s.origen, "vip"); assert.equal(s.creado_en, VIEJO.creado); assert.equal(s.nombre, "Vieja");
  assert.equal(await ver(), "valido");
  assert.equal(SB.db.codigos_descuento.length, 1); assert.equal(SB.db.suscriptores.length, 1);
});

await prueba("legado: un FV20 ya gastado en Blobs llega como 'usado' (con su referencia) y no da descuento", async () => {
  const legado = blobsViejos([VIEJO_USADO]);
  assert.equal((await estadoCodigo(db, "FV20-USADOAB", { legado })).estado, "usado");
  const c = SB.db.codigos_descuento[0];
  assert.equal(c.usado, true); assert.equal(c.referencia_pedido, "FV-1795100000000-PAGOX"); assert.equal(c.usado_en, VIEJO_USADO.usadoEn);
  assert.equal(SB.db.suscriptores[0].nombre, null, "'coleccionista' no se guarda como nombre");
  assert.equal(SB.db.suscriptores[0].origen, "circulo");
});

await prueba("legado: solicitar con un correo que ya tenía FV20 en Blobs devuelve ESE código (no crea otro)", async () => {
  const legado = blobsViejos([VIEJO]);
  const r = await procesarVip(req({ accion: "solicitar", origen: "vip", nombre: "Vieja", email: "VIEJA@ejemplo.co", web: "" }), { db, env: ENV, legado });
  assert.equal(r.status, 200); assert.equal(r.body.codigo, "FV20-VIEJOAB"); assert.equal(r.body.nuevo, false);
  assert.equal(SB.db.codigos_descuento.length, 1);
});

await prueba("legado: 'registrado' es sí para un correo que solo estaba en Blobs (y lo copia)", async () => {
  const legado = blobsViejos([VIEJO]);
  const r = await procesarVip(req({ accion: "registrado", email: "vieja@ejemplo.co" }), { db, env: ENV, legado });
  assert.deepEqual(r.body, { ok: true, registrado: true });
  assert.equal(SB.db.codigos_descuento[0].codigo, "FV20-VIEJOAB");
  assert.equal((await procesarVip(req({ accion: "registrado", email: "nadie@ejemplo.co" }), { db, env: ENV, legado })).body.registrado, false);
});

await prueba("legado: el webhook marca usado un FV20 que solo estaba en Blobs (pedido firmado por el servidor viejo)", async () => {
  const legado = blobsViejos([VIEJO]);
  const r = await marcarCodigoUsado(db, "FV20-VIEJOAB", "FV-1795100000001-APROB", { legado });
  assert.equal(r.ok, true); assert.equal(r.migrado, true);
  const c = SB.db.codigos_descuento[0];
  assert.equal(c.usado, true); assert.equal(c.referencia_pedido, "FV-1795100000001-APROB");
  const r2 = await marcarCodigoUsado(db, "FV20-VIEJOAB", "FV-1795100000002-OTRAX", { legado });
  assert.equal(r2.yaEstaba, true); assert.equal(r2.usadoRef, "FV-1795100000001-APROB");
});

await prueba("legado caído, colgado o inexistente: se ignora y todo sigue como sin legado", async () => {
  for (const legado of [blobsViejos([VIEJO], { falla: true }), blobsViejos([VIEJO], { cuelga: true }), null]) {
    limpiar();
    const t0 = Date.now();
    assert.equal((await estadoCodigo(db, "FV20-VIEJOAB", { legado })).estado, "invalido");
    assert.ok(Date.now() - t0 < 2500, "no se cuelga esperando Blobs");
    const r = await procesarVip(req({ accion: "solicitar", origen: "vip", nombre: "Vieja", email: "vieja@ejemplo.co", web: "" }), { db, env: ENV, legado });
    assert.equal(r.status, 200); assert.match(r.body.codigo, RE_FV20_T);
    assert.equal((await procesarVip(req({ accion: "registrado", email: "otro@ejemplo.co" }), { db, env: ENV, legado })).body.registrado, false);
  }
});

await prueba("legado seguro: si Supabase no deja guardar el código viejo -> 'sin-verificar' (sin descuento); índice cruzado se ignora", async () => {
  // El correo ya tiene OTRO FV20 en Supabase: el viejo choca con el índice único -> no se copia.
  SB.db.codigos_descuento.push({ codigo: "FV20-NUEVOZZ", tipo: "FV20", email: "vieja@ejemplo.co", usado: false });
  assert.equal((await estadoCodigo(db, "FV20-VIEJOAB", { legado: blobsViejos([VIEJO]) })).estado, "sin-verificar");
  assert.ok(!SB.db.codigos_descuento.some((c) => c.codigo === "FV20-VIEJOAB"));
  // Índice de correo que apunta al código de OTRA persona: no se entrega.
  limpiar();
  const legado = blobsViejos([VIEJO]);
  legado.m.set("correo:" + sha("intruso@ejemplo.co"), JSON.stringify({ codigo: "FV20-VIEJOAB" }));
  const r = await procesarVip(req({ accion: "solicitar", origen: "vip", nombre: "X", email: "intruso@ejemplo.co", web: "" }), { db, env: ENV, legado });
  assert.notEqual(r.body.codigo, "FV20-VIEJOAB");
  // Supabase caído durante la copia -> sin-verificar
  limpiar();
  SB.modo = "caido";
  assert.equal((await estadoCodigo(db, "FV20-VIEJOAB", { legado: blobsViejos([VIEJO]) })).estado, "sin-verificar");
});

await SB.cerrar();
console.log(`\n${ok} pruebas Supabase OK${process.exitCode ? " — HAY FALLAS" : ""}`);
