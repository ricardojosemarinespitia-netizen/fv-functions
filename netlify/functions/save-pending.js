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
// ============================================================
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let order;
  try {
    order = await req.json();
  } catch {
    return new Response("JSON inválido", { status: 400 });
  }

  if (!order || !order.ref) {
    return new Response("Falta la referencia (ref)", { status: 400 });
  }

  const store = getStore("pedidos");

  // Si ya existe, conservamos los datos previos y solo actualizamos el estado
  // (por ejemplo cuando el cliente marca el pedido como "done").
  let previo = null;
  try { previo = await store.get(order.ref, { type: "json" }); } catch {}

  const registro = {
    ...(previo || {}),
    ...order,
    _status: order._status || (previo && previo._status) || "pending",
    _savedAt: Date.now()
  };

  await store.setJSON(order.ref, registro);

  return new Response(JSON.stringify({ ok: true, ref: order.ref, status: registro._status }), {
    headers: { "Content-Type": "application/json" }
  });
};
