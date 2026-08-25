alter table public.viajes add column iva_tasa numeric not null default 0.16;
comment on column public.viajes.iva_tasa is 'tasa de IVA sobre precio (0, 0.08, 0.16), igual que compra_conceptos.tasa_iva';
