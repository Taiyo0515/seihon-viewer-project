using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// A single Chrome port owns a single compile and its temporary directory.
internal static class TexHost {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 24 * 1024 * 1024 };
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly Stream Output = Console.OpenStandardOutput();
    const string Origin = "chrome-extension://miiaicaobmegmjkmicojhmajnancjnjp/";
    public sealed class Request { public string type { get; set; } public string source { get; set; } }

    static void Reply(object message) {
        byte[] body = Utf8.GetBytes(Json.Serialize(message));
        Output.Write(BitConverter.GetBytes(body.Length), 0, 4);
        Output.Write(body, 0, body.Length);
        Output.Flush();
    }

    static string ReadSource() {
        using (var input = new BinaryReader(Console.OpenStandardInput())) {
            int size = input.ReadInt32();
            if (size < 1 || size > Json.MaxJsonLength) throw new InvalidDataException("原稿が大きすぎます。");
            byte[] data = input.ReadBytes(size);
            if (data.Length != size) throw new EndOfStreamException();
            var req = Json.Deserialize<Request>(Utf8.GetString(data));
            if (req == null || req.type != "compile" || req.source == null || Utf8.GetByteCount(req.source) > 4 * 1024 * 1024)
                throw new InvalidDataException("原稿を読み込めませんでした。上限は4 MBです。");
            return req.source;
        }
    }

    static string Run(string bin, string name, string args, string dir) {
        var info = new ProcessStartInfo(Path.Combine(bin, name + ".exe"), args) {
            WorkingDirectory = dir, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        info.EnvironmentVariables["openin_any"] = "p";
        info.EnvironmentVariables["openout_any"] = "p";
        info.EnvironmentVariables["shell_escape"] = "f";
        info.EnvironmentVariables["MKTEXPK"] = "0";
        var tail = new StringBuilder();
        DataReceivedEventHandler collect = delegate(object sender, DataReceivedEventArgs e) {
            if (e.Data == null) return;
            lock (tail) {
                tail.AppendLine(e.Data);
                if (tail.Length > 8192) tail.Remove(0, tail.Length - 8192);
            }
        };
        using (var process = new Process { StartInfo = info }) {
            process.OutputDataReceived += collect;
            process.ErrorDataReceived += collect;
            process.Start();
            process.StandardInput.Close();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            if (!process.WaitForExit(30000)) {
                process.Kill();
                process.WaitForExit();
                throw new TimeoutException(name + " が30秒以内に終了しませんでした。");
            }
            process.WaitForExit();
            string log = tail.ToString();
            if (process.ExitCode != 0) {
                Match match = Regex.Match(log, @"(?im)(?:\./)?main\.tex:(\d+):\s*([^\r\n]+)");
                throw new InvalidDataException(match.Success
                    ? match.Groups[1].Value + " 行目: " + match.Groups[2].Value
                    : name + ": " + log.Trim());
            }
            return log;
        }
    }

    static long Compile(string source, string dir) {
        string bin = File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "tex-bin.txt")).Trim();
        if (!Path.IsPathRooted(bin)) throw new InvalidDataException("TeX Liveの登録を確認してください。");
        File.WriteAllText(Path.Combine(dir, "main.tex"), source, Utf8);
        const string args = "-no-shell-escape -no-parse-first-line -kanji=utf8 -interaction=nonstopmode -halt-on-error -file-line-error main.tex";
        string log = Run(bin, "uplatex", args, dir);
        if (log.IndexOf("rerun", StringComparison.OrdinalIgnoreCase) >= 0 || File.Exists(Path.Combine(dir, "main.toc")))
            Run(bin, "uplatex", args, dir);
        Run(bin, "dvipdfmx", "-q -f ptex-haranoaji.map -f uptex-haranoaji.map -o main.pdf main.dvi", dir);
        using (Stream pdf = File.OpenRead(Path.Combine(dir, "main.pdf"))) {
            if (pdf.Length == 0 || pdf.Length > 64 * 1024 * 1024) throw new IOException("PDFのサイズは1バイト〜64 MBにしてください。");
            byte[] chunk = new byte[384 * 1024];
            int read;
            while ((read = pdf.Read(chunk, 0, chunk.Length)) != 0)
                Reply(new { type = "chunk", data = Convert.ToBase64String(chunk, 0, read) });
            return pdf.Length;
        }
    }

    static int Main(string[] args) {
        if (args.Length == 0 || args[0] != Origin) return 1;
        string dir = Path.Combine(Path.GetTempPath(), "seihon-tex-" + Guid.NewGuid().ToString("N"));
        long bytes = 0;
        string error = null;
        try {
            string source = ReadSource();
            Directory.CreateDirectory(dir);
            bytes = Compile(source, dir);
        } catch (Exception e) {
            error = e.Message;
        } finally {
            // Only remove files in the uniquely generated job directory.
            try {
                if (Directory.Exists(dir)) {
                    foreach (string file in Directory.GetFiles(dir)) File.Delete(file);
                    Directory.Delete(dir);
                }
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
        // Chrome may terminate the host as soon as the port receives this final message.
        try {
            if (error != null) {
                Reply(new { type = "error", message = error });
                return 1;
            }
            Reply(new { type = "done", bytes = bytes });
        } catch (IOException) { return 1; }
        return 0;
    }
}
