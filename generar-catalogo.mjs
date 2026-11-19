// ============================================================
//  generar-catalogo.mjs
// ------------------------------------------------------------
//  Regenera netlify/functions/lib/catalogo-datos.js a partir del
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
const OUT = path.resolve(AQUI, 'netlify', 'functions', 'lib', 'catalogo-datos.js');

if (!fs.existsSync(SRC)) {
  console.error('No encuentro products.js. Rutas probadas:');
  for (const p of CANDIDATOS) console.error('  -', p);
  console.error('Pasa la ruta como argumento: node generar-catalogo.mjs "C:/.../products.js"');
  process.exit(1);
}
console.log('Leyendo catalogo de:', SRC);

const codigo = fs.readFileSync(SRC, 'utf8');
const ctx = { console };
// products.js define window.FV_BF (Black Friday): en el vm, window = el contexto.
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(codigo + '\n;globalThis.__P = PRODUCTS;', ctx);
const productos = ctx.__P;

const lineas = productos.map((p) =>
  `  ${JSON.stringify(p.id)}: { precio: ${p.price}, sku: ${JSON.stringify(p.sku || '')}, nombre: ${JSON.stringify(p.name)} }`
);

const salida = `// ============================================================
//  catalogo-datos  ·  PRECIOS DE LISTA (servidor) · GENERADO
// ------------------------------------------------------------
//  GENERADO AUTOMATICAMENTE desde sitio-felipe-vergel/products.js
//  con: node generar-catalogo.mjs      NO EDITAR A MANO.
//  Fecha de generacion: ${new Date().toISOString().slice(0, 10)}
//  Piezas: ${productos.length}
//
//  Solo datos. La logica (Black Friday, envio, codigo del Club) vive en
//  lib/catalogo-precios.js, que NO se regenera: asi regenerar el catalogo
//  nunca borra las reglas de precio.
//  "precio" es el precio de LISTA (p.price). El precio final de campana se
//  calcula en catalogo-precios.js con la misma formula que products.js.
// ============================================================

export const CATALOGO = {
${lineas.join(',\n')}
};

// Interruptor del sitio (window.FV_BF de products.js) en el momento de
// generar. Solo lo usan las pruebas para avisar si cliente y servidor
// quedaron con un % distinto. El cobro NO lo lee: manda PCT_BLACK_FRIDAY.
export const FV_BF_SITIO = ${JSON.stringify(ctx.FV_BF || null)};
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, salida, 'utf8');
console.log('OK ->', OUT, '·', productos.length, 'piezas');
