// ============================================================
//  ventas-registrar  ·  Proxy servidor para escribir en la hoja de Ventas
// ------------------------------------------------------------
//  Antes: checkout.html llamaba DIRECTO al Apps Script de Ventas desde
//  el navegador, mandando VENTAS_KEY en el body. Cualquiera con "ver
//  código fuente" se llevaba la clave y podía inyectar ventas falsas o
//  marcar cupones como usados sin haber comprado nada.
//
//  Ahora: el navegador llama a ESTA función (sin ninguna clave). El
//  servidor agrega VENTAS_KEY antes de reenviar al Apps Script. La
//  clave ya no viaja nunca al navegador.
//
//  Dos acciones, igual que antes:
//    { action:"registrar", ...datosDelPedido }   -> nueva fila en Ventas
//    { action:"markUsed", code, ref, email }     -> marca un cupón usado
// ============================================================
// Misma URL que checkout.html llamaba directo (AKfycbz9BVbko...). Es la
// implementacion "Ventas" del proyecto Apps Script "PAGINA WEB" — distinta
// deployment de la que usan wompi-sign/wompi-webhook (AKfycbznN..., la que
// ademas expone checkCode/markUsed), pero mismo Codigo.gs y misma hoja.
const VENTAS_API = "https://script.google.com/macros/s/AKfycbz9BVbko_lCUMGsSHmSTn8Pu3Kd9L3LFSB6uhaqQZNn6Qi7iK4Hs5bcD3GoR6EBwYc8Jw/exec";
// Mismo secreto que ya usaban checkout.html y wompi-webhook.js. Ahora solo
// vive en código de servidor (nunca se sirve al navegador).
const VENTAS_KEY = "Pjh5zFh5RhYW";

const ORIGENES_OK = [
  "https://felipevergel.com",
  "https://www.felipevergel.com",
  "http://localhost:8888",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
];

const RE_REF = /^FV-\d{10,16}-[A-Z0-9]{1,12}$/;

function cabeceras(origen) {
  const permitido = ORIGENES_OK.includes(origen) ? origen : ORIGENES_OK[0];
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": permitido,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  };
}

export default async (req) => {
  const origen = req.headers.get("origin") || "";
  const H = cabeceras(origen);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "metodo-no-permitido" }), { status: 405, headers: H });
  }
  if (origen && !ORIGENES_OK.includes(origen)) {
    console.warn("ventas-registrar: origen no autorizado:", origen);
    return new Response(JSON.stringify({ ok: false, error: "origen-no-autorizado" }), { status: 403, headers: H });
  }

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: "json-invalido" }), { status: 400, headers: H });
  }

  const ref = String((body && body.ref) || "");
  if (!RE_REF.test(ref)) {
    return new Response(JSON.stringify({ ok: false, error: "referencia-invalida" }), { status: 400, headers: H });
  }

  // No confiamos en ningun "key" que venga del navegador: siempre se
  // sobreescribe con el secreto del servidor.
  const payload = { ...body, key: VENTAS_KEY };
  delete payload.origin; // por si acaso

  try {
    await fetch(VENTAS_API, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error("ventas-registrar: fallo al reenviar a Apps Script:", e.message);
    // No bloqueamos al cliente por esto: el pedido ya esta confirmado por
    // Wompi o ya se le mostro la pantalla de WhatsApp. Se pierde solo el
    // registro en la hoja, no la venta.
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: H });
};
