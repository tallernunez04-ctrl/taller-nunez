// Alta de usuarios (admin): crea la cuenta en Supabase Auth + su fila en `perfiles`.
// Necesita el service role key (crear un auth.users no es posible desde el cliente),
// por eso vive en una Edge Function en vez de hacerse directo desde admin.jsx.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const ROLES = ['chofer', 'taller', 'compras', 'admin', 'dispatch']

// lista blanca por variable de entorno (Supabase secret CORS_ORIGINS, separado por comas) --
// aun no hay dominio de producción fijo, así que no se puede hardcodear; localhost:5173 (dev)
// siempre queda incluido. Cuando haya dominio final: `supabase secrets set CORS_ORIGINS=https://...`
const ORIGENES_PERMITIDOS = [
  'http://localhost:5173',
  ...(Deno.env.get('CORS_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean),
]

function corsHeaders(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ORIGENES_PERMITIDOS.includes(origin) ? origin : ORIGENES_PERMITIDOS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  }
}

function generarPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 14)
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get('Origin'))
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const comoLlamante = createClient(url, anonKey, {
    global: { headers: { Authorization: req.headers.get('Authorization')! } },
  })
  const { data: { user } } = await comoLlamante.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'No autenticado' }), { status: 401, headers: cors })

  const { data: llamante } = await comoLlamante.from('perfiles').select('rol, activo').eq('id', user.id).single()
  if (!llamante || llamante.rol !== 'admin' || llamante.activo !== true) {
    return new Response(JSON.stringify({ error: 'Solo un admin puede crear usuarios' }), { status: 403, headers: cors })
  }

  const { email, nombre, rol } = await req.json()
  if (!email?.includes('@') || !nombre?.trim() || !ROLES.includes(rol)) {
    return new Response(JSON.stringify({ error: 'email, nombre o rol inválidos' }), { status: 400, headers: cors })
  }

  const admin = createClient(url, serviceKey)
  const password = generarPassword()
  const { data: creado, error: errCrear } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (errCrear) return new Response(JSON.stringify({ error: errCrear.message }), { status: 400, headers: cors })

  const { error: errPerfil } = await admin.from('perfiles').insert({
    id: creado.user.id, email, nombre: nombre.trim(), rol, activo: true,
  })
  if (errPerfil) {
    await admin.auth.admin.deleteUser(creado.user.id)
    return new Response(JSON.stringify({ error: errPerfil.message }), { status: 400, headers: cors })
  }

  return new Response(JSON.stringify({ email, password }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
