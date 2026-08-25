import { useEffect, useId, useMemo, useState } from 'react'
import { subirArchivo, supabase, urlFirmada } from './lib/supabaseClient'
import { useProveedores } from './catalogos'
import { FALLA_LABEL, LECTURA_LABEL, TIPOS, piezasLista } from './taller'
import { r2, dinero, hoy } from './utils/format'

export const METODOS = [
  ['credito_proveedor', 'Crédito proveedor'],
  ['efectivo', 'Efectivo'],
  ['tarjeta', 'Tarjeta'],
  ['transferencia', 'Transferencia'],
]
export const ESTATUS = { en_proceso: 'En proceso', completado: 'Completado' }

// tc = pesos por 1 USD (config.tipo_cambio_usd). Empresa fronteriza: todo se consolida en USD.
export const aUSD = (monto, moneda, tc) => (moneda === 'USD' ? monto : r2(monto / (tc || 1)))

// unidades (Km u horas de termo, según unidad.unidadLectura) que faltan para el próximo
// mantenimiento (null = sin ciclo configurado o sin lectura aún)
export const paraMantenimiento = (u) => {
  if (!u.mantenimientoCadaX || u.ultimaLectura == null) return null
  return (Number(u.ultimoMantenimientoValor) || 0) + Number(u.mantenimientoCadaX) - u.ultimaLectura
}

// 'sin_configurar' (sin mantenimientoCadaX) es distinto de null (configurado pero sin lectura aún
// para calcular) -- una unidad sin intervalo no debe mezclarse con las genuinamente vencidas.
// próximo = dentro del último 10% del intervalo (ej. cada 10,000 km, avisa desde los últimos 1,000)
export function estatusMantenimiento(u) {
  if (!u.mantenimientoCadaX) return 'sin_configurar'
  const restante = paraMantenimiento(u)
  if (restante === null) return null
  const margen = Number(u.mantenimientoCadaX) * 0.1
  if (restante <= 0) return 'vencido'
  if (restante <= margen) return 'proximo'
  return null
}

export function BadgeMantenimiento({ unidad }) {
  const estatus = estatusMantenimiento(unidad)
  if (estatus === 'sin_configurar') return <span className="badge inactivo">Mantenimiento sin configurar</span>
  if (estatus === 'vencido') return <span className="badge vencido">Mantenimiento vencido</span>
  if (estatus === 'proximo') {
    const restante = paraMantenimiento(unidad)
    const unidadRestante = unidad.unidadLectura === 'hrs' ? 'hrs' : 'km'
    return <span className="badge alerta">Mantenimiento próximo, en {restante.toLocaleString()} {unidadRestante}</span>
  }
  return null
}

// mapea columnas snake_case de Supabase a la forma camelCase que ya esperaba el resto de la app (ex-Firestore)
const mapUnidad = (u) => ({
  id: u.id,
  numero: u.numero,
  tipo: u.tipo,
  unidadLectura: u.unidad_lectura,
  marca: u.marca,
  modelo: u.modelo,
  vin: u.vin,
  anio: u.anio,
  ultimaLectura: u.ultima_lectura,
  mantenimientoCadaX: u.mantenimiento_cada_x,
  ultimoMantenimientoValor: u.ultimo_mantenimiento_valor,
  activo: u.activo,
})

export function useUnidades() {
  const [unidades, setUnidades] = useState([])
  useEffect(() => {
    const cargar = () => supabase.from('unidades').select('*').then(({ data, error }) => {
      if (error) { console.error(error); return }
      setUnidades(data.map(mapUnidad).sort((a, b) => a.numero.localeCompare(b.numero, undefined, { numeric: true })))
    })
    cargar()
    // nombre único por instancia: dos componentes montados a la vez (ej. WorkOrders +
    // CompraForm) no pueden compartir un canal ya suscrito -- .on() después de .subscribe()
    // en el mismo canal tira excepción y tumba el render entero (sin Error Boundary).
    const canal = supabase
      .channel(`unidades-cambios-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'unidades' }, cargar)
      .subscribe()
    return () => supabase.removeChannel(canal)
  }, [])
  return unidades
}

// hook genérico realtime para Supabase: select inicial (con embeds/filtros vía `construir`,
// que recibe el query builder ya apuntando a la tabla) + canal con nombre único por instancia
// montada -- mismo motivo que useUnidades: dos formularios abiertos a la vez no pueden
// compartir un canal ya suscrito.
export function useTabla(tabla, mapear, construir) {
  const [datos, setDatos] = useState(null)
  useEffect(() => {
    const cargar = () => {
      const q = construir ? construir(supabase.from(tabla)) : supabase.from(tabla).select('*')
      q.then(({ data, error }) => {
        if (error) { console.error(error); return }
        setDatos(data.map(mapear))
      })
    }
    cargar()
    const canal = supabase
      .channel(`${tabla}-cambios-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: tabla }, cargar)
      .subscribe()
    return () => supabase.removeChannel(canal)
  }, [tabla])
  return datos
}

// config es singleton (una sola fila, id=true) -- se reusa useTabla y se toma la primera fila
export const useTipoCambio = () => {
  const filas = useTabla('config', (c) => c)
  return filas?.[0] ? Number(filas[0].tipo_cambio_usd) : null
}

// selects con los embeds de FK que necesita la UI (evita denormalizar unidadNumero/proveedor/etc.)
export const SELECT_WO = '*, unidades(numero), perfiles(email), wo_llantas(accion, posiciones, notas)'
export const SELECT_COMPRA = '*, compra_conceptos(*), unidades(numero), proveedores(razon_social), work_orders(folio), perfiles(email)'

export const mapWO = (w) => ({
  id: w.id,
  wo: w.folio,
  fecha: w.fecha,
  unidadId: w.unidad_id,
  unidadNumero: w.unidades?.numero ?? '',
  lectura: { valor: w.lectura_valor ?? 0, unidad: w.lectura_unidad ?? '' },
  chofer: w.chofer_texto ?? '',
  mecanico: w.mecanico_texto ?? '',
  tipoFalla: w.tipo_falla ?? [],
  tipoServicio: w.tipo_servicio ?? 'correctivo',
  diagnostico: w.diagnostico ?? '',
  piezasRequeridas: w.piezas_requeridas ?? [],
  notasMecanico: w.notas_mecanico ?? '',
  estatus: w.estatus,
  origenMantenimientoProgramado: w.origen_mantenimiento_programado ?? false,
  creadoPor: w.perfiles?.email ?? '',
  createdAt: w.created_at,
  completadoAt: w.completado_at,
  llantaAccion: w.wo_llantas?.[0]?.accion ?? '',
  llantaPosiciones: w.wo_llantas?.[0]?.posiciones?.length ? w.wo_llantas[0].posiciones : [''],
  llantaNotas: w.wo_llantas?.[0]?.notas ?? '',
})

