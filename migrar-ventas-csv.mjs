// ============================================================
//  migrar-ventas-csv.mjs  ·  Fase 6 del plan de migracion a Supabase
// ------------------------------------------------------------
//  Importa el CSV exportado de la hoja "Ventas" (columnas: Fecha,
//  Referencia, Cliente, Email, Telefono, Productos, Cantidad,
//  Precio Unit., Subtotal, Descuento, Envio, Total, Metodo pago,
//  Metodo entrega, Ciudad, Direccion, Departamento, Codigo postal,
//  Documento, Notas) a Supabase, con origen='migracion-sheet'.
//
//  NO TOCA el Google Sheet original — solo LEE el CSV ya exportado.
//
//  Idempotente: pedidos.referencia es UNIQUE + on_conflict=referencia
//  con ignore-duplicates. Correr esto dos veces, o correrlo despues
//  de que el webhook ya haya registrado en vivo la misma referencia,
//  no duplica nada.
//
//  Uso:
//    node migrar-ventas-csv.mjs --csv "ruta.csv" --dry-run
//    node migrar-ventas-csv.mjs --csv "ruta.csv"          (real)
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

const RE_REF = /^FV-\d{10,16}-[A-Z0-9]{1,12}$/;

// "1× Florero Ondas (Gris)" / "2× Lámpara Caribe · Pieza Coleccionable (Transparente)"
function parsearLineaProducto(linea) {
  const m = linea.trim().match(/^(\d+)\s*[×xX]\s*(.+?)\s*\(([^)]+)\)\s*$/);
  if (!m) return { cantidad: 1, nombre: linea.trim(), color: null };
  return { cantidad: Number(m[1]) || 1, nombre: m[2].trim(), color: m[3].trim() };
}

// "11/06/2026 14:09:10" (DD/MM/AAAA) -> ISO
function parsearFecha(txt) {
  const m = String(txt || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y, h, mi, s] = m;
  const iso = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return isNaN(iso) ? null : iso.toISOString();
}

