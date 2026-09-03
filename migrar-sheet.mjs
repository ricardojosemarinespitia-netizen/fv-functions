// ============================================================
//  migrar-sheet.mjs  ·  Fase 6 del plan de migracion a Supabase
// ------------------------------------------------------------
//  Lee un CSV exportado a mano del Google Sheet de pedidos (Archivo >
//  Descargar > CSV) y sube cada fila reconocible a Supabase con
//  origen='migracion-sheet'.
//
//  NO TOCA el Google Sheet original — solo LEE el CSV que ya
//  exportaste. NO toca Google Forms, checkout.html, ni ninguna otra
//  parte del sitio.
//
//  Idempotente: pedidos.referencia es UNIQUE, y el insert usa
//  on_conflict=referencia&Prefer:resolution=ignore-duplicates — si un
//  pedido del CSV ya lo escribio el webhook (o si corres este script
//  dos veces), no se duplica, se ignora en silencio.
//
//  Uso:
//    node migrar-sheet.mjs --csv "ruta/al/export.csv" --dry-run
//    node migrar-sheet.mjs --csv "ruta/al/export.csv"          (real)
//
//  Variables de entorno requeridas (mismas que usa el webhook):
//    SUPABASE_URL, SUPABASE_SERVICE_KEY
//
//  Formato esperado de la fila de descripcion, tal como la arma
//  guardarPedido() en checkout.html / index.html y el paso 6 de
//  wompi-webhook.js:
//    "PEDIDO #FV-1234567890-ABCDE · correo@ejemplo.com · 1x [SKU] Nombre (Color) — $90.000 | ... · Total $90.000"
// ============================================================
import fs from "node:fs";

function parseArgs(argv) {
  const out = { dryRun: false, csv: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--csv") out.csv = argv[++i];
  }
  return out;
}

// Parser CSV simple pero correcto con comillas dobles y comas dentro de campos.
function parseCSV(text) {
  const filas = [];
  let fila = [];
  let campo = "";
  let enComillas = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (enComillas) {
      if (c === '"') {
        if (text[i + 1] === '"') { campo += '"'; i++; }
        else enComillas = false;
      } else campo += c;
    } else {
      if (c === '"') enComillas = true;
      else if (c === ",") { fila.push(campo); campo = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        fila.push(campo); campo = "";
        if (fila.length > 1 || fila[0] !== "") filas.push(fila);
        fila = [];
      } else campo += c;
    }
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

const RE_REF = /FV-\d{10,16}-[A-Z0-9]{1,12}/;
const RE_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const RE_TOTAL = /Total\s*\$?\s*([\d.,]+)/i;

function extraerDeDescripcion(texto) {
  if (!texto) return null;
  const ref = texto.match(RE_REF);
  if (!ref) return null;
  const email = texto.match(RE_EMAIL);
  const total = texto.match(RE_TOTAL);
  return {
    referencia: ref[0],
    email: email ? email[0].toLowerCase() : null,
    totalTexto: total ? total[1] : null
  };
}

async function main() {
  const { dryRun, csv } = parseArgs(process.argv.slice(2));
  if (!csv) {
    console.error("Uso: node migrar-sheet.mjs --csv \"ruta/export.csv\" [--dry-run]");
    process.exit(1);
  }
  if (!fs.existsSync(csv)) {
    console.error("No existe el archivo:", csv);
    process.exit(1);
  }

  const texto = fs.readFileSync(csv, "utf8").replace(/^﻿/, ""); // quita BOM si lo trae
  const filas = parseCSV(texto);
  if (!filas.length) {
    console.error("El CSV esta vacio.");
    process.exit(1);
  }

  const headers = filas[0];
  const dataRows = filas.slice(1);

  console.log(`Columnas detectadas: ${headers.join(" | ")}`);
  console.log(`Filas de datos: ${dataRows.length}\n`);

  const reconocidas = [];
  const sinReferencia = [];

  for (const fila of dataRows) {
    // Busca la referencia FV-... en CUALQUIER columna de la fila
    // (normalmente la de "descripción"/"observaciones", pero no
    // asumimos una columna fija por nombre — los headers de un Form
    // de Google son el texto de la pregunta, no un id estable).
    let encontrado = null;
    for (const celda of fila) {
      const r = extraerDeDescripcion(celda);
      if (r) { encontrado = r; break;
      }
    }
    if (encontrado) {
      reconocidas.push({ fila, ...encontrado });
    } else {
      sinReferencia.push(fila);
    }
  }

  console.log(`Filas con referencia FV-... reconocida: ${reconocidas.length}`);
  console.log(`Filas SIN referencia reconocible (se omiten, quedan listadas abajo): ${sinReferencia.length}\n`);

  if (dryRun) {
    console.log("=== MODO SIMULACION (--dry-run): no se escribe nada en Supabase ===\n");
    reconocidas.slice(0, 20).forEach((r, i) => {
      console.log(`${i + 1}. ref=${r.referencia}  email=${r.email || "(no encontrado)"}  total=${r.totalTexto || "?"}`);
    });
    if (reconocidas.length > 20) console.log(`... y ${reconocidas.length - 20} más.`);
    if (sinReferencia.length) {
      console.log("\nFilas omitidas (sin referencia FV-... reconocible):");
      sinReferencia.slice(0, 10).forEach((f, i) => console.log(`  ${i + 1}.`, f.join(" | ").slice(0, 120)));
      if (sinReferencia.length > 10) console.log(`  ... y ${sinReferencia.length - 10} más.`);
    }
    console.log("\nRevisa la lista de arriba. Corre sin --dry-run cuando estés listo.");
    return;
  }

  const URL_BASE = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL_BASE || !KEY) {
    console.error("Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en el entorno.");
    process.exit(1);
  }
  const headersBase = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` };

  let insertadas = 0, ignoradas = 0, errores = 0;
  for (const r of reconocidas) {
    try {
      const rPedido = await fetch(`${URL_BASE}/rest/v1/pedidos?on_conflict=referencia`, {
        method: "POST",
        headers: { ...headersBase, Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify([{
          referencia: r.referencia,
          cliente_email: r.email,
          cliente_nombre: null,
          origen: "migracion-sheet",
          total: r.totalTexto ? Number(r.totalTexto.replace(/[.,]/g, "")) : 0,
          payload_raw: { filaCSV: r.fila }
        }])
      });
      if (!rPedido.ok) { errores++; console.error("Error en", r.referencia, rPedido.status, await rPedido.text()); continue; }
      const filasRes = await rPedido.json().catch(() => []);
      if (Array.isArray(filasRes) && filasRes.length) insertadas++;
      else ignoradas++; // ya existía (idempotencia)
    } catch (e) {
      errores++;
      console.error("Excepción en", r.referencia, e.message);
    }
  }

  console.log(`\nListo. Insertadas: ${insertadas} · Ya existían (ignoradas): ${ignoradas} · Errores: ${errores}`);
}

main();
