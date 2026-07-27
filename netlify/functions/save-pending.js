// ============================================================
//  save-pending  ·  Guarda un pedido como PENDIENTE en el servidor
// ------------------------------------------------------------
//  El navegador llama a esta función ANTES de mandar al cliente
//  a Wompi. Así el webhook (wompi-webhook.js) puede recuperar el
//  pedido por su referencia y registrarlo + enviar correos aunque
//  el cliente nunca dé "Volver al comercio".
//
//  También se usa para marcar un pedido como "done" cuando el
//  cliente SÍ regresa y se procesa en el navegador (evita que el
//  webhook lo duplique).
//
//  SEGURIDAD — el servidor no repite lo que le dan:
//  wompi-sign.js recalcula los importes desde el catálogo del
//  servidor, firma ESE monto y escribe aquí el pedido marcado con
//  _serverPriced. A partir de ese momento el navegador ya no puede
//  reescribir subtotal/descuento/envío/total: si se dejara pasar,
//  bastaba un POST con {ref, total: 1000} para que la hoja de ventas
//  y el correo mostraran un importe falso, y otro con
//  {ref, _status:"done"} para que el webhook contestara "Ya estaba
//  procesado" y el pedido real no se registrara nunca.
//  (Misma protección que ya tenía av-functions/save-pending.js.)
// ============================================================
import { getStore } from "@netlify/blobs";

// Importes que solo puede fijar el servidor (wompi-sign).
// OJO: "cart" NO se congela — el navegador es quien tiene el nombre, el color
// y la foto de cada pieza, y los correos los usan. Lo que sí se hace es
// corregir el precio de cada línea contra _serverLineas (ver abajo).
const CAMPOS_DE_DINERO = ["subtotal", "discountAmount", "shipping", "total", "discountCode"];

// La referencia la genera checkout.html como FV-<epoch>-<alfanumérico>.
// Rechazar cualquier otra forma evita que alguien llene el almacén de blobs
// con claves arbitrarias.
const RE_REF = /^FV-\d{10,16}-[A-Z0-9]{1,12}$/;

// Orígenes que pueden escribir pedidos desde un navegador.
// Las llamadas servidor-a-servidor (wompi-sign) no mandan Origin: se permiten.
const ORIGENES_OK = [
  "https://felipevergel.com",
  "https://www.felipevergel.com",
  "http://localhost:8888",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
];

// ── CORS ──────────────────────────────────────────────────────────────────
//  ROTURA ENCONTRADA EN VIVO (27-jul-2026): checkout.html llama aquí con
//  Content-Type: application/json desde felipevergel.com. Eso es una petición
//  "no simple", así que el navegador manda antes un preflight OPTIONS. Esta
//  función respondía 405 sin cabeceras CORS a CUALQUIER método que no fuera
//  POST, de modo que el preflight fallaba y el POST no llegaba a salir nunca.
//  Comprobado:
//    curl -X OPTIONS .../save-pending -H "Origin: https://felipevergel.com"
//      -> HTTP 405, sin Access-Control-Allow-Origin
//  Consecuencia: el pedido pendiente jamás se guardaba desde el navegador y el
//  webhook contestaba "Sin pedido pendiente" -> ni registro ni correos.
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

  if (req.method === "OPTIONS") {
    // OJO: tiene que ser `null`, no `""`. Un 204 con cuerpo es inválido según
    // la spec de Fetch y `new Response("", {status:204})` LANZA un TypeError,
    // lo que convertiría cada preflight en un 502 y dejaría el checkout peor
    // que antes. Comprobado con node --check + prueba unitaria.
    return new Response(null, { status: 204, headers: H });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: H });
  }

  if (origen && !ORIGENES_OK.includes(origen)) {
    console.warn("save-pending: origen no autorizado:", origen);
    return new Response("Origen no autorizado", { status: 403, headers: H });
  }

  let order;
  try {
    order = await req.json();
  } catch {
    return new Response("JSON inválido", { status: 400, headers: H });
  }

  if (!order || !order.ref) {
    return new Response("Falta la referencia (ref)", { status: 400, headers: H });
  }

  if (!RE_REF.test(String(order.ref))) {
    return new Response("Referencia con formato inválido", { status: 400, headers: H });
  }

  const store = getStore("pedidos");

  // Si ya existe, conservamos los datos previos y solo actualizamos el estado
  // (por ejemplo cuando el cliente marca el pedido como "done").
  let previo = null;
  try { previo = await store.get(order.ref, { type: "json", consistency: "strong" }); } catch {}

  // No se puede crear un pedido ya "done" de la nada: eso serviría solo para
  // que el webhook ignorara un pago real. El flujo legítimo siempre escribe
  // primero el pedido pendiente y solo después lo marca como procesado.
  if (!previo && order._status === "done") {
    console.warn("save-pending: intento de crear un pedido 'done' inexistente:", order.ref);
    return new Response("No hay pedido pendiente con esa referencia", { status: 409, headers: H });
  }

  const entrante = { ...order };

  // Importes congelados: si wompi-sign ya fijó los precios, el navegador
  // no los puede cambiar.
  if (previo && previo._serverPriced) {
    for (const campo of CAMPOS_DE_DINERO) delete entrante[campo];
    delete entrante._serverPriced;
    delete entrante._serverLineas;

    // El carrito sí se acepta (nombre, color, imagen vienen del navegador),
    // pero el precio de cada línea se corrige con el del catálogo para que el
    // correo y la hoja no muestren unos precios y se cobre otro.
    const lineas = Array.isArray(previo._serverLineas) ? previo._serverLineas : [];
    if (lineas.length && Array.isArray(entrante.cart)) {
      const porId = new Map(lineas.map((l) => [String(l.id), l]));
      entrante.cart = entrante.cart.map((i) => {
        const l = porId.get(String(i && i.id));
        return l ? { ...i, price: l.precio, qty: l.qty, sku: l.sku || i.sku } : i;
      });
    }
  }

  const registro = {
    ...(previo || {}),
    ...entrante,
    // Un pedido ya procesado ("done") no vuelve a "pending".
    _status: (previo && previo._status === "done")
      ? "done"
      : (order._status || (previo && previo._status) || "pending"),
    _serverPriced: (previo && previo._serverPriced) || false,
    _savedAt: Date.now()
  };

  await store.setJSON(order.ref, registro);

  return new Response(JSON.stringify({ ok: true, ref: order.ref, status: registro._status }), {
    headers: H
  });
};