function numero(txt) {
  const n = Number(String(txt || "0").replace(/[^\d.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

async function main() {
  const { dryRun, csv } = parseArgs(process.argv.slice(2));
  if (!csv) {
    console.error('Uso: node migrar-ventas-csv.mjs --csv "ruta.csv" [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(csv)) {
    console.error("No existe el archivo:", csv);
    process.exit(1);
  }

  const texto = fs.readFileSync(csv, "utf8").replace(/^﻿/, "");
  const filas = parseCSV(texto);
  const headers = filas[0].map((h) => h.trim());
  const rows = filas.slice(1).filter((f) => f.some((c) => c.trim() !== ""));

  const idx = (nombre) => headers.findIndex((h) => h.toLowerCase().startsWith(nombre.toLowerCase()));
  const col = {
    fecha: idx("Fecha"), ref: idx("Referencia"), cliente: idx("Cliente"), email: idx("Email"),
    tel: idx("Tel"), productos: idx("Productos"), cantidad: idx("Cantidad"), precioUnit: idx("Precio Unit"),
    subtotal: idx("Subtotal"), descuento: idx("Descuento"), envio: idx("Env"), total: idx("Total"),
    metodoPago: idx("Método pago"), metodoEntrega: idx("Método entrega"), ciudad: idx("Ciudad"),
    direccion: idx("Direcci"), departamento: idx("Departamento"), cp: idx("Código postal"),
    doc: idx("Documento"), notas: idx("Notas")
  };

  console.log(`Columnas: ${headers.join(" | ")}`);
  console.log(`Filas de datos: ${rows.length}\n`);

  const validas = [];
  const invalidas = [];

  for (const f of rows) {
    const ref = (f[col.ref] || "").trim();
    if (!RE_REF.test(ref)) { invalidas.push(f); continue; }

    const productosTxt = f[col.productos] || "";
    const lineasProd = productosTxt.split("\n").map((l) => l.trim()).filter(Boolean).map(parsearLineaProducto);

    const subtotal = numero(f[col.subtotal]);
    const total = numero(f[col.total]);
    // Precio unitario en la hoja es por-fila (puede ser 0 si mezcla varios
    // productos distintos, ej. la venta de Monica Melendez) — cuando hay una
    // sola línea de producto, se le asigna ese precio; si hay varias, se
    // reparte el subtotal proporcional a la cantidad de cada línea.
    const totalUnidades = lineasProd.reduce((s, l) => s + l.cantidad, 0) || 1;
    const items = lineasProd.map((l) => {
      const precioUnitario = lineasProd.length === 1
        ? numero(f[col.precioUnit])
        : Math.round((subtotal / totalUnidades));
      return {
        nombre: l.nombre,
        color: l.color,
        cantidad: l.cantidad,
        precio_unitario: precioUnitario,
        precio_linea: precioUnitario * l.cantidad
      };
    });

    validas.push({
      referencia: ref,
      fecha_pedido: parsearFecha(f[col.fecha]),
      cliente_nombre: (f[col.cliente] || "").trim() || null,
      cliente_email: (f[col.email] || "").trim().toLowerCase() || null,
      cliente_telefono: (f[col.tel] || "").trim() || null,
      cliente_documento: (f[col.doc] || "").trim() || null,
      direccion: (f[col.direccion] || "").trim() || null,
      ciudad: (f[col.ciudad] || "").trim() || null,
      departamento: (f[col.departamento] || "").trim() || null,
      codigo_postal: (f[col.cp] || "").trim() || null,
      metodo_entrega: (f[col.metodoEntrega] || "").trim() || null,
      metodo_pago: (f[col.metodoPago] || "").trim() || null,
      notas: (f[col.notas] || "").trim() || null,
      subtotal,
      descuento: numero(f[col.descuento]),
      envio: numero(f[col.envio]),
      total,
      items,
      filaCSV: f
    });
  }

  console.log(`Filas válidas (referencia FV-... reconocida): ${validas.length}`);
  console.log(`Filas inválidas (se omiten): ${invalidas.length}\n`);

  if (dryRun) {
    console.log("=== MODO SIMULACION (--dry-run): no se escribe nada en Supabase ===\n");
    validas.forEach((v, i) => {
      console.log(`${i + 1}. ${v.referencia} · ${v.cliente_nombre} · ${v.cliente_email} · Total $${v.total.toLocaleString("es-CO")}`);
      v.items.forEach((it) => console.log(`     - ${it.cantidad}x ${it.nombre} (${it.color || "sin color"}) · $${it.precio_unitario.toLocaleString("es-CO")} c/u`));
    });
    if (invalidas.length) {
      console.log("\nFilas omitidas (sin referencia FV-... válida):");
      invalidas.forEach((f, i) => console.log(`  ${i + 1}.`, f.join(" | ").slice(0, 150)));
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
  const H = { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` };

  let insertadas = 0, ignoradas = 0, errores = 0;
  for (const v of validas) {
    try {
      // upsert cliente (si trae email)
      let clienteId = null;
      if (v.cliente_email) {
        const rC = await fetch(`${URL_BASE}/rest/v1/clientes?on_conflict=email`, {
          method: "POST",
          headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify([{
            email: v.cliente_email, nombre: v.cliente_nombre, telefono: v.cliente_telefono,
            documento: v.cliente_documento, ciudad: v.ciudad, departamento: v.departamento,
            direccion: v.direccion, codigo_postal: v.codigo_postal
          }])
        });
        if (rC.ok) {
          const rows2 = await rC.json().catch(() => []);
          clienteId = Array.isArray(rows2) && rows2[0] ? rows2[0].id : null;
        }
      }

      const rP = await fetch(`${URL_BASE}/rest/v1/pedidos?on_conflict=referencia`, {
        method: "POST",
        headers: { ...H, Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify([{
          referencia: v.referencia,
          cliente_id: clienteId,
          cliente_nombre: v.cliente_nombre,
          cliente_email: v.cliente_email,
          cliente_telefono: v.cliente_telefono,
          cliente_documento: v.cliente_documento,
          direccion: v.direccion,
          ciudad: v.ciudad,
          departamento: v.departamento,
          codigo_postal: v.codigo_postal,
          metodo_entrega: v.metodo_entrega,
          notas: v.notas,
          subtotal: v.subtotal,
          descuento: v.descuento,
          envio: v.envio,
          total: v.total,
          metodo_pago: v.metodo_pago,
          estado_pago: "APPROVED",
          origen: "migracion-sheet",
          payload_raw: { filaCSV: v.filaCSV },
          fecha_pedido: v.fecha_pedido || undefined
        }])
      });

      if (!rP.ok) { errores++; console.error("Error pedido", v.referencia, rP.status, await rP.text()); continue; }
      const filasRes = await rP.json().catch(() => []);
      const pedidoId = Array.isArray(filasRes) && filasRes[0] ? filasRes[0].id : null;
      if (!pedidoId) { ignoradas++; continue; } // ya existía

      if (v.items.length) {
        const items = v.items.map((it) => ({
          pedido_id: pedidoId,
          nombre: it.nombre,
          color: it.color,
          cantidad: it.cantidad,
          precio_unitario: it.precio_unitario,
          precio_linea: it.precio_linea
        }));
        const rI = await fetch(`${URL_BASE}/rest/v1/pedidos_items`, {
          method: "POST",
          headers: { ...H, Prefer: "return=minimal" },
          body: JSON.stringify(items)
        });
        if (!rI.ok) console.error("Error items", v.referencia, rI.status, await rI.text());
      }
      insertadas++;
    } catch (e) {
      errores++;
      console.error("Excepción en", v.referencia, e.message);
    }
  }

  console.log(`\nListo. Insertadas: ${insertadas} · Ya existían (ignoradas): ${ignoradas} · Errores: ${errores}`);
}

main();
