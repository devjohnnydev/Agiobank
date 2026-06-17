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
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? '' // usa mesma origem (servidor node local ou fallback)
  : ''; // em produção, mesma origem

let _syncTimeout = null;
let _dbReady = false;

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
  get settings()      { return _mem.settings || JSON.parse(localStorage.getItem('ab_settings') || JSON.stringify(DEFAULT_SETTINGS)); },
  set settings(v)     { _mem.settings = v; _scheduleSync(); _lsSet('ab_settings', v); },
  get currentUser()   { return JSON.parse(sessionStorage.getItem('ab_user') || 'null'); },
  set currentUser(v)  { sessionStorage.setItem('ab_user', JSON.stringify(v)); },
};

function _lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
}

function _scheduleSync() {
  if (_syncTimeout) clearTimeout(_syncTimeout);
  _syncTimeout = setTimeout(_pushState, 1500); // debounce 1.5s
}

async function _pushState() {
  try {
    await fetch(API_BASE + '/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clients: _mem.clients,
        loans: _mem.loans,
        smsHistory: _mem.smsHistory,
        settings: _mem.settings || DEFAULT_SETTINGS,
      }),
    });
  } catch (e) {
    // silently fail — dados continuam no localStorage
  }
}

async function _loadState() {
  // Carrega do localStorage enquanto aguarda o servidor
  _mem.clients    = JSON.parse(localStorage.getItem('ab_clients')  || '[]');
  _mem.loans      = JSON.parse(localStorage.getItem('ab_loans')    || '[]');
  _mem.smsHistory = JSON.parse(localStorage.getItem('ab_sms')      || '[]');
  _mem.settings   = JSON.parse(localStorage.getItem('ab_settings') || JSON.stringify(DEFAULT_SETTINGS));

  try {
    const res = await fetch(API_BASE + '/api/state');
    if (res.ok) {
      const data = await res.json();
      // Só atualiza se o servidor tiver mais dados
      if (data.clients && data.clients.length >= _mem.clients.length) {
        _mem.clients    = data.clients;
        _lsSet('ab_clients', data.clients);
      }
      if (data.loans && data.loans.length >= _mem.loans.length) {
        _mem.loans      = data.loans;
        _lsSet('ab_loans', data.loans);
      }
      if (data.smsHistory && data.smsHistory.length >= _mem.smsHistory.length) {
        _mem.smsHistory = data.smsHistory;
        _lsSet('ab_sms', data.smsHistory);
      }
      if (data.settings && Object.keys(data.settings).length > 0) {
        _mem.settings   = data.settings;
        _lsSet('ab_settings', data.settings);
      }
      console.log('✅ Estado carregado do PostgreSQL!');
    }
  } catch (e) {
    console.warn('⚠️ Servidor offline — usando dados locais');
  }
  _dbReady = true;
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
  DB.settings = DEFAULT_SETTINGS;
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

  if (loginScreen) loginScreen.style.opacity = '1';

  const user = DB.currentUser;
  if (user) {
    if (user.role === 'admin') enterAdmin();
    else enterClient(user);
  }

  // Set today's date
  const el = document.getElementById('adm-date');
  if (el) el.textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
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
  const user = document.getElementById('cl-login-user').value.trim();
  const pass = document.getElementById('cl-login-pass').value;

  const client = DB.clients.find(c =>
    (c.cpf === user || c.email === user) && c.senha === pass
  );

  if (!client) { toast('Erro', 'CPF/e-mail ou senha inválidos.', 'error'); return; }

  DB.currentUser = { ...client, role: 'client' };
  enterClient(client);
  toast('Bem-vindo!', `Olá, ${client.nome.split(' ')[0]}! 👋`, 'success');
}

