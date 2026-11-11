/*
 * Рендерер виджетов сцены. Используется панелью и оверлеем через SceneView.
 * Координаты нормализованы (0..1); размеры шрифтов считаются от высоты сцены,
 * поэтому виджет одинаково выглядит при любом разрешении.
 */

export const WIDGET_TYPES = ['clock', 'timer', 'counter', 'progress', 'goal', 'random', 'leaderboard'];

export const WIDGET_META = {
  clock: { label: 'Часы', icon: '🕐', w: 0.24, h: 0.13 },
  timer: { label: 'Таймер', icon: '⏱', w: 0.24, h: 0.17 },
  counter: { label: 'Счётчик', icon: '🔢', w: 0.2, h: 0.17 },
  progress: { label: 'Прогресс', icon: '📊', w: 0.34, h: 0.12 },
  goal: { label: 'Цель сбора', icon: '🎯', w: 0.36, h: 0.15 },
  random: { label: 'Случайный выбор', icon: '🎲', w: 0.3, h: 0.17 },
  leaderboard: { label: 'Таблица лидеров', icon: '🏆', w: 0.3, h: 0.32 },
};

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtClock(date, format24, seconds) {
  let h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  let suffix = '';
  if (!format24) {
    suffix = h >= 12 ? ' PM' : ' AM';
    h = h % 12 || 12;
  }
  const hh = format24 ? String(h).padStart(2, '0') : String(h);
  return `${hh}:${m}${seconds ? `:${s}` : ''}${suffix}`;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function fmtDate(date) {
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** Секунды таймера: обратный отсчёт от endsAt или накопленное время секундомера. */
export function timerRemaining(data, now = Date.now()) {
  if (data.mode === 'stopwatch') {
    const base = Number(data.accumulated) || 0;
    return data.running ? base + Math.max(0, (now - (Number(data.startedAt) || now)) / 1000) : base;
  }
  if (data.running && Number(data.endsAt) > 0) {
    return Math.max(0, ((Number(data.endsAt) || now) - now) / 1000);
  }
  return Math.max(0, Number(data.remaining) || 0);
}

function widgetLabel(widget) {
  const d = widget.data || {};
  return d.label || d.title || WIDGET_META[widget.type]?.label || 'Виджет';
}

function bar(pct, color) {
  const p = Math.max(0, Math.min(100, pct));
  return `<div class="widget-bar"><i style="width:${p}%;background:${esc(color)}"></i></div>`;
}

function bodyHtml(widget, ph) {
  const d = widget.data || {};
  const color = widget.color || '#7c6eff';
  switch (widget.type) {
    case 'clock': {
      const now = new Date();
      const time = fmtClock(now, d.format24 !== false, d.seconds === true);
      const date = d.date === true ? `<div class="widget-sub widget-clock-date">${esc(fmtDate(now))}</div>` : '';
      return `<div class="widget-big widget-clock-time" style="font-size:${ph * 0.4}px">${esc(time)}</div>${date}`;
    }
    case 'timer': {
      const secs = timerRemaining(d);
      const done = d.mode !== 'stopwatch' && d.running !== true && secs <= 0 && Number(d.endsAt) === 0 && Number(d.remaining) === 0;
      const cls = done ? 'widget-big widget-timer-time done' : 'widget-big widget-timer-time';
      const dot = d.running ? '<span class="widget-run-dot"></span>' : '';
      return `<div class="${cls}" style="font-size:${ph * 0.38}px">${esc(fmtDuration(secs))}${dot}</div>
        <div class="widget-sub">${esc(d.label || 'Таймер')}</div>`;
    }
    case 'counter':
      return `<div class="widget-big widget-counter-value" style="font-size:${ph * 0.42}px;color:${esc(color)}">${esc(String(d.value ?? 0))}</div>
        <div class="widget-sub">${esc(d.label || 'Счётчик')}</div>`;
    case 'progress': {
      const max = Number(d.max) || 100;
      const value = Number(d.value) || 0;
      const pct = Math.round((value / max) * 100);
      return `<div class="widget-sub row-between"><span>${esc(d.label || 'Прогресс')}</span><b>${pct}%</b></div>
        ${bar((value / max) * 100, color)}`;
    }
    case 'goal': {
      const target = Number(d.target) || 1000;
      const current = Number(d.current) || 0;
      const pct = Math.round((current / target) * 100);
      const cur = `${esc(d.currency || '₽')}`;
      return `<div class="widget-sub row-between"><span>${esc(d.label || 'Цель сбора')}</span><b>${pct}%</b></div>
        ${bar((current / target) * 100, color)}
        <div class="widget-sub widget-goal-nums">${esc(String(current))} / ${esc(String(target))} ${cur}</div>`;
    }
    case 'random': {
      const items = Array.isArray(d.items) ? d.items : [];
      const result = d.result ? esc(d.result) : '—';
      return `<div class="widget-big widget-random-result" style="font-size:${ph * 0.3}px">${result}</div>
        <div class="widget-sub">${items.length} вариант${plural(items.length)}</div>`;
    }
    case 'leaderboard': {
      const entries = Array.isArray(d.entries) ? d.entries.slice(0, 8) : [];
      if (!entries.length) return '<div class="widget-sub widget-empty">Пока пусто</div>';
      const rows = entries
        .map((e, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
          return `<li><span class="lb-rank">${medal}</span><span class="lb-name">${esc(e.name)}</span><b class="lb-score" style="color:${esc(color)}">${esc(String(e.score))}</b></li>`;
        })
        .join('');
      return `<ol class="widget-leaders" style="font-size:${Math.max(10, ph * 0.11)}px">${rows}</ol>`;
    }
    default:
      return '';
  }
}

function plural(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'ов';
  if (b > 1 && b < 5) return 'а';
  if (b === 1) return '';
  return 'ов';
}

export function applyWidgetStyle(node, widget, sceneHeight) {
  node.style.left = `${widget.x * 100}%`;
  node.style.top = `${widget.y * 100}%`;
  node.style.width = `${widget.w * 100}%`;
  node.style.height = `${widget.h * 100}%`;
  node.style.opacity = String(widget.opacity ?? 1);
  node.style.display = widget.hidden ? 'none' : '';
  const card = node.firstElementChild;
  if (card) {
    card.style.background = widget.bg || 'rgba(12,15,22,0.82)';
    card.style.setProperty('--waccent', widget.color || '#7c6eff');
  }
}

/** Полная перерисовка карточки (стиль + содержимое). */
export function renderWidget(node, widget, sceneHeight) {
  applyWidgetStyle(node, widget, sceneHeight);
  const ph = Math.max(24, (widget.h || 0.16) * (sceneHeight || 360));
  const meta = WIDGET_META[widget.type] || WIDGET_META.clock;
  const card = node.firstElementChild;
  card.style.fontSize = `${Math.max(9, ph * 0.12)}px`;
  card.innerHTML = `
    <div class="widget-head">
      <span class="widget-icon">${meta.icon}</span>
      <span class="widget-label">${esc(widgetLabel(widget))}</span>
    </div>
    <div class="widget-body">${bodyHtml(widget, ph)}</div>`;
}

export function buildWidgetEl(widget, sceneHeight) {
  const node = document.createElement('div');
  node.className = 'scene-widget';
  node.dataset.widgetId = widget.id;
  const card = document.createElement('div');
  card.className = 'widget-card';
  node.append(card);
  renderWidget(node, widget, sceneHeight);
  return node;
}

/** Лёгкое обновление только времени (часы/таймер) без пересборки DOM. */
export function tickWidget(node, widget) {
  const d = widget.data || {};
  if (widget.type === 'clock') {
    const timeEl = node.querySelector('.widget-clock-time');
    if (timeEl) timeEl.textContent = fmtClock(new Date(), d.format24 !== false, d.seconds === true);
    const dateEl = node.querySelector('.widget-clock-date');
    if (dateEl) dateEl.textContent = fmtDate(new Date());
  } else if (widget.type === 'timer') {
    const timeEl = node.querySelector('.widget-timer-time');
    if (timeEl) {
      const dot = timeEl.querySelector('.widget-run-dot');
      timeEl.textContent = fmtDuration(timerRemaining(d));
      if (d.running && dot) timeEl.append(dot);
      else if (d.running && !dot) {
        const span = document.createElement('span');
        span.className = 'widget-run-dot';
        timeEl.append(span);
      }
    }
  }
}