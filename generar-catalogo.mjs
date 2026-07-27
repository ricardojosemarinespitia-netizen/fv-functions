// ============================================================
//  generar-catalogo.mjs
// ------------------------------------------------------------
//  Regenera netlify/functions/lib/catalogo-precios.js a partir del
//  catalogo real del sitio (sitio-felipe-vergel/products.js).
//
//  CUANDO CORRERLO: cada vez que cambies un precio, agregues o
//  quites una pieza en products.js. Si no lo corres, el sitio
//  mostrara un total y el servidor firmara otro.
//
//  Uso (desde la carpeta fv-functions):
//     node generar-catalogo.mjs
//     node generar-catalogo.mjs "ruta/a/products.js"   (opcional)
// ============================================================
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

// Se buscan varias ubicaciones porque esta carpeta ha vivido en dos sitios:
//   - antes:  COWORK GENERAL/fv-functions        -> products.js en ../sitio-felipe-vergel/
//   - ahora:  sitio-felipe-vergel/fv-functions   -> products.js en ../
// Con la ruta unica de antes, el script moria con "No encuentro products.js"
// y el catalogo de precios del servidor se quedaba desactualizado en silencio.
const CANDIDATOS = [
  path.resolve(AQUI, '..', 'products.js'),                        // fv-functions dentro del sitio
  path.resolve(AQUI, '..', 'sitio-felipe-vergel', 'products.js'), // fv-functions en la raiz del workspace
  path.resolve(AQUI, '..', '..', 'sitio-felipe-vergel', 'products.js')
];

const SRC = process.argv[2] || CANDIDATOS.find((p) => fs.existsSync(p)) || CANDIDATOS[0];
const OUT = path.resolve(AQUI, 'netlify', 'functions', 'lib', 'catalogo-precios.js');

if (!fs.existsSync(SRC)) {
  console.error('No encuentro products.js. Rutas probadas:');
  for (const p of CANDIDATOS) console.error('  -', p);
  console.error('Pasa la ruta como argumento: node generar-catalogo.mjs "C:/.../products.js"');
  process.exit(1);
}
console.log('Leyendo catalogo de:', SRC);

const codigo = fs.readFileSync(SRC, 'utf8');
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(codigo + '\n;globalThis.__P = PRODUCTS;', ctx);
const productos = ctx.__P;

const lineas = productos.map((p) =>
  `  ${JSON.stringify(p.id)}: { precio: ${p.price}, sku: ${JSON.stringify(p.sku || '')}, nombre: ${JSON.stringify(p.name)} }`
);

const salida = `// ============================================================
//  catalogo-precios  ·  FUENTE DE VERDAD DE PRECIOS (servidor)
// ------------------------------------------------------------
//  GENERADO AUTOMATICAMENTE desde sitio-felipe-vergel/products.js
//  con: node generar-catalogo.mjs
//  Fecha de generacion: ${new Date().toISOString().slice(0, 10)}
//  Piezas: ${productos.length}
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
${lineas.join(',\n')}
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
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, salida, 'utf8');
console.log('OK ->', OUT, '·', productos.length, 'piezas');
