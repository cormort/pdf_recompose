// PDF Recompose 端到端驗證
//
//   node verify.mjs            # 需要 playwright（或設 PW_MODULE 指向 playwright/index.js）
//
// 為什麼要這支：這個 repo 沒有任何自動化測試，而它的核心價值在「重組後的 PDF 對不對」——
// 頁序、旋轉、頁碼、目錄超連結、中文字型。這些只有把真實 UI 跑一遍、再把產出的 PDF
// 解回來驗才算數，所以這支用 Playwright 驅動真頁面，再用 repo 內自帶的 pdf-lib／pdf.js
// 驗證輸出（與正式站同一批函式庫，不另外安裝）。
//
// 驗證項目：
//   1. 上傳兩個 PDF（含中文一份）→ 左側頁數、縮圖（必須是 data URL 的 <img>，不是 canvas）
//   2. 全選 → 加入右側 → 旋轉 → 新增小節 → 刪除 → 生成
//   3. 輸出 PDF：頁數、各頁角度、目錄頁文字、目錄頁碼、頁碼文字可被抽取（搜尋／複製正常）
//   4. 目錄超連結：數量與目標頁正確
//   5. 記憶體：載入後的 canvas 數必須為 0（縮圖改存 data URL 後的回歸守門）
//   6. 預覽 blob URL：連續生成兩次不得只增不減（避免累積整本 PDF 的 blob）
//   7. 全程不得有 pageerror／console error
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const require = createRequire(import.meta.url);

// pdf-lib／fontkit 是瀏覽器 UMD bundle。Node 26 起 require() 這兩個檔案拿不到匯出：
// UMD 會走「掛到全域物件」那條分支，但 CommonJS 包裝裡的 `this` 不是瀏覽器全域，
// module.exports 就一直是空物件（PDFDocument.create → undefined）。
//
// 解法：把 bundle 當成瀏覽器 <script> 執行，並且要在**同一個 realm**裡跑：
// 補上 self/window 別名後用 runInThisContext 執行，PDFLib/fontkit 就會掛在 Node 全域上。
// （若改用 vm.createContext 隔離，pdf-lib 收到的 Array 來自別的 realm，型別檢查會失敗，
//  例如 addPage([w,h]) 會丟 "page must be of type ... Array"。）
function loadUmd(file, globalName) {
    globalThis.self = globalThis.self || globalThis;
    globalThis.window = globalThis.window || globalThis;
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    // fontkit 這個 bundle 初始化時會把內嵌的標準字型 dump 到 stdout，暫時靜音。
    const realStdout = process.stdout.write;
    const realStderr = process.stderr.write;
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try {
        runInThisContext(source, { filename: file });
    } finally {
        process.stdout.write = realStdout;
        process.stderr.write = realStderr;
    }
    const lib = globalThis[globalName];
    if (!lib) throw new Error(`無法從 ${file} 取得 UMD 匯出（${globalName}）`);
    return lib;
}

const { PDFDocument, StandardFonts, PDFName, PDFString, PDFHexString, rgb } = loadUmd('./pdf-lib.min.js', 'PDFLib');

let chromium;
try {
    chromium = require(process.env.PW_MODULE || 'playwright').chromium;
} catch {
    console.error('找不到 playwright。請先安裝（npm i -D playwright && npx playwright install chromium），');
    console.error('或指定已安裝的位置：PW_MODULE=/path/to/playwright/index.js node verify.mjs');
    process.exit(2);
}

const ROOT = new URL('.', import.meta.url).pathname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.pdf': 'application/pdf' };

let failed = 0;
const check = (ok, label, detail) => {
    if (ok) { console.log(`✓ ${label}`); return; }
    failed++;
    console.error(`✗ ${label}${detail ? '：' + detail : ''}`);
};

// ── 靜態伺服器（與 GitHub Pages 同樣是同源靜態檔）──
const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    try {
        const body = await readFile(path);
        res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'content-length': body.length });
        res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── 測試檔：兩份，一份中文 ──
const cjkBytes = await readFile(join(ROOT, 'fonts/NotoSansTC-Regular.ttf'));
const fontkit = loadUmd('./fontkit.umd.min.js', 'fontkit');

