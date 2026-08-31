-- Las vistas agregadas (v_viaje_*, v_balance_mensual) las creó el dueño (postgres), así que por
-- default corren con SUS privilegios, no los de quien las consulta -- bypasean RLS por completo.
-- Cualquier usuario autenticado (incluso chofer) puede pegarle directo a
-- supabase.from('v_balance_mensual').select('*') desde la consola del navegador y ver la
-- utilidad completa de la empresa; con v_viaje_kilometraje/v_viaje_entregas_resumen/
-- v_viaje_clientes/v_viaje_cargas_resumen un chofer podría ver viajes de otros choferes.
--
-- Fix en dos partes:
-- 1) v_viaje_kilometraje/v_viaje_entregas_resumen/v_viaje_cargas_resumen/v_viaje_clientes:
--    security_invoker=true (PG15+) para que hereden el RLS real de viajes/viaje_movimientos/
--    viaje_entregas/viaje_cargas según el rol que consulta.
-- 2) v_balance_mensual (agregado de TODA la empresa, sin dueño de fila que invocar) no tiene
--    forma correcta de "heredar RLS" -- se cierra por completo y se expone solo vía RPC
--    security definer que valida admin explícitamente.
--
-- v_viaje_clientes hace join a `clientes`, y esa tabla no tenía política de lectura para
-- chofer (correcto: solo taller/compras/dispatch) -- con security_invoker=true eso habría roto
-- "Mis viajes" para chofer (el nombre del cliente desaparecería). Se agrega una política
-- estrecha: un chofer puede leer solo los clientes que aparecen en sus propios viajes.
create policy clientes_chofer_propios on clientes for select
using (
  auth_es(array['chofer']::rol_usuario[]) and (
    exists (
      select 1 from viaje_entregas ve join viajes v on v.id = ve.viaje_id
      where ve.cliente_id = clientes.id and v.chofer_actual_id = auth_operador_id()
    )
    or exists (
      select 1 from viaje_cargas vc join viajes v on v.id = vc.viaje_id
      where vc.cliente_id = clientes.id and v.chofer_actual_id = auth_operador_id()
    )
  )
);

alter view v_viaje_kilometraje set (security_invoker = true);
alter view v_viaje_entregas_resumen set (security_invoker = true);
alter view v_viaje_cargas_resumen set (security_invoker = true);
alter view v_viaje_clientes set (security_invoker = true);

-- app interna, sin usuarios anónimos en ningún flujo -- cierra el acceso de anon a estas
-- vistas de negocio (defensa en profundidad, aunque RLS ya bloquee filas para anon)
revoke all on v_viaje_kilometraje from anon;
revoke all on v_viaje_entregas_resumen from anon;
revoke all on v_viaje_cargas_resumen from anon;
revoke all on v_viaje_clientes from anon;
revoke all on v_rendimiento_unidades from anon;

-- v_balance_mensual: sin dueño de fila (es un agregado mensual de toda la compañía), así que
-- security_invoker no alcanza -- se cierra el acceso directo y se expone solo por RPC.
revoke all on v_balance_mensual from anon, authenticated;

create or replace function public.obtener_balance_mensual(p_mes date default null)
 returns setof v_balance_mensual
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not auth_es(array['admin']::rol_usuario[]) then
    raise exception 'No autorizado' using errcode = 'insufficient_privilege';
  end if;
  return query select * from v_balance_mensual where p_mes is null or mes = p_mes;
end;
$function$;

grant execute on function public.obtener_balance_mensual(date) to authenticated;
