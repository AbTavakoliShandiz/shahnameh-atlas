/* ===================== helpers ===================== */
function escapeHtml(s){
  if(s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function rowsToObjects(stmtResult){
  if(!stmtResult || !stmtResult.length) return [];
  const {columns, values} = stmtResult[0];
  return values.map(v => Object.fromEntries(columns.map((c,i)=>[c, v[i]])));
}
function debounce(fn, ms){
  let t; return (...a)=>{ clearTimeout(t); t = setTimeout(()=>fn(...a), ms); };
}
function sqlEsc(s){ return String(s).replace(/'/g,"''"); }

/** اجرای امن یک کوئری روی worker httpvfs؛ اگر جدول/ویو هنوز نباشد، خطا نمی‌دهد. */
async function safeQuery(sql, params){
  try{ return rowsToObjects(await worker.db.exec(sql, params)); }
  catch(e){ return null; }
}
async function runQuery(sql, params){
  return rowsToObjects(await worker.db.exec(sql, params));
}

const PUBLIC_EDITION = 'M';

// آدرس فایل دیتابیس. چون سایت و دیتابیس حالا هر دو روی همان GitHub Pages
// (همان ریپازیتوری) میزبانی می‌شوند، هر دو هم‌مبدأ (same-origin) هستند.
// از «حالت chunked» استفاده می‌کنیم (نه «full») چون GitHub پاسخ HEAD را gzip
// می‌کند و این باعث می‌شد sql.js-httpvfs نتواند طول واقعی فایل را تشخیص دهد؛
// در حالت chunked طول فایل مستقیم از db-meta.js خوانده می‌شود، نه از سرور.

let worker = null; // sql.js-httpvfs worker (تمام کوئری‌ها async و از طریق HTTP Range می‌آیند)
const PAGE_SIZE = 20;
let currentPage = 1;
let currentResults = [];
let searchMode = 'text'; // 'text' | 'all'
let searchToken = 0; // برای نادیده‌گرفتن نتایج قدیمی وقتی جست‌وجوی جدیدتری شروع شده

/* ===================== init ===================== */
async function init(){
  document.getElementById('results-wrap').innerHTML = '<div class="loading">در حال اتصال به دیتابیس (بارگذاری تکه‌ای، نه کل فایل)…</div>';

  worker = await createDbWorker(
    [{ from: 'inline', config: {
        serverMode: 'chunked',
        requestChunkSize: 1024,
        urlPrefix: DB_URL_PREFIX,
        serverChunkSize: DB_SERVER_CHUNK_SIZE,
        suffixLength: DB_SUFFIX_LENGTH,
        databaseLengthBytes: DB_LENGTH_BYTES
    }}],
    'sqlite.worker.js',
    'sql-wasm.wasm'
  );

  await populateFilters();
  await renderStats();
  await runSearch();
  await initGraphPicker();

  document.getElementById('search-input').addEventListener('input', debounce(()=>{ currentPage = 1; runSearch(); }, 250));
  ['f-dynasty','f-section','f-era'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('change', ()=>{ currentPage = 1; runSearch(); });
  });
  document.querySelectorAll('.search-mode-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.search-mode-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      searchMode = btn.dataset.mode;
      currentPage = 1;
      runSearch();
    });
  });

  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('view-' + btn.dataset.view).classList.add('active');
      document.getElementById('sidebar-search').style.display = btn.dataset.view === 'search' ? 'block' : 'none';
      if(btn.dataset.view === 'graph' && window._cy) window._cy.resize();
    });
  });
}

