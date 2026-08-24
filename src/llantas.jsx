import { useEffect, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import { useUnidades, SelectorUnidad } from './compras'
import { r2, hoy } from './utils/format'
import { exportarXlsx } from './utils/exportarXlsx'

/* Dashboard de Llantas (pedido explícito del cliente: análisis estricto de gasto de llantas).
   Sin identidad individual de llanta (decisión confirmada) -- la "vida" de una posición y el
   intervalo de rotación (evento a nivel unidad) se miden con dos métricas, ambas de solo lectura
   y sin alerta/umbral (Llantas no es un ciclo de mantenimiento preventivo):
   - Trucks (unidad_lectura != 'hrs'): Km recorridos desde el evento es la métrica principal
     (como siempre), días transcurridos se agrega como dato informativo adicional.
   - Reefers (unidad_lectura = 'hrs'): no hay km atribuible (sin relación fija reefer<->truck),
     así que días transcurridos es la ÚNICA métrica -- km_evento queda null en wo_llantas para
     estos eventos (columna nullable desde 2026-08-21).
   Ambas vistas (v_llantas_ultimo_reemplazo/v_llantas_ultima_rotacion) leen de wo_llantas,
   capturada desde el formulario de WO en taller.jsx cuando se marca "Llantas" como tipo de falla. */

const diasDesde = (fechaISO) => (fechaISO ? Math.floor((Date.now() - new Date(fechaISO).getTime()) / 86400000) : null)

function useLlantasKPI() {
  const [reemplazos, setReemplazos] = useState(null)
  const [rotaciones, setRotaciones] = useState(null)

  useEffect(() => {
    // las vistas no son tablas físicas -- no aceptan canal de postgres_changes directo, por eso
    // se escucha wo_llantas (la tabla real) y se refresca desde ahí, mismo patrón que useViajes()
    const cargar = async () => {
      const [r, ro] = await Promise.all([
        supabase.from('v_llantas_ultimo_reemplazo').select('*'),
        supabase.from('v_llantas_ultima_rotacion').select('*'),
      ])
      if (!r.error) setReemplazos(r.data)
      else console.error(r.error)
      if (!ro.error) setRotaciones(ro.data)
      else console.error(ro.error)
    }
    cargar()
    const canal = supabase
      .channel(`llantas-kpi-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wo_llantas' }, cargar)
      .subscribe()
    return () => supabase.removeChannel(canal)
  }, [])

  return { reemplazos, rotaciones }
}

export default function Llantas() {
  const unidades = useUnidades()
  const { reemplazos, rotaciones } = useLlantasKPI()
  const [fUnidad, setFUnidad] = useState('')
  const cargando = reemplazos === null || rotaciones === null

  const filas = unidades
    .filter((u) => !fUnidad || u.id === fUnidad)
    .map((u) => {
      const esHrs = u.unidadLectura === 'hrs'
      const rot = rotaciones?.find((r) => r.unidad_id === u.id)
      const posiciones = (reemplazos ?? [])
        .filter((r) => r.unidad_id === u.id)
        .map((r) => ({
          posicion: r.posicion,
          fecha: r.fecha_ultimo_reemplazo,
          diasDesde: diasDesde(r.fecha_ultimo_reemplazo),
          kmDesde: !esHrs && u.ultimaLectura != null && r.km_ultimo_reemplazo != null
            ? r2(u.ultimaLectura - Number(r.km_ultimo_reemplazo)) : null,
        }))
        .sort((a, b) => a.posicion.localeCompare(b.posicion))
      return {
        id: u.id,
        numero: u.numero,
        esHrs,
        diasDesdeRotacion: rot ? diasDesde(rot.fecha_ultima_rotacion) : null,
        kmDesdeRotacion: !esHrs && rot && u.ultimaLectura != null && rot.km_ultima_rotacion != null
          ? r2(u.ultimaLectura - Number(rot.km_ultima_rotacion)) : null,
        posiciones,
      }
    })
    .filter((f) => f.posiciones.length > 0 || f.diasDesdeRotacion != null)

  const exportar = () => exportarXlsx({
    nombreArchivo: `Llantas_${hoy()}.xlsx`,
    hojas: [{
      nombre: 'Llantas',
      datos: [
        ['Unidad', 'Posición', 'Km/llanta (desde reemplazo)', 'Días desde reemplazo', 'Fecha reemplazo', 'Km/rotación (desde última rotación)', 'Días desde rotación'],
        ...filas.flatMap((f) => (f.posiciones.length
          ? f.posiciones.map((p) => [f.numero, p.posicion, p.kmDesde ?? '', p.diasDesde ?? '', p.fecha ?? '', f.kmDesdeRotacion ?? '', f.diasDesdeRotacion ?? ''])
          : [[f.numero, '—', '', '', '', f.kmDesdeRotacion ?? '', f.diasDesdeRotacion ?? '']])),
      ],
    }],
  })

  return (
    <div>
      <h2>Llantas</h2>
      <SelectorUnidad unidades={unidades} value={fUnidad} onChange={setFUnidad} placeholder="Todas las unidades" />
      {cargando && <p className="muted">Cargando…</p>}
      {!cargando && filas.length === 0 && (
        <p className="muted vacio">Sin eventos de llantas registrados todavía.<br />Se capturan desde una WO en Taller, marcando "Llantas" como tipo de falla.</p>
      )}
      {filas.map((f) => (
        <div key={f.id} className="expediente-seccion">
          <div className="expediente-seccion-titulo" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Unidad {f.numero}</span>
            <span style={{ textTransform: 'none', fontWeight: 400, letterSpacing: 0 }}>
              {f.diasDesdeRotacion == null ? 'Sin rotación registrada' : (
                f.esHrs
                  ? `Rotación: ${f.diasDesdeRotacion.toLocaleString()} días`
                  : `Km/rotación: ${f.kmDesdeRotacion != null ? f.kmDesdeRotacion.toLocaleString() : '—'} km · ${f.diasDesdeRotacion.toLocaleString()} días`
              )}
            </span>
          </div>
          {f.posiciones.length === 0 && <p className="muted" style={{ padding: '0 var(--sp-3) var(--sp-2)' }}>Sin reemplazos registrados.</p>}
          {f.posiciones.length > 0 && (
            <div className="tabla-scroll">
              <table className="tabla-densa">
                <thead>
                  <tr>
                    <th>Posición</th>
                    {!f.esHrs && <th className="num">Km/llanta</th>}
                    <th className="num">Días</th>
                    <th>Desde</th>
                  </tr>
                </thead>
                <tbody>
                  {f.posiciones.map((p) => (
                    <tr key={p.posicion}>
                      <td>{p.posicion}</td>
                      {!f.esHrs && <td className="num">{p.kmDesde != null ? `${p.kmDesde.toLocaleString()} km` : '—'}</td>}
                      <td className="num">{p.diasDesde != null ? `${p.diasDesde.toLocaleString()} días` : '—'}</td>
                      <td className="muted">{p.fecha ? new Date(p.fecha).toLocaleDateString('es-MX') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
      {filas.length > 0 && (
        <div className="acciones">
          <button className="btn-secundario" onClick={exportar}>Descargar reporte (Excel)</button>
        </div>
      )}
    </div>
  )
}