function loginAdmin() {
  const user = document.getElementById('adm-login-user').value.trim();
  const pass = document.getElementById('adm-login-pass').value;
  const s = DB.settings;

  if (
    (user === 'agiotabraga@gmail.com' && pass === 'Ab@46431194') ||
    (user === 'admin' && pass === s.adminPass)
  ) {
    DB.currentUser = { role: 'admin', nome: 'Administrador' };
    enterAdmin();
    toast('Acesso concedido', 'Bem-vindo ao painel administrativo! 🔐', 'success');
  } else {
    toast('Acesso negado', 'Credenciais de administrador inválidas.', 'error');
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

  const newClient = {
    id: 'c' + Date.now(),
    nome, cpf, email, tel, cidade, estado,
    endereco: end, nasc, emprego, trabalho, renda, garantia, indicacao, senha,
    cadastro: new Date().toISOString(),
    rg: document.getElementById('reg-rg').value,
    estadoCivil: document.getElementById('reg-estado-civil').value,
    cep: document.getElementById('reg-cep').value,
  };

  const clients = DB.clients;
  clients.push(newClient);
  DB.clients = clients;

  DB.currentUser = { ...newClient, role: 'client' };
  enterClient(newClient);
  toast('Cadastro realizado!', `Bem-vindo ao ÁgilBank, ${nome.split(' ')[0]}! 🎉`, 'success');
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
  document.getElementById('btn-start-camera').style.display = 'none';
  document.getElementById('camera-container').style.display = 'block';
  
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => { capturedLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
      (err) => { console.warn("GPS error:", err); }
    );
  }

  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
    const videoEl = document.getElementById('camera-feed');
    videoEl.srcObject = videoStream;
    document.getElementById('btn-take-photo').style.display = 'block';
  } catch (err) {
    toast('Erro de Câmera', 'Não foi possível acessar a câmera. Tente novamente.', 'error');
    document.getElementById('btn-start-camera').style.display = 'block';
    document.getElementById('camera-container').style.display = 'none';
  }
}

function takePhoto() {
  const videoEl = document.getElementById('camera-feed');
  const canvas = document.getElementById('camera-canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  
  capturedSelfie = canvas.toDataURL('image/jpeg');
  
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
  }
  
  document.getElementById('camera-container').style.display = 'none';
  document.getElementById('btn-take-photo').style.display = 'none';
  
  const preview = document.getElementById('selfie-preview');
  preview.src = capturedSelfie;
  document.getElementById('security-result').style.display = 'block';
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
    toast('Segurança', 'Por favor, libere a câmera e tire a foto de segurança para enviar o pedido.', 'warning'); return;
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
    location: capturedLocation
  };

  const loans = DB.loans;
  loans.push(newLoan);
  DB.loans = loans;

  document.getElementById('lr-valor').value = '';
  document.getElementById('lr-motivo').value = '';
  document.getElementById('lr-desc').value = '';
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
  }
}

function updateAdminBadges() {
  const pending = DB.loans.filter(l => l.status === 'pending').length;
  const badge = document.getElementById('badge-requests');
  if (badge) { badge.textContent = pending; badge.style.display = pending ? 'inline-block' : 'none'; }
}

function loadAdminOverview() {
  const loans = DB.loans;
  const clients = DB.clients;
  const settings = DB.settings;

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

  document.getElementById('adm-total-emprestado').textContent = formatMoney(totalEmprestado);
  document.getElementById('adm-a-receber').textContent        = formatMoney(totalAReceber);
  document.getElementById('adm-total-clientes').textContent   = clients.length;
  document.getElementById('adm-atrasados').textContent        = overdueLoans.length;
  document.getElementById('adm-emprestimos-ativos').textContent = activeLoans.length;
  
  const elJurosRec = document.getElementById('adm-juros-recebidos');
  if (elJurosRec) elJurosRec.textContent = formatMoney(jurosRecebidos);
  
  const elJurosPen = document.getElementById('adm-juros-a-receber');
  if (elJurosPen) elJurosPen.textContent = formatMoney(jurosAReceber);

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
}

