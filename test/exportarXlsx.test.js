import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { exportarXlsx } from '../src/utils/exportarXlsx.js'

// xlsx 0.20 (build ESM pura) ya no auto-detecta fs de Node como el build CJS de antes --
// hay que dárselo explícitamente. Solo afecta este test (Node); en el navegador (producción)
// exportarXlsx nunca pasa por aquí, usa el flujo de descarga vía Blob/URL.createObjectURL.
XLSX.set_fs(fs)

function leerHojas(rutaArchivo) {
  const buf = fs.readFileSync(rutaArchivo)
  const wb = XLSX.read(buf, { type: 'buffer' })
  return Object.fromEntries(
    wb.SheetNames.map((nombre) => [nombre, XLSX.utils.sheet_to_json(wb.Sheets[nombre], { header: 1 })]),
  )
}

test('exportarXlsx escribe un archivo con una sola hoja', async () => {
  const ruta = path.join(os.tmpdir(), `xlsx_test_${Date.now()}_1.xlsx`)
  try {
    await exportarXlsx({ nombreArchivo: ruta, hojas: [{ nombre: 'Datos', datos: [['a', 'b'], [1, 2]] }] })
    assert.ok(fs.existsSync(ruta))
    const hojas = leerHojas(ruta)
    assert.deepEqual(Object.keys(hojas), ['Datos'])
    assert.deepEqual(hojas['Datos'], [['a', 'b'], [1, 2]])
  } finally {
    fs.rmSync(ruta, { force: true })
  }
})

test('exportarXlsx escribe varias hojas en orden y con su nombre', async () => {
  const ruta = path.join(os.tmpdir(), `xlsx_test_${Date.now()}_2.xlsx`)
  try {
    await exportarXlsx({
      nombreArchivo: ruta,
      hojas: [
        { nombre: 'Unidad', datos: [['Unidad', 'U-1'], ['Tipo', 'truck']] },
        { nombre: 'Work Orders', datos: [['WO', 'Fecha'], ['WO-1', '2026-01-01']] },
      ],
    })
    const hojas = leerHojas(ruta)
    assert.deepEqual(Object.keys(hojas), ['Unidad', 'Work Orders'])
    assert.deepEqual(hojas['Unidad'], [['Unidad', 'U-1'], ['Tipo', 'truck']])
    assert.deepEqual(hojas['Work Orders'], [['WO', 'Fecha'], ['WO-1', '2026-01-01']])
  } finally {
    fs.rmSync(ruta, { force: true })
  }
})
