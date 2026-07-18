import { useEffect, useState } from 'react'
import {
  collection, doc, getDocs, increment, onSnapshot, query, runTransaction,
  serverTimestamp, updateDoc, where, writeBatch,
} from 'firebase/firestore'
import { db, subirArchivo } from './firebase'
import { hoy } from './taller'
import { mediana } from './costeo'
import { dinero, incBalance, r2, useColeccion, useTipoCambio, useUnidades, SelectorUnidad } from './compras'
import { direccionTexto } from './catalogos'

/* Módulo Viajes: operación + costeo + viáticos + cuentas por cobrar.
   Rediseño con dos ejes independientes:
   - /viajes/{id}/entregas: consolidación (varios clientes/destinos por viaje)
   - /viajes/{id}/movimientos: cadena de custodia (chofer/camión pueden cambiar a medio viaje)
   El doc padre denormaliza choferActual- y camionActual- (y los campos legacy operador- y unidad-
   que nómina, rules y la PWA del chofer siguen leyendo) — solo se escriben en transacción.
   El costeo se calcula UNA vez al guardar, con la MEDIANA de las últimas 5 cargas. */

export const ESTATUS_VIAJE = { en_proceso: 'En proceso', terminado: 'Terminado', conciliado: 'Conciliado' }

const sumaDias = (fecha, dias) => {
  const d = new Date(fecha + 'T00:00')
  d.setDate(d.getDate() + dias)
  return d.toLocaleDateString('sv')
}

const fmtTs = (t) => t?.toDate?.().toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) ?? '—'

// rendimiento para costeo: mediana (resistente a atípicos); cae a promedio en docs viejos
const rendimientoCosteo = (u) =>
  u?.rendimientoMediana ?? mediana(u?.ultimosRendimientos) ?? u?.rendimientoPromedio ?? 0

/* ---------- Transacciones de custodia y entregas ---------- */

// cierra el movimiento activo, crea el nuevo encadenado y actualiza los denormalizados. Todo o nada.
async function registrarCambio({ viaje, movActivo, chofer, camion, cambiarCaja, caja, odometroCierre, odometroInicioNuevo, motivo }) {
  await runTransaction(db, async (tx) => {
    const viajeRef = doc(db, 'viajes', viaje.id)
    const snap = await tx.get(viajeRef)
    if (snap.data()?.estatus !== 'en_proceso') throw new Error('El viaje ya no está en proceso')
    const cierre = odometroCierre ?? null
    const kmRec = (cierre != null && movActivo.odometroInicio != null)
      ? Math.max(0, r2(cierre - movActivo.odometroInicio))
      : null
    tx.update(doc(db, 'viajes', viaje.id, 'movimientos', movActivo.id), {
      fechaHoraFin: serverTimestamp(), odometroFin: cierre, kmRecorridos: kmRec, activo: false,
    })
    const cajaPlataformaId = cambiarCaja ? (caja?.id ?? null) : (movActivo.cajaPlataformaId ?? null)
    const cajaNumero = cambiarCaja ? (caja?.numero ?? '') : (viaje.cajaNumero ?? '')
    tx.set(doc(collection(db, 'viajes', viaje.id, 'movimientos')), {
      choferId: chofer.id, choferNombre: chofer.nombre, choferEmail: chofer.email ?? '',
      camionId: camion.id, camionNumero: camion.numero,
      cajaPlataformaId,
      fechaHoraInicio: serverTimestamp(), fechaHoraFin: null,
      // mismo camión: el odómetro continúa; camión nuevo: arranca con su propia lectura
      odometroInicio: camion.id === movActivo.camionId ? cierre : (odometroInicioNuevo ?? null),
      odometroFin: null, kmRecorridos: null,
      motivoCambio: motivo, movimientoAnteriorId: movActivo.id, activo: true,
    })
    tx.update(viajeRef, {
      choferActualId: chofer.id, choferActualNombre: chofer.nombre, choferActualEmail: chofer.email ?? '',
      camionActualId: camion.id, camionActualNumero: camion.numero,
      cajaPlataformaId, cajaNumero,
      operadorId: chofer.id, operadorNombre: chofer.nombre, operadorEmail: chofer.email ?? '',
      unidadId: camion.id, unidadNumero: camion.numero, cajaId: cajaPlataformaId ?? '',
      kmTotales: increment(kmRec ?? 0),
    })
  })
}

// terminar exige cero entregas pendientes (validado también en firestore.rules) y cierra el movimiento activo
async function terminarViaje({ viaje, movActivo, odometroFin, viaticosComprobados }) {
  await runTransaction(db, async (tx) => {
    const viajeRef = doc(db, 'viajes', viaje.id)
    const snap = await tx.get(viajeRef)
    const v = snap.data()
    if (v?.estatus !== 'en_proceso') throw new Error('El viaje ya no está en proceso')
    if ((v.entregasPendientes ?? 0) > 0) throw new Error(`Hay ${v.entregasPendientes} entrega(s) pendiente(s) — no se puede terminar`)
    const fin = odometroFin ?? null
    const kmRec = (fin != null && movActivo?.odometroInicio != null)
      ? Math.max(0, r2(fin - movActivo.odometroInicio))
      : null
    if (movActivo) {
      tx.update(doc(db, 'viajes', viaje.id, 'movimientos', movActivo.id), {
        fechaHoraFin: serverTimestamp(), odometroFin: fin, kmRecorridos: kmRec, activo: false,
      })
    }
    tx.update(viajeRef, {
      estatus: 'terminado', terminadoAt: serverTimestamp(),
      viaticosComprobados: viaticosComprobados ?? (v.viaticosComprobados || 0),
      kmTotales: increment(kmRec ?? 0),
    })
  })
}

// entregada + decremento del contador en el padre (lo usa admin y la PWA del chofer)
export async function marcarEntregada(viajeId, entrega, evidenciaUrl) {
  await runTransaction(db, async (tx) => {
    tx.update(doc(db, 'viajes', viajeId, 'entregas', entrega.id), {
      estatus: 'entregada', fechaHoraEntregaReal: serverTimestamp(), evidenciaUrl: evidenciaUrl || '',
    })
    tx.update(doc(db, 'viajes', viajeId), { entregasPendientes: increment(-1) })
  })
}

