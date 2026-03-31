import { loadRepos, saveRepos } from '../utils/storage.js';
import { GitHubService } from '../services/GitHubService.js';
import { GitLabService } from '../services/GitLabService.js';
import { BitbucketService } from '../services/BitbucketService.js';
import { AzureService } from '../services/AzureService.js';

export class RepoManager {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.modal = document.getElementById('repoModal');
    this.trigger = document.getElementById('openRepoManager');
    this.closeBtn = document.getElementById('closeRepoModal');
    this.addBtn = document.getElementById('addRepoBtn');
    this.reposContainer = document.getElementById('activeReposContainer');
    this.wildcardCheckbox = document.getElementById('repoWildcard');
    this.repoNameInput = document.getElementById('repoName');
    
    this.init();
  }

  init() {
    this.trigger.onclick = () => this.showModal();
    this.closeBtn.onclick = () => this.hideModal();
    window.onclick = (e) => { if (e.target === this.modal) this.hideModal(); };
    
    this.addBtn.onclick = () => this.addRepo();
    
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

    this.renderRepos();
  }

  showModal() {
    this.modal.style.display = 'flex';
  }

  hideModal() {
    this.modal.style.display = 'none';
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

    if (this.wildcardCheckbox.checked) {
      const newRepo = {
        id: Date.now().toString(),
        provider,
        token,
        namespace,
        repo: '*',
        type: 'wildcard',
        active: true
      };
      repos.push(newRepo);
      saveRepos(repos);
    } else {
      const newRepo = {
        id: Date.now().toString(),
        provider,
        token,
        namespace,
        repo,
        active: true
      };
      repos.push(newRepo);
      saveRepos(repos);
    }
    
    // Clear inputs
    document.getElementById('repoToken').value = '';
    document.getElementById('repoNamespace').value = '';
    document.getElementById('repoName').value = '';
    this.wildcardCheckbox.checked = false;
    this.repoNameInput.disabled = false;
    this.repoNameInput.style.opacity = '1';

    this.renderRepos();
    this.onUpdate(repos);
  }

  removeRepo(id) {
    const repos = loadRepos().filter(r => r.id !== id);
    saveRepos(repos);
    this.renderRepos();
    this.onUpdate(repos);
  }

  renderRepos() {
    const repos = loadRepos();
    this.reposContainer.innerHTML = '';

    if (repos.length === 0) {
      this.reposContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 0.8rem">Nenhum repositório configurado.</p>';
      return;
    }

    repos.forEach(repo => {
      const item = document.createElement('div');
      item.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; background: var(--glass-bg); border-radius: 8px; border: 1px solid var(--glass-border);';
      
      const info = document.createElement('div');
      info.innerHTML = `
        <div style="font-weight: 600; font-size: 0.875rem">${repo.repo}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted)">${repo.provider} / ${repo.namespace}</div>
      `;

      const delBtn = document.createElement('button');
      delBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
      delBtn.style.cssText = 'background: none; border: none; color: var(--danger); cursor: pointer; padding: 0.25rem;';
      delBtn.onclick = () => this.removeRepo(repo.id);

      item.appendChild(info);
      item.appendChild(delBtn);
      this.reposContainer.appendChild(item);
    });
  }
}
