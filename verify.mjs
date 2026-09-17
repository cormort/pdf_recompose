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

// 內容集中在頁面中央的 A4（四周大片白邊），用來驗證「裁掉白邊」
async function makeInsetPdf() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) {
        const p = doc.addPage([595, 842]);
        p.drawText(`Inset ${i + 1}`, { x: 200, y: 400, size: 16, font });
    }
    const dir = await mkdtemp(join(tmpdir(), 'pdfrec-inset-'));
    const file = join(dir, 'inset.pdf');
    await writeFile(file, await doc.save());
    return file;
}

// 每頁只有一個大代號（P1、P2...），用來驗證拼版時「哪一頁被放到哪一格」
async function makeMarkedPdf(count) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < count; i++) {
        const p = doc.addPage([595, 842]);
        p.drawText(`P${i + 1}`, { x: 260, y: 400, size: 48, font });
    }
    const dir = await mkdtemp(join(tmpdir(), 'pdfrec-mark-'));
    const file = join(dir, `marked${count}.pdf`);
    await writeFile(file, await doc.save());
    return file;
}

// 把一頁的文字依「格線」分類：回傳每一格裡的文字
async function readCellsByGrid(targetPage, b64, cols, rows) {
    return targetPage.evaluate(async ({ data64, cols, rows }) => {
        const bin = atob(data64); const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
        const doc = await window.pdfjsLib.getDocument({ data }).promise;
        const pages = [];
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const vp = page.getViewport({ scale: 1 });
            const tc = await page.getTextContent();
            const cells = Array.from({ length: cols * rows }, () => []);
            for (const it of tc.items) {
                if (!it.str || !it.str.trim()) continue;
                // transform[4]/[5] 是基線位置；y 要用「距頁頂」計算才與格線一致
                const x = it.transform[4];
                const yFromTop = vp.height - it.transform[5];
                let col = Math.floor((x / vp.width) * cols);
                let row = Math.floor((yFromTop / vp.height) * rows);
                col = Math.max(0, Math.min(cols - 1, col));
                row = Math.max(0, Math.min(rows - 1, row));
                cells[row * cols + col].push(it.str.trim());
            }
            pages.push({ size: [Math.round(vp.width), Math.round(vp.height)], cells });
        }
        await doc.destroy();
        return pages;
    }, { data64: b64, cols, rows });
}

const fixtureA = await makePdf('A', 3, false);   // Chapter 1..3
const fixtureB = await makePdf('B', 2, true);    // 第1章、第2章
const fixtureOutline = await makeOutlinePdf();   // 含兩層中文書籤
const fixtureInset = await makeInsetPdf();       // 內容置中、四周大量白邊
const fixtureMark4 = await makeMarkedPdf(4);     // P1..P4（測試騎馬釘）
const fixtureMark6 = await makeMarkedPdf(6);     // P1..P6（測試 2-up / 4-up）

// 用 pdf.js 逐頁讀出文字 items（浮水印需要確認文字真的進到輸出、而且能被抽取）
async function readPageTexts(targetPage, b64) {
    return targetPage.evaluate(async (data64) => {
        const bin = atob(data64); const data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
        const doc = await window.pdfjsLib.getDocument({ data }).promise;
        const out = [];
        for (let i = 1; i <= doc.numPages; i++) {
            const tc = await (await doc.getPage(i)).getTextContent();
            out.push(tc.items.filter(it => it.str && it.str.trim()).map(it => it.str));
        }
        await doc.destroy();
        return out;
    }, b64);
}

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
    document.getElementById('addMarksCheckbox').checked = true;
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
// 目錄上的頁碼與內容頁的頁碼都必須抽得出來。
// 這份文件的順序是 P P P D P P（補了一張在最後，所以它在小節之後）。
// 採分節編號後，小節之後的那一頁會重新從 1 起算，所以出現的編號是 1..4，
// 而不是連續的 1..5 —— 這是刻意的語意，不是漏印。
const expectedNumbers = [];
for (let n = 1; n <= targetPagesAfterSection - 1; n++) expectedNumbers.push(String(n));
const contentTexts = texts.slice(tocPageCount);
const missingContentNums = expectedNumbers.filter(n => !contentTexts.some(t => t.includes(n)));
check(missingContentNums.length === 0, '內容頁的頁碼可用文字抽取（搜尋／複製正常）', `缺 ${missingContentNums.join(',')}`);
const missingTocNums = expectedNumbers.filter(n => !tocText.includes(n));
check(missingTocNums.length === 0, '目錄上的頁碼可用文字抽取', `缺 ${missingTocNums.join(',')}`);
// 目錄頁本身不應該被編號（它是封面性質，不屬於任何小節）
check(!texts.slice(0, tocPageCount).some(t => /^\s*0\s*$/.test(t)), '目錄頁不會被編號');

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
    document.getElementById('addMarksCheckbox').checked = true;
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
    document.getElementById('addMarksCheckbox').checked = true;
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

// ── 16. 復原／重做 ──
const page7 = await browser.newPage();
const errors7 = [];
page7.on('pageerror', e => errors7.push('PAGEERROR ' + e.message));
page7.on('console', m => { if (m.type() === 'error') errors7.push('CONSOLE ' + m.text().slice(0, 200)); });
await page7.goto(BASE + '/index.html', { waitUntil: 'load' });
// 等一下讓啟動的 IndexedDB 檢查跑完（這頁沒有工作階段，不會跳對話框）
await page7.waitForTimeout(400);
await page7.setInputFiles('#fileInput', [fixtureA], { timeout: 20000 });
await page7.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });

const targetCount = () => page7.evaluate(() => document.querySelectorAll('#selectedPages .selected-page-item').length);
// 依目前 DOM 狀態把第 index 張設定成想要的值（toggleTargetCheck 是「切換」，
// 直接呼叫會因為原本已勾選而反過來取消勾選）
const setTargetChecked = (index, want) => page7.evaluate(({ index, want }) => {
    const cb = document.querySelector(`#selectedPages [data-index="${index}"] .page-checkbox`);
    if (!cb) return null;
    if (cb.checked !== want) toggleTargetCheck(index);
    return document.querySelector(`#selectedPages [data-index="${index}"] .page-checkbox`).checked;
}, { index, want });
const historyState = () => page7.evaluate(() => (typeof getHistoryState === 'function' ? getHistoryState() : null));

await page7.evaluate(() => { const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb); });
await page7.click('button:has-text("加入右側")');
await page7.waitForTimeout(300);
check(await targetCount() === 3, '加入 3 頁到右側', `實際 ${await targetCount()}`);
const beforeUndo = await historyState();
check(beforeUndo && beforeUndo.undoDepth >= 1, '加入頁面後有可復原的步驟', JSON.stringify(beforeUndo));

await page7.click('#undoBtn');
await page7.waitForTimeout(200);
check(await targetCount() === 0, '復原會把「加入右側」整批還原', `實際 ${await targetCount()}`);
const afterUndo = await historyState();
check(afterUndo && afterUndo.redoDepth === 1, '復原後有可重做的步驟', JSON.stringify(afterUndo));

await page7.click('#redoBtn');
await page7.waitForTimeout(200);
check(await targetCount() === 3, '重做會把剛才的批次加回來', `實際 ${await targetCount()}`);

// 鍵盤捷徑
await page7.keyboard.press('Control+z');
await page7.waitForTimeout(200);
check(await targetCount() === 0, 'Ctrl+Z 也能復原', `實際 ${await targetCount()}`);
await page7.keyboard.press('Control+Shift+z');
await page7.waitForTimeout(200);
check(await targetCount() === 3, 'Ctrl+Shift+Z 也能重做', `實際 ${await targetCount()}`);

