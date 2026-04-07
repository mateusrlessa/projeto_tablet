import './styles.css';

let app = document.querySelector('#app');
if (!app) {
  app = document.createElement('div');
  app.id = 'app';
  document.body.appendChild(app);
}

function renderFatalError(message) {
  app.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="brand auth-brand">
          <div class="brand-mark">⚡</div>
          <div>
            <h1>HubSync</h1>
            <p>Painel de tablets TI</p>
          </div>
        </div>
        <h2>Falha ao carregar</h2>
        <p class="auth-error">${message}</p>
      </div>
    </div>
  `;
}

window.addEventListener('error', (event) => {
  renderFatalError(event?.message || 'Erro inesperado no navegador.');
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason;
  const message = reason?.message || String(reason || 'Falha inesperada ao inicializar.');
  renderFatalError(message);
});

const tokenStorageKey = 'hubsync_auth_token';
let refreshTimer = null;

function safeGetStorage(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function safeSetStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures so the UI can continue rendering.
  }
}

function safeRemoveStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage failures so the UI can continue rendering.
  }
}

const state = {
  user: null,
  token: safeGetStorage(tokenStorageKey),
  authMode: 'login',
  authLoading: false,
  authError: '',
  authNotice: '',
  resetToken: '',
  verifyToken: '',
  users: [],
  usersLoading: false,
  usersError: '',
  usersModalOpen: false,
  notificationPreferences: {
    notifyNewAsset: true,
    notifyDueSoon: true,
    notifyOverdue: true,
    dueSoonDays: 7,
  },
  notificationPrefsLoading: false,
  notificationPrefsSaving: false,
  notificationPrefsError: '',
  notificationPrefsNotice: '',
  summary: { totalMonitored: 0, onlineOk: 0, attention: 0, overdue: 0 },
  assets: [],
  search: '',
  loading: true,
  editingAssetId: null,
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '';

function renderBootState(message = 'Carregando...') {
  app.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="brand auth-brand">
          <div class="brand-mark">⚡</div>
          <div>
            <h1>HubSync</h1>
            <p>Painel de tablets TI</p>
          </div>
        </div>
        <h2>${message}</h2>
      </div>
    </div>
  `;
}

function statusLabel(status) {
  if (status === 'ok') return 'ONLINE / OK';
  if (status === 'atencao') return 'ATENÇÃO';
  return 'VENCIDO';
}

function statusClass(status) {
  if (status === 'ok') return 'ok';
  if (status === 'atencao') return 'attention';
  return 'overdue';
}

function isAdminUser() {
  return state.user?.role === 'admin';
}

function canManageAssets() {
  return isAdminUser();
}

function roleLabel(role) {
  return role === 'admin' ? 'Admin' : 'Normal';
}

function getResetTokenFromHash() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.startsWith('reset-password')) return '';

  const queryString = hash.includes('?') ? hash.split('?')[1] : '';
  const params = new URLSearchParams(queryString);
  return String(params.get('token') || '').trim();
}

function getVerifyTokenFromHash() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.startsWith('verify-email')) return '';

  const queryString = hash.includes('?') ? hash.split('?')[1] : '';
  const params = new URLSearchParams(queryString);
  return String(params.get('token') || '').trim();
}

function ensureAutoRefresh() {
  if (refreshTimer) return;

  refreshTimer = setInterval(() => {
    if (state.user) {
      loadData().catch(() => {});
    }
  }, 60000);
}

function stopAutoRefresh() {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

function formatDate(value) {
  return new Date(value).toLocaleDateString('pt-BR');
}

function formatPhoneInput(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

async function apiFetch(path, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };

  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    state.user = null;
    state.token = '';
    safeRemoveStorage(tokenStorageKey);
    render();
    throw new Error('unauthorized');
  }

  return response;
}

function passwordRuleMessage(code) {
  const messages = {
    'password-too-short': 'A senha precisa ter no mínimo 10 caracteres.',
    'password-missing-uppercase': 'A senha precisa ter pelo menos 1 letra maiúscula.',
    'password-missing-lowercase': 'A senha precisa ter pelo menos 1 letra minúscula.',
    'password-missing-digit': 'A senha precisa ter pelo menos 1 número.',
    'password-missing-symbol': 'A senha precisa ter pelo menos 1 símbolo.',
  };

  return messages[code] || 'A senha não atende aos requisitos de segurança.';
}

function evaluatePasswordRules(password) {
  const value = String(password || '');
  return {
    minLength: value.length >= 10,
    upper: /[A-Z]/.test(value),
    lower: /[a-z]/.test(value),
    digit: /\d/.test(value),
    symbol: /[^A-Za-z0-9]/.test(value),
  };
}

