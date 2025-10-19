// ==========================================================
// ===         *** 本地檔案 + window.onload ***
// === 確保所有函式庫 (包含本地 pdf.min.js) 都載入後才執行
// ==========================================================
window.onload = function() {

    // --- 檢查 pdfjsLib 是否已定義 ---
    if (typeof pdfjsLib === 'undefined') {
        console.error("CRITICAL: pdfjsLib is not defined even after window.onload!");
        alert("錯誤：PDF 核心函式庫 (pdf.min.js) 載入失敗。請確認檔案是否存在於同資料夾。");
        // 可以在此處停止執行或顯示更明顯的錯誤訊息
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
        alert("警告：字型函式庫 (fontkit.umd.min.js) 載入失敗，目錄功能可能異常。");
        // 仍然繼續執行
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
                // 使用 pdfjsLib (現在應該已定義)
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
                    text: item.str ? item.str.trim() : '', // Add check for item.str
                    y: item.transform ? item.transform[5] : 0, // Add check and default
                    x: item.transform ? item.transform[4] : 0, // Add check and default
                    height: item.height || 0, // Add check and default
                }))
                .filter(item => item.text.length > 0)
                .sort((a, b) => b.y - a.y || a.x - b.x);

            if (items.length === 0) { // Check again after filtering
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
            if (lines.length > 0 && lines[0].length > 0) { // Ensure line is not empty
                let titleLineText = lines[0].map(item => item.text).join(' ');
                
                if (lines.length > 1 && lines[1].length > 0) { // Ensure line is not empty
                    const firstLineY = lines[0][0].y;
                    const firstLineHeight = lines[0][0].height;
                    const secondLineY = lines[1][0].y;
                    if (Math.abs(firstLineY - secondLineY) < firstLineHeight * 1.8) {
                        titleLineText += ' ' + lines[1].map(item => item.text).join(' ');
                    }
                }

                let cleanedTitle = titleLineText;

                // --- Title cleaning logic (remains the same) ---
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
             return `Page ${pageNum}`; // Return default page number on error
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
        if (!pdfFiles[fileIndex] || !pdfFiles[fileIndex].pages[pageIndex]) return; // Add boundary check
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
        if (!pdfFiles[fileIndex] || !pdfFiles[fileIndex].pages[pageIndex]) return; // Add boundary check
        
        const currentGlobalIndex = getGlobalPageIndex(fileIndex, pageIndex);
        if (event && event.shiftKey && lastSelectedIndex !== null) {
            const start = Math.min(lastSelectedIndex, currentGlobalIndex);
            const end = Math.max(lastSelectedIndex, currentGlobalIndex);
            for (let i = start; i <= end; i++) {
                const pos = getPageByGlobalIndex(i);
                if (pos && pdfFiles[pos.fileIndex] && pdfFiles[pos.fileIndex].pages[pos.pageIndex]) { // Add boundary check
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
            if (pdfFiles[i]) { // Add check
                 count += pdfFiles[i].pages.length;
            }
        }
        return count + pageIndex;
    }
    
    function getPageByGlobalIndex(globalIndex) {
        let count = 0;
        for (let fileIndex = 0; fileIndex < pdfFiles.length; fileIndex++) {
             if (pdfFiles[fileIndex]) { // Add check
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
                id: Date.now() // Unique ID for key
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
             if (!file) return ''; // Add check for null file
             const pagesHtml = viewMode === 'grid' 
                ? `<div class="pages-grid">${file.pages.map((page, pageIndex) => renderPageItem(fileIndex, pageIndex, 'grid')).join('')}</div>`
                : `<div class="pages-list">${file.pages.map((page, pageIndex) => renderPageItem(fileIndex, pageIndex, 'list')).join('')}</div>`;
             return `<div class="pdf-file"><div class="pdf-file-header"><div class="pdf-file-name">${file.name || 'Unknown File'}</div></div>${pagesHtml}</div>`; // Add default name
        }).join('');

        // Re-render canvases after HTML update
        pdfFiles.forEach((file, fileIndex) => {
             if (file) {
                 file.pages.forEach((page, pageIndex) => {
                     const canvas = document.getElementById(`source_${fileIndex}_${pageIndex}`);
                     if (canvas && page.canvas) { // Ensure canvas element and page data exist
                        const ctx = canvas.getContext('2d');
                        // Ensure dimensions are valid before drawing
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
        // Add boundary checks
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
                </div>`; // Add default page number
        } else { // list
             const title = page.firstLine || `Page ${page.pageNum || '?'}`; // Default title
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
             if (!item) return ''; // Add boundary check
            if (item.type === 'divider') {
                return `
                    <div class="selected-divider-item" draggable="true" data-index="${index}">
                        <span class="drag-handle">⋮⋮</span>
                         <div class="selected-divider-title">${item.firstLine || 'New Section'}</div> 
                        <div class="page-actions">
                            <button class="btn btn-danger" onclick="removeSelectedPage(${index})">✕</button>
                        </div>
                    </div>
                `; // Add default title
            }
            // Default is a page item
             const title = item.firstLine || `Page ${item.pageNum || '?'}`; // Default title
             const source = `${item.fileName || 'Unknown File'} - 第 ${item.pageNum || '?'} 頁`; // Default source
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

        // Re-render canvases after HTML update
        selectedPages.forEach((item, index) => {
             // Add checks
             if (item && item.type !== 'divider') {
                 const canvas = document.getElementById(`selected_${index}`);
                 if (canvas && item.canvas) { // Ensure canvas element and item data exist
                     const ctx = canvas.getContext('2d');
                     // Ensure dimensions are valid before drawing
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
                if (e.dataTransfer) { // Check if dataTransfer exists
                    e.dataTransfer.effectAllowed = 'move';
                }
            });
            item.addEventListener('dragend', () => {
                 if(draggedElement) draggedElement.classList.remove('dragging'); // Add check
                 draggedElement = null; // Reset draggedElement
            });
            item.addEventListener('dragover', (e) => {
                e.preventDefault(); // Necessary to allow dropping
                if (!draggedElement) return; // Don't do anything if nothing is being dragged
                const afterElement = getDragAfterElement(selectedPagesContainer, e.clientY);
                try { // Add try-catch for potential DOM manipulation errors
                    if (afterElement == null) {
                         if (selectedPagesContainer.lastChild !== draggedElement) { // Prevent appending if already last
                            selectedPagesContainer.appendChild(draggedElement);
                        }
                    } else {
                         if (afterElement !== draggedElement && afterElement.previousSibling !== draggedElement) { // Prevent inserting before/after itself
                            selectedPagesContainer.insertBefore(draggedElement, afterElement);
                        }
                    }
                } catch (error) {
                    console.error("Error during dragover DOM manipulation:", error);
                }
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                 if (!draggedElement) return; // Ensure an element was actually dragged

                 // Get the original index BEFORE potential DOM reordering during dragover
                 const fromIndexAttr = draggedElement.getAttribute('data-index');
                 if (fromIndexAttr === null) {
                    console.error("Dragged element missing data-index attribute.");
                    return; // Abort if index is missing
                 }
                 const fromIndex = parseInt(fromIndexAttr, 10);


                 // Get the new index based on the final position in the DOM
                 const currentChildren = Array.from(selectedPagesContainer.children);
                 const toIndex = currentChildren.indexOf(draggedElement);

                 // Check for valid indices
                 if (isNaN(fromIndex) || fromIndex < 0 || fromIndex >= selectedPages.length || toIndex < 0) {
                     console.error("Invalid index during drop:", { fromIndex, toIndex, selectedPagesLength: selectedPages.length });
                     // Reset visual state and abort data update if indices are bad
                     draggedElement.classList.remove('dragging');
                     renderSelectedPages(); // Re-render to fix visual state
                     return;
                 }


                 // Only update array if indices are different
                 if (fromIndex !== toIndex) {
                    // Update the underlying selectedPages array
                    const [movedItem] = selectedPages.splice(fromIndex, 1);
                    if (movedItem) { // Ensure splice returned an item
                         selectedPages.splice(toIndex, 0, movedItem);
                     } else {
                         console.error("Splice failed to return the moved item.");
                         renderSelectedPages(); // Re-render to fix visual state
                         return; // Abort if splice failed
                    }
                 }

                // Always re-render to update data-index attributes and ensure consistency
                renderSelectedPages();
            });
        });
    }

    function getDragAfterElement(container, y) {
        // Get only direct children that are draggable and not the one being dragged
        const draggableElements = [...container.children].filter(child =>
            child.matches('.selected-page-item, .selected-divider-item') && !child.classList.contains('dragging')
        );

        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
             // Calculate midpoint of the element
            const midpoint = box.top + box.height / 2;
             // Calculate offset of the cursor (y) from the element's midpoint
            const offset = y - midpoint;

             // Find the element immediately *below* the cursor
             // We want the one with the smallest positive offset (closest below)
            if (offset > 0 && offset < closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
         }, { offset: Number.POSITIVE_INFINITY }).element; // Start with positive infinity
         // If no element is found below (cursor is at the bottom or container empty),
         // this returns `undefined`, which means appendChild should be used.
    }


    function openTocEditor() {
        const pageItems = selectedPages.filter(p => p && p.type !== 'divider'); // Add check for p
        if (pageItems.length === 0) {
            alert('請先選擇至少一個頁面才能編輯目錄。');
            return;
        }
        const titles = pageItems.map(p => p.firstLine || `Page ${p.pageNum || '?'}`).join('\n'); // Add default title
        tocTextarea.value = titles;
        tocModal.style.display = 'flex';
    }

    function closeTocEditor() {
        tocModal.style.display = 'none';
    }

    function saveToc() {
        const newTitles = tocTextarea.value.split('\n');
        const pageItems = selectedPages.filter(p => p && p.type !== 'divider'); // Add check for p
        if (newTitles.length !== pageItems.length) {
            alert(`錯誤：目錄行數 (${newTitles.length}) 與選擇的頁數 (${pageItems.length}) 不符，請檢查後再儲存。`);
            return;
        }
        let titleIndex = 0;
        selectedPages.forEach(item => {
            if (item && item.type !== 'divider') { // Add check for item
                item.firstLine = newTitles[titleIndex] || `Page ${item.pageNum || '?'}`; // Add default title if line is empty
                titleIndex++;
            }
        });
        renderSelectedPages();
        closeTocEditor();
    }

    async function generatePDF() {
         // Check again inside the function in case libraries failed silently
         if (typeof PDFLib === 'undefined' || typeof PDFLib.PDFDocument === 'undefined') {
            console.error("PDFLib not available in generatePDF");
            alert("錯誤：無法生成 PDF，編輯函式庫載入失敗。");
            return;
        }
        const { PDFDocument, rgb, StandardFonts } = PDFLib;

        const pageItems = selectedPages.filter(p => p && p.type !== 'divider'); // Add check for p
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
                progress.textContent = '正在下載中文字型...';
                const fontUrl = '.fonts/NotoSansTC-Regular.ttf';
                const fontBytes = await fetch(fontUrl).then(res => {
                    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                    return res.arrayBuffer();
                });
                
                // Check fontkit again
                if (typeof fontkit === 'undefined') {
                     console.warn("fontkit not loaded, using default font for TOC.");
                     customFont = await newPdf.embedFont(StandardFonts.Helvetica);
                } else {
                    newPdf.registerFontkit(fontkit); 
                    customFont = await newPdf.embedFont(fontBytes);
                }
            } catch (fontError) {
                console.error("中文字型載入失敗:", fontError);
                alert("警告：中文字型下載失敗，目錄將使用英文字型顯示（中文會變亂碼）。");
                // Fallback font
                 try {
                     customFont = await newPdf.embedFont(StandardFonts.Helvetica);
                 } catch (embedError) {
                     console.error("Failed to embed fallback font:", embedError);
                     alert("致命錯誤：無法嵌入預設字型。");
                     progress.textContent = '❌ 生成失敗：無法嵌入字型';
                     progress.classList.add('active', 'error');
                     return; // Abort if even fallback fails
                 }
            }
            
            const addToc = addTocCheckbox.checked;
            let pageOffset = addToc ? 1 : 0; 

            if (addToc) {
                progress.textContent = '正在建立目錄頁...';
                const tocPage = newPdf.addPage([842, 595]); // A4 Landscape? Ensure size is correct.
                tocPage.drawText('目錄', { x: 50, y: 595 - 50, size: 18, font: customFont, color: rgb(0,0,0) });
                let yPosition = 595 - 90;
                let pageCounterForToc = 0;

                for (const item of selectedPages) { // Use for...of for potential async later
                     if (!item) continue; // Skip null items

                     // Check if yPosition is too low, add new TOC page if needed
                     if (yPosition < 40) {
                         // TODO: Implement adding a new TOC page if content overflows
                         console.warn("TOC content might overflow, add new page logic needed.");
                         break; // Stop adding items for now
                     }


                    if (item.type === 'divider') {
                        yPosition -= 10;
                        tocPage.drawText(item.firstLine || 'New Section', { x: 50, y: yPosition, size: 14, font: customFont, color: rgb(0,0,0) });
                        yPosition -= 25;
                    } else {
                        pageCounterForToc++;
                         const title = item.firstLine || `Page ${item.pageNum || '?'}`; // Default title
                        const pageNumStr = `${pageCounterForToc + pageOffset}`; 

                        const leftMargin = 70;
                        const rightMargin = 50;
                        const fontSize = 12;
                        const pageContentWidth = tocPage.getWidth() - leftMargin - rightMargin;

                        let pageNumWidth = 0;
                        try {
                             pageNumWidth = customFont.widthOfTextAtSize(pageNumStr, fontSize);
                         } catch (e) { console.error("Error getting pageNum width:", e); }


                        let truncatedTitle = title;
                        let titleWidth = 0;
                         try {
                             titleWidth = customFont.widthOfTextAtSize(truncatedTitle, fontSize);
                         } catch (e) { console.error("Error getting title width:", e); }

                        const minDotSpace = 20;

                        // Truncate title logic
                        while (titleWidth > 0 && pageContentWidth > 0 && (titleWidth + pageNumWidth + minDotSpace > pageContentWidth) && truncatedTitle.length > 5) {
                            truncatedTitle = truncatedTitle.slice(0, -2) + '…';
                            try {
                                titleWidth = customFont.widthOfTextAtSize(truncatedTitle, fontSize);
                            } catch (e) {
                                 console.error("Error getting truncated title width:", e);
                                 titleWidth = 0; // Prevent infinite loop on error
                            }
                        }

                        // Draw text elements
                        tocPage.drawText(truncatedTitle, { x: leftMargin, y: yPosition, size: fontSize, font: customFont, color: rgb(0,0,0) });
                        tocPage.drawText(pageNumStr, { x: tocPage.getWidth() - rightMargin - pageNumWidth, y: yPosition, size: fontSize, font: customFont, color: rgb(0,0,0) });

                         // Draw dots logic
                         let dotWidth = 0;
                         try {
                            dotWidth = customFont.widthOfTextAtSize('.', fontSize);
                         } catch (e) { console.error("Error getting dot width:", e); }

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
            for (const item of selectedPages) { // Use for...of
                if (!item || item.type === 'divider') continue; // Skip null/divider items

                pageCounterForContent++;
                progress.textContent = `正在合併頁面 (${pageCounterForContent}/${pageItems.length})...`;
                
                // Ensure source file data is valid
                if (item.fileIndex === undefined || item.fileIndex === null || !pdfFiles[item.fileIndex] || !pdfFiles[item.fileIndex].file || !item.pageNum) {
                     console.error("Missing data for selected page item:", item);
                     continue; // Skip this page if data is bad
                }


                const sourceFile = pdfFiles[item.fileIndex];
                try {
                    const freshArrayBuffer = await sourceFile.file.arrayBuffer();
                     // Add load options for robustness
                    const sourcePdf = await PDFDocument.load(freshArrayBuffer, {
                        ignoreEncryption: true, // Attempt to load even if encrypted (might fail later)
                        updateMetadata: false
                    });

                     // Check if pageNum is valid for the source PDF
                     if (item.pageNum < 1 || item.pageNum > sourcePdf.getPageCount()) {
                         console.error(`Invalid page number ${item.pageNum} for file ${sourceFile.name} with ${sourcePdf.getPageCount()} pages.`);
                         continue; // Skip invalid page
                     }

                    const [copiedPage] = await newPdf.copyPages(sourcePdf, [item.pageNum - 1]);
                    newPdf.addPage(copiedPage);
                    
                    const newPageNumber = `${pageCounterForContent + pageOffset}`;
                    const { width, height } = copiedPage.getSize();
                     // Add checks for valid dimensions
                     if (width > 0 && height > 0) {
                        copiedPage.drawText(newPageNumber, {
                            x: width - 40,
                            y: 30,
                            size: 10,
                            font: customFont, // Use the potentially fallback font
                            color: rgb(0, 0, 0)
                        });
                     } else {
                         console.warn(`Invalid dimensions for page ${pageCounterForContent}`);
                    }
                } catch(loadError) {
                    console.error(`Error loading or copying page ${item.pageNum} from ${sourceFile.name}:`, loadError);
                     alert(`錯誤：無法載入或複製檔案 "${sourceFile.name}" 的第 ${item.pageNum} 頁。檔案可能已損毀或加密。`);
                    // Optionally decide whether to continue or abort PDF generation
                }
            }

            progress.textContent = '正在儲存 PDF...';
            
            // ==========================================================
            // ===            *** 最終加密修正 *** ===
            // ==========================================================
            const saveOptions = {};
            if (addEncryptCheckbox.checked) {
                const userPassword = prompt("請輸入 PDF [開啟] 密碼（若取消則不加密）：");
                if (userPassword && userPassword.trim() !== "") {
                    saveOptions.userPassword = userPassword;
                    saveOptions.ownerPassword = `owner-${userPassword}-${Date.now()}`; 
                    progress.textContent = '正在加密並儲存...';
                } else {
                    alert("未輸入密碼，將不進行加密。");
                }
            }
            // ==========================================================
            
            const pdfBytes = await newPdf.save(saveOptions);

            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.style.display = 'none'; // Hide the link

            const defaultFileName = '重組後的PDF_' + new Date().toISOString().slice(0, 10) + '.pdf';
            let finalFileName = prompt("請確認檔案名稱：", defaultFileName);

            if (finalFileName === null) {
                progress.textContent = '使用者取消儲存。';
                progress.classList.add('active', 'error');
                setTimeout(() => {
                    progress.classList.remove('active', 'error');
                    // Clean up URL object
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
            
            // Clean up after download starts
            setTimeout(() => {
                 try {
                     document.body.removeChild(a);
                     if (url) URL.revokeObjectURL(url);
                 } catch (cleanupError) {
                     console.error("Error during cleanup:", cleanupError);
                 }
            }, 100); // Short delay is usually enough

            progress.textContent = '✅ PDF 生成成功！';
            progress.classList.add('success');
            setTimeout(() => progress.classList.remove('active', 'success'), 5000);
        } catch (error) {
             console.error('生成 PDF 時發生錯誤：', error); // Log the full error
            progress.textContent = '❌ 生成失敗：' + error.message;
            progress.classList.add('active', 'error');
             // Consider adding a longer timeout for error messages
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