async function renderStats(){
  const beytsR = await runQuery(`SELECT COUNT(*) c FROM core_beyts WHERE edition='${PUBLIC_EDITION}'`);
  const entsR = await runQuery('SELECT COUNT(*) c FROM know_entities');
  const conceptsR = await runQuery('SELECT COUNT(*) c FROM know_concepts');
  const eventsR = await safeQuery(`
    SELECT COUNT(*) c FROM know_beyt_events be
    JOIN core_beyts cb ON cb.code = be.beyt_code AND cb.edition='${PUBLIC_EDITION}'
  `);
  const beyts = beytsR[0].c, ents = entsR[0].c, concepts = conceptsR[0].c;
  const eventsCount = eventsR ? eventsR[0].c : 0;
  document.getElementById('db-stat').innerHTML =
    `${beyts.toLocaleString('fa-IR')} بیت<br>${ents.toLocaleString('fa-IR')} مدخل<br>${concepts.toLocaleString('fa-IR')} مفهوم<br>${eventsCount.toLocaleString('fa-IR')} رویداد`;
  if(beyts === 0){
    document.getElementById('db-stat').insertAdjacentHTML('afterend',
      `<div class="stat-warn">هنوز داده‌ای برای نسخهٔ منتشرشده (مسکو) ثبت نشده است.</div>`);
  }
}

/* ===================== filters ===================== */
async function populateFilters(){
  const dyn = await runQuery('SELECT dynasty_id, name FROM core_dynasties ORDER BY order_index');
  const dynSel = document.getElementById('f-dynasty');
  dyn.forEach(d => dynSel.insertAdjacentHTML('beforeend', `<option value="${d.dynasty_id}">${escapeHtml(d.name)}</option>`));

  const sec = await runQuery('SELECT section_code, king_name FROM core_sections ORDER BY order_index');
  const secSel = document.getElementById('f-section');
  sec.forEach(s => secSel.insertAdjacentHTML('beforeend', `<option value="${s.section_code}">${escapeHtml(s.king_name)}</option>`));

  const era = await runQuery('SELECT era_id, name FROM core_eras ORDER BY order_index');
  const eraSel = document.getElementById('f-era');
  era.forEach(e => eraSel.insertAdjacentHTML('beforeend', `<option value="${e.era_id}">${escapeHtml(e.name)}</option>`));
}

/* ===================== search (دو حالت: فقط متن بیت / همهٔ محتوا) ===================== */
async function runSearch(){
  const myToken = ++searchToken;
  document.getElementById('results-wrap').innerHTML = '<div class="loading">در حال جست‌وجو…</div>';

  const q = document.getElementById('search-input').value.trim();
  const dynastyId = document.getElementById('f-dynasty').value;
  const sectionCode = document.getElementById('f-section').value;
  const eraId = document.getElementById('f-era').value;

  const viewProbe = await safeQuery('SELECT 1 FROM v_beyt_summary LIMIT 1');
  const useView = viewProbe !== null;

  let sql = useView ? `
    SELECT code, mesra1, mesra2, paraphrase, page, volume, edition,
           king_name, section_code, dynasty_id, dynasty_name, era_id, era_name
    FROM v_beyt_summary
    WHERE edition = '${PUBLIC_EDITION}'
  ` : `
    SELECT b.code, b.mesra1, b.mesra2, b.paraphrase, b.page, b.volume, b.edition, b.era_id,
           s.king_name, s.section_code, s.dynasty_id, d.name AS dynasty_name, e.name AS era_name
    FROM core_beyts b
    LEFT JOIN core_sections s ON b.section_code = s.section_code
    LEFT JOIN core_dynasties d ON s.dynasty_id = d.dynasty_id
    LEFT JOIN core_eras e ON b.era_id = e.era_id
    WHERE b.edition = '${PUBLIC_EDITION}'
  `;
  const tbl = useView ? '' : 'b.';
  const params = [];

  if(q){
    if(searchMode === 'text'){
      sql += ` AND (${tbl}mesra1 LIKE ? OR ${tbl}mesra2 LIKE ?) `;
      const like = `%${q}%`;
      params.push(like, like);
    } else {
      const hasMeanings = (await safeQuery('SELECT 1 FROM core_beyt_meanings LIMIT 1')) !== null;
      sql += ` AND (${tbl}mesra1 LIKE ? OR ${tbl}mesra2 LIKE ? OR ${tbl}paraphrase LIKE ?
               OR ${tbl}code IN (SELECT beyt_code FROM know_beyt_entities be JOIN know_entities ke ON be.entity_id=ke.entity_id WHERE ke.name LIKE ?)
               OR ${tbl}code IN (SELECT beyt_code FROM know_beyt_concepts bc JOIN know_concepts kc ON bc.concept_id=kc.concept_id WHERE kc.name LIKE ?)
               ${hasMeanings ? `OR ${tbl}code IN (SELECT beyt_code FROM core_beyt_meanings WHERE meaning_text LIKE ?)` : ''}
               ) `;
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
      if(hasMeanings) params.push(like);
    }
  }
  if(dynastyId){ sql += ` AND ${tbl}dynasty_id = ? `; params.push(dynastyId); }
  if(sectionCode){ sql += ` AND ${tbl}section_code = ? `; params.push(sectionCode); }
  if(eraId){ sql += ` AND ${tbl}era_id = ? `; params.push(eraId); }
  sql += ` ORDER BY ${tbl}volume, ${tbl}section_code, ${tbl}beyt_num`;

  let rows = [];
  try{
    rows = await runQuery(sql, params);
  }catch(e){
    rows = [];
  }

  if(myToken !== searchToken) return; // جست‌وجوی جدیدتری شروع شده، این نتیجه دیگر مهم نیست

  currentResults = rows;
  await renderPage();
}

