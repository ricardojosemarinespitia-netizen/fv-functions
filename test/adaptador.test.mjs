// Prueba del adaptador de Netlify (Request/Response) sin red.  node test/adaptador.test.mjs
import assert from "node:assert/strict";
import { codigoClub } from "../netlify/functions/lib/correos.js";
globalThis.fetch = async (url) => { throw new Error("RED BLOQUEADA en pruebas: " + url); };
const h = (await import("../netlify/functions/enviar-correo.js")).default;
const URL_FN = "https://x/.netlify/functions/enviar-correo";
const O = "https://felipevergel.com";
delete process.env.RESEND_API_KEY; delete process.env.RESEND_DRY_RUN;

const pre = await h(new Request(URL_FN, { method: "OPTIONS", headers: { origin: O } }));
assert.equal(pre.status, 204);
assert.equal(pre.headers.get("access-control-allow-origin"), O);
const preMal = await h(new Request(URL_FN, { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
assert.equal(preMal.status, 403);
assert.equal(preMal.headers.get("access-control-allow-origin"), null);

const sinClave = await h(new Request(URL_FN, { method: "POST", headers: { origin: O }, body: "{}" }));
assert.equal(sinClave.status, 503);
const otro = await h(new Request(URL_FN, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }));
assert.equal(otro.status, 403);

// Modo de prueba: sin clave, arma el correo y lo devuelve; no sale nada a la red.
process.env.RESEND_DRY_RUN = "1";
process.env.EMAIL_FELIPE = "avisos@felipevergel.com";
process.env.RESEND_FROM = "Felipe Vergel <pedidos@felipevergel.com>";
const email = "prueba@example.com";
const dry = await h(new Request(URL_FN, {
  method: "POST", headers: { origin: O, "content-type": "application/json", "x-nf-client-connection-ip": "9.9.9.9" },
  body: JSON.stringify({ tipo: "club", datos: { nombre: "Prueba", email, codigo: codigoClub(email) } })
}));
assert.equal(dry.status, 200);
const j = await dry.json();
assert.equal(j.dryRun, true);
assert.deepEqual(j.correos.map((c) => c.to[0]), ["avisos@felipevergel.com", email]);
delete process.env.RESEND_DRY_RUN;
console.log("adaptador OK (6 comprobaciones)");
