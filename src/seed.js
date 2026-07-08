import {
  collection, doc, getDoc, getDocs, limit, query, serverTimestamp, setDoc,
} from 'firebase/firestore'
import { db } from './firebase'

const TRUCKS = ['F61', 'F51', 'F68', 'F56', 'F55', 'F48', 'F72', 'F67', 'F50']
const REEFERS = [
  'CN79', 'CN69', 'CN91', 'CN51', 'CN68', 'CN98', 'CN85', 'CN52', 'CN66', 'CN89',
  'CN106', 'CN81', 'CN58', 'CN80', 'CN49', 'CN63', 'CN97', 'CN65', 'CN50',
]

// ponytail: seed corre en el cliente al entrar admin/compras (las reglas solo les
// permiten escribir a ellos); mover a script de admin si el seed crece
export async function seedIfEmpty(rol) {
  if (rol === 'admin') {
    const cfg = await getDoc(doc(db, 'config', 'general'))
    if (!cfg.exists()) {
      await setDoc(doc(db, 'config', 'general'), { ultimoWO: 0, tipoCambioUSD: 18.5 })
    }
  }
  if (rol !== 'admin' && rol !== 'compras') return
  const alguna = await getDocs(query(collection(db, 'unidades'), limit(1)))
  if (!alguna.empty) return
  const crear = (numero, tipo, unidadLectura) =>
    setDoc(doc(db, 'unidades', numero), {
      numero, tipo, unidadLectura,
      ultimaLectura: null,
      marca: '', anio: '', modelo: '', vin: '',
      activa: true,
      createdAt: serverTimestamp(),
    })
  await Promise.all([
    ...TRUCKS.map((n) => crear(n, 'truck', 'mi')),
    ...REEFERS.map((n) => crear(n, 'reefer', 'hrs')),
  ])
}
