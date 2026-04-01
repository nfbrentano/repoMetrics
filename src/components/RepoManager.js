import { loadRepos, saveRepos } from '../utils/storage.js';

export class RepoManager {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.addBtn = document.getElementById('addRepoBtn');
    this.reposContainer = document.getElementById('activeReposContainer');
    this.wildcardCheckbox = document.getElementById('repoWildcard');
    this.repoNameInput = document.getElementById('repoName');
    this.forceResyncBtn = document.getElementById('forceResyncBtn');
    
    this.init();
  }

  init() {
    if (this.addBtn) this.addBtn.onclick = () => this.addRepo();
    
    if (this.wildcardCheckbox) {
      this.wildcardCheckbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          this.repoNameInput.value = '*';
          this.repoNameInput.disabled = true;
          this.repoNameInput.style.opacity = '0.5';
        } else {
          this.repoNameInput.value = '';
          this.repoNameInput.disabled = false;
          this.repoNameInput.style.opacity = '1';
        }
      });
    }

    if (this.forceResyncBtn) {
      this.forceResyncBtn.onclick = () => this.forceResync();
    }

    this.renderRepos();
  }

  async forceResync() {
    if (!confirm('Isso irá apagar o histórico de sincronização local e buscar todos os dados novamente de todas as APIs. Deseja continuar?')) {
      return;
    }

    this.forceResyncBtn.disabled = true;
    this.forceResyncBtn.innerHTML = '<span class="status-spinner"></span> Sincronizando...';

    try {
      const res = await fetch('/api/sync/force', { method: 'POST' });
      if (!res.ok) throw new Error('Falha ao iniciar sincronização forçada');
      
      const data = await res.json();
      alert('Sincronização forçada iniciada com sucesso! Os dados aparecerão em instantes.');
      
      // Trigger update
      if (this.onUpdate) this.onUpdate(loadRepos());
    } catch (err) {
      console.error(err);
      alert('Erro ao forçar sincronização: ' + err.message);
    } finally {
      this.forceResyncBtn.disabled = false;
      this.forceResyncBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        Forçar Re-sync Total
      `;
    }
  }

  async addRepo() {
    const provider = document.getElementById('providerSelect').value;
    const token = document.getElementById('repoToken').value;
    const namespace = document.getElementById('repoNamespace').value;
    const repo = document.getElementById('repoName').value;

    if (!token || !namespace) {
      alert('Por favor, preencha todos os campos!');
      return;
    }
    if (!this.wildcardCheckbox.checked && !repo) {
       alert('Por favor, preencha o nome do repositório!');
       return;
    }

    const repos = loadRepos();

    const newRepo = {
      id: Date.now().toString(),
      provider,
      token,
      namespace,
      repo: this.wildcardCheckbox.checked ? '*' : repo,
      type: this.wildcardCheckbox.checked ? 'wildcard' : 'standard',
      active: true
    };
    
    repos.push(newRepo);
    saveRepos(repos);
    
    // Clear inputs
    document.getElementById('repoToken').value = '';
    document.getElementById('repoNamespace').value = '';
    document.getElementById('repoName').value = '';
    this.wildcardCheckbox.checked = false;
    this.repoNameInput.disabled = false;
    this.repoNameInput.style.opacity = '1';

    this.renderRepos();
    if (this.onUpdate) this.onUpdate(repos);
  }

  removeRepo(id) {
    if (!confirm('Deseja remover esta configuração de repositório?')) return;
    const repos = loadRepos().filter(r => r.id !== id);
    saveRepos(repos);
    this.renderRepos();
    if (this.onUpdate) this.onUpdate(repos);
  }

  renderRepos() {
    const repos = loadRepos();
    this.reposContainer.innerHTML = '';

    if (repos.length === 0) {
      this.reposContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 0.8rem">Nenhuma configuração ativa.</p>';
      return;
    }

    repos.forEach(repo => {
      const item = document.createElement('div');
      item.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 1rem; background: rgba(255,255,255,0.03); border-radius: 12px; border: 1px solid var(--glass-border); transition: var(--transition);';
      
      const info = document.createElement('div');
      info.innerHTML = `
        <div style="font-weight: 700; font-size: 0.9rem; color: #fff; margin-bottom: 0.25rem;">${repo.repo}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.5rem;">
          <span style="text-transform: uppercase; font-weight: 800; color: var(--primary); font-size: 0.65rem;">${repo.provider}</span>
          <span>•</span>
          <span>${repo.namespace}</span>
        </div>
      `;

      const delBtn = document.createElement('button');
      delBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      delBtn.style.cssText = 'background: rgba(239, 68, 68, 0.1); border: none; color: var(--danger); cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: var(--transition);';
      delBtn.onmouseover = () => delBtn.style.background = 'rgba(239, 68, 68, 0.2)';
      delBtn.onmouseout = () => delBtn.style.background = 'rgba(239, 68, 68, 0.1)';
      delBtn.onclick = () => this.removeRepo(repo.id);

      item.appendChild(info);
      item.appendChild(delBtn);
      this.reposContainer.appendChild(item);
    });
  }
}