async function makePdf(name, pages, cjk) {
    const doc = await PDFDocument.create();
    let font;
    if (cjk) { doc.registerFontkit(fontkit); font = await doc.embedFont(cjkBytes, { subset: true }); }
    else font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) {
        const p = doc.addPage([595, 842]);
        p.drawText(cjk ? `第${i + 1}章 中文標題` : `Chapter ${i + 1} Title`, { x: 60, y: 760, size: 18, font });
        p.drawText(`body-${name}-${i + 1}`, { x: 60, y: 700, size: 12, font, color: rgb(0, 0, 0) });
    }
    const dir = await mkdtemp(join(tmpdir(), 'pdfrec-'));
    const file = join(dir, `${name}.pdf`);
    await writeFile(file, await doc.save());
    return file;
}

// 中文書籤必須用 UTF-16BE + BOM 的 hex 字串（PDFString 走 PDFDocEncoding 會亂碼）
function textString(s) {
    if (/^[\x00-\x7F]*$/.test(s)) return PDFString.of(s);
    const bytes = [0xFE, 0xFF];
    for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (cp < 0x10000) bytes.push(cp >> 8, cp & 0xFF);
        else {
            const v = cp - 0x10000;
            const hi = 0xD800 + (v >> 10), lo = 0xDC00 + (v & 0x3FF);
            bytes.push(hi >> 8, hi & 0xFF, lo >> 8, lo & 0xFF);
        }
    }
    return PDFHexString.of(bytes.map(b => b.toString(16).padStart(2, '0')).join(''));
}

// 6 頁 + 兩層中文書籤：第一章(p1) > 1-1 節(p2) > 1-1-1 目(p3)；第二章(p5)
async function makeOutlinePdf() {
    const doc = await PDFDocument.create();
    const pages = [];
    for (let i = 0; i < 6; i++) {
        const p = doc.addPage([595, 842]);
        pages.push(p);
    }
    const ctx = doc.context;
    const refs = { out: ctx.nextRef(), c1: ctx.nextRef(), c1a: ctx.nextRef(), c1a1: ctx.nextRef(), c2: ctx.nextRef() };
    const item = (ref, title, pageIdx, parent, extra = {}) => ctx.assign(ref, ctx.obj({
        Title: textString(title), Parent: parent, Dest: [pages[pageIdx].ref, 'Fit'], ...extra,
    }));
    item(refs.c1a1, '1-1-1 目', 2, refs.c1a);
    item(refs.c1a, '1-1 節', 1, refs.c1, { First: refs.c1a1, Last: refs.c1a1, Count: 1 });
    item(refs.c1, '第一章 總則', 0, refs.out, { First: refs.c1a, Last: refs.c1a, Count: 2, Next: refs.c2 });
    item(refs.c2, '第二章 罰則', 4, refs.out, { Prev: refs.c1 });
    ctx.assign(refs.out, ctx.obj({ Type: 'Outlines', First: refs.c1, Last: refs.c2, Count: 4 }));
    doc.catalog.set(PDFName.of('Outlines'), refs.out);
    doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
    const dir = await mkdtemp(join(tmpdir(), 'pdfrec-bm-'));
    const file = join(dir, 'outline.pdf');
    await writeFile(file, await doc.save());
    return file;
}

const fixtureA = await makePdf('A', 3, false);   // Chapter 1..3
const fixtureB = await makePdf('B', 2, true);    // 第1章、第2章
const fixtureOutline = await makeOutlinePdf();   // 含兩層中文書籤

// 用 pdf.js 讀出 PDF 的大綱（標題 / 階層 / 實際頁碼）
async function readOutline(targetPage, b64) {
    return targetPage.evaluate(async (data64) => {
        const bin = atob(data64); const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
        const doc = await window.pdfjsLib.getDocument({ data }).promise;
        const out = [];
        const walk = async (items, depth) => {
            for (const it of items || []) {
                let pageIndex = null;
                try {
                    const d = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
                    if (d) pageIndex = await doc.getPageIndex(d[0]);
                } catch (e) { pageIndex = 'ERR:' + e.message; }
                out.push({ depth, title: it.title, pageIndex });
                if (it.items) await walk(it.items, depth + 1);
            }
        };
        await walk(await doc.getOutline(), 0);
        await doc.destroy();
        return out;
    }, b64);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 160)); });
await page.goto(BASE + '/index.html', { waitUntil: 'load' });

// ── 1. 上傳兩份 ──
await page.setInputFiles('#fileInput', [fixtureA], { timeout: 20000 });
await page.waitForTimeout(400);
await page.setInputFiles('#fileInput', [fixtureB], { timeout: 20000 });
await page.waitForFunction(() => /載入完成|載入失敗|累計/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });

