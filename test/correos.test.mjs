// Prueba SIN red: `fetch` simulado (y bloqueado). Ejecutar:  node test/correos.test.mjs
import assert from "node:assert/strict";
import {
  procesarSolicitud, enviarCorreos, limpiarPedido, _reiniciarLimites, codigoClub,
  EMAIL_FELIPE_DEFECTO, FROM_DEFECTO, MAX_BODY, LIMITES, fmt
} from "../netlify/functions/lib/correos.js";

// Ninguna prueba puede salir a internet: si algo llama al fetch global, falla.
globalThis.fetch = async (url) => { throw new Error("RED BLOQUEADA en pruebas: " + url); };

const CLAVE_FALSA = "re_clave_de_prueba_no_real";
// Black Friday YA iniciado (inicio simulado en el pasado). ENV_PRE = antes del lanzamiento.
const YA = "2026-01-01T00:00:00-05:00";
const ENV = { RESEND_API_KEY: CLAVE_FALSA, BLACK_FRIDAY_DESDE: YA };
const ENV_SIN_BF = { ...ENV, BLACK_FRIDAY_ACTIVO: "false" };
const ENV_PRE = { RESEND_API_KEY: CLAVE_FALSA, BLACK_FRIDAY_DESDE: "2099-01-01T00:00:00-05:00" };
const ENV_DRY = { RESEND_DRY_RUN: "1", RESEND_FROM: "Felipe Vergel <pedidos@felipevergel.com>", EMAIL_FELIPE: "avisos@felipevergel.com", BLACK_FRIDAY_DESDE: YA };
const ORIGEN = "https://felipevergel.com";
const REF = "FV-1788187888658-JG258";

let pasaron = 0;
async function prueba(nombre, fn) {
  _reiniciarLimites();
  try { await fn(); pasaron++; console.log("  ok  " + nombre); }
  catch (e) { console.error("  FALLA " + nombre + "\n", e); process.exitCode = 1; }
}

/** fetch simulado: guarda las llamadas y responde según `responder`. */
function mockFetch(responder = () => ({ status: 200, json: { id: "id_falso" } })) {
  const llamadas = [];
  const fn = async (url, init) => {
    const cuerpo = JSON.parse(init.body);
    llamadas.push({ url, headers: init.headers, cuerpo });
    const r = responder(cuerpo, llamadas.length);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json || {}, text: async () => JSON.stringify(r.json || {}) };
  };
  fn.llamadas = llamadas;
  return fn;
}
const sinRed = Object.assign(async () => { throw new Error("no debía llamar a Resend"); }, { llamadas: [] });

// Lámpara Caribe Brisa: lista 299.000 -> Black Friday 15 % = 254.150 c/u.
const pedidoBase = () => ({
  ref: REF,
  fullName: "Ana Pérez",
  email: "ana@example.com",
  phone: "3001234567",
  docId: "1098765432",
  address: "Calle 10 # 5-20 apto 301",
  city: "Floridablanca",
  department: "Santander",
  zipCode: "681004",
  notes: "Entregar en portería",
  deliveryMethod: "bucaramanga",
  paymentMethod: "pse",
  discountCode: null,
  discountAmount: 0,
  subtotal: 508300,
  shipping: 0,
  total: 508300,
  subtotalLista: 598000,
  descuentoBF: 89700,
  bfPct: 15,
  cart: [{ id: "lampara-caribe-brisa", qty: 2, sku: "LAM-002", name: "Lámpara Caribe Brisa", color: "Ámbar", price: 254150, precioLista: 299000 }]
});

const solicitud = (cuerpoObj, extra = {}) => ({
  metodo: "POST", origen: ORIGEN, ip: "1.2.3.4",
  cuerpo: typeof cuerpoObj === "string" ? cuerpoObj : JSON.stringify(cuerpoObj), ...extra
});
const club = (email, extra = {}) => ({ nombre: "Laura", email, codigo: codigoClub(email), ...extra });

console.log("Pedido");

