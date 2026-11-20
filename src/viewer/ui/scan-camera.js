/** カメラを利用者が開いている間だけ撮影し、撮った順に画像を渡す。 */
export function bindScanCamera(dialog, append, report) {
  const open = dialog.querySelector("[data-camera-open]");
  const pane = dialog.querySelector("[data-camera]");
  const video = pane.querySelector("video"), shoot = pane.querySelector("[data-camera-shot]");
  const capture = dialog.querySelector("[data-device-camera]");
  let stream = null, generation = 0, count = 0;
  const mobileCapture = "capture" in capture && matchMedia("(pointer: coarse)").matches;
  open.hidden = !mobileCapture && !navigator.mediaDevices?.getUserMedia;
  const stop = () => {
    generation++;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    pane.hidden = true;
    open.disabled = false;
  };
  capture.onchange = () => {
    if (capture.files.length) { append([...capture.files]); }
    capture.value = "";
  };
  open.onclick = async () => {
    if (mobileCapture) { capture.click(); return; }
    const request = ++generation;
    open.disabled = true;
    try {
      const granted = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 } } });
      if (!dialog.open || request !== generation) {
        granted.getTracks().forEach(track => track.stop());
        return;
      }
      stream = granted;
      video.srcObject = stream;
      pane.hidden = false;
      await video.play();
      shoot.focus();
    } catch (e) {
      if (request === generation) {
        stop();
        report(e.name === "NotAllowedError" ? "カメラの使用が許可されていません。画像ファイルからも追加できます。" : "カメラを開けませんでした。接続を確認するか画像ファイルを選んでください。");
      }
    }
  };
  shoot.onclick = async () => {
    if (!video.videoWidth || !stream) { return; }
    const request = generation;
    shoot.disabled = true;
    try {
      const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
      canvas.getContext("2d").drawImage(video, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.94 });
      if (request === generation && dialog.open) {
        append([new File([blob], `撮影-${String(++count).padStart(3, "0")}.jpg`, { type: "image/jpeg" })]);
      }
    } catch {
      report("撮影した画像を追加できませんでした。");
    } finally { shoot.disabled = false; }
  };
  pane.querySelector("[data-camera-stop]").onclick = stop;
  return stop;
}

