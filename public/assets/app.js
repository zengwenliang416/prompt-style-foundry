const PAGE_SIZE = 48;
const FAVORITES_KEY = "onepic-template-favorites-v1";

const state = {
  catalog: null,
  templates: [],
  filtered: [],
  visibleCount: PAGE_SIZE,
  search: "",
  category: "",
  mode: "",
  kind: "",
  favoritesOnly: false,
  favorites: new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]")),
  currentTemplate: null,
  currentPrompt: "",
};

const elements = {
  grid: document.querySelector("#template-grid"),
  summary: document.querySelector("#result-summary"),
  search: document.querySelector("#search-input"),
  category: document.querySelector("#category-filter"),
  mode: document.querySelector("#mode-filter"),
  kind: document.querySelector("#kind-filter"),
  favoritesFilter: document.querySelector("#favorites-filter"),
  clearFilters: document.querySelector("#clear-filters"),
  activeFilters: document.querySelector("#active-filters"),
  loadMore: document.querySelector("#load-more"),
  empty: document.querySelector("#empty-state"),
  dialog: document.querySelector("#template-dialog"),
  dialogPreview: document.querySelector("#dialog-preview"),
  dialogEyebrow: document.querySelector("#dialog-eyebrow"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogTags: document.querySelector("#dialog-tags"),
  dialogId: document.querySelector("#dialog-id"),
  dialogMode: document.querySelector("#dialog-mode"),
  dialogLanguage: document.querySelector("#dialog-language"),
  dialogSource: document.querySelector("#dialog-source"),
  dialogPrompt: document.querySelector("#dialog-prompt"),
  dialogFavorite: document.querySelector("#dialog-favorite"),
  copyPrompt: document.querySelector("#copy-prompt"),
  downloadPrompt: document.querySelector("#download-prompt"),
  toast: document.querySelector("#toast"),
};

const modeLabels = {
  "single-scene": "单幅场景",
  "multi-panel": "多面板",
  interface: "界面系统",
  infographic: "信息图",
  poster: "海报",
  product: "商品视觉",
  portrait: "人物角色",
  document: "文档出版",
  scene: "叙事场景",
};

const kindLabels = {
  framework: "框架模板",
  case: "案例蓝图",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function persistFavorites() {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites]));
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
}

function fillSelect(select, values, formatter = (value) => value) {
  const fragment = document.createDocumentFragment();
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = formatter(value);
    fragment.append(option);
  });
  select.append(fragment);
}

function normalizeSearch(value) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function templateSearchText(template) {
  return [
    template.id,
    template.title,
    template.category,
    template.mode,
    ...(template.styles || []),
    ...(template.scenes || []),
    ...(template.tags || []),
    template.source?.author || "",
  ]
    .join(" ")
    .toLocaleLowerCase("zh-CN");
}

function matchesFilters(template) {
  if (state.search && !templateSearchText(template).includes(state.search)) return false;
  if (state.category && template.category !== state.category) return false;
  if (state.mode && template.mode !== state.mode) return false;
  if (state.kind && template.kind !== state.kind) return false;
  if (state.favoritesOnly && !state.favorites.has(template.id)) return false;
  return true;
}

function sortTemplates(templates) {
  return [...templates].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "framework" ? -1 : 1;
    if (a.kind === "case") {
      const aId = Number(a.id.replace("case-", ""));
      const bId = Number(b.id.replace("case-", ""));
      return bId - aId;
    }
    return a.id.localeCompare(b.id, "zh-CN", { numeric: true });
  });
}

function makePreview(template, large = false) {
  if (template.preview) {
    return `<img src="${escapeHtml(template.preview)}" alt="${escapeHtml(template.title)}" loading="lazy" decoding="async" />${
      large ? "" : '<span class="preview-overlay"></span>'
    }`;
  }
  return `<div class="abstract-preview"><span>${escapeHtml(template.title.replace(" · ", "\n"))}</span></div>`;
}

function renderCard(template) {
  const favorite = state.favorites.has(template.id);
  const mode = modeLabels[template.mode] || template.mode;
  const sourceAuthor = template.source?.author ? ` · ${escapeHtml(template.source.author)}` : "";
  return `
    <article class="template-card" data-template-id="${escapeHtml(template.id)}">
      <button class="card-open" type="button" data-action="open" aria-label="打开 ${escapeHtml(template.title)}">
        <div class="card-preview">
          <span class="kind-badge">${kindLabels[template.kind] || template.kind}</span>
          ${makePreview(template)}
        </div>
        <div class="card-body">
          <p class="card-category">${escapeHtml(template.category)}</p>
          <h3 class="card-title">${escapeHtml(template.title)}</h3>
          <div class="card-meta">
            <span>${escapeHtml(mode)}</span>
            <span>${escapeHtml(template.id)}${sourceAuthor}</span>
          </div>
        </div>
      </button>
      <div class="card-actions">
        <button class="favorite-button" type="button" data-action="favorite" aria-pressed="${favorite}" aria-label="${
          favorite ? "取消收藏" : "收藏"
        }">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 20.5s-8-4.35-8-10.25A4.75 4.75 0 0 1 12 6.8a4.75 4.75 0 0 1 8 3.45c0 5.9-8 10.25-8 10.25Z" /></svg>
        </button>
        <button class="copy-card" type="button" data-action="copy">复制提示词</button>
      </div>
    </article>`;
}