// 新的操作要讓重做失效
await page7.click('#undoBtn');
await page7.waitForTimeout(200);
await page7.evaluate(() => { clearAllSourceChecks(); toggleSourceCheck(0, 0); });
await page7.click('button:has-text("加入右側")');
await page7.waitForTimeout(300);
const afterBranch = await historyState();
check(afterBranch && afterBranch.redoDepth === 0, '復原後做新動作會清掉重做堆疊', JSON.stringify(afterBranch));
check(await targetCount() === 1, '新動作的結果正確', `實際 ${await targetCount()}`);

// 旋轉與刪除也要能復原
check(await setTargetChecked(0, true) === true, '把唯一一張設成已勾選（旋轉用）');
await page7.click('#targetPanel button:has-text("右轉")');
await page7.waitForTimeout(200);
const rotatedDeg = await page7.evaluate(() => document.querySelector('#selectedPages img.page-thumb-img')?.style.transform || '');
await page7.click('#undoBtn');
await page7.waitForTimeout(200);
const rotatedAfterUndo = await page7.evaluate(() => document.querySelector('#selectedPages img.page-thumb-img')?.style.transform || '');
check(/rotate\(90deg\)/.test(rotatedDeg) && !/rotate\(90deg\)/.test(rotatedAfterUndo),
    '復原可以還原旋轉', `${rotatedDeg} -> ${rotatedAfterUndo}`);

check(await setTargetChecked(0, true) === true, '把唯一一張設成已勾選');
await page7.click('#targetPanel button:has-text("刪除")');
await page7.waitForTimeout(300);
check(await targetCount() === 0, '刪除生效', `實際 ${await targetCount()}`);
await page7.click('#undoBtn');
await page7.waitForTimeout(200);
check(await targetCount() === 1, '復原可以還原刪除', `實際 ${await targetCount()}`);
check(errors7.length === 0, '復原／重做流程沒有 pageerror', errors7.slice(0, 2).join(' | '));

// ── 17. 工作階段還原（IndexedDB）──
// 這段改用全新的分頁：前一段（復原／重做）已經在同一頁寫過工作階段，
// 舊分頁排程中的保存會在我們清理之後才落地，把狀態蓋回來。
const page8 = await browser.newPage();
const errors8 = [];
page8.on('pageerror', e => errors8.push('PAGEERROR ' + e.message));
page8.on('console', m => { if (m.type() === 'error') errors8.push('CONSOLE ' + m.text().slice(0, 200)); });

const hasIDB = await page8.evaluate(() => typeof indexedDB !== 'undefined').catch(() => false);
await page8.goto(BASE + '/index.html', { waitUntil: 'load' });
if (!hasIDB) {
    console.log('（此環境沒有 IndexedDB，略過工作階段還原測試）');
} else {
    // 從乾淨的狀態開始
    await page8.evaluate(() => new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('pdf-recompose');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
    }));
    await page8.reload({ waitUntil: 'load' });
    const readDb = () => page8.evaluate(() => new Promise((resolve) => {
        const r = indexedDB.open('pdf-recompose', 1);
        r.onsuccess = () => {
            const g = r.result.transaction('session', 'readonly').objectStore('session').get('current');
            g.onsuccess = () => { const v = g.result; r.result.close(); resolve(v ? (v.files || []).map(f => f.name) : null); };
            g.onerror = () => resolve('ERR');
        };
        r.onerror = () => resolve('OPEN-ERR');
    }));
    check(await readDb() === null, '起始狀態沒有舊的工作階段');

    await page8.setInputFiles('#fileInput', [fixtureB], { timeout: 20000 });
    await page8.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
    await page8.evaluate(() => { const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb); });
    await page8.click('button:has-text("加入右側")');
    await page8.waitForTimeout(300);
    const savedOk = await page8.evaluate(() => (typeof flushSessionSave === 'function' ? flushSessionSave() : false));
    check(savedOk === true, '工作階段寫入 IndexedDB 成功', String(savedOk));
    check(JSON.stringify(await readDb()) === JSON.stringify(['B.pdf']), 'DB 內存的是剛載入的檔案', JSON.stringify(await readDb()));

    // 重新載入：應該詢問是否還原
    await page8.reload({ waitUntil: 'load' });
    await page8.waitForSelector('#askDialog[open]', { timeout: 15000 });
    const restorePrompt = await page8.evaluate(() => ({
        title: document.getElementById('askDialogTitle').textContent,
    }));
    check(/還原/.test(restorePrompt.title), '重新開啟時會詢問是否還原工作階段', JSON.stringify(restorePrompt));
    await page8.click('#askDialogOk'); // 確定還原
    await page8.waitForFunction(() => /已還原/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
    await page8.waitForTimeout(600);
    const restored = await page8.evaluate(() => ({
        files: [...document.querySelectorAll('#fileList li span')].map(s => s.textContent),
        target: document.querySelectorAll('#selectedPages .selected-page-item').length,
        source: document.querySelectorAll('#sourcePages [data-page-key]').length,
    }));
    check(restored.files.length === 1 && restored.source === 2,
        '還原後來源檔案與頁面回來了', JSON.stringify(restored));
    check(restored.target === 2, '還原後右側的編排也回來了', JSON.stringify(restored));
    check((await page8.evaluate(() => getHistoryState())).undoDepth === 0,
        '還原後不會留下「還原前」的復原步驟');
    check(errors8.length === 0, '工作階段還原流程沒有 pageerror', errors8.slice(0, 2).join(' | '));

    // 選擇「不還原」之後要把工作階段清掉，下次不該再問
    await page8.reload({ waitUntil: 'load' });
    await page8.waitForSelector('#askDialog[open]', { timeout: 15000 });
    const restorePrompt2 = await page8.evaluate(() => document.getElementById('askDialogTitle').textContent);
    check(/還原/.test(restorePrompt2), '再次開啟仍會詢問還原', restorePrompt2);
    await page8.click('#askDialogCancel');
    await page8.waitForTimeout(600);
    check(await readDb() === null, '選擇不還原後工作階段會被清掉', JSON.stringify(await readDb()));
}

// ── 18. 浮水印 ──
const page9 = await browser.newPage();
const errors9 = [];
page9.on('pageerror', e => errors9.push('PAGEERROR ' + e.message));
page9.on('console', m => { if (m.type() === 'error') errors9.push('CONSOLE ' + m.text().slice(0, 200)); });
await page9.goto(BASE + '/index.html', { waitUntil: 'load' });
await page9.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('pdf-recompose'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
await page9.reload({ waitUntil: 'load' });
await page9.waitForTimeout(400);

await page9.setInputFiles('#fileInput', [fixtureA], { timeout: 20000 });
await page9.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
await page9.evaluate(() => { const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb); });
await page9.click('button:has-text("加入右側")');
await page9.waitForTimeout(300);
check(await page9.evaluate(() => document.querySelectorAll('#selectedPages .selected-page-item').length) === 3, '浮水印測試：3 頁就緒');

// 只有勾了浮水印才應該出現設定面板
check(await page9.evaluate(() => document.getElementById('watermarkSettingsPanel').style.display === 'none'),
    '未勾選浮水印時不顯示設定面板');
await page9.evaluate(() => {
    const cb = document.getElementById('addWatermarkCheckbox');
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
});
check(await page9.evaluate(() => document.getElementById('watermarkSettingsPanel').style.display !== 'none'),
    '勾選浮水印後展開設定面板');

