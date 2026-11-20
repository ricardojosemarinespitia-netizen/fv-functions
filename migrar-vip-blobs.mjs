// ============================================================
//  migrar-vip-blobs.mjs  ·  Pasa los FV20 que ya existan en Netlify Blobs
//  ("vip-codigos", el almacén anterior) a Supabase, como SQL para pegar en
//  el editor SQL. Solo LEE el almacén; no escribe ni borra nada en Netlify.
//
//  Correr UNA VEZ justo antes de desplegar este servidor (si vip-codigo ya
//  estaba publicado y alguien pidió su código, ese código vive solo en Blobs):
//
//    NETLIFY_SITE_ID=<id del sitio exquisite-pasca-848b8b> \
//    NETLIFY_AUTH_TOKEN=<token personal de Netlify> \
//    node migrar-vip-blobs.mjs "<carpeta privada>/04_fv20_desde_blobs.sql"
//
//  El SQL es idempotente (ON CONFLICT DO NOTHING / UPDATE solo si no estaba
//  usado). Datos personales: el archivo de salida va a la carpeta PRIVADA de
//  migración, nunca a este repo.
// ============================================================
import fs from "node:fs";
import { getStore } from "@netlify/blobs";

const salida = process.argv[2];
const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!salida || !siteID || !token) {
  console.error('Uso: NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node migrar-vip-blobs.mjs "<ruta>/04_fv20_desde_blobs.sql"');
  process.exit(2);
}
const q = (v) => (v == null || v === "" ? "null" : "'" + String(v).replace(/'/g, "''") + "'");
const store = getStore({ name: "vip-codigos", siteID, token });
const { blobs } = await store.list({ prefix: "codigo:" });
const filas = [];
for (const b of blobs) {
  const r = await store.get(b.key, { type: "json" });
  if (!r || !/^FV20-[A-Z0-9]{7}$/.test(String(r.codigo || ""))) continue;
  filas.push(r);
}
const L = ["-- FV20 emitidos antes de la migración (almacén Netlify Blobs vip-codigos). Generado " + new Date().toISOString(), "begin;"];
for (const r of filas) {
  const email = String(r.email || "").trim().toLowerCase();
  const origen = r.origen === "circulo" ? "circulo" : "vip";
  L.push(`insert into public.suscriptores (email, nombre, origen, metodo, creado_en) values (${q(email)}, ${q(r.nombre && r.nombre !== "coleccionista" ? r.nombre : null)}, '${origen}', null, ${q(r.creado)}) on conflict (email) do nothing;`);
  L.push(`insert into public.codigos_descuento (codigo, tipo, email, creado_en, usado, usado_en, referencia_pedido, origen) values (${q(r.codigo)}, 'FV20', ${q(email)}, ${q(r.creado)}, ${r.usado ? "true" : "false"}, ${r.usado ? q(r.usadoEn) : "null"}, ${r.usado ? q(r.usadoRef) : "null"}, '${origen}')`);
  L.push(`  on conflict (codigo) do update set usado = true, usado_en = excluded.usado_en, referencia_pedido = excluded.referencia_pedido where excluded.usado and not public.codigos_descuento.usado;`);
}
L.push("commit;");
fs.writeFileSync(salida, L.join("\n") + "\n", "utf8");
console.log(`${filas.length} códigos FV20 leídos de Blobs -> ${salida}`);