await prueba("pedido válido: 2 correos a Resend con cuerpo, asunto, destinatarios y cabeceras correctos", async () => {
  const f = mockFetch();
  const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase() }), { env: ENV, fetchFn: f });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, cliente: true, felipe: true });
  assert.equal(f.llamadas.length, 2);
  for (const l of f.llamadas) {
    assert.equal(l.url, "https://api.resend.com/emails");
    assert.equal(l.headers.Authorization, "Bearer " + CLAVE_FALSA);
    assert.equal(l.cuerpo.from, FROM_DEFECTO);
    assert.equal(l.cuerpo.to.length, 1);
    assert.ok(l.cuerpo.html.includes("https://felipevergel.com/img/logo/logo_blanco.png"));
    assert.ok(l.cuerpo.text.length > 50);
  }
  const felipe = f.llamadas.find((l) => l.cuerpo.to[0] === EMAIL_FELIPE_DEFECTO);
  const cliente = f.llamadas.find((l) => l.cuerpo.to[0] === "ana@example.com");
  assert.ok(felipe && cliente);
  assert.equal(felipe.cuerpo.subject, `Nuevo pedido · ${REF} · $508.300`);
  assert.equal(felipe.cuerpo.reply_to, "ana@example.com");
  assert.equal(cliente.cuerpo.subject, `Tu pedido está confirmado · ${REF}`);
  assert.equal(cliente.cuerpo.reply_to, EMAIL_FELIPE_DEFECTO);
  assert.equal(felipe.headers["Idempotency-Key"], `pedido-${REF}-felipe`);
  assert.equal(cliente.headers["Idempotency-Key"], `pedido-${REF}-cliente`);
  assert.ok(cliente.cuerpo.html.includes("$508.300") && cliente.cuerpo.html.includes("Lámpara Caribe Brisa"));
  // Black Friday visible en los dos correos
  assert.ok(cliente.cuerpo.html.includes("Black Friday 15") && cliente.cuerpo.html.includes("$598.000") && cliente.cuerpo.html.includes("-$89.700"));
  assert.ok(felipe.cuerpo.html.includes("ahorro $89.700"));
  assert.ok(!felipe.cuerpo.html.includes("En la pantalla del cliente"), "sin aviso si el total coincide");
  assert.ok(felipe.cuerpo.html.includes("1098765432") && felipe.cuerpo.html.includes("Santander") && felipe.cuerpo.html.includes("PSE / Wompi"));
  // la clave jamás aparece en lo que se devuelve al navegador
  assert.ok(!JSON.stringify(r).includes(CLAVE_FALSA));
});

await prueba("pedido por WhatsApp: asuntos y texto propios", async () => {
  const f = mockFetch();
  const d = { ...pedidoBase(), paymentMethod: "whatsapp" };
  await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV, fetchFn: f });
  const asuntos = f.llamadas.map((l) => l.cuerpo.subject).sort();
  assert.deepEqual(asuntos, [`Pedido por WhatsApp · ${REF} · $508.300`, `Recibimos tu pedido · ${REF}`]);
});

await prueba("precios y piezas los pone el SERVIDOR: precio/nombre falsos del navegador no llegan al correo", async () => {
  const f = mockFetch();
  const d = pedidoBase();
  d.cart[0].price = 1; d.cart[0].name = "Oferta gratis"; d.total = 2; d.subtotal = 2;
  const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV, fetchFn: f });
  assert.equal(r.status, 200);
  for (const l of f.llamadas) {
    assert.ok(!l.cuerpo.html.includes("Oferta gratis"));
    assert.ok(l.cuerpo.html.includes("Lámpara Caribe Brisa") && l.cuerpo.html.includes("$508.300"));
  }
  const felipe = f.llamadas.find((l) => l.cuerpo.to[0] === EMAIL_FELIPE_DEFECTO);
  assert.ok(felipe.cuerpo.html.includes("En la pantalla del cliente el total era $2"), "Felipe ve el aviso de diferencia");
});

await prueba("pieza buscada por SKU si no llega id; pieza desconocida -> 400 sin enviar nada", async () => {
  const f = mockFetch();
  const d = pedidoBase(); delete d.cart[0].id;
  assert.equal((await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV, fetchFn: f })).status, 200);
  _reiniciarLimites();
  const f2 = mockFetch();
  const d2 = pedidoBase(); d2.cart[0].id = "pieza-inventada"; d2.cart[0].sku = "XXX-999";
  const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: d2 }), { env: ENV, fetchFn: f2 });
  assert.equal(r.status, 400); assert.equal(r.body.error, "pieza-desconocida");
  assert.equal(f2.llamadas.length, 0);
});

