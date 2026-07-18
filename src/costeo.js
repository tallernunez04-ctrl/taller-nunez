/* Helpers puros de costeo — sin imports de firebase para poder testearlos con node. */

// mediana de un array de números; resiste atípicos (fallas mecánicas, errores de captura)
export const mediana = (arr) => {
  if (!arr?.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// true si el rendimiento se desvía más de ±25% de la mediana de los previos.
// ponytail: con <3 datos previos no alerta — la mediana aún no es confiable
export const esAtipico = (rendimiento, previos) => {
  if (!previos || previos.length < 3) return false
  const med = mediana(previos)
  return med > 0 && Math.abs(rendimiento - med) / med > 0.25
}
