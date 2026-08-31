-- Ninguna función/trigger/RPC de la app estaba versionada en supabase/migrations/ -- todas se
-- crearon directo en producción (dashboard/SQL editor). Aplicar las migraciones desde cero hoy
-- generaría un esquema sin auth_es/auth_rol/triggers de guarda de rol/RPCs de viajes-nómina-WO,
-- es decir, una app que no funciona. Esta migración es una foto de lo que YA corre en
-- producción (sin cambiar comportamiento) para que el repo deje de estar divergente.
--
-- De paso, limpia 3 overloads viejos (crear_viaje sin p_cargas, guardar_work_order sin
-- p_origen_mantenimiento_programado, registrar_carga_diesel sin p_estacion_id) que quedaron
-- huérfanos de una evolución de esquema anterior y que el frontend ya no llama.

-- ===== Helpers de auth (ya existían en producción) =====
create or replace function public.auth_activo()
 returns boolean
 language sql
 stable
as $function$
  select auth_rol() is not null
$function$;

create or replace function public.auth_es(roles rol_usuario[])
 returns boolean
 language sql
 stable
as $function$
  select auth_rol() = any(roles)
$function$;

create or replace function public.auth_operador_id()
 returns uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select o.id from operadores o where o.perfil_id = auth.uid() and o.activo
$function$;

create or replace function public.auth_rol()
 returns rol_usuario
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select p.rol from perfiles p where p.id = auth.uid() and p.activo
$function$;

-- ===== Triggers de guarda de rol/campos (ya existían en producción) =====
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
end
$function$;

create or replace function public.trg_unidades_guarda_chofer()
 returns trigger
 language plpgsql
as $function$
begin
  if auth_rol() = 'chofer' then
    if (new.numero, new.tipo, new.unidad_lectura, new.marca, new.modelo, new.vin,
        new.anio, new.mantenimiento_cada_x, new.ultimo_mantenimiento_valor, new.activo)
       is distinct from
       (old.numero, old.tipo, old.unidad_lectura, old.marca, old.modelo, old.vin,
        old.anio, old.mantenimiento_cada_x, old.ultimo_mantenimiento_valor, old.activo)
    then
      raise exception 'El chofer solo puede actualizar ultima_lectura'
        using errcode = 'insufficient_privilege';
    end if;
  elsif auth_rol() = 'taller' then
    if (new.numero, new.tipo, new.unidad_lectura, new.marca, new.modelo, new.vin,
        new.anio, new.mantenimiento_cada_x, new.activo)
       is distinct from
       (old.numero, old.tipo, old.unidad_lectura, old.marca, old.modelo, old.vin,
        old.anio, old.mantenimiento_cada_x, old.activo)
    then
      raise exception 'Taller solo puede actualizar ultima_lectura y ultimo_mantenimiento_valor'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end
$function$;

create or replace function public.trg_cargas_guarda_chofer()
 returns trigger
 language plpgsql
as $function$
begin
  if auth_rol() = 'chofer' then
    if (new.viaje_id, new.cliente_id, new.direccion_id, new.direccion_snapshot,
        new.mercancia, new.orden_secuencia)
       is distinct from
       (old.viaje_id, old.cliente_id, old.direccion_id, old.direccion_snapshot,
        old.mercancia, old.orden_secuencia)
    then
      raise exception 'El chofer solo puede modificar estatus y fecha_hora_recogido'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.trg_entregas_guarda_chofer()
 returns trigger
 language plpgsql
as $function$
begin
  if auth_rol() = 'chofer' then
    if (new.viaje_id, new.cliente_id, new.direccion_id, new.direccion_snapshot,
        new.mercancia, new.orden_secuencia)
       is distinct from
       (old.viaje_id, old.cliente_id, old.direccion_id, old.direccion_snapshot,
        old.mercancia, old.orden_secuencia)
    then
      raise exception 'El chofer solo puede modificar estatus, fecha_hora_entrega_real y evidencia_path'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end
$function$;