await prueba("sin Black Friday: precio de lista y el código FV15 resta 15 %", async () => {
  const f = mockFetch();
  const d = pedidoBase(); d.discountCode = "FV15-ABCD123";
  await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV_SIN_BF, fetchFn: f });
  const cliente = f.llamadas.find((l) => l.cuerpo.to[0] === "ana@example.com");
  // 598.000 - 89.700 (15 %) = 508.300; bucaramanga sin envío
  assert.ok(cliente.cuerpo.html.includes("FV15-ABCD123") && cliente.cuerpo.html.includes("-$89.700") && cliente.cuerpo.html.includes("$508.300"));
  assert.ok(!cliente.cuerpo.html.includes("Black Friday"));
});

await prueba("con Black Friday el código no se suma (no aparece como aplicado)", async () => {
  const f = mockFetch();
  const d = pedidoBase(); d.discountCode = "FV15-ABCD123";
  await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV, fetchFn: f });
  const cliente = f.llamadas.find((l) => l.cuerpo.to[0] === "ana@example.com");
  assert.ok(!cliente.cuerpo.html.includes("FV15-ABCD123"));
  assert.ok(cliente.cuerpo.html.includes("$508.300"));
});

await prueba("FV10 (Círculo) en pedido por WhatsApp: solo si Supabase lo da por válido; sin BF resta 10 %; con BF no suma", async () => {
  const d = () => { const x = pedidoBase(); x.discountCode = "FV10-ABCD234"; return x; };
  const cli = (f) => f.llamadas.find((l) => l.cuerpo.to[0] === "ana@example.com");
  // válido y sin Black Friday: 598.000 - 59.800 (10 %) = 538.200
  let f = mockFetch();
  _reiniciarLimites(); await procesarSolicitud(solicitud({ tipo: "pedido", datos: d() }), { env: ENV_SIN_BF, fetchFn: f, verificarVip: async () => "valido" });
  assert.ok(cli(f).cuerpo.html.includes("FV10-ABCD234") && cli(f).cuerpo.html.includes("-$59.800") && cli(f).cuerpo.html.includes("$538.200"));
  // usado / no verificable: sin descuento (lista completa)
  for (const est of ["usado", "sin-verificar", "invalido"]) {
    f = mockFetch();
    _reiniciarLimites(); await procesarSolicitud(solicitud({ tipo: "pedido", datos: d() }), { env: ENV_SIN_BF, fetchFn: f, verificarVip: async () => est });
    assert.ok(!cli(f).cuerpo.html.includes("FV10-ABCD234") && cli(f).cuerpo.html.includes("$598.000"), "estado " + est);
  }
  // sin verificador: no se aplica
  f = mockFetch();
  _reiniciarLimites(); await procesarSolicitud(solicitud({ tipo: "pedido", datos: d() }), { env: ENV_SIN_BF, fetchFn: f });
  assert.ok(!cli(f).cuerpo.html.includes("FV10-ABCD234"));
  // con Black Friday: 15 % público ($508.300), el FV10 no aparece ni suma
  f = mockFetch();
  _reiniciarLimites(); await procesarSolicitud(solicitud({ tipo: "pedido", datos: d() }), { env: ENV, fetchFn: f, verificarVip: async () => "valido" });
  assert.ok(!cli(f).cuerpo.html.includes("FV10-ABCD234") && cli(f).cuerpo.html.includes("$508.300"));
});

await prueba("pedido guardado por wompi-sign: montos del registro del servidor y correo debe coincidir", async () => {
  const guardado = { ...pedidoBase(), total: 499999, subtotal: 499999, _serverPriced: true };
  const f = mockFetch();
  const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase() }), { env: ENV, fetchFn: f, buscarPedido: async () => guardado });
  assert.equal(r.status, 200);
  assert.ok(f.llamadas.every((l) => l.cuerpo.html.includes("$499.999")));
  _reiniciarLimites();
  const f2 = mockFetch();
  const ajeno = await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase() }), { env: ENV, fetchFn: f2, buscarPedido: async () => ({ ...guardado, email: "otra@example.com" }) });
  assert.equal(ajeno.status, 403); assert.equal(ajeno.body.error, "pedido-no-coincide");
  assert.equal(f2.llamadas.length, 0);
});

