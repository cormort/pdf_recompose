// 模擬已選頁面清單
const selectedPages = [];
const pdfFiles = [];
const progress = document.getElementById("progress");

window.onload = () => {
  console.log("✅ script.js 載入完成，PDFLib:", typeof PDFLib);
  if (typeof PDFLib.PDFDocument.prototype.encrypt === "function") {
    console.log("✅ PDF 加密模組已可用 (pdf-lib-with-encrypt)");
  } else {
    console.warn("⚠️ encrypt() 函式未註冊，PDF 將無法加密。");
  }
};

// 主要生成 PDF 函式
async function generatePDF() {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  if (!selectedPages.length) {
    alert("請先選擇頁面再生成 PDF");
    return;
  }

  const addEncrypt = document.getElementById("addEncryptCheckbox").checked;

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const page = pdfDoc.addPage();
  page.drawText("PDF 測試頁", {
    x: 50,
    y: 750,
    size: 20,
    font,
    color: rgb(0, 0, 0)
  });

  if (addEncrypt) {
    const pwd = prompt("請輸入加密密碼：");
    if (pwd && typeof pdfDoc.encrypt === "function") {
      pdfDoc.encrypt({
        userPassword: pwd,
        ownerPassword: "owner-" + Date.now(),
        permissions: {
          printing: "highResolution",
          copying: false,
          modifying: false
        }
      });
      console.log("🔒 已啟用加密");
    } else {
      alert("未啟用加密或 encrypt() 不可用。");
    }
  }

  const pdfBytes = await pdfDoc.save({ useObjectStreams: false });
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "重組測試.pdf";
  link.click();
}
