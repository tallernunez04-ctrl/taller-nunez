-- =====================================================================
-- Taller Núñez — Row Level Security para las 21 tablas de producción
-- =====================================================================
-- IMPORTANTE: producción ya tenía RLS habilitado en las 21 tablas con
-- 42 políticas creadas fuera de control de versiones (no existían en
-- supabase/migrations/, probablemente aplicadas a mano en el SQL
-- Editor del dashboard). Esas políticas no coinciden con la matriz de
-- acceso pedida (p.ej. varios SELECT usaban auth_activo() dejando leer
-- a cualquier rol activo, incluido chofer, tablas a las que no debería
-- tener acceso; unidades_write daba escritura completa a compras).
--
-- Esta migración reemplaza TODAS esas políticas por el set completo
-- que corresponde a la matriz, dejándolo versionado. Los nombres viejos
-- se dan de baja explícitamente con DROP POLICY IF EXISTS.
--
-- Matriz de acceso por rol (chofer / taller / compras / admin), usando
-- las funciones SECURITY DEFINER ya existentes: auth_rol(), auth_es(),
-- auth_activo(), auth_operador_id().
--
-- Convenciones aplicadas (no explícitas en la matriz, decisión de esta
-- migración):
--   - "lectura"            -> SELECT
--   - "lectura/escritura"  -> SELECT + INSERT + UPDATE (sin DELETE)
--   - "propia fila"/"propios" -> SELECT + UPDATE acotado al dueño del
--     registro (sin INSERT salvo que la matriz diga "insertar")
--   - "insertar (propias)" -> INSERT acotado al dueño, sin SELECT/UPDATE
--   - admin "todas"        -> ALL (incluye DELETE), sin restricción
--
-- Excepción de seguridad añadida (no pedida explícitamente, pero
-- necesaria): perfiles.rol/activo/oculto no se pueden auto-modificar
-- ni siquiera en la propia fila, para evitar auto-escalación de
-- privilegios vía UPDATE directo. Ver trigger trg_perfiles_guarda_rol.
-- =====================================================================

-- ---------------------------------------------------------------------
-- perfiles
-- ---------------------------------------------------------------------
alter table public.perfiles enable row level security;

drop policy if exists perfiles_admin on public.perfiles;
drop policy if exists perfiles_select on public.perfiles;

create policy perfiles_admin_todas on public.perfiles
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy perfiles_propia_fila_select on public.perfiles
  for select using (id = auth.uid());

create policy perfiles_propia_fila_update on public.perfiles
  for update using (id = auth.uid())
  with check (id = auth.uid());

create or replace function public.trg_perfiles_guarda_rol()
returns trigger
language plpgsql
as $function$
begin
  if auth_rol() is distinct from 'admin' then
    if (new.rol, new.activo, new.oculto) is distinct from (old.rol, old.activo, old.oculto) then
      raise exception 'No puedes modificar tu propio rol, activo u oculto'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $function$;

create trigger t_perfiles_guarda_rol
  before update on public.perfiles
  for each row execute function public.trg_perfiles_guarda_rol();

-- ---------------------------------------------------------------------
-- config (lectura para cualquier rol activo, escritura solo admin)
-- ---------------------------------------------------------------------
alter table public.config enable row level security;

drop policy if exists config_admin on public.config;
drop policy if exists config_select on public.config;

create policy config_admin_todas on public.config
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy config_lectura on public.config
  for select using (auth_activo());

-- ---------------------------------------------------------------------
-- tabuladores (taller/compras lectura)
-- ---------------------------------------------------------------------
alter table public.tabuladores enable row level security;

drop policy if exists tabuladores_admin on public.tabuladores;
drop policy if exists tabuladores_select on public.tabuladores;

create policy tabuladores_admin_todas on public.tabuladores
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy tabuladores_lectura on public.tabuladores
  for select using (auth_es(array['taller','compras']::rol_usuario[]));

-- ---------------------------------------------------------------------
-- clientes (taller lectura/escritura, compras lectura)
-- ---------------------------------------------------------------------
alter table public.clientes enable row level security;

drop policy if exists clientes_admin on public.clientes;
drop policy if exists clientes_select on public.clientes;

create policy clientes_admin_todas on public.clientes
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy clientes_lectura on public.clientes
  for select using (auth_es(array['taller','compras']::rol_usuario[]));

create policy clientes_taller_insert on public.clientes
  for insert with check (auth_es(array['taller']::rol_usuario[]));

create policy clientes_taller_update on public.clientes
  for update using (auth_es(array['taller']::rol_usuario[]))
  with check (auth_es(array['taller']::rol_usuario[]));