await prueba("escapa HTML en nombre, notas, dirección y color (sin XSS ni etiquetas inyectadas)", async () => {
  const f = mockFetch();
  const mal = "<script>alert(1)</script>";
  const d = pedidoBase();
  d.fullName = mal; d.notes = '"><img src=x onerror=alert(2)>'; d.address = "<b>x</b>"; d.cart[0].color = "<i>c</i>";
  const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV, fetchFn: f });
  assert.equal(r.status, 200);
  for (const l of f.llamadas) {
    const h = l.cuerpo.html;
    assert.ok(!h.includes("<script>alert"), "script sin escapar");
    assert.ok(!h.includes("<img src=x"), "img sin escapar");
    assert.ok(!h.includes("<b>x</b>") && !h.includes("<i>c</i>"));
    assert.ok(h.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  }
});

await prueba("rechaza enlaces en nombre, notas, dirección y color (anti-spam)", async () => {
  const f = mockFetch();
  for (const m of [{ fullName: "Gana ya www.premio.com" }, { notes: "visita https://x.ru" }, { address: "bit.ly/abc" }]) {
    const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: { ...pedidoBase(), ...m } }), { env: ENV, fetchFn: f });
    assert.equal(r.status, 400, JSON.stringify(m));
  }
  const d = pedidoBase(); d.cart[0].color = "http://spam.co";
  assert.equal((await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV, fetchFn: f })).status, 400);
  assert.equal(f.llamadas.length, 0);
});

await prueba("rechaza tipo no permitido, JSON roto y campos extra en el nivel superior", async () => {
  const f = mockFetch();
  assert.equal((await procesarSolicitud(solicitud({ tipo: "spam", datos: pedidoBase() }), { env: ENV, fetchFn: f })).body.error, "tipo-no-permitido");
  assert.equal((await procesarSolicitud(solicitud("{no es json"), { env: ENV, fetchFn: f })).status, 400);
  assert.equal((await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase(), to: "otro@x.com" }), { env: ENV, fetchFn: f })).body.error, "campos-no-permitidos");
  assert.equal(f.llamadas.length, 0);
});

await prueba("destinatario arbitrario: 'to', 'cc', 'bcc', 'reply_to', 'emailFelipe', 'html', 'subject' -> 400", async () => {
  const f = mockFetch();
  for (const extra of [{ to: "victima@x.com" }, { cc: "a@b.co" }, { bcc: "a@b.co" }, { reply_to: "a@b.co" }, { emailFelipe: "a@b.co" }, { EMAIL_FELIPE: "a@b.co" }, { html: "<b>x</b>" }, { subject: "gratis" }]) {
    const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: { ...pedidoBase(), ...extra } }), { env: ENV, fetchFn: f });
    assert.equal(r.status, 400); assert.equal(r.body.error, "datos-invalidos");
    const rc = await procesarSolicitud(solicitud({ tipo: "club", datos: { ...club("z@example.com"), ...extra } }), { env: ENV, fetchFn: f });
    assert.equal(rc.status, 400);
  }
  const d = pedidoBase(); d.cart[0].to = "x@y.co";
  assert.equal((await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV, fetchFn: f })).status, 400);
  assert.equal(f.llamadas.length, 0);
});

await prueba("el aviso de Felipe SIEMPRE va a EMAIL_FELIPE, aunque el formulario traiga otro correo", async () => {
  const f = mockFetch();
  const env = { ...ENV, EMAIL_FELIPE: "taller@felipevergel.com" };
  await procesarSolicitud(solicitud({ tipo: "pedido", datos: { ...pedidoBase(), email: "victima@example.com" } }), { env, fetchFn: f });
  const destinos = f.llamadas.map((l) => l.cuerpo.to[0]).sort();
  assert.deepEqual(destinos, ["taller@felipevergel.com", "victima@example.com"]);
});

