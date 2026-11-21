import { loadSettings, onSettingsChanged } from "./settings.js";

// Classic is an explicit preference. Existing profiles without it start in the book workspace.
function applyDesign(settings) {
  document.documentElement.dataset.uiTheme = settings.uiTheme;
}
let changedDuringLoad = false;
onSettingsChanged(settings => {
  changedDuringLoad = true;
  applyDesign(settings);
});
const initial = await loadSettings();
if (!changedDuringLoad) applyDesign(initial);
