import { useEffect, useState } from 'react'
import {
  addDoc, collection, doc, getDocs, onSnapshot, query, runTransaction,
  serverTimestamp, updateDoc, where,
} from 'firebase/firestore'
import { db, subirArchivo } from './firebase'
import { incBalance, useColeccion } from './compras'
import { dinero, r2, hoy } from './utils/format'
import { exportarXlsx } from './utils/exportarXlsx'

/* Nómina interna (sin timbrado CFDI, por diseño):
   - Choferes: pago variable por viajes terminados del periodo (tabulador)
     menos viáticos no comprobados.
   - Mecánicos: sueldo base + bono por WO completada en el periodo.
   - Administrativos: sueldo base.
   El cierre corre en una transacción que marca cada viaje con nominaId:
   un viaje nunca puede liquidarse dos veces. */

export const ESTADO_NOMINA = { calculada: 'Calculada', aprobada: 'Aprobada', pagada: 'Pagada' }

const hace7 = () => {
  const d = new Date()
  d.setDate(d.getDate() - 7)
  return d.toLocaleDateString('sv')
}

export default function Nomina() {
  const [tab, setTab] = useState('cortes') // cortes | empleados
  return (
    <div>
      <div className="filtros">
        <button className={tab === 'cortes' ? 'chip chip-toggle activo' : 'chip chip-toggle'} onClick={() => setTab('cortes')}>Cortes de nómina</button>
        <button className={tab === 'empleados' ? 'chip chip-toggle activo' : 'chip chip-toggle'} onClick={() => setTab('empleados')}>Empleados</button>
      </div>
      {tab === 'empleados' ? <Empleados /> : <Cortes />}
    </div>
  )
}

/* ---------- Empleados (mecánicos y administrativos) ---------- */

const empleadoVacio = () => ({ nombre: '', tipo: 'mecanico', email: '', sueldoSemanal: '', bonoPorWO: '', activo: true })

function Empleados() {
  const empleados = useColeccion('empleados')
  const [f, setF] = useState(null)
  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  const guardar = async () => {
    if (!f.nombre.trim()) { alert('Escribe el nombre'); return }
    try {
      const { id, ...datos } = f
      const limpio = {
        nombre: datos.nombre.trim(), tipo: datos.tipo,
        email: (datos.email || '').trim().toLowerCase(),
        sueldoSemanal: Number(datos.sueldoSemanal) || 0,
        bonoPorWO: Number(datos.bonoPorWO) || 0,
        activo: datos.activo,
      }
      if (id) {
        await updateDoc(doc(db, 'empleados', id), limpio)
      } else {
        await addDoc(collection(db, 'empleados'), { ...limpio, createdAt: serverTimestamp() })
      }
      setF(null)
    } catch (e) { alert('Error: ' + e.message) }
  }

  if (f) {
    return (
      <div>
        <h2>{f.id ? f.nombre : 'Nuevo empleado'}</h2>
        <p className="muted">Los choferes no van aquí: se pagan por viaje desde el catálogo de Operadores.</p>
        <label className="campo"><span>Nombre</span>
          <input value={f.nombre} onChange={set('nombre')} />
        </label>
        <div className="fila-2">
          <label className="campo"><span>Tipo</span>
            <select value={f.tipo} onChange={set('tipo')}>
              <option value="mecanico">Mecánico</option>
              <option value="administrativo">Administrativo</option>
            </select>
          </label>
          <label className="campo"><span>Correo (para ligar sus WO)</span>
            <input type="email" value={f.email} onChange={set('email')} />
          </label>
        </div>
        <div className="fila-2">
          <label className="campo"><span>Sueldo semanal (USD)</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={f.sueldoSemanal} onChange={set('sueldoSemanal')} />
          </label>
          {f.tipo === 'mecanico' && (
            <label className="campo"><span>Bono por WO completada (USD)</span>
              <input type="number" inputMode="decimal" min="0" step="0.01" value={f.bonoPorWO} onChange={set('bonoPorWO')} />
            </label>
          )}
        </div>
        <label className="campo" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={f.activo}
            onChange={(e) => setF({ ...f, activo: e.target.checked })} />
          <span style={{ margin: 0 }}>Activo</span>
        </label>
        <div className="acciones">
          <button className="btn-primario" onClick={guardar}>Guardar</button>
          <button className="btn-secundario" onClick={() => setF(null)}>Cancelar</button>
        </div>
      </div>
    )
  }

  const lista = (empleados ?? []).slice().sort((a, b) => a.nombre.localeCompare(b.nombre))
  return (
    <div>
      <h2>Empleados</h2>
      {empleados === null && <p className="muted">Cargando…</p>}
      {empleados !== null && lista.length === 0 && (
        <p className="muted vacio">Sin empleados registrados.<br />Aquí van mecánicos y administrativos.</p>
      )}
      {lista.map((emp) => (
        <button key={emp.id} className="tarjeta" onClick={() => setF(emp)}>
          <div className="tarjeta-top">
            <strong>{emp.nombre}</strong>
            <span className={'badge ' + (emp.activo ? 'completado' : 'inactivo')}>{emp.activo ? 'Activo' : 'Inactivo'}</span>
          </div>
          <div className="muted">
            {emp.tipo === 'mecanico' ? 'Mecánico' : 'Administrativo'} · {dinero(emp.sueldoSemanal, 'USD')}/sem
            {emp.tipo === 'mecanico' && emp.bonoPorWO > 0 && ` · bono ${dinero(emp.bonoPorWO, 'USD')}/WO`}
          </div>
        </button>
      ))}
      <button className="fab" onClick={() => setF(empleadoVacio())} aria-label="Agregar empleado">+</button>
    </div>
  )
}

