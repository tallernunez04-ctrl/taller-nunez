import { useEffect, useState } from 'react'
import {
  collection, doc, getDocs, onSnapshot, query, runTransaction,
  serverTimestamp, updateDoc, where,
} from 'firebase/firestore'
import { db, subirArchivo } from './firebase'
import { hoy } from './taller'
import { dinero, incBalance, r2, useColeccion, useTipoCambio, useUnidades, SelectorUnidad } from './compras'
import { direccionTexto } from './catalogos'

/* Módulo Viajes: operación + costeo + viáticos + cuentas por cobrar.
   El costeo se calcula UNA vez al guardar (valores estáticos en el doc),
   nunca al vuelo en dashboards. */

export const ESTATUS_VIAJE = { en_proceso: 'En proceso', terminado: 'Terminado', conciliado: 'Conciliado' }

const sumaDias = (fecha, dias) => {
  const d = new Date(fecha + 'T00:00')
  d.setDate(d.getDate() + dias)
  return d.toLocaleDateString('sv')
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
          <div className="muted">Ingreso {dinero(v.precio, 'USD')} · Costeo est. {dinero(v.costeoEstimado?.total, 'USD')}</div>
        </button>
      ))}
      <button className="fab" onClick={() => setEditando('nuevo')} aria-label="Nuevo viaje">+</button>
    </div>
  )
}

const viajeVacio = () => ({
  fecha: hoy(),
  clienteId: '', direccionCargaId: '', direccionEntregaId: '',
  unidadId: '', cajaId: '', operadorId: '',
  tramoId: '', km: '', precio: '',
  viaticosEntregados: '', viaticosComprobados: '',
  notas: '',
})