await prueba("rechaza correos múltiples/inválidos, ref mala, carrito vacío o absurdo, código malo", async () => {
  const f = mockFetch();
  const malos = [
    { email: "a@b.co,otro@c.co" }, { email: "a@b.co otro@c.co" }, { email: "a@b.co\nBcc: x@y.co" }, { email: "sin-arroba" }, { email: 5 },
    { email: ["a@b.co", "c@d.co"] },
    { ref: "FV-1-x" }, { ref: "../../etc" }, { fullName: "" }, { cart: [] }, { cart: "x" },
    { discountCode: "HACK" }, { total: -5 }, { total: "1000" }, { fullName: "x".repeat(400) },
    { paymentMethod: "bitcoin" }, { deliveryMethod: "luna" }
  ];
  for (const m of malos) {
    const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: { ...pedidoBase(), ...m } }), { env: ENV, fetchFn: f });
    assert.equal(r.status, 400, "debía rechazar " + JSON.stringify(m).slice(0, 60));
  }
  const d = pedidoBase(); d.cart[0].qty = 0;
  assert.equal((await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV, fetchFn: f })).status, 400);
  const d1 = pedidoBase(); d1.cart[0].qty = 21;
  assert.equal((await procesarSolicitud(solicitud({ tipo: "pedido", datos: d1 }), { env: ENV, fetchFn: f })).status, 400);
  const d2 = pedidoBase(); d2.cart = Array.from({ length: 31 }, () => ({ ...pedidoBase().cart[0] }));
  assert.equal((await procesarSolicitud(solicitud({ tipo: "pedido", datos: d2 }), { env: ENV, fetchFn: f })).status, 400);
  assert.equal(f.llamadas.length, 0);
});

await prueba("cuerpo demasiado grande -> 413", async () => {
  const f = mockFetch();
  const d = pedidoBase(); d.notes = "n".repeat(MAX_BODY);
  const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV, fetchFn: f });
  assert.equal(r.status, 413);
  assert.equal(f.llamadas.length, 0);
});

await prueba("CORS exacto: solo felipevergel.com y www; otros orígenes sin Allow-Origin y 403", async () => {
  const f = mockFetch();
  const ok = await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase() }), { env: ENV, fetchFn: f });
  assert.equal(ok.headers["Access-Control-Allow-Origin"], ORIGEN);
  _reiniciarLimites();
  const www = await procesarSolicitud(solicitud({ tipo: "club", datos: club("w@example.com") }, { origen: "https://www.felipevergel.com" }), { env: ENV, fetchFn: f });
  assert.equal(www.status, 200);
  assert.equal(www.headers["Access-Control-Allow-Origin"], "https://www.felipevergel.com");
  const antes = f.llamadas.length;
  for (const o of ["https://evil.example", "", "https://felipevergel.com.evil.io", "http://felipevergel.com", "http://localhost:8888", "null"]) {
    const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase() }, { origen: o }), { env: ENV, fetchFn: f });
    assert.equal(r.status, 403, "origen " + o);
    assert.equal(r.headers["Access-Control-Allow-Origin"], undefined);
    const pre = await procesarSolicitud({ metodo: "OPTIONS", origen: o, ip: "1.1.1.1", cuerpo: "" }, { env: ENV, fetchFn: f });
    assert.equal(pre.status, 403);
  }
  assert.equal(f.llamadas.length, antes);
  assert.equal((await procesarSolicitud({ metodo: "GET", origen: ORIGEN, ip: "1.1.1.1", cuerpo: "" }, { env: ENV, fetchFn: f })).status, 405);
  assert.equal((await procesarSolicitud({ metodo: "OPTIONS", origen: ORIGEN, ip: "1.1.1.1", cuerpo: "" }, { env: ENV, fetchFn: f })).status, 204);
  const sinClave = await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase() }), { env: {}, fetchFn: f });
  assert.equal(sinClave.status, 503);
});

await prueba("límite de abuso por destinatario: del 5.º intento en una hora -> 429", async () => {
  const f = mockFetch();
  const estados = [];
  for (let i = 0; i < 6; i++) {
    const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase() }, { ip: "10.0.0." + i }), { env: ENV, fetchFn: f, ahora: 1_000_000 + i });
    estados.push(r.status);
  }
  assert.deepEqual(estados, [200, 200, 200, 200, 429, 429]);
  assert.equal(f.llamadas.length, 8);
});

await prueba("límite de abuso por IP: >12 pedidos/hora desde la misma IP -> 429, y se libera pasada la ventana", async () => {
  const f = mockFetch();
  const estados = [];
  for (let i = 0; i < 14; i++) {
    const d = pedidoBase(); d.email = `cliente${i}@example.com`;
    estados.push((await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV, fetchFn: f, ahora: 5_000_000 })).status);
  }
  assert.equal(estados.filter((s) => s === 200).length, 12);
  assert.deepEqual(estados.slice(12), [429, 429]);
  const d = pedidoBase(); d.email = "nuevo@example.com";
  const tarde = await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV, fetchFn: f, ahora: 5_000_000 + 61 * 60 * 1000 });
  assert.equal(tarde.status, 200);
});

