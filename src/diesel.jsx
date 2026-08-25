import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import { mediana } from './costeo'
import { BadgeMantenimiento, useUnidades, SelectorUnidad, CampoOdometro, useTabla, BarraAcciones } from './compras'
import { useOperadores, useEstacionesGasolinera, estacionTexto } from './catalogos'
import { dinero, r2, hoy } from './utils/format'
import { exportarXlsx } from './utils/exportarXlsx'

/* Módulo Diésel: captura del chofer en ruta, rendimientos por unidad, reportes de falla al
   taller y dashboard de rendimiento para admin. Migrado a Supabase (antes Firestore) --
   `registrar_carga_diesel` (RPC) hace el cálculo de rendimiento/atípico y las 3 escrituras
   (carga + unidades.ultima_lectura + reporte automático si es atípico) de forma atómica. */

// dos FKs de cargas_diesel a unidades (la unidad que carga y, opcional, la caja refrigerada)
const SELECT_CARGA = `*,
  unidades!cargas_diesel_unidad_id_fkey(numero, unidad_lectura),
  operadores(nombre, email),
  viajes(folio),
  caja:unidades!cargas_diesel_caja_id_fkey(numero)`

// misma forma camelCase que ya usaban los docs de Firestore, para no tocar conciliacion.jsx
// ni la lógica de abajo (statsPorUnidad, exportar) más de lo necesario
const mapCarga = (c) => ({
  id: c.id,
  fecha: c.fecha,
  unidadId: c.unidad_id,
  unidadNumero: c.unidades?.numero ?? '',
  estacion: c.estacion ?? '',
  litros: Number(c.litros) || 0,
  costoLitro: Number(c.costo_litro) || 0,
  costoTotal: Number(c.costo_total) || 0,
  odometro: Number(c.odometro) || 0,
  // la unidad que carga puede ser un camión (km/mi, homologado por CampoOdometro) o
  // directamente una caja refrigerada (hrs de la termo, sin homologar -- ver aKm)
  unidadLectura: c.unidades?.unidad_lectura === 'hrs' ? 'hrs' : 'km',
  rendimiento: c.rendimiento != null ? Number(c.rendimiento) : null,
  esAtipico: c.es_atipico,
  viajeId: c.viaje_id,
  viajeFolio: c.viajes?.folio ?? null,
  movimientoId: c.movimiento_id,
  caja: c.caja_id ? {
    cajaId: c.caja_id,
    cajaNumero: c.caja?.numero ?? '',
    horasTermo: Number(c.caja_horas_termo) || 0,
    litros: Number(c.caja_litros) || 0,
    costo: Number(c.caja_costo) || 0,
  } : null,
  notas: c.notas ?? '',
  operadorEmail: c.operadores?.email ?? '',
  operadorNombre: c.operadores?.nombre ?? '',
  createdAt: c.created_at,
})

export const useCargas = (limite) => useTabla('cargas_diesel', mapCarga,
  (q) => (limite
    ? q.select(SELECT_CARGA).order('created_at', { ascending: false }).limit(limite)
    : q.select(SELECT_CARGA).order('created_at', { ascending: false })))

// consulta puntual (no realtime) por rango de fecha -- para Conciliación, que solo lee al elegir un mes
export async function cargasEnRango(desde, hasta) {
  const { data, error } = await supabase.from('cargas_diesel').select(SELECT_CARGA)
    .gte('fecha', desde).lte('fecha', hasta)
  if (error) throw error
  return data.map(mapCarga)
}

const SELECT_REPORTE = '*, unidades(numero), operadores(nombre)'

const mapReporte = (r) => ({
  id: r.id,
  fecha: r.fecha,
  unidadId: r.unidad_id,
  unidadNumero: r.unidades?.numero ?? '',
  descripcion: r.descripcion,
  estatus: r.estatus,
  operadorId: r.operador_id,
  operadorNombre: r.operadores?.nombre ?? '',
  automatico: r.automatico,
  createdAt: r.created_at,
  atendidoAt: r.atendido_at,
})