create or replace function public.trg_sync_custodia_viaje()
 returns trigger
 language plpgsql
as $function$
begin
  if new.activo then
    update viajes
       set chofer_actual_id = new.chofer_id,
           camion_actual_id = new.camion_id,
           caja_actual_id   = new.caja_id
     where id = new.viaje_id;
  end if;
  return new;
end
$function$;

create or replace function public.trg_viaje_no_terminar_con_pendientes()
 returns trigger
 language plpgsql
as $function$
begin
  if new.estatus in ('terminado','conciliado') and old.estatus = 'en_proceso' then
    if exists (
      select 1 from viaje_entregas
      where viaje_id = new.id and estatus = 'pendiente'
    ) then
      raise exception 'No se puede terminar el viaje %: tiene entregas pendientes', new.folio
        using errcode = 'check_violation';
    end if;
    if new.terminado_at is null then
      new.terminado_at := now();
    end if;
  end if;
  return new;
end
$function$;

create or replace function public.trg_viajes_guarda_chofer()
 returns trigger
 language plpgsql
as $function$
begin
  if auth_rol() = 'chofer' then
    if (new.folio, new.fecha, new.tramo_id, new.origen, new.destino, new.km, new.km_fuente,
        new.precio, new.costeo_diesel_usd, new.costeo_pago_chofer, new.costeo_total,
        new.tipo_cambio_usado, new.viaticos_entregados, new.notas,
        new.chofer_actual_id, new.camion_actual_id, new.caja_actual_id, new.operador_provisional,
        new.nomina_id, new.cobranza_fecha_factura, new.cobranza_fecha_vence, new.cobranza_factura_path,
        new.cobranza_xml_path, new.cobranza_pagado, new.cobranza_comprobante_path, new.cobranza_pagado_at,
        new.created_at)
       is distinct from
       (old.folio, old.fecha, old.tramo_id, old.origen, old.destino, old.km, old.km_fuente,
        old.precio, old.costeo_diesel_usd, old.costeo_pago_chofer, old.costeo_total,
        old.tipo_cambio_usado, old.viaticos_entregados, old.notas,
        old.chofer_actual_id, old.camion_actual_id, old.caja_actual_id, old.operador_provisional,
        old.nomina_id, old.cobranza_fecha_factura, old.cobranza_fecha_vence, old.cobranza_factura_path,
        old.cobranza_xml_path, old.cobranza_pagado, old.cobranza_comprobante_path, old.cobranza_pagado_at,
        old.created_at)
    then
      raise exception 'El chofer solo puede actualizar iniciado_en, estatus, terminado_at y viaticos_comprobados'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$function$;

create or replace trigger t_perfiles_guarda_rol before update on public.perfiles
  for each row execute function public.trg_perfiles_guarda_rol();
create or replace trigger t_unidades_guarda_chofer before update on public.unidades
  for each row execute function public.trg_unidades_guarda_chofer();
create or replace trigger t_cargas_guarda_chofer before update on public.viaje_cargas
  for each row execute function public.trg_cargas_guarda_chofer();
create or replace trigger t_entregas_guarda_chofer before update on public.viaje_entregas
  for each row execute function public.trg_entregas_guarda_chofer();
create or replace trigger t_sync_custodia_viaje after insert or update on public.viaje_movimientos
  for each row execute function public.trg_sync_custodia_viaje();
create or replace trigger t_viaje_no_terminar_con_pendientes before update on public.viajes
  for each row execute function public.trg_viaje_no_terminar_con_pendientes();
create or replace trigger t_viajes_guarda_chofer before update on public.viajes
  for each row execute function public.trg_viajes_guarda_chofer();

-- ===== RPCs de negocio (ya existían en producción) =====
create or replace function public.crear_corte_nomina(p_periodo_del date, p_periodo_al date, p_periodo_tipo periodo_nomina, p_detalles jsonb)
 returns uuid
 language plpgsql