export default function Viajes({ usuario, vista }) {
  if (vista === 'mis-viajes') return <MisViajes usuario={usuario} />
  if (vista === 'cobranza') return <Cobranza />
  return <ListaViajes />
}

/* ---------- Lista + formulario (admin) ---------- */

function ListaViajes() {
  const [viajes, setViajes] = useState(null)
  const [editando, setEditando] = useState(null) // viaje | 'nuevo' | null
  const [fEstatus, setFEstatus] = useState('en_proceso')

  useEffect(() => onSnapshot(collection(db, 'viajes'),
    (s) => setViajes(s.docs.map((d) => ({ id: d.id, ...d.data() }))), console.error), [])

  if (editando) {
    return <ViajeForm viaje={editando === 'nuevo' ? null : editando} onDone={() => setEditando(null)} />
  }

  const lista = (viajes ?? [])
    .filter((v) => !fEstatus || v.estatus === fEstatus)
    .sort((a, b) => (b.folio || '').localeCompare(a.folio || ''))

  return (
    <div>
      <h2>Viajes</h2>
      <div className="filtros">
        <select value={fEstatus} onChange={(e) => setFEstatus(e.target.value)}>
          <option value="en_proceso">En proceso</option>
          <option value="terminado">Terminados</option>
          <option value="conciliado">Conciliados</option>
          <option value="">Todos</option>
        </select>
      </div>
      {viajes === null && <p className="muted">Cargando…</p>}
      {viajes !== null && lista.length === 0 && (
        <p className="muted vacio">No hay viajes con este filtro.<br />Toca + para crear uno nuevo.</p>
      )}
      {lista.map((v) => (
        <button key={v.id} className="tarjeta" onClick={() => setEditando(v)}>
          <div className="tarjeta-top">
            <strong>{v.folio}</strong>
            <span className={'badge ' + (v.estatus === 'en_proceso' ? 'en_proceso' : 'completado')}>
              {ESTATUS_VIAJE[v.estatus]}
            </span>
          </div>
          <div className="muted">{v.fecha} · {v.clienteNombre} · Unidad <strong>{v.unidadNumero}</strong></div>
          <div className="muted">{v.origen} → {v.destino} · {v.operadorNombre}{v.operadorProvisional ? ' (provisional)' : ''}</div>
          <div className="muted">
            Ingreso {dinero(v.precio, 'USD')} · Costeo est. {dinero(v.costeoEstimado?.total, 'USD')}
            {v.entregasPendientes > 0 && ` · ${v.entregasPendientes} entrega(s) pendiente(s)`}
          </div>
        </button>
      ))}
      <button className="fab" onClick={() => setEditando('nuevo')} aria-label="Nuevo viaje">+</button>
    </div>
  )
}

const viajeVacio = () => ({
  fecha: hoy(),
  unidadId: '', cajaId: '', operadorId: '', odometroInicio: '',
  tramoId: '', km: '', precio: '',
  viaticosEntregados: '', viaticosComprobados: '',
  notas: '',
})

const entregaVacia = () => ({ clienteId: '', direccionEntregaId: '', mercancia: '' })

// campos de una entrega (cliente + dirección + mercancía); se usa en alta de viaje y en agregar entrega
function EntregaCampos({ e, onChange, clientes, dirs, cargarDirs }) {
  return (
    <>
      <label className="campo"><span>Cliente</span>
        <select
          value={e.clienteId}
          onChange={(ev) => { cargarDirs(ev.target.value); onChange({ ...e, clienteId: ev.target.value, direccionEntregaId: '' }) }}
        >
          <option value="">Selecciona cliente…</option>
          {clientes.slice().sort((a, b) => a.razonSocial.localeCompare(b.razonSocial)).map((c) => (
            <option key={c.id} value={c.id}>{c.razonSocial}</option>
          ))}
        </select>
      </label>
      <label className="campo"><span>Dirección de entrega</span>
        <select value={e.direccionEntregaId} onChange={(ev) => onChange({ ...e, direccionEntregaId: ev.target.value })}>
          <option value="">Selecciona…</option>
          {(dirs[e.clienteId] ?? []).map((d) => <option key={d.id} value={d.id}>{direccionTexto(d)}</option>)}
        </select>
      </label>
      <label className="campo"><span>Mercancía</span>
        <input value={e.mercancia} onChange={(ev) => onChange({ ...e, mercancia: ev.target.value })}
          placeholder="Ej. 22 tarimas de aguacate" />
      </label>
    </>
  )
}

