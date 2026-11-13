const LEGACY_STORAGE_KEY = 'precocerto-v1';
const CACHE_PREFIX = 'precocerto-cache-v2-';
const PENDING_PREFIX = 'precocerto-pending-v2-';
const LAST_USER_KEY = 'precocerto-last-user';
const unitNames = { g: ['grama', 'gramas'], ml: ['mililitro', 'mililitros'], un: ['unidade', 'unidades'] };
const state = { ingredients: [], products: [], production: [] };
let activeView = 'dashboard';
let recipeDraft = [];
let currentUser = null;
let setPasswordToken = '';
let saveTimer = null;
let saveQueue = Promise.resolve();
let installPrompt = null;
let refreshingServiceWorker = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);
const number = value => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 }).format(Number(value) || 0);
function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));

function loadLegacyState() {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY));
    return { ingredients: saved?.ingredients || [], products: saved?.products || [], production: saved?.production || [] };
  } catch { return { ingredients: [], products: [], production: [] }; }
}
function saveState(message) {
  if (currentUser) localStorage.setItem(`${CACHE_PREFIX}${currentUser.id}`, JSON.stringify(state));
  renderAll();
  if (message) toast(message);
  if (!currentUser) return;
  clearTimeout(saveTimer);
  setSyncStatus('Salvando...');
  saveTimer = setTimeout(() => persistState(JSON.parse(JSON.stringify(state))), 350);
}
function persistState(snapshot) {
  const saveUserId = currentUser?.id;
  if (!saveUserId) return Promise.resolve();
  saveQueue = saveQueue.then(async () => {
    try {
      await api('/api/state', { method: 'PUT', body: JSON.stringify(snapshot) });
      localStorage.removeItem(`${PENDING_PREFIX}${saveUserId}`);
      setSyncStatus('Sincronizado');
    } catch (error) {
      localStorage.setItem(`${PENDING_PREFIX}${saveUserId}`, JSON.stringify(snapshot));
      console.error('Falha ao sincronizar:', error.status || error.message);
      if (error.status === 401) {
        toast('Sua sessão expirou. Entre novamente.');
        leaveApplication();
        return;
      }
      setSyncStatus(navigator.onLine ? 'Erro ao sincronizar' : 'Aguardando conexão', true);
      if (navigator.onLine) toast(error.message || 'Não foi possível salvar no servidor.');
    }
  }).catch(error => console.error(error));
  return saveQueue;
}
function ingredientCost(id, amount) { const item = state.ingredients.find(i => i.id === id); return item ? (item.price / item.amount) * amount : 0; }
function productCost(product) { return product.items.reduce((sum, item) => sum + ingredientCost(item.ingredientId, item.amount), 0); }
function unitCost(product) { return productCost(product) / product.yield; }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2600); }
function setSyncStatus(message, error = false) { const el=$('#syncStatus'); el.textContent=message; el.classList.toggle('error',error); el.classList.add('show'); clearTimeout(setSyncStatus.timer); setSyncStatus.timer=setTimeout(()=>el.classList.remove('show'),error?5000:1800); }

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body
    });
  } catch {
    const failure = new Error('Sem conexão com o servidor.');
    failure.status = 0;
    throw failure;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(data.error || 'Não foi possível concluir a operação.');
    failure.status = response.status;
    throw failure;
  }
  return data;
}
function showAccount(user) {
  const account = $('#userEmail');
  account.textContent = user.name || user.email || '';
  account.title = user.email || '';
}
function readLastUser() {
  try {
    const user = JSON.parse(localStorage.getItem(LAST_USER_KEY));
    return user?.id ? user : null;
  } catch { return null; }
}
function rememberUser(user) {
  localStorage.setItem(LAST_USER_KEY, JSON.stringify({ id: user.id, email: user.email, name: user.name, role: user.role }));
}
async function initializeAuth() {
  if (location.pathname === '/definir-senha') {
    await openSetPassword();
    return;
  }
  try {
    const data = await api('/api/session');
    if (data.user) await enterApplication(data.user);
  } catch (error) {
    const last = readLastUser();
    if (last && (error.status === 0 || error.status === 503 || !navigator.onLine)) {
      enterOffline(last);
      toast(error.message || 'Sem conexão. Mostrando a cópia deste navegador.');
      return;
    }
    if (error.message) showAuthMessage(error.message);
  }
}
function enterOffline(user) {
  currentUser = user;
  showAccount(user);
  $('#authScreen').classList.add('authenticated');
  Object.assign(state, readUserCache(user.id));
  const pending = readPendingState(user.id);
  if (pending) Object.assign(state, pending);
  renderAll();
  setSyncStatus('Modo offline', true);
}
async function enterApplication(user) {
  currentUser = user;
  rememberUser(user);
  showAccount(user);
  $('#authScreen').classList.add('authenticated');
  setSyncStatus('Carregando dados...');
  let remote;
  try {
    remote = await loadRemoteState();
  } catch (error) {
    if (error.status === 401) {
      leaveApplication();
      showAuthMessage(error.message);
      return;
    }
    Object.assign(state, readUserCache(user.id));
    renderAll();
    setSyncStatus('Erro ao carregar dados', true);
    toast(error.message || 'Não foi possível carregar os dados.');
    return;
  }
  Object.assign(state, remote);
  const pending = readPendingState(user.id);
  if (pending) {
    Object.assign(state, pending);
    await persistState(JSON.parse(JSON.stringify(state)));
    if (!currentUser) return;
    if (!readPendingState(user.id)) toast('Alterações pendentes foram sincronizadas.');
  }
  const hasRemoteData = state.ingredients.length || state.products.length || state.production.length;
  const legacy = loadLegacyState();
  const hasLegacyData = legacy.ingredients.length || legacy.products.length || legacy.production.length;
  const migrationOwner = localStorage.getItem('precocerto-legacy-migrated-user');
  if (!hasRemoteData && hasLegacyData && !migrationOwner) {
    Object.assign(state, legacy);
    await persistState(JSON.parse(JSON.stringify(state)));
    if (!currentUser) return;
    localStorage.setItem('precocerto-legacy-migrated-user', user.id);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    toast('Dados anteriores deste navegador foram copiados para a sua conta.');
  }
  localStorage.setItem(`${CACHE_PREFIX}${user.id}`, JSON.stringify(state));
  renderAll();
  setSyncStatus('Sincronizado');
}
async function loadRemoteState() {
  return api('/api/state');
}
function readUserCache(userId){try{const saved=JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${userId}`));return{ingredients:saved?.ingredients||[],products:saved?.products||[],production:saved?.production||[]}}catch{return{ingredients:[],products:[],production:[]}}}
function readPendingState(userId){try{return JSON.parse(localStorage.getItem(`${PENDING_PREFIX}${userId}`))||null}catch{return null}}
function showLoginPanel() {
  document.documentElement.classList.remove('set-password');
  $('#loginPanel').classList.remove('hidden');
  $('#forgotPanel').classList.add('hidden');
  $('#setPasswordPanel').classList.add('hidden');
  $('#setPasswordForm').classList.remove('hidden');
  showAuthMessage('');
}
function leaveApplication() {
  currentUser = null;
  localStorage.removeItem(LAST_USER_KEY);
  state.ingredients = [];
  state.products = [];
  state.production = [];
  renderAll();
  showLoginPanel();
  $('#authScreen').classList.remove('authenticated');
  $('#userEmail').textContent = '';
  $('#userEmail').title = '';
  if (location.pathname === '/definir-senha') history.replaceState({}, '', '/');
}

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
function showAuthMessage(message, success = false) {
  const el = $('#authMessage');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
  el.classList.toggle('success', success);
}
function showSetMessage(message, success = false) {
  const el = $('#setPasswordMessage');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
  el.classList.toggle('success', success);
}
$('#forgotButton').addEventListener('click', () => {
  $('#loginPanel').classList.add('hidden');
  $('#forgotPanel').classList.remove('hidden');
  showAuthMessage('');
});
$('#backToLogin').addEventListener('click', () => {
  $('#forgotPanel').classList.add('hidden');
  $('#loginPanel').classList.remove('hidden');
});
$('#authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#authSubmit');
  showAuthMessage('');
  button.disabled = true;
  button.textContent = 'Entrando...';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#authEmail').value.trim(), password: $('#authPassword').value })
    });
    await enterApplication(data.user);
  } catch (error) {
    showAuthMessage(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Entrar';
  }
});
async function openSetPassword() {
  $('#loginPanel').classList.add('hidden');
  $('#forgotPanel').classList.add('hidden');
  $('#setPasswordPanel').classList.remove('hidden');
  setPasswordToken = new URLSearchParams(location.search).get('token') || '';
  if (!setPasswordToken) {
    showSetMessage('Este link está incompleto. Peça um novo link de definição de senha.');
    $('#setPasswordForm').classList.add('hidden');
    return;
  }
  try {
    const data = await api(`/api/password-token?token=${encodeURIComponent(setPasswordToken)}`);
    const intro = data.purpose === 'reset'
      ? 'Escolha uma nova senha. A senha anterior deixa de valer.'
      : 'Crie a senha para entrar no PreçoCerto.';
    $('#setPasswordIntro').textContent = `${intro} Conta de ${data.name}: ${data.email}.`;
  } catch (error) {
    showSetMessage(error.message || 'Este link é inválido ou expirou.');
    $('#setPasswordForm').classList.add('hidden');
  }
}
$('#setPasswordForm').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('#newPassword').value;
  const confirmation = $('#confirmPassword').value;
  if (password !== confirmation) {
    showSetMessage('As senhas não conferem.');
    return;
  }
  const button = $('#setPasswordSubmit');
  button.disabled = true;
  button.textContent = 'Salvando...';
  showSetMessage('');
  try {
    const data = await api('/api/password', { method: 'POST', body: JSON.stringify({ token: setPasswordToken, password }) });
    history.replaceState({}, '', '/');
    showSetMessage('Senha definida. Entrando...', true);
    await enterApplication(data.user);
  } catch (error) {
    showSetMessage(error.message);
    button.disabled = false;
    button.textContent = 'Salvar senha e entrar';
  }
});
$('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch { /* a tela de login aparece mesmo sem resposta */ }
  leaveApplication();
});
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
renderAll();updateNetworkStatus();initializePwa();initializeAuth();
