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
         if (typeof PDFLib === 'undefined' || typeof PDFLib.PDFDocument === 'undefined') {
            console.error("PDFLib not available in generatePDF");
            alert("錯誤：無法生成 PDF，編輯函式庫載入失敗。");
            return;
        }
         // 新增：檢查 PDFEncryptor 是否可用
         const useEncryption = addEncryptCheckbox.checked;
         if (useEncryption && typeof PDFEncryptor === 'undefined') {
             console.error("PDFEncryptor not available in generatePDF");
             alert("錯誤：無法加密 PDF，加密函式庫載入失敗。請取消勾選加密或檢查網路連線。");
             return; // 如果要加密但函式庫不在，則停止
         }

        const { PDFDocument, rgb, StandardFonts } = PDFLib;

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

            try {
                progress.textContent = '正在載入中文字型...';
                const fontUrl = './fonts/NotoSansTC-Regular.ttf'; // 載入本地字型
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
                 alert(`警告：無法載入本地字型檔案 (${fontError.message})。目錄將使用英文字型顯示（中文會變亂碼）。`);
                 try {
                     customFont = await newPdf.embedFont(StandardFonts.Helvetica);
                 } catch (embedError) {
                     console.error("Failed to embed fallback font:", embedError);
                     alert("致命錯誤：無法嵌入預設字型。");
                     progress.textContent = '❌ 生成失敗：無法嵌入字型';
                     progress.classList.add('active', 'error');
                     return;
                 }
            }
            
            const addToc = addTocCheckbox.checked;
            let pageOffset = addToc ? 1 : 0; 

            if (addToc) {
                progress.textContent = '正在建立目錄頁...';
                const tocPage = newPdf.addPage([842, 595]);
                tocPage.drawText('目錄', { x: 50, y: 595 - 50, size: 18, font: customFont, color: rgb(0,0,0) });
                let yPosition = 595 - 90;
                let pageCounterForToc = 0;

                for (const item of selectedPages) {
                     if (!item) continue;
                     if (yPosition < 40) {
                         console.warn("TOC content might overflow"); break;
                     }
                    if (item.type === 'divider') {
                        yPosition -= 10;
                        tocPage.drawText(item.firstLine || 'New Section', { x: 50, y: yPosition, size: 14, font: customFont, color: rgb(0,0,0) });
                        yPosition -= 25;
                    } else {
                        pageCounterForToc++;
                         const title = item.firstLine || `Page ${item.pageNum || '?'}`;
                        const pageNumStr = `${pageCounterForToc + pageOffset}`; 
                        const leftMargin = 70; const rightMargin = 50; const fontSize = 12;
                        const pageContentWidth = tocPage.getWidth() - leftMargin - rightMargin;
                        let pageNumWidth = 0; let titleWidth = 0; let dotWidth = 0;
                        try { pageNumWidth = customFont.widthOfTextAtSize(pageNumStr, fontSize); } catch (e) { console.error("Err getting pageNum width:", e); }
                        let truncatedTitle = title;
                        try { titleWidth = customFont.widthOfTextAtSize(truncatedTitle, fontSize); } catch (e) { console.error("Err getting title width:", e); }
                        const minDotSpace = 20;
                        while (titleWidth > 0 && pageContentWidth > 0 && (titleWidth + pageNumWidth + minDotSpace > pageContentWidth) && truncatedTitle.length > 5) {
                            truncatedTitle = truncatedTitle.slice(0, -2) + '…';
                            try { titleWidth = customFont.widthOfTextAtSize(truncatedTitle, fontSize); } catch (e) { titleWidth = 0; }
                        }
                        tocPage.drawText(truncatedTitle, { x: leftMargin, y: yPosition, size: fontSize, font: customFont, color: rgb(0,0,0) });
                        tocPage.drawText(pageNumStr, { x: tocPage.getWidth() - rightMargin - pageNumWidth, y: yPosition, size: fontSize, font: customFont, color: rgb(0,0,0) });
                        try { dotWidth = customFont.widthOfTextAtSize('.', fontSize); } catch (e) { console.error("Err getting dot width:", e); }
                         if (dotWidth > 0) {
                            const dotStartX = leftMargin + titleWidth + 5;
                            const dotEndX = tocPage.getWidth() - rightMargin - pageNumWidth - 5;
                            const availableDotSpace = dotEndX - dotStartX;
                             if (availableDotSpace > dotWidth) {
                                const numDots = Math.floor(availableDotSpace / dotWidth);
                                const dotString = '.'.repeat(numDots);
                                tocPage.drawText(dotString, { x: dotStartX, y: yPosition, size: fontSize, font: customFont, color: rgb(0,0,0), opacity: 0.5 });
                             }
                         }
                        yPosition -= 20;
                    }
                }
            }

            let pageCounterForContent = 0;
            for (const item of selectedPages) {
                if (!item || item.type === 'divider') continue;
                pageCounterForContent++;
                progress.textContent = `正在合併頁面 (${pageCounterForContent}/${pageItems.length})...`;
                if (item.fileIndex === undefined || item.fileIndex === null || !pdfFiles[item.fileIndex] || !pdfFiles[item.fileIndex].file || !item.pageNum) {
                     console.error("Missing data for page item:", item); continue;
                }
                const sourceFile = pdfFiles[item.fileIndex];
                try {
                    const freshArrayBuffer = await sourceFile.file.arrayBuffer();
                    const sourcePdf = await PDFDocument.load(freshArrayBuffer, { ignoreEncryption: true, updateMetadata: false });
                     if (item.pageNum < 1 || item.pageNum > sourcePdf.getPageCount()) {
                         console.error(`Invalid page ${item.pageNum} for ${sourceFile.name}`); continue;
                     }
                    const [copiedPage] = await newPdf.copyPages(sourcePdf, [item.pageNum - 1]);
                    newPdf.addPage(copiedPage);
                    const newPageNumber = `${pageCounterForContent + pageOffset}`;
                    const { width, height } = copiedPage.getSize();
                     if (width > 0 && height > 0) {
                        copiedPage.drawText(newPageNumber, { x: width - 40, y: 30, size: 10, font: customFont, color: rgb(0, 0, 0) });
                     } else { console.warn(`Invalid dimensions page ${pageCounterForContent}`); }
                } catch(loadError) {
                    console.error(`Error loading/copying page ${item.pageNum} from ${sourceFile.name}:`, loadError);
                     alert(`錯誤：無法處理檔案 "${sourceFile.name}" 第 ${item.pageNum} 頁。`);
                }
            }

            progress.textContent = '正在儲存 PDF...';
            
            // 先使用 pdf-lib 生成基礎 PDF 的 bytes
            let pdfBytes = await newPdf.save(); // No saveOptions needed here anymore

            // ==========================================================
            // ===         *** 使用 pdf-encryptor 加密 ***
            // ==========================================================
            if (useEncryption) { // 變數 useEncryption 已在函式開頭定義
                 if (typeof PDFEncryptor === 'undefined') { // 再次檢查以防萬一
                     throw new Error("PDFEncryptor is not available for encryption.");
                 }
                const password = prompt("請輸入 PDF [開啟] 密碼（若取消則不加密）：");
                if (password && password.trim() !== "") {
                    progress.textContent = '正在加密 PDF...';
                    try {
                        const encryptedBytes = await PDFEncryptor.encrypt({
                            pdf: pdfBytes,         // 使用 pdf-lib 生成的 Uint8Array
                            password: password,    // 使用者輸入的開啟密碼
                            // ownerPassword: password, // pdf-encryptor 建議 owner 不同，不設則隨機
                             permissions: {      // 設定權限
                                 printing: 'highResolution', // 允許高品質列印
                                 modifying: false,          // 不允許修改
                                 copying: false,            // 不允許複製內容
                                 annotating: false,         // 不允許註解
                                 fillingForms: false,       // 不允許填表
                                 contentAccessibility: false,// 不允許內容提取 (輔助)
                                 documentAssembly: false    // 不允許頁面操作
                             }
                        });
                        pdfBytes = encryptedBytes; // 將 pdfBytes 替換為加密後的 bytes
                        progress.textContent = '加密完成，正在準備下載...';
                    } catch (encryptionError) {
                        console.error("PDF 加密失敗:", encryptionError);
                        alert(`PDF 加密失敗: ${encryptionError.message}`);
                        // 決定是否繼續下載未加密版本或停止
                        // progress.textContent = '❌ 加密失敗，將下載未加密版本...';
                        // 或者直接 return
                         progress.textContent = '❌ 加密失敗';
                         progress.classList.add('active', 'error');
                         return; // 中止執行
                    }
                } else {
                    alert("未輸入密碼，將不進行加密。");
                }
            }
            // ==========================================================
            
            // --- 下載邏輯 (使用最終的 pdfBytes) ---
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.style.display = 'none';

            const defaultFileName = '重組後的PDF_' + new Date().toISOString().slice(0, 10) + '.pdf';
            let finalFileName = prompt("請確認檔案名稱：", defaultFileName);

            if (finalFileName === null) {
                progress.textContent = '使用者取消儲存。';
                progress.classList.add('active', 'error');
                setTimeout(() => {
                    progress.classList.remove('active', 'error');
                    if (url) URL.revokeObjectURL(url);
                }, 3000);
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
                     if (url) URL.revokeObjectURL(url);
                 } catch (cleanupError) { console.error("Error during cleanup:", cleanupError); }
            }, 100);

            progress.textContent = '✅ PDF 生成成功！';
            progress.classList.add('success');
            setTimeout(() => progress.classList.remove('active', 'success'), 5000);
        } catch (error) {
             console.error('生成 PDF 時發生錯誤：', error);
            progress.textContent = '❌ 生成失敗：' + error.message;
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

// ==========================================================
// === 關閉 window.onload 監聽器
// ==========================================================
};
