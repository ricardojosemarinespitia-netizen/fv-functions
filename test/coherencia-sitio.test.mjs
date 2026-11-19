// Coherencia sitio <-> servidor de correos.  node test/coherencia-sitio.test.mjs "<carpeta del sitio>"
// Comprueba: el hash del código del Círculo (fnv1a7) es idéntico, el sitio
// llama a esta función por su URL de producción y no queda nada de EmailJS.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { codigoClub, ORIGENES_OK } from "../netlify/functions/lib/correos.js";

const SITIO = process.argv[2];
if (!SITIO) { console.error("Uso: node test/coherencia-sitio.test.mjs <carpeta del sitio>"); process.exit(2); }
const leer = (f) => fs.readFileSync(path.join(SITIO, f), "utf8");
const index = leer("index.html");

// 1) fnv1a7 del sitio = codigoClub del servidor
const m = index.match(/function fnv1a7\(str\) \{[\s\S]*?\n  \}/);
assert.ok(m, "no encontré fnv1a7 en index.html");
const fnv1a7 = new Function(m[0] + "; return fnv1a7;")();
for (const e of ["ana@example.com", "laura.perez+bf@gmail.com", "x@y.co", "ÑANDÚ@correo.com".toLowerCase(), "a".repeat(64) + "@felipevergel.com"]) {
  assert.equal("FV15-" + fnv1a7(e), codigoClub(e), "hash distinto para " + e);
}

// 2) URL de la función y CSP
const URL_FN = "https://exquisite-pasca-848b8b.netlify.app/.netlify/functions/enviar-correo";
assert.ok(index.includes(URL_FN), "index.html no llama a enviar-correo");
assert.ok(leer("checkout.html").includes(URL_FN), "checkout.html no llama a enviar-correo");
for (const f of ["index.html", "checkout.html", "customer-info.html", "product.html", "_headers"]) {
  const t = leer(f);
  assert.ok(!/emailjs/i.test(t), f + " todavía menciona EmailJS");
  const csp = (t.match(/connect-src[^;"]*/) || [""])[0];
  assert.ok(csp.includes("https://exquisite-pasca-848b8b.netlify.app"), f + ": connect-src sin el servidor de funciones");
}
assert.deepEqual(ORIGENES_OK, ["https://felipevergel.com", "https://www.felipevergel.com"]);
console.log("coherencia sitio/servidor OK");
