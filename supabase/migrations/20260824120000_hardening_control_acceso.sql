-- Auditoría de seguridad (Punto 1: control de acceso / IDOR), 2026-08-24.
-- 3 huecos reales encontrados en RLS: el rol solo no bastaba, faltaba validar dueño/columna.

-- ============================================================================
-- A) unidades: el UPDATE solo validaba rol, no permitía tocar una unidad dada
--    de baja. Un chofer necesita poder capturar diésel/odómetro en cualquier
--    unidad activa de la flota (confirmado: no siempre trae la suya asignada),
--    así que no se restringe A CUÁL unidad puede escribir -- solo se bloquea
--    tocar unidades con activo=false, y se corrige que registrar_carga_diesel
--    pudiera hacer retroceder el odómetro (no usaba GREATEST como el resto).
-- ============================================================================
drop policy if exists unidades_update on public.unidades;
create policy unidades_update on public.unidades for update
  using (
    auth_es(array['dispatch','taller']::rol_usuario[])
    or (auth_rol() = 'chofer' and activo = true)
  )
  with check (
    auth_es(array['dispatch','taller']::rol_usuario[])
    or (auth_rol() = 'chofer' and activo = true)
  );

create or replace function public.registrar_carga_diesel(
  p_unidad_id uuid, p_estacion text, p_litros numeric, p_costo_litro numeric,
  p_odometro numeric, p_viaje_id uuid, p_caja_id uuid, p_horas_termo numeric,
  p_litros_caja numeric, p_notas text, p_operador_id uuid, p_estacion_id uuid default null
)
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

  -- antes: "set ultima_lectura = p_odometro" a secas -- un valor bajo (mal capturado o
  -- manipulado) podía hacer retroceder el odómetro. Mismo GREATEST que usa el resto del código.
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

-- ============================================================================
-- B) viajes / viaje_cargas: el UPDATE de RLS solo validaba dueño de la fila
--    (chofer_actual_id = auth_operador_id()), no qué columnas podía tocar --
--    a diferencia de viaje_entregas, que ya tenía este guardado
--    (trg_entregas_guarda_chofer). Un chofer podía, con su propio JWT, reescribir
--    precio/costeo/viáticos de su propio viaje via API directa, sin pasar por la UI.
-- ============================================================================
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

drop trigger if exists t_viajes_guarda_chofer on public.viajes;
create trigger t_viajes_guarda_chofer
  before update on public.viajes
  for each row execute function public.trg_viajes_guarda_chofer();

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

drop trigger if exists t_cargas_guarda_chofer on public.viaje_cargas;
create trigger t_cargas_guarda_chofer
  before update on public.viaje_cargas
  for each row execute function public.trg_cargas_guarda_chofer();

-- ============================================================================
-- C) Storage 'adjuntos': la lectura de viajes/* y compras/* solo validaba
--    "está logueado" (auth_rol() is not null), sin importar rol ni dueño --
--    cualquier chofer podía leer el POD de otro chofer, o facturas de compras
--    (rol al que ni siquiera tiene acceso por tabla), si conocía la ruta.
--    También se acota el INSERT de POD a que solo se pueda subir dentro de la
--    carpeta del propio viaje del chofer (antes solo validaba el prefijo
--    "pod_" del nombre de archivo, no la carpeta).
-- ============================================================================
drop policy if exists adjuntos_viajes_lectura on storage.objects;
create policy adjuntos_viajes_lectura on storage.objects for select
  using (
    bucket_id = 'adjuntos'
    and (storage.foldername(name))[1] = 'viajes'
    and (
      auth_es(array['dispatch','admin']::rol_usuario[])
      or (
        auth_rol() = 'chofer'
        and (storage.foldername(name))[2] in (
          select id::text from viajes where chofer_actual_id = auth_operador_id()
        )
      )
    )
  );

drop policy if exists adjuntos_viajes_insert_pod on storage.objects;
create policy adjuntos_viajes_insert_pod on storage.objects for insert
  with check (
    bucket_id = 'adjuntos'
    and (storage.foldername(name))[1] = 'viajes'
    and left(storage.filename(name), 4) = 'pod_'
    and auth_es(array['chofer']::rol_usuario[])
    and (storage.foldername(name))[2] in (
      select id::text from viajes where chofer_actual_id = auth_operador_id()
    )
  );

drop policy if exists adjuntos_compras_lectura on storage.objects;
create policy adjuntos_compras_lectura on storage.objects for select
  using (
    bucket_id = 'adjuntos'
    and (storage.foldername(name))[1] = 'compras'
    and auth_es(array['compras','admin']::rol_usuario[])
  );