-- ---------------------------------------------------------------------
-- cliente_direcciones (taller lectura/escritura, compras lectura)
-- ---------------------------------------------------------------------
alter table public.cliente_direcciones enable row level security;

drop policy if exists direcciones_admin on public.cliente_direcciones;
drop policy if exists direcciones_select on public.cliente_direcciones;

create policy cliente_direcciones_admin_todas on public.cliente_direcciones
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy cliente_direcciones_lectura on public.cliente_direcciones
  for select using (auth_es(array['taller','compras']::rol_usuario[]));

create policy cliente_direcciones_taller_insert on public.cliente_direcciones
  for insert with check (auth_es(array['taller']::rol_usuario[]));

create policy cliente_direcciones_taller_update on public.cliente_direcciones
  for update using (auth_es(array['taller']::rol_usuario[]))
  with check (auth_es(array['taller']::rol_usuario[]));

-- ---------------------------------------------------------------------
-- proveedores (compras lectura/escritura)
-- ---------------------------------------------------------------------
alter table public.proveedores enable row level security;

drop policy if exists proveedores_select on public.proveedores;
drop policy if exists proveedores_write on public.proveedores;

create policy proveedores_admin_todas on public.proveedores
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy proveedores_compras_select on public.proveedores
  for select using (auth_es(array['compras']::rol_usuario[]));

create policy proveedores_compras_insert on public.proveedores
  for insert with check (auth_es(array['compras']::rol_usuario[]));

create policy proveedores_compras_update on public.proveedores
  for update using (auth_es(array['compras']::rol_usuario[]))
  with check (auth_es(array['compras']::rol_usuario[]));

-- ---------------------------------------------------------------------
-- unidades (taller lectura/escritura, compras lectura,
--           chofer select+update -- update acotado a ultima_lectura
--           por el trigger t_unidades_guarda_chofer ya existente)
-- ---------------------------------------------------------------------
alter table public.unidades enable row level security;

drop policy if exists unidades_chofer_lectura on public.unidades;
drop policy if exists unidades_select on public.unidades;
drop policy if exists unidades_write on public.unidades;

create policy unidades_admin_todas on public.unidades
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy unidades_lectura on public.unidades
  for select using (auth_es(array['taller','compras','chofer']::rol_usuario[]));

create policy unidades_taller_insert on public.unidades
  for insert with check (auth_es(array['taller']::rol_usuario[]));

create policy unidades_update on public.unidades
  for update using (auth_es(array['taller','chofer']::rol_usuario[]))
  with check (auth_es(array['taller','chofer']::rol_usuario[]));

-- ---------------------------------------------------------------------
-- empleados (taller lectura/escritura)
-- ---------------------------------------------------------------------
alter table public.empleados enable row level security;

drop policy if exists empleados_admin on public.empleados;

create policy empleados_admin_todas on public.empleados
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy empleados_taller_select on public.empleados
  for select using (auth_es(array['taller']::rol_usuario[]));

create policy empleados_taller_insert on public.empleados
  for insert with check (auth_es(array['taller']::rol_usuario[]));

create policy empleados_taller_update on public.empleados
  for update using (auth_es(array['taller']::rol_usuario[]))
  with check (auth_es(array['taller']::rol_usuario[]));

-- ---------------------------------------------------------------------
-- operadores (chofer propia fila, taller lectura/escritura)
-- ---------------------------------------------------------------------
alter table public.operadores enable row level security;

drop policy if exists operadores_admin on public.operadores;
drop policy if exists operadores_select on public.operadores;

create policy operadores_admin_todas on public.operadores
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy operadores_select on public.operadores
  for select using (auth_es(array['taller']::rol_usuario[]) or perfil_id = auth.uid());

create policy operadores_taller_insert on public.operadores
  for insert with check (auth_es(array['taller']::rol_usuario[]));

create policy operadores_update on public.operadores
  for update using (auth_es(array['taller']::rol_usuario[]) or perfil_id = auth.uid())
  with check (auth_es(array['taller']::rol_usuario[]) or perfil_id = auth.uid());

-- ---------------------------------------------------------------------
-- operador_contactos_emergencia (chofer propia fila, taller lectura/escritura)
-- ---------------------------------------------------------------------
alter table public.operador_contactos_emergencia enable row level security;

drop policy if exists contactos_admin on public.operador_contactos_emergencia;
drop policy if exists contactos_select on public.operador_contactos_emergencia;