async function getTagsForBeyt(code){
  const safe = sqlEsc(code);
  const ents = await runQuery(`
    SELECT ke.name FROM know_beyt_entities be JOIN know_entities ke ON be.entity_id = ke.entity_id
    WHERE be.beyt_code = '${safe}'
  `);
  const cons = await runQuery(`
    SELECT kc.name FROM know_beyt_concepts bc JOIN know_concepts kc ON bc.concept_id = kc.concept_id
    WHERE bc.beyt_code = '${safe}'
  `);
  return {ents, cons};
}

/** ارجاع صادقانه به تصویر صفحه‌ی اسکن‌شده (نه منبع تفسیر). */
async function getPageScanRef(edition, volume, page){
  if(!edition || !volume || !page) return null;
  const rows = await runQuery(`
    SELECT file_name FROM core_page_images
    WHERE edition = '${sqlEsc(edition)}' AND volume = ${parseInt(volume,10)} AND page_number = ${parseInt(page,10)}
    LIMIT 1
  `);
  return rows.length ? rows[0].file_name : null;
}

/** خوانش‌های علمی دیگر (core_beyt_meanings) — مکمل معنای امروزی، نه جایگزین آن. */
async function getAlternateMeanings(code){
  return (await safeQuery(`
    SELECT meaning_text, source_type, source_citation
    FROM core_beyt_meanings WHERE beyt_code = '${sqlEsc(code)}'
  `)) || [];
}

/** صدا: فایل مشترک هر ۱۰ بیت + بازهٔ زمانی این بیت در آن فایل. */
async function getAudioForBeyt(code){
  const ts = await safeQuery(`
    SELECT audio_id, start_ms, end_ms FROM core_beyt_audio_timestamps WHERE beyt_code = '${sqlEsc(code)}' LIMIT 1
  `);
  if(!ts || !ts.length) return null;
  const file = await safeQuery(`SELECT file_name FROM core_audio_files WHERE audio_id = ${parseInt(ts[0].audio_id,10)} LIMIT 1`);
  if(!file || !file.length) return null;
  return { fileName: file[0].file_name, startMs: ts[0].start_ms, endMs: ts[0].end_ms };
}