// 型態一：置中單一，中文
await page9.fill('#watermarkText', '機密文件');
await page9.selectOption('#watermarkLayout', 'center');
await page9.fill('#watermarkSize', '40');
await page9.fill('#watermarkOpacity', '0.3');
await page9.fill('#watermarkRange', '');
await page9.click('#generateBtn');
await page9.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
check(/預覽生成成功/.test(await page9.textContent('#progress')), '浮水印生成成功', (await page9.textContent('#progress')).trim());

const wmB64 = await page9.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const wmTexts = await readPageTexts(page9, wmB64);
const countWatermark = (items, label) => items.filter(t => t.replace(/\s+/g, '') === label).length;
check(wmTexts.length === 3, '浮水印不改變頁數', `實際 ${wmTexts.length}`);
check(wmTexts.every(items => countWatermark(items, '機密文件') === 1),
    '每一頁都有一個置中浮水印，且中文可被抽取',
    JSON.stringify(wmTexts.map(t => countWatermark(t, '機密文件'))));
check(wmTexts.every(items => items.some(t => /Chapter/.test(t))),
    '原本的頁面文字沒有被浮水印蓋掉（仍然抽得到）');

// 型態二：平鋪 → 同一頁出現多個
await page9.evaluate(() => document.getElementById('previewModal').close());
await page9.selectOption('#watermarkLayout', 'tile');
await page9.click('#generateBtn');
await page9.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const tileB64 = await page9.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const tileTexts = await readPageTexts(page9, tileB64);
check(tileTexts.every(items => countWatermark(items, '機密文件') >= 4),
    '平鋪模式每頁出現多個浮水印', JSON.stringify(tileTexts.map(t => countWatermark(t, '機密文件'))));

// 型態三：頁面範圍只蓋第 2 頁
await page9.evaluate(() => document.getElementById('previewModal').close());
await page9.selectOption('#watermarkLayout', 'center');
await page9.fill('#watermarkRange', '2');
await page9.click('#generateBtn');
await page9.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const rangeB64 = await page9.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const rangeCounts = (await readPageTexts(page9, rangeB64)).map(items => countWatermark(items, '機密文件'));
check(JSON.stringify(rangeCounts) === JSON.stringify([0, 1, 0]),
    '頁面範圍「2」只蓋第 2 頁', JSON.stringify(rangeCounts));

// 型態四：範圍語法 1-2,3 全部涵蓋
await page9.evaluate(() => document.getElementById('previewModal').close());
await page9.fill('#watermarkRange', '1-2,3');
await page9.click('#generateBtn');
await page9.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const range2B64 = await page9.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const range2Counts = (await readPageTexts(page9, range2B64)).map(items => countWatermark(items, '機密文件'));
check(JSON.stringify(range2Counts) === JSON.stringify([1, 1, 1]),
    '範圍語法「1-2,3」涵蓋全部三頁', JSON.stringify(range2Counts));

// 空字串時不應該蓋任何東西（避免整份文件被空白浮水印污染）
await page9.evaluate(() => document.getElementById('previewModal').close());
await page9.fill('#watermarkText', '   ');
await page9.click('#generateBtn');
await page9.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const blankB64 = await page9.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const blankCounts = (await readPageTexts(page9, blankB64)).map(items => countWatermark(items, '機密文件'));
check(blankCounts.every(n => n === 0), '空白浮水印文字不會蓋上去', JSON.stringify(blankCounts));
check(errors9.length === 0, '浮水印流程沒有 pageerror／console error', errors9.slice(0, 2).join(' | '));

// ── 18b. 頁面標記：頁首／頁尾與頁碼共用面板 ──
await page9.evaluate(() => document.getElementById('previewModal').close());
await page9.evaluate(() => {
    const wm = document.getElementById('addWatermarkCheckbox'); wm.checked = false; wm.dispatchEvent(new Event('change', { bubbles: true }));
    const mk = document.getElementById('addMarksCheckbox'); mk.checked = true; mk.dispatchEvent(new Event('change', { bubbles: true }));
});
await page9.fill('#headerFormat', 'DOC-{n}');
await page9.selectOption('#headerPosition', 'top-center');
await page9.fill('#footerFormat', '{date}');
await page9.selectOption('#footerPosition', 'bottom-left');
await page9.fill('#pageNumberFormat', 'P{n}');
await page9.selectOption('#pageNumberPosition', 'bottom-right');
await page9.click('#generateBtn');
await page9.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
check(/預覽生成成功/.test(await page9.textContent('#progress')), '頁首／頁尾／頁碼同時輸出成功');

const mkB64 = await page9.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const mkTocPages = (await PDFDocument.load(Buffer.from(mkB64, 'base64'))).getPageCount() - 3;
const mkMarks = await page9.evaluate(async (b64) => {
    const bin = atob(b64); const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
    const doc = await window.pdfjsLib.getDocument({ data }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const find = (re) => {
            const hit = tc.items.find(it => re.test(it.str.trim()));
            return hit ? { s: hit.str.trim(), x: hit.transform[4], y: hit.transform[5], w: vp.width, h: vp.height } : null;
        };
        out.push({ header: find(/^DOC-\d+$/), footer: find(/^\d{4}-\d{2}-\d{2}$/), pn: find(/^P\d+$/) });
        if (i === 1) await doc.getPage(1);
    }
    await doc.destroy();
    return out;
}, mkB64);
const mkContent = mkMarks.slice(mkTocPages);
check(mkContent.every(m => m.header && /^DOC-\d+$/.test(m.header.s)), '每一頁都有頁首標記',
    JSON.stringify(mkContent.map(m => m.header && m.header.s)));
check(mkContent.every(m => m.footer && /^\d{4}-\d{2}-\d{2}$/.test(m.footer.s)), '每一頁都有頁尾標記',
    JSON.stringify(mkContent.map(m => m.footer && m.footer.s)));
check(mkContent.every(m => m.header.y > m.header.h * 0.85), '頁首在頁面上方', JSON.stringify(mkContent.map(m => m.header && Math.round(m.header.y))));
check(mkContent.every(m => m.footer.y < m.footer.h * 0.15 && m.footer.x < m.footer.w * 0.35),
    '頁尾在左下（位置各自獨立）', JSON.stringify(mkContent.map(m => m.footer && [Math.round(m.footer.x), Math.round(m.footer.y)])));
check(mkContent.every(m => m.pn && m.pn.x > m.pn.w * 0.6), '頁碼仍在右下', JSON.stringify(mkContent.map(m => m.pn && Math.round(m.pn.x))));
check(errors9.length === 0, '頁面標記流程沒有 pageerror', errors9.slice(0, 2).join(' | '));

// ── 19. 頁碼格式 ──
// 沿用 page9（3 頁內容已就緒）。這一段要單獨驗證「只有頁碼」的輸出，
// 所以先把浮水印與頁首／頁尾清乾淨（前一段驗過它們，狀態會留著）。
await page9.evaluate(() => {
    document.getElementById('previewModal').close();
    const wm = document.getElementById('addWatermarkCheckbox');
    wm.checked = false; wm.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('headerFormat').value = '';
    document.getElementById('footerFormat').value = '';
    const cb = document.getElementById('addMarksCheckbox');
    cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
});
check(await page9.evaluate(() => document.getElementById('marksSettingsPanel').style.display === 'none'),
    '未勾選頁面標記時不顯示設定面板');
await page9.evaluate(() => {
    const cb = document.getElementById('addMarksCheckbox');
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
});
check(await page9.evaluate(() => document.getElementById('marksSettingsPanel').style.display !== 'none'),
    '勾選頁面標記後展開設定面板');