const haceUnMes = () => {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return d.toLocaleDateString('sv')
}

export default function Diesel({ usuario, vista }) {
  if (vista === 'reportar-falla') return <ReportarFalla usuario={usuario} />
  if (vista === 'reportes-falla') return <ReportesFalla />
  if (vista === 'rendimiento') return <Rendimiento />
  return <CargaDiesel usuario={usuario} />
}

/* ---------- Captura de carga (chofer / admin) ---------- */

const cargaVacia = () => ({
  unidadId: '', estacionId: '', estacion: '', litros: '', costoLitro: '', odometro: '',
  conCaja: false, cajaId: '', horasTermo: '', litrosCaja: '',
  notas: '',
})

function CargaDiesel({ usuario }) {
  const unidades = useUnidades()
  const operadores = useOperadores() ?? [] // RLS: para rol chofer, solo trae su propia fila
  const estaciones = useEstacionesGasolinera() ?? []
  const [f, setF] = useState(cargaVacia)
  const [estacionModo, setEstacionModo] = useState('catalogo') // 'catalogo' | 'otra'
  const [guardando, setGuardando] = useState(false)
  // CampoOdometro guarda su texto/unidad como estado interno (no lo controla f.odometro) --
  // cambiar su `key` fuerza un remount limpio al guardar, si no el odómetro no se borraba
  const [resetKey, setResetKey] = useState(0)
  const cargas = useCargas(20) // RLS ya limita a las propias del chofer; admin ve todas
  const [viajesEnCurso, setViajesEnCurso] = useState([])
  const [viajeId, setViajeId] = useState('')

  // default: unidad asignada al chofer (unidad_base_id); se puede cambiar a mano
  // si esa unidad está fuera de servicio y le tocó otra
  useEffect(() => {
    if (usuario.rol !== 'chofer' || f.unidadId) return
    const base = operadores.find((o) => o.perfilId === usuario.id)
    if (base?.unidadBaseId) setF((prev) => (prev.unidadId ? prev : { ...prev, unidadId: base.unidadBaseId }))
  }, [usuario.rol, usuario.id, operadores, f.unidadId])

  // viajes en proceso del chofer, para atribuir el diésel al movimiento activo -- RLS de
  // Supabase ya limita "viajes" al chofer actual, no hace falta filtrar por email
  useEffect(() => {
    if (usuario.rol !== 'chofer') return
    supabase.from('viajes').select('id, folio').eq('estatus', 'en_proceso').then(({ data, error }) => {
      if (error) { console.error(error); return }
      setViajesEnCurso(data)
      setViajeId((prev) => (data.some((v) => v.id === prev) ? prev : (data[0]?.id ?? '')))
    })
  }, [usuario.rol])

  const unidad = unidades.find((u) => u.id === f.unidadId)
  // la caja refrigerada también puede cargar diésel sola (sin camión): su lectura es
  // horómetro (hrs de la termo), no odómetro -- ver CampoOdometro, que solo maneja km/mi
  const esReefer = unidad?.tipo === 'reefer'
  const litros = Number(f.litros) || 0
  const costoLitro = Number(f.costoLitro) || 0
  const litrosCaja = Number(f.litrosCaja) || 0
  const costoTotal = r2(litros * costoLitro)
  const costoCaja = r2(litrosCaja * costoLitro)

  const guardar = async () => {
    if (!f.unidadId) { alert('Selecciona la unidad'); return }
    if (!(litros > 0) || !(costoLitro > 0)) { alert('Litros y costo por litro son obligatorios'); return }
    const odometro = Number(f.odometro)
    if (!(odometro > 0)) { alert(esReefer ? 'Escribe las horas de la termo' : 'Escribe el odómetro actual'); return }
    if (unidad?.ultimaLectura != null && odometro < unidad.ultimaLectura) {
      const etiqueta = esReefer ? 'Las horas' : 'El odómetro'
      alert(`${etiqueta} (${odometro.toLocaleString()}) no puede ser menor a la última lectura (${unidad.ultimaLectura.toLocaleString()})`)
      return
    }
    if (f.conCaja && !f.cajaId) { alert('Selecciona la caja refrigerada'); return }
    const miOperadorId = operadores.find((o) => o.perfilId === usuario.id)?.id
    if (!miOperadorId) { alert('Tu cuenta no está vinculada a un operador -- avisa a Catálogos.'); return }
    setGuardando(true)
    try {
      // rendimiento, atípico, la alerta automática a reportes_falla y actualizar
      // unidades.ultima_lectura quedan atómicos dentro de la RPC (ver migración)
      const { error } = await supabase.rpc('registrar_carga_diesel', {
        p_unidad_id: f.unidadId, p_estacion: f.estacion || null, p_estacion_id: f.estacionId || null,
        p_litros: litros, p_costo_litro: costoLitro,
        p_odometro: odometro, p_viaje_id: viajeId || null,
        p_caja_id: f.conCaja ? f.cajaId : null,
        p_horas_termo: f.conCaja ? (Number(f.horasTermo) || 0) : null,
        p_litros_caja: f.conCaja ? litrosCaja : null,
        p_notas: f.notas || null, p_operador_id: miOperadorId,
      })
      if (error) throw error
      alert('Carga registrada')
      setF(cargaVacia())
      setEstacionModo('catalogo')
      setResetKey((k) => k + 1)
    } catch (e) {
      console.error(e)
      alert('Error al guardar: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  return (
    <div>
      <BarraAcciones onGuardar={guardar} guardando={guardando} guardarLabel="Registrar carga" />
      <h2>Carga de diésel</h2>
      <SelectorUnidad
        unidades={unidades.filter((u) => u.tipo === 'truck' || u.tipo === 'reefer')}
        value={f.unidadId}
        onChange={(id) => {
          const u = unidades.find((x) => x.id === id)
          // si cambia a una caja refrigerada, "cargué también a la caja" ya no aplica
          // (una caja no puede llevar otra caja) -- se limpia por si venía marcado
          setF(u?.tipo === 'reefer'
            ? { ...f, unidadId: id, odometro: '', conCaja: false, cajaId: '', horasTermo: '', litrosCaja: '' }
            : { ...f, unidadId: id, odometro: '' })
          setResetKey((k) => k + 1)
        }}
        placeholder="Selecciona tu unidad…"
      />
      {unidad?.ultimaLectura != null && (
        <p className="muted tc-nota">
          Última lectura registrada: {unidad.ultimaLectura.toLocaleString()} {esReefer ? 'hrs' : 'km'}
        </p>
      )}
      {unidad && <BadgeMantenimiento unidad={unidad} />}
      {viajesEnCurso.length > 0 && (
        <label className="campo"><span>Viaje en curso</span>
          <select value={viajeId} onChange={(e) => setViajeId(e.target.value)}>
            <option value="">Sin viaje</option>
            {viajesEnCurso.map((v) => (
              <option key={v.id} value={v.id}>{v.folio} · {v.origen} → {v.destino}</option>
            ))}
          </select>
        </label>
      )}
      <label className="campo"><span>Estación de carga</span>
        <select value={estacionModo === 'otra' ? 'otra' : f.estacionId} onChange={(e) => {
          const v = e.target.value
          if (v === 'otra') { setEstacionModo('otra'); setF({ ...f, estacionId: '', estacion: '' }); return }
          setEstacionModo('catalogo')
          const est = estaciones.find((x) => x.id === v)
          setF({ ...f, estacionId: v, estacion: est ? estacionTexto(est) : '' })
        }}>
          <option value="">Selecciona estación…</option>
          {estaciones.map((est) => <option key={est.id} value={est.id}>{estacionTexto(est)}</option>)}
          <option value="otra">Otra (capturar a mano)…</option>
        </select>
      </label>
      {estacionModo === 'otra' && (
        <label className="campo"><span>Nombre de la estación</span>
          <input value={f.estacion} onChange={set('estacion')} placeholder="Ej. Pemex Villa Ahumada" />
        </label>
      )}
      <div className="fila-2">
        <label className="campo"><span>Litros</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={f.litros} onChange={set('litros')} />
        </label>
        <label className="campo"><span>$ / litro</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={f.costoLitro} onChange={set('costoLitro')} />
        </label>
      </div>
      {esReefer ? (
        <label className="campo"><span>Horas de la termo</span>
          <input type="number" inputMode="decimal" min="0" value={f.odometro} onChange={set('odometro')} />
        </label>
      ) : (
        <CampoOdometro
          key={resetKey}
          label="Odómetro" unidadPorDefecto={unidad?.unidadLectura}
          onChangeKm={(km) => setF((prev) => ({ ...prev, odometro: km ?? '' }))}
        />
      )}
      {costoTotal > 0 && <p className="total-detalle">Costo de la carga: {dinero(costoTotal, 'MXN')}</p>}

      {!esReefer && (
        <label className="campo" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={f.conCaja}
            onChange={(e) => setF({ ...f, conCaja: e.target.checked })} />
          <span style={{ margin: 0 }}>Cargué diésel a la caja refrigerada</span>
        </label>
      )}
      {!esReefer && f.conCaja && (
        <div className="linea">
          <label className="campo"><span>Caja refrigerada</span>
            <select value={f.cajaId} onChange={set('cajaId')}>
              <option value="">Selecciona caja…</option>
              {unidades.filter((u) => u.tipo === 'reefer').map((u) => (
                <option key={u.id} value={u.id}>{u.numero}</option>
              ))}
            </select>
          </label>
          <div className="fila-2">
            <label className="campo"><span>Horas de la termo</span>
              <input type="number" inputMode="decimal" min="0" value={f.horasTermo} onChange={set('horasTermo')} />
            </label>
            <label className="campo"><span>Litros a la caja</span>
              <input type="number" inputMode="decimal" min="0" step="0.01" value={f.litrosCaja} onChange={set('litrosCaja')} />
            </label>
          </div>
          {costoCaja > 0 && <p className="total-detalle">Costo caja: {dinero(costoCaja, 'MXN')}</p>}
        </div>
      )}

      <label className="campo"><span>Notas (opcional)</span>
        <textarea value={f.notas} onChange={set('notas')} />
      </label>

      <h3>Cargas recientes</h3>
      {cargas === null && <p className="muted">Cargando…</p>}
      {cargas !== null && cargas.length === 0 && <p className="muted">Sin cargas registradas.</p>}
      {(cargas ?? []).map((c) => (
        <div key={c.id} className="tarjeta detalle">
          <div className="tarjeta-top">
            <strong>{c.unidadNumero}</strong>
            <strong>{dinero(c.costoTotal, 'MXN')}</strong>
          </div>
          <div className="muted">
            {c.fecha} · {c.litros} L · {c.odometro?.toLocaleString()} {c.unidadLectura}
            {c.rendimiento != null && ` · ${c.rendimiento} ${c.unidadLectura}/L`}
            {c.estacion && ` · ${c.estacion}`}
            {c.viajeFolio && ` · ${c.viajeFolio}`}
          </div>
          {c.esAtipico && <span className="badge alerta">Rendimiento atípico</span>}
          {c.caja && (
            <div className="muted">Caja {c.caja.cajaNumero}: {c.caja.litros} L · {c.caja.horasTermo} hrs termo · {dinero(c.caja.costo, 'MXN')}</div>
          )}
        </div>
      ))}
    </div>
  )
}

/* ---------- Reporte de falla (chofer → taller) ---------- */

function ReportarFalla({ usuario }) {
  const unidades = useUnidades()
  const operadores = useOperadores() ?? []
  const [f, setF] = useState({ unidadId: '', descripcion: '' })
  const [guardando, setGuardando] = useState(false)
  const misReportes = useTabla('reportes_falla', mapReporte, // RLS ya limita a los propios del chofer
    (q) => q.select(SELECT_REPORTE).order('created_at', { ascending: false }).limit(10)) ?? []

  // default: unidad asignada al chofer, igual que en Carga de diésel
  useEffect(() => {
    if (usuario.rol !== 'chofer' || f.unidadId) return
    const base = operadores.find((o) => o.perfilId === usuario.id)
    if (base?.unidadBaseId) setF((prev) => (prev.unidadId ? prev : { ...prev, unidadId: base.unidadBaseId }))
  }, [usuario.rol, usuario.id, operadores, f.unidadId])

  const guardar = async () => {
    if (!f.unidadId) { alert('Selecciona la unidad'); return }
    if (!f.descripcion.trim()) { alert('Describe la falla'); return }
    const miOperadorId = operadores.find((o) => o.perfilId === usuario.id)?.id
    if (!miOperadorId) { alert('Tu cuenta no está vinculada a un operador -- avisa a Catálogos.'); return }
    setGuardando(true)
    try {
      const { error } = await supabase.from('reportes_falla').insert({
        unidad_id: f.unidadId, descripcion: f.descripcion.trim(), operador_id: miOperadorId,
      })
      if (error) throw error
      alert('Reporte enviado al taller')
      setF({ unidadId: '', descripcion: '' })
    } catch (e) {
      console.error(e)
      alert('Error al enviar: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div>
      <h2>Reportar falla</h2>
      <SelectorUnidad
        unidades={unidades}
        value={f.unidadId}
        onChange={(id) => setF({ ...f, unidadId: id })}
        placeholder="Selecciona la unidad…"
      />
      <label className="campo"><span>Descripción de la falla</span>
        <textarea value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })}
          placeholder="Qué falla, desde cuándo, en qué condiciones…" />
      </label>
      <div className="acciones">
        <button className="btn-primario" disabled={guardando} onClick={guardar}>
          {guardando ? 'Enviando…' : 'Enviar reporte al taller'}
        </button>
      </div>

      {misReportes.length > 0 && <h3>Mis reportes</h3>}
      {misReportes.map((rp) => (
        <div key={rp.id} className="tarjeta detalle">
          <div className="tarjeta-top">
            <strong>{rp.unidadNumero}</strong>
            <span className={'badge ' + (rp.estatus === 'abierto' ? 'en_proceso' : 'completado')}>
              {rp.estatus === 'abierto' ? 'Abierto' : 'Atendido'}
            </span>
          </div>
          <div className="muted">{rp.fecha}</div>
          <p>{rp.descripcion}</p>
        </div>
      ))}
    </div>
  )
}

/* ---------- Reportes de falla (taller / admin) ---------- */

function ReportesFalla() {
  const reportes = useTabla('reportes_falla', mapReporte, // taller ve todos, admin ve todos (RLS)
    (q) => q.select(SELECT_REPORTE).order('created_at', { ascending: false }))
  const [fEstatus, setFEstatus] = useState('abierto')

  const atender = async (rp) => {
    if (!confirm(`¿Marcar como atendido el reporte de la unidad ${rp.unidadNumero}?`)) return
    try {
      const { error } = await supabase.from('reportes_falla')
        .update({ estatus: 'atendido', atendido_at: new Date().toISOString() }).eq('id', rp.id)
      if (error) throw error
    } catch (e) { alert('Error: ' + e.message) }
  }

  const lista = (reportes ?? []).filter((rp) => !fEstatus || rp.estatus === fEstatus)
  return (
    <div>
      <h2>Reportes de falla</h2>
      <div className="filtros">
        <select value={fEstatus} onChange={(e) => setFEstatus(e.target.value)}>
          <option value="abierto">Abiertos</option>
          <option value="atendido">Atendidos</option>
          <option value="">Todos</option>
        </select>
      </div>
      {reportes === null && <p className="muted">Cargando…</p>}
      {reportes !== null && lista.length === 0 && <p className="muted vacio">Sin reportes.</p>}
      {lista.map((rp) => (
        <div key={rp.id} className="tarjeta">
          <div className="tarjeta-top">
            <strong>Unidad {rp.unidadNumero}</strong>
            <span className={'badge ' + (rp.estatus === 'abierto' ? 'en_proceso' : 'completado')}>
              {rp.estatus === 'abierto' ? 'Abierto' : 'Atendido'}
            </span>
          </div>
          <div className="muted">{rp.fecha} · {rp.operadorNombre}</div>
          <p>{rp.descripcion}</p>
          {rp.estatus === 'abierto' && (
            <button className="btn-secundario" onClick={() => atender(rp)}>Marcar como atendido</button>
          )}
        </div>
      ))}
    </div>
  )
}

/* ---------- Rendimiento (admin): km/l por unidad + Excel ---------- */

function Rendimiento() {
  const unidades = useUnidades()
  const [desde, setDesde] = useState(haceUnMes())
  const [hasta, setHasta] = useState(hoy())
  const [fUnidad, setFUnidad] = useState('')
  const cargas = useCargas() // admin ve todas (RLS)

  const lista = (cargas ?? []).filter((c) =>
    (!desde || c.fecha >= desde) && (!hasta || c.fecha <= hasta) && (!fUnidad || c.unidadId === fUnidad))

  const totalLitros = r2(lista.reduce((s, c) => s + (c.litros || 0) + (c.caja?.litros || 0), 0))
  const totalCosto = r2(lista.reduce((s, c) => s + (c.costoTotal || 0) + (c.caja?.costo || 0), 0))

  // ponytail: unidades ya vive en Supabase y no tiene columnas de rendimiento -- el historial
  // (últimos 5, promedio, mediana) se deriva aquí de cargasDiesel, que sigue siendo la fuente
  // real del dato. "cargas" ya viene ordenado desc por createdAt, así que tomar los primeros
  // 5 por unidad alcanza sin otra consulta.
  const statsPorUnidad = useMemo(() => {
    const porUnidad = {}
    for (const c of cargas ?? []) {
      if (c.rendimiento == null) continue
      const arr = porUnidad[c.unidadId] ?? (porUnidad[c.unidadId] = [])
      if (arr.length < 5) arr.push(c.rendimiento)
    }
    return Object.fromEntries(Object.entries(porUnidad).map(([id, ultimos]) => [id, {
      ultimos,
      promedio: r2(ultimos.reduce((s, x) => s + x, 0) / ultimos.length),
      mediana: mediana(ultimos),
    }]))
  }, [cargas])

  const trucks = unidades.filter((u) => u.tipo === 'truck'
    && (statsPorUnidad[u.id]?.ultimos.length || (!fUnidad ? false : u.id === fUnidad)))

  const exportar = () => exportarXlsx({
    nombreArchivo: `Diesel_${desde}_a_${hasta}.xlsx`,
    hojas: [
      {
        nombre: 'Cargas',
        datos: [
          ['Fecha', 'Unidad', 'Operador', 'Estación', 'Litros', '$/L', 'Costo', 'Odómetro', 'Rendimiento', 'Caja', 'Litros caja', 'Hrs termo', 'Costo caja', 'Notas'],
          ...lista.map((c) => [
            c.fecha, c.unidadNumero, c.operadorNombre, c.estacion, c.litros, c.costoLitro, c.costoTotal,
            c.odometro, c.rendimiento ?? '', c.caja?.cajaNumero ?? '', c.caja?.litros ?? '', c.caja?.horasTermo ?? '', c.caja?.costo ?? '', c.notas || '',
          ]),
          [],
          ['', '', '', 'TOTALES', totalLitros, '', totalCosto],
        ],
      },
      {
        nombre: 'Rendimiento por unidad',
        datos: [
          ['Unidad', 'Rendimiento promedio', 'Últimos rendimientos', 'Última lectura'],
          ...unidades.filter((u) => statsPorUnidad[u.id]).map((u) => [
            u.numero, statsPorUnidad[u.id].promedio, statsPorUnidad[u.id].ultimos.join(', '), u.ultimaLectura ?? '',
          ]),
        ],
      },
    ],
  })

  return (
    <div>
      <h2>Diésel y rendimiento</h2>
      <div className="fila-2">
        <label className="campo"><span>Desde</span>
          <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </label>
        <label className="campo"><span>Hasta</span>
          <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </label>
      </div>
      <SelectorUnidad unidades={unidades} value={fUnidad} onChange={setFUnidad} placeholder="Todas las unidades" />

      <div className="kpis">
        <div className="kpi">Litros cargados<strong>{totalLitros.toLocaleString()}</strong></div>
        <div className="kpi">Costo total<strong>{dinero(totalCosto, 'MXN')}</strong></div>
      </div>

      <h3>Rendimiento promedio por unidad</h3>
      {trucks.length === 0 && <p className="muted">Aún no hay rendimientos calculados.</p>}
      {trucks.length > 0 && (
        <div className="tabla-scroll">
          <table className="tabla-densa">
            <thead>
              <tr><th>Unidad</th><th className="num">Promedio</th><th className="num">Mediana (costeo)</th><th>Últimos 5</th><th className="num">Última lectura (km)</th></tr>
            </thead>
            <tbody>
              {trucks.map((u) => {
                const s = statsPorUnidad[u.id]
                return (
                  <tr key={u.id}>
                    <td><strong>{u.numero}</strong></td>
                    <td className="num">{s ? `${s.promedio} km/L` : '—'}</td>
                    <td className="num">{s?.mediana != null ? `${s.mediana} km/L` : '—'}</td>
                    <td className="muted">{(s?.ultimos ?? []).join(' · ')}</td>
                    <td className="num">{u.ultimaLectura?.toLocaleString() ?? ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3>Cargas del periodo ({lista.length})</h3>
      {lista.length > 0 && (
        <div className="acciones">
          <button className="btn-secundario" onClick={exportar}>Descargar reporte (Excel)</button>
        </div>
      )}
      {cargas === null && <p className="muted">Cargando…</p>}
      {lista.length > 0 && (
        <div className="tabla-scroll">
          <table className="tabla-densa">
            <thead>
              <tr>
                <th>Fecha</th><th>Unidad</th><th>Operador</th><th className="num">Litros</th>
                <th className="num">Costo</th><th>Rendimiento</th><th>Estación</th><th>Viaje</th><th>Caja</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.id}>
                  <td className="muted">{c.fecha}</td>
                  <td><strong>{c.unidadNumero}</strong></td>
                  <td className="muted">{c.operadorNombre}</td>
                  <td className="num">{c.litros}</td>
                  <td className="num">{dinero(c.costoTotal + (c.caja?.costo || 0), 'MXN')}</td>
                  <td className="muted">
                    {c.rendimiento != null ? `${c.rendimiento} ${c.unidadLectura}/L` : '—'}
                    {c.esAtipico && <span className="badge alerta" style={{ marginLeft: 'var(--sp-1)' }}>Atípico</span>}
                  </td>
                  <td className="muted">{c.estacion || '—'}</td>
                  <td className="muted">{c.viajeFolio || '—'}</td>
                  <td className="muted">{c.caja ? `${c.caja.cajaNumero}: ${c.caja.litros} L · ${c.caja.horasTermo} hrs` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
