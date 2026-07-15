import { lazy, Suspense, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db, provider } from './firebase'
import Taller from './taller'
import Compras from './compras'
import Catalogos from './catalogos'
import Diesel from './diesel'
import Viajes from './viajes'
const Nomina = lazy(() => import('./nomina'))
const Conciliacion = lazy(() => import('./conciliacion'))
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
  admin: [
    { id: 'viajes', label: 'Viajes', icono: '🚚', mod: 'viajes' },
    { id: 'cobranza', label: 'Por cobrar', icono: '💰', mod: 'viajes' },
    { id: 'gastos', label: 'Gastos', icono: '💵', mod: 'admin' },
    { id: 'dashboard', label: 'Dashboard', icono: '📊', mod: 'admin' },
    { id: 'detalle-unidad', label: 'Detalle por Unidad', icono: '🔍', mod: 'admin' },
    { id: 'rendimiento', label: 'Diésel', icono: '⛽', mod: 'diesel' },
    { id: 'operadores', label: 'Operadores', icono: '🧑‍✈️', mod: 'catalogos' },
    { id: 'clientes', label: 'Clientes', icono: '🤝', mod: 'catalogos' },
    { id: 'tabulador', label: 'Tabulador', icono: '🗺️', mod: 'catalogos' },
    { id: 'nomina', label: 'Nómina', icono: '💳', mod: 'nomina' },
    { id: 'conciliacion', label: 'Conciliación', icono: '📈', mod: 'conciliacion' },
    { id: 'usuarios', label: 'Usuarios', icono: '👤', mod: 'admin' },
  ],
}
const TITULO_GRUPO = { taller: 'Taller', compras: 'Compras', admin: 'Administración' }

// admin ve todos los módulos, agrupados por sección con separadores
const gruposDe = (rol) =>
  (rol === 'admin' ? ['taller', 'compras', 'admin'] : [rol]).map((r) => ({ rol: r, items: NAV[r] }))
const navDe = (rol) => gruposDe(rol).flatMap((g) => g.items)

export default function App() {
  const [estado, setEstado] = useState('cargando') // cargando | anonimo | no_autorizado | listo
  const [usuario, setUsuario] = useState(null) // doc de usuarios/{email}
  const [vista, setVista] = useState(null)
  const [error, setError] = useState('')
  const [colapsado, setColapsado] = useState(() => localStorage.getItem('sidebarColapsado') === '1')

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    if (!u) {
      setUsuario(null)
      setEstado('anonimo')
      return
    }
    try {
      const snap = await getDoc(doc(db, 'usuarios', u.email))
      if (!snap.exists() || snap.data().activo !== true) {
        setEstado('no_autorizado')
        return
      }
      const datos = snap.data()
      setUsuario(datos)
      setVista(navDe(datos.rol)[0].id)
      setEstado('listo')
    } catch (e) {
      console.error(e)
      setError(e.message)
      setEstado('no_autorizado')
    }
  }), [])

  const entrar = () => signInWithPopup(auth, provider).catch((e) => setError(e.message))
  const salir = () => signOut(auth)
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
        <button className="btn-primario" onClick={entrar}>Iniciar sesión con Google</button>
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
