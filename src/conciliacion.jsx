import { useEffect, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import { aUSD, mapCompra, SELECT_COMPRA, useTabla, useTipoCambio, useUnidades } from './compras'
import { mapViaje, SELECT_VIAJE, useViajes } from './viajes'
import { cargasEnRango } from './diesel'
import { dinero, r2, hoy } from './utils/format'

/* Conciliación gerencial. Los KPIs del mes salen de obtener_balance_mensual(), RPC
   security definer sobre v_balance_mensual que valida admin explícitamente (la vista
   agrega TODA la empresa sin dueño de fila, así que no se expone directo -- ver
   20260831150000_asegura_vistas_agregadas.sql); los cruces (auditoría de litros,
   rentabilidad) usan queries acotadas por rango de fecha — nunca el historial completo. */

const mesActual = () => hoy().slice(0, 7)
const finDeMes = (mes) => mes + '-31' // válido para comparar strings YYYY-MM-DD

const sumaDias = (dias) => {
  const d = new Date()
  d.setDate(d.getDate() + dias)
  return d.toLocaleDateString('sv')
}

const mapBalance = (b) => ({
  ingresosViajes: Number(b.ingresos_viajes) || 0,
  costoCompras: Number(b.costo_compras) || 0,
  costoDieselFacturado: Number(b.costo_diesel_facturado) || 0,
  litrosFacturados: Number(b.litros_facturados) || 0,
  costoNomina: Number(b.costo_nomina) || 0,
})

export default function Conciliacion() {
  const [mes, setMes] = useState(mesActual())
  const [balance, setBalance] = useState(null)
  const [cargasMes, setCargasMes] = useState([])

  useEffect(() => {
    supabase.rpc('obtener_balance_mensual', { p_mes: mes + '-01' }).maybeSingle()
      .then(({ data, error }) => { if (error) { console.error(error); return } setBalance(data ? mapBalance(data) : {}) })
  }, [mes])

  // litros reportados por choferes en el mes
  useEffect(() => {
    cargasEnRango(mes + '-01', finDeMes(mes)).then(setCargasMes).catch(console.error)
  }, [mes])

  const litrosReportados = r2(cargasMes.reduce((s, c) => s + (c.litros || 0) + (c.caja?.litros || 0), 0))
  const litrosFacturados = balance?.litrosFacturados || 0
  const desviacion = litrosFacturados > 0
    ? r2(Math.abs(litrosReportados - litrosFacturados) / litrosFacturados * 100)
    : null

  const ingresos = balance?.ingresosViajes || 0
  const egresos = r2((balance?.costoCompras || 0) + (balance?.costoNomina || 0))

  return (
    <div>
      <h2>Conciliación</h2>
      <label className="campo"><span>Mes</span>
        <input type="month" value={mes} max={mesActual()} onChange={(e) => setMes(e.target.value)} />
      </label>

      <div className="kpis">
        <div className="kpi grande">Utilidad del mes (facturado − gastado)<strong>{dinero(r2(ingresos - egresos), 'USD')}</strong></div>
        <div className="kpi">Ingresos facturados<strong>{dinero(ingresos, 'USD')}</strong></div>
        <div className="kpi">Compras<strong>{dinero(balance?.costoCompras || 0, 'USD')}</strong></div>
        <div className="kpi">Nómina pagada<strong>{dinero(balance?.costoNomina || 0, 'USD')}</strong></div>
        <div className="kpi">Diésel facturado<strong>{dinero(balance?.costoDieselFacturado || 0, 'USD')}</strong></div>
      </div>

      <h3>Auditoría de combustible</h3>
      <div className="kpis">
        <div className="kpi">Litros reportados (choferes)<strong>{litrosReportados.toLocaleString()}</strong></div>
        <div className="kpi">Litros facturados (gasolinera)<strong>{litrosFacturados.toLocaleString()}</strong></div>
      </div>
      {desviacion === null ? (
        <p className="muted">Registra facturas de diésel en Compras (con litros) para activar la auditoría.</p>
      ) : desviacion > 2 ? (
        <p className="error">⚠ Discrepancia del {desviacion}% entre lo reportado y lo facturado — revisar cargas del mes.</p>
      ) : (
        <p><span className="badge completado">Sin discrepancias relevantes ({desviacion}%)</span></p>
      )}

      <FlujoDeCaja />
      <Rentabilidad mes={mes} />
    </div>
  )
}

/* ---------- Flujo de caja proyectado (7 / 15 / 30 días) ---------- */

function FlujoDeCaja() {
  // cuentas por cobrar: viajes facturados sin pagar
  const todosViajes = useViajes() ?? []
  const viajes = todosViajes.filter((v) => v.cobranza?.fechaFactura && !v.cobranza?.pagado)
  // cuentas por pagar: compras a crédito sin pagar
  const compras = useTabla('compras', mapCompra, (q) => q.select(SELECT_COMPRA).eq('pagado', false)) ?? []

  const horizontes = [7, 15, 30].map((dias) => {
    const limite = sumaDias(dias)
    const cobros = r2(viajes.filter((v) => v.cobranza.fechaVence <= limite).reduce((s, v) => s + (v.precio || 0), 0))
    const pagos = r2(compras.filter((c) => (c.fechaVence || '') <= limite).reduce((s, c) => s + (c.totalGeneralUSD || 0), 0))
    return { dias, cobros, pagos, neto: r2(cobros - pagos) }
  })

  // gráfica: cobros vs pagos acumulados por día (30 días), SVG puro
  const W = 600; const H = 160; const M = 8
  const puntos = Array.from({ length: 31 }, (_, i) => {
    const limite = sumaDias(i)
    return {
      cobros: viajes.filter((v) => v.cobranza.fechaVence <= limite).reduce((s, v) => s + (v.precio || 0), 0),
      pagos: compras.filter((c) => (c.fechaVence || '') <= limite).reduce((s, c) => s + (c.totalGeneralUSD || 0), 0),
    }
  })
  const max = Math.max(1, ...puntos.map((p) => Math.max(p.cobros, p.pagos)))
  const linea = (serie) => puntos
    .map((p, i) => `${M + (i / 30) * (W - 2 * M)},${H - M - (p[serie] / max) * (H - 2 * M)}`)
    .join(' ')

  return (
    <>
      <h3>Flujo de caja proyectado</h3>
      <div className="kpis">
        {horizontes.map((h) => (
          <div key={h.dias} className="kpi">
            A {h.dias} días
            <strong className={h.neto < 0 ? 'error' : ''}>{dinero(h.neto, 'USD')}</strong>
            <span className="muted" style={{ fontSize: '0.72rem' }}>
              +{dinero(h.cobros, 'USD')} / −{dinero(h.pagos, 'USD')}
            </span>
          </div>
        ))}
      </div>
      {(viajes.length > 0 || compras.length > 0) && (
        <div className="tabla-scroll">
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxHeight: 200, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '0.75rem' }}>
            <polyline points={linea('cobros')} fill="none" stroke="#2E6B3E" strokeWidth="2.5" />
            <polyline points={linea('pagos')} fill="none" stroke="#B03A3A" strokeWidth="2.5" />
            <text x={M + 4} y={16} fontSize="11" fill="#2E6B3E">Cobros acumulados (30 días)</text>
            <text x={M + 4} y={30} fontSize="11" fill="#B03A3A">Pagos acumulados</text>
          </svg>
        </div>
      )}
      {viajes.length === 0 && compras.length === 0 && (
        <p className="muted">Sin cobros ni pagos pendientes con fecha de vencimiento.</p>
      )}
    </>
  )
}

