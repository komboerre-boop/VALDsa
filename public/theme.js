(() => {
  const STORAGE_KEY = 'cakeworld_theme';
  const THEMES = [
    { id: 'classic', label: 'Original', note: 'Синий' },
    { id: 'exosware', label: 'ExosWare', note: 'Неон' },
    { id: 'fallen', label: 'Fallen', note: 'Графит' },
    { id: 'svintus', label: 'Svintus', note: 'Жар' }
  ];

  function resolveTheme(themeId) {
    return THEMES.find(theme => theme.id === themeId) || THEMES[0];
  }

  function readStoredTheme() {
    try {
      return resolveTheme(localStorage.getItem(STORAGE_KEY)).id;
    } catch (_) {
      return THEMES[0].id;
    }
  }

  function persistTheme(themeId) {
    try {
      localStorage.setItem(STORAGE_KEY, themeId);
    } catch (_) {
      // Ignore storage errors and keep the active theme only in memory.
    }
  }

  function syncThemeAttributes(themeId) {
    document.documentElement.dataset.theme = themeId;
    if (document.body) {
      document.body.dataset.theme = themeId;
    }
  }

  function emitTheme(theme) {
    window.dispatchEvent(new CustomEvent('cake-theme-change', { detail: theme }));
  }

  const initialThemeId = readStoredTheme();
  syncThemeAttributes(initialThemeId);

  const api = {
    themes: THEMES.slice(),
    getThemeId() {
      return document.documentElement.dataset.theme || initialThemeId;
    },
    getTheme() {
      return resolveTheme(this.getThemeId());
    },
    setTheme(themeId) {
      const theme = resolveTheme(themeId);
      syncThemeAttributes(theme.id);
      persistTheme(theme.id);
      emitTheme(theme);
      updateSwitcher(theme.id);
      return theme;
    }
  };

  function updateSwitcher(activeThemeId) {
    document.querySelectorAll('.theme-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.themeOption === activeThemeId);
    });
  }

  function bindSwitchers() {
    if (!document.body || document.body.dataset.themeSwitchersBound === '1') {
      return;
    }
    document.body.dataset.themeSwitchersBound = '1';
    document.addEventListener('click', event => {
      const chip = event.target.closest('.theme-chip[data-theme-option]');
      if (!chip) return;
      api.setTheme(chip.dataset.themeOption);
    });
  }

  window.CakeTheme = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      bindSwitchers();
      api.setTheme(api.getThemeId());
    }, { once: true });
  } else {
    bindSwitchers();
    api.setTheme(api.getThemeId());
  }
})();
