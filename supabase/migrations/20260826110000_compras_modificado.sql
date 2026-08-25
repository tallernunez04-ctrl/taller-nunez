alter table public.compras
  add column modificado boolean not null default false,
  add column modificado_at timestamptz,
  add column modificado_por uuid references public.perfiles(id);
comment on column public.compras.modificado is 'true si se ajustaron costos de una PO ya guardada (proveedor cambió precio) -- solo costos, no conceptos/cantidades; queda marcada en rojo para revisión';
