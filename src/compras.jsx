import { useEffect, useMemo, useState } from 'react'
import {
  addDoc, collection, doc, getDoc, onSnapshot, orderBy, query,
  serverTimestamp, setDoc, updateDoc, where,
} from 'firebase/firestore'
import { db } from './firebase'
import { FALLA_LABEL, LECTURA_LABEL, TIPOS, hoy, piezasLista } from './taller'

export const METODOS = [
  ['efectivo', 'Efectivo'],
  ['tarjeta', 'Tarjeta'],
  ['transferencia', 'Transferencia'],
  ['credito_proveedor', 'Crédito proveedor'],
]
export const ESTATUS = { en_proceso: 'En proceso', completado: 'Completado' }

export const r2 = (n) => Math.round(n * 100) / 100
export const dinero = (n, moneda) =>
  '$' + (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + moneda

// tc = pesos por 1 USD (config/general.tipoCambioUSD). Empresa fronteriza: todo se consolida en USD.
export const aUSD = (monto, moneda, tc) => (moneda === 'USD' ? monto : r2(monto / (tc || 1)))

export function useUnidades() {
  const [unidades, setUnidades] = useState([])
  useEffect(() => onSnapshot(collection(db, 'unidades'), (s) =>
    setUnidades(
      s.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => a.numero.localeCompare(b.numero, undefined, { numeric: true })),
    ), console.error), [])
  return unidades
}

export function useTipoCambio() {
  const [tc, setTc] = useState(null)
  useEffect(() => onSnapshot(doc(db, 'config', 'general'),
    (s) => setTc(s.data()?.tipoCambioUSD ?? null), console.error), [])
  return tc
}

export default function Compras({ usuario, vista }) {
  if (vista === 'nueva-compra') return <CompraForm usuario={usuario} />
  if (vista === 'unidades') return <Unidades />
  return <WorkOrders usuario={usuario} />
}

/* ---------- Sección 1: Work Orders ---------- */

function WorkOrders({ usuario }) {
  const [wos, setWos] = useState(null)
  const [detalle, setDetalle] = useState(null)
  const [fEstatus, setFEstatus] = useState('')
  const [fTipo, setFTipo] = useState('')
  const unidades = useUnidades()
  const tipoDe = useMemo(() => Object.fromEntries(unidades.map((u) => [u.id, u.tipo])), [unidades])

  useEffect(() => onSnapshot(
    query(collection(db, 'workOrders'), orderBy('createdAt', 'desc')),
    (s) => setWos(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    console.error,
  ), [])

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
      {lista.map((w) => (
        <button key={w.id} className="tarjeta" onClick={() => setDetalle(w)}>
          <div className="tarjeta-top">
            <strong>{w.wo}</strong>
            <span className={'badge ' + w.estatus}>{ESTATUS[w.estatus]}</span>
          </div>
          <div className="muted">
            {w.fecha} · Unidad <strong>{w.unidadNumero}</strong>
            {w.lectura?.valor ? ` · ${w.lectura.valor.toLocaleString()} ${w.lectura.unidad}` : ''}
          </div>
          {(w.chofer || w.mecanico) && (
            <div className="muted">
              {w.chofer && `Chofer: ${w.chofer}`}
              {w.chofer && w.mecanico && ' · '}
              {w.mecanico && `Mecánico: ${w.mecanico}`}
            </div>
          )}
          {w.tipoFalla?.length > 0 && (
            <div className="chips">
              {w.tipoFalla.map((f) => <span key={f} className="chip">{FALLA_LABEL[f]}</span>)}
            </div>
          )}
        </button>
      ))}
    </div>
  )
}

