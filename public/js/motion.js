(function initMotion(global) {
  'use strict';

  const gsap = global.gsap;
  const CONFIG = Object.freeze({
    page: { out: 0.12, enter: 0.28, distance: 12, exitDistance: 6, stagger: 0.04, ease: 'power2.out' },
    panel: { enter: 0.24, out: 0.12, delay: 0.04, distance: 10, ease: 'power2.out' },
    indicator: { duration: 0.26, ease: 'power3.inOut' },
    list: { out: 0.10, enter: 0.22, stagger: 0.025, distance: 8, exitDistance: 4, ease: 'power2.out' },
    modal: { enter: 0.28, out: 0.18, backdrop: 0.18, distance: 16, exitDistance: 8, scale: 0.98, exitScale: 0.99, ease: 'power3.out' },
    hover: { duration: 0.18, distance: 2, ease: 'power2.out' },
    press: { down: 0.09, up: 0.16, scale: 0.97, ease: 'power2.out' },
    toast: { enter: 0.20, out: 0.15, hold: 3000, distance: 10, exitDistance: 8, ease: 'power2.out' },
    loading: { fade: 0.14, opacity: 0.55, spin: 0.8 },
    theme: { duration: 0.36, ease: 'power2.inOut' }
  });
  const jobs = new Map();
  const indicators = new Map();
  const spinners = new Map();
  const listSnapshots = new WeakMap();
  let reduced = global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let toastTimer;
  let pressed;
  const duration = (seconds) => reduced ? 0 : seconds;
  const clear = (nodes, props = 'opacity,visibility,transform,willChange') => {
    if (gsap && nodes.length !== 0) gsap.set(nodes, { clearProps: props });
  };

  function stop(owner) {
    jobs.get(owner)?.cancel();
  }

  // One owner has one transition. Replacing it always settles its old promise.
  function run(owner, build, cleanup = () => {}, fallback = () => {}) {
    stop(owner);
    if (!gsap) { fallback(); cleanup(); return Promise.resolve(true); }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (completed) => {
        if (settled) return;
        settled = true;
        cleanup();
        jobs.delete(owner);
        delete owner.dataset.motionState;
        resolve(completed);
      };
      const timeline = gsap.timeline({ paused: true, onComplete: () => settle(true) });
      jobs.set(owner, { timeline, cancel() { timeline.kill(); settle(false); } });
      owner.dataset.motionState = 'running';
      build(timeline);
      timeline.play();
    });
  }

  async function page(container, commit, isCurrent = () => true) {
    const hadView = !!container.dataset.view;
    stop(container);
    if (!isCurrent()) return false;
    const commitCurrent = () => {
      if (!isCurrent()) return false;
      commit();
      hydrate();
      return isCurrent();
    };
    if (!gsap || reduced) { return commitCurrent(); }
    if (hadView) {
      const completed = await run(container, (tl) => tl.to(container, {
        opacity: 0, y: -CONFIG.page.exitDistance, duration: CONFIG.page.out, ease: 'power1.in'
      }), () => clear(container));
      if (!completed || !isCurrent()) return false;
    }
    if (!commitCurrent()) return false;
    const sections = [...container.children].filter(node => !node.classList.contains('sr-only') && node.getClientRects().length);
    return run(container, (tl) => {
      tl.fromTo(sections, { opacity: 0, y: CONFIG.page.distance }, {
        opacity: 1, y: 0, duration: CONFIG.page.enter,
        stagger: CONFIG.page.stagger, ease: CONFIG.page.ease
      });
    }, () => clear(sections));
  }

  function syncIndicator(group, animate = true) {
    if (!group) return;
    const active = group.querySelector(':scope > button.active, :scope > a.active');
    if (!active || !group.getClientRects().length || !active.offsetWidth) return;
    let record = indicators.get(group);
    if (!record) {
      const marker = document.createElement('span');
      marker.className = 'motion-indicator';
      marker.setAttribute('aria-hidden', 'true');
      group.append(marker);
      group.classList.add('has-indicator');
      const observer = new ResizeObserver(() => {
        if (!indicators.get(group)?.tween) syncIndicator(group, false);
      });
      observer.observe(group);
      record = { marker, observer };
      indicators.set(group, record);
      animate = false;
    }
    const values = { x: active.offsetLeft, y: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight };
    if (!gsap) {
      Object.assign(record.marker.style, { left: values.x + 'px', top: values.y + 'px', width: values.width + 'px', height: values.height + 'px' });
      return;
    }
    if (!animate || reduced) {
      gsap.killTweensOf(record.marker);
      record.tween = null;
      gsap.set(record.marker, values);
    } else {
      record.tween = gsap.to(record.marker, {
        ...values, duration: CONFIG.indicator.duration, ease: CONFIG.indicator.ease, overwrite: true,
        onComplete: () => { record.tween = null; syncIndicator(group, false); }
      });
    }
  }

  function select(buttons, panels, index) {
    buttons = [...buttons];
    panels = [...panels];
    const next = panels[index];
    const parent = next?.parentElement;
    if (parent) stop(parent);
    const previous = panels.find(panel => panel.classList.contains('active'));
    const oldHeight = parent?.offsetHeight || 0;
    const direction = panels.indexOf(previous) > index ? -1 : 1;
    buttons.forEach((button, i) => {
      button.classList.toggle('active', i === index);
      button.setAttribute('aria-pressed', String(i === index));
    });
    syncIndicator(buttons[0]?.parentElement);
    panels.forEach((panel, i) => {
      panel.classList.toggle('active', i === index);
      panel.setAttribute('aria-hidden', String(i !== index));
      panel.inert = i !== index;
    });
    if (!next || next === previous || !gsap || reduced || !parent.getClientRects().length) { hydrate(); return; }
    const newHeight = next.offsetHeight;
    const cleanup = () => {
      clear(panels, 'opacity,visibility,transform,position,top,left,width,display,willChange');
      clear(parent, 'height,overflow');
      hydrate();
    };
    run(parent, (tl) => {
      gsap.set(parent, { height: oldHeight || newHeight, overflow: 'clip' });
      if (previous) {
        gsap.set(previous, { display: 'block', position: 'absolute', top: 0, left: 0, width: '100%' });
        tl.to(previous, { opacity: 0, x: -direction * CONFIG.panel.distance, duration: CONFIG.panel.out, ease: 'power1.in' }, 0);
      }
      tl.fromTo(next, { opacity: 0, x: direction * CONFIG.panel.distance }, {
        opacity: 1, x: 0, duration: CONFIG.panel.enter, ease: CONFIG.panel.ease
      }, CONFIG.panel.delay);
      const layout = { progress: 0 };
      tl.to(layout, {
        progress: 1, duration: CONFIG.panel.enter, ease: CONFIG.panel.ease,
        onUpdate: () => gsap.set(parent, { height: oldHeight + (next.offsetHeight - oldHeight) * layout.progress })
      }, 0);
    }, cleanup);
  }

  function loading(list, pagination, page) {
    if (!list) return;
    stop(list);
    list.setAttribute('aria-busy', 'true');
    list.inert = true;
    list.style.minHeight = list.offsetHeight + 'px';
    list.classList.add('list-loading');
    if (!list.children.length) list.innerHTML = '<div class="list-loader" role="status" aria-label="正在加载"><span class="loading"></span></div>';
    if (gsap && !reduced) gsap.to(list, { opacity: CONFIG.loading.opacity, duration: CONFIG.loading.fade, overwrite: 'auto' });
    if (pagination) {
      const lastPage = Math.max(...[...pagination.querySelectorAll('[data-page]')].map(button => Number(button.dataset.page)));
      pagination.querySelectorAll('button').forEach(button => {
        button.disabled = true;
        if (button.dataset.page) {
          const selected = Number(button.dataset.page) === page;
          button.dataset.distant = String(Number(button.dataset.page) !== 1 && Number(button.dataset.page) !== lastPage && Math.abs(Number(button.dataset.page) - page) >= 2);
          button.classList.toggle('active', selected);
          if (selected) button.setAttribute('aria-current', 'page');
          else button.removeAttribute('aria-current');
        }
      });
      syncIndicator(pagination);
    }
    hydrate();
  }

  function listContent(list, html) {
    if (!list) return;
    if (listSnapshots.get(list) === html && list.getAttribute('aria-busy') !== 'true') return;
    stop(list);
    gsap?.killTweensOf(list);
    const oldHeight = list.offsetHeight;
    const previousRows = [...list.querySelectorAll('.list-item')];
    let rows = [];
    const commit = () => {
      list.innerHTML = html;
      listSnapshots.set(list, html);
      list.style.minHeight = '';
      list.classList.remove('list-loading');
      list.removeAttribute('aria-busy');
      list.inert = false;
      rows = [...list.querySelectorAll('.list-item, .empty')];
      hydrate();
    };
    if (!gsap || reduced || !list.getClientRects().length) { commit(); clear(list); return; }
    run(list, (tl) => {
      if (previousRows.length) tl.to(previousRows, { opacity: 0, y: -CONFIG.list.exitDistance, duration: CONFIG.list.out, ease: 'power1.in' });
      tl.call(() => {
        commit();
        const newHeight = list.offsetHeight;
        gsap.set(list, { height: oldHeight || newHeight, opacity: 1, overflow: 'clip' });
        // Add after commit so API completion, empty states and pagination share this transition.
        tl.fromTo(rows, { opacity: 0, y: CONFIG.list.distance }, {
          opacity: 1, y: 0, duration: duration(CONFIG.list.enter),
          stagger: reduced ? 0 : CONFIG.list.stagger, ease: CONFIG.list.ease
        }, tl.time());
        tl.to(list, { height: newHeight, duration: duration(CONFIG.list.enter), ease: CONFIG.list.ease }, tl.time());
      });
    }, () => {
      clear(previousRows);
      clear(rows);
      clear(list, 'height,opacity,overflow');
    }, commit);
  }

  function pagination(container, html) {
    if (!container) return;
    const record = indicators.get(container);
    container.innerHTML = html;
    if (record && html) container.append(record.marker);
    if (!html && record) {
      record.observer.disconnect();
      gsap?.killTweensOf(record.marker);
      indicators.delete(container);
      container.classList.remove('has-indicator');
    }
    syncIndicator(container);
  }

  function reveal(element, animate = true) {
    if (!element) return;
    stop(element);
    const visible = element.classList.contains('show');
    element.classList.add('show');
    if (visible || !animate || !gsap || reduced) return;
    run(element, tl => tl.fromTo(element, { opacity: 0, y: CONFIG.page.distance }, {
      opacity: 1, y: 0, duration: CONFIG.page.enter, ease: CONFIG.page.ease
    }), () => clear(element));
  }

  function hide(element) {
    if (!element) return;
    const finish = () => element.classList.remove('show');
    if (!element.classList.contains('show') || !gsap || reduced) { stop(element); finish(); return; }
    run(element, tl => tl.to(element, { opacity: 0, y: -CONFIG.page.exitDistance, duration: CONFIG.page.out, ease: 'power1.in' }).call(finish), () => clear(element), finish);
  }

  function modal(overlay, open, onClosed = () => {}) {
    stop(overlay);
    const dialog = overlay.querySelector('.modal');
    const finish = () => { if (!open) onClosed(); };
    delete overlay.dataset.closing;
    if (!gsap || reduced) { finish(); return; }
    if (!open) overlay.dataset.closing = 'true';
    run(overlay, (tl) => {
      if (open) {
        tl.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: CONFIG.modal.backdrop }, 0);
        tl.fromTo(dialog, { opacity: 0, y: CONFIG.modal.distance, scale: CONFIG.modal.scale }, {
          opacity: 1, y: 0, scale: 1, duration: CONFIG.modal.enter, ease: CONFIG.modal.ease
        }, 0);
      } else {
        tl.to(dialog, { opacity: 0, y: CONFIG.modal.exitDistance, scale: CONFIG.modal.exitScale, duration: CONFIG.modal.out, ease: 'power2.in' }, 0);
        tl.to(overlay, { opacity: 0, duration: CONFIG.modal.out }, 0).call(finish);
      }
    }, () => { clear([overlay, dialog]); delete overlay.dataset.closing; }, finish);
    hydrate();
  }

  function toast(element) {
    clearTimeout(toastTimer);
    stop(element);
    element.classList.add('show');
    run(element, tl => tl.fromTo(element, { opacity: 0, y: CONFIG.toast.distance }, {
      opacity: 1, y: 0, duration: duration(CONFIG.toast.enter), ease: CONFIG.toast.ease
    }), () => clear(element));
    toastTimer = setTimeout(() => {
      run(element, tl => tl.to(element, { opacity: 0, y: CONFIG.toast.exitDistance, duration: duration(CONFIG.toast.out), ease: CONFIG.toast.ease })
        .call(() => element.classList.remove('show')), () => clear(element, 'opacity,visibility,transform,willChange'), () => element.classList.remove('show'));
    }, CONFIG.toast.hold);
  }

  function hydrate() {
    document.querySelectorAll('[data-motion-tabs], .pagination').forEach(group => {
      if (!indicators.has(group)) syncIndicator(group, false);
    });
    for (const [group, record] of indicators) {
      if (!group.isConnected) { record.observer.disconnect(); gsap?.killTweensOf(record.marker); indicators.delete(group); }
    }
    for (const [owner, job] of jobs) if (!owner.isConnected) job.cancel();
    if (!gsap) return;
    for (const [spinner, tween] of spinners) {
      if (!spinner.isConnected || reduced) { tween.kill(); clear(spinner); spinners.delete(spinner); }
    }
    if (!reduced) document.querySelectorAll('.loading').forEach(spinner => {
      if (!spinners.has(spinner)) spinners.set(spinner, gsap.to(spinner, { rotation: 360, duration: CONFIG.loading.spin, repeat: -1, ease: 'none' }));
    });
  }

  function install() {
    if (gsap) {
      const media = gsap.matchMedia();
      media.add({ all: '(min-width: 0px)', reduce: '(prefers-reduced-motion: reduce)' }, (context) => {
        reduced = context.conditions.reduce;
        document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
        if (reduced) {
          [...jobs.values()].forEach(job => job.timeline.totalProgress(1));
          document.querySelectorAll('button, .list-item, .url-option').forEach(node => {
            gsap.killTweensOf(node, 'scale,y,--hover');
            clear(node, 'opacity,visibility,transform,willChange,--hover');
          });
          indicators.forEach((record, group) => syncIndicator(group, false));
        }
        hydrate();
      });
    }
    const pressable = 'button, .btn-back, .sidebar-link, .shortcut-card, .file-picker, .theme-icon';
    const hoverable = '.list-item, .url-option, .shortcut-card';
    const finePointer = global.matchMedia('(hover: hover) and (pointer: fine)');
    const micro = (node, values, seconds) => {
      if (gsap && !reduced && node && (!node.disabled || values.scale === 1 || values['--hover'] === 0)) gsap.to(node, { ...values, duration: seconds, ease: CONFIG.press.ease, overwrite: 'auto' });
    };
    document.addEventListener('pointerover', event => {
      if (!finePointer.matches || event.pointerType === 'touch') return;
      const node = event.target.closest?.(hoverable);
      if (node && !node.contains(event.relatedTarget)) micro(node, { y: -CONFIG.hover.distance, '--hover': 1 }, CONFIG.hover.duration);
    });
    document.addEventListener('pointerout', event => {
      const node = event.target.closest?.(hoverable);
      if (node && !node.contains(event.relatedTarget)) micro(node, { y: 0, '--hover': 0 }, CONFIG.hover.duration);
    });
    const release = () => { micro(pressed, { scale: 1 }, CONFIG.press.up); pressed = null; };
    document.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      release();
      pressed = event.target.closest?.(pressable);
      micro(pressed, { scale: CONFIG.press.scale }, CONFIG.press.down);
    });
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    global.addEventListener('blur', release);
    document.addEventListener('keydown', event => {
      if (event.repeat || !['Enter', ' '].includes(event.key) || !event.target.matches('button, a.btn-back')) return;
      pressed = event.target;
      micro(pressed, { scale: CONFIG.press.scale }, CONFIG.press.down);
    });
    document.addEventListener('keyup', release);
    new MutationObserver(hydrate).observe(document.body, { childList: true, subtree: true });
    hydrate();
  }

  function theme(apply) {
    const root = document.documentElement, body = document.body;
    const names = ['--bg', '--card-bg', '--surface-alt', '--card-border', '--text', '--text-dim',
      '--accent-hover', '--accent-light', '--accent-text', '--danger', '--btn-text', '--glass-fill',
      '--glass-edge', '--glass-highlight', '--glass-sheen', '--control-fill', '--ambient-glow'];
    // GSAP parses percentage alpha as an unscaled number; normalize CSS Color 4 inputs.
    const colors = value => value.replace(/rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)%\s*\)/g,
      (_, r, g, b, alpha) => `rgba(${r},${g},${b},${Number(alpha) / 100})`);
    const read = () => Object.fromEntries(names.map(name => [name, colors(getComputedStyle(root).getPropertyValue(name).trim())]));
    const before = read(), background = getComputedStyle(body).backgroundImage;
    stop(root);
    apply();
    const after = read(), nextBackground = getComputedStyle(body).backgroundImage;
    const icon = document.querySelector('.theme-icon');
    return run(root, timeline => {
      timeline.fromTo(root, before, { ...after, duration: duration(CONFIG.theme.duration), ease: CONFIG.theme.ease }, 0);
      timeline.fromTo(body, { backgroundImage: background }, { backgroundImage: nextBackground,
        duration: duration(CONFIG.theme.duration), ease: CONFIG.theme.ease }, 0);
      if (icon && !reduced) timeline.fromTo(icon, { rotation: -35, scale: .85 },
        { rotation: 0, scale: 1, duration: CONFIG.theme.duration, ease: 'power2.out' }, 0);
    }, () => {
      names.forEach(name => root.style.removeProperty(name));
      body.style.removeProperty('background-image');
      if (icon) clear(icon);
    }, () => {});
  }

  global.MfuMotion = Object.freeze({ CONFIG, page, select, syncIndicator, loading, listContent, pagination, reveal, hide, modal, toast, hydrate, stop, theme });
  document.addEventListener('DOMContentLoaded', install, { once: true });
})(window);