create policy contactos_emergencia_admin_todas on public.operador_contactos_emergencia
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy contactos_emergencia_select on public.operador_contactos_emergencia
  for select using (auth_es(array['taller']::rol_usuario[]) or operador_id = auth_operador_id());

create policy contactos_emergencia_insert on public.operador_contactos_emergencia
  for insert with check (auth_es(array['taller']::rol_usuario[]) or operador_id = auth_operador_id());

create policy contactos_emergencia_update on public.operador_contactos_emergencia
  for update using (auth_es(array['taller']::rol_usuario[]) or operador_id = auth_operador_id())
  with check (auth_es(array['taller']::rol_usuario[]) or operador_id = auth_operador_id());

-- ---------------------------------------------------------------------
-- viajes (chofer propios, taller lectura/escritura)
-- ---------------------------------------------------------------------
alter table public.viajes enable row level security;

drop policy if exists viajes_admin on public.viajes;
drop policy if exists viajes_select on public.viajes;

create policy viajes_admin_todas on public.viajes
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy viajes_select on public.viajes
  for select using (auth_es(array['taller']::rol_usuario[]) or chofer_actual_id = auth_operador_id());

create policy viajes_taller_insert on public.viajes
  for insert with check (auth_es(array['taller']::rol_usuario[]));

create policy viajes_update on public.viajes
  for update using (auth_es(array['taller']::rol_usuario[]) or chofer_actual_id = auth_operador_id())
  with check (auth_es(array['taller']::rol_usuario[]) or chofer_actual_id = auth_operador_id());

-- ---------------------------------------------------------------------
-- viaje_movimientos (chofer propios, taller lectura/escritura)
-- ---------------------------------------------------------------------
alter table public.viaje_movimientos enable row level security;

drop policy if exists mov_admin on public.viaje_movimientos;
drop policy if exists mov_select on public.viaje_movimientos;

create policy viaje_movimientos_admin_todas on public.viaje_movimientos
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy viaje_movimientos_select on public.viaje_movimientos
  for select using (auth_es(array['taller']::rol_usuario[]) or chofer_id = auth_operador_id());

create policy viaje_movimientos_insert on public.viaje_movimientos
  for insert with check (auth_es(array['taller']::rol_usuario[]) or chofer_id = auth_operador_id());

create policy viaje_movimientos_update on public.viaje_movimientos
  for update using (auth_es(array['taller']::rol_usuario[]) or chofer_id = auth_operador_id())
  with check (auth_es(array['taller']::rol_usuario[]) or chofer_id = auth_operador_id());

-- ---------------------------------------------------------------------
-- viaje_entregas (chofer propios -- vía viaje asignado, taller lectura/escritura)
-- ---------------------------------------------------------------------
alter table public.viaje_entregas enable row level security;

drop policy if exists entregas_admin on public.viaje_entregas;
drop policy if exists entregas_chofer_update on public.viaje_entregas;
drop policy if exists entregas_select on public.viaje_entregas;

create policy viaje_entregas_admin_todas on public.viaje_entregas
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy viaje_entregas_select on public.viaje_entregas
  for select using (
    auth_es(array['taller']::rol_usuario[])
    or viaje_id in (select id from public.viajes where chofer_actual_id = auth_operador_id())
  );

create policy viaje_entregas_taller_insert on public.viaje_entregas
  for insert with check (auth_es(array['taller']::rol_usuario[]));

create policy viaje_entregas_update on public.viaje_entregas
  for update using (
    auth_es(array['taller']::rol_usuario[])
    or viaje_id in (select id from public.viajes where chofer_actual_id = auth_operador_id())
  )
  with check (
    auth_es(array['taller']::rol_usuario[])
    or viaje_id in (select id from public.viajes where chofer_actual_id = auth_operador_id())
  );

-- ---------------------------------------------------------------------
-- compras (compras lectura/escritura)
-- ---------------------------------------------------------------------
alter table public.compras enable row level security;

drop policy if exists compras_all on public.compras;

create policy compras_admin_todas on public.compras
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy compras_select on public.compras
  for select using (auth_es(array['compras']::rol_usuario[]));

create policy compras_insert on public.compras
  for insert with check (auth_es(array['compras']::rol_usuario[]));

create policy compras_update on public.compras
  for update using (auth_es(array['compras']::rol_usuario[]))
  with check (auth_es(array['compras']::rol_usuario[]));

-- ---------------------------------------------------------------------
-- compra_conceptos (compras lectura/escritura)
-- ---------------------------------------------------------------------
alter table public.compra_conceptos enable row level security;