function renderAuth() {
  const isLogin = state.authMode === 'login';
  const isForgot = state.authMode === 'forgot';
  const isReset = state.authMode === 'reset';
  const passwordRulesHint = 'A senha deve ter no mínimo 10 caracteres, com 1 maiúscula, 1 minúscula, 1 número e 1 símbolo.';
  const title = isLogin ? 'Entrar na plataforma' : 'Cadastrar novo usuário';
  const buttonLabel = isLogin ? 'Entrar' : 'Cadastrar e entrar';
  const toggleLabel = isLogin ? 'Não tenho conta' : 'Já tenho conta';
  const usernameField = isLogin
    ? ''
    : `
      <label>
        <span>Usuário</span>
        <input name="username" placeholder="Ex.: matheus" required />
      </label>
    `;
  const authTitle = isForgot
    ? 'Recuperar senha'
    : isReset
      ? 'Redefinir senha'
      : title;
  const authButtonLabel = isForgot
    ? 'Enviar link de recuperação'
    : isReset
      ? 'Redefinir senha'
      : buttonLabel;
  const forgotLinkAction = isLogin
    ? `
      <div class="auth-link-row">
        <button id="forgotPassword" class="auth-link-button" type="button">Esqueci minha senha</button>
      </div>
    `
    : '';
  const forgotField = isForgot
    ? `
      <label>
        <span>E-mail</span>
        <input name="email" type="email" placeholder="voce@dominio.com" required />
      </label>
    `
    : '';
  const resetFields = isReset
    ? `
      <label>
        <span>Token de recuperação</span>
        <input name="token" value="${state.resetToken}" ${state.resetToken ? 'readonly' : 'required'} placeholder="Token enviado por e-mail" />
      </label>
      <label>
        <span>Nova senha</span>
        <div class="password-field">
          <input id="resetNewPassword" name="newPassword" type="password" minlength="10" placeholder="Mínimo 10 caracteres" required />
          <button class="password-toggle" type="button" data-password-toggle="resetNewPassword" aria-label="Mostrar senha">👁</button>
        </div>
      </label>
      <label>
        <span>Confirmar nova senha</span>
        <div class="password-field">
          <input id="resetConfirmPassword" name="confirmPassword" type="password" minlength="10" placeholder="Repita a senha" required />
          <button class="password-toggle" type="button" data-password-toggle="resetConfirmPassword" aria-label="Mostrar senha">👁</button>
        </div>
      </label>
      <ul class="password-rules" data-password-rules-for="resetNewPassword">
        <li data-rule="minLength">Mínimo 10 caracteres</li>
        <li data-rule="upper">1 letra maiúscula</li>
        <li data-rule="lower">1 letra minúscula</li>
        <li data-rule="digit">1 número</li>
        <li data-rule="symbol">1 símbolo</li>
      </ul>
      <p class="auth-hint">${passwordRulesHint}</p>
    `
    : '';
  const resendVerificationAction = isLogin
    ? `
      <div class="auth-link-row">
        <button id="resendVerification" class="auth-link-button" type="button">Reenviar confirmação de e-mail</button>
      </div>
    `
    : '';

  app.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="brand auth-brand">
          <div class="brand-mark">⚡</div>
          <div>
            <h1>HubSync</h1>
            <p>Painel de tablets TI</p>
          </div>
        </div>

        <h2>${authTitle}</h2>

        ${state.authError ? `<p class="auth-error">${state.authError}</p>` : ''}
        ${state.authNotice ? `<p class="auth-notice">${state.authNotice}</p>` : ''}

        <form id="authForm" class="auth-form">
          ${usernameField}
          ${forgotField}
          ${resetFields}
          ${!isForgot && !isReset ? `
            <label>
              <span>E-mail</span>
              <input name="email" type="email" placeholder="voce@dominio.com" required />
            </label>
            <label>
              <span>Senha</span>
              <div class="password-field">
                <input id="registerPassword" name="password" type="password" minlength="10" placeholder="Mínimo 10 caracteres" required />
                <button class="password-toggle" type="button" data-password-toggle="registerPassword" aria-label="Mostrar senha">👁</button>
              </div>
            </label>
            ${!isLogin ? `
              <ul class="password-rules" data-password-rules-for="registerPassword">
                <li data-rule="minLength">Mínimo 10 caracteres</li>
                <li data-rule="upper">1 letra maiúscula</li>
                <li data-rule="lower">1 letra minúscula</li>
                <li data-rule="digit">1 número</li>
                <li data-rule="symbol">1 símbolo</li>
              </ul>
              <p class="auth-hint">${passwordRulesHint}</p>
            ` : ''}
            ${forgotLinkAction}
            ${resendVerificationAction}
          ` : ''}
          <button class="primary-button" type="submit" ${state.authLoading ? 'disabled' : ''}>${authButtonLabel}</button>
        </form>

        <div class="auth-actions">
          ${!isForgot && !isReset ? `<button id="toggleAuthMode" class="ghost-button auth-toggle" type="button">${toggleLabel}</button>` : ''}
          ${(isForgot || isReset) ? '<button id="backToLogin" class="ghost-button auth-toggle" type="button">Voltar</button>' : ''}
        </div>
      </div>
    </div>
  `;

  const form = document.querySelector('#authForm');
  const toggle = document.querySelector('#toggleAuthMode');
  const forgotPassword = document.querySelector('#forgotPassword');
  const resendVerification = document.querySelector('#resendVerification');
  const backToLogin = document.querySelector('#backToLogin');

  const passwordToggleButtons = document.querySelectorAll('[data-password-toggle]');
  passwordToggleButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const inputId = button.getAttribute('data-password-toggle');
      const input = inputId ? document.querySelector(`#${inputId}`) : null;
      if (!input) return;

      const isHidden = input.getAttribute('type') === 'password';
      input.setAttribute('type', isHidden ? 'text' : 'password');
      button.textContent = isHidden ? '🙈' : '👁';
      button.setAttribute('aria-label', isHidden ? 'Ocultar senha' : 'Mostrar senha');
    });
  });

  const passwordRuleLists = document.querySelectorAll('[data-password-rules-for]');
  passwordRuleLists.forEach((list) => {
    const inputId = list.getAttribute('data-password-rules-for');
    const input = inputId ? document.querySelector(`#${inputId}`) : null;
    if (!input) return;

    const paintRules = () => {
      const rules = evaluatePasswordRules(input.value);
      list.querySelectorAll('li[data-rule]').forEach((item) => {
        const rule = item.getAttribute('data-rule');
        const ok = Boolean(rule && rules[rule]);
        item.classList.toggle('ok', ok);
      });
    };

    paintRules();
    input.addEventListener('input', paintRules);
  });

  if (toggle) {
    toggle.addEventListener('click', () => {
      state.authMode = isLogin ? 'register' : 'login';
      state.authError = '';
      state.authNotice = '';
      renderAuth();
    });
  }

  if (forgotPassword) {
    forgotPassword.addEventListener('click', () => {
      state.authMode = 'forgot';
      state.authError = '';
      state.authNotice = '';
      renderAuth();
    });
  }

  if (resendVerification) {
    resendVerification.addEventListener('click', async () => {
      const email = window.prompt('Informe seu e-mail para reenviar a confirmação:') || '';
      if (!email.trim()) return;

      try {
        const response = await fetch(`${apiBaseUrl}/api/auth/resend-verification`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim() }),
        });

        const data = await response.json();
        state.authError = '';
        state.authNotice = data.message || 'Se o e-mail existir, enviaremos uma nova confirmação.';
        renderAuth();
      } catch {
        state.authError = 'Não foi possível reenviar o e-mail de confirmação.';
        renderAuth();
      }
    });
  }

  if (backToLogin) {
    backToLogin.addEventListener('click', () => {
      state.authMode = 'login';
      state.authError = '';
      state.authNotice = '';
      state.resetToken = '';
      window.location.hash = '';
      renderAuth();
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    state.authLoading = true;
    state.authError = '';
    state.authNotice = '';
    renderAuth();

    const formData = new FormData(form);

    try {
      if (isForgot) {
        const response = await fetch(`${apiBaseUrl}/api/auth/forgot-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: String(formData.get('email') || '').trim() }),
        });

        const data = await response.json();
        if (!response.ok) {
          state.authError = 'Não foi possível solicitar a recuperação de senha.';
          state.authLoading = false;
          renderAuth();
          return;
        }

        if (data.resetToken) {
          state.authMode = 'reset';
          state.resetToken = data.resetToken;
          window.location.hash = `reset-password?token=${data.resetToken}`;
          state.authNotice = 'Token gerado em desenvolvimento. Use a tela de redefinição.';
        } else {
          state.authNotice = data.message || 'Se o e-mail existir, você receberá um link de redefinição.';
        }

        state.authLoading = false;
        renderAuth();
        return;
      }

      if (isReset) {
        const token = String(formData.get('token') || '').trim() || state.resetToken;
        const newPassword = String(formData.get('newPassword') || '');
        const confirmPassword = String(formData.get('confirmPassword') || '');

        if (newPassword !== confirmPassword) {
          state.authError = 'As senhas não conferem.';
          state.authLoading = false;
          renderAuth();
          return;
        }

        const response = await fetch(`${apiBaseUrl}/api/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password: newPassword }),
        });

        const data = await response.json();
        if (!response.ok) {
          state.authError = data.error === 'token-invalid-or-expired'
            ? 'Token inválido ou expirado.'
            : String(data.error || '').startsWith('password-')
              ? passwordRuleMessage(data.error)
              : 'Não foi possível redefinir a senha.';
          state.authLoading = false;
          renderAuth();
          return;
        }

        state.authMode = 'login';
        state.resetToken = '';
        window.location.hash = '';
        state.authNotice = 'Senha redefinida com sucesso. Faça login novamente.';
        state.authLoading = false;
        renderAuth();
        return;
      }

      const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
      const payload = {
        email: String(formData.get('email') || '').trim(),
        password: String(formData.get('password') || ''),
      };

      if (!isLogin) {
        payload.username = String(formData.get('username') || '').trim();
      }

      const response = await fetch(`${apiBaseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok) {
        if (data.error === 'email-not-verified') {
          state.authError = 'Seu e-mail ainda não foi confirmado. Verifique sua caixa de entrada.';
        } else if (String(data.error || '').startsWith('password-')) {
          state.authError = passwordRuleMessage(data.error);
        } else {
          state.authError = 'Não foi possível autenticar. Verifique os dados e tente novamente.';
        }
        state.authLoading = false;
        renderAuth();
        return;
      }

      if (data.requiresEmailVerification) {
        state.authMode = 'login';
        state.authError = '';
        state.authNotice = data.message || 'Conta criada. Verifique seu e-mail para confirmar o cadastro.';
        state.authLoading = false;
        renderAuth();
        return;
      }

      state.user = data.user;
      state.token = data.token;
      safeSetStorage(tokenStorageKey, data.token);
      state.authLoading = false;
      ensureAutoRefresh();
      await loadNotificationPreferences();
      await loadData();
    } catch {
      state.authError = 'Erro de conexão com o servidor.';
      state.authLoading = false;
      renderAuth();
    }
  });
}

function render() {
  if (!state.token || !state.user) {
    renderAuth();
    return;
  }

  const editingAsset = state.assets.find((asset) => asset.id === state.editingAssetId) || null;
  const modalTitle = editingAsset ? 'Editar tablet' : 'Cadastrar tablet';
  const modalSubtitle = editingAsset ? 'Editar ativo' : 'Novo ativo';
  const submitLabel = editingAsset ? 'Atualizar' : 'Salvar';
  const manageAssets = canManageAssets();
  const renewalField = editingAsset
    ? `<input name="renewalPeriodDays" type="number" min="15" step="1" value="${editingAsset.renewalPeriodDays}" required />`
    : '<input value="15 dias fixos" disabled />';
  const renewalEmailValue = editingAsset ? (editingAsset.renewalEmail || '') : '';
  const summaryCards = [
    { title: 'TOTAL MONITORADO', value: state.summary.totalMonitored, accent: '' },
    { title: 'ONLINE / OK', value: state.summary.onlineOk, accent: 'accent-ok' },
    { title: 'ATENÇÃO', value: state.summary.attention, accent: 'accent-attention' },
    { title: 'VENCIDOS', value: state.summary.overdue, accent: 'accent-overdue' },
  ];

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">⚡</div>
          <div>
            <h1>HubSync</h1>
            <p>Painel de tablets TI</p>
          </div>
        </div>
        <div class="topbar-actions">
          ${isAdminUser() ? '<button class="ghost-button" data-action="open-users">Gerenciar Acessos</button>' : ''}
          <span class="user-chip">${state.user.username}</span>
          <button class="icon-button" aria-label="Alternar tema" title="Alternar tema">
            <span>◔</span>
          </button>
          ${manageAssets ? '<button class="primary-button" data-action="open-form">+ Novo Ativo</button>' : ''}
          <button class="icon-button" data-action="logout" aria-label="Sair" title="Sair">
            <span>↗</span>
          </button>
        </div>
      </header>

      <main class="content">
        <section class="settings-card">
          <h2>Notificações por e-mail</h2>
          <p>Personalize os alertas que você deseja receber.</p>
          <form id="notificationPrefsForm" class="settings-form">
            <label class="settings-check">
              <input type="checkbox" name="notifyNewAsset" ${state.notificationPreferences.notifyNewAsset ? 'checked' : ''} />
              <span>Receber e-mail quando um novo tablet for cadastrado</span>
            </label>
            <label class="settings-check">
              <input type="checkbox" name="notifyDueSoon" ${state.notificationPreferences.notifyDueSoon ? 'checked' : ''} />
              <span>Receber alerta quando estiver perto do vencimento</span>
            </label>
            <label class="settings-check">
              <input type="checkbox" name="notifyOverdue" ${state.notificationPreferences.notifyOverdue ? 'checked' : ''} />
              <span>Receber alerta quando estiver vencido</span>
            </label>
            <label>
              <span>Dias para alerta antecipado</span>
              <input name="dueSoonDays" type="number" min="1" max="30" value="${state.notificationPreferences.dueSoonDays}" required />
            </label>
            ${state.notificationPrefsError ? `<p class="auth-error">${state.notificationPrefsError}</p>` : ''}
            ${state.notificationPrefsNotice ? `<p class="auth-notice">${state.notificationPrefsNotice}</p>` : ''}
            <button class="ghost-button" type="submit" ${state.notificationPrefsSaving ? 'disabled' : ''}>
              ${state.notificationPrefsSaving ? 'Salvando...' : 'Salvar preferências'}
            </button>
          </form>
        </section>

        <section class="summary-grid">
          ${summaryCards.map((card) => `
            <article class="summary-card ${card.accent}">
              <span>${card.title}</span>
              <strong>${card.value}</strong>
            </article>
          `).join('')}
        </section>

        <section class="toolbar">
          <label class="search-box">
            <span>⌕</span>
            <input id="searchInput" value="${state.search}" placeholder="Buscar tablet...(/)" />
          </label>
          <div class="toolbar-actions">
            ${manageAssets ? '<button class="danger-button" data-action="resolve-overdue">Resolver Vencidos</button>' : ''}
            <a class="ghost-button" href="${apiBaseUrl}/api/assets/export.xlsx" target="_blank" rel="noreferrer">Exportar XLS</a>
          </div>
        </section>

        <section class="cards-grid">
          ${state.loading ? '<div class="empty-state">Carregando ativos...</div>' : state.assets.length === 0 ? '<div class="empty-state">Nenhum ativo encontrado.</div>' : state.assets.map((asset) => `
            <article class="asset-card ${statusClass(asset.status)}">
              <div class="asset-head">
                <div class="device-icon">📱</div>
                <div>
                  <h2>${asset.name}</h2>
                    <p>Número da pessoa: ${asset.personNumber}</p>
                      ${asset.renewalEmail ? `<p>E-mail renovação: ${asset.renewalEmail}</p>` : ''}
                </div>
              </div>
              <div class="asset-meta">
                <div>
                    <span>Última sinc</span>
                    <strong>${formatDate(asset.lastSyncAt)}</strong>
                </div>
                <div>
                    <span>Status</span>
                    <strong>${statusLabel(asset.status)}</strong>
                  </div>
                  <div>
                    <span>Faltam</span>
                    <strong>${asset.daysRemaining} dias</strong>
                </div>
              </div>
              <div class="asset-footer">
                ${manageAssets ? `
                  <div class="asset-footer-actions">
                    <button class="link-button" data-edit="${asset.id}">✎ Editar</button>
                    <button class="link-button" data-renew="${asset.id}">↻ Renovar</button>
                    <button class="link-button" data-renew-email="${asset.id}">✉ Renovação por e-mail</button>
                    <button class="link-button asset-delete-button" data-delete="${asset.id}">🗑 Lixeira</button>
                  </div>
                ` : '<div></div>'}
                <small>${formatDate(asset.renewalDueAt)}</small>
              </div>
            </article>
          `).join('')}
        </section>
      </main>
    </div>

    <dialog class="modal" id="assetModal">
      <form method="dialog" class="modal-card" id="assetForm">
        <div class="modal-header">
          <div>
            <p>${modalSubtitle}</p>
            <h3>${modalTitle}</h3>
          </div>
          <button class="icon-button" value="cancel">✕</button>
        </div>
        <label>
          <span>Nome do ativo</span>
          <input name="name" placeholder="Ex.: ANA PAULA" value="${editingAsset ? editingAsset.name : ''}" required />
        </label>
        <label>
          <span>Número da pessoa</span>
          <input name="personNumber" type="tel" inputmode="numeric" maxlength="15" placeholder="Ex.: (11) 99876-1234" value="${editingAsset ? editingAsset.personNumber : ''}" required />
        </label>
        <label>
          <span>Renovação mínima</span>
          ${renewalField}
        </label>
        <label>
          <span>E-mail de renovação</span>
          <input name="renewalEmail" type="email" placeholder="responsavel@empresa.com" value="${renewalEmailValue}" />
        </label>
        <div class="modal-actions">
          <button class="ghost-button" value="cancel">Cancelar</button>
          <button class="primary-button" type="submit">${submitLabel}</button>
        </div>
      </form>
    </dialog>

    <dialog class="modal" id="usersModal">
      <div class="modal-card users-modal-card">
        <div class="modal-header">
          <div>
            <p>RBAC / offboarding seguro</p>
            <h3>Gerenciar acessos</h3>
          </div>
          <button class="icon-button" value="close-users">✕</button>
        </div>

        <p class="users-helper">Admins podem promover ou rebaixar qualquer conta. Sua própria conta fica bloqueada para evitar auto-revogação.</p>

        <div class="users-table-shell">
          ${state.usersLoading
            ? '<p class="users-empty">Carregando usuários...</p>'
            : state.users.length === 0
              ? '<p class="users-empty">Nenhum usuário cadastrado.</p>'
              : `
                <table class="users-table">
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th>E-mail</th>
                      <th>Nível de acesso</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${state.users.map((user) => {
                      const isCurrentUser = user.id === state.user.id;
                      const nextRole = user.role === 'admin' ? 'viewer' : 'admin';
                      const actionLabel = user.role === 'admin' ? 'Remover Admin' : 'Tornar Admin';
                      return `
                        <tr>
                          <td data-label="Nome">${user.username}</td>
                          <td data-label="E-mail">${user.email}</td>
                          <td data-label="Nível de acesso"><span class="role-badge ${user.role === 'admin' ? 'role-admin' : 'role-viewer'}">${roleLabel(user.role)}</span></td>
                          <td data-label="Ações">
                            <div class="user-actions">
                              <button
                                class="table-action-button"
                                data-role-toggle="${user.id}"
                                data-next-role="${nextRole}"
                                ${isCurrentUser ? 'disabled title="Você não pode alterar o seu próprio acesso"' : ''}
                              >
                                ${actionLabel}
                              </button>
                              ${isCurrentUser
                                ? ''
                                : `<button class="table-action-button user-delete-button" data-user-delete="${user.id}">Excluir usuário</button>`}
                            </div>
                          </td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              `}
        </div>

        ${state.usersError ? `<p class="auth-error">${state.usersError}</p>` : ''}

        <form id="userCreateForm" class="auth-form users-create-form">
          <label>
            <span>Nome do usuário</span>
            <input name="username" placeholder="Ex.: João Silva" required />
          </label>
          <label>
            <span>E-mail</span>
            <input name="email" type="email" placeholder="usuario@empresa.com" required />
          </label>
          <label>
            <span>Senha</span>
            <input name="password" type="password" minlength="10" placeholder="Mínimo 10 caracteres" required />
          </label>
          ${state.usersError ? `<p class="auth-error">${state.usersError}</p>` : ''}
          <button class="primary-button" type="submit">Cadastrar usuário</button>
        </form>
      </div>
    </dialog>
  `;

  const usersModal = document.querySelector('#usersModal');
  if (usersModal) {
    if (state.usersModalOpen && !usersModal.open) {
      usersModal.showModal();
    } else if (!state.usersModalOpen && usersModal.open) {
      usersModal.close();
    }
  }

  bindEvents();
}

function bindEvents() {
  const searchInput = document.querySelector('#searchInput');
  const modal = document.querySelector('#assetModal');
  const form = document.querySelector('#assetForm');
  if (!searchInput || !modal || !form) return;

  const phoneInput = form.querySelector('input[name="personNumber"]');
  const closeButtons = modal.querySelectorAll('button[value="cancel"]');
  const usersModal = document.querySelector('#usersModal');
  const closeUsersButton = usersModal ? usersModal.querySelector('button[value="close-users"]') : null;
  const userCreateForm = document.querySelector('#userCreateForm');
  const openUsersButton = document.querySelector('[data-action="open-users"]');
  const logoutButton = document.querySelector('[data-action="logout"]');
  const openFormButton = document.querySelector('[data-action="open-form"]');
  const resolveOverdueButton = document.querySelector('[data-action="resolve-overdue"]');
  const notificationPrefsForm = document.querySelector('#notificationPrefsForm');

  if (openUsersButton) {
    openUsersButton.addEventListener('click', async () => {
      state.usersModalOpen = true;
      state.usersLoading = true;
      state.usersError = '';
      render();
      await loadUsers();
    });
  }

  if (usersModal) {
    usersModal.addEventListener('cancel', () => {
      state.usersModalOpen = false;
      render();
    });
    usersModal.addEventListener('close', () => {
      if (state.usersModalOpen) {
        state.usersModalOpen = false;
        render();
      }
    });
  }

  if (closeUsersButton) {
    closeUsersButton.setAttribute('type', 'button');
    closeUsersButton.addEventListener('click', () => {
      state.usersModalOpen = false;
      if (usersModal && usersModal.open) {
        usersModal.close();
      }
      render();
    });
  }

  if (userCreateForm) {
    userCreateForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(userCreateForm);
      state.usersError = '';
      try {
        const response = await apiFetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: String(formData.get('username') || '').trim(),
            email: String(formData.get('email') || '').trim(),
            password: String(formData.get('password') || ''),
          }),
        });

        if (!response.ok) {
          state.usersError = 'Não foi possível cadastrar usuário. Verifique se o e-mail já existe.';
          render();
          return;
        }

        userCreateForm.reset();
        await loadUsers();
      } catch {
        state.usersError = 'Falha ao cadastrar usuário.';
        render();
      }
    });
  }

  if (logoutButton) {
    logoutButton.addEventListener('click', () => {
      state.user = null;
      state.token = '';
      state.assets = [];
      state.users = [];
      state.usersModalOpen = false;
      safeRemoveStorage(tokenStorageKey);
      localStorage.removeItem(tokenStorageKey);
      render();
    });
  }

  if (openFormButton) {
    openFormButton.addEventListener('click', () => {
      state.editingAssetId = null;
      render();
      const modalElement = document.querySelector('#assetModal');
      if (modalElement) modalElement.showModal();
    });
  }
  closeButtons.forEach((button) => {
    button.setAttribute('type', 'button');
    button.addEventListener('click', () => modal.close());
  });

  if (phoneInput) {
    phoneInput.addEventListener('input', (event) => {
      event.target.value = formatPhoneInput(event.target.value);
    });
  }

  if (resolveOverdueButton) {
    resolveOverdueButton.addEventListener('click', async () => {
      await apiFetch('/api/assets/resolve-overdue', { method: 'POST' });
      await loadData();
    });
  }

  if (notificationPrefsForm) {
    notificationPrefsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(notificationPrefsForm);

      state.notificationPrefsSaving = true;
      state.notificationPrefsError = '';
      state.notificationPrefsNotice = '';
      render();

      try {
        const response = await apiFetch('/api/notifications/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            notifyNewAsset: formData.get('notifyNewAsset') === 'on',
            notifyDueSoon: formData.get('notifyDueSoon') === 'on',
            notifyOverdue: formData.get('notifyOverdue') === 'on',
            dueSoonDays: Number(formData.get('dueSoonDays')),
          }),
        });

        const payload = await response.json();
        if (!response.ok) {
          state.notificationPrefsError = 'Não foi possível salvar suas preferências.';
          state.notificationPrefsSaving = false;
          render();
          return;
        }

        state.notificationPreferences = payload;
        state.notificationPrefsNotice = 'Preferências salvas com sucesso.';
      } catch {
        state.notificationPrefsError = 'Falha ao salvar preferências.';
      }

      state.notificationPrefsSaving = false;
      render();
    });
  }

  document.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-delete');
      if (!window.confirm('Excluir este tablet?')) return;

      await apiFetch(`/api/assets/${id}`, { method: 'DELETE' });
      await loadData();
    });
  });

  document.querySelectorAll('[data-renew-email]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-renew-email');
      const asset = state.assets.find((item) => String(item.id) === String(id));
      const prefillEmail = String(asset?.renewalEmail || '').trim();
      const recipientEmail = prefillEmail || window.prompt('Digite o e-mail para enviar a renovação:') || '';
      if (!recipientEmail.trim()) {
        window.alert('Informe um e-mail válido no cadastro do ativo ou no envio manual.');
        return;
      }

      try {
        const response = await apiFetch(`/api/assets/${id}/send-renewal-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emailDestino: recipientEmail.trim() }),
        });

        if (!response.ok) {
          window.alert('Não foi possível enviar o e-mail de renovação.');
          return;
        }

        window.alert('E-mail de renovação enviado com sucesso.');
      } catch {
        window.alert('Falha ao enviar o e-mail de renovação.');
      }
    });
  });

  document.querySelectorAll('[data-role-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const userId = Number(button.getAttribute('data-role-toggle'));
      const nextRole = button.getAttribute('data-next-role');

      state.usersError = '';
      try {
        const response = await apiFetch(`/api/users/${userId}/role`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: nextRole }),
        });

        if (!response.ok) {
          state.usersError = 'Não foi possível atualizar o nível de acesso.';
          render();
          return;
        }

        await loadUsers();
      } catch {
        state.usersError = 'Falha ao atualizar o nível de acesso.';
        render();
      }
    });
  });

  document.querySelectorAll('[data-user-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const userId = button.getAttribute('data-user-delete');
      if (!window.confirm('Excluir este usuário?')) return;

      state.usersError = '';
      try {
        const response = await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
        if (!response.ok && response.status !== 204) {
          if (response.status === 403) {
            state.usersError = 'Você não pode excluir seu próprio usuário.';
          } else if (response.status === 404) {
            state.usersError = 'Usuário não encontrado.';
          } else {
            state.usersError = 'Não foi possível excluir o usuário.';
          }
          render();
          return;
        }

        state.usersError = '';
        await loadUsers();
      } catch {
        state.usersError = 'Falha ao excluir o usuário.';
        render();
      }
    });
  });

  document.querySelectorAll('[data-renew]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-renew');
      await apiFetch(`/api/assets/${id}/renew`, { method: 'POST' });
      await loadData();
    });
  });

  document.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.getAttribute('data-edit'));
      state.editingAssetId = id;
      render();
      document.querySelector('#assetModal').showModal();
    });
  });

  searchInput.addEventListener('input', async (event) => {
    state.search = event.target.value;
    await loadData();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const isEditing = state.editingAssetId !== null;
    const endpoint = isEditing ? `/api/assets/${state.editingAssetId}` : '/api/assets';
    const method = isEditing ? 'PUT' : 'POST';

    await apiFetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formData.get('name'),
        personNumber: String(formData.get('personNumber') || '').trim(),
        renewalEmail: String(formData.get('renewalEmail') || '').trim().toLowerCase(),
        renewalPeriodDays: isEditing ? Number(formData.get('renewalPeriodDays')) : 15,
      }),
    });
    state.editingAssetId = null;
    form.reset();
    modal.close();
    await loadData();
  });
}