function ViajeForm({ viaje, onDone }) {
  const unidades = useUnidades()
  const tc = useTipoCambio()
  const clientes = useColeccion('clientes') ?? []
  const operadores = useColeccion('operadores') ?? []
  const tramos = useColeccion('tabuladores') ?? []
  const [config, setConfig] = useState(null)
  const [f, setF] = useState(() => (viaje ? { ...viajeVacio(), ...viaje } : viajeVacio()))
  const [entregas, setEntregas] = useState([entregaVacia()]) // solo alta; en edición viven en subcolección
  const [dirs, setDirs] = useState({}) // cache de direcciones por cliente
  const [movs, setMovs] = useState(viaje ? null : [])
  const [modalCambio, setModalCambio] = useState(false)
  const [terminando, setTerminando] = useState(false)
  const [odometroFin, setOdometroFin] = useState('')
  const [guardando, setGuardando] = useState(false)

  useEffect(() => onSnapshot(doc(db, 'config', 'general'), (s) => setConfig(s.data() ?? {}), console.error), [])

  // historial de movimientos (cadena de custodia) del viaje existente
  useEffect(() => {
    if (!viaje) return
    return onSnapshot(collection(db, 'viajes', viaje.id, 'movimientos'),
      (s) => setMovs(
        s.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.fechaHoraInicio?.seconds ?? 0) - (b.fechaHoraInicio?.seconds ?? 0)),
      ), console.error)
  }, [viaje?.id])

  const cargarDirs = (cid) => {
    if (!cid || dirs[cid]) return
    getDocs(collection(db, 'clientes', cid, 'direcciones'))
      .then((s) => setDirs((prev) => ({ ...prev, [cid]: s.docs.map((d) => ({ id: d.id, ...d.data() })) })))
      .catch(console.error)
  }

  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  const movActivo = (movs ?? []).find((m) => m.activo) ?? null
  const camionActualId = viaje ? (viaje.camionActualId ?? viaje.unidadId) : f.unidadId
  const unidad = unidades.find((u) => u.id === camionActualId)
  const tramo = tramos.find((t) => t.id === f.tramoId)
  const operadorBase = operadores.find((o) => o.unidadBaseId === f.unidadId)
  const operador = operadores.find((o) => o.id === f.operadorId)

  const elegirUnidad = (id) => {
    // al elegir unidad se propone su chofer de base; el admin puede cambiarlo (provisional)
    const base = operadores.find((o) => o.unidadBaseId === id)
    setF({ ...f, unidadId: id, operadorId: base?.id ?? f.operadorId })
  }

  const elegirTramo = (e) => {
    const t = tramos.find((x) => x.id === e.target.value)
    setF({ ...f, tramoId: e.target.value, km: f.km || (t?.km ? String(t.km) : '') })
  }

  // costeo estimado: diésel (km / mediana de rendimientos × $/L, a USD) + pago chofer del tabulador
  const km = Number(f.km) || 0
  const rendimiento = rendimientoCosteo(unidad)
  const precioLitro = config?.precioDieselLitro || 0
  const costoDieselMXN = rendimiento > 0 ? r2((km / rendimiento) * precioLitro) : 0
  const costoDieselUSD = tc ? r2(costoDieselMXN / tc) : 0
  const pagoChofer = tramo?.pagoChofer || 0
  const costeoTotal = r2(costoDieselUSD + pagoChofer)

  const guardar = async () => {
    const entregasValidas = entregas.filter((e) => e.clienteId && e.direccionEntregaId)
    if (!viaje) {
      if (entregasValidas.length === 0) { alert('Agrega al menos una entrega (cliente + dirección)'); return }
      if (!f.unidadId) { alert('Selecciona la unidad'); return }
      if (!f.operadorId) { alert('Selecciona el operador'); return }
    }
    if (!(km > 0)) { alert('Escribe los kilómetros del viaje'); return }
    setGuardando(true)
    try {
      const comunes = {
        fecha: f.fecha,
        tramoId: f.tramoId,
        origen: tramo?.origen ?? viaje?.origen ?? '',
        destino: tramo?.destino ?? viaje?.destino ?? '',
        km,
        kmFuente: 'manual', // cambiar a 'maps' cuando se integre Distance Matrix
        precio: Number(f.precio) || 0,
        costeoEstimado: { dieselUSD: costoDieselUSD, pagoChofer, total: costeoTotal },
        viaticosEntregados: Number(f.viaticosEntregados) || 0,
        viaticosComprobados: Number(f.viaticosComprobados) || 0,
        notas: f.notas,
      }
      if (viaje) {
        // chofer/camión/caja NO se tocan aquí: solo la transacción de cambio de movimiento
        await updateDoc(doc(db, 'viajes', viaje.id), comunes)
      } else {
        const caja = unidades.find((u) => u.id === f.cajaId)
        const clientesIds = [...new Set(entregasValidas.map((e) => e.clienteId))]
        const nombres = clientesIds.map((id) => clientes.find((c) => c.id === id)?.razonSocial ?? '').filter(Boolean)
        // folio + viaje + primer movimiento + entregas: una sola transacción,
        // nunca existe un viaje sin movimiento
        await runTransaction(db, async (tx) => {
          const cfgRef = doc(db, 'config', 'general')
          const cfg = await tx.get(cfgRef)
          const n = (cfg.data()?.ultimoViaje ?? 0) + 1
          tx.update(cfgRef, { ultimoViaje: n })
          const viajeRef = doc(collection(db, 'viajes'))
          tx.set(viajeRef, {
            ...comunes,
            folio: 'V-' + String(n).padStart(4, '0'),
            clientesIds,
            clienteId: clientesIds[0],
            clienteNombre: nombres.join(' + '),
            estatus: 'en_proceso',
            choferActualId: operador.id, choferActualNombre: operador.nombre, choferActualEmail: operador.email ?? '',
            camionActualId: f.unidadId, camionActualNumero: unidad?.numero ?? '',
            cajaPlataformaId: f.cajaId || null, cajaNumero: caja?.numero ?? '',
            // legacy sincronizado: nómina, rules y PWA chofer leen estos campos
            operadorId: operador.id, operadorNombre: operador.nombre, operadorEmail: operador.email ?? '',
            operadorProvisional: Boolean(operadorBase && f.operadorId !== operadorBase.id),
            unidadId: f.unidadId, unidadNumero: unidad?.numero ?? '', cajaId: f.cajaId,
            entregasPendientes: entregasValidas.length,
            kmTotales: 0,
            cobranza: { fechaFactura: '', fechaVence: '', facturaURL: '', xmlURL: '', pagado: false, comprobanteURL: '' },
            createdAt: serverTimestamp(),
          })
          tx.set(doc(collection(db, 'viajes', viajeRef.id, 'movimientos')), {
            choferId: operador.id, choferNombre: operador.nombre, choferEmail: operador.email ?? '',
            camionId: f.unidadId, camionNumero: unidad?.numero ?? '',
            cajaPlataformaId: f.cajaId || null,
            fechaHoraInicio: serverTimestamp(), fechaHoraFin: null,
            odometroInicio: Number(f.odometroInicio) || null,
            odometroFin: null, kmRecorridos: null,
            motivoCambio: null, movimientoAnteriorId: null, activo: true,
          })
          entregasValidas.forEach((e, i) => {
            const dir = (dirs[e.clienteId] ?? []).find((d) => d.id === e.direccionEntregaId)
            tx.set(doc(collection(db, 'viajes', viajeRef.id, 'entregas')), {
              clienteId: e.clienteId,
              clienteNombre: clientes.find((c) => c.id === e.clienteId)?.razonSocial ?? '',
              direccionEntregaId: e.direccionEntregaId,
              direccion: dir ? direccionTexto(dir) : '',
              mercancia: e.mercancia,
              ordenSecuencia: i + 1,
              estatus: 'pendiente',
              fechaHoraEntregaReal: null, evidenciaUrl: '',
            })
          })
        })
      }
      onDone()
    } catch (e) {
      console.error(e)
      alert('Error al guardar: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const confirmarTerminar = async () => {
    if (!confirm('¿Confirmar que el viaje terminó? Se registrarán los viáticos comprobados.')) return
    setGuardando(true)
    try {
      await terminarViaje({
        viaje, movActivo,
        odometroFin: Number(odometroFin) || null,
        viaticosComprobados: Number(f.viaticosComprobados) || 0,
      })
      onDone()
    } catch (e) {
      console.error(e)
      alert('Error al terminar: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const soloLectura = viaje && viaje.estatus === 'conciliado'
  const enProceso = !viaje || viaje.estatus === 'en_proceso'

  return (
    <div>
      <h2>{viaje ? `Viaje ${viaje.folio}` : 'Nuevo viaje'}</h2>
      {soloLectura && <p className="muted">Viaje conciliado en nómina — solo lectura.</p>}
      <label className="campo"><span>Fecha</span>
        <input type="date" value={f.fecha} onChange={set('fecha')} />
      </label>

      {/* custodia: en alta se captura el movimiento inicial; en edición solo se muestra y se cambia por transacción */}
      {!viaje && (
        <>
          <SelectorUnidad
            unidades={unidades.filter((u) => u.tipo === 'truck')}
            value={f.unidadId}
            onChange={elegirUnidad}
            placeholder="Selecciona unidad…"
          />
          <label className="campo"><span>Caja / plataforma (opcional)</span>
            <select value={f.cajaId} onChange={set('cajaId')}>
              <option value="">Sin caja</option>
              {unidades.filter((u) => u.tipo !== 'truck').map((u) => (
                <option key={u.id} value={u.id}>{u.numero} ({u.tipo})</option>
              ))}
            </select>
          </label>
          <label className="campo"><span>Operador</span>
            <select value={f.operadorId} onChange={set('operadorId')}>
              <option value="">Selecciona operador…</option>
              {operadores.filter((o) => o.activo).sort((a, b) => a.nombre.localeCompare(b.nombre)).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.nombre}{o.unidadBaseId === f.unidadId ? ' (base)' : ''}
                </option>
              ))}
            </select>
          </label>
          {operadorBase && f.operadorId && f.operadorId !== operadorBase.id && (
            <p className="muted tc-nota">Asignación provisional — la unidad base de {operadorBase.nombre} no se modifica.</p>
          )}
          <label className="campo"><span>Odómetro inicial (opcional)</span>
            <input type="number" inputMode="numeric" min="0" value={f.odometroInicio} onChange={set('odometroInicio')} />
          </label>
        </>
      )}
      {viaje && (
        <div className="tarjeta detalle">
          <div className="tarjeta-top">
            <strong>Custodia actual</strong>
            {enProceso && !soloLectura && (
              <button className="btn-secundario" onClick={() => setModalCambio(true)}>Registrar cambio de chofer/unidad</button>
            )}
          </div>
          <p>
            Chofer: <strong>{viaje.choferActualNombre ?? viaje.operadorNombre}</strong>
            {' · '}Camión: <strong>{viaje.camionActualNumero ?? viaje.unidadNumero}</strong>
            {(viaje.cajaNumero || viaje.cajaId) && <> · Caja: <strong>{viaje.cajaNumero || viaje.cajaId}</strong></>}
          </p>
          {viaje.kmTotales > 0 && <p className="muted">Km recorridos (movimientos): {viaje.kmTotales.toLocaleString()}</p>}
        </div>
      )}

      <div className="fila-2">
        <label className="campo"><span>Tramo (tabulador)</span>
          <select value={f.tramoId} onChange={elegirTramo}>
            <option value="">Selecciona tramo…</option>
            {tramos.slice().sort((a, b) => (a.origen + a.destino).localeCompare(b.origen + b.destino)).map((t) => (
              <option key={t.id} value={t.id}>{t.origen} → {t.destino} ({dinero(t.pagoChofer, 'USD')})</option>
            ))}
          </select>
        </label>
        <label className="campo"><span>Kilómetros</span>
          <input type="number" inputMode="numeric" min="0" value={f.km} onChange={set('km')} />
        </label>
      </div>

      <div className="fila-2">
        <label className="campo"><span>Ingreso del viaje (USD)</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={f.precio} onChange={set('precio')} />
        </label>
        <label className="campo"><span>Viáticos entregados (USD)</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={f.viaticosEntregados} onChange={set('viaticosEntregados')} />
        </label>
      </div>

      {/* entregas: en alta son filas locales que la transacción crea; en edición viven en la subcolección */}
      {!viaje && (
        <>
          <h3>Entregas ({entregas.length})</h3>
          {entregas.map((e, i) => (
            <div key={i} className="tarjeta detalle">
              <div className="tarjeta-top">
                <strong>Entrega {i + 1}</strong>
                <button
                  type="button" className="btn-borrar" aria-label="Eliminar entrega"
                  disabled={entregas.length === 1}
                  onClick={() => setEntregas(entregas.filter((_, j) => j !== i))}
                >🗑</button>
              </div>
              <EntregaCampos
                e={e} clientes={clientes} dirs={dirs} cargarDirs={cargarDirs}
                onChange={(nueva) => setEntregas(entregas.map((x, j) => (j === i ? nueva : x)))}
              />
            </div>
          ))}
          <button type="button" className="btn-secundario btn-bloque" onClick={() => setEntregas([...entregas, entregaVacia()])}>
            + Agregar entrega
          </button>
        </>
      )}
      {viaje && (
        <EntregasSection
          viaje={viaje} clientes={clientes} dirs={dirs} cargarDirs={cargarDirs}
          editable={enProceso && !soloLectura}
        />
      )}

      <div className="totales">
        <div><span className="muted">Diésel estimado ({km} km / {rendimiento || '—'} km/L mediana × ${precioLitro}/L)</span><span>{dinero(costoDieselUSD, 'USD')}</span></div>
        <div><span className="muted">Pago al chofer (tabulador)</span><span>{dinero(pagoChofer, 'USD')}</span></div>
        <div className="total-grande"><span>COSTEO ESTIMADO</span><span>{dinero(costeoTotal, 'USD')}</span></div>
      </div>
      {!precioLitro && <p className="error">Configura el precio del diésel en el Dashboard para estimar el costeo.</p>}
      {unidad && !rendimiento && <p className="muted tc-nota">La unidad aún no tiene rendimientos registrados (se calculan con las cargas de diésel).</p>}

      {viaje && (
        <label className="campo"><span>Viáticos comprobados por el chofer (USD)</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={f.viaticosComprobados} onChange={set('viaticosComprobados')} />
        </label>
      )}
      {viaje && Number(f.viaticosComprobados) < Number(f.viaticosEntregados) && f.viaticosComprobados !== '' && (
        <p className="error">
          Diferencia no comprobada: {dinero(r2(Number(f.viaticosEntregados) - Number(f.viaticosComprobados)), 'USD')} — se descontará en nómina.
        </p>
      )}

      <label className="campo"><span>Notas</span>
        <textarea value={f.notas} onChange={set('notas')} />
      </label>

      {viaje && <MovimientosTimeline movs={movs} />}

      {!soloLectura && (
        <div className="acciones">
          <button className="btn-primario" disabled={guardando} onClick={guardar}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
          {viaje && viaje.estatus === 'en_proceso' && !terminando && (
            <button
              className="btn-completar" disabled={guardando}
              onClick={() => {
                if ((viaje.entregasPendientes ?? 0) > 0) {
                  alert(`Hay ${viaje.entregasPendientes} entrega(s) pendiente(s) — entrégalas antes de terminar el viaje.`)
                  return
                }
                setTerminando(true)
              }}
            >
              Terminar viaje
            </button>
          )}
          <button className="btn-secundario" disabled={guardando} onClick={onDone}>Cancelar</button>
        </div>
      )}
      {terminando && (
        <div className="tarjeta detalle">
          <label className="campo"><span>Odómetro final (opcional)</span>
            <input type="number" inputMode="numeric" min="0" value={odometroFin} onChange={(e) => setOdometroFin(e.target.value)} />
          </label>
          <div className="acciones">
            <button className="btn-completar" disabled={guardando} onClick={confirmarTerminar}>Confirmar término</button>
            <button className="btn-secundario" disabled={guardando} onClick={() => setTerminando(false)}>Cancelar</button>
          </div>
        </div>
      )}
      {soloLectura && (
        <div className="acciones">
          <button className="btn-secundario" onClick={onDone}>Volver</button>
        </div>
      )}

      {modalCambio && movActivo && (
        <ModalCambio
          viaje={viaje} movActivo={movActivo}
          operadores={operadores} unidades={unidades}
          onDone={() => setModalCambio(false)}
        />
      )}
    </div>
  )
}

/* ---------- Entregas del viaje (subcolección, admin) ---------- */

function EntregasSection({ viaje, clientes, dirs, cargarDirs, editable }) {
  const [entregas, setEntregas] = useState(null)
  const [nueva, setNueva] = useState(null) // entregaVacia() | null

  useEffect(() => onSnapshot(collection(db, 'viajes', viaje.id, 'entregas'),
    (s) => setEntregas(
      s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.ordenSecuencia ?? 0) - (b.ordenSecuencia ?? 0)),
    ), console.error), [viaje.id])

  const lista = entregas ?? []

  const mover = async (i, dir) => {
    const a = lista[i], b = lista[i + dir]
    if (!a || !b) return
    // intercambio de secuencia en un batch: nunca queda a medias
    const batch = writeBatch(db)
    batch.update(doc(db, 'viajes', viaje.id, 'entregas', a.id), { ordenSecuencia: b.ordenSecuencia })
    batch.update(doc(db, 'viajes', viaje.id, 'entregas', b.id), { ordenSecuencia: a.ordenSecuencia })
    await batch.commit().catch((e) => alert('Error: ' + e.message))
  }

  const agregar = async () => {
    if (!nueva.clienteId || !nueva.direccionEntregaId) { alert('Cliente y dirección son obligatorios'); return }
    try {
      const dir = (dirs[nueva.clienteId] ?? []).find((d) => d.id === nueva.direccionEntregaId)
      const orden = Math.max(0, ...lista.map((e) => e.ordenSecuencia ?? 0)) + 1
      await runTransaction(db, async (tx) => {
        tx.set(doc(collection(db, 'viajes', viaje.id, 'entregas')), {
          clienteId: nueva.clienteId,
          clienteNombre: clientes.find((c) => c.id === nueva.clienteId)?.razonSocial ?? '',
          direccionEntregaId: nueva.direccionEntregaId,
          direccion: dir ? direccionTexto(dir) : '',
          mercancia: nueva.mercancia,
          ordenSecuencia: orden,
          estatus: 'pendiente',
          fechaHoraEntregaReal: null, evidenciaUrl: '',
        })
        tx.update(doc(db, 'viajes', viaje.id), { entregasPendientes: increment(1) })
      })
      setNueva(null)
    } catch (e) { alert('Error: ' + e.message) }
  }

  const eliminar = async (entrega) => {
    if (!confirm(`¿Eliminar la entrega de ${entrega.clienteNombre}?`)) return
    try {
      await runTransaction(db, async (tx) => {
        tx.delete(doc(db, 'viajes', viaje.id, 'entregas', entrega.id))
        if (entrega.estatus === 'pendiente') {
          tx.update(doc(db, 'viajes', viaje.id), { entregasPendientes: increment(-1) })
        }
      })
    } catch (e) { alert('Error: ' + e.message) }
  }

  const entregar = async (entrega) => {
    if (!confirm(`¿Marcar como entregada la entrega de ${entrega.clienteNombre}?`)) return
    try { await marcarEntregada(viaje.id, entrega, '') } catch (e) { alert('Error: ' + e.message) }
  }

  return (
    <>
      <h3>Entregas ({lista.length}{viaje.entregasPendientes > 0 ? ` · ${viaje.entregasPendientes} pendientes` : ''})</h3>
      {entregas === null && <p className="muted">Cargando…</p>}
      {entregas !== null && lista.length === 0 && (
        <p className="muted">Sin entregas registradas (viaje anterior a la migración).</p>
      )}
      {lista.length > 0 && (
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr><th>#</th><th>Cliente</th><th>Dirección</th><th>Mercancía</th><th>Estatus</th>{editable && <th />}</tr>
            </thead>
            <tbody>
              {lista.map((e, i) => (
                <tr key={e.id}>
                  <td>{e.ordenSecuencia}</td>
                  <td><strong>{e.clienteNombre}</strong></td>
                  <td className="muted">{e.direccion}</td>
                  <td>{e.mercancia}</td>
                  <td>
                    {e.estatus === 'entregada'
                      ? <span className="badge completado">Entregada</span>
                      : <span className="badge en_proceso">Pendiente</span>}
                    {e.evidenciaUrl && <> <a href={e.evidenciaUrl} target="_blank" rel="noreferrer">POD</a></>}
                  </td>
                  {editable && (
                    <td className="num">
                      <button className="btn-borrar" aria-label="Subir" disabled={i === 0} onClick={() => mover(i, -1)}>▲</button>
                      <button className="btn-borrar" aria-label="Bajar" disabled={i === lista.length - 1} onClick={() => mover(i, 1)}>▼</button>
                      {e.estatus === 'pendiente' && (
                        <>
                          <button className="btn-borrar" aria-label="Marcar entregada" onClick={() => entregar(e)}>✓</button>
                          <button className="btn-borrar" aria-label="Eliminar" onClick={() => eliminar(e)}>🗑</button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable && !nueva && (
        <button type="button" className="btn-secundario btn-bloque" onClick={() => setNueva(entregaVacia())}>+ Agregar entrega</button>
      )}
      {editable && nueva && (
        <div className="tarjeta detalle">
          <EntregaCampos e={nueva} onChange={setNueva} clientes={clientes} dirs={dirs} cargarDirs={cargarDirs} />
          <div className="acciones">
            <button className="btn-primario" onClick={agregar}>Agregar</button>
            <button className="btn-secundario" onClick={() => setNueva(null)}>Cancelar</button>
          </div>
        </div>
      )}
    </>
  )
}

/* ---------- Timeline de movimientos (cadena de custodia) ---------- */

function MovimientosTimeline({ movs }) {
  return (
    <>
      <h3>Historial de movimientos</h3>
      {movs === null && <p className="muted">Cargando…</p>}
      {movs !== null && movs.length === 0 && (
        <p className="muted">Sin movimientos registrados (viaje anterior a la migración).</p>
      )}
      {movs?.length > 0 && (
        <div className="timeline">
          {movs.map((m) => (
            <div key={m.id} className={'tl-item' + (m.activo ? ' activo' : '')}>
              {m.motivoCambio && <p className="tl-motivo">“{m.motivoCambio}”</p>}
              <div>
                <strong>{m.choferNombre}</strong> · Camión {m.camionNumero}
                {m.activo && <> <span className="badge en_proceso">Activo</span></>}
              </div>
              <div className="muted">
                {fmtTs(m.fechaHoraInicio)} → {m.activo ? 'en curso' : fmtTs(m.fechaHoraFin)}
                {m.odometroInicio != null && ` · odómetro ${m.odometroInicio.toLocaleString()}${m.odometroFin != null ? ` → ${m.odometroFin.toLocaleString()}` : ''}`}
                {m.kmRecorridos != null && ` · ${m.kmRecorridos.toLocaleString()} km`}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* ---------- Modal de cambio de chofer/unidad ---------- */

function ModalCambio({ viaje, movActivo, operadores, unidades, onDone }) {
  const [f, setF] = useState({
    choferId: '', camionId: movActivo.camionId, cambiarCaja: false,
    cajaId: movActivo.cajaPlataformaId ?? '', odometroCierre: '', odometroInicioNuevo: '', motivo: '',
  })
  const [guardando, setGuardando] = useState(false)
  const mismoCamion = f.camionId === movActivo.camionId

  const guardar = async () => {
    const chofer = operadores.find((o) => o.id === f.choferId)
    const camion = unidades.find((u) => u.id === f.camionId)
    if (!chofer) { alert('Selecciona el nuevo chofer'); return }
    if (!camion) { alert('Selecciona el camión'); return }
    if (!f.motivo.trim()) { alert('Describe el motivo del cambio'); return }
    setGuardando(true)
    try {
      await registrarCambio({
        viaje, movActivo, chofer, camion,
        cambiarCaja: f.cambiarCaja,
        caja: unidades.find((u) => u.id === f.cajaId) ?? null,
        odometroCierre: Number(f.odometroCierre) || null,
        odometroInicioNuevo: Number(f.odometroInicioNuevo) || null,
        motivo: f.motivo.trim(),
      })
      onDone()
    } catch (e) {
      console.error(e)
      alert('Error al registrar el cambio: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  return (
    <div className="modal-fondo" onClick={(e) => { if (e.target === e.currentTarget) onDone() }}>
      <div className="modal">
        <h3>Registrar cambio de chofer/unidad</h3>
        <p className="muted">
          Movimiento actual: {movActivo.choferNombre} · Camión {movActivo.camionNumero}
        </p>
        <label className="campo"><span>Nuevo chofer</span>
          <select value={f.choferId} onChange={set('choferId')}>
            <option value="">Selecciona chofer…</option>
            {operadores.filter((o) => o.activo).sort((a, b) => a.nombre.localeCompare(b.nombre)).map((o) => (
              <option key={o.id} value={o.id}>{o.nombre}</option>
            ))}
          </select>
        </label>
        <label className="campo"><span>Camión</span>
          <select value={f.camionId} onChange={set('camionId')}>
            {unidades.filter((u) => u.tipo === 'truck').map((u) => (
              <option key={u.id} value={u.id}>{u.numero}{u.id === movActivo.camionId ? ' (mismo camión)' : ''}</option>
            ))}
          </select>
        </label>
        <label className="campo"><span>Odómetro de cierre del tramo</span>
          <input type="number" inputMode="numeric" min="0" value={f.odometroCierre} onChange={set('odometroCierre')} />
        </label>
        {!mismoCamion && (
          <label className="campo"><span>Odómetro inicial del nuevo camión (opcional)</span>
            <input type="number" inputMode="numeric" min="0" value={f.odometroInicioNuevo} onChange={set('odometroInicioNuevo')} />
          </label>
        )}
        <label className="campo" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={f.cambiarCaja}
            onChange={(e) => setF({ ...f, cambiarCaja: e.target.checked })} />
          <span style={{ margin: 0 }}>Cambiar caja/plataforma (caso excepcional — emergencia mecánica)</span>
        </label>
        {f.cambiarCaja && (
          <label className="campo"><span>Nueva caja/plataforma</span>
            <select value={f.cajaId} onChange={set('cajaId')}>
              <option value="">Sin caja</option>
              {unidades.filter((u) => u.tipo !== 'truck').map((u) => (
                <option key={u.id} value={u.id}>{u.numero} ({u.tipo})</option>
              ))}
            </select>
          </label>
        )}
        <label className="campo"><span>Motivo / comentarios del cambio</span>
          <textarea rows={4} value={f.motivo} onChange={set('motivo')}
            placeholder="Describe la situación: relevo fronterizo, infracción, tema médico, falla mecánica…" />
        </label>
        <div className="acciones">
          <button className="btn-primario" disabled={guardando} onClick={guardar}>
            {guardando ? 'Guardando…' : 'Registrar cambio'}
          </button>
          <button className="btn-secundario" disabled={guardando} onClick={onDone}>Cancelar</button>
        </div>
      </div>
    </div>
  )
}

/* ---------- Mis viajes (chofer) ---------- */

function MisViajes({ usuario }) {
  const [viajes, setViajes] = useState(null)

  useEffect(() => onSnapshot(
    query(collection(db, 'viajes'), where('operadorEmail', '==', usuario.email)),
    (s) => setViajes(
      s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.folio || '').localeCompare(a.folio || '')),
    ),
    console.error,
  ), [usuario.email])

  return (
    <div>
      <h2>Mis viajes</h2>
      {viajes === null && <p className="muted">Cargando…</p>}
      {viajes !== null && viajes.length === 0 && <p className="muted vacio">Sin viajes asignados.</p>}
      {(viajes ?? []).map((v) => (
        <div key={v.id} className="tarjeta">
          <div className="tarjeta-top">
            <strong>{v.folio}</strong>
            <span className={'badge ' + (v.estatus === 'en_proceso' ? 'en_proceso' : 'completado')}>
              {ESTATUS_VIAJE[v.estatus]}
            </span>
          </div>
          <div className="muted">{v.fecha} · {v.origen} → {v.destino}</div>
          <div className="muted">Unidad {v.unidadNumero}{v.cajaNumero && ` · Caja ${v.cajaNumero}`}</div>
          <div className="muted">Viáticos entregados: {dinero(v.viaticosEntregados, 'USD')}</div>
        </div>
      ))}
    </div>
  )
}

/* ---------- Cobranza / Cuentas por Cobrar (admin) ---------- */

function Cobranza() {
  const [viajes, setViajes] = useState(null)
  const [detalle, setDetalle] = useState(null)

  useEffect(() => onSnapshot(collection(db, 'viajes'),
    (s) => setViajes(s.docs.map((d) => ({ id: d.id, ...d.data() }))), console.error), [])

  if (detalle) {
    const v = (viajes ?? []).find((x) => x.id === detalle.id) ?? detalle
    return <CobranzaDetalle viaje={v} onVolver={() => setDetalle(null)} />
  }

  const terminados = (viajes ?? []).filter((v) => v.estatus !== 'en_proceso')
  const porFacturar = terminados.filter((v) => !v.cobranza?.fechaFactura)
  const porCobrar = terminados
    .filter((v) => v.cobranza?.fechaFactura && !v.cobranza?.pagado)
    .sort((a, b) => (a.cobranza.fechaVence || '').localeCompare(b.cobranza.fechaVence || ''))
  const pagados = terminados.filter((v) => v.cobranza?.pagado)
  const totalPorCobrar = r2(porCobrar.reduce((s, v) => s + (v.precio || 0), 0))

  const badgeVence = (v) => {
    const dias = Math.ceil((new Date(v.cobranza.fechaVence + 'T00:00') - new Date()) / 86400000)
    if (dias < 0) return <span className="badge vencido">Vencida hace {-dias} d</span>
    if (dias <= 7) return <span className="badge alerta">Vence en {dias} d</span>
    return <span className="muted">Vence {v.cobranza.fechaVence}</span>
  }

  const Card = ({ v, extra }) => (
    <button className="tarjeta" onClick={() => setDetalle(v)}>
      <div className="tarjeta-top">
        <strong>{v.folio} · {v.clienteNombre}</strong>
        <strong>{dinero(v.precio, 'USD')}</strong>
      </div>
      <div className="muted">{v.fecha} · {v.origen} → {v.destino}</div>
      {extra}
    </button>
  )

  return (
    <div>
      <h2>Cuentas por cobrar</h2>
      {viajes === null && <p className="muted">Cargando…</p>}

      <div className="kpis">
        <div className="kpi">Por facturar<strong>{porFacturar.length}</strong></div>
        <div className="kpi">Por cobrar<strong>{dinero(totalPorCobrar, 'USD')}</strong></div>
      </div>

      <h3>Por facturar ({porFacturar.length})</h3>
      {porFacturar.length === 0 && <p className="muted">Nada pendiente de facturar.</p>}
      {porFacturar.map((v) => <Card key={v.id} v={v} />)}

      <h3>Por cobrar ({porCobrar.length})</h3>
      {porCobrar.length === 0 && <p className="muted">Nada pendiente de cobro.</p>}
      {porCobrar.map((v) => <Card key={v.id} v={v} extra={<div>{badgeVence(v)}</div>} />)}

      <h3>Pagados ({pagados.length})</h3>
      {pagados.slice(0, 10).map((v) => <Card key={v.id} v={v} />)}
    </div>
  )
}

function CobranzaDetalle({ viaje, onVolver }) {
  const clientes = useColeccion('clientes') ?? []
  const [fechaFactura, setFechaFactura] = useState(viaje.cobranza?.fechaFactura || hoy())
  const [pdf, setPdf] = useState(null)
  const [xml, setXml] = useState(null)
  const [comprobante, setComprobante] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const cliente = clientes.find((c) => c.id === viaje.clienteId)
  const cobranza = viaje.cobranza ?? {}
  const facturado = Boolean(cobranza.fechaFactura)

  const facturar = async () => {
    if (!fechaFactura) { alert('Escribe la fecha de factura'); return }
    setGuardando(true)
    try {
      const diasCredito = cliente?.diasCredito ?? 0
      const facturaURL = pdf ? await subirArchivo(`viajes/${viaje.id}/factura_${pdf.name}`, pdf) : (cobranza.facturaURL || '')
      const xmlURL = xml ? await subirArchivo(`viajes/${viaje.id}/xml_${xml.name}`, xml) : (cobranza.xmlURL || '')
      await updateDoc(doc(db, 'viajes', viaje.id), {
        cobranza: {
          ...cobranza,
          fechaFactura,
          // vencimiento estático: fecha factura + días de crédito del cliente
          fechaVence: sumaDias(fechaFactura, diasCredito),
          facturaURL, xmlURL,
        },
      })
      // el ingreso entra al balance del mes de facturación (solo la primera vez)
      if (!facturado) {
        await incBalance(fechaFactura.slice(0, 7), { ingresosViajes: viaje.precio || 0 })
      }
      alert('Factura registrada')
    } catch (e) {
      console.error(e)
      alert('Error: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const marcarPagado = async () => {
    if (!comprobante && !confirm('¿Marcar como pagado sin comprobante bancario?')) return
    setGuardando(true)
    try {
      const comprobanteURL = comprobante
        ? await subirArchivo(`viajes/${viaje.id}/pago_${comprobante.name}`, comprobante)
        : (cobranza.comprobanteURL || '')
      await updateDoc(doc(db, 'viajes', viaje.id), {
        cobranza: { ...cobranza, pagado: true, comprobanteURL, pagadoAt: hoy() },
      })
      alert('Viaje marcado como pagado')
    } catch (e) {
      console.error(e)
      alert('Error: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div>
      <h2>Cobranza {viaje.folio}</h2>
      <div className="tarjeta detalle">
        <p><span className="muted">Cliente:</span> {viaje.clienteNombre} ({cliente?.diasCredito ?? 0} días de crédito)</p>
        <p><span className="muted">Ruta:</span> {viaje.origen} → {viaje.destino} · {viaje.fecha}</p>
        <p><span className="muted">Ingreso:</span> <strong>{dinero(viaje.precio, 'USD')}</strong></p>
        {facturado && <p><span className="muted">Facturado:</span> {cobranza.fechaFactura} · vence {cobranza.fechaVence}</p>}
        {cobranza.facturaURL && <p><a href={cobranza.facturaURL} target="_blank" rel="noreferrer">Ver factura PDF</a></p>}
        {cobranza.xmlURL && <p><a href={cobranza.xmlURL} target="_blank" rel="noreferrer">Descargar XML</a></p>}
        {cobranza.pagado && (
          <p>
            <span className="badge completado">Pagado {cobranza.pagadoAt || ''}</span>
            {cobranza.comprobanteURL && <> · <a href={cobranza.comprobanteURL} target="_blank" rel="noreferrer">Ver comprobante</a></>}
          </p>
        )}
      </div>

      {!cobranza.pagado && (
        <>
          <h3>{facturado ? 'Actualizar factura' : 'Registrar factura'}</h3>
          <label className="campo"><span>Fecha de facturación</span>
            <input type="date" value={fechaFactura} onChange={(e) => setFechaFactura(e.target.value)} />
          </label>
          <div className="fila-2">
            <label className="campo"><span>Factura PDF</span>
              <input type="file" accept=".pdf" onChange={(e) => setPdf(e.target.files[0] ?? null)} />
            </label>
            <label className="campo"><span>Factura XML</span>
              <input type="file" accept=".xml" onChange={(e) => setXml(e.target.files[0] ?? null)} />
            </label>
          </div>
          <div className="acciones">
            <button className="btn-primario" disabled={guardando} onClick={facturar}>
              {guardando ? 'Guardando…' : (facturado ? 'Actualizar factura' : 'Registrar factura')}
            </button>
          </div>

          {facturado && (
            <>
              <h3>Registrar pago</h3>
              <label className="campo"><span>Comprobante bancario</span>
                <input type="file" accept=".pdf,image/*" onChange={(e) => setComprobante(e.target.files[0] ?? null)} />
              </label>
              <div className="acciones">
                <button className="btn-completar" disabled={guardando} onClick={marcarPagado}>
                  Marcar como pagado
                </button>
              </div>
            </>
          )}
        </>
      )}

      <div className="acciones">
        <button className="btn-secundario" onClick={onVolver}>Volver</button>
      </div>
    </div>
  )
}
