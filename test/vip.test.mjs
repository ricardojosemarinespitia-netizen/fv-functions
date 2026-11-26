// Pruebas SIN red del código VIP (FV20): node test/vip.test.mjs
// La base es un Supabase FALSO local (test/supabase-falso.mjs); todo lo demás
// que intente salir a la red se bloquea.
import assert from "node:assert/strict";
import { procesarVip } from "../netlify/functions/lib/vip-http.js";
import { estadoCodigo, marcarCodigoUsado, generarCodigoVip, generarCodigoCirculo, RE_FV20, RE_FV10 } from "../netlify/functions/lib/vip.js";
import { _reiniciarLimites } from "../netlify/functions/lib/correos.js";
import { iniciarSupabaseFalso } from "./supabase-falso.mjs";

const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("http://127.0.0.1:")) return fetchReal(url, init);
  throw new Error("RED BLOQUEADA en pruebas: " + url);
};
const SB = await iniciarSupabaseFalso();
const nuevaBase = () => { for (const k of Object.keys(SB.db)) SB.db[k].length = 0; SB.modo = "ok"; return SB.cfg; };
const codigosEnBase = () => SB.db.codigos_descuento.length + SB.db.suscriptores.length;
const O = "https://felipevergel.com";
const ENV = { RESEND_DRY_RUN: "1", EMAIL_FELIPE: "avisos@felipevergel.com", RESEND_FROM: "Felipe Vergel <pedidos@felipevergel.com>", BLACK_FRIDAY_DESDE: "2099-01-01T00:00:00-05:00" };
const req = (body, extra = {}) => ({ metodo: "POST", origen: O, ip: "1.1.1.1", cuerpo: JSON.stringify(body), ...extra });
const pedir = (email, extra = {}) => ({ accion: "solicitar", origen: "vip", nombre: "Ana", email, web: "", ...extra });

let ok = 0;
async function prueba(n, fn) { _reiniciarLimites(); try { await fn(); ok++; console.log("  ok  " + n); } catch (e) { console.error("  FALLA " + n + "\n", e); process.exitCode = 1; } }

await prueba("solicitar: crea FV20, lo devuelve, arma el correo (DRY_RUN) a cliente y a EMAIL_FELIPE", async () => {
  const db = nuevaBase();
  const r = await procesarVip(req(pedir("ana@example.com")), { db, env: ENV });
  assert.equal(r.status, 200);
  assert.match(r.body.codigo, RE_FV20);
  assert.equal(r.body.nuevo, true); assert.equal(r.body.correo, true); assert.equal(r.body.dryRun, true);
  const [felipe, cliente] = r.body.correos;
  assert.deepEqual(cliente.to, ["ana@example.com"]); assert.deepEqual(felipe.to, ["avisos@felipevergel.com"]);
  assert.equal(cliente.subject, "Tu código personal del 20 %");
  assert.ok(cliente.html.includes(r.body.codigo) && cliente.text.includes(r.body.codigo));
  assert.ok(cliente.html.includes("reemplaza el 15"));
  assert.equal(felipe.subject, "Nuevo código VIP · Ana");
  assert.equal(r.headers["Access-Control-Allow-Origin"], O);
});

await prueba("un código por correo: pedirlo otra vez (mayúsculas/espacios) devuelve el MISMO", async () => {
  const db = nuevaBase();
  const a = await procesarVip(req(pedir("ana@example.com")), { db, env: ENV });
  const b = await procesarVip(req(pedir("  ANA@Example.com ")), { db, env: ENV, ahora: Date.now() + 1 });
  assert.equal(b.status, 200); assert.equal(b.body.codigo, a.body.codigo); assert.equal(b.body.nuevo, false);
  const c = await procesarVip(req(pedir("otra@example.com")), { db, env: ENV });
  assert.notEqual(c.body.codigo, a.body.codigo);
});

