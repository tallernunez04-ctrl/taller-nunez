import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const supabase = createClient(supabaseUrl, supabaseKey)

// tipos que de verdad sube la app (facturas, comprobantes, fotos, XML) -- el Content-Type
// que reporta el navegador (archivo.type) es inconsistente entre SO/navegador, especialmente
// para .xml, así que se deriva de la extensión del nombre de archivo, no se confía en él.
// Deliberadamente NO incluye svg/html: son "imagen"/"documento" pero pueden llevar <script>
// y ejecutarlo si alguien abre el archivo directo (ver urlFirmada -- download:true igual lo cubre).
const MIME_POR_EXTENSION = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif',
  xml: 'application/xml',
}

// valida los primeros bytes del archivo contra la firma real del tipo esperado -- que el
// nombre diga "factura.pdf" no significa que el contenido sea un PDF (ej. un .exe renombrado)
async function firmaValida(archivo, mime) {
  const buf = new Uint8Array(await archivo.slice(0, 16).arrayBuffer())
  switch (mime) {
    case 'application/pdf':
      return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 // %PDF
    case 'image/jpeg':
      return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF
    case 'image/png':
      return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    case 'image/webp':
      return buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
        && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    case 'image/heic':
    case 'image/heif':
      return buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70 // caja 'ftyp'
    case 'application/xml': {
      let i = (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? 3 : 0 // BOM UTF-8 opcional
      while (i < buf.length && [0x20, 0x09, 0x0A, 0x0D].includes(buf[i])) i++ // espacios en blanco
      return buf[i] === 0x3C // '<'
    }
    default:
      return false
  }
}

// sube un archivo al bucket privado 'adjuntos' y regresa la RUTA (no una URL firmada:
// una URL firmada de 10 años es un bearer token que nunca expira y salta el RLS de
// Storage para siempre si se filtra -- ver urlFirmada()). La ruta es lo que se guarda
// en la base; la URL se genera al vuelo cada vez que alguien la abre.
export async function subirArchivo(ruta, archivo) {
  const ext = (archivo.name || ruta).split('.').pop()?.toLowerCase()
  const mime = MIME_POR_EXTENSION[ext]
  if (!mime) throw new Error(`Tipo de archivo no permitido: .${ext}`)
  if (!(await firmaValida(archivo, mime))) {
    throw new Error(`"${archivo.name}" no parece ser un archivo ${ext.toUpperCase()} válido (el contenido no coincide con la extensión)`)
  }
  const { error } = await supabase.storage.from('adjuntos').upload(ruta, archivo, { upsert: true, contentType: mime })
  if (error) throw error
  return ruta
}

const VEINTICUATRO_HORAS = 60 * 60 * 24
// genera una URL firmada de corta duración para una ruta ya subida. download:true fuerza
// Content-Disposition: attachment -- el navegador descarga el archivo en vez de renderizarlo,
// así que aunque algo se colara pasando la validación de subida, abrirlo no ejecuta nada.
// Acepta también una URL firmada vieja (guardada antes de este fix) y la regresa tal cual --
// sigue siendo válida hasta su vencimiento original, no hay que migrar los archivos ya subidos.
export async function urlFirmada(ruta) {
  if (!ruta) return ''
  if (ruta.startsWith('http')) return ruta
  const { data, error } = await supabase.storage.from('adjuntos').createSignedUrl(ruta, VEINTICUATRO_HORAS, { download: true })
  if (error) throw error
  return data.signedUrl
}
