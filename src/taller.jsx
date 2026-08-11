import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import { mapWO, SELECT_WO, useTabla } from './compras'
import { hoy } from './utils/format'

export const FALLAS = [
  ['motor', 'Motor'],
  ['transmision', 'Transmisión'],
  ['electrica', 'Eléctrica'],
  ['suspension', 'Suspensión'],
  ['llantas', 'Llantas'],
  ['carroceria', 'Carrocería'],
]
export const FALLA_LABEL = Object.fromEntries(FALLAS)
export const TIPOS = { truck: 'Trucks', reefer: 'Reefers', plataforma: 'Plataformas', caja_seca: 'Cajas Secas' }
export const LECTURA_LABEL = { mi: 'Millaje (mi)', km: 'Kilometraje (km)', hrs: 'Horómetro (hrs)' }

// piezasRequeridas era string en docs viejos; normaliza siempre a array
export const piezasLista = (p) => (Array.isArray(p) ? p : p ? [p] : [])

export default function Taller({ usuario, vista, setVista }) {
  const [editando, setEditando] = useState(null)

  // RLS de work_orders ya deja a taller ver/editar cualquier WO (taller de varios mecánicos
  // compartiendo trabajo), no solo las propias -- admin ve lo mismo.
  const wos = useTabla('work_orders', mapWO, (q) => q.select(SELECT_WO).eq('estatus', 'en_proceso'))

  useEffect(() => { setEditando(null) }, [vista])

  const volver = () => { setEditando(null); setVista('mis-wo') }

  if (vista === 'nueva-wo') return <WOForm key="nueva" usuario={usuario} wo={null} onDone={volver} />
  if (editando) return <WOForm key={editando.id} usuario={usuario} wo={editando} onDone={volver} />

  const lista = (wos ?? []).slice().sort((a, b) => b.wo.localeCompare(a.wo))
  return (
    <div>
      <h2>{usuario.rol === 'admin' ? 'WO en proceso' : 'Mis WO en proceso'}</h2>
      {wos === null && <p className="muted">Cargando…</p>}
      {wos !== null && lista.length === 0 && (
        <p className="muted vacio">No hay reparaciones en proceso.<br />Toca + para crear una nueva WO.</p>
      )}
      {lista.map((w) => (
        <button key={w.id} className="tarjeta" onClick={() => setEditando(w)}>
          <div className="tarjeta-top">
            <strong>{w.wo}</strong>
            <span className="muted">{w.fecha}</span>
          </div>
          <div>Unidad <strong>{w.unidadNumero}</strong>{w.chofer && <span className="muted"> · Chofer: {w.chofer}</span>}</div>
          {w.tipoFalla.length > 0 && (
            <div className="chips">
              {w.tipoFalla.map((f) => <span key={f} className="chip">{FALLA_LABEL[f]}</span>)}
            </div>
          )}
        </button>
      ))}
      <button className="fab" onClick={() => setVista('nueva-wo')} aria-label="Nueva WO">+</button>
    </div>
  )
}

