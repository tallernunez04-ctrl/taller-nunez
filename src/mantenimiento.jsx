import { useState } from 'react'
import { useUnidades, paraMantenimiento, estatusMantenimiento } from './compras'
import { WOForm } from './taller'

// mismo cálculo que BadgeMantenimiento (compras.jsx): próximo = último 10% del intervalo, vencido = restante <= 0.
// "sin configurar" (sin mantenimientoCadaX) se separa de vencidas/próximas -- no es lo mismo no tener
// intervalo que sí tenerlo y haberlo rebasado.
export default function MantenimientoPreventivo({ usuario }) {
  const unidades = useUnidades()
  const [abierta, setAbierta] = useState(null)

  const activas = unidades.filter((u) => u.activo)
  const pendientes = activas
    .map((u) => ({ u, estatus: estatusMantenimiento(u), restante: paraMantenimiento(u) }))
    .filter(({ estatus }) => estatus === 'vencido' || estatus === 'proximo')
    .sort((a, b) => a.restante - b.restante)
  const sinConfigurar = activas.filter((u) => estatusMantenimiento(u) === 'sin_configurar')

  if (abierta) {
    return (
      <WOForm
        key={abierta.id}
        usuario={usuario}
        wo={null}
        programado={{ unidadId: abierta.id, unidadNumero: abierta.numero, unidadLectura: abierta.unidadLectura }}
        onDone={() => setAbierta(null)}
      />
    )
  }

  return (
    <div>
      <h2>Mantenimiento Preventivo</h2>
      {pendientes.length === 0 && (
        <p className="muted vacio">No hay unidades próximas o vencidas de servicio programado.</p>
      )}
      {pendientes.map(({ u, estatus, restante }) => {
        const unidadRestante = u.unidadLectura === 'hrs' ? 'hrs' : 'km'
        return (
          <button key={u.id} className="tarjeta" onClick={() => setAbierta(u)}>
            <div className="tarjeta-top">
              <strong>{u.numero}</strong>
              <span className={estatus === 'vencido' ? 'badge vencido' : 'badge alerta'}>
                {estatus === 'vencido' ? 'Vencido' : 'Próximo'}
              </span>
            </div>
            <div className="muted">
              {estatus === 'vencido'
                ? `Vencido hace ${Math.abs(restante).toLocaleString()} ${unidadRestante}`
                : `Faltan ${restante.toLocaleString()} ${unidadRestante}`}
            </div>
          </button>
        )
      })}

      {sinConfigurar.length > 0 && (
        <>
          <h3 className="muted">Sin intervalo configurado</h3>
          {sinConfigurar.map((u) => (
            <button key={u.id} className="tarjeta" onClick={() => setAbierta(u)}>
              <div className="tarjeta-top">
                <strong>{u.numero}</strong>
                <span className="badge inactivo">Sin configurar</span>
              </div>
            </button>
          ))}
        </>
      )}
    </div>
  )
}