function renderActiveFilters() {
  const chips = [];
  if (state.search) chips.push({ key: "search", label: `关键词：${elements.search.value.trim()}` });
  if (state.category) chips.push({ key: "category", label: state.category });
  if (state.mode) chips.push({ key: "mode", label: modeLabels[state.mode] || state.mode });
  if (state.kind) chips.push({ key: "kind", label: kindLabels[state.kind] || state.kind });
  if (state.favoritesOnly) chips.push({ key: "favorites", label: "仅收藏" });

  elements.activeFilters.innerHTML = chips
    .map(
      (chip) =>
        `<button class="filter-chip" type="button" data-filter-key="${escapeHtml(chip.key)}">${escapeHtml(chip.label)}</button>`,
    )
    .join("");
}

function render() {
  state.filtered = sortTemplates(state.templates.filter(matchesFilters));
  const visible = state.filtered.slice(0, state.visibleCount);

  elements.grid.innerHTML = visible.map(renderCard).join("");
  elements.grid.setAttribute("aria-busy", "false");
  elements.summary.textContent = `找到 ${state.filtered.length} 个模板 · 已显示 ${visible.length} 个`;
  elements.loadMore.hidden = visible.length >= state.filtered.length;
  elements.empty.hidden = state.filtered.length !== 0;
  elements.grid.hidden = state.filtered.length === 0;
  renderActiveFilters();
}

function resetVisibleCount() {
  state.visibleCount = PAGE_SIZE;
}

function clearFilters() {
  state.search = "";
  state.category = "";
  state.mode = "";
  state.kind = "";
  state.favoritesOnly = false;
  elements.search.value = "";
  elements.category.value = "";
  elements.mode.value = "";
  elements.kind.value = "";
  elements.favoritesFilter.setAttribute("aria-pressed", "false");
  resetVisibleCount();
  render();
}

function removeFilter(key) {
  if (key === "search") {
    state.search = "";
    elements.search.value = "";
  } else if (key === "category") {
    state.category = "";
    elements.category.value = "";
  } else if (key === "mode") {
    state.mode = "";
    elements.mode.value = "";
  } else if (key === "kind") {
    state.kind = "";
    elements.kind.value = "";
  } else if (key === "favorites") {
    state.favoritesOnly = false;
    elements.favoritesFilter.setAttribute("aria-pressed", "false");
  }
  resetVisibleCount();
  render();
}

function toggleFavorite(templateId) {
  if (state.favorites.has(templateId)) {
    state.favorites.delete(templateId);
    showToast("已取消收藏");
  } else {
    state.favorites.add(templateId);
    showToast("已加入收藏");
  }
  persistFavorites();
  render();
  if (state.currentTemplate?.id === templateId) updateDialogFavorite();
}

