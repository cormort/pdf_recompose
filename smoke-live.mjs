// 線上站完整煙霧測試：對 https://cormort.github.io/pdf_recompose/ 跑真實流程
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
function loadUmd(f, g) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const a = process.stdout.write, b = process.stderr.write;
    process.stdout.write = () => true; process.stderr.write = () => true;
    try { runInThisContext(src, { filename: f }); } finally { process.stdout.write = a; process.stderr.write = b; }
    return globalThis[g];
}
const { PDFDocument, StandardFonts } = loadUmd('./pdf-lib.min.js', 'PDFLib');
const fontkit = loadUmd('./fontkit.umd.min.js', 'fontkit');
const { chromium } = require(process.env.PW_MODULE);
const BASE = 'https://cormort.github.io/pdf_recompose';
let failed = 0;
const check = (ok, label, detail) => {
    if (ok) { console.log(`✓ ${label}`); return; }
    failed++;
    console.error(`✗ ${label}${detail ? '：' + detail : ''}`);
};

const cjk = readFileSync(join(process.cwd(), 'fonts/NotoSansTC-Regular.ttf'));
async function makePdf(name, pages, opts = {}) {
    const doc = await PDFDocument.create();
    let font;
    if (opts.cjk) { doc.registerFontkit(fontkit); font = await doc.embedFont(cjk, { subset: true }); }
    else font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) {
        const p = doc.addPage(opts.size || [595, 842]);
        p.drawText(opts.cjk ? `第${i + 1}章 中文` : `P${i + 1}`, { x: 230, y: 400, size: 28, font });
    }
    const dir = mkdtempSync(join(tmpdir(), 'smoke2-'));
    const f = join(dir, `${name}.pdf`);
    writeFileSync(f, await doc.save());
    return f;
}
const f4 = await makePdf('四頁', 4);
const fCjk = await makePdf('中文', 2, { cjk: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200)); });
page.on('response', r => { if (r.status() >= 400 && !r.url().includes('googletagmanager')) errors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(BASE + '/index.html', { waitUntil: 'load' });
check(await page.evaluate(() => typeof window.getLastExportZip === 'function'), '線上版本已含新版拆檔功能');

// 清掉工作階段，從乾淨狀態開始
await page.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('pdf-recompose'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(500);

const resetAll = async () => {
    await page.evaluate(() => {
        document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
        let guard = 0;
        while (document.querySelectorAll('#selectedPages > *').length > 0 && guard++ < 200) removeSelectedPage(0);
        while (document.querySelectorAll('#fileList li').length > 0 && guard++ < 200) removeFile(0);
        return true;
    });
    await page.waitForTimeout(150);
};
const loadAll = async (file) => {
    await resetAll();
    await page.setInputFiles('#fileInput', [file]);
    await page.waitForFunction(() => /載入完成|累計/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
    await page.evaluate(() => {
        const cb = document.getElementById('selectAllSource'); cb.checked = true; toggleSelectAllSource(cb);
        batchAddToTarget();
    });
    await page.waitForTimeout(250);
};
const generate = async () => {
    await page.evaluate(() => { const m = document.getElementById('previewModal'); if (m.open) m.close(); });
    const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 120000 }).catch(() => null),
        page.click('#generateBtn'),
    ]);
    await page.waitForFunction(() => /預覽生成成功|生成失敗|已產生/.test(document.getElementById('progress').textContent) ||
        /已產生|生成失敗/.test(document.getElementById('notification').textContent), null, { timeout: 180000 });
    return dl;
};
const readPreviewTexts = async () => page.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const data = new Uint8Array(buf);
    const doc = await window.pdfjsLib.getDocument({ data }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        out.push(tc.items.map(x => x.str).join(' '));
    }
    await doc.destroy();
    return out;
});

// 1. 載入 + 縮圖 + 合併（中文檔）
await loadAll(fCjk);
check(await page.evaluate(() => document.querySelectorAll('#selectedPages .selected-page-item').length) === 2, '載入中文 PDF 並加入右側');
check(await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('#sourcePages img.page-thumb-img')];
    return imgs.length >= 2 && document.querySelectorAll('canvas').length === 0;
}), '縮圖是可見的 <img>、頁面無殘留 canvas');