drop policy if exists conceptos_all on public.compra_conceptos;

create policy compra_conceptos_admin_todas on public.compra_conceptos
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy compra_conceptos_select on public.compra_conceptos
  for select using (auth_es(array['compras']::rol_usuario[]));

create policy compra_conceptos_insert on public.compra_conceptos
  for insert with check (auth_es(array['compras']::rol_usuario[]));

create policy compra_conceptos_update on public.compra_conceptos
  for update using (auth_es(array['compras']::rol_usuario[]))
  with check (auth_es(array['compras']::rol_usuario[]));

-- ---------------------------------------------------------------------
-- work_orders (taller lectura/escritura -- el chofer no tiene acceso
-- directo a work_orders; solo puede insertar en reportes_falla)
-- ---------------------------------------------------------------------
alter table public.work_orders enable row level security;

drop policy if exists wo_delete on public.work_orders;
drop policy if exists wo_insert on public.work_orders;
drop policy if exists wo_select on public.work_orders;
drop policy if exists wo_update on public.work_orders;

create policy work_orders_admin_todas on public.work_orders
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy work_orders_taller_select on public.work_orders
  for select using (auth_es(array['taller']::rol_usuario[]));

create policy work_orders_taller_insert on public.work_orders
  for insert with check (auth_es(array['taller']::rol_usuario[]));

create policy work_orders_taller_update on public.work_orders
  for update using (auth_es(array['taller']::rol_usuario[]))
  with check (auth_es(array['taller']::rol_usuario[]));

-- ---------------------------------------------------------------------
-- reportes_falla (chofer insertar propias, taller lectura/escritura)
-- ---------------------------------------------------------------------
alter table public.reportes_falla enable row level security;

drop policy if exists reportes_insert on public.reportes_falla;
drop policy if exists reportes_select on public.reportes_falla;
drop policy if exists reportes_update on public.reportes_falla;

create policy reportes_falla_admin_todas on public.reportes_falla
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy reportes_falla_taller_select on public.reportes_falla
  for select using (auth_es(array['taller']::rol_usuario[]));

create policy reportes_falla_insert on public.reportes_falla
  for insert with check (
    auth_es(array['taller']::rol_usuario[])
    or (auth_rol() = 'chofer' and operador_id = auth_operador_id())
  );

create policy reportes_falla_taller_update on public.reportes_falla
  for update using (auth_es(array['taller']::rol_usuario[]))
  with check (auth_es(array['taller']::rol_usuario[]));

-- ---------------------------------------------------------------------
-- nominas / nomina_detalles / nomina_detalle_viajes (solo admin)
-- ---------------------------------------------------------------------
alter table public.nominas enable row level security;

drop policy if exists nominas_admin on public.nominas;

create policy nominas_admin_todas on public.nominas
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

alter table public.nomina_detalles enable row level security;

drop policy if exists detalles_admin on public.nomina_detalles;

create policy nomina_detalles_admin_todas on public.nomina_detalles
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

alter table public.nomina_detalle_viajes enable row level security;

drop policy if exists detvia_admin on public.nomina_detalle_viajes;

create policy nomina_detalle_viajes_admin_todas on public.nomina_detalle_viajes
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

-- ---------------------------------------------------------------------
-- cargas_diesel (chofer propias, taller/compras lectura/escritura)
-- No estaba en la matriz original entregada por el usuario -- es la
-- tabla 21 real (no existe una tabla de "conceptos de work_orders"
-- separada; work_orders guarda piezas en el array piezas_requeridas).
-- Acceso confirmado con el usuario: simétrico a viajes/viaje_movimientos.
-- ---------------------------------------------------------------------
alter table public.cargas_diesel enable row level security;

drop policy if exists diesel_admin on public.cargas_diesel;
drop policy if exists diesel_insert on public.cargas_diesel;
drop policy if exists diesel_select on public.cargas_diesel;

create policy cargas_diesel_admin_todas on public.cargas_diesel
  for all using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));

create policy cargas_diesel_select on public.cargas_diesel
  for select using (auth_es(array['taller','compras']::rol_usuario[]) or operador_id = auth_operador_id());

create policy cargas_diesel_insert on public.cargas_diesel
  for insert with check (auth_es(array['taller','compras']::rol_usuario[]) or operador_id = auth_operador_id());

create policy cargas_diesel_update on public.cargas_diesel
  for update using (auth_es(array['taller','compras']::rol_usuario[]) or operador_id = auth_operador_id())
  with check (auth_es(array['taller','compras']::rol_usuario[]) or operador_id = auth_operador_id());
