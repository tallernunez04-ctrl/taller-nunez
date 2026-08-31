-- terminar_viaje ahora calcula el costeo real (diésel + pago chofer) al cerrar el viaje,
-- usando el km real recorrido (v_viaje_kilometraje, ya con el odómetro final recién capturado)
-- y la mediana de rendimiento/precio por litro de la unidad (v_rendimiento_unidades). Antes este
-- cálculo vivía en el frontend y se recalculaba (y sobrescribía) cada vez que alguien guardaba
-- una edición del viaje, incluso mucho después de cerrado -- ahora se fija una sola vez, al cierre.
create or replace function public.terminar_viaje(p_viaje_id uuid, p_odometro_fin numeric, p_viaticos_comprobados numeric)
 returns void
 language plpgsql
as $function$
declare
  v_pendientes int;
  v_mov_id uuid;
  v_camion_id uuid;
  v_tramo_id uuid;
  v_km numeric;
  v_rendimiento numeric;
  v_precio_litro numeric;
  v_tc numeric;
  v_pago_chofer numeric;
  v_diesel_mxn numeric;
  v_diesel_usd numeric;
begin
  if (select estatus from viajes where id = p_viaje_id) <> 'en_proceso' then
    raise exception 'El viaje ya no está en proceso';
  end if;
  select count(*) into v_pendientes from viaje_entregas where viaje_id = p_viaje_id and estatus = 'pendiente';
  if v_pendientes > 0 then
    raise exception 'Hay % entrega(s) pendiente(s) -- no se puede terminar', v_pendientes;
  end if;

  select id into v_mov_id from viaje_movimientos where viaje_id = p_viaje_id and activo = true limit 1;
  if v_mov_id is not null then
    update viaje_movimientos set fecha_hora_fin = now(), odometro_fin = p_odometro_fin, activo = false where id = v_mov_id;

    if p_odometro_fin is not null then
      update unidades u set ultima_lectura = greatest(coalesce(u.ultima_lectura, 0), p_odometro_fin)
        from viaje_movimientos vm where vm.id = v_mov_id and u.id = vm.camion_id;
    end if;
  end if;

  select camion_actual_id, tramo_id into v_camion_id, v_tramo_id from viajes where id = p_viaje_id;
  select coalesce(km_totales, 0) into v_km from v_viaje_kilometraje where viaje_id = p_viaje_id;
  select rendimiento_mediana, precio_litro_mediana into v_rendimiento, v_precio_litro
    from v_rendimiento_unidades where unidad_id = v_camion_id;
  select tipo_cambio_usd into v_tc from config where id = true;
  select pago_chofer into v_pago_chofer from tabuladores where id = v_tramo_id;
  v_pago_chofer := coalesce(v_pago_chofer, 0);

  v_diesel_mxn := case when coalesce(v_rendimiento, 0) > 0
    then round((coalesce(v_km, 0) / v_rendimiento) * coalesce(v_precio_litro, 0), 2)
    else 0 end;
  v_diesel_usd := case when coalesce(v_tc, 0) > 0 then round(v_diesel_mxn / v_tc, 2) else 0 end;

  update viajes set estatus = 'terminado', terminado_at = now(),
    viaticos_comprobados = coalesce(p_viaticos_comprobados, viaticos_comprobados),
    costeo_diesel_usd = v_diesel_usd,
    costeo_pago_chofer = v_pago_chofer,
    costeo_total = round(v_diesel_usd + v_pago_chofer, 2),
    tipo_cambio_usado = coalesce(v_tc, tipo_cambio_usado)
  where id = p_viaje_id;
end;
$function$;
