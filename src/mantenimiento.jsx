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
      <div className="toolbar-lista">
        <h2>Mantenimiento Preventivo</h2>
      </div>
      {pendientes.length === 0 && (
        <p className="muted vacio">No hay unidades próximas o vencidas de servicio programado.</p>
      )}
      {pendientes.length > 0 && (
        <div className="tabla-scroll">
          <table className="tabla-densa">
            <thead>
              <tr><th>Unidad</th><th>Estatus</th><th className="num">Restante</th></tr>
            </thead>
            <tbody>
              {pendientes.map(({ u, estatus, restante }) => {
                const unidadRestante = u.unidadLectura === 'hrs' ? 'hrs' : 'km'
                return (
                  <tr key={u.id} onClick={() => setAbierta(u)}>
                    <td><strong>{u.numero}</strong></td>
                    <td>
                      <span className={'punto-estado ' + estatus} />
                      {estatus === 'vencido' ? 'Vencido' : 'Próximo'}
                    </td>
                    <td className="num muted">
                      {estatus === 'vencido'
                        ? `Hace ${Math.abs(restante).toLocaleString()} ${unidadRestante}`
                        : `Faltan ${restante.toLocaleString()} ${unidadRestante}`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {sinConfigurar.length > 0 && (
        <>
          <h3 className="muted">Sin intervalo configurado</h3>
          <div className="tabla-scroll">
            <table className="tabla-densa">
              <tbody>
                {sinConfigurar.map((u) => (
                  <tr key={u.id} onClick={() => setAbierta(u)}>
                    <td><strong>{u.numero}</strong></td>
                    <td className="muted"><span className="punto-estado sin_configurar" /> Sin configurar</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