export const mapCompra = (c) => ({
  id: c.id,
  poFolio: c.folio,
  fecha: c.fecha,
  woId: c.wo_id,
  woNumero: c.work_orders?.folio ?? null,
  unidadId: c.unidad_id,
  unidadNumero: c.es_general ? 'General' : (c.unidades?.numero ?? ''),
  esGeneral: c.es_general,
  metodoPago: c.metodo_pago,
  tipoPago: c.tipo_pago,
  fechaVence: c.fecha_vence,
  pagado: c.pagado,
  pagadoAt: c.pagado_at,
  comprobantePagoURL: c.comprobante_pago_path ?? '',
  facturaURL: c.factura_path ?? '',
  xmlURL: c.xml_path ?? '',
  esDiesel: c.es_diesel,
  litrosFacturados: c.litros_facturados ?? 0,
  notas: c.notas ?? '',
  creadoPor: c.perfiles?.email ?? '',
  tipoCambioUsado: Number(c.tipo_cambio_usado),
  subtotalGeneralUSD: aUSD(Number(c.subtotal), c.moneda, Number(c.tipo_cambio_usado)),
  ivaGeneralUSD: aUSD(Number(c.iva), c.moneda, Number(c.tipo_cambio_usado)),
  totalGeneralUSD: Number(c.total_usd),
  createdAt: c.created_at,
  grupos: [{
    proveedorId: c.proveedor_id,
    proveedor: c.proveedores?.razon_social ?? '',
    moneda: c.moneda,
    folioFactura: c.folio_factura ?? '',
    conceptos: (c.compra_conceptos ?? []).map((x) => ({
      concepto: x.concepto, cantidad: Number(x.cantidad), costoUnitario: Number(x.costo_unitario),
      tasaIVA: Number(x.tasa_iva) * 100, subtotal: Number(x.subtotal), iva: Number(x.iva), total: Number(x.total),
    })),
    subtotal: Number(c.subtotal), iva: Number(c.iva), total: Number(c.total), totalUSD: Number(c.total_usd),
  }],
})

// input con <datalist> nativo: escribir muestra sugerencias reales del navegador (antes era
// un buscador de adorno que filtraba un <select> oculto y no mostraba nada al escribir).
// barra de acciones fija arriba del formulario (patrón ERP: Guardar/Atrás siempre visibles,
// sin tener que bajar al final de un formulario largo) -- `extra` recibe botones adicionales
// específicos del formulario (ej. "Terminar viaje"), se renderizan entre Atrás y Guardar
export function BarraAcciones({ onAtras, atrasLabel = 'Atrás', onGuardar, guardando, guardarLabel = 'Guardar', guardarDisabled, extra, className }) {
  return (
    <div className={className ? `barra-acciones ${className}` : 'barra-acciones'}>
      {onAtras
        ? <button type="button" className="btn-secundario" disabled={guardando} onClick={onAtras}>← {atrasLabel}</button>
        : <span />}
      {extra}
      {onGuardar && (
        <button type="button" className="btn-primario" disabled={guardando || guardarDisabled} onClick={onGuardar}>
          {guardando ? 'Guardando…' : guardarLabel}
        </button>
      )}
    </div>
  )
}

// abre un archivo del bucket privado 'adjuntos' firmando la URL al momento del click, en vez
// de depender de una URL guardada que puede haber expirado (ver urlFirmada en supabaseClient.js)
export function EnlaceArchivo({ ruta, children }) {
  const abrir = async (e) => {
    e.preventDefault()
    try {
      const url = await urlFirmada(ruta)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      alert('No se pudo abrir el archivo: ' + err.message)
    }
  }
  return <a href="#" onClick={abrir}>{children}</a>
}