function loadPendingRequests() {
  const pending = DB.loans.filter(l => l.status === 'pending');
  const clients = DB.clients;
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

  document.getElementById('modal-approve-content').innerHTML = `
    <div class="approve-grid">
      <div class="approve-field"><label>Cliente</label><span>${client.nome}</span></div>
      <div class="approve-field"><label>Telefone (SMS)</label><span>${client.tel}</span></div>
      <div class="approve-field"><label>Valor</label><span style="color:var(--green)">${formatMoney(loan.valor)}</span></div>
      <div class="approve-field"><label>Prazo</label><span>${loan.prazo} ${loan.prazo===1?'mês':'meses'}</span></div>
      <div class="approve-field"><label>Motivo</label><span>${loan.motivo || '—'}</span></div>
      <div class="approve-field"><label>Emprego/Trabalho</label><span>${client.emprego || '—'} ${client.trabalho ? '('+client.trabalho+')' : ''}</span></div>
      <div class="approve-interest">
        <label>⚙️ Configuração do Pagamento:</label>
        <div class="input-group" style="margin-bottom:12px">
          <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Modalidade:</label>
          <select id="modal-tipo" onchange="updateModalCalc(${loan.valor}, ${loan.prazo})">
            <option value="convencional">Parcelas Fixas (Principal + Juros)</option>
            <option value="juros_mensais">Só Juros Mensais (Principal no Final)</option>
          </select>
        </div>
        <div class="input-group" style="margin-bottom:12px">
          <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">1º Vencimento:</label>
          <input type="date" id="modal-vcto" value="${getDefaultDate(30)}" />
        </div>
        <div class="interest-row">
          <input type="number" id="modal-taxa" value="${defaultRate}" min="0" max="200" step="0.5"
            oninput="updateModalCalc(${loan.valor}, ${loan.prazo})" />
          <span style="font-size:12px;color:var(--text-muted);margin-right:8px" id="modal-taxa-label">% ao período</span>
          <span class="calc-result" id="modal-calc">
            Total: <strong>${formatMoney(total)}</strong> · ${loan.prazo}x de <strong>${formatMoney(parcela)}</strong>
          </span>
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
}

function approveLoan() {
  if (!currentLoanId) return;
  const taxa = parseFloat(document.getElementById('modal-taxa').value) || 0;
  const tipo = document.getElementById('modal-tipo').value;
  const vcto = document.getElementById('modal-vcto').value;
  approveWithRate(currentLoanId, taxa, tipo, vcto);
  closeModal('modal-approve');
}

function approveWithRate(loanId, taxa, tipo = 'convencional', primeiroVcto = null) {
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

  loans[idx] = {
    ...l,
    status: 'active',
    juros: taxa,
    tipoModalidade: tipo,
    totalComJuros: total,
    parcelas,
    approvedAt: new Date().toISOString(),
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
  let loans = DB.loans;

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

  document.getElementById('modal-loan-detail-content').innerHTML = `
    <div class="loan-detail-content">
      <div class="loan-detail-header">
        <h4>${client.nome || '—'} — Empréstimo #${loan.id}</h4>
        <p>${client.cpf || ''} · ${client.tel || ''} · ${client.email || ''}</p>
      </div>
      <div class="loan-detail-grid">
        <div class="ld-field"><label>Valor</label><span>${formatMoney(loan.valor)}</span></div>
        <div class="ld-field"><label>Prazo</label><span>${loan.prazo} meses</span></div>
        <div class="ld-field"><label>Juros</label><span>${loan.juros != null ? loan.juros + '%' : '—'}</span></div>
        <div class="ld-field"><label>Total c/ Juros</label><span style="color:var(--green)">${loan.totalComJuros ? formatMoney(loan.totalComJuros) : '—'}</span></div>
        <div class="ld-field"><label>Pago</label><span style="color:var(--green)">${formatMoney(pago)}</span></div>
        <div class="ld-field"><label>Saldo Devedor</label><span style="color:var(--orange)">${formatMoney((loan.totalComJuros || 0) - pago)}</span></div>
        <div class="ld-field"><label>Solicitado em</label><span>${formatDateTime(loan.createdAt)}</span></div>
        <div class="ld-field"><label>Aprovado em</label><span>${loan.approvedAt ? formatDateTime(loan.approvedAt) : '—'}</span></div>
        <div class="ld-field"><label>Status</label><span class="status-badge status-${loan.status}">${statusLabel(loan.status)}</span></div>
      </div>
      ${loan.parcelas ? `
        <h4 style="margin-bottom:12px">Parcelas</h4>
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
        </table>` : `<p style="color:var(--text-sec);font-size:14px">Nenhuma parcela gerada ainda.</p>`}
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
  let clients = DB.clients;

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

  const clientId = 'c' + Date.now();
  const newClient = {
    id: clientId,
    nome, cpf: cpf || '000.000.000-00', tel, responsavel,
    cidade: 'Não informada', estado: '',
    cadastro: new Date().toISOString()
  };

  const clients = DB.clients;
  clients.push(newClient);
  DB.clients = clients;

  const loanId = 'l' + Date.now();
  const newLoan = {
    id: loanId, clientId, valor, prazo, juros: taxa,
    status: 'pending', createdAt: new Date().toISOString()
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