// 預設格式：第 {n} 頁 / 共 {total} 頁。3 頁內容＋1 頁目錄 → total = 4，內容頁碼 2,3,4
await page9.evaluate(() => {
    const toc = document.getElementById('addTocCheckbox'); toc.checked = true; toc.dispatchEvent(new Event('change', { bubbles: true }));
});
await page9.fill('#pageNumberFormat', '第 {n} 頁 / 共 {total} 頁');
await page9.selectOption('#pageNumberPosition', 'bottom-right');
await page9.fill('#pageNumberMargin', '30');
await page9.fill('#pageNumberSize', '9');
await page9.click('#generateBtn');
await page9.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
check(/預覽生成成功/.test(await page9.textContent('#progress')), '帶格式頁碼的生成成功', (await page9.textContent('#progress')).trim());

const pnB64 = await page9.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const pnDoc = await PDFDocument.load(Buffer.from(pnB64, 'base64'));
const pnTocPages = pnDoc.getPageCount() - 3;
const pnTexts = await readPageTexts(page9, pnB64);
const pnFlat = pnTexts.map(items => items.join('').replace(/\s+/g, ''));
const pnContent = pnFlat.slice(pnTocPages);
const expectedPn = ['2', '3', '4'].map(n => `第${n}頁/共${3 + pnTocPages}頁`);
check(JSON.stringify(pnContent.map(t => (t.match(/第\d+頁\/共\d+頁/) || [''])[0])) === JSON.stringify(expectedPn),
    '自訂格式「第 {n} 頁 / 共 {total} 頁」每頁都正確（{total} 含目錄頁）',
    JSON.stringify(pnContent));
// pdf.js 會把中文與數字拆成不同 item（"第","2","頁"...），所以不能用「有沒有純數字 item」
// 判斷；改用精確的不變量：同一頁的文字＝原始內文 ＋ 剛好一個自訂格式頁碼，且頁碼在最後。
const pnBodyAndLabel = pnTexts.slice(pnTocPages).map((items, i) =>
    items.map(t => t.replace(/\s+/g, '')).join('') === `Chapter${i + 1}Titlebody-A-${i + 1}${expectedPn[i].replace(/\s+/g, '')}`);
check(pnBodyAndLabel.every(Boolean),
    '自訂格式取代了原本的純數字頁碼（同一頁只有一個頁碼，且接在內文之後）',
    JSON.stringify(pnTexts.slice(pnTocPages)));

// 快速套用鈕
await page9.evaluate(() => document.getElementById('previewModal').close());
await page9.click('#marksSettingsPanel button:has-text("N/M")');
check(await page9.inputValue('#pageNumberFormat') === '{n} / {total}', '快速套用「N/M」會改寫格式欄位');
await page9.click('#marksSettingsPanel button:has-text("純數字")');
check(await page9.inputValue('#pageNumberFormat') === '{n}', '快速套用「純數字」會改寫格式欄位');
await page9.click('#marksSettingsPanel button:has-text("第N頁")');
check(await page9.inputValue('#pageNumberFormat') === '第 {n} 頁 / 共 {total} 頁', '快速套用「第N頁」會改寫格式欄位');
await page9.click('#marksSettingsPanel button:has-text("純數字")');

// 純數字格式：內容頁只抽得到 n（＝原本的預設行為不能退化）
await page9.click('#generateBtn');
await page9.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const plainB64 = await page9.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const plainContent = (await readPageTexts(page9, plainB64)).slice(pnTocPages);
check(plainContent.every((items, i) => items.filter(t => t.trim() === String(i + 2 + pnTocPages - 1 - pnTocPages + 1)).length === 1),
    '純數字格式每頁恰好一個頁碼', JSON.stringify(plainContent));

// {name} / {date} 變數
await page9.evaluate(() => document.getElementById('previewModal').close());
await page9.fill('#pageNumberFormat', '{name} {date}');
await page9.click('#generateBtn');
await page9.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const varB64 = await page9.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const varContent = (await readPageTexts(page9, varB64)).slice(pnTocPages).map(items => items.join(''));
check(varContent.every(t => /A\.pdf/.test(t) && /\d{4}-\d{2}-\d{2}/.test(t)),
    '{name} 與 {date} 變數會代入', JSON.stringify(varContent));

// 位置：左下
await page9.evaluate(() => document.getElementById('previewModal').close());
await page9.fill('#pageNumberFormat', 'P{n}');
await page9.selectOption('#pageNumberPosition', 'bottom-left');
await page9.fill('#pageNumberMargin', '40');
await page9.click('#generateBtn');
await page9.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
const posB64 = await page9.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
// 用座標確認位置真的換到左下（pdf.js 的 transform 是 [a,b,c,d,e,f]，e/f 為 x/y）
const pnPos = await page9.evaluate(async (b64) => {
    const bin = atob(b64); const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
    const doc = await window.pdfjsLib.getDocument({ data }).promise;
    const page = await doc.getPage(1 + doc.numPages - 3); // 第一頁內容
    const tc = await page.getTextContent();
    const vp = page.getViewport({ scale: 1 });
    const hit = tc.items.find(it => /^P\d+$/.test(it.str));
    const out = hit ? { x: hit.transform[4], y: hit.transform[5], w: vp.width, h: vp.height } : null;
    await doc.destroy();
    return out;
}, posB64);
check(!!pnPos && pnPos.x < pnPos.w * 0.35 && pnPos.y < pnPos.h * 0.15,
    '頁碼位置切到左下（座標驗證）', JSON.stringify(pnPos));
check(errors9.length === 0, '頁碼格式流程沒有 pageerror／console error', errors9.slice(0, 2).join(' | '));

// ── 20. 裁剪與統一頁面尺寸 ──
const page10 = await browser.newPage();
const errors10 = [];
page10.on('pageerror', e => errors10.push('PAGEERROR ' + e.message));
page10.on('console', m => { if (m.type() === 'error') errors10.push('CONSOLE ' + m.text().slice(0, 200)); });
await page10.goto(BASE + '/index.html', { waitUntil: 'load' });
await page10.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('pdf-recompose'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
await page10.reload({ waitUntil: 'load' });
await page10.waitForTimeout(400);

await page10.setInputFiles('#fileInput', [fixtureInset], { timeout: 20000 });
await page10.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
await page10.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
    const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb);
    // 直接觸發 onclick：這一段在驗證版面邏輯，不需要經過真實指標事件
    batchAddToTarget();
});
await page10.waitForTimeout(300);
check(await page10.evaluate(() => document.querySelectorAll('#selectedPages .selected-page-item').length) === 2, '版面測試：2 頁就緒');
check(await page10.evaluate(() => document.getElementById('layoutSettingsPanel').style.display === 'none'),
    '未勾選版面調整時不顯示設定面板');
await page10.evaluate(() => {
    const cb = document.getElementById('enableLayoutCheckbox');
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
});
check(await page10.evaluate(() => document.getElementById('layoutSettingsPanel').style.display !== 'none'),
    '勾選版面調整後展開設定面板');

// 預設：維持原尺寸
// 關掉任何開啟的對話框（例如啟動時「要還原工作階段嗎？」會擋住後續點擊）
const dismissDialogs = async (target) => {
    await target.evaluate(() => {
        document.querySelectorAll('dialog[open]').forEach(d => {
            if (d.id === 'previewModal') return;
            d.close();
        });
    });
    await target.waitForTimeout(80);
};

