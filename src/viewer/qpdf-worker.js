// 各実行に専用のWorkerと仮想ファイルシステムを割り当て、終了時にパスワードごと破棄する。
importScripts("../vendor/qpdf/qpdf.js");

self.onmessage = async ({ data: { id, bytes, password } }) => {
  try {
    let invalidPassword = false;
    const qpdf = await Module({
      noInitialRun: true,
      locateFile: name => new URL("../vendor/qpdf/" + name, self.location.href).href,
      print() {},
      printErr(message) { if (/invalid password/i.test(message)) { invalidPassword = true; } },
    });
    qpdf.FS.writeFile("input.pdf", bytes);
    let args = [];
    if (id === "protect") {
      args = ["--encrypt", password, password, "256", "--"];
    } else if (id === "unlock") {
      args = ["--password=" + password, "--decrypt"];
    } else if (id !== "repair") {
      throw new Error("不明な操作です");
    }
    const rc = qpdf.callMain(["input.pdf", ...args, "result.pdf"]);
    if (rc !== 0 && rc !== 3) {
      throw new Error(invalidPassword ? "パスワードを確認してください" : "このPDFを処理できませんでした");
    }
    const result = qpdf.FS.readFile("result.pdf");
    self.postMessage({ bytes: result, warning: rc === 3 }, [result.buffer]);
  } catch (e) { self.postMessage({ error: e.message || "PDFを処理できませんでした" }); }
};