async function renderPage(){
  const total = currentResults.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if(currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = currentResults.slice(start, start + PAGE_SIZE);

  document.getElementById('results-count').textContent =
    total ? `${total.toLocaleString('fa-IR')} نتیجه — صفحه‌ی ${currentPage.toLocaleString('fa-IR')} از ${totalPages.toLocaleString('fa-IR')}` : '';

  await renderResults(pageRows);
  renderPagination(totalPages);
}

function renderPagination(totalPages){
  const el = document.getElementById('pagination');
  if(totalPages <= 1){ el.innerHTML = ''; return; }
  let html = `<button class="page-btn" id="pg-prev" ${currentPage===1?'disabled':''}>‹ قبلی</button>`;
  const windowSize = 2;
  for(let p=1; p<=totalPages; p++){
    if(p===1 || p===totalPages || Math.abs(p-currentPage) <= windowSize){
      html += `<button class="page-btn ${p===currentPage?'active':''}" data-page="${p}">${p.toLocaleString('fa-IR')}</button>`;
    } else if(Math.abs(p-currentPage) === windowSize+1){
      html += `<span style="padding:0 4px;color:var(--ink-soft);">…</span>`;
    }
  }
  html += `<button class="page-btn" id="pg-next" ${currentPage===totalPages?'disabled':''}>بعدی ›</button>`;
  el.innerHTML = html;
  const prev = document.getElementById('pg-prev');
  const next = document.getElementById('pg-next');
  if(prev) prev.addEventListener('click', ()=>{ currentPage--; renderPage(); scrollToResults(); });
  if(next) next.addEventListener('click', ()=>{ currentPage++; renderPage(); scrollToResults(); });
  el.querySelectorAll('[data-page]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ currentPage = parseInt(btn.dataset.page, 10); renderPage(); scrollToResults(); });
  });
}
function scrollToResults(){
  document.getElementById('results-count').scrollIntoView({behavior:'smooth', block:'start'});
}

let audioIdCounter = 0;

