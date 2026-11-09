/* Gravador de falas — página estática genérica. Não contém dados: busca as falas no backend
 * (Apps Script) usando o slug e o token que vêm no #fragmento do link (o fragmento não é
 * enviado a nenhum servidor). */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  var SLUG = hash.get('p') || '';
  var TOKEN = hash.get('t') || '';
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var API = (isLocal && hash.get('api')) || window.GRAVADOR_API || '';
  var FORCE_FMT = hash.get('fmt'); // 'webm' | 'mp4' (diagnóstico)
  var MAX_SECONDS = 180;
  var maxBytes = 10 * 1024 * 1024;

  var state = { total: 0, sent: {}, busy: null, uploading: 0, pending: 0 };
  var items = [];

  // ------------------------------------------------------------------ util
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fmtTime(s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function fmtHour(ms) { var d = new Date(ms); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function fmtDay(ms) {
    var d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return 'hoje às ' + fmtHour(ms);
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + ' às ' + fmtHour(ms);
  }
  function showState(msg, isErr, retry) {
    var s = $('#estado');
    s.hidden = false;
    s.className = 'cartao estado' + (isErr ? ' erro' : '');
    s.textContent = msg;
    if (retry) {
      var b = el('button', 'primario', 'Tentar de novo');
      b.style.marginTop = '10px';
      b.onclick = retry;
      s.appendChild(el('br'));
      s.appendChild(b);
    }
  }

  // ------------------------------------------------------------------ ambiente
  var ua = navigator.userAgent || '';
  if (/Instagram|FBAN|FBAV|FB_IAB|WhatsApp|Line\/|; wv\)|MicroMessenger|TikTok/i.test(ua)) $('#aviso-app').hidden = false;

  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    var webm = ['audio/webm;codecs=opus', 'audio/webm'];
    var mp4 = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/mp4;codecs=opus'];
    var order = FORCE_FMT === 'mp4' ? mp4.concat(webm) : webm.concat(mp4);
    for (var i = 0; i < order.length; i++) if (MediaRecorder.isTypeSupported(order[i])) return order[i];
    return '';
  }

  // Tela ligada enquanto grava/envia
  var wake = null;
  function wakeOn() {
    if (!('wakeLock' in navigator) || wake) return;
    navigator.wakeLock.request('screen').then(function (w) { wake = w; w.addEventListener('release', function () { wake = null; }); }).catch(function () {});
  }
  function wakeOff() { if (wake && !state.busy && !state.uploading) { wake.release().catch(function () {}); wake = null; } }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && (state.busy || state.uploading)) wakeOn();
  });
  window.addEventListener('beforeunload', function (e) {
    if (state.busy || state.uploading || state.pending) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------------ backend
  function api(body, timeoutMs) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000) : null;
    return fetch(API, {
      method: 'POST', body: JSON.stringify(body), redirect: 'follow', credentials: 'omit',
      referrerPolicy: 'no-referrer', signal: ctrl ? ctrl.signal : undefined
      // sem Content-Type explícito: o navegador usa text/plain (sem preflight CORS)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  function jsonp(params) {
    return new Promise(function (resolve, reject) {
      var cb = 'gravCb' + Math.floor(Math.random() * 1e9);
      var s = document.createElement('script');
      var t = setTimeout(function () { done(); reject(new Error('timeout')); }, 30000);
      function done() { clearTimeout(t); delete window[cb]; s.remove(); }
      window[cb] = function (data) { done(); resolve(data); };
      s.onerror = function () { done(); reject(new Error('jsonp')); };
      s.src = API + '?' + new URLSearchParams(Object.assign({}, params, { callback: cb })).toString();
      document.head.appendChild(s);
    });
  }

  function load() {
    showState('Carregando suas falas…');
    var params = { p: SLUG, t: TOKEN };
    api({ action: 'get', p: SLUG, t: TOKEN }, 40000)
      .catch(function () { return jsonp(params); })
      .then(function (res) {
        if (!res || !res.ok) {
          showState((res && res.error) || 'Não foi possível abrir suas falas.', true);
          return;
        }
        render(res);
      })
      .catch(function () { showState('Sem conexão com o servidor. Verifique a internet.', true, load); });
  }

  // ------------------------------------------------------------------ tela
  function updatePending() {
    var n = items.filter(function (it) { return it.pending; }).length;
    state.pending = n;
    var bar = $('#pendente');
    bar.hidden = !n;
    bar.textContent = n === 1 ? '1 fala gravada ainda não foi enviada — toque em Enviar ↑' : n + ' falas gravadas ainda não foram enviadas — toque em Enviar ↑';
  }

  function updateProgress() {
    var n = Object.keys(state.sent).length;
    $('#contagem').textContent = n + ' de ' + state.total + ' enviados';
    $('#barra-progresso').style.width = (state.total ? (100 * n / state.total) : 0) + '%';
    $('#fim').hidden = !(state.total && n >= state.total);
  }

  function render(res) {
    state.total = res.total;
    state.sent = res.sent || {};
    if (res.maxBytes) maxBytes = res.maxBytes;
    document.title = 'Gravar falas — ' + res.name;
    $('#nome').textContent = res.name;
    $('#estado').hidden = true;
    $('#como').hidden = false;
    var box = $('#cenas');
    box.textContent = '';
    items = [];
    var scenes = (res.data && res.data.scenes) || [];
    scenes.forEach(function (sc) {
      var sec = el('section', 'cena');
      sec.appendChild(el('h2', null, sc.title));
      if (sc.intent) {
        var p = el('p', 'cena-intencao');
        p.appendChild(el('b', null, 'Intenção da cena: '));
        p.appendChild(document.createTextNode(sc.intent));
        sec.appendChild(p);
      }
      box.appendChild(sec);
      sc.falas.forEach(function (f) { box.appendChild(fala(f)); });
    });
    updateProgress();
  }

  function labeled(cls, label, text, extra) {
    var p = el('p', cls);
    p.appendChild(el('b', null, label));
    p.appendChild(document.createTextNode(text));
    if (extra) { p.appendChild(el('b', null, extra[0])); p.appendChild(document.createTextNode(extra[1])); }
    return p;
  }

  function fala(f) {
    var node = $('#tpl-fala').content.firstElementChild.cloneNode(true);
    var ui = {
      root: node, selo: $('.selo', node), msg: $('.msg', node), rec: $('.gravando', node), tempo: $('.tempo', node),
      nivel: $('.nivel-barra', node), player: $('.player', node), gravar: $('.b-gravar', node), ouvir: $('.b-ouvir', node),
      regravar: $('.b-regravar', node), enviar: $('.b-enviar', node),
      arquivo: $('.b-arquivo', node), input: $('.arquivo', node)
    };
    node.dataset.code = f.code;
    $('.codigo', node).textContent = f.code;
    var nota = $('.nota', node);
    if (f.note) nota.textContent = f.note; else nota.remove();
    var antes = $('.antes', node);
    if (f.before) antes.replaceWith(labeled('antes', 'Antes de você: ', f.before.who + ' — “' + f.before.text + '”'));
    else antes.remove();
    var intencao = $('.intencao', node);
    if (f.intent) intencao.replaceWith(labeled('intencao', 'Intenção: ', f.intent, f.tone ? ['  Tom: ', f.tone] : null));
    else intencao.remove();
    $('.texto', node).textContent = f.text;

    var item = { code: f.code, ui: ui, blob: null, url: null, dur: 0, mode: 'idle' };
    items.push(item);
    paint(item, 'idle');
    ui.gravar.onclick = function () { state.busy === item ? stopRec(item) : startRec(item); };
    ui.regravar.onclick = function () { startRec(item); };
    ui.ouvir.onclick = function () {
      if (ui.player.paused) { pauseAll(); ui.player.play().catch(function () {}); } else { ui.player.pause(); }
    };
    ui.player.onplay = function () { ui.ouvir.textContent = '❚❚ Pausar'; };
    ui.player.onpause = ui.player.onended = function () { ui.ouvir.textContent = '▶ Ouvir'; };
    ui.enviar.onclick = function () { upload(item); };
    ui.arquivo.onclick = function () { ui.input.value = ''; ui.input.click(); };
    ui.input.onchange = function () { useFile(item, ui.input.files && ui.input.files[0]); };
    return node;
  }

  function paint(item, mode, text, cls) {
    var ui = item.ui, sent = state.sent[item.code];
    ui.selo.textContent = sent ? 'Enviado ✓' + (sent.n > 1 ? ' (' + sent.n + ' versões)' : '') : 'Não enviado';
    ui.selo.className = 'selo' + (sent ? ' ok' : '');
    ui.root.classList.toggle('enviada', !!sent);
    var has = !!item.blob;
    ui.rec.hidden = mode !== 'rec';
    ui.player.hidden = true; // tocamos pelo botão Ouvir
    ui.gravar.hidden = has && mode !== 'rec';
    ui.gravar.textContent = mode === 'rec' ? '■ Parar' : (sent ? '● Gravar de novo' : '● Gravar');
    ui.gravar.className = 'b-gravar ' + (mode === 'rec' ? 'parar' : (sent ? '' : 'primario'));
    ui.ouvir.hidden = !has || mode === 'rec';
    ui.regravar.hidden = !has || mode === 'rec';
    ui.enviar.hidden = !has || mode === 'rec' || mode === 'sent';
    ui.arquivo.hidden = mode === 'rec' || mode === 'sending';
    ui.arquivo.textContent = has ? '📎 Trocar arquivo' : '📎 Enviar áudio do WhatsApp';
    ui.enviar.textContent = mode === 'sending' ? 'Enviando…' : (mode === 'err' ? 'Tentar de novo ↑' : 'Enviar ↑');
    if (mode === 'idle' && sent && !text) {
      text = 'Último envio ' + fmtDay(sent.at) + '.'; cls = 'ok';
    }
    ui.msg.textContent = text || '';
    ui.msg.className = 'msg' + (cls ? ' ' + cls : '');
    item.mode = mode;
    refreshLocks();
    updatePending();
  }

  // Só uma gravação por vez; não regravar enquanto envia.
  function refreshLocks() {
    items.forEach(function (it) {
      var other = !!state.busy && state.busy !== it;
      var starting = state.busy === it && it.mode !== 'rec'; // esperando o microfone
      it.ui.gravar.disabled = other || starting;
      it.ui.regravar.disabled = other || starting || it.mode === 'sending';
      it.ui.enviar.disabled = starting || it.mode === 'sending';
      it.ui.arquivo.disabled = other || starting || it.mode === 'sending';
    });
  }

  // ------------------------------------------------------------------ gravação
  var audioCtx = null;

  function pauseAll() { items.forEach(function (it) { if (!it.ui.player.paused) it.ui.player.pause(); }); }

  function startRec(item) {
    if (state.busy) return;
    var mime = pickMime();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      paint(item, item.blob ? 'ready' : 'idle', 'Este navegador não grava áudio. Abra o link no Chrome ou no Safari.', 'erro');
      return;
    }
    pauseAll();
    state.busy = item; // trava os botões enquanto pede o microfone
    paint(item, item.blob ? 'ready' : 'idle', 'Pedindo acesso ao microfone…');
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { audioCtx = null; }
    var md = navigator.mediaDevices;
    md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      .catch(function (err) {
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err;
        return md.getUserMedia({ audio: true }); // reserva para aparelhos que recusam as restrições
      })
      .then(function (stream) { beginRecording(item, stream, mime); })
      .catch(function (err) {
        closeCtx();
        state.busy = null;
        var m = err && err.name === 'NotAllowedError'
          ? 'O microfone foi bloqueado. Permita o microfone para este site (ícone ao lado do endereço) e tente de novo. Se abriu pelo WhatsApp/Instagram, abra no Safari ou Chrome.'
          : 'Não consegui usar o microfone (' + (err && err.name || 'erro') + ').';
        paint(item, item.blob ? 'ready' : 'idle', m, 'erro');
      });
  }

  function beginRecording(item, stream, mime) {
    var rec;
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 }) : new MediaRecorder(stream);
    } catch (e) {
      try { rec = new MediaRecorder(stream); } catch (e2) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        closeCtx();
        state.busy = null;
        paint(item, 'idle', 'Este navegador não consegue gravar áudio.', 'erro');
        return;
      }
    }
    var chunks = [];
    var t0 = Date.now();
    var ui = item.ui;
    var analyser = null, raf = 0, src = null, buf = null, level = 0;
    if (audioCtx) {
      try {
        src = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        buf = new Uint8Array(analyser.fftSize);
      } catch (e) { analyser = null; }
    }
    function tick() {
      var secs = (Date.now() - t0) / 1000;
      ui.tempo.textContent = fmtTime(secs);
      if (analyser) {
        analyser.getByteTimeDomainData(buf);
        var peak = 0;
        for (var i = 0; i < buf.length; i++) { var v = Math.abs(buf[i] - 128); if (v > peak) peak = v; }
        level = Math.max(peak / 128, level * 0.88); // sobe rápido, desce devagar
        ui.nivel.style.width = Math.min(100, Math.round(level * 140)) + '%';
      }
      if (secs >= MAX_SECONDS) { stopRec(item); return; }
      raf = requestAnimationFrame(tick);
    }
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      cancelAnimationFrame(raf);
      try { if (src) src.disconnect(); } catch (e) {}
      stream.getTracks().forEach(function (t) { t.stop(); });
      closeCtx();
      state.busy = null;
      var type = rec.mimeType || (chunks[0] && chunks[0].type) || mime || (/iPhone|iPad|Macintosh/.test(ua) ? 'audio/mp4' : 'audio/webm');
      var blob = new Blob(chunks, { type: type });
      item.dur = (Date.now() - t0) / 1000;
      if (!blob.size) { paint(item, 'idle', 'A gravação ficou vazia. Tente de novo.', 'erro'); wakeOff(); return; }
      if (item.url) URL.revokeObjectURL(item.url);
      item.blob = blob;
      item.url = URL.createObjectURL(blob);
      ui.player.src = item.url;
      item.pending = true;
      paint(item, 'ready', 'Gravado (' + fmtTime(item.dur) + '). Ouça e, se estiver bom, toque em Enviar.');
      wakeOff();
    };
    item.rec = rec;
    item.pending = false;
    if (item.url) { ui.player.pause(); }
    item.blob = null;
    rec.start(1000);
    wakeOn();
    paint(item, 'rec');
    tick();
  }

  function closeCtx() {
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
  }

  function stopRec(item) {
    if (item.rec && item.rec.state !== 'inactive') item.rec.stop();
  }

  // ------------------------------------------------------------------ arquivo (WhatsApp etc.)
  var EXT_MIME = { opus: 'audio/ogg', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4',
    aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm' };
  var TYPE_MIME = { 'audio/opus': 'audio/ogg', 'audio/x-opus+ogg': 'audio/ogg', 'application/ogg': 'audio/ogg',
    'video/mp4': 'audio/mp4', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg',
    'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'video/webm': 'audio/webm', 'audio/x-aac': 'audio/aac' };

  function fileMime(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var t = (file.type || '').toLowerCase().split(';')[0].trim();
    if (EXT_MIME[ext]) return EXT_MIME[ext];
    if (TYPE_MIME[t]) return TYPE_MIME[t];
    if (/^audio\/(webm|mp4|aac|mpeg|ogg|wav)$/.test(t)) return t;
    return null;
  }

  function useFile(item, file) {
    if (!file || state.busy) return;
    var mime = fileMime(file);
    if (!mime) { paint(item, item.blob ? 'ready' : 'idle', 'Esse arquivo não parece ser um áudio. Escolha o áudio salvo do WhatsApp.', 'erro'); return; }
    if (file.size > maxBytes) { paint(item, item.blob ? 'ready' : 'idle', 'O arquivo passou de 10 MB. Envie só a fala.', 'erro'); return; }
    if (item.url) URL.revokeObjectURL(item.url);
    pauseAll();
    item.blob = new Blob([file], { type: mime });
    item.url = URL.createObjectURL(item.blob);
    item.dur = 0;
    item.ui.player.src = item.url;
    item.ui.player.onloadedmetadata = function () { if (isFinite(item.ui.player.duration)) item.dur = item.ui.player.duration; };
    item.pending = true;
    paint(item, 'ready', 'Arquivo escolhido: ' + file.name + '. Confira se é a fala certa e toque em Enviar.');
  }

  // ------------------------------------------------------------------ envio
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function upload(item) {
    if (!item.blob) return;
    if (item.blob.size > maxBytes) { paint(item, 'err', 'O áudio passou de 10 MB. Grave de novo, só a fala.', 'erro'); return; }
    state.uploading++;
    wakeOn();
    paint(item, 'sending', 'Enviando… não feche a página.');
    toBase64(item.blob).then(function (b64) {
      return api({ action: 'upload', p: SLUG, t: TOKEN, code: item.code, mime: item.blob.type, dur: item.dur, data: b64 }, 120000);
    }).then(function (res) {
      state.uploading--;
      if (!res || !res.ok) { paint(item, 'err', (res && res.error) || 'Não foi possível enviar.', 'erro'); return; }
      var prev = state.sent[item.code];
      state.sent[item.code] = { n: (prev ? prev.n : 0) + 1, at: res.at, size: res.size };
      item.pending = false;
      paint(item, 'sent', 'Enviado ✓ ' + fmtDay(res.at) + '.', 'ok');
      updateProgress();
      wakeOff();
    }).catch(function (err) {
      state.uploading--;
      paint(item, 'err', err && err.name === 'AbortError'
        ? 'O envio demorou demais. Se puder, use o Wi-Fi e toque em “Tentar de novo”.'
        : 'Falha na conexão. Verifique a internet e toque em “Tentar de novo”.', 'erro');
      wakeOff();
    });
  }

  // ------------------------------------------------------------------ início
  if (!SLUG || !TOKEN) { showState('Link incompleto. Abra o link exatamente como está no documento.', true); return; }
  if (!API) { showState('A página ainda não está configurada. Avise quem enviou o link.', true); return; }
  load();
})();
