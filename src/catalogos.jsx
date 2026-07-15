import { useEffect, useState } from 'react'
import {
  addDoc, collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc, updateDoc,
} from 'firebase/firestore'
import { db } from './firebase'
import { useColeccion, useUnidades } from './compras'

/* Catálogos del ERP: Operadores, Clientes (+direcciones), Proveedores y Tabulador.
   Todos siguen el patrón lista-tarjetas + formulario de Unidades (compras.jsx). */

// días que faltan para una fecha YYYY-MM-DD (negativo = ya venció)
export const diasPara = (fecha) => {
  if (!fecha) return null
  return Math.ceil((new Date(fecha + 'T00:00') - new Date()) / 86400000)
}

// el apto médico vence al año de su fecha
export const venceAptoMedico = (fecha) => {
  if (!fecha) return null
  const d = new Date(fecha + 'T00:00')
  d.setFullYear(d.getFullYear() + 1)
  return d.toLocaleDateString('sv')
}

export function BadgeVencimiento({ etiqueta, fecha }) {
  const dias = diasPara(fecha)
  if (dias === null) return null
  if (dias < 0) return <span className="badge vencido">{etiqueta} vencido</span>
  if (dias <= 30) return <span className="badge alerta">{etiqueta} vence en {dias} d</span>
  return null
}

export default function Catalogos({ vista }) {
  if (vista === 'clientes') return <Clientes />
  if (vista === 'proveedores') return <Proveedores />
  if (vista === 'tabulador') return <Tabulador />
  return <Operadores />
}

/* ---------- Operadores (choferes) ---------- */

const contactoVacio = () => ({ nombre: '', relacion: '', telefono: '' })
const operadorVacio = () => ({
  nombre: '', telefono: '', direccion: '', rfc: '', curp: '', email: '',
  licencia: { numero: '', vence: '' },
  visa: { numero: '', vence: '' },
  aptoMedicoFecha: '',
  contactosEmergencia: [contactoVacio()],
  unidadBaseId: '',
  activo: true,
})

function Operadores() {
  const operadores = useColeccion('operadores')
  const unidades = useUnidades()
  const [editando, setEditando] = useState(null) // objeto | 'nuevo' | null
  const numeroDe = Object.fromEntries(unidades.map((u) => [u.id, u.numero]))

  if (editando) {
    return <OperadorForm operador={editando === 'nuevo' ? null : editando} unidades={unidades} onDone={() => setEditando(null)} />
  }

  const lista = (operadores ?? []).slice().sort((a, b) => a.nombre.localeCompare(b.nombre))
  return (
    <div>
      <h2>Operadores</h2>
      {operadores === null && <p className="muted">Cargando…</p>}
      {operadores !== null && lista.length === 0 && (
        <p className="muted vacio">Sin operadores registrados.<br />Toca + para agregar el primero.</p>
      )}
      {lista.map((o) => (
        <button key={o.id} className="tarjeta" onClick={() => setEditando(o)}>
          <div className="tarjeta-top">
            <strong>{o.nombre}</strong>
            <span className={'badge ' + (o.activo ? 'completado' : 'inactivo')}>{o.activo ? 'Activo' : 'Inactivo'}</span>
          </div>
          <div className="muted">
            {o.telefono}
            {o.unidadBaseId && ` · Unidad base: ${numeroDe[o.unidadBaseId] ?? o.unidadBaseId}`}
          </div>
          <div className="chips">
            <BadgeVencimiento etiqueta="Licencia" fecha={o.licencia?.vence} />
            <BadgeVencimiento etiqueta="Visa" fecha={o.visa?.vence} />
            <BadgeVencimiento etiqueta="Apto médico" fecha={venceAptoMedico(o.aptoMedicoFecha)} />
          </div>
        </button>
      ))}
      <button className="fab" onClick={() => setEditando('nuevo')} aria-label="Agregar operador">+</button>
    </div>
  )
}