function ViajeForm({ viaje, onDone }) {
  const unidades = useUnidades()
  const tc = useTipoCambio()
  const clientes = useColeccion('clientes') ?? []
  const operadores = useColeccion('operadores') ?? []
  const tramos = useColeccion('tabuladores') ?? []
  const [config, setConfig] = useState(null)
  const [direcciones, setDirecciones] = useState([])
  const [f, setF] = useState(() => viaje ? { ...viajeVacio(), ...viaje } : viajeVacio())
  const [guardando, setGuardando] = useState(false)

  useEffect(() => onSnapshot(doc(db, 'config', 'general'), (s) => setConfig(s.data() ?? {}), console.error), [])

  // direcciones del cliente seleccionado
  useEffect(() => {
    if (!f.clienteId) { setDirecciones([]); return }
    getDocs(collection(db, 'clientes', f.clienteId, 'direcciones'))
      .then((s) => setDirecciones(s.docs.map((d) => ({ id: d.id, ...d.data() }))))
      .catch(console.error)
  }, [f.clienteId])

  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  const unidad = unidades.find((u) => u.id === f.unidadId)
  const tramo = tramos.find((t) => t.id === f.tramoId)
  const cliente = clientes.find((c) => c.id === f.clienteId)
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

  // costeo estimado: diésel (km / rendimiento × $/L, convertido a USD) + pago chofer del tabulador
  const km = Number(f.km) || 0
  const rendimiento = unidad?.rendimientoPromedio || 0
  const precioLitro = config?.precioDieselLitro || 0
  const costoDieselMXN = rendimiento > 0 ? r2((km / rendimiento) * precioLitro) : 0
  const costoDieselUSD = tc ? r2(costoDieselMXN / tc) : 0
  const pagoChofer = tramo?.pagoChofer || 0
  const costeoTotal = r2(costoDieselUSD + pagoChofer)

  const guardar = async (terminar) => {
    if (!f.clienteId) { alert('Selecciona el cliente'); return }
    if (!f.unidadId) { alert('Selecciona la unidad'); return }
    if (!f.operadorId) { alert('Selecciona el operador'); return }
    if (!(km > 0)) { alert('Escribe los kilómetros del viaje'); return }
    if (terminar && !confirm('¿Confirmar que el viaje terminó? Se registrarán los viáticos comprobados.')) return
    setGuardando(true)
    try {
      const dirCarga = direcciones.find((d) => d.id === f.direccionCargaId)
      const dirEntrega = direcciones.find((d) => d.id === f.direccionEntregaId)
      const datos = {
        fecha: f.fecha,
        clienteId: f.clienteId,
        clienteNombre: cliente?.razonSocial ?? '',
        direccionCargaId: f.direccionCargaId,
        direccionEntregaId: f.direccionEntregaId,
        origen: tramo?.origen ?? (dirCarga ? dirCarga.ciudad : ''),
        destino: tramo?.destino ?? (dirEntrega ? dirEntrega.ciudad : ''),
        unidadId: f.unidadId,
        unidadNumero: unidad?.numero ?? '',
        cajaId: f.cajaId,
        cajaNumero: unidades.find((u) => u.id === f.cajaId)?.numero ?? '',
        operadorId: f.operadorId,
        operadorNombre: operador?.nombre ?? '',
        operadorEmail: operador?.email ?? '',
        operadorProvisional: Boolean(operadorBase && f.operadorId !== operadorBase.id),
        tramoId: f.tramoId,
        km,
        kmFuente: 'manual', // cambiar a 'maps' cuando se integre Distance Matrix
        precio: Number(f.precio) || 0,
        costeoEstimado: { dieselUSD: costoDieselUSD, pagoChofer, total: costeoTotal },
        viaticosEntregados: Number(f.viaticosEntregados) || 0,
        viaticosComprobados: Number(f.viaticosComprobados) || 0,
        notas: f.notas,
        estatus: terminar ? 'terminado' : (viaje?.estatus ?? 'en_proceso'),
        ...(terminar ? { terminadoAt: serverTimestamp() } : {}),
      }
      if (viaje) {
        await updateDoc(doc(db, 'viajes', viaje.id), datos)
      } else {
        // folio consecutivo por transacción, igual que las WO
        await runTransaction(db, async (tx) => {
          const cfgRef = doc(db, 'config', 'general')
          const cfg = await tx.get(cfgRef)
          const n = (cfg.data()?.ultimoViaje ?? 0) + 1
          tx.update(cfgRef, { ultimoViaje: n })
          tx.set(doc(collection(db, 'viajes')), {
            ...datos,
            folio: 'V-' + String(n).padStart(4, '0'),
            cobranza: { fechaFactura: '', fechaVence: '', facturaURL: '', xmlURL: '', pagado: false, comprobanteURL: '' },
            createdAt: serverTimestamp(),
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

  const soloLectura = viaje && viaje.estatus === 'conciliado'

  return (
    <div>
      <h2>{viaje ? `Viaje ${viaje.folio}` : 'Nuevo viaje'}</h2>
      {soloLectura && <p className="muted">Viaje conciliado en nómina — solo lectura.</p>}
      <label className="campo"><span>Fecha</span>
        <input type="date" value={f.fecha} onChange={set('fecha')} />
      </label>
      <label className="campo"><span>Cliente</span>
        <select value={f.clienteId} onChange={(e) => setF({ ...f, clienteId: e.target.value, direccionCargaId: '', direccionEntregaId: '' })}>
          <option value="">Selecciona cliente…</option>
          {clientes.slice().sort((a, b) => a.razonSocial.localeCompare(b.razonSocial)).map((c) => (
            <option key={c.id} value={c.id}>{c.razonSocial}</option>
          ))}
        </select>
      </label>
      {f.clienteId && (
        <div className="fila-2">
          <label className="campo"><span>Dirección de carga</span>
            <select value={f.direccionCargaId} onChange={set('direccionCargaId')}>
              <option value="">Selecciona…</option>
              {direcciones.map((d) => <option key={d.id} value={d.id}>{direccionTexto(d)}</option>)}
            </select>
          </label>
          <label className="campo"><span>Dirección de entrega</span>
            <select value={f.direccionEntregaId} onChange={set('direccionEntregaId')}>
              <option value="">Selecciona…</option>
              {direcciones.map((d) => <option key={d.id} value={d.id}>{direccionTexto(d)}</option>)}
            </select>
          </label>
        </div>
      )}

      <SelectorUnidad
        unidades={unidades.filter((u) => u.tipo === 'truck')}
        value={f.unidadId}
        onChange={elegirUnidad}
        placeholder="Selecciona unidad…"
      />
      <label className="campo"><span>Caja (opcional)</span>
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

      <div className="totales">
        <div><span className="muted">Diésel estimado ({km} km / {rendimiento || '—'} km/L × ${precioLitro}/L)</span><span>{dinero(costoDieselUSD, 'USD')}</span></div>
        <div><span className="muted">Pago al chofer (tabulador)</span><span>{dinero(pagoChofer, 'USD')}</span></div>
        <div className="total-grande"><span>COSTEO ESTIMADO</span><span>{dinero(costeoTotal, 'USD')}</span></div>
      </div>
      {!precioLitro && <p className="error">Configura el precio del diésel en el Dashboard para estimar el costeo.</p>}
      {unidad && !rendimiento && <p className="muted tc-nota">La unidad aún no tiene rendimiento promedio (se calcula con las cargas de diésel).</p>}

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

      {!soloLectura && (
        <div className="acciones">
          <button className="btn-primario" disabled={guardando} onClick={() => guardar(false)}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
          {viaje && viaje.estatus === 'en_proceso' && (
            <button className="btn-completar" disabled={guardando} onClick={() => guardar(true)}>
              Terminar viaje
            </button>
          )}
          <button className="btn-secundario" disabled={guardando} onClick={onDone}>Cancelar</button>
        </div>
      )}
      {soloLectura && (
        <div className="acciones">
          <button className="btn-secundario" onClick={onDone}>Volver</button>
        </div>
      )}
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
