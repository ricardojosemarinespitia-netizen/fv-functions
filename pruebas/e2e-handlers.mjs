// Prueba de punta a punta de los handlers REALES sin red:
//   wompi-sign -> save-pending -> enviar-correo -> wompi-webhook (evento firmado) -> correos (Resend simulado)
//   enviar-correo sin pedido guardado (WhatsApp)
// Crea un stub temporal de @netlify/blobs (getStore en memoria) y lo borra al final.
//   node pruebas/e2e-handlers.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUB = path.join(RAIZ, "node_modules", "@netlify", "blobs");
const yaHabia = fs.existsSync(STUB);
if (!yaHabia) {
  fs.mkdirSync(STUB, { recursive: true });
  fs.writeFileSync(path.join(STUB, "package.json"), JSON.stringify({ name: "@netlify/blobs", version: "0.0.0-stub", type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(STUB, "index.js"), [
    "const M = globalThis.__BLOBS__ || (globalThis.__BLOBS__ = new Map());",
    "export function getStore(n) {",
    "  const k = (x) => n + '/' + x;",
    "  return {",
    "    async get(x, o) { const v = M.get(k(x)); if (v == null) return null; return o && o.type === 'json' ? JSON.parse(v) : v; },",
    "    async setJSON(x, v) { M.set(k(x), JSON.stringify(v)); },",
    "    async set(x, v) { M.set(k(x), String(v)); },",
    "    async delete(x) { M.delete(k(x)); }",
    "  };",
    "}"
  ].join("\n"));
}
const limpiar = () => { if (!yaHabia) fs.rmSync(path.join(RAIZ, "node_modules"), { recursive: true, force: true }); };

try {
  process.env.WOMPI_INTEGRITY = "secreto_de_prueba";
  process.env.WOMPI_EVENTS_SECRET = "eventos_de_prueba";
  process.env.RESEND_API_KEY = "re_falsa_de_prueba";
  process.env.EMAIL_FELIPE = "avisos@felipevergel.com";
  process.env.RESEND_FROM = "Felipe Vergel <pedidos@felipevergel.com>";
  delete process.env.BLACK_FRIDAY_ACTIVO; delete process.env.RESEND_DRY_RUN;

  // Red: solo "responde" Resend (simulado); todo lo demás se bloquea y se anota.
  const resend = []; const bloqueadas = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === "https://api.resend.com/emails") {
      resend.push({ headers: init.headers, cuerpo: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: "simulado" }), { status: 200 });
    }
    bloqueadas.push(String(url));
    throw new Error("red bloqueada en la prueba: " + url);
  };
  const sign = (await import("../netlify/functions/wompi-sign.js")).default;
  const save = (await import("../netlify/functions/save-pending.js")).default;
  const hook = (await import("../netlify/functions/wompi-webhook.js")).default;
  const correo = (await import("../netlify/functions/enviar-correo.js")).default;
  const O = "https://felipevergel.com";
  const req = (fn, body, origin = O) => new Request("https://x/.netlify/functions/" + fn, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });

  // 1) Firma: Brisa x1 + Candelabro Arco x2, domicilio, con FV15 (no acumula en BF)
  const ref = "FV-1795000000000-ABCDE";
  const j = await (await sign(req("wompi-sign", { ref, items: [{ id: "lampara-caribe-brisa", qty: 1 }, { id: "candelabro-arco", qty: 2 }], deliveryMethod: "domicilio", discountCode: "FV15-ABC1234" }))).json();
  assert.equal(j.resumen.subtotal, 420750); assert.equal(j.resumen.descuento, 0); assert.equal(j.amountInCents, 46282500);

  // 2) Guardado con el carrito del navegador (precios de lista viejos a propósito)
  const s = await save(req("save-pending", {
    ref, fullName: "Ana Prueba", email: "ana@example.com", phone: "3000000000", address: "Calle 1", city: "Floridablanca", department: "Santander",
    deliveryMethod: "domicilio", paymentMethod: "pse", total: 1000, subtotal: 1,
    cart: [{ id: "lampara-caribe-brisa", sku: "LAM-002", qty: 1, price: 299000, name: "Lámpara Caribe Brisa", color: "Azul" }, { id: "candelabro-arco", qty: 2, price: 98000, name: "Candelabro Arco", color: "Ámbar" }]
  }));
  assert.equal(s.status, 200);

  // 3) enviar-correo (navegador, al volver de Wompi) con montos falsos: salen los del pedido guardado
  resend.length = 0;
  const rc = await correo(req("enviar-correo", { tipo: "pedido", datos: { ref, fullName: "Ana Prueba", email: "ana@example.com", paymentMethod: "pse", deliveryMethod: "domicilio", total: 5, subtotal: 5, cart: [{ id: "lampara-caribe-brisa", qty: 1, name: "x", price: 1 }] } }));
  assert.equal(rc.status, 200, await rc.clone().text());
  assert.equal(resend.length, 2);
  assert.ok(resend.every((c) => c.cuerpo.html.includes("$462.825")), "total del servidor");
  assert.ok(resend.some((c) => c.cuerpo.to[0] === "avisos@felipevergel.com") && resend.some((c) => c.cuerpo.to[0] === "ana@example.com"));
  // misma referencia con el correo de otra persona -> 403
  const ajeno = await correo(req("enviar-correo", { tipo: "pedido", datos: { ref, fullName: "X", email: "otra@example.com", paymentMethod: "pse", cart: [{ id: "lampara-caribe-brisa", qty: 1, name: "x", price: 1 }] } }));
  assert.equal(ajeno.status, 403);

  // 4) Webhook con evento firmado APPROVED -> correos "pago confirmado" con línea Black Friday
  resend.length = 0;
  const data = { transaction: { id: "tx-1", status: "APPROVED", reference: ref, amount_in_cents: 46282500 } };
  const props = ["transaction.id", "transaction.status", "transaction.amount_in_cents"];
  const ts = 1795000000;
  const checksum = crypto.createHash("sha256").update("tx-1APPROVED46282500" + ts + "eventos_de_prueba").digest("hex");
  const rh = await hook(new Request("https://x/.netlify/functions/wompi-webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "transaction.updated", data, timestamp: ts, signature: { properties: props, checksum } }) }));
  assert.equal(rh.status, 200, await rh.clone().text());
  assert.equal(resend.length, 2);
  const felipe = resend.find((c) => c.cuerpo.to[0] === "avisos@felipevergel.com");
  assert.equal(felipe.cuerpo.subject, `Nuevo pedido (pago confirmado) · ${ref} · $462.825`);
  assert.ok(felipe.cuerpo.html.includes("Black Friday 15 %") && felipe.cuerpo.html.includes("ahorro $74.250"));
  assert.equal(felipe.headers["Idempotency-Key"], `pedido-${ref}-felipe`);
  // segunda entrega del mismo evento: idempotente, no reenvía
  resend.length = 0;
  const rh2 = await hook(new Request("https://x/.netlify/functions/wompi-webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "transaction.updated", data, timestamp: ts, signature: { properties: props, checksum } }) }));
  assert.equal(rh2.status, 200); assert.equal(resend.length, 0);

  // 5) WhatsApp (sin pedido guardado): montos recalculados con el catálogo
  resend.length = 0;
  const wa = await correo(req("enviar-correo", { tipo: "pedido", datos: { ref: "FV-1795000000002-WHATS", fullName: "Beto", email: "beto@example.com", paymentMethod: "whatsapp", deliveryMethod: "bucaramanga", total: 254150, subtotal: 254150, cart: [{ id: "lampara-caribe-brisa", sku: "LAM-002", qty: 1, name: "Lámpara Caribe Brisa", color: "Azul", price: 254150, precioLista: 299000 }] } }));
  assert.equal(wa.status, 200);
  assert.deepEqual(resend.map((c) => c.cuerpo.subject).sort(), ["Pedido por WhatsApp · FV-1795000000002-WHATS · $254.150", "Recibimos tu pedido · FV-1795000000002-WHATS"]);

  // 6) Origen ajeno
  assert.equal((await correo(req("enviar-correo", { tipo: "club", datos: {} }, "https://evil.example"))).status, 403);

  // Lo único que intentó salir (y se bloqueó): Google Forms / Apps Script.
  assert.ok(bloqueadas.every((u) => /docs\.google\.com|script\.google\.com/.test(u)), "salida inesperada: " + bloqueadas.join(", "));
  console.log("OK e2e: firma, guardado, enviar-correo (PSE con montos del servidor, pedido ajeno 403, WhatsApp recalculado), webhook firmado e idempotente. Salidas bloqueadas:", bloqueadas.length);
} finally {
  limpiar();
}
