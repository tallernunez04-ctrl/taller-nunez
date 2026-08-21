import { useEffect, useMemo, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import { mapWO, SELECT_WO, useTabla, aKm, CampoOdometro } from './compras'
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
export const ACCIONES_LLANTA = [['reemplazo', 'Reemplazo'], ['rotacion', 'Rotación'], ['reparacion', 'Reparación']]
export const TIPOS_SERVICIO = [['correctivo', 'Correctivo'], ['preventivo', 'Preventivo']]

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

// programado: { unidadId, unidadNumero, unidadLectura } cuando la WO se abre desde el panel de
// Mantenimiento Preventivo (dispatch o taller) -- fija tipoServicio y origenMantenimientoProgramado,
// que es lo único que dispara mantenimiento_preventivo/ultimo_mantenimiento_valor al completar
// (ver guardar_work_order).
export function WOForm({ usuario, wo, onDone, programado }) {
  const [unidades, setUnidades] = useState([])
  const [f, setF] = useState(() => wo
    ? { ...wo, piezasRequeridas: piezasLista(wo.piezasRequeridas).length ? piezasLista(wo.piezasRequeridas) : [''] }
    : {
      fecha: hoy(),
      unidadId: programado?.unidadId ?? '', unidadNumero: programado?.unidadNumero ?? '',
      lectura: { valor: '', unidad: programado?.unidadLectura ?? '' },
      chofer: '',
      mecanico: usuario.nombre,
      tipoFalla: [],
      tipoServicio: programado ? 'preventivo' : 'correctivo',
      origenMantenimientoProgramado: !!programado,
      diagnostico: '', piezasRequeridas: [''], notasMecanico: '',
      llantaAccion: '', llantaPosiciones: [''], llantaNotas: '',
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
    const llantasActivas = f.tipoFalla.includes('llantas')
    const posicionesLimpias = f.llantaPosiciones.map((p) => p.trim()).filter(Boolean)
    let kmEvento = null
    if (llantasActivas) {
      if (!f.llantaAccion) { alert('Elige la acción de llantas: Reemplazo, Rotación o Reparación'); return }
      // rotación es un evento de unidad completa (mueve varias llantas) -- reemplazo/reparación
      // necesitan la posición específica para el KPI Km/llanta
      if (f.llantaAccion !== 'rotacion' && posicionesLimpias.length === 0) {
        alert('Escribe al menos una posición (ej. "Del Izq") para el reemplazo/reparación'); return
      }
      // reefers (lectura en horas) no tienen km atribuible -- el evento se guarda sin km_evento,
      // la fecha de captura (wo_llantas.created_at) es el dato válido para su análisis de llantas
      if (f.lectura.unidad !== 'hrs') {
        kmEvento = aKm(f.lectura.valor, f.lectura.unidad)
        if (kmEvento == null) {
          alert('Para el análisis de llantas hace falta el millaje/kilometraje de la WO'); return
        }
      }
    }
    if (completar && f.tipoServicio === 'preventivo' && !f.lectura.unidad) {
      alert('Para completar un servicio preventivo hace falta el millaje/kilometraje/horómetro de la WO'); return
    }
    if (completar && !confirm('¿Confirmar que la reparación está completa? Esta acción no se puede deshacer.')) return
    setGuardando(true)
    try {
      // el folio WO-XXXX lo asigna la secuencia de Postgres al insertar, no hace falta contador propio.
      // guardar_work_order es atómico: WO + llantas + sincroniza unidades.ultima_lectura (nunca
      // retrocede, Km u horas de termo según la unidad) + si se completa como preventivo, registra
      // mantenimiento_preventivo y actualiza unidades.ultimo_mantenimiento_valor -- ver migración
      // mantenimiento_preventivo_fase1* / reefer_horas_termo_ciclo_agnostico.
      const { error } = await supabase.rpc('guardar_work_order', {
        p_wo_id: wo?.id ?? null,
        p_fecha: f.fecha,
        p_unidad_id: f.unidadId,
        p_lectura_valor: Number(f.lectura.valor) || null,
        // el valor ya viene homologado a Km (CampoOdometro) salvo horómetro, que no es distancia
        p_lectura_unidad: f.lectura.unidad === 'hrs' ? 'hrs' : (f.lectura.unidad ? 'km' : null),
        p_chofer_texto: f.chofer || null,
        p_mecanico_texto: f.mecanico || null,
        p_tipo_falla: f.tipoFalla,
        p_diagnostico: f.diagnostico || null,
        p_piezas_requeridas: f.piezasRequeridas.map((p) => p.trim()).filter(Boolean),
        p_notas_mecanico: f.notasMecanico || null,
        p_tipo_servicio: f.tipoServicio,
        p_completar: completar,
        p_creado_por: usuario.id,
        p_llantas_activas: llantasActivas,
        p_llanta_accion: llantasActivas ? f.llantaAccion : null,
        p_llanta_posiciones: llantasActivas ? posicionesLimpias : null,
        p_llanta_km_evento: llantasActivas ? kmEvento : null,
        p_llanta_notas: llantasActivas ? (f.llantaNotas || null) : null,
        p_origen_mantenimiento_programado: f.origenMantenimientoProgramado,
      })
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
      {f.lectura.unidad === 'hrs' && (
        <label className="campo">
          <span>{LECTURA_LABEL.hrs}</span>
          <input
            type="number" inputMode="numeric" min="0"
            value={f.lectura.valor}
            onChange={(e) => setF({ ...f, lectura: { ...f.lectura, valor: e.target.value } })}
          />
        </label>
      )}
      {(f.lectura.unidad === 'mi' || f.lectura.unidad === 'km') && (
        <CampoOdometro
          key={f.unidadId}
          label="Millaje / Kilometraje"
          unidadPorDefecto={f.lectura.unidad}
          valorInicialKm={wo ? aKm(f.lectura.valor, f.lectura.unidad) : null}
          // solo cambia el valor, nunca f.lectura.unidad: si tocara "unidad" aquí, el próximo
          // render se lo pasaría de vuelta a CampoOdometro como unidadPorDefecto="km" y su
          // propio efecto de default (todavía sin "tocado" porque el usuario no usó el <select>
          // de Unidad) lo pisaría de una tecleada a la otra -- el selector "se autocambiaba"
          // a Kilómetros a media escritura y arruinaba la conversión
          onChangeKm={(km) => setF({ ...f, lectura: { ...f.lectura, valor: km ?? '' } })}
        />
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
        <span>Tipo de servicio</span>
        {f.origenMantenimientoProgramado ? (
          <input value="Preventivo (servicio programado)" disabled />
        ) : (
        <div className="chips">
          {TIPOS_SERVICIO.map(([id, label]) => (
            <button
              type="button" key={id}
              className={f.tipoServicio === id ? 'chip chip-toggle activo' : 'chip chip-toggle'}
              onClick={() => setF({ ...f, tipoServicio: id })}
            >
              {label}
            </button>
          ))}
        </div>
        )}
      </div>
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
      {f.tipoFalla.includes('llantas') && (
        <div className="tarjeta detalle">
          <strong>Llantas</strong>
          <div className="campo">
            <span>Acción</span>
            <div className="chips">
              {ACCIONES_LLANTA.map(([id, label]) => (
                <button
                  type="button" key={id}
                  className={f.llantaAccion === id ? 'chip chip-toggle activo' : 'chip chip-toggle'}
                  onClick={() => setF({ ...f, llantaAccion: id })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="campo">
            <span>Posiciones{f.llantaAccion === 'rotacion' ? ' (opcional)' : ''}</span>
            {f.llantaPosiciones.map((p, i) => (
              <div key={i} className="pieza">
                <span className="pieza-num">{i + 1}.</span>
                <input
                  value={p}
                  placeholder="Ej. Del Izq, Tras Der Ext…"
                  onChange={(e) => setF({
                    ...f,
                    llantaPosiciones: f.llantaPosiciones.map((x, j) => (j === i ? e.target.value : x)),
                  })}
                />
                <button
                  type="button" className="btn-borrar" aria-label="Eliminar posición"
                  disabled={f.llantaPosiciones.length === 1}
                  onClick={() => setF({ ...f, llantaPosiciones: f.llantaPosiciones.filter((_, j) => j !== i) })}
                >🗑</button>
              </div>
            ))}
            <button
              type="button" className="btn-secundario btn-bloque"
              onClick={() => setF({ ...f, llantaPosiciones: [...f.llantaPosiciones, ''] })}
            >+ Agregar posición</button>
          </div>
          <label className="campo"><span>Notas de llantas (opcional)</span>
            <textarea value={f.llantaNotas} onChange={set('llantaNotas')} />
          </label>
          {!f.lectura.unidad && (
            <p className="error">Selecciona la unidad para poder capturar el millaje/kilometraje/horómetro de este evento.</p>
          )}
        </div>
      )}
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
        {usuario.rol !== 'dispatch' && (
          <button className="btn-completar" disabled={guardando} onClick={() => guardar(true)}>
            Completar reparación
          </button>
        )}
        <button className="btn-secundario" disabled={guardando} onClick={cancelar}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
