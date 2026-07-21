import test from 'node:test'
import assert from 'node:assert/strict'
import { r2, dinero, hoy } from '../src/utils/format.js'

test('r2 redondea a 2 decimales', () => {
  assert.equal(r2(2.345), 2.35)
  assert.equal(r2(10 / 3), 3.33)
  assert.equal(r2(-1.005), -1)
})

test('r2 conserva el quirk de punto flotante existente (1.005 -> 1, no 1.01)', () => {
  assert.equal(r2(1.005), 1)
})

test('dinero formatea con símbolo, separador de miles y moneda', () => {
  assert.equal(dinero(1234.5, 'MXN'), '$1,234.50 MXN')
  assert.equal(dinero(0, 'USD'), '$0.00 USD')
})

test('dinero trata null/undefined como 0', () => {
  assert.equal(dinero(null, 'USD'), '$0.00 USD')
  assert.equal(dinero(undefined, 'USD'), '$0.00 USD')
})

test('hoy devuelve fecha local en formato YYYY-MM-DD', () => {
  assert.match(hoy(), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(hoy(), new Date().toLocaleDateString('sv'))
})
