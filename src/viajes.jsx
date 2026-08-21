import { useEffect, useState } from 'react'
import { subirArchivo, supabase } from './lib/supabaseClient'
import { mediana } from './costeo'
import { usePrecioDiesel, useTipoCambio, useUnidades, SelectorUnidad, CampoOdometro } from './compras'
import { dinero, r2, hoy } from './utils/format'
import { cargarDirecciones, direccionTexto, useClientes, useOperadores, useTabuladores } from './catalogos'

/* Módulo Viajes: operación + costeo + viáticos + cuentas por cobrar. Migrado a Supabase.
   - viaje_entregas: consolidación (varios clientes/destinos por viaje)
   - viaje_movimientos: cadena de custodia (chofer/camión pueden cambiar a medio viaje)
   entregasPendientes/kmTotales/clienteNombre ya no son contadores denormalizados: se derivan
   de las vistas v_viaje_entregas_resumen / v_viaje_kilometraje / v_viaje_clientes. La atomicidad
   que daba runTransaction() en Firestore (nunca existe un viaje sin movimiento, cerrar+abrir
   movimiento es todo o nada) vive ahora en 3 funciones de Postgres: crear_viaje,
   registrar_cambio_custodia, terminar_viaje (ver migración rpc_viajes_transacciones). */

export const ESTATUS_VIAJE = { en_proceso: 'En proceso', terminado: 'Terminado', conciliado: 'Conciliado' }

// ponytail: "en_transito" no es un valor nuevo del enum estatus_viaje -- se deriva de
// iniciado_en para no tener que tocar RLS ni los filtros que ya comparan estatus === 'en_proceso'
// (terminar_viaje, la lista de viajes en curso de diesel.jsx, etc.). Si el negocio necesita
// filtrar/reportar por "en tránsito" como estatus real de la base, ahí sí conviene el enum.
export const estatusLabel = (v) => (v.estatus === 'en_proceso' && v.iniciadoEn ? 'En tránsito' : ESTATUS_VIAJE[v.estatus])

// kmInicioKm ya viene homologado a km (ver CampoOdometro) sin importar si el chofer lo leyó en millas
export async function iniciarViaje(viajeId, kmInicioKm) {
  const { error: e1 } = await supabase.from('viajes').update({ iniciado_en: new Date().toISOString() }).eq('id', viajeId)
  if (e1) throw e1
  if (kmInicioKm != null) {
    const { data: movs, error: e2 } = await supabase.from('viaje_movimientos')
      .select('id, camion_id').eq('viaje_id', viajeId).eq('activo', true).limit(1)
    if (e2) throw e2
    if (movs?.[0]) {
      const { error: e3 } = await supabase.from('viaje_movimientos')
        .update({ odometro_inicio: kmInicioKm }).eq('id', movs[0].id)
      if (e3) throw e3
      // sincroniza unidades.ultima_lectura (consolidada para el badge de mantenimiento) --
      // este es el punto real donde se captura el Km inicial, crear_viaje siempre lo manda null
      const { data: unidad } = await supabase.from('unidades').select('ultima_lectura').eq('id', movs[0].camion_id).single()
      if ((unidad?.ultima_lectura ?? 0) < kmInicioKm) {
        const { error: e4 } = await supabase.from('unidades').update({ ultima_lectura: kmInicioKm }).eq('id', movs[0].camion_id)
        if (e4) throw e4
      }
    }
  }
}

const sumaDias = (fecha, dias) => {
  const d = new Date(fecha + 'T00:00')
  d.setDate(d.getDate() + dias)
  return d.toLocaleDateString('sv')
}

const fmtTs = (t) => (t ? new Date(t).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : '—')

/* ---------- Mapeo Supabase -> forma camelCase que ya usaba la UI ---------- */

// dos FKs de viajes a unidades (camión y caja) y a viaje_movimientos -- hay que alias-earlos
export const SELECT_VIAJE = `*,
  operadores!viajes_chofer_actual_id_fkey(nombre, email),
  camion:unidades!viajes_camion_actual_id_fkey(numero),
  caja:unidades!viajes_caja_actual_id_fkey(numero)`
const SELECT_ENTREGA = '*, clientes(razon_social)'
const SELECT_MOVIMIENTO = `*,
  operadores(nombre),
  camion:unidades!viaje_movimientos_camion_id_fkey(numero)`

