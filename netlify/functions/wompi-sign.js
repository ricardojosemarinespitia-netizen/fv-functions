// ============================================================
//  wompi-sign  ·  Firma de integridad de Wompi, del lado servidor
// ------------------------------------------------------------
//  Antes: checkout.html tenia el secreto de integridad
//  (prod_integrity_...) en el navegador y firmaba alli el monto.
//  Cualquiera podia abrir "ver codigo fuente", copiar el secreto y
//  firmar una transaccion valida por $1.000 en vez de $400.000.
//
//  Ahora: el navegador manda SOLO los ids y las cantidades. El
//  servidor recalcula subtotal, descuento y envio desde su propio
//  catalogo (lib/catalogo-precios.js), y firma ESE monto. El precio
//  que llega del navegador se ignora por completo.
//
//  Variables de entorno requeridas en Netlify:
//    WOMPI_INTEGRITY  -> Secreto de integridad de Wompi
//                        (Comercio > Desarrolladores > Secreto de integridad)
//
//  Respuesta:
//    200 {ok:true, reference, amountInCents, currency, signature, publicKey?, resumen}
//    400 {ok:false, error}          -> peticion mal formada
//    503 {ok:false, error:"sin-secreto"} -> falta WOMPI_INTEGRITY en Netlify
// ============================================================
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { recalcularTotal, RE_CODIGO, RE_CODIGO_VIP, configBlackFriday } from "./lib/catalogo-precios.js";
import { estadoCodigo } from "./lib/vip.js";
import { configSupabase } from "./lib/supabase-rest.js";

// Origenes autorizados a pedir una firma. No es la barrera de seguridad
// (esa es el recalculo del monto), pero evita que la funcion se use desde
// una copia del checkout alojada en otro dominio.
const ORIGENES_OK = [
  "https://felipevergel.com",
  "https://www.felipevergel.com",
  "http://localhost:8888",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
];

// La referencia la genera el navegador con el formato FV-<epoch>-<alfanum>.
// La validamos para que nadie inyecte basura en la cadena que se firma.
// El sufijo sale de Math.random().toString(36).slice(2,7): normalmente son 5
// caracteres, pero puede salir mas corto. Con el minimo en 4 esos casos raros
// se rechazaban y el checkout caia al respaldo de firma local (el agujero que
// esta funcion existe para cerrar). Se acepta de 1 a 12.
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

/**
 * Verifica un código (FV15 o FV20) en Supabase (tabla codigos_descuento).
 * Devuelve "valido" | "usado" | "vencido" | "invalido" | "sin-verificar".
 * FALLA CERRADO: solo "valido" da descuento. Antes, con el Apps Script del
 * Club, un FV15 "sin-verificar" se aplicaba igual; ahora no: si la base no
 * contesta, el servidor cobra sin descuento, el checkout ve un total mayor
 * que el mostrado, no abre Wompi y le dice al cliente que intente de nuevo.
 * 2,5 s y sin reintento: ocurre DENTRO del clic de pagar, con la ventana de
 * Wompi abierta en blanco, y el checkout corta esta llamada a los 4 s.
 */
async function verificarCodigo(code) {
  return (await estadoCodigo(configSupabase(), code, { timeoutMs: 2500, reintentos: 0 })).estado;
}