const loaded = await page.evaluate(() => ({
    progress: document.getElementById('progress').textContent.trim(),
    sourceItems: document.querySelectorAll('#sourcePages .page-item, #sourcePages .page-list-item').length,
    thumbs: document.querySelectorAll('#sourcePages img.page-thumb-img').length,
    canvases: document.querySelectorAll('#sourcePages canvas').length,
    thumbBytes: [...document.querySelectorAll('#sourcePages img.page-thumb-img')].reduce((s, i) => s + i.src.length, 0),
}));
check(loaded.sourceItems === 5, '兩個檔案共 5 頁都進了左側', `實際 ${loaded.sourceItems}`);
check(loaded.thumbs === 5 && loaded.canvases === 0, '縮圖用 data URL 的 <img> 呈現（不再保留 canvas 點陣圖）',
    `img=${loaded.thumbs} canvas=${loaded.canvases}`);
check(loaded.thumbBytes > 0 && loaded.thumbBytes < 2_000_000, '5 頁縮圖的資料量合理（< 2MB）', `${loaded.thumbBytes} 字元`);
check(/累計 2 個/.test(loaded.progress), '分批上傳的進度訊息顯示累計數量', loaded.progress);

// ── 2. 全選 → 加入右側 → 旋轉 → 小節 → 刪除 ──
await page.evaluate(() => { const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb); });
await page.click('button:has-text("加入右側")');
await page.waitForTimeout(400);
const afterAdd = await page.evaluate(() => ({
    target: document.querySelectorAll('#selectedPages .selected-page-item').length,
    thumbs: document.querySelectorAll('#selectedPages img.page-thumb-img').length,
}));
check(afterAdd.target === 5 && afterAdd.thumbs === 5, '5 頁加入右側且縮圖正常', JSON.stringify(afterAdd));

// 勾第一張 → 右轉 → 取消勾選（checkbox 綁的是 onclick，用工具自己的函式最穩）
await page.evaluate(() => toggleTargetCheck(0));
await page.click('#targetPanel button:has-text("右轉")');
await page.waitForTimeout(200);
const rotated = await page.evaluate(() => document.querySelector('#selectedPages img.page-thumb-img')?.style.transform || '');
check(/rotate\(90deg\)/.test(rotated), '右轉後縮圖就地旋轉 90 度', rotated);
await page.evaluate(() => toggleTargetCheck(0));

// 刪掉最後一張（先勾選，刪完取消勾選狀態＝該項目已不存在）
await page.evaluate(() => {
    const items = [...document.querySelectorAll('#selectedPages .selected-page-item')];
    toggleTargetCheck(Number(items[items.length - 1].dataset.index));
});
await page.click('#targetPanel button:has-text("刪除")');
await page.waitForTimeout(300);
const targetPages = await page.evaluate(() => document.querySelectorAll('#selectedPages .selected-page-item').length);
check(targetPages === 4, '刪除 1 張後右側剩 4 頁', `實際 ${targetPages}`);

// 新增小節（會跳出 askDialog）
await page.click('button:has-text("新增小節")');
await page.waitForSelector('#askDialog[open]', { timeout: 5000 });
await page.fill('#askDialogInput', '第一部分');
await page.click('#askDialogOk');
await page.waitForTimeout(300);
check(await page.evaluate(() => document.querySelectorAll('#selectedPages .selected-divider-item').length) === 1, '新增小節後右側出現一個小節標題');

// 小節後面要有內容頁才有意義（結尾的空小節會被清掉），所以再從左側補一張到最後。
// 注意：加入右側後左側的勾選還在，要先把左側勾選清掉，否則會再加一次「全部」。
await page.evaluate(() => {
    clearAllSourceChecks();
    toggleSourceCheck(0, 0); // 只補左側第一張（透過 UI 函式，不直接碰 closure 內的狀態）
});
await page.click('button:has-text("加入右側")');
await page.waitForTimeout(300);
const afterSection = await page.evaluate(() => ({
    pages: document.querySelectorAll('#selectedPages .selected-page-item').length,
    dividers: document.querySelectorAll('#selectedPages .selected-divider-item').length,
    order: [...document.querySelectorAll('#selectedPages > *')].map(e => e.classList.contains('selected-divider-item') ? 'D' : 'P').join(''),
}));
check(afterSection.pages === 5 && afterSection.dividers === 1, '小節後面補上內容頁', JSON.stringify(afterSection));
check(/PPDP/.test(afterSection.order), '小節夾在內容頁中間（不是結尾的空章節）', afterSection.order);
const targetPagesAfterSection = afterSection.pages;