await prueba("Círculo: origen circulo, nombre opcional -> 'coleccionista'; entrega FV10 (10 %), no FV20", async () => {
  const db = nuevaBase();
  const r = await procesarVip(req({ accion: "solicitar", origen: "circulo", email: "c@example.com", web: "" }), { db, env: ENV });
  assert.equal(r.status, 200);
  assert.match(r.body.codigo, RE_FV10); assert.equal(r.body.tipo, "FV10"); assert.equal(r.body.pct, 10);
  const [felipe, cliente] = r.body.correos;
  assert.equal(felipe.subject, "Nuevo código del Círculo (10 %) · coleccionista");
  assert.ok(felipe.html.includes("Ventana del C") && felipe.html.includes("10 %"));
  assert.equal(cliente.subject, "Tu código personal del 10 %");
  assert.ok(cliente.html.includes(r.body.codigo) && cliente.text.includes(r.body.codigo));
  assert.ok(cliente.html.includes("10&nbsp;%") && !cliente.html.includes("20&nbsp;%") && !cliente.text.includes("20 %"));
  assert.equal(SB.db.codigos_descuento.length, 1); assert.equal(SB.db.codigos_descuento[0].tipo, "FV10"); assert.equal(SB.db.codigos_descuento[0].origen, "circulo");
});

await prueba("Círculo: pedirlo otra vez devuelve el MISMO FV10; /vip sigue dando FV20 (20 %)", async () => {
  const db = nuevaBase();
  const a = await procesarVip(req({ accion: "solicitar", origen: "circulo", email: "d@example.com", web: "" }), { db, env: ENV });
  const b = await procesarVip(req({ accion: "solicitar", origen: "circulo", email: " D@Example.com", web: "" }), { db, env: ENV, ahora: Date.now() + 1 });
  assert.equal(b.body.codigo, a.body.codigo); assert.equal(b.body.nuevo, false); assert.equal(b.body.tipo, "FV10");
  const v = await procesarVip(req(pedir("ana2@example.com")), { db, env: ENV });
  assert.match(v.body.codigo, RE_FV20); assert.equal(v.body.tipo, "FV20"); assert.equal(v.body.pct, 20);
  assert.equal(v.body.correos[1].subject, "Tu código personal del 20 %");
});

await prueba("regla 1: quien ya tiene FV20 y se une al Círculo recibe SU FV20 (no se le baja, no se crea FV10)", async () => {
  const db = nuevaBase();
  const a = await procesarVip(req(pedir("vip1@example.com")), { db, env: ENV });
  const b = await procesarVip(req({ accion: "solicitar", origen: "circulo", email: "vip1@example.com", web: "" }), { db, env: ENV, ahora: Date.now() + 1 });
  assert.equal(b.body.codigo, a.body.codigo); assert.equal(b.body.tipo, "FV20"); assert.equal(b.body.pct, 20); assert.equal(b.body.nuevo, false);
  assert.equal(b.body.correos[1].subject, "Tu código personal del 20 %");
  assert.equal(SB.db.codigos_descuento.length, 1);
});

await prueba("regla 3: quien solo tiene FV10 y entra por /vip recibe un FV20 nuevo; los dos coexisten", async () => {
  const db = nuevaBase();
  const c = await procesarVip(req({ accion: "solicitar", origen: "circulo", email: "dos@example.com", web: "" }), { db, env: ENV });
  const v = await procesarVip(req(pedir("dos@example.com")), { db, env: ENV, ahora: Date.now() + 1 });
  assert.equal(c.body.tipo, "FV10"); assert.equal(v.body.tipo, "FV20"); assert.notEqual(v.body.codigo, c.body.codigo); assert.equal(v.body.nuevo, true);
  assert.deepEqual(SB.db.codigos_descuento.map((x) => x.tipo).sort(), ["FV10", "FV20"]);
  // y si vuelve al Círculo, recibe su FV20 (el mejor), no el FV10
  const c2 = await procesarVip(req({ accion: "solicitar", origen: "circulo", email: "dos@example.com", web: "" }), { db, env: ENV, ahora: Date.now() + 2 });
  assert.equal(c2.body.codigo, v.body.codigo);
});