function WOForm({ usuario, wo, onDone }) {
  const [unidades, setUnidades] = useState([])
  const [f, setF] = useState(() => wo
    ? { ...wo, piezasRequeridas: piezasLista(wo.piezasRequeridas).length ? piezasLista(wo.piezasRequeridas) : [''] }
    : {
      fecha: hoy(),
      unidadId: '', unidadNumero: '',
      lectura: { valor: '', unidad: '' },
      chofer: '',
      mecanico: usuario.nombre,
      tipoFalla: [],
      diagnostico: '', piezasRequeridas: [''], notasMecanico: '',
    })
  const [guardando, setGuardando] = useState(false)
  const original = useMemo(() => JSON.stringify(f), [])
  const sucio = JSON.stringify(f) !== original

  useEffect(() => {
    supabase.from('unidades').select('id, numero, tipo, unidad_lectura').then(({ data, error }) => {
      if (error) { console.error(error); return }
      setUnidades(
        data
          .map((u) => ({ id: u.id, numero: u.numero, tipo: u.tipo, unidadLectura: u.unidad_lectura }))
          .sort((a, b) => a.numero.localeCompare(b.numero, undefined, { numeric: true })),
      )
    })
  }, [])

  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  const elegirUnidad = (e) => {
    const u = unidades.find((x) => x.id === e.target.value)
    setF({
      ...f,
      unidadId: u?.id ?? '',
      unidadNumero: u?.numero ?? '',
      lectura: { valor: f.lectura.valor, unidad: u?.unidadLectura ?? '' },
    })
  }

  const toggleFalla = (id) => setF({
    ...f,
    tipoFalla: f.tipoFalla.includes(id) ? f.tipoFalla.filter((x) => x !== id) : [...f.tipoFalla, id],
  })

  const guardar = async (completar) => {
    if (!f.unidadId) { alert('Selecciona una unidad'); return }
    if (completar && !confirm('¿Confirmar que la reparación está completa? Esta acción no se puede deshacer.')) return
    setGuardando(true)
    try {
      const datos = {
        fecha: f.fecha,
        unidad_id: f.unidadId,
        lectura_valor: Number(f.lectura.valor) || null,
        lectura_unidad: f.lectura.unidad || null,
        chofer_texto: f.chofer || null,
        mecanico_texto: f.mecanico || null,
        tipo_falla: f.tipoFalla,
        diagnostico: f.diagnostico || null,
        piezas_requeridas: f.piezasRequeridas.map((p) => p.trim()).filter(Boolean),
        notas_mecanico: f.notasMecanico || null,
        estatus: completar ? 'completado' : 'en_proceso',
        ...(completar ? { completado_at: new Date().toISOString() } : {}),
      }
      // el folio WO-XXXX lo asigna la secuencia de Postgres al insertar, no hace falta contador propio
      const { error } = wo
        ? await supabase.from('work_orders').update(datos).eq('id', wo.id)
        : await supabase.from('work_orders').insert({ ...datos, creado_por: usuario.id })
      if (error) throw error
      onDone()
    } catch (e) {
      console.error(e)
      alert('Error al guardar: ' + e.message)
    } finally {
      setGuardando(false)
    }
  }

  const cancelar = () => {
    if (!sucio || confirm('Hay cambios sin guardar. ¿Salir sin guardar?')) onDone()
  }

  return (
    <div>
      <h2>{wo ? `Editar ${wo.wo}` : 'Nueva WO'}</h2>
      <label className="campo">
        <span>WO</span>
        <input value={wo ? wo.wo : 'Se asignará al guardar'} disabled />
      </label>
      <label className="campo">
        <span>Fecha</span>
        <input type="date" value={f.fecha} onChange={set('fecha')} />
      </label>
      <label className="campo">
        <span>Unidad</span>
        <select value={f.unidadId} onChange={elegirUnidad}>
          <option value="">Selecciona unidad…</option>
          {Object.entries(TIPOS).map(([tipo, label]) => {
            const grupo = unidades.filter((u) => u.tipo === tipo)
            return grupo.length > 0 && (
              <optgroup key={tipo} label={label}>
                {grupo.map((u) => <option key={u.id} value={u.id}>{u.numero}</option>)}
              </optgroup>
            )
          })}
        </select>
      </label>
      {f.lectura.unidad && (
        <label className="campo">
          <span>{LECTURA_LABEL[f.lectura.unidad]}</span>
          <input
            type="number" inputMode="numeric" min="0"
            value={f.lectura.valor}
            onChange={(e) => setF({ ...f, lectura: { ...f.lectura, valor: e.target.value } })}
          />
        </label>
      )}
      <label className="campo">
        <span>Chofer</span>
        <input value={f.chofer} onChange={set('chofer')} />
      </label>
      <label className="campo">
        <span>Mecánico</span>
        <input value={f.mecanico} onChange={set('mecanico')} />
      </label>
      <div className="campo">
        <span>Tipo de falla</span>
        <div className="chips">
          {FALLAS.map(([id, label]) => (
            <button
              type="button" key={id}
              className={f.tipoFalla.includes(id) ? 'chip chip-toggle activo' : 'chip chip-toggle'}
              onClick={() => toggleFalla(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="campo">
        <span>Diagnóstico</span>
        <textarea value={f.diagnostico} onChange={set('diagnostico')} />
      </label>
      <div className="campo">
        <span>Piezas que se requieren</span>
        {f.piezasRequeridas.map((p, i) => (
          <div key={i} className="pieza">
            <span className="pieza-num">{i + 1}.</span>
            <input
              value={p}
              placeholder="Ej. Alternador Cummins Freightliner 2024"
              onChange={(e) => setF({
                ...f,
                piezasRequeridas: f.piezasRequeridas.map((x, j) => (j === i ? e.target.value : x)),
              })}
            />
            <button
              type="button" className="btn-borrar" aria-label="Eliminar pieza"
              disabled={f.piezasRequeridas.length === 1}
              onClick={() => setF({ ...f, piezasRequeridas: f.piezasRequeridas.filter((_, j) => j !== i) })}
            >🗑</button>
          </div>
        ))}
        <button
          type="button" className="btn-secundario btn-bloque"
          onClick={() => setF({ ...f, piezasRequeridas: [...f.piezasRequeridas, ''] })}
        >+ Agregar pieza</button>
      </div>
      <label className="campo">
        <span>Notas del mecánico</span>
        <textarea value={f.notasMecanico} onChange={set('notasMecanico')} />
      </label>
      <label className="campo">
        <span>Estatus</span>
        <input value="En proceso" disabled />
      </label>
      <div className="acciones">
        <button className="btn-primario" disabled={guardando} onClick={() => guardar(false)}>
          {guardando ? 'Guardando…' : 'Guardar'}
        </button>
        <button className="btn-completar" disabled={guardando} onClick={() => guardar(true)}>
          Completar reparación
        </button>
        <button className="btn-secundario" disabled={guardando} onClick={cancelar}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
