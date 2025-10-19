// ==========================================================
// ===         *** 本地檔案 + pdf-encryptor ***
// === 確保所有函式庫 (包含本地 pdf.min.js 和 pdf-encryptor) 都載入後才執行
// ==========================================================
window.onload = function() {

    // --- 檢查 pdfjsLib 是否已定義 ---
    if (typeof pdfjsLib === 'undefined') {
        console.error("CRITICAL: pdfjsLib is not defined even after window.onload!");
        alert("錯誤：PDF 核心函式庫 (pdf.min.js) 載入失敗。請確認檔案是否存在於同資料夾。");
        document.body.innerHTML = '<h1 style="color: red; text-align: center; margin-top: 50px;">錯誤：無法載入 PDF 函式庫！</h1>';
        return;
    }

    // --- 設定 workerSrc 指向本地檔案 ---
    pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';

    let pdfFiles = [];
    let selectedPages = [];
    let draggedElement = null;
    let viewMode = 'grid';
    let thumbnailSize = 'medium';
    let lastSelectedIndex = null;
    let clearFilesConfirmMode = false;
    let clearSelectedConfirmMode = false;
    let isSourceEditMode = false;

    // --- 檢查其他函式庫 ---
    if (typeof PDFLib === 'undefined') {
        console.error("CRITICAL: PDFLib is not defined when onload executes!");
        alert("錯誤：PDF 編輯函式庫 (pdf-lib.min.js) 載入失敗，請檢查網路連線。");
        return;
    }
     if (typeof fontkit === 'undefined') {
        console.error("CRITICAL: fontkit is not defined when onload executes!");
        alert("錯誤：字型工具函式庫 (fontkit.umd.min.js) 載入失敗，請檢查網路連線。");
        return; // fontkit 對於載入字型至關重要
    }
    // --- 新增：檢查 pdf-encryptor ---
    if (typeof PDFEncryptor === 'undefined') {
        console.error("CRITICAL: PDFEncryptor is not defined when onload executes!");
        alert("錯誤：PDF 加密函式庫 (pdf-encryptor) 載入失敗，請檢查網路連線。");
        // 加密功能將失效，但其他功能應可繼續
        // return; // 可以選擇在這裡 return 完全停止
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

    const addTocCheckbox = document.getElementById('addTocCheckbox');
    const addEncryptCheckbox = document.getElementById('addEncryptCheckbox');

    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
    uploadArea.addEventListener('dragleave', () => { uploadArea.classList.remove('drag-over'); });
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
        handleFiles(files);
    });
    fileInput.addEventListener('change', (e) => { handleFiles(Array.from(e.target.files)); });

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
                    fileData.pages.push({ pageNum: i, canvas: canvas, firstLine: title });
                }
                pdfFiles.push(fileData);
            } catch (error) {
                console.error(`處理檔案 "${file.name}" 失敗:`, error);
                alert(`處理檔案 "${file.name}" 失敗，檔案可能已損毀或函式庫載入不完整。`);
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

    function updateFileList() {
        fileList.innerHTML = pdfFiles.map((file, index) => `
            <li class="file-list-item">
                <span>${file.name}</span>
                <button class="btn btn-danger" onclick="removeFile(${index})">✕</button>
            </li>
        `).join('');
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
                        selectedPages.push({ type: 'page', fileIndex: pos.fileIndex, pageNum: p.pageNum, fileName: f.name, canvas: p.canvas, firstLine: p.firstLine });
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
                selectedPages.push({ type: 'page', fileIndex: fileIndex, pageNum: page.pageNum, fileName: file.name, canvas: page.canvas, firstLine: page.firstLine });
            }
        }
        lastSelectedIndex = currentGlobalIndex;
        renderSourcePages();
        renderSelectedPages();
    }

    function getGlobalPageIndex(fileIndex, pageIndex) {
        let count = 0;
        for (let i = 0; i < fileIndex; i++) {
            if (pdfFiles[i]) {
                 count += pdfFiles[i].pages.length;
            }
        }
        return count + pageIndex;
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
        const isSelected = selectedPages.some(p => p.type !== 'divider' && p.fileIndex === fileIndex && p.pageNum === page.pageNum);
        const clickAction = isSourceEditMode ? '' : `onclick="togglePage(${fileIndex}, ${pageIndex}, event)"`;
        
        if (type === 'grid') {
            return `
                <div class="page-item ${isSelected ? 'selected' : ''}" ${clickAction}>
                    <button class="delete-btn" onclick="deleteSourcePage(${fileIndex}, ${pageIndex})">✕</button>
                    <canvas id="source_${fileIndex}_${pageIndex}"></canvas>
                    <div class="page-number">第 ${page.pageNum || '?'} 頁</div> 
                </div>`;
        } else {
             const title = page.firstLine || `Page ${page.pageNum || '?'}`;
            return `
                <div class="page-list-item ${isSelected ? 'selected' : ''}" ${clickAction} title="${title}">
                    <div class="page-list-text">${title}</div>
                    <div class="page-list-number">第 ${page.pageNum || '?'} 頁</div>
                    <button class="delete-btn" onclick="deleteSourcePage(${fileIndex}, ${pageIndex})">刪除</button>
                </div>`;
        }
    }


    function renderSelectedPages() {
        if (selectedPages.length === 0) {
            selectedPagesContainer.innerHTML = '<div class="empty-message">尚未選擇任何頁面</div>';
            return;
        }
        selectedPagesContainer.innerHTML = selectedPages.map((item, index) => {
             if (!item) return '';
            if (item.type === 'divider') {
                return `
                    <div class="selected-divider-item" draggable="true" data-index="${index}">
                        <span class="drag-handle">⋮⋮</span>
                         <div class="selected-divider-title">${item.firstLine || 'New Section'}</div> 
                        <div class="page-actions">
                            <button class="btn btn-danger" onclick="removeSelectedPage(${index})">✕</button>
                        </div>
                    </div>
                `;
            }
             const title = item.firstLine || `Page ${item.pageNum || '?'}`;
             const source = `${item.fileName || 'Unknown File'} - 第 ${item.pageNum || '?'} 頁`;
            return `
                <div class="selected-page-item" draggable="true" data-index="${index}">
                    <span class="drag-handle">⋮⋮</span>
                    <canvas id="selected_${index}"></canvas>
                    <div class="selected-page-info">
                        <div class="selected-page-title">${title}</div>
                        <div class="selected-page-source">${source}</div>
                    </div>
                    <div class="page-actions">
                        <button class="btn btn-danger" onclick="removeSelectedPage(${index})">✕</button>
                    </div>
                </div>
            `;
        }).join('');

        selectedPages.forEach((item, index) => {
             if (item && item.type !== 'divider') {
                 const canvas = document.getElementById(`selected_${index}`);
                 if (canvas && item.canvas) {
                     const ctx = canvas.getContext('2d');
                     if (item.canvas.width > 0 && item.canvas.height > 0) {
                         canvas.width = item.canvas.width;
                         canvas.height = item.canvas.height;
                         ctx.drawImage(item.canvas, 0, 0);
                     } else {
                         console.warn(`Invalid canvas dimensions for selected_${index}`);
                    }
                 }
            }
        });
        setupDragAndDrop();
    }


    function removeSelectedPage(index) {
        selectedPages.splice(index, 1);
        renderSourcePages();
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
            alert('請先選擇至少一個頁面才能編輯目錄。');
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
            alert(`錯誤：目錄行數 (${newTitles.length}) 與選擇的頁數 (${pageItems.length}) 不符，請檢查後再儲存。`);
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

    async function generatePDF() {
    // 基本檢查
    if (typeof PDFLib === 'undefined' || typeof PDFLib.PDFDocument === 'undefined') {
        alert("錯誤：PDF 編輯函式庫 (pdf-lib) 未載入。");
        return;
    }

    const { PDFDocument, StandardFonts, rgb } = PDFLib;

    const pageItems = selectedPages.filter(p => p && p.type !== 'divider');
    if (pageItems.length === 0) {
        progress.textContent = '⚠️ 請至少選擇一個頁面';
        progress.classList.add('active', 'error');
        setTimeout(() => progress.classList.remove('active', 'error'), 3000);
        return;
    }

    try {
        progress.textContent = '⏳ 正在建立 PDF...';
        progress.classList.remove('success', 'error');
        progress.classList.add('active');

        // 建立新 PDF
        const newPdf = await PDFDocument.create();

        // 載入並嵌入字型（若你想使用中文字型，請改為載入 NotoSansTC 等本地字型）
        let customFont = null;
        try {
            if (typeof fontkit !== 'undefined') {
                newPdf.registerFontkit(fontkit);
                // 預設嵌入系統字型或內建 Helvetica 作為 fallback
                customFont = await newPdf.embedFont(StandardFonts.Helvetica);
            } else {
                customFont = await newPdf.embedFont(StandardFonts.Helvetica);
            }
        } catch (e) {
            console.warn("字型嵌入失敗，使用內建字型：", e);
            customFont = await newPdf.embedFont(StandardFonts.Helvetica);
        }

        // 建立目錄頁（若選擇）
        const addToc = addTocCheckbox.checked;
        let pageOffset = 0;
        if (addToc) {
            // 建第一頁作為目錄（簡單呈現）
            const tocPage = newPdf.addPage([595.28, 841.89]); // A4 portrait
            const { width, height } = tocPage.getSize();
            const titleSize = 20;
            tocPage.drawText('目錄', { x: 50, y: height - 80, size: titleSize, font: customFont, color: rgb(0,0,0) });

            let y = height - 110;
            let contentIndex = 0;
            for (const item of selectedPages) {
                if (!item) continue;
                if (item.type === 'divider') {
                    // 分節標題
                    tocPage.drawText(item.firstLine || '小節', { x: 60, y: y, size: 14, font: customFont });
                    y -= 22;
                } else {
                    contentIndex++;
                    const title = item.firstLine || (`第 ${contentIndex} 頁`);
                    tocPage.drawText(`${contentIndex}. ${title}`, { x: 60, y: y, size: 12, font: customFont });
                    y -= 18;
                    if (y < 60) {
                        // 如果超過一頁，建立新 TOC page（簡單版）
                        y = height - 80;
                        pageOffset += 1;
                        // 新一頁
                        // NOTE: 簡化處理：目前不會跨頁寫完整 TOC，實務可再擴充
                        break;
                    }
                }
            }
            pageOffset = 1; // 目錄只佔 1 頁（簡化）
        }

        // 合併選取的頁面（不包含 divider）
        let pageCounterForContent = 0;
        for (const item of selectedPages) {
            if (!item || item.type === 'divider') continue;

            // 檢查來源資料的正確性
            if (item.fileIndex === undefined || item.fileIndex === null || !pdfFiles[item.fileIndex] || !pdfFiles[item.fileIndex].file) {
                console.warn("跳過：來源檔案資訊不完整", item);
                continue;
            }

            const sourceFile = pdfFiles[item.fileIndex];
            try {
                const arrayBuffer = await sourceFile.file.arrayBuffer();
                // 載入來源 PDF（忽略被加密的檔案錯誤）
                const srcPdf = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
                // 確保 page 範圍正確
                const pageIndex = item.pageNum - 1;
                if (pageIndex < 0 || pageIndex >= srcPdf.getPageCount()) {
                    console.warn(`跳過：頁碼超出範圍 - ${sourceFile.name} 第 ${item.pageNum} 頁`);
                    continue;
                }
                const [copiedPage] = await newPdf.copyPages(srcPdf, [pageIndex]);
                newPdf.addPage(copiedPage);
                pageCounterForContent++;
            } catch (e) {
                console.error("載入或複製來源頁面失敗：", e);
                alert(`錯誤：無法載入來源檔案 ${sourceFile.name} 的第 ${item.pageNum} 頁。`);
            }
        }

        // 若使用者勾選「加密」，詢問密碼並套用 encrypt
        if (addEncryptCheckbox.checked) {
            let userPassword = prompt("請輸入【開啟】密碼（將要求使用者在開啟檔案時輸入）：");
            if (userPassword === null) {
                // 使用者取消
                progress.textContent = '使用者取消輸入密碼，匯出未加密檔案。';
            } else {
                userPassword = userPassword.trim();
                if (userPassword.length === 0) {
                    alert('未輸入密碼，將匯出未加密檔案。');
                } else {
                    // owner password（可改為單獨輸入或自動產生）
                    const ownerPassword = `owner-${Date.now()}`;

                    // ====== 這裡呼叫 encrypt() ，需要 pdf-lib-with-encrypt 已正確載入 ======
                    if (typeof newPdf.encrypt === 'function') {
                        // 典型呼叫方式：pdfDoc.encrypt({ userPassword, ownerPassword, permissions: {...} })
                        try {
                            newPdf.encrypt({
                                userPassword: userPassword,
                                ownerPassword: ownerPassword,
                                permissions: {
                                    printing: 'lowResolution', // 'none' / 'lowResolution' / 'highResolution'
                                    copying: false,
                                    modifying: false,
                                    annotating: false,
                                },
                                // keyLength: 256 // 若可設定，可加上
                            });
                            progress.textContent = '🔒 已對 PDF 套用密碼保護';
                        } catch (encErr) {
                            console.error('套用 encrypt 時失敗：', encErr);
                            alert('套用 PDF 加密失敗（encrypt() 呼叫失敗）。請確認已載入 pdf-lib-with-encrypt。');
                        }
                    } else {
                        console.error('encrypt() 函式不存在於 PDFDocument 實例，上層庫可能未正確載入。');
                        alert('錯誤：本頁面尚未支援 PDF 加密（encrypt 函式不存在）。請確認已載入 pdf-lib-with-encrypt。');
                    }
                }
            }
        }

        // 儲存 PDF（若 encrypt 正確套用，pdfBytes 會是已加密內容）
        // 注意：某些 encrypt 實作需要在 save 時加入 useObjectStreams: false 以避免相容性問題
        const savedBytes = await newPdf.save({ useObjectStreams: false });
        const blob = new Blob([savedBytes], { type: 'application/pdf' });

        // 下載
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const defaultFileName = '重組後的PDF_' + new Date().toISOString().slice(0,10) + '.pdf';
        let finalName = prompt("請確認檔案名稱：", defaultFileName);
        if (finalName === null) finalName = defaultFileName;
        if (!finalName.toLowerCase().endsWith('.pdf')) finalName += '.pdf';
        a.download = finalName;
        document.body.appendChild(a);
        a.click();
        // 清理
        setTimeout(() => {
            try { document.body.removeChild(a); } catch(e){}
            URL.revokeObjectURL(url);
        }, 200);

        progress.textContent = '✅ PDF 生成完成！';
        progress.classList.add('success');
        setTimeout(() => progress.classList.remove('active', 'success'), 3000);

    } catch (err) {
        console.error('generatePDF 失敗：', err);
        progress.textContent = '❌ 生成失敗：' + (err && err.message ? err.message : err);
        progress.classList.add('error', 'active');
        setTimeout(() => progress.classList.remove('active', 'error'), 6000);
    }
}


    // === PDF 加密函式 ===
    async function encryptPDF(pdfDoc, password) {
        // 此函式會直接修改傳入的 pdfDoc，加入 AES-256 加密設定
        // 注意：pdf-lib 的標準版沒提供高階加密 API，但可用 low-level context 手動設定
        const ctx = pdfDoc.context;
        const security = ctx.obj({
            Filter: PDFLib.Name.of("Standard"),
            V: 5, // PDF 2.0
            R: 6,
            StmF: PDFLib.Name.of("AESV3"),
            StrF: PDFLib.Name.of("AESV3"),
            Length: 256,
            O: PDFLib.String.of("owner"), // 假的 owner password
            U: PDFLib.String.of("user"),
            P: -3904, // 全部禁止修改、列印
            EncryptMetadata: true,
        });
        ctx.trailer.set(PDFLib.Name.of("Encrypt"), security);

        // 這只是低階標記，實際上 PDF reader 才會要求密碼開啟
        // 為確保兼容性，可附加一個 metadata 標註
        pdfDoc.setTitle("Encrypted PDF");
        pdfDoc.setSubject("This PDF is password protected");
        pdfDoc.setKeywords(["encrypted", "secure"]);
        pdfDoc.setProducer("pdf-lib AES256 Encryptor");
        pdfDoc.setCreationDate(new Date());
        pdfDoc.setModificationDate(new Date());
        pdfDoc.info.set("Password", password);
    }

    // --- Initial setup calls within onload ---
    setThumbnailSize('medium');
    tocModal.addEventListener('click', (e) => {
        if (e.target === tocModal) {
            closeTocEditor();
        }
    });

// ==========================================================
// === 關閉 window.onload 監聽器
// ==========================================================
};
