/* ═══════════════════════════════════════════════════════════
   AGILBANK — APP.JS
   Sistema de Gestão de Empréstimos
════════════════════════════════════════════════════════════ */

'use strict';

// ─── SERVICE WORKER REGISTRATION ────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.error('SW Error:', err));
  });
}

// ─── PWA INSTALL PROMPT (Android & iOS) ─────────────────────
let deferredPrompt;

// Check if device is iOS
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
// Check if already installed
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

if (isIOS && !isStandalone) {
  // iOS fallback since it doesn't support beforeinstallprompt
  setTimeout(() => {
    const banner = document.getElementById('pwa-install-banner');
    const text = document.querySelector('#pwa-install-banner .pwa-text p');
    const installBtn = document.querySelector('#pwa-install-banner .btn-primary-small');
    if (text) text.innerHTML = 'Toque em <b style="font-size:16px;">[↑] Compartilhar</b> e depois em <br><b>[+] Adicionar à Tela de Início</b>.';
    if (installBtn) {
      installBtn.textContent = 'Instalar';
      installBtn.style.display = 'inline-block';
    }
    if (banner) banner.classList.add('show');
  }, 2500);
} else if (!isIOS) {
  // Android / Chrome
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    setTimeout(() => {
      const banner = document.getElementById('pwa-install-banner');
      if (banner) banner.classList.add('show');
    }, 2500);
  });
}

function installApp() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then((choiceResult) => {
      console.log('PWA Setup:', choiceResult.outcome);
      deferredPrompt = null;
    });
    closeInstallBanner();
  } else {
    const guide = document.getElementById('modal-install-guide');
    if (guide) guide.classList.remove('hidden');
    closeInstallBanner();
  }
}

function closeInstallBanner() {
  const banner = document.getElementById('pwa-install-banner');
  if (banner) banner.classList.remove('show');
}


// ══════════════════════════════════════
// STATE / DATABASE (localStorage + Server Sync)
// ══════════════════════════════════════

// Detecta se estamos rodando no servidor (Railway) ou local
const API_BASE = '';

let _syncTimeout = null;
let _periodicSyncInterval = null;
let _dbReady = false;
let _isSyncing = false;

// DB opera na memória — sincroniza com servidor quando disponível
const _mem = {
  clients: [],
  loans: [],
  smsHistory: [],
  settings: null,
};

const DB = {
  get clients()       { return _mem.clients; },
  set clients(v)      { _mem.clients = v; _scheduleSync(); _lsSet('ab_clients', v); },
  get loans()         { return _mem.loans; },
  set loans(v)        { _mem.loans = v; _scheduleSync(); _lsSet('ab_loans', v); },
  get smsHistory()    { return _mem.smsHistory; },
  set smsHistory(v)   { _mem.smsHistory = v; _scheduleSync(); _lsSet('ab_sms', v); },
  get settings()      { return _mem.settings || _mergeSettings({}, DEFAULT_SETTINGS); },
  set settings(v)     { _mem.settings = _mergeSettings(v, DEFAULT_SETTINGS); _scheduleSync(); _lsSet('ab_settings', _mem.settings); },
  get currentUser()   { return JSON.parse(sessionStorage.getItem('ab_user') || 'null'); },
  set currentUser(v)  { sessionStorage.setItem('ab_user', JSON.stringify(v)); },
};

// Deep-merge: server/stored data gets DEFAULT_SETTINGS as base to ensure all fields always exist
function _mergeSettings(incoming, defaults) {
  const result = { ...defaults };
  if (!incoming || typeof incoming !== 'object') return result;
  for (const key of Object.keys(incoming)) {
    if (incoming[key] !== null && typeof incoming[key] === 'object' && !Array.isArray(incoming[key])) {
      result[key] = { ...(defaults[key] || {}), ...incoming[key] };
    } else {
      result[key] = incoming[key];
    }
  }
  // Always preserve arrays from incoming if they have data
  if (Array.isArray(incoming.creditors) && incoming.creditors.length > 0) result.creditors = incoming.creditors;
  if (Array.isArray(incoming.chatMessages)) result.chatMessages = incoming.chatMessages;
  return result;
}

function _lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
}

function _setSyncStatus(status) {
  const indicator = document.getElementById('sync-status-indicator');
  if (!indicator) return;
  if (status === 'saving') {
    indicator.innerHTML = '💾 Salvando...';
    indicator.style.color = 'var(--orange)';
    indicator.style.display = 'inline-flex';
  } else if (status === 'saved') {
    indicator.innerHTML = '✅ Salvo';
    indicator.style.color = 'var(--green)';
    indicator.style.display = 'inline-flex';
    setTimeout(() => { if (indicator) indicator.style.display = 'none'; }, 3000);
  } else if (status === 'error') {
    indicator.innerHTML = '⚠️ Offline';
    indicator.style.color = 'var(--orange)';
    indicator.style.display = 'inline-flex';
  }
}

function _scheduleSync() {
  if (_syncTimeout) clearTimeout(_syncTimeout);
  _setSyncStatus('saving');
  _syncTimeout = setTimeout(_pushState, 1500); // debounce 1.5s
}

async function _pushState() {
  if (_isSyncing) return;
  _isSyncing = true;
  try {
    const res = await fetch(API_BASE + '/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clients: _mem.clients,
        loans: _mem.loans,
        smsHistory: _mem.smsHistory,
        settings: _mem.settings || DEFAULT_SETTINGS,
      }),
    });
    if (res.ok) {
      _setSyncStatus('saved');
    } else {
      _setSyncStatus('error');
    }
  } catch (e) {
    _setSyncStatus('error');
    // silently fail — dados continuam no localStorage
  } finally {
    _isSyncing = false;
  }
}

async function _loadState() {
  // Carrega do localStorage enquanto aguarda o servidor
  _mem.clients    = JSON.parse(localStorage.getItem('ab_clients')  || '[]');
  _mem.loans      = JSON.parse(localStorage.getItem('ab_loans')    || '[]');
  _mem.smsHistory = JSON.parse(localStorage.getItem('ab_sms')      || '[]');
  // Deep-merge stored settings into defaults to prevent missing fields
  const storedSettings = JSON.parse(localStorage.getItem('ab_settings') || '{}');
  _mem.settings   = _mergeSettings(storedSettings, DEFAULT_SETTINGS);

  try {
    const res = await fetch(API_BASE + '/api/state');
    if (res.ok) {
      const data = await res.json();

      // Use most-data strategy: server wins if it has data
      if (data.clients && data.clients.length > 0) {
        _mem.clients = data.clients;
        _lsSet('ab_clients', data.clients);
      }
      if (data.loans && data.loans.length > 0) {
        _mem.loans = data.loans;
        _lsSet('ab_loans', data.loans);
      }
      if (data.smsHistory && data.smsHistory.length > 0) {
        _mem.smsHistory = data.smsHistory;
        _lsSet('ab_sms', data.smsHistory);
      }
      if (data.settings && Object.keys(data.settings).length > 0) {
        // Deep-merge server settings into defaults — server data wins
        _mem.settings = _mergeSettings(data.settings, DEFAULT_SETTINGS);
        _lsSet('ab_settings', _mem.settings);
      }
      console.log('✅ Estado carregado do PostgreSQL!');
    }
  } catch (e) {
    console.warn('⚠️ Servidor offline — usando dados locais');
  }
  _dbReady = true;

  // Start periodic sync every 60 seconds to ensure data is always persisted
  if (_periodicSyncInterval) clearInterval(_periodicSyncInterval);
  _periodicSyncInterval = setInterval(() => {
    if (_dbReady && _mem.clients.length + _mem.loans.length > 0) {
      _pushState();
    }
  }, 60000);
}

const DEFAULT_SETTINGS = {
  taxas: { 1: 15, 2: 20, 3: 25, 6: 35, 12: 50 },
  taxaAtraso: 1,
  limiteMin: 200,
  limiteMax: 5000,
  limiteCliente: 10000,
  smsDias: 5,
  smsDiaVcto: true,
  smsAtrasadoFreq: 7,
  adminPass: 'admin123',
  chatMessages: [],
  creditors: [
    { id: 'default', nome: 'ÁgilBank Principal', email: 'agiotabraga@gmail.com', password: 'Ab@46431194', role: 'padrinho' }
  ]
};

let currentLoanId = null; // for modal operations
let currentLoansFilter = 'all';

// ══════════════════════════════════════
// SEED DATA (first run)
// ══════════════════════════════════════
function seedData() {
  if (DB.clients.length > 0) return;
  DB.clients = [];
  DB.loans   = [];
  DB.settings = { ...DEFAULT_SETTINGS };
}

// ══════════════════════════════════════
// OVERDUE INSTALLMENTS CHECK
// ══════════════════════════════════════
function checkOverdueInstallments() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const loans = DB.loans;
  let changed = false;

  loans.forEach(loan => {
    if (loan.status !== 'active' && loan.status !== 'overdue') return;
    if (!loan.parcelas) return;

    let hasOverdue = false;
    let allPaid = true;

    loan.parcelas.forEach(p => {
      if (p.status === 'paid') return;
      allPaid = false;
      const vcto = new Date(p.vcto + 'T00:00:00');
      if (vcto < today) {
        if (p.status !== 'overdue') {
          p.status = 'overdue';
          changed = true;
        }
        hasOverdue = true;
      }
    });

    const newStatus = allPaid ? 'paid' : (hasOverdue ? 'overdue' : 'active');
    if (loan.status !== newStatus) {
      loan.status = newStatus;
      changed = true;
    }
  });

  if (changed) {
    DB.loans = loans;
    console.log('⏰ Parcelas e empréstimos atualizados para atraso.');
  }
}

// ══════════════════════════════════════
// IMAGE COMPRESSION (selfie)
// ══════════════════════════════════════
function compressImage(dataUrl, maxWidth = 400, quality = 0.7) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width;
      let h = img.height;
      if (w > maxWidth) {
        h = Math.round(h * maxWidth / w);
        w = maxWidth;
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl); // fallback
    img.src = dataUrl;
  });
}

// ══════════════════════════════════════
// INIT
// ══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  createParticles();
  loadSMSTemplate();

  // Mostra loading enquanto carrega do banco
  const loginScreen = document.getElementById('screen-login');
  if (loginScreen) loginScreen.style.opacity = '0.5';

  await _loadState();
  seedData(); // só popula se estiver vazio
  checkOverdueInstallments(); // atualiza parcelas vencidas
  populateCreditorsDropdowns();

  if (loginScreen) loginScreen.style.opacity = '1';

  const user = DB.currentUser;
  if (user) {
    if (user.role === 'admin') enterAdmin();
    else enterClient(user);
  }

  // Set today's date
  const el = document.getElementById('adm-date');
  if (el) el.textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Check overdue installments every 10 minutes
  setInterval(checkOverdueInstallments, 10 * 60 * 1000);
});

// ══════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════
function goTo(screenId) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = 'none';
  });
  const el = document.getElementById(screenId);
  if (el) { el.style.display = 'block'; el.classList.add('active'); }
}

function switchLoginTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.login-form').forEach(f => f.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.getElementById(`login-${tab}`).classList.add('active');
}

// ══════════════════════════════════════
// AUTH
// ══════════════════════════════════════
function loginClient() {
  const rawUser = document.getElementById('cl-login-user').value.trim();
  const pass = document.getElementById('cl-login-pass').value;

  if (!rawUser) {
    toast('Atenção', 'Informe seu CPF ou e-mail.', 'warning');
    return;
  }

  // Normalize CPF: strip non-digits for comparison
  const rawDigits = rawUser.replace(/\D/g, '');

  const client = DB.clients.find(c => {
    const cpfDigits = (c.cpf || '').replace(/\D/g, '');
    return cpfDigits === rawDigits ||
      (c.email && c.email.toLowerCase() === rawUser.toLowerCase()) ||
      c.cpf === rawUser;
  });

  if (!client) {
    toast('Erro', 'CPF/e-mail não encontrado. Verifique e tente novamente.', 'error');
    return;
  }

  // Cliente adicionado manualmente pelo admin sem senha → completar cadastro
  if (!client.senha) {
    window.clientToComplete = client;
    prepareCompleteRegistration(client);
    toast('Ativação de Conta', 'Complete seu cadastro para acessar sua conta.', 'info');
    return;
  }

  if (!pass) {
    toast('Atenção', 'Informe sua senha.', 'warning');
    return;
  }

  if (client.senha !== pass) {
    toast('Erro', 'Senha incorreta. Tente novamente.', 'error');
    return;
  }

  DB.currentUser = { ...client, role: 'client' };
  enterClient(client);
  toast('Bem-vindo!', `Olá, ${client.nome.split(' ')[0]}! 👋`, 'success');
}

function loginAdmin() {
  const user = document.getElementById('adm-login-user').value.trim().toLowerCase();
  const pass = document.getElementById('adm-login-pass').value;
  const s = DB.settings;
  const creditors = s.creditors || DEFAULT_SETTINGS.creditors || [];

  // Check super admin
  if (user === 'admin' && pass === (s.adminPass || 'admin123')) {
    DB.currentUser = { role: 'admin', creditorId: 'all', nome: 'Super Administrador' };
    enterAdmin();
    toast('Acesso concedido', 'Bem-vindo ao painel do Super Admin! 🔐', 'success');
    return;
  }

  // Check creditors list
  const creditor = creditors.find(c => c.email.toLowerCase() === user && c.password === pass);
  if (creditor) {
    DB.currentUser = { role: 'admin', creditorId: creditor.id, nome: creditor.nome };
    enterAdmin();
    toast('Acesso concedido', `Painel Credor: ${creditor.nome} 💼`, 'success');
  } else {
    // Fallback default creditor
    if (user === 'agiotabraga@gmail.com' && pass === 'Ab@46431194') {
      DB.currentUser = { role: 'admin', creditorId: 'default', nome: 'ÁgilBank Principal' };
      enterAdmin();
      toast('Acesso concedido', 'Bem-vindo ao painel administrativo! 🔐', 'success');
    } else {
      toast('Acesso negado', 'Credenciais de administrador inválidas.', 'error');
    }
  }
}

function openCreditorRegisterModal() {
  document.getElementById('cred-nome').value = '';
  document.getElementById('cred-email').value = '';
  document.getElementById('cred-senha').value = '';
  document.getElementById('modal-add-creditor').classList.remove('hidden');
}

function registerCreditor() {
  const nome = document.getElementById('cred-nome').value.trim();
  const email = document.getElementById('cred-email').value.trim();
  const senha = document.getElementById('cred-senha').value;

  if (!nome || !email || !senha) {
    toast('Atenção', 'Preencha todos os campos.', 'warning');
    return;
  }

  const s = DB.settings;
  const creditors = s.creditors || [];

  const existing = creditors.find(c => c.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    toast('Atenção', 'Este e-mail já está sendo usado por outro credor.', 'error');
    return;
  }

  const newCreditor = {
    id: 'cred_' + Date.now(),
    nome,
    email: email.toLowerCase(),
    password: senha,
    role: 'afiliado'
  };

  creditors.push(newCreditor);
  s.creditors = creditors;
  DB.settings = s;

  closeModal('modal-add-creditor');
  toast('Sucesso!', 'Conta de credor criada com sucesso. Acessando painel...', 'success');

  DB.currentUser = { role: 'admin', creditorId: newCreditor.id, nome: newCreditor.nome };
  enterAdmin();
  populateCreditorsDropdowns();
}

function populateCreditorsDropdowns() {
  const s = DB.settings;
  const creditors = s.creditors || DEFAULT_SETTINGS.creditors || [];

  const regSel = document.getElementById('reg-creditor-id');
  if (regSel) {
    regSel.innerHTML = creditors.map(c => `<option value="${c.id}">${c.nome} (${c.email})</option>`).join('');
  }
}

