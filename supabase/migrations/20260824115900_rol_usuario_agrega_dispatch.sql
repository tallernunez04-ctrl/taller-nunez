-- El rol 'dispatch' (nav "Despacho" en App.jsx) se agregó directo en producción y nunca quedó
-- versionado -- reproducir las migraciones desde cero hoy dejaría el enum sin este valor, y
-- 20260824120000_hardening_control_acceso.sql (que ya lo usa en políticas RLS) fallaría.
alter type rol_usuario add value if not exists 'dispatch';