async function loadData() {
  if (!state.token) {
    renderAuth();
    return;
  }

  state.loading = true;
  render();

  const response = await apiFetch('/api/summary');
  const payload = await response.json();

  state.summary = payload.summary;
  state.assets = state.search
    ? payload.assets.filter((asset) => asset.name.toLowerCase().includes(state.search.toLowerCase()))
    : payload.assets;
  state.loading = false;
  render();
}

async function loadUsers() {
  state.usersLoading = true;
  state.usersError = '';

  try {
    const response = await apiFetch('/api/users');
    state.users = await response.json();
  } catch {
    state.usersError = 'Não foi possível carregar usuários.';
  }

  state.usersLoading = false;
  render();
}

async function loadNotificationPreferences() {
  state.notificationPrefsLoading = true;
  state.notificationPrefsError = '';

  try {
    const response = await apiFetch('/api/notifications/preferences');
    if (response.ok) {
      state.notificationPreferences = await response.json();
    } else {
      state.notificationPrefsError = 'Não foi possível carregar preferências de notificação.';
    }
  } catch {
    state.notificationPrefsError = 'Não foi possível carregar preferências de notificação.';
  }

  state.notificationPrefsLoading = false;
}

async function bootstrap() {
  renderBootState('Inicializando painel...');
  const resetToken = getResetTokenFromHash();
  const verifyToken = getVerifyTokenFromHash();

  if (verifyToken) {
    try {
      const response = await fetch(`${apiBaseUrl}/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`);
      const payload = await response.json();
      if (response.ok) {
        state.authMode = 'login';
        state.authNotice = payload.message || 'E-mail confirmado com sucesso. Faça login.';
      } else {
        state.authMode = 'login';
        state.authError = payload.error === 'token-invalid-or-expired'
          ? 'Token de confirmação inválido ou expirado.'
          : 'Não foi possível confirmar seu e-mail.';
      }
    } catch {
      state.authMode = 'login';
      state.authError = 'Falha ao confirmar e-mail.';
    }

    window.location.hash = '';
  }

  if (resetToken) {
    state.authMode = 'reset';
    state.resetToken = resetToken;
  }

  if (!state.token) {
    renderAuth();
    return;
  }

  renderBootState('Conectando ao servidor...');

  try {
    const response = await apiFetch('/api/auth/me');
    const data = await response.json();
    state.user = data.user;
    ensureAutoRefresh();
    await loadNotificationPreferences();
    await loadData();
  } catch {
    state.user = null;
    state.token = '';
    safeRemoveStorage(tokenStorageKey);
    stopAutoRefresh();
    renderAuth();
  }
}

bootstrap().catch(() => {
  state.user = null;
  state.token = '';
  state.authError = 'Falha ao carregar o painel. Tente novamente.';
  safeRemoveStorage(tokenStorageKey);
  stopAutoRefresh();
  renderAuth();
});
