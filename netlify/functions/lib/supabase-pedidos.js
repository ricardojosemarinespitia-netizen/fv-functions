// ============================================================
//  supabase-pedidos  ·  Registro ADICIONAL de pedidos en Supabase
// ------------------------------------------------------------
//  Este modulo NO reemplaza el registro en Google Forms (paso 6 de
//  wompi-webhook.js) — es un registro EN PARALELO, agregado como
//  respaldo mas confiable. Google Forms sigue corriendo exactamente
//  igual y no se toca.
//
//  Por que existe: hoy los pedidos se registran via un POST
//  fire-and-forget desde el navegador del cliente a Google Forms
//  (checkout.html), que ya demostro perder ventas reales (casos
//  Diego Cantor y Pilar Espana, ago-2026) cuando el navegador
//  embebido de Instagram/Facebook corta la peticion a medias. Este
//  modulo se llama en cambio desde wompi-webhook.js, que corre en
//  el servidor y no depende del navegador del cliente.
//
//  DISENO A PROPOSITO DEFENSIVO — nunca puede tumbar una venta:
//    - Si faltan SUPABASE_URL o SUPABASE_SERVICE_KEY, no hace nada
//      y no lanza. Asi, borrar esas variables en Netlify es el
//      rollback instantaneo (sin deploy) a "como si esto no existiera".
//    - Cada llamada a la API tiene timeout de 4s (AbortController).
//    - El que llama a esta funcion (wompi-webhook.js) SIEMPRE la
//      envuelve en su propio try/catch — pero por si acaso, aqui
//      tambien se atrapa cualquier error y solo se hace
//      console.error, nunca se relanza hacia afuera.
//
//  Variables de entorno requeridas en Netlify (si faltan, no pasa
//  nada — ver arriba):
//    SUPABASE_URL          -> Project URL (Supabase > Settings > API)
//    SUPABASE_SERVICE_KEY  -> service_role key (Supabase > Settings > API)
//      OJO: la service_role key ignora RLS. Nunca debe viajar al
//      navegador ni vivir en el repo del sitio estatico.
//
//  Idempotencia: pedidos.referencia es UNIQUE en la base. Si el
//  webhook se dispara dos veces para el mismo pedido, el segundo
//  intento de insert es ignorado por la base (on_conflict=referencia,
//  Prefer: resolution=ignore-duplicates) — no se duplica nada.
// ============================================================

const FETCH_TIMEOUT_MS = 4000;

async function fetchConTimeout(url, opciones) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opciones, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Registra el cliente, el pedido y sus líneas en Supabase.
// `ref` = referencia del pedido (ej. FV-1788187888658-JG258)
// `pedido` = el objeto guardado en Netlify Blobs (fullName, email, phone,
//            address, city, cart, total, subtotal, discount, etc.)
// `tx` = la transacción de Wompi tal como llegó en el evento del webhook
export async function registrarEnSupabase(ref, pedido, tx) {
  const URL_BASE = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!URL_BASE || !KEY) {
    // Sin configurar todavia (o se borró a propósito como rollback).
    // No es un error: simplemente esta funcion no hace nada.
    return { ok: false, motivo: "sin-configurar" };
  }

  const headersBase = {
    "Content-Type": "application/json",
    apikey: KEY,
    Authorization: `Bearer ${KEY}`
  };

  try {
    const cart = Array.isArray(pedido.cart) ? pedido.cart : [];
    const email = (pedido.email || "").trim().toLowerCase();

    // 1) upsert del cliente por email (crea o actualiza sus datos de contacto)
    let clienteId = null;
    if (email) {
      const rCliente = await fetchConTimeout(`${URL_BASE}/rest/v1/clientes?on_conflict=email`, {
        method: "POST",
        headers: { ...headersBase, Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify([
          {
            email,
            nombre: pedido.fullName || null,
            telefono: pedido.phone || null,
            documento: pedido.docId || null,
            ciudad: pedido.city || null,
            departamento: pedido.department || null,
            direccion: pedido.address || null,
            codigo_postal: pedido.zip || null
          }
        ])
      });
      if (rCliente.ok) {
        const filas = await rCliente.json().catch(() => []);
        clienteId = Array.isArray(filas) && filas[0] ? filas[0].id : null;
      } else {
        console.error("supabase-pedidos: upsert cliente falló", rCliente.status, await rCliente.text().catch(() => ""));
      }
    }

    // 2) insert del pedido (ignora si la referencia ya existe — idempotencia)
    const subtotal = Number(pedido.subtotal) || 0;
    const descuento = Number(pedido.discount) || 0;
    const envio = Number(pedido.shipping) || 0;
    const total = Number(pedido.total) || 0;

    const rPedido = await fetchConTimeout(`${URL_BASE}/rest/v1/pedidos?on_conflict=referencia`, {
      method: "POST",
      headers: { ...headersBase, Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([
        {
          referencia: ref,
          cliente_id: clienteId,
          cliente_nombre: pedido.fullName || null,
          cliente_email: email || null,
          cliente_telefono: pedido.phone || null,
          cliente_documento: pedido.docId || null,
          direccion: pedido.address || null,
          ciudad: pedido.city || null,
          departamento: pedido.department || null,
          codigo_postal: pedido.zip || null,
          metodo_entrega: pedido.deliveryMethod || null,
          notas: pedido.notes || null,
          subtotal,
          descuento,
          codigo_descuento: pedido.discountCode || null,
          envio,
          total,
          metodo_pago: pedido.paymentMethod || "wompi",
          estado_pago: (tx && tx.status) || "APPROVED",
          wompi_tx_id: (tx && tx.id) || null,
          wompi_status: (tx && tx.status) || null,
          origen: "webhook",
          cart_raw: cart,
          payload_raw: pedido
        }
      ])
    });

    if (!rPedido.ok) {
      console.error("supabase-pedidos: insert pedido falló", rPedido.status, await rPedido.text().catch(() => ""));
      return { ok: false, motivo: "insert-pedido-fallo" };
    }

    const filasPedido = await rPedido.json().catch(() => []);
    // Si ignore-duplicates evitó el insert (ya existía), no vienen filas —
    // en ese caso no hay nada más que hacer, el pedido ya estaba registrado.
    const pedidoId = Array.isArray(filasPedido) && filasPedido[0] ? filasPedido[0].id : null;
    if (!pedidoId) {
      return { ok: true, motivo: "ya-existia" };
    }

    // 3) insert de las líneas del pedido (una fila por producto/color)
    if (cart.length) {
      const items = cart.map((i) => ({
        pedido_id: pedidoId,
        producto_id: i.id || i.productId || null,
        sku: i.sku || null,
        nombre: i.name || "",
        color: i.color || null,
        cantidad: Number(i.qty) || 1,
        precio_unitario: Number(i.price) || 0,
        precio_linea: (Number(i.price) || 0) * (Number(i.qty) || 1)
      }));

      const rItems = await fetchConTimeout(`${URL_BASE}/rest/v1/pedidos_items`, {
        method: "POST",
        headers: { ...headersBase, Prefer: "return=minimal" },
        body: JSON.stringify(items)
      });

      if (!rItems.ok) {
        console.error("supabase-pedidos: insert items falló", rItems.status, await rItems.text().catch(() => ""));
        return { ok: false, motivo: "insert-items-fallo" };
      }
    }

    return { ok: true, motivo: "registrado" };
  } catch (e) {
    console.error("supabase-pedidos: excepción no bloqueante:", e && e.message ? e.message : e);
    return { ok: false, motivo: "excepcion", error: e && e.message };
  }
}
