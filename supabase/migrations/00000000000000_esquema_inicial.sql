-- =====================================================================
-- Taller Núñez — Migración inicial (esquema reconstruido desde producción)
-- Generado a partir de introspección de information_schema / pg_catalog
-- Fecha de captura: 2026-08-06
-- =====================================================================
-- NOTA: Este archivo reconstruye el DDL ya aplicado en Supabase (producción).
-- No lo corras contra la base remota (ya existe). Sirve para dejar el
-- esquema versionado en supabase/migrations/ vía:
--   npx supabase migration repair --status applied 00000000000000
-- (ver instrucciones al final de la conversación en Claude Chat)
-- =====================================================================

-- ---------------------------------------------------------------------
-- EXTENSIONES
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------
create type public.estatus_entrega as enum ('pendiente','entregada');
create type public.estatus_nomina as enum ('calculada','aprobada','pagada');
create type public.estatus_reporte as enum ('abierto','atendido');
create type public.estatus_viaje as enum ('en_proceso','terminado','conciliado');
create type public.estatus_wo as enum ('en_proceso','completado');
create type public.metodo_pago as enum ('efectivo','tarjeta','transferencia','credito_proveedor');
create type public.moneda as enum ('MXN','USD');
create type public.periodo_nomina as enum ('semanal','quincenal');
create type public.rol_usuario as enum ('chofer','taller','compras','admin');
create type public.tipo_empleado as enum ('mecanico','administrativo');
create type public.tipo_nomina_persona as enum ('chofer','mecanico','administrativo');
create type public.tipo_pago as enum ('credito','contado');
create type public.tipo_unidad as enum ('truck','reefer','plataforma','caja_seca');
create type public.unidad_de_lectura as enum ('mi','km','hrs');

-- ---------------------------------------------------------------------
-- SECUENCIAS (folios)
-- ---------------------------------------------------------------------
create sequence if not exists public.seq_folio_po;
create sequence if not exists public.seq_folio_viaje;
create sequence if not exists public.seq_folio_wo;

-- ---------------------------------------------------------------------
-- TABLAS
-- ---------------------------------------------------------------------

-- perfiles (extiende auth.users)
create table public.perfiles (
  id         uuid primary key references auth.users(id),
  email      text not null unique,
  nombre     text not null,
  rol        rol_usuario not null default 'chofer',
  activo     boolean not null default true,
  oculto     boolean not null default false,
  created_at timestamptz not null default now()
);

-- clientes
create table public.clientes (
  id            uuid primary key default gen_random_uuid(),
  razon_social  text not null,
  contacto      text,
  rfc           text,
  telefono      text,
  correo        text,
  dias_credito  smallint not null default 0,
  activo        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- cliente_direcciones
create table public.cliente_direcciones (
  id         uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id),
  calle      text,
  ciudad     text,
  estado     text,
  pais       text,
  cp         text,
  activo     boolean not null default true
);

