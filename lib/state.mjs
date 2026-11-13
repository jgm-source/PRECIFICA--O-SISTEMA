import { getPool } from './db.mjs';
import { HttpError } from './http-error.mjs';

const UNITS = new Set(['g', 'ml', 'un']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value, label) {
  const id = String(value || '');
  if (!UUID.test(id)) throw new HttpError(400, `Identificador inválido em ${label}.`);
  return id;
}

function assertPositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 1e10) {
    throw new HttpError(400, `O campo ${label} precisa ser um número maior que zero.`);
  }
  return number;
}

function assertPositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 2147483647) {
    throw new HttpError(400, `${label} precisa ser um número inteiro maior que zero.`);
  }
  return number;
}

function asArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${label} está em formato inválido.`);
  return value;
}

function assertUnique(ids, label) {
  if (new Set(ids).size !== ids.length) throw new HttpError(400, `Há ${label} repetido na lista.`);
}

export function normalizeState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Dados inválidos.');
  }
  const ingredients = asArray(input.ingredients, 'A lista de insumos').map(item => {
    if (!item || typeof item !== 'object') throw new HttpError(400, 'Insumo inválido.');
    const name = String(item.name || '').trim();
    if (name.length < 1 || name.length > 80) throw new HttpError(400, 'O nome do insumo deve ter entre 1 e 80 caracteres.');
    const unit = String(item.unit || '');
    if (!UNITS.has(unit)) throw new HttpError(400, 'A unidade do insumo é inválida.');
    return {
      id: assertUuid(item.id, 'insumo'),
      name,
      price: assertPositiveNumber(item.price, 'preço do insumo'),
      unit,
      amount: assertPositiveNumber(item.amount, 'quantidade do insumo')
    };
  });
  const products = asArray(input.products, 'A lista de produtos').map(item => {
    if (!item || typeof item !== 'object') throw new HttpError(400, 'Produto inválido.');
    const name = String(item.name || '').trim();
    if (name.length < 1 || name.length > 80) throw new HttpError(400, 'O nome do produto deve ter entre 1 e 80 caracteres.');
    const items = asArray(item.items, 'A ficha técnica').map(row => {
      if (!row || typeof row !== 'object') throw new HttpError(400, 'Item da ficha técnica inválido.');
      return {
        ingredientId: assertUuid(row.ingredientId, 'item da ficha'),
        amount: assertPositiveNumber(row.amount, 'quantidade usada na ficha')
      };
    });
    return {
      id: assertUuid(item.id, 'produto'),
      name,
      yield: assertPositiveInt(item.yield, 'O rendimento'),
      items
    };
  });
  const production = asArray(input.production, 'A lista de produção').map(item => {
    if (!item || typeof item !== 'object') throw new HttpError(400, 'Item de produção inválido.');
    return {
      id: assertUuid(item.id, 'produção'),
      productId: assertUuid(item.productId, 'produção'),
      quantity: assertPositiveInt(item.quantity, 'A quantidade da produção')
    };
  });
  assertUnique(ingredients.map(item => item.id), 'um insumo');
  assertUnique(products.map(item => item.id), 'um produto');
  assertUnique(production.map(item => item.id), 'um item de produção');
  const ingredientIds = new Set(ingredients.map(item => item.id));
  const productIds = new Set(products.map(item => item.id));
  for (const product of products) {
    for (const item of product.items) {
      if (!ingredientIds.has(item.ingredientId)) {
        throw new HttpError(400, 'A ficha técnica usa um insumo que não está cadastrado.');
      }
    }
  }
  for (const row of production) {
    if (!productIds.has(row.productId)) {
      throw new HttpError(400, 'A produção usa um produto que não está cadastrado.');
    }
  }
  return { ingredients, products, production };
}

export function presentState(raw) {
  const state = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  return {
    ingredients: (state.ingredients || []).map(item => ({
      id: item.id,
      name: item.name,
      price: Number(item.price),
      unit: item.unit,
      amount: Number(item.amount)
    })),
    products: (state.products || []).map(product => ({
      id: product.id,
      name: product.name,
      yield: Number(product.yield),
      items: (product.items || []).map(item => ({
        ingredientId: item.ingredientId,
        amount: Number(item.amount)
      }))
    })),
    production: (state.production || []).map(item => ({
      id: item.id,
      productId: item.productId,
      quantity: Number(item.quantity)
    }))
  };
}

function mapStateError(error) {
  if (error.status) return error;
  if (error.code === '42P01') return new HttpError(503, 'O banco ainda não tem as tabelas. Execute npm run db:schema.');
  if (['23514', '23503', '23505', '22P02', '22003'].includes(error.code)) {
    return new HttpError(400, 'Não foi possível salvar estes dados. Revise os cadastros e tente de novo.');
  }
  return error;
}

export async function loadUserState(userId) {
  try {
    const result = await getPool().query('select public.load_price_state($1::uuid) as state', [userId]);
    return presentState(result.rows[0]?.state);
  } catch (error) {
    throw mapStateError(error);
  }
}

export async function saveUserState(userId, input) {
  const state = normalizeState(input);
  try {
    await getPool().query('select public.save_price_state($1::uuid, $2::jsonb)', [userId, JSON.stringify(state)]);
  } catch (error) {
    throw mapStateError(error);
  }
  return state;
}