// ── 3. 生成（目錄 + 頁碼）；順便計算 blob URL 的建立／釋放次數 ──
await page.evaluate(() => {
    window.__blob = { created: 0, revoked: 0 };
    const c = URL.createObjectURL.bind(URL), r = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__blob.created++; return c(b); };
    URL.revokeObjectURL = (u) => { window.__blob.revoked++; return r(u); };
    const t = document.getElementById('addTocCheckbox'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('addPageNumbersCheckbox').checked = true;
});
await page.click('#generateBtn');
await page.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
check(/預覽生成成功/.test(await page.textContent('#progress')), '生成成功', (await page.textContent('#progress')).trim());

// 再生成一次：預覽對話框已開，舊 blob URL 必須被釋放
await page.evaluate(() => { document.getElementById('previewModal').close(); });
await page.waitForTimeout(200);
await page.click('#generateBtn');
await page.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const blob = await page.evaluate(() => window.__blob);
check(blob.created - blob.revoked <= 1, '連續生成不會累積未釋放的 blob URL', JSON.stringify(blob));

// 取回預覽位元組
const b64 = await page.evaluate(async () => {
    const url = document.getElementById('previewFrame').src;
    const buf = await (await fetch(url)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const outFile = join(await mkdtemp(join(tmpdir(), 'pdfrec-out-')), 'out.pdf');
await writeFile(outFile, Buffer.from(b64, 'base64'));

// ── 4. 驗證輸出結構（pdf-lib）──
const outDoc = await PDFDocument.load(await readFile(outFile));
const outPages = outDoc.getPages();
// 內容頁數＝右側剩下的頁數；目錄頁數由程式排版決定，用總頁數反推
const tocPageCount = outPages.length - targetPagesAfterSection;
check(tocPageCount >= 1, `輸出頁數＝目錄＋內容 ${targetPagesAfterSection} 頁`, `總頁數 ${outPages.length}，目錄 ${tocPageCount} 頁`);
const angles = outPages.map(p => p.getRotation().angle);
check(angles.slice(tocPageCount)[0] === 90, '第一頁內容的旋轉 90 度有寫進輸出', angles.join(','));

// 目錄超連結：指向的頁碼必須等於目錄上印的頁碼
const linkTargets = [];
for (let i = 0; i < tocPageCount; i++) {
    const annots = outPages[i].node.lookup(PDFName.of('Annots'));
    const arr = annots?.asArray ? annots.asArray() : [];
    for (const a of arr) {
        const dict = outDoc.context.lookup(a);
        const d = dict?.lookup(PDFName.of('A'))?.lookup(PDFName.of('D'));
        const ref = d?.asArray ? d.asArray()[0] : null;
        const targetIndex = ref ? outPages.findIndex(p => String(p.ref) === String(ref)) : -1;
        linkTargets.push(targetIndex);
    }
}
check(linkTargets.length === targetPagesAfterSection, `目錄有 ${targetPagesAfterSection} 個超連結（＝內容頁數）`, `實際 ${linkTargets.length}`);
check(linkTargets.every(i => i >= tocPageCount), '超連結都指向內容頁而非目錄頁', linkTargets.join(','));

// ── 5. 驗證輸出文字（用同一支 pdf.js 抽，模擬使用者搜尋／複製）──
const texts = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        out.push(tc.items.map(x => x.str).join('').replace(/\s+/g, ' ').trim());
    }
    await doc.destroy();
    return out;
}, b64);

const tocText = texts.slice(0, tocPageCount).join(' ');
check(/目錄/.test(tocText), '目錄頁標題可被抽取（中文字型正常）', tocText.slice(0, 60));
check(/第一部分/.test(tocText), '小節標題出現在目錄上', tocText.slice(0, 80));
// 目錄上的頁碼與內容頁的頁碼都必須抽得出來，而且是正確的數字
const expectedNumbers = [];
for (let n = 1; n <= targetPagesAfterSection; n++) expectedNumbers.push(String(n + tocPageCount));
const contentTexts = texts.slice(tocPageCount);
const missingContentNums = expectedNumbers.filter(n => !contentTexts.some(t => t.includes(n)));
check(missingContentNums.length === 0, '內容頁的頁碼可用文字抽取（搜尋／複製正常）', `缺 ${missingContentNums.join(',')}`);
const missingTocNums = expectedNumbers.filter(n => !tocText.includes(n));
check(missingTocNums.length === 0, '目錄上的頁碼可用文字抽取', `缺 ${missingTocNums.join(',')}`);

