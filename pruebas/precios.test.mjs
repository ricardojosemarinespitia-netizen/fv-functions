// ============================================================
//  Pruebas cliente = servidor (Black Friday, envio, codigo del Club)
//  Uso (desde fv-functions):  node pruebas/precios.test.mjs [ruta/products.js] [ruta/sitio]
//  Sin dependencias: node:assert + node:vm.
//  CLIENTE: products.js real (fvPrecio, fvNormalizarCarrito, fvTotalesCarrito)
//           + calcShipping() copiado TAL CUAL de customer-info.html y checkout.html.
//  SERVIDOR: recalcularTotal() de lib/catalogo-precios.js (lo que firma wompi-sign).
// ============================================================
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recalcularTotal, configBlackFriday, precioFinal, PCT_BLACK_FRIDAY, BF_ACUMULA_CODIGO, CATALOGO } from "../netlify/functions/lib/catalogo-precios.js";
import { FV_BF_SITIO } from "../netlify/functions/lib/catalogo-datos.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SITIO = process.argv[3] || path.resolve(AQUI, "..", "..", "..");
const PRODUCTS_JS = process.argv[2] || path.join(SITIO, "products.js");

// ---------- CLIENTE ----------
function cargarCliente(bfOverride) {
  const ctx = { console, Date };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(PRODUCTS_JS, "utf8") + "\n;globalThis.PRODUCTS=PRODUCTS;", ctx);
  if (bfOverride) Object.assign(ctx.FV_BF, bfOverride);
  // calcShipping de las dos paginas, extraido del HTML real.
  for (const [pagina, nombre] of [["customer-info.html", "envioCI"], ["checkout.html", "envioCO"]]) {
    const html = fs.readFileSync(path.join(SITIO, pagina), "utf8");
    const m = html.match(/function calcShipping\(subtotal,method\)\{[\s\S]*?\n\}/);
    assert.ok(m, "no encontre calcShipping en " + pagina);
    vm.runInContext(m[0].replace("function calcShipping", "globalThis." + nombre + "=function"), ctx);
  }
  return ctx;
}
// Replica el calculo de renderSummary() de customer-info.html / checkout.html.
function totalCliente(c, cart, metodo, codigoValido) {
  cart = c.fvNormalizarCarrito(JSON.parse(JSON.stringify(cart)));
  const tot = c.fvTotalesCarrito(cart);
  const bfSinCodigo = c.fvBFActivo() && !c.FV_BF.acumulaCodigo;
  const subtotal = tot.final;
  const descuento = (codigoValido && !bfSinCodigo) ? Math.round(subtotal * 0.15) : 0;
  const envioCI = c.envioCI(subtotal - descuento, metodo);
  const envioCO = c.envioCO(subtotal - descuento, metodo);
  assert.equal(envioCI, envioCO, "customer-info y checkout calculan distinto envio");
  assert.equal(envioCI, c.fvEnvio(subtotal - descuento, metodo), "fvEnvio distinto de calcShipping");
  return { subtotalLista: tot.lista, descuentoBF: tot.ahorro, subtotal, descuento, envio: envioCI, total: subtotal - descuento + envioCI };
}
function totalServidor(cart, metodo, codigoValido, bf) {
  const r = recalcularTotal(cart.map((i) => ({ id: i.id, qty: i.qty })), metodo, codigoValido, bf);
  assert.deepEqual(r.desconocidos, [], "piezas desconocidas en el servidor: " + r.desconocidos);
  return { subtotalLista: r.subtotalLista, descuentoBF: r.descuentoBF, subtotal: r.subtotal, descuento: r.descuento, envio: r.envio, total: r.total };
}

let n = 0;
const filas = [];
function caso(nombre, cart, metodo, codigo, modo) {
  const on = modo !== "off";
  const c = cargarCliente(on ? null : { activo: false });
  const bf = configBlackFriday(on ? { BLACK_FRIDAY_ACTIVO: "1" } : { BLACK_FRIDAY_ACTIVO: "0" });
  const cli = totalCliente(c, cart, metodo, codigo);
  const srv = totalServidor(cart, metodo, codigo, bf);
  assert.deepEqual(cli, srv, nombre + ": cliente != servidor\n cli " + JSON.stringify(cli) + "\n srv " + JSON.stringify(srv));
  assert.ok(Number.isInteger(srv.total), "monto no entero");
  n++;
  filas.push({ caso: nombre, modo: on ? "BF on" : "BF off", entrega: metodo, codigo: codigo ? "FV15" : "-", lista: srv.subtotalLista, ahorroBF: srv.descuentoBF, subtotal: srv.subtotal, descCodigo: srv.descuento, envio: srv.envio, total: srv.total });
  return srv;
}

