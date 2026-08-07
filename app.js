const LEGACY_STORAGE_KEY = 'precocerto-v1';
const CACHE_PREFIX = 'precocerto-cache-v2-';
const PENDING_PREFIX = 'precocerto-pending-v2-';
const unitNames = { g: ['grama', 'gramas'], ml: ['mililitro', 'mililitros'], un: ['unidade', 'unidades'] };
const state = { ingredients: [], products: [], production: [] };
let activeView = 'dashboard';
let recipeDraft = [];
let supabaseClient = null;
let currentUser = null;
let authMode = 'login';
let saveTimer = null;
let saveQueue = Promise.resolve();
let installPrompt = null;
let refreshingServiceWorker = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);
const number = value => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(Number(value) || 0);
const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));

function loadLegacyState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY));
    return { ingredients: saved?.ingredients || [], products: saved?.products || [], production: saved?.production || [] };
  } catch { return { ingredients: [], products: [], production: [] }; }
}
function saveState(message) {
  if (currentUser) localStorage.setItem(`${CACHE_PREFIX}${currentUser.id}`, JSON.stringify(state));
  renderAll(); if (message) toast(message);
  if (!supabaseClient || !currentUser) return;
  clearTimeout(saveTimer); setSyncStatus('Salvando...');
  saveTimer = setTimeout(() => persistState(JSON.parse(JSON.stringify(state))), 350);
}
function persistState(snapshot) {
  const saveUserId = currentUser?.id;
  if (!saveUserId) return Promise.resolve();
  saveQueue = saveQueue.then(async()=>{
    const { error } = await supabaseClient.rpc('save_price_state', { state: snapshot });
    if (error) { localStorage.setItem(`${PENDING_PREFIX}${saveUserId}`,JSON.stringify(snapshot));console.error('Falha ao sincronizar:',error.code);setSyncStatus(navigator.onLine?'Erro ao sincronizar':'Aguardando conexão',true);if(navigator.onLine)toast('Não foi possível salvar no Supabase. Confira se o novo SQL foi executado.'); }
    else { localStorage.removeItem(`${PENDING_PREFIX}${saveUserId}`);setSyncStatus('Sincronizado'); }
  });
  return saveQueue;
}
function ingredientCost(id, amount) { const item = state.ingredients.find(i => i.id === id); return item ? (item.price / item.amount) * amount : 0; }
function productCost(product) { return product.items.reduce((sum, item) => sum + ingredientCost(item.ingredientId, item.amount), 0); }
function unitCost(product) { return productCost(product) / product.yield; }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2600); }
function setSyncStatus(message, error = false) { const el=$('#syncStatus'); el.textContent=message; el.classList.toggle('error',error); el.classList.add('show'); clearTimeout(setSyncStatus.timer); setSyncStatus.timer=setTimeout(()=>el.classList.remove('show'),error?5000:1800); }