export default async (req) => {
  const origen = req.headers.get("origin") || "";
  const H = cabeceras(origen);

  // OJO: `null`, no `""`. Un 204 con cuerpo es invalido segun la spec de Fetch
  // y `new Response("", {status:204})` LANZA un TypeError: el preflight habria
  // devuelto 502 y TODOS los checkouts habrian caido a la firma local (el
  // agujero que esta funcion existe para cerrar). Cubierto por prueba unitaria.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "metodo-no-permitido" }), { status: 405, headers: H });
  }

  // Ley 3 · fallar cerrado: sin secreto no hay firma. Nunca una firma "vacia".
  const INTEGRITY = process.env.WOMPI_INTEGRITY;
  if (!INTEGRITY) {
    console.error("wompi-sign: falta la variable de entorno WOMPI_INTEGRITY");
    return new Response(JSON.stringify({ ok: false, error: "sin-secreto" }), { status: 503, headers: H });
  }

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: "json-invalido" }), { status: 400, headers: H });
  }

  const ref = String((body && body.ref) || "");
  if (!RE_REF.test(ref)) {
    return new Response(JSON.stringify({ ok: false, error: "referencia-invalida" }), { status: 400, headers: H });
  }

  // Solo nos quedamos con id + qty. Todo lo demas que mande el navegador
  // (name, price, img...) se descarta: el precio lo pone el catalogo.
  const items = Array.isArray(body.items)
    ? body.items.map((i) => ({ id: String((i && i.id) || ""), qty: Number(i && i.qty) }))
    : [];
  if (!items.length) {
    return new Response(JSON.stringify({ ok: false, error: "carrito-vacio" }), { status: 400, headers: H });
  }

  // --- Descuento: solo si Supabase confirma que el codigo existe y no se ha
  // usado (FV15 o FV20). Si no se puede verificar, NO se aplica.
  const codigo = String((body.discountCode || "")).trim().toUpperCase();
  // Un solo descuento por pedido (regla de Ricardo). La hora la pone ESTE
  // servidor: antes de BF_DESDE no hay Black Friday aunque el navegador crea
  // que si (reloj del celular adelantado).
  const bf = configBlackFriday();
  let descuentoValido = false;
  let vip = false;
  let veredicto = "sin-codigo";
  if (codigo && RE_CODIGO_VIP.test(codigo)) {
    // FV20 (Supabase). Si no se puede verificar NO se aplica: el checkout ve
    // un total mayor y no abre Wompi.
    veredicto = await verificarCodigo(codigo);
    vip = veredicto === "valido";
  } else if (codigo && RE_CODIGO.test(codigo) && bf.activo && !bf.acumulaCodigo) {
    // FV15 durante Black Friday: da el mismo 15 % que ya tienen los precios.
    // No se consulta al Club (ahorra 2,5 s con Wompi en blanco), no resta
    // nada extra y NO se marca como usado.
    veredicto = "igual-que-black-friday";
  } else if (codigo && RE_CODIGO.test(codigo)) {
    veredicto = await verificarCodigo(codigo);
    descuentoValido = veredicto === "valido";
  } else if (codigo) {
    veredicto = "formato-invalido";
  }

  const r = recalcularTotal(items, body.deliveryMethod, descuentoValido, bf, { vip });
  // Solo queda guardado (y se marca usado al aprobarse) el codigo que de
  // verdad dio el descuento cobrado.
  const codigoAplicado = r.descuento > 0 ? codigo : null;

  if (!r.lineas.length) {
    return new Response(JSON.stringify({ ok: false, error: "sin-piezas-validas", desconocidos: r.desconocidos }), { status: 400, headers: H });
  }
  if (r.total <= 0) {
    return new Response(JSON.stringify({ ok: false, error: "total-invalido" }), { status: 400, headers: H });
  }

  const amountInCents = r.total * 100;
  const signature = crypto
    .createHash("sha256")
    .update(ref + String(amountInCents) + "COP" + INTEGRITY)
    .digest("hex");

  // ── Fijar los importes en el servidor ──────────────────────────────────
  //  Se escriben directamente en el almacen de pedidos (no via save-pending,
  //  para que _serverPriced solo pueda ponerlo el servidor). A partir de aqui
  //  save-pending ignora subtotal/descuento/envio/total que lleguen del
  //  navegador: es lo que impedia que un POST con {ref, total: 1000} dejara un
  //  importe falso en la hoja de ventas y en el correo.
  //  Se hace MERGE sobre lo que ya hubiera: los datos del cliente (nombre,
  //  correo, direccion, carrito) los tiene el navegador, no esta funcion.
  try {
    const store = getStore("pedidos");
    let previo = null;
    try { previo = await store.get(ref, { type: "json", consistency: "strong" }); } catch {}
    await store.setJSON(ref, {
      ...(previo || {}),
      ref,
      // subtotal = precios FINALES (con Black Friday si esta activo).
      subtotal: r.subtotal,
      discountAmount: r.descuento,
      discountCode: codigoAplicado,
      shipping: r.envio,
      total: r.total,
      // Black Friday (informativo): subtotalLista - descuentoBF = subtotal.
      subtotalLista: r.subtotalLista,
      descuentoBF: r.descuentoBF,
      bfPct: r.blackFriday.pct,
      tipoDescuento: r.tipoDescuento,
      // Precios del catalogo, por id: save-pending corrige con esto el precio
      // de cada linea del carrito que mande el navegador.
      _serverLineas: r.lineas,
      _serverPriced: true,
      _status: (previo && previo._status === "done") ? "done" : "pending",
      _savedAt: Date.now()
    });
  } catch (e) {
    // Nunca bloquea el pago: la firma ya es correcta y es lo que se cobra.
    console.error("wompi-sign: no se pudo fijar el pedido en el almacen:", e.message);
  }

  return new Response(JSON.stringify({
    ok: true,
    reference: ref,
    currency: "COP",
    amountInCents,
    signature,
    resumen: {
      subtotal: r.subtotal,
      descuento: r.descuento,
      envio: r.envio,
      total: r.total,
      codigo: codigoAplicado || "",
      veredictoCodigo: veredicto,
      desconocidos: r.desconocidos,
      subtotalLista: r.subtotalLista,
      descuentoBF: r.descuentoBF,
      blackFriday: r.blackFriday,
      tipoDescuento: r.tipoDescuento
    }
  }), { status: 200, headers: H });
};
