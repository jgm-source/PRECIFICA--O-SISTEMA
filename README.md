# PreçoCerto

Sistema web local para cadastro de insumos, criação de fichas técnicas e cálculo de custos de produção.

## Como usar

Abra o arquivo `index.html` em um navegador moderno. Não é necessário instalar dependências. Se preferir executar com um servidor local, use `node server.mjs` e acesse `http://127.0.0.1:4173`.

1. Cadastre os insumos informando preço, unidade e quantidade da embalagem.
2. Crie produtos e informe quanto de cada insumo é utilizado e o rendimento da receita.
3. Monte uma produção com um ou vários produtos para visualizar o investimento total e o custo médio por unidade.

Os dados são salvos no Supabase e associados ao usuário autenticado. Um cache isolado por conta mantém a interface disponível sem internet e alterações pendentes são reenviadas quando a conexão volta. Use **Exportar dados** para baixar um backup em JSON.

## Configurar login e banco Supabase

1. Crie um projeto em `https://supabase.com`.
2. Abra **SQL Editor**, cole todo o conteúdo de `supabase-setup.sql` e execute. O script cria as tabelas relacionais `ingredients`, `products`, `product_ingredients` e `production_items`, além das políticas RLS por usuário.
3. Em **Project Settings → API**, copie a URL do projeto e a chave **Publishable**.
4. Copie `supabase-config.example.js` para `supabase-config.js` e cole nele os dois valores. O arquivo real está no `.gitignore` e não será enviado ao GitHub. Nunca use uma chave `secret` ou `service_role` no navegador.
5. Em **Authentication → URL Configuration**, defina a URL pública do aplicativo e inclua-a nas Redirect URLs.
6. Atualize o navegador. O sistema exibirá a tela de criar conta ou entrar.

Na primeira entrada, cadastros legados que já existirem no navegador serão migrados uma única vez para a primeira conta autenticada. Depois disso, o Supabase será a fonte oficial dos dados. Um cache local separado pelo ID do usuário é mantido apenas para contingência e nunca é compartilhado entre contas.

## PWA para Android

O projeto inclui manifesto, ícones comuns e maskable, service worker, cache do aplicativo, aviso de atualização, fila offline por usuário e botão de instalação. Em Android com Chrome, abra o endereço publicado e use **Instalar app** quando o botão aparecer. A instalação exige HTTPS; `localhost` e `127.0.0.1` são aceitos somente para desenvolvimento.

## Publicar na Vercel

1. Envie o projeto para um repositório GitHub e importe-o na Vercel com o preset **Other**.
2. Não informe comando de build e deixe o diretório de saída sem sobrescrever, pois o projeto é estático e está na raiz.
3. Em **Settings → Environment Variables**, adicione `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` para Production, Preview e Development.
4. Faça um novo deploy após cadastrar as variáveis.
5. No Supabase, em **Authentication → URL Configuration**, use o domínio de produção da Vercel como **Site URL** e adicione o mesmo domínio às **Redirect URLs**.
6. Abra a aplicação publicada duas vezes no Chrome Android para garantir que o service worker assumiu o controle e então instale o app.

O endpoint `/api/config` fornece ao navegador apenas a URL e a chave pública. Chaves `secret` e `service_role` nunca devem ser cadastradas na Vercel para uso por este frontend.