// 2. 目錄 + 頁碼（分節編號）
await page.evaluate(() => {
    const mk = document.getElementById('addMarksCheckbox'); mk.checked = true; mk.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('headerFormat').value = 'DOC-{n}';
    document.getElementById('footerFormat').value = '';
    document.getElementById('pageNumberFormat').value = '第 {n} 頁 / 共 {total} 頁';
    document.getElementById('pageNumberPosition').value = 'bottom-center';
});
await generate();
check(/預覽生成成功/.test(await page.textContent('#progress')), '生成含頁首／頁碼的 PDF', (await page.textContent('#progress')).trim());
const marksTexts = await readPreviewTexts();
check(marksTexts.some(t => /DOC-1/.test(t)), '頁首標記有印出來', JSON.stringify(marksTexts.map(t => t.slice(0, 30))));
console.log('[dbg] 含標記的文字 =', JSON.stringify(marksTexts.map(t => t.slice(0, 60))));
const joined = marksTexts.join('|').replace(/\s+/g, '');
check(/第1頁\/共2頁/.test(joined), '頁碼有印出來', JSON.stringify(marksTexts.map(t => t.slice(0, 60))));
check(marksTexts.some(t => /中文/.test(t)), '中文內容可被抽取');

// 3. 浮水印
await page.evaluate(() => {
    const wm = document.getElementById('addWatermarkCheckbox'); wm.checked = true; wm.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('watermarkText').value = '機密';
    document.getElementById('watermarkLayout').value = 'center';
});
await generate();
const wmTexts = await readPreviewTexts();
check(wmTexts.every(t => /機密/.test(t)), '每一頁都有浮水印', JSON.stringify(wmTexts.map(t => (t.match(/機密/g) || []).length)));

// 4. 版面調整（裁白邊 + 統一 A5）
await page.evaluate(() => {
    const wm = document.getElementById('addWatermarkCheckbox'); wm.checked = false; wm.dispatchEvent(new Event('change', { bubbles: true }));
    const lay = document.getElementById('enableLayoutCheckbox'); lay.checked = true; lay.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('layoutFitSelect').value = 'content';
    document.getElementById('layoutMarginInput').value = '20';
    document.getElementById('uniformSizeSelect').value = 'a5';
});
await generate();
const layoutSizes = await page.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const data = new Uint8Array(buf);
    const doc = await window.pdfjsLib.getDocument({ data }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) { const vp = (await doc.getPage(i)).getViewport({ scale: 1 }); out.push([Math.round(vp.width), Math.round(vp.height)]); }
    await doc.destroy();
    return out;
});
check(layoutSizes.every(([w, h]) => w === 420 && h === 595), '裁白邊＋統一 A5 生效', JSON.stringify(layoutSizes));

// 5. 一頁多張（2-up）
await page.evaluate(() => {
    const lay = document.getElementById('enableLayoutCheckbox'); lay.checked = false; lay.dispatchEvent(new Event('change', { bubbles: true }));
    const imp = document.getElementById('enableImpositionCheckbox'); imp.checked = true; imp.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('impositionNUpSelect').value = '2';
    document.getElementById('impositionSheetSizeSelect').value = 'original';
    document.getElementById('impositionSaddleCheckbox').checked = false;
});
await generate();
const twoUpPages = await page.evaluate(async () => {
    const buf = await (await fetch(document.getElementById('previewFrame').src)).arrayBuffer();
    const data = new Uint8Array(buf);
    const doc = await window.pdfjsLib.getDocument({ data }).promise;
    const n = doc.numPages;
    await doc.destroy();
    return n;
});
check(twoUpPages === 1, '2-up：2 頁排成 1 張', String(twoUpPages));