// vistas que reemplazan los contadores que antes vivían en el doc del viaje (increment())
async function cargarResumenes() {
  const [ent, km, cli] = await Promise.all([
    supabase.from('v_viaje_entregas_resumen').select('*'),
    supabase.from('v_viaje_kilometraje').select('*'),
    supabase.from('v_viaje_clientes').select('*'),
  ])
  return {
    entregas: Object.fromEntries((ent.data ?? []).map((x) => [x.viaje_id, x])),
    km: Object.fromEntries((km.data ?? []).map((x) => [x.viaje_id, x])),
    clientes: Object.fromEntries((cli.data ?? []).map((x) => [x.viaje_id, x])),
  }
}

export const mapViaje = (v, resumenes = { entregas: {}, km: {}, clientes: {} }) => {
  const ent = resumenes.entregas[v.id]
  const cli = resumenes.clientes[v.id]
  return {
    id: v.id,
    folio: v.folio,
    fecha: v.fecha,
    tramoId: v.tramo_id,
    origen: v.origen,
    destino: v.destino,
    km: Number(v.km) || 0,
    kmFuente: v.km_fuente,
    precio: Number(v.precio) || 0,
    costeoEstimado: {
      dieselUSD: Number(v.costeo_diesel_usd) || 0,
      pagoChofer: Number(v.costeo_pago_chofer) || 0,
      total: Number(v.costeo_total) || 0,
    },
    viaticosEntregados: Number(v.viaticos_entregados) || 0,
    viaticosComprobados: Number(v.viaticos_comprobados) || 0,
    notas: v.notas ?? '',
    estatus: v.estatus,
    iniciadoEn: v.iniciado_en,
    operadorProvisional: v.operador_provisional,
    terminadoAt: v.terminado_at,
    nominaId: v.nomina_id,
    createdAt: v.created_at,
    cobranza: {
      fechaFactura: v.cobranza_fecha_factura,
      fechaVence: v.cobranza_fecha_vence,
      facturaURL: v.cobranza_factura_path ?? '',
      xmlURL: v.cobranza_xml_path ?? '',
      pagado: v.cobranza_pagado,
      comprobanteURL: v.cobranza_comprobante_path ?? '',
      pagadoAt: v.cobranza_pagado_at,
    },
    // custodia actual + alias "legacy" (mismo valor -- ya no hay chofer distinto al legacy)
    choferActualId: v.chofer_actual_id, operadorId: v.chofer_actual_id,
    choferActualNombre: v.operadores?.nombre ?? '', operadorNombre: v.operadores?.nombre ?? '',
    choferActualEmail: v.operadores?.email ?? '', operadorEmail: v.operadores?.email ?? '',
    camionActualId: v.camion_actual_id, unidadId: v.camion_actual_id,
    camionActualNumero: v.camion?.numero ?? '', unidadNumero: v.camion?.numero ?? '',
    cajaPlataformaId: v.caja_actual_id, cajaId: v.caja_actual_id,
    cajaNumero: v.caja?.numero ?? '',
    // derivados de vistas (antes contadores denormalizados)
    entregasPendientes: ent?.entregas_pendientes ?? 0,
    kmTotales: Number(resumenes.km[v.id]?.km_totales) || 0,
    clientesIds: cli?.cliente_ids ?? [],
    clienteNombre: cli?.clientes_texto ?? '',
  }
}

const mapEntrega = (e) => ({
  id: e.id,
  clienteId: e.cliente_id,
  clienteNombre: e.clientes?.razon_social ?? '',
  direccionEntregaId: e.direccion_id,
  direccion: e.direccion_snapshot ?? '',
  mercancia: e.mercancia ?? '',
  ordenSecuencia: e.orden_secuencia,
  estatus: e.estatus,
  fechaHoraEntregaReal: e.fecha_hora_entrega_real,
  evidenciaUrl: e.evidencia_path ?? '',
})

const mapMovimiento = (m) => ({
  id: m.id,
  choferId: m.chofer_id,
  choferNombre: m.operadores?.nombre ?? '',
  camionId: m.camion_id,
  camionNumero: m.camion?.numero ?? '',
  cajaPlataformaId: m.caja_id,
  fechaHoraInicio: m.fecha_hora_inicio,
  fechaHoraFin: m.fecha_hora_fin,
  odometroInicio: m.odometro_inicio != null ? Number(m.odometro_inicio) : null,
  odometroFin: m.odometro_fin != null ? Number(m.odometro_fin) : null,
  kmRecorridos: m.km_recorridos != null ? Number(m.km_recorridos) : null,
  motivoCambio: m.motivo_cambio,
  movimientoAnteriorId: m.movimiento_anterior_id,
  activo: m.activo,
})

