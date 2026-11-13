-- PreçoCerto: schema inicial para PostgreSQL comum.
-- Substitui o Supabase (auth.users, RLS e save_price_state ligada a auth.uid()).
-- Idempotente: pode ser executado de novo sem apagar dados.
-- A senha do banco não fica neste arquivo. A aplicação usa DATABASE_URL.
--
-- Não há RLS. No EasyPanel o aplicativo conecta como o usuário do banco (postgres),
-- e um superusuário ignora RLS. O isolamento entre contas fica na aplicação:
-- toda leitura e gravação usa o id da sessão, nunca um id vindo do navegador.

create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  role text not null default 'user',
  password_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_email_unique unique (email),
  constraint users_email_check check (char_length(email) between 3 and 254 and position('@' in email) > 1),
  constraint users_name_check check (char_length(btrim(name)) between 1 and 120),
  constraint users_role_check check (role in ('admin', 'user'))
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint sessions_token_hash_unique unique (token_hash)
);

create table if not exists public.password_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  token_hash text not null,
  purpose text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint password_tokens_token_hash_unique unique (token_hash),
  constraint password_tokens_purpose_check check (purpose in ('invite', 'reset'))
);

create table if not exists public.ingredients (
  id uuid primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  price numeric(14,4) not null check (price > 0),
  unit text not null check (unit in ('g', 'ml', 'un')),
  amount numeric(14,3) not null check (amount > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.products (
  id uuid primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  "yield" integer not null check ("yield" > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.product_ingredients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  product_id uuid not null,
  ingredient_id uuid not null,
  amount numeric(14,3) not null check (amount > 0),
  position integer not null default 0,
  foreign key (product_id, user_id) references public.products (id, user_id) on delete cascade,
  foreign key (ingredient_id, user_id) references public.ingredients (id, user_id) on delete restrict
);

create table if not exists public.production_items (
  id uuid primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  product_id uuid not null,
  quantity integer not null check (quantity > 0),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (product_id, user_id) references public.products (id, user_id) on delete cascade
);

create index if not exists ingredients_user_id_idx on public.ingredients (user_id);
create index if not exists products_user_id_idx on public.products (user_id);
create index if not exists product_ingredients_user_id_idx on public.product_ingredients (user_id);
create index if not exists product_ingredients_product_id_idx on public.product_ingredients (product_id);
create index if not exists production_items_user_id_idx on public.production_items (user_id);
create index if not exists sessions_user_id_idx on public.sessions (user_id);
create index if not exists sessions_expires_at_idx on public.sessions (expires_at);
create index if not exists password_tokens_user_id_idx on public.password_tokens (user_id);

-- Grava o estado inteiro da conta numa única transação.
-- O id vem da sessão no servidor, não do JSON enviado pelo navegador.
create or replace function public.save_price_state(current_user_id uuid, state jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if current_user_id is null then
    raise exception 'Usuário não autenticado';
  end if;
  if state is null or jsonb_typeof(state) <> 'object' then
    raise exception 'Dados inválidos';
  end if;
  if not exists (select 1 from public.users where id = current_user_id) then
    raise exception 'Usuário não encontrado';
  end if;

  delete from public.production_items where user_id = current_user_id;
  delete from public.product_ingredients where user_id = current_user_id;
  delete from public.products where user_id = current_user_id;
  delete from public.ingredients where user_id = current_user_id;

  insert into public.ingredients (id, user_id, name, price, unit, amount, created_at)
  select (item->>'id')::uuid,
         current_user_id,
         item->>'name',
         (item->>'price')::numeric,
         item->>'unit',
         (item->>'amount')::numeric,
         now() + ((ordinality - 1) * interval '1 millisecond')
  from jsonb_array_elements(coalesce(state->'ingredients', '[]'::jsonb)) with ordinality as rows(item, ordinality);

  insert into public.products (id, user_id, name, "yield", created_at)
  select (item->>'id')::uuid,
         current_user_id,
         item->>'name',
         (item->>'yield')::integer,
         now() + ((ordinality - 1) * interval '1 millisecond')
  from jsonb_array_elements(coalesce(state->'products', '[]'::jsonb)) with ordinality as rows(item, ordinality);

  insert into public.product_ingredients (user_id, product_id, ingredient_id, amount, position)
  select current_user_id,
         (product->>'id')::uuid,
         (ingredient->>'ingredientId')::uuid,
         (ingredient->>'amount')::numeric,
         ingredient_position::integer - 1
  from jsonb_array_elements(coalesce(state->'products', '[]'::jsonb)) product
  cross join lateral jsonb_array_elements(coalesce(product->'items', '[]'::jsonb))
    with ordinality as rows(ingredient, ingredient_position);

  insert into public.production_items (id, user_id, product_id, quantity, position)
  select (item->>'id')::uuid,
         current_user_id,
         (item->>'productId')::uuid,
         (item->>'quantity')::integer,
         item_position::integer - 1
  from jsonb_array_elements(coalesce(state->'production', '[]'::jsonb))
    with ordinality as rows(item, item_position);
end;
$$;

create or replace function public.load_price_state(current_user_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'ingredients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'name', name,
        'price', price,
        'unit', unit,
        'amount', amount
      ) order by created_at, id)
      from public.ingredients
      where user_id = current_user_id
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'yield', p."yield",
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ingredientId', pi.ingredient_id,
            'amount', pi.amount
          ) order by pi.position, pi.id)
          from public.product_ingredients pi
          where pi.user_id = p.user_id and pi.product_id = p.id
        ), '[]'::jsonb)
      ) order by p.created_at, p.id)
      from public.products p
      where p.user_id = current_user_id
    ), '[]'::jsonb),
    'production', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'productId', product_id,
        'quantity', quantity
      ) order by position, id)
      from public.production_items
      where user_id = current_user_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.save_price_state(uuid, jsonb) from public;
revoke all on function public.load_price_state(uuid) from public;
revoke all on public.users, public.sessions, public.password_tokens, public.ingredients, public.products, public.product_ingredients, public.production_items from public;
