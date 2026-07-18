import test from 'node:test'
import assert from 'node:assert/strict'
import { mediana, esAtipico } from '../src/costeo.js'

test('mediana de array impar', () => {
  assert.equal(mediana([3, 1, 2]), 2)
})

test('mediana de array par promedia los centrales', () => {
  assert.equal(mediana([1, 2, 3, 10]), 2.5)
})

test('mediana resiste un atípico (vs promedio)', () => {
  // una falla mecánica tira el rendimiento a 0.5; la mediana no se mueve
  assert.equal(mediana([2.4, 2.5, 2.6, 2.5, 0.5]), 2.5)
})

test('mediana de vacío o null es null', () => {
  assert.equal(mediana([]), null)
  assert.equal(mediana(null), null)
})

test('esAtipico detecta desviación mayor a ±25% de la mediana', () => {
  const previos = [2.4, 2.5, 2.6, 2.5]
  assert.equal(esAtipico(1.5, previos), true)   // -40%
  assert.equal(esAtipico(3.5, previos), true)   // +40%
  assert.equal(esAtipico(2.2, previos), false)  // -12%
  assert.equal(esAtipico(2.5, previos), false)
})

test('esAtipico no alerta con menos de 3 datos previos', () => {
  assert.equal(esAtipico(9, [2.5, 2.5]), false)
  assert.equal(esAtipico(9, []), false)
  assert.equal(esAtipico(9, null), false)
})