function WODetalle({ usuario, wo, onVolver }) {
  const [compras, setCompras] = useState([])
  const [comprando, setComprando] = useState(false)

  useEffect(() => onSnapshot(
    query(collection(db, 'compras'), where('woId', '==', wo.id)),
    (s) => setCompras(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    console.error,
  ), [wo.id])

  if (comprando) return <CompraForm usuario={usuario} wo={wo} onDone={() => setComprando(false)} />

  const totalUSD = r2(compras.reduce((s, c) => s + (c.totalGeneralUSD ?? 0), 0))

  return (
    <div>
      <div className="tarjeta-top">
        <h2>{wo.wo}</h2>
        <span className={'badge ' + wo.estatus}>{ESTATUS[wo.estatus]}</span>
      </div>
      <div className="tarjeta detalle">
        <p><span className="muted">Fecha:</span> {wo.fecha}</p>
        <p><span className="muted">Unidad:</span> <strong>{wo.unidadNumero}</strong>
          {wo.lectura?.valor ? ` · ${wo.lectura.valor.toLocaleString()} ${wo.lectura.unidad}` : ''}</p>
        {wo.chofer && <p><span className="muted">Chofer:</span> {wo.chofer}</p>}
        {wo.mecanico && <p><span className="muted">Mecánico:</span> {wo.mecanico}</p>}
        {wo.tipoFalla?.length > 0 && (
          <div className="chips">
            {wo.tipoFalla.map((f) => <span key={f} className="chip">{FALLA_LABEL[f]}</span>)}
          </div>
        )}
        {wo.diagnostico && <p><span className="muted">Diagnóstico:</span><br />{wo.diagnostico}</p>}
        {piezasLista(wo.piezasRequeridas).length > 0 && (
          <div>
            <span className="muted">Piezas requeridas:</span>
            <ol className="lista-piezas">
              {piezasLista(wo.piezasRequeridas).map((p, i) => <li key={i}>{p}</li>)}
            </ol>
          </div>
        )}
        {wo.notasMecanico && <p><span className="muted">Notas del mecánico:</span><br />{wo.notasMecanico}</p>}
      </div>

      <h3>Compras registradas</h3>
      {compras.length === 0 && <p className="muted">Sin compras para esta WO.</p>}
      {compras.map((c) => (
        <div key={c.id} className="tarjeta detalle">
          <div className="tarjeta-top">
            <span>{c.fecha}</span>
            <strong>{dinero(c.totalGeneralUSD, 'USD')}</strong>
          </div>
          <div className="muted">{(c.grupos ?? []).map((g) => g.proveedor).filter(Boolean).join(', ')}</div>
        </div>
      ))}
      {compras.length > 0 && (
        <p className="total-detalle">Total: {dinero(totalUSD, 'USD')}</p>
      )}

      <div className="acciones">
        <button className="btn-primario" onClick={() => setComprando(true)}>
          Registrar compra para esta WO
        </button>
        <button className="btn-secundario" onClick={onVolver}>Volver</button>
      </div>
    </div>
  )
}

/* ---------- Formulario de compra (con WO o directa) ---------- */
/* Estructura: la compra se agrupa por proveedor. Cada proveedor tiene su
   propia moneda y folio; dentro de cada uno, N conceptos con cantidad,
   costo unitario e IVA. El total general siempre se muestra consolidado
   en USD (empresa fronteriza), convirtiendo los grupos en MXN con el TC. */

const conceptoVacio = () => ({ concepto: '', cantidad: 1, costoUnitario: '', tasaIVA: 16 })
const grupoVacio = () => ({ proveedor: '', moneda: 'MXN', folioFactura: '', conceptos: [conceptoVacio()] })
const compraVacia = (wo) => ({
  unidadId: wo?.unidadId ?? '',
  unidadNumero: wo?.unidadNumero ?? '',
  fecha: hoy(),
  metodoPago: 'efectivo',
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

const calcGrupo = (g, tc) => {
  const conceptos = g.conceptos.map(calcConcepto)
  const subtotal = r2(conceptos.reduce((s, c) => s + c.subtotal, 0))
  const iva = r2(conceptos.reduce((s, c) => s + c.iva, 0))
  const total = r2(subtotal + iva)
  return {
    proveedor: g.proveedor, moneda: g.moneda, folioFactura: g.folioFactura,
    conceptos, subtotal, iva, total, totalUSD: aUSD(total, g.moneda, tc),
  }
}

function CompraForm({ usuario, wo, onDone }) {
  const unidades = useUnidades()
  const tc = useTipoCambio()
  const [busqueda, setBusqueda] = useState('')
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

  const filtradas = busqueda
    ? unidades.filter((u) => u.numero.toUpperCase().includes(busqueda.toUpperCase()))
    : unidades

  const calc = f.grupos.map((g) => calcGrupo(g, tc))
  const subtotalGeneralUSD = r2(calc.reduce((s, g) => s + aUSD(g.subtotal, g.moneda, tc), 0))
  const ivaGeneralUSD = r2(calc.reduce((s, g) => s + aUSD(g.iva, g.moneda, tc), 0))
  const totalGeneralUSD = r2(calc.reduce((s, g) => s + g.totalUSD, 0))

  const guardar = async () => {
    if (!f.unidadId) { alert('Selecciona una unidad'); return }
    if (!tc) { alert('Cargando tipo de cambio, intenta de nuevo en un momento'); return }
    const grupos = calc
      .map((g) => ({ ...g, conceptos: g.conceptos.filter((c) => c.concepto.trim() !== '' || c.subtotal > 0) }))
      .filter((g) => g.proveedor.trim() !== '' && g.conceptos.length > 0)
    if (grupos.length === 0) { alert('Agrega al menos un proveedor con un concepto'); return }
    setGuardando(true)
    try {
      await addDoc(collection(db, 'compras'), {
        woId: wo?.id ?? null,
        woNumero: wo?.wo ?? null,
        unidadId: f.unidadId,
        unidadNumero: f.unidadNumero,
        fecha: f.fecha,
        grupos,
        subtotalGeneralUSD: r2(grupos.reduce((s, g) => s + aUSD(g.subtotal, g.moneda, tc), 0)),
        ivaGeneralUSD: r2(grupos.reduce((s, g) => s + aUSD(g.iva, g.moneda, tc), 0)),
        totalGeneralUSD: r2(grupos.reduce((s, g) => s + g.totalUSD, 0)),
        tipoCambioUsado: tc,
        metodoPago: f.metodoPago,
        notas: f.notas,
        creadoPor: usuario.email,
        createdAt: serverTimestamp(),
      })
      if (onDone) {
        onDone()
      } else {
        alert('Compra guardada')
        setF(compraVacia(null))
        setBusqueda('')
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
      <h2>{wo ? `Compra para ${wo.wo}` : 'Nueva compra directa'}</h2>

      {wo ? (
        <label className="campo">
          <span>Unidad</span>
          <input value={wo.unidadNumero} disabled />
        </label>
      ) : (
        <label className="campo">
          <span>Unidad</span>
          <input
            placeholder="Buscar unidad…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            style={{ marginBottom: '0.4rem' }}
          />
          <select value={f.unidadId} onChange={(e) => {
            const u = unidades.find((x) => x.id === e.target.value)
            setF({ ...f, unidadId: u?.id ?? '', unidadNumero: u?.numero ?? '' })
          }}>
            <option value="">Selecciona unidad…</option>
            {Object.entries(TIPOS).map(([tipo, label]) => {
              const grupo = filtradas.filter((u) => u.tipo === tipo && u.activa !== false)
              return grupo.length > 0 && (
                <optgroup key={tipo} label={label}>
                  {grupo.map((u) => <option key={u.id} value={u.id}>{u.numero}</option>)}
                </optgroup>
              )
            })}
          </select>
        </label>
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
              <span>Proveedor</span>
              <input value={g.proveedor} onChange={setGrupoCampo(gi, 'proveedor')} />
            </label>
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

            {g.conceptos.map((c, ci) => {
              const cc = cg.conceptos[ci]
              return (
                <div key={ci} className="linea">
                  <label className="campo">
                    <span>Concepto</span>
                    <input value={c.concepto} onChange={setConcepto(gi, ci, 'concepto')} />
                  </label>
                  <div className="fila-3">
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

      <div className="acciones">
        <button className="btn-primario" disabled={guardando || !tc} onClick={guardar}>
          {guardando ? 'Guardando…' : 'Guardar compra'}
        </button>
        {onDone && <button className="btn-secundario" disabled={guardando} onClick={onDone}>Cancelar</button>}
      </div>
    </div>
  )
}

/* ---------- Sección 3: Unidades ---------- */

function Unidades() {
  const unidades = useUnidades()
  const [editando, setEditando] = useState(null) // objeto unidad | 'nueva' | null

  if (editando) {
    return (
      <UnidadForm
        unidad={editando === 'nueva' ? null : editando}
        onDone={() => setEditando(null)}
      />
    )
  }

  return (
    <div>
      <h2>Unidades</h2>
      {Object.entries(TIPOS).map(([tipo, label]) => {
        const grupo = unidades.filter((u) => u.tipo === tipo)
        return grupo.length > 0 && (
          <div key={tipo}>
            <h3>{label}</h3>
            {grupo.map((u) => (
              <button key={u.id} className="tarjeta" onClick={() => setEditando(u)}>
                <div className="tarjeta-top">
                  <strong>{u.numero}</strong>
                  <span className="muted">
                    {u.ultimaLectura != null ? `${u.ultimaLectura.toLocaleString()} ${u.unidadLectura}` : LECTURA_LABEL[u.unidadLectura]}
                  </span>
                </div>
                {(u.marca || u.anio || u.modelo) && (
                  <div className="muted">{[u.marca, u.anio, u.modelo].filter(Boolean).join(' ')}</div>
                )}
              </button>
            ))}
          </div>
        )
      })}
      <button className="fab" onClick={() => setEditando('nueva')} aria-label="Agregar unidad">+</button>
    </div>
  )
}

function UnidadForm({ unidad, onDone }) {
  const [f, setF] = useState(unidad ?? {
    numero: '', tipo: 'truck', unidadLectura: 'mi',
    marca: '', anio: '', modelo: '', vin: '',
  })
  const [guardando, setGuardando] = useState(false)
  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  const guardar = async () => {
    setGuardando(true)
    try {
      if (unidad) {
        await updateDoc(doc(db, 'unidades', unidad.id), {
          marca: f.marca, anio: f.anio, modelo: f.modelo, vin: f.vin,
          unidadLectura: f.unidadLectura,
        })
      } else {
        const numero = f.numero.trim().toUpperCase()
        if (!numero) { alert('Escribe el número de unidad'); return }
        const ref = doc(db, 'unidades', numero)
        if ((await getDoc(ref)).exists()) { alert(`Ya existe la unidad ${numero}`); return }
        await setDoc(ref, {
          numero, tipo: f.tipo, unidadLectura: f.unidadLectura,
          ultimaLectura: null,
          marca: f.marca, anio: f.anio, modelo: f.modelo, vin: f.vin,
          activa: true,
          createdAt: serverTimestamp(),
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

  return (
    <div>
      <h2>{unidad ? `Unidad ${unidad.numero}` : 'Agregar unidad'}</h2>
      {!unidad && (
        <>
          <label className="campo">
            <span>Número de unidad</span>
            <input value={f.numero} onChange={set('numero')} placeholder="Ej. F73" />
          </label>
          <label className="campo">
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
      <label className="campo">
        <span>Unidad de lectura</span>
        <select value={f.unidadLectura} onChange={set('unidadLectura')}>
          <option value="mi">Millas (mi)</option>
          <option value="km">Kilómetros (km)</option>
          <option value="hrs">Horas (hrs)</option>
        </select>
      </label>
      <label className="campo">
        <span>Marca</span>
        <input value={f.marca} onChange={set('marca')} />
      </label>
      <div className="fila-2">
        <label className="campo">
          <span>Año</span>
          <input value={f.anio} onChange={set('anio')} inputMode="numeric" />
        </label>
        <label className="campo">
          <span>Modelo</span>
          <input value={f.modelo} onChange={set('modelo')} />
        </label>
      </div>
      <label className="campo">
        <span>VIN / Serie</span>
        <input value={f.vin} onChange={set('vin')} />
      </label>
      <div className="acciones">
        <button className="btn-primario" disabled={guardando} onClick={guardar}>
          {guardando ? 'Guardando…' : (unidad ? 'Guardar cambios' : 'Guardar unidad')}
        </button>
        <button className="btn-secundario" disabled={guardando} onClick={onDone}>Cancelar</button>
      </div>
    </div>
  )
}
