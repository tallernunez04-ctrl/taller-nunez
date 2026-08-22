import { useEffect, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import { useTabla, useUnidades, BarraAcciones } from './compras'

/* Catálogos del ERP: Operadores, Clientes (+direcciones), Proveedores y Tabulador.
   Todos siguen el patrón lista-tarjetas + formulario de Unidades (compras.jsx).
   Migrado a Supabase -- ver mapXxx() para el snake_case -> camelCase de cada tabla. */

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
  if (vista === 'gasolineras') return <Gasolineras />
  return <Operadores />
}

const mapOperador = (o) => ({
  id: o.id,
  perfilId: o.perfil_id ?? '',
  nombre: o.nombre,
  telefono: o.telefono ?? '',
  direccion: o.direccion ?? '',
  rfc: o.rfc ?? '',
  curp: o.curp ?? '',
  email: o.email ?? '',
  licencia: { numero: o.licencia_numero ?? '', vence: o.licencia_vence ?? '' },
  visa: { numero: o.visa_numero ?? '', vence: o.visa_vence ?? '' },
  aptoMedicoFecha: o.apto_medico_fecha ?? '',
  unidadBaseId: o.unidad_base_id ?? '',
  activo: o.activo,
})
const mapCliente = (c) => ({
  id: c.id,
  razonSocial: c.razon_social,
  contacto: c.contacto ?? '',
  rfc: c.rfc ?? '',
  telefono: c.telefono ?? '',
  correo: c.correo ?? '',
  diasCredito: c.dias_credito ?? 0,
  activo: c.activo,
})
const mapDireccion = (d) => ({
  id: d.id, calle: d.calle ?? '', ciudad: d.ciudad ?? '', estado: d.estado ?? '', pais: d.pais ?? '', cp: d.cp ?? '',
})
const mapProveedor = (p) => ({
  id: p.id,
  razonSocial: p.razon_social,
  rfc: p.rfc ?? '',
  diasCredito: p.dias_credito ?? 0,
  banco: { nombre: p.banco_nombre ?? '', clabe: p.banco_clabe ?? '', cuenta: p.banco_cuenta ?? '' },
  activo: p.activo,
})
const mapTramo = (t) => ({ id: t.id, origen: t.origen, destino: t.destino, pagoChofer: t.pago_chofer, km: t.km ?? 0 })
const mapContacto = (c) => ({ id: c.id, nombre: c.nombre, relacion: c.relacion ?? '', telefono: c.telefono ?? '' })
const mapGasolinera = (g) => ({ id: g.id, razonSocial: g.razon_social, activo: g.activo })
const mapEstacion = (e) => ({ id: e.id, gasolineraId: e.gasolinera_id, alias: e.alias, ciudad: e.ciudad ?? '', activo: e.activo })

export const useOperadores = () => useTabla('operadores', mapOperador)
export const useClientes = () => useTabla('clientes', mapCliente)
export const useProveedores = () => useTabla('proveedores', mapProveedor)
export const useTabuladores = () => useTabla('tabuladores', mapTramo, (q) => q.select('*').eq('vigente', true))
export const useGasolineras = () => useTabla('gasolineras', mapGasolinera, (q) => q.select('*').eq('activo', true))
// estaciones + razón social de su gasolinera en un solo hook -- es lo que consume el selector de Diésel
export const useEstacionesGasolinera = () => useTabla(
  'gasolinera_estaciones',
  (e) => ({ ...mapEstacion(e), razonSocial: e.gasolineras?.razon_social ?? '' }),
  (q) => q.select('*, gasolineras(razon_social)').eq('activo', true),
)
export const estacionTexto = (e) => [e.razonSocial, e.alias, e.ciudad].filter(Boolean).join(' · ')

// direcciones y contactos se cargan bajo demanda (solo al editar un cliente/operador puntual),
// no con canal realtime -- es un formulario que un solo admin edita a la vez.
export const cargarDirecciones = (clienteId) => supabase.from('cliente_direcciones').select('*').eq('cliente_id', clienteId)
  .then(({ data, error }) => { if (error) throw error; return data.map(mapDireccion) })
const cargarContactos = (operadorId) => supabase.from('operador_contactos_emergencia').select('*').eq('operador_id', operadorId)
  .then(({ data, error }) => { if (error) throw error; return data.map(mapContacto) })
const cargarEstaciones = (gasolineraId) => supabase.from('gasolinera_estaciones').select('*').eq('gasolinera_id', gasolineraId)
  .then(({ data, error }) => { if (error) throw error; return data.map(mapEstacion) })

/* ---------- Operadores (choferes) ---------- */

