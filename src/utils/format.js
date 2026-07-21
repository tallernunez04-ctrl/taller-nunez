export const r2 = (n) => Math.round(n * 100) / 100
export const dinero = (n, moneda) =>
  '$' + (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + moneda

// fecha local YYYY-MM-DD (toISOString sería UTC y se adelanta de noche)
export const hoy = () => new Date().toLocaleDateString('sv')
