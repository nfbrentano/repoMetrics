import ApexCharts from 'apexcharts';
import dayjs from 'dayjs';
import { DataAggregator } from './src/services/DataAggregator.js';
import { RepoManager } from './src/components/RepoManager.js';
import { loadRepos, loadRange, saveRange } from './src/utils/storage.js';

let currentTab = 'atividade';
let currentRange = loadRange() || '6m';
let chartInstances = {};

const THEME_COLORS = {
  primary: '#6366f1',
  secondary: '#8b5cf6',
  accent: '#3b82f6',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  text: '#94a3b8',
  grid: 'rgba(255,255,255,0.05)'
};

const init = async () => {
  // Initialize Repo Manager
  new RepoManager((repos) => {
    updateRepoCount(repos);
    refreshData();
  });

  // Tab Switching
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = item.getAttribute('data-tab');
      switchTab(tab);
    });
  });

  // Range Switching
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const range = btn.getAttribute('data-range');
      setRange(range);
    });
  });

  // Initial Fetch
  const repos = loadRepos();
  updateRepoCount(repos);
  if (repos.length > 0) {
    refreshData();
  } else {
    renderRepoList(repos);
  }

  updateFilterButtons();
};

const switchTab = (tabId) => {
  currentTab = tabId;
  
  // Update Navigation UI
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  const activeNavItem = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (activeNavItem) activeNavItem.classList.add('active');
  
  // Update Content Panels
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const targetTab = document.getElementById(tabId);
  if (targetTab) targetTab.classList.add('active');

  const titles = {
    'atividade': 'Painel de Atividade',
    'colaboracao': 'Dashboard de Colaboração',
    'repositorios': 'Repositórios Integrados'
  };
  document.getElementById('tabTitle').innerText = titles[tabId] || 'Dashboard';
  
  // Force chart resize for visibility
  window.dispatchEvent(new Event('resize'));
};

const setRange = (range) => {
  currentRange = range;
  saveRange(range);
  document.getElementById('currentDateRange').innerText = range === '6m' ? 'Últimos 6 meses' : 'Último mês';
  updateFilterButtons();
  refreshData();
};

const updateFilterButtons = () => {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    const isActive = btn.getAttribute('data-range') === currentRange;
    btn.classList.toggle('active', isActive);
    btn.style.background = isActive ? THEME_COLORS.primary : 'transparent';
    btn.style.color = isActive ? '#fff' : THEME_COLORS.text;
  });
};

const updateRepoCount = (repos) => {
  const count = repos.length;
  document.getElementById('repoCount').innerHTML = `${count} repositório(s) consolidados • <span id="currentDateRange">${currentRange === '6m' ? 'Últimos 6 meses' : 'Último mês'}</span>`;
};

const refreshData = async () => {
  const rawRepos = loadRepos();
  if (rawRepos.length === 0) return;

  const titleEl = document.getElementById('tabTitle');
  const originalTitle = titleEl.innerText;
  titleEl.innerText = 'Resolvendo repositórios na nuvem...';

  // Render basic list before fetching
  renderRepoList(rawRepos, true);

  const resolvedRepos = await DataAggregator.expandWildcardRepos(rawRepos, (msg) => {
    titleEl.innerText = msg;
  });

  updateRepoCount(resolvedRepos);

  titleEl.innerText = 'Consolidando métricas...';

  const rangeMonths = parseInt(currentRange.replace('m', '')) || 6;
  
  const pbContainer = document.getElementById('globalProgressBarContainer');
  const pbFill = document.getElementById('globalProgressBar');
  if (pbContainer) {
    pbContainer.style.display = 'block';
    pbFill.style.width = '0%';
  }

  const metrics = await DataAggregator.aggregate(resolvedRepos, rangeMonths, (completed, total, repo) => {
    titleEl.innerText = `Lendo ${repo.repo} (${completed}/${total})...`;
    if (pbFill) pbFill.style.width = `${(completed / total) * 100}%`;
  });

  if (pbContainer) pbContainer.style.display = 'none';

  updateUI(metrics);
  renderCharts(metrics);
  renderRepoList(resolvedRepos, false); // Update list state to done with expanded repos
  
  titleEl.innerText = originalTitle;
};