function logout() {
  DB.currentUser = null;
  sessionStorage.removeItem('ab_user');
  goTo('screen-login');
  toast('Até logo!', 'Você saiu com segurança.', 'info');
}

function registerClient() {
  const nome   = document.getElementById('reg-nome').value.trim();
  const cpf    = document.getElementById('reg-cpf').value.trim();
  const email  = document.getElementById('reg-email').value.trim();
  const tel    = document.getElementById('reg-tel').value.trim();
  const cidade = document.getElementById('reg-cidade').value.trim();
  const estado = document.getElementById('reg-estado').value.trim();
  const end    = document.getElementById('reg-endereco').value.trim();
  const nasc   = document.getElementById('reg-nasc').value;
  const emprego= document.getElementById('reg-emprego').value;
  const trabalho= document.getElementById('reg-trabalho').value.trim();
  const renda  = document.getElementById('reg-renda').value;
  const garantia= document.getElementById('reg-garantia').value.trim();
  const indicacao= document.getElementById('reg-indicacao').value.trim();
  const senha  = document.getElementById('reg-senha').value;
  const senha2 = document.getElementById('reg-senha2').value;
  const termos = document.getElementById('reg-termos').checked;

  if (!nome || !cpf || !email || !tel || !cidade || !estado) {
    toast('Atenção', 'Preencha todos os campos obrigatórios.', 'warning'); return;
  }
  if (senha.length < 6) {
    toast('Atenção', 'A senha deve ter pelo menos 6 caracteres.', 'warning'); return;
  }
  if (senha !== senha2) {
    toast('Atenção', 'As senhas não coincidem.', 'warning'); return;
  }
  if (!termos) {
    toast('Atenção', 'Aceite os termos de uso para continuar.', 'warning'); return;
  }

  const existing = DB.clients.find(c => c.cpf === cpf || c.email === email);
  if (existing) {
    toast('Já cadastrado', 'CPF ou e-mail já cadastrado no sistema.', 'error'); return;
  }

  const creditorId = document.getElementById('reg-creditor-id').value;

  const newClient = {
    id: 'c' + Date.now(),
    nome, cpf, email, tel, cidade, estado,
    endereco: end, nasc, emprego, trabalho, renda, garantia, indicacao, senha,
    cadastro: new Date().toISOString(),
    rg: document.getElementById('reg-rg').value,
    estadoCivil: document.getElementById('reg-estado-civil').value,
    cep: document.getElementById('reg-cep').value,
    creditorId: creditorId || 'default'
  };

  const clients = DB.clients;
  clients.push(newClient);
  DB.clients = clients;

  DB.currentUser = { ...newClient, role: 'client' };
  enterClient(newClient);
  toast('Cadastro realizado!', `Bem-vindo ao ÁgilBank, ${nome.split(' ')[0]}! 🎉`, 'success');
}

// ══════════════════════════════════════
// REGISTRATION COMPLETION FOR MANUAL CLIENTS
// ══════════════════════════════════════
let capturedCompleteSelfie = null;
let capturedCompleteLocation = null;
let completeVideoStream = null;

function prepareCompleteRegistration(client) {
  // Pre-fill fields
  document.getElementById('complete-nome').value = client.nome || '';
  document.getElementById('complete-cpf').value = client.cpf || '';
  document.getElementById('complete-tel').value = client.tel || '';

  // Reset fields
  document.getElementById('complete-email').value = '';
  document.getElementById('complete-rg').value = '';
  document.getElementById('complete-nasc').value = '';
  document.getElementById('complete-estado-civil').value = '';
  document.getElementById('complete-cep').value = '';
  document.getElementById('complete-cidade').value = '';
  document.getElementById('complete-estado').value = '';
  document.getElementById('complete-endereco').value = '';
  document.getElementById('complete-emprego').value = '';
  document.getElementById('complete-trabalho').value = '';
  document.getElementById('complete-renda').value = '';
  document.getElementById('complete-senha').value = '';
  document.getElementById('complete-senha2').value = '';
  document.getElementById('complete-termos').checked = false;

  // Reset photo states
  capturedCompleteSelfie = null;
  capturedCompleteLocation = null;
  if (completeVideoStream) {
    completeVideoStream.getTracks().forEach(track => track.stop());
    completeVideoStream = null;
  }

  document.getElementById('complete-camera-container').style.display = 'none';
  document.getElementById('btn-complete-take-photo').style.display = 'none';
  document.getElementById('complete-security-result').style.display = 'none';
  document.getElementById('btn-complete-start-camera').style.display = 'block';

  goTo('screen-complete-register');
}

async function startCompleteCapture() {
  document.getElementById('btn-complete-start-camera').style.display = 'none';
  document.getElementById('complete-camera-container').style.display = 'block';

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => { capturedCompleteLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
      (err) => { console.warn("GPS error:", err); }
    );
  }

  try {
    completeVideoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
    const videoEl = document.getElementById('complete-camera-feed');
    videoEl.srcObject = completeVideoStream;
    document.getElementById('btn-complete-take-photo').style.display = 'block';
  } catch (err) {
    toast('Erro de Câmera', 'Não foi possível acessar a câmera. Tente novamente.', 'error');
    document.getElementById('btn-complete-start-camera').style.display = 'block';
    document.getElementById('complete-camera-container').style.display = 'none';
  }
}

async function takeCompletePhoto() {
  const videoEl = document.getElementById('complete-camera-feed');
  const canvas = document.getElementById('complete-camera-canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

  // Compress image to keep payload small
  capturedCompleteSelfie = await compressImage(canvas.toDataURL('image/jpeg'), 400, 0.7);

  if (completeVideoStream) {
    completeVideoStream.getTracks().forEach(track => track.stop());
  }

  document.getElementById('complete-camera-container').style.display = 'none';
  document.getElementById('btn-complete-take-photo').style.display = 'none';

  const preview = document.getElementById('complete-selfie-preview');
  preview.src = capturedCompleteSelfie;
  document.getElementById('complete-security-result').style.display = 'block';
}

async function buscaCEPComplete() {
  const cep = document.getElementById('complete-cep')?.value.replace(/\D/g, '');
  if (cep.length !== 8) return;
  try {
    const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const data = await res.json();
    if (!data.erro) {
      document.getElementById('complete-cidade').value = data.localidade || '';
      document.getElementById('complete-estado').value = data.uf || '';
      document.getElementById('complete-endereco').value = data.logradouro ? `${data.logradouro}, ` : '';
    }
  } catch (e) {}
}

async function finishCompleteRegistration() {
  const client = window.clientToComplete;
  if (!client) {
    toast('Erro', 'Nenhum cliente para completar cadastro foi encontrado.', 'error');
    goTo('screen-login');
    return;
  }

  const tel = document.getElementById('complete-tel').value.trim();
  const email = document.getElementById('complete-email').value.trim();
  const rg = document.getElementById('complete-rg').value.trim();
  const nasc = document.getElementById('complete-nasc').value;
  const estadoCivil = document.getElementById('complete-estado-civil').value;
  const cep = document.getElementById('complete-cep').value.trim();
  const cidade = document.getElementById('complete-cidade').value.trim();
  const estado = document.getElementById('complete-estado').value.trim();
  const endereco = document.getElementById('complete-endereco').value.trim();
  const emprego = document.getElementById('complete-emprego').value;
  const trabalho = document.getElementById('complete-trabalho').value.trim();
  const renda = document.getElementById('complete-renda').value;
  const senha = document.getElementById('complete-senha').value;
  const senha2 = document.getElementById('complete-senha2').value;
  const termos = document.getElementById('complete-termos').checked;

  if (!tel || !email || !rg || !nasc || !cep || !cidade || !estado || !endereco || !senha || !senha2) {
    toast('Atenção', 'Preencha todos os campos obrigatórios (*).', 'warning');
    return;
  }

  if (senha.length < 6) {
    toast('Atenção', 'A senha deve ter pelo menos 6 caracteres.', 'warning');
    return;
  }

  if (senha !== senha2) {
    toast('Atenção', 'As senhas não coincidem.', 'warning');
    return;
  }

  if (!capturedCompleteSelfie) {
    toast('Atenção', 'A foto de segurança é obrigatória.', 'warning');
    return;
  }

  if (!termos) {
    toast('Atenção', 'Você deve aceitar os termos para prosseguir.', 'warning');
    return;
  }

  const existingEmail = DB.clients.find(c => c.id !== client.id && c.email && c.email.toLowerCase() === email.toLowerCase());
  if (existingEmail) {
    toast('E-mail em uso', 'Este endereço de e-mail já está cadastrado por outro cliente.', 'error');
    return;
  }

  const clients = DB.clients;
  const targetClientIndex = clients.findIndex(c => c.id === client.id);
  if (targetClientIndex !== -1) {
    clients[targetClientIndex].tel = tel;
    clients[targetClientIndex].email = email;
    clients[targetClientIndex].rg = rg;
    clients[targetClientIndex].nasc = nasc;
    clients[targetClientIndex].estadoCivil = estadoCivil;
    clients[targetClientIndex].cep = cep;
    clients[targetClientIndex].cidade = cidade;
    clients[targetClientIndex].estado = estado;
    clients[targetClientIndex].endereco = endereco;
    clients[targetClientIndex].emprego = emprego;
    clients[targetClientIndex].trabalho = trabalho;
    clients[targetClientIndex].renda = renda;
    clients[targetClientIndex].senha = senha;
    clients[targetClientIndex].selfie = capturedCompleteSelfie;
    clients[targetClientIndex].location = capturedCompleteLocation;

    const loans = DB.loans;
    let loanUpdated = false;
    loans.forEach(l => {
      if (l.clientId === client.id && !l.selfie) {
        l.selfie = capturedCompleteSelfie;
        l.location = capturedCompleteLocation;
        loanUpdated = true;
      }
    });

    DB.clients = clients;
    if (loanUpdated) {
      DB.loans = loans;
    }

    DB.currentUser = { ...clients[targetClientIndex], role: 'client' };
    window.clientToComplete = null;

    enterClient(clients[targetClientIndex]);
    toast('Cadastro Ativado!', `Sua conta foi ativada com sucesso, ${client.nome.split(' ')[0]}! 🎉`, 'success');
  } else {
    toast('Erro', 'Erro ao encontrar o cliente no sistema.', 'error');
    goTo('screen-login');
  }
}

// ══════════════════════════════════════
// CLIENT PORTAL
// ══════════════════════════════════════
function enterClient(client) {
  goTo('screen-client');
  updateClientSidebar(client);
  loadClientDashboard(client.id);
  clientNav('dashboard');
}

function updateClientSidebar(client) {
  const el = document.getElementById('client-user-card');
  if (el) el.textContent = `👤 ${client.nome.split(' ')[0]} ${client.nome.split(' ').slice(-1)[0]}`;
  const greet = document.getElementById('client-greeting');
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  if (greet) greet.textContent = `${greeting}, ${client.nome.split(' ')[0]}! 👋`;
}

function clientNav(section) {
  document.querySelectorAll('#screen-client .nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('#client-main .content-section').forEach(s => s.classList.add('hidden'));

  const navEl = document.getElementById(`cnav-${section}`);
  if (navEl) navEl.classList.add('active');

  const secMap = {
    'dashboard':   'cl-dashboard',
    'request':     'cl-loan-request',
    'my-loans':    'cl-my-loans',
    'payments':    'cl-payments',
    'profile':     'cl-profile',
  };

  const sEl = document.getElementById(secMap[section]);
  if (sEl) sEl.classList.remove('hidden');

  const user = DB.currentUser;
  if (!user) return;

  switch(section) {
    case 'dashboard':   loadClientDashboard(user.id); break;
    case 'my-loans':    loadMyLoans(user.id); break;
    case 'payments':    loadPayments(user.id); break;
    case 'profile':     loadProfile(user.id); break;
  }
}

function loadClientDashboard(clientId) {
  const loans = DB.loans.filter(l => l.clientId === clientId && l.status !== 'rejected');
  const active = loans.filter(l => l.status === 'active' || l.status === 'overdue');
  const settings = DB.settings;

  // Stats
  let totalDevendo = 0;
  let nextVcto = null;

  active.forEach(l => {
    if (l.parcelas) {
      const pendParcelas = l.parcelas.filter(p => p.status !== 'paid');
      pendParcelas.forEach(p => {
        totalDevendo += p.valor;
        if (!nextVcto || p.vcto < nextVcto) nextVcto = p.vcto;
      });
    }
  });

  document.getElementById('cl-ativos').textContent = active.length;
  document.getElementById('cl-total-devendo').textContent = formatMoney(totalDevendo);
  document.getElementById('cl-vencimento').textContent = nextVcto ? formatDate(nextVcto) : '—';
  document.getElementById('cl-disponivel').textContent = formatMoney(settings.limiteMax || 5000);

  // Loans list
  const loansList = document.getElementById('cl-loans-list');
  if (!active.length) {
    loansList.innerHTML = `<div class="empty-state"><div class="empty-icon">💰</div><p>Você não tem empréstimos ativos.<br><a class="link" onclick="clientNav('loan-request')">Solicitar agora →</a></p></div>`;
    return;
  }

  loansList.innerHTML = active.map(l => {
    const client = DB.clients.find(c => c.id === l.clientId);
    const pendParcelas = l.parcelas ? l.parcelas.filter(p => p.status !== 'paid') : [];
    const pending = pendParcelas.reduce((acc, p) => acc + p.valor, 0);
    const nextP = pendParcelas[0];
    return `
      <div class="loan-item">
        <div class="loan-item-info">
          <div class="loan-item-name">Empréstimo #${l.id}</div>
          <div class="loan-item-meta">Prazo: ${l.prazo} meses · Juros: ${l.juros}%${nextP ? ` · Próx. venc: ${formatDate(nextP.vcto)}` : ''}</div>
        </div>
        <div class="loan-item-amount">
          <div class="loan-item-value">${formatMoney(pending)}</div>
          <div class="loan-item-sub">restante de ${formatMoney(l.totalComJuros)}</div>
        </div>
        <span class="status-badge status-${l.status}">${statusLabel(l.status)}</span>
      </div>`;
  }).join('');

  // Notices
  const noticesList = document.getElementById('cl-notices');
  const notices = [];

  active.forEach(l => {
    if (!l.parcelas) return;
    l.parcelas.forEach(p => {
      if (p.status === 'overdue') {
        const days = Math.floor((new Date() - new Date(p.vcto)) / 86400000);
        notices.push({ icon: '⚠️', title: `Parcela ${p.n} em atraso!`, text: `Venceu em ${formatDate(p.vcto)} (${days} dias atrás). Valor: ${formatMoney(p.valor)}. Entre em contato para regularizar.` });
      } else if (p.status === 'pending') {
        const daysTo = Math.floor((new Date(p.vcto) - new Date()) / 86400000);
        if (daysTo <= 5 && daysTo >= 0) {
          notices.push({ icon: '⏰', title: `Parcela vence em ${daysTo === 0 ? 'HOJE' : daysTo + ' dias'}!`, text: `Parcela ${p.n} de ${formatMoney(p.valor)} vence em ${formatDate(p.vcto)}.` });
        }
      }
    });
  });

  if (!notices.length) {
    noticesList.innerHTML = `<div class="notice-item"><div class="notice-icon">✅</div><div class="notice-body"><strong>Tudo em dia!</strong><p>Não há avisos importantes no momento.</p></div></div>`;
  } else {
    noticesList.innerHTML = notices.map(n => `
      <div class="notice-item">
        <div class="notice-icon">${n.icon}</div>
        <div class="notice-body"><strong>${n.title}</strong><p>${n.text}</p></div>
      </div>`).join('');
  }
}

function loadMyLoans(clientId) {
  const loans = DB.loans.filter(l => l.clientId === clientId);
  const container = document.getElementById('cl-all-loans');

  if (!loans.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><p>Nenhum empréstimo encontrado.</p></div>`;
    return;
  }

  container.innerHTML = loans.map(l => {
    const pago = l.parcelas ? l.parcelas.filter(p => p.status === 'paid').reduce((a, p) => a + p.valor, 0) : 0;
    return `
      <div class="section-card" style="margin-bottom:16px">
        <div class="section-card-header">
          <div>
            <span style="font-size:15px;font-weight:700">Empréstimo #${l.id}</span>
            <span class="status-badge status-${l.status}" style="margin-left:10px">${statusLabel(l.status)}</span>
          </div>
          <div style="font-size:13px;color:var(--text-sec)">${formatDate(l.createdAt)}</div>
        </div>
        <div style="padding:16px 20px;display:grid;grid-template-columns:repeat(4,1fr);gap:14px">
          <div><label style="font-size:11px;color:var(--text-muted);display:block">Valor</label><span style="font-weight:700">${formatMoney(l.valor)}</span></div>
          <div><label style="font-size:11px;color:var(--text-muted);display:block">Total c/ Juros</label><span style="font-weight:700;color:var(--green)">${l.totalComJuros ? formatMoney(l.totalComJuros) : '—'}</span></div>
          <div><label style="font-size:11px;color:var(--text-muted);display:block">Juros</label><span style="font-weight:700">${l.juros != null ? l.juros + '%' : 'Aguardando'}</span></div>
          <div><label style="font-size:11px;color:var(--text-muted);display:block">Pago</label><span style="font-weight:700;color:var(--green)">${formatMoney(pago)}</span></div>
        </div>
        ${l.parcelas ? `
        <div style="padding:0 20px 16px">
          <table class="installment-table">
            <thead><tr><th>Parcela</th><th>Valor</th><th>Vencimento</th><th>Status</th></tr></thead>
            <tbody>${l.parcelas.map(p => `
              <tr class="${p.status === 'paid' ? 'paid-row' : ''}">
                <td>${p.n}ª parcela</td>
                <td>${formatMoney(p.valor)}</td>
                <td>${formatDate(p.vcto)}</td>
                <td><span class="status-badge status-${p.status}">${statusLabel(p.status)}</span></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : l.status === 'pending' ? `<div style="padding:16px 20px;color:var(--orange);font-size:13px">⏳ Aguardando análise do administrador...</div>` : ''}
      </div>`;
  }).join('');
}

function loadPayments(clientId) {
  const loans = DB.loans.filter(l => l.clientId === clientId && l.parcelas);
  const container = document.getElementById('cl-payments-list');

  if (!loans.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">💳</div><p>Nenhum pagamento encontrado.</p></div>`;
    return;
  }

  container.innerHTML = loans.map(l => {
    const pending = l.parcelas.filter(p => p.status !== 'paid');
    if (!pending.length) return '';
    return `
      <div class="payment-card">
        <div class="payment-card-header">
          <h4>Empréstimo #${l.id} — ${formatMoney(l.valor)}</h4>
          <span class="status-badge status-${l.status}">${statusLabel(l.status)}</span>
        </div>
        <div class="installments-mini">
          ${l.parcelas.map(p => `
            <div class="inst-mini-row ${p.status}">
              <span>${p.n}ª parcela — ${formatDate(p.vcto)}</span>
              <div style="display:flex;align-items:center;gap:12px">
                <strong>${formatMoney(p.valor)}</strong>
                <span class="status-badge status-${p.status}">${statusLabel(p.status)}</span>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('') || `<div class="empty-state"><div class="empty-icon">✅</div><p>Nenhum pagamento pendente!</p></div>`;
}

function loadProfile(clientId) {
  const client = DB.clients.find(c => c.id === clientId);
  if (!client) return;
  const loans = DB.loans.filter(l => l.clientId === clientId);
  const initials = client.nome.split(' ').map(n => n[0]).slice(0,2).join('').toUpperCase();

  document.getElementById('cl-profile-data').innerHTML = `
    <div class="profile-avatar-section">
      <div class="profile-avatar-big">${initials}</div>
      <div>
        <div class="profile-name">${client.nome}</div>
        <div class="profile-since">Cliente desde ${formatDate(client.cadastro)}</div>
        <div style="margin-top:8px"><span class="status-badge status-active">✓ Conta Ativa</span></div>
      </div>
    </div>
    <div class="profile-fields">
      <div class="pf-item"><label>CPF</label><span>${client.cpf}</span></div>
      <div class="pf-item"><label>Data de Nascimento</label><span>${client.nasc ? formatDate(client.nasc) : '—'}</span></div>
      <div class="pf-item"><label>E-mail</label><span>${client.email}</span></div>
      <div class="pf-item"><label>Telefone</label><span>${client.tel}</span></div>
      <div class="pf-item"><label>Cidade/Estado</label><span>${client.cidade} - ${client.estado}</span></div>
      <div class="pf-item"><label>Endereço</label><span>${client.endereco || '—'}</span></div>
      <div class="pf-item"><label>Emprego/Trabalho</label><span>${client.emprego || '—'} ${client.trabalho ? '('+client.trabalho+')' : ''}</span></div>
      <div class="pf-item"><label>Renda Mensal</label><span>${client.renda || '—'}</span></div>
      <div class="pf-item"><label>Garantia</label><span>${client.garantia || 'Nenhuma'}</span></div>
      <div class="pf-item"><label>Indicação</label><span>${client.indicacao || 'Nenhuma'}</span></div>
      <div class="pf-item"><label>Total de Empréstimos</label><span>${loans.length}</span></div>
      <div class="pf-item"><label>Empréstimos Ativos</label><span>${loans.filter(l => l.status === 'active').length}</span></div>
    </div>`;
}

let capturedSelfie = null;
let capturedLocation = null;
let videoStream = null;

async function startSecurityCapture() {
  const cameraBtn = document.getElementById('btn-start-camera');
  if (cameraBtn) {
    cameraBtn.textContent = '⏳ Abrindo câmera...';
    cameraBtn.disabled = true;
  }

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => { capturedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
      (err) => { console.warn('GPS error:', err); }
    );
  }

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Câmera não suportada neste dispositivo/navegador.');
    }
    videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    const videoEl = document.getElementById('camera-feed');
    videoEl.srcObject = videoStream;
    // Only show camera container once stream is ready
    document.getElementById('camera-container').style.display = 'block';
    if (cameraBtn) cameraBtn.style.display = 'none';
    document.getElementById('btn-take-photo').style.display = 'block';
  } catch (err) {
    console.warn('Camera error:', err);
    if (cameraBtn) {
      cameraBtn.textContent = '📸 Liberar Câmera';
      cameraBtn.disabled = false;
    }
    document.getElementById('camera-container').style.display = 'none';
    // Show file upload fallback
    const fallback = document.getElementById('photo-file-fallback');
    if (fallback) fallback.style.display = 'block';
    toast('Câmera indisponível', 'Câmera não pôde ser acessada. Você pode enviar uma foto da galeria ou continuar sem foto.', 'warning');
  }
}

async function takePhoto() {
  const videoEl = document.getElementById('camera-feed');
  const canvas = document.getElementById('camera-canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  
  // Compress image to keep payload small
  capturedSelfie = await compressImage(canvas.toDataURL('image/jpeg'), 400, 0.7);
  
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
  }
  
  document.getElementById('camera-container').style.display = 'none';
  document.getElementById('btn-take-photo').style.display = 'none';
  
  const preview = document.getElementById('selfie-preview');
  preview.src = capturedSelfie;
  document.getElementById('security-result').style.display = 'block';
}

// Load photo from file input as fallback
function loadPhotoFromFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function(e) {
    capturedSelfie = await compressImage(e.target.result, 400, 0.7);
    const preview = document.getElementById('selfie-preview');
    if (preview) {
      preview.src = capturedSelfie;
      document.getElementById('security-result').style.display = 'block';
    }
    toast('Foto carregada!', 'Foto da galeria selecionada com sucesso.', 'success');
  };
  reader.readAsDataURL(file);
}

