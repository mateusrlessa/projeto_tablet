import './styles.css';

const app = document.querySelector('#app');
const tokenStorageKey = 'hubsync_auth_token';

const state = {
  user: null,
  token: localStorage.getItem(tokenStorageKey) || '',
  authMode: 'login',
  authLoading: false,
  authError: '',
  users: [],
  usersLoading: false,
  usersError: '',
  usersModalOpen: false,
  summary: { totalMonitored: 0, onlineOk: 0, attention: 0, overdue: 0 },
  assets: [],
  search: '',
  loading: true,
  editingAssetId: null,
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '';

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
    localStorage.removeItem(tokenStorageKey);
    render();
    throw new Error('unauthorized');
  }

  return response;
}

function renderAuth() {
  const isLogin = state.authMode === 'login';
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

        <h2>${title}</h2>

        ${state.authError ? `<p class="auth-error">${state.authError}</p>` : ''}

        <form id="authForm" class="auth-form">
          ${usernameField}
          <label>
            <span>E-mail</span>
            <input name="email" type="email" placeholder="voce@empresa.com" required />
          </label>
          <label>
            <span>Senha</span>
            <input name="password" type="password" minlength="6" placeholder="Mínimo 6 caracteres" required />
          </label>
          <button class="primary-button" type="submit" ${state.authLoading ? 'disabled' : ''}>${buttonLabel}</button>
        </form>

        <button id="toggleAuthMode" class="ghost-button auth-toggle" type="button">${toggleLabel}</button>
      </div>
    </div>
  `;

  const form = document.querySelector('#authForm');
  const toggle = document.querySelector('#toggleAuthMode');

  toggle.addEventListener('click', () => {
    state.authMode = isLogin ? 'register' : 'login';
    state.authError = '';
    renderAuth();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    state.authLoading = true;
    state.authError = '';
    renderAuth();

    const formData = new FormData(form);
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
    const payload = {
      email: String(formData.get('email') || '').trim(),
      password: String(formData.get('password') || ''),
    };

    if (!isLogin) {
      payload.username = String(formData.get('username') || '').trim();
    }

    try {
      const response = await fetch(`${apiBaseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok) {
        state.authError = 'Não foi possível autenticar. Verifique os dados e tente novamente.';
        state.authLoading = false;
        renderAuth();
        return;
      }

      state.user = data.user;
      state.token = data.token;
      localStorage.setItem(tokenStorageKey, data.token);
      state.authLoading = false;
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
  const renewalField = editingAsset
    ? `<input name="renewalPeriodDays" type="number" min="15" step="1" value="${editingAsset.renewalPeriodDays}" required />`
    : '<input value="15 dias fixos" disabled />';
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
          <button class="ghost-button" data-action="open-users">Gestão de Usuários</button>
          <span class="user-chip">${state.user.username}</span>
          <button class="icon-button" title="Alternar tema">
            <span>◔</span>
          </button>
          <button class="primary-button" data-action="open-form">+ Novo Ativo</button>
          <button class="icon-button" data-action="logout" title="Sair">
            <span>↗</span>
          </button>
        </div>
      </header>

      <main class="content">
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
            <input id="searchInput" value="${state.search}" placeholder="Buscar usuário...(/)" />
          </label>
          <div class="toolbar-actions">
            <button class="danger-button" data-action="resolve-overdue">Resolver Vencidos</button>
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
                <div class="asset-footer-actions">
                  <button class="link-button" data-edit="${asset.id}">✎ Editar</button>
                  <button class="link-button" data-renew="${asset.id}">↻ Renovar</button>
                </div>
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
            <p>Gestão de usuários</p>
            <h3>Usuários cadastrados</h3>
          </div>
          <button class="icon-button" value="close-users">✕</button>
        </div>

        <div class="users-list">
          ${state.usersLoading
            ? '<p class="users-empty">Carregando usuários...</p>'
            : state.users.length === 0
              ? '<p class="users-empty">Nenhum usuário cadastrado.</p>'
              : state.users.map((user) => `
                <article class="user-item">
                  <strong>${user.username}</strong>
                  <span>${user.email}</span>
                </article>
              `).join('')}
        </div>

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
            <input name="password" type="password" minlength="6" placeholder="Mínimo 6 caracteres" required />
          </label>
          ${state.usersError ? `<p class="auth-error">${state.usersError}</p>` : ''}
          <button class="primary-button" type="submit">Cadastrar usuário</button>
        </form>
      </div>
    </dialog>
  `;

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

  if (openUsersButton) {
    openUsersButton.addEventListener('click', async () => {
      state.usersModalOpen = true;
      state.usersLoading = true;
      state.usersError = '';
      render();
      const dialog = document.querySelector('#usersModal');
      if (dialog && !dialog.open) {
        dialog.showModal();
      }
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
  if (state.usersLoading && state.users.length > 0) return;

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

async function bootstrap() {
  if (!state.token) {
    renderAuth();
    return;
  }

  try {
    const response = await apiFetch('/api/auth/me');
    const data = await response.json();
    state.user = data.user;
    await loadData();
  } catch {
    state.user = null;
    state.token = '';
    localStorage.removeItem(tokenStorageKey);
    renderAuth();
  }
}

bootstrap();
