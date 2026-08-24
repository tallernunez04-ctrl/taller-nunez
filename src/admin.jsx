import { useEffect, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import { FALLA_LABEL, LECTURA_LABEL, piezasLista } from './taller'
import {
  ESTATUS, mapCompra, mapWO, METODOS, SELECT_COMPRA, SELECT_WO, SelectorUnidad,
  useTabla, useUnidades, useTipoCambio, usePrecioDiesel, BarraAcciones,
} from './compras'
import { dinero, r2, hoy } from './utils/format'
import { exportarXlsx } from './utils/exportarXlsx'

const METODO_LABEL = Object.fromEntries(METODOS)
const TIPO_LABEL = { truck: 'Truck', reefer: 'Reefer', plataforma: 'Plataforma', caja_seca: 'Caja seca' }
const COLOR_TIPO = { truck: '#C9A84C', reefer: '#7A1C2E', plataforma: '#5A7CA6', caja_seca: '#6E6E6E' }

const mesActual = () => hoy().slice(0, 7) // YYYY-MM
const haceUnMes = () => {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return d.toLocaleDateString('sv')
}
const piezasTexto = (p) => piezasLista(p).map((x, i) => `${i + 1}. ${x}`).join('\n')
const fallasTexto = (tf) => (tf || []).map((f) => FALLA_LABEL[f]).join(', ')

export default function Admin({ vista }) {
  if (vista === 'dashboard') return <Dashboard />
  if (vista === 'detalle-unidad') return <DetalleUnidad />
  if (vista === 'usuarios') return <Usuarios />
  return <Gastos />
}

/* ---------- Sección Gastos ---------- */

function Gastos() {
  const [desde, setDesde] = useState(haceUnMes())
  const [hasta, setHasta] = useState(hoy())
  const [fUnidad, setFUnidad] = useState('')
  const [fMoneda, setFMoneda] = useState('')
  const unidades = useUnidades()
  const tipoDe = Object.fromEntries(unidades.map((u) => [u.id, u.tipo]))
  const compras = useTabla('compras', mapCompra, (q) => q.select(SELECT_COMPRA).order('created_at', { ascending: false }))

  const lista = (compras ?? []).filter((c) =>
    (!desde || c.fecha >= desde) && (!hasta || c.fecha <= hasta)
    && (!fUnidad || c.unidadId === fUnidad)
    && (!fMoneda || (c.grupos ?? []).some((g) => g.moneda === fMoneda)))

  return (
    <div>
      <h2>Gastos</h2>
      <div className="fila-2">
        <label className="campo"><span>Desde</span>
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label className="campo"><span>Hasta</span>
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </label>
      </div>
      <SelectorUnidad unidades={unidades} value={fUnidad} onChange={setFUnidad} placeholder="Todas las unidades" />
      <label className="campo"><span>Incluye moneda</span>
        <select value={fMoneda} onChange={(e) => setFMoneda(e.target.value)}>
          <option value="">Todas</option>
          <option value="MXN">MXN</option>
          <option value="USD">USD</option>
        </select>
      </label>

      {lista.length > 0 && (
        <div className="acciones">
          <button className="btn-secundario" onClick={() => exportarReporteGastos(lista, desde, hasta)}>
            Descargar reporte detallado (Excel)
          </button>
        </div>
      )}

      {compras === null && <p className="muted">Cargando…</p>}
      {compras !== null && lista.length === 0 && <p className="muted vacio">Sin gastos en este rango.</p>}
      {lista.map((c) => (
        <GastoCard key={c.id} c={c} tipo={TIPO_LABEL[tipoDe[c.unidadId]] ?? ''} />
      ))}
    </div>
  )
}

function exportarReporteGastos(lista, desde, hasta) {
  const filas = lista.flatMap((c) => (c.grupos ?? []).flatMap((g, gi) => g.conceptos.map((l, i) => [
    c.fecha, c.woNumero || 'Sin WO', c.unidadNumero, METODO_LABEL[c.metodoPago] ?? c.metodoPago,
    g.proveedor, g.folioFactura || '', g.moneda,
    l.concepto, l.cantidad, l.costoUnitario, l.subtotal, l.tasaIVA, l.iva, l.total,
    gi === 0 && i === 0 ? c.totalGeneralUSD : '', gi === 0 && i === 0 ? (c.notas || '') : '',
  ])))
  const totalUSD = r2(lista.reduce((s, c) => s + (c.totalGeneralUSD ?? 0), 0))
  exportarXlsx({
    nombreArchivo: `Reporte_gastos_${desde || 'inicio'}_a_${hasta || 'hoy'}.xlsx`,
    hojas: [{
      nombre: 'Gastos',
      datos: [
        ['Fecha', 'WO', 'Unidad', 'Método de pago', 'Proveedor', 'Folio', 'Moneda', 'Concepto', 'Cantidad', 'Costo unit.', 'Subtotal', 'IVA %', 'IVA $', 'Total línea', 'Total compra (USD)', 'Notas'],
        ...filas,
        [],
        ['', '', '', '', '', '', '', '', '', '', '', '', '', 'TOTAL (USD)', totalUSD],
      ],
    }],
  })
}

function GastoCard({ c, tipo }) {
  const [abierto, setAbierto] = useState(false)
  const [wo, setWo] = useState(null)

  useEffect(() => {
    if (abierto && c.woId && !wo) {
      supabase.from('work_orders').select(SELECT_WO).eq('id', c.woId).single()
        .then(({ data, error }) => { if (!error && data) setWo(mapWO(data)) })
        .catch(console.error)
    }
  }, [abierto, c.woId, wo])

  return (
    <div className="tarjeta">
      <div className="gasto-cab" onClick={() => setAbierto(!abierto)}>
        <div className="tarjeta-top">
          <strong>{dinero(c.totalGeneralUSD, 'USD')}</strong>
          <span className="muted">{abierto ? '▾' : '▸'}</span>
        </div>
        <div className="muted">
          {c.fecha} · Unidad <strong>{c.unidadNumero}</strong>{tipo && ` (${tipo})`} · {c.woNumero || 'Compra directa'}
        </div>
        <div className="muted">
          {METODO_LABEL[c.metodoPago] ?? c.metodoPago}
          {' · '}{(c.grupos ?? []).map((g) => g.proveedor).filter(Boolean).join(', ')} · {c.creadoPor}
        </div>
      </div>
      {abierto && (
        <div className="subseccion">
          {c.notas && <p><span className="muted">Notas:</span> {c.notas}</p>}
          {(c.grupos ?? []).map((g, gi) => (
            <div key={gi} className="grupo-proveedor">
              <div className="tarjeta-top">
                <strong>{g.proveedor}</strong>
                <span className="muted">{g.moneda}{g.folioFactura && ` · Folio ${g.folioFactura}`}</span>
              </div>
              <div className="tabla-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Concepto</th><th className="num">Cant.</th>
                      <th className="num">Costo unit.</th><th className="num">Subtotal</th>
                      <th className="num">IVA %</th><th className="num">IVA $</th><th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.conceptos.map((l, i) => (
                      <tr key={i}>
                        <td>{l.concepto}</td><td className="num">{l.cantidad}</td>
                        <td className="num">{dinero(l.costoUnitario, g.moneda)}</td>
                        <td className="num">{dinero(l.subtotal, g.moneda)}</td>
                        <td className="num">{l.tasaIVA}%</td>
                        <td className="num">{dinero(l.iva, g.moneda)}</td>
                        <td className="num">{dinero(l.total, g.moneda)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="linea-calc grupo-total">
                <span className="muted">Total proveedor</span>
                <strong>
                  {dinero(g.total, g.moneda)}
                  {g.moneda === 'MXN' ? ` · ${dinero(g.totalUSD, 'USD')}` : ''}
                </strong>
              </div>
            </div>
          ))}
          <div className="totales">
            <div><span className="muted">Subtotal general (USD)</span><span>{dinero(c.subtotalGeneralUSD, 'USD')}</span></div>
            <div><span className="muted">IVA general (USD)</span><span>{dinero(c.ivaGeneralUSD, 'USD')}</span></div>
            <div className="total-grande"><span>TOTAL GENERAL</span><span>{dinero(c.totalGeneralUSD, 'USD')}</span></div>
          </div>
          {wo && (
            <div className="subseccion">
              <p><strong>{wo.wo}</strong> <span className={'badge ' + wo.estatus}>{ESTATUS[wo.estatus]}</span></p>
              {wo.mecanico && <p><span className="muted">Mecánico:</span> {wo.mecanico}</p>}
              {wo.tipoFalla?.length > 0 && <p><span className="muted">Fallas:</span> {fallasTexto(wo.tipoFalla)}</p>}
              {wo.diagnostico && <p><span className="muted">Diagnóstico:</span> {wo.diagnostico}</p>}
              {piezasLista(wo.piezasRequeridas).length > 0 && (
                <div>
                  <span className="muted">Piezas requeridas:</span>
                  <ol className="lista-piezas">
                    {piezasLista(wo.piezasRequeridas).map((p, i) => <li key={i}>{p}</li>)}
                  </ol>
                </div>
              )}
            </div>
          )}
          <div className="acciones">
            <button className="btn-primario" onClick={() => exportarGasto(c, wo)}>Descargar Excel</button>
          </div>
        </div>
      )}
    </div>
  )
}

function exportarGasto(c, wo) {
  const hoja1 = [
    ['Fecha', c.fecha],
    ['Unidad', c.unidadNumero],
    ['WO', c.woNumero || 'Compra directa'],
    ['Método de pago', METODO_LABEL[c.metodoPago] ?? c.metodoPago],
    ['Notas', c.notas || ''],
    ['Creado por', c.creadoPor],
    ['TC usado (MXN/USD)', c.tipoCambioUsado ?? ''],
    [],
  ]
  ;(c.grupos ?? []).forEach((g) => {
    hoja1.push(['Proveedor', g.proveedor, 'Moneda', g.moneda, 'Folio', g.folioFactura || ''])
    hoja1.push(['Concepto', 'Cantidad', 'Costo unit.', 'Subtotal', 'IVA %', 'IVA $', 'Total'])
    g.conceptos.forEach((l) => hoja1.push([l.concepto, l.cantidad, l.costoUnitario, l.subtotal, l.tasaIVA, l.iva, l.total]))
    hoja1.push(['', '', '', '', '', 'Total proveedor', g.total])
    hoja1.push(['', '', '', '', '', 'Equivalente USD', g.totalUSD])
    hoja1.push([])
  })
  hoja1.push(['', '', '', '', '', 'Subtotal general (USD)', c.subtotalGeneralUSD])
  hoja1.push(['', '', '', '', '', 'IVA general (USD)', c.ivaGeneralUSD])
  hoja1.push(['', '', '', '', '', 'TOTAL GENERAL (USD)', c.totalGeneralUSD])
  const hojas = [{ nombre: 'Compra', datos: hoja1 }]
  if (wo) {
    hojas.push({
      nombre: 'Work Order',
      datos: [
        ['WO', wo.wo],
        ['Fecha', wo.fecha],
        ['Estatus', ESTATUS[wo.estatus]],
        ['Unidad', wo.unidadNumero],
        ['Lectura', wo.lectura?.valor ? `${wo.lectura.valor} ${wo.lectura.unidad}` : ''],
        ['Chofer', wo.chofer || ''],
        ['Mecánico', wo.mecanico || ''],
        ['Tipos de falla', fallasTexto(wo.tipoFalla)],
        ['Diagnóstico', wo.diagnostico || ''],
        ['Piezas requeridas', piezasTexto(wo.piezasRequeridas)],
        ['Notas del mecánico', wo.notasMecanico || ''],
      ],
    })
  }
  exportarXlsx({ nombreArchivo: `Gasto_${c.unidadNumero}_${c.fecha}.xlsx`, hojas })
}

/* ---------- Sección Dashboard ---------- */

function Dashboard() {
  const [mes, setMes] = useState(mesActual())
  const [tcInput, setTcInput] = useState('')
  const [dieselInput, setDieselInput] = useState('')
  const unidades = useUnidades()
  const compras = useTabla('compras', mapCompra, (q) => q.select(SELECT_COMPRA)) ?? []
  const wos = useTabla('work_orders', mapWO, (q) => q.select(SELECT_WO)) ?? []
  const tc = useTipoCambio()
  const precioDiesel = usePrecioDiesel()

  useEffect(() => { if (tc != null) setTcInput(String(tc)) }, [tc])
  useEffect(() => { if (precioDiesel != null) setDieselInput(String(precioDiesel)) }, [precioDiesel])

  const comprasMes = compras.filter((c) => (c.fecha || '').startsWith(mes))
  const wosCompletadas = wos.filter((w) =>
    w.estatus === 'completado'
    && (w.completadoAt ? new Date(w.completadoAt).toLocaleDateString('sv') : '').startsWith(mes))

  // cada compra ya trae su totalGeneralUSD consolidado desde el formulario
  const totalUSD = r2(comprasMes.reduce((s, c) => s + (c.totalGeneralUSD ?? 0), 0))

  const tipoDe = Object.fromEntries(unidades.map((u) => [u.id, u.tipo]))
  const porUnidad = {}
  comprasMes.forEach((c) => {
    const p = porUnidad[c.unidadId] ?? (porUnidad[c.unidadId] = { numero: c.unidadNumero, total: 0, compras: 0 })
    p.compras += 1
    p.total = r2(p.total + (c.totalGeneralUSD ?? 0))
  })
  const filas = Object.entries(porUnidad)
    .map(([id, p]) => ({ id, ...p, tipo: tipoDe[id] ?? 'truck' }))
    .sort((a, b) => b.total - a.total)

  const actualizarTC = async () => {
    const v = Number(tcInput)
    if (!v || v <= 0) { alert('Tipo de cambio inválido'); return }
    const { error } = await supabase.from('config').update({ tipo_cambio_usd: v }).eq('id', true)
    if (error) alert('Error: ' + error.message)
  }

  return (
    <div>
      <h2>Dashboard</h2>
      <label className="campo"><span>Mes</span>
        <input type="month" value={mes} max={mesActual()} onChange={(e) => setMes(e.target.value)} />
      </label>

      <div className="kpis">
        <div className="kpi grande">Total gastado (USD)<strong>{dinero(totalUSD, 'USD')}</strong></div>
        <div className="kpi">WOs completadas<strong>{wosCompletadas.length}</strong></div>
        <div className="kpi">Compras registradas<strong>{comprasMes.length}</strong></div>
      </div>

      <div className="tc-fila">
        <span className="muted">TC USD→MXN</span>
        <input type="number" step="0.01" min="0" value={tcInput} onChange={(e) => setTcInput(e.target.value)} />
        <button className="btn-primario" onClick={actualizarTC}>Actualizar</button>
      </div>

      <div className="tc-fila">
        <span className="muted">Diésel $/L (MXN)</span>
        <input type="number" step="0.01" min="0" value={dieselInput} onChange={(e) => setDieselInput(e.target.value)} />
        <button className="btn-primario" onClick={async () => {
          const v = Number(dieselInput)
          if (!v || v <= 0) { alert('Precio inválido'); return }
          const { error } = await supabase.from('config').update({ precio_diesel_litro: v }).eq('id', true)
          if (error) alert('Error: ' + error.message)
        }}>Actualizar</button>
      </div>

      <h3>Gasto por unidad (USD)</h3>
      {filas.length === 0 ? (
        <p className="muted vacio">Sin gastos en {mes}.</p>
      ) : (
        <div className="barras">
          {filas.map((x) => (
            <div key={x.id} className="barra-fila">
              <span className="barra-label">{x.numero}</span>
              <div className="barra-pista">
                <div
                  className="barra"
                  style={{ width: `${(x.total / (filas[0].total || 1)) * 100}%`, background: COLOR_TIPO[x.tipo] }}
                />
              </div>
              <span className="barra-valor">{dinero(x.total, 'USD')}</span>
            </div>
          ))}
        </div>
      )}

      {filas.length > 0 && (
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr>
                <th>Unidad</th><th>Tipo</th><th className="num"># Compras</th>
                <th className="num">Total USD</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((x) => (
                <tr key={x.id}>
                  <td><strong>{x.numero}</strong></td>
                  <td>{TIPO_LABEL[x.tipo]}</td>
                  <td className="num">{x.compras}</td>
                  <td className="num">{dinero(x.total, 'USD')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ---------- Sección Detalle por Unidad ---------- */

function DetalleUnidad() {
  const unidades = useUnidades()
  const [unidadId, setUnidadId] = useState('')
  const [wos, setWos] = useState([])
  const [compras, setCompras] = useState([])
  const unidad = unidades.find((u) => u.id === unidadId)

  useEffect(() => {
    if (!unidadId) { setWos([]); setCompras([]); return }
    supabase.from('work_orders').select(SELECT_WO).eq('unidad_id', unidadId).then(({ data, error }) => {
      if (error) { console.error(error); return }
      setWos(data.map(mapWO).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')))
    })
    supabase.from('compras').select(SELECT_COMPRA).eq('unidad_id', unidadId).then(({ data, error }) => {
      if (error) { console.error(error); return }
      setCompras(data.map(mapCompra).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')))
    })
  }, [unidadId])

  const totalUSD = r2(compras.reduce((s, c) => s + (c.totalGeneralUSD ?? 0), 0))
  const directas = compras.filter((c) => !c.woId)

  return (
    <div>
      <h2>Detalle por Unidad</h2>
      <SelectorUnidad unidades={unidades} value={unidadId} onChange={setUnidadId} placeholder="Selecciona unidad…" />

      {unidad && (
        <>
          <div className="tarjeta detalle">
            <div className="tarjeta-top">
              <strong>{unidad.numero}</strong>
              <span className="muted">{TIPO_LABEL[unidad.tipo]}</span>
            </div>
            {(unidad.marca || unidad.anio || unidad.modelo) && (
              <p>{[unidad.marca, unidad.anio, unidad.modelo].filter(Boolean).join(' ')}</p>
            )}
            {unidad.vin && <p><span className="muted">VIN:</span> {unidad.vin}</p>}
            <p><span className="muted">Lectura:</span> {LECTURA_LABEL[unidad.unidadLectura]}
              {unidad.ultimaLectura != null && ` · última: ${unidad.ultimaLectura.toLocaleString()} ${unidad.unidadLectura === 'hrs' ? 'hrs' : 'km'}`}</p>
            <p><span className="muted">Total histórico:</span> <strong>{dinero(totalUSD, 'USD')}</strong></p>
          </div>

          <h3>Historial de reparaciones ({wos.length})</h3>
          {wos.length === 0 && <p className="muted">Sin WOs para esta unidad.</p>}
          {wos.map((w) => (
            <WOExpandible key={w.id} wo={w} compras={compras.filter((c) => c.woId === w.id)} />
          ))}

          <h3>Compras directas ({directas.length})</h3>
          {directas.length === 0 && <p className="muted">Sin compras directas.</p>}
          {directas.map((c) => (
            <div key={c.id} className="tarjeta detalle">
              <div className="tarjeta-top">
                <span>{c.fecha}</span>
                <strong>{dinero(c.totalGeneralUSD, 'USD')}</strong>
              </div>
              <div className="muted">
                {(c.grupos ?? []).flatMap((g) => g.conceptos).map((x) => x.concepto).filter(Boolean).join(', ')}
              </div>
              {c.notas && <div className="muted">{c.notas}</div>}
            </div>
          ))}

          <div className="acciones">
            <button className="btn-primario" onClick={() => exportarHistorial(unidad, wos, compras, totalUSD)}>
              Descargar Excel
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function WOExpandible({ wo, compras }) {
  const [abierto, setAbierto] = useState(false)
  return (
    <div className="tarjeta">
      <div className="gasto-cab" onClick={() => setAbierto(!abierto)}>
        <div className="tarjeta-top">
          <strong>{wo.wo}</strong>
          <span className={'badge ' + wo.estatus}>{ESTATUS[wo.estatus]}</span>
        </div>
        <div className="muted">{wo.fecha}{wo.mecanico && ` · ${wo.mecanico}`} <span style={{ float: 'right' }}>{abierto ? '▾' : '▸'}</span></div>
      </div>
      {abierto && (
        <div className="subseccion detalle">
          {wo.lectura?.valor > 0 && <p><span className="muted">Lectura:</span> {wo.lectura.valor.toLocaleString()} {wo.lectura.unidad}</p>}
          {wo.tipoFalla?.length > 0 && <p><span className="muted">Fallas:</span> {fallasTexto(wo.tipoFalla)}</p>}
          {wo.diagnostico && <p><span className="muted">Diagnóstico:</span> {wo.diagnostico}</p>}
          {piezasLista(wo.piezasRequeridas).length > 0 && (
            <div>
              <span className="muted">Piezas requeridas:</span>
              <ol className="lista-piezas">
                {piezasLista(wo.piezasRequeridas).map((p, i) => <li key={i}>{p}</li>)}
              </ol>
            </div>
          )}
          {wo.notasMecanico && <p><span className="muted">Notas:</span> {wo.notasMecanico}</p>}
          {compras.length > 0 && (
            <>
              <p><span className="muted">Compras de esta WO:</span></p>
              {compras.map((c) => (
                <div key={c.id} className="tarjeta-top">
                  <span className="muted">{c.fecha}</span>
                  <strong>{dinero(c.totalGeneralUSD, 'USD')}</strong>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function exportarHistorial(unidad, wos, compras, totalUSD) {
  exportarXlsx({
    nombreArchivo: `Historial_${unidad.numero}.xlsx`,
    hojas: [
      {
        nombre: 'Unidad',
        datos: [
          ['Unidad', unidad.numero],
          ['Tipo', TIPO_LABEL[unidad.tipo]],
          ['Marca', unidad.marca || ''],
          ['Año', unidad.anio || ''],
          ['Modelo', unidad.modelo || ''],
          ['VIN', unidad.vin || ''],
          ['Unidad de lectura', unidad.unidadLectura],
          ['Última lectura', unidad.ultimaLectura != null ? `${unidad.ultimaLectura} ${unidad.unidadLectura === 'hrs' ? 'hrs' : 'km'}` : ''],
          ['Total histórico (USD)', totalUSD],
        ],
      },
      {
        nombre: 'Work Orders',
        datos: [
          ['WO', 'Fecha', 'Estatus', 'Mecánico', 'Chofer', 'Lectura', 'Unidad lectura', 'Tipos de falla', 'Diagnóstico', 'Piezas requeridas', 'Notas'],
          ...wos.map((w) => [
            w.wo, w.fecha, ESTATUS[w.estatus], w.mecanico || '', w.chofer || '',
            w.lectura?.valor ?? '', w.lectura?.unidad ?? '',
            fallasTexto(w.tipoFalla), w.diagnostico || '', piezasTexto(w.piezasRequeridas), w.notasMecanico || '',
          ]),
        ],
      },
      {
        nombre: 'Compras',
        datos: [
          ['Fecha', 'WO', 'Método de pago', 'Proveedor', 'Folio', 'Moneda', 'Concepto', 'Cantidad', 'Costo unit.', 'Subtotal', 'IVA %', 'IVA $', 'Total línea', 'Total compra (USD)', 'Notas'],
          ...compras.flatMap((c) => (c.grupos ?? []).flatMap((g, gi) => g.conceptos.map((l, i) => [
            c.fecha, c.woNumero || 'Directa', METODO_LABEL[c.metodoPago] ?? c.metodoPago, g.proveedor, g.folioFactura || '', g.moneda,
            l.concepto, l.cantidad, l.costoUnitario, l.subtotal, l.tasaIVA, l.iva, l.total,
            gi === 0 && i === 0 ? c.totalGeneralUSD : '', gi === 0 && i === 0 ? (c.notas || '') : '',
          ]))),
        ],
      },
    ],
  })
}

/* ---------- Sección Usuarios ---------- */

function Usuarios() {
  const [usuarios, setUsuarios] = useState(null)
  const [editando, setEditando] = useState(null) // fila perfiles | 'nuevo' | null

  useEffect(() => {
    const cargar = () => supabase.from('perfiles').select('*').then(({ data, error }) => {
      if (error) { console.error(error); return }
      setUsuarios(data.filter((u) => u.oculto !== true))
    })
    cargar()
    const canal = supabase
      .channel(`perfiles-cambios-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'perfiles' }, cargar)
      .subscribe()
    return () => supabase.removeChannel(canal)
  }, [])

  if (editando) {
    return <UsuarioForm existente={editando === 'nuevo' ? null : editando} onDone={() => setEditando(null)} />
  }

  return (
    <div>
      <h2>Usuarios</h2>
      {usuarios === null && <p className="muted">Cargando…</p>}
      {(usuarios ?? []).map((u) => (
        <button key={u.id} className="tarjeta" onClick={() => setEditando(u)}>
          <div className="tarjeta-top">
            <strong>{u.nombre}</strong>
            <span className={'badge ' + (u.activo ? 'completado' : 'inactivo')}>
              {u.activo ? 'Activo' : 'Inactivo'}
            </span>
          </div>
          <div className="muted">{u.email} · {u.rol}</div>
        </button>
      ))}
      <button className="fab" onClick={() => setEditando('nuevo')} aria-label="Agregar usuario">+</button>
    </div>
  )
}

function UsuarioForm({ existente, onDone }) {
  const [f, setF] = useState(existente ?? { email: '', nombre: '', rol: 'taller', activo: true })
  const [guardando, setGuardando] = useState(false)
  const [cerrandoSesiones, setCerrandoSesiones] = useState(false)

  const cerrarSesiones = async () => {
    if (!confirm(`¿Cerrar la sesión de ${existente.email} en todos sus dispositivos? Se le asigna una contraseña nueva (se la tienes que compartir) y tendrá que volver a iniciar sesión.`)) return
    setCerrandoSesiones(true)
    try {
      const { data, error } = await supabase.functions.invoke('cerrar-sesiones', { body: { usuarioId: existente.id } })
      if (error) throw error
      alert(`Sesiones cerradas.\n\nContraseña nueva: ${data.password}\n\nCompártela ahora, no se vuelve a mostrar.`)
    } catch (e) {
      alert('Error: ' + (e.context ? await e.context.text?.().catch(() => e.message) : e.message))
    } finally {
      setCerrandoSesiones(false)
    }
  }

  const guardar = async () => {
    setGuardando(true)
    try {
      if (existente) {
        const { error } = await supabase.from('perfiles')
          .update({ nombre: f.nombre, rol: f.rol, activo: f.activo }).eq('id', existente.id)
        if (error) throw error
      } else {
        const email = f.email.trim().toLowerCase()
        if (!email.includes('@')) { alert('Escribe un correo válido'); return }
        const { data, error } = await supabase.functions.invoke('crear-usuario', {
          body: { email, nombre: f.nombre, rol: f.rol },
        })
        if (error) throw error
        alert(`Usuario creado.\n\nEmail: ${data.email}\nContraseña temporal: ${data.password}\n\nCompártela ahora, no se vuelve a mostrar.`)
      }
      onDone()
    } catch (e) {
      alert('Error al guardar: ' + (e.context ? await e.context.text?.().catch(() => e.message) : e.message))
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div>
      <BarraAcciones onAtras={onDone} onGuardar={guardar} guardando={guardando} />
      <h2>{existente ? existente.email : 'Agregar usuario'}</h2>
      {!existente && (
        <label className="campo"><span>Correo</span>
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="alguien@gmail.com" />
        </label>
      )}
      <label className="campo"><span>Nombre</span>
        <input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} />
      </label>
      <label className="campo"><span>Rol</span>
        <select value={f.rol} onChange={(e) => setF({ ...f, rol: e.target.value })}>
          <option value="chofer">chofer</option>
          <option value="dispatch">dispatch</option>
          <option value="taller">taller</option>
          <option value="compras">compras</option>
          <option value="admin">admin</option>
        </select>
      </label>
      {existente && (
        <label className="campo" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} />
          <span style={{ margin: 0 }}>Activo (puede iniciar sesión)</span>
        </label>
      )}
      {existente && (
        <button type="button" className="btn-secundario" disabled={cerrandoSesiones} onClick={cerrarSesiones}>
          {cerrandoSesiones ? 'Cerrando…' : 'Cerrar sesión en todos los dispositivos'}
        </button>
      )}
    </div>
  )
}