await prueba("FV10: un solo FV10 por correo aunque lleguen dos solicitudes a la vez (índice único)", async () => {
  const db = nuevaBase();
  const q = () => procesarVip(req({ accion: "solicitar", origen: "circulo", email: "par@example.com", web: "" }), { db, env: ENV });
  const [x, y] = await Promise.all([q(), q()]);
  assert.equal(x.status, 200); assert.equal(y.status, 200); assert.equal(x.body.codigo, y.body.codigo);
  assert.equal(SB.db.codigos_descuento.filter((c) => c.tipo === "FV10").length, 1);
});

await prueba("verificar FV10: valido -> (pago aprobado) usado; no vence con VIP_HASTA; Círculo no se cierra con VIP_HASTA (/vip sí: 410)", async () => {
  const db = nuevaBase();
  const ENV_VENCIDO = { ...ENV, VIP_HASTA: "2020-01-01T00:00:00-05:00" };
  const c = await procesarVip(req({ accion: "solicitar", origen: "circulo", email: "ven@example.com", web: "" }), { db, env: ENV_VENCIDO });
  assert.equal(c.status, 200); assert.equal(c.body.tipo, "FV10");
  assert.ok(!c.body.correos[1].html.includes("Vale hasta"), "el FV10 no menciona vencimiento");
  const v = await procesarVip(req(pedir("ven2@example.com")), { db, env: ENV_VENCIDO });
  assert.equal(v.status, 410);
  const ver = async (cod) => (await procesarVip(req({ accion: "verificar", codigo: cod }), { db, env: ENV_VENCIDO })).body.estado;
  assert.equal(await ver(c.body.codigo), "valido");
  assert.equal((await marcarCodigoUsado(db, c.body.codigo, "FV-1795000000000-ABCDE")).ok, true);
  assert.equal(await ver(c.body.codigo), "usado");
  assert.equal(await ver("FV10-NOEXIST"), "invalido");
});

await prueba("rechaza: honeypot lleno, sin nombre (/vip), correo malo, enlaces, campos extra, origen ajeno", async () => {
  const db = nuevaBase();
  const casos = [
    [pedir("a@example.com", { web: "http://spam" }), 400],
    [pedir("a@example.com", { nombre: "" }), 400],
    [pedir("no-es-correo"), 400],
    [pedir("a@b.co,c@d.co"), 400],
    [pedir("a@example.com", { nombre: "Gana en www.x.com" }), 400],
    [pedir("a@example.com", { to: "victima@x.com" }), 400],
    [pedir("a@example.com", { origen: "admin" }), 400],
    [{ accion: "borrar" }, 400]
  ];
  for (const [b, st] of casos) assert.equal((await procesarVip(req(b), { db, env: ENV })).status, st, JSON.stringify(b));
  assert.equal((await procesarVip(req(pedir("a@example.com"), { origen: "https://evil.example" }), { db, env: ENV })).status, 403);
  assert.equal((await procesarVip({ metodo: "GET", origen: O, ip: "1", cuerpo: "" }, { db, env: ENV })).status, 405);
  assert.equal(codigosEnBase(), 0, "no debía crear nada");
});

await prueba("límite: 3 por correo y 8 por IP en una hora -> 429", async () => {
  const db = nuevaBase();
  const st = [];
  for (let i = 0; i < 4; i++) st.push((await procesarVip(req(pedir("x@example.com"), { ip: "9.9.9." + i }), { db, env: ENV, ahora: 1000 })).status);
  assert.deepEqual(st, [200, 200, 200, 429]);
  _reiniciarLimites();
  const st2 = [];
  for (let i = 0; i < 9; i++) st2.push((await procesarVip(req(pedir(`p${i}@example.com`)), { db, env: ENV, ahora: 5000 })).status);
  assert.equal(st2.filter((s) => s === 200).length, 8); assert.equal(st2[8], 429);
});