// 0. Paridad de configuracion y catalogo
assert.equal(FV_BF_SITIO.pct, PCT_BLACK_FRIDAY, "products.js y el servidor tienen distinto %");
assert.equal(FV_BF_SITIO.acumulaCodigo, BF_ACUMULA_CODIGO, "acumulaCodigo distinto");
{
  const c = cargarCliente();
  assert.equal(c.PRODUCTS.length, Object.keys(CATALOGO).length, "catalogo del servidor desactualizado: corre node generar-catalogo.mjs");
  for (const p of c.PRODUCTS) {
    assert.ok(CATALOGO[p.id], "falta en servidor: " + p.id);
    assert.equal(CATALOGO[p.id].precio, p.price, "precio de lista distinto: " + p.id);
    const f = c.fvPrecio(p).final;
    assert.equal(f, precioFinal(p.price, 15), "precio final distinto: " + p.id);
    assert.equal(f % 10, 0, "no es multiplo de 10: " + p.id);
    assert.equal(f, p.price * 0.85, "redondeo movio el precio: " + p.id);
  }
  n++;
}

const P = (id, qty = 1) => ({ key: id + "::x", id, qty, price: CATALOGO[id].precio, name: id, color: "x" });

// 1. Una pieza
caso("1 pieza (Lampara Caribe Brisa)", [P("lampara-caribe-brisa")], "domicilio", false);
// 2. Varias piezas y cantidades
caso("varias piezas", [P("lampara-caribe-brisa", 2), P("plato-postre", 6), P("candelabro-arco", 3)], "domicilio", false);
caso("pieza cara (Triada)", [P("lampara-triada")], "domicilio", false);
// 3. Con y sin codigo del Club
caso("con codigo, BF on (no se suma)", [P("lampara-caribe-brisa")], "domicilio", true);
caso("con codigo, BF off (si resta 15 %)", [P("lampara-caribe-brisa")], "domicilio", true, "off");
caso("sin codigo, BF off", [P("lampara-caribe-brisa")], "domicilio", false, "off");
// 4. Bucaramanga gratis
caso("Bucaramanga gratis", [P("centro-mesa-marea", 2)], "bucaramanga", false);
caso("Bucaramanga gratis + codigo BF off", [P("centro-mesa-marea")], "bucaramanga", true, "off");

// 5. Bordes del envio sobre el subtotal YA descontado.
{
  const c = cargarCliente();
  const finales = c.PRODUCTS.map((p) => ({ id: p.id, f: c.fvPrecio(p).final }));
  function buscar(objetivo, mayorQue) {
    let mejor = null;
    for (const a of finales) for (let qa = 1; qa <= 12; qa++) {
      const s1 = a.f * qa;
      if (mayorQue ? (s1 > objetivo && (!mejor || s1 < mejor.s)) : s1 === objetivo) { mejor = { s: s1, cart: [P(a.id, qa)] }; if (!mayorQue) return mejor; }
      for (const b of finales) for (let qb = 1; qb <= 6; qb++) {
        if (b.id === a.id) continue;
        const s = s1 + b.f * qb;
        if (mayorQue ? (s > objetivo && (!mejor || s < mejor.s)) : s === objetivo) { mejor = { s, cart: [P(a.id, qa), P(b.id, qb)] }; if (!mayorQue) return mejor; }
      }
    }
    return mejor;
  }
  for (const borde of [180000, 310000]) {
    const exacto = buscar(borde, false);
    const encima = buscar(borde, true);
    if (exacto) {
      const r = caso("borde " + borde + " exacto (BF on)", exacto.cart, "domicilio", false);
      assert.equal(r.subtotal, borde);
      assert.equal(r.envio, Math.round(borde * (borde === 180000 ? 0.25 : 0.15)), "tramo mal aplicado en el borde");
    } else {
      // Con pct 15 y precios multiplos de $1.000 todo final es multiplo de $850:
      // 180.000 y 310.000 no son alcanzables. Se prueba el carrito real mas
      // cercano por DEBAJO (tramo inferior) y por encima (abajo).
      let deb = null;
      for (const a of finales) for (let qa = 1; qa <= 12; qa++) for (const b of finales) for (let qb = 0; qb <= 6; qb++) {
        if (qb && b.id === a.id) continue;
        const s = a.f * qa + b.f * qb;
        if (s <= borde && (!deb || s > deb.s)) deb = { s, cart: qb ? [P(a.id, qa), P(b.id, qb)] : [P(a.id, qa)] };
      }
      const r = caso("borde " + borde + " -" + (borde - deb.s) + " (BF on)", deb.cart, "domicilio", false);
      assert.equal(r.envio, Math.round(r.subtotal * (borde === 180000 ? 0.25 : 0.15)), "tramo mal aplicado bajo el borde");
    }
    const r2 = caso("borde " + borde + " +" + (encima.s - borde) + " (BF on)", encima.cart, "domicilio", false);
    assert.equal(r2.envio, Math.round(r2.subtotal * (borde === 180000 ? 0.15 : 0.10)), "no salto de tramo por encima del borde");
  }
  // BF off: bordes exactos con precios de lista (2 x 90.000 = 180.000; 310.000).
  caso("borde 180000 exacto (BF off)", [P("solitario-circular", 2)], "domicilio", false, "off");
  caso("borde 310000 exacto (BF off)", [P("bandeja-hoja-maxi-irregular")], "domicilio", false, "off");
  // Lista 310.000 con BF on cae a 263.500: el tramo lo pone el subtotal descontado.
  const r3 = caso("lista 310000 -> final 263500 (BF on)", [P("bandeja-hoja-maxi-irregular")], "domicilio", false);
  assert.equal(r3.envio, Math.round(263500 * 0.15));
  // Codigo con BF off que baja 2 x 108.000 = 216.000 a 183.600: tramo 15 %.
  caso("codigo baja de tramo (BF off)", [P("porta-plantas-individual", 2)], "domicilio", true, "off");
}