-- proveedores
create table public.proveedores (
  id            uuid primary key default gen_random_uuid(),
  razon_social  text not null,
  rfc           text,
  dias_credito  smallint not null default 0,
  banco_nombre  text,
  banco_clabe   text,
  banco_cuenta  text,
  activo        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- unidades
create table public.unidades (
  id                       uuid primary key default gen_random_uuid(),
  numero                   text not null unique,
  tipo                     tipo_unidad not null,
  unidad_lectura           unidad_de_lectura not null default 'mi',
  marca                    text,
  modelo                   text,
  vin                      text,
  anio                     smallint,
  ultima_lectura           numeric,
  mantenimiento_cada_x     numeric,
  ultimo_mantenimiento_km  numeric,
  activo                   boolean not null default true,
  created_at               timestamptz not null default now()
);

-- operadores
create table public.operadores (
  id                  uuid primary key default gen_random_uuid(),
  perfil_id           uuid unique references public.perfiles(id),
  nombre              text not null,
  telefono            text,
  direccion           text,
  rfc                 text,
  curp                text,
  email               text,
  licencia_numero     text,
  licencia_vence      date,
  visa_numero         text,
  visa_vence          date,
  apto_medico_fecha   date,
  unidad_base_id      uuid references public.unidades(id),
  activo              boolean not null default true,
  created_at          timestamptz not null default now()
);

-- operador_contactos_emergencia
create table public.operador_contactos_emergencia (
  id           uuid primary key default gen_random_uuid(),
  operador_id  uuid not null references public.operadores(id),
  nombre       text not null,
  relacion     text,
  telefono     text
);

-- empleados
create table public.empleados (
  id              uuid primary key default gen_random_uuid(),
  perfil_id       uuid unique references public.perfiles(id),
  nombre          text not null,
  tipo            tipo_empleado not null,
  email           text,
  sueldo_semanal  numeric not null default 0,
  bono_por_wo     numeric not null default 0,
  activo          boolean not null default true,
  created_at      timestamptz not null default now()
);

-- tabuladores
create table public.tabuladores (
  id           uuid primary key default gen_random_uuid(),
  origen       text not null,
  destino      text not null,
  pago_chofer  numeric not null,
  km           numeric,
  vigente      boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (origen, destino, vigente)
);

-- config (singleton: id boolean, siempre true)
create table public.config (
  id                    boolean primary key default true,
  tipo_cambio_usd       numeric not null,
  precio_diesel_litro   numeric not null,
  updated_at            timestamptz not null default now()
);

-- work_orders
create table public.work_orders (
  id                 uuid primary key default gen_random_uuid(),
  folio              text not null unique default ('WO-' || lpad(nextval('public.seq_folio_wo')::text, 4, '0')),
  fecha              date not null default current_date,
  unidad_id          uuid not null references public.unidades(id),
  lectura_valor      numeric,
  lectura_unidad     unidad_de_lectura,
  chofer_texto       text,
  mecanico_texto     text,
  tipo_falla         text[] not null default '{}',
  diagnostico        text,
  notas_mecanico     text,
  piezas_requeridas  text[] not null default '{}',
  estatus            estatus_wo not null default 'en_proceso',
  creado_por         uuid references public.perfiles(id),
  created_at         timestamptz not null default now(),
  completado_at      timestamptz
);

-- compras
create table public.compras (
  id                       uuid primary key default gen_random_uuid(),
  folio                    text not null unique default ('PO-' || lpad(nextval('public.seq_folio_po')::text, 4, '0')),
  fecha                    date not null default current_date,
  wo_id                    uuid references public.work_orders(id),
  unidad_id                uuid references public.unidades(id),
  es_general               boolean not null default false,
  proveedor_id             uuid not null references public.proveedores(id),
  moneda                   moneda not null default 'MXN',
  folio_factura            text,
  subtotal                 numeric not null default 0,
  iva                      numeric not null default 0,
  total                    numeric not null default 0,
  total_usd                numeric not null default 0,
  tipo_cambio_usado        numeric not null,
  metodo_pago              metodo_pago not null,
  tipo_pago                tipo_pago,
  fecha_vence              date,
  pagado                   boolean not null default false,
  pagado_at                date,
  comprobante_pago_path    text,
  factura_path             text,
  xml_path                 text,
  es_diesel                boolean not null default false,
  litros_facturados        numeric,
  notas                    text,
  creado_por               uuid references public.perfiles(id),
  created_at               timestamptz not null default now()
);

-- compra_conceptos
create table public.compra_conceptos (
  id              uuid primary key default gen_random_uuid(),
  compra_id       uuid not null references public.compras(id),
  concepto        text not null,
  cantidad        numeric not null default 1,
  costo_unitario  numeric not null default 0,
  tasa_iva        numeric not null default 0.16,
  subtotal        numeric,
  iva             numeric,
  total           numeric
);

-- reportes_falla
create table public.reportes_falla (
  id            uuid primary key default gen_random_uuid(),
  fecha         date not null default current_date,
  unidad_id     uuid not null references public.unidades(id),
  descripcion   text not null,
  estatus       estatus_reporte not null default 'abierto',
  operador_id   uuid references public.operadores(id),
  automatico    boolean not null default false,
  created_at    timestamptz not null default now(),
  atendido_at   timestamptz
);

-- nominas
create table public.nominas (
  id              uuid primary key default gen_random_uuid(),
  periodo_del     date not null,
  periodo_al      date not null,
  periodo_tipo    periodo_nomina not null,
  estatus         estatus_nomina not null default 'calculada',
  num_empleados   smallint not null default 0,
  total_general   numeric not null default 0,
  pagada_at       date,
  created_at      timestamptz not null default now()
);

-- viajes
create table public.viajes (
  id                          uuid primary key default gen_random_uuid(),
  folio                       text not null unique default ('V-' || lpad(nextval('public.seq_folio_viaje')::text, 4, '0')),
  fecha                       date not null default current_date,
  tramo_id                    uuid references public.tabuladores(id),
  origen                      text not null,
  destino                     text not null,
  km                          numeric,
  km_fuente                   text not null default 'manual',
  precio                      numeric not null default 0,
  costeo_diesel_usd           numeric,
  costeo_pago_chofer          numeric,
  costeo_total                numeric,
  tipo_cambio_usado           numeric,
  viaticos_entregados         numeric not null default 0,
  viaticos_comprobados        numeric not null default 0,
  notas                       text,
  estatus                     estatus_viaje not null default 'en_proceso',
  chofer_actual_id            uuid references public.operadores(id),
  camion_actual_id            uuid references public.unidades(id),
  caja_actual_id              uuid references public.unidades(id),
  operador_provisional        boolean not null default false,
  terminado_at                timestamptz,
  nomina_id                   uuid references public.nominas(id),
  cobranza_fecha_factura      date,
  cobranza_fecha_vence        date,
  cobranza_factura_path       text,
  cobranza_xml_path           text,
  cobranza_pagado             boolean not null default false,
  cobranza_comprobante_path   text,
  cobranza_pagado_at          date,
  created_at                  timestamptz not null default now()
);

-- viaje_movimientos
create table public.viaje_movimientos (
  id                       uuid primary key default gen_random_uuid(),
  viaje_id                 uuid not null references public.viajes(id),
  chofer_id                uuid not null references public.operadores(id),
  camion_id                uuid not null references public.unidades(id),
  caja_id                  uuid references public.unidades(id),
  fecha_hora_inicio        timestamptz not null default now(),
  fecha_hora_fin           timestamptz,
  odometro_inicio          numeric,
  odometro_fin             numeric,
  km_recorridos            numeric,
  motivo_cambio            text,
  movimiento_anterior_id   uuid references public.viaje_movimientos(id),
  activo                   boolean not null default true
);

-- viaje_entregas
create table public.viaje_entregas (
  id                         uuid primary key default gen_random_uuid(),
  viaje_id                   uuid not null references public.viajes(id),
  cliente_id                 uuid not null references public.clientes(id),
  direccion_id               uuid references public.cliente_direcciones(id),
  direccion_snapshot         text,
  mercancia                  text,
  orden_secuencia            smallint not null default 1,
  estatus                    estatus_entrega not null default 'pendiente',
  fecha_hora_entrega_real    timestamptz,
  evidencia_path             text
);

-- cargas_diesel
create table public.cargas_diesel (
  id                 uuid primary key default gen_random_uuid(),
  fecha              date not null default current_date,
  unidad_id          uuid not null references public.unidades(id),
  estacion           text,
  litros             numeric not null,
  costo_litro        numeric not null,
  costo_total        numeric,
  odometro           numeric not null,
  rendimiento        numeric,
  es_atipico         boolean not null default false,
  viaje_id           uuid references public.viajes(id),
  movimiento_id      uuid references public.viaje_movimientos(id),
  caja_id            uuid references public.unidades(id),
  caja_horas_termo   numeric,
  caja_litros        numeric,
  caja_costo         numeric,
  notas              text,
  operador_id        uuid references public.operadores(id),
  created_at         timestamptz not null default now()
);

-- nomina_detalles
create table public.nomina_detalles (
  id                    uuid primary key default gen_random_uuid(),
  nomina_id             uuid not null references public.nominas(id),
  tipo                  tipo_nomina_persona not null,
  operador_id           uuid references public.operadores(id),
  empleado_id           uuid references public.empleados(id),
  nombre_snapshot       text not null,
  num_wos               smallint not null default 0,
  sueldo_base           numeric not null default 0,
  bonos                 numeric not null default 0,
  percepciones          numeric not null default 0,
  descuento_viaticos    numeric not null default 0,
  total                 numeric not null default 0,
  comprobante_path      text
);

-- nomina_detalle_viajes
create table public.nomina_detalle_viajes (
  id                     uuid primary key default gen_random_uuid(),
  detalle_id             uuid not null references public.nomina_detalles(id),
  viaje_id               uuid references public.viajes(id),
  folio_snapshot         text not null,
  pago                   numeric not null default 0,
  viaticos_entregados    numeric not null default 0,
  viaticos_comprobados   numeric not null default 0
);

-- ---------------------------------------------------------------------
-- ÍNDICES (además de los generados automáticamente por PK / UNIQUE)
-- ---------------------------------------------------------------------
create index idx_diesel_operador on public.cargas_diesel using btree (operador_id);
create index idx_diesel_unidad on public.cargas_diesel using btree (unidad_id, fecha desc);
create index idx_diesel_viaje on public.cargas_diesel using btree (viaje_id);

create index idx_conceptos_compra on public.compra_conceptos using btree (compra_id);

create index idx_compras_fecha on public.compras using btree (fecha desc);
create index idx_compras_por_pagar on public.compras using btree (fecha_vence)
  where (not pagado and metodo_pago = 'credito_proveedor'::metodo_pago);
create index idx_compras_proveedor on public.compras using btree (proveedor_id);
create index idx_compras_unidad on public.compras using btree (unidad_id);
create index idx_compras_wo on public.compras using btree (wo_id);

create index idx_detvia_detalle on public.nomina_detalle_viajes using btree (detalle_id);
create unique index uniq_viaje_en_nomina on public.nomina_detalle_viajes using btree (viaje_id)
  where (viaje_id is not null);

create index idx_detalles_empleado on public.nomina_detalles using btree (empleado_id);
create index idx_detalles_nomina on public.nomina_detalles using btree (nomina_id);
create index idx_detalles_operador on public.nomina_detalles using btree (operador_id);

create index idx_reportes_abierto on public.reportes_falla using btree (estatus)
  where (estatus = 'abierto'::estatus_reporte);
create index idx_reportes_unidad on public.reportes_falla using btree (unidad_id);

create index idx_entregas_cliente on public.viaje_entregas using btree (cliente_id);
create index idx_entregas_pendiente on public.viaje_entregas using btree (viaje_id)
  where (estatus = 'pendiente'::estatus_entrega);
create index idx_entregas_viaje on public.viaje_entregas using btree (viaje_id);

create index idx_mov_chofer on public.viaje_movimientos using btree (chofer_id);
create index idx_mov_viaje on public.viaje_movimientos using btree (viaje_id);
-- Regla de negocio clave: solo un movimiento activo por viaje
create unique index uniq_movimiento_activo_por_viaje on public.viaje_movimientos using btree (viaje_id)
  where (activo);

create index idx_viajes_chofer on public.viajes using btree (chofer_actual_id);
create index idx_viajes_cobranza_pendiente on public.viajes using btree (cobranza_fecha_vence)
  where (cobranza_fecha_factura is not null and not cobranza_pagado);
create index idx_viajes_estatus on public.viajes using btree (estatus);
create index idx_viajes_fecha on public.viajes using btree (fecha desc);
create index idx_viajes_nomina on public.viajes using btree (nomina_id);

create index idx_wo_creador on public.work_orders using btree (creado_por);
create index idx_wo_estatus on public.work_orders using btree (estatus)
  where (estatus = 'en_proceso'::estatus_wo);
create index idx_wo_fecha on public.work_orders using btree (fecha desc);
create index idx_wo_unidad on public.work_orders using btree (unidad_id);

-- ---------------------------------------------------------------------
-- FUNCIONES (helpers de auth, SECURITY DEFINER para evitar recursión en RLS)
-- ---------------------------------------------------------------------
create or replace function public.auth_rol()
returns rol_usuario
language sql
stable security definer
set search_path to 'public'
as $function$
  select p.rol from perfiles p where p.id = auth.uid() and p.activo
$function$;

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

-- ---------------------------------------------------------------------
-- FUNCIONES DE TRIGGER
-- ---------------------------------------------------------------------
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
end $function$;

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
end $function$;

create or replace function public.trg_unidades_guarda_chofer()
returns trigger
language plpgsql
as $function$
begin
  if auth_rol() = 'chofer' then
    if (new.numero, new.tipo, new.unidad_lectura, new.marca, new.modelo, new.vin,
        new.anio, new.mantenimiento_cada_x, new.ultimo_mantenimiento_km, new.activo)
       is distinct from
       (old.numero, old.tipo, old.unidad_lectura, old.marca, old.modelo, old.vin,
        old.anio, old.mantenimiento_cada_x, old.ultimo_mantenimiento_km, old.activo)
    then
      raise exception 'El chofer solo puede actualizar ultima_lectura'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $function$;

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
end $function$;

-- ---------------------------------------------------------------------
-- TRIGGERS (confirmados vía pg_trigger / pg_get_triggerdef)
-- ---------------------------------------------------------------------
create trigger t_unidades_guarda_chofer
  before update on public.unidades
  for each row execute function public.trg_unidades_guarda_chofer();

create trigger t_entregas_guarda_chofer
  before update on public.viaje_entregas
  for each row execute function public.trg_entregas_guarda_chofer();

create trigger t_sync_custodia_viaje
  after insert or update of activo, chofer_id, camion_id, caja_id on public.viaje_movimientos
  for each row execute function public.trg_sync_custodia_viaje();

create trigger t_viaje_no_terminar_con_pendientes
  before update of estatus on public.viajes
  for each row execute function public.trg_viaje_no_terminar_con_pendientes();

-- ---------------------------------------------------------------------
-- VISTAS
-- ---------------------------------------------------------------------
create view public.v_viaje_kilometraje as
select
  viaje_id,
  coalesce(sum(km_recorridos), 0::numeric) as km_totales,
  count(*) as num_movimientos
from viaje_movimientos
group by viaje_id;

create view public.v_viaje_entregas_resumen as
select
  v.id as viaje_id,
  count(e.id) as entregas_total,
  count(e.id) filter (where e.estatus = 'pendiente'::estatus_entrega) as entregas_pendientes,
  count(e.id) filter (where e.estatus = 'entregada'::estatus_entrega) as entregas_completadas
from viajes v
left join viaje_entregas e on (e.viaje_id = v.id)
group by v.id;

create view public.v_viaje_clientes as
select
  e.viaje_id,
  array_agg(distinct c.id) as cliente_ids,
  string_agg(distinct c.razon_social, ' / '::text order by c.razon_social) as clientes_texto
from viaje_entregas e
join clientes c on (c.id = e.cliente_id)
group by e.viaje_id;

create view public.v_rendimiento_unidades as
with ultimas as (
  select
    cargas_diesel.unidad_id,
    cargas_diesel.rendimiento,
    row_number() over (partition by cargas_diesel.unidad_id order by cargas_diesel.fecha desc, cargas_diesel.created_at desc) as rn
  from cargas_diesel
  where (cargas_diesel.rendimiento is not null and not cargas_diesel.es_atipico)
)
select
  unidad_id,
  round(avg(rendimiento), 3) as rendimiento_promedio,
  round((percentile_cont(0.5::double precision) within group (order by (rendimiento)::double precision))::numeric, 3) as rendimiento_mediana,
  count(*) as muestras
from ultimas
where (rn <= 5)
group by unidad_id;

create view public.v_balance_mensual as
with ingresos as (
  select
    (date_trunc('month'::text, (viajes.cobranza_fecha_factura)::timestamp with time zone))::date as mes,
    sum(viajes.precio) as ingresos_viajes,
    0::numeric as costo_compras,
    0::numeric as costo_diesel_facturado,
    0::numeric as litros_facturados,
    0::numeric as costo_nomina
  from viajes
  where (viajes.cobranza_fecha_factura is not null)
  group by ((date_trunc('month'::text, (viajes.cobranza_fecha_factura)::timestamp with time zone))::date)
), egresos_compras as (
  select
    (date_trunc('month'::text, (compras.fecha)::timestamp with time zone))::date as mes,
    0::numeric as ingresos_viajes,
    sum(compras.total_usd) as costo_compras,
    sum(compras.total_usd) filter (where compras.es_diesel) as costo_diesel_facturado,
    coalesce(sum(compras.litros_facturados) filter (where compras.es_diesel), 0::numeric) as litros_facturados,
    0::numeric as costo_nomina
  from compras
  group by ((date_trunc('month'::text, (compras.fecha)::timestamp with time zone))::date)
), egresos_nomina as (
  select
    (date_trunc('month'::text, (nominas.pagada_at)::timestamp with time zone))::date as mes,
    0::numeric as ingresos_viajes,
    0::numeric as costo_compras,
    0::numeric as costo_diesel_facturado,
    0::numeric as litros_facturados,
    sum(nominas.total_general) as costo_nomina
  from nominas
  where (nominas.estatus = 'pagada'::estatus_nomina and nominas.pagada_at is not null)
  group by ((date_trunc('month'::text, (nominas.pagada_at)::timestamp with time zone))::date)
), todo as (
  select * from ingresos
  union all
  select * from egresos_compras
  union all
  select * from egresos_nomina
)
select
  mes,
  sum(ingresos_viajes) as ingresos_viajes,
  sum(costo_compras) as costo_compras,
  sum(costo_diesel_facturado) as costo_diesel_facturado,
  sum(litros_facturados) as litros_facturados,
  sum(costo_nomina) as costo_nomina,
  (sum(ingresos_viajes) - sum(costo_compras) - sum(costo_nomina)) as utilidad
from todo
group by mes
order by mes desc;

-- =====================================================================
-- FIN DEL ESQUEMA RECONSTRUIDO — Verificado 100% contra producción:
-- 21 tablas, 5 vistas, 14 enums, 3 secuencias de folio, todos los
-- índices, funciones auth_*, y los 4 triggers confirmados vía
-- pg_trigger (nombres y eventos exactos, no reconstrucción).
--
-- ⚠️ PENDIENTE DE SEGURIDAD (fuera del alcance de este archivo):
-- Ninguna tabla tiene Row Level Security (RLS) habilitado en
-- producción (confirmado en dashboard). Los 4 triggers de arriba son
-- la única barrera activa hoy, y no cubren INSERT/DELETE ni tablas
-- sensibles como nominas, compras o perfiles. Resolver como siguiente
-- prioridad tras dejar este esquema versionado.
-- =====================================================================