async function initializeSupabase() {
  try {
    const response = await fetch('/api/config', { cache:'no-store' });
    if (response.ok) { const config=await response.json();if(config.url&&config.publishableKey)window.SUPABASE_CONFIG=config; }
  } catch {}
  if (!window.SUPABASE_CONFIG) {
    try {
      const source = await fetch(`supabase-config.js?fresh=${Date.now()}`, { cache:'no-store' }).then(response=>response.text());
      const url = source.match(/url\s*:\s*['"]([^'"]+)['"]/i)?.[1];
      const publishableKey = source.match(/publishableKey\s*:\s*['"]([^'"]+)['"]/i)?.[1];
      if (url && publishableKey) window.SUPABASE_CONFIG = { url, publishableKey };
    } catch {}
  }
  let supabaseApi = window.supabase;
  if (!window.supabase) {
    try { supabaseApi = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'); } catch {}
  }
  const config = window.SUPABASE_CONFIG || {};
  const normalizedUrl = String(config.url || '').trim().replace(/\/+$/, '');
  const configured = /^https:\/\/.+\.supabase\.co$/.test(normalizedUrl) && config.publishableKey && !config.publishableKey.includes('COLE_');
  $('#authConfigured').classList.toggle('hidden', !configured); $('#authNotConfigured').classList.toggle('hidden', configured);
  if (!configured) return;
  if (!supabaseApi) { $('#authConfigured').classList.add('hidden'); $('#authNotConfigured').classList.remove('hidden'); $('#authNotConfigured').innerHTML='<span class="eyebrow">ERRO DE CONEXÃO</span><h2>Não foi possível carregar o Supabase</h2><p>Verifique sua conexão com a internet e atualize a página.</p>'; return; }
  supabaseClient = supabaseApi.createClient(normalizedUrl, config.publishableKey.trim(), { auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) await enterApplication(data.session.user);
  supabaseClient.auth.onAuthStateChange((event, session) => setTimeout(async()=>{
    if (session?.user && session.user.id !== currentUser?.id) await enterApplication(session.user);
    if (!session) leaveApplication();
  },0));
}
async function enterApplication(user) {
  currentUser=user; $('#userEmail').textContent=user.email || ''; $('#authScreen').classList.add('authenticated'); setSyncStatus('Carregando dados...');
  const remote = await loadRemoteState(user.id);
  if (remote.error) {
    const cached = readUserCache(user.id); Object.assign(state,cached);
    renderAll(); setSyncStatus('Erro ao carregar dados',true); toast('Execute o novo arquivo supabase-setup.sql para liberar o banco relacional.'); return;
  }
  Object.assign(state,remote.state);
  const pending = readPendingState(user.id);
  if (pending) { Object.assign(state,pending);await persistState(JSON.parse(JSON.stringify(state)));toast('Alterações pendentes foram sincronizadas.'); }
  const hasRemoteData = state.ingredients.length || state.products.length || state.production.length;
  const legacy = loadLegacyState();
  const hasLegacyData = legacy.ingredients.length || legacy.products.length || legacy.production.length;
  const migrationOwner = localStorage.getItem('precocerto-legacy-migrated-user');
  if (!hasRemoteData && hasLegacyData && !migrationOwner) {
    Object.assign(state,legacy); await persistState(JSON.parse(JSON.stringify(state)));
    localStorage.setItem('precocerto-legacy-migrated-user',user.id); localStorage.removeItem(LEGACY_STORAGE_KEY);
    toast('Dados anteriores migrados para sua conta no Supabase.');
  }
  localStorage.setItem(`${CACHE_PREFIX}${user.id}`,JSON.stringify(state)); renderAll(); setSyncStatus('Sincronizado');
}
async function loadRemoteState(userId) {
  const [ingredientsResult,productsResult,recipeResult,productionResult] = await Promise.all([
    supabaseClient.from('ingredients').select('id,name,price,unit,amount,created_at').eq('user_id',userId).order('created_at'),
    supabaseClient.from('products').select('id,name,yield,created_at').eq('user_id',userId).order('created_at'),
    supabaseClient.from('product_ingredients').select('product_id,ingredient_id,amount,position').eq('user_id',userId).order('position'),
    supabaseClient.from('production_items').select('id,product_id,quantity,position').eq('user_id',userId).order('position')
  ]);
  const error = ingredientsResult.error || productsResult.error || recipeResult.error || productionResult.error;
  if (error) return { error };
  const ingredients=(ingredientsResult.data||[]).map(i=>({id:i.id,name:i.name,price:Number(i.price),unit:i.unit,amount:Number(i.amount)}));
  const products=(productsResult.data||[]).map(p=>({id:p.id,name:p.name,yield:Number(p.yield),items:(recipeResult.data||[]).filter(i=>i.product_id===p.id).map(i=>({ingredientId:i.ingredient_id,amount:Number(i.amount)}))}));
  const production=(productionResult.data||[]).map(i=>({id:i.id,productId:i.product_id,quantity:Number(i.quantity)}));
  return { state:{ingredients,products,production} };
}
function readUserCache(userId){try{const saved=JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${userId}`));return{ingredients:saved?.ingredients||[],products:saved?.products||[],production:saved?.production||[]}}catch{return{ingredients:[],products:[],production:[]}}}
function readPendingState(userId){try{return JSON.parse(localStorage.getItem(`${PENDING_PREFIX}${userId}`))||null}catch{return null}}
function leaveApplication(){currentUser=null;state.ingredients=[];state.products=[];state.production=[];renderAll();$('#authScreen').classList.remove('authenticated');$('#userEmail').textContent='';}

function showView(view) {
  activeView = view;
  const titles = { dashboard: ['PAINEL','Visão geral'], ingredients: ['CADASTRO','Insumos'], products: ['FICHAS TÉCNICAS','Produtos'], production: ['SIMULAÇÃO','Produção'] };
  $$('.view').forEach(el => el.classList.toggle('active', el.id === `${view}View`));
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  $('#pageEyebrow').textContent = titles[view][0]; $('#pageTitle').textContent = titles[view][1];
  $('.sidebar').classList.remove('open'); renderAll();
}

function renderAll() { renderDashboard(); renderIngredients(); renderProducts(); renderProduction(); }
function renderDashboard() {
  $('#statIngredients').textContent = state.ingredients.length;
  $('#statProducts').textContent = state.products.length;
  const total = state.production.reduce((sum, row) => { const p = state.products.find(x => x.id === row.productId); return sum + (p ? unitCost(p) * row.quantity : 0); }, 0);
  $('#statProduction').textContent = money(total);
  const recent = state.products.slice(-3).reverse();
  $('#recentProducts').innerHTML = recent.length ? recent.map(p => `<div class="step"><b>▣</b><span><strong>${escapeHtml(p.name)}</strong><small>${money(unitCost(p))} por unidade</small></span></div>`).join('') : '<span>▣</span><p>Nenhum produto cadastrado ainda.</p>';
}
function renderIngredients() {
  const term = $('#ingredientSearch').value.toLowerCase();
  const rows = state.ingredients.filter(i => i.name.toLowerCase().includes(term));
  $('#ingredientCount').textContent = `${state.ingredients.length} ${state.ingredients.length === 1 ? 'insumo' : 'insumos'}`;
  $('#ingredientTableBody').innerHTML = rows.map(i => `<tr><td><strong>${escapeHtml(i.name)}</strong><small>${unitNames[i.unit][0][0].toUpperCase()+unitNames[i.unit][0].slice(1)}</small></td><td>${number(i.amount)} ${unitNames[i.unit][1]}</td><td><strong>${money(i.price)}</strong></td><td><strong>${money(i.price/i.amount)}</strong><small>por ${unitNames[i.unit][0]}</small></td><td><div class="row-actions"><button class="icon-button" data-edit-ingredient="${i.id}" title="Editar">✎</button><button class="icon-button danger" data-delete-ingredient="${i.id}" title="Excluir">×</button></div></td></tr>`).join('');
  $('#ingredientEmpty').classList.toggle('hidden', state.ingredients.length > 0);
  $('.table-wrap').classList.toggle('hidden', state.ingredients.length === 0);
}
function renderProducts() {
  const term = $('#productSearch').value.toLowerCase(); const products = state.products.filter(p => p.name.toLowerCase().includes(term));
  $('#productCount').textContent = `${state.products.length} ${state.products.length === 1 ? 'produto' : 'produtos'}`;
  $('#productGrid').innerHTML = products.map(p => `<article class="product-card"><div class="product-card-head"><div class="product-badge">▣</div><div class="row-actions"><button class="icon-button" data-edit-product="${p.id}" title="Editar">✎</button><button class="icon-button danger" data-delete-product="${p.id}" title="Excluir">×</button></div></div><h3>${escapeHtml(p.name)}</h3><p>${p.items.length} ${p.items.length === 1 ? 'insumo' : 'insumos'} · Rendimento: ${p.yield} un.</p><div class="product-costs"><div><span>CUSTO DA RECEITA</span><strong>${money(productCost(p))}</strong></div><div><span>POR UNIDADE</span><strong>${money(unitCost(p))}</strong></div></div></article>`).join('');
  $('#productEmpty').classList.toggle('hidden', state.products.length > 0);
}
function renderProduction() {
  state.production = state.production.filter(row => state.products.some(p => p.id === row.productId));
  let total = 0, units = 0;
  $('#productionRows').innerHTML = state.production.map(row => { const p = state.products.find(x => x.id === row.productId); const cost = unitCost(p)*row.quantity; total += cost; units += row.quantity; return `<div class="production-row"><div><strong>${escapeHtml(p.name)}</strong><small>${money(unitCost(p))} por unidade</small></div><div><span>QUANTIDADE</span><input type="number" min="1" step="1" value="${row.quantity}" data-production-quantity="${row.id}"></div><div><span>CUSTO</span><strong>${money(cost)}</strong></div><button class="icon-button danger" data-remove-production="${row.id}">×</button></div>`; }).join('');
  $('#productionEmpty').classList.toggle('hidden', state.production.length > 0);
  $('#productionTotal').textContent = money(total); $('#productionUnits').textContent = `${units} ${units === 1 ? 'unidade produzida' : 'unidades produzidas'}`;
  $('#productionKinds').textContent = state.production.length; $('#productionAverage').textContent = money(units ? total/units : 0);
}

function openIngredient(id) {
  const item = state.ingredients.find(i => i.id === id);
  $('#ingredientForm').reset(); $('#ingredientId').value = item?.id || ''; $('#ingredientName').value = item?.name || ''; $('#ingredientPrice').value = item?.price || ''; $('#ingredientUnit').value = item?.unit || 'g'; $('#ingredientAmount').value = item?.amount || '';
  $('#ingredientModalTitle').textContent = item ? 'Editar insumo' : 'Novo insumo'; updateIngredientPreview(); $('#ingredientDialog').showModal();
}
function updateIngredientPreview() {
  const unit = $('#ingredientUnit').value; const cost = Number($('#ingredientPrice').value)/Number($('#ingredientAmount').value);
  $('#previewUnit').textContent = unitNames[unit][0]; $('#amountHelp').textContent = `Informe quantos ${unitNames[unit][1]} há na embalagem comprada.`; $('#ingredientPreview').textContent = Number.isFinite(cost) ? money(cost).replace(/,\d{2}$/, m => m + '00') : 'R$ 0,0000';
}
function openProduct(id) {
  if (!state.ingredients.length) { showView('ingredients'); toast('Cadastre pelo menos um insumo primeiro.'); return; }
  const product = state.products.find(p => p.id === id); $('#productForm').reset(); $('#productId').value = product?.id || ''; $('#productName').value = product?.name || ''; $('#productYield').value = product?.yield || 1; recipeDraft = product ? product.items.map(x => ({...x})) : [];
  $('#productModalTitle').textContent = product ? 'Editar produto' : 'Novo produto'; renderRecipeRows(); $('#productDialog').showModal();
}
function addRecipeRow(item = {}) { recipeDraft.push({ id: uid(), ingredientId: item.ingredientId || state.ingredients[0].id, amount: item.amount || 1 }); renderRecipeRows(); }
function renderRecipeRows() {
  $('#recipeRows').innerHTML = recipeDraft.map((row, index) => { const ing = state.ingredients.find(i => i.id === row.ingredientId); return `<div class="recipe-row"><select data-recipe-ingredient="${index}">${state.ingredients.map(i => `<option value="${i.id}" ${i.id===row.ingredientId?'selected':''}>${escapeHtml(i.name)} (${i.unit})</option>`).join('')}</select><input type="number" min="0.001" step="0.001" value="${row.amount}" data-recipe-amount="${index}" aria-label="Quantidade usada"><div class="line-cost">${money(ingredientCost(row.ingredientId,row.amount))}</div><button class="icon-button danger remove-recipe" type="button" data-remove-recipe="${index}">×</button></div>`; }).join('');
  $('#recipeEmpty').classList.toggle('hidden', recipeDraft.length > 0); updateRecipeTotal();
}
function updateRecipeTotal() { const total=recipeDraft.reduce((s,r)=>s+ingredientCost(r.ingredientId,r.amount),0), y=Number($('#productYield').value)||1; $('#recipeTotal').textContent=money(total); $('#recipeUnitCost').textContent=`${money(total/y)} por unidade`; }
function openProduction() {
  if (!state.products.length) { showView('products'); toast('Crie pelo menos um produto primeiro.'); return; }
  $('#productionProduct').innerHTML = state.products.map(p=>`<option value="${p.id}">${escapeHtml(p.name)} — ${money(unitCost(p))}/un.</option>`).join(''); $('#productionQuantity').value=1; updateProductionPreview(); $('#productionDialog').showModal();
}
function updateProductionPreview(){const p=state.products.find(x=>x.id===$('#productionProduct').value);$('#productionPreview').textContent=money(p?unitCost(p)*(Number($('#productionQuantity').value)||0):0)}

$$('.nav-item').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view))); $$('[data-go]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.go)));
$('#menuButton').addEventListener('click',()=>$('.sidebar').classList.toggle('open')); $('#ingredientSearch').addEventListener('input',renderIngredients); $('#productSearch').addEventListener('input',renderProducts);
$('#newIngredientButton').addEventListener('click',()=>openIngredient()); $('#newProductButton').addEventListener('click',()=>openProduct()); $('#addProductionButton').addEventListener('click',openProduction);
document.addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b)return; if(b.hasAttribute('data-close-dialog')){b.closest('dialog')?.close();return} if(b.dataset.action==='new-ingredient')openIngredient(); if(b.dataset.action==='new-product')openProduct(); if(b.dataset.editIngredient)openIngredient(b.dataset.editIngredient); if(b.dataset.deleteIngredient){const used=state.products.some(p=>p.items.some(i=>i.ingredientId===b.dataset.deleteIngredient));if(used)return toast('Este insumo está sendo usado em um produto.');if(confirm('Excluir este insumo?')){state.ingredients=state.ingredients.filter(i=>i.id!==b.dataset.deleteIngredient);saveState('Insumo excluído.')}} if(b.dataset.editProduct)openProduct(b.dataset.editProduct); if(b.dataset.deleteProduct&&confirm('Excluir este produto e removê-lo da produção?')){state.products=state.products.filter(p=>p.id!==b.dataset.deleteProduct);state.production=state.production.filter(r=>r.productId!==b.dataset.deleteProduct);saveState('Produto excluído.')} if(b.dataset.removeRecipe!==undefined){recipeDraft.splice(Number(b.dataset.removeRecipe),1);renderRecipeRows()} if(b.dataset.removeProduction){state.production=state.production.filter(r=>r.id!==b.dataset.removeProduction);saveState('Produto removido da produção.')}});
['ingredientPrice','ingredientAmount','ingredientUnit'].forEach(id=>$('#'+id).addEventListener('input',updateIngredientPreview));
$('#ingredientForm').addEventListener('submit',e=>{e.preventDefault();const data={id:$('#ingredientId').value||uid(),name:$('#ingredientName').value.trim(),price:Number($('#ingredientPrice').value),unit:$('#ingredientUnit').value,amount:Number($('#ingredientAmount').value)};if(!data.name||data.price<=0||data.amount<=0)return;const ix=state.ingredients.findIndex(i=>i.id===data.id);ix>=0?state.ingredients[ix]=data:state.ingredients.push(data);$('#ingredientDialog').close();saveState(ix>=0?'Insumo atualizado.':'Insumo cadastrado.');});
$('#addRecipeItemButton').addEventListener('click',()=>addRecipeRow()); $('#productYield').addEventListener('input',updateRecipeTotal);
$('#recipeRows').addEventListener('input',e=>{let i;if(e.target.dataset.recipeIngredient!==undefined){i=Number(e.target.dataset.recipeIngredient);recipeDraft[i].ingredientId=e.target.value}if(e.target.dataset.recipeAmount!==undefined){i=Number(e.target.dataset.recipeAmount);recipeDraft[i].amount=Number(e.target.value)}renderRecipeRows()});
$('#productForm').addEventListener('submit',e=>{e.preventDefault();if(!recipeDraft.length)return toast('Adicione pelo menos um insumo.');if(recipeDraft.some(r=>!r.ingredientId||r.amount<=0))return toast('Revise as quantidades dos insumos.');const data={id:$('#productId').value||uid(),name:$('#productName').value.trim(),yield:Number($('#productYield').value),items:recipeDraft.map(r=>({ingredientId:r.ingredientId,amount:r.amount}))};if(!data.name||data.yield<1)return;const ix=state.products.findIndex(p=>p.id===data.id);ix>=0?state.products[ix]=data:state.products.push(data);$('#productDialog').close();saveState(ix>=0?'Produto atualizado.':'Produto cadastrado.');});
$('#productionProduct').addEventListener('change',updateProductionPreview);$('#productionQuantity').addEventListener('input',updateProductionPreview);
$('#productionForm').addEventListener('submit',e=>{e.preventDefault();const productId=$('#productionProduct').value,quantity=Number($('#productionQuantity').value);if(quantity<1)return;const existing=state.production.find(r=>r.productId===productId);existing?existing.quantity+=quantity:state.production.push({id:uid(),productId,quantity});$('#productionDialog').close();saveState('Produto adicionado à produção.');});
$('#productionRows').addEventListener('change',e=>{if(e.target.dataset.productionQuantity){const row=state.production.find(r=>r.id===e.target.dataset.productionQuantity);row.quantity=Math.max(1,Number(e.target.value)||1);saveState();}});
$('#printButton').addEventListener('click',()=>window.print());
$('#authToggle').addEventListener('click',()=>{authMode=authMode==='login'?'signup':'login';const signup=authMode==='signup';$('#authTitle').textContent=signup?'Crie sua conta':'Entre na sua conta';$('#authDescription').textContent=signup?'Seus dados ficarão seguros e disponíveis em seus dispositivos.':'Acesse seus insumos e produtos de qualquer dispositivo.';$('#authSubmit').disabled=false;$('#authSubmit').textContent=signup?'Criar conta':'Entrar';$('#authToggle').textContent=signup?'Já tenho uma conta':'Ainda não tenho uma conta';$('#authPassword').autocomplete=signup?'new-password':'current-password';showAuthMessage('');});
function showAuthMessage(message,success=false){const el=$('#authMessage');el.textContent=message;el.classList.toggle('hidden',!message);el.classList.toggle('success',success)}
function authErrorMessage(error){const messages={invalid_credentials:'E-mail ou senha incorretos.',email_not_confirmed:'Confirme seu e-mail antes de entrar.',user_already_exists:'Este e-mail já possui uma conta. Clique em “Já tenho uma conta” para entrar.',signup_disabled:'A criação de contas está desativada no Supabase.',over_email_send_rate_limit:'O e-mail atingiu o limite de envios, mas sua conta pode já ter sido criada. Clique em “Já tenho uma conta” e tente entrar.'};return messages[error?.code]||error?.message||'Não foi possível conectar ao Supabase.'}
$('#authForm').addEventListener('submit',async e=>{e.preventDefault();const button=$('#authSubmit'),email=$('#authEmail').value.trim(),password=$('#authPassword').value,signup=authMode==='signup';let keepDisabled=false;showAuthMessage('');button.disabled=true;button.textContent=signup?'Criando conta...':'Entrando...';try{const result=signup?await supabaseClient.auth.signUp({email,password}):await supabaseClient.auth.signInWithPassword({email,password});if(result.error){showAuthMessage(authErrorMessage(result.error));return}if(signup&&!result.data.session){keepDisabled=true;button.textContent='E-mail de confirmação enviado';showAuthMessage('Conta criada! Enviamos um e-mail de confirmação. Abra sua caixa de entrada e clique no link para liberar o acesso.',true)}else if(signup){keepDisabled=true;button.textContent='Conta criada';showAuthMessage('Conta criada com sucesso. Entrando...',true)}}catch(error){showAuthMessage(authErrorMessage(error))}finally{button.disabled=keepDisabled;if(!keepDisabled)button.textContent=signup?'Criar conta':'Entrar'}});
$('#logoutButton').addEventListener('click',async()=>{if(supabaseClient)await supabaseClient.auth.signOut();leaveApplication();});
$('#exportButton').addEventListener('click',()=>{const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`precocerto-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);toast('Backup exportado.');});

function updateNetworkStatus(){const offline=!navigator.onLine;$('#networkBanner').classList.toggle('hidden',!offline);if(offline)setSyncStatus('Modo offline',true)}
window.addEventListener('offline',updateNetworkStatus);
window.addEventListener('online',async()=>{updateNetworkStatus();if(currentUser){const pending=readPendingState(currentUser.id);if(pending){setSyncStatus('Sincronizando...');await persistState(pending);}}});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('#installButton').classList.remove('hidden')});
window.addEventListener('appinstalled',()=>{installPrompt=null;$('#installButton').classList.add('hidden');toast('PreçoCerto instalado com sucesso.')});
$('#installButton').addEventListener('click',async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('#installButton').classList.add('hidden')});

async function initializePwa(){
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration=await navigator.serviceWorker.register('/service-worker.js');
    if(registration.waiting)$('#updateBanner').classList.remove('hidden');
    registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)$('#updateBanner').classList.remove('hidden')})});
    $('#updateButton').addEventListener('click',()=>registration.waiting?.postMessage({type:'SKIP_WAITING'}));
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(refreshingServiceWorker)return;refreshingServiceWorker=true;location.reload()});
  } catch(error) { console.error('Service worker não registrado:',error); }
}

const requestedView=new URLSearchParams(location.search).get('view');
if(['ingredients','products','production'].includes(requestedView))showView(requestedView);
renderAll();updateNetworkStatus();initializePwa();initializeSupabase();
