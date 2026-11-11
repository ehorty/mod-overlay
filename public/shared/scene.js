/*
 * Общий рендерер сцены: используется и в оверлее (OBS), и в панели модератора.
 * Все координаты нормализованы (0..1), поэтому сцена одинаково выглядит
 * при любом разрешении.
 */

import { applyWidgetStyle, buildWidgetEl, renderWidget, tickWidget } from './widgets.js';

const MARKER_ALPHA = 0.32;

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.append(node);
  return node;
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

export class SceneView {
  constructor(root, options = {}) {
    this.root = root;
    this.options = options;
    this.state = { revision: 0, strokes: [], media: [], texts: [], widgets: [] };
    this.mediaEls = new Map();
    this.textEls = new Map();
    this.widgetEls = new Map();
    this.drawn = new Map();
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.redrawQueued = false;
    this.build();
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(root);
    this.layout();
    this.ticker = setInterval(() => this.tickWidgets(), 250);
  }

  build() {
    this.root.classList.add('scene-root');
    this.root.replaceChildren();
    this.mediaLayer = el('div', 'scene-layer scene-media', this.root);
    this.textLayer = el('div', 'scene-layer scene-texts', this.root);
    this.widgetLayer = el('div', 'scene-layer scene-widgets', this.root);
    this.canvas = el('canvas', 'scene-layer scene-canvas', this.root);
    this.ctx = this.canvas.getContext('2d');
    this.fxLayer = el('div', 'scene-layer scene-fx', this.root);
  }

  notify() {
    if (this.options.onChange) this.options.onChange(this);
  }

  /* ------------------------------ layout ------------------------------- */

  layout() {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (!w || !h) return;
    this.width = w;
    this.height = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.redrawAll();
    this.layoutTexts();
    this.layoutWidgets();
  }

  layoutTexts() {
    for (const item of this.state.texts) {
      const node = this.textEls.get(item.id);
      if (node) this.applyTextStyle(node, item);
    }
  }

  layoutWidgets() {
    for (const item of this.state.widgets) {
      const node = this.widgetEls.get(item.id);
      if (node) renderWidget(node, item, this.height);
    }
  }

  tickWidgets() {
    for (const item of this.state.widgets) {
      if (item.type !== 'clock' && item.type !== 'timer') continue;
      if (item.hidden) continue;
      const node = this.widgetEls.get(item.id);
      if (node) tickWidget(node, item);
    }
  }

  /* ------------------------------- state ------------------------------- */

  setState(state) {
    const source = state ?? { strokes: [], media: [], texts: [], widgets: [] };
    this.state = {
      revision: source.revision ?? 0,
      strokes: copy(source.strokes ?? []),
      media: copy(source.media ?? []),
      texts: copy(source.texts ?? []),
      widgets: copy(source.widgets ?? []),
    };
    this.drawn.clear();
    for (const node of this.mediaEls.values()) node.remove();
    for (const node of this.textEls.values()) node.remove();
    for (const node of this.widgetEls.values()) node.remove();
    this.mediaEls.clear();
    this.textEls.clear();
    this.widgetEls.clear();

    for (const item of this.state.media) this.addMediaEl(item);
    for (const item of this.state.texts) this.addTextEl(item);
    for (const item of this.state.widgets) this.addWidgetEl(item);
    this.redrawAll();
    this.layoutTexts();
    this.notify();
  }

  /* ------------------------------- strokes ------------------------------ */

  beginStyle(stroke) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.globalAlpha = stroke.tool === 'marker' ? MARKER_ALPHA : 1;
    ctx.strokeStyle = stroke.tool === 'eraser' ? '#000000' : stroke.color;
    const factor = stroke.tool === 'marker' ? 2.6 : stroke.tool === 'eraser' ? 1.4 : 1;
    ctx.lineWidth = Math.max(1, stroke.size * this.height * factor);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  endStyle() {
    this.ctx.restore();
  }