/* ---------- Cortes de nómina ---------- */

function Cortes() {
  const [nominas, setNominas] = useState(null)
  const [nueva, setNueva] = useState(false)
  const [detalle, setDetalle] = useState(null)

  useEffect(() => onSnapshot(collection(db, 'nominas'),
    (s) => setNominas(
      s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.periodo?.del || '').localeCompare(a.periodo?.del || '')),
    ), console.error), [])

  if (nueva) return <NuevoCorte onDone={() => setNueva(false)} />
  if (detalle) {
    const n = (nominas ?? []).find((x) => x.id === detalle.id) ?? detalle
    return <CorteDetalle nomina={n} onVolver={() => setDetalle(null)} />
  }

  return (
    <div>
      <h2>Cortes de nómina</h2>
      {nominas === null && <p className="muted">Cargando…</p>}
      {nominas !== null && nominas.length === 0 && (
        <p className="muted vacio">Sin cortes de nómina.<br />Toca + para generar el primero.</p>
      )}
      {(nominas ?? []).map((n) => (
        <button key={n.id} className="tarjeta" onClick={() => setDetalle(n)}>
          <div className="tarjeta-top">
            <strong>{n.periodo.del} → {n.periodo.al}</strong>
            <span className={'badge ' + (n.estatus === 'pagada' ? 'completado' : 'en_proceso')}>{ESTADO_NOMINA[n.estatus]}</span>
          </div>
          <div className="muted">
            {n.periodo.tipo === 'semanal' ? 'Semanal' : 'Quincenal'} · {n.numEmpleados} empleados · <strong>{dinero(n.totalGeneral, 'USD')}</strong>
          </div>
        </button>
      ))}
      <button className="fab" onClick={() => setNueva(true)} aria-label="Nuevo corte">+</button>
    </div>
  )
}

