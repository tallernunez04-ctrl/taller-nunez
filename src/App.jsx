import { lazy, Suspense, useEffect, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import Taller from './taller'
import Compras from './compras'
import Catalogos from './catalogos'
import Diesel from './diesel'
import Viajes from './viajes'
const Nomina = lazy(() => import('./nomina'))
const Conciliacion = lazy(() => import('./conciliacion'))
const Llantas = lazy(() => import('./llantas'))
// carga diferida: xlsx solo pesa para el admin
const Admin = lazy(() => import('./admin'))

// cada ítem indica su módulo (mod) porque un grupo puede mezclar módulos
const NAV = {
  chofer: [
    { id: 'diesel', label: 'Diésel', icono: '⛽', mod: 'diesel' },
    { id: 'mis-viajes', label: 'Mis viajes', icono: '🚚', mod: 'viajes' },
    { id: 'reportar-falla', label: 'Reportar falla', icono: '⚠️', mod: 'diesel' },
  ],
  taller: [
    { id: 'mis-wo', label: 'Mis WO', icono: '🔧', mod: 'taller' },
    { id: 'nueva-wo', label: 'Nueva WO', icono: '➕', mod: 'taller' },
    { id: 'reportes-falla', label: 'Reportes de falla', icono: '⚠️', mod: 'diesel' },
  ],
  compras: [
    { id: 'work-orders', label: 'Work Orders', icono: '📋', mod: 'compras' },
    { id: 'nueva-compra', label: 'Nueva Compra', icono: '🛒', mod: 'compras' },
    { id: 'unidades', label: 'Unidades', icono: '🚛', mod: 'compras' },
    { id: 'cuentas-pagar', label: 'Por pagar', icono: '📤', mod: 'compras' },
    { id: 'proveedores', label: 'Proveedores', icono: '🏭', mod: 'catalogos' },
  ],
  // rol nuevo (enum Supabase: 'dispatch', nav en español "Despacho"): dueño de la operación.
  // Viajes ya migró a Supabase (RLS de dispatch aplicada) -- Nómina se le asigna cuando migre.
  dispatch: [
    { id: 'viajes', label: 'Viajes', icono: '🚚', mod: 'viajes' },
    { id: 'cobranza', label: 'Por cobrar', icono: '💰', mod: 'viajes' },
    { id: 'unidades', label: 'Unidades', icono: '🚛', mod: 'compras' },
    { id: 'gasolineras', label: 'Gasolineras', icono: '⛽', mod: 'catalogos' },
  ],
  admin: [
    { id: 'gastos', label: 'Gastos', icono: '💵', mod: 'admin' },
    { id: 'dashboard', label: 'Dashboard', icono: '📊', mod: 'admin' },
    { id: 'detalle-unidad', label: 'Detalle por Unidad', icono: '🔍', mod: 'admin' },
    { id: 'rendimiento', label: 'Diésel', icono: '⛽', mod: 'diesel' },
    { id: 'llantas', label: 'Llantas', icono: '🛞', mod: 'llantas' },
    { id: 'operadores', label: 'Operadores', icono: '🧑‍✈️', mod: 'catalogos' },
    { id: 'clientes', label: 'Clientes', icono: '🤝', mod: 'catalogos' },
    { id: 'tabulador', label: 'Tabulador', icono: '🗺️', mod: 'catalogos' },
    { id: 'nomina', label: 'Nómina', icono: '💳', mod: 'nomina' },
    { id: 'conciliacion', label: 'Conciliación', icono: '📈', mod: 'conciliacion' },
    { id: 'usuarios', label: 'Usuarios', icono: '👤', mod: 'admin' },
  ],
}
const TITULO_GRUPO = { taller: 'Taller', compras: 'Compras', dispatch: 'Despacho', admin: 'Administración' }

// admin ve todos los módulos, agrupados por sección con separadores. "unidades" vive tanto en
// compras (solo-lectura) como en dispatch (CRUD) -- para admin se deduplica, quedándose con la
// primera aparición (dispatch antes que compras, ya es dispatch el dueño real de la pantalla).
const gruposDe = (rol) => {
  if (rol !== 'admin') return [{ rol, items: NAV[rol] }]
  const vistos = new Set()
  return ['taller', 'dispatch', 'compras', 'admin'].map((r) => ({
    rol: r,
    items: NAV[r].filter((n) => {
      if (vistos.has(n.id)) return false
      vistos.add(n.id)
      return true
    }),
  }))
}
const navDe = (rol) => gruposDe(rol).flatMap((g) => g.items)

export default function App() {
  const [estado, setEstado] = useState('cargando') // cargando | anonimo | no_autorizado | listo
  const [usuario, setUsuario] = useState(null) // { email, nombre, rol } -- misma forma que usaba el doc de usuarios/{email}
  const [vista, setVista] = useState(null)
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [colapsado, setColapsado] = useState(() => localStorage.getItem('sidebarColapsado') === '1')

  useEffect(() => {
    const cargarPerfil = async (session) => {
      if (!session) {
        setUsuario(null)
        setEstado('anonimo')
        return
      }
      try {
        const { data, error: err } = await supabase
          .from('perfiles')
          .select('id, email, nombre, rol, activo')
          .eq('id', session.user.id)
          .single()
        if (err || !data || data.activo !== true) {
          setEstado('no_autorizado')
          return
        }
        setUsuario(data)
        setVista(navDe(data.rol)[0].id)
        setEstado('listo')
      } catch (e) {
        console.error(e)
        setError(e.message)
        setEstado('no_autorizado')
      }
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_evento, session) => {
      cargarPerfil(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  const entrar = (e) => {
    e.preventDefault()
    setError('')
    supabase.auth.signInWithPassword({ email, password }).then(({ error: err }) => {
      if (err) setError(err.message)
    })
  }
  const salir = () => {
    supabase.auth.signOut()
  }
  const toggleSidebar = () => {
    localStorage.setItem('sidebarColapsado', colapsado ? '0' : '1')
    setColapsado(!colapsado)
  }

  if (estado === 'cargando') {
    return <div className="pantalla-centrada"><p className="muted">Cargando…</p></div>
  }

  if (estado === 'anonimo') {
    return (
      <div className="pantalla-centrada">
        <img src="/logo-nunez.png" alt="Taller Nuñez" className="logo logo-login" />
        <h1 className="marca">Taller <span>Nuñez</span></h1>
        <p className="muted">Gestión de taller mecánico</p>
        <form className="form-login" onSubmit={entrar}>
          <input
            type="email"
            placeholder="Correo"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          <input
            type="password"
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <button type="submit" className="btn-primario">Iniciar sesión</button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  if (estado === 'no_autorizado') {
    return (
      <div className="pantalla-centrada">
        <h1 className="marca">Taller <span>Nuñez</span></h1>
        <p className="error">Acceso no autorizado — contacta al administrador</p>
        <button className="btn-secundario" onClick={salir}>Usar otra cuenta</button>
      </div>
    )
  }

  const nav = navDe(usuario.rol)
  const actual = nav.find((n) => n.id === vista) ?? nav[0]
  // chofer usa layout móvil puro (nav inferior); el resto tiene sidebar en desktop
  const escritorio = usuario.rol !== 'chofer'

  const contenido = actual.mod === 'taller' ? (
    <Taller usuario={usuario} vista={actual.id} setVista={setVista} />
  ) : actual.mod === 'compras' ? (
    <Compras usuario={usuario} vista={actual.id} />
  ) : actual.mod === 'catalogos' ? (
    <Catalogos vista={actual.id} />
  ) : actual.mod === 'diesel' ? (
    <Diesel usuario={usuario} vista={actual.id} />
  ) : actual.mod === 'viajes' ? (
    <Viajes usuario={usuario} vista={actual.id} />
  ) : actual.mod === 'nomina' ? (
    <Suspense fallback={<p className="muted">Cargando…</p>}>
      <Nomina />
    </Suspense>
  ) : actual.mod === 'conciliacion' ? (
    <Suspense fallback={<p className="muted">Cargando…</p>}>
      <Conciliacion />
    </Suspense>
  ) : actual.mod === 'llantas' ? (
    <Suspense fallback={<p className="muted">Cargando…</p>}>
      <Llantas />
    </Suspense>
  ) : (
    <Suspense fallback={<p className="muted">Cargando…</p>}>
      <Admin vista={actual.id} />
    </Suspense>
  )

  return (
    <div className={'app' + (escritorio ? ' con-sidebar' : '') + (colapsado ? ' colapsado' : '')}>
      {escritorio && (
        <aside className="sidebar">
          <button className="sidebar-toggle" onClick={toggleSidebar} aria-label="Colapsar menú">☰</button>
          {gruposDe(usuario.rol).map((g) => (
            <div key={g.rol} className="sidebar-grupo">
              {usuario.rol === 'admin' && <div className="sidebar-titulo">{TITULO_GRUPO[g.rol]}</div>}
              {g.items.map((n) => (
                <button
                  key={n.id}
                  title={n.label}
                  className={n.id === actual.id ? 'sidebar-item activo' : 'sidebar-item'}
                  onClick={() => setVista(n.id)}
                >
                  <span className="sidebar-icono">{n.icono}</span>
                  <span className="sidebar-label">{n.label}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>
      )}
      <div className="app-main">
        <header className="encabezado">
          <img src="/logo-nunez.png" alt="Taller Nuñez" className="logo" />
          <div className="usuario">
            <span className="muted">{usuario.nombre} · {usuario.rol}</span>
            <button className="btn-salir" onClick={salir}>Salir</button>
          </div>
        </header>
        <main className="contenido">
          {contenido}
        </main>
        <nav className="nav-inferior">
          {gruposDe(usuario.rol).map((g) => (
            <div key={g.rol} className="nav-grupo">
              {g.items.map((n) => (
                <button
                  key={n.id}
                  className={n.id === actual.id ? 'nav-item activo' : 'nav-item'}
                  onClick={() => setVista(n.id)}
                >
                  {n.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </div>
    </div>
  )
}
