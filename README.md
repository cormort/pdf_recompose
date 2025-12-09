# PDF Recompose (PDF 重組工具)

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![JavaScript](https://img.shields.io/badge/language-JavaScript-yellow.svg)
![PDF-Lib](https://img.shields.io/badge/Powered%20by-PDF--Lib-orange)

一個基於瀏覽器的純前端 PDF 頁面重組工具。無需上傳伺服器，直接在本地端完成 PDF 的合併、拆分、重新排序與目錄生成。

## ✨ 主要功能

*   **🛡️ 隱私安全**：所有操作皆在瀏覽器端 (Client-side) 完成，檔案不經伺服器，適合處理機密文件。
*   **📂 多檔管理**：支援拖曳上傳多個 PDF 檔案，並提供縮圖 (Grid) 與清單 (List) 兩種預覽模式。
*   **🖱️ 靈活選取**：
    *   支援 `Shift` 鍵範圍選取。
    *   快速選取功能（全選、奇數頁、偶數頁、空白頁）。
*   **📝 專業目錄 (TOC)**：
    *   自動生成包含頁碼跳轉連結的目錄頁。
    *   **中文支援**：內嵌思源黑體 (NotoSansTC)，確保中文標題不亂碼。
    *   支援插入自訂「小節標題」以區分章節。
    *   提供文字編輯器模式，可批次修改目錄標題。
*   **🛠️ 編輯功能**：
    *   頁面自由拖曳排序 (Drag & Drop)。
    *   頁面旋轉 (90度/180度)。
    *   來源檔案頁面刪除。
*   **👀 即時預覽**：生成前可直接在瀏覽器預覽最終 PDF 成品。

## 🚀 快速開始

### 前置需求
由於瀏覽器安全限制 (CORS)，建議使用本地伺服器運行，而非直接打開 `index.html`。

### 安裝與執行

1. **Clone 專案**
   ```bash
   git clone https://github.com/cormort/pdf_recompose.git
   cd pdf_recompose