// ── 6. 記憶體回歸：載入後不得留下 canvas ──
const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length);
check(canvases === 0, '整個流程結束後頁面上沒有殘留 canvas（縮圖全為 data URL）', `canvas=${canvases}`);
check(errors.length === 0, '全程沒有 pageerror／console error', errors.slice(0, 3).join(' | '));

// ── 7. 跨頁目錄：40 頁內容會讓目錄自己超過一頁，考驗「先模擬排版算目錄頁數」那段邏輯 ──
const bigFixture = await makePdf('Big', 40, false);
const page2 = await browser.newPage();
const errors2 = [];
page2.on('pageerror', e => errors2.push('PAGEERROR ' + e.message));
await page2.goto(BASE + '/index.html', { waitUntil: 'load' });
await page2.setInputFiles('#fileInput', [bigFixture], { timeout: 20000 });
await page2.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 300000 });
await page2.evaluate(() => { const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb); });
await page2.click('button:has-text("加入右側")');
await page2.waitForTimeout(400);
await page2.evaluate(() => {
    const t = document.getElementById('addTocCheckbox'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('addPageNumbersCheckbox').checked = true;
});
await page2.click('#generateBtn');
await page2.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 300000 });
const bigB64 = await page2.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const bigDoc = await PDFDocument.load(Buffer.from(bigB64, 'base64'));
const bigTocPages = bigDoc.getPageCount() - 40;
check(bigTocPages >= 2, '40 頁內容的目錄自己超過一頁', `目錄 ${bigTocPages} 頁、總頁數 ${bigDoc.getPageCount()}`);
const bigTexts = await page2.evaluate(async (b64) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        out.push(tc.items.map(x => x.str).join('').replace(/\s+/g, ''));
    }
    await doc.destroy();
    return out;
}, bigB64);
const bigTocText = bigTexts.slice(0, bigTocPages).join(' ');
const bigContent = bigTexts.slice(bigTocPages);
const badNumbers = [];
for (let k = 1; k <= 40; k++) {
    const expected = String(k + bigTocPages);
    if (!bigContent[k - 1].includes(expected)) badNumbers.push(`第${k}張內容頁沒有頁碼 ${expected}`);
    if (!bigTocText.includes(expected)) badNumbers.push(`目錄沒有頁碼 ${expected}`);
}
check(badNumbers.length === 0, '跨頁目錄時每一頁的頁碼都與實體頁序一致', badNumbers.slice(0, 4).join('；'));
const bigLinks = [];
for (let i = 0; i < bigTocPages; i++) {
    const annots = bigDoc.getPages()[i].node.lookup(PDFName.of('Annots'));
    for (const a of annots?.asArray?.() || []) {
        const d = bigDoc.context.lookup(a)?.lookup(PDFName.of('A'))?.lookup(PDFName.of('D'));
        const ref = d?.asArray ? d.asArray()[0] : null;
        bigLinks.push(ref ? bigDoc.getPages().findIndex(p => String(p.ref) === String(ref)) : -1);
    }
}
check(bigLinks.length === 40, '跨頁目錄的 40 個超連結都建立成功', `實際 ${bigLinks.length}`);
check(bigLinks.every((v, i) => v === bigTocPages + i), '每個超連結都指向對應的內容頁（順序正確）',
    bigLinks.slice(0, 6).join(',') + ' …');
check(errors2.length === 0, '跨頁目錄流程沒有 pageerror', errors2.slice(0, 2).join(' | '));

