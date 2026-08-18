import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const supabase = createClient(supabaseUrl, supabaseKey)

// sube un archivo al bucket privado 'adjuntos' y regresa una URL firmada de larga
// duración (10 años) -- el bucket es privado (RLS por rol/carpeta), así que no hay
// URL pública equivalente a getDownloadURL() de Firebase; firmar una vez a la carga
// y guardar esa URL evita tener que regenerarla cada vez que se muestra
const DIEZ_ANIOS = 60 * 60 * 24 * 365 * 10
export async function subirArchivo(ruta, archivo) {
  const { error } = await supabase.storage.from('adjuntos').upload(ruta, archivo, { upsert: true })
  if (error) throw error
  const { data, error: errUrl } = await supabase.storage.from('adjuntos').createSignedUrl(ruta, DIEZ_ANIOS)
  if (errUrl) throw errUrl
  return data.signedUrl
}
