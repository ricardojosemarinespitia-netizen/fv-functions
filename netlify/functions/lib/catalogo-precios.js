// ============================================================
//  catalogo-precios  ·  FUENTE DE VERDAD DE PRECIOS (servidor)
// ------------------------------------------------------------
//  GENERADO AUTOMATICAMENTE desde sitio-felipe-vergel/products.js
//  con: node generar-catalogo.mjs
//  Fecha de generacion: 2026-07-27
//  Piezas: 36
//
//  Por que existe: el navegador manda el carrito, y el navegador es
//  territorio enemigo. El precio que llega en el body de la peticion
//  es una AFIRMACION del cliente, no un dato. El servidor firma la
//  transaccion de Wompi sobre el precio de ESTE archivo, nunca sobre
//  el que llego del navegador.
//
//  MANTENIMIENTO: cada vez que cambies un precio en products.js hay que
//  regenerar este archivo, o el checkout mostrara un total y cobrara otro.
//  El id de cada pieza (la clave) es el mismo p.id de products.js.
// ============================================================

export const CATALOGO = {
  "lampara-flor-colgante": { precio: 280000, sku: "LAM-001", nombre: "Lámpara Caribe · Pieza Coleccionable" },
  "bandeja-maxi-rect-ondas": { precio: 310000, sku: "BAN-001", nombre: "Maxi Bandeja Trama" },
  "bandeja-hoja-maxi-irregular": { precio: 260000, sku: "BAN-002", nombre: "Hoja Orgánica Midi" },
  "bandeja-hoja-midi-relieve": { precio: 190000, sku: "BAN-003", nombre: "Hoja Orgánica" },
  "bandeja-hoja-jaspeada-xl": { precio: 310000, sku: "BAN-004", nombre: "Hoja Orgánica Maxi" },
  "centro-mesa-redondo-mosaico": { precio: 190000, sku: "CEN-001", nombre: "Centro de Mesa Mosaico" },
  "centro-mesa-ovalado-franjas": { precio: 300000, sku: "CEN-002", nombre: "Centro de Mesa Oval Vetas" },
  "centro-mesa-ovalado-mosaico": { precio: 310000, sku: "CEN-003", nombre: "Centro de Mesa Oval Mosaico" },
  "centro-mesa-conico-mosaico": { precio: 300000, sku: "CEN-004", nombre: "Centro de Mesa Cónico Mosaico" },
  "centro-mesa-conico-degrade": { precio: 300000, sku: "CEN-005", nombre: "Centro de Mesa Cónico Degradé" },
  "centro-mesa-ovalado-hojas": { precio: 300000, sku: "CEN-006", nombre: "Centro de Mesa Oval Hojas" },
  "centro-mesa-conico-hojas": { precio: 300000, sku: "CEN-007", nombre: "Centro de Mesa Cónico Hojas" },
  "centro-mesa-cuadrado-mosaico": { precio: 300000, sku: "CEN-008", nombre: "Centro de Mesa Cuadrado Mosaico" },
  "centro-mesa-ovalado-liso": { precio: 280000, sku: "CEN-009", nombre: "Centro de Mesa Oval" },
  "centro-mesa-conico-franjas": { precio: 300000, sku: "CEN-010", nombre: "Centro de Mesa Cónico Vetas" },
  "florero-triptico": { precio: 160000, sku: "FLO-001", nombre: "Florero Tríptico" },
  "florero-alto-irregular": { precio: 260000, sku: "FLO-002", nombre: "Florero Alto Irregular" },
  "florero-irregular-boca-ancha": { precio: 270000, sku: "FLO-003", nombre: "Florero Ondas" },
  "florero-diptico": { precio: 50000, sku: "FLO-004", nombre: "Díptico" },
  "mini-florero": { precio: 50000, sku: "FLO-005", nombre: "Mini Florero" },
  "vaso-florero": { precio: 95000, sku: "FLO-006", nombre: "Vaso Florero" },
  "solitario-circular": { precio: 80000, sku: "SOL-001", nombre: "Solitario Circular" },
  "solitario-guitarra": { precio: 80000, sku: "SOL-002", nombre: "Solitario Guitarra" },
  "solitario-teja": { precio: 80000, sku: "SOL-003", nombre: "Solitario Teja" },
  "porta-plantas-individual": { precio: 90000, sku: "PPN-001", nombre: "Porta Plantas Individual" },
  "porta-plantas-doble": { precio: 180000, sku: "PPN-002", nombre: "Porta Plantas Doble" },
  "porta-plantas-triple": { precio: 250000, sku: "PPN-003", nombre: "Porta Plantas Triple" },
  "porta-matera": { precio: 250000, sku: "PPN-004", nombre: "Porta Matera Versátil" },
  "porta-pasabocas-doble": { precio: 160000, sku: "PED-001", nombre: "Porta Pasabocas Doble" },
  "plato-postre": { precio: 31000, sku: "VAJ-001", nombre: "Plato Postre" },
  "plato-ensalada": { precio: 41000, sku: "VAJ-002", nombre: "Plato Ensalada" },
  "plato-cena": { precio: 51000, sku: "VAJ-003", nombre: "Plato Principal" },
  "pedestal-repostero": { precio: 230000, sku: "PED-002", nombre: "Pedestal Repostero" },
  "portavasos-cuadrados": { precio: 20000, sku: "PVS-001", nombre: "Porta Vasos Vetas" },
  "centro-mesa-conico": { precio: 280000, sku: "CEN-011", nombre: "Centro de Mesa Cónico" },
  "bandeja-vetas": { precio: 280000, sku: "BAN-005", nombre: "Bandeja Vetas" }
};