async function renderResults(rows){
  if(!rows.length){
    document.getElementById('results-wrap').innerHTML = '<div class="loading">نتیجه‌ای یافت نشد.</div>';
    return;
  }

  // داده‌ی هر ردیف را موازی واکشی می‌کنیم تا صفحه سریع‌تر آماده شود
  const enriched = await Promise.all(rows.map(async r => {
    const [tags, scanFile, audio, altMeanings] = await Promise.all([
      getTagsForBeyt(r.code),
      getPageScanRef(r.edition, r.volume, r.page),
      getAudioForBeyt(r.code),
      getAlternateMeanings(r.code),
    ]);
    return { r, tags, scanFile, audio, altMeanings };
  }));

  let html = `<table><thead><tr>
    <th style="width:34%">بیت</th>
    <th>معنای امروزی</th>
    <th style="width:14%">جایگاه</th>
    <th style="width:16%">برچسب‌ها</th>
  </tr></thead><tbody>`;

  enriched.forEach(({r, tags, scanFile, audio, altMeanings})=>{
    const tagHtml = tags.ents.map(t=>`<span class="tag">${escapeHtml(t.name)}</span>`).join('') +
                    tags.cons.map(t=>`<span class="tag gold">${escapeHtml(t.name)}</span>`).join('');

    const audioHtml = audio
      ? `<button class="audio-btn" data-audio-file="audio/${escapeHtml(audio.fileName)}" data-start="${audio.startMs}" data-end="${audio.endMs}">🔊 پخش صوتی این بیت</button>`
      : '';

    audioIdCounter++;
    const altId = `alt-${audioIdCounter}`;
    const altHtml = altMeanings.length
      ? `<div class="alt-meanings">
          <button class="alt-toggle" data-target="${altId}">سایر خوانش‌ها (${altMeanings.length.toLocaleString('fa-IR')}) ▾</button>
          <div class="alt-body" id="${altId}" style="display:none;">
            ${altMeanings.map(m=>`<div class="alt-item">
                <div>${escapeHtml(m.meaning_text)}</div>
                <div class="cite-note">${escapeHtml(m.source_type || '')}${m.source_citation ? ' — ' + escapeHtml(m.source_citation) : ''}</div>
              </div>`).join('')}
          </div>
        </div>`
      : '';

    html += `<tr>
      <td class="beyt-cell">
        <span class="mesra">${escapeHtml(r.mesra1)}</span>
        <span class="mesra">${escapeHtml(r.mesra2)}</span>
        <div class="beyt-code-row">${escapeHtml(r.code)}</div>
        ${audioHtml}
      </td>
      <td>
        <div class="paraphrase">${escapeHtml(r.paraphrase || '—')}</div>
        ${scanFile
          ? `<div class="scan-ref">تصویر صفحه‌ی اصلی: نسخه‌ی ${escapeHtml(r.edition)}، ج${r.volume} ص${r.page} <span class="meta">(${escapeHtml(scanFile)})</span></div>`
          : `<div class="scan-ref muted">بدون ارجاع علمی ثبت‌شده برای تصویر این بیت</div>`}
        ${altHtml}
      </td>
      <td class="meta">${escapeHtml(r.king_name || '')}${r.dynasty_name ? ' · ' + escapeHtml(r.dynasty_name) : ''}<br>${escapeHtml(r.era_name || '')}<br>ج${r.volume || '?'} ص${r.page || '?'}</td>
      <td>${tagHtml || '<span class="meta">—</span>'}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  document.getElementById('results-wrap').innerHTML = html;

  document.querySelectorAll('.alt-toggle').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const body = document.getElementById(btn.dataset.target);
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      btn.textContent = btn.textContent.replace(open ? '▴' : '▾', open ? '▾' : '▴');
    });
  });
  document.querySelectorAll('.audio-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> playBeytAudio(btn));
  });
}

let activeAudioEl = null;
function playBeytAudio(btn){
  const file = btn.dataset.audioFile;
  const start = parseInt(btn.dataset.start, 10) / 1000;
  const end = parseInt(btn.dataset.end, 10) / 1000;
  if(activeAudioEl){ activeAudioEl.pause(); activeAudioEl = null; }
  const audioEl = new Audio(file);
  activeAudioEl = audioEl;
  const onTime = () => { if(audioEl.currentTime >= end){ audioEl.pause(); audioEl.removeEventListener('timeupdate', onTime); } };
  audioEl.addEventListener('timeupdate', onTime);
  audioEl.addEventListener('loadedmetadata', () => { audioEl.currentTime = start; audioEl.play(); });
  audioEl.play().catch(()=>{});
}

/* ===================== گراف: فقط با انتخاب یک گره، فقط همسایگان ۱-۲ جهش ===================== */
const TYPE_COLORS = { '_default': '#5C4A34' };
const PALETTE = ['#C08A2E','#2A5F50','#A1382A','#16233F','#7B5EA7','#8A8A8A','#3E7C6B','#B05C2E','#6B4E9C','#9C6B2E'];
function colorForType(type){
  if(TYPE_COLORS[type]) return TYPE_COLORS[type];
  const idx = Object.keys(TYPE_COLORS).length % PALETTE.length;
  const c = PALETTE[idx];
  TYPE_COLORS[type] = c;
  return c;
}

let pickerItems = [];
async function initGraphPicker(){
  const entities = await runQuery('SELECT entity_id id, name, type FROM know_entities');
  const concepts = await runQuery('SELECT concept_id id, name FROM know_concepts');
  pickerItems = [
    ...entities.map(e => ({ id: 'e'+e.id, label: e.name, cat: 'entity', type: e.type })),
    ...concepts.map(c => ({ id: 'c'+c.id, label: c.name, cat: 'concept', type: 'concept' })),
  ];

  const input = document.getElementById('graph-picker-input');
  const list = document.getElementById('graph-picker-list');

  input.addEventListener('input', debounce(()=>{
    const q = input.value.trim();
    if(!q){ list.innerHTML=''; list.style.display='none'; return; }
    const matches = pickerItems.filter(it => it.label.includes(q)).slice(0, 15);
    if(!matches.length){ list.innerHTML = '<div class="picker-empty">یافت نشد</div>'; list.style.display='block'; return; }
    list.innerHTML = matches.map(m =>
      `<div class="picker-item" data-id="${m.id}">
        <span class="picker-cat">${m.cat==='entity'?'مدخل':'مفهوم'}</span> ${escapeHtml(m.label)}
      </div>`).join('');
    list.style.display = 'block';
    list.querySelectorAll('.picker-item').forEach(el=>{
      el.addEventListener('click', ()=>{
        input.value = el.textContent.trim();
        list.style.display = 'none';
        startGraphFrom(el.dataset.id);
      });
    });
  }, 120));

  document.addEventListener('click', (e)=>{
    if(!list.contains(e.target) && e.target !== input) list.style.display = 'none';
  });
}

/** آی‌دی‌های رویداد که به نسخهٔ منتشرشده (M) تعلق دارند. */
async function publicEventIds(){
  const rows = await safeQuery(`
    SELECT be.event_id FROM know_beyt_events be
    JOIN core_beyts cb ON cb.code = be.beyt_code AND cb.edition='${PUBLIC_EDITION}'
  `);
  return new Set((rows || []).map(r => r.event_id));
}

const NEIGHBOR_CAP_PER_HOP = 8;
const NODE_CAP_TOTAL = 60;

async function getNeighbors(node, pubEvents){
  const cat = node.slice(0,1), rawId = node.slice(1);
  const out = [];

  if(cat === 'e'){ // مدخل
    const er = (await safeQuery(`SELECT relation_id, source_entity_id, target_entity_id, relation_type FROM know_entity_relations WHERE source_entity_id=${rawId} OR target_entity_id=${rawId}`)) || [];
    er.forEach(r=>{
      const otherId = r.source_entity_id == rawId ? r.target_entity_id : r.source_entity_id;
      out.push({ id:'e'+otherId, cat:'entity', edgeId:'er'+r.relation_id, source:'e'+r.source_entity_id, target:'e'+r.target_entity_id, edgeLabel:r.relation_type, kind:'entity-entity' });
    });

    const evActor = ((await safeQuery(`SELECT event_id, action FROM know_beyt_events WHERE actor_entity_id=${rawId}`)) || []).filter(ev=>pubEvents.has(ev.event_id)).slice(0,NEIGHBOR_CAP_PER_HOP);
    evActor.forEach(ev=>{
      out.push({ id:'v'+ev.event_id, cat:'event', label:ev.action, edgeId:'ea'+ev.event_id, source:'e'+rawId, target:'v'+ev.event_id, edgeLabel:'کنشگرِ', kind:'entity-event' });
    });
    const evTarget = ((await safeQuery(`SELECT event_id, action FROM know_beyt_events WHERE target_entity_id=${rawId}`)) || []).filter(ev=>pubEvents.has(ev.event_id)).slice(0,NEIGHBOR_CAP_PER_HOP);
    evTarget.forEach(ev=>{
      out.push({ id:'v'+ev.event_id, cat:'event', label:ev.action, edgeId:'et'+ev.event_id, source:'v'+ev.event_id, target:'e'+rawId, edgeLabel:'هدفِ', kind:'entity-event' });
    });

    const co = (await safeQuery(`
      SELECT kc.concept_id, kc.name, COUNT(*) n
      FROM know_beyt_entities be
      JOIN core_beyts cb ON cb.code=be.beyt_code AND cb.edition='${PUBLIC_EDITION}'
      JOIN know_beyt_concepts bc ON bc.beyt_code=be.beyt_code
      JOIN know_concepts kc ON kc.concept_id=bc.concept_id
      WHERE be.entity_id=${rawId} GROUP BY kc.concept_id ORDER BY n DESC LIMIT ${NEIGHBOR_CAP_PER_HOP}
    `)) || [];
    co.forEach(c=>{
      out.push({ id:'c'+c.concept_id, cat:'concept', label:c.name, edgeId:'ec'+rawId+'_'+c.concept_id, source:'e'+rawId, target:'c'+c.concept_id, edgeLabel:`هم‌رخداد ×${c.n}`, kind:'entity-concept' });
    });
  }

  if(cat === 'v'){ // رویداد
    const self = await safeQuery(`SELECT actor_entity_id, target_entity_id, beyt_code FROM know_beyt_events WHERE event_id=${rawId}`);
    if(self && self.length){
      const {actor_entity_id, target_entity_id, beyt_code} = self[0];
      if(actor_entity_id) out.push({ id:'e'+actor_entity_id, cat:'entity', edgeId:'ea'+rawId, source:'e'+actor_entity_id, target:'v'+rawId, edgeLabel:'کنشگرِ', kind:'entity-event' });
      if(target_entity_id) out.push({ id:'e'+target_entity_id, cat:'entity', edgeId:'et'+rawId, source:'v'+rawId, target:'e'+target_entity_id, edgeLabel:'هدفِ', kind:'entity-event' });

      const co = (await safeQuery(`
        SELECT kc.concept_id, kc.name FROM know_beyt_concepts bc JOIN know_concepts kc ON kc.concept_id=bc.concept_id
        WHERE bc.beyt_code='${sqlEsc(beyt_code)}' LIMIT ${NEIGHBOR_CAP_PER_HOP}
      `)) || [];
      co.forEach(c=>{
        out.push({ id:'c'+c.concept_id, cat:'concept', label:c.name, edgeId:'vc'+rawId+'_'+c.concept_id, source:'v'+rawId, target:'c'+c.concept_id, edgeLabel:'هم‌رخداد', kind:'event-concept' });
      });
    }
    const vr = (await safeQuery(`SELECT relation_id, source_event_id, target_event_id, relation_type FROM know_event_relations WHERE source_event_id=${rawId} OR target_event_id=${rawId}`)) || [];
    vr.filter(r => pubEvents.has(r.source_event_id) && pubEvents.has(r.target_event_id)).forEach(r=>{
      const otherId = r.source_event_id == rawId ? r.target_event_id : r.source_event_id;
      out.push({ id:'v'+otherId, cat:'event', edgeId:'vr'+r.relation_id, source:'v'+r.source_event_id, target:'v'+r.target_event_id, edgeLabel:r.relation_type, kind:'event-event' });
    });
  }

  if(cat === 'c'){ // مفهوم
    const ents = (await safeQuery(`
      SELECT ke.entity_id, ke.name, COUNT(*) n
      FROM know_beyt_concepts bc
      JOIN core_beyts cb ON cb.code=bc.beyt_code AND cb.edition='${PUBLIC_EDITION}'
      JOIN know_beyt_entities be ON be.beyt_code=bc.beyt_code
      JOIN know_entities ke ON ke.entity_id=be.entity_id
      WHERE bc.concept_id=${rawId} GROUP BY ke.entity_id ORDER BY n DESC LIMIT ${NEIGHBOR_CAP_PER_HOP}
    `)) || [];
    ents.forEach(e=>{
      out.push({ id:'e'+e.entity_id, cat:'entity', label:e.name, edgeId:'ec'+e.entity_id+'_'+rawId, source:'e'+e.entity_id, target:'c'+rawId, edgeLabel:`هم‌رخداد ×${e.n}`, kind:'entity-concept' });
    });
  }

  return out;
}

function labelFor(id){
  const item = pickerItems.find(p => p.id === id);
  if(item) return {label:item.label, type:item.type, cat:item.cat};
  return {label:id, type:'event', cat:'event'};
}

async function startGraphFrom(startId){
  document.getElementById('graph-empty-state').textContent = 'در حال بارگذاری گراف…';
  document.getElementById('graph-empty-state').style.display = 'block';
  document.getElementById('cy').style.display = 'none';

  const pubEvents = await publicEventIds();
  const visited = new Map();
  const edgesMap = new Map();
  const startMeta = labelFor(startId);
  visited.set(startId, { id: startId, cat: startMeta.cat, label: startMeta.label, type: startMeta.type });

  let frontier = [startId];
  for(let depth=0; depth<2 && visited.size < NODE_CAP_TOTAL; depth++){
    const results = await Promise.all(frontier.map(id => getNeighbors(id, pubEvents)));
    const nextFrontier = [];
    results.forEach(neighbors=>{
      neighbors.forEach(n=>{
        if(visited.size >= NODE_CAP_TOTAL) return;
        if(!visited.has(n.id)){
          const meta = n.label ? {label:n.label, type: n.type || labelFor(n.id).type, cat:n.cat} : labelFor(n.id);
          visited.set(n.id, { id:n.id, cat:n.cat, label: meta.label, type: n.cat==='event' ? 'event' : meta.type });
          nextFrontier.push(n.id);
        }
        if(!edgesMap.has(n.edgeId)){
          edgesMap.set(n.edgeId, { id:n.edgeId, source:n.source, target:n.target, label:n.edgeLabel || '', kind:n.kind });
        }
      });
    });
    frontier = nextFrontier;
  }

  const nodes = [...visited.values()].map(n => ({
    data: { id:n.id, label:n.label, cat:n.cat, type: n.cat==='entity' ? (n.type||'_default') : n.cat }
  }));
  const edges = [...edgesMap.values()]
    .filter(e => visited.has(e.source) && visited.has(e.target))
    .map(e => ({ data: e }));

  document.getElementById('graph-stat').textContent =
    `${nodes.length.toLocaleString('fa-IR')} نود · ${edges.length.toLocaleString('fa-IR')} یال — همسایگان تا ۲ جهش از «${escapeHtml(startMeta.label)}»`;

  document.getElementById('graph-empty-state').style.display = 'none';
  document.getElementById('cy').style.display = 'block';
  renderCyGraph(nodes, edges);
}

function renderCyGraph(nodes, edges){
  if(window._cy) window._cy.destroy();
  window._cy = cytoscape({
    container: document.getElementById('cy'),
    elements: { nodes, edges },
    style: [
      { selector: 'node[cat = "entity"]', style: { 'background-color': ele => colorForType(ele.data('type')), 'shape':'ellipse', 'width':26,'height':26 } },
      { selector: 'node[cat = "event"]', style: { 'background-color': '#16233F', 'shape':'diamond', 'width':24,'height':24 } },
      { selector: 'node[cat = "concept"]', style: { 'background-color': '#A1382A', 'shape':'star', 'width':28,'height':28 } },
      { selector: 'node', style: {
        'label': 'data(label)', 'color': '#2A2015', 'font-family': 'Vazirmatn, Tahoma, sans-serif',
        'font-size': 10, 'text-valign': 'bottom', 'text-margin-y': 6,
        'border-width': 2, 'border-color': '#F4E9CE', 'text-wrap':'ellipsis', 'text-max-width':'90px'
      }},
      { selector: 'edge[kind = "entity-entity"]', style: { 'line-color': '#C08A2E', 'target-arrow-color': '#C08A2E' } },
      { selector: 'edge[kind = "entity-event"]', style: { 'line-color': '#8A8A8A', 'target-arrow-color': '#8A8A8A', 'line-style':'dashed' } },
      { selector: 'edge[kind = "event-event"]', style: { 'line-color': '#A1382A', 'target-arrow-color': '#A1382A' } },
      { selector: 'edge[kind = "entity-concept"], edge[kind = "event-concept"]', style: { 'line-color':'#7B5EA7', 'target-arrow-color':'#7B5EA7', 'line-style':'dotted' } },
      { selector: 'edge', style: {
        'width': 1.5, 'curve-style': 'bezier', 'target-arrow-shape': 'triangle',
        'label': 'data(label)', 'font-size': 8.5, 'font-family': 'Vazirmatn, Tahoma, sans-serif',
        'color': '#5C4A34', 'text-background-color': '#F4E9CE', 'text-background-opacity': 0.85,
        'text-background-padding': 2, 'arrow-scale': 0.85
      }},
    ],
    layout: { name: 'cose', animate:false, idealEdgeLength: 90, nodeRepulsion: 8500, padding: 30 }
  });
  window._cy.on('tap', 'node', evt => startGraphFrom(evt.target.data('id')));
}

init();
