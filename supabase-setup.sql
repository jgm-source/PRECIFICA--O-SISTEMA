-- PreçoCerto: banco relacional multiusuário
-- Execute todo este arquivo no SQL Editor do Supabase.

create extension if not exists pgcrypto;

create table if not exists public.ingredients (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  price numeric(14,4) not null check (price > 0),
  unit text not null check (unit in ('g','ml','un')),
  amount numeric(14,3) not null check (amount > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.products (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  yield integer not null check (yield > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.product_ingredients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null,
  ingredient_id uuid not null,
  amount numeric(14,3) not null check (amount > 0),
  position integer not null default 0,
  foreign key (product_id, user_id) references public.products(id, user_id) on delete cascade,
  foreign key (ingredient_id, user_id) references public.ingredients(id, user_id) on delete restrict
);

create table if not exists public.production_items (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null,
  quantity integer not null check (quantity > 0),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (product_id, user_id) references public.products(id, user_id) on delete cascade
);

create index if not exists ingredients_user_id_idx on public.ingredients(user_id);
create index if not exists products_user_id_idx on public.products(user_id);
create index if not exists product_ingredients_user_id_idx on public.product_ingredients(user_id);
create index if not exists product_ingredients_product_id_idx on public.product_ingredients(product_id);
create index if not exists production_items_user_id_idx on public.production_items(user_id);

alter table public.ingredients enable row level security;
alter table public.products enable row level security;
alter table public.product_ingredients enable row level security;
alter table public.production_items enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array['ingredients','products','product_ingredients','production_items'] loop
    execute format('drop policy if exists "Usuários acessam apenas os próprios dados" on public.%I', table_name);
    execute format(
      'create policy "Usuários acessam apenas os próprios dados" on public.%I for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      table_name
    );
  end loop;
end $$;

grant select, insert, update, delete on public.ingredients to authenticated;
grant select, insert, update, delete on public.products to authenticated;
grant select, insert, update, delete on public.product_ingredients to authenticated;
grant select, insert, update, delete on public.production_items to authenticated;
revoke all on public.ingredients, public.products, public.product_ingredients, public.production_items from anon;

-- Salva todo o estado do usuário numa única transação. auth.uid() impede
-- que o cliente escolha ou altere dados pertencentes a outra conta.
create or replace function public.save_price_state(state jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare current_user_id uuid := auth.uid();
begin
  if current_user_id is null then raise exception 'Usuário não autenticado'; end if;

  delete from public.production_items where user_id = current_user_id;
  delete from public.product_ingredients where user_id = current_user_id;
  delete from public.products where user_id = current_user_id;
  delete from public.ingredients where user_id = current_user_id;

  insert into public.ingredients (id,user_id,name,price,unit,amount)
  select (item->>'id')::uuid, current_user_id, item->>'name', (item->>'price')::numeric,
         item->>'unit', (item->>'amount')::numeric
  from jsonb_array_elements(coalesce(state->'ingredients','[]'::jsonb)) item;

  insert into public.products (id,user_id,name,yield)
  select (item->>'id')::uuid, current_user_id, item->>'name', (item->>'yield')::integer
  from jsonb_array_elements(coalesce(state->'products','[]'::jsonb)) item;

  insert into public.product_ingredients (user_id,product_id,ingredient_id,amount,position)
  select current_user_id, (product->>'id')::uuid, (ingredient->>'ingredientId')::uuid,
         (ingredient->>'amount')::numeric, ingredient_position::integer - 1
  from jsonb_array_elements(coalesce(state->'products','[]'::jsonb)) product
  cross join lateral jsonb_array_elements(coalesce(product->'items','[]'::jsonb))
    with ordinality as rows(ingredient,ingredient_position);

  insert into public.production_items (id,user_id,product_id,quantity,position)
  select (item->>'id')::uuid, current_user_id, (item->>'productId')::uuid,
         (item->>'quantity')::integer, item_position::integer - 1
  from jsonb_array_elements(coalesce(state->'production','[]'::jsonb))
    with ordinality as rows(item,item_position);
end;
$$;

grant execute on function public.save_price_state(jsonb) to authenticated;
revoke all on function public.save_price_state(jsonb) from anon;

-- A tabela user_data antiga é mantida apenas para permitir conferência/migração.
-- Depois de validar os novos dados, ela poderá ser removida manualmente.
