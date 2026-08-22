-- La migración mantenimiento_preventivo_fase1 (20260818232442) renombró
-- unidades.ultimo_mantenimiento_km -> ultimo_mantenimiento_valor, pero no actualizó este
-- trigger. Cualquier UPDATE a unidades hecho por un chofer (terminar_viaje, iniciarViaje,
-- registrar_carga_diesel) revienta con "record new has no field ultimo_mantenimiento_km"
-- porque la columna ya no existe -- deja viajes atorados en "en_proceso" y cargas de diésel
-- sin registrar.
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
