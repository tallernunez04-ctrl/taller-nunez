-- Una fila por concepto cuyo costo_unitario cambió en EditarCostosPO (compras.jsx) -- hoy
-- compras.modificado solo marca la PO en rojo, sin guardar qué cambió de cuánto a cuánto.
-- Admin necesita revisar el detalle desde Cuentas por pagar (click en el badge "MODIFICADO").
create table public.compra_costo_historial (
  id uuid primary key default gen_random_uuid(),
  compra_id uuid not null references public.compras(id) on delete cascade,
  concepto_id uuid references public.compra_conceptos(id) on delete set null,
  concepto_texto text not null,
  costo_anterior numeric not null,
  costo_nuevo numeric not null,
  modificado_por uuid references public.perfiles(id),
  created_at timestamptz not null default now()
);
comment on table public.compra_costo_historial is 'historial de ediciones de costo_unitario por concepto -- ver compras.modificado';

alter table public.compra_costo_historial enable row level security;

-- mismo patrón de roles que compras/compra_conceptos: compras lee/escribe, admin todo
create policy compra_costo_historial_admin_todas on public.compra_costo_historial for all
  using (auth_es(array['admin']::rol_usuario[]))
  with check (auth_es(array['admin']::rol_usuario[]));
create policy compra_costo_historial_select on public.compra_costo_historial for select
  using (auth_es(array['compras']::rol_usuario[]));
create policy compra_costo_historial_insert on public.compra_costo_historial for insert
  with check (auth_es(array['compras']::rol_usuario[]));