as $function$
declare
  v_nomina_id uuid;
  v_detalle jsonb;
  v_detalle_id uuid;
  v_viaje jsonb;
  v_viaje_id uuid;
  v_total numeric := 0;
  v_num_empleados int := 0;
begin
  for v_detalle in select * from jsonb_array_elements(p_detalles) loop
    for v_viaje in select * from jsonb_array_elements(coalesce(v_detalle->'viajes', '[]'::jsonb)) loop
      v_viaje_id := (v_viaje->>'viaje_id')::uuid;
      if (select estatus from viajes where id = v_viaje_id) <> 'terminado' then
        raise exception 'El viaje % ya no está disponible para conciliar', v_viaje->>'folio_snapshot';
      end if;
    end loop;
    v_total := v_total + (v_detalle->>'total')::numeric;
    v_num_empleados := v_num_empleados + 1;
  end loop;

  insert into nominas (periodo_del, periodo_al, periodo_tipo, estatus, num_empleados, total_general)
  values (p_periodo_del, p_periodo_al, p_periodo_tipo, 'calculada', v_num_empleados, v_total)
  returning id into v_nomina_id;

  for v_detalle in select * from jsonb_array_elements(p_detalles) loop
    insert into nomina_detalles (
      nomina_id, tipo, operador_id, empleado_id, nombre_snapshot, num_wos,
      sueldo_base, bonos, percepciones, descuento_viaticos, total
    ) values (
      v_nomina_id, (v_detalle->>'tipo')::tipo_nomina_persona,
      nullif(v_detalle->>'operador_id', '')::uuid, nullif(v_detalle->>'empleado_id', '')::uuid,
      v_detalle->>'nombre_snapshot', coalesce((v_detalle->>'num_wos')::smallint, 0),
      coalesce((v_detalle->>'sueldo_base')::numeric, 0), coalesce((v_detalle->>'bonos')::numeric, 0),
      (v_detalle->>'percepciones')::numeric, coalesce((v_detalle->>'descuento_viaticos')::numeric, 0),
      (v_detalle->>'total')::numeric
    ) returning id into v_detalle_id;

    for v_viaje in select * from jsonb_array_elements(coalesce(v_detalle->'viajes', '[]'::jsonb)) loop
      v_viaje_id := (v_viaje->>'viaje_id')::uuid;
      insert into nomina_detalle_viajes (detalle_id, viaje_id, folio_snapshot, pago, viaticos_entregados, viaticos_comprobados)
      values (
        v_detalle_id, v_viaje_id, v_viaje->>'folio_snapshot',
        (v_viaje->>'pago')::numeric, coalesce((v_viaje->>'viaticos_entregados')::numeric, 0),
        coalesce((v_viaje->>'viaticos_comprobados')::numeric, 0)
      );
      update viajes set estatus = 'conciliado', nomina_id = v_nomina_id where id = v_viaje_id;
    end loop;
  end loop;

  return v_nomina_id;
end;
$function$;

create or replace function public.crear_viaje(p_fecha date, p_tramo_id uuid, p_origen text, p_destino text, p_km numeric, p_precio numeric, p_costeo_diesel_usd numeric, p_costeo_pago_chofer numeric, p_costeo_total numeric, p_tipo_cambio_usado numeric, p_viaticos_entregados numeric, p_notas text, p_chofer_id uuid, p_camion_id uuid, p_caja_id uuid, p_odometro_inicio numeric, p_operador_provisional boolean, p_entregas jsonb, p_cargas jsonb default '[]'::jsonb)
 returns uuid
 language plpgsql
as $function$
declare
  v_viaje_id uuid;
  v_entrega jsonb;
  v_carga jsonb;
  v_orden smallint := 0;