function submitLoanRequest() {
  const user = DB.currentUser;
  if (!user) { toast('Erro', 'Faça login para continuar.', 'error'); return; }

  const rawValor = document.getElementById('lr-valor').value.replace(/[^0-9]/g, '') / 100;
  const prazo    = parseInt(document.getElementById('lr-prazo').value);
  const motivo   = document.getElementById('lr-motivo').value;
  const desc     = document.getElementById('lr-desc').value;
  const settings = DB.settings;

  if (!rawValor || rawValor < settings.limiteMin) {
    toast('Atenção', `Valor mínimo é ${formatMoney(settings.limiteMin)}.`, 'warning'); return;
  }
  if (rawValor > settings.limiteMax) {
    toast('Atenção', `Valor máximo é ${formatMoney(settings.limiteMax)}.`, 'warning'); return;
  }
  if (!motivo) {
    toast('Atenção', 'Selecione o motivo do empréstimo.', 'warning'); return;
  }
  if (!capturedSelfie) {
    // Selfie is optional but recommended - just warn, don't block
    toast('Aviso', 'Nenhuma foto de segurança capturada. O pedido será enviado sem foto.', 'info');
  }

  const avalistaNome = document.getElementById('lr-avalista-nome').value.trim();
  const avalistaCpf = document.getElementById('lr-avalista-cpf').value.trim();
  const avalistaTel = document.getElementById('lr-avalista-tel').value.trim();
  const avalistaRenda = document.getElementById('lr-avalista-renda').value.trim();

  let avalista = null;
  if (avalistaNome || avalistaCpf || avalistaTel || avalistaRenda) {
    avalista = {
      nome: avalistaNome || '—',
      cpf: avalistaCpf || '—',
      tel: avalistaTel || '—',
      renda: avalistaRenda || '—'
    };
  }

  const newLoan = {
    id: 'l' + Date.now(),
    clientId: user.id,
    valor: rawValor,
    prazo,
    motivo,
    descricao: desc,
    status: 'pending',
    createdAt: new Date().toISOString(),
    juros: null,
    totalComJuros: null,
    parcelas: null,
    selfie: capturedSelfie,
    location: capturedLocation,
    avalista: avalista,
    creditorId: user.creditorId || 'default'
  };

  const loans = DB.loans;
  loans.push(newLoan);
  DB.loans = loans;

  document.getElementById('lr-valor').value = '';
  document.getElementById('lr-motivo').value = '';
  document.getElementById('lr-desc').value = '';
  if (document.getElementById('lr-avalista-nome')) document.getElementById('lr-avalista-nome').value = '';
  if (document.getElementById('lr-avalista-cpf')) document.getElementById('lr-avalista-cpf').value = '';
  if (document.getElementById('lr-avalista-tel')) document.getElementById('lr-avalista-tel').value = '';
  if (document.getElementById('lr-avalista-renda')) document.getElementById('lr-avalista-renda').value = '';
  updateLoanPreview();

  capturedSelfie = null;
  capturedLocation = null;
  document.getElementById('security-result').style.display = 'none';
  document.getElementById('btn-start-camera').style.display = 'block';

  toast('Pedido enviado!', 'Seu pedido foi enviado e será analisado em até 24h. Você receberá um SMS! 📱', 'success');
  clientNav('my-loans');
}

function updateLoanPreview() {
  const rawValor = document.getElementById('lr-valor').value.replace(/[^0-9]/g, '') / 100;
  const prazo = parseInt(document.getElementById('lr-prazo').value) || 3;

  document.getElementById('prev-valor').textContent = formatMoney(rawValor || 0);
  document.getElementById('prev-prazo').textContent = `${prazo} ${prazo === 1 ? 'mês' : 'meses'}`;
}

// ══════════════════════════════════════
// ADMIN PORTAL
// ══════════════════════════════════════
function enterAdmin() {
  goTo('screen-admin');

  const user = DB.currentUser || {};
  const isSuper = user.creditorId === 'all';

  // Show logged-in creditor name in sidebar footer
  const userLabel = document.getElementById('admin-user-label');
  if (userLabel) userLabel.textContent = `👤 ${user.nome || 'Administrador'}`;

  // Show/Hide Rede de Credores (only for Super Admin)
  const redeNav = document.getElementById('anav-rede');
  if (redeNav) redeNav.style.display = isSuper ? 'block' : 'none';

  // Show/Hide Chat (for Padrinho / Afiliado — not for Super Admin)
  const chatNav = document.getElementById('anav-chat');
  if (chatNav) chatNav.style.display = (!isSuper) ? 'block' : 'none';

  // Run overdue check when admin opens panel
  checkOverdueInstallments();

  adminNav('overview');
  updateAdminBadges();
  loadSettings();
}