// ── 8. 移除來源檔案：右側成品的 fileIndex 必須跟著修正（否則會抓到別份檔案的頁）──
const page3 = await browser.newPage();
const errors3 = [];
page3.on('pageerror', e => errors3.push('PAGEERROR ' + e.message));
await page3.goto(BASE + '/index.html', { waitUntil: 'load' });
await page3.setInputFiles('#fileInput', [fixtureA], { timeout: 20000 });
await page3.waitForTimeout(300);
await page3.setInputFiles('#fileInput', [fixtureB], { timeout: 20000 });
await page3.waitForFunction(() => /累計|載入完成/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
await page3.evaluate(() => { const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb); });
await page3.click('button:has-text("加入右側")');
await page3.waitForTimeout(400);
// 移除 A（右側有它的頁面 → 會跳確認）。注意不能在 evaluate 裡回傳 removeFile 的 promise：
// 那個 promise 要等對話框被回答才會 resolve，Playwright 會 await 它 → 死鎖。
await page3.evaluate(() => { removeFile(0); });
await page3.waitForSelector('#askDialog[open]', { timeout: 5000 });
await page3.click('#askDialogOk');
await page3.waitForTimeout(500);
const remain = await page3.evaluate(() => document.querySelectorAll('#selectedPages .selected-page-item').length);
check(remain === 2, '移除來源檔 A 後，右側只剩 B 的 2 頁', `實際 ${remain}`);
await page3.click('#generateBtn');
await page3.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const remapB64 = await page3.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const remapText = (await page3.evaluate(async (b64) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const doc = await pdfjsLib.getDocument({ data }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        out.push(tc.items.map(x => x.str).join(''));
    }
    await doc.destroy();
    return out;
}, remapB64)).join(' ').replace(/\s+/g, '');
check(/中文標題/.test(remapText) && !/Chapter/.test(remapText), '移除檔案後產出的是 B 的頁面（fileIndex 有正確修正）', remapText.slice(0, 80));
check(errors3.length === 0, '移除檔案流程沒有 pageerror', errors3.slice(0, 2).join(' | '));

// ── 9. 文件頁：程式碼總覽必須抓到真實檔案（不是手抄的過時副本）──
const docPage = await browser.newPage();
const errors4 = [];
docPage.on('pageerror', e => errors4.push('PAGEERROR ' + e.message));
await docPage.goto(BASE + '/instruction.html', { waitUntil: 'load' });
await docPage.waitForFunction(() => {
    const blocks = [...document.querySelectorAll('pre code[data-src]')];
    return blocks.length > 0 && blocks.every(b => b.textContent.length > 200);
}, null, { timeout: 30000 }).catch(() => {});
const docBlocks = await docPage.evaluate(() => [...document.querySelectorAll('pre code[data-src]')].map(b => ({
    src: b.dataset.src, len: b.textContent.length, head: b.textContent.slice(0, 40),
})));
check(docBlocks.length === 3 && docBlocks.every(b => b.len > 1000), 'instruction.html 的程式碼區塊抓到真實檔案',
    JSON.stringify(docBlocks.map(b => `${b.src}:${b.len}`)));
check(docBlocks.some(b => b.src === 'script.js' && b.head.includes('/**') || b.head.includes('//')), '抓到的內容確實是程式碼開頭',
    docBlocks.map(b => `${b.src}=${JSON.stringify(b.head)}`).join(' '));
check(errors4.length === 0, '文件頁沒有 pageerror', errors4.slice(0, 2).join(' | '));

