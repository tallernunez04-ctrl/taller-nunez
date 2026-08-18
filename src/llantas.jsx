import { useEffect, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import { useUnidades, SelectorUnidad } from './compras'
import { r2, hoy } from './utils/format'
import { exportarXlsx } from './utils/exportarXlsx'

/* Dashboard de Llantas (pedido explícito del cliente: análisis estricto de gasto de llantas).
   Sin identidad individual de llanta (decisión confirmada) -- la "vida" de una posición se mide
   como Km recorridos desde su último reemplazo (vista v_llantas_ultimo_reemplazo), y el
   intervalo de rotación como Km recorridos desde la última rotación de la unidad (vista
   v_llantas_ultima_rotacion, evento a nivel unidad). Ambas vistas leen de wo_llantas, capturada
   desde el formulario de WO en taller.jsx cuando se marca "Llantas" como tipo de falla. */

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
      const rot = rotaciones?.find((r) => r.unidad_id === u.id)
      const posiciones = (reemplazos ?? [])
        .filter((r) => r.unidad_id === u.id)
        .map((r) => ({
          posicion: r.posicion,
          fecha: r.fecha_ultimo_reemplazo,
          kmDesde: u.ultimaLectura != null ? r2(u.ultimaLectura - Number(r.km_ultimo_reemplazo)) : null,
        }))
        .sort((a, b) => a.posicion.localeCompare(b.posicion))
      return {
        id: u.id,
        numero: u.numero,
        kmDesdeRotacion: rot && u.ultimaLectura != null ? r2(u.ultimaLectura - Number(rot.km_ultima_rotacion)) : null,
        posiciones,
      }
    })
    .filter((f) => f.posiciones.length > 0 || f.kmDesdeRotacion != null)

  const exportar = () => exportarXlsx({
    nombreArchivo: `Llantas_${hoy()}.xlsx`,
    hojas: [{
      nombre: 'Llantas',
      datos: [
        ['Unidad', 'Posición', 'Km/llanta (desde reemplazo)', 'Fecha reemplazo', 'Km/rotación (desde última rotación)'],
        ...filas.flatMap((f) => (f.posiciones.length
          ? f.posiciones.map((p) => [f.numero, p.posicion, p.kmDesde ?? '', p.fecha ?? '', f.kmDesdeRotacion ?? ''])
          : [[f.numero, '—', '', '', f.kmDesdeRotacion ?? '']])),
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
        <div key={f.id} className="tarjeta detalle">
          <div className="tarjeta-top">
            <strong>Unidad {f.numero}</strong>
            <span className="muted">
              {f.kmDesdeRotacion != null ? `Km/rotación: ${f.kmDesdeRotacion.toLocaleString()} km` : 'Sin rotación registrada'}
            </span>
          </div>
          {f.posiciones.length === 0 && <p className="muted">Sin reemplazos registrados.</p>}
          {f.posiciones.length > 0 && (
            <div className="tabla-scroll">
              <table>
                <thead><tr><th>Posición</th><th className="num">Km/llanta</th><th>Desde</th></tr></thead>
                <tbody>
                  {f.posiciones.map((p) => (
                    <tr key={p.posicion}>
                      <td>{p.posicion}</td>
                      <td className="num">{p.kmDesde != null ? `${p.kmDesde.toLocaleString()} km` : '—'}</td>
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
