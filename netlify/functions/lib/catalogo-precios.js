// ============================================================
//  catalogo-precios  ·  REGLAS DE PRECIO DEL SERVIDOR (a mano)
// ------------------------------------------------------------
//  Los precios de LISTA vienen de lib/catalogo-datos.js, que se
//  regenera con `node generar-catalogo.mjs` desde products.js.
//  Este archivo NO se regenera: aqui viven las reglas (Black Friday,
//  envio, codigo del Club) para que regenerar el catalogo no las borre.
//
//  Por que existe: el navegador manda el carrito, y el navegador es
//  territorio enemigo. El precio que llega en el body de la peticion
//  es una AFIRMACION del cliente, no un dato. El servidor firma la
//  transaccion de Wompi sobre el precio calculado AQUI.
// ============================================================
import { CATALOGO } from "./catalogo-datos.js";

export { CATALOGO };

// ── BLACK FRIDAY ────────────────────────────────────────────
//  Espejo EXACTO de window.FV_BF / fvPrecioFinal() en products.js.
//  Si cambias el % aqui, cambialo alli (y al reves). Las pruebas
//  (pruebas/precios.test.mjs) fallan si no coinciden.
//
//  Variables de entorno en Netlify (opcionales):
//    BLACK_FRIDAY_ACTIVO = "1" | "0"    sin definir -> BF_ACTIVO_POR_DEFECTO
//    BLACK_FRIDAY_HASTA  = ISO 8601     sin definir -> BF_HASTA (null = sin fin)
//  El % NO va por variable a proposito: tiene que ser el mismo numero
//  que products.js, y una variable olvidada en Netlify lo romperia.
export const PCT_BLACK_FRIDAY = 15;
export const BF_ACTIVO_POR_DEFECTO = true;
export const BF_HASTA = null;            // no se inventa fecha de fin
export const BF_ACUMULA_CODIGO = false;  // FV15 no se suma durante la campana (PENDIENTE Ricardo)

const SI = ["1", "true", "si", "sí", "on", "yes"];

export function configBlackFriday(env = (typeof process !== "undefined" ? process.env : {}), ahora = Date.now()) {
  const v = String(env.BLACK_FRIDAY_ACTIVO == null ? "" : env.BLACK_FRIDAY_ACTIVO).trim().toLowerCase();
  let activo = v === "" ? BF_ACTIVO_POR_DEFECTO : SI.includes(v);
  const hasta = env.BLACK_FRIDAY_HASTA || BF_HASTA;
  if (activo && hasta) {
    const t = Date.parse(hasta);
    if (!Number.isNaN(t) && ahora >= t) activo = false;
  }
  return { activo, pct: activo ? PCT_BLACK_FRIDAY : 0, acumulaCodigo: BF_ACUMULA_CODIGO, hasta: hasta || null };
}

// Precio final de UNA unidad. Misma formula que products.js:
//   final = Math.round(lista * (100 - pct) / 1000) * 10
// -> COP entero, multiplo de 10. Con precios multiplos de $1.000 y pct 15
//    es exacto (lista x 0,85).
export function precioFinal(lista, pct) {
  lista = Math.round(Number(lista) || 0);
  if (!(pct > 0) || lista <= 0) return lista;
  return Math.round(lista * (100 - pct) / 1000) * 10;
}

// Reglas de envio — copia EXACTA de calcShipping() en customer-info.html,
// checkout.html y fvEnvio() de products.js. Se aplica sobre el subtotal YA
// con descuentos.
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
 * @param {boolean} descuentoValido  true si el codigo del Club se verifico (y puede aplicarse)
 * @param {{activo:boolean,pct:number,acumulaCodigo:boolean}} [bf]  config de Black Friday
 * @returns {{subtotalLista:number, descuentoBF:number, subtotal:number, descuento:number,
 *            envio:number, total:number, lineas:Array, desconocidos:Array, blackFriday:object}}
 *
 *  subtotal      = suma(precio FINAL x qty)   (ya con Black Friday)
 *  descuento     = codigo del Club sobre ese subtotal (0 si BF no acumula)
 *  envio         = sobre (subtotal - descuento)
 *  total         = subtotal - descuento + envio
 *  subtotalLista / descuentoBF son informativos (subtotalLista - descuentoBF = subtotal).
 */
export function recalcularTotal(items, metodoEntrega, descuentoValido, bf = configBlackFriday()) {
  const pct = bf && bf.activo ? bf.pct : 0;
  const lineas = [];
  const desconocidos = [];
  let subtotalLista = 0;
  let subtotal = 0;

  for (const it of Array.isArray(items) ? items : []) {
    const id = it && it.id;
    const pieza = id ? CATALOGO[id] : null;
    if (!pieza) { desconocidos.push(String(id)); continue; }
    // Cantidad: entero, minimo 1, tope 20 para que nadie desborde el monto.
    let qty = Math.floor(Number(it.qty));
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    if (qty > 20) qty = 20;
    const final = precioFinal(pieza.precio, pct);
    subtotalLista += pieza.precio * qty;
    subtotal += final * qty;
    // "precio" = lo que se cobra por unidad (save-pending lo pone en cart[].price).
    lineas.push({ id, qty, precio: final, precioLista: pieza.precio, sku: pieza.sku, nombre: pieza.nombre });
  }

  const codigoAplica = !!descuentoValido && !(pct > 0 && bf && bf.acumulaCodigo === false);
  const descuento = codigoAplica ? Math.round(subtotal * PCT_DESCUENTO) : 0;
  const subtotalConDescuento = subtotal - descuento;
  const envio = calcularEnvio(subtotalConDescuento, metodoEntrega === "bucaramanga" ? "bucaramanga" : "domicilio");
  const total = subtotalConDescuento + envio;

  return {
    subtotalLista,
    descuentoBF: subtotalLista - subtotal,
    subtotal,
    descuento,
    envio,
    total,
    lineas,
    desconocidos,
    blackFriday: { activo: pct > 0, pct, acumulaCodigo: bf ? bf.acumulaCodigo : true }
  };
}