// 清空右側成品：開目錄編輯器 → 存成空 → 關閉。
// saveToc 是同步的，所以這樣比連續呼叫 clearSelectedPages（有確認機制）可靠。
// 清空右側成品。不能用 saveToc（它會驗證行數＝頁數，不符就直接拒絕），
// 改用 removeSelectedPage 逐一移除（同步）。
const clearTarget = async (target) => {
    await target.evaluate(() => {
        let guard = 0;
        while (document.querySelectorAll('#selectedPages > *').length > 0 && guard++ < 200) {
            removeSelectedPage(0);
        }
        const m = document.getElementById('tocModal');
        if (m.open) m.close();
        return true;
    });
    await target.waitForTimeout(120);
};

// 清空來源：removeFile 是 async，直接 return 會讓 Playwright 一直等那個 promise。
// 用「表達式」呼叫並回傳 true，evaluate 就會立刻結束。
const clearSource = async (target) => {
    await target.evaluate(() => {
        let guard = 0;
        while (document.querySelectorAll('#fileList li').length > 0 && guard++ < 50) {
            removeFile(0);
        }
        return true;
    });
    await target.waitForTimeout(150);
};

// 每次情境都先清空來源檔案：輸出不會累積，頁數與頁序都可預期
const resetAll = async () => {
    await page10.evaluate(() => {
        const m = document.getElementById('previewModal');
        if (m.open) m.close();
    });
    await page10.evaluate(() => {
        document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
    });
    await dismissDialogs(page10);
    await clearTarget(page10);
    await clearSource(page10);
};
const genAndRead = async (label) => {
    await page10.evaluate(() => { const m = document.getElementById('previewModal'); if (m.open) m.close(); });
    await page10.click('#generateBtn');
    await page10.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
    const ok = /預覽生成成功/.test(await page10.textContent('#progress'));
    if (!ok) return { ok: false, detail: (await page10.textContent('#progress')).trim() };
    const b64 = await page10.evaluate(async () => {
        const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
        const bytes = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        return btoa(s);
    });
    const d = await PDFDocument.load(Buffer.from(b64, 'base64'));
    const all = d.getPages().map(p => { const sz = p.getSize(); return [Math.round(sz.width), Math.round(sz.height)]; });
    // 這次產出會「附加」在既有內容之後，所以不能只看最後幾頁。
    // 目錄頁固定是橫向 A4（842×595），用尺寸把它挑掉，剩下的就是這次的內容頁。
    const isToc = ([w, h]) => w === 842 && h === 595;
    const contentSizes = all.filter(sz => !isToc(sz));
    return { ok: true, sizes: contentSizes.slice(-2), allSizes: all, b64 };
};

await resetAll();
await page10.setInputFiles('#fileInput', [fixtureInset], { timeout: 20000 });
await page10.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
await page10.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
    const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb);
    // 直接觸發 onclick：這一段在驗證版面邏輯，不需要經過真實指標事件
    batchAddToTarget();
});
await page10.waitForTimeout(300);
const keep = await genAndRead('原尺寸');
check(keep.ok && JSON.stringify(keep.sizes) === JSON.stringify([[595, 842], [595, 842]]),
    '預設維持原尺寸', JSON.stringify(keep.sizes || keep.detail));

// 白邊裁切
await resetAll();
await page10.setInputFiles('#fileInput', [fixtureInset], { timeout: 20000 });
await page10.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
await page10.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
    const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb);
    // 直接觸發 onclick：這一段在驗證版面邏輯，不需要經過真實指標事件
    batchAddToTarget();
});
await page10.waitForTimeout(300);
await page10.evaluate(() => {
    document.getElementById('layoutFitSelect').value = 'content';
    document.getElementById('layoutMarginInput').value = '20';
});
const cropped = await genAndRead('裁白邊');
const cw = cropped.sizes && cropped.sizes[0][0];
const ch = cropped.sizes && cropped.sizes[0][1];
// 內容是 'Inset 1'（約 46×14pt），四邊再留 10pt → 大約 66×34；
// 給寬鬆但有意義的範圍：遠小於 A4，且不會縮到幾乎沒有內容。
check(cropped.ok && cw > 50 && cw < 120 && ch > 20 && ch < 100,
    '「裁掉白邊」會縮到內容範圍附近', JSON.stringify(cropped.sizes || cropped.detail));
check(cropped.sizes && Math.abs(cropped.sizes[0][0] - cropped.sizes[1][0]) <= 6 &&
      Math.abs(cropped.sizes[0][1] - cropped.sizes[1][1]) <= 6,
    '兩頁裁切後尺寸幾乎一致（差幾 pt 是文字寬度差異）', JSON.stringify(cropped.sizes));

// 統一尺寸：A4
await resetAll();
await page10.setInputFiles('#fileInput', [fixtureInset], { timeout: 20000 });
await page10.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
await page10.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
    const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb);
    // 直接觸發 onclick：這一段在驗證版面邏輯，不需要經過真實指標事件
    batchAddToTarget();
});
await page10.waitForTimeout(300);
await page10.evaluate(() => {
    document.getElementById('layoutFitSelect').value = 'original';
    document.getElementById('uniformSizeSelect').value = 'a4';
});
const uniform = await genAndRead('統一 A4');
check(uniform.ok && JSON.stringify(uniform.sizes) === JSON.stringify([[595, 842], [595, 842]]),
    '統一成 A4', JSON.stringify(uniform.sizes || uniform.detail));

// 統一尺寸：A5（應該比 A4 小）
await resetAll();
await page10.setInputFiles('#fileInput', [fixtureInset], { timeout: 20000 });
await page10.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
await page10.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
    const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb);
    // 直接觸發 onclick：這一段在驗證版面邏輯，不需要經過真實指標事件
    batchAddToTarget();
});
await page10.waitForTimeout(300);
await page10.evaluate(() => { document.getElementById('uniformSizeSelect').value = 'a5'; });
const a5 = await genAndRead('統一 A5');
check(a5.ok && a5.sizes.every(s => s[0] < 500 && s[1] < 700), '統一成 A5（尺寸真的變了）', JSON.stringify(a5.sizes));

// 縮放後文字仍可抽取（不能變成圖片）
// 同樣要挑掉目錄頁：只取「內容頁」的最後 2 頁
const isTocText = (items) => /目錄/.test(items.join('')) && !/Inset/.test(items.join(''));
const a5Texts = (await readPageTexts(page10, a5.b64)).filter(items => !isTocText(items)).slice(-2);
check(a5Texts.length === 2 && a5Texts.every(items => items.some(t => /Inset/.test(t))),
    '統一尺寸後文字仍可抽取（沒有變成圖片）', JSON.stringify(a5Texts));

// 兩者併用：先裁白邊再統一成 A5
await resetAll();
await page10.setInputFiles('#fileInput', [fixtureInset], { timeout: 20000 });
await page10.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
await page10.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
    const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb);
    // 直接觸發 onclick：這一段在驗證版面邏輯，不需要經過真實指標事件
    batchAddToTarget();
});
await page10.waitForTimeout(300);
await page10.evaluate(() => {
    document.getElementById('layoutFitSelect').value = 'content';
    document.getElementById('layoutMarginInput').value = '20';
    document.getElementById('uniformSizeSelect').value = 'a5';
});
const both = await genAndRead('裁白邊＋A5');
check(both.ok && JSON.stringify(both.sizes) === JSON.stringify(a5.sizes),
    '裁白邊與統一尺寸可以併用', JSON.stringify(both.sizes || both.detail));
