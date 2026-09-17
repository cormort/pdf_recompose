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
    *   ⚡ 智慧勾選（全選、奇數頁、偶數頁、空白頁…）：採**篩選**語意，套用時會以該條件重新設定勾選
      （若原本已有勾選會先跳確認），因此「奇數頁」不會和先前手動勾的偶數頁混在一起。
*   **📝 專業目錄 (TOC)**：
    *   自動生成包含頁碼跳轉連結的目錄頁。
    *   **中文支援**：內嵌思源黑體 (NotoSansTC)，確保中文標題不亂碼。
    *   支援插入自訂「小節標題」以區分章節；目錄只列出「後面還有內容頁」的小節，結尾的空章節會標示為「空章節，不列入目錄」。
    *   提供文字編輯器模式，可批次修改目錄標題，行首每 2 個空白代表縮一層。
*   **🔖 書籤大綱（雙向）**：
    *   **讀取**：載入時自動抽出來源 PDF 既有的書籤（含標題、階層、頁碼）。按「🔖 帶入來源書籤」就能一鍵預填目錄，不必一行一行手打。
    *   **寫入**：把最終目錄寫成 PDF 原生書籤（`/Outlines`），在 Acrobat／瀏覽器／多數閱讀器的左側書籤面板可以直接跳章節；可獨立於「目錄頁」開啟。
    *   **中文書籤**：書籤標題以 UTF-16BE + BOM 編碼（`PDFString` 走 PDFDocEncoding，中文會變亂碼）。
*   **🛠️ 編輯功能**：
    *   頁面自由拖曳排序 (Drag & Drop)。
    *   頁面旋轉 (90度/180度)。
    *   來源檔案頁面刪除。
*   **↶ 復原／重做**：所有編輯（加入、刪除、旋轉、排序、小節、目錄編輯、智慧勾選）都可以 Ctrl+Z／Ctrl+Shift+Z 復原，
    歷史深度 60 步；同一次拖曳的連續事件會合併成一步。
*   **💾 工作階段還原**：載入的檔案與整份編排會自動存進 IndexedDB，重新開啟時詢問是否還原，
    不小心重新整理或關掉分頁都不用重做。單一工作階段超過 80MB 時會自動停止保存（不影響操作）。
*   **👀 即時預覽**：生成前可直接在瀏覽器預覽最終 PDF 成品。

## 🔒 隱私與資料流

*   所有 PDF 都在瀏覽器記憶體內處理，**不會上傳**到任何伺服器；本專案沒有任何後端。
*   函式庫全部隨 repo 附帶（`pdf.min.js`／`pdf.worker.min.js`＝pdf.js 2.10.377、`pdf-lib.min.js`、`fontkit.umd.min.js`、`sortable.min.js` 1.15.6），**不從 CDN 載入**，封閉網路也能用。
*   唯一的對外連線是 Google Analytics（`googletagmanager.com`）的瀏覽量統計，送出的是頁面與瀏覽器資訊，**不含檔名或 PDF 內容**；要完全離線可封鎖該網域，功能不受影響。

## ✅ 驗證

```bash
npm test        # = node verify.mjs，需要 playwright
```

`verify.mjs` 會起一個本地靜態伺服器、用 Playwright 操作真實 UI（上傳→選取→旋轉→小節→刪除→
目錄＋頁碼→生成），再用 repo 內自帶的 pdf-lib／pdf.js **把產出的 PDF 解回來驗證**：

*   頁數、頁序、各頁旋轉角度是否寫進輸出。
*   目錄頁的文字（含中文）、目錄頁碼、內容頁頁碼是否**能被抽取**（＝使用者搜尋／複製正常）。
*   跨頁目錄（40 頁內容）時，每一頁印出的頁碼與實體頁序是否一致、每個超連結是否指向正確的內容頁。
*   移除來源檔案後，右側成品的來源索引是否正確修正（否則會抓到別份檔案的頁）。
*   縮圖是否為 data URL 的 `<img>`（載入後頁面上不應殘留 canvas，這是記憶體回歸的守門）。
*   連續生成不會累積未釋放的 blob URL；全程不得有 pageerror／console error。
*   回歸守門（每一項都對應一個實際修過的 bug）：載入中丟入的下一批檔案必須排隊處理（不能靜默漏檔）、
  載入完成當下可見範圍的縮圖就必須已渲染（延遲渲染不能延到下一幀）、智慧勾選必須是「取代」而非「疊加」。
*   書籤組：來源書籤的標題／階層／頁碼抽取是否正確；預填目錄是否帶入階層；輸出 PDF 的書籤
  標題（含中文）、階層、以及每個書籤指向的**實體頁**是否正確（含目錄頁位移）；只寫書籤不加目錄頁時
  也要正確（無位移）。
*   復原／重做：批次加入／旋轉／刪除都能還原與重做，Ctrl+Z 與 Ctrl+Shift+Z 生效，
  復原後做新動作會清掉重做堆疊。
*   工作階段還原：清掉之後不會被排程中的保存寫回來、重新開啟會詢問還原、還原後檔案與編排都回來、
  選擇不還原會把工作階段刪掉。

需要 playwright 時：`npm i -D playwright && npx playwright install chromium`，
或指定既有安裝位置：`PW_MODULE=/path/to/playwright/index.js node verify.mjs`。

> 註：Node 20 起以 ESM 匯入 repo 內附的 UMD bundle（pdf-lib／fontkit）不會拿到匯出，
> 因此 `verify.mjs` 自己用 `vm` 把 bundle 當瀏覽器 `<script>` 載入（詳見檔案內註解）。

## 🚀 快速開始

### 前置需求
由於瀏覽器安全限制 (CORS)，建議使用本地伺服器運行，而非直接打開 `index.html`：
```bash
npm run serve          # 等於 python3 -m http.server 8000
# 然後開 http://127.0.0.1:8000/index.html
```
（`instruction.html` 的「程式碼總覽」是執行時讀取 repo 內的實際檔案，**必須**用本地伺服器開啟才看得到內容。）

### 安裝與執行

1. **Clone 專案**
   ```bash
   git clone https://github.com/cormort/pdf_recompose.git
   cd pdf_recompose