// realtime de viajes -- RLS ya scoping por rol (dispatch/admin ven todo, chofer solo lo suyo).
// escucha viaje_entregas y viaje_movimientos también: entregasPendientes/kmTotales vienen de
// vistas sobre esas tablas, no de un campo en viajes, así que un cambio ahí no dispara el
// canal de 'viajes' por sí solo.
export function useViajes() {
  const [viajes, setViajes] = useState(null)
  useEffect(() => {
    const cargar = async () => {
      const [{ data, error }, resumenes] = await Promise.all([
        supabase.from('viajes').select(SELECT_VIAJE),
        cargarResumenes(),
      ])
      if (error) { console.error(error); return }
      setViajes(data.map((v) => mapViaje(v, resumenes)))
    }
    cargar()
    const canal = supabase
      .channel(`viajes-cambios-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'viajes' }, cargar)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'viaje_entregas' }, cargar)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'viaje_movimientos' }, cargar)
      .subscribe()
    return () => supabase.removeChannel(canal)
  }, [])
  return viajes
}

// entregada: ya no hay contador que decrementar en el padre (viene de la vista)
export async function marcarEntregada(entregaId, evidenciaPath) {
  const { error } = await supabase.from('viaje_entregas').update({
    estatus: 'entregada', fecha_hora_entrega_real: new Date().toISOString(), evidencia_path: evidenciaPath || null,
  }).eq('id', entregaId)
  if (error) throw error
}

export default function Viajes({ usuario, vista }) {
  if (vista === 'mis-viajes') return <MisViajes />
  if (vista === 'cobranza') return <Cobranza />
  if (vista === 'kmh-chofer') return <KmPorChofer />
  return <ListaViajes usuario={usuario} />
}

/* ---------- Lista + formulario (dispatch/admin) ---------- */

function ListaViajes({ usuario }) {
  const viajes = useViajes()
  const [editando, setEditando] = useState(null) // viaje | 'nuevo' | null
  const [fEstatus, setFEstatus] = useState('en_proceso')

  if (editando) {
    return <ViajeForm viaje={editando === 'nuevo' ? null : editando} usuario={usuario} onDone={() => setEditando(null)} />
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
              {estatusLabel(v)}
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
  unidadId: '', cajaId: '', operadorId: '',
  tramoId: '', precio: '',
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

function ViajeForm({ viaje, usuario, onDone }) {
  const unidades = useUnidades()
  const tc = useTipoCambio()
  const clientes = useClientes() ?? []
  const operadores = useOperadores() ?? []
  const tramos = useTabuladores() ?? []
  const precioDieselLitro = usePrecioDiesel()
  const [rendMap, setRendMap] = useState({})
  const [f, setF] = useState(() => (viaje ? { ...viajeVacio(), ...viaje } : viajeVacio()))
  const [entregas, setEntregas] = useState([entregaVacia()]) // solo alta; en edición viven aparte
  const [dirs, setDirs] = useState({}) // cache de direcciones por cliente
  const [movs, setMovs] = useState(viaje ? null : [])
  const [modalCambio, setModalCambio] = useState(false)
  const [terminando, setTerminando] = useState(false)
  const [odometroFin, setOdometroFin] = useState('')
  const [guardando, setGuardando] = useState(false)

  // mediana de rendimiento y de precio/litro por unidad -- ya no vive en el doc de la unidad (ver diesel.jsx)
  useEffect(() => {
    supabase.from('v_rendimiento_unidades').select('unidad_id, rendimiento_mediana, precio_litro_mediana').then(({ data, error }) => {
      if (!error) setRendMap(Object.fromEntries(data.map((r) => [r.unidad_id, {
        rendimiento: Number(r.rendimiento_mediana),
        precioLitro: r.precio_litro_mediana != null ? Number(r.precio_litro_mediana) : null,
      }])))
    })
  }, [])

  // historial de movimientos (cadena de custodia) del viaje existente
  useEffect(() => {
    if (!viaje) return
    const cargar = () => supabase.from('viaje_movimientos').select(SELECT_MOVIMIENTO).eq('viaje_id', viaje.id)
      .then(({ data, error }) => {
        if (error) { console.error(error); return }
        setMovs(data.map(mapMovimiento).sort((a, b) => new Date(a.fechaHoraInicio) - new Date(b.fechaHoraInicio)))
      })
    cargar()
    const canal = supabase
      .channel(`viaje-movimientos-${viaje.id}-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'viaje_movimientos', filter: `viaje_id=eq.${viaje.id}` }, cargar)
      .subscribe()
    return () => supabase.removeChannel(canal)
  }, [viaje?.id])

  const cargarDirs = (cid) => {
    if (!cid || dirs[cid]) return
    cargarDirecciones(cid)
      .then((direcciones) => setDirs((prev) => ({ ...prev, [cid]: direcciones })))
      .catch(console.error)
  }

  const set = (campo) => (e) => setF({ ...f, [campo]: e.target.value })

  const movActivo = (movs ?? []).find((m) => m.activo) ?? null
  const camionActualId = viaje ? viaje.camionActualId : f.unidadId
  const unidad = unidades.find((u) => u.id === camionActualId)
  const tramo = tramos.find((t) => t.id === f.tramoId)
  const operadorBase = operadores.find((o) => o.unidadBaseId === f.unidadId)
  const operador = operadores.find((o) => o.id === f.operadorId)

  const elegirUnidad = (id) => {
    // al elegir unidad se propone su chofer de base; el admin puede cambiarlo (provisional)
    const base = operadores.find((o) => o.unidadBaseId === id)
    setF({ ...f, unidadId: id, operadorId: base?.id ?? f.operadorId })
  }

  const elegirTramo = (e) => setF({ ...f, tramoId: e.target.value })

  // costeo estimado: diésel (km / mediana de rendimientos × $/L, a USD) + pago chofer del tabulador.
  // el km ya no se captura a mano aquí -- lo anota el chofer (Km inicial/final) en Mis viajes,
  // así que antes de que el viaje arranque el estimado de diésel simplemente es $0.
  const km = viaje?.kmTotales ?? 0
  const rendUnidad = rendMap[camionActualId]
  const rendimiento = rendUnidad?.rendimiento ?? 0
  // precio real pagado por esta unidad (mediana de sus últimas cargas) si ya existe -- si no,
  // cae al valor fijo de config (Dashboard) como estimado genérico
  const precioLitro = rendUnidad?.precioLitro || precioDieselLitro || 0
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
    setGuardando(true)
    try {
      if (viaje) {
        // chofer/camión/caja NO se tocan aquí: solo la transacción de cambio de movimiento
        const { error } = await supabase.from('viajes').update({
          fecha: f.fecha,
          tramo_id: f.tramoId || null,
          origen: tramo?.origen ?? viaje.origen ?? '',
          destino: tramo?.destino ?? viaje.destino ?? '',
          precio: Number(f.precio) || 0,
          costeo_diesel_usd: costoDieselUSD, costeo_pago_chofer: pagoChofer, costeo_total: costeoTotal,
          tipo_cambio_usado: tc,
          viaticos_entregados: Number(f.viaticosEntregados) || 0,
          viaticos_comprobados: Number(f.viaticosComprobados) || 0,
          notas: f.notas || null,
        }).eq('id', viaje.id)
        if (error) throw error
      } else {
        const entregasJson = entregasValidas.map((e) => {
          const dir = (dirs[e.clienteId] ?? []).find((d) => d.id === e.direccionEntregaId)
          return {
            cliente_id: e.clienteId,
            direccion_id: e.direccionEntregaId,
            direccion_snapshot: dir ? direccionTexto(dir) : '',
            mercancia: e.mercancia,
          }
        })
        const { error } = await supabase.rpc('crear_viaje', {
          p_fecha: f.fecha, p_tramo_id: f.tramoId || null,
          p_origen: tramo?.origen ?? '', p_destino: tramo?.destino ?? '',
          p_km: km, p_precio: Number(f.precio) || 0,
          p_costeo_diesel_usd: costoDieselUSD, p_costeo_pago_chofer: pagoChofer, p_costeo_total: costeoTotal,
          p_tipo_cambio_usado: tc,
          p_viaticos_entregados: Number(f.viaticosEntregados) || 0, p_notas: f.notas || null,
          p_chofer_id: operador.id, p_camion_id: f.unidadId, p_caja_id: f.cajaId || null,
          p_odometro_inicio: null, // lo anota el chofer al dar "Inicio de viaje" en Mis viajes
          p_operador_provisional: Boolean(operadorBase && f.operadorId !== operadorBase.id),
          p_entregas: entregasJson,
        })
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

  const confirmarTerminar = async () => {
    if (!confirm('¿Confirmar que el viaje terminó? Se registrarán los viáticos comprobados.')) return
    setGuardando(true)
    try {
      const { error } = await supabase.rpc('terminar_viaje', {
        p_viaje_id: viaje.id,
        p_odometro_fin: Number(odometroFin) || null,
        p_viaticos_comprobados: Number(f.viaticosComprobados) || 0,
      })
      if (error) throw error
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
            Chofer: <strong>{viaje.choferActualNombre}</strong>
            {' · '}Camión: <strong>{viaje.camionActualNumero}</strong>
            {viaje.cajaNumero && <> · Caja: <strong>{viaje.cajaNumero}</strong></>}
          </p>
          {viaje.kmTotales > 0 && <p className="muted">Km recorridos (movimientos): {viaje.kmTotales.toLocaleString()}</p>}
        </div>
      )}

      <label className="campo"><span>Tramo (tabulador)</span>
        <select value={f.tramoId} onChange={elegirTramo}>
          <option value="">Selecciona tramo…</option>
          {tramos.slice().sort((a, b) => (a.origen + a.destino).localeCompare(b.origen + b.destino)).map((t) => (
            <option key={t.id} value={t.id}>{t.origen} → {t.destino} ({dinero(t.pagoChofer, 'USD')})</option>
          ))}
        </select>
      </label>

      <div className="fila-2">
        {usuario?.rol === 'admin' && (
          <label className="campo"><span>Ingreso del viaje (USD)</span>
            <input type="number" inputMode="decimal" min="0" step="0.01" value={f.precio} onChange={set('precio')} />
          </label>
        )}
        <label className="campo"><span>Viáticos entregados (USD)</span>
          <input type="number" inputMode="decimal" min="0" step="0.01" value={f.viaticosEntregados} onChange={set('viaticosEntregados')} />
        </label>
      </div>

      {/* entregas: en alta son filas locales que la RPC crea; en edición viven en Supabase */}
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
        <div><span className="muted">Diésel estimado ({km} km / {rendimiento || '—'} km/L mediana × ${precioLitro}/L)</span><span>{rendimiento ? dinero(costoDieselUSD, 'USD') : '— (sin datos)'}</span></div>
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

/* ---------- Entregas del viaje (dispatch/admin) ---------- */

function EntregasSection({ viaje, clientes, dirs, cargarDirs, editable }) {
  const [entregas, setEntregas] = useState(null)
  const [nueva, setNueva] = useState(null) // entregaVacia() | null

  useEffect(() => {
    const cargar = () => supabase.from('viaje_entregas').select(SELECT_ENTREGA).eq('viaje_id', viaje.id)
      .then(({ data, error }) => {
        if (error) { console.error(error); return }
        setEntregas(data.map(mapEntrega).sort((a, b) => (a.ordenSecuencia ?? 0) - (b.ordenSecuencia ?? 0)))
      })
    cargar()
    const canal = supabase
      .channel(`viaje-entregas-${viaje.id}-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'viaje_entregas', filter: `viaje_id=eq.${viaje.id}` }, cargar)
      .subscribe()
    return () => supabase.removeChannel(canal)
  }, [viaje.id])

  const lista = entregas ?? []

  const mover = async (i, dir) => {
    const a = lista[i], b = lista[i + dir]
    if (!a || !b) return
    try {
      await supabase.from('viaje_entregas').update({ orden_secuencia: b.ordenSecuencia }).eq('id', a.id).throwOnError()
      await supabase.from('viaje_entregas').update({ orden_secuencia: a.ordenSecuencia }).eq('id', b.id).throwOnError()
    } catch (e) { alert('Error: ' + e.message) }
  }

  const agregar = async () => {
    if (!nueva.clienteId || !nueva.direccionEntregaId) { alert('Cliente y dirección son obligatorios'); return }
    try {
      const dir = (dirs[nueva.clienteId] ?? []).find((d) => d.id === nueva.direccionEntregaId)
      const orden = Math.max(0, ...lista.map((e) => e.ordenSecuencia ?? 0)) + 1
      const { error } = await supabase.from('viaje_entregas').insert({
        viaje_id: viaje.id,
        cliente_id: nueva.clienteId,
        direccion_id: nueva.direccionEntregaId,
        direccion_snapshot: dir ? direccionTexto(dir) : '',
        mercancia: nueva.mercancia,
        orden_secuencia: orden,
      })
      if (error) throw error
      setNueva(null)
    } catch (e) { alert('Error: ' + e.message) }
  }

  const eliminar = async (entrega) => {
    if (!confirm(`¿Eliminar la entrega de ${entrega.clienteNombre}?`)) return
    try {
      const { error } = await supabase.from('viaje_entregas').delete().eq('id', entrega.id)
      if (error) throw error
    } catch (e) { alert('Error: ' + e.message) }
  }

  const entregar = async (entrega) => {
    if (!confirm(`¿Marcar como entregada la entrega de ${entrega.clienteNombre}?`)) return
    try { await marcarEntregada(entrega.id, '') } catch (e) { alert('Error: ' + e.message) }
  }

  return (
    <>
      <h3>Entregas ({lista.length}{viaje.entregasPendientes > 0 ? ` · ${viaje.entregasPendientes} pendientes` : ''})</h3>
      {entregas === null && <p className="muted">Cargando…</p>}
      {entregas !== null && lista.length === 0 && (
        <p className="muted">Sin entregas registradas.</p>
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
        <p className="muted">Sin movimientos registrados.</p>
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
      const { error } = await supabase.rpc('registrar_cambio_custodia', {
        p_viaje_id: viaje.id, p_chofer_id: chofer.id, p_camion_id: camion.id,
        p_caja_id: (f.cambiarCaja ? f.cajaId : movActivo.cajaPlataformaId) || null,
        p_odometro_cierre: Number(f.odometroCierre) || null,
        p_odometro_inicio_nuevo: Number(f.odometroInicioNuevo) || null,
        p_motivo: f.motivo.trim(),
      })
      if (error) throw error
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

function MisViajes() {
  // RLS ya limita a los viajes donde el chofer es el actual -- no hace falta filtrar por email
  const viajes = useViajes()
  const unidades = useUnidades()

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
              {estatusLabel(v)}
            </span>
          </div>
          <div className="muted">{v.fecha} · {v.origen} → {v.destino}</div>
          <div className="muted">Unidad {v.unidadNumero}{v.cajaNumero && ` · Caja ${v.cajaNumero}`}</div>
          <div className="muted">Viáticos entregados: {dinero(v.viaticosEntregados, 'USD')}</div>
          {v.estatus === 'en_proceso' && (v.iniciadoEn
            ? <PanelViajeEnCurso viajeId={v.id} unidadPorDefecto={unidades.find((u) => u.id === v.unidadId)?.unidadLectura} inicioTexto={fmtTs(v.iniciadoEn)} />
            : <BotonInicioViaje viajeId={v.id} unidadPorDefecto={unidades.find((u) => u.id === v.unidadId)?.unidadLectura} />)}
        </div>
      ))}
    </div>
  )
}

function BotonInicioViaje({ viajeId, unidadPorDefecto }) {
  const [kmInicio, setKmInicio] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const iniciar = async () => {
    if (kmInicio == null) { alert('Escribe el kilometraje inicial'); return }
    setGuardando(true)
    try { await iniciarViaje(viajeId, kmInicio) } catch (err) { alert('Error: ' + err.message) } finally { setGuardando(false) }
  }
  return (
    <div className="tarjeta detalle">
      <CampoOdometro label="Km inicial" unidadPorDefecto={unidadPorDefecto} onChangeKm={setKmInicio} />
      <button className="btn-primario" disabled={guardando} onClick={iniciar}>
        {guardando ? 'Guardando…' : 'Inicio de viaje'}
      </button>
    </div>
  )
}

// envuelve el tramo "ya iniciado" de un viaje: muestra cuándo arrancó, pide el km final
// (mismo selector Km/Millas que el inicio) y se lo pasa a EntregasChofer para el auto-cierre
function PanelViajeEnCurso({ viajeId, unidadPorDefecto, inicioTexto }) {
  const [kmFinal, setKmFinal] = useState(null)
  return (
    <>
      <div className="muted">Inicio de viaje: {inicioTexto}</div>
      <CampoOdometro label="Km final (al terminar)" unidadPorDefecto={unidadPorDefecto} onChangeKm={setKmFinal} />
      <EntregasChofer viajeId={viajeId} kmFinalKm={kmFinal} />
    </>
  )
}

// entregas del viaje en curso: el chofer las marca entregadas con foto de evidencia opcional
function EntregasChofer({ viajeId, kmFinalKm }) {
  const [entregas, setEntregas] = useState(null)
  const [fotos, setFotos] = useState({}) // entregaId -> File
  const [subiendo, setSubiendo] = useState('')

  useEffect(() => {
    const cargar = () => supabase.from('viaje_entregas').select(SELECT_ENTREGA).eq('viaje_id', viajeId)
      .then(({ data, error }) => {
        if (error) { console.error(error); return }
        setEntregas(data.map(mapEntrega).sort((a, b) => (a.ordenSecuencia ?? 0) - (b.ordenSecuencia ?? 0)))
      })
    cargar()
    const canal = supabase
      .channel(`entregas-chofer-${viajeId}-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'viaje_entregas', filter: `viaje_id=eq.${viajeId}` }, cargar)
      .subscribe()
    return () => supabase.removeChannel(canal)
  }, [viajeId])

  const entregar = async (e) => {
    if (!confirm(`¿Marcar como entregada la entrega de ${e.clienteNombre}?`)) return
    setSubiendo(e.id)
    try {
      // se cuenta directo en la base (no con el `entregas` del estado local, que puede estar
      // desactualizado si el chofer marca varias entregas seguidas rápido) y ANTES de marcar
      // esta, para poder frenar aquí si es la última y todavía no hay km final -- si marcáramos
      // primero y bloqueáramos después, la entrega quedaría "entregada" sin viaje terminado y
      // sin forma de reintentar (el botón desaparece en cuanto estatus === 'entregada').
      const { count, error: countError } = await supabase.from('viaje_entregas')
        .select('id', { count: 'exact', head: true }).eq('viaje_id', viajeId).eq('estatus', 'pendiente')
      if (countError) throw countError
      const esUltima = count === 1
      if (esUltima && kmFinalKm == null) {
        alert('Esta es la última entrega -- escribe el kilometraje final antes de marcarla, para poder cerrar el viaje.')
        return
      }
      const archivo = fotos[e.id]
      const url = archivo ? await subirArchivo(`viajes/${viajeId}/pod_${e.id}_${archivo.name}`, archivo) : ''
      await marcarEntregada(e.id, url)
      // el viaje se termina solo y pasa a Cobranza -- dispatch ya no tiene que reabrirlo,
      // conserva el cierre manual como respaldo
      if (esUltima) {
        const { error } = await supabase.rpc('terminar_viaje', {
          p_viaje_id: viajeId, p_odometro_fin: kmFinalKm, p_viaticos_comprobados: null,
        })
        if (error) throw error
      }
    } catch (err) {
      console.error(err)
      alert('Error: ' + err.message)
    } finally {
      setSubiendo('')
    }
  }

  if (!entregas?.length) return null
  return (
    <div className="linea">
      <strong>Entregas</strong>
      {entregas.map((e) => (
        <div key={e.id} className="tarjeta detalle">
          <div className="tarjeta-top">
            <strong>{e.ordenSecuencia}. {e.clienteNombre}</strong>
            {e.estatus === 'entregada'
              ? <span className="badge completado">Entregada</span>
              : <span className="badge en_proceso">Pendiente</span>}
          </div>
          <div className="muted">{e.direccion}</div>
          {e.mercancia && <div className="muted">{e.mercancia}</div>}
          {e.estatus === 'pendiente' && (
            <>
              <label className="campo"><span>Foto de evidencia (opcional)</span>
                <input type="file" accept="image/*" capture="environment"
                  onChange={(ev) => setFotos({ ...fotos, [e.id]: ev.target.files[0] ?? null })} />
              </label>
              <button className="btn-completar" disabled={subiendo === e.id} onClick={() => entregar(e)}>
                {subiendo === e.id ? 'Guardando…' : 'Marcar como entregada'}
              </button>
            </>
          )}
          {e.evidenciaUrl && <p><a href={e.evidenciaUrl} target="_blank" rel="noreferrer">Ver evidencia</a></p>}
        </div>
      ))}
    </div>
  )
}

/* ---------- Cobranza / Cuentas por Cobrar (admin) ---------- */

function Cobranza() {
  const viajes = useViajes()
  const [detalle, setDetalle] = useState(null)

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
  const clientes = useClientes() ?? []
  const [fechaFactura, setFechaFactura] = useState(viaje.cobranza?.fechaFactura || hoy())
  const [pdf, setPdf] = useState(null)
  const [xml, setXml] = useState(null)
  const [comprobante, setComprobante] = useState(null)
  const [guardando, setGuardando] = useState(false)

  // viaje puede tener varios clientes (multi-drop); el crédito se calcula sobre el primero
  const cliente = clientes.find((c) => c.id === viaje.clientesIds?.[0])
  const cobranza = viaje.cobranza ?? {}
  const facturado = Boolean(cobranza.fechaFactura)

  const facturar = async () => {
    if (!fechaFactura) { alert('Escribe la fecha de factura'); return }
    setGuardando(true)
    try {
      const diasCredito = cliente?.diasCredito ?? 0
      const facturaURL = pdf ? await subirArchivo(`viajes/${viaje.id}/factura_${pdf.name}`, pdf) : (cobranza.facturaURL || '')
      const xmlURL = xml ? await subirArchivo(`viajes/${viaje.id}/xml_${xml.name}`, xml) : (cobranza.xmlURL || '')
      const { error } = await supabase.from('viajes').update({
        cobranza_fecha_factura: fechaFactura,
        // vencimiento estático: fecha factura + días de crédito del cliente
        cobranza_fecha_vence: sumaDias(fechaFactura, diasCredito),
        cobranza_factura_path: facturaURL || null, cobranza_xml_path: xmlURL || null,
      }).eq('id', viaje.id)
      if (error) throw error
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
      const { error } = await supabase.from('viajes').update({
        cobranza_pagado: true, cobranza_comprobante_path: comprobanteURL || null, cobranza_pagado_at: hoy(),
      }).eq('id', viaje.id)
      if (error) throw error
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

/* KPI Km/hora por chofer -- agrupa por segmento de viaje_movimientos (no por viaje completo),
   así un cambio de custodia a media ruta le atribuye a cada chofer exactamente su propio tramo.
   Sin filtro de atípicos por ahora (ver v_kmh_por_chofer): con cero viajes reales usando el
   flujo de Km inicial/final todavía, es prematuro definir un umbral -- se revisita cuando haya
   datos reales que mostrar el patrón. */
function KmPorChofer() {
  const operadores = useOperadores() ?? []
  const [filas, setFilas] = useState(null)

  useEffect(() => {
    const cargar = () => supabase.from('v_kmh_por_chofer').select('*').then(({ data, error }) => {
      if (!error) setFilas(data)
      else console.error(error)
    })
    cargar()
    const canal = supabase
      .channel(`kmh-chofer-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'viaje_movimientos' }, cargar)
      .subscribe()
    return () => supabase.removeChannel(canal)
  }, [])

  const nombreChofer = (id) => operadores.find((o) => o.id === id)?.nombre ?? '—'
  const ordenadas = (filas ?? [])
    .filter((f) => f.km_por_hora != null)
    .sort((a, b) => Number(b.km_por_hora) - Number(a.km_por_hora))

  return (
    <div>
      <h2>Km/hora por chofer</h2>
      {filas === null && <p className="muted">Cargando…</p>}
      {filas !== null && ordenadas.length === 0 && (
        <p className="muted vacio">Sin datos suficientes todavía.<br />Se calcula con los tramos de viaje que ya tienen Inicio de Viaje + Km inicial + Km final capturados.</p>
      )}
      {ordenadas.length > 0 && (
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr><th>Chofer</th><th className="num">Km/hora</th><th className="num">Km totales</th><th className="num">Horas totales</th><th className="num">Tramos</th></tr>
            </thead>
            <tbody>
              {ordenadas.map((f) => (
                <tr key={f.chofer_id}>
                  <td>{nombreChofer(f.chofer_id)}</td>
                  <td className="num">{Number(f.km_por_hora).toLocaleString()} km/h</td>
                  <td className="num">{Number(f.km_totales).toLocaleString()} km</td>
                  <td className="num">{Number(f.horas_totales).toLocaleString()} h</td>
                  <td className="num">{f.segmentos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
