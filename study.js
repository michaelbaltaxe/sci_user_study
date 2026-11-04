/* Driving video study: consent, instructions, a few scene pages with synced videos and 1-5 ratings,
   then submit. Plain browser JavaScript with no build step. Answers go to STUDY_CONFIG.endpoint (the
   Apps Script web app) or, when it is empty, to the local test server at /api/submit.
   URL options: ?block=N forces block N for a new participant, ?reset=1 starts over as a new
   participant, ?pilot=1 marks the answers as pilot answers. */
(function () {
  'use strict';

  const CONFIG = Object.assign({ endpoint: '' }, window.STUDY_CONFIG || {});
  const STORE = 'driving_video_study_v1';
  // Same columns, in the same order, as apps_script.gs and serve_local.py.
  const COLUMNS = ['received', 'participant', 'block', 'pilot', 'clip', 'page', 'position', 'video', 'question',
    'score', 'clip_seconds', 'total_seconds', 'viewport', 'version', 'started', 'finished'];
  const QUESTIONS = [
    { key: 'collision', label: 'Collision', text: 'A new car follows the planned path and collides with the other car.' },
    { key: 'physics', label: 'Physics', text: 'After the collision, the other car moves as it would in a real crash.' },
    { key: 'realism', label: 'Realism', text: 'The video looks real, and the rest of the scene matches the original.' },
  ];
  const LETTERS = 'ABCDEFGHIJKL';
  const params = new URLSearchParams(location.search);
  const app = document.getElementById('app');
  let manifest = null;
  let state = null;
  let group = null;
  let modalGroup = null;

  // ---------------------------------------------------------------- helpers

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function rand(n) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  }

  function shuffle(xs) {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function randomId(prefix) {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return prefix + Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)); } catch (e) { return null; }
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* no storage: keep going in memory */ }
  }

  async function fetchJson(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, Object.assign({ signal: ctrl.signal }, options));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const submitUrl = () => CONFIG.endpoint || '/api/submit';
  const countsUrl = () => CONFIG.endpoint
    ? CONFIG.endpoint + (CONFIG.endpoint.includes('?') ? '&' : '?') + 'action=counts'
    : '/api/counts';

  const currentCid = () => state.clips[state.index];
  const currentPage = () => state.pages[currentCid()];

  // ---------------------------------------------------------------- state

  async function chooseBlock() {
    const n = manifest.blocks.length;
    const forced = parseInt(params.get('block'), 10);
    if (forced >= 1 && forced <= n) return forced;
    let counts = {};
    try {
      counts = (await fetchJson(countsUrl(), { cache: 'no-store' }, 5000)).counts || {};
    } catch (e) { /* no counts: every block is equally likely */ }
    const used = Array.from({ length: n }, (_, i) => Number(counts[i + 1] || 0));
    const least = Math.min(...used);
    const options = used.map((u, i) => (u === least ? i + 1 : 0)).filter(Boolean);
    return options[rand(options.length)];
  }

  async function newState() {
    const block = await chooseBlock();
    const clips = shuffle(manifest.blocks[block - 1]);
    const attention = clips[rand(clips.length)];
    const pages = {};
    for (const cid of clips) {
      const c = manifest.clips[cid];
      const ids = cid === attention ? [...c.candidates, c.extra] : c.candidates.slice();
      pages[cid] = { order: shuffle(ids), ratings: {}, shownAt: null, seconds: null };
    }
    return {
      version: manifest.version, participant: randomId('p'), block, pilot: params.get('pilot') === '1',
      clips, pages, step: 'consent', index: 0, slow: false, started: null, finished: null,
      submitted: false, payload: null,
    };
  }

  function remaining(page) {
    let n = 0;
    for (const vid of page.order) {
      for (const q of QUESTIONS) if (!(page.ratings[vid] && page.ratings[vid][q.key])) n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- video sync

  // Videos of one view play together; the first is the clock. No `loop` attribute: when the
  // clock ends, every video restarts, so they never drift apart across loops.
  class SyncGroup {
    constructor(videos, controls) {
      this.videos = videos;
      this.leader = videos[0];
      this.controls = controls;
      this.rate = state.slow ? 0.5 : 1;
      this.playing = false;
      this.alive = true;
      this.onEnded = () => this.restart();
      this.leader.addEventListener('ended', this.onEnded);
      controls.bind(this);
      this.timer = setInterval(() => this.tick(), 200);
      this.ready().then(() => { if (this.alive) this.restart(); });
    }

    ready() {
      const one = v => (v.readyState >= 3 ? Promise.resolve() : new Promise(resolve => {
        v.addEventListener('canplay', resolve, { once: true });
        v.addEventListener('error', resolve, { once: true });
      }));
      return Promise.race([Promise.all(this.videos.map(one)), new Promise(r => setTimeout(r, 10000))]);
    }

    each(f) {
      for (const v of this.videos) {
        try { f(v); } catch (e) { /* a video that is not ready yet */ }
      }
    }

    play() {
      this.playing = true;
      const t = this.leader.currentTime;
      this.each(v => {
        v.playbackRate = this.rate;
        if (Math.abs(v.currentTime - t) > 0.05) v.currentTime = t;
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
      });
      this.controls.update(this);
    }

    pause() {
      this.playing = false;
      this.each(v => v.pause());
      this.controls.update(this);
    }

    toggle() {
      if (this.playing) this.pause(); else this.play();
    }

    restart() {
      this.each(v => { v.currentTime = 0; });
      this.play();
    }

    seek(t) {
      this.pause();
      this.each(v => { v.currentTime = t; });
    }

    setRate(r) {
      this.rate = r;
      this.each(v => { v.playbackRate = r; });
    }

    tick() {
      const t = this.leader.currentTime;
      if (this.playing) {
        this.each(v => {
          if (v !== this.leader && !v.seeking && !v.ended && Math.abs(v.currentTime - t) > 0.15) v.currentTime = t;
        });
      }
      this.controls.progress(t, this.leader.duration);
    }

    destroy() {
      this.alive = false;
      clearInterval(this.timer);
      this.leader.removeEventListener('ended', this.onEnded);
      this.each(v => { v.pause(); v.removeAttribute('src'); v.load(); });
    }
  }

  function playbackControls() {
    const playBtn = h('button', { class: 'btn small', type: 'button' }, 'Pause');
    const restartBtn = h('button', { class: 'btn small', type: 'button' }, 'Restart');
    const slow = h('input', { type: 'checkbox' });
    slow.checked = !!state.slow;
    const bar = h('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'scrub', 'aria-label': 'Position in the video' });
    const el = h('div', { class: 'controls' }, playBtn, restartBtn, h('label', { class: 'slow' }, slow, ' Slow motion'), bar);
    let g = null;
    let dragging = false;
    playBtn.addEventListener('click', () => g && g.toggle());
    restartBtn.addEventListener('click', () => g && g.restart());
    slow.addEventListener('change', () => {
      state.slow = slow.checked;
      save();
      if (g) g.setRate(slow.checked ? 0.5 : 1);
    });
    bar.addEventListener('input', () => {
      dragging = true;
      if (g && g.leader.duration) g.seek((bar.value / 1000) * g.leader.duration);
    });
    bar.addEventListener('change', () => { dragging = false; });
    return {
      el,
      bind(group_) { g = group_; },
      update(group_) { playBtn.textContent = group_.playing ? 'Pause' : 'Play'; },
      progress(t, d) { if (!dragging && d) bar.value = Math.round((1000 * t) / d); },
    };
  }

  function videoEl(id) {
    const v = h('video', { playsinline: true, muted: true, preload: 'auto', disablepictureinpicture: true });
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.src = 'videos/' + id + '.mp4';
    return v;
  }

  // ---------------------------------------------------------------- ratings

  function ratingRows(vid, prefix) {
    const page = currentPage();
    const box = h('div', { class: 'ratings' });
    for (const q of QUESTIONS) {
      const value = (page.ratings[vid] || {})[q.key];
      const opts = h('span', { class: 'ropts' });
      for (let s = 1; s <= 5; s++) {
        const input = h('input', { type: 'radio', name: `${prefix}-${vid}-${q.key}`, value: s, 'aria-label': `${q.label} ${s}` });
        input.checked = value === s;
        input.addEventListener('change', () => setRating(vid, q.key, s));
        opts.append(h('label', { class: 'ropt' }, input, h('span', {}, String(s))));
      }
      box.append(h('div', { class: 'rrow', title: q.text, 'data-vid': vid, 'data-q': q.key },
        h('span', { class: 'rlabel' }, q.label), opts));
    }
    return box;
  }

  function setRating(vid, q, s) {
    const page = currentPage();
    page.ratings[vid] = page.ratings[vid] || {};
    page.ratings[vid][q] = s;
    save();
    document.querySelectorAll(`.rrow[data-vid="${vid}"][data-q="${q}"]`).forEach(row => {
      row.classList.remove('missing');
      row.querySelectorAll('input').forEach(inp => { inp.checked = Number(inp.value) === s; });
    });
    updateNext();
  }

  function updateNext() {
    const btn = document.getElementById('next');
    const note = document.getElementById('left');
    if (!btn) return;
    const left = remaining(currentPage());
    btn.classList.toggle('disabled', left > 0);
    btn.setAttribute('aria-disabled', left > 0 ? 'true' : 'false');
    note.textContent = left ? `${left} rating${left === 1 ? '' : 's'} left` : 'All rated';
  }

  function markMissing() {
    const page = currentPage();
    let first = null;
    document.querySelectorAll('.grid .rrow').forEach(row => {
      const r = page.ratings[row.dataset.vid];
      const missing = !(r && r[row.dataset.q]);
      row.classList.toggle('missing', missing);
      if (missing && !first) first = row;
    });
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---------------------------------------------------------------- views

  function go(step) {
    state.step = step;
    save();
    render();
  }

  function render() {
    closeModal();
    if (group) {
      group.destroy();
      group = null;
    }
    ({ consent: renderConsent, instructions: renderInstructions, clip: renderClip, final: renderFinal, done: renderDone })[state.step]();
    window.scrollTo(0, 0);
  }

  function renderConsent() {
    app.replaceChildren(h('section', { class: 'text-page' },
      h('h1', {}, 'Rating edited driving videos'),
      h('p', {}, 'Thank you for helping with this research study. You will watch short dashcam videos and rate versions of them that were edited automatically. It takes about 20 minutes.'),
      h('ul', {},
        h('li', {}, 'Participation is voluntary and anonymous. We do not ask for your name or e-mail address.'),
        h('li', {}, 'We store only your ratings, the time spent on each page and your window size.'),
        h('li', {}, 'Nothing is sent until you press Submit at the end. You can stop at any time by closing this page.'),
        h('li', {}, 'The anonymous ratings may be reported in aggregate in a research publication.')),
      h('p', {}, 'Please use a laptop or desktop computer with a screen of 13 inches or larger.'),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          state.started = state.started || new Date().toISOString();
          go('instructions');
        },
      }, 'I agree, continue')));
  }

  function renderInstructions() {
    app.replaceChildren(h('section', { class: 'text-page wide' },
      h('h1', {}, 'Instructions'),
      h('p', {}, `You will see ${state.clips.length} scenes. Each scene has two reference videos and several results:`),
      h('ul', {},
        h('li', {}, h('b', {}, 'Original: '), 'the recorded dashcam video.'),
        h('li', {}, h('b', {}, 'Plan: '), 'the original with a blue box showing where a new car should be added and how it should drive, and a red star where it should collide with a car that is already in the video (the other car). The plan ends at the collision; what happens next is up to each result.'),
        h('li', {}, h('b', {}, 'Results A, B, C, …: '), 'the original edited by different automatic methods, in a random order.')),
      h('figure', { class: 'example' },
        h('img', { src: 'example.jpg', alt: 'Example of an original video and its plan' }),
        h('figcaption', {}, 'Example: (1) the planned box of the new car, (2) where it should collide with the other car.')),
      h('p', {}, 'Rate every result on three questions, from 1 (not at all) to 5 (completely):'),
      h('ol', { class: 'qlist' }, ...QUESTIONS.map(q => h('li', {}, h('b', {}, q.label + ': '), q.text))),
      h('p', {}, 'If the cars do not collide, choose 1 for Physics. Rate each result on its own; there are no right answers.'),
      h('p', {}, 'All videos play together in a loop. Use Pause, Restart, Slow motion and the slider to look closely, and click a result to enlarge it next to the original and the plan.'),
      window.innerWidth < 1100 ? h('p', { class: 'warn' }, 'Your browser window is narrow. Please maximize it or use a larger screen.') : null,
      h('button', {
        class: 'btn primary',
        onclick: () => {
          state.index = 0;
          go('clip');
        },
      }, 'Start')));
  }

  function candidateCard(vid, letter) {
    const video = videoEl(vid);
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('span', { class: 'badge' }, letter),
        h('button', { class: 'link', type: 'button', onclick: () => openModal(vid, letter) }, 'Enlarge')),
      h('div', { class: 'vwrap', title: 'Click to enlarge', onclick: () => openModal(vid, letter) }, video),
      ratingRows(vid, 'g'));
    return { card, video };
  }

  function renderClip() {
    const clip = manifest.clips[currentCid()];
    const page = currentPage();
    if (!page.shownAt) {
      page.shownAt = Date.now();
      save();
    }
    const n = state.clips.length;
    const original = videoEl(clip.original);
    const plan = videoEl(clip.plan);
    const controls = playbackControls();
    const cards = page.order.map((vid, i) => candidateCard(vid, LETTERS[i]));
    const side = h('aside', { class: 'side' },
      h('div', { class: 'progress' },
        h('b', {}, `Scene ${state.index + 1} of ${n}`),
        h('div', { class: 'pbar' }, h('div', { style: `width:${(100 * state.index) / n}%` }))),
      h('figure', { class: 'ref' }, original, h('figcaption', {}, 'Original')),
      h('figure', { class: 'ref' }, plan, h('figcaption', {}, 'Plan: blue box = new car, red star = collision point')),
      controls.el,
      h('div', { class: 'legend' },
        h('div', {}, 'Rate each result: 1 = not at all, 5 = completely.'),
        ...QUESTIONS.map(q => h('div', {}, h('b', {}, q.label + ': '), q.text))),
      h('div', { class: 'next-row' },
        h('span', { class: 'note', id: 'left' }),
        h('button', { class: 'btn primary', id: 'next', type: 'button', onclick: next }, state.index + 1 < n ? 'Next scene' : 'Finish')));
    const grid = h('div', { class: cards.length > 6 ? 'grid wide' : 'grid' }, ...cards.map(c => c.card));
    app.replaceChildren(h('div', { class: 'clip-page' }, side, grid));
    group = new SyncGroup([original, plan, ...cards.map(c => c.video)], controls);
    updateNext();
  }

  function next() {
    const page = currentPage();
    if (remaining(page) > 0) {
      markMissing();
      return;
    }
    page.seconds = Math.round((Date.now() - page.shownAt) / 100) / 10;
    state.index += 1;
    go(state.index < state.clips.length ? 'clip' : 'final');
  }

  function openModal(vid, letter) {
    closeModal();
    const clip = manifest.clips[currentCid()];
    if (group) group.pause();
    const big = videoEl(vid);
    const original = videoEl(clip.original);
    const plan = videoEl(clip.plan);
    const controls = playbackControls();
    const modal = h('div', { class: 'modal', onclick: e => { if (e.target === modal) closeModal(); } },
      h('div', { class: 'modal-box' },
        h('div', { class: 'modal-head' },
          h('span', { class: 'badge' }, letter), controls.el,
          h('button', { class: 'btn small', type: 'button', onclick: closeModal }, 'Close (Esc)')),
        h('div', { class: 'modal-grid' },
          h('figure', { class: 'm-main' }, big, h('figcaption', {}, 'Result ' + letter)),
          h('figure', {}, original, h('figcaption', {}, 'Original')),
          h('figure', {}, plan, h('figcaption', {}, 'Plan'))),
        ratingRows(vid, 'm')));
    document.body.append(modal);
    modalGroup = new SyncGroup([original, plan, big], controls);
  }

  function closeModal() {
    const modal = document.querySelector('.modal');
    if (!modal) return;
    if (modalGroup) modalGroup.destroy();
    modalGroup = null;
    modal.remove();
    if (group) group.play();
  }

  function buildPayload() {
    const total = Math.round((Date.parse(state.finished) - Date.parse(state.started)) / 1000);
    const viewport = `${window.innerWidth}x${window.innerHeight}`;
    const rows = [];
    state.clips.forEach((cid, i) => {
      const page = state.pages[cid];
      page.order.forEach((vid, pos) => {
        for (const q of QUESTIONS) {
          const row = {
            received: '', participant: state.participant, block: state.block, pilot: state.pilot, clip: cid,
            page: i + 1, position: LETTERS[pos], video: vid, question: q.key, score: page.ratings[vid][q.key],
            clip_seconds: page.seconds, total_seconds: total,
            viewport, version: state.version,
            started: state.started, finished: state.finished,
          };
          rows.push(Object.fromEntries(COLUMNS.map(c => [c, row[c]])));
        }
      });
    });
    return { participant: state.participant, block: state.block, pilot: state.pilot, version: state.version, rows };
  }

  async function send(payload) {
    const options = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const reply = await fetchJson(submitUrl(), options, 20000);
        if (reply && reply.ok) return 'ok';
      } catch (e) {
        if (CONFIG.endpoint && e && e.name === 'TypeError') {
          // The reply could not be read (e.g. blocked by CORS): deliver without reading it.
          // The server ignores repeated submissions of the same participant.
          try {
            await fetch(submitUrl(), Object.assign({ mode: 'no-cors' }, options));
            return 'unconfirmed';
          } catch (e2) { /* offline: retry below */ }
        }
      }
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
    return 'failed';
  }

  function downloadAnswers() {
    const blob = new Blob([JSON.stringify(state.payload || buildPayload(), null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `answers_${state.participant}.json` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function renderFinal() {
    const status = h('p', { class: 'status' });
    const download = h('button', { class: 'btn', type: 'button', hidden: true, onclick: downloadAnswers }, 'Download my answers');
    const submit = h('button', { class: 'btn primary', type: 'button' }, 'Submit');
    submit.addEventListener('click', async () => {
      submit.disabled = true;
      status.textContent = 'Sending…';
      state.finished = state.finished || new Date().toISOString();
      state.payload = buildPayload();
      save();
      if ((await send(state.payload)) === 'failed') {
        submit.disabled = false;
        submit.textContent = 'Try again';
        status.textContent = 'Your answers could not be sent. Please check your connection and try again. If it keeps failing, download your answers and send the file to the person who shared this link.';
        download.hidden = false;
        return;
      }
      state.submitted = true;
      go('done');
    });
    app.replaceChildren(h('section', { class: 'text-page' },
      h('h1', {}, 'Almost done'),
      h('p', {}, 'Press Submit to send your ratings.'),
      h('div', { class: 'next-row' }, submit, download),
      status));
  }

  function renderDone() {
    app.replaceChildren(h('section', { class: 'text-page' },
      h('h1', {}, 'Thank you!'),
      h('p', {}, 'Your answers have been recorded. You can close this page now.')));
  }

  // ---------------------------------------------------------------- start

  async function main() {
    try {
      const res = await fetch('manifest.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      manifest = await res.json();
    } catch (e) {
      app.replaceChildren(h('p', { class: 'loading' }, 'The study could not be loaded. Please reload the page.'));
      return;
    }
    if (params.get('reset') === '1') {
      try { localStorage.removeItem(STORE); } catch (e) { /* no storage */ }
      params.delete('reset');
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    }
    state = load();
    if (!state || state.version !== manifest.version) {
      state = await newState();
      save();
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    render();
  }

  main();
})();