const contactoVacio = () => ({ nombre: '', relacion: '', telefono: '' })
const operadorVacio = () => ({
  perfilId: '',
  nombre: '', telefono: '', direccion: '', rfc: '', curp: '', email: '',
  licencia: { numero: '', vence: '' },
  visa: { numero: '', vence: '' },
  aptoMedicoFecha: '',
  contactosEmergencia: [contactoVacio()],
  unidadBaseId: '',
  activo: true,
})

function Operadores() {
  const operadores = useOperadores()
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
    ? { ...operadorVacio(), ...operador, contactosEmergencia: [contactoVacio()] }
    : operadorVacio())
  const [guardando, setGuardando] = useState(false)
  const [cargandoContactos, setCargandoContactos] = useState(Boolean(operador))
  const [perfiles, setPerfiles] = useState([])
  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })
  const setAnidado = (campo, sub) => (e) => setF({ ...f, [campo]: { ...f[campo], [sub]: e.target.value } })
  const setContacto = (i, campo) => (e) => setF({
    ...f,
    contactosEmergencia: f.contactosEmergencia.map((c, j) => (j === i ? { ...c, [campo]: e.target.value } : c)),
  })

  useEffect(() => {
    if (!operador) return
    cargarContactos(operador.id).then((contactos) => {
      setF((prev) => ({ ...prev, contactosEmergencia: contactos.length ? contactos : [contactoVacio()] }))
      setCargandoContactos(false)
    }).catch(console.error)
  }, [operador?.id])

  // cuentas de login disponibles para vincular -- sin esto, auth_operador_id() (RLS de
  // viajes/diésel/reportes de falla) nunca resuelve y el chofer no ve nada de lo suyo.
  useEffect(() => {
    supabase.from('perfiles').select('id, email, nombre, rol').eq('activo', true).order('email')
      .then(({ data, error }) => { if (!error) setPerfiles(data) })
  }, [])

  const guardar = async () => {
    if (!f.nombre.trim()) { alert('Escribe el nombre del operador'); return }
    setGuardando(true)
    try {
      const datos = {
        perfil_id: f.perfilId || null,
        nombre: f.nombre.trim(),
        telefono: f.telefono || null, direccion: f.direccion || null, rfc: f.rfc || null, curp: f.curp || null,
        email: f.email.trim().toLowerCase() || null,
        licencia_numero: f.licencia.numero || null, licencia_vence: f.licencia.vence || null,
        visa_numero: f.visa.numero || null, visa_vence: f.visa.vence || null,
        apto_medico_fecha: f.aptoMedicoFecha || null,
        unidad_base_id: f.unidadBaseId || null,
        activo: f.activo,
      }
      const contactos = f.contactosEmergencia.filter((c) => c.nombre.trim())
      let operadorId = operador?.id
      if (operador) {
        const { error } = await supabase.from('operadores').update(datos).eq('id', operador.id)
        if (error) throw error
        await supabase.from('operador_contactos_emergencia').delete().eq('operador_id', operador.id)
      } else {
        const { data, error } = await supabase.from('operadores').insert(datos).select('id').single()
        if (error) throw error
        operadorId = data.id
      }
      if (contactos.length) {
        const { error } = await supabase.from('operador_contactos_emergencia').insert(
          contactos.map((c) => ({ operador_id: operadorId, nombre: c.nombre.trim(), relacion: c.relacion || null, telefono: c.telefono || null })),
        )
        if (error) throw error
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
      <BarraAcciones onAtras={onDone} onGuardar={guardar} guardando={guardando} guardarLabel="Guardar operador" />
      <h2>{operador ? operador.nombre : 'Nuevo operador'}</h2>
      <label className="campo"><span>Nombre completo</span>
        <input value={f.nombre} onChange={set('nombre')} />
      </label>
      <label className="campo"><span>Cuenta de login (para ver sus viajes/diésel)</span>
        <select value={f.perfilId} onChange={set('perfilId')}>
          <option value="">Sin vincular</option>
          {perfiles.map((p) => <option key={p.id} value={p.id}>{p.email} ({p.rol})</option>)}
        </select>
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
      {cargandoContactos && <p className="muted">Cargando…</p>}
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

    </div>
  )
}

/* ---------- Clientes (+ direcciones) ---------- */

const clienteVacio = () => ({ razonSocial: '', contacto: '', rfc: '', telefono: '', correo: '', diasCredito: 0 })

function Clientes() {
  const clientes = useClientes()
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
    if (!cliente) return
    cargarDirecciones(cliente.id).then(setDirecciones).catch(console.error)
  }, [cliente])

  const guardar = async () => {
    if (!f.razonSocial.trim()) { alert('Escribe la razón social'); return }
    setGuardando(true)
    try {
      const datos = {
        razon_social: f.razonSocial.trim(), contacto: f.contacto || null, rfc: f.rfc || null,
        telefono: f.telefono || null, correo: f.correo || null, dias_credito: Number(f.diasCredito) || 0,
      }
      const { error } = cliente
        ? await supabase.from('clientes').update(datos).eq('id', cliente.id)
        : await supabase.from('clientes').insert(datos)
      if (error) throw error
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
      const { id, ...d } = dirForm
      const fila = { cliente_id: cliente.id, calle: d.calle, ciudad: d.ciudad, estado: d.estado || null, pais: d.pais || null, cp: d.cp || null }
      const { error } = id
        ? await supabase.from('cliente_direcciones').update(fila).eq('id', id)
        : await supabase.from('cliente_direcciones').insert(fila)
      if (error) throw error
      setDirForm(null)
      setDirecciones(await cargarDirecciones(cliente.id))
    } catch (e) { alert('Error: ' + e.message) }
  }

  const borrarDireccion = async (id) => {
    if (!confirm('¿Eliminar esta dirección?')) return
    try {
      const { error } = await supabase.from('cliente_direcciones').delete().eq('id', id)
      if (error) throw error
      setDirecciones((prev) => prev.filter((d) => d.id !== id))
    } catch (e) { alert('Error: ' + e.message) }
  }

  return (
    <div>
      <BarraAcciones onAtras={onDone} onGuardar={guardar} guardando={guardando} guardarLabel="Guardar cliente" />
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
    </div>
  )
}

