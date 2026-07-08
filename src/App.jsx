import { lazy, Suspense, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db, provider } from './firebase'
import { seedIfEmpty } from './seed'
import Taller from './taller'
import Compras from './compras'
// carga diferida: xlsx + chart.js solo pesan para el admin
const Admin = lazy(() => import('./admin'))

const NAV = {
  taller: [
    { id: 'mis-wo', label: 'Mis WO' },
    { id: 'nueva-wo', label: 'Nueva WO' },
  ],
  compras: [
    { id: 'work-orders', label: 'Work Orders' },
    { id: 'nueva-compra', label: 'Nueva Compra' },
    { id: 'unidades', label: 'Unidades' },
  ],
  admin: [
    { id: 'gastos', label: 'Gastos' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'detalle-unidad', label: 'Detalle por Unidad' },
    { id: 'usuarios', label: 'Usuarios' },
  ],
}

// admin ve todos los módulos, agrupados por sección con separadores
const gruposDe = (rol) => (rol === 'admin' ? [NAV.taller, NAV.compras, NAV.admin] : [NAV[rol]])
const navDe = (rol) => gruposDe(rol).flat()

const VISTAS_TALLER = ['mis-wo', 'nueva-wo']
const VISTAS_COMPRAS = ['work-orders', 'nueva-compra', 'unidades']

export default function App() {
  const [estado, setEstado] = useState('cargando') // cargando | anonimo | no_autorizado | listo
  const [usuario, setUsuario] = useState(null) // doc de usuarios/{email}
  const [vista, setVista] = useState(null)
  const [error, setError] = useState('')

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
      seedIfEmpty(datos.rol).catch(console.error)
    } catch (e) {
      console.error(e)
      setError(e.message)
      setEstado('no_autorizado')
    }
  }), [])

  const entrar = () => signInWithPopup(auth, provider).catch((e) => setError(e.message))
  const salir = () => signOut(auth)

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

  return (
    <div className="app">
      <header className="encabezado">
        <img src="/logo-nunez.png" alt="Taller Nuñez" className="logo" />
        <div className="usuario">
          <span className="muted">{usuario.nombre} · {usuario.rol}</span>
          <button className="btn-salir" onClick={salir}>Salir</button>
        </div>
      </header>
      <main className="contenido">
        {VISTAS_TALLER.includes(actual.id) ? (
          <Taller usuario={usuario} vista={actual.id} setVista={setVista} />
        ) : VISTAS_COMPRAS.includes(actual.id) ? (
          <Compras usuario={usuario} vista={actual.id} />
        ) : (
          <Suspense fallback={<p className="muted">Cargando…</p>}>
            <Admin vista={actual.id} />
          </Suspense>
        )}
      </main>
      <nav className="nav-inferior">
        {gruposDe(usuario.rol).map((grupo, gi) => (
          <div key={gi} className="nav-grupo">
            {grupo.map((n) => (
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
  )
}
