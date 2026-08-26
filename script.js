// ==========================================================
// ===   主程式進入點 (window.onload)
// ==========================================================
window.onload = function() {

    // ------------------------------------------------------
    // 1. 函式庫設定與全域變數 (Configuration & State)
    // ------------------------------------------------------
    
    // 設定 PDF.js worker 路徑
    pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';

    // 資料儲存容器
    let pdfFiles = [];          // 存放載入的 PDF 檔案資訊
    let selectedPages = [];     // 存放右側已選擇的頁面資訊
    
    // 介面狀態變數
    let viewMode = 'list';      // 左側檢視模式 (list/grid)
    let thumbnailSize = 'medium'; // 左側縮圖大小

    // ✅ [修正 2] 預設改為清單顯示
    let targetViewMode = 'list'; // 右側檢視模式 (原本是 'grid')
    let targetThumbnailSize = 'medium'; // 右側縮圖大小

    // 操作輔助變數
    let lastSourceClickGlobalIndex = null; // (Shift多選) 上次點擊的全域索引
    let clearFilesConfirmMode = false;    // 清除檔案確認鎖
    let clearSelectedConfirmMode = false; // 清除已選確認鎖

    // PDF 預覽相關
    let finalPdfBytes = null;
    let currentPreviewUrl = null;

    // ------------------------------------------------------
    // 2. 函式庫檢查 (Dependency Check)
    // ------------------------------------------------------
    if (typeof PDFLib === 'undefined') {
        console.error("CRITICAL: PDFLib is not defined!");
        showNotification("錯誤：PDF 編輯函式庫 (pdf-lib.min.js) 載入失敗。", 'error');
        return;
    }
    if (typeof fontkit === 'undefined') {
        console.error("CRITICAL: fontkit is not defined!");
        showNotification("錯誤：字型工具函式庫 (fontkit.umd.min.js) 載入失敗。", 'error');
        return;
    }
    if (typeof Sortable === 'undefined') {
        console.error("CRITICAL: Sortable is not defined!");
        showNotification("錯誤：拖曳函式庫 (sortable.min.js) 載入失敗。", 'error');
        return;
    }

    // ------------------------------------------------------
    // 3. DOM 元素快取 (DOM Elements)
    // ------------------------------------------------------
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const fileList = document.getElementById('fileList');
    const sourcePanel = document.getElementById('sourcePanel');
    const sourcePages = document.getElementById('sourcePages');
    const selectedPagesContainer = document.getElementById('selectedPages');
    const progress = document.getElementById('progress');
    const tocModal = document.getElementById('tocModal');
    const tocTextarea = document.getElementById('tocTextarea');
    const notification = document.getElementById('notification');
    const addTocCheckbox = document.getElementById('addTocCheckbox');
    const tocSettingsPanel = document.getElementById('tocSettingsPanel');
    const previewModal = document.getElementById('previewModal');

    // ------------------------------------------------------
    // 4. 公開函式註冊 (Export to Window)
    // 說明：為了讓 HTML 中的 onclick="" 能夠呼叫，必須掛載到 window 下
    // ------------------------------------------------------
    
    // 基礎與檔案操作
    window.updateFileList = updateFileList;
    window.removeFile = removeFile;
    window.clearAllFiles = clearAllFiles;
    
    // 左側 (來源) 面板操作
    window.setViewMode = setViewMode;
    window.setThumbnailSize = setThumbnailSize;
    window.toggleSourceCheck = toggleSourceCheck;
    window.toggleSelectAllSource = toggleSelectAllSource;
    window.batchAddToTarget = batchAddToTarget;
    window.batchDeleteFromSource = batchDeleteFromSource;
    window.batchRotateSource = batchRotateSource;
    window.updateQuickSelectFileOptions = updateQuickSelectFileOptions;
    window.applyQuickSelection = applyQuickSelection;
    window.clearAllSourceChecks = clearAllSourceChecks;

    // 右側 (成品) 面板操作
    window.setTargetViewMode = setTargetViewMode;
    window.setTargetThumbnailSize = setTargetThumbnailSize;
    window.toggleTargetCheck = toggleTargetCheck;
    window.toggleSelectAllTarget = toggleSelectAllTarget;
    window.applyTargetQuickSelection = applyTargetQuickSelection;
    window.batchRotateTarget = batchRotateTarget;
    window.batchDeleteFromTarget = batchDeleteFromTarget;
    window.removeSelectedPage = removeSelectedPage;
    window.clearSelectedPages = clearSelectedPages;
    window.addSectionDivider = addSectionDivider;

    // 目錄與設定
    window.openTocEditor = openTocEditor;
    window.closeTocEditor = closeTocEditor;
    window.saveToc = saveToc;
    window.resetTocSettings = resetTocSettings;

    // PDF 生成與預覽
    window.generatePDF = generatePDF;
    window.downloadGeneratedPDF = downloadGeneratedPDF;
    window.closePreview = closePreview;

    // ------------------------------------------------------
    // 5. 事件監聽器綁定 (Event Listeners)
    // ------------------------------------------------------
    
    // 拖曳上傳
    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); uploadArea.classList.add('drag-over'); });
    uploadArea.addEventListener('dragleave', () => { uploadArea.classList.remove('drag-over'); });
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
        handleFiles(files);
    });
    fileInput.addEventListener('change', (e) => { handleFiles(Array.from(e.target.files)); });

    // 全視窗拖放：在視窗任意位置拖入 PDF 皆可載入
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('drag-over');
    });
    window.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget) uploadArea.classList.remove('drag-over');
    });
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
        if (files.length > 0) handleFiles(files);
    });

    // Modal 點擊背景關閉 (dialog 的 backdrop 點擊 target 會是 dialog 本身)
    tocModal.addEventListener('click', (e) => { if (e.target === tocModal) tocModal.close(); });
    previewModal.addEventListener('click', (e) => { if (e.target === previewModal) previewModal.close(); });
    // Esc / close() 統一在此清理預覽資源
    previewModal.addEventListener('close', () => {
        document.getElementById('previewFrame').src = 'about:blank';
        if (currentPreviewUrl) {
            URL.revokeObjectURL(currentPreviewUrl);
            currentPreviewUrl = null;
        }
        finalPdfBytes = null;
    });

    // 目錄設定面板切換
    addTocCheckbox.addEventListener('change', function() {
        tocSettingsPanel.style.display = this.checked ? 'block' : 'none';
    });

    // ------------------------------------------------------
    // 6. 初始化執行 (Initialization)
    // ------------------------------------------------------
    setViewMode(viewMode);   // 讓來源面板按鈕狀態與程式預設 (list) 一致
    setThumbnailSize('medium'); // 設定預設縮圖大小

    // 確保右側預設按鈕狀態正確
    setTargetViewMode(targetViewMode);
    setTargetThumbnailSize(targetThumbnailSize);

    if (addTocCheckbox.checked) {
        tocSettingsPanel.style.display = 'block';
    }
    setupDragAndDrop(); // Sortable 綁在容器上，初始化一次即可

    // 左右面板寬度調整
    (function initPanelResizer() {
        const resizer = document.getElementById('panelResizer');
        if (!resizer) return;
        resizer.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            resizer.setPointerCapture(e.pointerId);
            resizer.classList.add('dragging');
            const onMove = (ev) => {
                const rect = sourcePanel.parentElement.getBoundingClientRect();
                const ratio = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
                sourcePanel.style.flex = `${ratio}`;
                document.getElementById('targetPanel').style.flex = `${1 - ratio}`;
            };
            const onUp = () => {
                resizer.classList.remove('dragging');
                resizer.removeEventListener('pointermove', onMove);
                resizer.removeEventListener('pointerup', onUp);
            };
            resizer.addEventListener('pointermove', onMove);
            resizer.addEventListener('pointerup', onUp);
        });
    })();

    // ======================================================
    // === 邏輯區塊：工具與通用函式 (Utilities)
    // ======================================================

    // 通用 <dialog> 輔助：取代會凍結頁面的 prompt()/confirm()
    function askDialog(title, { input = false, defaultValue = '' } = {}) {
        const dlg = document.getElementById('askDialog');
        const inputEl = document.getElementById('askDialogInput');
        document.getElementById('askDialogTitle').textContent = title;
        inputEl.style.display = input ? '' : 'none';
        inputEl.value = defaultValue;
        return new Promise(resolve => {
            const done = (result) => {
                dlg.close();
                document.getElementById('askDialogOk').onclick = null;
                document.getElementById('askDialogCancel').onclick = null;
                dlg.oncancel = null;
                resolve(result);
            };
            document.getElementById('askDialogOk').onclick = () => done(input ? inputEl.value : true);
            document.getElementById('askDialogCancel').onclick = () => done(null);
            dlg.oncancel = (e) => { e.preventDefault(); done(null); };
            dlg.showModal();
            if (input) inputEl.select();
        });
    }
    const askText = (title, defaultValue = '') => askDialog(title, { input: true, defaultValue });
    const askConfirm = (title) => askDialog(title);

    // 檔名與 PDF 內文抽出的標題會插入 innerHTML，必須跳脫
    function esc(str) {
        return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function showNotification(message, type = 'error') {
        if (!notification) return;
        notification.textContent = message;
        notification.className = type; 
        notification.classList.add('show');
        setTimeout(() => { notification.classList.remove('show'); }, 3000);
    }

    function updateSelectedCountInfo() {
        let count = 0;
        pdfFiles.forEach(f => f.pages.forEach(p => { if(p.isChecked) count++; }));
        const info = document.getElementById('selectedCountInfo');
        if(info) info.textContent = `(已選 ${count} 頁)`;
    }

    function updateTargetSelectedInfo() {
        const count = selectedPages.filter(p => p.isChecked).length;
        const el = document.getElementById('targetSelectedCountInfo');
        if(el) el.textContent = `(${count})`;
    }

    // --- DOM 局部更新輔助（取代整面板重建，大量頁面時避免閃爍與卡頓） ---

    // 依資料狀態同步「左側來源」的勾選樣式/核取方塊
    function syncSourceCheckDom() {
        let missing = false;
        pdfFiles.forEach((file, fileIndex) => {
            if (!file) return;
            file.pages.forEach((page, pageIndex) => {
                const canvas = document.getElementById(`source_${fileIndex}_${pageIndex}`);
                const itemEl = canvas && canvas.closest('.page-item, .page-list-item');
                if (itemEl) {
                    itemEl.classList.toggle('checked', !!page.isChecked);
                    const cb = itemEl.querySelector('.page-checkbox');
                    if (cb) cb.checked = !!page.isChecked;
                } else {
                    missing = true;
                }
            });
        });
        if (missing) renderSourcePages(); // 兜底：若結構不完整才重建
    }

    // 依資料狀態同步「右側成品」的勾選樣式/核取方塊
    function syncTargetCheckDom() {
        selectedPages.forEach((item, index) => {
            if (!item || item.type === 'divider') return;
            const itemEl = selectedPagesContainer.querySelector(`[data-index="${index}"]`);
            if (itemEl) {
                itemEl.classList.toggle('checked', !!item.isChecked);
                const cb = itemEl.querySelector('.page-checkbox');
                if (cb) cb.checked = !!item.isChecked;
            }
        });
    }

    // 只更新「左側來源」旋轉樣式（transition 保留自原 inline style）
    function applySourceRotationDom() {
        pdfFiles.forEach((file, fileIndex) => {
            if (!file) return;
            file.pages.forEach((page, pageIndex) => {
                const canvas = document.getElementById(`source_${fileIndex}_${pageIndex}`);
                if (canvas) canvas.style.transform = `rotate(${(page.sourceRotation || 0) % 360}deg)`;
            });
        });
    }

    // 只更新「右側成品」旋轉樣式
    function applyTargetRotationDom() {
        selectedPages.forEach((item, index) => {
            if (!item || item.type === 'divider') return;
            const canvas = document.getElementById(`selected_${index}`);
            if (canvas) canvas.style.transform = `rotate(${(item.rotation || 0) % 360}deg)`;
        });
    }

    function getGlobalPageIndex(fileIndex, pageIndex) {
        let count = 0;
        for (let i = 0; i < fileIndex; i++) {
            if (pdfFiles[i]) count += pdfFiles[i].pages.length;
        }
        return count + pageIndex;
    }

    function getPageByGlobalIndex(globalIndex) {
        let count = 0;
        for (let i = 0; i < pdfFiles.length; i++) {
            const file = pdfFiles[i];
            if (globalIndex < count + file.pages.length) {
                return { fileIndex: i, pageIndex: globalIndex - count };
            }
            count += file.pages.length;
        }
        return null;
    }

    // ======================================================
    // === 邏輯區塊：檔案處理 (File Processing)
    // ======================================================

    async function handleFiles(files) {
        if (files.length === 0) return;
        
        progress.textContent = `⏳ 正在載入 ${files.length} 個檔案...`;
        progress.classList.remove('success', 'error');
        progress.classList.add('active');

        let loadedCount = 0;
        for (const [fileIdx, file] of files.entries()) {
            const fileData = { name: file.name, file: file, pages: [] };
            try {
                progress.textContent = `⏳ 正在載入檔案 ${fileIdx + 1}/${files.length}...`;
                const arrayBuffer = await file.arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                progress.textContent = `⏳ 正在載入「${file.name}」(${pdf.numPages} 頁)...`;
                
                // 並行渲染縮圖（限制同時 4 個 worker，避免大檔案卡死 UI）
                const CONCURRENCY = 4;
                let nextPageNum = 1;
                let donePages = 0;
                async function renderPageWorker() {
                    while (nextPageNum <= pdf.numPages) {
                        const i = nextPageNum++;
                        try {
                            const page = await pdf.getPage(i);
                            const canvas = document.createElement('canvas');
                            const context = canvas.getContext('2d');
                            const viewport = page.getViewport({ scale: 0.5 });
                            canvas.width = viewport.width;
                            canvas.height = viewport.height;
                            await page.render({ canvasContext: context, viewport: viewport }).promise;
                            const info = await extractPageInfo(page, i);
                            fileData.pages[i - 1] = { 
                                pageNum: i, 
                                canvas: canvas, 
                                firstLine: info.title,
                                isChecked: false, 
                                sourceRotation: 0 
                            };
                        } catch (pageErr) {
                            console.error(`處理 "${file.name}" 第 ${i} 頁失敗:`, pageErr);
                            // 保留佔位，避免頁碼索引錯亂
                            fileData.pages[i - 1] = { 
                                pageNum: i, 
                                canvas: null, 
                                firstLine: `Page ${i}`,
                                isChecked: false, 
                                sourceRotation: 0 
                            };
                        }
                        donePages++;
                        // 讓出主執行緒，維持 UI 反應
                        await new Promise(resolve => setTimeout(resolve, 0));
                        // 定期回報進度（避免每頁更新造成抖動）
                        if (donePages % 10 === 0 || donePages === pdf.numPages) {
                            progress.textContent = `⏳ 正在載入「${file.name}」... ${donePages}/${pdf.numPages} 頁`;
                        }
                    }
                }
                const workers = [];
                for (let w = 0; w < CONCURRENCY; w++) workers.push(renderPageWorker());
                await Promise.all(workers);

                pdf.destroy(); // 縮圖已產生，釋放 pdf.js worker 記憶體；生成時會用 file 重新讀取
                pdfFiles.push(fileData);
                loadedCount++;
            } catch (error) {
                console.error(`處理檔案 "${file.name}" 失敗:`, error);
                showNotification(`處理檔案 "${file.name}" 失敗，檔案可能已損毀。`, 'error');
            }
        }
        fileInput.value = ''; // 允許再次選取同一個檔案
        updateFileList();
        renderSourcePages();

        if (loadedCount === 0) {
            progress.textContent = '❌ 所有檔案載入失敗';
            progress.classList.add('error');
        } else {
            progress.textContent = `✅ ${loadedCount} 個檔案載入完成！`;
            progress.classList.add('success');
        }
        setTimeout(() => { progress.classList.remove('active', 'success', 'error'); }, 2000);
    }

    // 抽取頁面全文（座標、字級）與標題，一次 getTextContent 完成。
    // items 的 y 為「頂部原點」座標（越小越靠頁頂），供行距重排使用；x 為左側原點。
    async function extractPageInfo(page, pageNum) {
        let items = [];
        try {
            const textContent = await page.getTextContent();
            if (textContent && textContent.items) {
                const viewport = page.getViewport({ scale: 1 });
                const H = viewport.height;
                items = textContent.items
                    .map(item => ({
                        s: item.str ? item.str.trim() : '',
                        x: item.transform ? item.transform[4] : 0,
                        y: item.transform ? H - item.transform[5] : 0,
                        w: item.width || 0,
                        h: item.height || 0,
                    }))
                    .filter(it => it.s.length > 0);
            }
        } catch (error) {
            console.error(`Error extracting text from page ${pageNum}:`, error);
        }
        return { title: buildTitleFromItems(items, pageNum), items: items };
    }

    function buildTitleFromItems(items, pageNum) {        if (items.length === 0) return `Page ${pageNum}`;

        // 依位置排序：y 小（靠頁頂）在前，同行依 x 排序
        const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
        const lines = [];
        let currentLine = [sorted[0]];
        for (let i = 1; i < sorted.length; i++) {
            if (Math.abs(sorted[i].y - currentLine[0].y) < 5) {
                currentLine.push(sorted[i]);
            } else {
                lines.push(currentLine.sort((a, b) => a.x - b.x));
                currentLine = [sorted[i]];
            }
        }
        lines.push(currentLine.sort((a, b) => a.x - b.x));

        let title = `Page ${pageNum}`;
        if (lines.length > 0 && lines[0].length > 0) {
            let titleLineText = lines[0].map(item => item.s).join(' ');
            if (lines.length > 1 && lines[1].length > 0) {
                const firstLineY = lines[0][0].y;
                const firstLineHeight = lines[0][0].h;
                const secondLineY = lines[1][0].y;
                if (Math.abs(firstLineY - secondLineY) < firstLineHeight * 1.8) {
                    titleLineText += ' ' + lines[1].map(item => item.s).join(' ');
                }
            }

            let cleanedTitle = titleLineText;
            // --- Title cleaning logic ---
            if (!/^\d+\s*年度/.test(cleanedTitle.trim())) {
                cleanedTitle = cleanedTitle.replace(/^[\d\s.\-•]+\s*/, '');
            }
            const stopChars = ['一、', '二、', '（一）', '附註', '說明：', '中華民國'];
            for (const char of stopChars) {
                const pos = cleanedTitle.indexOf(char);
                if (pos !== -1) cleanedTitle = cleanedTitle.substring(0, pos).trim();
            }
            const specialKeywords = ["說明", "表", "情形"];
            let earliestIndex = -1; let keywordLength = 0;
            for (const keyword of specialKeywords) {
                const currentIndex = cleanedTitle.indexOf(keyword);
                if (currentIndex !== -1) {
                    if (earliestIndex === -1 || currentIndex < earliestIndex) {
                        earliestIndex = currentIndex; keywordLength = keyword.length;
                    }
                }
            }
            if (earliestIndex !== -1) {
                cleanedTitle = cleanedTitle.substring(0, earliestIndex + keywordLength);
            }
            cleanedTitle = cleanedTitle.replace(/\s+/g, '');
            if (cleanedTitle.length > 70) {
                cleanedTitle = cleanedTitle.substring(0, 70) + '...';
            }
            // --- End Title cleaning logic ---

            if (cleanedTitle) title = cleanedTitle;
        }
        return title;
    }

    function updateFileList() {
        fileList.innerHTML = pdfFiles.map((file, index) => `
            <li class="file-list-item">
                <span>${esc(file.name)}</span>
                <button class="btn btn-danger" onclick="removeFile(${index})">✕</button>
            </li>
        `).join('');
        updateQuickSelectFileOptions();
    }

    async function removeFile(index) {
        const file = pdfFiles[index];
        // 若該檔頁面已在右側成品中，提醒使用者
        const usedByTarget = selectedPages.some(p => p.type !== 'divider' && p.fileIndex === index);
        if (usedByTarget && !(await askConfirm(`「${file ? file.name : '此檔案'}」有頁面在右側成品中，移除後會一併從成品刪除。確定移除嗎？`))) {
            return;
        }
        pdfFiles.splice(index, 1);
        selectedPages = selectedPages.filter(p => p.fileIndex !== index).map(p => {
            if (p.fileIndex > index) p.fileIndex--;
            return p;
        });
        updateFileList();
        renderSourcePages();
        renderSelectedPages();
    }

    function clearAllFiles() {
        if (pdfFiles.length === 0) return;
        const clearBtn = document.getElementById('clearFilesBtn');
        if (!clearFilesConfirmMode) {
            clearFilesConfirmMode = true;
            clearBtn.classList.add('confirm-mode');
            clearBtn.innerHTML = '🗑️ 確定清除所有檔案？';
            setTimeout(() => {
                clearFilesConfirmMode = false;
                clearBtn.classList.remove('confirm-mode');
                clearBtn.innerHTML = '🗑️ 清除所有檔案';
            }, 3000);
            return;
        }
        pdfFiles = [];
        selectedPages = [];
        lastSourceClickGlobalIndex = null;
        clearFilesConfirmMode = false;
        fileInput.value = '';
        // 釋放預覽/生成的暫存資源
        finalPdfBytes = null;
        if (previewModal.open) previewModal.close();
        clearBtn.classList.remove('confirm-mode');
        clearBtn.innerHTML = '🗑️ 清除所有檔案';
        updateFileList();
        renderSourcePages();
        renderSelectedPages();
    }

    // ======================================================
    // === 邏輯區塊：左側來源面板 (Source Panel)
    // ======================================================

    function setViewMode(mode) {
        viewMode = mode;
        document.getElementById('gridViewBtn').classList.toggle('active', mode === 'grid');
        document.getElementById('listViewBtn').classList.toggle('active', mode === 'list');
        renderSourcePages();
    }

    function setThumbnailSize(size) {
        thumbnailSize = size;
        sourcePanel.classList.remove('size-small', 'size-medium', 'size-large', 'size-xlarge');
        sourcePanel.classList.add(`size-${size}`);
        
        document.querySelectorAll('#size-toggle button').forEach(btn => btn.classList.remove('active'));
        document.querySelector(`#size-toggle button[onclick="setThumbnailSize('${size}')"]`).classList.add('active');
    }

    function renderSourcePages() {
        if (pdfFiles.length === 0) {
            sourcePages.innerHTML = '<div class="empty-message"><span class="empty-icon">📂</span>尚未載入任何 PDF 檔案<div class="empty-hint">將 PDF 拖曳到視窗任意位置<br>或點擊左側「選擇檔案」按鈕</div></div>';
            const selectAllSource = document.getElementById('selectAllSource');
            if (selectAllSource) selectAllSource.checked = false; // 避免全選框殘留勾選態
            return;
        }
        sourcePages.innerHTML = pdfFiles.map((file, fileIndex) => {
             if (!file) return '';
             
             // [修正] 強制 List 模式使用垂直排列 (flex-direction: column)
             const pagesHtml = viewMode === 'grid' 
                ? `<div class="pages-grid">${file.pages.map((page, pageIndex) => renderPageItem(fileIndex, pageIndex, 'grid')).join('')}</div>`
                : `<div class="pages-list">${file.pages.map((page, pageIndex) => renderPageItem(fileIndex, pageIndex, 'list')).join('')}</div>`;
             
             return `<div class="pdf-file"><div class="pdf-file-header"><div class="pdf-file-name">${esc(file.name || 'Unknown File')}</div></div>${pagesHtml}</div>`;
        }).join('');

        // 重新繪製 Canvas (保持不變)
        pdfFiles.forEach((file, fileIndex) => {
             if (file) {
                 file.pages.forEach((page, pageIndex) => {
                     const canvas = document.getElementById(`source_${fileIndex}_${pageIndex}`);
                     if (canvas && page.canvas) {
                         const ctx = canvas.getContext('2d');
                         if (page.canvas.width > 0 && page.canvas.height > 0) {
                             canvas.width = page.canvas.width;
                             canvas.height = page.canvas.height;
                             ctx.drawImage(page.canvas, 0, 0);
                         }
                     }
                 });
             }
        });
    }

    function renderPageItem(fileIndex, pageIndex, type) {
        if (!pdfFiles[fileIndex] || !pdfFiles[fileIndex].pages[pageIndex]) return '';
        const page = pdfFiles[fileIndex].pages[pageIndex];
        
        const checkedAttr = page.isChecked ? 'checked' : '';
        const checkedClass = page.isChecked ? 'checked' : '';
        const currentRotation = page.sourceRotation || 0; 
        const rotationStyle = `transform: rotate(${currentRotation}deg); transition: transform 0.3s;`;
        
        const clickAction = `onclick="toggleSourceCheck(${fileIndex}, ${pageIndex}, event)"`;
        const checkboxAction = `onclick="event.stopPropagation(); toggleSourceCheck(${fileIndex}, ${pageIndex}, event)"`;

        if (type === 'grid') {
            return `
                <div class="page-item ${checkedClass}" ${clickAction}>
                    <input type="checkbox" class="page-checkbox" ${checkedAttr} ${checkboxAction}>
                    <div class="page-thumb">
                        <canvas id="source_${fileIndex}_${pageIndex}" style="${rotationStyle}"></canvas>
                    </div>
                    <div class="page-number">第 ${page.pageNum} 頁</div> 
                </div>`;
        } else {
             const title = esc(page.firstLine || `Page ${page.pageNum}`);
             // [修正] 加入 style="width: 100%;" 確保寬度佔滿容器
            return `
                <div class="page-list-item ${checkedClass}" ${clickAction} title="${title}">
                    <input type="checkbox" class="page-checkbox" ${checkedAttr} ${checkboxAction}>
                    <div class="list-thumb-wrapper">
                        <canvas id="source_${fileIndex}_${pageIndex}" style="width: 100%; ${rotationStyle}"></canvas>
                    </div>
                    <div class="page-list-text">${title}</div>
                    <div class="page-list-number">第 ${page.pageNum} 頁</div>
                </div>`;
        }
    }

    // 核心選取邏輯 (支援 Shift)
    function toggleSourceCheck(fileIndex, pageIndex, event) {
        if (!pdfFiles[fileIndex] || !pdfFiles[fileIndex].pages[pageIndex]) return;
        
        const currentGlobalIndex = getGlobalPageIndex(fileIndex, pageIndex);
        const targetPage = pdfFiles[fileIndex].pages[pageIndex];

        // 判斷是否按住了 Shift 鍵，且之前有點擊過有效的位置
        if (event && event.shiftKey && lastSourceClickGlobalIndex !== null) {
            
            // 1. 先改變「當前點擊頁面」的狀態
            targetPage.isChecked = !targetPage.isChecked;
            const targetState = targetPage.isChecked; 

            // 2. 計算範圍
            const start = Math.min(lastSourceClickGlobalIndex, currentGlobalIndex);
            const end = Math.max(lastSourceClickGlobalIndex, currentGlobalIndex);

            // 3. 迴圈設定狀態
            for (let i = start; i <= end; i++) {
                const pos = getPageByGlobalIndex(i);
                if (pos) {
                    pdfFiles[pos.fileIndex].pages[pos.pageIndex].isChecked = targetState;
                }
            }
            lastSourceClickGlobalIndex = currentGlobalIndex;
            syncSourceCheckDom();
        } else {
            // 一般單點：就地更新該項目，避免整面重繪造成閃爍
            targetPage.isChecked = !targetPage.isChecked;
            lastSourceClickGlobalIndex = currentGlobalIndex;
            const canvas = document.getElementById(`source_${fileIndex}_${pageIndex}`);
            const itemEl = canvas && canvas.closest('.page-item, .page-list-item');
            if (itemEl) {
                itemEl.classList.toggle('checked', targetPage.isChecked);
                const cb = itemEl.querySelector('.page-checkbox');
                if (cb) cb.checked = targetPage.isChecked;
            } else {
                renderSourcePages();
            }
        }
        updateSelectedCountInfo();
    }

    function toggleSelectAllSource(checkbox) {
        const isChecked = checkbox.checked;
        pdfFiles.forEach(file => {
            file.pages.forEach(page => {
                page.isChecked = isChecked;
            });
        });
        syncSourceCheckDom();
        updateSelectedCountInfo();
    }

    // --- 批次操作 (Source) ---

    function batchAddToTarget() {
        let addedCount = 0;
        pdfFiles.forEach((file, fIndex) => {
            file.pages.forEach((page, pIndex) => {
                if (page.isChecked) {
                    selectedPages.push({ 
                        type: 'page', 
                        fileIndex: fIndex, 
                        pageNum: page.pageNum, 
                        fileName: file.name, 
                        canvas: page.canvas, 
                        firstLine: page.firstLine,
                        rotation: page.sourceRotation || 0 
                    });
                    addedCount++;
                }
            });
        });

        if (addedCount > 0) {
            renderSelectedPages();
            showNotification(`✅ 已加入 ${addedCount} 個頁面到右側`, 'success');
            const container = document.getElementById('selectedPages');
            container.scrollTop = container.scrollHeight;
        } else {
            showNotification('⚠️ 請先勾選要加入的頁面', 'info');
        }
    }

    async function batchDeleteFromSource() {
        let deletedCount = 0;
        let hasSelection = false;
        pdfFiles.forEach(f => f.pages.forEach(p => { if(p.isChecked) hasSelection = true; }));

        if (!hasSelection) {
            showNotification('⚠️ 請先勾選要刪除的頁面', 'info');
            return;
        }

        if (!await askConfirm("確定要從來源列表中刪除選取的頁面嗎？")) return;

        const newPdfFiles = [];
        const indexMap = new Map(); // 舊 fileIndex -> 新 fileIndex（整檔刪除時右側索引須重排）
        pdfFiles.forEach((file, oldIndex) => {
            const remainingPages = file.pages.filter(p => {
                if (p.isChecked) {
                    deletedCount++;
                    return false;
                }
                return true;
            });
            if (remainingPages.length > 0) {
                file.pages = remainingPages;
                indexMap.set(oldIndex, newPdfFiles.length);
                newPdfFiles.push(file);
            }
        });

        pdfFiles = newPdfFiles;
        selectedPages = selectedPages.filter(p => p.type === 'divider' || indexMap.has(p.fileIndex));
        selectedPages.forEach(p => { if (p.type !== 'divider') p.fileIndex = indexMap.get(p.fileIndex); });
        document.getElementById('selectAllSource').checked = false;

        updateFileList();
        renderSourcePages();
        renderSelectedPages();
        updateSelectedCountInfo();
        showNotification(`🗑️ 已刪除 ${deletedCount} 個頁面`, 'success');
    }

    function batchRotateSource(deg) {
        let rotatedCount = 0;
        let hasSelection = false;

        pdfFiles.forEach(file => {
            file.pages.forEach(page => {
                if (page.isChecked) {
                    hasSelection = true;
                    if (typeof page.sourceRotation === 'undefined') page.sourceRotation = 0;
                    const current = page.sourceRotation;
                    page.sourceRotation = (current + deg + 360) % 360;
                    rotatedCount++;
                }
            });
        });

        if (rotatedCount > 0) {
            applySourceRotationDom();
            showNotification(`↻ 已旋轉 ${rotatedCount} 個頁面`, 'success');
        } else {
            if (!hasSelection) showNotification('⚠️ 請先勾選要旋轉的頁面 (左側來源)', 'info');
        }
    }

    // --- 快速選取 (Source) ---

    function updateQuickSelectFileOptions() {
        const qsFileSelect = document.getElementById('qsFileSelect');
        if (!qsFileSelect) return;

        qsFileSelect.innerHTML = '';
        if (pdfFiles.length === 0) {
            const option = document.createElement('option');
            option.value = "-1"; option.text = "-- 請先載入檔案 --";
            qsFileSelect.appendChild(option);
            return;
        }

        const allOption = document.createElement('option');
        allOption.value = "-1"; allOption.text = "📂 所有已載入檔案";
        qsFileSelect.appendChild(allOption);

        pdfFiles.forEach((file, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.text = `📄 ${index + 1}. ${file.name}`;
            qsFileSelect.appendChild(option);
        });
    }

    function applyQuickSelection() {
        const fileIndexStr = document.getElementById('qsFileSelect').value;
        const type = document.getElementById('qsTypeSelect').value;
        const targetFileIndex = parseInt(fileIndexStr); 

        if (pdfFiles.length === 0) {
            showNotification('請先載入 PDF 檔案', 'error');
            return;
        }

        let matchCount = 0;
        const checkPageLogic = (file, page, pIndex) => {
            let shouldCheck = false;
            const pageNum = page.pageNum;

            switch (type) {
                case 'all': shouldCheck = true; break;
                case 'odd': shouldCheck = (pageNum % 2 !== 0); break;
                case 'even': shouldCheck = (pageNum % 2 === 0); break;
                case 'first': shouldCheck = (pIndex === 0); break;
                case 'last': shouldCheck = (pIndex === file.pages.length - 1); break;
                case 'blank': if (page.firstLine === `Page ${pageNum}`) shouldCheck = true; break;
            }

            if (shouldCheck) {
                page.isChecked = true;
                matchCount++;
            }
        };

        if (targetFileIndex === -1) {
            pdfFiles.forEach(file => {
                file.pages.forEach((page, pIndex) => checkPageLogic(file, page, pIndex));
            });
        } else {
            const file = pdfFiles[targetFileIndex];
            if (file) {
                file.pages.forEach((page, pIndex) => checkPageLogic(file, page, pIndex));
            }
        }

        if (matchCount > 0) {
            syncSourceCheckDom();
            updateSelectedCountInfo();
            showNotification(`已自動勾選 ${matchCount} 個頁面`, 'success');
        } else {
            showNotification('沒有符合條件的頁面', 'info');
        }
    }

    function clearAllSourceChecks() {
        pdfFiles.forEach(file => {
            file.pages.forEach(page => page.isChecked = false);
        });
        document.getElementById('selectAllSource').checked = false;
        syncSourceCheckDom();
        updateSelectedCountInfo();
    }

    // ======================================================
    // === 邏輯區塊：右側成品面板 (Target Panel)
    // ======================================================

    function setTargetViewMode(mode) {
        targetViewMode = mode;
        document.getElementById('targetGridViewBtn').classList.toggle('active', mode === 'grid');
        document.getElementById('targetListViewBtn').classList.toggle('active', mode === 'list');
        renderSelectedPages();
    }

    function setTargetThumbnailSize(size) {
        targetThumbnailSize = size;
        const container = document.getElementById('targetPanel');
        container.classList.remove('size-small', 'size-medium', 'size-large', 'size-xlarge');
        container.classList.add(`size-${size}`);
        
        document.querySelectorAll('#target-size-toggle button').forEach(btn => btn.classList.remove('active'));
        document.querySelector(`#target-size-toggle button[onclick="setTargetThumbnailSize('${size}')"]`).classList.add('active');
    }

    function renderSelectedPages() {
        if (selectedPages.length === 0) {
            selectedPagesContainer.innerHTML = '<div class="empty-message"><span class="empty-icon">📋</span>尚未選擇任何頁面<div class="empty-hint">在左側勾選頁面後，點「➕ 加入右側」<br>或使用「⚡ 智慧勾選」快速選取</div></div>';
            // 即使是空訊息，也重置樣式以免跑版
            selectedPagesContainer.style.display = 'flex';
            selectedPagesContainer.style.flexDirection = 'column';
            const selectAllTarget = document.getElementById('selectAllTarget');
            if (selectAllTarget) selectAllTarget.checked = false; // 避免全選框殘留勾選態
            updateTargetSelectedInfo();
            return;
        }

        selectedPagesContainer.className = `selected-pages ${targetViewMode}-view`;

        // [修正] 強制設定容器的 Flex 方向
        if (targetViewMode === 'list') {
            selectedPagesContainer.style.display = 'flex';
            selectedPagesContainer.style.flexDirection = 'column'; // 強制由上而下
            selectedPagesContainer.style.flexWrap = 'nowrap';
            selectedPagesContainer.style.alignContent = 'stretch';
        } else {
            // Grid 模式
            selectedPagesContainer.style.display = 'flex';
            selectedPagesContainer.style.flexDirection = 'row';
            selectedPagesContainer.style.flexWrap = 'wrap';
            selectedPagesContainer.style.alignContent = 'flex-start';
        }

        selectedPagesContainer.innerHTML = selectedPages.map((item, index) => {
             if (!item) return '';
             
             // 分隔線
             if (item.type === 'divider') {
                // 分隔線在任何模式下都應該佔滿整行
                return `
                    <div class="selected-divider-item" data-index="${index}">
                        <span class="drag-handle">::</span>
                         <div class="selected-divider-title">${esc(item.firstLine || 'New Section')}</div>
                        <div class="page-actions">
                            <button class="btn btn-danger" onclick="removeSelectedPage(${index})">✕</button>
                        </div>
                    </div>`;
            }

            // 一般頁面
            const title = esc(item.firstLine || `Page ${item.pageNum || '?'}`);
            const source = esc(`${item.fileName || 'Unknown File'} - 第 ${item.pageNum || '?'} 頁`);
            const checkedAttr = item.isChecked ? 'checked' : '';
            const checkedClass = item.isChecked ? 'checked' : '';
            const rotationStyle = `transform: rotate(${item.rotation || 0}deg);`;
            const clickAction = `onclick="toggleTargetCheck(${index})"`;

            if (targetViewMode === 'grid') {
                return `
                <div class="selected-page-item grid-item ${checkedClass}" data-index="${index}" ${clickAction}>
                    <input type="checkbox" class="page-checkbox" ${checkedAttr} onclick="event.stopPropagation(); toggleTargetCheck(${index})">
                    <div class="canvas-wrapper">
                        <canvas id="selected_${index}" style="${rotationStyle}"></canvas>
                    </div>
                    <div class="page-info-grid">
                        <div class="page-num-badge">${index + 1}</div>
                        <div class="page-title-grid" title="${title}">${title}</div>
                    </div>
                </div>`;
            } else {
                // [修正] List Item 強制寬度 100%
                return `
                <div class="selected-page-item list-item ${checkedClass}" data-index="${index}" ${clickAction}>
                    <span class="drag-handle">::</span>
                    <input type="checkbox" class="page-checkbox" ${checkedAttr} onclick="event.stopPropagation(); toggleTargetCheck(${index})">
                    <div class="list-thumb-wrapper">
                        <canvas id="selected_${index}" style="${rotationStyle}"></canvas>
                    </div>
                    <div class="selected-page-info">
                        <div class="selected-page-title">${index + 1}. ${title}</div>
                        <div class="selected-page-source">${source}</div>
                    </div>
                </div>`;
            }
        }).join('');

        // 繪製右側 Canvas
        selectedPages.forEach((item, index) => {
             if (item && item.type !== 'divider') {
                 const canvas = document.getElementById(`selected_${index}`);
                 if (canvas && item.canvas) {
                    canvas.width = item.canvas.width;
                    canvas.height = item.canvas.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(item.canvas, 0, 0);
                 }
             }
        });

        updateTargetSelectedInfo();
    }

    function toggleTargetCheck(index) {
        if (!selectedPages[index]) return;
        const checked = selectedPages[index].isChecked = !selectedPages[index].isChecked;
        const itemEl = selectedPagesContainer.querySelector(`[data-index="${index}"]`);
        if (itemEl) {
            itemEl.classList.toggle('checked', checked);
            const cb = itemEl.querySelector('.page-checkbox');
            if (cb) cb.checked = checked;
        } else {
            renderSelectedPages();
        }
        updateTargetSelectedInfo();
    }

    function toggleSelectAllTarget(checkbox) {
        const checked = checkbox.checked;
        selectedPages.forEach(p => {
            if (p.type !== 'divider') p.isChecked = checked;
        });
        syncTargetCheckDom();
        updateTargetSelectedInfo();
    }

    // --- 批次操作 (Target) ---

    function batchDeleteFromTarget() {
        const initialLen = selectedPages.length;
        selectedPages = selectedPages.filter(p => !p.isChecked); 
        
        const deletedCount = initialLen - selectedPages.length;
        if (deletedCount > 0) {
            renderSelectedPages();
            document.getElementById('selectAllTarget').checked = false;
            showNotification(`已從右側移除 ${deletedCount} 頁`, 'success');
        } else {
            showNotification('請先勾選右側頁面', 'info');
        }
    }

    function batchRotateTarget(deg) {
        let count = 0;
        selectedPages.forEach(p => {
            if (p.isChecked && p.type !== 'divider') {
                const current = p.rotation || 0;
                p.rotation = (current + deg + 360) % 360;
                count++;
            }
        });
        if (count > 0) {
            applyTargetRotationDom();
        } else {
            showNotification('請先勾選右側頁面', 'info');
        }
    }

    function removeSelectedPage(index) {
        selectedPages.splice(index, 1);
        renderSelectedPages();
    }

    function applyTargetQuickSelection() {
        const type = document.getElementById('qsTargetTypeSelect').value;
        let count = 0;
        let pageIndexCounter = 0;

        selectedPages.forEach((item) => {
            if (item.type === 'divider') return;
            const currentPos = pageIndexCounter + 1; 
            let shouldCheck = false;

            switch (type) {
                case 'all': shouldCheck = true; break;
                case 'odd': shouldCheck = (currentPos % 2 !== 0); break;
                case 'even': shouldCheck = (currentPos % 2 === 0); break;
                case 'first': shouldCheck = (pageIndexCounter === 0); break;
                case 'last': 
                    const totalPages = selectedPages.filter(p => p.type !== 'divider').length;
                    shouldCheck = (pageIndexCounter === totalPages - 1); 
                    break;
                case 'blank':
                    if (item.firstLine && item.firstLine.startsWith('Page ')) shouldCheck = true;
                    break;
            }

            if (shouldCheck) {
                item.isChecked = true;
                count++;
            }
            pageIndexCounter++;
        });

        renderSelectedPages();
        showNotification(`已勾選右側 ${count} 個頁面`, 'success');
    }

    function clearSelectedPages() {
        if (selectedPages.length === 0) return;
        const btn = document.getElementById('clearSelectedBtn');
        if (!clearSelectedConfirmMode) {
            clearSelectedConfirmMode = true;
            btn.classList.add('confirm-mode');
            btn.textContent = '確定清空全部？';
            setTimeout(() => {
                clearSelectedConfirmMode = false;
                btn.classList.remove('confirm-mode');
                btn.textContent = '🗑️ 清空全部';
            }, 3000);
            return;
        }
        selectedPages = [];
        clearSelectedConfirmMode = false;
        btn.classList.remove('confirm-mode');
        btn.textContent = '🗑️ 清空全部';
        renderSelectedPages();
    }

    async function addSectionDivider() {
        const title = await askText("請輸入小節標題：");
        if (title && title.trim()) {
            selectedPages.push({
                type: 'divider',
                firstLine: title.trim(),
                id: Date.now()
            });
            renderSelectedPages();
        }
    }

    // ======================================================
    // === 邏輯區塊：拖曳排序 (Drag & Drop)
    // ======================================================

    // 使用 SortableJS：grid/list 皆準確，支援觸控與動畫。綁在容器上，初始化一次即可
    function setupDragAndDrop() {
        Sortable.create(selectedPagesContainer, {
            animation: 150,
            draggable: '.selected-page-item, .selected-divider-item',
            ghostClass: 'dragging',
            onEnd: (evt) => {
                if (evt.oldIndex === evt.newIndex) return;
                const [movedItem] = selectedPages.splice(evt.oldIndex, 1);
                selectedPages.splice(evt.newIndex, 0, movedItem);
                renderSelectedPages();
            }
        });
    }

    // ======================================================
    // === 邏輯區塊：目錄編輯 (TOC Editor)
    // ======================================================

    function openTocEditor() {
        const pageItems = selectedPages.filter(p => p && p.type !== 'divider');
        if (pageItems.length === 0) {
            showNotification('請先選擇至少一個頁面才能編輯目錄。', 'info');
            return;
        }
        const titles = pageItems.map(p => p.firstLine || `Page ${p.pageNum || '?'}`).join('\n');
        tocTextarea.value = titles;
        tocModal.showModal();
    }

    function closeTocEditor() {
        tocModal.close();
    }

    function saveToc() {
        const newTitles = tocTextarea.value.split('\n');
        const pageItems = selectedPages.filter(p => p && p.type !== 'divider');
        if (newTitles.length !== pageItems.length) {
            showNotification(`錯誤：目錄行數 (${newTitles.length}) 與選擇的頁數 (${pageItems.length}) 不符。`, 'error');
            return;
        }
        let titleIndex = 0;
        selectedPages.forEach(item => {
            if (item && item.type !== 'divider') {
                item.firstLine = newTitles[titleIndex] || `Page ${item.pageNum || '?'}`;
                titleIndex++;
            }
        });
        renderSelectedPages();
        closeTocEditor();
    }

    function resetTocSettings() {
        document.getElementById('tocMainTitleSize').value = 20;
        document.getElementById('tocSectionSize').value = 14;
        document.getElementById('tocItemTitleSize').value = 12;
        document.getElementById('tocPageNumSize').value = 12;
        document.getElementById('tocLineHeight').value = 20;
        showNotification('✅ 已重設為預設值', 'success');
    }

    // ======================================================
    // === 邏輯區塊：PDF 生成與下載 (Generation)
    // ======================================================

    async function downloadGeneratedPDF() {
        if (!finalPdfBytes) {
            showNotification("沒有可下載的 PDF 檔案。", 'error');
            return;
        }

        const blob = new Blob([finalPdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.style.display = 'none';

        const defaultFileName = '重組後的PDF_' + new Date().toISOString().slice(0, 10) + '.pdf';
        let finalFileName = await askText("請確認檔案名稱：", defaultFileName);

        if (finalFileName === null) {
            URL.revokeObjectURL(url);
            return;
        }
        if (finalFileName.trim() === "") {
            finalFileName = defaultFileName;
        }
        a.download = finalFileName.endsWith('.pdf') ? finalFileName : finalFileName + '.pdf';

        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
            try {
                document.body.removeChild(a);
                URL.revokeObjectURL(url); 
            } catch (cleanupError) { console.error("Error during cleanup:", cleanupError); }
        }, 100);
        
        closePreview();
    }

    function closePreview() {
        // 資源清理統一在 previewModal 的 'close' 事件處理
        if (previewModal.open) previewModal.close();
    }

    // 混合字型繪製：ASCII 用 Helvetica（抽取正確），CJK 用思源黑體。
    // 原因：pdf-lib + fontkit 對 CJK 字型的 ASCII 子集化會產生錯誤 glyph 對映
    // （渲染正常，但搜尋/複製會得到亂碼），拆開用標準字型則完全正常。
    function splitMixedRuns(text) {
        const runs = [];
        let cur = null;
        for (const ch of text) {
            const isAscii = ch.codePointAt(0) <= 0x7F;
            if (!cur || cur.ascii !== isAscii) {
                cur = { ascii: isAscii, s: ch };
                runs.push(cur);
            } else {
                cur.s += ch;
            }
        }
        return runs;
    }

    function mixedTextWidth(text, size, cjkFont, asciiFont) {
        let w = 0;
        for (const run of splitMixedRuns(text)) {
            w += (run.ascii ? asciiFont : cjkFont).widthOfTextAtSize(run.s, size);
        }
        return w;
    }

    function drawMixedText(page, text, x, y, size, cjkFont, asciiFont, color) {
        let cx = x;
        for (const run of splitMixedRuns(text)) {
            const font = run.ascii ? asciiFont : cjkFont;
            page.drawText(run.s, { x: cx, y: y, size: size, font: font, color: color });
            cx += font.widthOfTextAtSize(run.s, size);
        }
        return cx - x; // 回傳總寬度
    }

    async function generatePDF() {
        if (typeof PDFLib === 'undefined' || typeof PDFLib.PDFDocument === 'undefined') {
            console.error("PDFLib not available in generatePDF");
            showNotification("錯誤：無法生成 PDF，編輯函式庫載入失敗。", 'error');
            return;
        }

        // ✅ [修正 1] 這裡加入了 degrees
        const { PDFDocument, rgb, StandardFonts, PDFName, PDFArray, degrees } = PDFLib;

        const pageItems = selectedPages.filter(p => p && p.type !== 'divider');
        if (pageItems.length === 0) {
            progress.textContent = '⚠️ 請至少選擇一個頁面';
            progress.classList.add('active', 'error');
            setTimeout(() => progress.classList.remove('active', 'error'), 3000);
            return;
        }

        try {
            progress.textContent = '⏳ 正在準備生成 PDF...';
            progress.classList.remove('success', 'error');
            progress.classList.add('active');
            
            const newPdf = await PDFDocument.create();
            let customFont;
            let asciiFont;
            
            // 建立 PDF-Lib 文件快取
            const pdfLibDocCache = new Map();

            try {
                progress.textContent = '正在載入中文字型...';
                const fontUrl = './fonts/NotoSansTC-Regular.ttf';
                const fontBytes = await fetch(fontUrl).then(res => {
                    if (!res.ok) throw new Error(`字型檔案 (${fontUrl}) 載入失敗！ status: ${res.status}`);
                    return res.arrayBuffer();
                });
                
                if (typeof fontkit === 'undefined') throw new Error("fontkit 函式庫載入失敗");
                newPdf.registerFontkit(fontkit); 
                customFont = await newPdf.embedFont(fontBytes);
                // ASCII 用標準字型（pdf-lib 對 CJK 字型的 ASCII 子集化會產生錯誤 glyph 對映）
                asciiFont = await newPdf.embedFont(StandardFonts.Helvetica);
            } catch (fontError) {
                console.error("中文字型載入失敗:", fontError);
                showNotification(`警告：無法載入本地字型。目錄將使用英文字型。`, 'error');
                try {
                    customFont = await newPdf.embedFont(StandardFonts.Helvetica);
                    asciiFont = customFont; // 全部用 Helvetica 時 ASCII 字型相同
                } catch (embedError) {
                    console.error("Failed to embed fallback font:", embedError);
                    showNotification("致命錯誤：無法嵌入預設字型。", 'error');
                    progress.textContent = '❌ 生成失敗：無法嵌入字型';
                    progress.classList.add('active', 'error');
                    return;
                }
            }
            
            const addToc = addTocCheckbox.checked;
            const addPageNumbers = document.getElementById('addPageNumbersCheckbox').checked;
            
            let tocPages = []; 
            let tocLinkData = []; 

            // --- 建立目錄頁 (TOC) ---
            if (addToc) {
                progress.textContent = '正在建立目錄頁...';
                
                const TOC_CONFIG = {
                    MAIN_TITLE_SIZE: parseInt(document.getElementById('tocMainTitleSize').value) || 20,
                    SECTION_TITLE_SIZE: parseInt(document.getElementById('tocSectionSize').value) || 14,
                    ITEM_TITLE_SIZE: parseInt(document.getElementById('tocItemTitleSize').value) || 12,
                    ITEM_PAGENUM_SIZE: parseInt(document.getElementById('tocPageNumSize').value) || 12,
                    LINE_HEIGHT: parseInt(document.getElementById('tocLineHeight').value) || 20
                };
                
                // 先模擬排版計算目錄總頁數，否則跨頁目錄的頁碼會少算
                let simY = 595 - 90;
                let totalTocPages = 1;
                for (const item of selectedPages) {
                    if (!item) continue;
                    if (simY < 50) { totalTocPages++; simY = 595 - 90; }
                    simY -= (item.type === 'divider') ? 35 : TOC_CONFIG.LINE_HEIGHT;
                }

                let tocPage = newPdf.addPage([842, 595]); // 橫向A4
                tocPages.push(tocPage);
                
                drawMixedText(tocPage, '目錄', 50, 595 - 50, TOC_CONFIG.MAIN_TITLE_SIZE, customFont, asciiFont, rgb(0, 0, 0));
                
                let yPosition = 595 - 90;
                let pageCounterForToc = 0;

                for (const item of selectedPages) {
                    if (!item) continue;
                    
                    // TOC 換頁處理
                    if (yPosition < 50) {
                        tocPage = newPdf.addPage([842, 595]);
                        tocPages.push(tocPage);
                        yPosition = 595 - 90;
                        drawMixedText(tocPage, '目錄 (續)', 50, 595 - 50, TOC_CONFIG.MAIN_TITLE_SIZE, customFont, asciiFont, rgb(0, 0, 0));
                    }

                    if (item.type === 'divider') {
                        yPosition -= 10;
                        drawMixedText(tocPage, item.firstLine || 'New Section', 50, yPosition, TOC_CONFIG.SECTION_TITLE_SIZE, customFont, asciiFont, rgb(0, 0, 0));
                        yPosition -= 25;
                    } else {
                        pageCounterForToc++;
                        const title = item.firstLine || `Page ${item.pageNum || '?'}`;
                        const pageNumStr = `${pageCounterForToc + totalTocPages}`;
                        
                        const leftMargin = 70;
                        const rightMargin = 50;
                        const pageContentWidth = tocPage.getWidth() - leftMargin - rightMargin;
                        
                        let pageNumWidth = 0;
                        try { pageNumWidth = mixedTextWidth(pageNumStr, TOC_CONFIG.ITEM_PAGENUM_SIZE, customFont, asciiFont); } catch (e) {}
                        
                        let truncatedTitle = title;
                        let titleWidth = 0;
                        try { titleWidth = mixedTextWidth(truncatedTitle, TOC_CONFIG.ITEM_TITLE_SIZE, customFont, asciiFont); } catch (e) {}
                        
                        const minDotSpace = 20;
                        while (titleWidth > 0 && pageContentWidth > 0 && (titleWidth + pageNumWidth + minDotSpace > pageContentWidth) && truncatedTitle.length > 5) {
                            truncatedTitle = truncatedTitle.slice(0, -2) + '…';
                            try { titleWidth = mixedTextWidth(truncatedTitle, TOC_CONFIG.ITEM_TITLE_SIZE, customFont, asciiFont); } catch (e) { titleWidth = 0; }
                        }
                        
                        // 繪製標題
                        drawMixedText(tocPage, truncatedTitle, leftMargin, yPosition, TOC_CONFIG.ITEM_TITLE_SIZE, customFont, asciiFont, rgb(0, 0, 0));
                        
                        // 繪製頁碼
                        drawMixedText(tocPage, pageNumStr, tocPage.getWidth() - rightMargin - pageNumWidth, yPosition, TOC_CONFIG.ITEM_PAGENUM_SIZE, customFont, asciiFont, rgb(0, 0, 0));
                        
                        // 繪製點點
                        let dotWidth = 0;
                        const dotSize = Math.min(TOC_CONFIG.ITEM_TITLE_SIZE, TOC_CONFIG.ITEM_PAGENUM_SIZE);
                        try { dotWidth = asciiFont.widthOfTextAtSize('.', dotSize); } catch (e) {}
                        
                        if (dotWidth > 0) {
                            const dotStartX = leftMargin + titleWidth + 5;
                            const dotEndX = tocPage.getWidth() - rightMargin - pageNumWidth - 5;
                            const availableDotSpace = dotEndX - dotStartX;
                            if (availableDotSpace > dotWidth) {
                                const numDots = Math.floor(availableDotSpace / dotWidth);
                                const dotString = '.'.repeat(numDots);
                                tocPage.drawText(dotString, { 
                                    x: dotStartX, y: yPosition, 
                                    size: dotSize, font: asciiFont, color: rgb(0, 0, 0), opacity: 0.5 
                                });
                            }
                        }
                        
                        // 儲存連結資訊
                        tocLinkData.push({
                            tocPage: tocPage,
                            targetContentPageIndex: pageCounterForToc - 1,
                            linkRect: {
                                x: leftMargin - 5,
                                y: yPosition - 2,
                                width: pageContentWidth + 10,
                                height: Math.max(TOC_CONFIG.ITEM_TITLE_SIZE, TOC_CONFIG.ITEM_PAGENUM_SIZE) + 4
                            }
                        });
                        
                        yPosition -= TOC_CONFIG.LINE_HEIGHT;
                    }
                }
            }
            
            // --- 合併內容頁 ---
            let pageCounterForContent = 0;
            const pageOffset = tocPages.length;

            for (const item of selectedPages) {
                if (!item || item.type === 'divider') continue;
                pageCounterForContent++;
                progress.textContent = `正在合併頁面 (${pageCounterForContent}/${pageItems.length})...`;
                
                if (item.fileIndex === undefined || item.fileIndex === null || !pdfFiles[item.fileIndex] || !pdfFiles[item.fileIndex].file || !item.pageNum) {
                    console.error("Missing data for page item:", item); 
                    continue;
                }
                
                const sourceFile = pdfFiles[item.fileIndex];
                
                try {
                    let sourcePdf;
                    if (pdfLibDocCache.has(item.fileIndex)) {
                        sourcePdf = pdfLibDocCache.get(item.fileIndex);
                    } else {
                        const freshArrayBuffer = await sourceFile.file.arrayBuffer();
                        sourcePdf = await PDFDocument.load(freshArrayBuffer, { ignoreEncryption: true, updateMetadata: false });
                        pdfLibDocCache.set(item.fileIndex, sourcePdf);
                    }

                    if (item.pageNum < 1 || item.pageNum > sourcePdf.getPageCount()) {
                        console.error(`Invalid page ${item.pageNum} for ${sourceFile.name}`); 
                        continue;
                    }
                    
                    const [copiedPage] = await newPdf.copyPages(sourcePdf, [item.pageNum - 1]);
                    // copyPages 會保留來源角度，疊加使用者旋轉
                    const existingRotation = copiedPage.getRotation().angle;
                    const newPage = newPdf.addPage(copiedPage);
                    
                    const userRotation = item.rotation || 0;
                    const totalRotation = (existingRotation + userRotation) % 360;
                    
                    newPage.setRotation(degrees(totalRotation));

                    // 新增頁碼
                    if (addPageNumbers) {
                        const newPageNumber = `${pageCounterForContent + pageOffset}`;
                        const { width, height } = newPage.getSize();
                        if (width > 0 && height > 0) {
                            newPage.drawText(newPageNumber, { 
                                x: width - 40, y: 30, 
                                size: 10, font: customFont, color: rgb(0, 0, 0) 
                            });
                        }
                    }
                    
                } catch(loadError) {
                    console.error(`Error loading/copying page ${item.pageNum} from ${sourceFile.name}:`, loadError);
                    showNotification(`錯誤：無法處理檔案 "${sourceFile.name}" 第 ${item.pageNum} 頁。`, 'error');
                }
            }

            // --- 建立目錄超連結 ---
            if (addToc && tocLinkData.length > 0) {
                progress.textContent = '正在建立目錄超連結...';
                const allPages = newPdf.getPages();
                
                for (let i = 0; i < tocLinkData.length; i++) {
                    const linkInfo = tocLinkData[i];
                    const targetPageIndex = tocPages.length + linkInfo.targetContentPageIndex;
                    
                    if (targetPageIndex >= allPages.length) continue;
                    
                    const targetPage = allPages[targetPageIndex];
                    try {
                        const linkAnnot = linkInfo.tocPage.doc.context.obj({
                            Type: 'Annot', Subtype: 'Link',
                            Rect: [
                                linkInfo.linkRect.x, linkInfo.linkRect.y,
                                linkInfo.linkRect.x + linkInfo.linkRect.width,
                                linkInfo.linkRect.y + linkInfo.linkRect.height
                            ],
                            Border: [0, 0, 0], C: [0, 0, 1],
                            A: { S: 'GoTo', D: [targetPage.ref, 'Fit'] }
                        });
                        const registeredAnnot = linkInfo.tocPage.doc.context.register(linkAnnot);
                        let annots = linkInfo.tocPage.node.lookup(PDFName.of('Annots'));
                        if (!annots) {
                            annots = linkInfo.tocPage.doc.context.obj([]);
                            linkInfo.tocPage.node.set(PDFName.of('Annots'), annots);
                        }
                        if (annots instanceof PDFArray || Array.isArray(annots.array)) {
                            annots.push(registeredAnnot);
                        }
                    } catch (linkError) {
                        console.error(`無法建立超連結 (項目 ${i + 1}):`, linkError);
                    }
                }
            }

            progress.textContent = '正在儲存 PDF...';
            
            let pdfBytes = await newPdf.save();
            finalPdfBytes = pdfBytes;
            
            const blob = new Blob([finalPdfBytes], { type: 'application/pdf' });
            currentPreviewUrl = URL.createObjectURL(blob);

            document.getElementById('previewFrame').src = currentPreviewUrl;
            previewModal.showModal();
            
            progress.textContent = '✅ 預覽生成成功！';
            progress.classList.add('success');
            setTimeout(() => progress.classList.remove('active', 'success'), 5000);

        } catch (error) {
            console.error('生成 PDF 時發生錯誤：', error);
            const errMsg = (error && error.message) ? error.message : String(error);
            progress.textContent = '❌ 生成失敗：' + errMsg;
            showNotification('❌ 生成失敗：' + errMsg, 'error');
            progress.classList.add('active', 'error');
            setTimeout(() => progress.classList.remove('active', 'error'), 8000);
        }
    }
};
