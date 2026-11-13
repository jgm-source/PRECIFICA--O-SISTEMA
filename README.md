# PreçoCerto

Sistema web para cadastro de insumos, fichas técnicas e cálculo de custos de produção. Os dados ficam num PostgreSQL próprio. O login é da aplicação: senha com hash scrypt, sessão em cookie `HttpOnly` e link de uso único para definir ou trocar a senha.

O navegador não acessa o banco. Ele fala só com este servidor Node, e o servidor usa a variável `DATABASE_URL`.

## Como usar

1. Abra o endereço publicado do aplicativo (ou `http://127.0.0.1:3000` no seu computador, depois de `npm start`).
2. Na primeira vez, abra o link de criação de senha, escolha uma senha e entre.
3. Cadastre os insumos informando preço, unidade e quantidade da embalagem.
4. Crie produtos e informe quanto de cada insumo é utilizado e o rendimento da receita.
5. Monte uma produção com um ou vários produtos para visualizar o investimento total e o custo médio por unidade.

Os dados são salvos na conta autenticada. Uma cópia isolada por conta fica no navegador para a tela continuar disponível sem internet; alterações pendentes são reenviadas quando a conexão volta. Use **Exportar dados** para baixar um backup em JSON. **Sair** encerra a sessão.

Não dá para abrir o `index.html` direto no disco: sem o servidor não há login nem banco.

## Variáveis de ambiente

Copie `.env.example` para `.env` na máquina local, ou cadastre as mesmas chaves no serviço do EasyPanel. O arquivo `.env` não entra no Git. Não coloque senha em código, migration ou commit.

| Variável | Obrigatória | Função |
| --- | --- | --- |
| `DATABASE_URL` | sim | Conexão do PostgreSQL. No EasyPanel, use o host interno. |
| `APP_BASE_URL` | sim, para gerar links | URL pública do aplicativo, sem barra no final. Entra no link de senha. |
| `PASSWORD_TOKEN_TTL_HOURS` | não | Prazo do link, em horas. Padrão: `72`. |
| `SESSION_TTL_DAYS` | não | Duração da sessão, em dias. Padrão: `14`. |
| `COOKIE_SECURE` | não | `true` ou `false`. Vazio: segue `X-Forwarded-Proto` e, sem esse cabeçalho, fica `true` quando `NODE_ENV=production`. |
| `PORT` | não | Porta HTTP. Padrão: `3000`. O EasyPanel pode injetar outro valor. |
| `NODE_ENV` | não | Use `production` no serviço publicado. |

Exemplo de banco na rede interna do projeto `criadordigital` (troque `SENHA`; se ela tiver `@`, `#` ou outro caractere reservado, codifique, por exemplo `@` vira `%40`):

```text
DATABASE_URL=postgres://postgres:SENHA@criadordigital_p-novo-postgresql:5432/criadordigital?sslmode=disable
APP_BASE_URL=https://precocerto.seudominio.com
```

`APP_BASE_URL` é o endereço que a Celia abre no celular. Não use o host interno do Postgres.

## Aplicar o schema num banco vazio

No diretório do projeto, com Node 20 ou superior e `DATABASE_URL` definida:

```bash
npm install
npm run db:schema
```

O comando executa, em ordem, os arquivos de `db/migrations/`. O script é idempotente: rodar de novo não apaga insumos, produtos nem contas. Ele cria as tabelas, os índices e as funções `save_price_state` e `load_price_state`. Não há dado inicial de catálogo; a conta da Celia entra no passo seguinte, de propósito sem senha.

## Cadastrar a Celia Matias

Com `DATABASE_URL` e `APP_BASE_URL` já definidas no ambiente ou no `.env`:

```bash
npm run db:seed -- --name "Celia Matias" --email "celiamatias46@gmail.com"
```

O comando cria a conta com papel `admin` e **não define senha**. Ele imprime um link de criação de senha. Envie esse link para a Celia por um canal seguro. O sistema não envia e-mail.

Se o comando for executado de novo antes de ela definir a senha, o link anterior deixa de valer e um novo é impresso. Se a conta já tiver senha, nada é alterado.

Para outra pessoa no futuro, o mesmo comando aceita outro nome e outro e-mail. `--role user` cria uma conta comum. Cada conta vê só os próprios dados. O papel `admin` marca a conta principal; a tela de precificação é a mesma.

## Esqueci a senha

A tela **Esqueci minha senha** explica o caminho. O aplicativo não envia e-mail. Quem administra gera outro link, no mesmo formato da primeira senha:

```bash
npm run password-link -- --email "celiamatias46@gmail.com"
```

O link abre `/definir-senha?token=...`. O token tem 32 bytes aleatórios, vai só no endereço e o banco guarda apenas o SHA-256. Ele expira em `PASSWORD_TOKEN_TTL_HOURS` (72 horas, se nada for alterado), serve uma vez e invalida os links anteriores da mesma conta. Ao salvar a senha, as sessões antigas são encerradas e a pessoa entra na hora.

A senha é guardada com scrypt (custo 16384, sal único). Não existe senha padrão.

## Rodar na sua máquina

```bash
npm install
npm run db:schema
npm start
```

Abra `http://127.0.0.1:3000`. Para um link local, use `APP_BASE_URL=http://127.0.0.1:3000` antes do seed. `npm run build` confere a sintaxe e os testes; os testes de banco só rodam quando `DATABASE_URL` está definida.

## Publicar no EasyPanel

O host `criadordigital_p-novo-postgresql` só existe dentro da VPS. A Vercel não consegue alcançá-lo. O aplicativo deve rodar no EasyPanel, no mesmo projeto `criadordigital`, para usar esse host na porta 5432 sem abrir o Postgres na internet.

1. No projeto `criadordigital`, crie um serviço de aplicativo a partir deste repositório.
2. Escolha o build por **Dockerfile** (já está na raiz). A imagem usa Node 22, o comando `node server.mjs` e a porta 3000.
3. Se preferir Nixpacks/buildpack em vez do Dockerfile, o start é `npm start`, com Node 20 ou superior e as mesmas variáveis. O Dockerfile é o caminho recomendado porque deixa a versão do Node fixa.
4. Domínio com HTTPS no proxy do EasyPanel. O proxy precisa encaminhar `Host` e `X-Forwarded-Proto`.
5. Variáveis do serviço: `DATABASE_URL`, `APP_BASE_URL`, `NODE_ENV=production`. Não publique a porta 5432 do `p-novo-postgresql`.
6. Depois do deploy, abra o console **desse** container (as variáveis já estão no ambiente) e execute:

```bash
npm run db:schema
npm run db:seed -- --name "Celia Matias" --email "celiamatias46@gmail.com"
```

7. Copie o link impresso e envie para a Celia. Ela define a própria senha na tela que o link abre.

Continuar na Vercel exigiria um Postgres alcançável de fora, com SSL e firewall. Isso expõe o banco e não funciona com o host interno. Não é o caminho recomendado.

## PWA para Android

O projeto inclui manifesto, ícones, service worker e aviso de atualização. Em Android com Chrome, abra o endereço publicado em HTTPS e use **Instalar app** quando o botão aparecer. `localhost` e `127.0.0.1` servem só para desenvolvimento.

## O que saiu do Supabase

Não há mais Auth, chave publicável, RLS nem PostgREST. Storage e Realtime não eram usados. O cadastro público foi desligado: conta nova só pelo comando de seed. Os dados que ainda estiverem no Supabase antigo não são copiados; o banco novo começa vazio.