const renderRepoList = (repos, isSyncing = false) => {
  const container = document.getElementById('integratedRepoContainer');
  if (!container) return;
  
  if (repos.length === 0) {
    container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 4rem;">Nenhum repositório conectado. Use o botão "Gerenciar Repos" para começar.</div>`;
    return;
  }

  const icons = {
    github: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>`,
    azure: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.38 21.05H8.7L11.51 12 8.7 8.35v11.23L2.38 21.05zm19.24-5.26L18 21.05H8.7L15 2.95l6.62 12.84z"/></svg>`,
    gitlab: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 13.29-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26a.42.42 0 0 0-.1-.18.38.38 0 0 0-.26-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z"/></svg>`,
    bitbucket: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.27 3.53a.89.89 0 0 0-.91 1l2.5 15A.89.89 0 0 0 4.75 20h14.5a.89.89 0 0 0 .89-.74l2.5-15a.89.89 0 0 0-.91-1zM15 15H9l-1-7h8z"/></svg>`
  };

  container.innerHTML = repos.map(repo => {
    const statusClass = isSyncing ? 'syncing' : 'active';
    const statusIcon = isSyncing 
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
    const statusText = isSyncing ? 'Sincronizando...' : 'Conectado';

    return `
      <div class="repo-api-card">
        <div class="repo-api-header">
          <div class="repo-api-provider">
            <div class="repo-api-icon">${icons[repo.provider] || icons.github}</div>
            ${repo.provider}
          </div>
        </div>
        <div class="repo-api-body">
          <p>${repo.namespace}</p>
          <h4>${repo.repo}</h4>
        </div>
        <div class="repo-api-status ${statusClass}">
          ${statusIcon} ${statusText}
        </div>
      </div>
    `;
  }).join('');
};

const updateUI = (metrics) => {
  // Activity
  document.getElementById('val-commits').innerText = metrics.commits.toLocaleString();
  document.getElementById('val-prs-created').innerText = metrics.prsCreated;
  document.getElementById('val-prs-merged').innerText = metrics.prsMerged;
  document.getElementById('val-issues').innerText = metrics.issuesOpen;

  // Collaboration
  if (document.getElementById('val-reviews')) {
    document.getElementById('val-reviews').innerText = metrics.reviews.toLocaleString();
    document.getElementById('val-time-review').innerText = `${metrics.avgTimeFirstReview.toFixed(1)}h`;
    document.getElementById('val-coverage').innerText = `${metrics.reviewCoverage.toFixed(0)}%`;
    document.getElementById('val-time-merge').innerText = `${metrics.avgTimeMerge.toFixed(1)}h`;
  }
};

const renderCharts = (metrics) => {
  const chartOptionsBase = {
    chart: { background: 'transparent', foreColor: THEME_COLORS.text, toolbar: { show: false } },
    grid: { borderColor: THEME_COLORS.grid },
    tooltip: { theme: 'dark' }
  };

  // Activity Flow Chart
  const activityCtx = document.getElementById('activityChart');
  if (activityCtx) {
    if (chartInstances.activity) chartInstances.activity.destroy();
    
    // Gerar labels do timeline em base ao keys sortidos
    const timelineKeys = Object.keys(metrics.commitsTimeline || {}).sort();
    let categories = [];
    let seriesData = [];
    
    if (timelineKeys.length === 0) {
      categories = ['Sem Dados'];
      seriesData = [0];
    } else {
      categories = timelineKeys.map(key => {
        const [y, m] = key.split('-');
        const d = new Date(y, parseInt(m)-1, 1);
        return d.toLocaleString('default', { month: 'short' }) + '/' + y.slice(2);
      });
      seriesData = timelineKeys.map(k => metrics.commitsTimeline[k]);
    }

    chartInstances.activity = new ApexCharts(activityCtx, {
      ...chartOptionsBase,
      series: [{
        name: 'Eventos (Commits)',
        data: seriesData
      }],
      chart: { ...chartOptionsBase.chart, type: 'area', height: 350 },
      stroke: { curve: 'smooth', colors: [THEME_COLORS.primary] },
      fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.5, opacityTo: 0.1 } },
      xaxis: { categories: categories }
    });
    chartInstances.activity.render();
  }

  // Authors Chart
  const authorsCtx = document.getElementById('authorsChart');
  if (authorsCtx) {
    if (chartInstances.authors) chartInstances.authors.destroy();
    
    const sortedAuthors = Object.entries(metrics.authors).sort((a,b) => b[1] - a[1]).slice(0, 10);
    
    chartInstances.authors = new ApexCharts(authorsCtx, {
      ...chartOptionsBase,
      series: sortedAuthors.map(a => a[1]),
      labels: sortedAuthors.map(a => a[0]),
      chart: { ...chartOptionsBase.chart, type: 'donut', height: 350 },
      colors: [THEME_COLORS.primary, THEME_COLORS.secondary, THEME_COLORS.accent, THEME_COLORS.success, THEME_COLORS.warning],
      legend: { position: 'bottom' },
      stroke: { show: false }
    });
    chartInstances.authors.render();
  }

  // Collaboration Timeline (Bar Chart)
  const collabCtx = document.getElementById('collaborationChart');
  if (collabCtx) {
    if (chartInstances.collab) chartInstances.collab.destroy();
    chartInstances.collab = new ApexCharts(collabCtx, {
      ...chartOptionsBase,
      series: [
        { name: 'Reviews', data: [44, 55, 41, 67, 22, 43] },
        { name: 'Comentários', data: [13, 23, 20, 8, 13, 27] }
      ],
      chart: { ...chartOptionsBase.chart, type: 'bar', height: 350, stacked: true },
      xaxis: { categories: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] },
      colors: [THEME_COLORS.primary, THEME_COLORS.accent]
    });
    chartInstances.collab.render();
  }
};

init();