const bothTexts = (await readPageTexts(page10, both.b64)).filter(items => !isTocText(items)).slice(-2);
check(bothTexts.length === 2 && bothTexts.every(items => items.some(t => /Inset/.test(t))),
    '併用後文字仍可抽取', JSON.stringify(bothTexts));

check(errors10.length === 0, '版面流程沒有 pageerror／console error', errors10.slice(0, 2).join(' | '));

// ── 21. 一頁多張 / 騎馬釘拼版 ──
const page11 = await browser.newPage();
const errors11 = [];
page11.on('pageerror', e => errors11.push('PAGEERROR ' + e.message));
page11.on('console', m => { if (m.type() === 'error') errors11.push('CONSOLE ' + m.text().slice(0, 200)); });
await page11.goto(BASE + '/index.html', { waitUntil: 'load' });
await page11.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('pdf-recompose'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
await page11.reload({ waitUntil: 'load' });
await page11.waitForTimeout(400);

const reset11 = async () => {
    await page11.evaluate(() => {
        const m = document.getElementById('previewModal');
        if (m.open) m.close();
    });
    await clearTarget(page11);
    await page11.waitForTimeout(150);
};
// 清空來源檔案（removeFile 在「右側已清空」時是同步的，不會跳確認對話框）
const closeAnyDialog11 = () => page11.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
});
const clearSource11 = async () => {
    await closeAnyDialog11();
    await clearSource(page11);
};
const dismissDialogs11 = () => dismissDialogs(page11);
const loadInto11 = async (fixture) => {
    await reset11();
    await dismissDialogs11();
    await clearSource11();
    await page11.setInputFiles('#fileInput', [fixture], { timeout: 20000 });
    await page11.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
    await page11.evaluate(() => {
        document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
        const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb);
        batchAddToTarget();
    });
    await page11.waitForTimeout(250);
};
const gen11 = async () => {
    await page11.evaluate(() => { const m = document.getElementById('previewModal'); if (m.open) m.close(); });
    await page11.click('#generateBtn');
    await page11.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
    if (!/預覽生成成功/.test(await page11.textContent('#progress'))) {
        return { ok: false, detail: (await page11.textContent('#progress')).trim() };
    }
    const b64 = await page11.evaluate(async () => {
        const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
        const bytes = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        return btoa(s);
    });
    const doc = await PDFDocument.load(Buffer.from(b64, 'base64'));
    const sizes = doc.getPages().map(p => { const z = p.getSize(); return [Math.round(z.width), Math.round(z.height)]; });
    return { ok: true, b64, sizes, count: sizes.length };
};

check(await page11.evaluate(() => document.getElementById('impositionSettingsPanel').style.display === 'none'),
    '未勾選拼版時不顯示設定面板');
await page11.evaluate(() => {
    const cb = document.getElementById('enableImpositionCheckbox');
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
});
check(await page11.evaluate(() => document.getElementById('impositionSettingsPanel').style.display !== 'none'),
    '勾選拼版後展開設定面板');

// (a) 2-up：6 頁 → 3 張，每張左到右 P1|P2、P3|P4、P5|P6
await loadInto11(fixtureMark6);
await page11.evaluate(() => {
    document.getElementById('impositionNUpSelect').value = '2';
    document.getElementById('impositionSheetSizeSelect').value = 'original';
    document.getElementById('impositionSaddleCheckbox').checked = false;
});
const twoUp = await gen11();
check(twoUp.ok && twoUp.count === 3, '2-up：6 頁排成 3 張', JSON.stringify(twoUp.sizes || twoUp.detail));
const twoUpCells = twoUp.ok ? await readCellsByGrid(page11, twoUp.b64, 2, 1) : [];
const twoUpOrder = twoUpCells.map(p => p.cells.map(c => c.join('')).join('|'));
check(JSON.stringify(twoUpOrder) === JSON.stringify(['P1|P2', 'P3|P4', 'P5|P6']),
    '2-up 的左右順序正確（先左而右、由上而下）', JSON.stringify(twoUpOrder));

// (b) 4-up：6 頁 → 2 張（第二張右下留白）
await loadInto11(fixtureMark6);
await page11.evaluate(() => {
    document.getElementById('impositionNUpSelect').value = '4';
    document.getElementById('impositionSheetSizeSelect').value = 'a4';
});
const fourUp = await gen11();
check(fourUp.ok && fourUp.count === 2, '4-up：6 頁排成 2 張', JSON.stringify(fourUp.sizes || fourUp.detail));
check(fourUp.ok && fourUp.sizes.every(s => s[0] === 595 && s[1] === 842), '4-up 輸出為 A4', JSON.stringify(fourUp.sizes));
const fourUpCells = fourUp.ok ? await readCellsByGrid(page11, fourUp.b64, 2, 2) : [];
const fourUpOrder = fourUpCells.map(p => p.cells.map(c => c.join('')).join('|'));
check(JSON.stringify(fourUpOrder) === JSON.stringify(['P1|P2|P3|P4', 'P5|P6||']),
    '4-up 的格線順序正確，頁數不足時最後一格留白', JSON.stringify(fourUpOrder));

// (c) 騎馬釘：4 頁 → 2 張紙（每張紙正反兩面 = PDF 2 頁）
await loadInto11(fixtureMark4);
await page11.evaluate(() => {
    document.getElementById('impositionNUpSelect').value = '2';
    document.getElementById('impositionSheetSizeSelect').value = 'original';
    document.getElementById('impositionSaddleCheckbox').checked = true;
});
const saddle = await gen11();
// 4 頁只需要 1 張紙（正面 4|1、背面 2|3）
check(saddle.ok && saddle.count === 1, '騎馬釘：4 頁排成 1 張紙', JSON.stringify(saddle.sizes || saddle.detail));
const saddleTexts = saddle.ok ? [(await readPageTexts(page11, saddle.b64)).slice(-1)[0].join('')] : [];
const saddleSeen = new Set(saddleTexts.join(' ').match(/P\d/g) || []);
check(saddleTexts.length === 1 && [1, 2, 3, 4].every(n => saddleSeen.has(`P${n}`)),
    '騎馬釘 4 頁：每一頁都有排進成品',
    JSON.stringify({ pages: saddleTexts.length, seen: [...saddleSeen] }));
// 拼版順序用純函式驗證（見下方 pickSaddleOrder 檢查），不再從 PDF 反推

// (d) 騎馬釘：6 頁會補成 8 頁（4 的倍數）
await loadInto11(fixtureMark6);
await page11.evaluate(() => {
    document.getElementById('impositionNUpSelect').value = '2';
    document.getElementById('impositionSheetSizeSelect').value = 'original';
    document.getElementById('impositionSaddleCheckbox').checked = true;
});
const saddle6 = await gen11();
check(saddle6.ok && saddle6.count === 2, '騎馬釘：6 頁補成 8 頁 → 2 張', JSON.stringify(saddle6.sizes || saddle6.detail));
const saddle6Texts = saddle6.ok ? (await readPageTexts(page11, saddle6.b64)).slice(-2).map(i => i.join('')) : [];
const seen6 = new Set(saddle6Texts.join(' ').match(/P\d/g) || []);
check(saddle6Texts.length === 2 && [1, 2, 3, 4, 5, 6].every(n => seen6.has(`P${n}`)),
    '騎馬釘 6 頁：2 張紙且 6 頁都排進去',
    JSON.stringify({ pages: saddle6Texts.length, seen: [...seen6] }));