// ── 10. 回歸：連續兩批上傳不得漏檔（載入中的第二批要排隊，不能靜默丟掉）──
//     這個情境以前會讓第二批整個消失，而且因為還是顯示「載入完成」而完全看不出來。
const page5 = await browser.newPage();
const errors5 = [];
page5.on('pageerror', e => errors5.push('PAGEERROR ' + e.message));
await page5.goto(BASE + '/index.html', { waitUntil: 'load' });
await page5.setInputFiles('#fileInput', [fixtureA], { timeout: 20000 });
await page5.setInputFiles('#fileInput', [fixtureB], { timeout: 20000 }); // 不等第一批載完就丟第二批
await page5.waitForFunction(() => /累計 2 個/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const queued = await page5.evaluate(() => ({
    progress: document.getElementById('progress').textContent.trim(),
    files: [...document.querySelectorAll('#fileList li span')].map(s => s.textContent),
    items: document.querySelectorAll('#sourcePages .page-item, #sourcePages .page-list-item').length,
}));
check(queued.files.length === 2 && queued.items === 5, '載入中丟入的下一批會排隊處理（不會漏檔）',
    JSON.stringify(queued));
check(errors5.length === 0, '連續上傳流程沒有 pageerror', errors5.slice(0, 2).join(' | '));

// ── 11. 回歸：縮圖延遲渲染後，載入完成當下看得到的縮圖就要是 <img>（不能等下一幀）──
const visibleThumbs = await page5.evaluate(() => {
    const imgs = [...document.querySelectorAll('#sourcePages img.page-thumb-img')];
    const visible = imgs.filter(img => {
        const r = img.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
    });
    return { imgs: imgs.length, visible: visible.length, pending: document.querySelectorAll('#sourcePages [data-pending="1"]').length };
});
check(visibleThumbs.visible >= 3, '畫面可見範圍內的縮圖在載入完成時就已渲染（同步補幀）',
    JSON.stringify(visibleThumbs));

// ── 12. 回歸：智慧勾選是「取代」而非「疊加」──
// 先手動勾一個「偶數頁」，再套用「奇數頁」：原本勾的偶數頁必須被清掉（取代語意）。
// 勾選一律走 UI 函式；pdfFiles 是 window.onload 內的 closure 變數，頁面上取不到。
await page5.evaluate(() => {
    clearAllSourceChecks();
    toggleSourceCheck(0, 1); // A 的第 2 頁
});
const beforeQs = await page5.evaluate(() => document.querySelectorAll('#sourcePages .page-item.checked, #sourcePages .page-list-item.checked').length);
await page5.evaluate(() => {
    document.getElementById('qsFileSelect').value = '-1';
    document.getElementById('qsTypeSelect').value = 'odd';
    applyQuickSelection(); // 有既有勾選會先跳確認對話框
});
await page5.waitForSelector('#askDialog[open]', { timeout: 5000 });
await page5.click('#askDialogOk');
await page5.waitForTimeout(300);
const qsResult = await page5.evaluate(() => ({
    // 標題以「第 N 頁」的頁碼顯示；勾選狀態直接看 DOM
    labels: [...document.querySelectorAll('#sourcePages .page-item.checked .page-number, #sourcePages .page-list-item.checked .page-list-number')].map(e => e.textContent.trim()),
    divs: [...document.querySelectorAll('#sourcePages .page-list-item.checked')].map(e => e.dataset.pageKey),
    count: document.getElementById('selectedCountInfo').textContent,
}));
check(beforeQs === 1, '智慧勾選前先手動勾了 1 頁（用來驗證取代語意）', `實際 ${beforeQs}`);
check(qsResult.divs.length > 0 && qsResult.divs.every(k => /_0$|_2$/.test(k)),
    '智慧勾選「奇數頁」會清掉原本勾的偶數頁（取代語意，且只作用在選定檔案）', JSON.stringify(qsResult));
check(errors5.length === 0, '智慧勾選流程沒有 pageerror', errors5.slice(0, 2).join(' | '));

// ── 13. 書籤組：讀取來源大綱（標題 / 階層 / 頁碼）──
const page6 = await browser.newPage();
const errors6 = [];
page6.on('pageerror', e => errors6.push('PAGEERROR ' + e.message));
page6.on('console', m => { if (m.type() === 'error') errors6.push('CONSOLE ' + m.text().slice(0, 200)); });
await page6.goto(BASE + '/index.html', { waitUntil: 'load' });

const SRC_OUTLINE = [
    { title: '第一章 總則', pageIndex: 0, level: 0 },
    { title: '1-1 節', pageIndex: 1, level: 1 },
    { title: '1-1-1 目', pageIndex: 2, level: 2 },
    { title: '第二章 罰則', pageIndex: 4, level: 0 },
];

await page6.setInputFiles('#fileInput', [fixtureOutline], { timeout: 20000 });
await page6.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
const extracted = await page6.evaluate(() => (typeof getSourceOutline === 'function' ? getSourceOutline() : null));
check(extracted && extracted.length === SRC_OUTLINE.length, '載入時會抽出來源 PDF 的書籤大綱', JSON.stringify(extracted));
check(!!extracted && JSON.stringify(extracted) === JSON.stringify(SRC_OUTLINE),
    '大綱的標題（含中文）、階層、頁碼都正確', JSON.stringify(extracted));

// ── 14. 書籤組：預填目錄 → 生成 → 輸出帶巢狀書籤 ──
await page6.evaluate(() => { const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb); });
await page6.click('button:has-text("加入右側")');
await page6.waitForTimeout(400);
check(await page6.evaluate(() => document.querySelectorAll('#selectedPages .selected-page-item').length) === 6, '6 頁加入右側');

// 用來源書籤預填目錄（含小節標題與階層）
await page6.click('button:has-text("編輯目錄")');
await page6.waitForSelector('#tocModal[open]', { timeout: 5000 });
check(await page6.evaluate(() => typeof prefillTocFromSource === 'function'), '有「帶入來源書籤」的功能');
await page6.click('button:has-text("帶入來源書籤")');
await page6.waitForTimeout(300);
const prefilled = await page6.inputValue('#tocTextarea');
check(prefilled.includes('第一章 總則') && prefilled.includes('1-1 節'),
    '預填會把來源書籤帶進目錄編輯器', JSON.stringify(prefilled.slice(0, 80)));
