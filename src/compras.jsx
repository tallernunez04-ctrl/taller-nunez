import { useEffect, useMemo, useState } from 'react'
import {
  collection, doc, increment, onSnapshot, orderBy, query, runTransaction,
  serverTimestamp, setDoc, updateDoc, where,
} from 'firebase/firestore'
import { db, subirArchivo } from './firebase'
import { supabase } from './lib/supabaseClient'
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

// acumula totales del mes en /balances/{YYYY-MM} — el dashboard de conciliación
// lee este doc consolidado en vez de recorrer miles de documentos
// ponytail: agregación desde el cliente; migrar a Cloud Function si crece la concurrencia
export const incBalance = (mes, campos) => setDoc(
  doc(db, 'balances', mes),
  Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, increment(r2(v))])),
  { merge: true },
)

// km/mi que faltan para el próximo mantenimiento (null = sin ciclo configurado)
export const paraMantenimiento = (u) => {
  if (!u.mantenimientoCadaX || u.ultimaLectura == null) return null
  return (Number(u.ultimoMantenimientoKm) || 0) + Number(u.mantenimientoCadaX) - u.ultimaLectura
}

export function BadgeMantenimiento({ unidad }) {
  const restante = paraMantenimiento(unidad)
  if (restante === null || restante > 2000) return null
  return restante <= 0
    ? <span className="badge vencido">Mantenimiento vencido</span>
    : <span className="badge alerta">Mantenimiento en {restante.toLocaleString()} {unidad.unidadLectura}</span>
}

// mapea columnas snake_case de Supabase a la forma camelCase que ya esperaba el resto de la app (ex-Firestore)
const mapUnidad = (u) => ({
  id: u.id,
  numero: u.numero,
  tipo: u.tipo,
  unidadLectura: u.unidad_lectura,
  marca: u.marca,
  modelo: u.modelo,
  vin: u.vin,
  anio: u.anio,
  ultimaLectura: u.ultima_lectura,
  mantenimientoCadaX: u.mantenimiento_cada_x,
  ultimoMantenimientoKm: u.ultimo_mantenimiento_km,
  activo: u.activo,
})

export function useUnidades() {
  const [unidades, setUnidades] = useState([])
  useEffect(() => {
    const cargar = () => supabase.from('unidades').select('*').then(({ data, error }) => {
      if (error) { console.error(error); return }
      setUnidades(data.map(mapUnidad).sort((a, b) => a.numero.localeCompare(b.numero, undefined, { numeric: true })))
    })
    cargar()
    const canal = supabase
      .channel('unidades-cambios')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'unidades' }, cargar)
      .subscribe()
    return () => supabase.removeChannel(canal)
  }, [])
  return unidades
}

export function useTipoCambio() {
  const [tc, setTc] = useState(null)
  useEffect(() => onSnapshot(doc(db, 'config', 'general'),
    (s) => setTc(s.data()?.tipoCambioUSD ?? null), console.error), [])
  return tc
}

export function useColeccion(nombre) {
  const [docs, setDocs] = useState(null)
  useEffect(() => onSnapshot(collection(db, nombre),
    (s) => setDocs(s.docs.map((d) => ({ id: d.id, ...d.data() }))), console.error), [nombre])
  return docs
}

export function SelectorUnidad({ unidades, value, onChange, placeholder }) {
  const [busqueda, setBusqueda] = useState('')
  const filtradas = busqueda
    ? unidades.filter((u) => u.numero.toUpperCase().includes(busqueda.toUpperCase()))
    : unidades
  return (
    <div className="campo">
      <input
        placeholder="Buscar unidad…"
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        style={{ marginBottom: '0.4rem' }}
      />
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {Object.entries(TIPOS).map(([tipo, label]) => {
          const grupo = filtradas.filter((u) => u.tipo === tipo)
          return grupo.length > 0 && (
            <optgroup key={tipo} label={label}>
              {grupo.map((u) => <option key={u.id} value={u.id}>{u.numero}</option>)}
            </optgroup>
          )
        })}
      </select>
    </div>
  )
}

