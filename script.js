// ==========================================================
// ===   *** 本地檔案 ***
// === 確保所有函式庫 (包含本地 pdf.min.js) 都載入後才執行
// ==========================================================
window.onload = function() {

    // --- 設定 workerSrc 指向本地檔案 ---
    pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';

    let pdfFiles = [];
    let selectedPages = [];
    let draggedElement = null;
    let viewMode = 'list';
    let thumbnailSize = 'medium';
    let lastSelectedIndex = null;
    let clearFilesConfirmMode = false;
    let clearSelectedConfirmMode = false;
    let isSourceEditMode = false;

    let targetViewMode = 'grid'; // 預設為縮圖模式
    let targetThumbnailSize = 'medium';
    
    // --- 新增變數：用於 PDF 預覽 ---
    let finalPdfBytes = null;
    let currentPreviewUrl = null;

    let lastSourceClickGlobalIndex = null; // 記錄上一次點擊的來源頁面索引

    // --- 檢查其他函式庫 ---
    if (typeof PDFLib === 'undefined') {
        console.error("CRITICAL: PDFLib is not defined when onload executes!");
        showNotification("錯誤：PDF 編輯函式庫 (pdf-lib.min.js) 載入失敗。", 'error');
        return;
    }
     if (typeof fontkit === 'undefined') {
        console.error("CRITICAL: fontkit is not defined when onload executes!");
        showNotification("錯誤：字型工具函式庫 (fontkit.umd.min.js) 載入失敗。", 'error');
        return; // fontkit 對於載入字型至關重要
    }

    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const fileList = document.getElementById('fileList');
    const sourcePanel = document.getElementById('sourcePanel');
    const sourcePages = document.getElementById('sourcePages');
    const selectedPagesContainer = document.getElementById('selectedPages');
    const progress = document.getElementById('progress');
    const tocModal = document.getElementById('tocModal');
    const tocTextarea = document.getElementById('tocTextarea');
    const notification = document.getElementById('notification'); // 新增：通知 DOM

    // 1. 在變數宣告區（最上方）加入：
    const addTocCheckbox = document.getElementById('addTocCheckbox');
    const tocSettingsPanel = document.getElementById('tocSettingsPanel');


    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
    uploadArea.addEventListener('dragleave', () => { uploadArea.classList.remove('drag-over'); });
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
        handleFiles(files);
    });
    fileInput.addEventListener('change', (e) => { handleFiles(Array.from(e.target.files)); });

    // ==========================================================
    // === 新函式：顯示通知
    // ==========================================================
    function showNotification(message, type = 'error') {
        if (!notification) return;
        
        notification.textContent = message;
        notification.className = type; // 'error', 'success', 'info'
        notification.classList.add('show');
        
        setTimeout(() => {
            notification.classList.remove('show');
        }, 3000);
    }
    
    async function handleFiles(files) {
        if (files.length === 0) return;
        
        progress.textContent = `⏳ 正在載入 ${files.length} 個檔案...`;
        progress.classList.remove('success', 'error');
        progress.classList.add('active');

        for (const file of files) {
            const fileData = { name: file.name, file: file, pages: [], pdfDoc: null };
            try {
                const arrayBuffer = await file.arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                fileData.pdfDoc = pdf;
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    const viewport = page.getViewport({ scale: 0.5 });
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    await page.render({ canvasContext: context, viewport: viewport }).promise;
                    
                    const title = await extractTitleFromPage(page, i);
                    fileData.pages.push({ 
                    pageNum: i, 
                    canvas: canvas, 
                    firstLine: title,
                    // ▼▼▼ 新增屬性 ▼▼▼
                    isChecked: false, 
                    sourceRotation: 0 
                });
            }
            pdfFiles.push(fileData);
            } catch (error) {
                console.error(`處理檔案 "${file.name}" 失敗:`, error);
                showNotification(`處理檔案 "${file.name}" 失敗，檔案可能已損毀。`, 'error');
            }
        }
        updateFileList();
        renderSourcePages();

        progress.textContent = '✅ 檔案載入完成！';
        progress.classList.add('success');
        setTimeout(() => {
            progress.classList.remove('active', 'success');
        }, 2000);
    }

    async function extractTitleFromPage(page, pageNum) {
        try {
            const textContent = await page.getTextContent();
            if (!textContent || !textContent.items || textContent.items.length === 0) {
                 return `Page ${pageNum}`;
            }

            const items = textContent.items
                .map(item => ({
                    text: item.str ? item.str.trim() : '',
                    y: item.transform ? item.transform[5] : 0,
                    x: item.transform ? item.transform[4] : 0,
                    height: item.height || 0,
                }))
                .filter(item => item.text.length > 0)
                .sort((a, b) => b.y - a.y || a.x - b.x);

            if (items.length === 0) {
                 return `Page ${pageNum}`;
            }

            const lines = [];
            let currentLine = [items[0]];
            for (let i = 1; i < items.length; i++) {
                if (Math.abs(items[i].y - currentLine[0].y) < 5) {
                    currentLine.push(items[i]);
                } else {
                    lines.push(currentLine.sort((a, b) => a.x - b.x));
                    currentLine = [items[i]];
                }
            }
            lines.push(currentLine.sort((a, b) => a.x - b.x));


            let title = `Page ${pageNum}`;
            if (lines.length > 0 && lines[0].length > 0) {
                let titleLineText = lines[0].map(item => item.text).join(' ');
                
                if (lines.length > 1 && lines[1].length > 0) {
                    const firstLineY = lines[0][0].y;
                    const firstLineHeight = lines[0][0].height;
                    const secondLineY = lines[1][0].y;
                    if (Math.abs(firstLineY - secondLineY) < firstLineHeight * 1.8) {
                        titleLineText += ' ' + lines[1].map(item => item.text).join(' ');
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
                    if (pos !== -1) {
                        cleanedTitle = cleanedTitle.substring(0, pos).trim();
                    }
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

                if (cleanedTitle) {
                    title = cleanedTitle;
                }
            }
            return title;
        } catch (error) {
             console.error(`Error extracting title from page ${pageNum}:`, error);
             return `Page ${pageNum}`;
        }
    }

    // Assign functions to window scope *within* onload
    window.updateFileList = updateFileList;
    window.removeFile = removeFile;
    window.clearAllFiles = clearAllFiles;
    window.setViewMode = setViewMode;
    window.setThumbnailSize = setThumbnailSize;
    window.toggleSourceEditMode = toggleSourceEditMode;
    window.deleteSourcePage = deleteSourcePage;
    window.togglePage = togglePage;
    window.clearSelectedPages = clearSelectedPages;
    window.addSectionDivider = addSectionDivider;
    window.removeSelectedPage = removeSelectedPage;
    window.openTocEditor = openTocEditor;
    window.closeTocEditor = closeTocEditor;
    window.saveToc = saveToc;
    window.generatePDF = generatePDF;
    
    
    // --- 新增：註冊新函式到 window ---
    window.rotateSelectedPage = rotateSelectedPage;
    window.downloadGeneratedPDF = downloadGeneratedPDF;
    window.closePreview = closePreview;
    // ▼▼▼ 新增註冊 ▼▼▼
    window.executeQuickSelect = executeQuickSelect;
    
    
    // 2. 在 window 函式註冊區加入：
    // === 註冊重設函式 ===
    window.resetTocSettings = resetTocSettings;
    // ▼▼▼ 註冊開始pdf頁面的操作功能 ▼▼▼
    window.toggleSourceCheck = toggleSourceCheck;
    window.toggleSelectAllSource = toggleSelectAllSource;
    window.batchAddToTarget = batchAddToTarget;
    window.batchDeleteFromSource = batchDeleteFromSource;
    window.batchRotateSource = batchRotateSource;

    window.updateQuickSelectFileOptions = updateQuickSelectFileOptions;
    window.applyQuickSelection = applyQuickSelection;
    window.clearAllSourceChecks = clearAllSourceChecks; // 新增方便的清除功能
    // 已選擇的頁面 函式註冊
    window.setTargetViewMode = setTargetViewMode;
    window.setTargetThumbnailSize = setTargetThumbnailSize;
    window.toggleTargetCheck = toggleTargetCheck;
    window.toggleSelectAllTarget = toggleSelectAllTarget;
    window.applyTargetQuickSelection = applyTargetQuickSelection;
    window.batchRotateTarget = batchRotateTarget;
    window.batchDeleteFromTarget = batchDeleteFromTarget;


    function updateFileList() {
        fileList.innerHTML = pdfFiles.map((file, index) => `
            <li class="file-list-item">
                <span>${file.name}</span>
                <button class="btn btn-danger" onclick="removeFile(${index})">✕</button>
            </li>
        `).join('');
        
        // ▼▼▼ 新增：同步更新快速選取的檔案清單 ▼▼▼
        updateQuickSelectFileOptions();
        
    }

    function removeFile(index) {
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
        lastSelectedIndex = null;
        clearFilesConfirmMode = false;
        fileInput.value = '';
        clearBtn.classList.remove('confirm-mode');
        clearBtn.innerHTML = '🗑️ 清除所有檔案';
        updateFileList();
        renderSourcePages();
        renderSelectedPages();
    }

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

    function toggleSourceEditMode() {
        isSourceEditMode = !isSourceEditMode;
        const btn = document.getElementById('editSourceBtn');
        sourcePanel.classList.toggle('edit-mode', isSourceEditMode);
        btn.classList.toggle('active', isSourceEditMode);
        btn.innerHTML = isSourceEditMode ? '✓ 完成' : '🗑️ 刪除頁面';
        renderSourcePages();
    }

    function deleteSourcePage(fileIndex, pageIndex) {
        if (!pdfFiles[fileIndex] || !pdfFiles[fileIndex].pages[pageIndex]) return;
        const pageToDelete = pdfFiles[fileIndex].pages[pageIndex];
        selectedPages = selectedPages.filter(p => !(p.type !== 'divider' && p.fileIndex === fileIndex && p.pageNum === pageToDelete.pageNum));
        pdfFiles[fileIndex].pages.splice(pageIndex, 1);
        if (pdfFiles[fileIndex].pages.length === 0) {
            removeFile(fileIndex);
        } else {
            renderSourcePages();
            renderSelectedPages();
        }
    }

    function togglePage(fileIndex, pageIndex, event) {
        if (isSourceEditMode) return;
        if (!pdfFiles[fileIndex] || !pdfFiles[fileIndex].pages[pageIndex]) return;
        
        const currentGlobalIndex = getGlobalPageIndex(fileIndex, pageIndex);
        if (event && event.shiftKey && lastSelectedIndex !== null) {
            const start = Math.min(lastSelectedIndex, currentGlobalIndex);
            const end = Math.max(lastSelectedIndex, currentGlobalIndex);
            for (let i = start; i <= end; i++) {
                const pos = getPageByGlobalIndex(i);
                if (pos && pdfFiles[pos.fileIndex] && pdfFiles[pos.fileIndex].pages[pos.pageIndex]) {
                    const f = pdfFiles[pos.fileIndex];
                    const p = f.pages[pos.pageIndex];
                    if (!selectedPages.some(sp => sp.type !== 'divider' && sp.fileIndex === pos.fileIndex && sp.pageNum === p.pageNum)) {
                        selectedPages.push({ 
                            type: 'page', 
                            fileIndex: pos.fileIndex, 
                            pageNum: p.pageNum, 
                            fileName: f.name, 
                            canvas: p.canvas, 
                            firstLine: p.firstLine,
                            rotation: 0 // <-- 新增：旋轉屬性
                        });
                    }
                }
            }
        } else {
            const file = pdfFiles[fileIndex];
            const page = file.pages[pageIndex];
            const existingIndex = selectedPages.findIndex(p => p.type !== 'divider' && p.fileIndex === fileIndex && p.pageNum === page.pageNum);
            if (existingIndex >= 0) {
                selectedPages.splice(existingIndex, 1);
            } else {
                selectedPages.push({ 
                    type: 'page', 
                    fileIndex: fileIndex, 
                    pageNum: page.pageNum, 
                    fileName: file.name, 
                    canvas: page.canvas, 
                    firstLine: page.firstLine,
                    rotation: 0 // <-- 新增：旋轉屬性
                });
            }
        }
        lastSelectedIndex = currentGlobalIndex;
        renderSourcePages();
        renderSelectedPages();
    }

    // ==========================================
    // === 輔助函式：全域索引計算
    // ==========================================
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

    // ==========================================
    // === 核心：支援 Shift 多選的切換函式
    // ==========================================
    // ==========================================
    // === 核心：支援 Shift 多選的切換函式 (修正版)
    // ==========================================
    function toggleSourceCheck(fileIndex, pageIndex, event) {
        if (!pdfFiles[fileIndex] || !pdfFiles[fileIndex].pages[pageIndex]) return;
        
        const currentGlobalIndex = getGlobalPageIndex(fileIndex, pageIndex);
        const targetPage = pdfFiles[fileIndex].pages[pageIndex];

        // ★★★ 關鍵修正：判斷 Shift 鍵 ★★★
        // 判斷是否按住了 Shift 鍵，且之前有點擊過有效的位置
        if (event && event.shiftKey && lastSourceClickGlobalIndex !== null) {
            
            // 1. 先改變「當前點擊頁面」的狀態，作為這次連選的目標狀態
            //    (例如：原本沒勾，點下去變勾，那中間所有頁面都要變勾)
            targetPage.isChecked = !targetPage.isChecked;
            const targetState = targetPage.isChecked; 

            // 2. 計算範圍 (從小到大)
            const start = Math.min(lastSourceClickGlobalIndex, currentGlobalIndex);
            const end = Math.max(lastSourceClickGlobalIndex, currentGlobalIndex);

            // 3. 迴圈將範圍內的所有頁面設為目標狀態
            for (let i = start; i <= end; i++) {
                const pos = getPageByGlobalIndex(i);
                if (pos) {
                    pdfFiles[pos.fileIndex].pages[pos.pageIndex].isChecked = targetState;
                }
            }
            
            // Shift 連選後，最後點擊的位置依然更新為當前位置，方便連續操作
            lastSourceClickGlobalIndex = currentGlobalIndex;

        } else {
            // --- 一般單點模式 (沒有按 Shift) ---
            targetPage.isChecked = !targetPage.isChecked;
            
            // ★★★ 關鍵：一定要記錄這次點擊的位置，下次 Shift 才能用 ★★★
            lastSourceClickGlobalIndex = currentGlobalIndex;
        }
        
        renderSourcePages();
        updateSelectedCountInfo();
    }
    
    function getPageByGlobalIndex(globalIndex) {
        let count = 0;
        for (let fileIndex = 0; fileIndex < pdfFiles.length; fileIndex++) {
             if (pdfFiles[fileIndex]) {
                 const file = pdfFiles[fileIndex];
                 if (globalIndex < count + file.pages.length) {
                    return { fileIndex, pageIndex: globalIndex - count };
                 }
                count += file.pages.length;
            }
        }
        return null;
    }

    function clearSelectedPages() {
        if (selectedPages.length === 0) return;
        const btn = document.getElementById('clearSelectedBtn');
        if (!clearSelectedConfirmMode) {
            clearSelectedConfirmMode = true;
            btn.classList.add('confirm-mode');
            btn.textContent = '確定清除？';
            setTimeout(() => {
                clearSelectedConfirmMode = false;
                btn.classList.remove('confirm-mode');
                btn.textContent = '🗑️ 清除選取';
            }, 3000);
            return;
        }
        selectedPages = [];
        clearSelectedConfirmMode = false;
        btn.classList.remove('confirm-mode');
        btn.textContent = '🗑️ 清除選取';
        renderSourcePages();
        renderSelectedPages();
    }

    function addSectionDivider() {
        const title = prompt("請輸入小節標題：");
        if (title && title.trim()) {
            selectedPages.push({
                type: 'divider',
                firstLine: title.trim(),
                id: Date.now()
            });
            renderSelectedPages();
        }
    }

    function renderSourcePages() {
        if (pdfFiles.length === 0) {
            sourcePages.innerHTML = '<div class="empty-message">尚未載入任何 PDF 檔案</div>';
            return;
        }
        sourcePages.innerHTML = pdfFiles.map((file, fileIndex) => {
             if (!file) return '';
             const pagesHtml = viewMode === 'grid' 
                ? `<div class="pages-grid">${file.pages.map((page, pageIndex) => renderPageItem(fileIndex, pageIndex, 'grid')).join('')}</div>`
                : `<div class="pages-list">${file.pages.map((page, pageIndex) => renderPageItem(fileIndex, pageIndex, 'list')).join('')}</div>`;
             return `<div class="pdf-file"><div class="pdf-file-header"><div class="pdf-file-name">${file.name || 'Unknown File'}</div></div>${pagesHtml}</div>`;
        }).join('');

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
                         } else {
                             console.warn(`Invalid canvas dimensions for source_${fileIndex}_${pageIndex}`);
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
        
        // ★★★ 修改處：在 onclick 中加入 event 參數 ★★★
        const clickAction = `onclick="toggleSourceCheck(${fileIndex}, ${pageIndex}, event)"`;
        // Checkbox 也要加 event，並阻止冒泡
        const checkboxAction = `onclick="event.stopPropagation(); toggleSourceCheck(${fileIndex}, ${pageIndex}, event)"`;

        if (type === 'grid') {
            return `
                <div class="page-item ${checkedClass}" ${clickAction}>
                    <input type="checkbox" class="page-checkbox" ${checkedAttr} ${checkboxAction}>
                    <div style="overflow:hidden; display:flex; justify-content:center; align-items:center; height: 100%; width: 100%;">
                        <canvas id="source_${fileIndex}_${pageIndex}" style="${rotationStyle}"></canvas>
                    </div>
                    <div class="page-number">第 ${page.pageNum} 頁</div> 
                </div>`;
        } else {
             const title = page.firstLine || `Page ${page.pageNum}`;
            return `
                <div class="page-list-item ${checkedClass}" ${clickAction} title="${title}">
                    <input type="checkbox" class="page-checkbox" ${checkedAttr} ${checkboxAction}>
                    <div style="width: 30px; display: flex; justify-content: center;">
                        <canvas id="source_${fileIndex}_${pageIndex}" style="width: 100%; ${rotationStyle}"></canvas>
                    </div>
                    <div class="page-list-text">${title}</div>
                    <div class="page-list-number">第 ${page.pageNum} 頁</div>
                </div>`;
        }
    }


// ==========================================
    // === 右側 (Target) 面板功能函式
    // ==========================================

    function setTargetViewMode(mode) {
        targetViewMode = mode;
        document.getElementById('targetGridViewBtn').classList.toggle('active', mode === 'grid');
        document.getElementById('targetListViewBtn').classList.toggle('active', mode === 'list');
        renderSelectedPages();
    }

    function setTargetThumbnailSize(size) {
        targetThumbnailSize = size;
        const container = document.getElementById('targetPanel');
        // 移除舊的 size class
        container.classList.remove('size-small', 'size-medium', 'size-large');
        container.classList.add(`size-${size}`);
        
        // 更新按鈕狀態
        document.querySelectorAll('#target-size-toggle button').forEach(btn => btn.classList.remove('active'));
        document.querySelector(`#target-size-toggle button[onclick="setTargetThumbnailSize('${size}')"]`).classList.add('active');
    }

    // ★★★ 重寫 renderSelectedPages 以支援 Grid/List 與 Checkbox ★★★
    function renderSelectedPages() {
        if (selectedPages.length === 0) {
            selectedPagesContainer.innerHTML = '<div class="empty-message">尚未選擇任何頁面</div>';
            updateTargetSelectedInfo();
            return;
        }

        // 根據 ViewMode 設定容器 class
        selectedPagesContainer.className = `selected-pages ${targetViewMode}-view`;

        selectedPagesContainer.innerHTML = selectedPages.map((item, index) => {
             if (!item) return '';
             
             // 如果是分隔線 (Section Divider)
             if (item.type === 'divider') {
                return `
                    <div class="selected-divider-item" draggable="true" data-index="${index}">
                        <span class="drag-handle">::</span>
                         <div class="selected-divider-title">${item.firstLine || 'New Section'}</div> 
                        <div class="page-actions">
                            <button class="btn btn-danger" onclick="removeSelectedPage(${index})">✕</button>
                        </div>
                    </div>
                `;
            }

            // 一般頁面
            const title = item.firstLine || `Page ${item.pageNum || '?'}`;
            const source = `${item.fileName || 'Unknown File'} - 第 ${item.pageNum || '?'} 頁`;
            const checkedAttr = item.isChecked ? 'checked' : '';
            const checkedClass = item.isChecked ? 'checked' : '';
            const rotationStyle = `transform: rotate(${item.rotation || 0}deg);`;
            
            // 點擊事件：切換勾選
            const clickAction = `onclick="toggleTargetCheck(${index})"`;

            if (targetViewMode === 'grid') {
                return `
                <div class="selected-page-item grid-item ${checkedClass}" draggable="true" data-index="${index}" ${clickAction}>
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
                // List View
                return `
                <div class="selected-page-item list-item ${checkedClass}" draggable="true" data-index="${index}" ${clickAction}>
                    <span class="drag-handle">::</span>
                    <input type="checkbox" class="page-checkbox" ${checkedAttr} onclick="event.stopPropagation(); toggleTargetCheck(${index})">
                    <div class="list-thumb-wrapper">
                        <canvas id="selected_${index}" style="${rotationStyle}"></canvas>
                    </div>
                    <div class="selected-page-info">
                        <div class="selected-page-title">${index + 1}. ${title}</div>
                        <div class="selected-page-source">${source}</div>
                    </div>
                </div>
                `;
            }
        }).join('');

        // 繪製 Canvas (邏輯與之前類似，但要注意縮圖大小)
        selectedPages.forEach((item, index) => {
             if (item && item.type !== 'divider') {
                 const canvas = document.getElementById(`selected_${index}`);
                 if (canvas && item.canvas) {
                    // 這裡只負責繪製內容，旋轉由 CSS transform 處理
                    // 為了效能，縮圖可以畫小一點，但這裡為了清晰度維持原比例
                    canvas.width = item.canvas.width;
                    canvas.height = item.canvas.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(item.canvas, 0, 0);
                 }
             }
        });

        setupDragAndDrop(); // 重新綁定拖曳事件
        updateTargetSelectedInfo(); // 更新已選數量
    }

    // 1. 單選切換
    function toggleTargetCheck(index) {
        if (!selectedPages[index]) return;
        // 如果該物件沒有 isChecked 屬性，先初始化
        if (selectedPages[index].isChecked === undefined) selectedPages[index].isChecked = false;
        
        selectedPages[index].isChecked = !selectedPages[index].isChecked;
        renderSelectedPages();
    }

    // 2. 全選切換
    function toggleSelectAllTarget(checkbox) {
        const checked = checkbox.checked;
        selectedPages.forEach(p => {
            if (p.type !== 'divider') p.isChecked = checked;
        });
        renderSelectedPages();
    }

    // 3. 智慧勾選邏輯
    function applyTargetQuickSelection() {
        const type = document.getElementById('qsTargetTypeSelect').value;
        let count = 0;
        
        // 過濾掉分隔線，只計算實際頁面的索引位置
        // 注意：這裡的 "奇數/偶數" 是指「在成品PDF中的順序」，不是原始頁碼
        let pageIndexCounter = 0;

        selectedPages.forEach((item) => {
            if (item.type === 'divider') return;
            
            // pageIndexCounter 從 0 開始 (代表成品第1頁)
            const currentPos = pageIndexCounter + 1; 
            let shouldCheck = false;

            switch (type) {
                case 'all': shouldCheck = true; break;
                case 'odd': shouldCheck = (currentPos % 2 !== 0); break;
                case 'even': shouldCheck = (currentPos % 2 === 0); break;
                case 'first': shouldCheck = (pageIndexCounter === 0); break;
                case 'last': 
                    // 這裡需要計算總頁數 (不含divider)
                    const totalPages = selectedPages.filter(p => p.type !== 'divider').length;
                    shouldCheck = (pageIndexCounter === totalPages - 1); 
                    break;
                case 'blank':
                    // 檢查原始標題是否為預設值
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

    // 4. 批次刪除
    function batchDeleteFromTarget() {
        const initialLen = selectedPages.length;
        selectedPages = selectedPages.filter(p => !p.isChecked); // 只保留沒被勾選的
        
        const deletedCount = initialLen - selectedPages.length;
        if (deletedCount > 0) {
            renderSelectedPages();
            document.getElementById('selectAllTarget').checked = false;
            showNotification(`已從右側移除 ${deletedCount} 頁`, 'success');
        } else {
            showNotification('請先勾選右側頁面', 'info');
        }
    }

    // 5. 批次旋轉
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
            renderSelectedPages();
        } else {
            showNotification('請先勾選右側頁面', 'info');
        }
    }

    function updateTargetSelectedInfo() {
        const count = selectedPages.filter(p => p.isChecked).length;
        const el = document.getElementById('targetSelectedCountInfo');
        if(el) el.textContent = `(${count})`;
    }


    function removeSelectedPage(index) {
        selectedPages.splice(index, 1);
        renderSourcePages();
        renderSelectedPages();
    }

    // ==========================================================
    // === 新函式：旋轉已選頁面
    // ==========================================================
    function rotateSelectedPage(index) {
        if (!selectedPages[index] || selectedPages[index].type === 'divider') {
            return;
        }
        
        // 旋轉角度： 0 -> 90 -> 180 -> 270 -> 0
        let currentRotation = selectedPages[index].rotation || 0;
        let newRotation = (currentRotation + 90) % 360;
        selectedPages[index].rotation = newRotation;
        
        // 重新渲染右側列表
        renderSelectedPages();
    }


    function setupDragAndDrop() {
        document.querySelectorAll('.selected-page-item, .selected-divider-item').forEach(item => {
            item.addEventListener('dragstart', (e) => {
                draggedElement = item;
                item.classList.add('dragging');
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                }
            });
            item.addEventListener('dragend', () => {
                 if(draggedElement) draggedElement.classList.remove('dragging');
                 draggedElement = null;
            });
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (!draggedElement) return;
                const afterElement = getDragAfterElement(selectedPagesContainer, e.clientY);
                try {
                    if (afterElement == null) {
                         if (selectedPagesContainer.lastChild !== draggedElement) {
                             selectedPagesContainer.appendChild(draggedElement);
                         }
                    } else {
                         if (afterElement !== draggedElement && afterElement.previousSibling !== draggedElement) {
                             selectedPagesContainer.insertBefore(draggedElement, afterElement);
                         }
                    }
                } catch (error) {
                    console.error("Error during dragover DOM manipulation:", error);
                }
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                 if (!draggedElement) return;

                 const fromIndexAttr = draggedElement.getAttribute('data-index');
                 if (fromIndexAttr === null) {
                    console.error("Dragged element missing data-index attribute.");
                     renderSelectedPages(); // Attempt to restore visual state
                    return;
                 }
                 const fromIndex = parseInt(fromIndexAttr, 10);

                 const currentChildren = Array.from(selectedPagesContainer.children);
                 const toIndex = currentChildren.indexOf(draggedElement);

                 if (isNaN(fromIndex) || fromIndex < 0 || fromIndex >= selectedPages.length || toIndex < 0) {
                      console.error("Invalid index during drop:", { fromIndex, toIndex, selectedPagesLength: selectedPages.length });
                      renderSelectedPages();
                      return;
                 }

                 if (fromIndex !== toIndex) {
                     const [movedItem] = selectedPages.splice(fromIndex, 1);
                     if (movedItem) {
                          selectedPages.splice(toIndex, 0, movedItem);
                       } else {
                           console.error("Splice failed to return the moved item.");
                           renderSelectedPages();
                           return;
                       }
                 }
                renderSelectedPages(); // Always re-render
            });
        });
    }

    function getDragAfterElement(container, y) {
        const draggableElements = [...container.children].filter(child =>
            child.matches('.selected-page-item, .selected-divider-item') && !child.classList.contains('dragging')
        );

        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const midpoint = box.top + box.height / 2;
            const offset = y - midpoint;
            if (offset > 0 && offset < closest.offset) { // Find closest element *below* cursor
                return { offset: offset, element: child };
            } else {
                return closest;
            }
         }, { offset: Number.POSITIVE_INFINITY }).element;
    }


    function openTocEditor() {
        const pageItems = selectedPages.filter(p => p && p.type !== 'divider');
        if (pageItems.length === 0) {
            showNotification('請先選擇至少一個頁面才能編輯目錄。', 'info');
            return;
        }
        const titles = pageItems.map(p => p.firstLine || `Page ${p.pageNum || '?'}`).join('\n');
        tocTextarea.value = titles;
        tocModal.style.display = 'flex';
    }

    function closeTocEditor() {
        tocModal.style.display = 'none';
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
    
    // 4. 在函式定義區加入重設函式：
    // ==========================================================
    // === 重設目錄設定為預設值
    // ==========================================================
    function resetTocSettings() {
        document.getElementById('tocMainTitleSize').value = 20;
        document.getElementById('tocSectionSize').value = 14;
        document.getElementById('tocItemTitleSize').value = 12;
        document.getElementById('tocPageNumSize').value = 12;
        document.getElementById('tocLineHeight').value = 20;
        showNotification('✅ 已重設為預設值', 'success');
    }

    // ==========================================================
    // === 新函式：處理預覽和下載
    // ==========================================================

    // --- 負責「觸發下載」的函式 (從 generatePDF 搬移過來)
    function downloadGeneratedPDF() {
        if (!finalPdfBytes) {
            showNotification("沒有可下載的 PDF 檔案。", 'error');
            return;
        }

        const blob = new Blob([finalPdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob); // 建立一個新的 URL
        const a = document.createElement('a');
        a.href = url;
        a.style.display = 'none';

        const defaultFileName = '重組後的PDF_' + new Date().toISOString().slice(0, 10) + '.pdf';
        let finalFileName = prompt("請確認檔案名稱：", defaultFileName);

        if (finalFileName === null) {
            // 使用者取消下載
            URL.revokeObjectURL(url); // 釋放這個下載 URL
            return; // 保持預覽開啟
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
                URL.revokeObjectURL(url); // 釋放下載 URL
            } catch (cleanupError) { console.error("Error during cleanup:", cleanupError); }
        }, 100);
        
        // 下載完畢，關閉預覽
        closePreview();
    }

    // --- 負責「關閉預覽」的函式
    function closePreview() {
        const modal = document.getElementById('previewModal');
        const iframe = document.getElementById('previewFrame');
        
        modal.style.display = 'none';
        iframe.src = 'about:blank'; // 清空 iframe

        // 釋放預覽 URL 的記憶體
        if (currentPreviewUrl) {
            URL.revokeObjectURL(currentPreviewUrl);
            currentPreviewUrl = null;
        }
        finalPdfBytes = null; // 清空
    }

    // 5. 完整的 generatePDF 函式（替換整個函式）
    // ==========================================================
    // === generatePDF - 完整版本（含使用者可調整字型設定）
    // ==========================================================
    async function generatePDF() {
        if (typeof PDFLib === 'undefined' || typeof PDFLib.PDFDocument === 'undefined') {
            console.error("PDFLib not available in generatePDF");
            showNotification("錯誤：無法生成 PDF，編輯函式庫載入失敗。", 'error');
            return;
        }

        const { PDFDocument, rgb, StandardFonts, PDFName, PDFArray } = PDFLib;

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
            
            // --- 優化：建立 PDF-Lib 文件快取 ---
            const pdfLibDocCache = new Map();

            try {
                progress.textContent = '正在載入中文字型...';
                const fontUrl = './fonts/NotoSansTC-Regular.ttf';
                const fontBytes = await fetch(fontUrl).then(res => {
                    if (!res.ok) throw new Error(`字型檔案 (${fontUrl}) 載入失敗！ status: ${res.status}`);
                    return res.arrayBuffer();
                });
                
                if (typeof fontkit === 'undefined') {
                    throw new Error("fontkit 函式庫載入失敗");
                }
                newPdf.registerFontkit(fontkit); 
                customFont = await newPdf.embedFont(fontBytes);
                progress.textContent = '中文字型載入成功!';
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (fontError) {
                console.error("中文字型載入失敗:", fontError);
                showNotification(`警告：無法載入本地字型。目錄將使用英文字型。`, 'error');
                try {
                    customFont = await newPdf.embedFont(StandardFonts.Helvetica);
                } catch (embedError) {
                    console.error("Failed to embed fallback font:", embedError);
                    showNotification("致命錯誤：無法嵌入預設字型。", 'error');
                    progress.textContent = '❌ 生成失敗：無法嵌入字型';
                    progress.classList.add('active', 'error');
                    return;
                }
            }
            
            const addToc = addTocCheckbox.checked;
            
            // ▼▼▼ 讀取新增頁碼的選項 ▼▼▼
            const addPageNumbers = document.getElementById('addPageNumbersCheckbox').checked;
            // ▲▲▲ 讀取新增頁碼的選項 ▲▲▲
            
            let tocPages = []; // 追蹤所有目錄頁
            let tocLinkData = []; // 儲存目錄項目的位置資訊（用於後續建立超連結）

            if (addToc) {
                progress.textContent = '正在建立目錄頁...';
                
                // === 讀取使用者設定的字型大小 ===
                const TOC_CONFIG = {
                    MAIN_TITLE_SIZE: parseInt(document.getElementById('tocMainTitleSize').value) || 20,
                    SECTION_TITLE_SIZE: parseInt(document.getElementById('tocSectionSize').value) || 14,
                    ITEM_TITLE_SIZE: parseInt(document.getElementById('tocItemTitleSize').value) || 12,
                    ITEM_PAGENUM_SIZE: parseInt(document.getElementById('tocPageNumSize').value) || 12,
                    LINE_HEIGHT: parseInt(document.getElementById('tocLineHeight').value) || 20
                };
                
                let tocPage = newPdf.addPage([842, 595]); // 橫向A4
                tocPages.push(tocPage);
                
                // 使用使用者設定的大小繪製主標題
                tocPage.drawText('目錄', { 
                    x: 50, 
                    y: 595 - 50, 
                    size: TOC_CONFIG.MAIN_TITLE_SIZE,
                    font: customFont, 
                    color: rgb(0,0,0) 
                });
                
                let yPosition = 595 - 90;
                let pageCounterForToc = 0;

                for (const item of selectedPages) {
                    if (!item) continue;
                    
                    // --- TOC 頁面溢出處理 ---
                    if (yPosition < 50) {
                        tocPage = newPdf.addPage([842, 595]);
                        tocPages.push(tocPage);
                        yPosition = 595 - 90;
                        tocPage.drawText('目錄 (續)', { 
                            x: 50, 
                            y: 595 - 50, 
                            size: TOC_CONFIG.MAIN_TITLE_SIZE,
                            font: customFont, 
                            color: rgb(0,0,0) 
                        });
                    }

                    if (item.type === 'divider') {
                        yPosition -= 10;
                        tocPage.drawText(item.firstLine || 'New Section', { 
                            x: 50, 
                            y: yPosition, 
                            size: TOC_CONFIG.SECTION_TITLE_SIZE,
                            font: customFont, 
                            color: rgb(0,0,0) 
                        });
                        yPosition -= 25;
                    } else {
                        pageCounterForToc++;
                        const title = item.firstLine || `Page ${item.pageNum || '?'}`;
                        const pageNumStr = `${pageCounterForToc + tocPages.length}`;
                        
                        const leftMargin = 70;
                        const rightMargin = 50;
                        const pageContentWidth = tocPage.getWidth() - leftMargin - rightMargin;
                        
                        let pageNumWidth = 0;
                        let titleWidth = 0;
                        
                        // 使用設定的字型大小計算寬度
                        try { 
                            pageNumWidth = customFont.widthOfTextAtSize(pageNumStr, TOC_CONFIG.ITEM_PAGENUM_SIZE); 
                        } catch (e) { 
                            console.error("Err getting pageNum width:", e); 
                        }
                        
                        let truncatedTitle = title;
                        try { 
                            titleWidth = customFont.widthOfTextAtSize(truncatedTitle, TOC_CONFIG.ITEM_TITLE_SIZE); 
                        } catch (e) { 
                            console.error("Err getting title width:", e); 
                        }
                        
                        const minDotSpace = 20;
                        while (titleWidth > 0 && pageContentWidth > 0 && (titleWidth + pageNumWidth + minDotSpace > pageContentWidth) && truncatedTitle.length > 5) {
                            truncatedTitle = truncatedTitle.slice(0, -2) + '…';
                            try { 
                                titleWidth = customFont.widthOfTextAtSize(truncatedTitle, TOC_CONFIG.ITEM_TITLE_SIZE); 
                            } catch (e) { 
                                titleWidth = 0; 
                            }
                        }
                        
                        // === 繪製標題（使用使用者設定）===
                        tocPage.drawText(truncatedTitle, { 
                            x: leftMargin, 
                            y: yPosition, 
                            size: TOC_CONFIG.ITEM_TITLE_SIZE,
                            font: customFont, 
                            color: rgb(0, 0, 0) // 目錄的顏色
                        });
                        
                        // === 繪製頁碼（使用使用者設定）===
                        tocPage.drawText(pageNumStr, { 
                            x: tocPage.getWidth() - rightMargin - pageNumWidth, 
                            y: yPosition, 
                            size: TOC_CONFIG.ITEM_PAGENUM_SIZE,
                            font: customFont, 
                            color: rgb(0, 0, 0) 
                        });
                        
                        // === 繪製點點 ===
                        let dotWidth = 0;
                        const dotSize = Math.min(TOC_CONFIG.ITEM_TITLE_SIZE, TOC_CONFIG.ITEM_PAGENUM_SIZE);
                        try { 
                            dotWidth = customFont.widthOfTextAtSize('.', dotSize); 
                        } catch (e) { 
                            console.error("Err getting dot width:", e); 
                        }
                        
                        if (dotWidth > 0) {
                            const dotStartX = leftMargin + titleWidth + 5;
                            const dotEndX = tocPage.getWidth() - rightMargin - pageNumWidth - 5;
                            const availableDotSpace = dotEndX - dotStartX;
                            if (availableDotSpace > dotWidth) {
                                const numDots = Math.floor(availableDotSpace / dotWidth);
                                const dotString = '.'.repeat(numDots);
                                tocPage.drawText(dotString, { 
                                    x: dotStartX, 
                                    y: yPosition, 
                                    size: dotSize,
                                    font: customFont, 
                                    color: rgb(0, 0, 0), 
                                    opacity: 0.5 
                                });
                            }
                        }
                        
                        // === 儲存連結資訊（稍後建立）===
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
                        
                        // 使用使用者設定的行距
                        yPosition -= TOC_CONFIG.LINE_HEIGHT;
                    }
                }
            }
            
            // === 開始合併內容頁 ===
            let pageCounterForContent = 0;
            const pageOffset = tocPages.length; // 目錄頁數作為頁碼偏移

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
                    // --- 優化：使用快取載入 PDF ---
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

                    // --- 套用旋轉 ---
                    if (item.rotation && item.rotation !== 0) {
                        copiedPage.rotate(item.rotation);
                    }
                    
                    newPdf.addPage(copiedPage);
                    
                    // ▼▼▼ 加上新的頁碼 (如果使用者有勾選) ▼▼▼
                    if (addPageNumbers) {
                        const newPageNumber = `${pageCounterForContent + pageOffset}`;
                        const { width, height } = copiedPage.getSize();
                        
                        if (width > 0 && height > 0) {
                            copiedPage.drawText(newPageNumber, { 
                                x: width - 40, 
                                y: 30, 
                                size: 10, 
                                font: customFont, 
                                color: rgb(0, 0, 0) 
                            });
                        } else { 
                            console.warn(`Invalid dimensions page ${pageCounterForContent}`); 
                        }
                    }
                    // ▲▲▲ 頁碼邏輯結束 ▲▲▲
                    
                } catch(loadError) {
                    console.error(`Error loading/copying page ${item.pageNum} from ${sourceFile.name}:`, loadError);
                    showNotification(`錯誤：無法處理檔案 "${sourceFile.name}" 第 ${item.pageNum} 頁。`, 'error');
                }
            }

            // === 在所有頁面建立完成後，建立目錄超連結 ===
            if (addToc && tocLinkData.length > 0) {
                progress.textContent = '正在建立目錄超連結...';
                
                const allPages = newPdf.getPages();
                
                for (let i = 0; i < tocLinkData.length; i++) {
                    const linkInfo = tocLinkData[i];
                    const targetPageIndex = tocPages.length + linkInfo.targetContentPageIndex;
                    
                    if (targetPageIndex >= allPages.length) {
                        console.warn(`目標頁面索引 ${targetPageIndex} 超出範圍`);
                        continue;
                    }
                    
                    const targetPage = allPages[targetPageIndex];
                    
                    try {
                        // 建立 Link Annotation
                        const linkAnnot = linkInfo.tocPage.doc.context.obj({
                            Type: 'Annot',
                            Subtype: 'Link',
                            Rect: [
                                linkInfo.linkRect.x,
                                linkInfo.linkRect.y,
                                linkInfo.linkRect.x + linkInfo.linkRect.width,
                                linkInfo.linkRect.y + linkInfo.linkRect.height
                            ],
                            Border: [0, 0, 0],
                            C: [0, 0, 1],
                            A: {
                                S: 'GoTo',
                                D: [targetPage.ref, 'Fit']
                            }
                        });
                        
                        // 將 annotation 註冊並加到目錄頁
                        const registeredAnnot = linkInfo.tocPage.doc.context.register(linkAnnot);
                        
                        // 取得或建立 Annots 陣列
                        let annots = linkInfo.tocPage.node.lookup(PDFName.of('Annots'));
                        
                        if (!annots) {
                            annots = linkInfo.tocPage.doc.context.obj([]);
                            linkInfo.tocPage.node.set(PDFName.of('Annots'), annots);
                        }
                        
                        // 將連結加入陣列
                        if (annots instanceof PDFArray || Array.isArray(annots.array)) {
                            annots.push(registeredAnnot);
                        } else {
                            console.warn('Annots is not an array, cannot add link');
                        }
                        
                    } catch (linkError) {
                        console.error(`無法建立超連結 (項目 ${i + 1}):`, linkError);
                    }
                }
            }

            progress.textContent = '正在儲存 PDF...';
            
            // 使用 pdf-lib 生成 PDF 的 bytes
            let pdfBytes = await newPdf.save();

            // --- 不再直接下載，而是開啟預覽 ---
            finalPdfBytes = pdfBytes;
            
            const blob = new Blob([finalPdfBytes], { type: 'application/pdf' });
            currentPreviewUrl = URL.createObjectURL(blob);

            const iframe = document.getElementById('previewFrame');
            const modal = document.getElementById('previewModal');
            
            iframe.src = currentPreviewUrl;
            modal.style.display = 'flex';
            
            progress.textContent = '✅ 預覽生成成功！';
            progress.classList.add('success');
            setTimeout(() => progress.classList.remove('active', 'success'), 5000);

        } catch (error) {
            console.error('生成 PDF 時發生錯誤：', error);
            progress.textContent = '❌ 生成失敗：' + error.message;
            showNotification('❌ 生成失敗：' + error.message, 'error');
            progress.classList.add('active', 'error');
            setTimeout(() => progress.classList.remove('active', 'error'), 8000);
        }
    }


    // --- Initial setup calls within onload ---
    setThumbnailSize('medium');
    tocModal.addEventListener('click', (e) => {
        if (e.target === tocModal) {
            closeTocEditor();
        }
    });
    
    // --- 新增：設定預覽 Modal 的點擊外部關閉 ---
    const previewModal = document.getElementById('previewModal');
    previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) {
            closePreview();
        }
    });
    
    // 3. 在初始化區（接近 window.onload 結尾）加入：
    // === 目錄勾選框控制設定面板顯示 ===
    addTocCheckbox.addEventListener('change', function() {
        if (this.checked) {
            tocSettingsPanel.style.display = 'block';
        } else {
            tocSettingsPanel.style.display = 'none';
        }
    });

    // 初始化時根據勾選狀態顯示/隱藏
    if (addTocCheckbox.checked) {
        tocSettingsPanel.style.display = 'block';
    }
// ==========================================================
    // === 新增功能：快速選取邏輯
    // ==========================================================

    function updateQuickSelectFileOptions() {
        const qsFileSelect = document.getElementById('qsFileSelect');
        if (!qsFileSelect) return;

        qsFileSelect.innerHTML = '';

        if (pdfFiles.length === 0) {
            const option = document.createElement('option');
            option.value = "-1";
            option.text = "-- 請先載入檔案 --";
            qsFileSelect.appendChild(option);
            return;
        }

        const allOption = document.createElement('option');
        allOption.value = "-1";
        allOption.text = "📂 所有已載入檔案";
        qsFileSelect.appendChild(allOption);

        pdfFiles.forEach((file, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.text = `📄 ${index + 1}. ${file.name}`;
            qsFileSelect.appendChild(option);
        });
    }
// 2. 執行「智慧勾選」 (Apply Quick Selection)
    // 邏輯：根據下拉選單的條件，把符合的頁面 isChecked 設為 true
    function applyQuickSelection() {
        const fileIndexStr = document.getElementById('qsFileSelect').value;
        const type = document.getElementById('qsTypeSelect').value;
        const targetFileIndex = parseInt(fileIndexStr); 

        if (pdfFiles.length === 0) {
            showNotification('請先載入 PDF 檔案', 'error');
            return;
        }

        let matchCount = 0;

        // 定義檢查單一頁面的邏輯
        const checkPageLogic = (file, page, pIndex) => {
            let shouldCheck = false;
            const pageNum = page.pageNum;

            switch (type) {
                case 'all': shouldCheck = true; break;
                case 'odd': shouldCheck = (pageNum % 2 !== 0); break;
                case 'even': shouldCheck = (pageNum % 2 === 0); break;
                case 'first': shouldCheck = (pIndex === 0); break;
                case 'last': shouldCheck = (pIndex === file.pages.length - 1); break;
                case 'blank': 
                    // 簡單判斷：如果標題沒抓到內容 (通常標題會是 "Page X")
                    if (page.firstLine === `Page ${pageNum}`) shouldCheck = true;
                    break;
            }

            if (shouldCheck) {
                page.isChecked = true; // ★ 關鍵：只勾選，不取消已勾選的其他頁面 (累加模式)
                matchCount++;
            }
        };

        // 執行迴圈
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
            renderSourcePages(); // 重新渲染以顯示勾勾
            updateSelectedCountInfo();
            showNotification(`已自動勾選 ${matchCount} 個頁面`, 'success');
        } else {
            showNotification('沒有符合條件的頁面', 'info');
        }
    }

    // 3. 快速取消所有勾選 (Helper function)
    function clearAllSourceChecks() {
        pdfFiles.forEach(file => {
            file.pages.forEach(page => page.isChecked = false);
        });
        document.getElementById('selectAllSource').checked = false;
        renderSourcePages();
        updateSelectedCountInfo();
    }
    function executeQuickSelect() {
        const fileIndexStr = document.getElementById('qsFileSelect').value;
        const type = document.getElementById('qsTypeSelect').value;
        const targetFileIndex = parseInt(fileIndexStr); // -1 代表所有檔案

        if (pdfFiles.length === 0) {
            showNotification('請先載入 PDF 檔案', 'error');
            return;
        }

        let addedCount = 0;

        // 定義處理單一檔案的邏輯
        const processFile = (fIndex) => {
            const file = pdfFiles[fIndex];
            if (!file) return;

            file.pages.forEach((page, pIndex) => {
                let shouldSelect = false;
                const pageNum = page.pageNum; // 實際頁碼 (從1開始)

                switch (type) {
                    case 'all':
                        shouldSelect = true;
                        break;
                    case 'odd':
                        shouldSelect = (pageNum % 2 !== 0);
                        break;
                    case 'even':
                        shouldSelect = (pageNum % 2 === 0);
                        break;
                    case 'first':
                        shouldSelect = (pIndex === 0);
                        break;
                    case 'last':
                        shouldSelect = (pIndex === file.pages.length - 1);
                        break;
                    case 'blank':
                        // 判斷空白頁邏輯：依賴 extractTitleFromPage 的結果
                        // 如果標題完全等於 "Page X"，通常代表沒有提取到有意義的文字
                        // 或是檢查 firstLine 是否包含特定關鍵字
                        // *注意：這不是完美的空白頁檢測（因為掃描檔全是圖片），但對文字型PDF有效*
                        if (page.firstLine === `Page ${pageNum}`) {
                            shouldSelect = true;
                        }
                        break;
                }

                if (shouldSelect) {
                    // 檢查是否已經在右側列表中 (避免重複加入)
                    // 如果您希望允許重複，可以移除這個檢查，但通常使用者不希望重複
                    // 這裡我設定為：直接加入，不進行去重檢查 (因為有時候需要複製頁面)
                    // 如果要模仿 togglePage 的行為，我們就直接 push
                    
                    selectedPages.push({ 
                        type: 'page', 
                        fileIndex: fIndex, 
                        pageNum: page.pageNum, 
                        fileName: file.name, 
                        canvas: page.canvas, 
                        firstLine: page.firstLine,
                        rotation: 0 
                    });
                    addedCount++;
                }
            });
        };

        // 判斷是處理單一檔案還是所有檔案
        if (targetFileIndex === -1) {
            // 所有檔案
            for (let i = 0; i < pdfFiles.length; i++) {
                processFile(i);
            }
        } else {
            // 單一檔案
            processFile(targetFileIndex);
        }

        if (addedCount > 0) {
            renderSelectedPages();
            showNotification(`已加入 ${addedCount} 個頁面`, 'success');
            
            // 自動滾動到底部以顯示新加入的頁面
            const container = document.getElementById('selectedPages');
            container.scrollTop = container.scrollHeight;
        } else {
            showNotification('沒有符合條件的頁面', 'info');
        }
    }


    // 2. 全選 / 取消全選
    function toggleSelectAllSource(checkbox) {
        const isChecked = checkbox.checked;
        pdfFiles.forEach(file => {
            file.pages.forEach(page => {
                page.isChecked = isChecked;
            });
        });
        renderSourcePages();
        updateSelectedCountInfo();
    }

    // 3. 更新「已選 X 頁」的文字提示
    function updateSelectedCountInfo() {
        let count = 0;
        pdfFiles.forEach(f => f.pages.forEach(p => { if(p.isChecked) count++; }));
        const info = document.getElementById('selectedCountInfo');
        if(info) info.textContent = `(已選 ${count} 頁)`;
    }

    // 4. 批次功能：加入右側 (Add to Target)
    function batchAddToTarget() {
        let addedCount = 0;
        pdfFiles.forEach((file, fIndex) => {
            file.pages.forEach((page, pIndex) => {
                if (page.isChecked) {
                    // 複製一份資料到右側 selectedPages
                    // 注意：我們會把 sourceRotation 帶過去，作為初始旋轉值
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
                    // 選項：加入後是否要取消勾選？
                    // page.isChecked = false; 
                }
            });
        });

        if (addedCount > 0) {
            renderSelectedPages();
            showNotification(`✅ 已加入 ${addedCount} 個頁面到右側`, 'success');
            // 自動捲動到底部
            const container = document.getElementById('selectedPages');
            container.scrollTop = container.scrollHeight;
        } else {
            showNotification('⚠️ 請先勾選要加入的頁面', 'info');
        }
    }

    // 5. 批次功能：刪除來源頁面 (Delete from Source)
    function batchDeleteFromSource() {
        let deletedCount = 0;
        
        // 檢查是否有選取
        let hasSelection = false;
        pdfFiles.forEach(f => f.pages.forEach(p => { if(p.isChecked) hasSelection = true; }));
        
        if (!hasSelection) {
            showNotification('⚠️ 請先勾選要刪除的頁面', 'info');
            return;
        }

        if (!confirm("確定要從來源列表中刪除選取的頁面嗎？")) return;

        // 因為要刪除陣列元素，建議從後往前刪，或者建立新陣列
        // 這裡採用「建立新陣列」的方式比較穩當
        const newPdfFiles = [];

        pdfFiles.forEach(file => {
            // 過濾掉被勾選(要刪除)的頁面
            const remainingPages = file.pages.filter(p => {
                if (p.isChecked) {
                    deletedCount++;
                    return false; // 刪除
                }
                return true; // 保留
            });

            // 如果該檔案還有頁面，就保留該檔案物件
            if (remainingPages.length > 0) {
                file.pages = remainingPages;
                newPdfFiles.push(file);
            }
        });

        pdfFiles = newPdfFiles;
        
        // 清除全選狀態
        document.getElementById('selectAllSource').checked = false;
        
        updateFileList(); // 檔案可能被整個刪除，需更新列表
        renderSourcePages();
        updateSelectedCountInfo();
        showNotification(`🗑️ 已刪除 ${deletedCount} 個頁面`, 'success');
    }

    // 6. 批次功能：旋轉來源頁面 (Rotate Source)
    // 請確認此函式已加入 script.js
    function batchRotateSource(deg) {
        let rotatedCount = 0;
        let hasSelection = false;

        pdfFiles.forEach(file => {
            file.pages.forEach(page => {
                if (page.isChecked) {
                    hasSelection = true;
                    // 初始化角度 (如果之前沒設定過)
                    if (typeof page.sourceRotation === 'undefined') {
                        page.sourceRotation = 0;
                    }
                    
                    const current = page.sourceRotation;
                    // 計算新角度
                    page.sourceRotation = (current + deg + 360) % 360;
                    rotatedCount++;
                }
            });
        });

        if (rotatedCount > 0) {
            renderSourcePages(); // 重新渲染畫面以顯示旋轉
            // 可以在此加入 console.log 確認是否有執行
            console.log(`已旋轉 ${rotatedCount} 個頁面`);
        } else {
            if (!hasSelection) {
                // 如果使用者沒有勾選任何頁面，顯示提示
                showNotification('⚠️ 請先勾選要旋轉的頁面 (左側來源)', 'info');
            }
        }
    }
    
// ==========================================================
// === 關閉 window.onload 監聽器
// ==========================================================
};