// 5b. Envio por funcion en los bordes exactos (subtotal arbitrario):
//     calcShipping de las dos paginas = fvEnvio = calcularEnvio del servidor.
{
  const c = cargarCliente();
  const { calcularEnvio } = await import("../netlify/functions/lib/catalogo-precios.js");
  for (const s of [0, 10, 179990, 180000, 180010, 309990, 310000, 310010, 1674500]) for (const m of ["domicilio", "bucaramanga"]) {
    const esperado = m === "bucaramanga" ? 0 : Math.round(s * (s <= 180000 ? 0.25 : s <= 310000 ? 0.15 : 0.10));
    assert.equal(calcularEnvio(s, m), esperado, "servidor " + s + " " + m);
    assert.equal(c.envioCI(s, m), esperado, "customer-info " + s + " " + m);
    assert.equal(c.envioCO(s, m), esperado, "checkout " + s + " " + m);
    assert.equal(c.fvEnvio(s, m), esperado, "products.js " + s + " " + m);
  }
  assert.equal(calcularEnvio(180000, "domicilio"), 45000);
  assert.equal(calcularEnvio(180010, "domicilio"), 27002);
  assert.equal(calcularEnvio(310000, "domicilio"), 46500);
  assert.equal(calcularEnvio(310010, "domicilio"), 31001);
  n++;
}

// 6. Migracion de carritos viejos (solo traian price = lista)
{
  const c = cargarCliente();
  const viejo = [{ key: "a::x", id: "lampara-caribe-brisa", qty: 2, price: 299000 }, { key: "z::x", id: "pieza-que-ya-no-existe", qty: 1, price: 50000 }];
  const nuevo = c.fvNormalizarCarrito(JSON.parse(JSON.stringify(viejo)));
  assert.equal(nuevo[0].price, 254150); assert.equal(nuevo[0].precioLista, 299000);
  assert.equal(nuevo[1].price, 50000); assert.equal(nuevo[1].precioLista, 50000);
  assert.deepEqual(c.fvNormalizarCarrito(JSON.parse(JSON.stringify(nuevo))), nuevo, "no es idempotente");
  const off = cargarCliente({ activo: false });
  assert.equal(off.fvNormalizarCarrito(JSON.parse(JSON.stringify(nuevo)))[0].price, 299000, "al apagar no vuelve a lista");
  n++;
}
// 7. Fecha de fin e interruptor (cliente y servidor)
{
  const c = cargarCliente({ hasta: "2020-01-01T00:00:00-05:00" });
  assert.equal(c.fvBFActivo(), false);
  assert.equal(configBlackFriday({ BLACK_FRIDAY_HASTA: "2020-01-01T00:00:00-05:00" }).activo, false);
  assert.equal(configBlackFriday({}).activo, true, "por defecto activo (BF_ACTIVO_POR_DEFECTO)");
  assert.equal(configBlackFriday({ BLACK_FRIDAY_ACTIVO: "0" }).activo, false);
  n++;
}

console.table(filas);
console.log("OK: " + n + " pruebas, cliente = servidor en todos los casos.");
