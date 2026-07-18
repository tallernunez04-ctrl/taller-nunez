import { useEffect, useMemo, useState } from 'react'
import {
  addDoc, collection, doc, getDocs, limit, onSnapshot, orderBy, query, runTransaction,
  serverTimestamp, updateDoc, where,
} from 'firebase/firestore'
import { db } from './firebase'
import { supabase } from './lib/supabaseClient'
import { hoy } from './taller'
import { mediana, esAtipico } from './costeo'
import { BadgeMantenimiento, dinero, r2, useUnidades, SelectorUnidad } from './compras'

/* Módulo Diésel: captura del chofer en ruta, rendimientos por unidad
   (array estático en el doc de la unidad, sin consultas de historial),
   reportes de falla al taller y dashboard de rendimiento para admin. */

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
  unidadId: '', estacion: '', litros: '', costoLitro: '', odometro: '',
  conCaja: false, cajaId: '', horasTermo: '', litrosCaja: '',
  notas: '',
})

function CargaDiesel({ usuario }) {
  const unidades = useUnidades()
  const [f, setF] = useState(cargaVacia)
  const [guardando, setGuardando] = useState(false)
  const [cargas, setCargas] = useState(null)
  const [viajesEnCurso, setViajesEnCurso] = useState([])
  const [viajeId, setViajeId] = useState('')

  // viajes en proceso del chofer, para atribuir el diésel al movimiento activo
  useEffect(() => {
    if (usuario.rol !== 'chofer') return
    return onSnapshot(
      query(collection(db, 'viajes'), where('operadorEmail', '==', usuario.email)),
      (s) => {
        const activos = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((v) => v.estatus === 'en_proceso')
        setViajesEnCurso(activos)
        setViajeId((prev) => (activos.some((v) => v.id === prev) ? prev : (activos[0]?.id ?? '')))
      },
      console.error,
    )
  }, [usuario.email, usuario.rol])

  // el chofer ve sus propias cargas recientes; admin ve todas.
  // orden en cliente para no requerir índice compuesto (patrón de taller.jsx)
  useEffect(() => onSnapshot(
    query(
      collection(db, 'cargasDiesel'),
      ...(usuario.rol === 'admin' ? [] : [where('operadorEmail', '==', usuario.email)]),
    ),
    (s) => setCargas(
      s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0))
        .slice(0, 20),
    ),
    console.error,
  ), [usuario.email, usuario.rol])

  const unidad = unidades.find((u) => u.id === f.unidadId)
  const litros = Number(f.litros) || 0
  const costoLitro = Number(f.costoLitro) || 0
  const litrosCaja = Number(f.litrosCaja) || 0
  const costoTotal = r2(litros * costoLitro)
  const costoCaja = r2(litrosCaja * costoLitro)

  const guardar = async () => {
    if (!f.unidadId) { alert('Selecciona la unidad'); return }
    if (!(litros > 0) || !(costoLitro > 0)) { alert('Litros y costo por litro son obligatorios'); return }
    const odometro = Number(f.odometro)
    if (!(odometro > 0)) { alert('Escribe el odómetro actual'); return }
    if (unidad?.ultimaLectura != null && odometro < unidad.ultimaLectura) {
      alert(`El odómetro (${odometro.toLocaleString()}) no puede ser menor a la última lectura (${unidad.ultimaLectura.toLocaleString()})`)
      return
    }
    if (f.conCaja && !f.cajaId) { alert('Selecciona la caja refrigerada'); return }
    setGuardando(true)
    try {
      const caja = unidades.find((u) => u.id === f.cajaId)
      // liga al movimiento activo del viaje: el consumo se atribuye al chofer/camión del tramo
      let liga = { viajeId: null, viajeFolio: null, movimientoId: null }
      if (viajeId) {
        const movs = await getDocs(query(collection(db, 'viajes', viajeId, 'movimientos'), where('activo', '==', true)))
        liga = {
          viajeId,
          viajeFolio: viajesEnCurso.find((v) => v.id === viajeId)?.folio ?? null,
          movimientoId: movs.docs[0]?.id ?? null,
        }
      }
      // rendimiento = distancia recorrida desde la última carga / litros
      // ponytail: unidades ya vive en Supabase, cargasDiesel sigue en Firestore -- no hay
      // transacción cruzada posible entre las dos bases. El historial de rendimientos ya no vive
      // en el doc de la unidad (Supabase no tiene esas columnas): se deriva de las últimas
      // cargas de diésel de esta unidad, que siguen siendo la fuente real del dato.
      const rendimiento = (unidad.ultimaLectura != null && odometro > unidad.ultimaLectura)
        ? r2((odometro - unidad.ultimaLectura) / litros)
        : null
      const previosSnap = await getDocs(query(
        collection(db, 'cargasDiesel'),
        where('unidadId', '==', f.unidadId),
        orderBy('createdAt', 'desc'),
        limit(5),
      ))
      const previos = previosSnap.docs.map((d) => d.data().rendimiento).filter((r) => r != null)
      // el dato atípico se guarda igual (es historia real), solo queda marcado
      const atipico = rendimiento != null && esAtipico(rendimiento, previos)
      await runTransaction(db, async (tx) => {
        tx.set(doc(collection(db, 'cargasDiesel')), {
          fecha: hoy(),
          unidadId: f.unidadId,
          unidadNumero: unidad.numero,
          estacion: f.estacion,
          litros, costoLitro, costoTotal,
          odometro,
          unidadLectura: unidad.unidadLectura,
          rendimiento,
          esAtipico: atipico,
          ...liga,
          caja: f.conCaja ? {
            cajaId: f.cajaId,
            cajaNumero: caja?.numero ?? '',
            horasTermo: Number(f.horasTermo) || 0,
            litros: litrosCaja,
            costo: costoCaja,
          } : null,
          notas: f.notas,
          operadorEmail: usuario.email,
          operadorNombre: usuario.nombre,
          createdAt: serverTimestamp(),
        })
        if (atipico) {
          // alerta a la bandeja que taller ya vigila; misma forma que un reporte manual
          tx.set(doc(collection(db, 'reportesFalla')), {
            fecha: hoy(),
            unidadId: f.unidadId,
            unidadNumero: unidad.numero,
            descripcion: `Posible falla mecánica o error de captura en unidad ${unidad.numero}: `
              + `rendimiento ${rendimiento} ${unidad.unidadLectura}/L vs mediana ${mediana(previos)} ${unidad.unidadLectura}/L. `
              + 'Alerta generada automáticamente al registrar diésel.',
            estatus: 'abierto',
            operadorEmail: usuario.email,
            operadorNombre: usuario.nombre,
            createdAt: serverTimestamp(),
          })
        }
      })
      // solo se manda ultima_lectura: el trigger de la base rechaza cualquier otro campo cuando lo actualiza un chofer
      const { error } = await supabase.from('unidades').update({ ultima_lectura: odometro }).eq('id', f.unidadId)
      if (error) throw error
      alert('Carga registrada')
      setF(cargaVacia())
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
      <h2>Carga de diésel</h2>
      <SelectorUnidad
        unidades={unidades.filter((u) => u.tipo === 'truck')}
        value={f.unidadId}
        onChange={(id) => setF({ ...f, unidadId: id })}
        placeholder="Selecciona tu unidad…"
      />
      {unidad?.ultimaLectura != null && (
        <p className="muted tc-nota">Última lectura registrada: {unidad.ultimaLectura.toLocaleString()} {unidad.unidadLectura}</p>
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
        <input value={f.estacion} onChange={set('estacion')} placeholder="Ej. Pemex Villa Ahumada" />
      </label>
      <div className="fila-3">
        <label className="campo"><span>Litros</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={f.litros} onChange={set('litros')} />
        </label>
        <label className="campo"><span>$ / litro</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={f.costoLitro} onChange={set('costoLitro')} />
        </label>
        <label className="campo"><span>Odómetro ({unidad?.unidadLectura ?? 'km/mi'})</span>
          <input type="number" inputMode="numeric" min="0" value={f.odometro} onChange={set('odometro')} />
        </label>
      </div>
      {costoTotal > 0 && <p className="total-detalle">Costo de la carga: {dinero(costoTotal, 'MXN')}</p>}

      <label className="campo" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={f.conCaja}
          onChange={(e) => setF({ ...f, conCaja: e.target.checked })} />
        <span style={{ margin: 0 }}>Cargué diésel a la caja refrigerada</span>
      </label>
      {f.conCaja && (
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

      <div className="acciones">
        <button className="btn-primario" disabled={guardando} onClick={guardar}>
          {guardando ? 'Guardando…' : 'Registrar carga'}
        </button>
      </div>

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
  const [f, setF] = useState({ unidadId: '', descripcion: '' })
  const [guardando, setGuardando] = useState(false)
  const [misReportes, setMisReportes] = useState([])

  useEffect(() => onSnapshot(
    query(collection(db, 'reportesFalla'), where('operadorEmail', '==', usuario.email)),
    (s) => setMisReportes(
      s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0))
        .slice(0, 10),
    ),
    console.error,
  ), [usuario.email])

  const guardar = async () => {
    if (!f.unidadId) { alert('Selecciona la unidad'); return }
    if (!f.descripcion.trim()) { alert('Describe la falla'); return }
    setGuardando(true)
    try {
      const u = unidades.find((x) => x.id === f.unidadId)
      await addDoc(collection(db, 'reportesFalla'), {
        fecha: hoy(),
        unidadId: f.unidadId,
        unidadNumero: u?.numero ?? '',
        descripcion: f.descripcion.trim(),
        estatus: 'abierto',
        operadorEmail: usuario.email,
        operadorNombre: usuario.nombre,
        createdAt: serverTimestamp(),
      })
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
  const [reportes, setReportes] = useState(null)
  const [fEstatus, setFEstatus] = useState('abierto')

  useEffect(() => onSnapshot(
    query(collection(db, 'reportesFalla'), orderBy('createdAt', 'desc')),
    (s) => setReportes(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    console.error,
  ), [])

  const atender = async (rp) => {
    if (!confirm(`¿Marcar como atendido el reporte de la unidad ${rp.unidadNumero}?`)) return
    try {
      await updateDoc(doc(db, 'reportesFalla', rp.id), { estatus: 'atendido', atendidoAt: serverTimestamp() })
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
  const [cargas, setCargas] = useState(null)

  useEffect(() => onSnapshot(
    query(collection(db, 'cargasDiesel'), orderBy('createdAt', 'desc')),
    (s) => setCargas(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    console.error,
  ), [])

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

  const exportar = async () => {
    const XLSX = await import('xlsx') // carga diferida: no pesar el bundle del chofer
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Fecha', 'Unidad', 'Operador', 'Estación', 'Litros', '$/L', 'Costo', 'Odómetro', 'Rendimiento', 'Caja', 'Litros caja', 'Hrs termo', 'Costo caja', 'Notas'],
      ...lista.map((c) => [
        c.fecha, c.unidadNumero, c.operadorNombre, c.estacion, c.litros, c.costoLitro, c.costoTotal,
        c.odometro, c.rendimiento ?? '', c.caja?.cajaNumero ?? '', c.caja?.litros ?? '', c.caja?.horasTermo ?? '', c.caja?.costo ?? '', c.notas || '',
      ]),
      [],
      ['', '', '', 'TOTALES', totalLitros, '', totalCosto],
    ]), 'Cargas')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Unidad', 'Rendimiento promedio', 'Últimos rendimientos', 'Última lectura'],
      ...unidades.filter((u) => statsPorUnidad[u.id]).map((u) => [
        u.numero, statsPorUnidad[u.id].promedio, statsPorUnidad[u.id].ultimos.join(', '), u.ultimaLectura ?? '',
      ]),
    ]), 'Rendimiento por unidad')
    XLSX.writeFile(wb, `Diesel_${desde}_a_${hasta}.xlsx`)
  }

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
          <table>
            <thead>
              <tr><th>Unidad</th><th className="num">Promedio</th><th className="num">Mediana (costeo)</th><th>Últimos 5</th><th className="num">Última lectura</th></tr>
            </thead>
            <tbody>
              {trucks.map((u) => {
                const s = statsPorUnidad[u.id]
                return (
                  <tr key={u.id}>
                    <td><strong>{u.numero}</strong></td>
                    <td className="num">{s ? `${s.promedio} ${u.unidadLectura}/L` : '—'}</td>
                    <td className="num">{s?.mediana != null ? `${s.mediana} ${u.unidadLectura}/L` : '—'}</td>
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
      {lista.map((c) => (
        <div key={c.id} className="tarjeta detalle">
          <div className="tarjeta-top">
            <strong>{c.unidadNumero}</strong>
            <strong>{dinero(c.costoTotal + (c.caja?.costo || 0), 'MXN')}</strong>
          </div>
          <div className="muted">
            {c.fecha} · {c.operadorNombre} · {c.litros} L
            {c.rendimiento != null && ` · ${c.rendimiento} ${c.unidadLectura}/L`}
            {c.estacion && ` · ${c.estacion}`}
            {c.viajeFolio && ` · ${c.viajeFolio}`}
          </div>
          {c.esAtipico && <span className="badge alerta">Rendimiento atípico</span>}
          {c.caja && <div className="muted">Caja {c.caja.cajaNumero}: {c.caja.litros} L · {c.caja.horasTermo} hrs</div>}
        </div>
      ))}
    </div>
  )
}