  drawWholeStroke(stroke) {
    if (!this.width || !stroke.points.length) return;
    const ctx = this.ctx;
    const pts = stroke.points;
    this.beginStyle(stroke);
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * this.width, pts[0][1] * this.height);
    if (pts.length === 1) {
      ctx.lineTo(pts[0][0] * this.width + 0.01, pts[0][1] * this.height);
    } else {
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i][0] * this.width, pts[i][1] * this.height);
      }
    }
    ctx.stroke();
    this.endStyle();
    this.drawn.set(stroke.id, pts.length);
  }

  redrawAll() {
    if (!this.width) return;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.width, this.height);
    for (const stroke of this.state.strokes) this.drawWholeStroke(stroke);
  }

  scheduleRedraw() {
    if (this.redrawQueued) return;
    this.redrawQueued = true;
    requestAnimationFrame(() => {
      this.redrawQueued = false;
      this.redrawAll();
    });
  }

  startStroke(stroke) {
    const existing = this.state.strokes.findIndex((s) => s.id === stroke.id);
    if (existing >= 0) this.state.strokes.splice(existing, 1);
    this.state.strokes.push(stroke);
    this.drawWholeStroke(stroke);
    this.notify();
  }

  addPoints(id, points) {
    if (!points || !points.length) return;
    const stroke = this.state.strokes.find((s) => s.id === id);
    if (!stroke) return;
    stroke.points.push(...points);
    if (stroke.tool === 'marker') {
      this.scheduleRedraw();
      return;
    }
    const drawn = this.drawn.get(id) ?? stroke.points.length - points.length;
    const pts = stroke.points;
    const from = Math.max(0, drawn - 1);
    this.beginStyle(stroke);
    this.ctx.beginPath();
    this.ctx.moveTo(pts[from][0] * this.width, pts[from][1] * this.height);
    if (from === pts.length - 1) {
      this.ctx.lineTo(pts[from][0] * this.width + 0.01, pts[from][1] * this.height);
    } else {
      for (let i = from + 1; i < pts.length; i++) {
        this.ctx.lineTo(pts[i][0] * this.width, pts[i][1] * this.height);
      }
    }
    this.ctx.stroke();
    this.endStyle();
    this.drawn.set(id, pts.length);
  }

  removeStroke(id) {
    const before = this.state.strokes.length;
    this.state.strokes = this.state.strokes.filter((s) => s.id !== id);
    if (this.state.strokes.length === before) return;
    this.drawn.delete(id);
    this.redrawAll();
    this.notify();
  }

  clearStrokes() {
    this.state.strokes = [];
    this.drawn.clear();
    this.redrawAll();
    this.notify();
  }

  /* -------------------------------- media ------------------------------- */

  addMediaEl(item) {
    const node = document.createElement(item.kind === 'video' ? 'video' : 'img');
    node.className = 'scene-media-item';
    node.dataset.mediaId = item.id;
    node.draggable = false;
    if (item.kind === 'video') {
      node.autoplay = true;
      node.loop = true;
      node.muted = true;
      node.playsInline = true;
    } else {
      node.alt = '';
      node.decoding = 'async';
    }
    node.src = item.url;
    this.applyMediaStyle(node, item);
    this.mediaLayer.append(node);
    this.mediaEls.set(item.id, node);
    if (item.kind === 'video') node.play?.().catch(() => {});
  }

  applyMediaStyle(node, item) {
    node.style.left = `${item.x * 100}%`;
    node.style.top = `${item.y * 100}%`;
    node.style.width = `${item.w * 100}%`;
    node.style.height = `${item.h * 100}%`;
    node.style.opacity = String(item.opacity);
    node.style.transform = `rotate(${item.rotation}deg)`;
    node.style.objectFit = item.fit;
    node.style.display = item.hidden ? 'none' : '';
  }

  upsertMedia(item) {
    const node = this.mediaEls.get(item.id);
    if (node) {
      this.applyMediaStyle(node, item);
      if (node.getAttribute('src') !== item.url) node.src = item.url;
    } else {
      this.addMediaEl(item);
    }
    const index = this.state.media.findIndex((m) => m.id === item.id);
    if (index >= 0) this.state.media[index] = item;
    else this.state.media.push(item);
    this.notify();
  }

  removeMedia(id) {
    const node = this.mediaEls.get(id);
    if (node) node.remove();
    this.mediaEls.delete(id);
    this.state.media = this.state.media.filter((m) => m.id !== id);
    this.notify();
  }

  /* -------------------------------- texts ------------------------------- */

  addTextEl(item) {
    const node = el('div', 'scene-text', this.textLayer);
    node.dataset.textId = item.id;
    this.applyTextStyle(node, item);
    this.textEls.set(item.id, node);
  }

  applyTextStyle(node, item) {
    node.textContent = item.text;
    node.style.left = `${item.x * 100}%`;
    node.style.top = `${item.y * 100}%`;
    node.style.color = item.color;
    node.style.background = item.bg || 'transparent';
    node.style.opacity = String(item.opacity);
    node.style.textAlign = item.align;
    node.style.fontWeight = item.bold ? '800' : '600';
    node.style.display = item.hidden ? 'none' : '';
    node.classList.toggle('has-bg', Boolean(item.bg));
    node.classList.toggle('outlined', item.outline !== false);
    const px = this.height ? Math.round(item.size * this.height) : 24;
    node.style.fontSize = `${px}px`;
  }

  upsertText(item) {
    const node = this.textEls.get(item.id);
    if (node) this.applyTextStyle(node, item);
    else this.addTextEl(item);
    const index = this.state.texts.findIndex((t) => t.id === item.id);
    if (index >= 0) this.state.texts[index] = item;
    else this.state.texts.push(item);
    this.notify();
  }

  removeText(id) {
    const node = this.textEls.get(id);
    if (node) node.remove();
    this.textEls.delete(id);
    this.state.texts = this.state.texts.filter((t) => t.id !== id);
    this.notify();
  }

  /* ------------------------------- widgets ------------------------------ */

  addWidgetEl(item) {
    const node = buildWidgetEl(item, this.height);
    this.widgetLayer.append(node);
    this.widgetEls.set(item.id, node);
  }

  upsertWidget(item) {
    const node = this.widgetEls.get(item.id);
    if (node) renderWidget(node, item, this.height);
    else this.addWidgetEl(item);
    const index = this.state.widgets.findIndex((w) => w.id === item.id);
    if (index >= 0) this.state.widgets[index] = item;
    else this.state.widgets.push(item);
    this.notify();
  }

  removeWidget(id) {
    const node = this.widgetEls.get(id);
    if (node) node.remove();
    this.widgetEls.delete(id);
    this.state.widgets = this.state.widgets.filter((w) => w.id !== id);
    this.notify();
  }

  /* ------------------------------- helpers ------------------------------ */

  updateItemLocal(kind, id, patch) {
    const list = kind === 'media' ? this.state.media : kind === 'widget' ? this.state.widgets : this.state.texts;
    const item = list.find((x) => x.id === id);
    if (!item) return;
    Object.assign(item, patch);
    if (kind === 'media') {
      const node = this.mediaEls.get(id);
      if (node) this.applyMediaStyle(node, item);
    } else if (kind === 'widget') {
      const node = this.widgetEls.get(id);
      if (node) {
        if ('data' in patch || 'color' in patch || 'bg' in patch || 'type' in patch) renderWidget(node, item, this.height);
        else applyWidgetStyle(node, item, this.height);
      }
    } else {
      const node = this.textEls.get(id);
      if (node) this.applyTextStyle(node, item);
    }
  }

  getItem(kind, id) {
    const list = kind === 'media' ? this.state.media : kind === 'widget' ? this.state.widgets : this.state.texts;
    return list.find((x) => x.id === id) ?? null;
  }

  mediaEl(id) {
    return this.mediaEls.get(id) ?? null;
  }

  textEl(id) {
    return this.textEls.get(id) ?? null;
  }

  widgetEl(id) {
    return this.widgetEls.get(id) ?? null;
  }

  itemEl(kind, id) {
    return kind === 'media' ? this.mediaEl(id) : kind === 'widget' ? this.widgetEl(id) : this.textEl(id);
  }

  clearAll() {
    this.state.strokes = [];
    this.state.media = [];
    this.state.texts = [];
    this.state.widgets = [];
    this.drawn.clear();
    for (const node of this.mediaEls.values()) node.remove();
    for (const node of this.textEls.values()) node.remove();
    for (const node of this.widgetEls.values()) node.remove();
    this.mediaEls.clear();
    this.textEls.clear();
    this.widgetEls.clear();
    this.redrawAll();
    this.notify();
  }
}
