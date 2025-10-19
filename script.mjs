// ==========================================================
// === 修正：更換為 esm.sh 這個更穩定的 CDN 來載入模組 ===
// ==========================================================
// Import local files (from user upload)
import * as pdfjsLib from './pdf.mjs';

// Import other libraries from a reliable ESM CDN
import { PDFDocument, rgb, StandardFonts } from 'https://esm.sh/pdf-lib@1.17.1';
import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';

// Set worker path to local file
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs';

// --- (The rest of the code is unchanged) ---

let pdfFiles = [];
let selectedPages = [];
let draggedElement = null;
let viewMode = 'grid';
let thumbnailSize = 'medium';
let lastSelectedIndex = null;
let clearFilesConfirmMode = false;
let clearSelectedConfirmMode = false;
let isSourceEditMode = false;

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
            alert(`處理檔案 "${file.name}" 失敗，檔案可能已損毀。`);
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
    const textContent = await page.getTextContent();
    if (textContent.items.length === 0) {
        return `Page ${pageNum}`;
    }

    const items = textContent.items
        .map(item => ({
            text: item.str.trim(),
            y: item.transform[5],
            x: item.transform[4],
            height: item.height,
        }))
        .filter(item => item.text.length > 0)
        .sort((a, b) => b.y - a.y || a.x - b.x);

    const lines = [];
    if (items.length > 0) {
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
    }

    let title = `Page ${pageNum}`;
    if (lines.length > 0) {
        let titleLineText = lines[0].map(item => item.text).join(' ');
        
        if (lines.length > 1) {
            const firstLineY = lines[0][0].y;
            const firstLineHeight = lines[0][0].height;
            const secondLineY = lines[1][0].y;
            if (Math.abs(firstLineY - secondLineY) < firstLineHeight * 1.8) {
                titleLineText += ' ' + lines[1].map(item => item.text).join(' ');
            }
        }

        let cleanedTitle = titleLineText;

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
        let earliestIndex = -1;
        let keywordLength = 0;

        for (const keyword of specialKeywords) {
            const currentIndex = cleanedTitle.indexOf(keyword);
            if (currentIndex !== -1) {
                if (earliestIndex === -1 || currentIndex < earliestIndex) {
                    earliestIndex = currentIndex;
                    keywordLength = keyword.length;
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

        if (cleanedTitle) {
            title = cleanedTitle;
        }
    }
    return title;
}

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

// Make functions available globally so they can be called from HTML `onclick`
window.clearAllFiles = function() {
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

window.setViewMode = function(mode) {
    viewMode = mode;
    document.getElementById('gridViewBtn').classList.toggle('active', mode === 'grid');
    document.getElementById('listViewBtn').classList.toggle('active', mode === 'list');
    renderSourcePages();
}

window.setThumbnailSize = function(size) {
    thumbnailSize = size;
    sourcePanel.classList.remove('size-small', 'size-medium', 'size-large', 'size-xlarge');
    sourcePanel.classList.add(`size-${size}`);
    
    document.querySelectorAll('#size-toggle button').forEach(btn => btn.classList.remove('active'));
    document.querySelector(`#size-toggle button[onclick="setThumbnailSize('${size}')"]`).classList.add('active');
}

window.toggleSourceEditMode = function() {
    isSourceEditMode = !isSourceEditMode;
    const btn = document.getElementById('editSourceBtn');
    sourcePanel.classList.toggle('edit-mode', isSourceEditMode);
    btn.classList.toggle('active', isSourceEditMode);
    btn.innerHTML = isSourceEditMode ? '✓ 完成' : '🗑️ 刪除頁面';
    renderSourcePages();
}

window.deleteSourcePage = function(fileIndex, pageIndex) {
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

window.togglePage = function(fileIndex, pageIndex, event) {
    if (isSourceEditMode) return;
    const currentGlobalIndex = getGlobalPageIndex(fileIndex, pageIndex);
    if (event && event.shiftKey && lastSelectedIndex !== null) {
        const start = Math.min(lastSelectedIndex, currentGlobalIndex);
        const end = Math.max(lastSelectedIndex, currentGlobalIndex);
        for (let i = start; i <= end; i++) {
            const pos = getPageByGlobalIndex(i);
            if (pos) {
                const f = pdfFiles[pos.fileIndex];
                const p = f.pages[pos.pageIndex];
                if (!selectedPages.some(sp => sp.type !== 'divider' && sp.fileIndex === pos.fileIndex && sp.pageNum === p.pageNum)) {
                    selectedPages.push({ type: 'page', fileIndex: pos.fileIndex, pageNum: p.pageNum, fileName: f.name, canvas: p.canvas, firstLine: p.firstLine });
                }
            }
        }
    } else {
        const existingIndex = selectedPages.findIndex(p => p.type !== 'divider' && p.fileIndex === fileIndex && p.pageNum === pdfFiles[fileIndex].pages[pageIndex].pageNum);
        if (existingIndex >= 0) {
            selectedPages.splice(existingIndex, 1);
        } else {
            const file = pdfFiles[fileIndex];
            const page = file.pages[pageIndex];
            selectedPages.push({ type: 'page', fileIndex: fileIndex, pageNum: page.pageNum, fileName: file.name, canvas: page.canvas, firstLine: page.firstLine });
        }
    }
    lastSelectedIndex = currentGlobalIndex;
    renderSourcePages();
    renderSelectedPages();
}

window.clearSelectedPages = function() {
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

window.addSectionDivider = function() {
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

window.openTocEditor = function() {
    const pageItems = selectedPages.filter(p => p.type !== 'divider');
    if (pageItems.length === 0) {
        alert('請先選擇至少一個頁面才能編輯目錄。');
        return;
    }
    const titles = pageItems.map(p => p.firstLine).join('\n');
    tocTextarea.value = titles;
    tocModal.style.display = 'flex';
}

window.closeTocEditor = function() {
    tocModal.style.display = 'none';
}

window.saveToc = function() {
    const newTitles = tocTextarea.value.split('\n');
    const pageItems = selectedPages.filter(p => p.type !== 'divider');
    if (newTitles.length !== pageItems.length) {
        alert(`錯誤：目錄行數 (${newTitles.length}) 與選擇的頁數 (${pageItems.length}) 不符，請檢查後再儲存。`);
        return;
    }
    let titleIndex = 0;
    selectedPages.forEach(item => {
        if (item.type !== 'divider') {
            item.firstLine = newTitles[titleIndex];
            titleIndex++;
        }
    });
    renderSelectedPages();
    closeTocEditor();
}

window.removeSelectedPage = function(index) {
    selectedPages.splice(index, 1);
    renderSourcePages();
    renderSelectedPages();
}

function renderSourcePages() {
    if (pdfFiles.length === 0) {
        sourcePages.innerHTML = '<div class="empty-message">尚未載入任何 PDF 檔案</div>';
        return;
    }
    sourcePages.innerHTML = pdfFiles.map((file, fileIndex) => {
        const pagesHtml = viewMode === 'grid' 
            ? `<div class="pages-grid">${file.pages.map((page, pageIndex) => renderPageItem(fileIndex, pageIndex, 'grid')).join('')}</div>`
            : `<div class="pages-list">${file.pages.map((page, pageIndex) => renderPageItem(fileIndex, pageIndex, 'list')).join('')}</div>`;
        return `<div class="pdf-file"><div class="pdf-file-header"><div class="pdf-file-name">${file.name}</div></div>${pagesHtml}</div>`;
    }).join('');
    pdfFiles.forEach((file, fileIndex) => {
        file.pages.forEach((page, pageIndex) => {
            const canvas = document.getElementById(`source_${fileIndex}_${pageIndex}`);
            if (canvas) {
                const ctx = canvas.getContext('2d');
                canvas.width = page.canvas.width;
                canvas.height = page.canvas.height;
                ctx.drawImage(page.canvas, 0, 0);
            }
        });
    });
}

function renderPageItem(fileIndex, pageIndex, type) {
    const page = pdfFiles[fileIndex].pages[pageIndex];
    const isSelected = selectedPages.some(p => p.type !== 'divider' && p.fileIndex === fileIndex && p.pageNum === page.pageNum);
    const clickAction = isSourceEditMode ? '' : `onclick="togglePage(${fileIndex}, ${pageIndex}, event)"`;
    
    if (type === 'grid') {
        return `
            <div class="page-item ${isSelected ? 'selected' : ''}" ${clickAction}>
                <button class="delete-btn" onclick="deleteSourcePage(${fileIndex}, ${pageIndex})">✕</button>
                <canvas id="source_${fileIndex}_${pageIndex}"></canvas>
                <div class="page-number">第 ${page.pageNum} 頁</div>
            </div>`;
    } else { // list
        return `
            <div class="page-list-item ${isSelected ? 'selected' : ''}" ${clickAction} title="${page.firstLine}">
                <div class="page-list-text">${page.firstLine}</div>
                <div class="page-list-number">第 ${page.pageNum} 頁</div>
                <button class="delete-btn" onclick="deleteSourcePage(${fileIndex}, ${pageIndex})">刪除</button>
            </div>`;
    }
}

function getGlobalPageIndex(fileIndex, pageIndex) {
    return pdfFiles.slice(0, fileIndex).reduce((acc, file) => acc + file.pages.length, 0) + pageIndex;
}

function getPageByGlobalIndex(globalIndex) {
    let count = 0;
    for (let fileIndex = 0; fileIndex < pdfFiles.length; fileIndex++) {
        const file = pdfFiles[fileIndex];
        if (globalIndex < count + file.pages.length) {
            return { fileIndex, pageIndex: globalIndex - count };
        }
        count += file.pages.length;
    }
    return null;
}

function renderSelectedPages() {
    if (selectedPages.length === 0) {
        selectedPagesContainer.innerHTML = '<div class="empty-message">尚未選擇任何頁面</div>';
        return;
    }
    selectedPagesContainer.innerHTML = selectedPages.map((item, index) => {
        if (item.type === 'divider') {
            return `
                <div class="selected-divider-item" draggable="true" data-index="${index}">
                    <span class="drag-handle">⋮⋮</span>
                    <div class="selected-divider-title">${item.firstLine}</div>
                    <div class="page-actions">
                        <button class="btn btn-danger" onclick="removeSelectedPage(${index})">✕</button>
                    </div>
                </div>
            `;
        }
        return `
            <div class="selected-page-item" draggable="true" data-index="${index}">
                <span class="drag-handle">⋮⋮</span>
                <canvas id="selected_${index}"></canvas>
                <div class="selected-page-info">
                    <div class="selected-page-title">${item.firstLine}</div>
                    <div class="selected-page-source">${item.fileName} - 第 ${item.pageNum} 頁</div>
                </div>
                <div class="page-actions">
                    <button class="btn btn-danger" onclick="removeSelectedPage(${index})">✕</button>
                </div>
            </div>
        `;
    }).join('');

    selectedPages.forEach((item, index) => {
        if (item.type !== 'divider') {
            const canvas = document.getElementById(`selected_${index}`);
            const ctx = canvas.getContext('2d');
            canvas.width = item.canvas.width;
            canvas.height = item.canvas.height;
            ctx.drawImage(item.canvas, 0, 0);
        }
    });
    setupDragAndDrop();
}

function setupDragAndDrop() {
    document.querySelectorAll('.selected-page-item, .selected-divider-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            draggedElement = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        item.addEventListener('dragend', () => item.classList.remove('dragging'));
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            const afterElement = getDragAfterElement(selectedPagesContainer, e.clientY);
            if (afterElement == null) {
                selectedPagesContainer.appendChild(draggedElement);
            } else {
                selectedPagesContainer.insertBefore(draggedElement, afterElement);
            }
        });
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            const fromIndex = parseInt(draggedElement.dataset.index);
            const toIndex = Array.from(selectedPagesContainer.children).indexOf(draggedElement);
            const [movedItem] = selectedPages.splice(fromIndex, 1);
            selectedPages.splice(toIndex, 0, movedItem);
            renderSelectedPages();
        });
    });
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.selected-page-item:not(.dragging), .selected-divider-item:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

window.generatePDF = async function() {
    const pageItems = selectedPages.filter(p => p.type !== 'divider');
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
            const fontUrl = 'https://cdn.jsdelivr.net/gh/google/fonts/ofl/notosanstc/NotoSansTC-Regular.otf';
            const fontBytes = await fetch(fontUrl).then(res => res.arrayBuffer());
            
            newPdf.registerFontkit(fontkit); 
            customFont = await newPdf.embedFont(fontBytes);
        } catch (fontError) {
            console.error("中文字型載入失敗:", fontError);
            alert("警告：中文字型下載失敗，目錄將使用英文字型顯示（中文會變亂碼）。");
            customFont = await newPdf.embedFont(StandardFonts.Helvetica);
        }
        
        const addToc = addTocCheckbox.checked;
        let pageOffset = addToc ? 1 : 0; 

        if (addToc) {
            progress.textContent = '正在建立目錄頁...';
            const tocPage = newPdf.addPage([842, 595]);
            tocPage.drawText('目錄', { x: 50, y: 595 - 50, size: 18, font: customFont, color: rgb(0,0,0) });
            let yPosition = 595 - 90;
            let pageCounterForToc = 0;

            selectedPages.forEach(item => {
                if (item.type === 'divider') {
                    yPosition -= 10;
                    tocPage.drawText(item.firstLine, { x: 50, y: yPosition, size: 14, font: customFont, color: rgb(0,0,0) });
                    yPosition -= 25;
                } else {
                    pageCounterForToc++;
                    const title = item.firstLine;
                    const pageNumStr = `${pageCounterForToc + pageOffset}`; 

                    const leftMargin = 70;
                    const rightMargin = 50;
                    const fontSize = 12;
                    const pageContentWidth = tocPage.getWidth() - leftMargin - rightMargin;

                    const pageNumWidth = customFont.widthOfTextAtSize(pageNumStr, fontSize);
                    
                    let truncatedTitle = title;
                    let titleWidth = customFont.widthOfTextAtSize(truncatedTitle, fontSize);
                    const minDotSpace = 20;

                    while (titleWidth + pageNumWidth + minDotSpace > pageContentWidth && truncatedTitle.length > 5) {
                        truncatedTitle = truncatedTitle.slice(0, -2) + '…';
                        titleWidth = customFont.widthOfTextAtSize(truncatedTitle, fontSize);
                    }

                    tocPage.drawText(truncatedTitle, { x: leftMargin, y: yPosition, size: fontSize, font: customFont, color: rgb(0,0,0) });
                    tocPage.drawText(pageNumStr, { x: tocPage.getWidth() - rightMargin - pageNumWidth, y: yPosition, size: fontSize, font: customFont, color: rgb(0,0,0) });

                    const dotWidth = customFont.widthOfTextAtSize('.', fontSize);
                    const dotStartX = leftMargin + titleWidth + 5;
                    const dotEndX = tocPage.getWidth() - rightMargin - pageNumWidth - 5;
                    const availableDotSpace = dotEndX - dotStartX;

                    if (availableDotSpace > dotWidth) {
                        const numDots = Math.floor(availableDotSpace / dotWidth);
                        const dotString = '.'.repeat(numDots);
                        tocPage.drawText(dotString, { x: dotStartX, y: yPosition, size: fontSize, font: customFont, color: rgb(0,0,0), opacity: 0.5 });
                    }
                    yPosition -= 20;
                }
            });
        }

        let pageCounterForContent = 0;
        for (const item of selectedPages) {
            if (item.type === 'divider') continue;

            pageCounterForContent++;
            progress.textContent = `正在合併頁面 (${pageCounterForContent}/${pageItems.length})...`;
            
            const sourceFile = pdfFiles[item.fileIndex];
            const freshArrayBuffer = await sourceFile.file.arrayBuffer();
            const sourcePdf = await PDFDocument.load(freshArrayBuffer);
            const [copiedPage] = await newPdf.copyPages(sourcePdf, [item.pageNum - 1]);
            newPdf.addPage(copiedPage);
            
            const newPageNumber = `${pageCounterForContent + pageOffset}`;
            const { width, height } = copiedPage.getSize();
            copiedPage.drawText(newPageNumber, {
                x: width - 40,
                y: 30,
                size: 10,
                font: customFont,
                color: rgb(0, 0, 0)
            });
        }

        progress.textContent = '正在儲存 PDF...';
        
        const saveOptions = {};
        if (addEncryptCheckbox.checked) {
            const password = prompt("請輸入 PDF [開啟] 密碼（若取消則不加密）：");
            if (password && password.trim() !== "") {
                saveOptions.userPassword = password;
                progress.textContent = '正在加密並儲存...';
            } else {
                alert("未輸入密碼，將不進行加密。");
            }
        }
        
        const pdfBytes = await newPdf.save(saveOptions);

        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        const defaultFileName = '重組後的PDF_' + new Date().toISOString().slice(0, 10) + '.pdf';
        let finalFileName = prompt("請確認檔案名稱：", defaultFileName);

        if (finalFileName === null) {
            progress.textContent = '使用者取消儲存。';
            progress.classList.add('active', 'error');
            setTimeout(() => {
                progress.classList.remove('active', 'error');
                if (document.body.contains(a)) {
                    document.body.removeChild(a);
                }
                URL.revokeObjectURL(url);
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
            if (document.body.contains(a)) {
                document.body.removeChild(a);
            }
            URL.revokeObjectURL(url);
        }, 1000);

        progress.textContent = '✅ PDF 生成成功！';
        progress.classList.add('success');
        setTimeout(() => progress.classList.remove('active', 'success'), 5000);
    } catch (error) {
        progress.textContent = '❌ 生成失敗：' + error.message;
        progress.classList.add('active', 'error');
        console.error('生成 PDF 時發生錯誤：', error);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    setThumbnailSize('medium');
    tocModal.addEventListener('click', (e) => {
        if (e.target === tocModal) {
            closeTocEditor();
        }
    });
});
