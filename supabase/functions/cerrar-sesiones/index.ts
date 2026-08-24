// Cierra sesión de un usuario en TODOS sus dispositivos -- para cuando se pierde/roba un
// celular o laptop, o se sospecha de una sesión robada (ver auditoría de seguridad, Punto 6:
// el token vive en localStorage, no hay forma de invalidar una sesión específica desde el
// navegador mismo). Necesita el service role key, por eso vive en una Edge Function, mismo
// patrón que crear-usuario.
//
// admin.auth.admin.signOut(jwt, scope) del SDK NO sirve aquí -- espera el JWT de la sesión a
// cerrar, no el id del usuario (un admin nunca tiene ese JWT en la mano). El patrón real de
// Supabase para "cerrar sesión de un usuario por su id, sin su JWT" es resetear su contraseña:
// GoTrue revoca todos los refresh tokens existentes al cambiar la contraseña, así que no puede
// sacar un access token nuevo -- efectivamente fuera en cuanto expira el que ya tenía (máx. el
// tiempo de vida del JWT, hoy 60 min). Además evita que reingrese con la contraseña vieja si
// el dispositivo se perdió/robó, que es justo el caso de uso real.
//
// verify_jwt=false a nivel plataforma: el gateway de Supabase no valida bien los JWT de este
// proyecto (llaves de firma ES256 nuevas -- "invalid number of segments" con un JWT válido).
// No es un hueco de seguridad: la función ya valida el JWT Y el rol admin por su cuenta abajo
// (comoLlamante.auth.getUser() + chequeo de rol) -- ese es el gate real.
import { createClient } from 'jsr:@supabase/supabase-js@2'

function generarPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 14)
}

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
    return new Response(JSON.stringify({ error: 'Solo un admin puede cerrar sesiones de otro usuario' }), { status: 403, headers: cors })
  }

  const { usuarioId } = await req.json()
  if (!usuarioId) return new Response(JSON.stringify({ error: 'Falta usuarioId' }), { status: 400, headers: cors })

  const admin = createClient(url, serviceKey)
  const password = generarPassword()
  const { error } = await admin.auth.admin.updateUserById(usuarioId, { password })
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: cors })

  return new Response(JSON.stringify({ password }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