await prueba("límite global: muchas IP y muchos destinatarios -> se corta al pasar el techo por hora", async () => {
  const estados = [];
  for (let i = 0; i < LIMITES.club.global + 2; i++) {
    const email = `persona${i}@example.com`;
    estados.push((await procesarSolicitud(solicitud({ tipo: "club", datos: club(email) }, { ip: "172.16." + (i >> 8) + "." + (i & 255) }), { env: ENV_DRY, fetchFn: sinRed, ahora: 9_000_000 })).status);
  }
  assert.equal(estados.filter((s) => s === 200).length, LIMITES.club.global);
  assert.deepEqual(estados.slice(-2), [429, 429]);
});

await prueba("límite compartido vía almacén inyectado (Blobs) y si el almacén falla se abre el paso", async () => {
  const mem = new Map();
  const store = { get: async (k) => mem.get(k) ?? null, setJSON: async (k, v) => { mem.set(k, v); } };
  const f = mockFetch();
  const s1 = await procesarSolicitud(solicitud({ tipo: "club", datos: club("a@example.com") }), { env: ENV, fetchFn: f, store, ahora: 1 });
  assert.equal(s1.status, 200);
  assert.ok([...mem.keys()].some((k) => k.startsWith("rl-")));
  _reiniciarLimites(); // otra instancia de la función: la memoria local está vacía, el almacén no
  await procesarSolicitud(solicitud({ tipo: "club", datos: club("a@example.com") }), { env: ENV, fetchFn: f, store, ahora: 2 });
  _reiniciarLimites();
  const s3 = await procesarSolicitud(solicitud({ tipo: "club", datos: club("a@example.com") }), { env: ENV, fetchFn: f, store, ahora: 3 });
  assert.equal(s3.status, 429);
  _reiniciarLimites();
  const roto = { get: async () => { throw new Error("blobs caído"); }, setJSON: async () => { throw new Error("blobs caído"); } };
  const s4 = await procesarSolicitud(solicitud({ tipo: "club", datos: club("b@example.com") }), { env: ENV, fetchFn: f, store: roto, ahora: 4 });
  assert.equal(s4.status, 200);
});

await prueba("fallos de Resend: cliente falla -> 502; solo Felipe falla -> 200 con felipe:false; 409 idempotente = ok", async () => {
  const errores = [];
  const origError = console.error; console.error = (...a) => errores.push(a.join(" "));
  try {
    let f = mockFetch((c) => (c.to[0] === "ana@example.com" ? { status: 500, json: { message: "boom" } } : { status: 200, json: { id: "x" } }));
    let r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase() }), { env: ENV, fetchFn: f });
    assert.equal(r.status, 502); assert.deepEqual(r.body, { ok: false, cliente: false, felipe: true });
    _reiniciarLimites();
    f = mockFetch((c) => (c.to[0] === EMAIL_FELIPE_DEFECTO ? { status: 422, json: {} } : { status: 200, json: { id: "x" } }));
    r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase() }), { env: ENV, fetchFn: f });
    assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, cliente: true, felipe: false });
    _reiniciarLimites();
    f = mockFetch(() => ({ status: 409, json: {} }));
    r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase() }), { env: ENV, fetchFn: f });
    assert.equal(r.status, 200);
    _reiniciarLimites();
    const caido = async () => { throw new Error("ECONNRESET"); };
    r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: pedidoBase() }), { env: ENV, fetchFn: caido });
    assert.equal(r.status, 502);
    assert.ok(!errores.join("\n").includes(CLAVE_FALSA), "la clave no debe aparecer en logs");
  } finally { console.error = origError; }
});

console.log("Club");

await prueba("club válido: bienvenida al cliente con el código + aviso a Felipe", async () => {
  const f = mockFetch();
  const cod = codigoClub("laura@example.com");
  const r = await procesarSolicitud(solicitud({ tipo: "club", datos: club("laura@example.com", { via: "google" }) }), { env: ENV_SIN_BF, fetchFn: f });
  assert.equal(r.status, 200);
  const cliente = f.llamadas.find((l) => l.cuerpo.to[0] === "laura@example.com");
  const felipe = f.llamadas.find((l) => l.cuerpo.to[0] === EMAIL_FELIPE_DEFECTO);
  assert.equal(cliente.cuerpo.subject, "Bienvenido al Círculo · Tu 15% de descuento");
  assert.ok(cliente.cuerpo.html.includes(cod) && cliente.cuerpo.text.includes(cod));
  assert.ok(!cliente.cuerpo.html.includes("Black Friday"), "sin campaña no se menciona");
  assert.equal(felipe.cuerpo.subject, "Nuevo suscriptor · Laura");
  assert.ok(felipe.cuerpo.html.includes("Google Sign-In") && felipe.cuerpo.html.includes("laura@example.com"));
  assert.equal(felipe.cuerpo.reply_to, "laura@example.com");
});

