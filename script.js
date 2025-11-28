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
    let draggedElement = null;  // 目前拖曳的元素
    let viewMode = 'list';      // 左側檢視模式 (list/grid)
    let thumbnailSize = 'medium'; // 左側縮圖大小
    let isSourceEditMode = false; // 左側是否處於編輯模式
    
    let targetViewMode = 'grid'; // 右側檢視模式
    let targetThumbnailSize = 'medium'; // 右側縮圖大小

    // 操作輔助變數
    let lastSelectedIndex = null;       // (舊邏輯) 上次選擇索引
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
    window.toggleSourceEditMode = toggleSourceEditMode; // (舊)
    window.deleteSourcePage = deleteSourcePage; // (舊)
    window.togglePage = togglePage; // (舊)
    window.toggleSourceCheck = toggleSourceCheck;
    window.toggleSelectAllSource = toggleSelectAllSource;
    window.batchAddToTarget = batchAddToTarget;
    window.batchDeleteFromSource = batchDeleteFromSource;
    window.batchRotateSource = batchRotateSource;
    window.updateQuickSelectFileOptions = updateQuickSelectFileOptions;
    window.applyQuickSelection = applyQuickSelection;
    window.clearAllSourceChecks = clearAllSourceChecks;
    window.executeQuickSelect = executeQuickSelect;

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
    window.rotateSelectedPage = rotateSelectedPage;

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
    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
    uploadArea.addEventListener('dragleave', () => { uploadArea.classList.remove('drag-over'); });
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
        handleFiles(files);
    });
    fileInput.addEventListener('change', (e) => { handleFiles(Array.from(e.target.files)); });

    // Modal 點擊外部關閉
    tocModal.addEventListener('click', (e) => { if (e.target === tocModal) closeTocEditor(); });
    previewModal.addEventListener('click', (e) => { if (e.target === previewModal) closePreview(); });

    // 目錄設定面板切換
    addTocCheckbox.addEventListener('change', function() {
        tocSettingsPanel.style.display = this.checked ? 'block' : 'none';
    });

    // ------------------------------------------------------
    // 6. 初始化執行 (Initialization)
    // ------------------------------------------------------
    setThumbnailSize('medium'); // 設定預設縮圖大小
    if (addTocCheckbox.checked) {
        tocSettingsPanel.style.display = 'block';
    }

    // ======================================================
    // === 邏輯區塊：工具與通用函式 (Utilities)
    // ======================================================

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
        setTimeout(() => { progress.classList.remove('active', 'success'); }, 2000);
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

            if (items.length === 0) return `Page ${pageNum}`;

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
        } catch (error) {
             console.error(`Error extracting title from page ${pageNum}:`, error);
             return `Page ${pageNum}`;
        }
    }

    function updateFileList() {
        fileList.innerHTML = pdfFiles.map((file, index) => `
            <li class="file-list-item">
                <span>${file.name}</span>
                <button class="btn btn-danger" onclick="removeFile(${index})">✕</button>
            </li>
        `).join('');
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

    function toggleSourceEditMode() {
        isSourceEditMode = !isSourceEditMode;
        const btn = document.getElementById('editSourceBtn');
        sourcePanel.classList.toggle('edit-mode', isSourceEditMode);
        btn.classList.toggle('active', isSourceEditMode);
        btn.innerHTML = isSourceEditMode ? '✓ 完成' : '🗑️ 刪除頁面';
        renderSourcePages();
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
        
        // onclick 傳遞 event 參數以支援 shift 多選
        const clickAction = `onclick="toggleSourceCheck(${fileIndex}, ${pageIndex}, event)"`;
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
        } else {
            // 一般單點
            targetPage.isChecked = !targetPage.isChecked;
            lastSourceClickGlobalIndex = currentGlobalIndex;
        }
        
        renderSourcePages();
        updateSelectedCountInfo();
    }

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

    // 舊版選取邏輯 (目前保留以相容舊代碼，但 UI 主要使用 toggleSourceCheck)
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
                            rotation: 0 
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
                    rotation: 0
                });
            }
        }
        lastSelectedIndex = currentGlobalIndex;
        renderSourcePages();
        renderSelectedPages();
    }

    // 舊版刪除邏輯
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

    function batchDeleteFromSource() {
        let deletedCount = 0;
        let hasSelection = false;
        pdfFiles.forEach(f => f.pages.forEach(p => { if(p.isChecked) hasSelection = true; }));
        
        if (!hasSelection) {
            showNotification('⚠️ 請先勾選要刪除的頁面', 'info');
            return;
        }

        if (!confirm("確定要從來源列表中刪除選取的頁面嗎？")) return;

        const newPdfFiles = [];
        pdfFiles.forEach(file => {
            const remainingPages = file.pages.filter(p => {
                if (p.isChecked) {
                    deletedCount++;
                    return false;
                }
                return true;
            });
            if (remainingPages.length > 0) {
                file.pages = remainingPages;
                newPdfFiles.push(file);
            }
        });

        pdfFiles = newPdfFiles;
        document.getElementById('selectAllSource').checked = false;
        
        updateFileList();
        renderSourcePages();
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
            renderSourcePages();
            console.log(`已旋轉 ${rotatedCount} 個頁面`);
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
            renderSourcePages();
            updateSelectedCountInfo();
            showNotification(`已自動勾選 ${matchCount} 個頁面`, 'success');
        } else {
            showNotification('沒有符合條件的頁面', 'info');
        }
    }

    function executeQuickSelect() {
        // 此函式與 applyQuickSelection 類似，但行為是直接加入右側。
        // 為保持原始功能完整性保留此函式，但建議統一使用 applyQuickSelection + batchAddToTarget
        const fileIndexStr = document.getElementById('qsFileSelect').value;
        const type = document.getElementById('qsTypeSelect').value;
        const targetFileIndex = parseInt(fileIndexStr);

        if (pdfFiles.length === 0) {
            showNotification('請先載入 PDF 檔案', 'error');
            return;
        }

        let addedCount = 0;
        const processFile = (fIndex) => {
            const file = pdfFiles[fIndex];
            if (!file) return;

            file.pages.forEach((page, pIndex) => {
                let shouldSelect = false;
                const pageNum = page.pageNum;

                switch (type) {
                    case 'all': shouldSelect = true; break;
                    case 'odd': shouldSelect = (pageNum % 2 !== 0); break;
                    case 'even': shouldSelect = (pageNum % 2 === 0); break;
                    case 'first': shouldSelect = (pIndex === 0); break;
                    case 'last': shouldSelect = (pIndex === file.pages.length - 1); break;
                    case 'blank': if (page.firstLine === `Page ${pageNum}`) shouldSelect = true; break;
                }

                if (shouldSelect) {
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

        if (targetFileIndex === -1) {
            for (let i = 0; i < pdfFiles.length; i++) processFile(i);
        } else {
            processFile(targetFileIndex);
        }

        if (addedCount > 0) {
            renderSelectedPages();
            showNotification(`已加入 ${addedCount} 個頁面`, 'success');
            const container = document.getElementById('selectedPages');
            container.scrollTop = container.scrollHeight;
        } else {
            showNotification('沒有符合條件的頁面', 'info');
        }
    }

    function clearAllSourceChecks() {
        pdfFiles.forEach(file => {
            file.pages.forEach(page => page.isChecked = false);
        });
        document.getElementById('selectAllSource').checked = false;
        renderSourcePages();
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
        container.classList.remove('size-small', 'size-medium', 'size-large');
        container.classList.add(`size-${size}`);
        
        document.querySelectorAll('#target-size-toggle button').forEach(btn => btn.classList.remove('active'));
        document.querySelector(`#target-size-toggle button[onclick="setTargetThumbnailSize('${size}')"]`).classList.add('active');
    }

    function renderSelectedPages() {
        if (selectedPages.length === 0) {
            selectedPagesContainer.innerHTML = '<div class="empty-message">尚未選擇任何頁面</div>';
            updateTargetSelectedInfo();
            return;
        }

        selectedPagesContainer.className = `selected-pages ${targetViewMode}-view`;

        selectedPagesContainer.innerHTML = selectedPages.map((item, index) => {
             if (!item) return '';
             
             // 分隔線
             if (item.type === 'divider') {
                return `
                    <div class="selected-divider-item" draggable="true" data-index="${index}">
                        <span class="drag-handle">::</span>
                         <div class="selected-divider-title">${item.firstLine || 'New Section'}</div> 
                        <div class="page-actions">
                            <button class="btn btn-danger" onclick="removeSelectedPage(${index})">✕</button>
                        </div>
                    </div>`;
            }

            // 一般頁面
            const title = item.firstLine || `Page ${item.pageNum || '?'}`;
            const source = `${item.fileName || 'Unknown File'} - 第 ${item.pageNum || '?'} 頁`;
            const checkedAttr = item.isChecked ? 'checked' : '';
            const checkedClass = item.isChecked ? 'checked' : '';
            const rotationStyle = `transform: rotate(${item.rotation || 0}deg);`;
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

        setupDragAndDrop();
        updateTargetSelectedInfo();
    }

    function toggleTargetCheck(index) {
        if (!selectedPages[index]) return;
        if (selectedPages[index].isChecked === undefined) selectedPages[index].isChecked = false;
        selectedPages[index].isChecked = !selectedPages[index].isChecked;
        renderSelectedPages();
    }

    function toggleSelectAllTarget(checkbox) {
        const checked = checkbox.checked;
        selectedPages.forEach(p => {
            if (p.type !== 'divider') p.isChecked = checked;
        });
        renderSelectedPages();
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
            renderSelectedPages();
        } else {
            showNotification('請先勾選右側頁面', 'info');
        }
    }

    function removeSelectedPage(index) {
        selectedPages.splice(index, 1);
        renderSourcePages();
        renderSelectedPages();
    }

    function rotateSelectedPage(index) {
        if (!selectedPages[index] || selectedPages[index].type === 'divider') return;
        let currentRotation = selectedPages[index].rotation || 0;
        let newRotation = (currentRotation + 90) % 360;
        selectedPages[index].rotation = newRotation;
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

    // ======================================================
    // === 邏輯區塊：拖曳排序 (Drag & Drop)
    // ======================================================

    function setupDragAndDrop() {
        document.querySelectorAll('.selected-page-item, .selected-divider-item').forEach(item => {
            item.addEventListener('dragstart', (e) => {
                draggedElement = item;
                item.classList.add('dragging');
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
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
                     renderSelectedPages(); 
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
                renderSelectedPages();
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
            if (offset > 0 && offset < closest.offset) { 
                return { offset: offset, element: child };
            } else {
                return closest;
            }
         }, { offset: Number.POSITIVE_INFINITY }).element;
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

    function downloadGeneratedPDF() {
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
        let finalFileName = prompt("請確認檔案名稱：", defaultFileName);

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
        const modal = document.getElementById('previewModal');
        const iframe = document.getElementById('previewFrame');
        
        modal.style.display = 'none';
        iframe.src = 'about:blank'; 

        if (currentPreviewUrl) {
            URL.revokeObjectURL(currentPreviewUrl);
            currentPreviewUrl = null;
        }
        finalPdfBytes = null; 
    }

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
                
                let tocPage = newPdf.addPage([842, 595]); // 橫向A4
                tocPages.push(tocPage);
                
                tocPage.drawText('目錄', { 
                    x: 50, y: 595 - 50, 
                    size: TOC_CONFIG.MAIN_TITLE_SIZE, font: customFont, color: rgb(0,0,0) 
                });
                
                let yPosition = 595 - 90;
                let pageCounterForToc = 0;

                for (const item of selectedPages) {
                    if (!item) continue;
                    
                    // TOC 換頁處理
                    if (yPosition < 50) {
                        tocPage = newPdf.addPage([842, 595]);
                        tocPages.push(tocPage);
                        yPosition = 595 - 90;
                        tocPage.drawText('目錄 (續)', { 
                            x: 50, y: 595 - 50, 
                            size: TOC_CONFIG.MAIN_TITLE_SIZE, font: customFont, color: rgb(0,0,0) 
                        });
                    }

                    if (item.type === 'divider') {
                        yPosition -= 10;
                        tocPage.drawText(item.firstLine || 'New Section', { 
                            x: 50, y: yPosition, 
                            size: TOC_CONFIG.SECTION_TITLE_SIZE, font: customFont, color: rgb(0,0,0) 
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
                        try { pageNumWidth = customFont.widthOfTextAtSize(pageNumStr, TOC_CONFIG.ITEM_PAGENUM_SIZE); } catch (e) {}
                        
                        let truncatedTitle = title;
                        let titleWidth = 0;
                        try { titleWidth = customFont.widthOfTextAtSize(truncatedTitle, TOC_CONFIG.ITEM_TITLE_SIZE); } catch (e) {}
                        
                        const minDotSpace = 20;
                        while (titleWidth > 0 && pageContentWidth > 0 && (titleWidth + pageNumWidth + minDotSpace > pageContentWidth) && truncatedTitle.length > 5) {
                            truncatedTitle = truncatedTitle.slice(0, -2) + '…';
                            try { titleWidth = customFont.widthOfTextAtSize(truncatedTitle, TOC_CONFIG.ITEM_TITLE_SIZE); } catch (e) { titleWidth = 0; }
                        }
                        
                        // 繪製標題
                        tocPage.drawText(truncatedTitle, { 
                            x: leftMargin, y: yPosition, 
                            size: TOC_CONFIG.ITEM_TITLE_SIZE, font: customFont, color: rgb(0, 0, 0)
                        });
                        
                        // 繪製頁碼
                        tocPage.drawText(pageNumStr, { 
                            x: tocPage.getWidth() - rightMargin - pageNumWidth, y: yPosition, 
                            size: TOC_CONFIG.ITEM_PAGENUM_SIZE, font: customFont, color: rgb(0, 0, 0) 
                        });
                        
                        // 繪製點點
                        let dotWidth = 0;
                        const dotSize = Math.min(TOC_CONFIG.ITEM_TITLE_SIZE, TOC_CONFIG.ITEM_PAGENUM_SIZE);
                        try { dotWidth = customFont.widthOfTextAtSize('.', dotSize); } catch (e) {}
                        
                        if (dotWidth > 0) {
                            const dotStartX = leftMargin + titleWidth + 5;
                            const dotEndX = tocPage.getWidth() - rightMargin - pageNumWidth - 5;
                            const availableDotSpace = dotEndX - dotStartX;
                            if (availableDotSpace > dotWidth) {
                                const numDots = Math.floor(availableDotSpace / dotWidth);
                                const dotString = '.'.repeat(numDots);
                                tocPage.drawText(dotString, { 
                                    x: dotStartX, y: yPosition, 
                                    size: dotSize, font: customFont, color: rgb(0, 0, 0), opacity: 0.5 
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

                    if (item.rotation && item.rotation !== 0) {
                        copiedPage.rotate(item.rotation);
                    }
                    
                    newPdf.addPage(copiedPage);
                    
                    // 新增頁碼
                    if (addPageNumbers) {
                        const newPageNumber = `${pageCounterForContent + pageOffset}`;
                        const { width, height } = copiedPage.getSize();
                        if (width > 0 && height > 0) {
                            copiedPage.drawText(newPageNumber, { 
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
};