/* ---------- Rentabilidad real por unidad ---------- */

function Rentabilidad({ mes }) {
  const unidades = useUnidades()
  const tc = useTipoCambio()
  const [viajes, setViajes] = useState([])
  const [compras, setCompras] = useState([])
  const [cargas, setCargas] = useState([])

  useEffect(() => {
    const desde = mes + '-01'
    const hasta = finDeMes(mes)
    Promise.all([
      supabase.from('viajes').select(SELECT_VIAJE).gte('fecha', desde).lte('fecha', hasta),
      supabase.from('compras').select(SELECT_COMPRA).gte('fecha', desde).lte('fecha', hasta),
      cargasEnRango(desde, hasta),
    ])
      .then(([v, c, d]) => {
        if (v.error) throw v.error
        setViajes(v.data.map((x) => mapViaje(x)))
        if (c.error) throw c.error
        setCompras(c.data.map(mapCompra))
        setCargas(d)
      })
      .catch(console.error)
  }, [mes])

  const filas = unidades
    .filter((u) => u.tipo === 'truck')
    .map((u) => {
      const suyos = viajes.filter((v) => v.unidadId === u.id)
      const ingreso = r2(suyos.reduce((s, v) => s + (v.precio || 0), 0))
      const pagoChofer = r2(suyos.reduce((s, v) => s + (v.costeoEstimado?.pagoChofer || 0), 0))
      const taller = r2(compras.filter((c) => c.unidadId === u.id && !c.esDiesel)
        .reduce((s, c) => s + (c.totalGeneralUSD || 0), 0))
      const dieselMXN = cargas.filter((c) => c.unidadId === u.id)
        .reduce((s, c) => s + (c.costoTotal || 0) + (c.caja?.costo || 0), 0)
      const diesel = aUSD(r2(dieselMXN), 'MXN', tc)
      const utilidad = r2(ingreso - pagoChofer - taller - diesel)
      return { id: u.id, numero: u.numero, viajes: suyos.length, ingreso, pagoChofer, taller, diesel, utilidad }
    })
    .filter((x) => x.viajes > 0 || x.taller > 0 || x.diesel > 0)
    .sort((a, b) => b.utilidad - a.utilidad)

  return (
    <>
      <h3>Rentabilidad por unidad ({mes})</h3>
      {filas.length === 0 && <p className="muted">Sin movimientos en el mes.</p>}
      {filas.length > 0 && (
        <div className="tabla-scroll">
          <table className="tabla-densa">
            <thead>
              <tr>
                <th>Unidad</th><th className="num">Viajes</th><th className="num">Ingreso</th>
                <th className="num">Chofer</th><th className="num">Diésel</th>
                <th className="num">Taller/Compras</th><th className="num">Utilidad</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((x) => (
                <tr key={x.id}>
                  <td><strong>{x.numero}</strong></td>
                  <td className="num">{x.viajes}</td>
                  <td className="num">{dinero(x.ingreso, 'USD')}</td>
                  <td className="num">{dinero(x.pagoChofer, 'USD')}</td>
                  <td className="num">{dinero(x.diesel, 'USD')}</td>
                  <td className="num">{dinero(x.taller, 'USD')}</td>
                  <td className="num" style={{ color: x.utilidad < 0 ? 'var(--danger)' : 'inherit' }}>
                    <strong>{dinero(x.utilidad, 'USD')}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted tc-nota">Diésel de cargas en MXN convertido con el TC vigente. El costo real facturado vive en Compras.</p>
    </>
  )
}