await prueba("club durante Black Friday: explica que el código no se suma y se conserva", async () => {
  const f = mockFetch();
  await procesarSolicitud(solicitud({ tipo: "club", datos: club("bf@example.com") }), { env: ENV, fetchFn: f });
  const cliente = f.llamadas.find((l) => l.cuerpo.to[0] === "bf@example.com");
  assert.ok(cliente.cuerpo.html.includes("Durante Black Friday el 15&nbsp;%") && cliente.cuerpo.text.includes("no se suma"));
});

await prueba("club: el código debe ser el del correo (no se pueden mandar códigos inventados a terceros)", async () => {
  const f = mockFetch();
  const r = await procesarSolicitud(solicitud({ tipo: "club", datos: { nombre: "A", email: "victima@example.com", codigo: codigoClub("atacante@example.com") } }), { env: ENV, fetchFn: f });
  assert.equal(r.status, 400);
  assert.equal(f.llamadas.length, 0);
  // minúsculas se aceptan (se normalizan)
  _reiniciarLimites();
  const ok = await procesarSolicitud(solicitud({ tipo: "club", datos: { email: "Mayus@Example.com", codigo: codigoClub("mayus@example.com").toLowerCase() } }), { env: ENV, fetchFn: f });
  assert.equal(ok.status, 200);
});

await prueba("club: nombre vacío -> 'coleccionista'; saltos de línea no llegan al asunto; HTML escapado", async () => {
  const f = mockFetch();
  await procesarSolicitud(solicitud({ tipo: "club", datos: { email: "x@example.com", codigo: codigoClub("x@example.com") } }), { env: ENV, fetchFn: f });
  assert.equal(f.llamadas.find((l) => l.cuerpo.to[0] === EMAIL_FELIPE_DEFECTO).cuerpo.subject, "Nuevo suscriptor · coleccionista");
  _reiniciarLimites();
  const f2 = mockFetch();
  const nombre = "Ana\r\nBcc: robo@evil <b>x</b>";
  await procesarSolicitud(solicitud({ tipo: "club", datos: { nombre, email: "y@example.com", codigo: codigoClub("y@example.com") } }), { env: ENV, fetchFn: f2 });
  assert.equal(f2.llamadas.length, 2);
  for (const l of f2.llamadas) {
    assert.ok(!/[\r\n]/.test(l.cuerpo.subject), "salto de línea en asunto");
    assert.ok(!l.cuerpo.html.includes("<b>x</b>"));
    assert.equal(l.cuerpo.to.length, 1);
  }
});

await prueba("club: rechaza código/correo/campos inválidos y enlaces en el nombre", async () => {
  const f = mockFetch();
  const malos = [
    { nombre: "A", email: "a@example.com", codigo: "XX" },
    { nombre: "A", email: "no-correo", codigo: "FV15-AAAAAAA" },
    { ...club("a@example.com"), to: "x@y.co" },
    { ...club("a@example.com"), via: "sms" },
    { ...club("a@example.com"), nombre: "Premio en www.gana.co" }
  ];
  for (const d of malos) assert.equal((await procesarSolicitud(solicitud({ tipo: "club", datos: d }), { env: ENV, fetchFn: f })).status, 400);
  assert.equal(f.llamadas.length, 0);
});

console.log("Modo de prueba (RESEND_DRY_RUN=1)");