await prueba("VIP_HASTA: vacío = no vence; con fecha pasada -> solicitar 410 y verificar 'vencido'", async () => {
  const db = nuevaBase();
  const r = await procesarVip(req(pedir("v@example.com")), { db, env: ENV });
  const cod = r.body.codigo;
  assert.equal((await estadoCodigo(db, cod, { env: {}, ahora: Date.parse("2027-06-01") })).estado, "valido", "sin VIP_HASTA no vence");
  const envV = { ...ENV, VIP_HASTA: "2026-11-27T01:00:00-05:00" };
  assert.equal((await procesarVip(req(pedir("w@example.com")), { db, env: envV, ahora: Date.parse("2026-11-27T01:00:00-05:00") })).status, 410);
  const v = await procesarVip(req({ accion: "verificar", codigo: cod }), { db, env: envV, ahora: Date.parse("2026-11-27T01:00:00-05:00") });
  assert.equal(v.body.estado, "vencido");
});

await prueba("verificar: valido -> (pago aprobado) usado; inválido; minúsculas; nunca crea", async () => {
  const db = nuevaBase();
  const cod = (await procesarVip(req(pedir("u@example.com")), { db, env: ENV })).body.codigo;
  const ver = async (c) => (await procesarVip(req({ accion: "verificar", codigo: c }), { db, env: ENV })).body.estado;
  assert.equal(await ver(cod), "valido");
  assert.equal(await ver(cod.toLowerCase()), "valido");
  assert.equal(await ver("FV20-ZZZZZZZ"), "invalido");
  assert.equal(await ver("HOLA"), "invalido");
  const antes = codigosEnBase();
  await marcarCodigoUsado(db, cod, "FV-1795000000000-ABCDE");
  assert.equal(await ver(cod), "usado");
  const otra = await marcarCodigoUsado(db, cod, "FV-1795000000001-ZZZZZ");
  assert.equal(otra.yaEstaba, true); assert.equal(otra.usadoRef, "FV-1795000000000-ABCDE", "no se pisa la referencia");
  assert.equal(codigosEnBase(), antes);
});

await prueba("sin RESEND_API_KEY ni DRY_RUN: el código igual se crea y se muestra (correo:false)", async () => {
  const db = nuevaBase();
  const errores = []; const o = console.error; console.error = (...a) => errores.push(a.join(" "));
  try {
    const r = await procesarVip(req(pedir("s@example.com")), { db, env: {} });
    assert.equal(r.status, 200); assert.match(r.body.codigo, RE_FV20); assert.equal(r.body.correo, false);
  } finally { console.error = o; }
});

await prueba("generador: formato FV20 y FV10, alfabeto sin 0/O/1/I/L", async () => {
  for (let i = 0; i < 300; i++) { const c = generarCodigoVip(); assert.match(c, RE_FV20); assert.ok(!/[01OIL]/.test(c.slice(5))); }
  for (let i = 0; i < 300; i++) { const c = generarCodigoCirculo(); assert.match(c, RE_FV10); assert.ok(!/[01OIL]/.test(c.slice(5))); }
});

// ── Black Friday: el Círculo entrega 20 % ───────────────────
const DESDE = "2026-11-27T01:00:00-05:00";
const ENV_BF = { ...ENV, BLACK_FRIDAY_DESDE: DESDE };
const EN_BF = Date.parse(DESDE) + 3600e3, ANTES = Date.parse(DESDE) - 3600e3;
const circ = (email) => req({ accion: "solicitar", origen: "circulo", nombre: "Bea", email, web: "" });