function OperadorForm({ operador, unidades, onDone }) {
  const [f, setF] = useState(() => operador
    ? { ...operadorVacio(), ...operador, contactosEmergencia: operador.contactosEmergencia?.length ? operador.contactosEmergencia : [contactoVacio()] }
    : operadorVacio())
  const [guardando, setGuardando] = useState(false)
  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })
  const setAnidado = (campo, sub) => (e) => setF({ ...f, [campo]: { ...f[campo], [sub]: e.target.value } })
  const setContacto = (i, campo) => (e) => setF({
    ...f,
    contactosEmergencia: f.contactosEmergencia.map((c, j) => (j === i ? { ...c, [campo]: e.target.value } : c)),
  })

  const guardar = async () => {
    if (!f.nombre.trim()) { alert('Escribe el nombre del operador'); return }
    setGuardando(true)
    try {
      const datos = {
        nombre: f.nombre.trim(),
        telefono: f.telefono, direccion: f.direccion, rfc: f.rfc, curp: f.curp,
        email: f.email.trim().toLowerCase(),
        licencia: f.licencia, visa: f.visa, aptoMedicoFecha: f.aptoMedicoFecha,
        contactosEmergencia: f.contactosEmergencia.filter((c) => c.nombre.trim()),
        unidadBaseId: f.unidadBaseId,
        activo: f.activo,
      }
      if (operador) {
        await updateDoc(doc(db, 'operadores', operador.id), datos)
      } else {
        await addDoc(collection(db, 'operadores'), { ...datos, createdAt: serverTimestamp() })
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
      <h2>{operador ? operador.nombre : 'Nuevo operador'}</h2>
      <label className="campo"><span>Nombre completo</span>
        <input value={f.nombre} onChange={set('nombre')} />
      </label>
      <div className="fila-2">
        <label className="campo"><span>Teléfono</span>
          <input value={f.telefono} onChange={set('telefono')} inputMode="tel" />
        </label>
        <label className="campo"><span>Correo (cuenta Google para la app)</span>
          <input type="email" value={f.email} onChange={set('email')} />
        </label>
      </div>
      <label className="campo"><span>Dirección</span>
        <input value={f.direccion} onChange={set('direccion')} />
      </label>
      <div className="fila-2">
        <label className="campo"><span>RFC</span>
          <input value={f.rfc} onChange={set('rfc')} />
        </label>
        <label className="campo"><span>CURP</span>
          <input value={f.curp} onChange={set('curp')} />
        </label>
      </div>

      <h3>Documentos</h3>
      <div className="fila-2">
        <label className="campo"><span>Licencia (número)</span>
          <input value={f.licencia.numero} onChange={setAnidado('licencia', 'numero')} />
        </label>
        <label className="campo"><span>Licencia vence</span>
          <input type="date" value={f.licencia.vence} onChange={setAnidado('licencia', 'vence')} />
        </label>
      </div>
      <div className="fila-2">
        <label className="campo"><span>Visa (número)</span>
          <input value={f.visa.numero} onChange={setAnidado('visa', 'numero')} />
        </label>
        <label className="campo"><span>Visa vence</span>
          <input type="date" value={f.visa.vence} onChange={setAnidado('visa', 'vence')} />
        </label>
      </div>
      <label className="campo"><span>Fecha del apto médico (vence al año)</span>
        <input type="date" value={f.aptoMedicoFecha} onChange={set('aptoMedicoFecha')} />
      </label>
      {f.aptoMedicoFecha && (
        <p className="muted tc-nota">Vence: {venceAptoMedico(f.aptoMedicoFecha)}</p>
      )}

      <h3>Contactos de emergencia</h3>
      {f.contactosEmergencia.map((c, i) => (
        <div key={i} className="linea">
          <label className="campo"><span>Nombre</span>
            <input value={c.nombre} onChange={setContacto(i, 'nombre')} />
          </label>
          <div className="fila-2">
            <label className="campo"><span>Relación</span>
              <input value={c.relacion} onChange={setContacto(i, 'relacion')} placeholder="Esposa, hermano…" />
            </label>
            <label className="campo"><span>Teléfono</span>
              <input value={c.telefono} onChange={setContacto(i, 'telefono')} inputMode="tel" />
            </label>
          </div>
        </div>
      ))}
      {f.contactosEmergencia.length < 2 && (
        <button type="button" className="btn-secundario btn-bloque"
          onClick={() => setF({ ...f, contactosEmergencia: [...f.contactosEmergencia, contactoVacio()] })}>
          + Agregar segundo contacto
        </button>
      )}

      <h3>Asignación</h3>
      <label className="campo"><span>Unidad base</span>
        <select value={f.unidadBaseId} onChange={set('unidadBaseId')}>
          <option value="">Sin unidad asignada</option>
          {unidades.filter((u) => u.tipo === 'truck').map((u) => (
            <option key={u.id} value={u.id}>{u.numero}</option>
          ))}
        </select>
      </label>
      <label className="campo" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={f.activo}
          onChange={(e) => setF({ ...f, activo: e.target.checked })} />
        <span style={{ margin: 0 }}>Activo</span>
      </label>

      <div className="acciones">
        <button className="btn-primario" disabled={guardando} onClick={guardar}>
          {guardando ? 'Guardando…' : 'Guardar operador'}
        </button>
        <button className="btn-secundario" disabled={guardando} onClick={onDone}>Cancelar</button>
      </div>
    </div>
  )
}

/* ---------- Clientes (+ subcolección direcciones) ---------- */

const clienteVacio = () => ({ razonSocial: '', contacto: '', rfc: '', telefono: '', correo: '', diasCredito: 0 })

function Clientes() {
  const clientes = useColeccion('clientes')
  const [editando, setEditando] = useState(null)

  if (editando) {
    return <ClienteForm cliente={editando === 'nuevo' ? null : editando} onDone={() => setEditando(null)} />
  }

  const lista = (clientes ?? []).slice().sort((a, b) => a.razonSocial.localeCompare(b.razonSocial))
  return (
    <div>
      <h2>Clientes</h2>
      {clientes === null && <p className="muted">Cargando…</p>}
      {clientes !== null && lista.length === 0 && (
        <p className="muted vacio">Sin clientes registrados.<br />Toca + para agregar el primero.</p>
      )}
      {lista.map((c) => (
        <button key={c.id} className="tarjeta" onClick={() => setEditando(c)}>
          <div className="tarjeta-top">
            <strong>{c.razonSocial}</strong>
            <span className="muted">{c.diasCredito ? `${c.diasCredito} días crédito` : 'Contado'}</span>
          </div>
          <div className="muted">{[c.contacto, c.telefono, c.rfc].filter(Boolean).join(' · ')}</div>
        </button>
      ))}
      <button className="fab" onClick={() => setEditando('nuevo')} aria-label="Agregar cliente">+</button>
    </div>
  )
}

const direccionVacia = () => ({ calle: '', ciudad: '', estado: '', pais: 'México', cp: '' })
export const direccionTexto = (d) => [d.calle, d.ciudad, d.estado, d.pais, d.cp].filter(Boolean).join(', ')

function ClienteForm({ cliente, onDone }) {
  const [f, setF] = useState(cliente ?? clienteVacio())
  const [guardando, setGuardando] = useState(false)
  const [direcciones, setDirecciones] = useState([])
  const [dirForm, setDirForm] = useState(null) // {id?} en edición | null
  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  useEffect(() => {
    if (!cliente) return undefined
    return onSnapshot(collection(db, 'clientes', cliente.id, 'direcciones'),
      (s) => setDirecciones(s.docs.map((d) => ({ id: d.id, ...d.data() }))), console.error)
  }, [cliente])

  const guardar = async () => {
    if (!f.razonSocial.trim()) { alert('Escribe la razón social'); return }
    setGuardando(true)
    try {
      const datos = {
        razonSocial: f.razonSocial.trim(), contacto: f.contacto, rfc: f.rfc,
        telefono: f.telefono, correo: f.correo, diasCredito: Number(f.diasCredito) || 0,
      }
      if (cliente) {
        await updateDoc(doc(db, 'clientes', cliente.id), datos)
      } else {
        await addDoc(collection(db, 'clientes'), { ...datos, createdAt: serverTimestamp() })
      }
      onDone()
    } catch (e) {
      console.error(e)
      alert('Error al guardar: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const guardarDireccion = async () => {
    if (!dirForm.calle.trim() || !dirForm.ciudad.trim()) { alert('Calle y ciudad son obligatorias'); return }
    try {
      const { id, ...datos } = dirForm
      if (id) {
        await updateDoc(doc(db, 'clientes', cliente.id, 'direcciones', id), datos)
      } else {
        await addDoc(collection(db, 'clientes', cliente.id, 'direcciones'), datos)
      }
      setDirForm(null)
    } catch (e) { alert('Error: ' + e.message) }
  }

  const borrarDireccion = async (id) => {
    if (!confirm('¿Eliminar esta dirección?')) return
    try { await deleteDoc(doc(db, 'clientes', cliente.id, 'direcciones', id)) } catch (e) { alert('Error: ' + e.message) }
  }

  return (
    <div>
      <h2>{cliente ? cliente.razonSocial : 'Nuevo cliente'}</h2>
      <label className="campo"><span>Razón social</span>
        <input value={f.razonSocial} onChange={set('razonSocial')} />
      </label>
      <div className="fila-2">
        <label className="campo"><span>Contacto</span>
          <input value={f.contacto} onChange={set('contacto')} />
        </label>
        <label className="campo"><span>RFC</span>
          <input value={f.rfc} onChange={set('rfc')} />
        </label>
      </div>
      <div className="fila-2">
        <label className="campo"><span>Teléfono</span>
          <input value={f.telefono} onChange={set('telefono')} inputMode="tel" />
        </label>
        <label className="campo"><span>Correo</span>
          <input type="email" value={f.correo} onChange={set('correo')} />
        </label>
      </div>
      <label className="campo"><span>Días de crédito autorizados</span>
        <input type="number" inputMode="numeric" min="0" value={f.diasCredito} onChange={set('diasCredito')} />
      </label>

      {cliente && (
        <>
          <h3>Direcciones</h3>
          {direcciones.map((d) => (
            <div key={d.id} className="tarjeta detalle">
              <div className="tarjeta-top">
                <span>{direccionTexto(d)}</span>
                <span>
                  <button type="button" className="btn-borrar" aria-label="Editar" onClick={() => setDirForm(d)}>✏️</button>
                  <button type="button" className="btn-borrar" aria-label="Eliminar" onClick={() => borrarDireccion(d.id)}>🗑</button>
                </span>
              </div>
            </div>
          ))}
          {dirForm ? (
            <div className="linea">
              <label className="campo"><span>Calle y número</span>
                <input value={dirForm.calle} onChange={(e) => setDirForm({ ...dirForm, calle: e.target.value })} />
              </label>
              <div className="fila-2">
                <label className="campo"><span>Ciudad</span>
                  <input value={dirForm.ciudad} onChange={(e) => setDirForm({ ...dirForm, ciudad: e.target.value })} />
                </label>
                <label className="campo"><span>Estado</span>
                  <input value={dirForm.estado} onChange={(e) => setDirForm({ ...dirForm, estado: e.target.value })} />
                </label>
              </div>
              <div className="fila-2">
                <label className="campo"><span>País</span>
                  <input value={dirForm.pais} onChange={(e) => setDirForm({ ...dirForm, pais: e.target.value })} />
                </label>
                <label className="campo"><span>Código postal</span>
                  <input value={dirForm.cp} onChange={(e) => setDirForm({ ...dirForm, cp: e.target.value })} inputMode="numeric" />
                </label>
              </div>
              <div className="acciones">
                <button className="btn-primario" onClick={guardarDireccion}>Guardar dirección</button>
                <button className="btn-secundario" onClick={() => setDirForm(null)}>Cancelar</button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn-secundario btn-bloque" onClick={() => setDirForm(direccionVacia())}>
              + Agregar dirección
            </button>
          )}
        </>
      )}
      {!cliente && <p className="muted">Guarda el cliente para poder agregar direcciones.</p>}

      <div className="acciones">
        <button className="btn-primario" disabled={guardando} onClick={guardar}>
          {guardando ? 'Guardando…' : 'Guardar cliente'}
        </button>
        <button className="btn-secundario" disabled={guardando} onClick={onDone}>Cancelar</button>
      </div>
    </div>
  )
}

/* ---------- Proveedores ---------- */

const proveedorVacio = () => ({
  razonSocial: '', rfc: '', diasCredito: 0,
  banco: { nombre: '', clabe: '', cuenta: '' },
})

function Proveedores() {
  const proveedores = useColeccion('proveedores')
  const [editando, setEditando] = useState(null)

  if (editando) {
    return <ProveedorForm proveedor={editando === 'nuevo' ? null : editando} onDone={() => setEditando(null)} />
  }

  const lista = (proveedores ?? []).slice().sort((a, b) => a.razonSocial.localeCompare(b.razonSocial))
  return (
    <div>
      <h2>Proveedores</h2>
      {proveedores === null && <p className="muted">Cargando…</p>}
      {proveedores !== null && lista.length === 0 && (
        <p className="muted vacio">Sin proveedores registrados.<br />Toca + para agregar el primero.</p>
      )}
      {lista.map((p) => (
        <button key={p.id} className="tarjeta" onClick={() => setEditando(p)}>
          <div className="tarjeta-top">
            <strong>{p.razonSocial}</strong>
            <span className="muted">{p.diasCredito ? `${p.diasCredito} días crédito` : 'Contado'}</span>
          </div>
          <div className="muted">{[p.rfc, p.banco?.nombre].filter(Boolean).join(' · ')}</div>
        </button>
      ))}
      <button className="fab" onClick={() => setEditando('nuevo')} aria-label="Agregar proveedor">+</button>
    </div>
  )
}

function ProveedorForm({ proveedor, onDone }) {
  const [f, setF] = useState(() => proveedor ? { ...proveedorVacio(), ...proveedor } : proveedorVacio())
  const [guardando, setGuardando] = useState(false)
  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })
  const setBanco = (sub) => (e) => setF({ ...f, banco: { ...f.banco, [sub]: e.target.value } })

  const guardar = async () => {
    if (!f.razonSocial.trim()) { alert('Escribe la razón social'); return }
    setGuardando(true)
    try {
      const datos = {
        razonSocial: f.razonSocial.trim(), rfc: f.rfc,
        diasCredito: Number(f.diasCredito) || 0, banco: f.banco,
      }
      if (proveedor) {
        await updateDoc(doc(db, 'proveedores', proveedor.id), datos)
      } else {
        await addDoc(collection(db, 'proveedores'), { ...datos, createdAt: serverTimestamp() })
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
      <h2>{proveedor ? proveedor.razonSocial : 'Nuevo proveedor'}</h2>
      <label className="campo"><span>Razón social</span>
        <input value={f.razonSocial} onChange={set('razonSocial')} />
      </label>
      <div className="fila-2">
        <label className="campo"><span>RFC</span>
          <input value={f.rfc} onChange={set('rfc')} />
        </label>
        <label className="campo"><span>Días de crédito</span>
          <input type="number" inputMode="numeric" min="0" value={f.diasCredito} onChange={set('diasCredito')} />
        </label>
      </div>
      <h3>Datos bancarios</h3>
      <label className="campo"><span>Banco</span>
        <input value={f.banco.nombre} onChange={setBanco('nombre')} />
      </label>
      <div className="fila-2">
        <label className="campo"><span>CLABE</span>
          <input value={f.banco.clabe} onChange={setBanco('clabe')} inputMode="numeric" />
        </label>
        <label className="campo"><span>Cuenta</span>
          <input value={f.banco.cuenta} onChange={setBanco('cuenta')} inputMode="numeric" />
        </label>
      </div>
      <div className="acciones">
        <button className="btn-primario" disabled={guardando} onClick={guardar}>
          {guardando ? 'Guardando…' : 'Guardar proveedor'}
        </button>
        <button className="btn-secundario" disabled={guardando} onClick={onDone}>Cancelar</button>
      </div>
    </div>
  )
}

/* ---------- Tabulador (pago a chofer por tramo origen-destino) ---------- */

function Tabulador() {
  const tramos = useColeccion('tabuladores')
  const [f, setF] = useState(null) // {id?} en edición | null
  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  const guardar = async () => {
    if (!f.origen.trim() || !f.destino.trim()) { alert('Origen y destino son obligatorios'); return }
    if (!(Number(f.pagoChofer) > 0)) { alert('Escribe el pago al chofer'); return }
    try {
      const { id, ...datos } = f
      const limpio = {
        origen: datos.origen.trim(), destino: datos.destino.trim(),
        pagoChofer: Number(datos.pagoChofer), km: Number(datos.km) || 0,
      }
      if (id) {
        await updateDoc(doc(db, 'tabuladores', id), limpio)
      } else {
        await addDoc(collection(db, 'tabuladores'), { ...limpio, createdAt: serverTimestamp() })
      }
      setF(null)
    } catch (e) { alert('Error: ' + e.message) }
  }

  const borrar = async (id) => {
    if (!confirm('¿Eliminar este tramo del tabulador?')) return
    try { await deleteDoc(doc(db, 'tabuladores', id)) } catch (e) { alert('Error: ' + e.message) }
  }

  const lista = (tramos ?? []).slice().sort((a, b) => (a.origen + a.destino).localeCompare(b.origen + b.destino))
  return (
    <div>
      <h2>Tabulador de rutas</h2>
      <p className="muted">Pago al chofer por tramo origen → destino. Se usa en el costeo de viajes y en nómina.</p>

      {f && (
        <div className="linea">
          <div className="fila-2">
            <label className="campo"><span>Origen</span>
              <input value={f.origen} onChange={set('origen')} placeholder="Cd. Juárez" />
            </label>
            <label className="campo"><span>Destino</span>
              <input value={f.destino} onChange={set('destino')} placeholder="Monterrey" />
            </label>
          </div>
          <div className="fila-2">
            <label className="campo"><span>Pago al chofer (USD)</span>
              <input type="number" inputMode="decimal" min="0" step="0.01" value={f.pagoChofer} onChange={set('pagoChofer')} />
            </label>
            <label className="campo"><span>Km del tramo (opcional)</span>
              <input type="number" inputMode="numeric" min="0" value={f.km} onChange={set('km')} />
            </label>
          </div>
          <div className="acciones">
            <button className="btn-primario" onClick={guardar}>Guardar tramo</button>
            <button className="btn-secundario" onClick={() => setF(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {tramos === null && <p className="muted">Cargando…</p>}
      {tramos !== null && lista.length === 0 && !f && (
        <p className="muted vacio">Sin tramos registrados.<br />Toca + para agregar el primero.</p>
      )}
      {lista.length > 0 && (
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr><th>Origen</th><th>Destino</th><th className="num">Pago chofer</th><th className="num">Km</th><th></th></tr>
            </thead>
            <tbody>
              {lista.map((t) => (
                <tr key={t.id}>
                  <td>{t.origen}</td>
                  <td>{t.destino}</td>
                  <td className="num">${(t.pagoChofer || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td>
                  <td className="num">{t.km || ''}</td>
                  <td>
                    <button type="button" className="btn-borrar" aria-label="Editar" onClick={() => setF(t)}>✏️</button>
                    <button type="button" className="btn-borrar" aria-label="Eliminar" onClick={() => borrar(t.id)}>🗑</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!f && <button className="fab" onClick={() => setF({ origen: '', destino: '', pagoChofer: '', km: '' })} aria-label="Agregar tramo">+</button>}
    </div>
  )
}