await prueba("DRY_RUN: todos los tipos arman el correo, sin clave y SIN llamar a Resend", async () => {
  const casos = [
    { tipo: "pedido", datos: pedidoBase(), asuntos: [`Nuevo pedido · ${REF} · $508.300`, `Tu pedido está confirmado · ${REF}`] },
    { tipo: "pedido", datos: { ...pedidoBase(), paymentMethod: "whatsapp" }, asuntos: [`Pedido por WhatsApp · ${REF} · $508.300`, `Recibimos tu pedido · ${REF}`] },
    { tipo: "club", datos: club("dry@example.com"), asuntos: ["Nuevo suscriptor · Laura", "Bienvenido al Círculo · Tu 15% de descuento"] }
  ];
  for (const c of casos) {
    _reiniciarLimites();
    const r = await procesarSolicitud(solicitud({ tipo: c.tipo, datos: c.datos }), { env: ENV_DRY, fetchFn: sinRed });
    assert.equal(r.status, 200, c.tipo);
    assert.equal(r.body.dryRun, true);
    assert.equal(r.body.correos.length, 2);
    const [felipe, cliente] = r.body.correos;
    assert.deepEqual([felipe.subject, cliente.subject], c.asuntos);
    assert.deepEqual(felipe.to, ["avisos@felipevergel.com"]);
    assert.deepEqual(cliente.to, [c.datos.email]);
    for (const x of r.body.correos) {
      assert.equal(x.from, "Felipe Vergel <pedidos@felipevergel.com>");
      assert.ok(x.html.startsWith("<!DOCTYPE html>") && x.text.length > 40);
    }
    assert.ok(!JSON.stringify(r.body).includes("re_"), "no hay clave en la respuesta");
  }
});

await prueba("DRY_RUN: igual valida origen, datos y escapa HTML", async () => {
  const otro = await procesarSolicitud(solicitud({ tipo: "club", datos: club("o@example.com") }, { origen: "https://evil.example" }), { env: ENV_DRY, fetchFn: sinRed });
  assert.equal(otro.status, 403);
  const d = pedidoBase(); d.fullName = "<img src=x onerror=alert(1)>";
  const r = await procesarSolicitud(solicitud({ tipo: "pedido", datos: d }), { env: ENV_DRY, fetchFn: sinRed });
  assert.equal(r.status, 200);
  assert.ok(r.body.correos.every((x) => !x.html.includes("<img src=x") && x.html.includes("&lt;img src=x")));
  const mal = await procesarSolicitud(solicitud({ tipo: "pedido", datos: { ...pedidoBase(), bcc: "x@y.co" } }), { env: ENV_DRY, fetchFn: sinRed });
  assert.equal(mal.status, 400);
});

console.log("Webhook / módulo compartido");

await prueba("enviarCorreos directo (webhook): asunto 'pago confirmado', datos del pedido guardado y línea Black Friday", async () => {
  const f = mockFetch();
  const guardado = { ...pedidoBase(), extraDesconocido: "x", _serverPriced: true };
  const datos = limpiarPedido(guardado);
  assert.ok(!("extraDesconocido" in datos) && !("_serverPriced" in datos));
  const r = await enviarCorreos("pedido", datos, { env: ENV, fetchFn: f, pagoConfirmado: true });
  assert.deepEqual([r.cliente.ok, r.felipe.ok], [true, true]);
  const felipe = f.llamadas.find((l) => l.cuerpo.to[0] === EMAIL_FELIPE_DEFECTO);
  assert.equal(felipe.cuerpo.subject, `Nuevo pedido (pago confirmado) · ${REF} · $508.300`);
  assert.ok(felipe.cuerpo.html.includes("Black Friday 15 %"));
});

await prueba("RESEND_FROM y EMAIL_FELIPE se toman del entorno", async () => {
  const f = mockFetch();
  await enviarCorreos("pedido", limpiarPedido(pedidoBase()), { env: { ...ENV, RESEND_FROM: "Taller <hola@felipevergel.com>", EMAIL_FELIPE: "otro@felipevergel.com" }, fetchFn: f });
  assert.ok(f.llamadas.every((l) => l.cuerpo.from === "Taller <hola@felipevergel.com>"));
  assert.ok(f.llamadas.some((l) => l.cuerpo.to[0] === "otro@felipevergel.com"));
});

await prueba("codigoClub = fnv1a7 del sitio (mismo código que muestra la pantalla)", async () => {
  // Valores calculados con la función fnv1a7() de index.html del sitio.
  assert.match(codigoClub("ana@example.com"), /^FV15-[A-Z0-9]{7}$/);
  assert.equal(codigoClub(" ANA@example.com "), codigoClub("ana@example.com"));
});

await prueba("fmt: formato es-CO", async () => {
  assert.equal(fmt(1234567), "$1.234.567");
  assert.equal(fmt(0), "$0");
  assert.equal(fmt("x"), "$0");
});

console.log(`\n${pasaron} pruebas OK${process.exitCode ? " — HAY FALLAS" : ""}`);