export default function Compras({ usuario, vista }) {
  if (vista === 'nueva-compra') return <CompraForm usuario={usuario} />
  // también se monta desde el grupo de nav "dispatch"; compras solo puede consultar, no editar
  if (vista === 'unidades') return <Unidades soloLectura={usuario.rol === 'compras'} />
  if (vista === 'cuentas-pagar') return <CuentasPorPagar />
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
const grupoVacio = () => ({
  proveedorId: '', moneda: 'MXN', folioFactura: '',
  esDiesel: false, litrosFacturados: '',
  pdf: null, xml: null,
  conceptos: [conceptoVacio()],
})
const compraVacia = (wo) => ({
  unidadId: wo?.unidadId ?? '',
  unidadNumero: wo?.unidadNumero ?? '',
  esGeneral: false,
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

const calcGrupo = (g, tc, proveedores) => {
  const conceptos = g.conceptos.map(calcConcepto)
  const subtotal = r2(conceptos.reduce((s, c) => s + c.subtotal, 0))
  const iva = r2(conceptos.reduce((s, c) => s + c.iva, 0))
  const total = r2(subtotal + iva)
  const prov = (proveedores ?? []).find((p) => p.id === g.proveedorId)
  return {
    proveedorId: g.proveedorId,
    proveedor: prov?.razonSocial ?? g.proveedor ?? '',
    moneda: g.moneda, folioFactura: g.folioFactura,
    conceptos, subtotal, iva, total, totalUSD: aUSD(total, g.moneda, tc),
  }
}

const sumaDias = (fecha, dias) => {
  const d = new Date(fecha + 'T00:00')
  d.setDate(d.getDate() + dias)
  return d.toLocaleDateString('sv')
}

function CompraForm({ usuario, wo, onDone }) {
  const unidades = useUnidades()
  const tc = useTipoCambio()
  const proveedores = useColeccion('proveedores') ?? []
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

  const calc = f.grupos.map((g) => calcGrupo(g, tc, proveedores))
  const subtotalGeneralUSD = r2(calc.reduce((s, g) => s + aUSD(g.subtotal, g.moneda, tc), 0))
  const ivaGeneralUSD = r2(calc.reduce((s, g) => s + aUSD(g.iva, g.moneda, tc), 0))
  const totalGeneralUSD = r2(calc.reduce((s, g) => s + g.totalUSD, 0))

  const guardar = async () => {
    if (!f.esGeneral && !f.unidadId) { alert('Selecciona una unidad o marca la compra como general'); return }
    if (!tc) { alert('Cargando tipo de cambio, intenta de nuevo en un momento'); return }
    const esCredito = f.metodoPago === 'credito_proveedor'
    const grupos = calc
      .map((g, gi) => ({ gi, ...g, conceptos: g.conceptos.filter((c) => c.concepto.trim() !== '' || c.subtotal > 0) }))
      .filter((g) => g.proveedorId && g.conceptos.length > 0)
    if (grupos.length === 0) { alert('Agrega al menos un proveedor con un concepto'); return }
    if (esCredito && grupos.some((g) => !(proveedores.find((p) => p.id === g.proveedorId)?.diasCredito > 0))) {
      if (!confirm('Algún proveedor no tiene días de crédito configurados; el vencimiento será hoy. ¿Continuar?')) return
    }
    setGuardando(true)
    try {
      // cada proveedor genera su propio documento PO — refs pre-generadas para
      // subir adjuntos antes de la transacción y guardar folios consecutivos dentro de ella
      const docs = await Promise.all(grupos.map(async (g) => {
        const ref = doc(collection(db, 'compras'))
        const orig = f.grupos[g.gi]
        const facturaURL = orig.pdf ? await subirArchivo(`compras/${ref.id}/factura_${orig.pdf.name}`, orig.pdf) : ''
        const xmlURL = orig.xml ? await subirArchivo(`compras/${ref.id}/xml_${orig.xml.name}`, orig.xml) : ''
        return { ref, g, orig, facturaURL, xmlURL }
      }))
      await runTransaction(db, async (tx) => {
        const cfgRef = doc(db, 'config', 'general')
        const cfg = await tx.get(cfgRef)
        let n = cfg.data()?.ultimoPO ?? 0
        for (const { ref, g, orig, facturaURL, xmlURL } of docs) {
          n += 1
          const prov = proveedores.find((p) => p.id === g.proveedorId)
          const { gi: _gi, ...grupo } = g
          tx.set(ref, {
            poFolio: 'PO-' + String(n).padStart(4, '0'),
            woId: wo?.id ?? null,
            woNumero: wo?.wo ?? null,
            unidadId: f.esGeneral ? null : f.unidadId,
            unidadNumero: f.esGeneral ? 'General' : f.unidadNumero,
            esGeneral: f.esGeneral,
            fecha: f.fecha,
            grupos: [grupo], // un grupo por doc; los docs viejos con varios grupos se siguen leyendo igual
            subtotalGeneralUSD: aUSD(g.subtotal, g.moneda, tc),
            ivaGeneralUSD: aUSD(g.iva, g.moneda, tc),
            totalGeneralUSD: g.totalUSD,
            tipoCambioUsado: tc,
            metodoPago: f.metodoPago,
            tipoPago: esCredito ? 'credito' : 'contado',
            proveedorId: g.proveedorId,
            fechaVence: esCredito ? sumaDias(f.fecha, prov?.diasCredito ?? 0) : null,
            pagado: !esCredito, // contado queda pagado al momento
            comprobantePagoURL: '',
            facturaURL, xmlURL,
            esDiesel: Boolean(orig.esDiesel),
            litrosFacturados: orig.esDiesel ? (Number(orig.litrosFacturados) || 0) : 0,
            notas: f.notas,
            creadoPor: usuario.email,
            createdAt: serverTimestamp(),
          })
        }
        tx.update(cfgRef, { ultimoPO: n })
      })
      // agregación mensual para conciliación (fuera de la transacción: increment idempotente por guardado)
      const mes = f.fecha.slice(0, 7)
      const totalDiesel = r2(docs.reduce((s, { g, orig }) => s + (orig.esDiesel ? g.totalUSD : 0), 0))
      const litros = docs.reduce((s, { orig }) => s + (orig.esDiesel ? (Number(orig.litrosFacturados) || 0) : 0), 0)
      await incBalance(mes, {
        costoCompras: r2(docs.reduce((s, { g }) => s + g.totalUSD, 0)),
        ...(totalDiesel > 0 ? { costoDieselFacturado: totalDiesel, litrosFacturados: litros } : {}),
      })
      if (onDone) {
        onDone()
      } else {
        alert('Compra guardada')
        setF(compraVacia(null))
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
        <>
          <label className="campo" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={f.esGeneral}
              onChange={(e) => setF({ ...f, esGeneral: e.target.checked, unidadId: '', unidadNumero: '' })} />
            <span style={{ margin: 0 }}>Compra general de empresa (sin unidad: rentas, seguros, internet…)</span>
          </label>
          {!f.esGeneral && (
            <SelectorUnidad
              unidades={unidades}
              value={f.unidadId}
              onChange={(id) => {
                const u = unidades.find((x) => x.id === id)
                setF({ ...f, unidadId: u?.id ?? '', unidadNumero: u?.numero ?? '' })
              }}
              placeholder="Selecciona unidad…"
            />
          )}
        </>
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
              <span>Proveedor (catálogo)</span>
              <select value={g.proveedorId} onChange={setGrupoCampo(gi, 'proveedorId')}>
                <option value="">Selecciona proveedor…</option>
                {proveedores.slice().sort((a, b) => a.razonSocial.localeCompare(b.razonSocial)).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.razonSocial}{p.diasCredito ? ` (${p.diasCredito} días)` : ''}
                  </option>
                ))}
              </select>
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
            <label className="campo" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={g.esDiesel}
                onChange={(e) => setF({ ...f, grupos: f.grupos.map((x, j) => (j === gi ? { ...x, esDiesel: e.target.checked } : x)) })} />
              <span style={{ margin: 0 }}>Factura de diésel (gasolinera consolidada)</span>
            </label>
            {g.esDiesel && (
              <label className="campo">
                <span>Litros facturados (para auditoría vs. cargas de choferes)</span>
                <input type="number" inputMode="decimal" min="0" step="0.01" value={g.litrosFacturados}
                  onChange={setGrupoCampo(gi, 'litrosFacturados')} />
              </label>
            )}
            <div className="fila-2">
              <label className="campo">
                <span>Factura PDF (opcional)</span>
                <input type="file" accept=".pdf,image/*"
                  onChange={(e) => setF({ ...f, grupos: f.grupos.map((x, j) => (j === gi ? { ...x, pdf: e.target.files[0] ?? null } : x)) })} />
              </label>
              <label className="campo">
                <span>Factura XML (opcional)</span>
                <input type="file" accept=".xml"
                  onChange={(e) => setF({ ...f, grupos: f.grupos.map((x, j) => (j === gi ? { ...x, xml: e.target.files[0] ?? null } : x)) })} />
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

function Unidades({ soloLectura }) {
  const unidades = useUnidades()
  const [editando, setEditando] = useState(null) // objeto unidad | 'nueva' | null

  if (editando && !soloLectura) {
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
            {grupo.map((u) => {
              const Tarjeta = soloLectura ? 'div' : 'button'
              return (
                <Tarjeta key={u.id} className="tarjeta" onClick={soloLectura ? undefined : () => setEditando(u)}>
                  <div className="tarjeta-top">
                    <strong>{u.numero}</strong>
                    <span className="muted">
                      {u.ultimaLectura != null ? `${u.ultimaLectura.toLocaleString()} ${u.unidadLectura}` : LECTURA_LABEL[u.unidadLectura]}
                    </span>
                  </div>
                  {(u.marca || u.anio || u.modelo) && (
                    <div className="muted">{[u.marca, u.anio, u.modelo].filter(Boolean).join(' ')}</div>
                  )}
                  <BadgeMantenimiento unidad={u} />
                </Tarjeta>
              )
            })}
          </div>
        )
      })}
      {!soloLectura && (
        <button className="fab" onClick={() => setEditando('nueva')} aria-label="Agregar unidad">+</button>
      )}
    </div>
  )
}

