/**
 * fx.js — anime.js 动效层
 * 所有入口都检查 prefers-reduced-motion，命中时直接呈现终态。
 * 只动画 transform / opacity / stroke-dashoffset，避免布局抖动。
 */
import { animate, createTimeline, stagger, svg } from "./vendor/anime.esm.min.js";

export const THEME_KEY = "onepic-theme-v1";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
export const motionOK = () => !reducedMotion.matches;

if (!motionOK()) {
  document.documentElement.classList.add("no-motion");
}

/* ---------- 主题 ---------- */

export function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setupThemeToggle(button, scanEl) {
  if (!button) return;
  button.setAttribute("aria-pressed", String(currentTheme() === "light"));

  button.addEventListener("click", () => {
    const next = currentTheme() === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    button.setAttribute("aria-pressed", String(next === "light"));
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", next === "light" ? "#f3f3f0" : "#0e1013");
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (error) {
      /* localStorage 不可用时静默忽略 */
    }
    if (!motionOK()) return;
    animate(button, { rotate: ["0turn", "0.5turn"], duration: 600, ease: "outExpo" });
    if (scanEl) {
      animate(scanEl, {
        translateX: ["-100%", "100%"],
        opacity: [0, 1, 1, 0],
        duration: 900,
        ease: "inOutQuart",
      });
    }
  });
}

/* ---------- Hero 入场编排 ---------- */

function splitHeroTitle(titleEl) {
  const nodes = [...titleEl.childNodes];
  titleEl.textContent = "";
  nodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      [...node.textContent].forEach((char) => {
        const span = document.createElement("span");
        span.className = "word";
        span.textContent = char;
        titleEl.append(span);
      });
    } else {
      titleEl.append(node);
    }
  });
  return titleEl.querySelectorAll(".word");
}

export function heroIntro() {
  const hero = document.querySelector(".hero");
  if (!hero) return;
  if (!motionOK()) {
    document.documentElement.classList.add("no-motion");
    return;
  }

  const title = hero.querySelector("#hero-title");
  const words = title ? splitHeroTitle(title) : [];
  const blueprint = hero.querySelector(".hero-blueprint");

  const timeline = createTimeline({ defaults: { ease: "outExpo" } });

  if (blueprint) {
    const drawables = svg.createDrawable(blueprint.querySelectorAll(".bp-line, .bp-circle"));
    timeline.add(
      drawables,
      { draw: ["0 0", "0 1"], duration: 1600, delay: stagger(70) },
      0,
    );
  }
  if (words.length) {
    timeline.add(
      words,
      { translateY: ["1.2em", 0], opacity: [0, 1], duration: 700, delay: stagger(28) },
      blueprint ? 250 : 0,
    );
  }
  timeline.add(
    hero.querySelectorAll(".eyebrow, .hero-description"),
    { translateY: [18, 0], opacity: [0, 1], duration: 650, delay: stagger(90) },
    420,
  );
  timeline.add(
    hero.querySelectorAll(".hero-actions .button"),
    { translateY: [16, 0], opacity: [0, 1], duration: 550, delay: stagger(80) },
    640,
  );
  timeline.add(
    hero.querySelectorAll(".paper-card, .metric-card"),
    { translateY: [26, 0], opacity: [0, 1], duration: 750, delay: stagger(90) },
    520,
  );

  /* 轻微滚动视差 */
  let ticking = false;
  window.addEventListener(
    "scroll",
    () => {
      if (ticking || !blueprint) return;
      ticking = true;
      requestAnimationFrame(() => {
        blueprint.style.transform = `translateY(${window.scrollY * 0.12}px)`;
        ticking = false;
      });
    },
    { passive: true },
  );
}

/* ---------- 滚动进场 ---------- */

export function observeReveals() {
  const targets = document.querySelectorAll("[data-reveal]");
  if (!targets.length) return;
  if (!motionOK()) {
    targets.forEach((el) => {
      el.style.opacity = "1";
    });
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        animate(entry.target, {
          translateY: [34, 0],
          opacity: [0, 1],
          duration: 850,
          ease: "outExpo",
        });
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  targets.forEach((el) => observer.observe(el));
}

/* ---------- 卡片网格 ---------- */

export function cardsIn(grid, onlyIds = null) {
  if (!grid || !motionOK()) return;
  let cards = grid.querySelectorAll(".template-card");
  if (onlyIds) {
    cards = [...cards].filter((card) => onlyIds.has(card.dataset.templateId));
  }
  if (!cards.length) return;
  animate(cards, {
    translateY: [22, 0],
    opacity: [0, 1],
    duration: 520,
    delay: stagger(26, { from: "first" }),
    ease: "outCubic",
  });
}

/* ---------- 滚动进度发丝线 ---------- */

export function setupScrollProgress(bar) {
  if (!bar) return;
  let ticking = false;
  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = max > 0 ? `${(window.scrollY / max) * 100}%` : "0";
    ticking = false;
  };
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    },
    { passive: true },
  );
  window.addEventListener("resize", update, { passive: true });
  update();
}

/* ---------- 指标数字 ---------- */

export function countUp(el, value) {
  if (!el) return;
  const target = Number(value) || 0;
  if (!motionOK() || target <= 0) {
    el.textContent = String(target);
    return;
  }
  const counter = { value: 0 };
  animate(counter, {
    value: target,
    duration: 1400,
    ease: "outExpo",
    round: 1,
    onUpdate: () => {
      el.textContent = String(counter.value);
    },
  });
}

/* ---------- Dialog ---------- */

export function dialogIn(dialog) {
  if (!dialog || !motionOK()) return;
  const shell = dialog.querySelector(".dialog-shell");
  if (!shell) return;
  animate(shell, {
    translateY: [26, 0],
    opacity: [0, 1],
    clipPath: ["inset(6% 4% 6% 4%)", "inset(0% 0% 0% 0%)"],
    duration: 480,
    ease: "outExpo",
  });
}