/* ---------- Proveedores ---------- */

const proveedorVacio = () => ({
  razonSocial: '', rfc: '', diasCredito: 0,
  banco: { nombre: '', clabe: '', cuenta: '' },
})

function Proveedores() {
  const proveedores = useProveedores()
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
        razon_social: f.razonSocial.trim(), rfc: f.rfc || null,
        dias_credito: Number(f.diasCredito) || 0,
        banco_nombre: f.banco.nombre || null, banco_clabe: f.banco.clabe || null, banco_cuenta: f.banco.cuenta || null,
      }
      const { error } = proveedor
        ? await supabase.from('proveedores').update(datos).eq('id', proveedor.id)
        : await supabase.from('proveedores').insert(datos)
      if (error) throw error
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
      <BarraAcciones onAtras={onDone} onGuardar={guardar} guardando={guardando} guardarLabel="Guardar proveedor" />
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
    </div>
  )
}

/* ---------- Tabulador (pago a chofer por tramo origen-destino) ---------- */

function Tabulador() {
  const tramos = useTabuladores()
  const [f, setF] = useState(null) // {id?} en edición | null
  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  const guardar = async () => {
    if (!f.origen.trim() || !f.destino.trim()) { alert('Origen y destino son obligatorios'); return }
    if (!(Number(f.pagoChofer) > 0)) { alert('Escribe el pago al chofer'); return }
    try {
      const limpio = { origen: f.origen.trim(), destino: f.destino.trim(), pago_chofer: Number(f.pagoChofer), km: Number(f.km) || null }
      // no se edita en sitio: un viaje ya conciliado con este tramo no debe ver cambiar su
      // costeo histórico -- se retira la tarifa vieja (vigente=false) y se inserta la nueva.
      if (f.id) await supabase.from('tabuladores').update({ vigente: false }).eq('id', f.id)
      const { error } = await supabase.from('tabuladores').insert(limpio)
      if (error) throw error
      setF(null)
    } catch (e) { alert('Error: ' + e.message) }
  }

  const borrar = async (id) => {
    if (!confirm('¿Retirar este tramo del tabulador? Los viajes que ya lo usaron conservan su costeo.')) return
    try {
      const { error } = await supabase.from('tabuladores').update({ vigente: false }).eq('id', id)
      if (error) throw error
    } catch (e) { alert('Error: ' + e.message) }
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

/* ---------- Gasolineras (+ estaciones) ---------- */

const gasolineraVacia = () => ({ razonSocial: '' })
const estacionVacia = () => ({ alias: '', ciudad: '' })

function Gasolineras() {
  const gasolineras = useGasolineras()
  const [editando, setEditando] = useState(null)

  if (editando) {
    return <GasolineraForm gasolinera={editando === 'nuevo' ? null : editando} onDone={() => setEditando(null)} />
  }

  const lista = (gasolineras ?? []).slice().sort((a, b) => a.razonSocial.localeCompare(b.razonSocial))
  return (
    <div>
      <h2>Gasolineras</h2>
      <p className="muted">Empresas con convenio y sus estaciones de servicio. El chofer elige de aquí al cargar diésel.</p>
      {gasolineras === null && <p className="muted">Cargando…</p>}
      {gasolineras !== null && lista.length === 0 && (
        <p className="muted vacio">Sin gasolineras registradas.<br />Toca + para agregar la primera.</p>
      )}
      {lista.map((g) => (
        <button key={g.id} className="tarjeta" onClick={() => setEditando(g)}>
          <strong>{g.razonSocial}</strong>
        </button>
      ))}
      <button className="fab" onClick={() => setEditando('nuevo')} aria-label="Agregar gasolinera">+</button>
    </div>
  )
}

function GasolineraForm({ gasolinera, onDone }) {
  const [f, setF] = useState(gasolinera ?? gasolineraVacia())
  const [guardando, setGuardando] = useState(false)
  const [estaciones, setEstaciones] = useState([])
  const [estForm, setEstForm] = useState(null) // {id?} en edición | null
  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  useEffect(() => {
    if (!gasolinera) return
    cargarEstaciones(gasolinera.id).then(setEstaciones).catch(console.error)
  }, [gasolinera])

  const guardar = async () => {
    if (!f.razonSocial.trim()) { alert('Escribe la razón social'); return }
    setGuardando(true)
    try {
      const datos = { razon_social: f.razonSocial.trim() }
      const { error } = gasolinera
        ? await supabase.from('gasolineras').update(datos).eq('id', gasolinera.id)
        : await supabase.from('gasolineras').insert(datos)
      if (error) throw error
      onDone()
    } catch (e) {
      console.error(e)
      alert('Error al guardar: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const guardarEstacion = async () => {
    if (!estForm.alias.trim()) { alert('Escribe el alias de la estación'); return }
    try {
      const { id, ...e } = estForm
      const fila = { gasolinera_id: gasolinera.id, alias: e.alias.trim(), ciudad: e.ciudad || null }
      const { error } = id
        ? await supabase.from('gasolinera_estaciones').update(fila).eq('id', id)
        : await supabase.from('gasolinera_estaciones').insert(fila)
      if (error) throw error
      setEstForm(null)
      setEstaciones(await cargarEstaciones(gasolinera.id))
    } catch (e) { alert('Error: ' + e.message) }
  }

  const borrarEstacion = async (id) => {
    if (!confirm('¿Eliminar esta estación?')) return
    try {
      const { error } = await supabase.from('gasolinera_estaciones').delete().eq('id', id)
      if (error) throw error
      setEstaciones((prev) => prev.filter((e) => e.id !== id))
    } catch (e) { alert('Error: ' + e.message) }
  }

  return (
    <div>
      <BarraAcciones onAtras={onDone} onGuardar={guardar} guardando={guardando} guardarLabel="Guardar gasolinera" />
      <h2>{gasolinera ? gasolinera.razonSocial : 'Nueva gasolinera'}</h2>
      <label className="campo"><span>Razón social</span>
        <input value={f.razonSocial} onChange={set('razonSocial')} />
      </label>

      {gasolinera && (
        <>
          <h3>Estaciones de servicio</h3>
          {estaciones.map((e) => (
            <div key={e.id} className="tarjeta detalle">
              <div className="tarjeta-top">
                <span>{[e.alias, e.ciudad].filter(Boolean).join(' · ')}</span>
                <span>
                  <button type="button" className="btn-borrar" aria-label="Editar" onClick={() => setEstForm(e)}>✏️</button>
                  <button type="button" className="btn-borrar" aria-label="Eliminar" onClick={() => borrarEstacion(e.id)}>🗑</button>
                </span>
              </div>
            </div>
          ))}
          {estForm ? (
            <div className="linea">
              <div className="fila-2">
                <label className="campo"><span>Alias</span>
                  <input value={estForm.alias} onChange={(e) => setEstForm({ ...estForm, alias: e.target.value })} placeholder="Ej. La de la curva" />
                </label>
                <label className="campo"><span>Ciudad</span>
                  <input value={estForm.ciudad} onChange={(e) => setEstForm({ ...estForm, ciudad: e.target.value })} />
                </label>
              </div>
              <div className="acciones">
                <button className="btn-primario" onClick={guardarEstacion}>Guardar estación</button>
                <button className="btn-secundario" onClick={() => setEstForm(null)}>Cancelar</button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn-secundario btn-bloque" onClick={() => setEstForm(estacionVacia())}>
              + Agregar estación
            </button>
          )}
        </>
      )}
      {!gasolinera && <p className="muted">Guarda la gasolinera para poder agregar estaciones.</p>}
    </div>
  )
}
