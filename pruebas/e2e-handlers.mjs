// Prueba de punta a punta de los handlers REALES sin red:
//   wompi-sign -> save-pending -> enviar-correo -> wompi-webhook (evento firmado) -> correos (Resend simulado)
//   enviar-correo sin pedido guardado (WhatsApp)
//   Supabase = servidor FALSO local (test/supabase-falso.mjs): códigos, suscriptores y pedidos.
// Crea un stub temporal de @netlify/blobs (getStore en memoria) y lo borra al final.
//   node pruebas/e2e-handlers.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { iniciarSupabaseFalso } from "../test/supabase-falso.mjs";

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

const SB = await iniciarSupabaseFalso();
try {
  process.env.SUPABASE_URL = SB.url;
  process.env.SUPABASE_SERVICE_KEY = SB.cfg.key;
  process.env.WOMPI_INTEGRITY = "secreto_de_prueba";
  process.env.WOMPI_EVENTS_SECRET = "eventos_de_prueba";
  process.env.RESEND_API_KEY = "re_falsa_de_prueba";
  process.env.EMAIL_FELIPE = "avisos@felipevergel.com";
  process.env.RESEND_FROM = "Felipe Vergel <pedidos@felipevergel.com>";
  delete process.env.BLACK_FRIDAY_ACTIVO; delete process.env.RESEND_DRY_RUN; delete process.env.VIP_HASTA;
  // Pasos 1-5: Black Friday YA iniciado (inicio simulado en el pasado).
  process.env.BLACK_FRIDAY_DESDE = "2026-01-01T00:00:00-05:00";

  // Red: solo "responde" Resend (simulado); todo lo demás se bloquea y se anota.
  const resend = []; const bloqueadas = [];
  const fetchReal = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith(SB.url)) return fetchReal(url, init);
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
  const vipFn = (await import("../netlify/functions/vip-codigo.js")).default;
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

  // 6) Antes del lanzamiento (inicio en el futuro): precio de lista, sin BF
  process.env.BLACK_FRIDAY_DESDE = "2099-01-01T00:00:00-05:00";
  const pre = await (await sign(req("wompi-sign", { ref: "FV-1795000000010-PREBF", items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga" }))).json();
  assert.equal(pre.resumen.subtotal, 299000); assert.equal(pre.resumen.blackFriday.activo, false); assert.equal(pre.amountInCents, 29900000);

  // 7) FV20 de punta a punta (antes del lanzamiento: el único descuento)
  const firmarEvento = (id, status, ref, cents) => {
    const d = { transaction: { id, status, reference: ref, amount_in_cents: cents } };
    const cs = crypto.createHash("sha256").update(id + status + cents + ts + "eventos_de_prueba").digest("hex");
    return new Request("https://x/.netlify/functions/wompi-webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "transaction.updated", data: d, timestamp: ts, signature: { properties: props, checksum: cs } }) });
  };
  resend.length = 0;
  const sv = await vipFn(req("vip-codigo", { accion: "solicitar", origen: "vip", nombre: "Vera", email: "vera@example.com", web: "" }));
  const jv = await sv.json();
  assert.equal(sv.status, 200, JSON.stringify(jv)); assert.match(jv.codigo, /^FV20-[A-Z0-9]{7}$/); assert.equal(jv.correo, true);
  assert.equal(resend.length, 2, "correo VIP a cliente + aviso a Felipe");
  const COD = jv.codigo;
  const ver = async () => (await (await vipFn(req("vip-codigo", { accion: "verificar", codigo: COD }))).json()).estado;
  assert.equal(await ver(), "valido");
  // 7a) pago RECHAZADO: el código sigue válido
  const refV1 = "FV-1795000000020-VIPUN";
  const s1 = await (await sign(req("wompi-sign", { ref: refV1, items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "domicilio", discountCode: COD }))).json();
  // 299.000 - 20 % = 239.200; envío 15 % (tramo hasta 310.000) = 35.880; total 275.080
  assert.equal(s1.resumen.descuento, 59800); assert.equal(s1.resumen.tipoDescuento, "vip"); assert.equal(s1.resumen.codigo, COD); assert.equal(s1.amountInCents, 27508000);
  await save(req("save-pending", { ref: refV1, fullName: "Vera", email: "vera@example.com", deliveryMethod: "domicilio", paymentMethod: "pse", discountCode: COD, cart: [{ id: "lampara-caribe-brisa", qty: 1, price: 299000, name: "Lámpara Caribe Brisa", color: "Azul" }] }));
  assert.equal((await hook(firmarEvento("tx-v1", "DECLINED", refV1, 29900000))).status, 200);
  assert.equal(await ver(), "valido", "un pago rechazado no gasta el código");
  // 7b) pago APROBADO: se marca usado (aunque el navegador ya lo marcó "done")
  const refV2 = "FV-1795000000021-VIPDO";
  await sign(req("wompi-sign", { ref: refV2, items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "domicilio", discountCode: COD }));
  await save(req("save-pending", { ref: refV2, fullName: "Vera", email: "vera@example.com", deliveryMethod: "domicilio", paymentMethod: "pse", discountCode: COD, cart: [{ id: "lampara-caribe-brisa", qty: 1, price: 299000, name: "Lámpara Caribe Brisa", color: "Azul" }], _status: "done" }));
  resend.length = 0;
  assert.equal((await hook(firmarEvento("tx-v2", "APPROVED", refV2, 29900000))).status, 200);
  assert.equal(await ver(), "usado", "pago aprobado gasta el código");
  // 7c) reusar el código: el servidor cobra sin descuento (el checkout no abre Wompi)
  const s3 = await (await sign(req("wompi-sign", { ref: "FV-1795000000022-VIPRE", items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "domicilio", discountCode: COD }))).json();
  assert.equal(s3.resumen.descuento, 0); assert.equal(s3.resumen.veredictoCodigo, "usado"); assert.equal(s3.resumen.codigo, "");
  // 7c2) FV10 del Círculo de punta a punta (antes del lanzamiento): 10 % sobre lista, un uso
  const jc = await (await vipFn(req("vip-codigo", { accion: "solicitar", origen: "circulo", email: "cira@example.com", web: "" }))).json();
  assert.match(jc.codigo, /^FV10-[A-Z0-9]{7}$/); assert.equal(jc.tipo, "FV10"); assert.equal(jc.pct, 10);
  const C10 = jc.codigo;
  const ver10 = async () => (await (await vipFn(req("vip-codigo", { accion: "verificar", codigo: C10 }))).json()).estado;
  assert.equal(await ver10(), "valido");
  const refC1 = "FV-1795000000050-CIR10";
  const c1 = await (await sign(req("wompi-sign", { ref: refC1, items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: C10 }))).json();
  // 299.000 - 10 % = 269.100 (Bucaramanga: sin envío)
  assert.equal(c1.resumen.descuento, 29900); assert.equal(c1.resumen.tipoDescuento, "circulo"); assert.equal(c1.resumen.codigo, C10); assert.equal(c1.resumen.veredictoCodigo, "valido"); assert.equal(c1.amountInCents, 26910000);
  await save(req("save-pending", { ref: refC1, fullName: "Cira", email: "cira@example.com", deliveryMethod: "bucaramanga", paymentMethod: "pse", discountCode: C10, cart: [{ id: "lampara-caribe-brisa", qty: 1, price: 299000, name: "Lámpara Caribe Brisa", color: "Azul" }] }));
  assert.equal((await hook(firmarEvento("tx-c1", "DECLINED", refC1, 26910000))).status, 200);
  assert.equal(await ver10(), "valido", "un pago rechazado no gasta el FV10");
  assert.equal((await hook(firmarEvento("tx-c2", "APPROVED", refC1, 26910000))).status, 200);
  assert.equal(await ver10(), "usado", "pago aprobado gasta el FV10");
  const c3 = await (await sign(req("wompi-sign", { ref: "FV-1795000000051-CIR1R", items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: C10 }))).json();
  assert.equal(c3.resumen.descuento, 0); assert.equal(c3.resumen.veredictoCodigo, "usado"); assert.equal(c3.resumen.codigo, "");
  // FV10 inventado / formato malo: sin descuento
  const c4 = await (await sign(req("wompi-sign", { ref: "FV-1795000000052-CIR1X", items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: "FV10-ZZZZZZZ" }))).json();
  assert.equal(c4.resumen.descuento, 0); assert.equal(c4.resumen.veredictoCodigo, "invalido");

  // 7d) FV20 después del lanzamiento: reemplaza al 15 % (sobre lista), no se acumula
  process.env.BLACK_FRIDAY_DESDE = "2026-01-01T00:00:00-05:00";
  const jv2 = await (await vipFn(req("vip-codigo", { accion: "solicitar", origen: "vip", nombre: "Post", email: "post@example.com", web: "" }))).json();
  assert.match(jv2.codigo, /^FV20-/);
  const s4 = await (await sign(req("wompi-sign", { ref: "FV-1795000000023-VIPBF", items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: jv2.codigo }))).json();
  assert.equal(s4.resumen.subtotal, 299000); assert.equal(s4.resumen.descuentoBF, 0); assert.equal(s4.resumen.descuento, 59800); assert.equal(s4.amountInCents, 23920000);
  // 7e) FV15 durante BF: mismo 15 %, no se guarda como código (no se gasta)
  const s5 = await (await sign(req("wompi-sign", { ref: "FV-1795000000024-CLUBF", items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: "FV15-ABC1234" }))).json();
  assert.equal(s5.resumen.subtotal, 254150); assert.equal(s5.resumen.descuento, 0); assert.equal(s5.resumen.codigo, ""); assert.equal(s5.resumen.veredictoCodigo, "igual-que-black-friday");
  // 7e2) Círculo durante BF: FV20 de campaña (20 % sobre lista, reemplaza al 15 %)
  const jc2 = await (await vipFn(req("vip-codigo", { accion: "solicitar", origen: "circulo", email: "cira2@example.com", web: "" }))).json();
  assert.match(jc2.codigo, /^FV20-/); assert.equal(jc2.pct, 20); assert.equal(jc2.soloBF, true);
  const s6 = await (await sign(req("wompi-sign", { ref: "FV-1795000000053-CIRBF", items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: jc2.codigo }))).json();
  assert.equal(s6.resumen.subtotal, 299000); assert.equal(s6.resumen.descuentoBF, 0); assert.equal(s6.resumen.descuento, 59800); assert.equal(s6.amountInCents, 23920000);
  const verC2 = async () => (await (await vipFn(req("vip-codigo", { accion: "verificar", codigo: jc2.codigo }))).json()).estado;
  assert.equal(await verC2(), "valido");
  // al terminar Black Friday ese código deja de valer
  process.env.BLACK_FRIDAY_HASTA = "2026-01-02T00:00:00-05:00";
  assert.equal(await verC2(), "vencido");
  const s7 = await (await sign(req("wompi-sign", { ref: "FV-1795000000054-CIRFIN", items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: jc2.codigo }))).json();
  assert.equal(s7.resumen.descuento, 0);
  delete process.env.BLACK_FRIDAY_HASTA;
  // 7f) Correo de pedido por WhatsApp con FV20 válido: el 20 % sale en el correo
  resend.length = 0;
  const waV = await correo(req("enviar-correo", { tipo: "pedido", datos: { ref: "FV-1795000000025-WAVIP", fullName: "Post", email: "post@example.com", paymentMethod: "whatsapp", deliveryMethod: "bucaramanga", discountCode: jv2.codigo, total: 239200, subtotal: 299000, cart: [{ id: "lampara-caribe-brisa", qty: 1, name: "Lámpara Caribe Brisa", color: "Azul", price: 254150 }] } }));
  assert.equal(waV.status, 200);
  assert.ok(resend.every((c) => c.cuerpo.html.includes("$239.200") && c.cuerpo.html.includes(jv2.codigo)));

  // 8) Origen ajeno
  assert.equal((await correo(req("enviar-correo", { tipo: "club", datos: {} }, "https://evil.example"))).status, 403);

  // 9) Supabase quedó como fuente de verdad: pedidos aprobados, código usado, suscriptores
  const pedidosDb = SB.db.pedidos.map((p) => p.referencia).sort();
  assert.deepEqual(pedidosDb, [ref, refV2, refC1].sort(), "solo los pagos APROBADOS quedan en pedidos");
  const pAna = SB.db.pedidos.find((p) => p.referencia === ref);
  assert.equal(pAna.total, 462825); assert.equal(pAna.wompi_tx_id, "tx-1"); assert.equal(pAna.origen, "webhook");
  assert.equal(SB.db.pedidos_items.filter((i) => i.pedido_id === pAna.id).length, 2);
  const cV = SB.db.codigos_descuento.find((c) => c.codigo === COD);
  assert.equal(cV.usado, true); assert.equal(cV.referencia_pedido, refV2);
  const sus = Object.fromEntries(SB.db.suscriptores.map((x) => [x.email, x.origen]));
  assert.equal(sus["vera@example.com"], "vip", "pidió su código en /vip y luego compró: sigue como vip");
  assert.equal(sus["ana@example.com"], "compra"); assert.equal(sus["post@example.com"], "vip"); assert.equal(sus["cira@example.com"], "circulo"); assert.equal(SB.db.codigos_descuento.find((c) => c.codigo === C10).usado, true); assert.equal(SB.db.codigos_descuento.find((c) => c.codigo === C10).referencia_pedido, refC1);

  // 10) FV15 histórico fuera de Black Friday: Supabase lo valida, da 15 % y se gasta al aprobar
  process.env.BLACK_FRIDAY_DESDE = "2099-01-01T00:00:00-05:00";
  SB.db.codigos_descuento.push({ codigo: "FV15-HISTO12", tipo: "FV15", email: "histo@example.com", usado: false, usado_en: null, referencia_pedido: null, origen: "circulo" });
  const ref15 = "FV-1795000000030-CLUBQ";
  const f15 = await (await sign(req("wompi-sign", { ref: ref15, items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: "FV15-HISTO12" }))).json();
  assert.equal(f15.resumen.veredictoCodigo, "valido"); assert.equal(f15.resumen.descuento, 44850); assert.equal(f15.resumen.codigo, "FV15-HISTO12");
  await save(req("save-pending", { ref: ref15, fullName: "Histo", email: "histo@example.com", deliveryMethod: "bucaramanga", paymentMethod: "pse", cart: [{ id: "lampara-caribe-brisa", qty: 1, price: 299000, name: "Lámpara Caribe Brisa", color: "Azul" }] }));
  assert.equal((await hook(firmarEvento("tx-15", "APPROVED", ref15, f15.amountInCents))).status, 200);
  assert.equal(SB.db.codigos_descuento.find((c) => c.codigo === "FV15-HISTO12").referencia_pedido, ref15);
  const r15b = await (await sign(req("wompi-sign", { ref: "FV-1795000000031-CLUBR", items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: "FV15-HISTO12" }))).json();
  assert.equal(r15b.resumen.veredictoCodigo, "usado"); assert.equal(r15b.resumen.descuento, 0);
  // FV15 que no existe en la base: sin descuento (antes "sin-verificar" se aplicaba igual)
  const r15c = await (await sign(req("wompi-sign", { ref: "FV-1795000000032-CLUBS", items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: "FV15-NOEXIST" }))).json();
  assert.equal(r15c.resumen.veredictoCodigo, "invalido"); assert.equal(r15c.resumen.descuento, 0);

  // 11) Supabase CAÍDO: el cobro va sin descuento (falla cerrado) y el webhook usa Google Forms de respaldo
  assert.equal(bloqueadas.length, 0, "con Supabase arriba no se escribe en Google: " + bloqueadas.join(", "));
  SB.db.codigos_descuento.push({ codigo: "FV15-CAIDO12", tipo: "FV15", email: "cai@example.com", usado: false });
  SB.modo = "caido";
  const errOrig = console.error; console.error = () => {};
  try {
    const fc = await (await sign(req("wompi-sign", { ref: "FV-1795000000040-CAIDO", items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: "FV15-CAIDO12" }))).json();
    assert.equal(fc.resumen.veredictoCodigo, "sin-verificar"); assert.equal(fc.resumen.descuento, 0); assert.equal(fc.amountInCents, 29900000);
    await save(req("save-pending", { ref: "FV-1795000000040-CAIDO", fullName: "Cai", email: "cai@example.com", deliveryMethod: "bucaramanga", paymentMethod: "pse", cart: [{ id: "lampara-caribe-brisa", qty: 1, price: 299000, name: "Lámpara Caribe Brisa", color: "Azul" }] }));
    resend.length = 0;
    assert.equal((await hook(firmarEvento("tx-c", "APPROVED", "FV-1795000000040-CAIDO", 29900000))).status, 200);
    assert.equal(resend.length, 2, "los correos salen igual");
  } finally { console.error = errOrig; }
  assert.deepEqual(bloqueadas.map((u) => new URL(u).host), ["docs.google.com"], "respaldo: un envío a Google Forms");
  SB.modo = "ok";

  // 12) Migración perezosa: FV20 pedido en /vip con el servidor ANTERIOR (solo en Blobs "vip-codigos")
  const M = globalThis.__BLOBS__;
  const shaE = (e) => crypto.createHash("sha256").update(e).digest("hex");
  M.set("vip-codigos/codigo:FV20-BLOBSAA", JSON.stringify({ codigo: "FV20-BLOBSAA", email: "blob@example.com", nombre: "Blob", origen: "vip", creado: "2026-11-19T21:25:00.000Z", usado: false }));
  M.set("vip-codigos/correo:" + shaE("blob@example.com"), JSON.stringify({ codigo: "FV20-BLOBSAA" }));
  const refB = "FV-1795000000050-BLOBX";
  const fb = await (await sign(req("wompi-sign", { ref: refB, items: [{ id: "lampara-caribe-brisa", qty: 1 }], deliveryMethod: "bucaramanga", discountCode: "FV20-BLOBSAA" }))).json();
  assert.equal(fb.resumen.veredictoCodigo, "valido"); assert.equal(fb.resumen.descuento, 59800);
  assert.equal(SB.db.codigos_descuento.find((c) => c.codigo === "FV20-BLOBSAA").creado_en, "2026-11-19T21:25:00.000Z");
  await save(req("save-pending", { ref: refB, fullName: "Blob", email: "blob@example.com", deliveryMethod: "bucaramanga", paymentMethod: "pse", cart: [{ id: "lampara-caribe-brisa", qty: 1, price: 299000, name: "Lámpara Caribe Brisa", color: "Azul" }] }));
  assert.equal((await hook(firmarEvento("tx-b", "APPROVED", refB, fb.amountInCents))).status, 200);
  assert.equal(SB.db.codigos_descuento.find((c) => c.codigo === "FV20-BLOBSAA").referencia_pedido, refB);
  const vb = await (await vipFn(req("vip-codigo", { accion: "solicitar", origen: "vip", nombre: "Blob", email: "blob@example.com", web: "" }))).json();
  assert.equal(vb.codigo, "FV20-BLOBSAA", "pedirlo otra vez devuelve el mismo código");
  assert.equal(JSON.parse(M.get("vip-codigos/codigo:FV20-BLOBSAA")).usado, false, "Blobs no se escribe");

  console.log("OK e2e (+ migración perezosa desde Blobs): firma, guardado, enviar-correo, webhook firmado e idempotente, inicio de BF por hora, FV20 completo (rechazado no gasta, aprobado gasta, reuso sin descuento, reemplaza BF), FV15 en BF no se gasta, FV15 histórico validado y gastado en Supabase, pedidos y suscriptores en Supabase, Supabase caído = sin descuento + respaldo en Forms.");
} finally {
  limpiar();
  await SB.cerrar();
}
