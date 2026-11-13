import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { normalizeState } from '../lib/state.mjs';

function sample() {
  const ingredientId = randomUUID();
  const productId = randomUUID();
  return {
    ingredientId,
    productId,
    state: {
      ingredients: [{ id: ingredientId, name: ' Açúcar ', price: 10.5, unit: 'g', amount: 1000 }],
      products: [{ id: productId, name: 'Bolo', yield: 12, items: [{ ingredientId, amount: 200 }] }],
      production: [{ id: randomUUID(), productId, quantity: 3 }]
    }
  };
}

test('normaliza o mesmo formato que a tela salva', () => {
  const { state, ingredientId } = sample();
  const normalized = normalizeState(state);
  assert.equal(normalized.ingredients[0].name, 'Açúcar');
  assert.equal(normalized.ingredients[0].id, ingredientId);
  assert.equal(normalized.products[0].yield, 12);
  assert.equal(normalized.production[0].quantity, 3);
});

test('rejeita unidade e referência inválidas', () => {
  const { state } = sample();
  state.ingredients[0].unit = 'kg';
  assert.throws(() => normalizeState(state), /unidade/);
  const again = sample().state;
  again.products[0].items[0].ingredientId = randomUUID();
  assert.throws(() => normalizeState(again), /insumo que não está cadastrado/);
});
