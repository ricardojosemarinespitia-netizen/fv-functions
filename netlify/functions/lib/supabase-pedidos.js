// ============================================================
//  supabase-pedidos  ·  Registro de pedidos en Supabase (fuente de verdad)
// ------------------------------------------------------------
//  Desde nov-2026 Supabase es LA base de datos del sitio (antes era un
//  registro adicional a Google Forms). La llaman:
//    - wompi-webhook.js   pagos por Wompi aprobados (origen "webhook")
//    - ventas-registrar.js pedidos por WhatsApp     (origen "whatsapp",
//                          estado_pago "PENDIENTE": Felipe confirma el pago)
//
//  Qué escribe, en este orden:
//    1. clientes        upsert por email (datos de contacto al día)
//    2. pedidos         insert por referencia (UNIQUE): si ya existía, no se
//                       toca (el service_role NO tiene UPDATE en pedidos, a
//                       propósito: los pedidos son de solo agregar)
//    3. pedidos_items   una fila por pieza, solo si el pedido es nuevo
//    4. suscriptores    el correo del comprador con origen "compra" si no
//                       estaba (no pisa a quien ya está en el Círculo)
//
//  DISEÑO DEFENSIVO — nunca puede tumbar una venta:
//    - Sin SUPABASE_URL / SUPABASE_SERVICE_KEY no hace nada (motivo
//      "sin-configurar") y el que llama usa su respaldo (Google Forms en el
//      webhook, la hoja en ventas-registrar).
//    - Timeout de 4 s y un reintento corto por llamada (lib/supabase-rest.js).
//    - Nunca lanza: devuelve {ok, motivo}.
// ============================================================
import { sbFetch, configSupabase } from "./supabase-rest.js";
import { guardarSuscriptor } from "./vip.js";

/**
 * @param {string} ref   referencia FV-<epoch>-<sufijo>
 * @param {object} pedido  el objeto del pedido (fullName, email, phone, address, city,
 *                         department, zipCode, cart, subtotal, discountAmount, shipping,
 *                         total, discountCode, deliveryMethod, paymentMethod, notes…)
 * @param {object|null} tx   transacción de Wompi (webhook) o null
 * @param {{origen?, estado?, db?, fetchFn?}} opts
 * @returns {Promise<{ok:boolean, motivo:string, error?:string}>}
 */
export async function registrarEnSupabase(ref, pedido, tx, opts = {}) {
  const db = opts.db !== undefined ? opts.db : configSupabase();
  if (!db) return { ok: false, motivo: "sin-configurar" };
  const fetchFn = opts.fetchFn;

  try {
    const cart = Array.isArray(pedido.cart) ? pedido.cart : [];
    const email = String(pedido.email || "").trim().toLowerCase();
    const cp = pedido.zipCode || pedido.zip || null;

    // 1) cliente
    let clienteId = null;
    if (email) {
      const rc = await sbFetch(db, "/rest/v1/clientes?on_conflict=email", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=representation",
        body: [{
          email,
          nombre: pedido.fullName || null,
          telefono: pedido.phone || null,
          documento: pedido.docId || null,
          ciudad: pedido.city || null,
          departamento: pedido.department || null,
          direccion: pedido.address || null,
          codigo_postal: cp
        }],
        fetchFn
      });
      if (rc.ok) clienteId = Array.isArray(rc.datos) && rc.datos[0] ? rc.datos[0].id : null;
      else console.error("supabase-pedidos: upsert cliente falló", rc.status, rc.error);
    }

    // 2) pedido
    // Antes leia pedido.discount, campo que ningun flujo escribe (el pedido trae
    // discountAmount). Con Black Friday, "subtotal" ya viene con precios finales;
    // el ahorro de la campana (descuentoBF/subtotalLista/bfPct) queda en payload_raw.
    const rp = await sbFetch(db, "/rest/v1/pedidos?on_conflict=referencia", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=representation",
      body: [{
        referencia: ref,
        cliente_id: clienteId,
        cliente_nombre: pedido.fullName || null,
        cliente_email: email || null,
        cliente_telefono: pedido.phone || null,
        cliente_documento: pedido.docId || null,
        direccion: pedido.address || null,
        ciudad: pedido.city || null,
        departamento: pedido.department || null,
        codigo_postal: cp,
        metodo_entrega: pedido.deliveryMethod || null,
        notas: pedido.notes || null,
        subtotal: Number(pedido.subtotal) || 0,
        descuento: Number(pedido.discountAmount != null ? pedido.discountAmount : pedido.discount) || 0,
        codigo_descuento: pedido.discountCode || null,
        envio: Number(pedido.shipping) || 0,
        total: Number(pedido.total) || 0,
        metodo_pago: pedido.paymentMethod || "wompi",
        estado_pago: opts.estado || (tx && tx.status) || "APPROVED",
        wompi_tx_id: (tx && tx.id) || null,
        wompi_status: (tx && tx.status) || null,
        origen: opts.origen || "webhook",
        cart_raw: cart,
        payload_raw: pedido
      }],
      fetchFn
    });
    if (!rp.ok) {
      console.error("supabase-pedidos: insert pedido falló", rp.status, rp.error);
      return { ok: false, motivo: "insert-pedido-fallo", error: rp.error };
    }
    // Con ignore-duplicates, si la referencia ya existía no vuelven filas.
    const pedidoId = Array.isArray(rp.datos) && rp.datos[0] ? rp.datos[0].id : null;

    // 3) líneas (solo para un pedido nuevo: así un reintento no las duplica)
    if (pedidoId && cart.length) {
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
      const ri = await sbFetch(db, "/rest/v1/pedidos_items", { method: "POST", prefer: "return=minimal", body: items, fetchFn });
      if (!ri.ok) {
        console.error("supabase-pedidos: insert items falló", ri.status, ri.error);
        return { ok: false, motivo: "insert-items-fallo", error: ri.error };
      }
    }

    // 4) suscriptor "compra" (mejor esfuerzo: no cambia el resultado)
    if (email) {
      const gs = await guardarSuscriptor(db, { email, nombre: pedido.fullName || null, origen: "compra" }, { fetchFn });
      if (!gs.ok) console.error("supabase-pedidos: suscriptor compra no guardado", email, gs.error);
    }

    return { ok: true, motivo: pedidoId ? "registrado" : "ya-existia" };
  } catch (e) {
    console.error("supabase-pedidos: excepción no bloqueante:", e && e.message ? e.message : e);
    return { ok: false, motivo: "excepcion", error: e && e.message };
  }
}