function UnidadForm({ unidad, onDone }) {
  // Supabase manda null en los campos opcionales sin capturar -- un input controlado no acepta
  // null como value, y Number(null) === 0 se colaría al guardar violando el check de anio.
  const [f, setF] = useState(() => ({
    numero: unidad?.numero ?? '', tipo: unidad?.tipo ?? 'truck', unidadLectura: unidad?.unidadLectura ?? 'mi',
    marca: unidad?.marca ?? '', anio: unidad?.anio ?? '', modelo: unidad?.modelo ?? '', vin: unidad?.vin ?? '',
    mantenimientoCadaX: unidad?.mantenimientoCadaX ?? '', ultimoMantenimientoKm: unidad?.ultimoMantenimientoKm ?? '',
  }))
  const [guardando, setGuardando] = useState(false)
  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  const guardar = async () => {
    setGuardando(true)
    try {
      if (unidad) {
        const { error } = await supabase.from('unidades').update({
          marca: f.marca, anio: f.anio === '' ? null : Number(f.anio), modelo: f.modelo, vin: f.vin,
          unidad_lectura: f.unidadLectura,
          mantenimiento_cada_x: Number(f.mantenimientoCadaX) || 0,
          ultimo_mantenimiento_km: Number(f.ultimoMantenimientoKm) || 0,
        }).eq('id', unidad.id)
        if (error) throw error
      } else {
        const numero = f.numero.trim().toUpperCase()
        if (!numero) { alert('Escribe el número de unidad'); return }
        const { error } = await supabase.from('unidades').insert({
          numero, tipo: f.tipo, unidad_lectura: f.unidadLectura,
          mantenimiento_cada_x: Number(f.mantenimientoCadaX) || 0,
          ultimo_mantenimiento_km: Number(f.ultimoMantenimientoKm) || 0,
          marca: f.marca, anio: f.anio === '' ? null : Number(f.anio), modelo: f.modelo, vin: f.vin,
        })
        if (error) {
          if (error.code === '23505') { alert(`Ya existe la unidad ${numero}`); return }
          throw error
        }
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
      {f.tipo === 'truck' && (
        <div className="fila-2">
          <label className="campo">
            <span>Mantenimiento cada ({f.unidadLectura})</span>
            <input type="number" inputMode="numeric" min="0" value={f.mantenimientoCadaX}
              onChange={set('mantenimientoCadaX')} placeholder="Ej. 50000" />
          </label>
          <label className="campo">
            <span>Último mantenimiento en ({f.unidadLectura})</span>
            <input type="number" inputMode="numeric" min="0" value={f.ultimoMantenimientoKm}
              onChange={set('ultimoMantenimientoKm')} />
          </label>
        </div>
      )}
      <div className="acciones">
        <button className="btn-primario" disabled={guardando} onClick={guardar}>
          {guardando ? 'Guardando…' : (unidad ? 'Guardar cambios' : 'Guardar unidad')}
        </button>
        <button className="btn-secundario" disabled={guardando} onClick={onDone}>Cancelar</button>
      </div>
    </div>
  )
}

/* ---------- Sección 4: Cuentas por Pagar ---------- */

// lunes de la semana de una fecha YYYY-MM-DD (agrupa vencimientos por semana)
const lunesDe = (fecha) => {
  const d = new Date(fecha + 'T00:00')
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.toLocaleDateString('sv')
}

function CuentasPorPagar() {
  const [compras, setCompras] = useState(null)
  const [pagando, setPagando] = useState(null) // compra en proceso de pago
  const [comprobante, setComprobante] = useState(null)
  const [guardando, setGuardando] = useState(false)

  useEffect(() => onSnapshot(
    query(collection(db, 'compras'), where('tipoPago', '==', 'credito')),
    (s) => setCompras(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
    console.error,
  ), [])

  const pendientes = (compras ?? []).filter((c) => !c.pagado)
    .sort((a, b) => (a.fechaVence || '').localeCompare(b.fechaVence || ''))
  const totalUSD = r2(pendientes.reduce((s, c) => s + (c.totalGeneralUSD ?? 0), 0))

  // agrupa por semana de vencimiento
  const semanas = {}
  pendientes.forEach((c) => {
    const clave = c.fechaVence ? lunesDe(c.fechaVence) : 'sin-fecha'
    ;(semanas[clave] ??= []).push(c)
  })

  const pagar = async () => {
    setGuardando(true)
    try {
      const url = comprobante
        ? await subirArchivo(`compras/${pagando.id}/pago_${comprobante.name}`, comprobante)
        : ''
      await updateDoc(doc(db, 'compras', pagando.id), {
        pagado: true,
        pagadoAt: hoy(),
        comprobantePagoURL: url,
      })
      setPagando(null)
      setComprobante(null)
    } catch (e) {
      console.error(e)
      alert('Error: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const hoyStr = hoy()

  if (pagando) {
    return (
      <div>
        <h2>Pagar {pagando.poFolio || 'compra'}</h2>
        <div className="tarjeta detalle">
          <p><span className="muted">Proveedor:</span> {(pagando.grupos ?? []).map((g) => g.proveedor).join(', ')}</p>
          <p><span className="muted">Vence:</span> {pagando.fechaVence}</p>
          <p><span className="muted">Monto:</span> <strong>{dinero(pagando.totalGeneralUSD, 'USD')}</strong></p>
        </div>
        <label className="campo"><span>Comprobante de pago</span>
          <input type="file" accept=".pdf,image/*" onChange={(e) => setComprobante(e.target.files[0] ?? null)} />
        </label>
        <div className="acciones">
          <button className="btn-completar" disabled={guardando} onClick={pagar}>
            {guardando ? 'Guardando…' : 'Confirmar pago'}
          </button>
          <button className="btn-secundario" disabled={guardando} onClick={() => setPagando(null)}>Cancelar</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2>Cuentas por pagar</h2>
      <div className="kpis">
        <div className="kpi">Facturas pendientes<strong>{pendientes.length}</strong></div>
        <div className="kpi">Total por pagar<strong>{dinero(totalUSD, 'USD')}</strong></div>
      </div>
      {compras === null && <p className="muted">Cargando…</p>}
      {compras !== null && pendientes.length === 0 && <p className="muted vacio">Sin cuentas por pagar. 🎉</p>}
      {Object.entries(semanas).sort(([a], [b]) => a.localeCompare(b)).map(([semana, lista]) => (
        <div key={semana}>
          <h3>
            {semana === 'sin-fecha' ? 'Sin fecha de vencimiento' : `Semana del ${semana}`}
            {' · '}{dinero(r2(lista.reduce((s, c) => s + (c.totalGeneralUSD ?? 0), 0)), 'USD')}
          </h3>
          {lista.map((c) => (
            <div key={c.id} className="tarjeta">
              <div className="tarjeta-top">
                <strong>{c.poFolio || c.fecha} · {(c.grupos ?? []).map((g) => g.proveedor).join(', ')}</strong>
                <strong>{dinero(c.totalGeneralUSD, 'USD')}</strong>
              </div>
              <div className="muted">
                Compra {c.fecha} · {c.esGeneral ? 'General' : `Unidad ${c.unidadNumero}`}
                {c.fechaVence && (
                  c.fechaVence < hoyStr
                    ? <span className="badge vencido" style={{ marginLeft: '0.5rem' }}>Vencida</span>
                    : <span> · vence {c.fechaVence}</span>
                )}
              </div>
              {c.facturaURL && <div><a href={c.facturaURL} target="_blank" rel="noreferrer">Ver factura</a></div>}
              <button className="btn-secundario" onClick={() => setPagando(c)}>Registrar pago</button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