function NuevoCorte({ onDone }) {
  const operadores = useColeccion('operadores') ?? []
  const empleados = useColeccion('empleados') ?? []
  const [tipo, setTipo] = useState('semanal')
  const [del, setDel] = useState(hace7())
  const [al, setAl] = useState(hoy())
  const [preview, setPreview] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const calcular = async () => {
    try {
      // viajes terminados del periodo que aún no entran a ninguna nómina
      const viajesSnap = await getDocs(query(collection(db, 'viajes'), where('estatus', '==', 'terminado')))
      const viajes = viajesSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((v) => !v.nominaId && v.fecha >= del && v.fecha <= al)
      // WOs completadas del periodo (bonos de mecánicos)
      const wosSnap = await getDocs(query(collection(db, 'workOrders'), where('estatus', '==', 'completado')))
      const wos = wosSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((w) => {
          const f = w.completadoAt?.toDate?.()?.toLocaleDateString('sv') ?? ''
          return f >= del && f <= al
        })

      const factor = tipo === 'quincenal' ? 2 : 1 // ponytail: quincena = 2 semanas; ajustar si pagan por día
      const detalles = []

      for (const o of operadores.filter((x) => x.activo)) {
        const suyos = viajes.filter((v) => v.operadorId === o.id)
        if (suyos.length === 0) continue
        const percepciones = r2(suyos.reduce((s, v) => s + (v.costeoEstimado?.pagoChofer || 0), 0))
        // viáticos entregados no respaldados con comprobantes = descuento
        const descuentoViaticos = r2(suyos.reduce((s, v) =>
          s + Math.max(0, (v.viaticosEntregados || 0) - (v.viaticosComprobados || 0)), 0))
        detalles.push({
          empleadoTipo: 'chofer', empleadoId: o.id, nombre: o.nombre,
          viajes: suyos.map((v) => ({
            id: v.id, folio: v.folio, pago: v.costeoEstimado?.pagoChofer || 0,
            viaticosEntregados: v.viaticosEntregados || 0, viaticosComprobados: v.viaticosComprobados || 0,
          })),
          numWOs: 0, sueldoBase: 0, bonos: 0,
          percepciones, descuentoViaticos,
          total: r2(percepciones - descuentoViaticos),
          comprobanteURL: '',
        })
      }

      for (const emp of empleados.filter((x) => x.activo)) {
        const sueldoBase = r2((emp.sueldoSemanal || 0) * factor)
        const suyas = emp.tipo === 'mecanico'
          ? wos.filter((w) => (emp.email && w.creadoPor === emp.email) || w.mecanico === emp.nombre)
          : []
        const bonos = r2(suyas.length * (emp.bonoPorWO || 0))
        detalles.push({
          empleadoTipo: emp.tipo, empleadoId: emp.id, nombre: emp.nombre,
          viajes: [], numWOs: suyas.length,
          sueldoBase, bonos,
          percepciones: r2(sueldoBase + bonos), descuentoViaticos: 0,
          total: r2(sueldoBase + bonos),
          comprobanteURL: '',
        })
      }

      setPreview(detalles)
    } catch (e) {
      console.error(e)
      alert('Error al calcular: ' + e.message)
    }
  }

  const guardar = async () => {
    if (!preview?.length) return
    if (!confirm('¿Guardar el corte de nómina? Los viajes incluidos quedarán conciliados y no podrán pagarse en otro corte.')) return
    setGuardando(true)
    try {
      const nominaRef = doc(collection(db, 'nominas'))
      await runTransaction(db, async (tx) => {
        // re-verificar dentro de la transacción que ningún viaje ya fue liquidado
        const viajeIds = preview.flatMap((d) => d.viajes.map((v) => v.id))
        for (const vid of viajeIds) {
          const snap = await tx.get(doc(db, 'viajes', vid))
          if (snap.data()?.nominaId) throw new Error(`El viaje ${snap.data().folio} ya está en otra nómina`)
        }
        tx.set(nominaRef, {
          periodo: { del, al, tipo },
          estatus: 'calculada',
          numEmpleados: preview.length,
          totalGeneral: r2(preview.reduce((s, d) => s + d.total, 0)),
          createdAt: serverTimestamp(),
        })
        for (const d of preview) {
          tx.set(doc(collection(db, 'nominas', nominaRef.id, 'detalles')), d)
        }
        for (const vid of viajeIds) {
          tx.update(doc(db, 'viajes', vid), { nominaId: nominaRef.id, estatus: 'conciliado' })
        }
      })
      onDone()
    } catch (e) {
      console.error(e)
      alert('Error al guardar: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const total = r2((preview ?? []).reduce((s, d) => s + d.total, 0))

  return (
    <div>
      <h2>Nuevo corte de nómina</h2>
      <label className="campo"><span>Periodicidad</span>
        <select value={tipo} onChange={(e) => setTipo(e.target.value)}>
          <option value="semanal">Semanal</option>
          <option value="quincenal">Quincenal</option>
        </select>
      </label>
      <div className="fila-2">
        <label className="campo"><span>Del</span>
          <input type="date" value={del} onChange={(e) => setDel(e.target.value)} />
        </label>
        <label className="campo"><span>Al</span>
          <input type="date" value={al} onChange={(e) => setAl(e.target.value)} />
        </label>
      </div>
      <div className="acciones">
        <button className="btn-primario" onClick={calcular}>Calcular nómina</button>
        <button className="btn-secundario" onClick={onDone}>Cancelar</button>
      </div>

      {preview !== null && (
        <>
          <h3>Previsualización</h3>
          {preview.length === 0 && <p className="muted">Nada que pagar en este periodo.</p>}
          {preview.length > 0 && (
            <div className="tabla-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Empleado</th><th>Tipo</th><th className="num">Viajes/WOs</th>
                    <th className="num">Percepciones</th><th className="num">Desc. viáticos</th><th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((d, i) => (
                    <tr key={i}>
                      <td><strong>{d.nombre}</strong></td>
                      <td>{d.empleadoTipo}</td>
                      <td className="num">{d.empleadoTipo === 'chofer' ? d.viajes.length : d.numWOs}</td>
                      <td className="num">{dinero(d.percepciones, 'USD')}</td>
                      <td className="num">{d.descuentoViaticos ? '-' + dinero(d.descuentoViaticos, 'USD') : '—'}</td>
                      <td className="num"><strong>{dinero(d.total, 'USD')}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.length > 0 && (
            <>
              <p className="total-detalle">Total del corte: {dinero(total, 'USD')}</p>
              <div className="acciones">
                <button className="btn-completar" disabled={guardando} onClick={guardar}>
                  {guardando ? 'Guardando…' : 'Guardar corte (calculada)'}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function CorteDetalle({ nomina, onVolver }) {
  const [detalles, setDetalles] = useState(null)
  const [guardando, setGuardando] = useState(false)

  useEffect(() => onSnapshot(collection(db, 'nominas', nomina.id, 'detalles'),
    (s) => setDetalles(
      s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.nombre.localeCompare(b.nombre)),
    ), console.error), [nomina.id])

  const avanzar = async () => {
    const sig = nomina.estatus === 'calculada' ? 'aprobada' : 'pagada'
    if (!confirm(`¿Marcar la nómina como ${ESTADO_NOMINA[sig].toLowerCase()}?`)) return
    setGuardando(true)
    try {
      await updateDoc(doc(db, 'nominas', nomina.id), {
        estatus: sig,
        ...(sig === 'pagada' ? { pagadaAt: hoy() } : {}),
      })
      // el costo entra al balance del mes del fin de periodo, al pagarse
      if (sig === 'pagada') {
        await incBalance(nomina.periodo.al.slice(0, 7), { costoNomina: nomina.totalGeneral })
      }
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const subirComprobante = async (det, archivo) => {
    if (!archivo) return
    try {
      const url = await subirArchivo(`nominas/${nomina.id}/${det.id}_${archivo.name}`, archivo)
      await updateDoc(doc(db, 'nominas', nomina.id, 'detalles', det.id), { comprobanteURL: url })
    } catch (e) { alert('Error: ' + e.message) }
  }

  const exportar = () => exportarXlsx({
    nombreArchivo: `Nomina_${nomina.periodo.del}_a_${nomina.periodo.al}.xlsx`,
    hojas: [{
      nombre: 'Nómina',
      datos: [
        ['Periodo', `${nomina.periodo.del} a ${nomina.periodo.al}`, nomina.periodo.tipo],
        ['Estatus', ESTADO_NOMINA[nomina.estatus]],
        [],
        ['Empleado', 'Tipo', 'Viajes', 'WOs', 'Sueldo base', 'Bonos', 'Percepciones', 'Descuento viáticos', 'Total'],
        ...(detalles ?? []).map((d) => [
          d.nombre, d.empleadoTipo, d.viajes.map((v) => v.folio).join(', '), d.numWOs || '',
          d.sueldoBase, d.bonos, d.percepciones, d.descuentoViaticos, d.total,
        ]),
        [],
        ['', '', '', '', '', '', '', 'TOTAL', nomina.totalGeneral],
      ],
    }],
  })

  return (
    <div>
      <div className="tarjeta-top">
        <h2>Nómina {nomina.periodo.del} → {nomina.periodo.al}</h2>
        <span className={'badge ' + (nomina.estatus === 'pagada' ? 'completado' : 'en_proceso')}>{ESTADO_NOMINA[nomina.estatus]}</span>
      </div>

      {detalles === null && <p className="muted">Cargando…</p>}
      {(detalles ?? []).map((d) => (
        <div key={d.id} className="tarjeta detalle recibo">
          <div className="tarjeta-top">
            <strong>{d.nombre}</strong>
            <strong>{dinero(d.total, 'USD')}</strong>
          </div>
          <div className="muted">{d.empleadoTipo}</div>
          {d.empleadoTipo === 'chofer' && d.viajes.map((v) => (
            <p key={v.id}>
              {v.folio}: {dinero(v.pago, 'USD')}
              {v.viaticosEntregados > v.viaticosComprobados && (
                <span className="error"> · viáticos sin comprobar {dinero(r2(v.viaticosEntregados - v.viaticosComprobados), 'USD')}</span>
              )}
            </p>
          ))}
          {d.empleadoTipo !== 'chofer' && (
            <p>
              Base {dinero(d.sueldoBase, 'USD')}
              {d.bonos > 0 && ` + bonos ${dinero(d.bonos, 'USD')} (${d.numWOs} WOs)`}
            </p>
          )}
          {d.descuentoViaticos > 0 && <p className="error">Descuento por viáticos no comprobados: -{dinero(d.descuentoViaticos, 'USD')}</p>}
          {d.comprobanteURL ? (
            <p><a href={d.comprobanteURL} target="_blank" rel="noreferrer">Ver comprobante de transferencia</a></p>
          ) : (
            <label className="campo no-imprimir"><span>Comprobante de transferencia</span>
              <input type="file" accept=".pdf,image/*" onChange={(e) => subirComprobante(d, e.target.files[0])} />
            </label>
          )}
        </div>
      ))}

      <p className="total-detalle">Total: {dinero(nomina.totalGeneral, 'USD')}</p>

      <div className="acciones no-imprimir">
        {nomina.estatus !== 'pagada' && (
          <button className="btn-completar" disabled={guardando} onClick={avanzar}>
            {nomina.estatus === 'calculada' ? 'Aprobar nómina' : 'Marcar como pagada'}
          </button>
        )}
        <button className="btn-secundario" onClick={exportar}>Descargar Excel</button>
        <button className="btn-secundario" onClick={() => window.print()}>Imprimir recibos</button>
        <button className="btn-secundario" onClick={onVolver}>Volver</button>
      </div>
    </div>
  )
}
