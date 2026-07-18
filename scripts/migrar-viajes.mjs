/* Migración Fase A: viajes planos → entregas + movimientos.

   Por cada viaje sin movimientos crea:
   - 1 movimiento inicial desde operadorId/unidadId/cajaId (activo solo si en_proceso)
   - 1 entrega desde clienteId/direccionEntregaId (entregada si el viaje ya terminó)
   - campos denormalizados: clientesIds, choferActual*, camionActual*, cajaPlataformaId,
     entregasPendientes, kmTotales
   No borra ningún campo existente. Idempotente: salta viajes que ya tienen movimientos.

   Uso:
     node scripts/migrar-viajes.mjs                  # DRY RUN: solo reporta, no escribe nada
     node scripts/migrar-viajes.mjs --ejecutar       # escribe de verdad

   Credenciales: variable GOOGLE_APPLICATION_CREDENTIALS apuntando al JSON del
   service account, o ./serviceAccount.json en la raíz del proyecto (fuera de git). */

import { existsSync } from 'node:fs'
import { initializeApp, applicationDefault, cert } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const EJECUTAR = process.argv.includes('--ejecutar')

const credencial = existsSync('./serviceAccount.json')
  ? cert('./serviceAccount.json')
  : applicationDefault()
initializeApp({ credential: credencial })
const db = getFirestore()

const direccionTexto = (d) => [d.calle, d.ciudad, d.estado, d.pais, d.cp].filter(Boolean).join(', ')

const viajesSnap = await db.collection('viajes').get()
console.log(`${EJECUTAR ? 'EJECUTANDO' : 'DRY RUN (nada se escribe; usa --ejecutar para aplicar)'}`)
console.log(`Viajes en la colección: ${viajesSnap.size}\n`)

let migrados = 0
let saltados = 0

for (const docSnap of viajesSnap.docs) {
  const v = docSnap.data()
  const ref = docSnap.ref

  const movs = await ref.collection('movimientos').limit(1).get()
  if (!movs.empty) {
    saltados++
    console.log(`- ${v.folio ?? ref.id}: ya migrado (tiene movimientos), se salta`)
    continue
  }

  const enProceso = v.estatus === 'en_proceso'

  // dirección de la entrega (si el viaje la tiene registrada)
  let direccion = ''
  if (v.clienteId && v.direccionEntregaId) {
    const dir = await db.doc(`clientes/${v.clienteId}/direcciones/${v.direccionEntregaId}`).get()
    if (dir.exists) direccion = direccionTexto(dir.data())
  }

  const movimiento = {
    choferId: v.operadorId ?? '', choferNombre: v.operadorNombre ?? '', choferEmail: v.operadorEmail ?? '',
    camionId: v.unidadId ?? '', camionNumero: v.unidadNumero ?? '',
    cajaPlataformaId: v.cajaId || null,
    fechaHoraInicio: v.createdAt ?? FieldValue.serverTimestamp(),
    fechaHoraFin: enProceso ? null : (v.terminadoAt ?? null),
    // el odómetro histórico no existe en el modelo plano; los km del viaje se conservan
    odometroInicio: null, odometroFin: null,
    kmRecorridos: v.km ?? null,
    motivoCambio: null, movimientoAnteriorId: null,
    activo: enProceso,
  }

  const entrega = v.clienteId ? {
    clienteId: v.clienteId,
    clienteNombre: v.clienteNombre ?? '',
    direccionEntregaId: v.direccionEntregaId ?? '',
    direccion,
    mercancia: '',
    ordenSecuencia: 1,
    estatus: enProceso ? 'pendiente' : 'entregada',
    fechaHoraEntregaReal: enProceso ? null : (v.terminadoAt ?? null),
    evidenciaUrl: '',
  } : null

  const parche = {
    clientesIds: v.clienteId ? [v.clienteId] : [],
    choferActualId: v.operadorId ?? '', choferActualNombre: v.operadorNombre ?? '', choferActualEmail: v.operadorEmail ?? '',
    camionActualId: v.unidadId ?? '', camionActualNumero: v.unidadNumero ?? '',
    cajaPlataformaId: v.cajaId || null, cajaNumero: v.cajaNumero ?? '',
    entregasPendientes: entrega && enProceso ? 1 : 0,
    kmTotales: v.km ?? 0,
  }

  console.log(`- ${v.folio ?? ref.id} (${v.estatus}):`)
  console.log(`    movimiento inicial: ${movimiento.choferNombre || 'sin chofer'} · unidad ${movimiento.camionNumero || '—'} · activo=${movimiento.activo}`)
  console.log(entrega
    ? `    entrega: ${entrega.clienteNombre} · ${direccion || 'sin dirección'} · ${entrega.estatus}`
    : '    sin entrega (viaje sin clienteId)')
  console.log(`    parche: entregasPendientes=${parche.entregasPendientes}, kmTotales=${parche.kmTotales}, clientesIds=[${parche.clientesIds}]`)

  if (EJECUTAR) {
    const batch = db.batch()
    batch.set(ref.collection('movimientos').doc(), movimiento)
    if (entrega) batch.set(ref.collection('entregas').doc(), entrega)
    batch.update(ref, parche)
    await batch.commit()
  }
  migrados++
}

console.log(`\n${EJECUTAR ? 'Migrados' : 'Por migrar'}: ${migrados} · Ya migrados (saltados): ${saltados}`)
if (!EJECUTAR && migrados > 0) console.log('Revisa el reporte y vuelve a correr con --ejecutar para aplicar.')
