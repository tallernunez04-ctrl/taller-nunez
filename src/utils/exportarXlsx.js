// mecanica pura de armado de workbook; sin logica de negocio
// import() dinamico: mantiene xlsx (~430kB) fuera del bundle inicial de
// cualquier caller, como ya hacian nomina.jsx y diesel.jsx antes de este refactor
export async function exportarXlsx({ nombreArchivo, hojas }) {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  hojas.forEach(({ nombre, datos }) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(datos), nombre)
  })
  XLSX.writeFile(wb, nombreArchivo)
}