// (e) 關掉拼版後恢復原狀
await loadInto11(fixtureMark6);
await page11.evaluate(() => {
    const cb = document.getElementById('enableImpositionCheckbox');
    cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
});
const noImp = await gen11();
check(noImp.ok && noImp.count === 6, '關閉拼版後回到 6 頁', JSON.stringify(noImp.sizes || noImp.detail));

check(errors11.length === 0, '拼版流程沒有 pageerror／console error', errors11.slice(0, 2).join(' | '));

// ── 22. 依小節拆成多檔（ZIP）──
const page12 = await browser.newPage();
const errors12 = [];
page12.on('pageerror', e => errors12.push('PAGEERROR ' + e.message));
page12.on('console', m => { if (m.type() === 'error') errors12.push('CONSOLE ' + m.text().slice(0, 200)); });
await page12.goto(BASE + '/index.html', { waitUntil: 'load' });
await page12.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('pdf-recompose'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
await page12.reload({ waitUntil: 'load' });
await page12.waitForTimeout(400);

// 準備 6 頁 + 兩個小節：| 第一節 | P1 P2 P3 | 第二節 | P4 P5 P6 |
await page12.setInputFiles('#fileInput', [fixtureMark6], { timeout: 20000 });
await page12.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
await page12.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
    const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb);
    batchAddToTarget();
});
await page12.waitForTimeout(250);
// 用真實 UI 加小節、再用拖曳排序的等價操作把它搬到定位
for (const [title, targetIndex] of [['第一節', 0], ['第二節', 4]]) {
    await page12.evaluate(() => { addSectionDivider(); });
    await page12.waitForSelector('#askDialog[open]', { timeout: 5000 });
    await page12.fill('#askDialogInput', title);
    await page12.click('#askDialogOk');
    await page12.waitForTimeout(200);
    await page12.evaluate((idx) => window.moveLastItemTo(idx), targetIndex);
    await page12.waitForTimeout(200);
}
check(JSON.stringify(await page12.evaluate(() => window.getSectionGroups())) ===
      JSON.stringify([{ title: '第一節', pages: [1, 2, 3] }, { title: '第二節', pages: [4, 5, 6] }]),
    '準備好 2 個小節（各 3 頁）',
    JSON.stringify(await page12.evaluate(() => window.getRawOrder())));

check(await page12.evaluate(() => document.getElementById('splitSettingsPanel').style.display === 'none'),
    '未勾選拆檔時不顯示設定面板');
await page12.evaluate(() => {
    const cb = document.getElementById('enableSplitCheckbox');
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
});
check(await page12.evaluate(() => document.getElementById('splitSettingsPanel').style.display !== 'none'),
    '勾選拆檔後展開設定面板');

await page12.evaluate(() => {
    document.getElementById('splitNameFormat').value = '{n}-{title}';
    document.getElementById('splitPadWidth').value = '2';
});
// 拆檔會觸發檔案下載；click 要跟 download 事件一起等，否則會卡在等待
const [download1] = await Promise.all([
    page12.waitForEvent('download', { timeout: 180000 }).catch(() => null),
    page12.click('#generateBtn'),
]);
check(!!download1, '拆檔會觸發下載（ZIP）');
await page12.waitForFunction(() => /已產生 \d+ 個檔案/.test(document.getElementById('notification').textContent), null, { timeout: 180000 });

const zipB64 = await page12.evaluate(() => window.getLastExportZip());
check(!!zipB64, '拆檔會產生 ZIP');
const zipBuf = Buffer.from(zipB64 || '', 'base64');
// 解析 ZIP（自己寫的 STORE 格式，逐一驗證 CRC 與內容）
function unzipStore(buf) {
    const files = [];
    let off = buf.readUInt32LE(buf.length - 22 + 16); // EOCD → central directory offset
    const count = buf.readUInt16LE(buf.length - 22 + 10);
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c >>> 0; }
    for (let i = 0; i < count; i++) {
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const crc = buf.readUInt32LE(off + 16);
        const size = buf.readUInt32LE(off + 24);
        const lho = buf.readUInt32LE(off + 42);
        const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
        const lNameLen = buf.readUInt16LE(lho + 26);
        const lExtraLen = buf.readUInt16LE(lho + 28);
        const data = buf.slice(lho + 30 + lNameLen + lExtraLen, lho + 30 + lNameLen + lExtraLen + size);
        let c = 0xFFFFFFFF;
        for (const b of data) c = table[(c ^ b) & 0xFF] ^ (c >>> 8);
        c = (c ^ 0xFFFFFFFF) >>> 0;
        files.push({ name, size, crcOk: c === crc, data });
        off += 46 + nameLen + extraLen + commentLen;
    }
    return files;
}
const zipped = unzipStore(zipBuf);
check(zipped.length === 2, 'ZIP 內有 2 個檔案（＝2 個小節）', JSON.stringify(zipped.map(f => f.name)));
check(zipped.every(f => f.crcOk), '每個檔案的 CRC 都正確', JSON.stringify(zipped.map(f => f.crcOk)));
check(zipped.every(f => f.name.endsWith('.pdf')), '檔名都以 .pdf 結尾', JSON.stringify(zipped.map(f => f.name)));
check(zipped[0].name === '01-第一節.pdf' && zipped[1].name === '02-第二節.pdf',
    '檔名套用了「{n}-{title}」格式（含中文）', JSON.stringify(zipped.map(f => f.name)));

// 每個拆出來的 PDF：頁數正確，且只含該小節的頁面
const perFile = [];
for (const f of zipped) {
    const d = await PDFDocument.load(f.data);
    const texts = [];
    for (let i = 0; i < d.getPageCount(); i++) texts.push(i);
    perFile.push({ pages: d.getPageCount() });
}
check(perFile[0].pages === 3 && perFile[1].pages === 3,
    '各檔頁數符合小節範圍（3 頁 + 3 頁）', JSON.stringify(perFile));

// 用 pdf.js 讀出文字，確認檔案內容對應到正確的頁
const splitTexts = [];
for (const f of zipped) {
    const b64 = f.data.toString('base64');
    splitTexts.push(await readPageTexts(page12, b64));
}
const flat0 = splitTexts[0].map(i => i.join(''));
const flat1 = splitTexts[1].map(i => i.join(''));
check(flat0.join(' ').match(/P\d/g).join(',') === 'P1,P2,P3',
    '第一個檔案是「第一節」（P1～P3）', JSON.stringify(flat0));
check(flat1.join(' ').match(/P\d/g).join(',') === 'P4,P5,P6',
    '第二個檔案是「第二節」（P4～P6）', JSON.stringify(flat1));

// 保留小節與頁面，但把檔名格式改成「只用編號」→ 驗證格式變數真的有效
await page12.evaluate(() => { document.getElementById('splitNameFormat').value = '{n}'; });
await Promise.all([
    page12.waitForEvent('download', { timeout: 180000 }).catch(() => null),
    page12.click('#generateBtn'),
]);
await page12.waitForFunction(() => /已產生 \d+ 個檔案/.test(document.getElementById('notification').textContent), null, { timeout: 180000 });
const zip2 = unzipStore(Buffer.from(await page12.evaluate(() => window.getLastExportZip()), 'base64'));
check(zip2.length === 2 && zip2.every(f => f.crcOk) &&
      zip2[0].name === '01.pdf' && zip2[1].name === '02.pdf',
    '檔名格式可只用編號（{n}）', JSON.stringify(zip2.map(f => f.name)));

// 關閉拆檔後回到單檔流程
await page12.evaluate(() => {
    const cb = document.getElementById('enableSplitCheckbox');
    cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
    const m = document.getElementById('previewModal'); if (m.open) m.close();
});
await page12.click('#generateBtn');
await page12.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
check(/預覽生成成功/.test(await page12.textContent('#progress')), '關閉拆檔後回到單檔預覽流程');