await prueba("BF: Círculo entrega FV20 de campaña (20 %), correo lo explica, repetir devuelve el mismo", async () => {
  const db = nuevaBase();
  const r = await procesarVip(circ("bf@example.com"), { db, env: ENV_BF, ahora: EN_BF });
  assert.match(r.body.codigo, RE_FV20); assert.equal(r.body.pct, 20); assert.equal(r.body.soloBF, true);
  const [felipe, cliente] = r.body.correos;
  assert.ok(felipe.subject.startsWith("Nuevo código Black Friday del Círculo (20 %)"));
  assert.ok(cliente.text.includes("mientras dure Black Friday") && cliente.text.includes("no se acumulan"));
  const b = await procesarVip(circ("bf@example.com"), { db, env: ENV_BF, ahora: EN_BF + 1000 });
  assert.equal(b.body.codigo, r.body.codigo); assert.equal(SB.db.codigos_descuento.length, 1);
});

await prueba("BF: quien tenía FV10 recibe además su FV20; al terminar BF vence y el Círculo vuelve al FV10", async () => {
  const db = nuevaBase();
  const antes = await procesarVip(circ("v@example.com"), { db, env: ENV_BF, ahora: ANTES });
  assert.match(antes.body.codigo, RE_FV10);
  const en = await procesarVip(circ("v@example.com"), { db, env: ENV_BF, ahora: EN_BF });
  assert.match(en.body.codigo, RE_FV20);
  const fin = { ...ENV_BF, BLACK_FRIDAY_HASTA: "2026-12-01T00:00:00-05:00" };
  const despues = Date.parse("2026-12-02T00:00:00-05:00");
  assert.equal((await estadoCodigo(db, en.body.codigo, { env: ENV_BF, ahora: EN_BF })).estado, "valido");
  assert.equal((await estadoCodigo(db, en.body.codigo, { env: fin, ahora: despues })).estado, "vencido");
  const otra = await procesarVip(circ("v@example.com"), { db, env: fin, ahora: despues });
  assert.equal(otra.body.codigo, antes.body.codigo); assert.equal(otra.body.pct, 10);
});

await prueba("BF: /vip convierte el FV20 de campaña en normal (sigue válido después)", async () => {
  const db = nuevaBase();
  const en = await procesarVip(circ("p@example.com"), { db, env: ENV_BF, ahora: EN_BF });
  const v = await procesarVip(req(pedir("p@example.com")), { db, env: ENV_BF, ahora: EN_BF + 1000 });
  assert.equal(v.body.codigo, en.body.codigo); assert.equal(v.body.soloBF, false);
  const fin = { ...ENV_BF, BLACK_FRIDAY_HASTA: "2026-12-01T00:00:00-05:00" };
  assert.equal((await estadoCodigo(db, en.body.codigo, { env: fin, ahora: Date.parse("2026-12-02T00:00:00-05:00") })).estado, "valido");
});

await prueba("BF: un FV20 de Círculo anterior a la campaña no se toca (vale antes, durante y después)", async () => {
  const db = nuevaBase();
  SB.db.codigos_descuento.push({ codigo: "FV20-ABCDEFG", tipo: "FV20", email: "h@example.com", origen: "circulo", usado: false, creado_en: "2026-10-01T00:00:00Z" });
  const fin = { ...ENV_BF, BLACK_FRIDAY_HASTA: "2026-12-01T00:00:00-05:00" };
  for (const [env, ahora] of [[ENV_BF, ANTES], [ENV_BF, EN_BF], [fin, Date.parse("2026-12-02T00:00:00-05:00")]]) {
    assert.equal((await estadoCodigo(db, "FV20-ABCDEFG", { env, ahora })).estado, "valido");
    assert.equal((await procesarVip(circ("h@example.com"), { db, env, ahora })).body.codigo, "FV20-ABCDEFG");
  }
});

await SB.cerrar();
console.log(`\n${ok} pruebas VIP OK${process.exitCode ? " — HAY FALLAS" : ""}`);