begin
  insert into viajes (
    fecha, tramo_id, origen, destino, km, precio,
    costeo_diesel_usd, costeo_pago_chofer, costeo_total, tipo_cambio_usado,
    viaticos_entregados, notas, estatus,
    chofer_actual_id, camion_actual_id, caja_actual_id, operador_provisional
  ) values (
    p_fecha, p_tramo_id, p_origen, p_destino, p_km, p_precio,
    p_costeo_diesel_usd, p_costeo_pago_chofer, p_costeo_total, p_tipo_cambio_usado,
    p_viaticos_entregados, p_notas, 'en_proceso',
    p_chofer_id, p_camion_id, p_caja_id, p_operador_provisional
  ) returning id into v_viaje_id;

  insert into viaje_movimientos (viaje_id, chofer_id, camion_id, caja_id, odometro_inicio, activo)
  values (v_viaje_id, p_chofer_id, p_camion_id, p_caja_id, p_odometro_inicio, true);

  if p_odometro_inicio is not null then
    update unidades set ultima_lectura = greatest(coalesce(ultima_lectura, 0), p_odometro_inicio)
      where id = p_camion_id;
  end if;

  v_orden := 0;
  for v_entrega in select * from jsonb_array_elements(p_entregas) loop
    v_orden := v_orden + 1;
    insert into viaje_entregas (viaje_id, cliente_id, direccion_id, direccion_snapshot, mercancia, orden_secuencia)
    values (
      v_viaje_id,
      (v_entrega->>'cliente_id')::uuid,
      nullif(v_entrega->>'direccion_id', '')::uuid,
      v_entrega->>'direccion_snapshot',
      v_entrega->>'mercancia',
      v_orden
    );
  end loop;

  v_orden := 0;
  for v_carga in select * from jsonb_array_elements(p_cargas) loop
    v_orden := v_orden + 1;
    insert into viaje_cargas (viaje_id, cliente_id, direccion_id, direccion_snapshot, mercancia, orden_secuencia)
    values (
      v_viaje_id,
      (v_carga->>'cliente_id')::uuid,
      nullif(v_carga->>'direccion_id', '')::uuid,
      v_carga->>'direccion_snapshot',
      v_carga->>'mercancia',
      v_orden
    );
  end loop;

  return v_viaje_id;
end;
$function$;

create or replace function public.guardar_work_order(p_wo_id uuid, p_fecha date, p_unidad_id uuid, p_lectura_valor numeric, p_lectura_unidad unidad_de_lectura, p_chofer_texto text, p_mecanico_texto text, p_tipo_falla text[], p_diagnostico text, p_piezas_requeridas text[], p_notas_mecanico text, p_tipo_servicio tipo_servicio_wo, p_completar boolean, p_creado_por uuid, p_llantas_activas boolean, p_llanta_accion accion_llanta, p_llanta_posiciones text[], p_llanta_km_evento numeric, p_llanta_notas text, p_origen_mantenimiento_programado boolean default false)
 returns uuid
 language plpgsql
as $function$
declare
  v_wo_id uuid;