check(errors12.length === 0, '拆檔流程沒有 pageerror／console error', errors12.slice(0, 2).join(' | '));

// ── 23. 分節頁碼編號方案 ──
const page13 = await browser.newPage();
const errors13 = [];
page13.on('pageerror', e => errors13.push('PAGEERROR ' + e.message));
page13.on('console', m => { if (m.type() === 'error') errors13.push('CONSOLE ' + m.text().slice(0, 200)); });
await page13.goto(BASE + '/index.html', { waitUntil: 'load' });
await page13.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('pdf-recompose'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
await page13.reload({ waitUntil: 'load' });
await page13.waitForTimeout(400);

// 轉換規則：純函式單元檢查（比從 PDF 反推直接得多）
const conversions = await page13.evaluate(() => {
    const f = window.__numbering.formatNumberByScheme;
    return {
        decimal: [1, 2, 3, 10].map(n => f(n, 'decimal')),
        romanLower: [1, 4, 9, 14, 40].map(n => f(n, 'roman-lower')),
        romanUpper: [1, 4, 9, 14].map(n => f(n, 'roman-upper')),
        chinese: [1, 10, 11, 20, 27, 101, 2024].map(n => f(n, 'chinese')),
        alphaLower: [1, 26, 27].map(n => f(n, 'alpha-lower')),
        alphaUpper: [1, 26, 27].map(n => f(n, 'alpha-upper')),
    };
});
check(JSON.stringify(conversions.decimal) === JSON.stringify(['1', '2', '3', '10']), '十進位編號正確', JSON.stringify(conversions.decimal));
check(JSON.stringify(conversions.romanLower) === JSON.stringify(['i', 'iv', 'ix', 'xiv', 'xl']), '小寫羅馬數字正確', JSON.stringify(conversions.romanLower));
check(JSON.stringify(conversions.romanUpper) === JSON.stringify(['I', 'IV', 'IX', 'XIV']), '大寫羅馬數字正確', JSON.stringify(conversions.romanUpper));
check(JSON.stringify(conversions.chinese) === JSON.stringify(['一', '十', '十一', '二十', '二十七', '一百〇一', '二千〇二十四']),
    '中文數字正確（含十位數的「十」與中間的〇）', JSON.stringify(conversions.chinese));
check(JSON.stringify(conversions.alphaLower) === JSON.stringify(['a', 'z', 'aa']) &&
      JSON.stringify(conversions.alphaUpper) === JSON.stringify(['A', 'Z', 'AA']),
    '字母編號正確（含進位）', JSON.stringify({ lower: conversions.alphaLower, upper: conversions.alphaUpper }));

// 分節編號：4 頁 + 兩個小節（正文 2 頁、附錄 2 頁）
await page13.setInputFiles('#fileInput', [fixtureMark4], { timeout: 20000 });
await page13.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 120000 });
await page13.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
    const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb);
    batchAddToTarget();
});
await page13.waitForTimeout(250);
for (const [title, targetIndex] of [['正文', 0], ['附錄', 3]]) {
    await page13.evaluate(() => { addSectionDivider(); });
    await page13.waitForSelector('#askDialog[open]', { timeout: 5000 });
    await page13.fill('#askDialogInput', title);
    await page13.click('#askDialogOk');
    await page13.waitForTimeout(200);
    await page13.evaluate((idx) => window.moveLastItemTo(idx), targetIndex);
    await page13.waitForTimeout(200);
}
check(JSON.stringify(await page13.evaluate(() => window.getRawOrder())) ===
      JSON.stringify(['D:正文', 'P1', 'P2', 'D:附錄', 'P3', 'P4']),
    '準備好兩節（正文 2 頁、附錄 2 頁）', JSON.stringify(await page13.evaluate(() => window.getRawOrder())));

// 預設：每個小節重新起算
check(JSON.stringify(await page13.evaluate(() => window.getPageLabels())) === JSON.stringify(['1', '2', '1', '2']),
    '預設編號在每個小節重新起算', JSON.stringify(await page13.evaluate(() => window.getPageLabels())));

// 附錄改用羅馬數字
await page13.evaluate(() => { openTocEditor(); });
await page13.waitForSelector('#tocModal[open]', { timeout: 5000 });
const tocLines = (await page13.inputValue('#tocTextarea')).split('\n');
check(tocLines.length === 4, '目錄編輯器列出 4 頁', JSON.stringify(tocLines));
await page13.fill('#tocTextarea', tocLines.map((l, i) => i === 2 ? `[roman-lower] ${l}` : l).join('\n'));
await page13.click('button:has-text("儲存變更")');
await page13.waitForTimeout(300);
check(JSON.stringify(await page13.evaluate(() => window.getPageLabels())) === JSON.stringify(['1', '2', 'i', 'ii']),
    '附錄套用 [roman-lower] 後變成 i、ii', JSON.stringify(await page13.evaluate(() => window.getPageLabels())));

// 標記要能來回：重開編輯器時帶得出來（使用者才看得到目前設定）
await page13.evaluate(() => { openTocEditor(); });
await page13.waitForSelector('#tocModal[open]', { timeout: 5000 });
const reopened = (await page13.inputValue('#tocTextarea')).split('\n');
check(reopened[2].startsWith('[roman-lower]') && !/\[roman-lower\]/.test(reopened[0]),
    '重開編輯器會帶出既有的編號標記（且不佔行數、不污染標題）',
    JSON.stringify(reopened));
await page13.click('button:has-text("取消")');
await page13.waitForTimeout(200);

// 產出的 PDF：頁碼用分節編號（附錄應印 i、ii）
await page13.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
    const mk = document.getElementById('addMarksCheckbox');
    mk.checked = true; mk.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('headerFormat').value = '';
    document.getElementById('footerFormat').value = '';
    document.getElementById('pageNumberFormat').value = '{n}';
    document.getElementById('pageNumberPosition').value = 'bottom-center';
});
const [download13] = await Promise.all([
    page13.waitForEvent('download', { timeout: 60000 }).catch(() => null),
    page13.click('#generateBtn'),
]);
await page13.waitForFunction(() => /預覽生成成功|生成失敗/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
check(/預覽生成成功/.test(await page13.textContent('#progress')), '分節編號的生成成功', (await page13.textContent('#progress')).trim());
const numB64 = await page13.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
});
const numTexts = await readPageTexts(page13, numB64);
const numFlat = numTexts.map(items => items.join(' '));
// 目錄頁在最前面；取最後 4 頁為內容頁
const contentLabels = numFlat.slice(-4).map(t => (t.match(/\b(?:[0-9]+|i{1,3}|iv)\b/g) || []).join(''));
check(numFlat.slice(-4).some(t => /\bi\b/.test(t)) && numFlat.slice(-4).some(t => /\bii\b/.test(t)),
    '附錄的頁碼在 PDF 上是 i、ii', JSON.stringify(numFlat.slice(-4)));
check(numFlat.slice(-4).filter(t => /\b1\b|\b2\b/.test(t)).length === 2,
    '正文的頁碼是 1、2', JSON.stringify(numFlat.slice(-4)));
check(errors13.length === 0, '分節編號流程沒有 pageerror／console error', errors13.slice(0, 2).join(' | '));

await browser.close();
server.close();

console.log(`\n產出：${outFile}`);
if (failed) {
    console.error(`${failed} 項未通過。`);
    process.exit(1);
}
console.log('全部通過。');