async function fetchPrompt(template) {
  const response = await fetch(template.promptPath);
  if (!response.ok) throw new Error(`Prompt request failed: ${response.status}`);
  return response.text();
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function copyTemplate(template) {
  try {
    const prompt = await fetchPrompt(template);
    await copyText(prompt);
    showToast(`已复制：${template.title}`);
  } catch (error) {
    console.error(error);
    showToast("复制失败，请打开详情后手动复制");
  }
}

function sourceMarkup(template) {
  const sourceUrl = template.source?.sourceUrl || template.source?.galleryUrl || template.source?.repository;
  const label = template.source?.author || (template.kind === "framework" ? "上游模板文档" : "上游案例");
  if (!sourceUrl) return escapeHtml(label);
  return `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function updateDialogFavorite() {
  const favorite = state.currentTemplate && state.favorites.has(state.currentTemplate.id);
  elements.dialogFavorite.textContent = favorite ? "取消收藏" : "收藏";
}

async function openDialog(template) {
  state.currentTemplate = template;
  state.currentPrompt = "";

  elements.dialogPreview.innerHTML = makePreview(template, true);
  elements.dialogEyebrow.textContent = `${kindLabels[template.kind] || template.kind} · ${template.category}`;
  elements.dialogTitle.textContent = template.title;
  elements.dialogTags.innerHTML = [...(template.styles || []), ...(template.scenes || []), modeLabels[template.mode] || template.mode]
    .filter(Boolean)
    .slice(0, 8)
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");
  elements.dialogId.textContent = template.id;
  elements.dialogMode.textContent = modeLabels[template.mode] || template.mode;
  elements.dialogLanguage.textContent = template.language === "zh" ? "中文优先" : "英文优先";
  elements.dialogSource.innerHTML = sourceMarkup(template);
  elements.dialogPrompt.textContent = "正在载入提示词…";
  updateDialogFavorite();

  if (!elements.dialog.open) elements.dialog.showModal();

  try {
    const prompt = await fetchPrompt(template);
    if (state.currentTemplate?.id !== template.id) return;
    state.currentPrompt = prompt;
    elements.dialogPrompt.textContent = prompt;
  } catch (error) {
    console.error(error);
    elements.dialogPrompt.textContent = "提示词载入失败。请确认项目正通过本地 HTTP 服务运行。";
  }
}

function closeDialog() {
  if (elements.dialog.open) elements.dialog.close();
  state.currentTemplate = null;
  state.currentPrompt = "";
}

function downloadCurrentPrompt() {
  if (!state.currentTemplate || !state.currentPrompt) return;
  const blob = new Blob([state.currentPrompt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.currentTemplate.id}-${state.currentTemplate.title.replace(/[\\/:*?"<>|]/g, "-")}.txt`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast("提示词 TXT 已生成");
}

function bindEvents() {
  let searchTimer;
  elements.search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.search = normalizeSearch(elements.search.value);
      resetVisibleCount();
      render();
    }, 160);
  });

  elements.category.addEventListener("change", () => {
    state.category = elements.category.value;
    resetVisibleCount();
    render();
  });

  elements.mode.addEventListener("change", () => {
    state.mode = elements.mode.value;
    resetVisibleCount();
    render();
  });

  elements.kind.addEventListener("change", () => {
    state.kind = elements.kind.value;
    resetVisibleCount();
    render();
  });

  elements.favoritesFilter.addEventListener("click", () => {
    state.favoritesOnly = !state.favoritesOnly;
    elements.favoritesFilter.setAttribute("aria-pressed", String(state.favoritesOnly));
    resetVisibleCount();
    render();
  });

  elements.clearFilters.addEventListener("click", clearFilters);
  elements.empty.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="clear"]')) clearFilters();
  });

  elements.activeFilters.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-filter-key]");
    if (chip) removeFilter(chip.dataset.filterKey);
  });

  elements.loadMore.addEventListener("click", () => {
    state.visibleCount += PAGE_SIZE;
    render();
  });

  elements.grid.addEventListener("click", (event) => {
    const card = event.target.closest("[data-template-id]");
    if (!card) return;
    const template = state.templates.find((item) => item.id === card.dataset.templateId);
    if (!template) return;

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "favorite") toggleFavorite(template.id);
    if (action === "copy") copyTemplate(template);
    if (action === "open") openDialog(template);
  });

  elements.dialog.addEventListener("click", (event) => {
    if (event.target === elements.dialog) closeDialog();
    if (event.target.closest('[data-action="close-dialog"]')) closeDialog();
  });

  elements.dialog.addEventListener("close", () => {
    state.currentTemplate = null;
    state.currentPrompt = "";
  });

  elements.dialogFavorite.addEventListener("click", () => {
    if (state.currentTemplate) toggleFavorite(state.currentTemplate.id);
  });

  elements.copyPrompt.addEventListener("click", async () => {
    if (!state.currentPrompt) return;
    try {
      await copyText(state.currentPrompt);
      showToast("完整提示词已复制");
    } catch (error) {
      console.error(error);
      showToast("复制失败，请手动选择文本");
    }
  });

  elements.downloadPrompt.addEventListener("click", downloadCurrentPrompt);
}

async function init() {
  bindEvents();
  try {
    const response = await fetch("data/catalog.json");
    if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
    state.catalog = await response.json();
    state.templates = state.catalog.templates;

    document.querySelector("#metric-total").textContent = state.catalog.stats.total;
    document.querySelector("#metric-cases").textContent = state.catalog.stats.cases;
    document.querySelector("#metric-frameworks").textContent = state.catalog.stats.frameworks;

    fillSelect(elements.category, state.catalog.filters.categories);
    fillSelect(elements.mode, state.catalog.filters.modes, (value) => modeLabels[value] || value);
    render();
  } catch (error) {
    console.error(error);
    elements.grid.setAttribute("aria-busy", "false");
    elements.grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1">
        <strong>模板库载入失败</strong>
        <p>请通过 HTTP 服务打开项目，例如运行 <code>npm run dev</code>。</p>
      </div>`;
    elements.summary.textContent = "载入失败";
  }
}

init();