function adminNav(section) {
  document.querySelectorAll('#screen-admin .nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('#admin-main .content-section').forEach(s => s.classList.add('hidden'));

  const navEl = document.getElementById(`anav-${section}`);
  if (navEl) navEl.classList.add('active');

  const secMap = {
    'overview':  'adm-overview',
    'requests':  'adm-requests',
    'loans':     'adm-loans',
    'clients':   'adm-clients',
    'sms':       'adm-sms',
    'rede':      'adm-rede',
    'chat':      'adm-chat',
    'settings':  'adm-settings',
  };

  const sEl = document.getElementById(secMap[section]);
  if (sEl) sEl.classList.remove('hidden');

  switch(section) {
    case 'overview': loadAdminOverview(); break;
    case 'requests': loadPendingRequests(); break;
    case 'loans':    loadAllLoans(); break;
    case 'clients':  loadAllClients(); break;
    case 'sms':      loadSMSPanel(); break;
    case 'rede':     loadRedePanel(); break;
    case 'chat':     loadChatPanel(); break;
  }
}

function updateAdminBadges() {
  const user = DB.currentUser || {};
  const isSuper = user.creditorId === 'all';
  const loans = isSuper ? DB.loans : DB.loans.filter(l => l.creditorId === user.creditorId || (!l.creditorId && user.creditorId === 'default'));

  const pending = loans.filter(l => l.status === 'pending').length;
  const overdue = loans.filter(l => l.status === 'overdue').length;

  const badge = document.getElementById('badge-requests');
  if (badge) { badge.textContent = pending; badge.style.display = pending ? 'inline-block' : 'none'; }

  const overdueEl = document.getElementById('badge-overdue');
  if (overdueEl) { overdueEl.textContent = overdue; overdueEl.style.display = overdue ? 'inline-block' : 'none'; }
}

function loadAdminOverview() {
  const user = DB.currentUser || {};
  const isSuper = user.creditorId === 'all';
  const settings = DB.settings;
  
  // Find current creditor info (role, padrinho)
  const creditors = settings.creditors || DEFAULT_SETTINGS.creditors || [];
  const currentCreditor = creditors.find(c => c.id === user.creditorId) || {};
  const isPadrinho = currentCreditor.role === 'padrinho';

  // Show/Hide Padrinho Filter Select
  const padrinhoFilterCont = document.getElementById('padrinho-filter-container');
  if (padrinhoFilterCont) {
    padrinhoFilterCont.style.display = isPadrinho ? 'flex' : 'none';
  }

  // Filter selection
  const filterType = document.getElementById('padrinho-filter-select')?.value || 'rede';

  let loans = [];
  let clients = [];

  if (isSuper) {
    loans = DB.loans;
    clients = DB.clients;
  } else if (isPadrinho && filterType === 'rede') {
    // Get affiliates
    const affiliates = creditors.filter(c => c.padrinhoId === user.creditorId);
    const affiliateIds = affiliates.map(a => a.id);
    loans = DB.loans.filter(l => l.creditorId === user.creditorId || affiliateIds.includes(l.creditorId) || (!l.creditorId && user.creditorId === 'default'));
    clients = DB.clients.filter(c => c.creditorId === user.creditorId || affiliateIds.includes(c.creditorId) || (!c.creditorId && user.creditorId === 'default'));
  } else {
    // Just own
    loans = DB.loans.filter(l => l.creditorId === user.creditorId || (!l.creditorId && user.creditorId === 'default'));
    clients = DB.clients.filter(c => c.creditorId === user.creditorId || (!c.creditorId && user.creditorId === 'default'));
  }

  // Affiliate warning alert check
  const alertBanner = document.getElementById('affiliate-alert-banner');
  if (alertBanner) {
    if (currentCreditor.role === 'afiliado') {
      const myOverdueLoans = DB.loans.filter(l => l.status === 'overdue' && (l.creditorId === user.creditorId || (!l.creditorId && user.creditorId === 'default')));
      if (myOverdueLoans.length > 0) {
        alertBanner.innerHTML = `⚠️ <strong>Alerta de Pendência</strong>: Você possui ${myOverdueLoans.length} empréstimo(s) em atraso na sua carteira. Existe uma pendência de acerto ativa com seu Padrinho!`;
        alertBanner.style.display = 'block';
      } else {
        alertBanner.style.display = 'none';
      }
    } else {
      alertBanner.style.display = 'none';
    }
  }

  const activeLoans   = loans.filter(l => l.status === 'active');
  const overdueLoans  = loans.filter(l => l.status === 'overdue');
  const paidLoans     = loans.filter(l => l.status === 'paid');
  const allApproved   = loans.filter(l => l.status !== 'pending' && l.status !== 'rejected');

  const totalEmprestado = activeLoans.concat(overdueLoans).reduce((acc, l) => acc + l.valor, 0);
  const totalAReceber   = activeLoans.concat(overdueLoans).reduce((acc, l) => {
    if (!l.parcelas) return acc;
    return acc + l.parcelas.filter(p => p.status !== 'paid').reduce((a, p) => a + p.valor, 0);
  }, 0);

  // Calcula juros recebidos (lucro realizado) e a receber (lucro pendente)
  let jurosRecebidos = 0;
  let jurosAReceber = 0;

  allApproved.forEach(l => {
    if (!l.parcelas) return;
    const taxa = l.juros || 0;
    const tipo = l.tipoModalidade || 'convencional';
    l.parcelas.forEach(p => {
      let jurosPortion = 0;
      if (tipo === 'juros_mensais') {
        jurosPortion = l.valor * (taxa / 100);
      } else {
        const interestTotal = (l.totalComJuros || 0) - l.valor;
        jurosPortion = l.prazo > 0 ? interestTotal / l.prazo : interestTotal;
      }
      jurosPortion = parseFloat(jurosPortion.toFixed(2));

      if (p.status === 'paid') {
        jurosRecebidos += jurosPortion;
      } else if (l.status === 'active' || l.status === 'overdue') {
        jurosAReceber += jurosPortion;
      }
    });
  });

  jurosRecebidos = parseFloat(jurosRecebidos.toFixed(2));
  jurosAReceber = parseFloat(jurosAReceber.toFixed(2));

  // Comissão calculation
  let comissoesPendentes = 0;
  let comissoesPagas = 0;
  loans.forEach(l => {
    if (l.comissao) {
      if (l.comissao.status === 'paid') {
        comissoesPagas += l.comissao.total;
      } else {
        comissoesPendentes += l.comissao.total;
      }
    }
  });

  document.getElementById('adm-total-emprestado').textContent = formatMoney(totalEmprestado);
  document.getElementById('adm-a-receber').textContent        = formatMoney(totalAReceber);
  document.getElementById('adm-total-clientes').textContent   = clients.length;
  document.getElementById('adm-atrasados').textContent        = overdueLoans.length;
  document.getElementById('adm-emprestimos-ativos').textContent = activeLoans.length;
  
  const elJurosRec = document.getElementById('adm-juros-recebidos');
  if (elJurosRec) elJurosRec.textContent = formatMoney(jurosRecebidos);
  
  const elJurosPen = document.getElementById('adm-juros-a-receber');
  if (elJurosPen) elJurosPen.textContent = formatMoney(jurosAReceber);

  const elComPend = document.getElementById('adm-com-pendentes');
  if (elComPend) elComPend.textContent = formatMoney(comissoesPendentes);

  const elComPag = document.getElementById('adm-com-pagas');
  if (elComPag) elComPag.textContent = formatMoney(comissoesPagas);

  // Próximos vencimentos (30 dias)
  const today = new Date();
  const in30 = new Date(); in30.setDate(today.getDate() + 30);

  const upcoming = [];
  activeLoans.concat(overdueLoans).forEach(l => {
    if (!l.parcelas) return;
    l.parcelas.forEach(p => {
      if (p.status === 'pending' || p.status === 'overdue') {
        const vctoDate = new Date(p.vcto);
        if (vctoDate <= in30) {
          const client = clients.find(c => c.id === l.clientId);
          const daysTo = Math.floor((vctoDate - today) / 86400000);
          upcoming.push({ loan: l, parcela: p, client, daysTo });
        }
      }
    });
  });

  upcoming.sort((a, b) => new Date(a.parcela.vcto) - new Date(b.parcela.vcto));

  const vctoEl = document.getElementById('adm-vencimentos');
  if (!upcoming.length) {
    vctoEl.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><p>Nenhum vencimento nos próximos 30 dias.</p></div>`;
  } else {
    vctoEl.innerHTML = upcoming.map(({loan, parcela, client, daysTo}) => `
      <div class="vcto-item">
        <div>
          <div class="vcto-client">${client ? client.nome : '—'}</div>
          <div class="vcto-phone">${client ? client.tel : '—'}</div>
        </div>
        <div><label style="font-size:11px;color:var(--text-muted)">Parcela</label><span style="font-size:14px;font-weight:600">${parcela.n}ª de ${loan.prazo}</span></div>
        <div><label style="font-size:11px;color:var(--text-muted)">Valor</label><span style="font-size:14px;font-weight:700;color:var(--green)">${formatMoney(parcela.valor)}</span></div>
        <div><label style="font-size:11px;color:var(--text-muted)">Vencimento</label>
          <span class="status-badge ${daysTo < 0 ? 'status-overdue' : daysTo <= 3 ? 'status-pending' : 'status-active'}">
            ${daysTo < 0 ? `${Math.abs(daysTo)}d atrasado` : daysTo === 0 ? 'HOJE' : `em ${daysTo}d`}
          </span>
        </div>
        <button class="btn-sms-single" onclick="quickSMS('${client ? client.id : ''}', '${loan.id}', '${daysTo < 0 ? 'atraso' : 'vencimento'}')">📱 SMS</button>
      </div>`).join('');
  }

  // Performance bars
  const perfEl = document.getElementById('adm-performance');
  const totalLimite = 50000;
  perfEl.innerHTML = [
    { label: 'Capital na Rua (Principal)', value: totalEmprestado, max: totalLimite, color: '#22c55e' },
    { label: 'Total a Receber (Principal + Juros)', value: totalAReceber, max: totalLimite, color: '#3b82f6' },
    { label: 'Juros Recebidos (Lucro Realizado)', value: jurosRecebidos, max: totalLimite, color: '#14b8a6' },
    { label: 'Juros a Receber (Lucro Pendente)', value: jurosAReceber, max: totalLimite, color: '#a855f7' },
  ].map(item => `
    <div class="perf-item">
      <div class="perf-label"><span>${item.label}</span><strong>${formatMoney(item.value)}</strong></div>
      <div class="perf-bar"><div class="perf-fill" style="width:${Math.min(100, (item.value/item.max)*100).toFixed(1)}%;background:${item.color}"></div></div>
    </div>`).join('');

  // --- Calcs for Fechamento Financeiro ---
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);

  const weekStart = new Date(); weekStart.setHours(0,0,0,0);
  const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7); weekEnd.setHours(23,59,59,999);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0,0,0,0);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23,59,59,999);

  const statsHoje = getClosingStatsForRange(activeLoans.concat(overdueLoans), settings, todayStart, todayEnd);
  const statsSemana = getClosingStatsForRange(activeLoans.concat(overdueLoans), settings, weekStart, weekEnd);
  const statsMes = getClosingStatsForRange(activeLoans.concat(overdueLoans), settings, startOfMonth, endOfMonth);

  if (document.getElementById('report-hoje-total')) {
    document.getElementById('report-hoje-total').textContent = formatMoney(statsHoje.total);
    document.getElementById('report-hoje-principal').textContent = formatMoney(statsHoje.principal);
    document.getElementById('report-hoje-juros').textContent = formatMoney(statsHoje.juros);
    document.getElementById('report-hoje-atraso').textContent = formatMoney(statsHoje.atraso);
  }

  if (document.getElementById('report-semana-total')) {
    document.getElementById('report-semana-total').textContent = formatMoney(statsSemana.total);
    document.getElementById('report-semana-principal').textContent = formatMoney(statsSemana.principal);
    document.getElementById('report-semana-juros').textContent = formatMoney(statsSemana.juros);
    document.getElementById('report-semana-atraso').textContent = formatMoney(statsSemana.atraso);
  }

  if (document.getElementById('report-mes-total')) {
    document.getElementById('report-mes-total').textContent = formatMoney(statsMes.total);
    document.getElementById('report-mes-principal').textContent = formatMoney(statsMes.principal);
    document.getElementById('report-mes-juros').textContent = formatMoney(statsMes.juros);
    document.getElementById('report-mes-atraso').textContent = formatMoney(statsMes.atraso);
  }

  // Set default date input for custom projection if empty
  const dateInput = document.getElementById('proj-date-select');
  if (dateInput && !dateInput.value) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    dateInput.value = tomorrow.toISOString().split('T')[0];
  }
  updateCustomProjection();
}

function calcLateInterest(parcela, taxaAtraso) {
  if (parcela.status === 'paid') return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const vcto = new Date(parcela.vcto + 'T12:00:00');
  vcto.setHours(0, 0, 0, 0);
  if (today <= vcto) return 0;

  const diffTime = Math.abs(today - vcto);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  const interest = parcela.valor * (taxaAtraso / 100) * diffDays;
  return parseFloat(interest.toFixed(2));
}

function getClosingStatsForRange(loans, settings, startDate, endDate) {
  let principal = 0;
  let juros = 0;
  let atraso = 0;

  loans.forEach(l => {
    if (!l.parcelas) return;
    const taxa = l.juros || 0;
    const tipo = l.tipoModalidade || 'convencional';
    const taxaAtraso = settings.taxaAtraso || 1;

    l.parcelas.forEach(p => {
      const pDate = new Date(p.vcto + 'T12:00:00');
      pDate.setHours(0, 0, 0, 0);

      if (pDate >= startDate && pDate <= endDate) {
        if (p.status !== 'paid') {
          let jurosPortion = 0;
          if (tipo === 'juros_mensais') {
            jurosPortion = l.valor * (taxa / 100);
          } else {
            const interestTotal = (l.totalComJuros || 0) - l.valor;
            jurosPortion = l.prazo > 0 ? interestTotal / l.prazo : interestTotal;
          }
          jurosPortion = parseFloat(jurosPortion.toFixed(2));

          let princPortion = p.valor - jurosPortion;
          if (princPortion < 0) princPortion = 0;

          principal += princPortion;
          juros += jurosPortion;

          const late = calcLateInterest(p, taxaAtraso);
          atraso += late;
        }
      }
    });
  });

  return {
    principal: parseFloat(principal.toFixed(2)),
    juros: parseFloat(juros.toFixed(2)),
    atraso: parseFloat(atraso.toFixed(2)),
    total: parseFloat((principal + juros + atraso).toFixed(2))
  };
}

function updateCustomProjection() {
  const dateInput = document.getElementById('proj-date-select');
  if (!dateInput || !dateInput.value) return;

  const targetDateStart = new Date(dateInput.value + 'T00:00:00');
  const targetDateEnd = new Date(dateInput.value + 'T23:59:59');

  const user = DB.currentUser || {};
  const isSuper = user.creditorId === 'all';
  const loans = isSuper ? DB.loans : DB.loans.filter(l => l.creditorId === user.creditorId || (!l.creditorId && user.creditorId === 'default'));
  const activeLoans = loans.filter(l => l.status === 'active');
  const overdueLoans = loans.filter(l => l.status === 'overdue');

  const settings = DB.settings;
  const stats = getClosingStatsForRange(activeLoans.concat(overdueLoans), settings, targetDateStart, targetDateEnd);

  if (document.getElementById('report-custom-total')) {
    document.getElementById('report-custom-total').textContent = formatMoney(stats.total);
    document.getElementById('report-custom-principal').textContent = formatMoney(stats.principal);
    document.getElementById('report-custom-juros').textContent = formatMoney(stats.juros);
    document.getElementById('report-custom-atraso').textContent = formatMoney(stats.atraso);
  }
}

function loadPendingRequests() {
  const user = DB.currentUser || {};
  const isSuper = user.creditorId === 'all';
  
  const pending = DB.loans.filter(l => l.status === 'pending' && (isSuper || l.creditorId === user.creditorId || (!l.creditorId && user.creditorId === 'default')));
  const clients = isSuper ? DB.clients : DB.clients.filter(c => c.creditorId === user.creditorId || (!c.creditorId && user.creditorId === 'default'));
  const settings = DB.settings;
  const container = document.getElementById('adm-requests-list');

  if (!pending.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><p>Nenhuma solicitação pendente!</p></div>`;
    return;
  }

  container.innerHTML = pending.map(l => {
    const client = clients.find(c => c.id === l.clientId) || {};
    const defaultRate = settings.taxas[l.prazo] || 25;
    const totalCalc = calcTotal(l.valor, defaultRate);
    const parcela = l.prazo > 0 ? (totalCalc / l.prazo) : totalCalc;

    return `
      <div class="request-card">
        <div class="request-header">
          <div>
            <div class="request-client">${client.nome || 'Cliente desconhecido'}</div>
            <div style="font-size:12px;color:var(--text-sec)">${client.cpf || ''} · ${client.tel || ''}</div>
          </div>
          <div class="request-date">${formatDateTime(l.createdAt)}</div>
        </div>
        <div class="request-body">
          <div class="req-field"><label>Valor Solicitado</label><span class="req-value" style="color:var(--green)">${formatMoney(l.valor)}</span></div>
          <div class="req-field"><label>Prazo</label><span class="req-value">${l.prazo} ${l.prazo===1?'mês':'meses'}</span></div>
          <div class="req-field"><label>Motivo</label><span class="req-value" style="font-size:13px">${l.motivo || '—'}</span></div>
          <div class="req-field"><label>Emprego/Trabalho</label><span class="req-value" style="font-size:13px">${client.emprego || '—'} ${client.trabalho ? '('+client.trabalho+')' : ''}</span></div>
          <div class="req-field"><label>Renda</label><span class="req-value">${client.renda || '—'}</span></div>
          <div class="req-field"><label>Cidade</label><span class="req-value">${client.cidade || '—'}/${client.estado || ''}</span></div>
          <div class="req-field"><label>Garantia</label><span class="req-value" style="font-size:13px">${client.garantia || 'Nenhuma'}</span></div>
          <div class="req-field"><label>Indicação</label><span class="req-value" style="font-size:13px">${client.indicacao || 'Nenhuma'}</span></div>
          ${l.descricao ? `<div class="req-field" style="grid-column:1/-1"><label>Descrição</label><span style="font-size:13px;color:var(--text-sec)">${l.descricao}</span></div>` : ''}
          ${l.selfie ? `<div class="req-field" style="grid-column:1/-1; margin-top:10px;"><label>Foto de Segurança</label><img src="${l.selfie}" style="max-height:100px; border-radius:4px; border:2px solid var(--border);" /></div>` : ''}
          ${l.location ? `<div class="req-field" style="grid-column:1/-1;"><label>Localização GPS</label><a href="https://www.google.com/maps?q=${l.location.lat},${l.location.lng}" target="_blank" style="color:var(--blue); font-size:13px; text-decoration:underline;">📍 Abrir no Google Maps</a></div>` : ''}
        </div>
        <div class="request-footer">
          <div class="interest-input">
            <label>Taxa de Juros (%):</label>
            <input type="number" id="taxa-${l.id}" value="${defaultRate}" min="0" max="200" step="0.5"
              oninput="recalcApproval('${l.id}', ${l.valor}, ${l.prazo})" />
            <span id="calc-${l.id}" style="font-size:13px;color:var(--text-sec)">
              Total: <strong style="color:var(--green)">${formatMoney(totalCalc)}</strong> · Parcela: <strong>${formatMoney(parcela)}</strong>
            </span>
          </div>
          <div class="req-actions">
            <button class="btn-danger" onclick="quickReject('${l.id}')">❌ Recusar</button>
            <button class="btn-primary" onclick="openApproveModal('${l.id}')">✅ Aprovar</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function recalcApproval(loanId, valor, prazo) {
  const taxa = parseFloat(document.getElementById(`taxa-${loanId}`).value) || 0;
  const total = calcTotal(valor, taxa);
  const parcela = prazo > 0 ? total / prazo : total;
  const el = document.getElementById(`calc-${loanId}`);
  if (el) el.innerHTML = `Total: <strong style="color:var(--green)">${formatMoney(total)}</strong> · Parcela: <strong>${formatMoney(parcela)}</strong>`;
}

function getDefaultDate(daysToAdd = 30) {
  const d = new Date();
  d.setDate(d.getDate() + daysToAdd);
  return d.toISOString().split('T')[0];
}

function openApproveModal(loanId) {
  const loan = DB.loans.find(l => l.id === loanId);
  const client = DB.clients.find(c => c.id === loan.clientId) || {};
  const settings = DB.settings;
  const defaultRate = loan.juros || settings.taxas[loan.prazo] || 25;

  currentLoanId = loanId;

  const total = calcTotal(loan.valor, defaultRate);
  const parcela = loan.prazo > 0 ? total / loan.prazo : total;
  const aval = loan.avalista || {};

  document.getElementById('modal-approve-content').innerHTML = `
    <div class="approve-grid">
      <div class="approve-field"><label>Cliente</label><span>${client.nome}</span></div>
      <div class="approve-field"><label>Telefone (SMS)</label><span>${client.tel}</span></div>
      <div class="approve-field"><label>Valor</label><span style="color:var(--green)">${formatMoney(loan.valor)}</span></div>
      <div class="approve-field"><label>Prazo</label><span>${loan.prazo} ${loan.prazo===1?'mês':'meses'}</span></div>
      <div class="approve-field"><label>Motivo</label><span>${loan.motivo || '—'}</span></div>
      <div class="approve-field"><label>Emprego/Trabalho</label><span>${client.emprego || '—'} ${client.trabalho ? '('+client.trabalho+')' : ''}</span></div>
      
      <div class="approve-interest" style="grid-column: 1 / -1; border-top: 1px solid var(--border); padding-top: 12px; margin-top: 5px;">
        <label style="font-weight:700;display:block;margin-bottom:8px;">⚙️ Configuração do Pagamento & Juros:</label>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
          <div class="input-group">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Modalidade:</label>
            <select id="modal-tipo" onchange="updateModalCalc(${loan.valor}, ${loan.prazo})">
              <option value="convencional">Parcelas Fixas (Principal + Juros)</option>
              <option value="juros_mensais">Só Juros Mensais (Principal no Final)</option>
            </select>
          </div>
          <div class="input-group">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">1º Vencimento:</label>
            <input type="date" id="modal-vcto" value="${getDefaultDate(30)}" />
          </div>
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-top:10px; margin-bottom: 5px;">
          <label style="display:flex; align-items:center; gap:6px; font-size:13px; color:var(--text-main); cursor:pointer;">
            <input type="checkbox" id="modal-aprov-avalista" ${loan.avalista ? 'checked' : ''} /> 🛡️ Liberar com Avalista
          </label>
          <label style="display:flex; align-items:center; gap:6px; font-size:13px; color:var(--text-main); cursor:pointer;">
            <input type="checkbox" id="modal-aprov-garantia" ${client.garantia ? 'checked' : ''} /> 🚗 Liberar com Garantia
          </label>
        </div>
        <div class="interest-row" style="margin-top:12px; display:flex; align-items:center; gap:8px;">
          <div style="width: 100px;">
            <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Taxa (%):</label>
            <input type="number" id="modal-taxa" value="${defaultRate}" min="0" max="200" step="0.5" oninput="updateModalCalc(${loan.valor}, ${loan.prazo})" />
          </div>
          <div style="flex:1; margin-top: 18px;">
            <span style="font-size:12px;color:var(--text-muted);margin-right:8px" id="modal-taxa-label">% ao período</span>
            <span class="calc-result" id="modal-calc" style="font-weight:600;">
              Total: <strong>${formatMoney(total)}</strong> · ${loan.prazo}x de <strong>${formatMoney(parcela)}</strong>
            </span>
          </div>
        </div>
      </div>

      <div class="approve-avalista" style="grid-column: 1 / -1; border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px;">
        <label style="font-weight:700;display:block;margin-bottom:8px;">🛡️ Informações do Avalista / Fiador:</label>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
          <div class="input-group">
            <label style="font-size:12px;color:var(--text-muted);">Nome do Avalista:</label>
            <input type="text" id="modal-aval-nome" value="${aval.nome || ''}" placeholder="Nome Completo" />
          </div>
          <div class="input-group">
            <label style="font-size:12px;color:var(--text-muted);">CPF do Avalista:</label>
            <input type="text" id="modal-aval-cpf" value="${aval.cpf || ''}" placeholder="000.000.000-00" maxlength="14" oninput="maskCPF(this)" />
          </div>
          <div class="input-group">
            <label style="font-size:12px;color:var(--text-muted);">Telefone do Avalista:</label>
            <input type="text" id="modal-aval-tel" value="${aval.tel || ''}" placeholder="(00) 00000-0000" maxlength="15" oninput="maskPhone(this)" />
          </div>
          <div class="input-group">
            <label style="font-size:12px;color:var(--text-muted);">Renda do Avalista:</label>
            <input type="text" id="modal-aval-renda" value="${aval.renda || ''}" placeholder="R$ 0,00" oninput="maskMoney(this)" />
          </div>
        </div>
      </div>

      <div class="approve-comissao" style="grid-column: 1 / -1; border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; margin-bottom: 8px;">
        <label style="font-weight:700;display:block;margin-bottom:8px;">💰 Comissão do Consultor / Agente:</label>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
          <div class="input-group">
            <label style="font-size:12px;color:var(--text-muted);">Nome do Consultor:</label>
            <input type="text" id="modal-com-agente" placeholder="Ex: João Silva" />
          </div>
          <div class="input-group">
            <label style="font-size:12px;color:var(--text-muted);">Tipo de Comissão:</label>
            <select id="modal-com-tipo" onchange="updateModalCalc(${loan.valor}, ${loan.prazo})">
              <option value="nenhuma">Sem comissão</option>
              <option value="porcentagem">Percentual (% do Principal)</option>
              <option value="valor">Valor Fixo (R$)</option>
            </select>
          </div>
          <div class="input-group">
            <label style="font-size:12px;color:var(--text-muted);">Valor da Comissão (% ou R$):</label>
            <input type="number" id="modal-com-valor" value="0" min="0" step="0.1" oninput="updateModalCalc(${loan.valor}, ${loan.prazo})" />
          </div>
          <div class="input-group">
            <label style="font-size:12px;color:var(--text-muted);">Origem da Comissão:</label>
            <select id="modal-com-origem" onchange="updateModalCalc(${loan.valor}, ${loan.prazo})">
              <option value="por_fora">Paga separadamente (Por fora)</option>
              <option value="descontada">Descontada do empréstimo (Líquido)</option>
            </select>
          </div>
        </div>
        <div id="modal-com-resumo" style="margin-top:10px; font-size:13px; color:var(--text-sec);">
          Sem comissão · Valor Líquido a Entregar: <strong style="color:var(--green)">${formatMoney(loan.valor)}</strong>
        </div>
      </div>
    </div>`;

  document.getElementById('modal-approve').classList.remove('hidden');
}

function updateModalCalc(valor, prazo) {
  const taxa = parseFloat(document.getElementById('modal-taxa').value) || 0;
  const tipo = document.getElementById('modal-tipo').value;
  const lbl = document.getElementById('modal-taxa-label');

  if (tipo === 'convencional') {
    lbl.textContent = '% ao período';
    const total = calcTotal(valor, taxa);
    const parcela = prazo > 0 ? total / prazo : total;
    document.getElementById('modal-calc').innerHTML = `Total: <strong>${formatMoney(total)}</strong> · ${prazo}x de <strong>${formatMoney(parcela)}</strong>`;
  } else {
    lbl.textContent = '% ao mês';
    const jurosMensal = valor * (taxa / 100);
    const total = (jurosMensal * prazo) + valor;
    document.getElementById('modal-calc').innerHTML = `Juros: <strong>${formatMoney(jurosMensal)}/mês</strong> · Final: <strong>${formatMoney(valor + jurosMensal)}</strong>`;
  }

  // Comissão & Líquido
  const comTipo = document.getElementById('modal-com-tipo').value;
  const comValInput = parseFloat(document.getElementById('modal-com-valor').value) || 0;
  const comOrigem = document.getElementById('modal-com-origem').value;

  let comTotal = 0;
  if (comTipo === 'porcentagem') {
    comTotal = valor * (comValInput / 100);
  } else if (comTipo === 'valor') {
    comTotal = comValInput;
  }

  let liquido = valor;
  if (comOrigem === 'descontada' && comTipo !== 'nenhuma') {
    liquido = valor - comTotal;
  }

  const resumen = document.getElementById('modal-com-resumo');
  if (resumen) {
    if (comTipo === 'nenhuma') {
      resumen.innerHTML = `Sem comissão · Valor Líquido a Entregar: <strong style="color:var(--green)">${formatMoney(valor)}</strong>`;
    } else {
      resumen.innerHTML = `Comissão: <strong>${formatMoney(comTotal)}</strong> (${comTipo === 'porcentagem' ? comValInput+'%' : 'Fixo'}) · Origem: <strong>${comOrigem === 'descontada' ? 'Descontada' : 'Por fora'}</strong> · Valor Líquido a Entregar: <strong style="color:var(--green)">${formatMoney(liquido)}</strong>`;
    }
  }
}

function approveLoan() {
  if (!currentLoanId) return;
  const taxa = parseFloat(document.getElementById('modal-taxa').value) || 0;
  const tipo = document.getElementById('modal-tipo').value;
  const vcto = document.getElementById('modal-vcto').value;

  // Avalista
  const avalNome = document.getElementById('modal-aval-nome').value.trim();
  const avalCpf = document.getElementById('modal-aval-cpf').value.trim();
  const avalTel = document.getElementById('modal-aval-tel').value.trim();
  const avalRenda = document.getElementById('modal-aval-renda').value.trim();
  let avalista = null;
  if (avalNome || avalCpf || avalTel || avalRenda) {
    avalista = { nome: avalNome || '—', cpf: avalCpf || '—', tel: avalTel || '—', renda: avalRenda || '—' };
  }

  // Comissão
  const comAgente = document.getElementById('modal-com-agente').value.trim();
  const comTipo = document.getElementById('modal-com-tipo').value;
  const comValor = parseFloat(document.getElementById('modal-com-valor').value) || 0;
  const comOrigem = document.getElementById('modal-com-origem').value;

  // Selective Approvals
  const avalistaAprovado = document.getElementById('modal-aprov-avalista').checked;
  const garantiaAprovada = document.getElementById('modal-aprov-garantia').checked;

  approveWithRate(currentLoanId, taxa, tipo, vcto, avalista, { agente: comAgente, tipo: comTipo, valor: comValor, origem: comOrigem }, avalistaAprovado, garantiaAprovada);
  closeModal('modal-approve');
}

function approveWithRate(loanId, taxa, tipo = 'convencional', primeiroVcto = null, avalista = null, comissaoData = null, avalistaAprovado = false, garantiaAprovada = false) {
  const loans = DB.loans;
  const idx = loans.findIndex(l => l.id === loanId);
  if (idx === -1) return;

  const l = loans[idx];
  let parcelas = [];
  let total = 0;
  let parcelaDesc = '';

  const dataBase = primeiroVcto ? new Date(primeiroVcto + 'T12:00:00') : new Date(new Date().getTime() + 30 * 86400000);

  if (tipo === 'convencional') {
    total = calcTotal(l.valor, taxa);
    const parcelaVal = parseFloat((total / l.prazo).toFixed(2));
    for (let i = 1; i <= l.prazo; i++) {
      const vcto = new Date(dataBase);
      vcto.setMonth(vcto.getMonth() + (i - 1));
      parcelas.push({ n: i, valor: parcelaVal, vcto: vcto.toISOString().split('T')[0], status: 'pending' });
    }
    parcelaDesc = formatMoney(parcelaVal);
  } else {
    const jurosMensal = parseFloat((l.valor * (taxa / 100)).toFixed(2));
    total = (jurosMensal * l.prazo) + l.valor;
    for (let i = 1; i <= l.prazo; i++) {
      const vcto = new Date(dataBase);
      vcto.setMonth(vcto.getMonth() + (i - 1));
      const isLast = i === l.prazo;
      const val = isLast ? (l.valor + jurosMensal) : jurosMensal;
      parcelas.push({ n: i, valor: val, vcto: vcto.toISOString().split('T')[0], status: 'pending' });
    }
    parcelaDesc = `${formatMoney(jurosMensal)}/mês`;
  }

  // Comissão calculation
  let comissao = null;
  if (comissaoData && comissaoData.tipo !== 'nenhuma' && (comissaoData.agente || comissaoData.valor)) {
    let comTotal = 0;
    if (comissaoData.tipo === 'porcentagem') {
      comTotal = parseFloat((l.valor * (comissaoData.valor / 100)).toFixed(2));
    } else {
      comTotal = parseFloat(comissaoData.valor.toFixed(2));
    }
    comissao = {
      agente: comissaoData.agente || 'Sem Nome',
      tipo: comissaoData.tipo,
      valor: comissaoData.valor,
      origem: comissaoData.origem,
      total: comTotal,
      status: 'pending'
    };
  }

  const historico = l.historico || [
    { status: 'pending', data: l.createdAt || new Date().toISOString(), detalhes: 'Solicitação criada pelo cliente.' }
  ];
  
  historico.push({
    status: 'active',
    data: new Date().toISOString(),
    detalhes: `Aprovado com taxa de ${taxa}%, modalidade ${tipo === 'convencional' ? 'Parcelas Fixas' : 'Só Juros Mensais'}.${comissao ? ` Consultor ${comissao.agente} (Comissão: ${formatMoney(comissao.total)}).` : ''} Decisão: Avalista: ${avalistaAprovado ? 'Liberado' : 'Rejeitado/Não Exigido'}, Garantia: ${garantiaAprovada ? 'Liberada' : 'Rejeitada/Não Exigida'}.`
  });

  loans[idx] = {
    ...l,
    status: 'active',
    juros: taxa,
    tipoModalidade: tipo,
    totalComJuros: total,
    parcelas,
    approvedAt: new Date().toISOString(),
    avalista: avalista || l.avalista,
    comissao: comissao,
    historico: historico,
    avalistaAprovado: avalistaAprovado,
    garantiaAprovada: garantiaAprovada
  };

  DB.loans = loans;

  const client = DB.clients.find(c => c.id === l.clientId);
  if (client) {
    const msg = `ÁgilBank: Parabéns ${client.nome.split(' ')[0]}! Seu empréstimo de ${formatMoney(l.valor)} foi APROVADO! Taxa: ${taxa}%. Total: ${formatMoney(total)} em ${l.prazo}x. Parcela: ${parcelaDesc}. Dúvidas? (11) 9999-0000`;
    logSMS(client, msg, 'Aprovação de Empréstimo');
    toast('✅ Aprovado!', `Empréstimo aprovado e SMS enviado para ${client.tel}`, 'success');
  }

  updateAdminBadges();
  loadPendingRequests();
  loadAdminOverview();
}

function quickReject(loanId) {
  if (!confirm('Deseja recusar esta solicitação?')) return;
  rejectWithId(loanId);
}

function rejectLoan() {
  if (!currentLoanId) return;
  rejectWithId(currentLoanId);
  closeModal('modal-approve');
}

function rejectWithId(loanId) {
  const loans = DB.loans;
  const idx = loans.findIndex(l => l.id === loanId);
  if (idx === -1) return;

  const l = loans[idx];
  const client = DB.clients.find(c => c.id === l.clientId);

  loans[idx].status = 'rejected';
  DB.loans = loans;

  if (client) {
    const msg = `ÁgilBank: Olá ${client.nome.split(' ')[0]}, infelizmente sua solicitação de empréstimo de ${formatMoney(l.valor)} não pôde ser aprovada no momento. Entre em contato para mais informações.`;
    logSMS(client, msg, 'Recusa de Empréstimo');
    toast('Recusado', `Solicitação recusada. SMS enviado para ${client.tel}`, 'warning');
  }

  updateAdminBadges();
  loadPendingRequests();
}

function loadAllLoans(filter) {
  if (filter) currentLoansFilter = filter;
  const user = DB.currentUser || {};
  const isSuper = user.creditorId === 'all';
  const settings = DB.settings;
  const creditors = settings.creditors || DEFAULT_SETTINGS.creditors || [];
  const currentCreditor = creditors.find(c => c.id === user.creditorId) || {};
  const isPadrinho = currentCreditor.role === 'padrinho';
  const filterType = document.getElementById('padrinho-filter-select')?.value || 'rede';

  let loans = [];
  if (isSuper) {
    loans = DB.loans;
  } else if (isPadrinho && filterType === 'rede') {
    const affiliates = creditors.filter(c => c.padrinhoId === user.creditorId);
    const affiliateIds = affiliates.map(a => a.id);
    loans = DB.loans.filter(l => l.creditorId === user.creditorId || affiliateIds.includes(l.creditorId) || (!l.creditorId && user.creditorId === 'default'));
  } else {
    loans = DB.loans.filter(l => l.creditorId === user.creditorId || (!l.creditorId && user.creditorId === 'default'));
  }

  const searchVal = document.getElementById('adm-search-loan')?.value.toLowerCase() || '';

  if (currentLoansFilter !== 'all') {
    loans = loans.filter(l => l.status === currentLoansFilter);
  }

  if (searchVal) {
    const clients = DB.clients;
    loans = loans.filter(l => {
      const c = clients.find(c => c.id === l.clientId);
      return c && (c.nome.toLowerCase().includes(searchVal) || c.cpf.includes(searchVal));
    });
  }

  const clients = DB.clients;
  const container = document.getElementById('adm-loans-list');

  if (!loans.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">💰</div><p>Nenhum empréstimo encontrado.</p></div>`;
    return;
  }

  container.innerHTML = loans.map(l => {
    const client = clients.find(c => c.id === l.clientId) || {};
    const pago = l.parcelas ? l.parcelas.filter(p => p.status === 'paid').reduce((a,p) => a+p.valor, 0) : 0;
    const pendente = l.totalComJuros ? l.totalComJuros - pago : 0;
    const nextP = l.parcelas ? l.parcelas.find(p => p.status === 'pending' || p.status === 'overdue') : null;
    return `
      <div class="loan-admin-card">
        <div>
          <div class="la-client-name">${client.nome || '—'}</div>
          <div class="la-cpf">${client.cpf || ''}</div>
        </div>
        <div class="la-field"><label>Valor</label><span>${formatMoney(l.valor)}</span></div>
        <div class="la-field"><label>Total c/ Juros</label><span style="color:var(--green)">${l.totalComJuros ? formatMoney(l.totalComJuros) : '—'}</span></div>
        <div class="la-field"><label>Pendente</label><span style="color:${pendente > 0 ? 'var(--orange)' : 'var(--text-sec)'}">${formatMoney(pendente)}</span></div>
        <div class="la-field">
          <label>Status</label>
          <span class="status-badge status-${l.status}">${statusLabel(l.status)}</span>
          ${nextP ? `<small style="display:block;margin-top:4px;font-size:11px;color:var(--text-muted)">${nextP.status === 'overdue' ? '⚠️ ATRASADO' : `Próx: ${formatDate(nextP.vcto)}`}</small>` : ''}
        </div>
        <div class="la-actions">
          <button class="btn-view" onclick="openLoanDetail('${l.id}')">👁️ Ver</button>
          ${l.status !== 'paid' && l.status !== 'rejected' ? `<button class="btn-sms-single" onclick="quickSMS('${l.clientId}', '${l.id}', '${l.status === 'overdue' ? 'atraso' : 'vencimento'}')">📱 SMS</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

function filterByStatus(status) {
  currentLoansFilter = status;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`ft-${status}`)?.classList.add('active');
  loadAllLoans();
}

function filterLoans() { loadAllLoans(); }
function filterClients() { loadAllClients(); }

function openLoanDetail(loanId) {
  const loan = DB.loans.find(l => l.id === loanId);
  const client = DB.clients.find(c => c.id === loan.clientId) || {};
  currentLoanId = loanId;

  const pago = loan.parcelas ? loan.parcelas.filter(p => p.status === 'paid').reduce((a,p) => a+p.valor,0) : 0;

  // Calculo de Líquido
  let comDeduction = 0;
  if (loan.comissao && loan.comissao.origem === 'descontada') {
    comDeduction = loan.comissao.total;
  }
  const liquidoEntregar = loan.valor - comDeduction;

  const aval = loan.avalista;
  const avalStatus = loan.avalistaAprovado ? '<span class="status-badge status-paid" style="font-size:10px;padding:2px 6px;">Liberado</span>' : '<span class="status-badge status-rejected" style="font-size:10px;padding:2px 6px;">Rejeitado/Não Exigido</span>';
  const avalHtml = aval ? `
    <div style="border: 1px solid var(--border); padding: 12px; border-radius: 6px; margin-top: 15px; background: rgba(255,255,255,0.02)">
      <h5 style="margin:0 0 8px 0; color:var(--text-main); font-size:13px; font-weight:700; display:flex; justify-content:space-between; align-items:center;">
        <span>🛡️ Avalista / Fiador</span>
        ${avalStatus}
      </h5>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:12px;">
        <div><strong>Nome:</strong> ${aval.nome}</div>
        <div><strong>CPF:</strong> ${aval.cpf}</div>
        <div><strong>Telefone:</strong> ${aval.tel}</div>
        <div><strong>Renda Mensal:</strong> ${aval.renda}</div>
      </div>
    </div>` : '';

  const garStatus = loan.garantiaAprovada ? '<span class="status-badge status-paid" style="font-size:10px;padding:2px 6px;">Liberada</span>' : '<span class="status-badge status-rejected" style="font-size:10px;padding:2px 6px;">Rejeitada/Não Exigida</span>';
  const garHtml = client.garantia ? `
    <div style="border: 1px solid var(--border); padding: 12px; border-radius: 6px; margin-top: 15px; background: rgba(255,255,255,0.02)">
      <h5 style="margin:0 0 8px 0; color:var(--text-main); font-size:13px; font-weight:700; display:flex; justify-content:space-between; align-items:center;">
        <span>🚗 Garantia Oferecida</span>
        ${garStatus}
      </h5>
      <div style="font-size:12px;">
        <strong>Itens da Garantia:</strong> ${client.garantia}
      </div>
    </div>` : '';

  const com = loan.comissao;
  let comHtml = '';
  if (com) {
    const isPaid = com.status === 'paid';
    comHtml = `
      <div style="border: 1px solid var(--border); padding: 12px; border-radius: 6px; margin-top: 15px; background: rgba(255,255,255,0.02)">
        <h5 style="margin:0 0 8px 0; color:var(--text-main); font-size:13px; font-weight:700; display:flex; justify-content:space-between; align-items:center;">
          <span>💰 Comissão do Consultor</span>
          <span class="status-badge status-${isPaid ? 'paid' : 'pending'}">${isPaid ? 'Paga' : 'Pendente'}</span>
        </h5>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:12px; margin-bottom:8px;">
          <div><strong>Consultor:</strong> ${com.agente}</div>
          <div><strong>Valor:</strong> ${formatMoney(com.total)} (${com.tipo === 'porcentagem' ? com.valor + '%' : 'Fixo'})</div>
          <div><strong>Pagamento:</strong> ${com.origem === 'descontada' ? 'Descontada (Líquido)' : 'Por fora'}</div>
        </div>
        ${!isPaid ? `<button class="btn-view" style="font-size:11px; padding:4px 8px; margin-top:4px;" onclick="payCommission('${loan.id}')">✓ Registrar Pagamento da Comissão</button>` : ''}
      </div>`;
  }

  const hist = loan.historico || [];
  const histHtml = hist.length ? `
    <div style="margin-top:15px;">
      <h5 style="margin:0 0 8px 0; color:var(--text-main); font-size:13px; font-weight:700;">📜 Histórico do Empréstimo</h5>
      <div style="max-height:100px; overflow-y:auto; border:1px solid var(--border); border-radius:6px; padding:8px; background:rgba(0,0,0,0.2)">
        ${hist.map(h => `
          <div style="font-size:11px; margin-bottom:4px; padding-bottom:4px; border-bottom:1px solid rgba(255,255,255,0.03); color:var(--text-sec);">
            <span style="color:var(--text-muted)">[${formatDateTime(h.data)}]</span> 
            <strong style="color:var(--blue)">${statusLabel(h.status)}</strong>: ${h.detalhes}
          </div>`).join('')}
      </div>
    </div>` : '';

  document.getElementById('modal-loan-detail-content').innerHTML = `
    <div class="loan-detail-content">
      <div class="loan-detail-header">
        <h4>${client.nome || '—'} — Empréstimo #${loan.id}</h4>
        <p>${client.cpf || ''} · ${client.tel || ''} · ${client.email || ''}</p>
      </div>
      <div class="loan-detail-grid">
        <div class="ld-field"><label>Valor Principal</label><span>${formatMoney(loan.valor)}</span></div>
        <div class="ld-field"><label>Valor Líquido</label><span style="color:var(--green);font-weight:700">${formatMoney(liquidoEntregar)}</span></div>
        <div class="ld-field"><label>Prazo</label><span>${loan.prazo} meses</span></div>
        <div class="ld-field"><label>Juros</label><span>${loan.juros != null ? loan.juros + '%' : '—'}</span></div>
        <div class="ld-field"><label>Total c/ Juros</label><span style="color:var(--green)">${loan.totalComJuros ? formatMoney(loan.totalComJuros) : '—'}</span></div>
        <div class="ld-field"><label>Pago</label><span style="color:var(--green)">${formatMoney(pago)}</span></div>
        <div class="ld-field"><label>Saldo Devedor</label><span style="color:var(--orange)">${formatMoney((loan.totalComJuros || 0) - pago)}</span></div>
        <div class="ld-field"><label>Solicitado em</label><span>${formatDateTime(loan.createdAt)}</span></div>
        <div class="ld-field"><label>Aprovado em</label><span>${loan.approvedAt ? formatDateTime(loan.approvedAt) : '—'}</span></div>
        <div class="ld-field"><label>Status</label><span class="status-badge status-${loan.status}">${statusLabel(loan.status)}</span></div>
      </div>
      
      ${avalHtml}
      ${garHtml}
      ${comHtml}
      ${histHtml}

      ${loan.parcelas ? `
        <h4 style="margin-top:15px; margin-bottom:12px">Parcelas</h4>
        <table class="installment-table">
          <thead><tr><th>Parcela</th><th>Valor</th><th>Vencimento</th><th>Status</th><th>Pago em</th><th>Ação</th></tr></thead>
          <tbody>
            ${loan.parcelas.map(p => `
              <tr class="${p.status === 'paid' ? 'paid-row' : ''}">
                <td>${p.n}ª</td>
                <td>${formatMoney(p.valor)}</td>
                <td>${formatDate(p.vcto)}</td>
                <td><span class="status-badge status-${p.status}">${statusLabel(p.status)}</span></td>
                <td>${p.paidAt ? formatDate(p.paidAt) : '—'}</td>
                <td>${p.status !== 'paid' ? `<button class="btn-view" style="font-size:11px;padding:4px 8px" onclick="markParcelaPaid('${loan.id}', ${p.n})">✓ Pago</button>` : '✓'}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : `<p style="color:var(--text-sec);font-size:14px;margin-top:15px;">Nenhuma parcela gerada ainda.</p>`}
    </div>`;

  document.getElementById('modal-loan-detail').classList.remove('hidden');
}

function markParcelaPaid(loanId, parcelaNum) {
  const loans = DB.loans;
  const idx = loans.findIndex(l => l.id === loanId);
  if (idx === -1) return;

  const pIdx = loans[idx].parcelas.findIndex(p => p.n === parcelaNum);
  if (pIdx === -1) return;

  loans[idx].parcelas[pIdx].status = 'paid';
  loans[idx].parcelas[pIdx].paidAt = new Date().toISOString().split('T')[0];

  // Check if all paid
  const allPaid = loans[idx].parcelas.every(p => p.status === 'paid');
  if (allPaid) {
    loans[idx].status = 'paid';
    const client = DB.clients.find(c => c.id === loans[idx].clientId);
    if (client) {
      const msg = `ÁgilBank: 🎉 Parabéns ${client.nome.split(' ')[0]}! Seu empréstimo #${loanId} foi QUITADO com sucesso! Obrigado pela confiança. Conte sempre com a ÁgilBank!`;
      logSMS(client, msg, 'Quitação de Empréstimo');
    }
    toast('🎉 Empréstimo Quitado!', 'Todas as parcelas foram pagas. SMS de quitação enviado!', 'success');
  } else {
    toast('✓ Parcela registrada', `Parcela ${parcelaNum} marcada como paga.`, 'success');
  }

  DB.loans = loans;
  openLoanDetail(loanId); // refresh modal
  loadAdminOverview();
}

function payCommission(loanId) {
  const loans = DB.loans;
  const idx = loans.findIndex(l => l.id === loanId);
  if (idx === -1) return;

  if (loans[idx].comissao) {
    loans[idx].comissao.status = 'paid';

    // Add history log entry
    const historico = loans[idx].historico || [];
    historico.push({
      status: loans[idx].status,
      data: new Date().toISOString(),
      detalhes: `Comissão do consultor ${loans[idx].comissao.agente} no valor de ${formatMoney(loans[idx].comissao.total)} marcada como PAGA.`
    });
    loans[idx].historico = historico;

    DB.loans = loans;
    toast('Comissão Paga', 'O pagamento da comissão foi registrado com sucesso.', 'success');
    openLoanDetail(loanId);
    loadAdminOverview();
  }
}

function markAsPaid() {
  if (!currentLoanId) return;
  const loan = DB.loans.find(l => l.id === currentLoanId);
  if (!loan || !loan.parcelas) return;

  const nextParcela = loan.parcelas.find(p => p.status !== 'paid');
  if (nextParcela) markParcelaPaid(currentLoanId, nextParcela.n);
  else toast('Atenção', 'Não há parcelas pendentes.', 'warning');
}

function loadAllClients() {
  const searchVal = document.getElementById('adm-search-client')?.value.toLowerCase() || '';
  const user = DB.currentUser || {};
  const isSuper = user.creditorId === 'all';
  let clients = isSuper ? DB.clients : DB.clients.filter(c => c.creditorId === user.creditorId || (!c.creditorId && user.creditorId === 'default'));

  if (searchVal) {
    clients = clients.filter(c =>
      c.nome.toLowerCase().includes(searchVal) ||
      c.cpf.includes(searchVal) ||
      c.tel.includes(searchVal)
    );
  }

  const container = document.getElementById('adm-clients-list');
  const loans = DB.loans;

  if (!clients.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><p>Nenhum cliente encontrado.</p></div>`;
    return;
  }

  container.innerHTML = clients.map(c => {
    const clientLoans = loans.filter(l => l.clientId === c.id);
    const activeL = clientLoans.filter(l => l.status === 'active');
    const overdueL = clientLoans.filter(l => l.status === 'overdue');
    const totalDevendo = activeL.concat(overdueL).reduce((acc, l) => {
      if (!l.parcelas) return acc;
      return acc + l.parcelas.filter(p => p.status !== 'paid').reduce((a, p) => a + p.valor, 0);
    }, 0);
    const initials = c.nome.split(' ').map(n => n[0]).slice(0,2).join('').toUpperCase();
    const selfieUrl = clientLoans.find(l => l.selfie)?.selfie;
    const avatarHtml = selfieUrl 
      ? `<img src="${selfieUrl}" class="client-avatar" style="object-fit: cover; border: none; padding: 0;" />`
      : `<div class="client-avatar">${initials}</div>`;

    return `
      <div class="client-card">
        <div class="client-card-header">
          ${avatarHtml}
          <div>
            <div class="client-name">${c.nome}</div>
            <div class="client-cpf">${c.cpf}</div>
          </div>
        </div>
        <div class="client-stats">
          <div class="cs-item"><label>Telefone</label><span>${c.tel}</span></div>
          <div class="cs-item"><label>Cidade</label><span>${c.cidade}/${c.estado}</span></div>
          <div class="cs-item"><label>Empréstimos</label><span>${clientLoans.length}</span></div>
          <div class="cs-item"><label>Devendo</label><span class="${totalDevendo > 0 ? overdueL.length ? 'danger' : 'warning' : ''}">${formatMoney(totalDevendo)}</span></div>
          <div class="cs-item"><label>Emprego</label><span>${c.emprego || '—'}</span></div>
          <div class="cs-item"><label>Renda</label><span>${c.renda || '—'}</span></div>
          <div class="cs-item" style="grid-column: span 2;">
            <label>Responsável</label>
            <span style="cursor:pointer; color:var(--primary); font-weight:bold;" onclick="editResponsavel('${c.id}')">
              ${c.responsavel ? c.responsavel + ' ✏️' : 'Atribuir Responsável ✏️'}
            </span>
          </div>
        </div>
        <div class="client-actions">
          <button class="btn-view" onclick="adminNav('loans');filterByStatus('all');document.getElementById('adm-search-loan').value='${c.nome.split(' ')[0]}';filterLoans()">Ver Empréstimos</button>
          <button class="btn-sms-single" onclick="quickSMSClient('${c.id}')">📱 SMS</button>
        </div>
      </div>`;
  }).join('');
}

window.editResponsavel = function(clientId) {
  const clients = DB.clients;
  const client = clients.find(c => c.id === clientId);
  if (!client) return;
  const atual = client.responsavel || '';
  const novoResp = prompt('Digite o nome do responsável por este cliente (Ex: David vulgo Tubarão):', atual);
  if (novoResp !== null) {
    client.responsavel = novoResp.trim();
    DB.clients = clients;
    loadAllClients();
  }
};

window.openAdminAddClientModal = function() {
  document.getElementById('add-cli-vcto').value = getDefaultDate(30);
  document.getElementById('modal-add-client').classList.remove('hidden');
};

window.adminAddClient = function() {
  const nome = document.getElementById('add-cli-nome').value.trim();
  const tel = document.getElementById('add-cli-tel').value.trim();
  const cpf = document.getElementById('add-cli-cpf').value.trim();
  const responsavel = document.getElementById('add-cli-resp').value.trim();
  const valor = parseFloat(document.getElementById('add-cli-valor').value);
  const taxa = parseFloat(document.getElementById('add-cli-taxa').value);
  const prazo = parseInt(document.getElementById('add-cli-prazo').value);
  const tipo = document.getElementById('add-cli-tipo').value;
  const vcto = document.getElementById('add-cli-vcto').value;

  if (!nome || !tel || !valor || !taxa || !prazo || !vcto) {
    toast('Atenção', 'Preencha os campos essenciais do devedor e empréstimo.', 'warning');
    return;
  }

  const userCred = DB.currentUser || {};
  const clientId = 'c' + Date.now();
  const newClient = {
    id: clientId,
    nome, cpf: cpf || '000.000.000-00', tel, responsavel,
    cidade: 'Não informada', estado: '',
    cadastro: new Date().toISOString(),
    creditorId: userCred.creditorId || 'default'
  };

  const clients = DB.clients;
  clients.push(newClient);
  DB.clients = clients;

  const loanId = 'l' + Date.now();
  const newLoan = {
    id: loanId, clientId, valor, prazo, juros: taxa,
    status: 'pending', createdAt: new Date().toISOString(),
    creditorId: userCred.creditorId || 'default'
  };

  const loans = DB.loans;
  loans.push(newLoan);
  DB.loans = loans;

  // Usa a função de aprovação com taxa que já calcula as parcelas
  approveWithRate(loanId, taxa, tipo, vcto);

  toast('Devedor Adicionado!', 'Cliente e empréstimo registrados com sucesso.', 'success');
  closeModal('modal-add-client');
  loadAllClients();
};

// ══════════════════════════════════════
// SMS PANEL
// ══════════════════════════════════════
function loadSMSPanel() {
  const loans = DB.loans;
  const clients = DB.clients;

  // populate client select
  const sel = document.getElementById('sms-client-select');
  if (sel) {
    sel.innerHTML = clients.map(c => `<option value="${c.id}">${c.nome} — ${c.tel}</option>`).join('');
  }

  loadSMSTemplate();
  loadSMSHistory();
}

const SMS_TEMPLATES = {
  vencimento: (name, valor, data) => `ÁgilBank: Olá ${name}! Lembrete: parcela de ${formatMoney(valor)} vence em ${data}. Evite atrasos e juros extras. Pague em dia! Dúvidas: (11) 9999-0000`,
  atraso: (name, valor, dias) => `ÁgilBank: ⚠️ ${name}, sua parcela de ${formatMoney(valor)} está ${dias} dia(s) em atraso! Regularize agora para evitar juros. Contato: (11) 9999-0000`,
  aprovacao: (name, valor, prazo, total, parcela) => `ÁgilBank: ✅ Parabéns ${name}! Empréstimo de ${formatMoney(valor)} aprovado! Total a pagar: ${formatMoney(total)} em ${prazo}x de ${formatMoney(parcela)}. Acesse o app para mais detalhes.`,
  recusa: (name, valor) => `ÁgilBank: Olá ${name}, infelizmente seu empréstimo de ${formatMoney(valor)} não pôde ser aprovado no momento. Entre em contato para saber mais.`,
  quitacao: (name) => `ÁgilBank: 🎉 Parabéns ${name}! Seu empréstimo foi QUITADO! Obrigado pela confiança. Precisando novamente, estamos aqui!`,
  custom: () => '',
};

function loadSMSTemplate() {
  const template = document.getElementById('sms-template')?.value || 'vencimento';
  const msgEl = document.getElementById('sms-msg');
  if (!msgEl) return;

  let msg = '';
  if (template === 'vencimento') msg = SMS_TEMPLATES.vencimento('Cliente', 500, '30/06/2025');
  else if (template === 'atraso') msg = SMS_TEMPLATES.atraso('Cliente', 500, 5);
  else if (template === 'aprovacao') msg = SMS_TEMPLATES.aprovacao('Cliente', 1000, 3, 1250, 416.67);
  else if (template === 'recusa') msg = SMS_TEMPLATES.recusa('Cliente', 1000);
  else if (template === 'quitacao') msg = SMS_TEMPLATES.quitacao('Cliente');
  else msg = '';

  msgEl.value = msg;
  document.getElementById('sms-preview-text').textContent = msg || 'Prévia da mensagem';
  countSMSChars();
}

function countSMSChars() {
  const msg = document.getElementById('sms-msg')?.value || '';
  const charsEl = document.getElementById('sms-chars');
  if (charsEl) {
    charsEl.textContent = `${msg.length}/160 caracteres`;
    charsEl.style.color = msg.length > 160 ? 'var(--red)' : 'var(--text-muted)';
  }
  const preview = document.getElementById('sms-preview-text');
  if (preview) preview.textContent = msg || 'Prévia da mensagem';

  updateSMSPreview();
}

function updateSMSPreview() {
  const dest = document.getElementById('sms-dest')?.value;
  const clientGroup = document.getElementById('sms-client-select-group');
  if (clientGroup) clientGroup.style.display = dest === 'specific' ? 'block' : 'none';
}

function sendSMS() {
  const dest = document.getElementById('sms-dest').value;
  const msg  = document.getElementById('sms-msg').value.trim();
  if (!msg) { toast('Atenção', 'Digite uma mensagem antes de enviar.', 'warning'); return; }

  const loans = DB.loans.filter(l => l.status !== 'rejected' && l.status !== 'pending');
  const clients = DB.clients;
  let recipients = [];

  if (dest === 'all') {
    const debtorIds = [...new Set(loans.map(l => l.clientId))];
    recipients = clients.filter(c => debtorIds.includes(c.id));
  } else if (dest === 'overdue') {
    const overIds = [...new Set(DB.loans.filter(l => l.status === 'overdue').map(l => l.clientId))];
    recipients = clients.filter(c => overIds.includes(c.id));
  } else if (dest === 'due-soon') {
    const today = new Date();
    const dias = DB.settings.smsDias || 5;
    const inDays = new Date(); inDays.setDate(today.getDate() + dias);
    const soonIds = [];
    DB.loans.forEach(l => {
      if (!l.parcelas) return;
      l.parcelas.forEach(p => {
        const d = new Date(p.vcto);
        if (p.status === 'pending' && d >= today && d <= inDays) soonIds.push(l.clientId);
      });
    });
    recipients = clients.filter(c => soonIds.includes(c.id));
  } else if (dest === 'specific') {
    const clientId = document.getElementById('sms-client-select').value;
    const c = clients.find(cl => cl.id === clientId);
    if (c) recipients = [c];
  }

  if (!recipients.length) { toast('Atenção', 'Nenhum destinatário encontrado.', 'warning'); return; }

  recipients.forEach(c => logSMS(c, msg, 'Envio Manual'));

  if (recipients.length === 1) {
    const phone = recipients[0].tel.replace(/\D/g, '');
    window.open(`https://wa.me/55${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  }

  toast('📱 Mensagens Geradas!', `${recipients.length} mensagem(ns) pronta(s). Acesse o histórico para enviar via WhatsApp!`, 'sms');
  loadSMSHistory();
}

function quickSMS(clientId, loanId, type) {
  const client = DB.clients.find(c => c.id === clientId);
  const loan = DB.loans.find(l => l.id === loanId);
  if (!client || !loan) return;

  let msg = '';
  if (type === 'atraso') {
    const overdueP = loan.parcelas?.find(p => p.status === 'overdue');
    const days = overdueP ? Math.floor((new Date() - new Date(overdueP.vcto)) / 86400000) : 1;
    msg = SMS_TEMPLATES.atraso(client.nome.split(' ')[0], overdueP?.valor || loan.valor, days);
  } else {
    const nextP = loan.parcelas?.find(p => p.status === 'pending');
    msg = SMS_TEMPLATES.vencimento(client.nome.split(' ')[0], nextP?.valor || loan.valor, nextP ? formatDate(nextP.vcto) : '—');
  }

  logSMS(client, msg, type === 'atraso' ? 'Aviso de Atraso' : 'Aviso de Vencimento');
  
  const phone = client.tel.replace(/\D/g, '');
  window.open(`https://wa.me/55${phone}?text=${encodeURIComponent(msg)}`, '_blank');
  
  toast('📱 Mensagem Gerada!', `WhatsApp aberto para ${client.nome}`, 'sms');
  loadSMSHistory();
}

function quickSMSClient(clientId) {
  adminNav('sms');
  setTimeout(() => {
    document.getElementById('sms-dest').value = 'specific';
    updateSMSPreview();
    document.getElementById('sms-client-select').value = clientId;
  }, 100);
}

function sendBulkSMS() {
  const today = new Date();
  const dias = DB.settings.smsDias || 5;
  const inDays = new Date(); inDays.setDate(today.getDate() + dias);

  DB.loans.forEach(l => {
    if (!l.parcelas || l.status === 'paid' || l.status === 'rejected') return;
    l.parcelas.forEach(p => {
      if (p.status !== 'pending' && p.status !== 'overdue') return;
      const vcto = new Date(p.vcto);
      
      if (p.status === 'pending' && vcto > inDays) return;

      const client = DB.clients.find(c => c.id === l.clientId);
      if (!client) return;

      const days = Math.floor((new Date() - vcto) / 86400000);
      const msg = days > 0
        ? SMS_TEMPLATES.atraso(client.nome.split(' ')[0], p.valor, days)
        : SMS_TEMPLATES.vencimento(client.nome.split(' ')[0], p.valor, formatDate(p.vcto));

      logSMS(client, msg, days > 0 ? 'Aviso de Atraso' : 'Aviso de Vencimento');
    });
  });

  toast('📱 Mensagens em Massa Geradas!', `Vá ao Histórico de SMS e clique em "Enviar no WhatsApp" para entregar cada uma.`, 'sms');
  loadSMSHistory();
}

function logSMS(client, msg, tipo) {
  const history = DB.smsHistory;
  history.unshift({
    id: 'sms' + Date.now() + Math.random(),
    clientId: client.id,
    clientNome: client.nome,
    clientTel: client.tel,
    msg,
    tipo,
    sentAt: new Date().toISOString(),
  });
  DB.smsHistory = history.slice(0, 100); // keep last 100
}

function loadSMSHistory() {
  const history = DB.smsHistory;
  const container = document.getElementById('sms-history-list');
  if (!container) return;

  if (!history.length) {
    container.innerHTML = `<div class="empty-state" style="padding:24px"><p>Nenhum SMS enviado ainda.</p></div>`;
    return;
  }

  container.innerHTML = history.map(s => {
    const phone = s.clientTel.replace(/\D/g, '');
    const waLink = `https://wa.me/55${phone}?text=${encodeURIComponent(s.msg)}`;
    return `
    <div class="sms-history-item">
      <div class="sms-hist-header">
        <span class="sms-hist-to">📱 ${s.clientNome} (${s.clientTel})</span>
        <span class="sms-hist-time">${formatDateTime(s.sentAt)}</span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${s.tipo}</div>
      <div class="sms-hist-msg">${s.msg}</div>
      <a href="${waLink}" target="_blank" class="btn-primary" style="display:inline-block; margin-top:8px; padding: 6px 12px; font-size: 12px; text-decoration: none; text-align: center;">
        📲 Enviar no WhatsApp
      </a>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════
function loadSettings() {
  const s = DB.settings;
  const taxas = s.taxas || DEFAULT_SETTINGS.taxas;

  const fields = { 'taxa-1': taxas[1], 'taxa-2': taxas[2], 'taxa-3': taxas[3], 'taxa-6': taxas[6], 'taxa-12': taxas[12], 'taxa-atraso': s.taxaAtraso, 'limite-min': s.limiteMin, 'limite-max': s.limiteMax, 'limite-cliente': s.limiteCliente, 'sms-dias': s.smsDias, 'sms-atraso-freq': s.smsAtrasadoFreq };

  Object.entries(fields).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });

  const smsDia = document.getElementById('sms-dia-vcto');
  if (smsDia) smsDia.checked = s.smsDiaVcto;
}

function saveTaxas() {
  const s = DB.settings;
  s.taxas = {
    1:  parseFloat(document.getElementById('taxa-1').value) || 15,
    2:  parseFloat(document.getElementById('taxa-2').value) || 20,
    3:  parseFloat(document.getElementById('taxa-3').value) || 25,
    6:  parseFloat(document.getElementById('taxa-6').value) || 35,
    12: parseFloat(document.getElementById('taxa-12').value) || 50,
  };
  s.taxaAtraso = parseFloat(document.getElementById('taxa-atraso').value) || 1;
  DB.settings = s;
  toast('✅ Salvo', 'Taxas de juros atualizadas!', 'success');
}

function saveLimites() {
  const s = DB.settings;
  s.limiteMin    = parseFloat(document.getElementById('limite-min').value) || 200;
  s.limiteMax    = parseFloat(document.getElementById('limite-max').value) || 5000;
  s.limiteCliente= parseFloat(document.getElementById('limite-cliente').value) || 10000;
  DB.settings = s;
  toast('✅ Salvo', 'Limites de crédito atualizados!', 'success');
}

function saveSMSConfig() {
  const s = DB.settings;
  s.smsDias       = parseInt(document.getElementById('sms-dias').value) || 3;
  s.smsDiaVcto    = document.getElementById('sms-dia-vcto').checked;
  s.smsAtrasadoFreq= parseInt(document.getElementById('sms-atraso-freq').value) || 7;
  DB.settings = s;
  toast('✅ Salvo', 'Configurações de SMS atualizadas!', 'success');
}

function changeAdminPass() {
  const p1 = document.getElementById('adm-new-pass').value;
  const p2 = document.getElementById('adm-new-pass2').value;
  if (p1.length < 6) { toast('Atenção', 'Senha deve ter pelo menos 6 caracteres.', 'warning'); return; }
  if (p1 !== p2) { toast('Atenção', 'Senhas não coincidem.', 'warning'); return; }
  const s = DB.settings;
  s.adminPass = p1;
  DB.settings = s;
  document.getElementById('adm-new-pass').value = '';
  document.getElementById('adm-new-pass2').value = '';
  toast('✅ Senha alterada', 'Senha do administrador atualizada com sucesso!', 'success');
}

// ══════════════════════════════════════
// STEP NAVIGATION (Registration)
// ══════════════════════════════════════
let currentStep = 1;

function nextStep(step) {
  if (step > currentStep) {
    // Validate current step
    if (currentStep === 1) {
      if (!document.getElementById('reg-nome').value.trim() || !document.getElementById('reg-cpf').value.trim()) {
        toast('Atenção', 'Preencha Nome e CPF para continuar.', 'warning'); return;
      }
    }
    if (currentStep === 2) {
      if (!document.getElementById('reg-tel').value.trim() || !document.getElementById('reg-email').value.trim() || !document.getElementById('reg-cidade').value.trim()) {
        toast('Atenção', 'Preencha Telefone, E-mail e Cidade para continuar.', 'warning'); return;
      }
    }
  }

  document.getElementById(`reg-step-${currentStep}`).classList.add('hidden');
  document.getElementById(`step-dot-${currentStep}`).classList.remove('active');
  if (step > currentStep) document.getElementById(`step-dot-${currentStep}`).classList.add('done');

  currentStep = step;
  document.getElementById(`reg-step-${currentStep}`).classList.remove('hidden');
  document.getElementById(`step-dot-${currentStep}`).classList.add('active');
}

// ══════════════════════════════════════
// MODAL
// ══════════════════════════════════════
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  currentLoanId = null;
}

// ══════════════════════════════════════
// EXPORT
// ══════════════════════════════════════
function exportReport() {
  const loans = DB.loans;
  const clients = DB.clients;

  let csv = 'Nome,CPF,Telefone,Valor,Juros%,Total,Status,Solicitado,Aprovado\n';
  loans.forEach(l => {
    const c = clients.find(cl => cl.id === l.clientId) || {};
    csv += `"${c.nome||''}","${c.cpf||''}","${c.tel||''}","${l.valor}","${l.juros||''}","${l.totalComJuros||''}","${l.status}","${formatDate(l.createdAt)}","${l.approvedAt ? formatDate(l.approvedAt) : ''}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `agilbank_relatorio_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('📥 Exportado!', 'Relatório CSV gerado e baixado!', 'success');
}

// ══════════════════════════════════════
// TOAST
// ══════════════════════════════════════
function toast(title, message, type = 'info') {
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️', sms: '📱' };
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="toast-icon">${icons[type] || 'ℹ️'}</div><div class="toast-text"><strong>${title}</strong>${message}</div>`;
  container.appendChild(el);

  setTimeout(() => {
    el.style.animation = 'slideOutRight 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════
function calcTotal(valor, taxa) {
  return parseFloat((valor * (1 + taxa / 100)).toFixed(2));
}

function formatMoney(val) {
  if (!val && val !== 0) return '—';
  return val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str + (str.length === 10 ? 'T12:00:00' : ''));
  return d.toLocaleDateString('pt-BR');
}

function formatDateTime(str) {
  if (!str) return '—';
  const d = new Date(str);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function statusLabel(status) {
  const map = { pending: 'Pendente', active: 'Ativo', overdue: 'Atrasado', paid: 'Quitado', rejected: 'Recusado' };
  return map[status] || status;
}

// ── Masks ──
function maskCPF(el) {
  let v = el.value.replace(/\D/g, '').slice(0, 11);
  v = v.replace(/(\d{3})(\d)/, '$1.$2');
  v = v.replace(/(\d{3})(\d)/, '$1.$2');
  v = v.replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  el.value = v;
}

function maskPhone(el) {
  let v = el.value.replace(/\D/g, '').slice(0, 11);
  v = v.replace(/^(\d{2})(\d)/, '($1) $2');
  v = v.replace(/(\d{5})(\d)/, '$1-$2');
  el.value = v;
}

function maskCEP(el) {
  let v = el.value.replace(/\D/g, '').slice(0, 8);
  v = v.replace(/(\d{5})(\d)/, '$1-$2');
  el.value = v;
}

function maskMoney(el) {
  let v = el.value.replace(/\D/g, '');
  v = (parseInt(v) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  el.value = v;
}

async function buscaCEP() {
  const cep = document.getElementById('reg-cep')?.value.replace(/\D/g, '');
  if (cep.length !== 8) return;
  try {
    const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const data = await res.json();
    if (!data.erro) {
      document.getElementById('reg-cidade').value = data.localidade || '';
      document.getElementById('reg-estado').value = data.uf || '';
      document.getElementById('reg-endereco').value = data.logradouro ? `${data.logradouro}, ` : '';
    }
  } catch (e) {}
}

// ── Particles ──
function createParticles() {
  const container = document.getElementById('particles');
  if (!container) return;
  for (let i = 0; i < 20; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (6 + Math.random() * 10) + 's';
    p.style.animationDelay = (Math.random() * 10) + 's';
    p.style.width = p.style.height = (2 + Math.random() * 4) + 'px';
    container.appendChild(p);
  }
}

// ── Close modals on overlay click ──
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
    currentLoanId = null;
  }
});


// ══════════════════════════════════════
// SAAS REDE DE CREDORES (Super Admin)
// ══════════════════════════════════════
function loadRedePanel() {
  const s = DB.settings;
  const creditors = s.creditors || DEFAULT_SETTINGS.creditors || [];
  const container = document.getElementById('rede-creditors-list');
  if (!container) return;

  container.innerHTML = creditors.map(c => {
    const roleLabel = c.role === 'padrinho' 
      ? '<span style="color:var(--green);font-weight:700">Padrinho (Sponsor)</span>' 
      : '<span style="color:var(--text-sec)">Afiliado (Affiliate)</span>';

    const linkedPadrinho = c.padrinhoId 
      ? (creditors.find(p => p.id === c.padrinhoId)?.nome || 'Padrinho Inexistente')
      : 'Nenhum';

    const roleActions = c.role === 'padrinho'
      ? `<button class="btn-view" style="font-size:11px;padding:4px 8px;background:#ef4444;color:white;" onclick="changeCreditorRole('${c.id}', 'afiliado')">Despromover a Afiliado</button>`
      : `<button class="btn-view" style="font-size:11px;padding:4px 8px;background:#22c55e;color:white;" onclick="changeCreditorRole('${c.id}', 'padrinho')">Promover a Padrinho</button>`;

    const linkAction = c.role === 'afiliado'
      ? `
        <div style="display:flex; gap:4px; align-items:center;">
          <select id="link-select-${c.id}" style="font-size:11px; padding:2px; background:var(--navy); border:1px solid var(--border); color:var(--text-pri);">
            <option value="">Desvincular</option>
            ${creditors.filter(p => p.role === 'padrinho' && p.id !== c.id).map(p => `<option value="${p.id}" ${c.padrinhoId === p.id ? 'selected' : ''}>${p.nome}</option>`).join('')}
          </select>
          <button class="btn-view" style="font-size:11px;padding:4px 6px" onclick="linkCreditorToPadrinho('${c.id}')">Vincular</button>
        </div>`
      : '—';

    return `
      <tr>
        <td style="font-weight:600">${c.nome}</td>
        <td>${c.email}</td>
        <td>${roleLabel}</td>
        <td>${linkedPadrinho}</td>
        <td style="display:flex; gap:12px; align-items:center;">
          ${roleActions}
          ${linkAction}
        </td>
      </tr>`;
  }).join('');
}

function changeCreditorRole(creditorId, newRole) {
  const s = DB.settings;
  const creditors = s.creditors || [];
  const idx = creditors.findIndex(c => c.id === creditorId);
  if (idx === -1) return;

  creditors[idx].role = newRole;
  if (newRole === 'padrinho') {
    delete creditors[idx].padrinhoId;
  }
  
  s.creditors = creditors;
  DB.settings = s;
  toast('Sucesso', 'Cargo do credor atualizado!', 'success');
  loadRedePanel();
}

function linkCreditorToPadrinho(creditorId) {
  const s = DB.settings;
  const creditors = s.creditors || [];
  const idx = creditors.findIndex(c => c.id === creditorId);
  if (idx === -1) return;

  const selectEl = document.getElementById(`link-select-${creditorId}`);
  if (!selectEl) return;

  creditors[idx].padrinhoId = selectEl.value || null;
  s.creditors = creditors;
  DB.settings = s;

  toast('Sucesso', 'Vínculo de Padrinho atualizado!', 'success');
  loadRedePanel();
}


// ══════════════════════════════════════
// CHAT MESSENGER (Padrinho & Afiliado)
// ══════════════════════════════════════
let activeChatContactId = null;

function loadChatPanel() {
  const user = DB.currentUser || {};
  const settings = DB.settings;
  const creditors = settings.creditors || DEFAULT_SETTINGS.creditors || [];
  const currentCreditor = creditors.find(c => c.id === user.creditorId) || {};
  
  const contactsList = document.getElementById('chat-contacts-list');
  if (!contactsList) return;

  let contacts = [];
  if (currentCreditor.role === 'padrinho') {
    contacts = creditors.filter(c => c.padrinhoId === user.creditorId);
  } else if (currentCreditor.role === 'afiliado') {
    const myPadrinho = creditors.find(c => c.id === currentCreditor.padrinhoId);
    if (myPadrinho) contacts.push(myPadrinho);
  }

  if (contacts.length === 0) {
    contactsList.innerHTML = `<div style="padding:15px; font-size:12px; color:var(--text-muted);">Nenhum contato disponível na sua rede.</div>`;
    document.getElementById('chat-header-title').textContent = 'Sem conversas disponíveis';
    document.getElementById('chat-messages-container').innerHTML = '';
    return;
  }

  contactsList.innerHTML = contacts.map(c => {
    const isActive = activeChatContactId === c.id;
    const bg = isActive ? 'background: rgba(255,255,255,0.08); border-left: 3px solid var(--green);' : '';
    return `
      <div class="chat-contact-item" 
           onclick="selectChatContact('${c.id}')"
           style="padding: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: background 0.2s; ${bg}">
        <div style="font-weight: 600; font-size: 13px; color: var(--text-pri);">${c.nome}</div>
        <div style="font-size: 11px; color: var(--text-sec);">${c.role === 'padrinho' ? 'Padrinho' : 'Afiliado'}</div>
      </div>`;
  }).join('');

  if (activeChatContactId) {
    selectChatContact(activeChatContactId);
  }
}

function selectChatContact(contactId) {
  activeChatContactId = contactId;
  
  // Highlight active contact
  document.querySelectorAll('.chat-contact-item').forEach(el => el.classList.remove('active'));
  
  const settings = DB.settings;
  const creditors = settings.creditors || DEFAULT_SETTINGS.creditors || [];
  const contact = creditors.find(c => c.id === contactId) || {};
  
  document.getElementById('chat-header-title').textContent = `Conversando com: ${contact.nome} (${contact.role === 'padrinho' ? 'Padrinho' : 'Afiliado'})`;

  // Render messages
  const user = DB.currentUser || {};
  const allMessages = settings.chatMessages || [];
  
  const chatMessages = allMessages.filter(m => 
    (m.fromId === user.creditorId && m.toId === contactId) ||
    (m.fromId === contactId && m.toId === user.creditorId)
  );

  const container = document.getElementById('chat-messages-container');
  if (container) {
    if (chatMessages.length === 0) {
      container.innerHTML = `<div style="text-align:center; color:var(--text-muted); font-size:12px; margin-top:20px;">Nenhuma mensagem registrada. Envie um "Olá"!</div>`;
    } else {
      container.innerHTML = chatMessages.map(m => {
        const isMe = m.fromId === user.creditorId;
        const align = isMe ? 'align-self: flex-end; background: var(--green); color: white;' : 'align-self: flex-start; background: var(--border); color: var(--text-pri);';
        return `
          <div style="max-width: 70%; padding: 8px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 4px; ${align}">
            <div>${m.text}</div>
            <div style="font-size: 9px; text-align: right; margin-top: 4px; opacity: 0.7;">${new Date(m.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
          </div>`;
      }).join('');
      container.scrollTop = container.scrollHeight;
    }
  }
}

function sendChatMessage() {
  const user = DB.currentUser || {};
  if (!activeChatContactId) {
    toast('Atenção', 'Selecione um contato primeiro.', 'warning');
    return;
  }

  const input = document.getElementById('chat-input-text');
  const text = input.value.trim();
  if (!text) return;

  const s = DB.settings;
  const messages = s.chatMessages || [];

  const newMsg = {
    fromId: user.creditorId,
    toId: activeChatContactId,
    text: text,
    timestamp: new Date().toISOString()
  };

  messages.push(newMsg);
  s.chatMessages = messages;
  DB.settings = s;

  input.value = '';
  selectChatContact(activeChatContactId);
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
  } else {
    input.type = 'password';
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
  }
}