begin
  if p_completar and p_tipo_servicio = 'preventivo' and (p_lectura_valor is null or p_lectura_unidad is null) then
    raise exception 'Para completar un servicio preventivo hace falta el kilometraje/millaje/horómetro de la WO';
  end if;

  if p_wo_id is null then
    insert into work_orders (
      fecha, unidad_id, lectura_valor, lectura_unidad, chofer_texto, mecanico_texto,
      tipo_falla, diagnostico, piezas_requeridas, notas_mecanico, tipo_servicio,
      estatus, completado_at, creado_por, origen_mantenimiento_programado
    ) values (
      p_fecha, p_unidad_id, p_lectura_valor, p_lectura_unidad, p_chofer_texto, p_mecanico_texto,
      p_tipo_falla, p_diagnostico, p_piezas_requeridas, p_notas_mecanico, p_tipo_servicio,
      case when p_completar then 'completado'::estatus_wo else 'en_proceso'::estatus_wo end,
      case when p_completar then now() else null end,
      p_creado_por, p_origen_mantenimiento_programado
    ) returning id into v_wo_id;
  else
    update work_orders set
      fecha = p_fecha, unidad_id = p_unidad_id, lectura_valor = p_lectura_valor, lectura_unidad = p_lectura_unidad,
      chofer_texto = p_chofer_texto, mecanico_texto = p_mecanico_texto, tipo_falla = p_tipo_falla,
      diagnostico = p_diagnostico, piezas_requeridas = p_piezas_requeridas, notas_mecanico = p_notas_mecanico,
      tipo_servicio = p_tipo_servicio,
      estatus = case when p_completar then 'completado'::estatus_wo else 'en_proceso'::estatus_wo end,
      completado_at = case when p_completar then now() else completado_at end
    where id = p_wo_id
    returning id into v_wo_id;
  end if;

  if p_llantas_activas then
    insert into wo_llantas (work_order_id, unidad_id, accion, posiciones, km_evento, notas)
    values (v_wo_id, p_unidad_id, p_llanta_accion, p_llanta_posiciones, p_llanta_km_evento, p_llanta_notas)
    on conflict (work_order_id) do update set
      unidad_id = excluded.unidad_id, accion = excluded.accion, posiciones = excluded.posiciones,
      km_evento = excluded.km_evento, notas = excluded.notas;
  else
    delete from wo_llantas where work_order_id = v_wo_id;
  end if;

  -- 'km' (ya homologado desde mi en el cliente) y 'hrs' (horómetro/termo, no se homologa) se
  -- consolidan igual -- 'mi' nunca debería llegar aquí (el cliente siempre homologa antes de llamar)
  if p_lectura_valor is not null and p_lectura_unidad in ('km', 'hrs') then
    update unidades set ultima_lectura = greatest(coalesce(ultima_lectura, 0), p_lectura_valor)
      where id = p_unidad_id;
  end if;

  if p_completar and p_origen_mantenimiento_programado then
    insert into mantenimiento_preventivo (unidad_id, km_realizado, fecha_realizado, registrado_por, wo_id, notas)
    values (p_unidad_id, p_lectura_valor, p_fecha, auth.uid(), v_wo_id, p_notas_mecanico);

    update unidades set ultimo_mantenimiento_valor = p_lectura_valor where id = p_unidad_id;
  end if;

  return v_wo_id;
end;
$function$;

create or replace function public.registrar_cambio_custodia(p_viaje_id uuid, p_chofer_id uuid, p_camion_id uuid, p_caja_id uuid, p_odometro_cierre numeric, p_odometro_inicio_nuevo numeric, p_motivo text)
 returns uuid
 language plpgsql
as $function$
declare
  v_mov_activo viaje_movimientos%rowtype;
  v_nuevo_id uuid;
  v_mismo_camion boolean;
begin
  select * into v_mov_activo from viaje_movimientos where viaje_id = p_viaje_id and activo = true limit 1;
  if not found then raise exception 'No hay movimiento activo para este viaje'; end if;
  if (select estatus from viajes where id = p_viaje_id) <> 'en_proceso' then
    raise exception 'El viaje ya no está en proceso';
  end if;

  v_mismo_camion := (p_camion_id = v_mov_activo.camion_id);

  update viaje_movimientos set fecha_hora_fin = now(), odometro_fin = p_odometro_cierre, activo = false
    where id = v_mov_activo.id;

  if p_odometro_cierre is not null then
    update unidades set ultima_lectura = greatest(coalesce(ultima_lectura, 0), p_odometro_cierre)
      where id = v_mov_activo.camion_id;
  end if;

  insert into viaje_movimientos (viaje_id, chofer_id, camion_id, caja_id, odometro_inicio, motivo_cambio, movimiento_anterior_id, activo)
  values (
    p_viaje_id, p_chofer_id, p_camion_id, p_caja_id,
    case when v_mismo_camion then p_odometro_cierre else p_odometro_inicio_nuevo end,
    p_motivo, v_mov_activo.id, true
  ) returning id into v_nuevo_id;

  if not v_mismo_camion and p_odometro_inicio_nuevo is not null then
    update unidades set ultima_lectura = greatest(coalesce(ultima_lectura, 0), p_odometro_inicio_nuevo)
      where id = p_camion_id;
  end if;

  update viajes set chofer_actual_id = p_chofer_id, camion_actual_id = p_camion_id, caja_actual_id = p_caja_id
    where id = p_viaje_id;

  return v_nuevo_id;
