alter table public.viaje_entregas add column orden_cliente text;
comment on column public.viaje_entregas.orden_cliente is '# de orden/PO del cliente, para trazabilidad al facturar';