check(/^ {2}1-1 節$/m.test(prefilled) && /^ {4}1-1-1 目$/m.test(prefilled),
    '預填會用縮排表示階層（2 空白 = 下一層）', JSON.stringify(prefilled));
await page6.click('button:has-text("儲存變更")');
await page6.waitForTimeout(300);
// 開啟「寫入書籤」＋「新增目錄頁」後生成
await page6.evaluate(() => {
    const toc = document.getElementById('addTocCheckbox'); toc.checked = true; toc.dispatchEvent(new Event('change', { bubbles: true }));
    const bm = document.getElementById('addBookmarksCheckbox'); bm.checked = true;
    document.getElementById('addPageNumbersCheckbox').checked = true;
});
await page6.click('#generateBtn');
await page6.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
check(/預覽生成成功/.test(await page6.textContent('#progress')), '含書籤的生成成功', (await page6.textContent('#progress')).trim());

const bmB64 = await page6.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const bmDoc = await PDFDocument.load(Buffer.from(bmB64, 'base64'));
const bmTocPages = bmDoc.getPageCount() - 6;
check(bmTocPages >= 1, `輸出＝目錄 ${bmTocPages} 頁＋內容 6 頁`, `總頁數 ${bmDoc.getPageCount()}`);

const outOutline = await readOutline(page6, bmB64);
const EXPECT_OUTLINE = [
    { depth: 0, title: '第一章 總則', pageIndex: 0 },
    { depth: 1, title: '1-1 節', pageIndex: 1 },
    { depth: 2, title: '1-1-1 目', pageIndex: 2 },
    { depth: 0, title: '第二章 罰則', pageIndex: 4 },
];
check(outOutline.length === EXPECT_OUTLINE.length, '輸出 PDF 有書籤大綱',
    JSON.stringify(outOutline.map(o => o.title)));
check(JSON.stringify(outOutline.map(o => ({ depth: o.depth, title: o.title }))) ===
      JSON.stringify(EXPECT_OUTLINE.map(o => ({ depth: o.depth, title: o.title }))),
    '書籤標題（含中文）與階層完全正確', JSON.stringify(outOutline));
check(JSON.stringify(outOutline.map(o => o.pageIndex)) ===
      JSON.stringify(EXPECT_OUTLINE.map(o => o.pageIndex + bmTocPages)),
    '每個書籤都跳轉到正確的成品頁（已加上目錄頁位移）',
    `實際 ${outOutline.map(o => o.pageIndex).join(',')}，預期 ${EXPECT_OUTLINE.map(o => o.pageIndex + bmTocPages).join(',')}`);
check(errors6.length === 0, '書籤流程沒有 pageerror／console error', errors6.slice(0, 2).join(' | '));

// ── 15. 只寫書籤、不加目錄頁：仍要有正確的大綱，且頁碼沒有目錄位移 ──
await page6.evaluate(() => {
    document.getElementById('previewModal').close(); // 預覽還開著會擋住按鈕
    const toc = document.getElementById('addTocCheckbox'); toc.checked = false; toc.dispatchEvent(new Event('change', { bubbles: true }));
});
await page6.click('#generateBtn');
await page6.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const noTocB64 = await page6.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const noTocDoc = await PDFDocument.load(Buffer.from(noTocB64, 'base64'));
check(noTocDoc.getPageCount() === 6, '不加目錄頁時輸出剛好 6 頁', `實際 ${noTocDoc.getPageCount()}`);
const noTocOutline = await readOutline(page6, noTocB64);
check(JSON.stringify(noTocOutline.map(o => o.pageIndex)) ===
      JSON.stringify(EXPECT_OUTLINE.map(o => o.pageIndex)),
    '沒有目錄頁時，書籤直接指向內容頁（無位移）',
    `實際 ${noTocOutline.map(o => o.pageIndex).join(',')}`);
check(errors6.length === 0, '只寫書籤的流程沒有 pageerror', errors6.slice(0, 2).join(' | '));

await browser.close();
server.close();

console.log(`\n產出：${outFile}`);
if (failed) {
    console.error(`${failed} 項未通過。`);
    process.exit(1);
}
console.log('全部通過。');