export function SelectorUnidad({ unidades, value, onChange, placeholder, expediente }) {
  const listId = useId()
  const seleccionada = unidades.find((u) => u.id === value)
  const [texto, setTexto] = useState(seleccionada?.numero ?? '')

  // también depende de seleccionada?.numero: si value ya viene seteado (ej. default del
  // chofer) antes de que `unidades` termine de cargar, seleccionada pasa de undefined a
  // encontrada sin que `value` vuelva a cambiar -- sin esto el texto se quedaba vacío para siempre
  useEffect(() => { setTexto(seleccionada?.numero ?? '') }, [value, seleccionada?.numero])

  const escribir = (numero) => {
    setTexto(numero)
    // solo tocar el value del padre en transiciones reales (match exacto o campo vacío);
    // si no, el useEffect de arriba borraría lo que el usuario está a medio escribir
    if (numero === '') { onChange(''); return }
    const u = unidades.find((x) => x.numero === numero)
    if (u) onChange(u.id)
  }

  return (
    <label className={expediente ? 'expediente-fila' : 'campo'}>
      <span>{placeholder}</span>
      <input
        list={listId}
        value={texto}
        onChange={(e) => escribir(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
      />
      <datalist id={listId}>
        {unidades.map((u) => <option key={u.id} value={u.numero}>{TIPOS[u.tipo] ?? u.tipo}</option>)}
      </datalist>
    </label>
  )
}

const MI_A_KM = 1.609344

// homologa una lectura de odómetro/millaje a Km, sea cual sea su unidad nativa. 'hrs' (horómetro,
// motores estacionarios/PTO) no es una distancia -- no hay conversión posible, devuelve null.
export const aKm = (valor, unidad) => {
  const n = Number(valor)
  if (valor == null || valor === '' || Number.isNaN(n)) return null
  if (unidad === 'mi') return r2(n * MI_A_KM)
  if (unidad === 'km') return n
  return null
}

// inverso de aKm: de Km homologado a la unidad nativa de la unidad -- para precargar inputs que
// se capturan en unidad nativa (ej. mantenimiento_cada_x/ultimo_mantenimiento_valor) pero se
// guardan homologados a Km. 'hrs' no se homologa en ninguna dirección, se muestra tal cual (las
// horas de termo de un reefer no son distancia).
const kmAValor = (km, unidad) => {
  if (km == null || km === '') return ''
  if (unidad === 'mi') return r2(Number(km) / MI_A_KM)
  return Number(km)
}

// captura un odómetro con selector Km/Millas y devuelve siempre el equivalente en Km al padre
// (onChangeKm) -- así las unidades americanas (millas) y las nacionales (km) se pueden comparar
// y sumar en los mismos cálculos (rendimiento, costeo, KPIs) sin mezclar unidades.
export function CampoOdometro({ label, unidadPorDefecto, valorInicialKm, onChangeKm }) {
  const [raw, setRaw] = useState(valorInicialKm != null ? String(valorInicialKm) : '')
  const [unidadMedida, setUnidadMedida] = useState('km')
  // si ya viene con un valor (editar algo existente), ese valor siempre está en Km -- no dejar
  // que el default por unidadPorDefecto lo pise de vuelta a mi/hrs
  const [tocado, setTocado] = useState(valorInicialKm != null)

  // mismo motivo que en SelectorUnidad: unidadPorDefecto (de unidad.unidadLectura) puede llegar
  // después del primer render -- solo aplica mientras el usuario no haya elegido a mano
  useEffect(() => {
    if (!tocado && unidadPorDefecto) setUnidadMedida(unidadPorDefecto)
  }, [tocado, unidadPorDefecto])

  const emitir = (valorRaw, um) => onChangeKm(aKm(valorRaw, um))

  return (
    <div className="fila-2">
      <label className="campo"><span>{label}</span>
        <input
          type="number" inputMode="numeric" min="0" value={raw}
          onChange={(e) => { setRaw(e.target.value); emitir(e.target.value, unidadMedida) }}
        />
      </label>
      <label className="campo"><span>Unidad</span>
        <select
          value={unidadMedida}
          onChange={(e) => { setTocado(true); setUnidadMedida(e.target.value); emitir(raw, e.target.value) }}
        >
          <option value="km">Kilómetros</option>
          <option value="mi">Millas</option>
        </select>
      </label>
    </div>
  )
}

export default function Compras({ usuario, vista }) {
  if (vista === 'nueva-compra') return <CompraForm usuario={usuario} />
  // también se monta desde el grupo de nav "dispatch"; compras solo puede consultar, no editar
  if (vista === 'unidades') return <Unidades soloLectura={usuario.rol === 'compras'} />
  if (vista === 'cuentas-pagar') return <CuentasPorPagar />
  return <WorkOrders usuario={usuario} />
}

/* ---------- Sección 1: Work Orders ---------- */

function WorkOrders({ usuario }) {
  const [detalle, setDetalle] = useState(null)
  const [fEstatus, setFEstatus] = useState('')
  const [fTipo, setFTipo] = useState('')
  const unidades = useUnidades()
  const tipoDe = useMemo(() => Object.fromEntries(unidades.map((u) => [u.id, u.tipo])), [unidades])

  const wos = useTabla('work_orders', mapWO, (q) => q.select(SELECT_WO).order('created_at', { ascending: false }))

  if (detalle) return <WODetalle usuario={usuario} wo={detalle} onVolver={() => setDetalle(null)} />

  const lista = (wos ?? []).filter((w) =>
    (!fEstatus || w.estatus === fEstatus) && (!fTipo || tipoDe[w.unidadId] === fTipo))

  return (
    <div>
      <h2>Work Orders</h2>
      <div className="filtros">
        <select value={fEstatus} onChange={(e) => setFEstatus(e.target.value)}>
          <option value="">Todas</option>
          <option value="en_proceso">En proceso</option>
          <option value="completado">Completadas</option>
        </select>
        <select value={fTipo} onChange={(e) => setFTipo(e.target.value)}>
          <option value="">Todas las unidades</option>
          {Object.entries(TIPOS).map(([t, l]) => <option key={t} value={t}>{l}</option>)}
        </select>
      </div>
      {wos === null && <p className="muted">Cargando…</p>}
      {wos !== null && lista.length === 0 && <p className="muted vacio">No hay work orders con estos filtros.</p>}
      {lista.length > 0 && (
        <div className="tabla-scroll">
          <table className="tabla-densa">
            <thead>
              <tr>
                <th>WO</th><th>Fecha</th><th>Unidad</th><th>Estatus</th><th>Chofer / Mecánico</th><th>Fallas</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((w) => (
                <tr key={w.id} onClick={() => setDetalle(w)}>
                  <td><strong>{w.wo}</strong></td>
                  <td className="muted">{w.fecha}</td>
                  <td>
                    {w.unidadNumero}
                    {w.lectura?.valor && <span className="muted"> · {w.lectura.valor.toLocaleString()} {w.lectura.unidad}</span>}
                  </td>
                  <td><span className={'badge ' + w.estatus}>{ESTATUS[w.estatus]}</span></td>
                  <td className="muted">{[w.chofer, w.mecanico].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="muted">{w.tipoFalla?.length > 0 ? w.tipoFalla.map((f) => FALLA_LABEL[f]).join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function WODetalle({ usuario, wo, onVolver }) {
  const [comprando, setComprando] = useState(false)
  const compras = useTabla('compras', mapCompra, (q) => q.select(SELECT_COMPRA).eq('wo_id', wo.id)) ?? []

  if (comprando) return <CompraForm usuario={usuario} wo={wo} onDone={() => setComprando(false)} />

  const totalUSD = r2(compras.reduce((s, c) => s + (c.totalGeneralUSD ?? 0), 0))

  return (
    <div className="expediente">
      <BarraAcciones
        onAtras={onVolver}
        extra={<button type="button" className="btn-primario" onClick={() => setComprando(true)}>Registrar compra para esta WO</button>}
      />
      <div className="tarjeta-top">
        <h2>{wo.wo}</h2>
        <span className={'badge ' + wo.estatus}>{ESTATUS[wo.estatus]}</span>
      </div>
      <div className="expediente-seccion">
        <div className="expediente-seccion-titulo">Datos generales</div>
        <div className="expediente-fila"><span>Fecha</span><span>{wo.fecha}</span></div>
        <div className="expediente-fila">
          <span>Unidad</span>
          <span><strong>{wo.unidadNumero}</strong>{wo.lectura?.valor ? ` · ${wo.lectura.valor.toLocaleString()} ${wo.lectura.unidad}` : ''}</span>
        </div>
        {wo.chofer && <div className="expediente-fila"><span>Chofer</span><span>{wo.chofer}</span></div>}
        {wo.mecanico && <div className="expediente-fila"><span>Mecánico</span><span>{wo.mecanico}</span></div>}
        {wo.tipoFalla?.length > 0 && (
          <div className="expediente-fila"><span>Tipo de falla</span><span>{wo.tipoFalla.map((f) => FALLA_LABEL[f]).join(', ')}</span></div>
        )}
        {wo.diagnostico && <div className="expediente-fila"><span>Diagnóstico</span><span>{wo.diagnostico}</span></div>}
        {piezasLista(wo.piezasRequeridas).length > 0 && (
          <div className="expediente-fila">
            <span>Piezas requeridas</span>
            <ol className="lista-piezas">{piezasLista(wo.piezasRequeridas).map((p, i) => <li key={i}>{p}</li>)}</ol>
          </div>
        )}
        {wo.notasMecanico && <div className="expediente-fila"><span>Notas del mecánico</span><span>{wo.notasMecanico}</span></div>}
      </div>

      <h3>Compras registradas</h3>
      {compras.length === 0 && <p className="muted">Sin compras para esta WO.</p>}
      {compras.length > 0 && (
        <div className="tabla-scroll">
          <table className="tabla-densa">
            <thead><tr><th>Fecha</th><th>Proveedor</th><th className="num">Total</th></tr></thead>
            <tbody>
              {compras.map((c) => (
                <tr key={c.id}>
                  <td className="muted">{c.fecha}</td>
                  <td>{(c.grupos ?? []).map((g) => g.proveedor).filter(Boolean).join(', ')}</td>
                  <td className="num">{dinero(c.totalGeneralUSD, 'USD')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {compras.length > 0 && (
        <p className="total-detalle">Total: {dinero(totalUSD, 'USD')}</p>
      )}

    </div>
  )
}

/* ---------- Formulario de compra (con WO o directa) ---------- */
/* Estructura: la compra se agrupa por proveedor. Cada proveedor tiene su
   propia moneda y folio; dentro de cada uno, N conceptos con cantidad,
   costo unitario e IVA. El total general siempre se muestra consolidado
   en USD (empresa fronteriza), convirtiendo los grupos en MXN con el TC. */

const conceptoVacio = () => ({ concepto: '', cantidad: 1, costoUnitario: '', tasaIVA: 16 })
const grupoVacio = () => ({
  proveedorId: '', moneda: 'MXN', folioFactura: '',
  esDiesel: false, litrosFacturados: '',
  pdf: null, xml: null,
  conceptos: [conceptoVacio()],
})
const compraVacia = (wo) => ({
  unidadId: wo?.unidadId ?? '',
  unidadNumero: wo?.unidadNumero ?? '',
  esGeneral: false,
  fecha: hoy(),
  metodoPago: 'credito_proveedor',
  notas: '',
  grupos: [grupoVacio()],
})

const calcConcepto = (c) => {
  const cantidad = Number(c.cantidad) || 0
  const costoUnitario = Number(c.costoUnitario) || 0
  const tasaIVA = Number(c.tasaIVA)
  const subtotal = r2(cantidad * costoUnitario)
  const iva = r2(subtotal * tasaIVA / 100)
  return { concepto: c.concepto, cantidad, costoUnitario, tasaIVA, subtotal, iva, total: r2(subtotal + iva) }
}

const calcGrupo = (g, tc, proveedores) => {
  const conceptos = g.conceptos.map(calcConcepto)
  const subtotal = r2(conceptos.reduce((s, c) => s + c.subtotal, 0))
  const iva = r2(conceptos.reduce((s, c) => s + c.iva, 0))
  const total = r2(subtotal + iva)
  const prov = (proveedores ?? []).find((p) => p.id === g.proveedorId)
  return {
    proveedorId: g.proveedorId,
    proveedor: prov?.razonSocial ?? g.proveedor ?? '',
    moneda: g.moneda, folioFactura: g.folioFactura,
    conceptos, subtotal, iva, total, totalUSD: aUSD(total, g.moneda, tc),
  }
}

const sumaDias = (fecha, dias) => {
  const d = new Date(fecha + 'T00:00')
  d.setDate(d.getDate() + dias)
  return d.toLocaleDateString('sv')
}

function CompraForm({ usuario, wo, onDone }) {
  const unidades = useUnidades()
  const tc = useTipoCambio()
  const proveedores = useProveedores() ?? []
  const [f, setF] = useState(() => compraVacia(wo))
  const [guardando, setGuardando] = useState(false)

  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  const setGrupoCampo = (gi, campo) => (e) =>
    setF({ ...f, grupos: f.grupos.map((g, j) => (j === gi ? { ...g, [campo]: e.target.value } : g)) })

  const setConcepto = (gi, ci, campo) => (e) =>
    setF({
      ...f,
      grupos: f.grupos.map((g, j) => (j !== gi ? g : {
        ...g,
        conceptos: g.conceptos.map((c, k) => (k === ci ? { ...c, [campo]: e.target.value } : c)),
      })),
    })

  const agregarConcepto = (gi) => setF({
    ...f,
    grupos: f.grupos.map((g, j) => (j === gi ? { ...g, conceptos: [...g.conceptos, conceptoVacio()] } : g)),
  })
  const quitarConcepto = (gi, ci) => setF({
    ...f,
    grupos: f.grupos.map((g, j) => (j !== gi ? g : { ...g, conceptos: g.conceptos.filter((_, k) => k !== ci) })),
  })

  const agregarGrupo = () => setF({ ...f, grupos: [...f.grupos, grupoVacio()] })
  const quitarGrupo = (gi) => setF({ ...f, grupos: f.grupos.filter((_, j) => j !== gi) })

  const calc = f.grupos.map((g) => calcGrupo(g, tc, proveedores))
  const subtotalGeneralUSD = r2(calc.reduce((s, g) => s + aUSD(g.subtotal, g.moneda, tc), 0))
  const ivaGeneralUSD = r2(calc.reduce((s, g) => s + aUSD(g.iva, g.moneda, tc), 0))
  const totalGeneralUSD = r2(calc.reduce((s, g) => s + g.totalUSD, 0))

  const guardar = async () => {
    if (!f.esGeneral && !f.unidadId) { alert('Selecciona una unidad o marca la compra como general'); return }
    if (!tc) { alert('Cargando tipo de cambio, intenta de nuevo en un momento'); return }
    const esCredito = f.metodoPago === 'credito_proveedor'
    const grupos = calc
      .map((g, gi) => ({ gi, ...g, conceptos: g.conceptos.filter((c) => c.concepto.trim() !== '' || c.subtotal > 0) }))
      .filter((g) => g.proveedorId && g.conceptos.length > 0)
    if (grupos.length === 0) { alert('Agrega al menos un proveedor con un concepto'); return }
    if (esCredito && grupos.some((g) => !(proveedores.find((p) => p.id === g.proveedorId)?.diasCredito > 0))) {
      if (!confirm('Algún proveedor no tiene días de crédito configurados; el vencimiento será hoy. ¿Continuar?')) return
    }
    setGuardando(true)
    try {
      // un renglón de `compras` por proveedor (mismo criterio que ya usaba Firestore: un PO
      // por proveedor); el id se genera en el cliente para nombrar los archivos antes del insert.
      // el folio PO-XXXX lo asigna la secuencia de Postgres (nextval), no hace falta contador propio.
      const filas = await Promise.all(grupos.map(async (g) => {
        const id = crypto.randomUUID()
        const orig = f.grupos[g.gi]
        const prov = proveedores.find((p) => p.id === g.proveedorId)
        const facturaURL = orig.pdf ? await subirArchivo(`compras/${id}/factura_${orig.pdf.name}`, orig.pdf) : ''
        const xmlURL = orig.xml ? await subirArchivo(`compras/${id}/xml_${orig.xml.name}`, orig.xml) : ''
        return { id, g, orig, prov, facturaURL, xmlURL }
      }))
      for (const { id, g, orig, prov, facturaURL, xmlURL } of filas) {
        const { error: errCompra } = await supabase.from('compras').insert({
          id,
          wo_id: wo?.id ?? null,
          unidad_id: f.esGeneral ? null : f.unidadId,
          es_general: f.esGeneral,
          fecha: f.fecha,
          proveedor_id: g.proveedorId,
          moneda: g.moneda,
          folio_factura: g.folioFactura || null,
          subtotal: g.subtotal, iva: g.iva, total: g.total, total_usd: g.totalUSD,
          tipo_cambio_usado: tc,
          metodo_pago: f.metodoPago,
          fecha_vence: esCredito ? sumaDias(f.fecha, prov?.diasCredito ?? 0) : null,
          pagado: !esCredito, // contado queda pagado al momento
          factura_path: facturaURL || null, xml_path: xmlURL || null,
          es_diesel: Boolean(orig.esDiesel),
          litros_facturados: orig.esDiesel ? (Number(orig.litrosFacturados) || 0) : 0,
          notas: f.notas || null,
          creado_por: usuario.id,
        })
        if (errCompra) throw errCompra
        const { error: errConceptos } = await supabase.from('compra_conceptos').insert(
          g.conceptos.map((c) => ({
            compra_id: id, concepto: c.concepto, cantidad: c.cantidad,
            costo_unitario: c.costoUnitario, tasa_iva: c.tasaIVA / 100,
          })),
        )
        if (errConceptos) throw errConceptos
      }
      if (onDone) {
        onDone()
      } else {
        alert('Compra guardada')
        setF(compraVacia(null))
      }
    } catch (e) {
      console.error(e)
      alert('Error al guardar: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div>
      <BarraAcciones onAtras={onDone} onGuardar={guardar} guardando={guardando} guardarDisabled={!tc} guardarLabel="Guardar compra" />
      <h2>{wo ? `Compra para ${wo.wo}` : 'Nueva compra directa'}</h2>

      {wo && piezasLista(wo.piezasRequeridas).length > 0 && (
        <div className="expediente-seccion">
          <div className="expediente-fila">
            <span>Piezas requeridas</span>
            <ol className="lista-piezas">{piezasLista(wo.piezasRequeridas).map((p, i) => <li key={i}>{p}</li>)}</ol>
          </div>
        </div>
      )}

      {wo ? (
        <label className="campo">
          <span>Unidad</span>
          <input value={wo.unidadNumero} disabled />
        </label>
      ) : (
        <>
          <label className="campo" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={f.esGeneral}
              onChange={(e) => setF({ ...f, esGeneral: e.target.checked, unidadId: '', unidadNumero: '' })} />
            <span style={{ margin: 0 }}>Compra general de empresa (sin unidad: rentas, seguros, internet…)</span>
          </label>
          {!f.esGeneral && (
            <SelectorUnidad
              unidades={unidades}
              value={f.unidadId}
              onChange={(id) => {
                const u = unidades.find((x) => x.id === id)
                setF({ ...f, unidadId: u?.id ?? '', unidadNumero: u?.numero ?? '' })
              }}
              placeholder="Selecciona unidad…"
            />
          )}
        </>
      )}

      <label className="campo">
        <span>Fecha</span>
        <input type="date" value={f.fecha} onChange={set('fecha')} />
      </label>
      <label className="campo">
        <span>Método de pago</span>
        <select value={f.metodoPago} onChange={set('metodoPago')}>
          {METODOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label className="campo">
        <span>Notas</span>
        <textarea value={f.notas} onChange={set('notas')} placeholder="Motivo de la compra, taller externo…" />
      </label>

      <h3>Conceptos por proveedor</h3>
      {f.grupos.map((g, gi) => {
        const cg = calc[gi]
        return (
          <div key={gi} className="grupo-proveedor">
            <div className="tarjeta-top">
              <span className="muted">Proveedor {gi + 1}</span>
              <button
                type="button" className="btn-borrar" aria-label="Eliminar proveedor"
                disabled={f.grupos.length === 1}
                onClick={() => quitarGrupo(gi)}
              >🗑</button>
            </div>
            <label className="campo">
              <span>Proveedor (catálogo)</span>
              <select value={g.proveedorId} onChange={setGrupoCampo(gi, 'proveedorId')}>
                <option value="">Selecciona proveedor…</option>
                {proveedores.slice().sort((a, b) => a.razonSocial.localeCompare(b.razonSocial)).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.razonSocial}{p.diasCredito ? ` (${p.diasCredito} días)` : ''}
                  </option>
                ))}
              </select>
            </label>
            {g.conceptos.map((c, ci) => {
              const cc = cg.conceptos[ci]
              return (
                <div key={ci} className="linea">
                  <div className="fila-concepto">
                    <label className="campo">
                      <span>Concepto</span>
                      <input value={c.concepto} onChange={setConcepto(gi, ci, 'concepto')} />
                    </label>
                    <label className="campo">
                      <span>Cantidad</span>
                      <input type="number" inputMode="decimal" min="0" value={c.cantidad} onChange={setConcepto(gi, ci, 'cantidad')} />
                    </label>
                    <label className="campo">
                      <span>Costo unit.</span>
                      <input type="number" inputMode="decimal" min="0" step="0.01" value={c.costoUnitario} onChange={setConcepto(gi, ci, 'costoUnitario')} />
                    </label>
                    <label className="campo">
                      <span>IVA %</span>
                      <select value={c.tasaIVA} onChange={setConcepto(gi, ci, 'tasaIVA')}>
                        <option value="0">0%</option>
                        <option value="8">8%</option>
                        <option value="16">16%</option>
                      </select>
                    </label>
                  </div>
                  <div className="linea-calc">
                    <span className="muted">Subtotal {dinero(cc.subtotal, g.moneda)} · IVA {dinero(cc.iva, g.moneda)}</span>
                    <strong>{dinero(cc.total, g.moneda)}</strong>
                    <button
                      type="button" className="btn-borrar" aria-label="Eliminar concepto"
                      disabled={g.conceptos.length === 1}
                      onClick={() => quitarConcepto(gi, ci)}
                    >🗑</button>
                  </div>
                </div>
              )
            })}
            <button type="button" className="btn-secundario btn-bloque" onClick={() => agregarConcepto(gi)}>
              + Agregar concepto
            </button>

            <div className="fila-2">
              <label className="campo">
                <span>Moneda</span>
                <select value={g.moneda} onChange={setGrupoCampo(gi, 'moneda')}>
                  <option value="MXN">MXN</option>
                  <option value="USD">USD</option>
                </select>
              </label>
              <label className="campo">
                <span>Folio de factura / ticket</span>
                <input value={g.folioFactura} onChange={setGrupoCampo(gi, 'folioFactura')} />
              </label>
            </div>
            <label className="campo" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={g.esDiesel}
                onChange={(e) => setF({ ...f, grupos: f.grupos.map((x, j) => (j === gi ? { ...x, esDiesel: e.target.checked } : x)) })} />
              <span style={{ margin: 0 }}>Factura de diésel (gasolinera consolidada)</span>
            </label>
            {g.esDiesel && (
              <label className="campo">
                <span>Litros facturados (para auditoría vs. cargas de choferes)</span>
                <input type="number" inputMode="decimal" min="0" step="0.01" value={g.litrosFacturados}
                  onChange={setGrupoCampo(gi, 'litrosFacturados')} />
              </label>
            )}
            <div className="fila-2">
              <label className="campo">
                <span>Factura PDF (opcional)</span>
                <input type="file" accept=".pdf,image/*"
                  onChange={(e) => setF({ ...f, grupos: f.grupos.map((x, j) => (j === gi ? { ...x, pdf: e.target.files[0] ?? null } : x)) })} />
              </label>
              <label className="campo">
                <span>Factura XML (opcional)</span>
                <input type="file" accept=".xml"
                  onChange={(e) => setF({ ...f, grupos: f.grupos.map((x, j) => (j === gi ? { ...x, xml: e.target.files[0] ?? null } : x)) })} />
              </label>
            </div>

            <div className="linea-calc grupo-total">
              <span className="muted">Total proveedor ({g.moneda})</span>
              <strong>
                {dinero(cg.total, g.moneda)}
                {g.moneda === 'MXN' && tc ? ` · ${dinero(cg.totalUSD, 'USD')}` : ''}
              </strong>
            </div>
          </div>
        )
      })}
      <button type="button" className="btn-secundario btn-bloque" onClick={agregarGrupo}>
        + Agregar proveedor
      </button>

      <div className="totales">
        <div><span className="muted">Subtotal general (USD)</span><span>{dinero(subtotalGeneralUSD, 'USD')}</span></div>
        <div><span className="muted">IVA general (USD)</span><span>{dinero(ivaGeneralUSD, 'USD')}</span></div>
        <div className="total-grande"><span>TOTAL GENERAL</span><span>{dinero(totalGeneralUSD, 'USD')}</span></div>
      </div>
      {tc ? (
        <p className="muted tc-nota">TC usado: {tc} MXN/USD</p>
      ) : (
        <p className="muted tc-nota">Cargando tipo de cambio…</p>
      )}

    </div>
  )
}

/* ---------- Sección 3: Unidades ---------- */

function Unidades({ soloLectura }) {
  const unidades = useUnidades()
  const [editando, setEditando] = useState(null) // objeto unidad | 'nueva' | null

  if (editando && !soloLectura) {
    return (
      <UnidadForm
        unidad={editando === 'nueva' ? null : editando}
        onDone={() => setEditando(null)}
      />
    )
  }

  return (
    <div>
      <div className="toolbar-lista">
        <h2>Unidades</h2>
        {!soloLectura && (
          <button type="button" className="btn-primario" onClick={() => setEditando('nueva')}>
            + Agregar unidad
          </button>
        )}
      </div>
      {Object.entries(TIPOS).map(([tipo, label]) => {
        const grupo = unidades.filter((u) => u.tipo === tipo)
        return grupo.length > 0 && (
          <div key={tipo}>
            <h3>{label}</h3>
            <div className="tabla-scroll">
              <table className="tabla-densa">
                <thead>
                  <tr>
                    <th>Número</th>
                    <th>Última lectura</th>
                    <th>Marca / Modelo</th>
                    <th className="num">Año</th>
                    <th>Mantenimiento</th>
                  </tr>
                </thead>
                <tbody>
                  {grupo.map((u) => (
                    <tr key={u.id} onClick={soloLectura ? undefined : () => setEditando(u)}>
                      <td><strong>{u.numero}</strong></td>
                      <td className="num">
                        {u.ultimaLectura != null
                          ? `${u.ultimaLectura.toLocaleString()} ${u.unidadLectura === 'hrs' ? 'hrs' : 'km'}`
                          : LECTURA_LABEL[u.unidadLectura]}
                      </td>
                      <td className="muted">{[u.marca, u.modelo].filter(Boolean).join(' ') || '—'}</td>
                      <td className="num">{u.anio || '—'}</td>
                      <td><IndicadorMantenimiento unidad={u} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// versión compacta de BadgeMantenimiento para la tabla densa (punto + texto corto en vez de
// pill con fondo de color) -- BadgeMantenimiento sigue igual, la usan otras pantallas (Diésel)
function IndicadorMantenimiento({ unidad }) {
  const estatus = estatusMantenimiento(unidad)
  if (!estatus) return <span className="muted">—</span>
  const LABEL = { sin_configurar: 'Sin configurar', vencido: 'Vencido', proximo: 'Próximo' }
  return <span><span className={'punto-estado ' + estatus} />{LABEL[estatus]}</span>
}

function UnidadForm({ unidad, onDone }) {
  // Supabase manda null en los campos opcionales sin capturar -- un input controlado no acepta
  // null como value, y Number(null) === 0 se colaría al guardar violando el check de anio.
  const [f, setF] = useState(() => ({
    numero: unidad?.numero ?? '', tipo: unidad?.tipo ?? 'truck', unidadLectura: unidad?.unidadLectura ?? 'mi',
    marca: unidad?.marca ?? '', anio: unidad?.anio ?? '', modelo: unidad?.modelo ?? '', vin: unidad?.vin ?? '',
    // mantenimientoCadaX/ultimoMantenimientoValor se guardan homologados (Km para mi/km, valor
    // directo para hrs -- horas de termo no son distancia) -- se precargan de vuelta en la unidad
    // nativa de la unidad para que el input siga mostrando lo que el admin espera ver
    mantenimientoCadaX: unidad ? kmAValor(unidad.mantenimientoCadaX, unidad.unidadLectura) : '',
    ultimoMantenimientoValor: unidad ? kmAValor(unidad.ultimoMantenimientoValor, unidad.unidadLectura) : '',
  }))
  const [guardando, setGuardando] = useState(false)
  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  // 'hrs' no se homologa (no es distancia); mi/km sí, para poder compararse contra ultimaLectura
  const homologar = (valor) => (f.unidadLectura === 'hrs' ? Number(valor) || 0 : (aKm(valor, f.unidadLectura) ?? 0))

  const guardar = async () => {
    setGuardando(true)
    try {
      if (unidad) {
        const { error } = await supabase.from('unidades').update({
          marca: f.marca, anio: f.anio === '' ? null : Number(f.anio), modelo: f.modelo, vin: f.vin,
          unidad_lectura: f.unidadLectura,
          mantenimiento_cada_x: homologar(f.mantenimientoCadaX),
          ultimo_mantenimiento_valor: homologar(f.ultimoMantenimientoValor),
        }).eq('id', unidad.id)
        if (error) throw error
      } else {
        const numero = f.numero.trim().toUpperCase()
        if (!numero) { alert('Escribe el número de unidad'); return }
        const { error } = await supabase.from('unidades').insert({
          numero, tipo: f.tipo, unidad_lectura: f.unidadLectura,
          mantenimiento_cada_x: homologar(f.mantenimientoCadaX),
          ultimo_mantenimiento_valor: homologar(f.ultimoMantenimientoValor),
          marca: f.marca, anio: f.anio === '' ? null : Number(f.anio), modelo: f.modelo, vin: f.vin,
        })
        if (error) {
          if (error.code === '23505') { alert(`Ya existe la unidad ${numero}`); return }
          throw error
        }
      }
      onDone()
    } catch (e) {
      console.error(e)
      alert('Error al guardar: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="expediente">
      <BarraAcciones onAtras={onDone} onGuardar={guardar} guardando={guardando} guardarLabel={unidad ? 'Guardar cambios' : 'Guardar unidad'} />
      <h2>{unidad ? `Unidad ${unidad.numero}` : 'Agregar unidad'}</h2>

      <div className="expediente-seccion">
        <div className="expediente-seccion-titulo">Datos generales</div>
        {!unidad && (
          <>
            <label className="expediente-fila">
              <span>Número de unidad</span>
              <input value={f.numero} onChange={set('numero')} placeholder="Ej. F73" />
            </label>
            <label className="expediente-fila">
              <span>Tipo</span>
              <select value={f.tipo} onChange={(e) => {
                const tipo = e.target.value
                setF({ ...f, tipo, unidadLectura: tipo === 'reefer' ? 'hrs' : 'mi' })
              }}>
                <option value="truck">Truck</option>
                <option value="reefer">Reefer</option>
                <option value="plataforma">Plataforma</option>
                <option value="caja_seca">Caja seca</option>
              </select>
            </label>
          </>
        )}
        <label className="expediente-fila">
          <span>Unidad de lectura</span>
          <select value={f.unidadLectura} onChange={set('unidadLectura')}>
            <option value="mi">Millas (mi)</option>
            <option value="km">Kilómetros (km)</option>
            <option value="hrs">Horas (hrs)</option>
          </select>
        </label>
        <label className="expediente-fila">
          <span>Marca</span>
          <input value={f.marca} onChange={set('marca')} />
        </label>
        <label className="expediente-fila">
          <span>Modelo</span>
          <input value={f.modelo} onChange={set('modelo')} />
        </label>
        <label className="expediente-fila">
          <span>Año</span>
          <input value={f.anio} onChange={set('anio')} inputMode="numeric" />
        </label>
        <label className="expediente-fila">
          <span>VIN / Serie</span>
          <input value={f.vin} onChange={set('vin')} />
        </label>
      </div>

      {(f.tipo === 'truck' || f.tipo === 'reefer') && (
        <div className="expediente-seccion">
          <div className="expediente-seccion-titulo">Mantenimiento</div>
          <label className="expediente-fila">
            <span>Mantenimiento cada ({f.unidadLectura})</span>
            <input type="number" inputMode="numeric" min="0" value={f.mantenimientoCadaX}
              onChange={set('mantenimientoCadaX')} placeholder={f.unidadLectura === 'hrs' ? 'Ej. 500' : 'Ej. 50000'} />
          </label>
          <label className="expediente-fila">
            <span>Último mantenimiento en ({f.unidadLectura})</span>
            <input type="number" inputMode="numeric" min="0" value={f.ultimoMantenimientoValor}
              onChange={set('ultimoMantenimientoValor')} />
          </label>
        </div>
      )}
    </div>
  )
}

/* ---------- Sección 4: Cuentas por Pagar ---------- */

// lunes de la semana de una fecha YYYY-MM-DD (agrupa vencimientos por semana)
const lunesDe = (fecha) => {
  const d = new Date(fecha + 'T00:00')
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.toLocaleDateString('sv')
}

// factura/XML a veces llegan después del pago -- este control deja adjuntarlos desde
// Cuentas por pagar en cualquier momento (pendiente o ya pagada), sin volver a Compras
function AdjuntoCompra({ compra, campo, url, label, carpeta }) {
  const [subiendo, setSubiendo] = useState(false)
  const adjuntar = async (file) => {
    if (!file) return
    setSubiendo(true)
    try {
      const ruta = await subirArchivo(`compras/${compra.id}/${carpeta}_${file.name}`, file)
      const { error } = await supabase.from('compras').update({ [campo]: ruta }).eq('id', compra.id)
      if (error) throw error
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSubiendo(false)
    }
  }
  if (url) return <EnlaceArchivo ruta={url}>Ver {label}</EnlaceArchivo>
  return (
    <label className="btn-secundario">
      {subiendo ? 'Subiendo…' : `+ ${label}`}
      <input type="file" accept=".pdf,.xml,image/*" style={{ display: 'none' }} disabled={subiendo}
        onChange={(e) => adjuntar(e.target.files[0] ?? null)} />
    </label>
  )
}

function CuentasPorPagar() {
  const [pagando, setPagando] = useState(null) // compra en proceso de pago
  const [comprobante, setComprobante] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const compras = useTabla('compras', mapCompra, (q) => q.select(SELECT_COMPRA).eq('tipo_pago', 'credito'))

  const pendientes = (compras ?? []).filter((c) => !c.pagado)
    .sort((a, b) => (a.fechaVence || '').localeCompare(b.fechaVence || ''))
  const pagadas = (compras ?? []).filter((c) => c.pagado)
    .sort((a, b) => (b.pagadoAt || '').localeCompare(a.pagadoAt || ''))
  const totalUSD = r2(pendientes.reduce((s, c) => s + (c.totalGeneralUSD ?? 0), 0))

  // agrupa por semana de vencimiento
  const semanas = {}
  pendientes.forEach((c) => {
    const clave = c.fechaVence ? lunesDe(c.fechaVence) : 'sin-fecha'
    ;(semanas[clave] ??= []).push(c)
  })

  const pagar = async () => {
    setGuardando(true)
    try {
      const url = comprobante
        ? await subirArchivo(`compras/${pagando.id}/pago_${comprobante.name}`, comprobante)
        : ''
      const { error } = await supabase.from('compras').update({
        pagado: true,
        pagado_at: hoy(),
        comprobante_pago_path: url || null,
      }).eq('id', pagando.id)
      if (error) throw error
      setPagando(null)
      setComprobante(null)
    } catch (e) {
      console.error(e)
      alert('Error: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const hoyStr = hoy()

  if (pagando) {
    return (
      <div className="expediente">
        <h2>Pagar {pagando.poFolio || 'compra'}</h2>
        <div className="expediente-seccion">
          <div className="expediente-fila"><span>Proveedor</span><span>{(pagando.grupos ?? []).map((g) => g.proveedor).join(', ')}</span></div>
          <div className="expediente-fila"><span>Vence</span><span>{pagando.fechaVence}</span></div>
          <div className="expediente-fila"><span>Monto</span><span><strong>{dinero(pagando.totalGeneralUSD, 'USD')}</strong></span></div>
        </div>
        <label className="campo"><span>Comprobante de pago</span>
          <input type="file" accept=".pdf,image/*" onChange={(e) => setComprobante(e.target.files[0] ?? null)} />
        </label>
        <div className="acciones">
          <button className="btn-completar" disabled={guardando} onClick={pagar}>
            {guardando ? 'Guardando…' : 'Confirmar pago'}
          </button>
          <button className="btn-secundario" disabled={guardando} onClick={() => setPagando(null)}>Cancelar</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2>Cuentas por pagar</h2>
      <div className="kpis">
        <div className="kpi">Facturas pendientes<strong>{pendientes.length}</strong></div>
        <div className="kpi">Total por pagar<strong>{dinero(totalUSD, 'USD')}</strong></div>
      </div>
      {compras === null && <p className="muted">Cargando…</p>}
      {compras !== null && pendientes.length === 0 && <p className="muted vacio">Sin cuentas por pagar. 🎉</p>}
      {Object.entries(semanas).sort(([a], [b]) => a.localeCompare(b)).map(([semana, lista]) => (
        <div key={semana}>
          <h3>
            {semana === 'sin-fecha' ? 'Sin fecha de vencimiento' : `Semana del ${semana}`}
            {' · '}{dinero(r2(lista.reduce((s, c) => s + (c.totalGeneralUSD ?? 0), 0)), 'USD')}
          </h3>
          <div className="tabla-scroll">
            <table className="tabla-densa">
              <thead>
                <tr>
                  <th>Folio</th><th>Proveedor</th><th>Compra</th><th>Vence</th>
                  <th className="num">Total</th><th>Factura</th><th>XML</th><th></th>
                </tr>
              </thead>
              <tbody>
                {lista.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.poFolio || c.fecha}</strong></td>
                    <td className="muted">{(c.grupos ?? []).map((g) => g.proveedor).join(', ')}</td>
                    <td className="muted">{c.fecha} · {c.esGeneral ? 'General' : `Unidad ${c.unidadNumero}`}</td>
                    <td className="muted">
                      {c.fechaVence
                        ? <>{c.fechaVence < hoyStr && <span className="punto-estado vencido" />}{c.fechaVence}</>
                        : '—'}
                    </td>
                    <td className="num">{dinero(c.totalGeneralUSD, 'USD')}</td>
                    <td><AdjuntoCompra compra={c} campo="factura_path" url={c.facturaURL} label="factura" carpeta="factura" /></td>
                    <td><AdjuntoCompra compra={c} campo="xml_path" url={c.xmlURL} label="XML" carpeta="xml" /></td>
                    <td><button type="button" className="btn-secundario" onClick={() => setPagando(c)}>Registrar pago</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <h3>Pagadas ({pagadas.length})</h3>
      {compras !== null && pagadas.length === 0 && <p className="muted vacio">Sin cuentas pagadas todavía.</p>}
      {pagadas.length > 0 && (
        <div className="tabla-scroll">
          <table className="tabla-densa">
            <thead>
              <tr>
                <th>Folio</th><th>Proveedor</th><th>Compra</th><th>Pagada el</th>
                <th className="num">Total</th><th>Factura</th><th>XML</th>
              </tr>
            </thead>
            <tbody>
              {pagadas.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.poFolio || c.fecha}</strong></td>
                  <td className="muted">{(c.grupos ?? []).map((g) => g.proveedor).join(', ')}</td>
                  <td className="muted">{c.fecha} · {c.esGeneral ? 'General' : `Unidad ${c.unidadNumero}`}</td>
                  <td className="muted">{c.pagadoAt}</td>
                  <td className="num">{dinero(c.totalGeneralUSD, 'USD')}</td>
                  <td><AdjuntoCompra compra={c} campo="factura_path" url={c.facturaURL} label="factura" carpeta="factura" /></td>
                  <td><AdjuntoCompra compra={c} campo="xml_path" url={c.xmlURL} label="XML" carpeta="xml" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