// 6. 依小節拆檔（ZIP 下載）
await page.evaluate(() => {
    const imp = document.getElementById('enableImpositionCheckbox'); imp.checked = false; imp.dispatchEvent(new Event('change', { bubbles: true }));
    const sp = document.getElementById('enableSplitCheckbox'); sp.checked = true; sp.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('splitNameFormat').value = '{n}-{title}';
});
// 先加一個小節（用真實 UI）
await page.evaluate(() => { addSectionDivider(); });
await page.waitForSelector('#askDialog[open]', { timeout: 10000 });
await page.fill('#askDialogInput', '第一部分');
await page.click('#askDialogOk');
await page.waitForTimeout(250);
await page.evaluate(() => window.moveLastItemTo(0));
await page.waitForTimeout(250);
const dl = await generate();
check(!!dl, '拆檔觸發下載（ZIP）');
await page.waitForFunction(() => /已產生 \d+ 個檔案/.test(document.getElementById('notification').textContent), null, { timeout: 120000 });
const zipB64 = await page.evaluate(() => window.getLastExportZip());
check(!!zipB64, '可取回 ZIP 內容');
if (zipB64) {
    const buf = Buffer.from(zipB64, 'base64');
    const count = buf.readUInt16LE(buf.length - 22 + 10);
    let off = buf.readUInt32LE(buf.length - 22 + 16);
    const names = [];
    for (let i = 0; i < count; i++) {
        const nameLen = buf.readUInt16LE(off + 28);
        names.push(buf.slice(off + 46, off + 46 + nameLen).toString('utf8'));
        off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
    }
    check(count >= 1 && names.every(n => n.endsWith('.pdf')), 'ZIP 內是 PDF 檔', JSON.stringify(names));
}

// 7. 復原／重做
await page.evaluate(() => {
    const sp = document.getElementById('enableSplitCheckbox'); sp.checked = false; sp.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
});
// 先做一個明確的動作（再加一張），這樣 undo 的頂端一定是這個動作，
// 不會被前面測試自己清空產生的歷史蓋掉
const beforeAdd = await page.evaluate(() => document.querySelectorAll('#selectedPages > *').length);
await page.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { if (d.id !== 'previewModal') d.close(); });
    clearAllSourceChecks();
    toggleSourceCheck(0, 0);
    batchAddToTarget();
});
await page.waitForTimeout(250);
const afterAdd = await page.evaluate(() => document.querySelectorAll('#selectedPages > *').length);
check(afterAdd === beforeAdd + 1, '新增一張作為復原的目標', JSON.stringify({ beforeAdd, afterAdd }));
await page.click('#undoBtn');
await page.waitForTimeout(250);
const afterUndo = await page.evaluate(() => document.querySelectorAll('#selectedPages > *').length);
check(afterUndo === beforeAdd, '復原會退回上一個動作', JSON.stringify({ beforeAdd, afterUndo }));
await page.click('#redoBtn');
await page.waitForTimeout(250);
const afterRedo = await page.evaluate(() => document.querySelectorAll('#selectedPages > *').length);
check(afterRedo === afterAdd, '重做會回到復原前', JSON.stringify({ afterAdd, afterRedo }));

// 8. 工作階段還原（重整後詢問）
await page.evaluate(() => window.flushSessionSave());
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('#askDialog[open]', { timeout: 20000 });
const prompt = await page.evaluate(() => document.getElementById('askDialogTitle').textContent);
check(/還原/.test(prompt), '重整後詢問是否還原工作階段', prompt);
await page.click('#askDialogOk');
await page.waitForFunction(() => /已還原/.test(document.getElementById('progress').textContent), null, { timeout: 180000 });
await page.waitForTimeout(500);
const restored = await page.evaluate(() => ({
    files: document.querySelectorAll('#fileList li').length,
    target: document.querySelectorAll('#selectedPages > *').length,
}));
check(restored.files >= 1 && restored.target >= 1, '工作階段還原成功', JSON.stringify(restored));

check(errors.length === 0, '全程無 pageerror／console error／HTTP 4xx', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failed ? `\n${failed} 項未通過。` : '\n線上完整煙霧測試全部通過。');
process.exit(failed ? 1 : 0);