// Reglas de envio — copia EXACTA de calcShipping() en customer-info.html
// y checkout.html. Si cambian alli, cambian aqui.
export function calcularEnvio(subtotal, metodo) {
  if (metodo === "bucaramanga") return 0;
  if (subtotal <= 180000) return Math.round(subtotal * 0.25);
  if (subtotal <= 310000) return Math.round(subtotal * 0.15);
  return Math.round(subtotal * 0.10);
}

// Formato del codigo del Club: FV15-XXXXXXX (15% sobre el subtotal).
export const RE_CODIGO = /^FV15-[A-Z0-9]{7}$/;
export const PCT_DESCUENTO = 0.15;

/**
 * Recalcula el total del pedido SOLO con datos del servidor.
 * @param {Array<{id:string, qty:number}>} items  ids y cantidades que manda el navegador
 * @param {string} metodoEntrega  "bucaramanga" | "domicilio"
 * @param {boolean} descuentoValido  true si el codigo se verifico contra el Club
 * @returns {{subtotal:number, descuento:number, envio:number, total:number, lineas:Array, desconocidos:Array}}
 */
export function recalcularTotal(items, metodoEntrega, descuentoValido) {
  const lineas = [];
  const desconocidos = [];
  let subtotal = 0;

  for (const it of Array.isArray(items) ? items : []) {
    const id = it && it.id;
    const pieza = id ? CATALOGO[id] : null;
    if (!pieza) { desconocidos.push(String(id)); continue; }
    // Cantidad: entero, minimo 1, tope 20 para que nadie desborde el monto.
    let qty = Math.floor(Number(it.qty));
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    if (qty > 20) qty = 20;
    subtotal += pieza.precio * qty;
    lineas.push({ id, qty, precio: pieza.precio, sku: pieza.sku, nombre: pieza.nombre });
  }

  const descuento = descuentoValido ? Math.round(subtotal * PCT_DESCUENTO) : 0;
  const subtotalConDescuento = subtotal - descuento;
  const envio = calcularEnvio(subtotalConDescuento, metodoEntrega === "bucaramanga" ? "bucaramanga" : "domicilio");
  const total = subtotalConDescuento + envio;

  return { subtotal, descuento, envio, total, lineas, desconocidos };
}