end;
$function$;

create or replace function public.registrar_carga_diesel(p_unidad_id uuid, p_estacion text, p_litros numeric, p_costo_litro numeric, p_odometro numeric, p_viaje_id uuid, p_caja_id uuid, p_horas_termo numeric, p_litros_caja numeric, p_notas text, p_operador_id uuid, p_estacion_id uuid default null::uuid)
 returns uuid
 language plpgsql
as $function$
declare
  v_ultima numeric;
  v_unidad_numero text;
  v_rendimiento numeric;
  v_previos numeric[];
  v_mediana numeric;
  v_atipico boolean := false;
  v_movimiento_id uuid;
  v_carga_id uuid;
begin
  select ultima_lectura, numero into v_ultima, v_unidad_numero from unidades where id = p_unidad_id;

  if v_ultima is not null and p_odometro > v_ultima then
    v_rendimiento := round((p_odometro - v_ultima) / p_litros, 2);
  end if;

  select array_agg(rendimiento) into v_previos from (
    select rendimiento from cargas_diesel
    where unidad_id = p_unidad_id and rendimiento is not null and not es_atipico
    order by fecha desc, created_at desc limit 5
  ) s;

  if v_rendimiento is not null and coalesce(array_length(v_previos, 1), 0) >= 3 then
    select percentile_cont(0.5) within group (order by x) into v_mediana from unnest(v_previos) as x;
    if v_mediana > 0 and abs(v_rendimiento - v_mediana) / v_mediana > 0.25 then
      v_atipico := true;
    end if;
  end if;

  if p_viaje_id is not null then
    select id into v_movimiento_id from viaje_movimientos
    where viaje_id = p_viaje_id and activo = true limit 1;
  end if;

  insert into cargas_diesel (
    unidad_id, estacion, estacion_id, litros, costo_litro, odometro, rendimiento, es_atipico,
    viaje_id, movimiento_id, caja_id, caja_horas_termo, caja_litros, caja_costo,
    notas, operador_id
  ) values (
    p_unidad_id, p_estacion, p_estacion_id, p_litros, p_costo_litro, p_odometro, v_rendimiento, v_atipico,
    p_viaje_id, v_movimiento_id, p_caja_id, p_horas_termo, p_litros_caja,
    case when p_caja_id is not null then round(p_litros_caja * p_costo_litro, 2) else null end,
    p_notas, p_operador_id
  ) returning id into v_carga_id;

  update unidades set ultima_lectura = greatest(coalesce(ultima_lectura, 0), p_odometro) where id = p_unidad_id;

  if p_caja_id is not null and p_horas_termo is not null then
    update unidades set ultima_lectura = greatest(coalesce(ultima_lectura, 0), p_horas_termo)
      where id = p_caja_id;
  end if;

  if v_atipico then
    insert into reportes_falla (unidad_id, descripcion, operador_id, automatico)
    values (
      p_unidad_id,
      format('Posible falla mecánica o error de captura en unidad %s: rendimiento %s km/L vs mediana %s km/L. Alerta generada automáticamente al registrar diésel.',
        v_unidad_numero, v_rendimiento, v_mediana),
      p_operador_id, true
    );
  end if;

  return v_carga_id;
end;
$function$;

-- overloads viejos, sin llamadas en el frontend actual (evolucionaron a las firmas de arriba)
drop function if exists public.crear_viaje(date, uuid, text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, text, uuid, uuid, uuid, numeric, boolean, jsonb);
drop function if exists public.guardar_work_order(uuid, date, uuid, numeric, unidad_de_lectura, text, text, text[], text, text[], text, tipo_servicio_wo, boolean, uuid, boolean, accion_llanta, text[], numeric, text);
drop function if exists public.registrar_carga_diesel(uuid, text, numeric, numeric, numeric, uuid, uuid, numeric, numeric, text, uuid);
