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
  verifyEmail: '',
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
  adminMode: false,
  adminDashboard: null,
  adminAuditEvents: [],
  adminSystemInfo: null,
  adminLoading: false,
  adminAuditPage: 0,
  adminAuditLimit: 25,
  adminAuditTotal: 0,
  adminAuditEventTypeFilter: '',
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
  const isRegister = state.authMode === 'register';
  const isForgot = state.authMode === 'forgot';
  const isReset = state.authMode === 'reset';
  const isVerify = state.authMode === 'verify';
  const passwordRulesHint = 'A senha deve ter no mínimo 10 caracteres, com 1 maiúscula, 1 minúscula, 1 número e 1 símbolo.';
  const title = isLogin ? 'Entrar na plataforma' : 'Cadastrar novo usuário';
  const buttonLabel = isLogin ? 'Entrar' : 'Cadastrar e entrar';
  const toggleLabel = isLogin ? 'Não tenho conta' : 'Já tenho conta';
  const usernameField = isRegister
    ? `
      <label>
        <span>Usuário</span>
        <input name="username" placeholder="Ex.: matheus" required />
      </label>
    `
    : '';
  const authTitle = isForgot
    ? 'Recuperar senha'
    : isReset
      ? 'Redefinir senha'
      : isVerify
        ? 'Confirmar e-mail'
      : title;
  const authButtonLabel = isForgot
    ? 'Enviar link de recuperação'
    : isReset
      ? 'Redefinir senha'
      : isVerify
        ? 'Confirmar código'
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
  const verifyFields = isVerify
    ? `
      <p class="auth-hint">Enviamos um código de 6 dígitos para o e-mail informado. Digite o código abaixo para concluir o cadastro.</p>
      <label>
        <span>E-mail</span>
        <input name="verifyEmail" type="email" value="${state.verifyEmail}" placeholder="voce@dominio.com" required />
      </label>
      <label>
        <span>Código de confirmação</span>
        <input name="verifyCode" inputmode="numeric" maxlength="6" placeholder="000000" required />
      </label>
      <div class="auth-link-row">
        <button id="resendVerificationCode" class="auth-link-button" type="button">Reenviar código</button>
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
          ${verifyFields}
          ${!isForgot && !isReset && !isVerify ? `
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
          ` : ''}
          <button class="primary-button" type="submit" ${state.authLoading ? 'disabled' : ''}>${authButtonLabel}</button>
        </form>

        <div class="auth-actions">
          ${!isForgot && !isReset && !isVerify ? `<button id="toggleAuthMode" class="ghost-button auth-toggle" type="button">${toggleLabel}</button>` : ''}
          ${(isForgot || isReset || isVerify) ? '<button id="backToLogin" class="ghost-button auth-toggle" type="button">Voltar</button>' : ''}
        </div>
      </div>
    </div>
  `;

  const form = document.querySelector('#authForm');
  const toggle = document.querySelector('#toggleAuthMode');
  const forgotPassword = document.querySelector('#forgotPassword');
  const resendVerificationCode = document.querySelector('#resendVerificationCode');
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

  if (resendVerificationCode) {
    resendVerificationCode.addEventListener('click', async () => {
      const email = String(state.verifyEmail || '').trim();
      if (!email) {
        state.authError = 'Informe o e-mail para reenviar o código.';
        renderAuth();
        return;
      }

      try {
        const response = await fetch(`${apiBaseUrl}/api/auth/resend-verification`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });

        const data = await response.json();
        state.authError = '';
        state.authNotice = data.message || 'Se o e-mail existir, enviaremos um novo código de confirmação.';
        renderAuth();
      } catch {
        state.authError = 'Não foi possível reenviar o código de confirmação.';
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
      state.verifyEmail = '';
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

      if (isVerify) {
        const verifyEmail = String(formData.get('verifyEmail') || '').trim().toLowerCase();
        const verifyCode = String(formData.get('verifyCode') || '').replace(/\D/g, '').slice(0, 6);

        state.verifyEmail = verifyEmail;

        const response = await fetch(`${apiBaseUrl}/api/auth/verify-email-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: verifyEmail, code: verifyCode }),
        });

        const data = await response.json();
        if (!response.ok) {
          state.authError = data.error === 'verify-code-invalid-or-expired'
            ? 'Código inválido ou expirado. Solicite um novo código.'
            : 'Não foi possível confirmar o e-mail com o código informado.';
          state.authLoading = false;
          renderAuth();
          return;
        }

        state.authMode = 'login';
        state.verifyEmail = '';
        state.authError = '';
        state.authNotice = data.message || 'E-mail confirmado com sucesso. Faça login.';
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
          state.authMode = 'verify';
          state.verifyEmail = String(formData.get('email') || '').trim().toLowerCase();
          state.authError = '';
          state.authNotice = 'Seu e-mail ainda não foi confirmado. Digite o código recebido para concluir o acesso.';
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
        state.authMode = 'verify';
        state.verifyEmail = data.verifyEmail || String(formData.get('email') || '').trim().toLowerCase();
        state.authError = '';
        state.authNotice = data.message || 'Conta criada. Digite o código recebido no seu e-mail para confirmar o cadastro.';
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

function renderAdminPanel() {
  if (!isAdminUser()) {
    state.adminMode = false;
    render();
    return;
  }

  const dashboard = state.adminDashboard || {};
  const systemInfo = state.adminSystemInfo || {};
  const auditEvents = state.adminAuditEvents || [];
  const totalPages = Math.ceil(state.adminAuditTotal / state.adminAuditLimit);
  const currentPage = state.adminAuditPage + 1;
  const canPrevAudit = state.adminAuditPage > 0;
  const canNextAudit = currentPage < totalPages;

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">⚡</div>
          <div>
            <h1>HubSync</h1>
            <p>Painel Administrativo</p>
          </div>
        </div>
        <div class="topbar-actions">
          <button class="ghost-button" data-action="back-to-dashboard">← Dashboard normal</button>
          <span class="user-chip">${state.user.username} (Admin)</span>
          <button class="icon-button" data-action="logout" aria-label="Sair" title="Sair">
            <span>↗</span>
          </button>
        </div>
      </header>

      <main class="content admin-content">
        <nav class="admin-nav">
          <button class="admin-nav-item ${state.adminAuditEventTypeFilter === '' ? 'active' : ''}" data-admin-section="overview">📊 Visão Geral</button>
          <button class="admin-nav-item ${state.adminAuditEventTypeFilter !== '' || state.adminAuditEvents.length > 0 ? 'active' : ''}" data-admin-section="audit">📋 Auditoria</button>
          <button class="admin-nav-item" data-admin-section="system">⚙️ Sistema</button>
          <button class="admin-nav-item" data-admin-section="users" data-action="open-users">👥 Usuarios</button>
        </nav>

        <section class="admin-panel-section admin-overview">
          <div class="admin-stats-grid">
            <article class="admin-stat-card">
              <h4>Usuários Totais</h4>
              <strong class="admin-stat-value">${dashboard.totalUsers || 0}</strong>
              <p class="admin-stat-subtitle">${dashboard.verifiedUsers || 0} verificados</p>
            </article>
            <article class="admin-stat-card">
              <h4>Ativos Totais</h4>
              <strong class="admin-stat-value">${dashboard.totalAssets || 0}</strong>
              <p class="admin-stat-subtitle">${dashboard.dueSoonAssets || 0} próximos do vencimento</p>
            </article>
            <article class="admin-stat-card">
              <h4>Vencidos</h4>
              <strong class="admin-stat-value" style="color: #dc2626;">${dashboard.overdueAssets || 0}</strong>
              <p class="admin-stat-subtitle">Precisam atenção</p>
            </article>
            <article class="admin-stat-card">
              <h4>Eventos de Auditoria</h4>
              <strong class="admin-stat-value">${dashboard.totalAuditEvents || 0}</strong>
              <p class="admin-stat-subtitle">Últimos 7 dias</p>
            </article>
          </div>

          ${dashboard.recentEventTypes && dashboard.recentEventTypes.length > 0 ? `
            <div class="admin-recent-events">
              <h3>Eventos Recentes (7 dias)</h3>
              <ul class="admin-event-list">
                ${dashboard.recentEventTypes.map((event) => `
                  <li>
                    <span class="event-type-badge">${event.eventType}</span>
                    <strong>${event.count}</strong> ocorrências
                  </li>
                `).join('')}
              </ul>
            </div>
          ` : ''}
        </section>

        <section class="admin-panel-section admin-audit">
          <div class="admin-audit-controls">
            <input
              type="text"
              id="auditEventTypeFilter"
              placeholder="Filtrar por tipo de evento (ex.: user.created)..."
              class="admin-filter-input"
              value="${state.adminAuditEventTypeFilter}"
            />
            <button class="primary-button" id="applyAuditFilter">🔍 Filtrar</button>
          </div>

          ${auditEvents.length > 0 ? `
            <div class="admin-audit-table-wrapper">
              <table class="admin-audit-table">
                <thead>
                  <tr>
                    <th>Data/Hora</th>
                    <th>Tipo de Evento</th>
                    <th>Ator</th>
                    <th>Alvo</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  ${auditEvents.map((event) => `
                    <tr>
                      <td>${new Date(event.createdAt).toLocaleString('pt-BR')}</td>
                      <td><span class="audit-event-type">${event.eventType}</span></td>
                      <td>${event.actorEmail || '—'}</td>
                      <td>${event.targetEmail || '—'}</td>
                      <td><code>${event.payload?.requestIp || '—'}</code></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <div class="admin-pagination">
              <button class="ghost-button" id="auditPrevBtn" ${!canPrevAudit ? 'disabled' : ''}>← Anterior</button>
              <span>Página ${currentPage} de ${totalPages} (Total: ${state.adminAuditTotal})</span>
              <button class="ghost-button" id="auditNextBtn" ${!canNextAudit ? 'disabled' : ''}>Próxima →</button>
            </div>
          ` : '<div class="empty-state">Nenhum evento encontrado.</div>'}
        </section>

        <section class="admin-panel-section admin-system">
          ${systemInfo ? `
            <div class="admin-system-info">
              <h3>Informações do Sistema</h3>
              <div class="admin-system-grid">
                <div class="info-item">
                  <span>Ambiente</span>
                  <strong>${systemInfo.nodeEnv || '—'}</strong>
                </div>
                <div class="info-item">
                  <span>Porta</span>
                  <strong>${systemInfo.port || '—'}</strong>
                </div>
                <div class="info-item">
                  <span>E-mail (SMTP)</span>
                  <strong>${systemInfo.smtpConfigured ? '✓ Ativo' : '✗ Desativado'}</strong>
                </div>
                <div class="info-item">
                  <span>AUTH_SECRET</span>
                  <strong>${systemInfo.authSecureStatus === 'strong' ? '✓ Seguro' : '⚠️ Fraco'}</strong>
                </div>
                <div class="info-item">
                  <span>Uptime (segundos)</span>
                  <strong>${Math.round(systemInfo.uptime || 0)}</strong>
                </div>
                <div class="info-item">
                  <span>CORS Origins</span>
                  <strong>${(systemInfo.corsOrigins || []).join(', ') || '—'}</strong>
                </div>
              </div>
            </div>
          ` : '<div class="empty-state">Carregando informações do sistema...</div>'}
        </section>
      </main>
    </div>
  `;

  const backBtn = document.querySelector('[data-action="back-to-dashboard"]');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      state.adminMode = false;
      render();
    });
  }

  const logoutButton = document.querySelector('[data-action="logout"]');
  if (logoutButton) {
    logoutButton.addEventListener('click', () => {
      state.user = null;
      state.token = '';
      state.assets = [];
      state.users = [];
      state.usersModalOpen = false;
      state.adminMode = false;
      safeRemoveStorage(tokenStorageKey);
      render();
    });
  }

  const openUsersButton = document.querySelector('[data-action="open-users"]');
  if (openUsersButton) {
    openUsersButton.addEventListener('click', async () => {
      state.usersModalOpen = true;
      state.usersLoading = true;
      state.usersError = '';
      renderAdminPanel();
      await loadUsers();
    });
  }

  const applyFilterBtn = document.querySelector('#applyAuditFilter');
  if (applyFilterBtn) {
    applyFilterBtn.addEventListener('click', async () => {
      const input = document.querySelector('#auditEventTypeFilter');
      state.adminAuditEventTypeFilter = input.value.trim();
      state.adminAuditPage = 0;
      await loadAdminAudit();
      renderAdminPanel();
    });
  }

  const prevBtn = document.querySelector('#auditPrevBtn');
  if (prevBtn && canPrevAudit) {
    prevBtn.addEventListener('click', async () => {
      state.adminAuditPage -= 1;
      await loadAdminAudit();
      renderAdminPanel();
    });
  }

  const nextBtn = document.querySelector('#auditNextBtn');
  if (nextBtn && canNextAudit) {
    nextBtn.addEventListener('click', async () => {
      state.adminAuditPage += 1;
      await loadAdminAudit();
      renderAdminPanel();
    });
  }
}

function render() {
  if (!state.token || !state.user) {
    renderAuth();
    return;
  }

  if (state.adminMode && isAdminUser()) {
    renderAdminPanel();
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
          ${isAdminUser() ? '<button class="danger-button" data-action="open-admin">🔑 Painel Admin</button>' : ''}
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
  const openAdminButton = document.querySelector('[data-action="open-admin"]');
  const openUsersButton = document.querySelector('[data-action="open-users"]');
  const logoutButton = document.querySelector('[data-action="logout"]');
  const openFormButton = document.querySelector('[data-action="open-form"]');
  const resolveOverdueButton = document.querySelector('[data-action="resolve-overdue"]');
  const notificationPrefsForm = document.querySelector('#notificationPrefsForm');

  if (openAdminButton) {
    openAdminButton.addEventListener('click', async () => {
      state.adminMode = true;
      await loadAdminDashboard();
      await loadAdminAudit();
      await loadAdminSystemInfo();
      render();
    });
  }

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

async function loadAdminDashboard() {
  state.adminLoading = true;

  try {
    const response = await apiFetch('/api/admin/dashboard');
    if (response.ok) {
      state.adminDashboard = await response.json();
    }
  } catch {
    state.adminDashboard = null;
  }

  state.adminLoading = false;
}

async function loadAdminAudit() {
  state.adminLoading = true;

  try {
    const offset = state.adminAuditPage * state.adminAuditLimit;
    const params = new URLSearchParams({
      limit: state.adminAuditLimit,
      offset,
    });
    if (state.adminAuditEventTypeFilter) {
      params.append('eventType', state.adminAuditEventTypeFilter);
    }

    const response = await apiFetch(`/api/admin/audit?${params.toString()}`);
    if (response.ok) {
      const data = await response.json();
      state.adminAuditEvents = data.events;
      state.adminAuditTotal = data.total;
    }
  } catch {
    state.adminAuditEvents = [];
  }

  state.adminLoading = false;
}

async function loadAdminSystemInfo() {
  try {
    const response = await apiFetch('/api/admin/system-info');
    if (response.ok) {
      state.adminSystemInfo = await response.json();
    }
  } catch {
    state.adminSystemInfo = null;
  }
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
